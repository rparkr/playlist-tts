/** Sentence-level backend TTS player — drives pocket-tts from the front-end.
 *
 * Instead of sending the whole remaining document in one request (which makes
 * the first audio arrive only after the entire document is synthesized), this
 * player requests one sentence at a time and prefetches the next while the
 * current one plays. That gives sub-second first audio, keeps the Markdown
 * highlight in sync via `onSentenceStart`, and makes pause/resume/seek cheap:
 * pause keeps the cache, seek aborts in-flight requests and starts at the new
 * sentence without re-processing anything before it.
 */

import { fetchTTSWavStream } from './backendStream';

export interface SentencePlayerCallbacks {
	/** Fired when a sentence starts sounding — use to sync the highlight. */
	onSentenceStart?: (idx: number) => void;
	/** Fired when playback runs past the last sentence. */
	onEnded?: () => void;
	onError?: (message: string) => void;
	onLoadingChange?: (loading: boolean) => void;
}

const MAX_CACHE_ENTRIES = 100;

/** Short hash so cache keys stay small but text edits invalidate entries. */
function hashText(text: string): string {
	let h = 5381;
	for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36);
}

export class BackendSentencePlayer {
	private audio: HTMLAudioElement | null = null;
	private cache = new Map<string, string>();
	private pending = new Map<string, Promise<string>>();
	private chainAbort: AbortController | null = null;
	private generation = 0;
	private sentences: string[] = [];
	private idx = 0;
	private voiceKey = '';
	private voiceId: string | null = null;
	private voiceBlob: Blob | null = null;
	private rate = 1.0;
	private running = false;
	private paused = false;
	private loading = false;
	private cb: SentencePlayerCallbacks = {};

	/** Snapshot of playback state for the UI. */
	get currentIndex(): number {
		return this.idx;
	}

	get isRunning(): boolean {
		return this.running;
	}

	/** True when paused with a position worth resuming from. */
	canResume(): boolean {
		return this.paused && this.sentences.length > 0;
	}

	setCallbacks(cb: SentencePlayerCallbacks): void {
		this.cb = cb;
	}

	setRate(rate: number): void {
		this.rate = rate;
		if (this.audio) this.audio.playbackRate = rate;
	}

	private ensureAudio(): HTMLAudioElement {
		if (!this.audio) this.audio = new Audio();
		this.audio.playbackRate = this.rate;
		return this.audio;
	}

	private cacheKey(idx: number): string {
		return `${this.voiceKey}::${idx}::${hashText(this.sentences[idx] ?? '')}`;
	}

	private setLoading(loading: boolean): void {
		if (this.loading === loading) return;
		this.loading = loading;
		this.cb.onLoadingChange?.(loading);
	}

	/** Fetch (or reuse) the object URL for sentence `idx`. Dedupes in-flight. */
	private getAudio(idx: number, signal: AbortSignal): Promise<string> {
		const key = this.cacheKey(idx);
		const cached = this.cache.get(key);
		if (cached) return Promise.resolve(cached);
		const inFlight = this.pending.get(key);
		if (inFlight) return inFlight;
		const text = this.sentences[idx] ?? '';
		const voiceId = this.voiceId;
		const voiceBlob = this.voiceBlob;
		const promise = fetchTTSWavStream(text, voiceId, voiceBlob, signal)
			.then(({ url }) => {
				// Cache the newest entry; evict oldest past the cap.
				this.cache.delete(key);
				this.cache.set(key, url);
				while (this.cache.size > MAX_CACHE_ENTRIES) {
					const oldest = this.cache.keys().next().value;
					if (oldest === undefined) break;
					URL.revokeObjectURL(this.cache.get(oldest)!);
					this.cache.delete(oldest);
				}
				return url;
			})
			.finally(() => {
				if (this.pending.get(key) === promise) this.pending.delete(key);
			});
		this.pending.set(key, promise);
		return promise;
	}

	/** Fire-and-forget fetch for an upcoming sentence (never toggles loading). */
	private prefetch(idx: number): void {
		if (idx < 0 || idx >= this.sentences.length) return;
		const text = this.sentences[idx] ?? '';
		if (!text.trim()) return;
		const signal = this.chainAbort?.signal;
		if (!signal || signal.aborted) return;
		this.getAudio(idx, signal).catch(() => {});
	}

