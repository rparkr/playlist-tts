/** TTS derive layer — speakable chunks derived from parsed Markdown (#63).
 *
 * `parse.ts` stays the sentence authority for rendering and highlight sync
 * (`data-sentence-idx` numbering never changes here). This module derives a
 * second, speakable view over the same sections: one list entry per TTS
 * request, with a chunk→sentence map so highlight and seek keep working in
 * global-sentence space.
 *
 * Per-doc and in-memory only: callers re-derive on doc open and whenever the
 * live sections change (saved or debounced edits), and hand `texts` to
 * `BackendSentencePlayer`. derive is pure and synchronous — the full-book
 * perf gate (<3s on 3181 sentences) is asserted in the spec.
 *
 * Speakable transforms:
 * - URLs trim to the domain only (`https://a.b/c?d` → `a.b`).
 * - Fenced code contributes comments only (generic `#`, `//`, `--`, …).
 * - Tables become one verbalized JSON-style record per row
 *   (`Row 2 of 5: Model: Kumo, Accuracy: 91 percent`), so the engine never
 *   has to read a pipe symbol and headers repeat per row.
 * - List items stay whole (one chunk per item, not per sentence).
 * - Over-long chunks split on natural breaks (`;`, `,`, parens, …).
 */

import hljs from 'highlight.js/lib/common';
import { getGlobalSentences, type Section } from '../markdown/parse';

/** One TTS request: speakable text plus the global sentences it came from. */
export interface TtsChunk {
	/** Speakable text for a single TTS request (never blank). */
	text: string;
	/** Global sentence indices this chunk speaks. Empty only for
	 * code-comment chunks, which have no sentence spans to highlight —
	 * callers keep the current highlight for those. */
	sentenceIndices: number[];
}

/** Per-doc derived TTS view over parsed sections. */
export interface DerivedTts {
	chunks: TtsChunk[];
	/** `texts[i] === chunks[i].text` — snapshot handed to the sentence player. */
	texts: string[];
	/** `sentenceToChunk[g]` is the derived chunk speaking global sentence
	 * `g` (the first chunk when a sentence splits in two). Always covers
	 * every global sentence once `chunks` is non-empty. */
	sentenceToChunk: number[];
}

/** Longest single TTS request (chars). pocket-tts degrades past ~50 tokens,
 * so sentences beyond this split on natural breaks instead of stalling one
 * request. Generous enough that normal prose and list items stay whole. */
export const MAX_TTS_CHUNK_CHARS = 220;

const URL_RE =
	/https?:\/\/[^\s)>\]"]+|\bwww\.[^\s)>\]"]+|\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s)>\]"]*)?/gi;

/** Make a single parsed sentence speakable: trim URLs to their domain and
 * normalize punctuation the TTS model reads poorly. Idempotent. */
