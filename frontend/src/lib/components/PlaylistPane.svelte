<script lang="ts">
import {
	ArrowUp,
	ArrowDown,
	Check,
	FileText,
	Link2,
	Pencil,
	Plus,
	Trash2,
	Upload,
	X,
	ClipboardPaste,
	LibraryBig,
	FileStack,
	RefreshCw
} from 'lucide-svelte';
import type { Playlist, PlaylistItem } from '$lib/playlists/model';
import { sourceLabel } from '$lib/playlists/model';

export interface PlaylistItemStat {
	done: number;
	total: number;
	estTotal: string;
	estRemaining: string;
	hasPdf: boolean;
}

export type ReprocessEngine = 'auto' | 'text' | 'docling' | 'llm';

const ENGINES: { value: ReprocessEngine; label: string }[] = [
	{ value: 'auto', label: 'auto' },
	{ value: 'text', label: 'text extraction' },
	{ value: 'docling', label: 'OCR: docling' },
	{ value: 'llm', label: 'OCR: LLM' }
];

interface Props {
	playlist: Playlist | null;
	items: PlaylistItem[];
	stats: Record<string, PlaylistItemStat>;
	activeItemId: string | null;
	/** Show "add current doc" when a doc is open outside any playlist item. */
	canAddCurrentDoc: boolean;
	onSelectItem: (id: string) => void;
	onRenameItem: (id: string, title: string) => void;
	onDeleteItem: (id: string) => void;
	onBulkDelete: (ids: string[]) => void;
	onMoveItem: (id: string, dir: -1 | 1) => void;
	onDropItem: (id: string, targetId: string) => void;
	onShowPdf: (id: string) => void;
	onClearItemPdf: (id: string) => void;
	onReprocessItem: (id: string, engine: ReprocessEngine) => void;
	onOpenLibrary: () => void;
	onUploadDoc: () => void;
	onPasteText: (title: string, text: string) => void;
	onFetchUrl: (url: string) => void;
	onAddCurrentDoc: () => void;
}

let {
	playlist,
	items,
	stats,
	activeItemId,
	canAddCurrentDoc,
	onSelectItem,
	onRenameItem,
	onDeleteItem,
	onBulkDelete,
	onMoveItem,
	onDropItem,
	onShowPdf,
	onClearItemPdf,
	onReprocessItem,
	onOpenLibrary,
	onUploadDoc,
	onPasteText,
	onFetchUrl,
	onAddCurrentDoc
}: Props = $props();

let menuOpen: boolean = $state(false);
let urlFormOpen: boolean = $state(false);
let pasteFormOpen: boolean = $state(false);
let urlValue: string = $state('');
let pasteTitle: string = $state('');
let pasteValue: string = $state('');
let editingId: string | null = $state(null);
let editValue: string = $state('');
let dragId: string | null = $state(null);
// Edit mode (header pencil): checkboxes + per-row rename/reorder/reprocess,
// bulk delete. Normal mode stays decluttered: tap a card to open it.
let editMode: boolean = $state(false);
let selected: string[] = $state([]);
let reprocessId: string | null = $state(null);

// Drop selections for items that left the playlist (deletes, switches).
// Guarded: assigning a fresh array unconditionally would re-trigger this
// same effect forever (new identity notifies on every run) and take down
// the update flush with `effect_update_depth_exceeded`.
$effect(() => {
	const ids = new Set(items.map((i) => i.id));
	const pruned = selected.filter((id) => ids.has(id));
	if (pruned.length !== selected.length) selected = pruned;
	if (editingId && !ids.has(editingId)) {
		editingId = null;
		editValue = '';
	}
	if (reprocessId && !ids.has(reprocessId)) reprocessId = null;
});

function openMenu() {
	menuOpen = !menuOpen;
	if (menuOpen) {
		urlFormOpen = false;
		pasteFormOpen = false;
	}
}

function submitUrl() {
	const url = urlValue.trim();
	if (!url) return;
	urlValue = '';
	urlFormOpen = false;
	menuOpen = false;
	onFetchUrl(url);
}

function submitPaste() {
	const text = pasteValue.trim();
	if (!text) return;
	const title = pasteTitle.trim();
	pasteTitle = '';
	pasteValue = '';
	pasteFormOpen = false;
	menuOpen = false;
	onPasteText(title, text);
}

function startEdit(item: PlaylistItem) {
	editingId = item.id;
	editValue = item.title;
}

function commitEdit() {
	if (editingId && editValue.trim()) onRenameItem(editingId, editValue.trim());
	editingId = null;
	editValue = '';
}

function toggleSelect(id: string) {
	selected = selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
}

function itemPercent(id: string): number {
	const s = stats[id];
	if (!s || s.total <= 0) return 0;
	return Math.round((s.done / s.total) * 100);
}
</script>

