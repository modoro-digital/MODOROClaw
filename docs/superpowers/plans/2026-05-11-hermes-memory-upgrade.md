# Hermes-Style Memory Upgrade Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Hermes-style 2-tier memory (hot CEO-MEMORY.md + cold SQLite with embeddings) so the bot learns from CEO corrections, recalls decisions semantically, and detects cross-customer patterns.

**Architecture:** Hot tier (`CEO-MEMORY.md`) auto-loaded into every agent session via workspace contextInjection. Cold tier (`ceo_memories` table in `memory.db`) with FTS5 + e5-small embeddings for hybrid search. Nudge fires after CEO idle 5min (or immediately on correction), spawns agent WITHOUT `--deliver`, parses JSON output, writes memories in-process.

**Tech Stack:** SQLite (better-sqlite3), FTS5, e5-small embeddings (existing knowledge.js), spawnOpenClawSafe (existing boot.js), Cron API HTTP (existing cron-api.js)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `electron/lib/ceo-memory.js` | **NEW** — SQLite schema, CRUD, FTS5 index, embedding, hybrid search, CEO-MEMORY.md regeneration, relevance decay |
| `electron/lib/cron-api.js` | **MODIFY** — Add 3 `/api/memory/*` route handlers inside request dispatcher |
| `electron/lib/cron.js` | **MODIFY** — Add evening pattern detection after `appendPerCustomerSummaries()` |
| `electron/main.js` | **MODIFY** — Nudge timer, correction detection, `_lastCeoMessageAt` tracking |
| `electron/lib/dashboard-ipc.js` | **MODIFY** — Add `get-ceo-memories`, `delete-ceo-memory` IPC handlers |
| `electron/preload.js` | **MODIFY** — Add 2 memory IPC bridges |
| `electron/ui/dashboard.html` | **MODIFY** — Overview badge + memory list modal |
| `electron/lib/workspace.js` | **MODIFY** — Seed empty `CEO-MEMORY.md` |
| `AGENTS.md` | **MODIFY** — Add memory tool documentation section |
| `electron/scripts/smoke-test.js` | **MODIFY** — Add ceo-memory module smoke checks |

---

## Chunk 1: Core Memory Module

### Task 1: Create `ceo-memory.js` — schema + CRUD

**Files:**
- Create: `electron/lib/ceo-memory.js`
- Modify: `electron/lib/workspace.js` (seedWorkspace)

- [ ] **Step 1: Create ceo-memory.js with schema init**

```javascript
// electron/lib/ceo-memory.js
'use strict';
const fs = require('fs');
const path = require('path');

let _db = null;
const CURRENT_MODEL_VERSION = 'e5-small-v1';
const MAX_CONTENT_LENGTH = 500;
const HOT_TIER_MAX_CHARS = 8000;
const VALID_TYPES = ['rule', 'pattern', 'preference', 'fact', 'correction'];
const VALID_SOURCES = ['nudge', 'ceo_correction', 'evening_summary', 'manual'];

function getMemoryDb() {
  if (_db) return _db;
  try {
    const { getWorkspace } = require('./workspace');
    const ws = getWorkspace();
    if (!ws) return null;
    const dbPath = path.join(ws, 'memory.db');
    const Database = require('better-sqlite3');
    _db = new Database(dbPath);
    _db.pragma('journal_mode = WAL');
    ensureSchema(_db);
    return _db;
  } catch (e) {
    console.error('[ceo-memory] db init failed:', e?.message);
    return null;
  }
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ceo_memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'nudge',
      embedding BLOB,
      relevance_score REAL NOT NULL DEFAULT 1.0,
      model_version TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ceo_mem_type ON ceo_memories(type);
    CREATE INDEX IF NOT EXISTS idx_ceo_mem_score ON ceo_memories(relevance_score DESC);
  `);
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ceo_memory_fts USING fts5(
      content, tokenize='unicode61'
    )`);
  } catch (e) {
    if (!String(e?.message).includes('already exists')) throw e;
  }
}

module.exports = {
  getMemoryDb,
  ensureSchema,
  CURRENT_MODEL_VERSION,
  MAX_CONTENT_LENGTH,
  HOT_TIER_MAX_CHARS,
  VALID_TYPES,
  VALID_SOURCES,
};
```

- [ ] **Step 2: Verify module loads**

