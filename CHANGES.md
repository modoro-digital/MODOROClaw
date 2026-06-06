# CHANGES.md — Chi tiết thay đổi

> Commit history ghi *what*. File này ghi *what + why + how* — đủ để hiểu quyết định mà không cần đọc diff.

---

## 2026-06-06 (tối) — Telegram im lặng: bỏ cascade restart gateway khi Zalo listener chết

**File:** `electron/lib/gateway.js` (`startFastWatchdog`, nhánh Zalo sub-check)

**Triệu chứng:** Bot không reply trên Telegram nữa (dù token hợp lệ — `setMyCommands` ok, 9router khỏe).

**Root cause (systematic-debugging, xác nhận bằng log máy test):**
1. openzca (Zalo) login rồi bị Zalo đóng `NORMAL_CLOSURE (1000)` ngay → loop reconnect mỗi 1–7s, circuit breaker trip. (`openzca.log` cho thấy 2 tài khoản khác nhau bị quét vào CÙNG profile `default`: Bizclaw 645630314874670511 và Huy Bui 2219976038711505849 — session không giữ được.)
2. `fast-watchdog` thấy Zalo listener chết 6 lần (~120s) → gọi `stopOpenClaw()` + `startOpenClaw()` để respawn Zalo (rate-limit 5/giờ).
3. Restart đó GIẾT luôn Telegram poller (chung 1 gateway process). Mỗi restart mất ~25–38s + cửa sổ chồng lấn gây `409 Conflict getUpdates`.
4. Zalo chết vĩnh viễn (login hỏng) → watchdog restart gateway liên tục → **Telegram không bao giờ sống đủ lâu để reply.**

Code free đã có comment "LOG ONLY, never restart" (dòng 1542-1546) nhưng nhánh `_fwZaloMissCount === 6` BÊN DƯỚI vẫn restart — fix dở dang, comment mâu thuẫn code.

**Fix:** Copy đúng logic bản premium (`PeterBui85/9BizClaw-Premium` — đang chạy ổn). Xóa hẳn nhánh `=== 6` restart cascade; chỉ còn: 3 lần miss → log "NOT restarting gateway" **log-only, KHÔNG gửi alert CEO** (bỏ `sendCeoAlert` theo yêu cầu — tránh spam Telegram khi Zalo cần re-login). Telegram giờ ĐỘC LẬP với sức khỏe Zalo. Verified `node --check` pass.

**Lưu ý vận hành:** Zalo vẫn cần QR re-login sạch (1 tài khoản duy nhất) để kênh Zalo hoạt động lại — nhưng việc đó không còn ảnh hưởng Telegram.

---

## 2026-06-06 (chiều) — auto-update tắt + fork bump + free model combo

> Lưu ý: KHÔNG sửa Zalo allowlist trong bản này. Đã thử fix `mergeNewFriends`
> (nghi deny-all `['__NONE__']` chặn mọi DM) nhưng REVERT vì phá 3 invariant đã
> có test (`check-zalo-account-settings.js`): first-sync populate qua flow khác,
> deny-all + bạn mới → chỉ thêm bạn MỚI, account-switch loại shared-peer. `['__NONE__']`
> thấy trên máy dev là artifact của account-switch, KHÔNG phải trạng thái fresh-install.
> Zalo no-reply nhiều khả năng do **openzca listener crash/disconnect** (cần log máy
> test để xác nhận; QR login sạch thường khắc phục).

### UI: nút "Xóa" skill (tab Skills) bị kéo dài full-width

**File:** `electron/ui/dashboard.html` (`renderSkillDetail`)

**Bug:** Nút "Xóa" ở header chi tiết skill tùy chỉnh hiển thị thành một thanh đỏ dài gần hết chiều ngang panel. Inline style chỉ có `flex-shrink:0` (chặn co lại) nhưng không chặn nút giãn ra trong flex row, và dùng class `btn-sm` KHÔNG tồn tại (class đúng là `btn-small`) nên không có padding/size chuẩn.

**Fix:** Đổi sang `flex:0 0 auto;width:auto;align-self:flex-start;padding:6px 14px` + class `btn-small`. Nút giờ co về đúng kích thước nội dung, nằm gọn góc trên-phải.

### Auto-update DISABLED ở free edition (tránh kéo bản VIP)

**File:** `electron/lib/updates.js` — `checkForUpdates()` giờ là no-op `return null`. Feed cũ trỏ `PeterBui85/9BizClaw-Premium` → free user sẽ bị "update" thành bản premium/VIP có license gating. Tắt hẳn: không boot-check, không banner, không download. (Chi tiết: xem mục cùng ngày bên dưới nếu có.)

### modoro-zalo fork bump v1.0.19 → v1.0.20 (sửa version collision)

