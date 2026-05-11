'use strict';
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFilePromise = promisify(execFile);
const execSync = require('child_process').execSync;

let app;
try { ({ app } = require('electron')); } catch {}

// Installation-recovery retry + error classification for transient failures.
// Retries network/disk errors with exponential backoff, calls onRetry for UI feedback.
let withRetry;
try {
  ({ withRetry } = require('./installation-recovery'));
} catch {}

let isModelDownloaded, downloadModels;
try {
  ({ isModelDownloaded, downloadModels } = require('./model-downloader'));
} catch {}

// Pinned versions — loaded from a single canonical source so runtime-installer.js
// and prebuild-vendor.js always agree. PINNING.md is the human-readable source.
const SHARED_VERSIONS = (() => {
  try {
    return JSON.parse(require('fs').readFileSync(
      require('path').join(__dirname, '..', 'scripts', 'versions.json'), 'utf-8'
    ));
  } catch {
    return { openclaw: '2026.4.14', openzca: '0.1.57', nineRouter: '0.4.12', gog: 'v0.13.0', node: '22.22.2' };
  }
})();

// NOTE: the contract check (scripts/check-runtime-install-contract.js) uses regex on this
// object's literal values. Do NOT remove the string literals below — the contract will fail.
const PINNED_VERSIONS = {
  openclaw: SHARED_VERSIONS.openclaw,
  openzca: SHARED_VERSIONS.openzca,
  nineRouter: SHARED_VERSIONS.nineRouter,
};

// NOTE: the contract check uses regex on GOG_VERSION's string value. Do NOT refactor away.
const GOG_VERSION = SHARED_VERSIONS.gog;

// Minimum Node.js version required
const MIN_NODE_VERSION = '22.14.0';

// Package definitions
const PACKAGES = [
  { name: 'openclaw', version: PINNED_VERSIONS.openclaw },
  { name: 'openzca', version: PINNED_VERSIONS.openzca },
  { name: '9router', version: PINNED_VERSIONS.nineRouter },
];

const NPM_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

// Layout version for future migration safety.
// Bump this whenever the runtime install output directory structure changes.
// Old installations with a mismatched layout version will trigger a clean re-install.
const LAYOUT_VERSION = '1';

// SHA256 checksums for the Node.js download ARCHIVES (zip/tar.gz).
// Sources: https://nodejs.org/dist/v22.22.2/SHASUMS256.txt
// Verified AFTER download, BEFORE extraction — catches corrupt/truncated downloads.
// If the runtime install layout changes (e.g., different Node version), bump
// LAYOUT_VERSION and update these checksums accordingly.
const NODE_SHA256 = {
  'win32-x64':    '7c93e9d92bf68c07182b471aa187e35ee6cd08ef0f24ab060dfff605fcc1c57c',
  'win32-arm64':  '380d375cf650c5a7f2ef3ce29ac6ea9a1c9d2ec8ea8e8391e1a34fd543886ab3',
  'darwin-x64':   '12a6abb9c2902cf48a21120da13f87fde1ed1b71a13330712949e8db818708ba',
  'darwin-arm64': 'db4b275b83736df67533529a18cc55de2549a8329ace6c7bcc68f8d22d3c9000',
};

// MinGit — portable git for Windows (~30 MB). Needed when system git is absent
// and npm needs git for transitive dependency resolution.
const MINGIT_VERSION = '2.47.1.2';
const MINGIT_TAG = 'v2.47.1.windows.2';
const MINGIT_URL = {
  x64: `https://github.com/git-for-windows/git/releases/download/${MINGIT_TAG}/MinGit-${MINGIT_VERSION}-64-bit.zip`,
  arm64: `https://github.com/git-for-windows/git/releases/download/${MINGIT_TAG}/MinGit-${MINGIT_VERSION}-arm64.zip`,
};

const GOG_ARCHIVE_SHA256 = {
  'win32-x64':    '30836d03f66769ef38a65dd4b81ae2864e2159941d9751b6fdec6ea86be8726f',
  'win32-arm64':  '23c72facae6f2a8963a2a7dca87f3dadb1d9400912d832d263f611f3df15a9c3',
  'darwin-arm64': '7c6f650f7516323ddd003e4ababf998fc1d2c73089a4662b8c79bf80ac4bdf56',
  'darwin-x64':   '15c88798d25cb2e1870cafa5df232601f3a05472a134ca8c396be907f2b235f6',
};

// User-facing error messages for common download/install failures.
// Parsed by the UI to show actionable guidance in the user's language.
const ERROR_HINTS = {
  ENOTFOUND: 'Không phân giải được địa chỉ máy chủ. Kiểm tra kết nối mạng.',
  DNS: 'Lỗi phân giải DNS. Thử dùng mạng khác hoặc kiểm tra cấu hình DNS.',
  ECONNREFUSED: 'Máy chủ từ chối kết nối. Có thể do proxy/corporate firewall.',
  ETIMEDOUT: 'Kết nối quá chậm hoặc timeout. Thử mạng khác hoặc chờ vài phút.',
  TIMEOUT: 'Tải mất quá lâu (>10 phút). Thử mạng nhanh hơn.',
  PROXY: 'Proxy/corporate firewall có thể chặn kết nối. Kiểm tra cấu hình mạng.',
  'CERT_HAS_EXPIRED': 'Chứng chỉ TLS hết hạn — có thể do proxy corporate. Thử mạng khác.',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Lỗi xác thực chứng chỉ TLS. Kiểm tra proxy corporate.',
  ENOSPC: 'Ổ đĩa gần đầy. Giải phóng ít nhất 500 MB trước khi tiếp tục.',
  EACCES: 'Không có quyền ghi vào thư mục. Thử chạy với quyền Administrator.',
  NPM_CERT_ERROR: 'npm không xác thực được chứng chỉ — có thể do proxy corporate. Thử: npm config set strict-ssl false',
  NPM_ECONNRESET: 'npm bị reset kết nối — proxy hoặc mạng không ổn định. Thử lại.',
  GIT_ENOENT: 'Máy chưa có git — 9BizClaw sẽ tự tải MinGit portable. Thử lại.',
  XCODE_SELECT: 'Mac chưa có Xcode Command Line Tools. 9BizClaw sẽ tự bỏ qua git — thử lại.',
};

// Detect if a corporate proxy is likely active by checking common env vars.
function detectProxyEnv() {
  const proxyVars = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];
  for (const v of proxyVars) {
    if (process.env[v]) return v;
  }
  return null;
}

// Classify a download or install error into a hint category.
function classifyInstallError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  const code = error?.code || '';
  if (code === 'ENOTFOUND' || msg.includes('getaddrinfo') || msg.includes('not found')) return 'ENOTFOUND';
  if (code === 'ETIMEDOUT' || msg.includes('timed out') || msg.includes('timeout')) return 'ETIMEDOUT';
  if (code === 'ECONNREFUSED') return 'ECONNREFUSED';
  if (code === 'TIMEDOUT' || msg.includes('timeout')) return 'TIMEOUT';
  if (msg.includes('proxy')) return 'PROXY';
  if (msg.includes('certificate') || msg.includes('cert') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
  if (code === 'CERT_HAS_EXPIRED') return 'CERT_HAS_EXPIRED';
  if (code === 'ENOSPC') return 'ENOSPC';
  if (code === 'EACCES') return 'EACCES';
  if (msg.includes('npm') && (msg.includes('cert') || msg.includes('ssl'))) return 'NPM_CERT_ERROR';
  if (msg.includes('npm') && (msg.includes('connect') || msg.includes('reset'))) return 'NPM_ECONNRESET';
  if (msg.includes('xcode-select') || msg.includes('xcode_select')) return 'XCODE_SELECT';
  if (msg.includes('git error') && (msg.includes('enoent') || msg.includes('errno -4058'))) return 'GIT_ENOENT';
  return null;
}

// Return an actionable user message for a classified error.
function getInstallErrorHint(error) {
  const cls = classifyInstallError(error);
  if (cls && ERROR_HINTS[cls]) return ERROR_HINTS[cls];
  if (detectProxyEnv()) return ERROR_HINTS.PROXY;
  return null;
}

// Verify SHA256 of a file. Returns true if hash matches, false otherwise.
function verifySha256(filePath, expectedHash) {
  try {
    const { createHash } = require('crypto');
    const data = fs.readFileSync(filePath);
    const hash = createHash('sha256').update(data).digest('hex');
    return hash === expectedHash;
  } catch {
    return false;
  }
}

// Get the SHA256 key for the current platform + arch.
function getNodeShaKey() {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const arch = process.arch === 'x64' ? 'x64' : 'arm64';
  if (isWin) return `win32-${arch}`;
  if (isMac) return `darwin-${arch}`;
  return null; // linux: not supported for bundled install
}

function getGogShaKey() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return null;
  const arch = process.arch === 'x64' ? 'x64' : 'arm64';
  return `${process.platform}-${arch}`;
}

function verifyDownloadedGogArchive(filePath) {
  const shaKey = getGogShaKey();
  const expected = shaKey ? GOG_ARCHIVE_SHA256[shaKey] : null;
  if (!expected) {
    try { fs.unlinkSync(filePath); } catch {}
    throw new Error(`No gogcli SHA256 checksum for ${shaKey || 'unsupported-platform'}`);
  }
  if (verifySha256(filePath, expected)) return;
  try { fs.unlinkSync(filePath); } catch {}
  throw new Error(`gogcli SHA256 mismatch for ${shaKey}`);
}

