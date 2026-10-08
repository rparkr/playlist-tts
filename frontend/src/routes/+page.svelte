<script lang="ts">
	import { onMount, tick } from 'svelte';
	import {
		createDoc,
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
		createPlaylist,
		getPlaylists,
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
	import { createTTSFileJob, getTTSDownloadUrl } from '$lib/tts/backendStream';
	import { BackendSentencePlayer } from '$lib/tts/backendSentencePlayer';
	import { estimateRemainingSeconds, recordEtaSample } from '$lib/tts/etaStats';
	import Header from '$lib/components/Header.svelte';
	import PlayerBar from '$lib/components/PlayerBar.svelte';
	import LibraryModal from '$lib/components/LibraryModal.svelte';
	import Overview, {
		type OverviewPlaylistStat,
		type OverviewSearchHit
	} from '$lib/components/Overview.svelte';
	import PlaylistPane, { type PlaylistItemStat } from '$lib/components/PlaylistPane.svelte';
	import LibraryPane, { type LibraryPlaylistStat } from '$lib/components/LibraryPane.svelte';
	import TtsSettingsModal from '$lib/components/TtsSettingsModal.svelte';
	import PostprocessingModal from '$lib/components/PostprocessingModal.svelte';
	import MarkdownPane from '$lib/components/MarkdownPane.svelte';
	import PdfPane from '$lib/components/PdfPane.svelte';
	import OcrProgressPane from '$lib/components/OcrProgressPane.svelte';
	import { formatEta, formatRemaining, resolveAnchoredEta, tickDownEta } from '$lib/ocrEta';
	import { domainOf, isPdfUrl, sourceLabel } from '$lib/playlists/model';
	import {
		LS_KEYS,
		URL_PARAMS,
		parseEngine,
		parseRate,
		parseSentenceIndex,
		parsePostprocessFlags,
		parseVoiceByEngine,
		isBuiltinVoiceName,
		resolveVoiceId,
		serializePostprocessFlags,
		serializeVoiceByEngine,
		voiceForEngine,
		voiceUrlParam,
		withVoiceForEngine,
		resolveWithUrlPrecedence,
		progressKey,
		type TtsEngine,
		type VoiceByEngine
	} from '$lib/settings';

	// --- State ---
	let docs: Doc[] = $state([]);
	let customVoices: VoiceRecord[] = $state([]);
	let builtinVoices: { name: string }[] = $state([]);
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
	let isOcrRunning: boolean = $state(false);
	let ocrProgress: { done: number; total: number } | null = $state(null);
	let ocrStartAt: number | null = $state(null);
	// Anchored countdown ETA: each progress step sets a new anchor; the
	// per-second ticker only ever counts that anchor down.
	let ocrEtaSeconds: number | null = $state(null);
	let ocrEtaAnchoredAt: number | null = $state(null);
	let ocrNow: number = $state(Date.now());

	let globalIdx: number = $state(0);
	let isPlaying: boolean = $state(false);
	let useBackendTTS: boolean = $state(false);
	let sentencePlayer: BackendSentencePlayer | null = $state.raw(null);
	let selectedVoiceId: string = $state('alba');
	// Per-engine voice memory: each TTS engine remembers its own selection.
	let voiceByEngine: VoiceByEngine = $state({ device: null, pocket: null });
	let synthRate: number = $state(1.0);
	let toast: string | null = $state(null);

	let optCombine: boolean = $state(true);
	let optUppercase: boolean = $state(true);
	let optPunct: boolean = $state(true);
	let optPageMarkers: boolean = $state(true);
	let optFirstPageMarker: boolean = $state(true);
	let optFirstPageNumber: number = $state(1);
	// Guard persistence writes until onMount has restored last-set state, so
	// default initial values never clobber localStorage on first render.
	let settingsHydrated: boolean = $state(false);

	// Pre-OCR staging (#6): a newly selected PDF previews before any POST.
	// `pageOverrides` maps physical PDF pages → logical `Page N.` numbers.
	let pdfPendingOcr: boolean = $state(false);
	let pendingPdfName: string = $state('');
	let pageOverrides: Record<number, number> = $state({});
	let mdInputEl: HTMLInputElement | null = $state(null);

	function currentPostprocessOpts(): PostprocessOptions {
		return {
			combine_columns: optCombine,
			normalize_uppercase: optUppercase,
			ensure_punctuation: optPunct,
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
		optPunct = doc.postprocess.ensure_punctuation;
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
						punct: optPunct,
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
	let showLibrary = $state(false);
	let showTtsSettings = $state(false);
	let showPostprocess = $state(false);
	// Phase 3: overview view + tri-mode left pane (PDF | Playlist | Library).
	// The logo lands on the overview; the header eye-toggle shows/hides the pane.
	let view: 'overview' | 'reader' = $state('reader');
	let leftPane: 'pdf' | 'playlist' | 'library' = $state('playlist');
	let leftVisible = $state(true);
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
	/** New docs (OCR / upload / fetch / paste) land in this playlist when set. */
	let pendingPlaylistId: string | null = $state(null);
	/** Listen-now URL / paste dialogs from the overview page. */
	let urlDialogOpen = $state(false);
	let pasteDialogOpen = $state(false);
	let listenUrlValue: string = $state('');
	let listenPasteValue: string = $state('');

	let pdfInputEl: HTMLInputElement | null = $state(null);

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
		try {
			const r = await fetch(`${API_BASE}/api/tts/voices`);
			if (r.ok) {
				const data = await r.json();
				builtinVoices = data.voices ?? [{ name: 'alba' }];
			} else builtinVoices = [{ name: 'alba' }];
		} catch {
			builtinVoices = [{ name: 'alba' }];
		}
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
		const engine = resolveWithUrlPrecedence(engineParam, storedEngine, 'device' as const, parseEngine);
		useBackendTTS = engine === 'pocket';
		// Per-engine voice: stored map first, legacy single key migrates into
		// the current engine's slot, URL `voice` wins for the current engine.
		// The URL carries clone *names* (slugified); stored state keeps IDs.
		const storedMap = parseVoiceByEngine(localStorage.getItem(LS_KEYS.voiceByEngine)) ?? {
			device: null,
			pocket: null
		};
		if (storedVoice && !storedMap[engine]) storedMap[engine] = storedVoice;
		if (voiceParam) {
			const fallbackVoice = storedMap[engine] ?? storedVoice ?? 'alba';
			storedMap[engine] = resolveVoiceId(voiceParam, { builtinVoices, customVoices }, fallbackVoice);
		}
		voiceByEngine = storedMap;
		selectedVoiceId = voiceForEngine(voiceByEngine, engine, 'alba');
		// Postprocessing defaults: last-set global prefs until a doc overrides.
		const storedPostprocess = parsePostprocessFlags(localStorage.getItem(LS_KEYS.postprocess));
		if (storedPostprocess) {
			optCombine = storedPostprocess.combine;
			optUppercase = storedPostprocess.uppercase;
			optPunct = storedPostprocess.punct;
			optPageMarkers = storedPostprocess.pageMarkers;
			if (typeof storedPostprocess.firstPageMarker === 'boolean') optFirstPageMarker = storedPostprocess.firstPageMarker;
			if (typeof storedPostprocess.firstPageNumber === 'number') optFirstPageNumber = storedPostprocess.firstPageNumber;
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
		localStorage.setItem(LS_KEYS.engine, useBackendTTS ? 'pocket' : 'device');
		localStorage.setItem(
			LS_KEYS.postprocess,
			serializePostprocessFlags({
				combine: optCombine,
				uppercase: optUppercase,
				punct: optPunct,
				pageMarkers: optPageMarkers,
				firstPageMarker: optFirstPageMarker,
				firstPageNumber: optFirstPageNumber
			})
		);
		if (typeof window !== 'undefined' && activeDoc) {
			const url = new URL(window.location.href);
			url.searchParams.set(URL_PARAMS.doc, activeDoc.slug ?? activeDoc.id);
			url.searchParams.set(URL_PARAMS.sentence, String(globalIdx));
			url.searchParams.set(URL_PARAMS.rate, String(synthRate));
			// Cloned voices are deep-linked by slugified name, not raw ID.
			url.searchParams.set(URL_PARAMS.voice, voiceUrlParam(selectedVoiceId, customVoices));
			url.searchParams.set(URL_PARAMS.engine, useBackendTTS ? 'pocket' : 'device');
			history.replaceState(null, '', url.toString());
		}
	});

	// Derived — sections live-parse the draft while it differs from the saved
	// doc, so unsaved edits (and the save debounce window) reach the viewer
	// and TTS immediately instead of only after persisting.
	let sections: Section[] = $derived.by(() =>
		selectSections(activeDoc?.sections, activeDoc?.markdown, markdownDraft)
	);
	let totalSentences: number = $derived(getGlobalSentences(sections).length);
	let currentSectionIdx: number = $derived(globalToSectionChunk(sections, globalIdx).sectionIdx);
	let currentSection: Section | null = $derived(sections[currentSectionIdx] ?? null);
	let breadcrumbs: string = $derived(currentSection ? currentSection.titles.join(' > ') : '');

	// Keep the backend player's snapshot aligned with the live sections, so
	// edits (saved or not) replace what TTS speaks from the next sentence on
	// and deleted sentences can never sound after a pause/seek/resume.
	$effect(() => {
		sentencePlayer?.updateSentences(getGlobalSentences(sections));
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
		if (!leftVisible || leftPane !== 'pdf' || !pdfDoc || pdfTotalPages <= 0 || isOcrRunning || pdfPendingOcr) return;
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
			useBackendTTS ? 'pocket' : 'device',
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

	function anchorOcrEta(done: number, total: number, eventEta: unknown) {
		if (!isOcrRunning || ocrStartAt === null) return;
		const elapsed = (Date.now() - ocrStartAt) / 1000;
		const next = resolveAnchoredEta(eventEta, done, total, elapsed);
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

	async function onPdfSelected(e: Event) {
		const input = e.target as HTMLInputElement;
		if (!input.files?.[0]) return;
		const file = input.files[0];
		setPdfFromBlob(file, file.name);
		pendingPdfName = file.name;
		pageOverrides = {};
		pdfPendingOcr = true;
		leftVisible = true;
		leftPane = 'pdf';
		// Stage the PDF for preview + options — do NOT POST yet. The user
		// presses "Extract text" (staging bar) to kick off OCR (#6).
		await loadPdf();
		showToast('PDF loaded — set page options, then press Extract text');
		// reset input so same file can be re-selected
		input.value = '';
	}

	function cancelPendingPdf() {
		pdfPendingOcr = false;
		pendingPdfName = '';
		pageOverrides = {};
		pendingPlaylistId = null;
		clearPdfViewer();
		if (activeDoc) void loadCachedPdf(activeDoc.id);
	}

	// Markdown upload + PDF+Markdown pair (#20). Markers (`Page N.` lines)
	// drive viewer sync; the PDF page count validates the pairing.
	function triggerMarkdownUpload() {
		mdInputEl?.click();
	}

	async function onMarkdownSelected(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
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
				leftPane = 'pdf';
				leftVisible = true;
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
		pdfInputEl?.click();
	}

	/** Playlist "+" menu uploads: the new doc lands in the open playlist. */
	function handlePlaylistPdfUpload() {
		pendingPlaylistId = activePlaylistId;
		pdfInputEl?.click();
	}
	function handlePlaylistMarkdownUpload() {
		pendingPlaylistId = activePlaylistId;
		mdInputEl?.click();
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
		// The PdfPane canvas unmounts while OCR progress is shown, when the
		// left pane is hidden, or when it shows playlist/library instead.
		if (!leftVisible || leftPane !== 'pdf') return;
		// The PdfPane canvas unmounts while OCR progress is shown (and when
		// the pane is hidden), so wait for it to be bound before drawing.
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
			if (isPlaying || useBackendTTS) seekTo(markerIdx);
			else globalIdx = markerIdx;
		} else if (markerIdx === -1 && physical === 1 && globalIdx !== 0) {
			if (isPlaying || useBackendTTS) seekTo(0);
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
		isOcrRunning = true;
		ocrProgress = { done: 0, total: 0 };
		ocrStartAt = Date.now();
		ocrEtaSeconds = null;
		ocrEtaAnchoredAt = null;
		ocrNow = Date.now();
		let ocrSucceeded = false;
		try {
			const fd = new FormData();
			// Pass filename explicitly so the backend always sees it,
			// even if the File object was wrapped/proxied by state.
			fd.append('file', fileToUpload, fileToUpload.name || 'upload.pdf');
			fd.append('postprocess', JSON.stringify(currentPostprocessOpts()));
			const resp = await fetch(`${API_BASE}/api/ocr/jobs`, { method: 'POST', body: fd });
			if (!resp.ok) throw new Error(await parseErrorResponse(resp));
			const { job_id } = await resp.json();
			const es = new EventSource(`${API_BASE}/api/ocr/jobs/${job_id}/events`);
			await new Promise<any>((resolve, reject) => {
				es.onmessage = (ev) => {
					try {
						const data = JSON.parse(ev.data);
						if (data.type === 'progress' || data.type === 'keepalive') {
							ocrProgress = { done: data.done ?? 0, total: data.total ?? 0 };
							anchorOcrEta(data.done ?? 0, data.total ?? 0, data.eta);
						} else if (data.type === 'done') {
							es.close();
							resolve(data);
						} else if (data.type === 'error') {
							es.close();
							reject(new Error(data.error));
						}
					} catch {}
				};
				es.onerror = () => {};
			}).catch(async () => {
				for (let i = 0; i < 120; i++) {
					await new Promise((r) => setTimeout(r, 2000));
					const r = await fetch(`${API_BASE}/api/ocr/jobs/${job_id}`);
					if (!r.ok) continue;
					const j = await r.json();
					ocrProgress = { done: j.progress.done, total: j.progress.total };
					anchorOcrEta(j.progress.done, j.progress.total, j.progress.eta);
					if (j.status === 'done') return j;
					if (j.status === 'error') throw new Error(j.error);
				}
				throw new Error('OCR poll timeout');
			});
			const r = await fetch(`${API_BASE}/api/ocr/jobs/${job_id}`);
			const job = await r.json();
			if (job.status !== 'done') throw new Error(job.error ?? 'OCR failed');
			const result = job.result;
			const title = fileToUpload.name.replace(/\.pdf$/i, '') || 'Untitled';
			// Prefer raw backend output so re-render stays client-side/offline.
			// Fall back to processed markdown for older backends.
			const rawMarkdown = result.raw_markdown ?? result.markdown;
			const rawPageMap = result.raw_page_map ?? result.page_map;
			const doc = await createDoc(title, rawMarkdown, rawPageMap, currentPostprocessOpts());
			// Cache the uploaded PDF so the viewer can reload it after
			// reloads and doc switches. Storage failures must not fail OCR.
			try {
				await savePdf(doc.id, fileToUpload, fileToUpload.name || 'upload.pdf');
			} catch (e: any) {
				showToast(`OCR completed, but PDF caching failed: ${e?.message ?? e}`);
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
			}
			showToast('OCR completed');
			ocrSucceeded = true;
		} catch (e: any) {
			showToast(`OCR failed: ${e.message}`);
		} finally {
			isOcrRunning = false;
			ocrProgress = null;
			ocrStartAt = null;
			ocrEtaSeconds = null;
			ocrEtaAnchoredAt = null;
		}
		// Load the preview only after the progress pane is gone — while OCR
		// runs the PdfPane (and its canvas) is unmounted, so rendering then
		// silently no-ops and the viewer stays blank.
		if (ocrSucceeded && pdfUrl) {
			await tick();
			await loadPdf();
		}
	}

	async function openDoc(id: string) {
		const d = await getDoc(id);
		if (!d) return;
		if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel();
		sentencePlayer?.stop();
		isPlaying = false;
		pdfPendingOcr = false;
		pendingPdfName = '';
		pageOverrides = {};
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
		await refreshItemStats();
		await refreshLibraryStats();
	}

	/** Per-card progress + ETA stats for the open playlist's items. */
	async function refreshItemStats() {
		const engine = useBackendTTS ? 'pocket' : 'device';
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
		const engine = useBackendTTS ? 'pocket' : 'device';
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
		overviewSearch = idx;
	}

	/** Start (or resume) playback from the current sentence. */
	function startPlayback() {
		isPlaying = true;
		if (useBackendTTS) {
			if (sentencePlayer?.canResume()) void sentencePlayer.resume();
			else playBackend();
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
		leftVisible = true;
		await refreshPlaylistData();
		await tick();
		await loadCachedPdf(d.id);
		if (opts?.autoplay) startPlayback();
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
				leftVisible = true;
				leftPane = 'pdf';
				view = 'reader';
				await loadPdf();
				showToast('PDF loaded — set page options, then press Extract text');
			} catch (e: unknown) {
				showToast(`PDF download failed: ${(e as Error)?.message ?? e}`);
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

	async function handlePasteText(targetPlaylistId: string | null, text: string) {
		const clean = text.trim();
		if (!clean) return;
		const firstLine =
			clean
				.split('\n')
				.map((l) => l.trim())
				.find((l) => l.length > 0) ?? 'Pasted text';
		const title = firstLine.replace(/^#+\s*/, '').slice(0, 80) || 'Pasted text';
		pendingPlaylistId = targetPlaylistId;
		try {
			const doc = await createDoc(title, clean, undefined, currentPostprocessOpts());
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
		leftPane = 'playlist';
		leftVisible = true;
		view = 'reader';
	}

	async function handleOpenPlaylist(id: string) {
		activePlaylistId = id;
		leftPane = 'playlist';
		leftVisible = true;
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
		leftPane = 'pdf';
		leftVisible = true;
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
			pdfSizes[doc.id] !== undefined ? { kind: 'pdf-upload' } : { kind: 'markdown-upload' };
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
			// Capture scroll pre-swap so edit mode lands at the same view.
			markdownPaneRef?.prepareEditSwap?.(true);
			isEditing = true;
		} else {
			// shouldn't happen because save/cancel handle
			markdownPaneRef?.prepareEditSwap?.(false);
			isEditing = false;
		}
	}
	async function handleEditSave() {
		if (!activeDoc) return;
		if (saveDebounce) {
			clearTimeout(saveDebounce);
			saveDebounce = null;
		}
		markdownPaneRef?.prepareEditSwap?.(false);
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
		markdownPaneRef?.prepareEditSwap?.(false);
		isEditing = false;
	}
	function handleSentenceClick(idx: number) {
		if (isPlaying || useBackendTTS) seekTo(idx);
		else globalIdx = idx;
	}

	function handleVoiceChange(id: string) {
		selectedVoiceId = id;
		// Remember the choice under the current engine so toggling engines
		// restores each engine's last voice.
		const engine: TtsEngine = useBackendTTS ? 'pocket' : 'device';
		voiceByEngine = withVoiceForEngine(voiceByEngine, engine, id);
		// Cache keys are voice-scoped, so just restart the chain: the new
		// voice synthesizes from the current sentence, nothing earlier.
		if (isPlaying && useBackendTTS) playBackend();
	}

	function handleEngineChange(useBackend: boolean) {
		// Park the current selection under the old engine before switching.
		const fromEngine: TtsEngine = useBackendTTS ? 'pocket' : 'device';
		const toEngine: TtsEngine = useBackend ? 'pocket' : 'device';
		voiceByEngine = withVoiceForEngine(voiceByEngine, fromEngine, selectedVoiceId);
		useBackendTTS = useBackend;
		// Restore the other engine's last voice; the first toggle carries the
		// current selection over so nothing unexpectedly resets to a default.
		const next = voiceForEngine(voiceByEngine, toEngine, selectedVoiceId);
		voiceByEngine = withVoiceForEngine(voiceByEngine, toEngine, next);
		selectedVoiceId = next;
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
		while (isBuiltinVoiceName(name, builtinVoices)) {
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
		if (isBuiltinVoiceName(clean, builtinVoices)) {
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
		// Park any slot that pointed at the deleted voice onto a built-in.
		const fallback = builtinVoices[0]?.name ?? 'alba';
		voiceByEngine = {
			device: voiceByEngine.device === id ? fallback : voiceByEngine.device,
			pocket: voiceByEngine.pocket === id ? fallback : voiceByEngine.pocket
		};
		if (selectedVoiceId === id) {
			selectedVoiceId = fallback;
			if (isPlaying && useBackendTTS) playBackend();
		}
	}

	async function onVoiceFile(e: Event) {
		const input = e.target as HTMLInputElement;
		if (!input.files?.[0]) return;
		const file = input.files[0];
		if (file.name.toLowerCase().endsWith('.safetensors')) {
			const base = file.name.replace(/\.safetensors$/i, '') || 'voice';
			const name = promptForVoiceName(base, 'Name this voice (from .safetensors):');
			if (name === null) {
				(input as HTMLInputElement).value = '';
				return;
			}
			const blob = new Blob([await file.arrayBuffer()], { type: 'application/octet-stream' });
			const record: VoiceRecord = { id: 'voice_' + Date.now().toString(36), name, blob, bytes: blob.size, sourceWavName: file.name, createdAt: Date.now() };
			await saveVoice(record);
			customVoices = await getCustomVoices();
			selectedVoiceId = record.id;
			voiceByEngine = withVoiceForEngine(voiceByEngine, useBackendTTS ? 'pocket' : 'device', record.id);
			showToast(`Voice "${name}" saved (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
			(input as HTMLInputElement).value = '';
			return;
		}
		const fd = new FormData();
		fd.append('voice_wav', file, file.name || 'voice.wav');
		try {
			const resp = await fetch(`${API_BASE}/api/tts/voices/convert`, { method: 'POST', body: fd });
			if (!resp.ok) throw new Error(await parseErrorResponse(resp));
			const blob = await resp.blob();
			const base = file.name.replace(/\.[^.]+$/, '') || 'voice';
			const name = promptForVoiceName(base, 'Name this voice:');
			if (name === null) return;
			const record: VoiceRecord = { id: 'voice_' + Date.now().toString(36), name, blob, bytes: blob.size, sourceWavName: file.name, createdAt: Date.now() };
			await saveVoice(record);
			customVoices = await getCustomVoices();
			selectedVoiceId = record.id;
			voiceByEngine = withVoiceForEngine(voiceByEngine, useBackendTTS ? 'pocket' : 'device', record.id);
			showToast(`Voice "${name}" saved (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
		} catch (err: any) {
			showToast(`Voice clone failed: ${err.message}`);
		} finally {
			(input as HTMLInputElement).value = '';
		}
	}

	// Player
	let isBackendGenerating: boolean = $state(false);

	function getSentencePlayer(): BackendSentencePlayer {
		if (!sentencePlayer) {
			sentencePlayer = new BackendSentencePlayer();
			sentencePlayer.setCallbacks({
				onSentenceStart: (idx) => {
					globalIdx = idx;
				},
				onSentenceComplete: (_idx, chars, secondsAt1x) => {
					// Refine ETA stats for the voice+engine that sounded it.
					recordEtaSample(
						selectedVoiceId,
						useBackendTTS ? 'pocket' : 'device',
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

	function resolveBackendVoice(): { voiceKey: string; voiceId: string | null; blob: Blob | null } {
		const custom = customVoices.find((v) => v.id === selectedVoiceId);
		if (custom) return { voiceKey: custom.id, voiceId: null, blob: custom.blob };
		return { voiceKey: selectedVoiceId, voiceId: selectedVoiceId, blob: null };
	}

	/** Start backend playback from `globalIdx` — one sentence per request. */
	function playBackend() {
		if (!activeDoc) return;
		const all = getGlobalSentences(sections);
		if (all.slice(globalIdx).every((s) => !s.trim())) {
			isPlaying = false;
			return;
		}
		const { voiceKey, voiceId, blob } = resolveBackendVoice();
		isBackendGenerating = true;
		void getSentencePlayer().play(all, globalIdx, voiceKey, voiceId, blob, synthRate);
	}
	function playWebSpeechCorrect() {
		if (!isPlaying || !activeDoc) { isPlaying = false; return; }
		const all = getGlobalSentences(sections);
		if (globalIdx >= all.length) { isPlaying = false; return; }
		const text = all[globalIdx];
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
		} else {
			startPlayback();
		}
	}
	/** Move to `idx`, keeping backend playback going from there when playing. */
	function seekTo(idx: number) {
		const total = getGlobalSentences(sections).length;
		const next = Math.max(0, Math.min(idx, total - 1));
		globalIdx = next;
		if (useBackendTTS) {
			// When paused this just parks the resume position; when playing it
			// aborts in-flight requests and starts at the new sentence.
			void sentencePlayer?.seek(next);
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
			if (isPlaying || useBackendTTS) seekTo(target);
			else globalIdx = target;
		}
	}
	function prevSection() {
		const { sectionIdx } = globalToSectionChunk(sections, globalIdx);
		if (sectionIdx > 0) {
			const target = sectionChunkToGlobal(sections, sectionIdx - 1, 0);
			if (isPlaying || useBackendTTS) seekTo(target);
			else globalIdx = target;
		}
	}
	function updateRate(v: number) {
		synthRate = v;
		sentencePlayer?.setRate(v);
	}

	// Header actions
	async function handleLogoClick() {
		// The logo lands on the overview page (resume / library / listen now).
		view = 'overview';
		await refreshOverview();
	}
	function handleToggleLeftPane() {
		leftVisible = !leftVisible;
		if (leftVisible && leftPane === 'pdf' && pdfDoc) {
			// The canvas remounts when the pane becomes visible again.
			void (async () => {
				await tick();
				await renderPdfPage();
			})();
		}
	}
	function handleHeaderUpload() {
		// Header uploads are listen-now: the doc opens standalone.
		pendingPlaylistId = null;
		pdfInputEl?.click();
	}
	function handleMenuClick() {
		showLibrary = true;
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
		const text = getGlobalSentences(sections).join(' ');
		const custom = customVoices.find((v) => v.id === selectedVoiceId);
		const blob = custom?.blob ?? null;
		const voiceUrl = custom ? null : selectedVoiceId;
		const id = await createTTSFileJob(text, voiceUrl, blob, 'wav');
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
	<Header activeTitle={activeDoc?.title ?? null} {breadcrumbs} leftPaneVisible={leftVisible} onLogoClick={handleLogoClick} onUploadClick={handleHeaderUpload} onMenuClick={handleMenuClick} onToggleLeftPane={handleToggleLeftPane} />

	<input bind:this={pdfInputEl} type="file" accept="application/pdf" onchange={onPdfSelected} class="hidden" />
	<input bind:this={mdInputEl} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" onchange={onMarkdownSelected} class="hidden" />

	{#if toast}
		<div class="fixed top-16 right-4 bg-slate-800 border border-sky-500 text-slate-100 px-4 py-2 rounded-lg shadow z-50">{toast}</div>
	{/if}

	<main class="flex-1 min-h-0 flex flex-col mx-auto w-full max-w-6xl px-4 py-4 gap-4">
		{#if view === 'overview'}
			<Overview
				stats={overviewStats}
				searchIndex={overviewSearch}
				onResume={handleResumePlaylist}
				onOpenPlaylist={handleOpenPlaylist}
				onOpenItem={(pid, iid) => openPlaylistItem(pid, iid)}
				onShowLibrary={() => {
					view = 'reader';
					leftPane = 'library';
					leftVisible = true;
				}}
				onCreatePlaylist={handleCreatePlaylist}
				onUploadPdf={handleHeaderUpload}
				onEnterUrl={() => (urlDialogOpen = true)}
				onUploadMarkdown={() => {
					pendingPlaylistId = null;
					mdInputEl?.click();
				}}
				onPasteText={() => (pasteDialogOpen = true)}
			/>
		{:else if isOcrRunning}
			<OcrProgressPane {ocrProgress} {ocrEta} />
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
				<div class="flex items-center gap-2">
					<button onclick={triggerMarkdownUpload} class="text-xs px-3 py-1.5 rounded-md border border-slate-600 text-slate-200 hover:bg-slate-700">Attach Markdown</button>
					<button onclick={cancelPendingPdf} class="text-xs px-3 py-1.5 rounded-md border border-slate-600 text-slate-300 hover:bg-slate-700">Cancel</button>
					<button onclick={runOcr} class="text-xs px-4 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white font-medium">Extract text</button>
				</div>
			</div>
			<div class="{leftVisible ? 'grid md:grid-cols-2 gap-4 items-stretch md:h-[calc(100vh-19rem)] md:min-h-[480px] md:max-h-[860px] min-h-0' : 'max-w-3xl mx-auto w-full flex flex-col'}">
				{#if leftVisible}
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
				{/if}
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
			<div class="{leftVisible ? 'grid md:grid-cols-2 gap-4 items-stretch md:h-[calc(100vh-15rem)] md:min-h-[480px] md:max-h-[860px] min-h-0' : 'max-w-3xl mx-auto w-full md:h-[calc(100vh-15rem)] md:min-h-[480px] md:max-h-[860px] min-h-0 flex flex-col'}">
				{#if leftVisible}
					{#if leftPane === 'pdf'}
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
					{:else if leftPane === 'playlist'}
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
							onMoveItem={handleMovePlaylistItem}
							onDropItem={handleDropPlaylistItem}
							onShowPdf={handleShowItemPdf}
							onClearItemPdf={handleClearItemPdf}
							onOpenLibrary={() => (leftPane = 'library')}
							onUploadPdf={handlePlaylistPdfUpload}
							onUploadMarkdown={handlePlaylistMarkdownUpload}
							onPasteText={(text) => handlePasteText(activePlaylistId, text)}
							onFetchUrl={(url) => handleFetchUrl(activePlaylistId, url)}
							onAddCurrentDoc={handleAddCurrentDoc}
						/>
					{:else}
						<LibraryPane
							{playlists}
							stats={libraryStats}
							{activePlaylistId}
							onOpenPlaylist={handleOpenPlaylist}
							onCreatePlaylist={handleCreatePlaylist}
							onRenamePlaylist={handleRenamePlaylist}
							onDeletePlaylist={handleDeletePlaylist}
						/>
					{/if}
				{/if}
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
					onSentenceClick={handleSentenceClick}
				/>
			</div>
		{:else}
			<div class="flex-1 flex flex-col items-center justify-center gap-4 py-12 text-center">
				<h2 class="text-lg font-semibold text-slate-200">No document selected</h2>
				<p class="text-sm text-slate-400 max-w-md">Upload a PDF to extract text, upload Markdown directly, or open a document from the library.</p>
				<div class="mt-2 flex flex-wrap items-center justify-center gap-2">
					<button onclick={handleHeaderUpload} class="inline-flex items-center gap-2 bg-sky-600 hover:bg-sky-500 text-white px-5 py-2 rounded-md font-medium">
						Upload PDF
					</button>
					<button onclick={triggerMarkdownUpload} class="inline-flex items-center gap-2 border border-slate-600 hover:bg-slate-800 text-slate-200 px-5 py-2 rounded-md font-medium">
						Upload Markdown
					</button>
				</div>
				<button onclick={() => (showLibrary = true)} class="text-sm text-slate-400 hover:text-slate-200 underline">
					Open library ({docs.length} {docs.length === 1 ? 'doc' : 'docs'})
				</button>
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

	<LibraryModal
		open={showLibrary}
		{docs}
		activeDocId={activeDoc?.id ?? null}
		pdfSizes={pdfSizes}
		onClose={() => (showLibrary = false)}
		onSelect={openDoc}
		onDelete={deleteDocHandler}
		onRename={renameDoc}
		onClearPdf={clearCachedPdf}
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
					const v = listenPasteValue;
					listenPasteValue = '';
					pasteDialogOpen = false;
					void handlePasteText(null, v);
				}}
				class="relative w-full max-w-md bg-slate-800 rounded-xl border border-slate-700 p-4 flex flex-col gap-3"
			>
				<h2 class="text-base font-semibold text-slate-100">Paste text</h2>
				<p class="text-xs text-slate-400">Paste Markdown or plain text to listen to right away.</p>
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
		{useBackendTTS}
		onEngineChange={handleEngineChange}
		{builtinVoices}
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
	/>

	<PostprocessingModal
		open={showPostprocess}
		onClose={() => (showPostprocess = false)}
		{optCombine}
		{optPunct}
		{optPageMarkers}
		{optUppercase}
		onCombineChange={(v) => (optCombine = v)}
		onPunctChange={(v) => (optPunct = v)}
		onPageMarkersChange={(v) => (optPageMarkers = v)}
		onUppercaseChange={(v) => (optUppercase = v)}
		optFirstPageMarker={optFirstPageMarker}
		onFirstPageMarkerChange={(v) => (optFirstPageMarker = v)}
		optFirstPageNumber={optFirstPageNumber}
		onFirstPageNumberChange={(v) => (optFirstPageNumber = v)}
		{hasDirtyEdits}
		onApply={applyPostprocess}
	/>
</div>

<style>
	:global(body) { margin: 0; }
</style>
