/** Client-side post-processing pipeline — mirrors `backend/app/services/postprocess.py`.
 *
 * Stores raw OCR Markdown in IndexedDB and re-renders offline when the user
 * changes post-processing settings. Keep logic in parity with the backend;
 * the backend remains the initial OCR source, the frontend is the re-render
 * source of truth afterwards.
 */

import { parseMarkdownStructure, type PageMapItem, type Section } from './parse';

/** User-configurable post-processing flags (snake_case to match backend JSON). */
export interface PostprocessOptions {
	combine_columns: boolean;
	normalize_uppercase: boolean;
	ensure_punctuation: boolean;
	insert_page_markers: boolean;
}

/** Default options for new documents (match backend defaults). */
export const DEFAULT_POSTPROCESS: PostprocessOptions = {
	combine_columns: true,
	normalize_uppercase: false,
	ensure_punctuation: false,
	insert_page_markers: true
};

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const CODE_FENCE_RE = /^\s*```/;
const TABLE_RE = /^\s*\|.*\|\s*$/;
const TERMINAL_RE = /[.!?…]["'\)\]]*\s*$/;
const HEADER_TERMINAL_RE = /[.!?…]["'\)\]]*\s*$/;
const UPPER_WORD_RE = /\b[A-Z]{2,}\b/;
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=[A-Z0-9"'])/;
const IMAGE_COMMENT_RE = /^\s*<!--\s*image\s*-->\s*$/i;
const HTML_COMMENT_RE = /<!--.*?-->/gs;

/** Remove Docling image placeholders and HTML comments. */
export function stripImageArtifacts(markdown: string): string {
	const lines = markdown.split('\n');
	const out: string[] = [];
	let skipNextOther = false;
	for (let line of lines) {
		const stripped = line.trim();
		if (IMAGE_COMMENT_RE.test(line)) {
			skipNextOther = true;
			continue;
		}
		if (skipNextOther && stripped === 'Other') {
			skipNextOther = false;
			continue;
		}
		if (skipNextOther && stripped !== '') skipNextOther = false;
		if (line.includes('<!--') && line.includes('-->')) {
			const cleaned = line.replace(HTML_COMMENT_RE, '').trim();
			if (!cleaned) continue;
			line = cleaned;
		}
		out.push(line);
	}
	return out.join('\n');
}

/** Return True for lines that must never be merged or mutated. */
function isSpecialBlock(line: string): boolean {
	const stripped = line.trim();
	if (!stripped) return false;
	if (CODE_FENCE_RE.test(line)) return true;
	if (stripped.startsWith('>')) return true;
	return TABLE_RE.test(line);
}

/** Check if text ends with terminal punctuation (quote-aware). */
function endsWithTerminal(text: string): boolean {
	return TERMINAL_RE.test(text.trim());
}

/** Merge trailing paragraphs where a sentence continues across column/page. */
export function reflowColumns(markdown: string): string {
	const lines = markdown.split('\n');
	const paras: string[] = [];
	let buf: string[] = [];
	let inFence = false;

	const flushBuf = () => {
		if (buf.length > 0) {
			paras.push(buf.join('\n'));
			buf = [];
		}
	};

	for (const line of lines) {
		if (CODE_FENCE_RE.test(line)) {
			inFence = !inFence;
			buf.push(line);
			if (!inFence) flushBuf();
			continue;
		}
		if (inFence) {
			buf.push(line);
			continue;
		}
		if (line.trim() === '') {
			flushBuf();
		} else if (HEADING_RE.test(line.trim()) || isSpecialBlock(line)) {
			flushBuf();
			paras.push(line);
		} else {
			buf.push(line);
		}
	}
	flushBuf();
	if (paras.length === 0) return markdown;

	const resultParas: string[] = [];
	let i = 0;
	while (i < paras.length) {
		const cur = paras[i].trim();
		const isHeader = HEADING_RE.test(cur);
		const isSpecial = isSpecialBlock(cur) || cur.includes('```');
		if (isHeader || isSpecial) {
			resultParas.push(cur);
			i += 1;
			continue;
		}

		const endsTerminal = endsWithTerminal(cur);
		const endsHyphen = cur.trimEnd().endsWith('-');
		if ((!endsTerminal || endsHyphen) && i + 1 < paras.length) {
			const nxt = paras[i + 1].trim();
			const nxtIsHeader = HEADING_RE.test(nxt);
			const nxtIsSpecial = isSpecialBlock(nxt) || nxt.includes('```');
			if (!nxtIsHeader && !nxtIsSpecial) {
				const nxtStripped = nxt.replace(/^\s+/, '');
				const first = nxtStripped[0] ?? '';
				const isLowerLetter = first >= 'a' && first <= 'z';
				const shouldMerge =
					nxtStripped.length > 0 &&
					(endsHyphen || isLowerLetter || /[0-9]/.test(first) || first === '(');
				if (shouldMerge) {
					let merged: string;
					if (endsHyphen) merged = cur.trimEnd().slice(0, -1) + nxtStripped;
					else merged = cur + ' ' + nxtStripped;
					const sentences = merged
						.split(SENTENCE_SPLIT_RE)
						.map((s) => s.trim())
						.filter(Boolean);
					if (sentences.length >= 2) {
						resultParas.push(sentences[0]);
						paras[i + 1] = sentences.slice(1).join(' ');
					} else {
						resultParas.push(merged);
						i += 2;
						continue;
					}
					i += 1;
					continue;
				}
			}
		}
		resultParas.push(cur);
		i += 1;
	}
	return resultParas.join('\n\n');
}

