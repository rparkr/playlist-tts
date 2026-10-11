/** Browser pocket-tts engine — main-thread owner of the WASM worker.
 *
 * Lifecycle: `ensureReady()` downloads all 7 model files (cache-first,
 * with progress), spawns `static/vendor/sherpa/ocr-tts-worker.js`,
 * transfers the bytes, and awaits `tts-ready`. `generate()` synthesizes
 * one TTS chunk; callers schedule playback (see the sentence player) and
 * feed per-voice/engine ETA stats as usual.
 */

import {
	BASE_MODEL_FILES,
	downloadModelFile,
	totalBytes,
	type DownloadProgress
} from './browserModels';

export type BrowserTtsStatus = 'idle' | 'downloading' | 'initializing' | 'ready' | 'error';

export interface BrowserReferenceVoice {
	/** Mono float32 PCM at `sampleRate` (decoded clone/reference wav). */
	samples: Float32Array;
	sampleRate: number;
}

export interface BrowserAudio {
	samples: Float32Array;
	sampleRate: number;
}

/** Encode float32 mono PCM as a 16-bit WAV blob (player cache entries). */
export function encodeWavBlob(samples: Float32Array, sampleRate: number): Blob {
	const n = samples.length;
	const buf = new ArrayBuffer(44 + n * 2);
	const view = new DataView(buf);
	const writeAscii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};
	writeAscii(0, 'RIFF');
	view.setUint32(4, 36 + n * 2, true);
	writeAscii(8, 'WAVE');
	writeAscii(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	writeAscii(36, 'data');
	view.setUint32(40, n * 2, true);
	for (let i = 0; i < n; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(44 + i * 2, Math.round(s * 32767), true);
	}
	return new Blob([buf], { type: 'audio/wav' });
}

/** Map a backend `hf://repo/path` voice origin to a fetchable HTTPS URL. */
export function builtinVoiceWavUrl(origin: string): string | null {
	const prefix = 'hf://';
	if (!origin.startsWith(prefix)) return null;
	const parts = origin.slice(prefix.length).split('/');
	if (parts.length < 3) return null;
	const repo = `${parts[0]}/${parts[1]}`;
	return `https://huggingface.co/${repo}/resolve/main/${parts.slice(2).join('/')}`;
}

/** Decoded reference voices, cached per voice key (decode once per session). */
export const referenceVoiceCache = new Map<string, BrowserReferenceVoice>();

/** Decode (once) and cache the clone reference for `key`. */
export async function resolveReferenceVoice(
	key: string,
	load: () => Promise<Blob>
): Promise<BrowserReferenceVoice> {
	const hit = referenceVoiceCache.get(key);
	if (hit) return hit;
	const voice = await decodeReferenceVoice(await load());
	referenceVoiceCache.set(key, voice);
	return voice;
}

/** Downmix decoded WebAudio channels to mono float32 (clone input). */
export function monoSamples(channels: Float32Array[]): Float32Array {
	if (channels.length === 0) return new Float32Array(0);
	if (channels.length === 1) return channels[0].slice();
	const len = channels[0].length;
	const out = new Float32Array(len);
	for (const ch of channels) {
		const n = Math.min(len, ch.length);
		for (let i = 0; i < n; i++) out[i] += ch[i];
	}
	const inv = 1 / channels.length;
	for (let i = 0; i < len; i++) out[i] *= inv;
	return out;
}

