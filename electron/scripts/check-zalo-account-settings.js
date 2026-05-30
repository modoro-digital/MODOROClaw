'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  syncActiveZaloAccountSettings,
  saveActiveZaloAccountSettings,
  recordGroupOwnerSelfIds,
} = require('../lib/zalo-account-settings');
const { parseZaloUserMemoryMeta } = require('../lib/zalo-memory');
const ctx = require('../lib/context');
const { getOpenclawAgentWorkspace } = require('../lib/workspace');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function legacyState(workspace) {
  return {
    allowlist: readJson(path.join(workspace, 'zalo-allowlist.json')),
    stranger: readJson(path.join(workspace, 'zalo-stranger-policy.json')).mode,
    groups: readJson(path.join(workspace, 'zalo-group-settings.json')),
    users: readJson(path.join(workspace, 'zalo-user-settings.json')),
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zalo-account-settings-'));

try {
  writeJson(path.join(tmp, 'zalo-allowlist.json'), ['friend-a']);
  writeJson(path.join(tmp, 'zalo-blocklist.json'), ['blocked-a']);
  writeJson(path.join(tmp, 'zalo-stranger-policy.json'), { mode: 'reply' });
  writeJson(path.join(tmp, 'zalo-user-settings.json'), { 'friend-a': { internal: true } });
  writeJson(path.join(tmp, 'zalo-group-settings.json'), { __default: { mode: 'off' }, 'group-a': { mode: 'all', internal: true } });
  fs.mkdirSync(path.join(tmp, 'memory', 'zalo-groups'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'memory', 'zalo-groups', 'group-a.md'), [
    '---',
    'groupId: group-a',
    'name: Group A',
    '---',
    '# Group A',
    '',
    '## Chủ đề thường thảo luận',
    '(chưa có)',
  ].join('\n'), 'utf8');

  syncActiveZaloAccountSettings({
    workspace: tmp,
    selfId: 'account-a',
    displayName: 'Account A',
    profile: 'default',
    friendIds: ['friend-a', 'shared-peer'],
    groupIds: ['group-a'],
  });

  let current = legacyState(tmp);
  assert.deepEqual(current.allowlist, ['friend-a']);
  assert.equal(current.stranger, 'reply');
  assert.equal(current.groups['group-a'].mode, 'all');
  assert.equal(current.users['friend-a'].internal, true);

  writeJson(path.join(tmp, 'zalo-allowlist.json'), ['friend-a', 'shared-peer']);
  writeJson(path.join(tmp, 'zalo-stranger-policy.json'), { mode: 'greet-only' });
  saveActiveZaloAccountSettings({ workspace: tmp });

  syncActiveZaloAccountSettings({
    workspace: tmp,
    selfId: 'account-b',
    displayName: 'Account B',
    profile: 'default',
    friendIds: ['shared-peer', 'friend-b'],
    groupIds: ['group-b'],
  });

  current = legacyState(tmp);
  assert.deepEqual(current.allowlist, ['__NONE__']);
  assert.deepEqual(readJson(path.join(tmp, 'zalo-blocklist.json')), []);
  assert.equal(current.stranger, 'ignore');
  assert.equal(current.groups['group-b'].mode, 'off');
  assert.equal(current.groups['group-a'], undefined);

  writeJson(path.join(tmp, 'zalo-allowlist.json'), ['friend-b']);
  writeJson(path.join(tmp, 'zalo-stranger-policy.json'), { mode: 'reply' });
  saveActiveZaloAccountSettings({ workspace: tmp });

  syncActiveZaloAccountSettings({
    workspace: tmp,
    selfId: 'account-a',
    displayName: 'Account A',
    profile: 'default',
    friendIds: ['friend-a', 'shared-peer'],
    groupIds: ['group-a'],
  });

  current = legacyState(tmp);
  assert.deepEqual(current.allowlist, ['friend-a', 'shared-peer']);
  assert.equal(current.stranger, 'greet-only');
  assert.equal(current.groups['group-a'].mode, 'all');
  assert.equal(current.users['friend-a'].internal, true);

  syncActiveZaloAccountSettings({
    workspace: tmp,
    selfId: 'account-b',
    displayName: 'Account B',
    profile: 'default',
    friendIds: ['shared-peer', 'friend-b'],
    groupIds: ['group-b'],
  });

  current = legacyState(tmp);
  assert.deepEqual(current.allowlist, ['friend-b']);
  assert.equal(current.stranger, 'reply');

  const mismatch = path.join(tmp, 'mismatch');
  fs.mkdirSync(mismatch, { recursive: true });
  writeJson(path.join(mismatch, 'zalo-allowlist.json'), ['old-friend']);
  writeJson(path.join(mismatch, 'zalo-blocklist.json'), ['old-blocked']);
  writeJson(path.join(mismatch, 'zalo-stranger-policy.json'), { mode: 'reply' });
  writeJson(path.join(mismatch, 'zalo-user-settings.json'), { 'old-friend': { internal: true } });
  writeJson(path.join(mismatch, 'zalo-group-settings.json'), { __default: { mode: 'off' }, 'old-group': { mode: 'all' } });
  writeJson(path.join(mismatch, 'zalo-initial-blocklist-seeded.json'), {
    fingerprint: ['old-friend', 'old-peer'].sort().join(','),
    friendCount: 2,
    groupCount: 1,
  });
  syncActiveZaloAccountSettings({
    workspace: mismatch,
    selfId: 'new-account',
    displayName: 'New Account',
    profile: 'default',
    friendIds: ['new-friend'],
    groupIds: ['new-group'],
  });
  // v2.4.10 fix: removed fingerprint-mismatch wipe.
  // When no active-account file exists and legacy state has meaningful settings,
  // we now ADOPT the legacy state for the new selfId instead of wiping it. Friend
  // list churn (add/remove a top-10 friend) used to silently clobber CEO's choices
  // because fingerprint changed; that data loss is gone now. CEO's explicit settings
  // are preserved across QR rescans and friend churn — adopted under the new selfId.
  const mismatchCurrent = legacyState(mismatch);
  assert.deepEqual(mismatchCurrent.allowlist, ['old-friend'], 'legacy allowlist must be preserved (no fingerprint wipe)');
  assert.deepEqual(readJson(path.join(mismatch, 'zalo-blocklist.json')), ['old-blocked']);
  assert.equal(mismatchCurrent.stranger, 'reply');
  assert.equal(mismatchCurrent.groups['old-group'].mode, 'all', 'legacy group settings must be preserved');
  assert.equal(
    fs.existsSync(path.join(mismatch, 'zalo-legacy-unassigned-settings.json')),
    false,
    'no archive file should be created when fingerprint differs',
  );

  const fresh = path.join(tmp, 'fresh');
  fs.mkdirSync(fresh, { recursive: true });
  syncActiveZaloAccountSettings({
    workspace: fresh,
    selfId: 'fresh-account',
    displayName: 'Fresh Account',
    profile: 'default',
    friendIds: ['fresh-friend'],
    groupIds: ['fresh-group'],
  });
  const freshCurrent = legacyState(fresh);
  assert.deepEqual(freshCurrent.allowlist, ['__NONE__']);
  assert.deepEqual(readJson(path.join(fresh, 'zalo-blocklist.json')), []);
  assert.equal(freshCurrent.stranger, 'ignore');
  assert.equal(freshCurrent.groups['fresh-group'].mode, 'off');

  const freshStub = path.join(tmp, 'fresh-stub');
  fs.mkdirSync(freshStub, { recursive: true });
  writeJson(path.join(freshStub, 'zalo-allowlist.json'), []);
  writeJson(path.join(freshStub, 'zalo-blocklist.json'), []);
  writeJson(path.join(freshStub, 'zalo-group-settings.json'), { __default: { mode: 'off' } });
  syncActiveZaloAccountSettings({
    workspace: freshStub,
    selfId: 'fresh-stub-account',
    displayName: 'Fresh Stub Account',
    profile: 'default',
    friendIds: ['fresh-stub-friend'],
    groupIds: ['fresh-stub-group'],
  });
  const freshStubCurrent = legacyState(freshStub);
  assert.deepEqual(freshStubCurrent.allowlist, ['__NONE__']);
  assert.deepEqual(readJson(path.join(freshStub, 'zalo-blocklist.json')), []);
  assert.equal(freshStubCurrent.groups['fresh-stub-group'].mode, 'off');

  // === v2.4.11: new friend auto-ON after refresh ===
  const refreshDir = path.join(tmp, 'refresh-test');
  fs.mkdirSync(refreshDir, { recursive: true });
  // First sync — establish active account with 1 friend
  syncActiveZaloAccountSettings({
    workspace: refreshDir,
    selfId: 'refresh-acct',
    displayName: 'Refresh Test',
    profile: 'default',
    friendIds: ['existing-friend'],
    groupIds: [],
  });
  // Second sync — same account, CEO added a new friend on Zalo, hits refresh
  syncActiveZaloAccountSettings({
    workspace: refreshDir,
    selfId: 'refresh-acct',
    displayName: 'Refresh Test',
    profile: 'default',
    friendIds: ['existing-friend', 'new-friend'],
    groupIds: [],
  });
  let refreshState = legacyState(refreshDir);
  assert(refreshState.allowlist.includes('new-friend'), 'new friend must be auto-ON after refresh');

  // Toggle-off persistence: CEO turned off new-friend, refresh must NOT re-enable
  writeJson(path.join(refreshDir, 'zalo-allowlist.json'), ['existing-friend']);
  saveActiveZaloAccountSettings({ workspace: refreshDir });
  syncActiveZaloAccountSettings({
    workspace: refreshDir,
    selfId: 'refresh-acct',
    displayName: 'Refresh Test',
    profile: 'default',
    friendIds: ['existing-friend', 'new-friend'],
    groupIds: [],
  });
  refreshState = legacyState(refreshDir);
  assert(refreshState.allowlist.includes('existing-friend'), 'existing friend stays ON');
  assert(!refreshState.allowlist.includes('new-friend'), 'CEO toggled-off friend must stay OFF');

  // __NONE__ (deny-all) + new friend → only new friend gets added
  const denyDir = path.join(tmp, 'deny-test');
  fs.mkdirSync(denyDir, { recursive: true });
  syncActiveZaloAccountSettings({
    workspace: denyDir,
    selfId: 'deny-acct',
    displayName: 'Deny Test',
    profile: 'default',
    friendIds: ['old-friend'],
    groupIds: [],
  });
  writeJson(path.join(denyDir, 'zalo-allowlist.json'), ['__NONE__']);
  saveActiveZaloAccountSettings({ workspace: denyDir });
  syncActiveZaloAccountSettings({
    workspace: denyDir,
    selfId: 'deny-acct',
    displayName: 'Deny Test',
    profile: 'default',
    friendIds: ['old-friend', 'brand-new'],
    groupIds: [],
  });
  const denyState = legacyState(denyDir);
  assert(denyState.allowlist.includes('brand-new'), 'new friend ON even after deny-all');
  assert(!denyState.allowlist.includes('old-friend'), 'old friend stays OFF per deny-all');
  assert(!denyState.allowlist.includes('__NONE__'), '__NONE__ sentinel removed');

  assert.equal(recordGroupOwnerSelfIds({ workspace: tmp, selfId: 'account-a', groupIds: ['group-a'] }), 1);
  assert.equal(recordGroupOwnerSelfIds({ workspace: tmp, selfId: 'account-b', groupIds: ['group-a'] }), 1);
  assert.equal(recordGroupOwnerSelfIds({ workspace: tmp, selfId: 'account-b', groupIds: ['group-a'] }), 0);
  fs.writeFileSync(path.join(tmp, 'memory', 'zalo-groups', 'bad.md'), '---\ngroupId: bad\n---\n# Bad\n', 'utf8');
  assert.equal(recordGroupOwnerSelfIds({ workspace: tmp, selfId: 'account-a', groupIds: ['../bad'] }), 0);
  const groupMemory = fs.readFileSync(path.join(tmp, 'memory', 'zalo-groups', 'group-a.md'), 'utf8');
  assert(groupMemory.includes('ownerSelfIds: ["account-a","account-b"]'));
  const badGroupMemory = fs.readFileSync(path.join(tmp, 'memory', 'zalo-groups', 'bad.md'), 'utf8');
  assert(!badGroupMemory.includes('ownerSelfIds'));

  const datedOnly = [
    '---',
    'name: Test User',
    'lastSeen: 2026-05-27T00:00:00.000Z',
    'msgCount: 8',
    'gender: unknown',
    '---',
    '# Test User',
    '',
    '## 2026-05-25',
    '- Cũ hơn, không nên hiển thị.',
    '',
    '## 2026-05-27',
    '- Khách hỏi giá Premium và cần follow-up sáng mai.',
    '- Bot đã tư vấn theo chính sách hiện tại.',
  ].join('\n');
  assert.equal(parseZaloUserMemoryMeta(datedOnly).summary, 'Khách hỏi giá Premium và cần follow-up sáng mai.');

  const outOfOrderDated = [
    '---',
    'name: Out Of Order User',
    '---',
    '# Out Of Order User',
    '',
    '## 2026-05-27',
    '- Latest by date should win.',
    '',
    '## 2026-05-20',
    '- Older line appears later in the file.',
  ].join('\n');
  assert.equal(parseZaloUserMemoryMeta(outOfOrderDated).summary, 'Latest by date should win.');

  const dashboardHtml = fs.readFileSync(path.join(__dirname, '..', 'ui', 'dashboard.html'), 'utf8');
  assert(dashboardHtml.includes('title="Xem hồ sơ nhóm"'));
  assert(dashboardHtml.includes('refreshGroupMemoryNow'));
  assert(dashboardHtml.includes('{ force: true }'));
  assert(dashboardHtml.includes('function _effectiveUserAllowlist()'));
  assert(dashboardHtml.includes("zaloMgrConfig.userAllowlist = arr.length > 0 ? arr : ['__NONE__'];"));
  assert(dashboardHtml.includes("viewGroupMemory('${escAttr(escJs(g.groupId))}', '${escAttr(escJs(g.name))}')"));
  assert(dashboardHtml.includes("refreshGroupMemoryNow('${escAttr(escJs(groupId))}', '${escAttr(escJs(groupName))}')"));
  assert(!dashboardHtml.includes('summary?.hasContent ? `<button class="zc-summary-btn"'));
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert(preload.includes('seedGroupHistoryNow'));
  const ipc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard-ipc.js'), 'utf8');
  assert(ipc.includes("seedGroupHistorySummary(groupId, threadName || groupId, opts || {})"));
  assert(!/JSON\.parse\(fs\.readFileSync\((configPath|cfgPath|ocPath)/.test(ipc));
  const zaloPlugin = fs.readFileSync(path.join(__dirname, '..', 'lib', 'zalo-plugin.js'), 'utf8');
  const linkFnStart = zaloPlugin.indexOf('function ensureModoroZaloNodeModulesLink()');
  const seedFnStart = zaloPlugin.indexOf('function seedZaloCustomersFromCache()');
  const linkFn = zaloPlugin.slice(linkFnStart, seedFnStart);
  assert(linkFnStart >= 0 && seedFnStart > linkFnStart);
  assert(!linkFn.includes('selfInfo'));
  assert(zaloPlugin.includes('const usersDir = getZaloUsersDir()'));
  assert(zaloPlugin.includes('const groupsDir = getZaloGroupsDir()'));
  assert(zaloPlugin.includes('function sanitizeZaloGroupIdForFile'));
  assert(zaloPlugin.includes('resolveZaloGroupMemoryPath(groupsDir, groupId)'));
  assert(zaloPlugin.includes('resolveZaloGroupMemoryPath(dir, safeGroupId)'));
  assert(zaloPlugin.includes('ownerSelfIds: ${JSON.stringify([ownerSelfId])}'));
  assert(zaloPlugin.includes('recordGroupOwnerSelfIds({ workspace, groupsDir, selfId: selfInfo.selfId'));
  assert(zaloPlugin.includes('metadata-create-failed'));
  assert(zaloPlugin.includes('Dashboard'));
  const inboundTs = fs.readFileSync(path.join(__dirname, '..', 'packages', 'modoro-zalo', 'src', 'inbound.ts'), 'utf8');
  assert(inboundTs.includes('function isZaloFriendshipSystemText'));
  assert(inboundTs.includes('ban vua ket ban voi'));
  assert(inboundTs.includes('drop DM friendship system event'));
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert(packageJson.scripts['guard:zalo-account-settings']);
  assert(packageJson.scripts['guard:architecture'].includes('guard:zalo-account-settings'));

  const oldHome = ctx.HOME;
  try {
    const fakeHome = path.join(tmp, 'home');
    const fakeWorkspace = path.join(tmp, 'agent-workspace');
    fs.mkdirSync(path.join(fakeHome, '.openclaw'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.openclaw', 'openclaw.json'), '\u00EF\u00BB\u00BF' + JSON.stringify({
      agents: { defaults: { workspace: fakeWorkspace } },
    }, null, 2), 'utf8');
    ctx.HOME = fakeHome;
    assert.equal(getOpenclawAgentWorkspace(), path.resolve(fakeWorkspace));
  } finally {
    ctx.HOME = oldHome;
  }

  console.log('zalo account settings guard ok');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
