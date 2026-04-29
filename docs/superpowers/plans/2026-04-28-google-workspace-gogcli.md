# Google Workspace (gogcli) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bundle gogcli binary and expose Calendar, Gmail, Drive, Contacts, Tasks via local API (port 20200) + Dashboard UI + bot chat.

**Architecture:** `google-api.js` wraps `gog` CLI spawns. `google-routes.js` mounts into existing cron-api.js server. Dashboard has 1 page with 6 internal tabs (5 services + Settings). Bot uses `web_fetch` to call `/api/google/*`.

**Tech Stack:** JavaScript (Node), gogcli v0.13.0 (Go binary), raw HTTP (no Express)

**Spec:** `docs/superpowers/specs/2026-04-28-google-workspace-gogcli-design.md`

---

## Chunk 1: Foundation (Wave 1a + 1b)

### Task 1: Download and bundle gogcli binary

**Files:**
- Modify: `electron/scripts/prebuild-vendor.js`

**Context:** Follow the exact pattern used for Node binary download (lines 47-59 for checksums, lines 122-256 for download+extract+verify). gogcli is a single binary, no extraction needed — just download + chmod.

- [ ] **Step 1: Add GOG_VERSION and checksums constant after NODE_CHECKSUMS (line 59)**

```javascript
const GOG_VERSION = 'v0.13.0';
// SHA256 from https://github.com/steipete/gogcli/releases/tag/v0.13.0
// To regenerate: download each binary, run `sha256sum <file>`
const GOG_CHECKSUMS = {
  [GOG_VERSION]: {
    'win32-x64':    '', // TODO: fill from release page
    'win32-arm64':  '', // TODO: fill from release page
    'darwin-arm64': '', // TODO: fill from release page
    'darwin-x64':   '', // TODO: fill from release page
  },
};
```

- [ ] **Step 2: Add `downloadGogBinary(platform, arch)` function after `downloadAndExtractNode`**

```javascript
async function downloadGogBinary(platform, arch) {
  const gogDir = path.join(VENDOR, 'gog');
  const gogBin = platform === 'win32'
    ? path.join(gogDir, 'gog.exe')
    : path.join(gogDir, 'gog');

  const stamp = path.join(gogDir, '.target');
  const stampValue = `${GOG_VERSION}-${platform}-${arch}`;
  if (fs.existsSync(gogBin) && fs.existsSync(stamp) &&
      fs.readFileSync(stamp, 'utf-8').trim() === stampValue) {
    log('gog binary already present for', stampValue, '— skipping download');
    return;
  }

  rmrf(gogDir);
  mkdirp(gogDir);

  // Map platform+arch to GitHub release asset name
  const archMap = { x64: 'amd64', arm64: 'arm64' };
  const platMap = { win32: 'windows', darwin: 'darwin' };
  const ext = platform === 'win32' ? '.exe' : '';
  const assetName = `gog_${platMap[platform]}_${archMap[arch]}${ext}`;
  const url = `https://github.com/steipete/gogcli/releases/download/${GOG_VERSION}/${assetName}`;
  const tmp = path.join(os.tmpdir(), assetName);

  await downloadFile(url, tmp);

  // SHA256 verify
  const checksumKey = `${platform}-${arch}`;
  const expected = GOG_CHECKSUMS[GOG_VERSION]?.[checksumKey];
  if (expected) {
    const actual = sha256File(tmp);
    if (actual !== expected) {
      try { fs.unlinkSync(tmp); } catch {}
      fatal(`gog SHA256 mismatch for ${checksumKey}.\n  Expected: ${expected}\n  Got:      ${actual}`);
    }
    log(`gog SHA256 verified for ${checksumKey}`);
  } else {
    warn(`No SHA256 checksum for gog ${GOG_VERSION}/${checksumKey}. Fill GOG_CHECKSUMS.`);
  }

  fs.copyFileSync(tmp, gogBin);
  fs.unlinkSync(tmp);
  if (platform !== 'win32') {
    try { fs.chmodSync(gogBin, 0o755); } catch {}
  }

  fs.writeFileSync(stamp, stampValue + '\n');

  if (process.platform === platform) {
    try {
      const out = execSync(`"${gogBin}" version`, { encoding: 'utf-8', timeout: 10000 }).trim();
      log('vendor gog version:', out);
    } catch (e) {
      warn('gog binary present but failed to run:', e.message);
    }
  } else {
    log(`gog downloaded for ${platform}-${arch} — host is ${process.platform}, skipping run check`);
  }
}
```

- [ ] **Step 3: Call `downloadGogBinary` in `main()` after `downloadAndExtractNode` (line 737)**

Add after `await downloadAndExtractNode(platform, arch);`:
```javascript
  await downloadGogBinary(platform, arch);
