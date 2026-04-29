'use strict';
const fs = require('fs');
const path = require('path');
const { getWorkspace, auditLog } = require('./workspace');
const { sendCeoAlert } = require('./channels');
const { extractConversationHistoryRaw } = require('./conversation');

// ============================================
//  ESCALATION QUEUE — auto-forward to CEO
// ============================================
// send.ts output filter detects escalation keywords in bot replies and writes
// to logs/escalation-queue.jsonl. This poller reads the file every 30s, sends
// each entry to CEO via sendCeoAlert(), then truncates.

let _escalationInterval = null;

async function processEscalationQueue() {
  try {
    const ws = getWorkspace();
    const queueFile = path.join(ws, 'logs', 'escalation-queue.jsonl');
    if (!fs.existsSync(queueFile)) return;
    const tmpFile = queueFile + '.processing.' + process.pid;
    try { fs.renameSync(queueFile, tmpFile); } catch { return; }
    const raw = fs.readFileSync(tmpFile, 'utf-8').trim();
    if (!raw) { try { fs.unlinkSync(tmpFile); } catch {} return; }
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length === 0) { try { fs.unlinkSync(tmpFile); } catch {} return; }

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        let customerName = entry.to || 'unknown';
        try {
          const memDir = path.join(ws, 'memory', entry.isGroup ? 'zalo-groups' : 'zalo-users');
          const memFile = path.join(memDir, entry.to + '.md');
          if (fs.existsSync(memFile)) {
            const memContent = fs.readFileSync(memFile, 'utf-8').slice(0, 500);
            const nameMatch = memContent.match(/^#\s+(.+)/m);
            if (nameMatch) customerName = nameMatch[1].trim();
          }
        } catch {}

        let customerMsg = '';
        try {
          const collected = extractConversationHistoryRaw({ sinceMs: Date.now() - 10 * 60 * 1000, maxMessages: 20, channels: ['modoro-zalo'] });
          const fromCustomer = (collected || []).filter(m => m.role === 'user' && String(m.sender || '') === String(entry.to));
          if (fromCustomer.length > 0) {
            customerMsg = (fromCustomer[fromCustomer.length - 1].text || '').slice(0, 200);
          }
        } catch {}

        const vnTime = new Date(entry.t).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
        const target = entry.isGroup ? 'nhóm' : 'khách';
        const parts = [`${customerName} cần sếp xử lý (Zalo ${target})`];
        if (customerMsg) parts.push(`\nKhách nói: "${customerMsg}"`);
        parts.push(`\nBot trả lời: "${(entry.botReply || '').slice(0, 300)}"`);
        parts.push(`\n${vnTime} · ID: ${entry.to}`);
        const alertMsg = parts.join('');

        await sendCeoAlert(alertMsg);
        try { auditLog('escalation_forwarded', { to: entry.to, trigger: entry.trigger }); } catch {}
        console.log('[escalation] Forwarded to CEO:', entry.trigger, 'for', customerName);
      } catch (e) {
        console.error('[escalation] Parse/send error for line:', e?.message);
      }
    }
    try { fs.unlinkSync(tmpFile); } catch {}
  } catch (e) {
    console.error('[escalation] processQueue error:', e?.message);
  }
}

function startEscalationChecker() {
  if (_escalationInterval) clearInterval(_escalationInterval);
  // Recover orphaned .processing.* files from previous crash
  try {
    const ws = getWorkspace();
    const logsDir = path.join(ws, 'logs');
    if (fs.existsSync(logsDir)) {
      const orphans = fs.readdirSync(logsDir).filter(f => f.startsWith('escalation-queue.jsonl.processing.'));
      for (const orphan of orphans) {
        const orphanPath = path.join(logsDir, orphan);
        const queueFile = path.join(logsDir, 'escalation-queue.jsonl');
        try {
          const content = fs.readFileSync(orphanPath, 'utf-8').trim();
          if (content) fs.appendFileSync(queueFile, (content.endsWith('\n') ? content : content + '\n'), 'utf-8');
          fs.unlinkSync(orphanPath);
          console.log(`[escalation] recovered orphaned ${orphan} (${content.split('\n').length} entries)`);
        } catch (e) { console.warn('[escalation] orphan recovery failed:', e?.message); }
      }
    }
  } catch {}
  _escalationInterval = setInterval(processEscalationQueue, 30 * 1000);
  _escalationInterval.unref?.();
}

function cleanupEscalationTimers() {
  if (_escalationInterval) { clearInterval(_escalationInterval); _escalationInterval = null; }
}

module.exports = {
  processEscalationQueue,
  startEscalationChecker,
  cleanupEscalationTimers,
};
