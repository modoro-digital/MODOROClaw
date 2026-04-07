# Session Log — 2026-04-06 ~ 2026-04-07

## Tổng quan

Hai phiên làm việc liên tiếp tập trung vào **testing, audit nội dung, fix lỗi pairing, và xây hệ thống custom cron** cho MODOROClaw.

---

## Phiên 1: 2026-04-06 (Testing + Audit + Fix lỗi)

### 1. Telegram Slash Commands — HOÀN THÀNH

**Vấn đề:** CEO gõ `/` trên Telegram không thấy lệnh nào.

**Giải pháp:** Đăng ký 12 commands qua Telegram Bot API `setMyCommands`:

```javascript
// electron/main.js → registerTelegramCommands() (~line 1032)
const commands = [
  // 5 Custom MODOROClaw
  { command: 'menu', description: 'Xem mẫu giao việc theo ngành' },
  { command: 'baocao', description: 'Tạo báo cáo tổng hợp ngay lập tức' },
  { command: 'huongdan', description: 'Hướng dẫn cách sử dụng trợ lý' },
  { command: 'skill', description: 'Xem danh sách kỹ năng đã cài' },
  { command: 'thuvien', description: 'Xem thư viện tài liệu đã lưu' },
  // 7 OpenClaw built-in (CEO-friendly, Vietnamese descriptions)
  { command: 'new', description: 'Bắt đầu phiên hội thoại mới' },
  { command: 'reset', description: 'Xóa ngữ cảnh, bắt đầu lại từ đầu' },
  { command: 'status', description: 'Xem trạng thái bot (model, token, chi phí)' },
  { command: 'stop', description: 'Dừng tác vụ đang chạy' },
  { command: 'usage', description: 'Xem chi phí sử dụng AI' },
  { command: 'help', description: 'Xem tất cả lệnh có thể dùng' },
  { command: 'restart', description: 'Khởi động lại trợ lý' },
];
```

**Quyết định:** Chỉ giữ commands mà CEO thực sự cần. Loại bỏ ~26 lệnh OpenClaw nội bộ (model, compact, mcp, doctor, v.v.).

---

### 2. Audit Skill + Industry Files — HOÀN THÀNH

**Vấn đề:** ~86% capabilities trong skill/industry files là **bịa** — hứa hẹn tích hợp POS, CRM, GrabFood, ShopeeFood, Google Maps reviews, banking, Jira/Trello... mà OpenClaw không có khả năng.

**Giải pháp:** Viết lại toàn bộ **16 files** (8 skills + 8 industry) chỉ giữ 5 khả năng THẬT:

1. **Nhắc nhở vận hành** — cron + memory reminders
2. **Trả lời khách Zalo** — AI chat qua Zalo plugin
3. **Soạn nội dung/báo cáo** — text generation
4. **Ghi nhớ/theo dõi** — memory system
5. **Phân tích file CEO gửi** — document library + AI analysis

**Files đã rewrite:**
- `skills/`: tong-quat.md, fnb.md, thuong-mai.md, dich-vu.md, giao-duc.md, cong-nghe.md, san-xuat.md, bat-dong-san.md
- `industry/`: tong-quat.md, fnb.md, thuong-mai.md, dich-vu.md, giao-duc.md, cong-nghe.md, san-xuat.md, bat-dong-san.md
- `skills/active.md` + `industry/active.md` — copied từ fnb.md (ngành hiện tại)

**Cấu trúc industry mới:** 4 sections thay vì fake hourly schedules:
1. "Lịch tự động (Cron → Telegram)"
2. "Khi CEO nhắn tin"
3. "Quy trình xử lý tin nhắn Zalo"
4. "CEO giao việc qua tin nhắn"

---

### 3. Fix lỗi "pairing required" — HOÀN THÀNH (Phiên 1)

**Vấn đề:** Bot agent dùng `openclaw cron add` CLI → gateway yêu cầu pairing → lỗi `gateway closed (1008): pairing required`. User mới cài về sẽ gặp lỗi này ngay.

**Giải pháp ban đầu (Phiên 1):**
- Thêm instruction vào AGENTS.md: "KHÔNG BAO GIỜ sử dụng openclaw cron add"
- Hướng dẫn bot ghi vào memory thay vì tạo cron

**Vấn đề:** Cách này chỉ "ghi nhớ" chứ không tạo cron thật. Không có gì chạy vào đúng giờ.

