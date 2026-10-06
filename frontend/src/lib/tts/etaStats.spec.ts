import { describe, it, expect } from 'vitest';
import {
	COLD_START_CPS,
	STATS_CHAR_CAP,
	estimateRemainingSeconds,
	getCharsPerSecond,
	recordEtaSample,
	type StatsStore
} from './etaStats';

/** In-memory store stand-in (vitest runs without `localStorage`). */
function fakeStore(seed?: string): StatsStore & { data: Record<string, string> } {
	const data: Record<string, string> = {};
	if (seed !== undefined) data['tts_eta_stats_v1'] = seed;
	return {
		data,
		getItem: (k: string) => data[k] ?? null,
		setItem: (k: string, v: string) => {
			data[k] = v;
		}
	};
}

describe('etaStats', () => {
	it('cold-starts at ~150wpm with no samples', () => {
		const store = fakeStore();
		expect(getCharsPerSecond('alba', 'pocket', store)).toBeNull();
		// 1500 chars at 15cps and 1.0x → 100s.
		expect(estimateRemainingSeconds(1500, 'alba', 'pocket', 1.0, store)).toBe(100);
		expect(COLD_START_CPS).toBe(15);
	});

	it('converges to measured pace and persists across sessions', () => {
		const store = fakeStore();
		recordEtaSample('alba', 'pocket', 300, 10, store); // 30cps
		expect(getCharsPerSecond('alba', 'pocket', store)).toBe(30);
		// A "fresh session" reading the same storage sees the converged pace.
		const again = fakeStore(store.data['tts_eta_stats_v1']);
		expect(getCharsPerSecond('alba', 'pocket', again)).toBe(30);
		expect(estimateRemainingSeconds(300, 'alba', 'pocket', 1.0, again)).toBe(10);
		// Second sample averages in: (300+300)/(10+30) = 15cps.
		recordEtaSample('alba', 'pocket', 300, 30, store);
		expect(getCharsPerSecond('alba', 'pocket', store)).toBe(15);
	});

	it('keys stats by voice and engine separately', () => {
		const store = fakeStore();
		recordEtaSample('alba', 'pocket', 300, 10, store);
		recordEtaSample('alba', 'device', 100, 10, store);
		recordEtaSample('bruno', 'pocket', 200, 10, store);
		expect(getCharsPerSecond('alba', 'pocket', store)).toBe(30);
		expect(getCharsPerSecond('alba', 'device', store)).toBe(10);
		expect(getCharsPerSecond('bruno', 'pocket', store)).toBe(20);
		expect(getCharsPerSecond('bruno', 'device', store)).toBeNull();
	});

	it('normalizes by speech rate in estimates', () => {
		const store = fakeStore();
		recordEtaSample('alba', 'pocket', 300, 10, store); // 30cps at 1.0x
		expect(estimateRemainingSeconds(300, 'alba', 'pocket', 2.0, store)).toBe(5);
		expect(estimateRemainingSeconds(300, 'alba', 'pocket', 0.5, store)).toBe(20);
	});

	it('ignores invalid samples and corrupt storage', () => {
		const store = fakeStore('not json{{{');
		expect(getCharsPerSecond('alba', 'pocket', store)).toBeNull();
		recordEtaSample('alba', 'pocket', 0, 10, store);
		recordEtaSample('alba', 'pocket', 100, 0, store);
		recordEtaSample('alba', 'pocket', NaN, 10, store);
		recordEtaSample('', 'pocket', 100, 10, store);
		expect(getCharsPerSecond('alba', 'pocket', store)).toBeNull();
	});

	it('bounds growth by halving past the cap', () => {
		const store = fakeStore();
		recordEtaSample('alba', 'pocket', STATS_CHAR_CAP, STATS_CHAR_CAP / 20, store); // 20cps
		recordEtaSample('alba', 'pocket', STATS_CHAR_CAP, STATS_CHAR_CAP / 20, store);
		const totals = JSON.parse(store.data['tts_eta_stats_v1'])['pocket:alba'];
		expect(totals.chars).toBeLessThanOrEqual(STATS_CHAR_CAP);
		expect(totals.chars / totals.seconds).toBeCloseTo(20, 9);
	});
});
