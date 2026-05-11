const { app, BrowserWindow, Tray, Menu, nativeImage, shell, powerSaveBlocker, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');

// ============================================
//  GPU ACCELERATION — disable for Quadro/legacy GPU compatibility
// ============================================
// Electron/Chromium GPU renderer calls into GPU driver at kernel level.
// Old professional GPUs (Quadro K4000, older AMD FirePro, etc.) have driver
// bugs triggered by Chromium's GPU init → BSOD 0x00000050 PAGE_FAULT.
// Software rendering is sufficient for our dashboard UI (no WebGL needed).
app.disableHardwareAcceleration();

// ============================================
//  SINGLE INSTANCE LOCK (must be before app.whenReady)
// ============================================
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  const dbgBase = process.platform === 'darwin'
    ? path.join(require('os').homedir(), 'Library', 'Application Support', '9bizclaw')
    : path.join(process.env.APPDATA || require('os').homedir(), '9bizclaw');
  const dbgPath = path.join(dbgBase, 'logs', 'singleton-blocked.log');
  try { fs.mkdirSync(path.dirname(dbgPath), { recursive: true }); } catch {}
  try { fs.appendFileSync(dbgPath, `[${new Date().toISOString()}] single-instance blocked — another instance holds the lock\n`); } catch {}
  app.quit();
  process.exit(0);
}

// ============================================
//  FILE LOGGER — redirect console.* to main.log
// ============================================
// Without this, packaged Electron swallows console.log (they go to a hidden
// OS log buffer that end users can't reach). CEO must open DevTools with
// Ctrl+Shift+I to see anything — tệ UX. Solution: tee all console writes to
// a simple rotating file the user can open via tray menu → "Mở thư mục log".
//
// Path: <userData>/logs/main.log  (+ previous session rotated to main.log.1)
// Rotates on every app start so each launch has a clean log for repro.
let _logFilePath = null;
let _logStream = null;
let _retentionTimer = null;
function initFileLogger() {
  try {
    // app.getPath('userData') only works after app.whenReady, but we can use
    // APPDATA directly here since Electron userData defaults to
    // <appData>/<app.getName()>. CRITICAL: app.getName() reads package.json
    // top-level `name` field which is "9bizclaw" (LOWERCASE). It does NOT
    // read build.productName ("MODOROClaw") — that's electron-builder installer
    // metadata only. Hardcoding capital "MODOROClaw" creates a phantom dir
    // separate from Electron's real userData, splitting logs across two paths.
    const isWin = process.platform === 'win32';
    const appData = process.env.APPDATA
      || (isWin ? path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming') : null)
      || (process.platform === 'darwin'
          ? path.join(process.env.HOME || '', 'Library', 'Application Support')
          : path.join(process.env.HOME || '', '.config'));
    const logsDir = path.join(appData, '9bizclaw', 'logs');
    try { fs.mkdirSync(logsDir, { recursive: true }); } catch {}
    const logPath = path.join(logsDir, 'main.log');
    // Rotate previous session's log
    try {
      if (fs.existsSync(logPath)) {
        const oldPath = path.join(logsDir, 'main.log.1');
        try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch {}
        try { fs.renameSync(logPath, oldPath); } catch {}
      }
    } catch {}
    _logFilePath = logPath;
    _logStream = fs.createWriteStream(logPath, { flags: 'a' });

    const origLog = console.log.bind(console);
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);
    const ts = () => new Date().toISOString();
    const writeLine = (level, args) => {
      try {
        const line = `[${ts()}] [${level}] ` + args.map(a => {
          if (a instanceof Error) return a.stack || a.message;
          if (typeof a === 'object') {
            try { return JSON.stringify(a); } catch { return String(a); }
          }
          return String(a);
        }).join(' ') + '\n';
        _logStream.write(line);
      } catch {}
    };
    console.log = (...args) => { origLog(...args); writeLine('INFO', args); };
    console.warn = (...args) => { origWarn(...args); writeLine('WARN', args); };
    console.error = (...args) => { origError(...args); writeLine('ERROR', args); };

    // Capture uncaught exceptions + unhandled rejections
    process.on('uncaughtException', (err) => {
      writeLine('FATAL', ['uncaughtException:', err && err.stack ? err.stack : err]);
    });
    process.on('unhandledRejection', (reason) => {
      writeLine('FATAL', ['unhandledRejection:', reason && reason.stack ? reason.stack : reason]);
    });

    console.log('==========================================');
    console.log('9BizClaw starting —', new Date().toISOString());
    console.log('log file:', logPath);
    console.log('platform:', process.platform, 'arch:', process.arch);
    console.log('electron:', process.versions.electron, 'node:', process.versions.node);
    console.log('==========================================');
  } catch (e) {
    // If logger init fails, don't break the app — just run without file logging
    try { console.error('[initFileLogger] failed:', e?.message || e); } catch {}
  }
}
function getLogFilePath() { return _logFilePath; }
initFileLogger();

