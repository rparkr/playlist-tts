/** LiteParse WASM client — analysis and page extraction via a module worker. */

/** Per-page complexity signals from LiteParse's cheap text-layer pass. */
export interface ComplexityPage {
	pageNumber: number;
	needsOcr: boolean;
	reasons: string[];
	textLength: number;
}

export interface AnalyzeResult {
	totalPages: number;
	pages: ComplexityPage[];
}

export interface ExtractResult {
	totalPages: number;
	/** Per-page Markdown in physical PDF order (index 0 == page 1). */
	pages: string[];
}

export type WorkerRequest =
	| { id: number; type: 'analyze'; bytes: ArrayBuffer }
	| { id: number; type: 'parse'; bytes: ArrayBuffer; totalPages: number };

type Progress = (done: number, total: number) => void;

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	onProgress?: Progress;
}

/**
 * Reasons that mean OCR can genuinely recover text.
 *
 * `embedded-images` and `sparse-text` are common on normal figure-heavy or
 * section-title pages, so they do not justify an OCR call on their own.
 */
const OCR_REASONS: ReadonlySet<string> = new Set([
	'scanned',
	'garbled',
	'vector-text',
	'annotation-text'
]);

/** Select pages where LLM OCR is likely to improve on the text layer. */
export function ocrWorthyPages(pages: ComplexityPage[]): ComplexityPage[] {
	return pages.filter(
		(page) => page.needsOcr && page.reasons.some((reason) => OCR_REASONS.has(reason))
	);
}

/** Combine per-page reasons into `{reason: count}` for the OCR offer dialog. */
export function countReasons(pages: ComplexityPage[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const page of pages) {
		for (const reason of page.reasons) {
			if (!OCR_REASONS.has(reason)) continue;
			counts[reason] = (counts[reason] ?? 0) + 1;
		}
	}
	return counts;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

/** Return the shared worker, creating it on first use. */
function getWorker(): Worker {
	if (worker) return worker;
	worker = new Worker(new URL('./liteparse.worker.ts', import.meta.url), { type: 'module' });
	worker.onmessage = (event: MessageEvent) => {
		const data = event.data as {
			id: number;
			type: 'result' | 'error' | 'progress';
			result?: unknown;
			error?: string;
			done?: number;
			total?: number;
		};
		const entry = pending.get(data.id);
		if (!entry) return;
		if (data.type === 'progress') {
			entry.onProgress?.(data.done ?? 0, data.total ?? 0);
			return;
		}
		pending.delete(data.id);
		if (data.type === 'error') entry.reject(new Error(data.error ?? 'PDF parsing failed'));
		else entry.resolve(data.result);
	};
	worker.onerror = (event) => {
		const error = new Error(event.message || 'LiteParse worker crashed');
		for (const entry of pending.values()) entry.reject(error);
		pending.clear();
		worker?.terminate();
		worker = null;
	};
	return worker;
}

/** Send one request to the worker and await its result. */
function request<T>(message: WorkerRequest, onProgress?: Progress): Promise<T> {
	const w = getWorker();
	return new Promise<T>((resolve, reject) => {
		pending.set(message.id, {
			resolve: resolve as (value: unknown) => void,
			reject,
			onProgress
		});
		w.postMessage(message);
	});
}

/** Analyze page complexity without parsing the document text. */
export function analyzePdf(bytes: Uint8Array): Promise<AnalyzeResult> {
	return request<AnalyzeResult>({
		id: nextId++,
		type: 'analyze',
		bytes: toArrayBuffer(bytes)
	});
}

/** Extract per-page Markdown for the whole document. */
export function extractPdfPages(
	bytes: Uint8Array,
	totalPages: number,
	onProgress?: Progress
): Promise<ExtractResult> {
	return request<ExtractResult>(
		{
			id: nextId++,
			type: 'parse',
			bytes: toArrayBuffer(bytes),
			totalPages
		},
		onProgress
	);
}

/** Copy a typed array into a standalone ArrayBuffer for postMessage. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

/** Terminate the worker and reject any in-flight requests. */
export function terminateLiteparseWorker(): void {
	for (const entry of pending.values()) entry.reject(new Error('PDF extraction cancelled'));
	pending.clear();
	worker?.terminate();
	worker = null;
}
