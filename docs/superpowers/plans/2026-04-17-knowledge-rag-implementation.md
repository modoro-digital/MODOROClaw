# Knowledge RAG Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Tier 1 (local vector RAG) + Tier 2 (AI query rewrite) for knowledge base in MODOROClaw v2.3.47.

**Architecture:** `@xenova/transformers` multilingual-e5-small (quantized, 113MB ONNX) runs in-process in Electron main. Vector stored as BLOB in existing `documents_chunks` SQLite. HTTP endpoint on 127.0.0.1:20129 (already scaffolded) returns top-3 chunks. Gateway's openzalo `inbound.ts` patched to fetch + prepend context before agent dispatch. Tier 2 fires only on no-diacritic query regex OR low-margin retrieval (<0.03 gap between top-1 and top-2).

**Tech Stack:** Node 22 (vendor bundled), Electron 28, SQLite (better-sqlite3), `@xenova/transformers` + ONNX Runtime, existing FTS5 infrastructure.

**Spec:** [docs/superpowers/specs/2026-04-17-knowledge-rag-design.md](../specs/2026-04-17-knowledge-rag-design.md)

**Testing approach:** No existing unit test framework in electron/. Follow project pattern: smoke test (40-query accuracy probe) + manual verification. No TDD ceremony — most tasks are wiring.

**Work on main branch:** v2.3.47. Bump at end.

---

## File map

**Created:**
- `electron/scripts/prebuild-models.js` — download+verify model at build time
- `electron/scripts/smoke-rag-test.js` — 40-query accuracy smoke (runs as part of `npm run smoke`)
- `electron/test-fixtures/rag-canonical-queries.json` — 40 canonical queries + expected chunk IDs + 25 canonical chunks

**Modified:**
- `electron/package.json` — pin `@xenova/transformers`, add `prebuild:models` script
- `electron/main.js` — embedder module, schema migration, extend searchKnowledge, ensureZaloRagFix, reduce index.md, circuit breaker, Tier 2 rewrite call, lazy backfill, wizard pre-fill
- `electron/ui/dashboard.html` — Settings block for 3 checkboxes + rewrite model dropdown
- `electron/scripts/smoke-test.js` — wire smoke-rag-test
- `electron/scripts/prebuild-vendor.js` — include models dir in vendor/

---

## Chunk 1: Foundation (embedding + storage)

### Task 1: Install + pin @xenova/transformers

**Files:**
- Modify: `electron/package.json`

- [ ] **Step 1: Install exact version**

```bash
cd electron
npm install @xenova/transformers@2.17.2 --save-exact
```

- [ ] **Step 2: Verify package.json has pinned version**

Check `dependencies`: `"@xenova/transformers": "2.17.2"` (no caret). If caret present, manually strip it.

- [ ] **Step 3: Commit**

```bash
git add electron/package.json electron/package-lock.json
git commit -m "deps(electron): pin @xenova/transformers@2.17.2"
```

---

### Task 2: prebuild-models.js — download + verify + cache

**Files:**
- Create: `electron/scripts/prebuild-models.js`
- Modify: `electron/package.json` (add script)
- Modify: `.gitignore` (ignore `electron/vendor/models/`)

- [ ] **Step 1: Create script**

```js
// electron/scripts/prebuild-models.js
// Download Xenova/multilingual-e5-small quantized ONNX to vendor/models/
// Verify SHA256 per file, cache so CI/rebuilds are idempotent.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const MODEL_DIR = path.join(__dirname, '..', 'vendor', 'models', 'Xenova', 'multilingual-e5-small');
// Pin to a specific git revision SHA of the HF repo, not `main` — this way
// an upstream model update cannot shift bytes under us silently.
// Get current HEAD SHA: https://huggingface.co/Xenova/multilingual-e5-small/commits/main
// Update this when intentionally upgrading the model.
const HF_REVISION = '<REPLACE_WITH_LOCKED_40CHAR_SHA>';
const BASE = `https://huggingface.co/Xenova/multilingual-e5-small/resolve/${HF_REVISION}`;
// Pin files + SHA256. Collected by running once then locking hashes.
// CI will FAIL if any sha256 is null — explicit lock required before commit.
const FILES = [
  { rel: 'tokenizer.json', sha256: '<REPLACE_AFTER_FIRST_RUN>' },
  { rel: 'tokenizer_config.json', sha256: '<REPLACE_AFTER_FIRST_RUN>' },
  { rel: 'config.json', sha256: '<REPLACE_AFTER_FIRST_RUN>' },
  { rel: 'special_tokens_map.json', sha256: '<REPLACE_AFTER_FIRST_RUN>' },
  { rel: 'onnx/model_quantized.onnx', sha256: '<REPLACE_AFTER_FIRST_RUN>' },
];

// Assert all hashes + revision are locked before running — no null/placeholder slips into CI
for (const f of FILES) {
  if (!f.sha256 || f.sha256.length !== 64 || f.sha256.startsWith('<')) {
    throw new Error(`[prebuild-models] SHA256 not locked for ${f.rel} — run once locally, copy 64-char hex hash, commit before build`);
  }
}
if (!HF_REVISION || HF_REVISION.length !== 40 || HF_REVISION.startsWith('<')) {
  throw new Error('[prebuild-models] HF_REVISION not pinned — replace placeholder with 40-char git SHA from HF repo');
}

