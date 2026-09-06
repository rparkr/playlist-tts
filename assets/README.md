# Brand assets (source of truth)

Original logo artwork for the OCR-TTS Reader lives here. Files served by the
app or the docs are **copies** — the frontend and docs build tooling need the
files inside their own trees, so symlinks back here are intentionally avoided
(they break static-asset copying, PWA packaging, and Windows checkouts).

## Copies (keep in sync with the originals)

| Original | Copy | Used by |
|---|---|---|
| `tts-logo.svg` | `frontend/static/tts-logo.svg` | App header (`Header.svelte`) |
| `tts-logo-favicon.svg` | `frontend/src/lib/assets/favicon.svg` | App favicon (`+layout.svelte`) |

After changing an original, copy it over its derived file(s) and verify:

```sh
diff assets/tts-logo.svg frontend/static/tts-logo.svg
diff assets/tts-logo-favicon.svg frontend/src/lib/assets/favicon.svg
```

When user-facing docs arrive, place copies for the docs site under
`docs/assets/` the same way.
