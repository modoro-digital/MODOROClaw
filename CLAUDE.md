# CLAUDE.md — Rules cho dev / Claude Code khi làm việc với repo này

## RULE #1: Fresh-install parity — BẮT BUỘC

**Mọi fix, patch, workaround ĐỀU PHẢI áp dụng được cho user mới cài fresh trên máy mới.**

### Checklist cho mỗi fix:

- [ ] Fix nằm trong **source tree** (`Desktop/claw/...`), không phải file runtime (`~/.openclaw/...` chỉ)
- [ ] Fix được áp dụng tự động khi app chạy lần đầu (qua `seedWorkspace`, `ensureDefaultConfig`, `ensureXxxFix`, v.v.)
- [ ] Fix được re-apply sau mỗi restart (bảo vệ khi plugin/dependency bị reinstall)
- [ ] Verify: sau khi chạy `RESET.bat` + `RUN.bat` trên máy trắng, fix vẫn có hiệu lực
- [ ] Nếu patch file của plugin third-party → lưu template vào `electron/patches/`, auto-restore khi khởi động

### Các pattern PHẢI tuân thủ:

**1. Patch third-party plugin files:**
- Lưu file patched vào `electron/patches/<plugin-name>-<file>.ts`
- Thêm function `ensureXxxFix()` trong `main.js` kiểm tra marker `MODOROClaw PATCH` trong file plugin
- Nếu chưa có marker → copy template từ `electron/patches/` sang `~/.openclaw/extensions/xxx/src/`
- Gọi `ensureXxxFix()` trong `startOpenClaw()` để apply mỗi lần start

**2. Patch openclaw config defaults:**
- Thêm logic vào `ensureDefaultConfig()` trong `main.js`
- Đảm bảo field mặc định (VD: `channels.openzalo.groupPolicy: "open"`) được set nếu thiếu
- Chạy mỗi lần `startOpenClaw()`

**3. Patch workspace files (AGENTS.md, schedules.json, v.v.):**
- File template trong source tree (`Desktop/claw/`)
- `seedWorkspace()` copy vào writable workspace khi missing
- `RESET.bat` xóa runtime files → `seedWorkspace()` re-tạo từ template

**4. Patch bot behavior (LEARNINGS, rules):**
- Thêm vào `.learnings/LEARNINGS.md` với format L-XXX
- Thêm vào `AGENTS.md` section tương ứng
- Sync từ source (`Desktop/claw/`) sang workspace via `seedWorkspace`

### Anti-pattern — KHÔNG ĐƯỢC làm:

- ❌ Fix chỉ trong `~/.openclaw/...` mà không cập nhật source tree
- ❌ Fix thủ công mà không thêm auto-apply logic
- ❌ Fix chỉ cho case hiện tại, không handle fresh install
- ❌ Hardcode path chỉ có trên máy dev hiện tại
- ❌ Giả định user đã cài openclaw/openzca toàn cục trước đó

## RULE #2: Verify trước khi claim success

Sau mỗi fix:
1. Test trên máy dev hiện tại
2. Mental-simulate flow cho fresh install (user chạy RESET.bat → RUN.bat → wizard → test)
3. Ghi rõ trong response: "Fix áp dụng cho: [dev | fresh install | cả hai]"

## RULE #3: Document in session log

Mọi fix lớn → cập nhật `docs/superpowers/sessions/` với:
- Root cause đã tìm ra
- Fix đã áp dụng
- File đã thay đổi
- Cách verify

---

## Current patches (cần auto-restore trên fresh install)

### `electron/patches/openzalo-openzca.ts`
**Bug:** OpenZalo plugin dùng `shell: true` trên Windows + arg có newline → `cmd.exe` silently truncate → group replies không bao giờ đến
**Fix:** Dùng `spawn('node', [cliPath, ...args], { shell: false })` để bypass cmd.exe
**Auto-apply:** `ensureOpenzaloShellFix()` trong `main.js` — gọi trong `startOpenClaw()`
**Verify:** Group Zalo @mention → bot reply đến được group

