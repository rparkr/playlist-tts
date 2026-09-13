<script lang="ts">
	import { X, Pencil, Trash2, FileText, FileX2, Check } from 'lucide-svelte';
	import type { Doc } from '$lib/stores/library';
	import { getGlobalSentences } from '$lib/markdown/parse';

	interface Props {
		open: boolean;
		docs: Doc[];
		activeDocId: string | null;
		/** Cached PDF bytes per doc id, for storage UI. */
		pdfSizes?: Record<string, number>;
		onClose: () => void;
		onSelect: (id: string) => void;
		onDelete: (id: string) => void;
		onRename: (id: string, newTitle: string) => Promise<void>;
		onClearPdf?: (id: string) => Promise<void> | void;
	}

	let { open, docs, activeDocId, pdfSizes = {}, onClose, onSelect, onDelete, onRename, onClearPdf }: Props = $props();

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

	function formatBytes(bytes: number): string {
		if (!Number.isFinite(bytes) || bytes < 0) return '—';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
						{#if editingId === doc.id}
							<div class="flex-1 min-w-0 flex items-center gap-2">
								<FileText size={16} class="shrink-0 text-slate-400" />
								<span class="flex-1 min-w-0">
									<input
										bind:value={editValue}
										onkeydown={handleKey}
										onblur={commitEdit}
										onclick={(e) => e.stopPropagation()}
										class="w-full bg-slate-900 border border-sky-500 rounded px-2 py-1 text-sm text-slate-100 focus:outline-none"
										autofocus
									/>
								</span>
							</div>
						{:else}
							<button
								class="flex-1 min-w-0 text-left flex items-center gap-2"
								onclick={() => {
									onSelect(doc.id);
									onClose();
								}}
							>
								<FileText size={16} class="shrink-0 text-slate-400" />
								<span class="flex-1 min-w-0">
									<div class="text-sm font-medium text-slate-100 truncate">{doc.title}</div>
									<div class="text-xs text-slate-400">
										{doc.sections.length} sections · {getGlobalSentences(doc.sections).length} sentences{pdfSizes[doc.id] !== undefined
											? ` · 📄 PDF ${formatBytes(pdfSizes[doc.id])}`
											: doc.pageMap
												? ' · 📄 PDF'
												: ''}
									</div>
								</span>
							</button>
						{/if}

							<div class="flex items-center gap-1 shrink-0">
							{#if editingId === doc.id}
								<button
									onclick={commitEdit}
									onmousedown={(e) => e.preventDefault()}
									aria-label="Save"
									class="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-600 text-sky-400"
								>
									<Check size={14} />
								</button>
								<button
									onclick={cancelEdit}
									onmousedown={(e) => e.preventDefault()}
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
									{#if pdfSizes[doc.id] !== undefined && onClearPdf}
										<button
											onclick={() => onClearPdf?.(doc.id)}
											aria-label="Clear cached PDF"
											title="Clear cached PDF ({formatBytes(pdfSizes[doc.id])}) to save storage — text stays"
											class="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-600 text-slate-300 hover:text-amber-300"
										>
											<FileX2 size={14} />
										</button>
									{/if}
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
