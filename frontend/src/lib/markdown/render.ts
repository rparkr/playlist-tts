/** Rich Markdown rendering — `marked` + sentence-span injection.
 *
 * `parse.ts` stays the sentence authority (TTS, progress, seeking, PDF
 * sync all key off global sentence indices). This module renders each
 * structural block to HTML with `marked`, then wraps every sentence in a
 * `<span data-sentence-idx>` so highlighting, click-to-seek, auto-scroll,
 * and page-marker sync keep working on fully rendered Markdown.
 *
 * Mapping is exact by construction: spans are assigned only when the
 * block's rendered text matches its stored sentences (whitespace- and
 * entity-insensitive). Otherwise the block renders plain (tables, whose
 * pipe syntax never survives cleaning) — readable, just not clickable.
 */

import { marked } from 'marked';
import type { BlockMeta } from './parse';

export const SENTENCE_ATTR = 'data-sentence-idx';
export const SENTENCE_CLASS = 'tts-sent';

/** Collapse whitespace for text comparison (mirrors rendered spacing). */
export function normalizeRenderedText(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

/** Decode HTML entities via a non-executing element. */
function decodeEntities(s: string): string {
	const t = document.createElement('textarea');
	t.innerHTML = s;
	return t.value;
}

function normalizedSentence(s: string): string {
	return normalizeRenderedText(decodeEntities(s));
}

/** Parse an HTML string into elements via a `<template>` (no execution). */
function htmlToFragment(html: string): DocumentFragment {
	const t = document.createElement('template');
	t.innerHTML = html;
	return t.content;
}

function markdownToFragment(raw: string): DocumentFragment {
	return htmlToFragment(marked.parse(raw) as string);
}

interface TextPos {
	node: Text;
	offset: number;
}

/** Map each normalized char to its source position (whitespace-collapsed).
 *
 * Fenced code (`pre`) is unspeakable and excluded; *inline* code counts —
 * its text survives sentence cleaning, so it must survive here too.
 */
function mapNormalizedPositions(root: Element): { text: string; pos: TextPos[] } {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode: (node) => {
			const parent = (node as Text).parentElement;
			if (parent && parent.closest('pre, script, style')) return NodeFilter.FILTER_REJECT;
			return NodeFilter.FILTER_ACCEPT;
		}
	});
	let text = '';
	const pos: TextPos[] = [];
	let pendingSpace: TextPos | null = null;
	let emitted = false;
	const pushChar = (ch: string, p: TextPos) => {
		text += ch;
		pos.push(p);
		emitted = true;
	};
	let node = walker.nextNode() as Text | null;
	while (node) {
		const value = node.nodeValue ?? '';
		for (let i = 0; i < value.length; i++) {
			const ch = value[i];
			if (/\s/.test(ch)) {
				if (emitted && pendingSpace === null) pendingSpace = { node, offset: i };
			} else {
				if (pendingSpace !== null) {
					pushChar(' ', pendingSpace);
					pendingSpace = null;
				}
				pushChar(ch, { node, offset: i });
			}
		}
		node = walker.nextNode() as Text | null;
	}
	return { text, pos };
}

/** Wrap the normalized range `[start, end)` in a sentence span. */
function wrapRange(root: Element, start: number, end: number, idx: number): void {
	const { pos } = mapNormalizedPositions(root);
	if (start < 0 || end > pos.length || start >= end) return;
	const range = document.createRange();
	const from = pos[start];
	const to = pos[end - 1];
	range.setStart(from.node, from.offset);
	// End exclusive: offset after the last char (may equal node length).
	range.setEnd(to.node, to.offset + 1);
	const span = document.createElement('span');
	span.className = SENTENCE_CLASS;
	span.setAttribute(SENTENCE_ATTR, String(idx));
	span.setAttribute('tabindex', '0');
	span.setAttribute('role', 'button');
	span.appendChild(range.extractContents());
	range.insertNode(span);
}

/** Inject sentence spans into a rendered block element.
 *
 * Returns the next free global index (unchanged when the block renders
 * plain due to a text mismatch).
 */
