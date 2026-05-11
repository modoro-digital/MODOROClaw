'use strict';
const fs = require('fs');
const path = require('path');
const ctx = require('./context');
const { getWorkspace, auditLog } = require('./workspace');
const { call9Router } = require('./nine-router');

// Wire point: set by main.js so conversation.js can fire CEO Telegram alerts
// when customer memory is written (except routine daily cron summaries).
let _memoryWriteNotifyCeo = null;
function setMemoryWriteNotifyCeo(fn) { _memoryWriteNotifyCeo = fn; }
function notifyCeoMemoryWrite(info) {
  if (typeof _memoryWriteNotifyCeo === 'function') {
    try { _memoryWriteNotifyCeo(info); } catch (e) { /* non-blocking */ }
  }
}

// Strip prompt-injection patterns from LLM-generated memory summaries.
// Customers can send adversarial text that the summarizer LLM might echo
// verbatim — those strings then persist in memory files and get fed to
// the agent as "prior context", effectively injecting instructions.
function sanitizeMemorySummary(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/^(SYSTEM|ASSISTANT|HUMAN|USER|INSTRUCTION|PROMPT|RULE|BẮT BUỘC)\s*:/gim, '[khách nói]: ')
    .replace(/(?:127\.0\.0\.1|localhost|0\.0\.0\.0):\d{4,5}/g, '[local-api]')
    .replace(/(?:api[_-]?(?:key|token|secret)|bot[_-]?token|password|credentials?)\s*[:=]\s*\S+/gi, '[credential-removed]')
    .replace(/```(?:bash|sh|cmd|powershell|ps1)[\s\S]*?```/gi, '[code-block-removed]');
}

// =====================================================================
// Conversation history extractor for cron prompts
// =====================================================================
// THE ARCHITECTURAL PROBLEM:
// Bot answering "tóm tắt Zalo hôm qua" had no way to read past conversations
// because each cron fire spawns a NEW agent session — that session has no
// memory of past Zalo/Telegram messages which live in OTHER session jsonl
// files at ~/.openclaw/agents/main/sessions/<uuid>.jsonl. Bot would
// hallucinate "no Zalo data" while messages existed on disk.
//
// THE FIX:
// Extract messages directly from session jsonls and INJECT them into the
// cron prompt as a structured context block. Bot doesn't need to discover
// or guess where data lives — it sees actual messages right in the prompt.
// Returns raw structured array of messages. Used by appendPerCustomerSummaries.
function extractConversationHistoryRaw({ sinceMs, maxMessages = 40, channels = ['modoro-zalo', 'telegram'], maxPerSender = 0 } = {}) {
  try {
    const result = _extractConversationHistoryImpl({ sinceMs, maxMessages, channels, maxPerSender });
    return result.collected;
  } catch (e) {
    console.error('[extractConversationHistoryRaw] error:', e?.message || e);
    return [];
  }
}

// Returns formatted string. Used by prompt builders.
function extractConversationHistory({ sinceMs, maxMessages = 40, channels = ['modoro-zalo', 'telegram'], maxPerSender = 0 } = {}) {
  try {
    const result = _extractConversationHistoryImpl({ sinceMs, maxMessages, channels, maxPerSender });
    return result.formatted;
  } catch (e) {
    console.error('[extractConversationHistory] error:', e?.message || e);
    return '';
  }
}

