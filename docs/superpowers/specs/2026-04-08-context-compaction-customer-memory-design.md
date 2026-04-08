# Context Compaction + Customer Memory — Design Spec

**Date:** 2026-04-08
**Status:** Draft → pending review
**Author:** brainstorming session with founder

## Problem

MODOROClaw spawns `openclaw` agent runs for every Telegram/Zalo message and every cron task. openclaw stores each conversation as an append-only `.jsonl` file in `~/.openclaw/agents/main/sessions/<uuid>.jsonl` and **never compacts**. As conversations grow, every reply loads more tokens into the LLM. Failure modes that will hit production:

1. **Context overflow** mid-reply → bot crashes mid-sentence with customer
2. **Quota burn** — long conversations send 20k+ tokens per reply, OAuth Plus quota exhausts fast
3. **Latency creep** — reply time grows linearly with conversation length until customer abandons
4. **No long-term customer memory** — bot forgets what customer said yesterday because gateway only sees current session jsonl, no cross-conversation knowledge
5. **No structured customer profile** — admin (founder) cannot click on a Zalo customer in Dashboard and see "personality, preferences, decisions made, open commitments". Sales team flying blind.

The founder's hard requirement: **"khách nói 1 đằng mà bot trả lời 1 nẻo là chết"** — never confuse customers about prices, decisions, commitments. And: **customer must NEVER see any "compacting" indicator** — invisibility is mandatory.

## Goals

1. Bot **never** overflows context, **never** errors mid-reply due to context size
2. Compaction is **completely invisible** to end customer (no spike, no marker, no typing pause anomaly)
3. Important facts (prices, dates, decisions, commitments) **never silently lost** during compaction
4. Each customer (Tel + Zalo, individual + group sender) has a **persistent structured profile** queryable from Dashboard
5. Admin can **view** any customer's profile by clicking them in the existing Dashboard user list
6. Full **export/backup/restore** so data is portable, never vendor-locked
7. **Defensible audit trail** — when customer disputes "you said X yesterday", admin can recover ground truth

## Non-goals (v1)

- Edit profile fields manually (read-only in v1, AI-extracted only)
- Cross-channel profile linking (Tel user X = Zalo user X) — manual merge in v2
- Smart token counting via real tokenizer — char-based estimate sufficient for trigger
- Encrypted exports — plain zip in v1
- Paid add-on gating — feature is free in v1, gating logic deferred to v2
- Dashboard analytics tab for compaction stats — audit log file only

## Architecture overview

Two coupled services sharing one LLM call:

```
┌──────────────────────────────────────────────────────────────────┐
│                   MODOROClaw (Electron main process)              │
│                                                                    │
│   ┌────────────────────────┐      ┌───────────────────────────┐   │
│   │ ConversationCompactor  │─────▶│ CustomerMemoryService     │   │
│   │                        │      │                           │   │
│   │ • bg sweep */2 min     │      │ • SQLite customer-        │   │
│   │ • JIT @ 90% safety net │      │   profiles.db             │   │
│   │ • rewrites session     │      │ • upsert on compact       │   │
│   │   .jsonl in place      │      │ • read API for UI         │   │
│   │ • archives originals   │      │ • pinned-context writer   │   │
│   │   to .archive.jsonl    │      │ • export/restore          │   │
│   │ • critical-msg pinning │      │                           │   │
│   │ • 2-phase commit       │      │                           │   │
│   └────────────┬───────────┘      └─────────┬─────────────────┘   │
│                │                             │                     │
│                └──────────┬──────────────────┘                     │
│                           ▼                                        │
│   ┌────────────────────────────────────────────────────────────┐  │
│   │ 9router → gpt-5-mini (primary, ChatGPT Plus OAuth)         │  │
│   │   fallback → any combo model (Claude / Gemini / Ollama)     │  │
│   │   last resort → silent (no LLM, no destructive heuristic)   │  │
│   │ Output JSON: { conversation_summary, profile_updates }     │  │
│   └────────────────────────────────────────────────────────────┘  │
│                                                                    │
│   ┌────────────────────────────────────────────────────────────┐  │
│   │ Dashboard UI                                                │  │
│   │ • Zalo + Telegram tabs: existing user lists                │  │
│   │ • Click user → side panel slide from right with profile    │  │
│   │ • Export/Backup tab (sidebar)                              │  │
│   └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘

Storage:
  ~/.openclaw/agents/main/sessions/<uuid>.jsonl         (live, compacted)
  ~/.openclaw/agents/main/sessions/<uuid>.archive.jsonl (append-only forever)
  ~/.openclaw/workspace/customer-profiles.db            (SQLite)
  ~/.openclaw/workspace/logs/compaction.jsonl           (audit trail)
  ~/.openclaw/workspace/backups/auto-YYYY-MM-DD.zip     (daily auto-backup, keep 7)
```

## Six core principles (the pivot rules)

These are the iron rules that make "khách nói 1 đằng bot trả lời 1 nẻo" architecturally impossible:

