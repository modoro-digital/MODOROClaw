const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, powerSaveBlocker, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFilePromise = promisify(execFile);

// ============================================
//  SINGLE INSTANCE LOCK (must be before app.whenReady)
// ============================================
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
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
    // top-level `name` field which is "modoro-claw" (LOWERCASE). It does NOT
    // read build.productName ("MODOROClaw") — that's electron-builder installer
    // metadata only. Hardcoding capital "MODOROClaw" creates a phantom dir
    // separate from Electron's real userData, splitting logs across two paths.
    const isWin = process.platform === 'win32';
    const appData = process.env.APPDATA
      || (isWin ? path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming') : null)
      || (process.platform === 'darwin'
          ? path.join(process.env.HOME || '', 'Library', 'Application Support')
          : path.join(process.env.HOME || '', '.config'));
    const logsDir = path.join(appData, 'modoro-claw', 'logs');
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
    console.log('MODOROClaw starting —', new Date().toISOString());
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
      // the package.json `name` field ("modoro-claw", lowercase). NOT
      // build.productName ("MODOROClaw") — that's electron-builder installer
      // metadata, not Electron runtime. Mismatch creates a phantom capital
      // dir that some code paths write to while real workspace is lowercase.
      const HOMETMP = process.env.USERPROFILE || process.env.HOME || '';
      const APP_DIR = 'modoro-claw';
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
        console.log('[vendor-extract] already extracted at', targetDir, '→', meta.bundle_version);
        return { skipped: true, reason: 'already_extracted' };
      }
      console.log('[vendor-extract] version mismatch — re-extracting. have:', current, 'want:', meta.bundle_version);
    }
  } catch {}

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
  try {
    if (fs.existsSync(targetDir)) {
      const stale = targetDir + '.stale-' + Date.now();
      try {
        fs.renameSync(targetDir, stale);
        console.log('[vendor-extract] old vendor renamed to', stale, '(will be deleted in background)');
        // Background delete — doesn't block main thread. Errors ignored
        // because the rename already freed the target path for fresh extract.
        setTimeout(() => {
          fs.rm(stale, { recursive: true, force: true }, (err) => {
            if (err) console.warn('[vendor-extract] background cleanup failed:', err.message);
            else console.log('[vendor-extract] background cleanup done:', stale);
          });
        }, 10000);
      } catch (renameErr) {
        // Rename can fail if the old dir has locked files. Fall back to
        // cleaning known-bad subdirs only, leaving the rest for tar overwrite.
        console.warn('[vendor-extract] rename failed, tar will overwrite in place:', renameErr.message);
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
        throw new Error(`vendor-bundle.tar SHA256 mismatch (expected ${meta.sha256.slice(0, 16)}..., got ${actual.slice(0, 16)}...). File is corrupt or tampered. Re-install MODOROClaw.`);
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
      // Write version stamp
      try {
        fs.writeFileSync(versionStamp, meta.bundle_version, 'utf8');
      } catch (e) {
        console.warn('[vendor-extract] could not write version stamp:', e.message);
      }
      const durationMs = Date.now() - startedAt;
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
const CURRENT_AGENTS_MD_VERSION = 9;
const AGENTS_MD_VERSION_RE = /<!--\s*modoroclaw-agents-version:\s*(\d+)\s*-->/;

function seedWorkspace() {
  const ws = getWorkspace();
  try { fs.mkdirSync(ws, { recursive: true }); } catch {}

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
      if (existingVersion < CURRENT_AGENTS_MD_VERSION) {
        // Back up the stale file to .learnings/ so any user-added custom
        // rules (or bot self-improvement promotions) survive the overwrite.
        try {
          const backupDir = path.join(ws, '.learnings');
          fs.mkdirSync(backupDir, { recursive: true });
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const backupName = 'AGENTS-backup-v' + existingVersion + '-' + ts + '.md';
          fs.writeFileSync(path.join(backupDir, backupName), existingContent, 'utf-8');
          console.log('[seedWorkspace] AGENTS.md upgrade ' + existingVersion + ' → ' +
            CURRENT_AGENTS_MD_VERSION + ' (backup: .learnings/' + backupName + ')');
        } catch (be) {
          console.warn('[seedWorkspace] AGENTS.md backup failed:', be && be.message ? be.message : String(be));
          // Continue with overwrite anyway — the rule update is more
          // important than preserving the backup.
        }
        try { fs.unlinkSync(existingAgents); } catch {}
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
    const templateDirs = ['skills', 'industry', 'prompts', 'memory', 'tools', 'docs', '.learnings', 'config'];
    for (const d of templateDirs) {
      copyDirRecursive(path.join(templateRoot, d), path.join(ws, d));
    }
  }

  // ALWAYS ensure runtime files exist (dev + packaged)
  const schedulesFile = path.join(ws, 'schedules.json');
  if (!fs.existsSync(schedulesFile)) {
    try { fs.writeFileSync(schedulesFile, JSON.stringify(DEFAULT_SCHEDULES_JSON, null, 2), 'utf-8'); } catch {}
  }
  // INTENTIONAL: custom-crons.json is NOT in `templateFiles` above. It is user
  // data, never a template. Packaged fresh installs always get an empty list
  // here because their workspace=userData/ doesn't have the file. Devs cloning
  // the repo get whatever is in the source tree (their problem to manage).
  const customCronsFile = path.join(ws, 'custom-crons.json');
  if (!fs.existsSync(customCronsFile)) {
    try { fs.writeFileSync(customCronsFile, '[]', 'utf-8'); } catch {}
  }
  const blocklistFile = path.join(ws, 'zalo-blocklist.json');
  if (!fs.existsSync(blocklistFile)) {
    try { fs.writeFileSync(blocklistFile, '[]', 'utf-8'); } catch {}
  }

  // Zalo per-user memory dir (bot writes <senderId>.md per customer).
  // Bot's actual workspace is in openclaw.json -> agents.defaults.workspace,
  // NOT MODOROClaw's getWorkspace(). Pre-create at BOTH locations so the
  // Dashboard reader sees something even if openclaw.json isn't ready yet
  // on a fresh install (the agent-workspace one is the canonical one that
  // bot will actually use after wizard).
  try { fs.mkdirSync(path.join(ws, 'memory', 'zalo-users'), { recursive: true }); } catch {}
  try {
    const agentWs = (typeof getOpenclawAgentWorkspace === 'function') ? getOpenclawAgentWorkspace() : null;
    if (agentWs && agentWs !== ws) {
      fs.mkdirSync(path.join(agentWs, 'memory', 'zalo-users'), { recursive: true });
    }
  } catch {}

  // Knowledge tab folders + index files
  const knowCategories = ['cong-ty', 'san-pham', 'nhan-vien'];
  const knowLabels = { 'cong-ty': 'Công ty', 'san-pham': 'Sản phẩm', 'nhan-vien': 'Nhân viên' };
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

// MODOROClaw PATCH: resolve `node` to an absolute path so child spawns work even
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

// MODOROClaw PATCH: resolve openclaw.mjs path so we can spawn `node openclaw.mjs ...`
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
function extractConversationHistory({ sinceMs, maxMessages = 40, channels = ['openzalo', 'telegram'] } = {}) {
  try {
    const sessionsDir = path.join(HOME, '.openclaw', 'agents', 'main', 'sessions');
    if (!fs.existsSync(sessionsDir)) return '';
    const jsonlFiles = fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(sessionsDir, f));
    if (jsonlFiles.length === 0) return '';

    const collected = [];
    for (const file of jsonlFiles) {
      let content;
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
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
    }
    if (collected.length === 0) return '';
    collected.sort((a, b) => a.ts - b.ts);
    const recent = collected.slice(-maxMessages);
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
    return formatted.join('\n');
  } catch (e) {
    console.error('[extractConversationHistory] error:', e?.message || e);
    return '';
  }
}

// Write a daily memory journal at memory/YYYY-MM-DD.md so future cron fires
// (and bot agent reads of memory/) find structured per-day history. Idempotent.
function writeDailyMemoryJournal({ date = new Date() } = {}) {
  try {
    const ws = getWorkspace();
    if (!ws) return null;
    const memDir = path.join(ws, 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    const dateStr = date.toISOString().slice(0, 10);
    const file = path.join(memDir, `${dateStr}.md`);
    const sinceMs = date.getTime() - 24 * 60 * 60 * 1000;
    const history = extractConversationHistory({ sinceMs, maxMessages: 100 });
    const header = `# Memory ${dateStr}\n\n*Auto-generated. Records all Zalo + Telegram messages in the last 24h before this cron fire.*\n\n`;
    const body = history || '_(Không có tin nhắn nào trong 24h qua.)_';
    fs.writeFileSync(file, header + body + '\n', 'utf-8');
    return file;
  } catch (e) {
    console.error('[writeDailyMemoryJournal] error:', e?.message || e);
    return null;
  }
}

// Run an agent turn from a cron handler and deliver the reply to the CEO via Telegram.
// Sends the OUTPUT, not the prompt text. Retries on transient failures, journals every
// fire, and never fails silently — total failure always yields a Telegram notice.
async function runCronAgentPrompt(prompt, { label, timeoutMs = 600000 } = {}) {
  const niceLabel = label || 'cron';

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
      try { await sendTelegram(userMsg); } catch {}
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
    await sendTelegram(`*Cron "${niceLabel}" thất bại sau 3 lần*\n\nExit code: \`${lastCode}\`\n\`\`\`\n${lastErr.slice(0, 500)}\n\`\`\``);
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
  // Packaged Mac .app: prefer bundled vendor copy.
  const v = getBundledVendorDir();
  if (v) {
    const bundled = path.join(v, 'node_modules', packageName, relativeFile);
    try { if (fs.existsSync(bundled)) return bundled; } catch {}
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
      out.trim().split('\n').forEach(pid => { try { process.kill(parseInt(pid), 'SIGTERM'); } catch {} });
    }
  } catch {} // No process on port = fine
}

function isValidConfigKey(key) {
  return typeof key === 'string' && /^[a-zA-Z0-9._-]+$/.test(key);
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
    title: 'MODOROClaw',
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
  console.log('[createWindow] configured:', configured);

  if (!openclawBin) {
    console.error('[createWindow] → no-openclaw.html (findOpenClawBinSync returned null)');
    mainWindow.loadFile(path.join(__dirname, 'ui', 'no-openclaw.html'));
  } else if (configured) {
    console.log('[createWindow] → dashboard.html');
    mainWindow.loadFile(path.join(__dirname, 'ui', 'dashboard.html'));
    mainWindow.maximize();
    // Ensure workspace files exist BEFORE cron jobs try to read them
    try { seedWorkspace(); } catch (e) { console.error('[seedWorkspace early] error:', e.message); }
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
      try { await startOpenClaw(); } catch (e) { console.error('[boot] startOpenClaw error:', e?.message || e); }
      startCronJobs();
      watchCustomCrons();
      startZaloCacheAutoRefresh();
    })();
  } else {
    console.log('[createWindow] → wizard.html');
    mainWindow.loadFile(path.join(__dirname, 'ui', 'wizard.html'));
    // Wizard now uses full-screen 2-column layout — maximize so business owners
    // see the premium onboarding without scrolling.
    mainWindow.maximize();
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());

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
  tray.setToolTip('MODOROClaw');

  const show = () => {
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
  };

  // Pick a platform-appropriate label for "open log file in editor". On Mac
  // this opens TextEdit; calling it "Notepad" was Win-only and confusing.
  const openLogFileLabel = process.platform === 'win32'
    ? 'Mở file log trong Notepad'
    : 'Mở file log trong trình soạn thảo';

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mở MODOROClaw', click: show },
    { type: 'separator' },
    { label: botRunning ? 'Đang chạy' : 'Đã dừng', enabled: false },
    { label: botRunning ? 'Dừng' : 'Khởi động', click: () => { if (botRunning) stopOpenClaw(); else startOpenClaw(); createTray(); } },
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
    { label: 'Thoát', click: () => { app.isQuitting = true; stopOpenClaw(); app.quit(); } },
  ]));
  tray.on('click', show);
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

function start9Router() {
  if (routerProcess) return;
  try {
    ensure9RouterDefaultPassword();
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
    // install` did), make sure `plugins.entries.openzalo.enabled = true` so the
    // gateway actually loads it. Without this flag the plugin dir exists but
    // gateway skips registration → openzalo channel never registered → Zalo dead.
    try {
      const openzaloPluginManifest = path.join(HOME, '.openclaw', 'extensions', 'openzalo', 'openclaw.plugin.json');
      if (fs.existsSync(openzaloPluginManifest)) {
        if (!config.plugins) config.plugins = {};
        if (!config.plugins.entries) config.plugins.entries = {};
        if (!config.plugins.entries.openzalo) {
          config.plugins.entries.openzalo = { enabled: true };
          changed = true;
        } else if (config.plugins.entries.openzalo.enabled !== true) {
          config.plugins.entries.openzalo.enabled = true;
          changed = true;
        }
      }
    } catch (e) { console.warn('[config] plugin entry heal failed:', e?.message); }
    {
      const oz = config.channels.openzalo;
      if (oz.enabled !== true) { oz.enabled = true; changed = true; }
      if (!oz.dmPolicy) { oz.dmPolicy = 'open'; changed = true; }
      if (!oz.allowFrom) { oz.allowFrom = ['*']; changed = true; }
      if (!oz.groupPolicy) { oz.groupPolicy = 'open'; changed = true; }
      if (!oz.groupAllowFrom) { oz.groupAllowFrom = ['*']; changed = true; }
      // Disable BLOCK streaming — prevents coalesce idleMs flush mid-word (the
      // root cause of "Dạ" → "D" + "ạ" split). Note: openzalo schema does NOT
      // have a `streaming` field (only Telegram/Slack/Discord do). Adding it
      // breaks validation: `channels.openzalo: must NOT have additional
      // properties`. Openzalo's one-message guarantee comes from the source
      // patch in ensureOpenzaloForceOneMessageFix (hardcoded
      // disableBlockStreaming:true in inbound.ts).
      if (oz.blockStreaming !== false) { oz.blockStreaming = false; changed = true; }
      // DEFENSIVE CLEANUP: remove `streaming` if it crept in from a prior buggy
      // version of this function (2026-04-08 regression). Schema rejects it.
      if ('streaming' in oz) { delete oz.streaming; changed = true; }
      // DO NOT set `zcaBinary` here: the openzalo plugin's
      // resolveOpenzcaCliJs() on Windows only searches hardcoded npm global
      // paths and ignores the config value during resolve, then falls back to
      // `spawn(binary, ..., {shell: true})`. On Mac it always falls back to
      // that shell-spawn path. Either way, the resolution works via PATH
      // lookup of plain "openzca". For bundled .dmg installs, the PATH
      // augmentation in augmentPathWithBundledNode() prepends
      // vendor/node_modules/.bin so the bundled openzca shim is found.
    }
    // Telegram — disable both block streaming AND preview streaming so bot
    // replies arrive as exactly 1 complete message, never split. Telegram
    // schema DOES support `streaming` field ("off"|"partial"|"block"|"progress").
    if (!config.channels.telegram) config.channels.telegram = {};
    {
      const tg = config.channels.telegram;
      if (tg.blockStreaming !== false) { tg.blockStreaming = false; changed = true; }
      if (tg.streaming !== 'off') { tg.streaming = 'off'; changed = true; }
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
    // Remove any unknown keys that OpenClaw rejects
    const validKeys = ['plugins', 'meta', 'channels', 'gateway', 'models', 'agents', 'wizard', 'security'];
    for (const key of Object.keys(config)) {
      if (!validKeys.includes(key)) { delete config[key]; changed = true; }
    }

    // Seed writable workspace (first run) — copies templates from read-only bundle if packaged
    const ws = seedWorkspace();

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
  } catch (e) { console.error('ensureDefaultConfig error:', e.message); }
}

// Check if gateway is already running on port 18789
function isGatewayAlive(timeoutMs = 8000) {
  // Generous timeout (8s default) — gateway can be busy serving an AI completion
  // and not return the index page in time. A 2s timeout used to false-positive
  // every few minutes, causing the heartbeat watchdog to kill+respawn a healthy
  // gateway → looked like an endless restart loop. Any 2xx/3xx/4xx status counts
  // as alive (the connection itself is what we care about).
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
        // Find node.exe processes running "openzca" "listen" — use WMIC command line match
        const { execSync } = require('child_process');
        const out = execSync(
          'wmic process where "name=\'node.exe\' and CommandLine like \'%openzca%listen%\'" get ProcessId /format:csv 2>nul',
          { encoding: 'utf-8', timeout: 5000 }
        );
        const pids = out.split('\n')
          .map(l => l.trim().split(',').pop())
          .filter(p => /^\d+$/.test(p));
        for (const pid of pids) {
          try {
            execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 3000 });
            console.log('[zalo-cleanup] Killed listener tree pid', pid);
          } catch {}
        }
        // Also kill any cmd.exe wrapping openzca
        const cmdOut = execSync(
          'wmic process where "name=\'cmd.exe\' and CommandLine like \'%openzca%listen%\'" get ProcessId /format:csv 2>nul',
          { encoding: 'utf-8', timeout: 5000 }
        );
        const cmdPids = cmdOut.split('\n')
          .map(l => l.trim().split(',').pop())
          .filter(p => /^\d+$/.test(p));
        for (const pid of cmdPids) {
          try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 3000 }); } catch {}
        }
      } catch (e) { console.error('[zalo-cleanup] wmic error:', e.message); }
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

