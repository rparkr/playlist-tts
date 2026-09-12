import { describe, it, expect } from 'vitest';
import {
	chunkTextIntoSentences,
	parseMarkdownStructure,
	getBreadcrumbs,
	getGlobalSentences,
	globalToSectionChunk,
	sectionChunkToGlobal
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
