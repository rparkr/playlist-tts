<script lang="ts">
	import { ScanText, Settings2, X } from 'lucide-svelte';

	interface Props {
		open: boolean;
		totalPages: number;
		/** 1-indexed physical pages that need OCR. */
		pages: number[];
		/** Counts of OCR-worthy reasons, for the summary line. */
		reasons: Record<string, number>;
		/** True when browser parsing failed outright (offer whole-document OCR). */
		failure?: boolean;
		onRun: () => void;
		onKeep: () => void;
		onConfigure: () => void;
		onClose: () => void;
	}

	let {
		open,
		totalPages,
		pages,
		reasons,
		failure = false,
		onRun,
		onKeep,
		onConfigure,
		onClose
	}: Props = $props();

	const REASON_LABELS: Record<string, string> = {
		scanned: 'scanned images',
		garbled: 'garbled text',
		'vector-text': 'outlined text',
		'annotation-text': 'annotation-only text'
	};

	let reasonText = $derived(
		Object.entries(reasons)
			.filter(([reason]) => REASON_LABELS[reason])
			.map(([reason, count]) => `${count} ${REASON_LABELS[reason]}`)
			.join(' · ')
	);
	let visiblePages = $derived(pages.slice(0, 12));
	let extraPages = $derived(Math.max(0, pages.length - visiblePages.length));
	let allPages = $derived(pages.length >= totalPages);
</script>

{#if open}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="presentation">
		<div
			class="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-800 p-5 shadow-2xl"
			role="dialog"
			aria-modal="true"
			aria-labelledby="ocr-offer-title"
		>
			<div class="flex items-start gap-3">
				<div class="mt-0.5 rounded-lg bg-sky-500/15 p-2 text-sky-400">
					<ScanText size={20} />
				</div>
				<div class="min-w-0 flex-1">
					<h2 id="ocr-offer-title" class="text-base font-semibold text-slate-100">
						{failure ? 'Could not extract text' : `${pages.length} of ${totalPages} pages need OCR`}
					</h2>
					<p class="mt-1 text-sm text-slate-400">
						{failure
							? 'The browser parser could not read this PDF. LLM OCR can process the pages as images instead.'
							: 'These pages look like scans or unreadable text, so browser extraction may be incomplete.'}
					</p>
					{#if reasonText}
						<p class="mt-1 text-xs text-slate-500">{reasonText}</p>
					{/if}
				</div>
				<button
					type="button"
					class="rounded-md p-1 text-slate-400 hover:bg-slate-700 hover:text-slate-200"
					aria-label="Close"
					onclick={onClose}
				>
					<X size={18} />
				</button>
			</div>

			<div class="mt-4 flex flex-wrap gap-1.5 text-xs text-slate-300">
				{#each visiblePages as page (page)}
					<span class="rounded bg-slate-900 px-2 py-0.5 tabular-nums">Page {page}</span>
				{/each}
				{#if extraPages > 0}
					<span class="rounded bg-slate-900 px-2 py-0.5">and {extraPages} more</span>
				{/if}
			</div>

			{#if allPages}
				<p class="mt-3 text-xs text-amber-300/80">
					Keeping the current text may produce an empty document.
				</p>
			{/if}

			<div class="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
				<button
					type="button"
					class="inline-flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded-md border border-slate-600 text-slate-200 hover:bg-slate-700"
					onclick={onConfigure}
				>
					<Settings2 size={14} /> LLM settings
				</button>
				<div class="flex items-center gap-2">
					<button
						type="button"
						class="text-xs px-3 py-2 rounded-md border border-slate-600 text-slate-300 hover:bg-slate-700"
						onclick={onKeep}
					>
						{failure ? 'Cancel' : 'Keep current text'}
					</button>
					<button
						type="button"
						class="text-xs px-4 py-2 rounded-md bg-sky-600 text-white font-medium hover:bg-sky-500"
						onclick={onRun}
					>
						Run LLM OCR
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}
