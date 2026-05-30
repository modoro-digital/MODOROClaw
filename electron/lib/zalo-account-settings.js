'use strict';

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./util');
const ctx = require('./context');

// Defensive backstop: fs.watch is unreliable on Windows for atomic-rename writes,
// so writers in this module explicitly notify the Dashboard renderer when state
// changes. The renderer listens on 'zalo-manager-config-changed' and reloads
// loadZaloManagerData() to re-sync the cached zaloMgrConfig. Safe to call before
// mainWindow exists — the function short-circuits.
function notifyZaloConfigChanged() {
  try {
    const win = ctx.mainWindow;
    if (!win || win.isDestroyed?.()) return;
    win.webContents.send('zalo-manager-config-changed', { changedAt: new Date().toISOString(), source: 'zalo-account-settings' });
  } catch {}
}

const ACTIVE_ACCOUNT_FILE = 'zalo-active-account.json';
const ACCOUNT_SETTINGS_DIR = 'zalo-account-settings';
const LEGACY_UNASSIGNED_FILE = 'zalo-legacy-unassigned-settings.json';
const LEGACY_FILES = {
  allowlist: 'zalo-allowlist.json',
  blocklist: 'zalo-blocklist.json',
  userSettings: 'zalo-user-settings.json',
  groupSettings: 'zalo-group-settings.json',
  strangerPolicy: 'zalo-stranger-policy.json',
};

function normalizeId(value) {
  return String(value || '').trim().replace(/[^0-9A-Za-z_-]/g, '').slice(0, 64);
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(v => String(v || '').trim()).filter(Boolean))];
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function accountFingerprint(ids) {
  return normalizeList(ids).sort().slice(0, 10).join(',');
}

function getAccountSettingsDir(workspace) {
  return path.join(workspace, ACCOUNT_SETTINGS_DIR);
}

function getActiveAccountPath(workspace) {
  return path.join(workspace, ACTIVE_ACCOUNT_FILE);
}

function getAccountSnapshotPath(workspace, selfId) {
  const id = normalizeId(selfId);
  if (!id) return null;
  return path.join(getAccountSettingsDir(workspace), `${id}.json`);
}

function readActiveZaloAccount(workspace) {
  const active = readJson(getActiveAccountPath(workspace), null);
  if (!active || typeof active !== 'object') return null;
  const selfId = normalizeId(active.selfId);
  if (!selfId) return null;
  return { ...active, selfId };
}

function readZaloAccountSnapshot(workspace, selfId) {
  const snapshotPath = getAccountSnapshotPath(workspace, selfId);
  if (!snapshotPath) return null;
  const snapshot = readJson(snapshotPath, null);
  if (!snapshot || typeof snapshot !== 'object') return null;
  const normalizedSelfId = normalizeId(snapshot.selfId || selfId);
  if (!normalizedSelfId) return null;
  return normalizeSnapshot({ ...snapshot, selfId: normalizedSelfId });
}

function readLegacyZaloState(workspace) {
  const allowlist = readJson(path.join(workspace, LEGACY_FILES.allowlist), []);
  const blocklist = readJson(path.join(workspace, LEGACY_FILES.blocklist), []);
  const userSettings = readJson(path.join(workspace, LEGACY_FILES.userSettings), {});
  const groupSettings = readJson(path.join(workspace, LEGACY_FILES.groupSettings), {});
  const strangerRaw = readJson(path.join(workspace, LEGACY_FILES.strangerPolicy), {});
  const strangerPolicy = String(strangerRaw?.mode || strangerRaw?.policy || 'ignore').trim() || 'ignore';
  return {
    userAllowlist: normalizeList(allowlist),
    userBlocklist: normalizeList(blocklist),
    userSettings: normalizeObject(userSettings),
    groupSettings: normalizeObject(groupSettings),
    strangerPolicy,
  };
}

function hasLegacyFile(workspace, key) {
  return fs.existsSync(path.join(workspace, LEGACY_FILES[key]));
}

function legacyStateHasMeaningfulSettings(workspace) {
  const legacy = readLegacyZaloState(workspace);
  if (legacy.userAllowlist.length > 0) return true;
  if (legacy.userBlocklist.length > 0) return true;
  if (Object.keys(legacy.userSettings).length > 0) return true;
  if (Object.keys(legacy.groupSettings).some(key => key !== '__default')) return true;
  if (hasLegacyFile(workspace, 'strangerPolicy') && legacy.strangerPolicy !== 'ignore') return true;
  return false;
}

