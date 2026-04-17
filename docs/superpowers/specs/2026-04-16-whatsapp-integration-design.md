# WhatsApp Integration — Design Spec (R5 — source patch at runtime-api.js)

**Version target:** MODOROClaw v2.4.0
**Branch:** `feat/whatsapp-optional` (from `main` @ v2.3.44)
**Est:** 2 tuần dev + 3 ngày test + ship
**Author:** devops@modoro.com.vn
**Date:** 2026-04-16
**Revision:** 5 (source patch at runtime-api.js re-export boundary — shim dropped)

## Revision history

- **R1:** Rejected. Assumed TS source patching (plugin ships JS).
- **R2:** Rejected. 4 new HIGH: fake CLI commands, wrong patch target, `allowFrom=[]` semantic conflict with `dmPolicy`.
- **R3:** MVP scope cut. Drop all JS patches (blocklist/dedup/system-msg/output-filter). Native plugin config only. LLM rule fallback for 3 edge cases.
- **R3.1:** R3 review corrections applied:
  - Probe output shape: `channelAccounts.whatsapp[]` (NOT top-level `channels[]`)
  - DmPolicy enum values: `"pairing" | "allowlist" | "open" | "disabled"` (no `"all"`)
  - `dmPolicy: "open"` REQUIRES `allowFrom: ["*"]` (validator `requireOpenAllowFrom` rejects empty)
  - Default `groupPolicy` is `"allowlist"`, not `"open"`
  - QR capture: plain stdout works — `connection-controller-*.js` sets `printQRInTerminal:false`, QR flows through `opts.onQr?.(qr)` callback, no TTY needed. `node-pty` dropped.
  - O-C priority bumped: concrete pause-queue test required Day 1 (does `dmPolicy: "disabled"` prevent inbound dispatch, or just defer with queued burst on resume?)
- **R4:** User rejected LLM-only filter for blocklist ("chỉ block ở level llm ko đc đâu"). Add Node `--require` preload shim to monkey-patch plugin exports at gateway spawn time. Restores code-level gate for blocklist + system-msg + dedup WITHOUT patching plugin source or forking. Timeline bumps 2 → 2.5-3 tuần.
- **R5:** R4 CRITICAL fail. openclaw is pure ESM (`"type": "module"`, uses `await import()`). `Module._load` hook only intercepts CommonJS `require()` — shim never fires, silent. Switched to source patch approach: target `dist/extensions/whatsapp/runtime-api.js` (stable filename, re-export boundary), inject wrapper via import-rename + const-shadow pattern. Same auto-restore `ensureXxxFix` pattern as openzalo — proven 6 times. Timeline back to 2 tuần.

## 1. Goal

Ship WhatsApp channel (optional) trong v2.4.0 với Zalo-parity UX. Code-level gate cho blocklist/dedup/system-msg/pause qua `ensureWhatsAppRuntimeFix()` patching `dist/extensions/whatsapp/runtime-api.js` (stable filename, re-export boundary). Same auto-restore pattern as 6 existing `ensureZalo*Fix` patches. Fresh-install parity per CLAUDE.md Rule #1.

## 2. Scope

### 2.1. IN (v2.4.0)

- Wizard optional step "Kết nối WhatsApp" (QR scan)
- Dashboard sidebar + tab WhatsApp (clone Zalo structure)
- 2-mode: Tự động trả lời (auto) | Chỉ đọc + tóm tắt cuối ngày (read)
- Group mode toggle: mention-only | reply-all | off
- Pause/resume toggle
- Outbound `sendWhatsApp()` + triple-channel `sendCeoAlert()`
- Per-user + per-group memory (clone Zalo `memory/`)
- Memory view modal
- Phone-ban mitigation: random delay 2-5s, rate cap 100/giờ, SIM warning trong wizard
- AGENTS.md rules mở rộng cho WhatsApp (Vietnamese diacritics, first-greeting, bot-vs-bot, pause honor)
- **Source patch** `ensureWhatsAppRuntimeFix()` targeting `dist/extensions/whatsapp/runtime-api.js`:
  - Code-level blocklist gate (wrap `sendMessageWhatsApp` + `monitorWebInbox`)
  - Code-level sender dedup (wrap `monitorWebInbox`, per-sender Map TTL 3s)
  - Code-level system-msg filter (wrap `monitorWebInbox`, drop baileys `messageStubType` group events)
  - Code-level pause gate (wrap `monitorWebInbox`, read `whatsapp-paused.json`)
  - Auto-restore mỗi `startOpenClaw()` — same pattern as `ensureZaloBlocklistFix`

### 2.2. OUT (defer v2.5.0+)

- Output filter plugin-side patch (plugin already calls `sanitizeAssistantVisibleText`; MODOROClaw `filterSensitiveOutput` runs on bot-initiated sends via `sendWhatsApp` wrapper)
- Facebook Messenger (no plugin built-in)
- Lark/Feishu (wrong fit)
- Multi-account WhatsApp
- WhatsApp Cloud API (defer v2.5.0+ cho enterprise khách)

### 2.3. Accepted risks

