#!/usr/bin/env node
/*
 * prebuild-vendor.js
 * ---------------------------------------------------------------
 * Pre-bake everything the packaged Mac .app needs into electron/vendor/
 * so the user installs ZERO things on their machine.
 *
 * Output layout (after running):
 *   electron/vendor/
 *     node/bin/node                ← real Node binary for darwin-<arch>
 *     node_modules/openclaw/       ← npm-installed openclaw
 *     node_modules/9router/        ← npm-installed 9router
 *     node_modules/.bin/           ← shims
 *
 * electron-builder copies vendor/ → Resources/vendor/ via extraResources.
 * At runtime, main.js detects app.isPackaged and uses
 *   process.resourcesPath/vendor/node/bin/node
 *   process.resourcesPath/vendor/node_modules/openclaw/openclaw.mjs
 * exclusively. Nothing on the user's machine matters.
 *
 * Skipped on Windows (Win build doesn't need a Mac vendor dir).
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync, spawnSync } = require('child_process');
const os = require('os');

const NODE_VERSION = process.env.NODE_VENDOR_VERSION || 'v22.11.0';

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');
const VENDOR_NODE = path.join(VENDOR, 'node');
const VENDOR_NM = path.join(VENDOR, 'node_modules');

function log(...args) { console.log('[prebuild-vendor]', ...args); }
function warn(...args) { console.warn('[prebuild-vendor] WARN:', ...args); }
function fatal(msg) { console.error('[prebuild-vendor] FATAL:', msg); process.exit(1); }

function detectTargetArch() {
  // CI passes TARGET_ARCH=arm64|x64. Locally fall back to host arch.
  let a = (process.env.TARGET_ARCH || '').toLowerCase().trim();
  if (a === 'arm64' || a === 'x64') return a;
  // electron-builder sets npm_config_arch when invoked with --arm64/--x64
  a = (process.env.npm_config_arch || '').toLowerCase().trim();
  if (a === 'arm64' || a === 'x64') return a;
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

function detectTargetPlatform() {
  // Right now only `darwin` (macOS) needs vendor. Win/Linux skipped.
  return (process.env.TARGET_PLATFORM || process.platform).toLowerCase();
}

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    log('downloading:', url);
    const file = fs.createWriteStream(dest);
    const get = (u, redirectsLeft) => {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
          return get(res.headers.location, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      }).on('error', reject);
    };
    get(url, 5);
  });
}

async function downloadAndExtractNode(arch) {
  // Skip if already done for this arch
  const stamp = path.join(VENDOR_NODE, '.arch');
  if (fs.existsSync(path.join(VENDOR_NODE, 'bin', 'node')) &&
      fs.existsSync(stamp) &&
      fs.readFileSync(stamp, 'utf-8').trim() === arch) {
    log('Node binary already extracted for arch', arch, '— skipping download');
    return;
  }

  // Wipe stale dir from previous arch
  rmrf(VENDOR_NODE);
  mkdirp(VENDOR_NODE);

  const tarName = `node-${NODE_VERSION}-darwin-${arch}.tar.gz`;
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${tarName}`;
  const tmp = path.join(os.tmpdir(), tarName);

  await downloadFile(url, tmp);

  log('extracting...');
  // Use system tar — both macOS and Linux runners have it. Windows doesn't,
  // but we already early-exit on Windows so this never runs there.
  execSync(`tar -xzf "${tmp}" -C "${VENDOR_NODE}" --strip-components=1`, {
    stdio: 'inherit',
  });
  fs.unlinkSync(tmp);

  // Sanity check
  const nodeBin = path.join(VENDOR_NODE, 'bin', 'node');
  if (!fs.existsSync(nodeBin)) fatal(`Node binary missing after extract: ${nodeBin}`);
  fs.chmodSync(nodeBin, 0o755);

  // Stamp arch so we can skip re-download next time
  fs.writeFileSync(stamp, arch + '\n');

  // Verify it runs
  try {
    const out = execSync(`"${nodeBin}" --version`, { encoding: 'utf-8' }).trim();
    log('vendor node version:', out, `(${arch})`);
  } catch (e) {
    warn('vendor node binary present but failed to run:', e.message);
    warn('(this is OK if cross-building from a different arch — just verify on target machine)');
  }
}

function npmInstallVendorPackages() {
  // Install openclaw + 9router into vendor/node_modules. We use a fake
  // package.json so npm has somewhere to install relative to.
  mkdirp(VENDOR);
  const fakePkg = path.join(VENDOR, 'package.json');
  if (!fs.existsSync(fakePkg)) {
    fs.writeFileSync(fakePkg, JSON.stringify({
      name: 'modoroclaw-vendor',
      version: '0.0.0',
      private: true,
      description: 'Bundled CLI dependencies for the packaged MODOROClaw .app',
    }, null, 2) + '\n');
  }

  // Already installed? Skip.
  if (fs.existsSync(path.join(VENDOR_NM, 'openclaw', 'openclaw.mjs')) &&
      fs.existsSync(path.join(VENDOR_NM, '9router'))) {
    log('vendor packages already installed — skipping npm install');
    return;
  }

  log('npm install openclaw + 9router into vendor/...');
  // --no-package-lock so we don't litter the repo with another lockfile,
  // --no-audit + --no-fund for quieter CI logs,
  // --omit=dev so we don't drag in their devDependencies.
  const r = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', 'openclaw', '9router', '--no-package-lock', '--no-audit', '--no-fund', '--omit=dev'],
    { cwd: VENDOR, stdio: 'inherit', shell: process.platform === 'win32' }
  );
  if (r.status !== 0) fatal(`npm install in vendor/ failed (exit ${r.status})`);

  // Sanity check
  const openclawMjs = path.join(VENDOR_NM, 'openclaw', 'openclaw.mjs');
  if (!fs.existsSync(openclawMjs)) fatal(`vendor openclaw.mjs missing: ${openclawMjs}`);
  log('✓ openclaw installed at', openclawMjs);

  const ninerouter = path.join(VENDOR_NM, '9router');
  if (fs.existsSync(ninerouter)) {
    log('✓ 9router installed at', ninerouter);
  } else {
    warn('9router not installed (non-fatal — 9Router tab will be empty in app)');
  }
}

async function main() {
  const platform = detectTargetPlatform();
  if (platform !== 'darwin') {
    log(`platform=${platform} → skipping (vendor dir is only needed for macOS .app builds)`);
    return;
  }

  const arch = detectTargetArch();
  log('target: darwin', arch, '   node', NODE_VERSION);

  mkdirp(VENDOR);

  await downloadAndExtractNode(arch);
  npmInstallVendorPackages();

  log('✅ vendor ready at', VENDOR);
}

main().catch((e) => {
  console.error('[prebuild-vendor] failed:', e);
  process.exit(1);
});
