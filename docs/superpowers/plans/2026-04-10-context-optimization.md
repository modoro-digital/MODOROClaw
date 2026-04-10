# Context Optimization Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize MODOROClaw's context storage and retrieval — faster session scanning, smarter summaries for weekly/monthly reports, semantic knowledge search, and per-customer conversation memory.

**Architecture:** All changes in `electron/main.js`. Reuse existing 9Router HTTP call pattern from `summarizeKnowledgeContent()`. No new dependencies. Every optimization has fallback to current behavior.

**Tech Stack:** Node.js (Electron main process), SQLite FTS5, 9Router HTTP API (OpenAI-compatible `/chat/completions`)

**Spec:** `docs/superpowers/specs/2026-04-10-context-optimization-design.md`

---

## Chunk 1: Foundation — 9Router helper + extractConversationHistory rewrite

### Task 1: Extract reusable 9Router call helper

**Files:**
- Modify: `electron/main.js:8428-8497` (refactor `summarizeKnowledgeContent` pattern into shared helper)

The existing `summarizeKnowledgeContent()` has 60 lines of HTTP boilerplate (read config, resolve model, build request, handle timeout/fallback). We need this pattern in 4+ new places. Extract it once.

- [ ] **Step 1: Add `call9Router` helper ABOVE `summarizeKnowledgeContent` (~line 8427)**

```javascript
// Shared 9Router LLM call helper. Returns response text or null on failure.
// Reuses CEO's configured 9Router provider from openclaw.json.
// timeoutMs: per-call timeout (default 8s). maxTokens: response cap.
async function call9Router(prompt, { maxTokens = 200, temperature = 0.3, timeoutMs = 8000 } = {}) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(HOME, '.openclaw', 'openclaw.json'), 'utf-8'));
    const provider = config?.models?.providers?.ninerouter;
    if (!provider?.baseUrl || !provider?.apiKey) return null;
    let modelName = 'auto';
    try {
      const def = config?.agents?.defaults?.model;
      if (typeof def === 'string' && def.length > 0) {
        modelName = def.replace(/^ninerouter\//, '');
      } else if (Array.isArray(provider?.models) && provider.models[0]?.id) {
        modelName = provider.models[0].id;
      }
    } catch {}
    const http = require('http');
    const body = JSON.stringify({
      model: modelName,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature,
    });
    const url = new URL(provider.baseUrl + '/chat/completions');
    return await new Promise((resolve) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const text = parsed?.choices?.[0]?.message?.content?.trim();
            resolve(text || null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    });
  } catch { return null; }
}
```

- [ ] **Step 2: Refactor `summarizeKnowledgeContent` to use `call9Router`**

Replace the HTTP boilerplate in `summarizeKnowledgeContent` (lines 8435-8496) with:

```javascript
async function summarizeKnowledgeContent(content, filename) {
  const fallback = () => {
    const stripped = (content || '').replace(/\s+/g, ' ').trim();
    return stripped.substring(0, 200) || `(không đọc được nội dung ${filename})`;
  };
  if (!content || content.length < 30) return fallback();
  const truncated = content.length > 4000 ? content.substring(0, 4000) + '...' : content;
  const result = await call9Router(
    `Tóm tắt file "${filename}" trong 1-2 câu tiếng Việt ngắn gọn (tối đa 200 ký tự). Chỉ trả về tóm tắt, không thêm giải thích.\n\n---\n${truncated}`,
    { maxTokens: 120, temperature: 0.3, timeoutMs: 15000 }
  );
  return result ? result.substring(0, 300) : fallback();
}
```

- [ ] **Step 3: Verify Knowledge tab still works**

Upload a test file in Knowledge tab, confirm summary is generated. This validates the refactored `call9Router` helper works end-to-end through the existing code path.

- [ ] **Step 4: Commit**

```bash
git add electron/main.js
git commit -m "refactor: extract call9Router helper from summarizeKnowledgeContent"
```

---

### Task 2: Rewrite `extractConversationHistory` with mtime filter + early-exit + per-customer cap

**Files:**
- Modify: `electron/main.js:1685-1767`

- [ ] **Step 1: Replace `extractConversationHistory` function**

