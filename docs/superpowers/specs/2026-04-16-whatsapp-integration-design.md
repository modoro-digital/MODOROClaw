# WhatsApp Integration — Design Spec (Revision 2)

**Version target:** MODOROClaw v2.4.0
**Branch:** `feat/whatsapp-optional` (from `main` @ v2.3.44)
**Est:** 3-4 tuần dev + 1 tuần test + ship
**Author:** devops@modoro.com.vn
**Date:** 2026-04-16
**Revision:** 2 (post-review — corrected architecture assumptions)

## Revision history

- **R1 (2026-04-16):** Initial spec. Rejected by reviewer. 3 HIGH issues: assumed TS source patching (plugin ships compiled JS), fabricated HTTP endpoints, wrong auth path.
- **R2 (2026-04-16):** Rewritten. Hybrid approach combining native plugin config + selective JS patches. Actual plugin API verified from unpacked tarball.

## 1. Goal

Tích hợp WhatsApp làm kênh tùy chọn cho MODOROClaw, Zalo-parity UX (DM + group, 2-mode auto/read, pause, blocklist, per-user memory, group memory view, triple-channel CEO alert), KHÔNG ép khách kết nối khi onboard.

## 2. Non-Goals

- Facebook Messenger (phase sau, không có plugin built-in)
- Lark/Feishu (enterprise model, sai fit thị trường VN)
- Multi-account WhatsApp (chỉ 1 account/install, giống Zalo)
- WhatsApp Business Cloud API (có plugin `openclaw-whatsapp-cloud-api@1.1.0` alternative, nhưng require webhook tunnel → defer v2.5.0 cho khách enterprise)

## 3. Foundation — đã verify từ tarball

`openclaw@2026.4.14` ship sẵn `@openclaw/whatsapp` plugin:

- Dùng `@whiskeysockets/baileys@7.0.0-rc.9` (WhatsApp Web unofficial, QR scan)
- Plugin ship dưới dạng **compiled JS (ESM)** tại `dist/extensions/whatsapp/*.js`
- JS **KHÔNG minified** — tên biến + import preserved → regex patch khả thi
- **Auth persistence**: `resolveWhatsAppAuthDir()` → dir phụ thuộc env `OPENCLAW_OAUTH_DIR` fallback ~/.openclaw/oauth/whatsapp/<accountId>/
- **Readiness check**: `hasAnyWhatsAppAuth()` exported function từ `accounts-*.js`
- **Native features phát hiện**:
  - `normalizeWhatsAppAllowFromEntries` — native `allowFrom` whitelist
  - `resolveWhatsAppGroupRequireMention` — native mention-only gate
  - `resolveWhatsAppGroupToolPolicy` — native group tool policy
  - `whatsappCommandPolicy` — built-in command policy
  - `DEFAULT_WHATSAPP_MEDIA_MAX_MB` — native media limit
  - `jidToE164`, `normalizeE164` — phone number helpers
- **Multi-account schema**: `channels.whatsapp.accounts[<accountId>]` + `defaultAccount` (single-account install vẫn phải dùng schema này)
- **Outbound API**: `sendMessageWhatsApp(to, body, options)` trong `send-*.js` — direct JS function call inside gateway process (KHÔNG phải HTTP endpoint). MODOROClaw gọi qua openclaw CLI hoặc internal hook.

## 4. Architecture

### 4.1. Process layout

```
Electron main (MODOROClaw)
  └── Gateway subprocess (openclaw.mjs gateway run)
        ├── telegram plugin (built-in)
        ├── openzalo plugin (custom fork, TS source ta own)
        └── @openclaw/whatsapp plugin (built-in, JS compiled)
              └── baileys WebSocket → WhatsApp servers
```

Không có subprocess riêng cho WhatsApp. Plugin chạy trong gateway process, giống Telegram.

### 4.2. Directory layout

