import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BackendSentencePlayer } from './backendSentencePlayer';
import { fetchTTSWavStream } from './backendStream';

vi.mock('./backendStream', () => ({
	fetchTTSWavStream: vi.fn(
		(text: string, _voiceId: unknown, _voiceBlob: unknown, signal?: AbortSignal) =>
			new Promise<{ blob: Blob; url: string }>((resolve, reject) => {
				if (signal?.aborted) {
					reject(new DOMException('aborted', 'AbortError'));
					return;
				}
				const timer = setTimeout(() => {
					resolve({ blob: new Blob([text]), url: `url:${text}` });
				}, 20);
				signal?.addEventListener(
					'abort',
					() => {
						clearTimeout(timer);
						reject(new DOMException('aborted', 'AbortError'));
					},
					{ once: true }
				);
			})
	)
}));

const fetchMock = vi.mocked(fetchTTSWavStream);

/** Minimal HTMLAudioElement stand-in with an inspectable event log. */
class MockAudio {
	src = '';
	currentTime = 0;
	playbackRate = 1;
	paused = true;
	ended = false;
	log: string[] = [];
	private listeners = new Map<string, Set<() => void>>();

	constructor() {
		audios.push(this);
	}

	async play(): Promise<void> {
		this.log.push(`play:${this.src}`);
		this.paused = false;
		this.ended = false;
	}

	pause(): void {
		this.log.push('pause');
		this.paused = true;
	}

	load(): void {
		this.log.push('load');
	}

	removeAttribute(name: string): void {
		this.log.push(`removeAttribute:${name}`);
		if (name === 'src') this.src = '';
	}

	addEventListener(type: string, fn: () => void): void {
		let set = this.listeners.get(type);
		if (!set) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(fn);
	}

	removeEventListener(type: string, fn: () => void): void {
		this.listeners.get(type)?.delete(fn);
	}

	/** Test driver: pretend the current resource played to completion. */
	__ended(): void {
		this.ended = true;
		this.paused = true;
		const set = this.listeners.get('ended');
		this.listeners.delete('ended');
		set?.forEach((fn) => fn());
	}
}

let audios: MockAudio[] = [];
const audio = () => audios[audios.length - 1];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('BackendSentencePlayer seeking', () => {
	let player: BackendSentencePlayer;
	let started: number[];

	beforeEach(() => {
		audios = [];
		started = [];
		fetchMock.mockClear();
		vi.stubGlobal('Audio', MockAudio);
		player = new BackendSentencePlayer();
		player.setCallbacks({ onSentenceStart: (idx) => started.push(idx) });
	});

	afterEach(async () => {
		player.destroy();
		vi.unstubAllGlobals();
		// Let the 250ms invalidation checkers flush so intervals don't leak.
		await sleep(300);
	});

	it('plays the sought sentence after seek-while-paused, not the parked one', async () => {
		void player.play(['Alpha.', 'Bravo.', 'Charlie.'], 0, 'v', 'v', null, 1);
		await vi.waitFor(() => expect(audio().src).toBe('url:Alpha.'));

		// Park mid-sentence, then select another sentence while paused.
		audio().currentTime = 1;
		player.pause();
		await player.seek(1);

		// resume() only settles at end-of-playback; drive it fire-and-forget.
		void player.resume();
		await vi.waitFor(() => expect(audio().src).toBe('url:Bravo.'));
		expect(started).toEqual([0, 1]);
	});

	it('does not replay stale audio when resuming after pause-during-fetch + seek', async () => {
		void player.play(['Alpha.', 'Bravo.', 'Charlie.'], 0, 'v', 'v', null, 1);
		await vi.waitFor(() => expect(audio().src).toBe('url:Alpha.'));

		// Seek while running (fetch of Bravo in flight), then pause, then play.
		void player.seek(1);
		player.pause();
		expect(player.canResume()).toBe(true);

		void player.resume();
		await vi.waitFor(() => expect(audio().src).toBe('url:Bravo.'));
		expect(started).not.toContain(2);
		expect(started[started.length - 1]).toBe(1);
	});

	it('switches the element to the sought sentence when seeking while playing', async () => {
		void player.play(['Alpha.', 'Bravo.', 'Charlie.'], 0, 'v', 'v', null, 1);
		await vi.waitFor(() => expect(audio().src).toBe('url:Alpha.'));

		void player.seek(2);
		await vi.waitFor(() => expect(audio().src).toBe('url:Charlie.'));
		expect(audio().log).toContain('pause');
		expect(started).toEqual([0, 2]);
	});

	it('lands on the latest target after rapid successive seeks', async () => {
		void player.play(['Alpha.', 'Bravo.', 'Charlie.'], 0, 'v', 'v', null, 1);
		await vi.waitFor(() => expect(audio().src).toBe('url:Alpha.'));

		void player.seek(2);
		void player.seek(1);
		await vi.waitFor(() => expect(audio().src).toBe('url:Bravo.'));
		expect(started).toEqual([0, 1]);
	});

	it('resumes the same sentence instantly when paused with no seek', async () => {
		void player.play(['Alpha.', 'Bravo.'], 0, 'v', 'v', null, 1);
		await vi.waitFor(() => expect(audio().src).toBe('url:Alpha.'));
		// Let the prefetch of Bravo settle so the fetch count is stable.
		await sleep(60);

		audio().currentTime = 1;
		player.pause();
		const fetchesBefore = fetchMock.mock.calls.length;
		void player.resume();

		// Parked fast path: replays the element without refetching.
		await vi.waitFor(() =>
			expect(audio().log.filter((e) => e === 'play:url:Alpha.').length).toBe(2)
		);
		expect(fetchMock.mock.calls.length).toBe(fetchesBefore);
		expect(audio().src).toBe('url:Alpha.');
	});

	it('never sounds a sentence deleted while paused', async () => {
		void player.play(['Alpha.', 'Bravo.'], 0, 'v', 'v', null, 1);
		await vi.waitFor(() => expect(audio().src).toBe('url:Alpha.'));

		audio().currentTime = 1;
		player.pause();
		// User deletes the first sentence, then presses play.
		player.updateSentences(['Bravo.']);

		void player.resume();
		await vi.waitFor(() => expect(audio().src).toBe('url:Bravo.'));
		// Alpha was fetched once (before the edit) and never replayed.
		expect(fetchMock.mock.calls.filter((c) => c[0] === 'Alpha.').length).toBe(1);
		expect(started).toEqual([0, 0]);
	});

	it('clamps a parked position past the end of an edited document', async () => {
		void player.play(['Alpha.', 'Bravo.', 'Charlie.'], 0, 'v', 'v', null, 1);
		await vi.waitFor(() => expect(audio().src).toBe('url:Alpha.'));

		audio().currentTime = 1;
		player.pause();
		await player.seek(2);
		// User deletes everything after the first sentence.
		player.updateSentences(['Alpha.']);

		void player.resume();
		await vi.waitFor(() => expect(audio().src).toBe('url:Alpha.'));
		expect(player.currentIndex).toBe(0);
		expect(started).toEqual([0, 0]);
	});

	it('ignores snapshot updates while pristine', () => {
		player.updateSentences(['Alpha.']);
		expect(player.canResume()).toBe(false);
		expect(player.currentIndex).toBe(0);
	});
});

