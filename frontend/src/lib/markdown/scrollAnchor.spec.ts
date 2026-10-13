import { describe, it, expect } from 'vitest';
import {
	collapseWs,
	lineForCharIndex,
	stripMarkdownForMatch,
	snippetForSourceLine,
	nearestIndex,
	candidateLines,
	lineStartOffsets
} from './scrollAnchor';

describe('scroll anchors', () => {
	it('maps char offsets to logical lines and line starts', () => {
		expect(lineForCharIndex('ab\ncd\nef', 0)).toBe(0);
		expect(lineForCharIndex('ab\ncd\nef', 4)).toBe(1);
		expect(lineForCharIndex('ab\ncd\nef', 99)).toBe(2);
		expect(lineStartOffsets(['ab', 'cd', 'ef'])).toEqual([0, 3, 6]);
	});

	it('strips markers so source lines match rendered text', () => {
		expect(stripMarkdownForMatch('## Map of the Isle')).toBe('Map of the Isle');
		expect(stripMarkdownForMatch('1. STORAGE ROOM, with reeds')).toBe('STORAGE ROOM, with reeds');
		expect(stripMarkdownForMatch('- item **bold** done')).toBe('item bold done');
		expect(snippetForSourceLine('Page 22.')).toBe('Page 22.');
		expect(collapseWs('a  \n b')).toBe('a b');
	});

	it('picks the occurrence nearest the guess', () => {
		const hay = 'Page 22. text Page 22. more Page 22. end';
		expect(nearestIndex(hay, 'Page 22.', 0)).toBe(0);
		expect(nearestIndex(hay, 'Page 22.', 40)).toBe(hay.lastIndexOf('Page 22.'));
		expect(nearestIndex(hay, 'missing', 5)).toBe(-1);
	});

	it('ranks candidate lines by distance to the guess', () => {
		const lines = ['Page 22.', 'prose here', 'Page 22. again'];
		expect(candidateLines(lines, 'Page 22.', 99)).toEqual([2, 0]);
		expect(candidateLines(lines, 'absent', 0)).toEqual([]);
	});

	it('round-trips anchor snippets through invented book-like text', () => {
		// Synthetic stand-in for book text: empty lines, short item-like
		// lines, tab-indented lines, and very long prose lines (800+ chars).
		// All content below is invented for the test — no source excerpts.
		const long = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ';
		const lines = [
			'Page 22.',
			'',
			'Harbor Hill',
			'Glass Caverns',
			'\tIndented with a tab here',
			long.repeat(14).trim(),
			'Short again.',
			'',
			'1. STORAGE ROOM, with grain bins made of woven reeds',
			'Unicode: gryphon — aviary “roost” … done',
			long.repeat(16).trim(),
			'Page 23.'
		];
		// Source lines locate by snippet: exact line for unique text, and
		// the nearer occurrence for repeats (map markers, page numbers).
		const harbor = candidateLines(lines, 'Harbor Hill', 0);
		expect(harbor.length).toBe(1);
		expect(lines[harbor[0]]).toBe('Harbor Hill');
		expect(candidateLines(lines, 'STORAGE ROOM', 0).length).toBe(1);
		const pages = candidateLines(lines, 'Page 2', 99);
		expect(pages[0]).toBe(lines.length - 1);
	});
});