const ctx = require('./lib/context');
ctx.getLogFilePath = getLogFilePath;
const {
  getWorkspace, invalidateWorkspaceCache, seedWorkspace,
  hasCompletedOnboarding, isOpenClawConfigured, loadAppPrefs,
  auditLog, enforceRetentionPolicies, hardenSensitiveFilePerms,
  setCompilePersonaMix,
} = require('./lib/workspace');
const {
  initPathAugmentation,
  findOpenClawBinSync,
  bootDiagRunFullCheck,
} = require('./lib/boot');
const {
  stop9Router, setKillPort,
} = require('./lib/nine-router');
const { checkForUpdates } = require('./lib/updates');
const {
  setChannelPermanentPause, setZaloChannelEnabled,
  pauseChannel, sendCeoAlert,
  probeTelegramReady, probeZaloReady,
  broadcastChannelStatusOnce, startChannelStatusBroadcast,
  setIsZaloTargetAllowed: setChannelsIsZaloTargetAllowed,
  setGetZcaProfile: setChannelsGetZcaProfile,
  setIsKnownZaloTarget: setChannelsIsKnownZaloTarget,
  setReadZaloChannelState: setChannelsReadZaloChannelState,
  setIsGatewayAlive: setChannelsIsGatewayAlive,
  setCheckZaloCookieAge: setChannelsCheckZaloCookieAge,
  cleanupChannelTimers,
  trackChannelBootTimer,
} = require('./lib/channels');
const { startAppointmentDispatcher, cleanupAppointmentTimers } = require('./lib/appointments');
const {
  getZcaProfile, readZaloChannelState, isZaloTargetAllowed, isKnownZaloTarget,
  startZaloCacheAutoRefresh,
  cleanupZaloMemoryTimers,
} = require('./lib/zalo-memory');
const {
  cleanupOrphanZaloListener,
  ensureZaloPlugin, seedZaloCustomersFromCache,
  findOpenzcaCliJs, checkZaloCookieAge,
} = require('./lib/zalo-plugin');
const { compilePersonaMix } = require('./lib/persona');
const { startEscalationChecker, cleanupEscalationTimers } = require('./lib/escalation');
const {
  startFollowUpChecker, cleanupFollowUpTimers,
  setRunCronAgentPrompt: setFollowUpRunCronAgentPrompt,
} = require('./lib/follow-up');
const {
  killPort, killAllOpenClawProcesses,
  isGatewayAlive, waitForIpcDrain,
  startOpenClaw, stopOpenClaw,
  startFastWatchdog,
  cleanupGatewayTimers,
  setCreateTray, setKnowledgeCallbacks,
} = require('./lib/gateway');
const {
  KNOWLEDGE_CATEGORIES,
  getKnowledgeCategories,
  ensureKnowledgeFolders, backfillKnowledgeFromDisk,
  rewriteKnowledgeIndex,
  startKnowledgeSearchServer, getKnowledgeHttpServer, cleanupKnowledgeServer,
  backfillKnowledgeEmbeddings, backfillDocumentChunks,
  verifyEmbedderModelSha,
  initEmbedder,
} = require('./lib/knowledge');
const { isModelDownloaded, downloadModels } = require('./lib/model-downloader');
const { runPreflightChecks } = require('./lib/preflight');

// Wire compilePersonaMix into workspace.js (used by seedWorkspace persona compilation)
setCompilePersonaMix(compilePersonaMix);

// Cron module (extracted from main.js — Task 19)
const {
  runCronAgentPrompt,
  watchCustomCrons,
  startCronJobs, cleanupCronTimers,
} = require('./lib/cron');

const { startCronApi, cleanupCronApi } = require('./lib/cron-api');
const { startCeoMessageWatcher, startNudgeTimer, cleanupNudgeTimers } = require('./lib/ceo-nudge');
const { cleanupCeoMemoryTimers } = require('./lib/ceo-memory');
const fbSchedule = require('./lib/fb-schedule');
const { registerAllIpcHandlers } = require('./lib/dashboard-ipc');
const { compactAllSessions, compactSession, getAllSessionStats, parseCompactCommand, setAutoCompactTrigger, autoCompactIfNeeded } = require('./lib/compact');
const { setMemoryWriteNotifyCeo } = require('./lib/conversation');
const { sendMemoryWriteAlert } = require('./lib/channels');

// Wire runCronAgentPrompt into follow-up.js (now imported from cron.js)
setFollowUpRunCronAgentPrompt(runCronAgentPrompt);

// Wire killPort into nine-router.js (gateway.js now owns killPort)
setKillPort(killPort);

// Wire auto-compact trigger into Zalo plugin
// compact.js calls this once; inbound.ts fires it before every LLM call
setAutoCompactTrigger((sessionPath) => autoCompactIfNeeded(sessionPath));

// Wire memory write notification into conversation.js
// Fires CEO Telegram alert on every customer memory write (except routine daily cron)
setMemoryWriteNotifyCeo(sendMemoryWriteAlert);

// Wire isGatewayAlive into channels.js (gateway.js now owns it)
setChannelsIsGatewayAlive(isGatewayAlive);

// Wire knowledge callbacks into gateway.js
setKnowledgeCallbacks({
  getKnowledgeHttpServer,
  startKnowledgeSearchServer,
  KNOWLEDGE_CATEGORIES,
  getKnowledgeCategories,
  rewriteKnowledgeIndex,
});

// Wire late-binding setters for channels.js (moved from IPC handler zone)
setChannelsIsZaloTargetAllowed(isZaloTargetAllowed);
setChannelsGetZcaProfile(getZcaProfile);
setChannelsIsKnownZaloTarget(isKnownZaloTarget);
setChannelsReadZaloChannelState(readZaloChannelState);
setChannelsCheckZaloCookieAge(checkZaloCookieAge);

// Register all 118 IPC handlers (extracted to lib/dashboard-ipc.js — Task 21)
registerAllIpcHandlers();

// Wire createTray into gateway.js (hoisted function declaration — safe here)
setCreateTray(createTray);

initPathAugmentation();

// ============================================
//  WINDOW
// ============================================

