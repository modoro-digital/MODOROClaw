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
const cronApi = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cron-api.js'), 'utf8');
const agents = fs.readFileSync(path.join(__dirname, '..', '..', 'AGENTS.md'), 'utf8');
assert(
  'dashboard guides adding permissions in App Dashboard',
  dashboard.includes('Quản lý mọi thứ trên Trang') && dashboard.includes('Business Asset User Profile Access'),
  'missing App Dashboard permission setup guidance'
);
assert(
  'dashboard guides Page token via Graph API Explorer',
  dashboard.includes('Lấy mã truy cập Trang') && dashboard.includes('Generate Access Token'),
  'missing Graph API Explorer page token guidance'
);
assert(
  'cron api requires approval nonce for Facebook post',
  cronApi.includes('approvalNonce') && cronApi.includes('preview=1'),
  'posting endpoint must require a CEO-approved preview nonce'
);
assert(
  'bot instructions include Facebook approval flow',
  (agents.includes('preview Telegram') || agents.includes('approvalNonce')) &&
    (agents.includes('/api/fb/post') || agents.includes('send-photo')),
  'AGENTS.md must tell the bot to preview before posting'
);

if (failures.length) {
  console.error('[facebook-publisher] FAIL');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}

console.log('[facebook-publisher] PASS Page token task validation and setup guidance');