### Block streaming disabled (per-channel only)
**Bug:** Default `blockStreaming: true` + `coalesceIdleMs: 1000` → khi model chậm, token đầu ("D") fire idle timeout trước khi token tiếp theo ("ạ") đến → split thành 2 message.
**Fix:** `blockStreaming: false` ở 2 chỗ per-channel trong `openclaw.json`:
- `channels.openzalo.blockStreaming = false`
- `channels.telegram.blockStreaming = false`

⚠️ **KHÔNG set `agents.defaults.blockStreaming`** — openclaw 2026.4.x đã đổi key này sang `agents.defaults.blockStreamingDefault` ("on"|"off") và sẽ reject config nếu thấy key cũ. Default mới đã là "off" → ta không cần ghi gì cả, chỉ phải DELETE key cũ. Xem patch tiếp theo bên dưới.

**Auto-apply:** `ensureDefaultConfig()` trong `main.js` mỗi lần `startOpenClaw()`.

### `agents.defaults.blockStreaming` schema break (openclaw 2026.4.x)
**Bug:** openclaw 2026.4.x rename `agents.defaults.blockStreaming` (bool) → `agents.defaults.blockStreamingDefault` ("on"|"off"). Validator hard-reject key cũ → **mọi `openclaw <subcommand>` exit code 1** với `Config invalid: agents.defaults: Unrecognized key: "blockStreaming"` → toàn bộ cron-agent pipeline chết.
**Fix:** `ensureDefaultConfig()` actively `delete config.agents.defaults.blockStreaming` (KHÔNG ghi giá trị mới — default mới đã là "off" = đúng cái ta muốn).
**Auto-apply:** `ensureDefaultConfig()` mỗi lần `startOpenClaw()` — heal cả fresh install lẫn máy đã có key cũ.
**Verify:** `openclaw agent --help` exit 0, không còn `Config invalid`.

### Path B v3 — 6-layer cron-agent reliability (must-always-work)
**Goal:** cron jobs (existing + user-created) phải luôn chạy đúng trên fresh install, không silent fail, sống sót qua mọi update của openclaw + modoroclaw.

**6 layered defenses** (mỗi layer độc lập, chỉ cần 1 layer hoạt động là cron vẫn chạy):

1. **`findNodeBin()`** — resolve `node` về absolute path qua `where node`/`command -v node`, system locations, **nvm, volta, scoop, asdf, fnm**. Cache cho process. Mọi spawn dùng absolute path → không phụ thuộc Electron PATH inheritance (giải quyết Mac Finder launch + Windows Admin elevation cases).
2. **`spawnOpenClawSafe(args, {allowCmdShellFallback})`** — preferred: `<absoluteNode> openclaw.mjs <args>` với `shell:false` (multi-line safe). Fallback: `openclaw.cmd` với `shell:true` (UNSAFE). `runCronAgentPrompt` set `allowCmdShellFallback:false` khi prompt có `\n` → cmd.exe truncation class IMPOSSIBLE.
3. **Gateway spawn** trong `_startOpenClawImpl` cũng dùng `<absoluteNode> openclaw.mjs gateway run` thay vì bin shim → tránh ENOENT trên Windows khi bin là `.cmd` không có `shell:true`.
4. **Generic schema healer** — `parseUnrecognizedKeyErrors(stderr)` parse mọi `<dotted.path>: Unrecognized key: "<key>"` từ openclaw stderr. `healOpenClawConfigInline(errStderr)` walk path → delete key động. Cộng với static known-key removal. Retry loop pass stderr vào heal → **future openclaw schema breaks SELF-HEAL on first failure**.
5. **`getTelegramConfigWithRecovery()`** — chatId 3-tier recovery:
   - Tier 1: `channels.telegram.allowFrom[0]` từ openclaw.json
   - Tier 2: `~/.openclaw/modoroclaw-sticky-chatid.json` (token-fingerprinted, persist mỗi lần observe được)
   - Tier 3: `recoverChatIdFromTelegram(token)` — gọi Telegram `getUpdates`, lấy chatId của private message gần nhất → write back vào openclaw.json
   - Cả 3 fail → ghi `logs/cron-cannot-deliver.txt` (không silent).
