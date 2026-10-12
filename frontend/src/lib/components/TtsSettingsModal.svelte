<script lang="ts">
	import { Check, Pencil, Trash2, X, Download } from 'lucide-svelte';
	import type { VoiceRecord } from '$lib/stores/library';
	import { KOKORO_MODEL_BYTES, KOKORO_VOICES, type KokoroProgress } from '$lib/tts/kokoro';
	import { sortVoiceOptions, type TtsEngine } from '$lib/settings';

	function formatBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	}

	interface Props {
		open: boolean;
		onClose: () => void;
		ttsEngine: TtsEngine;
		onEngineChange: (engine: TtsEngine) => void;
		builtinVoices: { name: string }[];
		customVoices: VoiceRecord[];
		synthVoices: SpeechSynthesisVoice[];
		selectedVoiceId: string;
		onVoiceChange: (id: string) => void;
		onRenameVoice: (id: string, newName: string) => Promise<string | null>;
		onDeleteVoice: (id: string) => void;
		synthRate: number;
		onRateChange: (rate: number) => void;
		onVoiceFile: (e: Event) => void;
		isBackendGenerating: boolean;
		kokoroReady: boolean;
		kokoroDownloading: boolean;
		kokoroProgress: KokoroProgress | null;
		kokoroError: string | null;
		onDownloadKokoro: () => void;
	}

	let {
		open,
		onClose,
		ttsEngine,
		onEngineChange,
		builtinVoices,
		customVoices,
		synthVoices,
		selectedVoiceId,
		onVoiceChange,
		onRenameVoice,
		onDeleteVoice,
		synthRate,
		onRateChange,
		onVoiceFile,
		isBackendGenerating,
		kokoroReady,
		kokoroDownloading,
		kokoroProgress,
		kokoroError,
		onDownloadKokoro
	}: Props = $props();

	let rateInput: string = $state('1.00');

	// Inline rename state for the "My voices" management list.
	let editingVoiceId: string | null = $state(null);
	let editName: string = $state('');
	let renameError: string | null = $state(null);

	function startRename(cv: VoiceRecord) {
		editingVoiceId = cv.id;
		editName = cv.name;
		renameError = null;
	}

	function cancelRename() {
		editingVoiceId = null;
		editName = '';
		renameError = null;
	}

	async function saveRename(id: string) {
		const err = await onRenameVoice(id, editName);
		if (err) {
			renameError = err;
			return;
		}
		cancelRename();
	}

	// Alphabetical pickers with cloned voices pinned in the top optgroup.
	let sortedBuiltinVoices = $derived(sortVoiceOptions(builtinVoices));
	let sortedCustomVoices = $derived(sortVoiceOptions(customVoices));

	$effect(() => {
		// sync when prop changes
		rateInput = synthRate.toFixed(2);
	});

	function handleRateSlider(e: Event) {
		const v = parseFloat((e.target as HTMLInputElement).value);
		onRateChange(v);
	}

	function handleRateText(e: Event) {
		const raw = (e.target as HTMLInputElement).value;
		rateInput = raw;
		const v = parseFloat(raw);
		if (!isNaN(v)) {
			const clamped = Math.min(2.0, Math.max(0.5, Math.round(v * 10) / 10));
			onRateChange(clamped);
		}
	}

	function commitRateInput() {
		const v = parseFloat(rateInput);
		if (isNaN(v)) {
			rateInput = synthRate.toFixed(2);
			return;
		}
		const clamped = Math.min(2.0, Math.max(0.5, Math.round(v * 10) / 10));
		onRateChange(clamped);
		rateInput = clamped.toFixed(2);
	}

	function onBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onClose();
	}
</script>

