#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const monitor = fs.readFileSync(path.join(root, 'packages', 'modoro-zalo', 'src', 'monitor.ts'), 'utf8');
const channels = fs.readFileSync(path.join(root, 'lib', 'channels.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const failures = [];

function requireMatch(label, pattern) {
  if (!pattern.test(monitor)) failures.push(`${label}: missing ${pattern}`);
}

function forbidMatch(label, pattern) {
  if (pattern.test(monitor)) failures.push(`${label}: still matches ${pattern}`);
}

requireMatch('credential version helper', /function\s+readOpenzcaCredentialsVersion\s*\(/);
requireMatch('credential-aware sleep helper', /export\s+async\s+function\s+sleepWithAbortOrCredentialChange\s*\(/);
requireMatch('circuit breaker wakes on credential refresh', /sleepWithAbortOrCredentialChange\s*\(\s*MODORO_ZALO_CIRCUIT_BREAKER_COOLDOWN_MS/);
requireMatch('normal reconnect delay wakes on credential refresh', /sleepWithAbortOrCredentialChange\s*\(\s*delayMs/);
requireMatch('listener exit logs exit code', /listener exited \(code=\$\{streamExitCode/);
if (!/function\s+_execPowerShell\s*\(/.test(channels)) {
  failures.push('windows listener probe: missing execFileSync PowerShell wrapper');
}
if (/execSync\s*\(\s*`powershell\b/i.test(channels) || /execSync\s*\(\s*'powershell\b/i.test(channels)) {
  failures.push('windows listener probe: raw shell powershell call can break on C:\\Program Files paths');
}
forbidMatch(
  'stale self id guard',
  /if\s*\(!selfId\)\s*\{[\s\S]{0,800}?runOpenzcaCommand/,
);

if (!pkg.scripts || !String(pkg.scripts['guard:architecture'] || '').includes('guard:zalo-listener')) {
  failures.push('package guard chain: guard:architecture must include guard:zalo-listener');
}

if (failures.length) {
  console.error('[zalo-listener-recovery] FAIL');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}

console.log('[zalo-listener-recovery] PASS listener reconnect handles credentials refresh and stale self id');