/** Apply `func` to each line outside fenced code blocks. */
function mapLinesOutsideFences(markdown: string, func: (line: string) => string): string {
	const lines = markdown.split('\n');
	const out: string[] = [];
	let inFence = false;
	for (const line of lines) {
		if (CODE_FENCE_RE.test(line)) {
			inFence = !inFence;
			out.push(line);
			continue;
		}
		if (inFence) {
			out.push(line);
			continue;
		}
		out.push(func(line));
	}
	return out.join('\n');
}

/** Normalize uppercase spans to Title Case for TTS. */
export function normalizeUppercase(markdown: string): string {
	const normalizeLine = (line: string): string => {
		const tokens = line.split(/(\W+)/);
		const isUpper = tokens.map((t) => UPPER_WORD_RE.test(t) && /^[A-Z]+$/.test(t));
		let i = 0;
		while (i < tokens.length) {
			if (isUpper[i]) {
				let j = i;
				while (
					j < tokens.length &&
					(isUpper[j] || (tokens[j].trim() === '' && j + 1 < tokens.length && isUpper[j + 1]))
				) {
					j += 1;
					if (j < tokens.length && tokens[j].trim() === '') {
						if (j + 1 < tokens.length && isUpper[j + 1]) {
							j += 1;
							continue;
						} else break;
					}
				}
				const runUppers = tokens.slice(i, j).filter((_, k) => isUpper[i + k]).length;
				if (runUppers >= 2) {
					for (let k = i; k < j; k++) if (isUpper[k]) tokens[k] = toTitle(tokens[k]);
				} else if (runUppers === 1) {
					for (let k = i; k < j; k++)
						if (isUpper[k] && tokens[k].length >= 5) tokens[k] = toTitle(tokens[k]);
				}
				i = j;
			} else i += 1;
		}
		return tokens.join('');
	};
	return mapLinesOutsideFences(markdown, normalizeLine);
}

/** Convert `WORD` to `Word` (match Python `str.title` for ASCII words). */
function toTitle(word: string): string {
	if (!word) return word;
	return word[0].toUpperCase() + word.slice(1).toLowerCase();
}

/** Ensure headers and paragraphs end with terminal punctuation. */
export function ensurePunctuation(markdown: string): string {
	const lines = markdown.split('\n');
	const out: string[] = [];
	let inFence = false;
	for (const line of lines) {
		if (CODE_FENCE_RE.test(line)) {
			inFence = !inFence;
			out.push(line);
			continue;
		}
		if (inFence) {
			out.push(line);
			continue;
		}
		const m = HEADING_RE.exec(line.trim());
		if (m) {
			const hashes = m[1];
			let title = m[2].trim();
			if (title && !HEADER_TERMINAL_RE.test(title) && !TABLE_RE.test(title)) title += '.';
			out.push(`${hashes} ${title}`);
		} else if (TABLE_RE.test(line) || line.trim() === '' || isSpecialBlock(line)) {
			out.push(line);
		} else {
			out.push(line);
		}
	}
	return out.join('\n');
}

