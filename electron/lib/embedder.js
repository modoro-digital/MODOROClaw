// Shared embedder module — used by main.js AND smoke-rag-test.js so the smoke
// gate actually exercises the same code path as production. Previously smoke
// had its own inline embed() function → bugs in main.js embedText() would pass
// smoke silently.
//
// Exports: getEmbedder, embedText, cosineSim, vecToBlob, blobToVec, E5_DIM.
// Also exports embedder reference-counting for safe unload during in-flight calls.

const path = require('path');

const E5_DIM = 384;
const EMBEDDER_UNLOAD_MS = 10 * 60 * 1000;

let _embedder = null;
let _embedderLoadPromise = null;
let _embedderLastUsedAt = 0;
let _embedderUnloadTimer = null;
let _embedderInFlight = 0;  // E3 fix: reference count — never unload while >0

// Caller must provide the models root (packaged: userData/vendor; dev: electron/vendor).
// Passing explicitly avoids coupling this module to Electron app.getPath.
let _modelsRoot = null;
function setModelsRoot(dir) { _modelsRoot = dir; }

async function getEmbedder() {
  _embedderLastUsedAt = Date.now();
  if (_embedderUnloadTimer) clearTimeout(_embedderUnloadTimer);
  _embedderUnloadTimer = setTimeout(() => {
    // E3: never drop embedder while a call is mid-flight. Re-arm timer instead.
    if (_embedderInFlight > 0) {
      _embedderUnloadTimer = setTimeout(() => {}, EMBEDDER_UNLOAD_MS);
      return;
    }
    if (Date.now() - _embedderLastUsedAt >= EMBEDDER_UNLOAD_MS) {
      console.log('[embedder] unloading — idle 10min');
      _embedder = null;
    }
  }, EMBEDDER_UNLOAD_MS);

  if (_embedder) return _embedder;
  if (_embedderLoadPromise) return _embedderLoadPromise;

  _embedderLoadPromise = (async () => {
    const { pipeline, env } = await import('@xenova/transformers');
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    const base = _modelsRoot || path.join(__dirname, '..', 'vendor');
    env.localModelPath = path.join(base, 'models');
    env.cacheDir = env.localModelPath;
    const extractor = await pipeline(
      'feature-extraction',
      'Xenova/multilingual-e5-small',
      { quantized: true, local_files_only: true }
    );
    console.log('[embedder] loaded — Xenova/multilingual-e5-small quantized');
    _embedder = extractor;
    return extractor;
  })();

  try { return await _embedderLoadPromise; }
  finally { _embedderLoadPromise = null; }
}

async function embedText(text, isQuery = false) {
  const extractor = await getEmbedder();
  _embedderInFlight++;
  try {
    const prefix = isQuery ? 'query: ' : 'passage: ';
    const out = await extractor(prefix + text, { pooling: 'mean', normalize: true });
    _embedderLastUsedAt = Date.now();  // extend keepalive past long calls
    return Array.from(out.data);
  } finally {
    _embedderInFlight--;
  }
}

function cosineSim(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function vecToBlob(vec) {
  if (!vec || vec.length !== E5_DIM) {
    throw new Error(`[vecToBlob] expected ${E5_DIM} dims, got ${vec ? vec.length : 'null'}`);
  }
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

function blobToVec(blob) {
  if (!blob || blob.length % 4 !== 0) {
    throw new Error(`[blobToVec] BLOB length ${blob ? blob.length : 'null'} not divisible by 4 — corrupt row?`);
  }
  const n = blob.length / 4;
  const vec = new Array(n);
  for (let i = 0; i < n; i++) vec[i] = blob.readFloatLE(i * 4);
  return vec;
}

module.exports = {
  E5_DIM,
  EMBEDDER_UNLOAD_MS,
  setModelsRoot,
  getEmbedder,
  embedText,
  cosineSim,
  vecToBlob,
  blobToVec,
};