// MODOROClaw PATCH: OpenZalo plugin doesn't natively honor Modoro's user blocklist
// (zalo-blocklist.json) — only its own allowFrom whitelist. We inject a small check
// at the top of handleOpenzaloInbound that drops messages from blocklisted senders.
// Idempotent via "MODOROClaw BLOCKLIST PATCH" marker.
function ensureZaloBlocklistFix() {
  try {
    const pluginFile = path.join(HOME, '.openclaw', 'extensions', 'openzalo', 'src', 'inbound.ts');
    if (!fs.existsSync(pluginFile)) return;
    let content = fs.readFileSync(pluginFile, 'utf-8');
    if (content.includes('MODOROClaw BLOCKLIST PATCH')) return; // already patched

    const anchor = '  if (!rawBody && !hasMedia) {\n    return;\n  }';
    if (!content.includes(anchor)) {
      console.error('[zalo-blocklist-fix] anchor not found, skipping');
      return;
    }
    // Resolve workspace at patch time so packaged installs work too. We hard-code
    // the candidate paths here because we cannot import Electron from the plugin.
    const blocklistPaths = [
      path.join(getWorkspace(), 'zalo-blocklist.json').replace(/\\/g, '/'),
      path.join(HOME, '.openclaw', 'workspace', 'zalo-blocklist.json').replace(/\\/g, '/'),
    ];
    const injection = `

  // === MODOROClaw BLOCKLIST PATCH ===
  // Drop messages from senders listed in zalo-blocklist.json (workspace file
  // managed via Dashboard → Zalo → Bạn bè). OpenZalo upstream only supports
  // allowFrom (whitelist); this gives Modoro CEOs a working blocklist UX.
  try {
    const __mzFs = require("node:fs");
    const __mzCandidates = ${JSON.stringify(blocklistPaths)};
    let __mzBlocked: string[] = [];
    for (const __p of __mzCandidates) {
      try {
        if (__mzFs.existsSync(__p)) {
          const __raw = __mzFs.readFileSync(__p, "utf-8");
          const __parsed = JSON.parse(__raw);
          if (Array.isArray(__parsed)) {
            __mzBlocked = __parsed.map((x: any) => String(x));
            break;
          }
        }
      } catch {}
    }
    if (__mzBlocked.length > 0) {
      const __sender = String(message.senderId || "").trim();
      if (__sender && __mzBlocked.includes(__sender)) {
        runtime.log?.(\`openzalo: drop sender=\${__sender} (MODOROClaw blocklist)\`);
        return;
      }
    }
  } catch (__e) {
    runtime.log?.(\`openzalo: blocklist check error: \${String(__e)}\`);
  }
  // === END MODOROClaw BLOCKLIST PATCH ===
`;
    const patched = content.replace(anchor, anchor + injection);
    fs.writeFileSync(pluginFile, patched, 'utf-8');
    console.log('[zalo-blocklist-fix] Injected blocklist check into inbound.ts');
  } catch (e) {
    console.error('[zalo-blocklist-fix] error:', e.message);
  }
}

// MODOROClaw FRIEND-CHECK PATCH: Zalo has a "stranger" concept — if a user
// who is NOT a friend of the bot account sends a DM, Zalo shows it in a
// separate "stranger box" and replies may not deliver reliably. Other Zalo
// bots (seen in production) handle this by replying once with a "please
// add friend first" prompt then muting until the friend request is accepted.
//
// Implementation: inject a check right after the blocklist patch. Reads
// openzca's own friend cache at ~/.openzca/profiles/default/cache/friends.json,
// checks if senderId is present. If NOT a friend AND the cache is populated
// (fail-safe to "allow" when cache is empty to avoid blocking legit users
// during first-boot cache sync), sends a single friend-request message and
// returns. Dedupes per-sender with a 10-min window so a stranger spamming
// 20 messages only gets 1 reply.
//
// Groups are NOT affected. Idempotent via "MODOROClaw FRIEND-CHECK PATCH" marker.
// Custom message supported via workspace/zalo-friend-request-message.txt.
function ensureZaloFriendCheckFix() {
  try {
    const pluginFile = path.join(HOME, '.openclaw', 'extensions', 'openzalo', 'src', 'inbound.ts');
    if (!fs.existsSync(pluginFile)) return;
    let content = fs.readFileSync(pluginFile, 'utf-8');
    if (content.includes('MODOROClaw FRIEND-CHECK PATCH')) return; // already patched

    // Anchor: right after the blocklist patch's END marker. Ensures friend
    // check runs AFTER blocklist (so blocked users don't get the friend
    // prompt) and BEFORE dmPolicy/agent dispatch. Requires blocklist patch
    // to have run first.
    const anchor = '  // === END MODOROClaw BLOCKLIST PATCH ===';
    if (!content.includes(anchor)) {
      console.warn('[zalo-friend-check-fix] blocklist anchor missing — blocklist fix must run first');
      return;
    }

    const injection = `

  // === MODOROClaw FRIEND-CHECK PATCH ===
  // For DM messages from non-friends, send a one-time "please add friend"
  // reply and short-circuit. Reads openzca's friend cache to determine
  // friend status. Groups skip this check. See main.js ensureZaloFriendCheckFix.
  if (!message.isGroup) {
    try {
      const __fcFs = require("node:fs");
      const __fcPath = require("node:path");
      const __fcOs = require("node:os");
      const __fcSender = String(message.senderId || "").trim();
      const __fcBotSelf = String(botUserId || "").trim();
      if (__fcSender && __fcSender !== __fcBotSelf) {
        const __fcHome = __fcOs.homedir();
        const __fcCachePath = __fcPath.join(__fcHome, ".openzca", "profiles", "default", "cache", "friends.json");
        let __fcCacheExists = false;
        let __fcIsFriend = false;
        let __fcFriendsCount = 0;
        try {
          if (__fcFs.existsSync(__fcCachePath)) {
            __fcCacheExists = true;
            const __fcRaw = __fcFs.readFileSync(__fcCachePath, "utf-8");
            const __fcFriends = JSON.parse(__fcRaw);
            if (Array.isArray(__fcFriends)) {
              __fcFriendsCount = __fcFriends.length;
              __fcIsFriend = __fcFriends.some((__f: any) =>
                String(__f?.userId || __f?.uid || __f?.id || "").trim() === __fcSender,
              );
            }
          }
        } catch (__fcReadErr) {
          runtime.log?.(\`openzalo: friend cache read error: \${String(__fcReadErr)}\`);
        }
        // FAIL-SAFE: if cache doesn't exist or is empty, treat as disabled.
        // Only enforce friend check when cache has been populated by openzca.
        if (__fcCacheExists && __fcFriendsCount > 0 && !__fcIsFriend) {
          const __fcGlobal = globalThis as any;
          if (!__fcGlobal.__modoroFriendReqDedupe) {
            __fcGlobal.__modoroFriendReqDedupe = new Map();
          }
          const __fcMap: Map<string, number> = __fcGlobal.__modoroFriendReqDedupe;
          const __fcNow = Date.now();
          const __fcLast = __fcMap.get(__fcSender) || 0;
          const __fcWindow = 10 * 60 * 1000;
          if (__fcNow - __fcLast < __fcWindow) {
            runtime.log?.(\`openzalo: drop non-friend \${__fcSender} (friend-request sent <10min ago)\`);
            return;
          }
          __fcMap.set(__fcSender, __fcNow);
          for (const [__fcK, __fcTs] of __fcMap.entries()) {
            if (__fcNow - __fcTs > 60 * 60 * 1000) __fcMap.delete(__fcK);
          }
          runtime.log?.(\`openzalo: non-friend \${__fcSender} — sending friend request proactively\`);
          // PROACTIVE: bot sends a friend request TO the stranger (not just
          // a text message asking them to add). The stranger only needs to
          // tap "Accept" in Zalo — much easier than finding the "Add friend"
          // button. Uses openzca's api.sendFriendRequest(message, userId).
          try {
            const __fcApi = (globalThis as any).__openzcaApi || null;
            if (__fcApi && typeof __fcApi.sendFriendRequest === "function") {
              await __fcApi.sendFriendRequest("Xin chao, minh la tro ly AI. Ket ban de minh ho tro ban nhe!", __fcSender);
              runtime.log?.(\`openzalo: proactive friend request sent to \${__fcSender}\`);
            } else {
              runtime.log?.("openzalo: api.sendFriendRequest not available — falling back to text-only prompt");
            }
          } catch (__fcFrErr) {
            runtime.log?.(\`openzalo: proactive friend request failed: \${String(__fcFrErr)} — falling back to text prompt\`);
          }
          let __fcText = 'Xin chào! Mình vừa gửi lời mời kết bạn cho bạn. Vui lòng bấm "Đồng ý" để mình có thể hỗ trợ bạn nhé.\\n\\nSau khi kết bạn, mình sẽ chào bạn ngay.';
          try {
            const __fcAppDir = "modoro-claw";
            const __fcCustomPaths = [];
            if (process.env.MODORO_WORKSPACE) {
              __fcCustomPaths.push(__fcPath.join(process.env.MODORO_WORKSPACE, "zalo-friend-request-message.txt"));
            }
            if (process.platform === "darwin") {
              __fcCustomPaths.push(__fcPath.join(__fcHome, "Library", "Application Support", __fcAppDir, "zalo-friend-request-message.txt"));
            } else if (process.platform === "win32") {
              const __fcAppData = process.env.APPDATA || __fcPath.join(__fcHome, "AppData", "Roaming");
              __fcCustomPaths.push(__fcPath.join(__fcAppData, __fcAppDir, "zalo-friend-request-message.txt"));
            } else {
              const __fcConfig = process.env.XDG_CONFIG_HOME || __fcPath.join(__fcHome, ".config");
              __fcCustomPaths.push(__fcPath.join(__fcConfig, __fcAppDir, "zalo-friend-request-message.txt"));
            }
            __fcCustomPaths.push(__fcPath.join(__fcHome, ".openclaw", "workspace", "zalo-friend-request-message.txt"));
            for (const __fcCp of __fcCustomPaths) {
              try {
                if (__fcFs.existsSync(__fcCp)) {
                  const __fcCustom = __fcFs.readFileSync(__fcCp, "utf-8").trim();
                  if (__fcCustom) { __fcText = __fcCustom; break; }
                }
              } catch {}
            }
          } catch {}
          try {
            await sendTextOpenzalo({
              cfg,
              account,
              to: targetThreadId,
              text: __fcText,
            });
          } catch (__fcSendErr) {
            runtime.log?.(\`openzalo: friend-request send error: \${String(__fcSendErr)}\`);
          }
          return;
        }
      }
    } catch (__fcErr) {
      runtime.log?.(\`openzalo: friend check error: \${String(__fcErr)}\`);
    }
  }
  // === END MODOROClaw FRIEND-CHECK PATCH ===`;

    const patched = content.replace(anchor, anchor + injection);
    fs.writeFileSync(pluginFile, patched, 'utf-8');
    console.log('[zalo-friend-check-fix] Injected friend-status check into inbound.ts');
  } catch (e) {
    console.error('[zalo-friend-check-fix] error:', e.message);
  }
}

// MODOROCLAW ZALO-OWNER PATCH: when a Zalo DM arrives from the CEO's personal
// Zalo account (NOT the bot account that openzca logs in to), prepend a
// special marker to the message body so the agent can switch to CEO mode.
// AGENTS.md instructs the bot: when seeing `[ZALO_CHU_NHAN]` prefix, treat
// the message as if it came from CEO on Telegram (full persona, accept debug
// commands like /reset /status, skip output filter trust gate).
//
// Reads owner from workspace/zalo-owner.json (written by wizard step 4
// or Dashboard Zalo tab). Bypasses if file missing or sender doesn't match.
// Idempotent via marker. Anchor: end of friend-check patch.
function ensureZaloOwnerFix() {
  try {
    const pluginFile = path.join(HOME, '.openclaw', 'extensions', 'openzalo', 'src', 'inbound.ts');
    if (!fs.existsSync(pluginFile)) return;
    let content = fs.readFileSync(pluginFile, 'utf-8');

    // Migration: strip OLD versions of this patch on upgrade. Detect by
    // checking the patch BLOCK ONLY (between markers) for the version-pin
    // string we embed in current versions. If the version-pin is missing,
    // the patch is from an older build with broken Mac paths and must be
    // re-injected. We can NOT scan whole-file fingerprints (they false-positive
    // on text from other patches like the friend-request patch).
    const PATCH_VERSION_PIN = 'ZALO-OWNER-PATCH-V2';
    const startMarker = '// === MODOROCLAW ZALO-OWNER PATCH ===';
    const endMarker = '// === END MODOROCLAW ZALO-OWNER PATCH ===';
    if (content.includes(startMarker)) {
      const blockStart = content.indexOf(startMarker);
      const blockEnd = content.indexOf(endMarker, blockStart);
      if (blockStart < 0 || blockEnd < 0) {
        console.warn('[zalo-owner-fix] markers present but malformed — leaving as-is');
        return;
      }
      const block = content.slice(blockStart, blockEnd);
      if (block.includes(PATCH_VERSION_PIN)) return; // already current
      // Old version present — strip it. Find the leading whitespace so we
      // remove the leading "\n\n  " that was prepended at injection time.
      let stripStart = blockStart;
      while (stripStart > 0 && (content[stripStart - 1] === ' ' || content[stripStart - 1] === '\n')) {
        stripStart--;
        // Stop when we've consumed up to (but not past) the trailing newline
        // of the friend-check anchor line.
        if (content.slice(stripStart, stripStart + 2) === '\n\n') break;
      }
      const stripEndPos = blockEnd + endMarker.length;
      content = content.slice(0, stripStart) + content.slice(stripEndPos);
      console.log('[zalo-owner-fix] stripped old patch (no version pin) — re-injecting current');
    }

    // Anchor: end of friend-check patch. Owner check must run AFTER friend
    // check (non-friends already short-circuited) and BEFORE agent dispatch
    // so the marker is in the body the agent sees.
    const anchor = '  // === END MODOROClaw FRIEND-CHECK PATCH ===';
    if (!content.includes(anchor)) {
      console.warn('[zalo-owner-fix] friend-check anchor missing — friend-check fix must run first');
      return;
    }

    const injection = `

  // === MODOROCLAW ZALO-OWNER PATCH ===
  // ZALO-OWNER-PATCH-V2 — version pin (used by main.js for upgrade detection)
  // Mark messages from CEO's personal Zalo with [ZALO_CHU_NHAN] prefix.
  // AGENTS.md tells bot to switch to CEO mode when it sees this marker.
  // See electron/main.js ensureZaloOwnerFix.
  if (!message.isGroup) {
    try {
      const __zoFs = require("node:fs");
      const __zoPath = require("node:path");
      const __zoOs = require("node:os");
      const __zoSender = String(message.senderId || "").trim();
      if (__zoSender) {
        // Path resolution mirrors getWorkspace() in electron/main.js. The
        // canonical answer comes from MODORO_WORKSPACE env (set at gateway
        // spawn). Platform branches are fallbacks for the unlikely case the
        // env var is missing. CRITICAL: app dir name is "modoro-claw"
        // (lowercase) — matches Electron's app.getName() reading package.json
        // \`name\` field. NOT "MODOROClaw" (build.productName is installer
        // metadata only, not used for runtime userData).
        const __zoOwnerPaths = [];
        if (process.env.MODORO_WORKSPACE) {
          __zoOwnerPaths.push(__zoPath.join(process.env.MODORO_WORKSPACE, "zalo-owner.json"));
        }
        const __zoAppDir = "modoro-claw";
        if (process.platform === "darwin") {
          __zoOwnerPaths.push(__zoPath.join(__zoOs.homedir(), "Library", "Application Support", __zoAppDir, "zalo-owner.json"));
        } else if (process.platform === "win32") {
          const __zoAppData = process.env.APPDATA || __zoPath.join(__zoOs.homedir(), "AppData", "Roaming");
          __zoOwnerPaths.push(__zoPath.join(__zoAppData, __zoAppDir, "zalo-owner.json"));
        } else {
          const __zoConfig = process.env.XDG_CONFIG_HOME || __zoPath.join(__zoOs.homedir(), ".config");
          __zoOwnerPaths.push(__zoPath.join(__zoConfig, __zoAppDir, "zalo-owner.json"));
        }
        // Legacy fallback (older builds wrote here)
        __zoOwnerPaths.push(__zoPath.join(__zoOs.homedir(), ".openclaw", "workspace", "zalo-owner.json"));
        for (const __zoOp of __zoOwnerPaths) {
          try {
            if (!__zoFs.existsSync(__zoOp)) continue;
            const __zoData = JSON.parse(__zoFs.readFileSync(__zoOp, "utf-8"));
            const __zoOwner = String(__zoData?.ownerUserId || "").trim();
            if (!__zoOwner) break;
            if (__zoSender === __zoOwner) {
              const __zoName = String(__zoData?.ownerName || "").trim();
              const __zoTag = __zoName
                ? \`[ZALO_CHU_NHAN tên="\${__zoName.replace(/"/g, '')}"]\`
                : "[ZALO_CHU_NHAN]";
              // Prepend marker into the actual content the agent will read.
              // We mutate the runtime message text + structured content so
              // both code paths (text-only + media+caption) see the marker.
              if (typeof message.text === "string" && message.text) {
                (message as any).text = __zoTag + "\\n" + message.text;
              } else if (typeof message.text === "string") {
                (message as any).text = __zoTag;
              }
              if ((message as any).body && typeof (message as any).body === "string") {
                (message as any).body = __zoTag + "\\n" + (message as any).body;
              }
              runtime.log?.(\`openzalo: ZALO_CHU_NHAN marker injected for sender \${__zoSender}\`);
            }
            break; // first existing owner file wins
          } catch (__zoReadErr) {
            runtime.log?.(\`openzalo: zalo-owner read error: \${String(__zoReadErr)}\`);
          }
        }
      }
    } catch (__zoErr) {
      runtime.log?.(\`openzalo: zalo-owner check error: \${String(__zoErr)}\`);
    }
  }
  // === END MODOROCLAW ZALO-OWNER PATCH ===`;

    const patched = content.replace(anchor, anchor + injection);
    fs.writeFileSync(pluginFile, patched, 'utf-8');
    console.log('[zalo-owner-fix] Injected owner-marker patch into inbound.ts');
  } catch (e) {
    console.error('[zalo-owner-fix] error:', e?.message);
  }
}

