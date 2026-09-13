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
export const PAGE_BREAK_PLACEHOLDER = '<!-- page break -->';
const PAGE_BREAK_LINE_RE = /^\s*<!--\s*page\s*break\s*-->\s*$/i;
const PAGE_BREAK_INLINE_RE = /<!--\s*page\s*break\s*-->/gi;
const TERM_FORWARD_RE = /[.!?…]["'\)\]]*(?=\s|$)/;

/** Remove Docling image placeholders and HTML comments (preserving page breaks). */
export function stripImageArtifacts(markdown: string): string {
	const lines = markdown.split('\n');
	const out: string[] = [];
	let skipNextOther = false;
	for (let line of lines) {
		const stripped = line.trim();
		if (PAGE_BREAK_LINE_RE.test(line)) {
			if (skipNextOther && stripped !== '') skipNextOther = false;
			out.push(PAGE_BREAK_PLACEHOLDER);
			continue;
		}
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
			PAGE_BREAK_INLINE_RE.lastIndex = 0;
			if (PAGE_BREAK_INLINE_RE.test(line)) {
				PAGE_BREAK_INLINE_RE.lastIndex = 0;
				const m = PAGE_BREAK_INLINE_RE.exec(line);
				PAGE_BREAK_INLINE_RE.lastIndex = 0;
				if (m && m.index !== undefined) {
					const before = line.slice(0, m.index).replace(HTML_COMMENT_RE, '').trim();
					const after = line.slice(m.index + m[0].length).replace(HTML_COMMENT_RE, '').trim();
					if (before) out.push(before);
					out.push(PAGE_BREAK_PLACEHOLDER);
					if (after) out.push(after);
					continue;
				}
			}
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
	if (PAGE_BREAK_LINE_RE.test(line)) return true;
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

export function hasPageBreaks(markdown: string): boolean {
	PAGE_BREAK_INLINE_RE.lastIndex = 0;
	return PAGE_BREAK_INLINE_RE.test(markdown);
}

/** Remove previously-inserted standalone `Page N.` marker paragraphs.
 *
 * Lets re-renders that start from user-edited Markdown (which already
 * contains markers) toggle markers off cleanly and avoid duplicating them
 * when toggling back on. Only removes markers on their own paragraph.
 */
export function stripPageMarkers(markdown: string): string {
	const lines = markdown.split('\n');
	const out: string[] = [];
	for (const line of lines) {
		if (/^\s*Page \d+\.\s*$/.test(line)) continue;
		out.push(line);
	}
	return out
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

export function splitOnPageBreaks(markdown: string): string[] {
	return markdown.split(/<!--\s*page\s*break\s*-->/gi).map((p) => p.replace(/^\n+|\n+$/g, ''));
}

function firstSentenceEnd(text: string): number | null {
	const m = TERM_FORWARD_RE.exec(text);
	return m && m.index !== undefined ? m.index + m[0].length : null;
}

export function joinPagesWithMarkers(
	pages: string[],
	insertMarkers: boolean
): { markdown: string; pageMap: PageMapItem[] } {
	const nonEmpty = pages.filter((p) => p.trim());
	const effective = nonEmpty.length > 0 ? nonEmpty : pages;
	const total = effective.length;
	if (total <= 1) {
		const md = (effective[0] ?? '').trim();
		return { markdown: md, pageMap: [{ page: 1, char_start: 0, char_end: md.length, start_line: 1 }] };
	}
	if (!insertMarkers) {
		const parts: string[] = [];
		const pageMap: PageMapItem[] = [];
		let offset = 0;
		effective.forEach((page, i) => {
			const body = page.trim();
			if (i > 0) {
				parts.push('\n\n');
				offset += 2;
			}
			const cs = offset;
			parts.push(body);
			offset += body.length;
			pageMap.push({ page: i + 1, char_start: cs, char_end: offset, start_line: parts.join('').slice(0, cs).split('\n').length });
		});
		return { markdown: parts.join(''), pageMap };
	}
	const parts: string[] = [];
	const pageMap: PageMapItem[] = [];
	let offset = 0;
	const emit = (t: string) => {
		parts.push(t);
		offset += t.length;
	};
	const cur = () => parts.join('');
	emit(effective[0].trim());
	pageMap.push({ page: 1, char_start: 0, char_end: offset, start_line: 1 });
	for (let idx = 1; idx < total; idx++) {
		const nextPageNum = idx + 1;
		const remainder = effective[idx].trim();
		const prefix = cur();
		if (!remainder || endsWithTerminal(prefix)) {
			const marker = `\n\nPage ${nextPageNum}.\n\n`;
			emit(marker);
			const cs = offset;
			emit(remainder);
			pageMap.push({ page: nextPageNum, char_start: cs, char_end: offset, start_line: cur().slice(0, cs).split('\n').length });
			continue;
		}
		const end = firstSentenceEnd(remainder);
		if (end === null) {
			emit(' ' + remainder.replace(/^\s+/, ''));
			pageMap[pageMap.length - 1].char_end = offset;
			const marker = `\n\nPage ${nextPageNum}.\n\n`;
			emit(marker);
			const cs = offset;
			pageMap.push({ page: nextPageNum, char_start: cs, char_end: cs, start_line: cur().slice(0, cs).split('\n').length });
		} else {
			const firstSent = remainder.slice(0, end).trim();
			const rest = remainder.slice(end).trim();
			emit(' ' + firstSent.replace(/^\s+/, ''));
			pageMap[pageMap.length - 1].char_end = offset;
			const marker = `\n\nPage ${nextPageNum}.\n\n`;
			emit(marker);
			const cs = offset;
			if (rest) emit(rest);
			pageMap.push({ page: nextPageNum, char_start: cs, char_end: offset, start_line: cur().slice(0, cs).split('\n').length });
		}
	}
	return { markdown: cur(), pageMap };
}

/** Build pageMap, preferring Docling page-break placeholders when present. */
export function buildPageMap(markdown: string, totalPages: number): PageMapItem[] {
	const breaks = markdown.match(/<!--\s*page\s*break\s*-->/gi);
	if (breaks && breaks.length > 0) {
		const rawPages = splitOnPageBreaks(markdown);
		const pageMap: PageMapItem[] = [];
		let cursor = 0;
		for (const seg of rawPages) {
			const idx = markdown.indexOf(seg, cursor);
			const segStart = seg ? (idx === -1 ? cursor : idx) : cursor;
			const segEnd = segStart + seg.length;
			if (seg.trim()) {
				pageMap.push({
					page: pageMap.length + 1,
					char_start: segStart,
					char_end: segEnd,
					start_line: markdown.slice(0, segStart).split('\n').length
				});
			}
			const rest = markdown.slice(segEnd);
			const m = /<!--\s*page\s*break\s*-->/i.exec(rest);
			if (!m || m.index === undefined) break;
			cursor = segEnd + m.index + m[0].length;
		}
		if (pageMap.length > 0) return pageMap;
	}
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
	if (hasPageBreaks(md)) {
		const pages = splitOnPageBreaks(md);
		const processed = pages.map((page) => {
			let p = page;
			if (opts.combine_columns) p = reflowColumns(p);
			if (opts.normalize_uppercase) p = normalizeUppercase(p);
			if (opts.ensure_punctuation) p = ensurePunctuation(p);
			return p;
		});
		const joined = joinPagesWithMarkers(processed, opts.insert_page_markers);
		return { markdown: joined.markdown, sections: parseMarkdownStructure(joined.markdown), pageMap: joined.pageMap };
	}
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
