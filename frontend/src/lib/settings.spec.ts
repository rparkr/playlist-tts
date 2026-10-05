import { describe, expect, it } from 'vitest';
import {
	parseEngine,
	parseRate,
	parseSentenceIndex,
	parsePostprocessFlags,
	serializePostprocessFlags,
	parseVoiceByEngine,
	serializeVoiceByEngine,
	sortVoiceOptions,
	voiceForEngine,
	withVoiceForEngine,
	resolveWithUrlPrecedence,
	progressKey
} from './settings';

describe('parseEngine', () => {
	it('parses canonical and legacy values', () => {
		expect(parseEngine('pocket')).toBe('pocket');
		expect(parseEngine('device')).toBe('device');
		expect(parseEngine('backend')).toBe('pocket');
		expect(parseEngine('builtin')).toBe('device');
	});

	it('rejects absent/invalid values', () => {
		expect(parseEngine(null)).toBeNull();
		expect(parseEngine('')).toBeNull();
		expect(parseEngine('turbo')).toBeNull();
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
		const flags = { combine: true, uppercase: false, punct: true, pageMarkers: false };
		expect(parsePostprocessFlags(serializePostprocessFlags(flags))).toEqual(flags);
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
		const map = { device: 'Google US English', pocket: 'alba' };
		expect(parseVoiceByEngine(serializeVoiceByEngine(map))).toEqual(map);
	});

	it('rejects absent/invalid payloads', () => {
		expect(parseVoiceByEngine(null)).toBeNull();
		expect(parseVoiceByEngine('not-json')).toBeNull();
		expect(parseVoiceByEngine('{"device": 42}')).toBeNull();
	});

	it('reads each engine slot with fallback', () => {
		const map = { device: 'a', pocket: 'b' };
		expect(voiceForEngine(map, 'device', 'fb')).toBe('a');
		expect(voiceForEngine(map, 'pocket', 'fb')).toBe('b');
		expect(voiceForEngine({ device: null, pocket: null }, 'pocket', 'fb')).toBe('fb');
		expect(voiceForEngine(null, 'device', 'fb')).toBe('fb');
	});

	it('sets one slot without touching the other', () => {
		const next = withVoiceForEngine({ device: 'a', pocket: 'b' }, 'pocket', 'c');
		expect(next).toEqual({ device: 'a', pocket: 'c' });
	});

	it('keeps separate selections across engine toggles', () => {
		// Simulate: pick device voice, toggle to pocket (carries over), pick a
		// pocket voice, toggle back — the device voice is restored.
		let map = { device: null as string | null, pocket: null as string | null };
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
