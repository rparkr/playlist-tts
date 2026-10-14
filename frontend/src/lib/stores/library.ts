import { openDB, type DBSchema } from 'idb';
import { parseMarkdownStructure, type Section, type PageMapItem } from '$lib/markdown/parse';
import {
	applyPostprocessing,
	DEFAULT_POSTPROCESS,
	stripPageMarkers,
	type PostprocessOptions
} from '$lib/markdown/postprocess';
import type { ItemSource, ItemSourceKind, Playlist, PlaylistItem } from '$lib/playlists/model';

export interface Doc {
	id: string;
	title: string;
	/** URL-friendly slug derived from title (human-readable `?doc=` value). */
	slug?: string;
	/** Rendered Markdown after post-processing (what the reader shows). */
	markdown: string;
	/** Raw OCR Markdown before post-processing (source for offline re-render). */
	rawMarkdown?: string;
	/** Page map aligned to `rawMarkdown` (source for marker insertion). */
	rawPageMap?: PageMapItem[];
	/** Options used to render `markdown` from `rawMarkdown`. */
	postprocess?: PostprocessOptions;
	sections: Section[];
	pageMap?: PageMapItem[];
	createdAt: number;
	updatedAt: number;
}

interface OCRTTSDB extends DBSchema {
	docs: { key: string; value: Doc };
	voices: { key: string; value: VoiceRecord };
	pdfs: { key: string; value: PdfRecord };
	assets: { key: string; value: DocAsset };
	audio: { key: string; value: OfflineAudioRecord };
	playlists: { key: string; value: Playlist };
	items: { key: string; value: PlaylistItem; indexes: { 'by-playlist': string } };
}

export interface VoiceRecord {
	id: string;
	name: string;
	blob: Blob;
	bytes: number;
	sourceWavName?: string;
	createdAt: number;
}

/** Cached source PDF for a doc, so the viewer survives reloads/doc switches. */
export interface PdfRecord {
	/** Matches the owning `Doc.id`. */
	docId: string;
	blob: Blob;
	bytes: number;
	name: string;
	createdAt: number;
}

/** Cached ePub image asset for a doc (key `${docId}::${path}`). */
export interface DocAsset {
	/** Composite key: owning `Doc.id` + image path as referenced in Markdown. */
	key: string;
	docId: string;
	/** Image path relative to the ePub OPF directory (the Markdown `src`). */
	path: string;
	blob: Blob;
	bytes: number;
	mediaType: string;
	createdAt: number;
}

/** Pre-generated single-file chapter audio for offline / lock-screen listening.
 *
 * Key `${docId}::${voiceKey}::${fmt}` — one file per voice+format combo.
 * `textHash` marks the exact speakable text it was built from so edits can
 * flag the file as stale instead of silently playing outdated audio.
 */
export interface OfflineAudioRecord {
	/** Composite key: owning `Doc.id` + voice + container format. */
	key: string;
	docId: string;
	voiceKey: string;
	fmt: string;
	blob: Blob;
	bytes: number;
	mediaType: string;
	textHash: string;
	createdAt: number;
}

const DB_NAME = 'ocr-tts';
const DB_VERSION = 8;

function getDB() {
	return openDB<OCRTTSDB>(DB_NAME, DB_VERSION, {
		upgrade(db, oldVersion) {
			if (oldVersion < 1) {
				db.createObjectStore('docs', { keyPath: 'id' });
				db.createObjectStore('voices', { keyPath: 'id' });
			}
			if (oldVersion < 3 && !db.objectStoreNames.contains('voices')) {
				db.createObjectStore('voices', { keyPath: 'id' });
			}
			if (!db.objectStoreNames.contains('pdfs')) {
				db.createObjectStore('pdfs', { keyPath: 'docId' });
			}
			if (!db.objectStoreNames.contains('assets')) {
				db.createObjectStore('assets', { keyPath: 'key' });
			}
			if (!db.objectStoreNames.contains('audio')) {
				db.createObjectStore('audio', { keyPath: 'key' });
			}
			// Phase 3 playlist library (IndexedDB-only MVP): docs/voices/pdfs
			// stay as-is; playlists order items via `itemIds`, items link to
			// docs via `docId`. No seeding — existing docs stay unlisted
			// until the user adds them to a playlist.
			if (!db.objectStoreNames.contains('playlists')) {
				db.createObjectStore('playlists', { keyPath: 'id' });
			}
			if (!db.objectStoreNames.contains('items')) {
				const store = db.createObjectStore('items', { keyPath: 'id' });
				store.createIndex('by-playlist', 'playlistId', { unique: false });
			}
		}
	});
}

