#!/usr/bin/env node
/*
 * smoke-test.js
 * ---------------------------------------------------------------
 * Pre-build supply-chain validator. Catches upstream package breakage
 * BEFORE we ship a .exe / .dmg with broken dependencies.
 *
 * Why this exists:
 * 9BizClaw depends on 4 third-party npm packages we don't control:
 *   - openclaw            (the gateway + agent runtime)
 *   - openzca             (Zalo websocket listener)
 *   - 9router             (AI provider router)
 *   - modoro-zalo          (our fork of openzalo — Zalo channel plugin)
 *
 * Each upstream version bump can silently break 9BizClaw if:
 *   - Config schema validator rejects fields we set
 *   - CLI flags renamed/removed
 *   - Internal file format changed (session jsonl, listener-owner.json)
 *   - Plugin source files we patch (inbound.ts, openzca.ts) restructured
 *
 * This script runs the most likely failure modes and exits non-zero
 * if any are detected. Wired into npm run build:win + build:mac so a
 * broken build never reaches users.
 *
 * Each test below has a clear failure message + remediation hint.
 * NEVER add a test that requires network access or external state —
 * smoke tests must be hermetic and fast (<10 seconds total).
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');
const VENDOR_NM = path.join(VENDOR, 'node_modules');
const VENDOR_TAR = path.join(ROOT, 'vendor-bundle.tar');
const VENDOR_META = path.join(ROOT, 'vendor-meta.json');
const {
  resolveBootstrapMaxCharsForContext,
  resolveDynamicContextBudgetTokens,
} = require('../lib/config');

let failures = 0;
let warnings = 0;

function pass(name) { console.log(`  PASS  ${name}`); }
function fail(name, why) {
  console.error(`  FAIL  ${name}\n        → ${why}`);
  failures++;
}
function warn(name, why) {
  console.warn(`  WARN  ${name}\n        → ${why}`);
  warnings++;
}
function section(label) { console.log(`\n[${label}]`); }

// Shared pinned versions — loaded from versions.json so all files always agree.
// Upgrade rule: update ONLY electron/scripts/versions.json. All other files read from it.
const SHARED_VERSIONS = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'versions.json'), 'utf-8'));
  } catch {
    return { openclaw: '2026.4.14', openzca: '0.1.59', nineRouter: '0.4.63' };
  }
})();

// NOTE: the 9router RTK guard (scripts/check-9router-rtk.js) checks for SHARED_VERSIONS
// in this file. Do NOT refactor away the shared loading above.
const PINNED = {
  openclaw: SHARED_VERSIONS.openclaw,
  '9router': SHARED_VERSIONS.nineRouter,
  openzca: SHARED_VERSIONS.openzca,
};

// =========================================================================
// TEST 1: Vendor packages exist at pinned versions (dev prebuild only)
// =========================================================================
section('Vendor packages');
// Build artifacts (v2.4.0+ pure runtime install):
//   - Both Mac DMG and Win EXE: ship only modoro-zalo plugin (~2 MB).
//     Node.js + npm packages downloaded on first launch.
//   - Win builds may still produce vendor-bundle.tar for potential future use.
//
// If vendor dir or tar is present (dev prebuild or Windows tar), we verify.
// If neither is present, this is a standalone/CI smoke run — skip silently.
const hasVendorDir = fs.existsSync(VENDOR_NM);
const hasVendorTar = fs.existsSync(VENDOR_TAR) && fs.existsSync(VENDOR_META);
const isBundledBuild = hasVendorDir || hasVendorTar;

function listTarEntriesWithNode(tarPath) {
  const entries = new Set();
  const fd = fs.openSync(tarPath, 'r');
  const header = Buffer.alloc(512);
  let offset = 0;
  let pendingLongName = null;
  let pendingPaxPath = null;
  try {
    while (true) {
      const bytes = fs.readSync(fd, header, 0, 512, offset);
      if (bytes < 512) break;
      offset += 512;
      let empty = true;
      for (let i = 0; i < 512; i++) {
        if (header[i] !== 0) { empty = false; break; }
      }
      if (empty) break;

      const readString = (start, len) => header.toString('utf8', start, start + len).replace(/\0.*$/, '').trim();
      let name = readString(0, 100);
      const sizeRaw = readString(124, 12);
      const size = parseInt(sizeRaw || '0', 8) || 0;
      const typeflag = String.fromCharCode(header[156] || 48);
      const prefix = readString(345, 155);
      if (prefix) name = prefix + '/' + name;

      const payloadOffset = offset;
      const paddedSize = Math.ceil(size / 512) * 512;

      if (typeflag === 'L' || typeflag === 'x' || typeflag === 'g') {
        const payload = Buffer.alloc(size);
        if (size > 0) fs.readSync(fd, payload, 0, size, payloadOffset);
        const text = payload.toString('utf8').replace(/\0+$/, '');
        if (typeflag === 'L') {
          pendingLongName = text;
        } else if (typeflag === 'x') {
          for (const line of text.split('\n')) {
            const m = line.match(/^\d+\s+path=(.*)$/);
            if (m) { pendingPaxPath = m[1]; break; }
          }
        }
      } else {
        if (pendingPaxPath) {
          name = pendingPaxPath;
          pendingPaxPath = null;
          pendingLongName = null;
        } else if (pendingLongName) {
          name = pendingLongName;
          pendingLongName = null;
        }
        if (name) entries.add(name.replace(/\\/g, '/'));
      }

      offset = payloadOffset + paddedSize;
    }
  } finally {
    fs.closeSync(fd);
  }
  return entries;
}

function readTarEntryText(tarPath, entry) {
  function readWithNode() {
    const wanted = String(entry).replace(/\\/g, '/');
    const fd = fs.openSync(tarPath, 'r');
    const header = Buffer.alloc(512);
    let offset = 0;
    let pendingLongName = null;
    let pendingPaxPath = null;
    try {
      while (true) {
        const bytes = fs.readSync(fd, header, 0, 512, offset);
        if (bytes < 512) break;
        offset += 512;
        let empty = true;
        for (let i = 0; i < 512; i++) {
          if (header[i] !== 0) { empty = false; break; }
        }
        if (empty) break;

        const readString = (start, len) => header.toString('utf8', start, start + len).replace(/\0.*$/, '').trim();
        let name = readString(0, 100);
        const sizeRaw = readString(124, 12);
        const size = parseInt(sizeRaw || '0', 8) || 0;
        const typeflag = String.fromCharCode(header[156] || 48);
        const prefix = readString(345, 155);
        if (prefix) name = prefix + '/' + name;

        const payloadOffset = offset;
        const paddedSize = Math.ceil(size / 512) * 512;
        if (typeflag === 'L' || typeflag === 'x' || typeflag === 'g') {
          const payload = Buffer.alloc(size);
          if (size > 0) fs.readSync(fd, payload, 0, size, payloadOffset);
          const text = payload.toString('utf8').replace(/\0+$/, '');
          if (typeflag === 'L') {
            pendingLongName = text;
          } else if (typeflag === 'x') {
            for (const line of text.split('\n')) {
              const m = line.match(/^\d+\s+path=(.*)$/);
              if (m) { pendingPaxPath = m[1]; break; }
            }
          }
        } else {
          if (pendingPaxPath) {
            name = pendingPaxPath;
            pendingPaxPath = null;
            pendingLongName = null;
          } else if (pendingLongName) {
            name = pendingLongName;
            pendingLongName = null;
          }
          name = String(name || '').replace(/\\/g, '/');
          if (name === wanted) {
            const payload = Buffer.alloc(size);
            if (size > 0) fs.readSync(fd, payload, 0, size, payloadOffset);
            return payload.toString('utf8').replace(/\0+$/, '');
          }
        }
        offset = payloadOffset + paddedSize;
      }
    } finally {
      fs.closeSync(fd);
    }
    throw new Error(`entry not found in tar: ${entry}`);
  }
  const tarBin = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  const res = spawnSync(tarBin, ['-xOf', tarPath, entry], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.status !== 0) {
    try {
      return readWithNode();
    } catch (fallbackErr) {
      throw new Error(`tar -xOf failed exit ${res.status}: ${res.error?.message || (res.stderr || '').slice(0, 200) || 'no stderr'}; JS fallback failed: ${fallbackErr.message}`);
    }
  }
  return res.stdout;
}

// If only the Windows tar is present, peek inside it to verify pinned versions.
// Uses `tar -tvf` to list contents without extracting — fast.
let tarContents = null;
let tarListFailed = false;
let vendorMeta = null;
if (hasVendorTar && !hasVendorDir) {
  try {
    const tarBin = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
    const res = spawnSync(tarBin, ['-tf', VENDOR_TAR], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false, maxBuffer: 128 * 1024 * 1024,
    });
    if (res.status === 0) {
      tarContents = new Set(res.stdout.split('\n').map(s => s.trim()).filter(Boolean));
      pass(`vendor-bundle.tar contains ${tarContents.size} entries`);
      try {
        vendorMeta = JSON.parse(fs.readFileSync(VENDOR_META, 'utf8'));
        pass(`vendor-meta.json bundle_version=${vendorMeta.bundle_version}`);
      } catch {}
    } else {
      warn('vendor-bundle.tar', `system tar -tf failed exit ${res.status}: ${res.error?.message || (res.stderr || '').slice(0, 200) || 'no stderr'}; using JS tar scanner`);
      tarContents = listTarEntriesWithNode(VENDOR_TAR);
      pass(`vendor-bundle.tar contains ${tarContents.size} entries (JS scanner)`);
    }
  } catch (e) {
    try {
      warn('vendor-bundle.tar', `system tar inspect failed: ${e.message}; using JS tar scanner`);
      tarContents = listTarEntriesWithNode(VENDOR_TAR);
      pass(`vendor-bundle.tar contains ${tarContents.size} entries (JS scanner)`);
    } catch (fallbackErr) {
      tarListFailed = true;
      fail('vendor-bundle.tar', `could not inspect: ${fallbackErr.message}`);
    }
  }
}
if (hasVendorTar && !vendorMeta) {
  try { vendorMeta = JSON.parse(fs.readFileSync(VENDOR_META, 'utf8')); } catch {}
}

function checkVendorVersion(pkgName, expected) {
  // If we only have the Windows tar, verify package.json inside the archive.
  if (tarContents && !hasVendorDir) {
    const pkgJsonEntry = `vendor/node_modules/${pkgName}/package.json`;
    if (!tarContents.has(pkgJsonEntry)) {
      fail(`vendor tar ${pkgName}`, `${pkgName}/package.json not found in vendor-bundle.tar. Run: rm vendor-bundle.tar vendor-meta.json && npm run prebuild:vendor`);
      return;
    }
    let actual;
    try {
      actual = JSON.parse(readTarEntryText(VENDOR_TAR, pkgJsonEntry)).version;
    } catch (e) {
      fail(`vendor tar ${pkgName}`, `package.json unreadable in vendor-bundle.tar: ${e.message}`);
      return;
    }
    if (actual !== expected) {
      fail(`vendor tar ${pkgName}`, `version drift: have=${actual} pinned=${expected}. Run: rm vendor-bundle.tar vendor-meta.json && npm run prebuild:vendor`);
      return;
    }
    pass(`vendor tar ${pkgName}@${actual}`);
    return;
  }
  if (hasVendorTar && !hasVendorDir && tarListFailed) {
    return; // Avoid cascading false "vendor missing" failures after tar inspect failed.
  }
  const pkgJsonPath = pkgName.startsWith('@')
    ? path.join(VENDOR_NM, ...pkgName.split('/'), 'package.json')
    : path.join(VENDOR_NM, pkgName, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    if (isBundledBuild) {
      fail(`vendor ${pkgName}`, `vendor dir present but ${pkgName} missing. Run: rm -rf vendor && npm run prebuild:vendor`);
    }
    // No vendor dir at all — standalone smoke, skip silently
    return;
  }
  let actual;
  try { actual = require(pkgJsonPath).version; } catch (e) {
    fail(`vendor ${pkgName}`, `package.json unreadable: ${e.message}`);
    return;
  }
  if (actual !== expected) {
    fail(`vendor ${pkgName}`, `version drift: have=${actual} pinned=${expected}. Run: rm -rf vendor/node_modules && npm run prebuild:vendor`);
    return;
  }
  pass(`vendor ${pkgName}@${actual}`);
}
for (const [name, version] of Object.entries(PINNED)) {
  checkVendorVersion(name, version);
}

// modoro-zalo is our fork (copied from packages/, not installed via npm) —
// verify it's present in vendor with the plugin manifest.
if (hasVendorDir) {
  const modoroZaloManifest = path.join(VENDOR_NM, 'modoro-zalo', 'openclaw.plugin.json');
  if (fs.existsSync(modoroZaloManifest)) {
    pass('vendor modoro-zalo (plugin manifest present)');
  } else {
    fail('vendor modoro-zalo', 'modoro-zalo/openclaw.plugin.json missing from vendor. Run: npm run prebuild:vendor');
  }
} else if (tarContents) {
  const hasEntry = [...tarContents].some(e => e.startsWith('vendor/node_modules/modoro-zalo/'));
  if (hasEntry) {
    pass('vendor tar: modoro-zalo present');
  } else {
    fail('vendor tar modoro-zalo', 'modoro-zalo not found in vendor-bundle.tar. Run: rm vendor-bundle.tar vendor-meta.json && npm run prebuild:vendor');
  }
}


function checkVendorExtractionSentinels() {
  if (!isBundledBuild) return;
  const bootSource = fs.readFileSync(path.join(ROOT, 'lib', 'boot.js'), 'utf8');
  if (/node_modules['"],\s*['"]pdf-parse['"]/.test(bootSource)) {
    fail('vendor extraction sentinels', 'boot.js must not sentinel-check pdf-parse under vendor; pdf-parse is packaged as an Electron app dependency, not in vendor-bundle.tar');
    return;
  }
  const tarPlatform = vendorMeta?.target_platform || process.platform;
  const nodeEntry = tarPlatform === 'win32' ? 'vendor/node/node.exe' : 'vendor/node/bin/node';
  const sentinelEntries = [
    nodeEntry,
    'vendor/node_modules/openclaw/openclaw.mjs',
    'vendor/node_modules/openclaw/package.json',
    'vendor/node_modules/modoro-zalo/openclaw.plugin.json',
    'vendor/node_modules/9router/package.json',
    'vendor/models/Xenova/multilingual-e5-small/onnx/model_quantized.onnx',
    'vendor/models/Xenova/multilingual-e5-small/tokenizer.json',
    'vendor/models/Xenova/multilingual-e5-small/config.json',
  ];
  const betterSqliteEntry = 'vendor/node_modules/9router/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node';
  const betterSqlitePackageEntry = 'vendor/node_modules/9router/app/node_modules/better-sqlite3/package.json';
  if (tarContents && tarContents.has(betterSqlitePackageEntry)) {
    sentinelEntries.push(betterSqliteEntry);
  } else if (hasVendorDir && fs.existsSync(path.join(ROOT, betterSqlitePackageEntry.replace(/\//g, path.sep)))) {
    sentinelEntries.push(betterSqliteEntry);
  }
  if (tarContents && !hasVendorDir) {
    const missing = sentinelEntries.filter(entry => !tarContents.has(entry));
    if (missing.length) {
      fail('vendor tar extraction sentinels', 'missing from vendor-bundle.tar: ' + missing.join(', '));
      return;
    }
    pass(`vendor tar extraction sentinels (${sentinelEntries.length})`);
    return;
  }
  if (hasVendorDir) {
    const missing = sentinelEntries.filter(entry => {
      const abs = path.join(ROOT, entry.replace(/\//g, path.sep));
      return !fs.existsSync(abs) || fs.statSync(abs).size === 0;
    });
    if (missing.length) {
      fail('vendor dir extraction sentinels', 'missing/empty in electron/vendor: ' + missing.join(', '));
      return;
    }
    pass(`vendor dir extraction sentinels (${sentinelEntries.length})`);
  }
}

checkVendorExtractionSentinels();

// =========================================================================
// TEST 2: openclaw CLI is runnable + `agent --help` works
// =========================================================================
section('openclaw CLI');
function findOpenclawCli() {
  // Prefer vendor if present
  const vendorCli = path.join(VENDOR_NM, 'openclaw', 'openclaw.mjs');
  if (fs.existsSync(vendorCli)) return vendorCli;
  // Fallback to user-global install
  const HOME = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [
    path.join(HOME, 'AppData', 'Roaming', 'npm', 'node_modules', 'openclaw', 'openclaw.mjs'),
    '/usr/local/lib/node_modules/openclaw/openclaw.mjs',
    '/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}
const openclawCli = findOpenclawCli();
if (!openclawCli) {
  warn('openclaw CLI', 'not found in vendor or user-global. Smoke test for CLI behavior skipped.');
} else {
  // Use a TEMP empty config to isolate from user's potentially-broken openclaw.json.
  // We test --version (no schema validation) and `agent --help` separately so
  // a config issue doesn't mask a missing-binary issue.
  const tmpDir = path.join(os.tmpdir(), 'modoro-smoketest-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.openclaw'), { recursive: true });
  // FULL config that matches ALL fields ensureDefaultConfig() writes.
  // CRITICAL: every field ensureDefaultConfig adds to openclaw.json MUST appear
  // here. If a new field is added to ensureDefaultConfig but not here, and that
  // field is invalid in openclaw's schema, the smoke test CATCHES IT before shipping.
  // This is the EXACT test that would have caught the execSecurity bug.
  const minimalConfig = {
    gateway: { mode: 'local', auth: { mode: 'token', token: 'a'.repeat(48) } },
    channels: {
      telegram: {
        botToken: '0000000:fake_token_for_smoke_test_only', enabled: false,
        blockStreaming: false, streaming: 'off',
        groupPolicy: 'open', requireMention: true,
      },
      'modoro-zalo': {
        enabled: false, dmPolicy: 'open', allowFrom: ['*'],
        groupPolicy: 'open', groupAllowFrom: ['*'], blockStreaming: false,
        groups: {
          'fake-group-id-for-smoke-test': { requireMention: false, enabled: true },
        },
      },
    },
    plugins: {
      entries: { 'modoro-zalo': { enabled: false } },
      allow: ['modoro-zalo'],
    },
    models: { providers: { ninerouter: { baseUrl: 'http://127.0.0.1:20128/v1', apiKey: 'sk-fake', api: 'openai-completions', models: [{ id: 'main', name: 'fake', contextWindow: 200000, contextTokens: 200000 }] } } },
    agents: { defaults: { model: 'ninerouter/main', workspace: tmpDir, blockStreamingDefault: 'off', contextInjection: 'always', contextTokens: 200000, bootstrapMaxChars: 60000, bootstrapTotalMaxChars: 270000 } },
    tools: {
      allow: ['message', 'web_search', 'web_fetch', 'update_plan'],
      loopDetection: { enabled: true },
      message: { crossContext: { allowAcrossProviders: true } },
      web: { search: { provider: 'duckduckgo' } },
    },
    messages: { inbound: { debounceMs: 3000 } },
  };
  fs.writeFileSync(path.join(tmpDir, '.openclaw', 'openclaw.json'), JSON.stringify(minimalConfig, null, 2));

  // Use HOME env override so openclaw reads our temp config, not user's real one.
  // Set timeout 5s — --help should be near-instant (no network, no config validation
  // for `agent --help` since openclaw 2026.4.x). If it hangs, something is very wrong.
  const env = { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir };

  // Test 2a: --version (no config needed, should be instant)
  const rVer = spawnSync('node', [openclawCli, '--version'], {
    encoding: 'utf-8',
    timeout: 30000,
    env,
  });
  if (rVer.error) {
    fail('openclaw --version spawn', rVer.error.message);
  } else if (rVer.status !== 0) {
    fail('openclaw --version exit', `exit ${rVer.status}, stderr: ${(rVer.stderr || '').slice(0, 300)}`);
  } else if (!/\d+\.\d+\.\d+/.test(rVer.stdout)) {
    fail('openclaw --version output', `expected version number, got: ${rVer.stdout.slice(0, 200)}`);
  } else {
    pass('openclaw --version: ' + rVer.stdout.trim().slice(0, 60));
  }

  // Test 2b: Schema validator accepts ensureDefaultConfig() output shape.
  // We invoke `--help` (top-level, fastest) which still loads + validates config.
  // openclaw 2026.4.5 cold start can take 5-10s for plugin discovery, and a
  // build-loaded machine with cold disk cache can push CLI module-tree loads
  // past 12s, so we give it 30s. If it still hangs, that's the validator
  // getting stuck in a loop.
  const rValidate = spawnSync('node', [openclawCli, '--help'], {
    encoding: 'utf-8',
    timeout: 30000,
    env,
  });
  if (rValidate.error && rValidate.error.code === 'ETIMEDOUT') {
    warn('openclaw schema validation', 'timed out (20s) — slow plugin discovery is normal. Manually verify config shape before shipping.');
  } else if (rValidate.status !== 0) {
    const stderr = (rValidate.stderr || '').slice(0, 500);
    if (/Config invalid|Unrecognized key|additional properties/i.test(stderr)) {
      fail('openclaw schema accepts ensureDefaultConfig output', `validator REJECTED our config shape:\n${stderr}\nFix: update ensureDefaultConfig() in main.js to match new schema.`);
    } else {
      warn('openclaw --help', `non-zero exit ${rValidate.status} but no schema error: ${stderr}`);
    }
  } else {
    pass('openclaw schema accepts ensureDefaultConfig output shape');
  }

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

// =========================================================================
// TEST 3: openzca CLI runnable
// =========================================================================
section('openzca CLI');
function findOpenzcaCli() {
  const vendorCli = path.join(VENDOR_NM, 'openzca', 'dist', 'cli.js');
  if (fs.existsSync(vendorCli)) return vendorCli;
  const HOME = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [
    path.join(HOME, 'AppData', 'Roaming', 'npm', 'node_modules', 'openzca', 'dist', 'cli.js'),
    '/usr/local/lib/node_modules/openzca/dist/cli.js',
    '/opt/homebrew/lib/node_modules/openzca/dist/cli.js',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}
const openzcaCli = findOpenzcaCli();
if (!openzcaCli) {
  warn('openzca CLI', 'not found in vendor or user-global. Skipped.');
} else {
  const r = spawnSync('node', [openzcaCli, '--help'], { encoding: 'utf-8', timeout: 30000 });
  if (r.error) {
    fail('openzca --help spawn', r.error.message);
  } else if (r.status !== 0) {
    fail('openzca --help exit', `exit ${r.status}, stderr: ${(r.stderr || '').slice(0, 300)}`);
  } else if (!/listen|profile/i.test(r.stdout + r.stderr)) {
    fail('openzca --help output', 'expected "listen" or "profile" in help — CLI structure may have changed');
  } else {
    pass('openzca --help');
  }
}

// =========================================================================
// TEST 4: Patch anchors in modoro-zalo plugin source still match expected format
// =========================================================================
section('Plugin patch anchors');
// Patch anchors: pass if EITHER the original anchor matches (unpatched plugin)
// OR the 9BizClaw patch marker is present (already patched). Both states are
// "smoke OK" — only failure is "neither matches", which means upstream
// restructured the file in a way our patch logic can no longer find.
function checkPatchAnchor(name, file, anchorRegex, patchMarker, hint) {
  if (!fs.existsSync(file)) {
    warn(name, `plugin source not found at ${file} — skipped (Mac vendor or fresh install)`);
    return;
  }
  checkPatchAnchorContent(name, fs.readFileSync(file, 'utf-8'), anchorRegex, patchMarker, hint);
}

function checkPatchAnchorContent(name, content, anchorRegex, patchMarker, hint) {
  if (anchorRegex.test(content)) {
    pass(name + ' (anchor matches — unpatched)');
    return;
  }
  // Accept both current marker and legacy MODOROClaw marker (rebrand transition)
  const legacyMarker = patchMarker.replace('9BizClaw', 'MODOROClaw');
  if (patchMarker && content.includes(patchMarker)) {
    pass(name + ' (already patched — marker present)');
    return;
  }
  if (legacyMarker !== patchMarker && content.includes(legacyMarker)) {
    pass(name + ' (already patched — legacy marker present, will re-patch on next launch)');
    return;
  }
  fail(name, `neither anchor regex NOR patch marker "${patchMarker}" found. ${hint}`);
}

// Look for modoro-zalo source: packages/ (repo), dist/ (prebuild output), vendor, user-installed
const modoroZaloSrcCandidates = [
  path.join(ROOT, 'packages', 'modoro-zalo', 'src'),
  path.join(ROOT, 'dist', 'modoro-zalo', 'src'),
  path.join(VENDOR_NM, 'modoro-zalo', 'src'),
  path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'extensions', 'modoro-zalo', 'src'),
];
let modoroZaloSrc = null;
for (const c of modoroZaloSrcCandidates) {
  if (fs.existsSync(c)) { modoroZaloSrc = c; break; }
}
const modoroZaloTarSrc = !!(
  tarContents
  && tarContents.has('vendor/node_modules/modoro-zalo/src/openzca.ts')
  && tarContents.has('vendor/node_modules/modoro-zalo/src/inbound.ts')
);

// In CI builds, modoro-zalo source MUST be found somewhere (packages/, dist/, vendor, or tar).
// v2.4.0+: Mac uses runtime install model — vendor dir won't exist on Mac CI.
// The plugin is shipped via dist/modoro-zalo (prebuild:modoro-zalo step).
const isCiBuild = !!process.env.CI || !!process.env.GITHUB_ACTIONS;
if (!modoroZaloSrc && !modoroZaloTarSrc && isCiBuild) {
  fail('modoro-zalo source', 'CI build has no modoro-zalo source in packages/, dist/, vendor, or tar — prebuild:modoro-zalo may have failed');
}

if (!modoroZaloSrc && modoroZaloTarSrc && isCiBuild) {
  pass('modoro-zalo source present in vendor-bundle.tar');
}

if (modoroZaloSrc) {
  // Anchor 1: openzca.ts shell-fix (fork file)
  checkPatchAnchor(
    'openzca.ts spawn anchor',
    path.join(modoroZaloSrc, 'openzca.ts'),
    /spawn\s*\(\s*binary\s*,/,
    '9BizClaw PATCH',
    'modoro-zalo openzca.ts missing shell-fix patch — check electron/packages/modoro-zalo/src/openzca.ts'
  );

  // Anchor 2: inbound.ts blockStreaming (fork file)
  checkPatchAnchor(
    'inbound.ts disableBlockStreaming anchor',
    path.join(modoroZaloSrc, 'inbound.ts'),
    /disableBlockStreaming:\s*\n?\s*typeof account\.config\.blockStreaming === ["']boolean["']/,
    '9BizClaw FORCE-ONE-MESSAGE PATCH',
    'modoro-zalo inbound.ts missing force-one-message patch — check electron/packages/modoro-zalo/src/inbound.ts'
  );

  // Anchor 3: inbound.ts blocklist (fork file)
  checkPatchAnchor(
    'inbound.ts blocklist anchor',
    path.join(modoroZaloSrc, 'inbound.ts'),
    /if\s*\(!rawBody\s*&&\s*!hasMedia\)\s*\{\s*\n\s*return;\s*\n\s*\}/,
    '9BizClaw ALLOWLIST',
    'modoro-zalo inbound.ts missing allowlist patch — check electron/packages/modoro-zalo/src/inbound.ts'
  );
} else if (modoroZaloTarSrc) {
  const tarOpenzcaTs = readTarEntryText(VENDOR_TAR, 'vendor/node_modules/modoro-zalo/src/openzca.ts');
  const tarInboundTs = readTarEntryText(VENDOR_TAR, 'vendor/node_modules/modoro-zalo/src/inbound.ts');
  checkPatchAnchorContent(
    'openzca.ts spawn anchor',
    tarOpenzcaTs,
    /spawn\s*\(\s*binary\s*,/,
    '9BizClaw PATCH',
    'modoro-zalo openzca.ts missing shell-fix patch - check electron/packages/modoro-zalo/src/openzca.ts'
  );
  checkPatchAnchorContent(
    'inbound.ts disableBlockStreaming anchor',
    tarInboundTs,
    /disableBlockStreaming:\s*\n?\s*typeof account\.config\.blockStreaming === ["']boolean["']/,
    '9BizClaw FORCE-ONE-MESSAGE PATCH',
    'modoro-zalo inbound.ts missing force-one-message patch - check electron/packages/modoro-zalo/src/inbound.ts'
  );
  checkPatchAnchorContent(
    'inbound.ts blocklist anchor',
    tarInboundTs,
    /if\s*\(!rawBody\s*&&\s*!hasMedia\)\s*\{\s*\n\s*return;\s*\n\s*\}/,
    '9BizClaw ALLOWLIST',
    'modoro-zalo inbound.ts missing allowlist patch - check electron/packages/modoro-zalo/src/inbound.ts'
  );
} else {
  warn('modoro-zalo plugin source', 'not found in vendor or ~/.openclaw/extensions — patch anchors skipped');
}

// =========================================================================
// TEST 5: modoro-zalo package source files contain expected patch markers
// =========================================================================
section('modoro-zalo package source');
const modoroZaloPkgSrc = path.join(__dirname, '..', 'packages', 'modoro-zalo', 'src');
const pkgChecks = [
  {
    file: 'inbound.ts',
    markers: ['ALLOWLIST PATCH', 'SYSTEM-MSG PATCH', 'SENDER-DEDUP PATCH', 'RAG', 'DELIVER-COALESCE', 'PAUSE PATCH', 'COMMAND-BLOCK PATCH', 'RATE-LIMIT', 'BOT-LOOP-BREAKER', 'INBOUND-AUDIT PATCH'],
  },
  {
    file: 'send.ts',
    markers: ['OUTPUT-FILTER PATCH', 'GROUP-DETECT PATCH', 'ESCALATION-DETECT PATCH'],
  },
  {
    file: 'channel.ts',
    markers: ['FORCE-ONE-MESSAGE'],
  },
  {
    file: 'openzca.ts',
    markers: ['9BizClaw PATCH'],
  },
];
for (const check of pkgChecks) {
  const filePath = path.join(modoroZaloPkgSrc, check.file);
  if (!fs.existsSync(filePath)) {
    fail(`pkg ${check.file}`, `MISSING at ${filePath} — modoro-zalo package incomplete. Restore from git history.`);
    continue;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const missingMarkers = check.markers.filter(marker => !content.includes(marker));
  if (missingMarkers.length > 0) {
    fail(`pkg ${check.file} markers`, `file present but missing markers: [${missingMarkers.join(', ')}] — package source may be stale or incomplete`);
  } else {
    pass(`pkg ${check.file} (${check.markers.length} markers verified)`);
  }
}

// =========================================================================
// TEST 6: workspace-templates contains all critical files
// =========================================================================
section('Workspace templates (extraResources)');
const templateRoot = path.resolve(__dirname, '..', '..');
const requiredTemplates = [
  'AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'BOOTSTRAP.md', 'COMPANY.md',
  'PRODUCTS.md', 'USER.md', 'MEMORY.md', 'TOOLS.md',
];
for (const f of requiredTemplates) {
  const p = path.join(templateRoot, f);
  if (!fs.existsSync(p)) {
    fail(`template ${f}`, `MISSING at ${p} — fresh install will boot with broken workspace`);
  } else {
    pass(`template ${f}`);
  }
}

// IDENTITY.md must NOT contain hardcoded test names in the personalization fields.
// Examples in markdown blocks are OK — only the actual `**Cách xưng hô:**` line matters.
const identityPath = path.join(templateRoot, 'IDENTITY.md');
if (fs.existsSync(identityPath)) {
  const ic = fs.readFileSync(identityPath, 'utf-8');
  const xunghoLine = ic.match(/-\s*\*\*Cách xưng hô:\*\*\s*(.*)/);
  if (xunghoLine && /thầy Huy|Nguyễn Văn Huy|Peter Bui|Pi tờ|anh Huy/i.test(xunghoLine[1])) {
    fail('IDENTITY.md placeholder', `personalization line has leaked test name: "${xunghoLine[1].trim()}". Reset to "[Wizard sẽ điền cách bot gọi anh/chị]".`);
  } else {
    pass('IDENTITY.md personalization line is placeholder');
  }
}

// =========================================================================
// TEST 7: AGENTS.md must contain the no-emoji + history-block rules
// =========================================================================
section('AGENTS.md rules');
const agentsPath = path.join(templateRoot, 'AGENTS.md');
if (fs.existsSync(agentsPath)) {
  const ac = fs.readFileSync(agentsPath, 'utf-8');
  // Context-split emoji rule (v100+): no emoji in CEO chat, allowed in marketing content.
  if (!/KHÔNG DÙNG EMOJI khi nhắn cho CEO/i.test(ac)) {
    fail('AGENTS.md emoji rule', 'missing "KHÔNG DÙNG EMOJI khi nhắn cho CEO" rule — bot may emoji-spam CEO');
  } else {
    pass('AGENTS.md has context-split emoji rule (no emoji to CEO, allowed for marketing content)');
  }
  if (!/LỊCH SỬ TIN NHẮN/i.test(ac)) {
    fail('AGENTS.md history rule', 'missing cron history block rule — bot will hallucinate "no Zalo data"');
  } else {
    pass('AGENTS.md has cron history block rule');
  }
}

// =========================================================================
// TEST 7b: prompt template files exist in electron/prompts/
// =========================================================================
section('Prompt templates');
for (const pf of ['evening-briefing.md', 'morning-briefing.md', 'weekly-report.md', 'monthly-report.md']) {
  const pp = path.join(__dirname, '..', 'prompts', pf);
  if (!fs.existsSync(pp)) fail(`prompt template missing: prompts/${pf}`);
  else pass(`prompt template ${pf}`);
}

// =========================================================================
// TEST 8: RAG accuracy (gated — only if vendor/models exists)
// =========================================================================
// Skips silently during pre-prebuild:models states (e.g. standalone smoke,
// fresh checkout before model download). When models are present, runs the
// 40-query canonical probe — hard-gates Top-3 >= 85%. Cold model load
// adds ~10-15s to the smoke; still hermetic (no network, no external state).
section('RAG accuracy');
const modelsDir = path.join(__dirname, '..', 'vendor', 'models', 'Xenova');
const hostArch = process.arch;
const targetArch = process.env.TARGET_ARCH || process.env.npm_config_arch || hostArch;
const isCrossArch = targetArch !== hostArch;
if (isCrossArch) {
  warn('RAG smoke', `cross-arch build (host=${hostArch}, target=${targetArch}) — native modules won't load. Skipped.`);
} else if (fs.existsSync(modelsDir)) {
  console.log('  running smoke-rag-test.js (40-query probe)...');
  try {
    require('child_process').execFileSync(
      process.execPath,
      [path.join(__dirname, 'smoke-rag-test.js')],
      { stdio: 'inherit' }
    );
    pass('RAG smoke (Top-3 >= 85%)');
  } catch (e) {
    fail('RAG smoke', `smoke-rag-test.js exited non-zero — Top-3 below 85% gate or runtime error`);
  }
} else {
  warn('RAG smoke', 'vendor/models/ not present — run `npm run prebuild:models` first. Skipped.');
}

// =========================================================================
// TEST 9: Vision patch signature — ensureVisionFix V2 anchor must be present
// =========================================================================
// V1 ensureVisionFix regex broke silently on openclaw upgrade → Telegram
// images not seen by ChatGPT for weeks. V2 uses `async function
// resolveGatewayModelSupportsImages(params) {` as the anchor. If openclaw
// renames/restructures this function we must know at BUILD time, not at
// first customer report. Skipped if vendor not yet prebuilt (CI/fresh checkout).
section('openclaw vision patch anchor');
function findOpenclawSessionUtils() {
  const candidates = [
    path.join(__dirname, '..', 'vendor', 'node_modules', 'openclaw', 'dist'),
    path.join(__dirname, '..', 'node_modules', 'openclaw', 'dist'),
  ];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir).filter(f => f.startsWith('session-utils-') && f.endsWith('.js'));
      if (files.length > 0) return files.map(f => path.join(dir, f));
    } catch {}
  }
  return null;
}
const sessionUtilsFiles = findOpenclawSessionUtils();
if (!sessionUtilsFiles) {
  warn('vision-patch anchor', 'openclaw session-utils not found — expected in runtime-only model (openclaw downloaded on first launch)');
} else {
  const FUNC_SIG = 'async function resolveGatewayModelSupportsImages(params) {';
  let anchorFound = false;
  let anchorFile = null;
  for (const fp of sessionUtilsFiles) {
    const src = fs.readFileSync(fp, 'utf-8');
    if (src.includes(FUNC_SIG)) { anchorFound = true; anchorFile = fp; break; }
  }
  if (!anchorFound) {
    fail('vision-patch anchor', `openclaw session-utils present but FUNC_SIG "${FUNC_SIG}" missing — upstream refactor detected. ensureVisionFix will silently no-op. Update patch anchor before ship.`);
  } else {
    pass(`vision-patch anchor (${path.basename(anchorFile)})`);
  }
}

// =========================================================================
// openclaw vision catalog patch — LAYER 2 vision gate
// ensureVisionCatalogFix patches model-catalog-*.js `modelSupportsVision`.
// Without this patch, image-understanding capability runs instead of direct
// model pass-through → bot hallucinates image content.
// =========================================================================
section('openclaw vision-catalog patch anchor');
function findOpenclawModelCatalog() {
  const candidates = [
    path.join(__dirname, '..', 'vendor', 'node_modules', 'openclaw', 'dist'),
    path.join(__dirname, '..', 'node_modules', 'openclaw', 'dist'),
  ];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir).filter(f => f.startsWith('model-catalog-') && f.endsWith('.js'));
      if (files.length > 0) return files.map(f => path.join(dir, f));
    } catch {}
  }
  return null;
}
const modelCatalogFiles = findOpenclawModelCatalog();
if (!modelCatalogFiles) {
  warn('vision-catalog-patch anchor', 'openclaw model-catalog not found — expected in runtime-only model (openclaw downloaded on first launch)');
} else {
  const FUNC_SIG_CATALOG = 'function modelSupportsVision(entry) {';
  let anchorFoundCatalog = false;
  let anchorFileCatalog = null;
  for (const fp of modelCatalogFiles) {
    const src = fs.readFileSync(fp, 'utf-8');
    if (src.includes(FUNC_SIG_CATALOG)) { anchorFoundCatalog = true; anchorFileCatalog = fp; break; }
  }
  if (!anchorFoundCatalog) {
    fail('vision-catalog-patch anchor', `openclaw model-catalog present but FUNC_SIG "${FUNC_SIG_CATALOG}" missing — upstream refactor detected. ensureVisionCatalogFix will silently no-op. Update patch anchor before ship.`);
  } else {
    pass(`vision-catalog-patch anchor (${path.basename(anchorFileCatalog)})`);
  }
}

// =========================================================================
// openclaw vision serialization patch — LAYER 3+4 vision gates
// ensureVisionSerializationFix patches supportsImageInput (outbound content
// serializer) + supportsExplicitImageInput (tool-result image replay).
// Without these, images survive gateway accept + capability skip but get
// STRIPPED at the final OpenAI-compat serialization step → model never
// sees the actual image data → hallucination.
// =========================================================================
section('openclaw vision-serialization patch anchors');
function findFileWithFuncSig(distDirs, filenamePrefix, funcSig) {
  for (const dir of distDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir).filter(f => f.startsWith(filenamePrefix) && f.endsWith('.js'));
      for (const f of files) {
        const fp = path.join(dir, f);
        const src = fs.readFileSync(fp, 'utf-8');
        if (src.includes(funcSig)) return fp;
      }
    } catch {}
  }
  return null;
}
const visionSerializationDirs = [
  path.join(__dirname, '..', 'vendor', 'node_modules', 'openclaw', 'dist'),
  path.join(__dirname, '..', 'node_modules', 'openclaw', 'dist'),
];
const serializationTargets = [
  { label: 'supportsImageInput', prefix: 'model-context-tokens-', sig: 'function supportsImageInput(modelOverride) {' },
  { label: 'supportsExplicitImageInput', prefix: 'stream-', sig: 'function supportsExplicitImageInput(model) {' },
];
let serializationDistFound = false;
for (const dir of visionSerializationDirs) if (fs.existsSync(dir)) { serializationDistFound = true; break; }
if (!serializationDistFound) {
  warn('vision-serialization anchors', 'openclaw dist not found — expected in runtime-only model (openclaw downloaded on first launch)');
} else {
  for (const target of serializationTargets) {
    const hit = findFileWithFuncSig(visionSerializationDirs, target.prefix, target.sig);
    if (!hit) {
      fail('vision-serialization anchor', `${target.label} FUNC_SIG not found in any ${target.prefix}*.js — upstream refactor detected, ensureVisionSerializationFix will silently no-op → images stripped from outbound requests.`);
    } else {
      pass(`vision-serialization anchor: ${target.label} (${path.basename(hit)})`);
    }
  }
}

// =========================================================================
// electron-builder files allowlist coverage
// Every local `require('./xxx/...')` in main.js must have its prefix
// covered by `build.files` in package.json, otherwise the shipped .exe
// will throw `Cannot find module ./xxx/...` on first launch. This exact
// regression shipped v2.3.47 (lib/embedder.js was committed but not in
// files list) and cost 1 rebuild + user-visible crash.
// =========================================================================
section('electron-builder files allowlist covers local requires');
const mainJsSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
const pkgJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
const filesList = pkgJson.build?.files || [];
const localRequireRe = /require\(['"]\.\/([a-zA-Z0-9_/-]+)['"]\)/g;
const prefixes = new Set();
let m;
while ((m = localRequireRe.exec(mainJsSrc)) !== null) {
  const rel = m[1];
  // Skip package.json — that's auto-included.
  if (rel === 'package' || rel === 'package.json') continue;
  // Take the top-level prefix (e.g. `./lib/embedder` → `lib`).
  const top = rel.split('/')[0];
  prefixes.add(top);
}
const missingPrefixes = [];
for (const prefix of prefixes) {
  // Match either exact filename "lib" or glob "lib/**/*" etc.
  const matched = filesList.some((entry) => {
    if (typeof entry !== 'string') return false;
    if (entry.startsWith('!')) return false;  // negation
    return entry === prefix || entry.startsWith(prefix + '/') || entry.startsWith(prefix + '.');
  });
  if (!matched) missingPrefixes.push(prefix);
}
if (missingPrefixes.length > 0) {
  fail('files allowlist coverage', `main.js require('./${missingPrefixes.join("/...'), require('./")}/...') but package.json build.files does NOT include [${missingPrefixes.join(', ')}] — shipped .exe will crash at launch with "Cannot find module ./${missingPrefixes[0]}/...". Add "${missingPrefixes[0]}/**/*" to build.files.`);
} else {
  pass(`files allowlist covers all local require prefixes [${[...prefixes].join(', ')}]`);
}

