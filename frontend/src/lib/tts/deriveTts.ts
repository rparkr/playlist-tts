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
		// Stray pipes from flattened table soup (trafilatura) read as pauses.
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
/** Leading comment markers across common languages (`#`, `//`, `--`, `%`,
 * `;`, `"`, `(*`, `<!--`). Only the remainder after the marker speaks. */
const COMMENT_PREFIX_RE = /^\s*(?:#{1,3}|\/\/|--+|%%?|;;?|"|\(\*|<!--)\s*(.*?)\s*(?:\*\)|-->)?$/;

/** Extract speakable comments from a fenced code block's raw source.
 *
 * Returns the comment bodies in order, without markers. Code itself never
 * speaks. Empty when the block holds no comments. */
export function extractCodeComments(raw: string): string[] {
	const out: string[] = [];
	for (const line of raw.split('\n')) {
		if (CODE_FENCE_RE.test(line) || SHEBANG_RE.test(line)) continue;
		const m = COMMENT_PREFIX_RE.exec(line);
		if (!m) continue;
		const comment = m[1].trim();
		if (!comment || CODE_FENCE_RE.test(comment)) continue;
		out.push(comment);
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
