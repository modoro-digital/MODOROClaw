'use strict';
const fs = require('fs');
const path = require('path');
const { isPathSafe, writeJsonAtomic } = require('./util');
const { getWorkspace, getBrandAssetsDir, readFbConfig, purgeAgentSessions, auditLog, BRAND_ASSET_FORMATS, BRAND_ASSET_MAX_SIZE } = require('./workspace');
const { _withCustomCronLock, loadCustomCrons, getCustomCronsPath, restartCronJobs } = require('./cron');
const { sendCeoAlert, sendZaloTo, sendZaloMediaTo, sendTelegram, sendTelegramPhoto, probeZaloReady } = require('./channels');
const { getZcaCacheDir, sanitizeZaloUserId } = require('./zalo-memory');
const { stripCronApiTokenFromAgents } = require('./cron-api-token');
const mediaLibrary = require('./media-library');
const fbSchedule = require('./fb-schedule');

let shell;
try { shell = require('electron').shell; } catch {}

let _cronApiServer = null;
let _cronApiPort = 20200;
let _cronApiToken = '';
const _fbPostApprovals = new Map();

const FB_APPROVALS_MAX = 100;
function cleanupFbPostApprovals(now = Date.now()) {
  for (const [nonce, entry] of _fbPostApprovals.entries()) {
    if (!entry || entry.expiresAt <= now) _fbPostApprovals.delete(nonce);
  }
  if (_fbPostApprovals.size > FB_APPROVALS_MAX) {
    const excess = _fbPostApprovals.size - FB_APPROVALS_MAX;
    let removed = 0;
    for (const key of _fbPostApprovals.keys()) {
      if (removed >= excess) break;
      _fbPostApprovals.delete(key);
      removed++;
    }
  }
}

function stripTokenInValue(value, changedRef) {
  if (typeof value === 'string') {
    let next = value.replace(/([?&])token=[a-f0-9]{48}(?=&|\s|$)/gi, (_match, sep) => sep === '?' ? '?' : '');
    next = next.replace(/\?&/g, '?').replace(/[?&](?=\s|$)/g, '').replace(/[?&]$/g, '');
    if (next !== value) changedRef.changed = true;
    return next;
  }
  if (Array.isArray(value)) return value.map(v => stripTokenInValue(v, changedRef));
  if (value && typeof value === 'object') {
    const next = {};
    for (const [key, child] of Object.entries(value)) next[key] = stripTokenInValue(child, changedRef);
    return next;
  }
  return value;
}