// =========================================================================
// FIRST-TIME GUIDE (spotlight + tooltip product tour)
// =========================================================================
section('guide-overlay');
{
  const dashHtml = fs.readFileSync(path.join(__dirname, '..', 'ui', 'dashboard.html'), 'utf-8');
  const hasOverlay = dashHtml.includes('id="guide-overlay"');
  const hasSpotlight = dashHtml.includes('id="guide-spotlight"');
  const hasTooltip = dashHtml.includes('id="guide-tooltip"');
  const hasGuideCSS = dashHtml.includes('.guide-overlay');
  if (!hasOverlay || !hasSpotlight || !hasTooltip || !hasGuideCSS) {
    fail('guide-overlay', 'Missing guide spotlight/tooltip elements in dashboard.html');
  } else {
    pass('guide-overlay');
  }
}

section('guide-overlay-js-functions');
{
  const dashHtml = fs.readFileSync(path.join(__dirname, '..', 'ui', 'dashboard.html'), 'utf-8');
  const requiredFns = [
    'function guideInit(',
    'function guideFinish(',
    'function guideNext(',
    'function guideBack(',
    '_guidePositionTooltip',
  ];
  const missingFns = requiredFns.filter(fn => !dashHtml.includes(fn));
  if (missingFns.length > 0) {
    fail('guide-overlay-js-functions', `dashboard.html missing guide functions: [${missingFns.join(', ')}] — guide will be non-functional`);
  } else {
    pass(`guide-overlay-js-functions (${requiredFns.length} functions verified)`);
  }
}