/** Decode a wav/mp3 blob to a mono reference voice via WebAudio. */
export async function decodeReferenceVoice(blob: Blob): Promise<BrowserReferenceVoice> {
	const Ctx: typeof AudioContext | undefined =
		typeof window !== 'undefined'
			? (window.AudioContext ??
				(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
			: undefined;
	if (!Ctx) throw new Error('WebAudio is unavailable in this browser.');
	const data = await blob.arrayBuffer();
	const ctx = new Ctx();
	try {
		const decoded = await ctx.decodeAudioData(data);
		const channels: Float32Array[] = [];
		for (let c = 0; c < decoded.numberOfChannels; c++) {
			channels.push(new Float32Array(decoded.getChannelData(c)));
		}
		return { samples: monoSamples(channels), sampleRate: decoded.sampleRate };
	} finally {
		void ctx.close().catch(() => {});
	}
}

interface PendingGenerate {
	resolve: (audio: BrowserAudio) => void;
	reject: (err: Error) => void;
	onProgress?: (progress: number) => void;
}

let nextGenerateId = 1;

export class BrowserTtsEngine {
	status: BrowserTtsStatus = 'idle';
	error: string | null = null;
	sampleRate: number | null = null;

	private worker: Worker | null = null;
	private pending = new Map<number, PendingGenerate>();
	private readyPromise: Promise<void> | null = null;
	private runtimeReadyResolve: (() => void) | null = null;
	private modelBufs = new Map<string, ArrayBuffer>();

	/** Download (if needed) + initialize. Safe to call repeatedly. */
	ensureReady(onProgress?: (p: DownloadProgress) => void): Promise<void> {
		if (this.status === 'ready') return Promise.resolve();
		if (this.readyPromise) return this.readyPromise;
		this.readyPromise = this.setup(onProgress).catch((e: unknown) => {
			this.status = 'error';
			this.error = (e as Error)?.message ?? String(e);
			this.readyPromise = null;
			throw e;
		});
		return this.readyPromise;
	}

	private async setup(onProgress?: (p: DownloadProgress) => void): Promise<void> {
		this.status = 'downloading';
		this.error = null;
		const expected = totalBytes(BASE_MODEL_FILES);
		let loaded = 0;
		for (const f of BASE_MODEL_FILES) {
			const buf = await downloadModelFile(f.name, (p) => {
				onProgress?.({ loaded: loaded + p.loaded, total: expected });
			});
			loaded += buf.byteLength;
			this.modelBufs.set(f.name, buf);
		}
		onProgress?.({ loaded: expected, total: expected });
		this.status = 'initializing';
		this.spawnWorker();
		await this.waitForRuntime();
		await this.initInstance();
		this.status = 'ready';
	}

	private spawnWorker(): void {
		this.terminate();
		this.worker = new Worker('/vendor/sherpa/ocr-tts-worker.js');
		this.worker.onmessage = (e: MessageEvent) => this.handleMessage(e.data);
		this.worker.onerror = (e: ErrorEvent) => {
			this.status = 'error';
			this.error = e.message || 'TTS worker failed';
		};
	}

	private waitForRuntime(): Promise<void> {
		return new Promise((resolve) => {
			this.runtimeReadyResolve = resolve;
		});
	}

	private async initInstance(): Promise<void> {
		const names = BASE_MODEL_FILES.map((f) => f.name);
		const files: { name: string; data: ArrayBuffer }[] = [];
		for (const name of names) {
			const buf = this.modelBufs.get(name);
			if (!buf) throw new Error(`Missing model bytes: ${name}`);
			files.push({ name, data: buf });
		}
		const done = new Promise<void>((resolve, reject) => {
			this.initResolve = resolve;
			this.initReject = reject;
		});
		// Buffers transfer (neuter) — the worker owns them after this.
		const transfers = files.map((f) => f.data);
		this.worker?.postMessage({ type: 'init', files, withEncoder: true }, transfers);
		this.modelBufs.clear();
		await done;
	}

	private initResolve: (() => void) | null = null;
	private initReject: ((e: Error) => void) | null = null;

	private handleMessage(msg: {
		type: string;
		id?: number;
		message?: string;
		sampleRate?: number;
		samples?: Float32Array;
		progress?: number;
		status?: string;
	}): void {
		switch (msg.type) {
			case 'runtime-ready':
				this.runtimeReadyResolve?.();
				this.runtimeReadyResolve = null;
				break;
			case 'tts-ready':
				this.sampleRate = msg.sampleRate ?? null;
				this.initResolve?.();
				this.initResolve = this.initReject = null;
				break;
			case 'progress': {
				const pending = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
				pending?.onProgress?.(msg.progress ?? 0);
				break;
			}
			case 'result': {
				const pending = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
				if (pending && msg.samples && msg.sampleRate && msg.id !== undefined) {
					this.pending.delete(msg.id);
					pending.resolve({ samples: msg.samples, sampleRate: msg.sampleRate });
				}
				break;
			}
			case 'error': {
				const err = new Error(msg.message ?? 'Browser TTS failed');
				if (msg.id !== undefined && msg.id !== null) {
					const pending = this.pending.get(msg.id);
					if (pending) {
						this.pending.delete(msg.id);
						pending.reject(err);
						break;
					}
				}
				this.initReject?.(err);
				this.initResolve = this.initReject = null;
				this.status = 'error';
				this.error = err.message;
				break;
			}
		}
	}

	/** Synthesize one chunk. `reference` selects cloning (needs encoder). */
	generate(
		text: string,
		opts?: { speed?: number; reference?: BrowserReferenceVoice; onProgress?: (p: number) => void }
	): Promise<BrowserAudio> {
		if (!this.worker || this.status !== 'ready') {
			return Promise.reject(new Error('Browser TTS is not ready'));
		}
		const id = nextGenerateId++;
		return new Promise<BrowserAudio>((resolve, reject) => {
			this.pending.set(id, { resolve, reject, onProgress: opts?.onProgress });
			const transfers: ArrayBuffer[] = [];
			let reference: { samples: ArrayBuffer; sampleRate: number } | null = null;
			if (opts?.reference) {
				const copy = opts.reference.samples.slice().buffer as ArrayBuffer;
				transfers.push(copy);
				reference = { samples: copy, sampleRate: opts.reference.sampleRate };
			}
			this.worker?.postMessage(
				{ type: 'generate', id, text, speed: opts?.speed ?? 1.0, reference },
				transfers
			);
		});
	}

	cancel(id: number): void {
		this.worker?.postMessage({ type: 'cancel', id });
		this.pending.get(id)?.reject(new Error('cancelled'));
		this.pending.delete(id);
	}

	terminate(): void {
		for (const [, p] of this.pending) p.reject(new Error('TTS engine stopped'));
		this.pending.clear();
		this.worker?.terminate();
		this.worker = null;
		if (this.status === 'ready') this.status = 'idle';
	}
}
