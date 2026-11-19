/** LLM OCR of browser-rendered pages via the stateless `/api/llm/ocr` proxy. */

import type { LlmOcrPayload } from '$lib/settings';
import { openPdfRenderer, type PdfRenderer } from './render';

export interface OcrPagesResult {
	/** Page number (1-indexed) → Markdown for pages that succeeded. */
	pages: Map<number, string>;
	failed: number[];
}

export interface OcrOptions {
	apiBase: string;
	llm?: LlmOcrPayload | null;
	/** In-flight page requests; defaults to 2. */
	concurrency?: number;
	onProgress?: (done: number, total: number) => void;
}

/** Parse a FastAPI error body into a readable message. */
async function parseError(resp: Response): Promise<string> {
	const text = await resp.text();
	try {
		const data = JSON.parse(text);
		if (typeof data?.detail === 'string') return data.detail;
		if (Array.isArray(data?.detail)) {
			return data.detail.map((d: any) => d.msg ?? JSON.stringify(d)).join('; ');
		}
	} catch {
		// fall through to the raw body
	}
	return text || `HTTP ${resp.status}`;
}

/** OCR one rendered page image. */
async function ocrPageImage(
	blob: Blob,
	page: number,
	options: OcrOptions
): Promise<string> {
	const form = new FormData();
	form.append('image', blob, `page-${page}.jpg`);
	form.append('page', String(page));
	if (options.llm && Object.keys(options.llm).length > 0) {
		form.append('llm', JSON.stringify(options.llm));
	}
	const resp = await fetch(`${options.apiBase}/api/llm/ocr`, { method: 'POST', body: form });
	if (!resp.ok) throw new Error(await parseError(resp));
	const data = (await resp.json()) as { page: number; markdown: string };
	return data.markdown ?? '';
}

/** Merge OCR results into a page array; empty/failed pages keep browser text. */
export function mergeOcrResults(pages: string[], result: OcrPagesResult): string[] {
	for (const [page, markdown] of result.pages) {
		if (markdown.trim()) pages[page - 1] = markdown;
	}
	return pages;
}

/** OCR selected pages with bounded concurrency and one retry per page. */
export async function ocrPdfPages(
	bytes: Uint8Array,
	pages: number[],
	options: OcrOptions
): Promise<OcrPagesResult> {
	const renderer = await openPdfRenderer(bytes);
	try {
		return await ocrRenderedPages(renderer, pages, options);
	} finally {
		renderer.destroy();
	}
}

/** OCR every page of a PDF, returning the page count alongside the results. */
export async function ocrWholePdf(
	bytes: Uint8Array,
	options: OcrOptions
): Promise<{ totalPages: number; result: OcrPagesResult }> {
	const renderer = await openPdfRenderer(bytes);
	try {
		const pages = Array.from({ length: renderer.numPages }, (_, i) => i + 1);
		return {
			totalPages: renderer.numPages,
			result: await ocrRenderedPages(renderer, pages, options)
		};
	} finally {
		renderer.destroy();
	}
}

/** OCR selected pages using an already-open renderer. */
export async function ocrRenderedPages(
	renderer: PdfRenderer,
	pages: number[],
	options: OcrOptions
): Promise<OcrPagesResult> {
	const results: OcrPagesResult = { pages: new Map(), failed: [] };
	const total = pages.length;
	if (total === 0) return results;
	let nextIndex = 0;
	let done = 0;
	const concurrency = Math.max(
		1,
		Math.min(options.concurrency ?? 2, total)
	);

	const worker = async (): Promise<void> => {
		for (;;) {
			const index = nextIndex++;
			if (index >= total) return;
			const page = pages[index];
			let lastError: unknown;
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					const blob = await renderer.renderPage(page);
					results.pages.set(page, await ocrPageImage(blob, page, options));
					lastError = null;
					break;
				} catch (e) {
					lastError = e;
				}
			}
			if (lastError !== null && lastError !== undefined) {
				results.failed.push(page);
			}
			done += 1;
			options.onProgress?.(done, total);
		}
	};

	await Promise.all(Array.from({ length: concurrency }, () => worker()));
	results.failed.sort((a, b) => a - b);
	return results;
}
