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
function warn(msg) { console.warn('[fix-better-sqlite3] WARN:', msg); }

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

// Detect target arch — when building Mac DMG via electron-builder, the
// `npm_config_arch` env var is set to arm64 or x64. When running locally for
// dev, fall back to host arch. CRITICAL: prebuild-install must fetch the
// arch matching the FINAL build target, not the build machine. Otherwise an
// arm64 Mac building x64 .dmg ends up with arm64 better-sqlite3 binary inside
// an x64 app bundle → silent crash on launch.
function detectTargetArch() {
  const explicit = (process.env.npm_config_arch || process.env.TARGET_ARCH || '').toLowerCase().trim();
  if (explicit === 'arm64' || explicit === 'x64') return explicit;
  // electron-builder sometimes uses _CONFIG_ARCH
  const builder = (process.env._CONFIG_ARCH || '').toLowerCase().trim();
  if (builder === 'arm64' || builder === 'x64') return builder;
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

const targetArch = detectTargetArch();
const targetPlatform = (process.env.npm_config_platform || process.platform).toLowerCase();
log(`targeting Electron v${electronVersion}, platform=${targetPlatform}, arch=${targetArch}`);

const nodePath = path.join(bsqlDir, 'build', 'Release', 'better_sqlite3.node');
function isBinaryPresent() {
  return fs.existsSync(nodePath);
}

// Try to read the actual arch of the .node binary by parsing the Mach-O / PE header.
// On Mac the first 4 bytes are 0xfeedfacf (Mach-O 64-bit) followed by CPU type:
//   0x0100000c = arm64
//   0x01000007 = x86_64
// On Windows the .node is a PE DLL — header bytes 0x4d 0x5a (MZ).
// This is a best-effort sanity check, not full ABI verification.
function detectBinaryArch(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    // Mach-O 64-bit magic
    if (buf.readUInt32BE(0) === 0xfeedfacf || buf.readUInt32LE(0) === 0xfeedfacf) {
      const cpuType = buf.readUInt32LE(4);
      if (cpuType === 0x0100000c) return 'arm64';
      if (cpuType === 0x01000007) return 'x64';
    }
    // PE (Windows)
    if (buf[0] === 0x4d && buf[1] === 0x5a) return 'pe';
    // Linux ELF
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
      // ELF e_machine at offset 0x12
      const fd2 = fs.openSync(filePath, 'r');
      const m = Buffer.alloc(2);
      fs.readSync(fd2, m, 0, 2, 0x12);
      fs.closeSync(fd2);
      const machine = m.readUInt16LE(0);
      if (machine === 0xb7) return 'arm64';
      if (machine === 0x3e) return 'x64';
    }
  } catch {}
  return 'unknown';
}

function isBinaryUsable() {
  if (!isBinaryPresent()) return false;
  // On Mac, validate arch matches target. Cross-arch mismatch will silently
  // crash at runtime ("Bad CPU type in executable") so we want to catch it
  // here at build time. On Windows/Linux the check is informational only
  // (cross-build is rare).
  if (targetPlatform === 'darwin') {
    const actualArch = detectBinaryArch(nodePath);
    if (actualArch !== 'unknown' && actualArch !== targetArch) {
      warn(`binary arch=${actualArch} but target=${targetArch} — MISMATCH, refetching`);
      try { fs.unlinkSync(nodePath); } catch {}
      return false;
    }
    if (actualArch === targetArch) log(`✓ binary arch verified: ${actualArch}`);
  }
  return true;
}

function tryPrebuild() {
  try {
    log(`fetching prebuilt binary via prebuild-install (electron-${electronVersion}, ${targetPlatform}-${targetArch})...`);
    // Pass --platform and --arch explicitly so cross-builds get the right binary.
    // Without these, prebuild-install uses HOST arch which is wrong for
    // arm64-mac→x64-mac and vice versa.
    const archFlag = `--arch ${targetArch}`;
    const platformFlag = `--platform ${targetPlatform}`;
    execSync(
      `npx --yes prebuild-install -r electron -t ${electronVersion} ${archFlag} ${platformFlag}`,
      { cwd: bsqlDir, stdio: 'inherit' }
    );
    if (isBinaryUsable()) { log('prebuilt binary installed + verified'); return true; }
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
      `npx --yes @electron/rebuild -f -w better-sqlite3 -v ${electronVersion} --arch ${targetArch}`,
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
