# Customer Reports

Tracking customer-reported issues. Each entry: date, symptom, root cause, fix, status.

---

## 2026-05-22 — Skill creation broken ("ai cũng báo là đang lỗi hết")

**Reporter:** Multiple customers
**Symptom:** CEO tries to create custom skill via Telegram chat → bot doesn't know how / returns 403 error
**Root cause (2 bugs):**
1. Missing trigger in AGENTS.md Capability Router table — "tạo skill" keywords not routed to skill-builder.md
2. Explicit `headers` in skill-builder.md web_fetch calls may override auto-injected auth → 403
**Fix:** Added skill_builder trigger row to Router + removed explicit headers from 6 POST calls
**Status:** Fixed in v2.4.6 build, pending ship

---

## 2026-05-22 — Zalo "Tắt tất cả" button enables all instead of disabling

**Reporter:** CEO (internal)
**Symptom:** Pressing "Tắt tất cả" in Zalo friends list enables all DMs instead of blocking all
**Root cause:** `toggleAllFriends(false)` set `userAllowlist = []`. inbound.ts treats empty allowlist as "allow ALL" (backwards compat). Empty array = no filter = everyone gets through.
**Fix:** Changed to `userAllowlist = ['__NONE__']` sentinel — non-empty array, no real ID matches, deny-all behavior.
**Status:** Fixed in v2.4.7 build, pending ship

---

## 2026-05-22 — Zalo mode turned ON but bot not responding in groups

**Reporter:** Customer
**Symptom:** Customer turned on Zalo bot mode in Dashboard, but bot does not respond to group messages
**Root cause:** `zalo-group-settings.json` defaults to `__default: { mode: 'off' }`. Groups NOT explicitly in the file are silently dropped (inbound.ts line 985-989). Customer enabled the main toggle but didn't know they need to enable groups separately.
**Fix:** Auto-prompt when enabling Zalo with 0 active groups: "Bật bot cho tất cả N nhóm (chế độ @mention)?" — Yes = `setAllGroupsMode('mention')`. Added to `onZaloEnabledToggle()` in dashboard.html.
**Status:** Fixed in v2.4.7, pending rebuild

---

## 2026-05-22 — Bot leaks internal /approve command to Zalo customer (CRITICAL)

**Reporter:** CEO (observed in live Zalo conversation)
**Symptom:** When customer asks about product, bot replies "Anh duyệt giúp em lệnh này để em đọc đúng tài liệu" and shows `/approve 271048e7 allow-once` with PowerShell `Get-Content` command to read `skills/operations/zalo.md` and `knowledge/san-pham/index.md`. Customer sees internal file paths and approval mechanism.
**Root cause:** Bot uses `exec` tool (PowerShell Get-Content) to read 2 files in one call instead of `read_file`. `exec` requires approval → approval prompt goes to current channel (Zalo customer) instead of CEO. Zalo customer sees `/approve` command + internal file paths.
**Fix (2-layer):**
1. AGENTS.md rule: "CẤM TUYỆT ĐỐI khi đang trả lời Zalo: Bot KHÔNG ĐƯỢC dùng exec tool. Dùng read_file."
2. Output filter Layer L: 4 new patterns catch `/approve`, `allow-once`, `Get-Content`, "duyệt giúp em" — blocked before reaching customer.
**Status:** Fixed in v2.4.7, pending rebuild

---

## 2026-05-22 — Bot cannot summarize today's Zalo conversations (CRITICAL UX)

**Reporter:** CEO (Peter Bui) testing live
**Symptom:** CEO asks "hôm nay em đã nhắn zalo với ai" and "tóm tắt zalo cho anh". Bot replies "chưa thấy phát sinh cuộc nhắn Zalo" despite real Zalo activity today.
**Root cause:** `extractConversationHistory()` in conversation.js can't identify which messages are Zalo vs Telegram. Session JSONL files have no `event.origin` field. Fallback parsing looks for `From:` / `Channel:` format but actual metadata is JSON blocks. All messages get `channel: 'unknown'` → when filtering for `channels: ['modoro-zalo']`, nothing matches → "no Zalo messages found".
**Fix:** Added sender ID format detection in conversation.js: parse `"sender_id": "XXXX"` from metadata JSON blocks. Zalo IDs are 16-19 digits, Telegram IDs are 8-12 digits (per AGENTS.md). Also extracts sender name from `"sender": "..."` pattern. Channel detection now works without needing `event.origin`.
**Status:** Fixed in v2.4.7, pending rebuild

