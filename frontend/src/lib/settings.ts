/** Persistent reader settings: localStorage keys, URL params, and pure resolvers.
 *
 * Query params (`doc`, `s`, `rate`, `voice`, `engine`) carry shareable playback
 * state for deep links. LocalStorage carries the last-set state across reloads
 * when no query param overrides it. Per-document postprocessing options live in
 * IndexedDB on the doc; `tts_postprocess` only stores the last-set defaults
 * used for new OCR jobs and for the pre-doc UI.
 */

export type TtsEngine = 'device' | 'pocket';

export const LS_KEYS = {
	activeDocId: 'tts_active_doc_id',
	rate: 'tts_rate',
	voice: 'tts_voice',
	engine: 'tts_engine',
	postprocess: 'tts_postprocess'
} as const;

export const URL_PARAMS = {
	doc: 'doc',
	sentence: 's',
	rate: 'rate',
	voice: 'voice',
	engine: 'engine'
} as const;

export interface PostprocessFlags {
	combine: boolean;
	uppercase: boolean;
	punct: boolean;
	pageMarkers: boolean;
}

/** Parse an `engine` URL/localStorage value; return null when absent/invalid. */
export function parseEngine(value: string | null | undefined): TtsEngine | null {
	if (value === 'pocket' || value === 'backend') return 'pocket';
	if (value === 'device' || value === 'builtin') return 'device';
	return null;
}

/** Parse a speech-rate value; return null when absent/invalid. */
export function parseRate(value: string | null | undefined): number | null {
	if (value === null || value === undefined || value === '') return null;
	const n = parseFloat(value);
	if (!Number.isFinite(n)) return null;
	return Math.min(2.0, Math.max(0.5, n));
}

/** Parse a sentence index; return null when absent/invalid. */
export function parseSentenceIndex(value: string | null | undefined): number | null {
	if (value === null || value === undefined || value === '') return null;
	const n = parseInt(value, 10);
	if (isNaN(n) || n < 0) return null;
	return n;
}

/**
 * Resolve a setting with "URL wins, else stored, else default" precedence.
 *
 * This is the core rule that keeps deep links shareable while plain reloads
 * restore the last-set state from localStorage.
 */
export function resolveWithUrlPrecedence<T>(
	urlValue: string | null | undefined,
	storedValue: string | null | undefined,
	fallback: T,
	parse: (v: string) => T | null
): T {
	if (urlValue !== null && urlValue !== undefined && urlValue !== '') {
		const parsed = parse(urlValue);
		if (parsed !== null) return parsed;
	}
	if (storedValue !== null && storedValue !== undefined && storedValue !== '') {
		const parsed = parse(storedValue);
		if (parsed !== null) return parsed;
	}
	return fallback;
}

/** Parse stored postprocess flags; return null when absent/invalid. */
export function parsePostprocessFlags(value: string | null | undefined): PostprocessFlags | null {
	if (!value) return null;
	try {
		const p = JSON.parse(value) as Partial<PostprocessFlags>;
		if (
			typeof p.combine !== 'boolean' ||
			typeof p.uppercase !== 'boolean' ||
			typeof p.punct !== 'boolean' ||
			typeof p.pageMarkers !== 'boolean'
		) {
			return null;
		}
		return { combine: p.combine, uppercase: p.uppercase, punct: p.punct, pageMarkers: p.pageMarkers };
	} catch {
		return null;
	}
}

/** Serialize postprocess flags for localStorage. */
export function serializePostprocessFlags(flags: PostprocessFlags): string {
	return JSON.stringify(flags);
}

export function progressKey(docId: string): string {
	return `progress_${docId}`;
}
