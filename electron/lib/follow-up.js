'use strict';
const fs = require('fs');
const path = require('path');
const { getWorkspace, auditLog } = require('./workspace');
const { writeJsonAtomic } = require('./util');
const ctx = require('./context');

// ============================================
//  FOLLOW-UP QUEUE — one-shot delayed messages
// ============================================
// Bot escalates CEO + queues a follow-up: "15 min later, message customer X
// to check if they've been helped." File: <workspace>/follow-up-queue.json
// Format: [{ id, channel, recipientId, recipientName, prompt, fireAt, firedAt? }]
// Checked every 60s. After fire → mark firedAt. Entries older than 24h → purge.

let _followUpInterval = null;
let _followUpQueueLock = false;
let _followUpQueueLockAt = 0;
let _followUpWriteChain = Promise.resolve();

// Late-binding: runCronAgentPrompt lives in main.js (will move to cron.js in Task 19)
let _runCronAgentPrompt = null;
function setRunCronAgentPrompt(fn) { _runCronAgentPrompt = fn; }

function getFollowUpQueuePath() {
  return path.join(getWorkspace(), 'follow-up-queue.json');
}

function readFollowUpQueue() {
  const p = getFollowUpQueuePath();
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return []; }
}

function writeFollowUpQueue(queue) {
  writeJsonAtomic(getFollowUpQueuePath(), queue);
}

async function processFollowUpQueue() {
  if (_followUpQueueLock) {
    if (_followUpQueueLockAt && Date.now() - _followUpQueueLockAt > 15 * 60 * 1000) {
      console.error('[follow-up] lock held >15min — force-releasing (deadlock recovery)');
      _followUpQueueLock = false;
    } else {
      return;
    }
  }
  _followUpQueueLock = true;
  _followUpQueueLockAt = Date.now();
  // Count toward IPC in-flight so before-quit drain (waitForIpcDrain) actually waits for
  // follow-up processing to complete. Without this, a quit mid-flush would lose firedAt
  // stamps and cause duplicate customer messages on next boot.
  ctx.ipcInFlightCount++;
  try {
    let queue = readFollowUpQueue();
    if (queue.length === 0) return;
    const now = Date.now();
    let changed = false;
    for (const item of queue) {
      if (item.firedAt) continue; // already processed
      if (new Date(item.fireAt).getTime() > now) continue; // not yet
      // Fire!
      console.log('[follow-up] Firing:', item.id, 'for', item.recipientName || item.recipientId);
      if (!_runCronAgentPrompt) {
        console.error('[follow-up] _runCronAgentPrompt not wired — cannot fire follow-up', item.id);
        item.firedAt = 'error:runCronAgentPrompt not initialized';
      } else {
        try {
          const prompt = item.prompt || `Nhắc CEO: Khách ${item.recipientName || item.recipientId} (${item.channel || 'Zalo'}) hỏi ${item.question || 'một câu hỏi'} cách đây 15 phút và chưa được phản hồi. Gửi tin nhắn nhắc CEO kiểm tra. KHÔNG gửi tin cho khách. KHÔNG nói "đã kiểm tra".`;
          await _runCronAgentPrompt(prompt, { label: 'follow-up-' + (item.recipientName || item.recipientId) });
          item.firedAt = new Date().toISOString();
          try { auditLog('follow_up_fired', { id: item.id, recipient: item.recipientId }); } catch {}
        } catch (e) {
          console.error('[follow-up] Fire error:', e.message);
          item.firedAt = 'error:' + e.message;
        }
      }
      changed = true;
      // Per-item persistence (R2): persist firedAt stamp IMMEDIATELY after each fire so a
      // mid-loop quit/crash only loses the in-progress item, not the whole batch.
      // Merge with any IPC-added entries (IPC may have appended during the await above).
      try {
        const freshQueue = readFollowUpQueue();
        const ourById = new Map(queue.map(q => [q.id, q]));
        const merged = [];
        const seenIds = new Set();
        for (const fresh of freshQueue) {
          // Our in-memory updates (firedAt stamps) win for items we know about.
          merged.push(ourById.get(fresh.id) || fresh);
          seenIds.add(fresh.id);
        }
        // Defensive: our items missing from disk (shouldn't normally happen)
        for (const ours of queue) {
          if (!seenIds.has(ours.id)) merged.push(ours);
        }
        writeFollowUpQueue(merged);
      } catch (persistErr) {
        console.error('[follow-up] per-item persist error:', persistErr.message);
      }
    }
    // Final reconcile: pick up any IPC-added entries since last per-item persist.
    if (changed) {
      const freshQueue = readFollowUpQueue();
      const ourIds = new Set(queue.map(q => q.id));
      for (const fresh of freshQueue) {
        if (!ourIds.has(fresh.id)) queue.push(fresh); // new entry written by IPC
      }
    }

    // Purge entries older than 24h
    const cutoff = now - 24 * 60 * 60 * 1000;
    const before = queue.length;
    queue = queue.filter(q => new Date(q.fireAt).getTime() > cutoff);
    if (queue.length !== before) changed = true;
    if (changed) writeFollowUpQueue(queue);
  } catch (e) {
    console.error('[follow-up] processQueue error:', e.message);
  } finally {
    _followUpQueueLock = false;
    _followUpQueueLockAt = 0;
    ctx.ipcInFlightCount = Math.max(0, ctx.ipcInFlightCount - 1);
  }
}

function queueFollowUpSafe(entry) {
  _followUpWriteChain = _followUpWriteChain.then(() => {
    const queue = readFollowUpQueue();
    queue.push(entry);
    writeFollowUpQueue(queue);
  }).catch(e => console.error('[follow-up] queueFollowUpSafe error:', e.message));
  return _followUpWriteChain;
}

function startFollowUpChecker() {
  if (_followUpInterval) clearInterval(_followUpInterval);
  _followUpInterval = setInterval(processFollowUpQueue, 60 * 1000); // check every 60s
  _followUpInterval.unref?.();
}

function cleanupFollowUpTimers() {
  if (_followUpInterval) { clearInterval(_followUpInterval); _followUpInterval = null; }
}

module.exports = {
  getFollowUpQueuePath,
  readFollowUpQueue,
  writeFollowUpQueue,
  queueFollowUpSafe,
  processFollowUpQueue,
  startFollowUpChecker,
  cleanupFollowUpTimers,
  setRunCronAgentPrompt,
};
