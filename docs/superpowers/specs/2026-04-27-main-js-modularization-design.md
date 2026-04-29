# main.js Modularization — v2.4 Design Spec

> **For agentic workers:** Use superpowers:executing-plans to implement. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Split 18,415-line `electron/main.js` (~284 functions, ~105 state variables) into ~20 focused modules + slim orchestrator. Zero behavior change. All v49 members migrate seamlessly.

**Approach:** Bottom-up extraction with facade. Extract leaf functions first, work up dependency chain. Each commit ships independently on main.

**Language:** JavaScript (no TypeScript migration).

---

## Module Structure

```
electron/
  lib/
    context.js          shared state (mainWindow, HOME, resourceDir, etc.)
    util.js             writeJsonAtomic, tokenizeShellish, sanitizeZaloText, misc helpers
    workspace.js        getWorkspace, seedWorkspace, auditLog, paths, backup, retention
    boot.js             findNodeBin, getBundledNodeBin, vendor extract, splash, augmentPath, appDataDir, resolveBinAbsolute
    config.js           ensureDefaultConfig, schema heal, writeOpenClawConfigIfChanged
    nine-router.js      start9Router, stop9Router, ensure9RouterDefaultPassword, autoFix, waitReady
    conversation.js     extractConversationHistory, daily journal, memory append
    updates.js          check, download, install
    appointments.js     CRUD, reminders, dispatcher
    channels.js         telegram send/probe, zalo send/probe, pause, output filter
    zalo-memory.js      per-customer files, cache refresh, blocklist, groups
    zalo-plugin.js      ensureZaloPlugin, openzca helpers
    persona.js          compilePersonaMix, sync to bootstrap
    escalation.js       queue poller, alert format, checker
    follow-up.js        queue, scanner, checker
    gateway.js          spawn, health, restart governor, WS wait
    knowledge.js        DB, upload, search, FTS, RAG server, embeddings
    cron.js             scheduler, agent spawn, self-test, journal, custom cron CRUD
    cron-api.js         HTTP API server on :20200
    dashboard-ipc.js    all ipcMain.handle() registrations
  main.js              slim orchestrator (~500-700 lines)
  preload.js           unchanged
  ui/                  unchanged
```

### Existing files — KEPT AS-IS, no changes

These files already exist in `electron/lib/` or `electron/gcal/` and are not merged or renamed:

| File | Location | Used by |
|------|----------|---------|
| `vendor-patches.js` | `electron/lib/` | gateway.js, main.js |
| `embedder.js` | `electron/lib/` | knowledge.js |
| `fb-publisher.js` | `electron/lib/` | dashboard-ipc.js |
| `image-gen.js` | `electron/lib/` | dashboard-ipc.js |
| `license.js` | `electron/lib/` | dashboard-ipc.js (early IPC) |
| `license-public.pem` | `electron/lib/` | license.js |
| `gcal/auth.js` | `electron/gcal/` | dashboard-ipc.js |
| `gcal/calendar.js` | `electron/gcal/` | dashboard-ipc.js |
| `gcal/config.js` | `electron/gcal/` | dashboard-ipc.js |

The 9 gcal IPC handlers (`gcal-connect`, `gcal-disconnect`, `gcal-get-status`, etc.) route through `dashboard-ipc.js` calling the existing `gcal/*.js` modules directly.

## Shared Context Pattern

```js
// lib/context.js — shared state that 2+ modules need
const path = require('path');

const ctx = {
  // Window + tray — set by main.js after createWindow/createTray
  mainWindow: null,
  tray: null,

  // Paths — __dirname = electron/lib/, so ../.. = repo root
  HOME: process.env.HOME || process.env.USERPROFILE || '',
  resourceDir: path.join(__dirname, '..', '..'),  // ../.. because lib/ is one level deeper
  userDataDir: path.join(__dirname, '..', '..'),   // updated in main.js app.whenReady for packaged

  // Process state
  openclawProcess: null,
  botRunning: false,
  restartCount: 0,
  lastCrash: 0,
  appIsQuitting: false,
  ipcInFlightCount: 0,

  // Boot flags — read by multiple modules
  startOpenClawInFlight: false,
  wizardCompleteInFlight: false,
  gatewayRestartInFlight: false,
  gatewayLastStartedAt: 0,
};

module.exports = ctx;
```

