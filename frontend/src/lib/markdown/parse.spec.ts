import { describe, it, expect } from 'vitest';
import {
	chunkTextIntoSentences,
	parseMarkdownStructure,
	findPageMarkerIndex,
	getBreadcrumbs,
	getGlobalSentences,
	globalToSectionChunk,
	sectionChunkToGlobal,
	selectSections
} from './parse';

describe('chunkTextIntoSentences', () => {
	it('splits prose into sentences', () => {
		expect(chunkTextIntoSentences('Hello world. This is sentence two! And three?')).toEqual([
			'Hello world.',
			'This is sentence two!',
			'And three?'
		]);
	});

	it('returns empty for blank input', () => {
		expect(chunkTextIntoSentences('   ')).toEqual([]);
	});

	it('strips link markup before chunking', () => {
		expect(chunkTextIntoSentences('[docs](https://example.com) are here. Done.')).toEqual([
			'docs are here.',
			'Done.'
		]);
	});
});

describe('parseMarkdownStructure', () => {
	const md =
		'# Training methodology\n\n## Data selection\n\nContent here. Another sentence.';

	it('includes headings as readable sentences', () => {
		const sections = parseMarkdownStructure(md);
		const all = getGlobalSentences(sections);
		expect(all).toContain('Training methodology');
		expect(all).toContain('Data selection');
		expect(all).toContain('Content here.');
	});

	it('keeps a heading-only section when no body follows', () => {
		const sections = parseMarkdownStructure(md);
		expect(sections.length).toBe(2);
		expect(sections[0].heading).toBe('Training methodology');
		expect(sections[0].chunks).toEqual(['Training methodology']);
		expect(sections[1].titles).toEqual(['Training methodology', 'Data selection']);
		expect(sections[1].heading).toBe('Data selection');
		expect(sections[1].chunks).toEqual(['Data selection', 'Content here.', 'Another sentence.']);
	});

	it('preserves paragraph breaks', () => {
		const sections = parseMarkdownStructure('Para one.\n\nPara two.\n\nPara three.');
		expect(sections.length).toBe(1);
		expect(sections[0].paragraphs).toEqual([['Para one.'], ['Para two.'], ['Para three.']]);
	});

	it('builds breadcrumb strings', () => {
		const sections = parseMarkdownStructure(md);
		expect(getBreadcrumbs(sections, 1)).toBe('Training methodology > Data selection');
	});

	it('maps between global and section-local sentence indexes', () => {
		const sections = parseMarkdownStructure(md);
		// section 1 = ['Data selection', 'Content here.', 'Another sentence.']
		expect(globalToSectionChunk(sections, 2)).toEqual({ sectionIdx: 1, chunkIdx: 1 });
		expect(sectionChunkToGlobal(sections, 1, 1)).toBe(2);
	});

	it('returns no sections for empty input', () => {
		expect(parseMarkdownStructure('')).toEqual([]);
	});
});

describe('selectSections', () => {
	const saved = 'First sentence. Second sentence.';
	const stored = parseMarkdownStructure(saved);

	it('reuses stored sections when the draft matches the saved doc', () => {
		expect(selectSections(stored, saved, saved)).toBe(stored);
	});

	it('live-parses the draft when unsaved edits exist', () => {
		const draft = 'First sentence.';
		const sections = selectSections(stored, saved, draft);
		expect(sections).not.toBe(stored);
		expect(getGlobalSentences(sections)).toEqual(['First sentence.']);
	});

	it('drops deleted sentences from the live parse', () => {
		const draft = 'Second sentence.';
		expect(getGlobalSentences(selectSections(stored, saved, draft))).toEqual([
			'Second sentence.'
		]);
	});

	it('re-parses legacy stored sections without paragraph data', () => {
		const legacy = [{ ...stored[0], paragraphs: undefined as unknown as string[][] }];
		const sections = selectSections(legacy, saved, saved);
		expect(getGlobalSentences(sections)).toEqual(['First sentence.', 'Second sentence.']);
	});

	it('parses the draft when nothing is stored', () => {
		expect(getGlobalSentences(selectSections(undefined, undefined, saved))).toEqual([
			'First sentence.',
			'Second sentence.'
		]);
	});
});

describe('findPageMarkerIndex', () => {
	it('locates the Page N marker sentence for exact PDF sync', () => {
		const sentences = getGlobalSentences(
			parseMarkdownStructure('Intro text here.\n\nPage 2.\n\nSecond page text here.')
		);
		expect(findPageMarkerIndex(sentences, 2)).toBeGreaterThanOrEqual(0);
		expect(sentences[findPageMarkerIndex(sentences, 2)]).toBe('Page 2.');
	});

	it('resolves Page 1 markers like any other page', () => {
		expect(findPageMarkerIndex(['Page 1.', 'Intro.'], 1)).toBe(0);
		expect(findPageMarkerIndex(['Page 2.'], 1)).toBe(-1);
		expect(findPageMarkerIndex(['Just text.'], 3)).toBe(-1);
		expect(findPageMarkerIndex(['Page 1.'], 0)).toBe(-1);
	});
});

describe('findPageForSentence', () => {
	it('maps sentence indexes to logical pages via markers', async () => {
		const { findPageForSentence, logicalToPhysical, physicalToLogical } = await import('./parse');
		const sentences = ['Intro.', 'Page 6.', 'Sixth page.', 'Page 9.', 'Ninth page.'];
		expect(findPageForSentence(sentences, 0)).toBe(1);
		expect(findPageForSentence(sentences, 2)).toBe(6);
		expect(findPageForSentence(sentences, 4)).toBe(9);
		const pageMap = [
			{ page: 5, char_start: 0, char_end: 5, start_line: 1 },
			{ page: 6, char_start: 5, char_end: 10, start_line: 2 },
			{ page: 9, char_start: 10, char_end: 15, start_line: 3 }
		];
		expect(logicalToPhysical(9, pageMap, 3)).toBe(3);
		expect(physicalToLogical(3, pageMap)).toBe(9);
	});
});

describe('flat-h2 breadcrumbs', () => {
	it('parents subsections under the latest chapter, not the first heading', async () => {
		const { parseMarkdownStructure } = await import('./parse');
		const md = '## ELECTRICAL GRID.\n\nIntro.\n\n## COMMUNICATIONS.\n\nIntro.\n\n## Radio Antenna Towers.\n\nTowers.';
		const sections = parseMarkdownStructure(md);
		const radio = sections.find((s) => s.heading === 'Radio Antenna Towers.');
		expect(radio?.titles).toEqual(['Communications', 'Radio Antenna Towers']);
	});
});
