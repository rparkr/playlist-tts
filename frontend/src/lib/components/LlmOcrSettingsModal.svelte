<script lang="ts">
	import {
		AlertCircle,
		CheckCircle2,
		Eye,
		EyeOff,
		RefreshCw,
		X
	} from 'lucide-svelte';
	import {
		buildLlmPayload,
		type LlmOcrSettings
	} from '$lib/settings';
	import {
		fetchLlmModels,
		isVisionModel,
		testLlmConnection,
		visionLabel,
		type LlmModelInfo,
		type LlmOcrDefaults
	} from '$lib/ocr/llm';

	interface Props {
		open: boolean;
		onClose: () => void;
		settings: LlmOcrSettings;
		apiKey: string;
		rememberApiKey: boolean;
		defaults: LlmOcrDefaults | null;
		apiBase: string;
		onSave: (settings: LlmOcrSettings, apiKey: string, remember: boolean) => void;
	}

	let {
		open,
		onClose,
		settings,
		apiKey,
		rememberApiKey,
		defaults,
		apiBase,
		onSave
	}: Props = $props();

	let baseUrl = $state('');
	let model = $state('');
	let systemPrompt = $state('');
	let userPrompt = $state('');
	let concurrency: number | null = $state(null);
	let enableThinking = $state(false);
	let keyDraft = $state('');
	let rememberDraft = $state(false);
	let showKey = $state(false);

	let models: LlmModelInfo[] = $state([]);
	let modelsBaseUrl = $state('');
	let modelsLoading = $state(false);
	let modelsError = $state<string | null>(null);
	let showAllModels = $state(false);

	let testStatus: 'idle' | 'testing' | 'ok' | 'error' = $state('idle');
	let testMessage = $state('');

	let wasOpen = false;

	$effect(() => {
		if (open && !wasOpen) {
			baseUrl = settings.baseUrl ?? '';
			model = settings.model ?? '';
			systemPrompt = settings.systemMessage ?? defaults?.system_message ?? '';
			userPrompt = settings.userMessage ?? defaults?.user_message ?? '';
			concurrency = settings.concurrency ?? defaults?.concurrency ?? null;
			enableThinking = settings.enableThinking ?? defaults?.enable_thinking ?? false;
			keyDraft = apiKey;
			rememberDraft = rememberApiKey;
			models = [];
			modelsBaseUrl = '';
			modelsError = null;
			showAllModels = false;
			testStatus = 'idle';
			testMessage = '';
			showKey = false;
		}
		wasOpen = open;
	});

	let visibleModels = $derived(showAllModels ? models : models.filter(isVisionModel));
	let currentModel = $derived(models.find((m) => m.id === model) ?? null);

	function onBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onClose();
	}

	function draftSettings(): LlmOcrSettings {
		const sys =
			defaults && systemPrompt.trim() === defaults.system_message.trim()
				? null
				: systemPrompt.trim()
					? systemPrompt
					: null;
		const usr =
			defaults && userPrompt.trim() === defaults.user_message.trim()
				? null
				: userPrompt.trim()
					? userPrompt
					: null;
		const conc =
			defaults && concurrency === defaults.concurrency ? null : concurrency;
		const thinking =
			defaults && enableThinking === defaults.enable_thinking ? null : enableThinking;
		return {
			baseUrl: baseUrl.trim() || null,
			model: model.trim() || null,
			systemMessage: sys,
			userMessage: usr,
			concurrency: conc,
			enableThinking: thinking
		};
	}

	async function loadModels() {
		modelsLoading = true;
		modelsError = null;
		try {
			const res = await fetchLlmModels(
				apiBase,
				baseUrl.trim() || null,
				keyDraft.trim() || null
			);
			models = res.models;
			modelsBaseUrl = res.base_url;
		} catch (e: any) {
			modelsError = e?.message ?? String(e);
		} finally {
			modelsLoading = false;
		}
	}

	async function testConnection() {
		testStatus = 'testing';
		testMessage = '';
		try {
			const res = await testLlmConnection(
				apiBase,
				buildLlmPayload(draftSettings(), keyDraft)
			);
			testStatus = 'ok';
			testMessage = `Connected to ${res.model} in ${res.latency_ms} ms.`;
		} catch (e: any) {
			testStatus = 'error';
			testMessage = e?.message ?? String(e);
		}
	}

	function resetSystem() {
		systemPrompt = defaults?.system_message ?? '';
	}

	function resetUser() {
		userPrompt = defaults?.user_message ?? '';
	}

	function resetAll() {
		baseUrl = '';
		model = '';
		systemPrompt = defaults?.system_message ?? '';
		userPrompt = defaults?.user_message ?? '';
		concurrency = defaults?.concurrency ?? null;
		enableThinking = defaults?.enable_thinking ?? false;
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center md:p-4"
		role="dialog"
		aria-modal="true"
		aria-label="LLM OCR settings"
	>
		<button
			class="absolute inset-0 bg-black/60 backdrop-blur-sm"
			onclick={onBackdropClick}
			aria-label="Close"
			tabindex="-1"
		></button>
		<div
			class="relative flex h-full w-full flex-col overflow-hidden bg-slate-800 shadow-xl md:h-auto md:max-w-2xl md:rounded-xl"
		>
			<div class="flex items-center justify-between border-b border-slate-700 px-5 py-4">
				<div>
					<h2 class="text-lg font-semibold text-slate-100">LLM OCR settings</h2>
					<p class="text-xs text-slate-400">
						Connect to an OpenAI-compatible vision server and tune the per-page prompts.
					</p>
				</div>
				<button
					onclick={onClose}
					aria-label="Close"
					class="flex h-8 w-8 items-center justify-center rounded-md text-slate-300 hover:bg-slate-700"
				>
					<X size={18} />
				</button>
			</div>

			<div class="flex-1 overflow-auto p-5">
				{#if !defaults}
					<div class="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
						Server defaults are unavailable. You can still enter prompts manually.
					</div>
				{/if}

				<div class="flex flex-col gap-4">
					<div class="flex flex-col gap-3 rounded-lg border border-slate-700 bg-slate-900/40 p-3">
						<h3 class="text-xs font-semibold uppercase tracking-wide text-slate-400">Connection</h3>
						<label class="flex flex-col gap-1 text-sm text-slate-200">
							Base URL
							<input
								type="text"
								bind:value={baseUrl}
								placeholder={defaults?.base_url ?? 'http://127.0.0.1:9931/v1'}
								spellcheck="false"
								autocomplete="off"
								class="rounded-md border border-slate-600 bg-slate-900 px-2.5 py-1.5 text-sm text-slate-100"
							/>
							<span class="text-[11px] text-slate-500">
								Include the version suffix (usually <code>/v1</code>). Leave blank to use the server default.
							</span>
						</label>

						<div class="flex flex-col gap-1 text-sm text-slate-200">
							<span>API key</span>
							<div class="flex items-center gap-2">
								<input
									type={showKey ? 'text' : 'password'}
									bind:value={keyDraft}
									placeholder="Leave blank for local servers without auth"
									autocomplete="off"
									aria-label="API key"
									class="min-w-0 flex-1 rounded-md border border-slate-600 bg-slate-900 px-2.5 py-1.5 text-sm text-slate-100"
								/>
								<button
									type="button"
									onclick={() => (showKey = !showKey)}
									aria-label={showKey ? 'Hide API key' : 'Show API key'}
									class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-slate-600 text-slate-300 hover:bg-slate-700"
								>
									{#if showKey}<EyeOff size={15} />{:else}<Eye size={15} />{/if}
								</button>
							</div>
							<label class="mt-1 flex items-center gap-2 text-xs text-slate-400">
								<input type="checkbox" bind:checked={rememberDraft} class="accent-sky-500" />
								Remember this key on this device
							</label>
							<span class="text-[11px] text-slate-500">
								By default the key lives only in this tab's session storage.
							</span>
						</div>
					</div>

					<div class="flex flex-col gap-2 rounded-lg border border-slate-700 bg-slate-900/40 p-3">
						<div class="flex items-center justify-between gap-2">
							<h3 class="text-xs font-semibold uppercase tracking-wide text-slate-400">Model</h3>
							<button
								type="button"
								onclick={loadModels}
								disabled={modelsLoading}
								class="inline-flex items-center gap-1.5 rounded-md border border-slate-600 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50"
							>
								<RefreshCw size={13} class={modelsLoading ? 'animate-spin' : ''} />
								{modelsLoading ? 'Fetching…' : 'Fetch models'}
							</button>
						</div>

						<label class="flex flex-col gap-1 text-sm text-slate-200">
							Model
							<input
								type="text"
								bind:value={model}
								list="llm-ocr-model-options"
								placeholder={defaults?.model ?? 'Model name'}
								spellcheck="false"
								autocomplete="off"
								class="rounded-md border border-slate-600 bg-slate-900 px-2.5 py-1.5 text-sm text-slate-100"
							/>
							<datalist id="llm-ocr-model-options">
								{#each visibleModels as m (m.id)}
									<option value={m.id}>{m.name ?? m.id} — {visionLabel(m)}</option>
								{/each}
							</datalist>
						</label>

						<div class="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
							{#if currentModel}
								<span
									class="rounded-full border px-2 py-0.5 {currentModel.vision === true
										? 'border-emerald-500/40 text-emerald-300'
										: currentModel.vision === false
											? 'border-red-500/40 text-red-300'
											: 'border-amber-500/40 text-amber-300'}"
								>
									{visionLabel(currentModel)}
								</span>
							{/if}
							{#if models.length > 0}
								<span>{visibleModels.length} of {models.length} models</span>
								<label class="inline-flex items-center gap-1.5">
									<input type="checkbox" bind:checked={showAllModels} class="accent-sky-500" />
									Show models without vision support
								</label>
							{/if}
							{#if modelsBaseUrl}
								<span class="truncate">from {modelsBaseUrl}</span>
							{/if}
						</div>

						{#if modelsError}
							<div class="rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-xs text-red-200">
								{modelsError}
							</div>
						{/if}
					</div>

					<div class="flex flex-col gap-3 rounded-lg border border-slate-700 bg-slate-900/40 p-3">
						<div class="flex items-center justify-between gap-2">
							<h3 class="text-xs font-semibold uppercase tracking-wide text-slate-400">Prompts</h3>
							<button
								type="button"
								onclick={resetAll}
								class="text-xs text-slate-400 underline hover:text-slate-200"
							>
								Reset all
							</button>
						</div>

						<label class="flex flex-col gap-1 text-sm text-slate-200">
							<span class="flex items-center justify-between gap-2">
								System prompt
								<button
									type="button"
									onclick={resetSystem}
									class="text-[11px] text-slate-400 underline hover:text-slate-200"
								>
									Reset
								</button>
							</span>
							<textarea
								bind:value={systemPrompt}
								rows="3"
								class="resize-y rounded-md border border-slate-600 bg-slate-900 px-2.5 py-1.5 text-sm text-slate-100"
							></textarea>
						</label>

						<label class="flex flex-col gap-1 text-sm text-slate-200">
							<span class="flex items-center justify-between gap-2">
								User prompt
								<button
									type="button"
									onclick={resetUser}
									class="text-[11px] text-slate-400 underline hover:text-slate-200"
								>
									Reset
								</button>
							</span>
							<textarea
								bind:value={userPrompt}
								rows="6"
								class="resize-y rounded-md border border-slate-600 bg-slate-900 px-2.5 py-1.5 text-sm text-slate-100"
							></textarea>
						</label>
					</div>

					<details class="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
						<summary class="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400">
							Advanced
						</summary>
						<div class="mt-3 flex flex-col gap-3">
							<label class="flex items-center gap-3 text-sm text-slate-200">
								<span class="flex-1">
									Concurrency
									<span class="block text-[11px] text-slate-500">
										Max in-flight page requests. 0 = unbounded.
									</span>
								</span>
								<input
									type="number"
									min="0"
									step="1"
									value={concurrency ?? ''}
									oninput={(e) => {
										const raw = (e.target as HTMLInputElement).value;
										concurrency =
											raw === '' ? null : Math.max(0, Math.floor(parseInt(raw, 10) || 0));
									}}
									class="w-20 rounded border border-slate-600 bg-slate-900 px-2 py-1 text-sm text-slate-100"
								/>
							</label>
							<label class="flex items-center gap-2 text-sm text-slate-200">
								<input type="checkbox" bind:checked={enableThinking} class="accent-sky-500" />
								Enable thinking blocks (llama.cpp/Qwen)
							</label>
						</div>
					</details>
				</div>

				{#if testStatus !== 'idle'}
					<div
						class="mt-4 flex items-start gap-2 rounded-md border px-3 py-2 text-xs {testStatus === 'ok'
							? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
							: testStatus === 'error'
								? 'border-red-500/30 bg-red-500/10 text-red-200'
								: 'border-slate-600 bg-slate-900/50 text-slate-300'}"
					>
						{#if testStatus === 'ok'}
							<CheckCircle2 size={15} class="mt-0.5 shrink-0" />
						{:else if testStatus === 'error'}
							<AlertCircle size={15} class="mt-0.5 shrink-0" />
						{:else}
							<RefreshCw size={15} class="mt-0.5 shrink-0 animate-spin" />
						{/if}
						<span>{testStatus === 'testing' ? 'Testing connection…' : testMessage}</span>
					</div>
				{/if}
			</div>

			<div class="flex flex-wrap items-center justify-end gap-2 border-t border-slate-700 px-5 py-4">
				<button
					type="button"
					onclick={testConnection}
					disabled={testStatus === 'testing'}
					class="mr-auto rounded-md border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700 disabled:opacity-50"
				>
					Test connection
				</button>
				<button
					type="button"
					onclick={onClose}
					class="rounded-md border border-slate-600 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-700"
				>
					Cancel
				</button>
				<button
					type="button"
					onclick={() => onSave(draftSettings(), keyDraft.trim(), rememberDraft)}
					class="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-500"
				>
					Save
				</button>
			</div>
		</div>
	</div>
{/if}
