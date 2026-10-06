import { describe, expect, it } from 'vitest';
import {
	domainOf,
	isPdfUrl,
	playlistTotals,
	reorderIds,
	sortPlaylists,
	sourceLabel,
	type Playlist
} from './model';

function playlist(over: Partial<Playlist> & { id: string }): Playlist {
	return {
		name: over.id,
		itemIds: [],
		createdAt: 0,
		updatedAt: 0,
		lastListenedAt: null,
		...over
	};
}

describe('sortPlaylists', () => {
	it('orders most-recently-listened first, unlistened by recency', () => {
		const a = playlist({ id: 'a', updatedAt: 3 });
		const b = playlist({ id: 'b', updatedAt: 1, lastListenedAt: 10 });
		const c = playlist({ id: 'c', updatedAt: 2, lastListenedAt: 20 });
		expect(sortPlaylists([a, b, c]).map((p) => p.id)).toEqual(['c', 'b', 'a']);
	});
});

describe('reorderIds', () => {
	it('moves an entry to the target index', () => {
		expect(reorderIds(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
		expect(reorderIds(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
	});

	it('clamps out-of-range targets and ignores bad sources', () => {
		expect(reorderIds(['a', 'b'], 0, 99)).toEqual(['b', 'a']);
		expect(reorderIds(['a', 'b'], 7, 0)).toEqual(['a', 'b']);
	});
});

describe('sourceLabel', () => {
	it('labels uploads and pastes', () => {
		expect(sourceLabel({ kind: 'pdf-upload' })).toBe('PDF upload');
		expect(sourceLabel({ kind: 'markdown-upload' })).toBe('Markdown');
		expect(sourceLabel({ kind: 'markdown-paste' })).toBe('Pasted text');
	});

	it('badges URL items with their domain', () => {
		expect(sourceLabel({ kind: 'article-url', domain: 'example.com' })).toBe('example.com');
		expect(sourceLabel({ kind: 'pdf-url', domain: 'example.com' })).toBe('PDF · example.com');
	});
});

describe('playlistTotals', () => {
	it('clamps progress to each item total', () => {
		expect(
			playlistTotals([
				{ progress: 5, totalSentences: 10 },
				{ progress: 99, totalSentences: 4 }
			])
		).toEqual({ done: 9, total: 14 });
	});
});

describe('domainOf / isPdfUrl', () => {
	it('extracts hosts and detects PDF urls', () => {
		expect(domainOf('https://Example.COM/article?q=1')).toBe('example.com');
		expect(domainOf('not a url with spaces !!')).toBe('');
		expect(isPdfUrl('https://example.com/paper.pdf')).toBe(true);
		expect(isPdfUrl('https://example.com/article')).toBe(false);
	});
});
