# Frontend — OCR-TTS Reader (SvelteKit static SPA)

Offline-first reader UI: PDF preview (`pdfjs-dist` canvas), editable Markdown,
sentence-level playback via device `SpeechSynthesis` or the backend
`pocket-tts` stream, and IndexedDB persistence (`idb`) for docs, voices, and
progress. Ships as a static build served by the backend (or GitHub Pages) with
PWA offline support (`@vite-pwa/sveltekit`).

## Developing

```sh
bun install
bun run dev      # http://localhost:5173
```

## Checks

```sh
bun run check    # svelte-check
bun run test     # vitest (unit, run mode)
bun run build    # emits frontend/build/
```

Set `PUBLIC_API_URL` at build time when the API lives somewhere other than
same-origin (e.g. Cloud Run behind GitHub Pages).
