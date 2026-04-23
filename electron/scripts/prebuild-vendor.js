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
 * Skipped on Linux (no 9BizClaw distribution for Linux yet).
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execSync, spawnSync } = require('child_process');
const os = require('os');

// openclaw requires Node >=22.14.0. We pin to v22.22.2 (latest 22.x
// LTS as of 2026-04) to give plenty of headroom above openclaw's minimum and
// avoid another "requires Node >=X.Y.Z" surprise after every openclaw bump.
// Previous bumps: v22.11.0 → v22.12.0 (insufficient) → v22.22.2.
const NODE_VERSION = process.env.NODE_VENDOR_VERSION || 'v22.22.2';

// SHA256 checksums from https://nodejs.org/dist/<version>/SHASUMS256.txt
// Update when bumping NODE_VERSION. HTTPS protects against MITM but not
// against registry/CDN compromise — checksum verification catches both.
// To regenerate:
//   curl -s https://nodejs.org/dist/v22.22.2/SHASUMS256.txt | grep -E "darwin|win-"
const NODE_CHECKSUMS = {
  'v22.22.2': {
    'darwin-arm64': 'db4b275b83736df67533529a18cc55de2549a8329ace6c7bcc68f8d22d3c9000',
    'darwin-x64':   '12a6abb9c2902cf48a21120da13f87fde1ed1b71a13330712949e8db818708ba',
    'win32-x64':    '7c93e9d92bf68c07182b471aa187e35ee6cd08ef0f24ab060dfff605fcc1c57c',
    'win32-arm64':  '380d375cf650c5a7f2ef3ce29ac6ea9a1c9d2ec8ea8e8391e1a34fd543886ab3',
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
      description: 'Bundled CLI dependencies for the packaged 9BizClaw .app',
    }, null, 2) + '\n');
  }

  // Already installed AT THE PINNED VERSIONS? Skip. Check both file presence
  // AND version match — bumping a pinned version below MUST trigger reinstall
  // even though files exist.
  function readVendorVersion(pkgPath) {
    try { return require(path.resolve(pkgPath)).version || ''; } catch { return ''; }
  }
  const expectedVersions = {
    openclaw: '2026.4.14',
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
  // Arch marker — vendor/node_modules has native binaries (better-sqlite3 etc).
  // Cached install from a previous build for a DIFFERENT arch (e.g. last build
  // was --x64, now --arm64) MUST trigger reinstall, otherwise we ship an x64
  // .node into an arm64 .dmg (and 9router HTTP 500 on first launch).
  const platform = detectTargetPlatform();
  const arch = detectTargetArch();
  const archKey = `${platform}-${arch}`;
  const archMarkerPath = path.join(VENDOR, '.vendor-arch');
  const cachedArch = (() => { try { return fs.readFileSync(archMarkerPath, 'utf8').trim(); } catch { return ''; } })();
  const archMatch = cachedArch === archKey;
  if (allMatch && archMatch) {
    log('vendor packages already installed at pinned versions + matching arch — skipping npm install');
    log('  versions: ' + Object.entries(installedVersions).map(([k, v]) => `${k}@${v}`).join(', '));
    log('  arch: ' + archKey);
    return;
  } else if (allMatch && !archMatch) {
    log(`arch drift detected: cached=${cachedArch || 'none'} target=${archKey} — wiping vendor/node_modules to force native rebuild`);
    try { fs.rmSync(VENDOR_NM, { recursive: true, force: true }); } catch {}
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
  // every fresh 9BizClaw install overnight, with zero warning.
  //
  // To upgrade: change the version below, run a smoke test, manually verify
  // wizard + cron + Zalo + Telegram still work, THEN ship a build.
  // See PINNING.md (root of repo) for the full upgrade procedure.
  const PINNED = [
    'openclaw@2026.4.14',
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

  // Stamp arch marker so next prebuild can detect arch drift and force rebuild.
  try {
    fs.writeFileSync(archMarkerPath, archKey + '\n');
    log('✓ wrote arch marker:', archKey);
  } catch (e) {
    warn('failed to write arch marker (non-fatal):', e.message);
  }
}

// Read the CPU architecture from a Mach-O / PE / ELF native binary header.
// Used to verify better-sqlite3.node arch BEFORE shipping to users.
// Returns 'arm64' | 'x64' | 'pe' | 'elf-arm64' | 'elf-x64' | 'unknown'.
function detectBinaryArch(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    // Mach-O 64-bit magic (little-endian or big-endian)
    if (buf.readUInt32BE(0) === 0xfeedfacf || buf.readUInt32LE(0) === 0xfeedfacf) {
      const cpuType = buf.readUInt32LE(4);
      if (cpuType === 0x0100000c) return 'arm64';
      if (cpuType === 0x01000007) return 'x64';
      return 'macho-unknown';
    }
    // PE (Windows .dll / .node)
    if (buf[0] === 0x4d && buf[1] === 0x5a) return 'pe';
    // ELF (Linux)
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
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

// Rebuild better-sqlite3 inside 9router's bundled Next.js app dir so it
// matches the bundled Node binary (v22.x, not Electron). Without this step
// the binary 9router ships in its npm package was compiled on the 9router
// author's build machine — which may be a different arch or Node ABI.
//
// Root cause of "HTTP 500 on Mac wizard Thiết lập AI": 9router's
// better-sqlite3 is arm64 in the package but running on x64 Mac (or the
// reverse). Node can't load it → SQLite operations crash the server process
// → every 9router API call returns 500.
//
// Strategy:
//  1. Check if better_sqlite3.node exists; parse its Mach-O header.
//  2. If arch doesn't match target → use prebuild-install to fetch the right
//     prebuilt binary for plain Node (not Electron) at NODE_VERSION + arch.
//  3. If prebuild-install fails → fall back to node-pre-gyp rebuild (needs
//     C++ toolchain, which CI/dev machines have but user machines don't — this
//     is only a build-time step so that's fine).
//  4. Non-fatal: if both fail, log a loud warning and continue. The binary
//     mismatch will surface as a 500 error for the user.
function fixNineRouterNativeModules(platform, arch) {
  if (platform !== 'darwin' && platform !== 'win32') return;

  const nineRouterAppNm = path.join(VENDOR_NM, '9router', 'app', 'node_modules');
  if (!fs.existsSync(nineRouterAppNm)) {
    log('9router/app/node_modules not found — skipping native module fix');
    return;
  }

  const bsqlDir = path.join(nineRouterAppNm, 'better-sqlite3');
  if (!fs.existsSync(bsqlDir)) {
    log('9router/app/node_modules/better-sqlite3 not found — skipping');
    return;
  }

  const bsqlBin = path.join(bsqlDir, 'build', 'Release', 'better_sqlite3.node');

  // Stamp tracks platform-arch-nodeVersion. Arch match alone is insufficient:
  // a binary compiled for arm64+Node18 passes the arch check but crashes with
  // Node22 (different ABI). We must rebuild whenever Node version changes too.
  const stampFile = path.join(bsqlDir, '.prebuild-stamp');
  const expectedStamp = `${platform}-${arch}-node${NODE_VERSION}`;

  if (fs.existsSync(bsqlBin) && fs.existsSync(stampFile)) {
    const actualStamp = fs.readFileSync(stampFile, 'utf-8').trim();
    if (actualStamp === expectedStamp) {
      log(`✓ 9router better-sqlite3 already built for ${expectedStamp} — skipping`);
      return;
    }
    log(`9router better-sqlite3 stamp="${actualStamp}" but need "${expectedStamp}" — rebuilding`);
  } else if (fs.existsSync(bsqlBin)) {
    // Binary exists but no stamp — could be wrong Node ABI even if arch matches.
    // Always rebuild so we write a stamp and future runs can skip safely.
    const actualArch = detectBinaryArch(bsqlBin);
    log(`9router better-sqlite3 arch=${actualArch} but no ABI stamp — rebuilding for ${expectedStamp}`);
  } else {
    log('9router better-sqlite3 binary missing — building from source');
  }

  // Try prebuild-install (prebuilt binary for Node, not Electron)
  const bundledNode = bundledNodeBinPath(platform);
  const nodeVersionBare = NODE_VERSION.replace(/^v/, ''); // '22.22.2'

  // prebuild-install may not be in PATH so we run it via npx or direct path.
  // Use bundled Node so the ABI version is exactly right.
  const prebuildScript = path.join(nineRouterAppNm, '.bin', 'prebuild-install');
  const prebuildAvailable = fs.existsSync(prebuildScript);

  if (prebuildAvailable) {
    log(`running prebuild-install for 9router better-sqlite3 (node-${nodeVersionBare}, ${platform}-${arch})...`);
    const r = spawnSync(bundledNode, [
      prebuildScript,
      '-r', 'node',
      '-t', nodeVersionBare,
      '--arch', arch,
      '--platform', platform === 'darwin' ? 'darwin' : 'win32',
    ], { cwd: bsqlDir, stdio: 'inherit', shell: false });
    if (r.status === 0 && fs.existsSync(bsqlBin)) {
      const verifiedArch = detectBinaryArch(bsqlBin);
      fs.writeFileSync(stampFile, expectedStamp + '\n');
      log(`✓ 9router better-sqlite3 rebuilt — arch=${verifiedArch}`);
      return;
    }
    warn('prebuild-install for 9router better-sqlite3 failed — trying node-pre-gyp');
  }

  // Fallback: node-pre-gyp rebuild (needs C++ toolchain on build machine)
  const nodePreGyp = path.join(nineRouterAppNm, '.bin', 'node-pre-gyp');
  if (fs.existsSync(nodePreGyp)) {
    log('running node-pre-gyp rebuild for 9router better-sqlite3...');
    const r = spawnSync(bundledNode, [
      nodePreGyp, 'rebuild',
      `--target=${nodeVersionBare}`,
      `--target_arch=${arch}`,
      `--target_platform=${platform === 'darwin' ? 'darwin' : 'win32'}`,
    ], { cwd: bsqlDir, stdio: 'inherit', shell: false });
    if (r.status === 0 && fs.existsSync(bsqlBin)) {
      fs.writeFileSync(stampFile, expectedStamp + '\n');
      log('✓ 9router better-sqlite3 rebuilt via node-pre-gyp');
      return;
    }
  }

  // Last resort: use npx prebuild-install (will download if needed)
  log('trying npx prebuild-install as last resort...');
  const npm = platform === 'win32'
    ? path.join(VENDOR_NODE, 'npm.cmd')
    : path.join(VENDOR_NODE, 'bin', 'npm');
  const npxBin = fs.existsSync(npm)
    ? npm.replace('npm', 'npx')
    : (platform === 'win32' ? 'npx.cmd' : 'npx');
  const r = spawnSync(npxBin, [
    '--yes', 'prebuild-install',
    '-r', 'node',
    '-t', nodeVersionBare,
    '--arch', arch,
  ], { cwd: bsqlDir, stdio: 'inherit', shell: platform === 'win32' });
  if (r.status === 0 && fs.existsSync(bsqlBin)) {
    fs.writeFileSync(stampFile, expectedStamp + '\n');
    log('✓ 9router better-sqlite3 rebuilt via npx prebuild-install');
    return;
  }

  warn(
    '9router better-sqlite3 rebuild FAILED on all attempts.\n' +
    '  Users on this architecture will see HTTP 500 when connecting AI providers in wizard.\n' +
    '  Manual fix: cd vendor/node_modules/9router/app/node_modules/better-sqlite3 &&\n' +
    `  npx prebuild-install -r node -t ${nodeVersionBare} --arch ${arch}`
  );
}

// On Windows ONLY, pack vendor/ into a single uncompressed tar + write a
// meta.json sidecar. Reason: shipping ~50,000 loose files through NSIS is
// pathologically slow (each file hits MFT + NTFS journal + Defender scan,
// ~3-5 ms per file → 5-10 minutes install on a slow SSD). Shipping ONE big
// file hits SSD's sequential write ceiling instead → 20-30 seconds install.
// NSIS LZMA will compress the .tar during EXE packaging — no gzip needed
// (double-compression loses efficiency).
//
// The EXE ships BOTH the .tar AND vendor-meta.json under resources/.
// On first app launch, main.js reads meta → extracts tar → userData/vendor/.
// Subsequent launches skip extraction (meta.bundle_version matches userData
// vendor-version.txt).
//
// Mac DMG is untouched — drag-drop APFS copy is already fast enough.
function packVendorForWindows() {
  if (process.platform !== 'win32' && detectTargetPlatform() !== 'win32') return;

  log('packing vendor/ → vendor-bundle.tar for Windows (one-big-file install)...');

  const tarPath = path.join(ROOT, 'vendor-bundle.tar');
  const metaPath = path.join(ROOT, 'vendor-meta.json');

  // Count total ENTRIES (files + directories) and raw bytes.
  // tar verbose output prints one line per entry INCLUDING directories, so
  // splash progress bar must match this count — previous version counted
  // only files → extraction showed >100% because tar lines > file count.
  let entryCount = 0;
  let totalBytes = 0;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        entryCount++; // count the dir itself
        walk(full);
      } else if (entry.isFile()) {
        entryCount++;
        try { totalBytes += fs.statSync(full).size; } catch {}
      }
    }
  }
  // Also count the top-level 'vendor' dir tar adds as an entry
  entryCount++;
  walk(VENDOR);
  log(`  ${entryCount} tar entries (files + dirs), ${(totalBytes / 1024 / 1024).toFixed(1)} MB raw`);

  // Remove stale archive from previous builds
  if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);

  // Use Windows native tar.exe (BSD tar) — same binary prebuild uses for extract.
  // Create uncompressed tar (no -z) — NSIS LZMA will compress better at build time.
  // -C ROOT, archive just "vendor" subdir so extract restores as vendor/ cleanly.
  // NOTE: archiving the entire vendor/ directory recursively pulls in everything
  // under it, including vendor/models/Xenova/... (produced by prebuild-models.js,
  // chained before prebuild-vendor in package.json). No extra include list needed
  // — if prebuild-models ran, models ship in the tar; if it didn't, tar just has
  // node/ + node_modules/ and RAG smoke will warn+skip instead of fail.
  const tarBin = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const tarArgs = ['-cf', tarPath, '-C', ROOT, 'vendor'];
  log(`  running: ${tarBin} ${tarArgs.join(' ')}`);
  const tarRes = spawnSync(tarBin, tarArgs, { stdio: 'inherit', shell: false });
  if (tarRes.status !== 0) fatal(`tar pack failed (exit ${tarRes.status})`);
  if (!fs.existsSync(tarPath)) fatal(`tar created exit 0 but file missing: ${tarPath}`);

  const tarSize = fs.statSync(tarPath).size;
  log(`  ✓ vendor-bundle.tar = ${(tarSize / 1024 / 1024).toFixed(1)} MB`);

  // SHA256 the tar so first-launch extract can verify integrity before touching disk
  const tarSha256 = sha256File(tarPath);
  log(`  sha256: ${tarSha256}`);

  // Bundle version: deterministic fingerprint based on Node + openclaw version
  // + platform. NO Date.now() — otherwise every build forces a 2-minute
  // re-extract on customer machines even when vendor contents are identical.
  const bundleVersion = `${NODE_VERSION}_openclaw-2026.4.14_${process.platform}-${process.arch}`;

  // H7: per-model-file SHA so runtime can verify extracted .onnx wasn't
  // swapped (user-writable %APPDATA% on Windows). Read hashes from
  // prebuild-models.js pinned list (same source of truth).
  const modelSha = {};
  try {
    const modelDir = path.join(VENDOR, 'models', 'Xenova', 'multilingual-e5-small');
    const modelOnnx = path.join(modelDir, 'onnx', 'model_quantized.onnx');
    if (fs.existsSync(modelOnnx)) {
      modelSha['model_quantized.onnx'] = sha256File(modelOnnx);
    }
    const tokenizerJson = path.join(modelDir, 'tokenizer.json');
    if (fs.existsSync(tokenizerJson)) {
      modelSha['tokenizer.json'] = sha256File(tokenizerJson);
    }
  } catch (e) {
    warn('model SHA collection failed:', e.message);
  }

  const meta = {
    version: 1,
    filename: 'vendor-bundle.tar',
    file_count: entryCount, // kept for backwards-compat but now = entry_count
    entry_count: entryCount, // total tar entries (files + dirs)
    unpacked_bytes: totalBytes,
    archive_bytes: tarSize,
    bundle_version: bundleVersion,
    sha256: tarSha256,
    modelSha,
    created_at: new Date().toISOString(),
    node_version: NODE_VERSION,
    target_platform: 'win32',
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  log(`  ✓ vendor-meta.json written`);

  // DELETE vendor/ directory after packing — we ship the tar, not the directory.
  // electron-builder must not copy vendor/ (would double-bundle). This is safe
  // because next build iteration will re-extract Node + re-npm-install fresh.
  log('  removing vendor/ directory (will be re-created on next build)...');
  rmrf(VENDOR);
  log('  ✓ vendor/ removed (ship vendor-bundle.tar instead)');
}