- **Patch anchor drift**: `ensureWhatsAppRuntimeFix()` uses regex on stable function names (`sendMessageWhatsApp`, `monitorWebInbox`) in `runtime-api.js`. If openclaw upgrade restructures this file or renames exports, patch fails to apply → fallback to unpatched plugin (code-level gates inactive). Mitigation: smoke test verifies anchor strings match BEFORE build; CI fails if mismatch. Patch applies idempotent marker `// === MODOROClaw WHATSAPP RUNTIME PATCH v1 ===`.
- **Pause queue**: pause via file-based check inside patched `monitorWebInbox` wrapper (NOT `dmPolicy` flip). Baileys WS keeps running, but wrapper drops all inbound until `whatsapp-paused.json` expires. Zero queue-on-resume risk.
- **Dedupe-key leak on early-return**: wrapper early-returns (pause/blocked/system-msg/dup) bypass plugin's `finalizeInboundDedupe()` inside `attachWebInboxToSocket`. On socket reconnect, baileys may re-deliver same message — wrapper drops again (idempotent via our `__mcDedup` Map with TTL), but plugin-side dedupe keys stay unclaimed. Accepted: memory bounded by our 500-entry/60s TTL prune. Alternative (rejected as over-engineering): pass sentinel through `origOnMessage` to let finalization run.
- **Baileys stub ID drift**: `GROUP_STUB_TYPES` hardcodes IDs 20-32 (stable across baileys 6.x-7.x). Mitigation: widen range check to `t >= 20 && t <= 40` as safety margin; smoke test asserts baileys version still matches pinned one.

## 3. Foundation — verified from tarball

- `openclaw@2026.4.14` ship sẵn `@openclaw/whatsapp` plugin (baileys 7.0.0-rc.9)
- Plugin ship compiled JS ESM, KHÔNG minified (tên biến preserved)
- **Auth path**: `resolveWhatsAppAuthDir({cfg, accountId:'default'}).authDir` — gọi in-process, không hardcode
- **Readiness**: `hasAnyWhatsAppAuth()` exported từ `accounts-*.js`
- **Native features used**:
  - `dmPolicy: "open"|"disabled"|"pairing"` — chính thức gate cho DM
  - `allowFrom` whitelist (leave empty for all-allow default)
  - `groupRequireMention: true|false` — mention-only gate group
  - `groupAllowFrom` — whitelist group JIDs
  - `DEFAULT_WHATSAPP_MEDIA_MAX_MB = 50` (default OK, không override)
  - `sanitizeAssistantVisibleText` — plugin tự sanitize output khi reply
- **Multi-account schema (bắt buộc)**: `channels.whatsapp.accounts.<id>` + `defaultAccount`
- **Outbound**: `openclaw message send --channel whatsapp --account default -t <jid> -m <text> --json`
- **Status**: `openclaw channels status --probe --json` (parse WhatsApp section)
- **Login**: `openclaw channels login --channel whatsapp` (spawn subprocess, capture QR từ stdout — cần verify TTY requirement)

## 4. Architecture

### 4.1. Process layout

```
Electron main (MODOROClaw)
  └── ensureWhatsAppRuntimeFix() patches runtime-api.js BEFORE gateway spawn
  └── Gateway subprocess (openclaw.mjs gateway run)
        ├── telegram plugin (untouched)
        ├── openzalo plugin (patched in separate TS source — unchanged)
        └── @openclaw/whatsapp plugin (patched runtime-api.js)
              └── baileys WebSocket → WhatsApp servers
```

### 4.2. Directory layout

```
~/.openclaw/
├── openclaw.json                    # channels.whatsapp.accounts.default
└── oauth/whatsapp/default/          # baileys session — plugin tự manage

<workspace>/
├── memory/
│   ├── whatsapp-users/
│   └── whatsapp-groups/
└── config/
    ├── whatsapp-mode.txt            # auto | read (patched runtime reads this)
    ├── whatsapp-blocklist.json      # patched runtime reads this
    ├── whatsapp-group-settings.json # __default + per-group override
    ├── whatsapp-paused.json         # patched runtime reads this
    └── whatsapp-saved-dmpolicy.json # save original dmPolicy for mode toggle restore
```

### 4.3. Data flow inbound (native gate only)

```
WhatsApp server → baileys WS → plugin monitorWebInbox (PATCHED)
  → MODOROClaw wrapper checks inside monitorWebInbox callback:
      - pause check (whatsapp-paused.json) → drop if paused
      - mode=read check (whatsapp-mode.txt) → drop if read
      - blocklist check (whatsapp-blocklist.json) → drop if sender blocked
      - system-msg check (messageStubType ∈ group events enum) → drop
      - dedup check (per-sender Map, TTL 3s) → drop if duplicate
  → plugin native allowFrom + groupRequireMention checks
  → dispatch to agent runtime
  → agent reply
  → plugin sanitizeAssistantVisibleText
  → sendMessageWhatsApp (PATCHED):
      - blocklist check (outbound defense-in-depth) → drop if target blocked
  → baileys send
```

### 4.4. Data flow outbound (bot-initiated)

