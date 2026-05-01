'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFilePromise = promisify(execFile);

const ctx = require('./context');
const { writeJsonAtomic } = require('./util');
const {
  getWorkspace, seedWorkspace, auditLog, backupWorkspace, purgeAgentSessions,
} = require('./workspace');
const {
  getBundledVendorDir, findNodeBin, findOpenClawBin,
  findOpenClawCliJs,
} = require('./boot');
const { ensureDefaultConfig } = require('./config');
const {
  broadcastChannelStatusOnce, sendCeoAlert, sendTelegram,
  findOpenzcaListenerPid, registerTelegramCommands,
} = require('./channels');
const { start9Router, stop9Router, getRouterProcess } = require('./nine-router');
const {
  cleanupOrphanZaloListener,
  seedAllGroupHistories,
} = require('./zalo-plugin');
const { cleanBlocklist } = require('./zalo-memory');
const { syncAllBootstrapData } = require('./persona');
const vendorPatches = require('./vendor-patches');

// ============================================
//  LATE-BINDING SETTERS
// ============================================
let _createTray = null;
function setCreateTray(fn) { _createTray = fn; }

let _knowledgeCallbacks = {
  getKnowledgeHttpServer: () => null,
  startKnowledgeSearchServer: () => {},
  KNOWLEDGE_CATEGORIES: [],
  getKnowledgeCategories: () => [],
  rewriteKnowledgeIndex: () => {},
};
function setKnowledgeCallbacks(cbs) { Object.assign(_knowledgeCallbacks, cbs); }

// ============================================
//  FAST WATCHDOG STATE
// ============================================
let _fastWatchdogInterval = null;
let _fastWatchdogBootTimeout = null;
let _fwTickInFlight = false; // C6: prevent overlapping ticks
let _fwGatewayFailCount = 0;
let _fwZaloMissCount = 0;
const FW_INTERVAL_MS = 20000;
const FW_RECHECK_MS = 3000;
const FW_MAX_RESTARTS_PER_HOUR = 5;
let _fwRestartTimestamps = []; // track restart times for rate limiting
let _fwKnowledgeHttpDead = 0;
let _fwRouterProbeCount = 0;
let _fwRouterHealthFails = 0;

// ============================================
//  KILL HELPERS
// ============================================

// Kill process on a specific port
function killPort(port) {
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf-8', timeout: 3000, windowsHide: true });
      const pids = [...new Set(out.split('\n').map(l => l.trim().split(/\s+/).pop()).filter(p => p && /^\d+$/.test(p) && p !== '0'))];
      for (const pid of pids) { try { execSync(`taskkill /f /pid ${pid}`, { stdio: 'ignore', timeout: 3000, windowsHide: true }); } catch {} }
    } else {
      const out = execSync(`lsof -ti :${port}`, { encoding: 'utf-8', timeout: 3000 });
      const pids = out.trim().split('\n').filter(p => p && /^\d+$/.test(p.trim()));
      // SIGKILL — SIGTERM can be ignored by Node processes holding the port
      for (const pid of pids) {
        const p = parseInt(pid.trim());
        try { process.kill(p, 'SIGKILL'); } catch {}
      }
    }
  } catch {} // No process on port = fine
}

// Kill ALL openclaw + openzca processes (orphan cleanup on stop/restart)
function killAllOpenClawProcesses() {
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'win32') {
      // Kill any node process running openclaw or openzca
      try { execSync('taskkill /f /fi "WINDOWTITLE eq openclaw*" 2>nul', { stdio: 'ignore', timeout: 3000, windowsHide: true }); } catch {}
      try {
        const out = execSync('wmic process where "CommandLine like \'%openclaw%gateway%\'" get ProcessId /format:csv', { encoding: 'utf-8', timeout: 5000, windowsHide: true });
        for (const line of out.split('\n')) {
          const pid = line.trim().split(',').pop();
          if (pid && /^\d+$/.test(pid) && pid !== '0') {
            try { execSync(`taskkill /f /pid ${pid}`, { stdio: 'ignore', timeout: 3000, windowsHide: true }); } catch {}
          }
        }
      } catch {}
    } else {
      try { execSync("pkill -9 -f 'openclaw.*gateway' 2>/dev/null", { stdio: 'ignore', timeout: 3000 }); } catch {}
      try { execSync("pkill -9 -f 'openzca.*listen' 2>/dev/null", { stdio: 'ignore', timeout: 3000 }); } catch {}
    }
  } catch {}
}

// ============================================
//  GATEWAY ALIVE PROBE
// ============================================