// =====================================================================
// Installation Status
// =====================================================================
let _installStatus = null;
let _installInProgress = false;

const { getUserDataDir, copyDirRecursive: _copyDir } = require('./workspace');

function getRuntimeNodeDir() {
  // For runtime install (v2.4.0+), packages live in:
  //   Windows: %APPDATA%\9bizclaw\vendor\
  //   Mac: ~/Library/Application Support/9bizclaw/vendor/
  return path.join(getUserDataDir(), 'vendor');
}

function getPortableGitDir() {
  return path.join(getRuntimeNodeDir(), 'git');
}

function findGitBin() {
  const portable = path.join(getPortableGitDir(), 'cmd', 'git.exe');
  if (fs.existsSync(portable)) return portable;
  if (process.platform !== 'win32') {
    if (process.platform === 'darwin') {
      if (!macHasXcodeCLT()) {
        // Check common non-CLT git paths before giving up
        const macGitPaths = [
          '/opt/homebrew/bin/git',
          '/usr/local/bin/git',
          '/opt/local/bin/git',
        ];
        for (const p of macGitPaths) {
          if (fs.existsSync(p)) {
            console.log('[runtime-installer] Mac: found git outside CLT at', p);
            return p;
          }
        }
        // Create curl-based git shim as last resort
        const shim = ensureMacGitShim();
        if (shim) return shim;
        return null;
      }
    }
    return 'git';
  }
  try {
    const out = execSync('where git.exe', { encoding: 'utf8', timeout: 5000 }).trim();
    if (out) return out.split(/\r?\n/)[0];
  } catch {}
  return null;
}

function ensureMacGitShim() {
  const shimDir = path.join(getRuntimeNodeDir(), 'tools');
  const shimPath = path.join(shimDir, 'git-shim.sh');
  try {
    fs.mkdirSync(shimDir, { recursive: true });
    fs.writeFileSync(shimPath, MAC_GIT_SHIM, { mode: 0o755 });
    console.log('[runtime-installer] Mac: created git shim at', shimPath);
    return shimPath;
  } catch (e) {
    console.error('[runtime-installer] Mac: failed to create git shim:', e.message);
    return null;
  }
}

const MAC_GIT_SHIM = [
  '#!/bin/sh',
  '# Git shim for macOS without Xcode CLT.',
  '# Handles git+https GitHub URLs via curl tarball download.',
  '# Only supports the subset of git commands npm needs.',
  'case "$1" in',
  '  clone)',
  '    shift',
  '    URL="" DIR=""',
  '    while [ $# -gt 0 ]; do',
  '      case "$1" in',
  '        --depth|--branch|-b) shift; shift;;',
  '        -q|--recurse-submodules|--single-branch|--no-tags|--progress) shift;;',
  '        --*) shift;;',
  '        *) if [ -z "$URL" ]; then URL="$1"; else DIR="$1"; fi; shift;;',
  '      esac',
  '    done',
  '    [ -z "$DIR" ] && DIR=$(basename "$URL" .git)',
  '    CLEAN=$(echo "$URL" | sed \'s|^git+||;s|\\.git$||\')',
  '    mkdir -p "$DIR"',
  '    TMPTAR=$(mktemp /tmp/git-shim-XXXXXX.tar.gz)',
  '    /usr/bin/curl -fsSL --connect-timeout 15 --max-time 120 -o "$TMPTAR" "${CLEAN}/archive/HEAD.tar.gz" 2>/dev/null',
  '    RC=$?',
  '    if [ $RC -ne 0 ] || [ ! -s "$TMPTAR" ]; then',
  '      /usr/bin/curl -fsSL --connect-timeout 15 --max-time 120 -o "$TMPTAR" "${CLEAN}/archive/refs/heads/main.tar.gz" 2>/dev/null',
  '      RC=$?',
  '    fi',
  '    if [ $RC -eq 0 ] && [ -s "$TMPTAR" ]; then',
  '      /usr/bin/tar xzf "$TMPTAR" -C "$DIR" --strip-components=1',
  '      RC=$?',
  '    else',
  '      RC=1',
  '    fi',
  '    rm -f "$TMPTAR"',
  '    if [ $RC -eq 0 ] && [ -f "$DIR/package.json" ]; then',
  '      mkdir -p "$DIR/.git"',
  '      echo "ref: refs/heads/master" > "$DIR/.git/HEAD"',
  '    elif [ $RC -eq 0 ]; then',
  '      RC=1',
  '    fi',
  '    exit $RC',
  '    ;;',
  '  ls-remote)',
  '    # npm uses ls-remote to get commit hash — return a stable fake hash.',
  '    # printf ensures tab character (echo \\t is unreliable across shells).',
  '    printf "%s\\tHEAD\\n" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
  '    printf "%s\\trefs/heads/master\\n" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
  '    exit 0',
  '    ;;',
  '  checkout|rev-parse|fetch|reset|init)',
  '    if [ "$1" = "rev-parse" ]; then',
  '      echo "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
  '    fi',
  '    exit 0',
  '    ;;',
  '  *)',
  '    exit 0',
  '    ;;',
  'esac',
].join('\n') + '\n';

// On macOS without Xcode CLT, /usr/bin/git is a shim that triggers a system
// dialog asking to install developer tools. This blocks the npm process and
// eventually fails. Detect this BEFORE npm runs so we can neutralize it.
let _macCLTChecked = false;
let _macHasCLT = true;
function macHasXcodeCLT() {
  if (process.platform !== 'darwin') return true;
  if (_macCLTChecked) return _macHasCLT;
  _macCLTChecked = true;
  try {
    const cltPath = execSync('xcode-select -p', { timeout: 5000, stdio: 'pipe', encoding: 'utf-8' }).trim();
    // xcode-select -p can return a path even when CLT is partially installed.
    // Verify the actual git binary exists inside the CLT directory.
    const gitBin = path.join(cltPath, 'usr', 'bin', 'git');
    if (!fs.existsSync(gitBin)) {
      throw new Error('CLT path exists but git binary missing at ' + gitBin);
    }
    _macHasCLT = true;
  } catch {
    _macHasCLT = false;
    console.log('[runtime-installer] Mac: Xcode CLT not installed — will neutralize git shim');
  }
  return _macHasCLT;
}

async function ensureXcodeCLT(onProgress) {
  if (process.platform !== 'darwin' || macHasXcodeCLT()) return;
  console.log('[runtime-installer] Mac: Xcode CLT missing — triggering install dialog');
  if (onProgress) onProgress({ step: 'packages', percent: 2, message: 'Cài Xcode Command Line Tools...', subStep: 'Nhấn "Install" trong hộp thoại macOS' });
  try {
    require('child_process').execSync('xcode-select --install', { timeout: 10000, stdio: 'ignore' });
  } catch {}
  const maxWaitMs = 10 * 60 * 1000;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 5000));
    _macCLTChecked = false;
    if (macHasXcodeCLT()) {
      console.log('[runtime-installer] Mac: Xcode CLT installed after', Math.round((Date.now() - start) / 1000), 's');
      if (onProgress) onProgress({ step: 'packages', percent: 5, message: 'Xcode CLT đã sẵn sàng' });
      return;
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    if (onProgress) onProgress({ step: 'packages', percent: 2, message: 'Chờ cài Xcode Command Line Tools...', subStep: `Nhấn "Install" (${elapsed}s)` });
  }
  console.log('[runtime-installer] Mac: Xcode CLT timed out after 10min — falling back to git shim');
  forceNeutralizeGitShim();
}

function forceNeutralizeGitShim() {
  _macCLTChecked = true;
  _macHasCLT = false;
  console.log('[runtime-installer] Mac: force-neutralizing git shim after xcode-select error');
}

function getGitEnvPath() {
  const gitDir = path.join(getPortableGitDir(), 'cmd');
  const current = process.env.PATH || process.env.Path || '';
  if (fs.existsSync(gitDir)) return gitDir + path.delimiter + current;
  return current;
}

// Build env object for child process with correct PATH on Windows.
// Windows env vars are case-insensitive but JS objects aren't — spreading
// process.env copies the original key (usually "Path" on Windows). Adding
// a separate "PATH" key creates a duplicate; CreateProcess uses the FIRST
// occurrence, ignoring our override. Fix: delete all PATH variants first.
function buildEnvWithGitPath(extra) {
  const env = { ...process.env, ...extra };
  const gitPath = getGitEnvPath();
  delete env.PATH;
  delete env.Path;
  delete env.path;
  env.PATH = gitPath;
  // Runtime install never needs real git — all packages are on npm registry.
  // Always neutralize git to prevent Xcode CLT dialog popup, git auth prompts,
  // or any other git-related hang. Use our curl-based shim (handles git+https
  // URLs if a transitive dep has one), fall back to /usr/bin/false.
  if (process.platform === 'darwin') {
    const shimGit = findGitBin();
    env.npm_config_git = shimGit || '/usr/bin/false';
    console.log('[runtime-installer] npm_config_git =', env.npm_config_git);
  } else if (!macHasXcodeCLT()) {
    const shimGit = findGitBin();
    env.npm_config_git = shimGit || '/usr/bin/false';
  }
  return env;
}

