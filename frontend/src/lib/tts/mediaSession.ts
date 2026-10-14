/** Media Session lock-screen controls — metadata + transport handlers.
 *
 * This does not keep audio alive in the background (browsers suspend
 * `speechSynthesis` and throttle per-sentence `fetch` chains on lock).
 * It only puts the current document / sentence on the lock screen and
 * routes headset / lock-screen buttons back into the app's player.
 *
 * All helpers no-op when `navigator.mediaSession` is unavailable, so they
 * are safe to call unconditionally from page effects and unit tests.
 */

export interface MediaHandlers {
	onPlay?: () => void;
	onPause?: () => void;
	onPrev?: () => void;
	onNext?: () => void;
}

export interface MediaTrackInfo {
	/** Document title shown as the track title. */
	title: string;
	/** e.g. `Sentence 12 of 300` — shown as artist. */
	artist: string;
	/** Playlist / engine label — shown as album. */
	album: string;
}

function session(): MediaSession | null {
	if (typeof navigator === 'undefined') return null;
	const nav = navigator as Navigator & { mediaSession?: MediaSession };
	return nav.mediaSession ?? null;
}

/** True when lock-screen metadata + button handlers are available. */
export function isMediaSessionSupported(): boolean {
	return session() !== null;
}

/** Publish the current track on the lock screen / notification shade. */
export function updateMediaMetadata(info: MediaTrackInfo): void {
	const ms = session();
	if (!ms || typeof MediaMetadata === 'undefined') return;
	try {
		ms.metadata = new MediaMetadata({
			title: info.title || 'OCR-TTS Reader',
			artist: info.artist,
			album: info.album,
			// Square PNGs so the phone doesn't crop/zoom the wide favicon
			// (that fallback is what looked blurry). Served from static/.
			artwork: [
				{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
				{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }
			]
		});
	} catch {
		// ignore — lock-screen controls are best-effort
	}
}

/** Reflect play vs pause so the lock-screen button shows the right glyph. */
export function setMediaPlaybackState(playing: boolean): void {
	const ms = session();
	if (!ms) return;
	try {
		ms.playbackState = playing ? 'playing' : 'paused';
	} catch {
		// ignore
	}
}

/** Route lock-screen / headset buttons into the app player. */
export function setMediaActionHandlers(handlers: MediaHandlers): void {
	const ms = session();
	if (!ms) return;
	try {
		ms.setActionHandler('play', handlers.onPlay ?? null);
		ms.setActionHandler('pause', handlers.onPause ?? null);
		ms.setActionHandler('previoustrack', handlers.onPrev ?? null);
		ms.setActionHandler('nexttrack', handlers.onNext ?? null);
	} catch {
		// ignore — e.g. headphones-only actions on some browsers
	}
}

/** Clear the lock-screen entry (e.g. when no document is open). */
export function clearMediaMetadata(): void {
	const ms = session();
	if (!ms) return;
	try {
		ms.metadata = null;
		ms.playbackState = 'none';
	} catch {
		// ignore
	}
}
