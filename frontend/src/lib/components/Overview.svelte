<script lang="ts">
import { ListMusic, Plus, Upload, Link2, FileText, ClipboardPaste, Search } from 'lucide-svelte';
import type { Playlist } from '$lib/playlists/model';

export interface OverviewPlaylistStat {
	playlist: Playlist;
	itemCount: number;
	/** Sentences done across items. */
	done: number;
	/** Sentences total across items. */
	total: number;
	estRemaining: string;
	lastListenedLabel: string | null;
}

export interface OverviewSearchHit {
	playlistId: string;
	playlistName: string;
	itemId: string | null;
	/** Set for docs outside any playlist (opens standalone). */
	docId?: string | null;
	title: string;
	detail: string;
}

interface Props {
	stats: OverviewPlaylistStat[];
	searchIndex: OverviewSearchHit[];
	onResume: (playlistId: string) => void;
	onOpenPlaylist: (playlistId: string) => void;
	onOpenItem: (playlistId: string, itemId: string) => void;
	onOpenDoc: (docId: string) => void;
	onShowLibrary: () => void;
	onCreatePlaylist: () => void;
	onUploadPdf: () => void;
	onEnterUrl: () => void;
	onUploadMarkdown: () => void;
	onPasteText: () => void;
}

let {
	stats,
	searchIndex,
	onResume,
	onOpenPlaylist,
	onOpenItem,
	onOpenDoc,
	onShowLibrary,
	onCreatePlaylist,
	onUploadPdf,
	onEnterUrl,
	onUploadMarkdown,
	onPasteText
}: Props = $props();

let query: string = $state('');

let resume = $derived(stats.length > 0 ? stats[0] : null);
let others = $derived(stats.length > 1 ? stats.slice(1) : []);

let hits = $derived.by(() => {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	return searchIndex.filter((h) => h.title.toLowerCase().includes(q)).slice(0, 12);
});

function percent(s: OverviewPlaylistStat): number {
	if (s.total <= 0) return 0;
	return Math.round((s.done / s.total) * 100);
}
</script>

<div class="mx-auto w-full max-w-4xl flex flex-col gap-8 py-6">
	<div class="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2">
		<Search size={16} class="shrink-0 text-slate-400" />
		<input
			bind:value={query}
			placeholder="Search playlists and items…"
			aria-label="Search playlists and items"
			class="flex-1 min-w-0 bg-transparent text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
		/>
	</div>

	{#if query.trim() && hits.length > 0}
		<section>
			<h2 class="text-lg font-semibold text-slate-100 mb-3">Results</h2>
			<div class="flex flex-col gap-2">
				{#each hits as hit (hit.docId ?? hit.itemId ?? hit.playlistId)}
					<button
						onclick={() => {
							if (hit.docId) onOpenDoc(hit.docId);
							else if (hit.itemId) onOpenItem(hit.playlistId, hit.itemId);
							else onOpenPlaylist(hit.playlistId);
						}}
						class="text-left bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg px-4 py-2.5 transition-colors"
					>
						<div class="text-sm font-medium text-slate-100 truncate">{hit.title}</div>
						<div class="text-xs text-slate-400 truncate">{hit.detail}</div>
					</button>
				{/each}
			</div>
		</section>
	{/if}

	<section>
		<h2 class="text-lg font-semibold text-slate-100 mb-3">Resume listening</h2>
		{#if !resume}
			<p class="text-sm text-slate-400">No playlists yet — create one below, or listen to something right away.</p>
		{:else}
			<div class="grid sm:grid-cols-3 gap-3">
				<button
					onclick={() => onResume(resume.playlist.id)}
					class="text-left border-2 border-sky-500 bg-slate-800 hover:bg-slate-700 rounded-lg px-4 py-3 transition-colors"
				>
					<div class="text-sm font-semibold text-sky-300 truncate">{resume.playlist.name}</div>
					<div class="text-xs text-slate-300 mt-1">
						{resume.itemCount} {resume.itemCount === 1 ? 'item' : 'items'} · {percent(resume)}% · {resume.estRemaining} left
					</div>
					{#if resume.lastListenedLabel}
						<div class="text-[11px] text-slate-500 mt-0.5">Last listened {resume.lastListenedLabel}</div>
					{/if}
				</button>
				{#each others as s (s.playlist.id)}
					<button
						onclick={() => onOpenPlaylist(s.playlist.id)}
						class="text-left border border-slate-700 bg-slate-800 hover:bg-slate-700 rounded-lg px-4 py-3 transition-colors"
					>
						<div class="text-sm font-medium text-slate-100 truncate">{s.playlist.name}</div>
						<div class="text-xs text-slate-400 mt-1">
							{s.itemCount} {s.itemCount === 1 ? 'item' : 'items'} · {percent(s)}% · {s.estRemaining} left
						</div>
						{#if s.lastListenedLabel}
							<div class="text-[11px] text-slate-500 mt-0.5">Last listened {s.lastListenedLabel}</div>
						{/if}
					</button>
				{/each}
			</div>
		{/if}
	</section>

	<div class="grid sm:grid-cols-2 gap-3">
		<section class="border border-slate-700 bg-slate-800 rounded-lg px-4 py-4 flex flex-col gap-3">
			<h2 class="text-lg font-semibold text-slate-100 flex items-center gap-2">
				<ListMusic size={18} /> Library
			</h2>
			<p class="text-xs text-slate-400">View the library of playlists.</p>
			<div class="flex flex-wrap gap-2 mt-auto">
				<button onclick={onShowLibrary} class="text-sm px-4 py-2 rounded-md bg-slate-700 hover:bg-slate-600 text-slate-100 font-medium">
					View library
				</button>
				<button onclick={onCreatePlaylist} class="inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded-md border border-slate-600 hover:bg-slate-700 text-slate-200">
					<Plus size={15} /> New playlist
				</button>
			</div>
		</section>
		<section class="border border-slate-700 bg-slate-800 rounded-lg px-4 py-4 flex flex-col gap-3">
			<h2 class="text-lg font-semibold text-slate-100">Listen now</h2>
			<p class="text-xs text-slate-400">Upload a PDF, paste a URL, or upload Markdown to begin listening right away.</p>
			<div class="flex flex-wrap gap-2 mt-auto">
				<button onclick={onUploadPdf} class="inline-flex items-center gap-1.5 text-sm px-3 py-2 rounded-md bg-sky-600 hover:bg-sky-500 text-white font-medium">
					<Upload size={15} /> PDF
				</button>
				<button onclick={onEnterUrl} class="inline-flex items-center gap-1.5 text-sm px-3 py-2 rounded-md border border-slate-600 hover:bg-slate-700 text-slate-200">
					<Link2 size={15} /> URL
				</button>
				<button onclick={onUploadMarkdown} class="inline-flex items-center gap-1.5 text-sm px-3 py-2 rounded-md border border-slate-600 hover:bg-slate-700 text-slate-200">
					<FileText size={15} /> Markdown
				</button>
				<button onclick={onPasteText} class="inline-flex items-center gap-1.5 text-sm px-3 py-2 rounded-md border border-slate-600 hover:bg-slate-700 text-slate-200">
					<ClipboardPaste size={15} /> Paste
				</button>
			</div>
		</section>
	</div>
</div>
