'use strict';

const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
//  Lazy Electron require — only resolved when actually needed at runtime
// ---------------------------------------------------------------------------
let _app = null;
function _getApp() {
  if (!_app) _app = require('electron').app;
  return _app;
}

// ---------------------------------------------------------------------------
//  Imported modules (side-effect-free at require time)
// ---------------------------------------------------------------------------
const { getWorkspace, auditLog, purgeAgentSessions } = require('./workspace');
const { getBundledVendorDir, getBundledNodeBin } = require('./boot');
const { call9Router, call9RouterVision } = require('./nine-router');
const { writeJsonAtomic } = require('./util');
const mediaLibrary = require('./media-library');

// ---------------------------------------------------------------------------
//  Embedder — lazy init (requires app.getPath + getBundledVendorDir at runtime)
// ---------------------------------------------------------------------------
const _embedderModule = require('./embedder');

let _embedderInitDone = false;
function _ensureEmbedderInit() {
  if (_embedderInitDone) return;
  _embedderInitDone = true;

  const rawModelsRoot = getBundledVendorDir() || path.join(__dirname, '..', 'vendor');
  _embedderModule.setModelsRoot(_toNonAsciiSafePath(rawModelsRoot));

  // Platform-F5: cacheDir MUST be writable. Mac .app bundle is read-only when
  // installed to /Applications — keep transformers.js tokenizer cache in
  // userData where we always have write permission.
  try {
    const cacheDir = path.join(_getApp().getPath('userData'), 'transformers-cache');
    try { fs.mkdirSync(cacheDir, { recursive: true }); } catch {}
    _embedderModule.setCacheRoot(_toNonAsciiSafePath(cacheDir));
  } catch {}
}

// Re-export embedder functions — all go through lazy init gate
function getEmbedder() { _ensureEmbedderInit(); return _embedderModule.getEmbedder(); }
function embedText(text, isQuery) { _ensureEmbedderInit(); return _embedderModule.embedText(text, isQuery); }
function cosineSim(a, b) { return _embedderModule.cosineSim(a, b); }
function vecToBlob(v) { return _embedderModule.vecToBlob(v); }
function blobToVec(b) { return _embedderModule.blobToVec(b); }
function getEmbedderState() { return _embedderModule.getEmbedderState(); }
const E5_DIM = _embedderModule.E5_DIM;

// ---------------------------------------------------------------------------
//  sendCeoAlert — late-bound to avoid circular require with channels.js
// ---------------------------------------------------------------------------
let _sendCeoAlert = null;
function _getSendCeoAlert() {
  if (!_sendCeoAlert) {
    try { _sendCeoAlert = require('./channels').sendCeoAlert; } catch {}
  }
  return _sendCeoAlert || (() => {});
}

