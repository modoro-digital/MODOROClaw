# main.js Modularization Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `electron/main.js` (18,415 lines) into ~20 focused modules in `electron/lib/` + slim orchestrator.

**Architecture:** Bottom-up extraction — leaf functions first, working up the dependency chain in 5 waves. Each task produces a self-contained commit that ships. `require()` calls in main.js replace inline functions.

**Tech Stack:** Node.js/Electron, CommonJS modules, no build tools needed.

**Spec:** `docs/superpowers/specs/2026-04-27-main-js-modularization-design.md`

---

## Extraction Pattern (applies to every task)

Every module extraction follows the same mechanical steps:

1. **Create `electron/lib/<module>.js`** — add requires at top, copy functions from main.js, move private `let` state, add `module.exports` at bottom
2. **In main.js** — replace moved functions with `const { fn1, fn2 } = require('./lib/<module>')`. Delete the function bodies. Keep the `require()` near the top of the file.
3. **Update callers** — if any moved function references another function that's still in main.js (or in a different new module), add the appropriate `require()` in the new module
4. **Replace `global.*`** — if the moved function uses `global._foo`, either convert to module-private `let _foo` (single-module use) or `ctx.foo` (multi-module use)
5. **Add cleanup()** — if module owns intervals/timers, export a `cleanup()` function that clears them
6. **Update smoke test** — add `require()` + export assertions for the new module
7. **Verify** — `node -e "require('./electron/lib/<module>')"` + `npm run smoke` + manual launch
8. **Commit** — `git add electron/lib/<module>.js electron/main.js electron/scripts/smoke-test.js`

**Critical rule:** Do NOT change any function signature, behavior, or IPC channel name. This is a pure structural move.

---

## Chunk 1: Wave 0 + Wave 1 (Foundation)

### Task 1: Wave 0 — Smoke test module contract section

**Files:**
- Modify: `electron/scripts/smoke-test.js`

- [ ] **Step 1:** Add a `checkModuleContracts()` function to smoke-test.js that starts empty. It will grow with each wave.

```js
function checkModuleContracts() {
  const errors = [];
  // Wave 1+ modules will be checked here
  if (errors.length) {
    console.error('Module contract failures:', errors);
    process.exit(1);
  }
  console.log('[smoke] module contracts: OK');
}
```

- [ ] **Step 2:** Call `checkModuleContracts()` from the main smoke test flow.

- [ ] **Step 3:** Run `npm run smoke` — should pass (no modules to check yet).

- [ ] **Step 4:** Commit: `chore(v2.4): add module contract checks to smoke test`

---

### Task 2: Extract context.js

**Files:**
- Create: `electron/lib/context.js`
- Modify: `electron/main.js` (lines 115-125)

- [ ] **Step 1:** Create `electron/lib/context.js` with the shared state object from the spec:

```js
'use strict';
const path = require('path');

const ctx = {
  mainWindow: null,
  tray: null,
  HOME: process.env.HOME || process.env.USERPROFILE || '',
  resourceDir: path.join(__dirname, '..', '..'),
  userDataDir: path.join(__dirname, '..', '..'),
  openclawProcess: null,
  botRunning: false,
  restartCount: 0,
  lastCrash: 0,
  appIsQuitting: false,
  ipcInFlightCount: 0,
  startOpenClawInFlight: false,
  wizardCompleteInFlight: false,
  gatewayRestartInFlight: false,
  gatewayLastStartedAt: 0,
};

module.exports = ctx;
```

- [ ] **Step 2:** In main.js, add `const ctx = require('./lib/context');` near the top (after the existing requires, before STATE section ~line 112).