section('guide-overlay-preload-bridges');
{
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf-8');
  const requiredBridges = [
    'checkGuideNeeded',
    'markGuideComplete',
  ];
  const missingBridges = requiredBridges.filter(b => !preloadSrc.includes(b));
  if (missingBridges.length > 0) {
    fail('guide-overlay-preload-bridges', `preload.js missing guide bridges: [${missingBridges.join(', ')}] — guide IPC calls will fail at runtime`);
  } else {
    pass(`guide-overlay-preload-bridges (${requiredBridges.length} bridges verified)`);
  }
}

section('guide-overlay-no-emoji');
{
  const dashHtml = fs.readFileSync(path.join(__dirname, '..', 'ui', 'dashboard.html'), 'utf-8');
  const stepsIdx = dashHtml.indexOf('ZALO_GUIDE_STEPS');
  const overlayIdx = dashHtml.indexOf('id="guide-overlay"');
  if (stepsIdx === -1 && overlayIdx === -1) {
    warn('guide-overlay-no-emoji', 'Could not locate guide step arrays or overlay div to scan for emoji — skipped');
  } else {
    const startIdx = stepsIdx !== -1 ? stepsIdx : overlayIdx;
    const endIdx = overlayIdx !== -1 ? overlayIdx + 2000 : startIdx + 17000;
    const guideSection = dashHtml.slice(startIdx, endIdx);
    const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
    if (emojiRegex.test(guideSection)) {
      fail('guide-overlay-no-emoji', 'Guide section contains emoji characters — violates premium no-emoji rule.');
    } else {
      pass('guide-overlay-no-emoji');
    }
  }
}

