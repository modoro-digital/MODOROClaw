#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const fbPublisher = require(path.join(__dirname, '..', 'lib', 'fb-publisher'));

const failures = [];

function assert(name, condition, detail) {
  if (!condition) failures.push(`${name}: ${detail || 'assertion failed'}`);
}

const t = fbPublisher._test || {};
assert('exports hasPageCreateContentTask', typeof t.hasPageCreateContentTask === 'function', 'missing helper');
assert('accepts classic Page create task', t.hasPageCreateContentTask?.(['CREATE_CONTENT']) === true);
assert('accepts profile-plus Page create task', t.hasPageCreateContentTask?.(['PROFILE_PLUS_CREATE_CONTENT']) === true);
assert('rejects read-only Page tasks', t.hasPageCreateContentTask?.(['MESSAGING', 'ANALYZE']) === false);

const dashboard = fs.readFileSync(path.join(__dirname, '..', 'ui', 'dashboard.html'), 'utf8');
assert(
  'dashboard recommends working ClawHub app use case',
  dashboard.includes('Tương tác với khách hàng trên Messenger'),
  'missing Messenger use-case guidance'
);
assert(
  'dashboard requests Page token with tasks',
  dashboard.includes('me/accounts?fields=id,name,tasks,access_token'),
  'missing me/accounts fields query'
);

if (failures.length) {
  console.error('[facebook-publisher] FAIL');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}

console.log('[facebook-publisher] PASS Page token task validation and setup guidance');
