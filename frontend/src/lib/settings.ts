/** Persistent reader settings: localStorage keys, URL params, and pure resolvers.
 *
 * Query params (`doc`, `s`, `rate`, `voice`, `engine`) carry shareable playback
 * state for deep links. LocalStorage carries the last-set state across reloads
 * when no query param overrides it. Per-document postprocessing options live in
 * IndexedDB on the doc; `tts_postprocess` only stores the last-set defaults
 * used for new OCR jobs and for the pre-doc UI.
 */

/** Playback engines. `phonon-browser` runs the WASM model locally; the
 * server engines are `pocket` (legacy) and `phonon` (ptts). */
export type TtsEngine = 'device' | 'pocket' | 'phonon' | 'phonon-browser';
export type ServerTtsEngine = 'pocket' | 'phonon';

export const ALL_TTS_ENGINES: readonly TtsEngine[] = [
	'device',
	'phonon',
	'phonon-browser',
	'pocket'
];

/** True when the engine is synthesized by the backend. */
export function isServerEngine(engine: TtsEngine): engine is ServerTtsEngine {
	return engine === 'pocket' || engine === 'phonon';
}

export const LS_KEYS = {
	activeDocId: 'tts_active_doc_id',
	rate: 'tts_rate',
	voice: 'tts_voice',
	voiceByEngine: 'tts_voice_by_engine',
	engine: 'tts_engine',
	postprocess: 'tts_postprocess',
	offlineFmt: 'tts_offline_fmt',
	offlineUse: 'tts_offline_use'
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
	pageMarkers: boolean;
	firstPageMarker?: boolean;
	firstPageNumber?: number;
}

/** Parse an `engine` URL/localStorage value; return null when absent/invalid. */
export function parseEngine(value: string | null | undefined): TtsEngine | null {
	if (value === 'pocket' || value === 'backend') return 'pocket';
	if (value === 'device' || value === 'builtin') return 'device';
	if (value === 'phonon' || value === 'phonon-server') return 'phonon';
	if (value === 'phonon-browser' || value === 'phonon-wasm' || value === 'wasm') {
		return 'phonon-browser';
	}
	// Retired: 'browser'/'local' (Kokoro WASM engine, removed) → null → default.
	return null;
}

/** Parse an offline-use flag (`'1'` on, `'0'` off); null when absent/invalid. */
export function parseOfflineUse(value: string | null | undefined): boolean | null {
	if (value === '1') return true;
	if (value === '0') return false;
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
			typeof p.pageMarkers !== 'boolean'
		) {
			return null;
		}
		const out: PostprocessFlags = { combine: p.combine, uppercase: p.uppercase, pageMarkers: p.pageMarkers };
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

/** Per-engine voice selection: each TTS engine remembers its own voice.
 * Partial so adding an engine never invalidates older stored payloads. */
export type VoiceByEngine = Partial<Record<TtsEngine, string | null>>;

/** Parse a stored per-engine voice map; return null when absent/invalid.
 * Retired/unknown slots in older payloads are ignored (no migration). */
export function parseVoiceByEngine(value: string | null | undefined): VoiceByEngine | null {
	if (!value) return null;
	try {
		const p = JSON.parse(value) as Record<string, unknown>;
		const out: VoiceByEngine = {};
		for (const engine of ALL_TTS_ENGINES) {
			const v = p[engine];
			if (v === undefined) continue;
			if (v !== null && typeof v !== 'string') return null;
			out[engine] = v;
		}
		return out;
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
	return { ...(map ?? {}), [engine]: voiceId };
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

/** Voice metadata used for grouping by language → accent → gender. */
export interface VoiceGroupInfo {
	gender: 'male' | 'female' | 'unknown' | null;
	accent: 'us' | 'uk' | 'castilian' | 'mexican' | 'peninsular' | 'parisian' | 'brazilian' | null;
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
 * Group and sort voices by language → accent → gender → alphabetically.
 *
 * Returns an array of { group, label, voices } objects for rendering as
 * nested optgroups in a <select>.  When there is only one group it
 * returns a flat array (same shape as ``sortVoiceOptions``).
 *
 * The ``extra`` callback lets callers annotate voices with additional
 * data (e.g. IndexedDB size) for display in option labels.
 */
export function groupAndSortVoices<
	T extends { name: string; gender?: string | null; accent?: string | null },
>(
	voices: readonly T[],
	extra?: (v: T) => string
): { group: string; label: string; voices: T[] }[] | T[] {
	if (voices.length === 0) return [];

	// Build group keys
	const groupMap = new Map<string, Map<string, T[]>>();
	let hasGrouping = false;

	for (const v of voices) {
		const lang = (v as VoiceGroupInfo).gender !== undefined || (v as VoiceGroupInfo).accent !== undefined
			? ((v as any).language ?? 'en')
			: 'pocket';

		const accent = v.accent ?? null;
		const gender = v.gender ?? 'unknown';
		const langOrder = lang === 'en' ? 0 : 1;
		const accentOrder = accent === null ? 0 : accent === 'us' ? 1 : 2;
		const genderOrder = gender === 'female' ? 0 : gender === 'male' ? 1 : 2;

		const groupKey = `${lang}::${accent ?? 'all'}::${gender}`;

		if (!groupMap.has(groupKey)) groupMap.set(groupKey, new Map());
		const genderMap = groupMap.get(groupKey)!;
		if (!genderMap.has(gender)) genderMap.set(gender, []);
		genderMap.get(gender)!.push(v);

		if (groupMap.size > 1) hasGrouping = true;
	}

	if (!hasGrouping) {
		// Single group — return flat array
		return [
			...voices
		].sort((a, b) =>
			a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
		);
	}

	// Build nested optgroups
	const groups: { group: string; label: string; voices: T[] }[] = [];
	let prevLang = '';

	for (const [key, genderMap] of groupMap) {
		const [lang, accent, genderName] = key.split('::');

		for (const [genderName, voicesList] of genderMap) {
			const sorted = voicesList.sort((a, b) =>
				a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
			);

			// Group header: show language on first occurrence, accent/gender for each
			const label = [accent, genderName]
				.filter(Boolean)
				.map(w => w.charAt(0).toUpperCase() + w.slice(1))
				.join(', ');

			groups.push({ group: lang, label, voices: sorted });
		}
	}

	return groups;
}

/**
 * Legacy: return a copy of `voices` sorted alphabetically by `name`
 * (case-insensitive). Used to keep voice pickers stable with cloned voices
 * pinned in their own top optgroup.
 */
export function sortVoiceOptions<T extends { name: string }>(voices: readonly T[]): T[] {
	return [...voices].sort((a, b) =>
		a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
	);
}