// Migration from LocalStorage v1
export async function migrateFromLocalStorage(): Promise<void> {
	const key = 'tts_library_v1';
	const raw = localStorage.getItem(key);
	if (!raw) return;
	try {
		const parsed = JSON.parse(raw);
		const db = await getDB();
		for (const [id, doc] of Object.entries(parsed as Record<string, unknown>)) {
			const d = doc as Record<string, unknown>;
			// Try to reconstruct Doc
			const sections = (d.sections as Section[]) ?? parseMarkdownStructure('');
			const markdown = (d as { markdown?: string }).markdown ?? '';
			const title = (d as { title?: string }).title ?? id;
			const existing = await db.get('docs', id);
			if (!existing) {
				await db.put('docs', {
					id,
					title,
					slug: slugify(title),
					markdown,
					rawMarkdown: markdown,
					postprocess: { ...DEFAULT_POSTPROCESS },
					sections,
					createdAt: Date.now(),
					updatedAt: Date.now()
				});
			}
		}
		localStorage.setItem('tts_library_migrated_v3', '1');
	} catch {
		// ignore
	}
}

export async function saveDoc(doc: Doc): Promise<void> {
	doc.updatedAt = Date.now();
	// `doc` is often a Svelte 5 `$state` proxy in the UI layer. Proxies (and
	// any nested proxied values) fail IndexedDB structured-clone with
	// "could not be cloned". Docs are plain JSON-safe data (no Blobs), so
	// round-trip through JSON to strip proxies before `put`.
	const storable = JSON.parse(JSON.stringify(doc)) as Doc;
	const db = await getDB();
	await db.put('docs', storable);
}

/** Pre-generated offline chapter audio (one file per doc+voice+format). */

export function offlineAudioKey(docId: string, voiceKey: string, fmt: string): string {
	return `${docId}::${voiceKey}::${fmt}`;
}

/** Persist a generated chapter file for offline / lock-screen playback. */
export async function saveOfflineAudio(record: Omit<OfflineAudioRecord, 'key' | 'bytes' | 'createdAt'> & { blob: Blob }): Promise<OfflineAudioRecord> {
	const db = await getDB();
	const stored: OfflineAudioRecord = {
		...record,
		key: offlineAudioKey(record.docId, record.voiceKey, record.fmt),
		bytes: record.blob.size,
		createdAt: Date.now()
	};
	await db.put('audio', stored);
	return stored;
}

/** Load a cached chapter file for an exact doc+voice+format combo. */
export async function getOfflineAudio(docId: string, voiceKey: string, fmt: string): Promise<OfflineAudioRecord | undefined> {
	const db = await getDB();
	try {
		return await db.get('audio', offlineAudioKey(docId, voiceKey, fmt));
	} catch {
		return undefined;
	}
}

/** Remove one cached chapter file to free storage; keeps the doc itself. */
export async function deleteOfflineAudio(docId: string, voiceKey: string, fmt: string): Promise<void> {
	const db = await getDB();
	try {
		await db.delete('audio', offlineAudioKey(docId, voiceKey, fmt));
	} catch {
		// ignore — store may not exist yet
	}
}