1. **Originals never deleted** — every old message moves to `<uuid>.archive.jsonl` (append-only forever) before being replaced in the live session jsonl. Ground truth always exists.
2. **Profile DB is source of truth for facts**, not the LLM-generated summary. Prices, dates, decisions, commitments live as structured rows with timestamps and source_message_id pointers.
3. **Pinned context at slot 1 of session jsonl**, auto-refreshed when profile DB updates. Bot reads structured facts on every reply without depending on summary fidelity.
4. **Critical messages never compacted** — heuristic detects messages containing money, dates, decisions, open questions → keeps them verbatim regardless of age.
5. **2-phase commit** — archive append → DB upsert → ONLY THEN rewrite live jsonl. Any phase failure aborts before destructive action.
6. **LLM unavailable = silence, not destructive heuristic** — never drop messages blindly. Better to pause that one customer for 5 min than reply wrong.

## Component 1: ConversationCompactor

### Trigger logic

- **Background sweep** (`node-cron */2 * * * *` inside Electron main process): scan `~/.openclaw/agents/main/sessions/*.jsonl`, for each file estimate token usage via `chars / 3.5`. If usage ≥ **60% of budget** → enqueue compaction job.
- **JIT safety net**: a hook fires before each inbound message reaches the gateway (intercept point TBD during implementation — likely a file watcher on session jsonl that runs synchronously when size crosses 90%). If session ≥ **90% of budget** → run compaction synchronously, blocking reply 2-4s. Bot's existing "đang nhập…" indicator hides the latency.
- **Token estimation**: `tokens ≈ char_count / 3.5` (Vietnamese compresses worse than English; ratio is conservative). Good enough for trigger decisions; no real tokenizer needed in v1.

### Budget per conversation (adaptive)

- **Default budget:** 30,000 tokens (≈ 105k chars)
- **VIP budget:** 80,000 tokens, applied automatically when:
  - `customer_profiles.is_vip = 1` (manual flag from Dashboard), OR
  - `customer_profiles.message_count > 200` (auto-promoted long-term customer)
- Budget recomputed on every sweep (hot-reload from DB).

### Compaction algorithm (sliding window + critical pinning)

```
1. Acquire exclusive file lock (<uuid>.jsonl.lock with PID, steal if PID dead)
2. Snapshot read entire session jsonl into memory
3. Identify "old block" = all events except last 20 message events
4. SKIP if old_block.length < 5 (not worth a LLM call)
5. Detect "critical messages" in old block via regex/keyword:
   - Money: \d+(?:[.,]\d{3})*\s*(đ|tr|k|nghìn|triệu|VND|vnd)
   - Dates: \d{1,2}[/\-]\d{1,2}|thứ\s?[2-7]|chủ nhật|ngày mai|tuần sau|hôm nay
   - Decisions (Vietnamese keywords): đặt|chốt|lấy|mua|hủy|đổi|hẹn|cam kết|hứa|ok|đồng ý|được|xác nhận
   - Open questions: user message ending in "?" with no immediately-following bot answer matching same topic
6. Pinned messages REMAIN verbatim in compacted output
7. Non-pinned old messages → fed to LLM for summarization
8. LLM call (see "LLM call structure" below)
9. Validate JSON output schema; on failure → ABORT compaction (do not destroy data)
10. PHASE 1 — Append old non-pinned events to <uuid>.archive.jsonl (append-only,
    fsync). On fail → ABORT.
11. PHASE 2 — Upsert profile_updates into customer-profiles.db. On fail → ABORT
    (archive already has copy, retry next sweep).
12. PHASE 3 — Build new session jsonl:
    [0] session metadata event (preserved)
    [1] PINNED CONTEXT message (system role, structured profile dump from DB)
    [2] SUMMARY message (system role, conversation_summary from LLM)
    [3..] all critical pinned messages in original order
    [N..] last 20 message events verbatim
13. PHASE 4 — Atomic rewrite: write to <uuid>.jsonl.tmp, fsync, rename.
14. PHASE 5 — Append entry to logs/compaction.jsonl (audit).
15. Release lock.
```

**Race condition handling:**
- Gateway writes new event between snapshot read and rewrite → after acquiring lock, re-read file size; if grown, append the delta to "last 20 verbatim" before writing.
- Background sweep + JIT race on same file → exclusive lock; JIT wins (user is waiting), background skips to next sweep.
- Lock orphaned by crashed process → lock file contains PID, check `process.kill(pid, 0)`, steal if dead.

### LLM call structure

Single call with structured JSON output:

```
Model: gpt-5-mini (via 9router)
Timeout: 10s
response_format: { type: "json_object" }

System prompt:
  "Bạn là tóm tắt hội thoại CSKH cho bot AI tiếng Việt. Nhiệm vụ:
   1. Tóm tắt nội dung hội thoại thành 1 đoạn 100-200 từ giữ narrative flow
   2. Trích xuất facts có cấu trúc cho từng user xuất hiện trong hội thoại
   QUAN TRỌNG:
   - KHÔNG bịa thông tin không có trong hội thoại
   - Số tiền, ngày tháng, tên riêng phải copy CHÍNH XÁC từ tin nhắn gốc
   - Output JSON object duy nhất, không thêm text ngoài JSON
   Schema: { conversation_summary: string, profile_updates: { [user_id]: {...} } }"

User content (formatted):
  [2026-04-05 14:30 user:zalo_uid_123]: tôi muốn hỏi giá product A
  [2026-04-05 14:31 bot]: dạ giá product A là 5,000,000đ ạ
  [2026-04-05 14:32 user:zalo_uid_123]: ok chốt 1 cái, giao thứ 3 nhé
  ...
```

**Group chat extraction (per-sender, 2-pass):**
For group conversations with multiple senders, run extraction once per active sender (top 5 by message count in window):

```
Pass N: same prompt but constrained:
  "CHỈ trích xuất facts cho user_id={specific_id}, bỏ qua tin của user khác.
   Vẫn output conversation_summary chung."
```

Avoids 1-shot misattribution. Cost: 5x for groups, acceptable since group profile extraction is the highest-stakes accuracy case.

### Profile_updates JSON schema

```json
{
  "conversation_summary": "Khách Mai hỏi giá product A, được báo 5tr, đã chốt đơn, hẹn giao thứ 3. Sau đó hỏi thêm product B, chưa quyết.",
  "profile_updates": {
    "zalo_uid_123": {
      "display_name": "Mai",
      "personality_traits": ["thẳng thắn", "quyết đoán nhanh"],
      "preferences_added": ["thích product A"],
      "preferences_removed": [],
      "decisions_added": [
        {
          "date": "2026-04-05",
          "action": "đặt",
          "item": "product A",
          "price_vnd": 5000000,
          "delivery_date": "thứ 3 tuần sau",
          "status": "confirmed",
          "source_msg_id": "<msg_uuid>"
        }
      ],
      "open_loops_added": [
        {
          "date": "2026-04-05",
          "what": "Báo giá product B",
          "deadline": null
        }
      ],
      "open_loops_resolved": [],
      "key_facts_added": []
    }
  }
}
```

**Merge semantics in DB:** `_added` arrays append to existing rows; `_removed` and `_resolved` arrays mark existing rows as `status='removed'` or `status='resolved'` (soft delete with timestamp, never hard-delete for audit).

### Failure modes

| Failure | Action |
|---|---|
| LLM 9router unreachable | Skip compaction this round. JIT safety net at 90% retries. Repeated failures over 30 min → Telegram notify admin "LLM unavailable, conversation X near limit". |
| LLM returns invalid JSON | Skip compaction. Log to audit with `status: "invalid_json"`. Retry next sweep. |
| LLM returns valid JSON but factually wrong (cannot detect automatically) | Mitigated by Pivot 1 (originals in archive) + Pivot 2 (facts in structured DB, not summary). Admin can spot-check via `compaction.jsonl` audit log which contains full summary text. |
| Archive append fails (disk full, permission) | ABORT before touching live jsonl. Telegram notify admin. |
| Profile DB upsert fails | ABORT. Archive has copy. Retry next sweep. |
| Atomic rewrite fails after rename | Live jsonl is in inconsistent state: re-acquire lock, restore from `<uuid>.jsonl.tmp` if exists, else reconstruct from archive. |

## Component 2: CustomerMemoryService

### Database schema

`~/.openclaw/workspace/customer-profiles.db` (SQLite via better-sqlite3):

```sql
CREATE TABLE customer_profile (
  channel TEXT NOT NULL,            -- 'telegram' | 'zalo'
  user_id TEXT NOT NULL,            -- channel-native user id
  display_name TEXT,                -- human-readable, nullable
  first_seen_at INTEGER NOT NULL,   -- ms epoch
  last_seen_at INTEGER NOT NULL,
  message_count INTEGER DEFAULT 0,
  is_vip INTEGER DEFAULT 0,         -- manual flag, also auto-set when msg_count > 200
  personality_summary TEXT,         -- 1-2 sentences from latest compaction
  last_profile_update_at INTEGER,
  schema_version INTEGER DEFAULT 1,
  PRIMARY KEY (channel, user_id)
);

CREATE TABLE customer_preference (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  user_id TEXT NOT NULL,
  preference TEXT NOT NULL,         -- e.g. "thích sản phẩm A"
  status TEXT DEFAULT 'active',     -- 'active' | 'removed'
  added_at INTEGER NOT NULL,
  removed_at INTEGER,
  source_session_id TEXT,
  FOREIGN KEY (channel, user_id) REFERENCES customer_profile(channel, user_id)
);

CREATE TABLE customer_decision (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,               -- ISO date string
  action TEXT NOT NULL,             -- 'đặt' | 'hủy' | 'đổi' | 'hẹn' | 'mua' | ...
  item TEXT,
  price_vnd INTEGER,
  delivery_date TEXT,
  status TEXT DEFAULT 'confirmed',  -- 'confirmed' | 'cancelled' | 'fulfilled'
  source_session_id TEXT,
  source_msg_id TEXT,               -- pointer into archive jsonl
  raw_json TEXT,                    -- full LLM output for this decision
  added_at INTEGER NOT NULL,
  FOREIGN KEY (channel, user_id) REFERENCES customer_profile(channel, user_id)
);

CREATE TABLE customer_open_loop (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  user_id TEXT NOT NULL,
  what TEXT NOT NULL,               -- "Báo giá product B"
  deadline TEXT,                    -- ISO date or relative description
  status TEXT DEFAULT 'open',       -- 'open' | 'resolved'
  added_at INTEGER NOT NULL,
  resolved_at INTEGER,
  source_session_id TEXT,
  FOREIGN KEY (channel, user_id) REFERENCES customer_profile(channel, user_id)
);

CREATE TABLE customer_key_fact (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  user_id TEXT NOT NULL,
  fact TEXT NOT NULL,               -- "sinh năm 1985", "ở quận 7"
  added_at INTEGER NOT NULL,
  source_session_id TEXT,
  FOREIGN KEY (channel, user_id) REFERENCES customer_profile(channel, user_id)
);

CREATE INDEX idx_profile_last_seen ON customer_profile(last_seen_at DESC);
CREATE INDEX idx_decision_user ON customer_decision(channel, user_id, added_at DESC);
CREATE INDEX idx_open_loop_user ON customer_open_loop(channel, user_id, status);
CREATE INDEX idx_preference_user ON customer_preference(channel, user_id, status);
```

