'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ctx = require('./context');
const { getWorkspace, auditLog } = require('./workspace');
const { getBundledVendorDir, findNodeBin } = require('./boot');
const { withOpenClawConfigLock, writeOpenClawConfigIfChanged } = require('./config');
const { call9Router } = require('./nine-router');
const { getZaloGroupsDir } = require('./zalo-memory');

// ============================================
//  PRIVATE STATE
// ============================================
let _zaloReady = false;
let _zaloPluginInFlight = null;
let _groupHistorySeedInFlight = false;
let _cachedOpenzcaCliJs = null;
const MODORO_ZALO_FORK_VERSION = 'modoro-zalo-v1.0.0';

// ============================================
//  GETTERS
// ============================================
function isZaloReady() { return _zaloReady; }
function getZaloPluginVersion() { return MODORO_ZALO_FORK_VERSION; }

// ============================================
//  cleanupOrphanZaloListener
// ============================================
// Force-cleanup any Zalo listener tree before fresh gateway spawn.
// Reason: listener-owner.json stores the LISTENER's own pid, not the gateway's.
// A listener can be alive but orphaned (gateway dead). Messages silently drop.
// Simplest fix: always kill any "openzca listen" process before starting new gateway.
function cleanupOrphanZaloListener() {
  try {
    // Kill any openzca listen process tree on Windows/Unix
    if (process.platform === 'win32') {
      try {
        // Use PowerShell (always available on Win10+) instead of wmic (deprecated/removed on Win11 24H2+)
        const { execSync } = require('child_process');
        const psCmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*openzca*listen*' } | Select-Object -ExpandProperty ProcessId"`;
        const out = execSync(psCmd, { encoding: 'utf-8', timeout: 8000 }).trim();
        const pids = out.split(/\r?\n/).map(l => l.trim()).filter(p => /^\d+$/.test(p));
        for (const pid of pids) {
          try {
            execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 3000 });
            console.log('[zalo-cleanup] Killed listener tree pid', pid);
          } catch {}
        }
      } catch (e) { console.error('[zalo-cleanup] error:', e.message); }
    } else {
      try {
        require('child_process').execSync('pkill -f "openzca.*listen" 2>/dev/null || true', { stdio: 'ignore' });
      } catch {}
    }
    // Remove stale listener-owner.json so new gateway can claim fresh
    const ownerFile = path.join(ctx.HOME, '.openzca', 'profiles', 'default', 'listener-owner.json');
    if (fs.existsSync(ownerFile)) {
      try { fs.unlinkSync(ownerFile); console.log('[zalo-cleanup] Removed listener-owner.json'); } catch {}
    }
  } catch (e) { console.error('[zalo-cleanup] error:', e.message); }
}

// ============================================
//  ensureModoroZaloNodeModulesLink
// ============================================
// Idempotent heal: ensure <plugin>/node_modules exists and points at
// vendor/node_modules. Runs on EVERY boot, independent of whether the plugin
// was freshly copied or already present. Without this, users who installed
// a previous build (where we copied the plugin but NOT the deps link) are
// permanently broken on "Cannot find module 'zod'" even after upgrading.
function ensureModoroZaloNodeModulesLink() {
  try {
    const extensionsDir = path.join(ctx.HOME, '.openclaw', 'extensions', 'modoro-zalo');
    if (!fs.existsSync(path.join(extensionsDir, 'openclaw.plugin.json'))) return;
    const pluginNodeModules = path.join(extensionsDir, 'node_modules');
    // Already linked/present? Verify it has zod (the critical dep) to be sure
    // it's not an empty or partial dir from a previous broken attempt.
    if (fs.existsSync(path.join(pluginNodeModules, 'zod'))) return;
    const vendorDir = getBundledVendorDir();
    if (!vendorDir) return;
    const vendorNodeModules = path.join(vendorDir, 'node_modules');
    if (!fs.existsSync(vendorNodeModules)) return;
    // Remove ANY existing entry — fs.existsSync follows symlinks so it returns
    // false for broken symlinks, leaving them in place → symlinkSync EEXIST →
    // fallback mkdirSync also fails because path is a broken symlink (not a dir).
    // Use lstatSync (does NOT follow symlinks) to detect all cases.
    try {
      const lstat = fs.lstatSync(pluginNodeModules);
      if (lstat.isSymbolicLink() || lstat.isFile()) {
        fs.unlinkSync(pluginNodeModules);       // remove symlink / broken symlink
      } else {
        fs.rmSync(pluginNodeModules, { recursive: true, force: true }); // remove dir
      }
    } catch {}
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    try {
      fs.symlinkSync(vendorNodeModules, pluginNodeModules, linkType);
      console.log('[ensureModoroZaloNodeModulesLink] linked →', vendorNodeModules, `(${linkType})`);
    } catch (linkErr) {
      console.warn('[ensureModoroZaloNodeModulesLink] symlink failed, copying deps:', linkErr?.message);
      fs.mkdirSync(pluginNodeModules, { recursive: true });
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(extensionsDir, 'package.json'), 'utf-8'));
        for (const dep of Object.keys(pkg.dependencies || {})) {
          const src = path.join(vendorNodeModules, dep);
          const dst = path.join(pluginNodeModules, dep);
          if (fs.existsSync(src) && !fs.existsSync(dst)) {
            fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false });
            console.log('[ensureModoroZaloNodeModulesLink] copied', dep);
          }
        }
      } catch (copyErr) {
        console.error('[ensureModoroZaloNodeModulesLink] CRITICAL fallback copy failed:', copyErr?.message);
      }
    }
  } catch (e) {
    console.error('[ensureModoroZaloNodeModulesLink] error:', e?.message || e);
  }
}