// Shared implementation — returns { collected: [...], formatted: 'string' }.
function _extractConversationHistoryImpl({ sinceMs, maxMessages = 40, channels = ['modoro-zalo', 'telegram'], maxPerSender = 0 } = {}) {
  const _t0 = Date.now();
  const sessionsDir = path.join(ctx.HOME, '.openclaw', 'agents', 'main', 'sessions');
  if (!fs.existsSync(sessionsDir)) return { collected: [], formatted: '' };
  const allFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
  if (allFiles.length === 0) return { collected: [], formatted: '' };

  // mtime pre-filter: skip files not modified since sinceMs.
  const candidates = [];
  for (const f of allFiles) {
    const fp = path.join(sessionsDir, f);
    try {
      const stat = fs.statSync(fp);
      if (sinceMs && stat.mtimeMs < sinceMs) continue;
      candidates.push({ path: fp, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch { continue; }
  }
  if (candidates.length === 0) return { collected: [], formatted: '' };

  // Sort newest first — early-exit once we have enough messages.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const collectTarget = maxMessages * 2;

  const collected = [];
  for (const file of candidates) {
    // Tail-read: for large files, read first 4KB (session event) + last 64KB.
    // 4KB covers session events with long customer names / metadata.
    let content;
    try {
      if (file.size > 65536) {
        const fd = fs.openSync(file.path, 'r');
        try {
          const HEAD_SIZE = 4096;
          const headBuf = Buffer.alloc(HEAD_SIZE);
          fs.readSync(fd, headBuf, 0, HEAD_SIZE, 0);
          const headRaw = headBuf.toString('utf-8');
          const firstNl = headRaw.indexOf('\n');
          if (firstNl < 0) {
            content = fs.readFileSync(file.path, 'utf-8');
          } else {
            const headStr = headRaw.slice(0, firstNl + 1);
            const tailBuf = Buffer.alloc(65536);
            fs.readSync(fd, tailBuf, 0, 65536, file.size - 65536);
            let tailStr = tailBuf.toString('utf-8');
            const tailFirstNl = tailStr.indexOf('\n');
            if (tailFirstNl > 0) tailStr = tailStr.slice(tailFirstNl + 1);
            content = headStr + tailStr;
          }
        } finally {
          try { fs.closeSync(fd); } catch {}
        }
      } else {
        content = fs.readFileSync(file.path, 'utf-8');
      }
    } catch { continue; }

    const lines = content.split(/\r?\n/).filter(l => l.trim());
    let sessionChannel = null;
    let sessionSender = null;
    for (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'session' && event.origin) {
        sessionChannel = event.origin.provider || event.origin.surface || null;
        sessionSender = event.origin.label || null;
        continue;
      }
      if (event.type !== 'message') continue;
      const msg = event.message;
      if (!msg || typeof msg !== 'object') continue;
      const tsMs = typeof msg.timestamp === 'number'
        ? msg.timestamp
        : (event.timestamp ? Date.parse(event.timestamp) : 0);
      if (sinceMs && tsMs < sinceMs) continue;
      if (channels && sessionChannel && !channels.includes(sessionChannel)) continue;
      if (!Array.isArray(msg.content)) continue;
      const textParts = [];
      for (const part of msg.content) {
        if (part?.type === 'text' && typeof part.text === 'string') {
          textParts.push(part.text);
        }
      }
      if (textParts.length === 0) continue;
      let text = textParts.join('\n').trim();
      if (!text) continue;
      if (msg.role === 'user') {
        text = text.replace(/Conversation info[^]*?```\s*\n/g, '');
        text = text.replace(/Sender[^]*?```\s*\n/g, '');
        text = text.replace(/\[Queued messages while agent was busy\]\s*\n*---\n*Queued #\d+\n*/g, '\n');
        text = text.trim();
        if (!text) continue;
      }
      collected.push({
        ts: tsMs,
        role: msg.role,
        channel: sessionChannel || 'unknown',
        sender: sessionSender || 'unknown',
        text: text.slice(0, 500),
      });
    }

    if (collected.length >= collectTarget) break;
  }
  if (collected.length === 0) return { collected: [], formatted: '' };

  collected.sort((a, b) => a.ts - b.ts);

  // Per-customer cap
  let capped = collected;
  if (maxPerSender > 0) {
    const bySender = new Map();
    for (const m of collected) {
      const key = m.sender;
      if (!bySender.has(key)) bySender.set(key, []);
      bySender.get(key).push(m);
    }
    capped = [];
    for (const [, msgs] of bySender) {
      if (msgs.length <= maxPerSender) {
        capped.push(...msgs);
      } else {
        // Keep first 2 + last (cap - 2) to show conversation start + recent.
        // Guard: when maxPerSender <= 2, just take first N (no tail to avoid
        // slice(-0) which returns ALL elements instead of none).
        if (maxPerSender <= 2) {
          capped.push(...msgs.slice(0, maxPerSender));
        } else {
          const head = msgs.slice(0, 2);
          const tail = msgs.slice(-(maxPerSender - 2));
          capped.push(...head, ...tail);
        }
      }
    }
    capped.sort((a, b) => a.ts - b.ts);
  }

  const recent = capped.slice(-maxMessages);
  const formatted = [];
  let lastDate = '';
  for (const m of recent) {
    const dt = new Date(m.ts);
    const dateStr = dt.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
    const timeStr = dt.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (dateStr !== lastDate) {
      formatted.push(`\n--- ${dateStr} ---`);
      lastDate = dateStr;
    }
    const channelLabel = (m.channel === 'modoro-zalo' || m.channel === 'openzalo') ? 'Zalo' : m.channel === 'telegram' ? 'Telegram' : m.channel;
    const roleLabel = m.role === 'user'
      ? (m.sender ? m.sender.split(' id:')[0] : 'Khách')
      : 'Em (bot)';
    formatted.push(`[${timeStr}][${channelLabel}] ${roleLabel}: ${m.text}`);
  }
  console.log(`[extract] ${candidates.length}/${allFiles.length} files read, ${collected.length} msgs collected, ${recent.length} returned in ${Date.now() - _t0}ms`);
  return { collected: recent, formatted: formatted.join('\n') };
}

// Write raw daily journal + AI summary + per-customer interaction append.
// Raw journal: memory/YYYY-MM-DD.md (unchanged, audit trail).
// Summary: memory/YYYY-MM-DD-summary.md (cached, for weekly/monthly prompts).
// Per-customer: appends to memory/zalo-users/<id>.md dated sections.
async function writeDailyMemoryJournal({ date = new Date() } = {}) {
  try {
    const ws = getWorkspace();
    if (!ws) return null;
    const memDir = path.join(ws, 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    const dateStr = date.toISOString().slice(0, 10);
    const file = path.join(memDir, `${dateStr}.md`);
    const sinceMs = date.getTime() - 24 * 60 * 60 * 1000;

    // 1. Raw journal (same as before — full history, no cap)
    const history = extractConversationHistory({ sinceMs, maxMessages: 100 });
    const header = `# Memory ${dateStr}\n\n*Auto-generated. Records all Zalo + Telegram messages in the last 24h before this cron fire.*\n\n`;
    const body = history || '_(Không có tin nhắn nào trong 24h qua.)_';
    fs.writeFileSync(file, header + body + '\n', 'utf-8');

    // 2. Daily summary via 9Router (cached — skip if already exists)
    const summaryFile = path.join(memDir, `${dateStr}-summary.md`);
    if (!fs.existsSync(summaryFile) && history) {
      try {
        const summaryText = await call9Router(
          `Dưới đây là tất cả tin nhắn Zalo + Telegram trong ngày ${dateStr}. ` +
          `Tóm tắt thành bullet points ngắn gọn bằng tiếng Việt:\n` +
          `- Ai đã nhắn gì (tên khách, kênh)\n` +
          `- Kết quả / outcome của mỗi cuộc trò chuyện\n` +
          `- Việc gì còn tồn đọng / cần follow-up\n` +
          `Chỉ trả về bullet points, không thêm giải thích.\n\n` +
          `---\n${history}`,
          { maxTokens: 600, temperature: 0.2, timeoutMs: 15000 }
        );
        if (summaryText) {
          fs.writeFileSync(summaryFile, `# Tóm tắt ${dateStr}\n\n${summaryText}\n`, 'utf-8');
          console.log(`[journal] summary written: ${dateStr}-summary.md`);
        } else {
          auditLog('summary_generation_failed', { date: dateStr, reason: '9Router returned null' });
          console.warn(`[journal] 9Router summary failed for ${dateStr} — raw journal still available`);
        }
      } catch (e) {
        auditLog('summary_generation_failed', { date: dateStr, reason: e?.message });
        console.warn(`[journal] summary error for ${dateStr}:`, e?.message);
      }
    }

    // 3. Per-customer interaction summary (append to zalo-users/<id>.md)
    if (history) {
      try {
        await appendPerCustomerSummaries(ws, dateStr, sinceMs);
      } catch (e) {
        console.warn(`[journal] per-customer summary error:`, e?.message);
      }
    }

    // 4. Cross-customer pattern detection for CEO memory
    try {
      const collected = extractConversationHistoryRaw({ sinceMs, maxMessages: 500, channels: ['modoro-zalo'] });
      const bySender = new Map();
      for (const m of collected || []) {
        if (m.role !== 'user') continue;
        const idMatch = (m.sender || '').match(/id:(\d+)/);
        if (idMatch) {
          if (!bySender.has(idMatch[1])) bySender.set(idMatch[1], []);
          bySender.get(idMatch[1]).push((m.text || '').slice(0, 200));
        }
      }
      if (bySender.size >= 3) {
        const allMsgs = [];
        for (const msgs of bySender.values()) allMsgs.push(...msgs);
        const cleanedForDedup = allMsgs.join(' ').replace(/\[\d{2}:\d{2}\]/g, '').replace(/\d{4}-\d{2}-\d{2}/g, '').slice(0, 800);
        const { searchMemory, writeMemory } = require('./ceo-memory');
        const existing = await searchMemory(cleanedForDedup, { limit: 1, bumpRelevance: false });
        if (existing.length > 0 && existing[0].score > 0.85) {
          const ceoMem = require('./ceo-memory');
          const db = ceoMem.getMemoryDb();
          if (db) {
            db.prepare('UPDATE ceo_memories SET relevance_score = MIN(relevance_score + 0.1, 5.0), updated_at = ? WHERE id = ?').run(new Date().toISOString(), existing[0].id);
            ceoMem.scheduleRegeneration();
          }
          console.log('[ceo-memory] evening pattern already stored, relevance boosted for ' + existing[0].id);
        } else {
          const topMsgs = allMsgs.slice(0, 10).join('; ').slice(0, 300);
          const content = `${bySender.size} khách hỏi hôm nay. Nội dung: ${topMsgs}`;
          await writeMemory({ type: 'pattern', content: content.slice(0, 500), source: 'evening_summary' });
          console.log('[ceo-memory] evening pattern written from ' + bySender.size + ' customers');
        }
      }
    } catch (e) {
      console.warn('[ceo-memory] evening pattern detection failed:', e?.message);
    }

    return file;
  } catch (e) {
    console.error('[writeDailyMemoryJournal] error:', e?.message || e);
    return null;
  }
}

// Group messages by Zalo customer, summarize each, append to their profile.
// Only processes Zalo (modoro-zalo) messages (Telegram is CEO-only, no customer profiles).
// Extract the last N dated sections from a profile file for LLM prior-context.
// Returns a compact string or '' if no dated history exists.
function _recentProfileHistory(profileContent, maxSections = 3, maxChars = 1200) {
  try {
    const dated = profileContent.match(/\n\n## \d{4}-\d{2}-\d{2}\n[\s\S]*?(?=\n\n## \d{4}-\d{2}-\d{2}|$)/g) || [];
    if (dated.length === 0) return '';
    const tail = dated.slice(-maxSections).join('').trim();
    return tail.length > maxChars ? tail.slice(-maxChars) : tail;
  } catch { return ''; }
}

const _memoryFileLocks = new Map();
function _withMemoryFileLock(filePath, fn) {
  const prev = _memoryFileLocks.get(filePath) || Promise.resolve();
  const next = prev.then(fn, fn);
  _memoryFileLocks.set(filePath, next);
  next.finally(() => { if (_memoryFileLocks.get(filePath) === next) _memoryFileLocks.delete(filePath); });
  return next;
}

async function appendPerCustomerSummaries(ws, dateStr, sinceMs) {
  // Pull BOTH user and assistant messages so summary can reflect what actually
  // happened (was: role='user' only → prompt asked "Bot trả lời gì" but LLM
  // had no bot data → hallucinated or left blank → useless summaries).
  const collected = extractConversationHistoryRaw({ sinceMs, maxMessages: 1000, channels: ['modoro-zalo'], maxPerSender: 0 });
  if (!collected || collected.length === 0) return;

  const bySender = new Map();
  for (const m of collected) {
    // Keep all roles; group by the customer's senderId. For user messages
    // sender format is "Name id:123...", for assistant it may be bot id
    // or the session's peer — use message.peerId if available, else fall
    // back to parsing ".sender".
    const idMatch = (m.sender || '').match(/id:(\d+)/) || (m.peerId ? [null, String(m.peerId)] : null);
    if (!idMatch) continue;
    const senderId = idMatch[1];
    if (!bySender.has(senderId)) {
      bySender.set(senderId, {
        name: (m.role === 'user' && m.sender) ? m.sender.split(' id:')[0] : null,
        msgs: [],
      });
    }
    const slot = bySender.get(senderId);
    if (!slot.name && m.role === 'user' && m.sender) slot.name = m.sender.split(' id:')[0];
    slot.msgs.push(m);
  }

  const usersDir = path.join(ws, 'memory', 'zalo-users');

  // Build list of work items first (fast, fs-only) so we can cap concurrency
  // on the actual 9Router calls. Was: serial await in loop → 500 customers ×
  // 10s = 83 min cron. Now: batched Promise.allSettled → linear in batchSize.
  const MIN_MSGS = 3;                // skip greeting-only threads (saves LLM cost for "xin chào"/"ok"/"cảm ơn")
  const MAX_MSGS_PER_CUSTOMER = 60;  // cap prompt size — rare high-volume customer won't blow context
  const BATCH_SIZE = 5;              // parallel 9Router calls (was: serial)
  const workItems = [];
  for (const [senderId, { name, msgs }] of bySender) {
    if (msgs.length < MIN_MSGS) continue;

    const profilePath = path.join(usersDir, `${senderId}.md`);
    if (!fs.existsSync(profilePath)) continue;

    let existing = '';
    try {
      existing = fs.readFileSync(profilePath, 'utf-8');
      if (existing.includes(`## ${dateStr}`)) continue;
    } catch { continue; }

    // Trim to most recent MAX_MSGS_PER_CUSTOMER to cap prompt.
    const clipped = msgs.length > MAX_MSGS_PER_CUSTOMER
      ? msgs.slice(-MAX_MSGS_PER_CUSTOMER)
      : msgs;
    const resolvedName = name || ('kh' + senderId.slice(-4));
    workItems.push({ senderId, name: resolvedName, msgs: clipped, profilePath, existing });
  }

  // Batched parallel execution with Promise.allSettled so one slow/errored
  // customer doesn't block the rest. Each batch of BATCH_SIZE runs in parallel.
  for (let i = 0; i < workItems.length; i += BATCH_SIZE) {
    const batch = workItems.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(batch.map(async (item) => {
      const { senderId, name, msgs, profilePath, existing } = item;

      // Format BOTH sides so the LLM sees the actual conversation shape.
      // Label bot clearly so model won't confuse speakers.
      const customerHistory = msgs.map(m => {
        const dt = new Date(m.ts);
        const time = dt.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
        const speaker = m.role === 'assistant' ? 'Bot' : (name || 'Khách');
        const text = (m.text || '').slice(0, 500);  // per-msg cap
        return `[${time}] ${speaker}: ${text}`;
      }).join('\n');

      // Prior-context: last 3 dated sections from this customer's profile
      // so the LLM has continuity (was: every day started fresh → summaries
      // read like amnesia). Caps at 1200 chars so prompt stays small.
      const priorContext = _recentProfileHistory(existing, 3, 1200);
      const priorBlock = priorContext
        ? `\n\n[LỊCH SỬ TRƯỚC ĐÓ — tham khảo continuity, KHÔNG lặp lại]\n${priorContext}`
        : '';

      let summary = null;
      try {
        summary = await call9Router(
          `Bạn là trợ lý tóm tắt Zalo. Đọc cuộc trò chuyện ngày ${dateStr} giữa khách "${name}" và bot của shop.\n` +
          `Viết tóm tắt **3-5 bullet point** ngắn gọn bằng tiếng Việt CÓ DẤU. Cần thể hiện rõ:\n` +
          `1. KHÁCH hỏi/yêu cầu cụ thể gì (sản phẩm, giá, dịch vụ, nhu cầu cá nhân)\n` +
          `2. BOT trả lời gì — trích NGẮN câu trả lời quan trọng của bot\n` +
          `3. Outcome: đơn xong / chưa chốt / cần báo giá / cần CEO duyệt / khách quan tâm tiếp\n` +
          `4. Nếu khách hứa "mai mua" hoặc có deadline → ghi rõ ngày\n` +
          `5. Nếu khách bực/phàn nàn → flag "!CẨN THẬN" ở đầu bullet đó\n\n` +
          `KHÔNG emoji. KHÔNG lặp lại nguyên văn — TÓM TẮT. KHÔNG bịa nếu không rõ.\n` +
          `Chỉ trả về bullet points, không intro, không kết luận.${priorBlock}\n\n` +
          `[CUỘC TRÒ CHUYỆN HÔM NAY]\n${customerHistory}`,
          { maxTokens: 350, temperature: 0.2, timeoutMs: 12000 }
        );
      } catch {}

      const safeSummary = summary ? sanitizeMemorySummary(summary) : null;
      const appendContent = safeSummary
        ? `\n\n## ${dateStr}\n${safeSummary}\n`
        : `\n\n## ${dateStr}\n_(LLM summary không khả dụng — raw transcript)_\n${sanitizeMemorySummary(customerHistory)}\n`;

      try {
        await _withMemoryFileLock(profilePath, () => {
          fs.appendFileSync(profilePath, appendContent, 'utf-8');
          trimZaloMemoryFile(profilePath, 50 * 1024);
        });
        console.log(`[journal] appended ${dateStr} summary to zalo-users/${senderId}.md (${msgs.length} msgs, ${summary ? 'LLM' : 'raw'})`);
      } catch (e) {
        console.warn(`[journal] append to ${senderId}.md failed:`, e?.message);
      }
    }));
  }
}

// Trim a zalo-users/<id>.md file to at most maxBytes by removing the oldest
// ## YYYY-MM-DD sections from the top. The front-matter header (between first
// two --- markers) is always preserved. No-op if file is under the cap.
function trimZaloMemoryFile(filePath, maxBytes) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= maxBytes) return;

    let content = fs.readFileSync(filePath, 'utf-8');
    // Preserve everything up to and including the closing --- of front-matter
    const fmEnd = content.indexOf('\n---\n', content.indexOf('---\n') + 1);
    const header = fmEnd >= 0 ? content.slice(0, fmEnd + 5) : '';
    const body = fmEnd >= 0 ? content.slice(fmEnd + 5) : content;

    // Split body into dated sections (split on \n\n## YYYY-MM-DD).
    // sections[0] may be a non-dated intro block (profile markdown heading, import note)
    // — never drop it. Only drop sections that ARE dated (start with \n\n## YYYY-MM-DD).
    const sectionRe = /(?=\n\n## \d{4}-\d{2}-\d{2})/g;
    const sections = body.split(sectionRe).filter(Boolean);
    const datedRe = /^\n\n## \d{4}-\d{2}-\d{2}/;

    // Find index of first dated section; everything before it is the intro block (preserved)
    let firstDatedIdx = sections.findIndex(s => datedRe.test(s));
    if (firstDatedIdx < 0) firstDatedIdx = sections.length; // no dated sections — nothing to drop

    // Drop oldest DATED sections until under cap
    while (firstDatedIdx < sections.length) {
      const trimmed = header + sections.join('');
      if (Buffer.byteLength(trimmed, 'utf-8') <= maxBytes) break;
      sections.splice(firstDatedIdx, 1); // remove oldest dated section
      // firstDatedIdx stays the same (next oldest is now at the same index)
    }

    const newContent = header + sections.join('');
    if (newContent.length < content.length) {
      const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmpPath, newContent, 'utf-8');
      fs.renameSync(tmpPath, filePath);
      console.log(`[journal] trimmed ${path.basename(filePath)} from ${stat.size} → ${Buffer.byteLength(newContent, 'utf-8')} bytes`);
    }
  } catch (e) {
    console.warn(`[journal] trimZaloMemoryFile failed for ${filePath}:`, e?.message);
  }
}

module.exports = {
  extractConversationHistoryRaw,
  extractConversationHistory,
  writeDailyMemoryJournal,
  appendPerCustomerSummaries,
  trimZaloMemoryFile,
  withMemoryFileLock: _withMemoryFileLock,
  setMemoryWriteNotifyCeo,
};
