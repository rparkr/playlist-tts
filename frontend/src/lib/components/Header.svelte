<script lang="ts">
	import { LibraryBig, PanelLeft } from 'lucide-svelte';

	interface Props {
		activeTitle: string | null;
		breadcrumbs: string;
		leftPaneVisible: boolean;
		onLogoClick: () => void;
		onLibraryClick: () => void;
		onToggleLeftPane: () => void;
	}

	let { activeTitle, breadcrumbs, leftPaneVisible, onLogoClick, onLibraryClick, onToggleLeftPane }: Props = $props();
</script>

<header class="sticky top-0 z-30 w-full bg-slate-900 border-b border-slate-800">
	<div class="mx-auto max-w-6xl w-full flex items-center justify-between gap-3 px-4 py-2.5">
		<!-- Logo -->
		<button onclick={onLogoClick} aria-label="Go to overview" title="Overview" class="flex items-center shrink-0 hover:opacity-90 transition-opacity cursor-pointer">
			<img src="/tts-logo.svg" alt="PDF to TTS" class="h-8 w-auto object-contain" />
		</button>

		<!-- Center title + breadcrumbs -->
		<div class="flex-1 min-w-0 text-center px-2">
			{#if activeTitle}
				<div class="text-sm font-semibold text-slate-100 truncate">{activeTitle}</div>
				{#if breadcrumbs}
					<div class="text-xs text-slate-400 truncate">{breadcrumbs}</div>
				{/if}
			{:else}
				<div class="text-xs text-slate-500 hidden md:block">No document selected</div>
			{/if}
		</div>

		<!-- Actions -->
		<div class="flex items-center gap-2 shrink-0">
			<button
				onclick={onToggleLeftPane}
				aria-label={leftPaneVisible ? 'Hide side pane' : 'Show side pane'}
				title="Show/hide the PDF / Playlist / Library pane"
				class="w-9 h-9 flex items-center justify-center rounded-md bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700 transition-colors {leftPaneVisible ? '' : 'opacity-60'}"
			>
				<PanelLeft size={20} />
			</button>
			<button
				onclick={onLibraryClick}
				aria-label="Open library"
				title="Open the playlist library"
				class="inline-flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700 text-sm font-medium px-3.5 py-1.5 rounded-md transition-colors"
			>
				<LibraryBig size={16} />
				<span class="hidden sm:inline">Library</span>
			</button>
		</div>
	</div>
</header>
