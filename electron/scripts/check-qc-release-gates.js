#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const repoRoot = path.join(root, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const failures = [];

function check(label, fn) {
  try {
    fn();
  } catch (e) {
    failures.push(`${label}: ${e.message}`);
  }
}

function readRepoFile(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

function mustInclude(text, needle, message) {
  assert.ok(text.includes(needle), message || `missing ${needle}`);
}

check('senior QC checklist exists and covers P0/P1/P2', () => {
  const checklist = readRepoFile('docs/qc/senior-qc-checklist.md');
  for (const needle of [
    '# Senior QC Checklist',
    '## P0',
    '## P1',
    '## P2',
    'Dry-run never sends',
    'Payment exclusion',
    'opaque tokens',
    'formula',
    'hyperlink',
    'Packaged app',
  ]) {
    mustInclude(checklist, needle);
  }
});

check('Zalo Menu smoke plan exists and covers critical flows', () => {
  const plan = readRepoFile('docs/qc/zalo-menu-smoke-test-plan.md');
  for (const needle of [
    '# Zalo Menu Smoke Test Plan',
    'Dry-run never sends',
    'XLSX import',
    '1280px',
    'Restart persistence',
    'No SePay',
    'formula',
    'hyperlink',
    'file replacement',
  ]) {
    mustInclude(plan, needle);
  }
});

check('package exposes QC guard scripts', () => {
  assert.equal(pkg.scripts['guard:zalo-menu-dry-run'], 'node scripts/check-zalo-menu-dry-run.js');
  assert.equal(pkg.scripts['guard:qc-release'], 'node scripts/check-qc-release-gates.js');
});

check('architecture guard chain includes QC gates', () => {
  const chain = String(pkg.scripts['guard:architecture'] || '');
  mustInclude(chain, 'guard:zalo-menu-dry-run');
  mustInclude(chain, 'guard:qc-release');
});

check('smoke chain reaches architecture guard', () => {
  mustInclude(String(pkg.scripts.smoke || ''), 'npm run guard:architecture');
});

if (failures.length) {
  console.error('[qc-release-gates] FAIL');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}

console.log('[qc-release-gates] PASS senior QC checklist, smoke plan, and guard wiring');