// Check if gateway is already running on port 18789
function isGatewayAlive(timeoutMs = 15000) {
  // Generous timeout (15s default) — gateway can be busy serving a cloud-model
  // AI completion cold-start and not return the index page in time. An 8s
  // timeout used to false-positive for cloud-model first-token latency, and a
  // 2s timeout used to false-positive every few minutes, causing the heartbeat
  // watchdog to kill+respawn a healthy gateway → looked like an endless
  // restart loop. Any 2xx/3xx/4xx status counts as alive (the connection
  // itself is what we care about).
  return new Promise((resolve) => {
    const req = require('http').get('http://127.0.0.1:18789', { timeout: timeoutMs }, (res) => {
      res.resume(); resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ============================================
//  VENDOR PATCH WRAPPERS
// ============================================

function ensureVisionFix() { vendorPatches.ensureVisionFix(getBundledVendorDir(), ctx.HOME); }

function ensureVisionCatalogFix() { vendorPatches.ensureVisionCatalogFix(getBundledVendorDir(), ctx.HOME); }

function ensureVisionSerializationFix() { vendorPatches.ensureVisionSerializationFix(getBundledVendorDir(), ctx.HOME); }

function ensureWebFetchLocalhostFix() { vendorPatches.ensureWebFetchLocalhostFix(getBundledVendorDir(), ctx.HOME); }

function ensureOpenzcaFriendEventFix() { vendorPatches.ensureOpenzcaFriendEventFix(getBundledVendorDir(), getWorkspace() || ctx.resourceDir); }
function ensureOpenclawPricingFix() { vendorPatches.ensureOpenclawPricingFix(getBundledVendorDir()); }
function ensureOpenclawPrewarmFix() { vendorPatches.ensureOpenclawPrewarmFix(getBundledVendorDir()); }
function ensureOpenclawUpdateUiDisabled() { vendorPatches.ensureOpenclawUpdateUiDisabled(getBundledVendorDir(), ctx.HOME); }

// ============================================
//  IPC DRAIN + BOOT GUARD
// ============================================

// IPC in-flight counter — incremented on entry to mutating handlers, decremented
// in finally. before-quit awaits drain (up to 3s) so a save isn't interrupted
// by app.exit(0) leaving openclaw.json half-written.
function waitForIpcDrain(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const start = Date.now();
    if (ctx.ipcInFlightCount === 0) { resolve({ drained: true, elapsed: 0 }); return; }
    const iv = setInterval(() => {
      if (ctx.ipcInFlightCount === 0) {
        clearInterval(iv);
        resolve({ drained: true, elapsed: Date.now() - start });
      } else if (Date.now() - start >= timeoutMs) {
        clearInterval(iv);
        resolve({ drained: false, elapsed: Date.now() - start, inFlight: ctx.ipcInFlightCount });
      }
    }, 100);
  });
}

// Shared guard for mutating IPC during gateway boot. Returns a rejection envelope
// when unsafe (restart mid-spawn corrupts openclaw.json or crashes gateway);
// returns null when it's safe to proceed. Keep read-only handlers exempt.
function rejectIfBooting(handlerName) {
  const booting = ctx.startOpenClawInFlight === true
    || (ctx.botRunning === false && ctx.startOpenClawInFlight !== false);
  if (booting) {
    try { console.log(`[${handlerName}] rejected — BOOT_IN_PROGRESS`); } catch {}
    return {
      success: false,
      error: 'BOOT_IN_PROGRESS',
      message: 'Bot đang khởi động, vui lòng đợi vài giây rồi thử lại',
    };
  }
  return null;
}

// ============================================
//  START / STOP OPENCLAW
// ============================================

let _startOpenClawPromise = null;
let _gatewayIntentionalStopDepth = 0;
async function startOpenClaw(opts = {}) {
  if (ctx.botRunning) return;
  // Prevent re-entrant start while a previous start is still spawning. Without
  // this guard, heartbeat + UI button + boot sequence can race and spawn 2-3
  // gateway processes that fight over port 18789.
  if (ctx.startOpenClawInFlight) {
    console.log('[startOpenClaw] already in progress — concurrent caller will wait');
    return _startOpenClawPromise;
  }
  // [restart-guard A1 fix] Check bonjour + network cooldowns at the single
  // choke point. Previously _bonjourCooldownUntil was set but only checked
  // in fast-watchdog — all other call sites bypassed it silently.
  const now = Date.now();
  const bonjourUntil = global._bonjourCooldownUntil || 0;
  const networkUntil = global._networkCooldownUntil || 0;
  const cooldownUntil = Math.max(bonjourUntil, networkUntil);
  if (cooldownUntil > now && !opts.ignoreCooldown) {
    const remaining = Math.ceil((cooldownUntil - now) / 1000);
    const reason = bonjourUntil >= networkUntil ? 'bonjour' : 'network';
    console.log(`[startOpenClaw] ${reason} cooldown active — skipping (${remaining}s remaining)`);
    return;
  }
  if (cooldownUntil > now && opts.ignoreCooldown) {
    console.log('[startOpenClaw] cooldown ignored for explicit gateway restart');
  }
  try { seedWorkspace(); } catch (e) { console.error('[startOpenClaw] seedWorkspace preflight error:', e?.message || e); }
  try { require('./cron-api').startCronApi(); } catch (e) { console.error('[startOpenClaw] startCronApi preflight error:', e?.message || e); }
  ctx.startOpenClawInFlight = true;
  _startOpenClawPromise = (async () => {
  try {
    const r = await _startOpenClawImpl(opts);
    if (ctx.botRunning) ctx.gatewayLastStartedAt = Date.now();
    // Auto-seed group history summaries in the background. Fire-and-forget
    // after a 5s delay so gateway + openzca listener are fully ready before
    // we probe. Never blocks startup; never throws to caller.
    setTimeout(() => {
      try {
        seedAllGroupHistories({ source: 'startOpenClaw' }).catch(e => {
          console.warn('[group-history-seed] auto-run error:', e && e.message ? e.message : String(e));
        });
      } catch (e) {
        console.warn('[group-history-seed] auto-run dispatch error:', e && e.message ? e.message : String(e));
      }
    }, 5000);
    // One-shot index.md upgrade for existing installs: re-embed FULL PDF content
    // into knowledge/<cat>/index.md so bot can answer questions grounded in real
    // document text (not just 200-char summary). Fire-and-forget; never blocks.
    setTimeout(() => {
      try {
        for (const cat of _knowledgeCallbacks.getKnowledgeCategories()) {
          try { _knowledgeCallbacks.rewriteKnowledgeIndex(cat); } catch (e) {
            console.warn('[knowledge-index] boot rewrite', cat, 'err:', e && e.message ? e.message : String(e));
          }
        }
      } catch (e) {
        console.warn('[knowledge-index] boot rewrite dispatch error:', e && e.message ? e.message : String(e));
      }
    }, 12000);
    return r;
  }
  finally { ctx.startOpenClawInFlight = false; _startOpenClawPromise = null; }
  })();
  return _startOpenClawPromise;
}

async function _startOpenClawImpl(opts = {}) {
  // When called from auto-restart contexts (heartbeat, weekly cron, watchdog),
  // opts.silent === true suppresses "Telegram đã sẵn sàng" / "Zalo đã sẵn sàng"
  // boot pings so CEO doesn't get woken at 3:30 AM or spammed on auto-recovery.
  // Flag persists until next non-silent start (normal app boot / wizard-complete).
  if (opts.silent) {
    global._suppressBootPing = true;
    console.log('[startOpenClaw] silent mode — boot pings suppressed');
  } else {
    global._suppressBootPing = false;
  }
  try { backupWorkspace(); } catch (e) { console.error('[backup] failed:', e.message); }
  purgeAgentSessions('startOpenClaw');
  auditLog('startOpenClaw_begin', {});

  const bin = await findOpenClawBin();
  if (!bin) {
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('bot-status', { running: false, error: 'OpenClaw không tìm thấy.' });
    }
    return;
  }

  // === BOOT PARALLELIZATION ===
  // Start 9Router IMMEDIATELY (before patches + memory rebuild) so it has the
  // maximum wall time to warm up. Node module loading on Windows can take
  // 15-20s; if 9router is started AFTER patches, it races the gateway spawn.
  // Root cause of "Telegram + Zalo take 2-3 phút to respond" — 9router was
  // not actually ready when gateway loaded plugins.
  const t0 = Date.now();
  console.log('[boot] T+0ms start9Router (parallel warmup)');
  start9Router();

  // Ensure config is valid before anything (patches run in parallel with 9router warmup)
  await ensureDefaultConfig();

  // Apply non-zalo vendor patches. ensureModoroZaloNodeModulesLink + plugin copy
  // are handled inside _ensureZaloPluginImpl (called earlier in boot).
  const _patchFns = [
    ensureOpenclawPricingFix,
    ensureOpenclawPrewarmFix,
    ensureOpenclawUpdateUiDisabled,
    cleanBlocklist,
    ensureOpenzcaFriendEventFix,
    ensureVisionFix,
    ensureVisionCatalogFix,
    ensureVisionSerializationFix,
    ensureWebFetchLocalhostFix,
  ];
  for (const fn of _patchFns) {
    try { fn(); } catch (e) { console.error(`[boot] ${fn.name} threw:`, e?.message); }
  }

  // Sync persona + shop-state into bootstrap files (SOUL.md, USER.md) so bot
  // receives them automatically without needing to read separate files.
  syncAllBootstrapData();

  // Rebuild memory DB — use absolute node path so it works even if Electron's
  // PATH doesn't include the user's Node install (nvm/volta/scoop/etc.).
  try {
    const rebuildScript = path.join(ctx.resourceDir, 'tools', 'memory-db', 'rebuild-db.js');
    if (fs.existsSync(rebuildScript)) {
      const nodeBin = findNodeBin() || 'node';
      await execFilePromise(nodeBin, [rebuildScript], { timeout: 10000, cwd: ctx.resourceDir, stdio: 'pipe' });
    }
  } catch (e) { console.error('Memory DB rebuild failed:', e.message); }

  // CRIT #12: On cold boot (first call per Electron session), NEVER adopt an
  // orphan gateway. The orphan may have been spawned by a previous crashed
  // Electron, with stale in-memory config predating our latest patches — all
  // our ensureXxxFix runs + ensureDefaultConfig heals would have ZERO effect
  // on this run because the orphan already loaded the old config. Force a
  // clean respawn. Heartbeat-triggered restarts (after _coldBootDone=true)
  // still get to adopt so we don't thrash port during steady-state.
  if (!global._coldBootDone) {
    // R3: short 1500ms timeout on cold-boot probe. Fresh install has no
    // orphan → ECONNREFUSED fires <50ms. Only Defender-scanned ports see
    // any delay. 8s default would add dead time to every launch.
    const orphan = await isGatewayAlive(1500);
    if (orphan) {
      console.log('[boot] cold-start: killing stale gateway on :18789 (prevent stale-config adoption)');
      try { killPort(18789); } catch {}
      // Bumped 10×300ms (3s) → 30×500ms (15s). Observed on slow Defender-
      // heavy machines: taskkill can take 5-8s to fully release the port,
      // and a premature exit-with-port-still-bound leads to our new spawn
      // failing with EADDRINUSE. 15s is safe ceiling; fresh installs with
      // no orphan break out immediately on first iteration anyway.
      let stillAlive = true;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (!(await isGatewayAlive(1500))) { stillAlive = false; break; }
      }
      if (stillAlive) {
        const msg = '[cold-boot] gateway still alive after 15s — taskkill strategy exhausted';
        console.warn(msg);
        try { auditLog('gateway_stale_kill_fail', { port: 18789, strategyMs: 15000 }); } catch {}
      }
    }
    global._coldBootDone = true;
  } else {
    // Steady-state restart (e.g. heartbeat): adoption is fine
    const alreadyRunning = await isGatewayAlive();
    if (alreadyRunning) {
      console.log('Gateway already running on :18789 — adopting (steady-state restart)');
      ctx.botRunning = true;
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) ctx.mainWindow.webContents.send('bot-status', { running: true });
      if (_createTray) _createTray();
      // Adopting existing gateway — verify it's actually serving before
      // confirming channels. Without the alive check, dots flash green
      // immediately even if gateway is mid-restart or hung.
      if (!global._readyNotifyState) global._readyNotifyState = {};
      for (const ch of ['telegram', 'zalo']) {
        if (!global._readyNotifyState[ch]) global._readyNotifyState[ch] = {};
        const st = global._readyNotifyState[ch];
        if (!st.confirmedAt) {
          st.markerSeen = true;
          st.markerSeenAt = Date.now();
          st.awaitingConfirmation = true;
          st.lastError = '';
        }
      }
      setTimeout(() => { try { broadcastChannelStatusOnce(); } catch {} }, 500);
      // Delayed confirm: wait 10s then verify gateway alive before green dot
      setTimeout(async () => {
        const alive = await isGatewayAlive(5000);
        for (const ch of ['telegram', 'zalo']) {
          const st = global._readyNotifyState[ch];
          if (st && !st.confirmedAt) {
            if (alive) {
              st.confirmedAt = Date.now();
              st.confirmedBy = 'adopt';
              st.awaitingConfirmation = false;
              st.lastError = '';
            } else {
              st.lastError = 'Gateway adopted nhưng không phản hồi.';
            }
          }
        }
        try { broadcastChannelStatusOnce(); } catch {};
      }, 10000);
      return;
    }
  }

  // Cold start: kill orphan gateway + Zalo listener from previous run
  try { killPort(18789); } catch {}
  try { killAllOpenClawProcesses(); } catch {}
  cleanupOrphanZaloListener();

  // Wait for 9Router /v1/models — bumped from 10 to 60 iterations because Node
  // module loading on Windows can take 15-20s. If we spawn the gateway before
  // 9router responds, the modoro-zalo plugin's first call to 9router fails with
  // ECONNREFUSED → triggers a 30-60s retry-with-backoff stack inside the plugin
  // → CEO sees "2-3 phút before bot replies".
  let nineRouterReady = false;
  let nineRouterModelCount = 0;
  // Exponential backoff: 200ms × 5, 500ms × 5, 1000ms × 50 = ~55s total budget.
  // On fast machines, 9Router ready in <2s (caught in first 5 probes at 200ms).
  // On slow machines (Defender scan), ready in 15-20s (caught at 1s cadence).
  // Previously: flat 1000ms × 60 = always waited ≥1s even on fast machines.
  const _9rDelays = [
    ...Array(5).fill(200),   // T+0.2, 0.4, 0.6, 0.8, 1.0
    ...Array(5).fill(500),   // T+1.5, 2.0, 2.5, 3.0, 3.5
    ...Array(50).fill(1000), // T+4.5 ... T+54.5
  ];
  for (let i = 0; i < _9rDelays.length; i++) {
    await new Promise(r => setTimeout(r, _9rDelays[i]));
    try {
      const body = await new Promise((resolve, reject) => {
        const req = require('http').get('http://127.0.0.1:20128/v1/models', { timeout: 2000 }, (res) => {
          if (res.statusCode !== 200) { res.resume(); reject(); return; }
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { buf += c; });
          res.on('end', () => resolve(buf));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(); });
      });
      try {
        const parsed = JSON.parse(body);
        nineRouterModelCount = Array.isArray(parsed?.data) ? parsed.data.length : 0;
      } catch { nineRouterModelCount = 0; }
      nineRouterReady = true;
      console.log(`[boot] T+${Date.now() - t0}ms 9Router /v1/models ready (after ${Math.round((Date.now() - t0) / 1000)}s), ${nineRouterModelCount} models`);
      break;
    } catch {}
  }
  if (!nineRouterReady) {
    console.warn(`[boot] T+${Date.now() - t0}ms 9Router DID NOT respond within 60s — gateway will spawn anyway, first reply may be slow`);
  } else if (nineRouterModelCount === 0) {
    // LOUD alert: empty combo means EVERY cron fire + EVERY user message will
    // 404 until the user manually fixes it in the 9Router tab. Fire-and-forget
    // Telegram notification so CEO sees the problem before demo time.
    console.error(`[boot] T+${Date.now() - t0}ms 9Router returned 0 models — combo 'main' is empty. Bot replies and cron will FAIL until user configures combo in 9Router tab.`);
    try {
      const diagPath = path.join(getWorkspace(), 'logs', 'boot-diagnostic.txt');
      fs.mkdirSync(path.dirname(diagPath), { recursive: true });
      fs.appendFileSync(diagPath, `\n[${new Date().toISOString()}] [boot] CRITICAL: 9Router /v1/models returned 0 models. Combo 'main' empty. Bot will 404 on first message.\n`, 'utf-8');
    } catch {}
    // Telegram alert: try once, non-blocking. Uses sendTelegram which reads
    // channels.telegram.botToken + allowFrom directly from openclaw.json.
    setTimeout(() => {
      sendTelegram(
        '*Cảnh báo: 9Router combo rỗng*\n\n' +
        'Combo AI `main` không có model nào. Bot sẽ KHÔNG phản hồi và cron sẽ FAIL cho tới khi vào tab *9Router* trong Dashboard, chọn model cho combo `main` và bấm Save.'
      ).catch(() => {});
    }, 2000);
  }

  // NO pre-warm completion call. A previous version of this code fired a hardcoded
  // `gpt-5-mini` completion to force OAuth token refresh, but that failed with
  // "404 No active credentials for provider: openai" whenever the user had
  // configured 9router with a different provider (Claude, Gemini, Ollama, etc.).
  // Don't hardcode any provider/model here — let 9router auto-load whatever
  // the user has set up. The first real user message will do the OAuth refresh
  // naturally. The boot latency benefit of parallel start9Router + 60s wait loop
  // above is already large enough without this extra customization.

  // Start gateway — cwd = writable workspace so it reads/writes AGENTS.md, schedules.json, etc.
  // Prefer direct node + openclaw.mjs spawn so this works regardless of where
  // openclaw is installed (npm/pnpm/nvm/volta) and avoids cmd.exe quirks on
  // Windows when bin is a .cmd shim. Falls back to bin shim if direct path
  // unavailable.
  const gwCliJs = findOpenClawCliJs();
  const gwNodeBin = findNodeBin();
  let gwSpawnCmd = bin;
  let gwSpawnArgs = ['gateway', 'run'];
  let gwSpawnShell = process.platform === 'win32' && bin && bin.endsWith('.cmd');
  if (gwCliJs && gwNodeBin) {
    gwSpawnCmd = gwNodeBin;
    gwSpawnArgs = [gwCliJs, 'gateway', 'run'];
    gwSpawnShell = false;
    console.log('[gateway] spawning via direct node:', gwNodeBin, gwCliJs);
  } else {
    console.warn('[gateway] direct node spawn unavailable (nodeBin=' + !!gwNodeBin + ' cliJs=' + !!gwCliJs + '), falling back to bin shim:', bin);
  }
  // CRITICAL: enrich PATH so child subprocesses spawned by gateway (especially
  // openzca via modoro-zalo plugin) can find npm-installed shims. Electron inherits
  // PATH from explorer.exe / Start Menu launch, which on Windows often does NOT
  // include ~/AppData/Roaming/npm/. Without this, modoro-zalo's `spawn("openzca", ...)`
  // via cmd.exe fails with "openzca is not recognized" → listener never starts →
  // CEO sees "Chưa sẵn sàng" forever.
  // Defense in depth: even though the modoro-zalo package's openzca.ts resolves
  // direct `node <cli.js>` path, this PATH enrichment is still useful for any other
  // npm-installed bin the gateway or its plugins may need to spawn.
  const enrichedEnv = { ...process.env };
  // Expose workspace path so plugin patches can find
  // workspace files regardless of dev vs packaged. main.js getWorkspace()
  // already resolved the correct location at this point.
  // SECURITY: explicitly delete any pre-existing 9BIZ_WORKSPACE from the
  // user's shell env BEFORE setting our own value. Without this, if the user
  // launches Electron from a shell with `9BIZ_WORKSPACE=/tmp` set (or any
  // other poisoned value), and getWorkspace() throws for any reason, the
  // gateway would inherit the poisoned value and patches would write to /tmp.
  delete enrichedEnv['9BIZ_WORKSPACE'];
  try {
    const __ws = getWorkspace();
    if (__ws) enrichedEnv['9BIZ_WORKSPACE'] = __ws;
  } catch (e) {
    console.warn('[gateway] could not resolve 9BIZ_WORKSPACE:', e?.message);
  }
  // Disable openclaw's mDNS/bonjour — causes crash loops on some Windows machines
  // when mDNS watchdog sees its own stale record. openclaw 2026.4.14 official
  // env var (verified at vendor server.impl-BbJvXoPb.js:20261).
  enrichedEnv.OPENCLAW_DISABLE_BONJOUR = "1";
  try {
    const npmBinDirs = [];
    // HIGHEST PRIORITY: bundled vendor node dir. On packaged Windows installs,
    // augmentPathWithBundledNode() is called at module load (before vendor is
    // extracted from tar on first boot) so process.env.PATH does NOT yet have
    // the vendor node dir. We must add it explicitly here so the gateway
    // process and its children (modoro-zalo plugin → spawn('node', [openzca cli.js]))
    // can find the bundled node.exe even on machines with no system Node.
    try {
      const vd = getBundledVendorDir();
      if (vd) {
        const isWin = process.platform === 'win32';
        const vendorNodeBin = isWin ? path.join(vd, 'node') : path.join(vd, 'node', 'bin');
        const vendorNpmBin = path.join(vd, 'node_modules', '.bin');
        if (fs.existsSync(vendorNodeBin)) npmBinDirs.push(vendorNodeBin);
        if (fs.existsSync(vendorNpmBin)) npmBinDirs.push(vendorNpmBin);
      }
    } catch {}
    if (process.platform === 'win32') {
      // Windows: ~/AppData/Roaming/npm and ~/AppData/Local/npm
      npmBinDirs.push(path.join(ctx.HOME, 'AppData', 'Roaming', 'npm'));
      npmBinDirs.push(path.join(ctx.HOME, 'AppData', 'Local', 'npm'));
      npmBinDirs.push('C:\\Program Files\\nodejs');
    } else {
      // Unix: usual npm prefixes + nvm
      npmBinDirs.push('/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin');
      npmBinDirs.push(path.join(ctx.HOME, '.npm-global', 'bin'));
      npmBinDirs.push(path.join(ctx.HOME, '.local', 'bin'));
    }
    const sep = process.platform === 'win32' ? ';' : ':';
    const currentPath = enrichedEnv.PATH || enrichedEnv.Path || '';
    const existingDirs = new Set(currentPath.split(sep).map(d => d.trim()).filter(Boolean));
    const toAdd = npmBinDirs.filter(d => !existingDirs.has(d) && fs.existsSync(d));
    if (toAdd.length > 0) {
      enrichedEnv.PATH = toAdd.join(sep) + sep + currentPath;
      console.log('[gateway] enriched PATH with:', toAdd.join(' | '));
    }
    // Also expose absolute openzca cli.js path so modoro-zalo plugin (patched version)
    // can use it directly without having to search. Search ALL platform-specific
    // locations: Windows AppData, Mac Homebrew (both Intel + Apple Silicon),
    // /usr/local, ~/.npm-global, nvm/volta/asdf shims. First match wins.
    const ozCliCandidates = [];
    // HIGHEST PRIORITY (all platforms): bundled vendor. On fresh installs the
    // user has NO npm-installed openzca, only what we ship. Before this fix,
    // Windows fresh install logged "openzca CLI not found in any known
    // location" because candidates only listed %APPDATA%/npm/... paths.
    try {
      const bundledVendorDir = getBundledVendorDir();
      if (bundledVendorDir) {
        ozCliCandidates.push(path.join(bundledVendorDir, 'node_modules', 'openzca', 'dist', 'cli.js'));
      }
    } catch {}
    if (process.platform === 'win32') {
      ozCliCandidates.push(
        path.join(ctx.HOME, 'AppData', 'Roaming', 'npm', 'node_modules', 'openzca', 'dist', 'cli.js'),
        path.join(ctx.HOME, 'AppData', 'Local', 'npm', 'node_modules', 'openzca', 'dist', 'cli.js'),
        'C:\\Program Files\\nodejs\\node_modules\\openzca\\dist\\cli.js',
      );
    } else {
      // Mac + Linux: enumerate all known npm prefixes
      ozCliCandidates.push(
        '/opt/homebrew/lib/node_modules/openzca/dist/cli.js',     // Apple Silicon Homebrew
        '/usr/local/lib/node_modules/openzca/dist/cli.js',         // Intel Homebrew + system Node
        '/opt/local/lib/node_modules/openzca/dist/cli.js',         // MacPorts
        path.join(ctx.HOME, '.npm-global/lib/node_modules/openzca/dist/cli.js'),
        path.join(ctx.HOME, '.local/lib/node_modules/openzca/dist/cli.js'),
      );
      // nvm: scan all installed Node versions
      try {
        const nvmDir = path.join(ctx.HOME, '.nvm', 'versions', 'node');
        if (fs.existsSync(nvmDir)) {
          for (const v of fs.readdirSync(nvmDir)) {
            ozCliCandidates.push(path.join(nvmDir, v, 'lib', 'node_modules', 'openzca', 'dist', 'cli.js'));
          }
        }
      } catch {}
      // volta
      ozCliCandidates.push(path.join(ctx.HOME, '.volta', 'tools', 'image', 'packages', 'openzca', 'lib', 'node_modules', 'openzca', 'dist', 'cli.js'));
      // asdf
      try {
        const asdfDir = path.join(ctx.HOME, '.asdf', 'installs', 'nodejs');
        if (fs.existsSync(asdfDir)) {
          for (const v of fs.readdirSync(asdfDir)) {
            ozCliCandidates.push(path.join(asdfDir, v, '.npm', 'lib', 'node_modules', 'openzca', 'dist', 'cli.js'));
          }
        }
      } catch {}
      // Packaged Mac .app vendor bundle
      try {
        const vendorCli = path.join(process.resourcesPath || '', 'vendor', 'node_modules', 'openzca', 'dist', 'cli.js');
        ozCliCandidates.push(vendorCli);
      } catch {}
    }
    let foundOzCli = null;
    for (const p of ozCliCandidates) {
      try { if (fs.existsSync(p)) { foundOzCli = p; break; } } catch {}
    }
    if (foundOzCli) {
      enrichedEnv.BIZCLAW_OPENZCA_CLI_JS = foundOzCli;
      console.log('[gateway] openzca CLI:', foundOzCli);
    } else {
      console.warn('[gateway] openzca CLI not found in any known location — Zalo listener may fail. Searched:', ozCliCandidates.length, 'paths');
    }
  } catch (e) {
    console.warn('[gateway] PATH enrichment failed:', e.message);
  }
  ctx.openclawProcess = spawn(gwSpawnCmd, gwSpawnArgs, {
    cwd: getWorkspace(),
    env: enrichedEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: gwSpawnShell,
    windowsHide: true,
  });
  ctx.botRunning = true;
  if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) ctx.mainWindow.webContents.send('bot-status', { running: true });
  if (_createTray) _createTray();

  // CRITICAL: wait for the gateway WebSocket to actually be listening on
  // :18789 before returning. Otherwise `await startOpenClaw()` returns when
  // the process is *spawned* but not yet ready to accept connections, and
  // the very first cron handler that tries to spawn `openclaw agent ...`
  // gets ECONNREFUSED. Cold-start budget: 240 seconds (bumped from 90s —
  // slow machines with Windows Defender scanning vendor files on first install
  // can take 2-3 minutes before gateway binds port 18789).
  const gwStartMs = Date.now();
  const gwReadyDeadline = Date.now() + 240000;
  let gwReady = false;
  let probeAttempts = 0;
  let lastBootingEmitAt = 0;
  // Capture the process reference locally so we can detect external kill
  // (stopOpenClaw sets the global `ctx.openclawProcess = null` but our local
  // ref still points to the killed proc — we check `ctx.openclawProcess === procRef`
  // to bail out fast instead of uselessly probing for 240s).
  const procRef = ctx.openclawProcess;
  while (Date.now() < gwReadyDeadline) {
    probeAttempts++;
    if (ctx.openclawProcess !== procRef) {
      console.warn('[startOpenClaw] gateway process was killed externally during WS wait — aborting probe loop');
      return;
    }
    try {
      if (await isGatewayAlive(2000)) { gwReady = true; break; }
    } catch {}
    // Emit `gateway-booting` IPC every 3s so renderers can disable mutating
    // buttons (A5 also IPC-rejects, this is belt-and-suspenders UI feedback).
    const elapsedSoFar = Date.now() - gwStartMs;
    if (elapsedSoFar - lastBootingEmitAt >= 3000) {
      lastBootingEmitAt = elapsedSoFar;
      try {
        const { BrowserWindow: _BW } = require('electron');
        for (const w of _BW.getAllWindows()) {
          if (!w.isDestroyed()) { try { w.webContents.send('gateway-booting', { elapsedMs: elapsedSoFar }); } catch {} }
        }
      } catch {}
    }
    // Cadence: first 5s use 500ms (catch fast boots), then 1000ms to cut
    // probe count on slow machines (total timeout unchanged).
    const sleepMs = elapsedSoFar < 5000 ? 500 : 1000;
    await new Promise((r) => setTimeout(r, sleepMs));
  }
  if (gwReady) {
    const elapsedMs = Date.now() - gwStartMs;
    console.log(`[startOpenClaw] gateway WS ready on :18789 after ${elapsedMs}ms (${probeAttempts} probes)`);
    global._gatewayStartedAt = Date.now(); // fast watchdog skips first 360s
    auditLog('gateway_ready', { elapsedMs, probeAttempts });
  } else {
    console.log(`[startOpenClaw] gateway WS still not responding after 240s (${probeAttempts} probes). Spawning background monitor.`);
    auditLog('gateway_slow_start', { probeAttempts });
    // Background monitor: keep probing every 5s for up to 10 more minutes.
    // When gateway finally comes up, log + emit audit so dashboard dot updates.
    (async () => {
      const bgDeadline = Date.now() + 600000;
      let bgProbes = 0;
      while (Date.now() < bgDeadline) {
        await new Promise((r) => setTimeout(r, 5000));
        bgProbes++;
        try {
          if (await isGatewayAlive(3000)) {
            const totalMs = Date.now() - gwStartMs;
            console.log(`[startOpenClaw] gateway finally ready after ${totalMs}ms (bg probe #${bgProbes})`);
            global._gatewayStartedAt = Date.now();
            auditLog('gateway_ready_late', { totalMs, bgProbes });
            return;
          }
        } catch {}
      }
      console.warn('[startOpenClaw] gateway never came up after 10min — may need manual restart');
    })();
  }

  // Missed CEO alerts: silently clear on boot. Crons that missed while app
  // was off are expected — don't spam CEO with stale alerts on restart.
  // Dashboard overview still shows the count if file existed before clear.
  setTimeout(() => {
    try {
      const missedFile = path.join(getWorkspace(), 'logs', 'ceo-alerts-missed.log');
      if (fs.existsSync(missedFile)) {
        const content = fs.readFileSync(missedFile, 'utf-8').trim();
        if (content.length > 0) {
          console.log(`[boot] clearing ${content.split('\n').length} stale missed alerts (app was off)`);
          fs.writeFileSync(missedFile, '', 'utf-8');
        }
      }
    } catch (e) { console.warn('[boot] missed-alerts clear failed:', e?.message); }
  }, 20000);

  // Register Telegram slash commands. DELAYED 15s so it runs AFTER OpenClaw
  // gateway's own boot sequence (which may register default openclaw commands).
  // Our call is the LAST one → overwrites defaults with our custom commands.
  // Also re-register every 5 minutes in case gateway restarts and re-registers its own.
  setTimeout(() => {
    registerTelegramCommands().catch(e => console.error('[telegram] registerCommands failed:', e.message));
  }, 15000);
  if (!global._telegramCmdInterval) {
    global._telegramCmdInterval = setInterval(() => {
      registerTelegramCommands().catch(() => {});
    }, 5 * 60 * 1000);
  }

  // Boot ping removed — it was a FAKE readiness signal. Gateway WS responding
  // to GET / (the probe above) does NOT prove Telegram can actually receive
  // and reply to a real message. Real readiness is shown via the sidebar
  // dot (probeTelegramReady = getMe) and the end-to-end "Gửi tin test" button
  // in Dashboard. Don't spam CEO with notifications that don't mean anything.

  const logsDir = path.join(ctx.userDataDir, 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const logStream = fs.createWriteStream(path.join(logsDir, 'openclaw.log'), { flags: 'a' });
  let lastError = '';
  // Swallow pipe errors (they occur when process exits abruptly)
  logStream.on('error', (e) => console.error('[openclaw.log] write error:', e.message));
  ctx.openclawProcess.stdout.on('error', (e) => console.error('[openclaw stdout] pipe error:', e.message));
  ctx.openclawProcess.stderr.on('error', (e) => console.error('[openclaw stderr] pipe error:', e.message));
  ctx.openclawProcess.on('error', (e) => console.error('[openclaw spawn] error:', e.message));
  ctx.openclawProcess.stdout.pipe(logStream).on('error', () => {});
  ctx.openclawProcess.stderr.pipe(logStream).on('error', () => {});
  ctx.openclawProcess.stderr.on('data', (d) => { lastError = d.toString().trim().slice(-300); });

  // REAL READINESS NOTIFICATIONS
  // CEO rule: "nếu thông báo là nhấn phải có reply thật sự" — don't send
  // fake boot pings. Observe specific gateway log markers that indicate
  // a channel is ACTUALLY able to receive + process messages:
  //   - Telegram ready: `[telegram] [default] starting provider (@<bot>)`
  //     (emitted after getMe success + polling active + channel registered)
  //   - Zalo ready: `[modoro-zalo] [default] openzca connected` (or legacy `[openzalo]`)
  //     (emitted when openzca listener websocket is live + reading inbound)
  //
  // On first occurrence per boot, fire a single Telegram notification so
  // CEO knows EXACTLY when it's safe to test. The Telegram notification
  // itself proves Telegram send-path; Zalo notification is sent via
  // Telegram (we don't have CEO's Zalo ID) but content confirms listener
  // connected. If CEO doesn't receive the notification → channel broken.
  if (!global._readyNotifyState) global._readyNotifyState = {};
  const notifyState = global._readyNotifyState;
  notifyState.telegramReady = false;
  notifyState.zaloReady = false;
  notifyState.bootSessionId = Date.now();
  // Clear disk throttle so notification sends on every restart.
  // CEO wants "Telegram đã sẵn sàng" as proof bot works after each boot.
  try { const _bpf = path.join(getWorkspace(), '.boot-ping-ts.json'); if (fs.existsSync(_bpf)) fs.unlinkSync(_bpf); } catch {}
  notifyState.telegram = notifyState.telegram || {};
  notifyState.zalo = notifyState.zalo || {};
  for (const ch of ['telegram', 'zalo']) {
    const channelState = notifyState[ch];
    channelState.markerSeen = false;
    channelState.markerSeenAt = 0;
    channelState.confirmedAt = 0;
    channelState.awaitingConfirmation = false;
    channelState.confirmedBy = '';
    channelState.lastError = '';
    channelState.lastNotifyOkAt = 0;
    if (!Number.isFinite(channelState.lastNotifyOkAt)) channelState.lastNotifyOkAt = 0;
  }
  // H1 throttle: if a readiness notification was already sent within the
  // last 10 minutes, suppress re-notify on subsequent gateway restarts (e.g.
  // mid-demo Stop/Start, heartbeat watchdog fire). CEO shouldn't see the
  // "Telegram đã sẵn sàng" message twice in the same session. The watchdog
  // recovery path still works silently — channel is ready, just no duplicate
  // notification. A fresh boot after >10min gap (app restart next day) still
  // fires normally.
  const READY_NOTIFY_THROTTLE_MS = 30 * 60 * 1000;
  // Persist last boot ping timestamp across Electron restarts so we don't
  // spam CEO with "Telegram đã sẵn sàng" on every app relaunch.
  const _bootPingTsFile = path.join(getWorkspace(), '.boot-ping-ts.json');
  const _loadBootPingTs = () => {
    try { if (fs.existsSync(_bootPingTsFile)) return JSON.parse(fs.readFileSync(_bootPingTsFile, 'utf-8')); } catch {} return {};
  };
  const _saveBootPingTs = (channel) => {
    try { const d = _loadBootPingTs(); d[channel] = Date.now(); writeJsonAtomic(_bootPingTsFile, d); } catch {}
  };
  const readyNotifyThrottled = (channel) => {
    const inMemory = notifyState[channel]?.lastNotifyOkAt || 0;
    const onDisk = _loadBootPingTs()[channel] || 0;
    const last = Math.max(inMemory, onDisk);
    return !!last && (Date.now() - last) < READY_NOTIFY_THROTTLE_MS;
  };
  const markChannelConfirmed = (channel, by, ts = Date.now()) => {
    const st = notifyState[channel];
    st.awaitingConfirmation = false;
    st.confirmedAt = ts;
    st.confirmedBy = by;
    st.lastNotifyOkAt = ts;
    st.lastError = '';
    _saveBootPingTs(channel);
  };
  const readinessBuf = { tg: '', zl: '' };
  const scanForReadiness = (chunk) => {
    try {
      const text = chunk.toString('utf8');
      // Telegram marker — "starting provider" means channel plugin is LOADING,
      // not that it's ready to receive messages. On slow machines, 15-30s gap
      // between marker and actual readiness. We mark markerSeen but delay
      // confirmation to avoid premature green dot.
      if (!notifyState.telegram.markerSeen && /\[telegram\]\s*\[\w+\]\s*starting provider/i.test(text)) {
        notifyState.telegramReady = true;
        notifyState.telegram.markerSeen = true;
        notifyState.telegram.markerSeenAt = Date.now();
        notifyState.telegram.awaitingConfirmation = true;
        notifyState.telegram.lastError = '';
        console.log('[ready-notify] Telegram marker seen — waiting 10s for channel init before confirming');
        setTimeout(() => { try { broadcastChannelStatusOnce(); } catch {} }, 0);
        if (readyNotifyThrottled('telegram') || global._suppressBootPing) {
          // Even on throttle/silent path, wait 10s for channel to finish init
          if (global._suppressBootPing) console.log('[ready-notify] Telegram boot ping suppressed (silent auto-restart)');
          setTimeout(async () => {
            const alive = await isGatewayAlive(5000);
            if (alive) {
              markChannelConfirmed('telegram', global._suppressBootPing ? 'silent' : 'throttle');
              console.log('[ready-notify] Telegram confirmed after post-marker delay (' + (global._suppressBootPing ? 'silent' : 'throttle') + ')');
            } else {
              notifyState.telegram.lastError = 'Gateway không phản hồi sau khi marker xuất hiện.';
              console.log('[ready-notify] Telegram throttle-confirm deferred — gateway not alive');
            }
            setTimeout(() => { try { broadcastChannelStatusOnce(); } catch {} }, 0);
          }, 10000);
        } else {
          // skipFilter: these are OUR system notifications, not AI output.
          // The output filter is meant to catch AI leaking internal info to
          // customers — doesn't apply here. Without skipFilter, Zalo version
          // below was replaced with "Dạ em xin lỗi..." because text contained
          // the brand name "openzca" (see filter pattern brand-openzca).
          sendTelegram(
            'Telegram đã sẵn sàng.\n\n' +
            'Anh/chị nhắn bất kỳ tin nào cho bot ngay bây giờ, sẽ có trả lời thật.\n\n' +
            '(Tin này do bot tự gửi — nếu anh/chị nhận được = Telegram đã hoạt động 100%)',
            { skipFilter: true }
          ).then(ok => {
            if (ok) {
              markChannelConfirmed('telegram', 'send');
              console.log('[ready-notify] Telegram notify sent:', ok);
            } else {
              notifyState.telegram.awaitingConfirmation = true;
              notifyState.telegram.lastError = 'Đã kết nối Telegram nhưng chưa gửi được tin xác nhận sẵn sàng.';
              console.log('[ready-notify] Telegram notify failed');
            }
          }).catch(() => {
            notifyState.telegram.awaitingConfirmation = true;
            notifyState.telegram.lastError = 'Đã kết nối Telegram nhưng gửi tin xác nhận bị lỗi.';
          }).finally(() => {
            setTimeout(() => { try { broadcastChannelStatusOnce(); } catch {} }, 0);
          });
        }
      }
      // Zalo marker — "openzca connected" means WebSocket connected but
      // inbound pipeline may still be initializing. Delay before confirming.
      if (!notifyState.zalo.markerSeen && /\[(?:openzalo|modoro-zalo)\]\s*\[\w+\]\s*openzca connected/i.test(text)) {
        notifyState.zaloReady = true;
        notifyState.zalo.markerSeen = true;
        notifyState.zalo.markerSeenAt = Date.now();
        notifyState.zalo.awaitingConfirmation = true;
        notifyState.zalo.lastError = '';
        console.log('[ready-notify] Zalo marker seen — waiting 10s for pipeline init before confirming');
        setTimeout(() => { try { broadcastChannelStatusOnce(); } catch {} }, 0);
        if (readyNotifyThrottled('zalo') || global._suppressBootPing) {
          if (global._suppressBootPing) console.log('[ready-notify] Zalo boot ping suppressed (silent auto-restart)');
          setTimeout(async () => {
            const alive = await isGatewayAlive(5000);
            if (alive) {
              markChannelConfirmed('zalo', global._suppressBootPing ? 'silent' : 'throttle');
              console.log('[ready-notify] Zalo confirmed after post-marker delay (' + (global._suppressBootPing ? 'silent' : 'throttle') + ')');
            } else {
              notifyState.zalo.lastError = 'Gateway không phản hồi sau khi marker xuất hiện.';
              console.log('[ready-notify] Zalo throttle-confirm deferred — gateway not alive');
            }
            setTimeout(() => { try { broadcastChannelStatusOnce(); } catch {} }, 0);
          }, 10000);
        } else {
          sendTelegram(
            'Zalo đã sẵn sàng.\n\n' +
            'Bot đã kết nối Zalo và đang đọc tin nhắn. Anh/chị nhắn bot trên Zalo ngay bây giờ, sẽ có trả lời thật.\n\n' +
            '(Tin này gửi qua Telegram vì hệ thống chưa có Zalo ID của anh/chị)',
            { skipFilter: true }
          ).then(ok => {
            if (ok) {
              markChannelConfirmed('zalo', 'send');
              console.log('[ready-notify] Zalo notify sent:', ok);
            } else {
              notifyState.zalo.awaitingConfirmation = true;
              notifyState.zalo.lastError = 'Zalo đã kết nối nhưng chưa gửi được tin xác nhận sẵn sàng.';
              console.log('[ready-notify] Zalo notify failed');
            }
          }).catch(() => {
            notifyState.zalo.awaitingConfirmation = true;
            notifyState.zalo.lastError = 'Zalo đã kết nối nhưng gửi tin xác nhận bị lỗi.';
          }).finally(() => {
            setTimeout(() => { try { broadcastChannelStatusOnce(); } catch {} }, 0);
          });
        }
      }
    } catch (e) { /* never break on observer */ }
  };
  // Guard: if an external stopOpenClaw() killed the process mid-spawn, the
  // reference here is null — attaching .on() would throw and break the
  // spawn path permanently (observed: wizard-complete race with resume-zalo
  // → 240s timeout → null.stdout crash → gateway never recovers).
  if (!ctx.openclawProcess) {
    console.warn('[startOpenClaw] gateway process was killed externally during spawn — aborting attachment');
    return;
  }
  ctx.openclawProcess.stdout.on('data', scanForReadiness);
  ctx.openclawProcess.stderr.on('data', scanForReadiness);

  ctx.openclawProcess.on('exit', (code) => {
    ctx.botRunning = false;
    ctx.openclawProcess = null;
    console.log('Gateway exited with code', code, 'lastError:', lastError?.substring(0, 100));

    // Don't auto-restart if app is quitting
    const { app: _app } = require('electron');
    if (_app.isQuitting) return;
    if (_gatewayIntentionalStopDepth > 0 || ctx.gatewayRestartInFlight) {
      console.log('[restart-guard] gateway exit is intentional — caller owns restart');
      return;
    }

    const isRestart = lastError?.includes('restart') || lastError?.includes('SIGUSR1');
    const isBonjourConflict = lastError?.includes('bonjour') && lastError?.includes('non-announced');

    if (isBonjourConflict) {
      // openclaw's mDNS watchdog detected its own stale record from the previous
      // crash and exited. Restarting immediately causes a self-defeating 4-min loop.
      // Wait 5min for the mDNS TTL to expire so the new instance sees a clean slate.
      const BONJOUR_TTL_MS = 5 * 60 * 1000;
      global._bonjourCooldownUntil = Date.now() + BONJOUR_TTL_MS;
      console.log('[restart-guard] bonjour conflict exit — waiting 5min for mDNS TTL before restart');
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('bot-status', { running: false, error: 'Đang chờ mạng ổn định... tự động khởi động lại sau 5 phút.' });
      }
      setTimeout(() => {
        global._bonjourCooldownUntil = 0;
        if (ctx.botRunning || ctx.startOpenClawInFlight || ctx.gatewayRestartInFlight) return;
        startOpenClaw();
      }, BONJOUR_TTL_MS);
      return;
    }

    // Match only the specific openclaw pricing-bootstrap error observed in
    // LINH-BABY logs. Bare `TimeoutError` is too broad — openclaw emits it
    // from plugin init, openzca handshake, WS handshake too, and those are
    // NOT network-transient (restart won't help). The observed case logs
    // `pricing bootstrap failed: TimeoutError: ...` so this string alone
    // matches without false-positives.
    const isTransientNetwork =
      String(lastError || '').includes('pricing bootstrap failed');
    if (isTransientNetwork && !isBonjourConflict) {
      global._networkCooldownUntil = Date.now() + 60_000;
      console.log('[restart-guard] transient network exit — waiting 60s before restart');
    }

    if (isRestart) {
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('bot-status', { running: false, error: 'Đang khởi động lại... vui lòng đợi 30 giây.' });
      }
      // [restart-guard] Don't kick off a relaunch if another start is already
      // in flight or a hard-restart sequence (save-zalo-manager / resume-zalo)
      // already owns the restart. Otherwise two startOpenClaw calls race and
      // one fails with EADDRINUSE, leaving gateway dead.
      setTimeout(() => {
        if (ctx.botRunning || ctx.startOpenClawInFlight || ctx.gatewayRestartInFlight) {
          console.log('[restart-guard] exit-handler relaunch skipped — another start in progress');
          return;
        }
        startOpenClaw();
      }, 2000);
      return;
    }

    // Normal exit — check if another instance took over
    setTimeout(() => {
      isGatewayAlive().then(alive => {
        if (alive) {
          console.log('Gateway back alive — adopting');
          ctx.botRunning = true;
          if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) ctx.mainWindow.webContents.send('bot-status', { running: true });
          if (_createTray) _createTray();
          // Adopt path: mark markerSeen but delay confirm until gateway proven alive
          if (global._readyNotifyState) {
            for (const ch of ['telegram', 'zalo']) {
              const st = global._readyNotifyState[ch];
              if (st && !st.confirmedAt) {
                st.markerSeen = true;
                st.markerSeenAt = Date.now();
                st.awaitingConfirmation = true;
                st.lastError = '';
              }
            }
            setTimeout(() => { try { broadcastChannelStatusOnce(); } catch {} }, 500);
            setTimeout(async () => {
              const alive = await isGatewayAlive(5000);
              for (const ch of ['telegram', 'zalo']) {
                const st = global._readyNotifyState[ch];
                if (st && !st.confirmedAt) {
                  if (alive) {
                    st.confirmedAt = Date.now();
                    st.confirmedBy = 'adopt';
                    st.awaitingConfirmation = false;
                    st.lastError = '';
                  } else {
                    st.lastError = 'Gateway adopted nhưng không phản hồi.';
                  }
                }
              }
              try { broadcastChannelStatusOnce(); } catch {};
            }, 10000);
          }
          return;
        }
        const errMsg = code !== 0 ? `Mã lỗi: ${code}${lastError ? '\n' + lastError : ''}` : null;
        if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
          ctx.mainWindow.webContents.send('bot-status', { running: false, error: errMsg });
        }
        if (_createTray) _createTray();
      });
    }, 3000);
  });
}