/** Remove every cached chapter file for a doc (all voices/formats). */
export async function deleteOfflineAudioByDoc(docId: string): Promise<void> {
	const db = await getDB();
	try {
		const keys = await db.getAllKeys('audio');
		for (const k of keys) {
			if (k === docId || k.startsWith(`${docId}::`)) await db.delete('audio', k);
		}
	} catch {
		// ignore — store may not exist yet
	}
}

/** Lightweight `{ key, bytes }` listing for offline-audio storage UI. */
export async function getOfflineAudioSizes(): Promise<Record<string, number>> {
	const db = await getDB();
	try {
		const all = await db.getAll('audio');
		const sizes: Record<string, number> = {};
		for (const r of all) sizes[r.key] = r.bytes;
		return sizes;
	} catch {
		return {};
	}
}

export function slugify(title: string): string {
	const s = title
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.replace(/-{2,}/g, '-');
	return s || 'untitled';
}

function uniqueSlug(base: string, existing: Set<string>): string {
	if (!existing.has(base)) return base;
	let i = 2;
	while (existing.has(`${base}-${i}`)) i++;
	return `${base}-${i}`;
}

export async function getDoc(id: string): Promise<Doc | undefined> {
	const db = await getDB();
	const doc = await db.get('docs', id);
	if (doc) return ensureDocDefaults(doc);
	return undefined;
}

export async function getDocBySlugOrId(idOrSlug: string): Promise<Doc | undefined> {
	const db = await getDB();
	const byId = await db.get('docs', idOrSlug);
	if (byId) return ensureDocDefaults(byId);
	const all = await db.getAll('docs');
	const match = all.find((d) => d.slug === idOrSlug);
	if (match) return ensureDocDefaults(match);
	return undefined;
}

/** Backfill slugs and raw source fields; persists fixes. */
export async function ensureAllDocSlugs(): Promise<void> {
	const db = await getDB();
	const all = await db.getAll('docs');
	const taken = new Set(all.map((d) => d.slug).filter(Boolean) as string[]);
	for (const doc of all) {
		let changed = false;
		if (!doc.slug) {
			doc.slug = uniqueSlug(slugify(doc.title), taken);
			taken.add(doc.slug);
			changed = true;
		}
		if (doc.rawMarkdown === undefined) {
			doc.rawMarkdown = doc.markdown;
			changed = true;
		}
		if (doc.postprocess === undefined) {
			doc.postprocess = { ...DEFAULT_POSTPROCESS };
			changed = true;
		}
		if (changed) {
			doc.updatedAt = Date.now();
			await db.put('docs', doc);
		}
	}
}

/** Fill in a missing slug for docs created before slugs existed. */
function ensureDocSlug<T extends Doc>(doc: T): T {
	if (doc.slug) return doc;
	doc.slug = slugify(doc.title);
	return doc;
}

/** Backfill raw source fields for docs created before raw storage existed. */
export function ensureDocDefaults<T extends Doc>(doc: T): T {
	ensureDocSlug(doc);
	if (doc.rawMarkdown === undefined) doc.rawMarkdown = doc.markdown;
	if (doc.postprocess === undefined) doc.postprocess = { ...DEFAULT_POSTPROCESS };
	return doc;
}

