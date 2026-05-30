const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'memory.db');

function searchMemory(query, limit = 5) {
  if (!fs.existsSync(DB_PATH)) return []; // DB not built yet

  const db = new Database(DB_PATH, { readonly: true });

  let results;
  try {
    const stmt = db.prepare(`
      SELECT path, snippet(memories, 1, '', '', '...', 32) as snippet, rank
      FROM memories
      WHERE memories MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    results = stmt.all(query, limit);
  } catch {
    // Fallback: wrap query in quotes for literal matching (handles FTS5 syntax errors)
    try {
      const safeQuery = `"${query.replace(/"/g, '""')}"`;
      const stmt = db.prepare(`
        SELECT path, snippet(memories, 1, '', '', '...', 32) as snippet, rank
        FROM memories
        WHERE memories MATCH ?
        ORDER BY rank
        LIMIT ?
      `);
      results = stmt.all(safeQuery, limit);
    } catch {
      results = [];
    }
  }

  db.close();

  return results.map(r => ({
    path: r.path,
    snippet: r.snippet || '',
    relevance: r.rank,
  }));
}

// CLI usage
if (require.main === module) {
  const query = process.argv[2];
  if (!query) {
    console.log('Usage: node relevant-memory.js "<query>"');
    process.exit(1);
  }

  const results = searchMemory(query);
  console.log(`Found ${results.length} relevant memories:\n`);
  results.forEach((r, i) => {
    console.log(`${i + 1}. ${r.path}`);
    console.log(`   ${r.snippet}`);
    console.log();
  });
}

module.exports = { searchMemory };
