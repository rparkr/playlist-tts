import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	clearMediaMetadata,
	isMediaSessionSupported,
	setMediaActionHandlers,
	setMediaPlaybackState,
	updateMediaMetadata
} from './mediaSession';

describe('mediaSession helpers', () => {
	beforeEach(() => {
		expect(updateMediaMetadata).toBeDefined();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('no-ops without navigator.mediaSession', () => {
		vi.stubGlobal('navigator', {});
		expect(isMediaSessionSupported()).toBe(false);
		expect(() =>
			updateMediaMetadata({ title: 'Doc', artist: 'Sentence 1 of 2', album: 'pocket' })
		).not.toThrow();
		expect(() => setMediaPlaybackState(true)).not.toThrow();
		expect(() => setMediaActionHandlers({})).not.toThrow();
		expect(() => clearMediaMetadata()).not.toThrow();
	});

	it('publishes metadata, playback state, and action handlers', () => {
		const setActionHandler = vi.fn();
		const ms = { setActionHandler, metadata: null, playbackState: 'none' };
		vi.stubGlobal('navigator', { mediaSession: ms });
		class FakeMetadata {
			title: string;
			artwork: { src: string; sizes: string; type: string }[];
			constructor(init: { title: string; artwork?: { src: string; sizes: string; type: string }[] }) {
				this.title = init.title;
				this.artwork = init.artwork ?? [];
			}
		}
		vi.stubGlobal('MediaMetadata', FakeMetadata);

		expect(isMediaSessionSupported()).toBe(true);
		updateMediaMetadata({ title: 'Doc', artist: 'Sentence 1 of 2', album: 'pocket' });
		expect((ms.metadata as unknown as FakeMetadata).title).toBe('Doc');
		// Square packaged artwork — prevents the OS cropping the wide favicon.
		expect((ms.metadata as unknown as FakeMetadata).artwork.map((a) => a.sizes)).toEqual([
			'192x192',
			'512x512'
		]);

		setMediaPlaybackState(true);
		expect(ms.playbackState).toBe('playing');
		setMediaPlaybackState(false);
		expect(ms.playbackState).toBe('paused');

		const onPlay = vi.fn();
		const onPause = vi.fn();
		const onPrev = vi.fn();
		const onNext = vi.fn();
		setMediaActionHandlers({ onPlay, onPause, onPrev, onNext });
		const actions = Object.fromEntries(setActionHandler.mock.calls.map(([k, v]) => [k, v]));
		expect(actions.play).toBe(onPlay);
		expect(actions.pause).toBe(onPause);
		expect(actions.previoustrack).toBe(onPrev);
		expect(actions.nexttrack).toBe(onNext);

		clearMediaMetadata();
		expect(ms.metadata).toBeNull();
		expect(ms.playbackState).toBe('none');
	});
});