---

## Phiên 2: 2026-04-07 (Custom Cron System)

### 4. Thiết kế hệ thống Custom Cron — HOÀN THÀNH

**Yêu cầu từ user:**
- CEO nhắn "tạo cronjobs tóm tắt việc đã làm hôm nay vào lúc 11h30 tối" → phải chạy thật
- Vĩnh viễn, không hết hạn (loại bỏ OpenClaw CronCreate tool — chỉ sống 7 ngày)
- Không phụ thuộc OpenClaw CLI (tránh lỗi pairing)
- Hiển thị trên Dashboard

**Quyết định kiến trúc:**

| Phương án | Ưu | Nhược | Chọn? |
|-----------|-----|-------|-------|
| OpenClaw `CronCreate` tool | Built-in, dễ dùng | Hết hạn sau 7 ngày, session-only | ❌ |
| OpenClaw CLI `openclaw cron add` | Built-in | Lỗi pairing cho user mới | ❌ |
| **File-based: bot ghi `custom-crons.json`** | Vĩnh viễn, không phụ thuộc CLI, Dashboard đọc được | Cần file watcher | ✅ |

**Flow hoạt động:**
```
CEO nhắn "tạo cron..."
  → Bot đọc AGENTS.md → biết ghi file
  → Bot đọc custom-crons.json → thêm entry → ghi lại
  → Electron fs.watch phát hiện thay đổi
  → startCronJobs() reload tất cả cron
  → node-cron schedule job mới
  → Đúng giờ → triggerGatewayMessage(prompt) → Bot xử lý → gửi Telegram
  → Dashboard nhận IPC 'custom-crons-updated' → render realtime
```

---

### 5. Implementation: Custom Cron Backend — HOÀN THÀNH

**File: `electron/main.js`**

Thêm trước `startCronJobs()`:
```javascript
// Path: ~/.openclaw/workspace/custom-crons.json
const customCronsPath = path.join(HOME, '.openclaw', 'workspace', 'custom-crons.json');

function loadCustomCrons() { /* đọc file JSON */ }

function watchCustomCrons() {
  // fs.watch trên custom-crons.json
  // Debounce 1 giây → startCronJobs() + push IPC 'custom-crons-updated'
}
```

Trong `startCronJobs()`, sau switch block cho 4 fixed schedules, thêm:
```javascript
// Custom crons (permanent, created by bot)
const customs = loadCustomCrons();
for (const c of customs) {
  if (!c.enabled || !c.cronExpr || !c.prompt) continue;
  cron.schedule(c.cronExpr, async () => {
    const ok = await triggerGatewayMessage(c.prompt);
    if (!ok) await sendTelegram(`⏰ *${c.label}*\n\n${c.prompt}\n\n_(Gateway chưa sẵn sàng)_`);
  }, { timezone: 'Asia/Ho_Chi_Minh' });
}
```

**IPC handlers mới:**
- `get-custom-crons` — trả về array từ file
- `save-custom-crons` — ghi file (Dashboard toggle bật/tắt)

**Gọi `watchCustomCrons()` ở startup** (cùng chỗ `startCronJobs()`).

---

### 6. Implementation: Dashboard hiển thị Custom Crons — HOÀN THÀNH

**File: `electron/preload.js`** — thêm:
```javascript
getCustomCrons: () => ipcRenderer.invoke('get-custom-crons'),
saveCustomCrons: (crons) => ipcRenderer.invoke('save-custom-crons', crons),
onCustomCronsUpdated: (cb) => ipcRenderer.on('custom-crons-updated', (_e, data) => cb(data)),
```

**File: `electron/ui/dashboard.html`** — thêm:

1. **Nút Refresh** trên header "Lịch tự động"
2. **Render custom crons** với icon 🤖 bên dưới fixed schedules
3. **Toggle bật/tắt** cho custom crons (ghi lại file)
4. **Click để xem chi tiết** — modal popup với:
   - Loại (hệ thống / do bot tạo)
   - Lịch chạy (dịch cron → tiếng Việt: "mỗi ngày lúc 23:30")
   - Cron expression gốc
   - Ngày tạo
   - Trạng thái (bật/tắt)
   - Nội dung prompt đầy đủ
   - Nút Xóa (chỉ custom crons)
5. **Real-time update** — Dashboard lắng nghe IPC `custom-crons-updated`, tự render lại

