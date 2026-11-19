<script lang="ts">
	import { onMount, tick } from 'svelte';
	import {
		createDoc,
		createDocFromPages,
		getAllDocs,
		getDoc,
		getDocBySlugOrId,
		ensureAllDocSlugs,
		renameDoc as renameDocStore,
		deleteDoc,
		saveDoc,
		reapplyPostprocessing,
		getVoices as getCustomVoices,
		saveVoice,
		renameVoice,
		deleteVoice,
		migrateFromLocalStorage,
		savePdf,
		getPdf,
		deletePdf,
		getPdfSizes,
		deleteOfflineAudio,
		getOfflineAudio,
		getOfflineAudioMeta,
		offlineAudioKey,
		saveOfflineAudio,
		saveDocAssets,
		hasDocAssets,
		createPlaylist,
		getPlaylists,
		getAllItems,
		renamePlaylist,
		deletePlaylist,
		touchPlaylistListened,
		getPlaylistItems,
		addPlaylistItem,
		renamePlaylistItem,
		deletePlaylistItem,
		deleteItemsByDocId,
		movePlaylistItem,
		updatePlaylistItemProgress,
		type Doc,
		type OfflineAudioMeta,
		type VoiceRecord,
		type Playlist,
		type PlaylistItem,
		type ItemSource,
		type PostprocessOptions
	} from '$lib/stores/library';
	import {
		parseMarkdownStructure,
		findPageMarkerIndex,
		findPageForSentence,
		logicalToPhysical,
		physicalToLogical,
		getGlobalSentences,
		globalToSectionChunk,
		sectionChunkToGlobal,
		selectSections,
		type Section
	} from '$lib/markdown/parse';
	import {
		createTTSFileJob,
		getTTSDownloadUrl,
		fetchTTSWavStream,
		type ServerTtsEngine
	} from '$lib/tts/backendStream';
	import { BackendSentencePlayer } from '$lib/tts/backendSentencePlayer';
	import {
		ensurePhononModel,
		fetchPhononWav,
		getPhononStatus,
		listPhononVoices,
		subscribePhononStatus,
		type PhononStatus,
		type PhononVoice
	} from '$lib/tts/phononBrowser';
	import {
		clearMediaMetadata,
		setMediaActionHandlers,
		setMediaPlaybackState,
		updateMediaMetadata
	} from '$lib/tts/mediaSession';
	import { chunkForSentence, deriveTts, speakable } from '$lib/tts/deriveTts';
	import {
		generateOfflineAudioBlob,
		hashSpeakableText,
		isOfflineAudioStale,
		joinSpeakableTexts,
		parseOfflineFmt,
		type OfflineAudioFmt
	} from '$lib/tts/offlineAudio';
	import { OfflinePlayer } from '$lib/tts/offlinePlayer';
	import { estimateRemainingSeconds, recordEtaSample } from '$lib/tts/etaStats';
	import Header from '$lib/components/Header.svelte';
	import PlayerBar from '$lib/components/PlayerBar.svelte';
	import { fly } from 'svelte/transition';
	import { FileText, ListMusic, LibraryBig, Settings2, X } from 'lucide-svelte';
	import Overview, {
		type OverviewPlaylistStat,
		type OverviewSearchHit
	} from '$lib/components/Overview.svelte';
	import PlaylistPane, {
		type PlaylistItemStat,
		type PlaylistOfflineState
	} from '$lib/components/PlaylistPane.svelte';
	import LibraryPane, { type LibraryPlaylistStat } from '$lib/components/LibraryPane.svelte';
	import TtsSettingsModal from '$lib/components/TtsSettingsModal.svelte';
	import PostprocessingModal from '$lib/components/PostprocessingModal.svelte';
	import LlmOcrSettingsModal from '$lib/components/LlmOcrSettingsModal.svelte';
	import OcrOfferModal from '$lib/components/OcrOfferModal.svelte';
	import MarkdownPane from '$lib/components/MarkdownPane.svelte';
	import PdfPane from '$lib/components/PdfPane.svelte';
	import OcrProgressPane from '$lib/components/OcrProgressPane.svelte';
	import { formatEta, formatRemaining, measureEtaSeconds, tickDownEta } from '$lib/ocrEta';
	import { applyPostprocessing, applyPostprocessingPages } from '$lib/markdown/postprocess';
	import {
		analyzePdf,
		countReasons,
		extractPdfPages,
		ocrWorthyPages,
		type ComplexityPage
	} from '$lib/pdf/liteparse';
	import {
		mergeOcrResults,
		ocrPdfPages,
		ocrWholePdf,
		type OcrPagesResult
	} from '$lib/pdf/extract';
	import { domainOf, isEpubUrl, isPdfUrl, sourceLabel } from '$lib/playlists/model';
	import {
		LS_KEYS,
		URL_PARAMS,
		parseEngine,
		parseOfflineUse,
		parseRate,
		parseSentenceIndex,
		parsePostprocessFlags,
		parseVoiceByEngine,
		parseLlmOcrSettings,
		isBuiltinVoiceName,
		resolveVoiceId,
		serializePostprocessFlags,
		serializeLlmOcrSettings,
		serializeVoiceByEngine,
		buildLlmPayload,
		defaultLlmOcrSettings,
		voiceForEngine,
		voiceUrlParam,
		withVoiceForEngine,
		resolveWithUrlPrecedence,
		progressKey,
		isServerEngine,
		engineVoiceFileFormat,
		voiceFileFormat,
		ALL_TTS_ENGINES,
		type TtsEngine,
		type VoiceByEngine,
		type LlmOcrSettings,
		type LlmOcrPayload
	} from '$lib/settings';
	import { inspectVoiceFile } from '$lib/tts/voiceFile';
	import { fetchLlmDefaults, type LlmOcrDefaults } from '$lib/ocr/llm';

	// --- State ---
	let docs: Doc[] = $state([]);
	let customVoices: VoiceRecord[] = $state([]);
	/** Pocket's server voices. */
	let builtinVoices: {
		name: string;
		language?: string | null;
		dialect?: string | null;
		gender?: string | null;
	}[] = $state([]);
	/** Phonon's server voice catalog. */
	let phononVoices: {
		name: string;
		language?: string | null;
		dialect?: string | null;
		gender?: string | null;
	}[] = $state([]);
	/** Phonon WASM catalog, loaded when the browser engine is selected. */
	let phononBrowserVoices: PhononVoice[] = $state([]);
	let phononStatus: PhononStatus = $state(getPhononStatus());
	/** Server engine availability from `/api/tts/engines`. */
	let phononAvailable: boolean = $state(true);
	let pocketAvailable: boolean = $state(true);
	let activeDoc: Doc | null = $state(null);
	let pdfSizes: Record<string, number> = $state({});
	let markdownDraft: string = $state('');
	let pdfFile: File | null = $state.raw(null);
	let pdfUrl: string | null = $state(null);
	let pdfDoc: any = $state.raw(null);
	let pdfPageNum: number = $state(1);
	let pdfTotalPages: number = $state(0);
	// Set by the PDF prev/next buttons: the next Markdown→PDF follow
	// reaction belongs to that manual navigation, so it must not overwrite
	// the explicitly chosen page (missing-marker snap-back, #75).
	let pdfManualNav = false;
	// Phase 4 panel: slide-over overlay on mobile, left sidebar on
	// desktop. The reader stays Markdown-focused; PDF / playlist /
	// library live in the panel and are switched from its tab bar.
	let panel: 'pdf' | 'playlist' | 'library' | null = $state(null);
	let isOcrRunning: boolean = $state(false);
	let ocrProgress: { done: number; total: number } | null = $state(null);
	let ocrPhase: string = $state('Extracting text');
	let ocrStartAt: number | null = $state(null);
	// Anchored countdown ETA: each progress step sets a new anchor; the
	// per-second ticker only ever counts that anchor down.
	let ocrEtaSeconds: number | null = $state(null);
	let ocrEtaAnchoredAt: number | null = $state(null);
	let ocrNow: number = $state(Date.now());
	// Partial-OCR prompt: analysis found pages browser extraction cannot read.
	let ocrOffer: {
		totalPages: number;
		pages: number[];
		reasons: Record<string, number>;
		failure?: boolean;
	} | null = $state(null);
	let ocrOfferResolve: ((run: boolean) => void) | null = null;

	let globalIdx: number = $state(0);
	let isPlaying: boolean = $state(false);
	let ttsEngine: TtsEngine = $state('device');
	let sentencePlayer: BackendSentencePlayer | null = $state.raw(null);
	let selectedVoiceId: string = $state('alba');
	// Per-engine voice memory: each TTS engine remembers its own selection.
	let voiceByEngine: VoiceByEngine = $state({ device: null, pocket: null });
	let synthRate: number = $state(1.0);
	let toast: string | null = $state(null);

	let optCombine: boolean = $state(true);
	let optUppercase: boolean = $state(true);
	let optPageMarkers: boolean = $state(true);
	let optFirstPageMarker: boolean = $state(true);
	let optFirstPageNumber: number = $state(1);
	/** Extraction engine for the staging bar.
	 * `auto` parses in-browser and offers LLM OCR for unreadable pages;
	 * `liteparse` is browser-only; `llm` OCRs every page. */
	let optEngine: 'auto' | 'liteparse' | 'llm' = $state('auto');
	// Guard persistence writes until onMount has restored last-set state, so
	// default initial values never clobber localStorage on first render.
	let settingsHydrated: boolean = $state(false);

	// LLM OCR settings (connection, model, prompts). The API key is kept
	// separately: sessionStorage by default, localStorage only when the user
	// opts in via "Remember this key on this device".
	let llmSettings: LlmOcrSettings = $state(defaultLlmOcrSettings());
	let llmApiKey: string = $state('');
	let rememberLlmApiKey: boolean = $state(false);
	let llmDefaults: LlmOcrDefaults | null = $state(null);
	let showLlmSettings = $state(false);

	// Pre-OCR staging (#6): a newly selected PDF previews before any POST.
	// `pageOverrides` maps physical PDF pages → logical `Page N.` numbers.
	let pdfPendingOcr: boolean = $state(false);
	let pendingPdfName: string = $state('');
	let pageOverrides: Record<number, number> = $state({});
	/** Single consolidated file picker (PDF, Markdown, text, ePub — #83). */

	function currentPostprocessOpts(): PostprocessOptions {
		return {
			combine_columns: optCombine,
			normalize_uppercase: optUppercase,
			insert_page_markers: optPageMarkers,
			first_page_marker: optFirstPageMarker,
			first_page_number: optFirstPageNumber,
			page_overrides: Object.keys(pageOverrides).length > 0 ? { ...pageOverrides } : null
		};
	}

	function syncPostprocessOptsFromDoc(doc: Doc | null, persist = false) {
		if (!doc?.postprocess) return;
		optCombine = doc.postprocess.combine_columns;
		optUppercase = doc.postprocess.normalize_uppercase;
		optPageMarkers = doc.postprocess.insert_page_markers;
		optFirstPageMarker = doc.postprocess.first_page_marker ?? false;
		const n = doc.postprocess.first_page_number ?? 1;
		optFirstPageNumber = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
		if (persist) {
			try {
				localStorage.setItem(
					LS_KEYS.postprocess,
					serializePostprocessFlags({
						combine: optCombine,
						uppercase: optUppercase,
						pageMarkers: optPageMarkers,
						firstPageMarker: optFirstPageMarker,
						firstPageNumber: optFirstPageNumber
					})
				);
			} catch {
				// ignore — persistence is best-effort
			}
		}
	}

	let editorEl: HTMLTextAreaElement | null = $state(null);
	let canvasEl: HTMLCanvasElement | null = $state(null);
	let markdownPaneRef: any = $state(null);

	// UI state per plan
	let showTtsSettings = $state(false);
	let showPostprocess = $state(false);
	// Phase 4: overview view + Markdown-focused reader with a bottom-sheet
	// panel (PDF | Playlist | Library). The logo lands on the overview.
	let view: 'overview' | 'reader' = $state('reader');
	let isEditing = $state(false);
	let editBackup: string = $state('');

	// Playlist library (IndexedDB-only MVP).
	let playlists: Playlist[] = $state([]);
	let activePlaylistId: string | null = $state(null);
	let activeItemId: string | null = $state(null);
	let playlistItems: PlaylistItem[] = $state([]);
	let itemStats: Record<string, PlaylistItemStat> = $state({});
	let libraryStats: Record<string, LibraryPlaylistStat> = $state({});
	let overviewStats: OverviewPlaylistStat[] = $state([]);
	let overviewSearch: OverviewSearchHit[] = $state([]);
	/** Docs not referenced by any playlist item (library unassigned section). */
	let unassignedDocs: Doc[] = $state([]);
	/** New docs (OCR / upload / fetch / paste) land in this playlist when set. */
	let pendingPlaylistId: string | null = $state(null);
	/** Listen-now URL / paste dialogs from the overview page. */
	let urlDialogOpen = $state(false);
	let pasteDialogOpen = $state(false);
	let listenUrlValue: string = $state('');
	let listenPasteTitle: string = $state('');
	let listenPasteValue: string = $state('');

	let docInputEl: HTMLInputElement | null = $state(null);

	const API_BASE = (import.meta.env.PUBLIC_API_URL as string) ?? '';

	function showToast(msg: string) {
		toast = msg;
		setTimeout(() => (toast = null), 3000);
	}
	function cancelSpeech() {
		if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel();
	}

	async function refreshDocs() {
		await ensureAllDocSlugs();
		docs = await getAllDocs();
		customVoices = await getCustomVoices();
		try {
			pdfSizes = await getPdfSizes();
		} catch {
			pdfSizes = {};
		}
	}
	async function loadBuiltinVoices() {
		// `/engines` carries Phonon's catalog and Pocket availability. Pocket
		// voices are loaded later; older backends only have `/voices`, so
		// fall back to that for them.
		try {
			const r = await fetch(`${API_BASE}/api/tts/engines`);
			if (r.ok) {
				const data = await r.json();
				const engines = (data.engines ?? []) as {
					id: string;
					available?: boolean;
					voices?: { name: string; origin?: string }[];
				}[];
				const pocket = engines.find((e) => e.id === 'pocket');
				const phonon = engines.find((e) => e.id === 'phonon');
				pocketAvailable = pocket?.available ?? true;
				phononAvailable = phonon?.available ?? false;
				// Pocket's catalog is fetched lazily: reading it imports
				// PyTorch, which must not happen on a Phonon-only page load.
				builtinVoices = (pocket?.voices ?? []).map((v: any) => ({
					name: v.name,
					language: v.language ?? null,
					dialect: v.dialect ?? null,
					gender: v.gender ?? null
				}));
				phononVoices = (phonon?.voices ?? []).map((v: any) => ({
					name: v.name,
					language: v.language ?? null,
					dialect: v.dialect ?? null,
					gender: v.gender ?? null
				}));
				// The model always has its bundled default voice, even when the
				// remote catalog could not be fetched.
				if (phononAvailable && phononVoices.length === 0) phononVoices = [{ name: 'default' }];
				return;
			}
		} catch {
			// fall through to the legacy endpoint
		}
		try {
			const r = await fetch(`${API_BASE}/api/tts/voices`);
			if (r.ok) {
				const data = await r.json();
				builtinVoices = (data.voices ?? [{ name: 'alba' }]).map((v: any) => ({
					name: v.name,
					language: v.language ?? null,
					dialect: v.dialect ?? null,
					gender: v.gender ?? null
				}));
			} else builtinVoices = [{ name: 'alba' }];
		} catch {
			builtinVoices = [{ name: 'alba' }];
		}
		// Old backends have only Pocket.
		phononAvailable = false;
	}

	/** Fetch Pocket's catalog on first use (it imports PyTorch server-side). */
	let pocketVoicesPromise: Promise<void> | null = null;
	async function ensurePocketVoices(): Promise<void> {
		if (builtinVoices.length > 0) return;
		if (pocketVoicesPromise) return pocketVoicesPromise;
		pocketVoicesPromise = (async () => {
			try {
				const r = await fetch(`${API_BASE}/api/tts/voices?engine=pocket`);
				if (r.ok) {
					const data = await r.json();
					builtinVoices = (data.voices ?? []).map((v: any) => ({
						name: v.name,
						language: v.language ?? null,
						dialect: v.dialect ?? null,
						gender: v.gender ?? null
					}));
				}
			} catch {
				// Fall through to a usable fallback below.
			}
			if (builtinVoices.length === 0) {
				builtinVoices = [{ name: 'alba' }, { name: 'marius' }];
			}
			if (ttsEngine === 'pocket' && !voiceExistsFor('pocket', selectedVoiceId)) {
				selectedVoiceId = defaultVoiceFor('pocket');
				voiceByEngine = withVoiceForEngine(voiceByEngine, 'pocket', selectedVoiceId);
			}
		})().finally(() => {
			pocketVoicesPromise = null;
		});
		return pocketVoicesPromise;
	}

	/** Voices available to an engine, without device voices (resolved below). */
	function serverVoicesFor(engine: TtsEngine): { name: string }[] {
		if (engine === 'phonon') return phononVoices;
		if (engine === 'phonon-browser') return phononBrowserVoices;
		return builtinVoices;
	}

	/** Custom voice files this engine can load (Pocket and Phonon differ). */
	function customVoicesFor(engine: TtsEngine): VoiceRecord[] {
		const format = engineVoiceFileFormat(engine);
		return customVoices.filter((voice) => voiceFileFormat(voice) === format);
	}

	/** Find a custom voice only when it matches the engine's file format. */
	function findCustomVoiceFor(engine: TtsEngine, id: string): VoiceRecord | undefined {
		return customVoicesFor(engine).find((voice) => voice.id === id);
	}

	/** Built-in names for the current engine, used for clone-name collisions. */
	function builtinNamesFor(engine: TtsEngine): { name: string }[] {
		return serverVoicesFor(engine);
	}

	/** Fallback voice when the stored selection is not valid for `engine`. */
	function defaultVoiceFor(engine: TtsEngine): string {
		if (engine === 'device') return synthVoices[0]?.name ?? '';
		if (engine === 'phonon') return phononVoices[0]?.name ?? 'default';
		if (engine === 'phonon-browser') return phononBrowserVoices[0]?.name ?? 'default';
		return builtinVoices[0]?.name ?? 'alba';
	}

	/** True when `id` exists in the engine's current catalog. */
	function voiceExistsFor(engine: TtsEngine, id: string): boolean {
		if (!id) return false;
		if (engine === 'device') {
			// Device voices can populate after mount (`voiceschanged`), so
			// trust a stored name until the browser gives us the list.
			return synthVoices.length === 0 || synthVoices.some((v) => v.name === id);
		}
		if (findCustomVoiceFor(engine, id)) return true;
		if (engine === 'pocket') {
			// The built-in catalog is lazy; trust the stored name until it
			// arrives, then `ensurePocketVoices` repairs an invalid choice.
			return builtinVoices.length === 0 || builtinVoices.some((v) => v.name === id);
		}
		return serverVoicesFor(engine).some((v) => v.name === id);
	}

	/** Load the browser catalog and model status when that engine is chosen. */
	async function preparePhononBrowser(): Promise<void> {
		try {
			phononBrowserVoices = await listPhononVoices();
		} catch (e) {
			showToast(`Phonon voice catalog unavailable: ${(e as Error).message}`);
		}
		if (!voiceExistsFor('phonon-browser', selectedVoiceId)) {
			selectedVoiceId = defaultVoiceFor('phonon-browser');
			voiceByEngine = withVoiceForEngine(voiceByEngine, 'phonon-browser', selectedVoiceId);
		}
	}

	/** Start the one-time model download from the settings panel. */
	function preloadPhononBrowser(): void {
		ensurePhononModel().catch((e: unknown) =>
			showToast(`Phonon unavailable: ${(e as Error)?.message ?? e}`)
		);
	}

	onMount(async () => {
		await migrateFromLocalStorage();
		await refreshDocs();
		await loadBuiltinVoices();
		if (typeof window !== 'undefined' && window.speechSynthesis) {
			const load = () => {};
			window.speechSynthesis.onvoiceschanged = load;
			window.speechSynthesis.getVoices();
		}
		const url = new URL(window.location.href);
		const docParam = url.searchParams.get(URL_PARAMS.doc);
		const sParam = url.searchParams.get(URL_PARAMS.sentence);
		const rateParam = url.searchParams.get(URL_PARAMS.rate);
		const voiceParam = url.searchParams.get(URL_PARAMS.voice);
		const engineParam = url.searchParams.get(URL_PARAMS.engine);
		// TTS prefs: URL wins (shareable deep link), else last-set localStorage.
		const storedRate = localStorage.getItem(LS_KEYS.rate);
		const storedVoice = localStorage.getItem(LS_KEYS.voice);
		const storedEngine = localStorage.getItem(LS_KEYS.engine);
		synthRate = resolveWithUrlPrecedence(rateParam, storedRate, 1.0, parseRate);
		let engine = resolveWithUrlPrecedence(engineParam, storedEngine, 'device' as const, parseEngine);
		// A stale deep link or an install without the server engine should not
		// leave the reader on a broken picker.
		if ((engine === 'phonon' && !phononAvailable) || (engine === 'pocket' && !pocketAvailable)) {
			engine = 'device';
		}
		ttsEngine = engine;
		if (engine === 'pocket') await ensurePocketVoices();
		// Per-engine voice: stored map first, legacy single key migrates into
		// the current engine's slot, URL `voice` wins for the current engine.
		// The URL carries clone *names* (slugified); stored state keeps IDs.
		const storedMap = parseVoiceByEngine(localStorage.getItem(LS_KEYS.voiceByEngine)) ?? {};
		if (storedVoice && !storedMap[engine]) storedMap[engine] = storedVoice;
		if (voiceParam) {
			const fallbackVoice = storedMap[engine] ?? storedVoice ?? defaultVoiceFor(engine);
			storedMap[engine] = resolveVoiceId(
				voiceParam,
				{
					builtinVoices: serverVoicesFor(engine),
					customVoices: engine === 'device' ? [] : customVoicesFor(engine)
				},
				fallbackVoice
			);
		}
		voiceByEngine = storedMap;
		selectedVoiceId = voiceForEngine(voiceByEngine, engine, defaultVoiceFor(engine));
		if (!voiceExistsFor(engine, selectedVoiceId)) selectedVoiceId = defaultVoiceFor(engine);
		if (engine === 'phonon-browser') void preparePhononBrowser();
		// Postprocessing defaults: last-set global prefs until a doc overrides.
		const storedPostprocess = parsePostprocessFlags(localStorage.getItem(LS_KEYS.postprocess));
		if (storedPostprocess) {
			optCombine = storedPostprocess.combine;
			optUppercase = storedPostprocess.uppercase;
			optPageMarkers = storedPostprocess.pageMarkers;
			if (typeof storedPostprocess.firstPageMarker === 'boolean') optFirstPageMarker = storedPostprocess.firstPageMarker;
			if (typeof storedPostprocess.firstPageNumber === 'number') optFirstPageNumber = storedPostprocess.firstPageNumber;
		}
		const storedLlm = parseLlmOcrSettings(localStorage.getItem(LS_KEYS.llmOcr));
		if (storedLlm) llmSettings = storedLlm;
		const rememberedKey = localStorage.getItem(LS_KEYS.llmOcrKey);
		if (rememberedKey) {
			llmApiKey = rememberedKey;
			rememberLlmApiKey = true;
		} else {
			llmApiKey = sessionStorage.getItem(LS_KEYS.llmOcrKey) ?? '';
		}
		const urlSentence = parseSentenceIndex(sParam);
		if (docParam) {
			const d = await getDocBySlugOrId(docParam);
			if (d) {
				activeDoc = d;
				markdownDraft = d.markdown;
				renderBaseline = d.markdown;
				syncPostprocessOptsFromDoc(d, true);
				if (urlSentence !== null) {
					globalIdx = urlSentence;
				} else {
					const saved = localStorage.getItem(progressKey(d.id));
					if (saved) globalIdx = parseSentenceIndex(saved) ?? 0;
				}
			}
		} else {
			const last = localStorage.getItem(LS_KEYS.activeDocId);
			if (last) {
				const d = await getDocBySlugOrId(last);
				if (d) {
					activeDoc = d;
					markdownDraft = d.markdown;
					renderBaseline = d.markdown;
					syncPostprocessOptsFromDoc(d, true);
					if (urlSentence !== null) {
						globalIdx = urlSentence;
					} else {
						const saved = localStorage.getItem(progressKey(d.id));
						if (saved) globalIdx = parseSentenceIndex(saved) ?? 0;
					}
				}
			}
		}
		if (activeDoc) {
			// Restore the cached PDF so the viewer renders after reload/deep-link.
			await loadCachedPdf(activeDoc.id);
		}
		offlineFmt = parseOfflineFmt(localStorage.getItem(LS_KEYS.offlineFmt)) ?? 'webm';
		offlineUse = parseOfflineUse(localStorage.getItem(LS_KEYS.offlineUse)) ?? true;
		await refreshPlaylistData();
		// Fresh profiles (no restored doc) land on the overview page.
		if (!activeDoc) view = 'overview';
		settingsHydrated = true;
	});

	$effect(() => {
		if (!settingsHydrated) return;
		if (activeDoc) {
			localStorage.setItem(LS_KEYS.activeDocId, activeDoc.id);
			localStorage.setItem(progressKey(activeDoc.id), String(globalIdx));
			if (activeItemId) {
				// Mirror reader progress onto the playlist item card.
				void updatePlaylistItemProgress(activeItemId, globalIdx, totalSentences);
			}
		}
		localStorage.setItem(LS_KEYS.rate, String(synthRate));
		localStorage.setItem(LS_KEYS.voice, selectedVoiceId);
		localStorage.setItem(LS_KEYS.voiceByEngine, serializeVoiceByEngine(voiceByEngine));
		localStorage.setItem(LS_KEYS.engine, ttsEngine);
		localStorage.setItem(LS_KEYS.offlineFmt, offlineFmt);
		localStorage.setItem(LS_KEYS.offlineUse, offlineUse ? '1' : '0');
		localStorage.setItem(
			LS_KEYS.postprocess,
			serializePostprocessFlags({
				combine: optCombine,
				uppercase: optUppercase,
				pageMarkers: optPageMarkers,
				firstPageMarker: optFirstPageMarker,
				firstPageNumber: optFirstPageNumber
			})
		);
		localStorage.setItem(LS_KEYS.llmOcr, serializeLlmOcrSettings(llmSettings));
		if (rememberLlmApiKey && llmApiKey) {
			localStorage.setItem(LS_KEYS.llmOcrKey, llmApiKey);
		} else {
			localStorage.removeItem(LS_KEYS.llmOcrKey);
		}
		if (llmApiKey) {
			sessionStorage.setItem(LS_KEYS.llmOcrKey, llmApiKey);
		} else {
			sessionStorage.removeItem(LS_KEYS.llmOcrKey);
		}
		if (typeof window !== 'undefined' && activeDoc) {
			const url = new URL(window.location.href);
			url.searchParams.set(URL_PARAMS.doc, activeDoc.slug ?? activeDoc.id);
			url.searchParams.set(URL_PARAMS.sentence, String(globalIdx));
			url.searchParams.set(URL_PARAMS.rate, String(synthRate));
			// Cloned voices are deep-linked by slugified name, not raw ID.
			url.searchParams.set(URL_PARAMS.voice, voiceUrlParam(selectedVoiceId, customVoices));
			url.searchParams.set(URL_PARAMS.engine, ttsEngine);
			history.replaceState(null, '', url.toString());
		}
	});

	// Derived — sections live-parse the draft while it differs from the saved
	// doc, so unsaved edits (and the save debounce window) reach the viewer
	// and TTS immediately instead of only after persisting. Suspended while
	// editing: the viewer is unmounted, so per-keystroke re-parses only feed
	// a ~1s rich re-render (marked + sanitize) that nobody reads. The
	// debounced autosave still parses once per idle window for persistence.
	let sections: Section[] = $derived.by(() =>
		isEditing ? (activeDoc?.sections ?? []) : selectSections(activeDoc?.sections, activeDoc?.markdown, markdownDraft)
	);
	let totalSentences: number = $derived(getGlobalSentences(sections).length);
	// Speakable TTS view over the live sections (#63): re-derived on open and
	// on every edit (saved or debounced), so the player always speaks the
	// current text. Highlight/seek stay in global-sentence space via the
	// chunk→sentence map — the renderer's `data-sentence-idx` never changes.
	let tts = $derived(deriveTts(sections));
	let currentSectionIdx: number = $derived(globalToSectionChunk(sections, globalIdx).sectionIdx);
	let currentSection: Section | null = $derived(sections[currentSectionIdx] ?? null);
	let breadcrumbs: string = $derived(currentSection ? currentSection.titles.join(' > ') : '');

	// Keep the backend player's snapshot aligned with the live sections, so
	// edits (saved or not) replace what TTS speaks from the next sentence on
	// and deleted sentences can never sound after a pause/seek/resume. The
	// snapshot holds derived speakable chunks; a paused player re-parks on
	// the chunk for the current sentence, while a running chain picks the
	// new text up from the next chunk. Suspended while editing (per-keystroke
	// seek/resetElement churn); a single refresh runs on save instead.
	$effect(() => {
		if (isEditing) return;
		const texts = tts.texts;
		const player = sentencePlayer;
		if (!player) return;
		player.updateSentences(texts);
		if (!player.isRunning) void player.seek(chunkForSentence(tts, globalIdx));
	});

	// Two-way Markdown→PDF sync (#1): as the current sentence crosses a
	// `Page N.` marker (listening or seek), follow it in the PDF viewer.
	// Only renders when the physical page differs to avoid loops with the
	// PDF→Markdown scroll inside `renderPdfPage`.
	$effect(() => {
		const idx = globalIdx;
		const sens = sections;
		const manual = pdfManualNav;
		pdfManualNav = false;
		// Manual PDF paging owns the viewer until playback/seek moves on.
		if (manual) return;
		if (panel !== 'pdf' || !pdfDoc || pdfTotalPages <= 0 || isOcrRunning || pdfPendingOcr) return;
		const sentences = getGlobalSentences(sens);
		if (sentences.length === 0) return;
		const logical = findPageForSentence(sentences, idx);
		const physical = logicalToPhysical(logical, activeDoc?.pageMap, pdfTotalPages);
		if (physical !== pdfPageNum && physical >= 1 && physical <= pdfTotalPages) {
			pdfPageNum = physical;
			void renderPdfPage();
		}
	});

	// Remaining time: measured chars/sec per voice+engine when available,
	// cold-starting at ~150wpm until the first samples land.
	let remainingText: string = $derived.by(() => {
		const all = getGlobalSentences(sections);
		if (all.length === 0) return '';
		const remainingChars = all.slice(globalIdx).join(' ').length;
		const secs = estimateRemainingSeconds(
			remainingChars,
			selectedVoiceId,
			ttsEngine,
			synthRate
		);
		return formatRemaining(secs);
	});

	let ocrEta: string = $derived.by(() => {
		if (!isOcrRunning || ocrEtaSeconds === null || ocrEtaAnchoredAt === null) return '';
		return formatEta(tickDownEta(ocrEtaSeconds, ocrEtaAnchoredAt, ocrNow));
	});

	// Tick the countdown once per second while OCR runs. The ticker only
	// re-renders; the anchor itself is set by progress steps below.
	$effect(() => {
		if (!isOcrRunning) return;
		const id = setInterval(() => {
			ocrNow = Date.now();
		}, 1000);
		return () => clearInterval(id);
	});

	function anchorOcrEta(done: number, total: number, _eventEta?: unknown) {
		if (!isOcrRunning || ocrStartAt === null) return;
		const elapsed = (Date.now() - ocrStartAt) / 1000;
		const next = measureEtaSeconds(done, total, elapsed);
		if (next === null) return;
		ocrEtaSeconds = next;
		ocrEtaAnchoredAt = Date.now();
		ocrNow = Date.now();
	}

	// PDF handling
	/** Point the viewer at `blob` (revoking the previous object URL). */
	function setPdfFromBlob(blob: Blob, name: string) {
		if (pdfUrl) URL.revokeObjectURL(pdfUrl);
		pdfFile = blob instanceof File ? blob : new File([blob], name || 'document.pdf', { type: 'application/pdf' });
		pdfUrl = URL.createObjectURL(blob);
	}

	function clearPdfViewer() {
		if (pdfUrl) URL.revokeObjectURL(pdfUrl);
		pdfFile = null;
		pdfUrl = null;
		pdfDoc = null;
		pdfTotalPages = 0;
		pdfPageNum = 1;
	}

	/** Load the IndexedDB-cached PDF for a doc into the viewer; clears viewer if none. */
	async function loadCachedPdf(docId: string): Promise<boolean> {
		try {
			const record = await getPdf(docId);
			if (!record) {
				clearPdfViewer();
				return false;
			}
			setPdfFromBlob(record.blob, record.name);
			await loadPdf();
			return true;
		} catch {
			clearPdfViewer();
			return false;
		}
	}

	/** Consolidated upload (#83): sniff extension + magic bytes, then route
	 * to PDF staging, ePub conversion, or Markdown import. */
	async function onDocSelected(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		// reset upfront so the same file can be re-selected
		input.value = '';
		if (!file) return;
		const kind = await sniffDocKind(file);
		if (kind === 'pdf') {
			stagePdfFile(file);
			return;
		}
		if (kind === 'epub') {
			await handleEpubFile(file);
			return;
		}
		await handleMarkdownFile(file);
	}

	/** Extension + content sniffing for the consolidated picker. */
	async function sniffDocKind(file: File): Promise<'pdf' | 'epub' | 'text'> {
		const name = (file.name || '').toLowerCase();
		const type = (file.type || '').toLowerCase().split(';')[0].trim();
		if (name.endsWith('.pdf') || type === 'application/pdf') return 'pdf';
		if (name.endsWith('.epub') || type === 'application/epub+zip' || type === 'application/epub')
			return 'epub';
		if (name.endsWith('.md') || name.endsWith('.markdown') || name.endsWith('.txt')) return 'text';
		// Extensionless/dubious names (mobile shares, `blob`): sniff magic.
		try {
			const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
			if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46)
				return 'pdf'; // %PDF-
			if (head[0] === 0x50 && head[1] === 0x4b) {
				const ascii = String.fromCharCode(...head.slice(0, 64));
				if (ascii.includes('mimetypeapplication/epub+zip')) return 'epub';
			}
		} catch {}
		return 'text';
	}

	async function stagePdfFile(file: File) {
		setPdfFromBlob(file, file.name);
		pendingPdfName = file.name;
		pageOverrides = {};
		pdfPendingOcr = true;
		panel = 'pdf';
		// Stage the PDF for preview + options — do NOT POST yet. The user
		// presses "Extract text" (staging bar) to kick off OCR (#6).
		await loadPdf();
		showToast('PDF loaded — set page options, then press Extract text');
	}

	function cancelPendingPdf() {
		pdfPendingOcr = false;
		pendingPdfName = '';
		pageOverrides = {};
		pendingPlaylistId = null;
		panel = null;
		clearPdfViewer();
		if (activeDoc) void loadCachedPdf(activeDoc.id);
	}

	// Consolidated picker opener: callers set `pendingPlaylistId` first so
	// the new doc lands in the open playlist (or standalone when null).
	function openDocPicker() {
		docInputEl?.click();
	}

	/** ePub import: convert server-side, persist Markdown + image assets. */
	async function handleEpubFile(file: File | Blob, fallbackName: string = 'book.epub') {
		const name = file instanceof File ? file.name || fallbackName : fallbackName;
		if (pdfPendingOcr) {
			showToast('Finish or cancel the staged PDF first');
			return;
		}
		showToast('Converting ePub…');
		try {
			const form = new FormData();
			form.append('file', file, name);
			const resp = await fetch(`${API_BASE}/api/convert/epub`, { method: 'POST', body: form });
			if (!resp.ok) throw new Error(await parseErrorResponse(resp));
			const data = await resp.json();
			const title =
				(data.title as string | null) ||
				name.replace(/\.epub$/i, '').replace(/[_-]+/g, ' ').trim() ||
				'ePub book';
			const doc = await createDoc(title, data.markdown as string, undefined, currentPostprocessOpts());
			const images = (data.images ?? []) as { path: string; media_type: string; data_b64: string }[];
			if (images.length > 0) {
				await saveDocAssets(
					doc.id,
					images.map((img) => ({
						path: img.path,
						mediaType: img.media_type || 'image/png',
						blob: b64ToBlob(img.data_b64, img.media_type || 'image/png')
					}))
				);
			}
			await placeNewDoc(doc, { kind: 'epub-upload' });
			showToast(pendingPlaylistId ? 'ePub added to playlist' : 'ePub opened');
		} catch (e: unknown) {
			showToast(`ePub import failed: ${(e as Error)?.message ?? e}`);
		}
	}

	function b64ToBlob(b64: string, type: string): Blob {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return new Blob([bytes.buffer as ArrayBuffer], { type });
	}

	// Markdown upload + PDF+Markdown pair (#20). Markers (`Page N.` lines)
	// drive viewer sync; the PDF page count validates the pairing.
	async function handleMarkdownFile(file: File) {
		let text = '';
		try {
			text = await file.text();
		} catch (err: any) {
			showToast(`Could not read Markdown: ${err?.message ?? err}`);
			return;
		}
		if (!text.trim()) {
			showToast('Markdown file is empty');
			return;
		}
		const title = (file.name.replace(/\.(md|markdown|txt)$/i, '') || pendingPdfName.replace(/\.pdf$/i, '') || 'Untitled').trim();
		if (pdfPendingOcr && pdfFile && pdfTotalPages > 0) {
			// Paired import: validate marker count against the staged PDF.
			const nums = [...text.matchAll(/^\s*Page (\d+)\.\s*$/gm)].map((m) => parseInt(m[1], 10));
			if (nums.length > 0) {
				const maxMarker = Math.max(...nums);
				const expectedLast = resolveStagedLogical(pdfTotalPages);
				if (maxMarker !== expectedLast) {
					const ok = confirm(
						`Page markers go up to Page ${maxMarker} but the PDF has ${pdfTotalPages} pages` +
						` (expected last marker Page ${expectedLast}). Import anyway?`
					);
					if (!ok) return;
				}
			}
			try {
				const doc = await createDoc(title, text, undefined, currentPostprocessOpts());
				try {
					await savePdf(doc.id, pdfFile, pendingPdfName || 'document.pdf');
				} catch (err: any) {
					showToast(`Imported, but PDF caching failed: ${err?.message ?? err}`);
				}
				try {
					pdfSizes = await getPdfSizes();
				} catch {}
				await placeNewDoc(doc, { kind: 'pdf-upload' });
				pdfPendingOcr = false;
				pendingPdfName = '';
				pageOverrides = {};
				panel = 'pdf';
				syncPostprocessOptsFromDoc(doc, true);
				showToast('PDF + Markdown imported');
			} catch (err: any) {
				showToast(`Import failed: ${err?.message ?? err}`);
			}
			return;
		}
		// Markdown-only import (no PDF): parse client-side, no backend needed.
		try {
			const doc = await createDoc(title, text, undefined, currentPostprocessOpts());
			const target = pendingPlaylistId;
			await placeNewDoc(doc, { kind: 'markdown-upload' });
			showToast(target ? 'Markdown added to playlist' : 'Markdown imported');
		} catch (err: any) {
			showToast(`Import failed: ${err?.message ?? err}`);
		}
	}

	/** Logical `Page N.` number for a physical PDF page while staging (pre-OCR). */
	function resolveStagedLogical(physical: number): number {
		const ov = (pageOverrides as Record<number, number>)[physical];
		if (ov !== undefined) return ov;
		const base = optFirstPageNumber >= 1 ? optFirstPageNumber : 1;
		return base + physical - 1;
	}

	function handlePageOverrideChange(physical: number, raw: string) {
		const n = parseInt(raw, 10);
		const next = { ...(pageOverrides as Record<number, number>) };
		if (!Number.isFinite(n) || n < 1) delete next[physical];
		else next[physical] = Math.floor(n);
		pageOverrides = next;
	}

	// For manual trigger from PdfPane placeholder
	function triggerPdfUpload() {
		pendingPlaylistId = null;
		openDocPicker();
	}

	/** Playlist "+" menu uploads: the new doc lands in the open playlist. */
	function handlePlaylistDocUpload() {
		pendingPlaylistId = activePlaylistId;
		openDocPicker();
	}

	async function loadPdf() {
		if (!pdfUrl && !pdfFile) return;
		try {
			const pdfjs: any = await import('pdfjs-dist');
			try {
				const workerMod: any = await import('pdfjs-dist/build/pdf.worker.mjs?url');
				const workerUrl = workerMod.default ?? workerMod;
				if (workerUrl) pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
			} catch {}
			// pdfjs-dist v6 requires a params object (`{ data }` / `{ url }`);
			// passing the URL string directly throws "expected either
			// `data`, `range`, or `url` parameter". Prefer bytes so the
			// preview doesn't depend on the object-URL lifetime.
			let task;
			if (pdfFile) {
				const bytes = await pdfFile.arrayBuffer();
				task = pdfjs.getDocument({ data: bytes });
			} else {
				task = pdfjs.getDocument({ url: pdfUrl });
			}
			pdfDoc = await task.promise;
			pdfTotalPages = pdfDoc.numPages;
			pdfPageNum = 1;
			// Wait for the PdfPane canvas to mount before rendering into it.
			await tick();
			await renderPdfPage();
		} catch (e: any) {
			showToast(`PDF preview failed: ${e?.message ?? e}`);
		}
	}
	async function renderPdfPage() {
		if (!pdfDoc) return;
		// The PdfPane canvas unmounts while OCR progress is shown and when
		// the PDF panel is closed, so wait for it to be bound before drawing.
		if (panel !== 'pdf') return;
		let tries = 0;
		while (!canvasEl && tries < 40) {
			await new Promise((r) => setTimeout(r, 50));
			tries++;
		}
		if (!canvasEl) return;
		const page = await pdfDoc.getPage(pdfPageNum);
		const viewport = page.getViewport({ scale: 1.2 });
		canvasEl.width = viewport.width;
		canvasEl.height = viewport.height;
		const ctx = canvasEl.getContext('2d');
		if (ctx) await page.render({ canvasContext: ctx, viewport }).promise;
	// Sync scroll — prefer the exact `Page N.` marker element (precise no
	// matter how text-heavy each page is); fall back to character-offset
	// proportional scrolling when markers are off or absent. Line-based
	// estimates undershoot because rendered paragraphs wrap, and uneven
	// true page lengths made that visible.
	const viewer = markdownPaneRef?.getViewerEl?.();
	const scrolledToMarker = (() => {
		if (isEditing || !viewer || pdfPageNum < 1) return false;
		const idx = findPageMarkerIndex(getGlobalSentences(sections), pdfPageNum);
		if (idx === -1) return false;
		const node = viewer.querySelector(`[data-sentence-idx="${idx}"]`) as HTMLElement | null;
		if (!node) return false;
		const viewerRect = viewer.getBoundingClientRect();
		const elRect = node.getBoundingClientRect();
		viewer.scrollTop = Math.max(0, viewer.scrollTop + (elRect.top - viewerRect.top) - 16);
		return true;
	})();
	if (!scrolledToMarker) {
		const mdText = isEditing ? markdownDraft : (activeDoc?.markdown ?? markdownDraft);
		const mdLen = mdText.length || 1;
		// `pageMap[i].page` is the logical number for physical page `i + 1`;
		// prefer positional lookup so first-page offsets don't misalign.
		const pm =
			activeDoc?.pageMap?.[pdfPageNum - 1] ??
			activeDoc?.pageMap?.find((p) => p.page === pdfPageNum);
		const charStart = pm ? pm.char_start : ((pdfPageNum - 1) / Math.max(1, pdfTotalPages)) * mdLen;
		const el = isEditing ? editorEl : (viewer ?? editorEl);
		if (el) {
			el.scrollTop = Math.max(0, (charStart / mdLen) * el.scrollHeight - 40);
		}
	}
	}
	function nextPdfPage() {
		if (pdfPageNum < pdfTotalPages) {
			pdfPageNum++;
			pdfManualNav = true;
			syncMarkdownToPdfPage(pdfPageNum);
			renderPdfPage();
		}
	}
	function prevPdfPage() {
		if (pdfPageNum > 1) {
			pdfPageNum--;
			pdfManualNav = true;
			syncMarkdownToPdfPage(pdfPageNum);
			renderPdfPage();
		}
	}

	/** PDF→Markdown sync (#1): move the reader to the new PDF page's marker.
	 *
	 * Physical page 1 has no marker in legacy docs (markers started at
	 * Page 2): seek doc start instead of resolving to the Page-2 marker,
	 * which used to snap the viewer straight back to page 2.
	 */
	function syncMarkdownToPdfPage(physical: number) {
		if (isEditing || pdfPendingOcr) return;
		const sentences = getGlobalSentences(sections);
		if (sentences.length === 0) return;
		const logical = physicalToLogical(physical, activeDoc?.pageMap);
		const markerIdx = findPageMarkerIndex(sentences, logical);
		if (markerIdx !== -1 && markerIdx !== globalIdx) {
			if (isPlaying || ttsEngine !== 'device') seekTo(markerIdx);
			else globalIdx = markerIdx;
		} else if (markerIdx === -1 && physical === 1 && globalIdx !== 0) {
			if (isPlaying || ttsEngine !== 'device') seekTo(0);
			else globalIdx = 0;
		}
	}

	// OCR
	async function parseErrorResponse(resp: Response): Promise<string> {
		const text = await resp.text();
		try {
			const data = JSON.parse(text);
			if (typeof data?.detail === 'string') return data.detail;
			if (Array.isArray(data?.detail)) return data.detail.map((d: any) => d.msg ?? JSON.stringify(d)).join('; ');
		} catch {}
		return text;
	}

	function beginOcrProgress(phase = 'Extracting text') {
		isOcrRunning = true;
		ocrPhase = phase;
		ocrProgress = { done: 0, total: 0 };
		ocrStartAt = Date.now();
		ocrEtaSeconds = null;
		ocrEtaAnchoredAt = null;
		ocrNow = Date.now();
	}

	function clearOcrProgress() {
		isOcrRunning = false;
		ocrProgress = null;
		ocrStartAt = null;
		ocrEtaSeconds = null;
		ocrEtaAnchoredAt = null;
	}

	/** Load server-side LLM defaults for the settings modal. */
	async function loadLlmDefaults() {
		try {
			llmDefaults = await fetchLlmDefaults(API_BASE);
		} catch (e: any) {
			showToast(`Could not load LLM defaults: ${e?.message ?? e}`);
		}
	}

	async function openLlmSettings() {
		if (!llmDefaults) await loadLlmDefaults();
		showLlmSettings = true;
	}

	function handleSaveLlmSettings(next: LlmOcrSettings, key: string, remember: boolean) {
		llmSettings = next;
		llmApiKey = key;
		rememberLlmApiKey = remember;
		showLlmSettings = false;
		showToast('LLM OCR settings saved');
	}

	/** LLM overrides for `/api/llm/ocr` (empty object means server defaults). */
	function llmPayload(): LlmOcrPayload {
		return buildLlmPayload(llmSettings, llmApiKey);
	}

	/** In-flight page render/OCR requests; keep a local cap even when unbounded. */
	function ocrConcurrency(): number {
		const n = llmSettings.concurrency ?? llmDefaults?.concurrency ?? 2;
		return n > 0 ? Math.min(n, 8) : 2;
	}

	/** Ask whether to OCR pages the browser cannot read. Resolves to run/skip. */
	function askOcrOffer(offer: {
		totalPages: number;
		pages: number[];
		reasons: Record<string, number>;
		failure?: boolean;
	}): Promise<boolean> {
		ocrOffer = offer;
		return new Promise<boolean>((resolve) => {
			ocrOfferResolve = resolve;
		});
	}

	function resolveOcrOffer(run: boolean) {
		const resolve = ocrOfferResolve;
		ocrOfferResolve = null;
		ocrOffer = null;
		resolve?.(run);
	}

	function handleOcrOfferRun() {
		resolveOcrOffer(true);
	}

	function handleOcrOfferKeep() {
		resolveOcrOffer(false);
	}

	function handleOcrOfferConfigure() {
		resolveOcrOffer(false);
		void openLlmSettings();
	}

	/** OCR selected pages with the shared progress bar. */
	async function runPageOcr(bytes: Uint8Array, pages: number[]): Promise<OcrPagesResult> {
		ocrProgress = { done: 0, total: pages.length };
		const result = await ocrPdfPages(bytes, pages, {
			apiBase: API_BASE,
			llm: llmPayload(),
			concurrency: ocrConcurrency(),
			onProgress: (done, total) => {
				ocrProgress = { done, total };
				ocrPhase = `OCR page ${Math.min(done + 1, total)}/${total}`;
				anchorOcrEta(done, total, undefined);
			}
		});
		if (result.failed.length > 0) {
			showToast(`${result.failed.length}/${pages.length} pages failed OCR`);
		}
		return result;
	}

	/** OCR the entire document and return its page array. */
	async function ocrWholeDocument(bytes: Uint8Array) {
		const { totalPages, result } = await ocrWholePdf(bytes, {
			apiBase: API_BASE,
			llm: llmPayload(),
			concurrency: ocrConcurrency(),
			onProgress: (done, total) => {
				ocrProgress = { done, total };
				ocrPhase = `OCR page ${Math.min(done + 1, total)}/${total}`;
				anchorOcrEta(done, total, undefined);
			}
		});
		const pages = new Array<string>(totalPages).fill('');
		mergeOcrResults(pages, result);
		if (result.failed.length > 0) {
			showToast(`${result.failed.length}/${totalPages} pages failed OCR`);
		}
		return { pages, totalPages };
	}

	/** Browser extraction with optional LLM OCR for unreadable pages. */
	async function extractPdf(
		bytes: Uint8Array,
		engine: 'auto' | 'liteparse' | 'llm',
		options: { offerOcr: boolean }
	): Promise<{ pages: string[]; totalPages: number }> {
		if (engine === 'llm') {
			return ocrWholeDocument(bytes);
		}

		ocrPhase = 'Analyzing pages…';
		let analysis;
		try {
			analysis = await analyzePdf(bytes);
		} catch (e) {
			if (engine === 'auto' && options.offerOcr) {
				const run = await askOcrOffer({
					totalPages: 0,
					pages: [],
					reasons: {},
					failure: true
				});
				if (run) return ocrWholeDocument(bytes);
			}
			throw e;
		}

		const flagged = ocrWorthyPages(analysis.pages);
		ocrPhase = `Extracting page 1/${analysis.totalPages}`;
		const parsedPromise = extractPdfPages(
			bytes,
			analysis.totalPages,
			(done, total) => {
				ocrProgress = { done, total };
				ocrPhase = `Extracting page ${Math.min(done + 1, total)}/${total}`;
				anchorOcrEta(done, total, undefined);
			}
		);

		let ocrPages: number[] = [];
		if (flagged.length > 0) {
			if (engine === 'auto' && options.offerOcr) {
				const run = await askOcrOffer({
					totalPages: analysis.totalPages,
					pages: flagged.map((p: ComplexityPage) => p.pageNumber).sort((a, b) => a - b),
					reasons: countReasons(flagged)
				});
				if (run) ocrPages = flagged.map((p: ComplexityPage) => p.pageNumber);
			} else {
				showToast(`${flagged.length}/${analysis.totalPages} pages may need OCR`);
			}
		}

		let parsed;
		try {
			parsed = await parsedPromise;
		} catch (e) {
			if (engine === 'auto' && options.offerOcr) {
				const run = await askOcrOffer({
					totalPages: analysis.totalPages,
					pages: [],
					reasons: {},
					failure: true
				});
				if (run) return ocrWholeDocument(bytes);
			}
			throw e;
		}

		const pages = parsed.pages;
		if (ocrPages.length > 0) {
			const result = await runPageOcr(bytes, ocrPages);
			mergeOcrResults(pages, result);
		}
		return { pages, totalPages: parsed.totalPages };
	}

	async function runOcr() {
		if (!pdfFile) {
			showToast('Select a PDF first');
			return;
		}
		const fileToUpload = pdfFile;
		// No size limit — warn on large PDFs but allow any size.
		if (fileToUpload.size > 100 * 1024 * 1024) {
			showToast(`Large PDF (${(fileToUpload.size / 1024 / 1024).toFixed(1)} MB) — processing may take a while`);
		}
		if (isOcrRunning) {
			showToast('Extraction already running');
			return;
		}
		beginOcrProgress('Loading PDF engine…');
		let ocrSucceeded = false;
		try {
			const bytes = new Uint8Array(await fileToUpload.arrayBuffer());
			const { pages } = await extractPdf(bytes, optEngine, { offerOcr: true });
			const title = fileToUpload.name.replace(/\.pdf$/i, '') || 'Untitled';
			const doc = await createDocFromPages(title, pages, currentPostprocessOpts());
			// Cache the uploaded PDF so the viewer can reload it after
			// reloads and doc switches. Storage failures must not fail OCR.
			try {
				await savePdf(doc.id, fileToUpload, fileToUpload.name || 'upload.pdf');
			} catch (e: any) {
				showToast(`Extraction completed, but PDF caching failed: ${e?.message ?? e}`);
			}
			docs = await getAllDocs();
			try {
				pdfSizes = await getPdfSizes();
			} catch {}
			activeDoc = doc;
			markdownDraft = doc.markdown;
			renderBaseline = doc.markdown;
			globalIdx = 0;
			isEditing = false;
			pdfPendingOcr = false;
			pendingPdfName = '';
			pageOverrides = {};
			// Focus the fresh Markdown; the PDF stays one tab away.
			panel = null;
			if (pendingPlaylistId) {
				const item = await attachDocAsItem(pendingPlaylistId, doc, { kind: 'pdf-upload' });
				pendingPlaylistId = null;
				if (item) {
					activePlaylistId = item.playlistId;
					activeItemId = item.id;
				}
			} else {
				activePlaylistId = null;
				activeItemId = null;
				// Standalone docs land in the unassigned library section - refresh
				// so LibraryPane shows them without a manual revisit.
				// (Playlist branch already refreshes via attach/openPlaylistItem.)
				await refreshPlaylistData();
			}
			showToast(pages.some((page) => page.trim()) ? 'Extraction completed' : 'No text extracted');
			ocrSucceeded = true;
		} catch (e: any) {
			showToast(`Extraction failed: ${e?.message ?? e}`);
		} finally {
			clearOcrProgress();
		}
		// Load the preview only after the progress pane is gone — while OCR
		// runs the PdfPane (and its canvas) is unmounted, so rendering then
		// silently no-ops and the viewer stays blank.
		if (ocrSucceeded && pdfUrl) {
			await tick();
			await loadPdf();
		}
	}

	/** Re-extract a playlist item's cached PDF with a chosen engine.
	 *
	 * Runs the same extraction flow as initial import, then swaps the doc's
	 * text in place (title, playlist items, and cached PDF are kept).
	 */
	async function handleReprocessItem(
		itemId: string,
		engine: 'auto' | 'liteparse' | 'llm'
	) {
		const item = playlistItems.find((i) => i.id === itemId);
		if (!item) return;
		const doc = await getDoc(item.docId);
		if (!doc) {
			showToast('Document not found');
			return;
		}
		const pdf = await getPdf(item.docId);
		if (!pdf?.blob) {
			showToast('No cached PDF for this item');
			return;
		}
		if (
			!confirm(`Re-extract "${item.title}" with ${engine}? This replaces the current text.`)
		)
			return;
		if (isOcrRunning) {
			showToast('Extraction already running');
			return;
		}
		if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel();
		sentencePlayer?.stop();
		stopOffline();
		isPlaying = false;
		beginOcrProgress('Loading PDF engine…');
		try {
			const bytes = new Uint8Array(await pdf.blob.arrayBuffer());
			const { pages } = await extractPdf(bytes, engine, { offerOcr: true });
			const opts = currentPostprocessOpts();
			const rendered = applyPostprocessingPages(pages, opts);
			const updated: Doc = {
				...doc,
				markdown: rendered.markdown,
				sections: rendered.sections,
				pageMap: rendered.pageMap,
				rawPages: pages,
				pageCount: pages.length,
				postprocess: opts,
				updatedAt: Date.now()
			};
			delete (updated as Partial<Doc>).rawMarkdown;
			delete (updated as Partial<Doc>).rawPageMap;
			await saveDoc(updated);
			docs = await getAllDocs();
			const total = getGlobalSentences(rendered.sections).length;
			await updatePlaylistItemProgress(itemId, 0, total);
			if (activeDoc?.id === doc.id) {
				activeDoc = updated;
				markdownDraft = updated.markdown;
				renderBaseline = updated.markdown;
				globalIdx = 0;
				isEditing = false;
				await loadCachedPdf(doc.id);
			}
			await refreshPlaylistData();
			showToast('Re-extraction complete');
		} catch (e: any) {
			showToast(`Re-extract failed: ${e?.message ?? e}`);
		} finally {
			clearOcrProgress();
		}
	}

	async function openDoc(id: string) {
		const d = await getDoc(id);
		if (!d) return;
		if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel();
		sentencePlayer?.stop();
		stopOffline();
		isPlaying = false;
		pdfPendingOcr = false;
		pendingPdfName = '';
		pageOverrides = {};
		panel = null;
		// Standalone doc (outside any playlist item).
		activePlaylistId = null;
		activeItemId = null;
		clearPdfViewer();
		activeDoc = d;
		markdownDraft = d.markdown;
		renderBaseline = d.markdown;
		syncPostprocessOptsFromDoc(d, true);
		isEditing = false;
		const saved = localStorage.getItem(progressKey(id));
		globalIdx = parseSentenceIndex(saved) ?? 0;
		// Load the cached PDF for this doc so the viewer follows the active document.
		await tick();
		await loadCachedPdf(id);
	}
	async function deleteDocHandler(id: string) {
		if (!confirm('Delete document?')) return;
		await deleteDoc(id);
		// Drop playlist items that pointed at the deleted doc.
		await deleteItemsByDocId(id);
		try {
			pdfSizes = await getPdfSizes();
		} catch {}
		docs = await getAllDocs();
		await refreshPlaylistData();
		if (activeDoc?.id === id) {
			stopOffline();
			activeDoc = null;
			activeItemId = null;
			markdownDraft = '';
			renderBaseline = null;
			clearPdfViewer();
			localStorage.removeItem(LS_KEYS.activeDocId);
		}
	}
	async function clearCachedPdf(id: string) {
		const bytes = pdfSizes[id];
		const label = bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : 'cached PDF';
		if (!confirm(`Remove the cached PDF (${label}) to save storage? The document text stays.`)) return;
		await deletePdf(id);
		try {
			pdfSizes = await getPdfSizes();
		} catch {}
		if (activeDoc?.id === id) clearPdfViewer();
		showToast('Cached PDF cleared');
	}
	async function renameDoc(id: string, newTitle: string) {
		const d = await renameDocStore(id, newTitle);
		if (!d) return;
		docs = await getAllDocs();
		if (activeDoc?.id === id) activeDoc = d;
	}

	// ---- Playlist library (Phase 3, IndexedDB-only) ----

	function formatLastListened(ts: number | null): string | null {
		if (!ts) return null;
		const mins = Math.floor((Date.now() - ts) / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		if (days < 30) return `${days}d ago`;
		return new Date(ts).toLocaleDateString();
	}

	async function refreshPlaylistData() {
		playlists = await getPlaylists();
		if (activePlaylistId && !playlists.some((p) => p.id === activePlaylistId)) {
			activePlaylistId = null;
			activeItemId = null;
		}
		playlistItems = activePlaylistId ? await getPlaylistItems(activePlaylistId) : [];
		if (activeItemId && !playlistItems.some((i) => i.id === activeItemId)) activeItemId = null;
		await refreshUnassigned();
		await refreshItemStats();
		await refreshOfflineStates();
		await refreshLibraryStats();
	}

	/** Docs not referenced by any playlist item. */
	async function refreshUnassigned() {
		try {
			const all = await getAllItems();
			const referenced = new Set(all.map((i) => i.docId));
			unassignedDocs = docs.filter((d) => !referenced.has(d.id));
		} catch {
			unassignedDocs = [];
		}
	}

	/** Per-card progress + ETA stats for the open playlist's items. */
	async function refreshItemStats() {
		const engine = ttsEngine;
		const next: Record<string, PlaylistItemStat> = {};
		for (const item of playlistItems) {
			const d = await getDoc(item.docId);
			const sens = d ? getGlobalSentences(d.sections) : [];
			const total = sens.length;
			const done = Math.max(0, Math.min(item.progress, total));
			const totalChars = sens.join(' ').length;
			const remChars = sens.slice(done).join(' ').length;
			if (total !== item.totalSentences) {
				await updatePlaylistItemProgress(item.id, item.progress, total);
				item.totalSentences = total;
			}
			next[item.id] = {
				done,
				total,
				estTotal: formatRemaining(estimateRemainingSeconds(totalChars, selectedVoiceId, engine, 1)),
				estRemaining: formatRemaining(
					estimateRemainingSeconds(remChars, selectedVoiceId, engine, synthRate)
				),
				hasPdf: (pdfSizes[item.docId] ?? 0) > 0
			};
		}
		itemStats = next;
	}

	async function refreshLibraryStats() {
		const engine = ttsEngine;
		const next: Record<string, LibraryPlaylistStat> = {};
		for (const p of playlists) {
			const items = await getPlaylistItems(p.id);
			let done = 0;
			let total = 0;
			let remChars = 0;
			for (const it of items) {
				const d = await getDoc(it.docId);
				const sens = d ? getGlobalSentences(d.sections) : [];
				total += sens.length;
				const at = Math.max(0, Math.min(it.progress, sens.length));
				done += at;
				remChars += sens.slice(at).join(' ').length;
			}
			next[p.id] = {
				itemCount: items.length,
				done,
				total,
				estRemaining: formatRemaining(
					estimateRemainingSeconds(remChars, selectedVoiceId, engine, synthRate)
				)
			};
		}
		libraryStats = next;
	}

	async function refreshOverview() {
		playlists = await getPlaylists();
		await refreshUnassigned();
		await refreshLibraryStats();
		overviewStats = playlists.map((p) => {
			const s = libraryStats[p.id];
			return {
				playlist: p,
				itemCount: s?.itemCount ?? 0,
				done: s?.done ?? 0,
				total: s?.total ?? 0,
				estRemaining: s?.estRemaining ?? formatRemaining(0),
				lastListenedLabel: formatLastListened(p.lastListenedAt)
			};
		});
		const idx: OverviewSearchHit[] = [];
		for (const p of playlists) {
			idx.push({
				playlistId: p.id,
				playlistName: p.name,
				itemId: null,
				title: p.name,
				detail: 'Playlist'
			});
			for (const it of await getPlaylistItems(p.id)) {
				idx.push({
					playlistId: p.id,
					playlistName: p.name,
					itemId: it.id,
					title: it.title,
					detail: `${p.name} · ${sourceLabel(it.source)}`
				});
			}
		}
		for (const d of unassignedDocs) {
			idx.push({
				playlistId: '',
				playlistName: '',
				itemId: null,
				docId: d.id,
				title: d.title,
				detail: 'Not in a playlist'
			});
		}
		overviewSearch = idx;
	}

	// Offline files are generated by a server engine. Pocket is used only
	// while the user is on Pocket; every other engine pre-generates Phonon.
	function offlineEngine(): ServerTtsEngine {
		return ttsEngine === 'pocket' ? 'pocket' : 'phonon';
	}
	function offlineVoiceId(): string {
		const engine = offlineEngine();
		if (ttsEngine === engine) return selectedVoiceId;
		return voiceByEngine[engine] ?? defaultVoiceFor(engine);
	}
	function resolveOfflineVoice(): {
		voiceKey: string;
		voiceId: string | null;
		blob: Blob | null;
	} {
		const engine = offlineEngine();
		const id = offlineVoiceId();
		const custom = findCustomVoiceFor(engine, id);
		if (custom) return { voiceKey: custom.id, voiceId: custom.id, blob: custom.blob };
		return { voiceKey: id, voiceId: id, blob: null };
	}
	function getOfflinePlayer(): OfflinePlayer {
		if (!offlinePlayer) {
			offlinePlayer = new OfflinePlayer();
			offlinePlayer.setCallbacks({
				onTimeIndex: (chunkIdx) => {
					// Chunk space back to global sentences for the highlight.
					const g = tts.chunks[chunkIdx]?.sentenceIndices[0];
					if (g !== undefined) globalIdx = g;
				},
				onEnded: () => {
					void (async () => {
						const advanced = await advanceToNextItem();
						if (!advanced) {
							isPlaying = false;
							offlineActive = false;
							globalIdx = Math.max(0, getGlobalSentences(sections).length - 1);
						}
					})();
				},
				onError: (msg) => {
					showToast(`Offline audio failed: ${msg}`);
					isPlaying = false;
					offlineActive = false;
				}
			});
		}
		return offlinePlayer;
	}
	/** Tear down the offline session (doc switch, engine change, voice change). */
	function stopOffline(): void {
		offlinePlayer?.unload();
		offlineActive = false;
	}
	/** Per-card offline state for the open playlist at the pocket voice+fmt. */
	async function refreshOfflineStates(): Promise<void> {
		try {
			offlineMeta = await getOfflineAudioMeta();
		} catch {
			offlineMeta = {};
		}
		const engine = offlineEngine();
		const voiceKey = offlineVoiceId();
		const next: Record<string, PlaylistOfflineState> = {};
		for (const item of playlistItems) {
			const doc = await getDoc(item.docId);
			if (!doc) {
				next[item.id] = { state: 'none', bytes: 0 };
				continue;
			}
			if (offlineGenerating[doc.id]) {
				next[item.id] = {
					state: 'generating',
					bytes: offlineMeta[offlineAudioKey(doc.id, engine, voiceKey, offlineFmt)]?.bytes ?? 0
				};
				continue;
			}
			const meta = offlineMeta[offlineAudioKey(doc.id, engine, voiceKey, offlineFmt)];
			if (!meta) {
				next[item.id] = { state: 'none', bytes: 0 };
				continue;
			}
			const hash = hashSpeakableText(joinSpeakableTexts(deriveTts(doc.sections).texts));
			next[item.id] = {
				state: isOfflineAudioStale(meta.textHash, hash) ? 'stale' : 'fresh',
				bytes: meta.bytes
			};
		}
		offlineItemState = next;
	}
	async function handleGenerateOfflineItem(itemId: string): Promise<void> {
		const item = playlistItems.find((i) => i.id === itemId);
		if (!item) return;
		const doc = await getDoc(item.docId);
		if (!doc) {
			showToast('Document not found');
			return;
		}
		if (offlineGenerating[doc.id]) return;
		const engine = offlineEngine();
		const { voiceKey, voiceId, blob } = resolveOfflineVoice();
		const text = joinSpeakableTexts(deriveTts(doc.sections).texts);
		if (!text.trim()) {
			showToast('Nothing speakable to generate');
			return;
		}
		offlineGenerating = { ...offlineGenerating, [doc.id]: true };
		await refreshOfflineStates();
		try {
			showToast('Generating offline audio — keep the app open');
			const audioBlob = await generateOfflineAudioBlob({
				text,
				voiceId,
				voiceBlob: blob,
				fmt: offlineFmt,
				engine
			});
			await saveOfflineAudio({
				docId: doc.id,
				engine,
				voiceKey,
				fmt: offlineFmt,
				blob: audioBlob,
				mediaType: audioBlob.type || `audio/${offlineFmt}`,
				textHash: hashSpeakableText(text)
			});
			showToast(`Offline audio saved (${(audioBlob.size / 1024 / 1024).toFixed(1)} MB)`);
		} catch (e: unknown) {
			showToast(`Offline generation failed: ${(e as Error)?.message ?? e}`);
		} finally {
			const nextGen = { ...offlineGenerating };
			delete nextGen[doc.id];
			offlineGenerating = nextGen;
			await refreshOfflineStates();
		}
	}
	async function handleDeleteOfflineItem(itemId: string): Promise<void> {
		const item = playlistItems.find((i) => i.id === itemId);
		if (!item) return;
		const engine = offlineEngine();
		const { voiceKey } = resolveOfflineVoice();
		if (!confirm('Delete the pre-generated offline audio? The text stays.')) return;
		await deleteOfflineAudio(item.docId, engine, voiceKey, offlineFmt);
		if (activeDoc?.id === item.docId && offlineActive) {
			stopOffline();
			isPlaying = false;
		}
		await refreshOfflineStates();
		showToast('Offline audio deleted');
	}
	/** Load the cached file for the active doc when fresh; else false. */
	async function startOfflineIfAvailable(): Promise<boolean> {
		if (!activeDoc || ttsEngine === 'device' || !offlineUse) return false;
		const texts = tts.texts;
		if (texts.length === 0) return false;
		const engine = offlineEngine();
		const { voiceKey } = resolveOfflineVoice();
		let rec;
		try {
			rec = await getOfflineAudio(activeDoc.id, engine, voiceKey, offlineFmt);
		} catch {
			return false;
		}
		if (!rec) return false;
		if (isOfflineAudioStale(rec.textHash, hashSpeakableText(joinSpeakableTexts(texts)))) return false;
		sentencePlayer?.stop();
		const player = getOfflinePlayer();
		player.load(rec.blob, texts.map((t) => t.length));
		offlineActive = true;
		isPlaying = true;
		await player.playFromIndex(chunkForSentence(tts, globalIdx), synthRate);
		return true;
	}
	/** Start (or resume) playback from the current sentence. */
	async function startPlayback() {
		isPlaying = true;
		if (ttsEngine !== 'device') {
			if (offlineActive && offlinePlayer) {
				await offlinePlayer.resume(synthRate);
				return;
			}
			if (await startOfflineIfAvailable()) return;
			if (sentencePlayer?.canResume()) void sentencePlayer.resume();
			else playSentencePlayer();
		} else playWebSpeechCorrect();
	}

	async function openPlaylistItem(
		playlistId: string,
		itemId: string,
		opts?: { autoplay?: boolean }
	) {
		const items = await getPlaylistItems(playlistId);
		const item = items.find((i) => i.id === itemId);
		if (!item) {
			showToast('Playlist item not found');
			return;
		}
		const d = await getDoc(item.docId);
		if (!d) {
			showToast('The document for this item was deleted');
			return;
		}
		if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel();
		sentencePlayer?.stop();
		stopOffline();
		isPlaying = false;
		pdfPendingOcr = false;
		pendingPdfName = '';
		pageOverrides = {};
		pendingPlaylistId = null;
		clearPdfViewer();
		activePlaylistId = playlistId;
		activeItemId = itemId;
		activeDoc = d;
		markdownDraft = d.markdown;
		renderBaseline = d.markdown;
		syncPostprocessOptsFromDoc(d, true);
		isEditing = false;
		const total = getGlobalSentences(d.sections).length;
		globalIdx = Math.max(0, Math.min(item.progress, Math.max(0, total - 1)));
		await updatePlaylistItemProgress(itemId, globalIdx, total);
		await touchPlaylistListened(playlistId);
		view = 'reader';
		panel = null;
		await refreshPlaylistData();
		await tick();
		await loadCachedPdf(d.id);
		if (opts?.autoplay) void startPlayback();
	}

	/** Autoplay: after the last sentence, continue with the next playlist item. */
	async function advanceToNextItem(): Promise<boolean> {
		if (!activePlaylistId || !activeItemId) return false;
		const items = await getPlaylistItems(activePlaylistId);
		const idx = items.findIndex((i) => i.id === activeItemId);
		if (idx === -1 || idx >= items.length - 1) return false;
		const next = items[idx + 1];
		await openPlaylistItem(activePlaylistId, next.id, { autoplay: true });
		showToast(`Up next: ${next.title}`);
		return true;
	}

	async function attachDocAsItem(
		playlistId: string,
		doc: Doc,
		source: ItemSource
	): Promise<PlaylistItem | null> {
		const total = getGlobalSentences(doc.sections).length;
		const item = await addPlaylistItem(playlistId, {
			title: doc.title,
			source,
			docId: doc.id,
			totalSentences: total
		});
		if (!item) {
			showToast('Playlist not found');
			return null;
		}
		await touchPlaylistListened(playlistId);
		await refreshPlaylistData();
		return item;
	}

	/** Route a fresh doc into the pending playlist, or open it standalone. */
	async function placeNewDoc(doc: Doc, source: ItemSource): Promise<void> {
		docs = await getAllDocs();
		if (pendingPlaylistId) {
			const item = await attachDocAsItem(pendingPlaylistId, doc, source);
			pendingPlaylistId = null;
			if (item) await openPlaylistItem(item.playlistId, item.id);
			else await openDoc(doc.id);
		} else {
			await openDoc(doc.id);
			// Standalone (unassigned) add: openDoc does not touch library
			// state, so refresh here or the new doc stays invisible until
			// the user manually revisits the overview/library.
			await refreshPlaylistData();
		}
		view = 'reader';
	}

	async function handleFetchUrl(targetPlaylistId: string | null, rawUrl: string) {
		const url = rawUrl.trim();
		if (!url) return;
		if (isPdfUrl(url)) {
			// PDF-URL path: download the blob, then stage for OCR text routing.
			showToast('Downloading PDF…');
			try {
				const resp = await fetch(url);
				if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
				const blob = await resp.blob();
				const name = url.split('/').pop()?.split('?')[0]?.split('#')[0] || 'article.pdf';
				setPdfFromBlob(new Blob([blob], { type: 'application/pdf' }), name);
				pendingPdfName = name;
				pageOverrides = {};
				pdfPendingOcr = true;
				pendingPlaylistId = targetPlaylistId;
				panel = 'pdf';
				view = 'reader';
				await loadPdf();
				showToast('PDF loaded — set page options, then press Extract text');
			} catch (e: unknown) {
				showToast(`PDF download failed: ${(e as Error)?.message ?? e}`);
			}
			return;
		}
		if (isEpubUrl(url)) {
			// ePub-URL path: download the blob, then run the convert pipeline.
			showToast('Downloading ePub…');
			pendingPlaylistId = targetPlaylistId;
			try {
				const resp = await fetch(url);
				if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
				const blob = await resp.blob();
				const name = url.split('/').pop()?.split('?')[0]?.split('#')[0] || 'book.epub';
				await handleEpubFile(new Blob([blob], { type: 'application/epub+zip' }), name);
			} catch (e: unknown) {
				pendingPlaylistId = null;
				showToast(`ePub download failed: ${(e as Error)?.message ?? e}`);
			}
			return;
		}
		showToast('Fetching article…');
		try {
			const resp = await fetch(`${API_BASE}/api/fetch/article`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ url })
			});
			if (!resp.ok) throw new Error(await parseErrorResponse(resp));
			const data = await resp.json();
			const title =
				(data.title as string | null) ||
				(data.domain ? `${data.domain} article` : 'Article');
			pendingPlaylistId = targetPlaylistId;
			const doc = await createDoc(
				title,
				data.markdown as string,
				undefined,
				currentPostprocessOpts()
			);
			await placeNewDoc(doc, {
				kind: 'article-url',
				domain: (data.domain as string) || domainOf(url),
				url: (data.url as string) || url
			});
			showToast(targetPlaylistId ? 'Article added to playlist' : 'Article opened');
		} catch (e: unknown) {
			pendingPlaylistId = null;
			showToast(`Fetch failed: ${(e as Error)?.message ?? e}`);
		}
	}

	async function handlePasteText(targetPlaylistId: string | null, text: string, title?: string) {
		const clean = text.trim();
		if (!clean) return;
		const firstLine =
			clean
				.split('\n')
				.map((l) => l.trim())
				.find((l) => l.length > 0) ?? 'Pasted text';
		const docTitle = title?.trim() || firstLine.replace(/^#+\s*/, '').slice(0, 80) || 'Pasted text';
		pendingPlaylistId = targetPlaylistId;
		try {
			const doc = await createDoc(docTitle, clean, undefined, currentPostprocessOpts());
			await placeNewDoc(doc, { kind: 'markdown-paste' });
			showToast(targetPlaylistId ? 'Pasted text added to playlist' : 'Pasted text opened');
		} catch (e: unknown) {
			pendingPlaylistId = null;
			showToast(`Paste failed: ${(e as Error)?.message ?? e}`);
		}
	}

	async function handleCreatePlaylist() {
		const name = prompt('Name this playlist:');
		if (name === null) return;
		const playlist = await createPlaylist(name.trim() || 'Untitled playlist');
		await refreshPlaylistData();
		if (view === 'overview') await refreshOverview();
		// Drop the user into the new playlist.
		activePlaylistId = playlist.id;
		panel = 'playlist';
		view = 'reader';
	}

	async function handleOpenPlaylist(id: string) {
		activePlaylistId = id;
		panel = 'playlist';
		view = 'reader';
		await refreshPlaylistData();
	}

	async function handleResumePlaylist(id: string) {
		const items = await getPlaylistItems(id);
		if (items.length === 0) {
			await handleOpenPlaylist(id);
			return;
		}
		const next =
			items.find((i) => i.progress < Math.max(1, i.totalSentences)) ?? items[0];
		await openPlaylistItem(id, next.id);
	}

	async function handleRenamePlaylistItem(id: string, title: string) {
		await renamePlaylistItem(id, title);
		await refreshPlaylistData();
	}

	async function handleDeletePlaylistItem(id: string) {
		const item = playlistItems.find((i) => i.id === id);
		if (item && !confirm(`Remove "${item.title}" from the playlist? (The document is kept.)`))
			return;
		await deletePlaylistItem(id);
		if (activeItemId === id) activeItemId = null;
		await refreshPlaylistData();
	}

	async function handleBulkDeletePlaylistItems(ids: string[]) {
		if (ids.length === 0) return;
		if (
			!confirm(
				`Remove ${ids.length} ${ids.length === 1 ? 'item' : 'items'} from the playlist? (Documents are kept.)`
			)
		)
			return;
		for (const id of ids) {
			await deletePlaylistItem(id);
			if (activeItemId === id) activeItemId = null;
		}
		await refreshPlaylistData();
		showToast(`Removed ${ids.length} ${ids.length === 1 ? 'item' : 'items'}`);
	}

	async function handleMovePlaylistItem(id: string, dir: -1 | 1) {
		if (!activePlaylistId) return;
		const idx = playlistItems.findIndex((i) => i.id === id);
		if (idx === -1) return;
		await movePlaylistItem(activePlaylistId, id, idx + dir);
		playlistItems = await getPlaylistItems(activePlaylistId);
	}

	async function handleDropPlaylistItem(dragId: string, targetId: string) {
		if (!activePlaylistId || dragId === targetId) return;
		const targetIdx = playlistItems.findIndex((i) => i.id === targetId);
		if (targetIdx === -1) return;
		await movePlaylistItem(activePlaylistId, dragId, targetIdx);
		playlistItems = await getPlaylistItems(activePlaylistId);
	}

	async function handleShowItemPdf(id: string) {
		const item = playlistItems.find((i) => i.id === id);
		if (!item) return;
		const ok = await loadCachedPdf(item.docId);
		panel = 'pdf';
		if (ok) {
			await tick();
			await renderPdfPage();
		} else {
			showToast('No cached PDF for this item');
		}
	}

	async function handleClearItemPdf(id: string) {
		const item = playlistItems.find((i) => i.id === id);
		if (!item) return;
		if (!confirm('Remove the cached PDF to save storage? The text stays.')) return;
		await deletePdf(item.docId);
		try {
			pdfSizes = await getPdfSizes();
		} catch {}
		if (activeDoc?.id === item.docId) clearPdfViewer();
		await refreshItemStats();
		showToast('Cached PDF cleared');
	}

	async function handleAddCurrentDoc() {
		const doc = activeDoc;
		if (!doc || !activePlaylistId) return;
		if (playlistItems.some((i) => i.docId === doc.id)) {
			showToast('Already in this playlist');
			return;
		}
		const source: ItemSource =
			pdfSizes[doc.id] !== undefined
				? { kind: 'pdf-upload' }
				: (await hasDocAssets(doc.id))
					? { kind: 'epub-upload' }
					: { kind: 'markdown-upload' };
		const item = await attachDocAsItem(activePlaylistId, doc, source);
		if (item) {
			activeItemId = item.id;
			showToast('Added to playlist');
		}
	}

	async function handleRenamePlaylist(id: string, name: string) {
		await renamePlaylist(id, name);
		await refreshPlaylistData();
		if (view === 'overview') await refreshOverview();
	}

	async function handleDeletePlaylist(id: string) {
		const p = playlists.find((x) => x.id === id);
		if (p && !confirm(`Delete playlist "${p.name}"? (Documents are kept.)`)) return;
		await deletePlaylist(id);
		if (activePlaylistId === id) {
			activePlaylistId = null;
			activeItemId = null;
		}
		await refreshPlaylistData();
		if (view === 'overview') await refreshOverview();
	}

	let saveDebounce: ReturnType<typeof setTimeout> | null = null;
	// Last postprocess-rendered Markdown. `hasDirtyEdits` compares the draft
	// against this (not against the auto-saved doc) so saved user edits still
	// count as edits that re-render must preserve, and a failed re-render can
	// never leave a spurious dirty flag behind.
	let renderBaseline: string | null = $state(null);
	function onMarkdownDraftChange(v: string) {
		markdownDraft = v;
		if (!activeDoc) return;
		if (saveDebounce) clearTimeout(saveDebounce);
		saveDebounce = setTimeout(async () => {
			if (!activeDoc) return;
			const draftAtSave = markdownDraft;
			activeDoc.markdown = draftAtSave;
			activeDoc.sections = parseMarkdownStructure(draftAtSave);
			await saveDoc(activeDoc);
			docs = await getAllDocs();
		}, 600);
	}
	function handleEditToggle() {
		if (!activeDoc) return;
		if (!isEditing) {
			editBackup = markdownDraft;
			isEditing = true;
		} else {
			// shouldn't happen because save/cancel handle
			isEditing = false;
		}
	}
	async function handleEditSave() {
		if (!activeDoc) return;
		if (saveDebounce) {
			clearTimeout(saveDebounce);
			saveDebounce = null;
		}
		isEditing = false;
		activeDoc.markdown = markdownDraft;
		activeDoc.sections = parseMarkdownStructure(markdownDraft);
		await saveDoc(activeDoc);
		docs = await getAllDocs();
		showToast('Saved');
	}
	function handleEditCancel() {
		if (saveDebounce) {
			clearTimeout(saveDebounce);
			saveDebounce = null;
		}
		markdownDraft = editBackup;
		isEditing = false;
	}
	function handleSentenceClick(idx: number) {
		if (isPlaying || ttsEngine !== 'device') seekTo(idx);
		else globalIdx = idx;
	}

	function handleVoiceChange(id: string) {
		selectedVoiceId = id;
		// Remember the choice under the current engine so toggling engines
		// restores each engine's last voice.
		voiceByEngine = withVoiceForEngine(voiceByEngine, ttsEngine, id);
		// Cache keys are voice-scoped, so just restart the chain: the new
		// voice synthesizes from the current sentence, nothing earlier.
		// Offline files are voice-specific too — drop the old voice's session.
		const wasPlaying = isPlaying;
		stopOffline();
		if (wasPlaying && ttsEngine !== 'device') void startPlayback();
		void refreshOfflineStates();
	}

	function handleEngineChange(engine: TtsEngine) {
		// Park the current selection under the old engine before switching.
		voiceByEngine = withVoiceForEngine(voiceByEngine, ttsEngine, selectedVoiceId);
		// Stop any running chain — audio must never bleed across engines.
		cancelSpeech();
		sentencePlayer?.stop();
		stopOffline();
		isPlaying = false;
		ttsEngine = engine;
		// Restore the other engine's last voice; the first toggle carries the
		// current selection over so nothing unexpectedly resets to a default.
		let next = voiceForEngine(voiceByEngine, engine, selectedVoiceId);
		if (!voiceExistsFor(engine, next)) next = defaultVoiceFor(engine);
		voiceByEngine = withVoiceForEngine(voiceByEngine, engine, next);
		selectedVoiceId = next;
		if (engine === 'pocket') void ensurePocketVoices();
		if (engine === 'phonon-browser') void preparePhononBrowser();
	}

	// Voice handling
	let synthVoices: SpeechSynthesisVoice[] = $state([]);
	function refreshSynthVoices() {
		if (typeof window !== 'undefined' && window.speechSynthesis) {
			synthVoices = window.speechSynthesis.getVoices();
		}
	}
	$effect(() => {
		refreshSynthVoices();
		if (typeof window !== 'undefined') {
			window.speechSynthesis.onvoiceschanged = refreshSynthVoices;
		}
	});
	onMount(() => subscribePhononStatus((status) => (phononStatus = status)));
	/**
	 * Prompt for a clone name, blocking names that collide with built-in
	 * voices (warn-and-require-rename: no auto-suffix). Returns null when the
	 * user cancels.
	 */
	function promptForVoiceName(base: string, label: string): string | null {
		const cleanBase = base.trim() || 'voice';
		const first = prompt(label, cleanBase);
		if (first === null) return null;
		let name = first.trim() || cleanBase;
		while (isBuiltinVoiceName(name, builtinNamesFor(ttsEngine))) {
			const retry = prompt(
				`"${name}" is already a built-in voice name. Enter a different name:`,
				name
			);
			if (retry === null) return null;
			name = retry.trim() || name;
		}
		return name;
	}

	/**
	 * Rename a cloned voice. Returns an error message when the rename is
	 * blocked (built-in name collision), null on success.
	 */
	async function handleRenameVoice(id: string, newName: string): Promise<string | null> {
		const clean = newName.trim();
		if (!clean) return 'Enter a name.';
		const record = customVoices.find((voice) => voice.id === id);
		const engine: TtsEngine = record && voiceFileFormat(record) === 'phonon' ? 'phonon' : 'pocket';
		if (isBuiltinVoiceName(clean, builtinNamesFor(engine))) {
			return `"${clean}" is already a built-in voice name. Choose another name.`;
		}
		const updated = await renameVoice(id, clean);
		if (!updated) return 'Voice not found.';
		customVoices = await getCustomVoices();
		return null;
	}

	async function handleDeleteVoice(id: string) {
		const doomed = customVoices.find((v) => v.id === id);
		if (doomed && !confirm(`Delete cloned voice "${doomed.name}"?`)) return;
		await deleteVoice(id);
		customVoices = await getCustomVoices();
		// Park any slot that pointed at the deleted voice onto that engine's
		// current default (Pocket and Phonon have different catalogs).
		const nextMap: VoiceByEngine = {};
		for (const engine of ALL_TTS_ENGINES) {
			const value = voiceByEngine[engine];
			nextMap[engine] = value === id ? defaultVoiceFor(engine) : value;
		}
		voiceByEngine = nextMap;
		if (selectedVoiceId === id) {
			selectedVoiceId = defaultVoiceFor(ttsEngine);
			voiceByEngine = withVoiceForEngine(voiceByEngine, ttsEngine, selectedVoiceId);
			if (isPlaying && ttsEngine !== 'device') playSentencePlayer();
		}
	}

	async function onVoiceFile(e: Event) {
		const input = e.target as HTMLInputElement;
		if (!input.files?.[0]) return;
		const file = input.files[0];
		const format = engineVoiceFileFormat(ttsEngine);
		try {
			if (file.name.toLowerCase().endsWith('.safetensors')) {
				const blob = new Blob([await file.arrayBuffer()], {
					type: 'application/octet-stream'
				});
				const info = await inspectVoiceFile(blob);
				if (info.format !== 'unknown' && info.format !== format) {
					showToast(
						info.format === 'pocket'
							? 'That is a Pocket TTS clone. Pocket and Phonon voice files are not interchangeable.'
							: 'That is a Phonon voice file. Switch to a Phonon engine to use it.'
					);
					return;
				}
				const base = file.name.replace(/\.safetensors$/i, '') || 'voice';
				const name = promptForVoiceName(
					base,
					format === 'phonon' ? 'Name this Phonon voice:' : 'Name this Pocket voice:'
				);
				if (name === null) return;
				const record: VoiceRecord = {
					id: 'voice_' + Date.now().toString(36),
					name,
					blob,
					bytes: blob.size,
					sourceWavName: file.name,
					engine: format,
					createdAt: Date.now()
				};
				await saveVoice(record);
				customVoices = await getCustomVoices();
				selectedVoiceId = record.id;
				voiceByEngine = withVoiceForEngine(voiceByEngine, ttsEngine, record.id);
				showToast(`Voice "${name}" saved (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
				return;
			}
			if (format === 'phonon') {
				showToast('Phonon accepts precomputed .safetensors voice files, not audio recordings.');
				return;
			}
			const fd = new FormData();
			fd.append('voice_wav', file, file.name || 'voice.wav');
			const resp = await fetch(`${API_BASE}/api/tts/voices/convert`, { method: 'POST', body: fd });
			if (!resp.ok) throw new Error(await parseErrorResponse(resp));
			const blob = await resp.blob();
			const base = file.name.replace(/\.[^.]+$/, '') || 'voice';
			const name = promptForVoiceName(base, 'Name this voice:');
			if (name === null) return;
			const record: VoiceRecord = {
				id: 'voice_' + Date.now().toString(36),
				name,
				blob,
				bytes: blob.size,
				sourceWavName: file.name,
				engine: 'pocket',
				createdAt: Date.now()
			};
			await saveVoice(record);
			customVoices = await getCustomVoices();
			selectedVoiceId = record.id;
			voiceByEngine = withVoiceForEngine(voiceByEngine, ttsEngine, record.id);
			showToast(`Voice "${name}" saved (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
		} catch (err: any) {
			showToast(`Voice clone failed: ${err.message}`);
		} finally {
			(input as HTMLInputElement).value = '';
		}
	}

	// Player
	let isBackendGenerating: boolean = $state(false);
	// Offline chapter audio: pre-generated single file per doc+voice+format.
	let offlineFmt: OfflineAudioFmt = $state('webm');
	let offlineUse: boolean = $state(true);
	let offlinePlayer: OfflinePlayer | null = $state.raw(null);
	// True while an offline file is loaded for the active doc (playing or paused).
	let offlineActive: boolean = $state(false);
	let offlineMeta: Record<string, OfflineAudioMeta> = $state({});
	let offlineGenerating: Record<string, boolean> = $state({});
	let offlineItemState: Record<string, PlaylistOfflineState> = $state({});

	function getSentencePlayer(): BackendSentencePlayer {
		if (!sentencePlayer) {
			sentencePlayer = new BackendSentencePlayer();
			sentencePlayer.setCallbacks({
				onSentenceStart: (idx) => {
					// Backend index is derived-chunk space; map back so the
					// highlight and PDF sync stay on global sentences.
					// Code-comment chunks map to nothing — keep position.
					const g = tts.chunks[idx]?.sentenceIndices[0];
					if (g !== undefined) globalIdx = g;
				},
				onSentenceComplete: (_idx, chars, secondsAt1x) => {
					// Refine ETA stats for the voice+engine that sounded it.
					recordEtaSample(
						selectedVoiceId,
						ttsEngine,
						chars,
						secondsAt1x
					);
				},
				onEnded: () => {
					// Autoplay: continue with the next playlist item when there
					// is one; otherwise park at the last sentence and stop.
					void (async () => {
						const advanced = await advanceToNextItem();
						if (!advanced) {
							isPlaying = false;
							globalIdx = Math.max(0, getGlobalSentences(sections).length - 1);
						}
					})();
				},
				onError: (msg) => {
					showToast(`Backend TTS failed: ${msg}`);
					isPlaying = false;
				},
				onLoadingChange: (loading) => {
					isBackendGenerating = loading;
				}
			});
		}
		return sentencePlayer;
	}

	function resolveEngineVoice(
		engine: TtsEngine
	): { voiceKey: string; voiceId: string | null; blob: Blob | null } {
		// Cloned voices live in IndexedDB and are sent as safetensors blobs.
		const custom = findCustomVoiceFor(engine, selectedVoiceId);
		if (custom) return { voiceKey: custom.id, voiceId: custom.id, blob: custom.blob };
		return { voiceKey: selectedVoiceId, voiceId: selectedVoiceId, blob: null };
	}

	/** Start sentence-player playback (server or browser Phonon, or Pocket). */
	function playSentencePlayer() {
		if (!activeDoc) return;
		const texts = tts.texts;
		if (texts.length === 0 || texts.slice(chunkForSentence(tts, globalIdx)).every((s) => !s.trim())) {
			isPlaying = false;
			return;
		}
		const { voiceKey, voiceId, blob } = resolveEngineVoice(ttsEngine);
		getSentencePlayer().setFetchAudio(
			ttsEngine === 'phonon-browser' ? fetchPhononWav : fetchTTSWavStream
		);
		isBackendGenerating = true;
		const engine: ServerTtsEngine | 'phonon-browser' = isServerEngine(ttsEngine)
			? ttsEngine
			: 'phonon-browser';
		void getSentencePlayer().play(
			texts,
			chunkForSentence(tts, globalIdx),
			voiceKey,
			voiceId,
			blob,
			synthRate,
			engine
		);
	}

	function playWebSpeechCorrect() {
		if (!isPlaying || !activeDoc) { isPlaying = false; return; }
		const all = getGlobalSentences(sections);
		if (globalIdx >= all.length) { isPlaying = false; return; }
		const text = speakable(all[globalIdx]);
		let voice: SpeechSynthesisVoice | null = null;
		if (!customVoices.some((v) => v.id === selectedVoiceId)) {
			voice = synthVoices.find((v) => String(synthVoices.indexOf(v)) === selectedVoiceId) ?? synthVoices.find((v) => v.name === selectedVoiceId) ?? null;
		}
		const synth = window.speechSynthesis;
		synth.cancel();
		const u = new SpeechSynthesisUtterance(text);
		if (voice) u.voice = voice;
		u.rate = synthRate;
		u.onend = () => {
			if (!isPlaying) return;
			if (globalIdx < all.length - 1) {
				globalIdx++;
				playWebSpeechCorrect();
			} else {
				isPlaying = false;
				void advanceToNextItem();
			}
		};
		u.onerror = () => {};
		synth.speak(u);
	}
	function handleToggle() {
		if (isPlaying) {
			isPlaying = false;
			cancelSpeech();
			// Pause keeps cached sentence audio + position for instant resume.
			sentencePlayer?.pause();
			offlinePlayer?.pause();
		} else {
			void startPlayback();
		}
	}
	/** Move to `idx`, keeping backend playback going from there when playing. */
	function seekTo(idx: number) {
		const total = getGlobalSentences(sections).length;
		const next = Math.max(0, Math.min(idx, total - 1));
		globalIdx = next;
		if (offlineActive) {
			offlinePlayer?.seek(chunkForSentence(tts, next));
			return;
		}
		if (ttsEngine !== 'device') {
			// When paused this just parks the resume position; when playing it
			// aborts in-flight requests and starts at the new sentence. The
			// player works in derived-chunk space, so map the global index.
			void sentencePlayer?.seek(chunkForSentence(tts, next));
		} else if (isPlaying) {
			cancelSpeech();
			playWebSpeechCorrect();
		}
	}
	function skipSentence(dir: number) {
		seekTo(globalIdx + dir);
	}
	function nextSection() {
		const { sectionIdx } = globalToSectionChunk(sections, globalIdx);
		if (sectionIdx < sections.length - 1) {
			const target = sectionChunkToGlobal(sections, sectionIdx + 1, 0);
			if (isPlaying || ttsEngine !== 'device') seekTo(target);
			else globalIdx = target;
		}
	}
	function prevSection() {
		const { sectionIdx } = globalToSectionChunk(sections, globalIdx);
		if (sectionIdx > 0) {
			const target = sectionChunkToGlobal(sections, sectionIdx - 1, 0);
			if (isPlaying || ttsEngine !== 'device') seekTo(target);
			else globalIdx = target;
		}
	}
	function updateRate(v: number) {
		synthRate = v;
		sentencePlayer?.setRate(v);
		offlinePlayer?.setRate(v);
	}
	function handleOfflineFmtChange(fmt: OfflineAudioFmt) {
		offlineFmt = fmt;
		void refreshOfflineStates();
	}
	function handleOfflineUseChange(use: boolean) {
		offlineUse = use;
	}

	// Lock-screen controls (Media Session API): metadata + headset /
	// lock-screen buttons. Best-effort only — it does not keep audio
	// alive in the background, it just exposes what is already playing.
	$effect(() => {
		setMediaActionHandlers({
			onPlay: () => {
				if (!isPlaying) void startPlayback();
			},
			onPause: () => {
				if (isPlaying) handleToggle();
			},
			onPrev: () => skipSentence(-1),
			onNext: () => skipSentence(1)
		});
	});
	$effect(() => {
		const title = activeDoc?.title ?? null;
		if (!title) {
			clearMediaMetadata();
			return;
		}
		const total = totalSentences;
		const pos = total > 0 ? Math.max(0, Math.min(globalIdx, total - 1)) + 1 : 0;
		updateMediaMetadata({
			title,
			artist: total > 0 ? `Sentence ${pos} of ${total}` : 'OCR-TTS Reader',
			album:
				ttsEngine === 'device'
					? 'Device voice'
					: ttsEngine === 'pocket'
						? 'Pocket TTS'
						: ttsEngine === 'phonon'
							? 'Phonon (server)'
							: 'Phonon (browser)'
		});
		setMediaPlaybackState(isPlaying);
	});

	// Header actions
	async function handleLogoClick() {
		// The logo lands on the overview page (resume / library / listen now).
		view = 'overview';
		await refreshOverview();
	}
	// Phase 4 panel: opening the PDF view (re)renders once the canvas
	// remounts. The panel header's tab bar switches between Up next,
	// Library, and PDF without leaving the panel.
	function openPanel(kind: 'pdf' | 'playlist' | 'library') {
		panel = kind;
		if (kind === 'pdf' && pdfDoc) {
			void (async () => {
				await tick();
				await renderPdfPage();
			})();
		}
	}
	/** Header library button: toggle between the panel and reading. */
	function toggleLibraryPanel() {
		if (panel) panel = null;
		else openPanel(activePlaylistId ? 'playlist' : 'library');
	}
	function handleHeaderUpload() {
		// Header uploads are listen-now: the doc opens standalone.
		pendingPlaylistId = null;
		openDocPicker();
	}
	function handleLibraryButton() {
		if (activeDoc) {
			view = 'reader';
			toggleLibraryPanel();
		} else {
			view = 'overview';
			void refreshOverview();
		}
	}

	async function handleAddUnassignedToPlaylist(docId: string, playlistId: string) {
		const d = docs.find((x) => x.id === docId) ?? (await getDoc(docId));
		if (!d) {
			showToast('Document not found');
			return;
		}
		const source: ItemSource =
			pdfSizes[docId] !== undefined
				? { kind: 'pdf-upload' }
				: (await hasDocAssets(docId))
					? { kind: 'epub-upload' }
					: { kind: 'markdown-upload' };
		const item = await attachDocAsItem(playlistId, d, source);
		if (item) showToast('Added to playlist');
	}

	async function handleOpenUnassignedDoc(docId: string) {
		await openDoc(docId);
		view = 'reader';
	}

	// Postprocessing apply — offline client-side re-render, preserving user edits.
	let hasDirtyEdits = $derived(
		activeDoc ? markdownDraft !== (renderBaseline ?? (activeDoc as Doc).markdown) : false
	);
	async function applyPostprocess() {
		if (!activeDoc) return;
		// Drop any pending autosave so it can't clobber the fresh render below.
		if (saveDebounce) {
			clearTimeout(saveDebounce);
			saveDebounce = null;
		}
		// Persist the draft first so a re-render never loses typed-but-unsaved text.
		if (markdownDraft !== activeDoc.markdown) {
			activeDoc.markdown = markdownDraft;
			activeDoc.sections = parseMarkdownStructure(markdownDraft);
			try {
				await saveDoc(activeDoc);
			} catch (e: any) {
				showToast(`Re-render failed: ${e?.message ?? e}`);
				return;
			}
		}
		if (hasDirtyEdits) {
			if (!confirm('You have edited the Markdown. Re-applying postprocessing will keep your edits and apply the new settings on top. Continue?')) return;
		}
		try {
			const updated = await reapplyPostprocessing(
				activeDoc,
				currentPostprocessOpts(),
				hasDirtyEdits ? markdownDraft : undefined
			);
			activeDoc = updated;
			markdownDraft = updated.markdown;
			renderBaseline = updated.markdown;
			docs = await getAllDocs();
			globalIdx = 0;
			isEditing = false;
			showPostprocess = false;
			showToast('Postprocessing applied');
		} catch (e: any) {
			showToast(`Re-render failed: ${e?.message ?? e}`);
		}
	}

	// Overflow actions
	async function downloadMd() {
		if (!activeDoc) return;
		const blob = new Blob([activeDoc.markdown], { type: 'text/markdown' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${activeDoc.title}.md`;
		a.click();
		URL.revokeObjectURL(url);
	}
	async function saveAudioFile() {
		if (!activeDoc) return;
		const text = tts.texts.join(' ');
		const engine = offlineEngine();
		const { voiceId: resolvedVoiceId, blob } = resolveOfflineVoice();
		const voiceUrl = blob ? null : resolvedVoiceId;
		const id = await createTTSFileJob(text, voiceUrl, blob, 'wav', engine);
		showToast(`File job ${id} created — polling…`);
		for (let i = 0; i < 30; i++) {
			await new Promise((r) => setTimeout(r, 2000));
			const r = await fetch(`${API_BASE}/api/tts/jobs/${id}`);
			const j = await r.json();
			if (j.status === 'done') {
				window.open(getTTSDownloadUrl(id), '_blank');
				showToast('Download ready');
				break;
			}
			if (j.status === 'error') {
				showToast(`File job error: ${j.error}`);
				break;
			}
		}
	}
</script>

<svelte:head>
	<title>OCR-TTS Reader</title>
</svelte:head>

<div class="min-h-screen bg-slate-900 text-slate-100 flex flex-col">
	<Header activeTitle={activeDoc?.title ?? null} {breadcrumbs} onLogoClick={handleLogoClick} onLibraryClick={handleLibraryButton} />

	<input bind:this={docInputEl} type="file" accept=".pdf,.md,.markdown,.txt,.epub,application/pdf,text/markdown,text/plain,application/epub+zip" onchange={onDocSelected} class="hidden" />

	{#if toast}
		<div class="fixed top-16 right-4 bg-slate-800 border border-sky-500 text-slate-100 px-4 py-2 rounded-lg shadow z-50">{toast}</div>
	{/if}

	<OcrOfferModal
		open={ocrOffer !== null}
		totalPages={ocrOffer?.totalPages ?? 0}
		pages={ocrOffer?.pages ?? []}
		reasons={ocrOffer?.reasons ?? {}}
		failure={ocrOffer?.failure ?? false}
		onRun={handleOcrOfferRun}
		onKeep={handleOcrOfferKeep}
		onConfigure={handleOcrOfferConfigure}
		onClose={handleOcrOfferKeep}
	/>

	<main class="flex-1 min-h-0 flex flex-col mx-auto w-full px-4 py-4 gap-4 {view === 'reader' && activeDoc && panel && !isOcrRunning && !pdfPendingOcr ? 'max-w-none md:px-6' : 'max-w-6xl'}">
		{#if view === 'overview'}
			<Overview
				stats={overviewStats}
				searchIndex={overviewSearch}
				onResume={handleResumePlaylist}
				onOpenPlaylist={handleOpenPlaylist}
				onOpenItem={(pid, iid) => openPlaylistItem(pid, iid)}
				onOpenDoc={handleOpenUnassignedDoc}
				onShowLibrary={() => {
					view = 'reader';
					panel = 'library';
				}}
				onCreatePlaylist={handleCreatePlaylist}
				onUploadFile={() => {
					pendingPlaylistId = null;
					openDocPicker();
				}}
				onEnterUrl={() => (urlDialogOpen = true)}
				onPasteText={() => (pasteDialogOpen = true)}
			/>
		{:else if isOcrRunning}
			<OcrProgressPane {ocrProgress} {ocrEta} phase={ocrPhase} />
		{:else if pdfPendingOcr && pdfUrl}
			<div class="bg-slate-800 border border-sky-500/40 rounded-xl px-4 py-3 flex flex-col md:flex-row md:items-center gap-3">
				<div class="flex-1 min-w-0">
					<div class="text-sm font-medium text-slate-100 truncate">Staged: {pendingPdfName || 'document.pdf'} ({pdfTotalPages} pages)</div>
					<div class="text-xs text-slate-400">Preview the PDF, set page options, then extract — or attach its Markdown instead of OCR.</div>
				</div>
				<label class="flex items-center gap-2 text-xs text-slate-300">
					First page number
					<input
						type="number"
						min="1"
						step="1"
						value={optFirstPageNumber}
						oninput={(e) => {
							const n = parseInt((e.target as HTMLInputElement).value, 10);
							optFirstPageNumber = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
						}}
						class="w-20 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100"
					/>
				</label>
				<label class="flex items-center gap-2 text-xs text-slate-300">
					Engine
					<select
						bind:value={optEngine}
						aria-label="Extraction engine"
						title="auto extracts in the browser and offers LLM OCR for scans"
						class="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100"
					>
						<option value="auto">auto</option>
						<option value="liteparse">browser only</option>
						<option value="llm">OCR: LLM</option>
					</select>
				</label>
				{#if optEngine !== 'liteparse'}
					<div class="flex items-center gap-2">
						<button
							onclick={openLlmSettings}
							class="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-slate-600 text-slate-200 hover:bg-slate-700"
							title="Configure LLM OCR connection, model, and prompts"
						>
							<Settings2 size={14} /> LLM settings
						</button>
						<span
							class="max-w-[14rem] truncate text-[11px] text-slate-500"
							title={llmSettings.model ?? 'Using server default model'}
						>
							{llmSettings.model ?? 'Using server default model'}
						</span>
					</div>
				{/if}
				<div class="flex items-center gap-2">
					<button onclick={openDocPicker} class="text-xs px-3 py-1.5 rounded-md border border-slate-600 text-slate-200 hover:bg-slate-700">Attach Markdown</button>
					<button onclick={cancelPendingPdf} class="text-xs px-3 py-1.5 rounded-md border border-slate-600 text-slate-300 hover:bg-slate-700">Cancel</button>
					<button onclick={runOcr} class="text-xs px-4 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white font-medium">Extract text</button>
				</div>
			</div>
			<div class="grid md:grid-cols-2 gap-4 items-stretch min-h-0">
				<PdfPane
					{pdfUrl}
					bind:canvasEl
					{pdfPageNum}
					{pdfTotalPages}
					onPrev={prevPdfPage}
					onNext={nextPdfPage}
					onUploadClick={triggerPdfUpload}
					logicalPage={resolveStagedLogical(pdfPageNum)}
					showOverrideInput={true}
					pageOverrideText={pageOverrides[pdfPageNum] !== undefined ? String(pageOverrides[pdfPageNum]) : ''}
					onPageOverrideInput={(v) => handlePageOverrideChange(pdfPageNum, v)}
				/>
				{#if activeDoc}
					<MarkdownPane
						bind:this={markdownPaneRef}
						bind:editorEl
						{markdownDraft}
						{sections}
						{globalIdx}
						{isEditing}
						onDraftChange={onMarkdownDraftChange}
						onEditToggle={handleEditToggle}
						onEditSave={handleEditSave}
						onEditCancel={handleEditCancel}
						onOpenPostprocess={() => (showPostprocess = true)}
						onDownloadMd={downloadMd}
						onSaveAudio={saveAudioFile}
						hasActiveDoc={!!activeDoc}
						assetDocId={activeDoc?.id ?? null}
						onSentenceClick={handleSentenceClick}
					/>
				{:else}
					<div class="bg-slate-800 rounded-xl border border-slate-700 flex flex-col items-center justify-center gap-3 p-8 text-center min-h-[420px]">
						<div class="text-sm text-slate-300">No document yet — extract the staged PDF or attach its Markdown.</div>
						<div class="text-xs text-slate-500 max-w-sm">Markdown files with `Page N.` lines are validated against the PDF page count, then synced like OCR output.</div>
					</div>
				{/if}
			</div>
		{:else if activeDoc}
			<!-- Phase 4 reader: Markdown-focused. The panel is a slide-over
				overlay covering the reader on mobile, and a left sidebar
				(~1/3 width, independently scrolling) on desktop. -->
			<div class="relative mx-auto w-full flex flex-col min-h-0 md:flex-row md:gap-5 md:h-[calc(100vh-15rem)] md:min-h-[480px] md:max-h-[860px] {panel ? 'max-w-none' : 'max-w-3xl'}">
				{#if panel}
					<aside
						transition:fly={{ x: 72, duration: 160 }}
						aria-label={panel === 'pdf' ? 'PDF viewer' : panel === 'playlist' ? 'Playlist' : 'Library'}
						class="absolute inset-0 z-30 flex flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 md:static md:z-auto md:h-full md:w-[34%] md:max-w-md md:shrink-0 md:bg-slate-800"
					>
						<div class="shrink-0 border-b border-slate-700 px-3 pb-2 pt-2">
							<div class="flex items-center gap-2">
								<span class="flex-1 min-w-0 truncate text-sm font-semibold text-slate-100">
									{panel === 'pdf'
										? 'PDF'
										: panel === 'playlist'
											? (playlists.find((p) => p.id === activePlaylistId)?.name ?? 'Playlist')
											: 'Library'}
								</span>
								<button
									onclick={() => (panel = null)}
									aria-label="Close panel"
									title="Back to reading"
									class="flex h-8 w-8 items-center justify-center rounded-md text-slate-300 hover:bg-slate-700"
								>
									<X size={16} />
								</button>
							</div>
							<div class="mt-2 grid grid-cols-3 gap-1 rounded-lg border border-slate-700 bg-slate-900/60 p-1" role="tablist" aria-label="Panel views">
								<button
									role="tab"
									aria-selected={panel === 'playlist'}
									onclick={() => openPanel('playlist')}
									title="Up next (playlist)"
									class="inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors {panel === 'playlist' ? 'bg-sky-600 text-white' : 'text-slate-300 hover:bg-slate-700'}"
								>
									<ListMusic size={14} /> Up next
								</button>
								<button
									role="tab"
									aria-selected={panel === 'library'}
									onclick={() => openPanel('library')}
									title="Library"
									class="inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors {panel === 'library' ? 'bg-sky-600 text-white' : 'text-slate-300 hover:bg-slate-700'}"
								>
									<LibraryBig size={14} /> Library
								</button>
								<button
									role="tab"
									aria-selected={panel === 'pdf'}
									onclick={() => openPanel('pdf')}
									title="PDF viewer"
									class="inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors {panel === 'pdf' ? 'bg-sky-600 text-white' : 'text-slate-300 hover:bg-slate-700'}"
								>
									<FileText size={14} /> PDF
								</button>
							</div>
						</div>
						<div class="min-h-0 flex-1 overflow-y-auto">
							{#if panel === 'pdf'}
								<PdfPane
									{pdfUrl}
									bind:canvasEl
									{pdfPageNum}
									{pdfTotalPages}
									onPrev={prevPdfPage}
									onNext={nextPdfPage}
									onUploadClick={triggerPdfUpload}
									logicalPage={physicalToLogical(pdfPageNum, activeDoc?.pageMap)}
								/>
							{:else if panel === 'playlist'}
								<PlaylistPane
									playlist={playlists.find((p) => p.id === activePlaylistId) ?? null}
									items={playlistItems}
									stats={itemStats}
									{activeItemId}
									canAddCurrentDoc={!!activeDoc &&
										!!activePlaylistId &&
										!playlistItems.some((i) => i.docId === activeDoc?.id)}
									onSelectItem={(id) => {
										if (activePlaylistId) openPlaylistItem(activePlaylistId, id);
									}}
									onRenameItem={handleRenamePlaylistItem}
									onDeleteItem={handleDeletePlaylistItem}
									onBulkDelete={handleBulkDeletePlaylistItems}
									onMoveItem={handleMovePlaylistItem}
									onDropItem={handleDropPlaylistItem}
									onShowPdf={handleShowItemPdf}
									onClearItemPdf={handleClearItemPdf}
									offline={offlineItemState}
									onGenerateOffline={(id) => void handleGenerateOfflineItem(id)}
									onDeleteOffline={(id) => void handleDeleteOfflineItem(id)}
									onReprocessItem={handleReprocessItem}
									onConfigureLlm={openLlmSettings}
									onOpenLibrary={() => openPanel('library')}
									onUploadDoc={handlePlaylistDocUpload}
									onPasteText={(title, text) => handlePasteText(activePlaylistId, text, title)}
									onFetchUrl={(url) => handleFetchUrl(activePlaylistId, url)}
									onAddCurrentDoc={handleAddCurrentDoc}
								/>
							{:else}
								<LibraryPane
									{playlists}
									stats={libraryStats}
									{activePlaylistId}
									unassigned={unassignedDocs.map((d) => ({
										id: d.id,
										title: d.title,
										hasPdf: pdfSizes[d.id] !== undefined
									}))}
									onOpenPlaylist={handleOpenPlaylist}
									onCreatePlaylist={handleCreatePlaylist}
									onRenamePlaylist={handleRenamePlaylist}
									onDeletePlaylist={handleDeletePlaylist}
									onOpenDoc={handleOpenUnassignedDoc}
									onRenameDoc={renameDoc}
									onDeleteDoc={deleteDocHandler}
									onAddDocToPlaylist={handleAddUnassignedToPlaylist}
								/>
							{/if}
						</div>
					</aside>
				{/if}
				<div class="min-h-0 flex-1 md:h-full">
					<MarkdownPane
						bind:this={markdownPaneRef}
						bind:editorEl
						{markdownDraft}
						{sections}
						{globalIdx}
						{isEditing}
						onDraftChange={onMarkdownDraftChange}
						onEditToggle={handleEditToggle}
						onEditSave={handleEditSave}
						onEditCancel={handleEditCancel}
						onOpenPostprocess={() => (showPostprocess = true)}
						onDownloadMd={downloadMd}
						onSaveAudio={saveAudioFile}
						hasActiveDoc={!!activeDoc}
						assetDocId={activeDoc?.id ?? null}
						onSentenceClick={handleSentenceClick}
						bare
					/>
				</div>
			</div>
		{:else}
			<div class="flex-1 flex flex-col items-center justify-center gap-4 py-12 text-center">
				<h2 class="text-lg font-semibold text-slate-200">No document selected</h2>
				<p class="text-sm text-slate-400 max-w-md">Upload a PDF to extract text, upload Markdown directly, or open a document from the library.</p>
				<div class="mt-2 flex flex-wrap items-center justify-center gap-2">
					<button onclick={handleHeaderUpload} class="inline-flex items-center gap-2 bg-sky-600 hover:bg-sky-500 text-white px-5 py-2 rounded-md font-medium">
						Upload file
					</button>
				</div>
			<button
				onclick={() => {
					view = 'overview';
					void refreshOverview();
				}}
				class="text-sm text-slate-400 hover:text-slate-200 underline"
			>
				Go to overview
			</button>
		</div>
	{/if}
	</main>

	<PlayerBar
		{globalIdx}
		{totalSentences}
		{remainingText}
		{isPlaying}
		onPrevSection={prevSection}
		onPrevSentence={() => skipSentence(-1)}
		onToggle={handleToggle}
		onNextSentence={() => skipSentence(1)}
		onNextSection={nextSection}
		onSeek={seekTo}
		onSettings={() => (showTtsSettings = true)}
	/>

	{#if urlDialogOpen}
		<div
			class="fixed inset-0 z-50 flex items-center justify-center p-4"
			role="dialog"
			aria-modal="true"
			aria-label="Add URL"
		>
			<button
				class="absolute inset-0 bg-black/60 backdrop-blur-sm"
				onclick={() => (urlDialogOpen = false)}
				aria-label="Close"
				tabindex="-1"
			></button>
			<form
				onsubmit={(e) => {
					e.preventDefault();
					const v = listenUrlValue;
					listenUrlValue = '';
					urlDialogOpen = false;
					void handleFetchUrl(null, v);
				}}
				class="relative w-full max-w-md bg-slate-800 rounded-xl border border-slate-700 p-4 flex flex-col gap-3"
			>
				<h2 class="text-base font-semibold text-slate-100">Add URL</h2>
				<p class="text-xs text-slate-400">
					Articles are fetched and converted to Markdown; links ending in .pdf download the PDF
					for OCR instead.
				</p>
				<input
					bind:value={listenUrlValue}
					placeholder="https://example.com/article"
					aria-label="Article or PDF URL"
					class="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-sky-500"
					autofocus
				/>
				<div class="flex justify-end gap-2">
					<button
						type="button"
						onclick={() => (urlDialogOpen = false)}
						class="text-sm px-4 py-1.5 rounded-md border border-slate-600 text-slate-300 hover:bg-slate-700"
					>
						Cancel
					</button>
					<button
						type="submit"
						class="text-sm px-4 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white font-medium"
					>
						Add
					</button>
				</div>
			</form>
		</div>
	{/if}

	{#if pasteDialogOpen}
		<div
			class="fixed inset-0 z-50 flex items-center justify-center p-4"
			role="dialog"
			aria-modal="true"
			aria-label="Paste text"
		>
			<button
				class="absolute inset-0 bg-black/60 backdrop-blur-sm"
				onclick={() => (pasteDialogOpen = false)}
				aria-label="Close"
				tabindex="-1"
			></button>
			<form
				onsubmit={(e) => {
					e.preventDefault();
					const t = listenPasteTitle;
					const v = listenPasteValue;
					listenPasteTitle = '';
					listenPasteValue = '';
					pasteDialogOpen = false;
					void handlePasteText(null, v, t);
				}}
				class="relative w-full max-w-md bg-slate-800 rounded-xl border border-slate-700 p-4 flex flex-col gap-3"
			>
				<h2 class="text-base font-semibold text-slate-100">Paste text</h2>
				<p class="text-xs text-slate-400">Paste Markdown or plain text to listen to right away.</p>
				<input
					bind:value={listenPasteTitle}
					placeholder="Title (optional — first line used otherwise)"
					aria-label="Pasted text title"
					class="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-sky-500"
				/>
				<textarea
					bind:value={listenPasteValue}
					rows={8}
					placeholder="Paste Markdown or plain text…"
					aria-label="Text to listen to"
					class="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-sky-500"
					autofocus
				></textarea>
				<div class="flex justify-end gap-2">
					<button
						type="button"
						onclick={() => (pasteDialogOpen = false)}
						class="text-sm px-4 py-1.5 rounded-md border border-slate-600 text-slate-300 hover:bg-slate-700"
					>
						Cancel
					</button>
					<button
						type="submit"
						class="text-sm px-4 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white font-medium"
					>
						Add
					</button>
				</div>
			</form>
		</div>
	{/if}

	<TtsSettingsModal
		open={showTtsSettings}
		onClose={() => (showTtsSettings = false)}
		{ttsEngine}
		onEngineChange={handleEngineChange}
		{builtinVoices}
		{phononVoices}
		{phononBrowserVoices}
		{customVoices}
		{synthVoices}
		{selectedVoiceId}
		onVoiceChange={handleVoiceChange}
		onRenameVoice={handleRenameVoice}
		onDeleteVoice={handleDeleteVoice}
		{synthRate}
		onRateChange={updateRate}
		onVoiceFile={onVoiceFile}
		{isBackendGenerating}
		{offlineFmt}
		onOfflineFmtChange={handleOfflineFmtChange}
		offlineUse
		onOfflineUseChange={handleOfflineUseChange}
		{phononAvailable}
		{pocketAvailable}
		{phononStatus}
		onPhononPreload={preloadPhononBrowser}
	/>

	<PostprocessingModal
		open={showPostprocess}
		onClose={() => (showPostprocess = false)}
		{optCombine}
		{optPageMarkers}
		{optUppercase}
		onCombineChange={(v) => (optCombine = v)}
		onPageMarkersChange={(v) => (optPageMarkers = v)}
		onUppercaseChange={(v) => (optUppercase = v)}
		optFirstPageMarker={optFirstPageMarker}
		onFirstPageMarkerChange={(v) => (optFirstPageMarker = v)}
		optFirstPageNumber={optFirstPageNumber}
		onFirstPageNumberChange={(v) => (optFirstPageNumber = v)}
		{hasDirtyEdits}
		onApply={applyPostprocess}
	/>

	<LlmOcrSettingsModal
		open={showLlmSettings}
		onClose={() => (showLlmSettings = false)}
		settings={llmSettings}
		apiKey={llmApiKey}
		rememberApiKey={rememberLlmApiKey}
		defaults={llmDefaults}
		apiBase={API_BASE}
		onSave={handleSaveLlmSettings}
	/>
</div>

<style>
	:global(body) { margin: 0; }
</style>