```

- [ ] **Step 4: Verify — run `node electron/scripts/prebuild-vendor.js` (with TARGET_PLATFORM set)**

Expected: `[prebuild-vendor] vendor gog version: v0.13.0` (or similar). Binary at `electron/vendor/gog/gog.exe`.

- [ ] **Step 5: Fill actual SHA256 checksums**

Download each binary from the release page, compute `sha256sum`, fill `GOG_CHECKSUMS`.

- [ ] **Step 6: Commit**

```
git add electron/scripts/prebuild-vendor.js
git commit -m "feat(vendor): bundle gogcli v0.13.0 binary for Google Workspace"
```

---

### Task 2: Create google-api.js — core spawn wrapper + auth

**Files:**
- Create: `electron/lib/google-api.js`

**Context:** This is the single module both IPC handlers and API routes call. Pattern: `execFileSync` with JSON parsing, similar to how `findNodeBin()` works in boot.js.

- [ ] **Step 1: Verify actual CLI syntax**

Before writing wrapper functions, run on your machine:
```
vendor/gog/gog.exe --help
vendor/gog/gog.exe auth --help
vendor/gog/gog.exe calendar --help
```
Note exact flag names. Adjust commands below if they differ.

- [ ] **Step 2: Create `electron/lib/google-api.js`**

```javascript
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

let app;
try { app = require('electron').app; } catch {}

function getGogConfigDir() {
  if (app) return path.join(app.getPath('userData'), 'gog');
  // Fallback when app not ready — match Electron's userData resolution
  const homedir = require('os').homedir();
  if (process.platform === 'darwin') return path.join(homedir, 'Library', 'Application Support', '9bizclaw', 'gog');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'), '9bizclaw', 'gog');
  return path.join(homedir, '.config', '9bizclaw', 'gog');
}

function getGogBinaryPath() {
  const vendorDir = (() => {
    if (!app || !app.isPackaged) return path.join(__dirname, '..', 'vendor');
    return path.join(process.resourcesPath, 'vendor');
  })();
  const bin = process.platform === 'win32'
    ? path.join(vendorDir, 'gog', 'gog.exe')
    : path.join(vendorDir, 'gog', 'gog');

  if (!fs.existsSync(bin)) return null;

  // Mac: ensure executable
  if (process.platform !== 'win32') {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
    } catch {
      try { fs.chmodSync(bin, 0o755); } catch {}
    }
  }
  return bin;
}

function getGogAccount() {
  try {
    const p = path.join(getGogConfigDir(), 'account.json');
    return JSON.parse(fs.readFileSync(p, 'utf-8')).email || '';
  } catch { return ''; }
}

function saveGogAccount(email) {
  const dir = getGogConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify({ email }));
}

function gogEnv() {
  return {
    ...process.env,
    GOG_CONFIG_DIR: getGogConfigDir(),
    GOG_JSON: '1',
    GOG_TIMEZONE: 'Asia/Ho_Chi_Minh',
    GOG_ACCOUNT: getGogAccount(),
  };
}

function gogExecSync(args, timeoutMs = 15000) {
  const bin = getGogBinaryPath();
  if (!bin) throw new Error('gog binary not found');
  const stdout = execFileSync(bin, args, {
    env: gogEnv(),
    timeout: timeoutMs,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  try { return JSON.parse(stdout); } catch {
    return { error: 'Unexpected output', raw: stdout.slice(0, 2000) };
  }
}

// Async version — use in IPC handlers to avoid blocking Electron main thread
async function gogExec(args, timeoutMs = 15000) {
  return gogSpawnAsync(args, timeoutMs);
}

function gogSpawnAsync(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const bin = getGogBinaryPath();
    if (!bin) return reject(new Error('gog binary not found'));
    const child = spawn(bin, args, { env: gogEnv(), windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout?.on('data', d => stdout += d);
    child.stderr?.on('data', d => stderr += d);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Timeout after ' + (timeoutMs / 1000) + 's'));
    }, timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr || `exit code ${code}`));
      try { resolve(JSON.parse(stdout)); } catch {
        resolve({ ok: true, raw: stdout.slice(0, 2000) });
      }
    });
    child.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// --- Auth ---

