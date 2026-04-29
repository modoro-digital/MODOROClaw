'use strict';
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFilePromise = promisify(execFile);
const ctx = require('./context');
const { getWorkspace } = require('./workspace');

let app, BrowserWindow;
try { ({ app, BrowserWindow } = require('electron')); } catch {}

// Private state
let _cachedBin = null;
let _cachedNodeBin = null;
let _cachedOpenClawCliJs = null;
let _bootDiagState = { ts: null, lines: [] };
let splashWindow = null;

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
          path.join(targetDir, 'node_modules', 'modoro-zalo', 'openclaw.plugin.json'),
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
        try { execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${vendorAbs.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`, { timeout: 8000 }); } catch {}
        // Also kill by known process names that commonly lock vendor files
        try { execSync('taskkill /F /IM 9router.exe 2>nul', { timeout: 3000 }); } catch {}
        try { execSync('taskkill /F /IM openzca.exe 2>nul', { timeout: 3000 }); } catch {}
        // Give OS a moment to release file handles after kill
        await new Promise(r => setTimeout(r, 2000));
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
          await new Promise(r => setTimeout(r, 3000));
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
  if (meta.sha256) {
    if (onProgress) onProgress({ percent: 1, message: 'Đang kiểm tra tính toàn vẹn...' });
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
              if (onProgress) onProgress({ percent: pct, message: 'Đang kiểm tra tính toàn vẹn...' });
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
  // (openclaw, openzca, 9router). Without the second dir, the modoro-zalo
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

// Cross-platform helpers

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
  const home = ctx.HOME;

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
function initPathAugmentation() {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    const extra = enumerateNodeManagerBinDirs();
    process.env.PATH = extra.join(':') + ':' + (process.env.PATH || '');
  }
  // Packaged Mac .app: prepend bundled vendor/node/bin so child processes
  // (openclaw plugins, 9router) find a real `node` binary even on a Mac
  // with zero Node installed.
  try { augmentPathWithBundledNode(); } catch {}
}

function appDataDir() {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(ctx.HOME, 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(ctx.HOME, 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(ctx.HOME, '.config');
}

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
  candidates.push(path.join(ctx.HOME, '.openclaw', 'bin', isWin ? 'openclaw.exe' : 'openclaw'));
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
  candidates.push(path.join(ctx.HOME, '.openclaw', 'bin', isWin ? 'openclaw.exe' : 'openclaw'));

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
  const home = ctx.HOME;
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
async function spawnOpenClawSafe(args, { timeoutMs = 600000, cwd, allowCmdShellFallback = true } = {}) {
  const cliJs = findOpenClawCliJs();
  const nodeBin = findNodeBin();
  let cmd, spawnArgs, useShell, viaCmdShell = false;
  if (cliJs && nodeBin) {
    cmd = nodeBin;
    spawnArgs = [cliJs, ...args];
    useShell = false;
  } else {
    if (!allowCmdShellFallback) {
      const why = !nodeBin ? 'node binary not found on this system' : 'openclaw.mjs not found';
      console.error(`[spawnOpenClawSafe] refusing cmd-shell fallback (caller forbade it): ${why}`);
      return { code: -1, stdout: '', stderr: `cmd-shell fallback refused: ${why}`, viaCmdShell: false };
    }
    const bin = await findOpenClawBin();
    if (!bin) return { code: -1, stdout: '', stderr: 'openclaw not found', viaCmdShell: false };
    cmd = bin;
    spawnArgs = args;
    useShell = process.platform === 'win32' && bin.endsWith('.cmd');
    viaCmdShell = useShell;
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
    return { code: -1, stdout: '', stderr: String(e?.message || e), viaCmdShell };
  }
  return new Promise((resolve) => {
    const killer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000).unref();
    }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += String(c); });
    child.stderr.on('data', (c) => { stderr += String(c); });
    child.on('error', (e) => { clearTimeout(killer); resolve({ code: -1, stdout, stderr: stderr + String(e?.message || e), viaCmdShell }); });
    child.on('close', (code, signal) => { clearTimeout(killer); resolve({ code: code !== null ? code : (signal ? -9 : -1), stdout, stderr, viaCmdShell }); });
  });
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
  bootDiagLog(`HOME=${ctx.HOME}`);
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
    // Inline require to break circular dep: channels.js → boot.js (top-level)
    const { getTelegramConfig } = require('./channels');
    const cfg = getTelegramConfig ? getTelegramConfig() : {};
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
    const cfgPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
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
        userDataRoots.push(path.join(ctx.HOME, 'Library', 'Application Support', '9bizclaw'));
        userDataRoots.push(path.join(ctx.HOME, 'Library', 'Application Support', 'modoro-claw'));
      } else if (process.platform === 'win32') {
        const appdata = process.env.APPDATA || path.join(ctx.HOME, 'AppData', 'Roaming');
        userDataRoots.push(path.join(appdata, '9bizclaw'));
        userDataRoots.push(path.join(appdata, 'modoro-claw'));
      } else {
        userDataRoots.push(path.join(ctx.HOME, '.config', '9bizclaw'));
        userDataRoots.push(path.join(ctx.HOME, '.config', 'modoro-claw'));
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

// Windows packaged: show a splash window and extract vendor-bundle.tar → userData/vendor
// on first launch (or after update). Returns when extraction is done OR immediately
// on Mac / dev / already-extracted cases.
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
      preload: path.join(__dirname, '..', 'splash-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  splashWindow.setMenuBarVisibility(false);
  await splashWindow.loadFile(path.join(__dirname, '..', 'ui', 'splash.html'));
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

// =====================================================================
//  CLI SHIMS — make `openclaw` work from cmd.exe after install
// =====================================================================
// Windows packaged only. Creates .cmd shim files in userData/cli/ that
// forward to the bundled node + openclaw.mjs. Adds that directory to the
// user PATH (registry, not session) so new cmd windows can run `openclaw`
// exactly like a global npm install.
//
// Idempotent: safe to call every boot. Overwrites shims (in case paths
// changed after update) but only touches PATH if our dir isn't there yet.
function ensureCliShims() {
  if (process.platform !== 'win32') return;
  if (!app || !app.isPackaged) return;

  const vendorDir = getBundledVendorDir();
  if (!vendorDir) return;

  const userData = app.getPath('userData');
  const cliDir = path.join(userData, 'cli');
  try { fs.mkdirSync(cliDir, { recursive: true }); } catch {}

  const shimTemplate = (mjs) => [
    '@echo off',
    'setlocal',
    'set "VENDOR=%APPDATA%\\9bizclaw\\vendor"',
    'if not exist "%VENDOR%\\node\\node.exe" (',
    '  echo [9BizClaw] Vui long mo app 9BizClaw mot lan de giai nen truoc khi dung CLI.',
    '  exit /b 1',
    ')',
    '"%VENDOR%\\node\\node.exe" "%VENDOR%\\node_modules\\' + mjs + '" %*',
  ].join('\r\n') + '\r\n';

  const shims = [
    ['openclaw.cmd', 'openclaw\\openclaw.mjs'],
    ['openzca.cmd',  'openzca\\dist\\cli.js'],
  ];
  for (const [name, mjs] of shims) {
    try {
      fs.writeFileSync(path.join(cliDir, name), shimTemplate(mjs));
    } catch (e) {
      console.warn('[cli-shims] failed to write ' + name + ':', e?.message);
    }
  }

  // Add cliDir to user PATH via PowerShell -EncodedCommand.
  // MUST use EncodedCommand (base64 UTF-16LE) to bypass cmd.exe expansion:
  // if user PATH contains %JAVA_HOME%\bin, plain -Command would expand it
  // and permanently replace the reference with the resolved value.
  try {
    const { execSync } = require('child_process');
    const readScript = "$p = [Environment]::GetEnvironmentVariable('PATH','User'); Write-Output $p";
    const readB64 = Buffer.from(readScript, 'utf16le').toString('base64');
    const current = execSync(
      'powershell -NoProfile -EncodedCommand ' + readB64,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 8000 }
    ).trim();
    if (current.toLowerCase().includes(cliDir.toLowerCase())) {
      return; // already registered
    }
    const newPath = current ? (current + ';' + cliDir) : cliDir;
    const writeScript = "[Environment]::SetEnvironmentVariable('PATH','" +
      newPath.replace(/'/g, "''") + "','User')";
    const writeB64 = Buffer.from(writeScript, 'utf16le').toString('base64');
    execSync(
      'powershell -NoProfile -EncodedCommand ' + writeB64,
      { stdio: 'pipe', timeout: 8000 }
    );
    console.log('[cli-shims] registered in user PATH:', cliDir);
  } catch (e) {
    console.warn('[cli-shims] PATH registration failed (non-fatal):', e?.message);
  }
}

module.exports = {
  getBundledVendorDir,
  ensureVendorExtracted,
  getBundledNodeBin,
  getBundledOpenClawCliJs,
  augmentPathWithBundledNode,
  initPathAugmentation,
  enumerateNodeManagerBinDirs,
  enumerateNodeManagerLibDirs,
  appDataDir,
  resolveBinAbsolute,
  findBundledOpenClawMjs,
  findOpenClawBin,
  findOpenClawBinSync,
  findNodeBin,
  findOpenClawCliJs,
  spawnOpenClawSafe,
  runOpenClaw,
  bootDiagLog,
  bootDiagInit,
  bootDiagRunFullCheck,
  npmGlobalModules,
  findGlobalPackageFile,
  runSplashAndExtractVendor,
  ensureCliShims,
};