function readLegacySeedMetadata(workspace) {
  const seed = readJson(path.join(workspace, 'zalo-initial-blocklist-seeded.json'), null);
  if (!seed || typeof seed !== 'object') return null;
  const fingerprint = String(seed.fingerprint || '').trim();
  if (!fingerprint) return null;
  return {
    fingerprint,
    friendCount: Number.isFinite(Number(seed.friendCount)) ? Number(seed.friendCount) : null,
    groupCount: Number.isFinite(Number(seed.groupCount)) ? Number(seed.groupCount) : null,
    seededAt: seed.seededAt || null,
  };
}

function legacyStateLooksLikeDifferentAccount(workspace, accountMeta) {
  const seed = readLegacySeedMetadata(workspace);
  if (!seed?.fingerprint) return false;
  const currentFingerprint = accountFingerprint(accountMeta.friendIds);
  return !!currentFingerprint && currentFingerprint !== seed.fingerprint;
}

function archiveUnassignedLegacyState(workspace, accountMeta) {
  const payload = {
    archivedAt: new Date().toISOString(),
    reason: 'first-run-account-fingerprint-mismatch',
    seed: readLegacySeedMetadata(workspace),
    detectedAccount: {
      selfId: normalizeId(accountMeta.selfId),
      displayName: String(accountMeta.displayName || '').trim(),
      profile: String(accountMeta.profile || 'default').trim() || 'default',
      friendFingerprint: accountFingerprint(accountMeta.friendIds),
      friendCount: normalizeList(accountMeta.friendIds).length,
      groupCount: normalizeList(accountMeta.groupIds).length,
    },
    state: readLegacyZaloState(workspace),
  };
  writeJsonAtomic(path.join(workspace, LEGACY_UNASSIGNED_FILE), payload);
  return payload;
}

function normalizeGroupSettings(groupSettings, groupIds = []) {
  const out = normalizeObject(groupSettings);
  if (!out.__default) out.__default = { mode: 'off' };
  for (const groupId of normalizeList(groupIds)) {
    if (!out[groupId]) out[groupId] = { mode: 'off' };
  }
  return out;
}

function defaultStateForAccount({ friendIds = [], groupIds = [] } = {}) {
  return {
    userAllowlist: ['__NONE__'],
    userBlocklist: [],
    userSettings: {},
    groupSettings: normalizeGroupSettings({}, groupIds),
    strangerPolicy: 'ignore',
  };
}

function normalizeSnapshot(snapshot) {
  const normalized = {
    selfId: normalizeId(snapshot.selfId),
    displayName: String(snapshot.displayName || '').trim(),
    profile: String(snapshot.profile || 'default').trim() || 'default',
    createdAt: snapshot.createdAt || new Date().toISOString(),
    lastSeenAt: snapshot.lastSeenAt || new Date().toISOString(),
    strangerPolicy: String(snapshot.strangerPolicy || 'ignore').trim() || 'ignore',
    userAllowlist: normalizeList(snapshot.userAllowlist),
    userBlocklist: normalizeList(snapshot.userBlocklist),
    userSettings: normalizeObject(snapshot.userSettings),
    groupSettings: normalizeGroupSettings(snapshot.groupSettings),
    cache: normalizeObject(snapshot.cache),
  };
  return normalized;
}

function mergeNewFriends(snapshot, friendIds) {
  const currentFriendIds = normalizeList(friendIds);
  if (currentFriendIds.length === 0) return snapshot;

  if (!Array.isArray(snapshot.cache?.knownFriendIds)) {
    return { ...snapshot, cache: { ...snapshot.cache, knownFriendIds: currentFriendIds } };
  }

  const knownSet = new Set(snapshot.cache.knownFriendIds);
  const newFriends = currentFriendIds.filter(id => !knownSet.has(id));
  const updatedCache = { ...snapshot.cache, knownFriendIds: currentFriendIds };

  if (newFriends.length === 0) {
    return { ...snapshot, cache: updatedCache };
  }

  const allowlist = normalizeList(snapshot.userAllowlist);
  const isDenyAll = allowlist.length === 1 && allowlist[0] === '__NONE__';
  const updatedAllowlist = isDenyAll
    ? newFriends
    : [...new Set([...allowlist, ...newFriends])];

  return { ...snapshot, userAllowlist: updatedAllowlist, cache: updatedCache };
}

