/** Persistent reader settings: localStorage keys, URL params, and pure resolvers.
 *
 * Query params (`doc`, `s`, `rate`, `voice`, `engine`) carry shareable playback
 * state for deep links. LocalStorage carries the last-set state across reloads
 * when no query param overrides it. Per-document postprocessing options live in
 * IndexedDB on the doc; `tts_postprocess` only stores the last-set defaults
 * used for new OCR jobs and for the pre-doc UI.
 */

export type TtsEngine = 'device' | 'pocket' | 'browser';

export const LS_KEYS = {
	activeDocId: 'tts_active_doc_id',
	rate: 'tts_rate',
	voice: 'tts_voice',
	voiceByEngine: 'tts_voice_by_engine',
	engine: 'tts_engine',
	postprocess: 'tts_postprocess',
	paneSplit: 'tts_pane_split'
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
	firstPageMarker?: boolean;
	firstPageNumber?: number;
}

/** Parse an `engine` URL/localStorage value; return null when absent/invalid. */
export function parseEngine(value: string | null | undefined): TtsEngine | null {
	if (value === 'pocket' || value === 'backend') return 'pocket';
	if (value === 'device' || value === 'builtin') return 'device';
	if (value === 'browser' || value === 'local') return 'browser';
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
		const out: PostprocessFlags = { combine: p.combine, uppercase: p.uppercase, punct: p.punct, pageMarkers: p.pageMarkers };
		if (typeof p.firstPageMarker === 'boolean') out.firstPageMarker = p.firstPageMarker;
		if (typeof p.firstPageNumber === 'number' && Number.isFinite(p.firstPageNumber) && p.firstPageNumber >= 1) {
			out.firstPageNumber = Math.floor(p.firstPageNumber);
		}
		return out;
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

/** Per-engine voice selection: each TTS engine remembers its own voice. */
export interface VoiceByEngine {
	device: string | null;
	pocket: string | null;
	browser: string | null;
}

/** Parse a stored per-engine voice map; return null when absent/invalid. */
export function parseVoiceByEngine(value: string | null | undefined): VoiceByEngine | null {
	if (!value) return null;
	try {
		const p = JSON.parse(value) as Partial<VoiceByEngine>;
		const device = p.device ?? null;
		const pocket = p.pocket ?? null;
		const browser = p.browser ?? null;
		if (
			(device !== null && typeof device !== 'string') ||
			(pocket !== null && typeof pocket !== 'string') ||
			(browser !== null && typeof browser !== 'string')
		) {
			return null;
		}
		return { device, pocket, browser };
	} catch {
		return null;
	}
}

/** Serialize a per-engine voice map for localStorage. */
export function serializeVoiceByEngine(map: VoiceByEngine): string {
	return JSON.stringify(map);
}

/** Read the stored voice for `engine`, falling back to `fallback`. */
export function voiceForEngine(
	map: VoiceByEngine | null | undefined,
	engine: TtsEngine,
	fallback: string
): string {
	return map?.[engine] ?? fallback;
}

/** Return a copy of `map` with `engine`'s voice set to `voiceId`. */
export function withVoiceForEngine(
	map: VoiceByEngine | null | undefined,
	engine: TtsEngine,
	voiceId: string
): VoiceByEngine {
	const next: VoiceByEngine = {
		device: map?.device ?? null,
		pocket: map?.pocket ?? null,
		browser: map?.browser ?? null
	};
	next[engine] = voiceId;
	return next;
}

/** Slugify a cloned-voice name for the shareable `?voice=` URL parameter. */
export function voiceSlug(name: string): string {
	const s = name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.replace(/-{2,}/g, '-');
	return s || 'voice';
}

/**
 * Check a candidate clone name against built-in voice names
 * (case-insensitive). Collisions are blocked with an inline warning so the
 * user picks another name — never auto-suffixed.
 */
export function isBuiltinVoiceName(
	name: string,
	builtinVoices: readonly { name: string }[]
): boolean {
	const clean = name.trim().toLowerCase();
	if (!clean) return false;
	return builtinVoices.some((v) => v.name.toLowerCase() === clean);
}

/**
 * Serialize a voice selection for the `?voice=` URL parameter: cloned voices
 * use their slugified name, everything else (built-in server voices, device
 * voices) already reads well and passes through unchanged.
 */
export function voiceUrlParam(
	voiceId: string,
	customVoices: readonly { id: string; name: string }[]
): string {
	const custom = customVoices.find((v) => v.id === voiceId);
	if (custom) return voiceSlug(custom.name);
	return voiceId;
}

export interface VoiceLookup {
	builtinVoices: readonly { name: string }[];
	customVoices: readonly { id: string; name: string }[];
}

/**
 * Resolve a `?voice=` URL parameter to a voice ID. Accepts (in order) an
 * exact custom-voice ID (back-compat with older links), an exact built-in
 * name, a slugified clone name (`?voice=my-clone`), or an exact clone name.
 * Returns `fallback` when nothing matches.
 */
export function resolveVoiceId(
	param: string | null | undefined,
	lookup: VoiceLookup,
	fallback: string
): string {
	if (!param) return fallback;
	if (lookup.customVoices.some((v) => v.id === param)) return param;
	const builtin = lookup.builtinVoices.find((v) => v.name === param);
	if (builtin) return builtin.name;
	const slug = voiceSlug(param);
	const bySlug = lookup.customVoices.find((v) => voiceSlug(v.name) === slug);
	if (bySlug) return bySlug.id;
	const lower = param.toLowerCase();
	const byName = lookup.customVoices.find((v) => v.name.toLowerCase() === lower);
	if (byName) return byName.id;
	return fallback;
}

/**
 * Return a copy of `voices` sorted alphabetically by `name`
 * (case-insensitive). Used to keep voice pickers stable with cloned voices
 * pinned in their own top optgroup.
 */
export function sortVoiceOptions<T extends { name: string }>(voices: readonly T[]): T[] {
	return [...voices].sort((a, b) =>
		a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
	);
}
