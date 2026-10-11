// Dedicated worker for browser pocket-tts (sherpa-onnx WASM).
//
// The main thread owns downloads + caching (`browserModels.ts`) and
// transfers model bytes here; this worker writes them into MEMFS, builds
// the pocket-tts instance, and synthesizes per-sentence audio off the UI
// thread. Based on the sherpa-onnx `wasm/tts` demo worker, minus its
// preloaded-data-bundle assumption.
//
// Protocol — in:
//   {type:'init', files:[{name, data:ArrayBuffer}], withEncoder:boolean}
//   {type:'generate', id:number, text:string, speed:number,
//    reference:{samples:ArrayBuffer, sampleRate:number}|null}
//   {type:'dispose'}
// Protocol — out:
//   {type:'runtime-ready'}              (wasm loaded, send init next)
//   {type:'tts-ready', sampleRate}      (synthesis available)
//   {type:'progress', id, progress}     (streaming generation 0..1)
//   {type:'result', id, samples, sampleRate}  (samples transferred)
//   {type:'error', id|null, message}

let tts = null;
let cancelledId = -1;

self.Module = {
  // Resolve the .wasm next to this worker script.
  locateFile: (path, dir) => dir + path,
  setStatus: (status) => self.postMessage({ type: 'status', status: String(status) }),
  onRuntimeInitialized: () => self.postMessage({ type: 'runtime-ready' }),
};

importScripts('sherpa-onnx-wasm-main-tts.js', 'sherpa-onnx-tts.js');

function pocketConfig(withEncoder) {
  return {
    model: {
      pocket: {
        lmFlow: 'lm_flow.int8.onnx',
        lmMain: 'lm_main.int8.onnx',
        encoder: withEncoder ? 'encoder.onnx' : '',
        decoder: 'decoder.int8.onnx',
        textConditioner: 'text_conditioner.onnx',
        vocabJson: 'vocab.json',
        tokenScoresJson: 'token_scores.json',
        voiceEmbeddingCacheCapacity: 50,
      },
    },
    maxNumSentences: 1,
  };
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'init') {
      if (tts) {
        tts.free();
        tts = null;
      }
      for (const f of msg.files) {
        Module.FS.writeFile('/' + f.name, new Uint8Array(f.data));
      }
      tts = createOfflineTts(Module, pocketConfig(!!msg.withEncoder));
      self.postMessage({ type: 'tts-ready', sampleRate: tts.sampleRate });
      return;
    }
    if (msg.type === 'generate') {
      if (!tts) throw new Error('TTS not initialized');
      const id = msg.id;
      cancelledId = -1;
      const genConfig = { speed: msg.speed || 1.0, numSteps: 5 };
      if (msg.reference) {
        genConfig.referenceAudio = new Float32Array(msg.reference.samples);
        genConfig.referenceSampleRate = msg.reference.sampleRate;
      }
      genConfig.callback = (samples, n, progress) => {
        self.postMessage({ type: 'progress', id, progress });
        return cancelledId === id ? 0 : 1;
      };
      const audio = tts.generateWithConfig(msg.text, genConfig);
      const samples = audio.samples;
      self.postMessage(
        { type: 'result', id, samples, sampleRate: audio.sampleRate },
        [samples.buffer]
      );
      return;
    }
    if (msg.type === 'cancel') {
      cancelledId = msg.id;
      return;
    }
    if (msg.type === 'dispose') {
      if (tts) {
        tts.free();
        tts = null;
      }
      return;
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      id: msg && typeof msg.id === 'number' ? msg.id : null,
      message: err && err.message ? err.message : String(err),
    });
  }
};