	/** Start (or restart) playback at `startIdx`. Aborts any previous chain. */
	async play(
		sentences: string[],
		startIdx: number,
		voiceKey: string,
		voiceId: string | null,
		voiceBlob: Blob | null,
		rate: number
	): Promise<void> {
		this.stopChain();
		this.sentences = sentences;
		this.idx = Math.max(0, Math.min(startIdx, sentences.length - 1));
		this.voiceKey = voiceKey;
		this.voiceId = voiceId;
		this.voiceBlob = voiceBlob;
		this.rate = rate;
		this.running = true;
		this.paused = false;
		const gen = ++this.generation;
		this.chainAbort = new AbortController();
		await this.runChain(gen);
	}

	/** Pause: stop audio, abort in-flight fetches, but keep cache + position. */
	pause(): void {
		this.paused = true;
		this.running = false;
		this.generation++;
		this.chainAbort?.abort();
		this.chainAbort = null;
		this.audio?.pause();
		this.setLoading(false);
	}

	/** Resume after `pause()` from the same sentence (cached audio reused). */
	async resume(): Promise<void> {
		if (this.running || !this.paused) return;
		if (this.sentences.length === 0) return;
		// If the audio element is parked mid-sentence *for the current index*,
		// just continue it. The src check matters: a seek issued while paused
		// parks a new index but leaves the old resource behind, and replaying
		// that would sound the previous sentence while skipping the selected
		// one. Anything stale falls through to the chain restart below.
		const audio = this.audio;
		const expected = this.cache.get(this.cacheKey(this.idx));
		if (
			audio &&
			audio.src &&
			expected !== undefined &&
			audio.src === expected &&
			!audio.ended &&
			audio.currentTime > 0
		) {
			this.running = true;
			this.paused = false;
			const gen = ++this.generation;
			this.chainAbort = new AbortController();
			this.prefetch(this.idx + 1);
			try {
				await audio.play();
			} catch (e) {
				this.running = false;
				this.cb.onError?.(e instanceof Error ? e.message : String(e));
				return;
			}
			await this.waitForCurrentAudioEnd(gen);
			if (gen !== this.generation || !this.running) return;
			this.idx++;
			await this.runChain(gen);
			return;
		}
		// Otherwise (paused while fetching, or audio finished) restart the chain
		// at the current sentence — cache makes this instant when available.
		this.running = true;
		this.paused = false;
		const gen = ++this.generation;
		this.chainAbort = new AbortController();
		await this.runChain(gen);
	}

	/** Seek to `idx`. When running, playback continues from there immediately. */
	async seek(idx: number): Promise<void> {
		if (this.sentences.length === 0) return;
		this.idx = Math.max(0, Math.min(idx, this.sentences.length - 1));
		// Tear down whatever the element holds *now*: when paused this drops
		// the stale parked sentence so a later resume() cannot replay it
		// instead of the newly selected one; when running the chain below
		// attaches the new resource once its fetch completes. Cached audio is
		// kept, so revisits still start instantly.
		this.resetElement();
		if (!this.running) return;
		const wasRate = this.rate;
		const voiceKey = this.voiceKey;
		const voiceId = this.voiceId;
		const voiceBlob = this.voiceBlob;
		const sentences = this.sentences;
		this.stopChain();
		this.sentences = sentences;
		this.voiceKey = voiceKey;
		this.voiceId = voiceId;
		this.voiceBlob = voiceBlob;
		this.rate = wasRate;
		this.running = true;
		this.paused = false;
		const gen = ++this.generation;
		this.chainAbort = new AbortController();
		await this.runChain(gen);
	}

	/** Replace the sentence snapshot (e.g. after Markdown edits).
	 *
	 * Keeps the position clamped into the new array. A running chain picks the
	 * new text up from the next sentence (the current one already fetched);
	 * a paused player resumes from the clamped position, so deleted sentences
	 * can never sound. Ignored while pristine so unrelated recomputes cannot
	 * arm a resume.
	 */
	updateSentences(sentences: string[]): void {
		if (this.sentences.length === 0 && !this.running && !this.paused) return;
		this.sentences = sentences;
		if (this.sentences.length === 0) {
			this.idx = 0;
			return;
		}
		this.idx = Math.max(0, Math.min(this.idx, this.sentences.length - 1));
	}