async function main() {
  const platform = detectTargetPlatform();
  if (platform !== 'darwin' && platform !== 'win32') {
    log(`platform=${platform} → skipping (vendor bundling only supported for darwin/win32)`);
    return;
  }

  const arch = detectTargetArch();
  log('target:', platform, arch, '   node', NODE_VERSION);

  // Skip everything if vendor-bundle.tar + meta already exist and match pinned
  // versions. Saves ~4 minutes on rebuild when nothing has changed.
  if (platform === 'win32') {
    const tarPath = path.join(ROOT, 'vendor-bundle.tar');
    const metaPath = path.join(ROOT, 'vendor-meta.json');
    if (fs.existsSync(tarPath) && fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (meta.node_version === NODE_VERSION && meta.bundle_version && meta.sha256) {
          // Verify tar integrity hasn't been tampered with since meta was written
          const actualSha = sha256File(tarPath);
          if (actualSha === meta.sha256) {
            log('vendor-bundle.tar already built for', NODE_VERSION, '— skipping rebuild');
            log('  file:', tarPath);
            log('  file_count:', meta.file_count);
            log('  archive_bytes:', (meta.archive_bytes / 1024 / 1024).toFixed(1), 'MB');
            return;
          } else {
            warn('vendor-bundle.tar SHA mismatch vs meta — rebuilding');
          }
        }
      } catch (e) {
        warn('vendor-meta.json unreadable — rebuilding:', e.message);
      }
    }
  }

  mkdirp(VENDOR);

  await downloadAndExtractNode(platform, arch);
  npmInstallVendorPackages();
  fixNineRouterNativeModules(platform, arch);

  // Apply vendor patches at BUILD TIME so the packaged app ships pre-patched.
  // Runtime ensure*Fix calls in main.js become no-ops (idempotent via markers).
  try {
    const vendorPatches = require('../lib/vendor-patches');
    const homeDir = os.homedir();
    log('applying vendor patches to', VENDOR, '...');
    const results = vendorPatches.applyAllVendorPatches({
      vendorDir: VENDOR,
      homeDir,
      skipFork: true,   // openzalo fork is runtime-only (extension dir doesn't exist at build time)
    });
    log('vendor patches:', JSON.stringify(results));
  } catch (e) {
    warn('vendor patches failed (non-fatal — runtime will retry):', e.message);
  }

  if (platform === 'win32') {
    packVendorForWindows();
    log('vendor archive ready at', path.join(ROOT, 'vendor-bundle.tar'));
  } else {
    // Platform-F1: emit vendor-meta.json for Mac too so verifyEmbedderModelSha
    // on Mac has a baseline to compare against. No tar on Mac — just the
    // modelSha map.
    const modelDir = path.join(VENDOR, 'models', 'Xenova', 'multilingual-e5-small');
    const modelSha = {};
    try {
      const onnx = path.join(modelDir, 'onnx', 'model_quantized.onnx');
      if (fs.existsSync(onnx)) modelSha['model_quantized.onnx'] = sha256File(onnx);
      const tok = path.join(modelDir, 'tokenizer.json');
      if (fs.existsSync(tok)) modelSha['tokenizer.json'] = sha256File(tok);
    } catch (e) { warn('Mac model SHA collection failed:', e.message); }
    const macMetaPath = path.join(ROOT, 'vendor-meta.json');
    fs.writeFileSync(macMetaPath, JSON.stringify({
      version: 1,
      target_platform: 'darwin',
      target_arch: arch,
      modelSha,
      created_at: new Date().toISOString(),
    }, null, 2) + '\n');
    log(`  ✓ vendor-meta.json written (Mac: modelSha only)`);
    log('vendor ready at', VENDOR);
  }
}

main().catch((e) => {
  console.error('[prebuild-vendor] failed:', e);
  process.exit(1);
});