```
sendCeoAlert(msg) → Promise.allSettled([
  sendTelegram(msg),
  sendZalo(msg),
  sendWhatsApp(msg)  # NEW
])

sendWhatsApp(msg):
  isChannelPaused check
  filterSensitiveOutput (19 shared patterns)
  split into chunks (2000 char cap)
  for each chunk:
    random delay 2-5s (ban mitigation)
    spawnOpenClawSafe(['message', 'send', '--channel', 'whatsapp',
                       '--account', 'default', '-t', ownerJid,
                       '-m', chunk, '--json'])
```

## 5. Components

### 5.1. Plugin enablement — `ensureDefaultConfig()`

Config default (heal mỗi boot):

```js
if (!config.channels.whatsapp) {
  config.channels.whatsapp = {
    enabled: false,            // default OFF — không load plugin khi khách không dùng
    defaultAccount: "default",
    accounts: {
      default: {
        enabled: false,
        dmPolicy: "pairing",       // plugin default; flip to "open" post-login if CEO wants open-DM
        allowFrom: ["*"],          // REQUIRED when dmPolicy="open" (validator requireOpenAllowFrom)
        groupRequireMention: false,
        groupAllowFrom: ["*"],     // mirror allowFrom pattern
        groupPolicy: "allowlist"   // plugin default (NOT "open" — would trigger validator)
      }
    }
  };
  changed = true;
}

// Migration guard — nếu user có config từ R1/R2 với shape cũ
const waAcc = config.channels.whatsapp?.accounts?.default;
if (waAcc && waAcc.dmPolicy === undefined) {
  waAcc.dmPolicy = "open";
  changed = true;
}
```

**IMPORTANT (from O-7):** TẤT CẢ config mutations trong runtime (mode toggle, pause/resume) PHẢI đi qua `writeOpenClawConfigIfChanged()` helper IN-PROCESS, KHÔNG shell out `openclaw config set`. Lý do: CLI subprocess = external write → trigger gateway reload cascade (bug đã thấy trong openzalo v2.3.x "Gateway is restarting" loop). Pattern đã có sẵn trong `main.js`.

### 5.2. Wizard — optional step

File: `electron/ui/wizard.html`

Thêm step 5 (sau Zalo, trước Done): **"Kết nối kênh khác (không bắt buộc)"**

```
Kênh khác (không bắt buộc)
Bạn có thể bỏ qua. Kết nối sau từ Dashboard.

Lưu ý WhatsApp:
 - Nên dùng SIM có lịch sử >3 tháng
 - Có thể dùng số phụ nếu lo ngại
 - Không broadcast, chỉ reply khách đến
 - Filter blocklist/system-event phụ thuộc AI, không đảm bảo 100%

[ ] WhatsApp              [Kết nối]
[ ] Facebook (sắp có...)   disabled

[Bỏ qua] [Tiếp tục]
```

**QR flow (O-8 block):**
- Click "Kết nối" → spawn `openclaw channels login --channel whatsapp` subprocess với `shell:false`
- Monitor stdout stream → detect QR ASCII / base64 / image hint
- Nếu plugin require TTY (likely vì `qrcode-terminal` in deps) → use `node-pty` to spawn with pseudo-TTY, capture terminal output, convert ASCII QR block → `<pre>` trong modal HTML
- Verify QR refresh cadence (default ~20s baileys)

**Verification test for O-8 (do first in impl phase):**
```bash
openclaw channels login --channel whatsapp --account default
# Capture: does it emit QR bytes to stdout? Require TTY? Exit when done?
```

### 5.3. Dashboard tab

File: `electron/ui/dashboard.html`

Clone `page-zalo` structure:
- Sidebar item "WhatsApp" với dot state
- Page header: account name (E.164 from `jidToE164`) + connected since + pause toggle
- 4 sub-tabs: Liên hệ | Nhóm | Cài đặt | Bộ nhớ
- Mode radio: Tự động trả lời | Chỉ đọc + tóm tắt cuối ngày
- Group default dropdown: mention-only | reply-all | off
- Blocklist UI: add/remove JIDs (writes `whatsapp-blocklist.json`, AGENTS.md reads)
- Group list với per-group mode override
- Bộ nhớ tab: list user + group files với view modal

Khi `enabled: false` hoặc chưa login → CTA "Kết nối WhatsApp" → QR modal.

### 5.4. Channel readiness probe

```js
async function probeWhatsAppReady() {
  try {
    const res = await spawnOpenClawSafe(
      ['channels', 'status', '--probe', '--json'],
      { timeout: 6000 }
    );
    if (res.exitCode !== 0) return { ready: false, error: 'cli-failed' };
    const data = JSON.parse(res.stdout);
    // Gateway payload shape: { channelAccounts: { whatsapp: [{ accountId, connected, ... }] } }
    const accounts = data.channelAccounts?.whatsapp || [];
    const acc = accounts.find(a => (a.accountId || 'default') === 'default');
    if (!acc) return { ready: false, error: 'not-configured' };
    return {
      ready: acc.connected === true,
      accountId: acc.accountId || 'default',
      probe: acc.probe,          // plugin-specific sub-fields live here
      dmPolicy: acc.dmPolicy,
      error: acc.lastError || null
    };
    // jid/phone derived separately from creds.json (see getWhatsAppOwnerJid, Tier 2)
  } catch (e) {
    // Fallback: filesystem check
    try {
      const authDir = path.join(os.homedir(), '.openclaw', 'oauth', 'whatsapp', 'default');
      const credsPath = path.join(authDir, 'creds.json');
      if (fs.existsSync(credsPath)) {
        const mtime = fs.statSync(credsPath).mtime;
        if (Date.now() - mtime.getTime() < 7 * 24 * 60 * 60 * 1000) {
          return { ready: true, error: 'probe-fallback-fs' };
        }
      }
    } catch {}
    return { ready: false, error: 'probe-failed' };
  }
}
```

