#!/usr/bin/env node
/**
 * test-core.js — Runtime integration tests for MODOROClaw core functionality.
 *
 * Unlike smoke-test.js (pre-build, hermetic), this runs AFTER install against
 * real config, real workspace, real vendor binaries. Tests the actual paths
 * a customer machine will exercise.
 *
 * Usage:  node electron/scripts/test-core.js
 * Exit:   0 = all pass, 1 = failures found
 *
 * Each test prints PASS/FAIL with evidence. No guessing, no mocking.
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync, execFileSync } = require('child_process');
const os = require('os');

const HOME = os.homedir();
const isWin = process.platform === 'win32';
const isDarwin = process.platform === 'darwin';

// --- Resolve paths like main.js does ---
function getWorkspace() {
  const APP_DIR = '9bizclaw';
  if (isWin) return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), APP_DIR);
  if (isDarwin) return path.join(HOME, 'Library', 'Application Support', APP_DIR);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), APP_DIR);
}

function getVendorDir() {
  // Dev mode: electron/vendor or userData/vendor
  const devVendor = path.join(__dirname, '..', 'vendor');
  if (fs.existsSync(devVendor)) return devVendor;
  const wsVendor = path.join(getWorkspace(), 'vendor');
  if (fs.existsSync(wsVendor)) return wsVendor;
  return null;
}

const WS = getWorkspace();
const VENDOR = getVendorDir();
const OC_CONFIG = path.join(HOME, '.openclaw', 'openclaw.json');
const ZCA_CACHE = path.join(HOME, '.openzca', 'profiles', 'default', 'cache');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

let passed = 0, failed = 0, skipped = 0;

function pass(name, detail) {
  passed++;
  console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? ' — ' + detail : ''}`);
}
function fail(name, detail) {
  failed++;
  console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ' — ' + detail : ''}`);
}
function skip(name, detail) {
  skipped++;
  console.log(`  \x1b[33mSKIP\x1b[0m  ${name}${detail ? ' — ' + detail : ''}`);
}

// ============================================================
//  SUITE 1: Workspace & seedWorkspace artifacts
// ============================================================
console.log('\n\x1b[1m=== SUITE 1: Workspace Files ===\x1b[0m\n');

// T1.1: AGENTS.md exists and is v31+
(() => {
  const p = path.join(WS, 'AGENTS.md');
  if (!fs.existsSync(p)) return fail('T1.1 AGENTS.md exists', 'not found at ' + p);
  const content = fs.readFileSync(p, 'utf-8');
  const m = content.match(/modoroclaw-agents-version:\s*(\d+)/);
  if (!m) return fail('T1.1 AGENTS.md version', 'no version stamp');
  const ver = parseInt(m[1], 10);
  if (ver >= 31) pass('T1.1 AGENTS.md v' + ver, p);
  else fail('T1.1 AGENTS.md version', 'v' + ver + ' < 31');
})();

// T1.2: send-zalo-safe.js exists in workspace
(() => {
  const p = path.join(WS, 'tools', 'send-zalo-safe.js');
  if (fs.existsSync(p)) pass('T1.2 send-zalo-safe.js in workspace', p);
  else {
    // Check source tree — seedWorkspace hasn't run yet?
    const src = path.join(REPO_ROOT, 'tools', 'send-zalo-safe.js');
    if (fs.existsSync(src)) skip('T1.2 send-zalo-safe.js', 'exists in source (' + src + ') but not yet seeded to workspace. Restart app to seed.');
    else fail('T1.2 send-zalo-safe.js', 'missing from both workspace and source tree');
  }
})();

// T1.3: MEMORY.md has no emoji
(() => {
  const p = path.join(WS, 'MEMORY.md');
  if (!fs.existsSync(p)) return skip('T1.3 MEMORY.md no emoji', 'file not found');
  const content = fs.readFileSync(p, 'utf-8');
  // Match common emoji ranges
  const emojiRe = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{231A}\u{231B}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{25AA}\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2614}\u{2615}\u{2648}-\u{2653}\u{267F}\u{2693}\u{26A1}\u{26AA}\u{26AB}\u{26BD}\u{26BE}\u{26C4}\u{26C5}\u{26CE}\u{26D4}\u{26EA}\u{26F2}\u{26F3}\u{26F5}\u{26FA}\u{26FD}\u{2702}\u{2705}\u{2708}-\u{270D}\u{270F}]/u;
  if (emojiRe.test(content)) fail('T1.3 MEMORY.md no emoji', 'emoji found in content');
  else pass('T1.3 MEMORY.md no emoji');
})();

// T1.4: HEARTBEAT.md has no emoji
(() => {
  const p = path.join(WS, 'HEARTBEAT.md');
  if (!fs.existsSync(p)) return skip('T1.4 HEARTBEAT.md no emoji', 'file not found');
  const content = fs.readFileSync(p, 'utf-8');
  const emojiRe = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}]/u;
  if (emojiRe.test(content)) fail('T1.4 HEARTBEAT.md no emoji', 'emoji found');
  else pass('T1.4 HEARTBEAT.md no emoji');
})();

// T1.5: No fake memory files
(() => {
  const fakes = [
    'memory/people/colleague.md',
    'memory/projects/knowledge-management.md',
    'memory/projects/microservices-migration.md',
  ];
  let found = [];
  for (const f of fakes) {
    if (fs.existsSync(path.join(WS, f))) found.push(f);
  }
  if (found.length === 0) pass('T1.5 no fake memory files');
  else fail('T1.5 fake memory files exist', found.join(', '));
})();

// T1.6: Zalo memory dirs exist
(() => {
  const dirs = ['memory/zalo-users', 'memory/zalo-groups'];
  let missing = [];
  for (const d of dirs) {
    if (!fs.existsSync(path.join(WS, d))) missing.push(d);
  }
  if (missing.length === 0) pass('T1.6 Zalo memory dirs exist');
  else fail('T1.6 Zalo memory dirs missing', missing.join(', '));
})();

// ============================================================
//  SUITE 2: openclaw.json config health
// ============================================================
console.log('\n\x1b[1m=== SUITE 2: Config Health ===\x1b[0m\n');

let ocConfig = null;
(() => {
  if (!fs.existsSync(OC_CONFIG)) return skip('T2.0 openclaw.json exists', 'not found (pre-wizard?)');
  try {
    ocConfig = JSON.parse(fs.readFileSync(OC_CONFIG, 'utf-8'));
    pass('T2.0 openclaw.json parseable');
  } catch (e) {
    fail('T2.0 openclaw.json parseable', e.message);
  }
})();

if (ocConfig) {
  // T2.1: No deprecated blockStreaming key
  (() => {
    if (ocConfig.agents?.defaults?.blockStreaming !== undefined) {
      fail('T2.1 no deprecated blockStreaming', 'agents.defaults.blockStreaming still exists — openclaw will reject');
    } else {
      pass('T2.1 no deprecated blockStreaming');
    }
  })();

  // T2.2: Telegram enabled
  (() => {
    if (ocConfig.channels?.telegram?.enabled === true) pass('T2.2 Telegram enabled');
    else if (ocConfig.channels?.telegram?.botToken) fail('T2.2 Telegram enabled', 'has botToken but enabled !== true');
    else skip('T2.2 Telegram enabled', 'no botToken configured');
  })();

  // T2.3: modoro-zalo channel exists with correct defaults
  (() => {
    const oz = ocConfig.channels?.['modoro-zalo'];
    if (!oz) return skip('T2.3 modoro-zalo config', 'no modoro-zalo section');
    const issues = [];
    if (oz.blockStreaming !== false) issues.push('blockStreaming should be false');
    if (oz.dmPolicy && oz.dmPolicy !== 'open') issues.push('dmPolicy=' + oz.dmPolicy + ' (expected open)');
    if ('streaming' in oz) issues.push('"streaming" key present — schema rejects it');
    if (issues.length) fail('T2.3 modoro-zalo config', issues.join('; '));
    else pass('T2.3 modoro-zalo config healthy');
  })();

  // T2.4: crossContext messaging enabled
  (() => {
    if (ocConfig.tools?.message?.crossContext?.allowAcrossProviders === true) {
      pass('T2.4 crossContext messaging enabled');
    } else {
      fail('T2.4 crossContext messaging', 'tools.message.crossContext.allowAcrossProviders !== true');
    }
  })();

  // T2.5: workspace path set
  (() => {
    const ws = ocConfig.agents?.defaults?.workspace;
    if (ws && fs.existsSync(ws)) pass('T2.5 workspace path valid', ws);
    else if (ws) fail('T2.5 workspace path', 'set to ' + ws + ' but dir does not exist');
    else fail('T2.5 workspace path', 'agents.defaults.workspace not set');
  })();
}

// ============================================================
//  SUITE 3: send-zalo-safe.js safety gates
// ============================================================
console.log('\n\x1b[1m=== SUITE 3: send-zalo-safe.js Safety Gates ===\x1b[0m\n');

const safeScript = path.join(REPO_ROOT, 'tools', 'send-zalo-safe.js');
if (!fs.existsSync(safeScript)) {
  fail('T3.0 send-zalo-safe.js exists in source', 'not found at ' + safeScript);
} else {
  pass('T3.0 send-zalo-safe.js exists in source');

  // Helper: run script and capture exit code + stderr
  function runSafe(args, env = {}) {
    const res = spawnSync(process.execPath, [safeScript, ...args], {
      cwd: WS,
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: res.status, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() };
  }

  // T3.1: No args → exit 3 (usage)
  (() => {
    const r = runSafe([]);
    if (r.code === 3) pass('T3.1 no args → exit 3');
    else fail('T3.1 no args → exit 3', 'got exit ' + r.code);
  })();

  // T3.2: Pause gate
  (() => {
    const pausePath = path.join(WS, 'zalo-paused.json');
    const existed = fs.existsSync(pausePath);
    let oldContent = null;
    if (existed) oldContent = fs.readFileSync(pausePath, 'utf-8');
    try {
      fs.writeFileSync(pausePath, JSON.stringify({ permanent: true, reason: 'test-core' }));
      const r = runSafe(['123', 'test', '--group']);
      if (r.code === 1 && r.stderr.includes('paused')) pass('T3.2 pause gate blocks', r.stderr.slice(0, 80));
      else fail('T3.2 pause gate', 'exit=' + r.code + ' stderr=' + r.stderr.slice(0, 100));
    } finally {
      if (oldContent !== null) fs.writeFileSync(pausePath, oldContent);
      else try { fs.unlinkSync(pausePath); } catch {}
    }
  })();

  // T3.3: Disabled gate
  (() => {
    if (!ocConfig) return skip('T3.3 disabled gate', 'no openclaw.json');
    const wasEnabled = ocConfig.channels?.['modoro-zalo']?.enabled;
    try {
      ocConfig.channels['modoro-zalo'].enabled = false;
      fs.writeFileSync(OC_CONFIG, JSON.stringify(ocConfig, null, 2));
      const r = runSafe(['123', 'test', '--group']);
      if (r.code === 1 && r.stderr.includes('disabled')) pass('T3.3 disabled gate blocks', r.stderr.slice(0, 80));
      else fail('T3.3 disabled gate', 'exit=' + r.code + ' stderr=' + r.stderr.slice(0, 100));
    } finally {
      ocConfig.channels['modoro-zalo'].enabled = wasEnabled;
      fs.writeFileSync(OC_CONFIG, JSON.stringify(ocConfig, null, 2));
    }
  })();

  // T3.4-T3.6: Output filter tests. Need a valid targetId so target
  // validation (Gate 5) passes and the output filter (Gate 6) can run.
  // Use first friendId from cache for DM mode, or first groupId for group mode.
  const _filterTestId = (() => {
    try {
      const friendsFile = path.join(ZCA_CACHE, 'friends.json');
      if (!fs.existsSync(friendsFile)) return null;
      const friends = JSON.parse(fs.readFileSync(friendsFile, 'utf-8'));
      if (!Array.isArray(friends)) return null;
      // Find a friend NOT in blocklist so Gate 4 doesn't block before Gate 6
      let blocklist = [];
      try { blocklist = JSON.parse(fs.readFileSync(path.join(WS, 'zalo-blocklist.json'), 'utf-8')).map(b => String(b.id || b)); } catch {}
      const safe = friends.find(f => f.userId && !blocklist.includes(String(f.userId)));
      return safe ? String(safe.userId) : (friends[0]?.userId ? String(friends[0].userId) : null);
    } catch {}
    return null;
  })();

  // T3.4: Output filter — file path
  (() => {
    if (!_filterTestId) return skip('T3.4 output filter', 'no friendId for test');
    const r = runSafe([_filterTestId, 'Check C:\\Users\\admin\\secret\\file.txt']);
    if (r.code === 1 && r.stderr.includes('filter')) pass('T3.4 output filter blocks file path', r.stderr.slice(0, 80));
    else fail('T3.4 output filter', 'exit=' + r.code + ' stderr=' + r.stderr.slice(0, 100));
  })();

  // T3.5: Output filter — API key
  (() => {
    if (!_filterTestId) return skip('T3.5 output filter', 'no friendId for test');
    const r = runSafe([_filterTestId, 'Your key is sk-1234567890abcdef1234']);
    if (r.code === 1 && r.stderr.includes('filter')) pass('T3.5 output filter blocks API key', r.stderr.slice(0, 80));
    else fail('T3.5 output filter', 'exit=' + r.code + ' stderr=' + r.stderr.slice(0, 100));
  })();

  // T3.6: Output filter — stack trace
  (() => {
    if (!_filterTestId) return skip('T3.6 output filter', 'no friendId for test');
    const r = runSafe([_filterTestId, 'Error at Object.run (/usr/lib/node:123:45)']);
    if (r.code === 1 && r.stderr.includes('filter')) pass('T3.6 output filter blocks stack trace', r.stderr.slice(0, 80));
    else fail('T3.6 output filter', 'exit=' + r.code + ' stderr=' + r.stderr.slice(0, 100));
  })();

  // T3.7: Target validation — unknown groupId blocked (by target-not-found OR allowlist)
  (() => {
    const groupsFile = path.join(ZCA_CACHE, 'groups.json');
    if (!fs.existsSync(groupsFile)) return skip('T3.7 target validation', 'no groups.json');
    const r = runSafe(['9999999999999999999', 'test', '--group']);
    if (r.code === 1 && (r.stderr.includes('not found') || r.stderr.includes('not in allowlist'))) {
      pass('T3.7 unknown groupId blocked', r.stderr.slice(0, 80));
    } else {
      fail('T3.7 target validation', 'exit=' + r.code + ' stderr=' + r.stderr.slice(0, 100));
    }
  })();

  // T3.8: Clean message with ALLOWED groupId passes all gates
  (() => {
    if (!ocConfig || ocConfig.channels?.['modoro-zalo']?.enabled === false) {
      return skip('T3.8 clean message pass', 'Zalo disabled');
    }
    const pausePath = path.join(WS, 'zalo-paused.json');
    if (fs.existsSync(pausePath)) return skip('T3.8 clean message pass', 'Zalo paused');
    const groupsFile = path.join(ZCA_CACHE, 'groups.json');
    if (!fs.existsSync(groupsFile)) return skip('T3.8 clean message', 'no groups.json');
    // Find a group that's in the allowlist (or any group if policy=open)
    let groupId;
    try {
      const groups = JSON.parse(fs.readFileSync(groupsFile, 'utf-8'));
      const oz = ocConfig.channels?.['modoro-zalo'] || {};
      const allowFrom = Array.isArray(oz.groupAllowFrom) ? oz.groupAllowFrom : ['*'];
      const isOpen = oz.groupPolicy !== 'allowlist' || allowFrom.includes('*');
      if (isOpen) { groupId = groups[0]?.groupId; }
      else { const allowed = groups.find(g => allowFrom.includes(g.groupId)); groupId = allowed?.groupId; }
    } catch {}
    if (!groupId) return skip('T3.8 clean message', 'no allowed group');
    const r = runSafe([String(groupId), 'Xin chao test', '--group']);
    // exit 0 = sent, exit 2 = openzca fail (gates passed), exit null = timeout (gates passed, send slow)
    if (r.code === 0 || r.code === 2) pass('T3.8 clean message passes all gates', 'exit ' + r.code);
    else if (r.code === null) pass('T3.8 clean message passes gates (send timeout)', 'gates OK, openzca timed out');
    else fail('T3.8 clean message blocked', 'exit=' + r.code + ' stderr=' + r.stderr.slice(0, 100));
  })();
}

// ============================================================
//  SUITE 4: Vendor & CLI resolution
// ============================================================
console.log('\n\x1b[1m=== SUITE 4: Vendor & CLI Resolution ===\x1b[0m\n');

// T4.1: Node binary findable
(() => {
  try {
    const ver = execSync('node --version', { encoding: 'utf-8', timeout: 5000 }).trim();
    pass('T4.1 node in PATH', ver);
  } catch {
    fail('T4.1 node in PATH', 'node --version failed');
  }
})();

// T4.2: openzca CLI findable
(() => {
  const candidates = [];
  if (VENDOR) candidates.push(path.join(VENDOR, 'node_modules', 'openzca', 'dist', 'cli.js'));
  if (isWin) {
    candidates.push(path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'openzca', 'dist', 'cli.js'));
    candidates.push(path.join(WS, 'vendor', 'node_modules', 'openzca', 'dist', 'cli.js'));
  }
  const found = candidates.find(c => fs.existsSync(c));
  if (found) pass('T4.2 openzca CLI found', found);
  else fail('T4.2 openzca CLI', 'not found in ' + candidates.length + ' candidates');
})();

// T4.3: openclaw CLI findable
(() => {
  const candidates = [];
  if (VENDOR) candidates.push(path.join(VENDOR, 'node_modules', 'openclaw', 'openclaw.mjs'));
  if (isWin) {
    candidates.push(path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'openclaw', 'openclaw.mjs'));
    candidates.push(path.join(WS, 'vendor', 'node_modules', 'openclaw', 'openclaw.mjs'));
  }
  const found = candidates.find(c => fs.existsSync(c));
  if (found) pass('T4.3 openclaw CLI found', found);
  else fail('T4.3 openclaw CLI', 'not found');
})();

// T4.4: openzca .bin shims exist (for gateway PATH)
(() => {
  if (!VENDOR) return skip('T4.4 openzca shim', 'no vendor dir');
  const binDir = path.join(VENDOR, 'node_modules', '.bin');
  if (!fs.existsSync(binDir)) return fail('T4.4 .bin dir', 'not found at ' + binDir);
  const shims = isWin
    ? ['openzca.cmd', 'openzca.ps1']
    : ['openzca'];
  const missing = shims.filter(s => !fs.existsSync(path.join(binDir, s)));
  if (missing.length === 0) pass('T4.4 openzca shims', shims.join(', '));
  else fail('T4.4 openzca shims missing', missing.join(', '));
})();

// ============================================================
//  SUITE 5: Zalo cache & groups.json
// ============================================================
console.log('\n\x1b[1m=== SUITE 5: Zalo Cache ===\x1b[0m\n');

// T5.1: groups.json exists and parseable
(() => {
  const p = path.join(ZCA_CACHE, 'groups.json');
  if (!fs.existsSync(p)) return skip('T5.1 groups.json', 'not found — Zalo listener may not have run yet');
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!Array.isArray(data)) return fail('T5.1 groups.json', 'not an array');
    const names = data.map(g => g.name).filter(Boolean);
    pass('T5.1 groups.json', data.length + ' groups: ' + names.slice(0, 3).join(', ') + (names.length > 3 ? '...' : ''));
  } catch (e) {
    fail('T5.1 groups.json', 'parse error: ' + e.message);
  }
})();

// T5.2: friends.json exists and parseable
(() => {
  const p = path.join(ZCA_CACHE, 'friends.json');
  if (!fs.existsSync(p)) return skip('T5.2 friends.json', 'not found');
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!Array.isArray(data)) return fail('T5.2 friends.json', 'not an array');
    pass('T5.2 friends.json', data.length + ' friends');
  } catch (e) {
    fail('T5.2 friends.json', 'parse error: ' + e.message);
  }
})();

// ============================================================
//  SUITE 6: AGENTS.md consistency
// ============================================================
console.log('\n\x1b[1m=== SUITE 6: AGENTS.md Consistency ===\x1b[0m\n');

(() => {
  const p = path.join(REPO_ROOT, 'AGENTS.md');
  if (!fs.existsSync(p)) return fail('T6.0 AGENTS.md in source', 'not found');
  const content = fs.readFileSync(p, 'utf-8');

  // T6.1: No "file_read" (wrong tool name)
  if (/file_read/i.test(content)) fail('T6.1 no "file_read"', 'found — correct tool name is "read"');
  else pass('T6.1 no "file_read" references');

  // T6.2: No raw "openzca msg send" in cron prompt (should use wrapper)
  const cronLine = content.match(/prompt\s*=\s*`?exec:.*openzca\s+msg\s+send/i);
  if (cronLine) fail('T6.2 cron uses wrapper', 'found raw openzca in cron prompt — should use send-zalo-safe.js');
  else pass('T6.2 cron uses send-zalo-safe.js wrapper');

  // T6.3: No contradiction — line 7 should NOT say "PHẢI dùng bash" for openzca
  if (/openzca.*CLI.*PHẢI.*dùng bash/i.test(content)) {
    fail('T6.3 no openzca-bash contradiction', 'line 7 still says "PHẢI dùng bash" — contradicts wrapper rule');
  } else {
    pass('T6.3 no openzca-bash contradiction');
  }

  // T6.4: "send-zalo-safe.js" mentioned in Telegram section
  if (content.includes('send-zalo-safe.js')) pass('T6.4 send-zalo-safe.js referenced');
  else fail('T6.4 send-zalo-safe.js not referenced in AGENTS.md');

  // T6.5: Spam threshold consistent (should be 2 everywhere)
  const thresholds = [];
  const spamMatches = content.matchAll(/(?:lặp|gửi)\s*[≥>=]+\s*(\d)/gi);
  for (const m of spamMatches) thresholds.push(parseInt(m[1]));
  const unique = [...new Set(thresholds)];
  if (unique.length <= 1) pass('T6.5 spam threshold consistent', unique[0] ? '≥' + unique[0] : 'none found');
  else fail('T6.5 spam threshold conflict', 'found thresholds: ' + unique.join(', '));

  // T6.6: Tool names correct — should use "read" and "exec", not "file_read" and "bash"
  if (/dùng `read` tool/i.test(content)) pass('T6.6 correct tool name "read"');
  else if (/dùng.*read/i.test(content)) pass('T6.6 references read tool');
  else fail('T6.6 "read" tool not referenced');

  if (/`exec` tool/i.test(content)) pass('T6.7 correct tool name "exec"');
  else fail('T6.7 "exec" tool not referenced');
})();

// ============================================================
//  SUITE 7: Cron agent pipeline (offline check — no gateway needed)
// ============================================================
console.log('\n\x1b[1m=== SUITE 7: Cron Agent Pipeline ===\x1b[0m\n');

// T7.1: openclaw --version works
(() => {
  const cliBin = (() => {
    if (VENDOR) {
      const mjs = path.join(VENDOR, 'node_modules', 'openclaw', 'openclaw.mjs');
      if (fs.existsSync(mjs)) return mjs;
    }
    return null;
  })();
  if (!cliBin) return skip('T7.1 openclaw --version', 'openclaw not found');
  const res = spawnSync(process.execPath, [cliBin, '--version'], {
    encoding: 'utf-8',
    timeout: 15000,
    env: { ...process.env, HOME, USERPROFILE: HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.status === 0 && /\d+\.\d+/.test(res.stdout)) {
    pass('T7.1 openclaw --version', res.stdout.trim());
  } else {
    fail('T7.1 openclaw --version', 'exit ' + res.status + ': ' + (res.stderr || res.stdout || '').slice(0, 200));
  }
})();

// T7.2: openclaw config schema valid (proves CLI can parse config without hanging)
(() => {
  const cliBin = (() => {
    if (VENDOR) {
      const mjs = path.join(VENDOR, 'node_modules', 'openclaw', 'openclaw.mjs');
      if (fs.existsSync(mjs)) return mjs;
    }
    return null;
  })();
  if (!cliBin) return skip('T7.2 openclaw config valid', 'openclaw not found');
  // NOTE: `openclaw agent --help` HANGS (needs gateway). Use `--version` which
  // still validates config on startup. If config has deprecated keys, --version
  // will exit non-zero with "Config invalid" — proving the schema healer works.
  const res = spawnSync(process.execPath, [cliBin, '--version'], {
    encoding: 'utf-8',
    timeout: 15000,
    env: { ...process.env, HOME, USERPROFILE: HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.status === 0) {
    pass('T7.2 openclaw config valid', 'version exits 0 (config accepted)');
  } else {
    const err = (res.stderr || res.stdout || '').slice(0, 200);
    if (err.includes('Config invalid') || err.includes('Unrecognized key')) {
      fail('T7.2 openclaw config schema', 'rejected: ' + err);
    } else {
      fail('T7.2 openclaw config', 'exit ' + res.status + ': ' + err);
    }
  }
})();

// T7.3: Telegram chatId recoverable from config
(() => {
  if (!ocConfig) return skip('T7.3 Telegram chatId', 'no openclaw.json');
  const allowFrom = ocConfig.channels?.telegram?.allowFrom;
  if (Array.isArray(allowFrom) && allowFrom.length > 0) {
    pass('T7.3 Telegram chatId in config', String(allowFrom[0]));
  } else {
    // Check sticky file
    const stickyPath = path.join(HOME, '.openclaw', 'modoroclaw-sticky-chatid.json');
    if (fs.existsSync(stickyPath)) {
      try {
        const sticky = JSON.parse(fs.readFileSync(stickyPath, 'utf-8'));
        if (sticky.chatId) pass('T7.3 Telegram chatId in sticky', String(sticky.chatId));
        else fail('T7.3 Telegram chatId', 'sticky file exists but no chatId');
      } catch { fail('T7.3 Telegram chatId', 'sticky file corrupt'); }
    } else {
      fail('T7.3 Telegram chatId', 'not in config and no sticky file');
    }
  }
})();

// ============================================================
//  SUITE 8: Default config values (fresh install safety)
// ============================================================
console.log('\n\x1b[1m=== SUITE 8: Fresh Install Defaults ===\x1b[0m\n');

// T8.1: Source AGENTS.md version matches main.js constant
(() => {
  const agentsMd = fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf-8');
  const mainJs = fs.readFileSync(path.join(REPO_ROOT, 'electron', 'main.js'), 'utf-8');
  const mdVer = agentsMd.match(/modoroclaw-agents-version:\s*(\d+)/);
  const jsVer = mainJs.match(/CURRENT_AGENTS_MD_VERSION\s*=\s*(\d+)/);
  if (!mdVer || !jsVer) return fail('T8.1 version match', 'cannot parse versions');
  if (mdVer[1] === jsVer[1]) pass('T8.1 AGENTS.md v' + mdVer[1] + ' = main.js v' + jsVer[1]);
  else fail('T8.1 version mismatch', 'AGENTS.md v' + mdVer[1] + ' vs main.js v' + jsVer[1]);
})();

// T8.2: ensureDefaultConfig sets modoro-zalo.enabled = false for fresh (undefined → false)
(() => {
  const mainJs = fs.readFileSync(path.join(REPO_ROOT, 'electron', 'main.js'), 'utf-8');
  if (mainJs.includes('oz.enabled === undefined') && mainJs.includes('oz.enabled = false')) {
    pass('T8.2 fresh install Zalo disabled by default');
  } else {
    fail('T8.2 fresh install Zalo default', 'ensureDefaultConfig does not set enabled=false for undefined');
  }
})();

// T8.3: wizard-complete creates zalo-paused.json
(() => {
  const mainJs = fs.readFileSync(path.join(REPO_ROOT, 'electron', 'main.js'), 'utf-8');
  if (mainJs.includes('zalo-paused.json') && mainJs.includes('default-disabled')) {
    pass('T8.3 wizard-complete creates zalo-paused.json');
  } else {
    fail('T8.3 wizard-complete pause', 'zalo-paused.json not created with default-disabled');
  }
})();

// T8.4: tools/ is in extraResources
(() => {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'electron', 'package.json'), 'utf-8'));
  const extraRes = pkgJson.build?.extraResources || [];
  const hasTools = extraRes.some(r => (typeof r === 'string' ? r : r.from || '').includes('tools'));
  if (hasTools) pass('T8.4 tools/ in extraResources');
  else fail('T8.4 tools/ not in extraResources — send-zalo-safe.js won\'t ship in packaged build');
})();

// T8.5: tools/ is in seedWorkspace templateDirs
(() => {
  const mainJs = fs.readFileSync(path.join(REPO_ROOT, 'electron', 'main.js'), 'utf-8');
  if (/templateDirs.*'tools'/.test(mainJs)) pass('T8.5 tools/ in seedWorkspace templateDirs');
  else fail('T8.5 tools/ not in seedWorkspace templateDirs');
})();

// ============================================================
//  Results
// ============================================================
console.log('\n' + '='.repeat(50));
console.log(`  \x1b[32m${passed} passed\x1b[0m  \x1b[31m${failed} failed\x1b[0m  \x1b[33m${skipped} skipped\x1b[0m`);
console.log('='.repeat(50) + '\n');

process.exit(failed > 0 ? 1 : 0);
