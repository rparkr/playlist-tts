<script lang="ts">
	import { X, Pencil, Trash2, FileText } from 'lucide-svelte';
	import type { Doc } from '$lib/stores/library';
	import { getGlobalSentences } from '$lib/markdown/parse';

	interface Props {
		open: boolean;
		docs: Doc[];
		activeDocId: string | null;
		onClose: () => void;
		onSelect: (id: string) => void;
		onDelete: (id: string) => void;
		onRename: (id: string, newTitle: string) => Promise<void>;
	}

	let { open, docs, activeDocId, onClose, onSelect, onDelete, onRename }: Props = $props();

	let editingId: string | null = $state(null);
	let editValue: string = $state('');

	function startEdit(doc: Doc) {
		editingId = doc.id;
		editValue = doc.title;
	}

	async function commitEdit() {
		if (editingId && editValue.trim()) {
			await onRename(editingId, editValue.trim());
		}
		editingId = null;
		editValue = '';
	}

	function cancelEdit() {
		editingId = null;
		editValue = '';
	}

	function handleKey(e: KeyboardEvent) {
		if (e.key === 'Enter') commitEdit();
		if (e.key === 'Escape') cancelEdit();
	}

	function onBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onClose();
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center md:p-4"
		role="dialog"
		aria-modal="true"
		aria-label="Library"
	>
		<!-- Backdrop -->
		<button
			class="absolute inset-0 bg-black/60 backdrop-blur-sm"
			onclick={onBackdropClick}
			aria-label="Close library"
			tabindex="-1"
		></button>

		<!-- Card -->
		<div
			class="relative w-full h-full md:h-auto md:max-h-[80vh] md:max-w-lg bg-slate-800 md:rounded-xl shadow-xl flex flex-col overflow-hidden"
		>
			<div class="flex items-center justify-between px-5 py-4 border-b border-slate-700">
				<h2 class="text-lg font-semibold text-slate-100">Library</h2>
				<button
					onclick={onClose}
					aria-label="Close"
					class="w-8 h-8 flex items-center justify-center rounded-md hover:bg-slate-700 text-slate-300 transition-colors"
				>
					<X size={18} />
				</button>
			</div>

			<div class="flex-1 overflow-auto p-4 flex flex-col gap-2">
				{#if docs.length === 0}
					<p class="text-sm text-slate-400 py-8 text-center">No saved documents yet. Upload a PDF to get started.</p>
				{:else}
					{#each docs as doc (doc.id)}
						<div
							class="flex items-center gap-2 bg-slate-700/60 hover:bg-slate-700 px-3 py-2.5 rounded-lg border {activeDocId === doc.id
								? 'border-sky-500'
								: 'border-transparent'} transition-colors"
						>
							<button
								class="flex-1 min-w-0 text-left flex items-center gap-2"
								onclick={() => {
									onSelect(doc.id);
									onClose();
								}}
							>
								<FileText size={16} class="shrink-0 text-slate-400" />
								<span class="flex-1 min-w-0">
									{#if editingId === doc.id}
										<input
											bind:value={editValue}
											onkeydown={handleKey}
											onblur={commitEdit}
											class="w-full bg-slate-900 border border-sky-500 rounded px-2 py-1 text-sm text-slate-100 focus:outline-none"
											autofocus
										/>
									{:else}
										<div class="text-sm font-medium text-slate-100 truncate">{doc.title}</div>
										<div class="text-xs text-slate-400">
											{doc.sections.length} sections · {getGlobalSentences(doc.sections).length} sentences{doc.pageMap
												? ' · 📄 PDF'
												: ''}
										</div>
									{/if}
								</span>
							</button>

							<div class="flex items-center gap-1 shrink-0">
								{#if editingId === doc.id}
									<button
										onclick={commitEdit}
										aria-label="Save"
										class="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-600 text-sky-400"
									>
										<X size={14} class="rotate-45" />
										<!-- use check via text fallback -->
										<span class="sr-only">Save</span>✓
									</button>
									<button
										onclick={cancelEdit}
										aria-label="Cancel"
										class="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-600 text-slate-300"
									>
										<X size={14} />
									</button>
								{:else}
									<button
										onclick={() => startEdit(doc)}
										aria-label="Rename"
										class="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-600 text-slate-300"
									>
										<Pencil size={14} />
									</button>
									<button
										onclick={() => onDelete(doc.id)}
										aria-label="Delete"
										class="w-7 h-7 flex items-center justify-center rounded hover:bg-red-500/20 text-slate-300 hover:text-red-400"
									>
										<Trash2 size={14} />
									</button>
								{/if}
							</div>
						</div>
					{/each}
				{/if}
			</div>
		</div>
	</div>
{/if}
