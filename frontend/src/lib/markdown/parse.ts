/** Markdown parsing — mirrors backend/app/services/postprocess.py */

export interface Section {
	id: number;
	titles: string[];
	level: number;
	chunks: string[];
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

export function parseMarkdownStructure(mdText: string): Section[] {
	const lines = mdText.split('\n');
	const sections: Section[] = [];
	let currentLevel = 0;
	let currentLines: string[] = [];
	const headerStack: string[] = [];
	let inFence = false;

	function flushSection() {
		if (currentLines.length === 0) return;
		const content = currentLines.join('\n').trim();
		const chunks = chunkTextIntoSentences(content);
		if (chunks.length === 0) return;
		const titles = headerStack.length > 0 ? [...headerStack] : ['Document'];
		sections.push({ id: sections.length, titles, level: currentLevel || 1, chunks });
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
		} else {
			currentLines.push(line);
		}
	}
	flushSection();
	return sections;
}

/** Flatten sections to global sentence list */
export function getGlobalSentences(sections: Section[]): string[] {
	return sections.flatMap((s) => s.chunks);
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