export function speakable(text: string): string {
	let t = text
		.replace(/[“”]/g, '"')
		.replace(/[‘’]/g, "'")
		.replace(/…/g, '...')
		.replace(/—/g, ', ')
		.replace(/–/g, ', ')
		// Stray pipes from flattened table text read as pauses.
		.replace(/\|/g, ', ');
	t = t.replace(URL_RE, (m) => {
		const host = m
			.replace(/^https?:\/\//, '')
			.split(/[/:?#]/)[0]
			.replace(/^www\./, '')
			.replace(/\.+$/, '');
		return host || 'link';
	});
	return t.replace(/\s+/g, ' ').trim();
}

/** Split an over-long speakable string on natural breaks.
 *
 * Clauses break on `;`, parenthesized asides, and spaced `,`/`:` (never
 * inside numbers like `3,14`), then greedily re-pack under `max`. Falls
 * back to word-boundary splitting when no break exists. Always returns at
 * least the trimmed input. */
export function splitLongSentence(text: string, max: number = MAX_TTS_CHUNK_CHARS): string[] {
	const t = text.trim();
	if (!t || t.length <= max) return t ? [t] : [];
	const clauses = t
		.split(/\s*;\s*|\s+—\s+|\s+–\s+|\s+[,:]\s+|\s*[()]\s*/)
		.map((s) => s.trim())
		.filter(Boolean);
	if (clauses.length <= 1) {
		const words = t.split(/\s+/);
		const out: string[] = [];
		let cur = '';
		for (const w of words) {
			const next = cur ? `${cur} ${w}` : w;
			if (next.length > max && cur) {
				out.push(cur);
				cur = w;
			} else {
				cur = next;
			}
		}
		if (cur) out.push(cur);
		return out.length > 0 ? out : [t];
	}
	const out: string[] = [];
	let cur = '';
	for (const c of clauses) {
		const next = cur ? `${cur}, ${c}` : c;
		if (next.length > max && cur) {
			out.push(cur);
			cur = c;
		} else {
			cur = next;
		}
	}
	if (cur) out.push(cur);
	return out.flatMap((o) => (o.length > max ? splitLongSentence(o, max) : [o]));
}

const CODE_FENCE_RE = /^\s*```/;
const SHEBANG_RE = /^\s*#!/;
/** `#!/usr/bin/env X` → comment-syntax key for common runtimes. */
const SHEBANG_LANG: Record<string, string> = {
	python: 'python',
	python3: 'python',
	bash: 'bash',
	sh: 'bash',
	zsh: 'bash',
	fish: 'bash',
	node: 'javascript',
	deno: 'javascript',
	bun: 'javascript',
	ruby: 'ruby',
	perl: 'perl',
	php: 'php'
};

interface CodeCommentSyntax {
	/** Whole-line and trailing comment markers (matched outside strings). */
	line: string[];
	/** Block comment delimiters (may span lines). */
	block: [open: string, close: string][];
}

const C_FAMILY: CodeCommentSyntax = { line: ['//'], block: [['/*', '*/']] };
const HASH_LINE: CodeCommentSyntax = { line: ['#'], block: [] };

/** Comment syntax by lowercase language key (canonical ids and common
 * aliases). Languages absent here contribute no comments — deterministic
 * silence beats guessing markers for an unknown grammar. */
const CODE_COMMENT_SYNTAX: Record<string, CodeCommentSyntax> = {
	python: { line: ['#'], block: [['"""', '"""'], ["'''", "'''"]] },
	py: { line: ['#'], block: [['"""', '"""'], ["'''", "'''"]] },
	javascript: C_FAMILY,
	js: C_FAMILY,
	jsx: C_FAMILY,
	typescript: C_FAMILY,
	ts: C_FAMILY,
	tsx: C_FAMILY,
	java: C_FAMILY,
	c: C_FAMILY,
	h: C_FAMILY,
	cpp: C_FAMILY,
	'c++': C_FAMILY,
	csharp: C_FAMILY,
	'c#': C_FAMILY,
	cs: C_FAMILY,
	go: C_FAMILY,
	rust: C_FAMILY,
	rs: C_FAMILY,
	swift: C_FAMILY,
	kotlin: C_FAMILY,
	kt: C_FAMILY,
	scala: C_FAMILY,
	dart: C_FAMILY,
	json: { line: ['//'], block: [['/*', '*/']] },
	php: { line: ['//', '#'], block: [['/*', '*/']] },
	bash: HASH_LINE,
	sh: HASH_LINE,
	shell: HASH_LINE,
	zsh: HASH_LINE,
	fish: HASH_LINE,
	dockerfile: HASH_LINE,
	makefile: HASH_LINE,
	mak: HASH_LINE,
	cmake: HASH_LINE,
	nginx: HASH_LINE,
	yaml: HASH_LINE,
	yml: HASH_LINE,
	toml: HASH_LINE,
	ruby: HASH_LINE,
	rb: HASH_LINE,
	perl: HASH_LINE,
	pl: HASH_LINE,
	r: HASH_LINE,
	powershell: { line: ['#'], block: [['<#', '#>']] },
	ps1: { line: ['#'], block: [['<#', '#>']] },
	sql: { line: ['--'], block: [['/*', '*/']] },
	lua: { line: ['--'], block: [['--[[', ']]']] },
	haskell: { line: ['--'], block: [['{-', '-}']] },
	ada: { line: ['--'], block: [] },
	clojure: { line: [';'], block: [] },
	lisp: { line: [';'], block: [] },
	scheme: { line: [';'], block: [] },
	elisp: { line: [';'], block: [] },
	ini: { line: [';', '#'], block: [] },
	matlab: { line: ['%'], block: [['%{', '%}']] },
	octave: { line: ['%'], block: [['%{', '%}']] },
	latex: { line: ['%'], block: [] },
	tex: { line: ['%'], block: [] },
	vim: { line: ['"'], block: [] },
	css: { line: [], block: [['/*', '*/']] },
	scss: C_FAMILY,
	html: { line: [], block: [['<!--', '-->']] },
	xml: { line: [], block: [['<!--', '-->']] },
	vue: { line: [], block: [['<!--', '-->']] },
	svelte: { line: [], block: [['<!--', '-->']] }
};

/** Candidate languages for `highlightAuto` fallback detection (filtered to
 * grammars actually registered in the bundle). */
const DETECT_SUBSET = [
	'python',
	'javascript',
	'typescript',
	'bash',
	'sql',
	'java',
	'c',
	'cpp',
	'csharp',
	'go',
	'rust',
	'swift',
	'kotlin',
	'ruby',
	'perl',
	'php',
	'yaml',
	'json',
	'css',
	'xml',
	'lua',
	'r',
	'haskell',
	'ini'
].filter((id) => hljs.getLanguage(id));

/** Resolve a fenced block's language key for comment extraction.
 *
 * Prefers the fence info string, then the shebang line, then
 * `highlightAuto` over a small candidate set (relevance floor rejects
 * prose). Returns null when the language is unknown — the block then
 * contributes no comments rather than misread code. */
export function resolveCodeLanguage(raw: string): string | null {
	const lines = raw.split('\n');
	const fence = lines.find((l) => CODE_FENCE_RE.test(l)) ?? '';
	return resolveFromParts(parseFenceInfo(fence), lines.filter((l) => !CODE_FENCE_RE.test(l)));
}

/** Info-string language from a fence line (` ```py ` → `py`), if any. */
function parseFenceInfo(fence: string): string | null {
	const info = fence
		.replace(/^\s*```+\s*/, '')
		.trim()
		.split(/\s+/)[0]
		?.toLowerCase();
	return info || null;
}

function resolveFromParts(fenceInfo: string | null, codeLines: string[]): string | null {
	if (fenceInfo && hljs.getLanguage(fenceInfo)) return fenceInfo;
	const firstCode = codeLines.find((l) => l.trim() !== '') ?? '';
	const shebang = /^\s*#!\S*\b([A-Za-z0-9+#]+)\b/.exec(firstCode)?.[1]?.toLowerCase();
	if (shebang && SHEBANG_LANG[shebang]) return SHEBANG_LANG[shebang];
	const code = codeLines.join('\n');
	if (!code.trim()) return null;
	const detected = hljs.highlightAuto(code, DETECT_SUBSET);
	if (detected.language && detected.relevance >= 3) return detected.language;
	return null;
}

/** True when a comment body carries speakable words (skips decorative
 * rules like `=====`, `-----`, `*****`). */
function isSubstantiveComment(text: string): boolean {
	return /[A-Za-z0-9]/.test(text);
}

/** Find the leftmost match of any token outside string literals.
 *
 * Tracks `'`, `"`, and backtick strings with backslash escapes so markers
 * inside strings (URLs, `#` in `"a # b"`) never count. Tokens sharing a
 * prefix must be longest-first so block opens win ties (`--[[` over `--`).
 * Returns the token and its index, or null. */
function earliestTokenOutsideStrings(
	line: string,
	tokens: string[]
): { token: string; index: number } | null {
	let quote: string | null = null;
	let i = 0;
	while (i < line.length) {
		const ch = line[i];
		if (quote !== null) {
			if (ch === '\\') i += 2;
			else {
				if (ch === quote) quote = null;
				i += 1;
			}
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') {
			quote = ch;
			i += 1;
			continue;
		}
		for (const token of tokens) {
			if (token && line.startsWith(token, i)) return { token, index: i };
		}
		i += 1;
	}
	return null;
}

/** Extract speakable comments from a fenced code block's raw source.
 *
 * Language-aware: only that language's markers count, matched outside
 * string literals, so `#private` fields in JS stay silent while `#`
 * comments in Python speak. Captures full-line, trailing, and block
 * comments in order; code itself never speaks. Empty when the language
 * is unknown or the block holds no substantive comments. */
export function extractCodeComments(raw: string): string[] {
	// Each fenced region resolves its own language (a paste can hold
	// several blocks); unfenced runs resolve together via shebang/auto.
	interface Region {
		fenceInfo: string | null;
		lines: string[];
	}
	const regions: Region[] = [];
	let cur: Region | null = null;
	let inFence = false;
	for (const line of raw.split('\n')) {
		if (CODE_FENCE_RE.test(line)) {
			if (!inFence) {
				if (cur) regions.push(cur);
				cur = { fenceInfo: parseFenceInfo(line), lines: [] };
				inFence = true;
			} else {
				if (cur) regions.push(cur);
				cur = null;
				inFence = false;
			}
			continue;
		}
		if (!cur) cur = { fenceInfo: null, lines: [] };
		cur.lines.push(line);
	}
	if (cur) regions.push(cur);
	return regions.flatMap((r) => extractFromLines(r.lines, resolveFromParts(r.fenceInfo, r.lines)));
}

/** Extract comments from de-fenced lines in a resolved language. */
function extractFromLines(lines: string[], lang: string | null): string[] {
	if (!lang) return [];
	const syntax = CODE_COMMENT_SYNTAX[lang];
	if (!syntax) return [];
	const out: string[] = [];
	const push = (body: string) => {
		// JSDoc-style continuation stars carry no words of their own.
		const clean = body.replace(/^\*\s?/, '').trim();
		if (clean && isSubstantiveComment(clean)) out.push(clean);
	};
	let blockClose: string | null = null;
	for (const line of lines) {
		if (SHEBANG_RE.test(line)) continue;
		let rest = line;
		if (blockClose !== null) {
			const closeLen = blockClose.length;
			const end = rest.indexOf(blockClose);
			if (end === -1) {
				push(rest);
				continue;
			}
			push(rest.slice(0, end));
			blockClose = null;
			rest = rest.slice(end + closeLen);
			// Fall through: code after the close may hold a trailing comment.
			if (!rest.trim()) continue;
		}
		const tokens = [...syntax.line, ...syntax.block.map(([open]) => open)].sort(
			(a, b) => b.length - a.length
		);
		if (tokens.length === 0) continue;
		const hit = earliestTokenOutsideStrings(rest, tokens);
		if (!hit) continue;
		const blockOpen = syntax.block.find(([open]) => open === hit.token);
		if (blockOpen) {
			const after = rest.slice(hit.index + hit.token.length);
			const end = after.indexOf(blockOpen[1]);
			if (end === -1) {
				push(after);
				blockClose = blockOpen[1];
			} else {
				push(after.slice(0, end));
				const tail = after.slice(end + blockOpen[1].length);
				// A line comment after the close still counts.
				const tailHit = earliestTokenOutsideStrings(tail, syntax.line);
				if (tailHit) push(tail.slice(tailHit.index + tailHit.token.length));
			}
		} else {
			push(rest.slice(hit.index + hit.token.length));
		}
	}
	return out;
}

/** Strip inline Markdown from a table cell so no syntax reaches the TTS. */
function cleanTableCell(cell: string): string {
	let t = cell;
	t = t.replace(/`([^`]+)`/g, '$1');
	t = t.replace(/!\[([^\]]*)\]\([^)]+\)/g, '');
	t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
	t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
	t = t.replace(/(?<!\w)\*(\S[^*\n]*?\S|\S)\*(?!\w)/g, '$1');
	t = t.replace(/~~([^~]+)~~/g, '$1');
	t = t.replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>])[^>]*>/g, '');
	return t.replace(/\s+/g, ' ').trim();
}

const TABLE_SEP_CELL_RE = /^:?-{1,}:?$/;

/** Convert a pipe-table's raw source to one verbalized record per data row.
 *
 * Headers repeat with every row's values (`Row 2 of 5: Model: Kumo,
 * Accuracy: 91 percent`) so rows stay intelligible out of order and the
 * engine never sees a `|`. Separator (`---`) rows never speak. Empty when
 * the block holds no data rows. */
export function tableToRowRecords(raw: string): string[] {
	const rows = raw
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.startsWith('|'))
		.map((l) =>
			l
				.replace(/^\||\|$/g, '')
				.split('|')
				.map((c) => cleanTableCell(c))
		)
		.filter((cells) => !cells.every((c) => TABLE_SEP_CELL_RE.test(c)));
	if (rows.length === 0) return [];
	const header = rows[0];
	const hasHeader = header.some((c) => c.length > 0);
	// A single non-separator row with no companions is a header-only table.
	const data = rows.length > 1 ? rows.slice(1) : [];
	if (data.length === 0) return [];
	return data
		.map((cells, i) => {
			const pairs: string[] = [];
			for (let c = 0; c < Math.max(header.length, cells.length); c++) {
				const value = (cells[c] ?? '').trim();
				if (!value) continue;
				const name = hasHeader ? (header[c] ?? '').trim() : '';
				pairs.push(name ? `${name}: ${value}` : value);
			}
			if (pairs.length === 0) return null;
			return `Row ${i + 1} of ${data.length}: ${pairs.join(', ')}`;
		})
		.filter((r): r is string => r !== null);
}

/** Resolved derived-chunk index speaking global sentence `g` (clamped). */
export function chunkForSentence(d: DerivedTts, g: number): number {
	if (d.chunks.length === 0) return 0;
	if (d.sentenceToChunk.length === 0) return 0;
	const c = d.sentenceToChunk[Math.max(0, Math.min(g, d.sentenceToChunk.length - 1))];
	return c >= 0 ? c : 0;
}

/** Derive the speakable TTS view over parsed sections.
 *
 * Walks blocks in document order so chunk order matches reading order.
 * Highlight/seek stay in global-sentence space via `sentenceIndices` (chunk
 * → sentences) and `sentenceToChunk` (sentence → first chunk). Code-comment
 * chunks carry no sentence indices — nothing highlights while they sound. */
export function deriveTts(sections: Section[]): DerivedTts {
	const total = getGlobalSentences(sections).length;
	const chunks: TtsChunk[] = [];
	const sentenceToChunk: number[] = new Array(total).fill(-1);
	let offset = 0;

	const emit = (text: string, indices: number[]): void => {
		const t = text.trim();
		if (!t) return;
		const idx = chunks.length;
		chunks.push({ text: t, sentenceIndices: indices });
		for (const g of indices) {
			if (g >= 0 && g < total && sentenceToChunk[g] === -1) sentenceToChunk[g] = idx;
		}
	};

	for (const sec of sections) {
		const paras = sec.paragraphs ?? [];
		const paraStart: number[] = [];
		let acc = 0;
		for (const p of paras) {
			paraStart.push(acc);
			acc += p.length;
		}
		for (const block of sec.blocks ?? []) {
			if (block.kind === 'hr') continue;
			if (block.kind === 'code') {
				for (const comment of extractCodeComments(block.raw)) {
					for (const piece of splitLongSentence(speakable(comment))) emit(piece, []);
				}
				continue;
			}
			if (block.kind === 'table') {
				const base = block.paraIdx != null ? offset + (paraStart[block.paraIdx] ?? 0) : -1;
				const len = block.paraIdx != null ? (paras[block.paraIdx]?.length ?? 0) : 0;
				const indices =
					base >= 0 ? Array.from({ length: len }, (_, i) => base + i) : [];
				for (const record of tableToRowRecords(block.raw)) {
					for (const piece of splitLongSentence(speakable(record))) emit(piece, indices);
				}
				continue;
			}
			if (block.paraIdx == null) continue;
			const sentences = paras[block.paraIdx] ?? [];
			const base = offset + (paraStart[block.paraIdx] ?? 0);
			if (block.kind === 'list-item') {
				// One chunk per item, however many sentences it holds.
				const joined = sentences.map(speakable).filter(Boolean).join(' ');
				const indices = sentences.map((_, i) => base + i);
				for (const piece of splitLongSentence(joined)) emit(piece, indices);
			} else {
				sentences.forEach((s, i) => {
					const spoken = speakable(s);
					if (!spoken) return;
					for (const piece of splitLongSentence(spoken)) emit(piece, [base + i]);
				});
			}
		}
		offset += sec.chunks.length;
	}

	// Sentences that spoke nothing (cleaned to empty) park on the nearest
	// emitted chunk so every global index still resolves for seek.
	if (chunks.length > 0) {
		let last = -1;
		for (let g = 0; g < total; g++) {
			if (sentenceToChunk[g] === -1) sentenceToChunk[g] = last;
			else last = sentenceToChunk[g];
		}
		const first = sentenceToChunk.find((c) => c >= 0) ?? 0;
		for (let g = 0; g < total; g++) {
			if (sentenceToChunk[g] === -1) sentenceToChunk[g] = first;
		}
	}

	return { chunks, texts: chunks.map((c) => c.text), sentenceToChunk };
}