function createWindow() {
  const openclawBin = findOpenClawBinSync();

  ctx.mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: '9BizClaw',
    resizable: true,
    backgroundColor: '#0A0A0F',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Enable <webview> so embedded 9Router + OpenClaw web UIs run in their
      // own browsing context. Required for cookie-based auth (login session)
      // to persist — <iframe> in a file:// parent makes the embedded origin
      // "third-party", which Electron blocks by default and breaks 9Router login.
      webviewTag: true,
    },
  });

  ctx.mainWindow.setMenuBarVisibility(false);

  // Ctrl+R to reload UI (dev), Ctrl+Shift+I for DevTools
  ctx.mainWindow.webContents.on('before-input-event', (e, input) => {
    const mod = input.control || input.meta; // Ctrl on Windows, Cmd on Mac
    if (mod && input.key === 'r') { ctx.mainWindow.reload(); e.preventDefault(); }
    if (mod && input.key === 'F5') { ctx.mainWindow.webContents.reloadIgnoringCache(); e.preventDefault(); }
    if (input.key === 'F5') { ctx.mainWindow.reload(); e.preventDefault(); }
    if (mod && input.shift && input.key === 'I') { ctx.mainWindow.webContents.toggleDevTools(); e.preventDefault(); }
  });
  ctx.mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  ctx.mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  ctx.mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    const url = params.src || '';
    const allowedOrigins = [
      'http://127.0.0.1:20128', 'http://127.0.0.1:18789', 'http://127.0.0.1:18791',
      'http://localhost:20128', 'http://localhost:18789', 'http://localhost:18791'
    ];
    if (!allowedOrigins.some(origin => url.startsWith(origin))) {
      event.preventDefault();
    }
  });

  console.log('[createWindow] openclawBin:', openclawBin);
  if (app.isPackaged) {
    console.log('[createWindow] app.isPackaged=true, platform=', process.platform);
    console.log('[createWindow] userData:', app.getPath('userData'));
    console.log('[createWindow] resourcesPath:', process.resourcesPath);
  }
  const configured = openclawBin ? isOpenClawConfigured() : false;
  const onboardingComplete = hasCompletedOnboarding();
  console.log('[createWindow] configured:', configured);
  console.log('[createWindow] onboardingComplete:', onboardingComplete);

  // Register ready-to-show BEFORE any early return (license gate, etc.) so
  // the window always becomes visible regardless of which page is loaded.
  // CRITICAL: guard against flash when a splash window is also being shown.
  // Both windows may fire ready-to-show within milliseconds of each other.
  // If the main window shows while splash is still up, user sees both.
  ctx.mainWindow.once('ready-to-show', () => {
    let startMinimized = false;
    try { startMinimized = !!loadAppPrefs().startMinimized; } catch {}
    if (startMinimized) {
      console.log('[createWindow] startMinimized=true → hiding window (tray only)');
      try { ctx.mainWindow.hide(); } catch {}
    } else if (global._splashActive) {
      // Splash is still up — defer show until splash closes so they never overlap.
      // When splash closes below, we call mainWindow.show() explicitly.
      console.log('[createWindow] splash still active, deferring show()');
    } else {
      ctx.mainWindow.show();
    }
  });

  // License gate (membership builds only) — blocks ALL pages until valid key
  const isMembershipBuild = require('./package.json').membership === true;
  if (isMembershipBuild) {
    const license = require('./lib/license');
    const ls = license.checkLicenseStatus();
    if (ls.status === 'no_license' || ls.status === 'invalid' || ls.status === 'locked' || ls.status === 'expired') {
      console.log('[createWindow] membership build, license status:', ls.status, '-> license.html');
      ctx.mainWindow.loadFile(path.join(__dirname, 'ui', 'license.html'));
      return;
    }
    console.log('[createWindow] membership build, license valid');
  }

  if (!openclawBin) {
    console.error('[createWindow] → no-openclaw.html (findOpenClawBinSync returned null)');
    ctx.mainWindow.loadFile(path.join(__dirname, 'ui', 'no-openclaw.html'));
  } else if (configured) {
    console.log('[createWindow] → dashboard.html');
    ctx.mainWindow.loadFile(path.join(__dirname, 'ui', 'dashboard.html'));
    ctx.mainWindow.maximize();
    // Ensure workspace files exist BEFORE cron jobs try to read them
    try { seedWorkspace(); } catch (e) { console.error('[seedWorkspace early] error:', e.message); }
    if (!onboardingComplete) {
      setZaloChannelEnabled(false).catch((e) => { console.error('[createWindow] setZaloChannelEnabled error:', e.message); });
      try { setChannelPermanentPause('zalo', 'review-required-before-autoboot'); } catch {}
      console.log('[createWindow] onboarding marker missing → dashboard only, skip auto-start');
    } else {
      // ORDER MATTERS — same 3-step chain as wizard-complete:
      //   1. ensureZaloPlugin() — copy bundled plugin / heal missing plugin
      //      BEFORE gateway boots. Without this, the gateway config-reload
      //      watcher races with the bundled-copy and can miss the modoro-zalo
      //      channel registration on cold boot.
      //   2. startCronApi() — local API token must exist before gateway snapshots prompts.
      //   3. startOpenClaw() — ensureDefaultConfig + gateway spawn.
      //   4. startCronJobs() — AFTER both above so first cron fire sees a
      //      healed config with a running gateway.
      (async () => {
        try { await ensureZaloPlugin(); } catch (e) { console.error('[boot] ensureZaloPlugin error:', e?.message || e); }
        // Seed customer profiles from openzca cache AFTER plugin is ready but
        // BEFORE startOpenClaw so gateway's first message sees populated memory.
        try { seedZaloCustomersFromCache(); } catch (e) { console.error('[boot] seedZaloCustomers error:', e?.message || e); }
        try { startCronApi(); } catch (e) { console.error('[boot] startCronApi preflight error:', e?.message || e); }
        try { await startOpenClaw(); } catch (e) { console.error('[boot] startOpenClaw error:', e?.message || e); }
        startRuntimeSidecars('boot');
        // Warm cookie age check 30s after boot, then broadcast loop handles daily cadence.
        setTimeout(() => { try { checkZaloCookieAge(); } catch {} }, 30000);
      })();
    }
  } else {
    console.log('[createWindow] → wizard.html');
    ctx.mainWindow.loadFile(path.join(__dirname, 'ui', 'wizard.html'));
    // Wizard now uses full-screen 2-column layout — maximize so business owners
    // see the premium onboarding without scrolling.
    ctx.mainWindow.maximize();
  }

  ctx.mainWindow.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); ctx.mainWindow.hide(); }
  });
}

function startRuntimeSidecars(source) {
  const prefix = source ? `[${source}]` : '[runtime-sidecars]';
  try { startCronApi(); } catch (e) { console.error(prefix, 'startCronApi error:', e?.message || e); }
  try { startCronJobs(); } catch (e) { console.error(prefix, 'startCronJobs error:', e?.message || e); }
  try { startFollowUpChecker(); } catch (e) { console.error(prefix, 'startFollowUpChecker error:', e?.message || e); }
  try { startEscalationChecker(); } catch (e) { console.error(prefix, 'startEscalationChecker error:', e?.message || e); }
  try { watchCustomCrons(); } catch (e) { console.error(prefix, 'watchCustomCrons error:', e?.message || e); }
  try { startZaloCacheAutoRefresh(); } catch (e) { console.error(prefix, 'startZaloCacheAutoRefresh error:', e?.message || e); }
  try { startAppointmentDispatcher(); } catch (e) { console.error(prefix, 'startAppointmentDispatcher error:', e?.message || e); }
  try { startCeoMessageWatcher(); } catch (e) { console.error(prefix, 'startCeoMessageWatcher error:', e?.message || e); }
  try { startNudgeTimer(); } catch (e) { console.error(prefix, 'startNudgeTimer error:', e?.message || e); }
  // Auto-compact fires inside Zalo inbound handler (triggerAutoCompact in inbound.ts)
  // triggered before every LLM call — no separate interval needed
}