// ============================================
//  ensureZaloPlugin — in-flight promise guard
// ============================================
async function ensureZaloPlugin() {
  if (_zaloReady) return;
  // If a previous call is already running, attach to its promise instead of
  // re-entering the body. This makes the function safe under concurrent
  // invocation (boot path + fire-and-forget tail call + plugin manager UI).
  if (_zaloPluginInFlight) return _zaloPluginInFlight;
  _zaloPluginInFlight = (async () => {
    try {
      return await _ensureZaloPluginImpl();
    } finally {
      _zaloPluginInFlight = null;
    }
  })();
  return _zaloPluginInFlight;
}

// ============================================
//  seedZaloCustomersFromCache
// ============================================
// Bulk-seed memory/zalo-users/ and memory/zalo-groups/ from openzca cache.
// Solves the "cold start memory" problem: CEO installs MODOROClaw on day 1 and
// customers who've been Zalo friends for years get recognized on their first
// bot interaction instead of being treated as strangers.
//
// Idempotent: skips customers that already have a profile (bot may have
// learned things about them we don't want to overwrite).
//
// Data source: openzca listener maintains friend + group caches at
// ~/.openzca/profiles/default/cache/{friends.json,groups.json}. These are
// refreshed every 10 minutes by the listener, so they're usually <30min old.
function seedZaloCustomersFromCache() {
  try {
    const homedir = require('os').homedir();
    const cacheDir = path.join(homedir, '.openzca', 'profiles', 'default', 'cache');
    if (!fs.existsSync(cacheDir)) {
      console.log('[seedZaloCustomers] openzca cache dir not found, skipping');
      return;
    }
    const workspace = getWorkspace();
    if (!workspace) return;
    const usersDir = path.join(workspace, 'memory', 'zalo-users');
    const groupsDir = path.join(workspace, 'memory', 'zalo-groups');
    try { fs.mkdirSync(usersDir, { recursive: true }); } catch {}
    try { fs.mkdirSync(groupsDir, { recursive: true }); } catch {}

    let seededUsers = 0, seededGroups = 0, skipped = 0;
    const stamp = new Date().toISOString().slice(0, 19);

    // Collect all discovered IDs for default-deny blocklist seeding.
    const allFriendIds = [];
    const allGroupIds = [];

    // Friends → memory/zalo-users/<userId>.md
    const friendsPath = path.join(cacheDir, 'friends.json');
    if (fs.existsSync(friendsPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(friendsPath, 'utf-8'));
        const friends = Array.isArray(raw) ? raw : (Array.isArray(raw?.friends) ? raw.friends : []);
        for (const f of friends) {
          const userId = f.userId || f.uid || f.id;
          if (!userId) continue;
          allFriendIds.push(String(userId));
          const profilePath = path.join(usersDir, `${userId}.md`);
          if (fs.existsSync(profilePath)) { skipped++; continue; }
          const displayName = String(f.displayName || f.zaloName || f.name || 'Khách Zalo').trim();
          const zaloName = String(f.zaloName || f.displayName || displayName).trim();
          const lastSeen = f.lastActionTime
            ? new Date(f.lastActionTime).toISOString()
            : new Date().toISOString();
          const statusText = String(f.status || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 200);
          const content = `---
name: ${displayName}
zaloName: ${zaloName}
lastSeen: ${lastSeen}
msgCount: 0
gender: unknown
tags: []
groups: []
---
# ${displayName}

${statusText ? `**Trạng thái Zalo:** ${statusText}\n\n` : ''}---
*Hồ sơ được import tự động từ openzca cache lúc ${stamp}. Bot sẽ cập nhật thêm info sau mỗi lần tương tác.*
`;
          try { fs.writeFileSync(profilePath, content, 'utf-8'); seededUsers++; }
          catch (e) { console.error('[seedZaloCustomers] write user error:', e.message); }
        }
      } catch (e) {
        console.error('[seedZaloCustomers] friends parse error:', e.message);
      }
    }

    // Groups → memory/zalo-groups/<groupId>.md
    const groupsPath = path.join(cacheDir, 'groups.json');
    if (fs.existsSync(groupsPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(groupsPath, 'utf-8'));
        const groups = Array.isArray(raw) ? raw : (Array.isArray(raw?.groups) ? raw.groups : []);
        for (const g of groups) {
          const groupId = g.groupId || g.id;
          if (!groupId) continue;
          allGroupIds.push(String(groupId));
          const profilePath = path.join(groupsDir, `${groupId}.md`);
          if (fs.existsSync(profilePath)) { skipped++; continue; }
          const name = String(g.name || g.groupName || 'Nhóm Zalo').trim();
          const memberCount = Array.isArray(g.memVerList) ? g.memVerList.length
            : Array.isArray(g.members) ? g.members.length
            : (g.totalMember || 0);
          const content = `---
name: ${name}
lastActivity: ${new Date().toISOString()}
memberCount: ${memberCount}
---
# Nhóm ${groupId}

**Tên nhóm:** ${name}

## Chủ đề thường thảo luận
(chưa có)

## Thành viên key
(chưa có)

## Quyết định/thông báo gần đây
(chưa có)

---
*Nhóm được import tự động từ openzca cache lúc ${stamp}.*
`;
          try { fs.writeFileSync(profilePath, content, 'utf-8'); seededGroups++; }
          catch (e) { console.error('[seedZaloCustomers] write group error:', e.message); }
        }
      } catch (e) {
        console.error('[seedZaloCustomers] groups parse error:', e.message);
      }
    }

    if (seededUsers > 0 || seededGroups > 0) {
      console.log(`[seedZaloCustomers] seeded ${seededUsers} users + ${seededGroups} groups (skipped ${skipped} existing)`);
      try { auditLog('zalo_customers_seeded', { users: seededUsers, groups: seededGroups, skipped }); } catch {}
    } else if (skipped > 0) {
      console.log(`[seedZaloCustomers] ${skipped} profiles already exist, no new seeds`);
    } else {
      console.log('[seedZaloCustomers] cache is empty, nothing to seed');
    }

    // === Default-deny via settings (one-time, post-onboarding) ===
    // After wizard: bot does NOT reply to anyone by default. CEO explicitly
    // enables from Dashboard. No blocklist pollution — use settings only.
    try {
      const seedFlagPath = path.join(workspace, 'zalo-initial-blocklist-seeded.json');
      const cacheHasContent = allFriendIds.length > 0 || allGroupIds.length > 0;
      if (cacheHasContent && !fs.existsSync(seedFlagPath)) {
        // 1. Stranger policy → ignore (don't reply to unknown DMs)
        const spPath = path.join(workspace, 'zalo-stranger-policy.json');
        if (!fs.existsSync(spPath)) {
          fs.writeFileSync(spPath, JSON.stringify({ mode: 'ignore' }, null, 2), 'utf-8');
        }
        // 2. All discovered groups → off, default new group mode → off
        const gsPath = path.join(workspace, 'zalo-group-settings.json');
        let gs = {};
        if (fs.existsSync(gsPath)) {
          try { gs = JSON.parse(fs.readFileSync(gsPath, 'utf-8')) || {}; } catch {}
        }
        gs.__default = { mode: 'off' };
        for (const gid of allGroupIds) {
          if (!gs[gid]) gs[gid] = { mode: 'off' };
        }
        fs.writeFileSync(gsPath, JSON.stringify(gs, null, 2), 'utf-8');
        // 3. Empty blocklist (no group IDs, no friend IDs — settings handle deny)
        const blocklistPath = path.join(workspace, 'zalo-blocklist.json');
        if (!fs.existsSync(blocklistPath)) {
          fs.writeFileSync(blocklistPath, '[]', 'utf-8');
        }
        fs.writeFileSync(seedFlagPath, JSON.stringify({
          seededAt: new Date().toISOString(),
          friendCount: allFriendIds.length,
          groupCount: allGroupIds.length,
          note: 'Settings-based deny: stranger=ignore, all groups=off, default group=off. No blocklist seeding.',
        }, null, 2), 'utf-8');
        console.log(`[seed-defaults] stranger=ignore, ${allGroupIds.length} groups=off, default-group=off`);
        try { auditLog('zalo_defaults_seeded', { friends: allFriendIds.length, groups: allGroupIds.length }); } catch {}
      }
    } catch (e) {
      console.warn('[seed-defaults] error:', e.message);
    }
  } catch (e) {
    console.error('[seedZaloCustomers] error:', e.message);
  }
}

