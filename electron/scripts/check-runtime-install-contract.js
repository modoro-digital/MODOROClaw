#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const runtimePath = path.join(ROOT, 'lib', 'runtime-installer.js');
const bootPath = path.join(ROOT, 'lib', 'boot.js');
const mainPath = path.join(ROOT, 'main.js');
const nineRouterPath = path.join(ROOT, 'lib', 'nine-router.js');
const versionsJsonPath = path.join(ROOT, 'scripts', 'versions.json');

const runtime = require(runtimePath);
const runtimeSrc = fs.readFileSync(runtimePath, 'utf8');
const migrationSrc = fs.readFileSync(path.join(ROOT, 'lib', 'migration.js'), 'utf8');
const mainSrc = fs.readFileSync(mainPath, 'utf8');
const nineRouterSrc = fs.readFileSync(nineRouterPath, 'utf8');

let failures = 0;

function pass(name) {
  console.log('PASS', name);
}

function fail(name, detail) {
  failures++;
  console.error('FAIL', name + ':', detail);
}

function requireContains(name, src, needle) {
  if (src.includes(needle)) pass(name);
  else fail(name, 'missing ' + JSON.stringify(needle));
}

function requireNotContains(name, src, needle) {
  if (!src.includes(needle)) pass(name);
  else fail(name, 'must not contain ' + JSON.stringify(needle));
}

// Read canonical versions from the shared JSON file
let pinnedVersions;
try {
  pinnedVersions = JSON.parse(fs.readFileSync(versionsJsonPath, 'utf8'));
} catch (e) {
  fail('versions.json readable', e.message);
  pinnedVersions = { openclaw: '2026.4.14', openzca: '0.1.57', nineRouter: '0.4.63' };
}

const nodeBin = runtime.getRuntimeNodeBinPath();
const normalized = nodeBin.replace(/\\/g, '/');
if (process.platform === 'win32') {
  if (/\/vendor\/node\/node\.exe$/i.test(normalized)) pass('runtime Node path uses vendor/node/node.exe');
  else fail('runtime Node path uses vendor/node/node.exe', nodeBin);
} else {
  if (/\/vendor\/node\/bin\/node$/.test(normalized)) pass('runtime Node path uses vendor/node/bin/node');
  else fail('runtime Node path uses vendor/node/bin/node', normalized);
}

// Check that runtime installer's PINNED_VERSIONS loads from SHARED_VERSIONS
const pinnedMatch = runtimeSrc.match(/PINNED_VERSIONS\s*=\s*\{([\s\S]+?)\n\};/);
if (pinnedMatch) {
  const pinnedBlock = pinnedMatch[1];
  const expectedVersions = {
    openclaw: pinnedVersions.openclaw,
    openzca: pinnedVersions.openzca,
    nineRouter: pinnedVersions.nineRouter,
  };
  for (const [pkg, ver] of Object.entries(expectedVersions)) {
    const keyPat = pkg === 'nineRouter' ? 'nineRouter' : pkg;
    // Check: PINNED_VERSIONS field reads from SHARED_VERSIONS
    const sharedPat = keyPat + '\\s*:\\s*SHARED_VERSIONS\\.' + keyPat;
    const re = new RegExp(sharedPat);
    if (re.test(pinnedBlock)) {
      pass('PINNED_VERSIONS ' + pkg + ' loads from SHARED_VERSIONS.' + keyPat);
    } else {
      // Fallback: direct string literal (should match JSON)
      const directPat = keyPat + '\\s*:\\s*[\'"]' + ver.replace(/\./g, '\\.') + '[\'"]';
      if (new RegExp(directPat).test(pinnedBlock)) {
        pass('PINNED_VERSIONS ' + pkg + ' === \'' + ver + '\'');
      } else {
        fail('PINNED_VERSIONS ' + pkg, 'expected SHARED_VERSIONS.' + keyPat + ' or \'' + ver + '\', pattern not found');
      }
    }
  }
} else {
  fail('PINNED_VERSIONS object found in runtime-installer', 'not found');
}

