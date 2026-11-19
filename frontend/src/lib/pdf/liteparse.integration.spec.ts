import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import init, { LiteParse } from '@llamaindex/liteparse-wasm';
import { applyPostprocessingPages, DEFAULT_POSTPROCESS } from '$lib/markdown/postprocess';

const FIXTURE = new URL('./fixtures/sample-doc.pdf', import.meta.url);
const require = createRequire(import.meta.url);
const PACKAGE_DIR = dirname(require.resolve('@llamaindex/liteparse-wasm/package.json'));
const WASM = join(PACKAGE_DIR, 'pkg', 'liteparse_wasm_bg.wasm');
let bytes: Uint8Array;

beforeAll(async () => {
	bytes = new Uint8Array(readFileSync(fileURLToPath(FIXTURE)));
	await init({ module_or_path: new Uint8Array(readFileSync(WASM)) });
});

/** Risk-free parser config for a digital-native fixture. */
function createParser(): LiteParse {
	return new LiteParse({
		outputFormat: 'markdown',
		imageMode: 'off',
		quiet: true,
		maxPages: 100
	});
}

describe('LiteParse integration', () => {
	it('analyzes every page without flagging OCR', async () => {
		const parser = createParser();
		try {
			const stats = await parser.isComplex(bytes);
			expect(stats).toHaveLength(2);
			expect(stats.map((s) => s.pageNumber)).toEqual([1, 2]);
			expect(stats.some((s) => s.reasons.includes('scanned'))).toBe(false);
		} finally {
			parser.free();
		}
	});

	it('extracts per-page Markdown in reading order', async () => {
		const parser = createParser();
		try {
			const result = await parser.parse(bytes);
			expect(result.totalPages).toBe(2);
			expect(result.pages).toHaveLength(2);

			const first = result.pages[0].markdown;
			const second = result.pages[1].markdown;
			expect(first).toContain('Browser PDF Extraction');
			expect(first).toContain('What the extractor should preserve');
			expect(first).toContain('Headings and their hierarchy');
			expect(second).toContain('Second Page');
			expect(second).toContain('First item on page two');
		} finally {
			parser.free();
		}
	});

	it('exposes a batching path for large documents', async () => {
		const parser = createParser();
		try {
			const session = await parser.openBatchSession(bytes, 1);
			try {
				expect(session.totalPages).toBe(2);
				const pages: string[] = [];
				for (;;) {
					const batch = await session.nextBatch();
					if (!batch) break;
					pages.push(...batch.result.pages.map((page) => page.markdown));
				}
				expect(pages).toHaveLength(2);
				expect(pages[0]).toContain('Browser PDF Extraction');
				expect(pages[1]).toContain('Second Page');
			} finally {
				session.free();
			}
		} finally {
			parser.free();
		}
	});

	it('joins pages with aligned markers and no page-break comments', async () => {
		const parser = createParser();
		let pages: string[] = [];
		try {
			const result = await parser.parse(bytes);
			pages = result.pages.map((page) => page.markdown);
		} finally {
			parser.free();
		}

		const rendered = applyPostprocessingPages(pages, {
			...DEFAULT_POSTPROCESS,
			insert_page_markers: true
		});
		expect(rendered.pageMap.map((p) => p.page)).toEqual([1, 2]);
		expect(rendered.markdown).toContain('Page 1.');
		expect(rendered.markdown).toContain('Page 2.');
		expect(rendered.markdown).not.toContain('<!-- page break -->');
	});
});