// ============================================
//  findOpenzcaCliJs
// ============================================
// Locate openzca CLI (mirrors gateway spawn candidate list from _startOpenClawImpl).
function findOpenzcaCliJs() {
  if (_cachedOpenzcaCliJs && fs.existsSync(_cachedOpenzcaCliJs)) return _cachedOpenzcaCliJs;
  const candidates = [];
  try {
    const bundled = getBundledVendorDir && getBundledVendorDir();
    if (bundled) candidates.push(path.join(bundled, 'node_modules', 'openzca', 'dist', 'cli.js'));
  } catch {}
  if (process.platform === 'win32') {
    candidates.push(
      path.join(ctx.HOME, 'AppData', 'Roaming', 'npm', 'node_modules', 'openzca', 'dist', 'cli.js'),
      path.join(ctx.HOME, 'AppData', 'Local', 'npm', 'node_modules', 'openzca', 'dist', 'cli.js'),
      'C:\\Program Files\\nodejs\\node_modules\\openzca\\dist\\cli.js',
    );
  } else {
    candidates.push(
      '/opt/homebrew/lib/node_modules/openzca/dist/cli.js',
      '/usr/local/lib/node_modules/openzca/dist/cli.js',
      '/opt/local/lib/node_modules/openzca/dist/cli.js',
      path.join(ctx.HOME, '.npm-global/lib/node_modules/openzca/dist/cli.js'),
      path.join(ctx.HOME, '.local/lib/node_modules/openzca/dist/cli.js'),
    );
    try {
      const nvmDir = path.join(ctx.HOME, '.nvm', 'versions', 'node');
      if (fs.existsSync(nvmDir)) {
        for (const v of fs.readdirSync(nvmDir)) {
          candidates.push(path.join(nvmDir, v, 'lib', 'node_modules', 'openzca', 'dist', 'cli.js'));
        }
      }
    } catch {}
    try {
      const vendorCli = path.join(process.resourcesPath || '', 'vendor', 'node_modules', 'openzca', 'dist', 'cli.js');
      candidates.push(vendorCli);
    } catch {}
  }
  for (const p of candidates) {
    try { if (fs.existsSync(p)) { _cachedOpenzcaCliJs = p; return p; } } catch {}
  }
  return null;
}