// [restart-guard] stopOpenClaw is now async and waits for the gateway process
// to ACTUALLY exit before resolving. Without this, a caller that does
// `await stopOpenClaw(); await new Promise(r => setTimeout(r, 2000)); await startOpenClaw();`
// could race: the old process still holds port 18789 → new gateway fails to
// bind → we're back to the restart-loop situation. On Windows especially,
// mDNS/port cleanup after taskkill takes 1-3s.
//
// Resolution order:
//   1. Send SIGINT (Unix) or fire taskkill /f /t (Windows) — does not block.
//   2. Race the process' 'exit' event against a 5000ms deadline.
//   3. If deadline hit on Windows, fire taskkill again (belt-and-suspenders).
//   4. Poll isGatewayAlive(500) up to 10×500ms until it returns false so the
//      port is actually free before we resolve.
async function stopOpenClaw() {
  ctx.botRunning = false;
  // Clear marker cache so dots don't stay green from stale markers
  if (global._readyNotifyState) {
    for (const ch of ['telegram', 'zalo']) {
      const st = global._readyNotifyState[ch];
      if (st) { st.markerSeenAt = 0; st.confirmedAt = 0; st.markerSeen = false; }
    }
  }
  const proc = ctx.openclawProcess;
  ctx.openclawProcess = null;
  const startedAt = Date.now();
  _gatewayIntentionalStopDepth++;
  try {
  if (proc) {
    try {
      if (process.platform === 'win32') {
        try { spawn('taskkill', ['/pid', proc.pid.toString(), '/f', '/t'], { stdio: 'ignore' }); } catch {}
      } else {
        try { proc.kill('SIGINT'); } catch {}
      }
    } catch {}
    // Await actual exit — or give up after 5s and force-kill again.
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; resolve(); };
      try { proc.once('exit', finish); } catch { return finish(); }
      setTimeout(() => {
        if (done) return;
        if (process.platform === 'win32') {
          try { spawn('taskkill', ['/pid', proc.pid.toString(), '/f', '/t'], { stdio: 'ignore' }); } catch {}
        } else {
          try { proc.kill('SIGKILL'); } catch {}
        }
        // Wait one more tick, then resolve regardless.
        setTimeout(finish, 500);
      }, 5000);
    });
  }
  // Kill adopted/orphan gateway on the port + any lingering openclaw/openzca processes
  try { killPort(18789); } catch {}
  try { killAllOpenClawProcesses(); } catch {}
  // Poll the port to confirm it's actually free. Max 10 × 500ms = 5s.
  for (let i = 0; i < 10; i++) {
    const alive = await isGatewayAlive(500);
    if (!alive) break;
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`[stopOpenClaw] exited in ${Date.now() - startedAt}ms`);
  } finally {
    _gatewayIntentionalStopDepth = Math.max(0, _gatewayIntentionalStopDepth - 1);
  }
}