The function is split into two: `extractConversationHistoryRaw` returns structured array (used by per-customer summary), `extractConversationHistory` returns formatted string (used by prompt builders). Replace lines 1685-1767 with:

```javascript
// Returns raw structured array of messages. Used by appendPerCustomerSummaries.
function extractConversationHistoryRaw({ sinceMs, maxMessages = 40, channels = ['openzalo', 'telegram'], maxPerSender = 0 } = {}) {
  try {
    const result = _extractConversationHistoryImpl({ sinceMs, maxMessages, channels, maxPerSender });
    return result.collected;
  } catch (e) {
    console.error('[extractConversationHistoryRaw] error:', e?.message || e);
    return [];
  }
}

// Returns formatted string. Used by prompt builders.
function extractConversationHistory({ sinceMs, maxMessages = 40, channels = ['openzalo', 'telegram'], maxPerSender = 0 } = {}) {
  try {
    const result = _extractConversationHistoryImpl({ sinceMs, maxMessages, channels, maxPerSender });
    return result.formatted;
  } catch (e) {
    console.error('[extractConversationHistory] error:', e?.message || e);
    return '';
  }
}

// Shared implementation — returns { collected: [...], formatted: 'string' }.
function _extractConversationHistoryImpl({ sinceMs, maxMessages = 40, channels = ['openzalo', 'telegram'], maxPerSender = 0 } = {}) {
  try {
    const sessionsDir = path.join(HOME, '.openclaw', 'agents', 'main', 'sessions');
    if (!fs.existsSync(sessionsDir)) return '';
    const allFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
    if (allFiles.length === 0) return '';

    // mtime pre-filter: skip files not modified since sinceMs.
    // Session files are append-only — if mtime < sinceMs, no new messages exist.
    const candidates = [];
    for (const f of allFiles) {
      const fp = path.join(sessionsDir, f);
      try {
        const stat = fs.statSync(fp);
        if (sinceMs && stat.mtimeMs < sinceMs) continue;
        candidates.push({ path: fp, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch { continue; }
    }
    if (candidates.length === 0) return '';

    // Sort newest first — early-exit once we have enough messages.
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const collectTarget = maxMessages * 2; // buffer for sorting/dedup

    const collected = [];
    for (const file of candidates) {
      // Tail-read optimization: for large files, read first 1KB (session event
      // with channel/sender metadata) + last 64KB (recent messages).
      let content;
      try {
        if (file.size > 65536) {
          const fd = fs.openSync(file.path, 'r');
          // Read first 1KB to capture the session event (always first line).
          const headBuf = Buffer.alloc(1024);
          fs.readSync(fd, headBuf, 0, 1024, 0);
          const headStr = headBuf.toString('utf-8').split('\n')[0] + '\n';
          // Read last 64KB for recent messages.
          const tailBuf = Buffer.alloc(65536);
          fs.readSync(fd, tailBuf, 0, 65536, file.size - 65536);
          fs.closeSync(fd);
          let tailStr = tailBuf.toString('utf-8');
          // Drop first partial line (may be truncated mid-JSON).
          const firstNl = tailStr.indexOf('\n');
          if (firstNl > 0) tailStr = tailStr.slice(firstNl + 1);
          content = headStr + tailStr;
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

      // Early-exit: enough messages collected, stop reading more files.
      if (collected.length >= collectTarget) break;
    }
    if (collected.length === 0) return '';

    collected.sort((a, b) => a.ts - b.ts);

    // Per-customer cap: prevent one chatty sender from dominating.
    // maxPerSender=0 means no cap (backward compat for callers that don't set it).
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
          // Keep first 2 + last (maxPerSender - 2) to capture conversation start + recent.
          const head = msgs.slice(0, 2);
          const tail = msgs.slice(-(maxPerSender - 2));
          capped.push(...head, ...tail);
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
      const channelLabel = m.channel === 'openzalo' ? 'Zalo' : m.channel === 'telegram' ? 'Telegram' : m.channel;
      const roleLabel = m.role === 'user'
        ? (m.sender ? m.sender.split(' id:')[0] : 'Khách')
        : 'Em (bot)';
      formatted.push(`[${timeStr}][${channelLabel}] ${roleLabel}: ${m.text}`);
    }
    console.log(`[extract] ${candidates.length}/${allFiles.length} files read, ${collected.length} msgs collected, ${recent.length} returned in ${Date.now() - _t0}ms`);
    return { collected: recent, formatted: formatted.join('\n') };
}
```