Broadcast extends `startChannelStatusBroadcast()` từ dual → triple channel.

### 5.5. `sendWhatsApp()` outbound

```js
async function sendWhatsApp(text) {
  if (isChannelPaused('whatsapp')) return false;
  const filtered = filterSensitiveOutput(text);
  if (!filtered) return false;

  const ownerJid = await getWhatsAppOwnerJid();
  if (!ownerJid) {
    await appendMissedAlert('whatsapp', text);
    return false;
  }

  // Rate cap: 100 outbound/hour
  if (checkWhatsAppRateCap()) {
    log('[sendWhatsApp] rate cap hit — skip');
    await appendMissedAlert('whatsapp-rate-capped', text);
    return false;
  }

  const chunks = splitLongMessage(filtered, 2000);

  for (let i = 0; i < chunks.length; i++) {
    try {
      if (i > 0) await sleep(2000 + Math.random() * 3000);
      const res = await spawnOpenClawSafe([
        'message', 'send',
        '--channel', 'whatsapp',
        '--account', 'default',
        '-t', ownerJid,
        '-m', chunks[i],
        '--json'
      ], { timeout: 10000, allowCmdShellFallback: false });
      if (res.exitCode !== 0) throw new Error(res.stderr || 'send failed');
      incrementWhatsAppRateCounter();
    } catch (e) {
      log('[sendWhatsApp] send failed:', e.message);
      return false;
    }
  }
  return true;
}

async function getWhatsAppOwnerJid() {
  // Tier 1: cached from last successful probe
  if (global._waOwnerJidCache && Date.now() - global._waOwnerJidCache.at < 3600_000) {
    return global._waOwnerJidCache.jid;
  }
  // Tier 2: parse creds.json from auth dir
  try {
    const authDir = path.join(os.homedir(), '.openclaw', 'oauth', 'whatsapp', 'default');
    const credsPath = path.join(authDir, 'creds.json');
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    const jid = creds.me?.id || creds.account?.details?.accountNumber;
    if (jid) {
      global._waOwnerJidCache = { jid, at: Date.now() };
      return jid;
    }
  } catch {}
  // Tier 3: probe
  const status = await probeWhatsAppReady();
  if (status.ready && status.jid) {
    global._waOwnerJidCache = { jid: status.jid, at: Date.now() };
    return status.jid;
  }
  return null;
}
```

### 5.6. `sendCeoAlert()` triple channel

```js
async function sendCeoAlert(text) {
  const results = await Promise.allSettled([
    sendTelegram(text),
    sendZalo(text),
    sendWhatsApp(text)
  ]);
  const anyOk = results.some(r => r.status === 'fulfilled' && r.value === true);
  if (!anyOk) {
    await appendMissedAlert('all-channels-failed', text);
  }
  return anyOk;
}
```

### 5.7. Mode / pause (in-process config mutation)

**Mode switching:**
```js
async function setWhatsAppMode(mode) {  // 'auto' | 'read'
  const config = readOpenClawConfig();
  const acc = config.channels?.whatsapp?.accounts?.default;
  if (!acc) return false;

  if (mode === 'read') {
    // Save current dmPolicy if not already saved
    if (!existsSavedDmPolicy('whatsapp')) {
      saveDmPolicy('whatsapp', acc.dmPolicy || 'open');
    }
    acc.dmPolicy = 'disabled';
  } else {
    const saved = loadSavedDmPolicy('whatsapp');
    acc.dmPolicy = saved || 'open';
    clearSavedDmPolicy('whatsapp');
  }

  writeOpenClawConfigIfChanged(config);  // byte-equal helper — skip if unchanged
  fs.writeFileSync(path.join(workspace, 'config', 'whatsapp-mode.txt'), mode);

  // Trigger gateway in-process reload via existing heal pattern
  // (do NOT shell out config set)
}
```

**Pause:**
```js
async function pauseWhatsApp(minutes) {
  // Dual protection:
  // 1. File-based pause (existing pattern, sendWhatsApp checks)
  fs.writeFileSync(
    path.join(workspace, 'config', 'whatsapp-paused.json'),
    JSON.stringify({ until: Date.now() + minutes * 60000 })
  );
  // 2. dmPolicy flip (stops plugin from dispatching inbound to agent at all)
  //    Save current, set disabled — mirrors setWhatsAppMode('read')
  const config = readOpenClawConfig();
  const acc = config.channels?.whatsapp?.accounts?.default;
  if (acc) {
    if (!existsSavedDmPolicy('whatsapp-pause')) {
      saveDmPolicy('whatsapp-pause', acc.dmPolicy || 'open');
    }
    acc.dmPolicy = 'disabled';
    writeOpenClawConfigIfChanged(config);
  }
}

async function resumeWhatsApp() {
  try { fs.unlinkSync(path.join(workspace, 'config', 'whatsapp-paused.json')); } catch {}
  const saved = loadSavedDmPolicy('whatsapp-pause');
  if (saved) {
    const config = readOpenClawConfig();
    const acc = config.channels?.whatsapp?.accounts?.default;
    if (acc) {
      acc.dmPolicy = saved;
      writeOpenClawConfigIfChanged(config);
      clearSavedDmPolicy('whatsapp-pause');
    }
  }
}
```