function authStatus() {
  try {
    const result = gogExecSync(['auth', 'status'], 10000);
    const email = getGogAccount();
    return { connected: !!email, email, services: ['calendar', 'gmail', 'drive', 'contacts', 'tasks'], raw: result };
  } catch {
    return { connected: false, email: '', services: [] };
  }
}

function registerCredentials(clientSecretPath) {
  return gogExecSync(['auth', 'credentials', clientSecretPath], 10000);
}

async function connectAccount(email) {
  const result = await gogSpawnAsync(
    ['auth', 'add', email, '--services', 'calendar,gmail,drive,contacts,tasks'],
    120000
  );
  saveGogAccount(email);
  return result;
}

function disconnectAccount() {
  const email = getGogAccount();
  if (email) {
    try { gogExecSync(['auth', 'remove', email], 10000); } catch {}
  }
  const accountFile = path.join(getGogConfigDir(), 'account.json');
  try { fs.unlinkSync(accountFile); } catch {}
  return { ok: true };
}

module.exports = {
  getGogBinaryPath, getGogConfigDir, getGogAccount,
  gogExec, gogExecSync, gogSpawnAsync, gogEnv,
  authStatus, registerCredentials, connectAccount, disconnectAccount,
};
```

- [ ] **Step 3: Commit**

```
git add electron/lib/google-api.js
git commit -m "feat: google-api.js — gogcli spawn wrapper + auth functions"
```

---

### Task 3: Create google-routes.js + mount into cron-api.js

**Files:**
- Create: `electron/lib/google-routes.js`
- Modify: `electron/lib/cron-api.js:114` (tokenFreeEndpoints) and `~165` (route dispatch)

- [ ] **Step 1: Create `electron/lib/google-routes.js`**

```javascript
'use strict';
const googleApi = require('./google-api');

module.exports = function handleGoogleRoute(urlPath, params, req, res, jsonResp) {
  try {
    if (urlPath === '/status') {
      return jsonResp(res, 200, googleApi.authStatus());
    }
    return jsonResp(res, 404, { error: 'unknown google route: ' + urlPath });
  } catch (e) {
    return jsonResp(res, 500, { error: e.message });
  }
};
```

- [ ] **Step 2: Add `/api/google/status` to tokenFreeEndpoints in cron-api.js (line 114)**

Change:
```javascript
const tokenFreeEndpoints = ['/api/cron/list', '/api/workspace/read', '/api/workspace/list', '/api/auth/token', '/api/zalo/friends'];
```
To:
```javascript
const tokenFreeEndpoints = ['/api/cron/list', '/api/workspace/read', '/api/workspace/list', '/api/auth/token', '/api/zalo/friends', '/api/google/status'];
```

- [ ] **Step 3: Add google route delegation in cron-api.js request handler**

Add google route delegation AFTER the path sandboxing block (after line 163, just before `if (urlPath === '/api/cron/create')` at line 165). This ensures token check and path sandboxing have already run:

```javascript
    // Google Workspace routes — delegate to google-routes.js
    if (urlPath.startsWith('/api/google/')) {
      return handleGoogleRoute(urlPath.slice('/api/google'.length), params, req, res, jsonResp);
    }
```

Also add at the top of the `startCronApi()` function body (after `const nodeCron = ...` line 21):
```javascript
  const handleGoogleRoute = require('./google-routes');