6. **Boot ordering + inline pre-spawn heal** — `await startOpenClaw()` (chứa `await ensureDefaultConfig()`) trước `startCronJobs()` trong cả `createWindow` cold-boot lẫn `wizard-complete`. `runCronAgentPrompt` gọi `healOpenClawConfigInline()` trước mỗi spawn (defense-in-depth bypass-proof).

**Confidence:**
- Fresh install Windows + system Node: ~99%
- Fresh install Mac/Linux + system Node: ~99%
- Fresh install Mac + nvm/volta launched từ Finder: ~95% (Layer 1 catches)
- Future openclaw schema breaks: SELF-HEAL on first failure (Layer 4)
- Multi-line prompt: KHÔNG bao giờ truncated (Layer 2 hard-refuses)
- ChatId mất sau wizard/config edit: SELF-RECOVER (Layer 5)

**Verify sau RUN.bat:** console show `[findNodeBin] using: <abs>`, `[gateway] spawning via direct node:`, `[cron-agent self-test] OK — profile: full`. Click Test cron → summary thật về Telegram. `tail logs/cron-runs.jsonl` → `phase:"ok"`.

### Custom cron handler — chạy prompt qua agent thay vì gửi text
**Bug:** Handler trong `main.js` gọi `sendTelegram(c.prompt)` → CEO nhận được câu lệnh chứ không phải kết quả. Prompt không bao giờ được agent thực thi.
**Fix:** `runCronAgentPrompt()` trong `main.js` — spawn `node openclaw.mjs agent --message <prompt> --deliver --channel telegram --to <chatId> --reply-channel telegram --reply-to <chatId>`. Spawn dùng `shell:false` (qua `findOpenClawCliJs()` → `node` trực tiếp) để cmd.exe không truncate prompt nhiều dòng — cùng class bug như OpenZalo `shell:true`.
**Reliability (Path B "must never silently fail"):**
- `selfTestOpenClawAgent()` ở mỗi `startCronJobs()` — chạy `openclaw agent --help`, parse flags, chọn profile (`full`/`medium`/`minimal`). Catch openclaw CLI drift TRƯỚC khi cron fire. Boot fail → Telegram alert cho CEO.
- 3-attempt retry với exponential backoff trên transient error (ECONNREFUSED, gateway-not-running, timeout).
- Mọi fire journal vào `~/.openclaw/workspace/logs/cron-runs.jsonl` (phase: `self-test`/`ok`/`retry`/`fail`).
- Failure tổng cộng → `sendTelegram` notice cho CEO với exit code + stderr (không bao giờ silent).
**Auto-apply:** Trong `electron/main.js` source — chạy mỗi `startOpenClaw()` + `startCronJobs()`.
**Verify:** Click "Test" trên custom cron trong Dashboard → CEO nhận được summary thật (output của agent), không phải prompt text. Console show `[cron-agent self-test] OK — flag profile: full`.

### Knowledge tab — categorized document store
**Feature:** Tab Knowledge trong Dashboard cho CEO upload tài liệu vào 3 folder cố định (cong-ty, san-pham, nhan-vien)
**Auto-create:** `seedWorkspace()` tạo `knowledge/<cat>/files/` + `index.md` rỗng cho fresh install
**Backend:** SQLite có column `category` (idempotent ALTER) + AI summarize qua 9Router
**Bot integration:** AGENTS.md có rule "Knowledge doanh nghiệp" — bot bootstrap đọc 3 index.md
**Files mới:** `knowledge/{cong-ty,san-pham,nhan-vien}/{index.md, files/}`

