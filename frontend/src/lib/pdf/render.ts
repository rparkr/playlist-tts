/** Browser PDF page rasterization (pdf.js) for the LLM OCR path. */

/** Scale that renders at roughly 144 DPI. */
const DEFAULT_RENDER_SCALE = 2;
/** Cap the long edge so a dense page stays under the API size limit. */
const MAX_RENDER_EDGE = 2400;

export interface PdfRenderer {
	numPages: number;
	/** Render one 1-indexed page as a JPEG blob. */
	renderPage(pageNumber: number): Promise<Blob>;
	destroy(): void;
}

let pdfjsPromise: Promise<any> | null = null;

/** Load pdf.js and configure its worker once. */
async function loadPdfjs(): Promise<any> {
	if (!pdfjsPromise) {
		pdfjsPromise = (async () => {
			const pdfjs: any = await import('pdfjs-dist');
			try {
				const workerMod: any = await import('pdfjs-dist/build/pdf.worker.mjs?url');
				const workerUrl = workerMod.default ?? workerMod;
				if (workerUrl) pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
			} catch {
				// pdf.js falls back to a main-thread worker.
			}
			return pdfjs;
		})();
	}
	return pdfjsPromise;
}

/** Open PDF bytes for page rendering. Call `destroy()` when finished. */
export async function openPdfRenderer(bytes: Uint8Array): Promise<PdfRenderer> {
	const pdfjs = await loadPdfjs();
	// Copy: pdf.js may detach the source buffer.
	const task = pdfjs.getDocument({ data: bytes.slice() });
	const doc = await task.promise;
	return {
		numPages: doc.numPages as number,
		async renderPage(pageNumber: number): Promise<Blob> {
			const page = await doc.getPage(pageNumber);
			const base = page.getViewport({ scale: 1 });
			const scale = Math.min(
				DEFAULT_RENDER_SCALE,
				MAX_RENDER_EDGE / Math.max(base.width, base.height)
			);
			const viewport = page.getViewport({ scale });
			const canvas = document.createElement('canvas');
			canvas.width = Math.ceil(viewport.width);
			canvas.height = Math.ceil(viewport.height);
			const ctx = canvas.getContext('2d');
			if (!ctx) throw new Error('Could not create a canvas context for the page');
			await page.render({ canvasContext: ctx, viewport }).promise;
			page.cleanup();
			return new Promise<Blob>((resolve, reject) => {
				canvas.toBlob(
					(blob) => (blob ? resolve(blob) : reject(new Error('Page rasterization failed'))),
					'image/jpeg',
					0.9
				);
			});
		},
		destroy(): void {
			void doc.destroy();
		}
	};
}
