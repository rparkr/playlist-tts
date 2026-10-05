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
	t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
	t = t.replace(/(\*\*|__|\*|_|~~)/g, '');
	t = t.replace(/^\s*[-*+]\s+/gm, '');
	t = t.replace(/^\s*\d+\.\s+/gm, '');
	t = t.replace(/^#{1,6}\s+/gm, '');
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

/** Split body lines into blank-line-separated paragraph blocks. */
function splitParagraphBlocks(lines: string[]): string[] {
	const blocks: string[] = [];
	let buf: string[] = [];
	const flush = () => {
		const text = buf.join('\n').trim();
		if (text) blocks.push(text);
		buf = [];
	};
	for (const line of lines) {
		if (line.trim() === '') flush();
		else buf.push(line);
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
		if (pendingHeading) {
			const headingSentences = chunkTextIntoSentences(pendingHeading);
			// Keep raw title if cleaning stripped everything (e.g. symbols only)
			if (headingSentences.length > 0) paragraphs.push(headingSentences);
			else if (pendingHeading.trim()) paragraphs.push([pendingHeading.trim()]);
		}
		for (const block of splitParagraphBlocks(currentLines)) {
			const sentences = chunkTextIntoSentences(block);
			if (sentences.length > 0) paragraphs.push(sentences);
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
			heading: pendingHeading
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
 * character-proportional estimates.
 */
export function findPageMarkerIndex(sentences: string[], page: number): number {
	if (page <= 1) return -1;
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
			currentChapter = s.heading.trim().replace(/\.+$/, '');
			s.titles = [currentChapter];
			s.level = 1;
		} else if (currentChapter && s.heading) {
			const own = s.heading.trim().replace(/\.+$/, '');
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
