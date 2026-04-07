#!/usr/bin/env node
// Postinstall: ensure better-sqlite3 has a native binary that matches Electron's
// Node ABI (NODE_MODULE_VERSION 119 for Electron 28). Without this, fresh installs
// running `npm install` under system Node 22+ end up with the wrong .node file
// (compiled for NODE_MODULE_VERSION 137), and every Knowledge upload silently fails
// with "compiled against a different Node.js version".
//
// Strategy:
//  1. Read electron version from devDependencies (range — strip caret).
//  2. Run `prebuild-install -r electron -t <version>` inside better-sqlite3.
//  3. If that fails (no prebuilt), fall back to attempting an electron-rebuild.
//  4. On total failure, print a loud message but don't fail the install — the
//     app will detect the mismatch at runtime and surface an actionable error.
//
// CLAUDE.md Rule #1: this runs automatically on every `npm install` so fresh
// installs on a new machine never hit the ABI mismatch.

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const electronDir = path.dirname(__dirname); // electron/
const bsqlDir = path.join(electronDir, 'node_modules', 'better-sqlite3');
const electronPkgPath = path.join(electronDir, 'package.json');

function log(msg) { console.log('[fix-better-sqlite3]', msg); }

if (!fs.existsSync(bsqlDir)) {
  log('better-sqlite3 not installed yet — skipping');
  process.exit(0);
}

let electronVersion = '28.3.3';
try {
  const pkg = JSON.parse(fs.readFileSync(electronPkgPath, 'utf-8'));
  const dep = pkg.devDependencies && pkg.devDependencies.electron;
  if (dep) electronVersion = String(dep).replace(/^[\^~>=<\s]+/, '');
} catch {}

log('targeting Electron v' + electronVersion);

const nodePath = path.join(bsqlDir, 'build', 'Release', 'better_sqlite3.node');
function isBinaryUsable() {
  if (!fs.existsSync(nodePath)) return false;
  // We can't actually test ABI compat here without Electron at hand, but
  // presence of the file is a necessary condition.
  return true;
}

function tryPrebuild() {
  try {
    log('fetching prebuilt binary via prebuild-install...');
    execSync(
      `npx --yes prebuild-install -r electron -t ${electronVersion}`,
      { cwd: bsqlDir, stdio: 'inherit' }
    );
    if (isBinaryUsable()) { log('prebuilt binary installed'); return true; }
    return false;
  } catch (e) {
    log('prebuild-install failed: ' + (e.message || e));
    return false;
  }
}

function tryRebuild() {
  try {
    log('attempting electron-rebuild (requires C++ toolchain)...');
    execSync(
      `npx --yes @electron/rebuild -f -w better-sqlite3 -v ${electronVersion}`,
      { cwd: electronDir, stdio: 'inherit' }
    );
    if (isBinaryUsable()) { log('electron-rebuild succeeded'); return true; }
    return false;
  } catch (e) {
    log('electron-rebuild failed: ' + (e.message || e));
    return false;
  }
}

if (tryPrebuild() || tryRebuild()) {
  log('done — better-sqlite3 ready for Electron');
  process.exit(0);
}

console.error('');
console.error('================================================================');
console.error('  WARNING: better-sqlite3 native binary may be incompatible with');
console.error('  Electron v' + electronVersion + '. Knowledge tab uploads will silently fail.');
console.error('  ');
console.error('  Manual fix:');
console.error('    cd electron/node_modules/better-sqlite3');
console.error('    npx prebuild-install -r electron -t ' + electronVersion);
console.error('================================================================');
console.error('');
// Don't fail npm install — runtime detection will surface the error to the user.
process.exit(0);