/** Insert `Page N.` markers at page boundaries after sentence completion. */
export function insertPageMarkers(markdown: string, pageMap: PageMapItem[]): string {
	if (!pageMap || pageMap.length <= 1) return markdown;
	const sorted = [...pageMap].sort((a, b) => a.page - b.page);
	let result = markdown;
	const termRe = /[.!?…]["'\)\]]*(?=\s|$)/;
	let nextMarkerPos: number | null = null;

	for (const item of [...sorted.slice(0, -1)].reverse()) {
		let insertAt = Math.max(0, Math.min(item.char_end, result.length));
		const prefix = result.slice(0, insertAt);
		let newInsertAt: number;
		if (endsWithTerminal(prefix)) {
			newInsertAt = prefix.trimEnd().length;
		} else {
			const suffix = result.slice(insertAt);
			const m = termRe.exec(suffix);
			if (m && m.index !== undefined) {
				newInsertAt = insertAt + m.index + m[0].length;
			} else {
				if (
					insertAt > 0 &&
					insertAt < result.length &&
					/\w/.test(result[insertAt - 1] ?? '') &&
					/\w/.test(result[insertAt] ?? '')
				) {
					const nxtSpace = result.indexOf(' ', insertAt);
					if (nxtSpace !== -1 && nxtSpace - insertAt < 80) newInsertAt = nxtSpace + 1;
					else {
						const nxtNl = result.indexOf('\n', insertAt);
						if (nxtNl !== -1 && nxtNl - insertAt < 80) newInsertAt = nxtNl + 1;
						else newInsertAt = insertAt;
					}
				} else {
					const m2 = /[.!?…]/.exec(suffix);
					newInsertAt = m2 && m2.index !== undefined ? insertAt + m2.index + 1 : insertAt;
				}
			}
		}

		if (
			newInsertAt > 0 &&
			newInsertAt < result.length &&
			/\w/.test(result[newInsertAt - 1] ?? '') &&
			/\w/.test(result[newInsertAt] ?? '')
		) {
			const nxtSpace = result.indexOf(' ', newInsertAt);
			if (nxtSpace !== -1 && nxtSpace - newInsertAt < 80) newInsertAt = nxtSpace + 1;
		}
		newInsertAt = Math.max(0, Math.min(newInsertAt, result.length));

		if (nextMarkerPos !== null && newInsertAt >= nextMarkerPos) {
			newInsertAt = Math.max(0, Math.min(insertAt, nextMarkerPos - 1));
		}

		const nextPage = item.page + 1;
		const marker = `\n\nPage ${nextPage}.\n\n`;
		const windowStart = Math.max(0, newInsertAt - 12);
		const windowEnd = Math.min(result.length, newInsertAt + 12 + marker.length);
		if (result.slice(windowStart, windowEnd).includes(`Page ${nextPage}.`)) {
			nextMarkerPos = newInsertAt;
			continue;
		}
		result = result.slice(0, newInsertAt) + marker + result.slice(newInsertAt);
		nextMarkerPos = newInsertAt;
	}
	return result;
}

/** Estimate pageMap when accurate offsets are unavailable. */
export function buildPageMap(markdown: string, totalPages: number): PageMapItem[] {
	if (totalPages <= 1) {
		return [{ page: 1, char_start: 0, char_end: markdown.length, start_line: 1 }];
	}
	const lines = markdown.split('\n');
	const perPage = Math.max(1, Math.floor(lines.length / totalPages));
	const pageMap: PageMapItem[] = [];
	let charOffset = 0;
	for (let page = 1; page <= totalPages; page++) {
		const startLine = (page - 1) * perPage + 1;
		const endLine = page < totalPages ? perPage * page : lines.length;
		const sliceLines = lines.slice(startLine - 1, endLine);
		const sliceText = sliceLines.join('\n');
		const cs = charOffset;
		const ce = cs + sliceText.length;
		pageMap.push({ page, char_start: cs, char_end: ce, start_line: startLine });
		charOffset = ce + (page < totalPages ? 2 : 0);
	}
	return pageMap;
}

/** Apply configured post-processing and return rendered markdown, sections, pageMap. */
export function applyPostprocessing(
	rawMarkdown: string,
	opts: PostprocessOptions,
	rawPageMap?: PageMapItem[] | null
): { markdown: string; sections: Section[]; pageMap: PageMapItem[] } {
	let md = stripImageArtifacts(rawMarkdown);
	if (opts.combine_columns) md = reflowColumns(md);
	if (opts.normalize_uppercase) md = normalizeUppercase(md);
	if (opts.ensure_punctuation) md = ensurePunctuation(md);

	let sections = parseMarkdownStructure(md);
	let newMap: PageMapItem[];
	if (!rawPageMap) {
		newMap = buildPageMap(md, 1);
	} else if (opts.insert_page_markers && rawPageMap.length > 1) {
		md = insertPageMarkers(md, rawPageMap);
		newMap = buildPageMap(md, rawPageMap.length);
		sections = parseMarkdownStructure(md);
	} else {
		newMap = buildPageMap(md, rawPageMap.length);
	}
	return { markdown: md, sections, pageMap: newMap };
}
