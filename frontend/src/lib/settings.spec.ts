import { describe, expect, it } from 'vitest';
import {
	parseEngine,
	parseRate,
	parseSentenceIndex,
	parsePostprocessFlags,
	serializePostprocessFlags,
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
