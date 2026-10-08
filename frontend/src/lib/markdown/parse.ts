/** Markdown parsing — mirrors backend/app/services/postprocess.py */

export interface Section {
	id: number;
	titles: string[];
	level: number;
	chunks: string[];
	/** Sentence groups per paragraph. When `heading` is set, `paragraphs[0]` holds the heading sentence(s). */
	paragraphs: string[][];
	/** Own heading text for this section (the last `#` heading before its body), if any. */
	heading: string | null;
	/** Render blocks aligned with `paragraphs` (plus unspeakable blocks like
	 * code/hr with `paraIdx: null`). Absent on docs stored before the
	 * rich renderer — the viewer falls back to plain spans then. */
	blocks: BlockMeta[];
}

/** Structural block kinds for the rich renderer. */
export type BlockKind =
	| 'heading'
	| 'paragraph'
	| 'list-item'
	| 'blockquote'
	| 'table'
	| 'code'
	| 'hr';

export interface BlockMeta {
	kind: BlockKind;
	/** Raw markdown source for this block (rendered by the block renderer). */
	raw: string;
	/** Index into `Section.paragraphs`, or null for unspeakable blocks. */
	paraIdx: number | null;
	/** Heading level for `heading` blocks. */
	level?: number;
	/** True for ordered-list items (renderer groups `<ol>` runs). */
	ordered?: boolean;
}

export interface PageMapItem {
	page: number;
	char_start: number;
	char_end: number;
	start_line: number;
}

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const CODE_FENCE_RE = /^\s*```/;

function cleanForSentences(text: string): string {
	let t = text;
	t = t.replace(/```[\s\S]*?```/g, '');
	t = t.replace(/`([^`]+)`/g, '$1');
	t = t.replace(/^\s*>\s*/gm, '');
	t = t.replace(/^\s*[-*_]{3,}\s*$/gm, '');
	// Reference definitions carry no spoken text (`[label]: url` lines).
	t = t.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, '');
	// Images contribute no spoken words (alt text is renderer-only for now).
	t = t.replace(/!\[([^\]]*)\]\([^)]+\)/g, '');
	// Reference-style links keep their label.
	t = t.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
	t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
	// Real HTML tags (`<eos>`, `<div>`); kept text like `<3` or `a < b`
	// never matches (tag names start with a letter, `<` needs `>`).
	t = t.replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>])[^>]*>/g, '');
	// Paired emphasis only — lone `*`/`_` (footnote stars like `A4B*`,
	// snake_case, multiplication) stay so rendered text still matches.
	// Pairs need non-space adjacency (`* ja*` is literal text, not emphasis).
	t = t.replace(/\*\*(\S[^*\n]*?\S|\S)\*\*/g, '$1');
	t = t.replace(/(?<!\w)\*(\S[^*\n]*?\S|\S)\*(?!\w)/g, '$1');
	t = t.replace(/__(\S[^_\n]*?\S|\S)__/g, '$1');
	t = t.replace(/(?<!\w)_(\S[^_\n]*?\S|\S)_(?!\w)/g, '$1');
	t = t.replace(/~~(\S[^~\n]*?\S|\S)~~/g, '$1');
	// List markers: unordered at any indent (paragraph blocks never contain
	// `- ` lines — the splitter assigns those to items — so nested markers
	// strip safely); ordered at block start or when indented (a `2. Model`
	// plain-text heading at column 0 keeps its number, matching the render).
	t = t.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '');
	t = t.replace(/^[ \t]+[-*+]\s+\[[ xX]\]\s+/gm, '');
	t = t.replace(/^\s*[-*+]\s+/gm, '');
	t = t.replace(/^\s*\d{1,3}[.)]\s+/, '');
	t = t.replace(/^[ \t]+\d{1,3}[.)]\s+/gm, '');
	t = t.replace(/^#{1,6}\s+/gm, '');
	// Collapse internal whitespace (newlines, double spaces from stripped
	// markup) so stored sentences match rendered text exactly.
	t = t.replace(/\s+/g, ' ');
	return t.trim();
}

export function chunkTextIntoSentences(text: string): string[] {
	const clean = cleanForSentences(text);
	if (!clean) return [];
	// Primary: split on punctuation + space + capital/quote
	let parts = clean.split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/).map((s) => s.trim()).filter(Boolean);
	if (parts.length === 1) {
		parts = clean.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
	}
	return parts;
}