function buildSnapshotFromLegacy(workspace, accountMeta = {}, previous = null) {
  const now = new Date().toISOString();
  const legacy = readLegacyZaloState(workspace);
  const hasFriendIds = Array.isArray(accountMeta.friendIds);
  const hasGroupIds = Array.isArray(accountMeta.groupIds);
  const friendIds = normalizeList(accountMeta.friendIds);
  const groupIds = normalizeList(accountMeta.groupIds);
  return normalizeSnapshot({
    ...(previous || {}),
    ...legacy,
    selfId: accountMeta.selfId || previous?.selfId,
    displayName: accountMeta.displayName || previous?.displayName || '',
    profile: accountMeta.profile || previous?.profile || 'default',
    createdAt: previous?.createdAt || now,
    lastSeenAt: now,
    groupSettings: normalizeGroupSettings(legacy.groupSettings, groupIds),
    cache: {
      ...(previous?.cache || {}),
      ...(hasFriendIds ? { friendCount: friendIds.length } : {}),
      ...(hasGroupIds ? { groupCount: groupIds.length } : {}),
      updatedAt: now,
    },
  });
}

function buildDefaultSnapshot(accountMeta = {}) {
  const now = new Date().toISOString();
  const state = defaultStateForAccount(accountMeta);
  return normalizeSnapshot({
    ...state,
    selfId: accountMeta.selfId,
    displayName: accountMeta.displayName || '',
    profile: accountMeta.profile || 'default',
    createdAt: now,
    lastSeenAt: now,
    cache: {
      friendCount: normalizeList(accountMeta.friendIds).length,
      groupCount: normalizeList(accountMeta.groupIds).length,
      updatedAt: now,
    },
  });
}

function writeZaloAccountSnapshot(workspace, snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  if (!normalized.selfId) return null;
  const snapshotPath = getAccountSnapshotPath(workspace, normalized.selfId);
  writeJsonAtomic(snapshotPath, normalized);
  return normalized;
}

function writeActiveZaloAccount(workspace, snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  writeJsonAtomic(getActiveAccountPath(workspace), {
    selfId: normalized.selfId,
    displayName: normalized.displayName,
    profile: normalized.profile,
    updatedAt: new Date().toISOString(),
  });
}

function writeLegacyZaloState(workspace, snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  writeJsonAtomic(path.join(workspace, LEGACY_FILES.allowlist), normalized.userAllowlist);
  writeJsonAtomic(path.join(workspace, LEGACY_FILES.blocklist), normalized.userBlocklist);
  writeJsonAtomic(path.join(workspace, LEGACY_FILES.userSettings), normalized.userSettings);
  writeJsonAtomic(path.join(workspace, LEGACY_FILES.groupSettings), normalized.groupSettings);
  writeJsonAtomic(path.join(workspace, LEGACY_FILES.strangerPolicy), { mode: normalized.strangerPolicy });
  notifyZaloConfigChanged();
}

function saveActiveZaloAccountSettings({ workspace, selfId, displayName, profile, friendIds, groupIds } = {}) {
  if (!workspace) return null;
  const active = selfId ? { selfId } : readActiveZaloAccount(workspace);
  const normalizedSelfId = normalizeId(active?.selfId);
  if (!normalizedSelfId) return null;
  const previous = readZaloAccountSnapshot(workspace, normalizedSelfId);
  const snapshot = buildSnapshotFromLegacy(workspace, {
    selfId: normalizedSelfId,
    displayName: displayName || previous?.displayName || active?.displayName || '',
    profile: profile || previous?.profile || active?.profile || 'default',
    friendIds,
    groupIds,
  }, previous);
  writeZaloAccountSnapshot(workspace, snapshot);
  writeActiveZaloAccount(workspace, snapshot);
  return snapshot;
}