export function injectSentences(el: Element, sentences: string[], startIdx: number): number {
	if (sentences.length === 0) return startIdx;
	// (Re)map after every wrap: extraction splits text nodes.
	const expected = normalizeRenderedText(sentences.map(normalizedSentence).join(' '));
	const actual = mapNormalizedPositions(el).text;
	if (actual !== expected) return startIdx;
	let cursor = 0;
	for (let k = 0; k < sentences.length; k++) {
		const len = normalizedSentence(sentences[k]).length;
		wrapRange(el, cursor, cursor + len, startIdx + k);
		cursor += len + 1; // single-space separator in the normalized stream
	}
	return startIdx + sentences.length;
}

function postprocessBlock(root: ParentNode): void {
	for (const a of root.querySelectorAll('a')) {
		a.setAttribute('target', '_blank');
		a.setAttribute('rel', 'noopener');
	}
	for (const box of root.querySelectorAll('input[type="checkbox"]')) {
		(box as HTMLInputElement).disabled = true;
	}
	for (const img of root.querySelectorAll('img')) {
		img.setAttribute('loading', 'lazy');
		img.setAttribute('decoding', 'async');
	}
	for (const table of root.querySelectorAll('table')) {
		const wrap = document.createElement('div');
		wrap.className = 'overflow-x-auto';
		table.replaceWith(wrap);
		wrap.appendChild(table);
	}
	// Span injection splits inline elements at sentence boundaries, leaving
	// empty husks (`<a href></a>`); prune non-void empties, keep void ones.
	const voids = new Set(['IMG', 'BR', 'HR', 'INPUT', 'SOURCE', 'TRACK', 'WBR', 'COL', 'EMBED']);
	for (const el of root.querySelectorAll('*')) {
		if (el.childNodes.length === 0 && !voids.has(el.tagName)) el.remove();
	}
}

/** Render one section's blocks to an HTML string (sanitized by the caller).
 *
 * `paragraphs` are the section's sentence groups; `startIdx` is the global
 * index of its first sentence. Returns the HTML and the next free index.
 */
export function renderSectionBlocks(
	blocks: BlockMeta[],
	paragraphs: string[][],
	startIdx: number
): { html: string; nextIdx: number } {
	const host = document.createElement('div');
	let g = startIdx;
	let i = 0;
	while (i < blocks.length) {
		const b = blocks[i];
		if (b.kind === 'list-item') {
			// Group runs of the same list flavor into one list element.
			const ordered = b.ordered ?? false;
			const run: BlockMeta[] = [];
			while (
				i < blocks.length &&
				blocks[i].kind === 'list-item' &&
				(blocks[i].ordered ?? false) === ordered
			) {
				run.push(blocks[i]);
				i++;
			}
			const frag = markdownToFragment(run.map((r) => r.raw).join('\n'));
			const list = frag.querySelector('ul, ol');
			if (list) {
				const items = list.querySelectorAll(':scope > li');
				run.forEach((rb, k) => {
					const li = items[k];
					const sents = rb.paraIdx != null ? (paragraphs[rb.paraIdx] ?? []) : [];
					if (li && sents.length > 0) g = injectSentences(li, sents, g);
					else g += sents.length;
				});
				host.appendChild(list);
			} else {
				// Fallback: render items standalone (should not happen).
				for (const rb of run) {
					const frag2 = markdownToFragment(rb.raw);
					const sents = rb.paraIdx != null ? (paragraphs[rb.paraIdx] ?? []) : [];
					const first = frag2.firstElementChild;
					if (first && sents.length > 0) g = injectSentences(first, sents, g);
					else g += sents.length;
					host.append(frag2);
				}
			}
			continue;
		}
		const frag = markdownToFragment(b.raw);
		const first = frag.firstElementChild;
		const sents = b.paraIdx != null ? (paragraphs[b.paraIdx] ?? []) : [];
		if (first && sents.length > 0 && b.kind !== 'code') {
			g = injectSentences(first, sents, g);
		} else {
			g += sents.length;
		}
		host.append(frag);
		i++;
	}
	postprocessBlock(host);
	return { html: host.innerHTML, nextIdx: g };
}
