import { describe, expect, it } from 'vitest';
import {
	KOKORO_DEFAULT_VOICE,
	KOKORO_MODEL_ID,
	KOKORO_VOICES,
	encodeWavBlob,
	isKokoroVoice,
	KokoroProgressTracker,
	KokoroEngine
} from './kokoro';

describe('kokoro voices', () => {
	it('pins the model and the two top-grade voices', () => {
		expect(KOKORO_MODEL_ID).toBe('onnx-community/Kokoro-82M-v1.0-ONNX');
		expect(KOKORO_VOICES.map((v) => v.id)).toEqual(['af_heart', 'am_puck']);
		expect(KOKORO_DEFAULT_VOICE).toBe('af_heart');
		expect(isKokoroVoice('af_heart')).toBe(true);
		expect(isKokoroVoice('am_puck')).toBe(true);
		expect(isKokoroVoice('alba')).toBe(false);
		expect(isKokoroVoice(null)).toBe(false);
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

describe('KokoroProgressTracker', () => {
	it('folds per-file events into one bar', () => {
		const t = new KokoroProgressTracker();
		expect(t.update('model.onnx', 50, 100)).toEqual({ loaded: 50, total: 100 });
		expect(t.update('voice.bin', 25, 50)).toEqual({ loaded: 75, total: 150 });
		expect(t.update('model.onnx', 100, 100)).toEqual({ loaded: 125, total: 150 });
	});
});

describe('KokoroEngine guards', () => {
	it('rejects generate before ready', async () => {
		const engine = new KokoroEngine();
		expect(engine.status).toBe('idle');
		await expect(engine.generate('hello')).rejects.toThrow(/not ready/);
	});

	it('dispose without init is safe', () => {
		const engine = new KokoroEngine();
		expect(() => engine.dispose()).not.toThrow();
	});
});