```
~/.openclaw/
├── openclaw.json                    # thêm channels.whatsapp.accounts.default
└── oauth/whatsapp/default/          # baileys session (plugin tự manage)

<workspace>/
├── memory/
│   ├── whatsapp-users/              ← MỚI
│   └── whatsapp-groups/             ← MỚI
├── config/
│   ├── whatsapp-mode.txt            ← MỚI (auto|read)
│   ├── whatsapp-blocklist.json      ← MỚI
│   ├── whatsapp-group-settings.json ← MỚI (có __default)
│   └── whatsapp-paused.json         ← MỚI
```

### 4.3. Data flow inbound

```
WhatsApp server → baileys WS → plugin inbound handler (JS)
  → native allowFrom check (whitelist) — plugin tự drop nếu không match
  → native groupRequireMention check — plugin tự drop group non-mention
  → MODOROClaw PATCHES (3 patches inject):
      1. blocklist filter (drop senderId trong whatsapp-blocklist.json)
      2. sender dedup (drop duplicate trong 3s window)
      3. system-msg filter (drop messageStubType = group add/remove/rename)
  → dispatch to agent runtime → reply
  → output filter apply on outbound (wrapper tại deliver callback, patch JS)
  → sendMessageWhatsApp → baileys send → khách
```

### 4.4. Data flow outbound (bot-initiated, cron/alert)

```
sendCeoAlert(msg) → Promise.allSettled([
  sendTelegram(msg),     # existing
  sendZalo(msg),         # existing
  sendWhatsApp(msg)      # NEW — spawn openclaw CLI: openclaw msg send whatsapp <jid> <text>
])
```

`sendWhatsApp()` dùng openclaw CLI subprocess (pattern đã dùng cho openzca), KHÔNG call HTTP. Lookup owner JID từ `~/.openclaw/oauth/whatsapp/default/creds.json` (baileys persist).

## 5. Components

### 5.1. Plugin enablement — `ensureDefaultConfig()`

```js
// trong ensureDefaultConfig(), sau block zalo
if (!config.channels.whatsapp) {
  config.channels.whatsapp = {
    enabled: false,                   // default OFF — không chiếm resource khi khách không dùng
    defaultAccount: "default",
    accounts: {
      default: {
        enabled: false,
        allowFrom: [],                // empty = read-only mode (native drop)
        groupRequireMention: false,
        groupPolicy: "open"
      }
    }
  };
  changed = true;
}
```

Field `enabled: false` mặc định → plugin không load, không chiếm resource cho CEO không dùng.

### 5.2. Wizard — optional step mới

File: `electron/ui/wizard.html`

Thêm step 5 (giữa Zalo step 4 và Done step 6): **"Kết nối kênh khác (không bắt buộc)"**

UI:
```
[Tiêu đề] Kênh khác (không bắt buộc)
[Mô tả]   Bạn có thể bỏ qua. Kết nối sau từ Dashboard.

⚠️ Lưu ý WhatsApp: Nên dùng SIM có lịch sử >3 tháng. Có thể dùng
số phụ nếu lo ngại. Không khuyến nghị broadcast, chỉ reply khách.

[ ] WhatsApp          [Kết nối]
[ ] Facebook Messenger (sắp có...)  ← disabled

[Bỏ qua] [Tiếp tục]
```

Click "Kết nối" → expand inline QR modal (spawn `openclaw channels login whatsapp` subprocess, capture QR từ stdout) → scan xong → state saved → next.

### 5.3. Dashboard tab

File: `electron/ui/dashboard.html`

**Sidebar item** sau Zalo:
```
WhatsApp  [dot-xám "chưa kết nối"] / [dot-xanh "+84xxx"]
```

**Page `page-whatsapp`** clone structure từ `page-zalo`:
- Header: tên account (JID normalized E.164) + pause toggle
- 4 sub-tabs: Liên hệ | Nhóm | Cài đặt | Bộ nhớ
- Mode selector (Tự động trả lời | Chỉ đọc + tóm tắt cuối ngày)
- Group default mode dropdown (mention-only | reply-all | off)
- Blocklist manager + group list với per-group mode override
- Bộ nhớ tab: list user + group với view modal (icon tài liệu)

Khi `enabled: false` hoặc chưa login → page hiện CTA "Kết nối WhatsApp" → modal QR.

### 5.4. Channel readiness probe