Note: `_t0` is declared at the top of `_extractConversationHistoryImpl`, right after the opening brace:
```javascript
  const _t0 = Date.now();
```

- [ ] **Step 3: Update callers to use `maxPerSender`**

In `buildMorningBriefingPrompt` (~line 6613):
```javascript
const history = extractConversationHistory({ sinceMs, maxMessages: 50, maxPerSender: 10 });
```

In `buildEveningSummaryPrompt` (~line 6635):
```javascript
const history = extractConversationHistory({ sinceMs, maxMessages: 50, maxPerSender: 10 });
```

In `buildWeeklyReportPrompt` (~line 6655):
```javascript
const history = extractConversationHistory({ sinceMs, maxMessages: 100, maxPerSender: 10 });
```

In `buildMonthlyReportPrompt` (~line 6675):
```javascript
const history = extractConversationHistory({ sinceMs, maxMessages: 200, maxPerSender: 10 });
```

`writeDailyMemoryJournal` keeps `maxPerSender: 0` (no cap — raw journal must capture everything).

- [ ] **Step 4: Commit**

```bash
git add electron/main.js
git commit -m "perf: extractConversationHistory mtime filter + early-exit + per-customer cap"
```

---

## Chunk 2: Daily/weekly summarization + per-customer memory

### Task 3: Add daily summary generation to `writeDailyMemoryJournal`

**Files:**
- Modify: `electron/main.js:1771-1789`

- [ ] **Step 1: Rewrite `writeDailyMemoryJournal` to also generate summary + per-customer append**

Replace lines 1771-1789 with:

```javascript
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

    return file;
  } catch (e) {
    console.error('[writeDailyMemoryJournal] error:', e?.message || e);
    return null;
  }
}
```

Note: `writeDailyMemoryJournal` is now `async`. All callers already wrap it in try/catch and don't await it (fire-and-forget in prompt builders). No caller changes needed — the sync return path still works for the raw journal write.

- [ ] **Step 2: Add `appendPerCustomerSummaries` function right after `writeDailyMemoryJournal`**