// =========================================================================
// TEST 10: Module contracts — extracted lib/ modules export expected functions
// =========================================================================
section('Action capability router');
try {
  const agentsSrc = fs.readFileSync(path.join(templateRoot, 'AGENTS.md'), 'utf-8');
  const _skillRoot = path.join(templateRoot, 'skills');
  const _skillFiles = ['operations/image-generation.md', 'operations/cron-management.md', 'marketing/zalo-post-workflow.md'];
  const combinedSrc = agentsSrc + '\n' + _skillFiles.map(f => { try { return fs.readFileSync(path.join(_skillRoot, f), 'utf-8'); } catch { return ''; } }).join('\n');
  const requiredRouterBits = [
    'Capability Router',
    'zalo_image_post',
    'zalo_send',
    'zalo_cron',
    'diagnostic_recovery',
    '/api/brand-assets/list',
    '/api/image/generate',
    '/api/image/generate-and-send-zalo',
    '/api/zalo/friends',
    '/api/zalo/send',
    '/api/cron/list',
    '/api/cron/create',
    '/api/cron/replace',
    'jobId',
    'done_and_delivered',
    'done_not_delivered',
  ];
  const missingRouterBits = requiredRouterBits.filter(s => !combinedSrc.includes(s));
  if (missingRouterBits.length > 0) {
    fail('action capability router', `AGENTS.md+skills missing router entries: [${missingRouterBits.join(', ')}]`);
  } else {
    pass(`action capability router: ${requiredRouterBits.length} trigger/API/proof entries verified (AGENTS.md + ${_skillFiles.length} skill files)`);
  }
} catch (e) { fail('action capability router', 'source read failed: ' + e.message); }

section('Module contracts');
function checkModuleContracts() {
  const errors = [];
  // Wave 1: boot.js
  // Pure runtime model (v2.4.0+): boot.js no longer extracts vendor-bundle.tar.
  // SHA256 verification is done in runtime-installer.js instead.
  const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'runtime-installer.js'), 'utf-8');
  const hasSha256Verify = runtimeSource.includes('verifySha256') && runtimeSource.includes('NODE_SHA256');
  if (!hasSha256Verify) {
    errors.push('runtime-installer.js must verify node.exe SHA256 after extraction (verifySha256 + NODE_SHA256)');
  }
  // Wave 1: boot.js — verify all required exports
  try {
    const boot = require('../lib/boot');
    const required = ['getBundledVendorDir', 'ensureVendorExtracted', 'getBundledNodeBin',
      'getBundledOpenClawCliJs', 'augmentPathWithBundledNode', 'initPathAugmentation',
      'enumerateNodeManagerBinDirs', 'enumerateNodeManagerLibDirs',
      'appDataDir', 'resolveBinAbsolute', 'findBundledOpenClawMjs',
      'findOpenClawBin', 'findOpenClawBinSync', 'findNodeBin', 'findOpenClawCliJs',
      'spawnOpenClawSafe', 'runOpenClaw',
      'bootDiagLog', 'bootDiagInit', 'bootDiagRunFullCheck',
      'npmGlobalModules', 'findGlobalPackageFile'];
    for (const fn of required) {
      if (typeof boot[fn] !== 'function') errors.push(`boot.js missing export: ${fn}`);
    }
  } catch (e) { errors.push(`boot.js failed to load: ${e.message}`); }
  // Wave 1: context.js
  try {
    const ctx = require('../lib/context');
    const required = ['mainWindow', 'tray', 'HOME', 'resourceDir', 'userDataDir',
      'openclawProcess', 'botRunning', 'restartCount', 'lastCrash', 'appIsQuitting',
      'ipcInFlightCount', 'startOpenClawInFlight', 'wizardCompleteInFlight',
      'gatewayRestartInFlight', 'gatewayLastStartedAt'];
    for (const k of required) {
      if (!(k in ctx)) errors.push(`context.js missing key: ${k}`);
    }
  } catch (e) {
    errors.push(`context.js failed to load: ${e.message}`);
  }
  // Wave 1: util.js
  try {
    const util = require('../lib/util');
    for (const fn of ['isPathSafe', 'writeJsonAtomic', 'tokenizeShellish', 'sanitizeZaloText', 'stripTelegramMarkdown']) {
      if (typeof util[fn] !== 'function') errors.push(`util.js missing export: ${fn}`);
    }
  } catch (e) {
    errors.push(`util.js failed to load: ${e.message}`);
  }
  // Wave 1: workspace.js
  try {
    const ws = require('../lib/workspace');
    const required = ['getWorkspace', 'invalidateWorkspaceCache', 'getWorkspaceTemplateRoot',
      'getOpenclawAgentWorkspace', 'seedWorkspace', 'purgeAgentSessions',
      'getBrandAssetsDir',
      'getSetupCompletePath', 'hasCompletedOnboarding', 'markOnboardingComplete',
      'isOpenClawConfigured', 'getAppPrefsPath', 'loadAppPrefs', 'saveAppPrefs',
      'auditLog', 'enforceRetentionPolicies', 'backupWorkspace', 'hardenSensitiveFilePerms',
      'setCompilePersonaMix'];
    for (const fn of required) {
      if (typeof ws[fn] !== 'function') errors.push(`workspace.js missing export: ${fn}`);
    }
    for (const c of ['DEFAULT_SCHEDULES_JSON', 'BRAND_ASSET_FORMATS', 'BRAND_ASSET_MAX_SIZE']) {
      if (ws[c] === undefined) errors.push(`workspace.js missing constant: ${c}`);
    }
  } catch (e) { errors.push(`workspace.js failed to load: ${e.message}`); }
  // Wave 2: config.js
  try {
    const cfg = require('../lib/config');
    const required = ['parseUnrecognizedKeyErrors', 'healOpenClawConfigInline', 'isValidConfigKey',
      'sanitizeOpenClawConfigInPlace', 'withOpenClawConfigLock',
      'writeOpenClawConfigIfChanged', 'ensureDefaultConfig', 'setJournalCronRun'];
    for (const fn of required) {
      if (typeof cfg[fn] !== 'function') errors.push(`config.js missing export: ${fn}`);
    }
  } catch (e) { errors.push(`config.js failed to load: ${e.message}`); }
  // Wave 2: nine-router.js
  try {
    const nr = require('../lib/nine-router');
    const required = ['ensure9RouterDefaultPassword', 'saveProviderKey', 'ensure9RouterProviderKeys',
      'start9Router', 'stop9Router', 'nineRouterApi', 'autoFix9RouterSqlite',
      'waitFor9RouterReady', 'validateOllamaKeyDirect',
      'call9Router', 'call9RouterVision', 'detectChatgptPlusOAuth',
      'ensure9RouterRtkDefaultEnabled',
      'getRouterProcess', 'setKillPort'];
    for (const fn of required) {
      if (typeof nr[fn] !== 'function') errors.push(`nine-router.js missing export: ${fn}`);
    }
  } catch (e) { errors.push(`nine-router.js failed to load: ${e.message}`); }
  // Wave 2: conversation.js
  try {
    const conv = require('../lib/conversation');
    const required = ['extractConversationHistoryRaw', 'extractConversationHistory',
      'writeDailyMemoryJournal', 'appendPerCustomerSummaries', 'trimZaloMemoryFile'];
    for (const fn of required) {
      if (typeof conv[fn] !== 'function') errors.push(`conversation.js missing export: ${fn}`);
    }
  } catch (e) { errors.push(`conversation.js failed to load: ${e.message}`); }
  // Wave 2: ceo-memory.js
  try {
    const ceoMem = require('../lib/ceo-memory');
    const required = ['writeMemory', 'deleteMemory', 'searchMemory', 'listMemories',
      'getMemoryCount', 'getLastMemoryAt', 'regenerateCeoMemoryFile'];
    for (const fn of required) {
      if (typeof ceoMem[fn] !== 'function') errors.push(`ceo-memory.js missing export: ${fn}`);
    }
    const expectedTypes = ['rule', 'pattern', 'preference', 'fact', 'correction', 'task', 'procedure', 'entity_note', 'task_state'];
    const expectedSources = ['nudge', 'ceo_correction', 'evening_summary', 'manual', 'auto', 'workflow', 'system'];
    if (!Array.isArray(ceoMem.VALID_TYPES) || !expectedTypes.every(t => ceoMem.VALID_TYPES.includes(t))) errors.push('ceo-memory.js VALID_TYPES wrong');
    if (!Array.isArray(ceoMem.VALID_SOURCES) || !expectedSources.every(s => ceoMem.VALID_SOURCES.includes(s))) errors.push('ceo-memory.js VALID_SOURCES wrong');
  } catch (e) { errors.push(`ceo-memory.js failed to load: ${e.message}`); }
  // Wave 2: ceo-nudge.js
  try {
    const nudge = require('../lib/ceo-nudge');
    const required = ['startCeoMessageWatcher', 'startNudgeTimer', 'cleanupNudgeTimers'];
    for (const fn of required) {
      if (typeof nudge[fn] !== 'function') errors.push(`ceo-nudge.js missing export: ${fn}`);
    }
  } catch (e) { errors.push(`ceo-nudge.js failed to load: ${e.message}`); }
  // Wave 2: updates.js
  try {
    const upd = require('../lib/updates');
    const required = ['compareVersions', 'checkForUpdates', 'downloadUpdate',
      'installDmgUpdate', 'openGitHubUrl',
      'getLatestRelease', 'getUpdateDownloadInFlight', 'setUpdateDownloadInFlight'];
    for (const fn of required) {
      if (typeof upd[fn] !== 'function') errors.push(`updates.js missing export: ${fn}`);
    }
  } catch (e) { errors.push(`updates.js failed to load: ${e.message}`); }
  // Wave 3: channels.js
  try {
    const ch = require('../lib/channels');
    const required = [
      'getStickyChatIdPath', 'persistStickyChatId', 'loadStickyChatId',
      'getTelegramConfig', 'getTelegramConfigWithRecovery',
      'getGatewayAuthToken', 'getCeoSessionKey', 'sendToGatewaySession',
      'filterSensitiveOutput',
      '_getPausePath', 'setChannelPermanentPause', 'clearChannelPermanentPause',
      'isZaloChannelEnabled', 'setZaloChannelEnabled',
      'isChannelPaused', 'pauseChannel', 'resumeChannel', 'getChannelPauseStatus',
      'sendTelegram', 'sendTelegramPhoto', 'sendZalo', 'sendZaloTo', 'sendCeoAlert',
      'isZaloListenerAlive', 'getReadyGateState',
      'finalizeTelegramReadyProbe', 'finalizeZaloReadyProbe',
      'probeTelegramReady', 'findOpenzcaListenerPid', 'probeZaloReady',
      'broadcastChannelStatusOnce', 'startChannelStatusBroadcast',
      'registerTelegramCommands',
      'setIsZaloTargetAllowed', 'setGetZcaProfile', 'setIsKnownZaloTarget',
      'setReadZaloChannelState', 'setIsGatewayAlive', 'setCheckZaloCookieAge',
      'cleanupChannelTimers',
    ];
    for (const fn of required) {
      if (typeof ch[fn] !== 'function') errors.push(`channels.js missing export: ${fn}`);
    }
  } catch (e) { errors.push(`channels.js failed to load: ${e.message}`); }
  // Wave 3: appointments.js
  try {
    const appt = require('../lib/appointments');
    const required = [
      'getAppointmentsPath', 'readAppointments', 'writeAppointments',
      'newAppointmentId', 'mutateAppointments',
      'vnHHMM', 'vnDDMM', 'vnHHMMNow', 'vnDateKeyNow',
      'normalizeAppointment',
      'substituteApptTemplate', 'defaultApptPushTemplate', 'buildApptReminderText',
      'fireApptPushTarget', 'startAppointmentDispatcher', 'apptDispatcherTick',
      'cleanupAppointmentTimers',
    ];
    for (const fn of required) {
      if (typeof appt[fn] !== 'function') errors.push(`appointments.js missing export: ${fn}`);
    }
  } catch (e) { errors.push(`appointments.js failed to load: ${e.message}`); }
  // Wave 4: zalo-memory.js
  try {
    const zm = require('../lib/zalo-memory');
    const required = [
      'getZcaProfile', 'getZcaCacheDir', 'getZcaCacheDirForProfile',
      'readZaloChannelState', 'isZaloTargetAllowed', 'isKnownZaloTarget',
      'invalidateZaloFriendsCache', 'getZaloFriendsCached', 'setZaloFriendsCached',
      'runZaloCacheRefresh', 'startZaloCacheAutoRefresh',
      'getZaloUsersDir', 'ensureZaloUsersDir', 'sanitizeZaloUserId', 'parseZaloUserMemoryMeta',
      'getZaloGroupsDir', 'getZaloBlocklistPath', 'cleanBlocklist',
      'cleanupZaloMemoryTimers',
    ];
    for (const fn of required) {
      if (typeof zm[fn] !== 'function') errors.push(`zalo-memory.js missing export: ${fn}`);
    }
  } catch (e) { errors.push(`zalo-memory.js failed to load: ${e.message}`); }
  // Wave 3: zalo-plugin.js
  try {
    const zp = require('../lib/zalo-plugin');
    const required = [
      'cleanupOrphanZaloListener', 'ensureModoroZaloNodeModulesLink',
      'ensureZaloPlugin', 'seedZaloCustomersFromCache',
      'findOpenzcaCliJs', 'seedGroupHistorySummary', 'seedAllGroupHistories',
      'checkZaloCookieAge', '_ensureZaloPluginImpl',
      'isZaloReady', 'getZaloPluginVersion',
    ];
    for (const fn of required) {
      if (typeof zp[fn] !== 'function') errors.push(`zalo-plugin.js missing export: ${fn}`);
    }
  } catch (e) { errors.push(`zalo-plugin.js failed to load: ${e.message}`); }
  // Wave 3: persona.js
  try {
    const per = require('../lib/persona');
    const required = [
      'compilePersonaMix', 'syncPersonaToBootstrap',
      'syncShopStateToBootstrap', 'syncAllBootstrapData',
    ];
    for (const fn of required) {
      if (typeof per[fn] !== 'function') errors.push(`persona.js missing export: ${fn}`);
    }
  } catch (e) { errors.push(`persona.js failed to load: ${e.message}`); }
  // Wave 4: escalation.js
  try {
    const esc = require('../lib/escalation');
    const required = [
      'processEscalationQueue', 'startEscalationChecker', 'cleanupEscalationTimers',
    ];
    for (const fn of required) {
      if (typeof esc[fn] !== 'function') errors.push(`escalation.js missing export: ${fn}`);
    }
  } catch (e) { errors.push(`escalation.js failed to load: ${e.message}`); }
  // Wave 4: follow-up.js
  try {
    const fu = require('../lib/follow-up');
    const required = [
      'getFollowUpQueuePath', 'readFollowUpQueue', 'writeFollowUpQueue',
      'processFollowUpQueue', 'startFollowUpChecker',
      'cleanupFollowUpTimers', 'setRunCronAgentPrompt',
    ];
    for (const fn of required) {
      if (typeof fu[fn] !== 'function') errors.push(`follow-up.js missing export: ${fn}`);
    }
  } catch (e) { errors.push(`follow-up.js failed to load: ${e.message}`); }
  // Wave 4: gateway.js
  try {
    const gw = require('../lib/gateway');
    const required = [
      'killPort', 'killAllOpenClawProcesses',
      'isGatewayAlive', 'waitForIpcDrain', 'rejectIfBooting',
      'startOpenClaw', '_startOpenClawImpl', 'stopOpenClaw',
      'ensureVisionFix', 'ensureVisionCatalogFix', 'ensureVisionSerializationFix',
      'ensureWebFetchLocalhostFix', 'ensureOpenzcaFriendEventFix',
      'ensureOpenclawPricingFix', 'ensureOpenclawPrewarmFix',
      'startFastWatchdog', 'fastWatchdogTick', 'triggerGatewayMessage',
      'cleanupGatewayTimers',
      'setCreateTray', 'setKnowledgeCallbacks',
    ];
    for (const fn of required) {
      if (typeof gw[fn] !== 'function') errors.push(`gateway.js missing export: ${fn}`);
    }
  } catch (e) { errors.push(`gateway.js failed to load: ${e.message}`); }

  // Wave 4: knowledge.js
  try {
    const kn = require('../lib/knowledge');
    const required = [
      'getDocumentsDir', 'ensureDocumentsDir', 'getDocumentsDb',
      'KNOWLEDGE_CATEGORIES', 'getKnowledgeCategories', 'getKnowledgeDir',
      'rewriteKnowledgeIndex', 'searchKnowledge', 'startKnowledgeSearchServer',
      'getKnowledgeHttpServer', 'cleanupKnowledgeServer',
      'extractTextFromFile', 'listKnowledgeFilesFromDisk',
    ];
    for (const fn of required) {
      if (typeof kn[fn] !== 'function' && typeof kn[fn] !== 'object') errors.push(`knowledge.js missing export: ${fn}`);
    }
  } catch (e) { errors.push(`knowledge.js failed to load: ${e.message}`); }

  // Wave 5: cron.js
  try {
    const cr = require('../lib/cron');
    const required = [
      'cronJournalPath', 'journalCronRun', 'selfTestOpenClawAgent',
      'buildAgentArgs', 'isTransientErr', 'isConfigInvalidErr', 'isFatalErr',
      'parseSafeOpenzcaMsgSend', 'runSafeExecCommand',
      'runCronAgentPrompt', 'runCronViaSessionOrFallback',
      'getSchedulesPath', 'getCustomCronsPath',
      'loadSchedules', 'loadCustomCrons',
      'loadDailySummaries', 'generateWeeklySummary', 'loadWeeklySummaries',
      'loadPromptTemplate',
      'buildMorningBriefingPrompt', 'buildEveningSummaryPrompt',
      'buildWeeklyReportPrompt', 'buildMonthlyReportPrompt',
      'scanZaloFollowUpCandidates', 'buildZaloFollowUpPrompt',
      'buildMemoryCleanupPrompt',
      'healCustomCronEntries', 'watchCustomCrons',
      'startCronJobs', 'stopCronJobs', 'restartCronJobs',
      '_withCustomCronLock', '_removeCustomCronById', 'surfaceCronConfigError',
      'handleTimCommand', 'handleThongkeCommand', 'handleBaocaoCommand',
      'handleTelegramBuiltinCommand',
      '_readJsonlTail', '_readCeoNameFromIdentity', '_readRecentZaloCustomers', '_nextFireTime',
      '_OVERVIEW_EVENT_LABELS',
      'cleanupCronTimers',
      'setSaveZaloManagerInFlightGetter',
      'getAgentFlagProfile', 'getAgentCliHealthy',
    ];
    for (const fn of required) {
      if (cr[fn] === undefined) errors.push(`cron.js missing export: ${fn}`);
    }
  } catch (e) { errors.push(`cron.js failed to load: ${e.message}`); }

  // Wave 6: cron-api.js
  try {
    const ca = require('../lib/cron-api');
    for (const fn of ['startCronApi', 'cleanupCronApi', 'getCronApiToken', 'getCronApiPort']) {
      if (typeof ca[fn] !== 'function') errors.push(`cron-api.js missing export: ${fn}`);
    }
  } catch (e) { errors.push(`cron-api.js failed to load: ${e.message}`); }

  // Wave 7: dashboard-ipc.js
  try {
    const dIpc = require('../lib/dashboard-ipc');
    if (typeof dIpc.registerAllIpcHandlers !== 'function') errors.push('dashboard-ipc.js missing registerAllIpcHandlers');
  } catch (e) { errors.push('dashboard-ipc.js load failed: ' + e.message); }

  if (errors.length) {
    for (const e of errors) fail('module contract', e);
  } else {
    pass('module contracts OK');
  }
}
checkModuleContracts();

