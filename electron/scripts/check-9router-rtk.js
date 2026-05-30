'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const versionsJsonPath = path.join(ROOT, 'scripts', 'versions.json');

let pinnedVersions;
try {
  pinnedVersions = JSON.parse(fs.readFileSync(versionsJsonPath, 'utf8'));
} catch (e) {
  pinnedVersions = { nineRouter: '0.4.63' };
}
const EXPECTED_9ROUTER = pinnedVersions.nineRouter;

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

const failures = [];
function requireContains(file, needle, label) {
  const src = read(file);
  if (!src.includes(needle)) failures.push(file + ': missing ' + (label || needle));
}

function requireNotContains(file, needle, label) {
  const src = read(file);
  if (src.includes(needle)) failures.push(file + ': still contains ' + (label || needle));
}

requireContains('scripts/prebuild-vendor.js', "SHARED_VERSIONS.nineRouter", 'shared versions loading');
requireContains('scripts/prebuild-vendor.js', "PINNED_VENDOR_VERSIONS", 'shared vendor version constants');
requireContains('scripts/prebuild-vendor.js', "'9router': SHARED_VERSIONS.nineRouter", 'pinned 9router from shared');
requireContains('lib/dashboard-ipc.js', "SHARED_VERSIONS", 'dashboard-ipc loads shared versions');
requireContains('scripts/smoke-test.js', "SHARED_VERSIONS", 'smoke-test loads shared versions');

requireNotContains('scripts/prebuild-vendor.js', '9router@0.3.82', 'old 9router install pin');
requireNotContains('lib/dashboard-ipc.js', '9router@0.3.82', 'old dashboard install pin');
requireNotContains('scripts/smoke-test.js', "'9router': '0.3.82'", 'old smoke pin');
requireNotContains('scripts/prebuild-vendor.js', '9router@0.3.98', 'previous RTK trial install pin');
requireNotContains('lib/dashboard-ipc.js', '9router@0.3.98', 'previous RTK trial dashboard pin');
requireNotContains('scripts/smoke-test.js', "'9router': '0.3.98'", 'previous RTK trial smoke pin');

requireContains('lib/nine-router.js', 'ensure9RouterRtkDefaultEnabled', 'RTK default enablement helper');
requireContains('lib/nine-router.js', 'rtkEnabled', 'RTK settings write');
requireContains('lib/nine-router.js', '/api/settings', 'RTK settings route');
requireContains('lib/nine-router.js', 'modoroclaw-rtk-default-applied.json', 'one-time RTK default marker');
requireContains('lib/nine-router.js', "version: '" + EXPECTED_9ROUTER + "'", 'RTK marker package version (' + EXPECTED_9ROUTER + ')');
requireContains('lib/nine-router.js', "per-request settings", 'latest 9router RTK semantics comment');
requireContains('lib/nine-router.js', "'--host', '127.0.0.1'", 'local-only 9router host binding');
requireContains('lib/nine-router.js', 'ensure9RouterRtkDefaultEnabled,', 'RTK helper export');

if (failures.length) {
  console.error('9Router RTK guard failed:');
  for (const failure of failures) console.error(' - ' + failure);
  process.exit(1);
}

console.log('9Router RTK guard passed: pinned 9router@' + EXPECTED_9ROUTER + ' via shared versions.json with one-time RTK enablement.');