### OpenZalo blocklist patch (`ensureZaloBlocklistFix`)
**Bug:** OpenZalo plugin chỉ hỗ trợ `allowFrom` (whitelist), không có `denyFrom`. UI Modoro Dashboard → Zalo → Bạn bè ghi `zalo-blocklist.json` nhưng plugin không bao giờ đọc → blocklist vô tác dụng.
**Fix:** `ensureZaloBlocklistFix()` trong `main.js` inject một block code TS vào `~/.openclaw/extensions/openzalo/src/inbound.ts` ngay sau `if (!rawBody && !hasMedia) return;` — block đọc `zalo-blocklist.json` từ workspace, return sớm nếu `senderId` thuộc danh sách. Idempotent qua marker `MODOROClaw BLOCKLIST PATCH`.
**Auto-apply:** Gọi trong `startOpenClaw()` mỗi lần khởi động → sau bất kỳ `npm install` plugin nào cũng tự re-inject.
**Helper standalone:** `electron/patches/apply-zalo-blocklist.js` để patch tay khi cần.
**Verify:** Add user vào Zalo blocklist trên Dashboard → user nhắn → bot không reply, log có dòng `openzalo: drop sender=<id> (MODOROClaw blocklist)`.

### "Gateway is restarting" mid-reply — `openclaw config set` CLI subprocess bypass
**Bug:** Telegram getMe pass (sidebar dot xanh), nhưng nhắn thật → bot reply `⚠️ Gateway is restarting. Please wait a few seconds and try again.` Đã fix 2 lần (heartbeat watchdog + byte-equal helper) nhưng KHÔNG khỏi vì root cause khác.
**Root cause thật** (verified bằng `~/.openclaw/logs/config-audit.jsonl` — openclaw tự ghi mọi write của openclaw.json + argv):
- `ensureZaloPlugin()` ([main.js:~1610](electron/main.js#L1610)) gọi 2 CLI subprocess MỖI Electron startup:
  - `openclaw config set channels.openzalo.enabled true`
  - `openclaw config set channels.openzalo.dmPolicy open`
- Mỗi CLI subprocess là 1 Node process RIÊNG, dùng `rename`-based atomic write → đổi inode → BYPASS HOÀN TOÀN `writeOpenClawConfigIfChanged` helper (helper chỉ guard `fs.writeFileSync` trong process Electron).
- OpenClaw `startGatewayConfigReloader` watch openclaw.json, dùng `initialInternalWriteHash` phân biệt internal vs external write. CLI subprocess = external → wake reload pipeline → `buildGatewayReloadPlan(["channels.openzalo.enabled"])` matches openzalo plugin's reload prefix → restart action → `requestGatewayRestart` → nếu in-flight reply > 0 → `deferGatewayRestartUntilIdle` 5-min poll → timeout → `emitGatewayRestart()` → SIGUSR1 → `abortEmbeddedPiRun({mode:"compacting"})` → reply finalize với `aborted_for_restart` → `agent-runner.runtime.js:2477` send `⚠️ Gateway is restarting...`.
- Bằng chứng cứng: audit log `09:12:48.545Z` + `09:12:57.600Z` (= 16:12 VN, đúng lúc CEO test) — 2 entries `argv:["...openclaw.mjs","config","set","channels.openzalo.enabled","true"]` và `dmPolicy open`, parent PID là Electron PID. Pattern lặp đều mỗi lần Electron restart.
**Fix:**
- **Heal `enabled = true` trong `ensureDefaultConfig()`** ([main.js:1098](electron/main.js#L1098)) — thêm `if (oz.enabled !== true) { oz.enabled = true; changed = true; }` vào openzalo block. Cộng với `dmPolicy = 'open'` đã có sẵn → cả 2 fields được heal in-process qua byte-equal helper, không cần CLI hop.
- **Xóa 2 CLI calls trong `ensureZaloPlugin()`** ([main.js:~1612](electron/main.js#L1612)) — chỉ giữ `plugins install`. Comment giải thích root cause để future devs không add lại.
- Runtime cleanup 1 lần: `taskkill /F /PID <orphan>` để Electron spawn fresh gateway thay vì adopt orphan có accumulated restart-pending state.
**Verify:**
- `tail -n 5 ~/.openclaw/logs/config-audit.jsonl` sau Electron restart → KHÔNG có entry mới với `argv` chứa `["config","set","channels.openzalo.*"]`.
- `ls -la ~/.openclaw/openclaw.json` mtime KHÔNG bump sau restart (steady state).
- CEO nhắn thật → bot reply real content, KHÔNG còn "Gateway is restarting".

### "Gateway is restarting" mid-reply v1 (partial fix — kept) — openclaw.json byte-equal write helper
**Note:** Fix này VẪN GIỮ vì giải quyết 1 lớp khác: prevents trực tiếp `fs.writeFileSync(configPath, ...)` từ trong process Electron. Cộng với CLI subprocess fix bên trên = defense-in-depth.
- Helper `writeOpenClawConfigIfChanged(configPath, config)` ([main.js:907](electron/main.js#L907)) serialize với `\n` cuối, compare bytes, skip nếu equal hoặc chỉ khác trailing newline.
- Tất cả in-process writers route qua helper: `ensureDefaultConfig`, `healOpenClawConfigInline`, `set-batch-config`, `save-wizard-config`, `save-zalo-manager-config`, `getTelegramConfigWithRecovery`.

### Zalo readiness probe v2 — process-first, lock-file fallback
**Bug:** Probe v1 chỉ check `~/.openzca/profiles/default/listener-owner.json` exist → không có = "Chưa sẵn sàng". Race window: openzca subprocess được gateway spawn lúc T=0, nhưng `acquireListenerOwnerLock()` chỉ chạy sau khi process khởi tạo (~3-5s) → trong khoảng đó listener IS running nhưng probe nói "not ready". CEO mở Dashboard → thấy đỏ → tưởng bot chết.
**Fix:**
- `findOpenzcaListenerPid()` mới ([main.js:~2511](electron/main.js#L2511)) — query process list bằng `wmic ... CommandLine like '%openzca%listen%'` (Windows) / `pgrep -f` (Unix). Process IS the source of truth.
- `probeZaloReady()` rewrite: PRIMARY = process check, SECONDARY = lock file (chỉ để lấy session metadata). Stale lock với pid đã chết → not ready. Process chạy nhưng lock chưa có → STILL ready.
- Cache freshness chuyển từ "fail" sang "warning": cache > 30 phút = sắp cần refresh nhưng VẪN ready (listener tự reconnect được).
- `startChannelStatusBroadcast()` thêm boot phase fast polling: `[500, 3000, 6000, 10000, 15000, 20000, 25000, 30000]ms` rồi rơi về 45s steady-state. CEO mở Dashboard → trong 30s đầu thấy state cập nhật mỗi vài giây thay vì chờ 45s.
**Verify:** RESET + RUN → mở Dashboard ngay → Telegram dot xanh trong <2s → Zalo dot xám "checking" → khi gateway log thấy `[openzalo] openzca connected` (~10-15s sau gateway start) → broadcast tiếp theo (3-30s) bắt được listener PID → Zalo dot chuyển xanh.

### better-sqlite3 ABI auto-fix on runtime
**Bug:** Postinstall script `fix-better-sqlite3.js` chỉ chạy khi `npm install` chạy. Nếu user reset chỉ runtime files (không xóa node_modules) → binary cũ vẫn còn → ABI mismatch lại tái phát sau Electron upgrade. Không có cách tự heal trong process.
**Fix:**
- `autoFixBetterSqlite3()` ([main.js:~3193](electron/main.js#L3193)) — khi `getDocumentsDb()` throw `NODE_MODULE_VERSION` lần đầu, sync exec `node electron/scripts/fix-better-sqlite3.js`, clear `require.cache[better-sqlite3]`, retry `new Database(dbPath)` ngay trong cùng call. Idempotent qua `_documentsDbAutoFixAttempted` flag.
- Knowledge tab tiếp tục hoạt động (filesystem fallback) trong khi auto-fix chạy. Sau auto-fix thành công → DB mở được → backfill từ disk lên DB tự kích hoạt.
- RESET.bat thêm `rmdir electron/node_modules/better-sqlite3/build` + chạy `npm install` ở cuối → postinstall fire → binary đúng ABI cho Electron version hiện tại. Không cần chờ user trigger lần đầu mở app.
**Verify:** Sau RESET (mới) → RUN → tab Knowledge upload file → file hiện ngay, không cần wait/retry.

### RESET.bat fresh-install completeness
**Bug:** RESET.bat cũ không xóa `memory.db`, `knowledge/<cat>/files/`, `electron/node_modules/better-sqlite3/build/` → fresh install simulation không thực sự fresh, ABI mismatch có thể persist, Knowledge có data cũ.
**Fix:** RESET.bat thêm:
- `del memory.db` (Knowledge tab DB — `seedWorkspace()` tạo mới)
- `rmdir knowledge/<cat>/files` + `del knowledge/<cat>/index.md` (uploaded files + index — re-seeded khi mở Knowledge tab)
- `rmdir electron/node_modules/better-sqlite3/build` (binary — postinstall regenerate)
- `pushd electron && npm install --silent` ở cuối (force postinstall fire ngay trong RESET, không chờ RUN.bat)
**Verify:** Sau RESET → RUN → wizard → upload Knowledge → thấy file → restart → file vẫn còn (DB OK). Audit log `~/.openclaw/logs/config-audit.jsonl` (hoặc thư mục mới sau reset) chỉ có entries từ wizard install, không có entries từ `config set channels.openzalo.*` sau khi gateway boot.

### Channel readiness — real probes (Telegram getMe + Zalo listener check)
**Bug:** Dashboard show "running" chỉ dựa vào việc process được spawn — không phải proof channel thật sự nhận được tin. Token Telegram có thể sai, listener Zalo có thể chết, cookies có thể stale → bot online giả.
**Fix:**
- `probeTelegramReady()` gọi `https://api.telegram.org/bot<token>/getMe` (timeout 6s) — 200 + ok=true là proof tuyệt đối: token hợp lệ + Telegram server reach được bot. Trả về `{ ready, username, error }`.
- `probeZaloReady()` 3-layer: (1) `~/.openzca/profiles/default/listener-owner.json` exist, (2) pid trong file vẫn alive VÀ command line khớp `openzca listen` (Windows: wmic check, Unix: `kill(pid, 0)`), (3) youngest mtime trong profile dir < 30 phút (auto-refresh chạy mỗi 10 phút). Trả về `{ ready, listenerPid, lastRefreshMinAgo, error }`.
- IPC: `check-telegram-ready`, `check-zalo-ready`, `telegram-self-test` (gửi tin Telegram thật cho CEO — proof end-to-end mạnh nhất).
- `startChannelStatusBroadcast()` chạy mỗi 45s, broadcast `channel-status` event sang renderer (có throttle ở UI cho recheck thủ công).
- Dashboard: sidebar dot màu (xanh ready / đỏ not-ready / xám checking) + ready pill trên page Telegram & Zalo show text rõ ràng "Sẵn sàng nhận tin · @bot_username · kiểm tra HH:MM:SS". Hai nút "Kiểm tra" (force re-probe) + "Gửi tin test" (Telegram only — gửi tin thật cho CEO).
**Files:** `electron/main.js` (probe functions, IPC handlers, broadcast loop), `electron/preload.js` (4 bridges + onChannelStatus), `electron/ui/dashboard.html` (CSS dot/pill, sidebar markup, page header, JS handlers).
**Verify:** Mở Dashboard → sidebar Telegram + Zalo có chấm xanh trong vòng 1.5s. Page Telegram → bấm "Gửi tin test" → CEO nhận được tin trong Telegram. Tắt openzca → dot Zalo chuyển đỏ trong vòng 45s, tooltip nói rõ "Listener process không còn chạy".

### Gateway "restart hoài" loop fix
**Bug:** CEO báo gateway đang restart liên tục. Bằng chứng: 5 file `openclaw.json.bak.N` trong `~/.openclaw/` timestamp gần nhau (15:03, 15:08 ×3, 15:19) — mỗi lần restart openclaw rotate 1 backup.
**Root cause** (3 lỗi cộng dồn):
1. Heartbeat cron hardcode `*/5 * * * *` (mỗi 5 phút) BẤT CHẤP label "Mỗi 30 phút" trong `schedules.json`.
2. `isGatewayAlive()` timeout chỉ **2s** — gateway đang chạy AI completion (CPU-bound) trả response chậm hơn → false-positive "dead".
3. Heartbeat handler kill+respawn ngay sau **1 lần fail duy nhất**, không retry, không grace period. Một heartbeat lỡ → gateway healthy bị giết → respawn → vòng lặp.
4. Phụ: `startOpenClaw()` không có re-entrant guard — heartbeat + UI button + boot có thể spawn 2-3 gateway tranh port 18789.
5. Phụ: Boot ping Telegram fire mỗi restart → CEO thấy "MODOROClaw đã sẵn sàng" lặp đi lặp lại.
**Fix:**
- `isGatewayAlive(timeoutMs=8000)` — default 8s thay 2s, nhận tham số.
- Heartbeat đọc `time` từ schedules.json, parse "Mỗi N phút" → `*/N * * * *` (clamp tối thiểu 5 phút).
- Heartbeat yêu cầu **2 lần fail liên tiếp** với 5s gap mới restart. 1 lần fail = "slow but alive — skipping".
- `startOpenClaw()` wrap với `_startOpenClawInFlight` flag, gọi đến `_startOpenClawImpl` body — block reentrant calls.
- Boot ping throttle 10 phút qua `global._lastBootPingAt`.
**Files:** `electron/main.js` — `isGatewayAlive`, heartbeat case in `startCronJobs`, `startOpenClaw` wrapper, boot ping section.
**Verify:** Restart Electron → quan sát `~/.openclaw/openclaw.json.bak*` không tăng thêm trong 30 phút. Console không spam `[heartbeat] auto-restarting`. Telegram chỉ nhận 1 boot ping mỗi 10 phút.

### Knowledge DB path fix + better-sqlite3 ABI mismatch
**Bug 1 (path):** `getDocumentsDb()` hardcode `~/.openclaw/workspace/memory.db` nhưng dir đó không tồn tại trên fresh install. **Fix:** dùng `getWorkspace()/memory.db`.
**Bug 2 (ABI mismatch — chính):** `electron/node_modules/better-sqlite3/build/Release/better_sqlite3.node` được compile cho NODE_MODULE_VERSION 137 (Node 22+) nhưng Electron 28 dùng NODE_MODULE_VERSION 119 (Node 18). Mỗi lần `getDocumentsDb()` chạy → throw `compiled against a different Node.js version` → return null → upload silent fail → list luôn rỗng. Triệu chứng CEO: "thêm tài liệu thành công nhưng ko thấy hiện folder nào".
**Fix chính:** Downgrade `better-sqlite3` từ `^12.8.0` xuống `11.10.0` (phiên bản cuối có prebuilt cho electron-v119). Cài qua `npm install better-sqlite3@11.10.0 --ignore-scripts` rồi `npx prebuild-install -r electron -t 28.3.3` trong `node_modules/better-sqlite3` để fetch binary đúng ABI. Verified: `electron -e "new Database(':memory:')"` chạy OK.
**Fresh-install protection (Rule #1):**
- `electron/scripts/fix-better-sqlite3.js` — postinstall script tự đọc Electron version từ `package.json`, gọi `prebuild-install -r electron -t <version>` cho better-sqlite3, fallback `electron-rebuild` nếu cần. Cài đặt từ `package.json`: `"postinstall": "node scripts/fix-better-sqlite3.js"`.
- `getDocumentsDb()` log chi tiết khi gặp ABI mismatch (chỉ 1 lần) + hint cách fix.
- **Filesystem fallback:** `list-knowledge-files` + `get-knowledge-counts` + `rewriteKnowledgeIndex` đọc thẳng từ `knowledge/<cat>/files/` khi DB null → CEO luôn thấy file thật trên disk dù DB hỏng.
- **Backfill on startup:** `backfillKnowledgeFromDisk()` chạy trong `app.whenReady` — quét `knowledge/<cat>/files/`, INSERT vào DB những file chưa có, gọi `rewriteKnowledgeIndex` cho mỗi cat. Files upload trong giai đoạn DB hỏng tự được index lại sau khi sửa DB.
- Upload handler không throw khi DB fail — file vẫn lưu disk, return `dbWarning` để UI hiện cảnh báo nhẹ.
**Files:** `electron/package.json` (postinstall + bsqlite version), `electron/scripts/fix-better-sqlite3.js` (mới), `electron/main.js` (fallback + backfill + better error).
**Verify:** Upload file qua Knowledge → hiện trong list ngay → restart Electron → file vẫn còn. Smoke test bằng Electron: `electron -e "const db=require('better-sqlite3')(':memory:'); console.log(db.prepare('select 1').get())"` phải in `{ '1': 1 }`.

### 9Router default password (`ensure9RouterDefaultPassword`)
**Bug:** CEO không login được 9Router với mật khẩu mặc định `123456`. Root cause **thật** (đã verify bằng `curl POST /api/auth/login` → 200 + set-cookie thành công): backend OK, nhưng `<iframe>` trong page `file://` của Electron khiến origin `127.0.0.1:20128` thành "third-party" → cookie `auth_token` bị Electron drop → form login submit OK nhưng request kế tiếp không có cookie → user thấy login "không vào được". (Phụ: pin `INITIAL_PASSWORD` + `JWT_SECRET` để chắc chắn backend luôn nhận `123456`.)
**Fix chính:** Đổi `<iframe>` → `<webview partition="persist:embed-9router">` (cùng cho OpenClaw). `<webview>` có browsing context riêng, cookie không bị treat third-party. Cần `webPreferences.webviewTag: true` trong `BrowserWindow`. CSS `.embed-frame` chuyển sang `display:flex`/`inline-flex` cho phù hợp.
**Fix phụ:** `ensure9RouterDefaultPassword()` xóa `settings.password` khỏi `db.json` mỗi lần `start9Router()`. Pin `INITIAL_PASSWORD=123456` + `JWT_SECRET=modoroclaw-9router-jwt-secret-stable-v1` qua `env` khi spawn 9router. Hint mật khẩu hiển thị ngay header tab 9Router trong Dashboard.
**Files:** `electron/main.js` (`webviewTag:true`), `electron/ui/dashboard.html` (2 webview tag + CSS + ensureEmbedLoaded/reloadEmbed cập nhật cho webview API).
**Verify:** Mở tab 9Router → login form → nhập `123456` → vào dashboard 9Router thành công, refresh tab vẫn còn session. Backend smoke test: `curl -X POST http://127.0.0.1:20128/api/auth/login -H "Content-Type: application/json" -d '{"password":"123456"}'` → 200.

### Embed 9Router + OpenClaw web UI in dashboard
**Bug:** OpenClaw gateway dùng `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` → không thể embed iframe
**Fix:** `installEmbedHeaderStripper()` trong main.js — qua `session.defaultSession.webRequest.onHeadersReceived`, strip 2 headers CHỈ cho 4 trusted local origins (`127.0.0.1:18789`, `localhost:18789`, `127.0.0.1:20128`, `localhost:20128`)
**Auto-apply:** Gọi 1 lần trong `app.whenReady()` trước `createWindow()`
**Pages mới:** `page-9router` + `page-openclaw` với iframe lazy-load. Sidebar 2 menu item "9Router" + "OpenClaw" thay button cũ.
**Verify:** Click vào page → web UI load trong iframe, không bị frame-blocked. Click "Copy token" → token copy vào clipboard + paste vào OpenClaw login.