- [ ] **Step 3:** Replace all references to the moved globals with `ctx.*`:
  - `mainWindow` → `ctx.mainWindow` (throughout entire file)
  - `tray` → `ctx.tray`
  - `HOME` → `ctx.HOME` (careful: only the module-level `const HOME`, not string matches inside other identifiers)
  - `resourceDir` → `ctx.resourceDir`
  - `userDataDir` → `ctx.userDataDir`
  - `openclawProcess` → `ctx.openclawProcess`
  - `botRunning` → `ctx.botRunning`
  - `restartCount` → `ctx.restartCount`
  - `lastCrash` → `ctx.lastCrash`
  - `_appIsQuitting` → `ctx.appIsQuitting`
  - `_ipcInFlightCount` → `ctx.ipcInFlightCount`
  - `_startOpenClawInFlight` → `ctx.startOpenClawInFlight`
  - `_wizardCompleteInFlight` → `ctx.wizardCompleteInFlight`
  - `_gatewayRestartInFlight` → `ctx.gatewayRestartInFlight`
  - `_gatewayLastStartedAt` → `ctx.gatewayLastStartedAt`

- [ ] **Step 4:** Delete the original `let`/`const` declarations for these variables from main.js (lines 115-122, 124-125, 4247-4248, 4252, 4256, 4294, 4298).

- [ ] **Step 5:** Add context.js to smoke test contract checks.

- [ ] **Step 6:** Verify: `node -e "require('./electron/lib/context')"` + `npm run smoke`.

- [ ] **Step 7:** Commit: `refactor(v2.4): extract context.js — shared state singleton`

**WARNING:** This is the highest-risk task because `mainWindow`, `HOME`, `resourceDir` are referenced hundreds of times. Use find-and-replace carefully. Test after EACH variable replacement, not all at once.

---

### Task 3: Extract util.js

**Files:**
- Create: `electron/lib/util.js`
- Modify: `electron/main.js`

Functions to move (with line numbers from main.js):
- `isPathSafe` (210)
- `writeJsonAtomic` (3231) + its private `_atomicWriteCounter` (3230)
- `tokenizeShellish` (2480)
- `sanitizeZaloText` (9591)
- `stripTelegramMarkdown` (9775)

- [ ] **Step 1:** Create `electron/lib/util.js`. Copy the 5 functions + `_atomicWriteCounter`. Add `const ctx = require('./context');` and `const path = require('path'); const fs = require('fs');` as needed. Export all 5 functions.

- [ ] **Step 2:** In main.js, replace the function bodies with: `const { isPathSafe, writeJsonAtomic, tokenizeShellish, sanitizeZaloText, stripTelegramMarkdown } = require('./lib/util');`

- [ ] **Step 3:** Delete moved functions + `_atomicWriteCounter` from main.js.

- [ ] **Step 4:** Update smoke test. Verify. Commit: `refactor(v2.4): extract util.js`

---

### Task 4: Extract workspace.js

**Files:**
- Create: `electron/lib/workspace.js`
- Modify: `electron/main.js`

Functions to move:
- `getWorkspace` (143) + `_workspaceCached`, `_appPackaged` (141-142)
- `invalidateWorkspaceCache` (184)
- `getWorkspaceTemplateRoot` (274)
- `getOpenclawAgentWorkspace` (7201)
- `seedWorkspace` (712)
- `purgeAgentSessions` (186)
- `getBrandAssetsDir` (208)
- `getFbConfigPath` (218), `readFbConfig` (220), `writeFbConfig` (236)
- `getSetupCompletePath` (2860), `hasCompletedOnboarding` (2869), `markOnboardingComplete` (2877)
- `isOpenClawConfigured` (3028)
- `getAppPrefsPath` (3045), `loadAppPrefs` (3054), `saveAppPrefs` (3070)
- `auditLog` (4227)
- `enforceRetentionPolicies` (4117)
- `backupWorkspace` (4355)
- `hardenSensitiveFilePerms` (7503)

- [ ] **Step 1:** Create `electron/lib/workspace.js`. Requires: `context`, `util` (for writeJsonAtomic). Copy all functions + their private state. Export public functions.

- [ ] **Step 2:** In main.js, add require destructuring. Delete moved functions.