**File:** `electron/lib/zalo-plugin.js` (const) + `electron/packages/modoro-zalo/src/.fork-version`

**Bug:** free dùng CHUNG version `v1.0.19` với premium nhưng nội dung khác (free giữ user-skills v2). Fast-path `_ensureZaloPluginImpl` (zalo-plugin.js:750) skip re-copy khi version trùng → trên máy đã có plugin premium v1.0.19, app free KHÔNG deploy plugin của mình → chạy nhầm code premium. **Fix:** bump free sang `v1.0.20` (distinct) → luôn deploy đúng plugin free.

### Free model fallback dùng combo [mimo, deepseek] (không chỉ deepseek)

**File:** `electron/lib/dashboard-ipc.js` (`useFreeModel`)

`oc/deepseek-v4-flash-free` là model reasoning nặng → ở token budget thường trả `content` RỖNG (verified live). Đổi combo `main` = `['oc/mimo-v2.5-free', 'oc/deepseek-v4-flash-free']` — mimo trả content trực tiếp (primary), deepseek làm backup. Thêm guard: ghi combo lỗi → trả error thay vì false-success.

### Wizard step 2: nút "Dùng AI miễn phí & đi tiếp" khi không kết nối được ChatGPT

**File(s):** `electron/lib/dashboard-ipc.js` (handler `setup-9router-auto` opt mới `useFreeModel`), `electron/ui/wizard.html` (nút + handler `useFreeAIModel`)

**What:** Nếu CEO không kết nối được ChatGPT ở bước 2 (thường do tường OTP), có nút riêng để dùng ngay model miễn phí có sẵn của 9Router rồi tự động sang bước 3.

**Why:** Tường OTP của ChatGPT chặn một số người dùng ở bước 2 → kẹt onboarding. Cần đường thoát để bot chạy được ngay.

**How:** `useFreeModel` set combo `main` = `['oc/mimo-v2.5-free', 'oc/deepseek-v4-flash-free']` + đảm bảo có API key. Các model `oc/*` route được mà KHÔNG cần kết nối provider nào, `cost: "0"`, không xuất hiện trong `/v1/models` nhưng vẫn routable. **Thứ tự quan trọng:** `mimo-v2.5-free` là PRIMARY vì trả `content` trực tiếp; `deepseek-v4-flash-free` là model reasoning nặng — ở token budget thường nó tiêu hết token để "suy nghĩ" và trả `content` RỖNG (verified live: rỗng ở 400 token, chỉ trả lời khi >~2000 token), nên chỉ để làm backup trong combo (9Router tự fallthrough nếu mimo lỗi). Nút tạo combo NGAY lúc bấm, không có khâu "kết nối sau", rồi gọi `navNext()` để đi tiếp như một lần kết nối thành công. Đã kiểm tra chống false-success: nếu ghi combo lỗi (`comboRes.success===false`) → trả error thay vì báo thành công giả. Verify end-to-end live: PUT combo `main`=[mimo,deepseek] → completion qua `main` resolve về `xiaomi/mimo-v2.5`, `cost=0`, có `content` thật; combo của user được restore nguyên vẹn sau test.

### Wizard Telegram (bước 3): nút Quay lại trên mọi sub-screen

**File(s):** `electron/ui/wizard.html`

**What:** Thêm "← Quay lại" trên screen 3-2 và screen lấy User ID (3-3); footer `navBack()` giờ lùi qua từng sub-screen (3-4 → 3-3 → 3-2 → 3-1 → bước 2) thay vì nhảy thẳng về bước 2. Không còn dead-end. (Port pattern từ premium `9688e46d`.)

### Port các fix Zalo / hành vi chính từ premium main (bỏ Facebook/Google)

**What:** Cherry-pick có chọn lọc các fix Zalo/hành vi từ premium `main` (v2.4.11) vào free edition. Bỏ qua mọi thứ thuộc Facebook/Google và các kênh premium (WhatsApp/Lark).

**Why:** Free edition là orphan branch (không chung lịch sử git với premium), cắt từ một snapshot premium gần đây. Premium đã có nhiều fix Zalo/hành vi mà free chưa có.

