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
		// Cold-start seed (900 chars / 60s) smooths the first sample:
		// (900+300)/(60+10) ≈ 17.14, not all the way to 30.
		recordEtaSample('alba', 'pocket', 300, 10, store); // true 30cps
		expect(getCharsPerSecond('alba', 'pocket', store)).toBeCloseTo(1200 / 70, 9);
		// A "fresh session" reading the same storage sees the smoothed pace.
		const again = fakeStore(store.data['tts_eta_stats_v1']);
		expect(getCharsPerSecond('alba', 'pocket', again)).toBeCloseTo(1200 / 70, 9);
		// More evidence washes the seed out toward the measured 30cps:
		// (900+30000)/(60+1010) ≈ 28.9 after 100 more samples.
		for (let i = 0; i < 100; i++) recordEtaSample('alba', 'pocket', 300, 10, store);
		const settled = getCharsPerSecond('alba', 'pocket', store);
		expect(settled).toBeGreaterThan(28);
		expect(settled).toBeLessThan(30);
	});

	it('settles monotonically instead of swinging on early samples', () => {
		const store = fakeStore();
		// True pace 30cps from a 15cps cold start: each sample steps closer.
		const paces: number[] = [];
		for (let i = 0; i < 5; i++) {
			recordEtaSample('alba', 'pocket', 300, 10, store);
			const pace = getCharsPerSecond('alba', 'pocket', store);
			expect(pace).not.toBeNull();
			if (pace !== null) paces.push(pace);
		}
		for (const pace of paces) {
			expect(pace).toBeGreaterThan(15);
			expect(pace).toBeLessThan(30);
		}
		for (let i = 1; i < paces.length; i++) {
			expect(paces[i]).toBeGreaterThan(paces[i - 1]);
		}
		// First step moves only ~2cps, not the full 15.
		expect(paces[0]).toBeLessThan(20);
	});

	it('keys stats by voice and engine separately', () => {
		const store = fakeStore();
		recordEtaSample('alba', 'pocket', 300, 10, store);
		recordEtaSample('alba', 'device', 100, 10, store);
		recordEtaSample('bruno', 'pocket', 200, 10, store);
		expect(getCharsPerSecond('alba', 'pocket', store)).toBeCloseTo(1200 / 70, 9);
		expect(getCharsPerSecond('alba', 'device', store)).toBeCloseTo(1000 / 70, 9);
		expect(getCharsPerSecond('bruno', 'pocket', store)).toBeCloseTo(1100 / 70, 9);
		expect(getCharsPerSecond('bruno', 'device', store)).toBeNull();
	});

	it('normalizes by speech rate in estimates', () => {
		const store = fakeStore();
		recordEtaSample('alba', 'pocket', 300, 10, store); // smoothed ≈17.14cps
		const pace = 1200 / 70;
		expect(estimateRemainingSeconds(1200, 'alba', 'pocket', 1.0, store)).toBeCloseTo(
			1200 / pace,
			9
		);
		expect(estimateRemainingSeconds(1200, 'alba', 'pocket', 2.0, store)).toBeCloseTo(
			1200 / pace / 2,
			9
		);
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
		expect(totals.chars / totals.seconds).toBeCloseTo(20, 1);
	});
});