export async function getAllDocs(): Promise<Doc[]> {
	const db = await getDB();
	const docs = await db.getAll('docs');
	for (const d of docs) ensureDocDefaults(d);
	return docs.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteDoc(id: string): Promise<void> {
	const db = await getDB();
	await db.delete('docs', id);
	// Don't orphan the cached PDF: the doc is gone so its preview is useless.
	try {
		await db.delete('pdfs', id);
	} catch {
		// ignore — pdfs store may be missing on very old profiles until upgrade
	}
	await deleteDocAssets(id);
	await deleteOfflineAudioByDoc(id);
}

/** Re-export defaults for UI state initialisation. */
export { DEFAULT_POSTPROCESS };
export type { PostprocessOptions };

/** Create a doc from raw OCR output, rendering processed Markdown client-side. */
export async function createDoc(
	title: string,
	rawMarkdown: string,
	rawPageMap?: PageMapItem[],
	opts?: PostprocessOptions
): Promise<Doc> {
	const postprocess = opts ?? { ...DEFAULT_POSTPROCESS };
	const rendered = applyPostprocessing(rawMarkdown, postprocess, rawPageMap ?? null);
	const cleanTitle = title.trim() || 'Untitled';
	const db = await getDB();
	const existing = await db.getAll('docs');
	const taken = new Set(existing.map((d) => d.slug).filter(Boolean) as string[]);
	const doc: Doc = {
		id: 'doc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
		title: cleanTitle,
		slug: uniqueSlug(slugify(cleanTitle), taken),
		markdown: rendered.markdown,
		rawMarkdown,
		rawPageMap,
		postprocess,
		sections: rendered.sections,
		pageMap: rendered.pageMap,
		createdAt: Date.now(),
		updatedAt: Date.now()
	};
	await saveDoc(doc);
	return doc;
}

/** Re-render a doc from its stored raw Markdown with new options (offline).
 *
 * When `editedSource` is provided (the user's current Markdown draft differs
 * from the last render), re-render from those edits instead of discarding
 * them: strip previously-inserted `Page N.` markers so the toggle applies
 * cleanly, run the pipeline on the edited text, and promote the edited text
 * to the new raw source so future re-renders keep the edits. Never mutates
 * the input (which may be a Svelte proxy) before the save succeeds.
 */
export async function reapplyPostprocessing(
	doc: Doc,
	opts: PostprocessOptions,
	editedSource?: string
): Promise<Doc> {
	const useEdited = editedSource !== undefined;
	let source: string;
	let rawMap: PageMapItem[] | null;
	let nextRawMarkdown: string | undefined;
	let nextRawPageMap: PageMapItem[] | undefined;

	if (useEdited) {
		// The draft may already equal the auto-saved doc text; it still counts
		// as edited when the caller passes it (draft differs from last render).
		const clean = stripPageMarkers(editedSource as string);
		source = clean;
		rawMap = null;
		nextRawMarkdown = clean;
		nextRawPageMap = undefined;
	} else {
		source = doc.rawMarkdown ?? doc.markdown;
		rawMap = doc.rawPageMap ?? doc.pageMap ?? null;
		// Preserve raw source on first re-render of legacy docs.
		nextRawMarkdown = doc.rawMarkdown === undefined ? doc.markdown : doc.rawMarkdown;
		nextRawPageMap =
			doc.rawPageMap === undefined && doc.pageMap ? doc.pageMap : doc.rawPageMap;
	}
	const rendered = applyPostprocessing(source, opts, rawMap);
	const updated: Doc = {
		...JSON.parse(JSON.stringify(doc)) as Doc,
		markdown: rendered.markdown,
		sections: rendered.sections,
		pageMap: rendered.pageMap,
		postprocess: { ...opts },
		rawMarkdown: nextRawMarkdown,
		rawPageMap: nextRawPageMap
	};
	if (updated.rawMarkdown === undefined) delete (updated as Partial<Doc>).rawMarkdown;
	if (updated.rawPageMap === undefined) delete (updated as Partial<Doc>).rawPageMap;
	await saveDoc(updated);
	return updated;
}

/** Rename a doc and refresh its slug to track the new title (unique). */
export async function renameDoc(id: string, newTitle: string): Promise<Doc | undefined> {
	const db = await getDB();
	const doc = await db.get('docs', id);
	if (!doc) return undefined;
	doc.title = newTitle.trim() || doc.title;
	const all = await db.getAll('docs');
	const taken = new Set(all.filter((d) => d.id !== id).map((d) => d.slug).filter(Boolean) as string[]);
	doc.slug = uniqueSlug(slugify(doc.title), taken);
	await saveDoc(doc);
	return doc;
}

export async function updateDocMarkdown(id: string, markdown: string): Promise<Doc | undefined> {
	const doc = await getDoc(id);
	if (!doc) return undefined;
	doc.markdown = markdown;
	doc.sections = parseMarkdownStructure(markdown);
	await saveDoc(doc);
	return doc;
}

// Voices
export async function saveVoice(record: VoiceRecord): Promise<void> {
	const db = await getDB();
	await db.put('voices', record);
}

export async function getVoices(): Promise<VoiceRecord[]> {
	const db = await getDB();
	const voices = await db.getAll('voices');
	// Keep the picker stable: alphabetical, case-insensitive. The modal pins
	// these cloned voices in their own top optgroup.
	return voices.sort((a, b) =>
		a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
	);
}

export async function deleteVoice(id: string): Promise<void> {
	const db = await getDB();
	await db.delete('voices', id);
}

/** Rename a cloned voice; trims whitespace and keeps the existing name when blank. */
export async function renameVoice(id: string, newName: string): Promise<VoiceRecord | undefined> {
	const db = await getDB();
	const record = await db.get('voices', id);
	if (!record) return undefined;
	const clean = newName.trim();
	if (clean) record.name = clean;
	await db.put('voices', record);
	return record;
}

export async function getVoice(id: string): Promise<VoiceRecord | undefined> {
	const db = await getDB();
	return db.get('voices', id);
}

// Cached source PDFs (one per doc) for the PDF viewer.

/** Persist the uploaded PDF bytes for a doc so the viewer can reload them later. */
export async function savePdf(docId: string, data: Blob, name: string): Promise<PdfRecord> {
	const db = await getDB();
	const record: PdfRecord = {
		docId,
		blob: data,
		bytes: data.size,
		name,
		createdAt: Date.now()
	};
	await db.put('pdfs', record);
	return record;
}

/** Load a cached PDF for a doc, if one was stored. */
export async function getPdf(docId: string): Promise<PdfRecord | undefined> {
	const db = await getDB();
	try {
		return await db.get('pdfs', docId);
	} catch {
		return undefined;
	}
}

/** Remove the cached PDF for a doc to free storage; keeps the doc itself. */
export async function deletePdf(docId: string): Promise<void> {
	const db = await getDB();
	try {
		await db.delete('pdfs', docId);
	} catch {
		// ignore — store may not exist yet
	}
}

/** Lightweight `{ docId, bytes }` listing for library storage UI (no blob reads by caller). */
export async function getPdfSizes(): Promise<Record<string, number>> {
	const db = await getDB();
	try {
		const all = await db.getAll('pdfs');
		const sizes: Record<string, number> = {};
		for (const r of all) sizes[r.docId] = r.bytes;
		return sizes;
	} catch {
		return {};
	}
}

// Playlists + items (Phase 3 library, IndexedDB-only). `playlist.itemIds`
// is the order source of truth; item rows carry the payload.

// Cached ePub image assets (many per doc), resolved at render time.

/** Persist converted ePub images for a doc so relative refs render later. */
export async function saveDocAssets(
	docId: string,
	assets: { path: string; blob: Blob; mediaType: string }[]
): Promise<void> {
	const db = await getDB();
	for (const a of assets) {
		const record: DocAsset = {
			key: `${docId}::${a.path}`,
			docId,
			path: a.path,
			blob: a.blob,
			bytes: a.blob.size,
			mediaType: a.mediaType,
			createdAt: Date.now()
		};
		await db.put('assets', record);
	}
}

/** Load one cached image asset by its Markdown `src` path. */
export async function getDocAsset(docId: string, path: string): Promise<DocAsset | undefined> {
	const db = await getDB();
	try {
		return await db.get('assets', `${docId}::${path}`);
	} catch {
		return undefined;
	}
}

/** True when the doc has any cached image assets (ePub badge heuristic). */
export async function hasDocAssets(docId: string): Promise<boolean> {
	const db = await getDB();
	try {
		const keys = await db.getAllKeys('assets');
		return keys.some((k) => k === docId || k.startsWith(`${docId}::`));
	} catch {
		return false;
	}
}

/** Remove all cached image assets for a doc to free storage. */
export async function deleteDocAssets(docId: string): Promise<void> {
	const db = await getDB();
	try {
		const keys = await db.getAllKeys('assets');
		for (const k of keys) {
			if (k === docId || k.startsWith(`${docId}::`)) await db.delete('assets', k);
		}
	} catch {
		// ignore — store may not exist yet
	}
}

function newId(prefix: string): string {
	return `${prefix}_` + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Create a playlist with an empty item list. */
export async function createPlaylist(name: string): Promise<Playlist> {
	const clean = name.trim() || 'Untitled playlist';
	const db = await getDB();
	const now = Date.now();
	const playlist: Playlist = {
		id: newId('pl'),
		name: clean,
		itemIds: [],
		createdAt: now,
		updatedAt: now,
		lastListenedAt: null
	};
	await db.put('playlists', playlist);
	return playlist;
}

/** All playlists in overview order (most-recently-listened first). */
export async function getPlaylists(): Promise<Playlist[]> {
	const db = await getDB();
	try {
		const all = await db.getAll('playlists');
		return all.sort((a, b) => {
			const la = a.lastListenedAt ?? -1;
			const lb = b.lastListenedAt ?? -1;
			if (la !== lb) return lb - la;
			return b.updatedAt - a.updatedAt;
		});
	} catch {
		return [];
	}
}

export async function getPlaylist(id: string): Promise<Playlist | undefined> {
	const db = await getDB();
	try {
		return await db.get('playlists', id);
	} catch {
		return undefined;
	}
}

/** Rename a playlist; blank names keep the existing name. */
export async function renamePlaylist(id: string, name: string): Promise<Playlist | undefined> {
	const db = await getDB();
	const playlist = await db.get('playlists', id);
	if (!playlist) return undefined;
	const clean = name.trim();
	if (clean) playlist.name = clean;
	playlist.updatedAt = Date.now();
	await db.put('playlists', playlist);
	return playlist;
}

/** Delete a playlist and cascade-delete its items (docs are kept). */
export async function deletePlaylist(id: string): Promise<void> {
	const db = await getDB();
	const tx = db.transaction(['playlists', 'items'], 'readwrite');
	await tx.objectStore('playlists').delete(id);
	const index = tx.objectStore('items').index('by-playlist');
	for (const key of await index.getAllKeys(id)) {
		await tx.objectStore('items').delete(key);
	}
	await tx.done;
}

/** Mark a playlist as listened-to now (drives overview resume order). */
export async function touchPlaylistListened(id: string): Promise<void> {
	const db = await getDB();
	const playlist = await db.get('playlists', id);
	if (!playlist) return;
	playlist.lastListenedAt = Date.now();
	playlist.updatedAt = playlist.lastListenedAt;
	await db.put('playlists', playlist);
}

/** Items of a playlist in card order (`playlist.itemIds` first). */
export async function getPlaylistItems(playlistId: string): Promise<PlaylistItem[]> {
	const db = await getDB();
	const playlist = await db.get('playlists', playlistId);
	if (!playlist) return [];
	let rows: PlaylistItem[];
	try {
		rows = await db.getAllFromIndex('items', 'by-playlist', playlistId);
	} catch {
		const all = await db.getAll('items');
		rows = all.filter((i) => i.playlistId === playlistId);
	}
	const byId = new Map(rows.map((i) => [i.id, i]));
	const ordered = playlist.itemIds.map((id) => byId.get(id)).filter(Boolean) as PlaylistItem[];
	// Orphan rows (missing from `itemIds` after a crash) trail at the end.
	for (const row of rows) {
		if (!playlist.itemIds.includes(row.id)) ordered.push(row);
	}
	return ordered;
}

export interface NewPlaylistItem {
	title: string;
	source: ItemSource;
	docId: string;
	totalSentences: number;
	progress?: number;
}

/** Append a doc-backed item to a playlist. */
export async function addPlaylistItem(
	playlistId: string,
	init: NewPlaylistItem
): Promise<PlaylistItem | undefined> {
	const db = await getDB();
	const playlist = await db.get('playlists', playlistId);
	if (!playlist) return undefined;
	const now = Date.now();
	const item: PlaylistItem = {
		id: newId('it'),
		playlistId,
		title: init.title.trim() || 'Untitled',
		source: init.source,
		docId: init.docId,
		progress: Math.max(0, init.progress ?? 0),
		totalSentences: Math.max(0, init.totalSentences),
		createdAt: now,
		updatedAt: now
	};
	const tx = db.transaction(['playlists', 'items'], 'readwrite');
	await tx.objectStore('items').put(item);
	playlist.itemIds = [...playlist.itemIds, item.id];
	playlist.updatedAt = now;
	await tx.objectStore('playlists').put(playlist);
	await tx.done;
	return item;
}

/** Rename an item (playlist-scoped; the underlying doc title is untouched). */
export async function renamePlaylistItem(id: string, title: string): Promise<PlaylistItem | undefined> {
	const db = await getDB();
	const item = await db.get('items', id);
	if (!item) return undefined;
	const clean = title.trim();
	if (clean) item.title = clean;
	item.updatedAt = Date.now();
	await db.put('items', item);
	return item;
}

/** Remove an item from its playlist (the underlying doc is kept). */
export async function deletePlaylistItem(id: string): Promise<void> {
	const db = await getDB();
	const item = await db.get('items', id);
	if (!item) return;
	const tx = db.transaction(['playlists', 'items'], 'readwrite');
	await tx.objectStore('items').delete(id);
	const playlist = await tx.objectStore('playlists').get(item.playlistId);
	if (playlist) {
		playlist.itemIds = playlist.itemIds.filter((itemId) => itemId !== id);
		playlist.updatedAt = Date.now();
		await tx.objectStore('playlists').put(playlist);
	}
	await tx.done;
}

/** Persist a card reorder (drag, or up/down fallback buttons). */
export async function movePlaylistItem(
	playlistId: string,
	itemId: string,
	toIndex: number
): Promise<Playlist | undefined> {
	const db = await getDB();
	const playlist = await db.get('playlists', playlistId);
	if (!playlist || !playlist.itemIds.includes(itemId)) return undefined;
	const from = playlist.itemIds.indexOf(itemId);
	const next = [...playlist.itemIds];
	const [moved] = next.splice(from, 1);
	next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, moved);
	playlist.itemIds = next;
	playlist.updatedAt = Date.now();
	await db.put('playlists', playlist);
	return playlist;
}

/** Persist playback progress on an item (sentence index + cached totals). */
export async function updatePlaylistItemProgress(
	id: string,
	progress: number,
	totalSentences?: number
): Promise<PlaylistItem | undefined> {
	const db = await getDB();
	const item = await db.get('items', id);
	if (!item) return undefined;
	item.progress = Math.max(0, progress);
	if (totalSentences !== undefined) item.totalSentences = Math.max(0, totalSentences);
	item.updatedAt = Date.now();
	await db.put('items', item);
	return item;
}

/** Every playlist item (for unassigned-doc computation and search). */
export async function getAllItems(): Promise<PlaylistItem[]> {
	const db = await getDB();
	try {
		return await db.getAll('items');
	} catch {
		return [];
	}
}

/** Remove every playlist item pointing at a deleted doc (order fixup included). */
export async function deleteItemsByDocId(docId: string): Promise<string[]> {
	const db = await getDB();
	let all: PlaylistItem[];
	try {
		all = await db.getAll('items');
	} catch {
		return [];
	}
	const affected = new Set<string>();
	for (const item of all.filter((i) => i.docId === docId)) {
		affected.add(item.playlistId);
		await deletePlaylistItem(item.id);
	}
	return [...affected];
}

/** Re-export playlist model types for UI layers. */
export type { ItemSource, ItemSourceKind, Playlist, PlaylistItem };