function syncActiveZaloAccountSettings({ workspace, selfId, displayName, profile, friendIds, groupIds } = {}) {
  if (!workspace) return null;
  const normalizedSelfId = normalizeId(selfId);
  if (!normalizedSelfId) return null;

  const accountMeta = {
    selfId: normalizedSelfId,
    displayName: displayName || '',
    profile: profile || 'default',
    friendIds: normalizeList(friendIds),
    groupIds: normalizeList(groupIds),
  };
  const active = readActiveZaloAccount(workspace);

  if (active?.selfId && active.selfId !== normalizedSelfId) {
    saveActiveZaloAccountSettings({ workspace, selfId: active.selfId });
  }

  const existing = readZaloAccountSnapshot(workspace, normalizedSelfId);
  let snapshot;
  if (active?.selfId === normalizedSelfId) {
    snapshot = buildSnapshotFromLegacy(workspace, accountMeta, existing);
  } else if (existing) {
    snapshot = normalizeSnapshot({
      ...existing,
      displayName: accountMeta.displayName || existing.displayName,
      profile: accountMeta.profile || existing.profile,
      lastSeenAt: new Date().toISOString(),
      cache: {
        ...(existing.cache || {}),
        friendCount: accountMeta.friendIds.length,
        groupCount: accountMeta.groupIds.length,
        updatedAt: new Date().toISOString(),
      },
    });
  } else if (!active?.selfId) {
    if (!legacyStateHasMeaningfulSettings(workspace)) {
      snapshot = buildDefaultSnapshot(accountMeta);
    } else {
      snapshot = buildSnapshotFromLegacy(workspace, accountMeta, null);
    }
  } else {
    snapshot = buildDefaultSnapshot(accountMeta);
  }

  snapshot = mergeNewFriends(snapshot, accountMeta.friendIds);
  writeLegacyZaloState(workspace, snapshot);
  snapshot = writeZaloAccountSnapshot(workspace, snapshot);
  writeActiveZaloAccount(workspace, snapshot);
  return snapshot;
}

function parseOwnerSelfIds(value) {
  if (!value) return [];
  const raw = String(value).trim();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return normalizeList(parsed);
  } catch {}
  return normalizeList(raw.split(','));
}

function recordGroupOwnerSelfIds({ workspace, groupsDir, selfId, groupIds = [] } = {}) {
  const normalizedSelfId = normalizeId(selfId);
  if (!normalizedSelfId) return 0;
  const targetGroupsDir = groupsDir || (workspace ? path.join(workspace, 'memory', 'zalo-groups') : '');
  if (!targetGroupsDir || !fs.existsSync(targetGroupsDir)) return 0;
  let updatedCount = 0;
  for (const groupId of normalizeList(groupIds)) {
    const safeGroupId = normalizeId(groupId);
    if (!safeGroupId || safeGroupId !== String(groupId).trim()) continue;
    const filePath = path.join(targetGroupsDir, `${safeGroupId}.md`);
    if (!fs.existsSync(filePath)) continue;
    try {
      let content = fs.readFileSync(filePath, 'utf-8');
      const fm = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fm) continue;
      const frontmatter = fm[1];
      const existingLine = frontmatter.match(/^ownerSelfIds:\s*(.+)$/m);
      const ids = new Set(existingLine ? parseOwnerSelfIds(existingLine[1]) : []);
      const before = ids.size;
      ids.add(normalizedSelfId);
      if (ids.size === before) continue;
      const nextLine = `ownerSelfIds: ${JSON.stringify([...ids].sort())}`;
      const nextFrontmatter = existingLine
        ? frontmatter.replace(/^ownerSelfIds:\s*.+$/m, nextLine)
        : `${frontmatter}\n${nextLine}`;
      content = content.replace(/^---\n[\s\S]*?\n---/, `---\n${nextFrontmatter}\n---`);
      fs.writeFileSync(filePath, content, 'utf-8');
      updatedCount++;
    } catch {}
  }
  return updatedCount;
}

module.exports = {
  readLegacyZaloState,
  readActiveZaloAccount,
  readZaloAccountSnapshot,
  writeZaloAccountSnapshot,
  writeLegacyZaloState,
  saveActiveZaloAccountSettings,
  syncActiveZaloAccountSettings,
  recordGroupOwnerSelfIds,
  defaultStateForAccount,
};
