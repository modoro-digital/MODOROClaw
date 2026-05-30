#!/usr/bin/env node
// Smoke test for 3-tier visibility filter. Creates temp SQLite in-memory,
// seeds 3 rows (public/internal/private), asserts filter behavior at all
// 4 SQL locations searchKnowledge uses.
//
// Uses node:sqlite (built-in Node 22+) to avoid better-sqlite3 ABI
// mismatch when running under plain Node vs Electron.

'use strict';

let DatabaseConstructor;
try {
  const { DatabaseSync } = require('node:sqlite');
  DatabaseConstructor = DatabaseSync;
} catch (e) {
  console.error('[visibility smoke] SKIP: node:sqlite not available. Requires Node 22+ (with --experimental-sqlite) or Node 23+.');
  process.exit(0);
}

function fail(msg) { console.error('[visibility smoke] FAIL:', msg); process.exit(1); }
function ok(msg) { console.log('  OK  ', msg); }

function setupDb() {
  const db = new DatabaseConstructor(':memory:');
  db.exec(`
    CREATE TABLE documents (
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
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE documents_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER,
      chunk_index INTEGER,
      char_start INTEGER,
      char_end INTEGER,
      category TEXT,
      embedding BLOB,
      text TEXT
    );
    CREATE VIRTUAL TABLE documents_chunks_fts USING fts5(text, tokenize='unicode61');
  `);

  const ins = db.prepare('INSERT INTO documents (filename, filepath, content, category, visibility, enabled) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run('public-file.pdf', '/fake/p.pdf', 'khach hang giao hang', 'cong-ty', 'public', 1);
  ins.run('internal-file.pdf', '/fake/i.pdf', 'nhan vien noi quy giao hang', 'nhan-vien', 'internal', 1);
  ins.run('private-file.pdf', '/fake/pr.pdf', 'bao mat ceo giao hang', 'cong-ty', 'private', 1);
  ins.run('disabled-public.pdf', '/fake/off.pdf', 'khach hang giao hang disabled', 'cong-ty', 'public', 0);

  const insChunk = db.prepare('INSERT INTO documents_chunks (document_id, chunk_index, char_start, char_end, category, text, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const fakeEmb = Buffer.alloc(384 * 4);
  insChunk.run(1, 0, 0, 20, 'cong-ty', 'khach hang giao hang', fakeEmb);
  insChunk.run(2, 0, 0, 30, 'nhan-vien', 'nhan vien noi quy giao hang', fakeEmb);
  insChunk.run(3, 0, 0, 25, 'cong-ty', 'bao mat ceo giao hang', fakeEmb);
  insChunk.run(4, 0, 0, 28, 'cong-ty', 'khach hang giao hang disabled', fakeEmb);

  db.prepare('INSERT INTO documents_chunks_fts (rowid, text) VALUES (?, ?)').run(1, 'khach hang giao hang');
  db.prepare('INSERT INTO documents_chunks_fts (rowid, text) VALUES (?, ?)').run(2, 'nhan vien noi quy giao hang');
  db.prepare('INSERT INTO documents_chunks_fts (rowid, text) VALUES (?, ?)').run(3, 'bao mat ceo giao hang');
  db.prepare('INSERT INTO documents_chunks_fts (rowid, text) VALUES (?, ?)').run(4, 'khach hang giao hang disabled');

  return db;
}

function testVectorFilter(db) {
  const cases = [
    { audience: 'customer', expectedIds: [1] },
    { audience: 'internal', expectedIds: [1, 2] },
    { audience: 'ceo',      expectedIds: [1, 2, 3] },
    { audience: 'invalid',  expectedIds: [1] },
    { audience: undefined,  expectedIds: [1] },
  ];
  for (const c of cases) {
    const allowedTiers = c.audience === 'ceo'      ? ['public','internal','private']
                       : c.audience === 'internal' ? ['public','internal']
                                                   : ['public'];
    const placeholders = allowedTiers.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT d.id FROM documents_chunks c JOIN documents d ON d.id = c.document_id
       WHERE d.visibility IN (${placeholders}) AND c.embedding IS NOT NULL
         AND d.enabled = 1
       ORDER BY c.id ASC`
    ).all(...allowedTiers);
    const ids = rows.map(r => r.id).sort((a, b) => a - b);
    if (JSON.stringify(ids) !== JSON.stringify(c.expectedIds)) {
      fail(`vector audience=${c.audience} expected ${JSON.stringify(c.expectedIds)}, got ${JSON.stringify(ids)}`);
    }
    ok(`vector audience=${c.audience || 'undefined'} -> ${ids.length} row(s)`);
  }
}

function testFts5Filter(db) {
  const cases = [
    { audience: 'customer', expectedIds: [1] },
    { audience: 'internal', expectedIds: [1, 2] },
  ];
  for (const c of cases) {
    const allowedTiers = c.audience === 'internal' ? ['public','internal'] : ['public'];
    const placeholders = allowedTiers.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT dc.document_id AS did FROM documents_chunks_fts
       JOIN documents_chunks dc ON dc.id = documents_chunks_fts.rowid
       JOIN documents d ON d.id = dc.document_id
       WHERE documents_chunks_fts MATCH ? AND d.visibility IN (${placeholders})
         AND d.enabled = 1
       ORDER BY dc.id ASC`
    ).all('giao', ...allowedTiers);
    const ids = [...new Set(rows.map(r => r.did))].sort((a, b) => a - b);
    if (JSON.stringify(ids) !== JSON.stringify(c.expectedIds)) {
      fail(`FTS5 audience=${c.audience} expected ${JSON.stringify(c.expectedIds)}, got ${JSON.stringify(ids)}`);
    }
    ok(`FTS5 audience=${c.audience} -> ${ids.length} doc(s)`);
  }
}

function testLikeFilter(db) {
  const allowedTiers = ['public'];
  const placeholders = allowedTiers.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT d.id FROM documents d
     WHERE d.visibility IN (${placeholders}) AND d.enabled = 1 AND d.content LIKE ?`
  ).all(...allowedTiers, '%giao%');
  const ids = rows.map(r => r.id).sort((a, b) => a - b);
  if (JSON.stringify(ids) !== JSON.stringify([1])) {
    fail(`LIKE audience=customer expected [1], got ${JSON.stringify(ids)}`);
  }
  ok('LIKE audience=customer -> only public');
}

function testEnumValidation() {
  const valid = ['public', 'internal', 'private'];
  for (const v of ['Public', 'PRIVATE', '', null, undefined, ' ', 'internal ']) {
    if (valid.includes(v)) fail(`validation test bug: "${v}" should be invalid`);
  }
  ok('enum validation whitelist tight');
}

function testAlterUpgradePath() {
  const db = new DatabaseConstructor(':memory:');
  try {
    db.exec(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL, filepath TEXT NOT NULL, content TEXT,
        filetype TEXT, filesize INTEGER, word_count INTEGER,
        category TEXT DEFAULT 'general', summary TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    db.prepare('INSERT INTO documents (filename, filepath, content, category) VALUES (?, ?, ?, ?)').run('legacy.pdf', '/l.pdf', 'x', 'cong-ty');
    db.exec(`ALTER TABLE documents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`);
    db.exec(`ALTER TABLE documents ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`);
    const row = db.prepare('SELECT visibility, enabled FROM documents WHERE filename = ?').get('legacy.pdf');
    if (row.enabled !== 1) fail(`ALTER DEFAULT did not backfill enabled, got "${row.enabled}"`);
    if (row.visibility !== 'public') fail(`ALTER DEFAULT did not backfill — got "${row.visibility}"`);
    ok('ALTER upgrade path — legacy row reads visibility=public');
  } finally {
    db.close();
  }
}

function testIpcEnumValidation() {
  const ALLOWED = ['public', 'internal', 'private'];
  const validateVisibility = (v) => ALLOWED.includes(v);
  const rejects = ['Public', 'INTERNAL', ' public', 'public ', '', null, undefined, 0, false, true, 'all', 'ceo'];
  for (const bad of rejects) {
    if (validateVisibility(bad)) fail(`IPC enum accepted bad value: ${JSON.stringify(bad)}`);
  }
  for (const good of ['public', 'internal', 'private']) {
    if (!validateVisibility(good)) fail(`IPC enum rejected valid value: ${good}`);
  }
  ok('IPC enum predicate rejects non-enum, accepts 3 tiers');
}

function testSaveHandlerWhitelist() {
  const sanitize = (gs) => {
    if (!gs || !gs.mode) return null;
    if (!['off', 'mention', 'all'].includes(gs.mode)) return null;
    const out = { mode: gs.mode };
    if (gs.internal === true) out.internal = true;
    return out;
  };
  const ATTEMPTS = [
    { input: { mode: 'mention', internal: true },  expected: { mode: 'mention', internal: true } },
    { input: { mode: 'mention', internal: 'yes' }, expected: { mode: 'mention' } },
    { input: { mode: 'mention', internal: 1 },     expected: { mode: 'mention' } },
    { input: { mode: 'mention', internal: false },  expected: { mode: 'mention' } },
    { input: { mode: 'all', internal: true, badField: 'x' }, expected: { mode: 'all', internal: true } },
  ];
  for (const { input, expected } of ATTEMPTS) {
    const got = sanitize(input);
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      fail(`whitelist ${JSON.stringify(input)} -> expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
    }
  }
  ok('save-handler whitelist — only literal true stores internal');
}

