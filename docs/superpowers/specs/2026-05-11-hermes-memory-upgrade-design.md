# Hermes-Style Memory Upgrade — Design Spec

**Date:** 2026-05-11
**Status:** Approved
**Scope:** CEO interactions only (Telegram). Customer memory (Zalo per-user .md files) unchanged.

## Problem

9BizClaw's memory is flat files + daily cron summaries. The bot doesn't learn from CEO corrections, can't recall past decisions semantically, and has no cross-customer pattern detection. AGENTS.md is 25K chars but contains no learned knowledge — it's all hand-written rules.

Hermes agent (Nous Research, MIT, 64K+ stars) solves this with a 3-layer model: tiny hot tier always in prompt, SQLite cold tier searched on demand, agent-curated via periodic nudges. We adapt this for 9BizClaw with embedding-enhanced retrieval using the existing e5-small model.

## Architecture: 2-Tier Memory

### Hot Tier — `CEO-MEMORY.md`

Agent-curated markdown file at `{workspace}/CEO-MEMORY.md`. Always loaded into agent system context alongside AGENTS.md. Budget: ~2K tokens max.

Contains the bot's most important learnings, grouped by type:

```markdown
## Ve anh (CEO profile)
- Goi anh Huy, xung em
- Thich tra loi ngan gon

## Quy tac da hoc
- Khach hoi bao hanh → 12 thang, khong can hoi sep
- Gia si chi bao khi khach hoi ≥10 cai

## Patterns
- Thu 2-3 nhieu khach nhat (peak 9-11h)
- Nhom "Dai ly mien Tay" hay hoi ve chiet khau

## Ghi chu tam
- Dang cho confirm gia moi Q3
```

Regenerated automatically from top memories in cold tier, ranked by effective score (see Relevance Decay). Written atomically with 2-second debounce — multiple rapid writes trigger only one regeneration. Budget enforced by character proxy: iterate top-by-score, stop when cumulative length exceeds 8000 chars (~2K tokens for Vietnamese).

### Cold Tier — SQLite (`memory.db`)

Two new tables in the existing `memory.db` database:

**`ceo_memories`**

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | `mem_` + timestamp + 6-char random |
| type | TEXT | `rule` / `pattern` / `preference` / `fact` / `correction` |
| content | TEXT | The memory text (Vietnamese) |
| source | TEXT | `nudge` / `ceo_correction` / `evening_summary` / `manual` |
| embedding | BLOB | 384-dim float32 vector (e5-small) |
| relevance_score | REAL | Starts 1.0 (corrections: 1.5). Decays 0.02/day, +0.1 on access |
| model_version | TEXT | Embedding model identifier for future migration |
| created_at | TEXT | ISO timestamp |
| updated_at | TEXT | ISO timestamp |

**`ceo_memory_fts`** — FTS5 virtual table over `ceo_memories.content` for keyword search.

### Retrieval: Hybrid Search

On `memory/search(query)`:
1. FTS5 keyword match → raw BM25 scores (negative, lower = better)
2. Normalize FTS5: `fts_norm = 1.0 / (1.0 + Math.abs(rank))` → bounded [0, 1]
3. `embedText(query)` → cosine similarity against all stored embeddings → bounded [0, 1]
4. Compute effective relevance: `relevance = stored_score - 0.02 * daysSince(updated_at)`
5. Merge: `0.4 * fts_norm + 0.4 * cosine_score + 0.2 * Math.max(0, relevance)`
6. Dedupe, return top-K
7. Bump `relevance_score` by +0.1 on returned entries (UPDATE the row)

At <1000 entries, full vector scan is <5ms — no vector index needed.

## Nudge Mechanism

### Trigger

After CEO finishes a Telegram conversation. Detected by idle timer:
- `_lastCeoMessageAt` updated on every inbound Telegram CEO message
- Timer checks every 60s: if idle >5min AND hasn't nudged for this conversation → fire

### Correction Fast-Path

When CEO message matches correction patterns, nudge fires immediately instead of waiting 5 minutes. Memory stored with `source: 'ceo_correction'` and `relevance_score: 1.5`.