async function ensurePortableGit(onProgress) {
  if (process.platform !== 'win32') {
    if (process.platform === 'darwin' && !macHasXcodeCLT()) {
      const shim = ensureMacGitShim();
      console.log('[runtime-installer] Mac: no CLT — using', shim ? 'curl-based git shim' : '/usr/bin/false fallback');
    }
    return;
  }
  if (findGitBin()) {
    console.log('[runtime-installer] git found:', findGitBin());
    return;
  }
  console.log('[runtime-installer] git not found — downloading MinGit...');
  if (onProgress) onProgress({ step: 'git', pct: 0, label: 'Đang tải Git...' });
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const url = MINGIT_URL[arch];
  const dest = getPortableGitDir();
  const zipPath = path.join(dest, 'mingit.zip');
  fs.mkdirSync(dest, { recursive: true });
  try {
    await downloadFile(url, zipPath, (pct) => {
      if (onProgress) onProgress({ step: 'git', pct, label: 'Đang tải Git...' });
    });
    try {
      execSync(`tar -xf "${zipPath}" -C "${dest}"`, { timeout: 120000 });
    } catch {
      execSync(`powershell -NoProfile -Command "Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${dest}'"`, { timeout: 120000 });
    }
    try { fs.unlinkSync(zipPath); } catch {}
    if (onProgress) onProgress({ step: 'git-done', pct: 100, label: 'Git đã sẵn sàng' });
    console.log('[runtime-installer] MinGit installed to', dest);
  } catch (e) {
    console.warn('[runtime-installer] MinGit download failed (non-fatal):', e?.message);
    if (onProgress) onProgress({ step: 'git-done', pct: 100, label: 'Git — bỏ qua' });
  }
}

function getRuntimeNodeHomeDir() {
  return path.join(getRuntimeNodeDir(), 'node');
}

function getRuntimeNodeBinDir() {
  // Node.js binary for runtime install
  // Windows: vendor/node/node.exe
  // Mac/Linux: vendor/node/bin/node
  return process.platform === 'win32'
    ? getRuntimeNodeHomeDir()
    : path.join(getRuntimeNodeHomeDir(), 'bin');
}

function getRuntimeNodeModulesDir() {
  // Packages for runtime install
  return path.join(getRuntimeNodeDir(), 'node_modules');
}

function getVersionFile() {
  return path.join(getUserDataDir(), 'runtime-version.txt');
}

function getInstalledVersion() {
  try {
    const vf = getVersionFile();
    if (fs.existsSync(vf)) {
      return fs.readFileSync(vf, 'utf8').trim();
    }
  } catch {}
  return null;
}

function writeInstalledVersion(version) {
  try {
    const vf = getVersionFile();
    fs.mkdirSync(path.dirname(vf), { recursive: true });
    fs.writeFileSync(vf, version, 'utf8');
  } catch (e) {
    console.error('[runtime-installer] Failed to write version file:', e.message);
  }
}

function getLayoutVersionFile() {
  return path.join(getUserDataDir(), 'layout-version.txt');
}

function writeLayoutVersion() {
  try {
    const f = getLayoutVersionFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, LAYOUT_VERSION, 'utf8');
  } catch (e) {
    console.error('[runtime-installer] Failed to write layout version file:', e.message);
  }
}

// =====================================================================
// Node.js Detection & Installation
// =====================================================================

function parseNodeVersion(versionString) {
  // Parse "v22.11.0" or "22.11.0"
  const match = versionString.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    full: match[0],
  };
}