// ---------------------------------------------------------------------------
//  Documents directory helpers
// ---------------------------------------------------------------------------
function getDocumentsDir() {
  return path.join(getWorkspace(), 'documents');
}
function ensureDocumentsDir() {
  const d = getDocumentsDir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ---------------------------------------------------------------------------
//  State variables
// ---------------------------------------------------------------------------

// R2 FIX: throttle error logging by time window instead of permanent latch.
let _documentsDbLastErrorAt = 0;
const DOCUMENTS_DB_ERROR_LOG_INTERVAL_MS = 5 * 60 * 1000;
let _documentsDbAutoFixAttempted = false;
// R5 FIX: schema migration runs once per process.
let _documentsDbSchemaReady = false;

// ---------------------------------------------------------------------------
//  Vietnamese FTS5 helpers
// ---------------------------------------------------------------------------

const VI_STOPWORDS = new Set([
  'ở','la','voi','cua','cho','nay','kia','va','hoac','thi','ma','nen',
  'vay','roi','dang','se','da','co','cac','nhung','mot','trong','ngoai',
  'tren','duoi','khi','neu','tai','ve','theo','boi','vi','do','qua',
  'den','tu','vao','ra','len','xuong','di','toi','bang','cung','con',
  'do','day','kia','ay','nao','sao','dau','gi','ai','may','bao',
  'u','a','o','a','oi','nhe','nha','day','nhi','chu','ha','ho',
  'de','moi','chi','rat','hon','nhat','qua','that','that_su'
]);

function stripViDiacritics(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function normalizeForSearch(text) {
  if (!text) return '';
  return stripViDiacritics(String(text)).toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenizeForSearch(text) {
  if (!text) return '';
  const plain = normalizeForSearch(text);
  const tokens = plain.split(/[^a-z0-9]+/).filter(t => t.length >= 2 && !VI_STOPWORDS.has(t));
  return tokens.join(' ');
}

// Chunk Vietnamese text at sentence boundaries with configurable size + overlap.
function chunkVietnameseText(text, opts) {
  const chunkSize = (opts && opts.chunkSize) || 500;
  const overlap = (opts && opts.overlap) || 100;
  const minChunk = 50;
  if (!text) return [];
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return [];

  // 1) Split into candidate sentences with their start offsets.
  const sentences = [];
  const re = /[.!?。？！]+[\s]+/g;
  let lastIdx = 0;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const endIdx = m.index + m[0].length;
    sentences.push({ text: clean.slice(lastIdx, endIdx).trim(), start: lastIdx, end: endIdx });
    lastIdx = endIdx;
  }
  if (lastIdx < clean.length) {
    sentences.push({ text: clean.slice(lastIdx).trim(), start: lastIdx, end: clean.length });
  }

  // 2) Hard-cut any sentence > chunkSize into fixed-width pieces.
  const pieces = [];
  for (const s of sentences) {
    if (s.text.length <= chunkSize) { pieces.push(s); continue; }
    let off = 0;
    while (off < s.text.length) {
      const slice = s.text.slice(off, off + chunkSize);
      pieces.push({ text: slice, start: s.start + off, end: s.start + off + slice.length });
      off += chunkSize;
    }
  }

  // 3) Greedy pack pieces into chunks up to chunkSize, with `overlap` tail
  //    from the previous chunk prepended to each new chunk (except the first).
  const chunks = [];
  let cur = { text: '', start: -1, end: -1 };
  for (const p of pieces) {
    if (cur.text.length === 0) { cur = { text: p.text, start: p.start, end: p.end }; continue; }
    if (cur.text.length + 1 + p.text.length <= chunkSize) {
      cur.text = cur.text + ' ' + p.text;
      cur.end = p.end;
    } else {
      chunks.push(cur);
      // Build overlap from the tail of the previous chunk.
      const tailLen = Math.min(overlap, cur.text.length);
      const tail = tailLen > 0 ? cur.text.slice(cur.text.length - tailLen) : '';
      const tailStart = cur.end - tailLen;
      if (tail) {
        const combined = tail + ' ' + p.text;
        cur = { text: combined.length <= chunkSize ? combined : p.text,
                start: combined.length <= chunkSize ? tailStart : p.start,
                end: p.end };
      } else {
        cur = { text: p.text, start: p.start, end: p.end };
      }
    }
  }
  if (cur.text.length > 0) chunks.push(cur);

  // 4) Merge tiny trailing chunks (< minChunk) into the previous one.
  const merged = [];
  for (const c of chunks) {
    if (merged.length > 0 && c.text.length < minChunk) {
      const prev = merged[merged.length - 1];
      prev.text = prev.text + ' ' + c.text;
      prev.end = c.end;
    } else {
      merged.push(c);
    }
  }

  return merged.map((c, i) => ({
    index: i,
    content: c.text,
    char_start: c.start,
    char_end: c.end,
  }));
}

// ---------------------------------------------------------------------------
//  ONNX non-ASCII path workaround (Windows)
// ---------------------------------------------------------------------------
function _toNonAsciiSafePath(p) {
  if (!p || process.platform !== 'win32') return p;
  // Fast path: all ASCII → return as-is
  if (/^[\x00-\x7F]*$/.test(p)) return p;
  try {
    // Try fs.realpathSync.native — may yield NTFS short name
    const real = fs.realpathSync.native(p);
    if (/^[\x00-\x7F]*$/.test(real)) {
      console.log('[path-short] rewritten for non-ASCII safety:', p, '→', real);
      return real;
    }
    // Fallback: cmd /c for /f with 8.3 name.
    try {
      const short = require('child_process').execFileSync(
        'cmd', ['/c', 'for', '%I', 'in', '("' + p + '")', 'do', '@echo', '%~sI'],
        { encoding: 'utf8', windowsHide: true }
      ).trim();
      if (short && /^[\x00-\x7F]*$/.test(short)) {
        console.log('[path-short] 8.3 name:', p, '→', short);
        return short;
      }
    } catch {}
  } catch {}
  return p;
}

// ---------------------------------------------------------------------------
//  verifyEmbedderModelSha
// ---------------------------------------------------------------------------
async function verifyEmbedderModelSha() {
  const app = _getApp();
  if (!app.isPackaged) return;
  if (global.__embedderShaVerified) return;
  const resDir = process.resourcesPath;
  const metaPath = path.join(resDir, 'vendor-meta.json');
  if (!fs.existsSync(metaPath)) return;
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch { return; }
  if (!meta.modelSha || !meta.modelSha['model_quantized.onnx']) return;
  const vendorDir = getBundledVendorDir();
  if (!vendorDir) return;
  const onnxPath = path.join(vendorDir, 'models', 'Xenova', 'multilingual-e5-small', 'onnx', 'model_quantized.onnx');
  if (!fs.existsSync(onnxPath)) return;
  try {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(onnxPath, { highWaterMark: 4 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      stream.on('data', c => hash.update(c));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    const actual = hash.digest('hex');
    const expected = meta.modelSha['model_quantized.onnx'];
    if (actual !== expected) {
      console.warn(`[embedder-sha] model_quantized.onnx hash mismatch — expected ${expected.slice(0, 16)}..., got ${actual.slice(0, 16)}...`);
      if (process.platform === 'win32') {
        try {
          fs.unlinkSync(path.join(app.getPath('userData'), 'vendor-version.txt'));
          console.warn('[embedder-sha] vendor stamp removed — next launch will re-extract from tar');
        } catch {}
      }
      try {
        const msg = process.platform === 'win32'
          ? '[Bảo mật] Model RAG bị sửa đổi — khởi động lại app để cài lại từ bản gốc.'
          : '[Bảo mật] Model RAG bị sửa đổi — vui lòng cài lại 9BizClaw từ file DMG gốc.';
        _getSendCeoAlert()(msg);
      } catch {}
      try { auditLog('rag_model_tamper', { platform: process.platform, expected, actual }); } catch {}
    } else {
      console.log('[embedder-sha] model_quantized.onnx verified');
    }
  } catch (e) {
    console.warn('[embedder-sha] check skipped:', e.message);
  }
  global.__embedderShaVerified = true;
}

// ---------------------------------------------------------------------------
//  backfillKnowledgeEmbeddings
// ---------------------------------------------------------------------------
let _backfillInProgress = false;
async function backfillKnowledgeEmbeddings() {
  _ensureEmbedderInit();
  const db = getDocumentsDb();
  if (!db) return;
  _backfillInProgress = true;
  try {
    const missing = db.prepare(
      `SELECT c.id, c.document_id, c.char_start, c.char_end, d.content
       FROM documents_chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE c.embedding IS NULL`
    ).all();
    if (missing.length === 0) return;
    console.log(`[knowledge-backfill] embedding ${missing.length} chunks...`);
    const upsert = db.prepare(
      'UPDATE documents_chunks SET embedding = ?, embedding_model = ? WHERE id = ?'
    );
    const MODEL_STAMP = 'multilingual-e5-small-q';
    let done = 0;
    let diskFullHits = 0;
    for (const row of missing) {
      const text = (row.content || '').substring(row.char_start, row.char_end);
      if (!text || text.length < 50) continue;
      try {
        const vec = await embedText(text, false);
        upsert.run(vecToBlob(vec), MODEL_STAMP, row.id);
        done++;
      } catch (e) {
        const msg = String(e?.message || e);
        if (/SQLITE_FULL|ENOSPC|disk I\/O|no space/i.test(msg)) diskFullHits++;
        console.warn('[knowledge-backfill] chunk failed:', row.id, msg);
      }
    }
    console.log(`[knowledge-backfill] done ${done}/${missing.length}`);
    if (done === 0 && diskFullHits >= 10) {
      try { _getSendCeoAlert()('[RAG] Ổ đĩa đầy — không lưu được chỉ mục tìm kiếm. Giải phóng 500MB rồi khởi động lại.'); } catch {}
      try { auditLog('rag_backfill_disk_full', { attempted: missing.length, diskFullHits }); } catch {}
    }
  } catch (e) {
    console.warn('[knowledge-backfill] error:', e.message);
  } finally {
    _backfillInProgress = false;
    try { db.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
//  ensureKnowledgeChunksSchema
// ---------------------------------------------------------------------------
function ensureKnowledgeChunksSchema(db) {
  if (!db) return;
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL,
        category TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        char_start INTEGER,
        char_end INTEGER,
        FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_doc ON documents_chunks(document_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_cat ON documents_chunks(category);
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_chunks_fts USING fts5(
        content,
        content_plain,
        tokens,
        tokenize = "unicode61 remove_diacritics 2"
      );
      CREATE TRIGGER IF NOT EXISTS documents_chunks_ad
        AFTER DELETE ON documents_chunks BEGIN
          DELETE FROM documents_chunks_fts WHERE rowid = old.id;
        END;
    `);
  } catch (e) {
    console.error('[knowledge] chunk schema migrate error:', e.message);
  }

  // v2.3.47 — add embedding column for Knowledge RAG
  try {
    const cols = db.prepare("PRAGMA table_info(documents_chunks)").all();
    const hasEmbedding = cols.some(c => c.name === 'embedding');
    const hasModelStamp = cols.some(c => c.name === 'embedding_model');
    if (!hasEmbedding) {
      db.exec('ALTER TABLE documents_chunks ADD COLUMN embedding BLOB');
      console.log('[knowledge-schema] added embedding column');
    }
    if (!hasModelStamp) {
      db.exec('ALTER TABLE documents_chunks ADD COLUMN embedding_model TEXT');
      console.log('[knowledge-schema] added embedding_model column');
    }
  } catch (e) {
    console.warn('[knowledge-schema] embedding migration warning:', e.message);
  }
}

// ---------------------------------------------------------------------------
//  indexDocumentChunks
// ---------------------------------------------------------------------------
function indexDocumentChunks(db, documentId, category, rawText) {
  if (!db) return { chunks: 0, totalChars: 0 };
  try {
    ensureKnowledgeChunksSchema(db);
    const chunks = chunkVietnameseText(rawText || '');
    const txn = db.transaction(() => {
      db.prepare('DELETE FROM documents_chunks WHERE document_id = ?').run(documentId);
      const insChunk = db.prepare(
        'INSERT INTO documents_chunks (document_id, category, chunk_index, char_start, char_end) VALUES (?, ?, ?, ?, ?)'
      );
      const insFts = db.prepare(
        'INSERT INTO documents_chunks_fts (rowid, content, content_plain, tokens) VALUES (?, ?, ?, ?)'
      );
      for (const c of chunks) {
        const info = insChunk.run(documentId, category, c.index, c.char_start, c.char_end);
        const rowid = Number(info.lastInsertRowid);
        insFts.run(rowid, c.content, normalizeForSearch(c.content), tokenizeForSearch(c.content));
      }
    });
    txn();
    const totalChars = chunks.reduce((s, c) => s + c.content.length, 0);
    return { chunks: chunks.length, totalChars };
  } catch (e) {
    console.error('[knowledge] indexDocumentChunks error:', e.message);
    return { chunks: 0, totalChars: 0, error: e.message };
  }
}

// ---------------------------------------------------------------------------
//  backfillDocumentChunks
// ---------------------------------------------------------------------------
async function backfillDocumentChunks() {
  const db = getDocumentsDb();
  if (!db) return;
  try {
    ensureKnowledgeChunksSchema(db);
    const rows = db.prepare(`
      SELECT d.id, d.category, d.content
      FROM documents d
      LEFT JOIN (SELECT document_id, COUNT(*) c FROM documents_chunks GROUP BY document_id) x
        ON x.document_id = d.id
      WHERE x.c IS NULL OR x.c = 0
    `).all();
    let indexed = 0, totalChunks = 0;
    for (const r of rows) {
      if (!r.content) continue;
      const res = indexDocumentChunks(db, r.id, r.category || 'general', r.content);
      if (res.chunks > 0) { indexed += 1; totalChunks += res.chunks; }
    }
    if (indexed > 0) console.log(`[knowledge] backfill chunks: indexed ${indexed} docs, ${totalChunks} chunks`);
  } catch (e) {
    console.error('[knowledge] backfillDocumentChunks error:', e.message);
  } finally {
    try { db.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
//  autoFixBetterSqlite3
// ---------------------------------------------------------------------------
function autoFixBetterSqlite3() {
  if (_documentsDbAutoFixAttempted) return false;
  _documentsDbAutoFixAttempted = true;
  try {
    // V1: in packaged Electron, __dirname is inside app.asar (virtual fs).
    // scripts/** + better-sqlite3/** are in asarUnpack list, so they're
    // at app.asar.unpacked/... — resolve correctly by probing both paths.
    const electronDir = path.join(__dirname, '..');
    const asarUnpacked = electronDir.replace(/[\\/]app\.asar($|[\\/])/i, (m, _tail) => m.replace('app.asar', 'app.asar.unpacked'));
    const candScripts = [
      path.join(asarUnpacked, 'scripts', 'fix-better-sqlite3.js'),
      path.join(electronDir, 'scripts', 'fix-better-sqlite3.js'),
    ];
    let fixScript = null;
    for (const p of candScripts) { if (fs.existsSync(p)) { fixScript = p; break; } }
    if (!fixScript) {
      console.error('[documents] auto-fix script not found in asar.unpacked nor __dirname');
      return false;
    }
    const nodeBin = (typeof getBundledNodeBin === 'function' && getBundledNodeBin()) || 'node';
    const scriptCwd = path.dirname(path.dirname(fixScript)); // parent of scripts/
    console.log('[documents] auto-fixing better-sqlite3 ABI via', nodeBin, fixScript);
    require('child_process').execFileSync(nodeBin, [fixScript], {
      cwd: scriptCwd,
      timeout: 120000,
      stdio: 'inherit',
    });
    try {
      const moduleId = require.resolve('better-sqlite3');
      delete require.cache[moduleId];
    } catch {}
    console.log('[documents] auto-fix complete — retrying DB open');
    return true;
  } catch (e) {
    console.error('[documents] auto-fix failed:', e.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
//  ensureDocumentsSchema — idempotent schema creation + migration
// ---------------------------------------------------------------------------
function ensureDocumentsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      content TEXT,
      filetype TEXT,
      filesize INTEGER,
      word_count INTEGER,
      category TEXT DEFAULT 'general',
      summary TEXT,
      visibility TEXT NOT NULL DEFAULT 'public',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      filename, content, tokenize='unicode61'
    );
  `);
  try { db.exec(`ALTER TABLE documents ADD COLUMN category TEXT DEFAULT 'general'`); } catch {}
  try { db.exec(`ALTER TABLE documents ADD COLUMN summary TEXT`); } catch {}
  try { db.exec(`ALTER TABLE documents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_visibility ON documents(visibility)`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_cat_vis ON documents(category, visibility)`); } catch {}
  try { ensureKnowledgeChunksSchema(db); } catch (e) {
    console.warn('[documents] chunk schema init failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
//  getDocumentsDb
// ---------------------------------------------------------------------------
function getDocumentsDb() {
  try {
    const Database = require('better-sqlite3');
    const ws = getWorkspace();
    try { fs.mkdirSync(ws, { recursive: true }); } catch {}
    const dbPath = path.join(ws, 'memory.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    if (!_documentsDbSchemaReady) {
      ensureDocumentsSchema(db);
      try {
        const cols = db.prepare("PRAGMA table_info(documents_chunks)").all();
        const hasEmbedding = cols.some(c => c.name === 'embedding');
        const hasEmbeddingModel = cols.some(c => c.name === 'embedding_model');
        if (hasEmbedding && hasEmbeddingModel) {
          _documentsDbSchemaReady = true;
        } else {
          console.warn('[documents] schema incomplete — embedding columns missing, will retry next open');
        }
      } catch {}
    }
    return db;
  } catch (e) {
    if (/NODE_MODULE_VERSION|incompatible architecture|mach-o.*arch|invalid ELF header|dlopen.*Mach-O/i.test(e.message) && !_documentsDbAutoFixAttempted) {
      console.error('[documents] DB error (ABI mismatch):', e.message);
      const fixed = autoFixBetterSqlite3();
      if (fixed) {
        try {
          const Database = require('better-sqlite3');
          const ws = getWorkspace();
          const dbPath = path.join(ws, 'memory.db');
          const db = new Database(dbPath);
          ensureDocumentsSchema(db);
          console.log('[documents] DB now working after auto-fix');
          return db;
        } catch (e2) {
          console.error('[documents] DB still broken after auto-fix:', e2.message);
        }
      }
    }
    const now = Date.now();
    if (now - _documentsDbLastErrorAt >= DOCUMENTS_DB_ERROR_LOG_INTERVAL_MS) {
      console.error('[documents] DB error:', e.message);
      if (/NODE_MODULE_VERSION|incompatible architecture|mach-o.*arch|invalid ELF header|dlopen.*Mach-O/i.test(e.message)) {
        console.error('[documents] better-sqlite3 ABI mismatch persists — using disk-only fallback for Knowledge tab.');
        console.error('[documents] Manual fix: cd electron && rm -rf node_modules/better-sqlite3/build && npm install');
      }
      _documentsDbLastErrorAt = now;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
//  Knowledge categories
// ---------------------------------------------------------------------------
const DEFAULT_KNOWLEDGE_CATEGORIES = ['cong-ty', 'san-pham', 'nhan-vien'];
const KNOWLEDGE_LABELS = {
  'cong-ty': 'Công ty',
  'san-pham': 'Sản phẩm',
  'nhan-vien': 'Nhân viên',
};

function getKnowledgeCategories() {
  const ws = getWorkspace();
  const knowDir = path.join(ws, 'knowledge');
  if (!fs.existsSync(knowDir)) return [...DEFAULT_KNOWLEDGE_CATEGORIES];
  try {
    const dirs = fs.readdirSync(knowDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    const set = new Set(dirs);
    for (const d of DEFAULT_KNOWLEDGE_CATEGORIES) set.add(d);
    return [...set].sort();
  } catch { return [...DEFAULT_KNOWLEDGE_CATEGORIES]; }
}

// Compat shim — old code references KNOWLEDGE_CATEGORIES
const KNOWLEDGE_CATEGORIES = new Proxy(DEFAULT_KNOWLEDGE_CATEGORIES, {
  get(target, prop) {
    if (prop === 'includes') return (cat) => {
      if (DEFAULT_KNOWLEDGE_CATEGORIES.includes(cat)) return true;
      const dir = path.join(getWorkspace(), 'knowledge', cat);
      return fs.existsSync(dir);
    };
    return target[prop];
  }
});

function getKnowledgeDir(category) {
  if (!/^[a-z0-9-]+$/.test(category)) throw new Error('Invalid category name: ' + category);
  return path.join(getWorkspace(), 'knowledge', category);
}

// ---------------------------------------------------------------------------
//  Document row insert
// ---------------------------------------------------------------------------
function insertDocumentRow(db, {
  filename, filepath, content, filetype, filesize, wordCount,
  category = 'general', summary = null, visibility = 'public'
}) {
  if (!['public', 'internal', 'private'].includes(visibility)) {
    throw new Error(`insertDocumentRow: invalid visibility "${visibility}"`);
  }
  return db.prepare(
    'INSERT INTO documents (filename, filepath, content, filetype, filesize, word_count, category, summary, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(filename, filepath, content, filetype, filesize, wordCount, category, summary, visibility);
}

// ---------------------------------------------------------------------------
//  ensureKnowledgeFolders
// ---------------------------------------------------------------------------
function ensureKnowledgeFolders() {
  const ws = getWorkspace();
  for (const cat of getKnowledgeCategories()) {
    const dir = path.join(ws, 'knowledge', cat, 'files');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const indexFile = path.join(ws, 'knowledge', cat, 'index.md');
    if (!fs.existsSync(indexFile)) {
      const label = KNOWLEDGE_LABELS[cat] || cat;
      try {
        fs.writeFileSync(
          indexFile,
          `# Knowledge — ${label}\n\n*Chưa có tài liệu nào. CEO upload file qua Dashboard → Knowledge.*\n`,
          'utf-8'
        );
      } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
//  backfillKnowledgeFromDisk
// ---------------------------------------------------------------------------
async function backfillKnowledgeFromDisk() {
  const db = getDocumentsDb();
  if (!db) return;
  let inserted = 0;
  for (const cat of getKnowledgeCategories()) {
    let existing = new Set();
    try {
      for (const r of db.prepare('SELECT filename FROM documents WHERE category = ?').all(cat)) existing.add(r.filename);
    } catch {}
    const filesDir = path.join(getKnowledgeDir(cat), 'files');
    if (!fs.existsSync(filesDir)) continue;
    for (const entry of fs.readdirSync(filesDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (existing.has(entry.name)) continue;
      const fp = path.join(filesDir, entry.name);
      let stat;
      try { stat = fs.statSync(fp); } catch { continue; }
      const filetype = path.extname(entry.name).toLowerCase().replace('.', '');
      let content = '';
      try { content = await extractTextFromFile(fp, entry.name); } catch {}
      const isImage = /\.(jpe?g|png|gif|webp|bmp)$/i.test(entry.name);
      if (isImage && !content) {
        console.log('[backfill] skipping image (vision not ready?):', entry.name);
        continue;
      }
      const wordCount = content ? content.split(/\s+/).length : 0;
      try {
        insertDocumentRow(db, {
          filename: entry.name, filepath: fp, content,
          filetype, filesize: stat.size, wordCount,
          category: cat, summary: null, visibility: 'public'
        });
        try { db.prepare('INSERT INTO documents_fts (filename, content) VALUES (?, ?)').run(entry.name, content); } catch {}
        inserted++;
      } catch (e) { console.error('[knowledge] backfill insert err:', entry.name, e.message); }
    }
  }
  try { db.close(); } catch {}
  if (inserted > 0) {
    console.log('[knowledge] backfilled', inserted, 'file(s) from disk into DB');
    for (const cat of getKnowledgeCategories()) rewriteKnowledgeIndex(cat);
  }
}

// ---------------------------------------------------------------------------
//  resolveUniqueFilename
// ---------------------------------------------------------------------------
function resolveUniqueFilename(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = filename;
  let n = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    n++;
    candidate = `${base}-${n}${ext}`;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
//  describeImageForKnowledge
// ---------------------------------------------------------------------------
async function describeImageForKnowledge(imagePath, filename) {
  const fallback = `[Ảnh: ${filename}] Không thể mô tả tự động. CEO có thể thêm mô tả thủ công vào Knowledge.`;
  const prompt = `Mô tả chi tiết ảnh "${filename}" để lưu vào hệ thống Knowledge doanh nghiệp.

Yêu cầu mô tả SIÊU KỸ — mọi chi tiết đều quan trọng cho tìm kiếm sau này:

1. **Sản phẩm** (nếu có): tên, thương hiệu, model, dòng sản phẩm, thế hệ, phiên bản
2. **Đặc điểm vật lý**: màu sắc (chính xác: "đen nhám", "xanh dương đậm", không chỉ "xanh"), kích thước ước tính, chất liệu bề mặt, hình dạng
3. **Text trong ảnh**: đọc TOÀN BỘ chữ hiển thị — nhãn, giá, thông số, barcode text, watermark, logo text
4. **Thông số kỹ thuật** (nếu thấy): dung lượng, RAM, camera, pin, CPU, kích thước màn hình
5. **Phụ kiện / đi kèm**: hộp, sạc, tai nghe, ốp lưng, giấy bảo hành
6. **Tình trạng**: mới nguyên seal / đã khui hộp / đã qua sử dụng / trầy xước
7. **Bối cảnh**: chụp trên kệ shop, trên bàn, studio, ảnh quảng cáo, ảnh khách gửi
8. **Giá cả**: nếu thấy tag giá, bảng giá, watermark giá
9. **So sánh**: nếu có nhiều sản phẩm trong ảnh, so sánh kích thước/màu giữa chúng
10. **Loại ảnh**: ảnh sản phẩm, ảnh biên lai, ảnh CCCD, ảnh bảng giá, ảnh showroom, ảnh chat screenshot

Trả lời bằng tiếng Việt, dạng paragraph mô tả tự nhiên (KHÔNG dùng bullet points). Viết như đang mô tả cho người không nhìn thấy ảnh. Càng chi tiết càng tốt — 300-500 từ.`;

  const result = await call9RouterVision(imagePath, prompt);
  if (!result) {
    console.log(`[knowledge-vision] AI vision failed for ${filename}, using fallback`);
    return fallback;
  }
  console.log(`[knowledge-vision] AI described ${filename}: ${result.length} chars`);
  return `[Ảnh: ${filename}]\n\n${result}`;
}

function hasEnoughPdfText(text) {
  if (!text || String(text).trim().length < 200) return false;
  const s = String(text);
  const printable = (s.match(/[\x20-\x7E\u00C0-\u024F\u1E00-\u1EFF]/g) || []).length;
  return printable / Math.max(1, s.length) >= 0.30;
}

async function describePdfScanForKnowledge(pdfPath, filename, options = {}) {
  let result;
  try {
    result = await mediaLibrary.renderPdfPagesToMedia(pdfPath, {
      title: path.basename(filename, path.extname(filename)),
      visibility: options.visibility || 'public',
      knowledgeFilename: filename,
      knowledgeFilepath: pdfPath,
      knowledgeCategory: options.category || '',
      documentId: options.documentId || null,
      describe: true,
      maxPages: Infinity,
    });
  } catch (e) {
    throw new Error(mediaLibrary.localizeMediaError ? mediaLibrary.localizeMediaError(e) : e.message);
  }
  const ready = (result.assets || []).filter(a => a.description && a.status === 'ready');
  if (ready.length === 0) {
    const firstError = (result.assets || []).find(a => a.error)?.error || 'no page description generated';
    throw new Error(mediaLibrary.localizeMediaError ? mediaLibrary.localizeMediaError(firstError) : firstError);
  }
  const parts = ready.map(a => {
    const page = a.metadata?.page || '?';
    return `=== PDF scan page ${page}/${result.pages} - ${filename} ===\n${a.description}`;
  });
  return `[PDF scan: ${filename}]\n\n${parts.join('\n\n')}`;
}

// ---------------------------------------------------------------------------
//  summarizeKnowledgeContent
// ---------------------------------------------------------------------------
async function summarizeKnowledgeContent(content, filename) {
  const fallback = () => {
    return `(tom tat chua san sang cho ${filename} — 9Router offline, file da luu)`;
  };
  if (!content || content.length < 30) return fallback();
  const truncated = content.length > 4000 ? content.substring(0, 4000) + '...' : content;
  const result = await call9Router(
    `Tóm tắt file "${filename}" trong 1-2 câu tiếng Việt ngắn gọn (tối đa 200 ký tự). Chỉ trả về tóm tắt, không thêm giải thích.\n\n---\n${truncated}`,
    { maxTokens: 120, temperature: 0.3, timeoutMs: 15000 }
  );
  return result ? result.substring(0, 300) : fallback();
}

// ---------------------------------------------------------------------------
//  sanitizeKnowledgeContentForIndex
// ---------------------------------------------------------------------------
function sanitizeKnowledgeContentForIndex(raw) {
  if (!raw) return '';
  let s = String(raw);
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/^(#{1,6} )/gm, '\\$1');
  s = s.replace(/^[ \t]*---+[ \t]*$/gm, '- - -');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

// ---------------------------------------------------------------------------
//  rewriteKnowledgeIndex
// ---------------------------------------------------------------------------
function rewriteKnowledgeIndex(category) {
  const ws = getWorkspace();
  const indexFile = path.join(ws, 'knowledge', category, 'index.md');
  let rows = [];
  let nonPublicSet = null;
  const db = getDocumentsDb();
  if (db) {
    try {
      rows = db.prepare(
        "SELECT filename, summary, filesize, created_at FROM documents WHERE category = ? AND visibility = 'public' ORDER BY created_at DESC"
      ).all(category);
    } catch (e) { console.error('[knowledge] rewrite index db query:', e.message); }
    try {
      const npRows = db.prepare("SELECT filename FROM documents WHERE category = ? AND visibility != 'public'").all(category);
      nonPublicSet = new Set(npRows.map(r => r.filename));
    } catch {}
    try { db.close(); } catch {}
  }
  const dbNames = new Set(rows.map(r => r.filename));
  for (const f of listKnowledgeFilesFromDisk(category)) {
    if (dbNames.has(f.filename)) continue;
    if (nonPublicSet !== null && nonPublicSet.has(f.filename)) continue;
    rows.push({ filename: f.filename, summary: null, filesize: f.filesize, created_at: f.created_at });
  }
  try {
    const lines = [];
    lines.push(`# Knowledge — ${KNOWLEDGE_LABELS[category] || category}\n`);
    if (rows.length === 0) {
      lines.push('*Chưa có tài liệu nào. CEO upload file qua Dashboard → Knowledge.*\n');
    } else {
      lines.push(`Tổng: ${rows.length} tài liệu. Bot dùng search vector khi khách hỏi (không nạp toàn bộ nội dung).\n`);
      for (const r of rows) {
        lines.push(`- **${r.filename}** (${((r.filesize || 0) / 1024).toFixed(1)} KB, uploaded ${r.created_at})`);
        if (r.summary) lines.push(`  *${r.summary.slice(0, 200)}*`);
        lines.push('');
      }
    }
    const tmpFile = indexFile + '.tmp';
    const fd = fs.openSync(tmpFile, 'w');
    try {
      fs.writeSync(fd, lines.join('\n'));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpFile, indexFile);
    console.log(`[knowledge-index] ${category}: ${rows.length} files, ${Buffer.byteLength(lines.join('\n'), 'utf-8')} chars in index.md`);
  } catch (e) { console.error('[knowledge] rewrite index write:', e.message); }
}

// ---------------------------------------------------------------------------
//  listKnowledgeFilesFromDisk
// ---------------------------------------------------------------------------
function listKnowledgeFilesFromDisk(category) {
  try {
    const dir = path.join(getKnowledgeDir(category), 'files');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => {
        const fp = path.join(dir, e.name);
        let st = null;
        try { st = fs.statSync(fp); } catch {}
        return {
          filename: e.name,
          filetype: path.extname(e.name).toLowerCase().replace('.', ''),
          filesize: st ? st.size : 0,
          word_count: 0,
          summary: null,
          visibility: 'public',
          created_at: st ? new Date(st.mtimeMs).toISOString().replace('T', ' ').slice(0, 19) : '',
          _source: 'disk',
        };
      })
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  } catch (e) {
    console.error('[knowledge] disk list error:', e.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
//  Synonyms + FTS5 helpers
// ---------------------------------------------------------------------------
let _synonymsCache = null;
function loadSynonyms() {
  if (_synonymsCache) return _synonymsCache;
  try {
    // data/ is at electron/data/ — from lib/ we go up one level
    const p = path.join(__dirname, '..', 'data', 'synonyms-vi.json');
    _synonymsCache = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.warn('[knowledge-search] synonyms-vi.json not found, using empty dict');
    _synonymsCache = {};
  }
  return _synonymsCache;
}

function _ftsEscapeToken(tok) {
  if (!tok) return '';
  return String(tok).replace(/[^a-z0-9_]/g, '');
}

function expandSynonyms(normalizedQuery) {
  const syn = loadSynonyms();
  const tokens = String(normalizedQuery || '')
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 0 && !VI_STOPWORDS.has(t));
  if (tokens.length === 0) return '';

  const groups = [];
  const seenExpansions = new Set();

  let i = 0;
  while (i < tokens.length) {
    let matchedKey = null;
    let consume = 1;
    if (i + 1 < tokens.length) {
      const bigram = tokens[i] + ' ' + tokens[i + 1];
      if (syn[bigram]) { matchedKey = bigram; consume = 2; }
    }
    if (!matchedKey && syn[tokens[i]]) matchedKey = tokens[i];

    const base = matchedKey || tokens[i];
    const variants = matchedKey ? (Array.isArray(syn[matchedKey]) ? [base, ...syn[matchedKey]] : [base]) : [base];

    const ftsParts = [];
    for (const v of variants) {
      const subtoks = String(v).toLowerCase().split(/[^a-z0-9]+/).map(_ftsEscapeToken).filter(Boolean);
      if (subtoks.length === 0) continue;
      const expr = subtoks.length === 1 ? subtoks[0] : `"${subtoks.join(' ')}"`;
      if (!seenExpansions.has(expr)) {
        seenExpansions.add(expr);
        ftsParts.push(expr);
      }
    }
    if (ftsParts.length > 0) {
      groups.push(ftsParts.length === 1 ? ftsParts[0] : `(${ftsParts.join(' OR ')})`);
    }
    i += consume;
  }
  return groups.join(' AND ');
}

// ---------------------------------------------------------------------------
//  searchKnowledgeFTS5
// ---------------------------------------------------------------------------
function searchKnowledgeFTS5(opts, sharedDb) {
  const { query, category, limit, audience = 'customer' } = opts || {};
  const allowedTiers = audience === 'ceo'      ? ['public', 'internal', 'private']
                     : audience === 'internal' ? ['public', 'internal']
                                               : ['public'];
  const visPlaceholders = allowedTiers.map(() => '?').join(',');
  const lim = Math.max(1, Math.min(50, Number(limit) || 5));
  if (!query || !String(query).trim()) return [];

  const normalized = normalizeForSearch(query);
  const matchExpr = expandSynonyms(normalized);

  const db = sharedDb || getDocumentsDb();
  if (!db) {
    const err = new Error('DB unavailable');
    err.code = 'DB_UNAVAILABLE';
    throw err;
  }
  if (!sharedDb) {
    try { ensureKnowledgeChunksSchema(db); } catch {}
  }

  const baseSelect = `
    SELECT dc.id AS chunk_id, dc.document_id, dc.category, dc.chunk_index,
           dc.char_start, dc.char_end, d.filename,
           bm25(documents_chunks_fts) AS score,
           highlight(documents_chunks_fts, 0, '<b>', '</b>') AS snippet
    FROM documents_chunks_fts
    JOIN documents_chunks dc ON dc.id = documents_chunks_fts.rowid
    JOIN documents d ON d.id = dc.document_id
    WHERE documents_chunks_fts MATCH ?
      AND d.visibility IN (${visPlaceholders})
  `;
  const catClause = category ? ' AND dc.category = ?' : '';
  const orderLimit = ' ORDER BY bm25(documents_chunks_fts) LIMIT ?';

  function tryMatch(expr) {
    const sql = baseSelect + catClause + orderLimit;
    const args = category
      ? [expr, ...allowedTiers, category, lim]
      : [expr, ...allowedTiers, lim];
    return db.prepare(sql).all(...args);
  }

  let results = [];
  let usedExpr = matchExpr;

  // Tier 1: full synonym-expanded MATCH.
  if (matchExpr) {
    try { results = tryMatch(matchExpr); } catch (e) {
      console.warn('[knowledge-search] tier1 MATCH failed:', e.message);
      results = [];
    }
  }

  // Tier 2: bare tokens
  if (results.length === 0) {
    const bare = String(normalized).split(/[^a-z0-9]+/)
      .filter(t => t.length >= 2 && !VI_STOPWORDS.has(t))
      .map(_ftsEscapeToken).filter(Boolean);
    if (bare.length > 0) {
      const expr2 = bare.join(' OR ');
      usedExpr = expr2;
      try { results = tryMatch(expr2); } catch (e) {
        console.warn('[knowledge-search] tier2 MATCH failed:', e.message);
        results = [];
      }
    }
  }

  // Tier 3: LIKE scan
  if (results.length === 0) {
    try {
      const like = '%' + String(normalized).replace(/[%_]/g, '') + '%';
      const sql3 = `
        SELECT NULL AS chunk_id, d.id AS document_id, d.category, 0 AS chunk_index,
               0 AS char_start, 0 AS char_end, d.filename,
               999.0 AS score,
               substr(d.content, 1, 300) AS snippet
        FROM documents d
        WHERE d.visibility IN (${visPlaceholders})
          AND (d.content LIKE ? OR d.filename LIKE ?)
        ${category ? 'AND d.category = ?' : ''}
        LIMIT ?
      `;
      const args3 = category
        ? [...allowedTiers, like, like, category, lim]
        : [...allowedTiers, like, like, lim];
      results = db.prepare(sql3).all(...args3);
      usedExpr = 'LIKE:' + like;
    } catch (e) {
      console.warn('[knowledge-search] tier3 LIKE failed:', e.message);
      results = [];
    }
  }

  if (!sharedDb) {
    try { db.close(); } catch {}
  }
  try {
    console.log(`[knowledge-search] query="${String(query).slice(0, 80)}" expanded="${String(usedExpr).slice(0, 120)}" results=${results.length}`);
  } catch {}
  return results;
}

// ---------------------------------------------------------------------------
//  RRF + price filter helpers
// ---------------------------------------------------------------------------
function rrfMerge(lists, k = 60, topK = 10) {
  const scores = new Map();
  for (const list of lists) {
    let rank = 0;
    for (const id of list) {
      if (id == null) continue;
      scores.set(id, (scores.get(id) || 0) + 1 / (k + rank + 1));
      rank++;
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id]) => id);
}

function parsePriceFilter(query) {
  const q = stripViDiacritics(String(query || '')).toLowerCase().replace(/\s+/g, ' ').trim();
  const toVnd = (num, unit) => {
    const n = parseFloat(String(num).replace(/,/g, '.'));
    if (!Number.isFinite(n) || n < 0) return null;
    if (unit === 'ty') return n * 1_000_000_000;
    if (unit === 'trieu' || unit === 'tr') return n * 1_000_000;
    if (unit === 'k' || unit === 'nghin' || unit === 'ngan') return n * 1_000;
    return null;
  };
  const under = q.match(/(?:duoi|<|<=|toi da|it hon)\s*(\d+(?:[.,]\d+)?)\s*(ty|trieu|tr|k|nghin|ngan)?\b/);
  const over = q.match(/(?:tren|>|>=|toi thieu|nhieu hon|hon)\s*(\d+(?:[.,]\d+)?)\s*(ty|trieu|tr|k|nghin|ngan)?\b/);
  const result = {};
  if (under) { const v = toVnd(under[1], under[2]); if (v != null) result.max = v; }
  if (over) { const v = toVnd(over[1], over[2]); if (v != null) result.min = v; }
  return (result.min != null || result.max != null) ? result : null;
}

function extractChunkPrice(text) {
  if (!text) return null;
  const m = String(text).match(/([\d.]+)\s*(?:VND|VNĐ|đồng|đ)\b/i);
  if (!m) return null;
  const raw = m[1].replace(/\./g, '');
  if (raw.length < 4) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function mergeMediaSearchResults(query, rows, { limit = 3, audience = 'customer' } = {}) {
  const base = Array.isArray(rows) ? rows.slice(0, limit) : [];
  try {
    const mediaHits = mediaLibrary.searchMediaAssets(query, { audience, limit });
    const existing = new Set(base.map(r => r.media?.id).filter(Boolean));
    for (const asset of mediaHits) {
      if (existing.has(asset.id)) continue;
      base.push({
        id: `media:${asset.id}`,
        chunk_id: null,
        document_id: null,
        chunk_index: 0,
        filename: asset.filename,
        snippet: asset.description || asset.title || asset.filename,
        score: asset.score || 0,
        media: {
          id: asset.id,
          type: asset.type,
          title: asset.title,
          filename: asset.filename,
          relPath: asset.relPath,
          mime: asset.mime,
          visibility: asset.visibility,
          tags: asset.tags || [],
        },
      });
      if (base.length >= limit) break;
    }
  } catch (e) {
    console.warn('[knowledge-search] media merge skipped:', e.message);
  }
  return base.slice(0, limit);
}

// ---------------------------------------------------------------------------
//  Tier 2 helpers
// ---------------------------------------------------------------------------
function _tier2LocalDayKey(now = Date.now()) {
  const offsetMs = 7 * 3600 * 1000;  // ICT = UTC+7
  return new Date(now + offsetMs).toISOString().slice(0, 10);
}

function _tier2CounterPath() { return path.join(getWorkspace(), 'tier2-counter.json'); }
function _tier2LoadCounter() {
  try {
    const data = JSON.parse(fs.readFileSync(_tier2CounterPath(), 'utf-8'));
    return { day: String(data.day || ''), calls: Number(data.calls || 0) };
  } catch { return { day: '', calls: 0 }; }
}
function _tier2SaveCounter(day, calls) {
  try {
    writeJsonAtomic(_tier2CounterPath(), { day, calls, updatedAt: new Date().toISOString() });
    global.__tier2WriteFailCount = 0;
  } catch (e1) {
    global.__tier2WriteFailCount = (global.__tier2WriteFailCount || 0) + 1;
    console.warn(`[tier2] counter persist failed (${global.__tier2WriteFailCount}x): ${e1.message}`);
    if (global.__tier2WriteFailCount === 3 && !global.__tier2AlertSent) {
      global.__tier2AlertSent = true;
      try { _getSendCeoAlert()(`[Cảnh báo Tier 2] Không ghi được tier2-counter.json 3 lần liên tiếp (AV lock?). Counter có thể drift, over-budget. Error: ${e1.message}`); } catch {}
    }
  }
}

const TIER2_BACKOFF_STEPS_MS = [5, 10, 20, 40, 60, 120, 240, 240].map(m => m * 60_000);
const _TIER2_ALLOWED_MODELS = ['ninerouter/main', 'ninerouter/fast'];

// ---------------------------------------------------------------------------
//  getRagConfig
// ---------------------------------------------------------------------------
function getRagConfig() {
  const DEFAULT = { tier2Enabled: false, rewriteModel: 'ninerouter/fast' };
  try {
    const p = path.join(getWorkspace(), 'rag-config.json');
    if (!fs.existsSync(p)) return { ...DEFAULT };
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!_TIER2_ALLOWED_MODELS.includes(cfg.rewriteModel)) {
      cfg.rewriteModel = 'ninerouter/fast';
    }
    cfg.tier2Enabled = !!cfg.tier2Enabled;
    return cfg;
  } catch { return { ...DEFAULT }; }
}

// ---------------------------------------------------------------------------
//  rewriteQueryViaAI
// ---------------------------------------------------------------------------
async function rewriteQueryViaAI(query, model) {
  const routerUrl = `http://127.0.0.1:20128/v1/chat/completions`;
  const safeModel = _TIER2_ALLOWED_MODELS.includes(model) ? model : 'ninerouter/fast';
  const body = {
    model: safeModel,
    messages: [
      { role: 'system', content: 'Bạn chuẩn hoá câu hỏi tiếng Việt của khách hàng để tìm kiếm. Thêm dấu nếu thiếu, bỏ từ lóng, viết rõ. CHỈ trả về câu đã chuẩn hoá, không giải thích. Không dùng ngoặc vuông, ngoặc nhọn, backtick, URL.' },
      { role: 'user', content: query },
    ],
    temperature: 0.1,
    max_tokens: 100,
  };
  const resp = await fetch(routerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  if (!resp.ok) throw new Error(`9router HTTP ${resp.status}`);
  const data = await resp.json();
  const rewritten = data?.choices?.[0]?.message?.content?.trim();
  if (!rewritten) throw new Error('empty rewrite');
  const clean = rewritten.replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!clean || clean.length > 200) throw new Error('rewrite too long or empty');
  if (/[\[\]{}`<>]|https?:\/\//i.test(clean)) throw new Error('rewrite contains disallowed chars');
  return clean;
}

// ---------------------------------------------------------------------------
//  searchKnowledge — primary entry point
// ---------------------------------------------------------------------------
async function searchKnowledge({ query, category, limit, audience = 'customer' } = {}) {
  _ensureEmbedderInit();
  const allowedTiers = audience === 'ceo'      ? ['public', 'internal', 'private']
                     : audience === 'internal' ? ['public', 'internal']
                                               : ['public'];
  const visPlaceholders = allowedTiers.map(() => '?').join(',');
  limit = Math.min(Math.max(parseInt(limit, 10) || 3, 1), 10);
  if (typeof query !== 'string' || !query.trim()) return [];
  const db = getDocumentsDb();
  if (!db) return mergeMediaSearchResults(query, [], { limit, audience });
  const _ragSearchStart = Date.now();
  const _queryHash = require('crypto').createHash('sha1').update(String(query || '')).digest('hex').slice(0, 10);
  let _ragTier = 'unknown';
  let _top1 = 0, _top2 = 0, _tier2Fired = false, _tier2Reason = null;
  let _semTop1 = 0, _semTop2 = 0;
  let _priceFilterDropAll = false;

  if (_backfillInProgress) {
    try {
      const fts = searchKnowledgeFTS5({ query, category, limit, audience }, db);
      return mergeMediaSearchResults(query, fts, { limit, audience });
    }
    finally { try { db.close(); } catch {} }
  }

  try {
    let rows = [];
    let scored = [];
    const priceFilter = parsePriceFilter(query);
    try {
      const qvec = await embedText(String(query || '').slice(0, 500), true);
      rows = category
        ? db.prepare(
            `SELECT c.id, c.document_id, c.chunk_index, c.char_start, c.char_end, c.embedding, d.filename, d.content
             FROM documents_chunks c JOIN documents d ON d.id = c.document_id
             WHERE d.visibility IN (${visPlaceholders})
               AND c.category = ? AND c.embedding IS NOT NULL
             ORDER BY c.id DESC LIMIT 2000`
          ).all(...allowedTiers, category)
        : db.prepare(
            `SELECT c.id, c.document_id, c.chunk_index, c.char_start, c.char_end, c.embedding, d.filename, d.content
             FROM documents_chunks c JOIN documents d ON d.id = c.document_id
             WHERE d.visibility IN (${visPlaceholders})
               AND c.embedding IS NOT NULL
             ORDER BY c.id DESC LIMIT 2000`
          ).all(...allowedTiers);

      if (priceFilter && rows.length > 0) {
        const priceForRow = rows.map(r => extractChunkPrice((r.content || '').substring(r.char_start, r.char_end)));
        const hadPricedRows = priceForRow.some(p => p !== null);
        const before = rows.length;
        rows = rows.filter((r, i) => {
          const p = priceForRow[i];
          if (p === null) return true;
          if (priceFilter.max != null && p > priceFilter.max) return false;
          if (priceFilter.min != null && p < priceFilter.min) return false;
          return true;
        });
        const stillHasPricedRows = rows.some((r, _origIdx) => {
          const p = extractChunkPrice((r.content || '').substring(r.char_start, r.char_end));
          return p !== null;
        });
        global.__priceFilterLogCounter = (global.__priceFilterLogCounter || 0) + 1;
        const _dropped = before !== rows.length;
        if (_dropped || global.__priceFilterLogCounter % 20 === 0) {
          console.log(`[knowledge-search] price filter ${JSON.stringify(priceFilter)} → ${before} → ${rows.length} rows${_dropped ? '' : ' (sampled)'}`);
        }
        if (hadPricedRows && !stillHasPricedRows) _priceFilterDropAll = true;
      }

      if (rows.length === 0) {
        if (_priceFilterDropAll) {
          console.log('[knowledge-search] price filter emptied priced rows — returning [] (shop has no inventory in range)');
          _ragTier = 'price-filter-empty';
          return [];
        }
        console.log('[knowledge-search] no embeddings — falling back to FTS5');
        _ragTier = 'fts5-no-embed';
        return mergeMediaSearchResults(query, searchKnowledgeFTS5({ query, category, limit, audience }, db), { limit, audience });
      }
      _ragTier = 'hybrid-rrf';

      const semRanked = rows.map(r => {
        try {
          const vec = blobToVec(r.embedding);
          return {
            id: r.id,
            document_id: r.document_id,
            chunk_index: r.chunk_index,
            filename: r.filename,
            snippet: (r.content || '').substring(r.char_start, r.char_end),
            score: cosineSim(qvec, vec),
          };
        } catch (e) {
          console.warn(`[knowledge-search] skip corrupt BLOB id=${r.id}: ${e.message}`);
          return null;
        }
      }).filter(Boolean).sort((a, b) => b.score - a.score);
      _semTop1 = semRanked[0]?.score || 0;
      _semTop2 = semRanked[1]?.score || 0;

      let ftsIds = [];
      try {
        const ftsResults = searchKnowledgeFTS5({ query, category, limit: 10, audience }, db);
        const eligible = new Set(semRanked.map(s => s.id));
        ftsIds = ftsResults
          .map(r => r.chunk_id || r.id)
          .filter(id => id && eligible.has(id));
      } catch (e) {
        console.warn('[knowledge-search] FTS5 partner errored (using sem only):', e.message);
      }

      if (ftsIds.length > 0) {
        const semIds = semRanked.slice(0, 10).map(s => s.id);
        const rrfIds = rrfMerge([semIds, ftsIds], 60, 10);
        const rrfSet = new Set(rrfIds);
        const byId = new Map(semRanked.map(s => [s.id, s]));
        const merged = [];
        for (const id of rrfIds) {
          const s = byId.get(id);
          if (s) merged.push(s);
        }
        for (const s of semRanked) {
          if (!rrfSet.has(s.id) && merged.length < 10) merged.push(s);
        }
        scored = merged;
      } else {
        scored = semRanked;
        _ragTier = 'hybrid-rrf-sem-only';
      }
    } catch (e) {
      console.warn('[knowledge-search] vector search error, falling back to FTS5:', e.message);
      _ragTier = 'fts5-error';
      return mergeMediaSearchResults(query, searchKnowledgeFTS5({ query, category, limit, audience }, db), { limit, audience });
    }
    _top1 = scored[0]?.score || 0;
    _top2 = scored[1]?.score || 0;

    // Tier 2 — 2-signal OR gate
    const cfg = getRagConfig();
    if (cfg.tier2Enabled && scored.length >= 2) {
      const now = Date.now();
      const todayKey = _tier2LocalDayKey(now);

      if (!global.__tier2CounterHydrated) {
        const persisted = _tier2LoadCounter();
        if (persisted.day === todayKey) {
          global.__tier2DayKey = todayKey;
          global.__tier2CallsToday = persisted.calls;
        }
        global.__tier2CounterHydrated = true;
      }
      if (global.__tier2DayKey !== todayKey) {
        global.__tier2DayKey = todayKey;
        global.__tier2CallsToday = 0;
        global.__tier2ConsecutiveTrips = 0;
        _tier2SaveCounter(todayKey, 0);
      }
      const TIER2_DAILY_CAP = 500;

      if (!(global.__tier2CooldownUntil && now < global.__tier2CooldownUntil)
          && (global.__tier2CallsToday || 0) < TIER2_DAILY_CAP) {
        const top1 = _semTop1;
        const top2 = _semTop2;
        const qStr = String(query);
        const tokenCount = qStr.trim().split(/\s+/).length;
        const VI_FUNCWORDS = /\b(co|khong|ko|bao|nhieu|nao|gi|sao|lam|duoc|hay|the|cho|voi|cua|va|de|toi|ban|minh|ai|dau|khi|phai|may|gia|ban|chua|thi|muon|can|tim|mua|xem|hoi|shop|gui|nhan)\b/i;
        const noDiacritic = /[a-z]{3,}/i.test(qStr)
          && !/[\u00C0-\u024F\u1E00-\u1EFF]/.test(qStr)
          && tokenCount >= 3
          && qStr.length >= 15
          && VI_FUNCWORDS.test(qStr);
        const lowMargin = (top1 - top2) < 0.03;
        if (noDiacritic || lowMargin) {
          global.__tier2CallsToday = (global.__tier2CallsToday || 0) + 1;
          _tier2SaveCounter(todayKey, global.__tier2CallsToday);
          const reason = [noDiacritic && 'no-diacritic', lowMargin && 'low-margin'].filter(Boolean).join('+');
          _tier2Fired = true;
          _tier2Reason = reason;
          try {
            const rewritten = await rewriteQueryViaAI(qStr, cfg.rewriteModel);
            if (rewritten && typeof rewritten === 'string' && rewritten.trim() && rewritten !== qStr) {
              global.__tier2FailCount = 0;
              global.__tier2ConsecutiveTrips = 0;
              console.log(`[knowledge-search] tier2 rewrite: "${qStr}" → "${rewritten}"`);
              try { auditLog('tier2_rewrite', { reason, queryLen: qStr.length, rewrittenLen: rewritten.length, day: todayKey, callsToday: global.__tier2CallsToday }); } catch {}
              const qvec2 = await embedText(rewritten.slice(0, 500), true);
              const rescored = rows.map(r => {
                try {
                  return {
                    id: r.id, document_id: r.document_id, chunk_index: r.chunk_index,
                    filename: r.filename,
                    snippet: (r.content || '').substring(r.char_start, r.char_end),
                    score: cosineSim(qvec2, blobToVec(r.embedding)),
                  };
                } catch { return null; }
              }).filter(Boolean).sort((a, b) => b.score - a.score);
              if (rescored.length > 0 && rescored[0].score > scored[0].score) {
                return mergeMediaSearchResults(query, rescored.slice(0, limit), { limit, audience });
              }
            }
          } catch (e) {
            console.warn('[knowledge-search] tier2 rewrite skipped:', e.message);
            try { auditLog('tier2_rewrite_fail', { reason, err: String(e && e.message || e).slice(0, 200), day: todayKey }); } catch {}
            const window = 60_000;
            if (!global.__tier2FailWindowStart || now - global.__tier2FailWindowStart > window) {
              global.__tier2FailWindowStart = now;
              global.__tier2FailCount = 1;
            } else {
              global.__tier2FailCount = (global.__tier2FailCount || 0) + 1;
            }
            if (global.__tier2FailCount >= 3) {
              const trips = (global.__tier2ConsecutiveTrips || 0);
              const stepIdx = Math.min(trips, TIER2_BACKOFF_STEPS_MS.length - 1);
              const cooldownMs = TIER2_BACKOFF_STEPS_MS[stepIdx];
              global.__tier2CooldownUntil = now + cooldownMs;
              global.__tier2ConsecutiveTrips = trips + 1;
              const mins = Math.round(cooldownMs / 60_000);
              console.warn(`[knowledge-search] tier2 circuit breaker tripped — ${mins}min cooldown (trip #${trips + 1})`);
              try { auditLog('tier2_breaker_trip', { until: global.__tier2CooldownUntil, cooldownMins: mins, consecutiveTrips: trips + 1 }); } catch {}
              if (trips + 1 === 3) {
                try { _getSendCeoAlert()(`[Cảnh báo RAG] Tier 2 query-rewrite liên tục thất bại ${trips + 1} lần (cooldown ${mins} phút). Kiểm tra 9Router đăng nhập/cấu hình.`); } catch {}
              }
            }
          }
        }
      } else if ((global.__tier2CallsToday || 0) >= TIER2_DAILY_CAP) {
        if (!global.__tier2CapWarnedToday || global.__tier2CapWarnedToday !== todayKey) {
          console.warn(`[knowledge-search] tier2 daily cap reached (${TIER2_DAILY_CAP}) — rewrites disabled until tomorrow`);
          try { auditLog('tier2_daily_cap', { cap: TIER2_DAILY_CAP, day: todayKey }); } catch {}
          global.__tier2CapWarnedToday = todayKey;
        }
      }
    }

    return mergeMediaSearchResults(query, scored.slice(0, limit), { limit, audience });
  } finally {
    try { db.close(); } catch {}
    try {
      auditLog('rag_search', {
        queryHash: _queryHash,
        queryLen: String(query || '').length,
        tier: _ragTier,
        top1: Number(_top1.toFixed(4)),
        top2: Number(_top2.toFixed(4)),
        margin: Number((_top1 - _top2).toFixed(4)),
        tier2Fired: _tier2Fired,
        tier2Reason: _tier2Reason,
        durationMs: Date.now() - _ragSearchStart,
        cat: category || null,
      });
    } catch {}
  }
}

// ---------------------------------------------------------------------------
//  Knowledge search HTTP server
// ---------------------------------------------------------------------------
const KNOWLEDGE_HTTP_PORT = 20129;
let _knowledgeHttpServer = null;
let _knowledgeHttpSecret = null;

function _ragSecretPath() { return path.join(getWorkspace(), 'rag-secret.txt'); }
function _ensureRagSecret() {
  if (_knowledgeHttpSecret) return _knowledgeHttpSecret;
  try {
    const sp = _ragSecretPath();
    if (fs.existsSync(sp)) {
      const existing = fs.readFileSync(sp, 'utf-8').trim();
      if (existing.length >= 32) {
        _knowledgeHttpSecret = existing;
        return existing;
      }
    }
    const secret = require('crypto').randomBytes(32).toString('hex');
    fs.writeFileSync(sp, secret, 'utf-8');
    try { fs.chmodSync(sp, 0o600); } catch {}
    _knowledgeHttpSecret = secret;
    return secret;
  } catch (e) {
    console.warn('[knowledge-http] secret persist failed, using in-memory:', e.message);
    _knowledgeHttpSecret = require('crypto').randomBytes(32).toString('hex');
    return _knowledgeHttpSecret;
  }
}

const _httpRateLimitBuckets = new Map();
function _httpRateLimitCheck(ip) {
  const now = Date.now();
  const MAX = 60;
  const REFILL_PER_MS = MAX / 60_000;
  let bucket = _httpRateLimitBuckets.get(ip);
  if (!bucket) { bucket = { tokens: MAX, last: now }; _httpRateLimitBuckets.set(ip, bucket); }
  bucket.tokens = Math.min(MAX, bucket.tokens + (now - bucket.last) * REFILL_PER_MS);
  bucket.last = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function startKnowledgeSearchServer() {
  if (_knowledgeHttpServer) return;
  _ensureRagSecret();
  const http = require('http');
  const { URL } = require('url');
  _knowledgeHttpServer = http.createServer(async (req, res) => {
    try {
      const host = String(req.headers.host || '');
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'host denied' }));
        return;
      }
      const ip = req.socket?.remoteAddress || 'unknown';
      if (!_httpRateLimitCheck(ip)) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'rate limited' }));
        return;
      }
      const auth = String(req.headers.authorization || '');
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (token !== _knowledgeHttpSecret) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      const url = new URL(req.url, `http://127.0.0.1:${KNOWLEDGE_HTTP_PORT}`);
      if (url.pathname === '/audit-rag-degraded' && req.method === 'POST') {
        try { auditLog('rag_degraded', { at: Date.now() }); } catch {}
        res.writeHead(204); res.end();
        return;
      }
      if (url.pathname === '/health') {
        let coverage = null;
        try {
          const db2 = getDocumentsDb();
          if (db2) {
            try {
              const row = db2.prepare(
                "SELECT COUNT(*) AS total, COUNT(embedding) AS embedded FROM documents_chunks"
              ).get();
              coverage = { total: row.total, embedded: row.embedded, pct: row.total ? Math.round(row.embedded / row.total * 100) : 100 };
            } finally { try { db2.close(); } catch {} }
          }
        } catch {}
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ragHttp: 'ok',
          version: require('../package.json').version,
          embedder: getEmbedderState(),
          tier2: {
            callsToday: global.__tier2CallsToday || 0,
            dayKey: global.__tier2DayKey || null,
            failCount: global.__tier2FailCount || 0,
            cooldownUntil: global.__tier2CooldownUntil || 0,
            consecutiveTrips: global.__tier2ConsecutiveTrips || 0,
            cap: 500,
          },
          backfillInProgress: _backfillInProgress,
          coverage,
        }, null, 2));
        return;
      }
      if (url.pathname !== '/search') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      const query = url.searchParams.get('q') || '';
      const category = url.searchParams.get('cat') || null;
      const limit = parseInt(url.searchParams.get('k') || '3', 10);
      const rawAudience = url.searchParams.get('audience');
      const audience = (rawAudience === 'internal') ? 'internal' : 'customer';
      if (!query || query.length < 2) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ results: [] }));
        return;
      }
      const results = await searchKnowledge({ query, category, limit: Math.min(Math.max(limit, 1), 8), audience });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
  });
  _knowledgeHttpServer.listen(KNOWLEDGE_HTTP_PORT, '127.0.0.1', () => {
    console.log(`[knowledge-http] listening on http://127.0.0.1:${KNOWLEDGE_HTTP_PORT}/search (auth required)`);
  });
  _knowledgeHttpServer.on('error', (err) => {
    const isAddrInUse = err && err.code === 'EADDRINUSE';
    console.warn('[knowledge-http] server error:', err?.message);
    _knowledgeHttpServer = null;
    if (isAddrInUse) {
      if (!global._knowledgeHttpPortAlerted) {
        try { _getSendCeoAlert()('[RAG] Cổng 20129 đã bị chiếm bởi process khác (có thể đang mở 2 lần 9BizClaw). Tắt bớt instance để RAG hoạt động.'); } catch {}
        global._knowledgeHttpPortAlerted = true;
      }
    }
  });
}