Run: `node -e "require('./electron/lib/ceo-memory.js'); console.log('OK')"`
Expected: `OK`

- [ ] **Step 3: Add writeMemory function**

Append to `ceo-memory.js`:

```javascript
function writeMemory({ type, content, source = 'nudge' }) {
  if (!VALID_TYPES.includes(type)) throw new Error('invalid type: ' + type);
  if (!content || typeof content !== 'string') throw new Error('content required');
  const cleaned = content.replace(/^#{1,3}\s+/gm, '').trim();
  if (cleaned.length > MAX_CONTENT_LENGTH) throw new Error('content too long (max ' + MAX_CONTENT_LENGTH + ')');
  if (source && !VALID_SOURCES.includes(source)) source = 'manual';

  const db = getMemoryDb();
  if (!db) throw new Error('memory db unavailable');

  const id = 'mem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const now = new Date().toISOString();
  const score = type === 'correction' ? 1.5 : 1.0;

  let embeddingBlob = null;
  try {
    const { embedText, vecToBlob } = require('./knowledge');
    const vec = embedText(cleaned, false);
    embeddingBlob = vecToBlob(vec);
  } catch (e) {
    console.warn('[ceo-memory] embedding failed, storing without vector:', e?.message);
  }

  const stmt = db.prepare(`INSERT INTO ceo_memories (id, type, content, source, embedding, relevance_score, model_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  stmt.run(id, type, cleaned, source, embeddingBlob, score, embeddingBlob ? CURRENT_MODEL_VERSION : null, now, now);

  db.prepare(`INSERT INTO ceo_memory_fts (rowid, content) VALUES ((SELECT rowid FROM ceo_memories WHERE id = ?), ?)`).run(id, cleaned);

  scheduleRegeneration();
  return { id, created_at: now };
}
```

- [ ] **Step 4: Add deleteMemory function**

```javascript
function deleteMemory(id) {
  const db = getMemoryDb();
  if (!db) throw new Error('memory db unavailable');

  const row = db.prepare('SELECT rowid FROM ceo_memories WHERE id = ?').get(id);
  if (!row) return { deleted: false, reason: 'not found' };

  db.prepare('DELETE FROM ceo_memory_fts WHERE rowid = ?').run(row.rowid);
  db.prepare('DELETE FROM ceo_memories WHERE id = ?').run(id);

  scheduleRegeneration();
  return { deleted: true };
}
```

- [ ] **Step 5: Add hybrid searchMemory function**

```javascript
function searchMemory(query, { limit = 5 } = {}) {
  const db = getMemoryDb();
  if (!db) return [];
  if (!query || typeof query !== 'string') return [];

  const now = Date.now();
  const allRows = db.prepare('SELECT id, type, content, source, embedding, relevance_score, model_version, created_at, updated_at FROM ceo_memories').all();
  if (allRows.length === 0) return [];

  // FTS5 keyword search
  const ftsScores = {};
  try {
    const ftsRows = db.prepare(`SELECT m.id, fts.rank FROM ceo_memory_fts fts
      JOIN ceo_memories m ON m.rowid = fts.rowid
      WHERE ceo_memory_fts MATCH ? ORDER BY fts.rank LIMIT 50`).all(query);
    for (const r of ftsRows) {
      ftsScores[r.id] = 1.0 / (1.0 + Math.abs(r.rank));
    }
  } catch {}

  // Embedding cosine similarity
  const cosineScores = {};
  try {
    const { embedText, blobToVec, cosineSim } = require('./knowledge');
    const queryVec = embedText(query, true);
    for (const row of allRows) {
      if (row.embedding) {
        const vec = blobToVec(row.embedding);
        cosineScores[row.id] = Math.max(0, cosineSim(queryVec, vec));
      }
    }
  } catch (e) {
    console.warn('[ceo-memory] embedding search failed, using FTS only:', e?.message);
  }

  // Score and rank
  const scored = allRows.map(row => {
    const daysSince = (now - new Date(row.updated_at).getTime()) / 86400000;
    const effectiveRelevance = Math.max(0, row.relevance_score - 0.02 * daysSince);
    const fts = ftsScores[row.id] || 0;
    const cos = cosineScores[row.id] || 0;
    const score = 0.4 * fts + 0.4 * cos + 0.2 * effectiveRelevance;
    return { id: row.id, type: row.type, content: row.content, source: row.source, score, created_at: row.created_at };
  });

  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, limit).filter(r => r.score > 0);

  // Bump relevance on accessed entries
  const bumpStmt = db.prepare('UPDATE ceo_memories SET relevance_score = relevance_score + 0.1, updated_at = ? WHERE id = ?');
  const nowIso = new Date().toISOString();
  for (const r of results) {
    bumpStmt.run(nowIso, r.id);
  }

  return results;
}
```

- [ ] **Step 6: Add listMemories function**

```javascript
function listMemories({ limit = 100 } = {}) {
  const db = getMemoryDb();
  if (!db) return [];
  const now = Date.now();
  const rows = db.prepare('SELECT id, type, content, source, relevance_score, created_at, updated_at FROM ceo_memories ORDER BY created_at DESC LIMIT ?').all(limit);
  return rows.map(r => {
    const daysSince = (now - new Date(r.updated_at).getTime()) / 86400000;
    return { ...r, effective_score: Math.max(0, r.relevance_score - 0.02 * daysSince) };
  });
}

