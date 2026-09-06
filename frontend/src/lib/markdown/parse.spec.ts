import { describe, it, expect } from 'vitest';
import {
	chunkTextIntoSentences,
	parseMarkdownStructure,
	getBreadcrumbs,
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

	it('parses sections with breadcrumbs and sentence chunks', () => {
		const sections = parseMarkdownStructure(md);
		expect(sections.length).toBe(1);
		expect(sections[0].titles).toEqual(['Training methodology', 'Data selection']);
		expect(sections[0].level).toBe(2);
		expect(sections[0].chunks).toEqual(['Content here.', 'Another sentence.']);
	});

	it('builds breadcrumb strings', () => {
		const sections = parseMarkdownStructure(md);
		expect(getBreadcrumbs(sections, 0)).toBe('Training methodology > Data selection');
	});

	it('maps between global and section-local sentence indexes', () => {
		const sections = parseMarkdownStructure(md);
		expect(globalToSectionChunk(sections, 1)).toEqual({ sectionIdx: 0, chunkIdx: 1 });
		expect(sectionChunkToGlobal(sections, 0, 1)).toBe(1);
	});

	it('returns no sections for empty input', () => {
		expect(parseMarkdownStructure('')).toEqual([]);
	});
});
