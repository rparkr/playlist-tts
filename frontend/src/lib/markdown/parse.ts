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

/** Flatten sections to global sentence list */
export function getGlobalSentences(sections: Section[]): string[] {
	return sections.flatMap((s) => s.chunks);
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