function createTray() {
  if (ctx.tray) { ctx.tray.destroy(); ctx.tray = null; }

  const iconPath = path.join(__dirname, 'ui', 'tray-icon.png');
  let icon;
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath);
  } else {
    const s = 16, buf = Buffer.alloc(s * s * 4);
    for (let i = 0; i < s * s; i++) { buf[i*4]=249; buf[i*4+1]=115; buf[i*4+2]=22; buf[i*4+3]=255; }
    icon = nativeImage.createFromBuffer(buf, { width: s, height: s });
  }

  ctx.tray = new Tray(icon);
  ctx.tray.setToolTip('9BizClaw — Trợ lý AI cho CEO');
  try { global.__tray = ctx.tray; } catch {}

  const show = () => {
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) { ctx.mainWindow.show(); ctx.mainWindow.focus(); }
  };

  // Pick a platform-appropriate label for "open log file in editor". On Mac
  // this opens TextEdit; calling it "Notepad" was Win-only and confusing.
  const openLogFileLabel = process.platform === 'win32'
    ? 'Mở file log trong Notepad'
    : 'Mở file log trong trình soạn thảo';

  ctx.tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mở Dashboard', click: show },
    { type: 'separator' },
    { label: ctx.botRunning ? 'Bot đang chạy' : 'Bot đã dừng', enabled: false },
    { label: ctx.botRunning ? 'Dừng bot' : 'Khởi động bot', click: () => {
        if (ctx.botRunning) {
          stopOpenClaw();
        } else {
          (async () => {
            try { startCronApi(); } catch (e) { console.error('[tray] startCronApi preflight error:', e?.message || e); }
            try { await startOpenClaw(); } catch (e) { console.error('[tray] startOpenClaw error:', e?.message || e); }
            startRuntimeSidecars('tray');
          })();
        }
        createTray();
      }
    },
    { type: 'separator' },
    { label: 'Tạm dừng Zalo 30 phút', click: async () => {
        try { await pauseChannel('zalo', 30); } catch (e) { console.error('[tray] pause zalo failed:', e?.message || e); }
      }
    },
    { label: 'Tạm dừng Telegram 30 phút', click: async () => {
        try { await pauseChannel('telegram', 30); } catch (e) { console.error('[tray] pause telegram failed:', e?.message || e); }
      }
    },
    { type: 'separator' },
    { label: 'Mở thư mục log (chẩn đoán)', click: () => {
        try {
          const logPath = getLogFilePath();
          if (logPath && fs.existsSync(logPath)) {
            shell.showItemInFolder(logPath);
          } else if (logPath) {
            shell.openPath(path.dirname(logPath));
          }
        } catch (e) { console.error('[tray] open log folder failed:', e?.message || e); }
      }
    },
    { label: openLogFileLabel, click: () => {
        try {
          const logPath = getLogFilePath();
          if (logPath && fs.existsSync(logPath)) shell.openPath(logPath);
        } catch (e) { console.error('[tray] open log file failed:', e?.message || e); }
      }
    },
    { type: 'separator' },
    { label: 'Thoát 9BizClaw', click: () => { app.isQuitting = true; stopOpenClaw(); app.quit(); } },
  ]));
  // Single-click toggles window visibility (Windows). On Mac, click shows the
  // context menu natively — this handler still runs and is harmless.
  ctx.tray.on('click', () => {
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      if (ctx.mainWindow.isVisible()) ctx.mainWindow.hide();
      else { ctx.mainWindow.show(); ctx.mainWindow.focus(); }
    }
  });
}

// ============================================
//  APP LIFECYCLE
// ============================================

app.on('second-instance', () => {
  if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
    if (ctx.mainWindow.isMinimized()) ctx.mainWindow.restore();
    ctx.mainWindow.show();
    ctx.mainWindow.focus();
  }
});

// Strip frame-blocking headers for trusted local web UIs (9Router + OpenClaw gateway)
// so we can embed them in <webview> inside the dashboard.
//
// CRITICAL: dashboard.html uses <webview partition="persist:embed-openclaw"> and
// <webview partition="persist:embed-9router">. Each `partition` value creates
// its OWN session in Electron — `session.defaultSession.webRequest` listeners
// do NOT fire for partition sessions. We must install the stripper on EACH
// partition session separately, plus defaultSession (for any future iframes
// in the main BrowserWindow).
//
// Symptom of forgetting: openclaw web UI shows blank/blocked inside the app
// (X-Frame-Options: DENY + CSP frame-ancestors 'none' enforced) while 9Router
// embed works fine (it doesn't send those headers). User report v2.0.0:
// "không view được openclaw trong app, bật web thì bt, view 9router bt".
function installEmbedHeaderStripper() {
  try {
    const { session } = require('electron');
    const TRUSTED_LOCAL = [
      'http://127.0.0.1:18789', 'http://localhost:18789',
      'http://127.0.0.1:20128', 'http://localhost:20128',
    ];
    function attach(sess, label) {
      try {
        sess.webRequest.onHeadersReceived((details, callback) => {
          const url = details.url || '';
          if (!TRUSTED_LOCAL.some(o => url.startsWith(o))) {
            return callback({ responseHeaders: details.responseHeaders });
          }
          const headers = {};
          for (const [k, v] of Object.entries(details.responseHeaders || {})) {
            const lower = k.toLowerCase();
            if (lower === 'x-frame-options') continue; // strip XFO entirely
            if (lower === 'content-security-policy') {
              // Remove only frame-ancestors directive (keeps other CSP intact)
              headers[k] = (Array.isArray(v) ? v : [v]).map(line =>
                String(line).split(';')
                  .filter(d => !d.trim().toLowerCase().startsWith('frame-ancestors'))
                  .join(';')
              );
              continue;
            }
            headers[k] = v;
          }
          callback({ responseHeaders: headers });
        });
        console.log('[embed] Header stripper attached to session:', label);
      } catch (e) {
        console.warn('[embed] Could not attach to', label, ':', e?.message);
      }
    }
    // Apply to default session (covers iframes inside the main BrowserWindow)
    attach(session.defaultSession, 'defaultSession');
    // CRITICAL: also apply to partition sessions used by <webview> tags in
    // dashboard.html. Without these, openclaw webview never loads because the
    // partition session doesn't go through defaultSession's webRequest hooks.
    attach(session.fromPartition('persist:embed-openclaw'), 'persist:embed-openclaw');
    attach(session.fromPartition('persist:embed-9router'), 'persist:embed-9router');
    // Redirect new-window requests (OAuth popups, external links) from webview
    // partitions to the default browser. Without this, 9Router's ChatGPT OAuth
    // opens inside Electron's restricted context → freezes on Mac.
    for (const partName of ['persist:embed-9router', 'persist:embed-openclaw']) {
      try {
        session.fromPartition(partName).setWindowOpenHandler(({ url }) => {
          if (url && url.startsWith('http')) {
            require('electron').shell.openExternal(url).catch(() => {});
          }
          return { action: 'deny' };
        });
      } catch (e) { console.warn('[embed] setWindowOpenHandler failed for', partName, e?.message); }
    }
  } catch (e) {
    console.error('[embed] Failed to install header stripper:', e.message);
  }
}

