/// <reference lib="webworker" />

/** LiteParse WASM worker — keeps PDF parsing off the main thread. */

import init, { LiteParse } from '@llamaindex/liteparse-wasm';
import wasmUrl from '@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm?url';
import type { ComplexityPage, WorkerRequest } from './liteparse';

/** Documents this small parse whole; larger ones use bounded batches. */
const WHOLE_PARSE_LIMIT = 200;
const BATCH_SIZE = 50;

let ready: Promise<unknown> | null = null;

/** Initialize the wasm module once (pointer at the bundled asset). */
function ensureReady(): Promise<unknown> {
	if (!ready) ready = init({ module_or_path: wasmUrl });
	return ready;
}

/** Build a parser tuned for reading-order Markdown without images. */
function createParser(): LiteParse {
	return new LiteParse({
		outputFormat: 'markdown',
		imageMode: 'off',
		extractLinks: true,
		keepHeadersFooters: false,
		skipDiagonalText: true,
		preserveVerySmallText: false,
		quiet: true,
		maxPages: 10000
	});
}

interface WorkerResponse {
	id: number;
	type: 'result' | 'error' | 'progress';
	result?: unknown;
	error?: string;
	done?: number;
	total?: number;
}

function reply(message: WorkerResponse): void {
	self.postMessage(message);
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
	const msg = event.data;
	try {
		await ensureReady();
		const bytes = new Uint8Array(msg.bytes);
		const parser = createParser();
		try {
			if (msg.type === 'analyze') {
				const stats = await parser.isComplex(bytes);
				const pages: ComplexityPage[] = stats.map((s) => ({
					pageNumber: s.pageNumber,
					needsOcr: s.needsOcr,
					reasons: s.reasons,
					textLength: s.textLength
				}));
				reply({ id: msg.id, type: 'result', result: { totalPages: pages.length, pages } });
				return;
			}

			reply({ id: msg.id, type: 'progress', done: 0, total: msg.totalPages });
			const result =
				msg.totalPages > WHOLE_PARSE_LIMIT
					? await parseInBatches(parser, bytes, msg)
					: await parseWhole(parser, bytes);
			reply({ id: msg.id, type: 'result', result });
		} finally {
			parser.free();
		}
	} catch (e: unknown) {
		reply({
			id: msg.id,
			type: 'error',
			error: e instanceof Error ? e.message : String(e)
		});
	}
};

/** Parse the entire document in one wasm call. */
async function parseWhole(
	parser: LiteParse,
	bytes: Uint8Array
): Promise<{ totalPages: number; pages: string[] }> {
	const result = await parser.parse(bytes);
	const pages = new Array<string>(result.totalPages).fill('');
	for (const page of result.pages) {
		pages[page.pageNum - 1] = page.markdown ?? page.text ?? '';
	}
	return { totalPages: result.totalPages, pages };
}

/** Parse large documents batch-by-batch to bound wasm memory. */
async function parseInBatches(
	parser: LiteParse,
	bytes: Uint8Array,
	msg: WorkerRequest
): Promise<{ totalPages: number; pages: string[] }> {
	const session = await parser.openBatchSession(bytes, BATCH_SIZE);
	try {
		const pages = new Array<string>(session.totalPages).fill('');
		for (;;) {
			const batch = await session.nextBatch();
			if (!batch) break;
			for (const page of batch.result.pages) {
				pages[page.pageNum - 1] = page.markdown ?? page.text ?? '';
			}
			reply({ id: msg.id, type: 'progress', done: batch.endPage, total: session.totalPages });
		}
		return { totalPages: session.totalPages, pages };
	} finally {
		session.free();
	}
}
