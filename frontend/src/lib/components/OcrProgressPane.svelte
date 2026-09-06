<script lang="ts">
	interface Props {
		ocrProgress: { done: number; total: number } | null;
		ocrEta: string;
	}

	let { ocrProgress, ocrEta }: Props = $props();

	let percent = $derived(ocrProgress?.total ? Math.round((ocrProgress.done / ocrProgress.total) * 100) : 0);
</script>

<div class="grid md:grid-cols-2 gap-4">
	<div class="bg-slate-800 rounded-xl border border-slate-700 p-6 flex flex-col justify-center min-h-[420px]">
		<h3 class="text-xl font-semibold text-slate-100 mb-6">Extracting text</h3>
		<div class="w-full h-3 bg-slate-900 rounded-full overflow-hidden border border-slate-700">
			<div class="h-full bg-sky-500 transition-all" style="width: {percent}%"></div>
		</div>
		<div class="text-sm text-slate-400 mt-2 tabular-nums">
			{percent}% | {ocrProgress ? `${ocrProgress.done}/${ocrProgress.total} pages` : 'starting…'}
			{#if ocrEta} | {ocrEta} left{/if}
		</div>
	</div>
	<div class="bg-slate-800 rounded-xl border border-slate-700 p-6 flex items-center justify-center min-h-[420px]">
		<div class="text-xl font-semibold text-slate-100">Extracting text…</div>
	</div>
</div>
