import { describe, it, expect } from 'vitest';
import {
	collapseWs,
	visualWidth,
	rowsForLine,
	rowsAbove,
	lineForRow,
	lineForCharIndex,
	stripMarkdownForMatch,
	snippetForSourceLine,
	nearestIndex,
	candidateLines
} from './scrollAnchor';

describe('scroll anchors', () => {
	it('measures visual rows with tab expansion and wrapping', () => {
		expect(visualWidth('ab\tc')).toBe(2 + 6 + 1);
		expect(rowsForLine('', 80)).toBe(1);
		expect(rowsForLine('x'.repeat(80), 80)).toBe(1);
		expect(rowsForLine('x'.repeat(81), 80)).toBe(2);
		expect(rowsAbove(['a', 'b'.repeat(161), 'c'], 2, 80)).toBe(1 + 3);
		expect(lineForRow(['a', 'b'.repeat(161), 'c'], 0, 80)).toBe(0);
		expect(lineForRow(['a', 'b'.repeat(161), 'c'], 1, 80)).toBe(1);
		expect(lineForRow(['a', 'b'.repeat(161), 'c'], 3, 80)).toBe(1);
		expect(lineForRow(['a', 'b'.repeat(161), 'c'], 4, 80)).toBe(2);
	});

	it('maps char offsets to logical lines', () => {
		expect(lineForCharIndex('ab\ncd\nef', 0)).toBe(0);
		expect(lineForCharIndex('ab\ncd\nef', 4)).toBe(1);
		expect(lineForCharIndex('ab\ncd\nef', 99)).toBe(2);
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

	it('round-trips every logical line through visual rows', () => {
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
		// Narrow (70 cols) and wide (160 cols) editors alike: each logical
		// line maps to visual rows and back to itself.
		for (const cpl of [70, 160]) {
			for (let L = 0; L < lines.length; L++) {
				const R = rowsAbove(lines, L, cpl);
				expect(lineForRow(lines, R, cpl)).toBe(L);
			}
		}
		// Map-style items are findable by their rendered snippet.
		expect(candidateLines(lines, 'Harbor Hill', 0)).not.toEqual([]);
		expect(candidateLines(lines, 'STORAGE ROOM', 0)).not.toEqual([]);
	});
});