```javascript
// Group messages by Zalo customer, summarize each, append to their profile.
// Only processes openzalo messages (Telegram is CEO-only, no customer profiles).
async function appendPerCustomerSummaries(ws, dateStr, sinceMs) {
  // Use extractConversationHistoryRaw to get structured data directly.
  const collected = extractConversationHistoryRaw({ sinceMs, maxMessages: 500, channels: ['openzalo'], maxPerSender: 0 });
  if (!collected || collected.length === 0) return;

  // Group by sender id (extracted from sender label "Name id:12345").
  const bySender = new Map();
  for (const m of collected) {
    if (m.role !== 'user') continue; // only customer messages
    const idMatch = m.sender.match(/id:(\d+)/);
    if (!idMatch) continue;
    const senderId = idMatch[1];
    if (!bySender.has(senderId)) bySender.set(senderId, { name: m.sender.split(' id:')[0], msgs: [] });
    bySender.get(senderId).msgs.push(m);
  }

  const usersDir = path.join(ws, 'memory', 'zalo-users');

  for (const [senderId, { name, msgs }] of bySender) {
    if (msgs.length === 0) continue;

    const profilePath = path.join(usersDir, `${senderId}.md`);
    if (!fs.existsSync(profilePath)) continue; // no profile yet — bot creates these

    // Check if already appended for this date (idempotent).
    try {
      const existing = fs.readFileSync(profilePath, 'utf-8');
      if (existing.includes(`## ${dateStr}`)) continue;
    } catch { continue; }

    // Format messages for summarization.
    const customerHistory = msgs.map(m => {
      const dt = new Date(m.ts);
      const time = dt.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
      return `[${time}] ${name}: ${m.text}`;
    }).join('\n');
    let summary = null;
    try {
      summary = await call9Router(
        `Dưới đây là cuộc trò chuyện Zalo với khách "${name}" trong ngày ${dateStr}. ` +
        `Tóm tắt trong 2-4 bullet points ngắn gọn bằng tiếng Việt:\n` +
        `- Khách hỏi/yêu cầu gì\n` +
        `- Bot trả lời gì / kết quả\n` +
        `- Trạng thái: đã xong / chờ phản hồi / cần follow-up\n` +
        `Chỉ trả về bullet points.\n\n---\n${customerHistory}`,
        { maxTokens: 300, temperature: 0.2, timeoutMs: 10000 }
      );
    } catch {}

    // Fallback: if 9Router fails, append raw messages (verbose but no data loss).
    const appendContent = summary
      ? `\n\n## ${dateStr}\n${summary}\n`
      : `\n\n## ${dateStr}\n${customerHistory}\n`;

    try {
      fs.appendFileSync(profilePath, appendContent, 'utf-8');
      console.log(`[journal] appended ${dateStr} summary to zalo-users/${senderId}.md`);
    } catch (e) {
      console.warn(`[journal] append to ${senderId}.md failed:`, e?.message);
    }
  }
}
```

- [ ] **Step 3: Verify by checking logs after cron fires**

After morning cron: check `memory/YYYY-MM-DD-summary.md` exists and `memory/zalo-users/<id>.md` has new dated section. Console should show `[journal] summary written` and `[journal] appended` lines.

- [ ] **Step 4: Commit**

```bash
git add electron/main.js
git commit -m "feat: daily summary generation + per-customer conversation memory"
```

---

### Task 4: Update weekly/monthly prompt builders to use summaries

**Files:**
- Modify: `electron/main.js:6653-6691` (`buildWeeklyReportPrompt`, `buildMonthlyReportPrompt`)

- [ ] **Step 1: Add `loadDailySummaries` helper before the prompt builders (~line 6609)**

```javascript
// Load daily summaries for a date range. Falls back to raw journals for days
// where summary is missing (9Router was down). Returns combined text.
function loadDailySummaries(days) {
  const ws = getWorkspace();
  if (!ws) return '';
  const memDir = path.join(ws, 'memory');
  const parts = [];
  for (let i = days; i >= 1; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    // Prefer summary, fall back to raw journal.
    const summaryPath = path.join(memDir, `${dateStr}-summary.md`);
    const rawPath = path.join(memDir, `${dateStr}.md`);
    try {
      if (fs.existsSync(summaryPath)) {
        parts.push(fs.readFileSync(summaryPath, 'utf-8'));
      } else if (fs.existsSync(rawPath)) {
        parts.push(fs.readFileSync(rawPath, 'utf-8'));
      }
    } catch { continue; }
  }
  return parts.join('\n\n');
}