function getKnowledgeHttpServer() {
  return _knowledgeHttpServer;
}

function cleanupKnowledgeServer() {
  if (_knowledgeHttpServer) {
    try { _knowledgeHttpServer.close(); } catch {}
    _knowledgeHttpServer = null;
  }
}

// ---------------------------------------------------------------------------
//  extractTextFromFile
// ---------------------------------------------------------------------------
async function extractTextFromFile(filepath, filename, options = {}) {
  const ext = path.extname(filename).toLowerCase();

  if (ext === '.txt' || ext === '.md' || ext === '.csv') {
    return fs.readFileSync(filepath, 'utf-8');
  }

  if (ext === '.pdf') {
    try {
      const pdfParse = require('pdf-parse');
      const buf = fs.readFileSync(filepath);
      const data = await pdfParse(buf);
      if (hasEnoughPdfText(data.text)) return data.text;
      return await describePdfScanForKnowledge(filepath, filename, options);
    } catch (e) {
      const msg = mediaLibrary.localizeMediaError ? mediaLibrary.localizeMediaError(e) : e.message;
      return `[PDF extract failed: ${msg}]`;
    }
  }

  if (ext === '.docx') {
    try {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ path: filepath });
      return result.value;
    } catch (e) { return `[DOCX extract failed: ${e.message}]`; }
  }

  if (ext === '.xlsx' || ext === '.xls') {
    try {
      const XLSX = require('xlsx');
      const wb = XLSX.readFile(filepath);
      let text = '';
      for (const name of wb.SheetNames) {
        const sheet = wb.Sheets[name];
        text += `\n=== Sheet: ${name} ===\n`;
        text += XLSX.utils.sheet_to_csv(sheet);
      }
      return text;
    } catch (e) { return `[Excel extract failed: ${e.message}]`; }
  }

  // Images: use AI vision
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) {
    const description = await describeImageForKnowledge(filepath, filename);
    return description;
  }

  return `[Không hỗ trợ extract text cho file ${ext}]`;
}