{#if open}
	<div class="fixed inset-0 z-50 flex items-center justify-center md:p-4" role="dialog" aria-modal="true" aria-label="TTS Settings">
		<button class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick={onBackdropClick} aria-label="Close settings" tabindex="-1"
		></button>
		<div class="relative w-full h-full md:h-auto md:max-w-md bg-slate-800 md:rounded-xl shadow-xl flex flex-col overflow-hidden">
			<div class="flex items-center justify-between px-5 py-4 border-b border-slate-700">
				<h2 class="text-lg font-semibold text-slate-100">Text-to-speech Settings</h2>
				<button
					onclick={onClose}
					aria-label="Close"
					class="w-8 h-8 flex items-center justify-center rounded-md hover:bg-slate-700 text-slate-300"
				>
					<X size={18} />
				</button>
			</div>

			<div class="flex-1 overflow-auto p-5 flex flex-col gap-5">
				<!-- Engine -->
				<div class="flex items-center justify-between gap-4">
					<span class="text-sm font-medium text-slate-200">TTS engine</span>
					<div class="flex rounded-md overflow-hidden border border-slate-600">
						<button
							onclick={() => onEngineChange('device')}
							aria-label="Device voices"
							class="px-3 py-1.5 text-sm font-medium transition-colors {ttsEngine === 'device'
								? 'bg-sky-600 text-white'
								: 'bg-slate-700 text-slate-300 hover:bg-slate-600'}"
						>
							Built in
						</button>
						<button
							onclick={() => onEngineChange('pocket')}
							aria-label="Server Pocket TTS"
							class="px-3 py-1.5 text-sm font-medium transition-colors {ttsEngine === 'pocket'
								? 'bg-sky-600 text-white'
								: 'bg-slate-700 text-slate-300 hover:bg-slate-600'}"
						>
							Pocket TTS
						</button>
						<button
							onclick={() => onEngineChange('browser')}
							aria-label="Browser Kokoro"
							class="px-3 py-1.5 text-sm font-medium transition-colors {ttsEngine === 'browser'
								? 'bg-sky-600 text-white'
								: 'bg-slate-700 text-slate-300 hover:bg-slate-600'}"
						>
							Browser
						</button>
					</div>
				</div>
				{#if ttsEngine !== 'device' && isBackendGenerating}
					<div class="text-xs text-slate-400 -mt-3">Generating…</div>
				{/if}
				{#if ttsEngine === 'browser'}
					<div class="flex flex-col gap-2 rounded-md border border-slate-700 bg-slate-900/60 p-3">
						<span class="text-xs font-medium text-slate-300">Browser voice model ({formatBytes(KOKORO_MODEL_BYTES)}, one-time)</span>
						{#if kokoroReady}
							<div class="text-xs text-emerald-400">✓ Downloaded — works offline, no server needed.</div>
						{:else if kokoroDownloading}
							<div class="h-2 rounded bg-slate-700 overflow-hidden">
								<div
									class="h-full bg-sky-500 transition-all"
									style="width: {kokoroProgress && kokoroProgress.total > 0 ? Math.round((kokoroProgress.loaded / kokoroProgress.total) * 100) : 0}%"
								></div>
							</div>
							<div class="text-xs text-slate-400 tabular-nums">
								{kokoroProgress ? `${formatBytes(kokoroProgress.loaded)} / ${formatBytes(kokoroProgress.total)}` : 'Starting…'}
							</div>
						{:else}
							<button
								onclick={onDownloadKokoro}
								class="inline-flex items-center gap-1.5 self-start text-xs px-3 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white font-medium"
							>
								<Download size={13} /> Download model
							</button>
						{/if}
						{#if kokoroError}
							<div class="text-xs text-red-400">{kokoroError}</div>
						{/if}
						<div class="text-xs text-slate-500">Runs Kokoro in this tab (WebAssembly). Two top-grade voices; the model stays cached for offline use.</div>
					</div>
				{/if}

				<!-- Voice -->
				<div class="flex flex-col gap-2">
					<label for="voice-select" class="text-sm font-medium text-slate-200">Voice</label>
					<select
						id="voice-select"
						value={selectedVoiceId}
						onchange={(e) => onVoiceChange((e.target as HTMLSelectElement).value)}
						class="w-full bg-slate-900 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-sky-500"
					>
					{#if ttsEngine === 'device'}
						{#if sortedCustomVoices.length}
							<optgroup label="My voices (requires Pocket TTS)">
								{#each sortedCustomVoices as cv}
									<option value={cv.id}>{cv.name} · {(cv.bytes / 1024 / 1024).toFixed(1)} MB</option>
								{/each}
							</optgroup>
						{/if}
						<optgroup label="Device voices">
							{#each synthVoices as voice, i}
								<option value={voice.name}>{voice.name} ({voice.lang})</option>
							{/each}
							{#if synthVoices.length === 0}
								<option value="">Default</option>
							{/if}
						</optgroup>
					{:else if ttsEngine === 'browser'}
						<optgroup label="Kokoro voices (browser)">
							{#each KOKORO_VOICES as v}
								<option value={v.id}>{v.label}</option>
							{/each}
						</optgroup>
					{:else}
						{#if sortedCustomVoices.length}
							<optgroup label="My voices (IndexedDB)">
								{#each sortedCustomVoices as cv}
									<option value={cv.id}>{cv.name} · {(cv.bytes / 1024 / 1024).toFixed(1)} MB</option>
								{/each}
							</optgroup>
						{/if}
						<optgroup label="Built-in (server)">
							{#each sortedBuiltinVoices as v}
								<option value={v.name}>{v.name}</option>
							{/each}
						</optgroup>
						{#if ttsEngine === 'pocket'}
							<optgroup label="Device voices (fallback)">
								{#each synthVoices as voice}
									<option value={voice.name}>{voice.name} ({voice.lang})</option>
								{/each}
							</optgroup>
						{/if}
					{/if}
					</select>

					<div class="text-xs text-slate-400">
						Voice cloning — upload .wav/.mp3 (auto-converts) or .safetensors directly.
					</div>
					<input
						type="file"
						accept=".wav,.mp3,.flac,.m4a,.safetensors"
						onchange={onVoiceFile}
						class="w-full text-xs text-slate-300 file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:bg-slate-700 file:text-slate-200 hover:file:bg-slate-600"
					/>
					{#if customVoices.find((v) => v.id === selectedVoiceId)}
						<div class="text-xs text-sky-400">✓ Cloned voice: {customVoices.find((v) => v.id === selectedVoiceId)?.name}</div>
					{/if}
					{#if sortedCustomVoices.length}
						<div class="flex flex-col gap-1.5 rounded-md border border-slate-700 bg-slate-900/60 p-2.5">
							<span class="text-xs font-medium text-slate-300">Manage cloned voices</span>
							{#each sortedCustomVoices as cv (cv.id)}
								<div class="flex items-center gap-2">
									{#if editingVoiceId === cv.id}
										<input
											type="text"
											bind:value={editName}
											onkeydown={(e) => {
												if (e.key === 'Enter') void saveRename(cv.id);
												if (e.key === 'Escape') cancelRename();
											}}
											class="min-w-0 flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm text-slate-100 focus:outline-none focus:border-sky-500"
											aria-label="Voice name"
										/>
										<button
											onclick={() => void saveRename(cv.id)}
											aria-label="Save name"
											title="Save name"
											class="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-700 text-emerald-400"
										>
											<Check size={15} />
										</button>
										<button
											onclick={cancelRename}
											aria-label="Cancel rename"
											title="Cancel rename"
											class="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-700 text-slate-400"
										>
											<X size={15} />
										</button>
									{:else}
										<span class="min-w-0 flex-1 truncate text-sm text-slate-200">{cv.name}</span>
										<span class="text-xs text-slate-500 tabular-nums">{(cv.bytes / 1024 / 1024).toFixed(1)} MB</span>
										<button
											onclick={() => startRename(cv)}
											aria-label={`Rename ${cv.name}`}
											title="Rename"
											class="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200"
										>
											<Pencil size={15} />
										</button>
										<button
											onclick={() => onDeleteVoice(cv.id)}
											aria-label={`Delete ${cv.name}`}
											title="Delete"
											class="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-700 text-slate-400 hover:text-red-400"
										>
											<Trash2 size={15} />
										</button>
									{/if}
								</div>
								{#if renameError && editingVoiceId === cv.id}
									<div class="text-xs text-red-400">{renameError}</div>
								{/if}
							{/each}
						</div>
					{/if}
				</div>

				<!-- Rate -->
				<div class="flex flex-col gap-2">
					<label for="rate-slider" class="text-sm font-medium text-slate-200">Speech rate</label>
					<div class="flex items-center gap-3">
						<input
							id="rate-slider"
							type="range"
							min="0.5"
							max="2"
							step="0.1"
							value={synthRate}
							oninput={handleRateSlider}
							class="flex-1 accent-sky-500"
						/>
						<input
							type="text"
							inputmode="decimal"
							value={rateInput}
							oninput={handleRateText}
							onblur={commitRateInput}
							onkeydown={(e) => e.key === 'Enter' && (commitRateInput(), (e.target as HTMLInputElement).blur())}
							class="w-20 bg-slate-900 border border-slate-700 rounded-md px-2 py-1.5 text-sm text-center text-slate-100 focus:outline-none focus:border-sky-500"
							aria-label="Speech rate"
						/>
						<span class="text-xs text-slate-400">x</span>
					</div>
					<div class="text-xs text-slate-500">0.5x – 2.0x, step 0.1</div>
				</div>
			</div>
		</div>
	</div>
{/if}