**Packaged app path handling:** `ctx.userDataDir` is initialized to repo root (dev mode default). In `main.js` inside `app.whenReady()`, it is updated to `app.getPath('userData')` for packaged builds. Modules that need user-data paths read `ctx.userDataDir` — never compute it themselves.

**Rule:** context.js only holds state that 2+ modules need. Module-private state stays as `let` inside its own module.

### Globals-to-Module Mapping

| Global | Target module | Exported? | Notes |
|--------|--------------|-----------|-------|
| `mainWindow` | context.js | via ctx | Set by main.js |
| `tray` | context.js | via ctx | Set by main.js |
| `openclawProcess` | context.js | via ctx | Written by gateway.js, read by channels.js |
| `botRunning` | context.js | via ctx | Written by gateway.js, read by dashboard-ipc.js |
| `HOME` | context.js | via ctx | Read everywhere |
| `resourceDir` | context.js | via ctx | Read by boot.js, workspace.js, vendor-patches |
| `userDataDir` | context.js | via ctx | Updated in main.js whenReady, read by workspace.js |
| `appIsQuitting` | context.js | via ctx | Set by main.js quit handler |
| `ipcInFlightCount` | context.js | via ctx | Incremented by dashboard-ipc, drained by main.js |
| `startOpenClawInFlight` | context.js | via ctx | Guard for reentrant startOpenClaw |
| `wizardCompleteInFlight` | context.js | via ctx | Guard for wizard-complete sequence |
| `gatewayRestartInFlight` | context.js | via ctx | Guard for gateway restart |
| `_logFilePath`, `_logStream` | main.js | stays in main.js | initFileLogger runs before any require |
| `_atomicWriteCounter` | util.js | private | Used by writeJsonAtomic |
| `_openClawConfigMutex` | config.js | private | Write serialization |
| `_workspaceCached`, `_appPackaged` | workspace.js | private | Cache for getWorkspace() |
| `_cachedBin`, `_cachedNodeBin`, `_cachedOpenClawCliJs` | boot.js | private | Memoization caches |
| `_bootDiagState` | boot.js | private | Diagnostic log |
| `splashWindow` | boot.js | private | Vendor extract splash BrowserWindow |
| `routerProcess`, `_routerLogFd` | nine-router.js | private | 9router process state |
| `_9routerSqliteFixAttempted` | nine-router.js | private | Auto-fix guard |
| `_agentFlagProfile`, `_agentCliHealthy`, `_agentCliVersionOk` | cron.js | `_agentCliVersionOk` exported (dashboard reads) | Self-test state |
| `_selfTestPromise` | cron.js | private | Deduplicate concurrent self-tests |
| `_outputFilterPatterns`, `_outputFilterSafeMsgs` | channels.js | private | Filter arrays |
| `_channelStatusInterval`, `_lastChannelState` | channels.js | private | Broadcast state |
| `_channelConsecutiveFails` | channels.js | private | Grace counter |
| `_lastRecoverChatIdAt` | channels.js | private | Telegram recovery throttle |
| `_zaloReady`, `_zaloPluginInFlight` | zalo-plugin.js | `_zaloReady` exported (gateway checks) | Plugin state |
| `_cachedOpenzcaCliJs` | zalo-plugin.js | private | Memoization |
| `_zaloFriendsCache`, `_zaloCacheRefreshInFlight` | zalo-memory.js | private | Cache state |
| `_zaloCacheInterval` | zalo-memory.js | private | Refresh interval |
| `_zaloLoginStartedAt` | zalo-memory.js | private | Login tracking |
| `_saveZaloManagerInFlight` | zalo-memory.js | private | Write guard |
| `_groupHistorySeedInFlight` | zalo-memory.js | private | Seed guard |
| `_cronAgentQueue`, `_cronAgentQueueDepth` | cron.js | private | Sequential queue |
| `_startCronJobsInFlight` | cron.js | private | Reentrant guard |
| `_customCronWriteChain` | cron.js | private | Write serialization |
| `_watchPollerInterval`, `_lastCustomCronsMtime` | cron.js | private | File watcher |
| `_followUpInterval`, `_followUpQueueLock` | follow-up.js | private | Queue state |
| `_escalationInterval` | escalation.js | private | Poller interval |
| `_cronApiServer`, `_cronApiToken`, `_cronApiPort` | cron-api.js | private | HTTP server state |
| `_fastWatchdogInterval`, `_fwGatewayFailCount` | gateway.js | private | Watchdog state |
| `_fwTickInFlight`, `_fwZaloMissCount`, `_fwRestartTimestamps` | gateway.js | private | Watchdog state |
| `_apptWriteQueue`, `_apptMutating` | appointments.js | private | Write serialization |
| `_apptDispatcherInterval` | appointments.js | private | Dispatcher timer |
| `_zaloListenerAlive`, `_zaloListenerAliveAt` | channels.js | private | Zalo probe cache |
| `_documentsDbLastErrorAt`, `_documentsDbAutoFixAttempted`, `_documentsDbSchemaReady` | knowledge.js | private | DB state |
| `_memoryFileLocks` | conversation.js | private | Per-file write locks |
| `_PERSONA_MARKER_*`, `_SHOPSTATE_MARKER_*` | persona.js | private | Marker constants |
| `_channelStatusBroadcastInFlight`, `_channelStatusTickCount` | channels.js | private | Broadcast state |
| `_lastBootPingAt` | gateway.js | private | Boot ping throttle |