// MODOROCLAW FRIEND-EVENT PATCH: openzca daemon's `listen` command only subscribes
// to message/connected/error/closed events from zca-js — it does NOT listen for
// `friend_event`. zca-js DOES emit friend_event on type=ADD/REMOVE/REQUEST etc.
// Without subscribing, friends.json (the cache the friend-check patch reads) only
// updates on initial login or manual `auth cache-refresh`. Result: when a stranger
// adds bot as friend in real time, bot still treats them as stranger for 10+ min
// until next periodic refresh.
//
// This patch injects a `friend_event` listener directly into openzca cli.js that:
// 1. On REQUEST (type=2): auto-accept friend request via api.acceptFriendRequest
// 2. On ADD (type=0): refresh cache via refreshCacheForProfile so friends.json
//    gets updated within milliseconds — friend-check patch reads it on next msg
//
// Effect: stranger DMs → bot says "please add friend" → stranger taps Kết bạn →
// openzca auto-accepts → cache refresh → stranger sends 2nd msg → bot replies
// instantly. Total wait: ~2-3 sec for accept round-trip, no 10-min lag.
//
// Idempotent via marker. Anchor `api.listener.on("message"` is unique in cli.js.
function ensureOpenzcaFriendEventFix() {
  try {
    const vendorDir = getBundledVendorDir();
    if (!vendorDir) {
      console.log('[openzca-friend-event] no bundled vendor — skipping (dev mode or system openzca)');
      return;
    }
    const cliPath = path.join(vendorDir, 'node_modules', 'openzca', 'dist', 'cli.js');
    if (!fs.existsSync(cliPath)) {
      console.warn('[openzca-friend-event] cli.js not found at', cliPath);
      return;
    }
    let content = fs.readFileSync(cliPath, 'utf-8');
    if (content.includes('MODOROCLAW FRIEND-EVENT PATCH')) {
      console.log('[openzca-friend-event] already patched');
      return;
    }

    const anchor = 'api.listener.on("message", async (message) => {';
    const anchorIdx = content.indexOf(anchor);
    if (anchorIdx === -1) {
      console.error('[openzca-friend-event] CRITICAL: anchor not found — openzca cli.js structure changed');
      try {
        const diagPath = path.join(getWorkspace() || resourceDir, 'logs', 'boot-diagnostic.txt');
        fs.mkdirSync(path.dirname(diagPath), { recursive: true });
        fs.appendFileSync(diagPath,
          `\n[${new Date().toISOString()}] [openzca-friend-event] anchor regex failed — ` +
          `openzca cli.js source changed; instant friend recognition disabled. Check ${cliPath}\n`,
          'utf-8');
      } catch {}
      return;
    }

    // Inject right BEFORE the message listener so both handlers are siblings.
    // Uses `profile`, `api`, `refreshCacheForProfile` — all in scope inside the
    // listen action handler (verified at cli.js anchor location).
    const injection = `// === MODOROCLAW FRIEND-EVENT PATCH ===
        // Auto-handle friend events so friend-check cache stays fresh in real time.
        // type=0 ADD, type=2 REQUEST. See electron/main.js ensureOpenzcaFriendEventFix.
        api.listener.on("friend_event", async (event) => {
          try {
            if (!event || typeof event.type !== "number") return;
            console.log("[friend_event] type=" + event.type + " threadId=" + (event.threadId || ""));
            // REQUEST: auto-accept incoming friend request
            if (event.type === 2) {
              const fromUid = event.data && event.data.fromUid;
              if (fromUid) {
                try {
                  await api.acceptFriendRequest(fromUid);
                  console.log("[friend_event] auto-accepted friend request from " + fromUid);
                } catch (acceptErr) {
                  console.error("[friend_event] auto-accept failed:", acceptErr && acceptErr.message ? acceptErr.message : String(acceptErr));
                }
              }
            }
            // ADD or post-REQUEST: refresh cache so friends.json reflects new friend
            if (event.type === 0 || event.type === 2 || event.type === 7) {
              try {
                await refreshCacheForProfile(profile, api);
                console.log("[friend_event] cache refreshed for " + profile);
              } catch (refreshErr) {
                console.error("[friend_event] cache refresh failed:", refreshErr && refreshErr.message ? refreshErr.message : String(refreshErr));
              }
            }
            // WELCOME FLOW: when friend is ADDED (type=0), send a proactive
            // welcome message. This handles the case where a stranger was
            // told to "accept friend request" — once they do, the bot greets
            // them immediately without waiting for their next message.
            // Uses api.sendMessage for direct Zalo message delivery.
            if (event.type === 0) {
              try {
                const newFriendUid = event.data && (event.data.fromUid || event.threadId);
                if (newFriendUid) {
                  // Look up the friend's display name from the refreshed cache
                  let friendName = "";
                  try {
                    const __welFs = require("fs");
                    const __welPath = require("path");
                    const __welOs = require("os");
                    const cachePath = __welPath.join(__welOs.homedir(), ".openzca", "profiles", "default", "cache", "friends.json");
                    if (__welFs.existsSync(cachePath)) {
                      const friends = JSON.parse(__welFs.readFileSync(cachePath, "utf-8"));
                      if (Array.isArray(friends)) {
                        const match = friends.find(f => String(f.userId || f.uid || f.id || "").trim() === String(newFriendUid).trim());
                        if (match) friendName = String(match.displayName || match.name || match.zaloName || "").trim();
                      }
                    }
                  } catch {}
                  // Determine greeting pronoun from name (basic Vietnamese heuristic)
                  let pronoun = "ban";
                  if (friendName) {
                    const lastName = friendName.split(/\\s+/).pop() || "";
                    const maleNames = ["huy","minh","duc","hung","dung","tuan","thanh","long","quan","khanh","bao","hai","son","tu","duy","dat","kien","cuong","hoang","tri","nam","phuc","vinh"];
                    const femaleNames = ["huong","linh","trang","lan","mai","nga","ngoc","thao","vy","uyen","yen","hang","dung","thu","ha","nhung","hanh","chau","anh","quynh","my","nhi"];
                    const lnLower = lastName.toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "");
                    if (maleNames.includes(lnLower)) pronoun = "anh " + friendName;
                    else if (femaleNames.includes(lnLower)) pronoun = "chi " + friendName;
                    else pronoun = "anh/chi " + friendName;
                  }
                  // Read IDENTITY.md for bot intro (workspace path via env)
                  let botIntro = "tro ly AI cua doanh nghiep";
                  try {
                    const __welFs2 = require("fs");
                    const __welPath2 = require("path");
                    const ws = process.env.MODORO_WORKSPACE || "";
                    if (ws) {
                      const companyPath = __welPath2.join(ws, "COMPANY.md");
                      if (__welFs2.existsSync(companyPath)) {
                        const companyContent = __welFs2.readFileSync(companyPath, "utf-8");
                        const nameMatch = companyContent.match(/Ten cong ty[^:]*:\\s*(.+)/i) || companyContent.match(/^#\\s+(.+)/m);
                        if (nameMatch) botIntro = "tro ly AI cua " + nameMatch[1].trim();
                      }
                    }
                  } catch {}
                  // Build welcome message with numbered options
                  const welcomeMsg = "Chao " + pronoun + "! Cam on " + (pronoun.startsWith("anh") || pronoun.startsWith("chi") ? pronoun.split(" ")[0] : "ban") + " da ket ban.\\n\\n"
                    + "Minh la " + botIntro + ". Minh co the ho tro " + (pronoun.startsWith("anh") || pronoun.startsWith("chi") ? pronoun.split(" ")[0] : "ban") + ":\\n\\n"
                    + "1. Xem san pham / dich vu\\n"
                    + "2. Tim hieu gia ca\\n"
                    + "3. Dat lich hen / tu van\\n"
                    + "4. Hoi cau hoi khac\\n\\n"
                    + (pronoun.startsWith("anh") || pronoun.startsWith("chi") ? pronoun.split(" ")[0].charAt(0).toUpperCase() + pronoun.split(" ")[0].slice(1) : "Ban") + " chi can tra loi so (1-4) de minh ho tro ngay!";
                  // Send via zca-js api.sendMessage — threadType=0 for DM
                  await api.sendMessage({ body: welcomeMsg }, newFriendUid, 0);
                  console.log("[friend_event] welcome message sent to new friend " + newFriendUid + " (" + friendName + ")");
                }
              } catch (welcomeErr) {
                console.error("[friend_event] welcome send failed:", welcomeErr && welcomeErr.message ? welcomeErr.message : String(welcomeErr));
              }
            }
          } catch (handlerErr) {
            console.error("[friend_event] handler error:", handlerErr && handlerErr.message ? handlerErr.message : String(handlerErr));
          }
        });
        // === END MODOROCLAW FRIEND-EVENT PATCH ===
        `;

    const patched = content.slice(0, anchorIdx) + injection + content.slice(anchorIdx);
    fs.writeFileSync(cliPath, patched, 'utf-8');
    console.log('[openzca-friend-event] Injected friend_event listener into openzca cli.js');
  } catch (e) {
    console.error('[openzca-friend-event] error:', e && e.message ? e.message : String(e));
  }
}

// MODOROClaw OUTPUT-FILTER PATCH v3 — Security Layer 2
// v3 changes vs v2 (deep audit findings):
//   - Fix \b regex bug for Vietnamese-leading branches. JS \b only works
//     on [a-zA-Z0-9_]; for đ/ạ/ơ etc it never matches, so v2's
//     meta-vi-fact-claim second branch + meta-vi-memory-claim Vietnamese
//     branch were dead code. Replaced \b at start with (?<![a-zA-Z0-9_])
//     lookbehind, \b at end with (?![a-zA-Z0-9_]) lookahead.
//   - Drop bare "(rằng|là)" from second branch of fact-claim; keep only
//     "rằng". "là" alone false-positives on legit business reports.
//   - Add URL bypass to Layer D: skip diacritic check if reply contains
//     http(s):// scheme (legit URL-only replies pass).
//   - Add file-size safety guard: abort if patched send.ts shrinks > 50%.
//
// Original purpose: deterministic scan of outbound Zalo text for sensitive
// patterns + AI failure modes that AGENTS.md rules cannot prevent. The
// AI may sometimes:
//   1. cite file paths / API keys / config internals (security leak)
//   2. dump its English chain-of-thought as the user-facing reply
//   3. narrate file/tool operations ("em vừa edit file memory.md")
//   4. send a message with zero Vietnamese diacritics (= not Vietnamese)
//   5. claim to have stored facts in memory without actually doing it
//
// This filter runs AFTER the model generates, BEFORE the message hits
// sendTextOpenzalo's CLI spawn. If any blocked pattern matches, the body
// is replaced with a safe canned message and the incident is logged
// (sending continues — don't leave customer hanging).
//
// IMPORTANT: this function FORCE-REPLACES any prior version of the patch
// (v1 or v2) on each app start. That way pattern updates ship immediately
// without requiring users to delete extensions/openzalo/src/send.ts. The
// strip is bounded by the unique markers `MODOROClaw OUTPUT-FILTER PATCH`
// (start) and `END MODOROClaw OUTPUT-FILTER PATCH` (end).
function ensureZaloOutputFilterFix() {
  try {
    const pluginFile = path.join(HOME, '.openclaw', 'extensions', 'openzalo', 'src', 'send.ts');
    if (!fs.existsSync(pluginFile)) return;
    let content = fs.readFileSync(pluginFile, 'utf-8');
    const originalLength = content.length;

    const CURRENT_VERSION = 'MODOROClaw OUTPUT-FILTER PATCH v3';

    // Fast path: file is already on the current version, nothing to do.
    if (content.includes(CURRENT_VERSION)) return;

    // Strip any prior version of the patch (v1 had marker without "v2").
    // The injection block always begins with `// === MODOROClaw OUTPUT-FILTER PATCH`
    // and ends with `// === END MODOROClaw OUTPUT-FILTER PATCH ===`. Strip
    // the entire region (including any leading whitespace) so we can re-inject
    // cleanly. If no prior block exists this is a no-op.
    const stripRe = /\n\n\s*\/\/ === MODOROClaw OUTPUT-FILTER PATCH[\s\S]*?\/\/ === END MODOROClaw OUTPUT-FILTER PATCH ===/g;
    if (stripRe.test(content)) {
      content = content.replace(stripRe, '');
    }

    // Anchor: right after `const body = text.trim();` and the empty-body check,
    // before the args construction. Stable in upstream 2026.3.31+.
    const anchor = '  if (!body) {\n    return { messageId: "empty", kind: "text" };\n  }';
    if (!content.includes(anchor)) {
      console.warn('[zalo-output-filter-fix] anchor not found — upstream send.ts changed');
      return;
    }

    const injection = `

  // === MODOROClaw OUTPUT-FILTER PATCH v3 ===
  // Scan outbound Zalo text for sensitive patterns + AI failure modes.
  // See main.js ensureZaloOutputFilterFix for v3 changelog vs v2.
  try {
    const __ofFs = require("node:fs");
    const __ofPath = require("node:path");
    const __ofOs = require("node:os");
    // Patterns that MUST NEVER appear in a customer-facing Zalo reply.
    // Case-insensitive, matching any occurrence. Order matters: more
    // specific patterns first so audit log shows the most informative match.
    //
    // REGEX ANCHOR NOTE: \\b only works for ASCII-word transitions
    // ([a-zA-Z0-9_]). For patterns with branches starting with Vietnamese
    // chars (đã, đọc, ạ, ơ, ...), use (?<![a-zA-Z0-9_]) lookbehind at
    // start and (?![a-zA-Z0-9_]) lookahead at end. \\b is fine for
    // English-only or "em-prefix" branches.
    const __ofBlockPatterns: { name: string; re: RegExp }[] = [
      // --- Layer A: file paths + secrets ---
      { name: "file-path-memory", re: /\\bmemory\\/[\\w\\-./]*\\.md\\b/i },
      { name: "file-path-learnings", re: /\\.learnings\\/[\\w\\-./]*/i },
      { name: "file-path-core", re: /\\b(?:SOUL|USER|MEMORY|AGENTS|IDENTITY|COMPANY|PRODUCTS|BOOTSTRAP|HEARTBEAT|TOOLS)\\.md\\b/i },
      { name: "file-path-config", re: /\\bopenclaw\\.json\\b/i },
      { name: "line-ref", re: /#L\\d+/i },
      { name: "unix-home", re: /~\\/\\.openclaw|~\\/\\.openzca/i },
      { name: "win-user-path", re: /[A-Z]:[\\\\\\/]Users[\\\\\\/]/i },
      { name: "api-key-sk", re: /\\bsk-[a-zA-Z0-9_\\-]{16,}/i },
      { name: "bearer-token", re: /\\bBearer\\s+[a-zA-Z0-9_\\-.]{20,}/i },
      { name: "botToken-field", re: /\\bbotToken\\b/i },
      { name: "apiKey-field", re: /\\bapiKey\\b/i },
      // --- Layer B: English chain-of-thought leakage ---
      { name: "cot-en-the-actor", re: /\\bthe (user|assistant|bot|model|customer)\\b/i },
      { name: "cot-en-we-modal", re: /\\b(we need to|we have to|we should|we can|let me|let's|i'll|i will|i need to|i should)\\b/i },
      { name: "cot-en-meta", re: /\\b(internal reasoning|chain of thought|system prompt|instructions|prompt injection|tool call)\\b/i },
      { name: "cot-en-narration", re: /\\b(based on (the|our)|according to (the|my)|as (you|i) (can|mentioned)|in (the|this) conversation)\\b/i },
      { name: "cot-en-reasoning-verbs", re: /\\b(let me think|hmm,? let|first,? (i|let|we)|okay,? (so|let|i)|alright,? (so|let|i))\\b/i },
      // --- Layer C: meta-commentary about file/tool operations ---
      { name: "meta-vi-file-ops", re: /(?<![a-zA-Z0-9_])(edit file|ghi (vào )?file|lưu (vào )?file|update file|append file|read file|đọc file|cập nhật file|sửa file|tạo file|xóa file)(?![a-zA-Z0-9_])/i },
      { name: "meta-vi-tool-name", re: /\\b(tool (Edit|Write|Read|Bash|Grep|Glob)|use the (Edit|Write|Read) tool|công cụ (Edit|Write|Read|Bash))\\b/i },
      // v3 fix: lookbehind/lookahead instead of \\b. Vietnamese branch
      // (đã ...) was DEAD CODE in v2 because \\b can't anchor on đ.
      { name: "meta-vi-memory-claim", re: /(?<![a-zA-Z0-9_])(đã (lưu|ghi|cập nhật|update) (vào |trong )?(bộ nhớ|memory|hồ sơ|file|database)|stored (in|to) memory|saved to (file|memory))(?![a-zA-Z0-9_])/i },
      { name: "meta-vi-tool-action", re: /\\b(em (vừa|đã) (edit|write|read|chạy|gọi) (file|tool|công cụ)|em (vừa|đã) (cập nhật|sửa|đọc) (file|memory|database))\\b/i },
      // v3 fix: lookbehind/lookahead instead of \\b. Second branch (đã ...)
      // was DEAD CODE in v2. Also dropped bare "(rằng|là)" — keep only
      // "rằng" because "là" alone false-positives on legit business reports
      // like "đã cập nhật là 5 sản phẩm còn".
      { name: "meta-vi-fact-claim", re: /(?<![a-zA-Z0-9_])(em đã (cập nhật|ghi (nhận|chú)|lưu( lại)?) (rằng|thêm rằng|sở thích|preference|là anh|là chị|là mình)|đã (cập nhật|ghi nhận|lưu) (thêm )?rằng)(?![a-zA-Z0-9_])/i },
      // --- Layer D: all-Latin / no-Vietnamese-diacritic message ---
      // Vietnamese always contains at least one diacritic in non-trivial
      // messages. A long message with ZERO diacritics is almost certainly
      // an English CoT dump. Skipped if < 40 chars (phones/IDs/links) OR
      // if message contains http(s):// (legit URL replies pass).
      { name: "no-vietnamese-diacritic", re: /^(?!.*https?:\\/\\/)(?=[\\s\\S]{40,})(?!.*[àáảãạâấầẩẫậăắằẳẵặèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđÀÁẢÃẠÂẤẦẨẪẬĂẮẰẲẴẶÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴĐ]).+/s },
    ];
    let __ofBlocked: string | null = null;
    for (const __ofP of __ofBlockPatterns) {
      if (__ofP.re.test(body)) {
        __ofBlocked = __ofP.name;
        break;
      }
    }
    if (__ofBlocked) {
      // Log the blocked content to a dedicated audit file (never to main
      // stdout which could itself be exfiltrated). Write to workspace
      // logs/ dir so CEO can audit incidents.
      try {
        const __ofHome = __ofOs.homedir();
        // Resolve workspace logs dir cross-platform. Prefer MODORO_WORKSPACE
        // env (set by main.js at gateway spawn). Fallback to platform-specific
        // userData dir matching Electron's app.getPath('userData') which uses
        // the lowercase package.json \`name\` field "modoro-claw".
        const __ofAppDir = "modoro-claw";
        let __ofWsLogDir;
        if (process.env.MODORO_WORKSPACE) {
          __ofWsLogDir = __ofPath.join(process.env.MODORO_WORKSPACE, "logs");
        } else if (process.platform === "darwin") {
          __ofWsLogDir = __ofPath.join(__ofHome, "Library", "Application Support", __ofAppDir, "logs");
        } else if (process.platform === "win32") {
          const __ofAppData = process.env.APPDATA || __ofPath.join(__ofHome, "AppData", "Roaming");
          __ofWsLogDir = __ofPath.join(__ofAppData, __ofAppDir, "logs");
        } else {
          const __ofConfig = process.env.XDG_CONFIG_HOME || __ofPath.join(__ofHome, ".config");
          __ofWsLogDir = __ofPath.join(__ofConfig, __ofAppDir, "logs");
        }
        const __ofLogDir = __ofWsLogDir;
        __ofFs.mkdirSync(__ofLogDir, { recursive: true });
        const __ofAuditFile = __ofPath.join(__ofLogDir, "security-output-filter.jsonl");
        __ofFs.appendFileSync(
          __ofAuditFile,
          JSON.stringify({
            t: new Date().toISOString(),
            event: "zalo_output_blocked",
            pattern: __ofBlocked,
            to: to,
            accountId: account.accountId,
            bodyPreview: body.slice(0, 200),
            bodyLength: body.length,
          }) + "\\n",
          "utf-8",
        );
      } catch {}
      logOutbound("warn", "output filter blocked sensitive content", {
        accountId: account.accountId,
        pattern: __ofBlocked,
        bodyLength: body.length,
      });
      // Replace body with a safe canned message. Don't throw — we still
      // want the customer to get a reply, just not the leaked content.
      // Pick a context-appropriate fallback so it doesn't always look the
      // same (which would be a tell that the filter fired).
      const __ofSafeMsgs = [
        "Dạ em xin lỗi, cho em một phút em rà lại thông tin rồi báo lại mình ạ.",
        "Dạ em ghi nhận rồi ạ. Em sẽ kiểm tra và phản hồi lại mình ngay.",
        "Dạ em đang xác nhận lại thông tin, mình chờ em xíu nha.",
      ];
      const __ofSafeMsg = __ofSafeMsgs[Math.floor(Math.random() * __ofSafeMsgs.length)] || __ofSafeMsgs[0];
      (options as any).text = __ofSafeMsg;
      return await (async () => {
        const __ofSafeBody = __ofSafeMsg;
        const __ofArgs = ["msg", "send", target.threadId, __ofSafeBody];
        if (target.isGroup) __ofArgs.push("--group");
        try {
          const __ofResult = await runOpenzcaAccountCommand({
            account,
            binary: account.zcaBinary,
            profile: account.profile,
            args: __ofArgs,
            timeoutMs: 20_000,
          });
          const __ofRefs = parseOpenzcaMessageRefs(__ofResult.stdout);
          return {
            messageId: __ofRefs.msgId || "ok",
            msgId: __ofRefs.msgId,
            cliMsgId: __ofRefs.cliMsgId,
            kind: "text" as const,
            textPreview: __ofSafeBody.slice(0, 80),
          };
        } catch (__ofErr) {
          return { messageId: "filter-blocked", kind: "text" as const };
        }
      })();
    }
  } catch (__ofE) {
    // Filter error must not break legit sends. Log and fall through.
    try { logOutbound("error", "output filter error", { err: String(__ofE) }); } catch {}
  }
  // === END MODOROClaw OUTPUT-FILTER PATCH ===`;

    const patched = content.replace(anchor, anchor + injection);

    // SAFETY GUARD (v3): if patched content shrinks more than 50% vs the
    // original file size, the strip regex must have over-matched and would
    // corrupt send.ts. Abort the write rather than ship a broken plugin.
    // The injection ADDS ~150 lines, so a healthy patch should be LARGER
    // than the original; smaller-than-50% means we destroyed valid code.
    if (patched.length < originalLength * 0.5) {
      console.error(
        '[zalo-output-filter-fix] ABORT: patched send.ts shrank from ' +
        originalLength + ' to ' + patched.length + ' bytes (>50% loss). ' +
        'Strip regex likely over-matched. Leaving file untouched.'
      );
      return;
    }
    // Sanity check: marker must be present in patched output. If not, the
    // anchor.replace() did nothing (anchor was missing or matched zero
    // times) and we'd ship the unpatched file silently.
    if (!patched.includes(CURRENT_VERSION)) {
      console.error(
        '[zalo-output-filter-fix] ABORT: ' + CURRENT_VERSION +
        ' marker missing from patched output. Anchor replace failed.'
      );
      return;
    }

    fs.writeFileSync(pluginFile, patched, 'utf-8');
    console.log('[zalo-output-filter-fix] Injected output filter v3 into send.ts (' +
      originalLength + ' → ' + patched.length + ' bytes)');
  } catch (e) {
    console.error('[zalo-output-filter-fix] error:', e.message);
  }
}

