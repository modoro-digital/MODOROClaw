const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'memory.db');
const ROOT = path.resolve(__dirname, '..', '..');

function scanDir(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      scanDir(full, files);
    } else if (entry.name.endsWith('.md')) {
      files.push(full);
    }
  }
  return files;
}

function rebuildDatabase() {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

  const db = new Database(DB_PATH);
  db.exec(`CREATE VIRTUAL TABLE memories USING fts5(path, content, tokenize='porter')`);

  const insert = db.prepare('INSERT INTO memories (path, content) VALUES (?, ?)');
  let count = 0;

  const bulkInsert = db.transaction(() => {
    // Scan: memory/, skills/, industry/, top-level .md files
    const dirs = ['memory', 'skills', 'industry'].map(d => path.join(ROOT, d));
    for (const dir of dirs) {
      for (const file of scanDir(dir)) {
        try {
          const content = fs.readFileSync(file, 'utf-8');
          const rel = path.relative(ROOT, file).replace(/\\/g, '/');
          insert.run(rel, content);
          count++;
        } catch (e) { console.warn(`Skip ${file}: ${e.message}`); }
      }
    }

    // Top-level md files
    for (const f of ['MEMORY.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md', 'SOUL.md']) {
      const full = path.join(ROOT, f);
      if (fs.existsSync(full)) {
        insert.run(f, fs.readFileSync(full, 'utf-8'));
        count++;
      }
    }
  });

  bulkInsert();
  db.close();
  console.log(`Memory DB rebuilt: ${count} files indexed.`);
}

if (require.main === module) {
  rebuildDatabase();
}

module.exports = { rebuildDatabase };