All other globals not listed: stay private in their target module (determined by which functions use them).

## Module Interface Contract

Each module follows:

```js
// lib/example.js
const ctx = require('./context');
const { writeJsonAtomic } = require('./util');

let _privateState = null;  // not exported

function publicFunction() { ... }
async function anotherPublic() { ... }

module.exports = { publicFunction, anotherPublic };
```

**Invariants:**
- **No circular requires.** Module X may `require` module Y only if Y appears in an earlier or same wave AND Y does not `require` X. (Note: `auditLog` lives in `workspace.js`, not `util.js`, specifically to avoid a circular dependency — auditLog calls getWorkspace.)
- **Side-effect-free at require time.** No initialization on load — `path.join` for constants is OK but no I/O, no spawning, no file reads. All setup happens when explicitly called from main.js boot sequence or IPC registration.
- **Same function signatures.** `ensureDefaultConfig()` stays `ensureDefaultConfig()`. Same args, same return.
- **Exports = public API.** If nobody outside the file needs it, it's not exported.
- **Unlisted functions go to their primary caller's module.** The export lists below name key functions per module. Private helpers not listed (e.g., `_tier2LoadCounter`, `_ftsEscapeToken`, `getDocumentsDir`) move to the same module as the public function that calls them. When in doubt: grep callers, pick the module with the most call sites.
- **Each module exports a `cleanup()` function** if it owns intervals/watchers/child processes. `_beforeQuitCleanup` in main.js calls `cleanup()` on each module. Module-private intervals are never leaked — the module starts and stops them.
- **`global.*` properties:** Existing `global._suppressBootPing`, `global._coldBootDone`, `global.__powerBlockerId`, etc. migrate to `ctx` in context.js OR become module-private state. Rule: if only one module reads/writes it, convert to module `let`. If 2+ modules need it, add to `ctx`. `global.*` as cross-module communication is banned after modularization.

**dashboard-ipc.js pattern:** Each `ipcMain.handle` is a thin dispatcher — validate args, call domain module function, return result. No business logic in handler body. Receives `mainWindow` as parameter to `registerAllIpcHandlers(win)` and closes over it. All handlers registered BEFORE `mainWindow.loadFile()` is called (inside `createWindow`, before URL loads) to prevent race conditions where renderer calls an unregistered handler.

**Early vs late IPC:** `registerEarlyIpcHandlers()` registers handlers needed during window load (before dashboard.html DOMContentLoaded): `get-license-status`, `get-app-prefs`, `save-app-prefs`, `get-setup-complete`, `get-log-file-path`. Called in main.js before `createWindow`. `registerAllIpcHandlers(win)` registers all remaining 110+ handlers, called inside `createWindow` before `loadFile`.

## Dependency Graph

```
context.js (no deps)
    ↑
util.js (context)
    ↑
workspace.js (context, util)          ← auditLog lives here (calls getWorkspace)
boot.js (context, util, workspace)    ← appDataDir, resolveBinAbsolute, enumerateNodeManagerBinDirs
    ↑
config.js (context, util, workspace)
nine-router.js (context, boot, workspace)
conversation.js (context, workspace)
updates.js (context)
    ↑
channels.js (context, util, workspace, config)
appointments.js (context, util, workspace, channels)  ← fireApptPushTarget calls sendZaloTo/sendTelegram
zalo-memory.js (context, workspace, channels)
zalo-plugin.js (context, workspace, boot, config)
persona.js (context, workspace)
    ↑
escalation.js (context, workspace, channels, conversation)
follow-up.js (context, workspace, channels)
gateway.js (context, boot, config, channels, vendor-patches, zalo-plugin)
knowledge.js (context, util, workspace, boot, embedder)
    ↑
cron.js (context, boot, config, channels, gateway, conversation, persona, follow-up)
cron-api.js (context, workspace, cron)
    ↑
dashboard-ipc.js (requires ALL modules — thin dispatcher layer)
    ↑
main.js (orchestrates everything)
```