function getMemoryCount() {
  const db = getMemoryDb();
  if (!db) return 0;
  const row = db.prepare('SELECT COUNT(*) as cnt FROM ceo_memories').get();
  return row?.cnt || 0;
}

function getLastMemoryAt() {
  const db = getMemoryDb();
  if (!db) return null;
  const row = db.prepare('SELECT created_at FROM ceo_memories ORDER BY created_at DESC LIMIT 1').get();
  return row?.created_at || null;
}
```

- [ ] **Step 7: Add CEO-MEMORY.md regeneration with debounce**

```javascript
let _regenTimer = null;

function scheduleRegeneration() {
  if (_regenTimer) clearTimeout(_regenTimer);
  _regenTimer = setTimeout(() => {
    _regenTimer = null;
    try { regenerateCeoMemoryFile(); } catch (e) {
      console.error('[ceo-memory] regeneration failed:', e?.message);
    }
  }, 2000);
}

function regenerateCeoMemoryFile() {
  const db = getMemoryDb();
  if (!db) return;
  const { getWorkspace } = require('./workspace');
  const ws = getWorkspace();
  if (!ws) return;

  const now = Date.now();
  const allRows = db.prepare('SELECT id, type, content, relevance_score, updated_at FROM ceo_memories').all();

  // Sort by effective score
  const sorted = allRows.map(r => {
    const daysSince = (now - new Date(r.updated_at).getTime()) / 86400000;
    return { ...r, effective: Math.max(0, r.relevance_score - 0.02 * daysSince) };
  }).sort((a, b) => b.effective - a.effective);

  // Build sections grouped by type, respecting char budget
  const groups = {};
  let totalChars = 0;
  for (const r of sorted) {
    if (totalChars + r.content.length > HOT_TIER_MAX_CHARS) break;
    if (!groups[r.type]) groups[r.type] = [];
    groups[r.type].push(r.content);
    totalChars += r.content.length + 3; // +3 for "- " prefix + newline
  }

  const typeLabels = {
    correction: 'Quy tac da sua',
    rule: 'Quy tac da hoc',
    preference: 'So thich cua sep',
    pattern: 'Patterns khach hang',
    fact: 'Su kien quan trong',
  };

  let md = '# Bo nho bot\n\n';
  for (const type of ['correction', 'rule', 'preference', 'pattern', 'fact']) {
    if (groups[type]?.length) {
      md += `## ${typeLabels[type]}\n`;
      for (const line of groups[type]) {
        md += `- ${line}\n`;
      }
      md += '\n';
    }
  }

  const filePath = path.join(ws, 'CEO-MEMORY.md');
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  if (md.trim() !== current.trim()) {
    fs.writeFileSync(filePath, md, 'utf-8');
    console.log('[ceo-memory] CEO-MEMORY.md regenerated (' + totalChars + ' chars, ' + sorted.length + ' memories considered)');
  }
}
```

- [ ] **Step 8: Export all functions**

```javascript
module.exports = {
  getMemoryDb,
  ensureSchema,
  writeMemory,
  deleteMemory,
  searchMemory,
  listMemories,
  getMemoryCount,
  getLastMemoryAt,
  regenerateCeoMemoryFile,
  CURRENT_MODEL_VERSION,
  MAX_CONTENT_LENGTH,
  HOT_TIER_MAX_CHARS,
  VALID_TYPES,
  VALID_SOURCES,
};
```

- [ ] **Step 9: Seed CEO-MEMORY.md in workspace.js**

In `electron/lib/workspace.js`, find the `templateFiles` array in `seedWorkspace()` and add `'CEO-MEMORY.md'`. Also add a fallback empty file creation:

```javascript
// After templateFiles copy loop
const ceoMemPath = path.join(ws, 'CEO-MEMORY.md');
if (!fs.existsSync(ceoMemPath)) {
  try { fs.writeFileSync(ceoMemPath, '# Bo nho bot\n\n_Chua co gi. Bot se tu hoc tu cuoc hoi thoai voi sep._\n', 'utf-8'); } catch {}
}
```

- [ ] **Step 10: Commit**

```bash
git add electron/lib/ceo-memory.js electron/lib/workspace.js
git commit -m "feat: add ceo-memory.js — SQLite schema, CRUD, FTS5, embedding, hybrid search, CEO-MEMORY.md regeneration"
```

---

### Task 2: Cron API memory endpoints

**Files:**
- Modify: `electron/lib/cron-api.js`

- [ ] **Step 1: Add memory route handlers inside the request dispatcher**

In `cron-api.js`, find the request dispatcher `if/else if` chain (the block that handles `urlPath === '/api/cron/create'` etc.) and add before the final `else`:

```javascript
    // === CEO MEMORY API ===
    if (urlPath === '/api/memory/write') {
      if (req.method !== 'POST') return jsonResp(res, 405, { error: 'POST required' });
      const { writeMemory, VALID_TYPES } = require('./ceo-memory');
      const type = String(params.type || '').trim();
      const content = String(params.content || '').trim();
      const source = String(params.source || 'manual').trim();
      if (!type) return jsonResp(res, 400, { error: 'type required. Valid: ' + VALID_TYPES.join(', ') });
      if (!content) return jsonResp(res, 400, { error: 'content required' });
      try {
        const result = writeMemory({ type, content, source });
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
        const results = searchMemory(query, { limit });
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
```

- [ ] **Step 2: Verify endpoints work**

Start the app, then test:
```bash
curl -X POST http://127.0.0.1:20200/api/memory/write -H "Authorization: Bearer $(cat ~/.openclaw/workspace/cron-api-token.txt)" -H "Content-Type: application/json" -d "{\"type\":\"fact\",\"content\":\"Test memory entry\"}"
```
Expected: `{"id":"mem_...","created_at":"..."}`

- [ ] **Step 3: Commit**

```bash
git add electron/lib/cron-api.js
git commit -m "feat: add /api/memory/* endpoints to cron API"
```

---

## Chunk 2: Nudge Mechanism + Evening Patterns

### Task 3: Nudge timer and correction detection in main.js

**Files:**
- Modify: `electron/main.js`

- [ ] **Step 1: Add nudge state variables near top of main.js**

Find the global state section (near other `let _xxx` declarations) and add:

```javascript
// CEO memory nudge state
let _lastCeoMessageAt = 0;
let _lastNudgeAt = 0;
let _nudgeImmediate = false;
let _nudgeTimerId = null;
const _CORRECTION_PATTERNS = [
  /không phải/i, /khong phai/i,
  /sai rồi/i, /sai roi/i,
  /nhớ là/i, /nho la/i,
  /luôn luôn/i, /luon luon/i,
  /đừng bao giờ/i, /dung bao gio/i,
  /từ giờ/i, /tu gio/i,
  /phải là/i, /phai la/i,
];
```

- [ ] **Step 2: Add CEO message detection via audit.jsonl tailing**

```javascript
function startCeoMessageWatcher() {
  const ws = getWorkspace();
  if (!ws) return;
  const auditPath = path.join(ws, 'logs', 'audit.jsonl');
  let lastSize = 0;
  try { lastSize = fs.existsSync(auditPath) ? fs.statSync(auditPath).size : 0; } catch {}

  setInterval(() => {
    try {
      if (!fs.existsSync(auditPath)) return;
      const stat = fs.statSync(auditPath);
      if (stat.size <= lastSize) { lastSize = stat.size; return; }
      const fd = fs.openSync(auditPath, 'r');
      const buf = Buffer.alloc(Math.min(stat.size - lastSize, 4096));
      fs.readSync(fd, buf, 0, buf.length, lastSize);
      fs.closeSync(fd);
      lastSize = stat.size;
      const lines = buf.toString('utf-8').split('\n').filter(Boolean);
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
```

- [ ] **Step 3: Add nudge timer**

```javascript
function startNudgeTimer() {
  if (_nudgeTimerId) return;
  _nudgeTimerId = setInterval(async () => {
    const now = Date.now();
    const idle = now - _lastCeoMessageAt;
    const shouldNudge = (_nudgeImmediate && _lastCeoMessageAt > _lastNudgeAt)
      || (idle > 300000 && _lastCeoMessageAt > _lastNudgeAt);
    if (!shouldNudge) return;

    _lastNudgeAt = now;
    _nudgeImmediate = false;
    try {
      await runMemoryNudge();
    } catch (e) {
      console.error('[nudge] error:', e?.message);
    }
  }, 60000);
}

async function runMemoryNudge() {
  console.log('[nudge] firing memory nudge...');
  const { getWorkspace } = require('./lib/workspace');
  const ws = getWorkspace();
  if (!ws) return;

  // Read current CEO-MEMORY.md
  const memPath = path.join(ws, 'CEO-MEMORY.md');
  const currentMem = fs.existsSync(memPath) ? fs.readFileSync(memPath, 'utf-8') : '(empty)';

  // Extract last conversation (last 30min of session logs)
  let transcript = '';
  try {
    const { extractConversationHistory } = require('./lib/conversation');
    transcript = extractConversationHistory({ sinceMs: 30 * 60 * 1000, maxMessages: 30, channelFilter: 'telegram' });
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

  const { spawnOpenClawSafe } = require('./lib/boot');
  const result = await spawnOpenClawSafe(
    ['agent', '--message', prompt, '--json'],
    { timeoutMs: 120000 }
  );

  if (result.code !== 0) {
    console.warn('[nudge] agent exited with code', result.code);
    return;
  }

  // Parse JSON from stdout (may contain non-JSON preamble)
  let parsed;
  try {
    const jsonMatch = result.stdout.match(/\{[\s\S]*"memories"[\s\S]*\}/);
    if (!jsonMatch) { console.log('[nudge] no JSON in output'); return; }
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.warn('[nudge] JSON parse failed:', e?.message);
    return;
  }

  if (!Array.isArray(parsed.memories) || parsed.memories.length === 0) {
    console.log('[nudge] nothing worth remembering');
    return;
  }

  const { writeMemory, deleteMemory } = require('./lib/ceo-memory');
  let wrote = 0, deleted = 0;
  for (const mem of parsed.memories) {
    try {
      if (mem.action === 'write' && mem.content) {
        writeMemory({ type: mem.type || 'fact', content: mem.content, source: _nudgeImmediate ? 'ceo_correction' : 'nudge' });
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
  try { auditLog('memory_nudge', { wrote, deleted }); } catch {}
}
```

- [ ] **Step 4: Wire nudge into boot sequence**

In `main.js`, find the `app.whenReady()` block after `startCronJobs()` and add:

```javascript
startCeoMessageWatcher();
startNudgeTimer();
```

Also add the same two calls in the `wizard-complete` IPC handler, after `startCronJobs()`.

- [ ] **Step 5: Commit**

```bash
git add electron/main.js
git commit -m "feat: add CEO memory nudge — fires after 5min idle or immediate on correction"
```

---

### Task 4: Evening summary pattern detection

**Files:**
- Modify: `electron/lib/cron.js`

- [ ] **Step 1: Add pattern detection after appendPerCustomerSummaries**

Find `appendPerCustomerSummaries()` in `cron.js`. After the function body's main loop completes (after all per-customer summaries are written), add:

```javascript
  // Cross-customer pattern detection for CEO memory
  try {
    if (perCustomerSummaries.length >= 3) {
      const combined = perCustomerSummaries.map(s => s.summary || '').join(' ').slice(0, 1000);
      if (combined.length > 100) {
        const { searchMemory, writeMemory } = require('./ceo-memory');
        const existing = searchMemory(combined, { limit: 1 });
        if (existing.length > 0 && existing[0].score > 0.85) {
          console.log('[ceo-memory] evening pattern already stored, boosting relevance');
        } else {
          const patternPrompt = `${perCustomerSummaries.length} khach hoi hom nay. Chu de chinh: ${combined.slice(0, 300)}`;
          writeMemory({ type: 'pattern', content: patternPrompt.slice(0, 500), source: 'evening_summary' });
          console.log('[ceo-memory] evening pattern written from ' + perCustomerSummaries.length + ' customers');
        }
      }
    }
  } catch (e) {
    console.warn('[ceo-memory] evening pattern detection failed:', e?.message);
  }
```

- [ ] **Step 2: Commit**

```bash
git add electron/lib/cron.js
git commit -m "feat: evening summary cross-customer pattern detection → CEO memory"
```

---

## Chunk 3: Dashboard Integration + AGENTS.md

### Task 5: Dashboard IPC handlers

**Files:**
- Modify: `electron/lib/dashboard-ipc.js`
- Modify: `electron/preload.js`

- [ ] **Step 1: Add IPC handlers in dashboard-ipc.js**

Add near other memory-related handlers:

```javascript
// CEO Memory (Hermes-style learned knowledge)
ipcMain.handle('get-ceo-memories', async () => {
  try {
    const { listMemories, getMemoryCount, getLastMemoryAt } = require('./ceo-memory');
    return { memories: listMemories({ limit: 100 }), count: getMemoryCount(), lastAt: getLastMemoryAt() };
  } catch (e) {
    console.error('[ceo-memory] list error:', e?.message);
    return { memories: [], count: 0, lastAt: null };
  }
});

ipcMain.handle('delete-ceo-memory', async (_event, { id }) => {
  try {
    const { deleteMemory } = require('./ceo-memory');
    return deleteMemory(id);
  } catch (e) {
    console.error('[ceo-memory] delete error:', e?.message);
    return { deleted: false, reason: e?.message };
  }
});
```

- [ ] **Step 2: Add preload bridges in preload.js**

Find the `contextBridge.exposeInMainWorld('claw', { ... })` block and add:

```javascript
  getCeoMemories: () => ipcRenderer.invoke('get-ceo-memories'),
  deleteCeoMemory: (id) => ipcRenderer.invoke('delete-ceo-memory', { id }),
```

- [ ] **Step 3: Commit**

```bash
git add electron/lib/dashboard-ipc.js electron/preload.js
git commit -m "feat: add CEO memory IPC handlers + preload bridges"
```

---

### Task 6: Dashboard UI — overview badge + memory list

**Files:**
- Modify: `electron/ui/dashboard.html`

- [ ] **Step 1: Add memory badge to Overview page**

Find the Overview hero section (near `ov-bot-status`). Add after the bot status pill:

```html
<div id="ov-memory-badge" style="display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:6px;background:var(--surface-2);font-size:13px;cursor:pointer" onclick="showMemoryModal()">
  <span style="color:var(--text-2)">Bot da hoc:</span>
  <span id="ov-memory-count" style="font-weight:600">0</span>
</div>
```

- [ ] **Step 2: Add memory list modal**

Add before closing `</body>`:

```html
<sl-dialog id="memory-modal" label="Bo nho bot" style="--width:600px">
  <div id="memory-list" style="max-height:400px;overflow-y:auto"></div>
  <div slot="footer"><sl-button variant="default" onclick="document.getElementById('memory-modal').hide()">Dong</sl-button></div>
</sl-dialog>
```

- [ ] **Step 3: Add memory UI JavaScript**

```javascript
async function loadMemoryBadge() {
  try {
    const data = await window.claw.getCeoMemories();
    const el = document.getElementById('ov-memory-count');
    if (el) el.textContent = String(data.count || 0);
  } catch {}
}

async function showMemoryModal() {
  const data = await window.claw.getCeoMemories();
  const list = document.getElementById('memory-list');
  if (!data.memories?.length) {
    list.innerHTML = '<p style="color:var(--text-2);padding:16px">Chua co ky uc nao. Bot se tu hoc tu cuoc hoi thoai voi sep.</p>';
  } else {
    const typeLabels = { correction: 'Sua loi', rule: 'Quy tac', preference: 'So thich', pattern: 'Pattern', fact: 'Su kien' };
    list.innerHTML = data.memories.map(m => `
      <div style="display:flex;align-items:flex-start;gap:8px;padding:10px 0;border-bottom:1px solid var(--border)">
        <span style="flex-shrink:0;padding:2px 8px;border-radius:4px;background:var(--surface-2);font-size:11px;color:var(--text-2)">${typeLabels[m.type] || m.type}</span>
        <span style="flex:1;font-size:13px">${escapeHtml(m.content)}</span>
        <button style="flex-shrink:0;background:none;border:none;color:var(--text-3);cursor:pointer;font-size:16px" onclick="deleteCeoMemory('${m.id}')" title="Xoa">x</button>
      </div>
    `).join('');
  }
  document.getElementById('memory-modal').show();
}

async function deleteCeoMemory(id) {
  await window.claw.deleteCeoMemory(id);
  await showMemoryModal();
  await loadMemoryBadge();
}
```

- [ ] **Step 4: Wire loadMemoryBadge into overview refresh**

Find `loadOverviewData()` or the overview page refresh function. Add `loadMemoryBadge();` at the end.

- [ ] **Step 5: Commit**

```bash
git add electron/ui/dashboard.html
git commit -m "feat: dashboard memory badge + list modal"
```

---

### Task 7: AGENTS.md tool documentation

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Add memory tools section to AGENTS.md**

Add after the existing cron/tool documentation section:

```markdown
## Bo nho bot (CEO Memory)

Bot co the luu va truy xuat ky uc qua Cron API. Dung khi:
- CEO sua loi bot ("khong phai vay") → luu `correction`
- Hoc duoc quy tac moi tu CEO → luu `rule`
- Phat hien pattern khach hang → luu `pattern`

### Luu ky uc
POST http://127.0.0.1:20200/api/memory/write
Header: Authorization: Bearer <token tu cron-api-token.txt>
Body: {"type":"rule","content":"Khach hoi bao hanh → 12 thang"}
Type: rule | pattern | preference | fact | correction

### Tim ky uc
POST http://127.0.0.1:20200/api/memory/search
Body: {"query":"bao hanh","limit":5}

### Xoa ky uc
POST http://127.0.0.1:20200/api/memory/delete
Body: {"id":"mem_..."}

KHONG tu y goi memory/write trong hoi thoai thuong. He thong nudge se tu dong review va luu sau moi cuoc hoi thoai CEO.
```

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "feat: add CEO memory tool documentation to AGENTS.md"
```

---

### Task 8: Smoke test

**Files:**
- Modify: `electron/scripts/smoke-test.js`

- [ ] **Step 1: Add ceo-memory smoke checks**

Find the smoke test file's test section and add:

```javascript
// CEO Memory module
try {
  const ceoMem = require('../lib/ceo-memory');
  if (typeof ceoMem.writeMemory !== 'function') fail('ceo-memory', 'writeMemory not exported');
  else if (typeof ceoMem.searchMemory !== 'function') fail('ceo-memory', 'searchMemory not exported');
  else if (typeof ceoMem.deleteMemory !== 'function') fail('ceo-memory', 'deleteMemory not exported');
  else if (typeof ceoMem.regenerateCeoMemoryFile !== 'function') fail('ceo-memory', 'regenerateCeoMemoryFile not exported');
  else if (!Array.isArray(ceoMem.VALID_TYPES) || ceoMem.VALID_TYPES.length !== 5) fail('ceo-memory', 'VALID_TYPES wrong');
  else pass('ceo-memory module exports intact');
} catch (e) {
  fail('ceo-memory', 'module load failed: ' + e.message);
}
```

- [ ] **Step 2: Run smoke test**

Run: `node electron/scripts/smoke-test.js`
Expected: `PASS  ceo-memory module exports intact`

- [ ] **Step 3: Commit**

```bash
git add electron/scripts/smoke-test.js
git commit -m "test: add ceo-memory smoke checks"
```

---

## Verification

After all tasks, verify end-to-end:

1. Start app → `CEO-MEMORY.md` exists in workspace (seeded by workspace.js)
2. `curl POST /api/memory/write` → memory stored, `CEO-MEMORY.md` regenerated within 2s
3. `curl POST /api/memory/search` → hybrid results returned
4. `curl POST /api/memory/delete` → memory removed, `CEO-MEMORY.md` updated
5. Dashboard Overview → memory badge shows count
6. Click badge → modal shows memories with delete buttons
7. Send CEO a Telegram message with "không phải" → within 60s nudge fires, console shows `[nudge] firing memory nudge...`
8. `npm run smoke` → all tests pass including ceo-memory checks
