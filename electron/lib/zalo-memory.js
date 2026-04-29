'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFilePromise = promisify(execFile);
const ctx = require('./context');
const { getWorkspace, getOpenclawAgentWorkspace } = require('./workspace');
const { findNodeBin, findGlobalPackageFile } = require('./boot');
const { normalizeZaloBlocklist } = require('./zalo-settings');

// ============================================
//  ZALO MANAGER — Group whitelist + User blacklist
// ============================================

function getZcaProfile() {
  // Try to read active profile name, fallback to 'default'
  try {
    const pj = path.join(ctx.HOME, '.openzca', 'profiles.json');
    if (fs.existsSync(pj)) {
      const data = JSON.parse(fs.readFileSync(pj, 'utf-8'));
      return data?.active || 'default';
    }
  } catch {}
  return 'default';
}

function getZcaCacheDir() {
  return path.join(ctx.HOME, '.openzca', 'profiles', getZcaProfile(), 'cache');
}

function getZcaCacheDirForProfile(profile) {
  return path.join(ctx.HOME, '.openzca', 'profiles', profile || getZcaProfile(), 'cache');
}

function readZaloChannelState() {
  const state = {
    enabled: false,
    groupPolicy: 'open',
    groupAllowFrom: ['*'],
    userBlocklist: [],
    profile: getZcaProfile(),
    configError: null,
    blocklistError: null,
  };
  try {
    const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const oz = cfg?.channels?.['modoro-zalo'] || cfg?.channels?.openzalo || {};
      state.enabled = oz.enabled !== false;
      state.groupPolicy = oz.groupPolicy || 'open';
      state.groupAllowFrom = Array.isArray(oz.groupAllowFrom)
        ? oz.groupAllowFrom.map(String)
        : (state.groupPolicy === 'allowlist' ? [] : ['*']);
    }
  } catch (e) {
    state.configError = e?.message || String(e);
  }
  try {
    const bp = getZaloBlocklistPath();
    if (fs.existsSync(bp)) {
      const raw = JSON.parse(fs.readFileSync(bp, 'utf-8'));
      state.userBlocklist = normalizeZaloBlocklist(raw);
    }
  } catch (e) {
    state.blocklistError = e?.message || String(e);
  }
  return state;
}

function isZaloTargetAllowed(targetId, { isGroup = false } = {}) {
  const state = readZaloChannelState();
  if (state.configError || state.blocklistError) {
    return { allowed: false, reason: 'policy-error', state };
  }
  if (state.enabled === false) {
    return { allowed: false, reason: 'disabled', state };
  }
  const id = String(targetId || '').trim();
  if (!id) return { allowed: false, reason: 'missing-target', state };
  if (isGroup) {
    const allowAll = state.groupPolicy !== 'allowlist' || state.groupAllowFrom.includes('*');
    if (!allowAll && !state.groupAllowFrom.includes(id)) {
      return { allowed: false, reason: 'group-not-allowed', state };
    }
  } else if (state.userBlocklist.includes(id)) {
    return { allowed: false, reason: 'user-blocked', state };
  }
  return { allowed: true, state };
}

function isKnownZaloTarget(targetId, { isGroup = false, profile } = {}) {
  try {
    const cacheDir = getZcaCacheDirForProfile(profile);
    const filename = isGroup ? 'groups.json' : 'friends.json';
    const file = path.join(cacheDir, filename);
    if (!fs.existsSync(file)) return { known: false, reason: 'cache-missing' };
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (isGroup) {
      const arr = Array.isArray(data) ? data : (Array.isArray(data?.groups) ? data.groups : []);
      const known = arr.some(g => String(g.groupId || g.id || '') === String(targetId));
      return { known, reason: known ? null : 'group-not-in-cache' };
    }
    const arr = Array.isArray(data) ? data : (Array.isArray(data?.friends) ? data.friends : []);
    const known = arr.some(f => String(f.userId || f.uid || f.id || f.userKey || '') === String(targetId));
    return { known, reason: known ? null : 'user-not-in-cache' };
  } catch (e) {
    return { known: false, reason: 'cache-error', error: e?.message || String(e) };
  }
}

// PERF: cache friends list for 60s — avoids re-reading ~3767 entries from disk
// on every 120s auto-refresh. Invalidated on save-zalo-manager-config and login.
let _zaloFriendsCache = null;
let _zaloFriendsCacheAt = 0;
const ZALO_FRIENDS_CACHE_TTL_MS = 60 * 1000;
function invalidateZaloFriendsCache() { _zaloFriendsCache = null; _zaloFriendsCacheAt = 0; }
/** @returns {{ cache: any, cacheAt: number, ttl: number }} */
function getZaloFriendsCached() { return { cache: _zaloFriendsCache, cacheAt: _zaloFriendsCacheAt, ttl: ZALO_FRIENDS_CACHE_TTL_MS }; }
function setZaloFriendsCached(data) { _zaloFriendsCache = data; _zaloFriendsCacheAt = Date.now(); }