No cycles. Each arrow points upward (dependency → dependant).

### Shared helper functions placement

| Function | Target module | Reason |
|----------|--------------|--------|
| `auditLog` | workspace.js | Calls getWorkspace() — must be in same or later module |
| `appDataDir` | boot.js | Platform path resolution utility |
| `resolveBinAbsolute` | boot.js | Binary resolution |
| `enumerateNodeManagerBinDirs` | boot.js | Node manager discovery |
| `enumerateNodeManagerLibDirs` | boot.js | Node manager lib discovery |
| `findGlobalPackageFile` | boot.js | Global npm package resolution |
| `npmGlobalModules` | boot.js | npm global path |
| `getWorkspaceTemplateRoot` | workspace.js | Template path resolution |
| `getOpenclawAgentWorkspace` | workspace.js | Agent workspace path |
| `purgeAgentSessions` | workspace.js | Workspace cleanup |
| `getBrandAssetsDir` | workspace.js | Brand assets path |
| `isPathSafe` | util.js | Path safety check |
| `initFileLogger`, `getLogFilePath` | main.js (stays) | Runs before any module loads, writes to process.stdout |

## Extraction Order (5 waves)

### Wave 0 — Prep (1 commit)
- Extend `smoke-test.js` with module contract section: for each extracted module, `require()` it and assert expected exports are functions. Starts empty, grows with each wave. ~1 line per export.

### Wave 1 — Zero dependencies (pure leaf)
1. `context.js` — shared state singleton
2. `util.js` — writeJsonAtomic, tokenizeShellish, sanitizeZaloText, stripTelegramMarkdown, isPathSafe, misc
3. `workspace.js` — getWorkspace, invalidateWorkspaceCache, getWorkspaceTemplateRoot, getOpenclawAgentWorkspace, seedWorkspace, purgeAgentSessions, getBrandAssetsDir, getFbConfigPath, readFbConfig, writeFbConfig, getSetupCompletePath, hasCompletedOnboarding, markOnboardingComplete, isOpenClawConfigured, getAppPrefsPath, loadAppPrefs, saveAppPrefs, auditLog, enforceRetentionPolicies, backupWorkspace
4. `boot.js` — findNodeBin, getBundledNodeBin, getBundledVendorDir, getBundledOpenClawCliJs, findBundledOpenClawMjs, findOpenClawBin, findOpenClawBinSync, findOpenClawCliJs, spawnOpenClawSafe, runOpenClaw, appDataDir, resolveBinAbsolute, enumerateNodeManagerBinDirs, enumerateNodeManagerLibDirs, findGlobalPackageFile, npmGlobalModules, augmentPathWithBundledNode, ensureVendorExtracted, runSplashAndExtractVendor, bootDiagLog, bootDiagInit, bootDiagRunFullCheck

### Wave 2 — Depend on Wave 1 + context
5. `config.js` — ensureDefaultConfig, healOpenClawConfigInline, writeOpenClawConfigIfChanged, sanitizeOpenClawConfigInPlace, withOpenClawConfigLock, parseUnrecognizedKeyErrors, isValidConfigKey
6. `nine-router.js` — start9Router, stop9Router, ensure9RouterDefaultPassword, ensure9RouterProviderKeys, autoFix9RouterSqlite, waitFor9RouterReady, nineRouterApi, saveProviderKey, validateOllamaKeyDirect, call9Router, call9RouterVision, detectChatgptPlusOAuth
7. `conversation.js` — extractConversationHistoryRaw, extractConversationHistory, writeDailyMemoryJournal, appendPerCustomerSummaries, trimZaloMemoryFile, _withMemoryFileLock, _recentProfileHistory
8. `updates.js` — checkForUpdates, downloadUpdate, installDmgUpdate, compareVersions, openGitHubUrl