**CSS mới:**
```css
.cron-detail-box { /* modal container */ }
.cron-detail-row { /* label: value layout */ }
.cron-detail-prompt { /* monospace prompt preview */ }
```

**JS functions mới:**
- `cronToTime(expr)` — "30 23 * * *" → "23:30"
- `cronToHuman(expr)` — "30 23 * * *" → "mỗi ngày lúc 23:30"
- `showCronDetail(type, id)` — mở modal chi tiết
- `closeCronDetail()` — đóng modal
- `deleteCustomCron(id)` — xóa custom cron + ghi file
- `toggleCustomCron(id, enabled)` — bật/tắt + ghi file

---

### 7. AGENTS.md — 3 lớp chặn lỗi pairing — HOÀN THÀNH

**Lớp 1: Đầu file AGENTS.md** (đọc đầu tiên mỗi phiên):
```markdown
## CẤM TUYỆT ĐỐI — Đọc trước khi làm bất kỳ điều gì
- KHÔNG dùng `openclaw cron` (add/remove/list) — sẽ lỗi pairing
- KHÔNG hiển thị lỗi kỹ thuật cho CEO
- KHÔNG yêu cầu CEO chạy lệnh terminal
```

**Lớp 2: Mục cron trong AGENTS.md** (hướng dẫn chi tiết ghi file):
```markdown
## Tạo nhắc nhở / cron theo yêu cầu CEO
Ghi vào file `custom-crons.json` trong workspace.
Format: { id, label, cronExpr, prompt, enabled, createdAt }
```

**Lớp 3: .learnings/LEARNINGS.md** (bot đọc mỗi phiên):
- L-001: KHÔNG dùng `openclaw cron add` → ghi file custom-crons.json
- L-002: KHÔNG hiển thị lỗi kỹ thuật cho CEO

**Lớp 4: .learnings/ERRORS.md:**
- ERR-001: gateway closed (1008) pairing required — ghi lại để pattern detection

**Quyết định:** Bài học ship sẵn trong template, khách mới KHÔNG cần gặp lỗi mới học.

---

## Cấu trúc file quan trọng

### Electron App
```
electron/
├── main.js          # Main process: 28 IPC handlers, cron system, document library, gateway management
├── preload.js       # Renderer bridge: ~30 exposed APIs (window.claw.*)
├── ui/
│   ├── dashboard.html  # 3-panel layout: sidebar + main cards + activity log
│   ├── wizard.html     # 6-step setup wizard
│   └── no-openclaw.html
└── package.json     # Dependencies: better-sqlite3, node-cron, pdf-parse, mammoth, xlsx
```

### Workspace (bot đọc/ghi)
```
~/.openclaw/workspace/
├── AGENTS.md            # Master rules (367 lines)
├── IDENTITY.md          # Bot identity
├── USER.md              # CEO profile
├── SOUL.md              # Core philosophy
├── COMPANY.md           # Company info
├── PRODUCTS.md          # Products/services
├── MEMORY.md            # Memory index
├── HEARTBEAT.md         # Auto-check system
├── custom-crons.json    # ← NEW: Custom crons (bot writes, Electron reads)
├── skills/active.md     # Current industry skills
├── industry/active.md   # Current industry operations
├── .learnings/
│   ├── LEARNINGS.md     # Pre-loaded lessons (L-001, L-002)
│   └── ERRORS.md        # Error log (ERR-001)
├── memory/
│   ├── people/
│   ├── projects/
│   ├── decisions/
│   ├── context/
│   └── YYYY-MM-DD.md
└── prompts/
    ├── sop/active.md
    └── training/active.md
```

### Source (development)
```
claw/
├── AGENTS.md            # Source of truth (sync to workspace)
├── skills/*.md          # 8 industry skill files
├── industry/*.md        # 8 industry operation files
├── .learnings/*.md      # Pre-loaded lessons (ship with template)
├── electron/            # Electron app source
└── docs/superpowers/    # Plans, specs, session logs
```

---

## Cron System Architecture

