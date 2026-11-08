import { describe, expect, it } from 'vitest';
import {
	isBuiltinVoiceName,
	parseEngine,
	parseOfflineUse,
	parseRate,
	parseSentenceIndex,
	parsePostprocessFlags,
	parseVoiceByEngine,
	resolveVoiceId,
	serializePostprocessFlags,
	serializeVoiceByEngine,
	sortVoiceOptions,
	voiceForEngine,
	voiceSlug,
	voiceUrlParam,
	withVoiceForEngine,
	resolveWithUrlPrecedence,
	progressKey,
	groupAndSortVoices,
	localeToVoiceGroup,
	engineVoiceFileFormat,
	voiceFileFormat,
	type VoiceByEngine,
	type VoiceGroup
} from './settings';

describe('parseEngine', () => {
	it('parses canonical and legacy values', () => {
		expect(parseEngine('pocket')).toBe('pocket');
		expect(parseEngine('device')).toBe('device');
		expect(parseEngine('backend')).toBe('pocket');
		expect(parseEngine('builtin')).toBe('device');
		expect(parseEngine('phonon')).toBe('phonon');
		expect(parseEngine('phonon-server')).toBe('phonon');
		expect(parseEngine('phonon-browser')).toBe('phonon-browser');
		expect(parseEngine('wasm')).toBe('phonon-browser');
	});

	it('rejects absent/invalid values', () => {
		expect(parseEngine(null)).toBeNull();
		expect(parseEngine('')).toBeNull();
		expect(parseEngine('turbo')).toBeNull();
	});
});

describe('parseOfflineUse', () => {
	it('parses 1/0 flags and rejects the rest', () => {
		expect(parseOfflineUse('1')).toBe(true);
		expect(parseOfflineUse('0')).toBe(false);
		expect(parseOfflineUse('true')).toBeNull();
		expect(parseOfflineUse(null)).toBeNull();
		expect(parseOfflineUse(undefined)).toBeNull();
	});
});

describe('parseRate', () => {
	it('parses valid rates', () => {
		expect(parseRate('1.5')).toBe(1.5);
	});

	it('clamps to 0.5–2.0', () => {
		expect(parseRate('99')).toBe(2.0);
		expect(parseRate('0.01')).toBe(0.5);
	});

	it('rejects absent/invalid values', () => {
		expect(parseRate(null)).toBeNull();
		expect(parseRate('')).toBeNull();
		expect(parseRate('fast')).toBeNull();
	});
});

describe('resolveWithUrlPrecedence', () => {
	const identity = (v: string) => (v ? v : null);

	it('prefers the URL value over the stored value', () => {
		expect(resolveWithUrlPrecedence('url', 'stored', 'def', identity)).toBe('url');
	});

	it('falls back to the stored value when the URL is absent', () => {
		expect(resolveWithUrlPrecedence(null, 'stored', 'def', identity)).toBe('stored');
		expect(resolveWithUrlPrecedence('', 'stored', 'def', identity)).toBe('stored');
	});

	it('falls back to the default when both are absent or invalid', () => {
		expect(resolveWithUrlPrecedence(null, null, 'def', identity)).toBe('def');
		expect(resolveWithUrlPrecedence('url', 'stored', 'def', () => null)).toBe('def');
		// Invalid URL falls through to a valid stored value.
		expect(resolveWithUrlPrecedence('url', 'stored', 'def', (v) => (v === 'stored' ? v : null))).toBe(
			'stored'
		);
	});
});

describe('postprocess flags', () => {
	it('round-trips through JSON', () => {
		const flags = { combine: true, uppercase: false, pageMarkers: false };
		expect(parsePostprocessFlags(serializePostprocessFlags(flags))).toEqual(flags);
	});

	it('ignores the retired punct key from older payloads', () => {
		const legacy = '{"combine": true, "uppercase": false, "punct": true, "pageMarkers": false}';
		expect(parsePostprocessFlags(legacy)).toEqual({
			combine: true,
			uppercase: false,
			pageMarkers: false
		});
	});

	it('rejects malformed payloads', () => {
		expect(parsePostprocessFlags(null)).toBeNull();
		expect(parsePostprocessFlags('not-json')).toBeNull();
		expect(parsePostprocessFlags('{"combine": true}')).toBeNull();
	});
});

describe('progressKey', () => {
	it('scopes progress per document', () => {
		expect(progressKey('abc')).toBe('progress_abc');
	});
});

