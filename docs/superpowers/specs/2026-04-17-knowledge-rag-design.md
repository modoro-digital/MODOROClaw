---
title: Knowledge RAG — 3-tier semantic retrieval for MODOROClaw
date: 2026-04-17
status: draft
---

# Knowledge RAG — Semantic retrieval with local embeddings + AI query rewrite

## Context

Customers upload business documents (product catalogues, FAQ, policies) via Dashboard → Knowledge. Bot needs to answer customer questions accurately using that content.

**Current state (v2.3.46):**
- Upload: text extracted via pdf-parse, stored in SQLite `documents` table, chunked into `documents_chunks` with FTS5 index
- Bot context: reads `knowledge/<cat>/index.md` at bootstrap — a summary+first-8KB dump of every doc (capped at 50KB/category)
- Retrieval: NONE at query time. Bot sees truncated dump, can't find specifics from page 4+ of any document
- FTS5 chunks table + `knowledge-search` IPC handler exist (lines 14226, 15065 of [main.js](../../../electron/main.js)) but NOT wired to agent

**Problem:**
- 26-page PDF: first ~3 pages fit in index.md, remaining 23 pages invisible to bot
- Customer asks "iPhone 15 Pro Max 256GB giá bao nhiêu" (answer on page 18) → bot hallucinates or says "không biết"
- Current architecture incorrectly trades accuracy for context economy (dumps the wrong 8KB)

**Requirement from user:**
- Free (no per-query cost if possible)
- Low friction (no API key for embedding, no Ollama setup)
- Query fast (<100ms end-to-end)
- Accuracy: "trả lời đúng ở bất kỳ vị trí nào trong file" — target 97%+ in production

## Empirical testing (2026-04-17)

Before committing architecture, ran a retrieval matrix on 20 Vietnamese customer queries × 25 chunks × 10 configurations (stored at `c:/tmp/rag-test/`):

| Config | Top-1 | Top-3 |
|---|---|---|
| **Vector only (e5-small quantized)** | **83%** | **89%** |
| BM25 only (FTS5 equivalent) | 67% | 78% |
| Hybrid RRF (vector + BM25) | 67% | 83% |
| Weighted 70V/30BM25 | 67% | 89% |
| Vector + threshold 0.78/0.82 (OOD reject) | 83% | 89% |

**Findings:**
1. **Pure vector WINS on shop-scale corpus (25 chunks).** Hybrid hurts T1 — BM25 noise pulls vector results down when corpus is too small for BM25 statistics to stabilize.
2. **Score threshold does not reliably detect OOD.** "Bán máy giặt không" (out-of-domain) scored 0.85 — above typical threshold 0.78-0.82. Embedding model lacks an "I don't know" signal.
3. **2 unsolved failure modes by retrieval alone:**
   - No-diacritic input (`"giay bao hanh may cu"` — most Zalo customers type without diacritics)
   - Negation (`"máy nào không phải iPhone"`)

**Architectural implication:** at shop scale (~25-500 chunks), vector-only is the correct base. BM25 re-enters at 1000+ chunks but we defer that optimization. Both edge-case failures require AI-assisted query rewrite, not a different retrieval method.

## Architecture — 3 tiers

### Tier 1 (mandatory, default ON) — Pure vector RAG

**Embedding model:** `Xenova/multilingual-e5-small` (quantized, 113MB ONNX)
- Runs via `@xenova/transformers` in Electron main process (CPU, ONNX Runtime)
- 384 dimensions, normalized
- Vietnamese-capable (trained on 100+ languages)
- Inference: 13ms/chunk embed, 5-8ms query embed (benchmarked)
- Offline after initial model load — no network dependency at runtime

**Storage:** extend existing `documents_chunks` SQLite table with `embedding BLOB` column
- Float32 array × 384 dims = 1536 bytes per chunk
- 1000 chunks = 1.5MB storage — negligible
- Indexed by `document_id` for filtering (no ANN index — linear cosine is fast enough at this scale)

**Retrieval:**
- Query embedded (5-8ms)
- Cosine similarity computed in JS vs all chunks (10ms for 1000 chunks — vectors already normalized, so dot product = cosine)
- Top-3 returned

**Context injection:** top-3 chunks (~1.5-3KB) prepended to customer message before agent dispatch. Message format:
```
[Tài liệu liên quan]
[<filename>, chunk <N>]
<snippet>
---
[<filename>, chunk <M>]
<snippet>
[/Tài liệu liên quan]

[Câu hỏi khách]
<original message>
```

