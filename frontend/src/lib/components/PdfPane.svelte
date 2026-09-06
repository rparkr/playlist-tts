<script lang="ts">
	import { ChevronLeft, ChevronRight, Upload } from 'lucide-svelte';

	interface Props {
		pdfUrl: string | null;
		canvasEl: HTMLCanvasElement | null;
		pdfPageNum: number;
		pdfTotalPages: number;
		onPrev: () => void;
		onNext: () => void;
		onUploadClick: () => void;
	}

	let { pdfUrl, canvasEl = $bindable(), pdfPageNum, pdfTotalPages, onPrev, onNext, onUploadClick }: Props = $props();
</script>

<div class="bg-slate-800 rounded-xl border border-slate-700 flex flex-col overflow-hidden min-h-[420px] max-h-[70vh] md:max-h-none md:min-h-0 md:h-full">
	{#if pdfUrl}
		<div class="flex-1 min-h-0 overflow-auto flex flex-col items-center p-3 bg-slate-900/50">
			<canvas bind:this={canvasEl} class="max-w-full h-auto shrink-0 border border-slate-700 rounded bg-white shadow"></canvas>
		</div>
		<div class="shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-t border-slate-700 bg-slate-800">
			<button onclick={onPrev} disabled={pdfPageNum <= 1} class="w-8 h-8 flex items-center justify-center rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-slate-200">
				<ChevronLeft size={16} />
			</button>
			<span class="text-xs text-slate-400 tabular-nums">Page {pdfPageNum} / {pdfTotalPages || '—'}</span>
			<button onclick={onNext} disabled={pdfPageNum >= pdfTotalPages} class="w-8 h-8 flex items-center justify-center rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-slate-200">
				<ChevronRight size={16} />
			</button>
		</div>
		<div class="shrink-0 text-xs text-center text-slate-500 px-3 pb-2">Page controls move Markdown to stay synced</div>
	{:else}
		<div class="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 p-8 bg-slate-900/30">
			<div class="text-sm text-slate-300 text-center">No PDF loaded in this session</div>
			<button onclick={onUploadClick} class="inline-flex items-center gap-2 bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium px-4 py-2 rounded-md">
				<Upload size={16} />
				Upload PDF
			</button>
		</div>
	{/if}
</div>