describe('parseSentenceIndex', () => {
	it('parses non-negative integers', () => {
		expect(parseSentenceIndex('12')).toBe(12);
		expect(parseSentenceIndex('-1')).toBeNull();
		expect(parseSentenceIndex('x')).toBeNull();
		expect(parseSentenceIndex(null)).toBeNull();
	});
});

describe('voice by engine', () => {
	it('round-trips through JSON', () => {
		const map = {
			device: 'Google US English',
			pocket: 'alba',
			phonon: 'Zoey',
			'phonon-browser': 'Juniper'
		};
		expect(parseVoiceByEngine(serializeVoiceByEngine(map))).toEqual(map);
	});

	it('drops the retired browser slot from older payloads (migration-free)', () => {
		expect(parseVoiceByEngine('{"device":"a","pocket":"b","browser":"c"}')).toEqual({
			device: 'a',
			pocket: 'b'
		});
	});

	it('rejects absent/invalid payloads', () => {
		expect(parseVoiceByEngine(null)).toBeNull();
		expect(parseVoiceByEngine('not-json')).toBeNull();
		expect(parseVoiceByEngine('{"device": 42}')).toBeNull();
		expect(parseVoiceByEngine('{"pocket": 42}')).toBeNull();
	});

	it('reads each engine slot with fallback', () => {
		const map = { device: 'a', pocket: 'b' };
		expect(voiceForEngine(map, 'device', 'fb')).toBe('a');
		expect(voiceForEngine(map, 'pocket', 'fb')).toBe('b');
		expect(voiceForEngine({ device: null, pocket: null }, 'pocket', 'fb')).toBe('fb');
		expect(voiceForEngine({ phonon: 'Zoey' }, 'phonon', 'fb')).toBe('Zoey');
		expect(voiceForEngine(null, 'device', 'fb')).toBe('fb');
	});

	it('sets one slot without touching the others', () => {
		const next = withVoiceForEngine({ device: 'a', pocket: null }, 'pocket', 'c');
		expect(next).toEqual({ device: 'a', pocket: 'c' });
	});

	it('keeps separate selections across engine toggles', () => {
		// Simulate: pick device voice, toggle to pocket (carries over), pick a
		// pocket voice, toggle back — the device voice is restored.
		let map: VoiceByEngine = { device: null, pocket: null };
		map = withVoiceForEngine(map, 'device', 'Google US English');
		let current = voiceForEngine(map, 'device', 'alba');
		// toggle to pocket (no stored pocket voice yet → carries current over)
		const pocketFirst = voiceForEngine(map, 'pocket', current);
		map = withVoiceForEngine(map, 'pocket', pocketFirst);
		// user picks a pocket voice
		current = 'my-clone';
		map = withVoiceForEngine(map, 'pocket', current);
		// toggle back to device → original device voice restored
		expect(voiceForEngine(map, 'device', current)).toBe('Google US English');
	});
});

describe('sortVoiceOptions', () => {
	it('sorts alphabetically, case-insensitive, without mutating the input', () => {
		const input = [{ name: 'Zara' }, { name: 'alba' }, { name: 'Mara' }];
		const sorted = sortVoiceOptions(input);
		expect(sorted.map((v) => v.name)).toEqual(['alba', 'Mara', 'Zara']);
		expect(input.map((v) => v.name)).toEqual(['Zara', 'alba', 'Mara']);
	});

	it('returns an empty array for empty input', () => {
		expect(sortVoiceOptions([])).toEqual([]);
	});
});