// ---------------------------------------------------------------------------
//  expandSearchQuery + rerankSearchResults
// ---------------------------------------------------------------------------
async function expandSearchQuery(query) {
  if (!query || query.length < 2) return query;
  try {
    const result = await call9Router(
      `Mở rộng truy vấn tìm kiếm sau thành 3-5 từ khóa đồng nghĩa tiếng Việt (và tiếng Anh nếu phù hợp). ` +
      `Chỉ trả về các từ khóa cách nhau bằng dấu phẩy, không giải thích.\n\nTruy vấn: "${query}"`,
      { maxTokens: 50, temperature: 0, timeoutMs: 2000 }
    );
    if (!result) return query;
    const terms = result.split(/[,\n]/)
      .map(t => t.trim().replace(/[\"*()^+\-]/g, '').replace(/\b(NEAR|AND|NOT)\b/gi, ''))
      .filter(t => t.length > 1);
    if (terms.length === 0) return query;
    const allTerms = [query, ...terms];
    return allTerms.map(t => `"${t.replace(/"/g, '')}"`).join(' OR ');
  } catch { return query; }
}

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
    for (let i = 0; i < results.length; i++) {
      if (!seen.has(i)) reordered.push(results[i]);
    }
    return reordered;
  } catch { return results; }
}

// ---------------------------------------------------------------------------
//  Initialize embedder (call once after app.whenReady)
// ---------------------------------------------------------------------------
function initEmbedder() {
  _ensureEmbedderInit();
}

// ---------------------------------------------------------------------------
//  Exports
// ---------------------------------------------------------------------------
module.exports = {
  // Documents dir
  getDocumentsDir,
  ensureDocumentsDir,

  // DB
  getDocumentsDb,
  autoFixBetterSqlite3,

  // Categories
  KNOWLEDGE_CATEGORIES,
  DEFAULT_KNOWLEDGE_CATEGORIES,
  KNOWLEDGE_LABELS,
  getKnowledgeCategories,
  getKnowledgeDir,

  // CRUD helpers
  insertDocumentRow,
  ensureKnowledgeFolders,
  backfillKnowledgeFromDisk,
  resolveUniqueFilename,
  describeImageForKnowledge,
  summarizeKnowledgeContent,
  sanitizeKnowledgeContentForIndex,
  rewriteKnowledgeIndex,
  listKnowledgeFilesFromDisk,

  // Search
  searchKnowledge,
  searchKnowledgeFTS5,
  getRagConfig,
  _TIER2_ALLOWED_MODELS,

  // HTTP server
  startKnowledgeSearchServer,
  getKnowledgeHttpServer,
  cleanupKnowledgeServer,
  KNOWLEDGE_HTTP_PORT,

  // Text extraction
  extractTextFromFile,
  expandSearchQuery,
  rerankSearchResults,

  // FTS helpers
  stripViDiacritics,
  normalizeForSearch,
  tokenizeForSearch,
  chunkVietnameseText,

  // Backfill
  backfillKnowledgeEmbeddings,
  backfillDocumentChunks,

  // Schema / indexing
  verifyEmbedderModelSha,
  ensureKnowledgeChunksSchema,
  indexDocumentChunks,

  // Synonyms
  loadSynonyms,
  expandSynonyms,
  rrfMerge,

  // Price
  parsePriceFilter,
  extractChunkPrice,

  // Tier 2
  rewriteQueryViaAI,

  // Embedder re-exports
  getEmbedder,
  embedText,
  cosineSim,
  vecToBlob,
  blobToVec,
  E5_DIM,
  getEmbedderState,

  // Embedder init
  initEmbedder,
};