// ============================================
//  FAST WATCHDOG
// ============================================

function _fwCanRestart() {
  const now = Date.now();
  _fwRestartTimestamps = _fwRestartTimestamps.filter(t => now - t < 3600000);
  return _fwRestartTimestamps.length < FW_MAX_RESTARTS_PER_HOUR;
}

function startFastWatchdog() {
  if (_fastWatchdogInterval) clearInterval(_fastWatchdogInterval);
  if (_fastWatchdogBootTimeout) clearTimeout(_fastWatchdogBootTimeout);
  // Delay first tick 30s to let boot complete (C8: store timeout for cleanup)
  _fastWatchdogBootTimeout = setTimeout(() => {
    _fastWatchdogBootTimeout = null;
    _fastWatchdogInterval = setInterval(fastWatchdogTick, FW_INTERVAL_MS);
  }, 30000);
}

async function fastWatchdogTick() {
  if (ctx.appIsQuitting || !ctx.botRunning) return;
  if (ctx.startOpenClawInFlight || ctx.gatewayRestartInFlight) return;
  if (_fwTickInFlight) return;
  _fwTickInFlight = true;

  try {
    // Prune restart timestamps every tick (prevents unbounded growth when system is healthy)
    if (_fwRestartTimestamps.length > 10) {
      const now = Date.now();
      _fwRestartTimestamps = _fwRestartTimestamps.filter(t => now - t < 3600000);
    }

    // --- 9Router watchdog ---
    _fwRouterProbeCount++;
    const routerProc = getRouterProcess();
    if (!routerProc) {
      const routerAlive = await new Promise(r => {
        const req = require('http').get('http://127.0.0.1:20128/v1/models', { timeout: 3000 }, (res) => {
          res.resume(); r(res.statusCode === 200);
        });
        req.on('error', () => r(false));
        req.on('timeout', () => { req.destroy(); r(false); });
      });
      if (!routerAlive && _fwCanRestart()) {
        console.log('[fast-watchdog] 9Router dead — restarting');
        _fwRestartTimestamps.push(Date.now());
        try { start9Router(); } catch (e) { console.error('[fast-watchdog] 9Router restart error:', e.message); }
      }
    } else if (_fwRouterProbeCount % 5 === 0) {
      // Every 5th tick (~100s): probe /v1/models even when process alive.
      // Catches zombie state (process alive, models OK, completions 500).
      const routerResponds = await new Promise(r => {
        const req = require('http').get('http://127.0.0.1:20128/v1/models', { timeout: 5000 }, (res) => {
          let buf = '';
          res.on('data', c => buf += c);
          res.on('end', () => {
            if (res.statusCode !== 200) { r(false); return; }
            try {
              const parsed = JSON.parse(buf);
              r(Array.isArray(parsed?.data) && parsed.data.length > 0);
            } catch { r(false); }
          });
        });
        req.on('error', () => r(false));
        req.on('timeout', () => { req.destroy(); r(false); });
      });
      if (!routerResponds) {
        _fwRouterHealthFails++;
        if (_fwRouterHealthFails >= 3 && _fwCanRestart()) {
          console.warn('[fast-watchdog] 9Router alive but unhealthy (' + _fwRouterHealthFails + ' probe fails) — restarting');
          _fwRouterHealthFails = 0;
          _fwRestartTimestamps.push(Date.now());
          try { stop9Router(); await new Promise(r => setTimeout(r, 1000)); start9Router(); } catch (e) { console.error('[fast-watchdog] 9Router restart error:', e.message); }
        }
      } else {
        _fwRouterHealthFails = 0;
      }
    }

    // --- Gateway watchdog ---
    // Timeout 30s — gateway busy with AI completion can take 5-8s to respond.
    // Skip if gateway started <360s ago (slow SSDs + Defender + cloud model
    // cold start can push boot to 5+ minutes on customer machines).
    // Boot grace 360s — LINH-BABY observed 5:21 from launch to fully usable
    // (gateway "ready" at 70s is misleading; channels start 3:30+ later when
    // openrouter.ai fetch stuck on slow DNS/TCP — see ensureOpenclawPricingFix).
    // Even with pricing-fix, leaving 6min grace for worst-case slow boots.
    if (global._gatewayStartedAt && (Date.now() - global._gatewayStartedAt) < 360000) {
      // Gateway still booting — skip watchdog this tick
      _fwGatewayFailCount = 0;
      return;
    }
    const gwAlive = await isGatewayAlive(30000);
    if (!gwAlive) {
      _fwGatewayFailCount++;
      if (_fwGatewayFailCount === 1) {
        // First fail — recheck after 3s
        await new Promise(r => setTimeout(r, FW_RECHECK_MS));
        const gwAlive2 = await isGatewayAlive(30000);
        if (gwAlive2) {
          _fwGatewayFailCount = 0;
          return;
        }
      }
      // 5 consecutive fails — restart (was 3, but cloud model cold start
      // can hold gateway 30-60s, causing multiple probes to timeout in a
      // row without being dead).
      if (_fwGatewayFailCount >= 5 && _fwCanRestart() && !(global._bonjourCooldownUntil > Date.now()) && !(global._networkCooldownUntil > Date.now())) {
        console.log('[fast-watchdog] Gateway dead (' + _fwGatewayFailCount + ' fails) — restarting');
        _fwGatewayFailCount = 0;
        _fwRestartTimestamps.push(Date.now());
        ctx.gatewayRestartInFlight = true;
        try {
          await stopOpenClaw();
          await startOpenClaw({ silent: true });
        } catch (e) {
          console.error('[fast-watchdog] gateway restart error:', e.message);
        } finally {
          ctx.gatewayRestartInFlight = false;
        }
      }
    } else {
      _fwGatewayFailCount = 0;
      // --- Zalo listener sub-check: LOG ONLY, never restart gateway ---
      // Zalo listener is a subprocess managed by the gateway's modoro-zalo plugin.
      // If it crashes or session expires, the plugin handles reconnect internally.
      // NEVER restart the entire gateway for a Zalo issue — that kills Telegram
      // and creates the "restart cascade" loop that made connection feel broken.
      try {
        const _fwZaloEnabled = (() => { try {
          const _cfg = JSON.parse(fs.readFileSync(path.join(ctx.HOME, '.openclaw', 'openclaw.json'), 'utf-8'));
          return _cfg?.plugins?.entries?.['modoro-zalo']?.enabled === true || _cfg?.channels?.['modoro-zalo']?.enabled === true;
        } catch { return false; } })();
        if (_fwZaloEnabled) {
          const zlPid = findOpenzcaListenerPid();
          if (!zlPid) {
            _fwZaloMissCount++;
            if (_fwZaloMissCount === 3) {
              // Track timestamp so heartbeat watchdog skips duplicate alert (dedup fix).
              global._zaloListenerAlertSentAt = Date.now();
              console.warn('[fast-watchdog] Zalo listener not running (3 checks) — NOT restarting gateway. Zalo may need QR re-login.');
              // Alert CEO once, don't spam
              sendCeoAlert('Zalo listener không chạy. Nếu Zalo không nhận tin, vào tab Zalo bấm "Đổi tài khoản" để quét QR lại.').catch(() => {});
            }
          } else {
            _fwZaloMissCount = 0;
          }
        } else {
          _fwZaloMissCount = 0;
        }
      } catch {} // findOpenzcaListenerPid can throw on execSync timeout
    }

    // Debug-Agent-B R1/R2: Knowledge HTTP server watchdog. Inbound.ts patch
    // depends on port 20129 being up; if it dies mid-session (EADDRINUSE
    // from a 2nd instance, uncaught error), RAG degrades silently and the
    // gateway's inbound breaker keeps tripping. Re-arm the server on 2
    // consecutive fails. Skip when listen-side flag marks it unset (boot).
    try {
      if (_knowledgeCallbacks.getKnowledgeHttpServer() === null) {
        _fwKnowledgeHttpDead = (_fwKnowledgeHttpDead || 0) + 1;
        if (_fwKnowledgeHttpDead >= 2) {
          console.warn('[fast-watchdog] knowledge HTTP :20129 down — re-arming');
          try { _knowledgeCallbacks.startKnowledgeSearchServer(); } catch (e) { console.warn('[fast-watchdog] re-arm failed:', e.message); }
          _fwKnowledgeHttpDead = 0;
        }
      } else {
        _fwKnowledgeHttpDead = 0;
      }
    } catch {}
  } catch (e) {
    console.warn('[fast-watchdog] tick error:', e.message);
  } finally {
    _fwTickInFlight = false;
  }
}