File: `electron/main.js`

```js
async function probeWhatsAppReady() {
  try {
    // spawn openclaw CLI: openclaw status --channel whatsapp --json
    const res = await spawnOpenClawSafe(['status', '--channel', 'whatsapp', '--json'], {
      timeout: 5000
    });
    if (res.exitCode !== 0) return { ready: false, error: 'cli-failed' };
    const data = JSON.parse(res.stdout);
    return {
      ready: data.connected === true,
      jid: data.jid,
      phone: data.phone,
      lastSeen: data.lastSeen,
      error: data.connected ? null : data.error
    };
  } catch (e) {
    return { ready: false, error: 'probe-failed: ' + e.message };
  }
}
```

Fallback: nếu CLI không có `status` subcommand (khả năng plugin chưa expose), check `hasAnyWhatsAppAuth()` via tiny Node script spawn với plugin require. Third fallback: check `~/.openclaw/oauth/whatsapp/default/creds.json` exist + mtime < 7 ngày.

**OPEN QUESTION O-1:** `openclaw status --channel <x>` có được plugin support không → cần test manual sau khi plugin installed.

Broadcast vào `startChannelStatusBroadcast()` mở rộng từ Telegram+Zalo → triple channel.

### 5.5. `sendWhatsApp()` outbound

```js
async function sendWhatsApp(text) {
  if (isChannelPaused('whatsapp')) return false;
  const filtered = filterSensitiveOutput(text);  // 19 shared patterns
  if (!filtered) return false;

  const ownerJid = await getWhatsAppOwnerJid();  // từ creds.json
  if (!ownerJid) {
    fs.appendFileSync(path.join(workspace, 'logs', 'ceo-alerts-missed.log'),
      `${new Date().toISOString()} WhatsApp no owner: ${text.slice(0,200)}\n`);
    return false;
  }

  // WhatsApp text limit ~4096 chars, ta cap 2000 cho an toàn
  const chunks = splitLongMessage(filtered, 2000);

  for (let i = 0; i < chunks.length; i++) {
    try {
      // random 2-5s delay giữa messages (ban mitigation)
      if (i > 0) await sleep(2000 + Math.random() * 3000);
      const res = await spawnOpenClawSafe([
        'msg', 'send', 'whatsapp', ownerJid, chunks[i]
      ], { timeout: 10000 });
      if (res.exitCode !== 0) throw new Error(res.stderr);
    } catch (e) {
      log('[sendWhatsApp] send failed:', e.message);
      return false;
    }
  }
  return true;
}
```

Dùng `spawnOpenClawSafe` (đã có trong main.js) → absolute node path → shell:false → multi-line safe.

**OPEN QUESTION O-2:** `openclaw msg send whatsapp <jid> <text>` — confirm subcommand + args qua `openclaw msg send --help`.

### 5.6. `sendCeoAlert()` triple channel

```js
async function sendCeoAlert(text) {
  const results = await Promise.allSettled([
    sendTelegram(text),
    sendZalo(text),
    sendWhatsApp(text)  // NEW
  ]);
  const anyOk = results.some(r => r.status === 'fulfilled' && r.value === true);
  if (!anyOk) {
    fs.appendFileSync(path.join(workspace, 'logs', 'ceo-alerts-missed.log'),
      `${new Date().toISOString()} ALL CHANNELS FAILED: ${text}\n`);
  }
  return anyOk;
}
```

Cron delivery tự hưởng.

### 5.7. Native config gates (KHÔNG patch source)

Các filter dưới đây dùng **native plugin config** qua `openclaw config set`:

- **Mode auto/read**: `allowFrom = ["*"]` (auto) hoặc `allowFrom = []` (read, native drop all)
- **Pause**: tạm thời `allowFrom = []`, resume → restore từ saved state
- **Group mention-only**: `groupRequireMention = true` (native)
- **Group reply-all**: `groupRequireMention = false`
- **Media size limit**: `DEFAULT_WHATSAPP_MEDIA_MAX_MB` native (default 10MB OK)