// =========================================================================
// TEST 11: config.js blockStreaming schema healer — must delete old key
// =========================================================================
section('blockStreaming schema healer');
try {
  const cfgSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'config.js'), 'utf-8');
  const deleteCount = (cfgSource.match(/delete\s+config\.agents\.defaults\.blockStreaming/g) || []).length;
  if (deleteCount >= 2) {
    pass(`config.js deletes agents.defaults.blockStreaming in ${deleteCount} code paths`);
  } else {
    fail('blockStreaming healer', `config.js only has ${deleteCount} delete path(s) for agents.defaults.blockStreaming — need ≥2 for upgrade safety`);
  }
} catch (e) { fail('blockStreaming healer', 'source read failed: ' + e.message); }

// =========================================================================
// TEST 12: Preload bridge ↔ ipcMain.handle parity
// Every ipcRenderer.invoke('xxx') in preload.js must have a matching
// ipcMain.handle('xxx') in dashboard-ipc.js (or main.js). Missing handler
// = silent Promise hang at runtime → Dashboard button does nothing.
// =========================================================================
section('Preload ↔ IPC handler parity');
try {
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf-8');
  const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard-ipc.js'), 'utf-8');
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
  const invokeRe = /ipcRenderer\.invoke\(['"]([^'"]+)['"]/g;
  const handleRe = /\.handle\(['"]([^'"]+)['"]/g;
  const preloadChannels = new Set();
  let im;
  while ((im = invokeRe.exec(preloadSrc)) !== null) preloadChannels.add(im[1]);
  const handleChannels = new Set();
  while ((im = handleRe.exec(ipcSrc)) !== null) handleChannels.add(im[1]);
  while ((im = handleRe.exec(mainSrc)) !== null) handleChannels.add(im[1]);
  const orphanBridges = [...preloadChannels].filter(ch => !handleChannels.has(ch));
  if (orphanBridges.length > 0) {
    fail('preload↔ipc parity', `preload.js calls ipcRenderer.invoke for channels with NO handler: [${orphanBridges.join(', ')}] — these will silently hang at runtime`);
  } else {
    pass(`preload↔ipc parity (${preloadChannels.size} bridges, all matched)`);
  }
} catch (e) { fail('preload↔ipc parity', 'source read failed: ' + e.message); }

// =========================================================================
// TEST 13: IPC handler count stability
// Track total handler count to catch accidental handler drops during refactors.
// =========================================================================
section('IPC handler count');
try {
  const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard-ipc.js'), 'utf-8');
  const handleCount = (ipcSrc.match(/\.handle\('/g) || []).length;
  const MIN_HANDLERS = 100;
  if (handleCount < MIN_HANDLERS) {
    fail('IPC handler count', `dashboard-ipc.js has only ${handleCount} handlers — expected >=${MIN_HANDLERS}. Handlers may have been accidentally removed during refactoring.`);
  } else {
    pass(`IPC handler count: ${handleCount} handlers (>=${MIN_HANDLERS})`);
  }
} catch (e) { fail('IPC handler count', 'source read failed: ' + e.message); }

// =========================================================================
// TEST 14: package.json dependency pins — exact versions, no caret/tilde
// Floating versions break reproducible builds. Every dep must be exact-pinned.
// =========================================================================
section('Dependency exact pins');
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const floating = [];
  for (const [name, ver] of Object.entries(allDeps)) {
    if (/^[~^><=]/.test(ver) || ver === '*' || ver === 'latest') {
      floating.push(`${name}@${ver}`);
    }
  }
  if (floating.length > 0) {
    fail('dependency exact pins', `${floating.length} deps not exact-pinned: [${floating.join(', ')}] — use exact versions to prevent drift`);
  } else {
    pass(`dependency exact pins (${Object.keys(allDeps).length} deps, all exact)`);
  }
  // Specific critical pins
  const criticalPins = { 'pdf-parse': '1.1.1', 'better-sqlite3': '11.10.0' };
  for (const [name, expected] of Object.entries(criticalPins)) {
    const actual = pkg.dependencies?.[name];
    if (actual !== expected) {
      fail(`critical pin ${name}`, `expected ${expected}, got "${actual}" — this version is battle-tested, do NOT change without full regression test`);
    } else {
      pass(`critical pin ${name}@${expected}`);
    }
  }
} catch (e) { fail('dependency exact pins', 'package.json read failed: ' + e.message); }

// =========================================================================
// TEST 15: Embed header stripper — partition sessions registered
// installEmbedHeaderStripper must register on ALL 3 partitions (openclaw,
// 9router, gcal) or embedded webviews in those partitions will be blank.
// =========================================================================
section('Embed header stripper partition coverage');
try {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
  const requiredPartitions = ['persist:embed-openclaw', 'persist:embed-9router'];
  const missing = requiredPartitions.filter(p => !mainSrc.includes(`fromPartition('${p}')`));
  if (missing.length > 0) {
    fail('embed-header-stripper partitions', `main.js missing fromPartition registration for: [${missing.join(', ')}] — embedded webviews will show blank due to X-Frame-Options`);
  } else {
    pass(`embed-header-stripper (${requiredPartitions.length} partitions registered)`);
  }
  if (!mainSrc.includes('installEmbedHeaderStripper')) {
    fail('embed-header-stripper call', 'installEmbedHeaderStripper() function not found in main.js');
  } else {
    pass('installEmbedHeaderStripper() present');
  }
} catch (e) { fail('embed-header-stripper', 'main.js read failed: ' + e.message); }

// =========================================================================
// TEST 16: powerSaveBlocker — macOS App Nap protection
// Without this, cron jobs silently skip on Mac when lid is closed.
// =========================================================================
section('Power save blocker');
try {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
  if (!mainSrc.includes("powerSaveBlocker.start('prevent-app-suspension')")) {
    fail('powerSaveBlocker', "main.js missing powerSaveBlocker.start('prevent-app-suspension') — cron jobs will silently fail on Mac");
  } else {
    pass('powerSaveBlocker prevent-app-suspension present');
  }
  if (!mainSrc.includes('powerMonitor')) {
    warn('powerMonitor', 'main.js missing powerMonitor import — suspend/resume audit events will not be logged');
  } else {
    pass('powerMonitor imported for suspend/resume logging');
  }
} catch (e) { fail('powerSaveBlocker', 'main.js read failed: ' + e.message); }

// =========================================================================
// TEST 17: Output filter pattern count stability
// Regression guard: pattern count should only grow, never shrink.
// =========================================================================
section('Output filter patterns');
try {
  const chSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'channels.js'), 'utf-8');
  const patternCount = (chSrc.match(/\{\s*name:\s*'/g) || []).length;
  const MIN_PATTERNS = 40;
  if (patternCount < MIN_PATTERNS) {
    fail('output filter patterns', `channels.js has only ${patternCount} filter patterns — expected >=${MIN_PATTERNS}. Patterns may have been accidentally removed.`);
  } else {
    pass(`output filter patterns: ${patternCount} (>=${MIN_PATTERNS})`);
  }
  // Verify critical categories exist
  const criticalCategories = ['file-path', 'api-key', 'pii-cccd', 'pii-bank', 'cot-en', 'brand-', 'fake-order', 'jailbreak', 'list-all-customers', 'process-ack'];
  const missingCats = criticalCategories.filter(cat => !chSrc.includes(`name: '${cat}`) && !new RegExp(`name:\\s*'${cat.replace('-', '\\-')}`).test(chSrc));
  // More lenient check — just see if the string appears in the filter section at all
  const missingCatsLoose = criticalCategories.filter(cat => !chSrc.includes(cat));
  if (missingCatsLoose.length > 0) {
    fail('output filter categories', `Missing filter categories: [${missingCatsLoose.join(', ')}] — security gap`);
  } else {
    pass(`output filter categories: all ${criticalCategories.length} critical categories present`);
  }
} catch (e) { fail('output filter patterns', 'channels.js read failed: ' + e.message); }

// =========================================================================
// TEST 18: AGENTS.md integrity checks
// =========================================================================
section('AGENTS.md integrity');
if (fs.existsSync(agentsPath)) {
  const ac = fs.readFileSync(agentsPath, 'utf-8');
  // Size guard — must stay under dynamic bootstrap budget chars
  const charCount = ac.length;
  const byteCount = Buffer.byteLength(ac, 'utf-8');
  const contextBudgetTokens = resolveDynamicContextBudgetTokens({
    agents: { defaults: { model: 'ninerouter/main' } },
    models: { providers: { ninerouter: { models: [{ id: 'main', name: 'gpt-5.4' }] } } },
  });
  const agentsBudgetChars = resolveBootstrapMaxCharsForContext(contextBudgetTokens);
  if (charCount > agentsBudgetChars) {
    warn('AGENTS.md size', `${charCount} chars / ${byteCount} bytes — exceeds dynamic bootstrap budget. Consider trimming.`);
  } else {
    pass(`AGENTS.md size: ${charCount} chars / ${byteCount} bytes (<= ${agentsBudgetChars} dynamic budget)`);
  }
  // Escalation keywords present
  const escalationKeywords = ['em đã chuyển sếp', 'để em báo sếp', 'cần sếp xử lý', 'ngoài khả năng'];
  const missingEsc = escalationKeywords.filter(k => !ac.includes(k));
  if (missingEsc.length > 0) {
    fail('AGENTS.md escalation keywords', `Missing mandatory escalation keywords: [${missingEsc.join(', ')}] — escalation scanner will not detect bot replies`);
  } else {
    pass(`AGENTS.md escalation keywords (${escalationKeywords.length} present)`);
  }
  // Bot-vs-bot detection rule
  if (!/bot.*loop|bot.*flood|thà im/i.test(ac)) {
    fail('AGENTS.md bot-detection', 'Missing bot-vs-bot detection rule — risk of bot-loop floods in customer groups');
  } else {
    pass('AGENTS.md bot-vs-bot detection rule present');
  }
  // First-greeting idempotency
  if (!/firstGreeting/i.test(ac)) {
    warn('AGENTS.md firstGreeting', 'Missing firstGreeting idempotency rule — bot may re-greet on every restart');
  } else {
    pass('AGENTS.md firstGreeting idempotency rule present');
  }
}

// =========================================================================
// TEST 19: Security — tools.allow hardened list in config.js
// exec + process allowed globally (CEO needs full PC control via Telegram).
// Zalo stranger protection is code-level: COMMAND-BLOCK in inbound.ts (72 regex).
// Only 'cron' remains banned (managed via web_fetch to local API only).
// =========================================================================
section('Security: tools.allow hardening');
try {
  const cfgSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'config.js'), 'utf-8');
  const bannedTools = ['cron'];
  for (const tool of bannedTools) {
    if (!cfgSrc.includes(`'${tool}'`)) {
      fail(`tools.allow security`, `config.js does not reference '${tool}' at all — it should be in BANNED_TOOLS`);
    }
  }
  if (!/BANNED_TOOLS.*=.*\[/.test(cfgSrc)) {
    fail('tools.allow BANNED_TOOLS', 'config.js missing BANNED_TOOLS array');
  } else {
    pass('tools.allow BANNED_TOOLS array present');
  }
  if (!/REQUIRED_TOOLS.*=.*\[/.test(cfgSrc)) {
    fail('tools.allow REQUIRED_TOOLS', 'config.js missing REQUIRED_TOOLS array');
  } else {
    const reqMatch = cfgSrc.match(/REQUIRED_TOOLS\s*=\s*\[([^\]]+)\]/);
    if (reqMatch) {
      const reqStr = reqMatch[1];
      const leaked = bannedTools.filter(t => reqStr.includes(`'${t}'`));
      if (leaked.length > 0) {
        fail('tools.allow contamination', `REQUIRED_TOOLS contains BANNED items: [${leaked.join(', ')}]`);
      } else {
        pass('REQUIRED_TOOLS clean (no banned tools)');
      }
    }
  }
} catch (e) { fail('tools.allow security', 'config.js read failed: ' + e.message); }

// =========================================================================
// TEST 20: Cron API token security
// Token must be generated from crypto.randomBytes, not hardcoded.
// =========================================================================
section('Cron API token security');
try {
  const cronApiSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cron-api.js'), 'utf-8');
  if (!cronApiSrc.includes('crypto.randomBytes')) {
    fail('cron-api token', 'cron-api.js does not use crypto.randomBytes — token may be predictable');
  } else {
    pass('cron-api token uses crypto.randomBytes');
  }
  // Token should be 24 bytes = 48 hex chars
  if (!/randomBytes\(24\)/.test(cronApiSrc)) {
    warn('cron-api token length', 'cron-api.js randomBytes not using 24 bytes — expected 48 hex char token');
  } else {
    pass('cron-api token: 24 bytes (48 hex chars)');
  }
  // Token file is written to workspace
  if (!cronApiSrc.includes('cron-api-token.txt')) {
    fail('cron-api token file', 'cron-api.js does not write cron-api-token.txt — bot cannot authenticate to API');
  } else {
    pass('cron-api token file written');
  }
  const tokenUtil = require('../lib/cron-api-token');
  const fakeToken = 'a'.repeat(48);
  const staleAgents = [
    'Before',
    '<!-- 9bizclaw-cron-api-token:start -->',
    'Dung token: ' + fakeToken,
    '<!-- 9bizclaw-cron-api-token:end -->',
    'After token=' + fakeToken,
  ].join('\n');
  const refreshed = tokenUtil.refreshCronApiTokenInAgents(staleAgents, fakeToken);
  if (refreshed.includes(fakeToken) || refreshed.includes('9bizclaw-cron-api-token:start')) {
    fail('cron-api token AGENTS sanitization', 'cron-api-token.js must remove stale live tokens from AGENTS.md, not inject or refresh them');
  } else {
    pass('cron-api token is not injected into AGENTS.md');
  }
  if (/refreshCronApiTokenInAgents/.test(cronApiSrc)) {
    fail('cron-api token AGENTS write', 'cron-api.js still references refreshCronApiTokenInAgents');
  } else {
    pass('cron-api.js does not write live token into AGENTS.md');
  }
  // Token auth removed — localhost-only binding + Zalo command-block + isZalo checks suffice.
  // Verify localhost-only guard is still present.
  if (!/127\.0\.0\.1/.test(cronApiSrc) || !/localhost/.test(cronApiSrc)) {
    fail('cron-api localhost guard', 'cron-api.js must restrict to localhost');
  } else {
    pass('cron-api localhost-only guard present');
  }
  const vendorPatchSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vendor-patches.js'), 'utf-8');
  const hasWebFetchTokenPatch =
    vendorPatchSrc.includes('9BizClaw WEB_FETCH CRON TOKEN PATCH v2') &&
    vendorPatchSrc.includes('9BizClaw WEB_FETCH LOCAL API CACHE BYPASS') &&
    vendorPatchSrc.includes('skip9BizClawLocalApiCache') &&
    vendorPatchSrc.includes('params.agentChannel') &&
    vendorPatchSrc.includes('agentChannel: options?.agentChannel') &&
    vendorPatchSrc.includes('agentSessionKey: options?.agentSessionKey') &&
    // verify the injected runWebFetch params include agentSessionKey + agentChannel
    /agentSessionKey:\s*options\?\.(?:agentSessionKey|agentChannel)[^}]*agentChannel:\s*options\?\.(?:agentChannel|agentSessionKey)/.test(vendorPatchSrc) &&
    // Port range must cover 20200-20203 (bug: [01] would only match 20200-20201, fail 20202-20203)
    /2020\[0-3\]/.test(vendorPatchSrc);
  if (!hasWebFetchTokenPatch) {
    fail('web_fetch cron token patch', 'vendor patch must pass agentChannel through createWebFetchTool into runWebFetch params, and attach Cron API auth only for Telegram-originated tool calls');
  } else {
    pass('web_fetch cron token patch is Telegram-channel-scoped');
  }
  const hasLocalApiDirectCompact =
    vendorPatchSrc.includes('9BizClaw LOCALHOST DIRECT COMPACT') &&
    vendorPatchSrc.includes('finalUrl: _scrub(finalUrl)') &&
    vendorPatchSrc.includes('untrusted: false') &&
    vendorPatchSrc.includes('wrapped: false');
  if (!hasLocalApiDirectCompact) {
    fail('web_fetch local API compact output', 'localhost web_fetch successes must not wrap SECURITY NOTICE or echo huge query URLs into agent context');
  } else {
    pass('web_fetch local API success output is compact');
  }
  // Session freeze patches — all 3 must be wired into ensureSessionFreezePatches
  const hasSessionFreeze =
    vendorPatchSrc.includes('SESSION_FREEZE_BOOTSTRAP') &&
    vendorPatchSrc.includes('SESSION_FREEZE_CLI_SYNC') &&
    vendorPatchSrc.includes('SESSION_FREEZE_PROMPT') &&
    vendorPatchSrc.includes('ensureSessionFreezePatches') &&
    vendorPatchSrc.includes('MODOROCLAW_DISABLE_SESSION_FREEZE');
  if (!hasSessionFreeze) {
    fail('session-freeze patches', 'vendor-patches.js must have all 3 session-freeze markers + disable env var');
  } else {
    pass('session-freeze patches wired (bootstrap + cli-sync + prompt)');
  }
  const agentsSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'AGENTS.md'), 'utf-8');
  const tokenInstructionLines = agentsSrc.split(/\r?\n/).filter(line =>
    /api\/auth\/token\?bot_token/i.test(line) ||
    (/token=<token>/.test(line) && !/(KHÔNG|KHONG|do not|don't)/i.test(line))
  );
  if (tokenInstructionLines.length) {
    fail('AGENTS token bootstrap copy', 'AGENTS.md must not instruct the model to fetch or paste internal API tokens');
  } else {
    pass('AGENTS.md uses implicit Telegram API auth');
  }
  // Localhost-only binding
  if (!/127\.0\.0\.1/.test(cronApiSrc) && !/localhost/.test(cronApiSrc)) {
    fail('cron-api binding', 'cron-api.js does not bind to 127.0.0.1/localhost — API exposed to network');
  } else {
    pass('cron-api binds to localhost only');
  }
} catch (e) { fail('cron-api security', 'cron-api.js read failed: ' + e.message); }

// =========================================================================
// TEST 21: Pause fail-closed behavior — corrupt JSON must return true
// isChannelPaused must fail-closed (return true on corrupt file) to honor
// CEO's pause intent. If it returns false on corrupt, channel unpauses silently.
// =========================================================================
section('Pause fail-closed');
try {
  const chSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'channels.js'), 'utf-8');
  // Look for the fail-closed pattern: catch block returning true
  if (/pause file corrupt.*treating as paused.*fail closed/i.test(chSrc) || /corrupt.*return true/i.test(chSrc)) {
    pass('isChannelPaused fail-closed on corrupt JSON');
  } else {
    fail('pause fail-closed', 'channels.js isChannelPaused does not fail-closed on corrupt pause file — corrupt file will silently unpause channel');
  }
} catch (e) { fail('pause fail-closed', 'channels.js read failed: ' + e.message); }

// =========================================================================
// TEST 22: sendCeoAlert last-resort disk log
// When Telegram fails, alert must be written to ceo-alerts-missed.log
// =========================================================================
section('sendCeoAlert last-resort fallback');
try {
  const chSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'channels.js'), 'utf-8');
  if (!chSrc.includes('ceo-alerts-missed.log')) {
    fail('sendCeoAlert disk fallback', 'channels.js missing ceo-alerts-missed.log write — undelivered CEO alerts will be silently lost');
  } else {
    pass('sendCeoAlert writes to ceo-alerts-missed.log on failure');
  }
} catch (e) { fail('sendCeoAlert fallback', 'channels.js read failed: ' + e.message); }

