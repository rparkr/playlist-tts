// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import DOMPurify from 'dompurify';
import { describe, expect, it } from 'vitest';
import { getGlobalSentences, getSectionParagraphs, parseMarkdownStructure } from './parse';
import { injectSentences, normalizeRenderedText, renderSectionBlocks } from './render';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function article(name: string): string {
	return readFileSync(join(repoRoot, 'test-articles', name), 'utf-8');
}

function renderDoc(md: string): { html: string; sections: ReturnType<typeof parseMarkdownStructure> } {
	const sections = parseMarkdownStructure(md);
	let html = '';
	let g = 0;
	for (const sec of sections) {
		const paras = getSectionParagraphs(sec);
		const out = renderSectionBlocks(sec.blocks, paras, g);
		html += out.html;
		g = out.nextIdx;
	}
	return { html, sections };
}

function sanitized(html: string): string {
	return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] });
}

describe('normalizeRenderedText', () => {
	it('collapses whitespace for comparison', () => {
		expect(normalizeRenderedText('  a\n\t b  ')).toBe('a b');
	});
});

describe('renderSectionBlocks', () => {
	it('renders headings with levels and sentence spans', () => {
		const { html, sections } = renderDoc('# Title Here.\n\nBody text here.');
		expect(html).toContain('<h1>');
		const total = getGlobalSentences(sections).length;
		const spans = html.match(/data-sentence-idx="\d+"/g) ?? [];
		expect(spans.length).toBe(total);
		expect(total).toBeGreaterThan(0);
	});

	it('groups consecutive list items into one list with per-item spans', () => {
		const { html } = renderDoc('- first item here\n- second item here\n\n1. ordered one\n2. ordered two');
		expect(html.match(/<ul>/g)?.length).toBe(1);
		expect(html.match(/<ol>/g)?.length).toBe(1);
		expect(html).toContain('data-sentence-idx="0"');
		// Four items → four sentence spans minimum.
		expect(html.match(/data-sentence-idx="\d+"/g)?.length).toBeGreaterThanOrEqual(4);
	});

	it('renders nested lists without breaking span mapping', () => {
		const { html } = renderDoc('- outer one\n  - nested one here\n- outer two here');
		expect(html).toContain('<ul>');
		// Nested content folds into its parent item's span (one span per
		// top-level item); nothing is lost and mapping stays exact.
		expect(html.match(/data-sentence-idx="\d+"/g)?.length).toBe(2);
		expect(html).toContain('nested one here');
	});

	it('renders code fences without sentence spans', () => {
		const { html } = renderDoc('```py\nprint("hi")\n```\n\nAfter code here.');
		expect(html).toContain('<pre>');
		expect(html).toContain('print');
		// Code text is unspeakable: only the prose sentence gets a span.
		expect(html.match(/data-sentence-idx="\d+"/g)?.length).toBe(1);
	});

	it('renders links as anchors and keeps the sentence clickable', () => {
		const { html } = renderDoc('Read [the docs](https://example.com/x) today.');
		expect(html).toContain('<a href="https://example.com/x"');
		expect(html).toContain('data-sentence-idx="0"');
	});

	it('renders images without spans and tables readably', () => {
		const { html } = renderDoc('![alt text](https://example.com/i.png)\n\n| a | b |\n|---|---|\n| 1 | 2 |');
		expect(html).toContain('<img');
		expect(html).toContain('<table>');
		expect(html).toContain('<td>1</td>');
	});

	it('renders blockquotes and headings with spans', () => {
		const { html } = renderDoc('> Quoted words here.\n\n## Sub Heading Here.');
		expect(html).toContain('<blockquote>');
		expect(html).toContain('<h2>');
		expect(html.match(/data-sentence-idx="\d+"/g)?.length).toBeGreaterThanOrEqual(2);
	});
});

describe('injectSentences', () => {
	it('falls back to plain HTML on text mismatch', () => {
		const el = document.createElement('p');
		el.textContent = 'Totally different words here.';
		const next = injectSentences(el, ['Unrelated sentence here.'], 7);
		expect(next).toBe(7);
		expect(el.querySelector('[data-sentence-idx]')).toBeNull();
	});

	it('wraps sentences across inline element boundaries', () => {
		const el = document.createElement('p');
		el.innerHTML = 'See <strong>bold words</strong> today.';
		const next = injectSentences(el, ['See bold words today.'], 3);
		expect(next).toBe(4);
		const span = el.querySelector('[data-sentence-idx="3"]');
		expect(span?.textContent).toBe('See bold words today.');
		expect(span?.querySelector('strong')?.textContent).toBe('bold words');
	});
});

describe('sanitized output', () => {
	it('strips scripts but keeps spans, links, and targets', () => {
		const { html } = renderDoc('Hello <script>alert(1)</script> world.\n\n[Click](https://example.com).');
		const clean = sanitized(html);
		expect(clean).not.toContain('<script>');
		expect(clean).toContain('data-sentence-idx');
		expect(clean).toContain('target="_blank"');
	});
});

describe('real article fixture', () => {
	it('renders the Gemma report with links and spans (tables arrive as text soup)', () => {
		// NOTE: trafilatura flattens GFM tables to plain text, so no
		// `<table>` is expected here; pipe tables are covered above.
		const md = article('gemma-4-technical-report.md');
		const { html, sections } = renderDoc(md);
		const total = getGlobalSentences(sections).length;
		expect(total).toBeGreaterThan(50);
		expect(html).toContain('<a href=');
		const spans = html.match(/data-sentence-idx="\d+"/g) ?? [];
		// Most prose sentences map; flattened tables/code fall back to plain HTML.
		expect(spans.length).toBeGreaterThan(total * 0.5);
		const clean = sanitized(html);
		expect(clean).not.toContain('<script>');
	});

	it('strips frontmatter URL blocks without crashing', () => {
		const md = article('attention-for-llms.md');
		const { html } = renderDoc(md);
		expect(html.length).toBeGreaterThan(1000);
		expect(sanitized(html)).not.toContain('<script>');
	});
});

describe('performance gate (Q1: derive cost on book-length docs)', () => {
	it(
		'parses and renders the full engineering book in under 3s',
		{ timeout: 30000 },
		() => {
			const md = readFileSync(join(repoRoot, 'test-pdfs', 'engineering-full-book.md'), 'utf-8');
			const t0 = performance.now();
			const sections = parseMarkdownStructure(md);
			const tParse = performance.now();
			let g = 0;
			let html = '';
			for (const sec of sections) {
				const out = renderSectionBlocks(sec.blocks, getSectionParagraphs(sec), g);
				html += out.html;
				g = out.nextIdx;
			}
			const tRender = performance.now();
			const clean = sanitized(html);
			const tSanitize = performance.now();
			// eslint-disable-next-line no-console
			console.log(
				`book render: parse=${(tParse - t0).toFixed(0)}ms ` +
					`render=${(tRender - tParse).toFixed(0)}ms ` +
					`sanitize=${(tSanitize - tRender).toFixed(0)}ms ` +
					`sentences=${g}`
			);
			expect(clean.length).toBeGreaterThan(10000);
			expect(tSanitize - t0).toBeLessThan(3000);
		}
	);
});