Patterns matched with diacritics-stripped normalization (covers both typed-with and typed-without diacritics):
- `không phải` / `khong phai`
- `sai rồi` / `sai roi`
- `nhớ là` / `nho la`
- `luôn luôn` / `luon luon`
- `đừng bao giờ` / `dung bao gio`
- `từ giờ` / `tu gio`
- `phải là` / `phai la`

### Nudge Agent Call

Does NOT use `runCronAgentPrompt()` (which would `--deliver` the output to CEO's Telegram). Instead, spawns the agent with `spawnOpenClawSafe()` in JSON-output mode WITHOUT `--deliver`. Main.js parses the structured JSON response and calls `ceo-memory.js` functions directly in-process. This avoids auth token bootstrapping and prevents nudge output from being sent to CEO.

Prompt (injected as `--message`):

```
Review the last conversation with CEO. Decide if anything is worth
remembering long-term:
- A correction (CEO said "not like that, do it this way")
- A new business rule or preference
- A pattern across recent customers
- A fact about the business

Respond with JSON: { "memories": [{ "action": "write"|"delete", "type": "rule"|"pattern"|"preference"|"fact"|"correction", "content": "...", "id": "..." }] }
If nothing worth saving, respond: { "memories": [] }

Current CEO-MEMORY.md:
{contents}

Last conversation:
{last_session_transcript}
```

Main.js handler parses the JSON output, calls `writeMemory()` / `deleteMemory()` from `ceo-memory.js` directly. No API roundtrip, no auth needed.

Cost: ~1 LLM call per CEO conversation.

## Cron API Endpoints

Three new endpoints on existing Cron API (port 20200), same auth token:

### `POST /api/memory/write`

```json
{ "type": "rule", "content": "Khach hoi bao hanh → 12 thang" }
```
- Validates `type` against enum (`rule`/`pattern`/`preference`/`fact`/`correction`)
- Validates `content` length: max 500 chars. Strips markdown headers (`##`, `#`) to prevent CEO-MEMORY.md structure corruption
- Embeds content via `embedText()` (reuses Knowledge tab's e5-small)
- Inserts into `ceo_memories` + FTS5 index
- Triggers `CEO-MEMORY.md` regeneration (debounced 2s)
- Returns `{ id, created_at }`

### `POST /api/memory/search`

```json
{ "query": "bao hanh", "limit": 5 }
```
- Hybrid FTS5 + cosine similarity search
- Bumps relevance on accessed entries
- Returns `[{ id, type, content, score, created_at }]`

### `POST /api/memory/delete`

```json
{ "id": "mem_1715..." }
```
- Hard delete from `ceo_memories` + FTS5
- Triggers `CEO-MEMORY.md` regeneration

## Embedding Pipeline

Reuses existing `embedText()` from `knowledge.js` — e5-small (384-dim, ONNX quantized, in-process). No new model download.

- Lazy init: ~2-3s cold start on first call, warm after that
- `model_version` column enables future model swap: on mismatch, re-embed lazily on next access
- Full scan of 1000 × 384-dim vectors: <5ms in JS — no vector index needed at this scale

## Integration Points

### Agent Context Loading

Append `CEO-MEMORY.md` content as a managed section at the end of AGENTS.md during `ensureDefaultConfig()`. Bracketed by markers (`<!-- CEO-MEMORY START -->` / `<!-- CEO-MEMORY END -->`) so it can be replaced atomically on regeneration without touching the rest of AGENTS.md. This uses the existing workspace file loading mechanism — no openclaw code changes needed.

### Agent Tool Access

Add documentation-only instructions to AGENTS.md teaching the agent to use `web_fetch` to call `POST http://127.0.0.1:20200/api/memory/*` with Bearer token authentication. These are NOT openclaw-registered tools — they follow the same pattern as existing cron API tools (agent calls `web_fetch` with the API URL). The agent acquires the auth token from `cron-api-token.txt` via `read_file`.

### Evening Summary Enhancement

After existing `appendPerCustomerSummaries()` completes, add one extra step:
1. Summarize today's customer interactions
2. Call `searchMemory()` in-process with the summary text
3. If a similar pattern already exists (cosine > 0.85), update its `relevance_score` and `updated_at` instead of creating a duplicate
4. If new cross-customer pattern emerges (e.g., 3+ customers asked about same topic) → write a `pattern` type memory with `source: 'evening_summary'`

Zero extra CEO interaction cost. Gives cross-customer learning for free. Dedup prevents "warranty questions" from being written every evening.

### Correction Detection

In `main.js`, not a separate module. CEO Telegram message detection: tail `audit.jsonl` for recent entries with `event: 'message_inbound'` and `channel: 'telegram'` to detect CEO activity and update `_lastCeoMessageAt`. When message text matches correction regex patterns (diacritics-normalized) → set `_nudgeImmediate = true` flag → next timer tick fires nudge immediately.

### Dashboard Visibility (Minimal)

No new page. Overview page gets:
- "Bot da hoc: N" badge with last learning timestamp
- Click opens read-only list of recent memories with delete buttons
- IPC: `get-ceo-memories` (list), `delete-ceo-memory` (remove by id)

## Relevance Decay

- Initial score: 1.0 (corrections: 1.5)
- Decay is computed virtually, never stored: `effective_score = relevance_score - 0.02 * daysSince(updated_at)`
- The stored `relevance_score` only changes on access boost (+0.1, which writes to the row) or on initial write
- Access boost: +0.1 per search hit (UPDATEs `relevance_score` and `updated_at` in the row)
- Hot tier uses the same virtual formula to rank. Iterate top-by-effective-score, stop at 8000 chars (~2K tokens)
- Memories that keep getting recalled stay alive; unused ones sink out of hot tier but remain searchable in cold tier

## Schema Migration

- `CREATE TABLE IF NOT EXISTS` / `CREATE VIRTUAL TABLE IF NOT EXISTS` — idempotent on every app start
- `CEO-MEMORY.md` seeded as empty file on fresh install via `seedWorkspace()`
- No data migration needed — this is net-new functionality
- `model_version` lazy re-embedding: on search, if any returned row has `model_version != CURRENT_MODEL_VERSION`, queue a background re-embed (non-blocking). Return results using old embedding scores (degraded but functional). Background `reembedStaleMemories()` runs after queue fills.

## Files Changed/Created

| File | Change |
|------|--------|
| `electron/lib/ceo-memory.js` | **NEW** — memory CRUD, FTS5, embedding, hybrid search, CEO-MEMORY.md regeneration |
| `electron/lib/cron-api.js` | Add 3 `/api/memory/*` endpoints |
| `electron/lib/cron.js` | Add evening summary → pattern detection step |
| `electron/main.js` | Nudge timer, correction detection, `_lastCeoMessageAt` tracking |
| `electron/lib/dashboard-ipc.js` | Add `get-ceo-memories`, `delete-ceo-memory` IPC handlers |
| `electron/preload.js` | Add memory IPC bridges |
| `electron/ui/dashboard.html` | Overview badge + memory list modal |
| `electron/lib/workspace.js` | Seed empty `CEO-MEMORY.md` on fresh install |
| `AGENTS.md` | Add memory tool descriptions (3 tools via web_fetch) |

## What This Does NOT Change

- AGENTS.md size/content (unchanged, per user decision)
- Customer memory (Zalo per-user .md files stay as-is)
- Knowledge tab (unchanged, shares embedding model only)
- Existing cron jobs (morning/evening reports continue as-is)
- Existing conversation history extraction (unchanged)

## Success Criteria

1. CEO corrects the bot → bot never makes the same mistake again (stored as `correction` memory)
2. CEO asks "what did we discuss about X?" → bot recalls via hybrid search, even if it was weeks ago
3. Evening summary detects "3 customers asked about warranty this week" → bot proactively tells CEO next morning
4. Dashboard shows growing memory count — CEO sees the bot getting smarter
5. Total hot tier stays under 2K tokens — no AGENTS.md bloat