```
┌─────────────────────────────────┐
│  Fixed Schedules (Dashboard)    │
│  claw-schedules.json            │
│  ├── morning (07:30)            │
│  ├── evening (21:00)            │
│  ├── heartbeat (*/30 min)       │
│  └── meditation (01:00)         │
├─────────────────────────────────┤
│  Custom Crons (Bot-created)     │
│  custom-crons.json              │  ← bot ghi file trực tiếp
│  ├── fs.watch → auto-reload     │  ← Electron phát hiện thay đổi
│  ├── IPC push → Dashboard RT    │  ← Dashboard cập nhật realtime
│  └── Permanent, no expiry       │
├─────────────────────────────────┤
│  node-cron scheduler            │
│  All jobs → timezone VN         │
│  Fire → triggerGatewayMessage() │
│  Fallback → sendTelegram()      │
└─────────────────────────────────┘
```

---

## Vấn đề đang tồn đọng

### Quan trọng — Cần fix tiếp
1. **Bot vẫn dùng CLI cron thay vì ghi file** — Cần `/reset` để bot reload AGENTS.md mới. Nếu vẫn lỗi, kiểm tra session của OpenClaw agent có đọc AGENTS.md không.
2. **Port 18791 unauthorized** — Gateway web UI cần token auth. Token: `ad451200cab0ae33f54fd1407eeea648bdf67731e4c083eb`. Truy cập qua Dashboard button "Gateway UI" đã có sẵn.

### Tính năng pending (từ phiên trước)
3. Google Calendar/Email integration — user nói "calendar tính sau"
4. OTA update mechanism
5. Mac compatibility
6. End-to-end fresh install test
7. V2 features (Google Form onboarding, Personalization wizard, UI Rebrand) — plan tại `docs/superpowers/plans/2026-04-06-moodoroclaw-v2.md`

---

## Quyết định quan trọng đã đưa ra

| # | Quyết định | Lý do |
|---|-----------|-------|
| 1 | Dùng file-based cron thay vì OpenClaw CronCreate tool | CronCreate hết hạn 7 ngày, không permanent |
| 2 | Dùng file-based cron thay vì OpenClaw CLI | CLI cần pairing, lỗi cho user mới |
| 3 | Ship LEARNINGS.md có sẵn bài học | Khách mới không cần gặp lỗi mới học |
| 4 | 3 lớp chặn (AGENTS.md top + cron section + LEARNINGS) | Đảm bảo bot KHÔNG BAO GIỜ dùng CLI cron |
| 5 | Loại 86% fake capabilities từ skill files | Chỉ giữ 5 khả năng thật của OpenClaw |
| 6 | 12 Telegram commands (5 custom + 7 OpenClaw) | Chỉ giữ lệnh CEO thực sự cần |
| 7 | Dashboard hiện cả fixed + custom crons | Mọi cron phải visible, click xem chi tiết |
| 8 | Real-time Dashboard update via fs.watch + IPC | Bot tạo cron → Dashboard cập nhật ngay |

---

## Test checklist (chưa verify)

- [ ] `/reset` trên Telegram → bot reload AGENTS.md mới
- [ ] "tạo cron tóm tắt lúc 11h30 tối" → bot ghi custom-crons.json (không lỗi pairing)
- [ ] custom-crons.json thay đổi → Dashboard tự cập nhật
- [ ] Click vào cron row → modal chi tiết mở
- [ ] Toggle bật/tắt custom cron → ghi file → cron reload
- [ ] Xóa custom cron → file cập nhật → Dashboard cập nhật
- [ ] Nút Refresh trên Dashboard hoạt động
- [ ] Bot không hiện lỗi kỹ thuật cho CEO
- [ ] Fixed crons (morning/evening) vẫn chạy bình thường

---

## Session 2 — Custom cron sent prompt instead of running it

**Symptom:** Custom cron at 12:25 fired and Telegram-DM'd CEO the raw prompt
("Hãy tóm tắt những việc đã làm hôm nay…") instead of running the prompt
through the agent and delivering the **output**.

