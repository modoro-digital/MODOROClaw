'use strict';
const fs = require('fs');
const path = require('path');

let _lastCeoMessageAt = 0;
let _lastNudgeAt = 0;
let _nudgeImmediate = false;
let _nudgeInFlight = false;
let _nudgeTimerId = null;
let _watcherTimerId = null;
let _watcherLeftover = '';

const _CORRECTION_PATTERNS = [
  /khong phai/i,
  /sai roi/i,
  /nho la/i,
  /phai la/i,
  /khong dung/i,
  /sua lai/i,
  /tu gio/i,
  /luon luon/i,
  /dung bao gio/i,
  /moi lan/i,
  /quy tac/i,
  /anh thich/i,
  /anh ghet/i,
  /dung lam/i,
  /khong can/i,
  /anh muon/i,
];

function _normalizeVietnamese(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function _looksLikeMemorySignal(text) {
  const normalized = _normalizeVietnamese(text);
  return _CORRECTION_PATTERNS.some(p => p.test(normalized));
}

function startCeoMessageWatcher() {
  if (_watcherTimerId) return;
  const { getWorkspace } = require('./workspace');
  const ws = getWorkspace();
  if (!ws) return;
  const auditPath = path.join(ws, 'logs', 'audit.jsonl');
  let lastSize = 0;
  try { lastSize = fs.existsSync(auditPath) ? fs.statSync(auditPath).size : 0; } catch (e) { console.warn('[nudge-watcher] stat error:', e?.message); }

  _watcherTimerId = setInterval(() => {
    try {
      if (!fs.existsSync(auditPath)) return;
      const stat = fs.statSync(auditPath);
      if (stat.size <= lastSize) { lastSize = stat.size; return; }
      const readLen = Math.min(stat.size - lastSize, 8192);
      const fd = fs.openSync(auditPath, 'r');
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, lastSize);
      fs.closeSync(fd);
      lastSize = stat.size;
      const chunk = _watcherLeftover + buf.toString('utf-8');
      const parts = chunk.split('\n');
      _watcherLeftover = parts.pop() || '';
      const lines = parts.filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.event === 'message_inbound' && entry.channel === 'telegram') {
            _lastCeoMessageAt = Date.now();
            const text = entry.text || entry.body || '';
            if (_looksLikeMemorySignal(text)) {
              _nudgeImmediate = true;
            }
          }
        } catch {}
      }
    } catch (e) { console.warn('[nudge-watcher] tick error:', e?.message); }
  }, 10000);
}

function startNudgeTimer() {
  if (_nudgeTimerId) return;
  _nudgeTimerId = setInterval(async () => {
    const now = Date.now();
    const idle = now - _lastCeoMessageAt;
    if (_nudgeInFlight) return;
    const shouldNudge = (_nudgeImmediate && _lastCeoMessageAt > _lastNudgeAt)
      || (idle > 60000 && _lastCeoMessageAt > _lastNudgeAt);
    if (!shouldNudge) return;

    const source = _nudgeImmediate ? 'ceo_correction' : 'nudge';
    _lastNudgeAt = now;
    _nudgeImmediate = false;
    _nudgeInFlight = true;
    try {
      await _runMemoryNudge(source);
    } catch (e) {
      console.error('[nudge] error:', e?.message);
    } finally {
      _nudgeInFlight = false;
    }
  }, 60000);
}

async function _runMemoryNudge(source) {
  console.log('[nudge] firing memory nudge (source: ' + source + ')...');
  const { getWorkspace } = require('./workspace');
  const ws = getWorkspace();
  if (!ws) return;

  const memPath = path.join(ws, 'CEO-MEMORY.md');
  let currentMem = fs.existsSync(memPath) ? fs.readFileSync(memPath, 'utf-8') : '(empty)';
  if (currentMem.length > 4000) currentMem = currentMem.slice(0, 4000) + '\n...(truncated)';

  let transcript = '';
  try {
    const { extractConversationHistory } = require('./conversation');
    transcript = extractConversationHistory({ sinceMs: Date.now() - 30 * 60 * 1000, maxMessages: 30, channels: ['telegram'] });
  } catch (e) {
    console.warn('[nudge] conversation extraction failed:', e?.message);
    return;
  }
  if (!transcript || transcript.length < 50) {
    console.log('[nudge] skipped - no significant conversation to review');
    return;
  }

  const prompt = `Review the last conversation with CEO. Decide if anything is worth remembering long-term.

Only save durable, reusable memory:
1. correction - CEO corrected the bot, for example wrong price, wrong name, wrong workflow.
2. rule - CEO gave a future rule, for example "from now on always..." or "never...".
3. preference - CEO revealed a style or working preference.
4. procedure - CEO taught a reusable workflow or tool sequence.
5. pattern - repeated customer or business pattern.
6. fact - stable business fact.

Do not save task completions, sent-message logs, created-file logs, cron results, or one-time errands.
Sensitive data should be summarized without secrets.

Respond only with JSON:
{"memories":[{"action":"write","type":"correction","content":"Giá outlet là 2.5tr, không phải 3tr"}]}
If nothing is worth saving: {"memories":[]}

Current CEO-MEMORY.md:
${currentMem}

Last conversation:
${transcript}`;

  const { call9Router } = require('./nine-router');
  const raw = await call9Router(prompt, { maxTokens: 500, temperature: 0.2, timeoutMs: 20000 });
  if (!raw) {
    console.warn('[nudge] 9Router returned null - skipping');
    return;
  }

  let memoriesArr;
  try {
    const memJson = JSON.parse(raw.match(/\{[\s\S]*"memories"[\s\S]*\}/)?.[0] || '{}');
    memoriesArr = memJson?.memories;
  } catch (e) {
    console.warn('[nudge] JSON parse failed:', e?.message, raw?.slice(0, 200));
    return;
  }

  if (!Array.isArray(memoriesArr) || memoriesArr.length === 0) {
    console.log('[nudge] nothing worth remembering');
    return;
  }

  const { writeMemory, deleteMemory } = require('./ceo-memory');
  let wrote = 0, deleted = 0;
  for (const mem of memoriesArr) {
    try {
      if (mem.action === 'write' && mem.content) {
        await writeMemory({ type: mem.type || 'fact', content: mem.content, source, scope: 'ceo' });
        wrote++;
      } else if (mem.action === 'delete' && mem.id) {
        deleteMemory(mem.id);
        deleted++;
      }
    } catch (e) {
      console.warn('[nudge] memory op failed:', e?.message);
    }
  }
  console.log(`[nudge] done - wrote ${wrote}, deleted ${deleted}`);
  try {
    const { auditLog } = require('./workspace');
    auditLog('memory_nudge', { wrote, deleted, source });
  } catch {}
}

function cleanupNudgeTimers() {
  if (_nudgeTimerId) { clearInterval(_nudgeTimerId); _nudgeTimerId = null; }
  if (_watcherTimerId) { clearInterval(_watcherTimerId); _watcherTimerId = null; }
  _watcherLeftover = '';
}

module.exports = {
  startCeoMessageWatcher,
  startNudgeTimer,
  cleanupNudgeTimers,
  _looksLikeMemorySignal,
};
