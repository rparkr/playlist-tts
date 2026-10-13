/** Browser Kokoro engine — `kokoro-js` (onnx-community int8) behind a singleton.
 *
 * No vendoring: the npm package (transformers.js + onnxruntime WASM) lazy-loads
 * on first use, and model bytes come from Hugging Face with transformers.js's
 * own Cache API persistence. Two top-quality voices keep the picker and the
 * download minimal (~86MB model + 0.5MB/voice).
 */

export const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const KOKORO_SAMPLE_RATE = 24000;
/** Exact bytes of `onnx/model_q8f16.onnx` (progress denominator sanity). */
export const KOKORO_MODEL_BYTES = 86033585;

export interface KokoroVoice {
	/** kokoro-js voice id (`voices/<id>.bin`). */
	id: string;
	/** Picker label. */
	label: string;
}

/** The two top-grade Kokoro voices (female + male picks). */
export const KOKORO_VOICES: KokoroVoice[] = [
	{ id: 'af_heart', label: 'Heart (female)' },
	{ id: 'am_puck', label: 'Puck (male)' }
];

export const KOKORO_DEFAULT_VOICE = 'af_heart';

/** True for a usable browser-engine voice id. */
export function isKokoroVoice(id: string | null | undefined): boolean {
	return KOKORO_VOICES.some((v) => v.id === id);
}

export type KokoroStatus = 'idle' | 'downloading' | 'initializing' | 'ready' | 'error';

export interface KokoroProgress {
	loaded: number;
	total: number;
}

export interface KokoroAudio {
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

interface ProgressFileState {
	loaded: number;
	total: number;
}

/** Fold per-file transformers.js progress events into one overall bar. */
export class KokoroProgressTracker {
	private files = new Map<string, ProgressFileState>();

	update(file: string, loaded: number, total: number): KokoroProgress {
		this.files.set(file, { loaded, total });
		return this.overall();
	}

	overall(): KokoroProgress {
		let loaded = 0;
		let total = 0;
		for (const f of this.files.values()) {
			loaded += f.loaded;
			total += f.total;
		}
		return { loaded, total: Math.max(total, 1) };
	}
}

// Lazily imported so the page never pays for transformers.js until use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KokoroTTSType = any;

export class KokoroEngine {
	status: KokoroStatus = 'idle';
	error: string | null = null;

	private tts: KokoroTTSType | null = null;
	private readyPromise: Promise<void> | null = null;
	private tracker = new KokoroProgressTracker();

	/** Download (if needed) + initialize. Safe to call repeatedly. */
	ensureReady(onProgress?: (p: KokoroProgress) => void): Promise<void> {
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

	private async setup(onProgress?: (p: KokoroProgress) => void): Promise<void> {
		if (typeof window === 'undefined') throw new Error('Kokoro needs a browser.');
		this.status = 'downloading';
		this.error = null;
		this.tracker = new KokoroProgressTracker();
		const { KokoroTTS } = await import('kokoro-js');
		this.status = 'initializing';
		this.tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
			dtype: 'q8',
			device: 'wasm',
			progress_callback: (ev: {
				status: string;
				file?: string;
				progress?: number;
				loaded?: number;
				total?: number;
			}) => {
				if (ev.status === 'progress' && ev.file !== undefined) {
					onProgress?.(
						this.tracker.update(ev.file, ev.loaded ?? 0, ev.total ?? 0)
					);
				}
			}
		});
		this.status = 'ready';
	}

	/** Synthesize one chunk with a Kokoro voice (validated, defaults to Heart). */
	async generate(text: string, opts?: { voice?: string; speed?: number }): Promise<KokoroAudio> {
		if (!this.tts || this.status !== 'ready') {
			throw new Error('Kokoro is not ready');
		}
		const voice = isKokoroVoice(opts?.voice) ? (opts?.voice as string) : KOKORO_DEFAULT_VOICE;
		const audio = await this.tts.generate(text, { voice, speed: opts?.speed ?? 1.0 });
		const samples = audio.audio as Float32Array;
		return { samples: samples.slice(), sampleRate: audio.sampling_rate ?? KOKORO_SAMPLE_RATE };
	}

	dispose(): void {
		try {
			this.tts?.dispose?.();
		} catch {
			// ignore — dispose is best-effort
		}
		this.tts = null;
		if (this.status === 'ready') this.status = 'idle';
	}
}
