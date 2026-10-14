import { describe, it, expect } from 'vitest';
import {
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
