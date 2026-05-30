'use strict';
// Python runtime resolution for skill scripts.
//
// Strategy:
//   1. Check user-installed Python first (python3, python in PATH).
//      Accept version >= 3.8 (modern enough for pandas, requests, playwright).
//   2. If none compatible, lazy-download embedded Python to
//      `%APPDATA%/9bizclaw/vendor/python/` (~30MB on Windows).
//   3. Cache resolved path in `<workspace>/.python-binary.txt` so we don't
//      re-detect every spawn.
//
// macOS/Linux: rely on system `python3` (Apple ships one; Linux distros do).
// Windows: prefer system Python if installed (3.8+), else embedded.

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const https = require('https');
const os = require('os');

const MIN_PYTHON_MAJOR = 3;
const MIN_PYTHON_MINOR = 8;

// Windows embedded distribution. Version pinned to LTS-ish 3.11 for broad
// package compatibility (pandas, requests, playwright wheels all available).
const EMBEDDED_PYTHON_VERSION = '3.11.9';
const EMBEDDED_URL_WIN_X64 = `https://www.python.org/ftp/python/${EMBEDDED_PYTHON_VERSION}/python-${EMBEDDED_PYTHON_VERSION}-embed-amd64.zip`;
const EMBEDDED_URL_WIN_ARM = `https://www.python.org/ftp/python/${EMBEDDED_PYTHON_VERSION}/python-${EMBEDDED_PYTHON_VERSION}-embed-arm64.zip`;

let _cachedPythonBin = null;
let _cacheCheckedAt = 0;
const CACHE_TTL_MS = 60_000; // 1 minute — fast re-resolve in same session