// ============================================
//  TRIGGER GATEWAY MESSAGE
// ============================================

async function triggerGatewayMessage(prompt) {
  try {
    const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const gatewayToken = config?.gateway?.auth?.token;
    if (!gatewayToken) return null;
    const http = require('http');
    return new Promise((resolve) => {
      const payload = JSON.stringify({ message: prompt, channel: 'telegram' });
      const req = http.request({
        hostname: '127.0.0.1', port: 18789, path: '/api/v1/chat',
        method: 'POST',
        timeout: 5000,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${gatewayToken}` },
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          // Only consider success if HTTP 200 AND body exists (real reply, not 404 page)
          if (res.statusCode === 200 && d) resolve(d);
          else resolve(null);
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(payload);
      req.end();
    });
  } catch { return null; }
}

// ============================================
//  CLEANUP
// ============================================

function cleanupGatewayTimers() {
  if (_fastWatchdogInterval) { clearInterval(_fastWatchdogInterval); _fastWatchdogInterval = null; }
  if (_fastWatchdogBootTimeout) { clearTimeout(_fastWatchdogBootTimeout); _fastWatchdogBootTimeout = null; }
  if (global._telegramCmdInterval) { clearInterval(global._telegramCmdInterval); global._telegramCmdInterval = null; }
}

// ============================================
//  EXPORTS
// ============================================

module.exports = {
  killPort,
  killAllOpenClawProcesses,
  isGatewayAlive,
  waitForIpcDrain,
  rejectIfBooting,
  startOpenClaw,
  _startOpenClawImpl,
  stopOpenClaw,
  ensureVisionFix,
  ensureVisionCatalogFix,
  ensureVisionSerializationFix,
  ensureWebFetchLocalhostFix,
  ensureOpenzcaFriendEventFix,
  ensureOpenclawPricingFix,
  ensureOpenclawPrewarmFix,
  ensureOpenclawUpdateUiDisabled,
  startFastWatchdog,
  fastWatchdogTick,
  triggerGatewayMessage,
  cleanupGatewayTimers,
  setCreateTray,
  setKnowledgeCallbacks,
};