```

- [ ] **Step 4: Commit**

```
git add electron/lib/google-routes.js electron/lib/cron-api.js
git commit -m "feat: mount /api/google/* routes into cron API server"
```

---

### Task 4: Add COMMAND-BLOCK patterns to inbound.ts

**Files:**
- Modify: `electron/packages/modoro-zalo/src/inbound.ts:724` (before last patterns)

- [ ] **Step 1: Add gogcli patterns before the `.some()` check (before line 726)**

Insert these patterns into the `commandBlockPatterns` array:

```typescript
    // --- Google Workspace lockdown (gogcli, gmail, drive) ---
    /\bgog\b/i,
    /\bgoogle\b.*\b(?:calendar|gmail|drive|contacts|tasks|workspace)\b/i,
    /\bgmail\b.*\b(?:send|gui|forward|reply|draft)\b/i,
    /\bdrive\b.*\b(?:upload|download|share|delete|xoa)\b/i,
    /\b(?:gui|send)\s+email\b/i,
    /\b(?:tao|dat|book)\s+(?:meeting|lich|su kien|event)\b/i,
```

- [ ] **Step 2: Update smoke-test.js regex count comment if it references pattern count**

- [ ] **Step 3: Commit**

```
git add electron/packages/modoro-zalo/src/inbound.ts electron/scripts/smoke-test.js
git commit -m "security: add gogcli/google patterns to Zalo COMMAND-BLOCK"
```

---

### Task 5: Smoke test for gog binary

**Files:**
- Modify: `electron/scripts/smoke-test.js`

- [ ] **Step 1: Add gog binary check**

Find the vendor binary checks section. Add after the Node binary check:

```javascript
  // gog (gogcli) binary
  const gogBin = process.platform === 'win32'
    ? path.join(vendorDir, 'gog', 'gog.exe')
    : path.join(vendorDir, 'gog', 'gog');
  if (fs.existsSync(path.join(vendorDir, 'gog'))) {
    if (!fs.existsSync(gogBin)) {
      fail('vendor/gog/ directory exists but gog binary is missing');
    }
    if (process.platform === targetPlatform) {
      const gogRes = spawnSync(gogBin, ['version'], { encoding: 'utf-8', timeout: 10000 });
      if (gogRes.status !== 0) {
        fail('gog binary failed to run: ' + (gogRes.stderr || '').slice(0, 200));
      } else {
        ok('gog binary: ' + (gogRes.stdout || '').trim());
      }
    } else {
      ok('gog binary present (cross-platform, skipping run check)');
    }
  }