**Bootstrap index.md:** reduced to file manifest only (filename + 1-line AI summary). No more full-text dump. Saves ~95% context budget.

**Why this alone is enough for many shops:** 83% T1 / 89% T3 on hard test queries. Shops with narrow, factual content (product catalogues, FAQ) will hit higher in production since vocabulary is controlled.

### Tier 2 (opt-in in Settings) — AI query rewrite fallback

**Trigger design (corrected from score threshold):**

The empirical test (line ~44) proved raw score threshold is unreliable — OOD queries scored 0.85 above a 0.82 threshold, so the score alone cannot distinguish "bot is confident and correct" from "bot is confidently wrong." Use a **2-signal OR gate** instead:

1. **No-diacritic regex signal** — if query contains Vietnamese consonants/vowels but zero diacritics (e.g., `giay bao hanh may cu`), it's near-certainly typed without accents. Always rewrite. Detection: `/[a-z]{3,}/i.test(q) && !/[\u00C0-\u1EF9]/.test(q)`.
2. **Low-margin signal** — if `top1.score - top2.score < 0.03`, retrieval is uncertain (close contenders). Rewrite.

Neither trigger alone is sufficient; the OR covers both typo inputs (signal 1) and genuinely ambiguous queries (signal 2). Expected fire rate: ~10-15% of customer messages.

**Do NOT use raw score threshold** as the sole trigger — the test showed a 0.78-0.85 range contains both correct retrievals and false-confident OOD results, so no single cutoff separates them.

**Rewrite path:**
- Original query → 9Router AI call with prompt: "Chuẩn hoá câu hỏi tiếng Việt sau (thêm dấu, bỏ từ lóng, giữ ý): '<query>'"
- Response → new query
- Re-embed + re-search → new top-3

**Model selection (wizard-time choice):**
- If user's primary AI is **ChatGPT Plus OAuth** → use `ninerouter/main` (free, already paid via subscription)
- If user's primary AI is **paid API (OpenAI/Anthropic key)** → use `ninerouter/fast` slot (cheap model — Haiku / GPT-4o-mini)
- Default rewrite model configurable in Settings; fallback to `main` if `fast` unconfigured

**Cost + latency:**
- Latency: 200-500ms (acceptable only on the ~10% slow path)
- Cost: ~$0.10-0.15/month per shop using `fast` slot ($3/month worst case on `main` with paid API)
- Free if using ChatGPT Plus OAuth (most common config)

**Expected gain:** +5-8% accuracy (fixes no-diacritic + typo cases; partial help on negation).

### Tier 3 (roadmap v2.4, NOT in v1) — Local reranker

Adds cross-encoder reranker (`Xenova/bge-reranker-v2-m3`, ~560MB model, +150MB compressed, +200ms/query) for +5-8% accuracy over Tier 2. Off by default, opt-in in Settings. Defer until customer feedback shows Tier 2 insufficient.

## UI / Config

**Settings → Knowledge tab:**

```
[Knowledge RAG]
Bot tra cứu tài liệu thế nào khi trả lời khách?

[x] Tìm kiếm thông minh (khuyến nghị)              ← Tier 1 always on
    └─ Dùng mô hình local để tìm đoạn văn liên quan nhất
       Không tốn tiền, hoạt động offline.

[ ] Tự chuẩn hoá câu hỏi khó qua AI (nâng cao)     ← Tier 2 opt-in
    └─ Khi khách gõ thiếu dấu, sai chính tả, hoặc dùng viết tắt,
       bot nhờ AI chính sửa câu trước khi tìm kiếm.
       Model dùng: [dropdown: main / fast]  Default: auto-detect
       Chi phí ước tính: $0.10-3/tháng tuỳ provider.

[ ] Xếp lại kết quả bằng reranker (chưa có)        ← Tier 3 not in v1
    └─ (Sẽ có ở bản 2.4 — tăng độ chính xác thêm 5%)
```

**Default state on fresh install:** Tier 1 ON, Tier 2 OFF. User enables Tier 2 if they see bot missing customer intents.