const LIST_ITEM_RE = /^(\s*)([-*+]|\d{1,3}[.)])(\s+|\s*$)/;
const TABLE_ROW_RE = /^\s*\|/;
const HR_RE = /^\s*([-*_]\s*){3,}\s*$/;
const BLOCKQUOTE_RE = /^\s*>/;
const INDENTED_RE = /^(?:\t| {4})/;

/** De-indent isolated indented lines (trafilatura centers titles with tabs).
 *
 * A single tab/space-indented line surrounded by blanks is a centered
 * title, not code — fully left-trim so it renders (and speaks) as prose.
 * Isolation guarantees it cannot be nested content. Multi-line runs stay
 * untouched (real indented code).
 */
export function normalizeIndentedLines(lines: string[]): string[] {
	const out = [...lines];
	let inFence = false;
	for (let i = 0; i < out.length; i++) {
		if (CODE_FENCE_RE.test(out[i])) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		if (!INDENTED_RE.test(out[i]) || out[i].trim() === '') continue;
		const prevBlank = i === 0 || out[i - 1].trim() === '';
		const nextBlank = i === out.length - 1 || out[i + 1].trim() === '';
		if (prevBlank && nextBlank) out[i] = out[i].trimStart();
	}
	return out;
}

interface RawBlock {
	kind: BlockKind;
	lines: string[];
	ordered?: boolean;
	level?: number;
}

/** Split lines into structural blocks (fence/list/table/heading aware).
 *
 * Each Markdown list item becomes its own `list-item` block so it reads as
 * its own sentence group; fenced code and `hr` carry no sentences.
 */
export function splitBlocks(lines: string[]): RawBlock[] {
	const blocks: RawBlock[] = [];
	const input = normalizeIndentedLines(lines);
	let buf: string[] = [];
	let bufKind: 'paragraph' | 'table' | 'blockquote' | null = null;
	let inFence = false;
	let fenceBuf: string[] = [];
	/** Open list item collecting continuation lines (null outside a list run). */
	let openItem: RawBlock | null = null;
	let listBaseIndent = 0;

	const flush = () => {
		if (buf.length > 0 && bufKind) {
			const text = buf.join('\n').trim();
			if (text) blocks.push({ kind: bufKind, lines: [...buf] });
		}
		buf = [];
		bufKind = null;
	};
	const closeItem = () => {
		openItem = null;
	};

	for (const line of input) {
		if (CODE_FENCE_RE.test(line)) {
			flush();
			closeItem();
			if (!inFence) {
				inFence = true;
				fenceBuf = [line];
			} else {
				inFence = false;
				fenceBuf.push(line);
				blocks.push({ kind: 'code', lines: fenceBuf });
				fenceBuf = [];
			}
			continue;
		}
		if (inFence) {
			fenceBuf.push(line);
			continue;
		}
		if (line.trim() === '') {
			flush();
			closeItem();
			continue;
		}
		const heading = HEADING_RE.exec(line.trim());
		if (heading) {
			flush();
			closeItem();
			blocks.push({ kind: 'heading', lines: [line.trim()], level: heading[1].length });
			continue;
		}
		if (HR_RE.test(line)) {
			flush();
			closeItem();
			blocks.push({ kind: 'hr', lines: [line.trim()] });
			continue;
		}
		if (TABLE_ROW_RE.test(line)) {
			closeItem();
			if (bufKind !== 'table') flush();
			bufKind = 'table';
			buf.push(line);
			continue;
		}
		const listMatch = LIST_ITEM_RE.exec(line);
		if (listMatch) {
			const ordered = /^\d/.test(listMatch[2]);
			const itemNumber = ordered ? parseInt(listMatch[2], 10) : 0;
			// CommonMark: an ordered item only interrupts a paragraph when it
			// starts with 1 (so `2.3. Encoder…` mid-paragraph stays prose).
			// Unordered markers always interrupt.
			if (bufKind === 'paragraph' && ordered && itemNumber !== 1) {
				buf.push(line);
				continue;
			}
			flush();
			const indent = listMatch[1].replace(/\t/g, '    ').length;
			if (openItem === null || indent <= listBaseIndent) {
				// New top-level item: one block per item for sentence parity.
				openItem = { kind: 'list-item', lines: [line], ordered };
				blocks.push(openItem);
				listBaseIndent = indent;
			} else {
				// Nested item / continuation belongs to the open item.
				openItem.lines.push(line);
			}
			continue;
		}
		if (openItem !== null) {
			// Indented non-item lines continue the open item; anything else
			// ends the list run. (Lazy continuations stay with the item.)
			if (/^\s/.test(line)) openItem.lines.push(line);
			else closeItem();
		}
		if (openItem !== null) continue;
		if (BLOCKQUOTE_RE.test(line)) {
			if (bufKind !== 'blockquote') flush();
			bufKind = 'blockquote';
			buf.push(line);
			continue;
		}
		if (bufKind !== 'paragraph') flush();
		bufKind = 'paragraph';
		buf.push(line);
	}
	flush();
	return blocks;
}