**Root cause:** [electron/main.js:1693](../../electron/main.js#L1693) — handler did
`sendTelegram(c.prompt)`. Prompt text was never evaluated. Same anti-pattern as
the fixed morning/evening schedules, which intentionally only notify, but custom
crons inherited the wrong shape.

**Fix (Path B "must never silently fail"):** all in [electron/main.js](../../electron/main.js).

1. New `findOpenClawCliJs()` + `spawnOpenClawSafe()` — spawns
   `node openclaw.mjs <args>` directly with `shell:false`. Avoids cmd.exe
   silently truncating multi-line prompt args (same class of bug as the
   OpenZalo `shell:true` issue documented in CLAUDE.md).
2. New `selfTestOpenClawAgent()` — at every `startCronJobs()` call, runs
   `openclaw agent --help`, parses available flags, picks the most-explicit
   profile (`full` / `medium` / `minimal`) the current openclaw version
   actually supports. Catches openclaw CLI drift on EVERY app start, before
   any real cron fires. If broken → loud Telegram boot notice to CEO.
3. New `runCronAgentPrompt(prompt, {label})` — invokes
   `openclaw agent --message <prompt> --deliver --channel telegram --to <chatId>
   --reply-channel telegram --reply-to <chatId>` (or fallback). Retries 3× with
   exponential backoff on transient errors (ECONNREFUSED, gateway-not-running,
   timeout). On total failure → Telegram alert with exit code + stderr.
4. Every fire journaled to `~/.openclaw/workspace/logs/cron-runs.jsonl`
   (phase: `self-test` | `ok` | `retry` | `fail`). Always answerable: "did my
   cron run?".
5. Replaced both call sites:
   - [main.js:1796-1803](../../electron/main.js#L1796-L1803) — real cron handler.
   - [main.js:1483-1488](../../electron/main.js#L1483-L1488) — dashboard "Test"
     button (now exercises the same real path).

**Reliability properties (verified by design, not yet by fresh-install test):**
- Survives openclaw breaking changes — boot self-test catches missing flags,
  flag profiles fall back, journaled + announced.
- Survives modoro updates — single source file, no runtime patching.
- Never silent — every failure path reaches CEO via Telegram.
- Fresh-install safe — lives entirely in `electron/main.js` source, runs every
  `startOpenClaw()` boot.

**Verify after restart (RUN.bat):**
- Electron console shows: `[cron-agent self-test] OK — flag profile: full`
- Click "Test" on a custom cron in Dashboard → real summary arrives, not the prompt.
- Tail `~/.openclaw/workspace/logs/cron-runs.jsonl` after the test.

**Chained fix — `agents.defaults.blockStreaming` schema rejection**

After Path B shipped, the first real test produced the expected loud failure:
```
⚠️ Cron "TEST — Tóm tắt việc đã làm hôm nay" thất bại sau 3 lần
Exit code: 1
Config invalid — agents.defaults: Unrecognized key: "blockStreaming"
```
The Path B retries + alert pipeline worked exactly as designed and surfaced the
real blocker: openclaw 2026.4.x renamed `agents.defaults.blockStreaming` (bool)
→ `agents.defaults.blockStreamingDefault` (`"on"|"off"`), and now hard-rejects
the old key. Every `openclaw <subcommand>` was exiting code 1 on config load,
so no agent could ever run.

**Schema research (from openclaw dist):**
- `reply-CxEVitwF.js`: `resolvedBlockStreaming = ... agentCfg?.blockStreamingDefault === "on" ? "on" : "off"` — new key, defaults to `"off"` (= no block streaming = no message splitting). **The new default is what we wanted, so we don't need to write any value.**
- `bot-DYFDqLWF.js`: `telegramCfg.blockStreaming === "boolean" ? telegramCfg.blockStreaming : ...` — per-channel `channels.telegram.blockStreaming` is **still valid**. Same for `channels.openzalo.blockStreaming`.

**Fix:** [main.js:676-689](../../electron/main.js#L676-L689) — `ensureDefaultConfig()` now actively `delete`s `agents.defaults.blockStreaming` from the config (instead of writing it). Per-channel keys unchanged. Runs every boot, so existing fresh installs with the bad key get healed automatically.

**Live config also healed manually** so testing doesn't have to wait for the next `startOpenClaw()` cycle. Verified `node openclaw.mjs agent --help` now exits 0.



## Session 3 — Knowledge + Zalo + 9Router fixes (CEO bug report)

**BUG 1 — Knowledge upload không persist:** `getDocumentsDb()` hardcode `~/.openclaw/workspace/memory.db` (dir không tồn tại trên fresh install) → DB fail open → upload silently lost. Fix: dùng `getWorkspace()` cho cả DB và `documents/` dir. File: `electron/main.js` `getDocumentsDb`+`getDocumentsDir`.

**BUG 2 — `/thuvien` vs Knowledge tab:** Hợp nhất. Bỏ `/thuvien` khỏi `registerTelegramCommands` (main.js:1683), khỏi Dashboard "Lệnh nhanh" (dashboard.html:419), khỏi 2 chỗ AGENTS.md. Knowledge tab + `knowledge/<cat>/index.md` là canonical. Bot bootstrap rule (AGENTS.md line 75-90) đã có sẵn.

**BUG 4 — Zalo blocklist không hoạt động:** Plugin OpenZalo chỉ support `allowFrom` (whitelist), không có `denyFrom`. Fix: `ensureZaloBlocklistFix()` mới trong main.js inject 30 dòng TS vào `~/.openclaw/extensions/openzalo/src/inbound.ts` ngay sau body-empty check, đọc `zalo-blocklist.json` từ workspace, drop message nếu sender thuộc list. Idempotent qua marker `MODOROClaw BLOCKLIST PATCH`. Helper standalone: `electron/patches/apply-zalo-blocklist.js`. Đã apply lên runtime plugin.

**BUG 5 — Zalo group 3 modes:** UI hiện chỉ có 2 modes (open + allowlist). Plugin support thêm `disabled` nhưng UI không offer → giữ nguyên 2 modes, không pretend 3. Handler `save-zalo-manager-config` đã write `groupPolicy` đúng schema.

**BUG 6 — `agents.defaults.blockStreaming` schema break:** Đã fix trong session trước (delete key). Verified `~/.openclaw/openclaw.json` không còn key cũ.

**BUG 7 — 9Router login 123456 không vào:** Two root causes — (a) một lần chạy trước có thể đã write `settings.password` hash vào `db.json`, (b) `JWT_SECRET` không pin → cookie cũ invalid. Fix: `ensure9RouterDefaultPassword()` mới xóa `settings.password` mỗi lần `start9Router()`, pin `INITIAL_PASSWORD=123456` + `JWT_SECRET=modoroclaw-9router-jwt-secret-stable-v1` qua spawn env. UI hint mật khẩu hiện ngay header tab 9Router.

**Files changed:** `electron/main.js`, `electron/ui/dashboard.html`, `electron/patches/apply-zalo-blocklist.js` (new), `AGENTS.md`, `CLAUDE.md`. Patch áp dụng cho: cả dev lẫn fresh install (auto-restore on every startup).

---

## Session 4 — cron self-test was a gate, not a hint (Path B v2)

**Symptom:** After healing the `agents.defaults.blockStreaming` schema break,
restart produced this Telegram boot alert:
```
⚠️ MODOROClaw boot — openclaw CLI breaking change
openclaw agent không còn hỗ trợ --message hoặc --deliver. openclaw có thể vừa update breaking. Cron sẽ KHÔNG chạy.
```
But `node openclaw.mjs agent --help` from a fresh shell exited 0 with all six
flags present (verified). Reproducing inside Electron ALSO worked. Yet the
in-process self-test from boot 3 reported `missing-core-flags`.

**Root cause (design flaw, not openclaw):** the self-test was treated as a
**gate**: if it couldn't conclusively detect flags from `--help` output, it
set `_agentCliHealthy = false` and refused all subsequent runs. This violates
the "must always work" priority — a transient parser glitch (output truncation,
PATH race, openclaw rendering quirk) was enough to permanently disable cron
delivery for the entire process lifetime, even though the actual CLI was fine.

**Journal evidence (`~/.openclaw/workspace/logs/cron-runs.jsonl`):**
- Boots 1 + 2: self-test ok=true, profile=full, directNode=true ✓
- Boots 1 + 2 cron: failed because `ensureDefaultConfig()` ran async and the
  bad `blockStreaming` key was still in the live config when the agent spawn
  fired (3 retries each, all returning the same Config-invalid error)
- Boot 3 self-test: ok=false, reason=missing-core-flags — but no `directNode`
  or stdout/stderr length logged, so we couldn't tell *why* the parser failed.
  This visibility gap is itself a bug.

**Fix (Path B v2):** [main.js:309-391](../../electron/main.js#L309-L391) —
redesigned `selfTestOpenClawAgent()` to be **informational only, never gating**:

1. Try to detect best flag profile from `--help`. If found → use it.
2. If detection is **inconclusive for any reason** → default to `'full'` profile,
   set `_agentCliHealthy = true` anyway, and **do not Telegram-alert**.
3. The truth source is the actual cron call's exit code. The retry loop +
   Telegram alert in `runCronAgentPrompt` is the real safety net.
4. On every self-test, journal `code`, `stdoutLen`, `stderrLen`, `directNode`,
   plus on inconclusive runs a 400-char preview of stdout AND stderr — so any
   future weirdness is investigatable.
5. Self-test is re-runnable: cache only kept when conclusive (`_agentCliHealthy
   && _agentFlagProfile`), so PATH/openclaw state changes mid-process recover.

**Principle codified:** "Must always work" > "must verify before trying". A
self-test that can refuse to run the real thing is worse than no self-test —
it adds a new failure mode with no upside. The retry loop already discovers
real failures; the self-test only needs to optimize the first call's flag
choice when it can.

**Verify after restart:**
- Console shows `[cron-agent self-test] OK — profile: full ...` (or
  `inconclusive — defaulting to 'full'` if parser can't read help; either way
  cron will fire).
- Click Test → real summary delivered (or detailed Telegram error if openclaw
  is genuinely broken — never silence).
- `tail logs/cron-runs.jsonl` shows `phase:"self-test"` with all diagnostic fields.

---

## Session 5 — Onboard parity (CEO: "user ko cần học lại lỗi của chúng ta")

**Goal:** every fix from sessions 2/4 must take effect on the *very first*
boot of a fresh-install user, with zero retries needed and zero learned
workarounds. The user should never see ANY of these failure modes.

**Audit found 3 onboard reliability gaps:**

1. **Race in cold-boot ordering** ([main.js:622-633](../../electron/main.js#L622-L633)):
   `createWindow()` called `startOpenClaw()` (which awaits
   `ensureDefaultConfig()`) **fire-and-forget**, then immediately ran
   `startCronJobs()`. So the cron handlers got scheduled before the schema
   heal completed. If a user clicked "Test" within ~2 seconds of boot, the
   first agent spawn raced the heal and failed with "Config invalid".

2. **Same race in wizard-complete** ([main.js:2706-2722](../../electron/main.js#L2706-L2722)):
   the worst case — a brand-new user finishes the wizard and the very first
   thing that happens is the same race. Same fix.

3. **No defense if some other path bypasses boot heal:** if any future code
   path triggers a cron-agent spawn without going through boot ordering, the
   bad config could resurface.

**Fix — layered defense, "must always work":**

**Layer 1 — Boot ordering (await before schedule).** Both `createWindow()` and
`wizard-complete` now `await startOpenClaw()` before calling `startCronJobs()`.
Schema heal is guaranteed to finish before any cron handler exists.

**Layer 2 — Inline self-heal at every agent spawn.** New
[`healOpenClawConfigInline()`](../../electron/main.js#L420-L451) is called at
the top of `runCronAgentPrompt()` AND on any "Config invalid" error mid-retry.
Idempotent, cheap (just `JSON.parse` + `delete` + maybe write). If anything
re-introduces a deprecated key (manual edit, partial heal, future schema break
discovered at runtime), the cron run heals it on the spot and continues.

**Layer 3 — Heal-and-immediately-retry on `Config invalid`.** The retry loop
in `runCronAgentPrompt()` now detects `isConfigInvalidErr(stderr)` and triggers
an inline heal followed by an immediate retry (no backoff), so a single
unexpected schema rejection can self-recover within ~1s instead of consuming
all 3 retries on the same poisoned state.

**Layer 4 — Robust openclaw.mjs resolver.** [`findOpenClawCliJs()`](../../electron/main.js#L209-L249)
now derives the path from the resolved bin location first (`<bindir>/node_modules/openclaw/openclaw.mjs`),
falling back to a wider list of hardcoded common locations across platforms /
package managers (npm, pnpm, nvm, volta, scoop, system Node, etc.). This means
the multi-line-prompt-safe direct-node spawn keeps working regardless of where
the user installed openclaw — the cmd.exe newline-truncation bug class can't
sneak back in via a fallback path.

**Net effect for a fresh-install user:**
1. Wizard finishes → `await ensureDefaultConfig()` (writes/heals openclaw.json) → `startCronJobs()` schedules handlers.
2. User clicks Test on a cron → `healOpenClawConfigInline()` (no-op, already healed) → optimistic self-test (sets `'full'` profile) → spawn `node openclaw.mjs agent ...` → exit 0 → real summary delivered.
3. They never see "Config invalid", never see "missing-core-flags", never see the prompt-instead-of-output bug. Zero learning required.

**Files changed:** [electron/main.js](../../electron/main.js) only. All in source tree, runs every boot — fresh-install + modoro-update + openclaw-update safe per CLAUDE.md RULE #1.
