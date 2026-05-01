'use strict';
const fs = require('fs');
const path = require('path');
const { isPathSafe, writeJsonAtomic } = require('./util');
const { getWorkspace, getBrandAssetsDir, readFbConfig, purgeAgentSessions, auditLog, BRAND_ASSET_FORMATS, BRAND_ASSET_MAX_SIZE } = require('./workspace');
const { _withCustomCronLock, loadCustomCrons, getCustomCronsPath, restartCronJobs } = require('./cron');
const { sendCeoAlert, sendZaloTo, sendZaloMediaTo, sendTelegram, sendTelegramPhoto } = require('./channels');
const { getZcaCacheDir } = require('./zalo-memory');
const { stripCronApiTokenFromAgents } = require('./cron-api-token');
const mediaLibrary = require('./media-library');

let shell;
try { shell = require('electron').shell; } catch {}

let _cronApiServer = null;
let _cronApiPort = 20200;
let _cronApiToken = '';

function replaceTokenInValue(value, token, changedRef) {
  if (typeof value === 'string') {
    const next = value.replace(/token=[a-f0-9]{48}\b/gi, 'token=' + token);
    if (next !== value) changedRef.changed = true;
    return next;
  }
  if (Array.isArray(value)) return value.map(v => replaceTokenInValue(v, token, changedRef));
  if (value && typeof value === 'object') {
    const next = {};
    for (const [key, child] of Object.entries(value)) next[key] = replaceTokenInValue(child, token, changedRef);
    return next;
  }
  return value;
}

