'use strict';
const fs = require('fs');
const path = require('path');

const SHARED_COMMAND_PATTERNS = [
  /(?:t[aạ]o|th[eê]m|s[uử]a|x[oó]a|b[aậ]t|t[aắ]t)\s*(?:cron|l[iị]ch|h[eẹ]n)/i,
  /(?:broadcast|ph[aá]t)\s*(?:tin|nh[aắ]n|s[oó]ng)/i,
  /(?:exec|ch[aạ]y|run)\s*(?:l[eệ]nh|command|script)/i,
  /openzca\s+msg\s+send/i,
  /127\.0\.0\.1:20200/i,
  /\/api\/cron\//i,
  /(?:openclaw|modoro)\s+(?:config|cron|plugin)/i,
  /(?:restart|kh[oở]i\s*[đd][oộ]ng\s*l[aạ]i)\s*(?:gateway|bot|server)/i,
];

const REWRITE_TEXT = '[nội dung nội bộ đã được lọc]';

const CHANNEL_DEFENSE = {};

const _dedupMap = new Map();

function _pruneDedup(maxEntries) {
  if (_dedupMap.size <= maxEntries) return;
  const now = Date.now();
  for (const [k, v] of _dedupMap) {
    if (now - v > 60000) _dedupMap.delete(k);
  }
  if (_dedupMap.size > maxEntries) {
    const keys = [..._dedupMap.keys()];
    for (let i = 0; i < keys.length - maxEntries; i++) _dedupMap.delete(keys[i]);
  }
}

const BOT_PREFIXES = ['[bot]', '[tự động]', '[auto]', 'thông báo:', 'hệ thống:'];
const BOT_TEMPLATE_RE = /^(?:[A-Z][a-zà-ỹ]+:\s*.+\s*\|\s*){2,}/;

function _isBotLikeMessage(body) {
  const lower = body.toLowerCase().trim();
  if (BOT_PREFIXES.some(p => lower.startsWith(p))) return true;
  if (BOT_TEMPLATE_RE.test(body)) return true;
  if (!/(?:tôi|tao|mình|em|anh|chị)/i.test(body) && body.length > 100) return true;
  return false;
}

function runInboundDefense(channelId, msg) {
  const config = CHANNEL_DEFENSE[channelId];
  if (!config) return { action: 'pass' };
  const body = msg.body || msg.text || msg.rawBody || '';
  const senderId = msg.senderId || msg.from || '';
  if (config.systemMsgDetector && config.systemMsgDetector(msg)) {
    return { action: 'drop', reason: 'system-message' };
  }
  if (config.allowlistFile) {
    try {
      const { getWorkspace } = require('./workspace');
      const ws = getWorkspace();
      const alPath = path.join(ws, config.allowlistFile);
      if (fs.existsSync(alPath)) {
        const list = JSON.parse(fs.readFileSync(alPath, 'utf-8'));
        if (Array.isArray(list) && !list.includes('*')) {
          if (list.length === 0 || list.includes('__NONE__')) {
            return { action: 'drop', reason: 'allowlist-empty' };
          }
          if (!list.includes(senderId)) {
            return { action: 'drop', reason: 'not-in-allowlist' };
          }
        }
      }
    } catch {}
  }
  if (config.dedupWindowMs > 0 && senderId && body) {
    const key = `${channelId}:${senderId}:${body}`;
    const last = _dedupMap.get(key);
    if (last && (Date.now() - last) < config.dedupWindowMs) {
      return { action: 'drop', reason: 'dedup' };
    }
    _dedupMap.set(key, Date.now());
    _pruneDedup(config.dedupMaxEntries);
  }
  if (config.commandPatterns.length > 0 && body) {
    for (const pat of config.commandPatterns) {
      if (pat.test(body)) {
        return { action: 'rewrite', reason: 'command-block', body: REWRITE_TEXT };
      }
    }
  }
  if (config.botLoopEnabled && body && _isBotLikeMessage(body)) {
    return { action: 'drop', reason: 'bot-loop' };
  }
  return { action: 'pass' };
}

function runOutboundDefense(channelId, text) {
  const config = CHANNEL_DEFENSE[channelId];
  if (!config) return { blocked: false, text };
  const { filterSensitiveOutput } = require('./channels');
  if (config.outputFilterLevel === 'full') {
    return filterSensitiveOutput(text);
  }
  if (config.outputFilterLevel === 'light') {
    const lightPatterns = [
      /(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi,
      /\bsk-(?:proj|live|test)-[A-Za-z0-9]{20,}/gi,
      /[A-Za-z]:\\(?:Users|AppData|\.openclaw|electron)\\\S+/gi,
      /\/(?:home|Users|\.openclaw|var\/log)\S+/gi,
    ];
    let filtered = text;
    for (const p of lightPatterns) {
      filtered = filtered.replace(p, '[redacted]');
    }
    return { blocked: filtered !== text, text: filtered };
  }
  return { blocked: false, text };
}

function registerChannelDefense(channelId, config) {
  CHANNEL_DEFENSE[channelId] = config;
}

function clearDedup() {
  _dedupMap.clear();
}

module.exports = {
  runInboundDefense,
  runOutboundDefense,
  registerChannelDefense,
  clearDedup,
  SHARED_COMMAND_PATTERNS,
  CHANNEL_DEFENSE,
};