function compareVersions(a, b) {
  const pa = parseNodeVersion(a);
  const pb = parseNodeVersion(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

function satisfiesMinVersion(version) {
  return compareVersions(version, MIN_NODE_VERSION) >= 0;
}

async function getSystemNodeVersion() {
  try {
    const { stdout } = await execFilePromise('node', ['--version'], { timeout: 5000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function getRuntimeNodeVersion() {
  const runtimeNode = getRuntimeNodeBinPath();
  if (!fs.existsSync(runtimeNode)) return null;
  try {
    const { stdout } = await execFilePromise(runtimeNode, ['--version'], { timeout: 5000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

function getRuntimeNodeBinPath() {
  const isWin = process.platform === 'win32';
  const nodeDir = getRuntimeNodeHomeDir();
  return isWin
    ? path.join(nodeDir, 'node.exe')
    : path.join(nodeDir, 'bin', 'node');
}

function findNpmCliIn(dir) {
  // Windows: dir/node_modules/npm/bin/npm-cli.{js,cjs}
  // Mac/Linux: dir/lib/node_modules/npm/bin/npm-cli.{js,cjs}
  const searchDirs = [
    path.join(dir, 'node_modules', 'npm', 'bin'),
    path.join(dir, 'lib', 'node_modules', 'npm', 'bin'),
  ];
  for (const npmBinDir of searchDirs) {
    for (const name of ['npm-cli.js', 'npm-cli.cjs', 'npm-cli.mjs']) {
      const p = path.join(npmBinDir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function isNodeInstallComplete() {
  const nodeBin = getRuntimeNodeBinPath();
  if (!fs.existsSync(nodeBin)) return false;
  return !!findNpmCliIn(getRuntimeNodeHomeDir());
}

async function detectNodeInstallation() {
  // Priority: runtime-installed (userData/vendor/) > system Node
  // Both Mac and Windows use runtime install model (v2.4.0+).

  // 1. Runtime-installed Node at userData/vendor/
  const runtimeVersion = await getRuntimeNodeVersion();
  if (runtimeVersion) {
    const nodeBin = getRuntimeNodeBinPath();
    if (!isNodeInstallComplete()) {
      console.warn('[runtime-installer] node.exe exists but npm-cli missing — incomplete extraction, forcing re-install');
      killOrphanVendorNodeProcesses();
      try { fs.rmSync(getRuntimeNodeHomeDir(), { recursive: true, force: true }); } catch {}
      return { type: 'none', path: null, version: null, satisfiesMin: false, isSystem: false };
    }
    console.log('[runtime-installer] Found runtime Node:', runtimeVersion, 'at', nodeBin);
    return {
      type: 'runtime',
      path: nodeBin,
      version: runtimeVersion,
      satisfiesMin: satisfiesMinVersion(runtimeVersion),
      isSystem: false,
    };
  }

  // Packaged builds must be self-contained. Do not treat system Node as
  // satisfying the install: boot.js resolves child processes through
  // userData/vendor/node, not through the user's PATH.
  if (app && app.isPackaged) {
    return {
      type: 'none',
      path: null,
      version: null,
      satisfiesMin: false,
      isSystem: false,
    };
  }

  // 2. Check system Node
  const systemVersion = await getSystemNodeVersion();
  if (systemVersion) {
    try {
      const { stdout } = process.platform === 'win32'
        ? await execFilePromise('where', ['node.exe'], { timeout: 5000 })
        : await execFilePromise('/bin/sh', ['-c', 'command -v node'], { timeout: 5000 });
      const nodePath = process.platform === 'win32'
        ? stdout.trim().split('\n')[0].trim()
        : stdout.trim();
      console.log('[runtime-installer] Found system Node:', systemVersion, 'at', nodePath);
      return {
        type: 'system',
        path: nodePath,
        version: systemVersion,
        satisfiesMin: satisfiesMinVersion(systemVersion),
        isSystem: true,
      };
    } catch {}
  }

  // 3. No Node found
  return {
    type: 'none',
    path: null,
    version: null,
    satisfiesMin: false,
    isSystem: false,
  };
}

function getNodeDownloadUrl(targetVersion) {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const arch = process.arch === 'x64' ? 'x64' : 'arm64';

  if (isWin) {
    return {
      url: `https://nodejs.org/dist/v${targetVersion}/node-v${targetVersion}-win-${arch}.zip`,
      type: 'zip',
    };
  } else if (isMac) {
    return {
      url: `https://nodejs.org/dist/v${targetVersion}/node-v${targetVersion}-darwin-${arch}.tar.gz`,
      type: 'tar.gz',
    };
  } else {
    return {
      url: `https://nodejs.org/dist/v${targetVersion}/node-v${targetVersion}-linux-${arch}.tar.gz`,
      type: 'tar.gz',
    };
  }
}

async function downloadFile(url, destPath, onProgress) {
  const isWin = process.platform === 'win32';

  // Attach actionable hint to error for UI display.
  function attachHint(e) {
    const hint = getInstallErrorHint(e);
    if (!hint) return e;
    const wrapped = new Error(e.message + ' | HINT: ' + hint);
    wrapped.code = e.code;
    return wrapped;
  }

  return new Promise((resolve, reject) => {
    // Use native fetch if available (Node 18+)
    let client;
    if (typeof fetch !== 'undefined') {
      const controller = new AbortController();
      const fetchTimeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
      fetch(url, { signal: controller.signal }).then(async (response) => {
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          reject(attachHint(new Error(`HTTP ${response.status} ${response.statusText}: ${body.slice(0, 200)}`)));
          return;
        }
        const total = parseInt(response.headers.get('content-length') || '0', 10);
        let downloaded = 0;
        const reader = response.body.getReader();
        const ws = fs.createWriteStream(destPath);

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            ws.write(Buffer.from(value));
            downloaded += value.length;
            if (total > 0 && onProgress) {
              onProgress({ percent: Math.floor((downloaded / total) * 100), downloaded, total });
            }
          }
          ws.end();
          await new Promise((res, rej) => { ws.on('finish', res); ws.on('error', rej); });
        } catch (streamErr) {
          ws.destroy();
          try { fs.unlinkSync(destPath); } catch {}
          throw streamErr;
        }
        clearTimeout(fetchTimeout);
        resolve();
      }).catch((e) => { clearTimeout(fetchTimeout); reject(attachHint(e)); });
      return;
    } else if (isWin) {
      // Windows: use PowerShell with 10-minute timeout to match download progress bar
      client = spawn('powershell', [
        '-NoProfile',
        '-Command',
        `Invoke-WebRequest -Uri '${url}' -OutFile '${destPath}' -UseBasicParsing -TimeoutSec 600`
      ], { stdio: 'pipe' });
    } else {
      // Unix: use curl
      client = spawn('curl', ['-fSL', '-o', destPath, '--progress-bar', url], { stdio: 'pipe' });
    }

    if (onProgress) onProgress({ percent: 0, downloaded: 0, total: 0 });
    let stderr = '';
    client?.stderr?.on('data', (d) => { stderr += String(d); });
    client.on('error', (e) => { reject(attachHint(e)); });
    client.on('close', (code) => {
      if (code !== 0) {
        reject(attachHint(new Error(`Download failed (exit ${code}): ${stderr}`)));
      } else {
        if (onProgress) {
          try {
            const size = fs.statSync(destPath).size;
            onProgress({ percent: 100, downloaded: size, total: size });
          } catch { onProgress({ percent: 100, downloaded: 0, total: 0 }); }
        }
        resolve();
      }
    });
  });
}

async function installNode(targetVersion, onProgress) {
  console.log('[runtime-installer] Installing Node.js', targetVersion);

  if (onProgress) onProgress({ step: 'node', percent: 0, message: `Đang tải Node.js ${targetVersion}...` });

  const { url, type } = getNodeDownloadUrl(targetVersion);
  const vendorDir = getRuntimeNodeDir();
  const nodeDir = getRuntimeNodeHomeDir();
  const downloadPath = path.join(vendorDir, `download.${type}`);

  // Ensure directory exists
  fs.mkdirSync(vendorDir, { recursive: true });

  // Download + verify archive SHA256 BEFORE extraction
  const shaKey = getNodeShaKey();
  const expectedArchiveHash = shaKey ? NODE_SHA256[shaKey] : null;

  for (let dlAttempt = 0; dlAttempt < 2; dlAttempt++) {
    try {
      await downloadFile(url, downloadPath, (p) => {
        if (onProgress) {
          const sizeMB = p.total > 0 ? (p.total / 1024 / 1024).toFixed(0) : '';
          const dlMB = p.downloaded > 0 ? (p.downloaded / 1024 / 1024).toFixed(1) : '';
          const sizeStr = sizeMB ? ` (${dlMB}/${sizeMB} MB)` : '';
          onProgress({ step: 'node', percent: p.percent * 0.8, message: `Đang tải Node.js ${targetVersion}${sizeStr}` });
        }
      });
    } catch (e) {
      throw new Error(`Không tải được Node.js: ${e.message}`);
    }

    if (expectedArchiveHash) {
      if (verifySha256(downloadPath, expectedArchiveHash)) {
        console.log('[runtime-installer] Archive SHA256 verified OK');
        break;
      }
      if (dlAttempt === 0) {
        console.warn('[runtime-installer] Archive SHA256 mismatch — re-downloading...');
        try { fs.unlinkSync(downloadPath); } catch {}
        continue;
      }
      try { fs.unlinkSync(downloadPath); } catch {}
      throw new Error('Node.js archive SHA256 không khớp sau 2 lần tải. Kiểm tra kết nối mạng hoặc proxy.');
    }
    break;
  }

  if (onProgress) onProgress({ step: 'node', percent: 80, message: 'Đang giải nén Node.js...', subStep: 'Expand-Archive' });

  // Extract
  const isWin = process.platform === 'win32';
  const extractDir = path.join(vendorDir, 'temp-node-' + Date.now());

  try {
    fs.mkdirSync(extractDir, { recursive: true });

    // Heartbeat during extraction so splash doesn't look stuck
    let extractTick = 80;
    const extractTimer = setInterval(() => {
      if (extractTick < 94) extractTick += 1;
      if (onProgress) onProgress({ step: 'node', percent: extractTick, message: 'Đang giải nén Node.js...', subStep: `${extractTick - 80}s` });
    }, 1000);

    try {
      if (type === 'zip') {
        // Use native tar (bsdtar, built into Windows 10+) — faster than
        // PowerShell Expand-Archive and avoids .NET MAX_PATH edge cases.
        // Falls back to Expand-Archive only if tar fails.
        let extracted = false;
        try {
          await new Promise((resolve, reject) => {
            const t = spawn('tar', ['-xf', downloadPath, '-C', extractDir], { stdio: 'pipe' });
            let stderr = '';
            t.stderr?.on('data', d => { stderr += String(d); });
            t.on('close', (code) => code === 0 ? resolve() : reject(new Error(`tar -xf zip failed (${code}): ${stderr}`)));
            t.on('error', reject);
          });
          extracted = true;
        } catch (tarErr) {
          console.warn('[runtime-installer] tar -xf zip failed, falling back to Expand-Archive:', tarErr.message);
        }
        if (!extracted) {
          await new Promise((resolve, reject) => {
            const ps = spawn('powershell', [
              '-NoProfile',
              '-Command',
              `Expand-Archive -Path '${downloadPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`
            ], { stdio: 'pipe' });
            let stderr = '';
            ps.stderr?.on('data', d => { stderr += String(d); });
            ps.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Expand-Archive failed (${code}): ${stderr}`)));
            ps.on('error', reject);
          });
        }
      } else {
        await new Promise((resolve, reject) => {
          const tar = spawn('tar', ['-xzf', downloadPath, '-C', extractDir], { stdio: 'pipe' });
          tar.on('close', (code) => code === 0 ? resolve() : reject(new Error(`tar failed: ${code}`)));
          tar.on('error', reject);
        });
      }
    } finally {
      clearInterval(extractTimer);
    }

    // Find the actual extracted directory (may be nested like node-v22.14.0-win-x64/)
    const entries = fs.readdirSync(extractDir);
    let extractedRoot = null;

    // Look for the directory that contains node executable
    for (const entry of entries) {
      const entryPath = path.join(extractDir, entry);
      if (fs.statSync(entryPath).isDirectory()) {
        // Check if this directory contains node
        const potentialNode = isWin
          ? path.join(entryPath, 'node.exe')
          : path.join(entryPath, 'bin', 'node');
        if (fs.existsSync(potentialNode)) {
          extractedRoot = entryPath;
          break;
        }
      }
    }

    // Fallback: assume first entry is the root
    if (!extractedRoot && entries.length > 0) {
      extractedRoot = path.join(extractDir, entries[0]);
    }

    if (!extractedRoot) {
      throw new Error('Could not find extracted Node.js directory');
    }

    // Kill any process using vendor/node/node.exe before replacing it
    killOrphanVendorNodeProcesses();
    // Move extracted Node root to vendor/node, preserving vendor/node_modules.
    try { fs.rmSync(nodeDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(path.dirname(nodeDir), { recursive: true });
    try {
      fs.renameSync(extractedRoot, nodeDir);
    } catch (e) {
      // Fallback to copy if rename fails (cross-device move)
      if (e.code === 'EXDEV') {
        console.log('[runtime-installer] Cross-device move, using copy');
        copyDirRecursive(extractedRoot, nodeDir);
        fs.rmSync(extractedRoot, { recursive: true, force: true });
      } else {
        throw e;
      }
    }

    // Cleanup extract dir
    fs.rmSync(extractDir, { recursive: true, force: true });

  } catch (e) {
    // Cleanup on failure
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(downloadPath); } catch {}
    throw new Error(`Không giải nén được Node.js: ${e.message}`);
  }

  // Verify extracted binary AND npm-cli exist (catch partial extractions)
  const nodeBin = getRuntimeNodeBinPath();
  if (!fs.existsSync(nodeBin)) {
    throw new Error(`Node.js installation failed: binary not found at ${nodeBin}`);
  }
  const npmCliPath = findNpmCliIn(getRuntimeNodeHomeDir());
  if (!npmCliPath) {
    console.error('[runtime-installer] node.exe OK but npm-cli missing — extraction incomplete');
    try { fs.rmSync(getRuntimeNodeHomeDir(), { recursive: true, force: true }); } catch {}
    throw new Error('Node.js extraction incomplete: npm not found. Will retry on next launch.');
  }
  console.log('[runtime-installer] npm-cli verified at', npmCliPath);

  // Cleanup download archive (already verified before extraction)
  try { fs.unlinkSync(downloadPath); } catch {}

  if (onProgress) onProgress({ step: 'node', percent: 100, message: 'Node.js đã sẵn sàng' });

  console.log('[runtime-installer] Node.js installed successfully at', nodeBin);
  return { path: nodeBin, version: targetVersion };
}

// =====================================================================
// NPM Package Detection & Installation
// =====================================================================

async function getInstalledPackages() {
  const nodeBin = await getWorkingNodeBin();
  if (!nodeBin) return {};

  const result = {};
  for (const pkg of PACKAGES) {
    try {
      const pkgPath = path.join(getRuntimeNodeModulesDir(), pkg.name, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        result[pkg.name] = pkgJson.version;
      }
    } catch {}
  }
  return result;
}

async function getWorkingNodeBin() {
  // Try runtime Node first
  const runtimeVersion = await getRuntimeNodeVersion();
  if (runtimeVersion) {
    return getRuntimeNodeBinPath();
  }

  if (app && app.isPackaged) return null;

  // Fall back to system Node
  const systemVersion = await getSystemNodeVersion();
  if (systemVersion) {
    try {
      const out = execSync(
        process.platform === 'win32' ? 'where node' : 'command -v node',
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();
      return out.split('\n')[0].trim();
    } catch {}
  }

  return null;
}

function getRuntimeNpmCommand(nodeBin = null) {
  const runtimeNode = nodeBin || getRuntimeNodeBinPath();

  // Tier 1: runtime node + npm-cli from node home (covers .js/.cjs/.mjs)
  const nodeHomeCli = findNpmCliIn(getRuntimeNodeHomeDir());
  if (runtimeNode && fs.existsSync(runtimeNode) && nodeHomeCli) {
    return { command: runtimeNode, argsPrefix: [nodeHomeCli], shell: false };
  }

  // Tier 2: node binary sibling npm-cli (when nodeBin is external e.g. system node)
  if (runtimeNode && fs.existsSync(runtimeNode)) {
    const siblingCli = findNpmCliIn(path.dirname(runtimeNode));
    if (siblingCli) {
      return { command: runtimeNode, argsPrefix: [siblingCli], shell: false };
    }
  }

  // Tier 3: system npm (where npm.cmd / command -v npm)
  const isWin = process.platform === 'win32';
  try {
    const cmd = isWin ? 'where npm.cmd' : 'command -v npm';
    const out = execSync(cmd, { encoding: 'utf-8', timeout: 5000, shell: !isWin }).trim();
    const npmPath = out.split(/\r?\n/)[0]?.trim();
    if (npmPath) {
      if (isWin && npmPath.toLowerCase().endsWith('.cmd')) {
        const npmDir = path.dirname(npmPath);
        const nodeExe = path.join(npmDir, 'node.exe');
        const cliFromDir = findNpmCliIn(npmDir);
        if (cliFromDir && fs.existsSync(nodeExe)) {
          return { command: nodeExe, argsPrefix: [cliFromDir], shell: false };
        }
      }
      return {
        command: npmPath,
        argsPrefix: [],
        shell: isWin && npmPath.toLowerCase().endsWith('.cmd'),
      };
    }
  } catch {}

  console.error('[runtime-installer] WARN: no npm-cli found in any tier — falling back to bare npm');
  return { command: isWin ? 'npm.cmd' : 'npm', argsPrefix: [], shell: isWin };
}

function killOrphanVendorNodeProcesses() {
  if (process.platform !== 'win32') return;
  try {
    const nodeHome = getRuntimeNodeHomeDir();
    const nodeBin = path.join(nodeHome, 'node.exe');
    if (!fs.existsSync(nodeBin)) return;
    const escaped = nodeBin.replace(/\\/g, '\\\\');
    const out = execSync(
      `wmic process where "ExecutablePath='${escaped}'" get ProcessId /format:list`,
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'] }
    );
    const pids = out.match(/ProcessId=(\d+)/g)?.map(m => m.split('=')[1]) || [];
    const myPid = String(process.pid);
    for (const pid of pids) {
      if (pid === myPid) continue;
      try { execSync(`taskkill /pid ${pid} /f /t`, { stdio: 'ignore', timeout: 5000 }); } catch {}
    }
    if (pids.length) console.log('[runtime-installer] killed orphan vendor node process(es):', pids.filter(p => p !== myPid).join(', '));
  } catch {}
}

function killOrphan9RouterProcesses() {
  if (process.platform !== 'win32') return;
  try {
    const { execSync } = require('child_process');
    const vendorDir = getRuntimeNodeModulesDir();
    if (!vendorDir) return;
    const nrDir = path.join(vendorDir, '9router');
    if (!fs.existsSync(nrDir)) return;
    const out = execSync('wmic process where "CommandLine like \'%9router%\'" get ProcessId /format:list', {
      encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore']
    });
    const pids = out.match(/ProcessId=(\d+)/g)?.map(m => m.split('=')[1]) || [];
    for (const pid of pids) {
      try { execSync(`taskkill /pid ${pid} /f /t`, { stdio: 'ignore', timeout: 5000 }); } catch {}
    }
    if (pids.length) console.log('[runtime-installer] killed orphan 9router process(es):', pids.join(', '));
  } catch {}
}

async function installNpmPackages(versions, onProgress) {
  console.log('[runtime-installer] Installing npm packages...');

  killOrphan9RouterProcesses();

  const nodeBin = await getWorkingNodeBin();
  if (!nodeBin) {
    throw new Error('No Node.js found to install npm packages');
  }

  const vendorDir = getRuntimeNodeDir();
  const nodeModulesDir = getRuntimeNodeModulesDir();
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.mkdirSync(nodeModulesDir, { recursive: true });

  // Create a temporary package.json to define the local package scope
  const pkgJsonPath = path.join(vendorDir, 'package.json');
  let pkgJson = { name: 'modoro-runtime', version: '1.0.0', private: true };
  try {
    if (fs.existsSync(pkgJsonPath)) {
      pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    }
  } catch {}
  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2));

  // Determine which packages need installing
  const toInstall = [];
  for (const pkg of PACKAGES) {
    const version = versions[pkg.name] || pkg.version;
    const existingPath = path.join(nodeModulesDir, pkg.name, 'package.json');
    try {
      if (fs.existsSync(existingPath)) {
        const existing = JSON.parse(fs.readFileSync(existingPath, 'utf8'));
        if (existing.version === version) {
          console.log('[runtime-installer]', pkg.name, 'already at', version, '- skipping');
          continue;
        }
      }
    } catch {}
    toInstall.push({ name: pkg.name, version, spec: `${pkg.name}@${version}` });
  }

  if (toInstall.length === 0) {
    if (onProgress) onProgress({ step: 'packages', percent: 80, message: 'Packages đã có sẵn' });
    return await getInstalledPackages();
  }

  if (onProgress) {
    onProgress({
      step: 'packages',
      percent: 10,
      message: `Đang cài ${toInstall.map(p => p.name).join(', ')}...`,
      subStep: toInstall.map(p => p.spec).join(' '),
    });
  }

  // Install ALL packages in a single npm command to prevent npm 10+ from
  // pruning previously installed packages during sequential installs.
  // Use spawn (not execFile) to stream stdout and report progress to splash.
  const npmInstallOp = async () => {
    // Clean stale git-clone temp dirs from npm cache — a previous failed install
    // can leave empty dirs that cause ENOENT on package.json in the next attempt.
    try {
      const npmCacheTmp = path.join(require('os').homedir(), '.npm', '_cacache', 'tmp');
      if (fs.existsSync(npmCacheTmp)) {
        const stale = fs.readdirSync(npmCacheTmp).filter(d => d.startsWith('git-clone'));
        for (const d of stale) {
          fs.rmSync(path.join(npmCacheTmp, d), { recursive: true, force: true });
        }
        if (stale.length) console.log('[runtime-installer] cleaned', stale.length, 'stale git-clone dirs from npm cache');
      }
    } catch (e) { console.warn('[runtime-installer] npm cache cleanup failed (non-fatal):', e.message); }
    const npm = getRuntimeNpmCommand(nodeBin);
    const specs = toInstall.map(p => p.spec);
    console.log('[runtime-installer] npm install (batch):', specs.join(' '));
    await new Promise((resolve, reject) => {
      const child = spawn(
        npm.command,
        [...npm.argsPrefix, 'install', '--prefix', vendorDir, ...specs, '--save', '--no-fund', '--no-audit', '--ignore-scripts', '--omit=optional'],
        {
          encoding: 'utf-8', stdio: 'pipe', shell: npm.shell,
          env: buildEnvWithGitPath({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/echo', npm_config_node_gyp: 'echo' }),
        }
      );
      let settled = false;
      const settle = (fn, arg) => { if (settled) return; settled = true; clearInterval(npmTimer); clearTimeout(killTimer); clearInterval(activityWd); fn(arg); };
      let stderr = '';
      let lastSubStep = '';
      let lastActivityAt = Date.now();
      const ACTIVITY_TIMEOUT_MS = 90000;
      // spawn() ignores the timeout option — implement manually via kill timer
      const killTimer = setTimeout(() => {
        console.error('[runtime-installer] npm install timed out after ' + (NPM_INSTALL_TIMEOUT_MS / 1000) + 's — killing');
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000).unref();
        settle(reject, new Error('npm install timed out after ' + (NPM_INSTALL_TIMEOUT_MS / 1000) + 's'));
      }, NPM_INSTALL_TIMEOUT_MS);
      killTimer.unref();
      // Activity watchdog: kill if npm produces no output for 90s (likely hung)
      const activityWd = setInterval(() => {
        if (Date.now() - lastActivityAt > ACTIVITY_TIMEOUT_MS) {
          console.error('[runtime-installer] npm install silent for ' + (ACTIVITY_TIMEOUT_MS / 1000) + 's — killing (hung?)');
          console.error('[runtime-installer] last npm stderr:', stderr.slice(-300));
          try { child.kill('SIGTERM'); } catch {}
          setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000).unref();
          settle(reject, new Error('npm install hung — no output for ' + (ACTIVITY_TIMEOUT_MS / 1000) + 's'));
        }
      }, 10000);
      activityWd.unref();
      // Parse npm output lines for package-level progress
      const parseNpmLine = (line) => {
        const trimmed = String(line).trim();
        if (!trimmed) return;
        lastActivityAt = Date.now();
        // npm outputs "added N packages in Xs" at the end
        const addedMatch = trimmed.match(/added (\d+) packages? in/i);
        if (addedMatch) {
          lastSubStep = `${addedMatch[1]} packages installed`;
          if (onProgress) onProgress({ step: 'packages', percent: 75, message: `Hoàn tất ${lastSubStep}`, subStep: lastSubStep });
          return;
        }
        // npm progress: "npm warn", "npm http fetch GET", package names
        const httpMatch = trimmed.match(/http fetch (?:GET|POST)\s+\d+\s+(https?:\/\/[^\s]+)/i);
        if (httpMatch) {
          const pkgUrl = httpMatch[1];
          const pkgName = pkgUrl.split('/').pop()?.replace(/\.tgz$/, '') || '';
          if (pkgName) {
            lastSubStep = pkgName;
            if (onProgress) onProgress({ step: 'packages', message: `Đang tải ${pkgName}`, subStep: pkgName });
          }
          return;
        }
      };
      child.stdout?.on('data', (d) => { lastActivityAt = Date.now(); String(d).split('\n').forEach(parseNpmLine); });
      child.stderr?.on('data', (d) => {
        lastActivityAt = Date.now();
        const chunk = String(d);
        stderr += chunk;
        chunk.split('\n').forEach(parseNpmLine);
      });
      // Heartbeat so splash doesn't look stuck during long npm resolves
      let npmTick = 10;
      const npmTimer = setInterval(() => {
        npmTick = Math.min(npmTick + 2, 70);
        if (onProgress) {
          const elapsed = Math.round((Date.now() - npmStartTime) / 1000);
          const msg = lastSubStep ? `Đang cài: ${lastSubStep}` : `Đang cài packages... (${elapsed}s)`;
          onProgress({ step: 'packages', percent: npmTick, message: msg, subStep: lastSubStep || `${elapsed}s` });
        }
      }, 3000);
      const npmStartTime = Date.now();
      child.on('error', (e) => { settle(reject, e); });
      child.on('close', (code) => {
        if (code === 0) settle(resolve);
        else settle(reject, new Error(`npm install exited ${code}: ${stderr.slice(-500)}`));
      });
    });
  };

  let lastError = null;
  let installed = false;

  // If npm fails with git-related error, try downloading MinGit (Windows) or
  // log diagnostic (Mac — no portable git available, but shim is neutralized).
  const maybeFixGit = async (error) => {
    const msg = String(error?.message || '');
    const isGitError = msg.includes('spawn git') ||
      (msg.includes('git') && msg.includes('ENOENT')) ||
      msg.includes('xcode-select') ||
      msg.includes('git-clone') ||
      msg.includes('.git');
    if (isGitError) {
      console.log('[runtime-installer] npm failed with git-related error:', msg.slice(-200));
      if (process.platform === 'win32') {
        if (onProgress) onProgress({ step: 'packages', message: 'Đang tải Git (cần cho npm)...', subStep: 'MinGit' });
        await ensurePortableGit(onProgress);
      } else if (process.platform === 'darwin') {
        if (!macHasXcodeCLT()) {
          await ensureXcodeCLT(onProgress);
        } else {
          forceNeutralizeGitShim();
        }
      }
    }
  };

  try {
    if (withRetry) {
      await withRetry(npmInstallOp, {
        maxRetries: 2,
        baseDelay: 5000,
        maxDelay: 30000,
        onRetry: async ({ attempt, maxRetries, error, delay }) => {
          console.log(`[runtime-installer] Retry ${attempt}/${maxRetries} for npm install after ${delay}ms: ${error?.message}`);
          if (error?.message?.includes('EBUSY')) killOrphan9RouterProcesses();
          await maybeFixGit(error);
          if (onProgress) {
            onProgress({ step: 'packages', message: `Đang thử lại (lần ${attempt + 1})...`, subStep: 'retry' });
          }
        },
      });
      installed = true;
    } else {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          if (lastError?.message?.includes('EBUSY')) killOrphan9RouterProcesses();
          await maybeFixGit(lastError);
          await new Promise(r => setTimeout(r, 5000 * attempt));
          console.log('[runtime-installer] Retry', attempt + 1, 'for npm install');
        }
        try {
          await npmInstallOp();
          installed = true;
          break;
        } catch (e) {
          lastError = e;
        }
      }
    }
  } catch (e) {
    lastError = e;
  }

  if (!installed) {
    const hint = getInstallErrorHint(lastError);
    const hintMsg = hint ? '\n' + hint : '';
    throw new Error(`Không cài được packages: ${lastError?.message || 'Unknown error'}${hintMsg}`);
  }

  if (onProgress) {
    onProgress({ step: 'packages', percent: 80, message: 'Hoàn tất cài đặt packages' });
  }

  // Verify all installations
  const result = await getInstalledPackages();
  console.log('[runtime-installer] Installed packages:', result);

  for (const pkg of PACKAGES) {
    const expected = versions[pkg.name] || pkg.version;
    if (!result[pkg.name] || result[pkg.name] !== expected) {
      throw new Error(`Verification failed for ${pkg.name}: expected ${expected}, got ${result[pkg.name] || 'not installed'}`);
    }
  }

  // --ignore-scripts skips postinstall (avoids node-gyp/Xcode CLT requirement).
  // Manually fetch prebuilt native binaries for packages that need them.
  await fixRuntimeNativeModules(nodeBin, nodeModulesDir, onProgress);

  return result;
}

async function fixRuntimeNativeModules(nodeBin, nodeModulesDir, onProgress) {
  // 9router ships better-sqlite3 which needs a platform-specific .node binary.
  // With --ignore-scripts, its install script (prebuild-install || node-gyp)
  // didn't run. prebuild-install is NOT bundled in 9router's package, so we
  // install it temporarily, run it, then clean up.
  const bsqlDir = path.join(nodeModulesDir, '9router', 'app', 'node_modules', 'better-sqlite3');
  if (!fs.existsSync(bsqlDir)) return;

  const bsqlBin = path.join(bsqlDir, 'build', 'Release', 'better_sqlite3.node');
  if (fs.existsSync(bsqlBin)) {
    console.log('[runtime-installer] better-sqlite3 native binary already present');
    return;
  }

  if (onProgress) onProgress({ step: 'packages', percent: 82, message: 'Tải native module cho 9router...' });

  let nodeVer;
  try {
    nodeVer = require('child_process')
      .execFileSync(nodeBin, ['--version'], { encoding: 'utf-8', timeout: 5000 })
      .trim().replace(/^v/, '');
  } catch { return; }

  const arch = process.arch;
  const platform = process.platform;
  console.log(`[runtime-installer] fetching better-sqlite3 prebuilt for node-${nodeVer} ${platform}-${arch}`);

  // Install prebuild-install temporarily into better-sqlite3's own node_modules
  const tmpNm = path.join(bsqlDir, 'node_modules');
  const npm = getRuntimeNpmCommand(nodeBin);
  try {
    const installArgs = [...npm.argsPrefix, 'install', '--prefix', bsqlDir,
      'prebuild-install', '--no-save', '--no-fund', '--no-audit', '--ignore-scripts'];
    require('child_process').execFileSync(npm.command, installArgs, {
      timeout: 60000, encoding: 'utf-8', stdio: 'pipe', shell: npm.shell,
      env: buildEnvWithGitPath({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/echo', npm_config_node_gyp: 'echo' }),
    });
  } catch (e) {
    console.warn('[runtime-installer] failed to install prebuild-install:', e.message);
  }

  // Run prebuild-install to fetch the prebuilt binary
  const prebuildJs = path.join(tmpNm, 'prebuild-install', 'bin.js');
  if (fs.existsSync(prebuildJs)) {
    try {
      require('child_process').execFileSync(nodeBin,
        [prebuildJs, '-r', 'node', '-t', nodeVer, '--arch', arch],
        { cwd: bsqlDir, timeout: 60000, shell: false,
          env: buildEnvWithGitPath({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/echo', npm_config_arch: arch, npm_config_node_gyp: 'echo' }) });
      if (fs.existsSync(bsqlBin)) {
        console.log('[runtime-installer] ✓ better-sqlite3 prebuilt fetched');
        try { fs.rmSync(tmpNm, { recursive: true, force: true }); } catch {}
        return;
      }
    } catch (e) {
      console.warn('[runtime-installer] prebuild-install run failed:', e.message);
    }
  }

  // Cleanup temp
  try { fs.rmSync(tmpNm, { recursive: true, force: true }); } catch {}
  console.warn('[runtime-installer] could not fetch better-sqlite3 prebuilt — 9router autoFix will retry at startup');
}

// =====================================================================
// Utility Functions
// =====================================================================

const copyDirRecursive = _copyDir;

// =====================================================================
// modoro-zalo Plugin Bundling
// =====================================================================

function getBundledModoroZaloPath() {
  // In packaged app: resources/modoro-zalo/
  // In dev mode: electron/packages/modoro-zalo/
  if (app && app.isPackaged) {
    return path.join(process.resourcesPath, 'modoro-zalo');
  }
  return path.join(__dirname, '..', 'packages', 'modoro-zalo');
}

async function ensureModoroZaloPlugin(onProgress) {
  console.log('[runtime-installer] Ensuring modoro-zalo plugin...');

  if (onProgress) onProgress({ step: 'plugin', percent: 0, message: 'Đang cài plugin Zalo...', subStep: 'modoro-zalo' });

  const srcPath = getBundledModoroZaloPath();
  const destPath = path.join(getRuntimeNodeModulesDir(), 'modoro-zalo');

  if (!fs.existsSync(srcPath)) {
    throw new Error(`modoro-zalo plugin not found at ${srcPath}`);
  }

  // Copy plugin to node_modules
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  try {
    copyDirRecursive(srcPath, destPath);
  } catch (e) {
    throw new Error(`Không copy được modoro-zalo plugin: ${e.message}`);
  }

  // Verify
  const pluginManifest = path.join(destPath, 'openclaw.plugin.json');
  if (!fs.existsSync(pluginManifest)) {
    throw new Error(`modoro-zalo plugin manifest not found at ${pluginManifest}`);
  }

  if (onProgress) onProgress({ step: 'plugin', percent: 100, message: 'Plugin Zalo đã sẵn sàng' });

  console.log('[runtime-installer] modoro-zalo plugin installed at', destPath);
  return destPath;
}

function checkModoroZaloReady() {
  const locations = [];
  try {
    locations.push(path.join(getRuntimeNodeModulesDir(), 'modoro-zalo', 'openclaw.plugin.json'));
  } catch {}

  for (const manifest of locations) {
    try {
      if (fs.existsSync(manifest) && fs.statSync(manifest).size > 0) {
        return true;
      }
    } catch {}
  }
  return false;
}

// =====================================================================
// Installation Check & Status
// =====================================================================

async function checkInstallation() {
  const nodeStatus = await detectNodeInstallation();
  const installedPackages = await getInstalledPackages();
  const runtimeVersion = getInstalledVersion();
  const zaloReady = checkModoroZaloReady();

  let layoutVersionOk = true;
  try {
    const lvPath = path.join(getUserDataDir(), 'layout-version.txt');
    if (fs.existsSync(lvPath)) {
      layoutVersionOk = fs.readFileSync(lvPath, 'utf8').trim() === LAYOUT_VERSION;
    } else {
      layoutVersionOk = true;
    }
  } catch { layoutVersionOk = true; }

  const allPackagesInstalled = PACKAGES.every(pkg => {
    const installed = installedPackages[pkg.name];
    if (!installed) return false;
    return installed === pkg.version;
  });

  const filesReady = nodeStatus.satisfiesMin && allPackagesInstalled && zaloReady && layoutVersionOk;
  const ready = filesReady && runtimeVersion === '2.4.0' && layoutVersionOk;
  const gogReady = await checkGogCliReady();

  return {
    ready,
    filesReady,
    runtimeVersion,
    node: nodeStatus,
    packages: installedPackages,
    missingPackages: PACKAGES.filter(pkg => {
      return (installedPackages[pkg.name] || '') !== pkg.version;
    }).map(p => p.name),
    needsNodeInstall: !nodeStatus.satisfiesMin,
    needsPackageInstall: !allPackagesInstalled,
    layoutVersionOk,
    needsLayoutMigration: !layoutVersionOk,
    modoroZaloReady: zaloReady,
    needsModoroZaloInstall: !zaloReady,
    // gogcli is optional — always return true, never block boot
    gogReady,
    needsGogInstall: !gogReady,
  };
}

// =====================================================================
// Main Installation Flow
// =====================================================================

async function runInstallation({ onProgress } = {}) {
  if (_installInProgress) {
    throw new Error('Installation already in progress');
  }
  _installInProgress = true;

  try {
    if (onProgress) onProgress({ step: 'check', percent: 0, message: 'Đang kiểm tra hệ thống...' });

    // Check current status
    const status = await checkInstallation();

    if (status.ready) {
      if (onProgress) onProgress({ step: 'complete', percent: 100, message: 'Đã sẵn sàng!' });
      return status;
    }

    if (status.filesReady && status.runtimeVersion !== '2.4.0') {
      writeInstalledVersion('2.4.0');
      writeLayoutVersion();
      _installStatus = await checkInstallation();
      if (onProgress) onProgress({ step: 'complete', percent: 100, message: 'Đã sẵn sàng!' });
      return _installStatus;
    }

    // Layout migration: if LAYOUT_VERSION changed, trigger a clean re-install.
    if (status.needsLayoutMigration) {
      console.log('[boot] Runtime layout version mismatch — forcing re-install...');
      // Clean old node_modules but preserve user data
      try {
        const nmDir = getRuntimeNodeModulesDir();
        if (fs.existsSync(nmDir)) {
          fs.rmSync(nmDir, { recursive: true, force: true });
          console.log('[boot] Cleared old node_modules for layout migration');
        }
      } catch (e) {
        console.warn('[boot] Failed to clear node_modules:', e.message);
      }
    }

    // Step 1: Install Node.js if needed
    if (status.needsNodeInstall) {
      const stableVersion = SHARED_VERSIONS.node;
      await installNode(stableVersion, onProgress);
    } else {
      if (onProgress) onProgress({ step: 'node', percent: 100, message: 'Node.js đã có sẵn' });
    }
    if (onProgress) onProgress({ step: 'node-done' });

    // Step 1.5: Ensure portable git on Windows (non-fatal)
    await ensurePortableGit(onProgress);

    // Step 1.6: Ensure Xcode CLT on Mac (required for npm git dependencies)
    if (process.platform === 'darwin' && !macHasXcodeCLT()) {
      await ensureXcodeCLT(onProgress);
    }

    // Step 2: Install npm packages
    if (status.needsPackageInstall) {
      await installNpmPackages({}, onProgress);
    } else {
      if (onProgress) onProgress({ step: 'packages', percent: 80, message: 'Packages đã có sẵn' });
    }
    if (onProgress) onProgress({ step: 'packages-done' });

    // Step 3: Ensure modoro-zalo plugin
    if (status.needsModoroZaloInstall) {
      await ensureModoroZaloPlugin(onProgress);
    } else {
      if (onProgress) onProgress({ step: 'plugin', percent: 100, message: 'Plugin Zalo đã có sẵn' });
    }
    if (onProgress) onProgress({ step: 'plugin-done' });

    // Step 4: Install gogcli (Google Workspace CLI) — non-fatal, Google features degrade gracefully
    if (status.needsGogInstall) {
      try {
        await ensureGogCli(onProgress);
      } catch (e) {
        console.warn('[runtime-installer] gogcli install failed (non-fatal):', e.message);
        if (onProgress) onProgress({ step: 'gog', percent: 100, message: 'gogcli — bỏ qua (sẽ tải sau)' });
      }
    } else {
      if (onProgress) onProgress({ step: 'gog', percent: 100, message: 'gogcli đã có sẵn' });
    }
    if (onProgress) onProgress({ step: 'gog-done' });

    // Step 5: Download embedding model (non-fatal — grep fallback exists)
    if (isModelDownloaded && downloadModels) {
      if (!isModelDownloaded()) {
        try {
          if (onProgress) onProgress({ step: 'model', percent: 0, message: 'Đang tải mô hình AI...' });
          await downloadModels({
            onProgress: (p) => {
              if (onProgress) onProgress({ step: 'model', percent: p.percent, message: p.message });
            },
          });
          if (onProgress) onProgress({ step: 'model', percent: 100, message: 'Mô hình AI đã sẵn sàng' });
        } catch (e) {
          console.warn('[runtime-installer] Model download failed (non-fatal):', e.message);
          if (onProgress) onProgress({ step: 'model', percent: 100, message: 'Mô hình AI — bỏ qua (sẽ tải sau)' });
        }
      } else {
        if (onProgress) onProgress({ step: 'model', percent: 100, message: 'Mô hình AI đã có sẵn' });
      }
    }
    if (onProgress) onProgress({ step: 'model-done' });

    // Step 6: Write version + layout markers
    writeInstalledVersion('2.4.0');
    writeLayoutVersion();

    if (onProgress) onProgress({ step: 'complete', percent: 100, message: 'Hoàn tất cài đặt!' });

    _installStatus = await checkInstallation();
    return _installStatus;

  } finally {
    _installInProgress = false;
  }
}

// =====================================================================
// Runtime Path Helpers (for boot.js compatibility)
// =====================================================================

// Alias for getRuntimeNodeModulesDir - where npm packages are installed
const getRuntimeVendorDir = getRuntimeNodeModulesDir;

function findRuntimeNodeBin() {
  return getRuntimeNodeBinPath();
}

function findRuntimeOpenClawCliJs() {
  const mjs = path.join(getRuntimeNodeModulesDir(), 'openclaw', 'openclaw.mjs');
  if (fs.existsSync(mjs)) return mjs;
  return null;
}

// =====================================================================
// gogcli (Google Workspace CLI) Installation
// =====================================================================

async function checkGogCliReady() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return true;
  const isWin = process.platform === 'win32';
  const gogDir = path.join(getRuntimeNodeDir(), 'gog');
  const gogBin = isWin ? path.join(gogDir, 'gog.exe') : path.join(gogDir, 'gog');
  const stampFile = path.join(gogDir, '.target');
  const stampValue = `${GOG_VERSION}-${process.platform}-${process.arch}`;
  if (!fs.existsSync(gogBin) || !fs.existsSync(stampFile)) return false;
  try {
    if (fs.readFileSync(stampFile, 'utf8').trim() !== stampValue) return false;
    await execFilePromise(gogBin, ['version'], { timeout: 10000 });
    return true;
  } catch { return false; }
}

async function ensureGogCli(onProgress) {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  if (!isWin && !isMac) return; // Linux: skip for now

  if (onProgress) onProgress({ step: 'gog', percent: 0, message: 'Đang kiểm tra gogcli...', subStep: 'Google Workspace CLI' });

  const gogDir = path.join(getRuntimeNodeDir(), 'gog');
  const gogBin = isWin
    ? path.join(gogDir, 'gog.exe')
    : path.join(gogDir, 'gog');
  const stampFile = path.join(gogDir, '.target');
  const stampValue = `${GOG_VERSION}-${process.platform}-${process.arch}`;

  if (await checkGogCliReady()) {
    console.log('[runtime-installer] gogcli already installed:', stampValue);
    if (onProgress) onProgress({ step: 'gog', percent: 100, message: 'gogcli đã sẵn sàng' });
    return;
  }

  console.log('[runtime-installer] Installing gogcli', GOG_VERSION, '...');

  // Step 1: Try copy from bundled resources (resources/vendor/gog/)
  let installed = false;
  const bundledGog = getBundledGogPath();
  if (bundledGog && fs.existsSync(bundledGog)) {
    try {
      fs.mkdirSync(gogDir, { recursive: true });
      const bundledDir = path.dirname(bundledGog);
      const bundledFiles = fs.readdirSync(bundledDir);
      for (const f of bundledFiles) {
        const src = path.join(bundledDir, f);
        const dst = path.join(gogDir, f);
        if (fs.statSync(src).isFile()) {
          fs.copyFileSync(src, dst);
        }
      }
      if (fs.existsSync(gogBin)) {
        if (!isWin) try { fs.chmodSync(gogBin, 0o755); } catch {}
        fs.writeFileSync(stampFile, stampValue + '\n');
        if (await checkGogCliReady()) {
          console.log('[runtime-installer] gogcli copied from bundled:', gogBin);
          installed = true;
        } else {
          console.warn('[runtime-installer] bundled gogcli failed readiness check:', gogBin);
        }
      }
    } catch (e) {
      console.warn('[runtime-installer] Could not copy bundled gogcli:', e.message);
    }
  }

  // Step 2: Fallback download from GitHub
  if (!installed) {
    await installGogCliDownload(gogDir, gogBin, isWin, stampFile, stampValue, onProgress);
  }

  if (!(await checkGogCliReady())) {
    throw new Error('gogcli installed but failed readiness check');
  }

  if (onProgress) onProgress({ step: 'gog', percent: 100, message: 'gogcli đã sẵn sàng' });
}

function getBundledGogPath() {
  if (!app || !app.isPackaged) return null;
  const isWin = process.platform === 'win32';
  try {
    const vendorGog = path.join(app.getPath('userData'), 'vendor', 'gog', isWin ? 'gog.exe' : 'gog');
    if (fs.existsSync(vendorGog)) return vendorGog;
  } catch {}
  return null;
}

async function installGogCliDownload(gogDir, gogBin, isWin, stampFile, stampValue, onProgress) {
  const archMap = { x64: 'amd64', arm64: 'arm64' };
  const platMap = { win32: 'windows', darwin: 'darwin' };
  const ver = GOG_VERSION.replace(/^v/, '');
  const arch = process.arch === 'x64' ? 'x64' : 'arm64';
  const platform = platMap[process.platform];
  const ext = isWin ? '.zip' : '.tar.gz';
  const assetName = `gogcli_${ver}_${platform}_${archMap[arch]}${ext}`;
  const url = `https://github.com/steipete/gogcli/releases/download/${GOG_VERSION}/${assetName}`;

  const gogProgress = (p) => {
    if (onProgress) {
      const sizeMB = p.total > 0 ? (p.total / 1024 / 1024).toFixed(0) : '';
      const dlMB = p.downloaded > 0 ? (p.downloaded / 1024 / 1024).toFixed(1) : '';
      const sizeStr = sizeMB ? ` (${dlMB}/${sizeMB} MB)` : '';
      onProgress({ step: 'gog', percent: p.percent * 0.7, message: `Đang tải gogcli${sizeStr}`, subStep: assetName });
    }
  };

  let downloaded = false;
  let lastError = null;
  let tmp = path.join(require('os').tmpdir(), `gogcli-dl-${Date.now()}${ext}`);

  try {
    await downloadFile(url, tmp, gogProgress);
    verifyDownloadedGogArchive(tmp);
    downloaded = true;
  } catch (e) {
    lastError = e;
    const altName = `gogcli_${ver}_${platMap[process.platform]}_${arch}.${isWin ? 'zip' : 'tar.gz'}`;
    const altUrl = `https://github.com/steipete/gogcli/releases/download/${GOG_VERSION}/${altName}`;
    try {
      const tmp2 = path.join(require('os').tmpdir(), `gogcli-alt-${Date.now()}.${isWin ? 'zip' : 'tar.gz'}`);
      await downloadFile(altUrl, tmp2, gogProgress);
      verifyDownloadedGogArchive(tmp2);
      tmp = tmp2;
      downloaded = true;
    } catch (e2) {
      lastError = e2;
    }
  }

  if (!downloaded) {
    throw new Error(`Không tải được gogcli. Kiểm tra kết nối mạng. (${lastError?.message || 'unknown'})`);
  }

  if (onProgress) onProgress({ step: 'gog', percent: 75, message: 'Đang giải nén gogcli...', subStep: 'Extracting' });
  fs.mkdirSync(gogDir, { recursive: true });
  const extractDir = path.join(gogDir, 'temp-' + Date.now());
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    // Extract
    if (isWin) {
      await new Promise((resolve, reject) => {
        const ps = spawn('powershell', [
          '-NoProfile', '-Command',
          `Expand-Archive -Path '${tmp.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`
        ], { stdio: 'pipe' });
        let stderr = '';
        ps.stderr?.on('data', d => { stderr += String(d); });
        ps.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Extract failed (${code}): ${stderr}`)));
        ps.on('error', reject);
      });
    } else {
      await new Promise((resolve, reject) => {
        const t = spawn('tar', ['-xzf', tmp, '-C', extractDir], { stdio: 'pipe' });
        t.on('close', (code) => code === 0 ? resolve() : reject(new Error(`tar failed: ${code}`)));
        t.on('error', reject);
      });
    }

    // Find gog binary
    const entries = fs.readdirSync(extractDir);
    let foundBin = null;
    for (const entry of entries) {
      const entryPath = path.join(extractDir, entry);
      const checkPath = isWin
        ? path.join(entryPath, 'gog.exe')
        : path.join(entryPath, 'gog');
      if (fs.existsSync(checkPath)) { foundBin = checkPath; break; }
    }
    if (!foundBin) {
      // Fallback: check top-level
      const topBin = path.join(extractDir, isWin ? 'gog.exe' : 'gog');
      if (fs.existsSync(topBin)) foundBin = topBin;
    }

    if (!foundBin) {
      throw new Error('Không tìm thấy gog binary sau khi giải nén. Thử tải lại.');
    }

    // Copy to gogDir
    fs.copyFileSync(foundBin, gogBin);
    if (!isWin) try { fs.chmodSync(gogBin, 0o755); } catch {}
    fs.writeFileSync(stampFile, stampValue + '\n');
    console.log('[runtime-installer] gogcli installed at', gogBin);
  } finally {
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// =====================================================================
// Cleanup Old Bundled Files (Migration helper)
// =====================================================================

async function cleanupOldBundledFiles() {
  const userData = getUserDataDir();
  const oldFiles = [
    path.join(userData, 'vendor-bundle.tar'),
    path.join(userData, 'vendor-meta.json'),
    path.join(userData, 'vendor-version.txt'),
  ];

  for (const file of oldFiles) {
    try {
      if (fs.existsSync(file)) {
        if (fs.statSync(file).isDirectory()) {
          fs.rmSync(file, { recursive: true, force: true });
        } else {
          fs.unlinkSync(file);
        }
        console.log('[runtime-installer] Removed old file:', file);
      }
    } catch (e) {
      console.warn('[runtime-installer] Failed to remove old file:', file, e.message);
    }
  }

  // Also clean up stale vendor dirs
  try {
    const entries = fs.readdirSync(userData);
    for (const e of entries) {
      if (e.startsWith('vendor.stale-')) {
        fs.rmSync(path.join(userData, e), { recursive: true, force: true });
        console.log('[runtime-installer] Removed stale vendor:', e);
      }
    }
  } catch {}
}

// =====================================================================
// Module Exports
// =====================================================================
module.exports = {
  // Core functions
  checkInstallation,
  runInstallation,
  detectNodeInstallation,
  installNode,
  getInstalledPackages,
  installNpmPackages,
  ensureModoroZaloPlugin,
  ensureGogCli,
  // cleanupBundledTarIfInstalled removed — pure runtime, no bundled tar to clean

  // Path helpers
  getUserDataDir,
  getRuntimeNodeDir,
  getRuntimeNodeHomeDir,
  getRuntimeNodeModulesDir,
  getRuntimeNodeBinPath,
  getRuntimeNpmCommand,
  isNodeInstallComplete,
  findNpmCliIn,
  getRuntimeVendorDir,
  findRuntimeNodeBin,
  findRuntimeOpenClawCliJs,

  // Git helpers
  findGitBin,
  ensurePortableGit,

  // Version helpers
  getInstalledVersion,
  writeInstalledVersion,
  compareVersions,
  satisfiesMinVersion,

  // Migration
  cleanupOldBundledFiles,

  // Constants
  PINNED_VERSIONS,
  MIN_NODE_VERSION,
  PACKAGES,
  GOG_VERSION,
};
