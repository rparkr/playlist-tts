<script lang="ts">
import { Check, ListMusic, Pencil, Plus, Trash2, X } from 'lucide-svelte';
import type { Playlist } from '$lib/playlists/model';

export interface LibraryPlaylistStat {
	itemCount: number;
	done: number;
	total: number;
	estRemaining: string;
}

interface Props {
	playlists: Playlist[];
	stats: Record<string, LibraryPlaylistStat>;
	activePlaylistId: string | null;
	onOpenPlaylist: (id: string) => void;
	onCreatePlaylist: () => void;
	onRenamePlaylist: (id: string, name: string) => void;
	onDeletePlaylist: (id: string) => void;
}

let {
	playlists,
	stats,
	activePlaylistId,
	onOpenPlaylist,
	onCreatePlaylist,
	onRenamePlaylist,
	onDeletePlaylist
}: Props = $props();

let editingId: string | null = $state(null);
let editValue: string = $state('');

function startEdit(p: Playlist) {
	editingId = p.id;
	editValue = p.name;
}

function commitEdit() {
	if (editingId && editValue.trim()) onRenamePlaylist(editingId, editValue.trim());
	editingId = null;
	editValue = '';
}

function cardSub(id: string): string {
	const s = stats[id];
	if (!s) return '…';
	const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;
	return `${s.itemCount} ${s.itemCount === 1 ? 'item' : 'items'} · ${pct}% · ${s.estRemaining} left`;
}
</script>

<div class="bg-slate-800 rounded-xl border border-slate-700 flex flex-col overflow-hidden min-h-[420px] max-h-[70vh] md:max-h-none md:min-h-0 md:h-full">
	<div class="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-slate-700">
		<h2 class="flex-1 min-w-0 text-base font-semibold text-slate-100 flex items-center gap-2">
			<ListMusic size={17} /> Library
		</h2>
		<button onclick={onCreatePlaylist} aria-label="Create a new playlist" title="Create a new playlist"
			class="w-8 h-8 flex items-center justify-center rounded-md bg-slate-700 hover:bg-slate-600 text-slate-100">
			<Plus size={16} />
		</button>
	</div>

	<div class="flex-1 min-h-0 overflow-auto p-3 flex flex-col gap-2">
		{#if playlists.length === 0}
			<p class="text-xs text-slate-400 py-6 text-center">No playlists yet — press + to create one.</p>
		{:else}
			{#each playlists as p (p.id)}
				<div
					class="bg-slate-700/60 hover:bg-slate-700 px-3 py-2.5 rounded-lg border transition-colors {activePlaylistId === p.id ? 'border-sky-500' : 'border-transparent'}"
				>
					{#if editingId === p.id}
						<div class="flex items-center gap-1">
							<input bind:value={editValue}
								onkeydown={(e) => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') { editingId = null; editValue = ''; } }}
								onblur={commitEdit}
								class="flex-1 min-w-0 bg-slate-900 border border-sky-500 rounded px-2 py-1 text-sm text-slate-100 focus:outline-none"
								autofocus />
							<button onclick={commitEdit} onmousedown={(e) => e.preventDefault()} aria-label="Save" class="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-600 text-sky-400">
								<Check size={14} />
							</button>
							<button onclick={() => { editingId = null; editValue = ''; }} onmousedown={(e) => e.preventDefault()} aria-label="Cancel" class="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-600 text-slate-300">
								<X size={14} />
							</button>
						</div>
					{:else}
						<div class="flex items-center gap-2">
							<button class="flex-1 min-w-0 text-left" onclick={() => onOpenPlaylist(p.id)}>
								<div class="text-sm font-medium text-slate-100 truncate">{p.name}</div>
								<div class="text-xs text-slate-400 truncate">{cardSub(p.id)}</div>
							</button>
							<div class="flex items-center gap-1 shrink-0">
								<button onclick={() => startEdit(p)} aria-label="Rename playlist"
									class="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-600 text-slate-300">
									<Pencil size={14} />
								</button>
								<button onclick={() => onDeletePlaylist(p.id)} aria-label="Delete playlist"
									class="w-7 h-7 flex items-center justify-center rounded hover:bg-red-500/20 text-slate-300 hover:text-red-400">
									<Trash2 size={14} />
								</button>
							</div>
						</div>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</div>
