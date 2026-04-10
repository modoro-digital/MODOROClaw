# Context Optimization Design — Approach 2: Smart Context

**Date:** 2026-04-10
**Status:** Approved
**Priority:** No info loss. Token cost is not a constraint.

---

## Overview

4 optimizations to MODOROClaw's context storage and retrieval system. All changes in `electron/main.js`. No new dependencies.

**Guiding principle:** Never reduce information available to the bot. All optimizations are additive or improve retrieval speed without dropping data.

---

## Part A: extractConversationHistory — mtime filter + early-exit

### Problem
`extractConversationHistory()` (line ~1685) reads ALL `.jsonl` files in `~/.openclaw/agents/main/sessions/` regardless of date range. 500+ files scanned 3x/day.

### Solution

1. **mtime pre-filter:** `fs.statSync(file).mtimeMs` — skip files where `mtime < sinceMs`. Reasoning: session files are append-only (new messages appended at end). If a file's mtime is older than sinceMs, it has not received new messages since then, so it cannot contain messages within our time range. The filter is conservative: files with recent mtime are always read (even if they contain old messages too — those are filtered by timestamp inside the loop).

2. **Sort by mtime descending:** Read newest files first.

3. **Early-exit:** Once collected `maxMessages * 2` messages (buffer for dedup/sorting), stop reading more files.

4. **Tail-read optimization:** For large files (>64KB), read last 64KB instead of full file. Messages we want (recent) are appended at the end. Edge case: if a single file spans a wide time range AND relevant messages are in the first part (>64KB from end), they'd be missed. This is acceptable because: (a) mtime filter already ensures only recent files are read, (b) session files rarely exceed 64KB, (c) the missed messages exist in the raw journal anyway.

### Impact
- Morning cron (24h, 50 msg): ~3-5 files instead of 500+
- Weekly (7d, 100 msg): ~10-20 files
- Monthly (30d, 200 msg): ~30-50 files

### Fallback
None needed — strictly faster, same output.

---

## Part B: Daily journal summarization + additive context for weekly/monthly

### Problem
- `writeDailyMemoryJournal` dumps 100 raw messages to `memory/YYYY-MM-DD.md` (~25KB)
- Weekly prompt injects 100 raw messages. If week had 500 messages, 400 are dropped silently.
- Monthly: 200/1200+ messages, ~83% dropped.
- Bot writes reports from incomplete data without knowing.

### Solution

1. **Raw journal unchanged:** `memory/YYYY-MM-DD.md` continues to store full raw history. Audit trail preserved.

2. **Daily summary generation:** After writing raw journal, call 9Router to summarize into `memory/YYYY-MM-DD-summary.md` (~500-800 tokens). Prompt: summarize conversations into bullet points — who said what, outcomes, pending items.

3. **Weekly summary generation:** Every Monday, summarize 7 daily summaries into `memory/week-YYYY-WNN-summary.md`.

4. **Prompt injection changes:**

| Prompt | Before | After |
|--------|--------|-------|
| Morning/Evening | 50 raw messages 24h | **Same 50 raw messages** (no change) |
| Weekly | 100 raw 7d (drops overflow) | 50 raw 24h + 6 daily summaries (covers 100% of week) |
| Monthly | 200 raw 30d (drops overflow) | 50 raw 24h + 4 weekly summaries (covers 100% of month) |

5. **Summary cache:** If `YYYY-MM-DD-summary.md` exists, skip 9Router call. Idempotent.

6. **Fallback:** 9Router unavailable → current behavior (raw history only). Never block cron. Log warning to `audit.jsonl` when summary generation fails so CEO can see it in Dashboard activity feed.

7. **Weekly summary graceful degradation:** If some daily summaries are missing (9Router was down those days), weekly summarizer reads raw journals (`memory/YYYY-MM-DD.md`) for those days instead. Never skip a day — always have data from one source or the other.

### Result
- Daily reports: identical
- Weekly reports: strictly better coverage (100% vs ~20%)
- Monthly reports: strictly better (100% vs ~17%)

---

## Part C: Knowledge search reranking via 9Router

### Problem
`search-documents` IPC uses FTS5 keyword matching only. "chinh sach bao hanh" won't match docs containing "doi tra trong 30 ngay" or "warranty policy".

### Solution

**Layer 1 — Query expansion (before FTS5):**
- Call 9Router: "Expand this search into 3-5 Vietnamese synonym keywords: `<query>`"
- `max_tokens: 50`, timeout 2s
- Build expanded FTS5 query: `bao hanh OR doi tra OR warranty OR "chinh sach hoan"`
- **Sanitize LLM output:** Strip FTS5 special characters (`"`, `*`, `(`, `)`, `NEAR`) from expanded terms before building MATCH query. Only allow `OR` as operator. Prevents query injection from unexpected LLM output.
- Fail → use original query