// MODOROClaw FORCE-ONE-MESSAGE PATCH: openzalo plugin's `dispatchReplyWithBufferedBlockDispatcher`
// call passes `disableBlockStreaming` ONLY when `account.config.blockStreaming` is an explicit
// boolean. When openzalo config block is missing fields (which happens because openclaw 2026.4.x
// gateway normalizes/strips openzalo-specific fields at startup so the block becomes `{}`),
// disableBlockStreaming falls through to `undefined` → default ENABLED → block streaming with
// coalesceIdleMs=1000ms → model emits "D" → model pauses >1s → idle flush sends "D" standalone →
// then "ạ em chào..." arrives → sent as second message. CEO sees "Dạ" word split into 2 messages.
// Fix: rewrite the conditional `disableBlockStreaming: ...` expression to hardcoded `true` so it
// NEVER depends on config. Idempotent via "MODOROClaw FORCE-ONE-MESSAGE PATCH" marker.
function ensureOpenzaloForceOneMessageFix() {
  try {
    const pluginFile = path.join(HOME, '.openclaw', 'extensions', 'openzalo', 'src', 'inbound.ts');
    if (!fs.existsSync(pluginFile)) {
      console.warn('[zalo-force-one-msg] plugin file not present yet');
      return;
    }
    const content = fs.readFileSync(pluginFile, 'utf-8');
    if (content.includes('MODOROClaw FORCE-ONE-MESSAGE PATCH')) {
      console.log('[zalo-force-one-msg] already patched');
      return;
    }
    // Match the exact source form we expect. Plugin minor versions may vary whitespace
    // so we use a flexible regex.
    const re = /disableBlockStreaming:\s*\n?\s*typeof account\.config\.blockStreaming === "boolean"\s*\n?\s*\? !account\.config\.blockStreaming\s*\n?\s*: undefined\s*,/;
    if (!re.test(content)) {
      console.error('[zalo-force-one-msg] CRITICAL: conditional expression not found — plugin source has changed, pattern needs update');
      try {
        const diagPath = path.join(getWorkspace() || resourceDir, 'logs', 'boot-diagnostic.txt');
        fs.mkdirSync(path.dirname(diagPath), { recursive: true });
        fs.appendFileSync(diagPath,
          `\n[${new Date().toISOString()}] [zalo-force-one-msg] anchor regex failed — openzalo ` +
          `plugin source changed; Dạ/D split may reappear. Check ${pluginFile}\n`, 'utf-8');
      } catch {}
      return;
    }
    const replacement =
      '// MODOROClaw FORCE-ONE-MESSAGE PATCH: always disable block streaming regardless of\n' +
      '      // config — openclaw 2026.4.x gateway strips openzalo config fields to {} at startup,\n' +
      '      // so the old conditional fell back to undefined → default enabled → "Dạ" split.\n' +
      '      // Hardcoding true ensures Zalo ALWAYS sends one complete message per turn.\n' +
      '      disableBlockStreaming: true,';
    const patched = content.replace(re, replacement);
    fs.writeFileSync(pluginFile, patched, 'utf-8');
    // Verify write
    const verify = fs.readFileSync(pluginFile, 'utf-8');
    if (verify.includes('MODOROClaw FORCE-ONE-MESSAGE PATCH')) {
      console.log('[zalo-force-one-msg] patch applied + verified');
    } else {
      console.error('[zalo-force-one-msg] write verification FAILED');
    }
  } catch (e) {
    console.error('[zalo-force-one-msg] error:', e?.message || e);
  }
}

