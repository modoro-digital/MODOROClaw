#!/usr/bin/env node
/*
 * prebuild-vendor.js
 * ---------------------------------------------------------------
 * Pre-bake everything the packaged .app/.exe needs into electron/vendor/
 * so the user installs ZERO things on their machine. Works for BOTH
 * macOS .dmg AND Windows .exe builds.
 *
 * Output layout (after running):
 *   darwin:
 *     electron/vendor/
 *       node/bin/node                  ← real Node binary for darwin-<arch>
 *       node_modules/openclaw/         ← npm-installed openclaw
 *       node_modules/9router/          ← 9router AI proxy
 *       node_modules/openzca/          ← Zalo listener backend
 *       node_modules/@tuyenhx/openzalo ← Zalo plugin
 *
 *   win32:
 *     electron/vendor/
 *       node/node.exe                  ← real Node binary for win32-<arch>
 *       node/npm.cmd                   ← npm shim for child use
 *       node_modules/openclaw/         ← (same as Mac)
 *       node_modules/9router/
 *       node_modules/openzca/
 *       node_modules/@tuyenhx/openzalo
 *
 * electron-builder copies vendor/ → Resources/vendor/ via extraResources.
 * At runtime, main.js (getBundledNodeBin / getBundledOpenClawCliJs) detects
 * app.isPackaged and uses the bundled binary exclusively. Nothing on the
 * user's machine matters.
 *
 * Skipped on Linux (no MODOROClaw distribution for Linux yet).
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execSync, spawnSync } = require('child_process');
const os = require('os');

const NODE_VERSION = process.env.NODE_VENDOR_VERSION || 'v22.11.0';

// SHA256 checksums from https://nodejs.org/dist/<version>/SHASUMS256.txt
// Update when bumping NODE_VERSION. HTTPS protects against MITM but not
// against registry/CDN compromise — checksum verification catches both.
// To regenerate:
//   curl -s https://nodejs.org/dist/v22.11.0/SHASUMS256.txt | grep -E "darwin|win"
const NODE_CHECKSUMS = {
  'v22.11.0': {
    'darwin-arm64': '2e89afe6f4e3aa6c7e21c560d8a0453d84807e97850bbb819b998531a22bdfde',
    'darwin-x64':   '668d30b9512137b5f5baeef6c1bb4c46efff9a761ba990a034fb6b28b9da2465',
    'win32-x64':    '905373a059aecaf7f48c1ce10ffbd5334457ca00f678747f19db5ea7d256c236',
    'win32-arm64':  'b9ff5a6b6ffb68a0ffec82cc5664ed48247dabbd25ee6d129facd2f65a8ca80d',
  },
};

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
  // STRICT validation: only accept known platform values. If TARGET_PLATFORM
  // is set to something unexpected we want to fail loud instead of silently
  // falling back to host platform (which can cause CI to skip vendor build
  // when it should run).
  const explicit = (process.env.TARGET_PLATFORM || '').toLowerCase().trim();
  if (explicit) {
    if (explicit === 'darwin' || explicit === 'win32' || explicit === 'linux') return explicit;
    fatal(`TARGET_PLATFORM has invalid value: "${explicit}" (expected darwin|win32|linux)`);
  }
  return process.platform.toLowerCase();
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
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

// Returns the absolute path to the bundled `node` (or `node.exe`) inside
// VENDOR_NODE, accounting for layout differences:
//   darwin: <VENDOR_NODE>/bin/node       (extracted from tar.gz, has bin/)
//   win32:  <VENDOR_NODE>/node.exe       (extracted from zip, top-level)
function bundledNodeBinPath(platform) {
  if (platform === 'win32') return path.join(VENDOR_NODE, 'node.exe');
  return path.join(VENDOR_NODE, 'bin', 'node');
}

async function downloadAndExtractNode(platform, arch) {
  // Stamp file: store "<platform>-<arch>" so re-builds for the same target skip download
  const stamp = path.join(VENDOR_NODE, '.target');
  const stampValue = `${platform}-${arch}`;
  const expectedNodeBin = bundledNodeBinPath(platform);
  if (fs.existsSync(expectedNodeBin) &&
      fs.existsSync(stamp) &&
      fs.readFileSync(stamp, 'utf-8').trim() === stampValue) {
    log('Node binary already extracted for', stampValue, '— skipping download');
    return;
  }

  // Wipe stale dir from previous platform/arch
  rmrf(VENDOR_NODE);
  mkdirp(VENDOR_NODE);

  // Asset name + extension differ per platform:
  //   darwin: node-vX.Y.Z-darwin-<arch>.tar.gz   (use `tar -xzf`)
  //   win32:  node-vX.Y.Z-win-<arch>.zip          (use `tar -xf` — Win10+ has tar.exe)
  let assetName, isZip;
  if (platform === 'darwin') {
    assetName = `node-${NODE_VERSION}-darwin-${arch}.tar.gz`;
    isZip = false;
  } else if (platform === 'win32') {
    assetName = `node-${NODE_VERSION}-win-${arch}.zip`;
    isZip = true;
  } else {
    fatal(`Unsupported platform for Node bundling: ${platform}`);
  }

  const url = `https://nodejs.org/dist/${NODE_VERSION}/${assetName}`;
  const tmp = path.join(os.tmpdir(), assetName);

  await downloadFile(url, tmp);

  // Verify SHA256 checksum to catch tampered downloads. HTTPS protects MITM,
  // but a compromised CDN/mirror could still serve a poisoned tarball.
  const checksumKey = `${platform}-${arch}`;
  const expected = NODE_CHECKSUMS[NODE_VERSION]?.[checksumKey];
  if (expected) {
    const actual = sha256File(tmp);
    if (actual !== expected) {
      try { fs.unlinkSync(tmp); } catch {}
      fatal(
        `Node SHA256 mismatch for ${checksumKey}.\n` +
        `  Expected: ${expected}\n` +
        `  Got:      ${actual}\n` +
        `Refusing to bundle a tampered/corrupt Node binary.`
      );
    }
    log(`SHA256 verified for ${checksumKey}`);
  } else {
    warn(
      `No SHA256 checksum on file for ${NODE_VERSION}/${checksumKey}. ` +
      `UPDATE NODE_CHECKSUMS in prebuild-vendor.js with hash from ` +
      `https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`
    );
  }

  log('extracting...');
  // tar can extract both tar.gz AND zip via libarchive. --strip-components=1
  // removes the top-level `node-vX.Y.Z-<plat>-<arch>/` wrapper directory.
  //
  // CRITICAL: on Windows, the system tar.exe at %SystemRoot%\System32\tar.exe
  // (Win10 1803+) is BSD tar, which handles drive letters correctly. If we
  // shell out via Git Bash, we may pick up MSYS tar instead — which interprets
  // `C:\...` as a URL scheme and fails with "Cannot connect to C: resolve failed".
  // Spawn the system tar directly with shell:false to bypass the shell entirely.
  let tarBin = 'tar';
  if (process.platform === 'win32') {
    const sysTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(sysTar)) tarBin = sysTar;
    else warn('System tar.exe not found at SysRoot — extraction may fail in non-cmd shells');
  }
  const tarArgs = isZip
    ? ['-xf', tmp, '-C', VENDOR_NODE, '--strip-components=1']
    : ['-xzf', tmp, '-C', VENDOR_NODE, '--strip-components=1'];
  const tarRes = spawnSync(tarBin, tarArgs, { stdio: 'inherit', shell: false });
  if (tarRes.status !== 0) {
    fatal(`tar extraction failed (exit ${tarRes.status}): ${tarBin} ${tarArgs.join(' ')}`);
  }
  fs.unlinkSync(tmp);

  // Sanity check
  if (!fs.existsSync(expectedNodeBin)) fatal(`Node binary missing after extract: ${expectedNodeBin}`);
  if (platform !== 'win32') {
    try { fs.chmodSync(expectedNodeBin, 0o755); } catch {}
  }

  // Stamp so we can skip re-download next time
  fs.writeFileSync(stamp, stampValue + '\n');

  // Verify it runs (only when host can execute target binary — same platform)
  if (process.platform === platform) {
    try {
      const out = execSync(`"${expectedNodeBin}" --version`, { encoding: 'utf-8' }).trim();
      log('vendor node version:', out, `(${platform}-${arch})`);
    } catch (e) {
      warn('vendor node binary present but failed to run:', e.message);
      warn('(verify manually on target machine)');
    }
  } else {
    log(`vendor node downloaded for ${platform}-${arch} — host is ${process.platform}, skipping run check`);
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

  // Already installed AT THE PINNED VERSIONS? Skip. Check both file presence
  // AND version match — bumping a pinned version below MUST trigger reinstall
  // even though files exist.
  function readVendorVersion(pkgPath) {
    try { return require(path.resolve(pkgPath)).version || ''; } catch { return ''; }
  }
  const expectedVersions = {
    openclaw: '2026.4.5',
    '9router': '0.3.82',
    openzca: '0.1.57',
    '@tuyenhx/openzalo': '2026.3.31',
  };
  const installedVersions = {
    openclaw: readVendorVersion(path.join(VENDOR_NM, 'openclaw', 'package.json')),
    '9router': readVendorVersion(path.join(VENDOR_NM, '9router', 'package.json')),
    openzca: readVendorVersion(path.join(VENDOR_NM, 'openzca', 'package.json')),
    '@tuyenhx/openzalo': readVendorVersion(path.join(VENDOR_NM, '@tuyenhx', 'openzalo', 'package.json')),
  };
  const allMatch = Object.entries(expectedVersions).every(([k, v]) => installedVersions[k] === v);
  if (allMatch) {
    log('vendor packages already installed at pinned versions — skipping npm install');
    log('  versions: ' + Object.entries(installedVersions).map(([k, v]) => `${k}@${v}`).join(', '));
    return;
  } else {
    const drift = Object.entries(expectedVersions)
      .filter(([k, v]) => installedVersions[k] !== v)
      .map(([k, v]) => `${k}: have=${installedVersions[k] || 'missing'} want=${v}`);
    log('version drift detected, reinstalling: ' + drift.join(' | '));
  }

  // CRITICAL: openzca is REQUIRED for Zalo. The openzalo plugin spawns
  // openzca as a subprocess to maintain the Zalo websocket listener. Without
  // openzca bundled, fresh install of the packaged .dmg would load the
  // openzalo plugin successfully but the plugin would never spawn the
  // listener (silently), leaving Zalo dead with the user seeing a perpetual
  // red "waiting for gateway" dot. Documented root cause — see session log.
  //
  // CRITICAL #2: @tuyenhx/openzalo is the plugin PACKAGE itself. On fresh
  // install the openclaw gateway doesn't auto-install plugins from npm —
  // it expects them pre-extracted at ~/.openclaw/extensions/<plugin>/. By
  // bundling @tuyenhx/openzalo in vendor, main.js can copy it on first boot
  // with zero network dependency. No network, no failure.
  // ===== PINNED VERSIONS =====
  // CRITICAL: Pin EXACT versions to protect against upstream breakage. Without
  // pinning, every build fetches `latest` from npm — which means a single
  // upstream schema change (like the openclaw 2026.4.x rename of
  // `agents.defaults.blockStreaming` → `blockStreamingDefault`) can break
  // every fresh MODOROClaw install overnight, with zero warning.
  //
  // To upgrade: change the version below, run a smoke test, manually verify
  // wizard + cron + Zalo + Telegram still work, THEN ship a build.
  // See PINNING.md (root of repo) for the full upgrade procedure.
  const PINNED = [
    'openclaw@2026.4.5',
    '9router@0.3.82',
    'openzca@0.1.57',
    '@tuyenhx/openzalo@2026.3.31',
  ];

  log('npm install (PINNED versions): ' + PINNED.join(' '));
  // --no-package-lock so we don't litter the repo with another lockfile,
  // --no-audit + --no-fund for quieter CI logs,
  // --omit=dev so we don't drag in their devDependencies,
  // --save-exact so accidental future re-runs don't drift.
  const r = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', ...PINNED, '--save-exact', '--no-package-lock', '--no-audit', '--no-fund', '--omit=dev'],
    { cwd: VENDOR, stdio: 'inherit', shell: process.platform === 'win32' }
  );
  if (r.status !== 0) fatal(`npm install in vendor/ failed (exit ${r.status})`);

  // Sanity check — openclaw is mandatory
  const openclawMjs = path.join(VENDOR_NM, 'openclaw', 'openclaw.mjs');
  if (!fs.existsSync(openclawMjs)) fatal(`vendor openclaw.mjs missing: ${openclawMjs}`);
  log('✓ openclaw installed at', openclawMjs);

  // openzca is REQUIRED for Zalo — fatal if missing
  const openzcaCli = path.join(VENDOR_NM, 'openzca', 'dist', 'cli.js');
  if (!fs.existsSync(openzcaCli)) fatal(`vendor openzca/dist/cli.js missing: ${openzcaCli}`);
  log('✓ openzca installed at', openzcaCli);

  // 9router is REQUIRED — provides the AI router proxy. Without it, the
  // gateway has nothing to call for AI completions and bot replies are dead.
  // Previously this was "non-fatal" but that meant builds shipped silently
  // broken. Now we fail loud so the .dmg never ships missing 9router.
  const ninerouter = path.join(VENDOR_NM, '9router');
  if (!fs.existsSync(ninerouter)) {
    fatal(
      `vendor 9router missing: ${ninerouter}\n` +
      `9router is REQUIRED — without it the gateway has no AI provider and ` +
      `bot replies won't work. Refusing to ship a broken .app.`
    );
  }
  log('✓ 9router installed at', ninerouter);

  // @tuyenhx/openzalo is REQUIRED for Zalo. Without this pre-bundled, fresh
  // install would have to download the plugin from npm on first boot (which
  // requires network + working system npm — neither guaranteed on a fresh
  // Mac). With it bundled, main.js copies from vendor to extensions on first
  // run with zero network.
  const openzaloPlugin = path.join(VENDOR_NM, '@tuyenhx', 'openzalo', 'openclaw.plugin.json');
  if (!fs.existsSync(openzaloPlugin)) {
    fatal(
      `vendor @tuyenhx/openzalo missing: ${openzaloPlugin}\n` +
      `The Zalo plugin must be bundled — without it, Zalo cannot work on ` +
      `fresh Mac installs. Refusing to ship a broken .app.`
    );
  }
  log('✓ @tuyenhx/openzalo installed at', path.dirname(openzaloPlugin));
}

async function main() {
  const platform = detectTargetPlatform();
  if (platform !== 'darwin' && platform !== 'win32') {
    log(`platform=${platform} → skipping (vendor bundling only supported for darwin/win32)`);
    return;
  }

  const arch = detectTargetArch();
  log('target:', platform, arch, '   node', NODE_VERSION);

  mkdirp(VENDOR);

  await downloadAndExtractNode(platform, arch);
  npmInstallVendorPackages();

  log('vendor ready at', VENDOR);
}

main().catch((e) => {
  console.error('[prebuild-vendor] failed:', e);
  process.exit(1);
});
