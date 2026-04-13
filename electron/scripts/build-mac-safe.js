#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const arch = process.arch === 'arm64' ? 'arm64' : (process.arch === 'x64' ? 'x64' : null);

if (!arch) {
  console.error(`[build:mac] Unsupported host arch: ${process.arch}. Use build:mac:arm or build:mac:intel explicitly.`);
  process.exit(1);
}

const env = { ...process.env, TARGET_ARCH: arch };

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: false,
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`[build:mac] Safe build for host arch: ${arch}`);
run(process.execPath, [path.join(root, 'scripts', 'prebuild-vendor.js')]);
run(process.execPath, [path.join(root, 'scripts', 'smoke-test.js')]);
run(path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'), ['--mac', arch === 'arm64' ? '--arm64' : '--x64']);
