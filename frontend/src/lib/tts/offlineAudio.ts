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

export interface OfflineJobDeps {
	createJob: (
		text: string,
		voiceId: string | null,
		voiceBlob: Blob | null,
		fmt: string
	) => Promise<string>;
	pollJob: (jobId: string) => Promise<{ status: string; error?: string }>;
	download: (jobId: string) => Promise<Blob>;
}

export interface OfflineJobOptions {
	text: string;
	voiceId: string | null;
	voiceBlob: Blob | null;
	fmt: string;
	onProgress?: () => void;
	pollIntervalMs?: number;
	maxPolls?: number;
	deps?: OfflineJobDeps;
}

function defaultDeps(): OfflineJobDeps {
	return {
		createJob: async (text, voiceId, voiceBlob, fmt) => {
			const { createTTSFileJob } = await import('./backendStream');
			return createTTSFileJob(text, voiceId, voiceBlob, fmt);
		},
		pollJob: async (jobId) => {
			const { pollTTSJob } = await import('./backendStream');
			return pollTTSJob(jobId);
		},
		download: async (jobId) => {
			const { getTTSDownloadUrl } = await import('./backendStream');
			const resp = await fetch(getTTSDownloadUrl(jobId));
			if (!resp.ok) throw new Error(`Offline audio download failed ${resp.status}`);
			return resp.blob();
		}
	};
}

/** Generate a whole-chapter file via `POST /api/tts/jobs` and return its blob.
 *
 * Polls until done (server synthesizes ~4–6× real-time on CPU, so long docs
 * take minutes — callers show progress meanwhile). `deps` injection keeps
 * this testable without a network.
 */
export async function generateOfflineAudioBlob(opts: OfflineJobOptions): Promise<Blob> {
	const deps = opts.deps ?? defaultDeps();
	const onProgress = opts.onProgress ?? (() => {});
	const interval = opts.pollIntervalMs ?? 2000;
	const maxPolls = opts.maxPolls ?? 300;
	const jobId = await deps.createJob(opts.text, opts.voiceId, opts.voiceBlob, opts.fmt);
	for (let i = 0; i < maxPolls; i++) {
		const status = await deps.pollJob(jobId);
		if (status.status === 'done') return deps.download(jobId);
		if (status.status === 'error') throw new Error(status.error || 'Offline audio job failed');
		onProgress();
		await new Promise((r) => setTimeout(r, interval));
	}
	throw new Error('Offline audio job timed out');
}
