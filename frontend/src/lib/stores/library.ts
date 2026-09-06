import { openDB, type DBSchema } from 'idb';
import { parseMarkdownStructure, type Section, type PageMapItem } from '$lib/markdown/parse';

export interface Doc {
	id: string;
	title: string;
	markdown: string;
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
const DB_VERSION = 3;

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
					markdown,
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

export async function getDoc(id: string): Promise<Doc | undefined> {
	const db = await getDB();
	return db.get('docs', id);
}

export async function getAllDocs(): Promise<Doc[]> {
	const db = await getDB();
	const docs = await db.getAll('docs');
	return docs.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteDoc(id: string): Promise<void> {
	const db = await getDB();
	await db.delete('docs', id);
}

export async function createDoc(title: string, markdown: string, pageMap?: PageMapItem[]): Promise<Doc> {
	const sections = parseMarkdownStructure(markdown);
	const doc: Doc = {
		id: 'doc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
		title: title.trim() || 'Untitled',
		markdown,
		sections,
		pageMap,
		createdAt: Date.now(),
		updatedAt: Date.now()
	};
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