**Wizard integration:** AFTER wizard step 2 ("Thiết lập AI"), detect primary AI provider to **pre-fill the rewrite model dropdown** — but leave Tier 2 **checkbox OFF**. User must explicitly tick to enable (consent). Pre-fill rules:
- ChatGPT Plus OAuth → dropdown value = `main` (so if user ticks later, it's free by default)
- Paid API key → dropdown value = `fast` (so if user ticks, they get the cheap slot)

No silent enablement. User always sees the checkbox state they chose.

## Data flow

```
On upload:
  1. Dashboard → upload PDF
  2. pdf-parse extracts text (existing)
  3. chunkVietnameseText() (existing, 500char + 100 overlap)
  4. For each chunk: transformers.js embed → Float32Array(384)
     → INSERT INTO documents_chunks (document_id, category, chunk_index, content, embedding)
  5. rewriteKnowledgeIndex() updates index.md (summary-only now)

On customer message (Zalo / Telegram — patched in inbound.ts equivalent for each plugin):
  1. Message arrives, passes all existing filters (blocklist, system-msg, dedup, group-settings)
  2. RAG patch reads rawBody → HTTP call to Electron main on 127.0.0.1:20129/search
  3. main.js handler: embed query → cosine sim vs all chunks → top-3
  4. Return JSON with chunks
  5. Patch prepends chunks to rawBody → forwards to agent
  6. Bot AI replies using injected context
```

## Error handling

- **Transformers.js fails to load (first boot):** log warning, fall back to summary-only index.md (current behavior). User sees degraded retrieval but bot still functional.
- **Model file corrupted:** SHA256 checked on bundled model; re-extract from vendor tar on mismatch.
- **SQLite embedding column missing (older DB):** idempotent `ALTER TABLE documents_chunks ADD COLUMN embedding BLOB` on boot. Re-embed all chunks lazily on first RAG query if column was empty.
- **Concurrent upload + backfill race:** DB opened in WAL mode (already default in existing code). Wrap embed-and-write in per-row upsert (`INSERT ... ON CONFLICT(id) DO UPDATE SET embedding = excluded.embedding`) so upload and backfill can both write without conflict. Backfill skips rows where `embedding IS NOT NULL`.
- **HTTP endpoint unreachable from gateway (main.js crashed):** inbound.ts patch times out after 2s, continues without RAG enrichment. Bot answers without knowledge context (fail open). **Circuit breaker + audit trail:** track consecutive RAG failures in `global._ragFailCount`. On 3rd consecutive fail within 60s, emit `audit.jsonl` entry `rag_degraded` + surface in Dashboard "Cần để ý" section so CEO sees "Tìm kiếm tài liệu tạm dừng" instead of silent downgrade. Auto-reset on first successful call.
- **9Router rewrite call fails (Tier 2):** log warning, use original Tier 1 results. User sees slightly worse answer for that one message.
- **Embedding API mismatch after upgrade** (e.g., we change model): store model version alongside embedding. On mismatch, re-embed in background — don't block queries.

## Testing strategy

**Unit tests (`electron/test/knowledge-rag/`):**
- `embed.test.js` — verify model loads, outputs 384-dim normalized vectors
- `cosine.test.js` — verify cosine sim math against known vectors
- `chunking.test.js` — existing chunking still works after column addition

**Integration test (`smoke-rag-test.js`):**
- Seed 25 Vietnamese chunks + embeddings
- Run 40 canonical queries (expanded from 20 — single wrong answer becomes 2.5% not 5%, reducing CI noise)
- **Hard gate: Top-3 ≥ 85%** (primary regression signal — aligns with empirical baseline)
- Soft metric: Top-1 reported but not gating (single-query noise too large to gate on)
- Benchmark: query time < 200ms on CI runner

**Smoke inclusion:** add to `npm run smoke` chain — blocks build if RAG layer regresses below threshold.

**Manual verification on LINH-BABY:**
1. Upload sample 26-page PDF (product catalogue)
2. Send 10 test messages via Zalo with questions spanning pages 1-26
3. Verify bot replies contain correct answers
4. Check `logs/main.log` shows `[rag] query="..." top3=[...]`

## Ship size + performance budget

| | Before (v2.3.46) | After (v2.3.47 with Tier 1) |
|---|---|---|
| EXE size (Windows) | 423 MB | ~465 MB (+42 MB LZMA-compressed ONNX model) |
| Vendor bundle (tar) | 1.6 GB | ~1.73 GB (+130 MB raw model) |
| First launch extract | 30-60s | 30-60s (model loads async after splash) |
| Memory at idle | ~300 MB | ~300 MB (model lazy-loaded on first query, unloaded after 10 min idle) |
| Memory while RAG active | ~300 MB | ~450 MB (ONNX model + tensors in RAM) |
| Per-message cost | $0 (via ChatGPT Plus) | $0 Tier 1 |
| Per-message latency | ~50ms intake | ~100ms with RAG (50ms embed + cosine + inject) |

## Fresh-install parity (CLAUDE.md Rule #1)

- Model ships bundled in `vendor/node_modules/@xenova/transformers/` + `vendor/models/multilingual-e5-small/` → NSIS extracts → first boot finds locally
- `@xenova/transformers` pinned in `electron/package.json` per Rule #4
- `ALTER TABLE documents_chunks ADD COLUMN embedding BLOB` runs in `ensureKnowledgeChunksSchema()` on every boot → schema heals automatically on upgrade
- Backfill on boot: if `documents_chunks.embedding IS NULL` count > 0, embed lazily in background (doesn't block boot)
- Smoke test verifies model file exists + loads successfully

## Risks

| Risk | Mitigation |
|---|---|
| Model download fails on CI first run | `prebuild-models.js` downloads from HuggingFace CDN with SHA256 pin, caches in `vendor/models/`. DO NOT commit 130MB binary to git. Rule #4 (pin versions) means pin the SHA256 hash, not commit the blob. CI caches `vendor/models/` between runs. |
| Transformers.js not Node 18 compatible | Test confirmed works on Node 18.18.2 (Electron 28's runtime) — CI matrix covers |
| e5-small accuracy insufficient in production | Tier 2 opt-in available; Tier 3 on roadmap |
| Customer shop has 10K+ chunks → O(N) cosine too slow | Profile: 10K × 384 floats × 1 cos = 40ms still. Switch to sqlite-vec extension if >50K |
| Customer upload very long doc (1000 chunks at once) | Embed chunks async, show Dashboard progress bar; don't block upload confirmation |
| Model hallucinates false confidence on OOD queries (verified in test) | Injection block includes instruction: `[Lưu ý: nếu đoạn trên không liên quan câu hỏi, BỎ QUA và trả lời theo kiến thức chung hoặc nói chưa có thông tin]`. Placed INSIDE the RAG context block (not system prompt) so it's scoped to the current message — doesn't leak into general AGENTS.md behavior. |

## Out of scope

- BM25 hybrid retrieval (deferred — only worth revisiting at 1000+ chunks scale)
- Semantic chunking (deferred — fixed 500-char works for MVP)
- HyDE / query expansion beyond simple rewrite (deferred)
- Reranker (Tier 3) — roadmap for v2.4
- Multi-tenant embedding namespaces — single shop per install, not needed
- Streaming retrieval (RAG uses single round-trip)

## Rollback plan

- All changes additive: new column, new patch, new HTTP endpoint
- Revert = remove `ensureZaloRagFix()` call + remove `ensureKnowledgeEmbeddingSchema()` call + remove HTTP server start
- `embedding BLOB` column safely ignored by old code
- No data loss: embeddings are derived, can be re-generated from chunks
- Vendor model file can stay in bundle (just dead weight if feature disabled)

## Dependencies added

- `@xenova/transformers` — pinned version in `electron/package.json`, bundle size handled via vendor extract
- Model: `Xenova/multilingual-e5-small` — bundled in `vendor/models/` at build time via new `prebuild-models.js` step

## Deliverables

1. `electron/main.js`:
   - `getEmbedder()` — lazy-init transformers.js pipeline
   - `embedText(text, isQuery)` — helper with prefix
   - `cosineSim(a, b)` — normalized vector dot product
   - `ensureKnowledgeEmbeddingSchema()` — idempotent column add + model migration stamp
   - `searchKnowledgeVector(query, category, limit)` — extends existing `searchKnowledge()` with vector ranking
   - `startKnowledgeSearchServer()` — already added in this session; keep
2. `ensureZaloRagFix()` — inbound.ts patch, HTTP call + prepend chunks
3. Wizard integration — auto-detect ChatGPT Plus OAuth, pre-configure Tier 2
4. Dashboard Settings UI — 3 checkboxes + rewrite model dropdown
5. `electron/scripts/prebuild-models.js` — downloads + bundles model at build time
6. Smoke test `electron/scripts/smoke-rag-test.js` — 40-query accuracy probe (Top-3 ≥ 85% hard gate)