// MODOROClaw PATCH: OpenZalo plugin's `runOpenzcaStreaming` uses spawn(binary, args, {shell:true})
// where binary defaults to "openzca" (the npm shim). On Windows packaged installs, Electron's
// inherited PATH frequently does NOT include ~/AppData/Roaming/npm/, so cmd.exe can't find the
// shim → spawn exits non-zero → openzca listener never starts → CEO sees "Chưa sẵn sàng" forever.
// The patched template at electron/patches/openzalo-openzca.ts replaces all 3 spawn call sites
// with `spawn("node", [absolutePath/cli.js, ...args], {shell:false})` which bypasses cmd.exe and
// resolves the openzca CLI directly.
//
// CRITICAL: this function MUST resolve the template file in BOTH dev mode AND packaged install.
// Previously it used `path.join(resourceDir, 'electron', 'patches', ...)` which only worked in
// dev (resourceDir = Desktop/claw/, file at Desktop/claw/electron/patches/). In packaged install,
// resourceDir = resources/, but `electron/patches/` is bundled INSIDE app.asar, not extracted,
// so `resources/electron/patches/` does NOT exist → early-return silently → patch never applied
// → bug persists permanently. Fix: use __dirname/patches which resolves correctly in both modes
// (dev: Desktop/claw/electron/patches, packaged: app.asar/patches — Electron's fs transparently
// reads inside asar). Plus 2 fallback paths and a loud error if all fail.
function ensureOpenzaloShellFix() {
  try {
    const pluginFile = path.join(HOME, '.openclaw', 'extensions', 'openzalo', 'src', 'openzca.ts');
    if (!fs.existsSync(pluginFile)) {
      console.warn('[openzalo-fix] plugin file does not exist yet — openzalo not installed?');
      return;
    }
    const currentContent = fs.readFileSync(pluginFile, 'utf-8');
    // Two-tier version check: (1) MODOROClaw PATCH marker = any version patched,
    // (2) MODORO_OPENZCA_CLI_JS = v2+ patch which supports bundled-vendor via
    // env var override. If only (1) is present → force re-apply from newer
    // template so bundled .dmg installs can resolve openzca.
    const hasV1 = currentContent.includes('MODOROClaw PATCH');
    const hasV2 = currentContent.includes('MODORO_OPENZCA_CLI_JS');
    if (hasV1 && hasV2) {
      console.log('[openzalo-fix] already patched (v2 marker present)');
      return;
    }
    if (hasV1 && !hasV2) {
      console.log('[openzalo-fix] legacy v1 patch detected — upgrading to v2 (bundled-vendor support)');
    }
    // Try multiple template paths in priority order. First match wins.
    const candidates = [
      // Primary: __dirname/patches works in BOTH dev (electron/patches) AND
      // packaged install (app.asar/patches — Electron fs reads from inside asar).
      path.join(__dirname, 'patches', 'openzalo-openzca.ts'),
      // Fallback 1: legacy dev path (when running tests from outside electron/)
      path.join(resourceDir, 'electron', 'patches', 'openzalo-openzca.ts'),
      // Fallback 2: extraResources path (if we ever move patches/ to extraResources)
      path.join(process.resourcesPath || '', 'patches', 'openzalo-openzca.ts'),
      path.join(process.resourcesPath || '', 'app.asar.unpacked', 'patches', 'openzalo-openzca.ts'),
    ];
    let templateContent = null;
    let foundAt = null;
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          templateContent = fs.readFileSync(p, 'utf-8');
          foundAt = p;
          break;
        }
      } catch (e) {
        console.warn('[openzalo-fix] candidate read failed:', p, e.message);
      }
    }
    if (!templateContent) {
      // LOUD failure — this is the bug that caused weeks of "Zalo unstable".
      // Never silent fail again. Surface to console + boot diagnostic + Telegram.
      const msg = '[openzalo-fix] CRITICAL: patched template NOT FOUND in any candidate path. ' +
        'openzca listener will NOT start. Tried: ' + candidates.join(' | ');
      console.error(msg);
      try {
        const diagPath = path.join(getWorkspace() || resourceDir, 'logs', 'boot-diagnostic.txt');
        fs.mkdirSync(path.dirname(diagPath), { recursive: true });
        fs.appendFileSync(diagPath, `\n[${new Date().toISOString()}] ${msg}\n`, 'utf-8');
      } catch {}
      return;
    }
    // Verify template itself is valid before writing
    if (!templateContent.includes('MODOROClaw PATCH')) {
      console.error('[openzalo-fix] CRITICAL: template at ' + foundAt + ' is missing MODOROClaw PATCH marker — refusing to apply (corrupt?)');
      return;
    }
    fs.writeFileSync(pluginFile, templateContent, 'utf-8');
    console.log('[openzalo-fix] Patched openzca.ts from template at ' + foundAt + ' (' + templateContent.length + ' bytes)');
    // Verify write succeeded
    const verify = fs.readFileSync(pluginFile, 'utf-8');
    if (!verify.includes('MODOROClaw PATCH')) {
      console.error('[openzalo-fix] CRITICAL: write verification failed — file does not contain marker after write');
    } else {
      console.log('[openzalo-fix] write verified — openzca.ts now has patch');
    }
  } catch (e) {
    console.error('[openzalo-fix] error:', e?.message || e);
  }
}

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
async function startOpenClaw() {
  if (botRunning) return;
  // Prevent re-entrant start while a previous start is still spawning. Without
  // this guard, heartbeat + UI button + boot sequence can race and spawn 2-3
  // gateway processes that fight over port 18789.
  if (_startOpenClawInFlight) {
    console.log('[startOpenClaw] already in progress — skipping duplicate call');
    return;
  }
  _startOpenClawInFlight = true;
  try { return await _startOpenClawImpl(); }
  finally { _startOpenClawInFlight = false; }
}
async function _startOpenClawImpl() {
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
  ensureOpenzaloNodeModulesLink();
  // Re-apply OpenZalo shell fix in case plugin was reinstalled
  ensureOpenzaloShellFix();
  // Re-apply blocklist injection (idempotent)
  ensureZaloBlocklistFix();
  // Friend check: inject stranger-handling logic (depends on blocklist anchor)
  ensureZaloFriendCheckFix();
  // Owner marker: tag DMs from CEO's personal Zalo so bot switches to CEO mode
  // (depends on friend-check anchor — must run AFTER it)
  ensureZaloOwnerFix();
  // Patch openzca daemon to listen for friend_event + auto-accept friend requests
  // + refresh cache instantly. This is what makes the friend-check feel "instant"
  // — without it, friends.json only updates on login or manual cache-refresh, so
  // a brand-new friend would have to wait 5-10 minutes before bot recognized them.
  ensureOpenzcaFriendEventFix();
  // Output filter: scan outbound Zalo text for sensitive patterns (Security Layer 2)
  ensureZaloOutputFilterFix();
  // Force-one-message: hardcode disableBlockStreaming=true in openzalo inbound.ts
  // so "Dạ" word never gets split between messages regardless of config drift.
  ensureOpenzaloForceOneMessageFix();

  // Rebuild memory DB — use absolute node path so it works even if Electron's
  // PATH doesn't include the user's Node install (nvm/volta/scoop/etc.).
  try {
    const rebuildScript = path.join(resourceDir, 'tools', 'memory-db', 'rebuild-db.js');
    if (fs.existsSync(rebuildScript)) {
      const nodeBin = findNodeBin() || 'node';
      await execFilePromise(nodeBin, [rebuildScript], { timeout: 10000, cwd: resourceDir, stdio: 'pipe' });
    }
  } catch (e) { console.error('Memory DB rebuild failed:', e.message); }

  // Check if gateway already running — if yes, just adopt it
  const alreadyRunning = await isGatewayAlive();
  if (alreadyRunning) {
    console.log('Gateway already running on :18789 — adopting');
    botRunning = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('bot-status', { running: true });
    createTray();
    return;
  }

  // Cold start: clean up any stale Zalo listener tree before spawning new gateway
  cleanupOrphanZaloListener();

  // Wait for 9Router /v1/models — bumped from 10 to 60 iterations because Node
  // module loading on Windows can take 15-20s. If we spawn the gateway before
  // 9router responds, the openzalo plugin's first call to 9router fails with
  // ECONNREFUSED → triggers a 30-60s retry-with-backoff stack inside the plugin
  // → CEO sees "2-3 phút before bot replies".
  let nineRouterReady = false;
  let nineRouterModelCount = 0;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
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
      console.log(`[boot] T+${Date.now() - t0}ms 9Router /v1/models ready (after ${i + 1}s), ${nineRouterModelCount} models`);
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
        'Combo AI `main` không có model nào. Bot sẽ KHÔNG phản hồi và cron sẽ FAIL cho tới khi anh vào tab *9Router* trong Dashboard, chọn model cho combo `main` và bấm Save.'
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
  // Expose workspace path so plugin patches (e.g. ensureZaloOwnerFix) can find
  // workspace files regardless of dev vs packaged. main.js getWorkspace()
  // already resolved the correct location at this point.
  // SECURITY: explicitly delete any pre-existing MODORO_WORKSPACE from the
  // user's shell env BEFORE setting our own value. Without this, if the user
  // launches Electron from a shell with `MODORO_WORKSPACE=/tmp` set (or any
  // other poisoned value), and getWorkspace() throws for any reason, the
  // gateway would inherit the poisoned value and patches would write to /tmp.
  delete enrichedEnv.MODORO_WORKSPACE;
  try {
    const __ws = getWorkspace();
    if (__ws) enrichedEnv.MODORO_WORKSPACE = __ws;
  } catch (e) {
    console.warn('[gateway] could not resolve MODORO_WORKSPACE:', e?.message);
  }
  try {
    const npmBinDirs = [];
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
      enrichedEnv.MODORO_OPENZCA_CLI_JS = foundOzCli;
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
  // gets ECONNREFUSED. Cold-start budget: 90 seconds. On a slow first install,
  // openclaw may take that long to load all plugins + bind ports. The Path B
  // retry loop covers any case where this still isn't enough.
  const gwReadyDeadline = Date.now() + 90000;
  let gwReady = false;
  let probeAttempts = 0;
  while (Date.now() < gwReadyDeadline) {
    probeAttempts++;
    try {
      if (await isGatewayAlive(2000)) { gwReady = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  if (gwReady) {
    const elapsedMs = 90000 - (gwReadyDeadline - Date.now());
    console.log(`[startOpenClaw] gateway WS ready on :18789 after ${elapsedMs}ms (${probeAttempts} probes)`);
    auditLog('gateway_ready', { elapsedMs, probeAttempts });
  } else {
    // Don't WARN — that scared the user last time. The retry+Telegram path
    // catches any first-cron-fire that races a still-warming gateway.
    console.log(`[startOpenClaw] gateway WS still not responding to GET / after 90s (${probeAttempts} probes). Cron retries will handle warmup.`);
    auditLog('gateway_slow_start', { probeAttempts });
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
  // H1 throttle: if a readiness notification was already sent within the
  // last 10 minutes, suppress re-notify on subsequent gateway restarts (e.g.
  // mid-demo Stop/Start, heartbeat watchdog fire). CEO shouldn't see the
  // "Telegram đã sẵn sàng" message twice in the same session. The watchdog
  // recovery path still works silently — channel is ready, just no duplicate
  // notification. A fresh boot after >10min gap (app restart next day) still
  // fires normally.
  const READY_NOTIFY_THROTTLE_MS = 10 * 60 * 1000;
  const readyNotifyThrottled = () => {
    return global._lastReadyNotifyAt &&
      (Date.now() - global._lastReadyNotifyAt) < READY_NOTIFY_THROTTLE_MS;
  };
  const readinessBuf = { tg: '', zl: '' };
  const scanForReadiness = (chunk) => {
    try {
      const text = chunk.toString('utf8');
      // Telegram marker
      if (!notifyState.telegramReady && /\[telegram\]\s*\[\w+\]\s*starting provider/i.test(text)) {
        notifyState.telegramReady = true;
        console.log('[ready-notify] Telegram channel confirmed ready via gateway marker');
        if (readyNotifyThrottled()) {
          console.log('[ready-notify] Telegram notify throttled (last sent <10min ago)');
        } else {
          global._lastReadyNotifyAt = Date.now();
          sendTelegram(
            '*Telegram đã sẵn sàng*\n\n' +
            'Bot đã kết nối + đăng ký channel. Nhắn bất kỳ tin nào ngay bây giờ, sẽ có reply thật.\n\n' +
            '_(Thông báo này tự bot gửi — nếu anh nhận được = Telegram đã work 100%)_'
          ).then(ok => console.log('[ready-notify] Telegram notify sent:', ok))
           .catch(() => {});
        }
      }
      // Zalo marker — openzca listener connected = inbound pipeline live
      if (!notifyState.zaloReady && /\[openzalo\]\s*\[\w+\]\s*openzca connected/i.test(text)) {
        notifyState.zaloReady = true;
        console.log('[ready-notify] Zalo channel confirmed ready via gateway marker');
        if (readyNotifyThrottled()) {
          console.log('[ready-notify] Zalo notify throttled (last sent <10min ago)');
        } else {
          global._lastReadyNotifyAt = Date.now();
          sendTelegram(
            '*Zalo đã sẵn sàng*\n\n' +
            'Openzca listener đã connect Zalo web, đang đọc tin nhắn. Nhắn bot trên Zalo ngay bây giờ, sẽ có reply thật.\n\n' +
            '_(Thông báo gửi qua Telegram vì hệ thống không có Zalo ID của anh)_'
          ).then(ok => console.log('[ready-notify] Zalo notify sent:', ok))
           .catch(() => {});
        }
      }
    } catch (e) { /* never break on observer */ }
  };
  openclawProcess.stdout.on('data', scanForReadiness);
  openclawProcess.stderr.on('data', scanForReadiness);

  openclawProcess.on('exit', (code) => {
    botRunning = false;
    openclawProcess = null;
    console.log('Gateway exited with code', code, 'lastError:', lastError?.substring(0, 100));

    const isRestart = lastError?.includes('restart') || lastError?.includes('SIGUSR1');

    if (isRestart) {
      // /restart command — notify user, restart immediately
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bot-status', { running: false, error: 'Đang khởi động lại... vui lòng đợi 30 giây.' });
      }
      // Start fresh immediately — no need to wait for self-restart (doesn't work on Windows)
      setTimeout(() => startOpenClaw(), 2000);
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

function stopOpenClaw() {
  botRunning = false;
  if (openclawProcess) {
    const proc = openclawProcess;
    openclawProcess = null;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', proc.pid.toString(), '/f', '/t'], { stdio: 'ignore' });
    } else {
      proc.kill('SIGINT');
    }
  }
  // Also kill adopted/orphan gateway
  killPort(18789);
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
        'User-Agent': 'MODOROClaw-Wizard/1.0',
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
              error: 'Phản hồi từ Ollama không phải JSON — có thể anh đang ở mạng captive portal (Wi-Fi khách sạn / quán cafe). Thử lại với mạng khác.',
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

// Wait for 9router to be reachable. Polls /api/settings (lightweight,
// always present) every 500ms up to maxMs. Returns true if responsive.
async function waitFor9RouterReady(maxMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const r = await nineRouterApi('GET', '/api/settings', null, 1500);
    if (r.success || (r.statusCode && r.statusCode < 500)) return true;
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
        const ready = await waitFor9RouterReady(10000);
        if (!ready) {
          throw new Error('9router không khởi động được trong 10 giây — fallback file mode');
        }
        console.log('[setup-9router-auto] 9router API reachable');

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

        // 3. Create new Ollama provider
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

        // 4. Test it (THIS is the fast validator — usually 1-3 seconds)
        const testRes = await nineRouterApi('POST', `/api/providers/${providerId}/test`, null, 8000);
        const testValid = testRes.success && (testRes.data?.valid !== false);
        if (!testValid) {
          // Delete the bad provider so it doesn't pollute db.json
          await nineRouterApi('DELETE', `/api/providers/${providerId}`);
          const errMsg = testRes.data?.error || testRes.error || 'Ollama key không hợp lệ';
          console.warn('[setup-9router-auto] provider test failed:', errMsg);
          // Map common 9router errors to Vietnamese
          let viError = errMsg;
          if (/401|unauthor/i.test(errMsg)) {
            viError = 'Ollama API key sai hoặc đã hết hạn. Vào ollama.com/settings/keys → tạo key mới → paste lại.';
          } else if (/timeout|ETIMEDOUT/i.test(errMsg)) {
            viError = 'Timeout khi gọi Ollama. Kiểm tra kết nối Internet.';
          } else if (/ENOTFOUND|DNS/i.test(errMsg)) {
            viError = 'Không kết nối được ollama.com. Kiểm tra Internet.';
          } else if (/429|rate/i.test(errMsg)) {
            viError = 'Ollama trả về 429 (rate limit). Đợi 1 phút rồi thử lại.';
          }
          return {
            success: false,
            error: viError,
            validationFailed: true,
          };
        }
        console.log('[setup-9router-auto] provider test PASSED');

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
            error: 'Ollama key hợp lệ nhưng không có model nào. Tài khoản Ollama của anh có thể chưa subscribe gói nào.',
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
          const createKey = await nineRouterApi('POST', '/api/keys', { name: 'MODOROClaw' });
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
        apiKey: opts.ollamaKey,
        priority: 1,
        isActive: true,
        testStatus: 'unknown',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
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
      apiKey = { id: randomUUID(), name: 'MODOROClaw', key: keyValue, machineId, isActive: true, createdAt: new Date().toISOString() };
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
    // Clean up broken state if exists
    if (fs.existsSync(pluginNodeModules)) {
      try { fs.rmSync(pluginNodeModules, { recursive: true, force: true }); } catch {}
    }
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
    if (vendorDir && !fs.existsSync(path.join(extensionsDir, 'openclaw.plugin.json'))) {
      const bundledPlugin = path.join(vendorDir, 'node_modules', '@tuyenhx', 'openzalo');
      if (fs.existsSync(path.join(bundledPlugin, 'openclaw.plugin.json'))) {
        try {
          fs.mkdirSync(extensionsDir, { recursive: true });
          // Recursive copy — use fs.cpSync (Node 16.7+). Safe on Electron 28 (Node 18).
          fs.cpSync(bundledPlugin, extensionsDir, { recursive: true, force: true, errorOnExist: false });
          console.log('[ensureZaloPlugin] copied bundled openzalo plugin from vendor →', extensionsDir);
          // Also ensure plugins.entries.openzalo.enabled=true in openclaw.json
          // so the gateway knows to load it on next boot.
          try {
            const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
            if (fs.existsSync(configPath)) {
              const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
              if (!cfg.plugins) cfg.plugins = {};
              if (!cfg.plugins.entries) cfg.plugins.entries = {};
              if (!cfg.plugins.entries.openzalo) cfg.plugins.entries.openzalo = { enabled: true };
              else cfg.plugins.entries.openzalo.enabled = true;
              writeOpenClawConfigIfChanged(configPath, cfg);
            }
          } catch (e) { console.warn('[ensureZaloPlugin] config update failed:', e?.message); }
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
          // CRITICAL: the bundled plugin ships the upstream openzca.ts (no
          // MODOROClaw patches). We MUST apply our two runtime patches
          // immediately after copy so the very first gateway boot reads the
          // patched files. Without these, Windows multi-line args get
          // truncated by cmd.exe AND Mac builds can't resolve bundled openzca
          // via MODORO_OPENZCA_CLI_JS env var.
          try { ensureOpenzaloShellFix(); } catch (e) { console.warn('[ensureZaloPlugin] shell fix failed:', e?.message); }
          try { ensureZaloBlocklistFix(); } catch (e) { console.warn('[ensureZaloPlugin] blocklist fix failed:', e?.message); }
          try { ensureZaloFriendCheckFix(); } catch (e) { console.warn('[ensureZaloPlugin] friend check fix failed:', e?.message); }
          try { ensureZaloOwnerFix(); } catch (e) { console.warn('[ensureZaloPlugin] zalo owner fix failed:', e?.message); }
          try { ensureZaloOutputFilterFix(); } catch (e) { console.warn('[ensureZaloPlugin] output filter fix failed:', e?.message); }
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

      // Patch openzalo plugin for Windows only (shell:true + shellSafeArgs)
      if (process.platform !== 'win32') { /* skip patch on Mac/Linux */ }
      else {
      const openzaloSrc = path.join(HOME, '.openclaw', 'extensions', 'openzalo', 'src', 'openzca.ts');
      if (fs.existsSync(openzaloSrc)) {
        try {
          let src = fs.readFileSync(openzaloSrc, 'utf-8');
          let changed = false;
          if (src.includes('shell: false')) { src = src.replace(/shell: false/g, 'shell: true'); changed = true; }
          if (!src.includes('shellSafeArgs')) {
            const helper = `\n// On Windows with shell:true, args containing spaces must be quoted\nfunction shellSafeArgs(args: string[]): string[] {\n  if (process.platform !== "win32") return args;\n  return args.map(a => (a.includes(" ") || a.includes("&") || a.includes("|")) ? \`"\${a}"\` : a);\n}\n`;
            src = src.replace(/import { spawn } from "node:child_process";/, 'import { spawn } from "node:child_process";\n' + helper);
            src = src.replace(/const args = \["--profile", options\.profile, \.\.\.options\.args\]/g, 'const args = shellSafeArgs(["--profile", options.profile, ...options.args])');
            changed = true;
          }
          if (changed) fs.writeFileSync(openzaloSrc, src, 'utf-8');
        } catch {}
      }
      } // end Windows-only patch
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
        // Only count as new login if file was modified AFTER login started
        const mtime = fs.statSync(p).mtimeMs;
        if (_zaloLoginStartedAt && mtime < _zaloLoginStartedAt) continue; // old file, skip
        return { loggedIn: true };
      }
    }
    // Also try openzca status command
    try {
      const zcaBin = process.platform === 'win32' ? 'openzca.cmd' : 'openzca';
      const { stdout } = await execFilePromise(zcaBin, ['auth', 'status'], { timeout: 5000, encoding: 'utf-8', stdio: 'pipe', shell: process.platform === 'win32', windowsHide: true });
      if (stdout.toLowerCase().includes('logged in') || stdout.toLowerCase().includes('authenticated')) return { loggedIn: true };
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

ipcMain.handle('list-zalo-friends', async () => {
  try {
    const p = path.join(getZcaCacheDir(), 'friends.json');
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    // Normalize — only return fields the UI needs
    return (Array.isArray(data) ? data : []).map(f => ({
      userId: String(f.userId || f.userKey || ''),
      displayName: f.displayName || f.zaloName || f.username || '(không tên)',
      avatar: f.avatar || '',
      phoneNumber: f.phoneNumber || '',
      isFriend: f.isFr === 1,
      isBlocked: f.isBlocked === 1,
    })).filter(f => f.userId);
  } catch (e) {
    console.error('[zalo] list friends error:', e.message);
    return [];
  }
});

// Refresh openzca cache directly (shared helper).
// Searches ALL node-manager lib dirs for openzca/dist/cli.js (handles mixed
// nvm/system Node setups), then spawns via absolute node path so PATH issues
// can't break this on Mac Finder launches.
async function runZaloCacheRefresh() {
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
    return true;
  } catch (e) {
    console.error('[zalo-cache] refresh failed:', e.message);
    return false;
  }
}

// Periodic auto-refresh (every 10 min) so new groups/friends show up without manual action
let _zaloCacheInterval = null;
function startZaloCacheAutoRefresh() {
  if (_zaloCacheInterval) clearInterval(_zaloCacheInterval);
  _zaloCacheInterval = setInterval(() => {
    runZaloCacheRefresh().then(ok => {
      if (ok && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('zalo-cache-refreshed');
      }
    });
  }, 10 * 60 * 1000); // 10 minutes
}

// Trigger openzca to refresh its cache from live Zalo server (manual)
ipcMain.handle('refresh-zalo-cache', async () => {
  const ok = await runZaloCacheRefresh();
  return { success: ok };
});

ipcMain.handle('list-zalo-groups', async () => {
  try {
    const p = path.join(getZcaCacheDir(), 'groups.json');
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return (Array.isArray(data) ? data : []).map(g => ({
      groupId: String(g.groupId || g.id || ''),
      name: g.name || g.groupName || '(không tên)',
      avatar: g.avatar || g.groupAvatar || '',
      memberCount: g.totalMember || g.memberCount || (g.memberIds?.length) || 0,
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
    const ws = getWorkspace();
    const filePath = path.join(ws, 'memory', 'zalo-users', senderId + '.md');
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

// === Zalo owner identification ===
// CEO has 2 Zalo accounts: (1) the bot account that openzca logs in to,
// (2) their personal Zalo that talks to the bot. We need to recognize (2)
// so the bot treats those messages as CEO commands instead of customer
// service replies. Saved as { ownerUserId, ownerName, savedAt } in
// workspace/zalo-owner.json. Read by ensureZaloOwnerFix patch in
// inbound.ts at message dispatch time.

function getZaloOwnerPath() {
  const ws = getWorkspace();
  if (!ws) return null;
  return path.join(ws, 'zalo-owner.json');
}

function readZaloOwner() {
  try {
    const p = getZaloOwnerPath();
    if (!p || !fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf-8');
    const data = JSON.parse(raw);
    if (!data || typeof data.ownerUserId !== 'string' || !data.ownerUserId) return null;
    return data;
  } catch { return null; }
}

ipcMain.handle('get-zalo-owner', async () => {
  return readZaloOwner() || { ownerUserId: '', ownerName: '' };
});

ipcMain.handle('save-zalo-owner', async (_event, payload) => {
  try {
    const ws = getWorkspace();
    if (!ws) return { success: false, error: 'workspace không tồn tại' };
    const userId = String((payload && payload.ownerUserId) || '').trim().replace(/[^0-9-]/g, '').slice(0, 32);
    const name = String((payload && payload.ownerName) || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 100);
    if (!userId) return { success: false, error: 'userId rỗng hoặc không hợp lệ' };
    const data = { ownerUserId: userId, ownerName: name, savedAt: new Date().toISOString() };
    fs.writeFileSync(getZaloOwnerPath(), JSON.stringify(data, null, 2), 'utf-8');
    try { auditLog('zalo_owner_set', { ownerUserId: userId, ownerName: name }); } catch {}
    return { success: true };
  } catch (e) {
    console.error('[zalo-owner] save error:', e?.message);
    return { success: false, error: e.message };
  }
});

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
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
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
    return {
      enabled: zalo.enabled !== false,
      groupPolicy: zalo.groupPolicy || 'open',
      groupAllowFrom: Array.isArray(zalo.groupAllowFrom) ? zalo.groupAllowFrom.filter(x => x !== '*') : [],
      dmPolicy: zalo.dmPolicy || 'open',
      userBlocklist: Array.isArray(blocklist) ? blocklist : [],
    };
  } catch (e) {
    return { enabled: true, groupPolicy: 'open', groupAllowFrom: [], dmPolicy: 'open', userBlocklist: [] };
  }
});

ipcMain.handle('save-zalo-manager-config', async (_event, { enabled, groupPolicy, groupAllowFrom, userBlocklist }) => {
  try {
    // 1. Update openclaw.json (groups handled natively by OpenZalo)
    const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (!cfg.channels) cfg.channels = {};
      if (!cfg.channels.openzalo) cfg.channels.openzalo = {};
      cfg.channels.openzalo.enabled = enabled !== false;
      if (groupPolicy === 'allowlist') {
        cfg.channels.openzalo.groupPolicy = 'allowlist';
        cfg.channels.openzalo.groupAllowFrom = Array.isArray(groupAllowFrom) && groupAllowFrom.length > 0
          ? groupAllowFrom
          : [];
      } else {
        cfg.channels.openzalo.groupPolicy = 'open';
        cfg.channels.openzalo.groupAllowFrom = ['*'];
      }
      // CRITICAL: openzalo plugin defaults dmPolicy to "pairing" → unknown DM
      // sender → "OpenClaw: access not configured." pairing reply. We always
      // want CEO + their contacts to DM the bot directly without pairing dance.
      // Force dmPolicy="open" + allowFrom=["*"] every save so wizard/manager
      // never leaves these unset (which would re-trigger pairing on next boot).
      cfg.channels.openzalo.dmPolicy = 'open';
      if (!Array.isArray(cfg.channels.openzalo.allowFrom)) {
        cfg.channels.openzalo.allowFrom = ['*'];
      }
      writeOpenClawConfigIfChanged(configPath, cfg);
    }
    // 2. Write user blocklist to workspace (bot reads this per AGENTS.md rule)
    const bp = getZaloBlocklistPath();
    fs.writeFileSync(bp, JSON.stringify(userBlocklist || [], null, 2), 'utf-8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Save personalization (industry, tone, pronouns)
ipcMain.handle('save-personalization', async (_event, { industry, tone, pronouns, ceoTitle, botName }) => {
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
        'em-anh-chi': 'em — gọi chủ nhân là ' + ceoTitle,
        'toi-quy-khach': 'tôi — gọi chủ nhân là ' + ceoTitle,
        'minh-ban': 'mình — gọi chủ nhân là ' + ceoTitle,
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
      const botNameLine = `- **Tên:** ${botName || 'Trợ lý MODOROClaw'}`;
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
    } = payload || {};

    // Sanitize inputs (file content goes into Markdown templates → strip control chars)
    const sanitize = (s, maxLen = 500) => String(s || '').replace(/[\u0000-\u001F\u007F]/g, ' ').substring(0, maxLen).trim();
    const cName = sanitize(companyName, 100);
    const cDesc = sanitize(companyDesc, 500);
    const ceoN = sanitize(ceoName, 100);
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
      fs.writeFileSync(schedPath, JSON.stringify(schedules, null, 2), 'utf-8');
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
        '# Mục tiêu CEO khi dùng MODOROClaw\n\n' +
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
  try {
    const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    let config = {};
    if (fs.existsSync(configPath)) {
      try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch {}
    }
    for (const op of ops) {
      const parts = op.path.split('.');
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

// Save config by writing openclaw.json directly — no CLI dependency
ipcMain.handle('save-wizard-config', async (_event, configs) => {
  try {
    const configPath = path.join(HOME, '.openclaw', 'openclaw.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    let config = {};
    if (fs.existsSync(configPath)) {
      try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch {}
    }
    for (const { key, value } of configs) {
      const parts = key.split('.');
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
      fs.writeFileSync(getSchedulesPath(), JSON.stringify(schedules, null, 2), 'utf-8');
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
          sendTelegram(`🚨 *schedules.json bị lỗi JSON*\n\n\`${parseErr.message}\`\n\nĐã backup về \`${path.basename(backupPath)}\` và fall back về default schedules. Vào Dashboard → Lịch để xem.`);
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
            fs.mkdirSync(path.dirname(schedulesPath), { recursive: true });
            fs.writeFileSync(schedulesPath, JSON.stringify(data, null, 2), 'utf-8');
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
    fs.writeFileSync(getCustomCronsPath(), JSON.stringify(crons, null, 2), 'utf-8');
    // CRITICAL: do NOT rely on the file watcher alone — fs.watch is unreliable
    // on Windows + atomic-replace editors. Explicitly reload cron jobs after
    // every write so the new schedule takes effect immediately, even if the
    // watcher missed the event. The watcher's debounce will dedupe the second
    // call if it does fire.
    try { restartCronJobs(); } catch (e) { console.error('[save-custom-crons] restartCronJobs error:', e.message); }
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('save-schedules', async (_event, schedules) => {
  try {
    fs.writeFileSync(getSchedulesPath(), JSON.stringify(schedules, null, 2), 'utf-8');
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

// Build prompts used by BOTH the real scheduled cron AND the Dashboard "Test"
// button. Keeping them in one place guarantees test fires are byte-identical to
// what customers receive from scheduled runs — no test markers, no template
// drift. If you change cron behavior, change it here and both paths follow.
function buildMorningBriefingPrompt(timeStr) {
  try { writeDailyMemoryJournal({ date: new Date(Date.now() - 86400000) }); } catch {}
  const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
  const history = extractConversationHistory({ sinceMs, maxMessages: 50 });
  const historyBlock = history
    ? `\n\n--- LỊCH SỬ TIN NHẮN 24H QUA (đã trích từ session storage, KHÔNG cần em đi tìm thêm) ---\n${history}\n--- HẾT LỊCH SỬ ---\n\n`
    : `\n\n_(Chưa có tin nhắn nào trong 24h qua — nếu CEO mới setup hoặc chưa ai nhắn thì điều này bình thường.)_\n\n`;
  return (
    `Bây giờ là ${timeStr || '07:30'} sáng. Hãy gửi BÁO CÁO SÁNG cho CEO qua Telegram.` +
    historyBlock +
    `Dựa trên lịch sử tin nhắn ở trên + AGENTS.md + memory/ + knowledge công ty, tổng hợp:\n` +
    `1. Tóm tắt việc hôm qua (kết quả, deal đã chốt, vấn đề tồn đọng)\n` +
    `2. Lịch họp / việc cần làm hôm nay (ưu tiên cao trước)\n` +
    `3. Tin nhắn Zalo + Telegram cần xử lý (chỉ liệt kê tin có nội dung công việc, không liệt kê "hi" trống)\n` +
    `4. Cảnh báo / nhắc nhở quan trọng\n\n` +
    `Trả lời bằng tiếng Việt, ngắn gọn, dùng tiêu đề **BÁO CÁO SÁNG** in đậm + bullet points. ` +
    `KHÔNG dùng emoji (premium UI rule — bot phải sang trọng, chuyên nghiệp). ` +
    `KHÔNG hỏi lại CEO. KHÔNG yêu cầu CEO gõ lệnh. ` +
    `KHÔNG nói "em không có dữ liệu" — nếu lịch sử trên rỗng thì nói thẳng "Hôm qua không có tin nhắn nào đáng chú ý" và chuyển sang phần lịch hôm nay.`
  );
}

function buildEveningSummaryPrompt(timeStr) {
  try { writeDailyMemoryJournal({ date: new Date() }); } catch {}
  const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
  const history = extractConversationHistory({ sinceMs, maxMessages: 50 });
  const historyBlock = history
    ? `\n\n--- LỊCH SỬ TIN NHẮN 24H QUA (đã trích từ session storage, KHÔNG cần em đi tìm thêm) ---\n${history}\n--- HẾT LỊCH SỬ ---\n\n`
    : `\n\n_(Chưa có tin nhắn nào trong 24h qua.)_\n\n`;
  return (
    `Bây giờ là ${timeStr || '21:00'}, hết ngày làm việc. Hãy gửi TÓM TẮT CUỐI NGÀY cho CEO qua Telegram.` +
    historyBlock +
    `Dựa trên lịch sử tin nhắn ở trên + memory/ + knowledge, tổng hợp:\n` +
    `1. Kết quả hôm nay so với mục tiêu (việc đã xong, deal đã chốt, doanh thu nếu có)\n` +
    `2. Vấn đề tồn đọng cần xử lý\n` +
    `3. Kế hoạch / ưu tiên cho ngày mai\n` +
    `4. Cảnh báo / nhắc nhở quan trọng\n\n` +
    `Trả lời bằng tiếng Việt, ngắn gọn, dùng tiêu đề **TÓM TẮT CUỐI NGÀY** in đậm + bullet points. ` +
    `KHÔNG dùng emoji (premium UI rule). ` +
    `KHÔNG hỏi lại CEO. KHÔNG nói "em không có dữ liệu" — nếu rỗng thì nói "Hôm nay không có hoạt động đáng chú ý" và liệt kê plan ngày mai.`
  );
}

function buildWeeklyReportPrompt() {
  const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const history = extractConversationHistory({ sinceMs, maxMessages: 100 });
  const historyBlock = history
    ? `\n\n--- LỊCH SỬ TIN NHẮN 7 NGÀY QUA ---\n${history}\n--- HẾT LỊCH SỬ ---\n\n`
    : `\n\n_(Không có tin nhắn nào trong 7 ngày qua.)_\n\n`;
  return (
    `Hôm nay là thứ 2. Hãy gửi BÁO CÁO TUẦN cho CEO qua Telegram.` +
    historyBlock +
    `Dựa trên lịch sử tin nhắn + memory/ + knowledge + audit log, tổng hợp:\n` +
    `1. Tổng kết tuần qua: việc đã xong, deal đã chốt, khách mới qua Zalo/Telegram\n` +
    `2. Vấn đề tồn đọng / chưa giải quyết\n` +
    `3. Số liệu: tổng tin nhắn xử lý, cron đã chạy, khách Zalo mới kết bạn\n` +
    `4. Ưu tiên tuần tới\n` +
    `5. Đề xuất cải thiện (nếu có)\n\n` +
    `Trả lời bằng tiếng Việt, dùng tiêu đề **BÁO CÁO TUẦN** in đậm + bullet points. ` +
    `KHÔNG dùng emoji. KHÔNG hỏi lại CEO. Nếu data ít thì tóm ngắn, KHÔNG kêu CEO setup thêm gì.`
  );
}

function buildMonthlyReportPrompt() {
  const sinceMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const history = extractConversationHistory({ sinceMs, maxMessages: 200 });
  const historyBlock = history
    ? `\n\n--- LỊCH SỬ TIN NHẮN 30 NGÀY QUA (tóm tắt) ---\n${history}\n--- HẾT LỊCH SỬ ---\n\n`
    : `\n\n_(Không có tin nhắn trong 30 ngày qua.)_\n\n`;
  return (
    `Ngày 1 tháng mới. Hãy gửi BÁO CÁO THÁNG cho CEO qua Telegram.` +
    historyBlock +
    `Dựa trên lịch sử + memory/ + knowledge, tổng hợp:\n` +
    `1. Tổng kết tháng: kết quả nổi bật, milestone đạt được\n` +
    `2. Khách hàng: khách mới, khách quay lại, khách mất (nếu có data)\n` +
    `3. Hoạt động bot: tổng tin xử lý, cron runs, errors (nếu có)\n` +
    `4. So sánh với tháng trước (nếu có data memory)\n` +
    `5. Kế hoạch + ưu tiên tháng tới\n\n` +
    `Trả lời bằng tiếng Việt, dùng tiêu đề **BÁO CÁO THÁNG** in đậm + bullet points. ` +
    `KHÔNG dùng emoji. KHÔNG hỏi lại CEO. Nếu data ít thì tóm ngắn.`
  );
}

function buildZaloFollowUpPrompt() {
  return (
    `Kiểm tra khách hàng Zalo mới cần follow-up. Đọc tất cả file trong memory/zalo-users/*.md.\n\n` +
    `Với mỗi khách:\n` +
    `- Nếu kết bạn > 24h mà CHƯA có cuộc trò chuyện nào (file chỉ có header, không có note) → liệt kê\n` +
    `- Nếu khách hỏi giá/đặt lịch > 48h mà không reply tiếp → liệt kê\n\n` +
    `Gửi danh sách cho CEO qua Telegram với format:\n` +
    `**FOLLOW-UP KHÁCH ZALO**\n` +
    `- [Tên khách] — kết bạn [ngày], chưa tương tác\n` +
    `- [Tên khách] — hỏi [nội dung] ngày [ngày], chưa phản hồi\n\n` +
    `Nếu không có khách nào cần follow-up → nói "Không có khách cần follow-up hôm nay" (1 câu). ` +
    `KHÔNG dùng emoji. KHÔNG hỏi lại CEO.`
  );
}

function buildMemoryCleanupPrompt() {
  return (
    `Dọn dẹp memory. Đọc tất cả file trong memory/ (trừ zalo-users/).\n\n` +
    `1. Tìm các journal entries cũ > 7 ngày, tổng hợp những insight quan trọng\n` +
    `2. Ghi tổng hợp tuần vào memory/weekly-digest.md (append, không xóa cũ)\n` +
    `3. Xác định thông tin trùng lặp hoặc outdated trong memory files\n\n` +
    `Gửi CEO báo cáo ngắn qua Telegram:\n` +
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
        const ok = await runCronAgentPrompt(prompt, { label: 'morning-briefing' });
        return { success: ok, sent: ok };
      } else if (id === 'evening') {
        const prompt = buildEveningSummaryPrompt(s.time);
        const ok = await runCronAgentPrompt(prompt, { label: 'evening-summary' });
        return { success: ok, sent: ok };
      } else if (id === 'heartbeat') {
        const sent = await sendTelegram(`*Heartbeat*\n\nHệ thống đang hoạt động bình thường.`);
        return { success: sent === true, sent };
      } else if (id === 'meditation') {
        const sent = await sendTelegram(`*Tối ưu ban đêm*\n\nCron thật sẽ ghi queue lúc ${s.time}.`);
        return { success: sent === true, sent };
      } else if (id === 'weekly') {
        const prompt = buildWeeklyReportPrompt();
        const ok = await runCronAgentPrompt(prompt, { label: 'TEST — weekly-report' });
        return { success: ok, sent: ok };
      } else if (id === 'monthly') {
        const prompt = buildMonthlyReportPrompt();
        const ok = await runCronAgentPrompt(prompt, { label: 'TEST — monthly-report' });
        return { success: ok, sent: ok };
      } else if (id === 'zalo-followup') {
        const prompt = buildZaloFollowUpPrompt();
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
      // Match real cron behavior: run prompt through agent and deliver output
      const ok = await runCronAgentPrompt(c.prompt, { label: `TEST — ${c.label || c.id}` });
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
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      chatId: String(chatId),
      // Store a token hash (not the token itself) so we can verify the sticky
      // value belongs to the same bot if multiple bots are configured later.
      tokenFingerprint: fp,
      savedAt: new Date().toISOString(),
    }, null, 2), 'utf-8');
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
    try {
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
    return { token: sync.token, chatId: recovered, recovered: 'telegram-getUpdates' };
  }
  return sync;
}

async function sendTelegram(text) {
  const { token, chatId } = getTelegramConfig();
  if (!token || !chatId) {
    console.error('[sendTelegram] missing token or chatId');
    return null;
  }
  const https = require('https');
  return new Promise((resolve) => {
    const payload = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' });
    const req = https.request(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(d);
            if (parsed.ok) { resolve(true); }
            else { console.error('[sendTelegram] API error:', parsed.description); resolve(null); }
          } catch (e) { console.error('[sendTelegram] parse error:', e.message); resolve(null); }
        });
      }
    );
    req.on('error', (e) => { console.error('[sendTelegram] network error:', e.message); resolve(null); });
    req.write(payload);
    req.end();
  });
}

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
              resolve({
                ready: true,
                username: parsed.result.username,
                botName: parsed.result.first_name,
                botId: parsed.result.id,
                hasCeoChatId: !!chatId,
              });
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
      const out = require('child_process').execSync(
        `wmic process where "name='node.exe' and CommandLine like '%%openzca%%listen%%'" get ProcessId /format:csv 2>nul`,
        { encoding: 'utf-8', timeout: 3000 }
      );
      // CSV format: header row "Node,ProcessId" then "<hostname>,<pid>".
      // STRICT VALIDATION: skip header, require ≥2 cols, pid must be ≥100
      // (filter system PIDs 0-99 + reject malformed wmic output that could
      // otherwise return PID 0 or negative). Header row "ProcessId" string
      // parses to NaN so it's auto-skipped by Number.isFinite check.
      for (const line of out.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.toLowerCase().startsWith('node')) continue;
        const cols = trimmed.split(',');
        if (cols.length < 2) continue;
        const pidStr = cols[cols.length - 1].trim();
        const pid = parseInt(pidStr, 10);
        if (Number.isFinite(pid) && pid >= 100) return pid;
      }
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
    if (process.env.MODORO_DEBUG) console.error('[findOpenzcaListenerPid]', e.message);
  }
  return null;
}

async function probeZaloReady() {
  try {
    const ozDir = path.join(HOME, '.openzca', 'profiles', 'default');
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
      // Listener is not running. Check WHY and return the most actionable
      // error message. Credentials/expiry checks go HERE (fallback
      // diagnostics), not at the top — they previously caused false-positive
      // "expired" reports even when the process was happily maintaining the
      // WebSocket via keepalive.
      if (!fs.existsSync(credsFile)) {
        return {
          ready: false,
          reason: 'no-credentials',
          error: 'Chưa đăng nhập Zalo. Vào tab Zalo bấm "Đổi tài khoản" để quét QR.',
        };
      }
      // Parse cookie for expiry as a hint, but only if listener is NOT running.
      // If cookies are expired AND listener is down, user must re-login.
      // If cookies are expired BUT listener is up, we already returned ready above.
      try {
        const creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
        const cookies = Array.isArray(creds.cookie) ? creds.cookie : [];
        const sessionCookie = cookies.find(c => c && /zlogin_session|zpw_sek/.test(c.key || ''));
        if (sessionCookie) {
          const lastAccessedMs = Date.parse(sessionCookie.lastAccessed || sessionCookie.creation || 0);
          const maxAgeMs = (sessionCookie.maxAge || 0) * 1000;
          if (lastAccessedMs && maxAgeMs && (Date.now() - lastAccessedMs) > maxAgeMs) {
            const hoursAgo = Math.floor((Date.now() - lastAccessedMs) / 3600000);
            return {
              ready: false,
              reason: 'session-expired',
              error: `Phiên Zalo đã hết hạn (${hoursAgo} giờ trước) và listener không chạy. Vào tab Zalo bấm "Đổi tài khoản" để quét QR mới.`,
              cacheAgeMin,
            };
          }
        }
      } catch (e) {
        console.warn('[probeZaloReady] credentials parse error:', e.message);
      }
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
      return {
        ready: true,
        listenerPid,
        lastRefreshMinAgo: cacheAgeMin,
        warning: `Cookie cache ${cacheAgeMin} phút trước — sắp cần refresh.`,
      };
    }

    return {
      ready: true,
      listenerPid,
      lastRefreshMinAgo: cacheAgeMin,
    };
  } catch (e) {
    return { ready: false, error: 'Probe error: ' + e.message };
  }
}

ipcMain.handle('check-telegram-ready', async () => probeTelegramReady());
ipcMain.handle('check-zalo-ready', async () => probeZaloReady());

// Manual smoke test: send a real Telegram message to the CEO. The strongest
// possible proof — if this succeeds the channel is end-to-end working.
ipcMain.handle('telegram-self-test', async () => {
  const ok = await sendTelegram(
    '🧪 *Test kết nối*\n\nĐây là tin nhắn test từ Dashboard. Nếu anh thấy tin này, ' +
    'channel Telegram đã sẵn sàng nhận lệnh.'
  );
  return { success: ok === true };
});

// Periodic broadcast of channel readiness to the renderer so the sidebar dots
// stay fresh. Boot phase polls fast (every 3s for 30s) so the CEO sees the
// state flip from "checking" → "ready" as soon as the gateway brings the
// openzalo channel up (typically 10-15s after gateway start). After the boot
// window, fall back to 45s steady-state polling.
let _channelStatusInterval = null;
let _channelStatusBootTimers = [];
function startChannelStatusBroadcast() {
  if (_channelStatusInterval) clearInterval(_channelStatusInterval);
  for (const t of _channelStatusBootTimers) clearTimeout(t);
  _channelStatusBootTimers = [];

  const broadcast = async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const [tg, zl] = await Promise.all([probeTelegramReady(), probeZaloReady()]);
      mainWindow.webContents.send('channel-status', {
        telegram: tg,
        zalo: zl,
        checkedAt: new Date().toISOString(),
      });
    } catch (e) { console.error('[channel-status] broadcast error:', e.message); }
  };

  // Boot phase: fast polls so the openzalo listener spawn (~10-15s) is caught
  // quickly and the user doesn't sit on a stale "Chưa sẵn sàng" pill.
  const bootDelays = [500, 3000, 6000, 10000, 15000, 20000, 25000, 30000];
  for (const delay of bootDelays) {
    _channelStatusBootTimers.push(setTimeout(broadcast, delay));
  }
  // Steady-state polling
  _channelStatusInterval = setInterval(broadcast, 45 * 1000);
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
    // Default enabled=true when bot forgot it — CEO asked for a cron, he wants
    // it to run, don't require explicit enabled:true
    if (c.cronExpr && c.prompt && c.enabled === undefined) {
      c.enabled = true;
      healed = true;
    }
    // Auto-id so dedupe + journal works
    if (!c.id && c.cronExpr) {
      c.id = 'custom_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      healed = true;
    }
    // Auto-label from prompt if missing
    if (!c.label && c.prompt) {
      c.label = String(c.prompt).trim().split('\n')[0].slice(0, 60);
      healed = true;
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
  try {
    if (fs.existsSync(customCronsPath)) {
      const raw = fs.readFileSync(customCronsPath, 'utf-8');
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
          throw new Error('custom-crons.json must be an array, got ' + typeof parsed);
        }
        const wasHealed = healCustomCronEntries(parsed);
        if (wasHealed) {
          try {
            fs.writeFileSync(customCronsPath, JSON.stringify(parsed, null, 2), 'utf-8');
            console.log('[custom-crons] healed entries (alias/defaults) and rewrote file');
          } catch (e) { console.warn('[custom-crons] heal-writeback failed:', e.message); }
        }
        return parsed;
      } catch (parseErr) {
        // CRITICAL: do NOT silently return [] on corrupt file. Backup the bad
        // file, log loudly, and try to alert the CEO. Returning [] would
        // silently drop ALL the user's custom crons.
        const backupPath = customCronsPath + '.corrupt-' + Date.now();
        try { fs.copyFileSync(customCronsPath, backupPath); } catch {}
        console.error(`[custom-crons] CORRUPT JSON in ${customCronsPath}: ${parseErr.message}. Backed up to ${backupPath}`);
        try {
          const errFile = path.join(getWorkspace(), '.learnings', 'ERRORS.md');
          fs.mkdirSync(path.dirname(errFile), { recursive: true });
          fs.appendFileSync(errFile, `\n## ${new Date().toISOString()} — custom-crons.json corrupt\n\nError: ${parseErr.message}\nBackup: ${backupPath}\nAll custom crons disabled until fixed. Restore from backup or recreate via Dashboard.\n`, 'utf-8');
        } catch {}
        try {
          // Best-effort Telegram alert (sendTelegram is sync-callable)
          sendTelegram(`🚨 *custom-crons.json bị lỗi JSON*\n\n\`${parseErr.message}\`\n\nFile gốc đã backup về: \`${path.basename(backupPath)}\`. Tất cả custom cron sẽ KHÔNG chạy cho tới khi sửa file. Vào Dashboard → Cron để recreate hoặc khôi phục từ backup.`);
        } catch {}
        return [];
      }
    }
    // One-time migration from legacy paths
    for (const p of legacyCustomCronsPaths) {
      if (p !== customCronsPath && fs.existsSync(p)) {
        try {
          const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
          try {
            fs.mkdirSync(path.dirname(customCronsPath), { recursive: true });
            fs.writeFileSync(customCronsPath, JSON.stringify(data, null, 2), 'utf-8');
            console.log('[custom-crons] Migrated:', p, '→', customCronsPath);
          } catch {}
          return data;
        } catch (e) {
          console.error(`[custom-crons] legacy file ${p} is corrupt:`, e.message);
        }
      }
    }
  } catch (e) {
    console.error('[custom-crons] load error:', e.message);
  }
  return [];
}

// Watch custom-crons.json + schedules.json for changes — auto-reload when bot edits them
let customCronWatcher = null;
let schedulesWatcher = null;
let _watchPollerInterval = null;
let _lastCustomCronsMtime = 0;
let _lastSchedulesMtime = 0;
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
    if (!fs.existsSync(customCronsPath)) fs.writeFileSync(customCronsPath, '[]', 'utf-8');
    if (!fs.existsSync(schedulesPath)) fs.writeFileSync(schedulesPath, JSON.stringify(loadSchedules(), null, 2), 'utf-8');

    // Snapshot current mtimes so we don't trigger a spurious reload on first poll.
    try { _lastCustomCronsMtime = fs.statSync(customCronsPath).mtimeMs; } catch {}
    try { _lastSchedulesMtime = fs.statSync(schedulesPath).mtimeMs; } catch {}

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
            if (c && c.id && c.enabled !== false && c.cronExpr && c.prompt && !prevIds.has(c.id)) {
              added.push(c);
            }
          }
          global._knownCronIds = currIds;
          for (const c of added) {
            const validExpr = typeof cron.validate === 'function' ? cron.validate(c.cronExpr) : true;
            if (!validExpr) continue; // surfaceCronConfigError already alerted
            const label = c.label || c.id;
            const msg = `*Cron mới đã được lên lịch*\n\n` +
                        `Nhãn: \`${label}\`\n` +
                        `Lịch: \`${c.cronExpr}\` (giờ VN)\n` +
                        `Prompt: ${String(c.prompt).slice(0, 200)}${c.prompt.length > 200 ? '...' : ''}\n\n` +
                        `Đây là xác nhận từ hệ thống — nếu bạn không yêu cầu cron này, vào Dashboard → Cron để xóa.`;
            sendTelegram(msg).catch(() => {});
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
    }, 2000);
    _watchPollerInterval.unref?.();
  } catch (e) { console.error('[cron] watch error:', e.message); }
}

function startCronJobs() {
  stopCronJobs();
  // Kick off the openclaw-agent CLI self-test (non-blocking). Sets _agentFlagProfile
  // / _agentCliHealthy so that when a cron fires it already knows which flags to use.
  // Re-runs are no-ops because _selfTestPromise is cached for the process lifetime.
  selfTestOpenClawAgent().catch((e) => console.error('[cron-agent self-test] threw:', e?.message || e));
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
            await runCronAgentPrompt(prompt, { label: 'morning-briefing' });
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
            await runCronAgentPrompt(prompt, { label: 'evening-summary' });
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
            // Require 2 CONSECUTIVE failures (with a 5s gap) before restart.
            // A single timeout often means the gateway was busy serving an AI
            // request, not dead. Killing it mid-completion creates a real
            // restart loop because the next heartbeat finds another in-flight
            // request and false-positives again.
            const alive1 = await isGatewayAlive(8000);
            if (alive1) return;
            await new Promise(r => setTimeout(r, 5000));
            const alive2 = await isGatewayAlive(8000);
            if (alive2) {
              console.log('[heartbeat] gateway slow but alive — skipping restart');
              return;
            }
            console.log('[heartbeat] Gateway not responding (2 consecutive failures) — auto-restarting');
            // Silent auto-restart (no CEO-facing error per L-002 rule)
            try { stopOpenClaw(); } catch {}
            await new Promise(r => setTimeout(r, 2000));
            try { await startOpenClaw(); } catch (e) {
              console.error('[heartbeat] restart failed:', e.message);
            }
          } catch (e) { console.error('[heartbeat] error:', e.message); }
        };
        break;
      }
      case 'meditation': {
        cronExpr = '0 1 * * *';
        handler = async () => {
          console.log('[cron] Meditation triggered at', new Date().toISOString());
          // Silent — writes to memory/meditation-queue.md which bot reads on next session
          try {
            const ws = getWorkspace();
            const queueFile = path.join(ws, 'memory', 'meditation-queue.md');
            fs.mkdirSync(path.dirname(queueFile), { recursive: true });
            const stamp = new Date().toISOString();
            fs.appendFileSync(queueFile, `\n## Pending meditation ${stamp}\n\nRun night reflection: read .learnings/LEARNINGS.md, review patterns, promote repeating ones to AGENTS.md.\n`, 'utf-8');
          } catch (e) { console.error('[cron] meditation queue write error:', e.message); }
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
            const prompt = buildWeeklyReportPrompt();
            await runCronAgentPrompt(prompt, { label: 'weekly-report' });
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
            await runCronAgentPrompt(prompt, { label: 'monthly-report' });
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
            const prompt = buildZaloFollowUpPrompt();
            await runCronAgentPrompt(prompt, { label: 'zalo-followup' });
            try { auditLog('cron_fired', { id: 'zalo-followup', label: 'Follow-up khách Zalo' }); } catch {}
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

  // --- Custom crons (created by bot via CEO request, permanent) ---
  const customs = loadCustomCrons();
  // Per-cron in-flight guard so a slow agent run doesn't get a duplicate fire
  // started before the previous one finishes. Map<cronId, true>.
  if (!global._cronInFlight) global._cronInFlight = new Map();
  for (const c of customs) {
    if (!c) continue;
    if (!c.enabled) continue;
    // D3: warn loudly on misconfigured custom cron instead of silently skipping
    if (!c.cronExpr) {
      console.warn(`[cron] custom cron ${c.id || '(no id)'} skipped — missing cronExpr`);
      surfaceCronConfigError(c, 'missing cronExpr field');
      continue;
    }
    if (!c.prompt || !c.prompt.trim()) {
      console.warn(`[cron] custom cron ${c.id || '(no id)'} skipped — empty prompt`);
      surfaceCronConfigError(c, 'empty prompt field');
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
          // D1: defense-in-depth — runCronAgentPrompt has internal try/catch, but
          // wrap here too so an unexpected throw doesn't crash node-cron's task.
          const ok = await runCronAgentPrompt(c.prompt, { label: c.label || c.id });
          console.log(`[cron] Custom ${c.id} agent run result:`, ok);
          try { auditLog('cron_fired', { id: c.id, label: c.label || c.id, kind: 'custom' }); } catch {}
        } catch (e) {
          console.error(`[cron] Custom ${c.id} handler threw (suppressed):`, e?.message || e);
          journalCronRun({ phase: 'fail', label: c.label || c.id, reason: 'handler-threw', err: String(e?.message || e).slice(0, 300) });
          try { auditLog('cron_failed', { id: c.id, label: c.label || c.id, kind: 'custom', error: String(e?.message || e).slice(0, 200) }); } catch {}
          try { await sendTelegram(`*Cron "${c.label || c.id}" lỗi nội bộ*\n\n\`${String(e?.message || e).slice(0, 300)}\``); } catch {}
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

// D6 helper: write cron config errors to ERRORS.md and (best-effort) Telegram.
// Caller passes the offending cron config + a human-readable reason.
function surfaceCronConfigError(c, reason) {
  try {
    const errFile = path.join(getWorkspace(), '.learnings', 'ERRORS.md');
    fs.mkdirSync(path.dirname(errFile), { recursive: true });
    fs.appendFileSync(errFile, `\n## ${new Date().toISOString()} — custom-cron config error\n\nCron: \`${c?.label || c?.id || '?'}\` (id: \`${c?.id || '?'}\`)\nReason: ${reason}\nExpr: \`${c?.cronExpr || '?'}\`\nPrompt (first 100 chars): ${(c?.prompt || '').slice(0, 100)}\n`, 'utf-8');
  } catch (e) { console.error('[surfaceCronConfigError] write error:', e.message); }
  try {
    sendTelegram(`*Cron "${c?.label || c?.id || '?'}" cấu hình sai*\n\n${reason}\n\nCron sẽ KHÔNG chạy cho tới khi sửa. Vào Dashboard → Cron để fix.`);
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

// Cached one-shot warning so we don't spam the console with the same ABI error
// every time getDocumentsDb() is called from a list/upload handler.
let _documentsDbErrorLogged = false;
let _documentsDbAutoFixAttempted = false;

// Self-heal better-sqlite3 ABI mismatch by re-running the postinstall script
// (which calls prebuild-install for the bundled Electron version). Synchronous
// because getDocumentsDb is synchronous and called from many call sites — we
// cannot await here. Returns true if a fix was attempted.
function autoFixBetterSqlite3() {
  if (_documentsDbAutoFixAttempted) return false;
  _documentsDbAutoFixAttempted = true;
  try {
    const fixScript = path.join(__dirname, 'scripts', 'fix-better-sqlite3.js');
    if (!fs.existsSync(fixScript)) return false;
    console.log('[documents] auto-fixing better-sqlite3 ABI mismatch via', fixScript);
    require('child_process').execFileSync('node', [fixScript], {
      cwd: __dirname,
      timeout: 120000,
      stdio: 'inherit',
    });
    // After the fix script runs, the require cache still has the broken module.
    // Clear it so the next require() picks up the new binary.
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
    // Create documents table if not exists (category added for Knowledge tab)
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
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        filename, content, tokenize='unicode61'
      );
    `);
    // Migration: add columns if missing on older DB
    try { db.exec(`ALTER TABLE documents ADD COLUMN category TEXT DEFAULT 'general'`); } catch {}
    try { db.exec(`ALTER TABLE documents ADD COLUMN summary TEXT`); } catch {}
    return db;
  } catch (e) {
    // ABI mismatch → try to self-heal once. If the fix script succeeds, the
    // next call to getDocumentsDb() will succeed (we don't recurse here to keep
    // semantics simple — Knowledge tab uses the disk-fallback for the current
    // call and the DB starts working on the next IPC).
    if (/NODE_MODULE_VERSION/.test(e.message) && !_documentsDbAutoFixAttempted) {
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
              created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
              filename, content, tokenize='unicode61'
            );
          `);
          try { db.exec(`ALTER TABLE documents ADD COLUMN category TEXT DEFAULT 'general'`); } catch {}
          try { db.exec(`ALTER TABLE documents ADD COLUMN summary TEXT`); } catch {}
          console.log('[documents] DB now working after auto-fix');
          return db;
        } catch (e2) {
          console.error('[documents] DB still broken after auto-fix:', e2.message);
        }
      }
    }
    if (!_documentsDbErrorLogged) {
      console.error('[documents] DB error:', e.message);
      if (/NODE_MODULE_VERSION/.test(e.message)) {
        console.error('[documents] better-sqlite3 ABI mismatch persists — using disk-only fallback for Knowledge tab.');
        console.error('[documents] Manual fix: cd electron && rm -rf node_modules/better-sqlite3/build && npm install');
      }
      _documentsDbErrorLogged = true;
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
      const wordCount = content ? content.split(/\s+/).length : 0;
      // Skip slow LLM summary on backfill — leave summary null. CEO can re-upload
      // to trigger AI summary, or bot can summarize on demand later.
      try {
        db.prepare(
          'INSERT INTO documents (filename, filepath, content, filetype, filesize, word_count, category, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(entry.name, fp, content, filetype, stat.size, wordCount, cat, null);
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

// AI summarize via 9Router (fallback to filename + first 200 chars)
async function summarizeKnowledgeContent(content, filename) {
  const fallback = () => {
    const stripped = (content || '').replace(/\s+/g, ' ').trim();
    return stripped.substring(0, 200) || `(không đọc được nội dung ${filename})`;
  };
  if (!content || content.length < 30) return fallback();
  try {
    const config = JSON.parse(fs.readFileSync(path.join(HOME, '.openclaw', 'openclaw.json'), 'utf-8'));
    const provider = config?.models?.providers?.ninerouter;
    if (!provider?.baseUrl || !provider?.apiKey) return fallback();
    // Resolve model name dynamically — NEVER hardcode 'main' or any provider id.
    // Whatever combo CEO sets up in 9router (Ollama, Anthropic, Groq, OpenAI, ...)
    // works without code changes. Resolution order:
    //   1. agents.defaults.model from openclaw.json (set by wizard, e.g. 'ninerouter/auto')
    //      → strip 'ninerouter/' prefix
    //   2. First model id in models.providers.ninerouter.models[] (also set by wizard)
    //   3. Literal 'auto' — 9router treats this as "use first available combo"
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
    const truncated = content.length > 4000 ? content.substring(0, 4000) + '...' : content;
    const body = JSON.stringify({
      model: modelName,
      messages: [{
        role: 'user',
        content: `Tóm tắt file "${filename}" trong 1-2 câu tiếng Việt ngắn gọn (tối đa 200 ký tự). Chỉ trả về tóm tắt, không thêm giải thích.\n\n---\n${truncated}`,
      }],
      max_tokens: 120,
      temperature: 0.3,
    });
    const url = new URL(provider.baseUrl + '/chat/completions');
    return await new Promise((resolve) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        timeout: 15000,
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
            if (text) resolve(text.substring(0, 300));
            else resolve(fallback());
          } catch { resolve(fallback()); }
        });
      });
      req.on('error', () => resolve(fallback()));
      req.on('timeout', () => { req.destroy(); resolve(fallback()); });
      req.write(body);
      req.end();
    });
  } catch { return fallback(); }
}

function rewriteKnowledgeIndex(category) {
  const ws = getWorkspace();
  const indexFile = path.join(ws, 'knowledge', category, 'index.md');
  let rows = [];
  const db = getDocumentsDb();
  if (db) {
    try {
      rows = db.prepare(
        'SELECT filename, summary, filesize, created_at FROM documents WHERE category = ? ORDER BY created_at DESC'
      ).all(category);
    } catch (e) { console.error('[knowledge] rewrite index db query:', e.message); }
    try { db.close(); } catch {}
  }
  // Merge in disk-only files so the bot's bootstrap reading of index.md sees
  // everything that physically exists, not just DB rows. Keeps Knowledge tab
  // useful even when better-sqlite3 is broken.
  const dbNames = new Set(rows.map(r => r.filename));
  for (const f of listKnowledgeFilesFromDisk(category)) {
    if (!dbNames.has(f.filename)) {
      rows.push({ filename: f.filename, summary: null, filesize: f.filesize, created_at: f.created_at });
    }
  }
  try {
    let md = `# Knowledge — ${KNOWLEDGE_LABELS[category]}\n\n`;
    if (rows.length === 0) {
      md += '*Chưa có tài liệu nào. CEO upload file qua Dashboard → Knowledge.*\n';
    } else {
      md += `Tổng: ${rows.length} tài liệu.\n\n`;
      for (const r of rows) {
        md += `## ${r.filename}\n`;
        md += `*Uploaded: ${r.created_at} · ${((r.filesize || 0) / 1024).toFixed(1)} KB*\n\n`;
        md += `${r.summary || '(không có tóm tắt)'}\n\n`;
        md += `---\n\n`;
      }
    }
    fs.writeFileSync(indexFile, md, 'utf-8');
  } catch (e) { console.error('[knowledge] rewrite index write:', e.message); }
}

ipcMain.handle('upload-knowledge-file', async (_event, { category, filepath, originalName }) => {
  try {
    if (!KNOWLEDGE_CATEGORIES.includes(category)) {
      return { success: false, error: 'Loại không hợp lệ' };
    }
    if (!fs.existsSync(filepath)) return { success: false, error: 'File không tồn tại' };
    const stat = fs.statSync(filepath);
    if (stat.size > 20 * 1024 * 1024) return { success: false, error: 'File quá lớn (max 20MB)' };

    ensureKnowledgeFolders();
    const filesDir = path.join(getKnowledgeDir(category), 'files');
    const safeName = (originalName || path.basename(filepath)).replace(/[\\/:*?"<>|]/g, '_');
    const finalName = resolveUniqueFilename(filesDir, safeName);
    const dst = path.join(filesDir, finalName);
    fs.copyFileSync(filepath, dst);

    const content = await extractTextFromFile(dst, finalName);
    const wordCount = content ? content.split(/\s+/).length : 0;
    const filetype = path.extname(finalName).toLowerCase().replace('.', '');
    const summary = await summarizeKnowledgeContent(content, finalName);

    let dbWarning = null;
    const db = getDocumentsDb();
    if (db) {
      try {
        const insertBoth = db.transaction(() => {
          db.prepare(
            'INSERT INTO documents (filename, filepath, content, filetype, filesize, word_count, category, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).run(finalName, dst, content, filetype, stat.size, wordCount, category, summary);
          db.prepare('INSERT INTO documents_fts (filename, content) VALUES (?, ?)').run(finalName, content);
        });
        insertBoth();
      } catch (e) {
        console.error('[knowledge] db insert error:', e.message);
        dbWarning = 'DB insert failed (file vẫn lưu trên disk): ' + e.message;
      }
      try { db.close(); } catch {}
    } else {
      dbWarning = 'DB không mở được — file đã lưu trên disk, sẽ index lại sau khi sửa DB.';
    }

    rewriteKnowledgeIndex(category);
    return { success: true, filename: finalName, summary, wordCount, dbWarning };
  } catch (e) {
    console.error('[knowledge] upload error:', e.message);
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
        'SELECT filename, filetype, filesize, word_count, summary, created_at FROM documents WHERE category = ? ORDER BY created_at DESC'
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
      db.prepare('DELETE FROM documents WHERE category = ? AND filename = ?').run(category, filename);
      db.prepare('DELETE FROM documents_fts WHERE filename = ?').run(filename);
      db.close();
    }
    const fp = path.join(getKnowledgeDir(category), 'files', filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    rewriteKnowledgeIndex(category);
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

// List all knowledge folders with labels
ipcMain.handle('list-knowledge-folders', async () => {
  const cats = getKnowledgeCategories();
  return cats.map(cat => ({
    id: cat,
    label: KNOWLEDGE_LABELS[cat] || cat.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    isDefault: DEFAULT_KNOWLEDGE_CATEGORIES.includes(cat),
  }));
});

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

  // Images: store path, AI vision will read later
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) {
    return `[Ảnh: ${filename} — Bot sẽ dùng AI vision để đọc khi cần]`;
  }

  return `[Không hỗ trợ extract text cho file ${ext}]`;
}

ipcMain.handle('index-document', async (_event, { filepath, filename }) => {
  try {
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
        db.prepare('INSERT INTO documents (filename, filepath, content, filetype, filesize, word_count) VALUES (?, ?, ?, ?, ?, ?)')
          .run(filename, dst, content, filetype, filesize, wordCount);
        db.prepare('INSERT INTO documents_fts (filename, content) VALUES (?, ?)')
          .run(filename, content);
      });
      insertBoth();
      db.close();
    }

    return { success: true, filename, wordCount, filesize };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('search-documents', async (_event, query) => {
  try {
    const db = getDocumentsDb();
    if (!db) return [];
    const results = db.prepare(`
      SELECT d.filename, d.filetype, d.word_count, d.created_at,
             snippet(documents_fts, 1, '**', '**', '...', 32) as snippet
      FROM documents_fts f
      JOIN documents d ON d.filename = f.filename
      WHERE documents_fts MATCH ?
      ORDER BY rank
      LIMIT 10
    `).all(query);
    db.close();
    return results;
  } catch (e) { return []; }
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
      chat_id: chatId, text: '🦞 MODOROClaw — Kết nối thành công!', parse_mode: 'Markdown',
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
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.openclaw', 'openclaw.json'), 'utf-8'));
    if (cfg.channels?.telegram?.botToken) r.telegram = botRunning ? 'ok' : 'configured';
  } catch {}

  // 3. Zalo — check credentials file
  try {
    if (fs.existsSync(path.join(HOME, '.openzca', 'profiles', 'default', 'credentials.json'))) {
      r.zalo = botRunning ? 'ok' : 'configured';
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
    raw = raw.replace(/^(em|tôi|mình)[\s—-]*gọi chủ nhân là\s+/i, '');
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

// Compute the next firing time for a schedule item with `time: "HH:MM"` or
// `time: "Mỗi N phút"`. Returns ISO timestamp or null.
function _nextFireTime(timeStr, now = new Date()) {
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
            // Custom crons store either `time` (HH:MM or "Mỗi N phút") or
            // `cronExpr` (raw cron). Display friendly time when possible.
            const next = _nextFireTime(c.time, now);
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

    // 4b. Zalo cookie age — warn if > 14 days since last refresh
    try {
      const credFile = path.join(HOME, '.openzca', 'profiles', 'default', 'credentials.json');
      if (fs.existsSync(credFile)) {
        const ageMs = Date.now() - fs.statSync(credFile).mtimeMs;
        const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
        if (ageDays > 14) {
          actions.push({
            severity: ageDays > 25 ? 'high' : 'medium',
            text: `Cookie Zalo đã ${ageDays} ngày — sắp hết hạn`,
            cta: 'Quét QR mới',
            ctaPage: 'zalo',
            kind: 'cookie-stale',
          });
        }
      } else {
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
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
  // Fresh install: seed workspace files with defaults + cleanup any stale listener
  try { seedWorkspace(); } catch (e) { console.error('[wizard-complete seed] error:', e.message); }
  try { cleanupOrphanZaloListener(); } catch {}
  mainWindow.loadFile(path.join(__dirname, 'ui', 'dashboard.html'));
  mainWindow.maximize();
  // ORDER MATTERS — three hard dependencies:
  //   1. ensureZaloPlugin() — copies bundled openzalo plugin from vendor (Mac
  //      .dmg) OR installs from npm (dev mode). MUST finish before gateway
  //      starts, otherwise gateway won't register the openzalo channel and
  //      Zalo stays silently broken. Awaited here to eliminate the race with
  //      the parallel call from app.whenReady (which is fire-and-forget).
  //      _zaloReady flag makes this idempotent.
  //   2. startOpenClaw() runs ensureDefaultConfig() which heals the
  //      openclaw.json schema (deletes deprecated keys, creates
  //      channels.openzalo section, etc.).
  //   3. Cron jobs scheduled AFTER — otherwise the first cron handler can
  //      spawn `openclaw agent` against an unhealed config and fail with
  //      "Config invalid".
  try { await ensureZaloPlugin(); } catch (e) { console.error('[wizard-complete ensureZaloPlugin] error:', e?.message || e); }
  try { await startOpenClaw(); } catch (e) { console.error('[wizard-complete startOpenClaw] error:', e?.message || e); }
  startCronJobs();
  watchCustomCrons();
  startZaloCacheAutoRefresh();
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
        ? 'Khong tim thay Node.js tren may.\n\nCai Node 22 LTS tu https://nodejs.org\n(hoac: brew install node@22)\n\nSau do mo lai MODOROClaw.'
        : 'Khong tim thay Node.js tren may.\n\nCai Node 22 LTS tu https://nodejs.org\n\nSau do mo lai MODOROClaw.',
    };
  }
  if (nodeVersionMajor < 22) {
    return {
      success: false,
      error: `Node.js qua cu (v${nodeVersionMajor}). MODOROClaw can Node 22+ de chay openzca (Zalo plugin).\n\n` +
             (isMac
               ? 'Cap nhat:\n  brew upgrade node\nhoac tai installer tu https://nodejs.org'
               : 'Cap nhat tu https://nodejs.org'),
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
        send(`⚠️  npm global prefix khong ghi duoc: ${npmPrefix}`);
        send('');
        send('Khac phuc: thiet lap user-prefix cho npm:');
        send('  mkdir -p ~/.npm-global');
        send('  npm config set prefix ~/.npm-global');
        send('  echo \'export PATH=~/.npm-global/bin:$PATH\' >> ~/.zshrc');
        send('  source ~/.zshrc');
        send('');
        send('Sau do thu lai. (Tranh dung sudo cho npm install -g.)');
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
    // To upgrade pinned versions: edit MODORO_PINNED_VERSIONS table below,
    // smoke-test, then ship a new build. Single source of truth is also in
    // electron/scripts/prebuild-vendor.js — keep both in sync (and PINNING.md).
    const MODORO_PINNED_VERSIONS = [
      'openclaw@2026.4.5',
      '9router@0.3.82',
      'openzca@0.1.57',
    ];
    let cmd, args;
    if (isWin) {
      cmd = 'npm.cmd';
      args = ['install', '-g', '--save-exact', ...MODORO_PINNED_VERSIONS];
    } else {
      cmd = 'npm';
      args = ['install', '-g', '--save-exact', ...MODORO_PINNED_VERSIONS];
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
      send('❌ Quá thời gian (10 phút).');
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
          send('⚠️ Installer chạy xong nhưng không tìm thấy openclaw.');
          send('Thử khởi động lại app.');
          safeResolve({ success: false, error: 'Cài xong nhưng không tìm thấy openclaw. Khởi động lại app.' });
        } else {
          send('');
          send('❌ Cài đặt thất bại.');
          safeResolve({ success: false, error: `Mã lỗi: ${code}\n\n${output.slice(-1000)}` });
        }
      }, 2000);
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      send('');
      send('❌ Không chạy được: ' + err.message);
      safeResolve({ success: false, error: err.message });
    });
  });
});

// Relaunch app after OpenClaw install
ipcMain.handle('relaunch', async () => {
  app.relaunch();
  app.exit(0);
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
    const allowedOrigins = ['https://ollama.com', 'http://localhost:20128', 'http://127.0.0.1:20128', 'http://127.0.0.1:18789', 'http://localhost:18789', 'http://127.0.0.1:18791', 'http://localhost:18791'];
    if (allowedOrigins.includes(parsed.origin)) {
      const { shell } = require('electron');
      shell.openExternal(url);
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

ipcMain.handle('toggle-bot', async () => {
  if (botRunning) stopOpenClaw(); else startOpenClaw();
  await new Promise((r) => setTimeout(r, 500));
  return { running: botRunning };
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
    sendError('Lỗi: ' + (e.message || 'không rõ nguyên nhân') + '. Vui lòng cài lại MODOROClaw.');
    // Keep splash open 5s so user can read the error, then quit
    await new Promise(r => setTimeout(r, 5000));
    try { splashWindow.close(); } catch {}
    const { dialog } = require('electron');
    dialog.showErrorBox('Lỗi khởi tạo MODOROClaw', 'Không thể giải nén thành phần cần thiết:\n\n' + (e.message || '?') + '\n\nVui lòng gỡ cài đặt và cài lại MODOROClaw.');
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
  // Security Layer 5: enforce log rotation + memory retention policies.
  // Non-blocking, runs once at boot.
  try { enforceRetentionPolicies(); } catch (e) { console.warn('[retention] boot call failed:', e?.message); }
  // Security Layer 1 (scoped): chmod 600 sensitive files (Unix only).
  // Non-blocking, runs once at boot.
  try { hardenSensitiveFilePerms(); } catch (e) { console.warn('[file-harden] boot call failed:', e?.message); }
  // Security audit: record the boot event itself
  try { auditLog('app_boot', { platform: process.platform, node: process.versions.node, electron: process.versions.electron }); } catch {}
  // Start the real-readiness probe broadcast so sidebar dots stay accurate
  startChannelStatusBroadcast();
}).catch(console.error);

app.on('window-all-closed', () => {});
app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
});
app.on('before-quit', () => {
  app.isQuitting = true;
  stopOpenClaw();
  // Cleanup Zalo listener tree so next startup is clean (no orphans)
  try { cleanupOrphanZaloListener(); } catch {}
  // Stop 9Router too
  try { stop9Router(); } catch {}
});