describe('BackendSentencePlayer completion timing', () => {
	let player: BackendSentencePlayer;
	let completed: { idx: number; chars: number; secondsAt1x: number }[];

	beforeEach(() => {
		audios = [];
		completed = [];
		fetchMock.mockClear();
		vi.stubGlobal('Audio', MockAudio);
		player = new BackendSentencePlayer();
		player.setCallbacks({
			onSentenceComplete: (idx, chars, secondsAt1x) =>
				completed.push({ idx, chars, secondsAt1x })
		});
	});

	afterEach(async () => {
		player.destroy();
		vi.unstubAllGlobals();
		await sleep(300);
	});

	it('reports chars and 1.0x-normalized seconds on natural completion', async () => {
		void player.play(['Alpha.'], 0, 'v', 'v', null, 2.0);
		await vi.waitFor(() => expect(audio().src).toBe('url:Alpha.'));
		audio().__ended();
		await vi.waitFor(() => expect(completed.length).toBe(1));
		expect(completed[0].idx).toBe(0);
		expect(completed[0].chars).toBe('Alpha.'.length);
		// Wall duration divided by the 2.0x rate — small but positive.
		expect(completed[0].secondsAt1x).toBeGreaterThan(0);
		expect(completed[0].secondsAt1x).toBeLessThan(5);
	});

	it('does not report aborted sentences', async () => {
		void player.play(['Alpha.', 'Bravo.'], 0, 'v', 'v', null, 1);
		await vi.waitFor(() => expect(audio().src).toBe('url:Alpha.'));
		// Seek away before Alpha ends: its chain is invalidated, so no sample.
		void player.seek(1);
		await vi.waitFor(() => expect(audio().src).toBe('url:Bravo.'));
		audio().__ended();
		await vi.waitFor(() => expect(completed.length).toBe(1));
		expect(completed[0].idx).toBe(1);
	});
});

describe('BackendSentencePlayer fetch injection', () => {
	let player: BackendSentencePlayer;
	let started: number[];

	beforeEach(() => {
		audios = [];
		started = [];
		fetchMock.mockClear();
		vi.stubGlobal('Audio', MockAudio);
		player = new BackendSentencePlayer();
		player.setCallbacks({ onSentenceStart: (idx) => started.push(idx) });
	});

	afterEach(async () => {
		player.destroy();
		vi.unstubAllGlobals();
		await sleep(300);
	});

	it('uses the injected fetch (custom audio source) instead of the backend', async () => {
		const calls: string[] = [];
		player.setFetchAudio(async (text) => {
			calls.push(text);
			return { url: `custom:${text}` };
		});
		void player.play(['Alpha.', 'Bravo.'], 0, 'custom', null, null, 1);
		await vi.waitFor(() => expect(audio().src).toBe('custom:Alpha.'));
		expect(calls).toContain('Alpha.');
		expect(fetchMock).not.toHaveBeenCalled();
		expect(started).toEqual([0]);
	});
});
