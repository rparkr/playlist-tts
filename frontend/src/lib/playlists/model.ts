/** Playlist library model — pure types and ordering/label helpers.
 *
 * Persistence lives in `$lib/stores/library` (IndexedDB v6 `playlists` and
 * `items` stores). This module stays side-effect free so `vitest` can cover
 * the ordering and label rules without a browser IndexedDB.
 */

/** Where a playlist item's document came from. */
export type ItemSourceKind =
	| 'pdf-upload'
	| 'markdown-upload'
	| 'markdown-paste'
	| 'epub-upload'
	| 'article-url'
	| 'pdf-url';

export interface ItemSource {
	kind: ItemSourceKind;
	/** Lowercased host for `article-url` / `pdf-url` items (card badge). */
	domain?: string;
	/** Original URL for `article-url` / `pdf-url` items. */
	url?: string;
}

export interface Playlist {
	id: string;
	name: string;
	/** Ordered item ids — the source of truth for card order. */
	itemIds: string[];
	createdAt: number;
	updatedAt: number;
	/** Last time playback ran inside this playlist (overview resume order). */
	lastListenedAt: number | null;
}

export interface PlaylistItem {
	id: string;
	playlistId: string;
	title: string;
	source: ItemSource;
	/** Link to the `Doc` in the `docs` store that holds the Markdown. */
	docId: string;
	/** Last sentence index (mirrors the reader's saved progress). */
	progress: number;
	/** Cached sentence count at creation; refreshed when the item opens. */
	totalSentences: number;
	createdAt: number;
	updatedAt: number;
}

/** Human-readable source badge for item cards. */
export function sourceLabel(source: ItemSource): string {
	switch (source.kind) {
		case 'pdf-upload':
			return 'PDF upload';
		case 'markdown-upload':
			return 'Markdown';
		case 'markdown-paste':
			return 'Pasted text';
		case 'epub-upload':
			return 'ePub';
		case 'article-url':
			return source.domain || 'Article URL';
		case 'pdf-url':
			return source.domain ? `PDF · ${source.domain}` : 'PDF URL';
	}
}

/** Overview order: most-recently-listened first, never-listened by recency. */
export function sortPlaylists(playlists: readonly Playlist[]): Playlist[] {
	return [...playlists].sort((a, b) => {
		const la = a.lastListenedAt ?? -1;
		const lb = b.lastListenedAt ?? -1;
		if (la !== lb) return lb - la;
		if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
		return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
	});
}

/** Move an id within an order array (drag reorder with up/down fallback). */
export function reorderIds(ids: readonly string[], fromIndex: number, toIndex: number): string[] {
	const next = [...ids];
	if (fromIndex < 0 || fromIndex >= next.length) return next;
	const clamped = Math.max(0, Math.min(toIndex, next.length - 1));
	const [moved] = next.splice(fromIndex, 1);
	next.splice(clamped, 0, moved);
	return next;
}

/** Aggregate `{ done, total }` sentence counts for progress bars. */
export function playlistTotals(
	items: readonly Pick<PlaylistItem, 'progress' | 'totalSentences'>[]
): { done: number; total: number } {
	let done = 0;
	let total = 0;
	for (const item of items) {
		const t = Math.max(0, item.totalSentences);
		total += t;
		done += Math.max(0, Math.min(item.progress, t));
	}
	return { done, total };
}

/** Extract the host from a user-entered URL (empty string when unparseable). */
export function domainOf(rawUrl: string): string {
	try {
		const candidate = rawUrl.includes('://') ? rawUrl : `https://${rawUrl}`;
		return new URL(candidate).hostname.toLowerCase();
	} catch {
		return '';
	}
}

/** True when the URL points at a PDF (routes to the PDF-URL import path). */
export function isPdfUrl(rawUrl: string): boolean {
	return rawUrl.toLowerCase().split('?')[0].split('#')[0].trim().endsWith('.pdf');
}

/** True when the URL points at an ePub book (routes to the ePub import path). */
export function isEpubUrl(rawUrl: string): boolean {
	return rawUrl.toLowerCase().split('?')[0].split('#')[0].trim().endsWith('.epub');
}
