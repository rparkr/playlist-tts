<script lang="ts">
	import { X, Info } from 'lucide-svelte';

	interface Props {
		open: boolean;
		onClose: () => void;
		optCombine: boolean;
		optPunct: boolean;
		optPageMarkers: boolean;
		optUppercase: boolean;
		onCombineChange: (v: boolean) => void;
		onPunctChange: (v: boolean) => void;
		onPageMarkersChange: (v: boolean) => void;
		onUppercaseChange: (v: boolean) => void;
		hasDirtyEdits: boolean;
		onApply: () => void;
	}

	let {
		open,
		onClose,
		optCombine,
		optPunct,
		optPageMarkers,
		optUppercase,
		onCombineChange,
		onPunctChange,
		onPageMarkersChange,
		onUppercaseChange,
		hasDirtyEdits,
		onApply
	}: Props = $props();

	function onBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onClose();
	}

	let tooltip: string | null = $state(null);
</script>

{#if open}
	<div class="fixed inset-0 z-50 flex items-center justify-center md:p-4" role="dialog" aria-modal="true" aria-label="Postprocessing settings">
		<button class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick={onBackdropClick} aria-label="Close" tabindex="-1"></button>
		<div class="relative w-full h-full md:h-auto md:max-w-md bg-slate-800 md:rounded-xl shadow-xl flex flex-col overflow-hidden">
			<div class="flex items-center justify-between px-5 py-4 border-b border-slate-700">
				<h2 class="text-lg font-semibold text-slate-100">Postprocessing</h2>
				<button onclick={onClose} aria-label="Close" class="w-8 h-8 flex items-center justify-center rounded-md hover:bg-slate-700 text-slate-300">
					<X size={18} />
				</button>
			</div>

			<div class="flex-1 overflow-auto p-5 flex flex-col gap-4">
				{#if hasDirtyEdits}
					<div class="bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs px-3 py-2 rounded-md">
						You have edited the Markdown. Re-rendering will keep your edits and apply the new settings on top.
					</div>
				{/if}

				<label class="flex items-start gap-3 cursor-pointer group">
					<input
						type="checkbox"
						checked={optCombine}
						onchange={(e) => onCombineChange((e.target as HTMLInputElement).checked)}
						class="mt-0.5 accent-sky-500"
					/>
					<span class="flex-1">
						<span class="text-sm text-slate-200 flex items-center gap-1">
							Reflow columns
							<span class="relative inline-flex">
								<button
									type="button"
									class="text-slate-400 hover:text-slate-200"
									aria-label="Info about reflow"
									aria-describedby={tooltip === 'combine' ? 'tooltip-combine' : undefined}
									onmouseenter={() => (tooltip = 'combine')}
									onmouseleave={() => (tooltip = null)}
									onfocus={() => (tooltip = 'combine')}
									onblur={() => (tooltip = null)}
									onclick={(e) => {
										e.preventDefault();
										e.stopPropagation();
										tooltip = tooltip === 'combine' ? null : 'combine';
									}}
								>
									<Info size={14} />
								</button>
								{#if tooltip === 'combine'}
									<span
										id="tooltip-combine"
										role="tooltip"
										class="pointer-events-none absolute top-full left-1/2 z-20 mt-2 w-56 -translate-x-1/2 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-2 text-xs font-normal text-slate-300 shadow-xl"
										>Combine trailing paragraphs where a sentence continues in the next column or page.</span
									>
								{/if}
							</span>
						</span>
					</span>
				</label>

				<label class="flex items-start gap-3 cursor-pointer">
					<input
						type="checkbox"
						checked={optPunct}
						onchange={(e) => onPunctChange((e.target as HTMLInputElement).checked)}
						class="mt-0.5 accent-sky-500"
					/>
					<span class="flex-1">
						<span class="text-sm text-slate-200 flex items-center gap-1">
							Ensure punctuation
							<span class="relative inline-flex">
								<button
									type="button"
									class="text-slate-400 hover:text-slate-200"
									aria-label="Info about ensure punctuation"
									aria-describedby={tooltip === 'punct' ? 'tooltip-punct' : undefined}
									onmouseenter={() => (tooltip = 'punct')}
									onmouseleave={() => (tooltip = null)}
									onfocus={() => (tooltip = 'punct')}
									onblur={() => (tooltip = null)}
									onclick={(e) => {
										e.preventDefault();
										e.stopPropagation();
										tooltip = tooltip === 'punct' ? null : 'punct';
									}}
								>
									<Info size={14} />
								</button>
								{#if tooltip === 'punct'}
									<span
										id="tooltip-punct"
										role="tooltip"
										class="pointer-events-none absolute top-full left-1/2 z-20 mt-2 w-56 -translate-x-1/2 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-2 text-xs font-normal text-slate-300 shadow-xl"
										>Add terminal punctuation to paragraphs (e.g., headers) to improve TTS pauses.</span
									>
								{/if}
							</span>
						</span>
					</span>
				</label>

				<label class="flex items-start gap-3 cursor-pointer">
					<input
						type="checkbox"
						checked={optPageMarkers}
						onchange={(e) => onPageMarkersChange((e.target as HTMLInputElement).checked)}
						class="mt-0.5 accent-sky-500"
					/>
					<span class="flex-1">
						<span class="text-sm text-slate-200 flex items-center gap-1">
							Page markers
							<span class="relative inline-flex">
								<button
									type="button"
									class="text-slate-400 hover:text-slate-200"
									aria-label="Info about page markers"
									aria-describedby={tooltip === 'pages' ? 'tooltip-pages' : undefined}
									onmouseenter={() => (tooltip = 'pages')}
									onmouseleave={() => (tooltip = null)}
									onfocus={() => (tooltip = 'pages')}
									onblur={() => (tooltip = null)}
									onclick={(e) => {
										e.preventDefault();
										e.stopPropagation();
										tooltip = tooltip === 'pages' ? null : 'pages';
									}}
								>
									<Info size={14} />
								</button>
								{#if tooltip === 'pages'}
									<span
										id="tooltip-pages"
										role="tooltip"
										class="pointer-events-none absolute top-full left-1/2 z-20 mt-2 w-56 -translate-x-1/2 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-2 text-xs font-normal text-slate-300 shadow-xl"
										>Insert "Page N." markers to help follow along with the book.</span
									>
								{/if}
							</span>
						</span>
					</span>
				</label>

				<label class="flex items-start gap-3 cursor-pointer">
					<input
						type="checkbox"
						checked={optUppercase}
						onchange={(e) => onUppercaseChange((e.target as HTMLInputElement).checked)}
						class="mt-0.5 accent-sky-500"
					/>
					<span class="flex-1">
						<span class="text-sm text-slate-200 flex items-center gap-1">
							Normalize uppercase
							<span class="relative inline-flex">
								<button
									type="button"
									class="text-slate-400 hover:text-slate-200"
									aria-label="Info about uppercase normalization"
									aria-describedby={tooltip === 'upper' ? 'tooltip-upper' : undefined}
									onmouseenter={() => (tooltip = 'upper')}
									onmouseleave={() => (tooltip = null)}
									onfocus={() => (tooltip = 'upper')}
									onblur={() => (tooltip = null)}
									onclick={(e) => {
										e.preventDefault();
										e.stopPropagation();
										tooltip = tooltip === 'upper' ? null : 'upper';
									}}
								>
									<Info size={14} />
								</button>
								{#if tooltip === 'upper'}
									<span
										id="tooltip-upper"
										role="tooltip"
										class="pointer-events-none absolute top-full left-1/2 z-20 mt-2 w-56 -translate-x-1/2 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-2 text-xs font-normal text-slate-300 shadow-xl"
										>Convert long uppercase words and uppercase runs to Title Case so TTS does not spell them as acronyms.</span
									>
								{/if}
							</span>
						</span>
					</span>
				</label>

				<button
					onclick={onApply}
					class="mt-2 w-full bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium py-2 rounded-md transition-colors"
				>
					Apply and re-render
				</button>
			</div>
		</div>
	</div>
{/if}
