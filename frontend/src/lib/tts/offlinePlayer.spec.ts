import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	cumulativeEnds,
	fractionForIndex,
	indexForFraction,
	OfflinePlayer
} from './offlinePlayer';

describe('fraction mapping', () => {
	const ends = cumulativeEnds([5, 5, 10]); // total 20

	it('maps sentence starts to fractions', () => {
		expect(fractionForIndex(0, ends, 20)).toBe(0);
		expect(fractionForIndex(1, ends, 20)).toBe(0.25);
		expect(fractionForIndex(2, ends, 20)).toBe(0.5);
	});

	it('clamps out-of-range indices and guards empty input', () => {
		expect(fractionForIndex(99, ends, 20)).toBe(0.5);
		expect(fractionForIndex(-3, ends, 20)).toBe(0);
		expect(fractionForIndex(0, [], 0)).toBe(0);
	});

	it('maps fractions back to the sentence ending past them', () => {
		expect(indexForFraction(0, ends, 20)).toBe(0);
		expect(indexForFraction(0.24, ends, 20)).toBe(0);
		expect(indexForFraction(0.25, ends, 20)).toBe(1);
		expect(indexForFraction(0.9, ends, 20)).toBe(2);
		expect(indexForFraction(1, ends, 20)).toBe(2);
		expect(indexForFraction(0.5, [], 0)).toBe(0);
	});
});

/** Minimal HTMLAudioElement stand-in with drivable events. */
class MockAudio {
	src = '';
	currentTime = 0;
	duration = 100;
	playbackRate = 1;
	preload = '';
	private listeners = new Map<string, Set<() => void>>();

	async play(): Promise<void> {}
	pause(): void {}
	load(): void {}
	removeAttribute(_name: string): void {}
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
	__fire(type: string): void {
		this.listeners.get(type)?.forEach((fn) => fn());
	}
}

let audios: MockAudio[] = [];

describe('OfflinePlayer', () => {
	let player: OfflinePlayer;

	beforeEach(() => {
		audios = [];
		vi.stubGlobal(
			'Audio',
			class extends MockAudio {
				constructor() {
					super();
					audios.push(this);
				}
			}
		);
		let n = 0;
		vi.stubGlobal('URL', {
			createObjectURL: () => `blob:offline-${++n}`,
			revokeObjectURL: vi.fn()
		});
		player = new OfflinePlayer();
	});

	afterEach(() => {
		player.destroy();
		vi.unstubAllGlobals();
	});

	it('seeks to the sentence fraction on play', async () => {
		const seen: number[] = [];
		player.setCallbacks({ onTimeIndex: (i) => seen.push(i) });
		player.load(new Blob(['x']), [50, 50]); // total 100 chars
		await player.playFromIndex(1, 1);
		// sentence 1 starts at 50/100 of duration 100
		expect(audios[0].currentTime).toBe(50);

		// timeupdate maps back to sentence 1
		audios[0].__fire('timeupdate');
		expect(seen).toEqual([1]);
	});

	it('fires onEnded when the file completes', async () => {
		let ended = 0;
		player.setCallbacks({ onEnded: () => ended++ });
		player.load(new Blob(['x']), [10]);
		await player.playFromIndex(0, 1);
		audios[0].__fire('ended');
		expect(ended).toBe(1);
		expect(player.isRunning).toBe(false);
	});

	it('revokes the object URL on unload', async () => {
		player.load(new Blob(['x']), [10]);
		await player.playFromIndex(0, 1);
		player.unload();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:offline-1');
	});
});