### Wave 3 — Depend on Wave 1-2
9. `channels.js` — sendTelegram, sendTelegramPhoto, sendTelegramRich, sendZalo, sendZaloTo, sendCeoAlert, probeTelegramReady, probeZaloReady, findOpenzcaListenerPid, isZaloListenerAlive, getReadyGateState, finalizeTelegramReadyProbe, finalizeZaloReadyProbe, pauseChannel, resumeChannel, getChannelPauseStatus, setChannelPermanentPause, clearChannelPermanentPause, isZaloChannelEnabled, setZaloChannelEnabled, isChannelPaused, filterSensitiveOutput, broadcastChannelStatusOnce, startChannelStatusBroadcast, getTelegramConfig, getTelegramConfigWithRecovery, getGatewayAuthToken, getCeoSessionKey, sendToGatewaySession, registerTelegramCommands, getStickyChatIdPath, persistStickyChatId, loadStickyChatId, recoverChatIdFromTelegram
10. `appointments.js` — readAppointments, writeAppointments, mutateAppointments, normalizeAppointment, startAppointmentDispatcher, apptDispatcherTick, vnHHMM, vnDDMM, vnHHMMNow, vnDateKeyNow, substituteApptTemplate, defaultApptPushTemplate, buildApptReminderText, fireApptPushTarget
11. `zalo-memory.js` — per-customer CRUD, parseZaloUserMemoryMeta, getZaloUsersDir, getZaloGroupsDir, ensureZaloUsersDir, sanitizeZaloUserId, runZaloCacheRefresh, startZaloCacheAutoRefresh, invalidateZaloFriendsCache, isZaloTargetAllowed, isKnownZaloTarget, getZcaProfile, getZcaCacheDir, readZaloChannelState, getZaloBlocklistPath, cleanBlocklist, hardenSensitiveFilePerms, seedGroupHistorySummary, seedAllGroupHistories
12. `zalo-plugin.js` — ensureZaloPlugin, _ensureZaloPluginImpl, findOpenzcaCliJs, ensureModoroZaloNodeModulesLink, seedZaloCustomersFromCache, checkZaloCookieAge, cleanupOrphanZaloListener
13. `persona.js` — compilePersonaMix, syncPersonaToBootstrap, syncShopStateToBootstrap, syncAllBootstrapData

### Wave 4 — Depend on Wave 1-3
14. `escalation.js` — processEscalationQueue, startEscalationChecker
15. `follow-up.js` — readFollowUpQueue, writeFollowUpQueue, processFollowUpQueue, startFollowUpChecker, scanZaloFollowUpCandidates, buildZaloFollowUpPrompt
16. `gateway.js` — startOpenClaw, _startOpenClawImpl, stopOpenClaw, isGatewayAlive, startFastWatchdog, fastWatchdogTick, _fwCanRestart, killPort, killAllOpenClawProcesses, triggerGatewayMessage, waitForIpcDrain, rejectIfBooting, ensureVisionFix, ensureVisionCatalogFix, ensureVisionSerializationFix, ensureWebFetchLocalhostFix, ensureOpenzcaFriendEventFix, ensureOpenclawPricingFix, ensureOpenclawPrewarmFix (vendor patch wrappers — called from _startOpenClawImpl)
17. `knowledge.js` — getDocumentsDb, autoFixBetterSqlite3, searchKnowledge, searchKnowledgeFTS5, startKnowledgeSearchServer, backfillKnowledgeFromDisk, backfillKnowledgeEmbeddings, backfillDocumentChunks, extractTextFromFile, all RAG + embedding + FTS functions