async function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    req.on('error', reject);
  });
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function main() {
  fs.mkdirSync(path.join(MODEL_DIR, 'onnx'), { recursive: true });
  for (const f of FILES) {
    const dest = path.join(MODEL_DIR, f.rel);
    if (fs.existsSync(dest) && f.sha256) {
      const actual = await sha256(dest);
      if (actual === f.sha256) {
        console.log(`[prebuild-models] cached ${f.rel} (${actual.slice(0, 8)})`);
        continue;
      }
      console.log(`[prebuild-models] hash mismatch ${f.rel} — re-downloading`);
    }
    const url = `${BASE}/${f.rel}`;
    console.log(`[prebuild-models] downloading ${f.rel}...`);
    await download(url, dest);
    const actual = await sha256(dest);
    if (f.sha256 && actual !== f.sha256) {
      throw new Error(`[prebuild-models] SHA256 mismatch for ${f.rel}: expected ${f.sha256}, got ${actual}`);
    }
    console.log(`[prebuild-models] ${f.rel} OK (sha256=${actual})`);
  }
  console.log('[prebuild-models] all files ready at', MODEL_DIR);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Add npm script**

In `electron/package.json`:
```json
"prebuild:models": "node scripts/prebuild-models.js",
"prebuild:vendor": "node scripts/prebuild-models.js && node scripts/prebuild-vendor.js",
```

(Chain models before vendor so vendor-bundle.tar includes them.)

- [ ] **Step 3: Ignore downloaded models from git**

Add to `.gitignore`:
```
electron/vendor/models/
```

- [ ] **Step 4: Run once, collect SHA256 + HF revision, lock**

1. Get the current HEAD SHA of HF model repo:
```bash
curl -s https://huggingface.co/api/models/Xenova/multilingual-e5-small | jq -r '.sha'
```
Copy the 40-char SHA into `HF_REVISION`.

2. First run — temporarily comment out the assertion block so script runs without hashes:
```bash
cd electron
node scripts/prebuild-models.js  # will error on assertion — comment it, run again
```

3. Copy each printed `sha256=<64-char>` into the corresponding `FILES[].sha256`.

4. Uncomment the assertion block. Verify everything locked:
```bash
rm -rf vendor/models
node scripts/prebuild-models.js
```
Expected: all files download, all SHA256 + revision verify OK, assertion passes.

5. Note: HuggingFace serves identical bytes by content hash for a given revision — same SHA256 across every download. If you see hash mismatch on re-run, it means the HF_REVISION shifted (which shouldn't happen because it's pinned) — investigate before bypassing.

- [ ] **Step 5: Commit**

```bash
git add electron/scripts/prebuild-models.js electron/package.json .gitignore
git commit -m "build: prebuild-models.js — bundle e5-small ONNX with SHA256 pin"
```

---

### Task 3: Embedder module in main.js

**Files:**
- Modify: `electron/main.js` — add near existing knowledge functions (around line 14200)

- [ ] **Step 1: Add module**

Insert before `ensureKnowledgeChunksSchema` (line ~14184):

```js
// === Knowledge RAG — embedder ===
// Lazy-load transformers.js model. Auto-unload after 10min idle to save RAM.
let _embedder = null;
let _embedderLoadPromise = null;
let _embedderLastUsedAt = 0;
let _embedderUnloadTimer = null;
const EMBEDDER_UNLOAD_MS = 10 * 60 * 1000;

async function getEmbedder() {
  _embedderLastUsedAt = Date.now();
  // Reset unload timer
  if (_embedderUnloadTimer) { clearTimeout(_embedderUnloadTimer); }
  _embedderUnloadTimer = setTimeout(() => {
    if (Date.now() - _embedderLastUsedAt >= EMBEDDER_UNLOAD_MS) {
      console.log('[embedder] unloading — idle 10min');
      _embedder = null;
    }
  }, EMBEDDER_UNLOAD_MS);

  if (_embedder) return _embedder;
  if (_embedderLoadPromise) return _embedderLoadPromise;

  _embedderLoadPromise = (async () => {
    const { pipeline, env } = await import('@xenova/transformers');
    // Point to bundled model dir (NOT Hugging Face CDN at runtime).
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.localModelPath = path.join(getBundledVendorDir() || '', 'models');
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
  const prefix = isQuery ? 'query: ' : 'passage: ';
  const out = await extractor(prefix + text, { pooling: 'mean', normalize: true });
  return Array.from(out.data);  // Float32Array → regular array for BLOB storage
}

function cosineSim(a, b) {
  // Vectors already normalized in embedText → dot product = cosine
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

// Pack/unpack Float32Array ↔ BLOB for SQLite
function vecToBlob(vec) {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}
function blobToVec(blob) {
  const n = blob.length / 4;
  const vec = new Array(n);
  for (let i = 0; i < n; i++) vec[i] = blob.readFloatLE(i * 4);
  return vec;
}
```

- [ ] **Step 2: Sanity smoke**

```bash
cd electron
node -e "
  const main = require('./main.js');
  // manual: this will fail because main.js is the Electron entrypoint.
  // Instead test by running npm start and checking boot log for '[embedder] loaded' after first query.
"
```

Actual verification deferred to Task 11 integration.

- [ ] **Step 3: Commit**

```bash
git add electron/main.js
git commit -m "feat(knowledge): embedder module (lazy-load + idle unload + BLOB codec)"
```

---

### Task 4: Schema migration — add embedding column + model stamp

**Files:**
- Modify: `electron/main.js` — `ensureKnowledgeChunksSchema()` around line 14191

- [ ] **Step 1: Find existing function**

Read main.js around line 14184-14210. Existing function creates `documents_chunks` and `documents_chunks_fts` tables.

- [ ] **Step 2: Add migration inside the function**

Append before the closing of `ensureKnowledgeChunksSchema`:

```js
  // v2.3.47 — add embedding column for Knowledge RAG
  try {
    // Idempotent: ALTER TABLE ADD COLUMN is a no-op if column exists on some SQLite
    // versions; better-sqlite3 with old SQLite treats duplicate ADD as error.
    const cols = db.prepare("PRAGMA table_info(documents_chunks)").all();
    const hasEmbedding = cols.some(c => c.name === 'embedding');
    const hasModelStamp = cols.some(c => c.name === 'embedding_model');
    if (!hasEmbedding) {
      db.exec('ALTER TABLE documents_chunks ADD COLUMN embedding BLOB');
      console.log('[knowledge-schema] added embedding column');
    }
    if (!hasModelStamp) {
      db.exec('ALTER TABLE documents_chunks ADD COLUMN embedding_model TEXT');
      console.log('[knowledge-schema] added embedding_model column');
    }
  } catch (e) {
    console.warn('[knowledge-schema] embedding migration warning:', e.message);
  }
```

`embedding_model` stamps which model produced the vector (e.g., `multilingual-e5-small-q`). Future model upgrade = re-embed rows where stamp doesn't match current.

- [ ] **Step 3: Verify by opening app + reading schema**

```bash
cd electron
npm start
# In another terminal:
sqlite3 "$APPDATA/9bizclaw/memory.db" "PRAGMA table_info(documents_chunks)" | grep -E "embedding|embedding_model"
```

Expected output: 2 rows showing both columns.

- [ ] **Step 4: Commit**

```bash
git add electron/main.js
git commit -m "feat(knowledge): schema migration — embedding BLOB + model stamp columns"
```

---

## Chunk 2: Retrieval + ingestion wiring

### Task 5: Reduce index.md to manifest-only (revert earlier over-reduction)

**Files:**
- Modify: `electron/main.js` — `rewriteKnowledgeIndex()` around line 14628

**Context:** Earlier in session, caps were reduced to `PER_FILE_CAP=2000`, `PER_CATEGORY_BUDGET=20000`. Design says "manifest only" — even 2KB per file is more than needed now that RAG injection provides actual retrieval. Pare further.

- [ ] **Step 1: Simplify the "Nội dung đầy đủ" section**

Replace the per-file body in `rewriteKnowledgeIndex` (lines ~14669-14694) to emit only filename + AI summary, no raw content:

```js
    md += `Tổng: ${rows.length} tài liệu. Bot dùng search vector khi khách hỏi (không nạp toàn bộ nội dung).\n\n`;
    for (const r of rows) {
      md += `- **${r.filename}** (${((r.filesize || 0) / 1024).toFixed(1)} KB, uploaded ${r.created_at})\n`;
      if (r.summary) md += `  *${r.summary.slice(0, 200)}*\n`;
      md += `\n`;
    }
```

Delete the `PER_FILE_CAP` + `PER_CATEGORY_BUDGET` constants + their usage.

- [ ] **Step 2: Manual verify**

Open app with existing docs. Check `%APPDATA%/9bizclaw/knowledge/cong-ty/index.md` — should be short file list, no raw text.

- [ ] **Step 3: Commit**

```bash
git add electron/main.js
git commit -m "feat(knowledge): reduce index.md to manifest-only — RAG handles retrieval"
```

---

### Task 6: Embed-on-upload

**Files:**
- Modify: `electron/main.js` — `ipcMain.handle('upload-knowledge-file', ...)` around line 14702

- [ ] **Step 1: Add embedding after chunk insert**

In the upload handler, after the existing `indexDocumentChunks(db, insertedDocId, category, content)` call (around line 14747), add:

```js
        // Embed all chunks for this document — sync loop, ~13ms per chunk.
        // For 200-chunk doc (~100-page PDF), adds ~3s to upload.
        try {
          const chunkRows = db.prepare(
            'SELECT id, chunk_index, char_start, char_end FROM documents_chunks WHERE document_id = ? ORDER BY chunk_index'
          ).all(insertedDocId);
          const upsert = db.prepare(
            'UPDATE documents_chunks SET embedding = ?, embedding_model = ? WHERE id = ?'
          );
          const MODEL_STAMP = 'multilingual-e5-small-q';
          let embedded = 0;
          for (const row of chunkRows) {
            const chunkText = content.substring(row.char_start, row.char_end);
            if (!chunkText || chunkText.length < 5) continue;
            const vec = await embedText(chunkText, false);
            upsert.run(vecToBlob(vec), MODEL_STAMP, row.id);
            embedded++;
          }
          console.log(`[knowledge] embedded ${embedded}/${chunkRows.length} chunks for ${finalName}`);
        } catch (e) {
          console.error('[knowledge] embed error:', e.message);
          // Non-fatal — upload still succeeds. Backfill on boot catches missed rows.
        }
```

- [ ] **Step 2: Manual verify**

Upload a small .txt file via Dashboard. Check log for `[knowledge] embedded N/N chunks`. Then:

```bash
sqlite3 "$APPDATA/9bizclaw/memory.db" "SELECT COUNT(*), COUNT(embedding) FROM documents_chunks"
```

Expected: both counts equal.

- [ ] **Step 3: Commit**

```bash
git add electron/main.js
git commit -m "feat(knowledge): embed chunks on upload (sync, ~13ms each)"
```

---

### Task 7: Lazy backfill on boot for pre-existing rows

**Files:**
- Modify: `electron/main.js` — inside `_startOpenClawImpl` or after knowledge-index boot rewrite (around line 5955)

- [ ] **Step 1: Add backfill function**

Add helper near embedder module:

```js
async function backfillKnowledgeEmbeddings() {
  const db = getDocumentsDb();
  if (!db) return;
  try {
    const missing = db.prepare(
      `SELECT c.id, c.document_id, c.char_start, c.char_end, d.content
       FROM documents_chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE c.embedding IS NULL
       LIMIT 500`  // cap per boot — don't hog CPU; next boot picks up more
    ).all();
    if (missing.length === 0) return;
    console.log(`[knowledge-backfill] embedding ${missing.length} chunks...`);
    const upsert = db.prepare(
      'UPDATE documents_chunks SET embedding = ?, embedding_model = ? WHERE id = ?'
    );
    const MODEL_STAMP = 'multilingual-e5-small-q';
    let done = 0;
    for (const row of missing) {
      const text = row.content.substring(row.char_start, row.char_end);
      if (!text || text.length < 5) continue;
      const vec = await embedText(text, false);
      upsert.run(vecToBlob(vec), MODEL_STAMP, row.id);
      done++;
    }
    console.log(`[knowledge-backfill] done ${done}/${missing.length}`);
  } catch (e) {
    console.warn('[knowledge-backfill] error:', e.message);
  }
  // NO db.close() — same reasoning as searchKnowledge (Task 8): shared handle,
  // caller lifetime. Reviewer flagged closing here would corrupt subsequent ops.
}
```

- [ ] **Step 2: Schedule backfill 30s after boot (low priority)**

In the boot sequence (e.g., right after `app.whenReady`), add:

```js
  // Lazy RAG backfill — 30s after boot so startup isn't delayed.
  setTimeout(() => {
    backfillKnowledgeEmbeddings().catch(e => console.warn('[backfill] boot:', e?.message));
  }, 30000);
```

- [ ] **Step 3: Manual verify**

Install v2.3.47 over existing v2.3.46 install (which has docs uploaded but no embeddings). After boot + 30s, check:

```bash
sqlite3 "$APPDATA/9bizclaw/memory.db" "SELECT COUNT(*), COUNT(embedding) FROM documents_chunks"
```

Expected: `embedding` count grows toward total. (Another boot picks up next 500 if total > 500.)

- [ ] **Step 4: Commit**

```bash
git add electron/main.js
git commit -m "feat(knowledge): lazy backfill embeddings at boot (500/boot, non-blocking)"
```

---

### Task 8: Extend searchKnowledge() with vector ranking

**Files:**
- Modify: `electron/main.js` — `searchKnowledge()` around line 14890

- [ ] **Step 1: Add vector ranking path**

Rewrite the body of `searchKnowledge({ query, category, limit })`. Keep FTS5 as fallback when vectors missing.

Before the existing FTS5 code, add:

```js
async function searchKnowledge({ query, category, limit }) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 3, 1), 10);
  const db = getDocumentsDb();
  if (!db) return [];

  // DO NOT close `db` inside this function. getDocumentsDb() returns a handle
  // whose lifetime is managed by the callers (IPC + HTTP). Closing here corrupts
  // subsequent callers + the Tier 2 rescore path below (which re-reads `rows`).
  // `rows` declared outside the try block so Tier 2 can access after success.
  let rows = [];
  let scored = [];
  try {
    const qvec = await embedText(String(query || '').slice(0, 500), true);
    rows = category
      ? db.prepare(
          `SELECT c.id, c.document_id, c.chunk_index, c.char_start, c.char_end, c.embedding, d.filename, d.content
           FROM documents_chunks c JOIN documents d ON d.id = c.document_id
           WHERE c.category = ? AND c.embedding IS NOT NULL`
        ).all(category)
      : db.prepare(
          `SELECT c.id, c.document_id, c.chunk_index, c.char_start, c.char_end, c.embedding, d.filename, d.content
           FROM documents_chunks c JOIN documents d ON d.id = c.document_id
           WHERE c.embedding IS NOT NULL`
        ).all();

    if (rows.length === 0) {
      console.log('[knowledge-search] no embeddings — falling back to FTS5');
      return searchKnowledgeFTS5({ query, category, limit });
    }

    scored = rows.map(r => {
      const vec = blobToVec(r.embedding);
      return {
        id: r.id,
        document_id: r.document_id,
        chunk_index: r.chunk_index,
        filename: r.filename,
        snippet: r.content.substring(r.char_start, r.char_end),
        score: cosineSim(qvec, vec),
      };
    }).sort((a, b) => b.score - a.score);
  } catch (e) {
    console.warn('[knowledge-search] vector search error, falling back to FTS5:', e.message);
    return searchKnowledgeFTS5({ query, category, limit });
  }

  // Tier 2 rescore path (Task 11) inserts here, uses `rows` + `scored`
  return scored.slice(0, limit);
}
```

Rename the existing FTS5 function to `searchKnowledgeFTS5` so it can be the fallback.

- [ ] **Step 2: Update the HTTP endpoint to await the async function**

The `searchKnowledge` is now async. Update `startKnowledgeSearchServer()` (added earlier this session) to `await`:

Find `const results = searchKnowledge({ query, category, limit: Math.min(Math.max(limit, 1), 8) });` and change to:

```js
const results = await searchKnowledge({ query, category, limit: Math.min(Math.max(limit, 1), 8) });
```

Also wrap handler body in `async` and use `await`.

- [ ] **Step 3: Update the `knowledge-search` IPC handler similarly**

Around line 15065. Change `const results = searchKnowledge(...)` to `const results = await searchKnowledge(...)`.

- [ ] **Step 4: Manual verify via curl**

```bash
# Start app. After upload + embed:
curl "http://127.0.0.1:20129/search?q=iPhone%2015%20Pro%20Max&k=3"
```

Expected: JSON with 3 results, each having `filename`, `snippet`, `score` (0.7-0.95 range).

- [ ] **Step 5: Commit**

```bash
git add electron/main.js
git commit -m "feat(knowledge): vector search (cosine BLOB) in searchKnowledge() with FTS5 fallback"
```

---

## Chunk 3: RAG injection into Zalo pipeline

### Task 9: ensureZaloRagFix() — inbound.ts patch

**Files:**
- Modify: `electron/main.js` — add new `ensureZaloRagFix` function near other ensure functions (around line 3745)
- Modify: `electron/main.js` — add call to `ensureZaloRagFix()` in patch sequence (around line 6134)

- [ ] **Step 1: Write the ensure function**

```js
// inbound.ts RAG enrichment: calls Electron main HTTP knowledge-search + prepends chunks.
// Idempotent via "9BizClaw RAG PATCH v1" marker.
// Anchor: AFTER group-settings end marker (runs only for messages that passed all filters).
// Fail-open: if HTTP fails or returns nothing, message dispatches as-is.
// Circuit breaker: 3 consecutive fails within 60s → log audit + stop calling for 5min.
function ensureZaloRagFix() {
  try {
    const pluginFile = path.join(HOME, '.openclaw', 'extensions', 'openzalo', 'src', 'inbound.ts');
    if (!fs.existsSync(pluginFile)) return;
    let content = _readInboundTs(pluginFile);
    if (content.includes('9BizClaw RAG PATCH v1')) return;

    const anchor = '  // === END 9BizClaw GROUP-SETTINGS PATCH ===';
    if (!content.includes(anchor)) {
      console.warn('[zalo-rag] group-settings anchor missing — ensureZaloGroupSettingsFix must run first');
      return;
    }

    const injection = `
  // === 9BizClaw RAG PATCH v1 ===
  // Enrich message with relevant knowledge chunks via HTTP to Electron main.
  // Fail-open with circuit breaker.
  try {
    const __ragG = (global as any);
    __ragG.__ragFailCount ??= 0;
    __ragG.__ragCooldownUntil ??= 0;
    const __ragNow = Date.now();
    if (__ragNow > __ragG.__ragCooldownUntil && (rawBody || '').trim().length >= 3) {
      const __ragQ = (rawBody || '').slice(0, 500).trim();
      const __ragUrl = \`http://127.0.0.1:20129/search?q=\${encodeURIComponent(__ragQ)}&k=3\`;
      const __ragCtrl = new AbortController();
      const __ragTimer = setTimeout(() => __ragCtrl.abort(), 2000);
      try {
        const __ragResp: any = await fetch(__ragUrl, { signal: __ragCtrl.signal });
        clearTimeout(__ragTimer);
        if (__ragResp.ok) {
          const __ragData: any = await __ragResp.json();
          __ragG.__ragFailCount = 0;
          if (Array.isArray(__ragData.results) && __ragData.results.length > 0) {
            // Score floor 0.45 (not 0.55): corpus shows correct results sometimes
            // at 0.50-0.70 band. Lower than retrieved-top means less confident but
            // still useful context. Spec explicitly says avoid raw score gating for
            // OOD — bot's prompt instruction "BỎ QUA if not relevant" handles that.
            const __ragTop = __ragData.results
              .filter((r: any) => (r.snippet || '') && (r.score || 0) > 0.45)
              .slice(0, 3);
            if (__ragTop.length > 0) {
              const __ragCtx = __ragTop
                .map((r: any) => \`[\${r.filename || 'tài liệu'}, đoạn \${r.chunk_index ?? '?'}]\\n\${r.snippet}\`)
                .join('\\n\\n---\\n\\n');
              rawBody = \`[Tài liệu liên quan từ knowledge base của shop]\\n\${__ragCtx}\\n\\n[Lưu ý: nếu đoạn trên không liên quan câu hỏi, BỎ QUA và trả lời theo kiến thức chung hoặc nói chưa có thông tin]\\n\\n[Câu hỏi khách]\\n\${rawBody}\`;
              runtime.log?.(\`openzalo: RAG enriched with \${__ragTop.length} chunks\`);
            }
          }
        } else {
          __ragG.__ragFailCount++;
        }
      } catch (__ragErr) {
        clearTimeout(__ragTimer);
        __ragG.__ragFailCount++;
        runtime.log?.(\`openzalo: RAG skipped: \${String(__ragErr)}\`);
      }
      if (__ragG.__ragFailCount >= 3) {
        __ragG.__ragCooldownUntil = __ragNow + 5 * 60 * 1000;
        runtime.log?.('openzalo: RAG circuit breaker tripped — cooling 5min');
      }
    }
  } catch (__ragOuter) {
    runtime.log?.('openzalo: RAG outer error: ' + String(__ragOuter));
  }
  // === END 9BizClaw RAG PATCH v1 ===
`;
    content = content.replace(anchor, anchor + injection);
    _writeInboundTs(pluginFile, content);
    console.log('[zalo-rag] Injected RAG enrichment into inbound.ts');
  } catch (e) {
    console.error('[zalo-rag] error:', e?.message || e);
  }
}
```

- [ ] **Step 2: Wire into patch sequence**

In `_startOpenClawImpl`, find `ensureZaloGroupSettingsFix();` (line ~6134). Add right after:

```js
  ensureZaloGroupSettingsFix();
  ensureZaloRagFix();   // depends on group-settings anchor
```

- [ ] **Step 3: Manual verify**

After boot: check inbound.ts contains `9BizClaw RAG PATCH v1` marker:

```bash
grep -c "9BizClaw RAG PATCH v1" ~/.openclaw/extensions/openzalo/src/inbound.ts
```

Expected: `1`.

- [ ] **Step 4: End-to-end manual test**

1. Upload a small PDF to Knowledge (must have embedded chunks by now).
2. Send Zalo message matching content.
3. Check openclaw.log for `openzalo: RAG enriched with N chunks`.
4. Verify bot reply references doc content.

- [ ] **Step 5: Commit**

```bash
git add electron/main.js
git commit -m "feat(knowledge): ensureZaloRagFix — inbound.ts RAG injection + circuit breaker"
```

---

### Task 10: Circuit breaker Dashboard surface (folds into Task 9)

**This task REWRITES Task 9's patch with v2 marker + audit POST.**

**Files:**
- Modify: `electron/main.js` — `ensureZaloRagFix()` (replace entire function body)
- Modify: `electron/main.js` — `startKnowledgeSearchServer()` (add POST route)

- [ ] **Step 1: Add POST route to knowledge search HTTP server**

In `startKnowledgeSearchServer()` in main.js, extend the request handler inside the createServer callback. After the existing `if (url.pathname !== '/search')` check, add:

```js
      if (url.pathname === '/audit-rag-degraded' && req.method === 'POST') {
        try { auditLog('rag_degraded', { at: Date.now() }); } catch {}
        res.writeHead(204); res.end();
        return;
      }
```

- [ ] **Step 2: Rewrite ensureZaloRagFix with v2 marker**

Go back to `ensureZaloRagFix()` defined in Task 9. Change ALL of:
- Marker string `9BizClaw RAG PATCH v1` → `9BizClaw RAG PATCH v2`
- Idempotency check `content.includes('9BizClaw RAG PATCH v1')` → `content.includes('9BizClaw RAG PATCH v2')`
- Comment markers `// === 9BizClaw RAG PATCH v1 ===` → `v2`
- Comment markers `// === END 9BizClaw RAG PATCH v1 ===` → `v2`

Then add strip-old-v1 logic BEFORE the marker check (to upgrade installs that already have v1):

```js
    // Strip v1 block if present (upgrade from v1 → v2)
    if (content.includes('9BizClaw RAG PATCH v1')) {
      const v1Start = content.indexOf('  // === 9BizClaw RAG PATCH v1 ===');
      const v1End = content.indexOf('  // === END 9BizClaw RAG PATCH v1 ===');
      if (v1Start !== -1 && v1End !== -1) {
        const endMarkerLen = '  // === END 9BizClaw RAG PATCH v1 ===\n'.length;
        content = content.slice(0, v1Start) + content.slice(v1End + endMarkerLen);
      }
    }
```

Then in the injection string (inside the circuit breaker tripped branch), add the audit POST right below `runtime.log?.('openzalo: RAG circuit breaker tripped — cooling 5min');`:

```ts
        try { await fetch('http://127.0.0.1:20129/audit-rag-degraded', { method: 'POST' }); } catch {}
```

- [ ] **Step 3: Add Dashboard overview alert**

In the Dashboard overview IPC handler (`get-overview-data`), add an alert if `audit.jsonl` has a `rag_degraded` entry in the last 10 minutes:

```js
// Inside get-overview-data after existing alerts[]
try {
  const recentRag = recentAuditEntries.filter(e => e.type === 'rag_degraded' && (now - e.at) < 10 * 60 * 1000);
  if (recentRag.length > 0) {
    alerts.push({ severity: 'MED', msg: 'Tìm kiếm tài liệu tạm dừng (lỗi giao tiếp). Tự khôi phục sau 5 phút.' });
  }
} catch {}
```

- [ ] **Step 4: Commit**

```bash
git add electron/main.js
git commit -m "feat(knowledge): RAG circuit breaker audit + Dashboard surface"
```

---

## Chunk 4: Tier 2 query rewrite + Settings UI

### Task 11: Tier 2 trigger logic + 9Router rewrite call

**Files:**
- Modify: `electron/main.js` — extend searchKnowledge with optional rewrite pass

- [ ] **Step 1: Add config read**

Add helper:

```js
function getRagConfig() {
  try {
    const p = path.join(getWorkspace(), 'rag-config.json');
    if (!fs.existsSync(p)) return { tier2Enabled: false, rewriteModel: 'ninerouter/fast' };
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch { return { tier2Enabled: false, rewriteModel: 'ninerouter/fast' }; }
}
```

- [ ] **Step 2: Add rewrite function**

```js
async function rewriteQueryViaAI(query, model) {
  const routerUrl = `http://127.0.0.1:20128/v1/chat/completions`;
  const body = {
    model: model || 'ninerouter/fast',
    messages: [
      { role: 'system', content: 'Bạn chuẩn hoá câu hỏi tiếng Việt của khách hàng để tìm kiếm. Thêm dấu nếu thiếu, bỏ từ lóng, viết rõ. CHỈ trả về câu đã chuẩn hoá, không giải thích.' },
      { role: 'user', content: query },
    ],
    temperature: 0.1,
    max_tokens: 100,
  };
  const resp = await fetch(routerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  if (!resp.ok) throw new Error(`9router HTTP ${resp.status}`);
  const data = await resp.json();
  const rewritten = data?.choices?.[0]?.message?.content?.trim();
  if (!rewritten) throw new Error('empty rewrite');
  return rewritten;
}
```

- [ ] **Step 3: Add trigger check + retry**

In `searchKnowledge` after first vector retrieval, before returning:

```js
      // Tier 2 fallback
      const cfg = getRagConfig();
      if (cfg.tier2Enabled && scored.length >= 2) {
        const top1 = scored[0].score;
        const top2 = scored[1].score;
        const noDiacritic = /[a-z]{3,}/i.test(query) && !/[\u00C0-\u1EF9]/.test(query);
        const lowMargin = (top1 - top2) < 0.03;
        if (noDiacritic || lowMargin) {
          try {
            const rewritten = await rewriteQueryViaAI(String(query), cfg.rewriteModel);
            if (rewritten && rewritten !== query) {
              console.log(`[knowledge-search] tier2 rewrite: "${query}" → "${rewritten}"`);
              const qvec2 = await embedText(rewritten.slice(0, 500), true);
              const rescored = rows.map(r => ({
                id: r.id, document_id: r.document_id, chunk_index: r.chunk_index,
                filename: r.filename,
                snippet: r.content.substring(r.char_start, r.char_end),
                score: cosineSim(qvec2, blobToVec(r.embedding)),
              })).sort((a, b) => b.score - a.score);
              if (rescored[0].score > scored[0].score) return rescored.slice(0, limit);
            }
          } catch (e) { console.warn('[knowledge-search] tier2 rewrite skipped:', e.message); }
        }
      }
```

- [ ] **Step 4: Commit**

```bash
git add electron/main.js
git commit -m "feat(knowledge): Tier 2 query rewrite via 9Router (no-diacritic + low-margin)"
```

---

### Task 12: Dashboard Settings UI

**Files:**
- Modify: `electron/ui/dashboard.html` — Settings page (search for existing Settings block)

- [ ] **Step 1: Add RAG settings block**

Find the Settings page section in dashboard.html. Add new section:

```html
<div class="ds-section">
  <h3 class="ds-section-title">Tìm kiếm tài liệu cho khách</h3>
  <p class="ds-section-desc">Khi khách hỏi gì đó, bot tra cứu tài liệu shop để trả lời chính xác.</p>

  <label style="display:flex;align-items:center;gap:8px;margin:8px 0;cursor:not-allowed;opacity:0.7">
    <input type="checkbox" id="rag-tier1" checked disabled>
    <span><strong>Tìm kiếm thông minh</strong> (luôn bật) — local model, miễn phí, hoạt động offline.</span>
  </label>

  <label style="display:flex;align-items:center;gap:8px;margin:8px 0">
    <input type="checkbox" id="rag-tier2" onchange="saveRagConfig()">
    <span><strong>Tự chuẩn hoá câu hỏi khó qua AI</strong> — khi khách gõ thiếu dấu hoặc sai chính tả. Chi phí ~$0.10-3/tháng.</span>
  </label>

  <div id="rag-tier2-model-row" style="margin-left:26px;display:none">
    <label style="display:block;margin:4px 0;font-size:12px;color:var(--text-muted)">Model dùng cho rewrite:</label>
    <select id="rag-rewrite-model" class="zs-select" style="max-width:300px" onchange="saveRagConfig()">
      <option value="ninerouter/main">main (khuyến nghị nếu anh/chị dùng ChatGPT Plus)</option>
      <option value="ninerouter/fast">fast (khuyến nghị nếu dùng API key trả tiền)</option>
    </select>
  </div>

  <p style="margin-top:12px;font-size:11px;color:var(--text-muted)">
    Reranker (tăng thêm độ chính xác) — sẽ có ở bản 2.4.
  </p>
</div>

<script>
async function loadRagConfig() {
  const cfg = await window.claw.getRagConfig();
  document.getElementById('rag-tier2').checked = !!cfg.tier2Enabled;
  document.getElementById('rag-tier2-model-row').style.display = cfg.tier2Enabled ? 'block' : 'none';
  document.getElementById('rag-rewrite-model').value = cfg.rewriteModel || 'ninerouter/fast';
}
async function saveRagConfig() {
  const tier2 = document.getElementById('rag-tier2').checked;
  const model = document.getElementById('rag-rewrite-model').value;
  document.getElementById('rag-tier2-model-row').style.display = tier2 ? 'block' : 'none';
  await window.claw.setRagConfig({ tier2Enabled: tier2, rewriteModel: model });
}
document.addEventListener('DOMContentLoaded', loadRagConfig);
</script>
```

- [ ] **Step 2: Add IPC handlers**

In `electron/main.js` near other settings handlers:

```js
ipcMain.handle('get-rag-config', async () => getRagConfig());
ipcMain.handle('set-rag-config', async (_event, cfg) => {
  try {
    const p = path.join(getWorkspace(), 'rag-config.json');
    writeJsonAtomic(p, {
      tier2Enabled: !!cfg.tier2Enabled,
      rewriteModel: String(cfg.rewriteModel || 'ninerouter/fast'),
      updatedAt: new Date().toISOString(),
    });
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});
```

- [ ] **Step 3: Add preload bridges**

In `electron/preload.js`, add:

```js
getRagConfig: () => ipcRenderer.invoke('get-rag-config'),
setRagConfig: (cfg) => ipcRenderer.invoke('set-rag-config', cfg),
```

- [ ] **Step 4: Manual verify**

Open Settings → see new RAG section. Toggle Tier 2 → dropdown appears. Reload app → state persists.

- [ ] **Step 5: Commit**

```bash
git add electron/main.js electron/preload.js electron/ui/dashboard.html
git commit -m "feat(knowledge): Dashboard Settings UI for RAG (Tier 1 locked, Tier 2 toggle, model dropdown)"
```

---

### Task 13: Wizard rewrite-model pre-fill

**Files:**
- Modify: `electron/main.js` — wizard-complete handler (line 15724)

- [ ] **Step 1: Detect provider + pre-fill rewrite model**

In `wizard-complete` handler, after existing logic, add:

```js
  // Pre-fill RAG rewrite model based on primary AI provider.
  // Does NOT enable Tier 2 — only sets the dropdown value.
  try {
    const ragPath = path.join(getWorkspace(), 'rag-config.json');
    if (!fs.existsSync(ragPath)) {
      // Detect provider from 9Router config
      const isChatgptPlus = await detectChatgptPlusOAuth();  // implement below
      writeJsonAtomic(ragPath, {
        tier2Enabled: false,  // OFF by default
        rewriteModel: isChatgptPlus ? 'ninerouter/main' : 'ninerouter/fast',
        updatedAt: new Date().toISOString(),
      });
    }
  } catch (e) { console.warn('[wizard-complete] RAG config prefill failed:', e?.message); }
```

Add helper:

```js
async function detectChatgptPlusOAuth() {
  try {
    // 9router stores provider config at ~/.9router/db.json
    const dbPath = path.join(HOME, '.9router', 'db.json');
    if (!fs.existsSync(dbPath)) return false;
    const cfg = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    // Heuristic: providers array contains an entry with kind === 'openai-oauth' or similar
    const providers = cfg?.providers || [];
    return providers.some(p =>
      String(p.type || p.kind || '').toLowerCase().includes('oauth') ||
      String(p.label || '').toLowerCase().includes('chatgpt plus')
    );
  } catch { return false; }
}
```

- [ ] **Step 2: Manual verify on fresh install**

Fresh install → wizard → complete. Check:
```bash
cat "$APPDATA/9bizclaw/rag-config.json"
```

Expected: `tier2Enabled: false`, `rewriteModel` matches detected provider.

- [ ] **Step 3: Commit**

```bash
git add electron/main.js
git commit -m "feat(knowledge): wizard-complete pre-fills RAG rewrite model (no auto-enable)"
```

---

## Chunk 5: Smoke + Ship

### Task 14: 40-query smoke test fixture + runner

**Files:**
- Create: `electron/test-fixtures/rag-canonical.json` — 25 chunks + 40 queries + expected IDs
- Create: `electron/scripts/smoke-rag-test.js`
- Modify: `electron/scripts/smoke-test.js` — wire into chain

- [ ] **Step 1: Create fixture with 40 queries**

Copy 25 chunks from `c:/tmp/rag-test/test-rag-matrix.mjs` (lines declaring the `chunks` array). Use these 40 canonical queries — mix of intents, covering expected failure modes:

```
20 original (from matrix test):
  typo, slang, no-diacritic, eng-mix, negation, comparison, short, incomplete,
  number-range, compound, location, temporal, service, brand, accessory,
  OOD, emoji, vague, spec, chained

Add 20 more to total 40 (canonical fixture):
  21. [typo2]          "iphon 14 pro gia bao nhiu" → expected [5]
  22. [typo3]          "samsung s24 ultra bao nhieu tien" → expected [3]
  23. [no-dia2]        "dia chi shop o dau" → expected [11]
  24. [no-dia3]        "tra gop co ko" → expected [12]
  25. [eng-mix2]       "face id iphone 15 có không" → expected [9]
  26. [negation2]      "không phải samsung thì có gì" → expected [1,2,4,5,13]
  27. [comparison2]    "xiaomi với oppo cái nào tốt hơn" → expected [4,13]
  28. [short2]         "bảo hành" → expected [6]
  29. [short3]         "giao hàng" → expected [8]
  30. [number-range2]  "điện thoại trên 25 triệu" → expected [1,3,4]
  31. [number-range3]  "máy dưới 15 triệu cũ" → expected [21]
  32. [compound2]      "ipad pro và apple pencil" → expected [16]
  33. [location2]      "shop long biên" → expected [11]
  34. [temporal2]      "mùng 2 tết mở cửa không" → expected [20]
  35. [service2]       "thay màn hình iphone" → expected [] (OOD — not in corpus)
  36. [accessory2]     "kính cường lực" → expected [14]
  37. [accessory3]     "cáp sạc iphone" → expected [10]
  38. [OOD2]           "bán tivi không" → expected []
  39. [spec2]          "máy quay phim 4k" → expected [] (OOD — no such spec in corpus)
  40. [brand2]         "xiaomi có gì hot" → expected [4]
```

**Quality bar:** each query must map to a realistic Vietnamese customer utterance. `expected` must be the chunk IDs that actually contain the answer, not "plausibly related."

Store as JSON:
```json
{
  "chunks": [ { "id": 1, "text": "..." }, ... 25 items ... ],
  "queries": [ { "q": "iphon 15 pro max bnh nhieu tien", "expected": [1], "note": "typo" }, ... 40 items ... ]
}
```

- [ ] **Step 2: Write smoke runner**

```js
// electron/scripts/smoke-rag-test.js
// Assumes vendor models are extracted; runs against in-memory chunks.
const path = require('path');
const fs = require('fs');

async function main() {
  // Point transformers.js to bundled models
  const { pipeline, env } = await import('@xenova/transformers');
  env.localModelPath = path.join(__dirname, '..', 'vendor', 'models');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;

  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-fixtures', 'rag-canonical.json'), 'utf-8'));
  const extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', { quantized: true, local_files_only: true });

  const embed = async (t, q) => {
    const o = await extractor((q ? 'query: ' : 'passage: ') + t, { pooling: 'mean', normalize: true });
    return Array.from(o.data);
  };
  const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

  for (const c of fx.chunks) c.vec = await embed(c.text, false);

  let t1 = 0, t3 = 0, total = 0;
  for (const q of fx.queries) {
    if (!q.expected || q.expected.length === 0) continue;  // skip OOD
    total++;
    const qv = await embed(q.q, true);
    const top = fx.chunks.map(c => ({ id: c.id, s: cos(qv, c.vec) })).sort((a, b) => b.s - a.s);
    const top3 = top.slice(0, 3).map(x => x.id);
    if (q.expected.includes(top3[0])) t1++;
    if (q.expected.some(id => top3.includes(id))) t3++;
  }
  const t1pct = (t1 / total * 100).toFixed(1);
  const t3pct = (t3 / total * 100).toFixed(1);
  console.log(`[smoke-rag] Top-1: ${t1}/${total} = ${t1pct}%`);
  console.log(`[smoke-rag] Top-3: ${t3}/${total} = ${t3pct}%`);
  if (t3 / total < 0.85) {
    console.error(`[smoke-rag] FAIL: Top-3 ${t3pct}% below 85% gate`);
    process.exit(1);
  }
  console.log('[smoke-rag] OK (Top-3 gate passed)');
}
main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Wire into build chain**

Edit `electron/scripts/smoke-test.js`. After existing smoke checks, add:

```js
// RAG accuracy smoke — only if vendor/models exists (skip in pre-build-models states)
const modelsDir = path.join(__dirname, '..', 'vendor', 'models', 'Xenova');
if (fs.existsSync(modelsDir)) {
  console.log('\n[rag-smoke] Running RAG accuracy probe...');
  try {
    require('child_process').execFileSync('node', [path.join(__dirname, 'smoke-rag-test.js')], { stdio: 'inherit' });
  } catch (e) {
    console.error('[rag-smoke] FAILED');
    process.exit(1);
  }
} else {
  console.log('[rag-smoke] skipped — vendor/models/ not present (run prebuild:models first)');
}
```

- [ ] **Step 4: Run smoke end-to-end**

```bash
cd electron
npm run prebuild:models  # download model
npm run smoke            # includes rag-smoke now
```

Expected: `[smoke-rag] Top-3: 34/40 = 85.0%` or better.

- [ ] **Step 5: Commit**

```bash
git add electron/scripts/smoke-rag-test.js electron/scripts/smoke-test.js electron/test-fixtures/rag-canonical.json
git commit -m "test(knowledge): 40-query RAG accuracy smoke (Top-3 85% hard gate)"
```

---

### Task 15: Wire models into vendor bundle + build chain

**Files:**
- Modify: `electron/scripts/prebuild-vendor.js` — include models in tar

- [ ] **Step 1: Verify models are included in vendor tar**

Read `electron/scripts/prebuild-vendor.js`. Find the block that calls `tar.create(...)` or `execFileSync('tar', ['-cf', ...])` — this is the tar packaging step.

The existing include list likely looks like:
```js
const includePaths = ['node_modules', 'node'];  // or similar
```

Locate this. Change to:
```js
const includePaths = ['node_modules', 'node'];
if (fs.existsSync(path.join(vendorDir, 'models'))) {
  includePaths.push('models');
  console.log('[prebuild-vendor] including vendor/models/ in tar');
}
```

If the script uses `tar.create({ cwd: vendorDir, file: tarPath }, includePaths)` pattern → the above line array change is sufficient.

If the script uses glob patterns like `tar -cf foo.tar vendor/`, then it already captures models/ → no edit needed, just verify by inspecting the built tar:

```bash
cd electron
tar -tf vendor-bundle.tar | grep models | head -5
```

Expected: lists model files (at minimum `models/Xenova/multilingual-e5-small/onnx/model_quantized.onnx`).

- [ ] **Step 2: Verify full build chain**

```bash
cd electron
npm run build:win 2>&1 | grep -E "(prebuild-models|smoke-rag|OK)"
```

Expected output includes:
- `[prebuild-models] all files ready at ...`
- `[smoke-rag] Top-3: NN/40 = NN%`
- `[smoke-rag] OK`

- [ ] **Step 3: Check EXE size**

```bash
ls -la "dist/9BizClaw Setup 2.3.47.exe"
```

Expected: ~465 MB (up from ~423 MB). If >500 MB, something didn't compress well — investigate.

- [ ] **Step 4: Commit**

```bash
git add electron/scripts/prebuild-vendor.js
git commit -m "build: include vendor/models/ in prebuild-vendor tar"
```

---

### Task 16: Version bump + release

**Files:**
- Modify: `electron/package.json` — version 2.3.47

- [ ] **Step 1: Bump version**

Edit `electron/package.json`: `"version": "2.3.47"`.

- [ ] **Step 2: Full local test flow**

```bash
cd electron
npm start
# Wait for boot, then:
# - Open Dashboard → Settings → verify RAG section appears
# - Upload a small PDF to Knowledge
# - Watch log for "[knowledge] embedded N/N chunks"
# - Send Zalo message matching content
# - Verify openclaw.log shows "RAG enriched with N chunks"
# - Verify bot reply uses doc content
```

Observe 5 minutes. No `rag_degraded` audit entries. No embedder errors.

- [ ] **Step 3: Build Windows**

```bash
cd electron
npm run build:win
```

Expected: `dist/9BizClaw Setup 2.3.47.exe` built, size ~465MB, smoke (including RAG) passed.

- [ ] **Step 4: Commit version + push + tag**

```bash
git add electron/package.json
git commit -m "$(cat <<'EOF'
chore(release): v2.3.47 — knowledge RAG (Tier 1 + Tier 2 opt-in)

Ships local semantic retrieval: Xenova/multilingual-e5-small quantized
runs in-process via transformers.js. Vector stored as BLOB alongside
existing FTS5 chunks. HTTP endpoint on 127.0.0.1:20129 serves top-3
chunks; openzalo inbound.ts RAG patch prepends to messages before
agent dispatch.

Tier 2 (opt-in in Settings): 9Router AI query rewrite when no-diacritic
regex matches OR top-1/top-2 margin < 0.03. Off by default.

Empirical: 83% Top-1 / 89% Top-3 on 20 hard Vietnamese test queries
(typos, semantic, comparison). 40-query smoke gates at Top-3 ≥ 85%.

Ship size: 423MB → ~465MB EXE (+42MB compressed ONNX).
Bot cost per message: ~$0 for Tier 1, ~$0.0001 for ~10% queries
hitting Tier 2 fallback.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"

git push origin main
git tag -a v2.3.47 -m "v2.3.47 — knowledge RAG"
git push origin v2.3.47
```

- [ ] **Step 5: Monitor Mac build + release**

```bash
gh run list --workflow=build-mac.yml --limit=1
```

Wait ~20 min. When complete:

```bash
gh release upload v2.3.47 "dist/9BizClaw Setup 2.3.47.exe" "dist/9BizClaw Setup 2.3.47.exe.blockmap"
gh release view v2.3.47 --json assets --jq '.assets[].name'
```

Expected: 6 assets (Win exe + blockmap, Mac arm64 dmg + blockmap, Mac Intel dmg + blockmap).

- [ ] **Step 6: STOP — await user review before customer deploy**

Same pattern as v2.3.45/46: don't deploy to LINH-BABY until CEO approves the release build.

---

## Rollback plan

Each commit is a single task. Rollback = `git revert <sha>` of any task that regresses. No DB migrations destructive (only additive column). Vendor/models dir can stay (dead weight, doesn't break anything). RAG patch in inbound.ts is removable via marker search+delete if needed.

## Out of scope (confirmed deferred)

- Tier 3 reranker (roadmap v2.4)
- BM25 hybrid (only worth revisiting at 1000+ chunks scale)
- Semantic chunking (fixed 500-char works for MVP)
- HyDE query expansion
- Multi-tenant embedding namespaces
