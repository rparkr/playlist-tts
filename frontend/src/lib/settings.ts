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

/** Voice-file format a stored clone can be used with. */
export type VoiceFileFormat = 'pocket' | 'phonon';

/** Return the runtime a stored voice file belongs to; untagged is Pocket. */
export function voiceFileFormat(record: { engine?: string | null }): VoiceFileFormat {
	return record.engine === 'phonon' ? 'phonon' : 'pocket';
}

/** Voice-file format accepted by a playback engine. */
export function engineVoiceFileFormat(engine: TtsEngine): VoiceFileFormat {
	return engine === 'phonon' || engine === 'phonon-browser' ? 'phonon' : 'pocket';
}

export const LS_KEYS = {
	activeDocId: 'tts_active_doc_id',
	rate: 'tts_rate',
	voice: 'tts_voice',
	voiceByEngine: 'tts_voice_by_engine',
	engine: 'tts_engine',
	postprocess: 'tts_postprocess',
	llmOcr: 'tts_ocr_llm',
	llmOcrKey: 'tts_ocr_llm_key',
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

/** LLM OCR connection/prompt overrides. `null` means "use the server default". */
export interface LlmOcrSettings {
	baseUrl: string | null;
	model: string | null;
	systemMessage: string | null;
	userMessage: string | null;
	concurrency: number | null;
	enableThinking: boolean | null;
}

/** Fresh settings that defer every value to the backend defaults. */
export function defaultLlmOcrSettings(): LlmOcrSettings {
	return {
		baseUrl: null,
		model: null,
		systemMessage: null,
		userMessage: null,
		concurrency: null,
		enableThinking: null
	};
}

/** Parse stored LLM OCR settings; return null when absent/invalid. */
export function parseLlmOcrSettings(value: string | null | undefined): LlmOcrSettings | null {
	if (!value) return null;
	try {
		const p = JSON.parse(value) as Record<string, unknown>;
		if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
		const out = defaultLlmOcrSettings();
		for (const key of ['baseUrl', 'model', 'systemMessage', 'userMessage'] as const) {
			const v = p[key];
			if (v === undefined) continue;
			if (v !== null && typeof v !== 'string') return null;
			out[key] = v;
		}
		const concurrency = p.concurrency;
		if (concurrency !== undefined) {
			if (
				concurrency !== null &&
				(typeof concurrency !== 'number' || !Number.isFinite(concurrency) || concurrency < 0)
			) {
				return null;
			}
			out.concurrency = concurrency === null ? null : Math.floor(concurrency);
		}
		const thinking = p.enableThinking;
		if (thinking !== undefined) {
			if (thinking !== null && typeof thinking !== 'boolean') return null;
			out.enableThinking = thinking;
		}
		return out;
	} catch {
		return null;
	}
}

/** Serialize LLM OCR settings for localStorage. */
export function serializeLlmOcrSettings(settings: LlmOcrSettings): string {
	return JSON.stringify(settings);
}

/** Snake-case payload accepted by the backend's `llm` form field. */
export interface LlmOcrPayload {
	base_url?: string;
	api_key?: string;
	model?: string;
	system_message?: string;
	user_message?: string;
	concurrency?: number;
	enable_thinking?: boolean;
}

/**
 * Build the backend payload from settings, omitting values that should fall
 * back to server defaults. The API key is passed separately so it can live in
 * session storage rather than the settings object.
 */
export function buildLlmPayload(
	settings: LlmOcrSettings,
	apiKey: string | null | undefined
): LlmOcrPayload {
	const payload: LlmOcrPayload = {};
	if (settings.baseUrl?.trim()) payload.base_url = settings.baseUrl.trim();
	if (apiKey?.trim()) payload.api_key = apiKey.trim();
	if (settings.model?.trim()) payload.model = settings.model.trim();
	if (settings.systemMessage?.trim()) payload.system_message = settings.systemMessage;
	if (settings.userMessage?.trim()) payload.user_message = settings.userMessage;
	if (settings.concurrency !== null) payload.concurrency = settings.concurrency;
	if (settings.enableThinking !== null) payload.enable_thinking = settings.enableThinking;
	return payload;
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

/** Voice metadata used for grouping by language → dialect → gender. */
export interface VoiceGroupInfo {
	/** Display language, e.g. `English`. */
	language?: string | null;
	/** Display dialect, e.g. `US English` or `British English`. */
	dialect?: string | null;
	/** `female`, `male`, or absent/unknown. */
	gender?: string | null;
}

/** One rendered `<optgroup>`. */
export interface VoiceGroup<T> {
	/** Stable group identifier, also used as the option key. */
	group: string;
	/** Human-readable label, e.g. `English · US English · Female`. */
	label: string;
	voices: T[];
}

/** Primary languages first, then any others alphabetically. */
const LANGUAGE_ORDER = ['English', 'French', 'German', 'Spanish', 'Italian', 'Portuguese'];

/** Dialects in the order users expect; unknown dialects follow alphabetically. */
const DIALECT_ORDER = [
	'US English',
	'British English',
	'Australian English',
	'Canadian English',
	'Irish English',
	'New Zealand English',
	'South African English',
	'Indian English',
	'Character voices',
	'Other'
];

const LANGUAGE_NAMES: Record<string, string> = {
	en: 'English',
	fr: 'French',
	de: 'German',
	es: 'Spanish',
	it: 'Italian',
	pt: 'Portuguese',
	nl: 'Dutch',
	ja: 'Japanese',
	ko: 'Korean',
	zh: 'Chinese',
	ar: 'Arabic',
	hi: 'Hindi',
	pl: 'Polish',
	sv: 'Swedish',
	fi: 'Finnish',
	no: 'Norwegian',
	da: 'Danish',
	tr: 'Turkish'
};

/** Common BCP-47 locales → the dialect labels used by the voice catalogs. */
const LOCALE_DIALECTS: Record<string, string> = {
	'en-us': 'US English',
	'en-gb': 'British English',
	'en-au': 'Australian English',
	'en-ca': 'Canadian English',
	'en-ie': 'Irish English',
	'en-nz': 'New Zealand English',
	'en-za': 'South African English',
	'en-in': 'Indian English',
	'es-es': 'Castilian Spanish',
	'es-mx': 'Mexican Spanish',
	'es-us': 'US Spanish',
	'fr-fr': 'French (France)',
	'fr-ca': 'Canadian French',
	'de-de': 'German (Germany)',
	'de-at': 'Austrian German',
	'pt-br': 'Brazilian Portuguese',
	'pt-pt': 'European Portuguese',
	'it-it': 'Italian (Italy)',
	'nl-nl': 'Dutch (Netherlands)',
	characters: 'Character voices'
};

/**
 * Split a device voice locale (`en-US`, `fr_FR`, ...) into the same grouping
 * fields used by the server and browser voice catalogs.
 */
export function localeToVoiceGroup(locale: string | null | undefined): {
	language: string | null;
	dialect: string | null;
} {
	if (!locale) return { language: null, dialect: null };
	const normalized = locale.replace('_', '-').toLowerCase();
	if (normalized === 'characters') {
		return { language: 'English', dialect: 'Character voices' };
	}
	const [lang, region] = normalized.split('-');
	return {
		language: LANGUAGE_NAMES[lang] ?? (lang ? lang.toUpperCase() : null),
		dialect: LOCALE_DIALECTS[normalized] ?? (region ? region.toUpperCase() : null)
	};
}

function compareVoiceText(a: string | null | undefined, b: string | null | undefined): number {
	return (a ?? '').localeCompare(b ?? '', undefined, { sensitivity: 'base', numeric: true });
}

function orderRank(value: string | null | undefined, order: readonly string[]): number {
	if (!value) return order.length;
	const index = order.indexOf(value);
	return index === -1 ? order.length : index;
}

function normalizedGender(value: string | null | undefined): 'female' | 'male' | 'unknown' {
	const gender = (value ?? '').toLowerCase();
	if (gender === 'female' || gender === 'f') return 'female';
	if (gender === 'male' || gender === 'm') return 'male';
	return 'unknown';
}

function genderRank(value: string | null | undefined): number {
	const gender = normalizedGender(value);
	if (gender === 'female') return 0;
	if (gender === 'male') return 1;
	return 2;
}

function compareGroupParts(
	a: VoiceGroupInfo,
	b: VoiceGroupInfo
): number {
	const byLanguageRank =
		orderRank(a.language, LANGUAGE_ORDER) - orderRank(b.language, LANGUAGE_ORDER);
	if (byLanguageRank !== 0) return byLanguageRank;
	const byLanguage = compareVoiceText(a.language, b.language);
	if (byLanguage !== 0) return byLanguage;
	const byDialectRank = orderRank(a.dialect, DIALECT_ORDER) - orderRank(b.dialect, DIALECT_ORDER);
	if (byDialectRank !== 0) return byDialectRank;
	const byDialect = compareVoiceText(a.dialect, b.dialect);
	if (byDialect !== 0) return byDialect;
	return genderRank(a.gender) - genderRank(b.gender);
}

function groupLabel(info: VoiceGroupInfo): string {
	const gender = normalizedGender(info.gender);
	const parts = [
		info.language,
		info.dialect,
		gender === 'unknown' ? null : gender.charAt(0).toUpperCase() + gender.slice(1)
	].filter((part): part is string => Boolean(part));
	return parts.length > 0 ? parts.join(' · ') : 'Voices';
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
 * Group and sort voices by language → dialect → gender → alphabetically.
 *
 * Returns `{ group, label, voices }` objects for rendering as `<optgroup>`s.
 * When the voices carry no grouping metadata, or they all land in a single
 * group, a flat alphabetically-sorted array is returned instead.
 */
export function groupAndSortVoices<
	T extends { name: string } & VoiceGroupInfo,
>(voices: readonly T[]): VoiceGroup<T>[] | T[] {
	if (voices.length === 0) return [];

	const sorted = [...voices].sort((a, b) => {
		const byGroup = compareGroupParts(a, b);
		if (byGroup !== 0) return byGroup;
		return compareVoiceText(a.name, b.name);
	});

	const hasMetadata = voices.some((v) => Boolean(v.language || v.dialect || v.gender));
	if (!hasMetadata) return sorted;

	const groups = new Map<string, { info: VoiceGroupInfo; voices: T[] }>();
	for (const voice of sorted) {
		const info: VoiceGroupInfo = {
			language: voice.language ?? null,
			dialect: voice.dialect ?? null,
			gender: voice.gender ?? null
		};
		const key = [
			info.language ?? '',
			info.dialect ?? '',
			normalizedGender(info.gender)
		].join('::');
		let group = groups.get(key);
		if (!group) {
			group = { info, voices: [] };
			groups.set(key, group);
		}
		group.voices.push(voice);
	}

	if (groups.size <= 1) return sorted;

	return [...groups.entries()]
		.sort(([, a], [, b]) => compareGroupParts(a.info, b.info))
		.map(([group, entry]) => ({
			group,
			label: groupLabel(entry.info),
			voices: entry.voices
		}));
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