**Config update flow:**
```js
async function setWhatsAppMode(mode) {  // 'auto' | 'read'
  if (mode === 'read') {
    await spawnOpenClawSafe(['config', 'set', 'channels.whatsapp.accounts.default.allowFrom', '[]']);
  } else {
    await spawnOpenClawSafe(['config', 'set', 'channels.whatsapp.accounts.default.allowFrom', '["*"]']);
  }
  fs.writeFileSync(path.join(workspace, 'config', 'whatsapp-mode.txt'), mode);
}
```

**Reload concern:** `openclaw config set` CLI subprocess = external write → trigger gateway reload (pattern đã thấy trong openzalo bug). Mitigation: batch config updates, wrap trong heal function gọi TRƯỚC gateway start (giống `ensureDefaultConfig`).

### 5.8. JS patches (3 patches only)

Plugin JS không minified → regex anchor matching khả thi. Patches inject code vào `dist/extensions/whatsapp/*.js` files, idempotent qua markers.

**5.8.1. `ensureWhatsAppBlocklistFix()`**
- Target file: primary inbound handler trong `dist/extensions/whatsapp/*.js` (cần identify exactly — check `action-runtime.runtime.js` hoặc `runtime-api.js`)
- Inject block ĐẦU inbound handler: đọc `<workspace>/config/whatsapp-blocklist.json`, nếu `senderId` match → return sớm
- Marker: `// === MODOROClaw WHATSAPP BLOCKLIST PATCH v1 ===`

**5.8.2. `ensureWhatsAppSenderDedupFix()`**
- Per-sender Map `global.__waSenderDedup` với TTL 3s, pruned 500 entries / 60s
- Inject ngay sau blocklist patch → chainable
- Marker: `// === MODOROClaw WHATSAPP DEDUP PATCH v1 ===`

**5.8.3. `ensureWhatsAppSystemMsgFix()`**
- Check `message.messageStubType` (baileys enum) cho group system events
- Drop if stubType matches: GROUP_PARTICIPANT_ADD, GROUP_PARTICIPANT_REMOVE, GROUP_PARTICIPANT_LEAVE, GROUP_CHANGE_SUBJECT, GROUP_CHANGE_ICON
- Marker: `// === MODOROClaw WHATSAPP SYSTEM-MSG PATCH v1 ===`

**5.8.4. Output filter at deliver boundary** (NOT a separate patch, part of sendWhatsApp wrapper)
- `filterSensitiveOutput(text)` gọi trong `sendWhatsApp()` trước spawn CLI
- Để pass-through cho inbound reply (khi agent reply trả qua plugin), patch `deliver` callback trong action-runtime.runtime.js tương tự openzalo v4
- Marker: `// === MODOROClaw WHATSAPP OUTPUT-FILTER PATCH v1 ===`

**Patch locations TBD — cần tarball inspection chi tiết trong plan phase.**

**OPEN QUESTION O-3:** Xác định exact file + anchor string cho 3 patches. Dispatch agent đọc `action-runtime.runtime.js` và inbound handler trong impl plan phase.

### 5.9. Per-user + per-group memory

Clone Zalo implementation:
- `appendWhatsAppUserSummary(userId, summary)` — pattern `appendPerCustomerSummaries`, trim 50KB cap
- `appendWhatsAppGroupSummary(groupId, summary)` — trim 50KB cap
- `seedWorkspace()` tạo `memory/whatsapp-users/`, `memory/whatsapp-groups/`

File content pattern giống Zalo:
```markdown
---
id: 84901234567
name: Nguyễn Văn A
firstSeen: 2026-04-20
---

## 2026-04-20
Khách hỏi giá iPhone 15, đã báo 25.9M...
```

### 5.10. Watchdog + auto-reconnect

Extend existing watchdog loop:

```js
const waStatus = await probeWhatsAppReady();
if (!waStatus.ready && global._waWasConnected) {
  if (!global._waReconnectStartedAt) {
    global._waReconnectStartedAt = Date.now();
    log('[watchdog] WhatsApp disconnected — silent auto-reconnect...');
  }
  const downMs = Date.now() - global._waReconnectStartedAt;
  if (downMs > 5 * 60 * 1000 && !global._waAlertSent) {
    global._waAlertSent = true;
    await sendTelegram('[Cảnh báo WhatsApp] Kết nối đã mất >5 phút. Có thể cần scan QR lại.');
  }
} else if (waStatus.ready) {
  global._waWasConnected = true;
  global._waReconnectStartedAt = null;
  global._waAlertSent = false;
}
```

