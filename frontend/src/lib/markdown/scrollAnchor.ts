/** Scroll anchors for the viewer↔editor swap — text-identity positioning.
 *
 * Global scroll fractions drift across the swap because the rendered viewer
 * (proportional font, headings, spacing) and the editor (monospace, uniform)
 * lay the same characters out at very different heights. Anchors instead pin
 * the swap to *text*: the topmost visible unit on one side is located by
 * content on the other side, so the same words stay in view regardless of
 * fonts or styling. Every lookup degrades to a plain fraction when the text
 * cannot be found (heavy markup, empty doc).
 */

/** Collapse whitespace for content matching across view markup. */
export function collapseWs(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/** Visual columns of a source line with tab expansion. */
export function visualWidth(line: string, tabSize = 8): number {
	let w = 0;
	for (const ch of line) {
		if (ch === '\t') w += tabSize - (w % tabSize);
		else w += 1;
	}
	return w;
}

/** Visual rows a logical line occupies in a soft-wrapping mono textarea. */
export function rowsForLine(line: string, charsPerRow: number, tabSize = 8): number {
	if (charsPerRow <= 0) return 1;
	return Math.max(1, Math.ceil(visualWidth(line, tabSize) / charsPerRow));
}

/** Total visual rows above logical line `L` (0-based). */
export function rowsAbove(lines: string[], L: number, charsPerRow: number, tabSize = 8): number {
	let rows = 0;
	for (let i = 0; i < Math.max(0, Math.min(L, lines.length)); i++) {
		rows += rowsForLine(lines[i], charsPerRow, tabSize);
	}
	return rows;
}

/** Logical line index holding visual row `R` (0-based, clamped). */
export function lineForRow(lines: string[], R: number, charsPerRow: number, tabSize = 8): number {
	let rows = 0;
	for (let i = 0; i < lines.length; i++) {
		rows += rowsForLine(lines[i], charsPerRow, tabSize);
		if (rows > R) return i;
	}
	return Math.max(0, lines.length - 1);
}

/** Logical line index holding char offset `idx` (clamped). */
export function lineForCharIndex(text: string, idx: number): number {
	const clamped = Math.max(0, Math.min(idx, text.length));
	let line = 0;
	for (let i = 0; i < clamped; i++) {
		if (text[i] === '\n') line++;
	}
	return line;
}

/** Strip block + inline Markdown markers so a source line matches rendered text. */
export function stripMarkdownForMatch(line: string): string {
	let t = line.trim();
	t = t.replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d{1,3}[.)]\s+|\|\s*)/, '');
	t = t.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
	t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
	t = t.replace(/(\*\*|__|`{1,3}|~~)/g, '');
	return t;
}

/** Search snippet for a source line (collapsed, markers stripped). */
export function snippetForSourceLine(line: string, len = 64): string {
	return collapseWs(stripMarkdownForMatch(line)).slice(0, len);
}

/** Search snippet for rendered text (already markup-free). */
export function snippetForText(text: string, len = 64): string {
	return collapseWs(text).slice(0, len);
}

/** All start indices of `needle` in `haystack` (empty needle → []). */
export function allIndices(haystack: string, needle: string): number[] {
	if (!needle) return [];
	const out: number[] = [];
	let from = 0;
	for (;;) {
		const i = haystack.indexOf(needle, from);
		if (i < 0) return out;
		out.push(i);
		from = i + 1;
	}
}

/** Occurrence of `needle` nearest to `guess` (-1 when absent). */
export function nearestIndex(haystack: string, needle: string, guess: number): number {
	const hits = allIndices(haystack, needle);
	if (hits.length === 0) return -1;
	let best = hits[0];
	for (const h of hits) {
		if (Math.abs(h - guess) < Math.abs(best - guess)) best = h;
	}
	return best;
}

/** Source lines whose collapsed text contains `snippet`, nearest to `guessLine` first. */
export function candidateLines(lines: string[], snippet: string, guessLine: number): number[] {
	if (!snippet) return [];
	const hits: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (collapseWs(stripMarkdownForMatch(lines[i])).includes(snippet)) hits.push(i);
	}
	hits.sort((a, b) => Math.abs(a - guessLine) - Math.abs(b - guessLine));
	return hits;
}