function stripCronApiTokenFromCustomCrons() {
  try {
    const cronsPath = getCustomCronsPath();
    if (!fs.existsSync(cronsPath)) return;
    const raw = fs.readFileSync(cronsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const changedRef = { changed: false };
    const next = stripTokenInValue(parsed, changedRef);
    if (changedRef.changed) {
      writeJsonAtomic(cronsPath, next);
      console.log('[cron-api] removed live API token from custom-crons.json');
    }
  } catch (e) {
    console.error('[cron-api] custom-crons token cleanup failed:', e.message);
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

// Note: Vietnamese diacritics are enforced at the AGENTS.md / skill level
// (bot reads these rules and applies them naturally). No runtime filter needed.

function sanitizeMediaAssetForApi(asset) {
  if (!asset || typeof asset !== 'object') return asset;
  const {
    path: _path,
    absolutePath: _absolutePath,
    sourcePath: _sourcePath,
    localPath: _localPath,
    ...safe
  } = asset;
  // Strip absolute paths from nested metadata object (pdfSource, knowledgeFilepath, etc.)
  if (safe.metadata && typeof safe.metadata === 'object') {
    const { pdfSource: _ps, knowledgeFilepath: _kf, ...safeMeta } = safe.metadata;
    safe.metadata = safeMeta;
  }
  return safe;
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
  stripCronApiTokenFromCustomCrons();
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

  function boolParam(value) {
    if (value === true || value === 'true' || value === '1' || value === 1) return true;
    if (value === false || value === 'false' || value === '0' || value === 0) return false;
    return null;
  }

  function resolveFriendByName(friendName) {
    const q = String(friendName || '').trim().toLowerCase();
    if (!q) return { error: 'friendName required' };
    const matches = loadFriendsList().filter(f =>
      String(f.displayName || '').toLowerCase().includes(q)
      || String(f.zaloName || '').toLowerCase().includes(q)
      || String(f.userId || '').toLowerCase() === q
    );
    if (matches.length === 0) {
      return { error: 'No friend found matching "' + friendName + '". Check /api/zalo/friends?name=' + encodeURIComponent(friendName) };
    }
    if (matches.length > 1) {
      return {
        error: 'Multiple friends match "' + friendName + '": ' + matches.slice(0, 5).map(f => `${f.displayName || f.zaloName} (${f.userId})`).join(', '),
      };
    }
    const friend = matches[0];
    return {
      id: String(friend.userId),
      label: friend.displayName || friend.zaloName || String(friend.userId),
    };
  }

  function resolveCronZaloTarget(params, opts = {}) {
    const allowMultipleGroups = opts.allowMultipleGroups !== false;
    const groupTargets = [];
    if (params.groupIds) {
      for (const raw of String(params.groupIds).split(',')) {
        const item = raw.trim();
        if (item) groupTargets.push(item);
      }
    }
    if (params.groupId) groupTargets.push(String(params.groupId).trim());
    if (params.groupName) groupTargets.push(String(params.groupName).trim());

    const isGroupFlag = boolParam(params.isGroup);
    const rawTargetId = String(params.targetId || '').trim();
    if (isGroupFlag === true && rawTargetId) groupTargets.push(rawTargetId);

    if (groupTargets.length > 0) {
      if (!allowMultipleGroups && groupTargets.length > 1) return { error: 'Only one Zalo group target is allowed for this cron mode.' };
      const { byId, byName } = loadGroupsMap();
      const resolvedIds = groupTargets.map(t => byName[String(t).toLowerCase()] || t);
      const invalidIds = resolvedIds.filter(id => !(id in byId));
      if (invalidIds.length > 0) {
        return { error: 'unknown groupId(s): ' + invalidIds.join(', ') + '. Available: ' + Object.entries(byId).map(([id, name]) => `${name} (${id})`).join(', ') };
      }
      return {
        type: 'group',
        ids: resolvedIds,
        labels: resolvedIds.map(id => byId[id] || id),
      };
    }

    if (params.friendName) {
      const friend = resolveFriendByName(params.friendName);
      if (friend.error) return friend;
      return { type: 'user', ids: [friend.id], labels: [friend.label], friendName: friend.label };
    }

    if (rawTargetId) {
      if (isGroupFlag === true) return { error: 'targetId with isGroup=true did not match a known group. Use groupId/groupName for groups.' };
      return { type: 'user', ids: [rawTargetId], labels: [rawTargetId] };
    }

    return null;
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
        // Long text params may contain an unescaped "&" which breaks URL parsing.
        // Recover only the text value, never trailing control/auth params.
        const raw = req.url;
        const stopKeys = [
          'token', 'groupId', 'targetId', 'groupName', 'friendName', 'mediaId', 'imagePath',
          'filePath', 'isGroup', 'label', 'cronExpr', 'oneTimeAt', 'mode', 'approvalNonce',
          'preview', 'dryRun', 'type', 'visibility', 'audience', 'limit', 'max',
          'caption', 'allowInternalGenerated', 'allowInternal',
        ];
        for (const key of ['content', 'message', 'text', 'prompt']) {
          const marker = key + '=';
          const idx = raw.indexOf(marker);
          if (idx !== -1 && (!obj[key] || obj[key].length < 5)) {
            let rawVal = raw.slice(idx + marker.length);
            let cutAt = rawVal.length;
            for (const stopKey of stopKeys) {
              const stopIdx = rawVal.indexOf('&' + stopKey + '=');
              if (stopIdx !== -1 && stopIdx < cutAt) cutAt = stopIdx;
            }
            rawVal = rawVal.slice(0, cutAt);
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

  function normalizeCronScheduleSpec(spec) {
    const cronExpr = spec?.cronExpr;
    const oneTimeAt = spec?.oneTimeAt;
    if (cronExpr) {
      const normalized = String(cronExpr).trim().replace(/\s+/g, ' ');
      if (!nodeCron.validate(normalized)) return { error: 'invalid cronExpr: ' + cronExpr };
      const minField = normalized.split(' ')[0] || '';
      const stepMatch = minField.match(/^\*\/(\d+)$/);
      if (minField === '*' || (stepMatch && parseInt(stepMatch[1], 10) < 5)) {
        return { error: 'frequency too high - minimum 5 minutes (use */5 or wider).' };
      }
      return { cronExpr: normalized };
    }
    if (oneTimeAt) {
      const d = new Date(oneTimeAt);
      if (isNaN(d.getTime())) return { error: 'invalid oneTimeAt: ' + oneTimeAt };
      if (d.getTime() < Date.now() - 60000) return { error: 'oneTimeAt is in the past: ' + oneTimeAt };
      return { oneTimeAt: String(oneTimeAt) };
    }
    return { error: 'cronExpr or oneTimeAt required' };
  }

  function parseMaybeJsonArray(value, fieldName) {
    if (value == null || value === '') return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return [];
      if (trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed);
          return Array.isArray(parsed) ? parsed : { error: fieldName + ' must be an array' };
        } catch (e) {
          return { error: 'invalid JSON for ' + fieldName + ': ' + e.message };
        }
      }
      return trimmed.split(',').map(s => s.trim()).filter(Boolean);
    }
    return { error: fieldName + ' must be an array' };
  }

  function makeCronId() {
    return 'cron_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
  }

  function escapeCronSendText(text) {
    return String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ').replace(/\r/g, '');
  }

  function buildCronEntryForAtomicReplace(spec, index = 0) {
    if (!spec || typeof spec !== 'object') return { error: 'create entry #' + (index + 1) + ' must be an object' };
    const schedule = normalizeCronScheduleSpec(spec);
    if (schedule.error) return { error: 'create entry #' + (index + 1) + ': ' + schedule.error };

    const mode = spec.mode === 'agent' ? 'agent' : 'fixed';
    const id = makeCronId();
    const label = String(spec.label || (mode === 'agent' ? 'Agent cron' : 'Cron') + ' ' + new Date().toISOString().slice(0, 16)).trim();

    if (mode === 'agent') {
      const agentPrompt = spec.prompt || spec.content;
      if (!agentPrompt) return { error: 'create entry #' + (index + 1) + ': prompt (or content) required for mode=agent' };
      if (String(agentPrompt).length > 2000) return { error: 'create entry #' + (index + 1) + ': prompt too long (max 2000 chars)' };

      let finalPrompt = String(agentPrompt);
      const delivery = resolveCronZaloTarget({
        groupId: spec.groupId,
        groupIds: spec.groupIds,
        groupName: spec.groupName,
        targetId: spec.targetId,
        friendName: spec.friendName,
        isGroup: spec.isGroup,
      }, { allowMultipleGroups: false });
      if (delivery?.error) return { error: 'create entry #' + (index + 1) + ': ' + delivery.error };
      if (delivery) {
        // Delivery instructions are handled by the server-side internal endpoint
        // (api/internal/agent-deliver-zalo). Do NOT include delivery instructions
        // in the prompt — the LLM should only produce content and let the system
        // handle sending it. Including web_fetch instructions in the prompt risks
        // them being sent verbatim to Zalo.
        // (Previous pattern: appended web_fetch instructions to prompt — removed to
        // prevent prompt leakage and enable server-side async delivery.)
      }

      const entry = { id, label, prompt: finalPrompt, mode: 'agent', enabled: true, createdAt: new Date().toISOString() };
      if (delivery?.type === 'group') entry.groupId = delivery.ids[0];
      if (delivery?.type === 'user') {
        entry.targetId = delivery.ids[0];
        entry.isGroup = false;
        if (delivery.friendName) entry.friendName = delivery.friendName;
      }
      // Store Zalo target for post-agent delivery (cron.js reads this after agent runs)
      if (delivery) {
        entry.zaloTarget = { id: delivery.ids[0], isGroup: delivery.type === 'group', label: delivery.labels[0] || delivery.ids[0] };
      }
      if (schedule.cronExpr) entry.cronExpr = schedule.cronExpr;
      else entry.oneTimeAt = schedule.oneTimeAt;
      return { entry, delivery };
    }

    const content = spec.content;
    if (!content) return { error: 'create entry #' + (index + 1) + ': content required' };
    if (String(content).length > 500) return { error: 'create entry #' + (index + 1) + ': content too long (max 500 chars)' };
    const delivery = resolveCronZaloTarget({
      groupId: spec.groupId,
      groupIds: spec.groupIds,
      groupName: spec.groupName,
      targetId: spec.targetId,
      friendName: spec.friendName,
      isGroup: spec.isGroup,
    }, { allowMultipleGroups: true });
    if (delivery?.error) return { error: 'create entry #' + (index + 1) + ': ' + delivery.error };
    if (!delivery) return { error: 'create entry #' + (index + 1) + ': groupId/groupIds/groupName/targetId/friendName required' };
    if (delivery.type === 'user' && delivery.ids.length !== 1) return { error: 'create entry #' + (index + 1) + ': fixed personal Zalo cron requires exactly one target' };
    const targetStr = delivery.ids.join(',');
    const entry = {
      id,
      label,
      prompt: 'exec: openzca msg send ' + targetStr + ' "' + escapeCronSendText(content) + '"' + (delivery.type === 'group' ? ' --group' : '') + ' --profile default',
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    if (schedule.cronExpr) entry.cronExpr = schedule.cronExpr;
    else entry.oneTimeAt = schedule.oneTimeAt;
    return { entry, delivery };
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
    const authHeader = String(req.headers.authorization || '').trim();
    const bearerToken = authHeader.match(/^Bearer\s+([a-f0-9]{48})$/i)?.[1] || '';
    const headerToken = String(req.headers['x-9bizclaw-token'] || '').trim();
    const suppliedToken = params.token || bearerToken || headerToken;
    if (requiresToken && suppliedToken !== _cronApiToken) {
      return jsonResp(res, 403, { error: 'Thiếu xác thực API nội bộ. Chỉ phiên Telegram CEO được tự động xác thực khi gọi API local.' });
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
    } else if (urlPath === '/api/capabilities') {
      try {
        let capDir = path.join(__dirname, '..', '..', 'capabilities');
        if (!fs.existsSync(capDir)) {
          try { capDir = path.join(process.resourcesPath, 'workspace-templates', 'capabilities'); } catch {}
        }
        if (!fs.existsSync(capDir)) {
          return jsonResp(res, 500, { error: 'Capabilities directory not found (dev or packaged)' });
        }
        const files = fs.readdirSync(capDir).filter(f => f.endsWith('.contract.json'));
        const domainMap = {
          'brand-image': 'image',
          'facebook-post': 'facebook',
          'google-sheets': 'google',
          'google-gmail': 'google',
          'zalo-cron': 'zalo'
        };
        const domains = {};
        for (const file of files) {
          try {
            const contract = JSON.parse(fs.readFileSync(path.join(capDir, file), 'utf-8'));
            const domain = domainMap[contract.id] || contract.id.split('-')[0];
            if (!domains[domain]) domains[domain] = { capabilities: [] };
            domains[domain].capabilities.push({
              id: contract.id,
              title: contract.title,
              allowedChannels: contract.allowedChannels,
              requiresConfirmation: contract.requiresConfirmation || false,
              sideEffects: contract.sideEffects || [],
              apiCalls: contract.apiCalls
            });
          } catch (parseErr) {
            console.error('[capabilities] skipping malformed contract ' + file + ': ' + parseErr.message);
          }
        }
        return jsonResp(res, 200, {
          version: '1',
          baseUrl: 'http://127.0.0.1:' + _cronApiPort,
          domains
        });
      } catch (e) {
        return jsonResp(res, 500, { error: 'Failed to load capabilities: ' + e.message });
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
        /agents\.md$/i,
        /bootstrap\.md$/i,
        /identity\.md$/i,
        /soul\.md$/i,
        /openclaw\.json$/i,
      ];
      if (SENSITIVE_PATTERNS.some(p => p.test(reqPath))) {
        auditLog('file_api_blocked', { urlPath, path: reqPath, reason: 'sensitive path' });
        return jsonResp(res, 403, { error: 'SECURITY: access to sensitive file blocked. Path matched security filter.' });
      }

      // Directory allowlist: resolved path must be inside workspace subdirectories.
      // This is defense-in-depth on top of the sensitive patterns above.
      const fileAbs = path.resolve(String(params.path || ''));
      const wsDir = getWorkspace();
      const ALLOWED_DIRS = wsDir ? [
        path.join(wsDir, 'knowledge'),
        path.join(wsDir, 'memory'),
        path.join(wsDir, 'brand-assets'),
        path.join(wsDir, 'logs'),
        wsDir,  // workspace root (last — most general)
      ] : [];
      const isInAllowedDir = ALLOWED_DIRS.some(dir => fileAbs === dir || fileAbs.startsWith(dir + path.sep));
      if (!isInAllowedDir) {
        auditLog('file_api_blocked', { urlPath, path: fileAbs, reason: 'outside workspace allowlist' });
        return jsonResp(res, 403, { error: 'SECURITY: path must be inside the workspace directory. Access denied.' });
      }
    }

    // Google Workspace routes — delegate to google-routes.js
    if (urlPath.startsWith('/api/google/')) {
      return handleGoogleRoute(urlPath.slice('/api/google'.length), params, req, res, jsonResp);
    }

    // Facebook scheduled posts — delegate to fb-schedule.js
    if (urlPath.startsWith('/api/fb/schedule/')) {
      if (fbSchedule.registerRoutes(urlPath, params, jsonResp, res)) return;
    }

    // === CEO Memory API ===
    if (urlPath === '/api/memory/write') {
      if (req.method !== 'POST') return jsonResp(res, 405, { error: 'POST required' });
      const { writeMemory, VALID_TYPES } = require('./ceo-memory');
      const type = String(params.type || '').trim();
      const content = String(params.content || '').trim();
      const source = String(params.source || 'manual').trim();
      if (!type) return jsonResp(res, 400, { error: 'type required. Valid: ' + VALID_TYPES.join(', ') });
      if (!content) return jsonResp(res, 400, { error: 'content required' });
      try {
        const result = await writeMemory({ type, content, source });
        console.log('[cron-api] memory/write:', result.id, type);
        return jsonResp(res, 200, result);
      } catch (e) {
        return jsonResp(res, 400, { error: e.message });
      }
    }

    if (urlPath === '/api/memory/search') {
      if (req.method !== 'POST' && req.method !== 'GET') return jsonResp(res, 405, { error: 'POST or GET required' });
      const { searchMemory } = require('./ceo-memory');
      const query = String(params.query || '').trim();
      const limit = Math.min(Math.max(parseInt(params.limit) || 5, 1), 20);
      if (!query) return jsonResp(res, 400, { error: 'query required' });
      try {
        const results = await searchMemory(query, { limit, bumpRelevance: false });
        return jsonResp(res, 200, { results });
      } catch (e) {
        return jsonResp(res, 500, { error: e.message });
      }
    }

    if (urlPath === '/api/memory/delete') {
      if (req.method !== 'POST' && req.method !== 'DELETE') return jsonResp(res, 405, { error: 'POST or DELETE required' });
      const { deleteMemory } = require('./ceo-memory');
      const id = String(params.id || '').trim();
      if (!id) return jsonResp(res, 400, { error: 'id required' });
      try {
        const result = deleteMemory(id);
        if (result.deleted) console.log('[cron-api] memory/delete:', id);
        return jsonResp(res, 200, result);
      } catch (e) {
        return jsonResp(res, 500, { error: e.message });
      }
    }

    if (urlPath === '/api/memory/list') {
      const { listMemories } = require('./ceo-memory');
      const limit = Math.min(Math.max(parseInt(params.limit) || 100, 1), 500);
      try {
        return jsonResp(res, 200, { memories: listMemories({ limit }) });
      } catch (e) {
        return jsonResp(res, 500, { error: e.message });
      }
    }

    if (urlPath === '/api/memory/count') {
      const { getMemoryCount } = require('./ceo-memory');
      try {
        return jsonResp(res, 200, { count: getMemoryCount() });
      } catch (e) {
        return jsonResp(res, 500, { error: e.message });
      }
    }

    if (urlPath === '/api/cron/create') {
      const { label, cronExpr, oneTimeAt, groupId, groupIds, groupName, targetId: rawTargetId, friendName, isGroup, content, mode, prompt: rawPrompt } = params;
      const isAgentMode = mode === 'agent';

      if (isAgentMode) {
        // Agent mode: run a full AI agent prompt. Agent can use web_search,
        // web_fetch tools. Delivers result to CEO Telegram by default.
        // If groupId is provided, agent also sends result to Zalo group via API.
        const agentPrompt = rawPrompt || content;
        if (!agentPrompt) return jsonResp(res, 400, { error: 'prompt (or content) required for mode=agent' });
        if (String(agentPrompt).length > 2000) return jsonResp(res, 400, { error: 'prompt too long (max 2000 chars)' });
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

        // Validate Zalo target if provided. Delivery is handled server-side by
        // cron.js:deliverCronResultToZalo after the agent completes — no need to
        // inject API URLs into the prompt (which would leak internal endpoints).
        const finalPrompt = String(agentPrompt);
        const delivery = resolveCronZaloTarget({ groupId, groupIds, groupName, targetId: rawTargetId, friendName, isGroup }, { allowMultipleGroups: false });
        if (delivery?.error) return jsonResp(res, 400, { error: delivery.error });

        const id = 'cron_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
        const entry = {
          id,
          label: label || ('Agent cron ' + new Date().toISOString().slice(0, 16)),
          prompt: finalPrompt,
          mode: 'agent',
          enabled: true,
          createdAt: new Date().toISOString(),
        };
        if (delivery?.type === 'group') entry.groupId = delivery.ids[0];
        if (delivery?.type === 'user') {
          entry.targetId = delivery.ids[0];
          entry.isGroup = false;
          if (delivery.friendName) entry.friendName = delivery.friendName;
        }
        // Store Zalo target for post-agent delivery (cron.js reads this after agent runs)
        if (delivery) {
          entry.zaloTarget = { id: delivery.ids[0], isGroup: delivery.type === 'group', label: delivery.labels[0] || delivery.ids[0] };
        }
        if (cronExpr) entry.cronExpr = String(cronExpr).trim().replace(/\s+/g, ' ');
        else entry.oneTimeAt = oneTimeAt;
        try {
          return await withWriteLock(async () => {
            const crons = loadCustomCrons();
            if (crons.length >= 20) return jsonResp(res, 400, { error: 'too many crons (max 20). Delete some first.' });
            crons.push(entry);
            writeJsonAtomic(getCustomCronsPath(), crons);
            try { restartCronJobs(); } catch {}
            const targetLabel = delivery ? ' — ' + delivery.type + ': ' + (delivery.labels || delivery.ids).join(', ') : '';
            console.log('[cron-api] created agent cron:', id, label || '', targetLabel);
            try {
              sendCeoAlert('[Cron] Đã tạo (agent): ' + (label || 'no label') + ' — ' + (cronExpr || oneTimeAt) + targetLabel);
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
      const id = 'cron_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
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
          if (crons.length >= 20) return jsonResp(res, 400, { error: 'too many crons (max 20). Delete some first.' });
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

    } else if (urlPath === '/api/cron/replace') {
      try {
        const deleteIdsRaw = params.deleteIds ?? params.ids ?? params.id;
        const deleteIdsParsed = parseMaybeJsonArray(deleteIdsRaw, 'deleteIds');
        if (deleteIdsParsed?.error) return jsonResp(res, 400, { error: deleteIdsParsed.error });
        const deleteIds = [...new Set(deleteIdsParsed.map(id => String(id || '').trim()).filter(Boolean))];

        let createsParsed = parseMaybeJsonArray(params.creates ?? params.create ?? params.entries, 'creates');
        if (createsParsed?.error) return jsonResp(res, 400, { error: createsParsed.error });
        if (createsParsed.length === 0 && (params.label || params.cronExpr || params.oneTimeAt || params.content || params.prompt)) {
          createsParsed = [{
            label: params.label,
            cronExpr: params.cronExpr,
            oneTimeAt: params.oneTimeAt,
            groupId: params.groupId,
            groupIds: params.groupIds,
            groupName: params.groupName,
            targetId: params.targetId,
            friendName: params.friendName,
            isGroup: params.isGroup,
            content: params.content,
            mode: params.mode,
            prompt: params.prompt,
          }];
        }
        if (deleteIds.length === 0 && createsParsed.length === 0) {
          return jsonResp(res, 400, { error: 'deleteIds or creates required' });
        }
        if (createsParsed.length > 20) return jsonResp(res, 400, { error: 'too many creates (max 20)' });

        const built = [];
        for (let i = 0; i < createsParsed.length; i++) {
          const result = buildCronEntryForAtomicReplace(createsParsed[i], i);
          if (result.error) return jsonResp(res, 400, { error: result.error, transactional: true, changed: false });
          built.push(result);
        }

        return await withWriteLock(async () => {
          const crons = loadCustomCrons();
          const existingIds = new Set(crons.map(c => String(c?.id || '')).filter(Boolean));
          const missingIds = deleteIds.filter(id => !existingIds.has(id));
          if (missingIds.length > 0) {
            return jsonResp(res, 404, { error: 'cron not found: ' + missingIds.join(', '), transactional: true, changed: false });
          }
          const remaining = crons.filter(c => !deleteIds.includes(String(c?.id || '')));
          if (remaining.length + built.length > 20) {
            return jsonResp(res, 400, {
              error: 'too many crons after replace (max 20). Existing after delete: ' + remaining.length + ', creates: ' + built.length,
              transactional: true,
              changed: false,
            });
          }
          const entries = built.map(item => item.entry);
          const next = remaining.concat(entries);
          writeJsonAtomic(getCustomCronsPath(), next);
          try { restartCronJobs(); } catch {}
          const createdIds = entries.map(e => e.id);
          console.log('[cron-api] replace transaction:', { deleted: deleteIds, created: createdIds });
          try {
            sendCeoAlert('[Cron] Đã thay đổi atomic: xóa ' + deleteIds.length + ', tạo ' + createdIds.length + '.');
          } catch {}
          return jsonResp(res, 200, {
            success: true,
            transactional: true,
            deletedIds: deleteIds,
            createdIds,
            entries,
          });
        });
      } catch (e) {
        return jsonResp(res, 500, { error: e.message, transactional: true, changed: false });
      }

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
        /^memory\/[^\/]+\.md$/,
        /^memory\/[^\/]+\/[^\/]+\.md$/,
        /^memory\/[^\/]+\/[^\/]+\/[^\/]*\.md$/,
        /^memory\/zalo-users\/[^\/]+\.md$/,
        /^memory\/zalo-groups\/[^\/]+\.md$/,
        /^memory\/[^\/]+\.json$/,
        /^memory\/[^\/]+\/[^\/]+\.json$/,
        /^knowledge\/[^\/]+\/index\.md$/,
        /^knowledge\/[^\/]+\/[^\/]+\.md$/,
        /^knowledge\/[^\/]+\/[^\/]+$/,
        /^knowledge\/[^\/]+\/[^\/]+\/[^\/]+$/,
        /^AGENTS\.md$/,
        /^SOUL\.md$/,
        /^IDENTITY\.md$/,
        /^USER\.md$/,
        /^BOOTSTRAP\.md$/,
        /^MEMORY\.md$/,
        /^TOOLS\.md$/,
        /^COMPANY\.md$/,
        /^PRODUCTS\.md$/,
        /^schedules\.json$/,
        /^custom-crons\.json$/,
        /^zalo-blocklist\.json$/,
        /^active-persona\.json$/,
        /^active-persona\.md$/,
        /^shop-state\.json$/,
        /^logs\/cron-runs\.jsonl$/,
        /^logs\/escalation-queue\.jsonl$/,
        /^logs\/ceo-alerts-missed\.log$/,
        /^logs\/audit\.jsonl$/,
        /^skills\/[^\/]+\.md$/,
        /^skills\/[^\/]+\/[^\/]+\.md$/,
        /^skills\/[^\/]+\/[^\/]+\/[^\/]+\.md$/,
        /^prompts\/[^\/]+\.md$/,
        /^prompts\/[^\/]+\/[^\/]+\.md$/,
        /^tools\/[^\/]+\.md$/,
        /^tools\/[^\/]+\/[^\/]+\.md$/,
        /^docs\/[^\/]+\.md$/,
        /^docs\/[^\/]+\/[^\/]+\.md$/,
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

    // ============================================================
    //  PROTECTED CUSTOMER MEMORY WRITE ENDPOINT
    //  Guardrails:
    //  1. senderId must be numeric Zalo ID (sanitized)
    //  2. Only writes to memory/zalo-users/<senderId>.md (no other paths)
    //  3. Append-only — never overwrites existing content
    //  4. Max 2000 bytes per write
    //  5. Audit log entry on every write
    //  6. CEO Telegram notification (non-blocking)
    // ============================================================
    } else if (urlPath === '/api/customer-memory/write') {
      const ws = getWorkspace();
      if (!ws) return jsonResp(res, 500, { error: 'workspace not found' });
      const senderId = sanitizeZaloUserId(params.senderId);
      const content = String(params.content || '').trim();
      if (!senderId) return jsonResp(res, 400, { error: 'invalid senderId' });
      if (!content) return jsonResp(res, 400, { error: 'content required' });
      const byteLen = Buffer.byteLength(content, 'utf-8');
      if (byteLen > 2000) return jsonResp(res, 400, { error: 'content too large (max 2000 bytes)' });

      const { withMemoryFileLock } = require('./conversation');
      const { auditLog } = require('./workspace');
      const { sendMemoryWriteAlert } = require('./channels');
      const usersDir = path.join(ws, 'memory', 'zalo-users');
      const filePath = path.join(usersDir, senderId + '.md');

      try {
        await withMemoryFileLock(filePath, () => {
          fs.appendFileSync(filePath, '\n' + content, 'utf-8');
        }, { senderId, action: 'append-via-api', source: 'workspace-api' });

        // Audit log
        auditLog('customer-memory-write', {
          senderId,
          action: 'append-via-api',
          file: senderId + '.md',
          source: 'workspace-api',
          size: (() => { try { return fs.statSync(filePath).size; } catch { return 0; } })(),
        });

        // CEO notification (non-blocking — don't block the API response)
        sendMemoryWriteAlert({
          senderId,
          action: 'append-via-api',
          details: { file: senderId + '.md', source: 'workspace-api' },
        }).catch(() => {});

        return jsonResp(res, 200, { success: true, senderId, bytes: byteLen });
      } catch (e) {
        return jsonResp(res, 500, { error: e.message });
      }

    // ============================================================
    //  CEO RULE WRITING ENDPOINT
    //  CEO sends rule via Telegram → bot calls this endpoint
    //  System classifies the rule type → routes to correct append-only file
    //
    //  Routing table:
    //  - sales/vip/discount/shipping/pricing/policy/upsell → knowledge/sales-playbook.md
    //  - script/template/reply example/mẫu câu → knowledge/scripts/<slug>.md
    //  - sai/nhầm/lỗi/không đúng → .learnings/ERRORS.md
    //  - lesson/học được/remember/nhớ → .learnings/LEARNINGS.md
    //  - khách.*/customer.* + tên/id cụ thể → memory/zalo-users/<id>.md
    //  - default → knowledge/sales-playbook.md
    //
    //  Guardrails:
    //  1. Requires Bearer token (CEO-only via Telegram)
    //  2. Append-only — never overwrites existing content
    //  3. Sanitizes content before writing
    //  4. Max 4000 bytes per rule
    //  5. CEO Telegram notification with target file confirmation
    // ============================================================
    } else if (urlPath === '/api/ceo-rules/write') {
      const ws = getWorkspace();
      if (!ws) return jsonResp(res, 500, { error: 'workspace not found' });
      const content = String(params.content || '').trim();
      if (!content) return jsonResp(res, 400, { error: 'content required' });
      if (Buffer.byteLength(content, 'utf-8') > 4000) {
        return jsonResp(res, 400, { error: 'content too large (max 4000 bytes)' });
      }

      // Diacritics are enforced at the AGENTS.md / skill level.
      // The bot reads these rules and applies them naturally.

      // Classify rule type from content keywords
      const lc = content.toLowerCase();
      let destFile;
      if (/khách[hn]|customer|người mua|anh.*muốn.*lưu/i.test(lc) && /(\d{15,19})/.test(content)) {
        destFile = null; // needs customer ID — handled below
      } else if (/sai|nhầm|lỗi|sai rồi|không đúng|bot.*làm sai|bot.*nhầm|đáng lẽ/i.test(lc)) {
        destFile = '.learnings/ERRORS.md';
      } else if (/học được|nhớ|memorize|remember|lesson|tự động|bây giờ.*phải|nên.*phải|mỗi khi/i.test(lc)) {
        destFile = '.learnings/LEARNINGS.md';
      } else if (/script|mẫu câu|reply template|ví dụ.*trả lời|trả lời.*mẫu|template.*câu/i.test(lc)) {
        // Extract a slug from content for the script filename
        const slug = content.replace(/[^a-z0-9áàảãạăâặằắẳẵâầấẩẫậéèẻẽẹêềếểễệíìỉĩịóòỏõọôồốổỗộơờớởỡợúùủũụưừứửữựýỳỷỹỵ\s]/gi, '-').replace(/-+/g, '-').slice(0, 50).toLowerCase();
        destFile = `knowledge/scripts/${slug}.md`;
      } else {
        // Default: sales/business rules → sales playbook
        destFile = 'knowledge/sales-playbook.md';
      }

      // If customer-specific rule, require senderId param
      if (!destFile) {
        const senderId = sanitizeZaloUserId(params.senderId);
        if (!senderId) return jsonResp(res, 400, { error: 'senderId required for customer-specific rules' });
        destFile = `memory/zalo-users/${senderId}.md`;
      }

      const destPath = path.join(ws, destFile);
      const destDir = path.dirname(destPath);

      try {
        // Append-only: read existing, check for duplicate, append
        let existingContent = '';
        if (fs.existsSync(destPath)) {
          existingContent = fs.readFileSync(destPath, 'utf-8');
        }

        // Sanitize: remove prompt injection patterns
        const safeContent = content
          .replace(/^(SYSTEM|ASSISTANT|HUMAN|USER|INSTRUCTION|PROMPT|RULE|BẮT BUỘC)\s*:/gim, '[CEO]: ')
          .replace(/(?:127\.0\.0\.1|localhost|0\.0\.0\.0):\d{4,5}/g, '[local-api]')
          .replace(/(?:api[_-]?(?:key|token|secret)|password)\s*[:=]\s*\S+/gi, '[credential-removed]');

        const ts = new Date().toISOString().slice(0, 10);
        const appendEntry = `\n\n---\n**CEO rule · ${ts}**\n\n${safeContent}\n`;

        // Idempotency: skip if same content already appended today
        if (existingContent.includes(safeContent.slice(0, 100))) {
          return jsonResp(res, 200, {
            success: true,
            action: 'skipped-duplicate',
            file: destFile,
            message: 'Rule đã tồn tại, không ghi trùng.',
          });
        }

        fs.mkdirSync(destDir, { recursive: true });
        fs.appendFileSync(destPath, appendEntry, 'utf-8');
        const sizeAfter = fs.statSync(destPath).size;

        console.log(`[ceo-rules] appended rule to ${destFile} (${safeContent.length} chars)`);

        // Audit log
        const auditPath = path.join(ws, 'logs', 'ceo-rules-writes.jsonl');
        fs.mkdirSync(path.dirname(auditPath), { recursive: true });
        fs.appendFileSync(auditPath, JSON.stringify({
          t: new Date().toISOString(),
          file: destFile,
          chars: safeContent.length,
          sizeAfter,
        }) + '\n', 'utf-8');

        // CEO notification via Telegram (non-blocking)
        const shortContent = safeContent.slice(0, 120) + (safeContent.length > 120 ? '...' : '');
        sendCeoAlert(
          `✅ Đã lưu rule vào *${destFile}*\n\n"${shortContent}"`,
        ).catch(() => {});

        return jsonResp(res, 200, { success: true, file: destFile, chars: safeContent.length });
      } catch (e) {
        return jsonResp(res, 500, { error: e.message });
      }

    } else if (urlPath === '/api/workspace/list') {
      const ws = getWorkspace();
      if (!ws) return jsonResp(res, 500, { error: 'workspace not found' });
      const dir = String(params.dir || '').replace(/\\/g, '/');
      const DIRS_ALLOWED = [
        /^$/,
        /^\/?$/,
        /^\.?learnings\/?$/,
        /^memory\/?$/,
        /^memory\/zalo-users\/?$/,
        /^memory\/zalo-groups\/?$/,
        /^knowledge\/[^\/]+\/?$/,
        /^knowledge\/[^\/]+\/files\/?$/,
        /^skills\/?$/,
        /^skills\/[^\/]+\/?$/,
        /^skills\/[^\/]+\/[^\/]+\/?$/,
        /^prompts\/?$/,
        /^prompts\/[^\/]+\/?$/,
        /^tools\/?$/,
        /^tools\/[^\/]+\/?$/,
        /^docs\/?$/,
        /^docs\/[^\/]+\/?$/,
      ];
      if (!dir || dir.includes('..') || !DIRS_ALLOWED.some(r => r.test(dir))) {
        return jsonResp(res, 403, { error: 'dir not in whitelist. Allowed: root, .learnings/, memory/, memory/zalo-users/, memory/zalo-groups/, knowledge/*/, skills/*/, prompts/*/, tools/*/, docs/*/' });
      }
      try {
        const fullDir = path.join(ws, dir);
        if (!fs.existsSync(fullDir)) return jsonResp(res, 200, { dir, files: [] });
        // Root dir: show all non-hidden files of all types. Sub-dirs: .md/.json only.
        const isRoot = !dir || dir === '/' || dir === '';
        const files = fs.readdirSync(fullDir).filter(f => {
          if (f.startsWith('.')) return false;
          if (f === 'node_modules' || f === 'backups' || f === 'vendor' || f === 'logs') return false;
          if (isRoot) return true;
          return f.endsWith('.md') || f.endsWith('.json');
        });
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
      // Auto-detect group vs user from cache — avoids "user-not-in-cache" when passing
      // a bare groupId as targetId (resolveZaloIsGroup returns false for bare targetId).
      const { byId: groupsById } = loadGroupsMap();
      let isGroup = !!groupsById[String(tId)];
      if (!isGroup) {
        // Fall back to explicit params if not found in groups cache
        isGroup = resolveZaloIsGroup({ groupId, groupName, friendName, isGroupParam });
        if (!isGroup) {
          // Double-check: if targetId looks like a known friend, force user mode
          const friends = loadFriendsList();
          const isFriend = friends.some(f => String(f.userId || f.uid || f.id || f.userKey || '') === String(tId));
          if (isFriend) isGroup = false;
        }
      }
      if (isGroup && !groupsById[String(tId)]) {
        return jsonResp(res, 400, { error: 'unknown groupId: ' + tId + '. Check /api/cron/list for available groups.' });
      }
      try {
        const result = await sendZaloTo({ id: String(tId), isGroup }, String(text), { skipFilter: false });
        if (result && result.ok) {
          console.log(`[cron-api] /api/zalo/send OK → ${isGroup ? 'group' : 'user'} ${tId}`);
          return jsonResp(res, 200, { success: true, targetId: String(tId), isGroup });
        } else {
          return jsonResp(res, 500, { success: false, error: (result && result.error) ? result.error : 'sendZaloTo failed' });
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
      // Auto-detect group vs user from cache (same logic as /api/zalo/send).
      const { byId: groupsById } = loadGroupsMap();
      let isGroup = !!groupsById[String(tId)];
      if (!isGroup) {
        isGroup = resolveZaloIsGroup({ groupId, groupName, friendName, isGroupParam });
        if (!isGroup) {
          const friends = loadFriendsList();
          const isFriend = friends.some(f => String(f.userId || f.uid || f.id || f.userKey || '') === String(tId));
          if (isFriend) isGroup = false;
        }
      }
      if (isGroup && !groupsById[String(tId)]) {
        return jsonResp(res, 400, { error: 'unknown groupId: ' + tId + '. Check /api/cron/list for available groups.' });
      }
      let absPath = '';
      let asset = null;
      if (!mediaId) {
        return jsonResp(res, 400, { error: 'send-media requires mediaId from Media Library. Raw filePath/imagePath is blocked.' });
      }
      asset = mediaLibrary.findMediaAsset(String(mediaId));
      if (!asset) return jsonResp(res, 404, { error: 'media asset not found' });
      const allowInternalGenerated = ['true', '1', 'yes'].includes(String(params.allowInternalGenerated || params.allowInternal || '').toLowerCase());
      if (asset.visibility !== 'public' && !(allowInternalGenerated && asset.type === 'generated' && asset.visibility === 'internal')) {
        return jsonResp(res, 403, { error: 'media asset is not public' });
      }
      absPath = asset.path;
      try {
        const result = await sendZaloMediaTo({ id: String(tId), isGroup }, absPath, { caption: caption || asset?.title || '' });
        if (result.ok) {
          console.log(`[cron-api] /api/zalo/send-media OK → ${isGroup ? 'group' : 'user'} ${tId}`);
          return jsonResp(res, 200, { success: true, targetId: String(tId), isGroup, mediaId: asset?.id || null, mode: result.mode || null });
        }
        return jsonResp(res, 500, { success: false, error: result.error || 'sendZaloMediaTo failed' });
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
      const urlHost = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
      const BLOCKED_HOSTS = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.|localhost|::1|\[::)/i;
      if (BLOCKED_HOSTS.test(urlHost)) {
        auditLog('file_download_blocked', { url, reason: 'internal/private IP' });
        return jsonResp(res, 403, { error: 'SECURITY: downloads from internal/private IPs are blocked' });
      }
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
      // Allowlist: only permit commands starting with known-safe prefixes.
      // The agent only needs these specific tools — everything else is blocked.
      const cmdTrimmed = cmd.trimStart();
      const ALLOWED_PREFIXES = [
        'openzca', 'openclaw', 'git', 'npm',
        'dir', 'ls', 'cat', 'type', 'echo', 'whoami',
      ];
      const firstToken = cmdTrimmed.split(/[\s\/\\]/)[0].toLowerCase();
      if (!ALLOWED_PREFIXES.includes(firstToken)) {
        auditLog('exec_blocked', { command: cmd.slice(0, 200), reason: 'command not in allowlist', firstToken });
        return jsonResp(res, 403, { error: 'SECURITY: command blocked. Only these commands are allowed: ' + ALLOWED_PREFIXES.join(', ') + '. Got: "' + firstToken + '"' });
      }
      // Block shell metacharacters that enable command chaining/injection.
      // Includes \n \r (command separators in both cmd.exe and /bin/sh)
      // and ^ (cmd.exe escape character that can unblock & | etc.)
      const SHELL_META = /[;|&`$(){}!<>\n\r^]/;
      if (SHELL_META.test(cmdTrimmed)) {
        auditLog('exec_blocked', { command: cmd.slice(0, 200), reason: 'shell metacharacter detected' });
        return jsonResp(res, 403, { error: 'SECURITY: command contains blocked shell metacharacters.' });
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

    // ─── Image Preferences API ─────────────────────────────────
    } else if (urlPath === '/api/image/preferences') {
      const prefsPath = path.join(getWorkspace(), 'image-preferences.json');
      if (req.method === 'POST') {
        try {
          const { style, colorTone, composition, lighting, text, custom } = params;
          const prefs = { style, colorTone, composition, lighting, text, custom: custom || {}, updatedAt: new Date().toISOString() };
          writeJsonAtomic(prefsPath, prefs);
          return jsonResp(res, 200, { ok: true, preferences: prefs });
        } catch (e) { return jsonResp(res, 500, { error: e.message }); }
      } else {
        try {
          if (!fs.existsSync(prefsPath)) return jsonResp(res, 200, { preferences: null });
          const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
          return jsonResp(res, 200, { preferences: prefs });
        } catch (e) { return jsonResp(res, 200, { preferences: null }); }
      }

    // ─── Image Generation API ────────────────────────────────────
    } else if (urlPath === '/api/media/list') {
      try {
        mediaLibrary.backfillLegacyBrandAssets();
        const files = mediaLibrary.listMediaAssets({
          type: params.type || undefined,
          visibility: params.visibility || undefined,
          audience: params.audience || 'customer',
        }).map(sanitizeMediaAssetForApi);
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
        }).map(sanitizeMediaAssetForApi);
        return jsonResp(res, 200, { query: q, results });
      } catch (e) { return jsonResp(res, 500, { error: e.message }); }

    } else if (urlPath === '/api/media/upload') {
      if (req.method !== 'POST') return jsonResp(res, 405, { error: 'POST only' });
      try {
        const src = String(params.filePath || params.path || '').trim();
        if (!src) return jsonResp(res, 400, { error: 'filePath required' });
        const ws = getWorkspace();
        const absSrc = path.resolve(src);
        if (!ws || !absSrc.startsWith(ws + path.sep)) {
          return jsonResp(res, 403, { error: 'SECURITY: filePath must be inside the workspace directory.' });
        }
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
        return jsonResp(res, 200, { success: true, asset: sanitizeMediaAssetForApi(asset), describing: shouldDescribe });
      } catch (e) { return jsonResp(res, 500, { success: false, error: e.message }); }

    } else if (urlPath === '/api/media/describe') {
      if (req.method !== 'POST') return jsonResp(res, 405, { error: 'POST only' });
      try {
        const id = String(params.id || params.mediaId || '').trim();
        if (!id) return jsonResp(res, 400, { error: 'id required' });
        const asset = await mediaLibrary.describeMediaAsset(id);
        return jsonResp(res, 200, { success: true, asset: sanitizeMediaAssetForApi(asset) });
      } catch (e) { return jsonResp(res, 500, { success: false, error: e.message }); }

    } else if (urlPath === '/api/image/generate-and-send-zalo') {
      // FIX: This endpoint was returning success immediately after starting the async job,
      // causing the agent to report "Ảnh đã tạo xong" BEFORE Zalo delivery happened.
      // Now fully blocks until both image generation AND Zalo delivery are done.
      // The response tells the agent the truthful status so it can report to CEO accurately.
      const { prompt, assets, size, caption, groupId, groupName, targetId, friendName, isGroup } = params;
      if (!prompt) return jsonResp(res, 400, { error: 'prompt required' });
      const promptZStr = String(prompt);
      if (promptZStr.length > 5000) return jsonResp(res, 400, { error: 'prompt too long (max 5000)' });
      if (promptZStr.length < 150) return jsonResp(res, 400, { error: `prompt too short (${promptZStr.length} chars, min 150). Write a detailed prompt with subject, scene, lighting, colors, composition, and style.` });
      const delivery = resolveCronZaloTarget({ groupId, groupName, targetId, friendName, isGroup }, { allowMultipleGroups: false });
      if (!delivery) return jsonResp(res, 400, { error: 'groupId, groupName, targetId, hoặc friendName cần được cung cấp để gửi Zalo. Nếu đã cung cấp groupId nhưng bị lỗi — thử dùng groupName thay vì groupId.' });
      if (delivery.error) return jsonResp(res, 400, { error: delivery.error });

      const imageGen = require('./image-gen');
      const jobId = imageGen.generateJobId();
      const brandDir = getBrandAssetsDir();
      const assetList = Array.isArray(assets) ? assets : (assets ? String(assets).split(',').map(s => s.trim()).filter(Boolean) : []);
      const deliveryTarget = { id: delivery.ids[0], isGroup: delivery.type === 'group' };
      const deliveryLabel = delivery.labels?.[0] || delivery.ids[0];

      const jobDone = new Promise((resolveJob) => {
        imageGen.startJob(jobId, String(prompt), brandDir, assetList, imageGen.normalizeImageSize(size), async (err, imgPath) => {
          if (err) {
            resolveJob({ status: 'gen_failed', error: err.message });
            return;
          }
          if (!imgPath) {
            resolveJob({ status: 'gen_failed', error: 'no image path returned' });
            return;
          }
          try {
            const result = await sendZaloMediaTo(deliveryTarget, imgPath, { caption: caption || '' });
            resolveJob({
              status: 'done',
              imagePath: imgPath,
              zaloDelivered: result.ok,
              zaloError: result.error || null,
            });
          } catch (e) {
            resolveJob({
              status: 'done',
              imagePath: imgPath,
              zaloDelivered: false,
              zaloError: String(e?.message || e).slice(0, 300),
            });
          }
        });
      });

      const timeout = new Promise(r => setTimeout(() => r({ status: 'timeout' }), 14 * 60 * 1000));
      const result = await Promise.race([jobDone, timeout]);

      if (result.status === 'gen_failed') {
        sendCeoAlert('[Tạo ảnh/Zalo] Thất bại: ' + result.error).catch(() => {});
        return jsonResp(res, 502, { success: false, jobId, status: 'gen_failed', error: result.error });
      }
      if (result.status === 'timeout') {
        sendCeoAlert('[Tạo ảnh/Zalo] Quá thời gian chờ (14 phút). Thử lại với ảnh đơn giản hơn.').catch(() => {});
        return jsonResp(res, 504, { success: false, jobId, status: 'timeout', error: 'image generation timed out after 14 minutes' });
      }

      // Both image and Zalo delivery done — return truthful status
      console.log(`[image-gen] generate-and-send-zalo: gen=ok zalo=${result.zaloDelivered ? 'OK' : 'FAILED'}`);
      const status = result.zaloDelivered
        ? 'done_and_delivered'
        : 'done_not_delivered';

      if (result.zaloDelivered) {
        sendCeoAlert(`[Tạo ảnh/Zalo] Đã tạo ảnh và gửi vào ${delivery.type === 'group' ? 'nhóm' : 'Zalo cá nhân'} "${deliveryLabel}".`).catch(() => {});
      } else {
        sendCeoAlert(`[Tạo ảnh/Zalo] Ảnh tạo xong nhưng gửi vào "${deliveryLabel}" thất bại. jobId: ${jobId}. Lỗi: ${result.zaloError || 'unknown'}`).catch(() => {});
      }

      return jsonResp(res, 200, {
        success: true,
        jobId,
        status,
        imagePath: result.imagePath ? path.relative(getWorkspace(), result.imagePath) : undefined,
        zaloDelivered: result.zaloDelivered,
        zaloError: result.zaloError || null,
        delivery: {
          targetId: delivery.ids[0],
          isGroup: delivery.type === 'group',
          label: deliveryLabel,
        },
      });

    } else if (urlPath === '/api/image/generate') {
      const { prompt, assets, size, targetId, isGroup, caption, autoSendTelegram } = params;
      console.log(`[cron-api] /api/image/generate — assets param: ${JSON.stringify(assets)}, size: ${size}, autoSendTelegram: ${autoSendTelegram}`);
      if (!prompt) return jsonResp(res, 400, { error: 'prompt required' });
      const promptStr = String(prompt);
      if (promptStr.length > 5000) return jsonResp(res, 400, { error: 'prompt too long (max 5000)' });
      if (promptStr.length < 150) return jsonResp(res, 400, { error: `prompt too short (${promptStr.length} chars, min 150). Write a detailed prompt with subject, scene, lighting, colors, composition, and style. Short prompts produce bad images.` });
      const imageGen = require('./image-gen');
      const jobId = imageGen.generateJobId();
      const brandDir = getBrandAssetsDir();
      console.log(`[cron-api] brandDir=${brandDir}, exists=${fs.existsSync(brandDir)}`);
      const assetList = Array.isArray(assets) ? assets : (assets ? String(assets).split(',').map(s => s.trim()).filter(Boolean) : []);
      console.log(`[cron-api] parsed assetList: ${JSON.stringify(assetList)}`);
      const hasZaloTarget = !!targetId;
      const zaloTarget = hasZaloTarget ? { id: String(targetId), isGroup: isGroup === true || isGroup === 'true' } : null;
      let earlyFailureHandled = false;

      // If zaloTarget is set, we must wait for the image to finish and attempt delivery
      // within this request — so the cron-agent gets a truthful delivery status.
      if (zaloTarget) {
        const jobDone = new Promise((resolveJob) => {
          imageGen.startJob(jobId, String(prompt), brandDir, assetList, imageGen.normalizeImageSize(size), async (err, imgPath) => {
            if (err) {
              resolveJob({ status: 'failed', error: err.message });
              return;
            }
            if (!imgPath) { resolveJob({ status: 'failed', error: 'no image path' }); return; }
            try {
              const result = await sendZaloMediaTo(zaloTarget, imgPath, { caption: caption || '' });
              resolveJob({
                status: result.ok ? 'done' : 'failed',
                imagePath: imgPath,
                deliveryOk: result.ok,
                deliveryError: result.error || null,
              });
            } catch (e) {
              resolveJob({ status: 'failed', imagePath: imgPath, deliveryError: String(e?.message || e).slice(0, 200) });
            }
          });
        });

        const timeout = new Promise(resolve => setTimeout(() => resolve({ status: 'timeout' }), 14 * 60 * 1000));
        const result = await Promise.race([jobDone, timeout]);

        if (result.status === 'failed') {
          earlyFailureHandled = true;
          sendCeoAlert('[Tạo ảnh/Zalo] Thất bại: ' + (result.error || result.deliveryError || 'lỗi không rõ')).catch(() => {});
          return jsonResp(res, 502, { jobId, status: 'failed', error: result.error || result.deliveryError || 'image generation or Zalo delivery failed' });
        }
        if (result.status === 'timeout') {
          earlyFailureHandled = true;
          return jsonResp(res, 504, { jobId, status: 'timeout', error: 'image generation timed out after 14 minutes' });
        }
        // Image generated and delivered (or delivery failed but image is done)
        console.log(`[image-gen] zalo delivery result: ${result.deliveryOk ? 'OK' : 'FAILED'} for job ${jobId}`);
        if (result.deliveryOk) {
          sendCeoAlert('[Tạo ảnh/Zalo] Đã tạo ảnh và gửi vào nhóm Zalo thành công.').catch(() => {});
        } else {
          sendCeoAlert('[Tạo ảnh/Zalo] Ảnh đã tạo xong nhưng gửi vào nhóm Zalo thất bại. jobId: ' + jobId + (result.deliveryError ? ' — ' + result.deliveryError : '')).catch(() => {});
        }
        return jsonResp(res, 200, {
          jobId,
          status: result.deliveryOk ? 'done_and_delivered' : 'done_not_delivered',
          imagePath: result.imagePath ? path.relative(getWorkspace(), result.imagePath) : undefined,
          zaloTarget: { targetId: zaloTarget.id, isGroup: zaloTarget.isGroup },
          deliveryOk: !!result.deliveryOk,
          deliveryError: result.deliveryError || null,
        });
      }

      // No zaloTarget: non-blocking, generate and hand back to caller.
      // Auto-send to Telegram by DEFAULT — CEO always wants to see the result.
      // Pass autoSendTelegram=false to suppress (e.g. if caller handles delivery).
      const shouldAutoSend = autoSendTelegram !== false && autoSendTelegram !== 'false';
      let startErr = null;
      try {
        imageGen.startJob(jobId, String(prompt), brandDir, assetList, imageGen.normalizeImageSize(size), (err, imgPath) => {
          if (shouldAutoSend && !err && imgPath) {
            sendTelegramPhoto(imgPath, '').then(ok => {
              console.log(`[image-gen] auto-send Telegram: ${ok ? 'OK' : 'FAILED'} for ${jobId}`);
              if (!ok) sendCeoAlert(`[Tạo ảnh] Ảnh tạo xong nhưng gửi Telegram thất bại. jobId: ${jobId}`).catch(() => {});
            }).catch(() => {});
          } else if (shouldAutoSend && err) {
            sendCeoAlert(`[Tạo ảnh] Thất bại: ${err.message}`).catch(() => {});
          }
        });
      } catch (e) {
        startErr = e;
      }
      if (startErr) {
        console.error('[image-gen] startJob failed:', startErr.message);
        return jsonResp(res, 502, { jobId, status: 'failed', error: startErr.message });
      }
      const earlyStatus = await imageGen.waitForJobResult(jobId, 3000);
      if (earlyStatus.status === 'failed') {
        earlyFailureHandled = true;
        return jsonResp(res, 502, { jobId, status: 'failed', error: earlyStatus.error || 'image generation failed' });
      }
      return jsonResp(res, 200, {
        jobId,
        status: earlyStatus.status || 'generating',
        imagePath: earlyStatus.imagePath ? path.relative(getWorkspace(), earlyStatus.imagePath) : undefined,
        mediaId: earlyStatus.mediaId || null,
        zaloTarget: zaloTarget ? { targetId: zaloTarget.id, isGroup: zaloTarget.isGroup } : null,
      });

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
      const { message: fbMessage, imagePath: relImgPath, approvalNonce } = params;
      if (!fbMessage) return jsonResp(res, 400, { error: 'message required' });
      if (String(fbMessage).length > 63206) return jsonResp(res, 400, { error: 'message too long (max 63206 chars)' });
      const cfg = readFbConfig();
      if (!cfg || !cfg.accessToken) return jsonResp(res, 400, { error: 'Facebook chưa kết nối. Paste token vào Dashboard.' });
      const fbPub = require('./fb-publisher');
      try {
        cleanupFbPostApprovals();
        const normalizedImagePath = relImgPath ? String(relImgPath) : '';
        let absImg = '';
        if (normalizedImagePath) {
          const ws = getWorkspace();
          absImg = path.resolve(ws, normalizedImagePath);
          if (!absImg.startsWith(ws + path.sep)) return jsonResp(res, 400, { error: 'invalid imagePath' });
          if (!fs.existsSync(absImg)) return jsonResp(res, 400, { error: 'image not found' });
        }
        const fingerprint = JSON.stringify({
          pageId: cfg.pageId || '',
          message: String(fbMessage),
          imagePath: normalizedImagePath,
        });
        const isPreview = params.preview === 'true' || params.preview === '1' || params.dryRun === 'true' || params.dryRun === '1';
        if (isPreview) {
          cleanupFbPostApprovals();
          const nonce = crypto.randomBytes(18).toString('hex');
          const expiresAt = Date.now() + 10 * 60 * 1000;
          _fbPostApprovals.set(nonce, { fingerprint, expiresAt });
          return jsonResp(res, 200, {
            success: true,
            preview: true,
            approvalNonce: nonce,
            expiresAt: new Date(expiresAt).toISOString(),
            pageId: cfg.pageId,
            pageName: cfg.pageName,
            hasImage: !!normalizedImagePath,
          });
        }
        const approval = approvalNonce ? _fbPostApprovals.get(String(approvalNonce)) : null;
        if (!approval || approval.expiresAt <= Date.now() || approval.fingerprint !== fingerprint) {
          return jsonResp(res, 403, { error: 'Facebook post requires a fresh approvalNonce from /api/fb/post?preview=1 with the exact same message and imagePath.' });
        }
        _fbPostApprovals.delete(String(approvalNonce));
        let result;
        if (normalizedImagePath) {
          const imgBuf = fs.readFileSync(absImg);
          result = await fbPub.postPhoto(cfg.pageId, cfg.accessToken, String(fbMessage), imgBuf, absImg);
        } else {
          result = await fbPub.postText(cfg.pageId, cfg.accessToken, String(fbMessage));
        }
        return jsonResp(res, 200, result);
      } catch (e) {
        if (e._isTokenExpired || e._httpStatus === 401 || /OAuthException|Invalid OAuth|expired|invalid.token|session.*invalid/i.test(e.message)) {
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

    } else if (urlPath === '/api/fb/verify') {
      const cfg = readFbConfig();
      if (!cfg || !cfg.accessToken) return jsonResp(res, 200, { valid: false, error: 'Facebook chưa kết nối. Paste token vào Dashboard.' });
      try {
        const fbPub = require('./fb-publisher');
        const result = await fbPub.verifyToken(cfg.accessToken);
        return jsonResp(res, 200, result);
      } catch (e) { return jsonResp(res, 500, { valid: false, error: e.message }); }

    } else if (urlPath === '/api/zalo/ready') {
      try {
        const result = await probeZaloReady();
        return jsonResp(res, 200, result);
      } catch (e) { return jsonResp(res, 200, { ready: false, error: e.message }); }

    // ─── Internal: agent-mode cron delivers Zalo (token required) ──────
    } else if (urlPath === '/api/internal/agent-deliver-zalo') {
      const { text, targetId, isGroup, mediaId, caption } = params;
      const tId = targetId;
      if (!tId) return jsonResp(res, 400, { error: 'targetId required' });
      try {
        let ok;
        if (mediaId) {
          const mediaLibrary = require('./media-library');
          const asset = mediaLibrary.findMediaAsset(String(mediaId));
          if (!asset) return jsonResp(res, 404, { error: 'media asset not found' });
          if (asset.visibility === 'private') {
            auditLog('agent_deliver_zalo_blocked', { mediaId, reason: 'private asset' });
            return jsonResp(res, 403, { error: 'SECURITY: cannot deliver private media asset via Zalo.' });
          }
          auditLog('agent_deliver_zalo', { targetId: tId, isGroup: !!isGroup, mediaId, hasCaption: !!caption });
          const absPath = asset.path;
          if (!fs.existsSync(absPath)) return jsonResp(res, 400, { error: 'media file not found on disk' });
          const isGrp = isGroup === true || isGroup === 'true';
          ok = await sendZaloMediaTo({ id: String(tId), isGroup: isGrp }, absPath, { caption: caption || '' });
        } else {
          if (!text) return jsonResp(res, 400, { error: 'text required when no mediaId' });
          auditLog('agent_deliver_zalo', { targetId: tId, isGroup: !!isGroup, hasText: true });
          const isGrp = isGroup === true || isGroup === 'true';
          ok = await sendZaloTo({ id: String(tId), isGroup: isGrp }, String(text), { skipFilter: false });
        }
        if (ok && ok.ok) {
          console.log(`[cron-api] /api/internal/agent-deliver-zalo OK → ${isGroup ? 'group' : 'user'} ${tId}`);
          return jsonResp(res, 200, { success: true });
        } else {
          return jsonResp(res, 500, { success: false, error: ok && ok.error ? ok.error : 'send failed — check listener, target validity, or pause state' });
        }
      } catch (e) {
        return jsonResp(res, 500, { error: String(e?.message || e).slice(0, 300) });
      }

    } else {
      return jsonResp(res, 404, { error: 'not found', endpoints: ['/api/cron/create', '/api/cron/replace', '/api/cron/list', '/api/cron/delete', '/api/cron/toggle', '/api/zalo/send', '/api/zalo/send-media', '/api/knowledge/add', '/api/workspace/read', '/api/workspace/append', '/api/workspace/list', '/api/customer-memory/write', '/api/ceo-rules/write', '/api/file/read', '/api/file/write', '/api/file/list', '/api/file/search', '/api/file/open', '/api/file/rename', '/api/file/copy', '/api/file/delete', '/api/file/download', '/api/system/info', '/api/exec', '/api/brand-assets/list', '/api/brand-assets/save', '/api/media/list', '/api/media/search', '/api/media/upload', '/api/media/describe', '/api/image/generate', '/api/image/generate-and-send-zalo', '/api/image/status', '/api/telegram/send-photo', '/api/fb/post', '/api/fb/recent'] });
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
