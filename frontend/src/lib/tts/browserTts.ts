/** Browser pocket-tts engine — main-thread owner of the WASM worker.
 *
 * Lifecycle: `ensureReady()` downloads base models (cache-first, with
 * progress), spawns `static/vendor/sherpa/ocr-tts-worker.js`, transfers
 * the bytes, and awaits `tts-ready`. `ensureEncoder()` lazily adds voice
 * cloning by downloading `encoder.onnx` and re-initializing the instance.
 * `generate()` synthesizes one TTS chunk; callers schedule playback
 * (see the sentence player) and feed per-voice/engine ETA stats as usual.
 */

import {
	BASE_MODEL_FILES,
	ENCODER_FILE,
	areModelsCached,
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
	private hasEncoder = false;
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

	/** Download the cloning encoder and re-init (lazy; keeps base fast). */
	async ensureEncoder(onProgress?: (p: DownloadProgress) => void): Promise<void> {
		await this.ensureReady();
		if (this.hasEncoder) return;
		this.status = 'downloading';
		const data = await downloadModelFile(ENCODER_FILE.name, onProgress);
		this.modelBufs.set(ENCODER_FILE.name, data);
		this.status = 'initializing';
		await this.initInstance(true);
		this.hasEncoder = true;
		this.status = 'ready';
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
		await this.initInstance(false);
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

	private async initInstance(withEncoder: boolean): Promise<void> {
		const names = withEncoder
			? [...BASE_MODEL_FILES.map((f) => f.name), ENCODER_FILE.name]
			: BASE_MODEL_FILES.map((f) => f.name);
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
		// Buffers transfer (neuter) — re-fetch from cache if we init again.
		const transfers = files.map((f) => f.data);
		this.worker?.postMessage({ type: 'init', files, withEncoder }, transfers);
		this.modelBufs.clear();
		try {
			await done;
		} finally {
			// Re-cache bytes for future re-inits (worker neuters transfers).
			for (const f of [...BASE_MODEL_FILES.map((x) => x.name), ENCODER_FILE.name]) {
				const cached = await downloadModelFile(f).catch(() => null);
				if (cached) this.modelBufs.set(f, cached);
			}
		}
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
		this.hasEncoder = false;
		if (this.status === 'ready') this.status = 'idle';
	}
}
