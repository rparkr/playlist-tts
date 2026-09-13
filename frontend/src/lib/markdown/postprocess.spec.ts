import { describe, it, expect } from 'vitest';
import {
	applyPostprocessing,
	buildPageMap,
	dehyphenate,
	ensurePunctuation,
	insertPageMarkers,
	normalizeUppercase,
	reflowColumns,
	stripImageArtifacts,
	stripPageMarkers,
	DEFAULT_POSTPROCESS
} from './postprocess';

describe('stripImageArtifacts', () => {
	it('removes image comments and stray Other', () => {
		const out = stripImageArtifacts('Hello\n<!-- image -->\nOther\nWorld');
		expect(out).not.toContain('image');
		expect(out).not.toContain('Other');
		expect(out).toContain('World');
	});
});

describe('reflowColumns', () => {
	it('does not merge when prior para ends with quote punctuation', () => {
		const md = 'Here\'s a quote: "This is the end."\n\nNext paragraph starts here.';
		const out = reflowColumns(md);
		expect(out).toContain('Next paragraph');
		expect(out.split('\n\n').length).toBeGreaterThanOrEqual(2);
	});

	it('merges missing-terminal + lowercase continuation', () => {
		const md = 'This sentence continues without punctuation\n\nand continues here. Next sentence.';
		const out = reflowColumns(md);
		expect(out).toContain('and continues here.');
	});
});

describe('normalizeUppercase', () => {
	it('title-cases long single words but preserves acronyms', () => {
		expect(normalizeUppercase('WATER')).toBe('Water');
		expect(normalizeUppercase('This is NASA here')).toContain('NASA');
	});

	it('title-cases runs of uppercase words', () => {
		expect(normalizeUppercase('SAIL BOAT and normal')).toContain('Sail Boat');
	});

	it('skips code fences', () => {
		const out = normalizeUppercase('```\nTHIS IS CODE\n```\nSAIL BOAT');
		expect(out).toContain('THIS IS CODE');
		expect(out).toContain('Sail Boat');
	});
});

describe('ensurePunctuation', () => {
	it('adds period to headers lacking terminal', () => {
		expect(ensurePunctuation('## Chapter overview\n\nContent here.')).toContain(
			'## Chapter overview.'
		);
	});
});

describe('page markers', () => {
	it('strips previously-inserted markers so re-render from edits toggles cleanly', () => {
		const withMarkers = 'First page text.\n\nPage 2.\n\nSecond page text.';
		const stripped = stripPageMarkers(withMarkers);
		expect(stripped).not.toContain('Page 2.');
		expect(stripped).toContain('First page text.');
		expect(stripped).toContain('Second page text.');
	});

	it('does not strip inline mentions of pages', () => {
		const md = 'See Page 2 for details. More text here.';
		expect(stripPageMarkers(md)).toBe(md);
	});

	it('inserts markers after sentence boundaries', () => {
		const md = 'First sentence. Second sentence. Third sentence. Fourth sentence.';
		const pageMap = buildPageMap(md, 2);
		const out = insertPageMarkers(md, pageMap);
		expect(out).toContain('Page 2.');
	});

	it('is idempotent near existing markers', () => {
		const md = 'First sentence. Second sentence.';
		const pageMap = buildPageMap(md, 2);
		const once = insertPageMarkers(md, pageMap);
		const twice = insertPageMarkers(once, buildPageMap(once, 2));
		// Should not duplicate Page 2 marker endlessly.
		expect(twice.match(/Page 2\./g)?.length ?? 0).toBeLessThanOrEqual(2);
	});
});

describe('dehyphenate', () => {
	it('joins hyphen + space/newline breaks into one word', () => {
		expect(dehyphenate('stresses and dete- rioration and even')).toBe(
			'stresses and deterioration and even'
		);
		expect(dehyphenate('cables in combi- nation with')).toBe('cables in combination with');
		expect(dehyphenate('stresses and dete-\nrioration and')).toBe(
			'stresses and deterioration and'
		);
	});

	it('preserves real hyphens, spaced dashes, and code fences', () => {
		expect(dehyphenate('fiber-optic cables')).toBe('fiber-optic cables');
		expect(dehyphenate('word - word stays')).toBe('word - word stays');
		const out = dehyphenate('```\nCODE- WITH space\n```\nnormal dete- rioration');
		expect(out).toContain('CODE- WITH');
		expect(out).toContain('deterioration');
	});
});

describe('applyPostprocessing', () => {
	it('renders offline from raw markdown with toggles', () => {
		const raw = '# Title\n\nTHIS IS A SECTION\n\nContent here. Another sentence.';
		const withUpper = applyPostprocessing(
			raw,
			{ ...DEFAULT_POSTPROCESS, normalize_uppercase: true, ensure_punctuation: true },
			null
		);
		expect(withUpper.sections.length).toBeGreaterThan(0);
		expect(withUpper.pageMap.length).toBe(1);

		const withoutUpper = applyPostprocessing(
			raw,
			{ ...DEFAULT_POSTPROCESS, normalize_uppercase: false, ensure_punctuation: false },
			null
		);
		// Toggling changes rendered output deterministically from same raw.
		expect(withUpper.markdown).not.toBe(withoutUpper.markdown);
	});

	it('re-renders page markers from stored raw page map', () => {
		const raw = Array.from({ length: 20 }, (_, i) => `Sentence number ${i + 1}.`).join(' ');
		const rawMap = buildPageMap(raw, 3);
		const withMarkers = applyPostprocessing(
			raw,
			{ ...DEFAULT_POSTPROCESS, insert_page_markers: true },
			rawMap
		);
		const withoutMarkers = applyPostprocessing(
			raw,
			{ ...DEFAULT_POSTPROCESS, insert_page_markers: false },
			rawMap
		);
		expect(withMarkers.markdown).toContain('Page 2.');
		expect(withoutMarkers.markdown).not.toContain('Page 2.');
	});

	it('keeps Page markers at true page breaks, not between columns', () => {
		const raw = [
			'Depending on how it is harnessed, stored, distributed, and used, energy can',
			'',
			'take many forms. On the Earth, we can trace nearly all our energy back to the sun.',
			'',
			'<!-- page break -->',
			'',
			'Second page content starts here. More text on page two.'
		].join('\n');
		const rendered = applyPostprocessing(
			raw,
			{ ...DEFAULT_POSTPROCESS, combine_columns: true, insert_page_markers: true },
			buildPageMap(raw, 2)
		);
		expect(rendered.markdown).toContain('energy can take many forms.');
		expect(rendered.markdown.indexOf('take many forms.')).toBeLessThan(
			rendered.markdown.indexOf('Page 2.')
		);
		expect(rendered.markdown.indexOf('Page 2.')).toBeLessThan(
			rendered.markdown.indexOf('Second page')
		);
	});
});