export function parseMarkdownStructure(mdText: string): Section[] {
	const lines = mdText.split('\n');
	const sections: Section[] = [];
	let currentLevel = 0;
	let currentLines: string[] = [];
	let pendingHeading: string | null = null;
	const headerStack: string[] = [];
	let inFence = false;

	function flushSection() {
		const hasBody = currentLines.join('').trim().length > 0;
		if (!pendingHeading && !hasBody) return;
		const paragraphs: string[][] = [];
		const blocks: BlockMeta[] = [];
		const pushSentences = (text: string): number | null => {
			const sentences = chunkTextIntoSentences(text);
			if (sentences.length === 0) return null;
			const idx = paragraphs.length;
			paragraphs.push(sentences);
			return idx;
		};
		if (pendingHeading) {
			const headingSentences = chunkTextIntoSentences(pendingHeading);
			// Keep raw title if cleaning stripped everything (e.g. symbols only)
			const sentences =
				headingSentences.length > 0
					? headingSentences
					: pendingHeading.trim()
						? [pendingHeading.trim()]
						: [];
			if (sentences.length > 0) {
				const level = currentLevel || 1;
				blocks.push({
					kind: 'heading',
					raw: `${'#'.repeat(Math.min(6, level))} ${pendingHeading.trim()}`,
					paraIdx: paragraphs.length,
					level
				});
				paragraphs.push(sentences);
			}
		}
		for (const block of splitBlocks(currentLines)) {
			const raw = block.lines.join('\n');
			if (block.kind === 'code' || block.kind === 'hr') {
				blocks.push({ kind: block.kind, raw, paraIdx: null });
				continue;
			}
			if (block.kind === 'heading') {
				// ATX headings inside the body (same-level siblings after the
				// section heading was consumed): keep them as heading blocks.
				const title = raw.replace(/^#{1,6}\s+/, '');
				const paraIdx = pushSentences(title);
				if (paraIdx !== null) {
					blocks.push({ kind: 'heading', raw, paraIdx, level: block.level ?? 2 });
				}
				continue;
			}
			// Always emit: blocks with no sentences (image-only paragraphs)
			// still render visual content, just without sentence spans.
			const paraIdx = pushSentences(raw);
			blocks.push({
				kind: block.kind,
				raw,
				paraIdx,
				...(block.kind === 'list-item' ? { ordered: block.ordered ?? false } : {})
			});
		}
		const chunks = paragraphs.flat();
		if (chunks.length === 0) {
			currentLines = [];
			pendingHeading = null;
			return;
		}
		const titles = headerStack.length > 0 ? [...headerStack] : ['Document'];
		sections.push({
			id: sections.length,
			titles,
			level: currentLevel || 1,
			chunks,
			paragraphs,
			heading: pendingHeading,
			blocks
		});
		currentLines = [];
		pendingHeading = null;
	}

	for (const line of lines) {
		if (CODE_FENCE_RE.test(line)) {
			inFence = !inFence;
			currentLines.push(line);
			continue;
		}
		if (inFence) {
			currentLines.push(line);
			continue;
		}
		const m = HEADING_RE.exec(line.trim());
		if (m) {
			flushSection();
			currentLines = [];
			const hashes = m[1];
			const title = m[2].trim();
			const level = hashes.length;
			currentLevel = level;
			if (level <= headerStack.length) {
				headerStack.splice(level - 1);
			}
			while (headerStack.length < level - 1) headerStack.push('');
			headerStack.push(title);
			// Clean empties for breadcrumb display but keep level tracking approximate
			const cleaned = headerStack.filter(Boolean);
			headerStack.length = 0;
			headerStack.push(...cleaned);
			pendingHeading = title;
		} else {
			currentLines.push(line);
		}
	}
	flushSection();
	fixFlatHeadings(sections);
	return sections;
}

/** Paragraph groups for rendering; falls back for sections stored before `paragraphs` existed. */
export function getSectionParagraphs(section: Section): string[][] {
	if (section.paragraphs && section.paragraphs.length > 0) return section.paragraphs;
	if (section.chunks.length > 0) return [section.chunks];
	return [];
}

/** True when the paragraph at `paraIdx` holds the section heading sentence(s). */
export function isHeadingParagraph(section: Section, paraIdx: number): boolean {
	return paraIdx === 0 && section.heading != null;
}

/** Map a logical `Page N.` number to its physical PDF page (1-indexed).
 *
 * `pageMap[i].page` holds the logical number for physical page `i + 1`
 * (they coincide when no first-page offset or per-page overrides apply).
 * Falls back to clamping `logical` into `[1, totalPages]` when no map
 * entry matches (e.g. markers off or skipped illustration pages).
 */
export function logicalToPhysical(
	logical: number,
	pageMap: PageMapItem[] | undefined,
	totalPages: number
): number {
	if (pageMap && pageMap.length > 0) {
		const idx = pageMap.findIndex((p) => p.page === logical);
		if (idx !== -1) return idx + 1;
	}
	const total = totalPages > 0 ? totalPages : logical;
	return Math.max(1, Math.min(logical, total));
}

/** Map a physical PDF page (1-indexed) to its logical `Page N.` number. */
export function physicalToLogical(
	physical: number,
	pageMap: PageMapItem[] | undefined
): number {
	if (pageMap && physical >= 1 && physical <= pageMap.length) {
		return pageMap[physical - 1].page ?? physical;
	}
	return physical;
}

/** Flatten sections to global sentence list */
export function getGlobalSentences(sections: Section[]): string[] {
	return sections.flatMap((s) => s.chunks);
}

/** Global sentence index of the `Page N.` marker, or -1 when absent.
 *
 * Used for exact PDF→Markdown sync: scrolling to the marker element is
 * precise regardless of how text-heavy each page is, unlike line- or
 * character-proportional estimates. Page 1 resolves like any other page
 * (new docs always carry a `Page 1.` marker; legacy docs without one fall
 * back to doc start at the call site).
 */
export function findPageMarkerIndex(sentences: string[], page: number): number {
	if (!Number.isInteger(page) || page < 1) return -1;
	const want = `Page ${page}.`;
	return sentences.findIndex((s) => s.trim() === want);
}

const PAGE_MARKER_RE = /^\s*Page (\d+)\.\s*$/;

/** Logical page number for a global sentence index (Markdown→PDF sync).
 *
 * Counts `Page N.` markers at or before `globalIdx`: page 1 until the
 * first marker, then the marker's number afterwards. Returns the marker's
 * logical number (which may differ from the physical PDF page when a
 * first-page offset or per-page overrides are used — callers map
 * logical→physical via the page map).
 */
export function findPageForSentence(sentences: string[], globalIdx: number): number {
	let page = 1;
	const end = Math.max(0, Math.min(globalIdx, sentences.length - 1));
	for (let i = 0; i <= end; i++) {
		const m = PAGE_MARKER_RE.exec(sentences[i]);
		if (m) page = parseInt(m[1], 10);
	}
	return page;
}

/** True when a heading looks like an ALL-CAPS chapter title.
 *
 * Strips non-letters; requires ≥4 letters and fully uppercase so short
 * acronyms (`NASA`) and Title Case subsections don't promote.
 */
function isChapterHeading(text: string): boolean {
	const letters = text.replace(/[^A-Za-z]/g, '');
	return letters.length >= 4 && letters === letters.toUpperCase();
}

/** Breadcrumb display form: Title Case for ALL-CAPS headings, kept otherwise.
 *
 * Mirrors backend `_display_title`: `COMMUNICATIONS.` → `Communications`
 * while `Radio Antenna Towers.` keeps its case (trailing dots stripped).
 */
function displayTitle(text: string): string {
	const clean = text.trim().replace(/\.+$/, '');
	const letters = clean.replace(/[^A-Za-z]/g, '');
	if (letters.length >= 4 && letters === letters.toUpperCase()) {
		return clean
			.toLowerCase()
			.split(/([\W_]+)/)
			.map((tok) => (/^[a-z]/.test(tok) ? tok[0].toUpperCase() + tok.slice(1) : tok))
			.join('');
	}
	return clean;
}
/** Restructure flat-heading docs (e.g. all-`h2` scans) into chapters.
 *
 * Docling often emits every heading at one level, which leaves the
 * breadcrumb's top level stuck at the first heading (`Electrical grid >
 * Radio towers` instead of `Communications > Radio towers`). When all
 * sections share one level and unique ALL-CAPS headings exist, promote
 * those to level 1 chapters and parent following subsections under the
 * most recent chapter. Repeating ALL-CAPS callouts (e.g. `KEEP AN EYE
 * OUT.` ×37) are never chapters — only headings seen once qualify.
 */
export function fixFlatHeadings(sections: Section[]): void {
	if (sections.length < 3) return;
	const levels = new Set(sections.map((s) => s.level));
	if (levels.size !== 1) return;
	const counts = new Map<string, number>();
	for (const s of sections) {
		if (!s.heading) continue;
		const key = s.heading.trim().toLowerCase();
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const chapterKeys = new Set<string>();
	for (const s of sections) {
		if (!s.heading || !isChapterHeading(s.heading)) continue;
		const key = s.heading.trim().toLowerCase();
		if ((counts.get(key) ?? 0) === 1) chapterKeys.add(key);
	}
	if (chapterKeys.size === 0) return;
	let currentChapter: string | null = null;
	for (const s of sections) {
		const key = (s.heading ?? '').trim().toLowerCase();
		if (s.heading && chapterKeys.has(key)) {
			currentChapter = displayTitle(s.heading);
			s.titles = [currentChapter];
			s.level = 1;
		} else if (currentChapter && s.heading) {
			const own = displayTitle(s.heading);
			s.titles = own.toLowerCase() === currentChapter.toLowerCase() ? [currentChapter] : [currentChapter, own];
			s.level = 2;
		} else if (currentChapter) {
			s.titles = [currentChapter, ...(s.titles.slice(-1))];
			s.level = 2;
		}
	}
}

/** Resolve which sections the reader (viewer + TTS) should use right now.
 *
 * When the Markdown draft differs from the last saved doc text there are
 * unsaved edits (or a save is still debounced) — live-parse the draft so
 * rendering and speech always agree. Otherwise reuse the stored sections.
 */
export function selectSections(
	stored: Section[] | undefined,
	savedMarkdown: string | undefined,
	draft: string
): Section[] {
	if (savedMarkdown !== undefined && draft !== savedMarkdown) {
		return parseMarkdownStructure(draft);
	}
	if (stored && stored.length > 0 && stored[0].paragraphs) return stored;
	if (stored && stored.length > 0) return parseMarkdownStructure(savedMarkdown ?? draft);
	return parseMarkdownStructure(draft);
}

export function getBreadcrumbs(sections: Section[], sectionIdx: number): string {
	const sec = sections[sectionIdx];
	if (!sec) return '';
	return sec.titles.join(' > ');
}

export function getProgressPercent(sections: Section[], globalIdx: number): number {
	const total = getGlobalSentences(sections).length;
	if (total === 0) return 0;
	return Math.round((globalIdx / total) * 100);
}

export function globalToSectionChunk(sections: Section[], globalIdx: number): { sectionIdx: number; chunkIdx: number } {
	let remaining = globalIdx;
	for (let i = 0; i < sections.length; i++) {
		if (remaining < sections[i].chunks.length) return { sectionIdx: i, chunkIdx: remaining };
		remaining -= sections[i].chunks.length;
	}
	const last = sections.length - 1;
	return { sectionIdx: Math.max(0, last), chunkIdx: Math.max(0, ((sections[last]?.chunks.length ?? 1) - 1)) };
}

export function sectionChunkToGlobal(sections: Section[], sectionIdx: number, chunkIdx: number): number {
	let g = 0;
	for (let i = 0; i < sectionIdx; i++) g += sections[i].chunks.length;
	return g + chunkIdx;
}
