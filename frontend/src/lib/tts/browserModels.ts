/** Browser pocket-tts model management — manifest, download, cache.
 *
 * The sherpa-onnx WASM runtime (`static/vendor/sherpa/`) reads model files
 * from its MEMFS working dir. This module owns *which* files, *where* they
 * come from, and *where* they persist: downloads stream from Hugging Face
 * with progress, then land in Cache Storage so repeat visits stay offline.
 *
 * Base playback needs 6 files (~125MB). The voice-cloning encoder
 * (`encoder.onnx`, ~73MB) downloads lazily on first clone.
 */

export interface BrowserModelFile {
	/** MEMFS filename the WASM module expects (e.g. `lm_main.int8.onnx`). */
	name: string;
	/** Exact byte size, for progress totals and integrity checks. */
	bytes: number;
	/** True for the cloning encoder (lazy, not part of base setup). */
	lazy?: boolean;
}

/** Pinned model repo + revision (stable download URLs). */
export const BROWSER_TTS_REPO = 'csukuangfj2/sherpa-onnx-pocket-tts-int8-2026-01-26';
export const BROWSER_TTS_REVISION = 'e715955cf50d18d919d37231513c0e914b83661a';

export const BASE_MODEL_FILES: BrowserModelFile[] = [
	{ name: 'lm_main.int8.onnx', bytes: 76341079 },
	{ name: 'decoder.int8.onnx', bytes: 22693618 },
	{ name: 'text_conditioner.onnx', bytes: 16388343 },
	{ name: 'lm_flow.int8.onnx', bytes: 9962530 },
	{ name: 'vocab.json', bytes: 69478 },
	{ name: 'token_scores.json', bytes: 123616 }
];

export const ENCODER_FILE: BrowserModelFile = {
	name: 'encoder.onnx',
	bytes: 72713165,
	lazy: true
};

export const ALL_MODEL_FILES: BrowserModelFile[] = [...BASE_MODEL_FILES, ENCODER_FILE];

export const BROWSER_TTS_CACHE = 'ocr-tts-browser-tts-v1';

/** Download URL for one model file (pinned revision). */
export function modelFileUrl(name: string): string {
	return `https://huggingface.co/${BROWSER_TTS_REPO}/resolve/${BROWSER_TTS_REVISION}/${name}`;
}

/** Sum of expected bytes (download progress denominator). */
export function totalBytes(files: readonly BrowserModelFile[]): number {
	return files.reduce((sum, f) => sum + f.bytes, 0);
}

/** Human size for the download UI (`125.3 MB`). */
export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function cacheAvailable(): boolean {
	return typeof caches !== 'undefined';
}

/** Cached bytes for a model file, or null on miss/unavailable. */
export async function getCachedModel(name: string): Promise<ArrayBuffer | null> {
	if (!cacheAvailable()) return null;
	try {
		const cache = await caches.open(BROWSER_TTS_CACHE);
		const resp = await cache.match(modelFileUrl(name));
		if (!resp) return null;
		const buf = await resp.arrayBuffer();
		// Drop truncated entries (interrupted first download).
		const expected = ALL_MODEL_FILES.find((f) => f.name === name)?.bytes;
		if (expected !== undefined && buf.byteLength !== expected) {
			await cache.delete(modelFileUrl(name));
			return null;
		}
		return buf;
	} catch {
		return null;
	}
}

async function putCachedModel(name: string, data: ArrayBuffer): Promise<void> {
	if (!cacheAvailable()) return;
	try {
		const cache = await caches.open(BROWSER_TTS_CACHE);
		await cache.put(
			modelFileUrl(name),
			new Response(data, { headers: { 'Content-Length': String(data.byteLength) } })
		);
	} catch {
		// Private mode / quota — synthesis still works this session.
	}
}

export interface DownloadProgress {
	loaded: number;
	total: number;
}

/** Fetch one model file (cache-first), streaming progress. Returns bytes. */
export async function downloadModelFile(
	name: string,
	onProgress?: (p: DownloadProgress) => void
): Promise<ArrayBuffer> {
	const cached = await getCachedModel(name);
	if (cached) {
		onProgress?.({ loaded: cached.byteLength, total: cached.byteLength });
		return cached;
	}
	const expected = ALL_MODEL_FILES.find((f) => f.name === name)?.bytes ?? 0;
	const resp = await fetch(modelFileUrl(name));
	if (!resp.ok || !resp.body) throw new Error(`Model download failed: ${name} (HTTP ${resp.status})`);
	const reader = resp.body.getReader();
	const chunks: Uint8Array[] = [];
	let loaded = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			chunks.push(value);
			loaded += value.length;
			onProgress?.({ loaded, total: expected });
		}
	}
	const merged = new Uint8Array(loaded);
	let offset = 0;
	for (const c of chunks) {
		merged.set(c, offset);
		offset += c.length;
	}
	const buf = merged.buffer as ArrayBuffer;
	if (expected > 0 && buf.byteLength !== expected) {
		throw new Error(`Model download truncated: ${name} (${formatBytes(buf.byteLength)} of ${formatBytes(expected)})`);
	}
	await putCachedModel(name, buf);
	return buf;
}

/** True when every listed file is cached (unlock playback / cloning). */
export async function areModelsCached(files: readonly BrowserModelFile[]): Promise<boolean> {
	for (const f of files) {
		if ((await getCachedModel(f.name)) === null) return false;
	}
	return true;
}