// Generate weekly summary from 7 daily summaries. Called on Monday by
// buildWeeklyReportPrompt. Cached to memory/week-YYYY-WNN-summary.md.
async function generateWeeklySummary() {
  const ws = getWorkspace();
  if (!ws) return null;
  const memDir = path.join(ws, 'memory');
  // ISO week number.
  const now = new Date();
  const jan1 = new Date(now.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((now - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  const weekLabel = `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
  const weekFile = path.join(memDir, `week-${weekLabel}-summary.md`);
  // Cached — skip if already exists.
  try {
    if (fs.existsSync(weekFile)) return fs.readFileSync(weekFile, 'utf-8');
  } catch {}
  // Load 7 daily summaries (falls back to raw journals).
  const dailies = loadDailySummaries(7);
  if (!dailies) return null;
  const summary = await call9Router(
    `Dưới đây là tóm tắt hoạt động 7 ngày qua. Tổng hợp thành BÁO CÁO TUẦN ngắn gọn:\n` +
    `- Tổng quan hoạt động\n- Khách hàng nổi bật\n- Vấn đề tồn đọng\n- Số liệu tổng hợp\n` +
    `Chỉ trả về bullet points.\n\n---\n${dailies.substring(0, 6000)}`,
    { maxTokens: 800, temperature: 0.2, timeoutMs: 20000 }
  );
  if (summary) {
    try {
      fs.writeFileSync(weekFile, `# Tóm tắt tuần ${weekLabel}\n\n${summary}\n`, 'utf-8');
      console.log(`[journal] weekly summary written: week-${weekLabel}-summary.md`);
    } catch {}
    return `# Tóm tắt tuần ${weekLabel}\n\n${summary}\n`;
  }
  // Fallback: return raw daily summaries.
  return dailies;
}

// Load the 4 most recent weekly summaries for monthly report.
// Falls back to daily summaries for weeks where weekly summary is missing.
function loadWeeklySummaries() {
  const ws = getWorkspace();
  if (!ws) return '';
  const memDir = path.join(ws, 'memory');
  const parts = [];
  for (let w = 4; w >= 1; w--) {
    const d = new Date(Date.now() - w * 7 * 86400000);
    const jan1 = new Date(d.getFullYear(), 0, 1);
    const weekNum = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
    const weekLabel = `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
    const weekFile = path.join(memDir, `week-${weekLabel}-summary.md`);
    try {
      if (fs.existsSync(weekFile)) {
        parts.push(fs.readFileSync(weekFile, 'utf-8'));
        continue;
      }
    } catch {}
    // Fallback: load daily summaries for that week.
    const weekDailies = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(d.getTime() + i * 86400000);
      const dateStr = day.toISOString().slice(0, 10);
      const sp = path.join(memDir, `${dateStr}-summary.md`);
      const rp = path.join(memDir, `${dateStr}.md`);
      try {
        if (fs.existsSync(sp)) weekDailies.push(fs.readFileSync(sp, 'utf-8'));
        else if (fs.existsSync(rp)) weekDailies.push(fs.readFileSync(rp, 'utf-8'));
      } catch {}
    }
    if (weekDailies.length > 0) parts.push(weekDailies.join('\n'));
  }
  return parts.join('\n\n');
}
```

- [ ] **Step 2: Rewrite `buildWeeklyReportPrompt`**

```javascript
async function buildWeeklyReportPrompt() {
  // Generate weekly summary (cached). Must be called before building prompt.
  await generateWeeklySummary();
  // Raw 24h for recency detail.
  const sinceMs24h = Date.now() - 24 * 60 * 60 * 1000;
  const recentRaw = extractConversationHistory({ sinceMs: sinceMs24h, maxMessages: 50, maxPerSender: 10 });
  // Daily summaries for full week coverage.
  const dailySummaries = loadDailySummaries(7);
  const recentBlock = recentRaw
    ? `\n\n--- TIN NHẮN 24H GẦN NHẤT (chi tiết) ---\n${recentRaw}\n--- HẾT ---\n\n`
    : '';
  const summaryBlock = dailySummaries
    ? `\n\n--- TÓM TẮT 7 NGÀY QUA (từ daily summaries, cover 100% tin nhắn) ---\n${dailySummaries}\n--- HẾT TÓM TẮT ---\n\n`
    : `\n\n_(Không có tóm tắt ngày nào trong 7 ngày qua.)_\n\n`;
  return (
    `Hôm nay là thứ 2. Hãy gửi BÁO CÁO TUẦN cho CEO qua Telegram.` +
    recentBlock + summaryBlock +
    `Dựa trên tóm tắt hàng ngày ở trên + tin nhắn 24h gần nhất + memory/ + knowledge + audit log, tổng hợp:\n` +
    `1. Tổng kết tuần qua: việc đã xong, deal đã chốt, khách mới qua Zalo/Telegram\n` +
    `2. Vấn đề tồn đọng / chưa giải quyết\n` +
    `3. Số liệu: tổng tin nhắn xử lý, cron đã chạy, khách Zalo mới kết bạn\n` +
    `4. Ưu tiên tuần tới\n` +
    `5. Đề xuất cải thiện (nếu có)\n\n` +
    `Trả lời bằng tiếng Việt, dùng tiêu đề **BÁO CÁO TUẦN** in đậm + bullet points. ` +
    `KHÔNG dùng emoji. KHÔNG hỏi lại CEO. Nếu data ít thì tóm ngắn, KHÔNG kêu CEO setup thêm gì.`
  );
}
```

- [ ] **Step 3: Rewrite `buildMonthlyReportPrompt`**

```javascript
function buildMonthlyReportPrompt() {
  // Raw 24h for recency.
  const sinceMs24h = Date.now() - 24 * 60 * 60 * 1000;
  const recentRaw = extractConversationHistory({ sinceMs: sinceMs24h, maxMessages: 50, maxPerSender: 10 });
  // 4 weekly summaries for full month coverage (per spec).
  const weeklySummaries = loadWeeklySummaries();
  const recentBlock = recentRaw
    ? `\n\n--- TIN NHẮN 24H GẦN NHẤT (chi tiết) ---\n${recentRaw}\n--- HẾT ---\n\n`
    : '';
  const summaryBlock = weeklySummaries
    ? `\n\n--- TÓM TẮT 4 TUẦN QUA (từ weekly summaries, cover 100% tin nhắn) ---\n${weeklySummaries}\n--- HẾT TÓM TẮT ---\n\n`
    : `\n\n_(Không có tóm tắt trong 30 ngày qua.)_\n\n`;
  return (
    `Ngày 1 tháng mới. Hãy gửi BÁO CÁO THÁNG cho CEO qua Telegram.` +
    recentBlock + summaryBlock +
    `Dựa trên tóm tắt hàng tuần + memory/ + knowledge, tổng hợp:\n` +
    `1. Tổng kết tháng: kết quả nổi bật, milestone đạt được\n` +
    `2. Khách hàng: khách mới, khách quay lại, khách mất (nếu có data)\n` +
    `3. Hoạt động bot: tổng tin xử lý, cron runs, errors (nếu có)\n` +
    `4. So sánh với tháng trước (nếu có data memory)\n` +
    `5. Kế hoạch + ưu tiên tháng tới\n\n` +
    `Trả lời bằng tiếng Việt, dùng tiêu đề **BÁO CÁO THÁNG** in đậm + bullet points. ` +
    `KHÔNG dùng emoji. KHÔNG hỏi lại CEO. Nếu data ít thì tóm ngắn.`
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add electron/main.js
git commit -m "feat: weekly/monthly prompts use daily summaries for full coverage"
```

---

## Chunk 3: Knowledge search reranking

### Task 5: Add query expansion + reranking to `search-documents`

**Files:**
- Modify: `electron/main.js:8844-8858` (`search-documents` IPC handler)

- [ ] **Step 1: Add `expandSearchQuery` helper above the IPC handler**

```javascript
// Expand a search query into Vietnamese synonyms via 9Router.
// Returns FTS5-safe expanded query string, or original on failure.
async function expandSearchQuery(query) {
  if (!query || query.length < 2) return query;
  try {
    const result = await call9Router(
      `Mở rộng truy vấn tìm kiếm sau thành 3-5 từ khóa đồng nghĩa tiếng Việt (và tiếng Anh nếu phù hợp). ` +
      `Chỉ trả về các từ khóa cách nhau bằng dấu phẩy, không giải thích.\n\nTruy vấn: "${query}"`,
      { maxTokens: 50, temperature: 0, timeoutMs: 2000 }
    );
    if (!result) return query;
    // Sanitize: strip FTS5 special chars, build OR query.
    const terms = result.split(/[,\n]/)
      .map(t => t.trim().replace(/[\"*()^+\-]/g, '').replace(/\b(NEAR|AND|NOT)\b/gi, ''))
      .filter(t => t.length > 1);
    if (terms.length === 0) return query;
    // Add original query as first term to guarantee it's included.
    const allTerms = [query, ...terms];
    return allTerms.map(t => `"${t.replace(/"/g, '')}"`).join(' OR ');
  } catch { return query; }
}
```

- [ ] **Step 2: Add `rerankSearchResults` helper**

```javascript
// Rerank FTS5 results using 9Router for semantic relevance.
// Returns reordered subset, or original results on failure.
async function rerankSearchResults(query, results) {
  if (!results || results.length <= 1) return results;
  try {
    const candidateList = results.map((r, i) =>
      `${i + 1}. ${r.filename} — ${(r.snippet || '').replace(/\*\*/g, '').substring(0, 200)}`
    ).join('\n');
    const result = await call9Router(
      `Người dùng tìm: "${query}"\n\n` +
      `Kết quả tìm được:\n${candidateList}\n\n` +
      `Xếp hạng lại theo mức độ liên quan. Trả về CHỈ các số thứ tự (VD: 3,1,5,2,4), ` +
      `kết quả liên quan nhất trước. Không giải thích.`,
      { maxTokens: 50, temperature: 0, timeoutMs: 3000 }
    );
    if (!result) return results;
    // Parse ranking: extract numbers from response.
    const ranks = result.match(/\d+/g);
    if (!ranks || ranks.length === 0) return results;
    const reordered = [];
    const seen = new Set();
    for (const r of ranks) {
      const idx = parseInt(r, 10) - 1;
      if (idx >= 0 && idx < results.length && !seen.has(idx)) {
        reordered.push(results[idx]);
        seen.add(idx);
      }
    }
    // Append any results not mentioned by LLM (don't drop them).
    for (let i = 0; i < results.length; i++) {
      if (!seen.has(i)) reordered.push(results[i]);
    }
    return reordered;
  } catch { return results; }
}
```

- [ ] **Step 3: Rewrite `search-documents` IPC handler**

Replace lines 8844-8858:

```javascript
ipcMain.handle('search-documents', async (_event, query) => {
  try {
    const db = getDocumentsDb();
    if (!db) return [];
    // Layer 1: expand query for better recall.
    const expandedQuery = await expandSearchQuery(query);
    if (expandedQuery !== query) console.log(`[search] expanded "${query}" → "${expandedQuery}"`);
    // Layer 2: FTS5 search with expanded query.
    let results;
    try {
      results = db.prepare(`
        SELECT d.filename, d.filetype, d.word_count, d.created_at,
               snippet(documents_fts, 1, '**', '**', '...', 32) as snippet
        FROM documents_fts f
        JOIN documents d ON d.filename = f.filename
        WHERE documents_fts MATCH ?
        ORDER BY rank
        LIMIT 10
      `).all(expandedQuery);
    } catch {
      // Expanded query may have FTS5 syntax issues — fall back to original.
      results = db.prepare(`
        SELECT d.filename, d.filetype, d.word_count, d.created_at,
               snippet(documents_fts, 1, '**', '**', '...', 32) as snippet
        FROM documents_fts f
        JOIN documents d ON d.filename = f.filename
        WHERE documents_fts MATCH ?
        ORDER BY rank
        LIMIT 10
      `).all(query);
    }
    db.close();
    if (results.length === 0) return results;
    // Layer 3: rerank for semantic relevance.
    return await rerankSearchResults(query, results);
  } catch (e) { return []; }
});
```

- [ ] **Step 4: Test Knowledge search**

In Dashboard Knowledge tab, search "bao hanh" — should return docs about warranty/return policy even if they use different terms. Console should show expanded query.

- [ ] **Step 5: Commit**

```bash
git add electron/main.js
git commit -m "feat: knowledge search query expansion + semantic reranking via 9Router"
```

---

## Chunk 4: Verification + final commit

### Task 6: End-to-end verification

- [ ] **Step 1: Verify Part A — extraction speed**

Start the app, open console. Trigger a cron test from Dashboard. Console should show:
```
[extract] 3/150 files read, 45 msgs collected, 45 returned in 23ms
```
Confirm file count is much lower than total. Confirm time is <100ms.

- [ ] **Step 2: Verify Part B — summary generation**

After morning cron fires, check:
```bash
ls ~/.openclaw/workspace/memory/*summary*
```
Should see `YYYY-MM-DD-summary.md`. Read it — should be bullet points, not raw messages.

- [ ] **Step 3: Verify Part C — knowledge search**

Upload a doc about "chinh sach doi tra" in Knowledge tab. Search "bao hanh". The doc should appear in results (it wouldn't before without keyword match).

- [ ] **Step 4: Verify Part D — per-customer memory**

Check a Zalo customer profile after daily journal runs:
```bash
cat ~/.openclaw/workspace/memory/zalo-users/<some-id>.md
```
Should have a `## 2026-04-10` section with conversation summary.

- [ ] **Step 5: Verify fresh-install parity (RULE #1)**

Mental-simulate: RESET.bat → RUN.bat → wizard → first cron.
- `extractConversationHistory`: sessions dir empty → returns '' → OK
- `writeDailyMemoryJournal`: no history → writes empty journal → summary skipped → OK
- `search-documents`: FTS5 empty → expandSearchQuery gets no results → returns [] → OK
- `appendPerCustomerSummaries`: no zalo-users profiles yet → skips → OK

All paths handle empty state gracefully.

- [ ] **Step 6: Final commit if any fixes needed**

```bash
git add electron/main.js
git commit -m "fix: context optimization edge cases from verification"
```