**Layer 2 — FTS5 search:**
- Same as current, but with expanded query
- Returns top 10 candidates

**Layer 3 — Reranking (after FTS5):**
- Send 10 candidates (filename + 200-char snippet) + original query to 9Router
- "Rank these 10 results by relevance to the query. Return top 3 with reason."
- `max_tokens: 200`, `temperature: 0`, timeout 3s
- Fail → return FTS5 results as-is

### Latency
- Current: ~5ms
- After: ~5ms + ~800ms (expand) + ~800ms (rerank) = ~1.6s
- Acceptable for Knowledge tab search (user-initiated, not bot-internal)

### Fallback
Every layer has independent timeout + fallback to previous layer's results.

---

## Part D: Per-customer conversation memory

### Problem
- `memory/zalo-users/<senderId>.md` stores only metadata (name, phone, tags)
- Bot has no memory of previous conversations with returning customers
- One chatty customer (40 msgs/day) dominates the 50-message report slot, pushing out other customers

### Solution

**1. Per-customer daily interaction summary:**

At end of each day (inside `writeDailyMemoryJournal`):
- Group raw messages by sender field (parsed from `origin.label` format `"Name id:12345"` — extract the id portion after ` id:`. Messages with null/missing sender go into an "unknown" bucket and are skipped for per-customer summary)
- For each customer with messages today, call 9Router to summarize their conversation
- **Append** (not overwrite) to `memory/zalo-users/<senderId>.md` using `fs.appendFileSync` — safe against concurrent writes from openclaw gateway process which manages the YAML frontmatter section at the top of the file. Cron only appends dated sections at the bottom.

```markdown
## 2026-04-10
- Khach hoi gia san pham X, bao gia 2.5tr, khach noi se suy nghi
- Khach gui hinh mau, bot da chuyen cho CEO
- Trang thai: cho khach phan hoi
```

**2. Bot reads customer history on every interaction:**

When customer messages → openclaw loads workspace files → AGENTS.md already has rule to read `memory/zalo-users/<senderId>.md` → bot sees full interaction history → replies with context.

Flow:
```
Customer "Minh" messages → gateway receives
→ reads memory/zalo-users/<minh-id>.md
→ sees "04/10: hoi gia X, cho phan hoi"
→ replies: "Anh Minh, hom truoc anh hoi ve san pham X gia 2.5tr..."
```

**3. Per-customer cap in reports:**

`extractConversationHistory` adds post-processing:
- Group collected messages by sender
- Max **10 messages per customer per extraction**
- If customer has >10, keep first 2 + last 8 (capture start + recent context)
- Ensures all customers get representation in reports
- **Interaction with Part B:** The per-customer cap applies to `extractConversationHistory` output. Daily prompts (50 raw) will get capped per-customer. Weekly/monthly prompts inject raw 24h (also capped) + summaries (summaries are not capped — they are pre-computed aggregates). This means weekly/monthly get BETTER coverage than before: capped raw for recency + full summaries for completeness.

**4. Fallback:**
9Router fail → append raw messages to profile (verbose but no data loss).

### Data flow (no info loss proof)

```
Raw session JSONL     → kept (openclaw manages)
Raw daily journal     → kept (append-only, audit trail)
Per-customer summary  → additive (append to profile, never delete)
Report injection      → same raw count + added summaries
```

---

## Files changed

| File | Changes |
|------|---------|
| `electron/main.js` | `extractConversationHistory` rewrite, `writeDailyMemoryJournal` add summarization + per-customer, `build*Prompt` functions update, new `summarizeDailyForCustomer()`, new `expandSearchQuery()`, new `rerankSearchResults()`, `search-documents` IPC update |

## Non-goals
- No embedding / vector DB (defer to when knowledge > 500 docs)
- No changes to openclaw gateway internals
- No new npm dependencies
- No UI changes

## Verify
1. **Part A:** Add `console.time('[extract]')` — confirm <50ms for daily, <200ms for weekly
2. **Part B:** After cron fire, check `memory/YYYY-MM-DD-summary.md` exists. Weekly prompt includes daily summaries.
3. **Part C:** Knowledge tab search "bao hanh" returns docs about "doi tra" or "warranty"
4. **Part D:** Chat with Zalo customer → next day check `memory/zalo-users/<id>.md` has `## 2026-04-10` section. Customer messages again → bot references previous conversation.
