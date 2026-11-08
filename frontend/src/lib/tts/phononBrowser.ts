/** In-browser Phonon 31M TTS — lazy WASM model plus a sentence-to-WAV adapter.
 *
 * The model runs in the package's worker, so the page stays responsive. We
 * load it only when the `phonon-browser` engine is selected, cache it for the
 * lifetime of the tab, and expose progress so the settings UI can explain the
 * one-time download.
 */

import type { LoadProgress, PhononTTS } from 'phonon-tts';
import { localeToVoiceGroup } from '$lib/settings';

export type PhononStatusKind = 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';

export interface PhononStatus {
	kind: PhononStatusKind;
	message: string;
	/** 0–1 while downloading; null when indeterminate. */
	progress: number | null;
	device: 'webgpu' | 'cpu' | null;
	deviceReason: string;
	threads: number;
	threadsReason: string;
	voices: string[];
}

export interface PhononVoice {
	name: string;
	language: string | null;
	/** Display dialect, e.g. `US English`. */
	dialect?: string | null;
	origin: string | null;
	url: string;
	gender?: string | null;
}

/** The same catalog the Rust/Python runtimes use. */
const CATALOG_URL = 'https://huggingface.co/gradium/phonon-voices/resolve/main/voices.jsonl';
const VOICE_BASE_URL = 'https://huggingface.co/gradium/phonon-voices/resolve/main/';
const DEFAULT_VOICE: PhononVoice = {
	name: 'default',
	language: 'English',
	dialect: 'Bundled default',
	origin: 'Bundled default voice',
	url: new URL('default-voice.safetensors', VOICE_BASE_URL).href
};

/** Character voices have no gender in voices.jsonl; keep the curated labels
 * aligned with `backend/data/phonon-voice-associations.json`. */
const CHARACTER_GENDERS: Record<string, string> = {
	'Captain Silas Blackwater': 'male',
	'Morwenna of the Deep': 'female',
	'Old Mortlake': 'male',
	Azgorath: 'male',
	'Fennick the Young Elf': 'male',
	'The Thing Under the Stairs': 'unknown',
	'Vyrmathrax the Ancient': 'male',
	'Grub the Ogre': 'male',
	'Master Aldric': 'male',
	'The Snow Queen': 'female',
	'Sir Bramwell': 'male',
	'Fairy Godmother': 'female'
};

let tts: PhononTTS | null = null;
let loadPromise: Promise<PhononTTS> | null = null;
let catalogPromise: Promise<PhononVoice[]> | null = null;
const registeredVoices = new Set<string>();
const listeners = new Set<(status: PhononStatus) => void>();

let status: PhononStatus = {
	kind: 'idle',
	message: '',
	progress: null,
	device: null,
	deviceReason: '',
	threads: 0,
	threadsReason: '',
	voices: []
};

/** Current model status snapshot. */
export function getPhononStatus(): PhononStatus {
	return status;
}

/** Subscribe to model status changes; returns an unsubscribe function. */
export function subscribePhononStatus(cb: (status: PhononStatus) => void): () => void {
	listeners.add(cb);
	cb(status);
	return () => listeners.delete(cb);
}

function setStatus(patch: Partial<PhononStatus>): void {
	status = { ...status, ...patch };
	for (const cb of listeners) cb(status);
}

function supported(): boolean {
	// Let `PhononTTS.load` produce the precise error for a browser missing
	// WebAssembly SIMD or module workers; this only catches obvious cases.
	return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}

function progressFraction(p: LoadProgress): number | null {
	if (!p.total || p.total <= 0) return null;
	return Math.max(0, Math.min(1, p.loaded / p.total));
}

