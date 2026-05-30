'use strict';

// =====================================================================
//  CLI SHIMS — expose bundled openclaw / 9router / node / npm in any
//  terminal (PowerShell, cmd, zsh, bash) like a normal global install.
//
//  WHY: pure-runtime model puts node + packages under userData/vendor/
//  and the app spawns them via absolute paths. They are NOT on PATH, so
//  `openclaw ...` does nothing in a normal terminal. The npm-generated
//  node_modules/.bin/openclaw.cmd that the installer adds relies on a
//  *system* `node` on PATH — which non-dev users (CEOs) do not have, so
//  it fails. These standalone shims hardcode the BUNDLED node absolute
//  path, so they work with zero system Node.
//
//  DRIVE-SAFE: every path is resolved at runtime from app.getPath
//  ('userData') + getBundledVendorDir() + getBundledNodeBin(). Nothing
//  is hardcoded to C: — if the .exe is installed on D: (NSIS install dir
//  ≠ userData) the shims still point at the real vendor location, and
//  every embedded path is quoted so spaces ("D:\My Apps\...") are safe.
//
//  Idempotent + non-blocking: shims are written only when their content
//  changes; the persistent-PATH step runs once (guarded by a marker) and
//  is skipped on every subsequent launch.
// =====================================================================

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { app } = require('electron');
const { getBundledVendorDir, getBundledNodeBin } = require('./boot');

const SHIM_VERSION = 1;

// ---------------------------------------------------------------------
//  Pure helpers (exported for tests — encode the drive/space-safety intent)
// ---------------------------------------------------------------------

// Build a shim file's contents. `scriptPath` null = pass straight through
// to node (the `node` shim itself). All paths are quoted for spaces.
function _buildShimContent(platform, nodeBin, scriptPath) {
  if (platform === 'win32') {
    const body = scriptPath
      ? `"${nodeBin}" "${scriptPath}" %*`
      : `"${nodeBin}" %*`;
    // CRLF + @echo off so the command line isn't echoed; pass %* through.
    return `@echo off\r\n${body}\r\n`;
  }
  const body = scriptPath
    ? `exec "${nodeBin}" "${scriptPath}" "$@"`
    : `exec "${nodeBin}" "$@"`;
  return `#!/bin/sh\n${body}\n`;
}

function _shimFileName(platform, name) {
  return platform === 'win32' ? `${name}.cmd` : name;
}

// npm ships its CLI as npm-cli.{js,cjs,mjs} and the dir layout differs by OS.
function _findNpmCli(vendor, platform) {
  const binDir = platform === 'win32'
    ? path.join(vendor, 'node', 'node_modules', 'npm', 'bin')
    : path.join(vendor, 'node', 'lib', 'node_modules', 'npm', 'bin');
  for (const f of ['npm-cli.js', 'npm-cli.cjs', 'npm-cli.mjs']) {
    const p = path.join(binDir, f);
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

// PowerShell helper that prepends a dir to the *User* PATH (idempotent,
// no setx 1024-char truncation — reads/writes via [Environment]) and
// broadcasts WM_SETTINGCHANGE so newly-opened shells pick it up without
// a logout. NOTE on `node`/`npm`: prepending to User scope does NOT shadow
// a System-scope Node (official MSI default), but it CAN shadow a Node that
// lives on the *User* PATH (nvm-windows / fnm / per-user MSI). That only
// affects developers; the target users have no Node at all, and `claw-node`/
// `claw-npm` are always the unambiguous bundled runtime regardless.
// Prepends $Dir to the *User* PATH. Hardened:
//  - idempotent (skip if already present),
//  - refuses to write if the result would approach Windows' ~32767-char PATH
//    limit (prevents any chance of a corrupting/truncating write),
//  - re-reads after writing to confirm the change took,
//  - emits 'PATH_OK' on confirmed success so the caller keys its marker off
//    real PATH state, not merely a zero exit code (the WM_SETTINGCHANGE
//    broadcast is best-effort and never affects the outcome).
const _ADD_TO_PATH_PS1 = `param([Parameter(Mandatory=$true)][string]$Dir)
$ErrorActionPreference = 'Stop'
try {
  $cur = [Environment]::GetEnvironmentVariable('Path','User')
  if ($null -eq $cur) { $cur = '' }
  $parts = $cur -split ';' | Where-Object { $_ -ne '' }
  if ($parts -notcontains $Dir) {
    $new = (@($Dir) + $parts) -join ';'
    if ($new.Length -gt 30000) { Write-Output 'PATH_TOO_LONG'; exit 2 }
    [Environment]::SetEnvironmentVariable('Path', $new, 'User')
    $verify = [Environment]::GetEnvironmentVariable('Path','User')
    $vparts = $verify -split ';' | Where-Object { $_ -ne '' }
    if ($vparts -notcontains $Dir) { Write-Output 'VERIFY_FAILED'; exit 3 }
  }
  try {
    $sig = '[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
    $t = Add-Type -MemberDefinition $sig -Name 'Win32Env' -Namespace 'Native' -PassThru
    $r = [UIntPtr]::Zero
    $t::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r) | Out-Null
  } catch {}
  Write-Output 'PATH_OK'
  exit 0
} catch {
  Write-Output ('ERR: ' + $_.Exception.Message)
  exit 1
}
`;

// ---------------------------------------------------------------------
//  Internal: write a file only if its content differs (avoids needless
//  disk churn on every boot).
// ---------------------------------------------------------------------
function _writeIfChanged(filePath, content, mode) {
  let existing = null;
  try { existing = fs.readFileSync(filePath, 'utf-8'); } catch {}
  if (existing !== content) {
    fs.writeFileSync(filePath, content, 'utf-8');
  }
  if (mode && process.platform !== 'win32') {
    try { fs.chmodSync(filePath, mode); } catch {}
  }
}

// ---------------------------------------------------------------------
//  Persistent PATH — Windows (PowerShell, User scope) and POSIX (rc files)
// ---------------------------------------------------------------------
function _ensurePersistentPathWindows(binDir, userData) {
  const ps1Path = path.join(userData, '.add-to-path.ps1');
  _writeIfChanged(ps1Path, _ADD_TO_PATH_PS1);
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path, '-Dir', binDir],
      { timeout: 15000, windowsHide: true },
      (err, stdout) => {
        const out = String(stdout || '').trim();
        if (err || !/PATH_OK/.test(out)) {
          console.warn('[cli-shims] Windows PATH update not confirmed:', err ? err.message : out);
          resolve(false);
          return;
        }
        resolve(true);
      }
    );
  });
}

