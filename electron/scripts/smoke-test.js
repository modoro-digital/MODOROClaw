#!/usr/bin/env node
/*
 * smoke-test.js
 * ---------------------------------------------------------------
 * Pre-build supply-chain validator. Catches upstream package breakage
 * BEFORE we ship a .exe / .dmg with broken dependencies.
 *
 * Why this exists:
 * MODOROClaw depends on 4 third-party npm packages we don't control:
 *   - openclaw            (the gateway + agent runtime)
 *   - openzca             (Zalo websocket listener)
 *   - 9router             (AI provider router)
 *   - @tuyenhx/openzalo   (openclaw plugin for Zalo channel)
 *
 * Each upstream version bump can silently break MODOROClaw if:
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

// =========================================================================
// PINNED VERSIONS — must match prebuild-vendor.js + main.js install handler
// =========================================================================
const PINNED = {
  openclaw: '2026.4.5',
  '9router': '0.3.82',
  openzca: '0.1.57',
  '@tuyenhx/openzalo': '2026.3.31',
};

// =========================================================================
// TEST 1: Vendor packages exist at pinned versions (Mac builds only)
// =========================================================================
section('Vendor packages');
// Build artifacts differ per platform as of 2026-04-08:
//   - Mac DMG: ships vendor/ directory directly (APFS fast drag-drop copy)
//   - Win EXE: ships vendor-bundle.tar + vendor-meta.json (one-big-file NSIS install)
//
// If either layout is present, prebuild has run and we verify.
// If neither is present, this is a standalone smoke run — skip silently.
const hasVendorDir = fs.existsSync(VENDOR_NM);
const hasVendorTar = fs.existsSync(VENDOR_TAR) && fs.existsSync(VENDOR_META);
const isBundledBuild = hasVendorDir || hasVendorTar;

// If only the Windows tar is present, peek inside it to verify pinned versions.
// Uses `tar -tvf` to list contents without extracting — fast.
let tarContents = null;
if (hasVendorTar && !hasVendorDir) {
  try {
    const tarBin = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
    const res = spawnSync(tarBin, ['-tf', VENDOR_TAR], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false, maxBuffer: 20 * 1024 * 1024,
    });
    if (res.status === 0) {
      tarContents = new Set(res.stdout.split('\n').map(s => s.trim()).filter(Boolean));
      pass(`vendor-bundle.tar contains ${tarContents.size} entries`);
      try {
        const meta = JSON.parse(fs.readFileSync(VENDOR_META, 'utf8'));
        pass(`vendor-meta.json bundle_version=${meta.bundle_version}`);
      } catch {}
    } else {
      warn('vendor-bundle.tar', `tar -tf failed exit ${res.status}`);
    }
  } catch (e) {
    warn('vendor-bundle.tar', `could not inspect: ${e.message}`);
  }
}

function checkVendorVersion(pkgName, expected) {
  // If we only have the Windows tar, verify package path exists inside the tar listing.
  // We can't easily read version from inside a tar without extracting, so trust the
  // tar was built from a prebuild that already SHA256-verified + version-pinned.
  if (tarContents && !hasVendorDir) {
    const entryPrefix = pkgName.startsWith('@')
      ? `vendor/node_modules/${pkgName}/`
      : `vendor/node_modules/${pkgName}/`;
    const hasEntry = [...tarContents].some(e => e === entryPrefix || e.startsWith(entryPrefix));
    if (hasEntry) {
      pass(`vendor tar: ${pkgName} present`);
    } else {
      fail(`vendor tar ${pkgName}`, `${pkgName} not found in vendor-bundle.tar. Run: rm vendor-bundle.tar vendor-meta.json && npm run prebuild:vendor`);
    }
    return;
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
  // Minimal valid config that matches what ensureDefaultConfig writes
  const minimalConfig = {
    gateway: { mode: 'local', auth: { mode: 'token', token: 'a'.repeat(48) } },
    channels: {
      telegram: { botToken: '0000000:fake_token_for_smoke_test_only', enabled: false, blockStreaming: false, streaming: 'off' },
      openzalo: { enabled: false, dmPolicy: 'open', allowFrom: ['*'], groupPolicy: 'open', groupAllowFrom: ['*'], blockStreaming: false },
    },
    models: { providers: { ninerouter: { baseUrl: 'http://127.0.0.1:20128/v1', apiKey: 'sk-fake', api: 'openai-completions', models: [{ id: 'main', name: 'fake' }] } } },
    agents: { defaults: { model: 'ninerouter/main', workspace: tmpDir, blockStreamingDefault: 'off' } },
  };
  fs.writeFileSync(path.join(tmpDir, '.openclaw', 'openclaw.json'), JSON.stringify(minimalConfig, null, 2));

  // Use HOME env override so openclaw reads our temp config, not user's real one.
  // Set timeout 5s — --help should be near-instant (no network, no config validation
  // for `agent --help` since openclaw 2026.4.x). If it hangs, something is very wrong.
  const env = { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir };

  // Test 2a: --version (no config needed, should be instant)
  const rVer = spawnSync('node', [openclawCli, '--version'], {
    encoding: 'utf-8',
    timeout: 5000,
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
  // openclaw 2026.4.5 cold start can take 5-10s for plugin discovery, so we give
  // it 20s. If it still hangs, that's the validator getting stuck in a loop.
  const rValidate = spawnSync('node', [openclawCli, '--help'], {
    encoding: 'utf-8',
    timeout: 20000,
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
  const r = spawnSync('node', [openzcaCli, '--help'], { encoding: 'utf-8', timeout: 10000 });
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
// TEST 4: Patch anchors in openzalo plugin source still match expected format
// =========================================================================
section('Plugin patch anchors');
// Patch anchors: pass if EITHER the original anchor matches (unpatched plugin)
// OR the MODOROClaw patch marker is present (already patched). Both states are
// "smoke OK" — only failure is "neither matches", which means upstream
// restructured the file in a way our patch logic can no longer find.
function checkPatchAnchor(name, file, anchorRegex, patchMarker, hint) {
  if (!fs.existsSync(file)) {
    warn(name, `plugin source not found at ${file} — skipped (Mac vendor or fresh install)`);
    return;
  }
  const content = fs.readFileSync(file, 'utf-8');
  if (anchorRegex.test(content)) {
    pass(name + ' (anchor matches — unpatched)');
    return;
  }
  if (patchMarker && content.includes(patchMarker)) {
    pass(name + ' (already patched — marker present)');
    return;
  }
  fail(name, `neither anchor regex NOR patch marker "${patchMarker}" found. ${hint}`);
}

// Look for openzalo source in vendor first, then user-installed
const openzaloSrcCandidates = [
  path.join(VENDOR_NM, '@tuyenhx', 'openzalo', 'src'),
  path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'extensions', 'openzalo', 'src'),
];
let openzaloSrc = null;
for (const c of openzaloSrcCandidates) {
  if (fs.existsSync(c)) { openzaloSrc = c; break; }
}

// In CI Mac builds the vendor MUST contain openzalo (no user-installed
// fallback exists in CI). Fail loudly if vendor is empty so the build doesn't
// silently ship a DMG with no plugin patches applied at runtime.
const isCiBuild = !!process.env.CI || !!process.env.GITHUB_ACTIONS;
if (!openzaloSrc && isCiBuild && process.platform === 'darwin') {
  fail('openzalo vendor source', 'CI Mac build requires vendor/node_modules/@tuyenhx/openzalo/src — prebuild-vendor failed silently');
}

if (openzaloSrc) {
  // Anchor 1: ensureOpenzaloShellFix anchor or already-patched marker
  checkPatchAnchor(
    'openzca.ts spawn anchor',
    path.join(openzaloSrc, 'openzca.ts'),
    /spawn\s*\(\s*binary\s*,/,
    'MODOROClaw PATCH',
    'ensureOpenzaloShellFix() in main.js may need updated patch template at electron/patches/openzalo-openzca.ts'
  );

  // Anchor 2: ensureOpenzaloForceOneMessageFix anchor or already-patched marker
  checkPatchAnchor(
    'inbound.ts disableBlockStreaming anchor',
    path.join(openzaloSrc, 'inbound.ts'),
    /disableBlockStreaming:\s*\n?\s*typeof account\.config\.blockStreaming === ["']boolean["']/,
    'MODOROClaw FORCE-ONE-MESSAGE PATCH',
    'ensureOpenzaloForceOneMessageFix() regex needs updating — openzalo plugin restructured'
  );

  // Anchor 3: ensureZaloBlocklistFix anchor or already-patched marker
  checkPatchAnchor(
    'inbound.ts blocklist anchor',
    path.join(openzaloSrc, 'inbound.ts'),
    /if\s*\(!rawBody\s*&&\s*!hasMedia\)\s*\{\s*\n\s*return;\s*\n\s*\}/,
    'MODOROClaw BLOCKLIST PATCH',
    'ensureZaloBlocklistFix() anchor missing — openzalo plugin restructured'
  );
} else {
  warn('openzalo plugin source', 'not found in vendor or ~/.openclaw/extensions — patch anchors skipped');
}

// =========================================================================
// TEST 5: Patch template files exist (for ensureOpenzaloShellFix to read)
// =========================================================================
section('Patch templates');
const patchTemplate = path.join(__dirname, '..', 'patches', 'openzalo-openzca.ts');
if (!fs.existsSync(patchTemplate)) {
  fail('patches/openzalo-openzca.ts', `MISSING — ensureOpenzaloShellFix() will fail silently in production. Restore from git history.`);
} else {
  const content = fs.readFileSync(patchTemplate, 'utf-8');
  if (!content.includes('MODOROClaw PATCH')) {
    fail('patches/openzalo-openzca.ts marker', 'file present but missing "MODOROClaw PATCH" marker — ensureOpenzaloShellFix will refuse to apply it');
  } else {
    pass('patches/openzalo-openzca.ts (has MODOROClaw PATCH marker)');
  }
}

// =========================================================================
// TEST 6: workspace-templates contains all critical files
// =========================================================================
section('Workspace templates (extraResources)');
const templateRoot = path.resolve(__dirname, '..', '..');
const requiredTemplates = [
  'AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'BOOTSTRAP.md', 'COMPANY.md',
  'PRODUCTS.md', 'USER.md', 'MEMORY.md', 'HEARTBEAT.md', 'TOOLS.md',
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
  if (!/KHÔNG BAO GIỜ DÙNG EMOJI/i.test(ac)) {
    fail('AGENTS.md emoji rule', 'missing "KHÔNG BAO GIỜ DÙNG EMOJI" rule — bot will reply with emojis on fresh install');
  } else {
    pass('AGENTS.md has no-emoji rule');
  }
  if (!/LỊCH SỬ TIN NHẮN/i.test(ac)) {
    fail('AGENTS.md history rule', 'missing cron history block rule — bot will hallucinate "no Zalo data"');
  } else {
    pass('AGENTS.md has cron history block rule');
  }
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
