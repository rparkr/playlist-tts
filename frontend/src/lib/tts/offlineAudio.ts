/** Offline chapter-audio helpers — pure functions around the IndexedDB store.
 *
 * The store itself (`audio` in `stores/library`) holds one pre-generated
 * single-file chapter per doc+voice+format. These helpers build cache keys,
 * hash speakable text for staleness checks, and validate the format choice
 * (`webm`/Opus smallest, `mp3` most compatible, `wav` backend fallback).
 */

export type OfflineAudioFmt = 'webm' | 'mp3' | 'wav';

export const OFFLINE_FMTS: readonly OfflineAudioFmt[] = ['webm', 'mp3', 'wav'];

/** Parse a stored format value; return null when absent/invalid. */
export function parseOfflineFmt(value: string | null | undefined): OfflineAudioFmt | null {
	if (value === 'webm' || value === 'mp3' || value === 'wav') return value;
	return null;
}

/** Short hash of the exact speakable text a file was built from.
 *
 * Stored as `textHash` on the record; edits change the hash so the UI can
 * flag the file as stale instead of silently playing outdated audio.
 */
export function hashSpeakableText(text: string): string {
	let h = 5381;
	for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36);
}

/** Join derived speakable chunks the same way generation does. */
export function joinSpeakableTexts(texts: string[]): string {
	return texts.join(' ');
}

/** True when the cached file no longer matches the current document text. */
export function isOfflineAudioStale(cachedHash: string, currentHash: string): boolean {
	return cachedHash !== currentHash;
}