### Pinned context writer

Whenever profile DB updates for a user, MODOROClaw rewrites slot 1 of every active session jsonl belonging to that user (DM and groups they're in) with a fresh structured dump:

```
[HỒ SƠ KHÁCH HÀNG - cập nhật 2026-04-08 15:30]
Tên: Mai
Tính cách: thẳng thắn, quyết đoán nhanh
Sở thích: thích product A, không ăn cay, ưu tiên giao nhanh
Quyết định gần nhất:
  - 2026-04-05: ĐẶT product A, giá 5,000,000đ, hẹn giao thứ 3 tuần sau (đã xác nhận)
  - 2026-04-03: HỎI product B, chưa quyết
Đang chờ bạn:
  - Báo giá product B (khách hỏi 2026-04-05 14:30)
  - Xác nhận địa chỉ giao
Thông tin khác:
  - Sinh năm 1985
  - Ở quận 7 TP HCM
  - Quản lý công ty 50 nhân viên
LƯU Ý: KHÔNG đề xuất sản phẩm cay (đã từ chối 2 lần trước)
```

This is the message bot reads on EVERY reply. Source of truth for all answers about this customer.

### IPC API (preload bridge)

```js
// Read
window.modoroclaw.profile.list({ channel, search, limit, offset })
window.modoroclaw.profile.get({ channel, user_id })
  → returns { profile, preferences, decisions, open_loops, key_facts, recent_sessions }
window.modoroclaw.profile.refreshFromHistory({ channel, user_id })
  → re-extract from archive jsonl (manual recompute button)

// Write
window.modoroclaw.profile.setVip({ channel, user_id, is_vip })

// Export
window.modoroclaw.export.full() → returns saved zip path
window.modoroclaw.export.customer({ channel, user_id }) → returns saved zip path
window.modoroclaw.export.profilesCsv() → returns saved csv path
window.modoroclaw.export.copyProfileText({ channel, user_id }) → clipboard

// Restore
window.modoroclaw.restore.fromZip({ zipPath, mode: 'overwrite' | 'merge' })

// Backup management
window.modoroclaw.backup.list() → returns array of {file, size, date}
window.modoroclaw.backup.runNow() → trigger immediate backup
window.modoroclaw.backup.setSchedule({ enabled, time, keepDays })
```

## Component 3: Dashboard UI

### Existing tabs (Telegram, Zalo) — minimal additions

Each existing user list row gets a click handler. Click → side panel slides in from right (~480px wide), backdrop dimmed, click backdrop or Esc to close.

**Side panel layout (no emojis — premium aesthetic per founder rule):**

```
┌────────────────────────────────────────┐
│ <  Mai                  Zalo cá nhân   │
│                                        │
│    Khách VIP            [  ON  ]       │
│                                        │
│ ─── Tóm tắt ───                        │
│ Khách thẳng thắn, quyết định nhanh,    │
│ ưu tiên giao gấp. Đã mua product A.    │
│                                        │
│ ─── Quyết định gần đây ───             │
│ 2026-04-05   Đặt product A 5tr         │
│              Hẹn giao thứ 3 — đã xác   │
│              nhận                       │
│ 2026-04-03   Hỏi product B, chưa quyết │
│                                        │
│ ─── Đang chờ bạn ───                    │
│ Báo giá product B           3 ngày     │
│ Xác nhận địa chỉ giao        chưa rõ   │
│                                        │
│ ─── Sở thích ───                       │
│ Có      thích product A                │
│ Không   không ăn cay                   │
│ Ưu tiên giao nhanh                     │
│                                        │
│ ─── Thông tin khác ───                 │
│ Sinh năm 1985                          │
│ Quận 7 TP HCM                          │
│ Quản lý công ty 50 nhân viên           │
│                                        │
│ ─── Thao tác ───                        │
│ [Cập nhật từ lịch sử]                   │
│ [Xuất hồ sơ này]                        │
│ [Sao chép dạng text]                    │
│                                        │
│ Cập nhật lần cuối: 5 phút trước        │
│ Tổng tin nhắn: 247                     │
│ Lần đầu nói chuyện: 2026-02-15         │
└────────────────────────────────────────┘
```

UI implementation MUST NOT introduce emojis. Use weight, color, and spacing for visual hierarchy. Buttons use text-only labels with subtle border + hover state (Linear/Stripe aesthetic).

### New sidebar tab: "Sao lưu & Xuất dữ liệu"

```
┌─────────────────────────────────────┐
│  Sao lưu & Xuất dữ liệu              │
│                                      │
│  ── Sao lưu tự động ──               │
│  [✓] Bật sao lưu hàng ngày          │
│  Giờ chạy: 03:00                    │
│  Giữ 7 backup gần nhất               │
│  Lưu vào: ~/.openclaw/.../backups   │
│  [Đổi thư mục lưu]                  │
│                                      │
│  Lần backup gần nhất: hôm nay 03:00 │
│  Kích thước: 12.4 MB                │
│                                      │
│  ── Sao lưu thủ công ──             │
│  [Sao lưu toàn bộ ngay bây giờ]     │
│                                      │
│  ── Xuất dữ liệu ──                 │
│  [Xuất profiles ra Excel (.csv)]    │
│                                      │
│  ── Khôi phục ──                    │
│  [Chọn file backup .zip để khôi phục]│
│  ⚠ Khôi phục sẽ ghi đè dữ liệu       │
│    hiện tại                          │
│                                      │
│  ── Lịch sử backup ──                │
│  • auto-2026-04-08.zip  12.4 MB     │
│  • auto-2026-04-07.zip  12.1 MB     │
│  • auto-2026-04-06.zip  11.8 MB     │
│  ... (4 more)                        │
│                                      │
└─────────────────────────────────────┘
```

## Component 4: Export & Backup

### Auto-backup

- Cron `0 3 * * *` (03:00 daily, default ON)
- Output: `~/.openclaw/workspace/backups/auto-YYYY-MM-DD.zip`
- Contents: see "Full backup zip structure" below
- Rotation: keep newest 7, delete older
- User can disable, change time, change folder, change retention count

### Full backup zip structure

```
modoroclaw-backup-YYYY-MM-DD.zip
├── meta.json                          (schema version, MODOROClaw version, ts)
├── customer-profiles.db                (full SQLite copy)
├── sessions/
│   ├── <uuid1>.jsonl                   (live compacted)
│   ├── <uuid1>.archive.jsonl           (full history)
│   ├── <uuid2>.jsonl
│   ├── <uuid2>.archive.jsonl
│   └── ...
├── compaction.jsonl                    (audit log)
└── workspace-snapshot/                 (optional, AGENTS.md, schedules.json, etc.)
```

### Per-customer export zip

```
zalo-uid_123-2026-04-08.zip
├── profile.md                          (human-readable)
├── profile.json                        (machine-readable, all DB rows)
├── conversations/
│   ├── dm.jsonl                        (full archive of DM)
│   ├── group_<gid>.jsonl                (full archive of group, filtered to this user only)
│   └── ...
└── compactions.jsonl                   (audit entries for this user)
```

### CSV export

Single file `customer-profiles-YYYY-MM-DD.csv` with flat columns:

```
channel, user_id, display_name, first_seen, last_seen, msg_count, is_vip,
personality, top_3_preferences, last_decision, last_decision_date,
open_loops_count, key_facts, last_active_minutes_ago
```

### Restore

```
1. User picks .zip file
2. Confirm dialog: "Khôi phục sẽ ghi đè ... bạn có chắc?"
3. Validate meta.json schema_version
   - same version → proceed
   - older → run migration scripts in scripts/migrations/
   - newer → reject "Backup từ MODOROClaw mới hơn, cập nhật app trước"
4. Stop background sweep
5. Backup current state to backups/pre-restore-<ts>.zip (safety)
6. Replace customer-profiles.db (atomic copy)
7. Replace sessions/ directory (atomic move + replace)
8. Replace compaction.jsonl
9. Restart background sweep
10. Notify "Khôi phục thành công"
```

## Data flow: end-to-end customer reply

```
1. Customer sends Zalo message → openzca listener → openclaw gateway
2. Gateway loads session jsonl
3. [HOOK if implemented] MODOROClaw checks session size:
   - if ≥ 90% budget → run compaction synchronously (~2-4s)
   - else proceed
4. Gateway reads jsonl:
   slot[0] = session metadata
   slot[1] = pinned context (current customer profile dump)
   slot[2] = LLM-generated narrative summary
   slot[3..N-20] = critical pinned messages
   slot[N-20..N] = recent 20 messages verbatim
5. Gateway sends full context to LLM (gpt-5 via 9router)
6. LLM has facts (slot 1) + narrative (slot 2) + recent (slot N-20..N)
7. LLM replies; gateway delivers to customer via openzca
8. New events appended to jsonl (customer msg + bot reply)

[Background, every 2 min]
9. Sweep runs, finds session at 65% → compact it
10. Old non-pinned events → archive jsonl
11. LLM call extracts summary + profile updates
12. Profile DB upsert
13. Pinned context (slot 1) regenerated for ALL sessions of this user
14. Live jsonl rewritten
15. Audit logged
```

## Error handling matrix

| Failure | Layer | Customer impact | Admin notification | Recovery |
|---|---|---|---|---|
| LLM 9router 1 call fail | Compactor | None (background) | None | Retry next sweep |
| LLM 9router persistent fail (>30 min) | Compactor | None until burst | Telegram notify | Manual fix 9router |
| Customer hits 100% budget while LLM down | JIT | Bot pauses 1 reply | Telegram notify | Pause until LLM back |
| Profile DB locked | CustomerMemory | None | None | Retry next sweep |
| Archive append fails (disk full) | Compactor | None | Telegram notify URGENT | Free disk space |
| Atomic rewrite fails mid-rename | Compactor | Maybe 1 lost event | Audit log warning | Auto-restore from .tmp |
| Wrong profile extracted by LLM | CustomerMemory | Bot replies subtly off | Visible in compaction.jsonl | Admin clicks "Refresh from history" in UI |
| Customer disputes "you said X" | N/A | Trust issue | Manual | Read archive jsonl, has full original |
| Disk total failure | All | Service down | N/A | Restore from auto-backup zip |

## Testing strategy

### Unit tests

- `tokenEstimate(text)` → `chars / 3.5`, returns integer
- `detectCriticalMessages(events)` → boolean per event, regex coverage tests
- `splitOldAndRecent(events, recentCount)` → tuple
- `buildPinnedContextText(profile)` → matches snapshot
- `validateLLMOutputSchema(json)` → throws on bad input
- `mergeProfileUpdates(existing, updates)` → idempotent, preserves history

### Integration tests

- End-to-end compact: feed fixture jsonl → assert: archive grows, db upserts, live jsonl shrinks, slot 1 has pinned, audit logged
- Compact with critical messages → assert pinned messages preserved verbatim
- Compact with LLM mock returning invalid JSON → assert no destructive action
- Compact with archive append failure → assert live jsonl untouched
- Group chat compact → 2-pass extraction → assert per-sender attribution correct
- Race: gateway writes during compaction → assert no event lost
- Backup/restore round-trip → assert DB + sessions byte-equal after restore

### Manual QA scenarios (smoke test)

1. Send 50 messages to bot in DM → verify compaction fires (background sweep) → verify reply quality unchanged → verify archive.jsonl exists → verify audit log entry
2. Click customer in Dashboard → verify side panel opens with extracted profile → verify decisions match what was actually said
3. Toggle VIP → verify budget bumps → verify subsequent compactions use 80k threshold
4. Pull network cable → verify compaction skips silently → verify reply still works (bot just doesn't compact)
5. Send burst of 30 messages in 30 sec → verify JIT safety net fires before overflow → verify customer didn't see anything weird (only "đang nhập…" lasted ~3s longer)
6. Trigger manual backup → verify zip created → wipe DB → restore from zip → verify all profiles back
7. Edit a customer's reply data via direct SQL → click "Refresh from history" in UI → verify profile re-extracted from archive
8. Critical message test: send "tôi muốn đặt 5 cái product A giá 25 triệu giao ngày 12/4" → trigger compaction → verify message is pinned (still in slot 3+ verbatim, not summarized away)

## Phase 0: research spike (BLOCKING — must complete before Phase 1)

These two questions have load-bearing impact on the architecture and must be answered before any implementation work begins. Each spike is timeboxed to half a day.

### Spike A: JIT safety net hook point

**Question:** How can MODOROClaw intercept an inbound message before the openclaw gateway loads the session jsonl into LLM context?

**Investigation steps:**
1. Read `~/AppData/Roaming/npm/node_modules/openclaw/dist/server-*.js` for any `pre-message`, `before-llm`, plugin lifecycle, or webhook hooks.
2. Inspect openzca/openzalo plugin source for inbound message flow — find the line where it relays to gateway.
3. Check if openclaw config has any `webhooks` or `interceptors` field in JSON schema.

**Three candidate strategies (pick one based on findings):**

| Strategy | Pros | Cons | When to choose |
|---|---|---|---|
| **A1. Patch openzalo/openzca plugins** to call MODOROClaw IPC before relaying | Reliable, no race | Must re-patch on every plugin update (already a pattern in this repo) | Default if no native hook |
| **A2. File watcher on session jsonl** + sync compaction at 90% | No plugin patches | Race window, may miss bursts | Fallback if plugin patch infeasible |
| **A3. Pure background sweep, no JIT** | Simplest | Burst overflow risk acceptable IF sweep interval drops to 30s | Acceptable if 30s sweep + 50% sweep target catches 99.9% of cases |

**Resolution criterion:** Pick A1 if plugin source has a clean injection point (single function entry for inbound). Pick A3 (no JIT) if A1 cost > 1 day. A2 is forbidden — race conditions with file watcher on append-only jsonl are undebuggable.

**Default if spike inconclusive:** A3 with sweep interval reduced to `*/30 seconds` and sweep target reduced to 50% budget. Acceptable v1 risk profile; revisit in v2.

### Spike B: Group chat session jsonl structure

**Question:** Does openclaw create one jsonl per Zalo/Telegram group (shared by all members), or one per (group, sender) pair?

**Investigation steps:**
1. Add bot to a test Zalo group with 3+ members. Each member sends 1 message.
2. Inspect `~/.openclaw/agents/main/sessions/` — count new jsonl files created.
3. Inspect each jsonl: do they have multiple sender_ids in `message.origin`, or single sender?

**Two outcomes:**

| Outcome | Architectural impact |
|---|---|
| **B1. One jsonl per group (shared)** | Pinned context slot 1 cannot be per-user. Replace with **multi-user pinned block** containing top 5 active senders' profiles, refreshed when any of their profiles update. Compaction's per-sender 2-pass extraction unchanged. |
| **B2. One jsonl per (group, sender)** | Original design works as-specified. Pinned context per-user. Storage cost: 50-member group = 50 jsonl files. |

**Resolution criterion:** No choice — whichever openclaw does is what we must support. Spike just confirms which branch of the design to implement.

### Spike C: openclaw file watcher behavior on session jsonl rewrites

**Question:** Does openclaw's gateway file-watcher (the same one that triggered `Gateway is restarting` bugs in CLAUDE.md) treat session jsonl rewrites as "external writes" worth restarting for?

**Background:** CLAUDE.md documents two prior incidents where in-place file rewrites of `openclaw.json` caused gateway restarts mid-reply. The fix was the byte-equal helper + removing CLI subprocess writes. Session jsonls are watched by a different mechanism (gateway tails them for new events) but the risk pattern is similar.

**Investigation steps:**
1. Read openclaw dist for `chokidar`, `watchFile`, `fs.watch` references applied to `agents/main/sessions/`.
2. Test: manually rewrite a live session jsonl while gateway is running, observe gateway logs for restart events.

**Three outcomes + fallbacks:**

| Outcome | Mitigation |
|---|---|
| **C1. Gateway only appends, never re-reads jsonl mid-session** (cached in memory) | Compaction must NOT happen mid-session. Wait for session idle (no new events for >60s) before compacting. Pinned context updates only apply on next session load. |
| **C2. Gateway re-reads jsonl on watcher fire, no restart** | Original design works. |
| **C3. Gateway treats rewrite as restart trigger** (worst case) | Same as C1 — rewrites only when session idle, plus quiesce gateway briefly via existing IPC. |

**Default if spike inconclusive:** Assume C1 (most conservative). Defer all in-place rewrites to idle windows. Define "idle" as no new events for >60 seconds. JIT becomes "compact only after this customer's reply is delivered, before their next message".

---

## Other resolved questions

1. **better-sqlite3 ABI** — already pinned in `electron/package.json` for Knowledge tab. Open separate DB connection for `customer-profiles.db` (decouples failure domains from Knowledge tab DB).

2. **Schema migration framework** — none exists yet in MODOROClaw. Build minimal one for `customer-profiles.db`: files `electron/migrations/customer-profiles/001_init.sql`, `002_*.sql`, etc., applied in order on app boot. Track applied versions in a `schema_meta(version INTEGER, applied_at INTEGER)` table inside the same DB.

3. **Token estimate accuracy** — Vietnamese with diacritics tokenizes at roughly **2.5 chars per token** (cl100k tokenizer empirical estimate, conservative). Use `chars / 2.5` as starting ratio. After 1 week of production data, sample 10 real conversations, run tiktoken on the text, recalibrate. Sweep target 60% gives buffer against estimation drift.

4. **Foreign keys** — composite FKs in child tables require `PRAGMA foreign_keys = ON` and parent UNIQUE index, both supported in SQLite. Migration script must enable the pragma per-connection (not persistent). Alternative: drop FKs entirely since the app upserts profile before children. **Decision: drop FKs**, rely on app-level invariant (always upsert profile first). Simpler, no per-connection pragma, no migration footgun.

5. **Backup cron infrastructure** — REUSE existing MODOROClaw `startCronJobs()` infrastructure in `electron/main.js`. Add backup job to the existing `node-cron` instance, not a new one. Job key: `modoroclaw-auto-backup`. Configurable via Settings tab.

6. **Fallback model JSON output handling** — gpt-5-mini supports `response_format: { type: "json_object" }`. Fallback models (Claude, Gemini, Ollama) may not all support it. Strategy:
   - Detect provider from 9router response metadata
   - If provider supports `json_object` → use it
   - Else → embed strict JSON instructions in prompt + parse defensively + retry once with stricter system message on parse fail
   - If retry also fails → ABORT compaction (do not destroy data), log to audit, retry next sweep

7. **Pinned context writer debounce** — to prevent gateway churn from chatty VIPs, coalesce profile-update-triggered rewrites. Implementation:
   - When profile DB upsert fires, mark affected sessions as `needs_pinned_refresh = true` in an in-memory set
   - Background sweeper picks up these flags and rewrites pinned context **at most once per 60 seconds per session**
   - Compaction always rewrites pinned context as part of its own write (no extra IO)

8. **Restore must quiesce gateway** — Restore step 4 must be: `(4a) stop background sweep` AND `(4b) stop openclaw gateway via existing IPC` AND `(4c) wait for gateway exit`. Restore step 11 (after restart sweep) becomes `(11a) restart openclaw gateway` AND `(11b) restart background sweep`. Restore IS a destructive operation — gateway downtime for ~10s during restore is acceptable.

9. **Concurrency model** — at most **1 compaction in flight globally** (single-process semaphore). LLM call is the bottleneck (~2s per call); parallelizing would burn quota faster without latency benefit. Background sweeper enqueues, JIT preempts queue head. Locking is therefore really just queue ordering, not multi-writer protection.

10. **Audit log schema** (`logs/compaction.jsonl`) — one JSON object per line:
    ```json
    {
      "ts": "2026-04-08T15:30:42.123Z",
      "session_id": "<uuid>",
      "channel": "openzalo",
      "user_ids": ["zalo_uid_123", "zalo_uid_456"],
      "trigger": "background" | "jit" | "manual",
      "status": "success" | "skipped" | "aborted" | "invalid_json" | "llm_unavailable",
      "before": { "events": 143, "tokens_est": 29800, "bytes": 102340 },
      "after": { "events": 27, "tokens_est": 6200, "bytes": 21800 },
      "pinned_count": 7,
      "summary_text": "<full conversation_summary from LLM>",
      "profile_updates": { ...full JSON output from LLM... },
      "model_used": "gpt-5-mini",
      "fallback_used": false,
      "duration_ms": 1842
    }
    ```

11. **Critical message regex tightening:**
    - Money: `(?:^|[\s,.])(\d+(?:[.,]\d{3})*)\s*(đ|đồng|VND|vnd|tr|triệu|m|M|k|nghìn|ngàn)(?:$|[\s,.])` (handles "5tr", "25m", "5.000.000đ", "5,000 vnd")
    - Decisions: tighten to phrase-level: `(ok\s+(chốt|lấy|đặt|được))|(chốt\s+(đơn|lấy|đặt))|(đặt\s+\d)|(hủy\s+(đơn|lấy))|(đổi\s+(sang|qua|lấy))|(hẹn\s+(thứ|ngày|giờ))|(cam\s+kết)` — single-word "ok" and "được" produce false positives in every Vietnamese chat. Phrase patterns are rarer and high-signal.
    - Dates: unchanged (already specific enough)
    - Open questions: unchanged (heuristic, accept some over-pinning as the safe direction)
    - **Failure mode:** over-pinning is acceptable (just means verbatim block grows); under-pinning is the dangerous direction. When in doubt, regex should over-include.

## Out of scope (v2+)

- Manual edit of profile fields in UI (currently read-only + refresh button)
- Cross-channel profile linking (Tel + Zalo same person)
- Smart token counting via real tokenizer
- Encrypted backup zip (password protected)
- Paid tier gating (free / Memory Pro add-on)
- Dashboard analytics tab for compaction stats
- Auto-detect customer language and switch summary prompt
- LLM-based critical message detection (currently regex-only)
- Profile-based bot response style adaptation ("khách thích ngắn gọn → bot reply ngắn")
- Slack/Discord webhooks for important customer events
- Search profiles by content ("find all customers who mentioned product B")
- Customer tagging system

## Success criteria

**Customer-facing (must hold):**
1. Zero "context overflow" errors in production over 30 days of normal use
2. Zero customer reports "bot quên / nói sai giá / nói sai quyết định"
3. Compaction events completely invisible to customer (no reply latency spike > 2s except during JIT, hidden by typing indicator)

**Admin-facing:**
4. Admin can find any customer's profile in Dashboard within 10 seconds of opening app
5. Backup auto-creates daily; restore round-trip works on a fresh machine
6. Every important fact (price, date, decision) extracted into structured DB and visible in side panel

**Internal proxy metrics (since #2 relies on customer self-reporting, these are the testable substitutes):**
7. `compaction.jsonl` entries with `status` in `("invalid_json", "aborted", "llm_unavailable")` count < 1% of total entries over 30 days
8. Heuristic-only fallback (no LLM) never triggers — OR when it does, admin gets Telegram notification within 5 minutes
9. Zero `compaction.jsonl` entries where `before.events - after.events != archived_count` (data conservation invariant)
10. For 10 randomly sampled compactions per week, manual spot-check confirms summary text matches archive ground truth (no fabricated facts)