- [ ] **Step 3:** Grep main.js for any remaining calls to moved functions — they should now resolve via the require. Check that `auditLog` callers throughout main.js still work (it's called ~50 times).

- [ ] **Step 4:** Update smoke test. Verify. Commit: `refactor(v2.4): extract workspace.js`

---

### Task 5: Extract boot.js

**Files:**
- Create: `electron/lib/boot.js`
- Modify: `electron/main.js`

Functions to move:
- `getBundledVendorDir` (310)
- `ensureVendorExtracted` (344) + splash-related code
- `getBundledNodeBin` (645)
- `getBundledOpenClawCliJs` (658)
- `findBundledOpenClawMjs` (1257)
- `augmentPathWithBundledNode` (670)
- `enumerateNodeManagerBinDirs` (1041)
- `enumerateNodeManagerLibDirs` (1190)
- `appDataDir` (1225)
- `resolveBinAbsolute` (1239)
- `findNodeBin` (1388) + `_cachedNodeBin` (1387)
- `findOpenClawBin` (1265) + `_cachedBin` (119)
- `findOpenClawBinSync` (1321)
- `findOpenClawCliJs` (1429) + `_cachedOpenClawCliJs` (1428)
- `spawnOpenClawSafe` (1488)
- `runOpenClaw` (1365)
- `npmGlobalModules` (2756)
- `findGlobalPackageFile` (2776)
- `bootDiagLog` (1585) + `bootDiagInit` (1596) + `bootDiagRunFullCheck` (1606) + `_bootDiagState` (1584)
- `runSplashAndExtractVendor` (18061) + `splashWindow` (18060)

- [ ] **Step 1:** Create `electron/lib/boot.js`. Requires: `context`, `util`, `workspace`. This is a large extraction (~1500 lines). Copy all functions + private state.

- [ ] **Step 2:** Handle `splashWindow` — it's a `BrowserWindow` instance. `boot.js` needs `const { BrowserWindow } = require('electron');` (add to top).

- [ ] **Step 3:** In main.js, add require. Delete moved functions.

- [ ] **Step 4:** Update smoke test. Verify. Commit: `refactor(v2.4): extract boot.js`

---

## Chunk 2: Wave 2 (Config, 9Router, Conversation, Updates)

### Task 6: Extract config.js

**Files:**
- Create: `electron/lib/config.js`
- Modify: `electron/main.js`

Functions to move:
- `sanitizeOpenClawConfigInPlace` (3190)
- `withOpenClawConfigLock` (3290) + `_openClawConfigMutex` (3289)
- `writeOpenClawConfigIfChanged` (3296)
- `ensureDefaultConfig` (3548)
- `parseUnrecognizedKeyErrors` (1863)
- `healOpenClawConfigInline` (1903)
- `isValidConfigKey` (2856)

- [ ] **Step 1:** Create `electron/lib/config.js`. Requires: `context`, `util`, `workspace`.

- [ ] **Step 2:** In main.js, replace with require. Delete.

- [ ] **Step 3:** Verify. Commit: `refactor(v2.4): extract config.js`

---

### Task 7: Extract nine-router.js

**Files:**
- Create: `electron/lib/nine-router.js`
- Modify: `electron/main.js`

Functions to move:
- `ensure9RouterDefaultPassword` (3345)
- `saveProviderKey` (3370)
- `ensure9RouterProviderKeys` (3380)
- `start9Router` (3404) + `routerProcess` (3336), `_routerLogFd` (3338)
- `stop9Router` (3506)
- `nineRouterApi` (5436)
- `autoFix9RouterSqlite` (5479) + `_9routerSqliteFixAttempted` (5478)
- `waitFor9RouterReady` (5594)
- `validateOllamaKeyDirect` (5343)
- `call9Router` (14662)
- `call9RouterVision` (14717)
- `detectChatgptPlusOAuth` (15539)

- [ ] **Step 1:** Create `electron/lib/nine-router.js`. Requires: `context`, `boot`, `workspace`.

- [ ] **Step 2:** Note: `call9Router`/`call9RouterVision` are deep in the knowledge section (~14662) but use nineRouterApi. Move them here since they're 9router API wrappers.

- [ ] **Step 3:** Export `cleanup()` that calls `stop9Router()`.

- [ ] **Step 4:** Verify. Commit: `refactor(v2.4): extract nine-router.js`

---

### Task 8: Extract conversation.js

**Files:**
- Create: `electron/lib/conversation.js`
- Modify: `electron/main.js`

Functions to move:
- `extractConversationHistoryRaw` (2029)
- `extractConversationHistory` (2040)
- `_extractConversationHistoryImpl` (2051)
- `writeDailyMemoryJournal` (2211)
- `_recentProfileHistory` (2274)
- `_withMemoryFileLock` (2284) + `_memoryFileLocks` (2283)
- `appendPerCustomerSummaries` (2292)
- `trimZaloMemoryFile` (2410)

- [ ] **Step 1:** Create `electron/lib/conversation.js`. Requires: `context`, `workspace`.

- [ ] **Step 2:** Verify. Commit: `refactor(v2.4): extract conversation.js`

---

### Task 9: Extract updates.js

**Files:**
- Create: `electron/lib/updates.js`
- Modify: `electron/main.js`

Functions to move:
- `compareVersions` (17538)
- `checkForUpdates` (17549)
- `downloadUpdate` (17612)
- `installDmgUpdate` (17704)
- `openGitHubUrl` (17812)

- [ ] **Step 1:** Create `electron/lib/updates.js`. Requires: `context` (for mainWindow).

- [ ] **Step 2:** Verify. Commit: `refactor(v2.4): extract updates.js`

---

## Chunk 3: Wave 3 (Channels, Appointments, Zalo, Persona)

### Task 10: Extract channels.js

**Files:**
- Create: `electron/lib/channels.js`
- Modify: `electron/main.js`

This is the largest Wave 3 extraction (~2000 lines). Functions span lines 9267-11442 plus some earlier (2452, 9591-9786) and later (10559-11442).

Key function groups:
- **Telegram config:** getTelegramConfig (9375), getTelegramConfigWithRecovery (9398), getStickyChatIdPath (9267), persistStickyChatId (9270), loadStickyChatId (9295), recoverChatIdFromTelegram (9327), getGatewayAuthToken (9429), getCeoSessionKey (9438), sendToGatewaySession (9446)
- **Output filter:** filterSensitiveOutput (9612) + `_outputFilterPatterns` (9486), `_outputFilterSafeMsgs` (9581)
- **Pause:** _getPausePath (9632), setChannelPermanentPause (9638), clearChannelPermanentPause (9655), isZaloChannelEnabled (9677), setZaloChannelEnabled (9689), isChannelPaused (9708), pauseChannel (9734), resumeChannel (9745), getChannelPauseStatus (9753)
- **Send:** sendTelegram (9786), sendTelegramPhoto (9875), sendZalo (9927), sendZaloTo (10125), sendCeoAlert (2452), sendTelegramRich (11746)
- **Probes:** isZaloListenerAlive (10111), getReadyGateState (10559), finalizeTelegramReadyProbe (10571), finalizeZaloReadyProbe (10598), probeTelegramReady (10614), findOpenzcaListenerPid (10658), probeZaloReady (10708), broadcastChannelStatusOnce (11317), startChannelStatusBroadcast (11442)
- **Misc:** registerTelegramCommands (11676)

- [ ] **Step 1:** Create `electron/lib/channels.js`. Requires: `context`, `util`, `workspace`, `config`.

- [ ] **Step 2:** Move all functions + their ~15 private state variables. Export `cleanup()` that clears `_channelStatusInterval` and `_channelStatusBootTimers`.

- [ ] **Step 3:** Verify. Commit: `refactor(v2.4): extract channels.js`

---

### Task 11: Extract appointments.js

**Files:**
- Create: `electron/lib/appointments.js`
- Modify: `electron/main.js`

Functions from lines 9948-10367 + 10321-10559.

- [ ] **Step 1:** Create `electron/lib/appointments.js`. Requires: `context`, `util`, `workspace`, `channels` (for fireApptPushTarget calling sendZaloTo/sendTelegram).

- [ ] **Step 2:** Export `cleanup()` that clears `_apptDispatcherInterval` and `_apptDispatcherInitialTimeout`.

- [ ] **Step 3:** Verify. Commit: `refactor(v2.4): extract appointments.js`

---

### Task 12: Extract zalo-memory.js

**Files:**
- Create: `electron/lib/zalo-memory.js`
- Modify: `electron/main.js`

Functions from lines 6933-7542 + 7222-7503.

- [ ] **Step 1:** Create `electron/lib/zalo-memory.js`. Requires: `context`, `workspace`, `channels`.

- [ ] **Step 2:** Export `cleanup()` that clears `_zaloCacheInterval`.

- [ ] **Step 3:** Verify. Commit: `refactor(v2.4): extract zalo-memory.js`

---

### Task 13: Extract zalo-plugin.js

**Files:**
- Create: `electron/lib/zalo-plugin.js`
- Modify: `electron/main.js`

Functions: ensureModoroZaloNodeModulesLink (6099), ensureZaloPlugin (6149), seedZaloCustomersFromCache (6176), findOpenzcaCliJs (6351), seedGroupHistorySummary (6394), seedAllGroupHistories (6521), checkZaloCookieAge (6570), _ensureZaloPluginImpl (6572), cleanupOrphanZaloListener (4046).

- [ ] **Step 1:** Create `electron/lib/zalo-plugin.js`. Requires: `context`, `workspace`, `boot`, `config`.

- [ ] **Step 2:** Export `_zaloReady` (gateway.js reads it).

- [ ] **Step 3:** Verify. Commit: `refactor(v2.4): extract zalo-plugin.js`

---

### Task 14: Extract persona.js

**Files:**
- Create: `electron/lib/persona.js`
- Modify: `electron/main.js`

Functions from lines 7792-7967.

- [ ] **Step 1:** Create `electron/lib/persona.js`. Requires: `context`, `workspace`.

- [ ] **Step 2:** Verify. Commit: `refactor(v2.4): extract persona.js`

---

## Chunk 4: Wave 4 (Escalation, Follow-up, Gateway, Knowledge)

### Task 15: Extract escalation.js

**Files:**
- Create: `electron/lib/escalation.js`
- Modify: `electron/main.js`

Functions from lines 12424-12503.

- [ ] **Step 1:** Create `electron/lib/escalation.js`. Requires: `context`, `workspace`, `channels`, `conversation`.

- [ ] **Step 2:** Export `cleanup()` that clears `_escalationInterval`.

- [ ] **Step 3:** Verify. Commit: `refactor(v2.4): extract escalation.js`

---

### Task 16: Extract follow-up.js

**Files:**
- Create: `electron/lib/follow-up.js`
- Modify: `electron/main.js`

Functions from lines 9035-9168 (scanZaloFollowUpCandidates, buildZaloFollowUpPrompt) + 12314-12409.

- [ ] **Step 1:** Create `electron/lib/follow-up.js`. Requires: `context`, `workspace`, `channels`.

- [ ] **Step 2:** Export `cleanup()` that clears `_followUpInterval`.

- [ ] **Step 3:** Verify. Commit: `refactor(v2.4): extract follow-up.js`

---

### Task 17: Extract gateway.js

**Files:**
- Create: `electron/lib/gateway.js`
- Modify: `electron/main.js`

This is the **highest-risk extraction** — gateway touches boot sequence, config, channels, vendor patches, and zalo plugin.

Functions:
- `startOpenClaw` (4299), `_startOpenClawImpl` (4464) — ~800 lines of boot orchestration
- `stopOpenClaw` (5257)
- `isGatewayAlive` (4025)
- `startFastWatchdog` (11544), `fastWatchdogTick` (11554), `_fwCanRestart` (11538)
- `killPort` (2814), `killAllOpenClawProcesses` (2834)
- `triggerGatewayMessage` (11713)
- `waitForIpcDrain` (4257), `rejectIfBooting` (4275)
- Vendor patch wrappers (4085-4095)

- [ ] **Step 1:** Create `electron/lib/gateway.js`. Requires: `context`, `boot`, `config`, `channels`, `./vendor-patches`, `zalo-plugin`.

- [ ] **Step 2:** Move `global._suppressBootPing`, `global._coldBootDone`, `global._readyNotifyState`, `global._bonjourCooldownUntil`, `global._networkCooldownUntil`, `global._gatewayStartedAt` to either `ctx` (if multi-module) or module-private `let`.

- [ ] **Step 3:** Export `cleanup()` that clears `_fastWatchdogInterval`, `_fastWatchdogBootTimeout`, calls `stopOpenClaw()`.

- [ ] **Step 4:** Verify CAREFULLY — this module controls the entire bot startup. Manual test: launch app → bot replies on both Telegram and Zalo within 30s.

- [ ] **Step 5:** Commit: `refactor(v2.4): extract gateway.js`

---

### Task 18: Extract knowledge.js

**Files:**
- Create: `electron/lib/knowledge.js`
- Modify: `electron/main.js`

The largest single extraction (~2500 lines). Functions from lines 13909-16303.

- [ ] **Step 1:** Create `electron/lib/knowledge.js`. Requires: `context`, `util`, `workspace`, `boot` (getBundledVendorDir), `./embedder`.

- [ ] **Step 2:** Note: `call9Router`/`call9RouterVision`/`describeImageForKnowledge`/`summarizeKnowledgeContent` call 9router but are used only by knowledge. They were moved to nine-router.js in Task 7. Knowledge.js requires nine-router.js for these.

- [ ] **Step 3:** Export `cleanup()` that closes `_knowledgeHttpServer`.

- [ ] **Step 4:** Verify. Commit: `refactor(v2.4): extract knowledge.js`

---

## Chunk 5: Wave 5 (Cron, Cron API, Dashboard IPC, Slim main.js)

### Task 19: Extract cron.js

**Files:**
- Create: `electron/lib/cron.js`
- Modify: `electron/main.js`

The second-largest extraction (~1800 lines). Functions from lines 1556-1822 (journal, agent args, error detection) + 2615-2756 (runCronAgentPrompt) + 8572-9035 (schedules, prompt builders) + 9465 (runCronViaSessionOrFallback) + 11783-11952 (telegram builtin commands) + 11981-13897 (loadCustomCrons, watchCustomCrons, startCronJobs, cron CRUD).

- [ ] **Step 1:** Create `electron/lib/cron.js`. Requires: `context`, `boot`, `config`, `channels`, `gateway`, `conversation`, `persona`, `follow-up`.

- [ ] **Step 2:** Export `_agentCliVersionOk` (dashboard reads it for diagnostics).

- [ ] **Step 3:** Export `cleanup()` that calls `stopCronJobs()` and clears `_watchPollerInterval`.

- [ ] **Step 4:** Verify. Commit: `refactor(v2.4): extract cron.js`

---

### Task 20: Extract cron-api.js

**Files:**
- Create: `electron/lib/cron-api.js`
- Modify: `electron/main.js`

Functions from lines 12511-13358.

- [ ] **Step 1:** Create `electron/lib/cron-api.js`. Requires: `context`, `workspace`, `cron`.

- [ ] **Step 2:** Export `cleanup()` that closes `_cronApiServer`.

- [ ] **Step 3:** Verify. Commit: `refactor(v2.4): extract cron-api.js`

---

### Task 21: Extract dashboard-ipc.js

**Files:**
- Create: `electron/lib/dashboard-ipc.js`
- Modify: `electron/main.js`

This task moves ALL `ipcMain.handle(...)` calls from main.js into a single file. Each handler becomes a thin dispatcher.

- [ ] **Step 1:** Grep all `ipcMain.handle` calls in main.js — there are ~118 of them.

- [ ] **Step 2:** Create `electron/lib/dashboard-ipc.js`. Structure:

```js
const { ipcMain } = require('electron');
// require all domain modules
const workspace = require('./workspace');
const config = require('./config');
const channels = require('./channels');
// ... etc

function registerEarlyIpcHandlers() {
  // Handlers needed before createWindow
  ipcMain.handle('get-license-status', ...);
  ipcMain.handle('get-app-prefs', ...);
  ipcMain.handle('save-app-prefs', ...);
  ipcMain.handle('get-setup-complete', ...);
  ipcMain.handle('get-log-file-path', ...);
}

function registerAllIpcHandlers(win) {
  // All remaining 110+ handlers
  ipcMain.handle('check-telegram-ready', ...);
  // ...
}

module.exports = { registerEarlyIpcHandlers, registerAllIpcHandlers };
```

- [ ] **Step 3:** Each handler body should be a thin call to the domain module. Example:
```js
ipcMain.handle('check-telegram-ready', () => channels.probeTelegramReady());
ipcMain.handle('pause-telegram', (_, min) => channels.pauseChannel('telegram', min));
```

- [ ] **Step 4:** Delete all `ipcMain.handle` calls from main.js.

- [ ] **Step 5:** In main.js, call `registerEarlyIpcHandlers()` before createWindow, and `registerAllIpcHandlers(mainWindow)` inside createWindow before loadFile.

- [ ] **Step 6:** Verify EVERY IPC channel still works — open Dashboard, test each tab. Commit: `refactor(v2.4): extract dashboard-ipc.js`

---

### Task 22: Slim down main.js

**Files:**
- Modify: `electron/main.js`

- [ ] **Step 1:** main.js should now be ~500-700 lines containing only:
  - `initFileLogger()` + `getLogFilePath()`
  - All `require('./lib/...')` statements
  - `app.requestSingleInstanceLock()` + file lock
  - `app.whenReady()` with boot sequence (calling into modules)
  - `createWindow()`, `createTray()`, `installEmbedHeaderStripper()`
  - Quit lifecycle + signal handlers

- [ ] **Step 2:** Verify no function bodies remain in main.js except createWindow, createTray, installEmbedHeaderStripper, initFileLogger, and the boot sequence orchestration.

- [ ] **Step 3:** Final verification:
  - `npm run smoke` passes
  - Launch app fresh → wizard works → bot replies on Telegram + Zalo
  - Open every Dashboard tab → no errors
  - Cron fires → Telegram receives summary
  - Kill and relaunch → boot completes in <30s

- [ ] **Step 4:** Commit: `refactor(v2.4): slim main.js — modularization complete`

---

### Task 23: Update PREFLIGHT.md

**Files:**
- Modify: `docs/PREFLIGHT.md`

- [ ] **Step 1:** Replace all `main.js:~NNNN` line references with `lib/<module>.js:<functionName>`.

- [ ] **Step 2:** Commit: `docs(v2.4): update PREFLIGHT.md for modularized structure`

---

## Summary

| Wave | Tasks | New files | ~Lines moved |
|------|-------|-----------|-------------|
| 0 | 1 | 0 | 0 |
| 1 | 2-5 | 4 | ~3,500 |
| 2 | 6-9 | 4 | ~2,000 |
| 3 | 10-14 | 5 | ~4,000 |
| 4 | 15-18 | 4 | ~5,500 |
| 5 | 19-22 | 4 | ~3,400 |
| Cleanup | 23 | 0 | 0 |
| **Total** | **23** | **21** | **~18,400** |
