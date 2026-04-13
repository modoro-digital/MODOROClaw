#!/usr/bin/env node
// send-zalo-safe.js — Safe wrapper for sending Zalo messages from agent exec tool.
// Checks ALL safety gates before forwarding to openzca CLI.
//
// Usage:
//   node send-zalo-safe.js <targetId> "<message>" [--group]
//
// Exit codes:
//   0 = sent OK
//   1 = blocked by safety gate (message printed to stderr)
//   2 = openzca send failed
//   3 = usage error

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const HOME = os.homedir();
const isWin = process.platform === 'win32';

// --- Resolve workspace (same logic as main.js getWorkspace) ---
function getWorkspace() {
  if (process.env['9BIZ_WORKSPACE'] && fs.existsSync(process.env['9BIZ_WORKSPACE'])) {
    return process.env['9BIZ_WORKSPACE'];
  }
  const APP_DIR = '9bizclaw';
  if (isWin) return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), APP_DIR);
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Application Support', APP_DIR);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), APP_DIR);
}

// --- Parse args ---
const args = process.argv.slice(2);
if (args.length < 2) {
  process.stderr.write('Usage: node send-zalo-safe.js <targetId> "<message>" [--group]\n');
  process.exit(3);
}
const targetId = args[0];
const message = args[1];
const isGroup = args.includes('--group');

const ws = getWorkspace();
const configPath = path.join(HOME, '.openclaw', 'openclaw.json');

// --- Gate 1: Channel enabled ---
try {
  if (fs.existsSync(configPath)) {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (cfg?.channels?.openzalo?.enabled === false) {
      process.stderr.write('BLOCKED: Zalo channel is disabled. CEO must enable in Dashboard > Zalo.\n');
      process.exit(1);
    }
  }
} catch (e) {
  process.stderr.write('BLOCKED: Cannot read openclaw.json (fail closed): ' + e.message + '\n');
  process.exit(1);
}

// --- Gate 2: Channel paused ---
try {
  const pausePath = path.join(ws, 'zalo-paused.json');
  if (fs.existsSync(pausePath)) {
    const pause = JSON.parse(fs.readFileSync(pausePath, 'utf-8'));
    if (pause.permanent || pause.until) {
      const reason = pause.reason || 'unknown';
      process.stderr.write('BLOCKED: Zalo is paused (' + reason + '). CEO must resume in Dashboard.\n');
      process.exit(1);
    }
  }
} catch (e) {
  // Corrupt pause file → fail closed (treat as paused)
  process.stderr.write('BLOCKED: zalo-paused.json corrupt — treating as paused (fail closed).\n');
  process.exit(1);
}

// --- Gate 3: Group allowlist (only for --group sends) ---
if (isGroup) {
  try {
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const oz = cfg?.channels?.openzalo || {};
      const policy = oz.groupPolicy || 'open';
      const allowFrom = Array.isArray(oz.groupAllowFrom) ? oz.groupAllowFrom.map(String) : ['*'];
      if (policy === 'allowlist' && !allowFrom.includes('*') && !allowFrom.includes(targetId)) {
        process.stderr.write('BLOCKED: Group ' + targetId + ' not in allowlist. CEO must add in Dashboard > Zalo.\n');
        process.exit(1);
      }
    }
  } catch {}
}

// --- Gate 4: User blocklist (only for DM sends) ---
if (!isGroup) {
  try {
    const blocklistPath = path.join(ws, 'zalo-blocklist.json');
    if (fs.existsSync(blocklistPath)) {
      const blocklist = JSON.parse(fs.readFileSync(blocklistPath, 'utf-8'));
      const blocked = Array.isArray(blocklist)
        ? blocklist.some(e => String(e.id || e) === targetId)
        : false;
      if (blocked) {
        process.stderr.write('BLOCKED: User ' + targetId + ' is in blocklist.\n');
        process.exit(1);
      }
    }
  } catch {}
}

// --- Gate 5: Output filter (same patterns as main.js) ---
const FILTER_PATTERNS = [
  { name: 'file-path-win', re: /[A-Z]:\\[A-Za-z0-9_\\.-]{3,}/i },
  { name: 'file-path-unix', re: /(?:\/usr\/|\/home\/|\/tmp\/|~\/|\.\.\/)[A-Za-z0-9_/.-]{3,}/ },
  { name: 'api-key', re: /(?:sk-|pk_|token[=: ]+)[A-Za-z0-9_-]{10,}/ },
  { name: 'env-var-leak', re: /(?:APPDATA|USERPROFILE|HOME|PATH)=[^\s]{5,}/ },
  { name: 'stack-trace', re: /at\s+\S+\s+\([^)]*:\d+:\d+\)/ },
  { name: 'exit-code', re: /exit(?:\s+code)?\s*[=: ]+\d+/i },
  { name: 'node-error', re: /Error:\s+(?:ENOENT|EACCES|ECONNREFUSED|MODULE_NOT_FOUND)/ },
];
for (const p of FILTER_PATTERNS) {
  if (p.re.test(message)) {
    process.stderr.write('BLOCKED: Output filter matched pattern "' + p.name + '". Message may contain sensitive content.\n');
    process.exit(1);
  }
}

// --- All gates passed — find openzca and send ---
function findOpenzca() {
  // 1. vendor bundled
  const vendorRoots = [];
  if (isWin) {
    vendorRoots.push(path.join(process.env.APPDATA || '', '9bizclaw', 'vendor'));
  } else if (process.platform === 'darwin') {
    vendorRoots.push(path.join(HOME, 'Library', 'Application Support', '9bizclaw', 'vendor'));
  }
  for (const vr of vendorRoots) {
    const cli = path.join(vr, 'node_modules', 'openzca', 'dist', 'cli.js');
    if (fs.existsSync(cli)) return cli;
  }
  // 2. npm global
  const npmGlobal = isWin
    ? path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'openzca', 'dist', 'cli.js')
    : '/usr/local/lib/node_modules/openzca/dist/cli.js';
  if (fs.existsSync(npmGlobal)) return npmGlobal;
  return null;
}

const zcaCli = findOpenzca();
if (!zcaCli) {
  process.stderr.write('BLOCKED: openzca CLI not found. Zalo may not be installed.\n');
  process.exit(1);
}

const zcaArgs = [zcaCli, '--profile', 'default', 'msg', 'send', targetId, message];
if (isGroup) zcaArgs.push('--group');

const child = spawn(process.execPath, zcaArgs, {
  shell: false,
  timeout: 20000,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '', stderr = '';
child.stdout.on('data', d => { stdout += d; });
child.stderr.on('data', d => { stderr += d; });
child.on('close', code => {
  if (code === 0) {
    process.stdout.write('OK: Message sent to ' + (isGroup ? 'group' : 'user') + ' ' + targetId + '\n');
    process.exit(0);
  } else {
    process.stderr.write('FAILED: openzca exit ' + code + ': ' + stderr.slice(0, 200) + '\n');
    process.exit(2);
  }
});
child.on('error', e => {
  process.stderr.write('FAILED: spawn error: ' + e.message + '\n');
  process.exit(2);
});