**KHÔNG kill gateway** khi WhatsApp down (learning từ Zalo watchdog cascade v2.3.43). Log + alert only.

### 5.11. Preload + IPC bridges

File: `electron/preload.js` — 10 bridges mới:

- `probeWhatsAppReady()`
- `pauseWhatsApp(minutes)` / `resumeWhatsApp()` / `getWhatsAppPauseStatus()`
- `getWhatsAppContacts()` / `getWhatsAppGroups()` / `getWhatsAppGroupMemory(groupId)` / `getWhatsAppUserMemory(jid)`
- `setWhatsAppMode(mode)` / `getWhatsAppMode()`
- `updateWhatsAppDefaultGroupMode(mode)` / `updateWhatsAppGroupMode(groupId, mode)`
- `updateWhatsAppBlocklist(jids)`
- `openWhatsAppQrLogin()` / `logoutWhatsApp()`

### 5.12. AGENTS.md rules

Extend v44 → v45:

- Section "Kênh WhatsApp" — rules y hệt Zalo: Vietnamese diacritics, anti-citation, first-greeting idempotency (write-then-send), bot-vs-bot detection (6 signals), pause honoring, system event drop (prose backup to code filter)
- **Phone-ban mitigation rules**: không gửi duplicate template cho nhiều người trong cùng 5 phút; random delay 2-5s đã handle code-level nhưng AGENTS.md cũng nhắc LLM để vary text tự nhiên

### 5.13. Phone-ban mitigation summary

1. Wizard hiển thị warning về SIM history (>3 tháng khuyến nghị, số phụ được accept)
2. `sendWhatsApp()` random delay 2-5s giữa multi-chunk
3. Rate limit: max 100 outbound tin/giờ per account (hard cap enforced in sendWhatsApp)
4. AGENTS.md vary response text tự nhiên, không boilerplate
5. Plugin `blurb` đã warn "recommend a separate phone + eSIM" — giữ nguyên hiển thị

## 6. Reliability — Rule #1 compliance

- `ensureDefaultConfig()` heal `channels.whatsapp.accounts.default` mỗi boot
- `ensureWhatsAppBlocklistFix/SenderDedupFix/SystemMsgFix/OutputFilterFix` x4 patches re-apply mỗi `startOpenClaw()`, idempotent qua markers
- Patches target specific version — khi openclaw update, smoke test check anchor match
- `seedWorkspace()` tạo `memory/whatsapp-*/`, `config/whatsapp-*` templates
- `RESET.bat` xóa runtime → `seedWorkspace()` re-seed
- Smoke test extends: verify plugin version match + anchor strings còn exist trong compiled JS
- **Pin `@openclaw/whatsapp` version** bằng cách pin openclaw core (đã có trong PINNING.md) — không cho upgrade openclaw mà không re-test WhatsApp

## 7. Testing strategy

### 7.1. Unit (dev machine)
- Patch injection idempotency: run each ensure*Fix() 5 lần → file không phình, markers count = 1
- `sendWhatsApp` split logic: messages 500 / 2500 / 6000 chars → chunk đúng, delay enforced
- `sendCeoAlert` với 3 channels, simulate 1/2/3 failures
- Mode switcher: setWhatsAppMode('read') → allowFrom becomes [], restore OK

### 7.2. Integration (dev WhatsApp test number)
- Fresh install + skip WhatsApp → onboard OK, sidebar dot "chưa kết nối"
- Fresh install + tick WhatsApp → scan QR → login → nhắn bot → reply OK
- Existing install → dashboard click "Kết nối" → modal QR → login → tab populate
- Mode gate: set read → khách nhắn → bot im lặng, `openclaw.log` show `dropped by allowFrom`
- Pause: 10 min pause → khách nhắn → bot im → resume → reply
- Blocklist: add jid → khách nhắn → bot im (JS patch drops)
- Group: add bot vào group → default mode off → im → đổi mention → chỉ reply khi @ → đổi all → reply mọi tin
- System event: kick/invite group member → bot KHÔNG reply (JS patch)