app.whenReady().then(async () => {
  // Update ctx.userDataDir now that app is ready
  if (app.isPackaged) {
    ctx.userDataDir = app.getPath('userData');
    invalidateWorkspaceCache(); // Force getWorkspace() to re-evaluate with new ctx.userDataDir
  }

  // Mac: strip Gatekeeper quarantine xattr from runtime vendor on first boot.
  // DMG drag triggers quarantine on all files inside the DMG. Without xattr
  // strip, spawning userData/vendor/node/bin/node fails with
  // "cannot be opened because it is from an unidentified developer".
  // Idempotent via .xattr-stripped marker.
  if (process.platform === 'darwin' && app.isPackaged) {
    try {
      const markerPath = path.join(app.getPath('userData'), '.xattr-stripped');
      if (!fs.existsSync(markerPath)) {
        const vendorPath = path.join(app.getPath('userData'), 'vendor');
        if (fs.existsSync(vendorPath)) {
          require('child_process').spawn('xattr', ['-dr', 'com.apple.quarantine', vendorPath], {
            stdio: 'ignore', detached: true,
          }).on('exit', () => {
            try { fs.writeFileSync(markerPath, new Date().toISOString()); } catch {}
          });
          console.log('[mac-xattr] stripping quarantine from vendor/ (background)');
        }
      }
    } catch (e) { console.warn('[mac-xattr] strip failed:', e.message); }
  }

  // Mac: auto-eject installer DMG after drag-to-Applications.
  // Without this, the mounted DMG volume causes a duplicate Launchpad icon
  // (one from /Applications, one from /Volumes/9BizClaw*). Eject is safe —
  // the app is already copied to /Applications at this point.
  if (process.platform === 'darwin' && app.isPackaged && !app.getAppPath().startsWith('/Volumes/')) {
    try {
      const volumes = fs.readdirSync('/Volumes').filter(v => /^9BizClaw/i.test(v));
      for (const vol of volumes) {
        const mountPoint = path.join('/Volumes', vol);
        console.log('[mac-dmg-eject] ejecting installer volume:', mountPoint);
        require('child_process').spawn('hdiutil', ['detach', mountPoint, '-quiet'], {
          stdio: 'ignore', detached: true,
        }).unref();
      }
    } catch {}
  }

    // v2.4.0+ pure runtime install model:
  // - No bundled vendor tar in EXE — runtime installer downloads everything on first launch.
  // - userData/vendor/ holds runtime-installed Node + npm packages.
  // - gogcli is optional (Google Workspace CLI) — never blocks boot.
  let splashWindow;
  try {
    const runtimeInstaller = require('./lib/runtime-installer');
    const migration = require('./lib/migration');
    const conflictDetector = require('./lib/conflict-detector');

    // Surface any detected conflicts proactively — helps users understand why install is slow.
    if (app.isPackaged) {
      try {
        const cdResult = await conflictDetector.detectAllConflicts();
        if (cdResult && (cdResult.packages?.length || cdResult.strategies?.length)) {
          console.log('[boot] Conflict detection result:', JSON.stringify(cdResult));
          const issues = cdResult.strategies.map(s => `${s.type}: ${s.reason}`).join('; ');
          if (issues) {
            console.log('[boot] Conflicts detected:', issues);
            try {
              const diagFile = path.join(getWorkspace(), 'logs', 'boot-diagnostic.txt');
              fs.appendFileSync(diagFile, `[conflict-detector] ${issues}\n`);
            } catch {}
          }
        }
      } catch (e) {
        console.warn('[boot] Conflict detection failed (non-fatal):', e.message);
      }
    }

    // Check if we need work BEFORE showing splash (fast subsequent launches = no splash)
    const preCheck = await runtimeInstaller.checkInstallation();
    const needsRagModel = !isModelDownloaded();
    const needsWork = !preCheck.ready || needsRagModel || (migration.isUpgradeFromV23() && !migration.isMigrationCompleted());

    // Show splash window ONLY if we have real work to do
    let _splashCancelRequested = false;
    let _splashCancelTimer = null;
    if (needsWork) {
      global._splashActive = true;
      splashWindow = new BrowserWindow({
        width: 540,
        height: 400,
        minWidth: 540,
        minHeight: 400,
        frame: false,
        resizable: true,
        movable: true,
        alwaysOnTop: true,
        backgroundColor: '#0a0a0c',
        show: false,
        skipTaskbar: false,
        webPreferences: {
          preload: path.join(__dirname, 'splash-preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      const { ipcMain } = require('electron');
      ipcMain.on('splash-minimize', () => { try { splashWindow.minimize(); } catch {} });
      ipcMain.on('splash-cancel', () => {
        _splashCancelRequested = true;
        try {
          splashWindow.webContents.send('splash-error', 'Cài đặt bị hủy. Thoát ứng dụng để thử lại.');
          _splashCancelTimer = setTimeout(() => { try { app.exit(0); } catch {} }, 3000);
        } catch {}
      });
      splashWindow.setMenuBarVisibility(false);
      try {
        await splashWindow.loadFile(path.join(__dirname, 'ui', 'splash.html'));
      } catch (loadErr) {
        console.error('[boot] Splash HTML failed to load:', loadErr?.message);
        try { splashWindow.destroy(); } catch {}
        splashWindow = null;
      }
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.show();
        splashWindow.focus();
      }
    }

    const sendSplashProgress = (data) => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        try { splashWindow.webContents.send('splash-progress', data); } catch {}
      }
    };

    // Migration: v2.3.x → v2.4.0 (bundled vendor → runtime install)
    if (migration.isUpgradeFromV23() && !migration.isMigrationCompleted()) {
      console.log('[boot] Detected upgrade from v2.3.x, running migration...');
      const migrationResult = await new Promise((resolve, reject) => {
        migration.runMigration({
          onProgress: (data) => {
            if (splashWindow && !splashWindow.isDestroyed()) {
              try { splashWindow.webContents.send('splash-progress', data); } catch {}
            }
          },
          onError: (err) => { console.error('[boot] Migration error:', err); },
        }).then(resolve).catch(reject);
      });
      if (!migrationResult.migrated && migrationResult.error) {
        throw new Error('Migration failed: ' + migrationResult.error);
      }
      console.log('[boot] Migration completed:', migrationResult.migrated ? 'success' : 'skipped');
    }

    // Pure runtime install: download Node + npm packages if not yet installed.
    // On fast subsequent launches, checkInstallation() returns ready=true → skip.
    const status = await runtimeInstaller.checkInstallation();
    if (!status.ready) {
      console.log('[boot] Runtime installation needed...');
      const installedStatus = await runtimeInstaller.runInstallation({
        onProgress: sendSplashProgress,
      });
      if (!installedStatus?.ready) {
        const missing = [
          ...(installedStatus?.missingPackages || []),
          installedStatus?.needsNodeInstall ? 'node' : null,
          installedStatus?.needsModoroZaloInstall ? 'modoro-zalo' : null,
        ].filter(Boolean);
        if (installedStatus?.gogReady === false) {
          console.warn('[boot] gogcli unavailable — Google Workspace CLI not installed');
        }
        throw new Error('Runtime install incomplete' + (missing.length ? ': ' + missing.join(', ') : ''));
      }
      console.log('[boot] Runtime installation completed');
    } else {
      console.log('[boot] Runtime installation already complete');
    }

    // RAG embedding model: download if missing (upgrade from pre-RAG version or failed previous download)
    if (!isModelDownloaded()) {
      console.log('[boot] RAG model missing — downloading on splash...');
      try {
        await downloadModels({
          onProgress: (p) => sendSplashProgress({ step: 'model', percent: p.percent, message: p.message }),
        });
        console.log('[boot] RAG model download complete');
      } catch (e) {
        console.warn('[boot] RAG model download failed (non-fatal):', e?.message);
        sendSplashProgress({ step: 'model', percent: 100, message: 'Tải mô hình AI thất bại — sẽ thử lại sau' });
      }
    }

    // Close splash window
    if (splashWindow && !splashWindow.isDestroyed()) {
      try {
        sendSplashProgress({ step: 'complete', percent: 100, message: 'Sẵn sàng!' });
        await new Promise(r => setTimeout(r, 500));
        splashWindow.close();
      } catch {}
    }
    global._splashActive = false;
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed() && ctx.mainWindow.isVisible() === false) {
      try { ctx.mainWindow.show(); } catch {}
    }
  } catch (e) {
    console.error('[boot] Runtime installation/migration failed:', e);
    global._splashActive = false;
    // If user already clicked cancel, don't show retry/quit — cancel's 3s exit timer is running
    if (_splashCancelRequested) {
      console.log('[boot] Install error after cancel — letting cancel timer handle exit');
      return;
    }
    if (splashWindow && !splashWindow.isDestroyed()) {
      // Clear any pending cancel timer so it doesn't exit under the user
      if (_splashCancelTimer) { clearTimeout(_splashCancelTimer); _splashCancelTimer = null; }
      try {
        splashWindow.webContents.send('splash-error', String(e?.message || e));
      } catch {}
      const { ipcMain } = require('electron');
      await new Promise((resolve) => {
        ipcMain.once('splash-retry', () => {
          console.log('[boot] User requested retry — restarting app...');
          try { app.relaunch(); } catch {}
          app.exit(0);
        });
        ipcMain.once('splash-quit', () => {
          console.log('[boot] User quit after install failure');
          app.exit(1);
        });
        splashWindow.once('closed', () => {
          console.log('[boot] Splash window closed externally — exiting');
          app.exit(1);
        });
        setTimeout(() => {
          console.log('[boot] Splash error timeout (10min) — exiting');
          app.exit(1);
        }, 10 * 60 * 1000);
      });
      return;
    }
    try {
      const { dialog } = require('electron');
      dialog.showErrorBox('Môi trường cài đặt chưa sẵn sàng', 'Máy tính của bạn cần một số điều kiện để chạy 9BizClaw.\n\nVui lòng kiểm tra kết nối Internet, quyền ghi thư mục, và dung lượng ổ đĩa.\n\nChi tiết kỹ thuật:\n' + String(e?.message || e));
    } catch {}
    app.exit(1);
    return;
  }

  // Initialize knowledge embedder after ctx.userDataDir update.
  try { initEmbedder(); } catch (e) { console.warn('[boot] initEmbedder error:', e?.message || e); }

  // Boot diagnostic: writes <workspace>/logs/boot-diagnostic.txt with everything
  // we need to debug "why didn't cron work?". MUST run after ctx.userDataDir update
  // so the file goes to the right workspace.
  try { bootDiagRunFullCheck(); } catch (e) { console.error('[boot-diag] error:', e?.message || e); }

  try {
    const pf = await runPreflightChecks();
    if (!pf.allCriticalPass) {
      const failMsgs = pf.criticalFailures.map(f => `${f.name}: ${f.message}`).join('\n');
      console.error('[boot] CRITICAL preflight failures:\n' + failMsgs);
      try { auditLog('preflight_critical_failure', { failures: pf.criticalFailures }); } catch {}
    }
    if (pf.warnings.length) {
      try { auditLog('preflight_warnings', { warnings: pf.warnings }); } catch {}
    }
  } catch (e) {
    console.warn('[boot] preflight error (non-fatal):', e?.message || e);
  }

  installEmbedHeaderStripper(); // BEFORE createWindow so first iframe load is unblocked
  createWindow();
  createTray();

  // License check (membership builds only) — verify signature + check revocation 15s after boot
  if (require('./package.json').membership === true) {
    setTimeout(async () => {
      try {
        const license = require('./lib/license');
        const ls = license.checkLicenseStatus();
        if (ls.status === 'expired') {
          sendCeoAlert('[Bản quyền] Bản quyền 9BizClaw đã hết hạn. Liên hệ tech@modoro.com.vn để gia hạn.');
        } else if (ls.status === 'valid' && ls.daysLeft !== null && ls.daysLeft <= 14) {
          sendCeoAlert('[Bản quyền] Bản quyền 9BizClaw sẽ hết hạn trong ' + ls.daysLeft + ' ngày. Liên hệ gia hạn sớm.');
        }
        if (ls.status === 'valid') {
          const result = await license.revalidateLicense();
          console.log('[license] revalidation:', result ? 'ok (not revoked)' : 'revoked or check failed');
          if (!result) {
            sendCeoAlert('[Bản quyền] Key đã bị thu hồi. Liên hệ tech@modoro.com.vn.');
            if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
              ctx.mainWindow.loadFile(path.join(__dirname, 'ui', 'license.html'));
            }
          }
        }
      } catch (e) { console.error('[license] check error:', e?.message); }
    }, 15000);
    // Periodic revalidation every 2 hours (revocation check)
    setInterval(async () => {
      try {
        const license = require('./lib/license');
        const ls = license.checkLicenseStatus();
        if (ls.status !== 'valid') return;
        const result = await license.revalidateLicense();
        if (!result) {
          console.warn('[license] periodic revalidation: revoked');
          sendCeoAlert('[Bản quyền] Key đã bị thu hồi. Liên hệ tech@modoro.com.vn.');
          if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
            ctx.mainWindow.loadFile(path.join(__dirname, 'ui', 'license.html'));
          }
        }
      } catch (e) { console.error('[license] periodic revalidation error:', e?.message); }
    }, 2 * 60 * 60 * 1000);
  }

  // CRITICAL for Mac: prevent App Nap from suspending the process. macOS aggressively
  // suspends background apps after ~30s of no UI interaction, which freezes
  // setTimeout/setInterval — including node-cron's internal timer wheel. Without
  // this, the CEO's 7:30am morning report won't fire if the Mac was asleep or
  // backgrounded overnight. `prevent-app-suspension` is the lightest power blocker
  // (does NOT prevent display sleep, just prevents the OS from freezing JS timers).
  // On Windows it's a no-op (Windows doesn't App Nap). Idempotent: tracks blockerId
  // so repeated boots don't leak blockers.
  try {
    if (typeof global.__powerBlockerId === 'number' && powerSaveBlocker.isStarted(global.__powerBlockerId)) {
      powerSaveBlocker.stop(global.__powerBlockerId);
    }
    global.__powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    console.log('[power] prevent-app-suspension started, id=', global.__powerBlockerId);
  } catch (e) {
    console.warn('[power] failed to start power blocker:', e?.message);
  }

  // Defense in depth: when the system wakes from sleep, manually re-check cron
  // schedules. node-cron's timer wheel may have skipped firings while the
  // process was suspended (despite the powerSaveBlocker above — belt + braces).
  // We don't refire jobs ourselves; we just log the wake event so audit log
  // shows the gap, and force a config reload so any time-based check refreshes.
  try {
    powerMonitor.on('resume', () => {
      console.log('[power] system resume detected — node-cron may have skipped firings during sleep');
      try { auditLog('system_resume', { ts: new Date().toISOString() }); } catch {}
      // After wake, channel-status broadcast cadence is 45s → CEO can see stale
      // "đang kiểm tra" for up to 45s. Kick a fast-poll schedule mirroring the
      // boot pattern (see _channelStatusBootTimers) so UI feels instant post-wake.
      console.log('[power] resume — triggering fast channel-status refresh');
      try {
        const resumeTimers = [];
        // 2s: give network/mDNS a moment to stabilize, then refresh probe caches
        // directly BEFORE the broadcast fires so the broadcast sees fresh data.
        resumeTimers.push(setTimeout(() => {
          Promise.allSettled([
            (async () => { try { await probeTelegramReady(); } catch {} })(),
            (async () => { try { await probeZaloReady(); } catch {} })(),
          ]).finally(() => {
            try { broadcastChannelStatusOnce(); } catch {}
          });
        }, 2000));
        // Fast-poll series mirroring boot pattern (A6)
        for (const delay of [3000, 6000, 10000, 15000]) {
          resumeTimers.push(setTimeout(() => {
            try { broadcastChannelStatusOnce(); } catch {}
          }, delay));
        }
        for (const t of resumeTimers) trackChannelBootTimer(t);
      } catch (e) {
        console.warn('[power] resume fast-refresh failed:', e?.message);
      }
    });
    powerMonitor.on('suspend', () => {
      console.log('[power] system suspend detected');
      try { auditLog('system_suspend', { ts: new Date().toISOString() }); } catch {}
    });
  } catch (e) {
    console.warn('[power] could not register powerMonitor listeners:', e?.message);
  }

  // Pre-install Zalo plugin in background (so QR is fast when user clicks)
  ensureZaloPlugin().catch(() => {});
  // Re-index any Knowledge files that exist on disk but are missing from DB
  // (e.g. uploaded while better-sqlite3 was broken). Non-blocking.
  try { ensureKnowledgeFolders(); } catch {}
  // Always regenerate index.md from disk files at boot — even when DB is
  // broken (ABI mismatch after upgrade). rewriteKnowledgeIndex reads DB if
  // available, but merges in disk-only files so the bot's bootstrap context
  // always sees every document the CEO uploaded. Without this, upgrading
  // the app could leave index.md stale → bot forgets all knowledge.
  try {
    for (const cat of getKnowledgeCategories()) {
      try { rewriteKnowledgeIndex(cat); } catch (e) {
        console.warn('[knowledge] boot index rewrite for', cat, 'failed:', e.message);
      }
    }
  } catch {}
  backfillKnowledgeFromDisk().catch(e => console.error('[knowledge] backfill error:', e.message));
  // K1: chunk-level backfill — fire-and-forget 10s after boot so gateway warmup
  // takes priority. Non-blocking; safe no-op if DB still broken.
  setTimeout(() => {
    backfillDocumentChunks().catch(e => console.error('[knowledge] chunk backfill error:', e.message));
  }, 10000);
  // H7: verify embedder model SHA early so tamper alert surfaces fast.
  setTimeout(() => {
    verifyEmbedderModelSha().catch(e => console.warn('[embedder-sha] boot:', e?.message));
  }, 15000);
  // RAG: lazy vector backfill — 30s after boot so chunk backfill + gateway
  // warmup go first. Non-blocking; safe no-op if DB still broken or no missing rows.
  setTimeout(() => {
    backfillKnowledgeEmbeddings().catch(e => console.warn('[knowledge-backfill] boot:', e?.message));
  }, 30000);
  // Security Layer 5: enforce log rotation + memory retention policies.
  // Non-blocking. Runs at boot PLUS every 6h thereafter so long-running
  // installs (CEO leaves app open weeks, Zalo+Telegram busy) don't blow
  // past the 10MB openclaw.log + 50MB audit.jsonl caps until next restart.
  // Found by Round 2C scale review 2026-04-18.
  try { enforceRetentionPolicies(); } catch (e) { console.warn('[retention] boot call failed:', e?.message); }
  _retentionTimer = setInterval(() => {
    try { enforceRetentionPolicies(); }
    catch (e) { console.warn('[retention] periodic call failed:', e?.message); }
  }, 6 * 60 * 60 * 1000);
  if (_retentionTimer.unref) _retentionTimer.unref();
  // Security Layer 1 (scoped): chmod 600 sensitive files (Unix only).
  // Non-blocking, runs once at boot.
  try { hardenSensitiveFilePerms(); } catch (e) { console.warn('[file-harden] boot call failed:', e?.message); }
  // Security audit: record the boot event itself
  try { auditLog('app_boot', { platform: process.platform, node: process.versions.node, electron: process.versions.electron }); } catch {}
  // Start the real-readiness probe broadcast so sidebar dots stay accurate
  startChannelStatusBroadcast();
  // Knowledge search HTTP endpoint — gateway process (openclaw) calls this
  // from inbound.ts patch to RAG-enrich messages before dispatch to agent.
  // Localhost-only bind for security.
  try { startKnowledgeSearchServer(); } catch (e) { console.warn('[knowledge-http] boot failed:', e?.message); }
  // Auto-update check 15s after boot — non-blocking, silent if no update
  setTimeout(() => {
    checkForUpdates().catch(e => console.warn('[update] boot check failed:', e?.message));
  }, 15000);
  // Fast self-heal watchdog — 20s interval, separate from cron heartbeat.
  // Goal: <30s downtime on any component failure.
  // Gateway: 1st fail → 3s recheck → 2nd fail → immediate restart (~25s total)
  // 9Router: dead (getRouterProcess()=null + port down) → restart immediately
  // Zalo listener: 2 consecutive misses → restart gateway (~45s total)
  startFastWatchdog();
}).catch(console.error);