**How / File(s):**
- `electron/lib/channels.js` — sticky-chatId fail-safe (không tin chatId khi không xác thực được token), mở rộng regex output-filter `api-model-name` (mirror send.ts), `sendZaloTo({skipOnBlock})` (chặn rò "ack thay thế" vào nhóm khách), guard workspace=null. **Bỏ** các hàm/probe WhatsApp/Lark.
- `electron/lib/cron.js` — copy nguyên bản từ premium rồi GỠ phụ thuộc `fb-schedule` + `sacred-data` (free không có 2 module này): `_stripProcessAcks` (chống rò process-ack vào nhóm Zalo), `parseAgentJsonOutput` không deliver stdout non-JSON, `capCronPromptBytes`, `ensureGatewayWarmForCron`/`isGatewayDropErr`, `_handlePastDueOneTime`, dedup `_seedRecentFiresFromAudit` (đọc `e.t`/`e.id`), `cron.validate` guard, replay dedup.
- `electron/lib/vendor-patches.js` — web-fetch CRON TOKEN PATCH **v3** (gộp dọn legacy v1/v2 một lần → hết lỗi "Identifier already declared"), tắt 2 log cảnh báo pricing khi offline/proxy.
- `electron/lib/ceo-memory.js` — `regenerateCeoMemoryFile` ghi lại khi SỐ fact khác nhau (trước đây `_norm` collapse làm 2 chuỗi bằng nhau → file CEO-MEMORY.md không cập nhật khi thêm fact).
- `electron/lib/conversation.js` + `electron/lib/ceo-memory-capture.js` (mới) — viết lại idle-memory: dùng watcher định kỳ (quiet/gap/force) thay vì setTimeout re-arm (timer cũ KHÔNG BAO GIỜ fire khi bot bận vì traffic Zalo reset timer → ceo_memories rỗng nhiều ngày). Wiring đổi `setIdleMemoryRunCronAgent(...)` → `startIdleMemoryWatcher()` trong `dashboard-ipc.js`.
- `electron/packages/modoro-zalo/` — bump fork v1.0.11 → **v1.0.19**: copy nguyên `inbound.ts` + `send.ts` + `.fork-version` từ premium, cập nhật const `MODORO_ZALO_FORK_VERSION` trong `zalo-plugin.js`. **Giữ lại** khối USER-SKILLS-INJECT **v2** của free trong `inbound.ts` (free dùng resolve folder-layout `SKILL.md` self-contained; premium chuyển sang v3 unified-skill-manager mà free chưa có `chat.js` để đồng bộ) — mọi cải tiến hành vi Zalo khác của premium được giữ.
- `electron/scripts/smoke-test.js` — cập nhật 2 guard theo nguồn: marker token patch `v2` → `v3`; fork-version check chuyển sang format-based (không pin v1.0.11) — đồng bộ với cách premium làm.

**Verify:** `npm run smoke` — toàn bộ script PASS (module contracts 50 modules 0 fail; smoke-test 0 fail; context-injection/zalo-followup/visibility/skill-runtime PASS; map regenerated). `guard:bundle` chỉ chậm do enumerate `vendor-bundle.tar` 2.1GB (artifact build, không liên quan source).

---

## 2026-06-02

### Version: free edition renumbered 3.0.1-free → 2.0.0-free

**File(s):** `electron/package.json`, `electron/package-lock.json` (2 fields),
`README.md`, `.github/workflows/build-mac-release.yml` (example hint)

**Why:** The free edition was at 3.0.1-free — *higher* than the premium product
(2.4.x), which is backwards for a free/premium split. Renumbered the free line to
2.0.0-free so it visibly sits below premium. README was also stale (still showed
v3.0.0 while the build was 3.0.1-free); now consistent at v2.0.0-free.

**Also (release side, done outside the repo):** the published v3.0.0-free and
v3.0.1-free GitHub releases + tags were deleted and a single v2.0.0-free release
cut in their place. The current installers were re-uploaded under it — note they
still internally report 3.0.1-free until the next build is cut natively at 2.0.0.
`skills/operations/zalo.md` `version: 3.0.0` left as-is (that's the skill doc's own
metadata version, not the app version).

**State:** done

---

### Security/hygiene: public-repo cleanup (MODOROClaw is public)

**File(s):** `electron/lib/nine-router.js` (JWT secret), `.gitignore` + `CLAUDE.md` (untrack), `README.md`

**What + why:** The repo `modoro-digital/MODOROClaw` is public. Three problems fixed:

1. **Hardcoded JWT secret** — `nine-router.js` pinned `JWT_SECRET` to the literal
   `'REDACTED-ROTATED-SECRET'`. A shared constant in public source
   lets anyone forge a valid 9Router auth cookie. **Fix:** new `get9RouterJwtSecret()`
   generates a random 256-bit secret on first run, persists it to
   `<DATA_DIR>/.jwt-secret` (mode 0600), and reuses it — so cookies still survive
   restarts but each install has its own secret. `INITIAL_PASSWORD=123456` kept
   (localhost-only default, intentional).

