import { describe, it, expect, vi } from 'vitest';
import {
	generateOfflineAudioBlob,
	hashSpeakableText,
	isOfflineAudioStale,
	joinSpeakableTexts,
	parseOfflineFmt
} from './offlineAudio';

describe('parseOfflineFmt', () => {
	it('accepts webm, mp3, wav and rejects everything else', () => {
		expect(parseOfflineFmt('webm')).toBe('webm');
		expect(parseOfflineFmt('mp3')).toBe('mp3');
		expect(parseOfflineFmt('wav')).toBe('wav');
		expect(parseOfflineFmt('ogg')).toBeNull();
		expect(parseOfflineFmt('')).toBeNull();
		expect(parseOfflineFmt(null)).toBeNull();
		expect(parseOfflineFmt(undefined)).toBeNull();
	});
});

describe('hashSpeakableText', () => {
	it('is deterministic and sensitive to text changes', () => {
		expect(hashSpeakableText('hello world')).toBe(hashSpeakableText('hello world'));
		expect(hashSpeakableText('hello world')).not.toBe(hashSpeakableText('hello world!'));
		expect(hashSpeakableText('')).not.toBe(hashSpeakableText('a'));
	});
});

describe('joinSpeakableTexts', () => {
	it('joins chunks with single spaces', () => {
		expect(joinSpeakableTexts(['Alpha.', 'Bravo.'])).toBe('Alpha. Bravo.');
		expect(joinSpeakableTexts([])).toBe('');
	});
});

describe('generateOfflineAudioBlob', () => {
	it('polls until done, then downloads', async () => {
		const progress = vi.fn();
		const deps = {
			createJob: vi.fn(async () => 'job1'),
			pollJob: vi.fn(async () => ({ status: 'running' })),
			download: vi.fn(async () => new Blob(['audio']))
		};
		deps.pollJob.mockResolvedValueOnce({ status: 'running' }).mockResolvedValueOnce({ status: 'done' });
		const blob = await generateOfflineAudioBlob({
			text: 'Alpha. Bravo.',
			voiceId: 'alba',
			voiceBlob: null,
			fmt: 'webm',
			pollIntervalMs: 1,
			onProgress: progress,
			deps
		});
		expect(await blob.text()).toBe('audio');
		expect(deps.createJob).toHaveBeenCalledWith('Alpha. Bravo.', 'alba', null, 'webm');
		expect(deps.pollJob).toHaveBeenCalledTimes(2);
		expect(progress).toHaveBeenCalledTimes(1);
	});

	it('throws on job error', async () => {
		const deps = {
			createJob: vi.fn(async () => 'job1'),
			pollJob: vi.fn(async () => ({ status: 'error', error: 'boom' })),
			download: vi.fn(async () => new Blob())
		};
		await expect(
			generateOfflineAudioBlob({
				text: 'Alpha.',
				voiceId: null,
				voiceBlob: null,
				fmt: 'mp3',
				pollIntervalMs: 1,
				deps
			})
		).rejects.toThrow('boom');
	});

	it('throws on timeout', async () => {
		const deps = {
			createJob: vi.fn(async () => 'job1'),
			pollJob: vi.fn(async () => ({ status: 'running' })),
			download: vi.fn(async () => new Blob())
		};
		await expect(
			generateOfflineAudioBlob({
				text: 'Alpha.',
				voiceId: null,
				voiceBlob: null,
				fmt: 'mp3',
				pollIntervalMs: 1,
				maxPolls: 2,
				deps
			})
		).rejects.toThrow('timed out');
	});
});

describe('isOfflineAudioStale', () => {
	it('flags edits and accepts exact matches', () => {
		const current = hashSpeakableText(joinSpeakableTexts(['Alpha.', 'Bravo.']));
		expect(isOfflineAudioStale(current, current)).toBe(false);
		expect(
			isOfflineAudioStale(
				hashSpeakableText(joinSpeakableTexts(['Alpha.'])),
				current
			)
		).toBe(true);
	});
});