### Wave 5 — Highest-level orchestration
18. `cron.js` — startCronJobs, _startCronJobsInner, stopCronJobs, restartCronJobs, runCronAgentPrompt, _runCronAgentPromptImpl, selfTestOpenClawAgent, runCronViaSessionOrFallback, runSafeExecCommand, parseSafeOpenzcaMsgSend, buildAgentArgs, isTransientErr, isConfigInvalidErr, isFatalErr, cronJournalPath, journalCronRun, loadSchedules, loadCustomCrons, watchCustomCrons, healCustomCronEntries, _withCustomCronLock, _removeCustomCronById, surfaceCronConfigError, all cron prompt builders (buildMorningBriefingPrompt, buildEveningSummaryPrompt, buildWeeklyReportPrompt, buildMonthlyReportPrompt, buildMeditationPrompt, buildMemoryCleanupPrompt, loadDailySummaries, generateWeeklySummary, loadWeeklySummaries, loadPromptTemplate), handleTimCommand, handleThongkeCommand, handleBaocaoCommand, handleTelegramBuiltinCommand
19. `cron-api.js` — startCronApi, HTTP route handlers
20. `dashboard-ipc.js` — all ipcMain.handle() registrations (thin dispatchers, including 9 gcal handlers routing to existing gcal/*.js)
21. **Slim main.js** — app lifecycle, createWindow, createTray, installEmbedHeaderStripper, boot sequence

## Slim main.js (~500-700 lines)

After all extractions, main.js contains only:

1. `initFileLogger()` + `getLogFilePath()` (stays — runs before any module, writes to process.stdout)
2. `require()` all modules
3. `app.requestSingleInstanceLock()` + file-based lock
4. `registerEarlyIpcHandlers()` — license, app-prefs, setup-complete, log-file-path
5. `app.whenReady()`:
   - Update `ctx.userDataDir = app.getPath('userData')` for packaged builds
   - `powerSaveBlocker.start('prevent-app-suspension')` (Mac App Nap fix)
   - `powerMonitor.on('resume'/'suspend')` listeners (audit trail)
   - `installEmbedHeaderStripper()` (Electron session API, called once)
   - `createWindow()` — includes `registerAllIpcHandlers(win)` BEFORE `loadFile()`
   - `createTray()`
   - Inside createWindow boot chain: `ensureVendorExtracted` → `seedWorkspace` → `ensureZaloPlugin` (fire-and-forget) → `seedZaloCustomersFromCache` → `startOpenClaw` → `startCronJobs` → `startCronApi` → `startEscalationChecker` → `startFollowUpChecker` → `startAppointmentDispatcher` → `startChannelStatusBroadcast` → `startFastWatchdog` → `startZaloCacheAutoRefresh` → `watchCustomCrons`
   - Delayed boot tasks (outside createWindow): `ensureKnowledgeFolders` → `backfillKnowledgeFromDisk` → `backfillDocumentChunks` (10s delay) → `backfillKnowledgeEmbeddings` (30s delay) → `verifyEmbedderModelSha` (15s delay) → `startKnowledgeSearchServer` → `checkForUpdates` (15s delay) → `enforceRetentionPolicies` + 6h interval → `hardenSensitiveFilePerms`
   - Note: `ensureDefaultConfig` and `start9Router` are called from within `_startOpenClawImpl()`, not directly from main.js
6. Quit lifecycle: `before-quit` → set `ctx.appIsQuitting` → drain IPC → call `cleanup()` on each module (gateway, cron, nine-router, channels, follow-up, appointments, zalo-memory, knowledge)
7. Signal handlers: SIGINT/SIGTERM cleanup
8. `createWindow()` function (~150 lines — BrowserWindow config, webPreferences, loadFile)
9. `createTray()` function (~100 lines — tray menu, click handlers)
10. `installEmbedHeaderStripper()` function (~40 lines — session header stripping)

## v49 Member Compatibility

**Zero visible change:**
- IPC channel names: identical (same strings in dashboard-ipc.js)
- Workspace files: same paths, same formats
- Boot sequence: same order, same functions, same side effects
- openclaw.json: no key changes
- Plugin copy: same mechanism from packages/modoro-zalo/

**Build:** electron-builder `files` glob already covers `electron/**` — new `lib/*.js` files included automatically.

## Verification Per Commit

Each extraction commit verified by:
1. `node -e "require('./electron/lib/<module>')"` — loads without error
2. `npm run smoke` — smoke test passes (includes module contract checks added in Wave 0)
3. Manual: launch app → boot completes → bot replies on Telegram + Zalo

**Module contract in smoke test:** For each extracted module, smoke test `require()`s it and asserts expected exports are functions. Catches typos, missing exports, broken requires. ~1 line per export, grows with each wave.

**Rollback:** Each commit moves functions from main.js to a lib/ file and replaces them with `require()` calls. Reverting one commit restores both the inline functions to main.js AND removes the lib/ file — self-contained, no orphaned state.

## Documentation Updates

After modularization complete: update `docs/PREFLIGHT.md` to reference function names + module paths instead of line numbers (e.g., `lib/gateway.js:startOpenClaw` instead of `main.js:~4464`).

## Out of Scope

- No TypeScript migration
- No preload.js or dashboard.html changes
- No new abstractions (EventBus, DI, plugin system)
- No renaming IPC channels
- No test framework (Vitest is separate future effort)
- No function signature changes
- No ClawX-specific features (HTTP API server, Zustand, React)
- No merging/renaming existing lib/ or gcal/ files