2. **CLAUDE.md published** — the internal engineering journal documents the
   licensing/revocation Gist URL + GitHub handle, hardware-lock seal scheme,
   default credentials, ports, and every plugin bypass. **Fix:** `git rm --cached
   CLAUDE.md` + added to `.gitignore`. Kept on disk for local dev; not shipped in
   the product, so no build impact.

3. **README pointed at a non-existent repo** — all Releases + clone links used
   `github.com/modoro-digital/9BizClaw` (404; real repo is `MODOROClaw`). Dev-mode
   block called the gitignored `RUN.bat`. **Fix:** corrected all URLs to
   `MODOROClaw`, replaced `RUN.bat` with `npm start`, dropped the now-private
   `CLAUDE.md`/`RESET.bat` references from the dev-rules section.

**Not done (left to CEO — irreversible / business calls):** the old JWT literal,
Gist URL, and default password remain in *git history* — forward edits don't purge
them (rotating the JWT is the real mitigation since each install now self-generates).
A full purge needs a history rewrite + force-push, or making the repo private.
`AGENTS.md` left tracked: it ships inside every distributed binary (extractable from
any install) and removing it breaks source builds — making the repo private is the
only real protection. `9BizClaw-Premium` repo is also public (separate from this fix).

**State:** done (local). Push to `modoroclaw/main` pending.

---

### Fix: zalo-followup cron 9:30 AM gửi lỗi "parameter conflict" cho sessions_send

**File(s):** `electron/lib/cron.js` — `buildZaloFollowUpPrompt()` (lines ~1227-1229, ~1250)

**Root cause:** `buildZaloFollowUpPrompt()` dặn LLM "Gửi đúng tool sessions_send." Tool `sessions_send` trong openclaw yêu cầu tham số `sessionKey` (bắt buộc) để xác định target session. Khi LLM gọi `sessions_send` mà không có `sessionKey`, openclaw tool validator phản bác "parameter conflict" (sai schema). Cron chạy 3 lần retry rồi thất bại im lặng — CEO không nhận được tin.

**Tại sao bug xảy ra:** Hướng dẫn "sessions_send" đã được thêm vào prompt builder mà không hiểu schema của tool. `sessions_send` là internal inter-session RPC, không phải tool gửi tin ra ngoài. Tool đúng để LLM dùng là `message` (gửi tin đến CEO Telegram session — đã được AGENTS.md điều khiển).

**Fix:** Xoá 2 chỉ dẫn "Gửi qua tool sessions_send." khỏi `buildZaloFollowUpPrompt()`. Thay bằng "Gửi cho CEO báo cáo... qua tin nhắn." — LLM tự dùng `message` tool đúng theo AGENTS.md rules.

**Phạm vi kiểm tra:** Đã kiểm tra TẤT CẢ cronjob:
- Morning briefing, evening summary, afternoon nudge, weekly report, monthly report — dùng `runCronViaSessionOrFallback` → `sendToGatewaySession` (gateway CLI, không qua LLM tool) — **OK**
- Zalo follow-up — dùng `runCronAgentPrompt` với hướng dẫn `sessions_send` — **BROKEN → FIXED**
- Memory cleanup — dùng `runCronAgentPrompt` không có tool instruction — **OK**
- Custom crons (user-created) — dùng `runCronViaSessionOrFallback` hoặc `runCronAgentPrompt` tùy zaloTarget — phụ thuộc prompt user viết, không ảnh hưởng

**All 6 built-in cronjob tool paths verified:**
| Cron | Mode | Tool instruction | Status |
|------|------|-----------------|--------|
| Morning briefing | session-send (gateway CLI) | None | OK |
| Evening summary | session-send (gateway CLI) | None | OK |
| Afternoon nudge | session-send (gateway CLI) | None | OK |
| Weekly report | session-send (gateway CLI) | None | OK |
| Monthly report | session-send (gateway CLI) | None | OK |
| Zalo follow-up | runCronAgentPrompt | sessions_send (SAI) | FIXED |
| Memory cleanup | runCronAgentPrompt | None | OK |

**State:** done

---

## 2026-06-01

### Quy tắc ghi chép

**Mỗi khi có thay đổi** (fix, edit, new function, new feature, refactor, config change), phải ghi vào file này **TRƯỚC KHI commit**. Format:

```markdown
### YYYY-MM-DD — <Mô tả ngắn>

**File(s):** `<list files>`
**Root cause:** (nếu là bug fix) Tại sao bug xảy ra
**Fix/Change:** Giải thích cách sửa / thiết kế
**Tradeoff/Decision:** (nếu có) Tại sao chọn cách này thay vì cách khác
**State:** done / in-progress / reverted
```

Ghi đủ để:
- Hiểu quyết định mà không cần đọc code
- Trace một bug về nguyên nhân gốc
- Onboard dev mới nhanh
- Không cần đọc commit history

---