app.on('window-all-closed', () => {});
app.on('activate', () => {
  if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) { ctx.mainWindow.show(); ctx.mainWindow.focus(); }
});
// Centralized lifecycle-cleanup helper (intervals, watchers, cron, child
// processes). Called AFTER A5's IPC drain so no handler fires against a
// half-torn-down state. Each step wrapped so one failure doesn't block rest.
function _beforeQuitCleanup() {
  // (1) Clear all tracked intervals via module cleanup functions
  try { cleanupFollowUpTimers(); } catch (e2) { console.warn('[before-quit] cleanupFollowUpTimers:', e2?.message); }
  try { cleanupZaloMemoryTimers(); } catch (e2) { console.warn('[before-quit] cleanupZaloMemoryTimers:', e2?.message); }
  try { cleanupAppointmentTimers(); } catch (e2) { console.warn('[before-quit] cleanupAppointmentTimers:', e2?.message); }
  try { if (_retentionTimer) { clearInterval(_retentionTimer); _retentionTimer = null; } } catch {}
  try { cleanupChannelTimers(); } catch (e2) { console.warn('[before-quit] cleanupChannelTimers:', e2?.message); }
  try { cleanupGatewayTimers(); } catch (e2) { console.warn('[before-quit] cleanupGatewayTimers:', e2?.message); }
  try { cleanupEscalationTimers(); } catch (e2) { console.warn('[before-quit] cleanupEscalationTimers:', e2?.message); }
  try { cleanupNudgeTimers(); } catch (e2) { console.warn('[before-quit] cleanupNudgeTimers:', e2?.message); }
  try { cleanupCeoMemoryTimers(); } catch (e2) { console.warn('[before-quit] cleanupCeoMemoryTimers:', e2?.message); }
  try { cleanupKnowledgeServer(); } catch (e2) { console.warn('[before-quit] cleanupKnowledgeServer:', e2?.message); }

  // (2) Stop all cron jobs + watchers + pollers
  try { cleanupCronTimers(); } catch (e2) { console.warn('[before-quit] cleanupCronTimers:', e2?.message); }

  // (3) Close cron API HTTP server
  try { cleanupCronApi(); } catch (e2) { console.warn('[before-quit] cleanupCronApi:', e2?.message); }

  // (4) Stop child processes — synchronous kill (stopOpenClaw is async, can't await here)
  // Fire stopOpenClaw for its proc.kill + await-exit logic, but also do
  // synchronous killPort + killAll as belt-and-suspenders (the async parts
  // of stopOpenClaw may not complete before app.exit fires).
  try { stopOpenClaw(); } catch (e2) { console.warn('[before-quit] stopOpenClaw:', e2?.message); }
  try { killPort(18789); } catch {}
  try { killAllOpenClawProcesses(); } catch {}
  try { cleanupOrphanZaloListener(); } catch {}
  try { const googleApi = require('./lib/google-api'); googleApi.cleanupGogProcesses(); } catch (e2) { console.warn('[before-quit] cleanupGogProcesses:', e2?.message); }
  try { stop9Router(); } catch (e2) { console.warn('[before-quit] stop9Router:', e2?.message); }
}

