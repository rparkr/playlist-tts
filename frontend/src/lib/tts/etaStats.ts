/** Per-voice/engine TTS pace stats — refines playback ETA over time.
 *
 * Each completed `BackendSentencePlayer` sentence records its character count
 * and sounding duration normalized to 1.0x speech rate. Totals accumulate in
 * `localStorage` (keyed `voice + engine`), so estimates converge across
 * sessions: `remaining = remainingChars / charsPerSecond / rate`. With no
 * samples yet, estimates fall back to a cold-start pace of ~150wpm.
 */

export type TtsEngineKey = 'device' | 'pocket' | 'browser';

/** Cold-start pace (~150wpm at ~6 chars/word including spaces). */
export const COLD_START_CPS = 15;

const STORAGE_KEY = 'tts_eta_stats_v1';

/** Halve accumulated totals past this many chars (bounds growth, adapts to drift). */
export const STATS_CHAR_CAP = 500_000;

interface PaceTotals {
	chars: number;
	seconds: number;
}

/** Minimal storage surface — injectable so unit tests avoid `localStorage`. */
export interface StatsStore {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

function defaultStore(): StatsStore | null {
	try {
		if (typeof localStorage !== 'undefined') return localStorage;
	} catch {
		// ignore — private-mode access can throw on read
	}
	return null;
}

function statsKey(voice: string, engine: TtsEngineKey): string {
	return `${engine}:${voice}`;
}

function readAll(store: StatsStore | null): Record<string, PaceTotals> {
	if (!store) return {};
	try {
		const raw = store.getItem(STORAGE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const out: Record<string, PaceTotals> = {};
		for (const [k, v] of Object.entries(parsed)) {
			if (
				v !== null &&
				typeof v === 'object' &&
				Number.isFinite((v as PaceTotals).chars) &&
				Number.isFinite((v as PaceTotals).seconds)
			) {
				const chars = (v as PaceTotals).chars;
				const seconds = (v as PaceTotals).seconds;
				if (chars > 0 && seconds > 0) out[k] = { chars, seconds };
			}
		}
		return out;
	} catch {
		return {};
	}
}

/** Record one sounded sentence. `secondsAt1x` is wall duration / speech rate. */
export function recordEtaSample(
	voice: string,
	engine: TtsEngineKey,
	chars: number,
	secondsAt1x: number,
	store: StatsStore | null = defaultStore()
): void {
	if (!store || !voice) return;
	if (!Number.isFinite(chars) || !Number.isFinite(secondsAt1x)) return;
	if (chars <= 0 || secondsAt1x <= 0) return;
	const all = readAll(store);
	const key = statsKey(voice, engine);
	const prev = all[key] ?? { chars: 0, seconds: 0 };
	let next = { chars: prev.chars + chars, seconds: prev.seconds + secondsAt1x };
	if (next.chars > STATS_CHAR_CAP) {
		next = { chars: next.chars / 2, seconds: next.seconds / 2 };
	}
	all[key] = next;
	try {
		store.setItem(STORAGE_KEY, JSON.stringify(all));
	} catch {
		// persistence is best-effort (quota, private mode)
	}
}

/** Measured chars/second for a voice+engine, or null before any sample. */
export function getCharsPerSecond(
	voice: string,
	engine: TtsEngineKey,
	store: StatsStore | null = defaultStore()
): number | null {
	const totals = readAll(store)[statsKey(voice, engine)];
	if (!totals || totals.seconds <= 0) return null;
	return totals.chars / totals.seconds;
}

/** Estimated seconds to sound `remainingChars` at `rate`, cold-starting at ~150wpm. */
export function estimateRemainingSeconds(
	remainingChars: number,
	voice: string,
	engine: TtsEngineKey,
	rate: number,
	store: StatsStore | null = defaultStore()
): number {
	const cps = getCharsPerSecond(voice, engine, store) ?? COLD_START_CPS;
	const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
	return Math.max(0, remainingChars) / cps / safeRate;
}