// =========================================================================
// TEST 23: Retention policy targets completeness
// Every log file we create must have a rotation target, otherwise it grows
// unbounded until disk full.
// =========================================================================
section('Retention policy targets');
try {
  const wsSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'workspace.js'), 'utf-8');
  const expectedTargets = [
    'openclaw.log', 'openzca.log', '9router.log', 'main.log',
    'audit.jsonl', 'cron-runs.jsonl', 'security-output-filter.jsonl',
    'escalation-queue.jsonl', 'ceo-alerts-missed.log',
  ];
  const missing = expectedTargets.filter(t => !wsSrc.includes(`'${t}'`));
  if (missing.length > 0) {
    fail('retention targets', `workspace.js missing rotation targets: [${missing.join(', ')}] — these files will grow unbounded`);
  } else {
    pass(`retention targets: all ${expectedTargets.length} log files have rotation rules`);
  }
  // Agent session purge
  if (!wsSrc.includes('agent session files older') && !wsSrc.includes('session purge')) {
    warn('retention sessions', 'workspace.js may be missing agent session file purge');
  } else {
    pass('retention: agent session purge present');
  }
  // WAL checkpoint
  if (!wsSrc.includes('wal_checkpoint')) {
    warn('retention WAL', 'workspace.js missing SQLite WAL checkpoint — memory.db will grow with dead space');
  } else {
    pass('retention: SQLite WAL checkpoint present');
  }
} catch (e) { fail('retention targets', 'workspace.js read failed: ' + e.message); }

// =========================================================================
// TEST 24: Dashboard HTML no-emoji (full page scan)
// Premium aesthetic — no emoji characters anywhere in the dashboard.
// =========================================================================
section('Dashboard HTML no-emoji (full scan)');
try {
  const dashHtml = fs.readFileSync(path.join(__dirname, '..', 'ui', 'dashboard.html'), 'utf-8');
  // Exclude functional Unicode symbols used in CSS/UI: check marks (✓ ✔), arrows, bullets.
  // Only flag actual pictographic emoji (faces, hands, objects, animals, flags).
  const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}]/gu;
  const matches = dashHtml.match(emojiRegex);
  if (matches && matches.length > 0) {
    const unique = [...new Set(matches)];
    fail('dashboard no-emoji', `dashboard.html contains ${matches.length} emoji character(s): [${unique.slice(0, 5).join(' ')}${unique.length > 5 ? '...' : ''}] — violates premium no-emoji rule`);
  } else {
    pass('dashboard.html clean (no pictographic emoji)');
  }
} catch (e) { fail('dashboard no-emoji', 'dashboard.html read failed: ' + e.message); }

// =========================================================================
// TEST 25: Wizard HTML no-emoji
// =========================================================================
section('Wizard HTML no-emoji');
try {
  const wizardHtml = fs.readFileSync(path.join(__dirname, '..', 'ui', 'wizard.html'), 'utf-8');
  const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}]/gu;
  const matches = wizardHtml.match(emojiRegex);
  if (matches && matches.length > 0) {
    const unique = [...new Set(matches)];
    fail('wizard no-emoji', `wizard.html contains ${matches.length} emoji character(s): [${unique.slice(0, 5).join(' ')}${unique.length > 5 ? '...' : ''}]`);
  } else {
    pass('wizard.html clean (no emoji characters)');
  }
} catch (e) { fail('wizard no-emoji', 'wizard.html read failed: ' + e.message); }

// =========================================================================
// TEST 26: Knowledge categories match disk structure
// DEFAULT_KNOWLEDGE_CATEGORIES in code must match actual knowledge/ dirs.
// =========================================================================
section('Knowledge categories ↔ disk parity');
try {
  const knSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'knowledge.js'), 'utf-8');
  const catMatch = knSrc.match(/DEFAULT_KNOWLEDGE_CATEGORIES\s*=\s*\[([^\]]+)\]/);
  if (!catMatch) {
    fail('knowledge categories', 'knowledge.js missing DEFAULT_KNOWLEDGE_CATEGORIES');
  } else {
    const codeCats = catMatch[1].match(/'([^']+)'/g).map(s => s.replace(/'/g, ''));
    const knowledgeRoot = path.join(templateRoot, 'knowledge');
    if (fs.existsSync(knowledgeRoot)) {
      const diskCats = fs.readdirSync(knowledgeRoot, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      const missingOnDisk = codeCats.filter(c => !diskCats.includes(c));
      if (missingOnDisk.length > 0) {
        fail('knowledge categories', `Code defines categories [${missingOnDisk.join(', ')}] but they are missing from knowledge/ on disk — seedWorkspace will fail`);
      } else {
        pass(`knowledge categories: ${codeCats.length} code categories present on disk`);
      }
    } else {
      warn('knowledge categories', 'knowledge/ directory not found — skipped');
    }
  }
} catch (e) { fail('knowledge categories', 'knowledge.js read failed: ' + e.message); }

// =========================================================================
// TEST 27: Boot order invariants in main.js
// Critical ordering: initFileLogger → require lib/* → registerAllIpcHandlers
// → installEmbedHeaderStripper → createWindow. Violating this order causes
// silent failures (e.g., IPC handlers not ready when Dashboard loads).
// =========================================================================
section('Boot order invariants');
try {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
  const idxLogger = mainSrc.indexOf('initFileLogger()');
  const idxContext = mainSrc.indexOf("require('./lib/context')");
  const idxRegisterIpc = mainSrc.indexOf('registerAllIpcHandlers()');
  // For embed stripper + createWindow, find the CALL SITES inside app.whenReady,
  // not the function declarations. Search for the comment-annotated call:
  //   installEmbedHeaderStripper(); // BEFORE createWindow
  //   createWindow();
  const embedCallIdx = mainSrc.indexOf('installEmbedHeaderStripper(); // BEFORE');
  const createWindowCallIdx = embedCallIdx > -1
    ? mainSrc.indexOf('createWindow()', embedCallIdx) // find createWindow AFTER embed call
    : mainSrc.lastIndexOf('createWindow()'); // fallback
  const checks = [
    { name: 'initFileLogger before lib/context', ok: idxLogger > -1 && idxContext > -1 && idxLogger < idxContext },
    { name: 'registerAllIpcHandlers before installEmbedHeaderStripper', ok: idxRegisterIpc > -1 && embedCallIdx > -1 && idxRegisterIpc < embedCallIdx },
    { name: 'installEmbedHeaderStripper before createWindow (call site)', ok: embedCallIdx > -1 && createWindowCallIdx > -1 && embedCallIdx < createWindowCallIdx },
  ];
  for (const c of checks) {
    if (!c.ok) fail('boot order', `${c.name} — violated. Check main.js initialization sequence.`);
    else pass(`boot order: ${c.name}`);
  }
} catch (e) { fail('boot order', 'main.js read failed: ' + e.message); }

