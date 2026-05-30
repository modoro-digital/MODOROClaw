'use strict';
// Skill script execution helper.
//
// Spawn a script from a skill's `scripts/` folder with appropriate runtime,
// restricted environment, and resource limits. Supports both legacy flat
// skills (no scripts) and Anthropic folder skills (scripts/<file>).
//
// Returns: { exitCode, stdout, stderr, durationMs, timedOut, killedSize }

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_OUTPUT_MAX = 1_048_576; // 1MB
const TEST_TIMEOUT_MS = 30_000;
const TEST_OUTPUT_MAX = 102_400; // 100KB

// Detect runtime from script filename extension.
function _runtimeForFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.py': return 'python';
    case '.js': return 'node';
    case '.mjs': return 'node';
    case '.sh': return 'bash';
    case '.ps1': return 'powershell';
    default: return null;
  }
}

function _resolveRuntimeBin(runtime) {
  if (runtime === 'python') {
    return require('./python-runtime').detectSystemPython();
  }
  if (runtime === 'node') {
    try {
      const boot = require('./boot');
      const nodeBin = (typeof boot.findNodeBin === 'function' && boot.findNodeBin()) ||
        (typeof boot.getBundledNodeBin === 'function' && boot.getBundledNodeBin());
      if (nodeBin) return nodeBin;
    } catch {}
    return process.versions && process.versions.electron ? null : process.execPath;
  }
  if (runtime === 'bash') {
    // POSIX bash. On Windows, Git Bash often at C:\Program Files\Git\bin\bash.exe.
    if (process.platform === 'win32') {
      const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
      return fs.existsSync(gitBash) ? gitBash : null;
    }
    return '/bin/bash';
  }
  if (runtime === 'powershell') {
    return process.platform === 'win32' ? 'powershell.exe' : null;
  }
  return null;
}

function _nodeModulePathEntries() {
  const entries = [];
  try {
    const boot = require('./boot');
    const vendor = typeof boot.getBundledVendorDir === 'function' ? boot.getBundledVendorDir() : null;
    if (vendor) entries.push(path.join(vendor, 'node_modules'));
  } catch {}
  try {
    const runtimeInstaller = require('./runtime-installer');
    if (typeof runtimeInstaller.getRuntimeNodeModulesDir === 'function') {
      entries.push(runtimeInstaller.getRuntimeNodeModulesDir());
    }
  } catch {}
  entries.push(path.join(__dirname, '..', 'node_modules'));
  if (process.env.APPDATA) entries.push(path.join(process.env.APPDATA, '9bizclaw', 'vendor', 'node_modules'));
  const existing = String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
  return [...new Set([...entries, ...existing].filter(p => p && fs.existsSync(p)))];
}

// Build restricted env. Strip secrets, set workspace marker, allow PATH.
function _buildSafeEnv(extra) {
  const nodePath = _nodeModulePathEntries().join(path.delimiter);
  const safe = {
    ...extra,
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot, // Windows needs this
    TEMP: process.env.TEMP || process.env.TMP,
    TMP: process.env.TMP || process.env.TEMP,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    LANG: process.env.LANG || 'en_US.UTF-8',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
  };
  if (nodePath) safe.NODE_PATH = nodePath;
  return safe;
}

// Build args array per runtime
function _buildArgs(runtime, scriptPath, userArgs) {
  const args = Array.isArray(userArgs) ? userArgs.map(String) : [];
  if (runtime === 'python') return [scriptPath, ...args];
  if (runtime === 'node') return [scriptPath, ...args];
  if (runtime === 'bash') return [scriptPath, ...args];
  if (runtime === 'powershell') return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args];
  return [scriptPath, ...args];
}