<div class="bg-slate-800 rounded-xl border border-slate-700 flex flex-col overflow-hidden min-h-[420px] max-h-[70vh] md:max-h-none md:min-h-0 md:h-full">
	{#if !playlist}
		<div class="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center">
			<div class="text-sm text-slate-300">No playlist open</div>
			<button onclick={onOpenLibrary} class="inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded-md bg-sky-600 hover:bg-sky-500 text-white font-medium">
				<LibraryBig size={15} /> Open library
			</button>
		</div>
	{:else}
		<div class="shrink-0 px-4 py-3 border-b border-slate-700">
			<div class="flex items-center gap-2">
				<div class="flex-1 min-w-0">
					<h2 class="text-base font-semibold text-slate-100 truncate">{playlist.name}</h2>
					<div class="text-xs text-slate-400">{items.length} {items.length === 1 ? 'item' : 'items'}</div>
				</div>
				<button onclick={openMenu} aria-label="Add item to playlist" title="Add item (Upload file | Enter URL | Paste text)"
					class="w-8 h-8 flex items-center justify-center rounded-md bg-slate-700 hover:bg-slate-600 text-slate-100">
					<Plus size={16} />
				</button>
				<button onclick={() => { editMode = !editMode; selected = []; reprocessId = null; }} aria-label={editMode ? 'Done editing' : 'Edit playlist'}
					title={editMode ? 'Done editing' : 'Edit playlist (rename, reorder, reprocess, delete)'}
					class="w-8 h-8 flex items-center justify-center rounded-md text-slate-100 {editMode ? 'bg-sky-600 hover:bg-sky-500' : 'bg-slate-700 hover:bg-slate-600'}">
					{#if editMode}<Check size={16} />{:else}<Pencil size={16} />{/if}
				</button>
				<button onclick={onOpenLibrary} aria-label="Open library" title="Open library"
					class="w-8 h-8 flex items-center justify-center rounded-md bg-slate-700 hover:bg-slate-600 text-slate-100">
					<LibraryBig size={16} />
				</button>
			</div>
			{#if editMode && selected.length > 0}
				<div class="mt-2 flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-2 py-1.5">
					<span class="flex-1 text-xs text-slate-200">{selected.length} selected</span>
					<button onclick={() => { onBulkDelete(selected); selected = []; }}
						class="inline-flex items-center gap-1 text-xs px-3 py-1 rounded-md bg-red-600 hover:bg-red-500 text-white font-medium">
						<Trash2 size={13} /> Delete
					</button>
				</div>
			{/if}
			{#if menuOpen}
				<div class="mt-2 flex flex-col gap-2 rounded-lg border border-slate-600 bg-slate-900/60 p-2">
					<div class="grid grid-cols-2 gap-2">
						<button onclick={onUploadDoc} class="col-span-2 inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-slate-600 hover:bg-slate-700 text-slate-200">
							<Upload size={13} /> Upload file (PDF, Markdown, text, ePub)
						</button>
						<button onclick={() => { urlFormOpen = !urlFormOpen; pasteFormOpen = false; }} class="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-slate-600 hover:bg-slate-700 text-slate-200">
							<Link2 size={13} /> Enter URL
						</button>
						<button onclick={() => { pasteFormOpen = !pasteFormOpen; urlFormOpen = false; }} class="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-slate-600 hover:bg-slate-700 text-slate-200">
							<ClipboardPaste size={13} /> Paste text
						</button>
					</div>
					{#if canAddCurrentDoc}
						<button onclick={onAddCurrentDoc} class="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-sky-500/50 text-sky-300 hover:bg-sky-500/10">
							<FileStack size={13} /> Add current doc to this playlist
						</button>
					{/if}
					{#if urlFormOpen}
						<form onsubmit={(e) => { e.preventDefault(); submitUrl(); }} class="flex gap-2">
							<input bind:value={urlValue} placeholder="https://example.com/article, paper.pdf, or book.epub" aria-label="Article, PDF, or ePub URL"
								class="flex-1 min-w-0 bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-sky-500" />
							<button type="submit" class="text-xs px-3 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white font-medium">Add</button>
						</form>
					{/if}
					{#if pasteFormOpen}
						<form onsubmit={(e) => { e.preventDefault(); submitPaste(); }} class="flex flex-col gap-2">
							<input bind:value={pasteTitle} placeholder="Title (optional — first line used otherwise)" aria-label="Pasted text title"
								class="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-sky-500" />
							<textarea bind:value={pasteValue} rows={4} placeholder="Paste Markdown or plain text…" aria-label="Paste text"
								class="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-sky-500"></textarea>
							<button type="submit" class="self-end text-xs px-3 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white font-medium">Add as item</button>
						</form>
					{/if}
				</div>
			{/if}
		</div>

		<div class="flex-1 min-h-0 overflow-auto p-3 flex flex-col gap-2">
			{#if items.length === 0}
				<p class="text-xs text-slate-400 py-6 text-center">Empty playlist — press + to add the first item.</p>
			{:else}
				{#each items as item, i (item.id)}
					{@const s = stats[item.id]}
					<div
						role="option"
						tabindex="0"
						aria-selected={activeItemId === item.id}
						draggable={editMode ? 'true' : 'false'}
						ondragstart={() => (dragId = item.id)}
						ondragover={(e) => e.preventDefault()}
						ondrop={() => { if (dragId && dragId !== item.id) onDropItem(dragId, item.id); dragId = null; }}
						onkeydown={(e) => { if (e.key === 'Enter') onSelectItem(item.id); }}
						class="bg-slate-700/60 hover:bg-slate-700 px-3 py-2.5 rounded-lg border cursor-pointer transition-colors {activeItemId === item.id ? 'border-sky-500' : 'border-transparent'} {dragId === item.id ? 'opacity-50' : ''}"
					>
						<div class="flex items-center gap-2">
							{#if editMode}
								<input type="checkbox" checked={selected.includes(item.id)} onchange={() => toggleSelect(item.id)}
									onclick={(e) => e.stopPropagation()} aria-label="Select {item.title}"
									class="w-4 h-4 shrink-0 accent-sky-500" />
							{/if}
							{#if editingId === item.id}
								<input bind:value={editValue}
									onkeydown={(e) => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') { editingId = null; editValue = ''; } }}
									onblur={commitEdit}
									onclick={(e) => e.stopPropagation()}
									class="flex-1 min-w-0 bg-slate-900 border border-sky-500 rounded px-2 py-1 text-sm text-slate-100 focus:outline-none"
									autofocus />
								<button onclick={commitEdit} onmousedown={(e) => e.preventDefault()} aria-label="Save" class="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-600 text-sky-400">
									<Check size={14} />
								</button>
								<button onclick={() => { editingId = null; editValue = ''; }} onmousedown={(e) => e.preventDefault()} aria-label="Cancel" class="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-600 text-slate-300">
									<X size={14} />
								</button>
							{:else}
								<button class="flex-1 min-w-0 text-left" onclick={() => onSelectItem(item.id)}>
									<div class="text-sm font-medium text-slate-100 truncate">{item.title}</div>
									<div class="text-xs text-slate-400 truncate">
										{sourceLabel(item.source)} · {s ? `${itemPercent(item.id)}% · ${s.estRemaining} left · ${s.estTotal} total` : '…'}
									</div>
									{#if s && s.total > 0}
										<div class="mt-1 h-1 rounded-full bg-slate-600 overflow-hidden">
											<div class="h-full bg-sky-500 rounded-full" style="width: {itemPercent(item.id)}%"></div>
										</div>
									{/if}
								</button>
								{#if editMode}
									<div class="flex flex-col items-center gap-0.5 shrink-0">
										<button onclick={(e) => { e.stopPropagation(); onMoveItem(item.id, -1); }} disabled={i === 0} aria-label="Move up"
											class="w-6 h-5 flex items-center justify-center rounded hover:bg-slate-600 text-slate-300 disabled:opacity-30">
											<ArrowUp size={12} />
										</button>
										<button onclick={(e) => { e.stopPropagation(); onMoveItem(item.id, 1); }} disabled={i === items.length - 1} aria-label="Move down"
											class="w-6 h-5 flex items-center justify-center rounded hover:bg-slate-600 text-slate-300 disabled:opacity-30">
											<ArrowDown size={12} />
										</button>
									</div>
									<div class="flex items-center gap-1 shrink-0">
										{#if s?.hasPdf}
											<button onclick={(e) => { e.stopPropagation(); onShowPdf(item.id); }} aria-label="Show PDF" title="Show PDF side-by-side"
												class="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-600 text-slate-300 hover:text-sky-300">
												<FileText size={14} />
											</button>
											<button onclick={(e) => { e.stopPropagation(); reprocessId = reprocessId === item.id ? null : item.id; }} aria-label="Re-extract PDF" title="Re-extract with another engine"
												class="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-600 text-slate-300 hover:text-amber-300">
												<RefreshCw size={14} />
											</button>
										{/if}
										<button onclick={(e) => { e.stopPropagation(); startEdit(item); }} aria-label="Rename"
											class="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-600 text-slate-300">
											<Pencil size={14} />
										</button>
										<button onclick={(e) => { e.stopPropagation(); onDeleteItem(item.id); }} aria-label="Delete"
											class="w-7 h-7 flex items-center justify-center rounded hover:bg-red-500/20 text-slate-300 hover:text-red-400">
											<Trash2 size={14} />
										</button>
									</div>
								{/if}
							{/if}
						</div>
						{#if editMode && reprocessId === item.id}
							<div class="mt-2 flex flex-wrap items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1.5">
								<span class="text-[11px] text-amber-200/90 mr-1">Re-extract with:</span>
								{#each ENGINES as eng (eng.value)}
									<button onclick={(e) => { e.stopPropagation(); reprocessId = null; onReprocessItem(item.id, eng.value); }}
										class="text-[11px] px-2 py-0.5 rounded-md border border-slate-600 text-slate-200 hover:bg-slate-700">
										{eng.label}
									</button>
								{/each}
							</div>
						{/if}
						{#if editMode && s?.hasPdf && editingId !== item.id && reprocessId !== item.id}
							<button onclick={(e) => { e.stopPropagation(); onClearItemPdf(item.id); }}
								class="mt-1 text-[11px] text-slate-500 hover:text-amber-300 underline">
								Remove cached PDF to save storage
							</button>
						{/if}
					</div>
				{/each}
			{/if}
		</div>
	{/if}
</div>
