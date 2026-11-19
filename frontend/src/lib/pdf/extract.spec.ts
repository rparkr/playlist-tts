import { describe, expect, it } from 'vitest';
import { mergeOcrResults } from './extract';

describe('mergeOcrResults', () => {
	it('replaces only pages with OCR text', () => {
		const pages = ['browser one', 'browser two', 'browser three'];
		const merged = mergeOcrResults(pages, {
			pages: new Map([
				[2, '# OCR two'],
				[3, '   ']
			]),
			failed: [3]
		});
		expect(merged).toEqual(['browser one', '# OCR two', 'browser three']);
	});

	it('leaves the array unchanged when OCR produced nothing', () => {
		const pages = ['only'];
		expect(mergeOcrResults(pages, { pages: new Map(), failed: [1] })).toEqual(['only']);
	});
});
