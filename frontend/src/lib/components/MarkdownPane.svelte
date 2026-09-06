<script lang="ts">
	import { Pencil, Check, X, Settings, EllipsisVertical } from 'lucide-svelte';
	import type { Section } from '$lib/markdown/parse';
	import { getGlobalSentences, globalToSectionChunk } from '$lib/markdown/parse';

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

	function isActive(sentIdx: number): boolean {
		return sentIdx === globalIdx;
	}

	// Build flat list with section context for rendering
	let flatWithSection = $derived.by(() => {
		const flat: Array<{ text: string; globalIdx: number; section: Section }> = [];
		let g = 0;
		for (const sec of sections) {
			for (const chunk of sec.chunks) {
				flat.push({ text: chunk, globalIdx: g, section: sec });
				g++;
			}
		}
		return flat;
	});

	// Group by section for display
	let grouped = $derived.by(() => {
		const map = new Map<number, { section: Section; sentences: typeof flatWithSection }>();
		for (const item of flatWithSection) {
			const key = item.section.id;
			if (!map.has(key)) map.set(key, { section: item.section, sentences: [] });
			map.get(key)!.sentences.push(item);
		}
		return Array.from(map.values());
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
				class="w-full min-h-[360px] h-full bg-slate-900 border-0 rounded-none p-4 font-mono text-sm text-slate-100 resize-y focus:outline-none focus:ring-1 focus:ring-sky-500"
				placeholder="Markdown…"
			></textarea>
		{:else}
			<div class="p-5 prose prose-invert prose-sm max-w-none prose-p:leading-relaxed">
				{#if sections.length === 0}
					<p class="text-slate-400">No content yet.</p>
				{:else}
					{#each grouped as group}
						{#if group.section.titles.length && group.section.titles[0] !== 'Document'}
							<h3 class="text-slate-100 font-semibold mt-4 mb-2 text-base">
								{group.section.titles.join(' > ')}
							</h3>
						{/if}
						<p class="text-slate-200 leading-7">
							{#each group.sentences as s}
								<span
									role="button"
									tabindex="0"
									onclick={() => onSentenceClick?.(s.globalIdx)}
									onkeydown={(e) => e.key === 'Enter' && onSentenceClick?.(s.globalIdx)}
									class="rounded px-0.5 transition-colors {isActive(s.globalIdx)
										? 'bg-sky-500/20 ring-1 ring-sky-500/30 text-sky-100'
										: 'hover:bg-slate-700/40 cursor-pointer'}"
								>{s.text} </span>
							{/each}
						</p>
					{/each}
				{/if}
			</div>
		{/if}
	</div>
</div>
