<script lang="ts">
	import {
		ChevronsLeft,
		ChevronLeft,
		ChevronRight,
		ChevronsRight,
		Play,
		Pause,
		Settings
	} from 'lucide-svelte';

	interface Props {
		globalIdx: number;
		totalSentences: number;
		remainingText: string;
		isPlaying: boolean;
		onPrevSection: () => void;
		onPrevSentence: () => void;
		onToggle: () => void;
		onNextSentence: () => void;
		onNextSection: () => void;
		onSeek: (idx: number) => void;
		onSettings: () => void;
	}

	let {
		globalIdx,
		totalSentences,
		remainingText,
		isPlaying,
		onPrevSection,
		onPrevSentence,
		onToggle,
		onNextSentence,
		onNextSection,
		onSeek,
		onSettings
	}: Props = $props();

	let sliderMax = $derived(Math.max(0, totalSentences - 1));
</script>

<footer class="sticky bottom-0 z-30 w-full bg-slate-900 border-t border-slate-800">
	<div class="mx-auto max-w-6xl w-full flex flex-wrap md:flex-nowrap items-center gap-3 px-3 md:px-4 py-3">
		<!-- Controls -->
		<div class="flex items-center gap-1 shrink-0">
			<button
				onclick={onPrevSection}
				aria-label="Previous section"
				title="Previous section"
				class="w-9 h-9 flex items-center justify-center rounded-full bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors"
			>
				<ChevronsLeft size={18} />
			</button>
			<button
				onclick={onPrevSentence}
				aria-label="Previous sentence"
				title="Previous sentence"
				class="w-9 h-9 flex items-center justify-center rounded-full bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors"
			>
				<ChevronLeft size={18} />
			</button>
			<button
				onclick={onToggle}
				aria-label={isPlaying ? 'Pause' : 'Play'}
				title={isPlaying ? 'Pause' : 'Play'}
				class="w-12 h-12 flex items-center justify-center rounded-full bg-sky-600 hover:bg-sky-500 text-white transition-colors shadow"
			>
				{#if isPlaying}
					<Pause size={20} fill="white" />
				{:else}
					<Play size={20} fill="white" class="ml-0.5" />
				{/if}
			</button>
			<button
				onclick={onNextSentence}
				aria-label="Next sentence"
				title="Next sentence"
				class="w-9 h-9 flex items-center justify-center rounded-full bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors"
			>
				<ChevronRight size={18} />
			</button>
			<button
				onclick={onNextSection}
				aria-label="Next section"
				title="Next section"
				class="w-9 h-9 flex items-center justify-center rounded-full bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors"
			>
				<ChevronsRight size={18} />
			</button>
		</div>

		<!-- Slider -->
		<div class="flex-1 min-w-[140px] flex items-center gap-3 order-last md:order-none w-full md:w-auto">
			<input
				type="range"
				min="0"
				max={sliderMax}
				value={globalIdx}
				oninput={(e) => onSeek(parseInt((e.target as HTMLInputElement).value, 10))}
				disabled={totalSentences === 0}
				class="flex-1 h-2 accent-sky-500 disabled:opacity-50"
			/>
		</div>

		<!-- Progress + settings -->
		<div class="flex items-center gap-3 shrink-0 ml-auto md:ml-0">
			<div class="text-right leading-tight">
				<div class="text-sm font-medium text-slate-100 tabular-nums">
					{totalSentences ? `${globalIdx + 1} / ${totalSentences}` : '— / —'}
				</div>
				<div class="text-xs text-slate-400 tabular-nums">{remainingText || '—:—'}</div>
			</div>
			<button
				onclick={onSettings}
				aria-label="TTS settings"
				title="TTS settings"
				class="w-9 h-9 flex items-center justify-center rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
			>
				<Settings size={18} />
			</button>
		</div>
	</div>
</footer>
