import { openDB, type DBSchema } from 'idb';
import { parseMarkdownStructure, type Section, type PageMapItem } from '$lib/markdown/parse';
import {
	applyPostprocessing,
	DEFAULT_POSTPROCESS,
	type PostprocessOptions
} from '$lib/markdown/postprocess';

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
}

export interface VoiceRecord {
	id: string;
	name: string;
	blob: Blob;
	bytes: number;
	sourceWavName?: string;
	createdAt: number;
}

const DB_NAME = 'ocr-tts';
const DB_VERSION = 4;

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
	const db = await getDB();
	doc.updatedAt = Date.now();
	await db.put('docs', doc);
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

/** Re-render a doc from its stored raw Markdown with new options (offline). */
export async function reapplyPostprocessing(
	doc: Doc,
	opts: PostprocessOptions
): Promise<Doc> {
	const source = doc.rawMarkdown ?? doc.markdown;
	const rawMap = doc.rawPageMap ?? doc.pageMap ?? null;
	const rendered = applyPostprocessing(source, opts, rawMap);
	// Preserve raw source on first re-render of legacy docs.
	if (doc.rawMarkdown === undefined) doc.rawMarkdown = doc.markdown;
	if (doc.rawPageMap === undefined && doc.pageMap) doc.rawPageMap = doc.pageMap;
	doc.markdown = rendered.markdown;
	doc.sections = rendered.sections;
	doc.pageMap = rendered.pageMap;
	doc.postprocess = { ...opts };
	await saveDoc(doc);
	return doc;
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
	return db.getAll('voices');
}

export async function deleteVoice(id: string): Promise<void> {
	const db = await getDB();
	await db.delete('voices', id);
}

export async function getVoice(id: string): Promise<VoiceRecord | undefined> {
	const db = await getDB();
	return db.get('voices', id);
}