### 7.3. Soak test (7 ngày, 1 dev account)
- Chạy 7 ngày liên tục, restart Electron daily
- Session persist (không rescan QR)
- Patches re-apply zero error
- Memory files không phình >50KB
- Watchdog false-positive rate <1%

### 7.4. E2E (1 CEO volunteer — 48h dry run trước public ship)
- CEO có WhatsApp SIM >6 tháng history
- Monitor: `ceo-alerts-missed.log`, `security-output-filter.jsonl`, `openclaw.log`
- Verify triple alert đúng (Telegram + Zalo + WhatsApp cùng nhận boot ping)
- Ban check: WhatsApp account status sau 48h OK

## 8. Rollback

- Branch `feat/whatsapp-optional` từ main
- Critical bug post-ship:
  - Soft rollback: auto config patch `channels.whatsapp.enabled = false` → disable WhatsApp, app running
  - Hard rollback: v2.4.1 revert WhatsApp code
- Cherry-pick main hotfixes vào branch khi branch đang dev (default pattern)

## 9. Migration — existing installs

- Fresh install: no migration
- v2.3.x → v2.4.0 upgrade:
  1. Auto-update fires
  2. Restart → `ensureDefaultConfig()` thêm `channels.whatsapp.accounts.default` (enabled:false)
  3. `seedWorkspace()` tạo `memory/whatsapp-*`, `config/whatsapp-*`
  4. Dashboard sidebar thêm WhatsApp item "chưa kết nối"
  5. CEO click khi sẵn sàng, không bị ép
- Zero disruption Zalo/Telegram existing flow

## 10. Open questions

**O-1:** `openclaw status --channel whatsapp --json` có support không? Check `openclaw status --help` sau plugin installed. Fallback plan đã có (hasAnyWhatsAppAuth → filesystem check).

**O-2:** `openclaw msg send whatsapp <jid> <text>` command format + escape rule? Check `openclaw msg send --help` in impl phase.

**O-3:** Exact file location + anchor strings cho 3 patches (blocklist, dedup, system-msg) trong `dist/extensions/whatsapp/*.js`. Dispatch agent đọc `action-runtime.runtime.js`, `runtime-api.js`, `channel-plugin-api.js` trong impl phase.

**O-4:** `messageStubType` enum values cho group events — reverse từ baileys source (`@whiskeysockets/baileys/lib/Types/Message.ts`).

**O-5:** `openclaw config set channels.whatsapp.accounts.default.allowFrom '[]'` array-type CLI syntax OK? Check CLI grammar.

**O-6:** QR refresh cadence khi login (baileys default 20s). Expose trong UI hay chấp nhận baileys default.

**Block impl plan cho đến khi O-1 qua O-5 resolve** (O-6 có default acceptable).

## 11. Success criteria

1. Fresh install CEO không dùng WhatsApp → onboard <3 phút, không thấy WhatsApp UI interrupt
2. Fresh install CEO dùng WhatsApp → scan QR → bot reply trong <5 phút total
3. Existing v2.3.44 → v2.4.0 upgrade → zero disruption Zalo/Telegram 24h observation
4. Customer test concurrent WhatsApp + Zalo + Telegram 1 giờ → 0 cross-talk, 0 leak, 0 output filter FP
5. Watchdog test: kill WhatsApp session → auto-reconnect 30s-5min → KHÔNG kill gateway, KHÔNG disrupt Zalo/Telegram
6. `ceo-alerts-missed.log` trống sau 7 ngày soak
7. Smoke test pass fresh + existing install (patch anchors match, openclaw version pinned)
8. Ban check: 1 CEO 48h dry run → account vẫn OK

---

**Next step:** dispatch spec-document-reviewer subagent lần 2. Fix tất cả HIGH/MED/LOW còn lại. Khi approved, invoke `writing-plans` skill để tạo impl plan.
