#!/usr/bin/env node
/**
 * zalo-manage.js — CLI tool for managing Zalo group/user settings from Telegram
 *
 * Usage (called by bot via `exec` tool):
 *   node tools/zalo-manage.js group <groupId> <mention|all|off>
 *   node tools/zalo-manage.js user <userId> <on|off>
 *   node tools/zalo-manage.js list-groups
 *   node tools/zalo-manage.js list-users
 *   node tools/zalo-manage.js status
 *
 * Reads: openclaw.json (status only), groups.json, friends.json (openzca cache)
 * Writes: zalo-group-settings.json, zalo-blocklist.json (workspace files only — NOT openclaw.json)
 * Exit 0 = success, 1 = error
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// --- Resolve workspace (same logic as main.js getWorkspace) ---
function getWorkspace() {
  const home = os.homedir();
  const appDir = '9bizclaw';
  // Gateway sets 9BIZ_WORKSPACE — check this FIRST (most reliable in bot context)
  if (process.env['9BIZ_WORKSPACE'] && fs.existsSync(process.env['9BIZ_WORKSPACE'])) {
    return process.env['9BIZ_WORKSPACE'];
  }
  if (process.env.MODORO_WORKSPACE && fs.existsSync(process.env.MODORO_WORKSPACE)) {
    return process.env.MODORO_WORKSPACE;
  }
  const candidates = [
    path.join(home, 'AppData', 'Roaming', appDir),
    path.join(home, 'Library', 'Application Support', appDir),
    path.join(home, '.config', appDir),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function getZcaCacheDir() {
  return path.join(os.homedir(), '.openzca', 'profiles', 'default', 'cache');
}

function readJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {}
  return fallback;
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// --- Commands ---
const ws = getWorkspace();
if (!ws) { console.error('Workspace not found'); process.exit(1); }

const groupSettingsPath = path.join(ws, 'zalo-group-settings.json');
const blocklistPath = path.join(ws, 'zalo-blocklist.json');
// NOTE: Do NOT write to openclaw.json here. This script runs as a child
// process (separate Node) — writing openclaw.json changes inode → gateway
// config watcher treats it as external write → triggers channel reload →
// can abort in-flight replies with "Gateway is restarting". The workspace
// files (zalo-group-settings.json, zalo-blocklist.json) are read by
// inbound.ts patches directly and don't trigger gateway reload.
// openclaw.json groupAllowFrom sync happens via Dashboard "Lưu cấu hình"
// which uses the byte-equal write helper (safe).
// We DO read openclaw.json for status display (read-only, never write).
const openclawConfigPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');

const [,, cmd, id, value] = process.argv;

switch (cmd) {
  case 'group': {
    if (!id || !['mention', 'all', 'off'].includes(value)) {
      console.error('Usage: zalo-manage.js group <groupId> <mention|all|off>');
      process.exit(1);
    }
    const settings = readJson(groupSettingsPath, {});
    settings[id] = { mode: value };
    writeJson(groupSettingsPath, settings);

    const groups = readJson(path.join(getZcaCacheDir(), 'groups.json'), []);
    const g = groups.find(x => String(x.groupId || x.id) === id);
    const name = g ? g.name : id;
    const modeLabel = value === 'all' ? 'mọi tin' : value === 'mention' ? '@mention' : 'tắt';
    console.log(`OK: Nhóm "${name}" → ${modeLabel}`);
    console.log('Lưu ý: mở Dashboard → Zalo → Lưu cấu hình để đồng bộ hoàn toàn.');
    break;
  }

  case 'user': {
    if (!id || !['on', 'off'].includes(value)) {
      console.error('Usage: zalo-manage.js user <userId> <on|off>');
      process.exit(1);
    }
    let blocklist = readJson(blocklistPath, []);
    if (!Array.isArray(blocklist)) blocklist = [];
    if (value === 'off') {
      if (!blocklist.includes(id)) blocklist.push(id);
    } else {
      blocklist = blocklist.filter(x => x !== id);
    }
    writeJson(blocklistPath, blocklist);

    const friends = readJson(path.join(getZcaCacheDir(), 'friends.json'), []);
    const f = friends.find(x => String(x.userId || x.id) === id);
    const name = f ? (f.displayName || f.zaloName) : id;
    console.log(`OK: User "${name}" → ${value === 'on' ? 'bật' : 'tắt'}`);
    break;
  }

  case 'list-groups': {
    const groups = readJson(path.join(getZcaCacheDir(), 'groups.json'), []);
    const settings = readJson(groupSettingsPath, {});
    const cfg = readJson(openclawConfigPath, {});
    const allowFrom = cfg?.channels?.['modoro-zalo']?.groupAllowFrom || [];
    const isOpen = cfg?.channels?.['modoro-zalo']?.groupPolicy === 'open';

    if (groups.length === 0) { console.log('Chưa có nhóm Zalo nào.'); break; }
    for (const g of groups) {
      const gid = String(g.groupId || g.id);
      const s = settings[gid]?.mode || (isOpen || allowFrom.includes(gid) ? 'mention' : 'off');
      const label = s === 'all' ? 'MOI TIN' : s === 'mention' ? '@MENTION' : 'TAT';
      console.log(`[${label}] ${g.name || gid} (${g.totalMember || '?'} tv) — ID: ${gid}`);
    }
    break;
  }

  case 'list-users': {
    const friends = readJson(path.join(getZcaCacheDir(), 'friends.json'), []);
    const blocklist = readJson(blocklistPath, []);

    if (friends.length === 0) { console.log('Chưa có bạn bè Zalo.'); break; }
    for (const f of friends) {
      const uid = String(f.userId || f.id);
      const blocked = blocklist.includes(uid);
      const label = blocked ? 'TAT' : 'BAT';
      console.log(`[${label}] ${f.displayName || f.zaloName || uid} — ID: ${uid}`);
    }
    break;
  }

  case 'status': {
    const cfg = readJson(openclawConfigPath, {});
    const oz = cfg?.channels?.['modoro-zalo'] || {};
    const settings = readJson(groupSettingsPath, {});
    const blocklist = readJson(blocklistPath, []);
    const groups = readJson(path.join(getZcaCacheDir(), 'groups.json'), []);
    const friends = readJson(path.join(getZcaCacheDir(), 'friends.json'), []);

    const activeGroups = Object.entries(settings).filter(([,v]) => v.mode !== 'off').length;
    console.log(`Zalo: ${oz.enabled !== false ? 'BẬT' : 'TẮT'}`);
    console.log(`Nhóm: ${groups.length} tổng, ${activeGroups} đang bật`);
    console.log(`Bạn bè: ${friends.length} tổng, ${blocklist.length} đang tắt`);
    console.log(`Chế độ nhóm: ${oz.groupPolicy || 'open'}`);
    break;
  }

  default:
    console.error('Commands: group, user, list-groups, list-users, status');
    process.exit(1);
}