function refreshCronApiTokenInCustomCrons(token) {
  if (!/^[a-f0-9]{48}$/i.test(String(token || ''))) return;
  try {
    const cronsPath = getCustomCronsPath();
    if (!fs.existsSync(cronsPath)) return;
    const raw = fs.readFileSync(cronsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const changedRef = { changed: false };
    const next = replaceTokenInValue(parsed, token, changedRef);
    if (changedRef.changed) {
      writeJsonAtomic(cronsPath, next);
      console.log('[cron-api] refreshed API token in custom-crons.json');
    }
  } catch (e) {
    console.error('[cron-api] custom-crons token refresh failed:', e.message);
  }
}

function redactSecrets(value) {
  if (typeof value === 'string') {
    return value
      .replace(/(token=)[a-f0-9]{48}\b/gi, '$1<redacted>')
      .replace(/((?:Dùng|Dung|Use)\s+token:\s*)[a-f0-9]{48}\b/giu, '$1<redacted>')
      .replace(/(bot_token=)[^&\s"']+/gi, '$1<redacted>');
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = redactSecrets(child);
    return out;
  }
  return value;
}

function resolveZaloIsGroup({ groupId, groupName, friendName, isGroupParam }) {
  if (friendName) return false;
  if (groupId || groupName) return true;
  if (isGroupParam === true || isGroupParam === 'true') return true;
  if (isGroupParam === false || isGroupParam === 'false') return false;
  return false;
}

function startCronApi() {
  if (_cronApiServer) return;
  const http = require('http');
  const crypto = require('crypto');
  const nodeCron = require('node-cron');
  const handleGoogleRoute = require('./google-routes');

  _cronApiToken = crypto.randomBytes(24).toString('hex');
  try {
    const tokenPath = path.join(getWorkspace(), 'cron-api-token.txt');
    fs.writeFileSync(tokenPath, _cronApiToken, 'utf-8');
  } catch (e) { console.error('[cron-api] failed to write token file:', e.message); }
  refreshCronApiTokenInCustomCrons(_cronApiToken);
  try {
    const ws = getWorkspace();
    const agentsPath = ws && path.join(ws, 'AGENTS.md');
    if (agentsPath && fs.existsSync(agentsPath)) {
      const content = fs.readFileSync(agentsPath, 'utf-8');
      const nextContent = stripCronApiTokenFromAgents(content);
      if (nextContent !== content) {
        fs.writeFileSync(agentsPath, nextContent, 'utf-8');
        console.log('[cron-api] removed stale API token from AGENTS.md');
      }
    }
  } catch (e) { console.error('[cron-api] AGENTS.md token cleanup failed:', e.message); }

  function loadFriendsList() {
    try {
      const p = path.join(getZcaCacheDir(), 'friends.json');
      if (!fs.existsSync(p)) return [];
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      const arr = Array.isArray(data) ? data : (Array.isArray(data?.friends) ? data.friends : []);
      return arr.map(f => ({
        userId: String(f.userId || f.uid || f.id || f.userKey || ''),
        displayName: f.displayName || f.zaloName || '',
        zaloName: f.zaloName || f.displayName || '',
        avatar: f.avatar || '',
      }));
    } catch { return []; }
  }

  function loadGroupsMap() {
    try {
      const p = path.join(getZcaCacheDir(), 'groups.json');
      if (!fs.existsSync(p)) return { byId: {}, byName: {} };
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      const byId = {}, byName = {};
      const groups = Array.isArray(data) ? data : (Array.isArray(data?.groups) ? data.groups : []);
      for (const g of groups) {
        const id = String(g.groupId || g.id || '');
        const name = g.name || g.groupName || '';
        if (id) { byId[id] = name; if (name) byName[name.toLowerCase()] = id; }
      }
      return { byId, byName };
    } catch { return { byId: {}, byName: {} }; }
  }

  function jsonResp(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  function parseBody(req) {
    return new Promise((resolve) => {
      if (req.method === 'GET') {
        const u = new URL(req.url, 'http://127.0.0.1');
        const obj = {};
        for (const [k, v] of u.searchParams) obj[k] = v;
        // Long text params may contain & which breaks URL parsing.
        // Extract the LAST known text param from raw query as a fallback.
        const raw = req.url;
        for (const key of ['content', 'message', 'text', 'prompt']) {
          const marker = key + '=';
          const idx = raw.indexOf(marker);
          if (idx !== -1 && (!obj[key] || obj[key].length < 5)) {
            const rawVal = raw.slice(idx + marker.length);
            try { obj[key] = decodeURIComponent(rawVal.replace(/\+/g, ' ')); }
            catch { obj[key] = rawVal.replace(/\+/g, ' '); }
          }
        }
        resolve(obj);
        return;
      }
      const urlParams = {};
      const u = new URL(req.url, 'http://127.0.0.1');
      for (const [k, v] of u.searchParams) urlParams[k] = v;
      let chunks = [];
      let totalLen = 0;
      let resolved = false;
      const finish = (obj) => {
        if (resolved) return;
        resolved = true;
        resolve(obj);
      };
      const MAX_BODY = 1024 * 1024;
      req.on('data', c => {
        totalLen += c.length;
        if (totalLen > MAX_BODY) {
          try { req.destroy(); } catch {}
          finish(urlParams);
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try { finish({ ...urlParams, ...JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { finish(urlParams); }
      });
      req.on('error', () => finish(urlParams));
      req.setTimeout(5000, () => finish(urlParams));
    });
  }

  async function withWriteLock(fn) {
    return _withCustomCronLock(fn);
  }

  const server = http.createServer(async (req, res) => {
    const host = req.headers.host || '';
    if (!/^127\.0\.0\.1(:\d+)?$/.test(host) && !/^localhost(:\d+)?$/.test(host)) {
      return jsonResp(res, 403, { error: 'forbidden' });
    }
    const urlPath = (new URL(req.url, 'http://127.0.0.1')).pathname;
    const params = await parseBody(req);

    // Token bootstrap is the only token-free endpoint. Read/list endpoints also
    // require token because they can expose cron prompts, local IDs, or logs.
    // Token bootstrap: /api/auth/token requires Telegram bot token as proof
    // (prevents Zalo-originated prompt injection from acquiring the cron API token).
    const tokenFreeEndpoints = ['/api/auth/token'];
    const requiresToken = !tokenFreeEndpoints.includes(urlPath);
    if (requiresToken && params.token !== _cronApiToken) {
      return jsonResp(res, 403, { error: 'invalid or missing token. Call /api/auth/token with your telegram bot_token to get the cron-api token.' });
    }

    // /api/auth/token — exchange Telegram bot token for cron API token.
    // Only the Telegram channel agent has the bot token in its context.
    if (urlPath === '/api/auth/token') {
      const botToken = String(params.bot_token || '').trim();
      if (!botToken) return jsonResp(res, 400, { error: 'bot_token required' });
      try {
        const configPath = path.join(require('os').homedir(), '.openclaw', 'openclaw.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const realToken = config?.channels?.telegram?.botToken;
        if (!realToken) return jsonResp(res, 500, { error: 'Telegram bot token not configured' });
        if (botToken !== realToken) {
          auditLog('auth_token_rejected', { reason: 'bot_token mismatch' });
          return jsonResp(res, 403, { error: 'invalid bot_token' });
        }
        return jsonResp(res, 200, { token: _cronApiToken });
      } catch (e) {
        return jsonResp(res, 500, { error: 'config read error' });
      }
    }

    // Path sandboxing: block reads/writes to sensitive files regardless of token.
    // Even CEO shouldn't accidentally leak these through bot context.
    if (urlPath.startsWith('/api/file/') || urlPath === '/api/workspace/read') {
      const reqPath = String(params.path || '').toLowerCase().replace(/\\/g, '/');
      const SENSITIVE_PATTERNS = [
        /credentials\.json/i,
        /\.p12$/i,
        /\.pem$/i,
        /\.key$/i,
        /private.*key/i,
        /\.env$/i,
        /cron-api-token\.txt/i,
        /rag-secret\.txt/i,
        /bot.*token/i,
        /secret/i,
        /password/i,
        /\.ssh\//i,
        /\.gnupg\//i,
        /client_secret\.json/i,
      ];
      if (SENSITIVE_PATTERNS.some(p => p.test(reqPath))) {
        auditLog('file_api_blocked', { urlPath, path: reqPath, reason: 'sensitive path' });
        return jsonResp(res, 403, { error: 'SECURITY: access to sensitive file blocked. Path matched security filter.' });
      }
    }

    // Google Workspace routes — delegate to google-routes.js
    if (urlPath.startsWith('/api/google/')) {
      return handleGoogleRoute(urlPath.slice('/api/google'.length), params, req, res, jsonResp);
    }

    if (urlPath === '/api/cron/create') {
      const { label, cronExpr, oneTimeAt, groupId, groupIds, content, mode, prompt: rawPrompt } = params;
      const isAgentMode = mode === 'agent';

      if (isAgentMode) {
        // Agent mode: run a full AI agent prompt. Agent can use web_search,
        // web_fetch tools. Delivers result to CEO Telegram by default.
        // If groupId is provided, agent also sends result to Zalo group via API.
        const agentPrompt = rawPrompt || content;
        if (!agentPrompt) return jsonResp(res, 400, { error: 'prompt (or content) required for mode=agent' });
        if (String(agentPrompt).length > 2000) return jsonResp(res, 400, { error: 'prompt too long (max 2000 chars)' });
        const existingCrons = loadCustomCrons();
        if (existingCrons.length >= 20) return jsonResp(res, 400, { error: 'too many crons (max 20). Delete some first.' });
        if (cronExpr) {
          const normalized = String(cronExpr).trim().replace(/\s+/g, ' ');
          if (!nodeCron.validate(normalized)) return jsonResp(res, 400, { error: 'invalid cronExpr: ' + cronExpr });
          const parts = normalized.split(' ');
          if (parts.length >= 1) {
            const minField = parts[0];
            const stepMatch = minField.match(/^\*\/(\d+)$/);
            if (minField === '*' || (stepMatch && parseInt(stepMatch[1], 10) < 5)) {
              return jsonResp(res, 400, { error: 'frequency too high — minimum 5 minutes (use */5 or wider).' });
            }
          }
        }
        if (oneTimeAt) {
          const d = new Date(oneTimeAt);
          if (isNaN(d.getTime())) return jsonResp(res, 400, { error: 'invalid oneTimeAt: ' + oneTimeAt });
          if (d.getTime() < Date.now() - 60000) return jsonResp(res, 400, { error: 'oneTimeAt is in the past: ' + oneTimeAt });
        }
        if (!cronExpr && !oneTimeAt) return jsonResp(res, 400, { error: 'cronExpr or oneTimeAt required' });

        // If groupId provided, validate it and append delivery instructions
        let finalPrompt = String(agentPrompt);
        let resolvedGroupId = null;
        let resolvedGroupName = null;
        if (groupId) {
          const { byId, byName } = loadGroupsMap();
          resolvedGroupId = byName[String(groupId).toLowerCase()] || String(groupId).trim();
          resolvedGroupName = byId[resolvedGroupId];
          if (!resolvedGroupName) {
            return jsonResp(res, 400, { error: 'unknown groupId: ' + groupId + '. Check /api/cron/list for available groups.' });
          }
          finalPrompt += '\n\n---\nSAU KHI HOÀN THÀNH: gửi kết quả vào nhóm Zalo:\n'
            + 'web_fetch url=http://127.0.0.1:20200/api/zalo/send?token=' + _cronApiToken + '&groupId=' + resolvedGroupId + '&text=KẾT_QUẢ\n'
            + 'QUY TẮC VIẾT:\n'
            + '- Viết tiếng Việt CÓ DẤU đầy đủ (ví dụ: "trí tuệ nhân tạo" chứ KHÔNG "tri tue nhan tao")\n'
            + '- Viết dạng đoạn văn tự nhiên như đang chat, KHÔNG dùng danh sách số (1. 2. 3.), KHÔNG dùng bullet points\n'
            + '- Ngắn gọn, KHÔNG dùng emoji, KHÔNG tự xưng là AI/bot/trợ lý.';
        }

        const id = 'cron_' + Date.now();
        const entry = {
          id,
          label: label || ('Agent cron ' + new Date().toISOString().slice(0, 16)),
          prompt: finalPrompt,
          mode: 'agent',
          enabled: true,
          createdAt: new Date().toISOString(),
        };
        if (resolvedGroupId) entry.groupId = resolvedGroupId;
        if (cronExpr) entry.cronExpr = String(cronExpr).trim().replace(/\s+/g, ' ');
        else entry.oneTimeAt = oneTimeAt;
        try {
          return await withWriteLock(async () => {
            const crons = loadCustomCrons();
            crons.push(entry);
            writeJsonAtomic(getCustomCronsPath(), crons);
            try { restartCronJobs(); } catch {}
            const groupLabel = resolvedGroupName ? ' — group: ' + resolvedGroupName : '';
            console.log('[cron-api] created agent cron:', id, label || '', groupLabel);
            try {
              sendCeoAlert('[Cron] Đã tạo (agent): ' + (label || 'no label') + ' — ' + (cronExpr || oneTimeAt) + groupLabel);
            } catch {}
            return jsonResp(res, 200, { success: true, id, entry });
          });
        } catch (e) { return jsonResp(res, 500, { error: e.message }); }
      }

      // Default mode: group message send via openzca
      if (!content) return jsonResp(res, 400, { error: 'content required' });
      if (String(content).length > 500) return jsonResp(res, 400, { error: 'content too long (max 500 chars)' });
      const targets = groupIds ? String(groupIds).split(',').map(s => s.trim()).filter(Boolean) : (groupId ? [String(groupId).trim()] : []);
      if (targets.length === 0) return jsonResp(res, 400, { error: 'groupId or groupIds required' });
      const { byId, byName } = loadGroupsMap();
      const resolvedIds = targets.map(t => byName[t.toLowerCase()] || t);
      const invalidIds = resolvedIds.filter(id => !(id in byId));
      if (invalidIds.length > 0) return jsonResp(res, 400, { error: 'unknown groupId(s): ' + invalidIds.join(', ') + '. Available: ' + Object.entries(byId).map(([id, name]) => `${name} (${id})`).join(', ') });
      const existingCrons = loadCustomCrons();
      if (existingCrons.length >= 20) return jsonResp(res, 400, { error: 'too many crons (max 20). Delete some first.' });
      if (cronExpr) {
        const normalized = String(cronExpr).trim().replace(/\s+/g, ' ');
        if (!nodeCron.validate(normalized)) return jsonResp(res, 400, { error: 'invalid cronExpr: ' + cronExpr });
        const parts = normalized.split(' ');
        const minField = parts[0] || '';
        const stepMatch = minField.match(/^\*\/(\d+)$/);
        if (minField === '*' || (stepMatch && parseInt(stepMatch[1], 10) < 5)) {
          return jsonResp(res, 400, { error: 'frequency too high — minimum 5 minutes (use */5 or wider). Every-minute crons will spam groups.' });
        }
      }
      if (oneTimeAt) {
        const d = new Date(oneTimeAt);
        if (isNaN(d.getTime())) return jsonResp(res, 400, { error: 'invalid oneTimeAt (expected YYYY-MM-DDTHH:MM:SS): ' + oneTimeAt });
        if (d.getTime() < Date.now() - 60000) return jsonResp(res, 400, { error: 'oneTimeAt is in the past: ' + oneTimeAt });
      }
      if (!cronExpr && !oneTimeAt) return jsonResp(res, 400, { error: 'cronExpr or oneTimeAt required' });
      const targetStr = resolvedIds.join(',');
      const id = 'cron_' + Date.now();
      const entry = {
        id,
        label: label || ('Cron ' + new Date().toISOString().slice(0, 16)),
        prompt: 'exec: openzca msg send ' + targetStr + ' "' + String(content).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ').replace(/\r/g, '') + '" --group --profile default',
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      if (cronExpr) entry.cronExpr = String(cronExpr).trim().replace(/\s+/g, ' ');
      else entry.oneTimeAt = oneTimeAt;
      try {
        return await withWriteLock(async () => {
          const crons = loadCustomCrons();
          crons.push(entry);
          writeJsonAtomic(getCustomCronsPath(), crons);
          try { restartCronJobs(); } catch {}
          console.log('[cron-api] created:', id, label || '');
          try {
            const groupNames = resolvedIds.map(gid => byId[gid] || gid).join(', ');
            sendCeoAlert('[Cron] Đã tạo: ' + (label || 'no label') + ' — ' + (cronExpr || oneTimeAt) + ' — group: ' + groupNames);
          } catch {}
          return jsonResp(res, 200, { success: true, id, entry });
        });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    } else if (urlPath === '/api/cron/list') {
      try {
        const crons = redactSecrets(loadCustomCrons());
        const { byId } = loadGroupsMap();
        const resp = { crons, groups: Object.entries(byId).map(([id, name]) => ({ id, name })) };
        return jsonResp(res, 200, resp);
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    } else if (urlPath === '/api/cron/delete') {
      const { id } = params;
      if (!id) return jsonResp(res, 400, { error: 'id required' });
      try {
        return await withWriteLock(async () => {
          const crons = loadCustomCrons();
          const filtered = crons.filter(c => c.id !== id);
          if (filtered.length === crons.length) return jsonResp(res, 404, { error: 'cron not found: ' + id });
          writeJsonAtomic(getCustomCronsPath(), filtered);
          try { restartCronJobs(); } catch {}
          console.log('[cron-api] deleted:', id);
          try { sendCeoAlert('[Cron] Đã xóa: ' + id); } catch {}
          return jsonResp(res, 200, { success: true });
        });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    } else if (urlPath === '/api/cron/toggle') {
      const { id, enabled } = params;
      if (!id) return jsonResp(res, 400, { error: 'id required' });
      try {
        return await withWriteLock(async () => {
          const crons = loadCustomCrons();
          const target = crons.find(c => c.id === id);
          if (!target) return jsonResp(res, 404, { error: 'cron not found: ' + id });
          target.enabled = enabled === 'true' || enabled === true;
          writeJsonAtomic(getCustomCronsPath(), crons);
          try { restartCronJobs(); } catch {}
          try { sendCeoAlert('[Cron] ' + (target.enabled ? 'Bật' : 'Tắt') + ': ' + (target.label || id)); } catch {}
          return jsonResp(res, 200, { success: true, enabled: target.enabled });
        });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    } else if (urlPath === '/api/workspace/read') {
      const ws = getWorkspace();
      if (!ws) return jsonResp(res, 500, { error: 'workspace not found' });
      const reqPath = String(params.path || '').replace(/\\/g, '/');
      if (!reqPath) return jsonResp(res, 400, { error: 'path required' });
      const ALLOWED = [
        /^\.?learnings\/LEARNINGS\.md$/,
        /^LEARNINGS\.md$/,
        /^memory\/zalo-users\/[^\/]+\.md$/,
        /^memory\/zalo-groups\/[^\/]+\.md$/,
        /^knowledge\/[^\/]+\/index\.md$/,
        /^IDENTITY\.md$/,
        /^schedules\.json$/,
        /^custom-crons\.json$/,
        /^logs\/cron-runs\.jsonl$/,
        /^logs\/escalation-queue\.jsonl$/,
        /^logs\/ceo-alerts-missed\.log$/,
      ];
      if (reqPath.includes('..') || !ALLOWED.some(r => r.test(reqPath))) {
        return jsonResp(res, 403, { error: 'path not in whitelist' });
      }
      try {
        const fullPath = path.join(ws, reqPath);
        if (!fs.existsSync(fullPath)) return jsonResp(res, 404, { error: 'file not found: ' + reqPath });
        const content = redactSecrets(fs.readFileSync(fullPath, 'utf-8'));
        return jsonResp(res, 200, { path: reqPath, content, size: Buffer.byteLength(content) });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    } else if (urlPath === '/api/workspace/append') {
      if (params.token !== _cronApiToken) {
        return jsonResp(res, 403, { error: 'invalid or missing token' });
      }
      const ws = getWorkspace();
      if (!ws) return jsonResp(res, 500, { error: 'workspace not found' });
      const reqPath = String(params.path || '').replace(/\\/g, '/');
      const content = String(params.content || '');
      if (!reqPath || !content) return jsonResp(res, 400, { error: 'path and content required' });
      const APPEND_ALLOWED = [
        /^\.?learnings\/LEARNINGS\.md$/,
        /^LEARNINGS\.md$/,
      ];
      if (reqPath.includes('..') || !APPEND_ALLOWED.some(r => r.test(reqPath))) {
        return jsonResp(res, 403, { error: 'append only allowed for LEARNINGS.md' });
      }
      if (Buffer.byteLength(content) > 2000) return jsonResp(res, 400, { error: 'content too large (max 2000 bytes)' });
      try {
        return await withWriteLock(async () => {
          const fullPath = path.join(ws, reqPath);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.appendFileSync(fullPath, '\n' + content, 'utf-8');
          console.log('[workspace-api] appended to', reqPath, '(' + content.length + ' chars)');
          return jsonResp(res, 200, { success: true, path: reqPath });
        });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    } else if (urlPath === '/api/workspace/list') {
      const ws = getWorkspace();
      if (!ws) return jsonResp(res, 500, { error: 'workspace not found' });
      const dir = String(params.dir || '').replace(/\\/g, '/');
      const DIRS_ALLOWED = [
        /^memory\/zalo-users\/?$/,
        /^memory\/zalo-groups\/?$/,
        /^knowledge\/[^\/]+\/?$/,
      ];
      if (!dir || dir.includes('..') || !DIRS_ALLOWED.some(r => r.test(dir))) {
        return jsonResp(res, 403, { error: 'dir not in whitelist. Allowed: memory/zalo-users/, memory/zalo-groups/, knowledge/*/' });
      }
      try {
        const fullDir = path.join(ws, dir);
        if (!fs.existsSync(fullDir)) return jsonResp(res, 200, { dir, files: [] });
        const files = fs.readdirSync(fullDir).filter(f => f.endsWith('.md') || f.endsWith('.json'));
        return jsonResp(res, 200, { dir, files });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    } else if (urlPath === '/api/zalo/friends') {
      const friends = loadFriendsList();
      const q = String(params.name || params.q || '').trim().toLowerCase();
      if (q) {
        const matches = friends.filter(f =>
          f.displayName.toLowerCase().includes(q) || f.zaloName.toLowerCase().includes(q)
        );
        return jsonResp(res, 200, { query: q, count: matches.length, friends: matches });
      }
      return jsonResp(res, 200, { count: friends.length, friends });

    } else if (urlPath === '/api/zalo/send') {
      const { groupId, targetId: rawTargetId, groupName, friendName, text, isGroup: isGroupParam } = params;
      let tId = groupId || rawTargetId;
      if (!tId && groupName) {
        const { byName } = loadGroupsMap();
        tId = byName[String(groupName).toLowerCase()];
        if (!tId) return jsonResp(res, 400, { error: 'unknown groupName: ' + groupName + '. Check /api/cron/list for available groups.' });
      }
      if (!tId && friendName) {
        const q = String(friendName).trim().toLowerCase();
        const friends = loadFriendsList();
        const matches = friends.filter(f =>
          f.displayName.toLowerCase().includes(q) || f.zaloName.toLowerCase().includes(q)
        );
        if (matches.length === 1) {
          tId = matches[0].userId;
        } else if (matches.length > 1) {
          return jsonResp(res, 400, { error: 'Multiple friends match "' + friendName + '": ' + matches.map(f => f.displayName + ' (' + f.userId + ')').join(', ') + '. Use targetId to specify.' });
        } else {
          return jsonResp(res, 400, { error: 'No friend found matching "' + friendName + '". Call /api/zalo/friends to see all friends.' });
        }
      }
      if (!tId) return jsonResp(res, 400, { error: 'groupId, targetId, groupName, or friendName required' });
      if (!text) return jsonResp(res, 400, { error: 'text required' });
      if (String(text).length > 5000) return jsonResp(res, 400, { error: 'text too long (max 5000 chars)' });
      const isGroup = resolveZaloIsGroup({ groupId, groupName, friendName, isGroupParam });
      const { byId } = loadGroupsMap();
      if (isGroup && !byId[String(tId)]) {
        return jsonResp(res, 400, { error: 'unknown groupId: ' + tId + '. Check /api/cron/list for available groups.' });
      }
      try {
        const ok = await sendZaloTo({ id: String(tId), isGroup }, String(text), { skipFilter: false });
        if (ok) {
          console.log(`[cron-api] /api/zalo/send OK → ${isGroup ? 'group' : 'user'} ${tId}`);
          return jsonResp(res, 200, { success: true, targetId: String(tId), isGroup });
        } else {
          return jsonResp(res, 500, { success: false, error: 'sendZaloTo returned null — check listener status, target validity, or channel pause state' });
        }
      } catch (e) {
        return jsonResp(res, 500, { success: false, error: String(e?.message || e).slice(0, 300) });
      }

    } else if (urlPath === '/api/zalo/send-media') {
      const { groupId, targetId: rawTargetId, groupName, friendName, mediaId, caption, isGroup: isGroupParam } = params;
      let tId = groupId || rawTargetId;
      if (!tId && groupName) {
        const { byName } = loadGroupsMap();
        tId = byName[String(groupName).toLowerCase()];
        if (!tId) return jsonResp(res, 400, { error: 'unknown groupName: ' + groupName + '. Check /api/cron/list for available groups.' });
      }
      if (!tId && friendName) {
        const q = String(friendName).trim().toLowerCase();
        const friends = loadFriendsList();
        const matches = friends.filter(f =>
          f.displayName.toLowerCase().includes(q) || f.zaloName.toLowerCase().includes(q)
        );
        if (matches.length === 1) {
          tId = matches[0].userId;
        } else if (matches.length > 1) {
          return jsonResp(res, 400, { error: 'Multiple friends match "' + friendName + '": ' + matches.map(f => f.displayName + ' (' + f.userId + ')').join(', ') + '. Use targetId to specify.' });
        } else {
          return jsonResp(res, 400, { error: 'No friend found matching "' + friendName + '". Call /api/zalo/friends to see all friends.' });
        }
      }
      if (!tId) return jsonResp(res, 400, { error: 'groupId, targetId, groupName, or friendName required' });
      const isGroup = resolveZaloIsGroup({ groupId, groupName, friendName, isGroupParam });
      const { byId } = loadGroupsMap();
      if (isGroup && !byId[String(tId)]) {
        return jsonResp(res, 400, { error: 'unknown groupId: ' + tId + '. Check /api/cron/list for available groups.' });
      }
      let absPath = '';
      let asset = null;
      if (!mediaId) {
        return jsonResp(res, 400, { error: 'send-media requires mediaId from Media Library. Raw filePath/imagePath is blocked.' });
      }
      asset = mediaLibrary.findMediaAsset(String(mediaId));
      if (!asset) return jsonResp(res, 404, { error: 'media asset not found' });
      if (asset.visibility !== 'public' && params.allowInternal !== 'true') {
        return jsonResp(res, 403, { error: 'media asset is not public' });
      }
      absPath = asset.path;
      try {
        const ok = await sendZaloMediaTo({ id: String(tId), isGroup }, absPath, { caption: caption || asset?.title || '' });
        if (ok) {
          console.log(`[cron-api] /api/zalo/send-media OK → ${isGroup ? 'group' : 'user'} ${tId}`);
          return jsonResp(res, 200, { success: true, targetId: String(tId), isGroup, mediaId: asset?.id || null, mode: ok.mode || null });
        }
        return jsonResp(res, 500, { success: false, error: 'sendZaloMediaTo returned null — check listener status, target validity, media path, or channel pause state' });
      } catch (e) {
        return jsonResp(res, 500, { success: false, error: String(e?.message || e).slice(0, 300) });
      }

    } else if (urlPath === '/api/knowledge/add') {
      const ws = getWorkspace();
      if (!ws) return jsonResp(res, 500, { error: 'workspace not found' });
      const { category, title, content: faqContent } = params;
      const validCats = ['cong-ty', 'san-pham', 'nhan-vien'];
      if (!category || !validCats.includes(category)) return jsonResp(res, 400, { error: 'category required: ' + validCats.join(', ') });
      if (!title || !faqContent) return jsonResp(res, 400, { error: 'title and content required' });
      if (String(title).length > 200) return jsonResp(res, 400, { error: 'title too long (max 200)' });
      if (String(faqContent).length > 2000) return jsonResp(res, 400, { error: 'content too long (max 2000)' });
      try {
        return await withWriteLock(async () => {
          const indexPath = path.join(ws, 'knowledge', category, 'index.md');
          fs.mkdirSync(path.dirname(indexPath), { recursive: true });
          const entry = `\n\n## ${String(title).trim()}\n\n${String(faqContent).trim()}\n`;
          fs.appendFileSync(indexPath, entry, 'utf-8');
          console.log('[knowledge-api] added to', category + '/index.md:', title);
          try { auditLog('knowledge_added', { category, title: String(title).slice(0, 100) }); } catch {}
          purgeAgentSessions('knowledge-api-add');
          return jsonResp(res, 200, { success: true, category, title, indexPath: `knowledge/${category}/index.md` });
        });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    // ============================================
    //  CEO FILE API — full file system access (token-gated)
    // ============================================
    } else if (urlPath === '/api/file/read') {
      const filePath = String(params.path || '');
      if (!filePath) return jsonResp(res, 400, { error: 'path required (absolute path)' });
      const abs = path.resolve(filePath);
      try {
        const stat = fs.statSync(abs);
        if (stat.size > 10 * 1024 * 1024) return jsonResp(res, 400, { error: 'file too large (max 10MB). Size: ' + Math.round(stat.size / 1024 / 1024) + 'MB' });
        const ext = path.extname(abs).toLowerCase();
        if (ext === '.xlsx' || ext === '.xls') {
          try {
            const XLSX = require('xlsx');
            const wb = XLSX.readFile(abs);
            const sheets = {};
            for (const name of wb.SheetNames) {
              sheets[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' });
            }
            return jsonResp(res, 200, { success: true, path: abs, type: 'excel', sheets, sheetNames: wb.SheetNames });
          } catch (xe) { return jsonResp(res, 500, { error: 'Excel parse failed: ' + xe.message }); }
        }
        if (ext === '.pdf') {
          try {
            const pdfParse = require('pdf-parse');
            const buf = fs.readFileSync(abs);
            const data = await pdfParse(buf);
            return jsonResp(res, 200, { success: true, path: abs, type: 'pdf', pages: data.numpages, content: data.text.slice(0, 80000) });
          } catch (pe) { return jsonResp(res, 500, { error: 'PDF parse failed: ' + pe.message }); }
        }
        if (ext === '.docx') {
          try {
            const mammoth = require('mammoth');
            const result = await mammoth.extractRawText({ path: abs });
            return jsonResp(res, 200, { success: true, path: abs, type: 'docx', content: result.value.slice(0, 80000) });
          } catch (de) { return jsonResp(res, 500, { error: 'DOCX parse failed: ' + de.message }); }
        }
        if (ext === '.csv') {
          const text = fs.readFileSync(abs, 'utf-8');
          const lines = text.split(/\r?\n/).filter(l => l.trim());
          if (lines.length > 0) {
            const sep = (lines[0].match(/\t/) ? '\t' : ',');
            const headers = lines[0].split(sep).map(h => h.replace(/^"|"$/g, '').trim());
            const rows = lines.slice(1, 501).map(line => {
              const vals = line.split(sep).map(v => v.replace(/^"|"$/g, '').trim());
              const row = {};
              headers.forEach((h, i) => { row[h] = vals[i] || ''; });
              return row;
            });
            return jsonResp(res, 200, { success: true, path: abs, type: 'csv', headers, rowCount: lines.length - 1, rows });
          }
          return jsonResp(res, 200, { success: true, path: abs, type: 'csv', headers: [], rowCount: 0, rows: [] });
        }
        const buf = fs.readFileSync(abs);
        const isBinary = buf.slice(0, 8000).some(b => b === 0);
        if (isBinary) return jsonResp(res, 200, { success: true, path: abs, type: 'binary', size: stat.size, encoding: 'base64', content: buf.toString('base64').slice(0, 50000) });
        return jsonResp(res, 200, { success: true, path: abs, type: 'text', content: buf.toString('utf-8'), size: stat.size });
      } catch (e) {
        if (e.code === 'ENOENT') return jsonResp(res, 404, { error: 'file not found: ' + abs });
        return jsonResp(res, 500, { error: e.message });
      }

    } else if (urlPath === '/api/file/write') {
      const filePath = String(params.path || '');
      const content = params.content;
      if (!filePath) return jsonResp(res, 400, { error: 'path required (absolute path)' });
      if (content === undefined || content === null) return jsonResp(res, 400, { error: 'content required' });
      const abs = path.resolve(filePath);
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(content), 'utf-8');
        console.log('[file-api] write:', abs, '(' + String(content).length + ' chars)');
        return jsonResp(res, 200, { success: true, path: abs, size: Buffer.byteLength(String(content), 'utf-8') });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    } else if (urlPath === '/api/file/list') {
      const dirPath = String(params.path || '');
      if (!dirPath) return jsonResp(res, 400, { error: 'path required (absolute path to directory)' });
      const abs = path.resolve(dirPath);
      try {
        const entries = fs.readdirSync(abs, { withFileTypes: true });
        const items = entries.slice(0, 200).map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          size: e.isFile() ? (() => { try { return fs.statSync(path.join(abs, e.name)).size; } catch { return 0; } })() : undefined,
        }));
        return jsonResp(res, 200, { success: true, path: abs, count: entries.length, items });
      } catch (e) {
        if (e.code === 'ENOENT') return jsonResp(res, 404, { error: 'directory not found: ' + abs });
        return jsonResp(res, 500, { error: e.message });
      }

    } else if (urlPath === '/api/file/search') {
      const dir = String(params.path || params.dir || '');
      const query = String(params.query || params.name || '');
      if (!dir) return jsonResp(res, 400, { error: 'path required (directory to search in)' });
      if (!query) return jsonResp(res, 400, { error: 'query required (filename pattern, case-insensitive)' });
      const abs = path.resolve(dir);
      const maxDepth = Math.min(parseInt(params.depth) || 5, 10);
      const maxResults = Math.min(parseInt(params.limit) || 50, 200);
      const pattern = query.toLowerCase();
      const results = [];
      const walk = (dirPath, depth) => {
        if (depth > maxDepth || results.length >= maxResults) return;
        try {
          const entries = fs.readdirSync(dirPath, { withFileTypes: true });
          for (const e of entries) {
            if (results.length >= maxResults) break;
            if (e.name.startsWith('.') || e.name === 'node_modules') continue;
            const full = path.join(dirPath, e.name);
            if (e.name.toLowerCase().includes(pattern)) {
              const st = (() => { try { return fs.statSync(full); } catch { return null; } })();
              results.push({ name: e.name, path: full, type: e.isDirectory() ? 'dir' : 'file', size: st ? st.size : 0, modified: st ? st.mtime.toISOString() : null });
            }
            if (e.isDirectory()) walk(full, depth + 1);
          }
        } catch {}
      };
      walk(abs, 0);
      return jsonResp(res, 200, { success: true, searchDir: abs, query, resultCount: results.length, results });

    } else if (urlPath === '/api/file/open') {
      const filePath = String(params.path || '');
      if (!filePath) return jsonResp(res, 400, { error: 'path required' });
      const abs = path.resolve(filePath);
      if (!fs.existsSync(abs)) return jsonResp(res, 404, { error: 'file not found: ' + abs });
      auditLog('file_open', { path: abs });
      if (!shell || !shell.openPath) return jsonResp(res, 500, { error: 'shell.openPath unavailable (non-Electron context)' });
      const errMsg = await shell.openPath(abs);
      if (errMsg) return jsonResp(res, 500, { error: errMsg });
      return jsonResp(res, 200, { success: true, path: abs, message: 'File opened in default app' });

    } else if (urlPath === '/api/file/rename') {
      const src = String(params.path || params.from || '');
      const dst = String(params.newPath || params.to || '');
      if (!src || !dst) return jsonResp(res, 400, { error: 'path (source) and newPath (destination) required' });
      const absSrc = path.resolve(src);
      const absDst = path.resolve(dst);
      if (!fs.existsSync(absSrc)) return jsonResp(res, 404, { error: 'source not found: ' + absSrc });
      if (fs.existsSync(absDst)) return jsonResp(res, 409, { error: 'destination already exists: ' + absDst, warning: 'SECURITY: will not overwrite existing file. Delete destination first if intentional.' });
      auditLog('file_rename', { from: absSrc, to: absDst });
      try {
        fs.mkdirSync(path.dirname(absDst), { recursive: true });
        fs.renameSync(absSrc, absDst);
        return jsonResp(res, 200, { success: true, from: absSrc, to: absDst });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    } else if (urlPath === '/api/file/copy') {
      const src = String(params.path || params.from || '');
      const dst = String(params.to || params.dest || '');
      if (!src || !dst) return jsonResp(res, 400, { error: 'path (source) and to (destination) required' });
      const absSrc = path.resolve(src);
      const absDst = path.resolve(dst);
      if (!fs.existsSync(absSrc)) return jsonResp(res, 404, { error: 'source not found: ' + absSrc });
      if (fs.existsSync(absDst)) return jsonResp(res, 409, { error: 'destination already exists: ' + absDst, warning: 'SECURITY: will not overwrite. Delete destination first if intentional.' });
      auditLog('file_copy', { from: absSrc, to: absDst });
      try {
        fs.mkdirSync(path.dirname(absDst), { recursive: true });
        fs.copyFileSync(absSrc, absDst);
        const st = fs.statSync(absDst);
        return jsonResp(res, 200, { success: true, from: absSrc, to: absDst, size: st.size });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    } else if (urlPath === '/api/file/delete') {
      const filePath = String(params.path || '');
      if (!filePath) return jsonResp(res, 400, { error: 'path required' });
      const abs = path.resolve(filePath);
      if (!fs.existsSync(abs)) return jsonResp(res, 404, { error: 'not found: ' + abs });
      const st = fs.statSync(abs);
      if (st.isDirectory()) return jsonResp(res, 400, { error: 'SECURITY: directory deletion not allowed via API. Only single files.', warning: 'Recursive delete is too dangerous for remote API.' });
      if (st.size > 100 * 1024 * 1024) return jsonResp(res, 400, { error: 'SECURITY: file too large to delete via API (>100MB). Use file manager.', warning: 'Large file deletion requires manual confirmation.' });
      auditLog('file_delete', { path: abs, size: st.size });
      try {
        fs.unlinkSync(abs);
        return jsonResp(res, 200, { success: true, path: abs, warning: 'File permanently deleted. This cannot be undone.' });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    } else if (urlPath === '/api/file/download') {
      const url = String(params.url || '');
      const saveTo = String(params.path || params.saveTo || '');
      if (!url) return jsonResp(res, 400, { error: 'url required' });
      if (!saveTo) return jsonResp(res, 400, { error: 'path required (where to save the file)' });
      if (!/^https?:\/\//i.test(url)) return jsonResp(res, 400, { error: 'SECURITY: only http/https URLs allowed' });
      const abs = path.resolve(saveTo);
      if (fs.existsSync(abs)) return jsonResp(res, 409, { error: 'destination already exists: ' + abs, warning: 'SECURITY: will not overwrite. Delete first if intentional.' });
      auditLog('file_download', { url, saveTo: abs });
      try {
        const proto = url.startsWith('https') ? require('https') : require('http');
        const fileData = await new Promise((resolve, reject) => {
          const chunks = [];
          let size = 0;
          const MAX = 50 * 1024 * 1024;
          proto.get(url, { timeout: 30000 }, (resp) => {
            if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
              return reject(new Error('Redirect to: ' + resp.headers.location + ' — fetch that URL instead'));
            }
            if (resp.statusCode !== 200) return reject(new Error('HTTP ' + resp.statusCode));
            resp.on('data', (c) => { size += c.length; if (size > MAX) { resp.destroy(); reject(new Error('SECURITY: file too large (>50MB)')); } chunks.push(c); });
            resp.on('end', () => resolve(Buffer.concat(chunks)));
          }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('Download timeout (30s)')); });
        });
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, fileData);
        return jsonResp(res, 200, { success: true, url, path: abs, size: fileData.length, warning: 'SECURITY: file downloaded from external URL. Verify contents before opening.' });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    } else if (urlPath === '/api/system/info') {
      const os = require('os');
      let diskInfo = null;
      try {
        const diskCmd = process.platform === 'win32'
          ? 'wmic logicaldisk get size,freespace,caption /format:csv'
          : "df -h / | tail -1 | awk '{print $2,$4,$5}'";
        diskInfo = require('child_process').execSync(diskCmd, { encoding: 'utf-8', timeout: 5000 }).trim();
      } catch {}
      return jsonResp(res, 200, {
        success: true,
        platform: process.platform,
        arch: process.arch,
        hostname: os.hostname(),
        username: os.userInfo().username,
        homedir: os.homedir(),
        tmpdir: os.tmpdir(),
        totalMemoryGB: Math.round(os.totalmem() / 1073741824 * 10) / 10,
        freeMemoryGB: Math.round(os.freemem() / 1073741824 * 10) / 10,
        cpus: os.cpus().length,
        cpuModel: os.cpus()[0]?.model || 'unknown',
        uptime: Math.round(os.uptime() / 3600) + ' hours',
        nodeVersion: process.version,
        disk: diskInfo,
      });

    } else if (urlPath === '/api/exec') {
      const cmd = String(params.command || '');
      if (!cmd) return jsonResp(res, 400, { error: 'command required' });
      if (cmd.length > 2000) return jsonResp(res, 400, { error: 'command too long (max 2000 chars)' });
      // Block catastrophic commands that could destroy the system
      const cmdLower = cmd.toLowerCase().replace(/\s+/g, ' ').trim();
      const DANGEROUS_PATTERNS = [
        /\brm\s+-rf\s+[\/\\]/i,       // rm -rf /
        /\bformat\s+[a-z]:/i,          // format C:
        /\bdel\s+\/[sfq]/i,            // del /s /f /q
        /\brmdir\s+\/s/i,              // rmdir /s
        /\brd\s+\/s/i,                 // rd /s
        /\bmkfs\b/i,                   // mkfs
        /\bdd\s+if=/i,                 // dd if=
        /\b(shutdown|reboot|halt)\b/i, // system shutdown
        /\btaskkill\s+\/f\s+\/im\s+\*/i, // kill all processes
        /\bnet\s+user\b/i,             // user account manipulation
        /\breg\s+(delete|add)\b/i,     // registry manipulation
      ];
      if (DANGEROUS_PATTERNS.some(p => p.test(cmdLower))) {
        auditLog('exec_blocked', { command: cmd, reason: 'dangerous command pattern' });
        return jsonResp(res, 403, { error: 'SECURITY: command blocked — matches dangerous pattern. This is a safety guard.' });
      }
      auditLog('exec_run', { command: cmd.slice(0, 200), cwd: params.cwd || '(default)' });
      const timeoutMs = Math.min(parseInt(params.timeout) || 30000, 120000);
      const cwd = params.cwd ? String(params.cwd) : undefined;
      const { exec: execAsync } = require('child_process');
      return new Promise((resolve) => {
        execAsync(cmd, {
          timeout: timeoutMs,
          encoding: 'utf-8',
          cwd,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
          env: { ...process.env },
          shell: true,
        }, (err, stdout, stderr) => {
          if (err) {
            resolve(jsonResp(res, 200, {
              success: false,
              exitCode: err.code || 1,
              stdout: String(stdout || '').slice(0, 30000),
              stderr: String(stderr || '').slice(0, 30000),
              error: err.message,
            }));
          } else {
            resolve(jsonResp(res, 200, { success: true, output: String(stdout).slice(0, 50000) }));
          }
        });
      });

    // ─── Brand Assets API ──────────────────────────────────────────
    } else if (urlPath === '/api/brand-assets/list') {
      try {
        mediaLibrary.backfillLegacyBrandAssets();
        const files = mediaLibrary.listBrandAssetNames();
        return jsonResp(res, 200, { files });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    } else if (urlPath === '/api/brand-assets/save') {
      if (req.method !== 'POST') return jsonResp(res, 405, { error: 'POST only' });
      const { name, base64: b64Data } = params;
      if (!name || !b64Data) return jsonResp(res, 400, { error: 'name and base64 required' });
      const dir = getBrandAssetsDir();
      fs.mkdirSync(dir, { recursive: true });
      const safeName = String(name).replace(/[\\/:*?"<>|]/g, '_');
      if (!isPathSafe(dir, safeName)) return jsonResp(res, 400, { error: 'invalid filename' });
      const ext = path.extname(safeName).toLowerCase();
      if (!BRAND_ASSET_FORMATS.includes(ext)) return jsonResp(res, 400, { error: 'only png/jpg/webp allowed' });
      try {
        const buf = Buffer.from(b64Data, 'base64');
        if (buf.length > BRAND_ASSET_MAX_SIZE) return jsonResp(res, 400, { error: 'file too large (max 10MB)' });
        const outPath = path.join(dir, safeName);
        fs.writeFileSync(outPath, buf);
        try {
          mediaLibrary.registerExistingMediaFile(outPath, {
            type: 'brand',
            visibility: 'internal',
            source: 'brand-assets-api',
            status: 'indexed',
          });
        } catch (e) { console.warn('[media] brand asset register failed:', e.message); }
        return jsonResp(res, 200, { ok: true, name: safeName, sizeBytes: buf.length });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    // ─── Image Generation API ────────────────────────────────────
    } else if (urlPath === '/api/media/list') {
      try {
        mediaLibrary.backfillLegacyBrandAssets();
        const files = mediaLibrary.listMediaAssets({
          type: params.type || undefined,
          visibility: params.visibility || undefined,
          audience: params.audience || 'customer',
        });
        return jsonResp(res, 200, { files });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    } else if (urlPath === '/api/media/search') {
      try {
        const q = String(params.q || params.query || '').trim();
        if (!q) return jsonResp(res, 400, { error: 'query required' });
        const results = mediaLibrary.searchMediaAssets(q, {
          type: params.type || undefined,
          audience: params.audience || 'customer',
          limit: params.limit || params.max || 5,
        });
        return jsonResp(res, 200, { query: q, results });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    } else if (urlPath === '/api/media/upload') {
      if (req.method !== 'POST') return jsonResp(res, 405, { error: 'POST only' });
      try {
        const src = String(params.filePath || params.path || '').trim();
        if (!src) return jsonResp(res, 400, { error: 'filePath required' });
        const asset = mediaLibrary.importMediaFile(src, {
          type: params.type || 'product',
          visibility: params.visibility,
          title: params.title,
          tags: params.tags,
          aliases: params.aliases,
          sku: params.sku,
          description: params.description,
        });
        const shouldDescribe = params.describe !== 'false' && !asset.description;
        if (shouldDescribe) {
          mediaLibrary.describeMediaAsset(asset.id).catch(e => {
            console.error('[media] async describe failed:', e.message);
          });
        }
        return jsonResp(res, 200, { success: true, asset, describing: shouldDescribe });
      } catch (e) { return jsonResp(res, 500, { success: false, error: e.message }); }

    } else if (urlPath === '/api/media/describe') {
      if (req.method !== 'POST') return jsonResp(res, 405, { error: 'POST only' });
      try {
        const id = String(params.id || params.mediaId || '').trim();
        if (!id) return jsonResp(res, 400, { error: 'id required' });
        const asset = await mediaLibrary.describeMediaAsset(id);
        return jsonResp(res, 200, { success: true, asset });
      } catch (e) { return jsonResp(res, 500, { success: false, error: e.message }); }

    } else if (urlPath === '/api/image/generate') {
      const { prompt, assets, size } = params;
      if (!prompt) return jsonResp(res, 400, { error: 'prompt required' });
      if (String(prompt).length > 5000) return jsonResp(res, 400, { error: 'prompt too long (max 5000)' });
      const imageGen = require('./image-gen');
      const jobId = imageGen.generateJobId();
      const brandDir = getBrandAssetsDir();
      const assetList = Array.isArray(assets) ? assets : (assets ? String(assets).split(',').map(s => s.trim()).filter(Boolean) : []);
      let earlyFailureHandled = false;
      imageGen.startJob(jobId, String(prompt), brandDir, assetList, size || '1024x1024', (err, imgPath) => {
        if (err) {
          setTimeout(() => {
            if (!earlyFailureHandled) sendTelegram('[Tạo ảnh] Thất bại: ' + err.message, { skipFilter: true });
          }, 3000);
        } else if (imgPath) {
          sendTelegramPhoto(imgPath, 'Ảnh đã tạo xong').then(() => {}).catch(e =>
            console.error('[image-gen] proactive photo send failed:', e.message));
        }
      });
      const earlyStatus = await imageGen.waitForJobResult(jobId, 3000);
      if (earlyStatus.status === 'failed') {
        earlyFailureHandled = true;
        return jsonResp(res, 502, { jobId, status: 'failed', error: earlyStatus.error || 'image generation failed' });
      }
      return jsonResp(res, 200, { jobId, status: earlyStatus.status || 'generating', imagePath: earlyStatus.imagePath });

    } else if (urlPath === '/api/image/status') {
      const { jobId } = params;
      if (!jobId) return jsonResp(res, 400, { error: 'jobId required' });
      const imageGen = require('./image-gen');
      return jsonResp(res, 200, imageGen.getJobStatus(String(jobId)));

    // ─── Telegram Photo API ──────────────────────────────────────
    } else if (urlPath === '/api/telegram/send-photo') {
      const { imagePath: relPath, caption } = params;
      if (!relPath) return jsonResp(res, 400, { error: 'imagePath required' });
      const ws = getWorkspace();
      const absPath = path.resolve(ws, relPath);
      if (!absPath.startsWith(ws + path.sep)) return jsonResp(res, 400, { error: 'invalid path' });
      if (!fs.existsSync(absPath)) return jsonResp(res, 400, { error: 'file not found' });
      try {
        const ok = await sendTelegramPhoto(absPath, caption || '');
        return jsonResp(res, ok ? 200 : 500, { success: ok });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    // ─── Facebook API ────────────────────────────────────────────
    } else if (urlPath === '/api/fb/post') {
      const { message: fbMessage, imagePath: relImgPath } = params;
      if (!fbMessage) return jsonResp(res, 400, { error: 'message required' });
      if (String(fbMessage).length > 63206) return jsonResp(res, 400, { error: 'message too long (max 63206 chars)' });
      const cfg = readFbConfig();
      if (!cfg || !cfg.accessToken) return jsonResp(res, 400, { error: 'Facebook chưa kết nối. Paste token vào Dashboard.' });
      const fbPub = require('./fb-publisher');
      try {
        let result;
        if (relImgPath) {
          const ws = getWorkspace();
          const absImg = path.resolve(ws, relImgPath);
          if (!absImg.startsWith(ws + path.sep)) return jsonResp(res, 400, { error: 'invalid imagePath' });
          if (!fs.existsSync(absImg)) return jsonResp(res, 400, { error: 'image not found' });
          const imgBuf = fs.readFileSync(absImg);
          result = await fbPub.postPhoto(cfg.pageId, cfg.accessToken, String(fbMessage), imgBuf, absImg);
        } else {
          result = await fbPub.postText(cfg.pageId, cfg.accessToken, String(fbMessage));
        }
        return jsonResp(res, 200, result);
      } catch (e) {
        if (/OAuthException|Invalid OAuth|expired/i.test(e.message)) {
          return jsonResp(res, 401, { error: 'Token Facebook hết hạn. Paste token mới vào Dashboard.' });
        }
        return jsonResp(res, 500, { error: e.message });
      }

    } else if (urlPath === '/api/fb/recent') {
      const cfg = readFbConfig();
      if (!cfg || !cfg.accessToken) return jsonResp(res, 200, { posts: [] });
      try {
        const fbPub = require('./fb-publisher');
        const posts = await fbPub.getRecentPosts(cfg.pageId, cfg.accessToken, 5);
        return jsonResp(res, 200, { posts });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    } else {
      return jsonResp(res, 404, { error: 'not found', endpoints: ['/api/cron/create', '/api/cron/list', '/api/cron/delete', '/api/cron/toggle', '/api/zalo/send', '/api/zalo/send-media', '/api/knowledge/add', '/api/workspace/read', '/api/workspace/append', '/api/workspace/list', '/api/file/read', '/api/file/write', '/api/file/list', '/api/file/search', '/api/file/open', '/api/file/rename', '/api/file/copy', '/api/file/delete', '/api/file/download', '/api/system/info', '/api/exec', '/api/brand-assets/list', '/api/brand-assets/save', '/api/media/list', '/api/media/search', '/api/media/upload', '/api/media/describe', '/api/image/generate', '/api/image/status', '/api/telegram/send-photo', '/api/fb/post', '/api/fb/recent'] });
    }
  });

  function tryListen(port, retries) {
    server.listen(port, '127.0.0.1', () => {
      _cronApiServer = server;
      _cronApiPort = port;
      console.log('[cron-api] listening on http://127.0.0.1:' + port);
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && retries > 0) {
        console.warn('[cron-api] port ' + port + ' in use, trying ' + (port + 1));
        server.removeAllListeners('error');
        tryListen(port + 1, retries - 1);
      } else {
        console.error('[cron-api] server error:', err.message);
        try { sendCeoAlert('[Cron API] Không khởi động được HTTP server: ' + err.message); } catch {}
      }
    });
  }
  tryListen(20200, 3);
}

function getCronApiToken() { return _cronApiToken; }
function getCronApiPort() { return _cronApiPort; }

function cleanupCronApi() {
  if (_cronApiServer) {
    try { _cronApiServer.close(); } catch {}
    _cronApiServer = null;
  }
}

module.exports = { startCronApi, getCronApiToken, getCronApiPort, cleanupCronApi };
