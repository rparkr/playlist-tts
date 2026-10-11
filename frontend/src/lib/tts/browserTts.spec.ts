import { describe, expect, it, vi } from 'vitest';
import {
	BrowserTtsEngine,
	builtinVoiceWavUrl,
	decodeReferenceVoice,
	encodeWavBlob,
	monoSamples,
	referenceVoiceCache,
	resolveReferenceVoice
} from './browserTts';

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

describe('encodeWavBlob', () => {
	it('writes a 16-bit PCM header with exact sizes', async () => {
		const samples = new Float32Array([0, 0.5, -0.5, 1]);
		const blob = encodeWavBlob(samples, 24000);
		expect(blob.type).toBe('audio/wav');
		expect(blob.size).toBe(44 + 4 * 2);
		const buf = new DataView(await blob.arrayBuffer());
		const ascii = (off: number, len: number) =>
			String.fromCharCode(...new Uint8Array(buf.buffer, off, len));
		expect(ascii(0, 4)).toBe('RIFF');
		expect(ascii(8, 4)).toBe('WAVE');
		expect(buf.getUint32(24, true)).toBe(24000);
		expect(buf.getUint32(40, true)).toBe(8);
		expect(buf.getInt16(44 + 3 * 2, true)).toBe(32767);
	});
});

describe('builtinVoiceWavUrl', () => {
	it('maps hf:// origins to resolve URLs', () => {
		expect(builtinVoiceWavUrl('hf://kyutai/tts-voices/alba-mackenna/casual.wav')).toBe(
			'https://huggingface.co/kyutai/tts-voices/resolve/main/alba-mackenna/casual.wav'
		);
		expect(builtinVoiceWavUrl('https://example.com/x.wav')).toBeNull();
		expect(builtinVoiceWavUrl('hf://nopath')).toBeNull();
	});
});

describe('resolveReferenceVoice', () => {
	it('decodes once per key', async () => {
		referenceVoiceCache.clear();
		// Stub WebAudio decode by pre-seeding the cache path is browser-only;
		// here we verify the cache short-circuit with a seeded entry.
		referenceVoiceCache.set('alba', { samples: new Float32Array([1]), sampleRate: 24000 });
		const load = vi.fn();
		const voice = await resolveReferenceVoice('alba', load);
		expect(voice.sampleRate).toBe(24000);
		expect(load).not.toHaveBeenCalled();
		referenceVoiceCache.clear();
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