---

## 2026-05-22 — Knowledge visibility bypass via read_file (SECURITY)

**Reporter:** Internal security audit
**Symptom:** Documents marked "Nội bộ" or "Chỉ mình tôi" in Knowledge tab are still accessible to Zalo customers if the bot is tricked into using `read_file` or `list_files` tools directly — bypassing the RAG search visibility filter.
**Root cause:** The 3-tier visibility system (public/internal/private) only enforces at the RAG search API level (`searchKnowledge({ audience })`). The bot's native `read_file`/`list_files` tools read directly from disk, never touching the DB visibility column.
**Fix (3-layer defense-in-depth):**
1. Code: `<file-access-policy>` block injected into inbound.ts rawBody — instructs AI to not use read_file for sensitive paths when serving Zalo
2. API: `/api/file/read` adds sensitive path blocklist + DB visibility check for knowledge files
3. AGENTS.md v105: Updated Zalo rule — use `<kb-doc>` only, CẤM read_file for knowledge/memory/logs
**Status:** Implemented, pending rebuild

---

## 2026-05-23 — Cron "Config invalid" channels.telegram additional properties

**Reporter:** Customer (Tro Ly TC bot)
**Symptom:** All cron jobs fail with "channels.telegram: invalid config: must NOT have additional properties". 3 retries exhausted.
**Root cause:** `set-inbound-debounce` IPC wrote `channels.telegram.messages.inbound.debounceMs` — `messages` not in openclaw Telegram schema. Pre-spawn healer only runs static cleanup (no stderr), misses dynamic fields on first attempt.
**Fix:** (1) Remove per-channel debounce writes, use global `config.messages.inbound.debounceMs` only. (2) Add `messages` to Telegram legacy key cleanup. (3) For v2.5.0: pre-spawn `--version` probe to catch config errors before first cron attempt.
**Status:** Fix applied in v2.4.8, not yet shipped

---

## 2026-05-23 — Cron "spawn ENAMETOOLONG" on Windows

**Reporter:** Customer (IT_Bot)
**Symptom:** Cron weekly-report fails with exit code -1, "spawn ENAMETOOLONG". Retried 3 times, same error each time.
**Root cause:** Weekly report prompt grows to 30-50KB+ (7 days summaries + history + memory). Passed via `--message` CLI arg → Windows CreateProcess 32KB limit exceeded. No pre-spawn size check, no file-based fallback.
**Fix:** For v2.5.0: (1) Write prompt to temp file when >20KB, pass `--message-file` instead. (2) Add `ENAMETOOLONG` to `isFatalErr()` to avoid 3 wasteful retries. (3) Cap prompt template substitutions.
**Status:** Fixed in v2.4.8

---

## 2026-05-23 — Cron evening report not delivered to CEO

**Reporter:** Customer (BKE)
**Symptom:** Evening 21:00 cron report fires successfully (agent runs, no errors) but CEO never receives the report on Telegram.
**Root cause (2 failures):**
1. Path 1 (`sessions.send`): `getCeoSessionKey()` constructs `agent:main:telegram:direct:<chatId>` but OpenClaw 2026.4.14 defaults `session.dmScope` to `"main"` → actual session key is `agent:main:main` → session not found → fail silently
2. Path 2 (fallback `--json`): Agent output parsed correctly but only delivered to Zalo targets. Telegram-only crons had no delivery → report lost
**Fix:** (1) `getCeoSessionKey()` reads `session.dmScope` from openclaw.json, returns correct key format. (2) Fallback path calls `sendTelegram(replyText)` when no zaloTarget.
**Status:** Fixed in v2.4.8
