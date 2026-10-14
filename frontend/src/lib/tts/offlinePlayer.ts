/** Offline single-track player — one pre-generated chapter file as one media item.
 *
 * Unlike `BackendSentencePlayer` (one fetch + blob per sentence), this wraps
 * a single `<audio>` element around a whole-chapter file, so lock-screen and
 * offline playback never needs JS fetching between sentences. Sentence
 * highlight keeps roughly following via character-fraction mapping: sentence
 * `idx` starts at `charsBefore(idx) / totalChars` of the duration.
 */

export interface OfflinePlayerCallbacks {
	/** Fired (throttled by the element) as playback crosses sentences. */
	onTimeIndex?: (idx: number) => void;
	/** Fired when the file plays to completion. */
	onEnded?: () => void;
	onError?: (message: string) => void;
}

/** Cumulative end-char offsets: `ends[i]` is the char count through sentence `i`. */
export function cumulativeEnds(lengths: number[]): number[] {
	const out: number[] = [];
	let acc = 0;
	for (const n of lengths) {
		acc += Math.max(0, n);
		out.push(acc);
	}
	return out;
}

/** Start-time fraction (0–1) for sentence `idx` given cumulative ends + total. */
export function fractionForIndex(idx: number, ends: number[], total: number): number {
	if (total <= 0 || ends.length === 0) return 0;
	const at = Math.max(0, Math.min(idx, ends.length - 1));
	const before = at <= 0 ? 0 : ends[at - 1];
	return Math.max(0, Math.min(1, before / total));
}

/** Sentence index for a playback fraction (0–1): first sentence ending past it. */
export function indexForFraction(fraction: number, ends: number[], total: number): number {
	if (ends.length === 0) return 0;
	const f = Math.max(0, Math.min(1, fraction));
	const target = f * Math.max(0, total);
	for (let i = 0; i < ends.length; i++) {
		if (ends[i] > target) return i;
	}
	return ends.length - 1;
}

export class OfflinePlayer {
	private audio: HTMLAudioElement | null = null;
	private url: string | null = null;
	private ends: number[] = [];
	private total = 0;
	private lastIdx = -1;
	private running = false;
	private pendingFraction: number | null = null;
	private cb: OfflinePlayerCallbacks = {};
	private onMeta = () => this.applyPendingFraction();
	private onTime = () => this.emitTimeIndex();
	private onEnd = () => {
		this.running = false;
		this.cb.onEnded?.();
	};

	setCallbacks(cb: OfflinePlayerCallbacks): void {
		this.cb = cb;
	}

	get isRunning(): boolean {
		return this.running;
	}

	private ensureAudio(): HTMLAudioElement {
		if (!this.audio) {
			this.audio = new Audio();
			this.audio.preload = 'auto';
			this.audio.addEventListener('loadedmetadata', this.onMeta);
			this.audio.addEventListener('timeupdate', this.onTime);
			this.audio.addEventListener('ended', this.onEnd);
		}
		return this.audio;
	}

	/** Load a chapter file; `lengths` are per-sentence char counts for mapping. */
	load(blob: Blob, lengths: number[]): void {
		const audio = this.ensureAudio();
		this.unloadUrl();
		this.ends = cumulativeEnds(lengths);
		this.total = this.ends.length > 0 ? this.ends[this.ends.length - 1] : 0;
		this.lastIdx = -1;
		this.pendingFraction = null;
		this.url = URL.createObjectURL(blob);
		audio.src = this.url;
		audio.load();
	}

	setRate(rate: number): void {
		if (this.audio) this.audio.playbackRate = rate;
	}

	/** Play from the start of sentence `idx` (fraction of duration). */
	async playFromIndex(idx: number, rate: number): Promise<void> {
		const audio = this.ensureAudio();
		if (!this.url) {
			this.cb.onError?.('No offline audio loaded');
			return;
		}
		audio.playbackRate = rate;
		const fraction = fractionForIndex(idx, this.ends, this.total);
		if (Number.isFinite(audio.duration) && audio.duration > 0) {
			try {
				audio.currentTime = fraction * audio.duration;
			} catch {
				// ignore — some containers reject seeks before metadata
			}
		} else {
			this.pendingFraction = fraction;
		}
		this.running = true;
		try {
			await audio.play();
		} catch (e) {
			this.running = false;
			this.cb.onError?.(e instanceof Error ? e.message : String(e));
		}
	}

	/** Seek within a playing file; no-op when nothing is loaded. */
	seek(idx: number): void {
		const audio = this.audio;
		if (!audio || !this.url) return;
		const fraction = fractionForIndex(idx, this.ends, this.total);
		if (Number.isFinite(audio.duration) && audio.duration > 0) {
			try {
				audio.currentTime = fraction * audio.duration;
			} catch {
				// ignore
			}
		} else {
			this.pendingFraction = fraction;
		}
		this.lastIdx = -1;
		this.emitTimeIndex();
	}

	pause(): void {
		this.running = false;
		this.audio?.pause();
	}

	/** Full teardown — revokes the object URL. */
	unload(): void {
		this.running = false;
		this.audio?.pause();
		this.unloadUrl();
		this.ends = [];
		this.total = 0;
		this.lastIdx = -1;
		this.pendingFraction = null;
	}

	destroy(): void {
		if (this.audio) {
			this.audio.removeEventListener('loadedmetadata', this.onMeta);
			this.audio.removeEventListener('timeupdate', this.onTime);
			this.audio.removeEventListener('ended', this.onEnd);
		}
		this.unload();
		if (this.audio) {
			this.audio.removeAttribute('src');
			this.audio.load();
		}
		this.audio = null;
	}

	private unloadUrl(): void {
		if (this.url) {
			URL.revokeObjectURL(this.url);
			this.url = null;
		}
	}

	private applyPendingFraction(): void {
		const audio = this.audio;
		if (!audio || this.pendingFraction === null) return;
		if (Number.isFinite(audio.duration) && audio.duration > 0) {
			try {
				audio.currentTime = this.pendingFraction * audio.duration;
			} catch {
				// ignore
			}
		}
		this.pendingFraction = null;
	}

	private emitTimeIndex(): void {
		const audio = this.audio;
		if (!audio || !this.running) return;
		if (!Number.isFinite(audio.duration) || audio.duration <= 0 || this.total <= 0) return;
		const idx = indexForFraction(audio.currentTime / audio.duration, this.ends, this.total);
		if (idx !== this.lastIdx) {
			this.lastIdx = idx;
			this.cb.onTimeIndex?.(idx);
		}
	}
}
