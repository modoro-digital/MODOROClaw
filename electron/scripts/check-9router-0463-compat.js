#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const failures = [];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function fail(label, detail) {
  failures.push(label + (detail ? ': ' + detail : ''));
}

function requireContains(rel, needle, label) {
  const src = read(rel);
  if (!src.includes(needle)) fail(label || rel, 'missing ' + JSON.stringify(needle));
}

const versions = JSON.parse(read('scripts/versions.json'));
if (versions.nineRouter !== '0.4.63') {
  fail('versions.json pins 9router@0.4.63', 'found ' + versions.nineRouter);
}

requireContains('lib/nine-router.js', 'function get9RouterDataDir', '9Router data dir matches upstream DATA_DIR layout');
requireContains('lib/nine-router.js', 'auth', '9Router v0.4.63 CLI secret directory support');
requireContains('lib/nine-router.js', 'cli-secret', '9Router v0.4.63 CLI secret file support');
requireContains('lib/nine-router.js', 'machine-id', '9Router persisted machine-id support');
requireContains('lib/nine-router.js', 'get9RouterCliTokenCandidates', '9Router auth retries new and legacy CLI tokens');
requireContains('lib/nine-router.js', 'getLegacy9RouterCliToken', '9Router keeps v0.4.12 token fallback during rollout');
requireContains('lib/image-gen.js', 'x-9r-cli-token', 'image generation provider lookup authenticates /api/providers');
requireContains('lib/backup.js', 'data.sqlite', 'backup includes 9Router SQLite DB');
requireContains('lib/backup.js', 'cli-secret', 'backup preserves 9Router CLI auth secret');
requireContains('lib/backup.js', 'machine-id', 'backup preserves 9Router machine id');

try {
  const nineRouter = require(path.join(ROOT, 'lib', 'nine-router.js'));
  const testApi = nineRouter._test || {};
  if (typeof testApi.compute9RouterCliToken !== 'function') {
    fail('compute9RouterCliToken exported for contract test');
  } else {
    const actual = testApi.compute9RouterCliToken('raw-machine', 'secret-value');
    const expected = crypto.createHash('sha256')
      .update('raw-machine' + '9r-cli-auth' + 'secret-value')
      .digest('hex')
      .substring(0, 16);
    if (actual !== expected) fail('v0.4.63 CLI token formula', 'expected ' + expected + ', got ' + actual);
  }

  if (typeof testApi.computeLegacy9RouterCliToken !== 'function') {
    fail('computeLegacy9RouterCliToken exported for rollout fallback');
  } else {
    const actual = testApi.computeLegacy9RouterCliToken('raw-machine');
    const expected = crypto.createHash('sha256')
      .update('raw-machine' + '9r-cli-auth')
      .digest('hex')
      .substring(0, 16);
    if (actual !== expected) fail('legacy v0.4.12 CLI token formula', 'expected ' + expected + ', got ' + actual);
  }
} catch (e) {
  fail('nine-router module can be loaded for compat contract', e.message);
}

if (failures.length) {
  console.error('9Router v0.4.63 compatibility guard failed:');
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}

console.log('9Router v0.4.63 compatibility guard passed.');
