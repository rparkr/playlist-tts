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
	$effect(() => {
		const idx = globalIdx;
		const viewer = viewerEl;
		// Depend on the rendered output so fresh nodes get highlighted.
		void richHtml;
		void useRich;
		if (isEditing || !viewer || totalSentences === 0) return;
		syncActiveHighlight(idx);
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

	// Preserve scroll across the viewer↔editor swap so editing a long doc
	// lands at the same position instead of jumping to the top. The outer
	// scroll container persists, but the editor (`h-full` textarea) is much
	// shorter than rendered prose: without compensation the browser clamps
	// `scrollTop` to 0 when entering edit mode, and there are no sentence
	// spans to anchor to when leaving it.
	//
	// Capture must happen pre-swap (the parent calls `prepareEditSwap`
	// before flipping `isEditing`): on entering, pin the textarea's
	// min-height to the pre-swap scroll height (keeping the scroll range
	// stable); on exit, just carry the textarea's fraction over. The
	// transition effect below only restores the captured fraction post-swap.
	let pendingFraction: number | null = null;
	let editorMinHeight: string | null = $state(null);

	export function prepareEditSwap(entering: boolean): void {
		const scroller = viewerEl;
		if (!scroller) {
			pendingFraction = 0;
			return;
		}
		const maxBefore = scroller.scrollHeight - scroller.clientHeight;
		const active = scroller.querySelector(
			`[data-sentence-idx="${globalIdx}"]`
		) as HTMLElement | null;
		let fraction: number;
		if (active && entering) {
			const viewerRect = scroller.getBoundingClientRect();
			const elRect = active.getBoundingClientRect();
			const absTop = scroller.scrollTop + (elRect.top - viewerRect.top);
			fraction = scroller.scrollHeight > 0 ? absTop / scroller.scrollHeight : 0;
		} else {
			fraction = maxBefore > 0 ? scroller.scrollTop / maxBefore : 0;
		}
		pendingFraction = Math.max(0, Math.min(1, fraction));
		// Keep the scroll range stable across the swap; cleared on save/cancel.
		editorMinHeight = entering && scroller.scrollHeight > 0 ? `${scroller.scrollHeight}px` : null;
	}

	let prevEditing = false;
	$effect(() => {
		if (isEditing === prevEditing) return;
		prevEditing = isEditing;
		const fraction = pendingFraction;
		pendingFraction = null;
		if (fraction === null) return;
		void tick().then(() => {
			requestAnimationFrame(() => {
				const el = viewerEl;
				if (!el) return;
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
				class="p-5 prose prose-invert prose-sm max-w-none prose-p:leading-relaxed"
				use:richInteractions
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