function _ensurePersistentPathUnix(binDir) {
  const home = require('os').homedir();
  const markerStart = '# >>> 9bizclaw cli shims >>>';
  const markerEnd = '# <<< 9bizclaw cli shims <<<';
  const block = `${markerStart}\nexport PATH="${binDir}:$PATH"\n${markerEnd}\n`;
  // zsh login (.zprofile) + zsh interactive (.zshrc) + bash (.bashrc) + POSIX (.profile)
  const rcFiles = ['.zprofile', '.zshrc', '.bashrc', '.profile'].map(f => path.join(home, f));
  let failures = 0;
  for (const rc of rcFiles) {
    try {
      let content = '';
      try { content = fs.readFileSync(rc, 'utf-8'); } catch {}
      if (content.includes(markerStart)) continue; // already done — idempotent
      const sep = content && !content.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(rc, `${sep}${block}`, 'utf-8');
    } catch (e) {
      failures++;
      console.warn(`[cli-shims] could not update ${rc}:`, e?.message);
    }
  }
  // Only report success if NOTHING failed — so a partial failure (e.g. one rc
  // is unwritable) leaves the marker unwritten and retries next boot. The
  // per-file `includes(markerStart)` guard makes that retry cheap + dup-free.
  return failures === 0;
}

// ---------------------------------------------------------------------
//  Main entry — generate shims + ensure PATH. Safe to call every launch.
// ---------------------------------------------------------------------
async function ensureCliShims() {
  try {
    const vendor = getBundledVendorDir();
    const nodeBin = getBundledNodeBin();
    if (!vendor || !nodeBin) {
      // Dev mode or runtime not installed yet — nothing to shim.
      return { skipped: true, reason: !vendor ? 'no_vendor' : 'no_node' };
    }
    const platform = process.platform;
    const userData = app.getPath('userData');
    const binDir = path.join(userData, 'bin');
    try { fs.mkdirSync(binDir, { recursive: true }); } catch {}

    // Resolve shim targets (only those that actually exist on disk).
    const specs = [];
    const ocMjs = path.join(vendor, 'node_modules', 'openclaw', 'openclaw.mjs');
    if (fs.existsSync(ocMjs)) specs.push({ name: 'openclaw', script: ocMjs });

    // NOTE: 9router/cli.js is a SERVER entry (hardcoded port 20128), not a
    // general CLI. `9router --version`/`--help` work, but bare `9router` starts
    // a daemon that will EADDRINUSE against the app's running instance. Shipped
    // as a passthrough for advanced/diagnostic use only.
    const r9 = path.join(vendor, 'node_modules', '9router', 'cli.js');
    if (fs.existsSync(r9)) specs.push({ name: '9router', script: r9 });

    const npmCli = _findNpmCli(vendor, platform);
    if (npmCli) {
      specs.push({ name: 'npm', script: npmCli });
      specs.push({ name: 'claw-npm', script: npmCli });
    }
    // node + an unambiguous alias (claw-node always = bundled runtime even
    // if a system `node` shadows the plain shim).
    specs.push({ name: 'node', script: null });
    specs.push({ name: 'claw-node', script: null });

    const written = [];
    for (const s of specs) {
      const file = path.join(binDir, _shimFileName(platform, s.name));
      const content = _buildShimContent(platform, nodeBin, s.script);
      _writeIfChanged(file, content, 0o755);
      written.push(s.name);
    }

    // In-process: make shims visible to terminals the app itself spawns.
    const existing = (process.env.PATH || '').split(path.delimiter);
    if (!existing.includes(binDir)) {
      process.env.PATH = binDir + path.delimiter + (process.env.PATH || '');
    }

    // Persistent user PATH — run once, guarded by a marker keyed to the
    // exact binDir (so a moved userData re-triggers it).
    const marker = path.join(userData, '.cli-path-added');
    let markerVal = null;
    try { markerVal = fs.readFileSync(marker, 'utf-8').trim(); } catch {}
    const want = `v${SHIM_VERSION}:${binDir}`;
    if (markerVal !== want) {
      let ok = false;
      if (platform === 'win32') ok = await _ensurePersistentPathWindows(binDir, userData);
      else ok = _ensurePersistentPathUnix(binDir);
      if (ok) {
        try { fs.writeFileSync(marker, want, 'utf-8'); } catch {}
        console.log(`[cli-shims] added ${binDir} to user PATH (shims: ${written.join(', ')})`);
      }
    } else {
      console.log(`[cli-shims] shims up to date (${written.join(', ')})`);
    }

    return { ok: true, binDir, shims: written };
  } catch (e) {
    console.warn('[cli-shims] ensureCliShims error:', e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}

module.exports = {
  ensureCliShims,
  // exported for contract/smoke tests
  _buildShimContent,
  _shimFileName,
  _findNpmCli,
  _ADD_TO_PATH_PS1,
};
