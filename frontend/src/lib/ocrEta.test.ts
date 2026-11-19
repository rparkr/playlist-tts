import { describe, expect, it } from 'vitest';
import { formatEta, formatRemaining, measureEtaSeconds, tickDownEta } from './ocrEta';

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

	it('estimates remaining time from measured throughput', () => {
		// 10 of 16 pages in 30s => 3s/page => 18s left
		expect(measureEtaSeconds(10, 16, 30)).toBe(18);
		expect(measureEtaSeconds(16, 16, 48)).toBe(0);
	});

	it('returns null before the first completed page', () => {
		expect(measureEtaSeconds(0, 16, 5)).toBeNull();
		expect(measureEtaSeconds(10, 0, 5)).toBeNull();
		expect(measureEtaSeconds(Number.NaN, 16, 5)).toBeNull();
	});

	it('formats as m:ss', () => {
		expect(formatEta(18.4)).toBe('0:18');
		expect(formatEta(74)).toBe('1:14');
		expect(formatEta(-3)).toBe('0:00');
	});

	it('formats remaining under an hour as m:ss', () => {
		expect(formatRemaining(125)).toBe('2:05');
		expect(formatRemaining(59.4)).toBe('0:59');
		expect(formatRemaining(3599)).toBe('59:59');
	});

	it('formats remaining of an hour or more as h:mm:ss', () => {
		expect(formatRemaining(382 * 60 + 45)).toBe('6:22:45');
		expect(formatRemaining(3600)).toBe('1:00:00');
		expect(formatRemaining(3600 * 10 + 60 + 5)).toBe('10:01:05');
	});

	it('rounds before splitting so seconds never show :60', () => {
		expect(formatRemaining(119.6)).toBe('2:00');
		// Rounding that carries over the hour boundary switches branches.
		expect(formatRemaining(3599.6)).toBe('1:00:00');
		expect(formatRemaining(-3)).toBe('0:00');
	});
});
