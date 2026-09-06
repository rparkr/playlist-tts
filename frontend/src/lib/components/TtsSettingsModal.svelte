<script lang="ts">
	import { X } from 'lucide-svelte';
	import type { VoiceRecord } from '$lib/stores/library';

	interface Props {
		open: boolean;
		onClose: () => void;
		useBackendTTS: boolean;
		onEngineChange: (useBackend: boolean) => void;
		builtinVoices: { name: string }[];
		customVoices: VoiceRecord[];
		synthVoices: SpeechSynthesisVoice[];
		selectedVoiceId: string;
		onVoiceChange: (id: string) => void;
		synthRate: number;
		onRateChange: (rate: number) => void;
		onVoiceFile: (e: Event) => void;
		isBackendGenerating: boolean;
	}

	let {
		open,
		onClose,
		useBackendTTS,
		onEngineChange,
		builtinVoices,
		customVoices,
		synthVoices,
		selectedVoiceId,
		onVoiceChange,
		synthRate,
		onRateChange,
		onVoiceFile,
		isBackendGenerating
	}: Props = $props();

	let rateInput: string = $state('1.00');

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
							onclick={() => onEngineChange(false)}
							class="px-4 py-1.5 text-sm font-medium transition-colors {!useBackendTTS
								? 'bg-sky-600 text-white'
								: 'bg-slate-700 text-slate-300 hover:bg-slate-600'}"
						>
							Built in
						</button>
						<button
							onclick={() => onEngineChange(true)}
							class="px-4 py-1.5 text-sm font-medium transition-colors {useBackendTTS
								? 'bg-sky-600 text-white'
								: 'bg-slate-700 text-slate-300 hover:bg-slate-600'}"
						>
							Pocket TTS
						</button>
					</div>
				</div>
				{#if useBackendTTS && isBackendGenerating}
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
						{#if !useBackendTTS}
							<optgroup label="Device voices">
								{#each synthVoices as voice, i}
									<option value={voice.name}>{voice.name} ({voice.lang})</option>
								{/each}
								{#if synthVoices.length === 0}
									<option value="">Default</option>
								{/if}
							</optgroup>
							{#if customVoices.length}
								<optgroup label="My voices (requires Pocket TTS)">
									{#each customVoices as cv}
										<option value={cv.id}>{cv.name} · {(cv.bytes / 1024 / 1024).toFixed(1)} MB</option>
									{/each}
								</optgroup>
							{/if}
						{:else}
							<optgroup label="Built-in (server)">
								{#each builtinVoices as v}
									<option value={v.name}>{v.name}</option>
								{/each}
							</optgroup>
							{#if customVoices.length}
								<optgroup label="My voices (IndexedDB)">
									{#each customVoices as cv}
										<option value={cv.id}>{cv.name} · {(cv.bytes / 1024 / 1024).toFixed(1)} MB</option>
									{/each}
								</optgroup>
							{/if}
							<optgroup label="Device voices (fallback)">
								{#each synthVoices as voice}
									<option value={voice.name}>{voice.name} ({voice.lang})</option>
								{/each}
							</optgroup>
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
