#!/usr/bin/env node
// electron/scripts/smoke-rag-fts5-only.js
// ----------------------------------------------------------------
// Baseline comparison smoke: runs the SAME 100-query fixture that
// smoke-rag-test.js uses, but with v2.3.46's FTS5 keyword + synonym
// + BM25 retrieval (no embeddings). Lets us quantify the v2.3.47
// semantic-search uplift vs. the shipped previous architecture.
//
// Pure JS BM25 implementation — matches v2.3.46's logic:
//   1. Normalize (strip diacritics, lowercase)
//   2. Tokenize (alnum), drop stopwords
//   3. Expand each token via synonyms-vi.json
//   4. BM25 score: sum of IDF * TF / (TF + k1*(1-b + b*dl/avgdl)) for each
//      expanded query term against each chunk
//   5. Top-3 retrieval
//
// Run: node electron/scripts/smoke-rag-fts5-only.js

const path = require('path');
const fs = require('fs');

// ---------- Inlined from main.js v2.3.46 ----------
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
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D');
}
function normalizeForSearch(text) {
  if (!text) return '';
  return stripViDiacritics(String(text)).toLowerCase().replace(/\s+/g, ' ').trim();
}
function tokenize(text) {
  return normalizeForSearch(text).split(/[^a-z0-9]+/).filter(t => t.length >= 2 && !VI_STOPWORDS.has(t));
}

let _synonyms = null;
function loadSynonyms() {
  if (_synonyms) return _synonyms;
  try {
    _synonyms = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'synonyms-vi.json'), 'utf-8'));
  } catch { _synonyms = {}; }
  return _synonyms;
}

// Expand query tokens via synonym dictionary (bigram-first).
// Returns deduped array of (query-side) terms to score against each doc.
function expandQuery(queryTokens) {
  const syn = loadSynonyms();
  const expanded = new Set();
  let i = 0;
  while (i < queryTokens.length) {
    let matchedKey = null;
    let consume = 1;
    if (i + 1 < queryTokens.length) {
      const bigram = queryTokens[i] + ' ' + queryTokens[i + 1];
      if (syn[bigram]) { matchedKey = bigram; consume = 2; }
    }
    if (!matchedKey && syn[queryTokens[i]]) matchedKey = queryTokens[i];

    if (matchedKey) {
      const variants = Array.isArray(syn[matchedKey]) ? syn[matchedKey] : [matchedKey];
      for (const v of variants) {
        for (const t of tokenize(v)) expanded.add(t);
      }
      // Also include the original (so original token still counts even if syn overrides)
      for (const t of matchedKey.split(' ')) {
        if (t && !VI_STOPWORDS.has(t)) expanded.add(t);
      }
    } else {
      expanded.add(queryTokens[i]);
    }
    i += consume;
  }
  return [...expanded];
}

// BM25 over the corpus
const BM25_K1 = 1.5;
const BM25_B = 0.75;

function buildBM25Index(chunks) {
  // tokens[] per doc, length[] per doc, avgdl, df per term
  const docs = chunks.map(c => tokenize(c.text));
  const lengths = docs.map(d => d.length);
  const avgdl = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const df = new Map();
  for (const d of docs) {
    const seen = new Set(d);
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = docs.length;
  // TF maps per doc for fast lookup
  const tfMaps = docs.map(d => {
    const m = new Map();
    for (const t of d) m.set(t, (m.get(t) || 0) + 1);
    return m;
  });
  return { docs, lengths, avgdl, df, N, tfMaps };
}

function bm25Score(idx, docIdx, term) {
  const tf = idx.tfMaps[docIdx].get(term) || 0;
  if (tf === 0) return 0;
  const df = idx.df.get(term) || 0;
  const idf = Math.log((idx.N - df + 0.5) / (df + 0.5) + 1);
  const dl = idx.lengths[docIdx];
  return idf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * dl / idx.avgdl));
}

function searchFTS5(idx, query) {
  const qtoks = tokenize(query);
  const terms = expandQuery(qtoks);
  if (terms.length === 0) return [];
  const scores = idx.docs.map((_, i) => {
    let s = 0;
    for (const t of terms) s += bm25Score(idx, i, t);
    return { idx: i, score: s };
  });
  return scores.filter(x => x.score > 0).sort((a, b) => b.score - a.score);
}

// ---------- Main ----------
async function main() {
  const fixturePath = path.join(__dirname, '..', 'test-fixtures', 'rag-canonical.json');
  const fx = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));

  console.log(`[smoke-fts5] v2.3.46 FTS5+BM25+synonym baseline — ${fx.chunks.length} chunks, ${fx.queries.length} queries`);
  const idx = buildBM25Index(fx.chunks);
  console.log(`[smoke-fts5] corpus avgdl=${idx.avgdl.toFixed(1)} tokens, N=${idx.N}`);

  let t1 = 0, t3 = 0, total = 0;
  const perCat = {};
  const fails = [];
  for (const q of fx.queries) {
    if (!Array.isArray(q.expected) || q.expected.length === 0) continue;
    total++;
    const cat = q.note || 'uncat';
    perCat[cat] ??= { t1: 0, t3: 0, total: 0 };
    perCat[cat].total++;
    const ranked = searchFTS5(idx, q.q);
    const top3 = ranked.slice(0, 3).map(x => fx.chunks[x.idx].id);
    if (q.expected.includes(top3[0])) { t1++; perCat[cat].t1++; }
    if (q.expected.some(id => top3.includes(id))) {
      t3++; perCat[cat].t3++;
    } else {
      fails.push(`[${cat}] "${q.q}" top3=[${top3.join(',')}] expected=[${q.expected.join(',')}]`);
    }
  }

  const t1pct = (t1 / total * 100).toFixed(1);
  const t3pct = (t3 / total * 100).toFixed(1);
  console.log('');
  console.log(`[smoke-fts5] Top-1: ${t1}/${total} = ${t1pct}%`);
  console.log(`[smoke-fts5] Top-3: ${t3}/${total} = ${t3pct}%`);
  console.log(`[smoke-fts5] per-category Top-3:`);
  for (const [cat, s] of Object.entries(perCat).sort()) {
    const pct = (s.t3 / s.total * 100).toFixed(0);
    const marker = s.t3 === s.total ? ' OK' : (s.t3 / s.total >= 0.7 ? '  ' : ' !!');
    console.log(`  ${marker} ${cat.padEnd(14)} Top-3 ${s.t3}/${s.total} = ${pct}%`);
  }
  if (fails.length > 0) {
    console.log(`\n[smoke-fts5] ${fails.length} Top-3 miss(es):`);
    for (const f of fails) console.log(`  ${f}`);
  }
}

main().catch((e) => { console.error('[smoke-fts5] error:', e); process.exit(1); });