Persistence files (`whatsapp-saved-dmpolicy.json`) used để save+restore original policy khi unpause/un-read-mode.

### 5.7b. Source patch — `ensureWhatsAppRuntimeFix()`

Same pattern as existing `ensureZaloBlocklistFix` / `ensureZaloModeFix` / etc. Target stable file `dist/extensions/whatsapp/runtime-api.js` in installed plugin. Re-apply every `startOpenClaw()`, idempotent via marker.

**Why runtime-api.js specifically:**
- Stable filename (not content-hashed like `send-<hash>.js` or `login-<hash>.js`)
- Re-exports both `sendMessageWhatsApp` (outbound) and `monitorWebInbox` (inbound) from hashed files
- Wrapping at this boundary = one file patched, all usages covered

**Patch strategy (import-rename + const-shadow):**

Original file structure (verified from tarball):
```js
// line 31 (unchanged filename, hash varies)
import { n as sendPollWhatsApp, r as sendReactionWhatsApp, t as sendMessageWhatsApp } from "../../send-BJuTARpY.js";

// line 42
import { ..., r as monitorWebInbox, ... } from "../../login-D1rNuBKz.js";

// line 323 (re-export)
export { ..., monitorWebInbox, sendMessageWhatsApp, ... };
```

Patched:
```js
// MODIFIED line 31 — rename aliases
import { n as sendPollWhatsApp, r as sendReactionWhatsApp, t as __origSendMessageWhatsApp } from "../../send-BJuTARpY.js";

// MODIFIED line 42
import { ..., r as __origMonitorWebInbox, ... } from "../../login-D1rNuBKz.js";

// === MODOROClaw WHATSAPP RUNTIME PATCH v1 ===
// Injected BELOW imports, ABOVE first function definition
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const __mcWorkspace = process.env.MODORO_WORKSPACE
  || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'modoro-claw')
     : process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming', 'modoro-claw')
     : path.join(os.homedir(), '.config', 'modoro-claw'));

const __mcDedup = new Map();
const GROUP_STUB_TYPES = new Set([20, 21, 22, 24, 25, 27, 28, 29, 30, 31, 32]);

function __mcReadJson(rel, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(__mcWorkspace, rel), 'utf8')); }
  catch { return fallback; }
}
function __mcIsBlocked(jid) {
  const list = __mcReadJson('config/whatsapp-blocklist.json', []);
  const norm = String(jid).replace(/@.*/, '').replace(/^\+/, '');
  return list.includes(norm) || list.includes(String(jid));
}
function __mcIsPaused() {
  const p = __mcReadJson('config/whatsapp-paused.json', null);
  return p && p.until && p.until > Date.now();
}
function __mcIsReadMode() {
  try {
    const m = fs.readFileSync(path.join(__mcWorkspace, 'config/whatsapp-mode.txt'), 'utf8').trim();
    return m === 'read';
  } catch { return false; }
}
function __mcIsSystemEvent(msg) {
  const t = msg?.messageStubType;
  // Widened to 20-40 as safety margin against baileys stub ID drift
  return typeof t === 'number' && (GROUP_STUB_TYPES.has(t) || (t >= 20 && t <= 40));
}
function __mcIsDuplicate(senderJid, body) {
  const key = senderJid + ':' + String(body || '').slice(0, 200);
  const now = Date.now();
  const last = __mcDedup.get(key);
  if (last && now - last < 3000) return true;
  __mcDedup.set(key, now);
  if (__mcDedup.size > 500) {
    const cutoff = now - 60000;
    for (const [k, v] of __mcDedup) if (v < cutoff) __mcDedup.delete(k);
  }
  return false;
}

const sendMessageWhatsApp = async function(to, body, opts) {
  if (__mcIsBlocked(to)) {
    console.log('[modoro-wa] drop outbound to blocked jid:', to);
    return { dropped: 'blocklist' };
  }
  return __origSendMessageWhatsApp(to, body, opts);
};

const monitorWebInbox = function(options) {
  const origOnMessage = options?.onMessage;
  if (origOnMessage) {
    options = {
      ...options,
      onMessage: (msg) => {
        if (__mcIsPaused()) return;
        if (__mcIsReadMode()) return;
        const from = msg?.from || msg?.sender || msg?.key?.remoteJid;
        if (from && __mcIsBlocked(from)) return;
        if (__mcIsSystemEvent(msg)) return;
        const body = msg?.body || msg?.text || msg?.conversation || '';
        if (from && __mcIsDuplicate(from, body)) return;
        return origOnMessage(msg);
      }
    };
  }
  return __origMonitorWebInbox(options);
};
// === END MODOROClaw WHATSAPP RUNTIME PATCH v1 ===

// original function definitions continue unchanged...
// line 323 re-export: `sendMessageWhatsApp` and `monitorWebInbox` now resolve to our wrappers (const shadows)
```