// Spawn script with limits. opts:
//   - cwd (default: scriptPath's parent dir)
//   - args (positional args for script)
//   - timeoutMs (default 60s)
//   - outputMax (default 1MB)
//   - extraEnv (additional env vars)
//   - networkAllowed (placeholder — full sandbox requires OS-level isolation;
//     we just emit a flag for future enforcement)
async function runScript(scriptPath, opts = {}) {
  const startedAt = Date.now();
  if (!fs.existsSync(scriptPath)) {
    return { exitCode: -1, stdout: '', stderr: 'Script not found: ' + scriptPath, durationMs: 0, error: 'ENOENT' };
  }
  const filename = path.basename(scriptPath);
  const runtime = _runtimeForFile(filename);
  if (!runtime) {
    return { exitCode: -1, stdout: '', stderr: `Unsupported script type: ${filename}. Supported: .py, .js, .mjs, .sh, .ps1`, durationMs: 0, error: 'ENORUNTIME' };
  }
  let bin = _resolveRuntimeBin(runtime);
  if (!bin && runtime === 'python' && opts.autoInstallPython !== false) {
    try {
      bin = await require('./python-runtime').ensurePython();
    } catch (e) {
      return {
        exitCode: -1,
        stdout: '',
        stderr: e.message || 'Python runtime unavailable',
        durationMs: Date.now() - startedAt,
        error: 'ENORUNTIMEBIN',
        runtime,
      };
    }
  }
  if (!bin) {
    const msg = runtime === 'python'
      ? 'Python 3.8+ chưa cài. Bot sẽ tự download Python embedded lần đầu — chờ ~30s.'
      : runtime === 'bash' && process.platform === 'win32'
        ? 'Git Bash chưa cài. Cài Git for Windows hoặc đổi script sang .ps1.'
        : `Runtime "${runtime}" not available on this system.`;
    return { exitCode: -1, stdout: '', stderr: msg, durationMs: 0, error: 'ENORUNTIMEBIN', runtime };
  }
  const cwd = opts.cwd || path.dirname(scriptPath);
  const args = _buildArgs(runtime, scriptPath, opts.args);
  const env = _buildSafeEnv(opts.extraEnv || {});
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const outputMax = opts.outputMax || DEFAULT_OUTPUT_MAX;

  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let totalBytes = 0;
    let killedSize = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
    }, timeoutMs);
    const onChunk = (which) => (chunk) => {
      const str = chunk.toString('utf-8');
      totalBytes += chunk.length;
      if (totalBytes > outputMax) {
        if (!killedSize) {
          killedSize = true;
          try { child.kill('SIGTERM'); } catch {}
        }
        return;
      }
      if (which === 'stdout') stdout += str;
      else stderr += str;
    };
    child.stdout.on('data', onChunk('stdout'));
    child.stderr.on('data', onChunk('stderr'));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1, stdout, stderr: stderr + '\n[spawn error] ' + err.message,
        durationMs: Date.now() - startedAt, error: 'SPAWN_ERROR', runtime, bin,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        killedSize,
        signal: signal || null,
        runtime,
        bin,
      });
    });
  });
}

// Test execution — isolated cwd in OS temp, lower limits, no audit.
async function testRunScript(code, runtime, args, extraOpts) {
  let tempDir;
  try {
    tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), '9biz-skill-test-'));
  } catch (e) {
    return { exitCode: -1, stdout: '', stderr: 'Failed to create temp directory: ' + e.message, durationMs: 0 };
  }
  let scriptName;
  if (runtime === 'python') scriptName = 'test_script.py';
  else if (runtime === 'node') scriptName = 'test_script.js';
  else if (runtime === 'bash') scriptName = 'test_script.sh';
  else if (runtime === 'powershell') scriptName = 'test_script.ps1';
  else return { exitCode: -1, stdout: '', stderr: 'Unknown runtime: ' + runtime, durationMs: 0 };
  const scriptPath = path.join(tempDir, scriptName);
  fs.writeFileSync(scriptPath, code, 'utf-8');
  try {
    return await runScript(scriptPath, {
      cwd: tempDir,
      args,
      timeoutMs: TEST_TIMEOUT_MS,
      outputMax: TEST_OUTPUT_MAX,
      ...extraOpts,
    });
  } finally {
    // Windows: if the spawned process leaked a grandchild that still holds
    // a file handle in tempDir, the first rmSync hits EBUSY and the empty
    // catch silently swallowed it — leaving the script on disk indefinitely.
    // Retry after a delay (grandchildren usually finish within a few seconds)
    // before giving up + logging so we can audit leaks.
    if (!_safeRmTempDir(tempDir)) {
      setTimeout(() => {
        if (!_safeRmTempDir(tempDir)) {
          console.warn('[skill-runner] failed to clean temp dir after retry:', tempDir);
        }
      }, 5000).unref();
    }
  }
}

function _safeRmTempDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); return !fs.existsSync(dir); }
  catch { return false; }
}

module.exports = {
  runScript,
  testRunScript,
  _runtimeForFile,
  _resolveRuntimeBin,
  _nodeModulePathEntries,
};