// SHA256 verification helper present in runtime-installer
requireContains('runtime installer verifies node.exe SHA256 after extraction', runtimeSrc, 'verifySha256');
// Layout version migration for future-proofing
requireContains('runtime installer uses layout version for migration safety', runtimeSrc, 'LAYOUT_VERSION');
// Actionable download error messages for proxy/DNS/timeout
requireContains('runtime installer surfaces actionable download errors', runtimeSrc, 'PROXY');
requireContains('runtime installer uses installation-recovery withRetry', runtimeSrc, 'installation-recovery');
// npm install handles corporate proxy TLS errors
requireContains('runtime installer handles corporate proxy npm errors', runtimeSrc, 'CERT_HAS_EXPIRED');

requireContains('runtime installer exposes npm binary resolver', runtimeSrc, 'function getRuntimeNpmCommand');
requireContains('npm install prefixes vendor root', runtimeSrc, 'getRuntimeNodeDir()');
requireContains('runtime installer re-checks state after npm install can prune copied plugins', runtimeSrc, 'const postPackageStatus = await checkInstallation();');
requireContains('runtime installer bases modoro-zalo copy on post-install state', runtimeSrc, 'postPackageStatus.needsModoroZaloInstall');
if (/execFilePromise\(\s*nodeBin\s*,\s*\[\s*['"]npm['"]/.test(runtimeSrc)) {
  fail('npm install does not execute `node npm`', 'found execFilePromise(nodeBin, ["npm", ...])');
} else {
  pass('npm install does not execute `node npm`');
}
requireContains('downloadFile surfaces download errors with an actionable hint', runtimeSrc, 'throw attachHint(');
requireContains('downloadFile falls back to OS-proxy/keychain-aware methods (net.fetch + system tool)', runtimeSrc, 'downloadViaSystemTool');
requireContains('runtime readiness considers version marker', runtimeSrc, 'runtimeVersion');
requireContains('runtime install writes marker after fast ready path', runtimeSrc, 'writeInstalledVersion(RUNTIME_INSTALL_VERSION)');
requireContains('runtime install marker value is 2.4.0', runtimeSrc, "RUNTIME_INSTALL_VERSION = '2.4.0'");
requireContains('main verifies runtime install result before boot continues', mainSrc, 'Runtime install incomplete');
// CLEANUP_PATHS must not include bare "vendor" (no slash) which would delete the
// runtime vendor directory at userData/vendor/. A directory form "vendor/" (with /)
// is intentional for v2.3.x migration cleanup.
const cleanupBlock = migrationSrc.match(/CLEANUP_PATHS\s*=\s*\[([\s\S]*?)\];/);
if (cleanupBlock) {
  const block = cleanupBlock[1];
  const hasBareVendor = /['"]vendor['"]/.test(block) && !/['"]vendor\/['"]/.test(block);
  const hasVendorDir = /['"]vendor\/['"]/.test(block);
  if (hasBareVendor) {
    fail('CLEANUP_PATHS must not include bare "vendor" (would delete runtime vendor/)', block);
  } else {
    pass('CLEANUP_PATHS: bare "vendor" absent, vendor/ (v2.3.x cleanup) present=' + hasVendorDir);
  }
} else {
  fail('CLEANUP_PATHS block found', 'not found');
}
requireContains('9router starts in background tray mode', nineRouterSrc, "'--tray'");
requireContains('9router internal API uses CLI auth header', nineRouterSrc, "'x-9r-cli-token'");
requireContains('9router CLI auth token matches upstream salt', nineRouterSrc, "'9r-cli-auth'");
if (/no auth needed/i.test(nineRouterSrc)) {
  fail('9router comments do not claim unauthenticated /api access', 'found stale no-auth comment');
} else {
  pass('9router comments do not claim unauthenticated /api access');
}

if (failures) {
  console.error('\nRuntime install contract failed: ' + failures + ' issue(s)');
  process.exit(1);
}

console.log('\nRuntime install contract OK');