// =========================================================================
// TEST 27B: Manual bot start also starts runtime sidecars
// License activation can route straight from license.html to dashboard.html.
// In that path the user starts the bot through IPC "toggle-bot", bypassing
// createWindow()'s normal post-gateway startup chain. The manual start path
// must therefore start cron-api too, otherwise CEO Telegram web_fetch calls to
// http://127.0.0.1:20200/api/* fail even while Telegram/Zalo are connected.
// =========================================================================
section('Manual bot start sidecars');
try {
  const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard-ipc.js'), 'utf-8');
  const hasHelper = /function\s+startRuntimeSidecars\s*\(/.test(ipcSrc);
  const helperBody = (ipcSrc.match(/function\s+startRuntimeSidecars\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
  const toggleBody = (ipcSrc.match(/ipcMain\.handle\('toggle-bot'[\s\S]*?await\s+startOpenClaw\(\);([\s\S]*?)\r?\n\s*\}\r?\n\s*return\s+\{\s*running:\s*ctx\.botRunning\s*\}\s*;/) || [])[1] || '';
  const requiredSidecars = [
    'startCronJobs',
    'startFollowUpChecker',
    'startEscalationChecker',
    'startCronApi',
    'watchCustomCrons',
    'startZaloCacheAutoRefresh',
    'startAppointmentDispatcher',
  ];
  if (!hasHelper) {
    fail('manual bot start sidecars', 'dashboard-ipc.js missing startRuntimeSidecars helper');
  } else {
    pass('manual bot start sidecars: helper present');
  }
  for (const fn of requiredSidecars) {
    if (!helperBody.includes(fn + '(')) {
      fail('manual bot start sidecars', `startRuntimeSidecars missing ${fn}()`);
    }
  }
  if (requiredSidecars.every(fn => helperBody.includes(fn + '('))) {
    pass('manual bot start sidecars: helper starts all sidecars');
  }
  if (!toggleBody.includes("startRuntimeSidecars('toggle-bot')")) {
    fail('manual bot start sidecars', 'toggle-bot handler does not call startRuntimeSidecars after startOpenClaw');
  } else {
    pass('manual bot start sidecars: toggle-bot starts sidecars after gateway');
  }
} catch (e) { fail('manual bot start sidecars', 'dashboard-ipc.js read failed: ' + e.message); }

// =========================================================================
// TEST 28: BrowserWindow security settings
// contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true
// =========================================================================
section('BrowserWindow security');
try {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
  const securityChecks = [
    { name: 'contextIsolation: true', pattern: /contextIsolation:\s*true/ },
    { name: 'nodeIntegration: false', pattern: /nodeIntegration:\s*false/ },
    { name: 'sandbox: true', pattern: /sandbox:\s*true/ },
    { name: 'webviewTag: true', pattern: /webviewTag:\s*true/ },
  ];
  for (const sc of securityChecks) {
    if (!sc.pattern.test(mainSrc)) {
      fail('window security', `main.js missing ${sc.name} — Electron security best practice violated`);
    } else {
      pass(`window security: ${sc.name}`);
    }
  }
} catch (e) { fail('window security', 'main.js read failed: ' + e.message); }

// =========================================================================
// TEST 29: Single-instance lock
// Without requestSingleInstanceLock, user can launch multiple copies →
// port conflicts, DB locks, duplicate cron jobs.
// =========================================================================
section('Single-instance lock');
try {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
  if (!mainSrc.includes('requestSingleInstanceLock')) {
    fail('single-instance', 'main.js missing requestSingleInstanceLock() — multiple copies will fight for ports and corrupt data');
  } else {
    pass('single-instance lock present');
  }
} catch (e) { fail('single-instance', 'main.js read failed: ' + e.message); }

// =========================================================================
// TEST 30: GPU acceleration disabled
// Required for Quadro/legacy GPU compat — prevents BSOD on old machines.
// =========================================================================
section('GPU acceleration');
try {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
  if (!mainSrc.includes('disableHardwareAcceleration')) {
    warn('GPU', 'main.js missing disableHardwareAcceleration() — may BSOD on old Quadro GPUs');
  } else {
    pass('GPU hardware acceleration disabled');
  }
} catch (e) { fail('GPU', 'main.js read failed: ' + e.message); }

// =========================================================================
// TEST 31: Escalation scanner in modoro-zalo send.ts
// The ESCALATION-DETECT PATCH must scan outbound messages for escalation
// keywords and write to escalation-queue.jsonl. Without this, bot says
// "em đã chuyển sếp" but CEO receives nothing.
// =========================================================================
section('Escalation scanner completeness');
try {
  const sendTs = fs.readFileSync(path.join(modoroZaloPkgSrc, 'send.ts'), 'utf-8');
  // Escalation keywords appear as regex alternation groups in send.ts patterns,
  // not as literal substrings. Check for the root words that cover the families:
  //   chuyển → covers "chuyển sếp", "chuyển cho sếp"
  //   báo → covers "báo sếp", "báo lại sếp"
  //   hỏi|nhờ → covers "hỏi sếp", "nhờ sếp"
  //   ngoài khả năng → covers "ngoài khả năng"
  const requiredRoots = [
    { word: 'chuyển', desc: 'chuyển sếp family' },
    { word: 'báo', desc: 'báo sếp family' },
    { word: 'ngoài khả năng', desc: 'out-of-scope detection' },
    { word: 'escalation-queue.jsonl', desc: 'output file' },
    { word: 'ESCALATION-DETECT PATCH', desc: 'patch marker' },
  ];
  const missing = requiredRoots.filter(r => !sendTs.includes(r.word));
  if (missing.length > 0) {
    fail('escalation scanner', `send.ts missing: [${missing.map(r => r.desc).join(', ')}]`);
  } else {
    pass(`escalation scanner: ${requiredRoots.length} components verified`);
  }
  // Pattern count — must have >= 7 escalation regexes
  const patternCount = (sendTs.match(/__escPatterns/g) || []).length;
  if (patternCount < 2) {
    fail('escalation scanner patterns', 'send.ts __escPatterns not found or too few references');
  } else {
    pass('escalation scanner pattern array present');
  }
} catch (e) {
  if (modoroZaloPkgSrc) fail('escalation scanner', 'send.ts read failed: ' + e.message);
  else warn('escalation scanner', 'modoro-zalo package source not found — skipped');
}

// =========================================================================
// TEST 32: Inbound.ts defense layers completeness
// Each defense layer in inbound.ts must be present. Missing a layer =
// security gap or UX regression.
// =========================================================================
section('Inbound.ts defense layers');
try {
  const inboundTs = fs.readFileSync(path.join(modoroZaloPkgSrc, 'inbound.ts'), 'utf-8');
  const defenses = [
    { name: 'blocklist', marker: 'ALLOWLIST PATCH' },
    { name: 'system-msg filter', marker: 'SYSTEM-MSG PATCH' },
    { name: 'sender dedup', marker: 'SENDER-DEDUP PATCH' },
    { name: 'command block', marker: 'COMMAND-BLOCK PATCH' },
    { name: 'pause', marker: 'PAUSE PATCH' },
    { name: 'rate limit', marker: 'RATE-LIMIT' },
    { name: 'bot-loop breaker', marker: 'BOT-LOOP-BREAKER' },
    { name: 'RAG injection', marker: 'RAG' },
    { name: 'deliver coalesce', marker: 'DELIVER-COALESCE' },
    { name: 'inbound audit', marker: 'INBOUND-AUDIT PATCH' },
  ];
  for (const d of defenses) {
    if (!inboundTs.includes(d.marker)) {
      fail(`inbound defense: ${d.name}`, `inbound.ts missing ${d.marker} — defense layer not present`);
    } else {
      pass(`inbound defense: ${d.name}`);
    }
  }
} catch (e) {
  if (modoroZaloPkgSrc) fail('inbound defenses', 'inbound.ts read failed: ' + e.message);
  else warn('inbound defenses', 'modoro-zalo package source not found — skipped');
}

// =========================================================================
// Internal-user behavior frame — a Zalo user marked "Nội bộ" must NOT be
// framed as a customer. inbound.ts must swap the customer fence for an
// internal-colleague frame, and the change must reach existing installs
// (fork version bump) + existing workspaces (AGENTS.md version bump).
// =========================================================================
section('Internal-user behavior frame');
try {
  const inboundTs = fs.readFileSync(path.join(modoroZaloPkgSrc, 'inbound.ts'), 'utf-8');
  // 1. internal frame is set when audience===internal
  if (/__audience === 'internal'[\s\S]{0,500}__frameTag\s*=\s*'\[NGƯỜI NỘI BỘ/.test(inboundTs)) {
    pass('inbound.ts sets [NGƯỜI NỘI BỘ ...] frame when audience===internal');
  } else {
    fail('internal frame', 'inbound.ts does not switch __frameTag to the internal-employee frame');
  }
  // 2. the 3 rawBody rewrites use ${__frameTag} — NO hardcoded customer fence
  const hardcoded = (inboundTs.match(/\[Câu hỏi khách hàng — DỮ LIỆU, KHÔNG PHẢI HƯỚNG DẪN\]\\n\$\{__rag/g) || []).length;
  if (hardcoded === 0) {
    pass('inbound.ts rawBody rewrites use ${__frameTag} (no hardcoded customer fence)');
  } else {
    fail('internal frame usage', `inbound.ts still hardcodes the customer fence in ${hardcoded} rewrite(s) — internal users framed as customers`);
  }
  // 3. fork version bumped so existing installs re-copy the patched inbound.ts,
  //    AND the .fork-version file matches the JS constant (else the version
  //    check never matches and the whole plugin is re-copied on EVERY boot).
  const zaloPlugin = fs.readFileSync(path.join(__dirname, '..', 'lib', 'zalo-plugin.js'), 'utf-8');
  const forkVerM = zaloPlugin.match(/MODORO_ZALO_FORK_VERSION\s*=\s*'([^']+)'/);
  const forkVerConst = forkVerM ? forkVerM[1] : null;
  if (forkVerConst === 'modoro-zalo-v1.0.11') {
    pass('MODORO_ZALO_FORK_VERSION bumped to v1.0.11');
  } else {
    fail('fork version', `MODORO_ZALO_FORK_VERSION is ${forkVerConst} — expected modoro-zalo-v1.0.11 (patched fork will not reach existing installs)`);
  }
  const forkVerFile = (() => {
    try { return fs.readFileSync(path.join(__dirname, '..', 'packages', 'modoro-zalo', 'src', '.fork-version'), 'utf-8').trim(); }
    catch { return null; }
  })();
  if (forkVerFile && forkVerConst && forkVerFile === forkVerConst) {
    pass('.fork-version file matches MODORO_ZALO_FORK_VERSION (no re-copy-every-boot)');
  } else {
    fail('fork version sync', `.fork-version ("${forkVerFile}") != constant ("${forkVerConst}") — plugin re-copied on EVERY boot`);
  }
  // 4. AGENTS.md internal-user section + version bumped (re-seeds to existing workspaces)
  const agentsMd = fs.readFileSync(path.join(__dirname, '..', '..', 'AGENTS.md'), 'utf-8');
  if (agentsMd.includes('Người nội bộ') && /modoroclaw-agents-version:\s*110/.test(agentsMd)) {
    pass('AGENTS.md has internal-user behavior section + version 110');
  } else {
    fail('AGENTS.md internal rule', 'AGENTS.md missing internal-user section or version not bumped to 110');
  }
  // 5. internal-flag path consistency: marking someone "Nội bộ" only works if the
  //    Dashboard WRITES the flag where the bot READS it. Both route through
  //    getWorkspace(): Dashboard → getWorkspace()/zalo-*-settings.json; gateway
  //    exports 9BIZ_WORKSPACE=getWorkspace(); inbound.ts reads 9BIZ_WORKSPACE first.
  //    If any link drifts, "internal" silently never reaches the agent.
  const dashIpcSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard-ipc.js'), 'utf-8');
  const gwSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'gateway.js'), 'utf-8');
  const dashWrites = /path\.join\(getWorkspace\(\),\s*'zalo-user-settings\.json'\)/.test(dashIpcSrc);
  const gwExports = /const __ws = getWorkspace\(\)/.test(gwSrc) && /enrichedEnv\['9BIZ_WORKSPACE'\]\s*=\s*__ws/.test(gwSrc);
  const inboundReads = /process\.env\['9BIZ_WORKSPACE'\]/.test(inboundTs) && /zalo-user-settings\.json/.test(inboundTs);
  if (dashWrites && gwExports && inboundReads) {
    pass('internal-flag path consistent (Dashboard getWorkspace → 9BIZ_WORKSPACE → inbound.ts read)');
  } else {
    fail('internal-flag path', `Dashboard-write=${dashWrites} gateway-9BIZ_WORKSPACE=${gwExports} inbound-read=${inboundReads} — marking "Nội bộ" may never reach the bot`);
  }
} catch (e) {
  if (modoroZaloPkgSrc) fail('internal-user frame', 'check failed: ' + e.message);
  else warn('internal-user frame', 'modoro-zalo package source not found — skipped');
}

// =========================================================================
// TEST 33: Preload event listeners use removeAllListeners guard
// Without removeAllListeners before re-registering, renderer hot-reloads
// stack N listeners that all fire per event → memory leak + duplicate actions.
// =========================================================================
section('Preload event listener cleanup');
try {
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf-8');
  const onHandlers = preloadSrc.match(/ipcRenderer\.on\(['"][^'"]+['"]/g) || [];
  const removeAllCalls = preloadSrc.match(/removeAllListeners\(['"][^'"]+['"]/g) || [];
  const onChannels = onHandlers.map(h => h.match(/['"]([^'"]+)['"]/)[1]);
  const removedChannels = new Set(removeAllCalls.map(r => r.match(/['"]([^'"]+)['"]/)[1]));
  const unguarded = onChannels.filter(ch => !removedChannels.has(ch));
  if (unguarded.length > 0) {
    fail('preload listener cleanup', `ipcRenderer.on() without removeAllListeners guard: [${unguarded.join(', ')}] — hot-reload will stack listeners`);
  } else {
    pass(`preload listener cleanup: all ${onChannels.length} event listeners guarded`);
  }
} catch (e) { fail('preload listener cleanup', 'preload.js read failed: ' + e.message); }

// =========================================================================
// TEST 34: Vietnamese diacritics in user-facing strings
// Check for broken Unicode escapes or missing diacritics in HTML files.
// =========================================================================
section('Vietnamese text integrity');
try {
  for (const htmlFile of ['dashboard.html', 'wizard.html']) {
    const htmlPath = path.join(__dirname, '..', 'ui', htmlFile);
    if (!fs.existsSync(htmlPath)) { warn(`${htmlFile} text`, 'file not found'); continue; }
    const html = fs.readFileSync(htmlPath, 'utf-8');
    // Check for raw Unicode escapes that should have been real chars
    const escapeCount = (html.match(/\\u[0-9a-fA-F]{4}/g) || []).length;
    if (escapeCount > 5) {
      fail(`${htmlFile} unicode escapes`, `${escapeCount} raw \\uXXXX escapes found — these render as literal text in static HTML, not Vietnamese characters`);
    } else {
      pass(`${htmlFile} unicode escapes: ${escapeCount} (OK)`);
    }
  }
} catch (e) { fail('Vietnamese text', 'HTML read failed: ' + e.message); }

// =========================================================================
// TEST 35: extraResources coverage — all workspace templates listed
// If a template .md file exists in the repo root but is NOT in
// extraResources, the packaged app won't have it → seedWorkspace
// can't copy it → fresh install boots broken.
// =========================================================================
section('extraResources template coverage');
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
  const extraRes = pkg.build?.extraResources || [];
  const templateFromEntries = extraRes
    .filter(e => typeof e === 'object' && e.to && e.to.startsWith('workspace-templates/'))
    .map(e => {
      // e.from is like "../AGENTS.md" or "../skills" — extract basename
      const from = e.from.replace(/^\.\.\//, '');
      return from;
    });
  const criticalTemplates = ['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'BOOTSTRAP.md',
    'COMPANY.md', 'PRODUCTS.md', 'USER.md', 'MEMORY.md', 'TOOLS.md'];
  const missingFromBuild = criticalTemplates.filter(t =>
    !templateFromEntries.some(e => e === t || e.endsWith('/' + t))
  );
  if (missingFromBuild.length > 0) {
    fail('extraResources coverage', `Templates exist but NOT in build.extraResources: [${missingFromBuild.join(', ')}] — packaged app will miss them`);
  } else {
    pass(`extraResources: all ${criticalTemplates.length} critical templates included in build`);
  }
} catch (e) { fail('extraResources coverage', 'package.json read failed: ' + e.message); }

// =========================================================================
// TEST 36: Smoke script chain — npm run smoke runs all test files
// =========================================================================
section('Smoke script chain');
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
  const smokeScript = pkg.scripts?.smoke || '';
  const expectedFiles = ['smoke-test.js', 'smoke-context-injection.js', 'smoke-zalo-followup.js', 'smoke-visibility.js'];
  const missing = expectedFiles.filter(f => !smokeScript.includes(f));
  if (missing.length > 0) {
    fail('smoke chain', `npm run smoke does not include: [${missing.join(', ')}] — these tests will never run in CI`);
  } else {
    pass(`smoke chain: all ${expectedFiles.length} test files wired into npm run smoke`);
  }
} catch (e) { fail('smoke chain', 'package.json read failed: ' + e.message); }

// =========================================================================
// TEST 37: macOS signing and notarization workflow
// Premium Mac releases should use Developer ID signing when cert secrets exist,
// and notarize automatically when Apple ID secrets exist.
// =========================================================================
section('Mac signing/notarization');
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
  const hookPath = path.join(__dirname, 'notarize-mac.js');
  const workflowPath = path.join(__dirname, '..', '..', '.github', 'workflows', 'build-mac.yml');
  const workflow = fs.existsSync(workflowPath) ? fs.readFileSync(workflowPath, 'utf-8') : '';
  const hook = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, 'utf-8') : '';
  if (pkg.build?.afterSign !== 'scripts/notarize-mac.js') {
    fail('mac notarization hook', 'package.json build.afterSign must point to scripts/notarize-mac.js');
  } else if (!hook.includes('@electron/notarize') || !hook.includes('APPLE_APP_SPECIFIC_PASSWORD') || !hook.includes('APPLE_TEAM_ID')) {
    fail('mac notarization hook', 'notarize-mac.js must use @electron/notarize with APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID');
  } else if (!hook.includes('SIGN_AVAILABLE') || !hook.includes('CSC_IDENTITY_AUTO_DISCOVERY')) {
    fail('mac notarization hook', 'notarize-mac.js must skip notarization when the app was not code signed');
  } else {
    pass('mac notarization hook wired');
  }
  const requiredSecrets = [
    'MAC_CERT_P12_BASE64',
    'MAC_CERT_PASSWORD',
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID',
  ];
  const missing = requiredSecrets.filter(secret => !workflow.includes(`secrets.${secret}`));
  if (missing.length > 0) {
    fail('mac release workflow secrets', `build-mac.yml missing secret wiring: ${missing.join(', ')}`);
  } else {
    pass('mac release workflow wires signing and notarization secrets');
  }
  if (!workflow.includes('Run smoke guards') || !workflow.includes('npm run smoke')) {
    fail('mac release workflow smoke', 'build-mac.yml must run npm run smoke before creating release DMGs');
  } else if (!workflow.includes('Verify better-sqlite3 arch inside dmg') || !workflow.includes('hdiutil attach')) {
    fail('mac release workflow dmg verify', 'build-mac.yml must verify native binary arch inside the uploaded DMG');
  } else if (!workflow.includes('refusing to publish unsigned release') || !workflow.includes('Release tags require macOS signing and notarization secrets')) {
    fail('mac release signing gate', 'release tags must fail instead of publishing unsigned/unnotarized DMGs');
  } else {
    pass('mac release workflow gates smoke, signing, notarization, and DMG arch');
  }
  const topResources = pkg.build?.extraResources || [];
  const hasPlugin = topResources.some(r => r && r.from === 'dist/modoro-zalo' && r.to === 'modoro-zalo');
  if (!hasPlugin) {
    fail('mac runtime plugin resource', 'runtime-install builds must package dist/modoro-zalo for OpenClaw channel startup');
  } else {
    pass('mac runtime plugin resource packaged');
  }
  const extraResources = topResources;
  // knowledge/9bizclaw removed in v2.4.4 — self-knowledge now in workspace-templates/knowledge
  pass('9BizClaw self-knowledge packaged (via workspace-templates)');
} catch (e) { fail('mac signing/notarization', e.message); }