app.on('before-quit', (e) => {
  app.isQuitting = true;
  ctx.appIsQuitting = true;
  // Wait up to 3s for mutating IPC handlers (save-zalo-manager-config,
  // set-inbound-debounce, etc.) to finish writing openclaw.json. Without
  // this, app.exit(0) can interrupt a writeOpenClawConfigIfChanged call
  // mid-rename, leaving a corrupt JSON that breaks next boot.
  // Cleanup (intervals/watchers/cron/child-procs) runs AFTER drain so no
  // tick fires against a half-torn-down state.
  const needsDrain = ctx.ipcInFlightCount > 0;
  if (needsDrain || process.platform === 'win32') {
    e.preventDefault();
    (async () => {
      if (needsDrain) {
        const res = await waitForIpcDrain(3000);
        if (res.drained) console.log(`[quit] IPC drain completed in ${res.elapsed}ms`);
        else console.warn(`[quit] IPC drain TIMEOUT after ${res.elapsed}ms — ${res.inFlight} handlers still in flight`);
      }
      try { _beforeQuitCleanup(); } catch (e2) { console.warn('[quit] cleanup threw:', e2?.message); }
      // On Windows, taskkill is async — give it a moment to finish.
      const tailDelay = process.platform === 'win32' ? 500 : 0;
      setTimeout(() => app.exit(0), tailDelay);
    })();
  } else {
    // Non-drain, non-Windows path — still clean up synchronously.
    try { _beforeQuitCleanup(); } catch (e2) { console.warn('[quit] cleanup threw:', e2?.message); }
  }
});
