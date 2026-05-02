'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXPECTED_9ROUTER = '0.4.12';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

const failures = [];
function requireContains(file, needle, label) {
  const src = read(file);
  if (!src.includes(needle)) failures.push(`${file}: missing ${label || needle}`);
}

function requireNotContains(file, needle, label) {
  const src = read(file);
  if (src.includes(needle)) failures.push(`${file}: still contains ${label || needle}`);
}

requireContains('scripts/prebuild-vendor.js', `'9router': '${EXPECTED_9ROUTER}'`, 'expected vendor version');
requireContains('scripts/prebuild-vendor.js', "PINNED_VENDOR_VERSIONS", 'shared vendor version constants');
requireContains('scripts/prebuild-vendor.js', "9router-${PINNED_VENDOR_VERSIONS['9router']}", 'vendor bundle version includes 9router');
requireContains('scripts/prebuild-vendor.js', "`9router@${PINNED_VENDOR_VERSIONS['9router']}`", 'pinned npm install package');
requireContains('scripts/prebuild-vendor.js', "`openzca-${PINNED_VENDOR_VERSIONS.openzca}`", 'vendor bundle version includes openzca');
requireContains('lib/dashboard-ipc.js', `'9router@${EXPECTED_9ROUTER}'`, 'wizard/preflight install package');
requireContains('scripts/smoke-test.js', `'9router': '${EXPECTED_9ROUTER}'`, 'smoke expected version');

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
requireContains('lib/nine-router.js', "version: '0.4.12'", 'RTK marker package version');
requireContains('lib/nine-router.js', "per-request settings", 'latest 9router RTK semantics comment');
requireContains('lib/nine-router.js', "'--host', '127.0.0.1'", 'local-only 9router host binding');
requireContains('lib/nine-router.js', 'ensure9RouterRtkDefaultEnabled,', 'RTK helper export');

if (failures.length) {
  console.error('9Router RTK guard failed:');
  for (const failure of failures) console.error(' - ' + failure);
  process.exit(1);
}

console.log(`9Router RTK guard passed: pinned 9router@${EXPECTED_9ROUTER} with one-time RTK enablement.`);
