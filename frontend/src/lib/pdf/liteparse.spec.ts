import { describe, expect, it } from 'vitest';
import { countReasons, ocrWorthyPages, type ComplexityPage } from './liteparse';

/** Build a page with the fields the routing helpers read. */
function page(
	pageNumber: number,
	needsOcr: boolean,
	reasons: string[] = []
): ComplexityPage {
	return { pageNumber, needsOcr, reasons, textLength: 0 };
}

describe('ocrWorthyPages', () => {
	it('selects pages whose reasons OCR can improve', () => {
		const pages = [
			page(1, false),
			page(2, true, ['scanned']),
			page(3, true, ['garbled']),
			page(4, true, ['vector-text']),
			page(5, true, ['annotation-text'])
		];
		expect(ocrWorthyPages(pages).map((p) => p.pageNumber)).toEqual([2, 3, 4, 5]);
	});

	it('ignores figure-heavy and sparse-text pages', () => {
		const pages = [
			page(1, true, ['embedded-images']),
			page(2, true, ['sparse-text']),
			page(3, true, ['no-text']),
			page(4, true, ['embedded-images', 'scanned'])
		];
		expect(ocrWorthyPages(pages).map((p) => p.pageNumber)).toEqual([4]);
	});
});

describe('countReasons', () => {
	it('counts only OCR-relevant reasons', () => {
		const pages = [
			page(1, true, ['scanned', 'embedded-images']),
			page(2, true, ['scanned', 'garbled'])
		];
		expect(countReasons(pages)).toEqual({ scanned: 2, garbled: 1 });
	});
});
