const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'memory.db');
const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Atomic memory write: appends to file + updates SQLite index incrementally.
 * @param {string} filePath - Relative path from project root (e.g. "memory/2026-04-06.md")
 * @param {string} content - Content to write/append
 * @param {boolean} append - If true, append to existing file. If false, overwrite.
 */
function memoryWrite(filePath, content, append = true) {
  const fullPath = path.resolve(ROOT, filePath);

  // Path traversal guard
  if (!fullPath.startsWith(ROOT)) {
    throw new Error(`Path traversal blocked: ${filePath} resolves outside project root`);
  }

  // Write to file
  if (append && fs.existsSync(fullPath)) {
    fs.appendFileSync(fullPath, '\n' + content, 'utf-8');
  } else {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
  }

  // Update DB incrementally (if DB exists)
  if (!fs.existsSync(DB_PATH)) return;
  try {
    const db = new Database(DB_PATH);
    const rel = path.relative(ROOT, fullPath).replace(/\\/g, '/');
    const fullContent = fs.readFileSync(fullPath, 'utf-8');

    // Transactional upsert
    const upsert = db.transaction(() => {
      db.prepare('DELETE FROM memories WHERE path = ?').run(rel);
      db.prepare('INSERT INTO memories (path, content) VALUES (?, ?)').run(rel, fullContent);
    });
    upsert();
    db.close();
  } catch (err) {
    console.error(`Warning: DB update failed for ${filePath}:`, err.message);
  }
}

// CLI: node memory-write.js "memory/2026-04-06.md" "content to append"
if (require.main === module) {
  const [,, filePath, content] = process.argv;
  if (!filePath || !content) {
    console.log('Usage: node memory-write.js "<path>" "<content>"');
    process.exit(1);
  }
  memoryWrite(filePath, content);
  console.log(`Written to ${filePath}`);
}

module.exports = { memoryWrite };
