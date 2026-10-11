Pocket-TTS WASM runtime, vendored from sherpa-onnx (Apache-2.0,
https://github.com/k2-fsa/sherpa-onnx).

- `sherpa-onnx-wasm-main-tts.js` / `.wasm`: prebuilt Emscripten module.
  Copied from the `k2-fsa/web-assembly-en-tts-pocket` demo Space
  (same files as `wasm/tts/` in the sherpa-onnx repo at build time).
- `sherpa-onnx-tts.js`: JS config bindings from
  `wasm/tts/sherpa-onnx-tts.js` (Apache-2.0, attribution retained in-file).

NOT vendored: the `.data` preload bundle (it embeds one demo's models).
This app fetches the int8 model files itself (see
`src/lib/tts/browserModels.ts`) so downloads are cached and the
73MB voice-cloning encoder stays lazy.

One-line patch to `sherpa-onnx-wasm-main-tts.js` (re-apply on re-vendor):
the file-packager IIFE unconditionally fetches its `.data` bundle, which
we don't ship. The call `}}loadPackage({files:` became
`}}if(!globalThis.__ocrSkipPreload)loadPackage({files:`, and our worker
sets `globalThis.__ocrSkipPreload = true` before `importScripts`. With the
flag unset the file behaves exactly as upstream.