**`ensureWhatsAppRuntimeFix()` implementation** (in `electron/main.js`):

```js
function ensureWhatsAppRuntimeFix() {
  const pluginDir = path.join(getVendorDir(), 'node_modules', 'openclaw', 'dist', 'extensions', 'whatsapp');
  const filePath = path.join(pluginDir, 'runtime-api.js');
  if (!fs.existsSync(filePath)) {
    log('[ensureWhatsAppRuntimeFix] runtime-api.js not found — plugin may not be installed yet');
    return false;
  }
  let content = fs.readFileSync(filePath, 'utf8');
  const MARKER_START = '// === MODOROClaw WHATSAPP RUNTIME PATCH v1 ===';
  const MARKER_END = '// === END MODOROClaw WHATSAPP RUNTIME PATCH v1 ===';
  if (content.includes(MARKER_START)) {
    log('[ensureWhatsAppRuntimeFix] already patched');
    return true;
  }
  // Anchor 1: `t as sendMessageWhatsApp` import line
  const m1 = content.match(/(\{\s*n as sendPollWhatsApp,\s*r as sendReactionWhatsApp,\s*)t as sendMessageWhatsApp(\s*\})/);
  if (!m1) {
    log('[ensureWhatsAppRuntimeFix] anchor 1 (sendMessageWhatsApp import) not found — openclaw may have restructured');
    return false;
  }
  content = content.replace(m1[0], `${m1[1]}t as __origSendMessageWhatsApp${m1[2]}`);
  // Anchor 2: monitorWebInbox import (specific pattern with `r as monitorWebInbox`)
  const m2 = content.match(/(r as )monitorWebInbox(,)/);
  if (!m2) {
    log('[ensureWhatsAppRuntimeFix] anchor 2 (monitorWebInbox import) not found');
    return false;
  }
  content = content.replace(m2[0], `${m2[1]}__origMonitorWebInbox${m2[2]}`);
  // Anchor 3: inject patch block AFTER last import, BEFORE first #region or function
  const firstRegion = content.indexOf('//#region');
  if (firstRegion === -1) {
    log('[ensureWhatsAppRuntimeFix] anchor 3 (first #region) not found');
    return false;
  }
  const patchBlock = /* PATCH_BLOCK_HERE — defined as string constant */;
  content = content.slice(0, firstRegion) + patchBlock + '\n' + content.slice(firstRegion);
  fs.writeFileSync(filePath, content, 'utf8');
  log('[ensureWhatsAppRuntimeFix] patched runtime-api.js');
  return true;
}
```

Called in `_startOpenClawImpl()` right after `ensureZalo*Fix()` chain, BEFORE gateway spawn.

**Safety properties:**
- Idempotent via marker string check
- Regex anchors are on **stable export names** (`sendMessageWhatsApp`, `monitorWebInbox`) — content-hashed filenames are inside `from "../../<hash>.js"` strings which we preserve
- Smoke test re-verifies anchors match after every `npm install` of openclaw (smoke test already does plugin-intact check for openzalo)
- Failure mode = hard log + `sendCeoAlert` "WhatsApp safety patches not applied — upgrade needed" — CEO notified immediately
- Pattern identical to `ensureZaloBlocklistFix` (proven 6 times over v2.2.x/v2.3.x)

### 5.8. Memory

Clone Zalo pattern:
- `appendWhatsAppUserSummary(jid, summary)` → `memory/whatsapp-users/<jid>.md`, trim 50KB
- `appendWhatsAppGroupSummary(groupJid, summary)` → `memory/whatsapp-groups/<groupJid>.md`, trim 50KB
- `seedWorkspace()` tạo dirs (both fresh install AND upgrade — `seedWorkspace()` re-run on version bump)
- Group memory view modal clone từ Zalo

### 5.9. Watchdog + auto-reconnect

Extend watchdog loop (existing pattern, NO cascade kill):

```js
const waStatus = await probeWhatsAppReady();
if (!waStatus.ready && global._waWasConnected) {
  if (!global._waReconnectStartedAt) {
    global._waReconnectStartedAt = Date.now();
    log('[watchdog] WhatsApp disconnected — silent reconnect');
  }
  const downMs = Date.now() - global._waReconnectStartedAt;
  if (downMs > 5 * 60 * 1000 && !global._waAlertSent) {
    global._waAlertSent = true;
    await sendTelegram('[Cảnh báo WhatsApp] Kết nối đã mất >5 phút. Có thể cần scan QR lại. Mở Dashboard > WhatsApp.');
  }
} else if (waStatus.ready) {
  global._waWasConnected = true;
  global._waReconnectStartedAt = null;
  global._waAlertSent = false;
}
```

### 5.10. Preload + IPC (10 bridges)

