#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.resolve(ROOT, '..', 'dist');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

process.env.TARGET_PLATFORM = 'win32';
process.env.TARGET_ARCH = process.env.TARGET_ARCH || 'x64';

function run(cmd, args) {
  console.log(`[build-win] ${cmd} ${args.join(' ')}`);
  const quote = (value) => {
    const s = String(value);
    return /[\s&()]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
  };
  const res = spawnSync([cmd, ...args].map(quote).join(' '), {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
    shell: true,
  });
  if (res.status !== 0) {
    if (res.error) console.error('[build-win] spawn error:', res.error.message);
    if (res.signal) console.error('[build-win] terminated by signal:', res.signal);
    process.exit(res.status || 1);
  }
}

function removeIfExists(target) {
  try {
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      console.log('[build-win] removed stale artifact:', target);
    }
  } catch (e) {
    console.warn('[build-win] could not remove stale artifact:', target, e.message);
  }
}

removeIfExists(path.join(DIST, '9BizClaw Setup 2.4.0.exe'));
removeIfExists(path.join(DIST, 'win-unpacked'));

run(npmCmd, ['run', 'prebuild:vendor']);
run(npmCmd, ['run', 'smoke']);
run(npxCmd, ['electron-builder', '--win']);
run(process.execPath, ['scripts/fix-artifact-name.js']);
run(process.execPath, ['scripts/check-bundle-size.js', '--strict']);
