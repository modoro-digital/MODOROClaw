const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
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

// Writable workspace — in dev this is the source dir, in packaged it's userData
// Bot and Electron both use this path for all file I/O (AGENTS.md, schedules.json, etc.)
let _workspaceCached = null;
function getWorkspace() {
  if (_workspaceCached) return _workspaceCached;
  try {
    fs.accessSync(resourceDir, fs.constants.W_OK);
    _workspaceCached = resourceDir;
  } catch {
    _workspaceCached = userDataDir;
  }
  return _workspaceCached;
}
function invalidateWorkspaceCache() { _workspaceCached = null; }

// Default schedules (also used as template when seeding fresh install)
const DEFAULT_SCHEDULES_JSON = [
  { id: 'morning', label: 'Báo cáo sáng', time: '07:30', enabled: true, icon: '☀️', description: 'Doanh thu, lịch họp, việc cần xử lý' },
  { id: 'evening', label: 'Tóm tắt cuối ngày', time: '21:00', enabled: true, icon: '🌙', description: 'Kết quả ngày, vấn đề tồn đọng' },
  { id: 'heartbeat', label: 'Kiểm tra tự động', time: 'Mỗi 30 phút', enabled: true, icon: '💓', description: 'Gateway, kênh liên lạc' },
  { id: 'meditation', label: 'Tối ưu ban đêm', time: '01:00', enabled: true, icon: '🧠', description: 'Bot tự review bài học, tối ưu bộ nhớ' },
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
function getBundledVendorDir() {
  try {
    if (app && app.isPackaged) {
      const v = path.join(process.resourcesPath, 'vendor');
      if (fs.existsSync(v)) return v;
    }
  } catch {}
  return null;
}
function getBundledNodeBin() {
  const v = getBundledVendorDir();
  if (!v) return null;
  const isWin = process.platform === 'win32';
  const candidate = path.join(v, 'node', 'bin', isWin ? 'node.exe' : 'node');
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
  const binDir = path.join(v, 'node', 'bin');
  if (!fs.existsSync(binDir)) return;
  const sep = process.platform === 'win32' ? ';' : ':';
  const cur = process.env.PATH || '';
  if (cur.split(sep).some(p => p === binDir)) return; // already prepended
  process.env.PATH = binDir + sep + cur;
  console.log('[vendor] PATH prepended with bundled Node:', binDir);
}

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

  // Only seed from bundle if workspace differs from template source (packaged)
  const templateRoot = getWorkspaceTemplateRoot();
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

async function findOpenClawBin() {
  if (_cachedBin) return _cachedBin;

  const isWin = process.platform === 'win32';
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

// Parse openclaw stderr for "Unrecognized key" errors and return all (path, key)
// pairs we can heal. openclaw's error format (from validator output):
//   - agents.defaults: Unrecognized key: "blockStreaming"
//   - channels.telegram.foo: Unrecognized key: "bar"
// Returns an array of { path: string[], key: string } objects.
function parseUnrecognizedKeyErrors(stderr) {
  const out = [];
  if (!stderr) return out;
  // Match: "<dotted.path>: Unrecognized key: \"<key>\""
  const re = /([\w.]+):\s*Unrecognized key:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(stderr)) !== null) {
    const dottedPath = m[1];
    const key = m[2];
    out.push({ path: dottedPath.split('.'), key });
  }
  return out;
}

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

    // --- Dynamic removals from openclaw's own error message ---
    if (errStderr) {
      const parsed = parseUnrecognizedKeyErrors(errStderr);
      for (const { path: keyPath, key } of parsed) {
        // Walk to the parent object
        let parent = config;
        let valid = true;
        for (const segment of keyPath) {
          if (parent && typeof parent === 'object' && segment in parent) {
            parent = parent[segment];
          } else {
            valid = false;
            break;
          }
        }
        if (valid && parent && typeof parent === 'object' && key in parent) {
          delete parent[key];
          removed.push(`${keyPath.join('.')}.${key}`);
          changed = true;
          console.log(`[heal-inline] removed deprecated key from openclaw.json: ${keyPath.join('.')}.${key}`);
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
        userMsg = `⚠️ *Cron "${niceLabel}" KHÔNG chạy được — môi trường thiếu Node*\n\nKhông tìm thấy \`node\` hoặc \`openclaw.mjs\` trên máy. Cron prompt nhiều dòng KHÔNG thể chạy qua \`openclaw.cmd\` (cmd.exe sẽ truncate).\n\nCần cài Node.js và đảm bảo \`node\` chạy được từ terminal: \`node -v\`. Sau đó restart Modoro Claw.`;
      } else if (lastErr.toLowerCase().includes('openclaw not found')) {
        userMsg = `⚠️ *Cron "${niceLabel}" KHÔNG chạy được — openclaw không có trên máy*\n\nCần \`npm install -g openclaw\` rồi restart Modoro Claw.`;
      } else if (lastErr.toLowerCase().includes('invalid token') || lastErr.toLowerCase().includes('not authorized')) {
        userMsg = `⚠️ *Cron "${niceLabel}" KHÔNG chạy được — auth lỗi*\n\nGateway token hoặc Telegram bot token không hợp lệ. Vào Dashboard → Cài đặt → Wizard để cấu hình lại.\n\nstderr: \`${lastErr.slice(0, 200)}\``;
      } else {
        userMsg = `⚠️ *Cron "${niceLabel}" KHÔNG chạy được — lỗi không retry được*\n\nExit ${res.code}\n\`\`\`\n${lastErr.slice(0, 400)}\n\`\`\``;
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
    await sendTelegram(`⚠️ *Cron "${niceLabel}" thất bại sau 3 lần*\n\nExit code: \`${lastCode}\`\n\`\`\`\n${lastErr.slice(0, 500)}\n\`\`\``);
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
    width: 480,
    height: 720,
    minWidth: 400,
    minHeight: 600,
    title: 'MODOROClaw',
    resizable: true,
    backgroundColor: '#0D1117',
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
  const configured = openclawBin ? isOpenClawConfigured() : false;
  console.log('[createWindow] configured:', configured);

  if (!openclawBin) {
    console.log('[createWindow] → no-openclaw.html');
    mainWindow.loadFile(path.join(__dirname, 'ui', 'no-openclaw.html'));
  } else if (configured) {
    console.log('[createWindow] → dashboard.html');
    mainWindow.loadFile(path.join(__dirname, 'ui', 'dashboard.html'));
    mainWindow.maximize();
    // Ensure workspace files exist BEFORE cron jobs try to read them
    try { seedWorkspace(); } catch (e) { console.error('[seedWorkspace early] error:', e.message); }
    // ORDER MATTERS: startOpenClaw() runs ensureDefaultConfig() which heals the
    // openclaw.json schema (deletes deprecated keys, fixes provider URL, etc.).
    // Cron jobs MUST be scheduled AFTER that completes, otherwise the very first
    // cron handler can spawn `openclaw agent` against an unhealed config and fail
    // with "Config invalid". This used to be fire-and-forget; now it's awaited.
    (async () => {
      try { await startOpenClaw(); } catch (e) { console.error('[boot] startOpenClaw error:', e?.message || e); }
      startCronJobs();
      watchCustomCrons();
      startZaloCacheAutoRefresh();
    })();
  } else {
    console.log('[createWindow] → wizard.html');
    mainWindow.loadFile(path.join(__dirname, 'ui', 'wizard.html'));
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

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '🦞 Mở', click: show },
    { type: 'separator' },
    { label: botRunning ? '● Đang chạy' : '○ Đã dừng', enabled: false },
    { label: botRunning ? 'Dừng' : 'Khởi động', click: () => { if (botRunning) stopOpenClaw(); else startOpenClaw(); createTray(); } },
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
function writeOpenClawConfigIfChanged(configPath, config) {
  try {
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
      // Kill the entire process group so 9router's child Next.js server dies too.
      // detached:true at spawn time gave the child its own group with pgid=pid.
      // -pid (negative) targets the group; falling back to kill main pid if that
      // fails (single-process child).
      try { process.kill(-pid, 'SIGTERM'); }
      catch { try { routerProcess.kill('SIGTERM'); } catch {} }
      // Last resort: pkill any leftover 9router server.js by command line
      setTimeout(() => {
        try { require('child_process').execSync('pkill -f "9router/app/server.js" 2>/dev/null || true', { stdio: 'ignore' }); } catch {}
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
    // Ensure OpenZalo has all policy fields set (default: reply to all DMs + all groups)
    if (config.channels?.openzalo) {
      const oz = config.channels.openzalo;
      // CRITICAL: heal `enabled = true` HERE so we never need to call
      // `openclaw config set channels.openzalo.enabled true` from a CLI subprocess
      // (which uses rename-based atomic write, bypasses writeOpenClawConfigIfChanged,
      // changes the file inode, wakes the gateway's config-reload watcher, and
      // aborts in-flight reply runs with `aborted_for_restart` → CEO sees
      // "⚠️ Gateway is restarting"). Healing here means writeOpenClawConfigIfChanged
      // can byte-equal-skip the write entirely once steady state is reached.
      if (oz.enabled !== true) { oz.enabled = true; changed = true; }
      if (!oz.dmPolicy) { oz.dmPolicy = 'open'; changed = true; }
      if (!oz.allowFrom) { oz.allowFrom = ['*']; changed = true; }
      if (!oz.groupPolicy) { oz.groupPolicy = 'open'; changed = true; }
      if (!oz.groupAllowFrom) { oz.groupAllowFrom = ['*']; changed = true; }
      // FIX: disable block streaming so bot replies arrive as 1 complete message.
      // Without this, slow models trigger coalesce idle timeout (1s) and split messages
      // mid-word (e.g. "Dạ" → "D" + "ạ" in two separate Zalo messages).
      if (oz.blockStreaming !== false) { oz.blockStreaming = false; changed = true; }
    }
    // Same fix for Telegram — both channels use the same streaming pipeline
    if (config.channels?.telegram) {
      const tg = config.channels.telegram;
      if (tg.blockStreaming !== false) { tg.blockStreaming = false; changed = true; }
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

// MODOROClaw PATCH: OpenZalo plugin has a Windows shell:true bug that silently drops
// multi-line messages (group bot replies never arrive). We keep a patched copy of
// openzca.ts in electron/patches/ and restore it after any plugin (re)install.
function ensureOpenzaloShellFix() {
  try {
    const pluginFile = path.join(HOME, '.openclaw', 'extensions', 'openzalo', 'src', 'openzca.ts');
    const templateFile = path.join(resourceDir, 'electron', 'patches', 'openzalo-openzca.ts');
    if (!fs.existsSync(pluginFile) || !fs.existsSync(templateFile)) return;
    const currentContent = fs.readFileSync(pluginFile, 'utf-8');
    if (currentContent.includes('MODOROClaw PATCH')) return; // already patched
    const templateContent = fs.readFileSync(templateFile, 'utf-8');
    fs.writeFileSync(pluginFile, templateContent, 'utf-8');
    console.log('[openzalo-fix] Restored patched openzca.ts from template');
  } catch (e) {
    console.error('[openzalo-fix] error:', e.message);
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

  const bin = await findOpenClawBin();
  if (!bin) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('bot-status', { running: false, error: 'OpenClaw không tìm thấy.' });
    }
    return;
  }

  // Ensure config is valid before anything
  await ensureDefaultConfig();

  // Re-apply OpenZalo shell fix in case plugin was reinstalled
  ensureOpenzaloShellFix();
  // Re-apply blocklist injection (idempotent)
  ensureZaloBlocklistFix();

  // Rebuild memory DB — use absolute node path so it works even if Electron's
  // PATH doesn't include the user's Node install (nvm/volta/scoop/etc.).
  try {
    const rebuildScript = path.join(resourceDir, 'tools', 'memory-db', 'rebuild-db.js');
    if (fs.existsSync(rebuildScript)) {
      const nodeBin = findNodeBin() || 'node';
      await execFilePromise(nodeBin, [rebuildScript], { timeout: 10000, cwd: resourceDir, stdio: 'pipe' });
    }
  } catch (e) { console.error('Memory DB rebuild failed:', e.message); }

  // Start 9Router
  start9Router();

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

  // Wait for 9Router to be ready
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      await new Promise((resolve, reject) => {
        const req = require('http').get('http://127.0.0.1:20128/v1/models', { timeout: 2000 }, (res) => {
          res.resume(); res.statusCode === 200 ? resolve() : reject();
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(); });
      });
      break;
    } catch {}
  }

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
  openclawProcess = spawn(gwSpawnCmd, gwSpawnArgs, {
    cwd: getWorkspace(),
    env: process.env,
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
  } else {
    // Don't WARN — that scared the user last time. The retry+Telegram path
    // catches any first-cron-fire that races a still-warming gateway.
    console.log(`[startOpenClaw] gateway WS still not responding to GET / after 90s (${probeAttempts} probes). Cron retries will handle warmup.`);
  }

  // Register Telegram slash commands (fire-and-forget)
  registerTelegramCommands().catch(e => console.error('[telegram] registerCommands failed:', e.message));

  // Boot ping — confirms sendTelegram works end-to-end. Throttled to once per
  // 10 minutes per process so heartbeat-driven restarts don't spam the CEO.
  if (!global._lastBootPingAt || (Date.now() - global._lastBootPingAt) > 10 * 60 * 1000) {
    global._lastBootPingAt = Date.now();
    setTimeout(() => {
      sendTelegram(
        '✅ *MODOROClaw đã sẵn sàng*\n\n' +
        'Gateway, 9Router, Telegram đều OK. Cron tự động đang chạy.\n\n' +
        'Thử nhắn *"báo cáo"* hoặc */menu* để bắt đầu.'
      ).then(ok => console.log('[boot] Telegram ping:', ok ? 'OK' : 'FAILED'));
    }, 3000);
  } else {
    console.log('[boot] Telegram ping skipped (throttled — last sent <10min ago)');
  }

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
ipcMain.handle('setup-9router-auto', async (_event, opts = {}) => {
  try {
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

    // 1. Add Ollama provider
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

    // 2. Create combo "main" with default model
    let combo = db.combos.find(c => c.name === 'main');
    if (!combo) {
      combo = { id: randomUUID(), name: 'main', models: ['ollama/qwen3.5'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      db.combos.push(combo);
    } else if (!combo.models || combo.models.length === 0) {
      combo.models = ['ollama/qwen3.5'];
      combo.updatedAt = new Date().toISOString();
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

    // Restart 9Router to pick up new config
    stop9Router();
    await new Promise(r => setTimeout(r, 500));
    start9Router();

    return { success: true, apiKey: apiKey.key };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Setup Zalo via OpenZalo (openzca CLI for QR login)
// Pre-install openzalo plugin + patch (runs once in background at startup)
let _zaloReady = false;
async function ensureZaloPlugin() {
  if (_zaloReady) return;
  try {
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
ipcMain.handle('save-personalization', async (_event, { industry, tone, pronouns, ceoTitle }) => {
  try {
    // Validate inputs
    const VALID_INDUSTRIES = ['bat-dong-san', 'fnb', 'thuong-mai', 'dich-vu', 'giao-duc', 'cong-nghe', 'san-xuat', 'tong-quat'];
    if (!VALID_INDUSTRIES.includes(industry)) return { success: false, error: 'Invalid industry' };
    const VALID_TONES = ['professional', 'friendly', 'concise'];
    if (!VALID_TONES.includes(tone)) tone = 'friendly';
    const VALID_PRONOUNS = ['em-anh-chi', 'toi-quy-khach', 'minh-ban'];
    if (!VALID_PRONOUNS.includes(pronouns)) pronouns = 'em-anh-chi';
    ceoTitle = (ceoTitle || '').replace(/[\n\r]/g, '').substring(0, 50);

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
      content = content.replace(/- \*\*Cách xưng hô:\*\* .*/, `- **Cách xưng hô:** ${pronounMap[pronouns] || pronounMap['em-anh-chi']}`);
      content = content.replace(/- \*\*Phong cách:\*\* .*/, `- **Phong cách:** ${toneMap[tone] || toneMap['friendly']}`);
      content = content.replace(/- \*\*Ngành:\*\* .*/, `- **Ngành:** ${INDUSTRY_NAMES[industry] || industry}`);
      fs.writeFileSync(identityPath, content, 'utf-8');
    }

    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
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
    if (config.channels?.openzalo?.dmPolicy === 'open' && !config.channels.openzalo.allowFrom) {
      config.channels.openzalo.allowFrom = ['*'];
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
  return loadCustomCrons();
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

// Manually trigger a cron handler (for "Test ngay" button in Dashboard)
ipcMain.handle('test-cron', async (_event, { type, id }) => {
  try {
    if (type === 'fixed') {
      const schedules = loadSchedules();
      const s = schedules.find(x => x.id === id);
      if (!s) return { success: false, error: 'Schedule not found' };
      let text = '';
      if (id === 'morning') {
        text = `☀️ *TEST — Báo cáo sáng*\n\nĐây là tin test. Cron thật sẽ gửi vào ${s.time} mỗi ngày.\nNhắn "báo cáo" để em tổng hợp ngay.`;
      } else if (id === 'evening') {
        text = `🌙 *TEST — Tóm tắt cuối ngày*\n\nĐây là tin test. Cron thật sẽ gửi vào ${s.time} mỗi ngày.\nNhắn "tổng kết" để em gửi.`;
      } else if (id === 'heartbeat') {
        text = `💓 *TEST — Heartbeat*\n\nĐây là tin test. Hệ thống đang hoạt động bình thường.`;
      } else if (id === 'meditation') {
        text = `🧠 *TEST — Tối ưu ban đêm*\n\nĐây là tin test. Cron thật sẽ ghi queue lúc ${s.time}.`;
      }
      const sent = await sendTelegram(text);
      return { success: sent === true, sent };
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
      // CSV format: "Node,ProcessId\n<host>,<pid>"
      for (const line of out.split('\n')) {
        const cols = line.trim().split(',');
        const pid = parseInt(cols[cols.length - 1], 10);
        if (Number.isFinite(pid) && pid > 0) return pid;
      }
    } else {
      const out = require('child_process').execSync(
        `pgrep -f "openzca.*listen" 2>/dev/null || true`,
        { encoding: 'utf-8', timeout: 3000, shell: '/bin/sh' }
      );
      const pid = parseInt(out.trim().split('\n')[0], 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  } catch {}
  return null;
}

async function probeZaloReady() {
  try {
    const ozDir = path.join(HOME, '.openzca', 'profiles', 'default');
    const ownerFile = path.join(ozDir, 'listener-owner.json');

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
    const reloadCustom = () => {
      clearTimeout(debounce1);
      debounce1 = setTimeout(() => {
        console.log('[cron] custom-crons.json changed, reloading...');
        try { restartCronJobs(); } catch (e) { console.error('[cron] reload error:', e.message); }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('custom-crons-updated', loadCustomCrons());
        }
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
          // Send actionable notification to CEO — they reply "báo cáo" to trigger bot reasoning
          const sent = await sendTelegram(
            `☀️ *Báo cáo sáng — ${s.time || '07:30'}*\n\n` +
            `Chào anh/chị, em sẵn sàng tổng hợp báo cáo:\n` +
            `• Doanh thu hôm qua\n` +
            `• Lịch họp hôm nay\n` +
            `• Tin nhắn Zalo cần xử lý\n\n` +
            `Nhắn *"báo cáo"* để em gửi chi tiết ngay ạ.`
          );
          console.log('[cron] Morning sendTelegram result:', sent !== null);
        };
        break;
      }
      case 'evening': {
        const [h, m] = (s.time || '21:00').split(':');
        cronExpr = `${m || 0} ${h || 21} * * *`;
        handler = async () => {
          console.log('[cron] Evening summary triggered at', new Date().toISOString());
          const sent = await sendTelegram(
            `🌙 *Tóm tắt cuối ngày — ${s.time || '21:00'}*\n\n` +
            `Hết ngày làm việc rồi ạ. Em có thể tổng hợp:\n` +
            `• Kết quả hôm nay so với mục tiêu\n` +
            `• Vấn đề tồn đọng\n` +
            `• Kế hoạch ngày mai\n\n` +
            `Nhắn *"tổng kết"* để em gửi ngay ạ.`
          );
          console.log('[cron] Evening sendTelegram result:', sent !== null);
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
        } catch (e) {
          console.error(`[cron] Custom ${c.id} handler threw (suppressed):`, e?.message || e);
          journalCronRun({ phase: 'fail', label: c.label || c.id, reason: 'handler-threw', err: String(e?.message || e).slice(0, 300) });
          try { await sendTelegram(`⚠️ *Cron "${c.label || c.id}" lỗi nội bộ*\n\n\`${String(e?.message || e).slice(0, 300)}\``); } catch {}
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
    sendTelegram(`⚠️ *Cron "${c?.label || c?.id || '?'}" cấu hình sai*\n\n${reason}\n\nCron sẽ KHÔNG chạy cho tới khi sửa. Vào Dashboard → Cron để fix.`);
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

const KNOWLEDGE_CATEGORIES = ['cong-ty', 'san-pham', 'nhan-vien'];
const KNOWLEDGE_LABELS = {
  'cong-ty': 'Công ty',
  'san-pham': 'Sản phẩm',
  'nhan-vien': 'Nhân viên',
};

function getKnowledgeDir(category) {
  if (!KNOWLEDGE_CATEGORIES.includes(category)) throw new Error('Invalid category: ' + category);
  return path.join(getWorkspace(), 'knowledge', category);
}

function ensureKnowledgeFolders() {
  const ws = getWorkspace();
  for (const cat of KNOWLEDGE_CATEGORIES) {
    const dir = path.join(ws, 'knowledge', cat, 'files');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const indexFile = path.join(ws, 'knowledge', cat, 'index.md');
    if (!fs.existsSync(indexFile)) {
      try {
        fs.writeFileSync(
          indexFile,
          `# Knowledge — ${KNOWLEDGE_LABELS[cat]}\n\n*Chưa có tài liệu nào. CEO upload file qua Dashboard → Knowledge.*\n`,
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
  for (const cat of KNOWLEDGE_CATEGORIES) {
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
    const http = require('http');
    const truncated = content.length > 4000 ? content.substring(0, 4000) + '...' : content;
    const body = JSON.stringify({
      model: 'main',
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
    const db = getDocumentsDb();
    const counts = { 'cong-ty': 0, 'san-pham': 0, 'nhan-vien': 0 };
    if (!db) {
      // Fallback to disk count when DB unavailable.
      for (const cat of KNOWLEDGE_CATEGORIES) counts[cat] = listKnowledgeFilesFromDisk(cat).length;
      return counts;
    }
    for (const cat of KNOWLEDGE_CATEGORIES) {
      let n = 0;
      try { n = db.prepare('SELECT COUNT(*) as n FROM documents WHERE category = ?').get(cat)?.n || 0; } catch {}
      // Also count disk-only files (uploaded while DB was broken)
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
    return { 'cong-ty': 0, 'san-pham': 0, 'nhan-vien': 0 };
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

ipcMain.handle('wizard-complete', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
  // Fresh install: seed workspace files with defaults + cleanup any stale listener
  try { seedWorkspace(); } catch (e) { console.error('[wizard-complete seed] error:', e.message); }
  try { cleanupOrphanZaloListener(); } catch {}
  mainWindow.loadFile(path.join(__dirname, 'ui', 'dashboard.html'));
  mainWindow.maximize();
  // ORDER MATTERS — see comment at the dashboard branch in createWindow().
  // We MUST await startOpenClaw() (which awaits ensureDefaultConfig()) before
  // scheduling cron jobs, otherwise the first cron fire on a fresh install can
  // race the schema heal and fail with "Config invalid".
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

  // PRE-CHECK 1: Verify Node.js is available + version is recent enough.
  // openzca requires Node >= 22.13.0. If user has older Node, npm install will
  // log a warning but proceed; openzca's compiled output (tsup --target node22)
  // may then fail at runtime with syntax errors. Show a clear actionable error
  // BEFORE wasting 5 minutes on a doomed npm install.
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

    // Install OpenClaw + 9Router via npm. NOTE: --no-engine-strict so openzca's
    // engines.node check is a warning not a failure (we already verified Node>=22).
    let cmd, args;
    if (isWin) {
      cmd = 'npm.cmd';
      args = ['install', '-g', 'openclaw', '9router', 'openzca'];
    } else {
      cmd = 'npm';
      args = ['install', '-g', 'openclaw', '9router', 'openzca'];
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
          send('✅ CÀI ĐẶT THÀNH CÔNG!');
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
// so we can embed them in <iframe> inside the dashboard.
function installEmbedHeaderStripper() {
  try {
    const { session } = require('electron');
    const TRUSTED_LOCAL = [
      'http://127.0.0.1:18789', 'http://localhost:18789',
      'http://127.0.0.1:20128', 'http://localhost:20128',
    ];
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const url = details.url || '';
      if (!TRUSTED_LOCAL.some(o => url.startsWith(o))) {
        return callback({ responseHeaders: details.responseHeaders });
      }
      const headers = {};
      for (const [k, v] of Object.entries(details.responseHeaders || {})) {
        const lower = k.toLowerCase();
        if (lower === 'x-frame-options') continue; // strip
        if (lower === 'content-security-policy') {
          // Remove only frame-ancestors directive (keeps other security)
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
    console.log('[embed] Header stripper installed for trusted local origins');
  } catch (e) {
    console.error('[embed] Failed to install header stripper:', e.message);
  }
}

app.whenReady().then(() => {
  // Update userDataDir now that app is ready
  if (app.isPackaged) {
    userDataDir = app.getPath('userData');
    invalidateWorkspaceCache(); // Force getWorkspace() to re-evaluate with new userDataDir
  }
  // Boot diagnostic: writes <workspace>/logs/boot-diagnostic.txt with everything
  // we need to debug "why didn't cron work?". MUST run after userDataDir update
  // so the file goes to the right workspace.
  try { bootDiagRunFullCheck(); } catch (e) { console.error('[boot-diag] error:', e?.message || e); }

  installEmbedHeaderStripper(); // BEFORE createWindow so first iframe load is unblocked
  createWindow();
  createTray();
  // Pre-install Zalo plugin in background (so QR is fast when user clicks)
  ensureZaloPlugin().catch(() => {});
  // Re-index any Knowledge files that exist on disk but are missing from DB
  // (e.g. uploaded while better-sqlite3 was broken). Non-blocking.
  try { ensureKnowledgeFolders(); } catch {}
  backfillKnowledgeFromDisk().catch(e => console.error('[knowledge] backfill error:', e.message));
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