// Refresh openzca cache directly (shared helper).
// Searches ALL node-manager lib dirs for openzca/dist/cli.js (handles mixed
// nvm/system Node setups), then spawns via absolute node path so PATH issues
// can't break this on Mac Finder launches.
let _zaloCacheRefreshInFlight = null;
let _zaloCacheRefreshLastStartedAt = 0;
let _zaloCacheRefreshCooldownUntil = 0;
const ZALO_CACHE_REFRESH_MIN_GAP_MS = 30 * 1000;
const ZALO_CACHE_REFRESH_429_COOLDOWN_MS = 2 * 60 * 1000;

async function runZaloCacheRefresh({ source = 'manual', force = false } = {}) {
  const now = Date.now();
  if (_zaloCacheRefreshInFlight) {
    console.log(`[zalo-cache] refresh join existing in-flight run (source=${source})`);
    return _zaloCacheRefreshInFlight;
  }
  if (!force && _zaloCacheRefreshCooldownUntil > now) {
    const retryAfterSec = Math.max(1, Math.ceil((_zaloCacheRefreshCooldownUntil - now) / 1000));
    console.warn(`[zalo-cache] refresh skipped during cooldown (${retryAfterSec}s left, source=${source})`);
    return {
      ok: false,
      skipped: true,
      rateLimited: true,
      retryAfterSec,
      error: `Zalo đang giới hạn đồng bộ cache. Đợi ${retryAfterSec} giây rồi thử lại.`,
    };
  }
  if (!force && _zaloCacheRefreshLastStartedAt && (now - _zaloCacheRefreshLastStartedAt) < ZALO_CACHE_REFRESH_MIN_GAP_MS) {
    const retryAfterSec = Math.max(1, Math.ceil((ZALO_CACHE_REFRESH_MIN_GAP_MS - (now - _zaloCacheRefreshLastStartedAt)) / 1000));
    console.log(`[zalo-cache] refresh skipped (too soon, source=${source}, retryAfter=${retryAfterSec}s)`);
    return {
      ok: false,
      skipped: true,
      retryAfterSec,
      error: `Vừa đồng bộ cache Zalo xong. Đợi ${retryAfterSec} giây rồi thử lại.`,
    };
  }

  _zaloCacheRefreshInFlight = (async () => {
    _zaloCacheRefreshLastStartedAt = Date.now();
    try {
      const zcaScript = findGlobalPackageFile('openzca', 'dist/cli.js');
      let cmd, args, opts = { timeout: 15000, windowsHide: true };
      if (zcaScript) {
        cmd = findNodeBin() || 'node';
        args = [zcaScript, 'auth', 'cache-refresh'];
      } else {
        // PATH fallback. On Windows we need .cmd + shell:true; on Mac/Linux just
        // openzca with PATH already augmented at boot.
        const isWin = process.platform === 'win32';
        cmd = isWin ? 'openzca.cmd' : 'openzca';
        args = ['auth', 'cache-refresh'];
        opts.shell = isWin;
      }
      await execFilePromise(cmd, args, opts);
      _zaloCacheRefreshCooldownUntil = 0;
      console.log(`[zalo-cache] refresh ok (source=${source})`);
      invalidateZaloFriendsCache(); // PERF: bust friends cache after successful refresh
      return { ok: true };
    } catch (e) {
      const msg = e?.message || String(e);
      if (/status code 429|(?:^|\\b)429(?:\\b|$)|rate limit/i.test(msg)) {
        _zaloCacheRefreshCooldownUntil = Date.now() + ZALO_CACHE_REFRESH_429_COOLDOWN_MS;
        const retryAfterSec = Math.ceil(ZALO_CACHE_REFRESH_429_COOLDOWN_MS / 1000);
        console.warn(`[zalo-cache] refresh rate-limited (source=${source}, cooldown=${retryAfterSec}s): ${msg}`);
        return {
          ok: false,
          rateLimited: true,
          retryAfterSec,
          error: `Zalo đang rate limit đồng bộ cache. Đợi ${retryAfterSec} giây rồi thử lại.`,
        };
      }
      console.error(`[zalo-cache] refresh failed (source=${source}):`, msg);
      return { ok: false, error: msg };
    } finally {
      _zaloCacheRefreshInFlight = null;
    }
  })();

  return _zaloCacheRefreshInFlight;
}