// ============================================
//  seedGroupHistorySummary
// ============================================
// Seed a single group's history summary. Returns { ok, reason }.
//   - ok=true  → file updated (or already seeded / skipped for valid reason)
//   - ok=false → transient failure; leave "(chưa có)" so next boot retries
async function seedGroupHistorySummary(groupId, threadName) {
  const placeholder = '(chưa có)';
  try {
    const dir = getZaloGroupsDir && getZaloGroupsDir();
    if (!dir) return { ok: false, reason: 'no-groups-dir' };
    const filePath = path.join(dir, `${groupId}.md`);
    if (!fs.existsSync(filePath)) return { ok: true, reason: 'no-metadata-file' };
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); }
    catch { return { ok: false, reason: 'read-failed' }; }
    // Only proceed if at least one section still has the placeholder.
    const hasTopicsPlaceholder   = /##\s+Chủ đề thường thảo luận\s*\n\(chưa có\)/.test(content);
    const hasMembersPlaceholder  = /##\s+Thành viên key\s*\n\(chưa có\)/.test(content);
    const hasDecisionPlaceholder = /##\s+Quyết định\/thông báo gần đây\s*\n\(chưa có\)/.test(content);
    if (!hasTopicsPlaceholder && !hasMembersPlaceholder && !hasDecisionPlaceholder) {
      return { ok: true, reason: 'already-seeded' };
    }
    const cliJs = findOpenzcaCliJs();
    if (!cliJs) return { ok: false, reason: 'openzca-cli-not-found' };
    const nodeBin = findNodeBin();
    if (!nodeBin) return { ok: false, reason: 'node-not-found' };
    // Fetch last 30 messages from Zalo's live history for this group.
    const stdout = await new Promise((resolve) => {
      let out = '', err = '';
      const child = spawn(nodeBin, [cliJs, '--profile', 'default', 'msg', 'recent', groupId, '-g', '-n', '30', '--source', 'live', '-j'], {
        shell: false,
        windowsHide: true,
        timeout: 15000,
      });
      child.stdout.on('data', d => out += d.toString());
      child.stderr.on('data', d => err += d.toString());
      child.on('error', () => resolve({ out: '', err: 'spawn-error' }));
      child.on('exit', (code) => resolve({ out, err, code }));
    });
    if (!stdout || !stdout.out) return { ok: false, reason: 'no-stdout' };
    // openzca returns rate-limit error on stderr occasionally. Bail this run.
    if (stdout.err && /rate|429/i.test(stdout.err)) return { ok: false, reason: 'rate-limited' };
    let msgs;
    try {
      const parsed = JSON.parse(stdout.out);
      msgs = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.messages) ? parsed.messages : null);
    } catch { return { ok: false, reason: 'json-parse-failed' }; }
    if (!msgs || msgs.length === 0) {
      // New group with no pre-bot history → nothing to summarize. Leave placeholder.
      return { ok: true, reason: 'empty-history' };
    }
    // Format messages for the prompt.
    const formatted = msgs.map(m => {
      const ts = m.timestamp || m.ts || m.time || '';
      const name = String(m.senderName || m.fromName || m.sender || 'unknown').trim().slice(0, 40);
      const body = String(m.body || m.content || m.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!body) return null;
      return `[${ts}] ${name}: ${body}`;
    }).filter(Boolean).join('\n');
    if (!formatted) return { ok: true, reason: 'no-text-messages' };
    const prompt = `Dưới đây là 30 tin nhắn gần nhất trong nhóm Zalo "${threadName || 'không tên'}".\n` +
      `Hãy tóm tắt ngắn gọn thành 3 phần:\n` +
      `1. CHỦ ĐỀ THƯỜNG THẢO LUẬN: 2-4 bullet, mỗi bullet <20 từ.\n` +
      `2. THÀNH VIÊN KEY: 2-4 bullet, format "Tên/ID — vai trò hoặc đặc điểm".\n` +
      `3. QUYẾT ĐỊNH/THÔNG BÁO GẦN ĐÂY: 2-4 bullet, mỗi bullet <25 từ.\n` +
      `Không thêm phần nào khác. Không viết emoji. Tiếng Việt tự nhiên.\n` +
      `--- TIN NHẮN ---\n${formatted}`;
    const llmOut = await call9Router(prompt, { maxTokens: 800, temperature: 0.3, timeoutMs: 20000 });
    if (!llmOut) return { ok: false, reason: '9router-failed' };
    // Parse 3 sections out of LLM response. Accept headings like "1.", "CHỦ ĐỀ...",
    // "## CHỦ ĐỀ...", etc. Regex-based split on the key labels (case-insensitive).
    const sectionPattern = /(?:^|\n)\s*(?:##\s*|\d+[.)]\s*|\*\*\s*)?(CHỦ ĐỀ[^\n:]*|THÀNH VIÊN[^\n:]*|QUYẾT ĐỊNH[^\n:]*)[:\s]*\n?/gi;
    const parts = {};
    const matches = [...llmOut.matchAll(sectionPattern)];
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const headerUpper = m[1].toUpperCase();
      const startIdx = m.index + m[0].length;
      const endIdx = (i + 1 < matches.length) ? matches[i + 1].index : llmOut.length;
      let body = llmOut.slice(startIdx, endIdx).trim();
      // Strip surrounding ** if any, normalize bullet prefix
      body = body.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
        const stripped = l.replace(/^[-*•·]\s*/, '').replace(/^\d+[.)]\s*/, '').trim();
        return stripped ? `- ${stripped}` : '';
      }).filter(Boolean).join('\n');
      if (!body) continue;
      if (/CHỦ ĐỀ/i.test(headerUpper)) parts.topics = body;
      else if (/THÀNH VIÊN/i.test(headerUpper)) parts.members = body;
      else if (/QUYẾT ĐỊNH/i.test(headerUpper)) parts.decisions = body;
    }
    if (!parts.topics && !parts.members && !parts.decisions) {
      return { ok: false, reason: 'llm-unparseable' };
    }
    // Rewrite the MD file — replace each "(chưa có)" placeholder only if we got
    // content for that section. Preserve file structure otherwise.
    let updated = content;
    if (parts.topics && hasTopicsPlaceholder) {
      updated = updated.replace(/(##\s+Chủ đề thường thảo luận\s*\n)\(chưa có\)/, `$1${parts.topics}`);
    }
    if (parts.members && hasMembersPlaceholder) {
      updated = updated.replace(/(##\s+Thành viên key\s*\n)\(chưa có\)/, `$1${parts.members}`);
    }
    if (parts.decisions && hasDecisionPlaceholder) {
      updated = updated.replace(/(##\s+Quyết định\/thông báo gần đây\s*\n)\(chưa có\)/, `$1${parts.decisions}`);
    }
    // Update front-matter lastActivity
    updated = updated.replace(/^(lastActivity:\s*)[^\n]*$/m, `$1${new Date().toISOString()}`);
    // Append an auto-seed footer comment once (only if not already present)
    if (!/auto-seeded via history summary/i.test(updated)) {
      updated = updated.trimEnd() + `\n\n*Lịch sử nhóm được tự động tóm tắt từ ${msgs.length} tin gần nhất lúc ${new Date().toISOString().slice(0, 19)} (auto-seeded via history summary).*\n`;
    }
    if (updated === content) return { ok: true, reason: 'no-change' };
    // Atomic-ish write: temp + rename. Safe enough for MD.
    const tmpPath = filePath + '.tmp-' + Date.now();
    try {
      fs.writeFileSync(tmpPath, updated, 'utf-8');
      fs.renameSync(tmpPath, filePath);
    } catch (e) {
      try { fs.unlinkSync(tmpPath); } catch {}
      return { ok: false, reason: 'write-failed: ' + e.message };
    }
    console.log(`[group-history-seed] summarized ${msgs.length} messages for group ${groupId}`);
    try { auditLog('group_history_seeded', { groupId, msgCount: msgs.length, sections: Object.keys(parts) }); } catch {}
    return { ok: true, reason: 'seeded', msgCount: msgs.length };
  } catch (e) {
    return { ok: false, reason: 'exception: ' + (e && e.message ? e.message : String(e)) };
  }
}

// ============================================
//  seedAllGroupHistories
// ============================================
// Batch-seed all groups with unseeded placeholders. Rate limit: 1 per 3s.
// Bail on rate-limit error. Fire-and-forget from startOpenClaw, never blocks boot.
async function seedAllGroupHistories({ source = 'auto' } = {}) {
  if (_groupHistorySeedInFlight) {
    return { started: false, reason: 'already-running' };
  }
  _groupHistorySeedInFlight = true;
  const stats = { scanned: 0, seeded: 0, skipped: 0, failed: 0, failures: [] };
  try {
    const dir = getZaloGroupsDir && getZaloGroupsDir();
    if (!dir || !fs.existsSync(dir)) {
      return { started: true, ...stats, reason: 'no-groups-dir' };
    }
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    for (const f of files) {
      stats.scanned++;
      const groupId = f.replace(/\.md$/, '');
      let threadName = groupId;
      try {
        const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
        const m = raw.match(/^name:\s*([^\n]+)/m);
        if (m) threadName = m[1].trim();
      } catch {}
      const r = await seedGroupHistorySummary(groupId, threadName);
      if (r.ok && r.reason === 'seeded') stats.seeded++;
      else if (r.ok) stats.skipped++;
      else {
        stats.failed++;
        stats.failures.push({ groupId, reason: r.reason });
        // Hard bail on rate-limit so we don't hammer Zalo.
        if (r.reason === 'rate-limited') {
          console.warn('[group-history-seed] rate-limited — bailing this run');
          break;
        }
      }
      // 3s stagger between calls
      await new Promise(r => setTimeout(r, 3000));
    }
    console.log(`[group-history-seed] ${source} run done: scanned=${stats.scanned} seeded=${stats.seeded} skipped=${stats.skipped} failed=${stats.failed}`);
    return { started: true, ...stats };
  } finally {
    _groupHistorySeedInFlight = false;
  }
}

// ============================================
//  checkZaloCookieAge — no-op stub
// ============================================
// Cookie expiry monitor — REMOVED.
// Zalo sessions persist indefinitely as long as the listener keeps the
// WebSocket alive (confirmed via VinCSS research + openzca behavior).
// The old 14-day warning was an unverified assumption that caused false
// alarms and unnecessary QR re-scans for CEO.
// Kept as no-op so existing call sites don't break.
function checkZaloCookieAge() {}

// ============================================
//  _ensureZaloPluginImpl
// ============================================
async function _ensureZaloPluginImpl() {
  if (_zaloReady) return;
  try {
    // FRESH-INSTALL: copy modoro-zalo plugin from packages/ into
    // ~/.openclaw/extensions/modoro-zalo. Our own fork — no network needed.
    const extensionsDir = path.join(ctx.HOME, '.openclaw', 'extensions', 'modoro-zalo');
    const vendorDir = getBundledVendorDir();
    // Heal missing node_modules link even when plugin is already present
    // (upgrade path from prior build that copied plugin without linking deps).
    ensureModoroZaloNodeModulesLink();

    // Version marker — used to detect when the fork needs re-copy on upgrade.
    const FORK_VERSION = MODORO_ZALO_FORK_VERSION;
    const forkVersionFile = path.join(extensionsDir, 'src', '.fork-version');
    const currentForkVersion = (() => {
      try { return fs.readFileSync(forkVersionFile, 'utf-8').trim(); } catch { return ''; }
    })();

    // FAST PATH: plugin already installed AND version matches (common on subsequent boots).
    if (fs.existsSync(path.join(extensionsDir, 'openclaw.plugin.json')) && currentForkVersion === FORK_VERSION) {
      console.log('[ensureZaloPlugin] modoro-zalo plugin already present (v=' + FORK_VERSION + ') — skipping install');
      _zaloReady = true;
      return;
    }

    // PRIMARY SOURCE: packages/modoro-zalo/ (our fork, shipped in-tree)
    const packagesSource = path.join(__dirname, '..', 'packages', 'modoro-zalo');
    // FALLBACK: vendor/node_modules/modoro-zalo/ (bundled in vendor)
    const vendorSource = vendorDir ? path.join(vendorDir, 'node_modules', 'modoro-zalo') : null;

    const sourceDir = fs.existsSync(path.join(packagesSource, 'openclaw.plugin.json'))
      ? packagesSource
      : (vendorSource && fs.existsSync(path.join(vendorSource, 'openclaw.plugin.json')) ? vendorSource : null);

    if (sourceDir) {
      try {
        fs.mkdirSync(extensionsDir, { recursive: true });
        // Recursive copy — use fs.cpSync (Node 16.7+). Safe on Electron 28 (Node 18).
        fs.cpSync(sourceDir, extensionsDir, { recursive: true, force: true, errorOnExist: false });
        console.log('[ensureZaloPlugin] copied modoro-zalo plugin from', sourceDir, '→', extensionsDir);
        // Also ensure the plugin entry exists in openclaw.json, but mirror
        // the actual master Zalo enabled flag so copied plugin files do not
        // silently turn Zalo back on.
        await withOpenClawConfigLock(async () => {
          try {
            console.log('[config-lock] ensureZaloPlugin acquired');
            const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
            if (fs.existsSync(configPath)) {
              const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
              if (!cfg.plugins) cfg.plugins = {};
              if (!cfg.plugins.entries) cfg.plugins.entries = {};
              // Determine desired enabled state: check modoro-zalo block, then
              // legacy openzalo block (v49 upgrade), then sticky backup.
              let wantZaloEnabled = cfg?.channels?.['modoro-zalo']?.enabled;
              if (wantZaloEnabled === undefined) wantZaloEnabled = cfg?.channels?.openzalo?.enabled;
              if (wantZaloEnabled === undefined) {
                try {
                  const stickyPath = path.join(ctx.HOME, '.openclaw', 'modoroclaw-zalo-config-sticky.json');
                  if (fs.existsSync(stickyPath)) {
                    const snap = JSON.parse(fs.readFileSync(stickyPath, 'utf-8'));
                    wantZaloEnabled = snap?.channel?.enabled;
                  }
                } catch {}
              }
              if (wantZaloEnabled === undefined) wantZaloEnabled = false;
              if (!cfg.plugins.entries['modoro-zalo']) cfg.plugins.entries['modoro-zalo'] = { enabled: wantZaloEnabled };
              else cfg.plugins.entries['modoro-zalo'].enabled = wantZaloEnabled;
              writeOpenClawConfigIfChanged(configPath, cfg);
            }
          } catch (e) { console.warn('[ensureZaloPlugin] config update failed:', e?.message); }
        });
        // CRITICAL: after copying the plugin, its hoisted dependencies (zod etc)
        // are no longer reachable via Node's normal module resolution. The plugin
        // is "type": "module" (ESM) so NODE_PATH fallback doesn't apply either.
        // Fix: create a directory junction (Windows) / symlink (Mac/Linux) from
        // <plugin>/node_modules → vendor/node_modules.
        if (vendorDir) {
          try {
            const pluginNodeModules = path.join(extensionsDir, 'node_modules');
            const vendorNodeModules = path.join(vendorDir, 'node_modules');
            if (fs.existsSync(vendorNodeModules) && !fs.existsSync(pluginNodeModules)) {
              const linkType = process.platform === 'win32' ? 'junction' : 'dir';
              try {
                fs.symlinkSync(vendorNodeModules, pluginNodeModules, linkType);
                console.log('[ensureZaloPlugin] linked node_modules →', vendorNodeModules, `(${linkType})`);
              } catch (linkErr) {
                // Junction can fail on rare Windows setups (non-NTFS, permission
                // edge cases). Fall back to copying ONLY the declared deps.
                console.warn('[ensureZaloPlugin] junction failed, copying deps explicitly:', linkErr?.message);
                try {
                  fs.mkdirSync(pluginNodeModules, { recursive: true });
                  const pkgPath = path.join(extensionsDir, 'package.json');
                  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                  const deps = Object.keys(pkg.dependencies || {});
                  for (const dep of deps) {
                    const src = path.join(vendorNodeModules, dep);
                    const dst = path.join(pluginNodeModules, dep);
                    if (fs.existsSync(src) && !fs.existsSync(dst)) {
                      fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false });
                      console.log('[ensureZaloPlugin] copied dep', dep);
                    }
                  }
                } catch (copyErr) {
                  console.error('[ensureZaloPlugin] CRITICAL: dep copy fallback ALSO failed:', copyErr?.message);
                  console.error('[ensureZaloPlugin] Zalo plugin WILL fail to load with "Cannot find module"');
                }
              }
            }
          } catch (e) { console.warn('[ensureZaloPlugin] node_modules link setup failed:', e?.message); }
        }
        // Cleanup old extensions/openzalo/ directory if it exists (upgrade from v2.3.x)
        try {
          const oldExtDir = path.join(ctx.HOME, '.openclaw', 'extensions', 'openzalo');
          if (fs.existsSync(oldExtDir)) {
            fs.rmSync(oldExtDir, { recursive: true, force: true });
            console.log('[ensureZaloPlugin] cleaned up old extensions/openzalo/ directory');
          }
        } catch (e) { console.warn('[ensureZaloPlugin] old openzalo cleanup failed:', e?.message); }
        _zaloReady = true;
        return;
      } catch (e) {
        console.error('[ensureZaloPlugin] copy failed:', e?.message || e);
      }
    } else {
      console.warn('[ensureZaloPlugin] no modoro-zalo source found (checked packages/ and vendor/)');
    }
  } catch (e) {
    console.error('[ensureZaloPlugin] unexpected error:', e?.message || e);
  }
}

// ============================================
//  EXPORTS
// ============================================
module.exports = {
  cleanupOrphanZaloListener,
  ensureModoroZaloNodeModulesLink,
  ensureZaloPlugin,
  seedZaloCustomersFromCache,
  findOpenzcaCliJs,
  seedGroupHistorySummary,
  seedAllGroupHistories,
  checkZaloCookieAge,
  _ensureZaloPluginImpl,
  isZaloReady,
  getZaloPluginVersion,
};
