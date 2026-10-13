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

/** Line-start char offsets for `lines` (as joined by `\n`). */
export function lineStartOffsets(lines: string[]): number[] {
	const out: number[] = [];
	let acc = 0;
	for (const line of lines) {
		out.push(acc);
		acc += line.length + 1;
	}
	return out;
}

/** Exact logical-line layout via an off-screen mirror of a soft-wrap textarea.
 *
 * Font arithmetic (canvas `measureText` over fallback stacks) drifts a row or
 * two per hundred lines — pages off in a book. The browser already lays the
 * text out; a hidden mirror with identical width/font/wrap exposes each
 * logical line's true pixel top through `Range` caret rects. Build per
 * viewer↔editor swap (not per keystroke) and `dispose()` after.
 */
export interface LineMirror {
	/** Pixel top of logical line `L` (clamped) relative to the text start. */
	topOfLine(L: number): number;
	/** Logical line holding `scrollTop` pixels (clamped). */
	lineAtScroll(scrollTop: number): number;
	/** Remove the mirror from the document. */
	dispose(): void;
}

export function createLineMirror(
	textarea: HTMLTextAreaElement,
	lines: string[]
): LineMirror | null {
	try {
		const style = getComputedStyle(textarea);
		const lineHeight = parseFloat(style.lineHeight);
		if (!Number.isFinite(lineHeight) || lineHeight <= 0) return null;
		const padL = parseFloat(style.paddingLeft) || 0;
		const padR = parseFloat(style.paddingRight) || 0;
		const contentWidth = textarea.clientWidth - padL - padR;
		if (!Number.isFinite(contentWidth) || contentWidth <= 0) return null;
		const mirror = document.createElement('div');
		mirror.setAttribute('aria-hidden', 'true');
		mirror.style.cssText =
			'position:fixed;left:-99999px;top:0;visibility:hidden;pointer-events:none;' +
			`width:${contentWidth}px;font:${style.font};line-height:${style.lineHeight};` +
			`white-space:${style.whiteSpace};word-break:${style.wordBreak};` +
			`overflow-wrap:${style.overflowWrap};letter-spacing:${style.letterSpacing};` +
			`tab-size:${style.tabSize};padding:0;border:0;margin:0;`;
		mirror.textContent = lines.join('\n');
		document.body.appendChild(mirror);
		const node = mirror.firstChild;
		const starts = lineStartOffsets(lines);
		const range = document.createRange();
		// Raw caret tops; blank lines yield no rects (holes), so backfill
		// from the next known top — an empty pre-wrap line is one row.
		const raw: number[] = new Array(lines.length).fill(-1);
		if (node) {
			const textLen = (node.textContent ?? '').length;
			const mTop = mirror.getBoundingClientRect().top;
			for (let i = 0; i < lines.length; i++) {
				range.setStart(node, Math.min(starts[i], textLen));
				range.collapse(true);
				const rects = range.getClientRects();
				if (rects.length > 0) raw[i] = rects[0].top - mTop;
			}
		}
		const bottom = mirror.scrollHeight;
		for (let i = lines.length - 1; i >= 0; i--) {
			if (raw[i] < 0) raw[i] = (i + 1 < lines.length ? raw[i + 1] : bottom) - lineHeight;
		}
		const topOfLine = (L: number): number => raw[Math.max(0, Math.min(L, raw.length - 1))] ?? 0;
		return {
			topOfLine,
			lineAtScroll(scrollTop: number): number {
				const s = Math.max(0, scrollTop);
				let lo = 0;
				let hi = lines.length - 1;
				while (lo < hi) {
					const mid = Math.floor((lo + hi + 1) / 2);
					if (topOfLine(mid) <= s + 0.5) lo = mid;
					else hi = mid - 1;
				}
				return lo;
			},
			dispose() {
				mirror.remove();
			}
		};
	} catch {
		return null;
	}
}
