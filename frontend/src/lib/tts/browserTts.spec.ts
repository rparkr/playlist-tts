import { describe, expect, it, vi } from 'vitest';
import { BrowserTtsEngine, decodeReferenceVoice, monoSamples } from './browserTts';

describe('monoSamples', () => {
	it('returns empty for no channels', () => {
		expect(monoSamples([])).toHaveLength(0);
	});

	it('copies a single channel', () => {
		const ch = new Float32Array([0.5, -0.5, 0.25]);
		const out = monoSamples([ch]);
		expect(out).toEqual(ch);
		expect(out).not.toBe(ch);
	});

	it('averages stereo channels', () => {
		const out = monoSamples([new Float32Array([1, 0]), new Float32Array([-1, 0.5])]);
		expect(out[0]).toBeCloseTo(0);
		expect(out[1]).toBeCloseTo(0.25);
	});
});

describe('decodeReferenceVoice', () => {
	it('throws without WebAudio', async () => {
		vi.stubGlobal('window', undefined);
		await expect(decodeReferenceVoice(new Blob([]))).rejects.toThrow(/WebAudio/);
		vi.unstubAllGlobals();
	});
});

describe('BrowserTtsEngine guards', () => {
	it('rejects generate before ready', async () => {
		const engine = new BrowserTtsEngine();
		expect(engine.status).toBe('idle');
		await expect(engine.generate('hello')).rejects.toThrow(/not ready/);
	});

	it('terminate clears state without a worker', () => {
		const engine = new BrowserTtsEngine();
		expect(() => engine.terminate()).not.toThrow();
		expect(engine.status).toBe('idle');
	});
});