describe('voice URL names', () => {
	const lookup = {
		builtinVoices: [{ name: 'alba' }, { name: 'mara' }],
		customVoices: [
			{ id: 'voice_abc', name: 'My Clone Voice' },
			{ id: 'voice_xyz', name: 'Norah' }
		]
	};

	it('slugifies clone names for URLs', () => {
		expect(voiceSlug('My Clone Voice')).toBe('my-clone-voice');
		expect(voiceSlug('  Héllo—World!  ')).toBe('hello-world');
		expect(voiceSlug('')).toBe('voice');
	});

	it('serializes clones by slug and passes other voices through', () => {
		expect(voiceUrlParam('voice_abc', lookup.customVoices)).toBe('my-clone-voice');
		expect(voiceUrlParam('alba', lookup.customVoices)).toBe('alba');
		expect(voiceUrlParam('Google US English', lookup.customVoices)).toBe('Google US English');
	});

	it('resolves slugs, names, IDs, and builtins back to IDs', () => {
		expect(resolveVoiceId('my-clone-voice', lookup, 'fb')).toBe('voice_abc');
		expect(resolveVoiceId('My Clone Voice', lookup, 'fb')).toBe('voice_abc');
		expect(resolveVoiceId('voice_xyz', lookup, 'fb')).toBe('voice_xyz');
		expect(resolveVoiceId('mara', lookup, 'fb')).toBe('mara');
	});

	it('falls back when the parameter matches nothing', () => {
		expect(resolveVoiceId('no-such-voice', lookup, 'fb')).toBe('fb');
		expect(resolveVoiceId(null, lookup, 'fb')).toBe('fb');
		expect(resolveVoiceId('', lookup, 'fb')).toBe('fb');
	});

	it('detects built-in name collisions case-insensitively', () => {
		expect(isBuiltinVoiceName('Alba', lookup.builtinVoices)).toBe(true);
		expect(isBuiltinVoiceName('  MARA  ', lookup.builtinVoices)).toBe(true);
		expect(isBuiltinVoiceName('My Clone Voice', lookup.builtinVoices)).toBe(false);
		expect(isBuiltinVoiceName('', lookup.builtinVoices)).toBe(false);
	});
});

describe('voice grouping', () => {
	it('maps device locales to language and dialect labels', () => {
		expect(localeToVoiceGroup('en-US')).toEqual({
			language: 'English',
			dialect: 'US English'
		});
		expect(localeToVoiceGroup('en_GB')).toEqual({
			language: 'English',
			dialect: 'British English'
		});
		expect(localeToVoiceGroup('fr-FR')).toEqual({
			language: 'French',
			dialect: 'French (France)'
		});
		expect(localeToVoiceGroup('characters')).toEqual({
			language: 'English',
			dialect: 'Character voices'
		});
		expect(localeToVoiceGroup(null)).toEqual({ language: null, dialect: null });
	});

	it('groups and sorts language → dialect → gender → name', () => {
		const voices = [
			{ name: 'Zed', language: 'English', dialect: 'British English', gender: 'male' },
			{ name: 'Amy', language: 'English', dialect: 'US English', gender: 'female' },
			{ name: 'Bob', language: 'English', dialect: 'US English', gender: 'male' },
			{ name: 'Cat', language: 'English', dialect: 'British English', gender: 'female' },
			{ name: 'Ada', language: 'French', dialect: 'French (France)', gender: 'female' }
		];
		const groups = groupAndSortVoices(voices) as VoiceGroup<(typeof voices)[number]>[];
		expect(groups.map((group) => group.label)).toEqual([
			'English · US English · Female',
			'English · US English · Male',
			'English · British English · Female',
			'English · British English · Male',
			'French · French (France) · Female'
		]);
		expect(groups[0].voices.map((voice) => voice.name)).toEqual(['Amy']);
		expect(groups[2].voices.map((voice) => voice.name)).toEqual(['Cat']);
	});

	it('returns a flat alphabetical list when no metadata is present', () => {
		const voices = [{ name: 'zeta' }, { name: 'Alpha' }, { name: 'beta' }];
		const flat = groupAndSortVoices(voices) as typeof voices;
		expect(flat.map((voice) => voice.name)).toEqual(['Alpha', 'beta', 'zeta']);
	});

	it('does not group a single metadata bucket', () => {
		const voices = [
			{ name: 'Zed', language: 'English', dialect: 'US English', gender: 'female' },
			{ name: 'Amy', language: 'English', dialect: 'US English', gender: 'female' }
		];
		const flat = groupAndSortVoices(voices) as typeof voices;
		expect(flat.map((voice) => voice.name)).toEqual(['Amy', 'Zed']);
	});

	it('tags legacy voice records as Pocket files', () => {
		expect(voiceFileFormat({})).toBe('pocket');
		expect(voiceFileFormat({ engine: 'pocket' })).toBe('pocket');
		expect(voiceFileFormat({ engine: 'phonon' })).toBe('phonon');
		expect(engineVoiceFileFormat('phonon')).toBe('phonon');
		expect(engineVoiceFileFormat('phonon-browser')).toBe('phonon');
		expect(engineVoiceFileFormat('pocket')).toBe('pocket');
		expect(engineVoiceFileFormat('device')).toBe('pocket');
	});
});
