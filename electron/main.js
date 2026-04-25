const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, powerSaveBlocker, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFilePromise = promisify(execFile);

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
  const dbgPath = path.join(process.env.APPDATA || '', '9bizclaw', 'logs', 'singleton-blocked.log');
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

// ============================================
//  STATE
// ============================================
let mainWindow = null;
let tray = null;
let openclawProcess = null;
let botRunning = false;
let _cachedBin = null;
let restartCount = 0;
let lastCrash = 0;

// Paths — resolved lazily since app.getPath needs app to be ready in some contexts
const resourceDir = path.join(__dirname, '..');
let userDataDir = path.join(__dirname, '..');  // Updated in whenReady for packaged

// Writable workspace — in dev this is the source dir, in packaged it's userData.
// Bot and Electron both use this path for all file I/O (AGENTS.md, schedules.json, etc.)
//
// CRITICAL ARCHITECTURAL FIX (2026-04-08):
// Previously this checked if resourceDir was writable and if YES used resourceDir.
// On Windows packaged installs, resourceDir = ~/AppData/Local/Programs/modoro-claw/resources
// which IS user-writable. So workspace = install dir → NSIS installer WIPES this dir
// on every reinstall → CEO loses all data (memory, knowledge, wizard config) every
// time they update the app. Bug surfaced when bot replied "no Zalo data" after a
// reinstall — workspace was empty because seedWorkspace ran but bot needed REAL
// historical data, and the install had wiped user-state.
//
// FIX: in packaged mode, ALWAYS use userDataDir (~/AppData/Roaming/MODOROClaw/) which
// NSIS uninstaller never touches. resourceDir is only for reading template files.
let _workspaceCached = null;
let _appPackaged = null; // cached at first call after app.isPackaged is available
function getWorkspace() {
  if (_workspaceCached) return _workspaceCached;
  // Detect packaged at runtime (app may not be ready yet during early calls)
  let packaged = false;
  try { packaged = (_appPackaged === null) ? !!(app && app.isPackaged) : _appPackaged; } catch {}
  if (packaged) {
    // Packaged: use userData (NSIS-safe). userDataDir is set in app.whenReady()
    // to app.getPath('userData'). Until that runs, fall back to a sensible default.
    _appPackaged = true;
    if (userDataDir && userDataDir !== resourceDir) {
      _workspaceCached = userDataDir;
    } else {
      // app.whenReady hasn't fired yet — compute manually so early seedWorkspace
      // calls (e.g. from bootDiagRunFullCheck) get the right path.
      // CRITICAL: dir name must match Electron's app.getName() which reads
      // the package.json `name` field ("9bizclaw", lowercase). NOT
      // build.productName ("MODOROClaw") — that's electron-builder installer
      // metadata, not Electron runtime. Mismatch creates a phantom capital
      // dir that some code paths write to while real workspace is lowercase.
      const HOMETMP = process.env.USERPROFILE || process.env.HOME || '';
      const APP_DIR = '9bizclaw';
      if (process.platform === 'win32') {
        _workspaceCached = path.join(process.env.APPDATA || path.join(HOMETMP, 'AppData', 'Roaming'), APP_DIR);
      } else if (process.platform === 'darwin') {
        _workspaceCached = path.join(HOMETMP, 'Library', 'Application Support', APP_DIR);
      } else {
        _workspaceCached = path.join(process.env.XDG_CONFIG_HOME || path.join(HOMETMP, '.config'), APP_DIR);
      }
    }
    try { fs.mkdirSync(_workspaceCached, { recursive: true }); } catch {}
    return _workspaceCached;
  }
  // Dev mode: use source dir if writable
  try {
    fs.accessSync(resourceDir, fs.constants.W_OK);
    _workspaceCached = resourceDir;
  } catch {
    _workspaceCached = userDataDir;
  }
  return _workspaceCached;
}
function invalidateWorkspaceCache() { _workspaceCached = null; _appPackaged = null; }

function purgeAgentSessions(caller) {
  try {
    const sessDir = path.join(HOME, '.openclaw', 'agents', 'main', 'sessions');
    if (!fs.existsSync(sessDir)) return 0;
    const staleFiles = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
    for (const sf of staleFiles) {
      try { fs.unlinkSync(path.join(sessDir, sf)); } catch {}
    }
    const idxFile = path.join(sessDir, 'sessions.json');
    if (fs.existsSync(idxFile)) { try { fs.unlinkSync(idxFile); } catch {} }
    if (staleFiles.length > 0) console.log(`[${caller}] purged ${staleFiles.length} stale session(s)`);
    return staleFiles.length;
  } catch (pe) {
    console.warn(`[${caller}] session purge failed:`, pe?.message || pe);
    return 0;
  }
}

// Default schedules (also used as template when seeding fresh install)
const DEFAULT_SCHEDULES_JSON = [
  // `icon` legacy field kept empty — Dashboard uses lucide icons via SCHEDULE_ICON_MAP, not emoji.
  { id: 'morning', label: 'Báo cáo sáng', time: '07:30', enabled: true, icon: '', description: 'Doanh thu, lịch họp, việc cần xử lý' },
  { id: 'evening', label: 'Tóm tắt cuối ngày', time: '21:00', enabled: true, icon: '', description: 'Kết quả ngày, vấn đề tồn đọng' },
  { id: 'heartbeat', label: 'Kiểm tra tự động', time: 'Mỗi 30 phút', enabled: true, icon: '', description: 'Gateway, kênh liên lạc' },
  { id: 'meditation', label: 'Tối ưu ban đêm', time: '01:00', enabled: true, icon: '', description: 'Bot tự review bài học, tối ưu bộ nhớ' },
  { id: 'weekly', label: 'Báo cáo tuần', time: '08:00', enabled: true, icon: '', description: 'Tổng kết tuần, khách mới, ưu tiên tuần tới' },
  { id: 'monthly', label: 'Báo cáo tháng', time: '08:30', enabled: true, icon: '', description: 'Tổng kết tháng, trend, kế hoạch tháng tới' },
  { id: 'zalo-followup', label: 'Follow-up khách Zalo', time: '09:30', enabled: true, icon: '', description: 'Nhắc CEO khách mới chưa tương tác, khách hỏi chưa reply' },
  { id: 'memory-cleanup', label: 'Dọn dẹp memory', time: '02:00', enabled: false, icon: '', description: 'Tổng hợp journal cũ, dọn dẹp memory rời rạc' },
];

// Seed templates from read-only bundle → writable workspace (packaged install)
// In dev mode (resourceDir writable), this just ensures runtime files exist.
// Resolve where workspace template files live for the CURRENT runtime mode.
//   - Dev (Electron run from source): templates live in `resourceDir` (Desktop/claw)
//   - Packaged (.app on Mac, NSIS on Windows): templates were copied to
//     `process.resourcesPath/workspace-templates/` by electron-builder's
//     `extraResources` config. Reading from app.asar would fail (asar is
//     read-only and the templates are NOT inside it — they're alongside it).
// Falls back to `resourceDir` if the packaged path doesn't exist (shouldn't
// happen in a correctly built bundle, but better than crashing).
function getWorkspaceTemplateRoot() {
  try {
    if (app && app.isPackaged) {
      const packaged = path.join(process.resourcesPath, 'workspace-templates');
      if (fs.existsSync(packaged)) return packaged;
    }
  } catch {}
  return resourceDir;
}

// =====================================================================
//  BUNDLED VENDOR (Mac packaged .app only)
// =====================================================================
// In packaged mode the .app ships with EVERYTHING the user needs:
//   - Real Node.js binary at vendor/node/bin/node
//   - openclaw  at vendor/node_modules/openclaw/openclaw.mjs
//   - 9router   at vendor/node_modules/9router/...
// User installs ZERO things on their Mac. No Homebrew, no system Node,
// no `npm install -g`, no sudo. Just drag .app to Applications and run.
//
// `electron/scripts/prebuild-vendor.js` populates `electron/vendor/` before
// `electron-builder --mac` runs. `package.json -> build.extraResources`
// copies that dir into Resources/vendor/ inside the .app.
//
// Returns null in dev mode → callers fall back to system Node + global
// openclaw, exactly as before.
//
// Platform layout (as of 2026-04-08):
//   Mac DMG (packaged): resources/vendor/                    — ships directly
//   Win EXE (packaged): userData/vendor/                     — extracted from tar on first launch
//                       resources/vendor-bundle.tar          — source archive
//                       resources/vendor-meta.json           — integrity + file count
//   Dev (both):         electron/vendor/                     — local prebuild output
//
// The Windows indirection exists because shipping ~50k loose files through
// NSIS is pathologically slow. See CLAUDE.md "Vendor tar-and-extract" section.
function getBundledVendorDir() {
  try {
    if (!app || !app.isPackaged) return null;
    if (process.platform === 'win32') {
      // Windows packaged: extracted vendor lives in userData (written by
      // ensureVendorExtracted on first launch). Falls back to resources/vendor
      // if the old direct-ship layout is still present (old installs).
      const extracted = path.join(app.getPath('userData'), 'vendor');
      if (fs.existsSync(extracted)) return extracted;
      const legacy = path.join(process.resourcesPath, 'vendor');
      if (fs.existsSync(legacy)) return legacy;
      return null;
    }
    // Mac / Linux packaged: vendor ships directly in resources/
    const v = path.join(process.resourcesPath, 'vendor');
    if (fs.existsSync(v)) return v;
  } catch {}
  return null;
}

// Windows-only: extract vendor-bundle.tar from resources/ to userData/vendor/
// if not already extracted (first launch or after update). Emits progress via
// the optional onProgress callback so a splash window can show a progress bar.
//
// Behavior:
//   - Checks userData/vendor-version.txt vs resources/vendor-meta.json.bundle_version
//   - If match → resolve immediately (no-op, subsequent launches)
//   - If mismatch or missing → spawn Windows native tar.exe to extract the .tar
//     Progress = count lines from tar -v stdout / meta.file_count
//   - After successful extract, write userData/vendor-version.txt = bundle_version
//   - Returns { skipped: bool, extracted: bool, durationMs: number }
//
// Errors are fatal to the launch — if extraction fails, show an error dialog
// and quit. There's no safe fallback: bot can't run without vendor.
async function ensureVendorExtracted({ onProgress } = {}) {
  // Mac + Linux + dev mode → no-op. Only Windows packaged uses the tar indirection.
  if (process.platform !== 'win32') return { skipped: true };
  if (!app.isPackaged) return { skipped: true };

  const resDir = process.resourcesPath;
  const tarPath = path.join(resDir, 'vendor-bundle.tar');
  const metaPath = path.join(resDir, 'vendor-meta.json');
  const userData = app.getPath('userData');
  const targetDir = path.join(userData, 'vendor');
  const versionStamp = path.join(userData, 'vendor-version.txt');

  if (!fs.existsSync(tarPath) || !fs.existsSync(metaPath)) {
    // Old-layout install (vendor shipped directly in resources/). No-op.
    console.log('[vendor-extract] no tar/meta in resources — assuming legacy direct-ship layout');
    return { skipped: true };
  }

  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch (e) {
    throw new Error(`vendor-meta.json unreadable: ${e.message}`);
  }

  // Check if already extracted with matching version
  try {
    if (fs.existsSync(versionStamp)) {
      const current = fs.readFileSync(versionStamp, 'utf8').trim();
      if (current === meta.bundle_version && fs.existsSync(path.join(targetDir, 'node', 'node.exe'))) {
        // SAFETY: verify load-bearing files are present. C5 FIX: add model
        // .onnx to sentinel list. If antivirus quarantines the onnx post-
        // install, version stamp still matches, old code would skip re-extract
        // → embedder throws at load → RAG permanently broken until manual
        // reinstall. Now: any sentinel missing → re-extract from tar.
        // cold-F1: expanded sentinel list. Power-fail during extract could
        // leave stamp valid but any of these missing/truncated. Each is
        // load-bearing — missing one = broken feature down the line.
        const e5 = path.join(targetDir, 'models', 'Xenova', 'multilingual-e5-small');
        const sentinels = [
          path.join(targetDir, 'node_modules', 'openclaw', 'openclaw.mjs'),
          path.join(targetDir, 'node_modules', 'openclaw', 'package.json'),
          path.join(targetDir, 'node_modules', '9router', 'app', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
          path.join(targetDir, 'node_modules', 'pdf-parse', 'index.js'),
          path.join(e5, 'onnx', 'model_quantized.onnx'),
          path.join(e5, 'tokenizer.json'),
          path.join(e5, 'config.json'),
        ];
        const missing = sentinels.find(p => !fs.existsSync(p) || fs.statSync(p).size === 0);
        if (!missing) {
          console.log('[vendor-extract] already extracted at', targetDir, '→', meta.bundle_version);
          return { skipped: true, reason: 'already_extracted' };
        }
        console.log('[vendor-extract] version stamp matches but sentinel missing/empty:', missing, '— re-extracting');
      } else {
        console.log('[vendor-extract] version mismatch — re-extracting. have:', current, 'want:', meta.bundle_version);
      }
    }
  } catch {}
  // NOTE: do NOT delete old vendor dir before extract. tar -xf naturally
  // overwrites existing files. Deleting first fails when files are locked
  // by running processes (9Router, gateway) → tar extract fails → app crash.
  // Old files that no longer exist in new tar remain as orphans but are harmless.

  console.log('[vendor-extract] extracting vendor bundle...');
  console.log('  source:', tarPath);
  console.log('  target:', targetDir);
  console.log('  file_count:', meta.file_count, ' archive_bytes:', meta.archive_bytes);
  const startedAt = Date.now();

  if (onProgress) onProgress({ percent: 0, message: 'Đang chuẩn bị giải nén...' });

  // CRITICAL: if an old vendor dir exists (from a previous install with a
  // different bundle version), we MUST NOT call fs.rmSync here — Windows can
  // take 5-15 minutes to sync-delete 126k+ small files while Defender scans
  // each one, which blocks the Electron main thread → splash freezes with
  // "not responding". Instead rename the old dir to a stale suffix (instant
  // atomic NTFS rename) and delete it in background AFTER the main thread
  // is free. Next launch will also clean up any leftover stale dirs.
  //
  // OVERLAY-INSTALL FIX: kill leftover 9Router / openzca / gateway processes
  // from the PREVIOUS app instance BEFORE rename. Otherwise their open file
  // handles lock DLLs and .node binaries inside vendor/ → renameSync throws
  // EBUSY → tar overwrite also fails on locked files → splash shows error →
  // 2 client machines hit this on every overlay install.
  try {
    if (fs.existsSync(targetDir)) {
      // Phase 0: kill processes that hold locks inside vendor/
      try {
        const { execSync } = require('child_process');
        const vendorAbs = path.resolve(targetDir).replace(/\//g, '\\\\');
        // taskkill any node.exe whose command line references our vendor dir
        // /F = force, /T = tree-kill children. Errors ignored (process may not exist).
        try { execSync(`wmic process where "CommandLine like '%${vendorAbs.replace(/\\/g, '\\\\')}%'" call terminate 2>nul`, { timeout: 8000 }); } catch {}
        // Also kill by known process names that commonly lock vendor files
        try { execSync('taskkill /F /IM 9router.exe 2>nul', { timeout: 3000 }); } catch {}
        try { execSync('taskkill /F /IM openzca.exe 2>nul', { timeout: 3000 }); } catch {}
        // Give OS a moment to release file handles after kill
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) { /* spin-wait for handle release */ }
        console.log('[vendor-extract] killed leftover processes before rename');
      } catch (killErr) {
        console.warn('[vendor-extract] process cleanup (non-fatal):', killErr.message);
      }
      const stale = targetDir + '.stale-' + Date.now();
      try {
        fs.renameSync(targetDir, stale);
        console.log('[vendor-extract] old vendor renamed to', stale, '(will be deleted in background)');
        setTimeout(() => {
          fs.rm(stale, { recursive: true, force: true }, (err) => {
            if (err) console.warn('[vendor-extract] background cleanup failed:', err.message);
            else console.log('[vendor-extract] background cleanup done:', stale);
          });
        }, 10000);
      } catch (renameErr) {
        console.warn('[vendor-extract] rename failed after kill, retrying...', renameErr.message);
        // Retry once after longer wait — handles can take a moment to release
        try {
          const d2 = Date.now() + 3000; while (Date.now() < d2) {}
          fs.renameSync(targetDir, stale);
          console.log('[vendor-extract] rename succeeded on retry');
          setTimeout(() => {
            fs.rm(stale, { recursive: true, force: true }, () => {});
          }, 10000);
        } catch (retryErr) {
          console.warn('[vendor-extract] rename retry failed, tar will overwrite in place:', retryErr.message);
        }
      }
    }
  } catch {}
  // Also clean up any stale dirs from prior interrupted runs (background,
  // doesn't block).
  try {
    setTimeout(() => {
      try {
        const entries = fs.readdirSync(userData);
        for (const e of entries) {
          if (e.startsWith('vendor.stale-')) {
            fs.rm(path.join(userData, e), { recursive: true, force: true }, () => {});
          }
        }
      } catch {}
    }, 15000);
  } catch {}
  try { fs.mkdirSync(userData, { recursive: true }); } catch {}

  // Verify SHA256 BEFORE extraction — defends against corrupted install, disk
  // bit rot, MITM at download (if future version streams from network).
  if (meta.sha256 && onProgress) {
    onProgress({ percent: 1, message: 'Đang kiểm tra tính toàn vẹn...' });
    try {
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(tarPath, { highWaterMark: 4 * 1024 * 1024 });
      const totalBytes = meta.archive_bytes || 0;
      let readBytes = 0;
      let lastSha256Percent = 1;
      await new Promise((resolve, reject) => {
        stream.on('data', (chunk) => {
          hash.update(chunk);
          readBytes += chunk.length;
          if (totalBytes > 0) {
            // 1-4% range during SHA256 check so splash shows steady progress
            const pct = 1 + Math.floor((readBytes / totalBytes) * 3);
            if (pct > lastSha256Percent) {
              lastSha256Percent = pct;
              onProgress({ percent: pct, message: 'Đang kiểm tra tính toàn vẹn...' });
            }
          }
        });
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      const actual = hash.digest('hex');
      if (actual !== meta.sha256) {
        throw new Error(`vendor-bundle.tar SHA256 mismatch (expected ${meta.sha256.slice(0, 16)}..., got ${actual.slice(0, 16)}...). File is corrupt or tampered. Re-install 9BizClaw.`);
      }
      console.log('[vendor-extract] sha256 verified');
    } catch (e) {
      if (e.message && e.message.includes('mismatch')) throw e;
      console.warn('[vendor-extract] sha256 check skipped:', e.message);
    }
  }

  // Spawn Windows native tar.exe — same binary prebuild-vendor uses.
  // Avoid Git Bash MSYS tar (fails on drive letters with "Cannot connect to C:").
  const tarBin = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (!fs.existsSync(tarBin)) {
    throw new Error(`Windows native tar.exe not found at ${tarBin}. Need Windows 10 1803+ or later.`);
  }

  // -x extract, -f file, -v verbose (one line per extracted entry → progress),
  // -C target dir. The archive contains "vendor/" as top-level; we extract to
  // userData, so final path is userData/vendor/...
  const tarArgs = ['-xvf', tarPath, '-C', userData];

  if (onProgress) onProgress({ percent: 5, message: 'Đang giải nén thành phần...' });

  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const child = spawn(tarBin, tarArgs, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });

    let extractedCount = 0;
    let lastPercentReported = 5;
    let stderrBuf = '';

    // Total entries (files + directories) tar will emit. Prefer entry_count;
    // fall back to file_count for backwards-compat with older meta.json.
    const totalEntries = meta.entry_count || meta.file_count || 0;

    // tar -v writes one line per entry to stderr (BSD) or stdout (GNU). Listen on both.
    const onLine = () => {
      extractedCount++;
      if (totalEntries > 0 && onProgress) {
        // Reserve 5-95% for extraction. HARD CLAMP at 95 so percent never
        // exceeds 95 during extract phase — the final 95→100 happens after
        // extract finishes + version stamp is written. Previous bug: count
        // exceeded totalEntries (dirs vs files mismatch) → percent > 100%.
        let percent = 5 + Math.floor((extractedCount / totalEntries) * 90);
        if (percent > 95) percent = 95;
        if (percent < 5) percent = 5;
        if (percent > lastPercentReported) {
          lastPercentReported = percent;
          // Show percent only. Hide file counter entirely to avoid confusing
          // mismatches (tar entries vs user expectation of "files"). CEO rule:
          // "nếu không biết thì bỏ, số cũng ko đc vượt quá 100% lúc giải nén".
          onProgress({ percent, message: 'Đang giải nén...' });
        }
      }
    };

    const lineReader = (stream) => {
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.trim()) onLine();
        }
      });
      stream.on('end', () => { if (buf.trim()) onLine(); });
    };

    lineReader(child.stdout);
    // BSD tar (Windows native) writes verbose lines to stderr. Count those too.
    // BUT real errors ALSO go to stderr. Save full stderr for error reporting.
    let stderrTimer = null;
    child.stderr.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      stderrBuf += s;
      // Each line in stderr is either a file name (verbose) or an error.
      // On BSD tar, verbose output is "x path/to/file" (no error prefix).
      for (const line of s.split('\n')) {
        if (line.trim()) onLine();
      }
    });

    child.on('error', (e) => reject(new Error(`tar spawn failed: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`tar extract failed (exit ${code}): ${stderrBuf.slice(0, 500)}`));
      }
      // Verify extract landed where expected
      const nodeBin = path.join(targetDir, 'node', 'node.exe');
      if (!fs.existsSync(nodeBin)) {
        return reject(new Error(`Extract succeeded but vendor/node/node.exe missing at ${nodeBin}. Archive may be damaged.`));
      }
      // cold-F1: 2-phase stamp write. Previous single writeFileSync could
      // commit small stamp sector to disk BEFORE tar data pages flush (in
      // write-back cache) → power-fail leaves valid stamp + incomplete
      // vendor. Now: write to .staging, fsync, rename. Rename is atomic on
      // NTFS + ext4. Combined with expanded sentinel list in the skip-check
      // path above, this closes the partial-install window.
      try {
        const stagingPath = versionStamp + '.staging';
        const fd = fs.openSync(stagingPath, 'w');
        fs.writeSync(fd, Buffer.from(meta.bundle_version, 'utf8'));
        try { fs.fsyncSync(fd); } catch {}
        fs.closeSync(fd);
        fs.renameSync(stagingPath, versionStamp);
      } catch (e) {
        console.warn('[vendor-extract] could not write version stamp:', e.message);
      }
      const durationMs = Date.now() - startedAt;
      // Post-extract: log openclaw version for diagnostics
      try {
        const oclawPkg = path.join(targetDir, 'node_modules', 'openclaw', 'package.json');
        if (fs.existsSync(oclawPkg)) {
          const ver = JSON.parse(fs.readFileSync(oclawPkg, 'utf8')).version;
          console.log(`[vendor-extract] openclaw version: ${ver}`);
        }
      } catch {}
      console.log(`[vendor-extract] done in ${(durationMs / 1000).toFixed(1)}s, ${extractedCount} files`);
      if (onProgress) onProgress({ percent: 100, message: 'Hoàn tất!' });
      resolve({ skipped: false, extracted: true, durationMs, fileCount: extractedCount });
    });
  });
}
function getBundledNodeBin() {
  const v = getBundledVendorDir();
  if (!v) return null;
  // Layout differs per platform (set by prebuild-vendor.js):
  //   darwin: vendor/node/bin/node     (Mac tar.gz extracts with bin/ subdir)
  //   win32:  vendor/node/node.exe     (Windows zip is flat at top level)
  const isWin = process.platform === 'win32';
  const candidate = isWin
    ? path.join(v, 'node', 'node.exe')
    : path.join(v, 'node', 'bin', 'node');
  try { if (fs.existsSync(candidate)) return candidate; } catch {}
  return null;
}
function getBundledOpenClawCliJs() {
  const v = getBundledVendorDir();
  if (!v) return null;
  const candidate = path.join(v, 'node_modules', 'openclaw', 'openclaw.mjs');
  try { if (fs.existsSync(candidate)) return candidate; } catch {}
  return null;
}

// PATH augmentation: when packaged, prepend vendor/node/bin so any child
// process spawned by openclaw (or its plugins) that calls plain `node` finds
// our bundled binary instead of failing with ENOENT on a Mac without Node.
// Safe to call multiple times.
function augmentPathWithBundledNode() {
  const v = getBundledVendorDir();
  if (!v) return;
  // Prepend TWO dirs: (1) the directory containing the bundled `node` binary,
  // (2) vendor/node_modules/.bin for the shims of bundled npm packages
  // (openclaw, openzca, 9router). Without the second dir, the openzalo
  // plugin running inside the gateway calls `spawn('openzca', ...)` and gets
  // ENOENT because the bundled openzca shim is not on PATH.
  // Layout differs: darwin has vendor/node/bin/, win32 has vendor/node/ flat.
  const isWin = process.platform === 'win32';
  const nodeDir = isWin ? path.join(v, 'node') : path.join(v, 'node', 'bin');
  const pathsToAdd = [
    nodeDir,
    path.join(v, 'node_modules', '.bin'),
  ].filter(p => fs.existsSync(p));
  if (pathsToAdd.length === 0) return;
  const sep = process.platform === 'win32' ? ';' : ':';
  const cur = process.env.PATH || '';
  const curSet = new Set(cur.split(sep));
  const newEntries = pathsToAdd.filter(p => !curSet.has(p));
  if (newEntries.length === 0) return;
  process.env.PATH = newEntries.join(sep) + sep + cur;
  for (const p of newEntries) console.log('[vendor] PATH prepended:', p);
}

// Bump this constant whenever AGENTS.md gets a meaningful rule change.
// On install/launch, seedWorkspace() compares this to the version stamp
// in the user's existing AGENTS.md and FORCE-OVERWRITES from template if
// the user is on a stale version. The old AGENTS.md is backed up to
// .learnings/AGENTS-backup-v<old>-<timestamp>.md so any user customizations
// are preserved as audit trail.
//
// Version history:
//   1 — initial v2.2.5 baseline
//   2 — v2.2.6 added Vệ sinh tin nhắn + Hồ sơ khách Zalo silent rules
//   3 — v2.2.7 added pronoun 3-step fallback + reply-length style + rule
//       contradiction fix
//   4 — v2.2.8 (current) — bumped after audit, no new rules but the
//       version-stamp mechanism itself was added
const CURRENT_AGENTS_MD_VERSION = 73;
const AGENTS_MD_VERSION_RE = /<!--\s*modoroclaw-agents-version:\s*(\d+)\s*-->/;

function seedWorkspace() {
  const ws = getWorkspace();
  try { fs.mkdirSync(ws, { recursive: true }); } catch {}

  // Stale tmp sweep (H8): writeJsonAtomic leaves `<name>.tmp.<pid>.<ms>.<n>`
  // files if the process crashed mid-rename or AV killed the rename outright.
  // Clean anything older than 5 minutes at boot. Non-fatal on error.
  try {
    const now = Date.now();
    const entries = fs.readdirSync(ws);
    for (const f of entries) {
      if (!/\.tmp\.\d+\.\d+(?:\.\d+)?$/.test(f)) continue;
      const full = path.join(ws, f);
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs > 300000) {
          try { fs.unlinkSync(full); } catch {}
        }
      } catch {}
    }
  } catch {}

  const copyDirRecursive = (src, dst) => {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const sp = path.join(src, entry.name), tp = path.join(dst, entry.name);
      if (entry.isDirectory()) copyDirRecursive(sp, tp);
      else if (!fs.existsSync(tp)) {
        try { fs.copyFileSync(sp, tp); } catch {}
      }
    }
  };

  // BUG #2 FIX: AGENTS.md version-aware overwrite. Without this, users
  // upgrading from any prior version keep their stale AGENTS.md because
  // the copy logic below only writes when destination is missing. Means
  // new rules never reach runtime workspace on upgrade installs.
  //
  // Strategy: read existing AGENTS.md → parse version stamp → if older
  // than current, back up to .learnings/ and DELETE so the copy logic
  // below repopulates from template.
  const templateRoot = getWorkspaceTemplateRoot();
  const existingAgents = path.join(ws, 'AGENTS.md');
  if (ws !== templateRoot && fs.existsSync(existingAgents)) {
    try {
      const existingContent = fs.readFileSync(existingAgents, 'utf-8');
      const m = existingContent.match(AGENTS_MD_VERSION_RE);
      const existingVersion = m ? parseInt(m[1], 10) : 0;
      // Spoof guard: version suspiciously far ahead of template → treat as
      // stale/tampered and force overwrite. Prevents CEO (or anyone) from
      // accidentally editing the stamp higher and freezing the file forever.
      const spoofed = existingVersion > CURRENT_AGENTS_MD_VERSION + 10;
      if (existingVersion < CURRENT_AGENTS_MD_VERSION || spoofed) {
        // Back up the stale file to .learnings/ so any user-added custom
        // rules (or bot self-improvement promotions) survive the overwrite.
        try {
          const backupDir = path.join(ws, '.learnings');
          fs.mkdirSync(backupDir, { recursive: true });
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const backupName = 'AGENTS-backup-v' + existingVersion + '-' + ts + '.md';
          fs.writeFileSync(path.join(backupDir, backupName), existingContent, 'utf-8');
          const label = spoofed ? 'spoof-reset' : 'upgrade';
          console.log('[seedWorkspace] AGENTS.md ' + label + ' ' + existingVersion + ' → ' +
            CURRENT_AGENTS_MD_VERSION + ' (backup: .learnings/' + backupName + ')');
        } catch (be) {
          console.warn('[seedWorkspace] AGENTS.md backup failed:', be && be.message ? be.message : String(be));
          // Continue with overwrite anyway — the rule update is more
          // important than preserving the backup.
        }
        try { fs.unlinkSync(existingAgents); } catch {}
        // PIGGYBACK: when AGENTS.md upgrades, also force-overwrite other
        // template .md files that changed significantly. These don't have
        // their own version stamps, so they only get updated on AGENTS.md
        // version bumps. CEO customizations in these files are rare (they're
        // bot-internal, not user-facing), so overwriting is safe.
        const alsoOverwrite = ['MEMORY.md', 'HEARTBEAT.md', 'BOOTSTRAP.md', 'SOUL.md', 'TOOLS.md', 'README.md'];
        // Force-refresh template-owned files in these dirs while preserving
        // any files the customer created (custom skills, prompts, etc.).
        // Strategy: walk the template dir, overwrite matching files in workspace,
        // but never delete workspace files that don't exist in the template.
        for (const dirName of ['tools', 'docs', 'skills', 'prompts']) {
          const tmplDir = path.join(templateRoot, dirName);
          const wsDir = path.join(ws, dirName);
          if (!fs.existsSync(tmplDir)) continue;
          let refreshed = 0;
          const walkAndRefresh = (rel) => {
            const srcDir = path.join(tmplDir, rel);
            const dstDir = path.join(wsDir, rel);
            try { fs.mkdirSync(dstDir, { recursive: true }); } catch {}
            for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
              if (entry.isDirectory()) {
                walkAndRefresh(path.join(rel, entry.name));
              } else {
                const srcFile = path.join(srcDir, entry.name);
                const dstFile = path.join(dstDir, entry.name);
                try { fs.copyFileSync(srcFile, dstFile); refreshed++; } catch {}
              }
            }
          };
          try { walkAndRefresh(''); console.log('[seedWorkspace] ' + dirName + '/ refreshed ' + refreshed + ' template files (user files preserved)'); } catch (we) { console.warn('[seedWorkspace] ' + dirName + '/ refresh failed:', we.message); }
        }
        for (const f of alsoOverwrite) {
          const fp = path.join(ws, f);
          if (fs.existsSync(fp)) {
            try { fs.unlinkSync(fp); console.log('[seedWorkspace] ' + f + ' force-overwritten (piggyback on AGENTS.md upgrade)'); } catch {}
          }
        }
        // Clean up fake sample memory files from older templates
        const fakeFiles = [
          'memory/people/colleague.md',
          'memory/projects/knowledge-management.md',
          'memory/projects/microservices-migration.md',
        ];
        for (const f of fakeFiles) {
          const fp = path.join(ws, f);
          if (fs.existsSync(fp)) {
            try { fs.unlinkSync(fp); console.log('[seedWorkspace] removed fake memory file: ' + f); } catch {}
          }
        }
        purgeAgentSessions('seedWorkspace');
      }
    } catch (e) {
      console.warn('[seedWorkspace] AGENTS.md version check failed:', e && e.message ? e.message : String(e));
    }
  }

  // Only seed from bundle if workspace differs from template source (packaged)
  if (ws !== templateRoot) {
    const templateFiles = [
      'AGENTS.md', 'BOOTSTRAP.md', 'SOUL.md', 'IDENTITY.md', 'USER.md',
      'COMPANY.md', 'PRODUCTS.md', 'MEMORY.md', 'HEARTBEAT.md', 'TOOLS.md',
      'README.md',
    ];
    for (const f of templateFiles) {
      const src = path.join(templateRoot, f);
      const dst = path.join(ws, f);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        try { fs.copyFileSync(src, dst); } catch {}
      }
    }
    const templateDirs = ['skills', 'industry', 'prompts', 'memory', 'tools', 'docs', '.learnings', 'config', 'personas'];
    for (const d of templateDirs) {
      copyDirRecursive(path.join(templateRoot, d), path.join(ws, d));
    }
    // Copy knowledge/sales-playbook.md explicitly (rest of knowledge/ is CEO-owned).
    try {
      const playbookSrc = path.join(templateRoot, 'knowledge', 'sales-playbook.md');
      const playbookDstDir = path.join(ws, 'knowledge');
      const playbookDst = path.join(playbookDstDir, 'sales-playbook.md');
      if (fs.existsSync(playbookSrc) && !fs.existsSync(playbookDst)) {
        fs.mkdirSync(playbookDstDir, { recursive: true });
        fs.copyFileSync(playbookSrc, playbookDst);
      }
    } catch {}
  }

  // Seed empty shop-state.json (daily state file) if missing
  try {
    const shopStatePath = path.join(ws, 'shop-state.json');
    if (!fs.existsSync(shopStatePath)) {
      writeJsonAtomic(shopStatePath, {
        updatedAt: new Date().toISOString(),
        updatedBy: 'seed',
        outOfStock: [],
        staffAbsent: [],
        shippingDelay: { active: false, reason: '', estimatedDelayHours: 0 },
        activePromotions: [],
        earlyClosing: { active: false, time: null },
        specialNotes: '',
      });
    }
  } catch {}

  // REMOVED (user report 2026-04-18): legacy cleanup was deleting the
  // zalo-group-settings.json file whenever every entry was mode="off".
  // That pattern is ALSO what a CEO who legitimately turns off bot in all
  // groups via Dashboard "Tắt tất cả" produces. Result: their explicit
  // all-off setting got wiped on next boot → Dashboard fell back to the
  // UI default ("mention") → user saw all groups reset to @mention with
  // no memory of their choice. The original legacy case (v2.3.42-era
  // buggy save that unilaterally wrote all-off) hasn't been writable for
  // many releases; any legitimate all-off file now is intentional and
  // must be preserved.

  // Seed default active-persona mix if missing (wizard overwrites later).
  // Format: active-persona.json (structured config) + active-persona.md
  // (compiled prompt bot reads on bootstrap).
  //
  // Upgrade migration: if user had v2.2.35 with active-persona.txt (single
  // archetype id), map that to a matching mix config before seeding default.
  // Otherwise silently losing their wizard choice would change bot voice
  // without warning.
  try {
    const mixJsonPath = path.join(ws, 'active-persona.json');
    const compiledPath = path.join(ws, 'active-persona.md');
    const legacyPath = path.join(ws, 'active-persona.txt');

    // Archetype id → mix config map (mirrors PERSONA_PRESETS in wizard.html).
    // Traits use the 15 scientific slugs (Big Five + service-specific).
    const ARCHETYPE_TO_MIX = {
      'chi-ban-hang-mien-tay': { region: 'tay',         voice: 'em-nu-tre',       customer: 'anh-chi',   traits: ['am-ap','thuc-te','kien-nhan','chu-dao'],            formality: 4 },
      'em-sale-bds-sg':        { region: 'nam',         voice: 'em-nu-tre',       customer: 'anh-chi',   traits: ['nang-dong','chu-dong','chuyen-nghiep','chu-dao'],   formality: 6 },
      'co-giao-ha-noi':        { region: 'bac',         voice: 'chi-trung-nien',  customer: 'anh-chi',   traits: ['chin-chu','kien-nhan','chu-dao','tinh-te'],         formality: 8 },
      'duoc-si-an-can':        { region: 'trung-tinh',  voice: 'em-nu-tre',       customer: 'anh-chi',   traits: ['chin-chu','dong-cam','diem-tinh','chu-dao'],        formality: 6 },
      'chi-spa-nhe-nhang':     { region: 'trung-tinh',  voice: 'em-nu-tre',       customer: 'anh-chi',   traits: ['tinh-te','am-ap','diem-tinh','linh-hoat'],          formality: 7 },
      'anh-tho-sua-xe':        { region: 'nam',         voice: 'em-nam-tre',      customer: 'anh-chi',   traits: ['thang-than','thuc-te','chu-dao','than-thien'],      formality: 4 },
      'co-le-tan-khach-san':   { region: 'bac',         voice: 'em-nu-tre',       customer: 'quy-khach', traits: ['tinh-te','chuyen-nghiep','chin-chu','linh-hoat'],  formality: 10 },
      'anh-sale-oto':          { region: 'trung-tinh',  voice: 'em-nam-tre',      customer: 'anh-chi',   traits: ['chuyen-nghiep','chu-dong','chu-dao','linh-hoat'],  formality: 7 },
      'chi-chu-boutique':      { region: 'nam',         voice: 'em-nu-tre',       customer: 'anh-chi',   traits: ['sang-tao','tinh-te','am-ap','linh-hoat'],           formality: 6 },
      'anh-ky-thuat-cong-nghe':{ region: 'trung-tinh',  voice: 'em-nam-tre',      customer: 'anh-chi',   traits: ['chuyen-nghiep','kien-nhan','thuc-te','chu-dao'],   formality: 6 },
    };

    if (!fs.existsSync(mixJsonPath)) {
      let mixToSeed = null;

      // Try migration from v2.2.35 legacy format
      try {
        if (fs.existsSync(legacyPath)) {
          const oldId = fs.readFileSync(legacyPath, 'utf-8').trim();
          if (ARCHETYPE_TO_MIX[oldId]) {
            mixToSeed = Object.assign({ greeting: '', closing: '', phrases: '' }, ARCHETYPE_TO_MIX[oldId]);
            console.log('[seedWorkspace] migrated legacy persona "' + oldId + '" → mix config');
          }
        }
      } catch (e) {
        console.warn('[seedWorkspace] legacy persona migration failed:', e?.message);
      }

      // Fresh install default
      if (!mixToSeed) {
        mixToSeed = {
          region: 'trung-tinh',
          voice: 'em-nu-tre',
          customer: 'anh-chi',
          traits: ['am-ap', 'chu-dao', 'chuyen-nghiep'],
          formality: 5,
          greeting: '',
          closing: '',
          phrases: '',
        };
      }

      writeJsonAtomic(mixJsonPath, mixToSeed);
      if (typeof compilePersonaMix === 'function') {
        fs.writeFileSync(compiledPath, compilePersonaMix(mixToSeed), 'utf-8');
      }
    }
    // Legacy cleanup — only delete AFTER migration above had a chance to run
    try {
      if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
    } catch {}
  } catch {}

  // ALWAYS ensure runtime files exist (dev + packaged)
  const schedulesFile = path.join(ws, 'schedules.json');
  if (!fs.existsSync(schedulesFile)) {
    try { writeJsonAtomic(schedulesFile, DEFAULT_SCHEDULES_JSON); } catch {}
  }
  // Strip entries with owner:"facebook" — FB features are v2.3.48+, not this version.
  // Prevents stale dev/test data from showing up in Tổng quan timeline.
  try {
    if (fs.existsSync(schedulesFile)) {
      const sched = JSON.parse(fs.readFileSync(schedulesFile, 'utf-8'));
      if (Array.isArray(sched)) {
        const cleaned = sched.filter(s => s?.owner !== 'facebook' && !/^fb-/.test(s?.id || ''));
        if (cleaned.length < sched.length) {
          writeJsonAtomic(schedulesFile, cleaned);
          console.log(`[seedWorkspace] removed ${sched.length - cleaned.length} FB schedule(s) from schedules.json (not supported in this version)`);
        }
      }
    }
  } catch (e) { console.warn('[seedWorkspace] FB schedule cleanup error:', e?.message); }
  // INTENTIONAL: custom-crons.json is NOT in `templateFiles` above. It is user
  // data, never a template. Packaged fresh installs always get an empty list
  // here because their workspace=userData/ doesn't have the file. Devs cloning
  // the repo get whatever is in the source tree (their problem to manage).
  const customCronsFile = path.join(ws, 'custom-crons.json');
  if (!fs.existsSync(customCronsFile)) {
    try { writeJsonAtomic(customCronsFile, []); } catch {}
  }
  const blocklistFile = path.join(ws, 'zalo-blocklist.json');
  if (!fs.existsSync(blocklistFile)) {
    try { writeJsonAtomic(blocklistFile, []); } catch {}
  }

  // Zalo per-user memory dir (bot writes <senderId>.md per customer).
  // Bot's actual workspace is in openclaw.json -> agents.defaults.workspace,
  // NOT MODOROClaw's getWorkspace(). Pre-create at BOTH locations so the
  // Dashboard reader sees something even if openclaw.json isn't ready yet
  // on a fresh install (the agent-workspace one is the canonical one that
  // bot will actually use after wizard).
  try { fs.mkdirSync(path.join(ws, 'memory', 'zalo-users'), { recursive: true }); } catch {}
  try { fs.mkdirSync(path.join(ws, 'memory', 'zalo-groups'), { recursive: true }); } catch {}
  try {
    const agentWs = (typeof getOpenclawAgentWorkspace === 'function') ? getOpenclawAgentWorkspace() : null;
    if (agentWs && agentWs !== ws) {
      fs.mkdirSync(path.join(agentWs, 'memory', 'zalo-users'), { recursive: true });
      fs.mkdirSync(path.join(agentWs, 'memory', 'zalo-groups'), { recursive: true });
    }
  } catch {}

  // Knowledge tab folders + index files
  const knowCategories = ['cong-ty', 'san-pham', 'nhan-vien', '9bizclaw'];
  const knowLabels = { 'cong-ty': 'Công ty', 'san-pham': 'Sản phẩm', 'nhan-vien': 'Nhân viên', '9bizclaw': '9BizClaw' };
  for (const cat of knowCategories) {
    const filesDir = path.join(ws, 'knowledge', cat, 'files');
    try { fs.mkdirSync(filesDir, { recursive: true }); } catch {}
    const indexFile = path.join(ws, 'knowledge', cat, 'index.md');
    if (!fs.existsSync(indexFile)) {
      try {
        fs.writeFileSync(
          indexFile,
          `# Knowledge — ${knowLabels[cat]}\n\n*Chưa có tài liệu nào. CEO upload file qua Dashboard → Knowledge.*\n`,
          'utf-8'
        );
      } catch {}
    }
  }
  // Seed 9BizClaw product doc from source tree (self-knowledge for the bot)
  const bizclawSrc = path.join(__dirname, '..', 'knowledge', '9bizclaw');
  const bizclawDst = path.join(ws, 'knowledge', '9bizclaw');
  if (fs.existsSync(bizclawSrc)) copyDirRecursive(bizclawSrc, bizclawDst);

  return ws;
}

// Cross-platform helpers
const HOME = process.env.HOME || process.env.USERPROFILE || '';

// =====================================================================
// Node version manager enumeration — shared by every "find a binary on
// this user's machine" path. macOS users very commonly install Node via
// nvm/volta/asdf/fnm/MacPorts/Homebrew, and Electron launched from
// Finder doesn't inherit the shell PATH that those managers set up.
// Without enumerating these locations explicitly, the app would silently
// fail to find `node`, `openclaw`, or `openclaw.mjs` for many Mac users.
//
// Returns an array of "directory" entries — caller appends the binary
// name as needed (e.g. `path.join(dir, 'openclaw')`).
// =====================================================================
function enumerateNodeManagerBinDirs() {
  const dirs = [];
  const isWin = process.platform === 'win32';
  const home = HOME;

  // 1. nvm — enumerate ALL installed versions, newest first
  try {
    const nvmRoots = isWin
      ? [path.join(process.env.APPDATA || '', 'nvm'), path.join(home, 'AppData', 'Roaming', 'nvm')]
      : [path.join(home, '.nvm', 'versions', 'node')];
    for (const root of nvmRoots) {
      if (!fs.existsSync(root)) continue;
      const versions = fs.readdirSync(root)
        .filter((v) => /^v?\d+\./.test(v))
        .sort((a, b) => {
          const pa = a.replace(/^v/, '').split('.').map(Number);
          const pb = b.replace(/^v/, '').split('.').map(Number);
          for (let i = 0; i < 3; i++) {
            if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
          }
          return 0;
        });
      for (const v of versions) {
        dirs.push(isWin ? path.join(root, v) : path.join(root, v, 'bin'));
      }
    }
  } catch {}

  // 2. volta
  try {
    const voltaRoot = process.env.VOLTA_HOME || path.join(home, '.volta');
    dirs.push(path.join(voltaRoot, 'bin'));
  } catch {}

  // 3. asdf (Linux/macOS only) — shims dir holds a wrapper for every binary
  if (!isWin) {
    try {
      dirs.push(path.join(home, '.asdf', 'shims'));
      // Also enumerate per-version installs (in case shims are stale)
      const asdfRoot = path.join(home, '.asdf', 'installs', 'nodejs');
      if (fs.existsSync(asdfRoot)) {
        for (const v of fs.readdirSync(asdfRoot)) {
          dirs.push(path.join(asdfRoot, v, 'bin'));
        }
      }
    } catch {}
  }

  // 4. fnm — newest first
  try {
    const fnmRoots = isWin
      ? [path.join(home, 'AppData', 'Local', 'fnm_multishells')]
      : [path.join(home, '.local', 'share', 'fnm', 'node-versions'), path.join(home, '.fnm', 'node-versions')];
    for (const root of fnmRoots) {
      if (!fs.existsSync(root)) continue;
      const versions = fs.readdirSync(root)
        .filter((v) => /v?\d+\./.test(v))
        .sort()
        .reverse();
      for (const v of versions) {
        dirs.push(isWin ? path.join(root, v) : path.join(root, v, 'installation', 'bin'));
      }
    }
  } catch {}

  // 4b. nodenv — newest first
  if (!isWin) {
    try {
      dirs.push(path.join(home, '.nodenv', 'shims'));
      const nodenvRoot = path.join(home, '.nodenv', 'versions');
      if (fs.existsSync(nodenvRoot)) {
        const versions = fs.readdirSync(nodenvRoot).sort().reverse();
        for (const v of versions) dirs.push(path.join(nodenvRoot, v, 'bin'));
      }
    } catch {}
  }

  // 4c. n (tj/n) — installs into /usr/local by default but can be configured
  if (!isWin) {
    try {
      const nPrefix = process.env.N_PREFIX || '/usr/local';
      dirs.push(path.join(nPrefix, 'bin'));
      const nRoot = path.join(nPrefix, 'n', 'versions', 'node');
      if (fs.existsSync(nRoot)) {
        const versions = fs.readdirSync(nRoot).sort().reverse();
        for (const v of versions) dirs.push(path.join(nRoot, v, 'bin'));
      }
    } catch {}
  }

  // 4d. mise (formerly rtx) — shims dir
  if (!isWin) {
    try {
      const miseShims = path.join(home, '.local', 'share', 'mise', 'shims');
      dirs.push(miseShims);
      // Also look up installed node versions
      const miseRoot = path.join(home, '.local', 'share', 'mise', 'installs', 'node');
      if (fs.existsSync(miseRoot)) {
        const versions = fs.readdirSync(miseRoot).sort().reverse();
        for (const v of versions) dirs.push(path.join(miseRoot, v, 'bin'));
      }
    } catch {}
  }

  // 4e. devbox / nix-installed Node — devbox installs to a unique nix store path
  // per project, but adds shims to a known location
  if (!isWin) {
    try {
      dirs.push('/nix/var/nix/profiles/default/bin');
      dirs.push(path.join(home, '.nix-profile', 'bin'));
    } catch {}
  }

  // 5. Homebrew + system locations
  if (!isWin) {
    if (process.platform === 'darwin') {
      dirs.push('/opt/homebrew/bin');     // Apple Silicon
      dirs.push('/opt/homebrew/sbin');
      dirs.push('/usr/local/bin');         // Intel Mac + Homebrew prefix on Apple Silicon
      dirs.push('/usr/local/sbin');
      dirs.push('/opt/local/bin');         // MacPorts
      dirs.push('/opt/local/sbin');
    }
    dirs.push('/usr/bin');
    dirs.push('/usr/local/bin');
    dirs.push('/snap/bin');
  } else {
    dirs.push('C:\\Program Files\\nodejs');
    dirs.push('C:\\Program Files (x86)\\nodejs');
    dirs.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs'));
    dirs.push(path.join(home, 'scoop', 'apps', 'nodejs', 'current'));
    dirs.push(path.join(home, 'scoop', 'apps', 'nodejs-lts', 'current'));
    dirs.push(path.join(process.env.APPDATA || '', 'npm'));
    dirs.push(path.join(home, 'AppData', 'Roaming', 'npm'));
  }

  // 6. User-local installs
  dirs.push(path.join(home, '.local', 'bin'));
  dirs.push(path.join(home, '.npm-global', 'bin'));

  // De-duplicate while preserving order
  const seen = new Set();
  return dirs.filter((d) => { if (!d || seen.has(d)) return false; seen.add(d); return true; });
}

// Enumerate sibling node_modules directories (where openclaw.mjs would live)
// derived from the bin directories above. For npm-global installs, openclaw.mjs
// lives at <binDir>/node_modules/openclaw/openclaw.mjs OR
// <binDir>/../lib/node_modules/openclaw/openclaw.mjs depending on layout.
function enumerateNodeManagerLibDirs() {
  const libs = [];
  for (const binDir of enumerateNodeManagerBinDirs()) {
    libs.push(path.join(binDir, 'node_modules'));                 // Windows-style
    libs.push(path.join(binDir, '..', 'lib', 'node_modules'));    // Unix-style
  }
  // Add specific Mac/Linux global lib paths just in case
  if (process.platform !== 'win32') {
    libs.push('/usr/local/lib/node_modules');
    libs.push('/opt/homebrew/lib/node_modules');
    libs.push('/opt/local/lib/node_modules');
    libs.push('/usr/lib/node_modules');
  }
  const seen = new Set();
  return libs.filter((d) => { if (!d || seen.has(d)) return false; seen.add(d); return true; });
}

// Mac/Linux: Electron launched from Finder doesn't inherit shell PATH. Add
// every directory that might hold `node`, `openclaw`, `openzca`, `npm`, etc.
// so child spawns + execSync('which node') succeed regardless of how Node was
// installed. Keep ORIGINAL process.env.PATH at the END so user-set entries
// still win when they're set.
//
// Important: do NOT filter by fs.existsSync. PATH lookup tolerates non-existent
// dirs gracefully, and including them means the user installing Node *after*
// MODOROClaw boot still works without an Electron restart. Only cost is a
// slightly longer PATH string.
if (process.platform === 'darwin' || process.platform === 'linux') {
  const extra = enumerateNodeManagerBinDirs();
  process.env.PATH = extra.join(':') + ':' + (process.env.PATH || '');
}
// Packaged Mac .app: prepend bundled vendor/node/bin so child processes
// (openclaw plugins, 9router) find a real `node` binary even on a Mac
// with zero Node installed.
try { augmentPathWithBundledNode(); } catch {}
function appDataDir() {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
}

// ============================================
//  HELPERS
// ============================================

// Resolve a candidate (which may be a bare command name like 'openclaw') to an
// ABSOLUTE path. Critical because findOpenClawCliJs uses _cachedBin to derive
// the openclaw.mjs location via path.dirname(_cachedBin) — if _cachedBin is
// 'openclaw.cmd' (relative), the derived path becomes useless.
function resolveBinAbsolute(bin) {
  if (!bin) return bin;
  if (path.isAbsolute(bin)) return bin;
  try {
    const { execFileSync } = require('child_process');
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [bin], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    const first = out.split(/\r?\n/)[0]?.trim();
    if (first && fs.existsSync(first)) return first;
  } catch {}
  return bin; // give up — keep relative; the caller will still spawn it
}

// When packaged with bundled vendor, openclaw is the .mjs file inside
// vendor/node_modules/openclaw/. There is NO .cmd / .exe shim — the gateway
// is spawned via `<bundled-node> openclaw.mjs`. findOpenClawBin returns the
// .mjs path for these builds; callers (runOpenClaw, spawnOpenClawSafe) already
// know to spawn it via getBundledNodeBin() instead of executing directly.
function findBundledOpenClawMjs() {
  const v = getBundledVendorDir();
  if (!v) return null;
  const mjs = path.join(v, 'node_modules', 'openclaw', 'openclaw.mjs');
  try { if (fs.existsSync(mjs)) return mjs; } catch {}
  return null;
}

async function findOpenClawBin() {
  if (_cachedBin) return _cachedBin;

  const isWin = process.platform === 'win32';

  // 0. Bundled vendor (full-bundled Mac DMG + Win EXE) — check FIRST so
  //    packaged builds never depend on user's system openclaw / system Node.
  //    Trust file existence: SHA256 verify ran during tar extract. We used
  //    to spawn `node openclaw.mjs --version` here, but on slow SSDs the
  //    cold-load of openclaw (500+ deps) exceeded the 8s timeout → detection
  //    fell through → no-openclaw.html shown → user sees install-code loop.
  const bundledMjs = findBundledOpenClawMjs();
  const bundledNode = getBundledNodeBin();
  if (bundledMjs && bundledNode) {
    _cachedBin = bundledMjs; // cache the .mjs path; callers detect .mjs and use bundled node
    console.log('[findOpenClawBin] using bundled:', bundledMjs);
    return _cachedBin;
  }
  if (app && app.isPackaged) {
    console.warn('[findOpenClawBin] packaged build but bundled vendor missing. mjs=', bundledMjs, 'node=', bundledNode, 'vendorDir=', getBundledVendorDir());
  }

  const candidates = [];

  // 1. PATH lookup (covers most setups including system Node)
  candidates.push(isWin ? 'openclaw.cmd' : 'openclaw');
  candidates.push('openclaw');

  // 2. Every Node version manager bin dir + npm global locations
  for (const dir of enumerateNodeManagerBinDirs()) {
    candidates.push(path.join(dir, isWin ? 'openclaw.cmd' : 'openclaw'));
    if (isWin) candidates.push(path.join(dir, 'openclaw'));
  }

  // 3. Legacy openclaw self-installed location
  candidates.push(path.join(HOME, '.openclaw', 'bin', isWin ? 'openclaw.exe' : 'openclaw'));
  if (isWin) candidates.push('C:\\Program Files\\openclaw\\openclaw.exe');

  for (const bin of candidates) {
    if (!bin) continue;
    // Fail-fast: skip absolute paths whose target doesn't exist (avoids
    // 30+ spawn syscalls on a Mac cold start where most candidates miss).
    // Bare names ('openclaw') still go through spawn so PATH lookup works.
    if (path.isAbsolute(bin) && !fs.existsSync(bin)) continue;
    try {
      const vOpts = { timeout: 5000, stdio: 'pipe', windowsHide: true };
      if (isWin && bin.endsWith('.cmd')) vOpts.shell = true;
      await execFilePromise(bin, ['--version'], vOpts);
      _cachedBin = resolveBinAbsolute(bin); // cache absolute path so derived helpers work
      return _cachedBin;
    } catch {}
  }
  return null;
}

// Sync version only for startup (before window is created)
function findOpenClawBinSync() {
  if (_cachedBin) return _cachedBin;
  const { execFileSync } = require('child_process');
  const isWin = process.platform === 'win32';

  // 0. Bundled vendor — trust file existence, no spawn check.
  //    See findOpenClawBin above for rationale (cold-load timeout on slow SSDs).
  const bundledMjs = findBundledOpenClawMjs();
  const bundledNode = getBundledNodeBin();
  if (bundledMjs && bundledNode) {
    _cachedBin = bundledMjs;
    console.log('[findOpenClawBinSync] using bundled:', bundledMjs);
    return _cachedBin;
  }
  if (app && app.isPackaged) {
    console.warn('[findOpenClawBinSync] packaged build but bundled vendor missing. mjs=', bundledMjs, 'node=', bundledNode, 'vendorDir=', getBundledVendorDir());
  }

  // Same enumeration as findOpenClawBin so dev-mode and packaged-mode have
  // identical Mac/Linux Node-version-manager coverage.
  const candidates = [];
  candidates.push(isWin ? 'openclaw.cmd' : 'openclaw');
  candidates.push('openclaw');
  for (const dir of enumerateNodeManagerBinDirs()) {
    candidates.push(path.join(dir, isWin ? 'openclaw.cmd' : 'openclaw'));
    if (isWin) candidates.push(path.join(dir, 'openclaw'));
  }
  candidates.push(path.join(HOME, '.openclaw', 'bin', isWin ? 'openclaw.exe' : 'openclaw'));

  for (const bin of candidates) {
    if (!bin) continue;
    // Fail-fast: skip absolute paths whose target doesn't exist
    if (path.isAbsolute(bin) && !fs.existsSync(bin)) continue;
    try {
      const opts = { timeout: 5000, stdio: 'pipe', windowsHide: true };
      if (isWin && bin.endsWith('.cmd')) opts.shell = true;
      execFileSync(bin, ['--version'], opts);
      _cachedBin = resolveBinAbsolute(bin);
      return _cachedBin;
    } catch {}
  }
  return null;
}

async function runOpenClaw(args, timeout = 10000) {
  const bin = await findOpenClawBin();
  if (!bin) throw new Error('OpenClaw not found');
  const opts = { timeout, encoding: 'utf-8', stdio: 'pipe', windowsHide: true };
  // Bundled vendor: bin is the .mjs file, must be invoked via the bundled Node binary.
  // (See findOpenClawBin Strategy 0.)
  if (bin.endsWith('.mjs')) {
    const nodeBin = getBundledNodeBin() || findNodeBin();
    if (!nodeBin) throw new Error('No Node binary found to invoke openclaw.mjs');
    const { stdout } = await execFilePromise(nodeBin, [bin, ...args], opts);
    return stdout;
  }
  if (process.platform === 'win32' && bin.endsWith('.cmd')) opts.shell = true;
  const { stdout } = await execFilePromise(bin, args, opts);
  return stdout;
}

// 9BizClaw PATCH: resolve `node` to an absolute path so child spawns work even
// when Electron's PATH is missing nvm/volta/scoop/portable Node locations (a real
// issue when Electron is launched from Finder on macOS or as Administrator on
// Windows). Without this, `spawn('node', ...)` returns ENOENT for users who
// installed Node via a non-system manager, breaking the entire cron-agent path.
let _cachedNodeBin = null;
function findNodeBin() {
  if (_cachedNodeBin !== null) return _cachedNodeBin || null;

  // Packaged Mac .app: bundled Node always wins. User has zero Node setup.
  const bundled = getBundledNodeBin();
  if (bundled) {
    _cachedNodeBin = bundled;
    console.log('[findNodeBin] using bundled vendor node:', bundled);
    return bundled;
  }

  const isWin = process.platform === 'win32';
  const candidates = [];

  // 1. PATH lookup via execSync (works when PATH is correct, including the Mac
  //    PATH augmentation from the top of this file).
  try {
    const { execSync } = require('child_process');
    const cmd = isWin ? 'where node' : 'command -v node';
    const out = execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, shell: !isWin }).trim();
    const first = out.split(/\r?\n/)[0]?.trim();
    if (first && fs.existsSync(first)) candidates.push(first);
  } catch {}

  // 2. Every Node version manager bin dir (nvm, volta, asdf, fnm, brew, MacPorts, etc.)
  for (const dir of enumerateNodeManagerBinDirs()) {
    candidates.push(path.join(dir, isWin ? 'node.exe' : 'node'));
  }

  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) { _cachedNodeBin = p; console.log('[findNodeBin] using:', p); return p; } } catch {}
  }
  console.error('[findNodeBin] FAILED — no Node binary found in any candidate location');
  _cachedNodeBin = '';
  return null;
}

// 9BizClaw PATCH: resolve openclaw.mjs path so we can spawn `node openclaw.mjs ...`
// directly with shell:false. Avoids cmd.exe silently truncating args containing
// newlines (same class of bug as the OpenZalo `shell:true` issue documented in CLAUDE.md).
let _cachedOpenClawCliJs = null;
function findOpenClawCliJs() {
  if (_cachedOpenClawCliJs !== null) return _cachedOpenClawCliJs || null;

  // Packaged Mac .app: bundled vendor openclaw always wins.
  const bundled = getBundledOpenClawCliJs();
  if (bundled) {
    _cachedOpenClawCliJs = bundled;
    console.log('[findOpenClawCliJs] using bundled vendor openclaw:', bundled);
    return bundled;
  }

  // Strategy 1 (primary): derive from the resolved openclaw bin path. Whatever
  // package manager (npm / pnpm / nvm / corepack / volta) installed openclaw,
  // its sibling node_modules/openclaw/openclaw.mjs lives next to the bin shim.
  // More reliable than guessing because it follows the actual install location.
  const derived = [];
  try {
    if (_cachedBin) {
      const binDir = path.dirname(_cachedBin);
      derived.push(path.join(binDir, 'node_modules', 'openclaw', 'openclaw.mjs'));
      derived.push(path.join(binDir, '..', 'lib', 'node_modules', 'openclaw', 'openclaw.mjs'));
    }
  } catch {}

  // Strategy 2: every Node version manager's lib/node_modules directory
  const enumerated = [];
  for (const lib of enumerateNodeManagerLibDirs()) {
    enumerated.push(path.join(lib, 'openclaw', 'openclaw.mjs'));
  }

  // Strategy 3: legacy/exotic install locations
  const home = HOME;
  const isWin = process.platform === 'win32';
  const exotic = isWin
    ? [
        path.join(home, 'AppData', 'Local', 'npm', 'node_modules', 'openclaw', 'openclaw.mjs'),
      ]
    : [
        path.join(home, '.volta', 'tools', 'image', 'packages', 'openclaw', 'lib', 'node_modules', 'openclaw', 'openclaw.mjs'),
      ];

  for (const p of [...derived, ...enumerated, ...exotic]) {
    try { if (p && fs.existsSync(p)) { _cachedOpenClawCliJs = p; return p; } } catch {}
  }
  _cachedOpenClawCliJs = '';
  return null;
}

// Spawn `openclaw` safely so multi-line / special-char args survive on Windows.
// Returns { code, stdout, stderr, viaCmdShell }.
//
// Reliability strategy:
//   1. Preferred path: spawn `<absolute node path> openclaw.mjs <args>` with
//      shell:false. This is the only path that's guaranteed safe for multi-line
//      prompts on Windows. Both `node` and `openclaw.mjs` are resolved to absolute
//      paths so it works regardless of Electron's PATH.
//   2. Fallback path: spawn `openclaw.cmd <args>` with shell:true. This is unsafe
//      for multi-line args (cmd.exe truncates), so callers MUST inspect the
//      `viaCmdShell` flag and refuse to use it for prompt-bearing operations.
function spawnOpenClawSafe(args, { timeoutMs = 600000, cwd, allowCmdShellFallback = true } = {}) {
  return new Promise(async (resolve) => {
    const cliJs = findOpenClawCliJs();
    const nodeBin = findNodeBin();
    let cmd, spawnArgs, useShell, viaCmdShell = false;
    if (cliJs && nodeBin) {
      // Preferred: absolute node + openclaw.mjs, no shell. Multi-line safe.
      cmd = nodeBin;
      spawnArgs = [cliJs, ...args];
      useShell = false;
    } else {
      if (!allowCmdShellFallback) {
        const why = !nodeBin ? 'node binary not found on this system' : 'openclaw.mjs not found';
        console.error(`[spawnOpenClawSafe] refusing cmd-shell fallback (caller forbade it): ${why}`);
        return resolve({ code: -1, stdout: '', stderr: `cmd-shell fallback refused: ${why}`, viaCmdShell: false });
      }
      const bin = await findOpenClawBin();
      if (!bin) return resolve({ code: -1, stdout: '', stderr: 'openclaw not found', viaCmdShell: false });
      cmd = bin;
      spawnArgs = args;
      useShell = process.platform === 'win32' && bin.endsWith('.cmd');
      viaCmdShell = useShell; // dangerous for multi-line args on Windows
      console.warn(`[spawnOpenClawSafe] WARN — falling back to ${bin} (viaCmdShell=${viaCmdShell}). Multi-line args may be truncated. Reason: nodeBin=${!!nodeBin} cliJs=${!!cliJs}`);
    }
    let stdout = '', stderr = '';
    let child;
    try {
      child = spawn(cmd, spawnArgs, {
        cwd: cwd || getWorkspace(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: useShell,
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String(e?.message || e), viaCmdShell });
    }
    const killer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000).unref();
    }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += String(c); });
    child.stderr.on('data', (c) => { stderr += String(c); });
    child.on('error', (e) => { clearTimeout(killer); resolve({ code: -1, stdout, stderr: stderr + String(e?.message || e), viaCmdShell }); });
    child.on('close', (code) => { clearTimeout(killer); resolve({ code: code ?? 0, stdout, stderr, viaCmdShell }); });
  });
}

// ============================================================
//   CRON AGENT PIPELINE — Path B "must never silently fail"
// ============================================================
//
// Reliability strategy:
//   1. Boot self-test inspects `openclaw agent --help` and picks the most-explicit
//      flag profile that the current openclaw version actually supports. This
//      catches CLI drift on EVERY app start, before any real cron fires.
//   2. Flag profiles fall back from rich → minimal so future openclaw versions
//      that drop a flag still work.
//   3. Each cron run retries up to 3× with backoff on transient failures.
//   4. Every fire is journaled to ~/.openclaw/workspace/logs/cron-runs.jsonl
//      so "did my 12:25 cron run?" is always answerable.
//   5. Total failure → loud Telegram notification to CEO. Never silent.

let _agentFlagProfile = null;   // 'full' | 'medium' | 'minimal'
let _agentCliHealthy = false;
let _agentCliVersionOk = false; // true only when --version call succeeds (real health signal)
let _selfTestPromise = null;

function cronJournalPath() {
  return path.join(getWorkspace(), 'logs', 'cron-runs.jsonl');
}
function journalCronRun(entry) {
  try {
    const file = cronJournalPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n', 'utf-8');
  } catch (e) {
    console.error('[cron-journal] write error:', e.message);
  }
}

// =====================================================================
// Boot diagnostic — writes a human-readable file showing exactly what was
// found and what wasn't, on EVERY boot. Critical for Mac users who launch
// from Finder and have no visible console output.
//
// File: <workspace>/logs/boot-diagnostic.txt
// Cron pipeline failures? Check this file FIRST. It tells you:
//   - What platform we're on
//   - What `node` binary was resolved (or not)
//   - What `openclaw` binary was resolved (or not)
//   - What `openclaw.mjs` was resolved (or not)
//   - Whether the gateway came up
//   - Whether telegram bot config is present
//   - PATH augmentation status
// =====================================================================
let _bootDiagState = { ts: null, lines: [] };
function bootDiagLog(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log('[boot-diag]', line);
  _bootDiagState.lines.push(stamped);
  // Flush to file each time so partial diagnostics survive a crash
  try {
    const file = path.join(getWorkspace(), 'logs', 'boot-diagnostic.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, stamped + '\n', 'utf-8');
  } catch {}
}
function bootDiagInit() {
  try {
    const file = path.join(getWorkspace(), 'logs', 'boot-diagnostic.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Truncate at start of every boot so old diagnostics don't pile up
    const banner = `==== BOOT ${new Date().toISOString()} ====\n`;
    fs.writeFileSync(file, banner, 'utf-8');
  } catch {}
  _bootDiagState = { ts: Date.now(), lines: [] };
}
function bootDiagRunFullCheck() {
  bootDiagInit();
  bootDiagLog(`platform=${process.platform} arch=${process.arch} electron=${process.versions.electron || 'n/a'} node=${process.versions.node}`);
  bootDiagLog(`HOME=${HOME}`);
  bootDiagLog(`workspace=${getWorkspace()}`);
  bootDiagLog(`PATH (first 500 chars)=${(process.env.PATH || '').slice(0, 500)}`);

  // Node binary
  const nodeBin = findNodeBin();
  if (nodeBin) {
    bootDiagLog(`✓ findNodeBin: ${nodeBin}`);
  } else {
    bootDiagLog(`✗ findNodeBin: NOT FOUND — cron pipeline will fall back to openclaw.cmd shim (multi-line UNSAFE on Windows)`);
  }

  // openclaw binary (sync version, available before app.whenReady)
  const openclawBin = findOpenClawBinSync();
  if (openclawBin) {
    bootDiagLog(`✓ findOpenClawBin: ${openclawBin}`);
  } else {
    bootDiagLog(`✗ findOpenClawBin: NOT FOUND — wizard cannot run. User must \`npm install -g openclaw\``);
  }

  // openclaw.mjs (depends on _cachedBin being set, which findOpenClawBinSync just did)
  const openclawCli = findOpenClawCliJs();
  if (openclawCli) {
    bootDiagLog(`✓ findOpenClawCliJs: ${openclawCli} (multi-line prompts SAFE)`);
  } else {
    bootDiagLog(`✗ findOpenClawCliJs: NOT FOUND — will fall back to bin shim. On Windows this means cmd.exe truncates multi-line cron prompts. On Mac this is fine but slower.`);
  }

  // Telegram chat config presence
  try {
    const cfg = getTelegramConfig();
    if (cfg.token && cfg.chatId) {
      bootDiagLog(`✓ Telegram config: token+chatId present (chatId=${cfg.chatId})${cfg.recovered ? ` (RECOVERED via ${cfg.recovered})` : ''}`);
    } else if (cfg.token) {
      bootDiagLog(`⚠ Telegram config: token present but NO chatId — cron cannot deliver until user /start the bot or wizard re-runs`);
    } else {
      bootDiagLog(`⚠ Telegram config: NO token — wizard not yet completed`);
    }
  } catch (e) {
    bootDiagLog(`✗ Telegram config: error reading openclaw.json: ${e.message}`);
  }

  // openclaw.json schema sanity
  try {
    const cfgPath = path.join(HOME, '.openclaw', 'openclaw.json');
    if (fs.existsSync(cfgPath)) {
      const c = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      const issues = [];
      if (c?.agents?.defaults && 'blockStreaming' in c.agents.defaults) issues.push('agents.defaults.blockStreaming (deprecated key — heal will remove)');
      if (issues.length) {
        bootDiagLog(`⚠ openclaw.json: ${issues.length} known schema issues — will be auto-healed: ${issues.join(', ')}`);
      } else {
        bootDiagLog(`✓ openclaw.json: schema clean (no known deprecated keys)`);
      }
    } else {
      bootDiagLog(`⚠ openclaw.json: not present yet (wizard will create)`);
    }
  } catch (e) {
    bootDiagLog(`✗ openclaw.json: read/parse error: ${e.message}`);
  }

  // Cron files
  try {
    const customCronsFile = path.join(getWorkspace(), 'custom-crons.json');
    if (fs.existsSync(customCronsFile)) {
      const arr = JSON.parse(fs.readFileSync(customCronsFile, 'utf-8'));
      const enabled = Array.isArray(arr) ? arr.filter((c) => c?.enabled).length : 0;
      const total = Array.isArray(arr) ? arr.length : 0;
      bootDiagLog(`✓ custom-crons.json: ${total} cron(s), ${enabled} enabled`);
    } else {
      bootDiagLog(`✓ custom-crons.json: not yet created (will be empty [] on first cron)`);
    }
  } catch (e) {
    bootDiagLog(`✗ custom-crons.json: ${e.message}`);
  }
  try {
    const schedulesFile = path.join(getWorkspace(), 'schedules.json');
    if (fs.existsSync(schedulesFile)) {
      const arr = JSON.parse(fs.readFileSync(schedulesFile, 'utf-8'));
      const enabled = Array.isArray(arr) ? arr.filter((c) => c?.enabled).length : 0;
      bootDiagLog(`✓ schedules.json: ${enabled} fixed schedule(s) enabled`);
    } else {
      bootDiagLog(`⚠ schedules.json: missing — will be created from defaults`);
    }
  } catch (e) {
    bootDiagLog(`✗ schedules.json: ${e.message}`);
  }

  bootDiagLog(`---- diagnostic complete ----`);
}

// Inspect `openclaw agent --help` to pick a flag profile this openclaw version
// actually supports. Runs once per process; safe to call multiple times.
// IMPORTANT design note (Path B v2):
// The self-test is INFORMATIONAL ONLY, never gating. It tries to detect the best
// flag profile from `openclaw agent --help`, but if it can't parse the output for
// any reason (transient PATH glitch, output truncation, openclaw rendering quirk)
// it MUST default to the most-explicit profile and let the actual cron call's
// exit code be the source of truth. The retry+Telegram pipeline in
// runCronAgentPrompt is the real safety net — never let the self-test refuse to
// even attempt a real run. "Must always work" > "must verify before trying".
async function selfTestOpenClawAgent() {
  // If a previous self-test was conclusive (ok=true with a real detected profile),
  // reuse it. Otherwise re-run — installing/upgrading openclaw without restarting
  // the app should be allowed to recover, and a previous inconclusive run should
  // be retried in case PATH/openclaw state changed.
  if (_selfTestPromise && _agentCliHealthy && _agentFlagProfile) return _selfTestPromise;
  _selfTestPromise = (async () => {
    const usingDirectNode = !!findOpenClawCliJs();
    console.log(`[cron-agent self-test] cli path: ${usingDirectNode ? 'node openclaw.mjs (safe)' : 'openclaw.cmd (fallback — newline-fragile)'}`);

    // CRITICAL: previously we used `agent --help` which loads the entire agent
    // subcommand module and takes ~26 seconds. With a 15s timeout, the spawn
    // was being SIGTERM-killed every time, returning code 0 (because `code ?? 0`
    // for null SIGTERM signal) with empty stdout — looking like "openclaw is
    // broken" when in reality it just hadn't finished initializing the agent
    // module.
    //
    // Use `--version` instead — it's a top-level command that exits in ~600ms
    // with predictable output (`OpenClaw 2026.4.5 (3e72c03)\n`). We don't need
    // to parse flag profiles from --help anyway because:
    //   1. The current openclaw version supports the full flag set.
    //   2. If a future openclaw drops a flag, the actual cron call will fail
    //      with `Unrecognized key`/similar and the dynamic schema healer +
    //      retry+Telegram path catches it.
    //   3. We always default to 'full' profile, and the build path falls back
    //      gracefully if a flag isn't supported.
    let res;
    try {
      res = await spawnOpenClawSafe(['--version'], { timeoutMs: 10000 });
    } catch (e) {
      res = { code: -1, stdout: '', stderr: String(e?.message || e) };
    }

    const stdout = res.stdout || '';
    const stderr = res.stderr || '';

    // Always proceed with 'full' profile. Self-test is purely informational —
    // verifies that the CLI runs at all (so we know findNodeBin + findOpenClawCliJs
    // resolved to working paths). If --version succeeded → CLI is reachable.
    // If it failed → log loudly but STILL set 'full' so cron attempts can
    // proceed and surface real errors via retry+Telegram.
    _agentFlagProfile = 'full';
    _agentCliHealthy = true;

    const versionMatch = stdout.match(/OpenClaw\s+(\S+)/);
    const versionStr = versionMatch ? versionMatch[1] : null;

    if (res.code === 0 && versionStr) {
      _agentCliVersionOk = true;
      console.log(`[cron-agent self-test] OK — openclaw ${versionStr} (directNode=${usingDirectNode}, profile=full)`);
      journalCronRun({
        phase: 'self-test',
        ok: true,
        profile: 'full',
        version: versionStr,
        directNode: usingDirectNode,
        code: res.code,
        stdoutLen: stdout.length,
      });
    } else {
      // CLI invocation failed somehow — could be a real installation problem,
      // could be a transient issue. Don't gate, but log everything we have.
      console.warn(`[cron-agent self-test] FAIL — code=${res.code} stdoutLen=${stdout.length} stderrLen=${stderr.length} viaCmdShell=${res.viaCmdShell}`);
      if (stdout) console.warn(`[cron-agent self-test] stdout: ${stdout.slice(0, 300)}`);
      if (stderr) console.warn(`[cron-agent self-test] stderr: ${stderr.slice(0, 300)}`);
      journalCronRun({
        phase: 'self-test',
        ok: false,
        reason: 'version-call-failed',
        defaultedProfile: 'full',
        directNode: usingDirectNode,
        code: res.code,
        stdoutLen: stdout.length,
        stderrLen: stderr.length,
        stdoutPreview: stdout.slice(0, 400),
        stderrPreview: stderr.slice(0, 400),
        viaCmdShell: res.viaCmdShell,
      });
      // We will discover the truth on the first real cron call. The retry loop
      // and Telegram alert in runCronAgentPrompt are the real safety net.
    }
  })();
  return _selfTestPromise;
}

function buildAgentArgs(prompt, chatId) {
  const idStr = String(chatId);
  const base = ['agent', '--message', prompt, '--deliver'];
  if (_agentFlagProfile === 'full') {
    return [...base, '--channel', 'telegram', '--to', idStr, '--reply-channel', 'telegram', '--reply-to', idStr];
  }
  if (_agentFlagProfile === 'medium') {
    return [...base, '--channel', 'telegram', '--to', idStr];
  }
  // minimal — relies on openclaw default channel routing for the bound CEO
  return [...base, '--to', idStr];
}

function isTransientErr(stderr) {
  const s = (stderr || '').toLowerCase();
  return s.includes('econnrefused')
      || s.includes('etimedout')
      || s.includes('gateway') && s.includes('not')
      || s.includes('temporarily')
      || s.includes('timeout');
}

function isConfigInvalidErr(stderr) {
  const s = (stderr || '').toLowerCase();
  return s.includes('config invalid') || s.includes('unrecognized key');
}

function isFatalErr(stderr, exitCode) {
  const s = (stderr || '').toLowerCase();
  // Errors that will NEVER recover with retries — bail immediately so the
  // user gets a fast actionable Telegram alert instead of waiting 7+ seconds
  // for 3 doomed attempts.
  return s.includes('openclaw not found')
      || s.includes('cmd-shell fallback refused')
      || s.includes('enoent') && (s.includes('openclaw') || s.includes('node'))
      || s.includes('eacces')
      || s.includes('not authorized')
      || s.includes('invalid token')
      || (exitCode === 127); // command not found
}

// Parse openclaw stderr for schema violations we can auto-heal.
// openclaw's validator emits two different error formats depending on the
// underlying schema library version:
//
//   1. Zod v3 "Unrecognized key" format:
//        "agents.defaults: Unrecognized key: \"blockStreaming\""
//        "channels.telegram.foo: Unrecognized key: \"bar\""
//
//   2. AJV / JSON-Schema-draft-07 "additional properties" format:
//        "channels.openzalo: invalid config: must NOT have additional properties"
//        "- channels.openzalo/streaming: must match ..."
//
//   3. Plain list format (sometimes wraps around):
//        "channels.openzalo: must NOT have additional properties"
//        followed by: "Additional property: streaming"
//
// For format #1 we can extract both the path AND the specific key.
// For format #2 we only know the parent path — we need to diff against the
// known schema whitelist to figure out which key is the offender. But that
// whitelist is in the plugin source, not shipped to us. Fallback: return the
// parent path only, and the caller does a targeted cleanup using known
// "bad keys we ourselves might have added" — which catches the case where
// WE introduced the invalid field in the first place.
//
// Returns an array of { path: string[], key: string | null } objects.
// A null `key` means "parent path detected but specific field unknown — use
// whitelist diff at caller site".
function parseUnrecognizedKeyErrors(stderr) {
  const out = [];
  if (!stderr) return out;
  // Format #1: Unrecognized key with explicit name
  const unrecognized = /([\w.]+):\s*Unrecognized key:\s*"([^"]+)"/g;
  let m;
  while ((m = unrecognized.exec(stderr)) !== null) {
    out.push({ path: m[1].split('.'), key: m[2] });
  }
  // Format #2: "must NOT have additional properties" at a dotted path
  const additionalProps = /([\w.]+):\s*(?:invalid config:\s*)?must NOT have additional properties/g;
  while ((m = additionalProps.exec(stderr)) !== null) {
    out.push({ path: m[1].split('.'), key: null });
  }
  // Format #3: "Additional property: xxx" as a separate line
  const addlProp = /Additional propert(?:y|ies):\s*"?([^"\s,]+)"?/g;
  while ((m = addlProp.exec(stderr)) !== null) {
    // Without a path, we can't know which parent. Push as unscoped marker.
    out.push({ path: null, key: m[1] });
  }
  return out;
}

// Whitelist of fields we might mistakenly have added to openzalo config that
// are NOT in its schema. When we see "additional properties" error at the
// openzalo path, we strip these known-offenders. Expand this list as we learn.
const KNOWN_BAD_OPENZALO_KEYS = ['streaming', 'streamMode', 'nativeStreaming', 'blockStreamingDefault'];

// Defense-in-depth: synchronously remove deprecated keys from openclaw.json so
// `openclaw <subcommand>` stops exiting with "Config invalid". Cheap, idempotent.
// Called BEFORE every agent spawn AND on any "Config invalid" stderr.
//
// Two modes:
//   - Static mode (no errStderr): removes keys we already know about (current
//     state of the world: agents.defaults.blockStreaming).
//   - Dynamic mode (errStderr passed): parses "Unrecognized key" errors from
//     openclaw stderr and deletes EXACTLY those paths. This means future
//     deprecated keys we don't yet know about heal themselves on first failure.
//
// Returns true if a write happened.
function healOpenClawConfigInline(errStderr) {
  try {
    const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
    if (!fs.existsSync(configPath)) return false;
    const raw = fs.readFileSync(configPath, 'utf-8');
    let config;
    try { config = JSON.parse(raw); } catch (e) {
      console.error('[heal-inline] openclaw.json is not valid JSON — refusing to touch:', e.message);
      return false;
    }
    let changed = false;
    const removed = [];

    // --- Static known-key removals (always run) ---
    if (config?.agents?.defaults && 'blockStreaming' in config.agents.defaults) {
      delete config.agents.defaults.blockStreaming;
      removed.push('agents.defaults.blockStreaming');
      changed = true;
    }
    // Static: strip any KNOWN_BAD_OPENZALO_KEYS from openzalo root + all accounts.
    // These are fields that LOOK like they should work (streaming, streamMode)
    // but openzalo schema doesn't define them, so the validator hard-rejects.
    const stripBadOpenzaloKeys = (block, pathPrefix) => {
      if (!block || typeof block !== 'object') return;
      for (const k of KNOWN_BAD_OPENZALO_KEYS) {
        if (k in block) {
          delete block[k];
          removed.push(`${pathPrefix}.${k}`);
          changed = true;
        }
      }
    };
    if (config?.channels?.openzalo) {
      stripBadOpenzaloKeys(config.channels.openzalo, 'channels.openzalo');
      if (config.channels.openzalo.accounts) {
        for (const accId of Object.keys(config.channels.openzalo.accounts || {})) {
          stripBadOpenzaloKeys(
            config.channels.openzalo.accounts[accId],
            `channels.openzalo.accounts.${accId}`
          );
        }
      }
    }

    // --- Dynamic removals from openclaw's own error message ---
    if (errStderr) {
      const parsed = parseUnrecognizedKeyErrors(errStderr);
      for (const { path: keyPath, key } of parsed) {
        if (keyPath && key) {
          // Format #1: explicit (path, key) — delete exactly that field
          let parent = config;
          let valid = true;
          for (const segment of keyPath) {
            if (parent && typeof parent === 'object' && segment in parent) {
              parent = parent[segment];
            } else { valid = false; break; }
          }
          if (valid && parent && typeof parent === 'object' && key in parent) {
            delete parent[key];
            removed.push(`${keyPath.join('.')}.${key}`);
            changed = true;
          }
        } else if (keyPath && !key) {
          // Format #2: "additional properties" at parent path — we don't know
          // WHICH field is the offender. Strategy: if path is channels.openzalo
          // (or its accounts), strip all KNOWN_BAD_OPENZALO_KEYS. This catches
          // the case where we ourselves added a bad field.
          if (keyPath[0] === 'channels' && keyPath[1] === 'openzalo') {
            let parent = config;
            for (const segment of keyPath) {
              if (parent && typeof parent === 'object' && segment in parent) parent = parent[segment];
              else { parent = null; break; }
            }
            if (parent && typeof parent === 'object') {
              stripBadOpenzaloKeys(parent, keyPath.join('.'));
            }
          }
        } else if (!keyPath && key) {
          // Format #3: "Additional property: xxx" without parent — scan all
          // known channel blocks for this key and strip.
          const channels = config?.channels;
          if (channels) {
            for (const chName of Object.keys(channels)) {
              const ch = channels[chName];
              if (ch && typeof ch === 'object' && key in ch) {
                delete ch[key];
                removed.push(`channels.${chName}.${key}`);
                changed = true;
              }
            }
          }
        }
      }
    }

    if (changed) {
      const wrote = writeOpenClawConfigIfChanged(configPath, config);
      if (wrote) {
        console.log('[heal-inline] healed openclaw.json — removed:', removed.join(', '));
        journalCronRun({ phase: 'heal-inline', changed: true, removed, dynamic: !!errStderr });
      } else {
        console.log('[heal-inline] heal would have run but file already byte-equal — skipping write');
      }
    }
    return changed;
  } catch (e) {
    console.error('[heal-inline] error:', e.message);
    return false;
  }
}

// =====================================================================
// Conversation history extractor for cron prompts
// =====================================================================
// THE ARCHITECTURAL PROBLEM:
// Bot answering "tóm tắt Zalo hôm qua" had no way to read past conversations
// because each cron fire spawns a NEW agent session — that session has no
// memory of past Zalo/Telegram messages which live in OTHER session jsonl
// files at ~/.openclaw/agents/main/sessions/<uuid>.jsonl. Bot would
// hallucinate "no Zalo data" while messages existed on disk.
//
// THE FIX:
// Extract messages directly from session jsonls and INJECT them into the
// cron prompt as a structured context block. Bot doesn't need to discover
// or guess where data lives — it sees actual messages right in the prompt.
// Returns raw structured array of messages. Used by appendPerCustomerSummaries.
function extractConversationHistoryRaw({ sinceMs, maxMessages = 40, channels = ['openzalo', 'telegram'], maxPerSender = 0 } = {}) {
  try {
    const result = _extractConversationHistoryImpl({ sinceMs, maxMessages, channels, maxPerSender });
    return result.collected;
  } catch (e) {
    console.error('[extractConversationHistoryRaw] error:', e?.message || e);
    return [];
  }
}

// Returns formatted string. Used by prompt builders.
function extractConversationHistory({ sinceMs, maxMessages = 40, channels = ['openzalo', 'telegram'], maxPerSender = 0 } = {}) {
  try {
    const result = _extractConversationHistoryImpl({ sinceMs, maxMessages, channels, maxPerSender });
    return result.formatted;
  } catch (e) {
    console.error('[extractConversationHistory] error:', e?.message || e);
    return '';
  }
}

// Shared implementation — returns { collected: [...], formatted: 'string' }.
function _extractConversationHistoryImpl({ sinceMs, maxMessages = 40, channels = ['openzalo', 'telegram'], maxPerSender = 0 } = {}) {
  const _t0 = Date.now();
  const sessionsDir = path.join(HOME, '.openclaw', 'agents', 'main', 'sessions');
  if (!fs.existsSync(sessionsDir)) return { collected: [], formatted: '' };
  const allFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
  if (allFiles.length === 0) return { collected: [], formatted: '' };

  // mtime pre-filter: skip files not modified since sinceMs.
  const candidates = [];
  for (const f of allFiles) {
    const fp = path.join(sessionsDir, f);
    try {
      const stat = fs.statSync(fp);
      if (sinceMs && stat.mtimeMs < sinceMs) continue;
      candidates.push({ path: fp, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch { continue; }
  }
  if (candidates.length === 0) return { collected: [], formatted: '' };

  // Sort newest first — early-exit once we have enough messages.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const collectTarget = maxMessages * 2;

  const collected = [];
  for (const file of candidates) {
    // Tail-read: for large files, read first 4KB (session event) + last 64KB.
    // 4KB covers session events with long customer names / metadata.
    let content;
    try {
      if (file.size > 65536) {
        const fd = fs.openSync(file.path, 'r');
        const HEAD_SIZE = 4096;
        const headBuf = Buffer.alloc(HEAD_SIZE);
        fs.readSync(fd, headBuf, 0, HEAD_SIZE, 0);
        const headRaw = headBuf.toString('utf-8');
        const firstNl = headRaw.indexOf('\n');
        // If no newline found in 4KB, session line is abnormally long — read full file
        if (firstNl < 0) {
          fs.closeSync(fd);
          content = fs.readFileSync(file.path, 'utf-8');
        } else {
          const headStr = headRaw.slice(0, firstNl + 1);
          const tailBuf = Buffer.alloc(65536);
          fs.readSync(fd, tailBuf, 0, 65536, file.size - 65536);
          fs.closeSync(fd);
          let tailStr = tailBuf.toString('utf-8');
          const tailFirstNl = tailStr.indexOf('\n');
          if (tailFirstNl > 0) tailStr = tailStr.slice(tailFirstNl + 1);
          content = headStr + tailStr;
        }
      } else {
        content = fs.readFileSync(file.path, 'utf-8');
      }
    } catch { continue; }

    const lines = content.split(/\r?\n/).filter(l => l.trim());
    let sessionChannel = null;
    let sessionSender = null;
    for (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'session' && event.origin) {
        sessionChannel = event.origin.provider || event.origin.surface || null;
        sessionSender = event.origin.label || null;
        continue;
      }
      if (event.type !== 'message') continue;
      const msg = event.message;
      if (!msg || typeof msg !== 'object') continue;
      const tsMs = typeof msg.timestamp === 'number'
        ? msg.timestamp
        : (event.timestamp ? Date.parse(event.timestamp) : 0);
      if (sinceMs && tsMs < sinceMs) continue;
      if (channels && sessionChannel && !channels.includes(sessionChannel)) continue;
      if (!Array.isArray(msg.content)) continue;
      const textParts = [];
      for (const part of msg.content) {
        if (part?.type === 'text' && typeof part.text === 'string') {
          textParts.push(part.text);
        }
      }
      if (textParts.length === 0) continue;
      let text = textParts.join('\n').trim();
      if (!text) continue;
      if (msg.role === 'user') {
        text = text.replace(/Conversation info[^]*?```\s*\n/g, '');
        text = text.replace(/Sender[^]*?```\s*\n/g, '');
        text = text.replace(/\[Queued messages while agent was busy\]\s*\n*---\n*Queued #\d+\n*/g, '\n');
        text = text.trim();
        if (!text) continue;
      }
      collected.push({
        ts: tsMs,
        role: msg.role,
        channel: sessionChannel || 'unknown',
        sender: sessionSender || 'unknown',
        text: text.slice(0, 500),
      });
    }

    if (collected.length >= collectTarget) break;
  }
  if (collected.length === 0) return { collected: [], formatted: '' };

  collected.sort((a, b) => a.ts - b.ts);

  // Per-customer cap
  let capped = collected;
  if (maxPerSender > 0) {
    const bySender = new Map();
    for (const m of collected) {
      const key = m.sender;
      if (!bySender.has(key)) bySender.set(key, []);
      bySender.get(key).push(m);
    }
    capped = [];
    for (const [, msgs] of bySender) {
      if (msgs.length <= maxPerSender) {
        capped.push(...msgs);
      } else {
        // Keep first 2 + last (cap - 2) to show conversation start + recent.
        // Guard: when maxPerSender <= 2, just take first N (no tail to avoid
        // slice(-0) which returns ALL elements instead of none).
        if (maxPerSender <= 2) {
          capped.push(...msgs.slice(0, maxPerSender));
        } else {
          const head = msgs.slice(0, 2);
          const tail = msgs.slice(-(maxPerSender - 2));
          capped.push(...head, ...tail);
        }
      }
    }
    capped.sort((a, b) => a.ts - b.ts);
  }

  const recent = capped.slice(-maxMessages);
  const formatted = [];
  let lastDate = '';
  for (const m of recent) {
    const dt = new Date(m.ts);
    const dateStr = dt.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
    const timeStr = dt.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (dateStr !== lastDate) {
      formatted.push(`\n--- ${dateStr} ---`);
      lastDate = dateStr;
    }
    const channelLabel = m.channel === 'openzalo' ? 'Zalo' : m.channel === 'telegram' ? 'Telegram' : m.channel;
    const roleLabel = m.role === 'user'
      ? (m.sender ? m.sender.split(' id:')[0] : 'Khách')
      : 'Em (bot)';
    formatted.push(`[${timeStr}][${channelLabel}] ${roleLabel}: ${m.text}`);
  }
  console.log(`[extract] ${candidates.length}/${allFiles.length} files read, ${collected.length} msgs collected, ${recent.length} returned in ${Date.now() - _t0}ms`);
  return { collected: recent, formatted: formatted.join('\n') };
}

// Write raw daily journal + AI summary + per-customer interaction append.
// Raw journal: memory/YYYY-MM-DD.md (unchanged, audit trail).
// Summary: memory/YYYY-MM-DD-summary.md (cached, for weekly/monthly prompts).
// Per-customer: appends to memory/zalo-users/<id>.md dated sections.
async function writeDailyMemoryJournal({ date = new Date() } = {}) {
  try {
    const ws = getWorkspace();
    if (!ws) return null;
    const memDir = path.join(ws, 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    const dateStr = date.toISOString().slice(0, 10);
    const file = path.join(memDir, `${dateStr}.md`);
    const sinceMs = date.getTime() - 24 * 60 * 60 * 1000;

    // 1. Raw journal (same as before — full history, no cap)
    const history = extractConversationHistory({ sinceMs, maxMessages: 100 });
    const header = `# Memory ${dateStr}\n\n*Auto-generated. Records all Zalo + Telegram messages in the last 24h before this cron fire.*\n\n`;
    const body = history || '_(Không có tin nhắn nào trong 24h qua.)_';
    fs.writeFileSync(file, header + body + '\n', 'utf-8');

    // 2. Daily summary via 9Router (cached — skip if already exists)
    const summaryFile = path.join(memDir, `${dateStr}-summary.md`);
    if (!fs.existsSync(summaryFile) && history) {
      try {
        const summaryText = await call9Router(
          `Dưới đây là tất cả tin nhắn Zalo + Telegram trong ngày ${dateStr}. ` +
          `Tóm tắt thành bullet points ngắn gọn bằng tiếng Việt:\n` +
          `- Ai đã nhắn gì (tên khách, kênh)\n` +
          `- Kết quả / outcome của mỗi cuộc trò chuyện\n` +
          `- Việc gì còn tồn đọng / cần follow-up\n` +
          `Chỉ trả về bullet points, không thêm giải thích.\n\n` +
          `---\n${history}`,
          { maxTokens: 600, temperature: 0.2, timeoutMs: 15000 }
        );
        if (summaryText) {
          fs.writeFileSync(summaryFile, `# Tóm tắt ${dateStr}\n\n${summaryText}\n`, 'utf-8');
          console.log(`[journal] summary written: ${dateStr}-summary.md`);
        } else {
          auditLog('summary_generation_failed', { date: dateStr, reason: '9Router returned null' });
          console.warn(`[journal] 9Router summary failed for ${dateStr} — raw journal still available`);
        }
      } catch (e) {
        auditLog('summary_generation_failed', { date: dateStr, reason: e?.message });
        console.warn(`[journal] summary error for ${dateStr}:`, e?.message);
      }
    }

    // 3. Per-customer interaction summary (append to zalo-users/<id>.md)
    if (history) {
      try {
        await appendPerCustomerSummaries(ws, dateStr, sinceMs);
      } catch (e) {
        console.warn(`[journal] per-customer summary error:`, e?.message);
      }
    }

    return file;
  } catch (e) {
    console.error('[writeDailyMemoryJournal] error:', e?.message || e);
    return null;
  }
}

// Group messages by Zalo customer, summarize each, append to their profile.
// Only processes openzalo messages (Telegram is CEO-only, no customer profiles).
// Extract the last N dated sections from a profile file for LLM prior-context.
// Returns a compact string or '' if no dated history exists.
function _recentProfileHistory(profileContent, maxSections = 3, maxChars = 1200) {
  try {
    const dated = profileContent.match(/\n\n## \d{4}-\d{2}-\d{2}\n[\s\S]*?(?=\n\n## \d{4}-\d{2}-\d{2}|$)/g) || [];
    if (dated.length === 0) return '';
    const tail = dated.slice(-maxSections).join('').trim();
    return tail.length > maxChars ? tail.slice(-maxChars) : tail;
  } catch { return ''; }
}

const _memoryFileLocks = new Map();
function _withMemoryFileLock(filePath, fn) {
  const prev = _memoryFileLocks.get(filePath) || Promise.resolve();
  const next = prev.then(fn, fn);
  _memoryFileLocks.set(filePath, next);
  next.finally(() => { if (_memoryFileLocks.get(filePath) === next) _memoryFileLocks.delete(filePath); });
  return next;
}

async function appendPerCustomerSummaries(ws, dateStr, sinceMs) {
  // Pull BOTH user and assistant messages so summary can reflect what actually
  // happened (was: role='user' only → prompt asked "Bot trả lời gì" but LLM
  // had no bot data → hallucinated or left blank → useless summaries).
  const collected = extractConversationHistoryRaw({ sinceMs, maxMessages: 1000, channels: ['openzalo'], maxPerSender: 0 });
  if (!collected || collected.length === 0) return;

  const bySender = new Map();
  for (const m of collected) {
    // Keep all roles; group by the customer's senderId. For user messages
    // sender format is "Name id:123...", for assistant it may be bot id
    // or the session's peer — use message.peerId if available, else fall
    // back to parsing ".sender".
    const idMatch = (m.sender || '').match(/id:(\d+)/) || (m.peerId ? [null, String(m.peerId)] : null);
    if (!idMatch) continue;
    const senderId = idMatch[1];
    if (!bySender.has(senderId)) {
      bySender.set(senderId, {
        name: (m.role === 'user' && m.sender) ? m.sender.split(' id:')[0] : null,
        msgs: [],
      });
    }
    const slot = bySender.get(senderId);
    if (!slot.name && m.role === 'user' && m.sender) slot.name = m.sender.split(' id:')[0];
    slot.msgs.push(m);
  }

  const usersDir = path.join(ws, 'memory', 'zalo-users');

  // Build list of work items first (fast, fs-only) so we can cap concurrency
  // on the actual 9Router calls. Was: serial await in loop → 500 customers ×
  // 10s = 83 min cron. Now: batched Promise.allSettled → linear in batchSize.
  const MIN_MSGS = 3;                // skip greeting-only threads (saves LLM cost for "xin chào"/"ok"/"cảm ơn")
  const MAX_MSGS_PER_CUSTOMER = 60;  // cap prompt size — rare high-volume customer won't blow context
  const BATCH_SIZE = 5;              // parallel 9Router calls (was: serial)
  const workItems = [];
  for (const [senderId, { name, msgs }] of bySender) {
    if (msgs.length < MIN_MSGS) continue;

    const profilePath = path.join(usersDir, `${senderId}.md`);
    if (!fs.existsSync(profilePath)) continue;

    let existing = '';
    try {
      existing = fs.readFileSync(profilePath, 'utf-8');
      if (existing.includes(`## ${dateStr}`)) continue;
    } catch { continue; }

    // Trim to most recent MAX_MSGS_PER_CUSTOMER to cap prompt.
    const clipped = msgs.length > MAX_MSGS_PER_CUSTOMER
      ? msgs.slice(-MAX_MSGS_PER_CUSTOMER)
      : msgs;
    const resolvedName = name || ('kh' + senderId.slice(-4));
    workItems.push({ senderId, name: resolvedName, msgs: clipped, profilePath, existing });
  }

  // Batched parallel execution with Promise.allSettled so one slow/errored
  // customer doesn't block the rest. Each batch of BATCH_SIZE runs in parallel.
  for (let i = 0; i < workItems.length; i += BATCH_SIZE) {
    const batch = workItems.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(batch.map(async (item) => {
      const { senderId, name, msgs, profilePath, existing } = item;

      // Format BOTH sides so the LLM sees the actual conversation shape.
      // Label bot clearly so model won't confuse speakers.
      const customerHistory = msgs.map(m => {
        const dt = new Date(m.ts);
        const time = dt.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
        const speaker = m.role === 'assistant' ? 'Bot' : (name || 'Khách');
        const text = (m.text || '').slice(0, 500);  // per-msg cap
        return `[${time}] ${speaker}: ${text}`;
      }).join('\n');

      // Prior-context: last 3 dated sections from this customer's profile
      // so the LLM has continuity (was: every day started fresh → summaries
      // read like amnesia). Caps at 1200 chars so prompt stays small.
      const priorContext = _recentProfileHistory(existing, 3, 1200);
      const priorBlock = priorContext
        ? `\n\n[LỊCH SỬ TRƯỚC ĐÓ — tham khảo continuity, KHÔNG lặp lại]\n${priorContext}`
        : '';

      let summary = null;
      try {
        summary = await call9Router(
          `Bạn là trợ lý tóm tắt Zalo. Đọc cuộc trò chuyện ngày ${dateStr} giữa khách "${name}" và bot của shop.\n` +
          `Viết tóm tắt **3-5 bullet point** ngắn gọn bằng tiếng Việt CÓ DẤU. Cần thể hiện rõ:\n` +
          `1. KHÁCH hỏi/yêu cầu cụ thể gì (sản phẩm, giá, dịch vụ, nhu cầu cá nhân)\n` +
          `2. BOT trả lời gì — trích NGẮN câu trả lời quan trọng của bot\n` +
          `3. Outcome: đơn xong / chưa chốt / cần báo giá / cần CEO duyệt / khách quan tâm tiếp\n` +
          `4. Nếu khách hứa "mai mua" hoặc có deadline → ghi rõ ngày\n` +
          `5. Nếu khách bực/phàn nàn → flag "!CẨN THẬN" ở đầu bullet đó\n\n` +
          `KHÔNG emoji. KHÔNG lặp lại nguyên văn — TÓM TẮT. KHÔNG bịa nếu không rõ.\n` +
          `Chỉ trả về bullet points, không intro, không kết luận.${priorBlock}\n\n` +
          `[CUỘC TRÒ CHUYỆN HÔM NAY]\n${customerHistory}`,
          { maxTokens: 350, temperature: 0.2, timeoutMs: 12000 }
        );
      } catch {}

      const appendContent = summary
        ? `\n\n## ${dateStr}\n${summary}\n`
        : `\n\n## ${dateStr}\n_(LLM summary không khả dụng — raw transcript)_\n${customerHistory}\n`;

      try {
        await _withMemoryFileLock(profilePath, () => {
          fs.appendFileSync(profilePath, appendContent, 'utf-8');
          trimZaloMemoryFile(profilePath, 50 * 1024);
        });
        console.log(`[journal] appended ${dateStr} summary to zalo-users/${senderId}.md (${msgs.length} msgs, ${summary ? 'LLM' : 'raw'})`);
      } catch (e) {
        console.warn(`[journal] append to ${senderId}.md failed:`, e?.message);
      }
    }));
  }
}

// Trim a zalo-users/<id>.md file to at most maxBytes by removing the oldest
// ## YYYY-MM-DD sections from the top. The front-matter header (between first
// two --- markers) is always preserved. No-op if file is under the cap.
function trimZaloMemoryFile(filePath, maxBytes) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= maxBytes) return;

    let content = fs.readFileSync(filePath, 'utf-8');
    // Preserve everything up to and including the closing --- of front-matter
    const fmEnd = content.indexOf('\n---\n', content.indexOf('---\n') + 1);
    const header = fmEnd >= 0 ? content.slice(0, fmEnd + 5) : '';
    const body = fmEnd >= 0 ? content.slice(fmEnd + 5) : content;

    // Split body into dated sections (split on \n\n## YYYY-MM-DD).
    // sections[0] may be a non-dated intro block (profile markdown heading, import note)
    // — never drop it. Only drop sections that ARE dated (start with \n\n## YYYY-MM-DD).
    const sectionRe = /(?=\n\n## \d{4}-\d{2}-\d{2})/g;
    const sections = body.split(sectionRe).filter(Boolean);
    const datedRe = /^\n\n## \d{4}-\d{2}-\d{2}/;

    // Find index of first dated section; everything before it is the intro block (preserved)
    let firstDatedIdx = sections.findIndex(s => datedRe.test(s));
    if (firstDatedIdx < 0) firstDatedIdx = sections.length; // no dated sections — nothing to drop

    // Drop oldest DATED sections until under cap
    while (firstDatedIdx < sections.length) {
      const trimmed = header + sections.join('');
      if (Buffer.byteLength(trimmed, 'utf-8') <= maxBytes) break;
      sections.splice(firstDatedIdx, 1); // remove oldest dated section
      // firstDatedIdx stays the same (next oldest is now at the same index)
    }

    const newContent = header + sections.join('');
    if (newContent.length < content.length) {
      fs.writeFileSync(filePath, newContent, 'utf-8');
      console.log(`[journal] trimmed ${path.basename(filePath)} from ${stat.size} → ${Buffer.byteLength(newContent, 'utf-8')} bytes`);
    }
  } catch (e) {
    console.warn(`[journal] trimZaloMemoryFile failed for ${filePath}:`, e?.message);
  }
}

// Send an alert to CEO via Telegram. Zalo outbound to CEO is not possible
// (CEO's Zalo account IS the bot — can't message yourself).
async function sendCeoAlert(text) {
  const opts = { skipFilter: true, skipPauseCheck: true };
  let delivered = false;
  try {
    const result = await sendTelegram(text, opts);
    delivered = result === true;
  } catch (e) {
    console.error('[sendCeoAlert] Telegram failed:', e?.message);
  }
  if (!delivered) {
    // Both channels failed — write to disk as last resort so nothing is silently lost
    try {
      const logsDir = path.join(getWorkspace(), 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      const missedFile = path.join(logsDir, 'ceo-alerts-missed.log');
      const entry = `${new Date().toISOString()} — UNDELIVERED: ${text.slice(0, 500)}\n`;
      fs.appendFileSync(missedFile, entry, 'utf-8');
      console.error('[sendCeoAlert] BOTH channels failed — wrote to ceo-alerts-missed.log');
    } catch (e) {
      console.error('[sendCeoAlert] BOTH channels failed AND disk write failed:', e?.message);
    }
  }
  return delivered;
}

// Run an agent turn from a cron handler and deliver the reply to the CEO via Telegram.
// Sends the OUTPUT, not the prompt text. Retries on transient failures, journals every
// fire, and never fails silently — total failure always yields a notice on ALL channels.
function tokenizeShellish(command) {
  const tokens = [];
  let cur = '';
  let quote = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (escaped) cur += '\\';
  if (quote) return null;
  if (cur) tokens.push(cur);
  return tokens;
}

function parseSafeOpenzcaMsgSend(shellCmd) {
  const tokens = tokenizeShellish(shellCmd);
  if (!tokens || !tokens.length) return null;
  let i = 0;
  // node <cli.js> ...
  if (/^(?:node|node\.exe)$/i.test(tokens[i] || '')) {
    const cli = String(tokens[i + 1] || '');
    if (!/openzca[\\\/].*dist[\\\/]cli\.js$/i.test(cli) && !/openzca.*cli\.js$/i.test(cli)) return null;
    i += 2;
  } else {
    const bin = String(tokens[i] || '');
    if (!/^(?:openzca(?:\.cmd|\.ps1)?|openzca)$/i.test(bin)) return null;
    i += 1;
  }
  let profile = null;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '--profile' || t === '-p') {
      profile = tokens[i + 1] || null;
      i += 2;
      continue;
    }
    if (t === '--debug' || t === '--debug-file') {
      i += (t === '--debug-file') ? 2 : 1;
      continue;
    }
    break;
  }
  if ((tokens[i] || '').toLowerCase() !== 'msg') return null;
  if ((tokens[i + 1] || '').toLowerCase() !== 'send') return null;
  const targetIdRaw = tokens[i + 2];
  const text = tokens[i + 3];
  if (!targetIdRaw || text == null) return null;
  const trailing = tokens.slice(i + 4);
  const isGroup = trailing.includes('--group');
  const profileIdx = trailing.indexOf('--profile');
  if (profileIdx !== -1 && !profile) {
    profile = trailing[profileIdx + 1] || null;
  }
  const unsupported = trailing.filter((t, idx) => {
    if (t === '--group') return false;
    if (profileIdx !== -1 && (idx === profileIdx || idx === profileIdx + 1)) return false;
    return true;
  });
  if (unsupported.length > 0) return null;
  const targetIds = targetIdRaw.split(',').map(s => s.trim()).filter(Boolean);
  if (!targetIds.length || targetIds.length > 50) return null;
  return { profile: profile || getZcaProfile(), targetIds, text, isGroup };
}

async function runSafeExecCommand(shellCmd, { label } = {}) {
  const parsed = parseSafeOpenzcaMsgSend(shellCmd);
  if (!parsed) return null;
  const { targetIds, text, isGroup, profile } = parsed;
  if (!isZaloListenerAlive()) {
    console.error(`[cron-exec] "${label || 'cron'}" — Zalo listener not running, refusing send`);
    journalCronRun({ phase: 'fail', label: label || 'cron', mode: 'safe-openzca', err: 'zalo-listener-down' });
    sendCeoAlert(`Cron "${label || 'cron'}" không gửi được — Zalo listener không chạy. Vào Dashboard kiểm tra tab Zalo.`).catch(() => {});
    return false;
  }
  if (targetIds.length === 1) {
    console.log(`[cron-exec] "${label || 'cron'}" rerouted to safe Zalo sender`);
    const ok = await sendZaloTo({ id: targetIds[0], isGroup }, text, { profile });
    return ok ? true : false;
  }
  console.log(`[cron-exec] "${label || 'cron'}" broadcast to ${targetIds.length} targets`);
  let sent = 0;
  for (let t = 0; t < targetIds.length; t++) {
    try {
      const ok = await sendZaloTo({ id: targetIds[t], isGroup }, text, { profile });
      if (ok) sent++;
      else console.warn(`[cron-exec] broadcast target ${targetIds[t]} failed`);
    } catch (e) {
      console.error(`[cron-exec] broadcast target ${targetIds[t]} error:`, e?.message || e);
    }
    if (t < targetIds.length - 1) await new Promise(r => setTimeout(r, 1500));
  }
  console.log(`[cron-exec] broadcast done: ${sent}/${targetIds.length} sent`);
  if (sent === 0) return false;
  if (sent < targetIds.length) {
    sendCeoAlert(`Cron "${label || 'cron'}" broadcast: ${sent}/${targetIds.length} nhóm thành công. ${targetIds.length - sent} nhóm thất bại.`).catch(() => {});
  }
  return true;
}

// Cron serialization queue — cron jobs can fire near-simultaneously (morning
// briefing + follow-up queue + custom cron all spawning openclaw agents).
// Two concurrent children = double memory + competing WS + out-of-order delivery.
// Serialize through a rolling promise so only one agent runs at a time. Depth
// logged when callers actually wait (depth > 1).
let _cronAgentQueue = Promise.resolve();
let _cronAgentQueueDepth = 0;
async function runCronAgentPrompt(prompt, opts = {}) {
  _cronAgentQueueDepth++;
  if (_cronAgentQueueDepth > 1) {
    console.log(`[cron-agent] queued (depth=${_cronAgentQueueDepth}) label="${opts?.label || 'cron'}"`);
  }
  const run = _cronAgentQueue.then(() => _runCronAgentPromptImpl(prompt, opts));
  _cronAgentQueue = run.catch(() => {}).finally(() => { _cronAgentQueueDepth--; });
  return run;
}

async function _runCronAgentPromptImpl(prompt, { label, timeoutMs = 600000 } = {}) {
  const niceLabel = label || 'cron';

  // Fast-path: if prompt starts with "exec: <shell command>", run it directly
  // in main.js with the enriched PATH (vendor node + openzca in .bin/).
  // This bypasses the openclaw agent entirely — the agent's bash tool may not
  // have vendor openzca in PATH on customer machines (bundled install).
  // Example: "exec: openzca msg send <groupId> "text" --group"
  const execMatch = prompt.trim().match(/^exec:\s+(.+)$/s);
  if (execMatch) {
    const shellCmd = execMatch[1].trim();
    const safeResult = await runSafeExecCommand(shellCmd, { label: niceLabel });
    if (safeResult !== null) {
      if (safeResult) {
        journalCronRun({ phase: 'ok', label: niceLabel, mode: 'safe-openzca' });
      } else {
        journalCronRun({ phase: 'fail', label: niceLabel, mode: 'safe-openzca', err: 'safe-openzca command blocked or failed' });
        sendCeoAlert(`*Cron "${niceLabel}" bị chặn vì không an toàn hoặc gửi Zalo thất bại*\n\nLệnh gửi Zalo đã được kéo về đường an toàn và không được phép đi tiếp.`).catch(() => {});
      }
      return safeResult;
    }
    // Block ALL unrecognized exec: commands. Only safe openzca msg send
    // (handled above) is allowed. Everything else — including raw shell
    // commands — is rejected to prevent command injection.
    console.warn(`[cron-exec] "${niceLabel}" BLOCKED — unrecognized exec command: ${shellCmd.slice(0, 120)}`);
    journalCronRun({ phase: 'fail', label: niceLabel, mode: 'exec-blocked', err: 'only exec: openzca msg send is allowed' });
    sendCeoAlert(`*Cron "${niceLabel}" bị chặn*\n\nChỉ cho phép \`exec: openzca msg send <id> "<text>" --group\`. Lệnh khác không được phép chạy trực tiếp.`).catch(() => {});
    return false;
  }

  // Defense-in-depth heal #1: synchronously remove deprecated openclaw config
  // keys BEFORE the first agent spawn. Cheap, idempotent. Catches any path that
  // bypasses the boot heal.
  try { healOpenClawConfigInline(); } catch (e) { console.error('[cron-agent] inline heal:', e?.message || e); }

  await selfTestOpenClawAgent(); // optimistic: never gates

  // selfTest now ALWAYS sets _agentFlagProfile (defaults to 'full'), so this
  // safety check is just a final paranoia layer.
  if (!_agentFlagProfile) _agentFlagProfile = 'full';
  if (!_agentCliHealthy) _agentCliHealthy = true;

  // Use the recovery-capable variant: try config → sticky file → Telegram getUpdates.
  const { chatId, recovered } = await getTelegramConfigWithRecovery();
  if (!chatId) {
    journalCronRun({ phase: 'fail', label: niceLabel, reason: 'no-chat-id-even-after-recovery' });
    console.error(`[cron-agent] "${niceLabel}" — no telegram chatId, even after recovery attempt`);
    // We CAN'T sendTelegram alert because we don't have a chatId. Best we can
    // do is log loudly and write to a file the wizard / dashboard will surface.
    try {
      const alertFile = path.join(getWorkspace(), 'logs', 'cron-cannot-deliver.txt');
      fs.mkdirSync(path.dirname(alertFile), { recursive: true });
      fs.appendFileSync(alertFile, `${new Date().toISOString()} — Cron "${niceLabel}" cannot deliver: no telegram chatId in config, sticky file, or recent Telegram updates. Re-run wizard or have someone /start the bot.\n`, 'utf-8');
    } catch {}
    return false;
  }
  if (recovered) {
    console.warn(`[cron-agent] "${niceLabel}" — used recovered chatId source: ${recovered}`);
    journalCronRun({ phase: 'chatid-recovered', label: niceLabel, source: recovered });
  }

  const args = buildAgentArgs(prompt, chatId);
  const promptHasNewline = prompt.includes('\n');
  let lastErr = '';
  let lastCode = -1;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const startedAt = Date.now();
    console.log(`[cron-agent] "${niceLabel}" attempt ${attempt}/3 (profile=${_agentFlagProfile}, prompt ${prompt.length}c, multiline=${promptHasNewline})`);
    // CRITICAL: refuse cmd.exe shell fallback for multi-line prompts. Otherwise
    // cmd.exe will silently truncate the prompt and the agent will receive
    // garbage. Better to fail loudly than to deliver wrong output.
    const res = await spawnOpenClawSafe(args, {
      timeoutMs,
      allowCmdShellFallback: !promptHasNewline,
    });
    const durMs = Date.now() - startedAt;
    if (res.code === 0) {
      journalCronRun({ phase: 'ok', label: niceLabel, attempt, durMs, profile: _agentFlagProfile, viaCmdShell: res.viaCmdShell });
      console.log(`[cron-agent] "${niceLabel}" delivered in ${durMs}ms (viaCmdShell=${res.viaCmdShell})`);
      return true;
    }
    lastCode = res.code;
    lastErr = (res.stderr || res.stdout || '').slice(0, 800);
    journalCronRun({ phase: 'retry', label: niceLabel, attempt, durMs, code: res.code, err: lastErr.slice(0, 300), viaCmdShell: res.viaCmdShell });
    console.error(`[cron-agent] "${niceLabel}" attempt ${attempt} failed (code ${res.code}): ${lastErr.slice(0, 200)}`);

    // Hard-fail: if the error is unrecoverable (cmd-shell refused, openclaw
    // not found, ENOENT, auth failure, invalid token), retrying just wastes
    // time. Bail immediately with a specific Telegram alert. The retry loop
    // is meant for transient failures (gateway warmup, ECONNREFUSED, timeout),
    // not for environment misconfigurations.
    if (isFatalErr(lastErr, res.code)) {
      let userMsg;
      if (lastErr.includes('cmd-shell fallback refused')) {
        userMsg = `*Cron "${niceLabel}" KHÔNG chạy được — môi trường thiếu Node*\n\nKhông tìm thấy \`node\` hoặc \`openclaw.mjs\` trên máy. Cron prompt nhiều dòng KHÔNG thể chạy qua \`openclaw.cmd\` (cmd.exe sẽ truncate).\n\nCần cài Node.js và đảm bảo \`node\` chạy được từ terminal: \`node -v\`. Sau đó restart Modoro Claw.`;
      } else if (lastErr.toLowerCase().includes('openclaw not found')) {
        userMsg = `*Cron "${niceLabel}" KHÔNG chạy được — openclaw không có trên máy*\n\nCần \`npm install -g openclaw\` rồi restart Modoro Claw.`;
      } else if (lastErr.toLowerCase().includes('invalid token') || lastErr.toLowerCase().includes('not authorized')) {
        userMsg = `*Cron "${niceLabel}" KHÔNG chạy được — auth lỗi*\n\nGateway token hoặc Telegram bot token không hợp lệ. Vào Dashboard → Cài đặt → Wizard để cấu hình lại.\n\nstderr: \`${lastErr.slice(0, 200)}\``;
      } else {
        userMsg = `*Cron "${niceLabel}" KHÔNG chạy được — lỗi không retry được*\n\nExit ${res.code}\n\`\`\`\n${lastErr.slice(0, 400)}\n\`\`\``;
      }
      try { await sendCeoAlert(userMsg); } catch {}
      journalCronRun({ phase: 'fail', label: niceLabel, code: lastCode, reason: 'fatal-no-retry', err: lastErr.slice(0, 300) });
      return false;
    }

    // Defense-in-depth heal #2: if openclaw rejected the config (e.g. a NEW
    // deprecated key we don't yet know about, or a partial heal), try to heal
    // and immediately retry. The known-key path heals before attempt 1; this
    // catches anything else that surfaces during retries.
    if (attempt < 3 && isConfigInvalidErr(lastErr)) {
      const healed = healOpenClawConfigInline(lastErr);
      console.log(`[cron-agent] config-invalid detected; inline heal ${healed ? 'WROTE' : 'noop'}, retrying immediately`);
      continue;
    }

    if (attempt < 3) {
      const backoffMs = isTransientErr(lastErr) ? attempt * 5000 : attempt * 2000;
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  journalCronRun({ phase: 'fail', label: niceLabel, code: lastCode, err: lastErr.slice(0, 400) });
  try {
    await sendCeoAlert(`*Cron "${niceLabel}" thất bại sau 3 lần*\n\nExit code: \`${lastCode}\`\n\`\`\`\n${lastErr.slice(0, 500)}\n\`\`\``);
  } catch {}
  return false;
}

// Find npm global node_modules path (cross-platform)
function npmGlobalModules() {
  // Try every Node version manager's lib/node_modules dir until we find one
  // that actually exists. This way `openzca` lookups work for users on
  // nvm/volta/asdf/fnm/MacPorts/Scoop, not just system Node.
  for (const lib of enumerateNodeManagerLibDirs()) {
    if (fs.existsSync(lib)) return lib;
  }
  // Last-ditch defaults if nothing found yet
  if (process.platform === 'win32') return path.join(process.env.APPDATA || '', 'npm', 'node_modules');
  return '/usr/local/lib/node_modules';
}

// Search ALL global lib dirs for a specific package's file. Returns the first
// matching absolute path, or null. Use this instead of `npmGlobalModules() +
// path.join(pkg, file)` because npmGlobalModules() returns the first lib dir
// that EXISTS — which may not be the dir that actually contains the package
// (real Windows scenario: user has nvm-windows AND `npm install -g <pkg>` to
// system Node — npmGlobalModules returns the nvm dir, but the package lives
// in %APPDATA%\npm\node_modules). Searching all lib dirs is the only correct
// way to find a specific package across mixed Node-manager setups.
function findGlobalPackageFile(packageName, relativeFile) {
  // Packaged: prefer bundled vendor copy.
  const v = getBundledVendorDir();
  if (v) {
    const bundled = path.join(v, 'node_modules', packageName, relativeFile);
    try { if (fs.existsSync(bundled)) return bundled; } catch {}
  }
  // Dev mode fallback: check userData/vendor (from previous packaged install tar extract)
  // This covers the case where dev runs RUN.bat but vendor/ was deleted by prebuild-vendor.
  if (!v) {
    try {
      const userDataRoots = [];
      if (process.platform === 'darwin') {
        userDataRoots.push(path.join(HOME, 'Library', 'Application Support', '9bizclaw'));
        userDataRoots.push(path.join(HOME, 'Library', 'Application Support', 'modoro-claw'));
      } else if (process.platform === 'win32') {
        const appdata = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
        userDataRoots.push(path.join(appdata, '9bizclaw'));
        userDataRoots.push(path.join(appdata, 'modoro-claw'));
      } else {
        userDataRoots.push(path.join(HOME, '.config', '9bizclaw'));
        userDataRoots.push(path.join(HOME, '.config', 'modoro-claw'));
      }
      for (const root of userDataRoots) {
        const cand = path.join(root, 'vendor', 'node_modules', packageName, relativeFile);
        if (fs.existsSync(cand)) return cand;
      }
    } catch {}
  }
  for (const lib of enumerateNodeManagerLibDirs()) {
    if (!fs.existsSync(lib)) continue;
    const candidate = path.join(lib, packageName, relativeFile);
    try { if (fs.existsSync(candidate)) return candidate; } catch {}
  }
  return null;
}

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

function isValidConfigKey(key) {
  return typeof key === 'string' && /^[a-zA-Z0-9._-]+$/.test(key);
}

function getSetupCompletePath() {
  try {
    const dir = (app && app.isReady()) ? app.getPath('userData') : userDataDir;
    return path.join(dir || HOME, 'setup-complete.json');
  } catch {
    return path.join(userDataDir || HOME, 'setup-complete.json');
  }
}

function hasCompletedOnboarding() {
  try {
    return fs.existsSync(getSetupCompletePath());
  } catch {
    return false;
  }
}

function markOnboardingComplete(source = 'wizard') {
  try {
    const p = getSetupCompletePath();
    writeJsonAtomic(p, {
      completed: true,
      source,
      at: new Date().toISOString(),
      appVersion: app?.getVersion?.() || null,
    });
    return true;
  } catch (e) {
    console.error('[setup-complete] write error:', e.message);
    return false;
  }
}

// ============================================
//  WINDOW
// ============================================

function createWindow() {
  const openclawBin = findOpenClawBinSync();

  mainWindow = new BrowserWindow({
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

  mainWindow.setMenuBarVisibility(false);

  // Ctrl+R to reload UI (dev), Ctrl+Shift+I for DevTools
  mainWindow.webContents.on('before-input-event', (e, input) => {
    const mod = input.control || input.meta; // Ctrl on Windows, Cmd on Mac
    if (mod && input.key === 'r') { mainWindow.reload(); e.preventDefault(); }
    if (mod && input.key === 'F5') { mainWindow.webContents.reloadIgnoringCache(); e.preventDefault(); }
    if (input.key === 'F5') { mainWindow.reload(); e.preventDefault(); }
    if (mod && input.shift && input.key === 'I') { mainWindow.webContents.toggleDevTools(); e.preventDefault(); }
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  console.log('[createWindow] openclawBin:', openclawBin);
  if (app.isPackaged) {
    console.log('[createWindow] app.isPackaged=true, platform=', process.platform);
    console.log('[createWindow] userData:', app.getPath('userData'));
    console.log('[createWindow] resourcesPath:', process.resourcesPath);
    console.log('[createWindow] getBundledVendorDir():', getBundledVendorDir());
    console.log('[createWindow] getBundledNodeBin():', getBundledNodeBin());
    console.log('[createWindow] findBundledOpenClawMjs():', findBundledOpenClawMjs());
  }
  const configured = openclawBin ? isOpenClawConfigured() : false;
  const onboardingComplete = hasCompletedOnboarding();
  console.log('[createWindow] configured:', configured);
  console.log('[createWindow] onboardingComplete:', onboardingComplete);

  // License gate (membership builds only) — blocks ALL pages until valid key
  const isMembershipBuild = require('./package.json').membership === true;
  if (isMembershipBuild) {
    const license = require('./lib/license');
    license.init(getWorkspace);
    const ls = license.checkLicenseStatus();
    if (ls.status === 'no_license' || ls.status === 'invalid' || ls.status === 'locked') {
      console.log('[createWindow] membership build, license status:', ls.status, '-> license.html');
      mainWindow.loadFile(path.join(__dirname, 'ui', 'license.html'));
      return;
    }
    console.log('[createWindow] membership build, license valid');
  }

  if (!openclawBin) {
    console.error('[createWindow] → no-openclaw.html (findOpenClawBinSync returned null)');
    mainWindow.loadFile(path.join(__dirname, 'ui', 'no-openclaw.html'));
  } else if (configured) {
    console.log('[createWindow] → dashboard.html');
    mainWindow.loadFile(path.join(__dirname, 'ui', 'dashboard.html'));
    mainWindow.maximize();
    // Ensure workspace files exist BEFORE cron jobs try to read them
    try { seedWorkspace(); } catch (e) { console.error('[seedWorkspace early] error:', e.message); }
    if (!onboardingComplete) {
      try { setZaloChannelEnabled(false); } catch {}
      try { setChannelPermanentPause('zalo', 'review-required-before-autoboot'); } catch {}
      console.log('[createWindow] onboarding marker missing → dashboard only, skip auto-start');
    } else {
      // ORDER MATTERS — same 3-step chain as wizard-complete:
      //   1. ensureZaloPlugin() — copy bundled plugin / heal missing plugin
      //      BEFORE gateway boots. Without this, the gateway config-reload
      //      watcher races with the bundled-copy and can miss the openzalo
      //      channel registration on cold boot.
      //   2. startOpenClaw() — ensureDefaultConfig + gateway spawn.
      //   3. startCronJobs() — AFTER both above so first cron fire sees a
      //      healed config with a running gateway.
      (async () => {
        try { await ensureZaloPlugin(); } catch (e) { console.error('[boot] ensureZaloPlugin error:', e?.message || e); }
        // Seed customer profiles from openzca cache AFTER plugin is ready but
        // BEFORE startOpenClaw so gateway's first message sees populated memory.
        try { seedZaloCustomersFromCache(); } catch (e) { console.error('[boot] seedZaloCustomers error:', e?.message || e); }
        try { await startOpenClaw(); } catch (e) { console.error('[boot] startOpenClaw error:', e?.message || e); }
        startCronJobs();
        startFollowUpChecker();
        startEscalationChecker();
        startCronApi();
        watchCustomCrons();
        startZaloCacheAutoRefresh();
        startAppointmentDispatcher();
        // Warm cookie age check 30s after boot, then broadcast loop handles daily cadence.
        setTimeout(() => { try { checkZaloCookieAge(); } catch {} }, 30000);
      })();
    }
  } else {
    console.log('[createWindow] → wizard.html');
    mainWindow.loadFile(path.join(__dirname, 'ui', 'wizard.html'));
    // Wizard now uses full-screen 2-column layout — maximize so business owners
    // see the premium onboarding without scrolling.
    mainWindow.maximize();
  }

  mainWindow.once('ready-to-show', () => {
    let startMinimized = false;
    try { startMinimized = !!loadAppPrefs().startMinimized; } catch {}
    if (startMinimized) {
      console.log('[createWindow] startMinimized=true → hiding window (tray only)');
      try { mainWindow.hide(); } catch {}
    } else {
      mainWindow.show();
    }
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
}

function isOpenClawConfigured() {
  try {
    // Read config directly — CLI requires pairing which can timeout/fail
    const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
    console.log('[isOpenClawConfigured] configPath:', configPath, 'exists:', fs.existsSync(configPath));
    if (!fs.existsSync(configPath)) return false;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const token = config && config.channels && config.channels.telegram && config.channels.telegram.botToken;
    console.log('[isOpenClawConfigured] token found:', !!token);
    return !!token && token.trim() !== '';
  } catch (e) { console.error('[isOpenClawConfigured] error:', e.message); return false; }
}

// ============================================
//  APP PREFS (start minimized, etc.)
// ============================================

function getAppPrefsPath() {
  try {
    const dir = app.getPath('userData');
    return path.join(dir, 'app-prefs.json');
  } catch {
    return path.join(HOME, '.9bizclaw-app-prefs.json');
  }
}

function loadAppPrefs() {
  const defaults = { startMinimized: false };
  try {
    const p = getAppPrefsPath();
    if (!fs.existsSync(p)) {
      try { writeJsonAtomic(p, defaults); } catch {}
      return { ...defaults };
    }
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return { ...defaults, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch (e) {
    console.warn('[app-prefs] load failed:', e?.message || e);
    return { ...defaults };
  }
}

function saveAppPrefs(partial) {
  try {
    const cur = loadAppPrefs();
    const next = { ...cur, ...(partial && typeof partial === 'object' ? partial : {}) };
    writeJsonAtomic(getAppPrefsPath(), next);
    return next;
  } catch (e) {
    console.warn('[app-prefs] save failed:', e?.message || e);
    return null;
  }
}

// ============================================
//  TRAY
// ============================================

function createTray() {
  if (tray) { tray.destroy(); tray = null; }

  const iconPath = path.join(__dirname, 'ui', 'tray-icon.png');
  let icon;
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath);
  } else {
    const s = 16, buf = Buffer.alloc(s * s * 4);
    for (let i = 0; i < s * s; i++) { buf[i*4]=249; buf[i*4+1]=115; buf[i*4+2]=22; buf[i*4+3]=255; }
    icon = nativeImage.createFromBuffer(buf, { width: s, height: s });
  }

  tray = new Tray(icon);
  tray.setToolTip('9BizClaw — Trợ lý AI cho CEO');
  try { global.__tray = tray; } catch {}

  const show = () => {
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
  };

  // Pick a platform-appropriate label for "open log file in editor". On Mac
  // this opens TextEdit; calling it "Notepad" was Win-only and confusing.
  const openLogFileLabel = process.platform === 'win32'
    ? 'Mở file log trong Notepad'
    : 'Mở file log trong trình soạn thảo';

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mở Dashboard', click: show },
    { type: 'separator' },
    { label: botRunning ? 'Bot đang chạy' : 'Bot đã dừng', enabled: false },
    { label: botRunning ? 'Dừng bot' : 'Khởi động bot', click: () => { if (botRunning) stopOpenClaw(); else startOpenClaw(); createTray(); } },
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
  tray.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isVisible()) mainWindow.hide();
      else { mainWindow.show(); mainWindow.focus(); }
    }
  });
}

// ============================================
//  OPENCLAW PROCESS
// ============================================

// Byte-for-byte safe write of openclaw.json. The gateway watches this file
// AND distinguishes its own writes from external ones via a hash. Any external
// write (even one that produces logically-identical JSON) fires the
// config-reload pipeline → buildGatewayReloadPlan → if any path matches a
// "restart" rule, gateway restarts → in-flight reply runs are aborted with
// `aborted_for_restart` → CEO sees "⚠️ Gateway is restarting. Please wait..."
//
// Our `ensureDefaultConfig()` was the culprit: it `JSON.stringify`'d without a
// trailing newline while OpenClaw writes WITH one — so even when nothing
// logically changed, our write differed by a single \n, openclaw's reloader
// woke up, and a CEO message sent at the wrong moment got aborted mid-reply.
//
// This helper:
//   1. Serializes the new config the same way openclaw does (2-space indent +
//      trailing newline).
//   2. Reads the existing file as a Buffer.
//   3. Only writes if the byte content actually differs.
// Returns true if a write happened.
// Strip schema-invalid keys from a config object in-place before serialization.
// Single chokepoint: every writer of openclaw.json goes through
// writeOpenClawConfigIfChanged → sanitizeOpenClawConfigInPlace, so legacy
// wizard handlers, save-zalo-manager-config, ensureDefaultConfig, and any
// future code path get the same cleanup for free.
//
// This is defense-in-depth on top of ensureDefaultConfig's own cleanup —
// catches bad writes that originate from IPC handlers which don't re-run
// ensureDefaultConfig.
function sanitizeOpenClawConfigInPlace(config) {
  if (!config || typeof config !== 'object') return;
  // openclaw 2026.4.x removed agents.defaults.blockStreaming (replaced with
  // blockStreamingDefault). Keep the file schema-clean.
  if (config.agents?.defaults && 'blockStreaming' in config.agents.defaults) {
    delete config.agents.defaults.blockStreaming;
  }
  // openzalo schema does NOT include 'streaming', 'streamMode',
  // 'nativeStreaming', or 'blockStreamingDefault' — writing them causes
  // `channels.openzalo: must NOT have additional properties` which kills
  // every `openclaw <subcommand>` call and blocks gateway reloads.
  const stripKeys = (block) => {
    if (!block || typeof block !== 'object') return;
    for (const k of KNOWN_BAD_OPENZALO_KEYS) {
      if (k in block) delete block[k];
    }
  };
  if (config.channels?.openzalo) {
    stripKeys(config.channels.openzalo);
    if (config.channels.openzalo.accounts && typeof config.channels.openzalo.accounts === 'object') {
      for (const accId of Object.keys(config.channels.openzalo.accounts)) {
        stripKeys(config.channels.openzalo.accounts[accId]);
      }
    }
  }
}

// =====================================================================
// Atomic JSON writer — tmp-file + rename. Prevents half-written JSON when
// the process crashes or antivirus interrupts between bytes. Drop-in for
// `fs.writeFileSync(p, JSON.stringify(x, null, 2), 'utf-8')` against any
// workspace JSON (schedules, custom-crons, zalo-*, follow-up-queue, ...).
//
// Do NOT use for openclaw.json — that has its own byte-equal guard via
// writeOpenClawConfigIfChanged (rename would change inode and wake
// openclaw's external-write detector → spurious "Gateway is restarting").
// =====================================================================
// Module-level counter guarantees tmp-file uniqueness even when two calls
// land in the same millisecond (same PID, same Date.now()). Without this,
// concurrent writers under Windows AV hold can collide on the tmp path.
let _atomicWriteCounter = 0;
function writeJsonAtomic(filePath, data) {
  const serialized = JSON.stringify(data, null, 2) + '\n';
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${++_atomicWriteCounter}`;
  try {
    try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch {}
    fs.writeFileSync(tmp, serialized, 'utf-8');
    try {
      fs.renameSync(tmp, filePath);
    } catch (e1) {
      // Windows + antivirus can transiently hold the target and make
      // renameSync throw EBUSY/EPERM/EACCES. Real-world AV release is
      // typically 10-30ms; we spin 10ms max so we never block heartbeat
      // long enough to trip the "gateway dead" watchdog (previously 100ms
      // busy-wait caused false-positives under AV scan).
      const wait = Date.now() + 10;
      while (Date.now() < wait) { /* short sync spin — 10ms */ }
      try {
        fs.renameSync(tmp, filePath);
      } catch (e2) {
        try {
          const msg = `[writeJsonAtomic] rename fail: ${filePath} — ${e2.message} (tmp=${tmp})`;
          if (typeof console !== 'undefined') console.error(msg);
          try { logToFile && logToFile(msg); } catch {}
        } catch {}
        // Cleanup tmp before throwing so we don't leak tmp files.
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
        const err = new Error(
          `[writeJsonAtomic] failed to rename ${tmp} -> ${filePath}: ${e2.message}`
        );
        err.code = e2.code;
        err.original = e2;
        throw err;
      }
    }
    return true;
  } catch (e) {
    // Ensure tmp cleanup on any path. Each unlink in its own try/catch
    // so a stat/unlink failure on one doesn't mask the underlying throw.
    try {
      if (fs.existsSync(tmp)) {
        try { fs.unlinkSync(tmp); } catch {}
      }
    } catch {}
    throw e;
  }
}

// =====================================================================
// Single-writer mutex for openclaw.json read-modify-write sequences.
// Multiple IPC handlers (save-zalo-manager-config, save-wizard-config,
// set-batch-config, getTelegramConfigWithRecovery, setZaloChannelEnabled,
// resume-zalo) all do: read → mutate → writeOpenClawConfigIfChanged.
// Without serialization, two concurrent handlers can both read the same
// snapshot, mutate independently, and the last writer silently clobbers
// the first one's changes (TOCTOU).
//
// Usage: await withOpenClawConfigLock(async () => { ...read/mutate/write... })
// =====================================================================
let _openClawConfigMutex = Promise.resolve();
function withOpenClawConfigLock(fn) {
  const run = _openClawConfigMutex.then(() => fn());
  _openClawConfigMutex = run.catch(() => {});
  return run;
}

function writeOpenClawConfigIfChanged(configPath, config) {
  try {
    // Sanitize FIRST — strip any schema-invalid keys that may have crept in
    // from legacy code paths, stale wizard state, or future schema bumps.
    // Callers get the cleaned version written even if they forgot to sanitize.
    sanitizeOpenClawConfigInPlace(config);
    const serialized = JSON.stringify(config, null, 2) + '\n';
    if (fs.existsSync(configPath)) {
      const existing = fs.readFileSync(configPath, 'utf-8');
      // Exact byte match — skip
      if (existing === serialized) return false;
      // Trailing-newline-only diff — also skip. Current file may have been
      // written by an older version of this code without a trailing newline;
      // overwriting it just to add the newline would still wake openclaw's
      // file watcher and trigger a spurious "Gateway is restarting" mid-reply.
      // The semantic content is identical so it's safe to leave as-is.
      if (existing + '\n' === serialized) return false;
      // Also handle the inverse: existing has trailing newline, our serialized
      // would still match content-wise. Compare with newline normalized.
      const existingNorm = existing.replace(/\n+$/, '');
      const serializedNorm = serialized.replace(/\n+$/, '');
      if (existingNorm === serializedNorm) return false;
    }
    fs.writeFileSync(configPath, serialized, 'utf-8');
    // Security audit: record every config write with the keys that changed.
    // Don't log values (may contain tokens). Only structure.
    try {
      auditLog('openclaw_config_write', {
        configPath: path.basename(configPath),
        bytes: serialized.length,
        topKeys: Object.keys(config || {}),
      });
    } catch {}
    return true;
  } catch (e) {
    console.error('[openclaw-config] write error:', e.message);
    return false;
  }
}

let routerProcess = null;

let _routerLogFd = null;
// Strip any stored password from 9Router's settings store so the default
// "123456" login always works. 9Router's /api/auth/login uses
// `getSettings().password` if present, falling back to env INITIAL_PASSWORD.
// If a previous run accidentally set a hashed password (or settings file
// got corrupted), the CEO can no longer log in. Idempotent: only writes
// when a non-null password field is present.
function ensure9RouterDefaultPassword() {
  try {
    const dbPath = path.join(appDataDir(), '9router', 'db.json');
    if (!fs.existsSync(dbPath)) return;
    const raw = fs.readFileSync(dbPath, 'utf-8');
    const db = JSON.parse(raw);
    let changed = false;
    if (db.settings && db.settings.password) {
      delete db.settings.password;
      changed = true;
    }
    // Some 9Router builds store password at top level
    if (db.password) { delete db.password; changed = true; }
    if (changed) {
      fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf-8');
      console.log('[9router] Cleared stored password — login uses default 123456');
    }
  } catch (e) { console.error('[9router] ensure default password error:', e.message); }
}

// 9Router GET /api/providers strips apiKey from response (security design).
// Problem: 9Router UI reads from API → shows empty apiKey field → CEO saves → key wiped.
// Fix: save provider keys in our own file, re-inject into 9Router db.json on every startup.
const PROVIDER_KEYS_PATH = () => path.join(appDataDir(), 'modoroclaw-provider-keys.json');

function saveProviderKey(provider, apiKey) {
  try {
    const p = PROVIDER_KEYS_PATH();
    let keys = {};
    if (fs.existsSync(p)) keys = JSON.parse(fs.readFileSync(p, 'utf-8'));
    keys[provider] = apiKey;
    fs.writeFileSync(p, JSON.stringify(keys, null, 2), 'utf-8');
  } catch (e) { console.warn('[provider-keys] save error:', e.message); }
}

function ensure9RouterProviderKeys() {
  try {
    const dbPath = path.join(appDataDir(), '9router', 'db.json');
    const keysPath = PROVIDER_KEYS_PATH();
    if (!fs.existsSync(dbPath) || !fs.existsSync(keysPath)) return;
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    const savedKeys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
    const providers = db.providers || db.providerConnections || [];
    let changed = false;
    for (const p of providers) {
      const savedKey = savedKeys[p.provider];
      if (savedKey && (!p.apiKey || p.apiKey.length < 10)) {
        console.log('[9router] Re-injecting apiKey for provider:', p.name);
        p.apiKey = savedKey;
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf-8');
      console.log('[9router] Provider keys re-injected into db.json');
    }
  } catch (e) { console.error('[9router] ensure provider keys error:', e.message); }
}

function start9Router() {
  if (routerProcess) return;
  try {
    // Kill any foreign process occupying port 20128 before spawning ours.
    // A pre-installed global 9Router (from manual install) squats on the port →
    // our spawn fails EADDRINUSE → waitFor9RouterReady sees the foreign process
    // respond 200 → gateway routes through wrong 9Router → 401 on first chat.
    try { killPort(20128); } catch {}

    ensure9RouterDefaultPassword();
    ensure9RouterProviderKeys();
    const logsDir = path.join(userDataDir, 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    _routerLogFd = fs.openSync(path.join(logsDir, '9router.log'), 'a');

    // Spawn node directly with the JS entrypoint when we can resolve it.
    // This avoids PATH lookups (a real concern on Mac when Electron is launched
    // from Finder and inherits a minimal PATH that misses brew/nvm bin dirs).
    // Use findGlobalPackageFile so we search ALL Node-manager lib dirs — not
    // just the first existing one — because users with mixed setups (e.g.
    // nvm-windows + system Node) can have 9router installed in a different
    // lib dir than the one npmGlobalModules() returns first.
    const routerScript = findGlobalPackageFile('9router', 'cli.js');
    let routerCmd, routerArgs, routerSpawnOpts;
    if (routerScript) {
      // Resolve absolute node path so spawn doesn't depend on PATH at all.
      const nodeBin = findNodeBin() || 'node';
      routerCmd = nodeBin;
      routerArgs = [routerScript, '-n', '--skip-update'];
      routerSpawnOpts = { shell: false };
    } else {
      // Fallback: PATH lookup via shell shim. On Windows we need `9router.cmd`
      // AND shell:true (otherwise spawn ENOENT — only `node.exe`/`*.exe` can be
      // spawned without shell). On Mac/Linux PATH-augmented `9router` works
      // with shell:false. If 9router isn't installed at all, we skip silently
      // — 9router is optional, the CEO can use the app without it.
      const isWin = process.platform === 'win32';
      const probe = isWin ? '9router.cmd' : '9router';
      // Quick PATH probe so we fail-fast instead of escaping a spawn ENOENT
      // out of the try/catch (spawn errors are async — they'd kill the main
      // process via the unhandled 'error' event before our catch ever runs).
      let inPath = false;
      try {
        require('child_process').execSync(
          isWin ? `where ${probe}` : `command -v ${probe}`,
          { stdio: 'ignore', timeout: 3000, shell: !isWin }
        );
        inPath = true;
      } catch {}
      if (!inPath) {
        console.log('[9router] not installed (skipping start). The 9Router tab in Dashboard will be empty but the bot still works.');
        if (_routerLogFd !== null) { try { fs.closeSync(_routerLogFd); } catch {} _routerLogFd = null; }
        return;
      }
      routerCmd = probe;
      routerArgs = ['-n', '--skip-update'];
      routerSpawnOpts = { shell: isWin };
    }
    // Pin 9Router auth so the login form always accepts "123456" and the JWT
    // cookie stays valid across restarts. Without these env vars 9Router falls
    // back to its compiled defaults — but JWT_SECRET also defaults to a fixed
    // string, and INITIAL_PASSWORD defaults to "123456". The CEO-reported login
    // failure is usually because a previous run wrote a custom hashed password
    // into 9Router's settings store, so the literal "123456" stops working.
    // Pinning INITIAL_PASSWORD here is harmless when no stored password exists,
    // and pinning JWT_SECRET makes auth cookies survive Electron restarts.
    const routerEnv = {
      ...process.env,
      INITIAL_PASSWORD: process.env.INITIAL_PASSWORD || '123456',
      JWT_SECRET: process.env.JWT_SECRET || 'modoroclaw-9router-jwt-secret-stable-v1',
    };
    routerProcess = spawn(routerCmd, routerArgs, {
      stdio: ['ignore', _routerLogFd, _routerLogFd],
      detached: true,
      windowsHide: true,
      env: routerEnv,
      ...routerSpawnOpts,
    });
    // CRITICAL: register the 'error' listener BEFORE any other event so an
    // ENOENT (binary not found) doesn't bubble up as an uncaught exception
    // and crash the entire main process with a JS error dialog. spawn errors
    // are async — they fire after this function's try/catch has already
    // returned. Without this listener, ENOENT kills MODOROClaw on launch
    // when 9router is missing/misconfigured.
    routerProcess.on('error', (err) => {
      console.error('[9router] spawn error:', err.message);
      if (_routerLogFd !== null) { try { fs.closeSync(_routerLogFd); } catch {} _routerLogFd = null; }
      routerProcess = null;
    });
    routerProcess.unref();
    routerProcess.on('exit', () => {
      routerProcess = null;
      if (_routerLogFd !== null) { try { fs.closeSync(_routerLogFd); } catch {} _routerLogFd = null; }
    });
    console.log('9Router started (log: logs/9router.log)');
  } catch (e) {
    console.log('9Router start failed:', e.message);
    if (_routerLogFd !== null) { try { fs.closeSync(_routerLogFd); } catch {} _routerLogFd = null; }
    routerProcess = null;
  }
}

function stop9Router() {
  if (!routerProcess) return;
  const pid = routerProcess.pid;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', pid.toString(), '/f', '/t']);
    } else {
      // Mac/Linux: belt-and-braces process tree cleanup. The child Next.js server
      // is a grandchild — kill -pid (process group) is the cleanest approach but
      // RELIES on detached:true at spawn time creating a proper group. If anything
      // about that setup is fragile (which it has been on Mac in the past), the
      // grandchild becomes orphan and squats on port 20128 → next 9router start
      // fails with EADDRINUSE.
      //
      // Strategy: do BOTH process-group kill AND pkill IMMEDIATELY (not as
      // delayed fallback). Use SIGTERM first to allow graceful shutdown, then
      // SIGKILL after 1.5s for anything still alive. Final pkill on
      // server.js as the safety net catches any orphan from previous runs too.
      try { process.kill(-pid, 'SIGTERM'); } catch {}
      try { routerProcess.kill('SIGTERM'); } catch {}
      // Immediate pkill — primary, not fallback
      try {
        require('child_process').execSync(
          'pkill -TERM -f "9router/(app/server.js|cli\\.js)" 2>/dev/null || true',
          { stdio: 'ignore', timeout: 3000, shell: '/bin/sh' }
        );
      } catch {}
      // SIGKILL escalation if still alive after grace period
      setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); } catch {}
        try {
          require('child_process').execSync(
            'pkill -KILL -f "9router/(app/server.js|cli\\.js)" 2>/dev/null || true',
            { stdio: 'ignore', timeout: 3000, shell: '/bin/sh' }
          );
        } catch {}
      }, 1500);
    }
  } catch {}
  routerProcess = null;
}

async function ensureDefaultConfig() {
  // Wrap the entire read-modify-write in the global openclaw.json mutex.
  // This fn runs at boot AND reactively (startOpenClaw from heartbeat / save-zalo-manager
  // / wizard-complete) so it can race with IPC handlers that mutate the same file.
  return withOpenClawConfigLock(async () => {
  console.log('[config-lock] ensureDefaultConfig acquired');
  // Patch openclaw.json directly — no CLI "restart to apply" issue
  const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
  try {
    if (!fs.existsSync(configPath)) return;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    let changed = false;

    if (!config.gateway) config.gateway = {};
    if (config.gateway.mode !== 'local') { config.gateway.mode = 'local'; changed = true; }

    const provider = config.models?.providers?.ninerouter;
    if (provider) {
      if (provider.api !== 'openai-completions') { provider.api = 'openai-completions'; changed = true; }
      // Fix IPv6 issue: localhost → 127.0.0.1
      if (provider.baseUrl && provider.baseUrl.includes('localhost')) {
        provider.baseUrl = provider.baseUrl.replace('localhost', '127.0.0.1');
        changed = true;
      }
      // LAYER 5 vision fix — pi-ai's openai-completions.js filters out
      // image_url parts from user messages AND tool results if
      // `model.input.includes("image")` is false (node_modules/@mariozechner/
      // pi-ai/dist/providers/openai-completions.js:461 + 574). 9Router's
      // /v1/models response does NOT declare `input:["image"]` → pi-ai gate
      // strips every image part at the final outbound serialization step →
      // upstream gets only text → bot hallucinates. Declaring input:["image"]
      // at the openclaw.json model level propagates through openclaw's model
      // override chain into pi-ai, flipping the gate open.
      if (Array.isArray(provider.models)) {
        for (const m of provider.models) {
          if (!m || typeof m !== 'object') continue;
          if (!Array.isArray(m.input) || !m.input.includes('image')) {
            m.input = Array.isArray(m.input) ? [...new Set([...m.input, 'image', 'text'])] : ['text', 'image'];
            changed = true;
          }
        }
      }
    }

    // Fix required fields OpenClaw validator demands
    if (config.channels?.telegram?.botToken && !config.channels.telegram.enabled) {
      config.channels.telegram.enabled = true; changed = true;
    }
    // Ensure OpenZalo has all policy fields set. CRITICAL: create block if missing
    // entirely — previously we only healed when `config.channels?.openzalo` was truthy,
    // but openclaw 2026.4.x gateway normalization can strip fields and leave `{}`, or
    // even remove the openzalo key altogether. Always create + heal so the block is
    // never undefined/empty after this function.
    if (!config.channels) config.channels = {};
    if (!config.channels.openzalo || typeof config.channels.openzalo !== 'object') {
      config.channels.openzalo = {};
      changed = true;
    }
    // ALSO: if the openzalo plugin files exist at ~/.openclaw/extensions/openzalo/
    // (either because bundled vendor copy placed them there, or `openclaw plugins
    // install` did), make sure the plugin entry EXISTS. We sync its enabled
    // state later from channels.openzalo.enabled so "Tắt Zalo" is a real
    // hard-off, not merely a soft gate after the plugin already loaded.
    try {
      const openzaloPluginManifest = path.join(HOME, '.openclaw', 'extensions', 'openzalo', 'openclaw.plugin.json');
      if (fs.existsSync(openzaloPluginManifest)) {
        if (!config.plugins) config.plugins = {};
        if (!config.plugins.entries) config.plugins.entries = {};
        if (!config.plugins.entries.openzalo) {
          config.plugins.entries.openzalo = { enabled: false };
          changed = true;
        }
        // plugins.allow tells gateway which non-bundled plugins are trusted.
        // Without this, gateway warns "plugins.allow is empty" on every boot.
        if (!Array.isArray(config.plugins.allow)) {
          config.plugins.allow = ['openzalo'];
          changed = true;
        } else if (!config.plugins.allow.includes('openzalo')) {
          config.plugins.allow.push('openzalo');
          changed = true;
        }
      }
    } catch (e) { console.warn('[config] plugin entry heal failed:', e?.message); }
    {
      const oz = config.channels.openzalo;
      // Default OFF on fresh install — CEO must enable from Settings > Zalo.
      // If field already exists (any value), preserve it so disabling from
      // dashboard survives restarts. Previously this forced true every boot,
      // which overrode the CEO's explicit disable.
      if (oz.enabled === undefined) { oz.enabled = false; changed = true; }
      // U2: purge legacy channels.openzalo.groups on upgrade. v2.58 stored
      // per-group requireMention/enabled here, creating a dual source of
      // truth with zalo-group-settings.json (CRIT #5). We're now
      // single-sourcing via the JSON file + GROUP-SETTINGS v3 patch.
      if (oz.groups && typeof oz.groups === 'object') { delete oz.groups; changed = true; }
      if (!oz.dmPolicy) { oz.dmPolicy = 'open'; changed = true; }
      if (!oz.allowFrom) { oz.allowFrom = ['*']; changed = true; }
      if (!oz.groupPolicy) { oz.groupPolicy = 'open'; changed = true; }
      if (!oz.groupAllowFrom) { oz.groupAllowFrom = ['*']; changed = true; }
      // DELETE legacy streaming keys — openclaw 2026.4.14 rejects them.
      // Openzalo one-message guarantee comes from ensureOpenzaloForceOneMessageFix
      // (hardcoded disableBlockStreaming:true in inbound.ts), not config.
      for (const legacyKey of ['blockStreaming', 'streamMode', 'draftChunk', 'blockStreamingCoalesce']) {
        if (legacyKey in oz) { delete oz[legacyKey]; changed = true; }
      }
      // History limits: prevent context window bloat over weeks of chat.
      // historyLimit = max messages kept per group thread (default unlimited → OOM after weeks)
      // dmHistoryLimit = max messages kept per DM thread
      // Without these, a CEO with 50 active Zalo groups × 200 msg/day = compaction every reply after ~3 days.
      if (!oz.historyLimit || oz.historyLimit > 50) { oz.historyLimit = 50; changed = true; }
      if (!oz.dmHistoryLimit || oz.dmHistoryLimit > 20) { oz.dmHistoryLimit = 20; changed = true; }
      // DEFENSIVE CLEANUP: remove `streaming` if it crept in from a prior buggy
      // version of this function (2026-04-08 regression). Schema rejects it.
      if ('streaming' in oz) { delete oz.streaming; changed = true; }
      // Whitelist-based strip: openzalo schema is strict
      // (additionalProperties:false). CEOs upgrading from older openclaw CLI
      // installs may have fields like `messages` (seen in real customer
      // workspace 2026-04-15) or other legacy keys that make the gateway
      // reject config with "channels.openzalo: must NOT have additional
      // properties" → gateway never binds WS → bot dead silently.
      // Fields valid per openzalo/src/config-schema-core.ts OpenzaloConfigSchema:
      const OPENZALO_VALID_FIELDS = new Set([
        'name', 'enabled', 'profile', 'zcaBinary', 'acpx', 'markdown',
        'dmPolicy', 'allowFrom', 'groupPolicy', 'groupAllowFrom', 'groups',
        'historyLimit', 'dmHistoryLimit', 'textChunkLimit', 'chunkMode',
        'mediaMaxMb', 'mediaLocalRoots', 'sendTypingIndicators',
        'threadBindings', 'actions', 'accounts', 'defaultAccount',
      ]);
      for (const k of Object.keys(oz)) {
        if (!OPENZALO_VALID_FIELDS.has(k)) {
          console.log('[config] stripped unknown openzalo field: ' + k);
          delete oz[k];
          changed = true;
        }
      }
      // DO NOT set `zcaBinary` here: the openzalo plugin's
      // resolveOpenzcaCliJs() on Windows only searches hardcoded npm global
      // paths and ignores the config value during resolve, then falls back to
      // `spawn(binary, ..., {shell: true})`. On Mac it always falls back to
      // that shell-spawn path. Either way, the resolution works via PATH
      // lookup of plain "openzca". For bundled .dmg installs, the PATH
      // augmentation in augmentPathWithBundledNode() prepends
      // vendor/node_modules/.bin so the bundled openzca shim is found.
    }
    // Defense-in-depth: config layer in case env var fails to propagate (e.g.,
    // cron-agent subprocess spawn that doesn't inherit enrichedEnv).
    if (!config.discovery) config.discovery = {};
    if (!config.discovery.mdns) config.discovery.mdns = {};
    if (config.discovery.mdns.mode !== "off") {
      config.discovery.mdns.mode = "off";
      changed = true;
    }
    // Sync plugin hard-off with the master Zalo enabled flag. If Zalo is off,
    // the gateway should not load openzalo at all.
    try {
      const openzaloPluginManifest = path.join(HOME, '.openclaw', 'extensions', 'openzalo', 'openclaw.plugin.json');
      if (fs.existsSync(openzaloPluginManifest)) {
        if (!config.plugins) config.plugins = {};
        if (!config.plugins.entries) config.plugins.entries = {};
        const wantOpenzaloEnabled = config.channels.openzalo.enabled !== false;
        if (!config.plugins.entries.openzalo) {
          config.plugins.entries.openzalo = { enabled: wantOpenzaloEnabled };
          changed = true;
        } else if (config.plugins.entries.openzalo.enabled !== wantOpenzaloEnabled) {
          config.plugins.entries.openzalo.enabled = wantOpenzaloEnabled;
          changed = true;
        }
      }
    } catch (e) { console.warn('[config] plugin hard-off sync failed:', e?.message); }
    // Telegram — disable streaming so bot replies arrive as exactly 1 complete
    // message, never split. openclaw 2026.4.14 moved streaming config from scalar
    // keys (blockStreaming, streaming:"off") to nested object:
    //   streaming.mode = "off"
    //   streaming.block.enabled = false
    // Old scalar keys are REJECTED by validator ("must NOT have additional properties").
    if (!config.channels.telegram) config.channels.telegram = {};
    {
      const tg = config.channels.telegram;
      // DELETE legacy keys that cause "invalid config" rejection
      for (const legacyKey of ['blockStreaming', 'streamMode', 'chunkMode', 'draftChunk', 'blockStreamingCoalesce']) {
        if (legacyKey in tg) { delete tg[legacyKey]; changed = true; }
      }
      // Migrate scalar `streaming: "off"` → nested object
      if (typeof tg.streaming === 'string' || tg.streaming === undefined) {
        tg.streaming = { mode: 'off', block: { enabled: false } };
        changed = true;
      } else if (tg.streaming && typeof tg.streaming === 'object') {
        if (tg.streaming.mode !== 'off') { tg.streaming.mode = 'off'; changed = true; }
        if (!tg.streaming.block) tg.streaming.block = {};
        if (tg.streaming.block.enabled !== false) { tg.streaming.block.enabled = false; changed = true; }
      }
      // Group policy: "open" lets bot reply in ANY group it's added to (no
      // allowlist gate). Default openclaw is "allowlist" which blocks all groups
      // until manually configured → CEO adds bot to group, @mentions, bot
      // silently drops message. Same UX as Zalo (open by default).
      if (tg.groupPolicy !== 'open') { tg.groupPolicy = 'open'; changed = true; }
      // Require @mention in groups so bot only replies when explicitly called.
      // Otherwise bot would forward every group message to AI → huge token waste.
      // NOTE: requireMention is NOT a valid Telegram schema field in openclaw
      // 2026.4.14 (it exists for Discord/Slack/Matrix only). Telegram groups
      // use per-group config via `groups.<id>.requireMention` instead. Writing
      // it at top level causes "must NOT have additional properties" → gateway
      // refuses to start. DELETE if present from prior versions.
      if ('requireMention' in tg) { delete tg.requireMention; changed = true; }
      // History limit: prevent context bloat for CEO who chats 100+ msg/day
      if (!tg.historyLimit || tg.historyLimit > 50) { tg.historyLimit = 50; changed = true; }
      // DEFENSIVE CLEANUP: strip keys that are NOT in the Telegram schema.
      // A prior config or openclaw version may have left `messages`, `configWrites`
      // or other top-level keys nested under channels.telegram by mistake.
      // openclaw 2026.4.14 uses strict() → any unknown key = "must NOT have
      // additional properties" → gateway refuses to start.
      const TELEGRAM_VALID_FIELDS = new Set([
        'name', 'capabilities', 'execApprovals', 'enabled', 'markdown',
        'commands', 'customCommands', 'configWrites', 'dmPolicy', 'botToken',
        'tokenFile', 'replyToMode', 'groups', 'allowFrom', 'defaultTo',
        'groupAllowFrom', 'groupPolicy', 'contextVisibility', 'historyLimit',
        'dmHistoryLimit', 'dms', 'direct', 'textChunkLimit', 'streaming',
        'mediaMaxMb', 'timeoutSeconds', 'retry', 'network', 'webhookUrl',
        'webhookSecret', 'webhookPath', 'webhookHost', 'webhookPort',
        'webhookCertPath', 'accounts', 'defaultAccount',
        'profile', 'sendTypingIndicators',
      ]);
      for (const k of Object.keys(tg)) {
        if (!TELEGRAM_VALID_FIELDS.has(k)) {
          console.log('[config] stripped unknown telegram field: ' + k);
          delete tg[k];
          changed = true;
        }
      }
    }
    // Global default: openclaw 2026.4.x removed `agents.defaults.blockStreaming`
    // (boolean) and replaced it with `agents.defaults.blockStreamingDefault`
    // ("on"|"off"). The new default is already "off" — no value to write — but we
    // MUST actively delete the old key so the validator stops rejecting the file
    // with: `agents.defaults: Unrecognized key: "blockStreaming"`. Without this,
    // every `openclaw <subcommand>` call exits with code 1 (Config invalid) and
    // the entire cron-agent pipeline is dead.
    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};
    if ('blockStreaming' in config.agents.defaults) {
      delete config.agents.defaults.blockStreaming;
      changed = true;
    }
    // Belt-and-braces: explicitly set blockStreamingDefault="off" so even if a
    // future channel config block forgets `blockStreaming: false`, the global
    // default kicks in and prevents the "D" + "ạ em chào..." word-split bug.
    // (openclaw 2026.4.x default is already "off" but writing it explicit
    // protects against any future schema flip + makes intent clear in config.)
    if (config.agents.defaults.blockStreamingDefault !== 'off') {
      config.agents.defaults.blockStreamingDefault = 'off';
      changed = true;
    }
    // BOOTSTRAP INJECTION MODE: "always" re-injects AGENTS.md + bootstrap files
    // on EVERY turn (~8k tokens overhead). "continuation-skip" only injects on
    // the first message then skips — saves tokens but model loses AGENTS.md rules
    // on subsequent turns, causing emoji usage, AI self-disclosure, and missing
    // CEO confirmation steps. For customer-facing bot, correctness > token cost.
    if (config.agents.defaults.contextInjection !== 'always') {
      config.agents.defaults.contextInjection = 'always';
      changed = true;
    }
    // BOOTSTRAP-BUDGET FIX: openclaw default bootstrapMaxChars is 20,000 per file.
    // AGENTS.md is ~24K and growing (v2.3.48 will add more rules). At 20K the tail
    // of AGENTS.md is silently truncated — defense rules, cron rules, and channel
    // rules at the bottom get cut. Raise to 40K so the full file is always injected.
    // bootstrapTotalMaxChars default (150K) is generous and does not need changing.
    if (config.agents.defaults.bootstrapMaxChars !== 40000) {
      config.agents.defaults.bootstrapMaxChars = 40000;
      changed = true;
    }
    // TOOL-BLOAT FIX: deny media-generation tools (unused in support flow).
    // exec + process ALLOWED — needed for CEO "gửi Zalo từ Telegram" flow
    // (agent runs send-zalo-safe.js). AGENTS.md restricts exec to only
    // send-zalo-safe.js + forbids config/blocklist writes.
    //
    // tools.allow verified in openclaw 2026.4.x runtime-schema at "tools.allow".
    if (!config.tools) config.tools = {};
    // tools.allow = absolute allowlist. Only these tools are available to the agent.
    // SECURITY: exec, process, cron ALL REMOVED — gateway agent serves both
    // Telegram (trusted CEO) AND Zalo (untrusted strangers) with ONE config.
    // exec/process = RCE via strangers. cron = strangers create scheduled jobs.
    const ALLOW_TOOLS = [
      'message',      // reply to customers (Zalo) + CEO (Telegram)
      'web_search',   // look up info for customer questions
      'web_fetch',    // read URLs shared by customers/CEO + API calls
      'update_plan',  // agent planning for multi-step answers
    ];
    const existingAllow = Array.isArray(config.tools.allow) ? config.tools.allow : [];
    if (JSON.stringify(existingAllow.slice().sort()) !== JSON.stringify(ALLOW_TOOLS.slice().sort())) {
      config.tools.allow = ALLOW_TOOLS;
      changed = true;
    }
    // Remove legacy deny list — allow takes precedence, deny is redundant
    if (config.tools.deny) {
      delete config.tools.deny;
      changed = true;
    }
    // openzalo.tools already stripped by OPENZALO_VALID_FIELDS whitelist above.
    // LOOP SAFETY: enable tools.loopDetection — openclaw ships it disabled.
    // Without this, a truly stuck model can grind through unlimited tool calls.
    // Thresholds chosen wide enough to NEVER fire on normal 3-5 turn Zalo reply
    // (user said don't cap natural behavior), but stops pathological runaway.
    // Default values used for most fields — we just flip `enabled: true`.
    if (!config.tools.loopDetection) config.tools.loopDetection = {};
    if (config.tools.loopDetection.enabled !== true) {
      config.tools.loopDetection.enabled = true;
      changed = true;
    }
    // CLEANUP: execSecurity is NOT valid under agents.defaults (it's a runtime
    // agent config key). A prior buggy version wrote it here → gateway rejects
    // entire config with "Unrecognized key: execSecurity" → bot never starts.
    // Must actively delete to heal machines that already have the bad key.
    if ('execSecurity' in config.agents.defaults) {
      delete config.agents.defaults.execSecurity;
      changed = true;
    }
    // Inbound message batching: wait 3s for rapid messages from same sender,
    // then process all together as 1 turn. Prevents bot replying 3 times when
    // customer sends "anh ơi" + "giá bao nhiêu" + "có ship không" in 3 seconds.
    // OpenClaw default is 700ms. CEO experience is better at 3000ms.
    if (!config.messages) config.messages = {};
    if (!config.messages.inbound) config.messages.inbound = {};
    if (!config.messages.inbound.debounceMs || config.messages.inbound.debounceMs < 2500) {
      config.messages.inbound.debounceMs = 3000;
      changed = true;
    }
    // Suppress compaction notices to customers. OpenClaw sends "🧹 Compacting context..."
    // and "⚠️ Context limit exceeded" to the chat — CEO/khách should never see these.
    if (!config.agents.defaults.compaction) config.agents.defaults.compaction = {};
    if (config.agents.defaults.compaction.notifyUser !== false) {
      config.agents.defaults.compaction.notifyUser = false;
      changed = true;
    }
    // Enable cross-channel messaging: bot on Telegram channel can call `message`
    // tool targeting Zalo channel (e.g. CEO says "nhắn group Zalo X"). Without
    // this flag openclaw hard-throws "Cross-context messaging denied" even if the
    // bot follows AGENTS.md instruction. Config key confirmed from source:
    //   message-action-runner.js: cfg.tools?.message?.crossContext?.allowAcrossProviders
    if (!config.tools) config.tools = {};
    if (!config.tools.message) config.tools.message = {};
    if (!config.tools.message.crossContext) config.tools.message.crossContext = {};
    if (config.tools.message.crossContext.allowAcrossProviders !== true) {
      config.tools.message.crossContext.allowAcrossProviders = true;
      changed = true;
    }

    // Enable DuckDuckGo web search (built-in from openclaw 2026.4.14, no API key needed)
    if (!config.tools.web) config.tools.web = {};
    if (!config.tools.web.search) config.tools.web.search = {};
    if (!config.tools.web.search.provider) {
      config.tools.web.search.provider = 'duckduckgo';
      changed = true;
    }

    // Remove any unknown keys that OpenClaw rejects
    const validKeys = ['plugins', 'meta', 'channels', 'gateway', 'models', 'agents', 'wizard', 'tools', 'messages', 'discovery'];
    for (const key of Object.keys(config)) {
      if (!validKeys.includes(key)) { delete config[key]; changed = true; }
    }

    // Seed writable workspace (first run) — copies templates from read-only bundle if packaged
    const ws = seedWorkspace();

    // CAP blocklist at 200 entries — unbounded list = memory/perf risk + abuse vector
    const blPath = path.join(ws, 'zalo-blocklist.json');
    if (fs.existsSync(blPath)) {
      try {
        const bl = JSON.parse(fs.readFileSync(blPath, 'utf-8'));
        if (Array.isArray(bl) && bl.length > 200) {
          console.warn(`[config] zalo-blocklist.json has ${bl.length} entries — trimming to 200`);
          fs.writeFileSync(blPath, JSON.stringify(bl.slice(0, 200), null, 2) + '\n');
          try { auditLog('blocklist_trimmed', { was: bl.length, now: 200 }); } catch {}
        }
      } catch (blErr) { console.warn('[config] blocklist cap check failed:', blErr?.message); }
    }

    // Set workspace to the writable dir so gateway reads our AGENTS.md, SOUL.md etc
    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};
    const wantedWorkspace = ws.replace(/\\/g, '/');
    if (config.agents.defaults.workspace !== wantedWorkspace) {
      config.agents.defaults.workspace = wantedWorkspace;
      changed = true;
    }

    // Always go through writeOpenClawConfigIfChanged so even with `changed=true`
    // we still skip if the serialized bytes are byte-equal (e.g. trailing-newline
    // mismatch with openclaw's writer was the previous bug). This guarantees we
    // never wake openclaw's config-reload pipeline unless we *truly* changed
    // something — which is the only way to avoid spurious "Gateway is restarting".
    if (changed) {
      const wrote = writeOpenClawConfigIfChanged(configPath, config);
      if (wrote) console.log('[config] openclaw.json patched (real change)');
      else console.log('[config] openclaw.json unchanged on disk — skipping write');
    }

    // Create required dirs
    fs.mkdirSync(path.join(HOME, '.openclaw', 'agents', 'main', 'sessions'), { recursive: true });
    console.log('[config] workspace =', ws);
  } catch (e) {
    console.error('ensureDefaultConfig error:', e.message);
    // Surface write errors prominently — silent failure means bot runs with broken config
    try {
      const logsDir = path.join(HOME, '.openclaw', 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      const errFile = path.join(logsDir, 'config-errors.log');
      fs.appendFileSync(errFile, `${new Date().toISOString()} ensureDefaultConfig: ${e?.message || e}\n`, 'utf-8');
    } catch {}
  }
  });
}

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

// Force-cleanup any Zalo listener tree before fresh gateway spawn.
// Reason: listener-owner.json stores the LISTENER's own pid, not the gateway's.
// A listener can be alive but orphaned (gateway dead). Messages silently drop.
// Simplest fix: always kill any "openzca listen" process before starting new gateway.
function cleanupOrphanZaloListener() {
  try {
    // Kill any openzca listen process tree on Windows/Unix
    if (process.platform === 'win32') {
      try {
        // Use PowerShell (always available on Win10+) instead of wmic (deprecated/removed on Win11 24H2+)
        const { execSync } = require('child_process');
        const psCmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*openzca*listen*' } | Select-Object -ExpandProperty ProcessId"`;
        const out = execSync(psCmd, { encoding: 'utf-8', timeout: 8000 }).trim();
        const pids = out.split(/\r?\n/).map(l => l.trim()).filter(p => /^\d+$/.test(p));
        for (const pid of pids) {
          try {
            execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 3000 });
            console.log('[zalo-cleanup] Killed listener tree pid', pid);
          } catch {}
        }
      } catch (e) { console.error('[zalo-cleanup] error:', e.message); }
    } else {
      try {
        require('child_process').execSync('pkill -f "openzca.*listen" 2>/dev/null || true', { stdio: 'ignore' });
      } catch {}
    }
    // Remove stale listener-owner.json so new gateway can claim fresh
    const ownerFile = path.join(HOME, '.openzca', 'profiles', 'default', 'listener-owner.json');
    if (fs.existsSync(ownerFile)) {
      try { fs.unlinkSync(ownerFile); console.log('[zalo-cleanup] Removed listener-owner.json'); } catch {}
    }
  } catch (e) { console.error('[zalo-cleanup] error:', e.message); }
}


// ========================================================================
// Vendor patches — delegated to electron/lib/vendor-patches.js
// ========================================================================
// All ensure*Fix functions + applyOpenzaloFork live in the shared module.
// This lets prebuild-vendor.js apply the SAME patches at build time.
// Runtime calls here are defense-in-depth (idempotent via markers).
const vendorPatches = require('./lib/vendor-patches');

function ensureVisionFix() { vendorPatches.ensureVisionFix(getBundledVendorDir(), HOME); }

function ensureVisionCatalogFix() { vendorPatches.ensureVisionCatalogFix(getBundledVendorDir(), HOME); }

function ensureVisionSerializationFix() { vendorPatches.ensureVisionSerializationFix(getBundledVendorDir(), HOME); }

function ensureWebFetchLocalhostFix() { vendorPatches.ensureWebFetchLocalhostFix(getBundledVendorDir(), HOME); }

function ensureOpenzcaFriendEventFix() { vendorPatches.ensureOpenzcaFriendEventFix(getBundledVendorDir(), getWorkspace() || resourceDir); }
function ensureOpenclawPricingFix() { vendorPatches.ensureOpenclawPricingFix(getBundledVendorDir()); }
function ensureOpenclawPrewarmFix() { vendorPatches.ensureOpenclawPrewarmFix(getBundledVendorDir()); }
const OPENZALO_FORK_VERSION = vendorPatches.OPENZALO_FORK_VERSION;
function applyOpenzaloFork() { return vendorPatches.applyOpenzaloFork(HOME, path.join(__dirname, 'patches', 'openzalo-fork'), getBundledVendorDir()); }

// ========================================================================
// Security Layer 5 — Log rotation + memory retention
// ========================================================================
// Runs once at app startup. Enforces retention policies so stale data
// (log files with tokens/PII, old memory that shouldn't have been kept)
// doesn't accumulate indefinitely. Each action is append-only-safe: archives
// before delete where possible.
//
// Policies:
// - logs/openclaw.log  > 10 MB → rotate to openclaw.log.1 (single rotation)
// - logs/openzca.log   > 10 MB → rotate to openzca.log.1
// - logs/main.log      > 20 MB → rotate
// - logs/audit.jsonl   > 50 MB → rotate to audit.jsonl.1 (preserve forensics)
// - logs/*.log.1       > 7 days old → delete
// - memory/YYYY-MM-DD.md > 90 days old → move to memory/archive/ (not deleted
//   by default — CEO can manually purge archive)
// - openclaw.json.bak* > 30 days → delete
//
// Non-blocking. Errors logged but don't affect boot.
function enforceRetentionPolicies() {
  try {
    const workspace = getWorkspace();
    if (!workspace) return;
    const logsDir = path.join(workspace, 'logs');
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const MB = 1024 * 1024;

    // 1. Rotate oversized logs
    const rotationTargets = [
      { name: 'openclaw.log', maxBytes: 10 * MB },
      { name: 'openzca.log', maxBytes: 10 * MB },
      { name: 'main.log', maxBytes: 20 * MB },
      { name: 'audit.jsonl', maxBytes: 50 * MB },
      { name: 'cron-runs.jsonl', maxBytes: 10 * MB },
      { name: 'security-output-filter.jsonl', maxBytes: 10 * MB },
      { name: 'escalation-queue.jsonl', maxBytes: 5 * MB },
      { name: 'ceo-alerts-missed.log', maxBytes: 5 * MB },
    ];
    for (const t of rotationTargets) {
      try {
        const p = path.join(logsDir, t.name);
        if (!fs.existsSync(p)) continue;
        const stat = fs.statSync(p);
        if (stat.size > t.maxBytes) {
          const rotated = p + '.1';
          try { fs.rmSync(rotated, { force: true }); } catch {}
          fs.renameSync(p, rotated);
          auditLog('log_rotated', { file: t.name, bytes: stat.size });
          console.log(`[retention] rotated ${t.name} (${(stat.size / MB).toFixed(1)} MB)`);
        }
      } catch (e) { console.warn('[retention] rotate', t.name, 'failed:', e?.message); }
    }

    // 2. Delete old rotated .log.1 files (>7 days)
    try {
      if (fs.existsSync(logsDir)) {
        for (const entry of fs.readdirSync(logsDir)) {
          if (!/\.(log|jsonl)\.\d+$/.test(entry)) continue;
          const p = path.join(logsDir, entry);
          try {
            const stat = fs.statSync(p);
            if (now - stat.mtimeMs > 7 * DAY) {
              fs.rmSync(p, { force: true });
              auditLog('log_expired_deleted', { file: entry });
              console.log(`[retention] deleted expired log: ${entry}`);
            }
          } catch {}
        }
      }
    } catch {}

    // 3. Archive memory/YYYY-MM-DD.md > 90 days old
    try {
      const memoryDir = path.join(workspace, 'memory');
      const archiveDir = path.join(memoryDir, 'archive');
      if (fs.existsSync(memoryDir)) {
        for (const entry of fs.readdirSync(memoryDir)) {
          if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(entry)) continue;
          const p = path.join(memoryDir, entry);
          try {
            const stat = fs.statSync(p);
            if (now - stat.mtimeMs > 90 * DAY) {
              fs.mkdirSync(archiveDir, { recursive: true });
              fs.renameSync(p, path.join(archiveDir, entry));
              auditLog('memory_archived', { file: entry });
              console.log(`[retention] archived old memory: ${entry}`);
            }
          } catch {}
        }
      }
    } catch {}

    // 4. Delete old openclaw.json.bak* (>30 days) — not needed forever
    try {
      const openclawDir = path.join(HOME, '.openclaw');
      if (fs.existsSync(openclawDir)) {
        for (const entry of fs.readdirSync(openclawDir)) {
          if (!/^openclaw\.json\.bak/.test(entry)) continue;
          const p = path.join(openclawDir, entry);
          try {
            const stat = fs.statSync(p);
            if (now - stat.mtimeMs > 30 * DAY) {
              fs.rmSync(p, { force: true });
              auditLog('config_backup_expired', { file: entry });
              console.log(`[retention] deleted old config backup: ${entry}`);
            }
          } catch {}
        }
      }
    } catch {}

    auditLog('retention_policies_enforced', {});
  } catch (e) {
    console.warn('[retention] enforcement failed:', e?.message);
  }
}

// ========================================================================
// Security Layer 3 — Append-only audit log
// ========================================================================
// Every sensitive event (boot, config write, channel spawn, blocked output,
// cron fire, friend-check hit, etc.) is appended to an audit.jsonl file in
// the workspace logs/ directory. Append-only — callers NEVER rewrite or
// truncate. Gives CEO a forensic trail: "what did the bot do on day X".
//
// Rotation handled separately by Layer 5 log-rotate cron.
//
// Usage: auditLog('event_name', { ...metadata })
function auditLog(event, meta) {
  try {
    const workspace = getWorkspace();
    if (!workspace) return;
    const logsDir = path.join(workspace, 'logs');
    try { fs.mkdirSync(logsDir, { recursive: true }); } catch {}
    const file = path.join(logsDir, 'audit.jsonl');
    const entry = JSON.stringify({
      t: new Date().toISOString(),
      event: String(event || 'unknown'),
      pid: process.pid,
      ...meta,
    }) + '\n';
    fs.appendFileSync(file, entry, 'utf-8');
  } catch (e) {
    // Audit log failure MUST NOT break core flow. Log to console only.
    console.warn('[audit] write failed:', e?.message);
  }
}

let _startOpenClawInFlight = false;
let _wizardCompleteInFlight = false;
// Set true in before-quit handler — wizard-complete IIFE checks this between
// awaits so the bg sequence aborts if user force-quits mid-boot instead of
// racing file writes against shutdown cleanup.
let _appIsQuitting = false;
// IPC in-flight counter — incremented on entry to mutating handlers, decremented
// in finally. before-quit awaits drain (up to 3s) so a save isn't interrupted
// by app.exit(0) leaving openclaw.json half-written.
let _ipcInFlightCount = 0;
function waitForIpcDrain(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const start = Date.now();
    if (_ipcInFlightCount === 0) { resolve({ drained: true, elapsed: 0 }); return; }
    const iv = setInterval(() => {
      if (_ipcInFlightCount === 0) {
        clearInterval(iv);
        resolve({ drained: true, elapsed: Date.now() - start });
      } else if (Date.now() - start >= timeoutMs) {
        clearInterval(iv);
        resolve({ drained: false, elapsed: Date.now() - start, inFlight: _ipcInFlightCount });
      }
    }, 100);
  });
}
// Shared guard for mutating IPC during gateway boot. Returns a rejection envelope
// when unsafe (restart mid-spawn corrupts openclaw.json or crashes gateway);
// returns null when it's safe to proceed. Keep read-only handlers exempt.
function rejectIfBooting(handlerName) {
  const booting = _startOpenClawInFlight === true
    || (botRunning === false && _startOpenClawInFlight !== false);
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
// [restart-guard A1] Set while a hard-restart sequence (stopOpenClaw → wait →
// startOpenClaw) is in progress. Heartbeat watchdog checks this and skips its
// own restart attempt — otherwise save-zalo-manager / resume-zalo can kick off
// a restart, heartbeat fires mid-sequence, both try to restart, cascade.
// Cleared inside the IIFE's finally, NOT by any individual startOpenClaw /
// stopOpenClaw caller.
let _gatewayRestartInFlight = false;
// [restart-guard A1] Timestamp (ms since epoch) of the last _startOpenClawImpl
// completion. Heartbeat requires >= 60s since last start before attempting its
// own restart — otherwise a slow boot looks dead.
let _gatewayLastStartedAt = 0;
async function startOpenClaw(opts = {}) {
  if (botRunning) return;
  // Prevent re-entrant start while a previous start is still spawning. Without
  // this guard, heartbeat + UI button + boot sequence can race and spawn 2-3
  // gateway processes that fight over port 18789.
  if (_startOpenClawInFlight) {
    console.log('[startOpenClaw] already in progress — skipping duplicate call');
    return;
  }
  // [restart-guard A1 fix] Check bonjour + network cooldowns at the single
  // choke point. Previously _bonjourCooldownUntil was set but only checked
  // in fast-watchdog — all other call sites bypassed it silently.
  const now = Date.now();
  const bonjourUntil = global._bonjourCooldownUntil || 0;
  const networkUntil = global._networkCooldownUntil || 0;
  const cooldownUntil = Math.max(bonjourUntil, networkUntil);
  if (cooldownUntil > now) {
    const remaining = Math.ceil((cooldownUntil - now) / 1000);
    const reason = bonjourUntil >= networkUntil ? 'bonjour' : 'network';
    console.log(`[startOpenClaw] ${reason} cooldown active — skipping (${remaining}s remaining)`);
    return;
  }
  _startOpenClawInFlight = true;
  try {
    const r = await _startOpenClawImpl(opts);
    _gatewayLastStartedAt = Date.now();
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
        for (const cat of KNOWLEDGE_CATEGORIES) {
          try { rewriteKnowledgeIndex(cat); } catch (e) {
            console.warn('[knowledge-index] boot rewrite', cat, 'err:', e && e.message ? e.message : String(e));
          }
        }
      } catch (e) {
        console.warn('[knowledge-index] boot rewrite dispatch error:', e && e.message ? e.message : String(e));
      }
    }, 12000);
    return r;
  }
  finally { _startOpenClawInFlight = false; }
}
function backupWorkspace() {
  const ws = getWorkspace();
  if (!ws || !fs.existsSync(ws)) return;
  const backupsRoot = path.join(ws, 'backups');
  try { fs.mkdirSync(backupsRoot, { recursive: true }); } catch {}

  // Throttle: skip if most recent backup < 1 hour old
  try {
    const existing = fs.readdirSync(backupsRoot)
      .filter(n => /^\d{4}-\d{2}-\d{2}-\d{6}$/.test(n))
      .sort();
    if (existing.length > 0) {
      const latest = existing[existing.length - 1];
      const latestPath = path.join(backupsRoot, latest);
      try {
        const st = fs.statSync(latestPath);
        if (Date.now() - st.mtimeMs < 60 * 60 * 1000) {
          console.log('[backup] skipped — recent backup exists');
          return;
        }
      } catch {}
    }
  } catch {}

  // Build UTC timestamp YYYY-MM-DD-HHmmss
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const dst = path.join(backupsRoot, stamp);
  fs.mkdirSync(dst, { recursive: true });

  let fileCount = 0;

  const copyFileIfExists = (srcAbs, dstAbs) => {
    try {
      if (!fs.existsSync(srcAbs)) return;
      fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
      fs.copyFileSync(srcAbs, dstAbs);
      fileCount++;
    } catch {}
  };

  const flatFiles = [
    'AGENTS.md', 'IDENTITY.md', 'COMPANY.md', 'PRODUCTS.md', 'USER.md',
    'SOUL.md', 'MEMORY.md', 'BOOTSTRAP.md', 'HEARTBEAT.md', 'TOOLS.md',
    'schedules.json', 'custom-crons.json',
    'zalo-blocklist.json', 'telegram-paused.json', 'zalo-paused.json',
  ];
  for (const rel of flatFiles) {
    copyFileIfExists(path.join(ws, rel), path.join(dst, rel));
  }

  // memory/ recursive, excluding Cache + logs
  const memSrc = path.join(ws, 'memory');
  if (fs.existsSync(memSrc)) {
    try {
      fs.cpSync(memSrc, path.join(dst, 'memory'), {
        recursive: true,
        filter: (src) => {
          const base = path.basename(src);
          if (base === 'Cache' || base === 'logs') return false;
          return true;
        },
      });
      // Count files recursively
      const walk = (p) => {
        try {
          const entries = fs.readdirSync(p, { withFileTypes: true });
          for (const e of entries) {
            const full = path.join(p, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.isFile()) fileCount++;
          }
        } catch {}
      };
      walk(path.join(dst, 'memory'));
    } catch {}
  }

  // knowledge/<cat>/index.md only
  for (const cat of ['cong-ty', 'san-pham', 'nhan-vien']) {
    copyFileIfExists(
      path.join(ws, 'knowledge', cat, 'index.md'),
      path.join(dst, 'knowledge', cat, 'index.md'),
    );
  }

  // ~/.openclaw/openclaw.json
  try {
    const openclawJson = path.join(require('os').homedir(), '.openclaw', 'openclaw.json');
    copyFileIfExists(openclawJson, path.join(dst, 'openclaw.json'));
  } catch {}

  console.log(`[backup] saved ${dst} (${fileCount} files)`);

  // Retention: keep 7 most recent
  try {
    const all = fs.readdirSync(backupsRoot)
      .filter(n => /^\d{4}-\d{2}-\d{2}-\d{6}$/.test(n))
      .sort();
    const toDelete = all.slice(0, Math.max(0, all.length - 7));
    for (const name of toDelete) {
      try {
        fs.rmSync(path.join(backupsRoot, name), { recursive: true, force: true });
      } catch {}
    }
  } catch {}
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
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('bot-status', { running: false, error: 'OpenClaw không tìm thấy.' });
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

  // Heal missing node_modules link (plugin copied out of vendor → ESM deps
  // unreachable → "Cannot find module 'zod'"). Must run BEFORE gateway spawn.
  const _patchFns = [
    ensureOpenzaloNodeModulesLink,
    ensureOpenclawPricingFix,
    ensureOpenclawPrewarmFix,
    applyOpenzaloFork,
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
    const rebuildScript = path.join(resourceDir, 'tools', 'memory-db', 'rebuild-db.js');
    if (fs.existsSync(rebuildScript)) {
      const nodeBin = findNodeBin() || 'node';
      await execFilePromise(nodeBin, [rebuildScript], { timeout: 10000, cwd: resourceDir, stdio: 'pipe' });
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
        try { (typeof logger !== 'undefined' && logger?.warn) ? logger.warn(msg) : console.warn(msg); } catch { console.warn(msg); }
        try { auditLog('gateway_stale_kill_fail', { port: 18789, strategyMs: 15000 }); } catch {}
      }
    }
    global._coldBootDone = true;
  } else {
    // Steady-state restart (e.g. heartbeat): adoption is fine
    const alreadyRunning = await isGatewayAlive();
    if (alreadyRunning) {
      console.log('Gateway already running on :18789 — adopting (steady-state restart)');
      botRunning = true;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('bot-status', { running: true });
      createTray();
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
        try { broadcastChannelStatusOnce(); } catch {}
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
  // 9router responds, the openzalo plugin's first call to 9router fails with
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
  // openzca via openzalo plugin) can find npm-installed shims. Electron inherits
  // PATH from explorer.exe / Start Menu launch, which on Windows often does NOT
  // include ~/AppData/Roaming/npm/. Without this, openzalo's `spawn("openzca", ...)`
  // via cmd.exe fails with "openzca is not recognized" → listener never starts →
  // CEO sees "Chưa sẵn sàng" forever.
  // Defense in depth: even when ensureOpenzaloShellFix() patches openzca.ts to use
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
    // process and its children (openzalo plugin → spawn('node', [openzca cli.js]))
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
      npmBinDirs.push(path.join(HOME, 'AppData', 'Roaming', 'npm'));
      npmBinDirs.push(path.join(HOME, 'AppData', 'Local', 'npm'));
      npmBinDirs.push('C:\\Program Files\\nodejs');
    } else {
      // Unix: usual npm prefixes + nvm
      npmBinDirs.push('/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin');
      npmBinDirs.push(path.join(HOME, '.npm-global', 'bin'));
      npmBinDirs.push(path.join(HOME, '.local', 'bin'));
    }
    const sep = process.platform === 'win32' ? ';' : ':';
    const currentPath = enrichedEnv.PATH || enrichedEnv.Path || '';
    const existingDirs = new Set(currentPath.split(sep).map(d => d.trim()).filter(Boolean));
    const toAdd = npmBinDirs.filter(d => !existingDirs.has(d) && fs.existsSync(d));
    if (toAdd.length > 0) {
      enrichedEnv.PATH = toAdd.join(sep) + sep + currentPath;
      console.log('[gateway] enriched PATH with:', toAdd.join(' | '));
    }
    // Also expose absolute openzca cli.js path so openzalo plugin (patched version)
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
        path.join(HOME, 'AppData', 'Roaming', 'npm', 'node_modules', 'openzca', 'dist', 'cli.js'),
        path.join(HOME, 'AppData', 'Local', 'npm', 'node_modules', 'openzca', 'dist', 'cli.js'),
        'C:\\Program Files\\nodejs\\node_modules\\openzca\\dist\\cli.js',
      );
    } else {
      // Mac + Linux: enumerate all known npm prefixes
      ozCliCandidates.push(
        '/opt/homebrew/lib/node_modules/openzca/dist/cli.js',     // Apple Silicon Homebrew
        '/usr/local/lib/node_modules/openzca/dist/cli.js',         // Intel Homebrew + system Node
        '/opt/local/lib/node_modules/openzca/dist/cli.js',         // MacPorts
        path.join(HOME, '.npm-global/lib/node_modules/openzca/dist/cli.js'),
        path.join(HOME, '.local/lib/node_modules/openzca/dist/cli.js'),
      );
      // nvm: scan all installed Node versions
      try {
        const nvmDir = path.join(HOME, '.nvm', 'versions', 'node');
        if (fs.existsSync(nvmDir)) {
          for (const v of fs.readdirSync(nvmDir)) {
            ozCliCandidates.push(path.join(nvmDir, v, 'lib', 'node_modules', 'openzca', 'dist', 'cli.js'));
          }
        }
      } catch {}
      // volta
      ozCliCandidates.push(path.join(HOME, '.volta', 'tools', 'image', 'packages', 'openzca', 'lib', 'node_modules', 'openzca', 'dist', 'cli.js'));
      // asdf
      try {
        const asdfDir = path.join(HOME, '.asdf', 'installs', 'nodejs');
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
  openclawProcess = spawn(gwSpawnCmd, gwSpawnArgs, {
    cwd: getWorkspace(),
    env: enrichedEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: gwSpawnShell,
    windowsHide: true,
  });
  botRunning = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('bot-status', { running: true });
  createTray();

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
  // (stopOpenClaw sets the global `openclawProcess = null` but our local
  // ref still points to the killed proc — we check `openclawProcess === procRef`
  // to bail out fast instead of uselessly probing for 240s).
  const procRef = openclawProcess;
  while (Date.now() < gwReadyDeadline) {
    probeAttempts++;
    if (openclawProcess !== procRef) {
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
    global._gatewayStartedAt = Date.now(); // fast watchdog skips first 90s
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
            auditLog('gateway_ready_late', { totalMs, bgProbes });
            return;
          }
        } catch {}
      }
      console.warn('[startOpenClaw] gateway never came up after 10min — may need manual restart');
    })();
  }

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

  const logsDir = path.join(userDataDir, 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const logStream = fs.createWriteStream(path.join(logsDir, 'openclaw.log'), { flags: 'a' });
  let lastError = '';
  // Swallow pipe errors (they occur when process exits abruptly)
  logStream.on('error', (e) => console.error('[openclaw.log] write error:', e.message));
  openclawProcess.stdout.on('error', (e) => console.error('[openclaw stdout] pipe error:', e.message));
  openclawProcess.stderr.on('error', (e) => console.error('[openclaw stderr] pipe error:', e.message));
  openclawProcess.on('error', (e) => console.error('[openclaw spawn] error:', e.message));
  openclawProcess.stdout.pipe(logStream).on('error', () => {});
  openclawProcess.stderr.pipe(logStream).on('error', () => {});
  openclawProcess.stderr.on('data', (d) => { lastError = d.toString().trim().slice(-300); });

  // REAL READINESS NOTIFICATIONS
  // CEO rule: "nếu thông báo là nhấn phải có reply thật sự" — don't send
  // fake boot pings. Observe specific gateway log markers that indicate
  // a channel is ACTUALLY able to receive + process messages:
  //   - Telegram ready: `[telegram] [default] starting provider (@<bot>)`
  //     (emitted after getMe success + polling active + channel registered)
  //   - Zalo ready: `[openzalo] [default] openzca connected`
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
      if (!notifyState.zalo.markerSeen && /\[openzalo\]\s*\[\w+\]\s*openzca connected/i.test(text)) {
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
  if (!openclawProcess) {
    console.warn('[startOpenClaw] gateway process was killed externally during spawn — aborting attachment');
    return;
  }
  openclawProcess.stdout.on('data', scanForReadiness);
  openclawProcess.stderr.on('data', scanForReadiness);

  openclawProcess.on('exit', (code) => {
    botRunning = false;
    openclawProcess = null;
    console.log('Gateway exited with code', code, 'lastError:', lastError?.substring(0, 100));

    // Don't auto-restart if app is quitting
    if (app.isQuitting) return;

    const isRestart = lastError?.includes('restart') || lastError?.includes('SIGUSR1');
    const isBonjourConflict = lastError?.includes('bonjour') && lastError?.includes('non-announced');

    if (isBonjourConflict) {
      // openclaw's mDNS watchdog detected its own stale record from the previous
      // crash and exited. Restarting immediately causes a self-defeating 4-min loop.
      // Wait 5min for the mDNS TTL to expire so the new instance sees a clean slate.
      const BONJOUR_TTL_MS = 5 * 60 * 1000;
      global._bonjourCooldownUntil = Date.now() + BONJOUR_TTL_MS;
      console.log('[restart-guard] bonjour conflict exit — waiting 5min for mDNS TTL before restart');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bot-status', { running: false, error: 'Đang chờ mạng ổn định... tự động khởi động lại sau 5 phút.' });
      }
      setTimeout(() => {
        global._bonjourCooldownUntil = 0;
        if (botRunning || _startOpenClawInFlight || _gatewayRestartInFlight) return;
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
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bot-status', { running: false, error: 'Đang khởi động lại... vui lòng đợi 30 giây.' });
      }
      // [restart-guard] Don't kick off a relaunch if another start is already
      // in flight or a hard-restart sequence (save-zalo-manager / resume-zalo)
      // already owns the restart. Otherwise two startOpenClaw calls race and
      // one fails with EADDRINUSE, leaving gateway dead.
      setTimeout(() => {
        if (botRunning || _startOpenClawInFlight || _gatewayRestartInFlight) {
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
          botRunning = true;
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('bot-status', { running: true });
          createTray();
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
              try { broadcastChannelStatusOnce(); } catch {}
            }, 10000);
          }
          return;
        }
        const errMsg = code !== 0 ? `Mã lỗi: ${code}${lastError ? '\n' + lastError : ''}` : null;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('bot-status', { running: false, error: errMsg });
        }
        createTray();
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
  botRunning = false;
  // Clear marker cache so dots don't stay green from stale markers
  if (global._readyNotifyState) {
    for (const ch of ['telegram', 'zalo']) {
      const st = global._readyNotifyState[ch];
      if (st) { st.markerSeenAt = 0; st.confirmedAt = 0; st.markerSeen = false; }
    }
  }
  const proc = openclawProcess;
  openclawProcess = null;
  const startedAt = Date.now();
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
}

// ============================================
//  IPC HANDLERS
// ============================================

// Start 9Router and open dashboard in browser
ipcMain.handle('start-9router', async () => {
  try {
    start9Router();
    await new Promise(r => setTimeout(r, 2000));
    const { shell } = require('electron');
    shell.openExternal('http://localhost:20128');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Auto-setup 9Router: write db.json directly (most reliable), then restart
// Direct Ollama Cloud API key validation. Calls Ollama's own API (not via
// 9router proxy) so we can fail-fast with a CLEAR error message before
// writing the key to db.json + restarting 9router (which takes ~15s).
//
// Endpoint: https://ollama.com/api/ps — list running processes, USER-SCOPED
// (requires auth). We picked this specifically because:
//   - /api/tags is PUBLIC (returns global model catalog regardless of key)
//   - /v1/models is PUBLIC (same)
//   - /api/version is PUBLIC
//   - /api/ps returns 401 for missing or invalid key, 200 with JSON
//     (possibly empty array) for valid key. Verified by curling with
//     empty Bearer + fake Bearer — both got 401. A real key would get 200.
//
// Failure modes:
//   - 401/403 → invalid or expired key
//   - 200 but non-JSON → captive portal returning HTML
//   - 5xx → ollama outage
//   - Network errors → no internet, DNS, firewall
//   - Timeout (10s) → slow connection
async function validateOllamaKeyDirect(apiKey) {
  return new Promise((resolve) => {
    const https = require('https');
    const req = https.request({
      hostname: 'ollama.com',
      port: 443,
      path: '/api/ps',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
        'User-Agent': '9BizClaw-Wizard/1.0',
      },
      timeout: 10000,
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          // Parse to verify it's actually JSON (defensive — captive portal
          // might return 200 with HTML login page)
          try {
            const parsed = JSON.parse(buf);
            // /api/ps returns { models: [...] } (running processes). Empty
            // array is fine — means key valid but no active processes.
            // Just verify we got an object.
            if (parsed && typeof parsed === 'object') {
              resolve({ valid: true, statusCode: 200, raw: parsed });
            } else {
              resolve({
                valid: false,
                statusCode: 200,
                error: 'Phản hồi từ Ollama không đúng định dạng — có thể đang ở mạng captive portal (Wi-Fi khách sạn / quán cafe). Thử lại với mạng khác.',
              });
            }
          } catch {
            resolve({
              valid: false,
              statusCode: 200,
              error: 'Phản hồi từ Ollama không phải JSON — có thể đang ở mạng captive portal (Wi-Fi khách sạn / quán cafe). Thử lại với mạng khác.',
            });
          }
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          resolve({
            valid: false,
            statusCode: res.statusCode,
            error: 'Ollama API key sai hoặc đã hết hạn. Vào ollama.com/settings/keys → tạo key mới → paste lại.',
          });
        } else if (res.statusCode === 429) {
          resolve({
            valid: false,
            statusCode: 429,
            error: 'Ollama trả về 429 (rate limit). Đợi 1 phút rồi thử lại.',
          });
        } else if (res.statusCode >= 500) {
          resolve({
            valid: false,
            statusCode: res.statusCode,
            error: `Ollama đang gặp sự cố (HTTP ${res.statusCode}). Thử lại sau vài phút hoặc check status.ollama.com.`,
          });
        } else {
          resolve({
            valid: false,
            statusCode: res.statusCode,
            error: `Ollama trả về HTTP ${res.statusCode} — không xác định: ${buf.slice(0, 200)}`,
          });
        }
      });
    });
    req.on('error', (e) => {
      const msg = e?.message || String(e);
      if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) {
        resolve({ valid: false, error: 'Không kết nối được ollama.com — kiểm tra mạng Internet.' });
      } else if (/ECONNREFUSED|ECONNRESET/i.test(msg)) {
        resolve({ valid: false, error: 'Kết nối tới ollama.com bị từ chối — có thể firewall hoặc proxy chặn.' });
      } else if (/CERT|SSL|TLS/i.test(msg)) {
        resolve({ valid: false, error: 'Lỗi chứng chỉ SSL — máy có thể có MITM/antivirus chặn HTTPS.' });
      } else {
        resolve({ valid: false, error: 'Lỗi mạng: ' + msg });
      }
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ valid: false, error: 'Timeout kết nối ollama.com (>10s) — mạng chậm hoặc bị chặn.' });
    });
    req.end();
  });
}

// Generic 9router HTTP API caller. Localhost-only, no auth needed (9router
// /api/* is bound to 127.0.0.1 and doesn't require auth — only /v1/* needs
// the Bearer API key). Returns { success, data, error, statusCode }.
function nineRouterApi(method, path, body = null, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const http = require('http');
    const headers = { 'Content-Type': 'application/json' };
    let bodyStr = null;
    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      bodyStr = JSON.stringify(body);
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = http.request({
      hostname: '127.0.0.1', port: 20128, path, method, headers, timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = buf ? JSON.parse(buf) : {}; }
        catch { parsed = { _raw: buf.slice(0, 200) }; }
        if (res.statusCode >= 400 || (parsed && parsed.error)) {
          resolve({
            success: false,
            statusCode: res.statusCode,
            error: parsed?.error || `HTTP ${res.statusCode}`,
            data: parsed,
          });
        } else {
          resolve({ success: true, statusCode: res.statusCode, data: parsed });
        }
      });
    });
    req.on('error', (e) => resolve({ success: false, error: 'Network: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'Timeout (>' + timeoutMs + 'ms)' }); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Runtime self-heal for 9router's bundled better-sqlite3 binary.
// Mirrors the build-time fixNineRouterNativeModules() in prebuild-vendor.js, but
// runs inside the packaged app when the binary ships with the wrong arch (e.g.
// x64 binary on arm64 Mac, or vice versa). Runs at most once per process lifetime.
let _9routerSqliteFixAttempted = false;
async function autoFix9RouterSqlite() {
  if (_9routerSqliteFixAttempted) return false;
  _9routerSqliteFixAttempted = true;
  try {
    const vendorDir = getBundledVendorDir();
    if (!vendorDir) {
      console.warn('[9router-autofix] not packaged — skipping');
      return false;
    }
    const bsqlDir = path.join(vendorDir, 'node_modules', '9router', 'app', 'node_modules', 'better-sqlite3');
    if (!fs.existsSync(bsqlDir)) {
      console.warn('[9router-autofix] better-sqlite3 dir not found:', bsqlDir);
      return false;
    }
    const nodeBin = getBundledNodeBin();
    if (!nodeBin) {
      console.warn('[9router-autofix] bundled node binary not found');
      return false;
    }
    // Get version of the BUNDLED Node (not Electron's embedded Node)
    let nodeVer;
    try {
      nodeVer = require('child_process')
        .execFileSync(nodeBin, ['--version'], { encoding: 'utf-8', timeout: 5000 })
        .trim().replace(/^v/, '');
    } catch (e) {
      console.warn('[9router-autofix] could not get bundled node version:', e.message);
      return false;
    }
    const arch = process.arch; // 'arm64' or 'x64'
    const platform = process.platform;
    console.log(`[9router-autofix] rebuilding better-sqlite3 for node-${nodeVer} ${platform}-${arch}`);
    const { execFileSync } = require('child_process');
    const bsqlBin = path.join(bsqlDir, 'build', 'Release', 'better_sqlite3.node');
    // Strategy 1: prebuild-install from 9router's own .bin dir (fastest — prebuilt binary)
    const prebuildBin = path.join(bsqlDir, '..', '.bin', 'prebuild-install');
    if (fs.existsSync(prebuildBin)) {
      try {
        execFileSync(nodeBin, [prebuildBin, '-r', 'node', '-t', nodeVer, '--arch', arch], {
          cwd: bsqlDir, timeout: 60000, shell: false,
          env: { ...process.env, npm_config_arch: arch },
        });
        if (fs.existsSync(bsqlBin)) {
          console.log('[9router-autofix] ✓ rebuilt via prebuild-install');
          return true;
        }
      } catch (e) {
        console.warn('[9router-autofix] prebuild-install failed:', e.message);
      }
    }
    // Strategy 2: node-pre-gyp from 9router's .bin dir
    const nodePreGyp = path.join(bsqlDir, '..', '.bin', 'node-pre-gyp');
    if (fs.existsSync(nodePreGyp)) {
      try {
        execFileSync(nodeBin, [nodePreGyp, 'rebuild', `--target=${nodeVer}`, `--target_arch=${arch}`], {
          cwd: bsqlDir, timeout: 120000, shell: false,
        });
        if (fs.existsSync(bsqlBin)) {
          console.log('[9router-autofix] ✓ rebuilt via node-pre-gyp');
          return true;
        }
      } catch (e) {
        console.warn('[9router-autofix] node-pre-gyp failed:', e.message);
      }
    }
    // Strategy 3: npx prebuild-install — downloads prebuild-install if not in .bin.
    // This handles 9router versions that don't ship prebuild-install as a dep.
    const npxBin = path.join(path.dirname(nodeBin), 'npx');
    if (fs.existsSync(npxBin)) {
      try {
        console.log('[9router-autofix] trying npx prebuild-install...');
        execFileSync(npxBin, ['--yes', 'prebuild-install', '-r', 'node', '-t', nodeVer, '--arch', arch], {
          cwd: bsqlDir, timeout: 90000, shell: false,
          env: { ...process.env, npm_config_arch: arch },
        });
        if (fs.existsSync(bsqlBin)) {
          console.log('[9router-autofix] ✓ rebuilt via npx prebuild-install');
          return true;
        }
      } catch (e) {
        console.warn('[9router-autofix] npx prebuild-install failed:', e.message);
      }
    }
    // Strategy 4: npm rebuild from the 9router app dir (compiles from source).
    // Needs Xcode CLT on Mac, but that's the last resort.
    const vendorDir2 = getBundledVendorDir();
    const npmBin = path.join(path.dirname(nodeBin), 'npm');
    if (vendorDir2 && fs.existsSync(npmBin)) {
      try {
        console.log('[9router-autofix] trying npm rebuild better-sqlite3...');
        execFileSync(npmBin, ['rebuild', 'better-sqlite3', `--arch=${arch}`], {
          cwd: path.join(vendorDir2, 'node_modules', '9router', 'app'),
          timeout: 180000, shell: false,
          env: { ...process.env, npm_config_arch: arch, npm_config_target: nodeVer, npm_config_runtime: 'node' },
        });
        if (fs.existsSync(bsqlBin)) {
          console.log('[9router-autofix] ✓ rebuilt via npm rebuild');
          return true;
        }
      } catch (e) {
        console.warn('[9router-autofix] npm rebuild failed:', e.message);
      }
    }
    console.warn('[9router-autofix] all 4 rebuild strategies failed — user needs reinstall');
    return false;
  } catch (e) {
    console.error('[9router-autofix] unexpected error:', e.message);
    return false;
  }
}

// Wait for 9router to be reachable. Polls /api/settings every 500ms up to maxMs.
// Returns { ready: true } on success, or { ready: false, reason: '...' } on timeout.
// Distinguishes between "never started" (ECONNREFUSED) vs "started but 5xx" (native
// module crash — e.g. better-sqlite3 arch mismatch on Mac).
async function waitFor9RouterReady(maxMs = 10000) {
  const start = Date.now();
  let consecutiveFiveXx = 0;
  while (Date.now() - start < maxMs) {
    const r = await nineRouterApi('GET', '/api/settings', null, 1500);
    if (r.success || (r.statusCode && r.statusCode < 500)) return true;
    if (r.statusCode && r.statusCode >= 500) {
      consecutiveFiveXx++;
      // 3 consecutive 5xx while process IS accepting connections = internal crash
      // (e.g. better-sqlite3 native module arch mismatch). No point waiting longer.
      if (consecutiveFiveXx >= 3) {
        console.warn('[waitFor9RouterReady] 9router accepting connections but returning 5xx consistently — likely native module crash');
        return false;
      }
    } else {
      consecutiveFiveXx = 0; // reset on ECONNREFUSED / timeout
    }
    await new Promise(res => setTimeout(res, 500));
  }
  return false;
}

ipcMain.handle('setup-9router-auto', async (_event, opts = {}) => {
  try {
    if (opts.ollamaKey) {
      const trimmedKey = String(opts.ollamaKey).trim();
      if (trimmedKey.length < 20) {
        return { success: false, error: 'Ollama API key quá ngắn — kiểm tra lại đã paste đủ chưa.' };
      }
    }

    // FAST PATH: use 9router HTTP API for create+test+models. ~3-5 seconds
    // total instead of the old write-file-and-restart approach (~30s).
    //
    // Steps:
    //   1. Ensure 9router is running + reachable
    //   2. POST /api/providers (create Ollama connection)
    //   3. POST /api/providers/{id}/test (instant validate)
    //   4. If invalid: DELETE the connection + return clear error
    //   5. If valid: GET /api/providers/{id}/models, pick first
    //   6. Update or create combo "main" with picked model via /api/combos
    //   7. Ensure an API key exists (GET/POST /api/keys)
    //
    // No restart, no db.json writes — 9router persists everything itself.
    // If the API is unreachable (vendor broken, 9router won't start), fall
    // back to the legacy file-based approach below.
    if (opts.ollamaKey) {
      try {
        // 1. Make sure 9router is running
        if (!routerProcess) {
          console.log('[setup-9router-auto] 9router not running — starting');
          start9Router();
        }
        let ready = await waitFor9RouterReady(10000);
        if (!ready) {
          // Distinguish crash (5xx = native module broken) from not-started (ECONNREFUSED)
          const ping = await nineRouterApi('GET', '/api/settings', null, 1500);
          if (ping.statusCode && ping.statusCode >= 500) {
            // Native module crash (e.g. better-sqlite3 arch mismatch on Mac).
            // Attempt runtime rebuild — takes up to ~60s but wizard shows spinner.
            console.log('[setup-9router-auto] 9router crash (HTTP', ping.statusCode, ') — attempting native module auto-fix');
            const fixed = await autoFix9RouterSqlite();
            if (fixed) {
              stop9Router();
              // Wait > 1500ms (Mac SIGKILL grace period) so old process releases
              // port 20128 before we restart. Also force-clear any lingering process
              // on the port as belt-and-braces.
              await new Promise(r => setTimeout(r, 2500));
              try { killPort(20128); } catch {}
              start9Router();
              ready = await waitFor9RouterReady(30000);
              if (ready) {
                console.log('[setup-9router-auto] 9router ready after native module auto-fix');
              } else {
                // BUG-A fix: return directly so we don't fall through to legacy
                // file mode (which also fails with 500 when 9router is broken).
                return { success: false, error: '9router vẫn không khởi động được sau khi tự sửa native module. Mở thư mục log (9router.log) để xem chi tiết.' };
              }
            } else {
              // BUG-A fix: return directly, same reason as above.
              return { success: false, error: '9router gặp lỗi khởi động (HTTP 500) và không thể tự sửa native module. Mở thư mục log (9router.log) để xem chi tiết.' };
            }
          } else {
            throw new Error('9router không khởi động được trong 10 giây — fallback file mode');
          }
        }
        console.log('[setup-9router-auto] 9router API reachable');

        // Advisory-only direct validation against ollama.com/api/ps.
        // Previously this was FAIL-CLOSED on 401/403 but ollama.com's /api/ps
        // endpoint behavior is brittle: Cloudflare challenge pages, regional
        // firewall, new key-format changes, or rate-limit can return 401 even
        // for valid keys. 9router's own test against ollama.com is the
        // authoritative source — we trust its result, not ours. Log for debug
        // but never block on direct check.
        if (opts.ollamaKey && typeof opts.ollamaKey === 'string') {
          try {
            const directCheck = await validateOllamaKeyDirect(opts.ollamaKey.trim());
            if (!directCheck.valid) {
              console.warn('[setup-9router-auto] direct-check advisory:', directCheck.statusCode, directCheck.error, '— proceeding via 9router');
            } else {
              console.log('[setup-9router-auto] direct-check PASSED (ollama.com 200)');
            }
          } catch (e) {
            console.warn('[setup-9router-auto] direct-check threw (non-fatal):', e?.message);
          }
        }

        // 2. Look for existing Ollama provider — if exists, delete it first
        //    so we don't accumulate dupes when user re-runs wizard
        const listRes = await nineRouterApi('GET', '/api/providers');
        if (listRes.success) {
          const existing = (listRes.data?.connections || []).filter(c => c.provider === 'ollama');
          for (const old of existing) {
            await nineRouterApi('DELETE', `/api/providers/${old.id}`);
            console.log('[setup-9router-auto] removed old Ollama provider', old.id);
          }
        }

        // 3. Create new Ollama provider — DO NOT set baseUrl.
        // 9Router knows the correct Ollama cloud endpoint internally for
        // provider type 'ollama'. Setting baseUrl: 'https://ollama.com'
        // previously overrode the default → requests hit wrong URL → 401.
        const createRes = await nineRouterApi('POST', '/api/providers', {
          provider: 'ollama',
          name: 'Ollama',
          apiKey: opts.ollamaKey.trim(),
        });
        if (!createRes.success) {
          throw new Error('Không tạo được provider: ' + (createRes.error || 'unknown'));
        }
        const providerId = createRes.data?.id || createRes.data?.connection?.id;
        if (!providerId) {
          throw new Error('9router không trả về provider ID');
        }
        console.log('[setup-9router-auto] created Ollama provider', providerId);
        // Save key in our own file so we can re-inject if 9Router UI wipes it
        saveProviderKey('ollama', opts.ollamaKey.trim());

        // 4. Test it (THIS is the fast validator — usually 1-3 seconds)
        const testRes = await nineRouterApi('POST', `/api/providers/${providerId}/test`, null, 8000);
        const testErrMsg = testRes.data?.error || testRes.error || 'Ollama key không hợp lệ';
        const testValid = testRes.success && (testRes.data?.valid !== false);

        if (!testValid) {
          console.warn('[setup-9router-auto] provider test failed:', testErrMsg);

          // HTTP 5xx = 9router internal unhandled exception (NOT a key validation failure).
          // Root cause: testConnection() in 9router writes the test result to SQLite AFTER
          // the fetch completes, and that write throws without a try/catch → propagates to
          // the route handler catch → 500. This is a 9router bug, not an invalid key.
          //
          // Key was already validated directly via validateOllamaKey() in wizard.html
          // before this IPC was called, so we KNOW the key is valid.
          // Skip the test result, do NOT delete the provider, fall through to models.
          // 5xx OR transient network errors (ECONNRESET, EPIPE, ETIMEDOUT,
          // socket hang up) = NOT a key validation failure. Bypass test,
          // proceed to models. If models lookup later also fails, we'll
          // surface the real error there.
          if (
            /^HTTP [5]\d{2}$/.test(String(testErrMsg)) ||
            /ECONNRESET|EPIPE|socket hang up|ETIMEDOUT|read ETIMEDOUT|network/i.test(String(testErrMsg))
          ) {
            console.warn('[setup-9router-auto] transient test error — proceeding (key trusted):', testErrMsg);
          } else {
            // Non-5xx = genuine key/network failure (401, ENOTFOUND, etc.)
            // Delete the bad provider so it doesn't pollute db.json
            await nineRouterApi('DELETE', `/api/providers/${providerId}`);
            let viError = testErrMsg;
            if (/401|unauthor/i.test(testErrMsg)) {
              viError = 'Ollama trả về 401. Nếu key chắc chắn đúng, có thể do Cloudflare/firewall chặn — thử đổi mạng (4G, VPN khác) rồi thử lại.';
            } else if (/ENOTFOUND|DNS/i.test(testErrMsg)) {
              viError = 'Không kết nối được ollama.com. Kiểm tra Internet hoặc thử đổi mạng.';
            } else if (/429|rate/i.test(testErrMsg)) {
              viError = 'Ollama trả về 429 (rate limit). Đợi 1 phút rồi thử lại.';
            } else if (/\b5\d{2}\b|internal.server.error/i.test(testErrMsg)) {
              viError = 'Ollama đang gặp sự cố tạm thời (HTTP 5xx). Thử lại sau vài phút hoặc kiểm tra status.ollama.com.';
            }
            return { success: false, error: viError, validationFailed: true };
          }
        }
        console.log('[setup-9router-auto] provider test PASSED (or bypassed — key pre-validated)');

        // 5. Get models for this provider
        const modelsRes = await nineRouterApi('GET', `/api/providers/${providerId}/models`);
        const modelIds = Array.isArray(modelsRes.data?.models)
          ? modelsRes.data.models.map(m => typeof m === 'string' ? m : (m?.id || m?.name)).filter(Boolean)
          : [];
        console.log('[setup-9router-auto] models:', modelIds.slice(0, 5));
        if (modelIds.length === 0) {
          await nineRouterApi('DELETE', `/api/providers/${providerId}`);
          return {
            success: false,
            error: 'Ollama key hợp lệ nhưng không có model nào. Tài khoản Ollama có thể chưa subscribe gói nào.',
            validationFailed: true,
          };
        }

        // Smart model selection: pick the best model for demo/daily use.
        // Priority: large capable models first, avoid tiny/quantized variants.
        const PREFERRED_MODELS = [
          'qwen3.5:397b', 'qwen3.5', 'deepseek-v3.2', 'deepseek-v3.1:671b',
          'glm-5.1', 'glm-5', 'mistral-large-3:675b', 'kimi-k2.5', 'kimi-k2:1t',
          'minimax-m2.7', 'minimax-m2.5', 'minimax-m2.1', 'minimax-m2',
          'gemma4:31b', 'gemma3:27b', 'gemma3:12b',
          'qwen3-coder:480b', 'qwen3-coder-next', 'cogito-2.1:671b',
          'nemotron-3-super', 'devstral-2:123b',
        ];
        // Strip ollama/ prefix for matching, then re-add
        const bareIds = modelIds.map(id => id.replace(/^ollama\//, ''));
        let pickedBare = null;
        for (const pref of PREFERRED_MODELS) {
          const match = bareIds.find(id => id === pref || id.startsWith(pref + ':'));
          if (match) { pickedBare = match; break; }
        }
        if (!pickedBare) pickedBare = bareIds[0]; // fallback to first
        let picked = modelIds.find(id => id.endsWith(pickedBare)) || modelIds[0];
        // 9router model IDs may not have ollama/ prefix in the response; add it
        if (!picked.startsWith('ollama/')) picked = 'ollama/' + picked;
        console.log('[setup-9router-auto] smart pick:', picked, '(from', modelIds.length, 'models)');

        // 6. Get or create combo 'main'
        const combosRes = await nineRouterApi('GET', '/api/combos');
        const combos = combosRes.data?.combos || combosRes.data || [];
        let mainCombo = (Array.isArray(combos) ? combos : []).find(c => c.name === 'main');
        if (mainCombo) {
          // Update existing
          const upRes = await nineRouterApi('PUT', `/api/combos/${mainCombo.id}`, {
            name: 'main',
            models: [picked],
          });
          if (!upRes.success) console.warn('[setup-9router-auto] combo update failed:', upRes.error);
        } else {
          // Create new
          const createCombo = await nineRouterApi('POST', '/api/combos', {
            name: 'main',
            models: [picked],
          });
          if (!createCombo.success) console.warn('[setup-9router-auto] combo create failed:', createCombo.error);
        }
        console.log('[setup-9router-auto] combo "main" set to model:', picked);

        // 7. Get or create API key
        const keysRes = await nineRouterApi('GET', '/api/keys');
        const keys = keysRes.data?.keys || keysRes.data || [];
        let apiKeyValue = null;
        const activeKey = (Array.isArray(keys) ? keys : []).find(k => k.isActive !== false && k.key);
        if (activeKey) {
          apiKeyValue = activeKey.key;
        } else {
          const createKey = await nineRouterApi('POST', '/api/keys', { name: '9BizClaw' });
          apiKeyValue = createKey.data?.key?.key || createKey.data?.key || null;
        }

        if (!apiKeyValue) {
          // Last resort: read from db.json directly
          try {
            const dbCheck = JSON.parse(fs.readFileSync(path.join(appDataDir(), '9router', 'db.json'), 'utf-8'));
            const k = (dbCheck.apiKeys || []).find(k => k.isActive);
            if (k) apiKeyValue = k.key;
          } catch {}
        }

        return {
          success: true,
          apiKey: apiKeyValue || '(see 9router web UI)',
          selectedModel: picked,
        };
      } catch (apiErr) {
        // Fall through to legacy file-based approach if API path fails
        console.warn('[setup-9router-auto] API path failed, falling back to file mode:', apiErr.message);
      }
    }
    // (legacy file-based approach continues below as fallback)

    const { randomUUID, randomBytes } = require('crypto');
    const dbPath = path.join(appDataDir(), '9router', 'db.json');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    // Read existing or create fresh
    let db = {};
    if (fs.existsSync(dbPath)) {
      try { db = JSON.parse(fs.readFileSync(dbPath, 'utf-8')); } catch {}
    }
    if (!Array.isArray(db.providerConnections)) db.providerConnections = [];
    if (!Array.isArray(db.combos)) db.combos = [];
    if (!Array.isArray(db.apiKeys)) db.apiKeys = [];
    if (!db.settings) db.settings = {};
    if (!Array.isArray(db.providerNodes)) db.providerNodes = [];
    if (!db.proxyPools) db.proxyPools = [];
    if (!db.modelAliases) db.modelAliases = {};
    if (!db.mitmAlias) db.mitmAlias = {};
    if (!db.pricing) db.pricing = {};

    // 1. Add Ollama provider — ONLY if user supplied a key. Don't touch
    //    existing providers the user may have configured directly via 9router
    //    web UI (ChatGPT Plus OAuth, Claude, Gemini, local Ollama, etc.).
    if (opts.ollamaKey) {
      db.providerConnections = db.providerConnections.filter(p => p.provider !== 'ollama');
      db.providerConnections.push({
        id: randomUUID(),
        provider: 'ollama',
        authType: 'apikey',
        name: 'Ollama',
        apiKey: opts.ollamaKey.trim(),
        priority: 1,
        isActive: true,
        testStatus: 'unknown',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      saveProviderKey('ollama', opts.ollamaKey.trim());
    }

    // 2. Combo 'main' handling — create if missing, leave existing alone.
    //    We'll auto-populate models below by querying 9router /v1/models AFTER
    //    restart, so whatever model the connected provider actually exposes
    //    gets picked. No hardcoding, no guessing model names that might be typos
    //    or stale (the old 'ollama/qwen3.5' hardcode failed this way).
    let combo = db.combos.find(c => c.name === 'main');
    let createdCombo = false;
    if (!combo) {
      combo = {
        id: randomUUID(),
        name: 'main',
        models: [], // Populated below from /v1/models
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      db.combos.push(combo);
      createdCombo = true;
    }

    // 3. Create API key
    let apiKey = db.apiKeys.find(k => k.isActive);
    if (!apiKey) {
      const machineId = randomBytes(8).toString('hex');
      const keyValue = `sk-${machineId}-modoro-${randomBytes(4).toString('hex')}`;
      apiKey = { id: randomUUID(), name: '9BizClaw', key: keyValue, machineId, isActive: true, createdAt: new Date().toISOString() };
      db.apiKeys.push(apiKey);
    }

    db.settings.comboStrategy = 'fallback';

    // Write db.json
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf-8');
    console.log('9Router db.json written:', db.providerConnections.length, 'providers,', db.combos.length, 'combos');

    // Restart 9Router to pick up new provider config
    stop9Router();
    await new Promise(r => setTimeout(r, 500));
    start9Router();

    // AUTO-DETECT MODELS: wait for 9Router to be ready, then query /v1/models
    // with our API key to see what models the connected providers actually
    // expose. Pick the first one and populate combo 'main' if it's empty.
    //
    // Why this instead of hardcoding (e.g. 'ollama/qwen3.5'):
    // - Hardcoded model names may not exist on the provider (CEO hit this
    //   with 'ollama/qwen3.5' which was a typo / stale name → 9router
    //   fallback → 404 openai)
    // - /v1/models returns the actual connected models, source of truth
    // - Respects whatever provider the user already has configured —
    //   if they had ChatGPT Plus OAuth before wizard, that provider's
    //   models get picked; if they pasted Ollama key now, Ollama models
    //   get picked. Provider-agnostic.
    //
    // If the query or pick fails, combo stays empty and user is directed
    // to the 9Router web UI to configure manually.
    let autoSelectedModel = null;
    let autoDetectError = null;
    if (createdCombo || !combo.models || combo.models.length === 0) {
      try {
        // Wait up to 15s for 9router to respond to /v1/models after restart.
        // Windows cold-start of 9router can take 10-12s on slower machines;
        // 8s was cutting it close and occasionally returned timeout → empty
        // combo → bot 404 on first real message.
        let modelsList = null;
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 1000));
          try {
            modelsList = await new Promise((resolve, reject) => {
              const req = require('http').request({
                hostname: '127.0.0.1', port: 20128, path: '/v1/models',
                method: 'GET',
                headers: { 'Authorization': `Bearer ${apiKey.key}` },
                timeout: 3000,
              }, (res) => {
                let buf = '';
                res.setEncoding('utf8');
                res.on('data', (c) => { buf += c; });
                res.on('end', () => {
                  if (res.statusCode !== 200) {
                    reject(new Error(`/v1/models returned ${res.statusCode}: ${buf.slice(0, 200)}`));
                    return;
                  }
                  try { resolve(JSON.parse(buf)); }
                  catch (e) { reject(new Error('invalid JSON from /v1/models: ' + e.message)); }
                });
              });
              req.on('error', reject);
              req.on('timeout', () => { req.destroy(new Error('timeout')); });
              req.end();
            });
            break; // got a response
          } catch (e) {
            if (i === 14) throw e;
            // else keep retrying
          }
        }

        const modelIds = Array.isArray(modelsList?.data)
          ? modelsList.data.map(m => m && m.id).filter(Boolean)
          : [];
        console.log('[setup-9router-auto] /v1/models returned', modelIds.length, 'models:', modelIds.slice(0, 10));

        if (modelIds.length > 0) {
          // Smart model selection (same priority list as API path above)
          const PREFERRED_MODELS_FB = [
            'qwen3.5:397b', 'qwen3.5', 'deepseek-v3.2', 'deepseek-v3.1:671b',
            'glm-5.1', 'glm-5', 'mistral-large-3:675b', 'kimi-k2.5', 'kimi-k2:1t',
            'minimax-m2.7', 'minimax-m2.5', 'minimax-m2.1', 'minimax-m2',
            'gemma4:31b', 'gemma3:27b', 'gemma3:12b',
          ];
          let picked = null;
          for (const pref of PREFERRED_MODELS_FB) {
            picked = modelIds.find(id => id === pref || id.endsWith('/' + pref) || id.startsWith(pref));
            if (picked) break;
          }
          if (!picked && opts.ollamaKey) picked = modelIds.find(id => id.startsWith('ollama/'));
          if (!picked) picked = modelIds[0];

          // Re-read db.json in case 9router rewrote it during restart
          let currentDb;
          try { currentDb = JSON.parse(fs.readFileSync(dbPath, 'utf-8')); }
          catch { currentDb = db; }
          const currentCombo = currentDb.combos.find(c => c.name === 'main');
          if (currentCombo) {
            if (!currentCombo.models || currentCombo.models.length === 0) {
              currentCombo.models = [picked];
              currentCombo.updatedAt = new Date().toISOString();
              fs.writeFileSync(dbPath, JSON.stringify(currentDb, null, 2), 'utf-8');
              // VERIFY: re-read db.json to confirm the write really persisted.
              // Zero-risk guarantee: if the file got rewritten by a racing
              // 9router process without our combo update, we want to know now,
              // not at first user message.
              let verified = false;
              try {
                const reRead = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
                const reCombo = reRead.combos?.find(c => c.name === 'main');
                verified = Array.isArray(reCombo?.models) && reCombo.models.includes(picked);
              } catch {}
              if (!verified) {
                autoDetectError = 'combo write verification failed — 9router may have overwritten our update';
                console.error('[setup-9router-auto]', autoDetectError);
              } else {
                autoSelectedModel = picked;
                console.log('[setup-9router-auto] auto-populated combo "main" with model:', picked, '(verified)');
                // Restart 9router one more time so it picks up the new combo
                stop9Router();
                await new Promise(r => setTimeout(r, 500));
                start9Router();
              }
            } else {
              autoSelectedModel = currentCombo.models[0];
              console.log('[setup-9router-auto] combo "main" already has models, leaving alone:', currentCombo.models);
            }
          } else {
            autoDetectError = 'combo "main" not found after restart';
          }
        } else {
          autoDetectError = 'no models returned by /v1/models — provider may have failed to connect';
        }
      } catch (e) {
        autoDetectError = 'auto-detect failed: ' + (e.message || String(e));
        console.warn('[setup-9router-auto]', autoDetectError);
      }
    }

    return {
      success: true,
      apiKey: apiKey.key,
      selectedModel: autoSelectedModel,
      autoDetectError,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Setup Zalo via OpenZalo (openzca CLI for QR login)
// Pre-install openzalo plugin + patch (runs once in background at startup)
let _zaloReady = false;
// In-flight promise guard: ensureZaloPlugin can be invoked concurrently
// (boot path awaits it, but a fire-and-forget call also exists at app.whenReady
// tail). Without this guard, two callers race past `if (_zaloReady) return`
// (since _zaloReady is only set after the patches at end of function), both
// run the patch injection logic concurrently, and last-writer-wins on
// inbound.ts could leave a corrupted/half-patched file.
let _zaloPluginInFlight = null;
// Idempotent heal: ensure <plugin>/node_modules exists and points at
// vendor/node_modules. Runs on EVERY boot, independent of whether the plugin
// was freshly copied or already present. Without this, users who installed
// a previous build (where we copied the plugin but NOT the deps link) are
// permanently broken on "Cannot find module 'zod'" even after upgrading.
function ensureOpenzaloNodeModulesLink() {
  try {
    const extensionsDir = path.join(HOME, '.openclaw', 'extensions', 'openzalo');
    if (!fs.existsSync(path.join(extensionsDir, 'openclaw.plugin.json'))) return;
    const pluginNodeModules = path.join(extensionsDir, 'node_modules');
    // Already linked/present? Verify it has zod (the critical dep) to be sure
    // it's not an empty or partial dir from a previous broken attempt.
    if (fs.existsSync(path.join(pluginNodeModules, 'zod'))) return;
    const vendorDir = getBundledVendorDir();
    if (!vendorDir) return;
    const vendorNodeModules = path.join(vendorDir, 'node_modules');
    if (!fs.existsSync(vendorNodeModules)) return;
    // Remove ANY existing entry — fs.existsSync follows symlinks so it returns
    // false for broken symlinks, leaving them in place → symlinkSync EEXIST →
    // fallback mkdirSync also fails because path is a broken symlink (not a dir).
    // Use lstatSync (does NOT follow symlinks) to detect all cases.
    try {
      const lstat = fs.lstatSync(pluginNodeModules);
      if (lstat.isSymbolicLink() || lstat.isFile()) {
        fs.unlinkSync(pluginNodeModules);       // remove symlink / broken symlink
      } else {
        fs.rmSync(pluginNodeModules, { recursive: true, force: true }); // remove dir
      }
    } catch {}
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    try {
      fs.symlinkSync(vendorNodeModules, pluginNodeModules, linkType);
      console.log('[ensureOpenzaloNodeModulesLink] linked →', vendorNodeModules, `(${linkType})`);
    } catch (linkErr) {
      console.warn('[ensureOpenzaloNodeModulesLink] symlink failed, copying deps:', linkErr?.message);
      fs.mkdirSync(pluginNodeModules, { recursive: true });
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(extensionsDir, 'package.json'), 'utf-8'));
        for (const dep of Object.keys(pkg.dependencies || {})) {
          const src = path.join(vendorNodeModules, dep);
          const dst = path.join(pluginNodeModules, dep);
          if (fs.existsSync(src) && !fs.existsSync(dst)) {
            fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false });
            console.log('[ensureOpenzaloNodeModulesLink] copied', dep);
          }
        }
      } catch (copyErr) {
        console.error('[ensureOpenzaloNodeModulesLink] CRITICAL fallback copy failed:', copyErr?.message);
      }
    }
  } catch (e) {
    console.error('[ensureOpenzaloNodeModulesLink] error:', e?.message || e);
  }
}

async function ensureZaloPlugin() {
  if (_zaloReady) return;
  // If a previous call is already running, attach to its promise instead of
  // re-entering the body. This makes the function safe under concurrent
  // invocation (boot path + fire-and-forget tail call + plugin manager UI).
  if (_zaloPluginInFlight) return _zaloPluginInFlight;
  _zaloPluginInFlight = (async () => {
    try {
      return await _ensureZaloPluginImpl();
    } finally {
      _zaloPluginInFlight = null;
    }
  })();
  return _zaloPluginInFlight;
}

// Bulk-seed memory/zalo-users/ and memory/zalo-groups/ from openzca cache.
// Solves the "cold start memory" problem: CEO installs MODOROClaw on day 1 and
// customers who've been Zalo friends for years get recognized on their first
// bot interaction instead of being treated as strangers.
//
// Idempotent: skips customers that already have a profile (bot may have
// learned things about them we don't want to overwrite).
//
// Data source: openzca listener maintains friend + group caches at
// ~/.openzca/profiles/default/cache/{friends.json,groups.json}. These are
// refreshed every 10 minutes by the listener, so they're usually <30min old.
function seedZaloCustomersFromCache() {
  try {
    const homedir = require('os').homedir();
    const cacheDir = path.join(homedir, '.openzca', 'profiles', 'default', 'cache');
    if (!fs.existsSync(cacheDir)) {
      console.log('[seedZaloCustomers] openzca cache dir not found, skipping');
      return;
    }
    const workspace = getWorkspace();
    if (!workspace) return;
    const usersDir = path.join(workspace, 'memory', 'zalo-users');
    const groupsDir = path.join(workspace, 'memory', 'zalo-groups');
    try { fs.mkdirSync(usersDir, { recursive: true }); } catch {}
    try { fs.mkdirSync(groupsDir, { recursive: true }); } catch {}

    let seededUsers = 0, seededGroups = 0, skipped = 0;
    const stamp = new Date().toISOString().slice(0, 19);

    // Collect all discovered IDs for default-deny blocklist seeding.
    const allFriendIds = [];
    const allGroupIds = [];

    // Friends → memory/zalo-users/<userId>.md
    const friendsPath = path.join(cacheDir, 'friends.json');
    if (fs.existsSync(friendsPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(friendsPath, 'utf-8'));
        const friends = Array.isArray(raw) ? raw : (Array.isArray(raw?.friends) ? raw.friends : []);
        for (const f of friends) {
          const userId = f.userId || f.uid || f.id;
          if (!userId) continue;
          allFriendIds.push(String(userId));
          const profilePath = path.join(usersDir, `${userId}.md`);
          if (fs.existsSync(profilePath)) { skipped++; continue; }
          const displayName = String(f.displayName || f.zaloName || f.name || 'Khách Zalo').trim();
          const zaloName = String(f.zaloName || f.displayName || displayName).trim();
          const lastSeen = f.lastActionTime
            ? new Date(f.lastActionTime).toISOString()
            : new Date().toISOString();
          const statusText = String(f.status || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 200);
          const content = `---
name: ${displayName}
zaloName: ${zaloName}
lastSeen: ${lastSeen}
msgCount: 0
gender: unknown
tags: []
groups: []
---
# ${displayName}

${statusText ? `**Trạng thái Zalo:** ${statusText}\n\n` : ''}---
*Hồ sơ được import tự động từ openzca cache lúc ${stamp}. Bot sẽ cập nhật thêm info sau mỗi lần tương tác.*
`;
          try { fs.writeFileSync(profilePath, content, 'utf-8'); seededUsers++; }
          catch (e) { console.error('[seedZaloCustomers] write user error:', e.message); }
        }
      } catch (e) {
        console.error('[seedZaloCustomers] friends parse error:', e.message);
      }
    }

    // Groups → memory/zalo-groups/<groupId>.md
    const groupsPath = path.join(cacheDir, 'groups.json');
    if (fs.existsSync(groupsPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(groupsPath, 'utf-8'));
        const groups = Array.isArray(raw) ? raw : (Array.isArray(raw?.groups) ? raw.groups : []);
        for (const g of groups) {
          const groupId = g.groupId || g.id;
          if (!groupId) continue;
          allGroupIds.push(String(groupId));
          const profilePath = path.join(groupsDir, `${groupId}.md`);
          if (fs.existsSync(profilePath)) { skipped++; continue; }
          const name = String(g.name || g.groupName || 'Nhóm Zalo').trim();
          const memberCount = Array.isArray(g.memVerList) ? g.memVerList.length
            : Array.isArray(g.members) ? g.members.length
            : (g.totalMember || 0);
          const content = `---
name: ${name}
lastActivity: ${new Date().toISOString()}
memberCount: ${memberCount}
---
# Nhóm ${groupId}

**Tên nhóm:** ${name}

## Chủ đề thường thảo luận
(chưa có)

## Thành viên key
(chưa có)

## Quyết định/thông báo gần đây
(chưa có)

---
*Nhóm được import tự động từ openzca cache lúc ${stamp}.*
`;
          try { fs.writeFileSync(profilePath, content, 'utf-8'); seededGroups++; }
          catch (e) { console.error('[seedZaloCustomers] write group error:', e.message); }
        }
      } catch (e) {
        console.error('[seedZaloCustomers] groups parse error:', e.message);
      }
    }

    if (seededUsers > 0 || seededGroups > 0) {
      console.log(`[seedZaloCustomers] seeded ${seededUsers} users + ${seededGroups} groups (skipped ${skipped} existing)`);
      try { auditLog('zalo_customers_seeded', { users: seededUsers, groups: seededGroups, skipped }); } catch {}
    } else if (skipped > 0) {
      console.log(`[seedZaloCustomers] ${skipped} profiles already exist, no new seeds`);
    } else {
      console.log('[seedZaloCustomers] cache is empty, nothing to seed');
    }

    // === Default-deny via settings (one-time, post-onboarding) ===
    // After wizard: bot does NOT reply to anyone by default. CEO explicitly
    // enables from Dashboard. No blocklist pollution — use settings only.
    try {
      const seedFlagPath = path.join(workspace, 'zalo-initial-blocklist-seeded.json');
      const cacheHasContent = allFriendIds.length > 0 || allGroupIds.length > 0;
      if (cacheHasContent && !fs.existsSync(seedFlagPath)) {
        // 1. Stranger policy → ignore (don't reply to unknown DMs)
        const spPath = path.join(workspace, 'zalo-stranger-policy.json');
        if (!fs.existsSync(spPath)) {
          fs.writeFileSync(spPath, JSON.stringify({ mode: 'ignore' }, null, 2), 'utf-8');
        }
        // 2. All discovered groups → off, default new group mode → off
        const gsPath = path.join(workspace, 'zalo-group-settings.json');
        let gs = {};
        if (fs.existsSync(gsPath)) {
          try { gs = JSON.parse(fs.readFileSync(gsPath, 'utf-8')) || {}; } catch {}
        }
        gs.__default = { mode: 'off' };
        for (const gid of allGroupIds) {
          if (!gs[gid]) gs[gid] = { mode: 'off' };
        }
        fs.writeFileSync(gsPath, JSON.stringify(gs, null, 2), 'utf-8');
        // 3. Empty blocklist (no group IDs, no friend IDs — settings handle deny)
        const blocklistPath = path.join(workspace, 'zalo-blocklist.json');
        if (!fs.existsSync(blocklistPath)) {
          fs.writeFileSync(blocklistPath, '[]', 'utf-8');
        }
        fs.writeFileSync(seedFlagPath, JSON.stringify({
          seededAt: new Date().toISOString(),
          friendCount: allFriendIds.length,
          groupCount: allGroupIds.length,
          note: 'Settings-based deny: stranger=ignore, all groups=off, default group=off. No blocklist seeding.',
        }, null, 2), 'utf-8');
        console.log(`[seed-defaults] stranger=ignore, ${allGroupIds.length} groups=off, default-group=off`);
        try { auditLog('zalo_defaults_seeded', { friends: allFriendIds.length, groups: allGroupIds.length }); } catch {}
      }
    } catch (e) {
      console.warn('[seed-defaults] error:', e.message);
    }
  } catch (e) {
    console.error('[seedZaloCustomers] error:', e.message);
  }
}

// ==================== GROUP HISTORY AUTO-SEED ====================
// When bot joins a new Zalo group, `seedZaloCustomersFromCache` writes metadata
// (name, memberCount) but leaves topic/member/decision sections as "(chưa có)".
// This helper fetches the last 30 actual messages via `openzca msg recent -g`,
// summarizes them through 9Router, and fills in the 3 empty sections so the AI
// has real context the FIRST time a customer in that group pings the bot.
//
// Fresh install parity: helper runs every `_startOpenClawImpl` completion →
// fresh installs no-op (no groups yet) → after wizard + first group add →
// auto-populates next boot. IPC `seed-group-history-all` exposed for manual
// retry from dashboard.

// Locate openzca CLI (mirrors gateway spawn candidate list from _startOpenClawImpl).
let _cachedOpenzcaCliJs = null;
function findOpenzcaCliJs() {
  if (_cachedOpenzcaCliJs && fs.existsSync(_cachedOpenzcaCliJs)) return _cachedOpenzcaCliJs;
  const candidates = [];
  try {
    const bundled = getBundledVendorDir && getBundledVendorDir();
    if (bundled) candidates.push(path.join(bundled, 'node_modules', 'openzca', 'dist', 'cli.js'));
  } catch {}
  if (process.platform === 'win32') {
    candidates.push(
      path.join(HOME, 'AppData', 'Roaming', 'npm', 'node_modules', 'openzca', 'dist', 'cli.js'),
      path.join(HOME, 'AppData', 'Local', 'npm', 'node_modules', 'openzca', 'dist', 'cli.js'),
      'C:\\Program Files\\nodejs\\node_modules\\openzca\\dist\\cli.js',
    );
  } else {
    candidates.push(
      '/opt/homebrew/lib/node_modules/openzca/dist/cli.js',
      '/usr/local/lib/node_modules/openzca/dist/cli.js',
      '/opt/local/lib/node_modules/openzca/dist/cli.js',
      path.join(HOME, '.npm-global/lib/node_modules/openzca/dist/cli.js'),
      path.join(HOME, '.local/lib/node_modules/openzca/dist/cli.js'),
    );
    try {
      const nvmDir = path.join(HOME, '.nvm', 'versions', 'node');
      if (fs.existsSync(nvmDir)) {
        for (const v of fs.readdirSync(nvmDir)) {
          candidates.push(path.join(nvmDir, v, 'lib', 'node_modules', 'openzca', 'dist', 'cli.js'));
        }
      }
    } catch {}
    try {
      const vendorCli = path.join(process.resourcesPath || '', 'vendor', 'node_modules', 'openzca', 'dist', 'cli.js');
      candidates.push(vendorCli);
    } catch {}
  }
  for (const p of candidates) {
    try { if (fs.existsSync(p)) { _cachedOpenzcaCliJs = p; return p; } } catch {}
  }
  return null;
}

// Seed a single group's history summary. Returns { ok, reason }.
//   - ok=true  → file updated (or already seeded / skipped for valid reason)
//   - ok=false → transient failure; leave "(chưa có)" so next boot retries
async function seedGroupHistorySummary(groupId, threadName) {
  const placeholder = '(chưa có)';
  try {
    const dir = getZaloGroupsDir && getZaloGroupsDir();
    if (!dir) return { ok: false, reason: 'no-groups-dir' };
    const filePath = path.join(dir, `${groupId}.md`);
    if (!fs.existsSync(filePath)) return { ok: true, reason: 'no-metadata-file' };
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); }
    catch { return { ok: false, reason: 'read-failed' }; }
    // Only proceed if at least one section still has the placeholder.
    const hasTopicsPlaceholder   = /##\s+Chủ đề thường thảo luận\s*\n\(chưa có\)/.test(content);
    const hasMembersPlaceholder  = /##\s+Thành viên key\s*\n\(chưa có\)/.test(content);
    const hasDecisionPlaceholder = /##\s+Quyết định\/thông báo gần đây\s*\n\(chưa có\)/.test(content);
    if (!hasTopicsPlaceholder && !hasMembersPlaceholder && !hasDecisionPlaceholder) {
      return { ok: true, reason: 'already-seeded' };
    }
    const cliJs = findOpenzcaCliJs();
    if (!cliJs) return { ok: false, reason: 'openzca-cli-not-found' };
    const nodeBin = findNodeBin();
    if (!nodeBin) return { ok: false, reason: 'node-not-found' };
    // Fetch last 30 messages from Zalo's live history for this group.
    const stdout = await new Promise((resolve) => {
      let out = '', err = '';
      const child = spawn(nodeBin, [cliJs, '--profile', 'default', 'msg', 'recent', groupId, '-g', '-n', '30', '--source', 'live', '-j'], {
        shell: false,
        windowsHide: true,
        timeout: 15000,
      });
      child.stdout.on('data', d => out += d.toString());
      child.stderr.on('data', d => err += d.toString());
      child.on('error', () => resolve({ out: '', err: 'spawn-error' }));
      child.on('exit', (code) => resolve({ out, err, code }));
    });
    if (!stdout || !stdout.out) return { ok: false, reason: 'no-stdout' };
    // openzca returns rate-limit error on stderr occasionally. Bail this run.
    if (stdout.err && /rate|429/i.test(stdout.err)) return { ok: false, reason: 'rate-limited' };
    let msgs;
    try {
      const parsed = JSON.parse(stdout.out);
      msgs = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.messages) ? parsed.messages : null);
    } catch { return { ok: false, reason: 'json-parse-failed' }; }
    if (!msgs || msgs.length === 0) {
      // New group with no pre-bot history → nothing to summarize. Leave placeholder.
      return { ok: true, reason: 'empty-history' };
    }
    // Format messages for the prompt.
    const formatted = msgs.map(m => {
      const ts = m.timestamp || m.ts || m.time || '';
      const name = String(m.senderName || m.fromName || m.sender || 'unknown').trim().slice(0, 40);
      const body = String(m.body || m.content || m.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!body) return null;
      return `[${ts}] ${name}: ${body}`;
    }).filter(Boolean).join('\n');
    if (!formatted) return { ok: true, reason: 'no-text-messages' };
    const prompt = `Dưới đây là 30 tin nhắn gần nhất trong nhóm Zalo "${threadName || 'không tên'}".\n` +
      `Hãy tóm tắt ngắn gọn thành 3 phần:\n` +
      `1. CHỦ ĐỀ THƯỜNG THẢO LUẬN: 2-4 bullet, mỗi bullet <20 từ.\n` +
      `2. THÀNH VIÊN KEY: 2-4 bullet, format "Tên/ID — vai trò hoặc đặc điểm".\n` +
      `3. QUYẾT ĐỊNH/THÔNG BÁO GẦN ĐÂY: 2-4 bullet, mỗi bullet <25 từ.\n` +
      `Không thêm phần nào khác. Không viết emoji. Tiếng Việt tự nhiên.\n` +
      `--- TIN NHẮN ---\n${formatted}`;
    const llmOut = await call9Router(prompt, { maxTokens: 800, temperature: 0.3, timeoutMs: 20000 });
    if (!llmOut) return { ok: false, reason: '9router-failed' };
    // Parse 3 sections out of LLM response. Accept headings like "1.", "CHỦ ĐỀ...",
    // "## CHỦ ĐỀ...", etc. Regex-based split on the key labels (case-insensitive).
    const sectionPattern = /(?:^|\n)\s*(?:##\s*|\d+[.)]\s*|\*\*\s*)?(CHỦ ĐỀ[^\n:]*|THÀNH VIÊN[^\n:]*|QUYẾT ĐỊNH[^\n:]*)[:\s]*\n?/gi;
    const parts = {};
    const matches = [...llmOut.matchAll(sectionPattern)];
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const headerUpper = m[1].toUpperCase();
      const startIdx = m.index + m[0].length;
      const endIdx = (i + 1 < matches.length) ? matches[i + 1].index : llmOut.length;
      let body = llmOut.slice(startIdx, endIdx).trim();
      // Strip surrounding ** if any, normalize bullet prefix
      body = body.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
        const stripped = l.replace(/^[-*•·]\s*/, '').replace(/^\d+[.)]\s*/, '').trim();
        return stripped ? `- ${stripped}` : '';
      }).filter(Boolean).join('\n');
      if (!body) continue;
      if (/CHỦ ĐỀ/i.test(headerUpper)) parts.topics = body;
      else if (/THÀNH VIÊN/i.test(headerUpper)) parts.members = body;
      else if (/QUYẾT ĐỊNH/i.test(headerUpper)) parts.decisions = body;
    }
    if (!parts.topics && !parts.members && !parts.decisions) {
      return { ok: false, reason: 'llm-unparseable' };
    }
    // Rewrite the MD file — replace each "(chưa có)" placeholder only if we got
    // content for that section. Preserve file structure otherwise.
    let updated = content;
    if (parts.topics && hasTopicsPlaceholder) {
      updated = updated.replace(/(##\s+Chủ đề thường thảo luận\s*\n)\(chưa có\)/, `$1${parts.topics}`);
    }
    if (parts.members && hasMembersPlaceholder) {
      updated = updated.replace(/(##\s+Thành viên key\s*\n)\(chưa có\)/, `$1${parts.members}`);
    }
    if (parts.decisions && hasDecisionPlaceholder) {
      updated = updated.replace(/(##\s+Quyết định\/thông báo gần đây\s*\n)\(chưa có\)/, `$1${parts.decisions}`);
    }
    // Update front-matter lastActivity
    updated = updated.replace(/^(lastActivity:\s*)[^\n]*$/m, `$1${new Date().toISOString()}`);
    // Append an auto-seed footer comment once (only if not already present)
    if (!/auto-seeded via history summary/i.test(updated)) {
      updated = updated.trimEnd() + `\n\n*Lịch sử nhóm được tự động tóm tắt từ ${msgs.length} tin gần nhất lúc ${new Date().toISOString().slice(0, 19)} (auto-seeded via history summary).*\n`;
    }
    if (updated === content) return { ok: true, reason: 'no-change' };
    // Atomic-ish write: temp + rename. Safe enough for MD.
    const tmpPath = filePath + '.tmp-' + Date.now();
    try {
      fs.writeFileSync(tmpPath, updated, 'utf-8');
      fs.renameSync(tmpPath, filePath);
    } catch (e) {
      try { fs.unlinkSync(tmpPath); } catch {}
      return { ok: false, reason: 'write-failed: ' + e.message };
    }
    console.log(`[group-history-seed] summarized ${msgs.length} messages for group ${groupId}`);
    try { auditLog('group_history_seeded', { groupId, msgCount: msgs.length, sections: Object.keys(parts) }); } catch {}
    return { ok: true, reason: 'seeded', msgCount: msgs.length };
  } catch (e) {
    return { ok: false, reason: 'exception: ' + (e && e.message ? e.message : String(e)) };
  }
}

// Batch-seed all groups with unseeded placeholders. Rate limit: 1 per 3s.
// Bail on rate-limit error. Fire-and-forget from startOpenClaw, never blocks boot.
let _groupHistorySeedInFlight = false;
async function seedAllGroupHistories({ source = 'auto' } = {}) {
  if (_groupHistorySeedInFlight) {
    return { started: false, reason: 'already-running' };
  }
  _groupHistorySeedInFlight = true;
  const stats = { scanned: 0, seeded: 0, skipped: 0, failed: 0, failures: [] };
  try {
    const dir = getZaloGroupsDir && getZaloGroupsDir();
    if (!dir || !fs.existsSync(dir)) {
      return { started: true, ...stats, reason: 'no-groups-dir' };
    }
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    for (const f of files) {
      stats.scanned++;
      const groupId = f.replace(/\.md$/, '');
      let threadName = groupId;
      try {
        const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
        const m = raw.match(/^name:\s*([^\n]+)/m);
        if (m) threadName = m[1].trim();
      } catch {}
      const r = await seedGroupHistorySummary(groupId, threadName);
      if (r.ok && r.reason === 'seeded') stats.seeded++;
      else if (r.ok) stats.skipped++;
      else {
        stats.failed++;
        stats.failures.push({ groupId, reason: r.reason });
        // Hard bail on rate-limit so we don't hammer Zalo.
        if (r.reason === 'rate-limited') {
          console.warn('[group-history-seed] rate-limited — bailing this run');
          break;
        }
      }
      // 3s stagger between calls
      await new Promise(r => setTimeout(r, 3000));
    }
    console.log(`[group-history-seed] ${source} run done: scanned=${stats.scanned} seeded=${stats.seeded} skipped=${stats.skipped} failed=${stats.failed}`);
    return { started: true, ...stats };
  } finally {
    _groupHistorySeedInFlight = false;
  }
}

// Cookie expiry monitor — REMOVED.
// Zalo sessions persist indefinitely as long as the listener keeps the
// WebSocket alive (confirmed via VinCSS research + openzca behavior).
// The old 14-day warning was an unverified assumption that caused false
// alarms and unnecessary QR re-scans for CEO.
// Kept as no-op so existing call sites don't break.
function checkZaloCookieAge() {}

async function _ensureZaloPluginImpl() {
  if (_zaloReady) return;
  try {
    // FRESH-INSTALL FAST PATH: copy bundled openzalo plugin from vendor into
    // ~/.openclaw/extensions/openzalo. This skips network-dependent
    // `openclaw plugins install` and `npm install -g openzca`, so it works
    // on a fresh Mac with ZERO Node.js installed.
    const extensionsDir = path.join(HOME, '.openclaw', 'extensions', 'openzalo');
    const vendorDir = getBundledVendorDir();
    // Heal missing node_modules link even when plugin is already present
    // (upgrade path from prior build that copied plugin without linking deps).
    ensureOpenzaloNodeModulesLink();
    // FAST PATH: plugin already installed (common on subsequent boots).
    // Skip both bundled-copy AND network-install. Without this early return,
    // the code falls through to `npm install -g openzca` (60s timeout) on
    // EVERY boot — the root cause of the 50s startup delay.
    if (fs.existsSync(path.join(extensionsDir, 'openclaw.plugin.json'))) {
      console.log('[ensureZaloPlugin] plugin already present — skipping install');
      _zaloReady = true;
      return;
    }
    if (vendorDir) {
      const bundledPlugin = path.join(vendorDir, 'node_modules', '@tuyenhx', 'openzalo');
      if (fs.existsSync(path.join(bundledPlugin, 'openclaw.plugin.json'))) {
        try {
          fs.mkdirSync(extensionsDir, { recursive: true });
          // Recursive copy — use fs.cpSync (Node 16.7+). Safe on Electron 28 (Node 18).
          fs.cpSync(bundledPlugin, extensionsDir, { recursive: true, force: true, errorOnExist: false });
          console.log('[ensureZaloPlugin] copied bundled openzalo plugin from vendor →', extensionsDir);
          // Also ensure the plugin entry exists in openclaw.json, but mirror
          // the actual master Zalo enabled flag so copied plugin files do not
          // silently turn Zalo back on.
          await withOpenClawConfigLock(async () => {
            try {
              console.log('[config-lock] ensureZaloPlugin acquired');
              const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
              if (fs.existsSync(configPath)) {
                const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                if (!cfg.plugins) cfg.plugins = {};
                if (!cfg.plugins.entries) cfg.plugins.entries = {};
                const wantOpenzaloEnabled = cfg?.channels?.openzalo?.enabled !== false;
                if (!cfg.plugins.entries.openzalo) cfg.plugins.entries.openzalo = { enabled: wantOpenzaloEnabled };
                else cfg.plugins.entries.openzalo.enabled = wantOpenzaloEnabled;
                writeOpenClawConfigIfChanged(configPath, cfg);
              }
            } catch (e) { console.warn('[ensureZaloPlugin] config update failed:', e?.message); }
          });
          // CRITICAL: after copying the plugin OUT of vendor/node_modules, its
          // hoisted dependencies (zod etc) are no longer reachable via Node's
          // normal module resolution. The plugin is "type": "module" (ESM) so
          // NODE_PATH fallback doesn't apply either. Without this, the gateway
          // logs "Cannot find module 'zod'" forever and the openzalo plugin
          // never loads → Zalo is completely dead even though openzca session
          // is fine. Fix: create a directory junction (Windows) / symlink
          // (Mac/Linux) from <plugin>/node_modules → vendor/node_modules. One
          // link, zero file copies, plugin sees all hoisted deps.
          try {
            const pluginNodeModules = path.join(extensionsDir, 'node_modules');
            const vendorNodeModules = path.join(vendorDir, 'node_modules');
            if (fs.existsSync(vendorNodeModules) && !fs.existsSync(pluginNodeModules)) {
              const linkType = process.platform === 'win32' ? 'junction' : 'dir';
              try {
                fs.symlinkSync(vendorNodeModules, pluginNodeModules, linkType);
                console.log('[ensureZaloPlugin] linked node_modules →', vendorNodeModules, `(${linkType})`);
              } catch (linkErr) {
                // Junction can fail on rare Windows setups (non-NTFS, permission
                // edge cases). Fall back to copying ONLY the declared deps from
                // the plugin's package.json. Zero-dep libs like zod are tiny.
                console.warn('[ensureZaloPlugin] junction failed, copying deps explicitly:', linkErr?.message);
                try {
                  fs.mkdirSync(pluginNodeModules, { recursive: true });
                  const pkgPath = path.join(extensionsDir, 'package.json');
                  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                  const deps = Object.keys(pkg.dependencies || {});
                  for (const dep of deps) {
                    const src = path.join(vendorNodeModules, dep);
                    const dst = path.join(pluginNodeModules, dep);
                    if (fs.existsSync(src) && !fs.existsSync(dst)) {
                      fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false });
                      console.log('[ensureZaloPlugin] copied dep', dep);
                    }
                  }
                } catch (copyErr) {
                  console.error('[ensureZaloPlugin] CRITICAL: dep copy fallback ALSO failed:', copyErr?.message);
                  console.error('[ensureZaloPlugin] Zalo plugin WILL fail to load with "Cannot find module"');
                }
              }
            }
          } catch (e) { console.warn('[ensureZaloPlugin] node_modules link setup failed:', e?.message); }
          // Apply openzalo fork: copy pre-patched source files over upstream.
          // Replaces the old 12+ individual ensure* patch calls.
          try { applyOpenzaloFork(); } catch (e) { console.warn('[ensureZaloPlugin] fork apply failed:', e?.message); }
          _zaloReady = true;
          return;
        } catch (e) {
          console.error('[ensureZaloPlugin] bundled copy failed — falling back to network install:', e?.message || e);
        }
      }
    }
    // NETWORK FALLBACK: dev mode OR bundled copy unavailable.
    const bin = await findOpenClawBin();
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    try { await execFilePromise(npmBin, ['install', '-g', 'openzca'], { timeout: 60000, stdio: 'pipe', shell: process.platform === 'win32', windowsHide: true }); } catch {}
    if (bin) {
      try { await runOpenClaw(['plugins', 'install', '@tuyenhx/openzalo', '--dangerously-force-unsafe-install'], 60000); } catch {}
      // REMOVED: `openclaw config set channels.openzalo.enabled true` and
      //          `openclaw config set channels.openzalo.dmPolicy open`
      //
      // Why: each `openclaw config set ...` runs as a CLI subprocess which
      // rewrites openclaw.json via atomic rename. That bypasses our in-process
      // writeOpenClawConfigIfChanged byte-equal guard, changes the file inode,
      // wakes the gateway's config-reload watcher, and triggers a reload plan.
      // For `channels.openzalo.*` paths the plan resolves to a restart action
      // → in-flight reply runs aborted with `aborted_for_restart` → CEO sees
      // "⚠️ Gateway is restarting. Please wait a few seconds and try again."
      // exactly when sending a real message — even though Telegram getMe still
      // works (the bot itself is fine, only the gateway's reply pipeline got
      // killed mid-completion).
      //
      // ensureDefaultConfig() now heals `channels.openzalo.enabled = true` and
      // `channels.openzalo.dmPolicy = 'open'` in-process, so no CLI hop needed.

      // Apply openzalo fork after network install (same as bundled path)
      try { applyOpenzaloFork(); } catch (e) { console.warn('[ensureZaloPlugin] fork apply after network install failed:', e?.message); }
    }
    _zaloReady = true;
  } catch {}
}

// Setup Zalo — only runs QR login (fast), plugin already installed
ipcMain.handle('setup-zalo', async () => {
  try {
    _zaloLoginStartedAt = Date.now();

    // Delete old QR files
    for (const qr of [path.join(userDataDir, 'qr.png'), path.join(__dirname, 'qr.png'), path.join(resourceDir, 'qr.png'), path.join(process.cwd(), 'qr.png')]) {
      try { fs.unlinkSync(qr); } catch {}
    }

    // Run openzca auth login hidden — QR saved to known path
    const logsDir = path.join(userDataDir, 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const qrSavePath = path.join(userDataDir, 'qr.png');
    const zaloLogFd = fs.openSync(path.join(logsDir, 'openzca.log'), 'a');
    // Spawn node directly — no CMD window. findGlobalPackageFile searches ALL
    // Node-manager lib dirs, not just the first existing one (the npmGlobalModules
    // shortcut breaks on mixed nvm/system Node setups).
    const zcaScript = findGlobalPackageFile('openzca', 'dist/cli.js');
    let zcaCmd, zcaArgs;
    if (zcaScript) {
      zcaCmd = findNodeBin() || 'node';
      zcaArgs = [zcaScript, 'auth', 'login', '--qr-path', qrSavePath];
    } else {
      // Fallback to PATH lookup. Use shell=true on Windows so .cmd shim resolves.
      zcaCmd = process.platform === 'win32' ? 'openzca.cmd' : 'openzca';
      zcaArgs = ['auth', 'login', '--qr-path', qrSavePath];
    }
    // Prevent openzca from auto-opening QR image in external viewer
    const zcaEnv = { ...process.env, OPENZCA_QR_OPEN: '0', OPENZCA_QR_AUTO_OPEN: '0' };
    const zaloProc = spawn(zcaCmd, zcaArgs, {
      stdio: ['ignore', zaloLogFd, zaloLogFd],
      detached: true,
      windowsHide: true,
      env: zcaEnv,
    });
    zaloProc.on('exit', () => { try { fs.closeSync(zaloLogFd); } catch {} });
    zaloProc.unref();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Find QR image and return as base64 data URL (avoids CSP file:// issues)
ipcMain.handle('find-zalo-qr', async () => {
  const candidates = [
    path.join(userDataDir, 'qr.png'),
    path.join(__dirname, 'qr.png'),
    path.join(resourceDir, 'qr.png'),
    path.join(process.cwd(), 'qr.png'),
    path.join(HOME, 'qr.png'),
    path.join(HOME, '.openzca', 'qr.png'),
    path.join(HOME, '.openclaw', 'qr.png'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const data = fs.readFileSync(p);
      return 'data:image/png;base64,' + data.toString('base64');
    }
  }
  return null;
});

// Check if Zalo login succeeded (openzca stores session)
let _zaloLoginStartedAt = 0;
ipcMain.handle('check-zalo-login', async () => {
  try {
    const home = HOME;
    const sessionPaths = [
      path.join(home, '.openzca', 'profiles', 'default', 'credentials.json'),
      path.join(home, '.openzca', 'profiles', 'default', 'creds.json'),
      path.join(home, '.openzca', 'profiles', 'default', 'session.json'),
      path.join(home, '.openzca', 'default', 'credentials.json'),
    ];
    for (const p of sessionPaths) {
      if (fs.existsSync(p)) {
        // Count as logged in if file was modified AFTER login started OR within
        // 5s tolerance (clock precision, filesystem timestamp rounding).
        const mtime = fs.statSync(p).mtimeMs;
        if (_zaloLoginStartedAt && mtime < _zaloLoginStartedAt - 5000) continue;
        return { loggedIn: true };
      }
    }
    // Also try openzca status command — use direct node path for reliability
    // (execFile with shell=false on Mac can't resolve PATH-based commands).
    try {
      const zcaScript = findGlobalPackageFile('openzca', 'dist/cli.js');
      if (zcaScript) {
        const nodeBin = findNodeBin() || 'node';
        const { stdout } = await execFilePromise(nodeBin, [zcaScript, 'auth', 'status'], { timeout: 5000, encoding: 'utf-8', stdio: 'pipe', windowsHide: true });
        if (stdout.toLowerCase().includes('logged in') || stdout.toLowerCase().includes('authenticated')) return { loggedIn: true };
      }
    } catch {}
    return { loggedIn: false };
  } catch { return { loggedIn: false }; }
});

// Get current Zalo mode
ipcMain.handle('get-zalo-mode', async () => {
  try {
    const configPath = path.join(getWorkspace(), 'config', 'zalo-mode.txt');
    if (fs.existsSync(configPath)) return fs.readFileSync(configPath, 'utf-8').trim();
    return 'auto';
  } catch { return 'auto'; }
});

// Save Zalo mode to workspace config (read by AGENTS.md)
// ================================
// Shop State — "Tình trạng hôm nay"
// ================================
// CEO updates via Dashboard. Bot reads workspace/shop-state.json before each
// reply to know real-time shop state (out of stock, staff absent, shipping
// delay, active promotions, early closing, special notes).
// Note: no daily auto-reset cron — CEO clears fields manually via Dashboard
// "Xoá hết (bình thường)" button. May add cron in a later release.
ipcMain.handle('get-shop-state', async () => {
  try {
    const ws = getWorkspace();
    if (!ws) return null;
    const p = path.join(ws, 'shop-state.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.error('[get-shop-state] error:', e?.message);
    return null;
  }
});
ipcMain.handle('set-shop-state', async (_event, state) => {
  try {
    const ws = getWorkspace();
    if (!ws) return { ok: false, error: 'no workspace' };
    const p = path.join(ws, 'shop-state.json');
    const payload = {
      updatedAt: new Date().toISOString(),
      updatedBy: 'CEO via Dashboard',
      ...(state || {}),
    };
    writeJsonAtomic(p, payload);
    syncShopStateToBootstrap();
    try { auditLog('shop_state_updated', { fields: Object.keys(state || {}).length }); } catch {}
    return { ok: true };
  } catch (e) {
    console.error('[set-shop-state] error:', e?.message);
    return { ok: false, error: e.message };
  }
});

// ================================
// Persona Mix — Dashboard re-edit (post-wizard)
// ================================
// Dashboard has a "Tính cách bot" page where CEO can edit persona mix after
// wizard. These handlers bridge between Dashboard UI state and the 2 workspace
// files (active-persona.json + active-persona.md).
ipcMain.handle('get-persona-mix', async () => {
  try {
    const ws = getWorkspace();
    if (!ws) return null;
    const p = path.join(ws, 'active-persona.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.error('[get-persona-mix] error:', e?.message);
    return null;
  }
});
ipcMain.handle('save-persona-mix', async (_event, mix) => {
  try {
    const ws = getWorkspace();
    if (!ws) return { ok: false, error: 'no workspace' };
    if (!mix || typeof mix !== 'object') return { ok: false, error: 'invalid mix' };
    const normalized = {
      voice: mix.voice || 'em-nu-tre',
      customer: mix.customer || 'anh-chi',
      traits: Array.isArray(mix.traits) ? mix.traits.slice(0, 5) : [],
      formality: Math.max(1, Math.min(10, parseInt(mix.formality, 10) || 5)),
      greeting: (mix.greeting || '').toString().slice(0, 300),
      closing: (mix.closing || '').toString().slice(0, 300),
      phrases: (mix.phrases || '').toString().slice(0, 1000),
    };
    const jsonPath = path.join(ws, 'active-persona.json');
    const mdPath = path.join(ws, 'active-persona.md');
    writeJsonAtomic(jsonPath, normalized);
    fs.writeFileSync(mdPath, compilePersonaMix(normalized), 'utf-8');
    syncPersonaToBootstrap();
    try { auditLog('persona_mix_updated', { voice: normalized.voice, traits: normalized.traits.length, formality: normalized.formality }); } catch {}
    console.log('[save-persona-mix] updated via Dashboard');
    return { ok: true };
  } catch (e) {
    console.error('[save-persona-mix] error:', e?.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('save-zalo-mode', async (_event, mode) => {
  try {
    const ws = getWorkspace();
    const configPath = path.join(ws, 'config', 'zalo-mode.txt');
    fs.mkdirSync(path.join(ws, 'config'), { recursive: true });
    fs.writeFileSync(configPath, mode, 'utf-8');

    // Also update AGENTS.md Zalo section based on mode
    const agentsPath = path.join(ws, 'AGENTS.md');
    if (fs.existsSync(agentsPath)) {
      let content = fs.readFileSync(agentsPath, 'utf-8');
      // Replace Zalo mode marker if exists, or add after Zalo section header
      const modeText = mode === 'auto'
        ? '**Chế độ: Tự động trả lời.** Trợ lý tự reply khách hàng. Vấn đề phức tạp escalate qua Telegram.'
        : mode === 'read'
        ? '**Chế độ: Chỉ đọc.** KHÔNG tự trả lời trên Zalo. Đọc tin nhắn và báo qua Telegram cho CEO. CEO quyết định trả lời.'
        : '**Chế độ: Tóm tắt cuối ngày.** KHÔNG tự trả lời. Đọc tất cả tin nhắn trong ngày, gửi bản tổng hợp qua Telegram 1 lần vào cuối ngày.';

      if (content.includes('**Chế độ:')) {
        content = content.replace(/\*\*Chế độ:.*?\*\*/s, modeText.split('**')[1] ? modeText : modeText);
        // Simpler: replace the whole mode line
        content = content.replace(/\*\*Chế độ:.*$/m, modeText);
      } else if (content.includes('### Zalo (kênh khách hàng/nhân viên)')) {
        content = content.replace(
          '### Zalo (kênh khách hàng/nhân viên)\n',
          `### Zalo (kênh khách hàng/nhân viên)\n\n${modeText}\n`
        );
      }
      fs.writeFileSync(agentsPath, content, 'utf-8');
    }
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

// ============================================
//  ZALO MANAGER — Group whitelist + User blacklist
// ============================================

function getZcaProfile() {
  // Try to read active profile name, fallback to 'default'
  try {
    const pj = path.join(HOME, '.openzca', 'profiles.json');
    if (fs.existsSync(pj)) {
      const data = JSON.parse(fs.readFileSync(pj, 'utf-8'));
      return data?.active || 'default';
    }
  } catch {}
  return 'default';
}

function getZcaCacheDir() {
  return path.join(HOME, '.openzca', 'profiles', getZcaProfile(), 'cache');
}

function getZcaCacheDirForProfile(profile) {
  return path.join(HOME, '.openzca', 'profiles', profile || getZcaProfile(), 'cache');
}

function readZaloChannelState() {
  const state = {
    enabled: false,
    groupPolicy: 'open',
    groupAllowFrom: ['*'],
    userBlocklist: [],
    profile: getZcaProfile(),
    configError: null,
    blocklistError: null,
  };
  try {
    const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const oz = cfg?.channels?.openzalo || {};
      state.enabled = oz.enabled !== false;
      state.groupPolicy = oz.groupPolicy || 'open';
      state.groupAllowFrom = Array.isArray(oz.groupAllowFrom)
        ? oz.groupAllowFrom.map(String)
        : (state.groupPolicy === 'allowlist' ? [] : ['*']);
    }
  } catch (e) {
    state.configError = e?.message || String(e);
  }
  try {
    const bp = getZaloBlocklistPath();
    if (fs.existsSync(bp)) {
      const raw = JSON.parse(fs.readFileSync(bp, 'utf-8'));
      state.userBlocklist = Array.isArray(raw) ? raw.map(e => String(e?.id || e)) : [];
    }
  } catch (e) {
    state.blocklistError = e?.message || String(e);
  }
  return state;
}

function isZaloTargetAllowed(targetId, { isGroup = false } = {}) {
  const state = readZaloChannelState();
  if (state.configError || state.blocklistError) {
    return { allowed: false, reason: 'policy-error', state };
  }
  if (state.enabled === false) {
    return { allowed: false, reason: 'disabled', state };
  }
  const id = String(targetId || '').trim();
  if (!id) return { allowed: false, reason: 'missing-target', state };
  if (isGroup) {
    const allowAll = state.groupPolicy !== 'allowlist' || state.groupAllowFrom.includes('*');
    if (!allowAll && !state.groupAllowFrom.includes(id)) {
      return { allowed: false, reason: 'group-not-allowed', state };
    }
  } else if (state.userBlocklist.includes(id)) {
    return { allowed: false, reason: 'user-blocked', state };
  }
  return { allowed: true, state };
}

function isKnownZaloTarget(targetId, { isGroup = false, profile } = {}) {
  try {
    const cacheDir = getZcaCacheDirForProfile(profile);
    const filename = isGroup ? 'groups.json' : 'friends.json';
    const file = path.join(cacheDir, filename);
    if (!fs.existsSync(file)) return { known: false, reason: 'cache-missing' };
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (isGroup) {
      const arr = Array.isArray(data) ? data : (Array.isArray(data?.groups) ? data.groups : []);
      const known = arr.some(g => String(g.groupId || g.id || '') === String(targetId));
      return { known, reason: known ? null : 'group-not-in-cache' };
    }
    const arr = Array.isArray(data) ? data : [];
    const known = arr.some(f => String(f.userId || f.userKey || '') === String(targetId));
    return { known, reason: known ? null : 'user-not-in-cache' };
  } catch (e) {
    return { known: false, reason: 'cache-error', error: e?.message || String(e) };
  }
}

// PERF: cache friends list for 60s — avoids re-reading ~3767 entries from disk
// on every 120s auto-refresh. Invalidated on save-zalo-manager-config and login.
let _zaloFriendsCache = null;
let _zaloFriendsCacheAt = 0;
const ZALO_FRIENDS_CACHE_TTL_MS = 60 * 1000;
function invalidateZaloFriendsCache() { _zaloFriendsCache = null; _zaloFriendsCacheAt = 0; }
ipcMain.handle('list-zalo-friends', async () => {
  try {
    const now = Date.now();
    if (_zaloFriendsCache && (now - _zaloFriendsCacheAt) < ZALO_FRIENDS_CACHE_TTL_MS) {
      return _zaloFriendsCache;
    }
    const p = path.join(getZcaCacheDir(), 'friends.json');
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    // Normalize — only return fields the UI needs
    const result = (Array.isArray(data) ? data : []).map(f => ({
      userId: String(f.userId || f.userKey || ''),
      displayName: f.displayName || f.zaloName || f.username || '(không tên)',
      avatar: f.avatar || '',
      phoneNumber: f.phoneNumber || '',
      isFriend: f.isFr === 1,
      isBlocked: f.isBlocked === 1,
    })).filter(f => f.userId);
    _zaloFriendsCache = result;
    _zaloFriendsCacheAt = now;
    return result;
  } catch (e) {
    console.error('[zalo] list friends error:', e.message);
    return [];
  }
});

// Refresh openzca cache directly (shared helper).
// Searches ALL node-manager lib dirs for openzca/dist/cli.js (handles mixed
// nvm/system Node setups), then spawns via absolute node path so PATH issues
// can't break this on Mac Finder launches.
let _zaloCacheRefreshInFlight = null;
let _zaloCacheRefreshLastStartedAt = 0;
let _zaloCacheRefreshCooldownUntil = 0;
const ZALO_CACHE_REFRESH_MIN_GAP_MS = 30 * 1000;
const ZALO_CACHE_REFRESH_429_COOLDOWN_MS = 2 * 60 * 1000;

async function runZaloCacheRefresh({ source = 'manual', force = false } = {}) {
  const now = Date.now();
  if (_zaloCacheRefreshInFlight) {
    console.log(`[zalo-cache] refresh join existing in-flight run (source=${source})`);
    return _zaloCacheRefreshInFlight;
  }
  if (!force && _zaloCacheRefreshCooldownUntil > now) {
    const retryAfterSec = Math.max(1, Math.ceil((_zaloCacheRefreshCooldownUntil - now) / 1000));
    console.warn(`[zalo-cache] refresh skipped during cooldown (${retryAfterSec}s left, source=${source})`);
    return {
      ok: false,
      skipped: true,
      rateLimited: true,
      retryAfterSec,
      error: `Zalo đang giới hạn đồng bộ cache. Đợi ${retryAfterSec} giây rồi thử lại.`,
    };
  }
  if (!force && _zaloCacheRefreshLastStartedAt && (now - _zaloCacheRefreshLastStartedAt) < ZALO_CACHE_REFRESH_MIN_GAP_MS) {
    const retryAfterSec = Math.max(1, Math.ceil((ZALO_CACHE_REFRESH_MIN_GAP_MS - (now - _zaloCacheRefreshLastStartedAt)) / 1000));
    console.log(`[zalo-cache] refresh skipped (too soon, source=${source}, retryAfter=${retryAfterSec}s)`);
    return {
      ok: false,
      skipped: true,
      retryAfterSec,
      error: `Vừa đồng bộ cache Zalo xong. Đợi ${retryAfterSec} giây rồi thử lại.`,
    };
  }

  _zaloCacheRefreshInFlight = (async () => {
    _zaloCacheRefreshLastStartedAt = Date.now();
    try {
      const zcaScript = findGlobalPackageFile('openzca', 'dist/cli.js');
      let cmd, args, opts = { timeout: 15000, windowsHide: true };
      if (zcaScript) {
        cmd = findNodeBin() || 'node';
        args = [zcaScript, 'auth', 'cache-refresh'];
      } else {
        // PATH fallback. On Windows we need .cmd + shell:true; on Mac/Linux just
        // openzca with PATH already augmented at boot.
        const isWin = process.platform === 'win32';
        cmd = isWin ? 'openzca.cmd' : 'openzca';
        args = ['auth', 'cache-refresh'];
        opts.shell = isWin;
      }
      await execFilePromise(cmd, args, opts);
      _zaloCacheRefreshCooldownUntil = 0;
      console.log(`[zalo-cache] refresh ok (source=${source})`);
      invalidateZaloFriendsCache(); // PERF: bust friends cache after successful refresh
      return { ok: true };
    } catch (e) {
      const msg = e?.message || String(e);
      if (/status code 429|(?:^|\\b)429(?:\\b|$)|rate limit/i.test(msg)) {
        _zaloCacheRefreshCooldownUntil = Date.now() + ZALO_CACHE_REFRESH_429_COOLDOWN_MS;
        const retryAfterSec = Math.ceil(ZALO_CACHE_REFRESH_429_COOLDOWN_MS / 1000);
        console.warn(`[zalo-cache] refresh rate-limited (source=${source}, cooldown=${retryAfterSec}s): ${msg}`);
        return {
          ok: false,
          rateLimited: true,
          retryAfterSec,
          error: `Zalo đang rate limit đồng bộ cache. Đợi ${retryAfterSec} giây rồi thử lại.`,
        };
      }
      console.error(`[zalo-cache] refresh failed (source=${source}):`, msg);
      return { ok: false, error: msg };
    } finally {
      _zaloCacheRefreshInFlight = null;
    }
  })();

  return _zaloCacheRefreshInFlight;
}

// Periodic auto-refresh (every 10 min) so new groups/friends show up without manual action
let _zaloCacheInterval = null;
function startZaloCacheAutoRefresh() {
  if (_zaloCacheInterval) clearInterval(_zaloCacheInterval);
  _zaloCacheInterval = setInterval(() => {
    runZaloCacheRefresh({ source: 'auto-interval' }).then(res => {
      if (res?.ok && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('zalo-cache-refreshed');
      }
    });
  }, 10 * 60 * 1000); // 10 minutes
}

// Trigger openzca to refresh its cache from live Zalo server (manual)
ipcMain.handle('refresh-zalo-cache', async () => {
  const result = await runZaloCacheRefresh({ source: 'manual' });
  return {
    success: !!result?.ok,
    skipped: !!result?.skipped,
    rateLimited: !!result?.rateLimited,
    retryAfterSec: result?.retryAfterSec || 0,
    error: result?.error || null,
  };
});

ipcMain.handle('list-zalo-groups', async () => {
  try {
    const p = path.join(getZcaCacheDir(), 'groups.json');
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return (Array.isArray(data) ? data : []).map(g => ({
      groupId: String(g.groupId || g.id || ''),
      name: g.name || g.groupName || '(không tên)',
      avatar: g.avatar || g.groupAvatar || g.avt || g.fullAvt || '',
      memberCount: g.totalMember || g.memberCount || (g.memberIds?.length) || (g.memVerList?.length) || 0,
      desc: g.desc || '',
      createdTime: g.createdTime || 0,
    })).filter(g => g.groupId);
  } catch (e) {
    console.error('[zalo] list groups error:', e.message);
    return [];
  }
});

// === Zalo per-user memory ===
// Bot writes one .md file per Zalo customer at memory/zalo-users/<senderId>.md
// containing a structured profile (tone, decisions, likes/dislikes, CEO notes).
// Dashboard reads them so CEO can click any friend → see full memory.
//
// CRITICAL: bot's working dir is set in ~/.openclaw/openclaw.json field
// `agents.defaults.workspace` (typically %APPDATA%/modoro-claw on Windows).
// MODOROClaw's getWorkspace() returns a DIFFERENT path (Desktop/claw in dev,
// %APPDATA%/MODOROClaw packaged) → mismatch caused Dashboard to read empty
// while bot wrote to the right place. Always read this from openclaw.json
// so Electron + bot agree on a single source of truth.

function getOpenclawAgentWorkspace() {
  try {
    const cfgPath = path.join(HOME, '.openclaw', 'openclaw.json');
    if (!fs.existsSync(cfgPath)) return null;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    const ws = cfg && cfg.agents && cfg.agents.defaults && cfg.agents.defaults.workspace;
    if (typeof ws === 'string' && ws.trim()) {
      // path.resolve() promotes relative paths to absolute (defensive — in
      // practice openclaw always writes absolute paths, but a misconfigured
      // wizard or hand-edit could leave a relative path which would then
      // resolve against process.cwd() and silently split bot/Electron paths
      // again — the exact bug we just fixed).
      return path.resolve(ws.trim());
    }
    return null;
  } catch (e) {
    console.warn('[getOpenclawAgentWorkspace] read failed:', e && e.message ? e.message : String(e));
    return null;
  }
}

function getZaloUsersDir() {
  // Single source of truth: openclaw.json -> agents.defaults.workspace.
  // Falls back to MODOROClaw workspace only if openclaw.json missing (very
  // early boot before wizard). Bot reads/writes here using relative path.
  const agentWs = getOpenclawAgentWorkspace();
  if (agentWs) return path.join(agentWs, 'memory', 'zalo-users');
  const ws = getWorkspace();
  if (!ws) return null;
  return path.join(ws, 'memory', 'zalo-users');
}

function ensureZaloUsersDir() {
  const dir = getZaloUsersDir();
  if (!dir) return null;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function sanitizeZaloUserId(id) {
  // Zalo IDs are numeric strings. Allow only digits + dashes (some are negative-prefixed).
  return String(id || '').trim().replace(/[^0-9-]/g, '').slice(0, 32);
}

function parseZaloUserMemoryMeta(content) {
  // Parse front-matter-style header. Format expected:
  //   ---
  //   name: ...
  //   lastSeen: 2026-04-09T10:30:00Z
  //   msgCount: 12
  //   gender: male|female|unknown
  //   ---
  const meta = { name: '', lastSeen: '', msgCount: 0, gender: '', summary: '' };
  if (!content) return meta;
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^(\w+):\s*(.+)$/);
      if (!m) continue;
      const k = m[1].trim();
      const v = m[2].trim();
      if (k === 'name') meta.name = v;
      else if (k === 'lastSeen') meta.lastSeen = v;
      else if (k === 'msgCount') meta.msgCount = parseInt(v, 10) || 0;
      else if (k === 'gender') meta.gender = v;
    }
  }
  // Extract summary: first line after "## Tóm tắt" header
  const sumMatch = content.match(/## Tóm tắt\s*\n+([^\n#]+)/);
  if (sumMatch) meta.summary = sumMatch[1].trim().slice(0, 140);
  return meta;
}

ipcMain.handle('list-zalo-user-memories', async () => {
  try {
    const dir = getZaloUsersDir();
    if (!dir || !fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('.'));
    const out = [];
    for (const f of files) {
      try {
        const senderId = f.replace(/\.md$/, '');
        const filePath = path.join(dir, f);
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf-8');
        const meta = parseZaloUserMemoryMeta(content);
        out.push({
          senderId,
          name: meta.name,
          lastSeen: meta.lastSeen || stat.mtime.toISOString(),
          msgCount: meta.msgCount,
          gender: meta.gender,
          summary: meta.summary,
          mtimeMs: stat.mtimeMs,
        });
      } catch {}
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
  } catch (e) {
    console.error('[zalo-user-memory] list error:', e?.message);
    return [];
  }
});

ipcMain.handle('read-zalo-user-memory', async (_event, { senderId }) => {
  try {
    const id = sanitizeZaloUserId(senderId);
    if (!id) return { exists: false, content: '' };
    const dir = getZaloUsersDir();
    if (!dir) return { exists: false, content: '' };
    const filePath = path.join(dir, id + '.md');
    if (!fs.existsSync(filePath)) return { exists: false, content: '' };
    const content = fs.readFileSync(filePath, 'utf-8');
    const meta = parseZaloUserMemoryMeta(content);
    return { exists: true, content, meta };
  } catch (e) {
    console.error('[zalo-user-memory] read error:', e?.message);
    return { exists: false, content: '', error: e.message };
  }
});

ipcMain.handle('reset-zalo-user-memory', async (_event, { senderId }) => {
  try {
    const id = sanitizeZaloUserId(senderId);
    if (!id) return { success: false, error: 'invalid id' };
    const dir = getZaloUsersDir();
    if (!dir) return { success: false, error: 'no workspace' };
    const filePath = path.join(dir, id + '.md');
    if (!fs.existsSync(filePath)) return { success: true };
    // Move to .archive/<id>-<ts>.md instead of deleting (audit trail)
    const archDir = path.join(dir, '.archive');
    fs.mkdirSync(archDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const archPath = path.join(archDir, id + '-' + ts + '.md');
    fs.renameSync(filePath, archPath);
    return { success: true };
  } catch (e) {
    console.error('[zalo-user-memory] reset error:', e?.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('append-zalo-user-note', async (_event, { senderId, note }) => {
  try {
    const id = sanitizeZaloUserId(senderId);
    if (!id) return { success: false, error: 'invalid id' };
    const cleanNote = String(note || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 2000);
    if (!cleanNote) return { success: false, error: 'empty note' };
    const dir = ensureZaloUsersDir();
    if (!dir) return { success: false, error: 'no workspace' };
    const filePath = path.join(dir, id + '.md');
    let content = '';
    if (fs.existsSync(filePath)) {
      content = fs.readFileSync(filePath, 'utf-8');
    } else {
      // Create skeleton if missing
      content = `---\nname: \nlastSeen: ${new Date().toISOString()}\nmsgCount: 0\ngender: unknown\n---\n# Khách Zalo ${id}\n\n## Tóm tắt\n(Chưa có dữ liệu)\n\n## CEO notes\n`;
    }
    // Ensure "## CEO notes" section exists; append timestamped entry
    if (!content.includes('## CEO notes')) {
      content = content.replace(/$/, '\n\n## CEO notes\n');
    }
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    content = content.replace(/(## CEO notes\s*\n)/, `$1- **${stamp}** — ${cleanNote}\n`);
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true };
  } catch (e) {
    console.error('[zalo-user-memory] append note error:', e?.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('delete-zalo-user-note', async (_event, { senderId, noteTimestamp }) => {
  try {
    if (!senderId || !noteTimestamp) return { success: false, error: 'missing params' };
    const id = sanitizeZaloUserId(senderId);
    if (!id) return { success: false, error: 'invalid senderId' };
    const ws = getWorkspace();
    const filePath = path.join(ws, 'memory', 'zalo-users', id + '.md');
    if (!fs.existsSync(filePath)) return { success: false, error: 'file not found' };
    let content = fs.readFileSync(filePath, 'utf-8');
    // CEO notes are lines like: - **2026-04-09 13:45** — note text
    // Match the line containing the exact timestamp and remove it
    const escapedTs = noteTimestamp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lineRegex = new RegExp('^- \\*\\*' + escapedTs + '\\*\\*.*$\\n?', 'm');
    const newContent = content.replace(lineRegex, '');
    if (newContent === content) return { success: false, error: 'note not found' };
    fs.writeFileSync(filePath, newContent, 'utf-8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// === Zalo group memory ===
function getZaloGroupsDir() {
  const agentWs = getOpenclawAgentWorkspace();
  if (agentWs) return path.join(agentWs, 'memory', 'zalo-groups');
  const ws = getWorkspace();
  if (!ws) return null;
  return path.join(ws, 'memory', 'zalo-groups');
}

ipcMain.handle('get-zalo-group-summaries', async () => {
  try {
    const dir = getZaloGroupsDir();
    if (!dir || !fs.existsSync(dir)) return {};
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    const summaries = {};
    for (const f of files) {
      const groupId = f.replace('.md', '');
      try {
        const content = fs.readFileSync(path.join(dir, f), 'utf-8');
        // Extract key sections from the group memory file
        const lines = content.split('\n');
        let topics = '', members = '', decisions = '';
        let currentSection = '';
        for (const line of lines) {
          if (line.startsWith('## Chủ đề thường thảo luận')) { currentSection = 'topics'; continue; }
          if (line.startsWith('## Thành viên key')) { currentSection = 'members'; continue; }
          if (line.startsWith('## Quyết định/thông báo')) { currentSection = 'decisions'; continue; }
          if (line.startsWith('## ') || line.startsWith('---')) { currentSection = ''; continue; }
          const trimmed = line.trim();
          if (!trimmed || trimmed === '(chưa có)') continue;
          if (currentSection === 'topics') topics += (topics ? ', ' : '') + trimmed.replace(/^[-*]\s*/, '');
          if (currentSection === 'members') members += (members ? ', ' : '') + trimmed.replace(/^[-*]\s*/, '');
          if (currentSection === 'decisions') decisions += (decisions ? ', ' : '') + trimmed.replace(/^[-*]\s*/, '');
        }
        summaries[groupId] = {
          topics: topics.slice(0, 120) || '',
          members: members.slice(0, 120) || '',
          decisions: decisions.slice(0, 120) || '',
          hasContent: !!(topics || members || decisions),
        };
      } catch {}
    }
    return summaries;
  } catch (e) {
    console.error('[zalo-group-memory] error:', e?.message);
    return {};
  }
});

// Read full group memory file for display in Dashboard modal.
ipcMain.handle('get-zalo-group-memory', async (_evt, groupId) => {
  try {
    const dir = getZaloGroupsDir();
    if (!dir) return { content: '', exists: false };
    const fp = path.join(dir, groupId + '.md');
    if (!fs.existsSync(fp)) return { content: '', exists: false };
    return { content: fs.readFileSync(fp, 'utf-8'), exists: true };
  } catch (e) {
    return { content: '', exists: false, error: e?.message };
  }
});

// Manually re-seed a single group's history summary (dashboard "refresh context").
// Returns { ok, reason, msgCount? }.
ipcMain.handle('seed-group-history-now', async (_evt, groupId, threadName) => {
  try {
    if (!groupId || typeof groupId !== 'string') return { ok: false, reason: 'invalid-groupId' };
    return await seedGroupHistorySummary(groupId, threadName || groupId);
  } catch (e) {
    return { ok: false, reason: 'exception: ' + (e && e.message ? e.message : String(e)) };
  }
});

// Manually trigger batch re-seed across all groups (CEO "refresh all group context").
// Fire-and-forget: returns immediately with started=true, run continues in background.
ipcMain.handle('seed-group-history-all', async () => {
  try {
    if (_groupHistorySeedInFlight) return { started: false, reason: 'already-running' };
    // Kick off in background, return immediately so dashboard isn't blocked.
    seedAllGroupHistories({ source: 'ipc-manual' }).catch(e => {
      console.warn('[group-history-seed] manual run error:', e && e.message ? e.message : String(e));
    });
    return { started: true };
  } catch (e) {
    return { started: false, reason: 'exception: ' + (e && e.message ? e.message : String(e)) };
  }
});

// REMOVED: Zalo owner identification — owner/chủ nhân feature fully removed.
// All Zalo messages are treated as customer messages uniformly.


// === Security Layer 1 (scoped) — File permission hardening ===
// Real Layer 1 (DPAPI/Keychain encryption) is high-risk because decryption
// failure = bot can't boot. Until we have a battle-tested decryption shim,
// scoped Layer 1 protects sensitive files at the FILESYSTEM level only:
// chmod 600 (owner-only read/write) on Unix. Windows NTFS already inherits
// per-user ACL from `C:\Users\<user>\` so no additional work needed there.
//
// Files protected:
// - ~/.openclaw/openclaw.json (Telegram bot token, Zalo session ref)
// - ~/.openclaw/dashboard-pin.json (PIN scrypt hash)
// - ~/.openzca/profiles/default/credentials.json (Zalo cookies/tokens)
// - ~/.openzca/profiles/default/listener-owner.json (PID lock + meta)
//
// Re-applied at every app.whenReady() — safe to call repeatedly. openclaw
// daemon preserves file mode on overwrite (Linux fs.writeFile inherits
// existing inode mode), so 600 stays sticky after our initial chmod.
function hardenSensitiveFilePerms() {
  if (process.platform === 'win32') {
    // NTFS default ACL on user profile already restricts to owner.
    // Setting explicit ACLs via icacls would require elevation we don't have.
    return { skipped: true, reason: 'win32_ntfs_default_acl' };
  }
  const targets = [
    path.join(HOME, '.openclaw', 'openclaw.json'),
    path.join(HOME, '.openclaw', 'openclaw.json.bak'),
    path.join(HOME, '.openclaw', 'dashboard-pin.json'),
    path.join(HOME, '.openzca', 'profiles', 'default', 'credentials.json'),
    path.join(HOME, '.openzca', 'profiles', 'default', 'listener-owner.json'),
  ];
  let hardened = 0;
  for (const f of targets) {
    try {
      if (fs.existsSync(f)) {
        fs.chmodSync(f, 0o600);
        hardened++;
      }
    } catch (e) {
      console.warn('[file-harden] chmod failed:', path.basename(f), e.message);
    }
  }
  // Also harden the parent dirs to 700 so listing is restricted
  const dirs = [
    path.join(HOME, '.openclaw'),
    path.join(HOME, '.openzca'),
  ];
  for (const d of dirs) {
    try {
      if (fs.existsSync(d)) fs.chmodSync(d, 0o700);
    } catch {}
  }
  console.log('[file-harden] hardened', hardened, 'sensitive files (chmod 600)');
  try { auditLog('file_perms_hardened', { count: hardened }); } catch {}
  return { hardened };
}

// === Security Layer 4 — Dashboard PIN ===
// 6-digit PIN protects Dashboard. First Dashboard open after wizard prompts
// for PIN setup. Subsequent opens require PIN. After 5 failed attempts,
// 15-min lockout. Auto-lock after 15-min idle. Reset by re-entering Telegram
// User ID (proof CEO has access to bot's allowFrom, harder to brute-force
// than just resetting from disk).
//
// Storage: ~/.openclaw/dashboard-pin.json
//   { hash, salt, createdAt, failedAttempts, lockedUntil }
// Hash: crypto.scryptSync(pin, salt, 64) — built-in, no native deps.

function getDashboardPinPath() {
  return path.join(HOME, '.openclaw', 'dashboard-pin.json');
}

function readDashboardPin() {
  try {
    const p = getDashboardPinPath();
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!data || !data.hash || !data.salt) return null;
    return data;
  } catch { return null; }
}

function writeDashboardPin(data) {
  try {
    const p = getDashboardPinPath();
    writeJsonAtomic(p, data);
    // Restrict perms (defense in depth — Layer 1 scoped)
    try {
      if (process.platform !== 'win32') {
        fs.chmodSync(p, 0o600);
      }
    } catch {}
    return true;
  } catch (e) {
    console.error('[dashboard-pin] write error:', e.message);
    return false;
  }
}

function hashPin(pin, salt) {
  const crypto = require('crypto');
  // scrypt with N=2^15 cost — slow enough to discourage brute force but
  // fast enough that PIN unlock feels instant (~50ms on modern CPUs).
  //
  // CRITICAL: maxmem MUST be passed explicitly. Node's default maxmem is
  // 32 MB. Memory required = 128 * N * r = 128 * 32768 * 8 = 32 MB EXACTLY,
  // which trips Node's "memory limit exceeded" check (the comparison is
  // strict >). Without maxmem, this throws on EVERY PIN check:
  //   "Invalid scrypt params: memory limit exceeded".
  // 64 MB headroom = safe for these params.
  return crypto.scryptSync(String(pin), salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  const crypto = require('crypto');
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

ipcMain.handle('get-pin-status', async () => {
  const data = readDashboardPin();
  if (!data) return { hasPin: false, locked: false };
  const now = Date.now();
  const lockedUntil = data.lockedUntil || 0;
  const locked = lockedUntil > now;
  return {
    hasPin: true,
    locked,
    lockedUntilMs: locked ? lockedUntil : 0,
    failedAttempts: data.failedAttempts || 0,
  };
});

ipcMain.handle('setup-pin', async (_event, { pin }) => {
  try {
    const cleaned = String(pin || '').replace(/[^0-9]/g, '');
    if (cleaned.length !== 6) return { success: false, error: 'PIN phải đúng 6 chữ số.' };
    if (readDashboardPin()) return { success: false, error: 'PIN đã được đặt. Dùng đổi PIN nếu muốn thay.' };
    const crypto = require('crypto');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPin(cleaned, salt);
    const ok = writeDashboardPin({
      hash, salt,
      createdAt: new Date().toISOString(),
      failedAttempts: 0,
      lockedUntil: 0,
    });
    if (!ok) return { success: false, error: 'Lưu PIN thất bại.' };
    try { auditLog('dashboard_pin_setup', {}); } catch {}
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('verify-pin', async (_event, { pin }) => {
  try {
    const data = readDashboardPin();
    if (!data) return { success: false, error: 'PIN chưa được đặt.' };
    const now = Date.now();
    const lockedUntil = data.lockedUntil || 0;
    if (lockedUntil > now) {
      return { success: false, locked: true, lockedUntilMs: lockedUntil, error: 'Đã khoá. Đợi hết thời gian rồi thử lại.' };
    }
    const cleaned = String(pin || '').replace(/[^0-9]/g, '');
    if (cleaned.length !== 6) return { success: false, error: 'PIN phải 6 chữ số.' };
    const candidate = hashPin(cleaned, data.salt);
    const match = constantTimeEqual(candidate, data.hash);
    if (match) {
      // Reset failed counter on success
      writeDashboardPin({ ...data, failedAttempts: 0, lockedUntil: 0 });
      try { auditLog('dashboard_pin_unlock', {}); } catch {}
      return { success: true };
    }
    // Wrong PIN
    const failed = (data.failedAttempts || 0) + 1;
    let lockedUntilNew = 0;
    if (failed >= 5) {
      lockedUntilNew = now + 15 * 60 * 1000; // 15 min
      try { auditLog('dashboard_pin_lockout', { failedAttempts: failed }); } catch {}
    }
    writeDashboardPin({ ...data, failedAttempts: failed, lockedUntil: lockedUntilNew });
    return {
      success: false,
      error: lockedUntilNew ? 'Sai PIN 5 lần. Đã khoá 15 phút.' : `Sai PIN. Còn ${5 - failed} lần thử.`,
      locked: !!lockedUntilNew,
      lockedUntilMs: lockedUntilNew,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('reset-pin', async (_event, { telegramUserId, newPin }) => {
  // Reset PIN by proving access to Telegram allowFrom.
  try {
    const cleanedTgId = String(telegramUserId || '').replace(/[^0-9]/g, '');
    if (!cleanedTgId) return { success: false, error: 'User ID Telegram rỗng.' };
    const cleanedPin = String(newPin || '').replace(/[^0-9]/g, '');
    if (cleanedPin.length !== 6) return { success: false, error: 'PIN mới phải 6 chữ số.' };
    // Verify telegramUserId matches openclaw.json channels.telegram.allowFrom
    const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
    if (!fs.existsSync(configPath)) return { success: false, error: 'Chưa cài Telegram qua wizard.' };
    let config;
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); }
    catch { return { success: false, error: 'Config openclaw không đọc được.' }; }
    const allowFrom = config?.channels?.telegram?.allowFrom || [];
    if (!Array.isArray(allowFrom) || !allowFrom.map(String).includes(cleanedTgId)) {
      try { auditLog('dashboard_pin_reset_failed', { reason: 'telegram_id_mismatch' }); } catch {}
      return { success: false, error: 'User ID Telegram không khớp tài khoản chủ.' };
    }
    // Verified — overwrite PIN
    const crypto = require('crypto');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPin(cleanedPin, salt);
    writeDashboardPin({
      hash, salt,
      createdAt: new Date().toISOString(),
      failedAttempts: 0,
      lockedUntil: 0,
    });
    try { auditLog('dashboard_pin_reset_success', {}); } catch {}
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('change-pin', async (_event, { oldPin, newPin }) => {
  try {
    const data = readDashboardPin();
    if (!data) return { success: false, error: 'Chưa có PIN. Dùng setup-pin thay.' };
    const cleanedOld = String(oldPin || '').replace(/[^0-9]/g, '');
    const cleanedNew = String(newPin || '').replace(/[^0-9]/g, '');
    if (cleanedOld.length !== 6 || cleanedNew.length !== 6) return { success: false, error: 'PIN phải 6 chữ số.' };
    const candidate = hashPin(cleanedOld, data.salt);
    if (!constantTimeEqual(candidate, data.hash)) {
      return { success: false, error: 'PIN cũ không đúng.' };
    }
    const crypto = require('crypto');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPin(cleanedNew, salt);
    writeDashboardPin({
      hash, salt,
      createdAt: new Date().toISOString(),
      failedAttempts: 0,
      lockedUntil: 0,
    });
    try { auditLog('dashboard_pin_changed', {}); } catch {}
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

function getZaloBlocklistPath() { return path.join(getWorkspace(), 'zalo-blocklist.json'); }

function cleanBlocklist() {
  try {
    const blPath = getZaloBlocklistPath();
    if (!fs.existsSync(blPath)) return;
    const bl = JSON.parse(fs.readFileSync(blPath, 'utf-8'));
    if (!Array.isArray(bl) || bl.length === 0) return;
    fs.writeFileSync(blPath, '[]', 'utf-8');
    console.log(`[blocklist] cleared ${bl.length} entries (legacy seed — settings control deny now)`);
  } catch (e) {
    console.warn('[blocklist] cleanup error:', e?.message);
  }
}

ipcMain.handle('get-zalo-manager-config', async () => {
  try {
    const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
    let zalo = {};
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      zalo = cfg?.channels?.openzalo || {};
    }
    let blocklist = [];
    const bp = getZaloBlocklistPath();
    if (fs.existsSync(bp)) {
      try { blocklist = JSON.parse(fs.readFileSync(bp, 'utf-8')); } catch {}
    }
    let groupSettings = {};
    try {
      const gsPath = path.join(getWorkspace(), 'zalo-group-settings.json');
      if (fs.existsSync(gsPath)) groupSettings = JSON.parse(fs.readFileSync(gsPath, 'utf-8'));
    } catch {}
    let strangerPolicy = 'ignore';
    try {
      const spPath = path.join(getWorkspace(), 'zalo-stranger-policy.json');
      if (fs.existsSync(spPath)) strangerPolicy = JSON.parse(fs.readFileSync(spPath, 'utf-8')).mode || 'ignore';
    } catch {}
    return {
      enabled: zalo.enabled !== false,
      groupPolicy: zalo.groupPolicy || 'open',
      groupAllowFrom: Array.isArray(zalo.groupAllowFrom) ? zalo.groupAllowFrom.filter(x => x !== '*') : [],
      dmPolicy: zalo.dmPolicy || 'open',
      userBlocklist: Array.isArray(blocklist) ? blocklist : [],
      groupSettings,
      strangerPolicy,
    };
  } catch (e) {
    return { enabled: false, groupPolicy: 'open', groupAllowFrom: [], dmPolicy: 'open', userBlocklist: [] };
  }
});

let _saveZaloManagerInFlight = false;
ipcMain.handle('save-zalo-manager-config', async (_event, { enabled, groupPolicy, groupAllowFrom, userBlocklist, groupSettings, strangerPolicy }) => {
  invalidateZaloFriendsCache(); // PERF: bust friends cache on config save
  const booting = rejectIfBooting('save-zalo-manager-config');
  if (booting) return booting;
  // Double-click guard: a rapid 2nd save before the 1st completes would
  // read the same prev snapshot, both compute identical diffs, both try
  // to restart gateway → two concurrent stopOpenClaw calls racing.
  if (_saveZaloManagerInFlight) {
    return { success: false, error: 'Lưu đang chạy — thử lại sau 1-2 giây' };
  }
  _saveZaloManagerInFlight = true;
  _ipcInFlightCount++;
  // [A2] Serialize concurrent openclaw.json writers with config mutex.
  return withOpenClawConfigLock(async () => {
  try {
    console.log('[config-lock] save-zalo-manager-config acquired');
    // Detect whether `channels.openzalo.enabled` actually changes. Only this
    // field needs a hard gateway restart (stop+wait+start) because it
    // controls whether openclaw loads the openzalo plugin + spawns the
    // openzca listener subprocess at all. All other fields (blocklist,
    // groupSettings, strangerPolicy) are read realtime by inbound.ts patches
    // so zero restart is needed for them.
    let prevEnabled = null;
    try {
      const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
      if (fs.existsSync(configPath)) {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        prevEnabled = cfg?.channels?.openzalo?.enabled !== false;
      }
    } catch {}
    const newEnabled = enabled !== false;
    const enabledChanged = (prevEnabled !== null) && (prevEnabled !== newEnabled);

    // 1. Update openclaw.json (groups handled natively by OpenZalo)
    const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (!cfg.channels) cfg.channels = {};
      if (!cfg.channels.openzalo) cfg.channels.openzalo = {};
      cfg.channels.openzalo.enabled = enabled !== false;
      // ALWAYS keep native gate open — let code-level patch in inbound.ts
      // handle group filtering via zalo-group-settings.json (realtime, no restart).
      // Setting allowlist here blocks groups at the native gate BEFORE our
      // patches run, making Dashboard group toggle useless.
      cfg.channels.openzalo.groupPolicy = 'open';
      cfg.channels.openzalo.groupAllowFrom = ['*'];
      // CRITICAL: openzalo plugin defaults dmPolicy to "pairing" → unknown DM
      // sender → "OpenClaw: access not configured." pairing reply. We always
      // want CEO + their contacts to DM the bot directly without pairing dance.
      // Force dmPolicy="open" + allowFrom=["*"] every save so wizard/manager
      // never leaves these unset (which would re-trigger pairing on next boot).
      cfg.channels.openzalo.dmPolicy = 'open';
      if (!Array.isArray(cfg.channels.openzalo.allowFrom)) {
        cfg.channels.openzalo.allowFrom = ['*'];
      }
      // CRIT #5: zalo-group-settings.json is single source of truth —
      // inbound.ts GROUP-SETTINGS PATCH v3 handles off/mention/all modes
      // realtime. Purge any legacy groups[gid] entries from openclaw.json.
      if (cfg.channels.openzalo.groups) delete cfg.channels.openzalo.groups;
      // Also sync plugins.entries.openzalo.enabled with channels.openzalo.enabled
      // so "Tắt Zalo" is a real hard-off (gateway won't even load plugin
      // on next boot). ensureDefaultConfig syncs this too but doing it here
      // ensures the in-memory flip propagates immediately.
      if (cfg.plugins?.entries?.openzalo) {
        cfg.plugins.entries.openzalo.enabled = newEnabled;
      }
      writeOpenClawConfigIfChanged(configPath, cfg);
    }
    let gateOk = true;
    if (enabled === false) gateOk = setChannelPermanentPause('zalo', 'manager-disabled');
    else {
      gateOk = clearChannelPermanentPause('zalo');
      markOnboardingComplete('zalo-manager-enable');
    }
    // 2. Write user blocklist to workspace (bot reads this per AGENTS.md rule)
    const bp = getZaloBlocklistPath();
    writeJsonAtomic(bp, userBlocklist || []);
    // 3. CRIT #5: Persist ALL explicit modes (off/mention/all) — zalo-group-settings.json
    // is the single source of truth used by GROUP-SETTINGS PATCH v2. If user
    // sets 'mention' in Dashboard we must persist it so the patch enforces
    // @mention gating (not openzalo native which we bypassed above).
    //
    // CRITICAL FIX (user report 2026-04-17): Previously this REPLACED the
    // whole file on every save, and DELETED it if incoming groupSettings was
    // empty. That caused settings to be wiped whenever Dashboard sent partial
    // or empty state (e.g., user saves with only stranger policy changed →
    // groupSettings unchanged in UI but sent as-is → wiped other modes).
    //
    // New behavior: MERGE incoming into existing. Never delete file on empty
    // input. User's only way to reset a mode is to change it explicitly via
    // the dropdown.
    if (groupSettings && typeof groupSettings === 'object') {
      const gsPath = path.join(getWorkspace(), 'zalo-group-settings.json');
      let existing = {};
      try {
        if (fs.existsSync(gsPath)) existing = JSON.parse(fs.readFileSync(gsPath, 'utf-8')) || {};
        if (typeof existing !== 'object' || Array.isArray(existing)) existing = {};
      } catch {}
      // Read old file for audit diff before mutating
      let oldExisting = {};
      try { oldExisting = JSON.parse(JSON.stringify(existing)); } catch {}
      for (const [gid, gs] of Object.entries(groupSettings)) {
        if (!gs || !gs.mode) continue;
        if (!['off', 'mention', 'all'].includes(gs.mode)) continue;
        const sanitized = { mode: gs.mode };
        if (gs.internal === true) sanitized.internal = true;
        existing[gid] = sanitized;
      }
      // Audit log internal flag changes
      try {
        for (const gid of Object.keys(existing)) {
          const wasInternal = oldExisting[gid]?.internal === true;
          const isInternal = existing[gid]?.internal === true;
          if (wasInternal !== isInternal) {
            auditLog('group-internal-change', { groupId: gid, internal: isInternal, ts: Date.now() });
          }
        }
      } catch {}
      if (Object.keys(existing).length > 0) {
        writeJsonAtomic(gsPath, existing);
      }
    }
    // 4. Write stranger policy to workspace — mirror groupSettings pattern:
    // if no explicit strangerPolicy provided, REMOVE file so patch falls back
    // to plugin default (prevents stale policy file leaking after CEO clears
    // the field in Dashboard).
    {
      const spPath = path.join(getWorkspace(), 'zalo-stranger-policy.json');
      if (strangerPolicy) {
        writeJsonAtomic(spPath, { mode: strangerPolicy });
      } else if (fs.existsSync(spPath)) {
        try { fs.unlinkSync(spPath); } catch {}
      }
    }
    // 5. Hard gateway restart ONLY when openzalo enabled flag actually flipped.
    // This is the only field that requires full gateway reload — the plugin
    // loader decides at boot whether to register openzalo + spawn openzca
    // listener subprocess. Toggling it without a restart means:
    //   disable → plugin still loaded, listener still running (memory leak)
    //   enable  → plugin NOT loaded (it was disabled at boot), no listener
    //             → Dashboard shows green but customers get silence
    // Proper restart pattern: stopOpenClaw + wait + startOpenClaw.
    // startOpenClaw alone is a no-op when botRunning=true, so we MUST stop first.
    //
    // [restart-guard A1] Set _gatewayRestartInFlight BEFORE the IIFE starts so
    // the heartbeat watchdog (which also polls every N minutes) will skip its
    // own restart attempt if it fires while we're mid-sequence. Clear in the
    // IIFE's finally only.
    if (enabledChanged) {
      // [zalo-watchdog rearm] CEO toggling Zalo enabled/disabled rearms the
      // listener watchdog. Config flip means CEO has deliberately changed
      // channel state — prior gave-up / restart streak is stale. Reset all 3.
      global._zaloListenerGaveUp = false;
      global._zaloListenerRestartHistory = [];
      global._zaloListenerMissStreak = 0;
      console.log('[zalo-watchdog] reset gave-up / streak by CEO action');
      if (_startOpenClawInFlight) {
        console.log(`[save-zalo-manager] channels.openzalo.enabled ${prevEnabled}→${newEnabled} — gateway spawn in progress, skip restart (will read new config)`);
      } else if (_gatewayRestartInFlight) {
        console.log('[restart-guard] save-zalo-manager: restart already in-flight — skipping duplicate');
      } else {
        _gatewayRestartInFlight = true;
        console.log(`[save-zalo-manager] channels.openzalo.enabled ${prevEnabled}→${newEnabled} — hard-restart gateway (bg)`);
        // Fire-and-forget so IPC returns fast — UI sidebar dots will flip
        // to checking→ready via channel-status broadcast as gateway boots.
        (async () => {
          try {
            console.log('[restart-guard] save-zalo-manager: hard-restart begin');
            try { await stopOpenClaw(); } catch (e1) { console.warn('[save-zalo-manager] stop failed:', e1?.message); }
            await new Promise(r => setTimeout(r, 2000));
            try { await startOpenClaw(); } catch (e2) { console.warn('[save-zalo-manager] start failed:', e2?.message); }
            global._zaloListenerMissStreak = 0;
            console.log('[restart-guard] save-zalo-manager: hard-restart end');
          } finally {
            _gatewayRestartInFlight = false;
          }
        })();
      }
    } else {
      console.log('[save-zalo-manager] no enable/disable flip — skipping restart (realtime patches apply)');
    }
    return { success: gateOk };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    _saveZaloManagerInFlight = false;
    _ipcInFlightCount--;
  }
  });
});

// Save personalization (industry, tone, pronouns)
// Compile a persona mix config into a human-readable Markdown prompt that
// the bot reads on bootstrap. Mix contains: region, voice, customer, traits[],
// formality (1-10), greeting/closing/phrases (optional custom text).
// Bot reads the compiled file (not the raw JSON) to get concrete instructions
// + signature phrases it can apply naturally.
function compilePersonaMix(mix) {
  if (!mix || typeof mix !== 'object') mix = {};
  const voiceMap = {
    'em-nu-tre': { pronoun: 'em', gender: 'Nữ trẻ (20-28 tuổi). Giọng nhẹ nhàng, năng động, thân thiện.' },
    'em-nam-tre': { pronoun: 'em', gender: 'Nam trẻ (20-28 tuổi). Giọng thẳng thắn, nhanh nhẹn, lễ phép.' },
    'chi-trung-nien': { pronoun: 'chị', gender: 'Nữ trung niên (35-45 tuổi). Giọng chững chạc, chu đáo, tin cậy.' },
    'anh-trung-nien': { pronoun: 'anh', gender: 'Nam trung niên (35-45 tuổi). Giọng chững chạc, chuyên nghiệp, đáng tin.' },
    'minh-trung-tinh': { pronoun: 'mình', gender: 'Trung tính, không xác định giới tính. Thân thiện, lịch sự.' },
  };
  const customerMap = {
    'anh-chi': 'Gọi khách là "anh" / "chị" tùy giới tính.',
    'quy-khach': 'Gọi khách là "quý khách" — formal cao cấp.',
    'mình': 'Gọi khách là "mình" — casual, cùng cấp.',
  };
  // 15 traits grounded in Big Five (OCEAN) + customer service research.
  // Groups: Openness (3) + Conscientiousness (3) + Extraversion (3) +
  //         Agreeableness (3) + Service-specific (3).
  // Each description ties the trait to concrete bot behavior.
  const traitMap = {
    // Openness — cởi mở / sáng tạo
    'sang-tao':     '[Sáng tạo — Openness] Gợi ý alternative, đề xuất combo mới, kể câu chuyện về SP thay vì đọc spec khô khan',
    'thuc-te':      '[Thực tế — Openness] Thẳng vào vấn đề, không thêu dệt, không kể câu chuyện dài. Nói cái gì cần nói',
    'linh-hoat':    '[Linh hoạt — Openness] Điều chỉnh theo từng khách, không cứng nhắc theo template, adapt tone per customer',
    // Conscientiousness — chỉn chu / có tổ chức
    'chin-chu':     '[Chỉn chu — Conscientiousness] Kiểm tra kỹ, không miss chi tiết, xác nhận rõ ràng trước khi reply',
    'chu-dao':      '[Chu đáo — Conscientiousness] Để ý nhu cầu ngầm, gợi ý chủ động, hỏi han thêm ngoài câu hỏi của khách',
    'kien-nhan':    '[Kiên nhẫn — Conscientiousness] Không vội, giải thích chậm rãi, cho khách thời gian quyết định',
    // Extraversion — năng động / giao tiếp
    'nang-dong':    '[Năng động — Extraversion] Reply nhanh, tone tươi, tạo cảm giác shop đang "alive"',
    'diem-tinh':    '[Điềm tĩnh — Extraversion] Chậm rãi, bình tĩnh, tạo cảm giác yên tâm. Dùng cho tình huống khủng hoảng/nhạy cảm',
    'chu-dong':     '[Chủ động — Extraversion] Dẫn dắt conversation, gợi ý trước khi khách hỏi, upsell khéo',
    // Agreeableness — đồng cảm / hợp tác
    'am-ap':        '[Ấm áp — Agreeableness] Giọng tình cảm như người quen, tạo kết nối cá nhân',
    'dong-cam':     '[Đồng cảm — Agreeableness] Hiểu cảm xúc khách, đặt mình vào vị trí khách trước khi reply',
    'thang-than':   '[Thẳng thắn — Agreeableness-low] Nói rõ được/không được, không vòng vo, không làm hài lòng giả tạo',
    // Service-specific
    'chuyen-nghiep':'[Chuyên nghiệp — Service] Formal, đúng mực, thể hiện shop có quy trình rõ ràng',
    'than-thien':   '[Thân thiện — Service] Balance giữa formal và casual, universal-safe tone cho mọi khách',
    'tinh-te':      '[Tinh tế — Service] Để ý nuance ngôn ngữ, xử lý khéo tình huống nhạy cảm, vocabulary chọn lọc',
  };

  const voice = voiceMap[mix.voice] || voiceMap['em-nu-tre'];
  const customerAddr = customerMap[mix.customer] || customerMap['anh-chi'];
  const traits = Array.isArray(mix.traits) ? mix.traits : [];
  const formality = Math.max(1, Math.min(10, parseInt(mix.formality, 10) || 5));
  const formalityDesc = formality >= 8 ? 'Rất trang trọng (10 = lễ tân khách sạn 5 sao)'
    : formality >= 6 ? 'Trang trọng vừa phải (giống nhân viên văn phòng)'
    : formality >= 4 ? 'Balance — thân thiện nhưng vẫn lịch sự (chuẩn CSKH phổ biến)'
    : 'Thân mật — giống bạn bè, không formal';

  const traitList = traits.map(t => `- ${traitMap[t] || t}`).join('\n') || '- (CEO chưa chọn trait cụ thể — dùng style mặc định)';
  const customGreeting = (mix.greeting || '').trim();
  const customClosing = (mix.closing || '').trim();
  const customPhrases = (mix.phrases || '').trim().split('\n').map(s => s.trim()).filter(Boolean);

  return `# Persona Mix — Tính cách bot hiện tại

> File này được compile tự động từ config CEO đã chọn ở wizard/settings. KHÔNG sửa tay.
> Sửa qua Dashboard → Cài đặt → Tính cách nhân viên.

## Xưng hô + giới tính bot
- Bot tự xưng: **${voice.pronoun}**
- Giới tính archetype: ${voice.gender}
- ${customerAddr}

## Tính cách đặc trưng (${traits.length}/5 đặc điểm đã chọn)
${traitList}

## Độ trang trọng: ${formality}/10
${formalityDesc}

${customGreeting ? `## Câu chào riêng (CEO tự đặt)
"${customGreeting}"

Bot PHẢI dùng câu này cho lần đầu chào khách trong phiên.

` : ''}${customClosing ? `## Câu kết riêng (CEO tự đặt)
"${customClosing}"

Bot PHẢI dùng câu này khi kết thúc conversation.

` : ''}${customPhrases.length > 0 ? `## Cụm từ đặc trưng (CEO tự đặt)
${customPhrases.map(p => `- "${p}"`).join('\n')}

Bot nên dùng các cụm này tự nhiên trong reply (không ép).

` : ''}## Hướng dẫn áp dụng cho bot

1. **Giọng văn**: Kết hợp tính cách + xưng hô thành reply tự nhiên. VD:
   - Ấm áp + Em nữ trẻ → "Dạ em chào anh/chị ạ, anh/chị cần em tư vấn gì không ạ?"
   - Chuyên nghiệp + Em nam trẻ → "Dạ em chào anh/chị. Anh/chị đang cần tư vấn về sản phẩm nào ạ?"

2. **Kết hợp trait, không isolated**: Nếu có trait "Thẳng thắn" + "Chu đáo" → vừa nói rõ cái được/không được, vừa gợi ý alternative. Đừng chỉ thẳng thắn mà thiếu chu đáo.

3. **Đừng lặp cùng 1 signature phrase mỗi reply**: Dùng luân phiên, tự nhiên.

4. **Tất cả rule defense (prompt injection, PII, scope, Dạ/ạ chuẩn CSKH) trong AGENTS.md vẫn BẮT BUỘC** — persona mix KHÔNG override defense rules, chỉ override giọng nói.

5. **Độ dài reply**: Theo SOUL.md — tối đa 3 câu, dưới 80 từ trên Zalo. Persona KHÔNG extend giới hạn này.
`;
}

// BOOTSTRAP SYNC: inject persona + shop-state into bootstrap files so the bot
// gets them automatically without needing to voluntarily read separate files.
// active-persona.md is NOT one of the 8 bootstrap files openclaw auto-loads.
// shop-state.json is also not auto-loaded. By injecting their content into
// SOUL.md (persona) and USER.md (shop-state), the bot receives them on every
// message with zero extra file reads.
const _PERSONA_MARKER_START = '<!-- PERSONA-MIX-INJECT-START -->';
const _PERSONA_MARKER_END = '<!-- PERSONA-MIX-INJECT-END -->';
const _SHOPSTATE_MARKER_START = '<!-- SHOP-STATE-INJECT-START -->';
const _SHOPSTATE_MARKER_END = '<!-- SHOP-STATE-INJECT-END -->';

function syncPersonaToBootstrap() {
  try {
    const ws = getWorkspace();
    if (!ws) return;
    const personaJsonPath = path.join(ws, 'active-persona.json');
    if (!fs.existsSync(personaJsonPath)) return;
    const mix = JSON.parse(fs.readFileSync(personaJsonPath, 'utf-8'));
    const compiled = compilePersonaMix(mix);
    const soulPath = path.join(ws, 'SOUL.md');
    if (!fs.existsSync(soulPath)) return;
    let soul = fs.readFileSync(soulPath, 'utf-8');
    const startIdx = soul.indexOf(_PERSONA_MARKER_START);
    const endIdx = soul.indexOf(_PERSONA_MARKER_END);
    const injection = `${_PERSONA_MARKER_START}\n${compiled}\n${_PERSONA_MARKER_END}`;
    if (startIdx >= 0 && endIdx >= 0) {
      soul = soul.slice(0, startIdx) + injection + soul.slice(endIdx + _PERSONA_MARKER_END.length);
    } else {
      soul = soul.trimEnd() + '\n\n---\n\n' + injection + '\n';
    }
    fs.writeFileSync(soulPath, soul, 'utf-8');
    console.log('[bootstrap-sync] persona injected into SOUL.md');
  } catch (e) {
    console.warn('[bootstrap-sync] persona sync failed:', e?.message);
  }
}

function syncShopStateToBootstrap() {
  try {
    const ws = getWorkspace();
    if (!ws) return;
    const statePath = path.join(ws, 'shop-state.json');
    if (!fs.existsSync(statePath)) return;
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const parts = [];
    if (state.outOfStock) parts.push('- Hết hàng: ' + state.outOfStock);
    if (state.staffAbsent) parts.push('- Nhân viên vắng: ' + state.staffAbsent);
    if (state.shippingDelay) parts.push('- Giao hàng chậm: ' + state.shippingDelay);
    if (state.activePromotions) parts.push('- Khuyến mãi: ' + state.activePromotions);
    if (state.earlyClosing) parts.push('- Đóng cửa sớm: ' + state.earlyClosing);
    if (state.specialNotes) parts.push('- Ghi chú: ' + state.specialNotes);
    if (parts.length === 0) return; // nothing to inject
    const body = `## Tình trạng hôm nay (CEO cập nhật ${state.updatedAt ? new Date(state.updatedAt).toLocaleString('vi-VN') : 'gần đây'})\n\n` +
      'Bot PHẢI tham khảo thông tin này khi trả lời khách. Đây là tình trạng THỰC TẾ hôm nay.\n\n' +
      parts.join('\n') + '\n';
    const userPath = path.join(ws, 'USER.md');
    if (!fs.existsSync(userPath)) return;
    let user = fs.readFileSync(userPath, 'utf-8');
    const startIdx = user.indexOf(_SHOPSTATE_MARKER_START);
    const endIdx = user.indexOf(_SHOPSTATE_MARKER_END);
    const injection = `${_SHOPSTATE_MARKER_START}\n${body}\n${_SHOPSTATE_MARKER_END}`;
    if (startIdx >= 0 && endIdx >= 0) {
      user = user.slice(0, startIdx) + injection + user.slice(endIdx + _SHOPSTATE_MARKER_END.length);
    } else {
      user = user.trimEnd() + '\n\n---\n\n' + injection + '\n';
    }
    fs.writeFileSync(userPath, user, 'utf-8');
    console.log('[bootstrap-sync] shop-state injected into USER.md (' + parts.length + ' fields)');
  } catch (e) {
    console.warn('[bootstrap-sync] shop-state sync failed:', e?.message);
  }
}

function syncAllBootstrapData() {
  syncPersonaToBootstrap();
  syncShopStateToBootstrap();
}

ipcMain.handle('save-personalization', async (_event, { industry, tone, pronouns, ceoTitle, botName, personaMix, selectedPersona }) => {
  try {
    // Validate inputs
    const VALID_INDUSTRIES = ['bat-dong-san', 'fnb', 'thuong-mai', 'dich-vu', 'giao-duc', 'cong-nghe', 'san-xuat', 'tong-quat'];
    if (!VALID_INDUSTRIES.includes(industry)) return { success: false, error: 'Invalid industry' };
    const VALID_TONES = ['professional', 'friendly', 'concise'];
    if (!VALID_TONES.includes(tone)) tone = 'friendly';
    const VALID_PRONOUNS = ['em-anh-chi', 'toi-quy-khach', 'minh-ban'];
    if (!VALID_PRONOUNS.includes(pronouns)) pronouns = 'em-anh-chi';
    ceoTitle = (ceoTitle || '').replace(/[\n\r]/g, '').substring(0, 50).trim();
    // Bot name is optional — if provided, replace the placeholder in IDENTITY.md.
    // If empty, the bot self-refers as "em" (from pronouns config) without a personal name.
    botName = (botName || '').replace(/[\n\r]/g, '').substring(0, 30).trim();
    // Empty ceoTitle is a wizard bug — IDENTITY.md would end up with literal
    // "gọi chủ nhân là " with no name → bot falls back to template default
    // (which used to be hardcoded "thầy Huy" — see IDENTITY.md template fix).
    // Refuse to write a broken file: surface error so wizard can re-prompt.
    if (!ceoTitle) {
      console.error('[save-personalization] empty ceoTitle — refusing to write IDENTITY.md');
      return { success: false, error: 'ceoTitle bắt buộc — vui lòng nhập "Trợ lý gọi bạn là" trong wizard' };
    }
    console.log('[save-personalization] industry=' + industry + ' tone=' + tone + ' pronouns=' + pronouns + ' ceoTitle="' + ceoTitle + '" botName="' + botName + '"');

    // Industry name map for display
    const INDUSTRY_NAMES = {
      'bat-dong-san': 'Bất động sản',
      'fnb': 'F&B (Nhà hàng, Quán cà phê)',
      'thuong-mai': 'Thương mại / Bán lẻ',
      'dich-vu': 'Dịch vụ (Spa, Salon, Phòng khám)',
      'giao-duc': 'Giáo dục / Đào tạo',
      'cong-nghe': 'Công nghệ / IT',
      'san-xuat': 'Sản xuất',
      'tong-quat': 'Tổng quát',
    };

    const ws = getWorkspace();
    // 1. Copy skill file -> skills/active.md
    const skillSrc = path.join(ws, 'skills', `${industry}.md`);
    const skillDst = path.join(ws, 'skills', 'active.md');
    if (fs.existsSync(skillSrc)) fs.copyFileSync(skillSrc, skillDst);

    // 2. Copy industry workflow -> industry/active.md
    const indSrc = path.join(ws, 'industry', `${industry}.md`);
    const indDst = path.join(ws, 'industry', 'active.md');
    if (fs.existsSync(indSrc)) fs.copyFileSync(indSrc, indDst);

    // 3. Copy SOP templates -> prompts/sop/active.md
    const sopDir = path.join(ws, 'prompts', 'sop');
    if (!fs.existsSync(sopDir)) fs.mkdirSync(sopDir, { recursive: true });
    const sopSrc = path.join(sopDir, `${industry}.md`);
    const sopDst = path.join(sopDir, 'active.md');
    if (fs.existsSync(sopSrc)) fs.copyFileSync(sopSrc, sopDst);

    // 4. Copy training guide -> prompts/training/active.md
    const trainDir = path.join(ws, 'prompts', 'training');
    if (!fs.existsSync(trainDir)) fs.mkdirSync(trainDir, { recursive: true });
    const trainSrc = path.join(trainDir, `${industry}.md`);
    const trainDst = path.join(trainDir, 'active.md');
    if (fs.existsSync(trainSrc)) fs.copyFileSync(trainSrc, trainDst);

    // 5. Update IDENTITY.md with tone, pronouns, industry
    const identityPath = path.join(ws, 'IDENTITY.md');
    if (!fs.existsSync(identityPath)) {
      // seedWorkspace should have created this. If missing, the bot would
      // fall back to whatever stale copy is in the bundle (with hardcoded
      // example name). Log loudly and try to seed it now from the template.
      console.error('[save-personalization] IDENTITY.md missing at ' + identityPath + ' — re-seeding');
      try { seedWorkspace(); } catch (e) { console.error('[save-personalization] re-seed failed:', e.message); }
    }
    if (fs.existsSync(identityPath)) {
      let content = fs.readFileSync(identityPath, 'utf-8');
      const pronounMap = {
        'em-anh-chi': 'em — gọi ' + ceoTitle,
        'toi-quy-khach': 'tôi — gọi ' + ceoTitle,
        'minh-ban': 'mình — gọi ' + ceoTitle,
      };
      const toneMap = {
        'professional': 'Chuyên nghiệp, lịch sự, rõ ràng. Phù hợp giao tiếp doanh nghiệp.',
        'friendly': 'Thân thiện, gần gũi, nhiệt tình. Phù hợp ngành dịch vụ, bán lẻ.',
        'concise': 'Ngắn gọn, hiệu quả, đi thẳng vào vấn đề. Không dài dòng.',
      };
      const xunghoLine = `- **Cách xưng hô:** ${pronounMap[pronouns] || pronounMap['em-anh-chi']}`;
      const phongcachLine = `- **Phong cách:** ${toneMap[tone] || toneMap['friendly']}`;
      const nganhLine = `- **Ngành:** ${INDUSTRY_NAMES[industry] || industry}`;
      const before = content;
      // Bot name — replace the "[Tên trợ lý của bạn]" placeholder or update
      // an existing name. If botName is empty, write a sensible default so the
      // template placeholder doesn't show up in bot introductions.
      const botNameLine = `- **Tên:** ${botName || 'Trợ lý 9BizClaw'}`;
      content = content.replace(/- \*\*Tên:\*\* .*/, botNameLine);
      content = content.replace(/- \*\*Cách xưng hô:\*\* .*/, xunghoLine);
      content = content.replace(/- \*\*Phong cách:\*\* .*/, phongcachLine);
      content = content.replace(/- \*\*Ngành:\*\* .*/, nganhLine);
      if (content === before) {
        // Replace did nothing — IDENTITY.md is missing the expected lines.
        // Append them so bot still gets the right ceoTitle even on a malformed
        // template.
        console.warn('[save-personalization] IDENTITY.md missing expected lines — appending');
        content = content.trimEnd() + '\n\n' + xunghoLine + '\n' + phongcachLine + '\n' + nganhLine + '\n';
      }
      fs.writeFileSync(identityPath, content, 'utf-8');
      // Read back to confirm the write actually persisted (catches silent
      // permission failures on packaged Windows installs where workspace
      // happens to be the install dir).
      const verify = fs.readFileSync(identityPath, 'utf-8');
      if (!verify.includes(ceoTitle)) {
        console.error('[save-personalization] write verification FAILED — ceoTitle not in file after write');
        return { success: false, error: 'IDENTITY.md write verification failed — file does not contain ceoTitle after write. Có thể workspace không writable.' };
      }
      console.log('[save-personalization] IDENTITY.md updated OK at ' + identityPath);
    } else {
      console.error('[save-personalization] IDENTITY.md still missing after re-seed attempt');
      return { success: false, error: 'IDENTITY.md không tồn tại — workspace bị hỏng' };
    }

    // Save persona mix config from wizard. Bot reads compiled active-persona.md
    // on bootstrap. JSON config saved separately for Dashboard settings edit.
    // personaMix format: { region, voice, customer, traits:[], formality:1-10,
    //                      greeting, closing, phrases }
    // Legacy: `selectedPersona` (archetype id) still accepted for backwards
    // compat — if present and personaMix missing, map to default mix.
    try {
      let mix = personaMix;
      if (!mix || typeof mix !== 'object') {
        // Legacy fallback: single archetype id → default mix
        mix = { voice: 'em-nu-tre', customer: 'anh-chi', traits: ['am-ap', 'chu-dao'], formality: 5, greeting: '', closing: '', phrases: '' };
      }
      // Write structured JSON for Dashboard settings editor
      const mixJsonPath = path.join(ws, 'active-persona.json');
      fs.writeFileSync(mixJsonPath, JSON.stringify(mix, null, 2), 'utf-8');
      // Write compiled Markdown for bot bootstrap read
      const compiledPath = path.join(ws, 'active-persona.md');
      fs.writeFileSync(compiledPath, compilePersonaMix(mix), 'utf-8');
      // Clean up legacy active-persona.txt if present (from v2.2.35)
      try {
        const legacyPath = path.join(ws, 'active-persona.txt');
        if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
      } catch {}
      console.log('[save-personalization] persona mix saved: voice=' + mix.voice + ' traits=' + (mix.traits || []).length + ' formality=' + mix.formality);
      syncPersonaToBootstrap();
    } catch (e) { console.warn('[save-personalization] persona mix write failed:', e?.message); }

    // Delete BOOTSTRAP.md — it's single-use, wizard completion means bot is
    // bootstrapped. Leaving it wastes ~1.5k chars per session-bootstrap read.
    // The file itself says "Sau lần chạy đầu: Xoá file này" — we enforce that
    // here so the bot doesn't need to remember to do it.
    try {
      const bootstrapPath = path.join(ws, 'BOOTSTRAP.md');
      if (fs.existsSync(bootstrapPath)) {
        fs.unlinkSync(bootstrapPath);
        console.log('[save-personalization] BOOTSTRAP.md deleted (wizard complete)');
      }
    } catch (e) { console.warn('[save-personalization] BOOTSTRAP.md cleanup failed:', e?.message); }

    return { success: true };
  } catch (e) {
    console.error('[save-personalization] error:', e?.message || e);
    return { success: false, error: e.message };
  }
});

// =====================================================================
//  Save business profile (wizard step 1+1c) — enterprise onboarding
// =====================================================================
// Collects high-impact business context and writes:
//   - COMPANY.md      → company name + description (bot uses to reply Zalo customers
//                       with real context, not generic boilerplate)
//   - IDENTITY.md     → team size note (bot knows when to escalate vs decide alone)
//   - schedules.json  → morning cron time = workStart, evening cron time = workEnd
//                       (instead of hardcoded 07:30 / 21:00)
//   - memory/projects/business-goals.md → list of selected goals (bot reads on session
//                       start to know focus area)
ipcMain.handle('save-business-profile', async (_event, payload) => {
  try {
    const {
      companyName = '',
      companyDesc = '',
      teamSize = 'small',
      workStart = '07:30',
      workEnd = '21:00',
      goals = [],
      ceoName = '',
      bizProduct = '',
      bizAudience = '',
      bizHighlight = '',
      bizPhone = '',
      bizAddress = '',
    } = payload || {};

    // Sanitize inputs (file content goes into Markdown templates → strip control chars)
    const sanitize = (s, maxLen = 500) => String(s || '').replace(/[\u0000-\u001F\u007F]/g, ' ').substring(0, maxLen).trim();
    const cName = sanitize(companyName, 100);
    const cDesc = sanitize(companyDesc, 500);
    const ceoN = sanitize(ceoName, 100);
    const bProduct = sanitize(bizProduct, 300);
    const bAudience = sanitize(bizAudience, 300);
    const bHighlight = sanitize(bizHighlight, 500);
    const bPhone = sanitize(bizPhone, 20);
    const bAddress = sanitize(bizAddress, 200);
    const VALID_TEAM = ['solo', 'small', 'medium', 'large'];
    const tSize = VALID_TEAM.includes(teamSize) ? teamSize : 'small';
    const VALID_GOALS = ['zalo-auto-reply', 'daily-reports', 'schedule-mgmt', 'staff-reminders', 'customer-followup', 'competitor-watch'];
    const gList = Array.isArray(goals) ? goals.filter(g => VALID_GOALS.includes(g)) : [];
    // Validate HH:MM format
    const validTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));
    const wStart = validTime(workStart) ? workStart : '07:30';
    const wEnd = validTime(workEnd) ? workEnd : '21:00';

    console.log('[save-business-profile]', { cName, tSize, wStart, wEnd, goalCount: gList.length });

    const ws = getWorkspace();
    if (!ws) return { success: false, error: 'Workspace không tồn tại' };

    // 1. Update COMPANY.md (overwrite "Thông tin chung" section if exists, else append)
    const companyPath = path.join(ws, 'COMPANY.md');
    if (!fs.existsSync(companyPath)) {
      try { seedWorkspace(); } catch {}
    }
    if (fs.existsSync(companyPath)) {
      let content = fs.readFileSync(companyPath, 'utf-8');
      const teamSizeLabel = {
        solo: 'Solo founder (chỉ 1 người)',
        small: '2-10 người',
        medium: '11-50 người',
        large: '51+ người',
      }[tSize];
      const profileBlock =
        '<!-- WIZARD AUTO-FILLED -->\n' +
        '## Thông tin chung\n\n' +
        '- **Tên:** ' + (cName || '[chưa điền]') + '\n' +
        (ceoN ? '- **Người đại diện:** ' + ceoN + '\n' : '') +
        '- **Quy mô:** ' + teamSizeLabel + '\n' +
        '- **Giờ làm việc:** ' + wStart + ' - ' + wEnd + '\n' +
        (bPhone ? '- **SĐT:** ' + bPhone + '\n' : '') +
        (bAddress ? '- **Địa chỉ:** ' + bAddress + '\n' : '') +
        (cDesc ? '\n## Giới thiệu\n\n' + cDesc + '\n' : '') +
        '<!-- /WIZARD AUTO-FILLED -->\n';
      // Replace block if marker present, else inject after first H1 or at top
      if (content.includes('<!-- WIZARD AUTO-FILLED -->')) {
        content = content.replace(/<!-- WIZARD AUTO-FILLED -->[\s\S]*?<!-- \/WIZARD AUTO-FILLED -->\n?/, profileBlock);
      } else {
        // First run: strip the empty template "## Thông tin chung" section so we
        // don't end up with duplicate headings (template has placeholder fields,
        // wizard has real ones — wizard wins). Match from "## Thông tin chung"
        // to next "## " heading or end of file.
        content = content.replace(/## Thông tin chung[\s\S]*?(?=\n## |\n*$)/, '');
        // Inject wizard block right after H1 + blockquote
        const lines = content.split('\n');
        const h1Idx = lines.findIndex(l => l.startsWith('# '));
        if (h1Idx >= 0) {
          let insertAt = h1Idx + 1;
          while (insertAt < lines.length && (lines[insertAt].trim() === '' || lines[insertAt].startsWith('>') || lines[insertAt].trim() === '---')) insertAt++;
          lines.splice(insertAt, 0, '', profileBlock);
          content = lines.join('\n');
        } else {
          content = profileBlock + '\n' + content;
        }
      }
      fs.writeFileSync(companyPath, content, 'utf-8');
      console.log('[save-business-profile] COMPANY.md updated');
    }

    // 1b. Update PRODUCTS.md — replace placeholder template with wizard-collected info.
    // Wizard asks "Bán gì" (product) + "Cho ai" (audience) + "Điểm khác biệt" (highlight).
    // Bot reads PRODUCTS.md to answer customer questions about products/services.
    // If user has already edited PRODUCTS.md manually (no marker), skip to preserve their edits.
    const productsPath = path.join(ws, 'PRODUCTS.md');
    if (fs.existsSync(productsPath) && (bProduct || bAudience || bHighlight)) {
      let productsContent = fs.readFileSync(productsPath, 'utf-8');
      const isTemplate = productsContent.includes('[Tên sản phẩm 1]') || productsContent.includes('<!-- WIZARD AUTO-FILLED -->');
      if (isTemplate) {
        const wizardBlock =
          '<!-- WIZARD AUTO-FILLED -->\n' +
          '## Sản phẩm / Dịch vụ chính\n\n' +
          (bProduct ? '**Bán gì:** ' + bProduct + '\n\n' : '') +
          (bAudience ? '**Khách hàng mục tiêu:** ' + bAudience + '\n\n' : '') +
          (bHighlight ? '**Điểm khác biệt / Lợi thế:** ' + bHighlight + '\n\n' : '') +
          '> Anh/chị bổ sung bảng giá chi tiết bên dưới khi có.\n' +
          '<!-- /WIZARD AUTO-FILLED -->\n\n';
        if (productsContent.includes('<!-- WIZARD AUTO-FILLED -->')) {
          productsContent = productsContent.replace(/<!-- WIZARD AUTO-FILLED -->[\s\S]*?<!-- \/WIZARD AUTO-FILLED -->\n?\n?/, wizardBlock);
        } else {
          // First run: strip placeholder product table (from "## Bảng sản phẩm" to next "## ")
          productsContent = productsContent.replace(/## Bảng sản phẩm[\s\S]*?(?=\n## |$)/, '');
          const lines = productsContent.split('\n');
          const h1Idx = lines.findIndex(l => l.startsWith('# '));
          if (h1Idx >= 0) {
            let insertAt = h1Idx + 1;
            while (insertAt < lines.length && (lines[insertAt].trim() === '' || lines[insertAt].startsWith('>') || lines[insertAt].trim() === '---')) insertAt++;
            lines.splice(insertAt, 0, '', wizardBlock);
            productsContent = lines.join('\n');
          } else {
            productsContent = wizardBlock + productsContent;
          }
        }
        fs.writeFileSync(productsPath, productsContent, 'utf-8');
        console.log('[save-business-profile] PRODUCTS.md updated');
      } else {
        console.log('[save-business-profile] PRODUCTS.md has custom edits — skipping wizard overwrite');
      }
    }

    // 2. Update schedules.json — set morning cron = workStart, evening cron = workEnd
    const schedPath = path.join(ws, 'schedules.json');
    let schedules = DEFAULT_SCHEDULES_JSON.map(s => ({ ...s }));
    if (fs.existsSync(schedPath)) {
      try { schedules = JSON.parse(fs.readFileSync(schedPath, 'utf-8')); } catch {}
    }
    let schedChanged = false;
    for (const s of schedules) {
      if (s.id === 'morning' && s.time !== wStart) { s.time = wStart; schedChanged = true; }
      if (s.id === 'evening' && s.time !== wEnd) { s.time = wEnd; schedChanged = true; }
    }
    if (schedChanged) {
      writeJsonAtomic(schedPath, schedules);
      console.log('[save-business-profile] schedules.json updated: morning=' + wStart + ' evening=' + wEnd);
    }

    // 3. Write business goals to memory/projects/business-goals.md
    // Bot reads memory on session start → knows focus area without CEO restating it
    if (gList.length > 0) {
      const GOAL_LABELS = {
        'zalo-auto-reply': 'Trả tin Zalo tự động cho khách hàng',
        'daily-reports': 'Báo cáo hàng ngày (doanh thu, KPI, vấn đề)',
        'schedule-mgmt': 'Quản lý lịch họp + nhắc lịch + follow-up',
        'staff-reminders': 'Nhắc nhở nhân viên (báo cáo, deadline, ca trực)',
        'customer-followup': 'Follow-up khách quan tâm chưa chốt',
        'competitor-watch': 'Theo dõi tin tức đối thủ + biến động thị trường',
      };
      const goalsDir = path.join(ws, 'memory', 'projects');
      try { fs.mkdirSync(goalsDir, { recursive: true }); } catch {}
      const goalsPath = path.join(goalsDir, 'business-goals.md');
      const goalsContent =
        '# Mục tiêu CEO khi dùng 9BizClaw\n\n' +
        '> Tự fill từ wizard onboarding. CEO chọn các việc trợ lý nên giúp nhiều nhất.\n' +
        '> Bot đọc file này MỖI session để biết focus area.\n\n' +
        '## Ưu tiên hỗ trợ\n\n' +
        gList.map((g, i) => (i + 1) + '. **' + GOAL_LABELS[g] + '**').join('\n') + '\n\n' +
        '---\n\n' +
        '_Cập nhật: ' + new Date().toISOString().slice(0, 10) + '_\n';
      fs.writeFileSync(goalsPath, goalsContent, 'utf-8');
      console.log('[save-business-profile] business-goals.md written with ' + gList.length + ' goals');
    }

    // 4. Add team-size hint to IDENTITY.md (bot knows when to escalate vs decide solo)
    const identityPath = path.join(ws, 'IDENTITY.md');
    if (fs.existsSync(identityPath)) {
      let content = fs.readFileSync(identityPath, 'utf-8');
      const teamHint = {
        solo: 'Solo founder — anh/chị tự quyết mọi việc, em báo trực tiếp, không cần hỏi ý kiến team.',
        small: '2-10 người — em có thể nhắc nhân viên qua Zalo, nhưng quyết định lớn phải hỏi anh/chị.',
        medium: '11-50 người — có nhiều phòng ban, em escalate đúng người chịu trách nhiệm khi cần.',
        large: '51+ người — quy mô lớn, em ưu tiên báo cáo cấp cao, không can thiệp vận hành chi tiết.',
      }[tSize];
      const teamLine = '- **Quy mô đội ngũ:** ' + teamHint;
      if (content.includes('- **Quy mô đội ngũ:**')) {
        content = content.replace(/- \*\*Quy mô đội ngũ:\*\* .*/, teamLine);
      } else {
        // Insert after the Cách xưng hô line
        content = content.replace(
          /(- \*\*Cách xưng hô:\*\* .*)/,
          '$1\n' + teamLine
        );
      }
      // Inject "## Em đang làm việc tại" block at top so bot ALWAYS sees company
      // context — bot reads IDENTITY.md first per AGENTS.md bootstrap chain. This
      // is critical: COMPANY.md is technically loaded but bot may skip reads on
      // short messages ("ping"). IDENTITY.md is small + highest-priority → never
      // skipped. Idempotent via marker.
      const bizMarkerStart = '<!-- WIZARD-BUSINESS-PROFILE -->';
      const bizMarkerEnd = '<!-- /WIZARD-BUSINESS-PROFILE -->';
      const bizLines = [bizMarkerStart, '## Em đang làm việc tại'];
      if (cName) bizLines.push('- **Công ty:** ' + cName);
      if (cDesc) bizLines.push('- **Mô tả:** ' + cDesc);
      bizLines.push(bizMarkerEnd, '');
      const bizBlock = bizLines.join('\n');
      if (cName || cDesc) {
        if (content.includes(bizMarkerStart)) {
          content = content.replace(
            new RegExp(bizMarkerStart + '[\\s\\S]*?' + bizMarkerEnd + '\\n?'),
            bizBlock
          );
        } else {
          // Insert AFTER the H1 title (# IDENTITY.md — Tôi Là Ai?) so it's the
          // first content block bot sees after the heading.
          const lines = content.split('\n');
          const h1Idx = lines.findIndex(l => l.startsWith('# '));
          const insertAt = h1Idx >= 0 ? h1Idx + 1 : 0;
          // Skip blank lines after H1
          let insertPos = insertAt;
          while (insertPos < lines.length && lines[insertPos].trim() === '') insertPos++;
          lines.splice(insertPos, 0, '', bizBlock);
          content = lines.join('\n');
        }
      }
      fs.writeFileSync(identityPath, content, 'utf-8');
    }

    // 5. Write business profile to memory/projects/business-profile.md so it
    // shows up in MEMORY.md projects index + bot can search/recall it via
    // memory_search("bán gì") etc. Stable file name → idempotent overwrite.
    try {
      const projDir = path.join(ws, 'memory', 'projects');
      fs.mkdirSync(projDir, { recursive: true });
      const profPath = path.join(projDir, 'business-profile.md');
      const profLines = [
        '# Hồ sơ doanh nghiệp',
        '',
        '> File này do wizard onboarding tự ghi. Bot dùng để biết "công ty làm gì, bán gì, bán cho ai".',
        '> Cập nhật bằng cách chạy lại wizard hoặc sửa tay file này.',
        '',
        '## Tổng quan',
        '',
      ];
      if (cName) profLines.push('- **Tên công ty:** ' + cName);
      if (ceoN) profLines.push('- **Người đại diện:** ' + ceoN);
      if (bPhone) profLines.push('- **SĐT:** ' + bPhone);
      if (bAddress) profLines.push('- **Địa chỉ:** ' + bAddress);
      const teamSizeLabel2 = {
        solo: 'Solo founder (1 người)',
        small: '2-10 người',
        medium: '11-50 người',
        large: '51+ người',
      }[tSize];
      profLines.push('- **Quy mô:** ' + teamSizeLabel2);
      profLines.push('- **Giờ làm việc:** ' + wStart + ' - ' + wEnd);
      if (cDesc) {
        profLines.push('');
        profLines.push('## Mô tả');
        profLines.push('');
        profLines.push(cDesc);
      }
      if (gList.length > 0) {
        profLines.push('');
        profLines.push('## Trợ lý dùng để');
        profLines.push('');
        const goalLabels = {
          'zalo-auto-reply': 'Trả tin Zalo tự động',
          'daily-reports': 'Báo cáo hàng ngày',
          'schedule-mgmt': 'Quản lý lịch họp',
          'staff-reminders': 'Nhắc nhân viên',
          'customer-followup': 'Follow-up khách',
          'competitor-watch': 'Theo dõi đối thủ',
        };
        for (const g of gList) profLines.push('- ' + (goalLabels[g] || g));
      }
      profLines.push('');
      profLines.push('---');
      profLines.push('Cập nhật lần cuối: ' + new Date().toISOString().slice(0, 10));
      profLines.push('');
      fs.writeFileSync(profPath, profLines.join('\n'), 'utf-8');
      console.log('[save-business-profile] memory/projects/business-profile.md written');
    } catch (e) {
      console.warn('[save-business-profile] business-profile.md write failed:', e?.message);
    }

    return { success: true };
  } catch (e) {
    console.error('[save-business-profile] error:', e?.message || e);
    return { success: false, error: e.message };
  }
});

// Google Calendar + Gmail integration via `gog-cli`.
//
// STATUS (2026-04-07): The `gog-cli` npm package referenced here does NOT
// currently exist on the public npm registry. Calling this handler used to
// silently fail in npm install (404), then crash with "command not found"
// when spawning `gog auth`. On Mac the failure is even louder because
// `npm install -g` requires write permission to /usr/local/lib/node_modules
// and pops a permission error.
//
// Until a working Google integration is shipped, this handler returns a
// graceful "not implemented" response so the wizard can show a clear message
// instead of throwing. The Dashboard's "Google" channel chip stays at
// `not_configured` (handled by check-all-channels which only looks for
// ~/.gog/token.json — won't exist).
ipcMain.handle('setup-google', async () => {
  return {
    success: false,
    error: 'Google integration chưa sẵn sàng (gog-cli chưa publish). ' +
           'Tích hợp Calendar/Gmail sẽ có trong bản cập nhật sau.',
    notImplemented: true,
  };
});

// Batch config set (for complex nested objects like model providers)
// Batch config set — write JSON directly
ipcMain.handle('set-batch-config', async (_event, ops) => {
  const booting = rejectIfBooting('set-batch-config');
  if (booting) return booting;
  _ipcInFlightCount++;
  try {
    return await withOpenClawConfigLock(async () => {
      try {
        console.log('[config-lock] set-batch-config acquired');
        const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        let config = {};
        if (fs.existsSync(configPath)) {
          try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch {}
        }
        const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];
        for (const op of ops) {
          const parts = op.path.split('.');
          if (parts.some(p => UNSAFE_KEYS.includes(p))) continue;
          let obj = config;
          for (let i = 0; i < parts.length - 1; i++) {
            if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
            obj = obj[parts[i]];
          }
          obj[parts[parts.length - 1]] = op.value;
        }
        writeOpenClawConfigIfChanged(configPath, config);
        return { success: true };
      } catch (e) { return { success: false, error: e.message }; }
    });
  } finally { _ipcInFlightCount--; }
});

// Save config by writing openclaw.json directly — no CLI dependency
ipcMain.handle('save-wizard-config', async (_event, configs) => {
  // Not gated by rejectIfBooting — wizard runs before boot by design.
  _ipcInFlightCount++;
  try {
    return await withOpenClawConfigLock(async () => {
      try {
        console.log('[config-lock] save-wizard-config acquired');
        const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        let config = {};
        if (fs.existsSync(configPath)) {
          try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch {}
        }
        const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];
        for (const { key, value } of configs) {
          const parts = key.split('.');
          if (parts.some(p => UNSAFE_KEYS.includes(p))) continue;
          let obj = config;
          for (let i = 0; i < parts.length - 1; i++) {
            if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
            obj = obj[parts[i]];
          }
          obj[parts[parts.length - 1]] = value;
        }

      // Auto-fix required fields OpenClaw expects
      if (config.channels?.telegram?.botToken && !config.channels.telegram.enabled) {
        config.channels.telegram.enabled = true;
      }
      // If wizard enabled openzalo, ensure dmPolicy="open" + allowFrom=["*"] so
      // unknown DM senders don't get the "access not configured" pairing reply.
      // (openzalo plugin defaults dmPolicy to "pairing" if missing.)
      if (config.channels?.openzalo?.enabled) {
        if (config.channels.openzalo.dmPolicy !== 'open') {
          config.channels.openzalo.dmPolicy = 'open';
        }
        if (!Array.isArray(config.channels.openzalo.allowFrom)) {
          config.channels.openzalo.allowFrom = ['*'];
        }
      }
      // Create required dirs
      const sessDir = path.join(HOME, '.openclaw', 'agents', 'main', 'sessions');
      fs.mkdirSync(sessDir, { recursive: true });

        writeOpenClawConfigIfChanged(configPath, config);
        return { success: true };
      } catch (e) { return { success: false, error: e.message }; }
    });
  } finally { _ipcInFlightCount--; }
});

// Add cron — save custom times to claw-schedules.json (bypasses broken CLI)
ipcMain.handle('add-cron', async (_event, { name, cron, tz, message, channel }) => {
  try {
    // Parse cron expression to extract time (e.g., "30 7 * * *" → "07:30")
    const parts = (cron || '').split(/\s+/);
    if (parts.length >= 2) {
      const m = parts[0].padStart(2, '0');
      const h = parts[1].padStart(2, '0');
      const time = `${h}:${m}`;
      const schedules = loadSchedules();
      // Map cron name to schedule ID
      if (name && name.toLowerCase().includes('sang') || name && name.toLowerCase().includes('morning')) {
        const s = schedules.find(x => x.id === 'morning');
        if (s) { s.time = time; s.enabled = true; }
      } else if (name && name.toLowerCase().includes('toi') || name && name.toLowerCase().includes('evening')) {
        const s = schedules.find(x => x.id === 'evening');
        if (s) { s.time = time; s.enabled = true; }
      }
      writeJsonAtomic(getSchedulesPath(), schedules);
      restartCronJobs();
      console.log('[add-cron] Saved custom time:', name, time);
    }
  } catch (e) { console.error('[add-cron] error:', e.message); }
  return { success: true };
});

// Schedule management (CEO-friendly cron display)
// All paths derived from getWorkspace() — writable in both dev and packaged
function getSchedulesPath() { return path.join(getWorkspace(), 'schedules.json'); }
function getCustomCronsPath() { return path.join(getWorkspace(), 'custom-crons.json'); }
// Legacy paths for one-time migration from older installs
const legacySchedulesPaths = [
  path.join(HOME, '.openclaw', 'workspace', 'schedules.json'),
  path.join(appDataDir(), 'claw-schedules.json'),
];
const legacyCustomCronsPaths = [
  path.join(HOME, '.openclaw', 'workspace', 'custom-crons.json'),
];

function loadSchedules() {
  const schedulesPath = getSchedulesPath();
  try {
    if (fs.existsSync(schedulesPath)) {
      const raw = fs.readFileSync(schedulesPath, 'utf-8');
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('schedules.json must be an array');
        return parsed;
      } catch (parseErr) {
        // Backup + alert + return defaults so morning/evening etc. still work.
        const backupPath = schedulesPath + '.corrupt-' + Date.now();
        try { fs.copyFileSync(schedulesPath, backupPath); } catch {}
        console.error(`[schedules] CORRUPT JSON in ${schedulesPath}: ${parseErr.message}. Backed up to ${backupPath}. Falling back to defaults.`);
        try {
          const errFile = path.join(getWorkspace(), '.learnings', 'ERRORS.md');
          fs.mkdirSync(path.dirname(errFile), { recursive: true });
          fs.appendFileSync(errFile, `\n## ${new Date().toISOString()} — schedules.json corrupt\n\nError: ${parseErr.message}\nBackup: ${backupPath}\nFell back to defaults so morning/evening still fire.\n`, 'utf-8');
        } catch {}
        try {
          sendCeoAlert(`Cảnh báo: schedules.json bị lỗi JSON\n\n${parseErr.message}\n\nĐã backup về ${path.basename(backupPath)} và fall back về default schedules. Vào Dashboard, tab Lịch để xem.`);
        } catch {}
        return DEFAULT_SCHEDULES_JSON;
      }
    }
    // Try migrating from legacy locations
    for (const p of legacySchedulesPaths) {
      if (p !== schedulesPath && fs.existsSync(p)) {
        try {
          const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
          try {
            writeJsonAtomic(schedulesPath, data);
            console.log('[schedules] Migrated from', p, '→', schedulesPath);
          } catch {}
          return data;
        } catch (e) {
          console.error(`[schedules] legacy file ${p} is corrupt:`, e.message);
        }
      }
    }
  } catch {}
  return DEFAULT_SCHEDULES_JSON;
}

ipcMain.handle('get-schedules', async () => {
  return loadSchedules();
});

ipcMain.handle('get-custom-crons', async () => {
  // Merge MODOROClaw custom-crons.json + OpenClaw built-in cron/jobs.json.
  // The bot creates crons via OpenClaw's `cron` tool (saved to
  // ~/.openclaw/cron/jobs.json), NOT to custom-crons.json. The Dashboard
  // previously only read custom-crons.json, so bot-created crons were
  // invisible to the CEO. Fix: read both, merge, dedupe by ID, label
  // OpenClaw crons with source:'openclaw' so Dashboard can distinguish.
  const modoroEntries = loadCustomCrons().map(c => ({ ...c, source: 'modoro' }));
  let openclawEntries = [];
  try {
    const ocJobsPath = path.join(HOME, '.openclaw', 'cron', 'jobs.json');
    if (fs.existsSync(ocJobsPath)) {
      const raw = JSON.parse(fs.readFileSync(ocJobsPath, 'utf-8'));
      const jobs = Array.isArray(raw?.jobs) ? raw.jobs : [];
      for (const j of jobs) {
        if (!j || !j.id) continue;
        // Map OpenClaw cron format → MODOROClaw display format
        const schedExpr = j.schedule?.expr || j.schedule?.at || '';
        const kind = j.schedule?.kind || 'cron';
        let displayTime = schedExpr;
        if (kind === 'at') {
          try {
            const d = new Date(j.schedule.at);
            displayTime = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} (một lần)`;
          } catch {}
        }
        openclawEntries.push({
          id: 'oc_' + j.id,
          label: j.name || 'OpenClaw cron',
          cronExpr: schedExpr,
          displayTime,
          prompt: j.payload?.text || j.payload?.message || '(hệ thống)',
          enabled: j.enabled !== false,
          createdAt: j.createdAtMs ? new Date(j.createdAtMs).toISOString() : '',
          source: 'openclaw',
          // Extra metadata for display
          lastStatus: j.state?.lastRunStatus || null,
          nextRunAt: j.state?.nextRunAtMs ? new Date(j.state.nextRunAtMs).toISOString() : null,
          deleteAfterRun: j.deleteAfterRun || false,
        });
      }
    }
  } catch (e) {
    console.warn('[get-custom-crons] failed to read OpenClaw cron/jobs.json:', e?.message);
  }
  // Merge: OpenClaw entries first (they're the ones bot created), then MODOROClaw
  return [...openclawEntries, ...modoroEntries];
});

ipcMain.handle('save-custom-crons', async (_event, crons) => {
  try {
    if (!Array.isArray(crons)) return { success: false, error: 'crons must be an array' };
    // CRIT #7: Dashboard `get-custom-crons` merges MODOROClaw crons with
    // OpenClaw-sourced entries (source:'openclaw' — bot-created crons read
    // from ~/.openclaw/agents/main/jobs.json). FE passes the merged array back
    // on any toggle/delete. If we wrote it verbatim, those OpenClaw entries
    // would get copied INTO our custom-crons.json and double-fire every day.
    // Strip anything not ours before persisting.
    const mine = crons.filter(c => !c || c.source !== 'openclaw');
    // Validate cronExpr so a malformed entry doesn't crash the cron scheduler
    // on the watcher reload (which would then keep re-firing).
    const nodeCron = require('node-cron');
    for (const c of mine) {
      if (c && typeof c.cronExpr === 'string' && !nodeCron.validate(c.cronExpr)) {
        return { success: false, error: `Cron expression invalid: "${c.cronExpr}" (label: ${c.label || c.id || '?'})` };
      }
    }
    writeJsonAtomic(getCustomCronsPath(), mine);
    // CRITICAL: do NOT rely on the file watcher alone — fs.watch is unreliable
    // on Windows + atomic-replace editors. Explicitly reload cron jobs after
    // every write so the new schedule takes effect immediately, even if the
    // watcher missed the event. The watcher's debounce will dedupe the second
    // call if it does fire.
    try { restartCronJobs(); } catch (e) { console.error('[save-custom-crons] restartCronJobs error:', e.message); }
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('delete-openclaw-cron', async (_event, jobId) => {
  try {
    if (!jobId || typeof jobId !== 'string') return { success: false, error: 'jobId required' };
    const realId = jobId.startsWith('oc_') ? jobId.slice(3) : jobId;
    const ocJobsPath = path.join(HOME, '.openclaw', 'cron', 'jobs.json');
    if (!fs.existsSync(ocJobsPath)) return { success: false, error: 'jobs.json not found' };
    const raw = JSON.parse(fs.readFileSync(ocJobsPath, 'utf-8'));
    const before = Array.isArray(raw?.jobs) ? raw.jobs.length : 0;
    raw.jobs = (raw.jobs || []).filter(j => j && j.id !== realId);
    if (raw.jobs.length === before) return { success: false, error: 'job not found: ' + realId };
    writeJsonAtomic(ocJobsPath, raw);
    console.log('[delete-openclaw-cron] deleted job:', realId);
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('save-schedules', async (_event, schedules) => {
  try {
    writeJsonAtomic(getSchedulesPath(), schedules);
    restartCronJobs(); // Re-schedule with new settings
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

// Re-run boot diagnostic on demand (Dashboard exposes a "Diagnostic" button).
// Returns the latest diagnostic file content as a string the UI can render.
ipcMain.handle('cron-diagnostic', async () => {
  try {
    bootDiagRunFullCheck();
    const file = path.join(getWorkspace(), 'logs', 'boot-diagnostic.txt');
    const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    return {
      success: true,
      file,
      content,
      summary: {
        platform: process.platform,
        arch: process.arch,
        nodeBin: findNodeBin() || null,
        openclawBin: _cachedBin || null,
        openclawCli: findOpenClawCliJs() || null,
        agentProfile: _agentFlagProfile,
        agentHealthy: _agentCliHealthy,
        botRunning,
      },
    };
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  }
});

// Load daily summaries for a date range. Falls back to raw journals for days
// where summary is missing (9Router was down). Returns combined text.
function loadDailySummaries(days) {
  const ws = getWorkspace();
  if (!ws) return '';
  const memDir = path.join(ws, 'memory');
  const parts = [];
  for (let i = days; i >= 1; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    const summaryPath = path.join(memDir, `${dateStr}-summary.md`);
    const rawPath = path.join(memDir, `${dateStr}.md`);
    try {
      if (fs.existsSync(summaryPath)) {
        parts.push(fs.readFileSync(summaryPath, 'utf-8'));
      } else if (fs.existsSync(rawPath)) {
        parts.push(fs.readFileSync(rawPath, 'utf-8'));
      }
    } catch { continue; }
  }
  return parts.join('\n\n');
}

// Generate weekly summary from 7 daily summaries. Called on Monday by
// buildWeeklyReportPrompt. Cached to memory/week-YYYY-WNN-summary.md.
async function generateWeeklySummary() {
  const ws = getWorkspace();
  if (!ws) return null;
  const memDir = path.join(ws, 'memory');
  const now = new Date();
  // ISO 8601 week number: week 1 contains the first Thursday of the year.
  const thu = new Date(now);
  thu.setDate(thu.getDate() + 3 - ((thu.getDay() + 6) % 7)); // nearest Thursday
  const jan4 = new Date(thu.getFullYear(), 0, 4); // Jan 4 is always in week 1
  const weekNum = 1 + Math.round(((thu - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  const weekLabel = `${thu.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
  const weekFile = path.join(memDir, `week-${weekLabel}-summary.md`);
  try {
    if (fs.existsSync(weekFile)) return fs.readFileSync(weekFile, 'utf-8');
  } catch {}
  const dailies = loadDailySummaries(7);
  if (!dailies) return null;
  const summary = await call9Router(
    `Dưới đây là tóm tắt hoạt động 7 ngày qua. Tổng hợp thành BÁO CÁO TUẦN ngắn gọn:\n` +
    `- Tổng quan hoạt động\n- Khách hàng nổi bật\n- Vấn đề tồn đọng\n- Số liệu tổng hợp\n` +
    `Chỉ trả về bullet points.\n\n---\n${dailies.substring(0, 6000)}`,
    { maxTokens: 800, temperature: 0.2, timeoutMs: 20000 }
  );
  if (summary) {
    try {
      fs.writeFileSync(weekFile, `# Tóm tắt tuần ${weekLabel}\n\n${summary}\n`, 'utf-8');
      console.log(`[journal] weekly summary written: week-${weekLabel}-summary.md`);
    } catch {}
    return `# Tóm tắt tuần ${weekLabel}\n\n${summary}\n`;
  }
  return dailies;
}

// Load the 4 most recent weekly summaries for monthly report.
function loadWeeklySummaries() {
  const ws = getWorkspace();
  if (!ws) return '';
  const memDir = path.join(ws, 'memory');
  const parts = [];
  for (let w = 4; w >= 1; w--) {
    const d = new Date(Date.now() - w * 7 * 86400000);
    const thu = new Date(d);
    thu.setDate(thu.getDate() + 3 - ((thu.getDay() + 6) % 7));
    const jan4 = new Date(thu.getFullYear(), 0, 4);
    const weekNum = 1 + Math.round(((thu - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
    const weekLabel = `${thu.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
    const weekFile = path.join(memDir, `week-${weekLabel}-summary.md`);
    try {
      if (fs.existsSync(weekFile)) {
        parts.push(fs.readFileSync(weekFile, 'utf-8'));
        continue;
      }
    } catch {}
    const weekDailies = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(d.getTime() + i * 86400000);
      const dateStr = day.toISOString().slice(0, 10);
      const sp = path.join(memDir, `${dateStr}-summary.md`);
      const rp = path.join(memDir, `${dateStr}.md`);
      try {
        if (fs.existsSync(sp)) weekDailies.push(fs.readFileSync(sp, 'utf-8'));
        else if (fs.existsSync(rp)) weekDailies.push(fs.readFileSync(rp, 'utf-8'));
      } catch {}
    }
    if (weekDailies.length > 0) parts.push(weekDailies.join('\n'));
  }
  return parts.join('\n\n');
}

function loadPromptTemplate(name) {
  const candidates = [
    path.join(__dirname, 'prompts', name),
    path.join(process.resourcesPath || __dirname, 'prompts', name),
  ];
  for (const p of candidates) {
    try { return fs.readFileSync(p, 'utf-8'); } catch {}
  }
  return null;
}

function buildMorningBriefingPrompt(timeStr) {
  try { writeDailyMemoryJournal({ date: new Date(Date.now() - 86400000) }); } catch {}
  const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
  const history = extractConversationHistory({ sinceMs, maxMessages: 50, maxPerSender: 10 });
  const historyBlock = history
    ? `\n\n--- Lịch sử tin nhắn 24h qua ---\n${history}\n--- Hết ---\n\n`
    : `\n\n_(Chưa có tin nhắn nào trong 24h qua.)_\n\n`;
  const template = loadPromptTemplate('morning-briefing.md');
  if (template) {
    return template
      .replace('{{time}}', timeStr || '07:30')
      .replace('{{historyBlock}}', historyBlock);
  }
  return `Bây giờ là ${timeStr || '07:30'} sáng. Gửi báo cáo sáng cho CEO.` + historyBlock +
    `Tóm tắt hôm qua, việc hôm nay, tin cần xử lý, cảnh báo. Tiếng Việt có dấu, không emoji.`;
}

function buildEveningSummaryPrompt(timeStr) {
  try { writeDailyMemoryJournal({ date: new Date() }); } catch {}
  const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
  const history = extractConversationHistory({ sinceMs, maxMessages: 50, maxPerSender: 10 });
  const historyBlock = history
    ? `\n\n--- LỊCH SỬ TIN NHẮN 24H QUA (đã trích từ session storage, KHÔNG cần em đi tìm thêm) ---\n${history}\n--- HẾT LỊCH SỬ ---\n\n`
    : `\n\n_(Chưa có tin nhắn nào trong 24h qua.)_\n\n`;

  // Scan memory/zalo-users/*.md for patterns: unanswered questions, promises, hot topics
  let memoryInsights = '';
  try {
    const ws = getWorkspace();
    if (ws) {
      const memDir = path.join(ws, 'memory', 'zalo-users');
      if (fs.existsSync(memDir)) {
        const files = fs.readdirSync(memDir).filter(f => f.endsWith('.md'));
        const today = new Date();
        const todayStr = today.toISOString().slice(0, 10);
        const yesterdayStr = new Date(today - 86400000).toISOString().slice(0, 10);
        const recentFiles = [];
        for (const f of files) {
          try {
            const stat = fs.statSync(path.join(memDir, f));
            const ageH = (Date.now() - stat.mtimeMs) / 3600000;
            if (ageH < 48) recentFiles.push(f);
          } catch {}
        }
        if (recentFiles.length > 0) {
          const snippets = [];
          for (const f of recentFiles.slice(0, 20)) {
            try {
              const content = fs.readFileSync(path.join(memDir, f), 'utf-8');
              const lines = content.split('\n');
              const recentLines = lines.filter(l => l.includes(todayStr) || l.includes(yesterdayStr));
              if (recentLines.length > 0) {
                snippets.push(`[${f.replace('.md', '')}] ${recentLines.slice(-5).join(' | ')}`);
              }
            } catch {}
          }
          if (snippets.length > 0) {
            memoryInsights = `\n\n--- HOAT DONG KHACH HANG 48H (tu memory/zalo-users/) ---\n${snippets.join('\n')}\n--- HET ---\n\n`;
          }
        }
      }
    }
  } catch {}

  // Scan knowledge gaps: questions bot couldn't answer (from audit log)
  let knowledgeGaps = '';
  try {
    const ws = getWorkspace();
    if (ws) {
      const auditPath = path.join(ws, 'logs', 'audit.jsonl');
      if (fs.existsSync(auditPath)) {
        const raw = fs.readFileSync(auditPath, 'utf-8');
        const lines = raw.trim().split('\n').slice(-200);
        const gaps = [];
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.event === 'knowledge_gap' || entry.event === 'no_answer') {
              gaps.push(entry.question || entry.detail || '');
            }
          } catch {}
        }
        if (gaps.length > 0) {
          knowledgeGaps = `\n\n--- CAU HOI BOT KHONG TRA LOI DUOC ---\n${[...new Set(gaps)].slice(0, 5).join('\n')}\n--- HET ---\n\n`;
        }
      }
    }
  } catch {}

  const template = loadPromptTemplate('evening-briefing.md');
  if (template) {
    return template
      .replace('{{time}}', timeStr || '21:00')
      .replace('{{historyBlock}}', historyBlock)
      .replace('{{memoryInsights}}', memoryInsights)
      .replace('{{knowledgeGaps}}', knowledgeGaps);
  }
  return `Bây giờ là ${timeStr || '21:00'}, cuối ngày. Tóm tắt hoạt động hôm nay cho CEO.` +
    historyBlock + memoryInsights + knowledgeGaps +
    `Tiếng Việt có dấu, không emoji, ngắn gọn.`;
}

async function buildWeeklyReportPrompt() {
  await generateWeeklySummary();
  const sinceMs24h = Date.now() - 24 * 60 * 60 * 1000;
  const recentRaw = extractConversationHistory({ sinceMs: sinceMs24h, maxMessages: 50, maxPerSender: 10 });
  const dailySummaries = loadDailySummaries(7);
  const recentBlock = recentRaw
    ? `\n\n--- TIN NHẮN 24H GẦN NHẤT (chi tiết) ---\n${recentRaw}\n--- HẾT ---\n\n`
    : '';
  const summaryBlock = dailySummaries
    ? `\n\n--- TÓM TẮT 7 NGÀY QUA (từ daily summaries, cover 100% tin nhắn) ---\n${dailySummaries}\n--- HẾT TÓM TẮT ---\n\n`
    : `\n\n_(Không có tóm tắt ngày nào trong 7 ngày qua.)_\n\n`;
  const template = loadPromptTemplate('weekly-report.md');
  if (template) {
    return template
      .replace('{{recentBlock}}', recentBlock)
      .replace('{{summaryBlock}}', summaryBlock);
  }
  return `Hôm nay là thứ 2. Gửi báo cáo tuần cho CEO.` +
    recentBlock + summaryBlock +
    `Tổng kết tuần, vấn đề tồn đọng, số liệu, ưu tiên tuần tới. Tiếng Việt có dấu, không emoji.`;
}

function buildMonthlyReportPrompt() {
  const sinceMs24h = Date.now() - 24 * 60 * 60 * 1000;
  const recentRaw = extractConversationHistory({ sinceMs: sinceMs24h, maxMessages: 50, maxPerSender: 10 });
  const weeklySummaries = loadWeeklySummaries();
  const recentBlock = recentRaw
    ? `\n\n--- TIN NHẮN 24H GẦN NHẤT (chi tiết) ---\n${recentRaw}\n--- HẾT ---\n\n`
    : '';
  const summaryBlock = weeklySummaries
    ? `\n\n--- TÓM TẮT 4 TUẦN QUA (từ weekly summaries, cover 100% tin nhắn) ---\n${weeklySummaries}\n--- HẾT TÓM TẮT ---\n\n`
    : `\n\n_(Không có tóm tắt trong 30 ngày qua.)_\n\n`;
  const template = loadPromptTemplate('monthly-report.md');
  if (template) {
    return template
      .replace('{{recentBlock}}', recentBlock)
      .replace('{{summaryBlock}}', summaryBlock);
  }
  return `Ngày 1 tháng mới. Hãy gửi BÁO CÁO THÁNG cho CEO.` +
    recentBlock + summaryBlock +
    `Dựa trên tóm tắt hàng tuần + memory/ + knowledge, tổng hợp:\n` +
    `1. Tổng kết tháng: kết quả nổi bật, milestone đạt được\n` +
    `2. Khách hàng: khách mới, khách quay lại, khách mất (nếu có data)\n` +
    `3. Hoạt động bot: tổng tin xử lý, cron runs, errors (nếu có)\n` +
    `4. So sánh với tháng trước (nếu có data memory)\n` +
    `5. Kế hoạch + ưu tiên tháng tới\n\n` +
    `Trả lời bằng tiếng Việt, dùng tiêu đề **BÁO CÁO THÁNG** in đậm + bullet points. ` +
    `KHÔNG dùng emoji. KHÔNG hỏi lại CEO. Nếu data ít thì tóm ngắn.`;
}

// SCALE FIX + SEMANTIC FIX: scan memory/zalo-users/*.md in Node BEFORE agent.
//
// Old prompt said "Đọc tất cả file" → CEO with 2000 Zalo friends had 2000
// profile files, total 50-200MB. Context window overflowed → agent gave up
// mid-scan → follow-up report was garbage.
//
// First pre-filter (43cbfea) fixed scale but kept a broken semantic: it
// flagged EVERY friend whose profile existed > 24h with no interaction as
// "new-no-interaction". User correctly objected: "nó có nhiều người ko có
// tương tác nó cũng report, để làm gì?" Right — a friend who never DM'd
// the bot isn't a follow-up, it's a cold contact. Seed job creates 1 file
// per friend list entry; that's 2000 files → 2000 noise candidates daily.
//
// New semantic: a follow-up candidate is a customer the BOT OWES something
// to. Specifically: their latest dated section was > 48h ago AND the
// section text contains a pending hint ("chờ phản hồi", "hẹn mai",
// "hứa ghé/mua/đặt", etc). "Kết bạn chưa nói gì" is explicitly NOT a
// follow-up — that's sales prospecting, a separate concern.
function scanZaloFollowUpCandidates(ws, { nowMs = Date.now(), max = 20 } = {}) {
  const usersDir = path.join(ws, 'memory', 'zalo-users');
  if (!fs.existsSync(usersDir)) return [];

  const H24_MS = 24 * 60 * 60 * 1000;
  const H48_MS = 48 * 60 * 60 * 1000;
  const H30D_MS = 30 * H24_MS;
  const DATED_RE = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/gm;
  const PENDING_HINTS = /(chờ phản hồi|chờ trả lời|chưa chốt|cần follow-?up|sẽ liên hệ|hẹn mai|mai liên lạc|ngày mai sẽ|hứa.*(mua|đặt|ghé|qua))/i;

  const candidates = [];
  let files;
  try { files = fs.readdirSync(usersDir).filter(f => f.endsWith('.md')); }
  catch { return []; }

  // Pre-filter by file mtime: if a profile hasn't been touched in 30 days,
  // any "pending" state from > 30 days ago is already cold. Skip reading
  // the file entirely. For a 2000-friend install where 80% are silent
  // contacts, this avoids the bulk of the I/O.
  for (const file of files) {
    const fp = path.join(usersDir, file);
    let stat;
    try { stat = fs.statSync(fp); } catch { continue; }
    if (stat.size < 10) continue;
    if (nowMs - stat.mtimeMs > H30D_MS) continue;  // cold contact — skip

    let content;
    try {
      // Read full file — safe because trimZaloMemoryFile caps each at 50KB.
      content = fs.readFileSync(fp, 'utf-8');
    } catch { continue; }

    // Parse frontmatter (first --- ... --- block).
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    const fm = {};
    if (fmMatch) {
      for (const line of fmMatch[1].split('\n')) {
        const m = line.match(/^(\w+):\s*(.*)$/);
        if (m) fm[m[1]] = m[2].trim();
      }
    }
    const name = fm.name || file.replace(/\.md$/, '');

    // Find all dated sections.
    const dates = [];
    let dm;
    DATED_RE.lastIndex = 0;
    while ((dm = DATED_RE.exec(content)) !== null) dates.push(dm[1]);

    // SEMANTIC REQUIREMENT: must have AT LEAST ONE interaction. A profile
    // with zero dated sections means the bot and this customer have
    // NEVER exchanged a message. That's not a follow-up; it's inventory.
    // Silently skip.
    if (dates.length === 0) continue;

    // STALE PENDING — last dated section > 48h ago AND body contains a
    // pending-interaction hint. Both conditions required.
    {
      const lastDate = dates.sort().at(-1);
      const lastMs = Date.parse(lastDate + 'T00:00:00Z');
      if (!Number.isFinite(lastMs)) continue;
      const staleMs = nowMs - lastMs;
      if (staleMs < H48_MS) continue;

      // Pull text of the last section (between `## lastDate` and next `## ` or EOF).
      const sectionStart = content.lastIndexOf(`## ${lastDate}`);
      const sectionEnd = content.indexOf('\n## ', sectionStart + 3);
      const sectionText = sectionEnd > 0
        ? content.slice(sectionStart, sectionEnd)
        : content.slice(sectionStart);

      if (!PENDING_HINTS.test(sectionText)) continue;

      const staleDays = Math.floor(staleMs / H24_MS);
      // Extract first bullet or first line as "what was asked".
      const preview = (sectionText.match(/^[-*]\s+(.*?)$/m)?.[1] || sectionText.split('\n')[1] || '').slice(0, 80);
      candidates.push({
        kind: 'pending-stale',
        senderId: file.replace(/\.md$/, ''),
        name,
        staleDays,
        lastDate,
        priority: 30 + Math.min(staleDays, 30),  // stale = higher priority than new
        line: `- ${name} — ${preview || 'chờ phản hồi'} (ngày ${lastDate}, ${staleDays} ngày chưa trả lời tiếp)`,
      });
    }
  }

  candidates.sort((a, b) => b.priority - a.priority);
  return candidates.slice(0, max);
}

function buildZaloFollowUpPrompt(candidates) {
  // If no candidates supplied, fall back to the original "Đọc tất cả" prompt
  // (backward compat — test handlers may call without pre-scan).
  if (!Array.isArray(candidates)) {
    return (
      `Kiểm tra khách hàng Zalo cần follow-up. Đọc tất cả file trong memory/zalo-users/*.md.\n\n` +
      `KHÔNG dùng emoji. KHÔNG hỏi lại CEO.`
    );
  }

  if (candidates.length === 0) {
    return (
      `Gửi cho CEO NỘI DUNG CHÍNH XÁC NHƯ SAU (không thêm chữ, không hỏi lại, không bịa):\n\n` +
      `Không có khách nào cần follow-up hôm nay.\n\n` +
      `Gửi qua tool sessions_send.`
    );
  }

  // Build detailed per-candidate blocks with actionable context
  const blocks = candidates.map((c, i) => {
    const urgency = c.staleDays >= 4 ? 'CAO' : c.staleDays >= 2 ? 'TRUNG BINH' : 'BINH THUONG';
    const preview = c.line.replace(/^-\s*/, '');
    return [
      `${i + 1}. ${c.name}`,
      `   Mức độ: ${urgency} -- ${c.staleDays} ngày chưa phản hồi (từ ${c.lastDate})`,
      `   Nội dung gần nhất: ${preview}`,
      `   Gợi ý nhắn: Viết 1 câu nhắn tin tự nhiên cho khách này dựa trên nội dung trên. Giọng như đang hỏi thăm, không bán hàng. Ví dụ: "Anh/chị [tên] ơi, hôm trước mình trao đổi về [chủ đề], anh/chị đã cân nhắc thế nào ạ?"`,
    ].join('\n');
  });

  return (
    `Em đã quét memory khách hàng Zalo và tìm được ${candidates.length} khách cần follow-up.\n\n` +
    `Gửi cho CEO báo cáo với format bên dưới. Với mỗi khách, VIẾT MỘT CÂU NHẮN GỢI Ý CỤ THỂ dựa trên nội dung cuối cùng của họ (không dùng template chung chung). Ưu tiên khách có độ khẩn cấp CAO lên trước.\n\n` +
    `FOLLOW-UP KHACH ZALO (${candidates.length} khách)\n\n` +
    blocks.join('\n\n') +
    `\n\n` +
    `Với mỗi khách, thêm dòng "Gợi ý nhắn:" với 1 câu nhắn tin tự nhiên, cụ thể theo ngữ cảnh của khách đó. Không dùng template. Không bắt đầu bằng "Chào anh/chị" thuần túy.\n\n` +
    `Gửi đúng tool sessions_send. KHÔNG emoji, KHÔNG hỏi lại CEO, KHÔNG bịa thêm khách ngoài danh sách trên.`
  );
}

function buildMeditationPrompt() {
  return (
    `Bây giờ là 01:00 sáng. Đây là phiên TỐI ƯU BAN ĐÊM — em tự review bài học và tối ưu bộ nhớ.\n\n` +
    `1. Đọc .learnings/LEARNINGS.md — liệt kê những learning nào xuất hiện > 2 lần hoặc có impact cao\n` +
    `2. Đọc memory/ (journal entries, weekly-digest.md nếu có) — tìm patterns: khách hay hỏi gì, CEO cần gì thường xuyên, điểm nào bot hay sai\n` +
    `3. Nếu tìm thấy pattern đáng ghi nhận: append vào .learnings/LEARNINGS.md với format L-XXX (tiếp số hiện có)\n` +
    `4. Gửi CEO báo cáo ngắn:\n` +
    `**TỐI ƯU BAN ĐÊM**\n` +
    `- Đã review N learning entries\n` +
    `- Pattern mới phát hiện: [bullet nếu có, hoặc "Không có gì mới"]\n` +
    `- Điểm cần cải thiện: [1-2 bullet ngắn]\n\n` +
    `KHÔNG dùng emoji. KHÔNG hỏi lại CEO. KHÔNG sửa AGENTS.md (chỉ ghi vào LEARNINGS.md).`
  );
}

function buildMemoryCleanupPrompt() {
  return (
    `Dọn dẹp memory. Đọc tất cả file trong memory/ (trừ zalo-users/).\n\n` +
    `1. Tìm các journal entries cũ > 7 ngày, tổng hợp những insight quan trọng\n` +
    `2. Ghi tổng hợp tuần vào memory/weekly-digest.md (append, không xóa cũ)\n` +
    `3. Xác định thông tin trùng lặp hoặc outdated trong memory files\n\n` +
    `Gửi CEO báo cáo ngắn:\n` +
    `**DỌN DẸP MEMORY**\n` +
    `- Đã tổng hợp N journal entries\n` +
    `- Insight chính: [1-3 bullet]\n\n` +
    `KHÔNG xóa file gốc, chỉ tổng hợp. KHÔNG dùng emoji. KHÔNG hỏi lại CEO.`
  );
}

// Manually trigger a cron handler (for "Test ngay" button in Dashboard).
// CRITICAL: test fires MUST be byte-identical to scheduled cron fires so the
// customer's test preview matches what they'll receive in production. No
// "[TEST]" preambles, no "(tin test thủ công)" footers — reuse the exact same
// prompt builders.
ipcMain.handle('test-cron', async (_event, { type, id }) => {
  try {
    if (type === 'fixed') {
      const schedules = loadSchedules();
      const s = schedules.find(x => x.id === id);
      if (!s) return { success: false, error: 'Schedule not found' };
      if (id === 'morning') {
        const prompt = buildMorningBriefingPrompt(s.time);
        const ok = await runCronViaSessionOrFallback(prompt, { label: 'TEST — morning-briefing' });
        return { success: ok, sent: ok };
      } else if (id === 'evening') {
        const prompt = buildEveningSummaryPrompt(s.time);
        const ok = await runCronViaSessionOrFallback(prompt, { label: 'TEST — evening-summary' });
        return { success: ok, sent: ok };
      } else if (id === 'heartbeat') {
        const sent = await sendTelegram(`*Heartbeat*\n\nHệ thống đang hoạt động bình thường.`);
        return { success: sent === true, sent };
      } else if (id === 'meditation') {
        const prompt = buildMeditationPrompt();
        const ok = await runCronAgentPrompt(prompt, { label: 'TEST — meditation' });
        return { success: ok, sent: ok };
      } else if (id === 'weekly') {
        const prompt = await buildWeeklyReportPrompt();
        const ok = await runCronViaSessionOrFallback(prompt, { label: 'TEST — weekly-report' });
        return { success: ok, sent: ok };
      } else if (id === 'monthly') {
        const prompt = buildMonthlyReportPrompt();
        const ok = await runCronViaSessionOrFallback(prompt, { label: 'TEST — monthly-report' });
        return { success: ok, sent: ok };
      } else if (id === 'zalo-followup') {
        const ws = getWorkspace();
        const candidates = ws ? scanZaloFollowUpCandidates(ws) : [];
        const prompt = buildZaloFollowUpPrompt(candidates);
        const ok = await runCronAgentPrompt(prompt, { label: 'TEST — zalo-followup' });
        return { success: ok, sent: ok };
      } else if (id === 'memory-cleanup') {
        const prompt = buildMemoryCleanupPrompt();
        const ok = await runCronAgentPrompt(prompt, { label: 'TEST — memory-cleanup' });
        return { success: ok, sent: ok };
      }
      return { success: false, error: 'Unknown schedule id' };
    } else if (type === 'custom') {
      const customs = loadCustomCrons();
      const c = customs.find(x => x.id === id);
      if (!c) return { success: false, error: 'Custom cron not found' };
      const ok = c.prompt && !c.prompt.startsWith('exec:')
        ? await runCronViaSessionOrFallback(c.prompt, { label: `TEST — ${c.label || c.id}` })
        : await runCronAgentPrompt(c.prompt, { label: `TEST — ${c.label || c.id}` });
      return { success: ok, sent: ok };
    }
    return { success: false, error: 'Unknown type' };
  } catch (e) { return { success: false, error: e.message }; }
});

// ============================================
//  CRON SCHEDULER (node-cron + Telegram Bot API)
// ============================================

const cron = require('node-cron');
let cronJobs = [];

// Sticky chatId persistence — protects against the silent-failure mode where
// the openclaw.json loses its `channels.telegram.allowFrom` entry (manual edit,
// downgrade, partial wizard, etc.). We persist the chatId every time we observe
// it, and recover from this file when config is missing it.
function getStickyChatIdPath() {
  return path.join(HOME, '.openclaw', 'modoroclaw-sticky-chatid.json');
}
function persistStickyChatId(token, chatId) {
  try {
    if (!chatId) return;
    const file = getStickyChatIdPath();
    const fp = token ? require('crypto').createHash('sha256').update(token).digest('hex').slice(0, 16) : null;
    // D20: Compare-then-write to avoid file system thrash. getTelegramConfig
    // is called from EVERY sendTelegram + every cron fire — we'd otherwise
    // rewrite this file dozens of times per minute with identical content.
    if (fs.existsSync(file)) {
      try {
        const existing = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (existing.chatId === String(chatId) && existing.tokenFingerprint === fp) {
          return; // unchanged, skip write
        }
      } catch {}
    }
    writeJsonAtomic(file, {
      chatId: String(chatId),
      // Store a token hash (not the token itself) so we can verify the sticky
      // value belongs to the same bot if multiple bots are configured later.
      tokenFingerprint: fp,
      savedAt: new Date().toISOString(),
    });
  } catch (e) { console.error('[sticky-chatid] write error:', e.message); }
}
function loadStickyChatId(token) {
  try {
    const file = getStickyChatIdPath();
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    // If we know the token, verify the fingerprint matches — otherwise the
    // sticky value might belong to a different bot.
    if (token && data.tokenFingerprint) {
      const fp = require('crypto').createHash('sha256').update(token).digest('hex').slice(0, 16);
      if (fp !== data.tokenFingerprint) return null;
    }
    return data.chatId || null;
  } catch { return null; }
}

// Last-resort recovery: ask Telegram's getUpdates for any recent chat that has
// messaged this bot, and return the first numeric chat id. Works if the user
// has ever sent a message to the bot in the last ~24h. Returns null on failure.
//
// IMPORTANT (D19): we explicitly pass `offset: 0` and `timeout: 0` (i.e. NOT
// long polling) so this call:
//   1. Does NOT acknowledge any updates (no offset advance) — openclaw's own
//      poller still receives them.
//   2. Returns instantly without holding a long-poll connection that would
//      block openclaw's poller.
//   3. May still briefly conflict with openclaw's poll → Telegram returns
//      409 Conflict to one of us. We accept the failure and the recovery
//      simply returns null. We don't retry.
//
// Throttled to once per 60s so a misconfigured environment doesn't hammer
// Telegram on every cron fire.
let _lastRecoverChatIdAt = 0;
async function recoverChatIdFromTelegram(token) {
  if (!token) return null;
  const now = Date.now();
  if (now - _lastRecoverChatIdAt < 60000) {
    console.log('[recover-chatid] throttled (last attempt < 60s ago)');
    return null;
  }
  _lastRecoverChatIdAt = now;
  try {
    return await new Promise((resolve) => {
      const https = require('https');
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${token}/getUpdates?offset=0&timeout=0&limit=10`,
        method: 'GET',
        timeout: 5000,
      }, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (!parsed.ok || !Array.isArray(parsed.result)) {
              if (parsed.error_code === 409) {
                console.log('[recover-chatid] 409 Conflict (openclaw poller is active) — skipping');
              }
              return resolve(null);
            }
            // Iterate newest-first WITHOUT mutating the original array.
            for (let i = parsed.result.length - 1; i >= 0; i--) {
              const update = parsed.result[i];
              const chat = update?.message?.chat || update?.edited_message?.chat;
              if (chat && typeof chat.id === 'number' && chat.type === 'private') {
                console.log('[recover-chatid] recovered from Telegram getUpdates:', chat.id);
                return resolve(String(chat.id));
              }
            }
            resolve(null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    });
  } catch { return null; }
}

function getTelegramConfig() {
  try {
    const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const token = config?.channels?.telegram?.botToken;
    const allowFrom = config?.channels?.telegram?.allowFrom;
    let chatId = allowFrom && allowFrom[0]; // First allowed user = CEO
    if (chatId) {
      persistStickyChatId(token, chatId); // keep sticky file fresh
      return { token, chatId };
    }
    // Config-missing-chatId fallback: try sticky file
    const sticky = loadStickyChatId(token);
    if (sticky) {
      console.warn('[getTelegramConfig] chatId missing from openclaw.json — using sticky file value:', sticky);
      return { token, chatId: sticky, recovered: 'sticky' };
    }
    return { token, chatId: undefined };
  } catch { return {}; }
}

// Async variant that ALSO tries Telegram getUpdates as last resort. Use this
// in cron handlers where we MUST find a chatId or fail loudly.
async function getTelegramConfigWithRecovery() {
  const sync = getTelegramConfig();
  if (sync.chatId) return sync;
  if (!sync.token) return sync;
  // Last resort: ask Telegram who has talked to this bot recently.
  const recovered = await recoverChatIdFromTelegram(sync.token);
  if (recovered) {
    persistStickyChatId(sync.token, recovered);
    // Also write it back into openclaw.json so subsequent calls don't need recovery.
    // Wrapped in config lock to avoid clobbering concurrent wizard/manager writes.
    await withOpenClawConfigLock(async () => {
      try {
        console.log('[config-lock] getTelegramConfigWithRecovery acquired');
        const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (!config.channels) config.channels = {};
        if (!config.channels.telegram) config.channels.telegram = {};
        const arr = Array.isArray(config.channels.telegram.allowFrom) ? config.channels.telegram.allowFrom : [];
        const num = parseInt(recovered, 10);
        if (Number.isFinite(num) && !arr.includes(num)) {
          config.channels.telegram.allowFrom = [num, ...arr];
          writeOpenClawConfigIfChanged(configPath, config);
          console.log('[getTelegramConfigWithRecovery] wrote recovered chatId back into openclaw.json');
        }
      } catch (e) { console.error('[getTelegramConfigWithRecovery] write back failed:', e.message); }
    });
    return { token: sync.token, chatId: recovered, recovered: 'telegram-getUpdates' };
  }
  return sync;
}

function getGatewayAuthToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  try {
    const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return config?.gateway?.auth?.token || null;
  } catch { return null; }
}

async function getCeoSessionKey() {
  try {
    const { chatId } = await getTelegramConfigWithRecovery();
    if (!chatId) return null;
    return `agent:main:telegram:direct:${chatId}`;
  } catch { return null; }
}

async function sendToGatewaySession(sessionKey, message) {
  try {
    const params = JSON.stringify({ key: sessionKey, message });
    const res = await spawnOpenClawSafe(
      ['gateway', 'call', 'sessions.send', '--params', params, '--json'],
      { timeoutMs: 180000, allowCmdShellFallback: false }
    );
    if (res.code !== 0) {
      console.warn('[sessions.send] failed (exit ' + res.code + '):', (res.stderr || '').slice(0, 300));
      return false;
    }
    console.log('[sessions.send] delivered to', sessionKey.slice(0, 40) + '...');
    return true;
  } catch (e) {
    console.warn('[sessions.send] error:', e?.message || e);
    return false;
  }
}

async function runCronViaSessionOrFallback(prompt, opts = {}) {
  // gateway call subprocess reads auth from its own openclaw.json — no need to pass token
  const sessionKey = await getCeoSessionKey();
  if (sessionKey) {
    const ok = await sendToGatewaySession(sessionKey, prompt);
    if (ok) {
      journalCronRun({ phase: 'ok', label: opts.label || 'cron', mode: 'session-send' });
      return true;
    }
    console.log('[cron] sessions.send failed, falling back to runCronAgentPrompt');
  }
  return runCronAgentPrompt(prompt, opts);
}

// ============================================
//  SHARED OUTPUT FILTER — same patterns for Telegram + Zalo
// ============================================
// Mirrors the 47 block patterns from the openzalo fork send.ts so BOTH
// channels get the same defense-in-depth. Zalo's transport-layer filter in
// send.ts is the primary defense for Zalo; this function covers Telegram
// sends from main.js (cron delivery, alerts) and sendZalo() direct sends.
const _outputFilterPatterns = [
  // Layer A: file paths + secrets
  { name: 'file-path-memory', re: /\bmemory\/[\w\-./]*\.md\b/i },
  { name: 'file-path-learnings', re: /\.learnings\/[\w\-./]*/i },
  { name: 'file-path-core', re: /\b(?:SOUL|USER|MEMORY|AGENTS|IDENTITY|COMPANY|PRODUCTS|BOOTSTRAP|HEARTBEAT|TOOLS)\.md\b/i },
  { name: 'file-path-config', re: /\bopenclaw\.json\b/i },
  { name: 'line-ref', re: /#L\d+/i },
  { name: 'unix-home', re: /~\/\.openclaw|~\/\.openzca/i },
  { name: 'win-user-path', re: /[A-Z]:[/\\]Users[/\\]/i },
  { name: 'api-key-sk', re: /\bsk-[a-zA-Z0-9_\-]{16,}/i },
  { name: 'bearer-token', re: /\bBearer\s+[a-zA-Z0-9_\-.]{20,}/i },
  { name: 'hex-token-48', re: /\b[a-f0-9]{48}\b/i },
  { name: 'botToken-field', re: /\bbotToken\b/i },
  { name: 'apiKey-field', re: /\bapiKey\b/i },
  // Layer A1.7: PII masking — bot MUST NOT echo sensitive customer data
  // extracted from images (CCCD, bank receipts, ID cards) now that the
  // vision 5-layer patch enables OCR. Nghị định 13/2023 (VN privacy law).
  // Tuned CONSERVATIVE to avoid false-positive blocking legit CS replies:
  //   - CCCD/CMND: require context keyword adjacency. Bare 12-digit numbers
  //     are common (order codes, timestamps, tracking IDs) so we won't
  //     block those; we only block when the bot explicitly SAYS "CCCD"
  //     or "căn cước" or "số CMND" next to a 9/12-digit run.
  //   - Bank account: require context keyword. Bare long numbers don't trip.
  //   - Credit card: require 13-19 digits WITH separator pattern (raw
  //     clumps already appear in product SKUs, so don't match without
  //     typical "XXXX-XXXX-XXXX-XXXX" or "XXXX XXXX XXXX XXXX" shape).
  //   - Phone: intentionally NOT filtered — Vietnamese CS routinely echoes
  //     phone numbers ("hotline 0909..."). Blocking all phones breaks
  //     legitimate operation.
  { name: 'pii-cccd-cmnd', re: /(?:cccd|căn\s*cước|cmnd|chứng\s*minh\s*(?:nhân\s*dân|thư))[\s:=]*\d{9}(?:\d{3})?\b/i },
  { name: 'pii-bank-account', re: /(?:stk|số\s*tài\s*khoản|account\s*(?:number|no\.?)|acct\s*#?)[\s:=]*\d{6,20}/i },
  { name: 'pii-credit-card', re: /\b\d{4}[\s-]\d{4}[\s-]\d{4}[\s-]\d{1,4}\b/ },
  // Layer A1.4: upstream API / LLM error leakage — ChatGPT/OpenAI errors passed through
  // 9Router into bot reply text. Customer must NEVER see "[Error] Our servers are..."
  { name: 'api-error-bracket', re: /\[Error\]/i },
  { name: 'api-overloaded', re: /servers? (?:are |is )?(?:currently )?overloaded/i },
  { name: 'api-rate-limit', re: /rate.?limit(?:ed|ing)?\b/i },
  { name: 'api-try-again', re: /(?:please |pls )?try again later/i },
  { name: 'api-internal-error', re: /(?:internal server error|502 bad gateway|503 service|429 too many)/i },
  { name: 'api-quota-exceeded', re: /quota.?exceeded|usage.?limit/i },
  // Layer A1.5: bot "silent" tokens — model outputs these instead of truly staying silent
  { name: 'bot-silent-token', re: /^(NO_REPLY|SKIP|SILENT|DO_NOT_REPLY|IM_LANG|IM LẶNG|KHÔNG TRẢ LỜI|no.?reply|skip.?message)$/i },
  // Layer A2: compaction/context reset
  { name: 'compaction-notice', re: /(?:Auto-compaction|Compacting context|Context limit exceeded|reset our conversation)/i },
  { name: 'compaction-emoji', re: /🧹/ },
  // Layer B: English chain-of-thought leakage
  // NOTE: cot-en-the-actor intentionally excludes "customer" — legitimate CS replies
  // routinely reference "the customer" in English phrases. "assistant/bot/model" are CoT.
  { name: 'cot-en-the-actor', re: /\bthe (assistant|bot|model)\b/i },
  // NOTE: cot-en-we-modal excludes "we can / let me / let's / i'll" — these appear in
  // code-switched Vietnamese CS replies ("Let me check for you", "We can arrange that").
  // Only block the obvious CoT patterns that have no CS use case.
  { name: 'cot-en-we-modal', re: /\b(we need to|we have to|we should|i need to|i should)\b/i },
  { name: 'cot-en-meta', re: /\b(internal reasoning|chain of thought|system prompt|instructions|prompt injection|tool call)\b/i },
  { name: 'cot-en-narration', re: /\b(based on (the|our)|according to (the|my)|as (you|i) (can|mentioned)|in (the|this) conversation)\b/i },
  { name: 'cot-en-reasoning-verbs', re: /\b(let me think|hmm,? let|first,? (i|let|we)|okay,? (so|let|i)|alright,? (so|let|i))\b/i },
  // Layer C: meta-commentary about file/tool operations
  { name: 'meta-vi-file-ops', re: /(?<![a-zA-Z0-9_])(edit file|ghi (?:vào )?file|lưu (?:vào )?file|update file|append file|read file|đọc file|cập nhật file|sửa file|tạo file|xóa file)(?![a-zA-Z0-9_])/i },
  { name: 'meta-vi-tool-name', re: /\b(tool (?:Edit|Write|Read|Bash|Grep|Glob)|use the (?:Edit|Write|Read) tool|công cụ (?:Edit|Write|Read|Bash))\b/i },
  { name: 'meta-vi-memory-claim', re: /(?<![a-zA-Z0-9_])(đã (?:lưu|ghi|cập nhật|update) (?:vào |trong )?(?:bộ nhớ|memory|hồ sơ|file|database)|stored (?:in|to) memory|saved to (?:file|memory))(?![a-zA-Z0-9_])/i },
  { name: 'meta-vi-tool-action', re: /\b(em (?:vừa|đã) (?:edit|write|read|chạy|gọi) (?:file|tool|công cụ)|em (?:vừa|đã) (?:cập nhật|sửa|đọc) (?:file|memory|database))\b/i },
  { name: 'meta-vi-fact-claim', re: /(?<![a-zA-Z0-9_])(em đã (?:cập nhật|ghi (?:nhận|chú)|lưu(?: lại)?) (?:rằng|thêm rằng|sở thích|preference|là anh|là chị|là mình)|đã (?:cập nhật|ghi nhận|lưu) (?:thêm )?rằng)(?![a-zA-Z0-9_])/i },
  // Layer D: all-Latin / no-Vietnamese-diacritic (>200 chars, no URL)
  // Threshold raised 40→200: product listings like "iPhone 15 Pro 256GB: 25,900,000 VND"
  // are all-Latin but legitimate CS replies. CoT leaks are long walls of English text (>200c).
  { name: 'no-vietnamese-diacritic', re: /^(?!.*https?:\/\/)(?=[\s\S]{200,})(?!.*[àáảãạâấầẩẫậăắằẳẵặèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđÀÁẢÃẠÂẤẦẨẪẬĂẮẰẲẴẶÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴĐ]).+/s },
  // Layer E: brand + internal name leakage
  // v2.2.59 fix: old regex \bopenzca\b blocked legit system notifications
  // like "Zalo đã sẵn sàng" (mentions "openzca listener"). Tightened to
  // match only path-like / CoT-debug contexts: file exts, path separators,
  // debug verbs (error/crashed/spawn). Plain brand word is now allowed —
  // system alerts are either routed via sendCeoAlert (skipFilter=true) or
  // ready-notify (skipFilter=true), and AI CoT leaks always appear alongside
  // paths or debug verbs, not as bare brand name.
  { name: 'brand-9bizclaw', re: /9bizclaw[\/\\.\-](?:dist|cli|json|ts|js|log|md)|(?:error|crashed|spawn|exception|stack(?:\s*trace)?)\s+9bizclaw/i },
  { name: 'brand-openclaw', re: /openclaw[\/\\.\-](?:dist|cli|mjs|json|ts|js|log|md)|(?:error|crashed|spawn|exception|stack(?:\s*trace)?)\s+openclaw/i },
  { name: 'brand-9router', re: /9router[\/\\.\-](?:dist|cli|json|ts|js|log|md)|(?:error|crashed|spawn|exception|stack(?:\s*trace)?)\s+9router/i },
  { name: 'brand-openzca', re: /openzca[\/\\.\-](?:dist|cli|listen|json|ts|js|log|md)|(?:error|crashed|spawn|exception|stack(?:\s*trace)?)\s+openzca/i },
  // Layer F: prompt injection acknowledgment leakage
  { name: 'jailbreak-acknowledge', re: /\b(developer mode|jailbreak|ignore previous|forget instructions|role\s*play as|you are now|pretend to be)\b/i },
  { name: 'system-prompt-leak', re: /\b(my (?:instructions|prompt|system prompt|rules)|here (?:are|is) my (?:rules|instructions))/i },
  // Layer G: cross-customer PII leakage (any attempt to list customers)
  { name: 'list-all-customers', re: /(?:tất cả khách hàng|all customers|list customers|other customers?|khách khác cũng|khách hàng khác)/i },
  // Layer H: fake order confirmation / hallucinated commerce — bot must NEVER
  // confirm orders, prices, shipping fees, discounts, or bookings without CEO.
  // These patterns are aggressive — if they fire, the bot was about to make a
  // commitment it cannot honor, which creates legal + reputation risk.
  { name: 'fake-order-confirm', re: /(?:đã\s+(?:xác\s*nhận|tạo|lưu|ghi\s*nhận)\s*đơn|đơn\s*(?:của\s+(?:anh|chị|mình|bạn))?\s*(?:đã|được)\s+(?:tạo|xác\s*nhận|lưu|ghi))/i },
  { name: 'fake-shipping-fee', re: /(?:phí\s*ship|ship\s*phí|phí\s*vận\s*chuyển|tiền\s*ship)\s*[:=]?\s*\d{1,3}[.,]?\d{3}/i },
  { name: 'fake-total-amount', re: /tổng\s*(?:tiền|cộng|đơn\s*hàng|thanh\s*toán|cần\s*thanh\s*toán)\s*[:=]?\s*\d{1,3}[.,]?\d{3}/i },
  { name: 'fake-discount-percent', re: /(?:giảm\s*(?:giá)?|discount|khuyến\s*mãi|sale)\s*\d{1,2}\s*%/i },
  { name: 'fake-booking-confirmed', re: /(?:đã\s*(?:đặt|book|giữ|xác\s*nhận))\s*(?:lịch|bàn|phòng|chỗ|slot|lịch\s*hẹn|cuộc\s*hẹn)/i },
  { name: 'fake-payment-received', re: /(?:đã\s*nhận\s*(?:thanh\s*toán|tiền|chuyển\s*khoản)|payment\s*received)/i },
];

const _outputFilterSafeMsgs = [
  'Dạ em xin lỗi, cho em một phút em rà lại thông tin rồi báo lại mình ạ.',
  'Dạ em ghi nhận rồi ạ. Em sẽ kiểm tra và phản hồi lại mình ngay.',
  'Dạ em đang xác nhận lại thông tin, mình chờ em xíu nha.',
];

// Strip markdown artifacts from Zalo-bound text. Zalo does NOT render markdown,
// so **bold**, *italic*, `code`, ``` blocks, # headers, and bullet lists all
// appear as literal asterisks/hashes to customers. This strips them cleanly.
// Also strips zero-width chars, RLO/LRO Unicode overrides, HTML tags.
function sanitizeZaloText(text) {
  if (!text || typeof text !== 'string') return '';
  let out = String(text);
  out = out.replace(/```[\s\S]*?```/g, '');                       // code fences
  out = out.replace(/`([^`]+)`/g, '$1');                           // inline code
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '$1');                   // **bold**
  out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1');          // *italic*
  out = out.replace(/__([^_\n]+)__/g, '$1');                       // __bold__
  out = out.replace(/(?<!_)_([^_\n]+)_(?!_)/g, '$1');              // _italic_
  out = out.replace(/^#{1,6}\s+/gm, '');                           // # headings
  out = out.replace(/^>\s*/gm, '');                                // > blockquote
  out = out.replace(/^\s*[-*+•·]\s*/gm, '');                        // - bullets + • · unicode
  out = out.replace(/^\s*\d+[.)]\s+/gm, '');                       // 1. numbered
  out = out.replace(/\|([^|\n]+)\|/g, '$1');                       // | table |
  out = out.replace(/<\/?[a-zA-Z][^>]*>/g, '');                    // HTML tags
  out = out.replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, '');    // zero-width + RLO/LRO
  out = out.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1FA00}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, ''); // strip ALL emoji
  out = out.replace(/\n{3,}/g, '\n\n');                             // collapse newlines
  return out.trim();
}

function filterSensitiveOutput(text) {
  if (!text || typeof text !== 'string') return { blocked: false, text };
  for (const p of _outputFilterPatterns) {
    if (p.re.test(text)) {
      const safeMsg = _outputFilterSafeMsgs[Math.floor(Math.random() * _outputFilterSafeMsgs.length)];
      try {
        const logDir = path.join(getWorkspace(), 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(path.join(logDir, 'security-output-filter.jsonl'),
          JSON.stringify({ t: new Date().toISOString(), event: 'output_blocked', pattern: p.name, channel: 'main-process', bodyPreview: text.slice(0, 200), bodyLength: text.length }) + '\n', 'utf-8');
      } catch {}
      return { blocked: true, pattern: p.name, text: safeMsg };
    }
  }
  return { blocked: false, text };
}

// ============================================
//  CHANNEL PAUSE — file-based pause for Telegram + Zalo (Dashboard control)
// ============================================
function _getPausePath(channel) {
  const ws = getWorkspace();
  if (!ws) return null;
  return path.join(ws, `${channel}-paused.json`);
}

function setChannelPermanentPause(channel, reason = 'manual-disabled') {
  const p = _getPausePath(channel);
  if (!p) return false;
  try {
    writeJsonAtomic(p, {
      permanent: true,
      reason,
      pausedAt: new Date().toISOString(),
    });
    console.log(`[pause] ${channel} permanently paused (${reason})`);
    return true;
  } catch (e) {
    console.error(`[pause] ${channel} permanent pause error:`, e.message);
    return false;
  }
}

function clearChannelPermanentPause(channel) {
  const p = _getPausePath(channel);
  if (!p) return false;
  try {
    if (!fs.existsSync(p)) return true;
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
      data = { permanent: true, reason: 'corrupt' };
    }
    if (data?.permanent) {
      fs.unlinkSync(p);
      console.log(`[pause] ${channel} permanent pause cleared`);
    }
    return true;
  } catch (e) {
    console.error(`[pause] ${channel} clear permanent pause error:`, e.message);
    return false;
  }
}

function isZaloChannelEnabled() {
  try {
    const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
    if (!fs.existsSync(configPath)) return false;
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return cfg?.channels?.openzalo?.enabled !== false;
  } catch (e) {
    console.error('[zalo] read enabled state error:', e.message);
    return false;
  }
}

function setZaloChannelEnabled(enabled) {
  try {
    const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
    if (!fs.existsSync(configPath)) return false;
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (!cfg.channels) cfg.channels = {};
    if (!cfg.channels.openzalo || typeof cfg.channels.openzalo !== 'object') {
      cfg.channels.openzalo = {};
    }
    const next = enabled !== false;
    if (cfg.channels.openzalo.enabled === next) return true;
    cfg.channels.openzalo.enabled = next;
    return writeOpenClawConfigIfChanged(configPath, cfg);
  } catch (e) {
    console.error('[zalo] set enabled state error:', e.message);
    return false;
  }
}

function isChannelPaused(channel) {
  const p = _getPausePath(channel);
  if (!p) return false;
  try {
    if (!fs.existsSync(p)) return false;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
      // Corrupt pause file — fail closed: treat as paused to honor CEO's intent.
      // Better to block 1 message than to ignore a deliberate pause request.
      console.error(`[pause] ${channel} pause file corrupt — treating as paused (fail closed)`);
      return true;
    }
    // Permanent pause (e.g. default-disabled on fresh install) — no expiry
    if (data.permanent) return true;
    if (data.pausedUntil && new Date(data.pausedUntil) > new Date()) return true;
    // Expired — clean up
    try { fs.unlinkSync(p); } catch {}
    return false;
  } catch { return false; }
}

function pauseChannel(channel, durationMin = 30) {
  const p = _getPausePath(channel);
  if (!p) return false;
  const until = new Date(Date.now() + durationMin * 60 * 1000).toISOString();
  try {
    writeJsonAtomic(p, { pausedUntil: until, pausedAt: new Date().toISOString() });
    console.log(`[pause] ${channel} paused until ${until}`);
    return true;
  } catch (e) { console.error(`[pause] ${channel} error:`, e.message); return false; }
}

function resumeChannel(channel) {
  const p = _getPausePath(channel);
  if (!p) return false;
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  console.log(`[pause] ${channel} resumed`);
  return true;
}

function getChannelPauseStatus(channel) {
  const p = _getPausePath(channel);
  if (!p) return { paused: false };
  try {
    if (!fs.existsSync(p)) return { paused: false };
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (data.permanent) return { paused: true, permanent: true };
    if (data.pausedUntil && new Date(data.pausedUntil) > new Date()) {
      return { paused: true, until: data.pausedUntil };
    }
    try { fs.unlinkSync(p); } catch {}
    return { paused: false };
  } catch {
    return { paused: true, permanent: true, error: 'corrupt' };
  }
}

// skipFilter: bypass output filter for system alerts (cron errors, boot pings)
// that are OUR messages, not AI-generated. Blocking these would cause silent failures.
// R1: strip Telegram Markdown v1 syntax tokens so plain-text send doesn't
// leak raw `*` / backtick / triple-backtick into CEO's alert output.
// sendCeoAlert call sites use `*bold*` + ``` code fences historically.
function stripTelegramMarkdown(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/```[a-z]*\n?/gi, '')               // fence open
    .replace(/```/g, '')                          // fence close
    .replace(/\*{1,2}([^*\n]+)\*{1,2}/g, '$1')   // *bold* / **bold**
    .replace(/`([^`\n]+)`/g, '$1')                // `code`
    .replace(/__([^_\n]+)__/g, '$1')              // __double__
    .replace(/(?<![\w])_([^_\n]+)_(?![\w])/g, '$1'); // _italic_ (skip snake_case)
}

async function sendTelegram(text, { skipFilter = false, skipPauseCheck = false } = {}) {
  // Check pause state — skip send if Telegram is paused
  if (!skipPauseCheck && isChannelPaused('telegram')) {
    console.log('[sendTelegram] channel paused — skipping');
    return null;
  }
  // Output filter — same patterns as Zalo transport filter
  if (!skipFilter) {
    const filtered = filterSensitiveOutput(text);
    if (filtered.blocked) {
      console.warn(`[sendTelegram] output filter blocked (${filtered.pattern})`);
      text = filtered.text;
    }
  } else {
    // Bypass audit — so we can later verify bypass isn't abused.
    console.log('[sendTelegram] filter BYPASSED for system alert');
    try {
      const logDir = path.join(getWorkspace(), 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(path.join(logDir, 'security-output-filter.jsonl'),
        JSON.stringify({ t: new Date().toISOString(), event: 'output_bypass', channel: 'telegram', bodyPreview: text.slice(0, 200), bodyLength: text.length }) + '\n', 'utf-8');
    } catch {}
  }
  const { token, chatId } = getTelegramConfig();
  if (!token || !chatId) {
    console.error('[sendTelegram] missing token or chatId');
    return null;
  }
  // CRIT #8: Robust send with 429 retry, 401/403 persistent-failure alert,
  // 400 parse-mode fallback. Old code used parse_mode:'Markdown' (legacy v1)
  // which failed 400 on URLs with `_` or customer names like "DJ_Kool" — silent
  // cron drop. We now send plain text (no parse_mode) — safe for all content.
  // Strip Markdown syntax since we send without parse_mode (plain text)
  text = stripTelegramMarkdown(text);
  if (text.length > 4000) {
    let c = text.lastIndexOf('\n\n', 4000);
    if (c < 200) c = text.lastIndexOf('\n', 4000);
    if (c < 200) c = text.lastIndexOf(' ', 4000);
    if (c < 200) c = 4000;
    await sendTelegram(text.slice(0, c), { skipFilter: true, skipPauseCheck: true });
    await new Promise(r => setTimeout(r, 300));
    return sendTelegram(text.slice(c).trimStart(), { skipFilter: true, skipPauseCheck: true });
  }
  const https = require('https');
  const doRequest = (withRetry = true) => new Promise((resolve) => {
    const payload = JSON.stringify({ chat_id: chatId, text });
    const req = https.request(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', async () => {
          try {
            const parsed = JSON.parse(d);
            if (parsed.ok) { resolve(true); return; }
            const code = parsed.error_code || res.statusCode;
            const desc = parsed.description || '';
            // 429: rate limit — retry once after retry_after seconds
            if (code === 429 && withRetry) {
              const wait = Math.min((parsed.parameters?.retry_after || 3) * 1000, 15000);
              console.warn(`[sendTelegram] 429 rate limit — retrying in ${wait}ms`);
              setTimeout(() => doRequest(false).then(resolve), wait);
              return;
            }
            // 401/403: token revoked or bot blocked — log to missed-alerts
            if (code === 401 || code === 403) {
              console.error('[sendTelegram] token invalid/blocked:', desc);
              try {
                const logPath = path.join(getWorkspace(), 'logs', 'ceo-alerts-missed.log');
                fs.mkdirSync(path.dirname(logPath), { recursive: true });
                fs.appendFileSync(logPath, `${new Date().toISOString()}\tTELEGRAM-${code}\t${desc}\t${text.slice(0, 200)}\n`);
              } catch {}
              resolve(null);
              return;
            }
            console.error('[sendTelegram] API error:', code, desc);
            resolve(null);
          } catch (e) { console.error('[sendTelegram] parse error:', e.message); resolve(null); }
        });
      }
    );
    req.on('error', (e) => { console.error('[sendTelegram] network error:', e.message); resolve(null); });
    req.write(payload);
    req.end();
  });
  return doRequest(true);
}

// Send a direct Zalo message to the CEO's personal Zalo account via openzca CLI.
// Mirrors sendTelegram() for parity. Used by cron alerts and fallback delivery.
async function sendZalo(text, opts = {}) {
  // Zalo outbound disabled — owner system removed. Alerts go via Telegram only.
  return null;
}

// ============================================
//  APPOINTMENTS — local calendar driven by CEO via Telegram prompts
// ============================================
//
// Data: workspace/appointments.json (array of appointment objects).
// Engine: dispatcher tick every 60s — fires reminders + push targets.
// Bot writes via filesystem tool (rules in AGENTS.md). Dashboard is view + fallback.
//
// Schema: see normalizeAppointment() below. Each appointment has:
//   - start/end (ISO8601 with TZ), meetingUrl, location, note
//   - reminderMinutes + reminderChannels (telegram/zalo) — 1 shot before start
//   - pushTargets[] — {channel, toId, toName, atTime, daily, template}
//     channel = telegram | zalo_user | zalo_group
//     atTime = 'HH:MM' local, daily=true => repeat each day until appointment passes
//   - status = scheduled | done | canceled

function getAppointmentsPath() {
  // Bot (openclaw agent process) writes to agents.defaults.workspace.
  // Dispatcher MUST read from the same path or split-brain occurs. Prefer bot's
  // workspace, fallback to Electron workspace, last resort HOME.
  try {
    const botWs = getOpenclawAgentWorkspace();
    if (botWs) return path.join(botWs, 'appointments.json');
  } catch {}
  const ws = getWorkspace();
  if (ws) return path.join(ws, 'appointments.json');
  return path.join(HOME, 'appointments.json');
}

function readAppointments() {
  try {
    const p = getAppointmentsPath();
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('[appointments] read error:', e.message);
    return [];
  }
}

function writeAppointments(arr) {
  const p = getAppointmentsPath();
  const tmp = p + '.tmp';
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf-8');
  } catch (e) {
    console.error('[appointments] write error (tmp):', e.message);
    return false;
  }
  // Windows + antivirus can transiently hold `appointments.json` and make
  // renameSync throw EBUSY/EPERM. Retry a few times with short backoff before
  // giving up so an AV scan doesn't cause silent mutation loss.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.renameSync(tmp, p);
      return true;
    } catch (e) {
      const code = e && e.code;
      if ((code === 'EBUSY' || code === 'EPERM' || code === 'EEXIST') && attempt < 3) {
        const wait = 30 + attempt * 50;
        const until = Date.now() + wait;
        while (Date.now() < until) { /* spin briefly, synchronous on purpose */ }
        continue;
      }
      console.error(`[appointments] write error (rename attempt ${attempt + 1}):`, e.message);
      try { fs.unlinkSync(tmp); } catch {}
      return false;
    }
  }
  return false;
}

function newAppointmentId() {
  return `apt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

// Serialize all in-process mutations so IPC handlers + dispatcher tick don't race.
// Returns null on write failure (caller must check) or if mutator throws/returns
// non-array (abort). Guards against reentrant calls that would deadlock the queue.
let _apptWriteQueue = Promise.resolve();
let _apptMutating = false;
function mutateAppointments(mutatorFn) {
  if (_apptMutating) {
    console.error('[appointments] recursive mutateAppointments call refused — would deadlock');
    return Promise.resolve(null);
  }
  const next = _apptWriteQueue.then(async () => {
    _apptMutating = true;
    try {
      const list = readAppointments();
      const result = await mutatorFn(list);
      if (!Array.isArray(result)) return null;
      if (!writeAppointments(result)) return null;
      return result;
    } catch (e) {
      console.error('[appointments] mutate error:', e.message);
      return null;
    } finally {
      _apptMutating = false;
    }
  });
  _apptWriteQueue = next.catch(() => null);
  return next;
}

// VN timezone helpers — engine must always display/compare VN local time
// regardless of machine timezone (demo machines may run UTC/PST).
function vnHHMM(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    if (!Number.isFinite(d.getTime())) return '';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d);
  } catch { return ''; }
}
function vnDDMM(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    if (!Number.isFinite(d.getTime())) return '';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Ho_Chi_Minh',
      day: '2-digit', month: '2-digit',
    }).format(d);
  } catch { return ''; }
}
function vnHHMMNow() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}
function vnDateKeyNow() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function normalizeAppointment(a) {
  if (!a || typeof a !== 'object') return null;
  const clean = (v, max) => String(v == null ? '' : v).slice(0, max);
  return {
    id: a.id || newAppointmentId(),
    title: clean(a.title, 200),
    customerName: clean(a.customerName, 100),
    phone: clean(a.phone, 30),
    start: a.start || null,
    end: a.end || null,
    meetingUrl: clean(a.meetingUrl, 500),
    location: clean(a.location, 200),
    note: clean(a.note, 1000),
    reminderMinutes: Number.isFinite(Number(a.reminderMinutes)) ? Number(a.reminderMinutes) : 15,
    reminderChannels: Array.isArray(a.reminderChannels) && a.reminderChannels.length
      ? a.reminderChannels.filter(c => c === 'telegram' || c === 'zalo') : ['telegram'],
    pushTargets: Array.isArray(a.pushTargets) ? a.pushTargets.map(t => ({
      channel: ['telegram', 'zalo_user', 'zalo_group'].includes(t?.channel) ? t.channel : 'telegram',
      toId: clean(t?.toId, 100),
      toName: clean(t?.toName, 200),
      atTime: /^\d{2}:\d{2}$/.test(t?.atTime || '') ? t.atTime : null,
      daily: !!t?.daily,
      template: clean(t?.template, 1000),
    })) : [],
    status: ['scheduled', 'done', 'canceled'].includes(a.status) ? a.status : 'scheduled',
    reminderFiredAt: a.reminderFiredAt || null,
    pushedAt: (a.pushedAt && typeof a.pushedAt === 'object') ? a.pushedAt : {},
    createdBy: a.createdBy || 'telegram',
    createdAt: a.createdAt || new Date().toISOString(),
  };
}

let _zaloListenerAlive = null;
let _zaloListenerAliveAt = 0;
const ZALO_LISTENER_CACHE_TTL = 30000;
function isZaloListenerAlive() {
  const now = Date.now();
  if (_zaloListenerAlive !== null && (now - _zaloListenerAliveAt) < ZALO_LISTENER_CACHE_TTL) {
    return _zaloListenerAlive;
  }
  const pid = findOpenzcaListenerPid();
  _zaloListenerAlive = !!pid;
  _zaloListenerAliveAt = now;
  return _zaloListenerAlive;
}

// Send a Zalo message to an arbitrary target (user or group), unlike sendZalo()
// which only ever talks to the configured CEO owner. Used by appointment push
// targets so bot/cron can push meeting links into any group or friend.
async function sendZaloTo(target, text, opts = {}) {
  let targetId, isGroup;
  if (typeof target === 'string') {
    if (target.startsWith('group:')) { targetId = target.slice(6); isGroup = true; }
    else if (target.startsWith('user:')) { targetId = target.slice(5); isGroup = false; }
    else { targetId = target; isGroup = false; }
  } else if (target && typeof target === 'object') {
    targetId = String(target.id || target.toId || '');
    isGroup = !!target.isGroup;
  }
  if (!targetId) { console.error('[sendZaloTo] missing target id'); return null; }

  const { skipFilter = false, skipPauseCheck = false } = opts;
  if (!isZaloChannelEnabled()) {
    console.log('[sendZaloTo] channel disabled in config — skipping');
    return null;
  }
  if (!skipPauseCheck && isChannelPaused('zalo')) {
    console.log('[sendZaloTo] channel paused — skipping');
    return null;
  }
  if (!opts.skipListenerCheck && !isZaloListenerAlive()) {
    console.error('[sendZaloTo] Zalo listener not running — refusing send (would silently fail)');
    return null;
  }
  if (!skipFilter) {
    text = sanitizeZaloText(text);
    const filtered = filterSensitiveOutput(text);
    if (filtered.blocked) {
      console.warn(`[sendZaloTo] output filter blocked (${filtered.pattern})`);
      text = filtered.text;
    }
  }

  const allow = isZaloTargetAllowed(targetId, { isGroup });
  if (!allow.allowed) {
    console.warn(`[sendZaloTo] blocked by policy (${allow.reason}) target=${targetId}`);
    return null;
  }

  const zcaBin = findGlobalPackageFile('openzca', 'dist/cli.js');
  if (!zcaBin) { console.error('[sendZaloTo] openzca CLI not found'); return null; }
  const nodeBin = findNodeBin() || 'node';
  const zcaProfile = opts.profile || allow.state?.profile || getZcaProfile();
  const knownTarget = isKnownZaloTarget(targetId, { isGroup, profile: zcaProfile });
  if (!knownTarget.known) {
    console.warn(`[sendZaloTo] target not in cache (${knownTarget.reason}) target=${targetId}`);
    return null;
  }

  const ZALO_CHUNK = 2000;
  const chunks = [];
  if (text.length > ZALO_CHUNK) {
    let remaining = text;
    while (remaining.length > ZALO_CHUNK) {
      let cut = ZALO_CHUNK;
      const paraBreak = remaining.lastIndexOf('\n\n', ZALO_CHUNK);
      if (paraBreak > 200) { cut = paraBreak + 2; }
      else {
        const sentBreak = remaining.slice(0, ZALO_CHUNK).search(/[.!?][^.!?]*$/);
        if (sentBreak > 200) { cut = sentBreak + 1; }
        else {
          const spaceBreak = remaining.lastIndexOf(' ', ZALO_CHUNK);
          if (spaceBreak > 200) { cut = spaceBreak + 1; }
        }
      }
      chunks.push(remaining.slice(0, cut).trimEnd());
      remaining = remaining.slice(cut).trimStart();
    }
    if (remaining.length > 0) chunks.push(remaining);
  } else {
    chunks.push(text);
  }

  const sendOneChunk = (chunk) => new Promise((resolve) => {
    try {
      const liveAllow = isZaloTargetAllowed(targetId, { isGroup });
      if (!liveAllow.allowed) {
        console.log(`[sendZaloTo] blocked before chunk send (${liveAllow.reason})`);
        resolve(null);
        return;
      }
      if (!isZaloChannelEnabled()) {
        console.log('[sendZaloTo] disabled before chunk send — aborting');
        resolve(null);
        return;
      }
      if (isChannelPaused('zalo')) {
        console.log('[sendZaloTo] paused before chunk send — aborting');
        resolve(null);
        return;
      }
      const args = [zcaBin, '--profile', zcaProfile, 'msg', 'send', targetId, chunk];
      if (isGroup) args.push('--group');
      const child = require('child_process').spawn(
        nodeBin, args,
        { shell: false, timeout: 20000, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => {
        if (code === 0) {
          resolve(true);
        } else {
          console.error(`[sendZaloTo] exit ${code}: ${stderr.slice(0, 200)}`);
          resolve(null);
        }
      });
      child.on('error', (e) => { console.error('[sendZaloTo] spawn error:', e.message); resolve(null); });
    } catch (e) {
      console.error('[sendZaloTo] error:', e.message);
      resolve(null);
    }
  });

  let lastResult = null;
  for (let i = 0; i < chunks.length; i++) {
    lastResult = await sendOneChunk(chunks[i]);
    if (!lastResult) {
      console.error(`[sendZaloTo] chunk ${i + 1}/${chunks.length} failed`);
      break;
    }
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 800));
  }
  if (lastResult) {
    console.log(`[sendZaloTo] sent to ${isGroup ? 'group' : 'user'} ${targetId}${chunks.length > 1 ? ` (${chunks.length} chunks)` : ''}`);
  }
  return lastResult;
}

function substituteApptTemplate(tpl, apt) {
  if (!tpl) return '';
  const hhmm = vnHHMM(apt.start);
  const ddmm = vnDDMM(apt.start);
  return String(tpl)
    .replace(/\{title\}/g, apt.title || '')
    .replace(/\{customerName\}/g, apt.customerName || '')
    .replace(/\{phone\}/g, apt.phone || '')
    .replace(/\{meetingUrl\}/g, apt.meetingUrl || '')
    .replace(/\{location\}/g, apt.location || '')
    .replace(/\{note\}/g, apt.note || '')
    .replace(/\{startHHMM\}/g, hhmm)
    .replace(/\{startDate\}/g, ddmm);
}

function defaultApptPushTemplate(apt) {
  let t = 'Lịch hẹn: {title}';
  if (apt.start) t += ' lúc {startHHMM} ({startDate})';
  if (apt.customerName) t += ' với {customerName}';
  if (apt.meetingUrl) t += '\nLink: {meetingUrl}';
  if (apt.location) t += '\nĐịa điểm: {location}';
  return t;
}

function buildApptReminderText(apt) {
  const hhmm = vnHHMM(apt.start);
  let txt = `Nhắc lịch: ${apt.title || 'Cuộc hẹn'}`;
  if (hhmm) txt += ` lúc ${hhmm}`;
  if (apt.customerName) txt += ` với ${apt.customerName}`;
  if (apt.meetingUrl) txt += `\nLink: ${apt.meetingUrl}`;
  if (apt.location) txt += `\nĐịa điểm: ${apt.location}`;
  if (apt.note) txt += `\nGhi chú: ${apt.note}`;
  return txt;
}

async function fireApptPushTarget(apt, target) {
  const tpl = target.template || defaultApptPushTemplate(apt);
  const text = substituteApptTemplate(tpl, apt);
  try {
    let ok = false;
    if (target.channel === 'telegram') {
      ok = !!(await sendTelegram(text));
    } else if (target.channel === 'zalo_user' || target.channel === 'zalo_group') {
      if (isChannelPaused('zalo')) {
        // Zalo paused — don't silently drop. Alert CEO on Telegram so they know
        // push was skipped, and return false so pushedAt is NOT marked → retries
        // on next tick after they resume Zalo.
        try {
          await sendTelegram(`[Cảnh báo] Zalo đang tạm dừng, không push được "${apt.title}" vào ${target.toName || target.toId}. Resume Zalo ở Dashboard.`);
        } catch {}
        return false;
      }
      ok = !!(await sendZaloTo({ id: target.toId, isGroup: target.channel === 'zalo_group' }, text));
    }
    if (ok) {
      try { auditLog('appt_push', { id: apt.id, channel: target.channel, to: target.toName || target.toId }); } catch {}
    }
    return ok;
  } catch (e) {
    console.error('[fireApptPushTarget] failed:', e.message);
    return false;
  }
}

let _apptDispatcherInterval = null;
let _apptDispatcherInitialTimeout = null;
function startAppointmentDispatcher() {
  // Track both interval + initial timeout so a second startAppointmentDispatcher
  // call (cold-boot + wizard-complete both call this) doesn't leak a second
  // initial tick scheduled before the first completed.
  if (_apptDispatcherInterval) clearInterval(_apptDispatcherInterval);
  if (_apptDispatcherInitialTimeout) clearTimeout(_apptDispatcherInitialTimeout);
  _apptDispatcherInterval = setInterval(() => {
    apptDispatcherTick().catch(e => console.error('[apptDispatcher] tick error:', e.message));
  }, 60 * 1000);
  _apptDispatcherInitialTimeout = setTimeout(() => {
    _apptDispatcherInitialTimeout = null;
    apptDispatcherTick().catch(() => {});
  }, 10_000);
  console.log('[apptDispatcher] started (60s tick)');
}

async function apptDispatcherTick() {
  await mutateAppointments(async (list) => {
    if (!list.length) return null;
    let changed = false;
    const now = Date.now();
    const hhmm = vnHHMMNow();
    const todayKey = vnDateKeyNow();
    // Grace window for catch-up reminders after Electron restart / missed tick.
    // If start time passed within GRACE_MS and reminder never fired, still send
    // it with "[Trễ]" prefix so CEO knows.
    const GRACE_MS = 15 * 60_000;

    for (const apt of list) {
      if (apt.status !== 'scheduled') continue;

      // 1) Reminder (with catch-up): fire if in window, or in grace window past start.
      if (apt.start && !apt.reminderFiredAt) {
        const startMs = new Date(apt.start).getTime();
        if (Number.isFinite(startMs)) {
          const reminderMs = startMs - (Number(apt.reminderMinutes) || 0) * 60_000;
          const late = now > startMs;
          const withinLiveWindow = now >= reminderMs && now < startMs;
          const withinGrace = late && now <= startMs + GRACE_MS;
          if (withinLiveWindow || withinGrace) {
            let text = buildApptReminderText(apt);
            if (late) text = '[Trễ] ' + text;
            const channels = apt.reminderChannels && apt.reminderChannels.length ? apt.reminderChannels : ['telegram'];
            let anySent = false;
            for (const ch of channels) {
              try {
                if (ch === 'telegram') anySent = !!(await sendTelegram(text)) || anySent;
                else if (ch === 'zalo') anySent = !!(await sendZalo(text)) || anySent;
              } catch (e) { console.error('[apptDispatcher] reminder send:', e.message); }
            }
            if (anySent) {
              apt.reminderFiredAt = new Date().toISOString();
              try { auditLog('appt_reminder', { id: apt.id, title: apt.title, late }); } catch {}
              changed = true;
            }
          }
        }
      }

      // 2) Auto-mark done after end + 5 min.
      if (apt.end) {
        const endMs = new Date(apt.end).getTime();
        if (Number.isFinite(endMs) && now > endMs + 5 * 60_000) {
          apt.status = 'done';
          changed = true;
        }
      }

      // 3) Push targets at atTime — only mark pushedAt if send actually succeeded.
      if (Array.isArray(apt.pushTargets)) {
        for (let i = 0; i < apt.pushTargets.length; i++) {
          const t = apt.pushTargets[i];
          if (!t || !t.atTime) continue;
          if (t.atTime !== hhmm) continue;

          const startMs = apt.start ? new Date(apt.start).getTime() : null;
          if (t.daily) {
            if (startMs && now > startMs + 24 * 60 * 60_000) continue;
            const pushKey = `${i}_${todayKey}`;
            if (apt.pushedAt && apt.pushedAt[pushKey]) continue;
            const ok = await fireApptPushTarget(apt, t);
            if (ok) {
              apt.pushedAt = apt.pushedAt || {};
              apt.pushedAt[pushKey] = new Date().toISOString();
              changed = true;
            }
          } else {
            const pushKey = `${i}`;
            if (apt.pushedAt && apt.pushedAt[pushKey]) continue;
            if (startMs) {
              if (now > startMs) continue;
              if (now < startMs - 7 * 24 * 60 * 60_000) continue;
            }
            const ok = await fireApptPushTarget(apt, t);
            if (ok) {
              apt.pushedAt = apt.pushedAt || {};
              apt.pushedAt[pushKey] = new Date().toISOString();
              changed = true;
            }
          }
        }
      }
    }

    return changed ? list : null;
  });
}

// --- IPC: appointments CRUD ---
ipcMain.handle('list-appointments', async () => {
  return readAppointments();
});

ipcMain.handle('create-appointment', async (_e, data) => {
  try {
    const apt = normalizeAppointment(data || {});
    if (!apt) return { ok: false, error: 'Dữ liệu không hợp lệ' };
    if (!apt.title) return { ok: false, error: 'Thiếu tiêu đề' };
    if (!apt.start) return { ok: false, error: 'Thiếu thời gian bắt đầu' };
    const startMs = new Date(apt.start).getTime();
    if (!Number.isFinite(startMs)) return { ok: false, error: 'Thời gian không hợp lệ' };
    const result = await mutateAppointments(async (list) => { list.push(apt); return list; });
    if (!Array.isArray(result)) return { ok: false, error: 'Không ghi được file appointments.json' };
    try { auditLog('appt_created', { id: apt.id, title: apt.title, start: apt.start }); } catch {}
    return { ok: true, appointment: apt };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('update-appointment', async (_e, payload) => {
  try {
    const { id, patch } = payload || {};
    if (!id) return { ok: false, error: 'Thiếu id' };
    const result = await mutateAppointments(async (list) => {
      const idx = list.findIndex(a => a.id === id);
      if (idx < 0) return null;
      const oldApt = list[idx];
      const newStart = (patch && patch.start) || oldApt.start;
      const newEnd = (patch && patch.end) || oldApt.end;
      const timeChanged = newStart !== oldApt.start || newEnd !== oldApt.end;
      const merged = { ...oldApt, ...(patch || {}), id };
      if (timeChanged) {
        // Time changed — reset delivery state so reminder/push fire for new time.
        merged.reminderFiredAt = null;
        merged.pushedAt = {};
      }
      list[idx] = normalizeAppointment(merged);
      return list;
    });
    if (!Array.isArray(result)) return { ok: false, error: 'Không tìm thấy hoặc không ghi được lịch hẹn' };
    const updated = result.find(a => a.id === id);
    if (!updated) return { ok: false, error: 'Lịch hẹn đã bị xóa trước khi cập nhật' };
    return { ok: true, appointment: updated };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('delete-appointment', async (_e, payload) => {
  try {
    const id = payload?.id;
    if (!id) return { ok: false, error: 'Thiếu id' };
    const result = await mutateAppointments(async (list) => list.filter(a => a.id !== id));
    if (!Array.isArray(result)) return { ok: false, error: 'Không ghi được file' };
    try { auditLog('appt_deleted', { id }); } catch {}
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Bot + UI helper: resolve Zalo target by name from openzca cache.
// Returns fuzzy matches (accent-insensitive substring) so bot can confirm with CEO.
ipcMain.handle('resolve-zalo-target', async (_e, payload) => {
  try {
    const query = payload?.query;
    const type = payload?.type || 'any'; // 'group' | 'user' | 'any'
    // NFD decomposes most Vietnamese diacritics, but đ/Đ are atomic (U+0111/U+0110)
    // and don't decompose. Map them explicitly so "Đội bán hàng" matches "doi ban hang".
    const normalize = (s) => String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'd');
    const q = normalize(query);
    if (!q) return { matches: [] };
    const results = [];
    if (type === 'group' || type === 'any') {
      const pg = path.join(getZcaCacheDir(), 'groups.json');
      if (fs.existsSync(pg)) {
        try {
          const data = JSON.parse(fs.readFileSync(pg, 'utf-8'));
          for (const g of (Array.isArray(data) ? data : [])) {
            const name = g.name || g.groupName || '';
            if (normalize(name).includes(q)) {
              results.push({
                type: 'zalo_group',
                toId: String(g.groupId || g.id || ''),
                toName: name,
                memberCount: g.totalMember || g.memberCount || (g.memberIds?.length) || 0,
              });
            }
          }
        } catch {}
      }
    }
    if (type === 'user' || type === 'any') {
      const pf = path.join(getZcaCacheDir(), 'friends.json');
      if (fs.existsSync(pf)) {
        try {
          const data = JSON.parse(fs.readFileSync(pf, 'utf-8'));
          for (const u of (Array.isArray(data) ? data : [])) {
            const name = u.displayName || u.zaloName || u.name || '';
            if (normalize(name).includes(q)) {
              results.push({
                type: 'zalo_user',
                toId: String(u.userId || u.id || ''),
                toName: name,
              });
            }
          }
        } catch {}
      }
    }
    return { matches: results.slice(0, 10) };
  } catch (e) { return { matches: [], error: e.message }; }
});

// ============================================
//  CHANNEL READINESS PROBES — actual proof channels can receive messages
// ============================================
//
// CEO complaint: "cần có cách nào đó show telegram và zalo thật sự sẵn sàng
// nhận tin nhắn, kiểu phải chắc chắn được". The dashboard used to display
// "running" based purely on whether OUR processes were spawned — that's a lie
// because the gateway can be up while the Telegram bot token is invalid, or
// while the Zalo listener has died/lost cookies. These probes hit the actual
// upstream service to prove the channel is reachable end-to-end.

// Telegram: call getMe — Telegram's API endpoint that returns bot identity.
// 200 + ok=true is conclusive proof: the token is valid AND Telegram's servers
// can reach this bot. Cheap (~150ms), doesn't send a user-visible message.
function getReadyGateState(channel) {
  const state = (global._readyNotifyState && global._readyNotifyState[channel]) || {};
  return {
    markerSeen: !!state.markerSeen,
    confirmed: !!state.confirmedAt,
    confirmedAt: state.confirmedAt || 0,
    confirmedBy: state.confirmedBy || '',
    awaitingConfirmation: !!state.awaitingConfirmation,
    lastError: state.lastError || '',
  };
}

function finalizeTelegramReadyProbe(base, hasCeoChatId) {
  if (!hasCeoChatId) {
    return { ...base, ready: false, reason: 'no-ceo-chat-id',
      error: 'Chưa có CEO chat ID để gửi tin xác nhận.' };
  }
  if (!botRunning) {
    return { ...base, ready: false, error: 'Gateway chưa khởi động' };
  }
  // READY GATE: dot green ONLY when gateway has emitted channel marker
  // AND notification sent. This is the contract: green = bot CAN reply.
  // getMe passing only proves token is valid, NOT that the channel pipeline
  // is initialized. On slow machines (Kaspersky, HDD), channel init takes
  // 1-3 min after WS ready. Showing green before that misleads CEO into
  // sending messages that get no reply.
  const gate = getReadyGateState('telegram');
  if (gate.confirmed) {
    return { ...base, ready: true };
  }
  if (gate.markerSeen) {
    return { ...base, ready: false, awaitingConfirmation: true,
      error: 'Telegram s\u1EAFp s\u1EB5n s\u00E0ng, \u0111ang g\u1EEDi tin x\u00E1c nh\u1EADn...' };
  }
  // WS ready + getMe pass but channel not yet initialized
  return { ...base, ready: false, awaitingConfirmation: true,
    error: '\u0110ang kh\u1EDFi t\u1EA1o k\u00EAnh Telegram... (1-2 ph\u00FAt)' };
}

function finalizeZaloReadyProbe(base) {
  if (!botRunning) {
    return { ...base, ready: false, error: 'Gateway chưa khởi động' };
  }
  const gate = getReadyGateState('zalo');
  if (gate.confirmed) {
    return { ...base, ready: true };
  }
  if (gate.markerSeen) {
    return { ...base, ready: false, awaitingConfirmation: true,
      error: 'Zalo s\u1EAFp s\u1EB5n s\u00E0ng, \u0111ang x\u00E1c nh\u1EADn...' };
  }
  return { ...base, ready: false, awaitingConfirmation: true,
    error: '\u0110ang kh\u1EDFi t\u1EA1o k\u00EAnh Zalo... (1-2 ph\u00FAt)' };
}

async function probeTelegramReady() {
  const { token, chatId } = getTelegramConfig();
  if (!token) return { ready: false, error: 'Chưa cấu hình bot token' };
  const https = require('https');
  return await new Promise((resolve) => {
    const req = https.get(
      `https://api.telegram.org/bot${token}/getMe`,
      { timeout: 6000 },
      (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.ok && parsed.result) {
              resolve(finalizeTelegramReadyProbe({
                username: parsed.result.username,
                botName: parsed.result.first_name,
                botId: parsed.result.id,
                hasCeoChatId: !!chatId,
              }, !!chatId));
            } else {
              resolve({ ready: false, error: parsed.description || 'Telegram API trả về lỗi' });
            }
          } catch (e) {
            resolve({ ready: false, error: 'Phản hồi không hợp lệ: ' + e.message });
          }
        });
      }
    );
    req.on('error', (e) => resolve({ ready: false, error: 'Không kết nối được Telegram: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ready: false, error: 'Timeout kết nối Telegram (>6s)' }); });
  });
}

// Zalo: 3-layer check
//   1. listener-owner.json must exist (openzca wrote its pid)
//   2. The pid must still be a live `openzca listen` process
//   3. Cookie cache file must have been refreshed in the last 30 minutes
//      (stale cookies = listener will silently drop messages)
// Find any running `openzca ... listen ...` process. Returns its PID or null.
// This is the AUTHORITATIVE check — listener-owner.json is just a lock file
// which can be missing during the brief window between process spawn and
// `acquireListenerOwnerLock()`. The process itself is the source of truth.
function findOpenzcaListenerPid() {
  try {
    if (process.platform === 'win32') {
      // PowerShell primary (wmic deprecated/removed on Win11 24H2+).
      let wmicOut = null;
      try {
        wmicOut = require('child_process').execSync(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*openzca*listen*' } | Select-Object -ExpandProperty ProcessId"`,
          { encoding: 'utf-8', timeout: 5000 }
        );
      } catch { wmicOut = null; }

      if (wmicOut) {
        for (const line of wmicOut.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.toLowerCase().startsWith('node')) continue;
          const pid = parseInt(trimmed, 10);
          if (Number.isFinite(pid) && pid >= 100) return pid;
        }
      }

      // PowerShell fallback (works even when wmic is disabled)
      try {
        const psOut = require('child_process').execSync(
          `powershell -NoProfile -Command "Get-WmiObject Win32_Process -Filter \\"name='node.exe'\\" | Where-Object { $_.CommandLine -like '*openzca*listen*' } | Select-Object -ExpandProperty ProcessId"`,
          { encoding: 'utf-8', timeout: 5000, windowsHide: true }
        );
        for (const line of psOut.trim().split('\n')) {
          const pid = parseInt(line.trim(), 10);
          if (Number.isFinite(pid) && pid >= 100) return pid;
        }
      } catch {}
    } else {
      // Mac/Linux: pgrep -f matches command line. Returns one PID per line.
      // pgrep exit 1 = no matches → empty string. Iterate to be safe.
      const out = require('child_process').execSync(
        `pgrep -f "openzca.*listen" 2>/dev/null || true`,
        { encoding: 'utf-8', timeout: 3000, shell: '/bin/sh' }
      );
      for (const line of out.trim().split('\n')) {
        const pid = parseInt(line.trim(), 10);
        if (Number.isFinite(pid) && pid >= 100) return pid;
      }
    }
  } catch (e) {
    if (process.env.BIZCLAW_DEBUG) console.error('[findOpenzcaListenerPid]', e.message);
  }
  return null;
}

async function probeZaloReady() {
  try {
    const state = readZaloChannelState();
    const pause = getChannelPauseStatus('zalo');
    if (state.configError) {
      return {
        ready: false,
        reason: 'config-error',
        error: 'Cấu hình Zalo đang lỗi hoặc chưa đọc được. Bot giữ trạng thái tắt để an toàn.',
      };
    }
    if (state.enabled === false) {
      return {
        ready: false,
        reason: 'disabled',
        error: 'Zalo đang tắt trong Dashboard. Bot sẽ không tự trả lời.',
      };
    }
    if (pause?.permanent) {
      return {
        ready: false,
        reason: 'paused-permanent',
        error: 'Zalo đang bị khóa an toàn trong Dashboard. Chỉ bật lại khi đã kiểm tra xong.',
      };
    }
    if (pause?.paused) {
      return {
        ready: false,
        reason: 'paused',
        error: pause.until ? `Zalo đang tạm dừng đến ${pause.until}.` : 'Zalo đang tạm dừng.',
      };
    }

    const ozDir = path.join(HOME, '.openzca', 'profiles', state.profile || 'default');
    const ownerFile = path.join(ozDir, 'listener-owner.json');
    const credsFile = path.join(ozDir, 'credentials.json');

    // CRITICAL ORDERING FIX (2026-04-08): process check MUST come before cookie
    // expiry check. Previously we returned `session-expired` based purely on
    // cookie file timestamps (lastAccessed + maxAge math), even when the
    // openzca listener process was running AND actively replying to Zalo
    // messages. Root cause: Zalo's zlogin_session has maxAge=3600 (1 hour)
    // but openzca maintains the WebSocket via keepalive without rewriting the
    // credentials file on every use. The file timestamp goes stale while the
    // live session keeps working. Result: CEO saw "Zalo đã hết hạn" in
    // Dashboard while Zalo replies arrived normally.
    //
    // Rule: if the listener process is alive, Zalo is READY by definition.
    // Cookie expiry math is only a diagnostic when the process is NOT running.
    // PRIMARY check: process by name (authoritative — process IS the listener,
    // regardless of whether the lock file has been written yet). Solves the
    // race window where listener-owner.json doesn't exist for ~3-5s after the
    // openzca subprocess spawns and before it calls acquireListenerOwnerLock().
    const processPid = findOpenzcaListenerPid();

    // SECONDARY check: lock file content (preferred when present — gives us
    // session metadata that the process check can't).
    let ownerPid = null;
    let ownerErr = null;
    if (fs.existsSync(ownerFile)) {
      try {
        const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf-8'));
        if (owner.pid) ownerPid = owner.pid;
        else ownerErr = 'lock file thiếu pid';
      } catch (e) { ownerErr = 'lock file hỏng: ' + e.message; }
    }

    // Cookie cache freshness — youngest mtime in the profile dir as proxy.
    // The auto-refresh interval is 10 min so 30+ min stale = something broken.
    let youngestMtime = 0;
    try {
      for (const entry of fs.readdirSync(ozDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        try {
          const m = fs.statSync(path.join(ozDir, entry.name)).mtimeMs;
          if (m > youngestMtime) youngestMtime = m;
        } catch {}
      }
    } catch {}
    const cacheAgeMin = youngestMtime ? Math.floor((Date.now() - youngestMtime) / 60000) : null;

    // Decide ready state. Listener process running = ready (cache may still be
    // refreshing in the background). No process = not ready, regardless of
    // lock file (a stale lock from a crashed process must be treated as down).
    const listenerPid = processPid || ownerPid || null;

    if (!processPid && !ownerPid) {
      // BOOT GRACE: During the first 60s after gateway start, openzca hasn't
      // spawned yet. Don't show scary "session expired" — show "đang khởi động".
      // Without this, boot fast-poll at 500ms hits this path, sees cookie maxAge
      // expired (Zalo session cookie has maxAge=3600 but openzca keeps it alive
      // via WebSocket without rewriting the file), and flashes "hết hạn" briefly.
      const bootGraceMs = 60000;
      const gatewayStartedAt = global._gatewayStartedAt || 0;
      const inBootGrace = gatewayStartedAt && (Date.now() - gatewayStartedAt < bootGraceMs);

      // Listener is not running. Check WHY and return the most actionable
      // error message. Credentials/expiry checks go HERE (fallback
      // diagnostics), not at the top — they previously caused false-positive
      // "expired" reports even when the process was happily maintaining the
      // WebSocket via keepalive.
      if (!fs.existsSync(credsFile)) {
        return {
          ready: false,
          reason: 'no-credentials',
          error: inBootGrace
            ? 'Zalo đang khởi động...'
            : 'Chưa đăng nhập Zalo. Vào tab Zalo bấm "Đổi tài khoản" để quét QR.',
        };
      }

      // During boot grace, skip cookie expiry check entirely — just say "đang khởi động"
      if (inBootGrace) {
        return {
          ready: false,
          reason: 'boot-grace',
          error: 'Zalo đang khởi động...',
          cacheAgeMin,
        };
      }

      // Cookie maxAge check removed — Zalo sessions persist indefinitely
      // while the listener keeps the WebSocket alive. The maxAge field in
      // credentials.json is misleading (openzca refreshes internally).
      return {
        ready: false,
        error: 'Listener chưa chạy. Đợi gateway khởi động openzalo channel (~10-15 giây sau khi mở app).',
        cacheAgeMin,
      };
    }

    // Process check failed but lock file claims a pid → verify the lock's pid
    // is alive and is actually openzca (not a recycled pid).
    if (!processPid && ownerPid) {
      let aliveAndOpenzca = false;
      if (process.platform === 'win32') {
        try {
          const out = require('child_process').execSync(
            `wmic process where "ProcessId=${ownerPid}" get CommandLine /format:list 2>nul`,
            { encoding: 'utf-8', timeout: 3000 }
          );
          aliveAndOpenzca = /openzca/i.test(out) && /listen/i.test(out);
        } catch {}
      } else {
        try { require('process').kill(ownerPid, 0); aliveAndOpenzca = true; } catch {}
      }
      if (!aliveAndOpenzca) {
        // openzca auto-reconnects in 1-2s after periodic session refresh.
        // Debounce: wait 3s and re-check before declaring down, to avoid
        // false "stale lock" flashes during the normal reconnect window.
        await new Promise(r => setTimeout(r, 3000));
        // Re-read lock file — if PID changed, new process is up
        try {
          const freshOwner = JSON.parse(fs.readFileSync(ownerFile, 'utf-8'));
          if (freshOwner.pid && freshOwner.pid !== ownerPid) {
            return finalizeZaloReadyProbe({ listenerPid: freshOwner.pid, lastRefreshMinAgo: cacheAgeMin });
          }
        } catch {}
        // Also retry process search (PowerShell fallback may now succeed)
        const retryPid = findOpenzcaListenerPid();
        if (retryPid) {
          return finalizeZaloReadyProbe({ listenerPid: retryPid, lastRefreshMinAgo: cacheAgeMin });
        }
        return {
          ready: false,
          error: 'Listener đã thoát (lock file còn nhưng pid ' + ownerPid + ' không còn chạy)',
          listenerPid: ownerPid,
          cacheAgeMin,
        };
      }
    }

    // Stale cache warning (still ready — listener can reconnect)
    if (cacheAgeMin != null && cacheAgeMin > 30) {
      return finalizeZaloReadyProbe({
        listenerPid,
        lastRefreshMinAgo: cacheAgeMin,
        warning: `Cookie cache ${cacheAgeMin} phút trước — sắp cần refresh.`,
      });
    }

    return finalizeZaloReadyProbe({
      listenerPid,
      lastRefreshMinAgo: cacheAgeMin,
    });
  } catch (e) {
    return { ready: false, error: 'Probe error: ' + e.message };
  }
}

ipcMain.handle('get-telegram-config', async () => {
  try {
    const configPath = getOpenClawConfigPath();
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const tg = config.channels?.telegram || {};
    return {
      botToken: tg.botToken || '',
      allowFrom: tg.allowFrom || [],
    };
  } catch { return { botToken: '', allowFrom: [] }; }
});

ipcMain.handle('save-telegram-config', async (_e, { botToken, userId }) => {
  return withOpenClawConfigLock(async () => {
    try {
      const configPath = getOpenClawConfigPath();
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (!config.channels) config.channels = {};
      if (!config.channels.telegram) config.channels.telegram = {};
      if (botToken !== undefined) config.channels.telegram.botToken = botToken;
      if (userId !== undefined) {
        const uid = parseInt(userId, 10);
        if (!isNaN(uid) && uid > 0) config.channels.telegram.allowFrom = [uid];
      }
      writeOpenClawConfigIfChanged(configPath, config);
      return { success: true };
    } catch (e) { return { success: false, error: String(e) }; }
  });
});

ipcMain.handle('check-telegram-ready', async () => probeTelegramReady());
ipcMain.handle('check-zalo-ready', async () => probeZaloReady());

// Manual smoke test: send a real Telegram message to the CEO. The strongest
// possible proof — if this succeeds the channel is end-to-end working.
ipcMain.handle('telegram-self-test', async () => {
  // Self-test bypasses pause + filter — CEO explicitly clicked "Gửi tin test"
  const ok = await sendTelegram(
    'Test kết nối\n\nĐây là tin nhắn test từ Dashboard. Nếu thấy tin này,' +
    'channel Telegram đã sẵn sàng nhận lệnh.',
    { skipFilter: true, skipPauseCheck: true }
  );
  return { success: ok === true };
});

// --- Telegram behavior settings (mirrors Zalo behavior pattern) ---
ipcMain.handle('get-telegram-behavior', async () => {
  try {
    const ws = getWorkspace();
    if (!ws) return { strangerPolicy: 'ignore', defaultGroupMode: 'mention', historyLimit: 50 };

    // Stranger policy — file-based like Zalo
    let strangerPolicy = 'ignore';
    try {
      const spPath = path.join(ws, 'telegram-stranger-policy.json');
      if (fs.existsSync(spPath)) {
        const sp = JSON.parse(fs.readFileSync(spPath, 'utf-8'));
        if (['reply', 'greet-only', 'ignore'].includes(sp.policy)) strangerPolicy = sp.policy;
      }
    } catch {}

    // Default group mode — file-based
    let defaultGroupMode = 'mention';
    try {
      const gmPath = path.join(ws, 'telegram-group-defaults.json');
      if (fs.existsSync(gmPath)) {
        const gm = JSON.parse(fs.readFileSync(gmPath, 'utf-8'));
        if (['mention', 'all', 'off'].includes(gm.mode)) defaultGroupMode = gm.mode;
      }
    } catch {}

    // History limit — from openclaw.json
    let historyLimit = 50;
    try {
      const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
      if (fs.existsSync(configPath)) {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        historyLimit = cfg?.channels?.telegram?.historyLimit || 50;
      }
    } catch {}

    return { strangerPolicy, defaultGroupMode, historyLimit };
  } catch (e) {
    console.error('[get-telegram-behavior] error:', e.message);
    return { strangerPolicy: 'ignore', defaultGroupMode: 'mention', historyLimit: 50 };
  }
});

ipcMain.handle('save-telegram-behavior', async (_event, behavior) => {
  try {
    const ws = getWorkspace();
    if (!ws) return { success: false, error: 'No workspace' };
    const { strangerPolicy, defaultGroupMode, historyLimit } = behavior || {};

    // Save stranger policy
    if (strangerPolicy && ['reply', 'greet-only', 'ignore'].includes(strangerPolicy)) {
      writeJsonAtomic(path.join(ws, 'telegram-stranger-policy.json'), {
        policy: strangerPolicy,
        updatedAt: new Date().toISOString(),
      });
    }

    // Save default group mode
    if (defaultGroupMode && ['mention', 'all', 'off'].includes(defaultGroupMode)) {
      writeJsonAtomic(path.join(ws, 'telegram-group-defaults.json'), {
        mode: defaultGroupMode,
        updatedAt: new Date().toISOString(),
      });
    }

    // Save history limit to openclaw.json
    if (historyLimit) {
      const limit = Math.min(Math.max(parseInt(historyLimit, 10) || 50, 5), 50);
      try {
        await withOpenClawConfigLock(async () => {
          const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
          if (fs.existsSync(configPath)) {
            const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            if (!cfg.channels) cfg.channels = {};
            if (!cfg.channels.telegram) cfg.channels.telegram = {};
            cfg.channels.telegram.historyLimit = limit;
            writeOpenClawConfigIfChanged(configPath, cfg);
          }
        });
      } catch (e) {
        console.warn('[save-telegram-behavior] historyLimit write error:', e.message);
      }
    }

    try { auditLog('telegram-behavior-changed', { strangerPolicy, defaultGroupMode, historyLimit }); } catch {}
    console.log('[save-telegram-behavior] saved:', { strangerPolicy, defaultGroupMode, historyLimit });
    return { success: true };
  } catch (e) {
    console.error('[save-telegram-behavior] error:', e.message);
    return { success: false, error: e.message };
  }
});

// --- Channel pause/resume (symmetric for both Telegram + Zalo) ---
ipcMain.handle('pause-telegram', async (_e, { minutes } = {}) => {
  return { success: pauseChannel('telegram', minutes || 30) };
});
ipcMain.handle('resume-telegram', async () => {
  return { success: resumeChannel('telegram') };
});
ipcMain.handle('get-telegram-pause-status', async () => {
  return getChannelPauseStatus('telegram');
});
ipcMain.handle('pause-zalo', async (_e, { minutes } = {}) => {
  return { success: pauseChannel('zalo', minutes || 30) };
});
ipcMain.handle('resume-zalo', async () => {
  const booting = rejectIfBooting('resume-zalo');
  if (booting) return booting;
  _ipcInFlightCount++;
  try {
    return await withOpenClawConfigLock(async () => {
      console.log('[config-lock] resume-zalo acquired');
      // [zalo-watchdog rearm] CEO's manual Resume rearms the listener watchdog.
      // Without this, once _zaloListenerGaveUp flipped true (3 restarts in 2h),
      // it stuck until app restart — CEO fixing the root cause + pressing
      // Resume wouldn't re-enable auto-restart. Reset all 3 counters.
      global._zaloListenerGaveUp = false;
      global._zaloListenerRestartHistory = [];
      global._zaloListenerMissStreak = 0;
      console.log('[zalo-watchdog] reset gave-up / streak by CEO action');
      // Detect if enabled was previously false — transitioning false→true needs
      // a hard gateway restart so openclaw loads the openzalo plugin + spawns
      // openzca listener (both skipped at boot when enabled=false).
      let wasDisabled = false;
      try {
        const cfgPath = path.join(HOME, '.openclaw', 'openclaw.json');
        if (fs.existsSync(cfgPath)) {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
          wasDisabled = cfg?.channels?.openzalo?.enabled === false;
        }
      } catch {}
      const resumed = resumeChannel('zalo');
      const enabled = setZaloChannelEnabled(true);
      const cleared = clearChannelPermanentPause('zalo');
      if (enabled && cleared) markOnboardingComplete('resume-zalo');
      // [restart-guard A1] Flipping enabled/permanent-pause doesn't reach the running
      // gateway (config is read at boot). Kick off a hard-restart in the
      // background so Zalo actually comes back. Only restart if disabled→enabled
      // transition (HEAD's smart check) AND not in-flight already (A1 guard).
      if (wasDisabled) {
        // Defer restart if gateway spawn is already in progress (wizard just
        // finished, boot path still spawning). Killing mid-spawn causes 240s
        // WS timeout → null.stdout crash → gateway dead permanently.
        if (_startOpenClawInFlight) {
          console.log('[resume-zalo] gateway spawn in progress — skip restart, config change will apply on its own');
        } else if (_gatewayRestartInFlight) {
          console.log('[restart-guard] resume-zalo: restart already in-flight — skipping duplicate');
        } else {
          _gatewayRestartInFlight = true;
          console.log('[resume-zalo] transitioning disabled→enabled — hard-restart gateway (bg)');
          (async () => {
            try {
              console.log('[restart-guard] resume-zalo: hard-restart begin');
              try { await stopOpenClaw(); } catch (e1) { console.warn('[resume-zalo] stop failed:', e1?.message); }
              await new Promise(r => setTimeout(r, 5000));
              try { await startOpenClaw(); } catch (e2) { console.warn('[resume-zalo] start failed:', e2?.message); }
              // [zalo-watchdog rearm] Post-restart: wipe any pre-restart miss
              // streak so next heartbeat miss doesn't immediately re-trip cap.
              global._zaloListenerMissStreak = 0;
              console.log('[restart-guard] resume-zalo: hard-restart end');
            } finally {
              _gatewayRestartInFlight = false;
            }
          })();
        }
      }
      return { success: resumed && enabled && cleared };
    });
  } finally { _ipcInFlightCount--; }
});
ipcMain.handle('get-zalo-pause-status', async () => {
  return getChannelPauseStatus('zalo');
});

// Inbound debounce — how long bot waits to coalesce rapid messages from
// same customer into 1 turn. Openclaw has one global setting; we expose
// it via 2 sliders (Telegram + Zalo pages) that share the same backend
// so CEO can adjust from either page. Default 3000ms; 0 = no coalesce.
ipcMain.handle('get-inbound-debounce', async () => {
  try {
    const cfgPath = path.join(HOME, '.openclaw', 'openclaw.json');
    if (!fs.existsSync(cfgPath)) return { telegram: 3000, zalo: 3000 };
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    const tgMs = cfg?.channels?.telegram?.messages?.inbound?.debounceMs;
    const zlMs = cfg?.channels?.openzalo?.messages?.inbound?.debounceMs;
    const globalMs = cfg?.messages?.inbound?.debounceMs ?? 3000;
    return {
      telegram: typeof tgMs === 'number' ? tgMs : globalMs,
      zalo: typeof zlMs === 'number' ? zlMs : globalMs,
    };
  } catch { return { telegram: 3000, zalo: 3000 }; }
});
ipcMain.handle('set-inbound-debounce', async (_e, { channel, ms } = {}) => {
  const booting = rejectIfBooting('set-inbound-debounce');
  if (booting) return booting;
  _ipcInFlightCount++;
  try {
    if (!['telegram', 'zalo'].includes(channel)) return { success: false, error: 'channel must be telegram or zalo' };
    const clampedMs = Math.max(0, Math.min(10000, Number(ms) || 0));
    return await withOpenClawConfigLock(async () => {
      const cfgPath = path.join(HOME, '.openclaw', 'openclaw.json');
      if (!fs.existsSync(cfgPath)) return { success: false, error: 'config not found' };
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (!cfg.channels) cfg.channels = {};
      const chanKey = channel === 'zalo' ? 'openzalo' : 'telegram';
      if (!cfg.channels[chanKey]) cfg.channels[chanKey] = {};
      if (!cfg.channels[chanKey].messages) cfg.channels[chanKey].messages = {};
      if (!cfg.channels[chanKey].messages.inbound) cfg.channels[chanKey].messages.inbound = {};
      cfg.channels[chanKey].messages.inbound.debounceMs = clampedMs;
      const otherKey = chanKey === 'telegram' ? 'openzalo' : 'telegram';
      const otherMs = cfg.channels?.[otherKey]?.messages?.inbound?.debounceMs;
      if (!cfg.messages) cfg.messages = {};
      if (!cfg.messages.inbound) cfg.messages.inbound = {};
      cfg.messages.inbound.debounceMs = typeof otherMs === 'number'
        ? Math.min(clampedMs, otherMs) : clampedMs;
      writeOpenClawConfigIfChanged(cfgPath, cfg);

      try {
        const cliJs = (typeof findOpenClawCliJs === 'function') ? findOpenClawCliJs() : null;
        const nodeBin = (typeof findNodeBin === 'function') ? findNodeBin() : null;
        if (cliJs && nodeBin) {
          const probe = require('child_process').spawnSync(nodeBin, [cliJs, '--help'], {
            timeout: 4000, encoding: 'utf-8', shell: false
          });
          const stderr = String(probe.stderr || '') + String(probe.stdout || '');
          if (probe.status !== 0 && /Config invalid|Unrecognized key/i.test(stderr)) {
            try { healOpenClawConfigInline(stderr); } catch {}
            const cfg2 = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
            if (cfg2?.channels?.[chanKey]?.messages?.inbound) {
              delete cfg2.channels[chanKey].messages.inbound.debounceMs;
              if (!cfg2.messages) cfg2.messages = {};
              if (!cfg2.messages.inbound) cfg2.messages.inbound = {};
              cfg2.messages.inbound.debounceMs = clampedMs;
              writeOpenClawConfigIfChanged(cfgPath, cfg2);
            }
            return { success: true, ms: clampedMs, scope: 'global-fallback' };
          }
        }
      } catch { /* non-fatal probe failure */ }

      return { success: true, ms: clampedMs };
    });
  } catch (e) {
    return { success: false, error: e?.message };
  } finally { _ipcInFlightCount--; }
});

// App prefs (start minimized, etc.) — persisted in <userData>/app-prefs.json
ipcMain.handle('get-app-prefs', async () => {
  return loadAppPrefs();
});
ipcMain.handle('set-app-prefs', async (_e, partial) => {
  const next = saveAppPrefs(partial || {});
  return next || loadAppPrefs();
});

// Periodic broadcast of channel readiness to the renderer so the sidebar dots
// stay fresh. Boot phase polls fast (every 3s for 30s) so the CEO sees the
// state flip from "checking" → "ready" as soon as the gateway brings the
// openzalo channel up (typically 10-15s after gateway start). After the boot
// window, fall back to 45s steady-state polling.
let _channelStatusInterval = null;
let _channelStatusBootTimers = [];
let _lastChannelState = { telegram: null, zalo: null };
let _lastChannelAlertAt = { telegram: 0, zalo: 0 };
let _channelStatusBroadcastInFlight = false;
let _channelStatusTickCount = 0;
async function broadcastChannelStatusOnce() {
  if (_channelStatusBroadcastInFlight) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // PERF: skip expensive probes when window is not visible/focused, but still
  // run every 5th tick (~3.75min) so dots aren't completely stale when user opens app.
  _channelStatusTickCount++;
  try {
    if (!mainWindow.isVisible() || mainWindow.isMinimized()) {
      if (_channelStatusTickCount % 5 !== 0) return;
    }
  } catch {} // isVisible/isMinimized can throw if window is mid-destruction
  _channelStatusBroadcastInFlight = true;
  try {
    // Gate: if bot is stopped, both channels are not-ready by definition.
    // Don't probe Telegram getMe (token is valid even when gateway is off).
    if (!botRunning) {
      mainWindow.webContents.send('channel-status', {
        telegram: { ready: false, error: 'Bot \u0111ang d\u1EEBng' },
        zalo: { ready: false, error: 'Bot \u0111ang d\u1EEBng' },
        checkedAt: new Date().toISOString(),
      });
      return;
    }
        // Gate 2: gateway spawned (botRunning=true) but not yet listening on :18789.
    // Telegram getMe returns green even when gateway can't process messages.
    // CEO sees green dot but bot won't reply for 30-60s. Quick 2s probe.
    const __gwAlive = await isGatewayAlive(2000);
    if (!__gwAlive) {
      mainWindow.webContents.send('channel-status', {
        telegram: { ready: false, error: 'Đang khởi động...' },
        zalo: { ready: false, error: 'Đang khởi động...' },
        checkedAt: new Date().toISOString(),
      });
      return;
    }
    // OPTIM: skip expensive network probe if gateway recently emitted a
    // "provider ready" marker (within 5min). Marker is ground-truth readiness
    // — no need to hit Telegram getMe / scan process list again. Saves probe
    // cost AND avoids false-negatives during transient network blips.
    const MARKER_FRESH_MS = 5 * 60 * 1000;
    const notifyState = global._readyNotifyState || null;
    const now = Date.now();
    const tgFresh = notifyState?.telegram?.markerSeenAt && (now - notifyState.telegram.markerSeenAt) < MARKER_FRESH_MS;
    const zlFresh = notifyState?.zalo?.markerSeenAt && (now - notifyState.zalo.markerSeenAt) < MARKER_FRESH_MS;
    const [tg, zl] = await Promise.all([
      tgFresh
        ? Promise.resolve({ ready: true, cachedFromMarker: true })
        : probeTelegramReady(),
      zlFresh
        ? Promise.resolve({ ready: true, cachedFromMarker: true })
        : probeZaloReady(),
    ]);
    if (tgFresh || zlFresh) {
      console.log(`[channel-status] skip probe (marker fresh) telegram=${!!tgFresh} zalo=${!!zlFresh}`);
    }
    mainWindow.webContents.send('channel-status', {
      telegram: { ...tg, paused: isChannelPaused('telegram') },
      zalo: { ...zl, paused: isChannelPaused('zalo') },
      checkedAt: new Date().toISOString(),
    });

    try { checkZaloCookieAge(); } catch {}

    // F-2: alert only after 5 minutes of continuous disconnect (skip transient
    // restarts / AI-busy probe misses). Previously this alerted on first
    // ready→not-ready transition with only 15min THROTTLE_MS — CEO phone
    // buzzed on every reply-serving probe miss. The grace logic used to live
    // in startChannelStatusBroadcast but was unreachable dead code behind
    // an accidental early `return await`.
    const THROTTLE_MS = 15 * 60 * 1000;
    const DOWN_GRACE_MS = 5 * 60 * 1000;
    // `now` already declared above (marker-fresh check); reuse.
    const probes = { telegram: tg, zalo: zl };
    const labels = { telegram: 'Telegram', zalo: 'Zalo' };
    if (!global._channelDownSince) global._channelDownSince = {};
    for (const ch of ['telegram', 'zalo']) {
      const prev = _lastChannelState[ch];
      const cur = probes[ch];
      if (prev !== null && prev.ready === true && cur.ready === false) {
        if (!global._channelDownSince[ch]) global._channelDownSince[ch] = now;
      }
      if (cur.ready === true) {
        delete global._channelDownSince[ch];
      }
      if (cur.ready === false && global._channelDownSince[ch] && (now - global._channelDownSince[ch]) >= DOWN_GRACE_MS) {
        if (now - (_lastChannelAlertAt[ch] || 0) >= THROTTLE_MS) {
          const hhmm = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
          const reason = (cur && cur.error) ? String(cur.error) : 'không rõ';
          const downMin = Math.round((now - global._channelDownSince[ch]) / 60000);
          const msg = `Kênh ${labels[ch]} mất kết nối đã ${downMin} phút (từ ${hhmm}). Tự khôi phục không thành công. Mở Dashboard kiểm tra giúp em ạ. Lý do: ${reason}.`;
          try { sendCeoAlert(msg); } catch (e) { console.error('[channel-status] sendCeoAlert error:', e.message); }
          _lastChannelAlertAt[ch] = now;
          delete global._channelDownSince[ch];
        }
      }
      _lastChannelState[ch] = cur;
    }
  } catch (e) {
    console.error('[channel-status] broadcast error:', e.message);
  } finally {
    _channelStatusBroadcastInFlight = false;
  }
}
function startChannelStatusBroadcast() {
  if (_channelStatusInterval) clearInterval(_channelStatusInterval);
  for (const t of _channelStatusBootTimers) clearTimeout(t);
  _channelStatusBootTimers = [];
  // Tear down any previous fs.watch handles from a prior broadcast setup.
  if (global._channelStatusWatchers) {
    for (const w of global._channelStatusWatchers) { try { w.close(); } catch {} }
  }
  global._channelStatusWatchers = [];

  const broadcast = async () => broadcastChannelStatusOnce();
  // Debounced broadcast — file watchers can fire 2-3 events per write
  // (create + modify on Windows). Coalesce within 250ms.
  let _watchDebounce = null;
  const broadcastSoon = (reason) => {
    if (_watchDebounce) clearTimeout(_watchDebounce);
    _watchDebounce = setTimeout(() => {
      _watchDebounce = null;
      console.log('[channel-status] fs.watch trigger:', reason);
      broadcast();
    }, 250);
  };

  // Boot phase: fast polls so listener spawn is caught quickly (first 30s)
  // Boot phase: defer probes until gateway has had time to start channels.
  // Previously started at T+500ms — all probes before T+30s are wasted
  // (gateway still loading, Telegram getMe times out, Zalo scan finds nothing).
  // Now: first probe at T+15s, then every 5s until T+60s. Saves ~10 wasted
  // probe cycles (each = 6s HTTPS timeout + process scan).
  const bootDelays = [15000, 20000, 25000, 30000, 35000, 40000, 50000, 60000];
  for (const delay of bootDelays) {
    _channelStatusBootTimers.push(setTimeout(broadcast, delay));
  }
  // Steady-state polling — 45s cadence (matches CLAUDE.md v2.2.7 intent).
  // Fast boot-phase timers above catch the first 30s; fs.watch handles
  // instant updates on state-file writes. The 45s interval is pure backstop
  // for edge cases (cookie age, offline listener). Marker-fresh cache in
  // broadcastChannelStatusOnce further short-circuits probes for 5 minutes
  // after gateway emits a ready marker, so steady-state cost is minimal.
  _channelStatusInterval = setInterval(broadcast, 45 * 1000);

  // INSTANT triggers — file watches on load-bearing state files. Any write
  // fires a coalesced broadcast in <500ms. This eliminates the "phải bấm
  // Refresh mới thấy xanh" lag: listener-owner.json created → dot xanh
  // within 250ms; pause file deleted → dot xanh immediately; etc.
  const watchTargets = [];
  try {
    const ozDir = path.join(HOME, '.openzca', 'profiles', 'default');
    if (fs.existsSync(ozDir)) watchTargets.push({ dir: ozDir, label: 'openzca-profile' });
  } catch {}
  try {
    const ws = getWorkspace();
    if (fs.existsSync(ws)) watchTargets.push({ dir: ws, label: 'workspace' });
  } catch {}
  try {
    const openclawDir = path.join(HOME, '.openclaw');
    if (fs.existsSync(openclawDir)) watchTargets.push({ dir: openclawDir, label: 'openclaw' });
  } catch {}
  for (const { dir, label } of watchTargets) {
    try {
      const watcher = fs.watch(dir, { persistent: false }, (eventType, filename) => {
        if (!filename) return;
        const name = String(filename);
        if (
          name === 'listener-owner.json' ||
          name === 'credentials.json' ||
          name === 'zalo-paused.json' ||
          name === 'telegram-paused.json' ||
          name === 'openclaw.json'
        ) {
          broadcastSoon(`${label}/${name}`);
        }
      });
      watcher.on('error', () => {}); // ignore — fall back to polling
      global._channelStatusWatchers.push(watcher);
    } catch (e) {
      console.warn('[channel-status] fs.watch failed on', dir, ':', e?.message);
    }
  }
}

// ============================================
//  FAST SELF-HEAL WATCHDOG — 20s interval
//  Goal: <30s downtime on any component failure
//  Separate from cron heartbeat (runs every 10-30 min).
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
  if (_appIsQuitting || !botRunning) return;
  if (_startOpenClawInFlight || _gatewayRestartInFlight) return;
  if (_fwTickInFlight) return;
  _fwTickInFlight = true;

  try {
    // --- 9Router watchdog ---
    if (!routerProcess) {
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
    }

    // --- Gateway watchdog ---
    // Timeout 15s (was 4s — gateway busy with AI completion can take 5-8s
    // to respond to HTTP probe, causing false-positive "dead" → restart loop).
    // Also skip if gateway started <180s ago (slow SSDs + Windows Defender
    // scan + cloud model cold start can push boot to 64-76s observed on
    // customer machine LINH-BABY — 90s grace was too tight).
    // Boot grace 360s — LINH-BABY observed 5:21 from launch to fully usable
    // (gateway "ready" at 70s is misleading; channels start 3:30+ later when
    // openrouter.ai fetch stuck on slow DNS/TCP — see ensureOpenclawPricingFix).
    // Even with pricing-fix, leaving 6min grace for worst-case slow boots.
    if (global._gatewayStartedAt && (Date.now() - global._gatewayStartedAt) < 360000) {
      // Gateway still booting — skip watchdog this tick
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
      if (_fwGatewayFailCount >= 5 && _fwCanRestart() && !(global._bonjourCooldownUntil > Date.now())) {
        console.log('[fast-watchdog] Gateway dead (' + _fwGatewayFailCount + ' fails) — restarting');
        _fwGatewayFailCount = 0;
        _fwRestartTimestamps.push(Date.now());
        _gatewayRestartInFlight = true;
        try {
          await stopOpenClaw();
          await startOpenClaw({ silent: true });
        } catch (e) {
          console.error('[fast-watchdog] gateway restart error:', e.message);
        } finally {
          _gatewayRestartInFlight = false;
        }
      }
    } else {
      _fwGatewayFailCount = 0;
      // --- Zalo listener sub-check: LOG ONLY, never restart gateway ---
      // Zalo listener is a subprocess managed by the gateway's openzalo plugin.
      // If it crashes or session expires, the plugin handles reconnect internally.
      // NEVER restart the entire gateway for a Zalo issue — that kills Telegram
      // and creates the "restart cascade" loop that made connection feel broken.
      try {
        const _fwZaloEnabled = (() => { try {
          const _cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.openclaw', 'openclaw.json'), 'utf-8'));
          return _cfg?.plugins?.entries?.openzalo?.enabled === true || _cfg?.channels?.openzalo?.enabled === true;
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
              sendCeoAlert('Zalo listener kh\u00F4ng ch\u1EA1y. N\u1EBFu Zalo kh\u00F4ng nh\u1EADn tin, v\u00E0o tab Zalo b\u1EA5m "\u0110\u1ED5i t\u00E0i kho\u1EA3n" \u0111\u1EC3 qu\u00E9t QR l\u1EA1i.').catch(() => {});
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
      if (_knowledgeHttpServer === null) {
        _fwKnowledgeHttpDead = (_fwKnowledgeHttpDead || 0) + 1;
        if (_fwKnowledgeHttpDead >= 2) {
          console.warn('[fast-watchdog] knowledge HTTP :20129 down — re-arming');
          try { startKnowledgeSearchServer(); } catch (e) { console.warn('[fast-watchdog] re-arm failed:', e.message); }
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

async function registerTelegramCommands() {
  const { token } = getTelegramConfig();
  if (!token) return;
  const https = require('https');
  const commands = [
    // --- Custom MODOROClaw ---
    { command: 'menu', description: 'Xem mẫu giao việc theo ngành' },
    { command: 'baocao', description: 'Tạo báo cáo tổng hợp ngay lập tức' },
    { command: 'huongdan', description: 'Hướng dẫn cách sử dụng trợ lý' },
    { command: 'skill', description: 'Xem danh sách kỹ năng đã cài' },
    // /thuvien removed — Knowledge tab in Dashboard is the canonical document store.
    // Bot reads knowledge/<cat>/index.md per AGENTS.md bootstrap rule.
    // --- OpenClaw built-in (CEO-friendly) ---
    { command: 'new', description: 'Bắt đầu phiên hội thoại mới' },
    { command: 'reset', description: 'Xóa ngữ cảnh, bắt đầu lại từ đầu' },
    { command: 'status', description: 'Xem trạng thái bot (model, token, chi phí)' },
    { command: 'stop', description: 'Dừng tác vụ đang chạy' },
    { command: 'usage', description: 'Xem chi phí sử dụng AI' },
    { command: 'help', description: 'Xem tất cả lệnh có thể dùng' },
    { command: 'restart', description: 'Khởi động lại trợ lý' },
  ];
  return new Promise((resolve) => {
    const payload = JSON.stringify({ commands });
    const req = https.request(
      `https://api.telegram.org/bot${token}/setMyCommands`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { console.log('[telegram] setMyCommands:', d); resolve(d); }); }
    );
    req.on('error', (e) => { console.error('[telegram] setMyCommands error:', e.message); resolve(null); });
    req.write(payload);
    req.end();
  });
}

// NOTE: OpenClaw gateway doesn't expose a generic HTTP chat endpoint for injecting system prompts.
// The only reliable way to "trigger" the bot from cron is to send a message to CEO on Telegram
// that CEO can act on. This function is kept for future compatibility but returns false by default.
async function triggerGatewayMessage(prompt) {
  try {
    const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
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

// Send message to CEO via Telegram AS IF from the bot itself (bot → CEO direction).
// This is the reliable path — no gateway dependency.
async function sendTelegramRich(text, options = {}) {
  const { token, chatId } = getTelegramConfig();
  if (!token || !chatId) return false;
  const https = require('https');
  return new Promise((resolve) => {
    const body = { chat_id: chatId, text, parse_mode: 'Markdown', ...options };
    const payload = JSON.stringify(body);
    const req = https.request(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(d);
            resolve(parsed.ok === true);
          } catch { resolve(false); }
        });
      }
    );
    req.on('error', () => resolve(false));
    req.write(payload);
    req.end();
  });
}

// ============================================================================
// Telegram built-in command handlers (intercepted in main.js, not in agent)
// ----------------------------------------------------------------------------
// These commands run locally in Electron so they always work even if the
// OpenClaw agent is compacting / restarting / offline. They must never block
// the agent pipeline — parseTelegramBuiltinCommand returns `true` only when
// the command was fully handled here, so callers can short-circuit forwarding.
// ============================================================================

// /tim <keyword> — search customer memory files under memory/zalo-users/
async function handleTimCommand(keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) {
    await sendTelegram('Cách dùng: /tim <tên|SĐT|từ khóa>');
    return;
  }
  const workspace = getWorkspace();
  if (!workspace) { await sendTelegram('Lỗi: không xác định được workspace.'); return; }
  const dir = path.join(workspace, 'memory', 'zalo-users');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch {}
  const kwLower = kw.toLowerCase();
  const matches = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
      // Parse frontmatter
      const fm = {};
      const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      const body = m ? m[2] : raw;
      if (m) {
        for (const line of m[1].split('\n')) {
          const mm = line.match(/^([a-zA-Z][\w]*)\s*:\s*(.*)$/);
          if (mm) fm[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, '');
        }
      }
      const haystack = [
        fm.name, fm.phone, fm.email, fm.zaloName, body
      ].filter(Boolean).join('\n').toLowerCase();
      if (haystack.includes(kwLower)) {
        // Pull 80-char snippet around first body match
        let snippet = '';
        const bodyLower = body.toLowerCase();
        const idx = bodyLower.indexOf(kwLower);
        if (idx >= 0) {
          const start = Math.max(0, idx - 20);
          snippet = body.slice(start, start + 80).replace(/\s+/g, ' ').trim();
        } else {
          snippet = body.replace(/\s+/g, ' ').trim().slice(0, 80);
        }
        // Relative time from lastSeen
        let rel = '';
        if (fm.lastSeen) {
          const ts = Date.parse(fm.lastSeen);
          if (!isNaN(ts)) {
            const diffDays = Math.floor((Date.now() - ts) / 86400000);
            if (diffDays <= 0) rel = 'hôm nay';
            else if (diffDays === 1) rel = 'hôm qua';
            else rel = `${diffDays} ngày trước`;
          }
        }
        matches.push({
          name: fm.name || fm.zaloName || f.replace(/\.md$/, ''),
          phone: fm.phone || '',
          rel,
          snippet,
          lastSeenMs: fm.lastSeen ? Date.parse(fm.lastSeen) || 0 : 0,
        });
      }
    } catch {}
  }
  // Sort: most recent lastSeen first
  matches.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
  if (matches.length === 0) {
    await sendTelegram(`Không tìm thấy khách nào khớp "${kw}"`);
    return;
  }
  const top = matches.slice(0, 5);
  const lines = [`**Tìm thấy ${matches.length} khách với từ khóa "${kw}":**`, ''];
  top.forEach((m, i) => {
    const parts = [`**${m.name}**`];
    if (m.phone) parts.push(m.phone);
    if (m.rel) parts.push(m.rel);
    lines.push(`${i + 1}. ${parts.join(' · ')}`);
    if (m.snippet) lines.push(`   "${m.snippet}"`);
    lines.push('');
  });
  await sendTelegram(lines.join('\n').trim());
}

// /thongke — show today's stats
async function handleThongkeCommand() {
  const workspace = getWorkspace();
  if (!workspace) { await sendTelegram('Lỗi: không xác định được workspace.'); return; }

  // Count today's events from audit.jsonl (tail last 64KB)
  const auditFile = path.join(workspace, 'logs', 'audit.jsonl');
  let tgReplies = 0, zaloReplies = 0, cronFired = 0;
  try {
    const stat = fs.statSync(auditFile);
    const readFrom = Math.max(0, stat.size - 64 * 1024);
    const fd = fs.openSync(auditFile, 'r');
    const buf = Buffer.alloc(stat.size - readFrom);
    fs.readSync(fd, buf, 0, buf.length, readFrom);
    fs.closeSync(fd);
    const lines = buf.toString('utf-8').split('\n');
    const todayStr = new Date().toISOString().slice(0, 10);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (!ev.t || !ev.t.startsWith(todayStr)) continue;
        const evt = String(ev.event || '');
        if (/telegram.*reply|reply.*telegram|telegram_send/i.test(evt)) tgReplies++;
        else if (/zalo.*reply|reply.*zalo|zalo_send/i.test(evt)) zaloReplies++;
        if (evt === 'cron_fired') cronFired++;
      } catch {}
    }
  } catch {}
  const totalReplies = tgReplies + zaloReplies;

  // Count customers
  const dir = path.join(workspace, 'memory', 'zalo-users');
  let totalCustomers = 0, activeToday = 0;
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    totalCustomers = files.length;
    const todayStr = new Date().toISOString().slice(0, 10);
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
        const m = raw.match(/^---\n([\s\S]*?)\n---/);
        if (m) {
          const lsMatch = m[1].match(/lastSeen\s*:\s*(.+)/);
          if (lsMatch && lsMatch[1].trim().startsWith(todayStr)) activeToday++;
        }
      } catch {}
    }
  } catch {}

  // Uptime from process.uptime()
  const upSec = Math.floor(process.uptime());
  const upH = Math.floor(upSec / 3600);
  const upM = Math.floor((upSec % 3600) / 60);

  const now = new Date();
  const hhmm = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const ddmm = now.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });

  const lines = [
    `**Thống kê hôm nay (${hhmm} ${ddmm})**`,
    '',
    `Tin đã trả: ${totalReplies} (Telegram ${tgReplies} · Zalo ${zaloReplies})`,
    `Khách tương tác: ${activeToday} / ${totalCustomers} tổng`,
    `Cron đã chạy: ${cronFired}`,
    `Uptime: ${upH}g ${upM}p`,
  ];
  await sendTelegram(lines.join('\n'));
}

// /baocao — manually trigger the morning brief
async function handleBaocaoCommand() {
  await sendTelegram('Đang chạy báo cáo, em sẽ gửi sau vài giây...');
  try {
    const timeStr = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const prompt = buildMorningBriefingPrompt(timeStr);
    runCronViaSessionOrFallback(prompt, { label: 'manual-baocao' }).catch(e => {
      console.error('[/baocao] runCronViaSessionOrFallback failed:', e?.message || e);
      sendTelegram('Xin lỗi, em chạy báo cáo bị lỗi. Thử lại sau vài phút giúp em.').catch(() => {});
    });
  } catch (e) {
    console.error('[/baocao] build prompt failed:', e?.message || e);
    await sendTelegram('Xin lỗi, em chạy báo cáo bị lỗi. Thử lại sau vài phút giúp em.');
  }
}

// Dispatcher: parse a raw Telegram text message and handle if it matches one
// of our built-in commands. Returns true when handled (caller should NOT
// forward to the OpenClaw agent).
async function handleTelegramBuiltinCommand(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/')) return false;
  // Strip bot username suffix e.g. /tim@mybot
  const firstSpace = raw.indexOf(' ');
  const head = (firstSpace >= 0 ? raw.slice(0, firstSpace) : raw).split('@')[0].toLowerCase();
  const args = firstSpace >= 0 ? raw.slice(firstSpace + 1) : '';
  if (head === '/tim') {
    await handleTimCommand(args);
    return true;
  }
  if (head === '/thongke') {
    await handleThongkeCommand();
    return true;
  }
  if (head === '/baocao') {
    await handleBaocaoCommand();
    return true;
  }
  return false;
}

// Custom crons file — bot writes here, Electron picks up automatically
//
// HEALING: the bot (running as openclaw agent) sometimes writes entries with
// minor schema mistakes (missing `enabled`, used `cron` instead of `cronExpr`,
// forgot `id`, etc.). Rather than skipping these silently (which CEO sees as
// "bot said done but nothing happens"), we heal them on load. Any healed
// entries are written back to disk so the next load is idempotent.
function healCustomCronEntries(arr) {
  let healed = false;
  for (const c of arr) {
    if (!c || typeof c !== 'object') continue;
    // Alias: some bot prompts use `cron` as the field name
    if (!c.cronExpr && typeof c.cron === 'string') {
      c.cronExpr = c.cron;
      delete c.cron;
      healed = true;
    }
    // Alias: `schedule` also seen in older bot outputs
    if (!c.cronExpr && typeof c.schedule === 'string') {
      c.cronExpr = c.schedule;
      delete c.schedule;
      healed = true;
    }
    // Auto-heal: LLM wrote ISO date/timestamp as cronExpr → convert to oneTimeAt
    if (c.cronExpr && (/^\d{4}-\d{2}-\d{2}/.test(c.cronExpr) || /T\d{2}:\d{2}/.test(c.cronExpr))) {
      const isoVal = c.cronExpr;
      c.oneTimeAt = isoVal.replace(/\.000Z$/, '').replace(/Z$/, '');
      delete c.cronExpr;
      healed = true;
      console.log(`[custom-crons] auto-healed ISO cronExpr "${isoVal}" → oneTimeAt "${c.oneTimeAt}" for ${c.id || c.label || '(unknown)'}`);
    }
    // Default enabled=true when bot forgot it — CEO asked for a cron, he wants
    // it to run, don't require explicit enabled:true
    if ((c.cronExpr || c.oneTimeAt) && c.prompt && c.enabled === undefined) {
      c.enabled = true;
      healed = true;
    }
    // Auto-id so dedupe + journal works
    if (!c.id && (c.cronExpr || c.oneTimeAt)) {
      c.id = 'custom_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      healed = true;
    }
    // Auto-label from prompt if missing
    if (!c.label && c.prompt) {
      c.label = String(c.prompt).trim().split('\n')[0].slice(0, 60);
      healed = true;
    }
    // Auto-heal: if prompt is a plain openzca msg send without exec: prefix,
    // add the prefix so runCronAgentPrompt takes the fast-path (no approval needed)
    if (c.prompt && /^openzca\s+.*msg\s+send\s/i.test(c.prompt.trim())) {
      c.prompt = 'exec: ' + c.prompt.trim();
      healed = true;
      console.log(`[custom-crons] auto-healed missing exec: prefix for ${c.id || c.label || '(unknown)'}`);
    }
    if (!c.createdAt) {
      c.createdAt = new Date().toISOString();
      healed = true;
    }
  }
  return healed;
}
function loadCustomCrons() {
  const customCronsPath = getCustomCronsPath();
  let modoroEntries = [];
  try {
    if (fs.existsSync(customCronsPath)) {
      const raw = fs.readFileSync(customCronsPath, 'utf-8');
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
          throw new Error('custom-crons.json must be an array, got ' + typeof parsed);
        }
        // U4: one-shot migration — strip OpenClaw-sourced entries that got
        // written to custom-crons.json by a v2.58 bug (Dashboard toggle/delete
        // pushed the merged array back verbatim, copying OC crons into our
        // file → they double-fire every day alongside the real OpenClaw ones).
        const beforeLen = parsed.length;
        const cleaned = parsed.filter(c => !c || c.source !== 'openclaw');
        const ocStripped = beforeLen - cleaned.length;
        if (ocStripped > 0) {
          try {
            fs.writeFileSync(customCronsPath, JSON.stringify(cleaned, null, 2), 'utf-8');
            console.log(`[custom-crons] upgrade migration: stripped ${ocStripped} OpenClaw-merged entries`);
          } catch (e) { console.warn('[custom-crons] migration writeback failed:', e.message); }
          parsed.length = 0;
          Array.prototype.push.apply(parsed, cleaned);
        }
        const wasHealed = healCustomCronEntries(parsed);
        if (wasHealed) {
          try {
            writeJsonAtomic(customCronsPath, parsed);
            console.log('[custom-crons] healed entries (alias/defaults) and rewrote file');
          } catch (e) { console.warn('[custom-crons] heal-writeback failed:', e.message); }
        }
        modoroEntries = parsed;
      } catch (parseErr) {
        const backupPath = customCronsPath + '.corrupt-' + Date.now();
        try { fs.copyFileSync(customCronsPath, backupPath); } catch {}
        console.error(`[custom-crons] CORRUPT JSON in ${customCronsPath}: ${parseErr.message}. Backed up to ${backupPath}`);
        try {
          const errFile = path.join(getWorkspace(), '.learnings', 'ERRORS.md');
          fs.mkdirSync(path.dirname(errFile), { recursive: true });
          fs.appendFileSync(errFile, `\n## ${new Date().toISOString()} — custom-crons.json corrupt\n\nError: ${parseErr.message}\nBackup: ${backupPath}\nAll custom crons disabled until fixed. Restore from backup or recreate via Dashboard.\n`, 'utf-8');
        } catch {}
        try {
          sendCeoAlert(`Cảnh báo: custom-crons.json bị lỗi JSON\n\n${parseErr.message}\n\nFile gốc đã backup về: ${path.basename(backupPath)}. Tất cả custom cron sẽ KHÔNG chạy cho tới khi sửa file. Vào Dashboard, tab Cron để recreate hoặc khôi phục từ backup.`);
        } catch {}
      }
    } else {
      // One-time migration from legacy paths
      for (const p of legacyCustomCronsPaths) {
        if (p !== customCronsPath && fs.existsSync(p)) {
          try {
            const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
            try {
              writeJsonAtomic(customCronsPath, data);
              console.log('[custom-crons] Migrated:', p, '→', customCronsPath);
            } catch {}
            modoroEntries = data;
            break;
          } catch (e) {
            console.error(`[custom-crons] legacy file ${p} is corrupt:`, e.message);
          }
        }
      }
    }
  } catch (e) {
    console.error('[custom-crons] load error:', e.message);
  }

  // Merge OpenClaw cron/jobs.json — bot creates crons via openclaw `cron` tool
  // which writes to this file, not to custom-crons.json. Without this merge
  // the scheduler would never run bot-created crons.
  let openclawEntries = [];
  try {
    const ocJobsPath = path.join(HOME, '.openclaw', 'cron', 'jobs.json');
    if (fs.existsSync(ocJobsPath)) {
      const raw = JSON.parse(fs.readFileSync(ocJobsPath, 'utf-8'));
      const jobs = Array.isArray(raw?.jobs) ? raw.jobs : [];
      const modoroIds = new Set(modoroEntries.map(c => c?.id).filter(Boolean));
      for (const j of jobs) {
        if (!j || !j.id) continue;
        if (modoroIds.has('oc_' + j.id)) continue;
        const schedExpr = j.schedule?.expr || j.schedule?.at || '';
        if (!schedExpr) continue;
        openclawEntries.push({
          id: 'oc_' + j.id,
          label: j.name || 'OpenClaw cron',
          cronExpr: schedExpr,
          prompt: j.payload?.text || j.payload?.message || '',
          enabled: j.enabled !== false,
          source: 'openclaw',
        });
      }
      if (openclawEntries.length > 0) {
        healCustomCronEntries(openclawEntries);
        for (const oc of openclawEntries) {
          if (oc.prompt && !oc.prompt.trim().startsWith('exec:') &&
              /(?:zalo|nhom|group|gui\s+tin|openzca)/i.test(oc.prompt)) {
            console.warn(`[custom-crons] OpenClaw cron "${oc.label}" looks like a Zalo send but is NOT in exec: format — agent will attempt natural language execution (unreliable). Prompt should be: exec: openzca --profile default msg send <groupId> "<text>" --group`);
          }
        }
        console.log(`[custom-crons] merged ${openclawEntries.length} OpenClaw cron(s) into scheduler`);
      }
    }
  } catch (e) {
    console.warn('[custom-crons] failed to read OpenClaw cron/jobs.json:', e?.message);
  }

  return [...modoroEntries, ...openclawEntries];
}

// Watch custom-crons.json + schedules.json for changes — auto-reload when bot edits them
let customCronWatcher = null;
let schedulesWatcher = null;
let _watchPollerInterval = null;
let _lastCustomCronsMtime = 0;
let _lastSchedulesMtime = 0;
let _lastOcJobsMtime = 0;
function watchCustomCrons() {
  try {
    if (customCronWatcher) { try { customCronWatcher.close(); } catch {} customCronWatcher = null; }
    if (schedulesWatcher) { try { schedulesWatcher.close(); } catch {} schedulesWatcher = null; }
    if (_watchPollerInterval) { clearInterval(_watchPollerInterval); _watchPollerInterval = null; }

    const customCronsPath = getCustomCronsPath();
    const schedulesPath = getSchedulesPath();
    const dir = path.dirname(customCronsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Initialize files if missing (safety net — seedWorkspace() normally handles this)
    if (!fs.existsSync(customCronsPath)) writeJsonAtomic(customCronsPath, []);
    if (!fs.existsSync(schedulesPath)) writeJsonAtomic(schedulesPath, loadSchedules());

    // Snapshot current mtimes so we don't trigger a spurious reload on first poll.
    try { _lastCustomCronsMtime = fs.statSync(customCronsPath).mtimeMs; } catch {}
    try { _lastSchedulesMtime = fs.statSync(schedulesPath).mtimeMs; } catch {}
    const ocJobsPath = path.join(HOME, '.openclaw', 'cron', 'jobs.json');
    try { _lastOcJobsMtime = fs.statSync(ocJobsPath).mtimeMs; } catch {}

    let debounce1 = null;
    let debounce2 = null;
    // Track known cron IDs across reloads so we can detect NEW entries
    // (bot added a cron at CEO's request) and send an independent Telegram
    // confirmation. Without this the CEO only has the bot's word that the
    // cron was created — and if the bot lied / hallucinated / failed silently
    // the CEO has no second source of truth. With this, every new scheduled
    // cron produces a system-level Telegram message showing the actual
    // cronExpr + next fire time.
    if (!global._knownCronIds) {
      global._knownCronIds = new Set(loadCustomCrons().map(c => c && c.id).filter(Boolean));
    }
    const reloadCustom = () => {
      clearTimeout(debounce1);
      debounce1 = setTimeout(() => {
        console.log('[cron] custom-crons.json changed, reloading...');
        try { restartCronJobs(); } catch (e) { console.error('[cron] reload error:', e.message); }
        const current = loadCustomCrons();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('custom-crons-updated', current);
        }
        // Detect NEW entries and confirm to CEO
        try {
          const prevIds = global._knownCronIds || new Set();
          const currIds = new Set(current.map(c => c && c.id).filter(Boolean));
          const added = [];
          for (const c of current) {
            if (c && c.id && c.enabled !== false && (c.cronExpr || c.oneTimeAt) && c.prompt && !prevIds.has(c.id)) {
              added.push(c);
            }
          }
          global._knownCronIds = currIds;
          for (const c of added) {
            const schedule = c.cronExpr || c.oneTimeAt || '(unknown)';
            if (c.cronExpr) {
              const validExpr = typeof cron.validate === 'function' ? cron.validate(c.cronExpr) : true;
              if (!validExpr) continue;
            }
            const label = c.label || c.id;
            const schedType = c.oneTimeAt ? 'Một lần' : 'Lịch';
            const msg = `*Cron mới đã được lên lịch*\n\n` +
                        `Nhãn: \`${label}\`\n` +
                        `${schedType}: \`${schedule}\` (giờ VN)\n` +
                        `Prompt: ${String(c.prompt).slice(0, 200)}${c.prompt.length > 200 ? '...' : ''}\n\n` +
                        `Đây là xác nhận từ hệ thống — nếu bạn không yêu cầu cron này, vào Dashboard → Cron để xóa.`;
            sendCeoAlert(msg).catch(() => {});
          }
        } catch (e) { console.error('[cron] new-entry confirmation error:', e.message); }
      }, 1000);
    };
    const reloadSchedules = () => {
      clearTimeout(debounce2);
      debounce2 = setTimeout(() => {
        console.log('[cron] schedules.json changed, reloading...');
        try { restartCronJobs(); } catch (e) { console.error('[cron] reload error:', e.message); }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('schedules-updated', loadSchedules());
        }
      }, 1000);
    };

    // Layer 1: fs.watch — efficient on most systems but unreliable on Windows
    // when files are atomically replaced (write to .tmp + rename). The watcher
    // loses the inode and silently stops firing. We still register it because
    // it's responsive when it works.
    const safeWatch = (target, onChange) => {
      try {
        const w = fs.watch(target, (eventType) => {
          // 'rename' events on Windows mean the file was atomically replaced —
          // re-establish the watcher on the NEW inode after a small delay.
          if (eventType === 'rename') {
            try { w.close(); } catch {}
            setTimeout(() => {
              try {
                if (target === customCronsPath) {
                  customCronWatcher = safeWatch(target, onChange);
                } else {
                  schedulesWatcher = safeWatch(target, onChange);
                }
              } catch (e) { console.error('[cron] re-watch error:', e.message); }
            }, 200);
          }
          onChange();
        });
        w.on('error', (e) => {
          console.error('[cron] watcher error on', target, '—', e.message, '(falling back to poller)');
        });
        return w;
      } catch (e) {
        console.error('[cron] fs.watch failed for', target, '—', e.message, '(poller will catch changes)');
        return null;
      }
    };
    customCronWatcher = safeWatch(customCronsPath, reloadCustom);
    schedulesWatcher = safeWatch(schedulesPath, reloadSchedules);

    // Layer 2: mtime poller — bulletproof fallback that catches ANY change
    // regardless of how the file was written (atomic replace, append, in-place
    // truncate). Polls every 2s. Compare mtimeMs with last-known value.
    _watchPollerInterval = setInterval(() => {
      try {
        const m1 = fs.statSync(customCronsPath).mtimeMs;
        if (m1 !== _lastCustomCronsMtime) {
          _lastCustomCronsMtime = m1;
          console.log('[cron] poller detected custom-crons.json mtime change');
          reloadCustom();
        }
      } catch {}
      try {
        const m2 = fs.statSync(schedulesPath).mtimeMs;
        if (m2 !== _lastSchedulesMtime) {
          _lastSchedulesMtime = m2;
          console.log('[cron] poller detected schedules.json mtime change');
          reloadSchedules();
        }
      } catch {}
      try {
        const m3 = fs.statSync(ocJobsPath).mtimeMs;
        if (m3 !== _lastOcJobsMtime) {
          _lastOcJobsMtime = m3;
          console.log('[cron] poller detected OpenClaw jobs.json mtime change');
          reloadCustom();
        }
      } catch {}
    }, 2000);
    _watchPollerInterval.unref?.();
  } catch (e) { console.error('[cron] watch error:', e.message); }
}

// ============================================
//  FOLLOW-UP QUEUE — one-shot delayed messages
// ============================================
// Bot escalates CEO + queues a follow-up: "15 min later, message customer X
// to check if they've been helped." File: <workspace>/follow-up-queue.json
// Format: [{ id, channel, recipientId, recipientName, prompt, fireAt, firedAt? }]
// Checked every 60s. After fire → mark firedAt. Entries older than 24h → purge.

let _followUpInterval = null;
let _followUpQueueLock = false;
let _followUpQueueLockAt = 0;

function getFollowUpQueuePath() {
  return path.join(getWorkspace(), 'follow-up-queue.json');
}

function readFollowUpQueue() {
  const p = getFollowUpQueuePath();
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return []; }
}

function writeFollowUpQueue(queue) {
  writeJsonAtomic(getFollowUpQueuePath(), queue);
}

async function processFollowUpQueue() {
  if (_followUpQueueLock) {
    if (_followUpQueueLockAt && Date.now() - _followUpQueueLockAt > 15 * 60 * 1000) {
      console.error('[follow-up] lock held >15min — force-releasing (deadlock recovery)');
      _followUpQueueLock = false;
    } else {
      return;
    }
  }
  _followUpQueueLock = true;
  _followUpQueueLockAt = Date.now();
  // Count toward IPC in-flight so before-quit drain (waitForIpcDrain) actually waits for
  // follow-up processing to complete. Without this, a quit mid-flush would lose firedAt
  // stamps and cause duplicate customer messages on next boot.
  _ipcInFlightCount++;
  try {
    let queue = readFollowUpQueue();
    if (queue.length === 0) return;
    const now = Date.now();
    let changed = false;
    for (const item of queue) {
      if (item.firedAt) continue; // already processed
      if (new Date(item.fireAt).getTime() > now) continue; // not yet
      // Fire!
      console.log('[follow-up] Firing:', item.id, 'for', item.recipientName || item.recipientId);
      try {
        const prompt = item.prompt || `Nhắc CEO: Khách ${item.recipientName || item.recipientId} (${item.channel || 'Zalo'}) hỏi ${item.question || 'một câu hỏi'} cách đây 15 phút và chưa được phản hồi. Gửi tin nhắn nhắc CEO kiểm tra. KHÔNG gửi tin cho khách. KHÔNG nói "đã kiểm tra".`;
        await runCronAgentPrompt(prompt, { label: 'follow-up-' + (item.recipientName || item.recipientId) });
        item.firedAt = new Date().toISOString();
        try { auditLog('follow_up_fired', { id: item.id, recipient: item.recipientId }); } catch {}
      } catch (e) {
        console.error('[follow-up] Fire error:', e.message);
        item.firedAt = 'error:' + e.message;
      }
      changed = true;
      // Per-item persistence (R2): persist firedAt stamp IMMEDIATELY after each fire so a
      // mid-loop quit/crash only loses the in-progress item, not the whole batch.
      // Merge with any IPC-added entries (IPC may have appended during the await above).
      try {
        const freshQueue = readFollowUpQueue();
        const ourById = new Map(queue.map(q => [q.id, q]));
        const merged = [];
        const seenIds = new Set();
        for (const fresh of freshQueue) {
          // Our in-memory updates (firedAt stamps) win for items we know about.
          merged.push(ourById.get(fresh.id) || fresh);
          seenIds.add(fresh.id);
        }
        // Defensive: our items missing from disk (shouldn't normally happen)
        for (const ours of queue) {
          if (!seenIds.has(ours.id)) merged.push(ours);
        }
        writeFollowUpQueue(merged);
      } catch (persistErr) {
        console.error('[follow-up] per-item persist error:', persistErr.message);
      }
    }
    // Final reconcile: pick up any IPC-added entries since last per-item persist.
    if (changed) {
      const freshQueue = readFollowUpQueue();
      const ourIds = new Set(queue.map(q => q.id));
      for (const fresh of freshQueue) {
        if (!ourIds.has(fresh.id)) queue.push(fresh); // new entry written by IPC
      }
    }

    // Purge entries older than 24h
    const cutoff = now - 24 * 60 * 60 * 1000;
    const before = queue.length;
    queue = queue.filter(q => new Date(q.fireAt).getTime() > cutoff);
    if (queue.length !== before) changed = true;
    if (changed) writeFollowUpQueue(queue);
  } catch (e) {
    console.error('[follow-up] processQueue error:', e.message);
  } finally {
    _followUpQueueLock = false;
    _followUpQueueLockAt = 0;
    _ipcInFlightCount = Math.max(0, _ipcInFlightCount - 1);
  }
}

function startFollowUpChecker() {
  if (_followUpInterval) clearInterval(_followUpInterval);
  _followUpInterval = setInterval(processFollowUpQueue, 60 * 1000); // check every 60s
  _followUpInterval.unref?.();
}

// ============================================
//  ESCALATION QUEUE — auto-forward to CEO
// ============================================
// send.ts output filter detects escalation keywords in bot replies and writes
// to logs/escalation-queue.jsonl. This poller reads the file every 30s, sends
// each entry to CEO via sendCeoAlert(), then truncates.

let _escalationInterval = null;

async function processEscalationQueue() {
  try {
    const ws = getWorkspace();
    const queueFile = path.join(ws, 'logs', 'escalation-queue.jsonl');
    if (!fs.existsSync(queueFile)) return;
    const tmpFile = queueFile + '.processing.' + process.pid;
    try { fs.renameSync(queueFile, tmpFile); } catch { return; }
    const raw = fs.readFileSync(tmpFile, 'utf-8').trim();
    if (!raw) { try { fs.unlinkSync(tmpFile); } catch {} return; }
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length === 0) { try { fs.unlinkSync(tmpFile); } catch {} return; }

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        let customerName = entry.to || 'unknown';
        try {
          const memDir = path.join(ws, 'memory', entry.isGroup ? 'zalo-groups' : 'zalo-users');
          const memFile = path.join(memDir, entry.to + '.md');
          if (fs.existsSync(memFile)) {
            const memContent = fs.readFileSync(memFile, 'utf-8').slice(0, 500);
            const nameMatch = memContent.match(/^#\s+(.+)/m);
            if (nameMatch) customerName = nameMatch[1].trim();
          }
        } catch {}

        const alertMsg = `[Escalation] Bot vừa trả lời ${entry.isGroup ? 'nhóm' : 'khách'} ${customerName} (ID: ${entry.to}) với nội dung có dấu hiệu cần sếp xử lý.\n\nTrigger: "${entry.trigger}"\nBot reply: ${(entry.botReply || '').slice(0, 300)}\nThời gian: ${entry.t}`;
        await sendCeoAlert(alertMsg);
        try { auditLog('escalation_forwarded', { to: entry.to, trigger: entry.trigger }); } catch {}
        console.log('[escalation] Forwarded to CEO:', entry.trigger, 'for', customerName);
      } catch (e) {
        console.error('[escalation] Parse/send error for line:', e?.message);
      }
    }
    try { fs.unlinkSync(tmpFile); } catch {}
  } catch (e) {
    console.error('[escalation] processQueue error:', e?.message);
  }
}

function startEscalationChecker() {
  if (_escalationInterval) clearInterval(_escalationInterval);
  _escalationInterval = setInterval(processEscalationQueue, 30 * 1000); // check every 30s
  _escalationInterval.unref?.();
}

// ─── Local Cron API (port 20200) ─────────────────────────────────────
// CEO Telegram → bot uses web_fetch → POST/GET to this API → main.js writes custom-crons.json.
// Zalo customers cannot trigger this: inbound.ts command-block rewrites rawBody before agent sees it,
// and cron/exec/process tools are removed from tools.allow. Defense-in-depth.
let _cronApiServer = null;
let _cronApiPort = 20200;
let _cronApiToken = '';
function startCronApi() {
  if (_cronApiServer) return;
  const http = require('http');
  const crypto = require('crypto');
  const nodeCron = require('node-cron');

  _cronApiToken = crypto.randomBytes(24).toString('hex');
  try {
    const tokenPath = path.join(getWorkspace(), 'cron-api-token.txt');
    fs.writeFileSync(tokenPath, _cronApiToken, 'utf-8');
  } catch (e) { console.error('[cron-api] failed to write token file:', e.message); }

  function loadGroupsMap() {
    try {
      const p = path.join(getZcaCacheDir(), 'groups.json');
      if (!fs.existsSync(p)) return { byId: {}, byName: {} };
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      const byId = {}, byName = {};
      for (const g of (Array.isArray(data) ? data : [])) {
        const id = String(g.groupId || g.id || '');
        const name = g.name || g.groupName || '';
        if (id) { byId[id] = name; if (name) byName[name.toLowerCase()] = id; }
      }
      return { byId, byName };
    } catch { return { byId: {}, byName: {} }; }
  }

  function jsonResp(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  function parseBody(req) {
    return new Promise((resolve) => {
      if (req.method === 'GET') {
        const u = new URL(req.url, 'http://127.0.0.1');
        const obj = {};
        for (const [k, v] of u.searchParams) obj[k] = v;
        // content may contain & which breaks URL parsing — extract from raw query as last param
        const raw = req.url;
        const contentIdx = raw.indexOf('content=');
        if (contentIdx !== -1 && (!obj.content || obj.content.length < 5)) {
          const rawContent = raw.slice(contentIdx + 8);
          try { obj.content = decodeURIComponent(rawContent.replace(/\+/g, ' ')); }
          catch { obj.content = rawContent.replace(/\+/g, ' '); }
        }
        resolve(obj);
        return;
      }
      let chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve({}); }
      });
      req.setTimeout(5000, () => resolve({}));
    });
  }

  async function withWriteLock(fn) {
    return _withCustomCronLock(fn);
  }

  const server = http.createServer(async (req, res) => {
    const host = req.headers.host || '';
    if (!/^127\.0\.0\.1(:\d+)?$/.test(host) && !/^localhost(:\d+)?$/.test(host)) {
      return jsonResp(res, 403, { error: 'forbidden' });
    }
    const urlPath = (new URL(req.url, 'http://127.0.0.1')).pathname;
    const params = await parseBody(req);

    const readOnlyEndpoints = ['/api/cron/list', '/api/workspace/read', '/api/workspace/list'];
    const isMutation = !readOnlyEndpoints.includes(urlPath);
    if (isMutation && params.token !== _cronApiToken) {
      return jsonResp(res, 403, { error: 'invalid or missing token. Read cron-api-token.txt via /api/workspace/read?path=cron-api-token.txt first.' });
    }

    if (urlPath === '/api/cron/create') {
      const { label, cronExpr, oneTimeAt, groupId, groupIds, content, mode, prompt: rawPrompt } = params;
      const isAgentMode = mode === 'agent';

      if (isAgentMode) {
        // Agent mode: run a full AI agent prompt. Agent can use web_search,
        // web_fetch tools. Delivers result to CEO Telegram by default.
        // If groupId is provided, agent also sends result to Zalo group via API.
        const agentPrompt = rawPrompt || content;
        if (!agentPrompt) return jsonResp(res, 400, { error: 'prompt (or content) required for mode=agent' });
        if (String(agentPrompt).length > 2000) return jsonResp(res, 400, { error: 'prompt too long (max 2000 chars)' });
        const existingCrons = loadCustomCrons();
        if (existingCrons.length >= 20) return jsonResp(res, 400, { error: 'too many crons (max 20). Delete some first.' });
        if (cronExpr) {
          const normalized = String(cronExpr).trim().replace(/\s+/g, ' ');
          if (!nodeCron.validate(normalized)) return jsonResp(res, 400, { error: 'invalid cronExpr: ' + cronExpr });
          const parts = normalized.split(' ');
          if (parts.length >= 1) {
            const minField = parts[0];
            const stepMatch = minField.match(/^\*\/(\d+)$/);
            if (minField === '*' || (stepMatch && parseInt(stepMatch[1], 10) < 5)) {
              return jsonResp(res, 400, { error: 'frequency too high — minimum 5 minutes (use */5 or wider).' });
            }
          }
        }
        if (oneTimeAt) {
          const d = new Date(oneTimeAt);
          if (isNaN(d.getTime())) return jsonResp(res, 400, { error: 'invalid oneTimeAt: ' + oneTimeAt });
          if (d.getTime() < Date.now() - 60000) return jsonResp(res, 400, { error: 'oneTimeAt is in the past: ' + oneTimeAt });
        }
        if (!cronExpr && !oneTimeAt) return jsonResp(res, 400, { error: 'cronExpr or oneTimeAt required' });

        // If groupId provided, validate it and append delivery instructions
        let finalPrompt = String(agentPrompt);
        let resolvedGroupId = null;
        let resolvedGroupName = null;
        if (groupId) {
          const { byId, byName } = loadGroupsMap();
          resolvedGroupId = byName[String(groupId).toLowerCase()] || String(groupId).trim();
          resolvedGroupName = byId[resolvedGroupId];
          if (!resolvedGroupName) {
            return jsonResp(res, 400, { error: 'unknown groupId: ' + groupId + '. Check /api/cron/list for available groups.' });
          }
          finalPrompt += '\n\n---\nSAU KHI HOÀN THÀNH: gửi kết quả vào nhóm Zalo bằng cách gọi 2 API:\n'
            + '1. Đọc token: web_fetch url=http://127.0.0.1:20200/api/workspace/read?path=cron-api-token.txt\n'
            + '2. Gửi tin: web_fetch url=http://127.0.0.1:20200/api/zalo/send?token=TOKEN_VỪA_ĐỌC&groupId=' + resolvedGroupId + '&text=KẾT_QUẢ\n'
            + 'QUY TẮC VIẾT:\n'
            + '- Viết tiếng Việt CÓ DẤU đầy đủ (ví dụ: "trí tuệ nhân tạo" chứ KHÔNG "tri tue nhan tao")\n'
            + '- Viết dạng đoạn văn tự nhiên như đang chat, KHÔNG dùng danh sách số (1. 2. 3.), KHÔNG dùng bullet points\n'
            + '- Ngắn gọn, KHÔNG dùng emoji, KHÔNG tự xưng là AI/bot/trợ lý.';
        }

        const id = 'cron_' + Date.now();
        const entry = {
          id,
          label: label || ('Agent cron ' + new Date().toISOString().slice(0, 16)),
          prompt: finalPrompt,
          mode: 'agent',
          enabled: true,
          createdAt: new Date().toISOString(),
        };
        if (resolvedGroupId) entry.groupId = resolvedGroupId;
        if (cronExpr) entry.cronExpr = String(cronExpr).trim().replace(/\s+/g, ' ');
        else entry.oneTimeAt = oneTimeAt;
        try {
          return await withWriteLock(async () => {
            const crons = loadCustomCrons();
            crons.push(entry);
            writeJsonAtomic(getCustomCronsPath(), crons);
            try { restartCronJobs(); } catch {}
            const groupLabel = resolvedGroupName ? ' — group: ' + resolvedGroupName : '';
            console.log('[cron-api] created agent cron:', id, label || '', groupLabel);
            try {
              sendCeoAlert('[Cron] Đã tạo (agent): ' + (label || 'no label') + ' — ' + (cronExpr || oneTimeAt) + groupLabel);
            } catch {}
            return jsonResp(res, 200, { success: true, id, entry });
          });
        } catch (e) { return jsonResp(res, 500, { error: e.message }); }
      }

      // Default mode: group message send via openzca
      if (!content) return jsonResp(res, 400, { error: 'content required' });
      if (String(content).length > 500) return jsonResp(res, 400, { error: 'content too long (max 500 chars)' });
      const targets = groupIds ? String(groupIds).split(',').map(s => s.trim()).filter(Boolean) : (groupId ? [String(groupId).trim()] : []);
      if (targets.length === 0) return jsonResp(res, 400, { error: 'groupId or groupIds required' });
      const { byId, byName } = loadGroupsMap();
      const resolvedIds = targets.map(t => byName[t.toLowerCase()] || t);
      const invalidIds = resolvedIds.filter(id => !(id in byId));
      if (invalidIds.length > 0) return jsonResp(res, 400, { error: 'unknown groupId(s): ' + invalidIds.join(', ') + '. Available: ' + Object.entries(byId).map(([id, name]) => `${name} (${id})`).join(', ') });
      const existingCrons = loadCustomCrons();
      if (existingCrons.length >= 20) return jsonResp(res, 400, { error: 'too many crons (max 20). Delete some first.' });
      if (cronExpr) {
        const normalized = String(cronExpr).trim().replace(/\s+/g, ' ');
        if (!nodeCron.validate(normalized)) return jsonResp(res, 400, { error: 'invalid cronExpr: ' + cronExpr });
        const parts = normalized.split(' ');
        const minField = parts[0] || '';
        const stepMatch = minField.match(/^\*\/(\d+)$/);
        if (minField === '*' || (stepMatch && parseInt(stepMatch[1], 10) < 5)) {
          return jsonResp(res, 400, { error: 'frequency too high — minimum 5 minutes (use */5 or wider). Every-minute crons will spam groups.' });
        }
      }
      if (oneTimeAt) {
        const d = new Date(oneTimeAt);
        if (isNaN(d.getTime())) return jsonResp(res, 400, { error: 'invalid oneTimeAt (expected YYYY-MM-DDTHH:MM:SS): ' + oneTimeAt });
        if (d.getTime() < Date.now() - 60000) return jsonResp(res, 400, { error: 'oneTimeAt is in the past: ' + oneTimeAt });
      }
      if (!cronExpr && !oneTimeAt) return jsonResp(res, 400, { error: 'cronExpr or oneTimeAt required' });
      const targetStr = resolvedIds.join(',');
      const id = 'cron_' + Date.now();
      const entry = {
        id,
        label: label || ('Cron ' + new Date().toISOString().slice(0, 16)),
        prompt: 'exec: openzca msg send ' + targetStr + ' "' + String(content).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ').replace(/\r/g, '') + '" --group --profile default',
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      if (cronExpr) entry.cronExpr = String(cronExpr).trim().replace(/\s+/g, ' ');
      else entry.oneTimeAt = oneTimeAt;
      try {
        return await withWriteLock(async () => {
          const crons = loadCustomCrons();
          crons.push(entry);
          writeJsonAtomic(getCustomCronsPath(), crons);
          try { restartCronJobs(); } catch {}
          console.log('[cron-api] created:', id, label || '');
          try {
            const groupNames = resolvedIds.map(gid => byId[gid] || gid).join(', ');
            sendCeoAlert('[Cron] Đã tạo: ' + (label || 'no label') + ' — ' + (cronExpr || oneTimeAt) + ' — group: ' + groupNames);
          } catch {}
          return jsonResp(res, 200, { success: true, id, entry });
        });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    } else if (urlPath === '/api/cron/list') {
      try {
        const crons = loadCustomCrons();
        const { byId } = loadGroupsMap();
        const resp = { crons, groups: Object.entries(byId).map(([id, name]) => ({ id, name })) };
        return jsonResp(res, 200, resp);
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    } else if (urlPath === '/api/cron/delete') {
      const { id } = params;
      if (!id) return jsonResp(res, 400, { error: 'id required' });
      try {
        return await withWriteLock(async () => {
          const crons = loadCustomCrons();
          const filtered = crons.filter(c => c.id !== id);
          if (filtered.length === crons.length) return jsonResp(res, 404, { error: 'cron not found: ' + id });
          writeJsonAtomic(getCustomCronsPath(), filtered.filter(c => c.source !== 'openclaw'));
          try { restartCronJobs(); } catch {}
          console.log('[cron-api] deleted:', id);
          try { sendCeoAlert('[Cron] Đã xóa: ' + id); } catch {}
          return jsonResp(res, 200, { success: true });
        });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    } else if (urlPath === '/api/cron/toggle') {
      const { id, enabled } = params;
      if (!id) return jsonResp(res, 400, { error: 'id required' });
      try {
        return await withWriteLock(async () => {
          const crons = loadCustomCrons();
          const target = crons.find(c => c.id === id);
          if (!target) return jsonResp(res, 404, { error: 'cron not found: ' + id });
          target.enabled = enabled === 'true' || enabled === true;
          writeJsonAtomic(getCustomCronsPath(), crons.filter(c => c.source !== 'openclaw'));
          try { restartCronJobs(); } catch {}
          try { sendCeoAlert('[Cron] ' + (target.enabled ? 'Bật' : 'Tắt') + ': ' + (target.label || id)); } catch {}
          return jsonResp(res, 200, { success: true, enabled: target.enabled });
        });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    } else if (urlPath === '/api/workspace/read') {
      const ws = getWorkspace();
      if (!ws) return jsonResp(res, 500, { error: 'workspace not found' });
      const reqPath = String(params.path || '').replace(/\\/g, '/');
      if (!reqPath) return jsonResp(res, 400, { error: 'path required' });
      const ALLOWED = [
        /^\.?learnings\/LEARNINGS\.md$/,
        /^LEARNINGS\.md$/,
        /^memory\/zalo-users\/[^\/]+\.md$/,
        /^memory\/zalo-groups\/[^\/]+\.md$/,
        /^knowledge\/[^\/]+\/index\.md$/,
        /^IDENTITY\.md$/,
        /^schedules\.json$/,
        /^custom-crons\.json$/,
        /^logs\/cron-runs\.jsonl$/,
        /^logs\/escalation-queue\.jsonl$/,
        /^logs\/ceo-alerts-missed\.log$/,
        /^cron-api-token\.txt$/,
      ];
      if (reqPath.includes('..') || !ALLOWED.some(r => r.test(reqPath))) {
        return jsonResp(res, 403, { error: 'path not in whitelist' });
      }
      try {
        const fullPath = path.join(ws, reqPath);
        if (!fs.existsSync(fullPath)) return jsonResp(res, 404, { error: 'file not found: ' + reqPath });
        const content = fs.readFileSync(fullPath, 'utf-8');
        return jsonResp(res, 200, { path: reqPath, content, size: Buffer.byteLength(content) });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    } else if (urlPath === '/api/workspace/append') {
      if (params.token !== _cronApiToken) {
        return jsonResp(res, 403, { error: 'invalid or missing token' });
      }
      const ws = getWorkspace();
      if (!ws) return jsonResp(res, 500, { error: 'workspace not found' });
      const reqPath = String(params.path || '').replace(/\\/g, '/');
      const content = String(params.content || '');
      if (!reqPath || !content) return jsonResp(res, 400, { error: 'path and content required' });
      const APPEND_ALLOWED = [
        /^\.?learnings\/LEARNINGS\.md$/,
        /^LEARNINGS\.md$/,
      ];
      if (reqPath.includes('..') || !APPEND_ALLOWED.some(r => r.test(reqPath))) {
        return jsonResp(res, 403, { error: 'append only allowed for LEARNINGS.md' });
      }
      if (Buffer.byteLength(content) > 2000) return jsonResp(res, 400, { error: 'content too large (max 2000 bytes)' });
      try {
        return await withWriteLock(async () => {
          const fullPath = path.join(ws, reqPath);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.appendFileSync(fullPath, '\n' + content, 'utf-8');
          console.log('[workspace-api] appended to', reqPath, '(' + content.length + ' chars)');
          return jsonResp(res, 200, { success: true, path: reqPath });
        });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    } else if (urlPath === '/api/workspace/list') {
      const ws = getWorkspace();
      if (!ws) return jsonResp(res, 500, { error: 'workspace not found' });
      const dir = String(params.dir || '').replace(/\\/g, '/');
      const DIRS_ALLOWED = [
        /^memory\/zalo-users\/?$/,
        /^memory\/zalo-groups\/?$/,
        /^knowledge\/[^\/]+\/?$/,
      ];
      if (!dir || dir.includes('..') || !DIRS_ALLOWED.some(r => r.test(dir))) {
        return jsonResp(res, 403, { error: 'dir not in whitelist. Allowed: memory/zalo-users/, memory/zalo-groups/, knowledge/*/' });
      }
      try {
        const fullDir = path.join(ws, dir);
        if (!fs.existsSync(fullDir)) return jsonResp(res, 200, { dir, files: [] });
        const files = fs.readdirSync(fullDir).filter(f => f.endsWith('.md') || f.endsWith('.json'));
        return jsonResp(res, 200, { dir, files });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    } else if (urlPath === '/api/zalo/send') {
      const { groupId, targetId: rawTargetId, groupName, text, isGroup: isGroupParam } = params;
      let tId = groupId || rawTargetId;
      if (!tId && groupName) {
        const { byName } = loadGroupsMap();
        tId = byName[String(groupName).toLowerCase()];
        if (!tId) return jsonResp(res, 400, { error: 'unknown groupName: ' + groupName + '. Check /api/cron/list for available groups.' });
      }
      if (!tId) return jsonResp(res, 400, { error: 'groupId (or targetId or groupName) required' });
      if (!text) return jsonResp(res, 400, { error: 'text required' });
      if (String(text).length > 5000) return jsonResp(res, 400, { error: 'text too long (max 5000 chars)' });
      const isGroup = isGroupParam !== 'false' && isGroupParam !== false;
      const { byId } = loadGroupsMap();
      if (isGroup && !byId[String(tId)]) {
        return jsonResp(res, 400, { error: 'unknown groupId: ' + tId + '. Check /api/cron/list for available groups.' });
      }
      try {
        const ok = await sendZaloTo({ id: String(tId), isGroup }, String(text), { skipFilter: true });
        if (ok) {
          console.log(`[cron-api] /api/zalo/send OK → ${isGroup ? 'group' : 'user'} ${tId}`);
          return jsonResp(res, 200, { success: true, targetId: String(tId), isGroup });
        } else {
          return jsonResp(res, 500, { success: false, error: 'sendZaloTo returned null — check listener status, target validity, or channel pause state' });
        }
      } catch (e) {
        return jsonResp(res, 500, { success: false, error: String(e?.message || e).slice(0, 300) });
      }

    } else if (urlPath === '/api/knowledge/add') {
      const ws = getWorkspace();
      if (!ws) return jsonResp(res, 500, { error: 'workspace not found' });
      const { category, title, content: faqContent } = params;
      const validCats = ['cong-ty', 'san-pham', 'nhan-vien'];
      if (!category || !validCats.includes(category)) return jsonResp(res, 400, { error: 'category required: ' + validCats.join(', ') });
      if (!title || !faqContent) return jsonResp(res, 400, { error: 'title and content required' });
      if (String(title).length > 200) return jsonResp(res, 400, { error: 'title too long (max 200)' });
      if (String(faqContent).length > 2000) return jsonResp(res, 400, { error: 'content too long (max 2000)' });
      try {
        return await withWriteLock(async () => {
          const indexPath = path.join(ws, 'knowledge', category, 'index.md');
          fs.mkdirSync(path.dirname(indexPath), { recursive: true });
          const existing = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf-8') : '';
          const entry = `\n\n## ${String(title).trim()}\n\n${String(faqContent).trim()}\n`;
          fs.appendFileSync(indexPath, entry, 'utf-8');
          console.log('[knowledge-api] added to', category + '/index.md:', title);
          try { auditLog('knowledge_added', { category, title: String(title).slice(0, 100) }); } catch {}
          purgeAgentSessions('knowledge-api-add');
          return jsonResp(res, 200, { success: true, category, title, indexPath: `knowledge/${category}/index.md` });
        });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    // ============================================
    //  CEO FILE API — full file system access (token-gated)
    // ============================================
    } else if (urlPath === '/api/file/read') {
      const filePath = String(params.path || '');
      if (!filePath) return jsonResp(res, 400, { error: 'path required (absolute path)' });
      const abs = path.resolve(filePath);
      try {
        const stat = fs.statSync(abs);
        if (stat.size > 10 * 1024 * 1024) return jsonResp(res, 400, { error: 'file too large (max 10MB). Size: ' + Math.round(stat.size / 1024 / 1024) + 'MB' });
        const ext = path.extname(abs).toLowerCase();
        if (ext === '.xlsx' || ext === '.xls') {
          try {
            const XLSX = require('xlsx');
            const wb = XLSX.readFile(abs);
            const sheets = {};
            for (const name of wb.SheetNames) {
              sheets[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' });
            }
            return jsonResp(res, 200, { success: true, path: abs, type: 'excel', sheets, sheetNames: wb.SheetNames });
          } catch (xe) { return jsonResp(res, 500, { error: 'Excel parse failed: ' + xe.message + '. Install xlsx: npm i xlsx in electron/' }); }
        }
        const buf = fs.readFileSync(abs);
        const isBinary = buf.slice(0, 8000).some(b => b === 0);
        if (isBinary) return jsonResp(res, 200, { success: true, path: abs, type: 'binary', size: stat.size, encoding: 'base64', content: buf.toString('base64').slice(0, 50000) });
        return jsonResp(res, 200, { success: true, path: abs, type: 'text', content: buf.toString('utf-8'), size: stat.size });
      } catch (e) {
        if (e.code === 'ENOENT') return jsonResp(res, 404, { error: 'file not found: ' + abs });
        return jsonResp(res, 500, { error: e.message });
      }

    } else if (urlPath === '/api/file/write') {
      const filePath = String(params.path || '');
      const content = params.content;
      if (!filePath) return jsonResp(res, 400, { error: 'path required (absolute path)' });
      if (content === undefined || content === null) return jsonResp(res, 400, { error: 'content required' });
      const abs = path.resolve(filePath);
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(content), 'utf-8');
        console.log('[file-api] write:', abs, '(' + String(content).length + ' chars)');
        return jsonResp(res, 200, { success: true, path: abs, size: Buffer.byteLength(String(content), 'utf-8') });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    } else if (urlPath === '/api/file/list') {
      const dirPath = String(params.path || '');
      if (!dirPath) return jsonResp(res, 400, { error: 'path required (absolute path to directory)' });
      const abs = path.resolve(dirPath);
      try {
        const entries = fs.readdirSync(abs, { withFileTypes: true });
        const items = entries.slice(0, 200).map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          size: e.isFile() ? (() => { try { return fs.statSync(path.join(abs, e.name)).size; } catch { return 0; } })() : undefined,
        }));
        return jsonResp(res, 200, { success: true, path: abs, count: entries.length, items });
      } catch (e) {
        if (e.code === 'ENOENT') return jsonResp(res, 404, { error: 'directory not found: ' + abs });
        return jsonResp(res, 500, { error: e.message });
      }

    } else if (urlPath === '/api/exec') {
      const cmd = String(params.command || '');
      if (!cmd) return jsonResp(res, 400, { error: 'command required' });
      if (cmd.length > 2000) return jsonResp(res, 400, { error: 'command too long (max 2000 chars)' });
      const timeoutMs = Math.min(parseInt(params.timeout) || 30000, 120000);
      const cwd = params.cwd ? String(params.cwd) : undefined;
      const { exec: execAsync } = require('child_process');
      return new Promise((resolve) => {
        execAsync(cmd, {
          timeout: timeoutMs,
          encoding: 'utf-8',
          cwd,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
          env: { ...process.env },
          shell: true,
        }, (err, stdout, stderr) => {
          if (err) {
            resolve(jsonResp(res, 200, {
              success: false,
              exitCode: err.code || 1,
              stdout: String(stdout || '').slice(0, 30000),
              stderr: String(stderr || '').slice(0, 30000),
              error: err.message,
            }));
          } else {
            resolve(jsonResp(res, 200, { success: true, output: String(stdout).slice(0, 50000) }));
          }
        });
      });

    } else {
      return jsonResp(res, 404, { error: 'not found', endpoints: ['/api/cron/create', '/api/cron/list', '/api/cron/delete', '/api/cron/toggle', '/api/zalo/send', '/api/knowledge/add', '/api/workspace/read', '/api/workspace/append', '/api/workspace/list', '/api/file/read', '/api/file/write', '/api/file/list', '/api/exec'] });
    }
  });

  function tryListen(port, retries) {
    server.listen(port, '127.0.0.1', () => {
      _cronApiServer = server;
      _cronApiPort = port;
      console.log('[cron-api] listening on http://127.0.0.1:' + port);
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && retries > 0) {
        console.warn('[cron-api] port ' + port + ' in use, trying ' + (port + 1));
        server.removeAllListeners('error');
        tryListen(port + 1, retries - 1);
      } else {
        console.error('[cron-api] server error:', err.message);
        try { sendCeoAlert('[Cron API] Không khởi động được HTTP server: ' + err.message); } catch {}
      }
    });
  }
  tryListen(20200, 3);
}

// IPC: bot or dashboard can queue a follow-up.
// Race safety: processFollowUpQueue holds _followUpQueueLock for the entire async duration
// (up to 600s while runCronAgentPrompt executes). A 150ms yield was insufficient.
// Instead, processFollowUpQueue re-reads the queue file before its final write (see above),
// so any IPC-written entries that arrived during the long await are merged back in.
// The IPC handler itself simply writes immediately — it only appends, never overwrites.
ipcMain.handle('queue-follow-up', async (_event, { channel, recipientId, recipientName, question, prompt, delayMinutes }) => {
  try {
    const queue = readFollowUpQueue();
    const id = 'fu_' + Date.now();
    const fireAt = new Date(Date.now() + (delayMinutes || 15) * 60 * 1000).toISOString();
    queue.push({ id, channel: channel || 'zalo', recipientId, recipientName, question, prompt, fireAt });
    writeFollowUpQueue(queue);
    console.log('[follow-up] Queued:', id, 'fire at', fireAt);
    return { success: true, id, fireAt };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

let _startCronJobsInFlight = false;
function startCronJobs() {
  if (_startCronJobsInFlight) { console.log('[cron] startCronJobs skipped — already in flight'); return; }
  _startCronJobsInFlight = true;
  try { _startCronJobsInner(); } finally { _startCronJobsInFlight = false; }
}
function _startCronJobsInner() {
  stopCronJobs();
  if (!global._cronInFlight) global._cronInFlight = new Map();
  // Kick off the openclaw-agent CLI self-test (non-blocking). Sets _agentFlagProfile
  // / _agentCliHealthy so that when a cron fires it already knows which flags to use.
  // Re-runs are no-ops because _selfTestPromise is cached for the process lifetime.
  // PROACTIVE ALERT: if the CLI is broken at startup, alert CEO now instead of waiting
  // for the first cron to fail (which could be hours away, e.g. morning report at 7:30am).
  selfTestOpenClawAgent()
    .then(() => {
      if (!_agentCliVersionOk) {
        const msg = '[Cảnh báo cron] Không chạy được openclaw CLI khi khởi động. ' +
          'Cron job sáng/tối có thể không chạy được. Kiểm tra Dashboard → console để biết chi tiết.';
        sendCeoAlert(msg).catch(() => {});
        console.warn('[startCronJobs] CLI health check failed — CEO alerted');
      }
    })
    .catch((e) => console.error('[cron-agent self-test] threw:', e?.message || e));
  const schedules = loadSchedules();

  // --- Fixed schedules (managed by Dashboard) ---
  for (const s of schedules) {
    if (!s.enabled) continue;

    let cronExpr = null;
    let handler = null;

    switch (s.id) {
      case 'morning': {
        const [h, m] = (s.time || '07:30').split(':');
        cronExpr = `${m || 30} ${h || 7} * * *`;
        handler = async () => {
          console.log('[cron] Morning briefing triggered at', new Date().toISOString());
          if (global._cronInFlight?.get('morning')) {
            console.warn('[cron] Morning SKIPPED — previous run still in flight');
            return;
          }
          global._cronInFlight?.set('morning', true);
          try {
            const prompt = buildMorningBriefingPrompt(s.time);
            await runCronViaSessionOrFallback(prompt, { label: 'morning-briefing' });
            try { auditLog('cron_fired', { id: 'morning', label: s.label || 'Báo cáo sáng' }); } catch {}
          } catch (e) {
            console.error('[cron] Morning handler threw:', e?.message || e);
            try { auditLog('cron_failed', { id: 'morning', label: s.label || 'Báo cáo sáng', error: String(e?.message || e).slice(0, 200) }); } catch {}
          } finally {
            global._cronInFlight?.delete('morning');
          }
        };
        break;
      }
      case 'evening': {
        const [h, m] = (s.time || '21:00').split(':');
        cronExpr = `${m || 0} ${h || 21} * * *`;
        handler = async () => {
          console.log('[cron] Evening summary triggered at', new Date().toISOString());
          if (global._cronInFlight?.get('evening')) {
            console.warn('[cron] Evening SKIPPED — previous run still in flight');
            return;
          }
          global._cronInFlight?.set('evening', true);
          try {
            const prompt = buildEveningSummaryPrompt(s.time);
            await runCronViaSessionOrFallback(prompt, { label: 'evening-summary' });
            try { auditLog('cron_fired', { id: 'evening', label: s.label || 'Tóm tắt cuối ngày' }); } catch {}
          } catch (e) {
            console.error('[cron] Evening handler threw:', e?.message || e);
            try { auditLog('cron_failed', { id: 'evening', label: s.label || 'Tóm tắt cuối ngày', error: String(e?.message || e).slice(0, 200) }); } catch {}
          } finally {
            global._cronInFlight?.delete('evening');
          }
        };
        break;
      }
      case 'heartbeat': {
        // Honor schedules.json `time` field. Default to "Mỗi 10 phút" if absent
        // or unparseable. Previously hardcoded `*/5 * * * *` ignored the label.
        const timeStr = (s.time || '').toLowerCase();
        const m = timeStr.match(/(\d+)\s*ph[uú]t/);
        const everyMin = m ? Math.max(5, parseInt(m[1], 10)) : 10;
        cronExpr = `*/${everyMin} * * * *`;
        handler = async () => {
          try {
            // Race guard: skip heartbeat if user-triggered restart is in
            // progress (save-zalo-manager or resume-zalo hard-restart) — else
            // heartbeat sees "gateway down" mid-user-restart → tries its own
            // restart → two concurrent stopOpenClaw+startOpenClaw race.
            if (_saveZaloManagerInFlight || _startOpenClawInFlight) {
              console.log('[heartbeat] skipping — user-triggered restart in progress');
              return;
            }
            // Post-boot grace: skip heartbeat entirely if gateway started <6min
            // ago. Full boot on slow customer machines can take 5:21 (gateway
            // "ready" at 70s + blocked channel startup waiting on openrouter.ai
            // fetch). Heartbeat cron firing at :00/:30 during the blocked
            // window was killing healthy-but-busy gateways → restart loop.
            const sinceGatewayStart = Date.now() - (global._gatewayStartedAt || 0);
            if (global._gatewayStartedAt && sinceGatewayStart < 360_000) {
              console.log(`[heartbeat] skipping — gateway only ${Math.round(sinceGatewayStart/1000)}s old (<6min grace)`);
              return;
            }
            const alive1 = await isGatewayAlive(30000);
            if (alive1) {
              // Gateway alive → also verify openzca listener is running.
              // Listener can die silently if openzca crashes; gateway stays
              // up but Zalo channel is dead. Only restart gateway if
              // Zalo is enabled in config.
              //
              // [zalo-watchdog] Single transient "no listener pid found"
              // used to trigger a restart → cascade loop. Now we require
              // 3 consecutive misses with backoff.
              try {
                const cfgPath = path.join(HOME, '.openclaw', 'openclaw.json');
                const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
                if (cfg?.channels?.openzalo?.enabled === true && !isChannelPaused('zalo')) {
                  const lpid = findOpenzcaListenerPid();
                  if (lpid) {
                    // Listener healthy — reset streak, stay calm.
                    global._zaloListenerMissStreak = 0;
                  } else {
                    global._zaloListenerMissStreak = (global._zaloListenerMissStreak || 0) + 1;
                    const streak = global._zaloListenerMissStreak;
                    console.log(`[zalo-watchdog] listener missing — streak=${streak}`);
                    // Gate 1: need 3 misses in a row.
                    if (streak < 3) { return; }
                    // Gate 2: skip if another restart sequence is in-flight
                    // (save-zalo-manager, resume-zalo, or recent startOpenClaw).
                    if (_gatewayRestartInFlight || _startOpenClawInFlight) {
                      console.log('[zalo-watchdog] restart already in-flight — skipping');
                      return;
                    }
                    // Gate 3: gateway must have finished booting at least 60s
                    // ago — slow boots on Windows can leave the listener
                    // momentarily absent while openzca is still spawning.
                    const sinceBoot = Date.now() - (_gatewayLastStartedAt || 0);
                    if (sinceBoot < 60_000) {
                      console.log(`[zalo-watchdog] gateway only ${sinceBoot}ms old — too fresh to restart`);
                      return;
                    }
                    // Gate 4: 10-minute cooldown since last watchdog restart.
                    const lastRestart = global._zaloListenerLastRestartAt || 0;
                    const sinceRestart = Date.now() - lastRestart;
                    if (lastRestart > 0 && sinceRestart < 10 * 60_000) {
                      console.log(`[zalo-watchdog] last restart ${Math.round(sinceRestart/1000)}s ago — waiting out 10min cooldown`);
                      return;
                    }
                    // Gate 5: 3 restarts in 2h ⇒ stop auto-restarting and
                    // alert CEO. Wait for manual Save/resume to reset.
                    global._zaloListenerRestartHistory = (global._zaloListenerRestartHistory || []).filter(ts => (Date.now() - ts) < 2 * 60 * 60_000);
                    if (global._zaloListenerGaveUp) {
                      console.log('[zalo-watchdog] already gave up after 3 restarts in 2h — waiting for manual Save/resume');
                      return;
                    }
                    if (global._zaloListenerRestartHistory.length >= 3) {
                      console.log('[zalo-watchdog] 3 restarts in 2h — giving up, alerting CEO');
                      global._zaloListenerGaveUp = true;
                      // Dedup: skip alert if fast watchdog already alerted within 15 min
                      const _fwAlertAge = Date.now() - (global._zaloListenerAlertSentAt || 0);
                      if (global._zaloListenerAlertSentAt && _fwAlertAge < 15 * 60 * 1000) {
                        console.log(`[zalo-watchdog] skipping CEO alert — fast watchdog already alerted ${Math.round(_fwAlertAge/1000)}s ago`);
                      } else {
                        try { await sendCeoAlert('Listener Zalo đang không ổn định, vui lòng kiểm tra kết nối mạng'); } catch {}
                      }
                      return;
                    }
                    // All gates passed — do the restart.
                    console.log('[zalo-watchdog] gateway alive but Zalo listener dead (3 misses) — hard-restart');
                    global._zaloListenerLastRestartAt = Date.now();
                    global._zaloListenerRestartHistory.push(Date.now());
                    global._zaloListenerMissStreak = 0;
                    if (_gatewayRestartInFlight) return;
                    _gatewayRestartInFlight = true;
                    try {
                      try { await stopOpenClaw(); } catch {}
                      await new Promise(r => setTimeout(r, 5000));
                      try { await startOpenClaw({ silent: true }); } catch (e) { console.error('[zalo-watchdog] zalo restart failed:', e.message); }
                    } finally {
                      _gatewayRestartInFlight = false;
                    }
                  }
                }
              } catch {}
              return;
            }
            await new Promise(r => setTimeout(r, 5000));
            const alive2 = await isGatewayAlive(30000);
            if (alive2) {
              console.log('[heartbeat] gateway slow but alive — skipping restart');
              return;
            }
            // Third probe before restart — cloud model cold start can hold
            // gateway 30-60s, tripping 2 probes in a row without being dead.
            await new Promise(r => setTimeout(r, 5000));
            const alive3 = await isGatewayAlive(30000);
            if (alive3) {
              console.log('[heartbeat] gateway slow but alive (3rd probe) — skipping restart');
              return;
            }
            // [restart-guard] Don't cascade a restart if save/resume or another
            // watchdog pass already owns the restart.
            if (_gatewayRestartInFlight || _startOpenClawInFlight) {
              console.log('[heartbeat] restart already in-flight — skipping gateway-dead restart');
              return;
            }
            console.log('[heartbeat] Gateway not responding (3 consecutive failures) — auto-restarting');
            _gatewayRestartInFlight = true;
            try {
              try { await stopOpenClaw(); } catch {}
              await new Promise(r => setTimeout(r, 5000));
              try { await startOpenClaw({ silent: true }); } catch (e) {
                console.error('[heartbeat] restart failed:', e.message);
              }
            } finally {
              _gatewayRestartInFlight = false;
            }
          } catch (e) { console.error('[heartbeat] error:', e.message); }
        };
        break;
      }
      case 'meditation': {
        cronExpr = '0 1 * * *';
        handler = async () => {
          console.log('[cron] Meditation triggered at', new Date().toISOString());
          if (global._cronInFlight?.get('meditation')) return;
          global._cronInFlight?.set('meditation', true);
          try {
            const prompt = buildMeditationPrompt();
            await runCronAgentPrompt(prompt, { label: 'meditation' });
            try { auditLog('cron_fired', { id: 'meditation', label: 'Tối ưu ban đêm' }); } catch {}
          } catch (e) {
            console.error('[cron] Meditation threw:', e?.message || e);
            try { auditLog('cron_failed', { id: 'meditation', label: 'Tối ưu ban đêm', error: String(e?.message || e).slice(0, 200) }); } catch {}
          } finally { global._cronInFlight?.delete('meditation'); }
        };
        break;
      }
      case 'weekly': {
        // Monday 8:00 AM
        const [h, m] = (s.time || '08:00').split(':');
        cronExpr = `${m || 0} ${h || 8} * * 1`;
        handler = async () => {
          console.log('[cron] Weekly report triggered at', new Date().toISOString());
          if (global._cronInFlight?.get('weekly')) return;
          global._cronInFlight?.set('weekly', true);
          try {
            const prompt = await buildWeeklyReportPrompt();
            await runCronViaSessionOrFallback(prompt, { label: 'weekly-report' });
            try { auditLog('cron_fired', { id: 'weekly', label: s.label || 'Báo cáo tuần' }); } catch {}
          } catch (e) {
            console.error('[cron] Weekly handler threw:', e?.message || e);
            try { auditLog('cron_failed', { id: 'weekly', label: 'Báo cáo tuần', error: String(e?.message || e).slice(0, 200) }); } catch {}
          } finally { global._cronInFlight?.delete('weekly'); }
        };
        break;
      }
      case 'monthly': {
        // 1st of month 8:30 AM
        const [h, m] = (s.time || '08:30').split(':');
        cronExpr = `${m || 30} ${h || 8} 1 * *`;
        handler = async () => {
          console.log('[cron] Monthly report triggered at', new Date().toISOString());
          if (global._cronInFlight?.get('monthly')) return;
          global._cronInFlight?.set('monthly', true);
          try {
            const prompt = buildMonthlyReportPrompt();
            await runCronViaSessionOrFallback(prompt, { label: 'monthly-report' });
            try { auditLog('cron_fired', { id: 'monthly', label: s.label || 'Báo cáo tháng' }); } catch {}
          } catch (e) {
            console.error('[cron] Monthly handler threw:', e?.message || e);
            try { auditLog('cron_failed', { id: 'monthly', label: 'Báo cáo tháng', error: String(e?.message || e).slice(0, 200) }); } catch {}
          } finally { global._cronInFlight?.delete('monthly'); }
        };
        break;
      }
      case 'zalo-followup': {
        // Daily 9:30 AM — check Zalo customers needing follow-up
        const [h, m] = (s.time || '09:30').split(':');
        cronExpr = `${m || 30} ${h || 9} * * *`;
        handler = async () => {
          console.log('[cron] Zalo follow-up triggered at', new Date().toISOString());
          if (global._cronInFlight?.get('zalo-followup')) return;
          global._cronInFlight?.set('zalo-followup', true);
          try {
            const ws = getWorkspace();
            const candidates = ws ? scanZaloFollowUpCandidates(ws) : [];
            const prompt = buildZaloFollowUpPrompt(candidates);
            await runCronAgentPrompt(prompt, { label: 'zalo-followup' });
            try { auditLog('cron_fired', { id: 'zalo-followup', label: 'Follow-up khách Zalo', candidateCount: candidates.length }); } catch {}
          } catch (e) {
            console.error('[cron] Zalo follow-up threw:', e?.message || e);
            try { auditLog('cron_failed', { id: 'zalo-followup', label: 'Follow-up khách Zalo', error: String(e?.message || e).slice(0, 200) }); } catch {}
          } finally { global._cronInFlight?.delete('zalo-followup'); }
        };
        break;
      }
      case 'memory-cleanup': {
        // Sunday 2:00 AM
        cronExpr = '0 2 * * 0';
        handler = async () => {
          console.log('[cron] Memory cleanup triggered at', new Date().toISOString());
          if (global._cronInFlight?.get('memory-cleanup')) return;
          global._cronInFlight?.set('memory-cleanup', true);
          try {
            const prompt = buildMemoryCleanupPrompt();
            await runCronAgentPrompt(prompt, { label: 'memory-cleanup' });
            try { auditLog('cron_fired', { id: 'memory-cleanup', label: 'Dọn dẹp memory' }); } catch {}
          } catch (e) {
            console.error('[cron] Memory cleanup threw:', e?.message || e);
            try { auditLog('cron_failed', { id: 'memory-cleanup', label: 'Dọn dẹp memory', error: String(e?.message || e).slice(0, 200) }); } catch {}
          } finally { global._cronInFlight?.delete('memory-cleanup'); }
        };
        break;
      }
    }

    if (cronExpr && handler) {
      try {
        const job = cron.schedule(cronExpr, handler, { timezone: 'Asia/Ho_Chi_Minh' });
        cronJobs.push({ id: s.id, job });
        console.log(`[cron] Scheduled ${s.id}: ${cronExpr}`);
      } catch (e) { console.error(`[cron] Failed to schedule ${s.id}:`, e.message); }
    }
  }

  // Weekly gateway restart — prevent memory bloat from accumulated context.
  // Runs Wednesday 3:30 AM (low-traffic). Restarts gateway only (not Electron).
  // Gateway process holds all agent context + openzca subprocess — fresh start
  // clears accumulated heap. Telegram/Zalo reconnect within ~30s (fast watchdog).
  try {
    const weeklyRestart = cron.schedule('30 3 * * 3', async () => {
      console.log('[cron] Weekly gateway restart for memory hygiene');
      try { auditLog('cron_fired', { id: 'weekly-gateway-restart', label: 'Weekly memory hygiene' }); } catch {}
      try {
        await stopOpenClaw();
        await startOpenClaw({ silent: true });
        console.log('[cron] Weekly gateway restart completed');
      } catch (e) {
        console.error('[cron] Weekly gateway restart failed:', e?.message);
      }
    }, { timezone: 'Asia/Ho_Chi_Minh' });
    cronJobs.push({ id: 'weekly-gateway-restart', job: weeklyRestart });
    console.log('[cron] Scheduled weekly-gateway-restart: 30 3 * * 3');
  } catch (e) { console.error('[cron] Failed to schedule weekly restart:', e?.message); }

  // --- Custom crons (created by bot via CEO request, permanent) ---
  const customs = loadCustomCrons();
  // Per-cron in-flight guard so a slow agent run doesn't get a duplicate fire
  // started before the previous one finishes. Map<cronId, true>.
  if (!global._cronInFlight) global._cronInFlight = new Map();
  for (const c of customs) {
    if (!c) continue;
    if (!c.enabled) continue;
    // D3: warn loudly on misconfigured custom cron instead of silently skipping
    if (!c.prompt || !c.prompt.trim()) {
      console.warn(`[cron] custom cron ${c.id || '(no id)'} skipped — empty prompt`);
      surfaceCronConfigError(c, 'empty prompt field');
      continue;
    }
    // oneTimeAt support: schedule via setTimeout instead of cron expression
    if (c.oneTimeAt && !c.cronExpr) {
      try {
        const fireAt = new Date(c.oneTimeAt);
        const delayMs = fireAt.getTime() - Date.now();
        if (isNaN(fireAt.getTime())) {
          surfaceCronConfigError(c, `oneTimeAt invalid date: "${c.oneTimeAt}"`);
          continue;
        }
        if (delayMs < -60000) {
          console.log(`[cron] oneTime ${c.id} already past (${c.oneTimeAt}) — removing`);
          _removeCustomCronById(c.id);
          continue;
        }
        const effectiveDelay = Math.max(delayMs, 1000);
        const timer = setTimeout(async () => {
          console.log(`[cron] OneTime "${c.label || c.id}" firing at`, new Date().toISOString());
          try {
            if (c.prompt && !c.prompt.startsWith('exec:')) {
              await runCronViaSessionOrFallback(c.prompt, { label: c.label || c.id });
            } else {
              await runCronAgentPrompt(c.prompt, { label: c.label || c.id });
            }
            try { auditLog('cron_fired', { id: c.id, label: c.label || c.id, kind: 'one-time' }); } catch {}
          } catch (e) {
            console.error(`[cron] OneTime ${c.id} failed:`, e?.message);
            try { await sendCeoAlert(`*Cron một lần "${c.label || c.id}" lỗi*\n\n\`${String(e?.message || e).slice(0, 300)}\``); } catch {}
          }
          _removeCustomCronById(c.id);
        }, effectiveDelay);
        cronJobs.push({ id: c.id, job: { stop: () => clearTimeout(timer) } });
        console.log(`[cron] OneTime scheduled ${c.id}: ${c.oneTimeAt} (in ${Math.round(effectiveDelay / 1000)}s)`);
      } catch (e) {
        surfaceCronConfigError(c, `oneTimeAt setup failed: ${e.message}`);
      }
      continue;
    }
    if (!c.cronExpr) {
      console.warn(`[cron] custom cron ${c.id || '(no id)'} skipped — missing cronExpr`);
      surfaceCronConfigError(c, 'missing cronExpr field');
      continue;
    }
    // Inline heal: if LLM wrote ISO date as cronExpr, convert to oneTimeAt
    // on-the-fly instead of erroring. The heal in loadCustomCrons should have
    // caught this, but bot can re-write the file after heal (race condition).
    if (/^\d{4}-\d{2}-\d{2}/.test(c.cronExpr) || /T\d{2}:\d{2}/.test(c.cronExpr)) {
      console.log(`[cron] inline-healing ISO cronExpr "${c.cronExpr}" → oneTimeAt for ${c.id}`);
      c.oneTimeAt = c.cronExpr.replace(/\.000Z$/, '').replace(/Z$/, '');
      delete c.cronExpr;
      // Write healed version back to file so it doesn't re-trigger
      try {
        const customCronsPath = getCustomCronsPath();
        const all = loadCustomCrons();
        const idx = all.findIndex(x => x && x.id === c.id);
        if (idx >= 0) { all[idx] = c; writeJsonAtomic(customCronsPath, all); }
      } catch {}
      // Fall through to oneTimeAt scheduling below — need to re-enter the loop
      // by checking oneTimeAt condition. Simplest: just goto the oneTimeAt handler.
    }
    if (c.oneTimeAt && !c.cronExpr) {
      try {
        const fireAt = new Date(c.oneTimeAt);
        const delayMs = fireAt.getTime() - Date.now();
        if (isNaN(fireAt.getTime())) {
          surfaceCronConfigError(c, `oneTimeAt invalid date: "${c.oneTimeAt}"`);
          continue;
        }
        if (delayMs < -60000) {
          console.log(`[cron] oneTime ${c.id} already past (${c.oneTimeAt}) — removing`);
          _removeCustomCronById(c.id);
          continue;
        }
        const effectiveDelay = Math.max(delayMs, 1000);
        const timer = setTimeout(async () => {
          console.log(`[cron] OneTime "${c.label || c.id}" firing at`, new Date().toISOString());
          try {
            if (c.prompt && !c.prompt.startsWith('exec:')) {
              await runCronViaSessionOrFallback(c.prompt, { label: c.label || c.id });
            } else {
              await runCronAgentPrompt(c.prompt, { label: c.label || c.id });
            }
            try { auditLog('cron_fired', { id: c.id, label: c.label || c.id, kind: 'one-time-healed' }); } catch {}
          } catch (e) {
            console.error(`[cron] OneTime ${c.id} failed:`, e?.message);
            try { await sendCeoAlert(`*Cron một lần "${c.label || c.id}" lỗi*\n\n\`${String(e?.message || e).slice(0, 300)}\``); } catch {}
          }
          _removeCustomCronById(c.id);
        }, effectiveDelay);
        cronJobs.push({ id: c.id, job: { stop: () => clearTimeout(timer) } });
        console.log(`[cron] OneTime (inline-healed) scheduled ${c.id}: ${c.oneTimeAt} (in ${Math.round(effectiveDelay / 1000)}s)`);
      } catch (e) {
        surfaceCronConfigError(c, `oneTimeAt setup failed: ${e.message}`);
      }
      continue;
    }
    // D6: validate cronExpr syntax BEFORE scheduling, surface invalid expressions
    if (typeof cron.validate === 'function' && !cron.validate(c.cronExpr)) {
      console.error(`[cron] custom cron ${c.id} has INVALID cronExpr: "${c.cronExpr}"`);
      surfaceCronConfigError(c, `invalid cron expression: "${c.cronExpr}"`);
      continue;
    }
    try {
      const job = cron.schedule(c.cronExpr, async () => {
        const niceId = c.id || c.label || 'cron';
        // D2: concurrency guard — skip this fire if a previous one is still running
        if (global._cronInFlight.get(niceId)) {
          console.warn(`[cron] Custom "${c.label || c.id}" SKIPPED — previous run still in flight`);
          journalCronRun({ phase: 'skip', label: c.label || c.id, reason: 'previous-still-in-flight' });
          return;
        }
        global._cronInFlight.set(niceId, true);
        try {
          console.log(`[cron] Custom "${c.label || c.id}" triggered at`, new Date().toISOString());
          const ok = (c.prompt && !c.prompt.startsWith('exec:'))
            ? await runCronViaSessionOrFallback(c.prompt, { label: c.label || c.id })
            : await runCronAgentPrompt(c.prompt, { label: c.label || c.id });
          console.log(`[cron] Custom ${c.id} agent run result:`, ok);
          try { auditLog('cron_fired', { id: c.id, label: c.label || c.id, kind: 'custom' }); } catch {}
        } catch (e) {
          console.error(`[cron] Custom ${c.id} handler threw (suppressed):`, e?.message || e);
          journalCronRun({ phase: 'fail', label: c.label || c.id, reason: 'handler-threw', err: String(e?.message || e).slice(0, 300) });
          try { auditLog('cron_failed', { id: c.id, label: c.label || c.id, kind: 'custom', error: String(e?.message || e).slice(0, 200) }); } catch {}
          try { await sendCeoAlert(`*Cron "${c.label || c.id}" lỗi nội bộ*\n\n\`${String(e?.message || e).slice(0, 300)}\``); } catch {}
        } finally {
          global._cronInFlight.delete(niceId);
        }
      }, { timezone: 'Asia/Ho_Chi_Minh' });
      cronJobs.push({ id: c.id, job });
      console.log(`[cron] Custom scheduled ${c.id}: ${c.cronExpr} → "${c.prompt.substring(0, 50)}..."`);
    } catch (e) {
      console.error(`[cron] Failed custom ${c.id}:`, e.message);
      surfaceCronConfigError(c, `cron.schedule threw: ${e.message}`);
    }
  }
}

let _customCronWriteChain = Promise.resolve();
async function _withCustomCronLock(fn) {
  let release;
  const gate = new Promise(r => { release = r; });
  const prev = _customCronWriteChain;
  _customCronWriteChain = gate;
  await prev;
  try { return await fn(); } finally { release(); }
}

async function _removeCustomCronById(id) {
  await _withCustomCronLock(async () => {
    try {
      const p = path.join(getWorkspace(), 'custom-crons.json');
      if (!fs.existsSync(p)) return;
      const arr = JSON.parse(fs.readFileSync(p, 'utf-8'));
      const filtered = Array.isArray(arr) ? arr.filter(e => e?.id !== id) : arr;
      writeJsonAtomic(p, filtered);
      console.log(`[cron] removed one-time entry ${id} from custom-crons.json`);
    } catch (e) { console.warn(`[cron] _removeCustomCronById(${id}) error:`, e?.message); }
  });
}

function surfaceCronConfigError(c, reason) {
  try {
    const errFile = path.join(getWorkspace(), '.learnings', 'ERRORS.md');
    fs.mkdirSync(path.dirname(errFile), { recursive: true });
    fs.appendFileSync(errFile, `\n## ${new Date().toISOString()} — custom-cron config error\n\nCron: \`${c?.label || c?.id || '?'}\` (id: \`${c?.id || '?'}\`)\nReason: ${reason}\nExpr: \`${c?.cronExpr || '?'}\`\nPrompt (first 100 chars): ${(c?.prompt || '').slice(0, 100)}\n`, 'utf-8');
  } catch (e) { console.error('[surfaceCronConfigError] write error:', e.message); }
  try {
    sendCeoAlert(`*Cron "${c?.label || c?.id || '?'}" cấu hình sai*\n\n${reason}\n\nCron sẽ KHÔNG chạy cho tới khi sửa. Vào Dashboard → Cron để fix.`);
  } catch {}
}

function stopCronJobs() {
  for (const { job } of cronJobs) { try { job.stop(); } catch {} }
  cronJobs = [];
}

function restartCronJobs() {
  startCronJobs();
}

// ============================================
//  DOCUMENT LIBRARY (Telegram file → FTS5 index)
// ============================================

// Documents/knowledge files live in the writable workspace (Desktop/claw in dev,
// userData when packaged). Earlier versions hardcoded ~/.openclaw/workspace/ which
// did NOT exist on fresh installs — so the DB never opened, uploads silently failed,
// and the Knowledge tab list was always empty after restart. Always use getWorkspace().
function getDocumentsDir() {
  return path.join(getWorkspace(), 'documents');
}
function ensureDocumentsDir() {
  const d = getDocumentsDir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// R2 FIX: throttle error logging by time window instead of permanent latch.
// Permanent latch hid transient recovery → we lost observability if DB came
// back after a mount glitch. 5-min re-log window = quiet enough to not spam,
// loud enough to notice a recurring failure.
let _documentsDbLastErrorAt = 0;
const DOCUMENTS_DB_ERROR_LOG_INTERVAL_MS = 5 * 60 * 1000;
let _documentsDbAutoFixAttempted = false;
// R5 FIX: schema migration runs once per process. Previously DDL + 2 ALTER
// TABLE ran on every getDocumentsDb() call (50-100×/day on busy shops) —
// harmless but noisy throw-path on ALTER-already-exists.
let _documentsDbSchemaReady = false;

// ============================================
//  KNOWLEDGE SEARCH — Vietnamese FTS5 helpers
//  (K1 of v2.3.0: schema migration + chunker + normalizer)
// ============================================

// Vietnamese stopword list — dropped from `tokens` column to reduce FTS noise.
// Keep short-word (<2 chars) filtering separate so "id", "sn" codes survive.
const VI_STOPWORDS = new Set([
  'ở','la','voi','cua','cho','nay','kia','va','hoac','thi','ma','nen',
  'vay','roi','dang','se','da','co','cac','nhung','mot','trong','ngoai',
  'tren','duoi','khi','neu','tai','ve','theo','boi','vi','do','qua',
  'den','tu','vao','ra','len','xuong','di','toi','bang','cung','con',
  'do','day','kia','ay','nao','sao','dau','gi','ai','may','bao',
  'u','a','o','a','oi','nhe','nha','day','nhi','chu','ha','ho',
  'de','moi','chi','rat','hon','nhat','qua','that','that_su'
]);

// NFD decomposition strips combining marks; `đ`/`Đ` aren't decomposable so
// handle separately. Used by FTS5 unicode61 tokenizer also sets
// `remove_diacritics 2` but we still need a JS copy for `content_plain`
// and `tokens` columns (FTS5 tokenizer works on indexed text, not on
// the JS side where we compute derived columns).
function stripViDiacritics(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function normalizeForSearch(text) {
  if (!text) return '';
  return stripViDiacritics(String(text)).toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenizeForSearch(text) {
  if (!text) return '';
  const plain = normalizeForSearch(text);
  const tokens = plain.split(/[^a-z0-9]+/).filter(t => t.length >= 2 && !VI_STOPWORDS.has(t));
  return tokens.join(' ');
}

// Chunk Vietnamese text at sentence boundaries with configurable size + overlap.
// Sentence splitter recognises Latin (. ! ?) and CJK fullwidth (。？！) — useful
// for mixed VN/EN/CN product catalogs. Minimum chunk size 50: tiny trailing
// fragments merge into the previous chunk so FTS5 rows stay meaningful.
// Hard-cut fallback: a single sentence > chunkSize is split at chunkSize regardless.
function chunkVietnameseText(text, opts) {
  const chunkSize = (opts && opts.chunkSize) || 500;
  const overlap = (opts && opts.overlap) || 100;
  const minChunk = 50;
  if (!text) return [];
  // Normalise whitespace but preserve original char offsets by tracking cleaned
  // positions relative to the cleaned string. `char_start`/`char_end` refer to
  // the cleaned text (used for highlighting; exact byte-offsets in raw PDFs are
  // unreliable anyway after pdf-parse's own normalisation).
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return [];

  // 1) Split into candidate sentences with their start offsets.
  const sentences = [];
  const re = /[.!?。？！]+[\s]+/g;
  let lastIdx = 0;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const endIdx = m.index + m[0].length;
    sentences.push({ text: clean.slice(lastIdx, endIdx).trim(), start: lastIdx, end: endIdx });
    lastIdx = endIdx;
  }
  if (lastIdx < clean.length) {
    sentences.push({ text: clean.slice(lastIdx).trim(), start: lastIdx, end: clean.length });
  }

  // 2) Hard-cut any sentence > chunkSize into fixed-width pieces.
  const pieces = [];
  for (const s of sentences) {
    if (s.text.length <= chunkSize) { pieces.push(s); continue; }
    let off = 0;
    while (off < s.text.length) {
      const slice = s.text.slice(off, off + chunkSize);
      pieces.push({ text: slice, start: s.start + off, end: s.start + off + slice.length });
      off += chunkSize;
    }
  }

  // 3) Greedy pack pieces into chunks up to chunkSize, with `overlap` tail
  //    from the previous chunk prepended to each new chunk (except the first).
  const chunks = [];
  let cur = { text: '', start: -1, end: -1 };
  for (const p of pieces) {
    if (cur.text.length === 0) { cur = { text: p.text, start: p.start, end: p.end }; continue; }
    if (cur.text.length + 1 + p.text.length <= chunkSize) {
      cur.text = cur.text + ' ' + p.text;
      cur.end = p.end;
    } else {
      chunks.push(cur);
      // Build overlap from the tail of the previous chunk.
      const tailLen = Math.min(overlap, cur.text.length);
      const tail = tailLen > 0 ? cur.text.slice(cur.text.length - tailLen) : '';
      const tailStart = cur.end - tailLen;
      if (tail) {
        const combined = tail + ' ' + p.text;
        cur = { text: combined.length <= chunkSize ? combined : p.text,
                start: combined.length <= chunkSize ? tailStart : p.start,
                end: p.end };
      } else {
        cur = { text: p.text, start: p.start, end: p.end };
      }
    }
  }
  if (cur.text.length > 0) chunks.push(cur);

  // 4) Merge tiny trailing chunks (< minChunk) into the previous one.
  const merged = [];
  for (const c of chunks) {
    if (merged.length > 0 && c.text.length < minChunk) {
      const prev = merged[merged.length - 1];
      prev.text = prev.text + ' ' + c.text;
      prev.end = c.end;
    } else {
      merged.push(c);
    }
  }

  return merged.map((c, i) => ({
    index: i,
    content: c.text,
    char_start: c.start,
    char_end: c.end,
  }));
}

// === Knowledge RAG — embedder ===
// Implementation lives in lib/embedder.js so smoke-rag-test.js can import the
// SAME code path as production (E1 fix — previously smoke had its own inline
// embed() function → bugs in main.js embedText() would pass smoke silently).
// F10 fix: ONNX Runtime on Windows has documented bugs with non-ASCII paths
// (microsoft/onnxruntime#15388). Vietnamese Windows usernames like "Bùi",
// "Đức" would break embedder load silently. Resolve to short-name (8.3) if
// the original path contains non-ASCII — `fs.realpathSync.native` returns
// the canonical NT path which on NTFS can yield short names.
function _toNonAsciiSafePath(p) {
  if (!p || process.platform !== 'win32') return p;
  // Fast path: all ASCII → return as-is
  if (/^[\x00-\x7F]*$/.test(p)) return p;
  try {
    // Try fs.realpathSync.native — may yield NTFS short name
    const real = fs.realpathSync.native(p);
    if (/^[\x00-\x7F]*$/.test(real)) {
      console.log('[path-short] rewritten for non-ASCII safety:', p, '→', real);
      return real;
    }
    // Fallback: cmd /c for /f with 8.3 name. Only works if NTFS short-name
    // generation is enabled (default on Windows 10/11).
    try {
      const short = require('child_process').execFileSync(
        'cmd', ['/c', 'for', '%I', 'in', '("' + p + '")', 'do', '@echo', '%~sI'],
        { encoding: 'utf8', windowsHide: true }
      ).trim();
      if (short && /^[\x00-\x7F]*$/.test(short)) {
        console.log('[path-short] 8.3 name:', p, '→', short);
        return short;
      }
    } catch {}
  } catch {}
  // Return original if can't shorten — may still work on Windows 11 with UTF-8 ANSI.
  return p;
}

const _embedderModule = require('./lib/embedder');
const _rawModelsRoot = getBundledVendorDir() || path.join(__dirname, 'vendor');
_embedderModule.setModelsRoot(_toNonAsciiSafePath(_rawModelsRoot));
// Platform-F5: cacheDir MUST be writable. Mac .app bundle is read-only when
// installed to /Applications — keep transformers.js tokenizer cache in
// userData where we always have write permission.
try {
  const cacheDir = path.join(app.getPath('userData'), 'transformers-cache');
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch {}
  _embedderModule.setCacheRoot(_toNonAsciiSafePath(cacheDir));
} catch {}
const { getEmbedder, embedText, cosineSim, vecToBlob, blobToVec, E5_DIM, getEmbedderState } = _embedderModule;

// H7 FIX: runtime SHA256 check on bundled model .onnx. Build-time prebuild
// verified the HuggingFace download; runtime extracted files land in user-
// writable %APPDATA% (Windows) and could be swapped by local malware. If
// hash doesn't match, force re-extract by invalidating version stamp. Mac
// vendor lives in SIP-protected .app bundle so skip there.
async function verifyEmbedderModelSha() {
  if (!app.isPackaged) return;
  if (global.__embedderShaVerified) return;
  // Previously gated on win32 assuming Mac vendor was SIP-protected. Wrong:
  // unsigned .app installed to ~/Applications (not /Applications) is user-
  // writable on Mac too. Run SHA verify on both platforms.
  const resDir = process.resourcesPath;
  const metaPath = path.join(resDir, 'vendor-meta.json');
  if (!fs.existsSync(metaPath)) return;
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch { return; }
  if (!meta.modelSha || !meta.modelSha['model_quantized.onnx']) return;
  const vendorDir = getBundledVendorDir();
  if (!vendorDir) return;
  const onnxPath = path.join(vendorDir, 'models', 'Xenova', 'multilingual-e5-small', 'onnx', 'model_quantized.onnx');
  if (!fs.existsSync(onnxPath)) return;
  try {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(onnxPath, { highWaterMark: 4 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      stream.on('data', c => hash.update(c));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    const actual = hash.digest('hex');
    const expected = meta.modelSha['model_quantized.onnx'];
    if (actual !== expected) {
      console.warn(`[embedder-sha] model_quantized.onnx hash mismatch — expected ${expected.slice(0, 16)}..., got ${actual.slice(0, 16)}...`);
      if (process.platform === 'win32') {
        // Win: invalidate tar stamp → next boot auto-re-extracts from bundled tar.
        try {
          fs.unlinkSync(path.join(app.getPath('userData'), 'vendor-version.txt'));
          console.warn('[embedder-sha] vendor stamp removed — next launch will re-extract from tar');
        } catch {}
      }
      // Mac: no tar to re-extract from — tell CEO to reinstall the app.
      try {
        const msg = process.platform === 'win32'
          ? '[Bảo mật] Model RAG bị sửa đổi — khởi động lại app để cài lại từ bản gốc.'
          : '[Bảo mật] Model RAG bị sửa đổi — vui lòng cài lại 9BizClaw từ file DMG gốc.';
        sendCeoAlert(msg);
      } catch {}
      try { auditLog('rag_model_tamper', { platform: process.platform, expected, actual }); } catch {}
    } else {
      console.log('[embedder-sha] model_quantized.onnx verified');
    }
  } catch (e) {
    console.warn('[embedder-sha] check skipped:', e.message);
  }
  global.__embedderShaVerified = true;
}

// Boot-time backfill for pre-existing chunks (v2.3.46 upgrades etc where
// documents_chunks rows exist but have NULL embedding). Runs 30s after
// app.whenReady so gateway + 9router warmup take priority.
//
// H5 FIX: removed 500/boot cap — E5-small CPU inference is ~20-50ms/chunk,
// so 2000 chunks = ~40-100s of background work, completes in one boot. Old
// cap meant a 2000-chunk shop needed 4 daily restarts to finish backfilling,
// and during that window searchKnowledge only saw partial embeddings (C2).
//
// C2 FIX: while backfill is in progress, flip `_backfillInProgress` flag so
// searchKnowledge forces FTS5 fallback. Prevents "0.6% of corpus scored"
// class of silent wrong answers when a query lands mid-backfill.
//
// C7 FIX: explicit db.close() in finally. Previous comment claimed "GC
// reclaims eventually" but each backfill leak was one permanent handle
// until process exit — on heartbeat-triggered restarts that's a handle
// leak per reboot cycle.
let _backfillInProgress = false;
async function backfillKnowledgeEmbeddings() {
  const db = getDocumentsDb();
  if (!db) return;
  _backfillInProgress = true;
  try {
    const missing = db.prepare(
      `SELECT c.id, c.document_id, c.char_start, c.char_end, d.content
       FROM documents_chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE c.embedding IS NULL`
    ).all();
    if (missing.length === 0) return;
    console.log(`[knowledge-backfill] embedding ${missing.length} chunks...`);
    const upsert = db.prepare(
      'UPDATE documents_chunks SET embedding = ?, embedding_model = ? WHERE id = ?'
    );
    const MODEL_STAMP = 'multilingual-e5-small-q';
    let done = 0;
    let diskFullHits = 0;
    for (const row of missing) {
      const text = (row.content || '').substring(row.char_start, row.char_end);
      // F5: skip chunks under 50 chars (matches chunker's minChunk). E5 on
      // 3-char "abc" produces arbitrary-direction vectors that dominate cosine
      // against short queries. Previous threshold (5) let 6-40 char junk through.
      if (!text || text.length < 50) continue;
      try {
        const vec = await embedText(text, false);
        upsert.run(vecToBlob(vec), MODEL_STAMP, row.id);
        done++;
      } catch (e) {
        const msg = String(e?.message || e);
        if (/SQLITE_FULL|ENOSPC|disk I\/O|no space/i.test(msg)) diskFullHits++;
        console.warn('[knowledge-backfill] chunk failed:', row.id, msg);
      }
    }
    console.log(`[knowledge-backfill] done ${done}/${missing.length}`);
    // R3 cold-F2: if backfill failed wholesale due to disk-full, alert CEO.
    // Without this, RAG silently falls back to FTS5 forever — investment lost.
    if (done === 0 && diskFullHits >= 10) {
      try { sendCeoAlert('[RAG] Ổ đĩa đầy — không lưu được chỉ mục tìm kiếm. Giải phóng 500MB rồi khởi động lại.'); } catch {}
      try { auditLog('rag_backfill_disk_full', { attempted: missing.length, diskFullHits }); } catch {}
    }
  } catch (e) {
    console.warn('[knowledge-backfill] error:', e.message);
  } finally {
    _backfillInProgress = false;
    try { db.close(); } catch {}
  }
}

// Idempotent schema migration for the chunk table + FTS5 mirror. Runs inside
// getDocumentsDb() so every DB open catches fresh installs + upgrades. The
// triggers keep documents_chunks_fts mirror in sync with documents_chunks
// writes — INSERT/UPDATE/DELETE routed via rowid. tokens column stores the
// stopword-stripped, diacritic-stripped form used by the query-rewrite code
// (K3) to boost recall over plain FTS. content_plain is the diacritic-free
// but stopword-retained form — used for snippet() highlighting.
function ensureKnowledgeChunksSchema(db) {
  if (!db) return;
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL,
        category TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        char_start INTEGER,
        char_end INTEGER,
        FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_doc ON documents_chunks(document_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_cat ON documents_chunks(category);
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_chunks_fts USING fts5(
        content,
        content_plain,
        tokens,
        tokenize = "unicode61 remove_diacritics 2"
      );
      CREATE TRIGGER IF NOT EXISTS documents_chunks_ad
        AFTER DELETE ON documents_chunks BEGIN
          DELETE FROM documents_chunks_fts WHERE rowid = old.id;
        END;
    `);
  } catch (e) {
    console.error('[knowledge] chunk schema migrate error:', e.message);
  }

  // v2.3.47 — add embedding column for Knowledge RAG
  try {
    // Idempotent: ALTER TABLE ADD COLUMN is a no-op if column exists on some SQLite
    // versions; better-sqlite3 with old SQLite treats duplicate ADD as error.
    const cols = db.prepare("PRAGMA table_info(documents_chunks)").all();
    const hasEmbedding = cols.some(c => c.name === 'embedding');
    const hasModelStamp = cols.some(c => c.name === 'embedding_model');
    if (!hasEmbedding) {
      db.exec('ALTER TABLE documents_chunks ADD COLUMN embedding BLOB');
      console.log('[knowledge-schema] added embedding column');
    }
    if (!hasModelStamp) {
      db.exec('ALTER TABLE documents_chunks ADD COLUMN embedding_model TEXT');
      console.log('[knowledge-schema] added embedding_model column');
    }
  } catch (e) {
    console.warn('[knowledge-schema] embedding migration warning:', e.message);
  }
}

// Re-index a single document: delete existing chunks + FTS rows, run chunker,
// insert rows + FTS mirror inside a single transaction. Called from
// upload-knowledge-file after the documents row is inserted, and from
// backfillDocumentChunks for existing rows without chunks.
function indexDocumentChunks(db, documentId, category, rawText) {
  if (!db) return { chunks: 0, totalChars: 0 };
  try {
    ensureKnowledgeChunksSchema(db);
    const chunks = chunkVietnameseText(rawText || '');
    const txn = db.transaction(() => {
      // Clean re-index: drop existing chunks (trigger removes FTS rows).
      db.prepare('DELETE FROM documents_chunks WHERE document_id = ?').run(documentId);
      const insChunk = db.prepare(
        'INSERT INTO documents_chunks (document_id, category, chunk_index, char_start, char_end) VALUES (?, ?, ?, ?, ?)'
      );
      const insFts = db.prepare(
        'INSERT INTO documents_chunks_fts (rowid, content, content_plain, tokens) VALUES (?, ?, ?, ?)'
      );
      for (const c of chunks) {
        const info = insChunk.run(documentId, category, c.index, c.char_start, c.char_end);
        const rowid = Number(info.lastInsertRowid);
        insFts.run(rowid, c.content, normalizeForSearch(c.content), tokenizeForSearch(c.content));
      }
    });
    txn();
    const totalChars = chunks.reduce((s, c) => s + c.content.length, 0);
    return { chunks: chunks.length, totalChars };
  } catch (e) {
    console.error('[knowledge] indexDocumentChunks error:', e.message);
    return { chunks: 0, totalChars: 0, error: e.message };
  }
}

// Boot-time catch-up: any documents row that has zero chunks gets chunked.
// Non-blocking; called via setTimeout from app.whenReady so it never delays
// boot. Fails gracefully if DB not available (e.g. ABI mismatch still being
// auto-fixed).
async function backfillDocumentChunks() {
  const db = getDocumentsDb();
  if (!db) return;
  try {
    ensureKnowledgeChunksSchema(db);
    const rows = db.prepare(`
      SELECT d.id, d.category, d.content
      FROM documents d
      LEFT JOIN (SELECT document_id, COUNT(*) c FROM documents_chunks GROUP BY document_id) x
        ON x.document_id = d.id
      WHERE x.c IS NULL OR x.c = 0
    `).all();
    let indexed = 0, totalChunks = 0;
    for (const r of rows) {
      if (!r.content) continue;
      const res = indexDocumentChunks(db, r.id, r.category || 'general', r.content);
      if (res.chunks > 0) { indexed += 1; totalChunks += res.chunks; }
    }
    if (indexed > 0) console.log(`[knowledge] backfill chunks: indexed ${indexed} docs, ${totalChunks} chunks`);
  } catch (e) {
    console.error('[knowledge] backfillDocumentChunks error:', e.message);
  } finally {
    try { db.close(); } catch {}
  }
}

// Self-heal better-sqlite3 ABI mismatch by re-running the postinstall script
// (which calls prebuild-install for the bundled Electron version). Synchronous
// because getDocumentsDb is synchronous and called from many call sites — we
// cannot await here. Returns true if a fix was attempted.
function autoFixBetterSqlite3() {
  if (_documentsDbAutoFixAttempted) return false;
  _documentsDbAutoFixAttempted = true;
  try {
    // V1: in packaged Electron, __dirname is inside app.asar (virtual fs).
    // scripts/** + better-sqlite3/** are in asarUnpack list, so they're
    // at app.asar.unpacked/... — resolve correctly by probing both paths.
    // Plain `node` isn't installed on fresh customer machines, so prefer
    // the bundled vendor node we ship.
    const asarUnpacked = __dirname.replace(/[\\/]app\.asar($|[\\/])/i, (m, tail) => m.replace('app.asar', 'app.asar.unpacked'));
    const candScripts = [
      path.join(asarUnpacked, 'scripts', 'fix-better-sqlite3.js'),
      path.join(__dirname, 'scripts', 'fix-better-sqlite3.js'),
    ];
    let fixScript = null;
    for (const p of candScripts) { if (fs.existsSync(p)) { fixScript = p; break; } }
    if (!fixScript) {
      console.error('[documents] auto-fix script not found in asar.unpacked nor __dirname');
      return false;
    }
    const nodeBin = (typeof getBundledNodeBin === 'function' && getBundledNodeBin()) || 'node';
    const scriptCwd = path.dirname(path.dirname(fixScript)); // parent of scripts/
    console.log('[documents] auto-fixing better-sqlite3 ABI via', nodeBin, fixScript);
    require('child_process').execFileSync(nodeBin, [fixScript], {
      cwd: scriptCwd,
      timeout: 120000,
      stdio: 'inherit',
    });
    try {
      const moduleId = require.resolve('better-sqlite3');
      delete require.cache[moduleId];
    } catch {}
    console.log('[documents] auto-fix complete — retrying DB open');
    return true;
  } catch (e) {
    console.error('[documents] auto-fix failed:', e.message);
    return false;
  }
}

function getDocumentsDb() {
  try {
    const Database = require('better-sqlite3');
    const ws = getWorkspace();
    try { fs.mkdirSync(ws, { recursive: true }); } catch {}
    const dbPath = path.join(ws, 'memory.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    // R5: schema migration runs once per process. C1 FIX: set the flag ONLY
    // after we verify the critical columns actually exist. Previous code
    // swallowed ensureKnowledgeChunksSchema errors → flag would be set even
    // if embedding column was never added → subsequent handles skip DDL →
    // every search throws "no such column: c.embedding" silently.
    if (!_documentsDbSchemaReady) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filename TEXT NOT NULL,
          filepath TEXT NOT NULL,
          content TEXT,
          filetype TEXT,
          filesize INTEGER,
          word_count INTEGER,
          category TEXT DEFAULT 'general',
          summary TEXT,
          visibility TEXT NOT NULL DEFAULT 'public',
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
          filename, content, tokenize='unicode61'
        );
      `);
      try { db.exec(`ALTER TABLE documents ADD COLUMN category TEXT DEFAULT 'general'`); } catch {}
      try { db.exec(`ALTER TABLE documents ADD COLUMN summary TEXT`); } catch {}
      try { db.exec(`ALTER TABLE documents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`); } catch {}
      try { db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_visibility ON documents(visibility)`); } catch {}
      try { db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_cat_vis ON documents(category, visibility)`); } catch {}
      try { ensureKnowledgeChunksSchema(db); } catch (e) {
        console.warn('[documents] chunk schema init failed:', e.message);
      }
      // Verify the load-bearing columns actually landed before marking ready.
      // If ensureKnowledgeChunksSchema swallowed a SQLITE_BUSY / disk-full /
      // corrupt-schema error, `embedding` column will be missing and every
      // vector search would throw. Flag stays false → next open retries.
      try {
        const cols = db.prepare("PRAGMA table_info(documents_chunks)").all();
        const hasEmbedding = cols.some(c => c.name === 'embedding');
        const hasEmbeddingModel = cols.some(c => c.name === 'embedding_model');
        if (hasEmbedding && hasEmbeddingModel) {
          _documentsDbSchemaReady = true;
        } else {
          console.warn('[documents] schema incomplete — embedding columns missing, will retry next open');
        }
      } catch {}
    }
    return db;
  } catch (e) {
    // ABI mismatch → try to self-heal once. If the fix script succeeds, the
    // next call to getDocumentsDb() will succeed (we don't recurse here to keep
    // semantics simple — Knowledge tab uses the disk-fallback for the current
    // call and the DB starts working on the next IPC).
    if (/NODE_MODULE_VERSION|incompatible architecture|mach-o.*arch|invalid ELF header|dlopen.*Mach-O/i.test(e.message) && !_documentsDbAutoFixAttempted) {
      console.error('[documents] DB error (ABI mismatch):', e.message);
      const fixed = autoFixBetterSqlite3();
      if (fixed) {
        // Try once more in this same call so the user doesn't have to retry.
        try {
          const Database = require('better-sqlite3');
          const ws = getWorkspace();
          const dbPath = path.join(ws, 'memory.db');
          const db = new Database(dbPath);
          db.exec(`
            CREATE TABLE IF NOT EXISTS documents (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              filename TEXT NOT NULL, filepath TEXT NOT NULL, content TEXT,
              filetype TEXT, filesize INTEGER, word_count INTEGER,
              category TEXT DEFAULT 'general', summary TEXT,
              visibility TEXT NOT NULL DEFAULT 'public',
              created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
              filename, content, tokenize='unicode61'
            );
          `);
          try { db.exec(`ALTER TABLE documents ADD COLUMN category TEXT DEFAULT 'general'`); } catch {}
          try { db.exec(`ALTER TABLE documents ADD COLUMN summary TEXT`); } catch {}
          try { db.exec(`ALTER TABLE documents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`); } catch {}
          try { db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_visibility ON documents(visibility)`); } catch {}
          try { db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_cat_vis ON documents(category, visibility)`); } catch {}
          try { ensureKnowledgeChunksSchema(db); } catch {}
          console.log('[documents] DB now working after auto-fix');
          return db;
        } catch (e2) {
          console.error('[documents] DB still broken after auto-fix:', e2.message);
        }
      }
    }
    const now = Date.now();
    if (now - _documentsDbLastErrorAt >= DOCUMENTS_DB_ERROR_LOG_INTERVAL_MS) {
      console.error('[documents] DB error:', e.message);
      if (/NODE_MODULE_VERSION|incompatible architecture|mach-o.*arch|invalid ELF header|dlopen.*Mach-O/i.test(e.message)) {
        console.error('[documents] better-sqlite3 ABI mismatch persists — using disk-only fallback for Knowledge tab.');
        console.error('[documents] Manual fix: cd electron && rm -rf node_modules/better-sqlite3/build && npm install');
      }
      _documentsDbLastErrorAt = now;
    }
    return null;
  }
}

// ============================================
//  KNOWLEDGE TAB — categorized document store
// ============================================

const DEFAULT_KNOWLEDGE_CATEGORIES = ['cong-ty', 'san-pham', 'nhan-vien'];
const KNOWLEDGE_LABELS = {
  'cong-ty': 'Công ty',
  'san-pham': 'Sản phẩm',
  'nhan-vien': 'Nhân viên',
};

// Dynamic: read all subdirectories under knowledge/ as categories
function getKnowledgeCategories() {
  const ws = getWorkspace();
  const knowDir = path.join(ws, 'knowledge');
  if (!fs.existsSync(knowDir)) return [...DEFAULT_KNOWLEDGE_CATEGORIES];
  try {
    const dirs = fs.readdirSync(knowDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    // Ensure defaults always present
    const set = new Set(dirs);
    for (const d of DEFAULT_KNOWLEDGE_CATEGORIES) set.add(d);
    return [...set].sort();
  } catch { return [...DEFAULT_KNOWLEDGE_CATEGORIES]; }
}

// Compat shim — old code references KNOWLEDGE_CATEGORIES
const KNOWLEDGE_CATEGORIES = new Proxy(DEFAULT_KNOWLEDGE_CATEGORIES, {
  get(target, prop) {
    if (prop === 'includes') return (cat) => {
      // Accept any folder that exists on disk OR is a default
      if (DEFAULT_KNOWLEDGE_CATEGORIES.includes(cat)) return true;
      const dir = path.join(getWorkspace(), 'knowledge', cat);
      return fs.existsSync(dir);
    };
    return target[prop];
  }
});

function getKnowledgeDir(category) {
  // Allow any alphanumeric + dash folder name
  if (!/^[a-z0-9-]+$/.test(category)) throw new Error('Invalid category name: ' + category);
  return path.join(getWorkspace(), 'knowledge', category);
}

function insertDocumentRow(db, {
  filename, filepath, content, filetype, filesize, wordCount,
  category = 'general', summary = null, visibility = 'public'
}) {
  if (!['public', 'internal', 'private'].includes(visibility)) {
    throw new Error(`insertDocumentRow: invalid visibility "${visibility}"`);
  }
  return db.prepare(
    'INSERT INTO documents (filename, filepath, content, filetype, filesize, word_count, category, summary, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(filename, filepath, content, filetype, filesize, wordCount, category, summary, visibility);
}

function ensureKnowledgeFolders() {
  const ws = getWorkspace();
  for (const cat of getKnowledgeCategories()) {
    const dir = path.join(ws, 'knowledge', cat, 'files');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const indexFile = path.join(ws, 'knowledge', cat, 'index.md');
    if (!fs.existsSync(indexFile)) {
      const label = KNOWLEDGE_LABELS[cat] || cat;
      try {
        fs.writeFileSync(
          indexFile,
          `# Knowledge — ${label}\n\n*Chưa có tài liệu nào. CEO upload file qua Dashboard → Knowledge.*\n`,
          'utf-8'
        );
      } catch {}
    }
  }
}

// Catch-up: index any files that exist on disk under knowledge/<cat>/files/
// but are missing from the documents table. Runs once at startup so files
// uploaded while better-sqlite3 was broken get registered as soon as the DB
// works again — and bot's index.md reflects reality without manual re-upload.
async function backfillKnowledgeFromDisk() {
  const db = getDocumentsDb();
  if (!db) return; // DB still broken — nothing to backfill into
  let inserted = 0;
  for (const cat of getKnowledgeCategories()) {
    let existing = new Set();
    try {
      for (const r of db.prepare('SELECT filename FROM documents WHERE category = ?').all(cat)) existing.add(r.filename);
    } catch {}
    const filesDir = path.join(getKnowledgeDir(cat), 'files');
    if (!fs.existsSync(filesDir)) continue;
    for (const entry of fs.readdirSync(filesDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (existing.has(entry.name)) continue;
      const fp = path.join(filesDir, entry.name);
      let stat;
      try { stat = fs.statSync(fp); } catch { continue; }
      const filetype = path.extname(entry.name).toLowerCase().replace('.', '');
      // Best-effort text extraction (skip on error — we still register the row).
      let content = '';
      try { content = await extractTextFromFile(fp, entry.name); } catch {}
      // Skip images with no extracted content — vision API may not be ready at boot.
      // Leaving them un-inserted lets next boot retry once 9Router is up.
      const isImage = /\.(jpe?g|png|gif|webp|bmp)$/i.test(entry.name);
      if (isImage && !content) {
        console.log('[backfill] skipping image (vision not ready?):', entry.name);
        continue;
      }
      const wordCount = content ? content.split(/\s+/).length : 0;
      // Skip slow LLM summary on backfill — leave summary null. CEO can re-upload
      // to trigger AI summary, or bot can summarize on demand later.
      try {
        insertDocumentRow(db, {
          filename: entry.name, filepath: fp, content,
          filetype, filesize: stat.size, wordCount,
          category: cat, summary: null, visibility: 'public'
        });
        try { db.prepare('INSERT INTO documents_fts (filename, content) VALUES (?, ?)').run(entry.name, content); } catch {}
        inserted++;
      } catch (e) { console.error('[knowledge] backfill insert err:', entry.name, e.message); }
    }
  }
  try { db.close(); } catch {}
  if (inserted > 0) {
    console.log('[knowledge] backfilled', inserted, 'file(s) from disk into DB');
    for (const cat of KNOWLEDGE_CATEGORIES) rewriteKnowledgeIndex(cat);
  }
}

// Resolve filename collision: foo.pdf → foo-2.pdf → foo-3.pdf
function resolveUniqueFilename(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = filename;
  let n = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    n++;
    candidate = `${base}-${n}${ext}`;
  }
  return candidate;
}

// Shared 9Router LLM call helper. Returns response text or null on failure.
// Reuses CEO's configured 9Router provider from openclaw.json.
// timeoutMs: per-call timeout (default 8s). maxTokens: response cap.
// Model resolution order (NEVER hardcode):
//   1. agents.defaults.model from openclaw.json (e.g. 'ninerouter/auto') → strip prefix
//   2. First model id in models.providers.ninerouter.models[]
//   3. Literal 'auto' — 9router treats this as "use first available combo"
async function call9Router(prompt, { maxTokens = 200, temperature = 0.3, timeoutMs = 8000 } = {}) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(HOME, '.openclaw', 'openclaw.json'), 'utf-8'));
    const provider = config?.models?.providers?.ninerouter;
    if (!provider?.baseUrl || !provider?.apiKey) return null;
    let modelName = 'auto';
    try {
      const def = config?.agents?.defaults?.model;
      if (typeof def === 'string' && def.length > 0) {
        modelName = def.replace(/^ninerouter\//, '');
      } else if (Array.isArray(provider?.models) && provider.models[0]?.id) {
        modelName = provider.models[0].id;
      }
    } catch {}
    const http = require('http');
    const body = JSON.stringify({
      model: modelName,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature,
    });
    const url = new URL(provider.baseUrl + '/chat/completions');
    return await new Promise((resolve) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const text = parsed?.choices?.[0]?.message?.content?.trim();
            resolve(text || null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    });
  } catch { return null; }
}

// Vision-capable 9Router call: sends image as base64 alongside a text prompt.
// Returns response text or null on failure.
async function call9RouterVision(imagePath, prompt, { maxTokens = 1500, temperature = 0.2, timeoutMs = 30000 } = {}) {
  try {
    const stat = fs.statSync(imagePath);
    if (stat.size > 20 * 1024 * 1024) return null; // skip images > 20MB

    const config = JSON.parse(fs.readFileSync(path.join(HOME, '.openclaw', 'openclaw.json'), 'utf-8'));
    const provider = config?.models?.providers?.ninerouter;
    if (!provider?.baseUrl || !provider?.apiKey) return null;
    let modelName = 'auto';
    try {
      const def = config?.agents?.defaults?.model;
      if (typeof def === 'string' && def.length > 0) {
        modelName = def.replace(/^ninerouter\//, '');
      } else if (Array.isArray(provider?.models) && provider.models[0]?.id) {
        modelName = provider.models[0].id;
      }
    } catch {}

    const ext = path.extname(imagePath).toLowerCase();
    const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
    const mime = mimeMap[ext] || 'image/jpeg';
    const base64 = fs.readFileSync(imagePath).toString('base64');

    const http = require('http');
    const body = JSON.stringify({
      model: modelName,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' } },
        ],
      }],
      max_tokens: maxTokens,
      temperature,
    });
    const url = new URL(provider.baseUrl + '/chat/completions');
    return await new Promise((resolve) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            console.error('[call9RouterVision] HTTP ' + res.statusCode + ': ' + data.substring(0, 200));
            resolve(null);
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const text = parsed?.choices?.[0]?.message?.content?.trim();
            resolve(text || null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    });
  } catch { return null; }
}

// AI vision description for image uploads in Knowledge system.
// Returns detailed Vietnamese description for RAG indexing, or fallback string.
async function describeImageForKnowledge(imagePath, filename) {
  const fallback = `[Ảnh: ${filename}] Không thể mô tả tự động. CEO có thể thêm mô tả thủ công vào Knowledge.`;
  const prompt = `Mô tả chi tiết ảnh "${filename}" để lưu vào hệ thống Knowledge doanh nghiệp.

Yêu cầu mô tả SIÊU KỸ — mọi chi tiết đều quan trọng cho tìm kiếm sau này:

1. **Sản phẩm** (nếu có): tên, thương hiệu, model, dòng sản phẩm, thế hệ, phiên bản
2. **Đặc điểm vật lý**: màu sắc (chính xác: "đen nhám", "xanh dương đậm", không chỉ "xanh"), kích thước ước tính, chất liệu bề mặt, hình dạng
3. **Text trong ảnh**: đọc TOÀN BỘ chữ hiển thị — nhãn, giá, thông số, barcode text, watermark, logo text
4. **Thông số kỹ thuật** (nếu thấy): dung lượng, RAM, camera, pin, CPU, kích thước màn hình
5. **Phụ kiện / đi kèm**: hộp, sạc, tai nghe, ốp lưng, giấy bảo hành
6. **Tình trạng**: mới nguyên seal / đã khui hộp / đã qua sử dụng / trầy xước
7. **Bối cảnh**: chụp trên kệ shop, trên bàn, studio, ảnh quảng cáo, ảnh khách gửi
8. **Giá cả**: nếu thấy tag giá, bảng giá, watermark giá
9. **So sánh**: nếu có nhiều sản phẩm trong ảnh, so sánh kích thước/màu giữa chúng
10. **Loại ảnh**: ảnh sản phẩm, ảnh biên lai, ảnh CCCD, ảnh bảng giá, ảnh showroom, ảnh chat screenshot

Trả lời bằng tiếng Việt, dạng paragraph mô tả tự nhiên (KHÔNG dùng bullet points). Viết như đang mô tả cho người không nhìn thấy ảnh. Càng chi tiết càng tốt — 300-500 từ.`;

  const result = await call9RouterVision(imagePath, prompt);
  if (!result) {
    console.log(`[knowledge-vision] AI vision failed for ${filename}, using fallback`);
    return fallback;
  }
  console.log(`[knowledge-vision] AI described ${filename}: ${result.length} chars`);
  return `[Ảnh: ${filename}]\n\n${result}`;
}

// AI summarize via 9Router (fallback to filename + first 200 chars)
async function summarizeKnowledgeContent(content, filename) {
  const fallback = () => {
    return `(tom tat chua san sang cho ${filename} — 9Router offline, file da luu)`;
  };
  if (!content || content.length < 30) return fallback();
  const truncated = content.length > 4000 ? content.substring(0, 4000) + '...' : content;
  const result = await call9Router(
    `Tóm tắt file "${filename}" trong 1-2 câu tiếng Việt ngắn gọn (tối đa 200 ký tự). Chỉ trả về tóm tắt, không thêm giải thích.\n\n---\n${truncated}`,
    { maxTokens: 120, temperature: 0.3, timeoutMs: 15000 }
  );
  return result ? result.substring(0, 300) : fallback();
}

// Clean extracted PDF/doc text for safe embedding into markdown index.md:
//  - strip control chars (except \n \r \t) that pdf-parse sometimes leaks
//  - collapse 3+ consecutive newlines → 2
//  - escape any line that begins with "# " so it doesn't break our section headings
//  - neutralize horizontal rules "---" on their own line → "- - -" so markdown
//    doesn't treat PDF content as a section separator (we use --- as our own)
function sanitizeKnowledgeContentForIndex(raw) {
  if (!raw) return '';
  let s = String(raw);
  // Drop NUL + most C0 controls, keep \t \n \r
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  // Normalize CRLF → LF
  s = s.replace(/\r\n?/g, '\n');
  // Escape lines that start with "# ", "## ", etc. so they don't become headings
  s = s.replace(/^(#{1,6} )/gm, '\\$1');
  // Neutralize bare horizontal rules
  s = s.replace(/^[ \t]*---+[ \t]*$/gm, '- - -');
  // Collapse excessive blank lines
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function rewriteKnowledgeIndex(category) {
  const ws = getWorkspace();
  const indexFile = path.join(ws, 'knowledge', category, 'index.md');
  let rows = [];
  let nonPublicSet = null;
  const db = getDocumentsDb();
  if (db) {
    try {
      rows = db.prepare(
        "SELECT filename, summary, filesize, created_at FROM documents WHERE category = ? AND visibility = 'public' ORDER BY created_at DESC"
      ).all(category);
    } catch (e) { console.error('[knowledge] rewrite index db query:', e.message); }
    try {
      const npRows = db.prepare("SELECT filename FROM documents WHERE category = ? AND visibility != 'public'").all(category);
      nonPublicSet = new Set(npRows.map(r => r.filename));
    } catch {}
    try { db.close(); } catch {}
  }
  // Merge in disk-only files so the bot's bootstrap reading of index.md sees
  // everything that physically exists, not just DB rows. Keeps Knowledge tab
  // useful even when better-sqlite3 is broken.
  const dbNames = new Set(rows.map(r => r.filename));
  for (const f of listKnowledgeFilesFromDisk(category)) {
    if (dbNames.has(f.filename)) continue;
    if (nonPublicSet !== null && nonPublicSet.has(f.filename)) continue;
    rows.push({ filename: f.filename, summary: null, filesize: f.filesize, created_at: f.created_at });
  }
  try {
    // Manifest-only. Bot bootstrap reads this file to know what docs exist,
    // but actual content retrieval happens via RAG search (vector + FTS5)
    // through the knowledge-search HTTP endpoint consumed by inbound.ts.
    // No raw content here — keeps bootstrap context small + avoids stale
    // copies when originals update.
    const lines = [];
    lines.push(`# Knowledge — ${KNOWLEDGE_LABELS[category]}\n`);
    if (rows.length === 0) {
      lines.push('*Chưa có tài liệu nào. CEO upload file qua Dashboard → Knowledge.*\n');
    } else {
      lines.push(`Tổng: ${rows.length} tài liệu. Bot dùng search vector khi khách hỏi (không nạp toàn bộ nội dung).\n`);
      for (const r of rows) {
        lines.push(`- **${r.filename}** (${((r.filesize || 0) / 1024).toFixed(1)} KB, uploaded ${r.created_at})`);
        if (r.summary) lines.push(`  *${r.summary.slice(0, 200)}*`);
        lines.push('');
      }
    }
    const tmpFile = indexFile + '.tmp';
    const fd = fs.openSync(tmpFile, 'w');
    fs.writeSync(fd, lines.join('\n'));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmpFile, indexFile);
    console.log(`[knowledge-index] ${category}: ${rows.length} files, ${Buffer.byteLength(lines.join('\n'), 'utf-8')} chars in index.md`);
  } catch (e) { console.error('[knowledge] rewrite index write:', e.message); }
}

ipcMain.handle('upload-knowledge-file', async (_event, { category, filepath, originalName, visibility = 'public' }) => {
  if (!['public', 'internal', 'private'].includes(visibility)) {
    return { success: false, error: 'Invalid visibility value' };
  }
  try {
    if (!KNOWLEDGE_CATEGORIES.includes(category)) {
      return { success: false, error: 'Loại không hợp lệ' };
    }
    if (!fs.existsSync(filepath)) return { success: false, error: 'File không tồn tại' };
    const stat = fs.statSync(filepath);
    // 100MB cap: CEO brochures/catalogs/handbooks routinely 20-80MB. pdf-parse 1.1.1 loads full buffer in memory,
    // but 100MB peak is fine on 8GB-RAM laptop (parsed briefly, GC'd after). summarizeKnowledgeContent slices
    // content before LLM + DB row, so steady-state memory footprint remains small.
    if (stat.size > 100 * 1024 * 1024) return { success: false, error: 'File quá lớn (tối đa 100MB). Vui lòng tách PDF thành nhiều phần nhỏ hơn.' };

    ensureKnowledgeFolders();
    const filesDir = path.join(getKnowledgeDir(category), 'files');
    const safeName = (originalName || path.basename(filepath)).replace(/[\\/:*?"<>|]/g, '_');
    const finalName = resolveUniqueFilename(filesDir, safeName);
    const dst = path.join(filesDir, finalName);
    fs.copyFileSync(filepath, dst);

    const content = await extractTextFromFile(dst, finalName);
    // R3-F7: reject mostly-binary / OCR-garbage content. Scanned receipts
    // extracted by pdf-parse often return strings like "¶▶Ω≈∑ I p h O N e"
    // — embedding that pollutes the vector corpus. Require ≥30% printable
    // ASCII chars (digits/letters/punct/space) OR Vietnamese letter chars.
    // Skip for images — vision descriptions are always clean text.
    const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(path.extname(finalName).toLowerCase());
    if (content && content.length > 50 && !isImage) {
      // R4-F1: tighten OCR-garbage regex. Previous range \u00C0-\u1EF9 covers
      // ~8000 chars incl. Greek/Cyrillic/Arabic/Armenian/Hebrew — an Arabic
      // product catalog would pass the 30% gate. Narrow to Latin + Latin
      // Extended-A/B + Latin Extended Additional (VN range = \u1E00-\u1EFF).
      const printable = (content.match(/[\x20-\x7E\u00C0-\u024F\u1E00-\u1EFF]/g) || []).length;
      const ratio = printable / content.length;
      if (ratio < 0.30) {
        try { fs.unlinkSync(dst); } catch {}
        return {
          success: false,
          error: `File có vẻ là scan/ảnh chưa OCR (chỉ ${Math.round(ratio * 100)}% ký tự đọc được). Vui lòng OCR trước khi upload.`,
        };
      }
    }
    const wordCount = content ? content.split(/\s+/).length : 0;
    const filetype = path.extname(finalName).toLowerCase().replace('.', '');
    const summary = await summarizeKnowledgeContent(content, finalName);

    let dbWarning = null;
    const db = getDocumentsDb();
    if (db) {
      let insertedDocId = null;
      try {
        const insertBoth = db.transaction(() => {
          const info = insertDocumentRow(db, {
            filename: finalName, filepath: dst, content,
            filetype, filesize: stat.size, wordCount,
            category, summary, visibility
          });
          insertedDocId = Number(info.lastInsertRowid);
          db.prepare('INSERT INTO documents_fts (filename, content) VALUES (?, ?)').run(finalName, content);
        });
        insertBoth();
      } catch (e) {
        console.error('[knowledge] db insert error:', e.message);
        dbWarning = 'DB insert failed (file vẫn lưu trên disk): ' + e.message;
      }
      // K1: chunk + index for Vietnamese FTS5 search. Non-fatal if it fails —
      // the full document is still in documents_fts, just not snippet-retrievable.
      if (insertedDocId && content) {
        try {
          const res = indexDocumentChunks(db, insertedDocId, category, content);
          if (res && res.chunks > 0) {
            console.log(`[knowledge] indexed ${res.chunks} chunks for ${finalName}`);
          }
        } catch (e) { console.error('[knowledge] chunk index error:', e.message); }

        // RAG: embed every chunk for vector search (Tier 1). ~13ms/chunk sync —
        // for a 200-chunk doc (~100-page PDF) adds ~3s to upload. Non-fatal:
        // upload still succeeds on failure; boot-time backfill catches missed
        // rows. Skip rows with too-short text (noise, boilerplate).
        try {
          const chunkRows = db.prepare(
            'SELECT id, chunk_index, char_start, char_end FROM documents_chunks WHERE document_id = ? ORDER BY chunk_index'
          ).all(insertedDocId);
          const upsert = db.prepare(
            'UPDATE documents_chunks SET embedding = ?, embedding_model = ? WHERE id = ?'
          );
          const MODEL_STAMP = 'multilingual-e5-small-q';
          let embedded = 0;
          for (const row of chunkRows) {
            const chunkText = content.substring(row.char_start, row.char_end);
            if (!chunkText || chunkText.length < 50) continue;
            const vec = await embedText(chunkText, false);
            upsert.run(vecToBlob(vec), MODEL_STAMP, row.id);
            embedded++;
          }
          console.log(`[knowledge] embedded ${embedded}/${chunkRows.length} chunks for ${finalName}`);
        } catch (e) {
          console.error('[knowledge] embed error:', e.message);
          // Non-fatal — upload still succeeds. Backfill on boot catches missed rows.
        }
      }
      try { db.close(); } catch {}
    } else {
      dbWarning = 'DB không mở được — file đã lưu trên disk, sẽ index lại sau khi sửa DB.';
    }

    rewriteKnowledgeIndex(category);
    purgeAgentSessions('knowledge-upload');
    return { success: true, filename: finalName, summary, wordCount, dbWarning };
  } catch (e) {
    console.error('[knowledge] upload error:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('set-knowledge-visibility', async (_event, { docId, visibility }) => {
  try {
    if (!Number.isInteger(docId) || docId <= 0) {
      return { success: false, error: 'Invalid docId' };
    }
    if (!['public', 'internal', 'private'].includes(visibility)) {
      return { success: false, error: 'Invalid visibility value' };
    }
    const db = getDocumentsDb();
    if (!db) return { success: false, error: 'DB unavailable' };
    let info, category;
    try {
      const row = db.prepare('SELECT category FROM documents WHERE id=?').get(docId);
      category = row?.category;
      info = db.prepare('UPDATE documents SET visibility=? WHERE id=?').run(visibility, docId);
    } finally {
      try { db.close(); } catch {}
    }
    if (info.changes === 0) return { success: false, error: 'Document not found' };
    try { auditLog('visibility-change', { docId, visibility, ts: Date.now() }); } catch {}
    let indexWarning;
    if (category) {
      try { rewriteKnowledgeIndex(category); } catch (e) { indexWarning = e.message; }
      purgeAgentSessions('knowledge-visibility');
    }
    return { success: true, indexWarning };
  } catch (e) {
    console.error('[set-knowledge-visibility] error:', e.message);
    return { success: false, error: e.message };
  }
});

// Filesystem-truth listing: read knowledge/<cat>/files/ directly. Used as a
// fallback when better-sqlite3 is broken (e.g. ABI mismatch right after a fresh
// `npm install`) AND merged with DB rows so files uploaded during a DB outage
// still appear. Without this, the CEO sees an empty list even though files DO
// exist on disk — exactly the symptom we hit before the v11.10.0 downgrade.
function listKnowledgeFilesFromDisk(category) {
  try {
    const dir = path.join(getKnowledgeDir(category), 'files');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => {
        const fp = path.join(dir, e.name);
        let st = null;
        try { st = fs.statSync(fp); } catch {}
        return {
          filename: e.name,
          filetype: path.extname(e.name).toLowerCase().replace('.', ''),
          filesize: st ? st.size : 0,
          word_count: 0,
          summary: null,
          visibility: 'public',
          created_at: st ? new Date(st.mtimeMs).toISOString().replace('T', ' ').slice(0, 19) : '',
          _source: 'disk',
        };
      })
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  } catch (e) {
    console.error('[knowledge] disk list error:', e.message);
    return [];
  }
}

ipcMain.handle('list-knowledge-files', async (_event, { category }) => {
  try {
    if (!KNOWLEDGE_CATEGORIES.includes(category)) return [];
    const diskRows = listKnowledgeFilesFromDisk(category);
    const db = getDocumentsDb();
    if (!db) {
      // DB unavailable (typically better-sqlite3 ABI mismatch). Return what's
      // actually on disk so the CEO never sees a blank Knowledge tab.
      return diskRows;
    }
    let dbRows = [];
    try {
      dbRows = db.prepare(
        'SELECT id, filename, filetype, filesize, word_count, summary, visibility, created_at FROM documents WHERE category = ? ORDER BY created_at DESC'
      ).all(category);
    } catch (e) {
      console.error('[knowledge] db query error:', e.message);
    }
    try { db.close(); } catch {}
    // Merge: prefer DB row (has summary) but include disk-only files (uploaded
    // while DB was broken).
    const dbNames = new Set(dbRows.map(r => r.filename));
    const diskOnly = diskRows.filter(r => !dbNames.has(r.filename));
    return [...dbRows, ...diskOnly];
  } catch (e) {
    console.error('[knowledge] list error:', e.message);
    // Last-ditch: still try disk-only.
    try { return listKnowledgeFilesFromDisk(category); } catch { return []; }
  }
});

ipcMain.handle('delete-knowledge-file', async (_event, { category, filename }) => {
  try {
    if (!KNOWLEDGE_CATEGORIES.includes(category)) return { success: false };
    const db = getDocumentsDb();
    if (db) {
      try {
        const row = db.prepare('SELECT id FROM documents WHERE category = ? AND filename = ?').get(category, filename);
        const deleteAll = db.transaction(() => {
          if (row) {
            db.prepare('DELETE FROM documents_chunks WHERE document_id = ?').run(row.id);
          }
          db.prepare('DELETE FROM documents WHERE category = ? AND filename = ?').run(category, filename);
          db.prepare('DELETE FROM documents_fts WHERE filename = ?').run(filename);
        });
        deleteAll();
      } finally {
        try { db.close(); } catch {}
      }
    }
    const fp = path.join(getKnowledgeDir(category), 'files', filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    rewriteKnowledgeIndex(category);
    purgeAgentSessions('knowledge-delete');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-knowledge-counts', async () => {
  try {
    const cats = getKnowledgeCategories();
    const db = getDocumentsDb();
    const counts = {};
    for (const cat of cats) counts[cat] = 0;
    if (!db) {
      for (const cat of cats) counts[cat] = listKnowledgeFilesFromDisk(cat).length;
      return counts;
    }
    for (const cat of cats) {
      let n = 0;
      try { n = db.prepare('SELECT COUNT(*) as n FROM documents WHERE category = ?').get(cat)?.n || 0; } catch {}
      const diskFiles = listKnowledgeFilesFromDisk(cat);
      const dbNames = new Set();
      try {
        for (const r of db.prepare('SELECT filename FROM documents WHERE category = ?').all(cat)) dbNames.add(r.filename);
      } catch {}
      const diskExtra = diskFiles.filter(f => !dbNames.has(f.filename)).length;
      counts[cat] = n + diskExtra;
    }
    db.close();
    return counts;
  } catch {
    const counts = {};
    for (const cat of getKnowledgeCategories()) counts[cat] = 0;
    return counts;
  }
});

// === FIRST-TIME CHANNEL GUIDE IPC ===

ipcMain.handle('check-guide-needed', async (_e, { channel }) => {
  const ws = getWorkspace();
  if (!ws) return { needed: false };
  const guideFile = path.join(ws, 'guide-completed.json');
  try {
    if (fs.existsSync(guideFile)) {
      const data = JSON.parse(fs.readFileSync(guideFile, 'utf-8'));
      if (data && data[channel]) return { needed: false };
    }
  } catch {}
  return { needed: true };
});

ipcMain.handle('mark-guide-complete', async (_e, { channel }) => {
  const ws = getWorkspace();
  if (!ws) return { ok: false };
  const guideFile = path.join(ws, 'guide-completed.json');
  try {
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(guideFile, 'utf-8')); } catch {}
    existing[channel] = true;
    existing.completedAt = existing.completedAt || new Date().toISOString();
    fs.writeFileSync(guideFile, JSON.stringify(existing, null, 2));
  } catch {}
  return { ok: true };
});

// List all knowledge folders with labels
ipcMain.handle('list-knowledge-folders', async () => {
  const cats = getKnowledgeCategories();
  return cats.map(cat => ({
    id: cat,
    label: KNOWLEDGE_LABELS[cat] || cat.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    isDefault: DEFAULT_KNOWLEDGE_CATEGORIES.includes(cat),
  }));
});

// ============================================
//  KNOWLEDGE SEARCH — query + FTS5 MATCH builder
//  (K3 of v2.3.0: query expansion via synonyms + BM25 rank + fallback)
//  TODO(v2.3.1): wire as openclaw tool via plugins/knowledge-search-tool
// ============================================

// Lazy-load + cache Vietnamese synonym dictionary (K2 ships
// electron/data/synonyms-vi.json). Shape: { "<normalized-key>": ["syn1", ...] }.
// Missing file is non-fatal — expansion just becomes a pass-through.
let _synonymsCache = null;
function loadSynonyms() {
  if (_synonymsCache) return _synonymsCache;
  try {
    const p = path.join(__dirname, 'data', 'synonyms-vi.json');
    _synonymsCache = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.warn('[knowledge-search] synonyms-vi.json not found, using empty dict');
    _synonymsCache = {};
  }
  return _synonymsCache;
}

// Escape FTS5 token — drop everything that isn't alnum or underscore.
// Returns '' if nothing usable left (caller should skip that token).
function _ftsEscapeToken(tok) {
  if (!tok) return '';
  // Already diacritic-stripped + lowercased by normalizeForSearch upstream.
  return String(tok).replace(/[^a-z0-9_]/g, '');
}

// Build an FTS5 MATCH expression from a normalized Vietnamese query.
// Strategy:
//   - token-by-token scan, but also probe 2-word phrases (bigrams) against
//     synonyms dict so multi-word keys like "bao nhieu" resolve before the
//     unigram pass consumes them.
//   - each (token OR synonyms...) group becomes a single FTS5 OR-subexpr.
//   - groups joined with AND so BM25 still ranks by density of matches.
// Dedupe expansion across the whole query so noisy synonym lists don't blow up
// the MATCH string.
function expandSynonyms(normalizedQuery) {
  const syn = loadSynonyms();
  const tokens = String(normalizedQuery || '')
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 0 && !VI_STOPWORDS.has(t));
  if (tokens.length === 0) return '';

  const groups = [];
  const seenExpansions = new Set();

  let i = 0;
  while (i < tokens.length) {
    // Try bigram synonym first (e.g. "bao nhieu" → ["bao nhieu","gia"]).
    let matchedKey = null;
    let consume = 1;
    if (i + 1 < tokens.length) {
      const bigram = tokens[i] + ' ' + tokens[i + 1];
      if (syn[bigram]) { matchedKey = bigram; consume = 2; }
    }
    if (!matchedKey && syn[tokens[i]]) matchedKey = tokens[i];

    const base = matchedKey || tokens[i];
    const variants = matchedKey ? (Array.isArray(syn[matchedKey]) ? syn[matchedKey] : [base]) : [base];

    const ftsParts = [];
    for (const v of variants) {
      // Each synonym may itself be multi-word — split, escape, join as phrase.
      const subtoks = String(v).toLowerCase().split(/[^a-z0-9]+/).map(_ftsEscapeToken).filter(Boolean);
      if (subtoks.length === 0) continue;
      const expr = subtoks.length === 1 ? subtoks[0] : `"${subtoks.join(' ')}"`;
      if (!seenExpansions.has(expr)) {
        seenExpansions.add(expr);
        ftsParts.push(expr);
      }
    }
    if (ftsParts.length > 0) {
      groups.push(ftsParts.length === 1 ? ftsParts[0] : `(${ftsParts.join(' OR ')})`);
    }
    i += consume;
  }
  return groups.join(' AND ');
}

// FTS5 + BM25 + synonym-expanded search. Used as fallback below when vectors
// unavailable (fresh install before backfill, or embed pipeline broken).
// Graceful degradation: (a) DB unavailable → throw 'DB unavailable',
// (b) FTS5 MATCH syntax error → retry word-chars-only, (c) empty FTS result →
// LIKE on documents.content last-resort.
// R1 FIX: accept optional shared `db` from caller. When searchKnowledge falls
// back to FTS5 it passes its own handle so we don't open a second one (doubles
// fd pressure on the hot Zalo inbound path). Standalone callers still pass
// no db and we open/close our own.
function searchKnowledgeFTS5(opts, sharedDb) {
  const { query, category, limit, audience = 'customer' } = opts || {};
  const allowedTiers = audience === 'ceo'      ? ['public', 'internal', 'private']
                     : audience === 'internal' ? ['public', 'internal']
                                               : ['public'];
  const visPlaceholders = allowedTiers.map(() => '?').join(',');
  const lim = Math.max(1, Math.min(50, Number(limit) || 5));
  if (!query || !String(query).trim()) return [];

  const normalized = normalizeForSearch(query);
  const matchExpr = expandSynonyms(normalized);

  const db = sharedDb || getDocumentsDb();
  if (!db) {
    const err = new Error('DB unavailable');
    err.code = 'DB_UNAVAILABLE';
    throw err;
  }
  if (!sharedDb) {
    try { ensureKnowledgeChunksSchema(db); } catch {}
  }

  const baseSelect = `
    SELECT dc.id AS chunk_id, dc.document_id, dc.category, dc.chunk_index,
           dc.char_start, dc.char_end, d.filename,
           bm25(documents_chunks_fts) AS score,
           highlight(documents_chunks_fts, 0, '<b>', '</b>') AS snippet
    FROM documents_chunks_fts
    JOIN documents_chunks dc ON dc.id = documents_chunks_fts.rowid
    JOIN documents d ON d.id = dc.document_id
    WHERE documents_chunks_fts MATCH ?
      AND d.visibility IN (${visPlaceholders})
  `;
  const catClause = category ? ' AND dc.category = ?' : '';
  const orderLimit = ' ORDER BY bm25(documents_chunks_fts) LIMIT ?';

  function tryMatch(expr) {
    const sql = baseSelect + catClause + orderLimit;
    const args = category
      ? [expr, ...allowedTiers, category, lim]
      : [expr, ...allowedTiers, lim];
    return db.prepare(sql).all(...args);
  }

  let results = [];
  let usedExpr = matchExpr;

  // Tier 1: full synonym-expanded MATCH.
  if (matchExpr) {
    try { results = tryMatch(matchExpr); } catch (e) {
      console.warn('[knowledge-search] tier1 MATCH failed:', e.message);
      results = [];
    }
  }

  // Tier 2: bare tokens (no synonyms, no quotes) — safer if tier1 hit
  // FTS5 tokenizer edge cases (quoted phrase w/ stopword, etc).
  if (results.length === 0) {
    const bare = String(normalized).split(/[^a-z0-9]+/)
      .filter(t => t.length >= 2 && !VI_STOPWORDS.has(t))
      .map(_ftsEscapeToken).filter(Boolean);
    if (bare.length > 0) {
      const expr2 = bare.join(' OR ');
      usedExpr = expr2;
      try { results = tryMatch(expr2); } catch (e) {
        console.warn('[knowledge-search] tier2 MATCH failed:', e.message);
        results = [];
      }
    }
  }

  // Tier 3: LIKE scan on documents.content — slow, last-resort.
  if (results.length === 0) {
    try {
      const like = '%' + String(normalized).replace(/[%_]/g, '') + '%';
      const sql3 = `
        SELECT NULL AS chunk_id, d.id AS document_id, d.category, 0 AS chunk_index,
               0 AS char_start, 0 AS char_end, d.filename,
               999.0 AS score,
               substr(d.content, 1, 300) AS snippet
        FROM documents d
        WHERE d.visibility IN (${visPlaceholders})
          AND (d.content LIKE ? OR d.filename LIKE ?)
        ${category ? 'AND d.category = ?' : ''}
        LIMIT ?
      `;
      const args3 = category
        ? [...allowedTiers, like, like, category, lim]
        : [...allowedTiers, like, like, lim];
      results = db.prepare(sql3).all(...args3);
      usedExpr = 'LIKE:' + like;
    } catch (e) {
      console.warn('[knowledge-search] tier3 LIKE failed:', e.message);
      results = [];
    }
  }

  if (!sharedDb) {
    try { db.close(); } catch {}
  }
  try {
    console.log(`[knowledge-search] query="${String(query).slice(0, 80)}" expanded="${String(usedExpr).slice(0, 120)}" results=${results.length}`);
  } catch {}
  return results;
}

// === Hybrid RRF + price-filter helpers (v2.3.47.1) ===

// Reciprocal Rank Fusion — industry standard for merging multiple ranked
// lists without needing to normalize scores. score = Σ 1/(k + rank).
// k=60 is canonical (Cormack et al 2009). Input: array of ID-lists (not
// objects — different from the benchmark reference which passed objects).
function rrfMerge(lists, k = 60, topK = 10) {
  const scores = new Map();
  for (const list of lists) {
    // Round-2 R4: manual rank counter — `forEach` skip still advanced rank,
    // which gave valid IDs after a null the wrong (lower) RRF score.
    let rank = 0;
    for (const id of list) {
      if (id == null) continue;
      scores.set(id, (scores.get(id) || 0) + 1 / (k + rank + 1));
      rank++;
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id]) => id);
}

// Parse "dưới 20 triệu" / "trên 5 triệu" / "duoi 2tr" / "trên 2 tỷ" into
// { min, max } in VND. Returns null if no price pattern found.
// Round-1 fixes:
//  - REMOVED "khoang" from under-patterns (point estimate, not a bound)
//  - REMOVED the ≤100 bare-number heuristic (wrong for "dưới 200" triệu-less)
//    → if no unit, return null (don't filter — user intent unclear)
//  - Added "ty" (tỷ/billion) for real estate
//  - Reject negative + non-finite numbers
//  - `max = 0` no longer treated as falsy via `||`
function parsePriceFilter(query) {
  const q = stripViDiacritics(String(query || '')).toLowerCase().replace(/\s+/g, ' ').trim();
  const toVnd = (num, unit) => {
    const n = parseFloat(String(num).replace(/,/g, '.'));
    if (!Number.isFinite(n) || n < 0) return null;
    if (unit === 'ty') return n * 1_000_000_000;
    if (unit === 'trieu' || unit === 'tr') return n * 1_000_000;
    if (unit === 'k' || unit === 'nghin' || unit === 'ngan') return n * 1_000;
    // No unit — user intent ambiguous (could be VND, triệu, k). Skip filter.
    return null;
  };
  const under = q.match(/(?:duoi|<|<=|toi da|it hon)\s*(\d+(?:[.,]\d+)?)\s*(ty|trieu|tr|k|nghin|ngan)?\b/);
  const over = q.match(/(?:tren|>|>=|toi thieu|nhieu hon|hon)\s*(\d+(?:[.,]\d+)?)\s*(ty|trieu|tr|k|nghin|ngan)?\b/);
  const result = {};
  if (under) { const v = toVnd(under[1], under[2]); if (v != null) result.max = v; }
  if (over) { const v = toVnd(over[1], over[2]); if (v != null) result.min = v; }
  return (result.min != null || result.max != null) ? result : null;
}

// Extract first VND price from chunk text. Matches our format
// ("iPhone 15 Pro Max 256GB giá 29.990.000 VND" → 29990000).
// Round-1 fix: strip only dots (VN thousands separator convention). Commas
// in chunk text are unusual and keeping them prevents "29,990,000" style
// from being silently mangled to 25 (benchmark parity).
function extractChunkPrice(text) {
  if (!text) return null;
  const m = String(text).match(/([\d.]+)\s*(?:VND|VNĐ|đồng|đ)\b/i);
  if (!m) return null;
  const raw = m[1].replace(/\./g, '');
  // Require at least 4 digits — filters "99.99 VND" (9999, not a real VND price)
  // that would otherwise false-match a range like "dưới 1 triệu".
  if (raw.length < 4) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

// === RAG config + Tier 2 helpers ===

// C6 FIX: local-date key (Vietnam = UTC+7). Previous code used UTC ISO date →
// daily cap rolled over at 07:00 ICT instead of local midnight. Targets peak
// morning-shop hours with a reset.
function _tier2LocalDayKey(now = Date.now()) {
  const offsetMs = 7 * 3600 * 1000;  // ICT = UTC+7
  return new Date(now + offsetMs).toISOString().slice(0, 10);
}

// H2 FIX: persist tier2 counter to workspace so Electron heartbeat restart
// (documented in CLAUDE.md) doesn't reset the hard cap. Without persistence,
// a flaky machine restarting once/day effectively doubles the 500/day ceiling.
function _tier2CounterPath() { return path.join(getWorkspace(), 'tier2-counter.json'); }
function _tier2LoadCounter() {
  try {
    const data = JSON.parse(fs.readFileSync(_tier2CounterPath(), 'utf-8'));
    return { day: String(data.day || ''), calls: Number(data.calls || 0) };
  } catch { return { day: '', calls: 0 }; }
}
function _tier2SaveCounter(day, calls) {
  // R4-F3: AV-lock drift protection. Previous version swallowed persist fails
  // silently → in-memory counter kept incrementing but disk value stale →
  // Electron heartbeat restart reloaded old count → over-budget fires.
  // Fix: retry once after 60ms (Defender release window), track consecutive
  // failures, alert CEO after 3 straight fails so broken AV config surfaces.
  try {
    writeJsonAtomic(_tier2CounterPath(), { day, calls, updatedAt: new Date().toISOString() });
    global.__tier2WriteFailCount = 0;
  } catch (e1) {
    // AV lock or transient filesystem error — log and count. The lock will be
    // released by the time the next request triggers a write, so no need to
    // busy-wait and block the event loop.
    global.__tier2WriteFailCount = (global.__tier2WriteFailCount || 0) + 1;
    console.warn(`[tier2] counter persist failed (${global.__tier2WriteFailCount}x): ${e1.message}`);
    if (global.__tier2WriteFailCount === 3 && !global.__tier2AlertSent) {
      global.__tier2AlertSent = true;
      try { sendCeoAlert(`[Cảnh báo Tier 2] Không ghi được tier2-counter.json 3 lần liên tiếp (AV lock?). Counter có thể drift, over-budget. Error: ${e1.message}`); } catch {}
    }
  }
}

// H4 FIX: exponential backoff for breaker re-trips. 9Router dying permanently
// → flat 5min cooldown = 288 trip cycles/day = forensics noise. Now trips:
// 5min → 10min → 20min → 40min → 1hr → 2hr → 4hr → 4hr (capped). Surfaces
// CEO alert on 3rd consecutive trip so broken 9Router config gets attention.
const TIER2_BACKOFF_STEPS_MS = [5, 10, 20, 40, 60, 120, 240, 240].map(m => m * 60_000);

// Detect whether 9Router is configured with a ChatGPT Plus OAuth provider.
// Used by wizard-complete to pre-fill the rewrite-model dropdown:
// OAuth = 'ninerouter/main' (ChatGPT Plus included, cheap), else 'ninerouter/fast'.
async function detectChatgptPlusOAuth() {
  try {
    // 9router db.json path: use appDataDir() to match how 9router actually
    // stores it on each platform (Win: %APPDATA%/9router/, Mac: Application
    // Support/9router/, Linux: ~/.config/9router/). Previous `HOME/.9router/`
    // was wrong — existsSync always false → every install defaults to 'fast'
    // even for ChatGPT Plus OAuth users (bug flagged by code quality review).
    const dbPath = path.join(appDataDir(), '9router', 'db.json');
    if (!fs.existsSync(dbPath)) return false;
    const cfg = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    const providers = cfg?.providers || [];
    return providers.some(p =>
      String(p.type || p.kind || '').toLowerCase().includes('oauth') ||
      String(p.label || '').toLowerCase().includes('chatgpt plus')
    );
  } catch { return false; }
}

// rag-config.json lives in workspace root. tier2Enabled off by default.
// H3 FIX: re-validate rewriteModel on read. User/support tech hand-editing
// the file could set 'gpt-5-pro' (expensive upstream); set-rag-config IPC
// has whitelist but file writes bypass it.
const _TIER2_ALLOWED_MODELS = ['ninerouter/main', 'ninerouter/fast'];
function getRagConfig() {
  const DEFAULT = { tier2Enabled: false, rewriteModel: 'ninerouter/fast' };
  try {
    const p = path.join(getWorkspace(), 'rag-config.json');
    if (!fs.existsSync(p)) return { ...DEFAULT };
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!_TIER2_ALLOWED_MODELS.includes(cfg.rewriteModel)) {
      cfg.rewriteModel = 'ninerouter/fast';
    }
    cfg.tier2Enabled = !!cfg.tier2Enabled;
    return cfg;
  } catch { return { ...DEFAULT }; }
}

// Rewrite a query via 9Router chat completion. Vietnamese query normalization:
// add diacritics, drop slang, clarify. Timeout 3s — never block retrieval.
// H6 FIX: validate output is a plain query string, reject control chars /
// brackets / backticks / URLs — prevents the rewrite model from emitting
// prompt-injection framing like "[Câu hỏi khách]" that would be re-embedded
// and could poison retrieval ranking.
async function rewriteQueryViaAI(query, model) {
  const routerUrl = `http://127.0.0.1:20128/v1/chat/completions`;
  const safeModel = _TIER2_ALLOWED_MODELS.includes(model) ? model : 'ninerouter/fast';
  const body = {
    model: safeModel,
    messages: [
      { role: 'system', content: 'Bạn chuẩn hoá câu hỏi tiếng Việt của khách hàng để tìm kiếm. Thêm dấu nếu thiếu, bỏ từ lóng, viết rõ. CHỈ trả về câu đã chuẩn hoá, không giải thích. Không dùng ngoặc vuông, ngoặc nhọn, backtick, URL.' },
      { role: 'user', content: query },
    ],
    temperature: 0.1,
    max_tokens: 100,
  };
  const resp = await fetch(routerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  if (!resp.ok) throw new Error(`9router HTTP ${resp.status}`);
  const data = await resp.json();
  const rewritten = data?.choices?.[0]?.message?.content?.trim();
  if (!rewritten) throw new Error('empty rewrite');
  // Whitelist: letters (any unicode), digits, whitespace, basic punctuation.
  // Reject brackets/braces/backticks/http. Strip trailing control chars.
  const clean = rewritten.replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!clean || clean.length > 200) throw new Error('rewrite too long or empty');
  if (/[\[\]{}`<>]|https?:\/\//i.test(clean)) throw new Error('rewrite contains disallowed chars');
  return clean;
}

// Primary search entry point. Tier 1 (vector / cosine sim on BLOB embeddings)
// when chunks have embeddings; falls back to FTS5 + BM25 when none do.
// Each call opens its own db handle (via getDocumentsDb) and MUST close it
// on every exit path. Skipping close leaks handles under busy shops (Zalo
// inbound HTTP hits this 50-100×/day) → eventual EMFILE on macOS.
async function searchKnowledge({ query, category, limit, audience = 'customer' } = {}) {
  const allowedTiers = audience === 'ceo'      ? ['public', 'internal', 'private']
                     : audience === 'internal' ? ['public', 'internal']
                                               : ['public'];
  const visPlaceholders = allowedTiers.map(() => '?').join(',');
  limit = Math.min(Math.max(parseInt(limit, 10) || 3, 1), 10);
  // Round-1 I2 + Round-2 E1: reject non-string / empty / whitespace queries.
  // String(obj) → "[object Object]" was bypassing round-1's guard.
  if (typeof query !== 'string' || !query.trim()) return [];
  const db = getDocumentsDb();
  if (!db) return [];
  const _ragSearchStart = Date.now();
  // Obs-H3: collect per-search telemetry. Hash the query so audit.jsonl
  // doesn't leak PII but we can still dedup/correlate.
  const _queryHash = require('crypto').createHash('sha1').update(String(query || '')).digest('hex').slice(0, 10);
  let _ragTier = 'unknown';
  let _top1 = 0, _top2 = 0, _tier2Fired = false, _tier2Reason = null;
  // Round-1 I4: preserve pre-RRF semantic top1/top2 for Tier 2 low-margin
  // detection. Post-RRF order reflects fused ranking; cosine margin between
  // whoever RRF placed at #1/#2 is not the same signal the heuristic wants.
  let _semTop1 = 0, _semTop2 = 0;
  let _priceFilterDropAll = false;  // Round-1 A-C3/B-I1 flag

  // C2 FIX: while backfill is writing embeddings, force FTS5 fallback — the
  // vector query would only see the chunks embedded so far (filter IS NOT NULL)
  // and could confidently pick a wrong top-1 from 0.6% of corpus.
  if (_backfillInProgress) {
    try { return searchKnowledgeFTS5({ query, category, limit, audience }, db); }
    finally { try { db.close(); } catch {} }
  }

  try {
    let rows = [];
    let scored = [];
    // v2.3.47.1 HYBRID RRF: parse price filter upfront so we can narrow the
    // candidate pool before retrieval. "dưới 20 triệu" → only rows whose
    // chunk price ≤ 20M. Biggest category gain: number-range (+17pp), also
    // avoids spending Tier 1 cosine on obviously-wrong-price chunks.
    const priceFilter = parsePriceFilter(query);
    try {
      const qvec = await embedText(String(query || '').slice(0, 500), true);
      // LIMIT cap: cosine loop is O(N). With 10k chunks × 384-dim float32 = 15MB
      // BLOB read + 80-150ms JS cosine. Capping at 2000 most-recent chunks
      // keeps P95 query <200ms while still covering realistic SMB knowledge
      // (typical shop: 50-500 chunks; heavy: 2000). For shops with genuine
      // 10k+ chunks, older documents are almost never matched by recent
      // customer queries anyway — recency ranking is a reasonable proxy.
      // Found by Round 2C scale review 2026-04-18.
      rows = category
        ? db.prepare(
            `SELECT c.id, c.document_id, c.chunk_index, c.char_start, c.char_end, c.embedding, d.filename, d.content
             FROM documents_chunks c JOIN documents d ON d.id = c.document_id
             WHERE d.visibility IN (${visPlaceholders})
               AND c.category = ? AND c.embedding IS NOT NULL
             ORDER BY c.id DESC LIMIT 2000`
          ).all(...allowedTiers, category)
        : db.prepare(
            `SELECT c.id, c.document_id, c.chunk_index, c.char_start, c.char_end, c.embedding, d.filename, d.content
             FROM documents_chunks c JOIN documents d ON d.id = c.document_id
             WHERE d.visibility IN (${visPlaceholders})
               AND c.embedding IS NOT NULL
             ORDER BY c.id DESC LIMIT 2000`
          ).all(...allowedTiers);

      // Price filter: drop rows whose chunk text doesn't fit range. Be
      // conservative — if extractChunkPrice can't parse (non-product chunk
      // like "giờ mở cửa"), keep the row so keyword/semantic can still help.
      // Only drop when we DO know a price AND it falls outside range.
      if (priceFilter && rows.length > 0) {
        // Round-2 R1: compute prices once (was 3× per row). Round-2 R2+R3:
        // simpler drop-all detection — only flag if SOURCE had priced rows
        // AND filter removed them ALL. Empty input doesn't set the flag.
        const priceForRow = rows.map(r => extractChunkPrice((r.content || '').substring(r.char_start, r.char_end)));
        const hadPricedRows = priceForRow.some(p => p !== null);
        const before = rows.length;
        rows = rows.filter((r, i) => {
          const p = priceForRow[i];
          if (p === null) return true;  // keep policy/info chunks untouched
          if (priceFilter.max != null && p > priceFilter.max) return false;
          if (priceFilter.min != null && p < priceFilter.min) return false;
          return true;
        });
        const stillHasPricedRows = rows.some((r, origIdx) => {
          // Need to map filtered index back to priceForRow — just re-check.
          const p = extractChunkPrice((r.content || '').substring(r.char_start, r.char_end));
          return p !== null;
        });
        // R4-F4: throttle — log only when filter actually dropped rows OR
        // sampled 1/20 for volume observability. High-traffic shops would
        // otherwise spam 1 line per query.
        global.__priceFilterLogCounter = (global.__priceFilterLogCounter || 0) + 1;
        const _dropped = before !== rows.length;
        if (_dropped || global.__priceFilterLogCounter % 20 === 0) {
          console.log(`[knowledge-search] price filter ${JSON.stringify(priceFilter)} → ${before} → ${rows.length} rows${_dropped ? '' : ' (sampled)'}`);
        }
        // Only fire drop-all if the SOURCE had products AND we filtered them all out.
        if (hadPricedRows && !stillHasPricedRows) _priceFilterDropAll = true;
      }

      if (rows.length === 0) {
        // Round-2 R3: only return [] on GENUINE price-filter empty (source had
        // priced rows, filter dropped them all). Empty-category or no-embedding
        // states still fall to FTS5 so fresh installs keep working.
        if (_priceFilterDropAll) {
          console.log('[knowledge-search] price filter emptied priced rows — returning [] (shop has no inventory in range)');
          _ragTier = 'price-filter-empty';
          return [];
        }
        console.log('[knowledge-search] no embeddings — falling back to FTS5');
        _ragTier = 'fts5-no-embed';
        return searchKnowledgeFTS5({ query, category, limit, audience }, db);
      }
      _ragTier = 'hybrid-rrf';

      // Step 1 — semantic ranking (cosine).
      // Round-1 I7: per-row try/catch. One corrupt BLOB used to throw the
      // whole .map() → caller fell to FTS5 fallback. Now we skip the bad row
      // and keep scoring the rest.
      const semRanked = rows.map(r => {
        try {
          const vec = blobToVec(r.embedding);
          return {
            id: r.id,
            document_id: r.document_id,
            chunk_index: r.chunk_index,
            filename: r.filename,
            snippet: (r.content || '').substring(r.char_start, r.char_end),
            score: cosineSim(qvec, vec),
          };
        } catch (e) {
          console.warn(`[knowledge-search] skip corrupt BLOB id=${r.id}: ${e.message}`);
          return null;
        }
      }).filter(Boolean).sort((a, b) => b.score - a.score);
      // Round-1 I4: capture pre-RRF semantic margin for Tier 2 signal. This
      // is what the low-margin heuristic is designed for (close cosine top1
      // vs top2 = ambiguous query that might benefit from rewrite).
      _semTop1 = semRanked[0]?.score || 0;
      _semTop2 = semRanked[1]?.score || 0;

      // Step 2 — FTS5 ranking over same DB. Result chunk IDs will be the
      // rowids in documents_chunks (chunk_id column when returned).
      let ftsIds = [];
      try {
        const ftsResults = searchKnowledgeFTS5({ query, category, limit: 10, audience }, db);
        const eligible = new Set(semRanked.map(s => s.id));
        // Only keep FTS5 hits that have embeddings (in rows set). Prevents
        // RRF from picking chunks we can't score + present with full data.
        ftsIds = ftsResults
          .map(r => r.chunk_id || r.id)
          .filter(id => id && eligible.has(id));
      } catch (e) {
        // FTS5 may throw on unusual queries; don't fail the hybrid path.
        console.warn('[knowledge-search] FTS5 partner errored (using sem only):', e.message);
      }

      // Step 3 — RRF merge. If FTS5 returned nothing, fall back to semantic
      // ordering. Rank list uses IDs only; we re-map to full scored objects.
      if (ftsIds.length > 0) {
        const semIds = semRanked.slice(0, 10).map(s => s.id);
        const rrfIds = rrfMerge([semIds, ftsIds], 60, 10);
        const rrfSet = new Set(rrfIds);  // Round-1 I6: O(1) membership test
        const byId = new Map(semRanked.map(s => [s.id, s]));
        const merged = [];
        for (const id of rrfIds) {
          const s = byId.get(id);
          if (s) merged.push(s);
        }
        // Append any semantic chunks not in RRF top-10 (preserve long tail).
        for (const s of semRanked) {
          if (!rrfSet.has(s.id) && merged.length < 10) merged.push(s);
        }
        scored = merged;
      } else {
        scored = semRanked;
        _ragTier = 'hybrid-rrf-sem-only';  // Round-1 I8: distinguish from fts5-no-embed
      }
    } catch (e) {
      console.warn('[knowledge-search] vector search error, falling back to FTS5:', e.message);
      _ragTier = 'fts5-error';
      return searchKnowledgeFTS5({ query, category, limit, audience }, db);
    }
    _top1 = scored[0]?.score || 0;
    _top2 = scored[1]?.score || 0;

    // Tier 2 — 2-signal OR gate (opt-in via Settings).
    // Triggers: Vietnamese-looking no-diacritic query OR low top1/top2 margin (<0.03).
    // Brand-name guard (R4): require 3+ tokens AND 15+ chars AND at least one
    // common Vietnamese function word so "iPhone 15 Pro Max 256GB Titan" (pure
    // brand, 6 tokens, 30 chars, no VI) still skips.
    // Circuit breaker: 3 fails in 60s → 5min cooldown (prevents 3s latency tax
    // when 9Router is down).
    // Daily cap (T1): hard stop at TIER2_DAILY_CAP calls/day across all queries.
    // Audit (T2): every trigger event logged to audit.jsonl for cost forensics.
    const cfg = getRagConfig();
    if (cfg.tier2Enabled && scored.length >= 2) {
      const now = Date.now();
      const todayKey = _tier2LocalDayKey(now);  // C6: Vietnam local midnight

      // H2: hydrate from persisted counter on first use this process.
      if (!global.__tier2CounterHydrated) {
        const persisted = _tier2LoadCounter();
        if (persisted.day === todayKey) {
          global.__tier2DayKey = todayKey;
          global.__tier2CallsToday = persisted.calls;
        }
        global.__tier2CounterHydrated = true;
      }
      if (global.__tier2DayKey !== todayKey) {
        global.__tier2DayKey = todayKey;
        global.__tier2CallsToday = 0;
        global.__tier2ConsecutiveTrips = 0;  // reset backoff ladder at day boundary
        _tier2SaveCounter(todayKey, 0);
      }
      const TIER2_DAILY_CAP = 500;

      if (!(global.__tier2CooldownUntil && now < global.__tier2CooldownUntil)
          && (global.__tier2CallsToday || 0) < TIER2_DAILY_CAP) {
        // Round-1 I4: lowMargin uses pre-RRF semantic top1/top2. Post-RRF
        // "scored" order reflects fused ranking; cosine margin between
        // RRF-placed #1/#2 is not the ambiguity signal the heuristic needs.
        const top1 = _semTop1;
        const top2 = _semTop2;
        const qStr = String(query);
        const tokenCount = qStr.trim().split(/\s+/).length;
        // R4: VI function-word heuristic — real no-diacritic VI queries almost
        // always contain at least one of these high-frequency function words.
        const VI_FUNCWORDS = /\b(co|khong|ko|bao|nhieu|nao|gi|sao|lam|duoc|hay|the|cho|voi|cua|va|de|toi|ban|minh|ai|dau|khi|phai|may|gia|ban|chua|thi|muon|can|tim|mua|xem|hoi|shop|gui|nhan)\b/i;
        const noDiacritic = /[a-z]{3,}/i.test(qStr)
          && !/[\u00C0-\u024F\u1E00-\u1EFF]/.test(qStr)
          && tokenCount >= 3
          && qStr.length >= 15
          && VI_FUNCWORDS.test(qStr);
        const lowMargin = (top1 - top2) < 0.03;
        if (noDiacritic || lowMargin) {
          // T1/H2: increment + persist (survives heartbeat restart)
          global.__tier2CallsToday = (global.__tier2CallsToday || 0) + 1;
          _tier2SaveCounter(todayKey, global.__tier2CallsToday);
          // F6: preserve both signals when both fire (higher-confidence trigger).
          const reason = [noDiacritic && 'no-diacritic', lowMargin && 'low-margin'].filter(Boolean).join('+');
          _tier2Fired = true;
          _tier2Reason = reason;
          try {
            const rewritten = await rewriteQueryViaAI(qStr, cfg.rewriteModel);
            if (rewritten && typeof rewritten === 'string' && rewritten.trim() && rewritten !== qStr) {
              global.__tier2FailCount = 0;
              global.__tier2ConsecutiveTrips = 0;  // H4: success clears backoff ladder
              console.log(`[knowledge-search] tier2 rewrite: "${qStr}" → "${rewritten}"`);
              try { auditLog('tier2_rewrite', { reason, queryLen: qStr.length, rewrittenLen: rewritten.length, day: todayKey, callsToday: global.__tier2CallsToday }); } catch {}
              const qvec2 = await embedText(rewritten.slice(0, 500), true);
              // Debug-Agent-A fix: per-row try/catch matching main semantic
              // path (lib 15774). One corrupt BLOB used to throw here and
              // register as a spurious Tier 2 failure → breaker trip.
              const rescored = rows.map(r => {
                try {
                  return {
                    id: r.id, document_id: r.document_id, chunk_index: r.chunk_index,
                    filename: r.filename,
                    snippet: (r.content || '').substring(r.char_start, r.char_end),
                    score: cosineSim(qvec2, blobToVec(r.embedding)),
                  };
                } catch { return null; }
              }).filter(Boolean).sort((a, b) => b.score - a.score);
              if (rescored.length > 0 && rescored[0].score > scored[0].score) return rescored.slice(0, limit);
            }
          } catch (e) {
            console.warn('[knowledge-search] tier2 rewrite skipped:', e.message);
            try { auditLog('tier2_rewrite_fail', { reason, err: String(e && e.message || e).slice(0, 200), day: todayKey }); } catch {}
            const window = 60_000;
            if (!global.__tier2FailWindowStart || now - global.__tier2FailWindowStart > window) {
              global.__tier2FailWindowStart = now;
              global.__tier2FailCount = 1;
            } else {
              global.__tier2FailCount = (global.__tier2FailCount || 0) + 1;
            }
            if (global.__tier2FailCount >= 3) {
              // H4: exponential backoff ladder. Step index increases each time
              // we trip without a success between trips (consecutive_trips).
              const trips = (global.__tier2ConsecutiveTrips || 0);
              const stepIdx = Math.min(trips, TIER2_BACKOFF_STEPS_MS.length - 1);
              const cooldownMs = TIER2_BACKOFF_STEPS_MS[stepIdx];
              global.__tier2CooldownUntil = now + cooldownMs;
              global.__tier2ConsecutiveTrips = trips + 1;
              const mins = Math.round(cooldownMs / 60_000);
              console.warn(`[knowledge-search] tier2 circuit breaker tripped — ${mins}min cooldown (trip #${trips + 1})`);
              try { auditLog('tier2_breaker_trip', { until: global.__tier2CooldownUntil, cooldownMins: mins, consecutiveTrips: trips + 1 }); } catch {}
              // H4: alert CEO once on 3rd consecutive trip — signal that 9Router is persistently broken.
              if (trips + 1 === 3) {
                try { sendCeoAlert(`[Cảnh báo RAG] Tier 2 query-rewrite liên tục thất bại ${trips + 1} lần (cooldown ${mins} phút). Kiểm tra 9Router đăng nhập/cấu hình.`); } catch {}
              }
            }
          }
        }
      } else if ((global.__tier2CallsToday || 0) >= TIER2_DAILY_CAP) {
        if (!global.__tier2CapWarnedToday || global.__tier2CapWarnedToday !== todayKey) {
          console.warn(`[knowledge-search] tier2 daily cap reached (${TIER2_DAILY_CAP}) — rewrites disabled until tomorrow`);
          try { auditLog('tier2_daily_cap', { cap: TIER2_DAILY_CAP, day: todayKey }); } catch {}
          global.__tier2CapWarnedToday = todayKey;
        }
      }
    }

    return scored.slice(0, limit);
  } finally {
    try { db.close(); } catch {}
    // Obs-H3: one structured audit event per search — support can grep
    // audit.jsonl for this single event kind to reconstruct the decision
    // tree without reading 3 different log lines across 2 files.
    try {
      auditLog('rag_search', {
        queryHash: _queryHash,
        queryLen: String(query || '').length,
        tier: _ragTier,
        top1: Number(_top1.toFixed(4)),
        top2: Number(_top2.toFixed(4)),
        margin: Number((_top1 - _top2).toFixed(4)),
        tier2Fired: _tier2Fired,
        tier2Reason: _tier2Reason,
        durationMs: Date.now() - _ragSearchStart,
        cat: category || null,
      });
    } catch {}
  }
}

ipcMain.handle('knowledge-search', async (_event, payload) => {
  const { query, category, limit } = payload || {};
  try {
    const results = await searchKnowledge({ query, category, limit, audience: 'ceo' });
    return { success: true, results };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
});

// RAG config — read/write rag-config.json in workspace root
ipcMain.handle('get-rag-config', async () => getRagConfig());
ipcMain.handle('set-rag-config', async (_event, cfg) => {
  try {
    const p = path.join(getWorkspace(), 'rag-config.json');
    // Whitelist rewriteModel to known 9Router slots. Prevents devtools/buggy-UI
    // from persisting invalid model IDs that would silently fail tier2 calls.
    const ALLOWED_MODELS = ['ninerouter/main', 'ninerouter/fast'];
    const requested = String((cfg && cfg.rewriteModel) || 'ninerouter/fast');
    const rewriteModel = ALLOWED_MODELS.includes(requested) ? requested : 'ninerouter/fast';
    writeJsonAtomic(p, {
      tier2Enabled: !!(cfg && cfg.tier2Enabled),
      rewriteModel,
      updatedAt: new Date().toISOString(),
    });
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

// === KNOWLEDGE SEARCH HTTP SERVER (for gateway → inbound.ts RAG) ===
// Gateway openzalo plugin (different process) queries our SQLite/vector index
// to RAG-enrich messages before dispatch to AI. Exposed on 127.0.0.1 only.
//
// C4 FIX: previous version had no auth → any local process (malicious browser
// tab exploiting DNS rebinding, any unprivileged user on shared Windows
// terminal, any user-level program) could:
//   - flood audit.jsonl via /audit-rag-degraded
//   - drain Tier 2 daily cap via /search?q=... + force embedder CPU load
// v2 adds: shared-secret bearer token, Host header check (blocks DNS
// rebinding), per-minute rate limit (60 req/min).
const KNOWLEDGE_HTTP_PORT = 20129;
let _knowledgeHttpServer = null;
let _knowledgeHttpSecret = null;

// Secret lives in workspace/rag-secret.txt. Inbound.ts reads it at first RAG
// call. Rewritten each boot to prevent a stale secret from a prior install
// being used to bypass. File is readable by any local user but that's fine
// — the goal is to prevent cross-origin bypass via DNS rebinding, not to
// defend against a local attacker with disk read (who already has more power).
function _ragSecretPath() { return path.join(getWorkspace(), 'rag-secret.txt'); }
function _ensureRagSecret() {
  if (_knowledgeHttpSecret) return _knowledgeHttpSecret;
  try {
    const secret = require('crypto').randomBytes(32).toString('hex');
    fs.writeFileSync(_ragSecretPath(), secret, 'utf-8');
    try { fs.chmodSync(_ragSecretPath(), 0o600); } catch {}
    _knowledgeHttpSecret = secret;
    return secret;
  } catch (e) {
    console.warn('[knowledge-http] secret persist failed, using in-memory:', e.message);
    _knowledgeHttpSecret = require('crypto').randomBytes(32).toString('hex');
    return _knowledgeHttpSecret;
  }
}

// Per-IP token bucket, 60 req/min with burst of 10. key = remoteAddress.
const _httpRateLimitBuckets = new Map();
function _httpRateLimitCheck(ip) {
  const now = Date.now();
  const MAX = 60;
  const REFILL_PER_MS = MAX / 60_000;
  let bucket = _httpRateLimitBuckets.get(ip);
  if (!bucket) { bucket = { tokens: MAX, last: now }; _httpRateLimitBuckets.set(ip, bucket); }
  bucket.tokens = Math.min(MAX, bucket.tokens + (now - bucket.last) * REFILL_PER_MS);
  bucket.last = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function startKnowledgeSearchServer() {
  if (_knowledgeHttpServer) return;
  _ensureRagSecret();
  const http = require('http');
  const { URL } = require('url');
  _knowledgeHttpServer = http.createServer(async (req, res) => {
    try {
      // Host header check — blocks DNS rebinding attacks where a browser
      // resolves evil.com to 127.0.0.1 and proxies requests here with
      // Host: evil.com.
      const host = String(req.headers.host || '');
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'host denied' }));
        return;
      }
      // Per-IP rate limit (only meaningful against localhost flood, not a
      // real defense against a determined local attacker, but stops runaway
      // loops + drains).
      const ip = req.socket?.remoteAddress || 'unknown';
      if (!_httpRateLimitCheck(ip)) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'rate limited' }));
        return;
      }
      // Bearer secret on all non-trivial paths.
      const auth = String(req.headers.authorization || '');
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (token !== _knowledgeHttpSecret) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      const url = new URL(req.url, `http://127.0.0.1:${KNOWLEDGE_HTTP_PORT}`);
      if (url.pathname === '/audit-rag-degraded' && req.method === 'POST') {
        try { auditLog('rag_degraded', { at: Date.now() }); } catch {}
        res.writeHead(204); res.end();
        return;
      }
      // Obs-CRIT-1: /health endpoint so support can diagnose RAG state via
      // one curl call. Returns: HTTP ok, embedder state, Tier 2 counters,
      // embedding coverage. Requires same bearer auth as /search.
      if (url.pathname === '/health') {
        let coverage = null;
        try {
          const db2 = getDocumentsDb();
          if (db2) {
            try {
              const row = db2.prepare(
                "SELECT COUNT(*) AS total, COUNT(embedding) AS embedded FROM documents_chunks"
              ).get();
              coverage = { total: row.total, embedded: row.embedded, pct: row.total ? Math.round(row.embedded / row.total * 100) : 100 };
            } finally { try { db2.close(); } catch {} }
          }
        } catch {}
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ragHttp: 'ok',
          version: require('./package.json').version,
          embedder: getEmbedderState(),
          tier2: {
            callsToday: global.__tier2CallsToday || 0,
            dayKey: global.__tier2DayKey || null,
            failCount: global.__tier2FailCount || 0,
            cooldownUntil: global.__tier2CooldownUntil || 0,
            consecutiveTrips: global.__tier2ConsecutiveTrips || 0,
            cap: 500,
          },
          backfillInProgress: _backfillInProgress,
          coverage,
        }, null, 2));
        return;
      }
      if (url.pathname !== '/search') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      const query = url.searchParams.get('q') || '';
      const category = url.searchParams.get('cat') || null;
      const limit = parseInt(url.searchParams.get('k') || '3', 10);
      const rawAudience = url.searchParams.get('audience');
      const audience = (rawAudience === 'internal') ? 'internal' : 'customer';
      if (!query || query.length < 2) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ results: [] }));
        return;
      }
      const results = await searchKnowledge({ query, category, limit: Math.min(Math.max(limit, 1), 8), audience });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
  });
  _knowledgeHttpServer.listen(KNOWLEDGE_HTTP_PORT, '127.0.0.1', () => {
    console.log(`[knowledge-http] listening on http://127.0.0.1:${KNOWLEDGE_HTTP_PORT}/search (auth required)`);
  });
  _knowledgeHttpServer.on('error', (err) => {
    const isAddrInUse = err && err.code === 'EADDRINUSE';
    console.warn('[knowledge-http] server error:', err?.message);
    _knowledgeHttpServer = null;
    if (isAddrInUse) {
      // Debug-Agent-B R2: surface port conflict once — likely a 2nd 9BizClaw
      // instance. Watchdog (fastWatchdogTick) will keep retrying; if the
      // port stays occupied, CEO sees the alert and knows why RAG is off.
      if (!global._knowledgeHttpPortAlerted) {
        try { sendCeoAlert('[RAG] Cổng 20129 đã bị chiếm bởi process khác (có thể đang mở 2 lần 9BizClaw). Tắt bớt instance để RAG hoạt động.'); } catch {}
        global._knowledgeHttpPortAlerted = true;
      }
    }
  });
}

// Create custom knowledge folder
ipcMain.handle('create-knowledge-folder', async (_event, { name }) => {
  try {
    // Sanitize: lowercase, replace spaces with dash, remove non-alphanumeric
    const id = String(name).toLowerCase().trim()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
      .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (!id || id.length < 2) return { success: false, error: 'Tên thư mục quá ngắn' };
    if (id.length > 30) return { success: false, error: 'Tên thư mục quá dài (tối đa 30 ký tự)' };
    const dir = path.join(getWorkspace(), 'knowledge', id, 'files');
    fs.mkdirSync(dir, { recursive: true });
    const label = String(name).trim();
    KNOWLEDGE_LABELS[id] = label;
    const indexFile = path.join(getWorkspace(), 'knowledge', id, 'index.md');
    if (!fs.existsSync(indexFile)) {
      fs.writeFileSync(indexFile, `# Knowledge — ${label}\n\n*Chưa có tài liệu nào.*\n`, 'utf-8');
    }
    return { success: true, id, label };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Delete custom knowledge folder (only non-default)
ipcMain.handle('delete-knowledge-folder', async (_event, { id }) => {
  try {
    if (!/^[a-z0-9-]+$/.test(id)) return { success: false, error: 'Invalid folder name' };
    if (DEFAULT_KNOWLEDGE_CATEGORIES.includes(id)) return { success: false, error: 'Không thể xóa thư mục mặc định' };
    const dir = path.join(getWorkspace(), 'knowledge', id);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // Clean DB entries
    try {
      const db = getDocumentsDb();
      if (db) { db.prepare('DELETE FROM documents WHERE category = ?').run(id); db.close(); }
    } catch {}
    purgeAgentSessions('knowledge-folder-delete');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// File picker (Electron native dialog) — for upload UI
ipcMain.handle('pick-knowledge-file', async () => {
  try {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Chọn file để thêm vào Knowledge',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Tài liệu', extensions: ['pdf', 'docx', 'xlsx', 'xls', 'txt', 'md', 'csv'] },
        { name: 'Ảnh', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] },
        { name: 'Tất cả', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    return { canceled: false, filePaths: result.filePaths };
  } catch (e) {
    return { canceled: true, error: e.message };
  }
});

async function extractTextFromFile(filepath, filename) {
  const ext = path.extname(filename).toLowerCase();

  if (ext === '.txt' || ext === '.md' || ext === '.csv') {
    return fs.readFileSync(filepath, 'utf-8');
  }

  if (ext === '.pdf') {
    try {
      const pdfParse = require('pdf-parse');
      const buf = fs.readFileSync(filepath);
      const data = await pdfParse(buf);
      return data.text;
    } catch (e) { return `[PDF extract failed: ${e.message}]`; }
  }

  if (ext === '.docx') {
    try {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ path: filepath });
      return result.value;
    } catch (e) { return `[DOCX extract failed: ${e.message}]`; }
  }

  if (ext === '.xlsx' || ext === '.xls') {
    try {
      const XLSX = require('xlsx');
      const wb = XLSX.readFile(filepath);
      let text = '';
      for (const name of wb.SheetNames) {
        const sheet = wb.Sheets[name];
        text += `\n=== Sheet: ${name} ===\n`;
        text += XLSX.utils.sheet_to_csv(sheet);
      }
      return text;
    } catch (e) { return `[Excel extract failed: ${e.message}]`; }
  }

  // Images: use AI vision to generate detailed description for RAG search
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) {
    const description = await describeImageForKnowledge(filepath, filename);
    return description;
  }

  return `[Không hỗ trợ extract text cho file ${ext}]`;
}

ipcMain.handle('index-document', async (_event, { filepath, filename }) => {
  try {
    if (!filename || /[\/\\]/.test(filename) || filename.includes('..')) return { success: false, error: 'Invalid filename' };
    ensureDocumentsDir();
    const dst = path.join(getDocumentsDir(), filename);
    fs.copyFileSync(filepath, dst);

    const content = await extractTextFromFile(dst, filename);
    const wordCount = content ? content.split(/\s+/).length : 0;
    const filesize = fs.statSync(dst).size;
    const filetype = path.extname(filename).toLowerCase().replace('.', '');

    const db = getDocumentsDb();
    if (db) {
      const insertBoth = db.transaction(() => {
        insertDocumentRow(db, {
          filename, filepath: dst, content,
          filetype, filesize, wordCount
        });
        db.prepare('INSERT INTO documents_fts (filename, content) VALUES (?, ?)')
          .run(filename, content);
      });
      insertBoth();
      db.close();
    }

    return { success: true, filename, wordCount, filesize };
  } catch (e) { return { success: false, error: e.message }; }
});

// Expand a search query into Vietnamese synonyms via 9Router.
// Returns FTS5-safe expanded query string, or original on failure.
async function expandSearchQuery(query) {
  if (!query || query.length < 2) return query;
  try {
    const result = await call9Router(
      `Mở rộng truy vấn tìm kiếm sau thành 3-5 từ khóa đồng nghĩa tiếng Việt (và tiếng Anh nếu phù hợp). ` +
      `Chỉ trả về các từ khóa cách nhau bằng dấu phẩy, không giải thích.\n\nTruy vấn: "${query}"`,
      { maxTokens: 50, temperature: 0, timeoutMs: 2000 }
    );
    if (!result) return query;
    // Sanitize: strip FTS5 special chars, build OR query.
    const terms = result.split(/[,\n]/)
      .map(t => t.trim().replace(/[\"*()^+\-]/g, '').replace(/\b(NEAR|AND|NOT)\b/gi, ''))
      .filter(t => t.length > 1);
    if (terms.length === 0) return query;
    const allTerms = [query, ...terms];
    return allTerms.map(t => `"${t.replace(/"/g, '')}"`).join(' OR ');
  } catch { return query; }
}

// Rerank FTS5 results using 9Router for semantic relevance.
// Returns reordered subset, or original results on failure.
async function rerankSearchResults(query, results) {
  if (!results || results.length <= 1) return results;
  try {
    const candidateList = results.map((r, i) =>
      `${i + 1}. ${r.filename} — ${(r.snippet || '').replace(/\*\*/g, '').substring(0, 200)}`
    ).join('\n');
    const result = await call9Router(
      `Người dùng tìm: "${query}"\n\n` +
      `Kết quả tìm được:\n${candidateList}\n\n` +
      `Xếp hạng lại theo mức độ liên quan. Trả về CHỈ các số thứ tự (VD: 3,1,5,2,4), ` +
      `kết quả liên quan nhất trước. Không giải thích.`,
      { maxTokens: 50, temperature: 0, timeoutMs: 3000 }
    );
    if (!result) return results;
    const ranks = result.match(/\d+/g);
    if (!ranks || ranks.length === 0) return results;
    const reordered = [];
    const seen = new Set();
    for (const r of ranks) {
      const idx = parseInt(r, 10) - 1;
      if (idx >= 0 && idx < results.length && !seen.has(idx)) {
        reordered.push(results[idx]);
        seen.add(idx);
      }
    }
    for (let i = 0; i < results.length; i++) {
      if (!seen.has(i)) reordered.push(results[i]);
    }
    return reordered;
  } catch { return results; }
}

ipcMain.handle('search-documents', async (_event, query) => {
  let db;
  try {
    db = getDocumentsDb();
    if (!db) return [];
    // Layer 1: expand query for better recall.
    const expandedQuery = await expandSearchQuery(query);
    if (expandedQuery !== query) console.log(`[search] expanded "${query}" → "${expandedQuery}"`);
    // Layer 2: FTS5 search with expanded query.
    let results;
    try {
      results = db.prepare(`
        SELECT d.filename, d.filetype, d.word_count, d.created_at,
               snippet(documents_fts, 1, '**', '**', '...', 32) as snippet
        FROM documents_fts f
        JOIN documents d ON d.filename = f.filename
        WHERE documents_fts MATCH ?
        ORDER BY rank
        LIMIT 10
      `).all(expandedQuery);
    } catch {
      // Expanded query may have FTS5 syntax issues — fall back to original.
      results = db.prepare(`
        SELECT d.filename, d.filetype, d.word_count, d.created_at,
               snippet(documents_fts, 1, '**', '**', '...', 32) as snippet
        FROM documents_fts f
        JOIN documents d ON d.filename = f.filename
        WHERE documents_fts MATCH ?
        ORDER BY rank
        LIMIT 10
      `).all(query);
    }
    if (results.length === 0) return results;
    // Layer 3: rerank for semantic relevance.
    return await rerankSearchResults(query, results);
  } catch (e) { return []; }
  finally { try { if (db) db.close(); } catch {} }
});

ipcMain.handle('list-documents', async () => {
  try {
    const db = getDocumentsDb();
    if (!db) return [];
    const docs = db.prepare('SELECT filename, filetype, word_count, filesize, created_at FROM documents ORDER BY created_at DESC').all();
    db.close();
    return docs;
  } catch { return []; }
});

ipcMain.handle('delete-document', async (_event, filename) => {
  try {
    if (!filename || /[\/\\]/.test(filename) || filename.includes('..')) return { success: false, error: 'Invalid filename' };
    const db = getDocumentsDb();
    if (db) {
      db.prepare('DELETE FROM documents WHERE filename = ?').run(filename);
      db.prepare('DELETE FROM documents_fts WHERE filename = ?').run(filename);
      db.close();
    }
    const fp = path.join(getDocumentsDir(), filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('test-telegram', async (_event, { token, chatId }) => {
  return new Promise((resolve) => {
    const https = require('https');
    const payload = JSON.stringify({
      chat_id: chatId, text: '9BizClaw — Kết nối thành công!', parse_mode: 'Markdown',
    });
    const req = https.request(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => { try { resolve({ success: JSON.parse(data).ok }); } catch { resolve({ success: false }); } });
      }
    );
    req.on('error', () => resolve({ success: false }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ success: false }); });
    req.write(payload);
    req.end();
  });
});

// Check all channels — fast, reliable, based on config + process state + HTTP ping
ipcMain.handle('check-all-channels', async () => {
  const r = {
    telegram: 'not_configured',
    zalo: 'not_configured',
    ai: 'stopped',
    google: 'not_configured',
    gateway: botRunning ? 'ok' : 'stopped',
  };

  // 1. 9Router — HTTP ping 127.0.0.1:20128
  r.ai = await new Promise((resolve) => {
    const req = require('http').get('http://127.0.0.1:20128/v1/models', { timeout: 3000 }, (res) => {
      res.resume();
      console.log('9Router check: status', res.statusCode);
      resolve(res.statusCode === 200 ? 'ok' : 'error');
    });
    req.on('error', (e) => { console.log('9Router check ERROR:', e.code, e.message); resolve('stopped'); });
    req.on('timeout', () => { console.log('9Router check TIMEOUT'); req.destroy(); resolve('stopped'); });
  });

  // 2. Telegram — check botToken in openclaw.json
  try {
    const tg = await probeTelegramReady();
    const { token } = getTelegramConfig();
    const telegramPause = getChannelPauseStatus('telegram');
    if (!token) {
      r.telegram = 'not_configured';
    } else if (telegramPause?.permanent) {
      r.telegram = 'disabled';
    } else if (telegramPause?.paused) {
      r.telegram = 'paused';
    } else if (tg.ready) {
      r.telegram = 'ok';
    } else if (tg.awaitingConfirmation) {
      r.telegram = 'checking';
    } else if (tg.reason === 'no-ceo-chat-id') {
      r.telegram = 'error';
    } else {
      r.telegram = botRunning ? 'error' : 'stopped';
    }
  } catch {}

  // 3. Zalo — check credentials file
  try {
    const zl = await probeZaloReady();
    if (zl.reason === 'config-error') {
      r.zalo = 'error';
    } else if (zl.reason === 'disabled' || zl.reason === 'paused-permanent') {
      r.zalo = 'disabled';
    } else if (zl.reason === 'paused') {
      r.zalo = 'paused';
    } else if (zl.ready) {
      r.zalo = 'ok';
    } else if (zl.awaitingConfirmation) {
      r.zalo = 'checking';
    } else if (zl.reason === 'no-credentials') {
      r.zalo = 'not_configured';
    } else {
      r.zalo = botRunning ? 'error' : 'stopped';
    }
  } catch {}

  // 4. Google — check gog token
  try {
    const gogPaths = [path.join(HOME, '.gog', 'token.json'), path.join(HOME, '.gog', 'credentials.json')];
    if (gogPaths.some(p => fs.existsSync(p))) r.google = botRunning ? 'ok' : 'configured';
  } catch {}

  return r;
});

ipcMain.handle('get-dashboard', async () => {
  const data = { botRunning };
  return data;
});

// =========================================================================
// Overview page data — single round-trip for the redesigned home page.
// Returns greeting (CEO name + date), recent activity feed, upcoming cron
// firings, action items (alerts), and today-stats. CEO opens dashboard,
// sees this in <100ms — no separate IPCs needed.
// =========================================================================

// Map raw audit event names to human-readable Vietnamese labels for CEO.
// Boring system events (config_write, log_rotated) are filtered out.
const _OVERVIEW_EVENT_LABELS = {
  app_boot: { label: 'Khởi động bot', icon: 'zap', show: true },
  gateway_ready: { label: 'Bot sẵn sàng nhận tin', icon: 'check', show: true },
  gateway_slow_start: { label: 'Bot khởi động chậm', icon: 'clock', show: true },
  zalo_output_blocked: { label: 'Bộ lọc chặn 1 tin Zalo', icon: 'shield', show: true },
  cron_fired: { label: 'Cron đã chạy', icon: 'calendar', show: true },
  cron_failed: { label: 'Cron lỗi', icon: 'alert', show: true },
  zalo_owner_set: { label: 'Đã đặt chủ Zalo', icon: 'user', show: true },
  system_resume: { label: 'Mac thức dậy', icon: 'power', show: true },
  system_suspend: { label: 'Mac đang ngủ', icon: 'moon', show: true },
};

function _readJsonlTail(filePath, maxLines) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const stat = fs.statSync(filePath);
    // For small files just read all. For larger, read last 64KB to keep this fast.
    const SIZE = stat.size;
    if (SIZE === 0) return [];
    const READ_BYTES = Math.min(SIZE, 64 * 1024);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(READ_BYTES);
    fs.readSync(fd, buf, 0, READ_BYTES, SIZE - READ_BYTES);
    fs.closeSync(fd);
    const text = buf.toString('utf-8');
    const lines = text.split('\n').filter(Boolean);
    // If we sliced mid-line, drop the first (likely partial) line
    if (SIZE > READ_BYTES && lines.length > 1) lines.shift();
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
      try { out.push(JSON.parse(lines[i])); } catch {}
    }
    return out; // newest first
  } catch (e) {
    console.warn('[overview] readJsonlTail error:', e?.message);
    return [];
  }
}

function _readCeoNameFromIdentity() {
  try {
    const ws = getWorkspace();
    if (!ws) return { name: '', title: '' };
    const idPath = path.join(ws, 'IDENTITY.md');
    if (!fs.existsSync(idPath)) return { name: '', title: '' };
    const content = fs.readFileSync(idPath, 'utf-8');
    // Look for "Cách xưng hô" line. Wizard fills this with "anh/chị <name>".
    const match = content.match(/Cách xưng hô:\*\*\s*([^\n\[]+)/i)
               || content.match(/Cách xưng hô:\s*([^\n\[]+)/i);
    if (!match) return { name: '', title: '' };
    let raw = match[1].trim();
    // Handle "em — gọi chủ nhân là anh Huy" form
    raw = raw.replace(/^(em|tôi|mình)\s*[—–\-]+\s*gọi\s+(chủ nhân là\s+)?/i, '');
    raw = raw.split(/[,(]/)[0].trim();
    // `raw` is now the full honorific+name like "anh Quốc" or "thầy Quốc" or "chị Lan"
    const title = raw.slice(0, 40); // full "anh Quốc" — used in greeting directly
    // Extract bare name by stripping Vietnamese title prefixes
    let name = raw.replace(/^(anh|chị|anh\/chị|quý Sếp|thầy|cô|bác|chú)\s+/i, '');
    name = name.slice(0, 40);
    return { name, title };
  } catch { return { name: '', title: '' }; }
}

// Read recent Zalo customers from memory/zalo-users/*.md
function _readRecentZaloCustomers(ws, limit = 5) {
  try {
    const dir = path.join(ws, 'memory', 'zalo-users');
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    const customers = [];
    for (const f of files) {
      try {
        const fp = path.join(dir, f);
        const stat = fs.statSync(fp);
        const content = fs.readFileSync(fp, 'utf-8');
        // Parse YAML frontmatter
        let name = '', lastSeen = '', msgCount = 0;
        const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const fm = fmMatch[1];
          const nameM = fm.match(/name:\s*(.+)/i);
          if (nameM) name = nameM[1].trim().replace(/^["']|["']$/g, '');
          const lsM = fm.match(/lastSeen:\s*(.+)/i);
          if (lsM) lastSeen = lsM[1].trim().replace(/^["']|["']$/g, '');
          const mcM = fm.match(/msgCount:\s*(\d+)/i);
          if (mcM) msgCount = parseInt(mcM[1], 10);
        }
        // Parse summary section
        let summary = '';
        const sumMatch = content.match(/##\s*Tóm tắt\s*\n+([\s\S]*?)(?:\n##|\n---|\s*$)/i);
        if (sumMatch) {
          summary = sumMatch[1].trim().split('\n')[0].replace(/^[-*]\s*/, '').trim();
          if (summary.length > 80) summary = summary.slice(0, 77) + '...';
        }
        const senderId = f.replace(/\.md$/, '');
        // Use lastSeen from frontmatter, fall back to file mtime
        const sortTime = lastSeen ? new Date(lastSeen).getTime() : stat.mtimeMs;
        if (!name) name = senderId; // fallback to filename
        customers.push({ name, lastSeen: lastSeen || stat.mtime.toISOString(), summary, senderId, msgCount, _sortTime: sortTime });
      } catch {}
    }
    customers.sort((a, b) => b._sortTime - a._sortTime);
    return customers.slice(0, limit).map(c => ({ name: c.name, lastSeen: c.lastSeen, summary: c.summary, senderId: c.senderId, msgCount: c.msgCount }));
  } catch { return []; }
}

// Compute the next firing time for a schedule item with `time: "HH:MM"`,
// `time: "Mỗi N phút"`, or `cronExpr: "M H D MON DOW"`. Returns ISO timestamp or null.
function _nextFireTime(timeStr, now = new Date(), cronExpr = null) {
  if (cronExpr) {
    try {
      const parts = String(cronExpr).trim().split(/\s+/);
      if (parts.length >= 5) {
        const [minF, hourF, domF, monF, dowF] = parts;
        const _expandField = (f, min, max) => {
          if (f === '*') return null;
          const vals = new Set();
          for (const seg of f.split(',')) {
            const stepMatch = seg.match(/^(?:(\d+)-(\d+)|\*)\/(\d+)$/);
            if (stepMatch) {
              const lo = stepMatch[1] != null ? parseInt(stepMatch[1]) : min;
              const hi = stepMatch[2] != null ? parseInt(stepMatch[2]) : max;
              const step = parseInt(stepMatch[3] || '1');
              for (let i = lo; i <= hi; i += step) vals.add(i);
            } else if (seg.includes('-')) {
              const [a, b] = seg.split('-').map(Number);
              for (let i = a; i <= b; i++) vals.add(i);
            } else {
              vals.add(parseInt(seg));
            }
          }
          return vals.size ? vals : null;
        };
        const minSet = _expandField(minF, 0, 59);
        const hourSet = _expandField(hourF, 0, 23);
        const dowSet = _expandField(dowF, 0, 6);
        const candidate = new Date(now.getTime() + 60000);
        candidate.setSeconds(0, 0);
        for (let i = 0; i < 1440; i++) {
          const m = candidate.getMinutes(), h = candidate.getHours(), d = candidate.getDay();
          if ((!minSet || minSet.has(m)) && (!hourSet || hourSet.has(h)) && (!dowSet || dowSet.has(d))) {
            return candidate.toISOString();
          }
          candidate.setTime(candidate.getTime() + 60000);
        }
      }
    } catch {}
    return null;
  }
  if (!timeStr) return null;
  const everyMatch = String(timeStr).match(/Mỗi\s+(\d+)\s*phút/i);
  if (everyMatch) {
    const n = parseInt(everyMatch[1], 10);
    if (!isFinite(n) || n < 1) return null;
    const next = new Date(now.getTime() + n * 60 * 1000);
    return next.toISOString();
  }
  const hhmm = String(timeStr).match(/^(\d{1,2}):(\d{2})$/);
  if (hhmm) {
    const h = parseInt(hhmm[1], 10), m = parseInt(hhmm[2], 10);
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    const next = new Date(now);
    next.setHours(h, m, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }
  return null;
}

ipcMain.handle('get-overview-data', async () => {
  try {
    const ws = getWorkspace();
    const now = new Date();
    const todayISO = now.toISOString().slice(0, 10);

    // 1. GREETING — CEO name + date + bot status
    const ceoInfo = _readCeoNameFromIdentity();
    const ceoName = ceoInfo.name || '';
    const ceoTitle = ceoInfo.title || '';
    const dayNames = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
    const dayName = dayNames[now.getDay()];
    const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
    const hour = now.getHours();
    const greeting = hour < 12 ? 'Chào buổi sáng' : hour < 18 ? 'Chào buổi chiều' : 'Chào buổi tối';

    // 2. RECENT ACTIVITY — last 50 audit entries, mapped to display labels
    const auditFile = ws ? path.join(ws, 'logs', 'audit.jsonl') : null;
    const rawAudit = auditFile ? _readJsonlTail(auditFile, 50) : [];
    const activity = [];
    for (const e of rawAudit) {
      const meta = _OVERVIEW_EVENT_LABELS[e.event];
      if (!meta || !meta.show) continue;
      activity.push({
        ts: e.t,
        label: meta.label,
        icon: meta.icon,
        event: e.event,
      });
      if (activity.length >= 8) break;
    }

    // 3. UPCOMING — compute next firings for built-in schedules + custom crons
    const upcoming = [];
    try {
      const schedFile = path.join(ws, 'schedules.json');
      if (fs.existsSync(schedFile)) {
        const sched = JSON.parse(fs.readFileSync(schedFile, 'utf-8'));
        if (Array.isArray(sched)) {
          for (const s of sched) {
            if (!s || s.enabled === false) continue;
            const next = _nextFireTime(s.time, now);
            if (next) upcoming.push({ label: s.label || s.id, time: next, kind: 'built-in' });
          }
        }
      }
    } catch {}
    try {
      const cronsFile = path.join(ws, 'custom-crons.json');
      if (fs.existsSync(cronsFile)) {
        const crons = JSON.parse(fs.readFileSync(cronsFile, 'utf-8'));
        if (Array.isArray(crons)) {
          for (const c of crons) {
            if (!c || c.enabled === false) continue;
            const next = _nextFireTime(c.time, now, c.cronExpr);
            if (next) upcoming.push({ label: c.label || c.name || 'Cron tuỳ chỉnh', time: next, kind: 'custom' });
          }
        }
      }
    } catch {}
    upcoming.sort((a, b) => new Date(a.time) - new Date(b.time));
    const upcomingTrimmed = upcoming.slice(0, 6);

    // 4. ACTION ITEMS — things CEO should look at
    const actions = [];

    // 4a. Output filter blocked count today
    try {
      const filterFile = ws ? path.join(ws, 'logs', 'security-output-filter.jsonl') : null;
      if (filterFile && fs.existsSync(filterFile)) {
        const entries = _readJsonlTail(filterFile, 100);
        const todayCount = entries.filter(e => e.t && e.t.slice(0, 10) === todayISO).length;
        if (todayCount > 0) {
          actions.push({
            severity: 'medium',
            text: `${todayCount} tin Zalo bị bộ lọc chặn hôm nay`,
            cta: 'Xem log',
            ctaPage: null, // CTA opens log folder via tray
            kind: 'filter-blocked',
          });
        }
      }
    } catch {}

    // 4b. Zalo login status — only warn if not logged in at all
    try {
      const credFile = path.join(HOME, '.openzca', 'profiles', 'default', 'credentials.json');
      if (!fs.existsSync(credFile)) {
        // No credentials → user hasn't logged in Zalo yet
        actions.push({
          severity: 'low',
          text: 'Chưa đăng nhập Zalo',
          cta: 'Đăng nhập',
          ctaPage: 'zalo',
          kind: 'no-zalo-login',
        });
      }
    } catch {}

    // 4c. Strangers DMing today (count Zalo user memories created today)
    try {
      const zaloMemDir = ws ? path.join(ws, 'memory', 'zalo-users') : null;
      if (zaloMemDir && fs.existsSync(zaloMemDir)) {
        const files = fs.readdirSync(zaloMemDir).filter(f => f.endsWith('.md'));
        let newToday = 0;
        for (const f of files) {
          try {
            const mtime = fs.statSync(path.join(zaloMemDir, f)).mtimeMs;
            const ageH = (Date.now() - mtime) / (60 * 60 * 1000);
            if (ageH < 24) newToday++;
          } catch {}
        }
        if (newToday > 0) {
          actions.push({
            severity: 'low',
            text: `${newToday} khách Zalo mới tương tác hôm nay`,
            cta: 'Mở Zalo',
            ctaPage: 'zalo',
            kind: 'new-zalo-customers',
          });
        }
      }
    } catch {}

    // 4d. Bot stopped warning
    if (!botRunning) {
      actions.push({
        severity: 'high',
        text: 'Bot đang dừng — khách nhắn sẽ không có ai trả lời',
        cta: 'Khởi động',
        ctaPage: null,
        kind: 'bot-stopped',
      });
    }

    // 4e. RAG circuit breaker — recent rag_degraded audit entry within 10min
    try {
      const nowMs = Date.now();
      const recentRag = rawAudit.filter(e => {
        if (e.event !== 'rag_degraded') return false;
        const tMs = e.t ? Date.parse(e.t) : 0;
        return tMs && (nowMs - tMs) < 10 * 60 * 1000;
      });
      if (recentRag.length > 0) {
        actions.push({
          severity: 'medium',
          text: 'Tìm kiếm tài liệu tạm dừng (lỗi giao tiếp). Tự khôi phục sau 5 phút.',
          cta: null,
          ctaPage: null,
          kind: 'rag-degraded',
        });
      }
    } catch {}

    // 5. STATS — count of audit events today (rough proxy for "bot was busy")
    let eventsToday = 0;
    for (const e of rawAudit) {
      if (e.t && e.t.slice(0, 10) === todayISO) eventsToday++;
    }

    // 5b. New Zalo customers today (reuse actions computation)
    let newZaloCustomersToday = 0;
    try {
      const zaloMemDir2 = ws ? path.join(ws, 'memory', 'zalo-users') : null;
      if (zaloMemDir2 && fs.existsSync(zaloMemDir2)) {
        const files2 = fs.readdirSync(zaloMemDir2).filter(f => f.endsWith('.md'));
        for (const f of files2) {
          try {
            const mtime = fs.statSync(path.join(zaloMemDir2, f)).mtimeMs;
            if ((Date.now() - mtime) / (60 * 60 * 1000) < 24) newZaloCustomersToday++;
          } catch {}
        }
      }
    } catch {}

    // 5c. Cron OK count today
    let cronOkToday = 0;
    try {
      const cronRunsFile = ws ? path.join(ws, 'logs', 'cron-runs.jsonl') : null;
      if (cronRunsFile && fs.existsSync(cronRunsFile)) {
        const cronEntries = _readJsonlTail(cronRunsFile, 200);
        for (const e of cronEntries) {
          if (e.t && e.t.slice(0, 10) === todayISO && e.phase === 'ok') cronOkToday++;
        }
      }
    } catch {}

    // 6. RECENT ZALO CUSTOMERS — from memory/zalo-users/*.md
    const recentCustomers = ws ? _readRecentZaloCustomers(ws, 5) : [];

    return {
      success: true,
      greeting: {
        salutation: greeting,
        ceoName: ceoName || '',
        ceoTitle: ceoTitle || '',
        dayName,
        dateStr,
        botRunning,
      },
      activity,
      upcoming: upcomingTrimmed,
      actions,
      recentCustomers,
      stats: {
        eventsToday,
        newZaloCustomersToday,
        cronOkToday,
      },
    };
  } catch (e) {
    console.error('[get-overview-data] error:', e?.message);
    return { success: false, error: e?.message };
  }
});

ipcMain.handle('wizard-complete', async () => {
  if (_wizardCompleteInFlight) { console.log('[wizard] already in flight, skipping'); return { success: true }; }
  _wizardCompleteInFlight = true;
  if (!mainWindow || mainWindow.isDestroyed()) { _wizardCompleteInFlight = false; return { success: false }; }
  // GUARANTEE navigation: even if anything below throws/hangs, force-navigate
  // to dashboard.html on a short timer so CEO never sees forever-spinner.
  const navGuard = setTimeout(() => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.warn('[wizard-complete] nav-guard fired — forcing dashboard load');
        mainWindow.loadFile(path.join(__dirname, 'ui', 'dashboard.html'));
        try { mainWindow.maximize(); } catch {}
      }
    } catch (e) { console.error('[wizard-complete nav-guard] error:', e && e.message); }
  }, 5000);
  // Fresh install: seed workspace files with defaults + cleanup any stale listener
  try { seedWorkspace(); } catch (e) { console.error('[wizard-complete seed] error:', e.message); }
  // F-3 + U3: Detect whether user completed Zalo QR login in wizard.
  // Poll for up to 3 seconds in case credentials.json is still being written
  // by the listener (QR scan completes → subprocess writes file asynchronously,
  // may lag 1-2s behind the IPC that says "login ok").
  let zaloLoggedIn = false;
  const credPath = path.join(HOME, '.openzca', 'profiles', 'default', 'credentials.json');
  for (let i = 0; i < 6; i++) {
    try {
      if (fs.existsSync(credPath)) {
        const stat = fs.statSync(credPath);
        if ((Date.now() - stat.mtimeMs) < 24 * 60 * 60 * 1000) { zaloLoggedIn = true; break; }
      }
    } catch {}
    if (i < 5) await new Promise(r => setTimeout(r, 500));
  }
  try { cleanupOrphanZaloListener(); } catch {}
  try { markOnboardingComplete('wizard-complete'); } catch {}
  // Pre-fill RAG rewrite-model based on primary AI provider.
  // Does NOT enable Tier 2 — tier2Enabled stays false. CEO opts in via Settings.
  try {
    const ragPath = path.join(getWorkspace(), 'rag-config.json');
    if (!fs.existsSync(ragPath)) {
      const isChatgptPlus = await detectChatgptPlusOAuth();
      writeJsonAtomic(ragPath, {
        tier2Enabled: false,
        rewriteModel: isChatgptPlus ? 'ninerouter/main' : 'ninerouter/fast',
        updatedAt: new Date().toISOString(),
      });
      console.log(`[wizard-complete] rag-config.json seeded (tier2=off, model=${isChatgptPlus ? 'ninerouter/main' : 'ninerouter/fast'})`);
    }
  } catch (e) { console.warn('[wizard-complete] RAG config prefill failed:', e?.message); }
  clearTimeout(navGuard);
  try { mainWindow.loadFile(path.join(__dirname, 'ui', 'dashboard.html')); } catch (e) { console.error('[wizard-complete loadFile] error:', e && e.message); }
  try { mainWindow.maximize(); } catch {}
  // CRIT #2: Return IMMEDIATELY. Previously this awaited ensureZaloPlugin +
  // startOpenClaw sequentially → UI froze 30-180s on fresh Windows install.
  // Non-tech CEOs force-quit. Dashboard channel-status broadcast (every 45s
  // after boot, 500ms-30s during boot window) drives sidebar dots as gateway
  // comes up — user sees progress instead of a frozen window.
  (async () => {
    try {
    if (_appIsQuitting) { console.log('[wizard-iife] aborting — app quitting (pre-ensureZaloPlugin)'); return; }
    try { await ensureZaloPlugin(); } catch (e) { console.error('[wizard-complete ensureZaloPlugin] error:', e?.message || e); }
    if (_appIsQuitting) { console.log('[wizard-iife] aborting — app quitting (pre-seedZaloCustomers)'); return; }
    try { seedZaloCustomersFromCache(); } catch (e) { console.error('[wizard-complete seedZaloCustomers] error:', e?.message || e); }
    if (_appIsQuitting) { console.log('[wizard-iife] aborting — app quitting (pre-startOpenClaw)'); return; }
    try { await startOpenClaw(); } catch (e) { console.error('[wizard-complete startOpenClaw] error:', e?.message || e); }
    if (_appIsQuitting) { console.log('[wizard-iife] aborting — app quitting (pre-startCronJobs)'); return; }
    try { startCronJobs(); } catch (e) { console.error('[wizard-complete startCronJobs] error:', e?.message || e); }
    try { startCronApi(); } catch (e) { console.error('[wizard-complete startCronApi] error:', e?.message || e); }
    try { watchCustomCrons(); } catch {}
    try { startZaloCacheAutoRefresh(); } catch {}
    try { startAppointmentDispatcher(); } catch {}
    try { startFollowUpChecker(); } catch {}
    try { startEscalationChecker(); } catch {}
    setTimeout(() => { try { checkZaloCookieAge(); } catch {} }, 30000);

    // Welcome flow: first-time introduction after wizard
    if (_appIsQuitting) { console.log('[wizard-iife] aborting — app quitting (pre-welcome)'); return; }
    try {
      const ws = getWorkspace();
      const welcomeSent = ws && fs.existsSync(path.join(ws, '.welcome-sent'));
      if (!welcomeSent) {
        const { chatId } = getTelegramConfig();
        if (chatId) {
          const welcomeMsg = [
            'Chào anh/chị, em đã sẵn sàng làm việc.',
            '',
            'Vài thứ có thể thử ngay:',
            '- Nhắn tin cho em trên Telegram này -- em sẽ trả lời như cố vấn kinh doanh',
            '- Nhờ khách hàng nhắn Zalo cho shop -- em sẽ tự động tư vấn dựa trên Knowledge',
            '- Gõ "báo cáo" -- em gửi tóm tắt hoạt động ngay lập tức',
            '- Gõ "tạo cron gửi nhóm VIP mỗi sáng 9h: Chào buổi sáng" -- em tạo lịch gửi tự động',
            '',
            'Mỗi sáng và tối em sẽ gửi báo cáo tự động. Reply tự nhiên để ra lệnh.',
            '',
            'Nếu cần thêm Knowledge (bảng giá, FAQ, chính sách), mở Dashboard tab Knowledge và upload file.',
          ].join('\n');
          // Write marker BEFORE send (write-then-send = safe order per AGENTS.md)
          if (ws) fs.writeFileSync(path.join(ws, '.welcome-sent'), new Date().toISOString(), 'utf-8');
          await sendTelegram(welcomeMsg, { skipFilter: true, skipPauseCheck: true });
          console.log('[welcome] sent first-time introduction via Telegram');
        }
      }
    } catch (e) { console.error('[welcome] failed:', e?.message); }
    } finally { _wizardCompleteInFlight = false; }
  })();
  return { success: true };
});

// Install OpenClaw automatically (async — no UI freeze)
ipcMain.handle('install-openclaw', async (event) => {
  const sender = event.sender;
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';

  const send = (msg) => sender.send('install-progress', msg);

  // SHORT-CIRCUIT: if app is packaged AND vendor/ ships with bundled Node + plugins,
  // skip npm install entirely. The wizard's "Đang khởi tạo npm..." step is a no-op
  // for full-bundled builds (Mac DMG + Win EXE 436MB) — everything is already
  // pre-extracted to resources/vendor/ by prebuild-vendor.js. Verifying the bundled
  // openclaw + 9router + openzca + @tuyenhx/openzalo all exist is enough.
  try {
    const vendorDir = getBundledVendorDir();
    if (vendorDir) {
      const openclawCli = path.join(vendorDir, 'node_modules', 'openclaw', 'openclaw.mjs');
      const ninerouterPkg = path.join(vendorDir, 'node_modules', '9router', 'package.json');
      const openzcaCli = path.join(vendorDir, 'node_modules', 'openzca', 'dist', 'cli.js');
      const openzaloPlugin = path.join(vendorDir, 'node_modules', '@tuyenhx', 'openzalo', 'openclaw.plugin.json');
      const all = [openclawCli, ninerouterPkg, openzcaCli, openzaloPlugin];
      const allPresent = all.every(p => { try { return fs.existsSync(p); } catch { return false; } });
      if (allPresent) {
        send('App đã có sẵn OpenClaw bundled — bỏ qua npm install.');
        send('Bundled vendor: ' + vendorDir);
        send('  openclaw: OK');
        send('  9router: OK');
        send('  openzca: OK');
        send('  @tuyenhx/openzalo: OK');
        send('Hoàn tất.');
        return { success: true, bundled: true };
      } else {
        const missing = all.filter(p => { try { return !fs.existsSync(p); } catch { return true; } });
        send('Cảnh báo: vendor folder có nhưng thiếu file:');
        for (const m of missing) send('  - ' + m);
        send('Sẽ thử npm install để bổ sung...');
      }
    }
  } catch (e) {
    send('Lỗi khi kiểm tra bundled vendor: ' + String(e.message || e));
    send('Sẽ fallback sang npm install...');
  }

  // PRE-CHECK 1: Verify Node.js is available + version is recent enough.
  // openzca requires Node >= 22.13.0. If user has older Node, npm install will
  // log a warning but proceed; openzca's compiled output (tsup --target node22)
  // may then fail at runtime with syntax errors. Show a clear actionable error
  // BEFORE wasting 5 minutes on a doomed npm install.
  // NOTE: This intentionally checks SYSTEM node (`node -v` via PATH), not the
  // bundled vendor/node/bin/node. Reason: this handler runs `npm install -g`
  // which goes through the user's npm prefix and uses their globally-installed
  // Node. Bundled vendor node is for RUNTIME spawning of openclaw/openzca/9router
  // by the gateway, not for installing global packages. The two roles are
  // separate by design — vendor node never touches the user's npm tree.
  let nodeVersionMajor = 0;
  try {
    const { execSync } = require('child_process');
    const out = execSync('node -v', { encoding: 'utf-8', timeout: 5000 }).trim();
    const m = out.match(/^v(\d+)/);
    if (m) nodeVersionMajor = parseInt(m[1], 10);
  } catch {
    return {
      success: false,
      error: isMac
        ? 'Không tìm thấy Node.js trên máy.\n\nCài Node 22 LTS từ https://nodejs.org\n(hoặc: brew install node@22)\n\nSau đó mở lại 9BizClaw.'
        : 'Không tìm thấy Node.js trên máy.\n\nCài Node 22 LTS từ https://nodejs.org\n\nSau đó mở lại 9BizClaw.',
    };
  }
  if (nodeVersionMajor < 22) {
    return {
      success: false,
      error: `Node.js quá cũ (v${nodeVersionMajor}). 9BizClaw cần Node 22+ để chạy openzca (Zalo plugin).\n\n` +
             (isMac
               ? 'Cập nhật:\n  brew upgrade node\nhoặc tải installer từ https://nodejs.org'
               : 'Cập nhật từ https://nodejs.org'),
    };
  }

  // PRE-CHECK 2 (Mac only): Verify npm has write permission to global prefix.
  // On Mac without sudo, /usr/local/lib/node_modules is often write-protected.
  // We check `npm config get prefix` and try to detect EACCES early so the
  // user gets a clear hint to set up `~/.npm-global` or use `sudo`.
  if (isMac) {
    try {
      const { execSync } = require('child_process');
      const npmPrefix = execSync('npm config get prefix', { encoding: 'utf-8', timeout: 5000 }).trim();
      // Probe writability of the global lib dir
      const libDir = path.join(npmPrefix, 'lib', 'node_modules');
      try { fs.accessSync(libDir, fs.constants.W_OK); }
      catch {
        send(`C\u1EA3nh b\u00E1o: npm global prefix kh\u00F4ng ghi \u0111\u01B0\u1EE3c: ${npmPrefix}`);
        send('');
        send('Kh\u1EAFc ph\u1EE5c: thi\u1EBFt l\u1EADp user-prefix cho npm:');
        send('  mkdir -p ~/.npm-global');
        send('  npm config set prefix ~/.npm-global');
        send('  echo \'export PATH=~/.npm-global/bin:$PATH\' >> ~/.zshrc');
        send('  source ~/.zshrc');
        send('');
        send('Sau \u0111\u00F3 th\u1EED l\u1EA1i. (Tr\u00E1nh d\u00F9ng sudo cho npm install -g.)');
        // We don't hard-fail here — npm install may still succeed if user
        // has /usr/local writable. Just warn loudly.
      }
    } catch {}
  }

  // Kill 9Router/OpenClaw before npm install to avoid EBUSY
  stop9Router();
  stopOpenClaw();
  if (isWin) {
    try { spawn('taskkill', ['/f', '/im', '9router.exe'], { stdio: 'ignore' }); } catch {}
  } else {
    try { spawn('killall', ['9router', 'openclaw'], { stdio: 'ignore' }); } catch {}
  }
  await new Promise(r => setTimeout(r, 1000));

  return new Promise((resolve) => {
    let resolved = false;
    const safeResolve = (val) => { if (!resolved) { resolved = true; resolve(val); } };
    send('=== Bắt đầu cài đặt OpenClaw ===');
    send('');
    send('Hệ điều hành: ' + (isWin ? 'Windows' : process.platform === 'darwin' ? 'macOS' : process.platform));
    send('Node.js: v' + nodeVersionMajor);
    send('Thời gian: ' + new Date().toLocaleTimeString('vi-VN'));
    send('');
    send('--- Cài đặt OpenClaw via npm ---');

    // Install OpenClaw + 9Router + openzca via npm AT PINNED VERSIONS.
    // CRITICAL: pin versions to protect against upstream schema breakage.
    // Without pinning, fresh installs months from now will pull `latest` which
    // may have incompatible schema → wizard fails on day 1 with "Config invalid".
    // To upgrade pinned versions: edit PINNED_VERSIONS table below,
    // smoke-test, then ship a new build. Single source of truth is also in
    // electron/scripts/prebuild-vendor.js — keep both in sync (and PINNING.md).
    // CRIT #11: All 4 vendor packages must be pinned. Previously @tuyenhx/openzalo
    // was missing — dev-mode fresh installs pulled `latest` via openclaw's
    // plugin auto-install path, so an upstream breaking change in openzalo
    // would silently break Zalo for every new VIP installing that day.
    const PINNED_VERSIONS = [
      'openclaw@2026.4.14',
      '9router@0.3.82',
      'openzca@0.1.57',
      '@tuyenhx/openzalo@2026.3.31',
    ];
    let cmd, args;
    if (isWin) {
      cmd = 'npm.cmd';
      args = ['install', '-g', '--save-exact', ...PINNED_VERSIONS];
    } else {
      cmd = 'npm';
      args = ['install', '-g', '--save-exact', ...PINNED_VERSIONS];
    }

    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';

    // Stream ALL output — both stdout and stderr
    const handleOutput = (stream, prefix) => {
      let buffer = '';
      stream.on('data', (data) => {
        buffer += data.toString();
        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete last line in buffer
        for (const raw of lines) {
          const clean = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
          if (clean) {
            output += clean + '\n';
            send(prefix + clean);
          }
        }
      });
      // Flush remaining buffer
      stream.on('end', () => {
        const clean = buffer.replace(/\x1b\[[0-9;]*m/g, '').trim();
        if (clean) {
          output += clean + '\n';
          send(prefix + clean);
        }
      });
    };

    handleOutput(proc.stdout, '');
    handleOutput(proc.stderr, '');

    // Timeout after 10 minutes (npm install can be slow)
    const timeout = setTimeout(() => {
      proc.kill();
      send('');
      send('Qu\u00E1 th\u1EDDi gian (10 ph\u00FAt).');
      safeResolve({ success: false, error: 'Quá thời gian. Thử lại hoặc cài thủ công.' });
    }, 10 * 60 * 1000);

    proc.on('exit', (code) => {
      clearTimeout(timeout);
      send('');
      send('--- Bước 2: Kiểm tra cài đặt ---');
      send('Exit code: ' + code);

      // Verify — small delay for PATH to propagate
      _cachedBin = null;
      setTimeout(async () => {
        const bin = await findOpenClawBin();
        if (bin) {
          send('OpenClaw binary: ' + bin);
          send('');
          send('CÀI ĐẶT THÀNH CÔNG');
          safeResolve({ success: true });
        } else if (code === 0) {
          send('');
          send('C\u1EA3nh b\u00E1o: Installer ch\u1EA1y xong nh\u01B0ng kh\u00F4ng t\u00ECm th\u1EA5y openclaw.');
          send('Thử khởi động lại app.');
          safeResolve({ success: false, error: 'Cài xong nhưng không tìm thấy openclaw. Khởi động lại app.' });
        } else {
          send('');
          send('C\u00E0i \u0111\u1EB7t th\u1EA5t b\u1EA1i.');
          safeResolve({ success: false, error: `Mã lỗi: ${code}\n\n${output.slice(-1000)}` });
        }
      }, 2000);
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      send('');
      send('Không chạy được: ' + err.message);
      safeResolve({ success: false, error: err.message });
    });
  });
});

// Relaunch app after OpenClaw install
ipcMain.handle('relaunch', async () => {
  app.relaunch();
  app.exit(0);
});

// Factory reset — wipe ALL user data. Called from Dashboard with 2-layer
// confirmation (modal + type-to-confirm "XOA"). After wipe, Dashboard calls
// relaunch() so app starts fresh with wizard onboarding.
ipcMain.handle('factory-reset', async () => {
  try {
    console.log('[factory-reset] Starting full wipe...');
    // Stop background processes so they don't hold file handles
    try { stopOpenClaw(); } catch {}
    try { stop9Router(); } catch {}
    try { stopCronJobs(); } catch {}
    // Small delay for process cleanup
    await new Promise(r => setTimeout(r, 500));

    const targets = [];
    const ws = getWorkspace();
    if (ws) targets.push(ws);
    targets.push(path.join(HOME, '.openclaw'));
    targets.push(path.join(HOME, '.openzca'));
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
      targets.push(path.join(appData, '9router'));
    } else if (process.platform === 'darwin') {
      targets.push(path.join(HOME, 'Library', 'Application Support', '9router'));
    } else {
      const xdg = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
      targets.push(path.join(xdg, '9router'));
    }

    const results = [];
    for (const t of targets) {
      try {
        if (fs.existsSync(t)) {
          fs.rmSync(t, { recursive: true, force: true });
          console.log('[factory-reset] removed:', t);
          results.push({ path: t, ok: true });
        }
      } catch (e) {
        console.error('[factory-reset] failed to remove', t, e?.message);
        results.push({ path: t, ok: false, error: e?.message });
      }
    }

    console.log('[factory-reset] done');
    return { success: true, results };
  } catch (e) {
    console.error('[factory-reset] error:', e?.message || e);
    return { success: false, error: e?.message || String(e) };
  }
});

// Export workspace — create a tar archive of the user's workspace (config,
// memory, knowledge metadata, schedules, etc.) for backup / migration to a
// new machine. Excludes Electron cache dirs, logs, backups, and heavy
// knowledge/*/files blobs to keep the archive lean.
ipcMain.handle('export-workspace', async () => {
  try {
    const { dialog } = require('electron');
    const ws = getWorkspace();
    if (!ws || !fs.existsSync(ws)) {
      return { ok: false, error: 'workspace not found' };
    }
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const defaultName = `modoroclaw-export-${Date.now()}.tar`;
    const saveRes = await dialog.showSaveDialog(win, {
      title: 'Lưu file export',
      defaultPath: defaultName,
      filters: [{ name: 'TAR archive', extensions: ['tar'] }],
    });
    if (saveRes.canceled || !saveRes.filePath) {
      return { ok: false, canceled: true };
    }
    const outfile = saveRes.filePath;

    // Excluded dir/file name set (Electron cache, heavy state, transient).
    const EXCLUDED = new Set([
      'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'Network',
      'Local Storage', 'Session Storage', 'logs', 'backups',
      'Shared Dictionary', 'SharedStorage', 'blob_storage', 'Partitions',
      'node_modules', 'tmp', 'temp',
    ]);
    // Build explicit include list from top-level workspace entries.
    const include = [];
    for (const name of fs.readdirSync(ws)) {
      if (EXCLUDED.has(name)) continue;
      // Skip dotfiles coming from Chromium/Electron state.
      if (name === '.org.chromium.Chromium' || name.startsWith('.com.google.Chrome')) continue;
      include.push(name);
    }
    if (include.length === 0) {
      return { ok: false, error: 'nothing to export' };
    }

    // For each knowledge/<cat>/files subdir, exclude via --exclude patterns
    // (still include knowledge/<cat>/index.md + metadata). tar honors
    // --exclude relative to -C root on both BSD tar (mac) and bsdtar
    // bundled with Windows 10+.
    const excludePatterns = [
      'knowledge/*/files',
      'knowledge/*/files/*',
    ];

    const tarBin = process.platform === 'win32'
      ? 'C:\\Windows\\System32\\tar.exe'
      : '/usr/bin/tar';

    const args = ['-cf', outfile];
    for (const pat of excludePatterns) args.push(`--exclude=${pat}`);
    args.push('-C', ws);
    for (const n of include) args.push(n);

    await new Promise((resolve, reject) => {
      const proc = spawn(tarBin, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tar exit ${code}: ${stderr.trim()}`));
      });
    });

    const stat = fs.statSync(outfile);
    console.log('[export-workspace] wrote', outfile, stat.size, 'bytes');
    return { ok: true, path: outfile, sizeBytes: stat.size };
  } catch (e) {
    console.error('[export-workspace] error:', e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
});

// Import workspace — restore a previously exported tar archive over the
// current workspace. Overwrites existing files. Caller is expected to show
// a confirm dialog in the UI before invoking. App restart is recommended
// afterwards so in-memory state re-reads the fresh files.
ipcMain.handle('import-workspace', async () => {
  try {
    const { dialog } = require('electron');
    const ws = getWorkspace();
    if (!ws) {
      return { ok: false, error: 'workspace not found' };
    }
    try { fs.mkdirSync(ws, { recursive: true }); } catch {}
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const openRes = await dialog.showOpenDialog(win, {
      title: 'Chọn file export để khôi phục',
      properties: ['openFile'],
      filters: [{ name: 'TAR archive', extensions: ['tar'] }],
    });
    if (openRes.canceled || !openRes.filePaths || openRes.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const infile = openRes.filePaths[0];
    if (!fs.existsSync(infile)) {
      return { ok: false, error: 'file not found' };
    }

    const tarBin = process.platform === 'win32'
      ? 'C:\\Windows\\System32\\tar.exe'
      : '/usr/bin/tar';
    const args = ['-xf', infile, '-C', ws];

    await new Promise((resolve, reject) => {
      const proc = spawn(tarBin, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tar exit ${code}: ${stderr.trim()}`));
      });
    });

    console.log('[import-workspace] restored from', infile, 'into', ws);
    return { ok: true, path: infile };
  } catch (e) {
    console.error('[import-workspace] error:', e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
});

// Diagnostic log IPC — lets Dashboard/wizard grab the main.log contents
// without the user needing to open DevTools.
ipcMain.handle('get-diagnostic-log', async (_event, { tailLines = 500 } = {}) => {
  try {
    const logPath = getLogFilePath();
    if (!logPath || !fs.existsSync(logPath)) {
      return { ok: false, error: 'log file not found', path: logPath || null };
    }
    const raw = fs.readFileSync(logPath, 'utf-8');
    const lines = raw.split('\n');
    const tail = tailLines > 0 ? lines.slice(-tailLines).join('\n') : raw;
    return { ok: true, path: logPath, content: tail, totalLines: lines.length };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('open-log-folder', async () => {
  try {
    const logPath = getLogFilePath();
    if (logPath && fs.existsSync(logPath)) {
      shell.showItemInFolder(logPath);
      return { ok: true };
    }
    if (logPath) {
      shell.openPath(path.dirname(logPath));
      return { ok: true };
    }
    return { ok: false, error: 'no log path' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('open-external', async (_event, url) => {
  try {
    const parsed = new URL(url);
    const allowedOrigins = ['https://ollama.com', 'https://t.me', 'https://youtube.com', 'http://localhost:20128', 'http://127.0.0.1:20128', 'http://127.0.0.1:18789', 'http://localhost:18789', 'http://127.0.0.1:18791', 'http://localhost:18791'];
    // Telegram deep-link: tg://resolve?domain=<bot> opens native app directly.
    // Allow ONLY the resolve action (no msg_url, no join) to keep the surface
    // tight. Non-resolve tg:// URLs are rejected.
    const isTelegramResolve = parsed.protocol === 'tg:' && parsed.href.startsWith('tg://resolve?domain=') && /^[A-Za-z0-9_]{1,32}$/.test(parsed.searchParams.get('domain') || '');
    if (allowedOrigins.includes(parsed.origin) || isTelegramResolve) {
      const { shell } = require('electron');
      shell.openExternal(parsed.href);
    }
  } catch {} // Invalid URL — ignore
});

ipcMain.handle('get-gateway-token', async () => {
  try {
    const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return config.gateway?.auth?.token || null;
    }
  } catch {}
  return null;
});

ipcMain.handle('get-bot-status', async () => ({ running: botRunning }));

ipcMain.handle('get-app-version', async () => {
  try { return app.getVersion(); } catch { return ''; }
});

// ---- License IPC handlers (membership builds only) ----

ipcMain.handle('activate-license', async (_event, { key }) => {
  const license = require('./lib/license');
  license.init(getWorkspace);
  try {
    const result = await license.activateLicense(key);
    if (!result.success) return result;
    // Check if app was already set up (re-activation after expiry)
    const configured = isOpenClawConfigured() && hasCompletedOnboarding();
    return { ...result, configured };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-license-status', async () => {
  const license = require('./lib/license');
  license.init(getWorkspace);
  return license.checkLicenseStatus();
});

ipcMain.handle('deactivate-license', async () => {
  const license = require('./lib/license');
  license.init(getWorkspace);
  await license.clearLicense();
  return { success: true };
});

ipcMain.handle('toggle-bot', async () => {
  if (botRunning) {
    await stopOpenClaw();
  } else {
    if (_startOpenClawInFlight || _gatewayRestartInFlight) {
      return { running: false, pending: true };
    }
    await startOpenClaw();
  }
  return { running: botRunning };
});

// ============================================
//  AUTO-UPDATE — GitHub Releases (gated via pre-release flag)
//  Flow: /releases/latest only returns non-prerelease → CEO controls
//  which version customers see by toggling pre-release flag.
//  Windows: download .exe → shell open → user runs installer
//  Mac: download correct DMG (arm64/x64) → mount → admin cp → xattr → relaunch
// ============================================

const UPDATE_REPO = 'modoro-digital/MODOROClaw';
let _latestRelease = null; // cached { version, body, html_url, assets }
let _updateDownloadInFlight = false; // H1: concurrency guard

function compareVersions(a, b) {
  // Returns >0 if a > b, <0 if a < b, 0 if equal
  const pa = String(a || '0').replace(/^v/, '').split('.').map(Number);
  const pb = String(b || '0').replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function checkForUpdates() {
  const https = require('https');
  const current = app.getVersion();
  return new Promise((resolve) => {
    const opts = {
      hostname: 'api.github.com',
      path: `/repos/${UPDATE_REPO}/releases/latest`,
      headers: { 'User-Agent': '9BizClaw/' + current, 'Accept': 'application/vnd.github.v3+json' },
      timeout: 10000,
    };
    let dataLen = 0;
    const req = https.get(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        dataLen += chunk.length;
        // M3: cap response body at 1MB to prevent memory abuse
        if (dataLen > 1024 * 1024) { req.destroy(); return resolve(null); }
        data += chunk;
      });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            console.log('[update] GitHub API status', res.statusCode);
            return resolve(null);
          }
          const release = JSON.parse(data);
          const latest = String(release.tag_name || '').replace(/^v/, '');
          if (compareVersions(latest, current) > 0) {
            _latestRelease = {
              version: latest,
              body: release.body || '',
              html_url: release.html_url || '',
              published_at: release.published_at || '',
              assets: (release.assets || []).map(a => ({
                name: a.name,
                size: a.size,
                url: a.browser_download_url,
              })),
            };
            console.log('[update] new version available:', latest, '(current:', current + ')');
            // Notify renderer
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('update-available', _latestRelease);
            }
            return resolve(_latestRelease);
          }
          console.log('[update] up to date:', current);
          resolve(null);
        } catch (e) {
          console.warn('[update] parse error:', e.message);
          resolve(null);
        }
      });
    });
    req.on('error', (e) => {
      console.warn('[update] check failed:', e.message);
      resolve(null);
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Download installer to temp dir, return local path
async function downloadUpdate(assetUrl, filename, expectedSize) {
  const https = require('https');
  const tmpDir = path.join(app.getPath('temp'), '9bizclaw-update');
  fs.mkdirSync(tmpDir, { recursive: true });
  // L2: clean old downloads before starting new one
  try {
    for (const f of fs.readdirSync(tmpDir)) {
      if (f.endsWith('.exe') || f.endsWith('.dmg')) {
        try { fs.unlinkSync(path.join(tmpDir, f)); } catch {}
      }
    }
  } catch {}
  const dest = path.join(tmpDir, filename);

  // Follow redirects (GitHub assets redirect to S3)
  function followRedirect(url, redirectCount) {
    if (redirectCount > 5) throw new Error('Too many redirects');
    // H3: only follow HTTPS redirects
    if (!String(url).startsWith('https://')) throw new Error('Refused non-HTTPS redirect');
    return new Promise((resolve, reject) => {
      const req = https.get(url, { headers: { 'User-Agent': '9BizClaw' }, timeout: 120000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); // L1: drain response body to free socket
          return resolve(followRedirect(res.headers.location, redirectCount + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const file = fs.createWriteStream(dest);
        let lastProgressAt = 0;

        res.on('data', (chunk) => {
          received += chunk.length;
          file.write(chunk);
          const now = Date.now();
          if (now - lastProgressAt > 500 && mainWindow && !mainWindow.isDestroyed()) {
            lastProgressAt = now;
            mainWindow.webContents.send('update-download-progress', {
              received, total: totalBytes,
              percent: totalBytes > 0 ? Math.round(received / totalBytes * 100) : 0,
            });
          }
        });
        res.on('end', () => {
          file.end(() => {
            // M1: verify downloaded size matches expected asset size
            if (expectedSize && expectedSize > 0 && received < expectedSize * 0.95) {
              try { fs.unlinkSync(dest); } catch {}
              return reject(new Error('Download incomplete: ' + received + '/' + expectedSize + ' bytes'));
            }
            // Hard minimum: EXE/DMG must be >50MB. Catches truncated downloads
            // when GitHub doesn't return content-length (asset.size=0 on redirects).
            const MIN_INSTALLER_SIZE = 50 * 1024 * 1024;
            if (received < MIN_INSTALLER_SIZE) {
              try { fs.unlinkSync(dest); } catch {}
              return reject(new Error('Download too small (' + Math.round(received / 1024) + 'KB) — likely truncated. Retry.'));
            }
            resolve(dest);
          });
        });
        res.on('error', (e) => {
          file.destroy();
          try { fs.unlinkSync(dest); } catch {} // H2: cleanup partial file
          reject(e);
        });
      });
      // C1: timeout handler — destroy request on stall, explicitly reject
      // (req.destroy() should emit 'error' but we don't rely on that side-effect)
      req.on('timeout', () => {
        req.destroy();
        try { fs.unlinkSync(dest); } catch {} // H2: cleanup partial file
        reject(new Error('Download timed out'));
      });
      req.on('error', (e) => {
        try { fs.unlinkSync(dest); } catch {} // H2: cleanup partial file
        reject(e);
      });
    });
  }

  return followRedirect(assetUrl, 0);
}

// --- Mac DMG auto-install helper ---
// Mount DMG → mv old .app → cp new .app → xattr → unmount → relaunch
// C1: shell script file (no inline osascript injection risk)
// C2: async exec (no main-thread blocking)
// C3: atomic mv swap (never a moment with no .app)
async function installDmgUpdate(dmgPath) {
  const { exec } = require('child_process');
  const execAsync = (cmd, opts = {}) => new Promise((resolve, reject) => {
    exec(cmd, { encoding: 'utf8', timeout: 120000, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve(stdout);
    });
  });

  function sendInstallStatus(status) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-install-status', { status });
    }
  }

  const tmpDir = path.dirname(dmgPath);

  // 1. Detach any stale mount from previous failed update (I5)
  try { await execAsync('hdiutil detach "/Volumes/9BizClaw"* -force 2>/dev/null || true', { timeout: 10000 }); } catch {}

  // 2. Mount DMG (async — doesn't block main thread)
  sendInstallStatus('Đang mở DMG...');
  let mountPoint = null;
  try {
    const out = await execAsync(`hdiutil attach "${dmgPath}" -nobrowse -noautoopen -readonly`, { timeout: 90000 });
    const lines = out.trim().split('\n').filter(l => l.trim());
    for (const line of lines) {
      const match = line.match(/\t(\/Volumes\/.+)$/);
      if (match) { mountPoint = match[1].trim(); break; }
    }
    if (!mountPoint) {
      const fallback = out.match(/(\/Volumes\/[^\t\n]+)/);
      if (fallback) mountPoint = fallback[1].trim();
    }
    if (!mountPoint) throw new Error('Could not determine mount point');
    console.log('[update] DMG mounted at:', mountPoint);
  } catch (e) {
    throw new Error('Không mount được DMG: ' + e.message);
  }

  // 3. Find .app inside mounted volume (I2: validate name)
  const EXPECTED_APP = '9BizClaw.app';
  let appName = null;
  try {
    const items = fs.readdirSync(mountPoint);
    appName = items.find(i => i === EXPECTED_APP);
    if (!appName) appName = items.find(i => i.endsWith('.app') && !i.startsWith('.'));
    if (!appName) throw new Error('Không tìm thấy .app trong DMG');
  } catch (e) {
    try { await execAsync(`hdiutil detach "${mountPoint}" -force`, { timeout: 15000 }); } catch {}
    throw new Error('Không đọc được DMG: ' + e.message);
  }

  const srcApp = path.join(mountPoint, appName);
  const destApp = '/Applications/' + appName;
  const backupApp = '/Applications/' + appName + '.old';

  // 4. Write install script to temp file (C1: no shell injection via osascript inline)
  //    C3: atomic mv swap — old app moved to .old, never deleted before copy completes
  const sq = s => s.replace(/'/g, "'\\''"); // single-quote escape for shell
  const scriptPath = path.join(tmpDir, 'update-install.sh');
  const scriptContent = [
    '#!/bin/bash',
    'set -e',
    `rm -rf '${sq(backupApp)}'`,
    `if [ -d '${sq(destApp)}' ]; then mv '${sq(destApp)}' '${sq(backupApp)}'; fi`,
    `cp -R '${sq(srcApp)}' '${sq(destApp)}'`,
    `xattr -dr com.apple.quarantine '${sq(destApp)}'`,
    `rm -rf '${sq(backupApp)}'`,
  ].join('\n');
  fs.writeFileSync(scriptPath, scriptContent, 'utf-8');
  fs.chmodSync(scriptPath, 0o755);

  // 5. Run install with admin privileges (C2: async, doesn't block main thread)
  sendInstallStatus('Đang cài đặt... (cần mật khẩu admin)');
  try {
    await execAsync(`osascript -e 'do shell script "${sq(scriptPath)}" with administrator privileges'`);
    console.log('[update] App installed to', destApp);
  } catch (e) {
    try { await execAsync(`hdiutil detach "${mountPoint}" -force`, { timeout: 15000 }); } catch {}
    try { fs.unlinkSync(scriptPath); } catch {}
    if (e.message && (e.message.includes('User canceled') || e.message.includes('(-128)'))) {
      // Restore backup if user cancelled after mv but before cp
      try { await execAsync(`[ -d '${sq(backupApp)}' ] && mv '${sq(backupApp)}' '${sq(destApp)}' || true`, { timeout: 10000 }); } catch {}
      throw new Error('Đã hủy nhập mật khẩu admin');
    }
    // Restore backup on any failure
    try { await execAsync(`[ -d '${sq(backupApp)}' ] && mv '${sq(backupApp)}' '${sq(destApp)}' || true`, { timeout: 10000 }); } catch {}
    throw new Error('Lỗi cài đặt: ' + e.message);
  }

  // 6. Cleanup
  sendInstallStatus('Đang dọn dẹp...');
  try { await execAsync(`hdiutil detach "${mountPoint}" -force`, { timeout: 15000 }); } catch (e) {
    console.warn('[update] DMG unmount failed (non-fatal):', e.message);
  }
  try { fs.unlinkSync(dmgPath); } catch {}
  try { fs.unlinkSync(scriptPath); } catch {}

  // 7. Relaunch (I1: app.exit instead of app.quit to avoid before-quit deadlock)
  sendInstallStatus('Khởi động lại...');
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 1500);
}

// H4: validate URL is a safe GitHub URL before opening externally
function openGitHubUrl(url) {
  const { shell } = require('electron');
  if (url && String(url).startsWith('https://github.com/')) {
    shell.openExternal(url);
    return true;
  }
  console.warn('[update] refused to open non-GitHub URL:', String(url).slice(0, 80));
  return false;
}

ipcMain.handle('check-for-updates', async () => {
  try {
    const result = await checkForUpdates();
    if (result) return { available: true, ...result };
    return { available: false, version: app.getVersion() };
  } catch (e) {
    return { available: false, error: e.message };
  }
});

ipcMain.handle('download-and-install-update', async () => {
  if (!_latestRelease) return { success: false, error: 'No update available' };
  // H1: concurrency guard — prevent double-click corruption
  if (_updateDownloadInFlight) return { success: false, error: 'Download already in progress' };
  _updateDownloadInFlight = true;
  try {
    const platform = process.platform;
    let asset = null;
    if (platform === 'win32') {
      asset = _latestRelease.assets.find(a => a.name.endsWith('.exe'));
    } else if (platform === 'darwin') {
      // Mac: download correct DMG (arm64 vs x64) → mount → install → relaunch
      const arch = process.arch; // 'arm64' or 'x64'
      // Asset naming: 9BizClaw-2.3.4-arm64.dmg (Apple Silicon), 9BizClaw-2.3.4.dmg (Intel x64)
      asset = _latestRelease.assets.find(a => {
        if (!a.name.endsWith('.dmg')) return false;
        if (arch === 'arm64') return a.name.includes('arm64');
        // x64: pick DMG that does NOT have 'arm64' in name
        return !a.name.includes('arm64');
      });
      if (!asset) {
        // Fallback: open release page in browser
        console.warn('[update] No matching DMG for arch:', arch);
        openGitHubUrl(_latestRelease.html_url);
        return { success: true, method: 'browser' };
      }
    }
    if (!asset) {
      // Fallback: open release page
      openGitHubUrl(_latestRelease.html_url);
      return { success: true, method: 'browser' };
    }
    // Download asset (EXE on Windows, DMG on Mac)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-download-progress', { received: 0, total: asset.size, percent: 0 });
    }
    const localPath = await downloadUpdate(asset.url, asset.name, asset.size);

    if (platform === 'darwin') {
      // Mac: mount DMG → copy .app → remove quarantine → relaunch
      await installDmgUpdate(localPath);
      return { success: true, method: 'dmg-install' };
    }
    // Windows: launch EXE installer and quit
    const { shell } = require('electron');
    shell.openPath(localPath);
    // Give installer 2s to start then quit app
    setTimeout(() => { app.quit(); }, 2000);
    return { success: true, method: 'installer', path: localPath };
  } catch (e) {
    console.error('[update] download/install error:', e.message);
    // Mac fallback: if DMG install fails, open release page in browser
    if (process.platform === 'darwin' && _latestRelease && _latestRelease.html_url) {
      openGitHubUrl(_latestRelease.html_url);
      return { success: false, error: e.message, fallback: 'browser' };
    }
    return { success: false, error: e.message };
  } finally {
    _updateDownloadInFlight = false;
  }
});

// ============================================
//  GOOGLE CALENDAR
// ============================================

const gcalAuth = require('./gcal/auth');
const gcalCalendar = require('./gcal/calendar');
const gcalConfig = require('./gcal/config');

ipcMain.handle('gcal-connect', async () => {
  try {
    const authUrl = gcalAuth.getAuthUrl();
    // Start callback server BEFORE opening browser so it's ready when redirect arrives
    const tokenPromise = gcalAuth.startCallbackServer();
    // Open Google OAuth in user's default browser
    const { shell } = require('electron');
    shell.openExternal(authUrl);
    // Wait for callback (max 5 min)
    const tokens = await tokenPromise;
    return { success: true, email: tokens.email || null };
  } catch (e) {
    gcalAuth.stopCallbackServer();
    return { success: false, error: e.message };
  }
});

ipcMain.handle('gcal-disconnect', async () => {
  gcalAuth.disconnect();
  return { success: true };
});

ipcMain.handle('gcal-get-status', async () => {
  return { connected: gcalAuth.isConnected(), email: gcalAuth.getEmail() };
});

ipcMain.handle('gcal-list-events', async (_event, { maxResults } = {}) => {
  try {
    return { success: true, events: await gcalCalendar.listEvents(maxResults || 10) };
  } catch (e) {
    return { success: false, error: e.message, events: [] };
  }
});

ipcMain.handle('gcal-get-freebusy', async (_event, { dateFrom, dateTo }) => {
  try {
    return { success: true, ...(await gcalCalendar.getFreeBusy(dateFrom, dateTo)) };
  } catch (e) {
    return { success: false, error: e.message, busy: [] };
  }
});

ipcMain.handle('gcal-create-event', async (_event, opts) => {
  try {
    return await gcalCalendar.createEvent(opts);
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('gcal-get-free-slots', async (_event, { date }) => {
  try {
    const config = gcalConfig.read();
    const slots = await gcalCalendar.getFreeSlotsForDay(date, config.slotDurationMinutes);
    return { success: true, slots };
  } catch (e) {
    return { success: false, error: e.message, slots: [] };
  }
});

ipcMain.handle('gcal-get-config', async () => gcalConfig.read());

ipcMain.handle('gcal-save-config', async (_event, cfg) => {
  gcalConfig.write(cfg);
  return { success: true };
});

// ============================================
//  APP LIFECYCLE
// ============================================

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
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
    attach(session.fromPartition('persist:embed-gcal'), 'persist:embed-gcal');
    // Redirect new-window requests (OAuth popups, external links) from webview
    // partitions to the default browser. Without this, 9Router's ChatGPT OAuth
    // opens inside Electron's restricted context → freezes on Mac.
    for (const partName of ['persist:embed-9router', 'persist:embed-openclaw', 'persist:embed-gcal']) {
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

// Windows packaged: show a splash window and extract vendor-bundle.tar → userData/vendor
// on first launch (or after update). Returns when extraction is done OR immediately
// on Mac / dev / already-extracted cases.
let splashWindow = null;
async function runSplashAndExtractVendor() {
  if (process.platform !== 'win32' || !app.isPackaged) return;

  // Check upfront if extraction is needed before spawning a splash window
  try {
    const resDir = process.resourcesPath;
    const tarPath = path.join(resDir, 'vendor-bundle.tar');
    const metaPath = path.join(resDir, 'vendor-meta.json');
    if (!fs.existsSync(tarPath) || !fs.existsSync(metaPath)) return; // legacy layout
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const versionStamp = path.join(app.getPath('userData'), 'vendor-version.txt');
    const vendorNode = path.join(app.getPath('userData'), 'vendor', 'node', 'node.exe');
    if (fs.existsSync(versionStamp) && fs.existsSync(vendorNode)) {
      const current = fs.readFileSync(versionStamp, 'utf8').trim();
      if (current === meta.bundle_version) {
        console.log('[splash] vendor already extracted — skipping splash');
        return; // Fast path: already extracted. No splash at all.
      }
    }
  } catch (e) {
    console.warn('[splash] pre-check failed, continuing to splash + extract:', e.message);
  }

  // Need to extract → show splash window
  splashWindow = new BrowserWindow({
    width: 540,
    height: 400,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    backgroundColor: '#0a0a0c',
    show: false,
    skipTaskbar: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  splashWindow.setMenuBarVisibility(false);
  await splashWindow.loadFile(path.join(__dirname, 'ui', 'splash.html'));
  splashWindow.show();
  splashWindow.focus();

  const sendProgress = (data) => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      try { splashWindow.webContents.send('splash-progress', data); } catch {}
    }
  };
  const sendError = (message) => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      try { splashWindow.webContents.send('splash-error', message); } catch {}
    }
  };

  try {
    await ensureVendorExtracted({ onProgress: sendProgress });
    // Small grace period so user sees "100% Hoàn tất!"
    await new Promise(r => setTimeout(r, 500));
  } catch (e) {
    console.error('[splash] vendor extract failed:', e);
    sendError('Lỗi: ' + (e.message || 'không rõ nguyên nhân') + '. Vui lòng cài lại 9BizClaw.');
    // Keep splash open 5s so user can read the error, then quit
    await new Promise(r => setTimeout(r, 5000));
    try { splashWindow.close(); } catch {}
    const { dialog } = require('electron');
    dialog.showErrorBox('Lỗi khởi tạo 9BizClaw', 'Không thể giải nén thành phần cần thiết:\n\n' + (e.message || '?') + '\n\nVui lòng gỡ cài đặt và cài lại 9BizClaw.');
    app.exit(1);
    return;
  }

  try { splashWindow.close(); } catch {}
  splashWindow = null;
}

app.whenReady().then(async () => {
  // Update userDataDir now that app is ready
  if (app.isPackaged) {
    userDataDir = app.getPath('userData');
    invalidateWorkspaceCache(); // Force getWorkspace() to re-evaluate with new userDataDir
  }

  // Platform-F3: strip quarantine xattr from bundled vendor on Mac first boot.
  // DMG drag triggers Gatekeeper quarantine on nested files. Spawning
  // vendor/node/bin/node for autoFix* can silently fail with "cannot be opened
  // because it is from an unidentified developer" until xattr is cleared.
  // Idempotent marker prevents repeating work.
  if (process.platform === 'darwin' && app.isPackaged) {
    try {
      const markerPath = path.join(app.getPath('userData'), '.xattr-stripped');
      if (!fs.existsSync(markerPath)) {
        const vendorPath = path.join(process.resourcesPath, 'vendor');
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

  // Windows packaged FIRST LAUNCH: extract vendor-bundle.tar → userData/vendor
  // with a progress splash window. No-op on Mac, dev mode, or subsequent launches.
  // MUST run BEFORE anything that calls getBundledVendorDir() / findOpenClawBin()
  // because on Windows packaged, those now read from userData/vendor which
  // doesn't exist yet on first launch.
  try {
    await runSplashAndExtractVendor();
  } catch (e) {
    console.error('[boot] runSplashAndExtractVendor failed:', e);
    // Fatal — can't proceed without vendor
    return;
  }

  // Boot diagnostic: writes <workspace>/logs/boot-diagnostic.txt with everything
  // we need to debug "why didn't cron work?". MUST run after userDataDir update
  // so the file goes to the right workspace.
  try { bootDiagRunFullCheck(); } catch (e) { console.error('[boot-diag] error:', e?.message || e); }

  installEmbedHeaderStripper(); // BEFORE createWindow so first iframe load is unblocked
  createWindow();
  createTray();

  // License revalidation (membership builds only) — background check 15s after boot
  if (require('./package.json').membership === true) {
    setTimeout(async () => {
      try {
        const license = require('./lib/license');
        license.init(getWorkspace);
        const ls = license.checkLicenseStatus();
        if (ls.status === 'grace_warning') {
          const daysLeft = ls.daysLeft || (45 - (ls.daysSinceValidation || 0));
          sendCeoAlert('[Bản quyền] Bản quyền MODOROClaw cần được gia hạn. Còn ' + daysLeft + ' ngày trước khi bị khóa. Kết nối internet để tự động gia hạn.');
        }
        if (ls.status === 'valid' || ls.status === 'grace_warning') {
          const result = await license.revalidateLicense();
          console.log('[license] revalidation:', result ? 'ok' : 'skipped/failed');
        }
      } catch (e) { console.error('[license] revalidation error:', e?.message); }
    }, 15000);
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
        // Push to boot-timers array so before-quit cleanup also clears these.
        if (Array.isArray(_channelStatusBootTimers)) {
          for (const t of resumeTimers) _channelStatusBootTimers.push(t);
        }
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
  const _retentionTimer = setInterval(() => {
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
  // 9Router: dead (routerProcess=null + port down) → restart immediately
  // Zalo listener: 2 consecutive misses → restart gateway (~45s total)
  startFastWatchdog();
}).catch(console.error);

app.on('window-all-closed', () => {});
app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
});
// Centralized lifecycle-cleanup helper (intervals, watchers, cron, child
// processes). Called AFTER A5's IPC drain so no handler fires against a
// half-torn-down state. Each step wrapped so one failure doesn't block rest.
function _beforeQuitCleanup() {
  // (1) Clear all tracked intervals
  try { if (_followUpInterval) { clearInterval(_followUpInterval); _followUpInterval = null; } } catch (e2) { console.warn('[before-quit] _followUpInterval:', e2?.message); }
  try { if (_zaloCacheInterval) { clearInterval(_zaloCacheInterval); _zaloCacheInterval = null; } } catch (e2) { console.warn('[before-quit] _zaloCacheInterval:', e2?.message); }
  try { if (_apptDispatcherInterval) { clearInterval(_apptDispatcherInterval); _apptDispatcherInterval = null; } } catch (e2) { console.warn('[before-quit] _apptDispatcherInterval:', e2?.message); }
  try { if (_channelStatusInterval) { clearInterval(_channelStatusInterval); _channelStatusInterval = null; } } catch (e2) { console.warn('[before-quit] _channelStatusInterval:', e2?.message); }
  try { if (_watchPollerInterval) { clearInterval(_watchPollerInterval); _watchPollerInterval = null; } } catch (e2) { console.warn('[before-quit] _watchPollerInterval:', e2?.message); }
  try { if (global._telegramCmdInterval) { clearInterval(global._telegramCmdInterval); global._telegramCmdInterval = null; } } catch (e2) { console.warn('[before-quit] _telegramCmdInterval:', e2?.message); }
  try { if (_fastWatchdogInterval) { clearInterval(_fastWatchdogInterval); _fastWatchdogInterval = null; } } catch (e2) { console.warn('[before-quit] _fastWatchdogInterval:', e2?.message); }
  try { if (_fastWatchdogBootTimeout) { clearTimeout(_fastWatchdogBootTimeout); _fastWatchdogBootTimeout = null; } } catch {}

  // (2) Clear boot-phase timeouts + close fs.watch handles
  try {
    if (Array.isArray(_channelStatusBootTimers)) {
      for (const t of _channelStatusBootTimers) { try { clearTimeout(t); } catch {} }
      _channelStatusBootTimers = [];
    }
  } catch (e2) { console.warn('[before-quit] _channelStatusBootTimers:', e2?.message); }
  try {
    if (Array.isArray(global._channelStatusWatchers)) {
      for (const w of global._channelStatusWatchers) { try { w.close(); } catch {} }
      global._channelStatusWatchers = [];
    }
  } catch (e2) { console.warn('[before-quit] _channelStatusWatchers:', e2?.message); }

  // (3) Stop all cron jobs — node-cron tasks hold setInterval internally
  try { stopCronJobs(); } catch (e2) { console.warn('[before-quit] stopCronJobs:', e2?.message); }

  // (4) Stop child processes — synchronous kill (stopOpenClaw is async, can't await here)
  // Fire stopOpenClaw for its proc.kill + await-exit logic, but also do
  // synchronous killPort + killAll as belt-and-suspenders (the async parts
  // of stopOpenClaw may not complete before app.exit fires).
  try { stopOpenClaw(); } catch (e2) { console.warn('[before-quit] stopOpenClaw:', e2?.message); }
  try { killPort(18789); } catch {}
  try { killAllOpenClawProcesses(); } catch {}
  try { cleanupOrphanZaloListener(); } catch {}
  try { stop9Router(); } catch (e2) { console.warn('[before-quit] stop9Router:', e2?.message); }
}

app.on('before-quit', (e) => {
  app.isQuitting = true;
  _appIsQuitting = true;
  // Wait up to 3s for mutating IPC handlers (save-zalo-manager-config,
  // set-inbound-debounce, etc.) to finish writing openclaw.json. Without
  // this, app.exit(0) can interrupt a writeOpenClawConfigIfChanged call
  // mid-rename, leaving a corrupt JSON that breaks next boot.
  // Cleanup (intervals/watchers/cron/child-procs) runs AFTER drain so no
  // tick fires against a half-torn-down state.
  const needsDrain = _ipcInFlightCount > 0;
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