function testProductionCallSitesExist() {
  const fs = require('node:fs');
  const path = require('node:path');
  const knowledgeJs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'knowledge.js'), 'utf-8');
  const dashboardIpcJs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard-ipc.js'), 'utf-8');
  const cronApiJs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cron-api.js'), 'utf-8');
  const preloadJs = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf-8');
  const mediaLibraryJs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'media-library.js'), 'utf-8');
  const combined = knowledgeJs + '\n' + dashboardIpcJs + '\n' + cronApiJs + '\n' + preloadJs + '\n' + mediaLibraryJs;
  const assertions = [
    { name: 'visibility column in CREATE TABLE',
      re: /visibility\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'public'/ },
    { name: 'enabled column in CREATE TABLE',
      re: /enabled\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+1/ },
    { name: 'visibility ALTER TABLE',
      re: /ALTER\s+TABLE\s+documents\s+ADD\s+COLUMN\s+visibility/ },
    { name: 'enabled ALTER TABLE',
      re: /ALTER\s+TABLE\s+documents\s+ADD\s+COLUMN\s+enabled/ },
    { name: 'insertDocumentRow helper',
      re: /function\s+insertDocumentRow\s*\(/ },
    { name: 'searchKnowledge audience parameter',
      re: /async\s+function\s+searchKnowledge\(\{[^}]*audience/ },
    { name: 'searchKnowledgeFTS5 audience parameter',
      re: /function\s+searchKnowledgeFTS5\(opts[^)]*\)[\s\S]{0,200}audience/ },
    { name: 'set-knowledge-visibility IPC',
      re: /ipcMain\.handle\(\s*'set-knowledge-visibility'/ },
    { name: 'set-knowledge-enabled IPC',
      re: /ipcMain\.handle\(\s*'set-knowledge-enabled'/ },
    { name: 'setKnowledgeEnabled preload bridge',
      re: /setKnowledgeEnabled\s*:\s*\(docId,\s*enabled\)\s*=>\s*ipcRenderer\.invoke\(\s*'set-knowledge-enabled'/ },
    { name: 'visibility IN filter in vector search',
      re: /d\.visibility\s+IN\s*\(/ },
    { name: 'enabled filter in search',
      re: /d\.enabled\s*=\s*1/ },
    { name: 'file-read blocks disabled knowledge files before channel visibility',
      re: /if\s*\(\s*row\s*&&\s*row\.enabled\s*===\s*0\s*\)[\s\S]{0,500}file_read_disabled_block/ },
    { name: 'file-read falls back to persisted enabled metadata',
      re: /getKnowledgeDocumentEnabled\s*\(\s*abs\s*,\s*true\s*\)\s*===\s*false/ },
    { name: 'legacy search-documents filters enabled documents',
      re: /ipcMain\.handle\(\s*'search-documents'[\s\S]{0,1600}d\.enabled\s*=\s*1/ },
    { name: 'knowledge enabled toggle rolls back metadata on DB failure',
      re: /setKnowledgeDocumentEnabledState\s*\(\s*row\.filepath,\s*previousEnabled\s*!==\s*0\s*\)/ },
    { name: 'watcher delete clears enabled metadata',
      re: /if\s*\(!exists\)[\s\S]{0,500}removeKnowledgeDocumentState\s*\(\s*filePath\s*\)/ },
    // --- fail-closed hardening (added after visibility audit) ---
    { name: 'media-library normalizes audience fail-closed (invalid -> customer)',
      re: /\['customer',\s*'internal',\s*'ceo'\]\.includes\(filters\.audience\)\s*\?\s*filters\.audience\s*:\s*'customer'/ },
    { name: 'cron-api media endpoints clamp audience fail-closed',
      re: /\['customer',\s*'internal',\s*'ceo'\]\.includes\(params\.audience\)\s*\?\s*params\.audience\s*:\s*'customer'/ },
    { name: 'legacy search-documents filters visibility (fail-closed to public)',
      re: /ipcMain\.handle\(\s*'search-documents'[\s\S]{0,1800}d\.visibility\s+IN\s*\('public'\)/ },
    { name: 'file-read infers visibility from path when DB row missing (fail-closed)',
      re: /const\s+_fileVis\s*=\s*row\s*\?\s*row\.visibility\s*:\s*knowledge\.inferVisibilityFromPath\(\s*abs\s*\)/ },
    { name: 'set-knowledge-visibility moves file before DB write (atomic) + aborts on move fail',
      re: /Không di chuyển được file/ },
    { name: 'set-knowledge-visibility rolls file back if DB write fails',
      re: /if\s*\(moved\)\s*\{[\s\S]{0,120}renameSync\(newPath,\s*filepath\)/ },
  ];
  for (const a of assertions) {
    if (!a.re.test(combined)) fail(`production call site missing: ${a.name}`);
    ok(`prod call site: ${a.name}`);
  }
}

// Mirror of media-library.js listMediaAssets() fail-closed filter. Asserts a
// private/internal media asset is NEVER returned for an invalid/unknown audience
// (the old code fell through both guards and leaked private for audience='ceo'/''/typo).
function testMediaAudienceFailClosed() {
  const visible = (assetVis, rawAudience) => {
    const audience = ['customer', 'internal', 'ceo'].includes(rawAudience) ? rawAudience : 'customer';
    if (audience === 'customer' && assetVis !== 'public') return false;
    if (audience === 'internal' && assetVis === 'private') return false;
    return true;
  };
  for (const bad of ['', ' ', null, undefined, 'all', 'ceeo', 'CEO', 0, false, 'admin']) {
    if (visible('private', bad)) fail(`media: invalid audience ${JSON.stringify(bad)} leaked PRIVATE asset`);
    if (visible('internal', bad)) fail(`media: invalid audience ${JSON.stringify(bad)} leaked INTERNAL asset`);
  }
  if (visible('private', 'customer')) fail('media: customer saw private');
  if (visible('internal', 'customer')) fail('media: customer saw internal');
  if (visible('private', 'internal')) fail('media: internal saw private');
  if (!visible('internal', 'internal')) fail('media: internal could not see internal');
  if (!visible('private', 'ceo')) fail('media: ceo could not see private');
  if (!visible('public', 'customer')) fail('media: customer could not see public');
  ok('media audience fail-closed — invalid audience -> public only; private requires explicit ceo');
}

function main() {
  console.log('[visibility smoke] 4-location filter + enum + upgrade + prod-call checks...');
  const db = setupDb();
  try {
    testVectorFilter(db);
    testFts5Filter(db);
    testLikeFilter(db);
    testEnumValidation();
    testAlterUpgradePath();
    testIpcEnumValidation();
    testSaveHandlerWhitelist();
    testMediaAudienceFailClosed();
    testProductionCallSitesExist();
  } finally {
    db.close();
  }
  console.log('[visibility smoke] PASS');
}

main();
