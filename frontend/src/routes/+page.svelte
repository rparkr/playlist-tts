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
		migrateFromLocalStorage,
		type Doc,
		type VoiceRecord,
		type PostprocessOptions
	} from '$lib/stores/library';
	import {
		parseMarkdownStructure,
		getGlobalSentences,
		globalToSectionChunk,
		sectionChunkToGlobal,
		selectSections,
		type Section
	} from '$lib/markdown/parse';
	import { createTTSFileJob, getTTSDownloadUrl } from '$lib/tts/backendStream';
	import { BackendSentencePlayer } from '$lib/tts/backendSentencePlayer';
	import Header from '$lib/components/Header.svelte';
	import PlayerBar from '$lib/components/PlayerBar.svelte';
	import LibraryModal from '$lib/components/LibraryModal.svelte';
	import TtsSettingsModal from '$lib/components/TtsSettingsModal.svelte';
	import PostprocessingModal from '$lib/components/PostprocessingModal.svelte';
	import MarkdownPane from '$lib/components/MarkdownPane.svelte';
	import PdfPane from '$lib/components/PdfPane.svelte';
	import OcrProgressPane from '$lib/components/OcrProgressPane.svelte';
	import { formatEta, resolveAnchoredEta, tickDownEta } from '$lib/ocrEta';

	// --- State ---
	let docs: Doc[] = $state([]);
	let customVoices: VoiceRecord[] = $state([]);
	let builtinVoices: { name: string }[] = $state([]);
	let activeDoc: Doc | null = $state(null);
	let markdownDraft: string = $state('');
	let pdfFile: File | null = $state.raw(null);
	let pdfUrl: string | null = $state(null);
	let pdfDoc: any = $state.raw(null);
	let pdfPageNum: number = $state(1);
	let pdfTotalPages: number = $state(0);
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
	let synthRate: number = $state(1.0);
	let toast: string | null = $state(null);

	let optCombine: boolean = $state(true);
	let optUppercase: boolean = $state(true);
	let optPunct: boolean = $state(true);
	let optPageMarkers: boolean = $state(true);

	function currentPostprocessOpts(): PostprocessOptions {
		return {
			combine_columns: optCombine,
			normalize_uppercase: optUppercase,
			ensure_punctuation: optPunct,
			insert_page_markers: optPageMarkers
		};
	}

	function syncPostprocessOptsFromDoc(doc: Doc | null) {
		if (!doc?.postprocess) return;
		optCombine = doc.postprocess.combine_columns;
		optUppercase = doc.postprocess.normalize_uppercase;
		optPunct = doc.postprocess.ensure_punctuation;
		optPageMarkers = doc.postprocess.insert_page_markers;
	}

	let editorEl: HTMLTextAreaElement | null = $state(null);
	let canvasEl: HTMLCanvasElement | null = $state(null);
	let markdownPaneRef: any = $state(null);

	// UI state per plan
	let showLibrary = $state(false);
	let showTtsSettings = $state(false);
	let showPostprocess = $state(false);
	let pdfVisible = $state(true);
	let isEditing = $state(false);
	let editBackup: string = $state('');

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
		const docParam = url.searchParams.get('doc');
		const s = url.searchParams.get('s');
		const rate = url.searchParams.get('rate');
		const voice = url.searchParams.get('voice');
		if (rate) synthRate = parseFloat(rate) || 1.0;
		if (voice) selectedVoiceId = voice;
		if (docParam) {
			const d = await getDocBySlugOrId(docParam);
			if (d) {
				activeDoc = d;
				markdownDraft = d.markdown;
				syncPostprocessOptsFromDoc(d);
				if (s) {
					const g = parseInt(s, 10);
					if (!isNaN(g)) globalIdx = g;
				} else {
					const saved = localStorage.getItem(`progress_${d.id}`);
					if (saved) globalIdx = parseInt(saved, 10) || 0;
				}
			}
		} else {
			const last = localStorage.getItem('tts_active_doc_id');
			if (last) {
				const d = await getDocBySlugOrId(last);
				if (d) {
					activeDoc = d;
					markdownDraft = d.markdown;
					syncPostprocessOptsFromDoc(d);
					const saved = localStorage.getItem(`progress_${d.id}`);
					if (saved) globalIdx = parseInt(saved, 10) || 0;
				}
			}
		}
		const savedRate = localStorage.getItem('tts_rate');
		if (savedRate) synthRate = parseFloat(savedRate) || 1.0;
		const savedVoice = localStorage.getItem('tts_voice');
		if (savedVoice && !url.searchParams.get('voice')) selectedVoiceId = savedVoice;
	});

	$effect(() => {
		if (activeDoc) {
			localStorage.setItem('tts_active_doc_id', activeDoc.id);
			localStorage.setItem(`progress_${activeDoc.id}`, String(globalIdx));
		}
		localStorage.setItem('tts_rate', String(synthRate));
		localStorage.setItem('tts_voice', selectedVoiceId);
		if (typeof window !== 'undefined' && activeDoc) {
			const url = new URL(window.location.href);
			url.searchParams.set('doc', activeDoc.slug ?? activeDoc.id);
			url.searchParams.set('s', String(globalIdx));
			url.searchParams.set('rate', String(synthRate));
			url.searchParams.set('voice', selectedVoiceId);
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

	// Remaining time heuristic: 150 wpm at 1.0x
	let remainingText: string = $derived.by(() => {
		const all = getGlobalSentences(sections);
		if (all.length === 0) return '';
		const remaining = all.slice(globalIdx).join(' ');
		const words = remaining.trim().split(/\s+/).filter(Boolean).length;
		const secs = (words / (150 / 60)) / synthRate;
		const m = Math.floor(secs / 60);
		const s = Math.round(secs % 60);
		return `-${m}:${String(s).padStart(2, '0')}`;
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
	async function onPdfSelected(e: Event) {
		const input = e.target as HTMLInputElement;
		if (!input.files?.[0]) return;
		pdfFile = input.files[0];
		if (pdfUrl) URL.revokeObjectURL(pdfUrl);
		pdfUrl = URL.createObjectURL(pdfFile);
		// Auto-run OCR immediately (header flow)
		await runOcr();
		// reset input so same file can be re-selected
		input.value = '';
	}

	// For manual trigger from PdfPane placeholder
	function triggerPdfUpload() {
		pdfInputEl?.click();
	}

	async function loadPdf() {
		if (!pdfUrl) return;
		try {
			const pdfjs: any = await import('pdfjs-dist');
			try {
				const workerMod: any = await import('pdfjs-dist/build/pdf.worker.mjs?url');
				const workerUrl = workerMod.default ?? workerMod;
				if (workerUrl) pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
			} catch {}
			const task = pdfjs.getDocument(pdfUrl);
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
		// Sync scroll
		const targetLine = (() => {
			if (activeDoc?.pageMap) {
				const pm = activeDoc.pageMap.find((p) => p.page === pdfPageNum);
				if (pm) return pm.start_line;
			}
			return null;
		})();
		if (targetLine !== null) {
			const lineHeight = 20;
			const top = Math.max(0, (targetLine - 1) * lineHeight - 40);
			if (isEditing && editorEl) {
				editorEl.scrollTop = top;
			} else {
				const viewer = markdownPaneRef?.getViewerEl?.();
				if (viewer) viewer.scrollTop = top;
				else if (editorEl) editorEl.scrollTop = top;
			}
		} else if (pdfTotalPages) {
			// fallback proportional
			const viewer = markdownPaneRef?.getViewerEl?.();
			const el = isEditing ? editorEl : viewer;
			if (el && pdfTotalPages) {
				const approx = ((pdfPageNum - 1) / pdfTotalPages) * el.scrollHeight;
				el.scrollTop = approx;
			}
		}
	}
	function nextPdfPage() {
		if (pdfPageNum < pdfTotalPages) {
			pdfPageNum++;
			renderPdfPage();
		}
	}
	function prevPdfPage() {
		if (pdfPageNum > 1) {
			pdfPageNum--;
			renderPdfPage();
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
			fd.append(
				'postprocess',
				JSON.stringify({
					combine_columns: optCombine,
					normalize_uppercase: optUppercase,
					ensure_punctuation: optPunct,
					insert_page_markers: optPageMarkers
				})
			);
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
			docs = await getAllDocs();
			activeDoc = doc;
			markdownDraft = doc.markdown;
			globalIdx = 0;
			isEditing = false;
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
		activeDoc = d;
		markdownDraft = d.markdown;
		syncPostprocessOptsFromDoc(d);
		isEditing = false;
		const saved = localStorage.getItem(`progress_${id}`);
		globalIdx = saved ? parseInt(saved, 10) || 0 : 0;
		if (!d.pageMap) {
			pdfFile = null;
			pdfUrl = null;
			pdfDoc = null;
		}
	}
	async function deleteDocHandler(id: string) {
		if (!confirm('Delete document?')) return;
		await deleteDoc(id);
		docs = await getAllDocs();
		if (activeDoc?.id === id) {
			activeDoc = null;
			markdownDraft = '';
			localStorage.removeItem('tts_active_doc_id');
		}
	}
	async function renameDoc(id: string, newTitle: string) {
		const d = await renameDocStore(id, newTitle);
		if (!d) return;
		docs = await getAllDocs();
		if (activeDoc?.id === id) activeDoc = d;
	}

	let saveDebounce: ReturnType<typeof setTimeout> | null = null;
	function onMarkdownDraftChange(v: string) {
		markdownDraft = v;
		if (!activeDoc) return;
		if (saveDebounce) clearTimeout(saveDebounce);
		saveDebounce = setTimeout(async () => {
			if (!activeDoc) return;
			activeDoc.markdown = markdownDraft;
			activeDoc.sections = parseMarkdownStructure(markdownDraft);
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
		isEditing = false;
		activeDoc.markdown = markdownDraft;
		activeDoc.sections = parseMarkdownStructure(markdownDraft);
		await saveDoc(activeDoc);
		docs = await getAllDocs();
		showToast('Saved');
	}
	function handleEditCancel() {
		markdownDraft = editBackup;
		isEditing = false;
	}
	function handleSentenceClick(idx: number) {
		if (isPlaying || useBackendTTS) seekTo(idx);
		else globalIdx = idx;
	}

	function handleVoiceChange(id: string) {
		selectedVoiceId = id;
		// Cache keys are voice-scoped, so just restart the chain: the new
		// voice synthesizes from the current sentence, nothing earlier.
		if (isPlaying && useBackendTTS) playBackend();
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
	async function onVoiceFile(e: Event) {
		const input = e.target as HTMLInputElement;
		if (!input.files?.[0]) return;
		const file = input.files[0];
		if (file.name.toLowerCase().endsWith('.safetensors')) {
			const base = file.name.replace(/\.safetensors$/i, '') || 'voice';
			let name = prompt('Name this voice (from .safetensors):', base) ?? base;
			name = name.trim() || base;
			const blob = new Blob([await file.arrayBuffer()], { type: 'application/octet-stream' });
			const record: VoiceRecord = { id: 'voice_' + Date.now().toString(36), name, blob, bytes: blob.size, sourceWavName: file.name, createdAt: Date.now() };
			await saveVoice(record);
			customVoices = await getCustomVoices();
			selectedVoiceId = record.id;
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
			let name = prompt('Name this voice:', base) ?? base;
			name = name.trim() || base;
			const record: VoiceRecord = { id: 'voice_' + Date.now().toString(36), name, blob, bytes: blob.size, sourceWavName: file.name, createdAt: Date.now() };
			await saveVoice(record);
			customVoices = await getCustomVoices();
			selectedVoiceId = record.id;
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
				onEnded: () => {
					isPlaying = false;
					globalIdx = Math.max(0, getGlobalSentences(sections).length - 1);
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
			isPlaying = true;
			if (useBackendTTS) {
				if (sentencePlayer?.canResume()) void sentencePlayer.resume();
				else playBackend();
			} else playWebSpeechCorrect();
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
		pdfVisible = !pdfVisible;
		if (pdfVisible && pdfDoc) {
			// The canvas remounts when the pane becomes visible again.
			await tick();
			await renderPdfPage();
		}
	}
	function handleHeaderUpload() {
		pdfInputEl?.click();
	}
	function handleMenuClick() {
		showLibrary = true;
	}

	// Postprocessing apply — offline client-side re-render from stored raw Markdown.
	let hasDirtyEdits = $derived(activeDoc ? markdownDraft !== (activeDoc as Doc).markdown : false);
	async function applyPostprocess() {
		if (!activeDoc) return;
		if (hasDirtyEdits) {
			if (!confirm('You have edited the Markdown. Re-applying postprocessing will overwrite your changes. Continue?')) return;
		}
		try {
			const updated = await reapplyPostprocessing(activeDoc, currentPostprocessOpts());
			activeDoc = updated;
			markdownDraft = updated.markdown;
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
	<Header activeTitle={activeDoc?.title ?? null} {breadcrumbs} onLogoClick={handleLogoClick} onUploadClick={handleHeaderUpload} onMenuClick={handleMenuClick} />

	<input bind:this={pdfInputEl} type="file" accept="application/pdf" onchange={onPdfSelected} class="hidden" />

	{#if toast}
		<div class="fixed top-16 right-4 bg-slate-800 border border-sky-500 text-slate-100 px-4 py-2 rounded-lg shadow z-50">{toast}</div>
	{/if}

	<main class="flex-1 min-h-0 flex flex-col mx-auto w-full max-w-6xl px-4 py-4 gap-4">
		{#if isOcrRunning}
			<OcrProgressPane {ocrProgress} {ocrEta} />
		{:else if activeDoc}
			<div class="{pdfVisible ? 'grid md:grid-cols-2 gap-4 items-stretch md:h-[calc(100vh-15rem)] md:min-h-[480px] md:max-h-[860px] min-h-0' : 'max-w-3xl mx-auto w-full md:h-[calc(100vh-15rem)] md:min-h-[480px] md:max-h-[860px] min-h-0 flex flex-col'}">
				{#if pdfVisible}
					<PdfPane {pdfUrl} bind:canvasEl {pdfPageNum} {pdfTotalPages} onPrev={prevPdfPage} onNext={nextPdfPage} onUploadClick={triggerPdfUpload} />
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
				<p class="text-sm text-slate-400 max-w-md">Upload a PDF to extract text, or open a document from the library.</p>
				<button onclick={handleHeaderUpload} class="mt-2 inline-flex items-center gap-2 bg-sky-600 hover:bg-sky-500 text-white px-5 py-2 rounded-md font-medium">
					Upload PDF
				</button>
				<button onclick={() => (showLibrary = true)} class="text-sm text-slate-400 hover:text-slate-200 underline">
					Open library ({docs.length} {docs.length === 1 ? 'doc' : 'docs'})
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
		onClose={() => (showLibrary = false)}
		onSelect={openDoc}
		onDelete={deleteDocHandler}
		onRename={renameDoc}
	/>

	<TtsSettingsModal
		open={showTtsSettings}
		onClose={() => (showTtsSettings = false)}
		{useBackendTTS}
		onEngineChange={(v) => (useBackendTTS = v)}
		{builtinVoices}
		{customVoices}
		{synthVoices}
		{selectedVoiceId}
		onVoiceChange={handleVoiceChange}
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
		{hasDirtyEdits}
		onApply={applyPostprocess}
	/>
</div>

<style>
	:global(body) { margin: 0; }
</style>
