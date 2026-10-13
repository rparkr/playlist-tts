<script lang="ts">
	import { tick } from 'svelte';
	import DOMPurify from 'dompurify';
	import { Pencil, Check, X, Settings, EllipsisVertical } from 'lucide-svelte';
	import type { Section } from '$lib/markdown/parse';
	import {
		getGlobalSentences,
		getSectionParagraphs,
		isHeadingParagraph
	} from '$lib/markdown/parse';
	import {
		SENTENCE_ATTR,
		renderSectionBlocks
	} from '$lib/markdown/render';
	import {
		candidateLines,
		collapseWs,
		lineForRow,
		rowsAbove,
		snippetForSourceLine,
		snippetForText
	} from '$lib/markdown/scrollAnchor';
	import { getDocAsset } from '$lib/stores/library';

	interface Props {
		markdownDraft: string;
		sections: Section[];
		globalIdx: number;
		isEditing: boolean;
		editorEl: HTMLTextAreaElement | null;
		onDraftChange: (v: string) => void;
		onEditToggle: () => void;
		onEditSave: () => void;
		onEditCancel: () => void;
		onOpenPostprocess: () => void;
		onDownloadMd: () => void;
		onSaveAudio: () => void;
		hasActiveDoc: boolean;
		/** Owning doc id for resolving relative ePub image refs (null skips). */
		assetDocId?: string | null;
		onSentenceClick?: (idx: number) => void;
	}

	let {
		markdownDraft,
		sections,
		globalIdx,
		isEditing,
		editorEl = $bindable(),
		onDraftChange,
		onEditToggle,
		onEditSave,
		onEditCancel,
		onOpenPostprocess,
		onDownloadMd,
		onSaveAudio,
		hasActiveDoc,
		assetDocId = null,
		onSentenceClick
	}: Props = $props();

	let viewerEl: HTMLDivElement | null = $state(null);

	export function getViewerEl(): HTMLDivElement | null {
		return viewerEl;
	}

	let showOverflow = $state(false);

	let totalSentences = $derived(getGlobalSentences(sections).length);

	// Rich rendering (#57): sections parsed with block structure render
	// through `marked` with sentence spans injected; legacy docs stored
	// before blocks existed keep the plain-span path below.
	let useRich = $derived(
		sections.length > 0 && sections.every((s) => (s.blocks?.length ?? 0) > 0)
	);

	let richHtml: string = $derived.by(() => {
		if (!useRich) return '';
		// Prerender/SSR has no DOM; content only appears post-mount anyway.
		if (typeof document === 'undefined' || typeof window === 'undefined') return '';
		let html = '';
		let g = 0;
		for (const sec of sections) {
			const out = renderSectionBlocks(sec.blocks, getSectionParagraphs(sec), g);
			html += out.html;
			g = out.nextIdx;
		}
		return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] });
	});

	const ACTIVE_CLASS = 'tts-active';

	function syncActiveHighlight(idx: number) {
		const viewer = viewerEl;
		if (!viewer) return;
		for (const el of viewer.querySelectorAll(`.${ACTIVE_CLASS}`)) {
			el.classList.remove(ACTIVE_CLASS);
		}
		if (idx < 0) return;
		for (const el of viewer.querySelectorAll(`[${SENTENCE_ATTR}="${idx}"]`)) {
			el.classList.add(ACTIVE_CLASS);
		}
	}

	function handleRichClick(e: MouseEvent) {
		const t = e.target as HTMLElement;
		// Real links open normally; never seek from them.
		if (t.closest('a')) return;
		if (t.closest('button, input, select, textarea')) return;
		const sp = t.closest(`[${SENTENCE_ATTR}]`);
		if (sp) onSentenceClick?.(Number(sp.getAttribute(SENTENCE_ATTR)));
	}

	function handleRichKey(e: KeyboardEvent) {
		if (e.key !== 'Enter' && e.key !== ' ') return;
		const t = e.target as HTMLElement;
		if (t.closest('a')) return;
		const sp = t.closest(`[${SENTENCE_ATTR}]`);
		if (sp) {
			e.preventDefault();
			onSentenceClick?.(Number(sp.getAttribute(SENTENCE_ATTR)));
		}
	}

	/** Delegated click/key handling for injected spans (an action, so the
	 * static container carries no inline handlers for a11y). */
	function richInteractions(node: HTMLElement) {
		const click = (e: MouseEvent) => handleRichClick(e);
		const key = (e: KeyboardEvent) => handleRichKey(e);
		node.addEventListener('click', click);
		node.addEventListener('keydown', key);
		return {
			destroy() {
				node.removeEventListener('click', click);
				node.removeEventListener('keydown', key);
			}
		};
	}

	// Blob-URL cache for ePub image assets (one entry per doc + path).
	const assetUrlCache = new Map<string, string>();

	async function assetUrl(docId: string, path: string): Promise<string | null> {
		const key = `${docId}::${path}`;
		const hit = assetUrlCache.get(key);
		if (hit) return hit;
		const rec = await getDocAsset(docId, path);
		if (!rec) return null;
		const url = URL.createObjectURL(rec.blob);
		assetUrlCache.set(key, url);
		return url;
	}

	/** Resolve relative `<img src>` refs (ePub assets) to cached blob URLs.
	 *
	 * Absolute http(s)/blob/data/srcs (article images) pass through. A
	 * `MutationObserver` re-resolves after `{@html}` swaps (edit saves),
	 * guarded by a per-element flag so sentence spans churn stays cheap. */
	function resolveAssetImages(node: HTMLElement, docId: string | null) {
		let current = docId;
		let cancelled = false;
		async function run(id: string) {
			for (const img of node.querySelectorAll('img')) {
				if (cancelled) return;
				const el = img as HTMLImageElement;
				if (el.dataset.assetResolved) continue;
				const src = el.getAttribute('src') ?? '';
				if (!src || /^(https?:|blob:|data:|#)/i.test(src) || src.startsWith('/')) continue;
				el.dataset.assetResolved = 'pending';
				const url = await assetUrl(id, src);
				if (cancelled) return;
				if (url) el.src = url;
				else delete el.dataset.assetResolved;
			}
		}
		const mo = new MutationObserver(() => {
			if (current) void run(current);
		});
		mo.observe(node, { childList: true, subtree: true });
		if (current) void run(current);
		return {
			update(next: string | null) {
				current = next;
				if (next) void run(next);
			},
			destroy() {
				cancelled = true;
				mo.disconnect();
			}
		};
	}

	function isActive(sentIdx: number): boolean {
		return sentIdx === globalIdx;
	}

	function sentenceClass(active: boolean): string {
		return `rounded px-0.5 transition-colors scroll-mt-2 ${active ? 'bg-sky-500/20 ring-1 ring-sky-500/30 text-sky-100' : 'hover:bg-slate-700/40 cursor-pointer'}`;
	}

	interface RenderSentence {
		text: string;
		globalIdx: number;
	}
	interface RenderParagraph {
		paraIdx: number;
		isHeading: boolean;
		isLegacyBreadcrumb: boolean;
		sentences: RenderSentence[];
	}
	interface RenderSection {
		section: Section;
		paragraphs: RenderParagraph[];
	}

	// Build render model preserving paragraph breaks; headings render as
	// clickable heading elements so they stay in the TTS sentence flow.
	let renderSections: RenderSection[] = $derived.by(() => {
		const out: RenderSection[] = [];
		let g = 0;
		for (const sec of sections) {
			const isLegacy = sec.paragraphs == null;
			const paras = getSectionParagraphs(sec);
			const flatLen = paras.flat().length;
			const useParas: string[][] = !isLegacy && flatLen === sec.chunks.length ? paras : sec.chunks.length ? [sec.chunks] : [];
			let local = 0;
			const paragraphs: RenderParagraph[] = useParas.map((para, pi) => {
				const sentences = para.map((text, si) => ({ text, globalIdx: g + local + si }));
				local += para.length;
				return {
					paraIdx: pi,
					isHeading: !isLegacy && isHeadingParagraph(sec, pi),
					isLegacyBreadcrumb: false,
					sentences
				};
			});
			// Legacy docs (stored before headings/paragraphs): keep breadcrumb heading.
			if (isLegacy && sec.titles.length && sec.titles[0] !== 'Document' && paragraphs.length > 0) {
				paragraphs[0].isLegacyBreadcrumb = true;
			}
			out.push({ section: sec, paragraphs });
			g += sec.chunks.length;
		}
		return out;
	});

	// Keep the active sentence in view during playback and slider seeks.
	// The view stays put while the active sentence is visible; once it moves
	// off-page, scroll so it lands at the top of the viewer. Also syncs the
	// rich-renderer highlight (injected spans are plain DOM, not Svelte).
	// Exiting edit mode suppresses the scroll exactly once (see below): the
	// transition effect restores the editor's position, and a smooth
	// follow-scroll queued in the same flush would otherwise drag the view
	// back to the active sentence.
	let suppressFollowOnce = false;
	$effect(() => {
		const idx = globalIdx;
		const viewer = viewerEl;
		if (isEditing || !viewer || totalSentences === 0) {
			// Never leak a stale suppression into later follow-scrolls when
			// the exit-triggered run bails before consuming it.
			if (!isEditing) suppressFollowOnce = false;
			return;
		}
		// Depend on the rendered output so fresh nodes get highlighted.
		// Read only on the viewing path: while editing these recompute a
		// ~1s full-book render (marked + sanitize) per keystroke that the
		// unmounted viewer never reads.
		void richHtml;
		void useRich;
		syncActiveHighlight(idx);
		if (suppressFollowOnce) {
			suppressFollowOnce = false;
			return;
		}
		requestAnimationFrame(() => {
			const el = viewer.querySelector(`[${SENTENCE_ATTR}="${idx}"]`) as HTMLElement | null;
			if (!el) return;
			const viewerRect = viewer.getBoundingClientRect();
			const elRect = el.getBoundingClientRect();
			const fullyVisible = elRect.top >= viewerRect.top && elRect.bottom <= viewerRect.bottom;
			if (fullyVisible) return;
			const top = viewer.scrollTop + (elRect.top - viewerRect.top) - 16;
			viewer.scrollTo({ top, behavior: 'smooth' });
		});
	});

	// Preserve scroll across the viewer↔editor swap by text identity: the
	// topmost visible unit on one side is located by content on the other,
	// so the same words stay in view despite different fonts and layouts.
	// Capture must happen pre-swap (the parent calls `prepareEditSwap`
	// before flipping `isEditing`). A plain scroll fraction is kept as the
	// fallback whenever the anchor text cannot be found. The transition
	// effect below applies the captured anchor post-swap.
	interface EditAnchor {
		/** Target editor logical line + in-view offset (entering; the editor
		 * mounts only post-swap, so metrics resolve in the effect). */
		editorLine?: number;
		editorDelta?: number;
		/** Snippet to locate in the viewer (exiting) with its in-view offset. */
		viewerSnippet?: string;
		viewerDelta?: number;
	}
	let pendingAnchor: EditAnchor | null = null;
	let pendingFraction: number | null = null;
	let editorMinHeight: string | null = $state(null);

	/** Mono editor metrics for exact logical-line math under soft wrap. */
	function measureEditor(
		editor: HTMLTextAreaElement
	): { lineHeight: number; charsPerRow: number } | null {
		const style = getComputedStyle(editor);
		const lineHeight = parseFloat(style.lineHeight);
		if (!Number.isFinite(lineHeight) || lineHeight <= 0) return null;
		const font = `${style.fontStyle} ${style.fontVariant} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
		let charWidth = 0;
		try {
			const canvas = document.createElement('canvas');
			const ctx = canvas.getContext('2d');
			if (!ctx) return null;
			ctx.font = font;
			charWidth = ctx.measureText('MMMMMMMMMM').width / 10;
		} catch {
			return null;
		}
		if (!Number.isFinite(charWidth) || charWidth <= 0) return null;
		return { lineHeight, charsPerRow: Math.max(16, Math.floor(editor.clientWidth / charWidth)) };
	}

	/** Topmost visible sentence span in the viewer (O(1) hit-test + scan fallback). */
	function topVisibleSentence(viewer: HTMLElement): HTMLElement | null {
		const rect = viewer.getBoundingClientRect();
		try {
			const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 3);
			const span = hit?.closest?.(`[${SENTENCE_ATTR}]`) as HTMLElement | null;
			if (span && viewer.contains(span)) return span;
		} catch {
			// fall through to the scan
		}
		const spans = viewer.querySelectorAll(`[${SENTENCE_ATTR}]`);
		for (const el of spans) {
			const r = (el as HTMLElement).getBoundingClientRect();
			if (r.bottom > rect.top + 1) return el as HTMLElement;
		}
		return null;
	}

	export function prepareEditSwap(entering: boolean): void {
		const scroller = viewerEl;
		// Plain `let`, not `$state`: the follow-scroll effect consumes this
		// without subscribing, so setting it never retriggers anything. Set
		// before the parent flips `isEditing`, so the exit-triggered effect
		// run sees it and skips its smooth scroll (which would otherwise
		// fight the anchor restore below and yank to the active sentence).
		if (!entering) suppressFollowOnce = true;
		pendingAnchor = null;
		if (!scroller) {
			pendingFraction = 0;
			return;
		}
		const maxBefore = scroller.scrollHeight - scroller.clientHeight;
		const fraction =
			maxBefore > 0 ? Math.max(0, Math.min(1, scroller.scrollTop / maxBefore)) : 0;
		pendingFraction = fraction;
		if (entering) {
			// Anchor to the visible view (not the active sentence): locate
			// the topmost sentence in the draft. The editor mounts only
			// post-swap, so only the logical line is captured here; metrics
			// resolve in the transition effect.
			const span = topVisibleSentence(scroller);
			const viewerRect = scroller.getBoundingClientRect();
			if (span) {
				const snippet = snippetForText(span.textContent ?? '');
				const lines = markdownDraft.split('\n');
				const guessLine = Math.round(fraction * Math.max(0, lines.length - 1));
				const hits = candidateLines(lines, snippet, guessLine);
				if (snippet && hits.length > 0) {
					pendingAnchor = {
						editorLine: hits[0],
						editorDelta: Math.max(0, span.getBoundingClientRect().top - viewerRect.top)
					};
				}
			}
			// Keep the scroll range stable across the swap; cleared on save/cancel.
			editorMinHeight =
				scroller.scrollHeight > 0 ? `${scroller.scrollHeight}px` : null;
		} else {
			// Anchor to the editor's top logical line: locate its text in
			// the viewer on exit.
			const editor = editorEl;
			if (editor) {
				const metrics = measureEditor(editor);
				if (metrics) {
					const row = Math.max(0, Math.round(editor.scrollTop / metrics.lineHeight));
					const lines = editor.value.split('\n');
					const line = lineForRow(lines, row, metrics.charsPerRow);
					const snippet = snippetForSourceLine(lines[line] ?? '');
					if (snippet) {
						const delta =
							editor.scrollTop - rowsAbove(lines, line, metrics.charsPerRow) * metrics.lineHeight;
						pendingAnchor = { viewerSnippet: snippet, viewerDelta: Math.max(0, delta) };
					}
				}
			}
		}
	}

	let prevEditing = false;
	$effect(() => {
		if (isEditing === prevEditing) return;
		prevEditing = isEditing;
		const anchor = pendingAnchor;
		pendingAnchor = null;
		const fraction = pendingFraction;
		pendingFraction = null;
		if (anchor === null && fraction === null) return;
		void tick().then(() => {
			requestAnimationFrame(() => {
				const el = viewerEl;
				if (!el) return;
				if (anchor?.editorLine !== undefined) {
					// Entering: the editor is the scroller now — resolve its
					// metrics post-mount and scroll to the anchored line.
					const editor = editorEl;
					const metrics = editor ? measureEditor(editor) : null;
					if (editor && metrics) {
						const lines = editor.value.split('\n');
						const line = Math.max(0, Math.min(anchor.editorLine, lines.length - 1));
						el.scrollTop = Math.max(
							0,
							rowsAbove(lines, line, metrics.charsPerRow) * metrics.lineHeight -
								(anchor.editorDelta ?? 0)
						);
						return;
					}
				}
				if (anchor?.viewerSnippet) {
					// Exiting: find the editor's top line in the fresh view.
					const spans = el.querySelectorAll(`[${SENTENCE_ATTR}]`);
					for (const node of spans) {
						const text = collapseWs((node as HTMLElement).textContent ?? '');
						if (text.includes(anchor.viewerSnippet)) {
							const viewerRect = el.getBoundingClientRect();
							const r = (node as HTMLElement).getBoundingClientRect();
							el.scrollTop = Math.max(
								0,
								el.scrollTop + (r.top - viewerRect.top) - (anchor.viewerDelta ?? 0)
							);
							return;
						}
					}
				}
				if (fraction === null) return;
				const maxAfter = el.scrollHeight - el.clientHeight;
				if (maxAfter <= 0) return;
				// Assigning scrollTop cancels any in-flight smooth follow-scroll.
				el.scrollTop = fraction * maxAfter;
			});
		});
	});
</script>

<div class="bg-slate-800 rounded-xl border border-slate-700 flex flex-col overflow-hidden min-h-[420px] max-h-[70vh] md:max-h-none md:min-h-0 md:h-full">
	<!-- Pane header -->
	<div class="shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-700 bg-slate-800">
		<span class="text-xs font-medium text-slate-400">Markdown</span>
		<div class="flex items-center gap-1">
			{#if isEditing}
				<button onclick={onEditSave} aria-label="Save edits" class="w-8 h-8 flex items-center justify-center rounded hover:bg-slate-700 text-emerald-400">
					<Check size={16} />
				</button>
				<button onclick={onEditCancel} aria-label="Cancel edits" class="w-8 h-8 flex items-center justify-center rounded hover:bg-slate-700 text-slate-300">
					<X size={16} />
				</button>
			{:else}
				<button onclick={onEditToggle} aria-label="Edit markdown" class="w-8 h-8 flex items-center justify-center rounded hover:bg-slate-700 text-slate-300">
					<Pencil size={16} />
				</button>
			{/if}
			<button onclick={onOpenPostprocess} aria-label="Postprocessing settings" class="w-8 h-8 flex items-center justify-center rounded hover:bg-slate-700 text-slate-300">
				<Settings size={16} />
			</button>
			<div class="relative">
				<button
					onclick={() => (showOverflow = !showOverflow)}
					aria-label="More actions"
					class="w-8 h-8 flex items-center justify-center rounded hover:bg-slate-700 text-slate-300"
				>
					<EllipsisVertical size={16} />
				</button>
				{#if showOverflow}
					<div class="absolute right-0 mt-1 w-48 bg-slate-900 border border-slate-700 rounded-lg shadow-lg py-1 z-10">
						<button
							onclick={() => {
								showOverflow = false;
								onDownloadMd();
							}}
							disabled={!hasActiveDoc}
							class="w-full text-left px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
						>
							Download .md
						</button>
						<button
							onclick={() => {
								showOverflow = false;
								onSaveAudio();
							}}
							disabled={!hasActiveDoc}
							class="w-full text-left px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
						>
							Save audio file (server)
						</button>
					</div>
				{/if}
			</div>
		</div>
	</div>

	<!-- Content -->
	<div class="flex-1 min-h-0 bg-slate-900/30 overflow-auto" bind:this={viewerEl}>
		{#if isEditing}
			<textarea
				bind:this={editorEl}
				value={markdownDraft}
				oninput={(e) => onDraftChange((e.target as HTMLTextAreaElement).value)}
				style={editorMinHeight ? `min-height: ${editorMinHeight};` : ''}
				class="w-full min-h-[360px] h-full bg-slate-900 border-0 rounded-none p-4 font-mono text-sm text-slate-100 resize-y focus:outline-none focus:ring-1 focus:ring-sky-500"
				placeholder="Markdown…"
			></textarea>
		{:else if useRich}
			<div
				role="document"
				class="md-body p-5 max-w-none"
				use:richInteractions
				use:resolveAssetImages={assetDocId}
			>
				{#if sections.length === 0}
					<p class="text-slate-400">No content yet.</p>
				{:else}
					{@html richHtml}
				{/if}
			</div>
		{:else}
			<div class="p-5 prose prose-invert prose-sm max-w-none prose-p:leading-relaxed">
				{#if sections.length === 0}
					<p class="text-slate-400">No content yet.</p>
				{:else}
					{#each renderSections as rs (rs.section.id)}
						{#each rs.paragraphs as para (rs.section.id + '-' + para.paraIdx)}
							{#if para.isHeading}
								<h3
									class="text-slate-100 font-semibold mt-4 mb-2 {rs.section.level === 1 ? 'text-lg' : 'text-base'}"
								>
									{#each para.sentences as s (s.globalIdx)}
										<span
											role="button"
											tabindex="0"
											data-sentence-idx={s.globalIdx}
											onclick={() => onSentenceClick?.(s.globalIdx)}
											onkeydown={(e) => e.key === 'Enter' && onSentenceClick?.(s.globalIdx)}
											class={sentenceClass(isActive(s.globalIdx))}>{s.text} </span>
									{/each}
								</h3>
							{:else}
								{#if para.isLegacyBreadcrumb}
									<h3 class="text-slate-100 font-semibold mt-4 mb-2 text-base">
										{rs.section.titles.join(' > ')}
									</h3>
								{/if}
								<p class="text-slate-200 leading-7 mb-4">
									{#each para.sentences as s (s.globalIdx)}
										<span
											role="button"
											tabindex="0"
											data-sentence-idx={s.globalIdx}
											onclick={() => onSentenceClick?.(s.globalIdx)}
											onkeydown={(e) => e.key === 'Enter' && onSentenceClick?.(s.globalIdx)}
											class={sentenceClass(isActive(s.globalIdx))}>{s.text} </span>
									{/each}
								</p>
							{/if}
						{/each}
					{/each}
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	/* GitHub-like rendered Markdown (dark, app-themed). The viewer injects
	 * `marked` HTML via `{@html}`, so all rules must be global — Svelte
	 * scoping does not reach injected nodes. (`prose` classes are not used:
	 * `@tailwindcss/typography` is not installed, so they are no-ops.)
	 */
	:global(.md-body) {
		color: rgb(226 232 240);
		font-size: 0.9375rem;
		line-height: 1.75;
		overflow-wrap: break-word;
	}
	:global(.md-body > :first-child) {
		margin-top: 0;
	}
	:global(.md-body > :last-child) {
		margin-bottom: 0;
	}
	:global(.md-body h1),
	:global(.md-body h2),
	:global(.md-body h3),
	:global(.md-body h4),
	:global(.md-body h5),
	:global(.md-body h6) {
		color: rgb(241 245 249);
		font-weight: 700;
		line-height: 1.3;
		margin: 1.5em 0 0.75em;
	}
	:global(.md-body h1) {
		font-size: 1.6em;
		padding-bottom: 0.3em;
		border-bottom: 1px solid rgb(51 65 85);
	}
	:global(.md-body h2) {
		font-size: 1.35em;
		padding-bottom: 0.3em;
		border-bottom: 1px solid rgb(51 65 85);
	}
	:global(.md-body h3) {
		font-size: 1.15em;
	}
	:global(.md-body h4) {
		font-size: 1em;
	}
	:global(.md-body p) {
		margin: 0 0 1em;
	}
	:global(.md-body a) {
		color: rgb(56 189 248);
		text-decoration: none;
	}
	:global(.md-body a:hover) {
		text-decoration: underline;
	}
	:global(.md-body strong) {
		font-weight: 700;
		color: rgb(241 245 249);
	}
	:global(.md-body ul),
	:global(.md-body ol) {
		margin: 0 0 1em;
		padding-left: 2em;
	}
	:global(.md-body ul) {
		list-style: disc;
	}
	:global(.md-body ol) {
		list-style: decimal;
	}
	:global(.md-body li) {
		margin: 0.25em 0;
	}
	:global(.md-body li > ul),
	:global(.md-body li > ol) {
		margin-bottom: 0;
	}
	:global(.md-body li > input[type='checkbox']) {
		margin-right: 0.5em;
	}
	:global(.md-body table) {
		display: table;
		width: 100%;
		max-width: 100%;
		margin: 0 0 1em;
		border-collapse: collapse;
		font-size: 0.875em;
		line-height: 1.6;
	}
	:global(.md-body th),
	:global(.md-body td) {
		padding: 0.5em 0.9em;
		border: 1px solid rgb(51 65 85);
		text-align: left;
		vertical-align: top;
	}
	:global(.md-body th) {
		font-weight: 700;
		color: rgb(241 245 249);
		background-color: rgb(30 41 59 / 0.7);
	}
	:global(.md-body tbody tr:nth-child(even)) {
		background-color: rgb(30 41 59 / 0.35);
	}
	:global(.md-body pre) {
		margin: 0 0 1em;
		padding: 1em;
		overflow-x: auto;
		border: 1px solid rgb(51 65 85 / 0.7);
		border-radius: 0.5rem;
		background-color: rgb(2 6 23 / 0.7);
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.85em;
		line-height: 1.6;
	}
	:global(.md-body pre code) {
		padding: 0;
		border: 0;
		border-radius: 0;
		background: transparent;
	}
	/* highlight.js theme sets its own surface on `code.hljs`; keep the
	 * app-themed `<pre>` surface and use only the theme's token colors. */
	:global(.md-body pre code.hljs) {
		background: transparent;
		padding: 0;
	}
	:global(.md-body code) {
		padding: 0.15em 0.4em;
		border-radius: 0.375rem;
		background-color: rgb(51 65 85 / 0.6);
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.85em;
	}
	:global(.md-body blockquote) {
		margin: 0 0 1em;
		padding: 0 1em;
		border-left: 0.25em solid rgb(71 85 105);
		color: rgb(148 163 184);
	}
	:global(.md-body blockquote > :last-child) {
		margin-bottom: 0;
	}
	:global(.md-body hr) {
		margin: 1.5em 0;
		border: 0;
		border-top: 1px solid rgb(51 65 85);
	}
	:global(.md-body img) {
		max-width: 100%;
		border-radius: 0.375rem;
	}
	/* Sentence spans are injected as raw HTML (`{@html}`), so their styles
	 * must be global — Svelte scoping does not reach injected nodes.
	 * Mirrors the legacy `sentenceClass` look (pill highlight when active).
	 */
	:global(.tts-sent) {
		border-radius: 0.25rem;
		padding-left: 0.125rem;
		padding-right: 0.125rem;
		transition: background-color 0.15s;
		scroll-margin-top: 0.5rem;
		cursor: pointer;
	}
	:global(.tts-sent:hover) {
		background-color: rgb(51 65 85 / 0.4);
	}
	:global(.tts-sent.tts-active) {
		background-color: rgb(14 165 233 / 0.2);
		box-shadow: 0 0 0 1px rgb(14 165 233 / 0.3);
		color: rgb(224 242 254);
	}
	:global(.tts-sent:focus-visible) {
		outline: 1px solid rgb(14 165 233 / 0.6);
		outline-offset: 1px;
	}
</style>