```

- [ ] **Step 2: Commit**

```
git add electron/scripts/smoke-test.js
git commit -m "test: smoke test for bundled gog binary"
```

---

### Task 6: Dashboard Settings tab + auth IPC + delete old gcal

**Files:**
- Modify: `electron/lib/dashboard-ipc.js:4378-4443` (delete gcal handlers), `~3304` (check-all-channels)
- Modify: `electron/preload.js:140-148` (replace gcal bridges)
- Modify: `electron/ui/dashboard.html:1921-1924` (sidebar), `2977-2988` (page content)
- Delete: `electron/gcal/auth.js`, `electron/gcal/calendar.js`, `electron/gcal/config.js`

- [ ] **Step 1: Delete `electron/gcal/` directory**

- [ ] **Step 2: Remove gcal requires at lines 142-144 of dashboard-ipc.js**

Delete:
```javascript
const gcalAuth = require('../gcal/auth');
const gcalCalendar = require('../gcal/calendar');
const gcalConfig = require('../gcal/config');
```

- [ ] **Step 3: Replace gcal IPC handlers in dashboard-ipc.js (lines 4378-4443)**

Delete all 9 `gcal-*` handlers. Replace with:

```javascript
  // --- Google Workspace (via gogcli) ---
  const googleApi = require('./google-api');

  ipcMain.handle('google-auth-status', async () => {
    try { return googleApi.authStatus(); }
    catch (e) { return { connected: false, error: e.message }; }
  });

  ipcMain.handle('google-upload-credentials', async (_ev, filePath) => {
    try {
      const configDir = googleApi.getGogConfigDir();
      fs.mkdirSync(configDir, { recursive: true });
      const dest = path.join(configDir, 'client_secret.json');
      fs.copyFileSync(filePath, dest);
      googleApi.registerCredentials(dest);
      return { ok: true };
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('google-connect', async (_ev, email) => {
    try {
      const result = await googleApi.connectAccount(email);
      return { ok: true, ...result };
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('google-disconnect', async () => {
    try { return googleApi.disconnectAccount(); }
    catch (e) { return { error: e.message }; }
  });
```

- [ ] **Step 4: Update `check-all-channels` handler (line ~3304)**

Find the google status check (references `~/.gog/token.json`). Replace with:

```javascript
    const googleStatus = (() => {
      try { return googleApi.authStatus(); }
      catch { return { connected: false }; }
    })();
```

- [ ] **Step 5: Replace gcal bridges in preload.js (lines 140-148)**

Replace 9 gcal bridges with:

```javascript
    // Google Workspace
    googleAuthStatus: () => ipcRenderer.invoke('google-auth-status'),
    googleUploadCredentials: (path) => ipcRenderer.invoke('google-upload-credentials', path),
    googleConnect: (email) => ipcRenderer.invoke('google-connect', email),
    googleDisconnect: () => ipcRenderer.invoke('google-disconnect'),
```

- [ ] **Step 6: Replace sidebar menu item in dashboard.html (line 1921-1924)**

Replace:
```html
<div class="sidebar-menu-item" data-page="gcal" onclick="switchPage('gcal')">
  <span class="icon" data-icon="calendar"></span><span class="label">Google Calendar</span>
  <span class="badge">Soon</span>
</div>
```
With:
```html
<div class="sidebar-menu-item" data-page="google" onclick="switchPage('google')">
  <span class="icon" data-icon="calendar"></span><span class="label">Google Workspace</span>
</div>
```

- [ ] **Step 7: Replace page-gcal with page-google (lines 2977-2988)**

Replace the entire `<div class="page" id="page-gcal">...</div>` with the Google Workspace page containing Settings tab. Full HTML is large — build it with:
- Horizontal tab bar: `[Calendar] [Gmail] [Drive] [Contacts] [Tasks] [Cai dat]`
- Tab switching JS (same page, show/hide sections)
- Settings tab content: upload credentials button, email input + connect button, status display, disconnect button
- Other 5 tab contents: placeholder "Dang phat trien" text (populated in later waves)

- [ ] **Step 8: Add `client_secret.json` to SENSITIVE_PATTERNS in cron-api.js (line ~144)**

Add to the `SENSITIVE_PATTERNS` array:
```javascript
        /client_secret\.json/i,
```

- [ ] **Step 9: Commit**

```
git rm -r electron/gcal/
git add electron/lib/dashboard-ipc.js electron/lib/cron-api.js electron/preload.js electron/ui/dashboard.html
git commit -m "feat: Google Workspace settings tab, auth IPC, delete old gcal code"
```

---

## Chunk 2: Calendar (Wave 2)

### Task 7: Calendar operations in google-api.js

**Files:**
- Modify: `electron/lib/google-api.js`

- [ ] **Step 1: Add calendar functions after auth functions**

```javascript
// --- Calendar ---

function listEvents(from, to) {
  const args = ['calendar', 'events', 'list'];
  if (from) args.push('--from', from);
  if (to) args.push('--to', to);
  return gogExec(args);
}

function createEvent(summary, start, end, attendees) {
  const args = ['calendar', 'events', 'create', '--summary', summary, '--start', start, '--end', end];
  if (attendees) {
    const list = Array.isArray(attendees) ? attendees.join(',') : attendees;
    args.push('--attendees', list);
  }
  return gogExec(args);
}

function deleteEvent(eventId) {
  return gogExec(['calendar', 'events', 'delete', eventId]);
}

function getFreeBusy(from, to) {
  return gogExec(['calendar', 'freebusy', '--from', from, '--to', to]);
}

function getFreeSlots(date, workStart = '08:00', workEnd = '18:00', slotMinutes = 30) {
  const from = date + 'T' + workStart + ':00';
  const to = date + 'T' + workEnd + ':00';
  const busy = getFreeBusy(from, to);
  // Compute free slots from busy intervals
  const busyPeriods = (busy.calendars || busy.data || [])
    .flatMap(c => c.busy || [])
    .map(b => ({ start: new Date(b.start), end: new Date(b.end) }))
    .sort((a, b) => a.start - b.start);

  const slots = [];
  let cursor = new Date(from);
  const endTime = new Date(to);
  const slotMs = slotMinutes * 60000;
  while (cursor.getTime() + slotMs <= endTime.getTime()) {
    const slotEnd = new Date(cursor.getTime() + slotMs);
    const conflict = busyPeriods.some(b => cursor < b.end && slotEnd > b.start);
    if (!conflict) slots.push({ start: cursor.toISOString(), end: slotEnd.toISOString() });
    cursor = new Date(cursor.getTime() + slotMs);
  }
  return { slots };
}
```

- [ ] **Step 2: Add to module.exports**

```javascript
  listEvents, createEvent, deleteEvent, getFreeBusy, getFreeSlots,
```

- [ ] **Step 3: Commit**

```
git add electron/lib/google-api.js
git commit -m "feat: calendar operations in google-api.js"
```

---

### Task 8: Calendar API routes + IPC + preload

**Files:**
- Modify: `electron/lib/google-routes.js`
- Modify: `electron/lib/dashboard-ipc.js`
- Modify: `electron/preload.js`

- [ ] **Step 1: Add calendar routes in google-routes.js**

After the `/status` handler:

```javascript
    if (urlPath === '/calendar/events') {
      return jsonResp(res, 200, googleApi.listEvents(params.from, params.to));
    }
    if (urlPath === '/calendar/create') {
      if (!params.summary || !params.start || !params.end) return jsonResp(res, 400, { error: 'summary, start, end required' });
      return jsonResp(res, 200, googleApi.createEvent(params.summary, params.start, params.end, params.attendees));
    }
    if (urlPath === '/calendar/delete') {
      if (!params.eventId) return jsonResp(res, 400, { error: 'eventId required' });
      return jsonResp(res, 200, googleApi.deleteEvent(params.eventId));
    }
    if (urlPath === '/calendar/freebusy') {
      return jsonResp(res, 200, googleApi.getFreeBusy(params.from, params.to));
    }
    if (urlPath === '/calendar/free-slots') {
      return jsonResp(res, 200, googleApi.getFreeSlots(params.date, params.workStart, params.workEnd, params.slotMinutes));
    }
```

- [ ] **Step 2: Add calendar IPC handlers in dashboard-ipc.js (after google-disconnect)**

```javascript
  ipcMain.handle('google-calendar-events', async (_ev, opts) => {
    try { return googleApi.listEvents(opts?.from, opts?.to); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-calendar-create', async (_ev, opts) => {
    try { return googleApi.createEvent(opts.summary, opts.start, opts.end, opts.attendees); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-calendar-delete', async (_ev, opts) => {
    try { return googleApi.deleteEvent(opts.eventId); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-calendar-freebusy', async (_ev, opts) => {
    try { return googleApi.getFreeBusy(opts?.from, opts?.to); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-calendar-free-slots', async (_ev, opts) => {
    try { return googleApi.getFreeSlots(opts.date, opts.workStart, opts.workEnd, opts.slotMinutes); }
    catch (e) { return { error: e.message }; }
  });
```

- [ ] **Step 3: Add preload bridges**

```javascript
    googleCalendarEvents: (opts) => ipcRenderer.invoke('google-calendar-events', opts || {}),
    googleCalendarCreate: (opts) => ipcRenderer.invoke('google-calendar-create', opts),
    googleCalendarDelete: (opts) => ipcRenderer.invoke('google-calendar-delete', opts),
    googleCalendarFreebusy: (opts) => ipcRenderer.invoke('google-calendar-freebusy', opts || {}),
    googleCalendarFreeSlots: (opts) => ipcRenderer.invoke('google-calendar-free-slots', opts),
```

- [ ] **Step 4: Commit**

```
git add electron/lib/google-routes.js electron/lib/dashboard-ipc.js electron/preload.js
git commit -m "feat: calendar API routes + IPC handlers"
```

---

### Task 9: Calendar Dashboard tab

**Files:**
- Modify: `electron/ui/dashboard.html`

- [ ] **Step 1: Build Calendar tab content**

Replace the Calendar placeholder in page-google with:
- Week view: 7 day sections, each listing events (time, title, attendees)
- "Tao su kien" button → modal form
- JS: `loadCalendarEvents()` calls `window.claw.googleCalendarEvents({ from: todayISO, to: plus7dISO })`, renders grouped by date
- Auto-refresh on tab switch
- Empty state: "Chua co su kien nao trong 7 ngay toi"

- [ ] **Step 2: Commit**

```
git add electron/ui/dashboard.html
git commit -m "feat: Calendar tab in Google Workspace dashboard page"
```

---

### Task 10: AGENTS.md calendar section

**Files:**
- Modify: `AGENTS.md` (in workspace template)

- [ ] **Step 1: Add Google Workspace section**

```markdown
## Google Workspace

Bot co the truy cap Google Calendar cua CEO qua local API.
Dung web_fetch goi http://127.0.0.1:20200/api/google/*.

Header bat buoc: Authorization: Bearer <token tu file cron-api-token.txt>

Vi du:
- "lich tuan nay" → POST /api/google/calendar/events body: {from: "today", to: "+7d"}
- "dat meeting 3pm thu 5" → POST /api/google/calendar/create body: {summary, start, end}
- "slot trong ngay mai" → POST /api/google/calendar/free-slots body: {date: "tomorrow"}

KHONG BAO GIO tao su kien tu Zalo. Chi thuc hien khi CEO yeu cau qua Telegram.

Neu chua ket noi Google: tra loi "Anh chua ket noi Google Workspace.
Mo Dashboard > Google Workspace > Cai dat de ket noi."
```

- [ ] **Step 2: Commit**

```
git add AGENTS.md
git commit -m "feat: AGENTS.md Google Calendar instructions for bot"
```

---

## Chunk 3: Gmail + Drive + Contacts + Tasks (Waves 3-5)

### Task 11: Gmail operations + routes + IPC + tab

**Files:**
- Modify: `electron/lib/google-api.js` — add `listInbox`, `readEmail`, `sendEmail`, `replyEmail`
- Modify: `electron/lib/google-routes.js` — add `/gmail/*` routes with `X-Source-Channel` check on `/gmail/send` and `/gmail/reply` (return 403 if `zalo`)
- Modify: `electron/lib/dashboard-ipc.js` — add `google-gmail-*` handlers
- Modify: `electron/preload.js` — add gmail bridges
- Modify: `electron/ui/dashboard.html` — Gmail tab: inbox list, read email expand, compose modal, reply inline

Follow exact same pattern as Calendar (Task 7-9). Key difference:

**Gmail send security (google-routes.js):**
```javascript
    if (urlPath === '/gmail/send' || urlPath === '/gmail/reply') {
      const sourceChannel = req.headers['x-source-channel'] || '';
      if (sourceChannel.toLowerCase() === 'zalo') {
        return jsonResp(res, 403, { error: 'Gmail send not allowed from Zalo channel' });
      }
    }
```

**google-api.js functions:**
```javascript
function listInbox(max = 20) {
  return gogExec(['gmail', 'search', '--query', 'in:inbox', '--max', String(max)]);
}
function readEmail(id) {
  return gogExec(['gmail', 'get', id]);
}
function sendEmail(to, subject, body) {
  return gogExec(['gmail', 'send', '--to', to, '--subject', subject, '--body', body], 30000);
}
function replyEmail(id, body) {
  return gogExec(['gmail', 'reply', id, '--body', body], 30000);
}
```

- [ ] **Step 1: Add Gmail functions to google-api.js + exports**
- [ ] **Step 2: Add Gmail routes to google-routes.js (with X-Source-Channel guard)**
- [ ] **Step 3: Add Gmail IPC handlers + preload bridges**
- [ ] **Step 4: Build Gmail tab UI in dashboard.html**
- [ ] **Step 5: Commit**

```
git commit -m "feat: Gmail integration — inbox, read, send, reply"
```

---

### Task 12: Drive operations + routes + IPC + tab

**Files:** Same pattern. Key difference: path validation.

**google-api.js functions:**
```javascript
const { isPathSafe } = require('./util');
const { getWorkspace, getBrandAssetsDir } = require('./workspace');

function listFiles(query, max = 20) {
  const args = query ? ['drive', 'search', query, '--max', String(max)] : ['drive', 'ls', '--max', String(max)];
  return gogExec(args);
}
function uploadFile(filePath, folderId) {
  const ws = getWorkspace();
  const brandDir = getBrandAssetsDir();
  if (!isPathSafe(ws, filePath) && !isPathSafe(brandDir, filePath)) {
    throw new Error('Upload path not allowed — must be within workspace or brand assets');
  }
  const args = ['drive', 'upload', filePath];
  if (folderId) args.push('--parent', folderId);
  return gogExec(args, 60000);
}
function downloadFile(fileId, destPath) {
  const ws = getWorkspace();
  if (!isPathSafe(ws, destPath)) {
    throw new Error('Download path not allowed — must be within workspace');
  }
  return gogExec(['drive', 'download', fileId, destPath], 60000);
}
function shareFile(fileId, email, role = 'reader') {
  return gogExec(['drive', 'share', fileId, '--email', email, '--role', role]);
}
```

- [ ] **Step 1: Add Drive functions to google-api.js + exports** (`listFiles`, `uploadFile`, `downloadFile`, `shareFile`)
- [ ] **Step 2: Add Drive routes to google-routes.js** (include `/drive/download` route)
- [ ] **Step 3: Add Drive IPC handlers + preload bridges**
- [ ] **Step 4: Build Drive tab UI (file list, search, upload, download, share)**
- [ ] **Step 5: Commit**

```
git commit -m "feat: Google Drive integration — list, search, upload, share"
```

---

### Task 13: Contacts + Tasks operations + routes + IPC + tabs

**Files:** Same pattern, two services in one task (both small).

**google-api.js — Contacts:**
```javascript
function listContacts(query) {
  return query ? gogExec(['contacts', 'search', query]) : gogExec(['contacts', 'list']);
}
function createContact(name, phone, email) {
  const args = ['contacts', 'create', '--name', name];
  if (phone) args.push('--phone', phone);
  if (email) args.push('--email', email);
  return gogExec(args);
}
```

**google-api.js — Tasks:**
```javascript
function listTasks(listId) {
  const args = ['tasks', 'list'];
  if (listId) args.push('--list', listId);
  return gogExec(args);
}
function createTask(title, due, listId) {
  const args = ['tasks', 'add', title];
  if (due) args.push('--due', due);
  if (listId) args.push('--list', listId);
  return gogExec(args);
}
function completeTask(taskId) {
  return gogExec(['tasks', 'done', taskId]);
}
```

- [ ] **Step 1: Add Contacts + Tasks functions to google-api.js + exports**
- [ ] **Step 2: Add routes to google-routes.js**
- [ ] **Step 3: Add IPC handlers + preload bridges**
- [ ] **Step 4: Build Contacts tab UI (search, list, add)**
- [ ] **Step 5: Build Tasks tab UI (list, add, check off)**
- [ ] **Step 6: Commit**

```
git commit -m "feat: Contacts + Tasks integration"
```

---

### Task 14: Final AGENTS.md update

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Expand Google Workspace section with all 5 services**

Add Gmail, Drive, Contacts, Tasks examples to the section created in Task 10:

```markdown
- "email moi" → POST /api/google/gmail/inbox
- "gui email cho X noi dung Y" → POST /api/google/gmail/send body: {to, subject, body}
- "tim file bao cao" → POST /api/google/drive/list body: {query: "bao cao"}
- "so dien thoai Hung" → POST /api/google/contacts/search body: {query: "Hung"}
- "them task goi khach" → POST /api/google/tasks/create body: {title: "goi khach"}
- "tasks hom nay" → POST /api/google/tasks/list

KHONG BAO GIO gui email hoac tao su kien tu Zalo. Chi thuc hien khi CEO
yeu cau truc tiep qua Telegram. Neu Zalo hoi ve email/lich: tra loi thong
tin nhung KHONG thuc hien hanh dong.
```

- [ ] **Step 2: Commit**

```
git add AGENTS.md
git commit -m "feat: AGENTS.md — full Google Workspace instructions for bot"
```

---

## Summary

| Wave | Tasks | Description |
|------|-------|-------------|
| 1a | 1-2 | Binary bundling + spawn wrapper |
| 1b | 3-6 | Routes, COMMAND-BLOCK, smoke test, Settings tab, delete gcal |
| 2 | 7-10 | Calendar (full) |
| 3 | 11 | Gmail (full) |
| 4 | 12 | Drive (full) |
| 5 | 13-14 | Contacts + Tasks + final AGENTS.md |

14 tasks, ~14 commits, each ships independently.
