import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
	ALL_MODEL_FILES,
	BASE_MODEL_FILES,
	BROWSER_TTS_REVISION,
	areModelsCached,
	downloadModelFile,
	formatBytes,
	getCachedModel,
	modelFileUrl,
	totalBytes
} from './browserModels';

describe('browser model manifest', () => {
	it('pins all 7 files including the cloning encoder', () => {
		expect(BASE_MODEL_FILES.map((f) => f.name)).toEqual([
			'lm_main.int8.onnx',
			'decoder.int8.onnx',
			'text_conditioner.onnx',
			'lm_flow.int8.onnx',
			'vocab.json',
			'token_scores.json',
			'encoder.onnx'
		]);
		expect(ALL_MODEL_FILES).toHaveLength(7);
	});

	it('builds pinned HF resolve URLs', () => {
		expect(modelFileUrl('lm_main.int8.onnx')).toBe(
			`https://huggingface.co/csukuangfj2/sherpa-onnx-pocket-tts-int8-2026-01-26/resolve/${BROWSER_TTS_REVISION}/lm_main.int8.onnx`
		);
	});

	it('sums progress denominators (full bundle byte-exact)', () => {
		expect(totalBytes(BASE_MODEL_FILES)).toBe(198291829);
		expect(totalBytes(ALL_MODEL_FILES)).toBe(198291829);
		expect(formatBytes(totalBytes(BASE_MODEL_FILES))).toBe('189.1 MB');
	});
});

describe('formatBytes', () => {
	it('formats B/KB/MB', () => {
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(2048)).toBe('2.0 KB');
		expect(formatBytes(125 * 1024 * 1024)).toBe('125.0 MB');
	});
});

describe('model cache + download', () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it('returns null without Cache Storage (SSR/private mode)', async () => {
		vi.stubGlobal('caches', undefined);
		await expect(getCachedModel('vocab.json')).resolves.toBeNull();
		await expect(areModelsCached(BASE_MODEL_FILES)).resolves.toBe(false);
	});

	it('serves cache hits without fetching', async () => {
		const buf = new Uint8Array(123616).buffer;
		const match = vi.fn().mockResolvedValue(new Response(buf));
		const open = vi.fn().mockResolvedValue({ match, put: vi.fn(), delete: vi.fn() });
		vi.stubGlobal('caches', { open });
		vi.stubGlobal('fetch', vi.fn());
		const result = await getCachedModel('token_scores.json');
		expect(result?.byteLength).toBe(123616);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('drops truncated cache entries and reports a miss', async () => {
		const buf = new Uint8Array(100).buffer;
		const store = { match: vi.fn().mockResolvedValue(new Response(buf)), delete: vi.fn() };
		vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue(store) });
		await expect(getCachedModel('token_scores.json')).resolves.toBeNull();
		expect(store.delete).toHaveBeenCalled();
	});

	it('streams downloads with progress and rejects short bodies', async () => {
		vi.stubGlobal('caches', undefined);
		const chunk = new Uint8Array([1, 2, 3]);
		const reader = {
			read: vi
				.fn()
				.mockResolvedValueOnce({ done: false, value: chunk })
				.mockResolvedValueOnce({ done: true, value: undefined })
		};
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({ ok: true, status: 200, body: { getReader: () => reader } })
		);
		const seen: number[] = [];
		await expect(
			downloadModelFile('vocab.json', (p) => seen.push(p.loaded))
		).rejects.toThrow(/truncated/);
		expect(seen).toEqual([3]);
	});
});
