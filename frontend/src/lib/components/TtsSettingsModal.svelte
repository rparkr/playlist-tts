<script lang="ts">
	import { Check, Pencil, Trash2, X } from 'lucide-svelte';
	import type { VoiceRecord } from '$lib/stores/library';
	import {
		engineVoiceFileFormat,
		groupAndSortVoices,
		localeToVoiceGroup,
		sortVoiceOptions,
		voiceFileFormat,
		type TtsEngine
	} from '$lib/settings';
	import { OFFLINE_FMTS, type OfflineAudioFmt } from '$lib/tts/offlineAudio';
	import type { PhononStatus } from '$lib/tts/phononBrowser';

	interface GroupableVoice {
		name: string;
		language?: string | null;
		dialect?: string | null;
		gender?: string | null;
	}

	interface Props {
		open: boolean;
		onClose: () => void;
		ttsEngine: TtsEngine;
		onEngineChange: (engine: TtsEngine) => void;
		builtinVoices: GroupableVoice[];
		/** Phonon's server catalog. */
		phononVoices: GroupableVoice[];
		/** Phonon's WASM catalog, available after the browser catalog loads. */
		phononBrowserVoices: GroupableVoice[];
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
		offlineFmt: OfflineAudioFmt;
		onOfflineFmtChange: (fmt: OfflineAudioFmt) => void;
		offlineUse: boolean;
		onOfflineUseChange: (use: boolean) => void;
		phononAvailable: boolean;
		pocketAvailable: boolean;
		phononStatus: PhononStatus;
		onPhononPreload: () => void;
	}

	let {
		open,
		onClose,
		ttsEngine,
		onEngineChange,
		builtinVoices,
		phononVoices,
		phononBrowserVoices,
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
		offlineFmt,
		onOfflineFmtChange,
		offlineUse,
		onOfflineUseChange,
		phononAvailable,
		pocketAvailable,
		phononStatus,
		onPhononPreload
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

	let isPocket = $derived(ttsEngine === 'pocket');
	let isBrowserPhonon = $derived(ttsEngine === 'phonon-browser');
	let isServerPhonon = $derived(ttsEngine === 'phonon');
	let isPhonon = $derived(isBrowserPhonon || isServerPhonon);

	// Cloned voices are stored per runtime: Pocket and Phonon voice files are
	// not interchangeable, so only show the ones this engine can load.
	let voiceFormat = $derived(engineVoiceFileFormat(ttsEngine));
	let sortedCustomVoices = $derived(
		sortVoiceOptions(customVoices.filter((v) => voiceFileFormat(v) === voiceFormat))
	);

	// Voice pickers grouped by language → dialect → gender, then alphabetically.
	let sortedBuiltinVoices = $derived(groupAndSortVoices(builtinVoices));
	let sortedPhononVoices = $derived(groupAndSortVoices(phononVoices));
	let sortedPhononBrowserVoices = $derived(groupAndSortVoices(phononBrowserVoices));
	let deviceVoices = $derived(
		synthVoices.map((voice) => ({
			name: voice.name,
			lang: voice.lang,
			...localeToVoiceGroup(voice.lang)
		}))
	);
	let sortedDeviceVoices = $derived(groupAndSortVoices(deviceVoices));

	/** Check if a voice list is grouped (array of { group, label, voices }) or flat. */
	function isGrouped(list: any[]): list is { group: string; label: string; voices: any[] }[] {
		return list.length > 0 && 'group' in list[0];
	}

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
				<div class="flex flex-col gap-2">
					<span class="text-sm font-medium text-slate-200">TTS engine</span>
					<div class="grid grid-cols-2 gap-1 rounded-md overflow-hidden border border-slate-600">
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
							disabled={!pocketAvailable}
							title={pocketAvailable ? undefined : 'Pocket TTS is not installed on the server'}
							class="px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed {ttsEngine === 'pocket'
								? 'bg-sky-600 text-white'
								: 'bg-slate-700 text-slate-300 hover:bg-slate-600'}"
						>
							Pocket TTS
						</button>
						<button
							onclick={() => onEngineChange('phonon')}
							aria-label="Server Phonon"
							disabled={!phononAvailable}
							title={phononAvailable ? undefined : 'Phonon is not installed on the server'}
							class="px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed {ttsEngine === 'phonon'
								? 'bg-sky-600 text-white'
								: 'bg-slate-700 text-slate-300 hover:bg-slate-600'}"
						>
							Phonon
						</button>
						<button
							onclick={() => onEngineChange('phonon-browser')}
							aria-label="Phonon in the browser"
							class="px-3 py-1.5 text-sm font-medium transition-colors {isBrowserPhonon
								? 'bg-sky-600 text-white'
								: 'bg-slate-700 text-slate-300 hover:bg-slate-600'}"
						>
							Phonon browser
						</button>
					</div>
					<div class="text-xs text-slate-500">
						{#if ttsEngine === 'device'}
							Uses the voices built into your device or browser.
						{:else if ttsEngine === 'pocket'}
							Legacy server engine with local voice cloning.
						{:else if ttsEngine === 'phonon'}
							Fast server engine; voices download on first use.
						{:else}
							Runs entirely in this browser after a one-time model download.
						{/if}
					</div>
				</div>
				{#if ttsEngine !== 'device' && isBackendGenerating}
					<div class="text-xs text-slate-400 -mt-3">Generating…</div>
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
						{#if isGrouped(sortedDeviceVoices)}
							{#each sortedDeviceVoices as g}
								<optgroup label={g.label}>
									{#each g.voices as voice}
										<option value={voice.name}>{voice.name} ({voice.lang})</option>
									{/each}
								</optgroup>
							{/each}
						{:else}
							<optgroup label="Device voices">
								{#each sortedDeviceVoices as voice}
									<option value={voice.name}>{voice.name} ({voice.lang})</option>
								{/each}
								{#if sortedDeviceVoices.length === 0}
									<option value="">Default</option>
								{/if}
							</optgroup>
						{/if}
					{:else if ttsEngine === 'pocket'}
						{#if sortedCustomVoices.length}
							<optgroup label="My voices (IndexedDB)">
								{#each sortedCustomVoices as cv}
									<option value={cv.id}>{cv.name} · {(cv.bytes / 1024 / 1024).toFixed(1)} MB</option>
								{/each}
							</optgroup>
						{/if}
						{#if isGrouped(sortedBuiltinVoices)}
							{#each sortedBuiltinVoices as g}
								<optgroup label={g.label}>
									{#each g.voices as v}
										<option value={v.name}>{v.name}</option>
									{/each}
								</optgroup>
							{/each}
						{:else}
							<optgroup label="Built-in (server)">
								{#each sortedBuiltinVoices as v}
									<option value={v.name}>{v.name}</option>
								{/each}
							</optgroup>
						{/if}
						<optgroup label="Device voices (fallback)">
							{#each synthVoices as voice}
								<option value={voice.name}>{voice.name} ({voice.lang})</option>
							{/each}
						</optgroup>
					{:else if ttsEngine === 'phonon'}
						{#if sortedCustomVoices.length}
							<optgroup label="My voices (Phonon files)">
								{#each sortedCustomVoices as cv}
									<option value={cv.id}>{cv.name} · {(cv.bytes / 1024 / 1024).toFixed(1)} MB</option>
								{/each}
							</optgroup>
						{/if}
						{#if isGrouped(sortedPhononVoices)}
							{#each sortedPhononVoices as g}
								<optgroup label={g.label}>
									{#each g.voices as v}
										<option value={v.name}>{v.name}</option>
									{/each}
								</optgroup>
							{/each}
						{:else}
							<optgroup label="Phonon voices (server)">
								{#each sortedPhononVoices as v}
									<option value={v.name}>{v.name}</option>
								{/each}
							</optgroup>
						{/if}
					{:else}
						{#if sortedCustomVoices.length}
							<optgroup label="My voices (Phonon files)">
								{#each sortedCustomVoices as cv}
									<option value={cv.id}>{cv.name} · {(cv.bytes / 1024 / 1024).toFixed(1)} MB</option>
								{/each}
							</optgroup>
						{/if}
						{#if isGrouped(sortedPhononBrowserVoices)}
							{#each sortedPhononBrowserVoices as g}
								<optgroup label={g.label}>
									{#each g.voices as v}
										<option value={v.name}>{v.name}</option>
									{/each}
								</optgroup>
							{/each}
						{:else}
							<optgroup label="Phonon voices (browser)">
								{#each sortedPhononBrowserVoices as v}
									<option value={v.name}>{v.name}</option>
								{/each}
							</optgroup>
						{/if}
					{/if}
					</select>

					{#if isPocket}
						<div class="text-xs text-slate-400">
							Voice cloning — upload .wav/.mp3 (auto-converts) or a Pocket .safetensors file.
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
					{:else if isPhonon}
						<div class="text-xs text-slate-400">
							Voice files — upload a precomputed .safetensors file from Gradium Studio.
							Pocket-format clones are not compatible.
						</div>
						<input
							type="file"
							accept=".safetensors"
							onchange={onVoiceFile}
							class="w-full text-xs text-slate-300 file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:bg-slate-700 file:text-slate-200 hover:file:bg-slate-600"
						/>
						{#if customVoices.find((v) => v.id === selectedVoiceId)}
							<div class="text-xs text-sky-400">✓ Cloned voice: {customVoices.find((v) => v.id === selectedVoiceId)?.name}</div>
						{/if}
					{/if}
					{#if isBrowserPhonon}
						<div class="flex flex-col gap-1.5 rounded-md border border-slate-700 bg-slate-900/60 p-2.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-300">Browser model</span>
								{#if phononStatus.kind === 'ready'}
									<span class="text-xs text-emerald-400">
										{phononStatus.device === 'webgpu'
											? 'WebGPU'
											: `CPU · ${phononStatus.threads} thread${phononStatus.threads === 1 ? '' : 's'}`}
									</span>
								{:else if phononStatus.kind === 'loading'}
									<span class="text-xs text-sky-400">Loading…</span>
								{:else if phononStatus.kind === 'error' || phononStatus.kind === 'unsupported'}
									<span class="text-xs text-red-400">Unavailable</span>
								{:else}
									<span class="text-xs text-slate-500">Not loaded</span>
								{/if}
							</div>
							{#if phononStatus.kind === 'loading'}
								<div class="h-1.5 rounded bg-slate-700 overflow-hidden">
									<div
										class="h-full bg-sky-500 transition-all"
										style="width: {phononStatus.progress === null ? 100 : Math.round(phononStatus.progress * 100)}%"
									></div>
								</div>
								<div class="text-xs text-slate-400">{phononStatus.message}</div>
							{:else if phononStatus.kind === 'error' || phononStatus.kind === 'unsupported'}
								<div class="text-xs text-red-400">{phononStatus.message}</div>
							{:else if phononStatus.kind === 'ready'}
								<div class="text-xs text-slate-400">{phononStatus.message}</div>
								{#if phononStatus.threadsReason}
									<div class="text-xs text-slate-500">{phononStatus.threadsReason}</div>
								{/if}
							{:else}
								<div class="text-xs text-slate-400">
									Downloads about 65 MB once, then stays cached in this browser.
								</div>
								<button
									onclick={onPhononPreload}
									class="self-start rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500"
								>
									Load model now
								</button>
							{/if}
						</div>
					{/if}
					{#if ttsEngine !== 'device' && sortedCustomVoices.length}
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
				<!-- Offline chapter audio -->
				<div class="flex flex-col gap-2 rounded-md border border-slate-700 bg-slate-900/60 p-2.5">
					<span class="text-sm font-medium text-slate-200">Offline chapter audio</span>
					<label class="flex items-center gap-2 text-xs text-slate-300">
						<input
							type="checkbox"
							checked={offlineUse}
							onchange={(e) => onOfflineUseChange((e.target as HTMLInputElement).checked)}
							class="w-4 h-4 accent-sky-500"
						/>
						Play pre-generated file when available (lock-screen proof)
					</label>
					<label class="flex items-center gap-2 text-xs text-slate-300">
						Format
						<select
							value={offlineFmt}
							onchange={(e) => onOfflineFmtChange((e.target as HTMLSelectElement).value as OfflineAudioFmt)}
							class="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100 focus:outline-none focus:border-sky-500"
						>
							{#each OFFLINE_FMTS as fmt}
								<option value={fmt}>{fmt === 'webm' ? 'webm (smallest)' : fmt === 'mp3' ? 'mp3 (compatible)' : 'wav (largest)'}</option>
							{/each}
						</select>
					</label>
					<div class="text-xs text-slate-500">Pre-generate from the playlist item card; files live in the browser.</div>
				</div>
			</div>
		</div>
	</div>
{/if}