- `probeWhatsAppReady()`
- `pauseWhatsApp(minutes)` / `resumeWhatsApp()` / `getWhatsAppPauseStatus()`
- `setWhatsAppMode(mode)` / `getWhatsAppMode()`
- `getWhatsAppContacts()` / `getWhatsAppGroups()` / `getWhatsAppGroupMemory(jid)` / `getWhatsAppUserMemory(jid)`
- `updateWhatsAppBlocklist(jids)` / `updateWhatsAppGroupMode(jid, mode)` / `updateWhatsAppDefaultGroupMode(mode)`
- `openWhatsAppQrLogin()` / `logoutWhatsApp()`

### 5.11. AGENTS.md rules (v44 → v45)

Section "Kênh WhatsApp":

**Common rules (y hệt Zalo):**
- Vietnamese có dấu bắt buộc
- Không trích dẫn "theo tài liệu"
- First-greeting idempotency (write-then-send)
- Bot-vs-bot detection (6 signals)
- Pause: đọc `whatsapp-paused.json`, nếu chưa expire → im lặng

**Defense-in-depth rules (shim gates already handle these, AGENTS.md is backup):**
- **Blocklist**: shim drops at code level. AGENTS.md rule still present as defense — if shim detection ever fails, LLM honors `whatsapp-blocklist.json`.
- **System events**: shim drops by `messageStubType`. AGENTS.md rule as backup: "nếu thấy tin hệ thống group (thêm/rời/đổi tên) → im lặng".
- **Mode read**: shim drops. AGENTS.md rule: đọc `whatsapp-mode.txt`, nếu `"read"` → im lặng.

### 5.12. Phone-ban mitigation

1. Wizard warning card về SIM history
2. `sendWhatsApp()` random delay 2-5s multi-chunk
3. Rate cap hard limit 100 outbound/hour/account
4. AGENTS.md: vary response wording
5. Plugin `blurb` built-in: "recommend a separate phone + eSIM"
6. Rate cap overflow → `sendCeoAlert` warn CEO "WhatsApp rate limit approached — consider dedicated number"

## 6. Reliability (Rule #1 compliance)

- `ensureDefaultConfig()` heal `channels.whatsapp` mỗi boot (migration guard included)
- `seedWorkspace()` tạo `memory/whatsapp-*`, `config/whatsapp-*` templates — **re-run on version bump for existing installs** (confirmed in main.js — seedWorkspace idempotent)
- Runtime config mutations via in-process `writeOpenClawConfigIfChanged` only — NEVER shell out `openclaw config set`
- `RESET.bat` xóa runtime → `seedWorkspace()` re-seed
- Smoke test extends:
  - verify openclaw version pin (existing PINNING.md mechanism)
  - verify `hasAnyWhatsAppAuth` export exists (API sanity)
  - **verify shim-hookable exports exist**: spawn `node --require electron/patches/whatsapp-shim.js -e 'require("openclaw")'` and check `whatsapp-shim.log` shows `_shimApplied = true` — fails build if shim can't detect `sendMessageWhatsApp`
  - verify shim JS parses + runs (no syntax error, no unhandled throw)
- **NO source patches** → shim is only touchpoint. When openclaw upgrade breaks shim detection, smoke test fails BEFORE ship.

## 7. Testing

### 7.1. Unit
- `sendWhatsApp` split logic (500/2500/6000 chars) + delay enforcement
- Rate cap enforcement (100 in 60min → 101st fails)
- `sendCeoAlert` 3-channel with 0/1/2/3 failures
- `setWhatsAppMode('read')` → config dmPolicy becomes disabled, saved state correct
- `setWhatsAppMode('auto')` after read → dmPolicy restored từ saved
- `pauseWhatsApp(10)` → dmPolicy disabled + file written; `resumeWhatsApp()` → dmPolicy restored + file deleted

### 7.2. Integration (dev test number)
- Fresh install skip WhatsApp → onboard OK, sidebar "chưa kết nối"
- Fresh install connect WhatsApp → QR → login → nhắn bot → reply OK
- Existing install → click sidebar "Kết nối" → modal QR → login → tab populates
- Mode read: khách nhắn → bot im lặng; openclaw.log shows plugin dropped via dmPolicy
- Pause 10m: khách nhắn → bot im; auto-resume sau 10m → reply
- Group mention-only: @mention → reply; no mention → im (native)
- Blocklist (LLM rule): add JID → khách nhắn → test bot có respect rule không (known 1-5% FP rate)

### 7.3. Soak test (3 ngày, dev account)
- Continuous 72h, daily Electron restart
- Session persist OK
- Memory files ≤50KB
- No gateway restart storms (verify `openclaw.json.bak*` không spawn)
- Watchdog alert fires khi manually kill WA session

### 7.4. E2E (1 CEO volunteer — 48h dry run)
- CEO có SIM >6 tháng
- Monitor: `ceo-alerts-missed.log`, `security-output-filter.jsonl`, `openclaw.log`, WhatsApp account status
- Triple alert verify: Telegram + Zalo + WhatsApp cùng nhận boot ping

## 8. Rollback

- Branch `feat/whatsapp-optional` từ main
- Soft rollback: `ensureDefaultConfig()` patch `channels.whatsapp.enabled = false` qua auto-update
- Hard rollback: v2.4.1 revert WhatsApp code
- Cherry-pick main hotfixes vào branch

## 9. Migration

