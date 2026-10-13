import { describe, it, expect } from 'vitest';
import {
	chunkTextIntoSentences,
	parseMarkdownStructure,
	findPageMarkerIndex,
	getBreadcrumbs,
	getGlobalSentences,
	getSectionParagraphs,
	globalToSectionChunk,
	isBareItemLine,
	isItemBoundary,
	normalizeIndentedLines,
	sectionChunkToGlobal,
	selectSections,
	splitBlocks
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

	it('keeps lone asterisks and snake_case (renderer parity)', () => {
		expect(chunkTextIntoSentences('The 26B-A4B* model uses max_tokens here.')).toEqual([
			'The 26B-A4B* model uses max_tokens here.'
		]);
		expect(chunkTextIntoSentences('A * B = C stars stay.')).toEqual(['A * B = C stars stay.']);
	});

	it('strips paired emphasis but not spaced stars', () => {
		expect(chunkTextIntoSentences('This is **bold** and *em* text.')).toEqual([
			'This is bold and em text.'
		]);
		expect(chunkTextIntoSentences('Values * ja* stay literal.')).toEqual([
			'Values * ja* stay literal.'
		]);
	});

	it('drops images and HTML tags but keeps image-adjacent prose', () => {
		expect(chunkTextIntoSentences('See ![alt](https://x/y.png) here.')).toEqual(['See here.']);
		expect(chunkTextIntoSentences('Output an <eos> token now.')).toEqual(['Output an token now.']);
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

	it('emits one block per list item with paragraph alignment', () => {
		const sections = parseMarkdownStructure('- alpha here\n- beta here\n\nTail.');
		expect(sections.length).toBe(1);
		const kinds = sections[0].blocks.map((b) => b.kind);
		expect(kinds).toEqual(['list-item', 'list-item', 'paragraph']);
		expect(sections[0].blocks.map((b) => b.paraIdx)).toEqual([0, 1, 2]);
		expect(getSectionParagraphs(sections[0])).toEqual([['alpha here'], ['beta here'], ['Tail.']]);
	});

	it('keeps mid-paragraph numbered lines as prose, not lists', () => {
		const sections = parseMarkdownStructure('Intro line here.\n2.3. Encoder stuff here.');
		const kinds = sections[0].blocks.map((b) => b.kind);
		expect(kinds).toEqual(['paragraph']);
		expect(getGlobalSentences(sections)).toEqual([
			'Intro line here.',
			'2.3.',
			'Encoder stuff here.'
		]);
	});

	it('marks code and hr blocks unspeakable', () => {
		const sections = parseMarkdownStructure('```py\nprint(1)\n```\n\n---\n\nDone here.');
		const kinds = sections[0].blocks.map((b) => b.kind);
		expect(kinds).toContain('code');
		expect(kinds).toContain('hr');
		for (const b of sections[0].blocks) {
			if (b.kind === 'code' || b.kind === 'hr') expect(b.paraIdx).toBeNull();
		}
		expect(getGlobalSentences(sections)).toEqual(['Done here.']);
	});
});

describe('splitBlocks', () => {
	it('splits fences, tables, quotes, and headings structurally', () => {
		const blocks = splitBlocks([
			'## Sub here',
			'',
			'> quoted here',
			'',
			'| a | b |',
			'|---|---|',
			'| 1 | 2 |',
			'',
			'```js',
			'x();',
			'```'
		]);
		expect(blocks.map((b) => b.kind)).toEqual(['heading', 'blockquote', 'table', 'code']);
	});

	it('groups ordered runs and flags ordering', () => {
		const blocks = splitBlocks(['1. one here', '2. two here']);
		expect(blocks.map((b) => b.kind)).toEqual(['list-item', 'list-item']);
		expect(blocks.every((b) => b.ordered)).toBe(true);
	});

	it('keeps each bare pypdf table row as its own paragraph block', () => {
		const blocks = splitBlocks([
			'Encoder Embedder Einsums Drafter',
			'E2B305M 150M 400M + 2,340M 1,870M 76M',
			'E4B305M 150M 670M + 2,820M 3,940M 77M'
		]);
		expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'paragraph', 'paragraph']);
		expect(getGlobalSentences(parseMarkdownStructure(blocks.map((b) => b.lines.join('\n')).join('\n')))).toEqual([
			'Encoder Embedder Einsums Drafter',
			'E2B305M 150M 400M + 2,340M 1,870M 76M',
			'E4B305M 150M 670M + 2,820M 3,940M 77M'
		]);
	});

	it('joins wrapped prose, dialogue, and citation wraps across lines', () => {
		expect(
			getGlobalSentences(
				parseMarkdownStructure(
					'The rapid evolution of large language models\nhas driven the need for open weights.'
				)
			)
		).toEqual([
			'The rapid evolution of large language models has driven the need for open weights.'
		]);
		expect(
			getGlobalSentences(
				parseMarkdownStructure('embeddings as in Gemma 3n (Gemma Team,\n2025b), making them effective.')
			)
		).toEqual(['embeddings as in Gemma 3n (Gemma Team, 2025b), making them effective.']);
		expect(
			getGlobalSentences(
				parseMarkdownStructure('In this technical report, we presented Gemma\n4, an open-weight family.')
			)
		).toEqual(['In this technical report, we presented Gemma 4, an open-weight family.']);
	});
});

describe('isBareItemLine / isItemBoundary', () => {
	it('flags short unterminated lines but not prose wraps', () => {
		expect(isBareItemLine('E2B305M 150M 400M + 2,340M')).toBe(true);
		expect(isBareItemLine('Gemma 4 Technical Report')).toBe(true);
		expect(isBareItemLine('most capable and efficient generation in the')).toBe(false);
		expect(isBareItemLine('with RMSNorm (Zhang and Sennrich, 2019),')).toBe(false);
		expect(isBareItemLine('Our models have pre-norm and post-norm.')).toBe(false);
		expect(isBareItemLine('- marked item')).toBe(false);
		expect(isBareItemLine('| piped | row |')).toBe(false);
	});

	it('splits on uppercase leads, guards proper-noun digit wraps', () => {
		expect(isItemBoundary('Vision', 'Encoder Embedder')).toBe(true);
		expect(isItemBoundary('E2B305M 150M', 'E4B305M 150M')).toBe(true);
		expect(isItemBoundary('In this report, we presented Gemma', '4, an open family')).toBe(false);
		expect(isItemBoundary('One morning, Norah said to me,', '"Arthur, take company"')).toBe(false);
		expect(isItemBoundary('introduce a thinking mode (OpenAI, 2024) to', 'Gemma 4 models')).toBe(false);
	});
});

describe('normalizeIndentedLines', () => {
	it('de-indents isolated centered titles but keeps code runs', () => {
		expect(normalizeIndentedLines(['', '\t\tCentered Title', ''])).toEqual([
			'',
			'Centered Title',
			''
		]);
		expect(normalizeIndentedLines(['', '\tline one', '\tline two', ''])).toEqual([
			'',
			'\tline one',
			'\tline two',
			''
		]);
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