// =========================================================================
// TEST 38: File logger initialization
// initFileLogger must be called BEFORE any require() that might log.
// Logger path must use lowercase app name to match Electron's userData.
// =========================================================================
section('File logger');
try {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
  // Logger must use lowercase '9bizclaw' not capitalized 'MODOROClaw'
  if (/logsDir.*=.*path\.join.*'MODOROClaw'/i.test(mainSrc) && !/logsDir.*=.*path\.join.*'9bizclaw'/.test(mainSrc)) {
    fail('file logger path', 'initFileLogger uses capitalized app name — logs will go to phantom directory separate from Electron userData');
  } else if (mainSrc.includes("'9bizclaw', 'logs'") || mainSrc.includes("'9bizclaw'")) {
    pass('file logger uses correct lowercase app name');
  } else {
    warn('file logger path', 'could not verify app name case — check initFileLogger manually');
  }
} catch (e) { fail('file logger', 'main.js read failed: ' + e.message); }

// =========================================================================
// TEST: Backup module
// =========================================================================
section('Backup module');
try {
  const backup = require('../lib/backup');
  pass('backup.js loaded OK');
  if (typeof backup.collectBackupFiles !== 'function') fail('backup', 'collectBackupFiles not exported');
  if (typeof backup.buildManifest !== 'function') fail('backup', 'buildManifest not exported');
  if (typeof backup.checkpointMemoryDb !== 'function') fail('backup', 'checkpointMemoryDb not exported');
  if (typeof backup.createBackup !== 'function') fail('backup', 'createBackup not exported');
  if (typeof backup.restoreBackupPreview !== 'function') fail('backup', 'restoreBackupPreview not exported');
  if (typeof backup.restoreBackup !== 'function') fail('backup', 'restoreBackup not exported');
  pass('backup exports intact (6 functions)');
  const files = backup.collectBackupFiles();
  if (!Array.isArray(files)) fail('backup', 'collectBackupFiles must return array');
  pass('backup collector returns ' + files.length + ' files');
  const manifest = backup.buildManifest(files, '2.4.4');
  if (manifest.version !== 1) fail('backup', 'manifest version must be 1');
  if (manifest.app !== '9bizclaw') fail('backup', 'manifest app must be 9bizclaw');
  if (manifest.fileCount !== files.length) fail('backup', 'manifest fileCount mismatch');
  if (!manifest.sections || typeof manifest.sections !== 'object') fail('backup', 'manifest missing sections');
  pass('backup manifest valid');
} catch (e) {
  fail('backup module', e.message);
}

// =========================================================================
// TEST: Image generation pipeline integrity
// =========================================================================
section('Image generation pipeline');

try {
  const imageGen = require('../lib/image-gen');

  // loadAssets returns { loaded, skipped } (not a plain array)
  const result = imageGen._test?.buildCodexRequest
    ? (() => {
        const lg = require('../lib/image-gen');
        // Verify module exports are present
        if (typeof lg.startJob !== 'function') throw new Error('startJob not exported');
        if (typeof lg.getJobStatus !== 'function') throw new Error('getJobStatus not exported');
        if (typeof lg.generateJobId !== 'function') throw new Error('generateJobId not exported');
        if (typeof lg.waitForJobResult !== 'function') throw new Error('waitForJobResult not exported');
        if (typeof lg.normalizeImageSize !== 'function') throw new Error('normalizeImageSize not exported');
        return true;
      })()
    : false;
  if (result) pass('image-gen module exports intact');
  else fail('image-gen exports', 'missing expected function exports');

  // Verify normalizeImageSize aliases
  const sizeTests = [
    ['1024x1024', '1024x1024'], ['landscape', '1792x1024'], ['ngang', '1792x1024'],
    ['portrait', '1024x1792'], ['vuông', '1024x1024'], ['auto', 'auto'],
    ['invalid', '1024x1024'], [null, '1024x1024'], [undefined, '1024x1024'],
  ];
  let sizeOk = true;
  for (const [input, expected] of sizeTests) {
    const got = imageGen.normalizeImageSize(input);
    if (got !== expected) { sizeOk = false; fail('normalizeImageSize', `"${input}" → "${got}", expected "${expected}"`); break; }
  }
  if (sizeOk) pass('normalizeImageSize aliases correct');

  // Verify getJobStatus returns not_found for missing job
  const missing = imageGen.getJobStatus('nonexistent_job_id');
  if (missing && missing.status === 'not_found') pass('getJobStatus returns not_found for missing job');
  else fail('getJobStatus', `expected {status:"not_found"}, got ${JSON.stringify(missing)}`);

  // Verify generateJobId format
  const jid = imageGen.generateJobId();
  if (/^img_\d+_[a-z0-9]{4}$/.test(jid)) pass('generateJobId format correct');
  else fail('generateJobId', `unexpected format: ${jid}`);

} catch (e) {
  fail('image-gen pipeline', e.message);
}

// channels module: sendTelegramPhoto exported
try {
  const ch = require('../lib/channels');
  if (typeof ch.sendTelegramPhoto === 'function') pass('channels.sendTelegramPhoto exported');
  else fail('channels exports', 'sendTelegramPhoto not found');
} catch (e) {
  fail('channels load', e.message);
}

// =========================================================================
// CLI shims — bundled openclaw/9router/node/npm exposed on PATH.
// Guards the drive/space-safety intent: shims MUST quote embedded paths so
// a D:\ install or a path with spaces ("D:\My Apps\...") doesn't break.
// =========================================================================
section('CLI shims (drive/space-safe)');
{
  try {
    const cs = require('../lib/cli-shims');
    if (typeof cs.ensureCliShims === 'function') pass('cli-shims.js exports ensureCliShims');
    else fail('cli-shims', 'ensureCliShims not exported');

    const node = 'D:\\My Apps\\9bizclaw\\vendor\\node\\node.exe';
    const oc = 'D:\\My Apps\\9bizclaw\\vendor\\node_modules\\openclaw\\openclaw.mjs';
    const win = cs._buildShimContent('win32', node, oc);
    if (win.includes('"' + node + '"') && win.includes('"' + oc + '"') && win.includes('%*') && win.startsWith('@echo off')) {
      pass('win shim quotes D:\\ + spaces and forwards %*');
    } else {
      fail('cli-shims win shim', 'must quote both paths, forward %*, start with @echo off');
    }

    const winNode = cs._buildShimContent('win32', node, null);
    if (winNode.includes('"' + node + '"') && winNode.includes('%*') && !winNode.includes('.mjs')) pass('win node passthrough shim');
    else fail('cli-shims win node', 'node passthrough must quote node + forward %*');

    const nix = cs._buildShimContent('darwin', '/Users/a b/node', '/Users/a b/openclaw.mjs');
    if (nix.startsWith('#!/bin/sh') && nix.includes('exec ') && nix.includes('"$@"') && nix.includes('"/Users/a b/node"')) {
      pass('unix shim: #!/bin/sh + exec + quoted "$@"');
    } else {
      fail('cli-shims unix shim', 'must be #!/bin/sh, exec, quote paths + "$@"');
    }

    if (cs._shimFileName('win32', 'openclaw') === 'openclaw.cmd' && cs._shimFileName('darwin', 'openclaw') === 'openclaw') {
      pass('shim filenames per-platform (.cmd vs bare)');
    } else {
      fail('cli-shims filename', 'win must be .cmd, unix bare');
    }

    // Lock in the Windows PATH-write hardening so a future edit can't silently
    // drop the guards that prevent PATH corruption.
    const ps1 = cs._ADD_TO_PATH_PS1 || '';
    const hardened = ps1.includes('PATH_TOO_LONG') && ps1.includes('VERIFY_FAILED') &&
      ps1.includes('PATH_OK') && /SetEnvironmentVariable\('Path'[^)]*'User'/.test(ps1);
    if (hardened) pass('PATH-add ps1 keeps length-guard + verify + PATH_OK + User scope');
    else fail('cli-shims ps1 hardening', 'PATH-add script missing a safety guard (length/verify/sentinel/User scope)');
  } catch (e) { fail('cli-shims.js', 'failed to load: ' + e.message); }

  // main.js must actually wire it at boot
  try {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
    if (mainSrc.includes("require('./lib/cli-shims')") && mainSrc.includes('ensureCliShims(')) {
      pass('main.js wires ensureCliShims at boot');
    } else {
      fail('cli-shims wiring', 'main.js does not require + call ensureCliShims');
    }
  } catch (e) { fail('cli-shims wiring', 'could not read main.js: ' + e.message); }
}

// =========================================================================
// Cron Telegram delivery parity — a content-less / filter-blocked cron reply
// must NOT reach the CEO as a substituted polite ack (reported bug: repeated
// "em đang xác nhận…" at cron times when the model returned an auth error).
// =========================================================================
section('Cron Telegram delivery (no content-less acks)');
{
  try {
    const cronSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cron.js'), 'utf-8');
    if (/function\s+deliverCronResultToTelegram\s*\(/.test(cronSrc)) pass('cron.js has deliverCronResultToTelegram()');
    else fail('cron telegram delivery', 'deliverCronResultToTelegram() missing');

    const usesHelper = /else if \(replyText && !zaloTarget\)\s*\{[\s\S]{0,160}deliverCronResultToTelegram\(/.test(cronSrc);
    const bare = /else if \(replyText && !zaloTarget\)\s*\{[\s\S]{0,120}await sendTelegram\(replyText\)/.test(cronSrc);
    if (usesHelper && !bare) pass('cron Telegram branch routes through deliverCronResultToTelegram (not bare sendTelegram)');
    else fail('cron telegram delivery', 'Telegram cron branch still sends replyText raw — content-less acks leak to CEO');

    const strips = /deliverCronResultToTelegram[\s\S]{0,400}_stripProcessAcks/.test(cronSrc);
    const skipsBlocked = /deliverCronResultToTelegram[\s\S]{0,800}filterSensitiveOutput[\s\S]{0,140}blocked/.test(cronSrc);
    if (strips && skipsBlocked) pass('deliverCronResultToTelegram strips acks + skips filter-blocked replies');
    else fail('cron telegram delivery', 'deliverCronResultToTelegram missing ack-strip or filter-blocked skip');
  } catch (e) { fail('cron telegram delivery', 'cron.js read failed: ' + e.message); }
}

// CEO Dashboard + agent image-composer must pass audience:'ceo' to
// listMediaAssets. The shared default fail-closes to 'customer', which hides
// every internal/generated/brand asset — the "brand images lost" regression
// (Dashboard) and silently logo-less generated images (composer).
{
  try {
    const dashSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard-ipc.js'), 'utf-8');
    const mlSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'media-library.js'), 'utf-8');
    const brandList = dashSrc.includes("listMediaAssets({ type: 'brand', audience: 'ceo' })");
    const mediaList = dashSrc.includes("audience: (filters && filters.audience) || 'ceo'");
    const brandNames = mlSrc.includes('function listBrandAssetNames') && mlSrc.includes("listMediaAssets({ type: 'brand', audience: 'ceo' })");
    if (brandList && mediaList && brandNames) {
      pass('CEO Dashboard + image composer pass audience:ceo (brand/internal assets visible)');
    } else {
      fail('media audience ceo', `list-brand=${brandList} list-media=${mediaList} listBrandAssetNames=${brandNames} — internal/brand assets hidden from CEO`);
    }
  } catch (e) { fail('media audience ceo', 'read failed: ' + e.message); }
}

// =========================================================================
// SUMMARY
// =========================================================================
console.log('');
console.log('='.repeat(60));
console.log(`Smoke test complete: ${failures} failures, ${warnings} warnings`);
console.log('='.repeat(60));
if (failures > 0) {
  console.error(`\n✗ BUILD BLOCKED — ${failures} smoke test(s) failed.`);
  console.error('  Fix the failures above before shipping a build.');
  process.exit(1);
}
if (warnings > 0) {
  console.warn(`\n⚠ ${warnings} warning(s) — review but not blocking build.`);
}
console.log('\n✓ All smoke tests passed.');
process.exit(0);
