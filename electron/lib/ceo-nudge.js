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
  /kh[oô]ng ph[aả]i/i,
  /khong phai/i,
  /sai r[oồ]i/i,
  /sai roi/i,
  /nh[oớ] l[aà]/i,
  /nho la/i,
  /lu[oô]n lu[oô]n/i,
  /luon luon/i,
  /[đd][uừ]ng bao gi[oờ]/i,
  /dung bao gio/i,
  /t[uừ] gi[oờ]/i,
  /tu gio/i,
  /ph[aả]i l[aà]/i,
  /phai la/i,
];

function startCeoMessageWatcher() {
  if (_watcherTimerId) return;
  const { getWorkspace } = require('./workspace');
  const ws = getWorkspace();
  if (!ws) return;
  const auditPath = path.join(ws, 'logs', 'audit.jsonl');
  let lastSize = 0;
  try { lastSize = fs.existsSync(auditPath) ? fs.statSync(auditPath).size : 0; } catch {}

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
            if (_CORRECTION_PATTERNS.some(p => p.test(text))) {
              _nudgeImmediate = true;
            }
          }
        } catch {}
      }
    } catch {}
  }, 10000);
}

function startNudgeTimer() {
  if (_nudgeTimerId) return;
  _nudgeTimerId = setInterval(async () => {
    const now = Date.now();
    const idle = now - _lastCeoMessageAt;
    if (_nudgeInFlight) return;
    const shouldNudge = (_nudgeImmediate && _lastCeoMessageAt > _lastNudgeAt)
      || (idle > 300000 && _lastCeoMessageAt > _lastNudgeAt);
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
    console.log('[nudge] skipped — no significant conversation to review');
    return;
  }

  const prompt = `Review the last conversation with CEO. Decide if anything is worth remembering long-term:
- A correction (CEO said "not like that, do it this way")
- A new business rule or preference
- A pattern across recent customers
- A fact about the business

Respond ONLY with JSON (no markdown, no explanation):
{"memories":[{"action":"write","type":"rule","content":"..."},{"action":"delete","id":"mem_..."}]}
If nothing worth saving: {"memories":[]}

Current CEO-MEMORY.md:
${currentMem}

Last conversation:
${transcript}`;

  const { spawnOpenClawSafe } = require('./boot');
  const result = await spawnOpenClawSafe(
    ['agent', '--message', prompt, '--json'],
    { timeoutMs: 120000 }
  );

  if (result.code !== 0) {
    console.warn('[nudge] agent exited with code', result.code);
    return;
  }

  let memoriesArr;
  try {
    const trimmed = (result.stdout || '').trim();
    const parsed = JSON.parse(trimmed);
    const payloadText = parsed?.result?.payloads?.[0]?.text
      || parsed?.payloads?.[0]?.text
      || parsed?.text
      || trimmed;
    const memJson = typeof payloadText === 'string'
      ? JSON.parse(payloadText.match(/\{[\s\S]*"memories"[\s\S]*\}/)?.[0] || '{}')
      : payloadText;
    memoriesArr = memJson?.memories;
  } catch (e) {
    console.warn('[nudge] JSON parse failed:', e?.message);
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
        await writeMemory({ type: mem.type || 'fact', content: mem.content, source });
        wrote++;
      } else if (mem.action === 'delete' && mem.id) {
        deleteMemory(mem.id);
        deleted++;
      }
    } catch (e) {
      console.warn('[nudge] memory op failed:', e?.message);
    }
  }
  console.log(`[nudge] done — wrote ${wrote}, deleted ${deleted}`);
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
};