	/** Full stop — use when switching documents or engines. */
	stop(): void {
		this.stopChain();
		this.sentences = [];
		this.paused = false;
		this.audio?.pause();
		if (this.audio) {
			this.audio.removeAttribute('src');
			this.audio.load();
		}
	}

	/** Drop cached audio (call when the voice changes). */
	clearCache(): void {
		for (const url of this.cache.values()) URL.revokeObjectURL(url);
		this.cache.clear();
	}

	destroy(): void {
		this.stop();
		this.clearCache();
		this.audio = null;
	}

	private stopChain(): void {
		this.running = false;
		this.generation++;
		this.chainAbort?.abort();
		this.chainAbort = null;
		this.audio?.pause();
		this.setLoading(false);
	}

	/** Tear down the element's current resource so stale audio can never resume. */
	private resetElement(): void {
		const audio = this.audio;
		if (!audio) return;
		audio.pause();
		audio.removeAttribute('src');
		audio.load();
	}

	private waitForCurrentAudioEnd(gen: number): Promise<void> {
		const audio = this.audio;
		if (!audio) return Promise.resolve();
		if (audio.ended) return Promise.resolve();
		return new Promise((resolve) => {
			const cleanup = () => {
				globalThis.clearInterval(checker);
				audio.removeEventListener('ended', wrappedEnd);
				audio.removeEventListener('error', wrappedError);
			};
			function wrappedEnd(): void {
				cleanup();
				resolve();
			}
			function wrappedError(): void {
				cleanup();
				resolve();
			}
			// If the chain was invalidated while waiting, resolve so the old
			// chain exits instead of hanging forever.
			// NOTE: globalThis (not window) so this also runs under node/vitest.
			const checker = globalThis.setInterval(() => {
				if (gen !== this.generation || !this.running) {
					cleanup();
					resolve();
				}
			}, 250);
			audio.addEventListener('ended', wrappedEnd, { once: true });
			audio.addEventListener('error', wrappedError, { once: true });
		});
	}

	private async runChain(gen: number): Promise<void> {
		const audio = this.ensureAudio();
		while (this.running && gen === this.generation) {
			if (this.idx >= this.sentences.length) {
				this.running = false;
				this.paused = false;
				this.setLoading(false);
				this.cb.onEnded?.();
				return;
			}
			// Capture the target locally: `this.idx` may be re-parked by a
			// concurrent seek, and only the current generation may play.
			const target = this.idx;
			const text = this.sentences[target] ?? '';
			if (!text.trim()) {
				this.idx = target + 1;
				continue;
			}
			const signal = this.chainAbort?.signal;
			if (!signal || signal.aborted) return;
			const key = this.cacheKey(target);
			const isCached = this.cache.has(key) || this.pending.has(key);
			if (!isCached) this.setLoading(true);
			let url: string;
			try {
				url = await this.getAudio(target, signal);
			} catch (e) {
				if (gen !== this.generation || !this.running) return;
				if (e instanceof DOMException && e.name === 'AbortError') return;
				this.running = false;
				this.setLoading(false);
				this.cb.onError?.(e instanceof Error ? e.message : String(e));
				return;
			}
			if (gen !== this.generation || !this.running) return;
			this.cb.onSentenceStart?.(target);
			// Prefetch the next sentence as the current one begins, so it is
			// ready (or nearly) when the current one ends.
			this.prefetch(target + 1);
			// Deterministic track switch: pause, attach the new resource from
			// position 0, then play. Relying on bare `src` assignment leaves
			// the start position up to the browser, which can replay the tail
			// of (or skip) the selected sentence on some engines.
			audio.pause();
			if (audio.src !== url) {
				audio.src = url;
				audio.load();
			}
			audio.currentTime = 0;
			audio.playbackRate = this.rate;
			this.setLoading(false);
			try {
				await audio.play();
			} catch (e) {
				if (gen !== this.generation || !this.running) return;
				this.running = false;
				this.cb.onError?.(e instanceof Error ? e.message : String(e));
				return;
			}
			await this.waitForCurrentAudioEnd(gen);
			if (gen !== this.generation || !this.running) return;
			this.idx = target + 1;
		}
	}
}
