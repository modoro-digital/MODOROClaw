'use strict';
const fs = require('fs');
const path = require('path');

let _db = null;
const CURRENT_MODEL_VERSION = 'e5-small-v1';
const MAX_CONTENT_LENGTH = 500;
const HOT_TIER_MAX_CHARS = 8000;
const VALID_TYPES = ['rule', 'pattern', 'preference', 'fact', 'correction', 'task', 'procedure', 'entity_note', 'task_state'];
const VALID_SOURCES = ['nudge', 'ceo_correction', 'evening_summary', 'manual', 'auto', 'workflow', 'system'];
const VALID_SCOPES = ['ceo', 'internal', 'customer', 'public', 'workflow'];
const VALID_STATUS = ['active', 'pending_review', 'disabled', 'superseded', 'deleted'];
const VALID_SENSITIVITY = ['none', 'personal', 'secret', 'credential'];

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
    _db.pragma('busy_timeout = 5000');
    _ensureSchema(_db);
    return _db;
  } catch (e) {
    console.error('[ceo-memory] db init failed:', e?.message);
    return null;
  }
}

function _ensureSchema(db) {
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

  _ensureColumn(db, 'ceo_memories', 'scope', "TEXT NOT NULL DEFAULT 'ceo'");
  _ensureColumn(db, 'ceo_memories', 'entity_type', 'TEXT');
  _ensureColumn(db, 'ceo_memories', 'entity_id', 'TEXT');
  _ensureColumn(db, 'ceo_memories', 'confidence', 'REAL NOT NULL DEFAULT 1.0');
  _ensureColumn(db, 'ceo_memories', 'status', "TEXT NOT NULL DEFAULT 'active'");
  _ensureColumn(db, 'ceo_memories', 'sensitivity', "TEXT NOT NULL DEFAULT 'none'");
  _ensureColumn(db, 'ceo_memories', 'evidence_event_ids_json', "TEXT NOT NULL DEFAULT '[]'");
  _ensureColumn(db, 'ceo_memories', 'expires_at', 'TEXT');
  _ensureColumn(db, 'ceo_memories', 'last_used_at', 'TEXT');
  _ensureColumn(db, 'ceo_memories', 'use_count', 'INTEGER NOT NULL DEFAULT 0');
  _ensureColumn(db, 'ceo_memories', 'supersedes_id', 'TEXT');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_ceo_mem_scope_status ON ceo_memories(scope, status);
    CREATE INDEX IF NOT EXISTS idx_ceo_mem_entity ON ceo_memories(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_ceo_mem_updated ON ceo_memories(updated_at DESC);

    CREATE TABLE IF NOT EXISTS memory_events (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL DEFAULT 'unknown',
      actor_id TEXT,
      event_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      source_ref TEXT,
      untrusted INTEGER NOT NULL DEFAULT 0,
      sensitivity TEXT NOT NULL DEFAULT 'none',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_events_created ON memory_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_events_channel ON memory_events(channel, actor_id);

    CREATE TABLE IF NOT EXISTS memory_entities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      source_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_entities_type ON memory_entities(type);

    CREATE TABLE IF NOT EXISTS memory_edges (
      id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      type TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      evidence_event_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_edges_source ON memory_edges(source_entity_id);
    CREATE INDEX IF NOT EXISTS idx_memory_edges_target ON memory_edges(target_entity_id);
  `);

  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ceo_memory_fts USING fts5(content, tokenize='unicode61')`);
  } catch (e) {
    console.warn('[ceo-memory] FTS5 unavailable, search will use embeddings/lexical fallback:', e?.message);
  }
}

function _ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function _id(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function _nowIso() {
  return new Date().toISOString();
}

function _parseJsonArray(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function _normalizeType(type) {
  const t = String(type || '').trim();
  if (!VALID_TYPES.includes(t)) throw new Error('invalid type: ' + t);
  return t;
}

function _normalizeScope(scope, channel) {
  const raw = String(scope || '').trim().toLowerCase();
  if (VALID_SCOPES.includes(raw)) return raw;
  const ch = String(channel || '').trim().toLowerCase();
  if (ch === 'zalo') return 'customer';
  return 'ceo';
}

function _normalizeStatus(status, sensitivity, requiresReview = false) {
  const raw = String(status || '').trim().toLowerCase();
  if ((sensitivity && sensitivity !== 'none') || requiresReview) {
    if (raw === 'disabled' || raw === 'deleted' || raw === 'superseded') return raw;
    return 'pending_review';
  }
  if (VALID_STATUS.includes(raw)) return raw;
  return 'active';
}

function _normalizeSensitivity(value, content) {
  const raw = String(value || '').trim().toLowerCase();
  if (VALID_SENSITIVITY.includes(raw)) return raw;
  return classifySensitivity(content);
}

function classifySensitivity(content) {
  const text = String(content || '');
  if (/(api[_\s-]?key|access[_\s-]?token|bearer\s+[a-z0-9._-]+|secret|password|mật khẩu|mat khau|sk-[a-z0-9_-]{8,})/i.test(text)) {
    return 'credential';
  }
  if (/\b(?:\d[ -]?){12,19}\b/.test(text)) return 'secret';
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) return 'personal';
  if (/(?:\+?84|0)(?:\d[\s.-]?){8,10}\b/.test(text)) return 'personal';
  return 'none';
}

function _cleanContent(content) {
  if (!content || typeof content !== 'string') throw new Error('content required');
  const cleaned = content.replace(/^#{1,3}\s+/gm, '').trim();
  if (cleaned.length > MAX_CONTENT_LENGTH) throw new Error('content too long (max ' + MAX_CONTENT_LENGTH + ')');
  return cleaned;
}

function _allowedScopesForChannel(channel, scopeHints = []) {
  const ch = String(channel || '').trim().toLowerCase();
  const hints = Array.isArray(scopeHints) ? scopeHints.map(s => String(s).toLowerCase()) : [];
  if (ch === 'zalo') {
    return ['customer', 'public'].filter(s => hints.length === 0 || hints.includes(s) || s === 'public');
  }
  if (ch === 'telegram' || ch === 'app' || ch === 'internal' || ch === 'ceo') {
    const base = ['ceo', 'internal', 'workflow', 'public'];
    return hints.length ? base.filter(s => hints.includes(s) || s === 'public') : base;
  }
  return ['public'];
}

function _isCustomerChannel(channel) {
  const ch = String(channel || '').trim().toLowerCase();
  return ch === 'zalo';
}

function _rowAllowedForActor(row, channel, actorId) {
  if (!_isCustomerChannel(channel)) return true;
  const entityType = String(row.entity_type || '').trim().toLowerCase();
  const entityId = String(row.entity_id || '').trim();
  const isCustomerEntity = ['customer', 'zalo_user', 'zalo_group', 'group'].includes(entityType);
  const isCustomerScopedEntity = (row.scope || 'ceo') === 'customer' && !!entityId;
  if (!isCustomerEntity && !isCustomerScopedEntity) return true;
  const actor = String(actorId || '').trim();
  return !!actor && entityId === actor;
}

function _normalizeText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function _tokens(text) {
  return _normalizeText(text)
    .split(/[^a-z0-9]+/i)
    .filter(t => t.length >= 2);
}

function _lexicalScore(query, content) {
  const q = new Set(_tokens(query));
  if (!q.size) return 0;
  const c = new Set(_tokens(content));
  let hit = 0;
  for (const t of q) if (c.has(t)) hit++;
  return hit / q.size;
}

function _typeWeight(type) {
  return {
    procedure: 1.35,
    correction: 1.30,
    rule: 1.20,
    preference: 1.10,
    pattern: 1.00,
    fact: 0.90,
    entity_note: 0.85,
    task_state: 0.75,
    task: 0.40,
  }[type] || 0.80;
}

function _hasRetrievalSignal({ fts = 0, lex = 0, cos = 0 } = {}) {
  return Math.max(fts, lex) >= 0.12 || cos >= 0.86;
}

function _rowToMemory(row, score) {
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    source: row.source,
    scope: row.scope || 'ceo',
    entity_type: row.entity_type || null,
    entity_id: row.entity_id || null,
    confidence: Number(row.confidence ?? 1),
    status: row.status || 'active',
    sensitivity: row.sensitivity || 'none',
    evidence_event_ids: _parseJsonArray(row.evidence_event_ids_json),
    expires_at: row.expires_at || null,
    last_used_at: row.last_used_at || null,
    use_count: Number(row.use_count || 0),
    supersedes_id: row.supersedes_id || null,
    score,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function _activeWhere() {
  return `(status = 'active' AND (expires_at IS NULL OR expires_at = '' OR expires_at > ?))`;
}

function _deleteFts(rowid) {
  const db = getMemoryDb();
  if (!db || rowid == null) return;
  try { db.prepare('DELETE FROM ceo_memory_fts WHERE rowid = ?').run(rowid); } catch {}
}

function _insertFts(rowid, content) {
  const db = getMemoryDb();
  if (!db || rowid == null) return;
  try { db.prepare('INSERT INTO ceo_memory_fts (rowid, content) VALUES (?, ?)').run(rowid, content); } catch {}
}

function _evidenceRequiresReview(db, evidenceEventIds) {
  const ids = _parseJsonArray(evidenceEventIds);
  if (!ids.length) return false;
  const placeholders = ids.map(() => '?').join(',');
  const row = db.prepare(
    `SELECT COUNT(*) AS cnt
       FROM memory_events
      WHERE id IN (${placeholders})
        AND (untrusted = 1 OR sensitivity != 'none')`
  ).get(...ids);
  return Number(row?.cnt || 0) > 0;
}

// ---------------------------------------------------------------------------
//  Events and graph primitives
// ---------------------------------------------------------------------------

function recordMemoryEvent({ channel = 'unknown', actorId = null, eventType, summary, sourceRef = null, untrusted = false, sensitivity = null } = {}) {
  if (!eventType) throw new Error('eventType required');
  const cleaned = _cleanContent(String(summary || ''));
  const db = getMemoryDb();
  if (!db) throw new Error('memory db unavailable');
  const id = _id('evt');
  const now = _nowIso();
  const sens = _normalizeSensitivity(sensitivity, cleaned);
  db.prepare(
    `INSERT INTO memory_events (id, channel, actor_id, event_type, summary, source_ref, untrusted, sensitivity, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, String(channel || 'unknown'), actorId ? String(actorId) : null, String(eventType), cleaned, sourceRef ? String(sourceRef) : null, untrusted ? 1 : 0, sens, now);
  return { id, created_at: now, sensitivity: sens };
}

function pruneMemoryEvents({ olderThanDays = 90 } = {}) {
  const db = getMemoryDb();
  if (!db) throw new Error('memory db unavailable');
  const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
  return db.prepare('DELETE FROM memory_events WHERE created_at < ?').run(cutoff);
}

function upsertMemoryEntity({ id, type, label, aliases = [], sourceRef = null } = {}) {
  if (!id) throw new Error('id required');
  if (!type) throw new Error('type required');
  if (!label) throw new Error('label required');
  const db = getMemoryDb();
  if (!db) throw new Error('memory db unavailable');
  const now = _nowIso();
  db.prepare(
    `INSERT INTO memory_entities (id, type, label, aliases_json, source_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET type = excluded.type, label = excluded.label,
       aliases_json = excluded.aliases_json, source_ref = excluded.source_ref, updated_at = excluded.updated_at`
  ).run(String(id), String(type), String(label), JSON.stringify(Array.isArray(aliases) ? aliases : []), sourceRef ? String(sourceRef) : null, now, now);
  return { id: String(id), updated_at: now };
}

function upsertMemoryEdge({ sourceEntityId, targetEntityId, type, weight = 1, evidenceEventIds = [] } = {}) {
  if (!sourceEntityId || !targetEntityId || !type) throw new Error('sourceEntityId, targetEntityId, type required');
  const db = getMemoryDb();
  if (!db) throw new Error('memory db unavailable');
  const id = 'edge_' + _normalizeText([sourceEntityId, type, targetEntityId].join('_')).replace(/[^a-z0-9_]+/g, '_');
  const now = _nowIso();
  db.prepare(
    `INSERT INTO memory_edges (id, source_entity_id, target_entity_id, type, weight, evidence_event_ids_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET weight = excluded.weight,
       evidence_event_ids_json = excluded.evidence_event_ids_json, updated_at = excluded.updated_at`
  ).run(id, String(sourceEntityId), String(targetEntityId), String(type), Number(weight) || 1, JSON.stringify(_parseJsonArray(evidenceEventIds)), now, now);
  return { id, updated_at: now };
}

// ---------------------------------------------------------------------------
//  CRUD
// ---------------------------------------------------------------------------

async function writeMemory(opts = {}) {
  const type = _normalizeType(opts.type);
  const content = _cleanContent(opts.content);
  const source = VALID_SOURCES.includes(opts.source) ? opts.source : 'manual';
  if (source === 'auto' && type === 'task') {
    return { skipped: true, reason: 'routine task logs are not durable memory', status: 'disabled' };
  }

  const scope = _normalizeScope(opts.scope, opts.channel);
  const sensitivity = _normalizeSensitivity(opts.sensitivity, content);
  const confidence = Math.max(0, Math.min(1, Number(opts.confidence ?? 1)));
  const entityType = opts.entityType || opts.entity_type || null;
  const entityId = opts.entityId || opts.entity_id || null;
  const evidenceEventIds = _parseJsonArray(opts.evidenceEventIds || opts.evidence_event_ids || opts.evidence_event_ids_json);
  const supersedesId = opts.supersedesId || opts.supersedes_id || null;
  const expiresAt = opts.expiresAt || opts.expires_at || null;

  const db = getMemoryDb();
  if (!db) throw new Error('memory db unavailable');
  const status = _normalizeStatus(opts.status, sensitivity, _evidenceRequiresReview(db, evidenceEventIds));

  const id = _id('mem');
  const now = _nowIso();
  const score = type === 'correction' ? 1.5 : (type === 'procedure' ? 1.3 : 1.0);

  let embeddingBlob = null;
  try {
    const { embedText, vecToBlob } = require('./knowledge');
    const vec = await embedText(content, false);
    embeddingBlob = vecToBlob(vec);
  } catch (e) {
    console.warn('[ceo-memory] embedding failed, storing without vector:', e?.message);
  }

  db.transaction(() => {
    if (supersedesId) {
      db.prepare("UPDATE ceo_memories SET status = 'superseded', updated_at = ? WHERE id = ?").run(now, supersedesId);
    }
    db.prepare(
      `INSERT INTO ceo_memories
       (id, type, content, source, embedding, relevance_score, model_version, created_at, updated_at,
        scope, entity_type, entity_id, confidence, status, sensitivity, evidence_event_ids_json,
        expires_at, last_used_at, use_count, supersedes_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, type, content, source, embeddingBlob, score, embeddingBlob ? CURRENT_MODEL_VERSION : null, now, now,
      scope, entityType, entityId, confidence, status, sensitivity, JSON.stringify(evidenceEventIds),
      expiresAt, null, 0, supersedesId
    );

    const rowid = db.prepare('SELECT rowid FROM ceo_memories WHERE id = ?').get(id)?.rowid;
    _insertFts(rowid, content);
  })();

  _scheduleRegeneration();
  return { id, created_at: now, status, sensitivity, scope };
}

function deleteMemory(id) {
  const db = getMemoryDb();
  if (!db) throw new Error('memory db unavailable');

  const row = db.prepare('SELECT rowid FROM ceo_memories WHERE id = ?').get(id);
  if (!row) return { deleted: false, reason: 'not found' };

  db.transaction(() => {
    _deleteFts(row.rowid);
    db.prepare('DELETE FROM ceo_memories WHERE id = ?').run(id);
  })();

  _scheduleRegeneration();
  return { deleted: true };
}

async function updateMemoryStatus(id, status) {
  const st = String(status || '').trim().toLowerCase();
  if (!VALID_STATUS.includes(st)) throw new Error('invalid status: ' + st);
  const db = getMemoryDb();
  if (!db) throw new Error('memory db unavailable');
  const result = db.prepare('UPDATE ceo_memories SET status = ?, updated_at = ? WHERE id = ?').run(st, _nowIso(), id);
  _scheduleRegeneration();
  return { updated: result.changes > 0, status: st };
}

async function supersedeMemory(id, supersededById = null) {
  const db = getMemoryDb();
  if (!db) throw new Error('memory db unavailable');
  const result = db.prepare("UPDATE ceo_memories SET status = 'superseded', supersedes_id = COALESCE(?, supersedes_id), updated_at = ? WHERE id = ?").run(supersededById, _nowIso(), id);
  _scheduleRegeneration();
  return { updated: result.changes > 0, status: 'superseded' };
}

async function prioritizeMemory(id, delta = 0.5) {
  const db = getMemoryDb();
  if (!db) throw new Error('memory db unavailable');
  const result = db.prepare('UPDATE ceo_memories SET relevance_score = MIN(relevance_score + ?, 5.0), updated_at = ? WHERE id = ?').run(Math.max(0.1, Number(delta) || 0.5), _nowIso(), id);
  _scheduleRegeneration();
  return { updated: result.changes > 0 };
}

// ---------------------------------------------------------------------------
//  Hybrid search: scope + status filter, FTS5, lexical, e5-small cosine
// ---------------------------------------------------------------------------

async function searchMemory(query, { limit = 5, bumpRelevance = true, scopes = null, channel = null, actorId = null, includePending = false, includeDisabled = false } = {}) {
  const db = getMemoryDb();
  if (!db) return [];
  if (!query || typeof query !== 'string') return [];

  const nowIso = _nowIso();
  const now = Date.now();
  const allowedScopes = scopes ? scopes.map(String) : (channel ? _allowedScopesForChannel(channel) : null);
  if (allowedScopes && allowedScopes.length === 0) return [];
  const where = [];
  const params = [];
  if (!includePending && !includeDisabled) {
    where.push("status = 'active'");
  } else {
    if (!includePending) where.push("status != 'pending_review'");
    if (!includeDisabled) where.push("status NOT IN ('disabled', 'deleted', 'superseded')");
  }
  if (!includeDisabled) {
    where.push("(expires_at IS NULL OR expires_at = '' OR expires_at > ?)");
    params.push(nowIso);
  }
  if (allowedScopes) {
    where.push(`COALESCE(scope, 'ceo') IN (${allowedScopes.map(() => '?').join(',')})`);
    params.push(...allowedScopes);
  }
  if (_isCustomerChannel(channel)) {
    const actor = String(actorId || '').trim();
    where.push(`(
      NOT (
        LOWER(COALESCE(entity_type, '')) IN ('customer', 'zalo_user', 'zalo_group', 'group')
        OR (COALESCE(scope, 'ceo') = 'customer' AND COALESCE(entity_id, '') != '')
      )
      OR (? != '' AND COALESCE(entity_id, '') = ?)
    )`);
    params.push(actor, actor);
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const allRows = db.prepare(
    `SELECT id, type, content, source, embedding, relevance_score, model_version, created_at, updated_at,
            scope, entity_type, entity_id, confidence, status, sensitivity, evidence_event_ids_json,
            expires_at, last_used_at, use_count, supersedes_id
       FROM ceo_memories${whereSql}`
  ).all(...params).filter(row => _rowAllowedForActor(row, channel, actorId));
  if (allRows.length === 0) return [];

  const ftsScores = {};
  try {
    const ftsQuery = '"' + query.replace(/"/g, '""') + '"';
    const ftsRows = db.prepare(
      `SELECT m.id, fts.rank FROM ceo_memory_fts fts
       JOIN ceo_memories m ON m.rowid = fts.rowid
       WHERE ceo_memory_fts MATCH ? ORDER BY fts.rank LIMIT 50`
    ).all(ftsQuery);
    for (const r of ftsRows) {
      ftsScores[r.id] = 1.0 / (1.0 + Math.abs(r.rank));
    }
  } catch (e) {
    console.warn('[ceo-memory] FTS5 search failed, using lexical/embedding fallback:', e?.message);
  }

  const cosineScores = {};
  try {
    const { embedText, blobToVec, cosineSim } = require('./knowledge');
    const queryVec = await embedText(query, true);
    for (const row of allRows) {
      if (row.embedding) {
        const vec = blobToVec(row.embedding);
        cosineScores[row.id] = Math.max(0, cosineSim(queryVec, vec));
      }
    }
  } catch (e) {
    console.warn('[ceo-memory] embedding search failed, using lexical/FTS only:', e?.message);
  }

  const scored = allRows.map(row => {
    const daysSince = (now - new Date(row.updated_at).getTime()) / 86400000;
    const effectiveRelevance = Math.max(0, Number(row.relevance_score || 0) - 0.02 * daysSince);
    const fts = ftsScores[row.id] || 0;
    const lex = _lexicalScore(query, row.content);
    const cos = cosineScores[row.id] || 0;
    if (!_hasRetrievalSignal({ fts, lex, cos })) return null;
    const confidence = Math.max(0, Math.min(1, Number(row.confidence ?? 1)));
    const evidenceBoost = Math.min(0.1, _parseJsonArray(row.evidence_event_ids_json).length * 0.03);
    const usageBoost = Math.min(0.08, Number(row.use_count || 0) * 0.01);
    const relevance = Math.min(1, effectiveRelevance / 5);
    const score = (
      0.25 * Math.max(fts, lex) +
      0.25 * cos +
      0.18 * relevance +
      0.12 * confidence +
      0.15 * _typeWeight(row.type) / 1.35 +
      evidenceBoost +
      usageBoost
    );
    return _rowToMemory(row, score);
  }).filter(Boolean);

  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, limit).filter(r => r.score > 0);

  if (bumpRelevance && results.length > 0) {
    const nowIso2 = _nowIso();
    const bumpStmt = db.prepare('UPDATE ceo_memories SET relevance_score = MIN(relevance_score + 0.1, 5.0), updated_at = ?, last_used_at = ?, use_count = use_count + 1 WHERE id = ?');
    for (const r of results) {
      bumpStmt.run(nowIso2, nowIso2, r.id);
    }
    _scheduleRegeneration();
  }

  return results;
}

async function getMemoryContext({ query = '', channel = 'telegram', actorId = null, taskType = '', intent = '', scopeHints = [], limit = 8 } = {}) {
  const allowedScopes = _allowedScopesForChannel(channel, scopeHints);
  const searchQuery = [query, taskType, intent].filter(Boolean).join(' ');
  const memories = await searchMemory(searchQuery || query || taskType || intent, {
    limit: Math.min(Math.max(Number(limit) || 8, 1), 30),
    bumpRelevance: true,
    scopes: allowedScopes,
    channel,
    actorId,
  });
  const procedures = memories.filter(m => m.type === 'procedure');
  const evidenceIds = [...new Set(memories.flatMap(m => m.evidence_event_ids || []))];
  const relatedEntities = _getRelatedEntities(memories);
  const safetyWarnings = [];
  const ch = String(channel || '').toLowerCase();
  if (ch === 'zalo') {
    safetyWarnings.push('Customer channel: CEO/internal memories are excluded before scoring.');
  }

  return {
    query,
    channel,
    actorId,
    taskType,
    intent,
    scopes: allowedScopes,
    generatedAt: _nowIso(),
    memories,
    procedures,
    entities: relatedEntities,
    safetyWarnings,
    evidenceIds,
  };
}

function _getRelatedEntities(memories) {
  const db = getMemoryDb();
  if (!db) return [];
  const ids = [...new Set(memories.map(m => m.entity_id).filter(Boolean))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`SELECT id, type, label, aliases_json, source_ref, created_at, updated_at FROM memory_entities WHERE id IN (${placeholders})`).all(...ids).map(r => ({
    id: r.id,
    type: r.type,
    label: r.label,
    aliases: _parseJsonArray(r.aliases_json),
    source_ref: r.source_ref || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

// ---------------------------------------------------------------------------
//  List / count / last
// ---------------------------------------------------------------------------

function listMemories({ limit = 100, status = null, scope = null, type = null } = {}) {
  const db = getMemoryDb();
  if (!db) return [];
  const now = Date.now();
  const where = [];
  const params = [];
  if (status) {
    where.push('status = ?');
    params.push(String(status));
  }
  if (scope) {
    where.push('scope = ?');
    params.push(String(scope));
  }
  if (type) {
    where.push('type = ?');
    params.push(String(type));
  }
  const max = Math.min(Math.max(parseInt(limit) || 100, 1), 1000);
  const rows = db.prepare(
    `SELECT id, type, content, source, relevance_score, created_at, updated_at,
            scope, entity_type, entity_id, confidence, status, sensitivity,
            evidence_event_ids_json, expires_at, last_used_at, use_count, supersedes_id
       FROM ceo_memories ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY created_at DESC LIMIT ?`
  ).all(...params, max);
  return rows.map(r => {
    const daysSince = (now - new Date(r.updated_at).getTime()) / 86400000;
    return { ..._rowToMemory(r), effective_score: Math.max(0, Number(r.relevance_score || 0) - 0.02 * daysSince) };
  });
}

function listMemoryEvents({ limit = 100, channel = null, actorId = null, ids = null } = {}) {
  const db = getMemoryDb();
  if (!db) return [];
  const where = [];
  const params = [];
  const idList = _parseJsonArray(ids);
  if (idList.length) {
    where.push(`id IN (${idList.map(() => '?').join(',')})`);
    params.push(...idList);
  }
  if (channel) {
    where.push('channel = ?');
    params.push(String(channel));
  }
  if (actorId) {
    where.push('actor_id = ?');
    params.push(String(actorId));
  }
  const max = Math.min(Math.max(parseInt(limit) || 100, 1), 1000);
  const rows = db.prepare(
    `SELECT * FROM memory_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY created_at DESC LIMIT ?`
  ).all(...params, max);
  return rows.map(r => ({ ...r, untrusted: !!r.untrusted }));
}

function getMemoryCount() {
  const db = getMemoryDb();
  if (!db) return 0;
  return db.prepare("SELECT COUNT(*) as cnt FROM ceo_memories WHERE status != 'deleted'").get()?.cnt || 0;
}

function getLastMemoryAt() {
  const db = getMemoryDb();
  if (!db) return null;
  return db.prepare("SELECT created_at FROM ceo_memories WHERE status != 'deleted' ORDER BY created_at DESC LIMIT 1").get()?.created_at || null;
}

// ---------------------------------------------------------------------------
//  CEO-MEMORY.md regeneration (debounced 2s)
// ---------------------------------------------------------------------------

let _regenTimer = null;

function _scheduleRegeneration() {
  if (_regenTimer) clearTimeout(_regenTimer);
  _regenTimer = setTimeout(() => {
    _regenTimer = null;
    try { regenerateCeoMemoryFile(); } catch (e) {
      console.error('[ceo-memory] regeneration failed:', e?.message);
    }
  }, 2000);
}

function trimOldTaskEntries() {
  const db = getMemoryDb();
  if (!db) return;
  try {
    const result = db.prepare("DELETE FROM ceo_memories WHERE type = 'task' AND source = 'auto'").run();
    if (result.changes > 0) console.log(`[ceo-memory] purged ${result.changes} auto-task entries`);
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    db.prepare("DELETE FROM ceo_memories WHERE type = 'task' AND created_at < ?").run(cutoff);
  } catch (e) {
    console.warn('[ceo-memory] trim old tasks error:', e?.message);
  }
}

function regenerateCeoMemoryFile() {
  trimOldTaskEntries();
  pruneMemoryEvents({ olderThanDays: 90 });
  const db = getMemoryDb();
  if (!db) return;
  const { getWorkspace } = require('./workspace');
  const ws = getWorkspace();
  if (!ws) return;

  const now = Date.now();
  const nowIso = _nowIso();
  const allRows = db.prepare(
    `SELECT id, type, content, relevance_score, updated_at, status, expires_at
       FROM ceo_memories WHERE ${_activeWhere()}`
  ).all(nowIso);

  const byType = { correction: [], rule: [], procedure: [], pattern: [], preference: [], fact: [], entity_note: [], task_state: [], task: [] };
  for (const r of allRows) {
    const daysSince = (now - new Date(r.updated_at).getTime()) / 86400000;
    r.effective = Math.max(0, Number(r.relevance_score || 0) - 0.02 * daysSince);
    if (byType[r.type]) byType[r.type].push(r);
  }
  for (const arr of Object.values(byType)) {
    arr.sort((a, b) => b.effective - a.effective);
  }

  const typePriority = ['correction', 'rule', 'procedure', 'pattern', 'preference', 'fact', 'entity_note', 'task_state', 'task'];
  const typeSoftCaps = { correction: 0.22, rule: 0.20, procedure: 0.20, pattern: 0.12, preference: 0.10, fact: 0.08, entity_note: 0.04, task_state: 0.03, task: 0.01 };
  const groups = {};
  let totalChars = 0;
  let surplus = 0;

  for (const type of typePriority) {
    const baseCap = HOT_TIER_MAX_CHARS * (typeSoftCaps[type] || 0.05);
    const effectiveCap = baseCap + surplus;
    let typeChars = 0;
    groups[type] = [];
    for (const r of byType[type]) {
      if (totalChars + r.content.length > HOT_TIER_MAX_CHARS) break;
      if (typeChars + r.content.length > effectiveCap) break;
      groups[type].push(r.content);
      totalChars += r.content.length + 3;
      typeChars += r.content.length + 3;
    }
    surplus += Math.max(0, baseCap - typeChars);
  }

  const typeLabels = {
    correction: 'Quy tắc đã sửa',
    rule: 'Quy tắc đã học',
    procedure: 'Quy trình vận hành',
    preference: 'Sở thích của sếp',
    pattern: 'Mẫu khách hàng',
    fact: 'Sự kiện quan trọng',
    entity_note: 'Ghi chú đối tượng',
    task_state: 'Trạng thái việc quan trọng',
    task: 'Việc đã làm gần đây',
  };

  let md = '# Bộ nhớ bot\n\n';
  for (const type of typePriority) {
    if (groups[type]?.length) {
      md += `## ${typeLabels[type]}\n`;
      for (const line of groups[type]) {
        md += `- ${line}\n`;
      }
      md += '\n';
    }
  }

  if (totalChars === 0) {
    md += '_Chưa có gì. Bot sẽ tự học từ cuộc hội thoại với sếp._\n';
  }

  const filePath = path.join(ws, 'CEO-MEMORY.md');
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  if (md.trim() !== current.trim()) {
    fs.writeFileSync(filePath, md, 'utf-8');
    console.log('[ceo-memory] CEO-MEMORY.md regenerated (' + totalChars + ' chars, ' + allRows.length + ' active memories)');
  }
  injectMemoryIntoAgentsMd();
}

// ---------------------------------------------------------------------------
//  AGENTS.md memory injection compatibility cache
// ---------------------------------------------------------------------------

const MEMORY_SECTION_START = '<!-- MEMORY-CONTEXT-START -->';
const MEMORY_SECTION_END = '<!-- MEMORY-CONTEXT-END -->';
const MEMORY_MIN_CHARS = 2000;
const MEMORY_BUDGET_CAP = 10000;
const TOTAL_CONTEXT_BUDGET = 35000;

function getMemoryBudget(agentsPath) {
  try {
    const agentsContent = fs.readFileSync(agentsPath, 'utf-8');
    const agentsChars = agentsContent.length;
    const available = TOTAL_CONTEXT_BUDGET - agentsChars;
    return Math.max(MEMORY_MIN_CHARS, Math.min(MEMORY_BUDGET_CAP, available));
  } catch {
    return MEMORY_MIN_CHARS;
  }
}

function injectMemoryIntoAgentsMd() {
  try {
    const { getWorkspace } = require('./workspace');
    const ws = getWorkspace();
    if (!ws) return;
    const agentsPath = path.join(ws, 'AGENTS.md');
    if (!fs.existsSync(agentsPath)) return;

    const ceoMemPath = path.join(ws, 'CEO-MEMORY.md');
    let memContent = '';
    if (fs.existsSync(ceoMemPath)) {
      memContent = fs.readFileSync(ceoMemPath, 'utf-8').trim();
    }
    if (!memContent || memContent.includes('Chưa có gì')) memContent = '';

    const memBudget = getMemoryBudget(agentsPath);
    if (memContent.length > memBudget) {
      const lines = memContent.split('\n');
      let trimmed = '';
      for (let i = 0; i < lines.length; i++) {
        const candidate = trimmed ? trimmed + '\n' + lines[i] : lines[i];
        if (candidate.length > memBudget) break;
        trimmed = candidate;
      }
      memContent = trimmed.trim();
    }

    const section = memContent
      ? `\n\n${MEMORY_SECTION_START}\n<memory-context>\n${memContent}\n</memory-context>\n${MEMORY_SECTION_END}`
      : `\n\n${MEMORY_SECTION_START}\n${MEMORY_SECTION_END}`;

    let agents = fs.readFileSync(agentsPath, 'utf-8');
    const startIdx = agents.indexOf(MEMORY_SECTION_START);
    const endIdx = agents.indexOf(MEMORY_SECTION_END);
    if (startIdx !== -1 && endIdx !== -1) {
      agents = agents.slice(0, startIdx) + section.trim() + agents.slice(endIdx + MEMORY_SECTION_END.length);
    } else {
      agents = agents.trimEnd() + section;
    }

    const current = fs.readFileSync(agentsPath, 'utf-8');
    if (agents !== current) {
      fs.writeFileSync(agentsPath, agents, 'utf-8');
    }

    // Warn if AGENTS.md exceeds the openclaw bootstrap budget floor.
    // Threshold mirrors AGENTS_MD_BOOTSTRAP_MAX_CHARS in electron/lib/config.js.
    // Warn-only: never throws, never blocks, never modifies the write outcome.
    try {
      const AGENTS_MD_BOOTSTRAP_MAX_CHARS = 40000; // keep in sync with config.js
      const byteSize = Buffer.byteLength(agents, 'utf-8');
      if (byteSize > AGENTS_MD_BOOTSTRAP_MAX_CHARS) {
        console.warn(
          `[ceo-memory] AGENTS.md is ${byteSize} chars — exceeds bootstrap floor (${AGENTS_MD_BOOTSTRAP_MAX_CHARS}); risk of tail truncation by the gateway`
        );
      }
    } catch {}
  } catch (e) {
    console.warn('[ceo-memory] inject into AGENTS.md failed:', e?.message);
  }
}

// ---------------------------------------------------------------------------
//  Exports
// ---------------------------------------------------------------------------

function cleanupCeoMemoryTimers() {
  if (_regenTimer) { clearTimeout(_regenTimer); _regenTimer = null; }
  if (_db) { try { _db.close(); } catch {} _db = null; }
}

module.exports = {
  getMemoryDb,
  writeMemory,
  deleteMemory,
  updateMemoryStatus,
  supersedeMemory,
  prioritizeMemory,
  searchMemory,
  getMemoryContext,
  listMemories,
  listMemoryEvents,
  getMemoryCount,
  getLastMemoryAt,
  recordMemoryEvent,
  pruneMemoryEvents,
  upsertMemoryEntity,
  upsertMemoryEdge,
  classifySensitivity,
  regenerateCeoMemoryFile,
  scheduleRegeneration: _scheduleRegeneration,
  cleanupCeoMemoryTimers,
  injectMemoryIntoAgentsMd,
  getMemoryBudget,
  CURRENT_MODEL_VERSION,
  MAX_CONTENT_LENGTH,
  HOT_TIER_MAX_CHARS,
  VALID_TYPES,
  VALID_SOURCES,
  VALID_SCOPES,
  VALID_STATUS,
  VALID_SENSITIVITY,
};