// Periodic auto-refresh (every 10 min) so new groups/friends show up without manual action
let _zaloCacheInterval = null;
function startZaloCacheAutoRefresh() {
  if (_zaloCacheInterval) clearInterval(_zaloCacheInterval);
  _zaloCacheInterval = setInterval(() => {
    runZaloCacheRefresh({ source: 'auto-interval' }).then(res => {
      if (res?.ok && ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('zalo-cache-refreshed');
      }
    });
  }, 10 * 60 * 1000); // 10 minutes
}

// === Zalo per-user memory ===
// Bot writes one .md file per Zalo customer at memory/zalo-users/<senderId>.md
// containing a structured profile (tone, decisions, likes/dislikes, CEO notes).
// Dashboard reads them so CEO can click any friend → see full memory.
//
// CRITICAL: bot's working dir is set in ~/.openclaw/openclaw.json field
// `agents.defaults.workspace` (typically %APPDATA%/modoro-claw on Windows).
// MODOROClaw's getWorkspace() returns a DIFFERENT path (Desktop/claw in dev,
// %APPDATA%/MODOROClaw packaged) → mismatch caused Dashboard to read empty
// while bot wrote to the right place. Always read this from openclaw.json
// so Electron + bot agree on a single source of truth.

function getZaloUsersDir() {
  // Single source of truth: openclaw.json -> agents.defaults.workspace.
  // Falls back to MODOROClaw workspace only if openclaw.json missing (very
  // early boot before wizard). Bot reads/writes here using relative path.
  const agentWs = getOpenclawAgentWorkspace();
  if (agentWs) return path.join(agentWs, 'memory', 'zalo-users');
  const ws = getWorkspace();
  if (!ws) return null;
  return path.join(ws, 'memory', 'zalo-users');
}

function ensureZaloUsersDir() {
  const dir = getZaloUsersDir();
  if (!dir) return null;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function sanitizeZaloUserId(id) {
  // Zalo IDs are numeric strings. Allow only digits + dashes (some are negative-prefixed).
  return String(id || '').trim().replace(/[^0-9-]/g, '').slice(0, 32);
}

function parseZaloUserMemoryMeta(content) {
  // Parse front-matter-style header. Format expected:
  //   ---
  //   name: ...
  //   lastSeen: 2026-04-09T10:30:00Z
  //   msgCount: 12
  //   gender: male|female|unknown
  //   ---
  const meta = { name: '', lastSeen: '', msgCount: 0, gender: '', summary: '' };
  if (!content) return meta;
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^(\w+):\s*(.+)$/);
      if (!m) continue;
      const k = m[1].trim();
      const v = m[2].trim();
      if (k === 'name') meta.name = v;
      else if (k === 'lastSeen') meta.lastSeen = v;
      else if (k === 'msgCount') meta.msgCount = parseInt(v, 10) || 0;
      else if (k === 'gender') meta.gender = v;
    }
  }
  // Extract summary: first line after "## Tóm tắt" header
  const sumMatch = content.match(/## Tóm tắt\s*\n+([^\n#]+)/);
  if (sumMatch) meta.summary = sumMatch[1].trim().slice(0, 140);
  return meta;
}

// === Zalo group memory ===
function getZaloGroupsDir() {
  const agentWs = getOpenclawAgentWorkspace();
  if (agentWs) return path.join(agentWs, 'memory', 'zalo-groups');
  const ws = getWorkspace();
  if (!ws) return null;
  return path.join(ws, 'memory', 'zalo-groups');
}

// === Security Layer 1 (scoped) — File permission hardening ===
function getZaloBlocklistPath() { return path.join(getWorkspace(), 'zalo-blocklist.json'); }

function cleanBlocklist() {
  // NO-OP: previously this wiped zalo-blocklist.json to [] every boot,
  // destroying the CEO's friend block settings. The blocklist IS the
  // user's explicit per-friend deny list managed via Dashboard. Preserve it.
}

function cleanupZaloMemoryTimers() {
  if (_zaloCacheInterval) { clearInterval(_zaloCacheInterval); _zaloCacheInterval = null; }
}

module.exports = {
  getZcaProfile, getZcaCacheDir, getZcaCacheDirForProfile,
  readZaloChannelState, isZaloTargetAllowed, isKnownZaloTarget,
  invalidateZaloFriendsCache, getZaloFriendsCached, setZaloFriendsCached,
  runZaloCacheRefresh, startZaloCacheAutoRefresh,
  getZaloUsersDir, ensureZaloUsersDir, sanitizeZaloUserId, parseZaloUserMemoryMeta,
  getZaloGroupsDir, getZaloBlocklistPath, cleanBlocklist,
  cleanupZaloMemoryTimers,
};