- Fresh install: none needed
- v2.3.44 → v2.4.0 upgrade:
  1. Auto-update fires
  2. Restart → `ensureDefaultConfig()` adds `channels.whatsapp.accounts.default` (enabled:false, dmPolicy:open)
  3. `seedWorkspace()` adds `memory/whatsapp-*`, `config/whatsapp-*` templates
  4. Dashboard shows sidebar item "chưa kết nối"
  5. Zero disruption Zalo/Telegram

## 10. Open questions (reduced from R2)

**Must close before impl plan:**

**O-A (LOW after R3.1):** `openclaw channels login --channel whatsapp` stdout QR capture.

Evidence from `connection-controller-*.js`: `printQRInTerminal: false`, QR emitted via `opts.onQr?.(qr)` callback, CLI path uses plain `console.log` + `qrcode-terminal.generate`. Plain stdout pipe should work — no TTY needed. Verify:
```bash
# From Electron subprocess (spawn with shell:false, stdio piped)
openclaw channels login --channel whatsapp --account default
```
Expected: ASCII QR block in stdout, refresh ~20s. Capture → render in `<pre>` modal.
Fallback only if surprise: PNG file in auth dir.

**O-B:** `openclaw channels status --probe --json` output format — verify field names (`connected`, `jid`, `phone`, `accountId`) match what my probe code expects. Test:
```bash
openclaw channels status --probe --json
```

**O-C (resolved by shim):** Pause now handled by SHIM reading `whatsapp-paused.json`, NOT by flipping `dmPolicy`. Baileys continues to deliver inbound to plugin during pause, but shim drops at Module._load hook — zero agent activity, zero queue on resume. `dmPolicy` only flipped for mode=read (semi-permanent, not per-event pause).

Reload cascade still a concern for mode=read which does flip `dmPolicy` in-process. Mitigation already in spec §5.7 (use `writeOpenClawConfigIfChanged` byte-equal helper). Verify Day 1: toggle mode 3 times via in-process helper → confirm no gateway restart.

**O-D (HIGH — MUST close Day 1):** Shim function-name detection.

Test:
```bash
# 1. Install openclaw@2026.4.14 in vendor
# 2. Create /tmp/shim-test.js with Module._load hook logging every request + exports key list
# 3. Spawn: node --require /tmp/shim-test.js vendor/node_modules/openclaw/openclaw.mjs gateway run
# 4. Observe which file+export has `sendMessageWhatsApp`; note inbound handler name
```

Expected: `sendMessageWhatsApp` appears in `send-<hash>.js` exports. Inbound handler TBD — likely `monitorWebInbox`, `handleIncomingMessage`, or callback passed into baileys' `ev.on('messages.upsert', ...)`. Record exact names → update shim accordingly.

If inbound handler is a closure inside `monitorWebInbox` (not an export), shim switches to wrapping the dispatch boundary instead — e.g., wrap the agent-runtime's `dispatch` method which IS exported. Adjust impl plan accordingly.

**Can defer:**
- Blocklist LLM rule FP rate tuning (observed in production)
- Per-group allowFrom whitelist UI (v2.4.1 polish)

## 11. Success criteria

1. Fresh install skip WhatsApp → onboard <3 phút, zero WhatsApp UI interrupt
2. Fresh install connect WhatsApp → QR → bot reply in <5 min total
3. v2.3.44 → v2.4.0 upgrade → 24h zero disruption Zalo/Telegram
4. Concurrent 3-channel (Telegram+Zalo+WhatsApp) 1h → 0 cross-talk, 0 leak
5. Watchdog kill WhatsApp → auto-reconnect 30s-5min → no gateway kill
6. `ceo-alerts-missed.log` empty after 72h soak
7. Smoke test pass (openclaw pin + WhatsApp plugin API intact)
8. CEO 48h ban check → account remains active

## 12. Timeline

**Week 1 — Foundation + patch (5 ngày):**
- Day 1: Close O-A (QR), O-B (probe output shape) — manual tests on vendor plugin. Verify `runtime-api.js` anchors (`sendMessageWhatsApp` + `monitorWebInbox` import lines) match regex
- Day 2: `ensureWhatsAppRuntimeFix()` implement + unit tests (idempotency, anchor match, patch applied correctly)
- Day 3: `ensureDefaultConfig` schema + in-process config helpers + mode/pause toggles
- Day 4: `probeWhatsAppReady` + `sendWhatsApp` + `sendCeoAlert` triple + rate cap
- Day 5: Wizard step HTML + QR capture flow

**Week 2 — UI + memory + integration (5 ngày):**
- Day 6-7: Dashboard page + sidebar + 4 sub-tabs
- Day 8: AGENTS.md v45 rules + memory handlers + view modal
- Day 9: Watchdog integration + preload bridges + mode/pause UI
- Day 10: Integration tests (patch smoke, end-to-end blocklist, pause without queue, dedup window)

**Week 3 — E2E + ship (3 ngày):**
- Day 11-12: 72h soak on dev account + E2E on volunteer CEO account
- Day 13: Fix findings, final smoke test, ship v2.4.0 (EXE + Mac DMG)

**Total: 2 tuần dev + 3 ngày test.**

---

**Next step:** close O-A, O-B qua manual test → dispatch reviewer R5 → approve → invoke writing-plans skill.
