import { describe, expect, it } from 'vitest';
import {
	fallbackEtaSeconds,
	formatEta,
	resolveAnchoredEta,
	tickDownEta
} from './ocrEta';

describe('ocrEta countdown', () => {
	it('ticks down 1s per second between steps and never counts up', () => {
		const anchor = 18;
		const t0 = 1_000_000;
		expect(tickDownEta(anchor, t0, t0)).toBe(18);
		expect(tickDownEta(anchor, t0, t0 + 1000)).toBe(17);
		expect(tickDownEta(anchor, t0, t0 + 5000)).toBe(13);
		// later ticks are always <= earlier ticks
		expect(tickDownEta(anchor, t0, t0 + 6000)).toBeLessThanOrEqual(
			tickDownEta(anchor, t0, t0 + 5000)
		);
	});

	it('clamps at zero instead of going negative', () => {
		expect(tickDownEta(2, 0, 5000)).toBe(0);
		expect(tickDownEta(0, 0, 1000)).toBe(0);
	});

	it('prefers the server eta for the anchor (steps may revise up or down)', () => {
		expect(resolveAnchoredEta(14, 11, 16, 31)).toBe(14);
		expect(resolveAnchoredEta(20, 11, 16, 31)).toBe(20);
	});

	it('falls back to a countdown estimate when the step has no eta', () => {
		// 16 pages * 2.6 + 8 = 49.6s total; 30s elapsed -> ~19.6s left
		const eta = resolveAnchoredEta(undefined, 10, 16, 30);
		expect(eta).not.toBeNull();
		expect(eta!).toBeGreaterThan(19);
		expect(eta!).toBeLessThan(20);
	});

	it('returns null fallback while nothing is done yet', () => {
		expect(fallbackEtaSeconds(0, 16, 5)).toBeNull();
		expect(fallbackEtaSeconds(10, 0, 5)).toBeNull();
	});

	it('formats as m:ss', () => {
		expect(formatEta(18.4)).toBe('0:18');
		expect(formatEta(74)).toBe('1:14');
		expect(formatEta(-3)).toBe('0:00');
	});
});