function _parseVersion(stdout) {
  // "Python 3.11.7" or "Python 3.8.10"
  const m = String(stdout || '').match(/Python\s+(\d+)\.(\d+)\.(\d+)/i);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function _isCompatible(ver) {
  if (!ver) return false;
  if (ver.major > MIN_PYTHON_MAJOR) return true;
  if (ver.major < MIN_PYTHON_MAJOR) return false;
  return ver.minor >= MIN_PYTHON_MINOR;
}

// Resolve a PATH-relative binary name to its absolute path. Returns null if
// not found. Uses `where` on Windows and `/usr/bin/which` on POSIX. We can NOT
// use `command -v` here because `command` is a shell builtin (not a binary)
// and spawnSync with shell:false would ENOENT it.
function _resolveBinAbs(name) {
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null;
  try {
    const cmd = process.platform === 'win32' ? 'where' : '/usr/bin/which';
    const r = spawnSync(cmd, [name], { timeout: 3000, encoding: 'utf-8', shell: false });
    if (r.status !== 0) return null;
    const lines = String(r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    return lines[0] || null;
  } catch { return null; }
}

// On Windows, `python3.exe` and `python.exe` in
// `%LOCALAPPDATA%\Microsoft\WindowsApps\` are App Execution Aliases — 0-byte
// reparse points that either forward to a Microsoft Store Python install OR
// (if the user hasn't installed Store Python) open the Store UI silently.
// With `windowsHide:true`, the stub hangs forever waiting for UI. The stub
// DOES respond to `--version` (forwarded), so `_tryPython` would accept it
// and cache `python3` → every real script spawn hangs. Reject by path.
function _isMsStoreStub(abs) {
  if (!abs || process.platform !== 'win32') return false;
  return /\\Microsoft\\WindowsApps\\python(3)?\.exe$/i.test(abs);
}

// macOS counterpart: `/usr/bin/python3` is Apple's CommandLine Tools shim.
// When CLT IS installed, it works fine (forwards to xcrun). When CLT is NOT
// installed, invoking it pops a GUI "Install developer tools?" dialog and
// blocks. From an Electron child process spawn (non-TTY, possibly LSUIElement)
// the dialog may not surface and the process hangs indefinitely. Detect by
// asking `xcode-select -p` (exits 0 iff CLT path is set).
function _isMacCltStubMissing(abs) {
  if (!abs || process.platform !== 'darwin') return false;
  if (abs !== '/usr/bin/python3') return false;
  try {
    const r = spawnSync('/usr/bin/xcode-select', ['-p'], { timeout: 2000, encoding: 'utf-8' });
    return r.status !== 0;
  } catch { return true; }
}

function _tryPython(bin) {
  try {
    const abs = _resolveBinAbs(bin);
    if (!abs) return null;
    if (_isMsStoreStub(abs)) return null;
    if (_isMacCltStubMissing(abs)) return null;
    const r = spawnSync(abs, ['--version'], { timeout: 5000, encoding: 'utf-8' });
    if (r.status !== 0) return null;
    // Python <3.4 prints to stderr; modern versions to stdout. Check both.
    const ver = _parseVersion(r.stdout) || _parseVersion(r.stderr);
    if (_isCompatible(ver)) return { bin: abs, version: ver };
    return null;
  } catch { return null; }
}

function _workspaceDir() {
  try { return require('./workspace').getWorkspace(); }
  catch { return null; }
}

function _userDataVendorPythonDir() {
  // Embedded Python lives in userData/vendor/python (same root as Node vendor).
  // Avoid bundling in EXE — keep distribution lean per runtime-install model.
  try {
    const electron = require('electron');
    const userData = electron?.app?.getPath?.('userData');
    if (userData) return path.join(userData, 'vendor', 'python');
  } catch {}
  // Fallback for non-Electron contexts (tests, CLI use)
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || home, '9bizclaw', 'vendor', 'python');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', '9bizclaw', 'vendor', 'python');
  return path.join(home, '.config', '9bizclaw', 'vendor', 'python');
}

function _cacheFile() {
  const ws = _workspaceDir();
  if (!ws) return null;
  return path.join(ws, '.python-binary.txt');
}

function _readCache() {
  const cf = _cacheFile();
  if (!cf) return null;
  try {
    if (!fs.existsSync(cf)) return null;
    const p = fs.readFileSync(cf, 'utf-8').trim();
    if (!p) return null;
    // Cache MUST hold an absolute path. Older versions wrote PATH-relative
    // names ('python3') which on Windows can resolve to the Microsoft Store
    // App Execution Alias and hang under windowsHide:true spawn. Invalidate
    // any non-absolute or stub-path cache so the next call re-detects.
    if (!path.isAbsolute(p)) return null;
    if (!fs.existsSync(p)) return null;
    if (_isMsStoreStub(p)) return null;
    if (_isMacCltStubMissing(p)) return null;
    return p;
  } catch { return null; }
}

function _writeCache(bin) {
  const cf = _cacheFile();
  if (!cf) return;
  try { fs.writeFileSync(cf, bin, 'utf-8'); } catch {}
}

// Synchronous detection. Returns absolute path or null.
function detectSystemPython() {
  if (_cachedPythonBin && Date.now() - _cacheCheckedAt < CACHE_TTL_MS) {
    return _cachedPythonBin;
  }
  // Cache file (persisted across boots)
  const cached = _readCache();
  if (cached) {
    _cachedPythonBin = cached;
    _cacheCheckedAt = Date.now();
    return cached;
  }
  // Try common bin names in order of preference.
  // On Windows, prefer `python`/`py` (real installer) BEFORE `python3` because
  // `python3.exe` on most Windows machines is the Microsoft Store App Execution
  // Alias — see _isMsStoreStub. Real CPython installers only create python.exe.
  //
  // On Mac/Linux, also include explicit absolute fallback paths. Electron
  // launched from Finder/Dock on macOS inherits the LAUNCHER's PATH, not the
  // user's shell PATH — so `which python3` returns null even if Homebrew is
  // installed (because /opt/homebrew/bin is added by shell rc, not by macOS
  // launchd). Check those install locations directly.
  let candidates;
  if (process.platform === 'win32') {
    candidates = ['py', 'python', 'python3'];
  } else if (process.platform === 'darwin') {
    candidates = [
      'python3', 'python',
      '/opt/homebrew/bin/python3',           // Homebrew on Apple Silicon
      '/usr/local/bin/python3',              // Homebrew on Intel, Python.org forwarder
      '/Library/Frameworks/Python.framework/Versions/Current/bin/python3', // Python.org installer
      '/usr/bin/python3',                    // Apple CLT (last resort; stub-guarded)
    ];
  } else {
    candidates = ['python3', 'python', '/usr/bin/python3', '/usr/local/bin/python3'];
  }
  for (const name of candidates) {
    const r = _tryPython(name);
    if (r) {
      _cachedPythonBin = r.bin;
      _cacheCheckedAt = Date.now();
      _writeCache(r.bin);
      console.log(`[python-runtime] detected system Python ${r.version.major}.${r.version.minor}.${r.version.patch} at ${r.bin}`);
      return r.bin;
    }
  }
  // Check embedded location
  const embedDir = _userDataVendorPythonDir();
  const embedBin = process.platform === 'win32'
    ? path.join(embedDir, 'python.exe')
    : path.join(embedDir, 'bin', 'python3');
  if (fs.existsSync(embedBin)) {
    const r = _tryPython(embedBin);
    if (r) {
      _cachedPythonBin = embedBin;
      _cacheCheckedAt = Date.now();
      _writeCache(embedBin);
      console.log(`[python-runtime] using embedded Python ${r.version.major}.${r.version.minor}.${r.version.patch} at ${embedBin}`);
      return embedBin;
    }
  }
  return null;
}

// Lazy-download embedded Python. Only Windows for now (Mac/Linux ship Python).
// Returns a promise that resolves to the binary path or rejects on error.
async function downloadEmbeddedPython(progressCb) {
  if (process.platform !== 'win32') {
    throw new Error('Embedded Python download only supported on Windows. Mac/Linux: install python3 via system package manager.');
  }
  const embedDir = _userDataVendorPythonDir();
  fs.mkdirSync(embedDir, { recursive: true });
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const url = arch === 'arm64' ? EMBEDDED_URL_WIN_ARM : EMBEDDED_URL_WIN_X64;
  const zipPath = path.join(embedDir, 'python-embed.zip');
  console.log(`[python-runtime] downloading embedded Python ${EMBEDDED_PYTHON_VERSION} (${arch}) from ${url}`);
  await _httpsDownload(url, zipPath, progressCb);
  // Extract zip (Windows built-in tar handles zip since 10.0.17063)
  console.log('[python-runtime] extracting...');
  const tarRes = spawnSync('tar', ['-xf', zipPath, '-C', embedDir], { timeout: 60000 });
  if (tarRes.status !== 0) {
    throw new Error('Failed to extract Python zip: ' + (tarRes.stderr?.toString() || 'tar exit ' + tarRes.status));
  }
  try { fs.unlinkSync(zipPath); } catch {}
  // Enable site-packages: edit python311._pth to uncomment `import site`
  try {
    const pthFile = fs.readdirSync(embedDir).find(f => /^python\d+\._pth$/.test(f));
    if (pthFile) {
      const pthPath = path.join(embedDir, pthFile);
      const content = fs.readFileSync(pthPath, 'utf-8');
      const patched = content.replace(/^#import site$/m, 'import site');
      fs.writeFileSync(pthPath, patched, 'utf-8');
    }
  } catch (e) { console.warn('[python-runtime] _pth patch failed:', e.message); }
  const bin = path.join(embedDir, 'python.exe');
  if (!fs.existsSync(bin)) throw new Error('Python binary not found after extract: ' + bin);
  const verified = _tryPython(bin);
  if (!verified) throw new Error('Embedded Python verification failed');
  _cachedPythonBin = bin;
  _cacheCheckedAt = Date.now();
  _writeCache(bin);
  console.log(`[python-runtime] embedded Python ready at ${bin}`);
  return bin;
}

function _httpsDownload(url, dst, progressCb) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dst);
    https.get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        // Follow redirect
        file.close(); try { fs.unlinkSync(dst); } catch {}
        return _httpsDownload(res.headers.location, dst, progressCb).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close(); try { fs.unlinkSync(dst); } catch {}
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (progressCb && total) {
          try { progressCb({ received, total, percent: Math.round((received / total) * 100) }); } catch {}
        }
      });
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        // Verify byte count when Content-Length was advertised. Without this,
        // a connection that drops mid-stream resolved as success and the
        // truncated zip would fail extraction later with a confusing error
        // (or worse, extract partial data).
        if (total > 0 && received !== total) {
          try { fs.unlinkSync(dst); } catch {}
          return reject(new Error(`download truncated: got ${received} of ${total} bytes`));
        }
        resolve(dst);
      });
      file.on('error', (e) => { try { fs.unlinkSync(dst); } catch {}; reject(e); });
    }).on('error', (e) => {
      try { fs.unlinkSync(dst); } catch {};
      reject(e);
    });
  });
}

// High-level: returns python bin path, lazy-downloading if necessary.
// progressCb receives {phase, ...} for UI splash. Caller decides UX:
//   phase='detected' → ready, no action needed
//   phase='downloading' → show progress
//   phase='ready' → done
async function ensurePython(progressCb) {
  const detected = detectSystemPython();
  if (detected) {
    if (progressCb) try { progressCb({ phase: 'detected', bin: detected }); } catch {}
    return detected;
  }
  if (process.platform !== 'win32') {
    throw new Error('Python 3.8+ không tìm thấy trên máy. Cài Python3 qua Homebrew (Mac) hoặc package manager (Linux), rồi thử lại.');
  }
  if (progressCb) try { progressCb({ phase: 'downloading' }); } catch {}
  const bin = await downloadEmbeddedPython((p) => {
    if (progressCb) try { progressCb({ phase: 'downloading', ...p }); } catch {}
  });
  if (progressCb) try { progressCb({ phase: 'ready', bin }); } catch {}
  return bin;
}

module.exports = {
  detectSystemPython,
  ensurePython,
  downloadEmbeddedPython,
  MIN_PYTHON_MAJOR,
  MIN_PYTHON_MINOR,
  EMBEDDED_PYTHON_VERSION,
};