/** Load the browser model once, returning the shared instance. */
export function ensurePhononModel(): Promise<PhononTTS> {
	if (tts) return Promise.resolve(tts);
	if (loadPromise) return loadPromise;
	if (!supported()) {
		const message = 'This browser does not support the WebAssembly SIMD build Phonon needs.';
		setStatus({ kind: 'unsupported', message, progress: null });
		return Promise.reject(new Error(message));
	}

	setStatus({
		kind: 'loading',
		message: 'Loading Phonon…',
		progress: null,
		device: null,
		threads: 0
	});
	loadPromise = (async () => {
		const mod = await import('phonon-tts');
		const loaded = await mod.PhononTTS.load({
			lang: 'en',
			quant: 'q8',
			device: 'auto',
			threads: 'auto',
			cache: true,
			onProgress: (p) => {
				const fraction = progressFraction(p);
				setStatus({
					kind: 'loading',
					message: p.cached
						? `Loading ${p.file} from cache…`
						: `Downloading ${p.file}${p.total ? ` (${Math.round(p.loaded / 1e6)} of ${Math.round(p.total / 1e6)} MB)` : ''}`,
					progress: fraction
				});
			}
		});
		tts = loaded;
		setStatus({
			kind: 'ready',
			message: `Phonon ready · ${loaded.device === 'webgpu' ? 'WebGPU' : `CPU · ${loaded.threads} thread${loaded.threads === 1 ? '' : 's'}`}`,
			progress: null,
			device: loaded.device,
			deviceReason: loaded.deviceReason,
			threads: loaded.threads,
			threadsReason: loaded.threadsReason,
			voices: loaded.voices
		});
		return loaded;
	})()
		.catch((error: unknown) => {
			loadPromise = null;
			const message = error instanceof Error ? error.message : String(error);
			setStatus({ kind: 'error', message, progress: null });
			throw error;
		});
	return loadPromise;
}

/** Free the model and worker. The next selection loads it again from cache. */
export function disposePhonon(): void {
	tts?.dispose();
	tts = null;
	loadPromise = null;
	registeredVoices.clear();
	setStatus({
		kind: 'idle',
		message: '',
		progress: null,
		device: null,
		deviceReason: '',
		threads: 0,
		threadsReason: '',
		voices: []
	});
}

interface CatalogVoice {
	filename?: string;
	name?: string;
	language?: string;
	locale?: string;
	gender?: string | null;
	description?: string;
}

/** Fetch and cache the English Phonon 31M voice catalog. */
export function listPhononVoices(): Promise<PhononVoice[]> {
	if (catalogPromise) return catalogPromise;
	catalogPromise = fetch(CATALOG_URL)
		.then(async (resp) => {
			if (!resp.ok) throw new Error(`Voice catalog failed (${resp.status})`);
			const text = await resp.text();
			const voices: PhononVoice[] = [DEFAULT_VOICE];
			for (const line of text.split('\n')) {
				if (!line.trim()) continue;
				try {
					const row = JSON.parse(line) as CatalogVoice;
					if (!row.name || !row.filename || row.language !== 'en') continue;
					if (voices.some((v) => v.name === row.name)) continue;
					const group = localeToVoiceGroup(row.locale);
					voices.push({
						name: row.name,
						language: group.language,
						dialect: group.dialect,
						origin: row.description || null,
						url: new URL(row.filename, VOICE_BASE_URL).href,
						gender: row.gender ?? CHARACTER_GENDERS[row.name] ?? null
					});
				} catch {
					// A malformed catalog line should not hide the rest.
				}
			}
			return voices;
		})
		.catch((error) => {
			catalogPromise = null;
			throw error;
		});
	return catalogPromise;
}

async function ensureVoice(
	model: PhononTTS,
	voice: string | null,
	voiceBlob: Blob | null
): Promise<string | undefined> {
	if (voiceBlob) {
		// A Gradium/Phonon voice file from IndexedDB. Register it under the
		// stable custom-voice ID so per-sentence requests reuse one entry.
		const name = voice ?? `upload-${voiceBlob.size}-${Date.now().toString(36)}`;
		if (model.voices.includes(name) || registeredVoices.has(name)) return name;
		await model.addVoice(name, voiceBlob);
		registeredVoices.add(name);
		return name;
	}
	if (!voice) return undefined;
	if (model.voices.includes(voice) || registeredVoices.has(voice)) return voice;
	const catalog = await listPhononVoices();
	const entry = catalog.find((v) => v.name === voice);
	if (!entry) throw new Error(`Phonon voice not found: ${voice}`);
	await model.addVoice(entry.name, entry.url);
	registeredVoices.add(entry.name);
	return entry.name;
}

/** Synthesize one sentence to an object URL, supporting seek/pause aborts. */
export async function fetchPhononWav(
	text: string,
	voiceId: string | null,
	voiceBlob: Blob | null,
	signal?: AbortSignal
): Promise<{ url: string }> {
	const model = await ensurePhononModel();
	const voice = await ensureVoice(model, voiceId, voiceBlob);
	const mod = await import('phonon-tts');
	const chunks: Float32Array[] = [];
	const stream = model.stream(text, { voice, signal });
	try {
		for await (const chunk of stream) chunks.push(chunk);
	} catch (error) {
		if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
		throw error;
	}
	const blob = mod.encodeWav(mod.concatPcm(chunks), model.sampleRate);
	return { url: URL.createObjectURL(blob) };
}
