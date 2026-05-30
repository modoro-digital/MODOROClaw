#!/usr/bin/env node
// Measure 4 architectures on the 1000-query fixture:
//   A. FTS5+BM25+synonym (v2.3.46)
//   B. Semantic pure (v2.3.47 current)
//   C. Hybrid RRF (FTS5 + Semantic merged via Reciprocal Rank Fusion)
//   D. Hybrid RRF + price pre-filter (regex-extract price range → SQL-style WHERE)
//
// LLM rerank (Level 3) simulated via an oracle — if expected chunks are in
// top-10 candidates, we count as retrieved. This upper-bounds what LLM
// rerank can do. In production, LLM hits 85-95% of the oracle bound.

const path = require('path');
const fs = require('fs');

const embedder = require('../lib/embedder');
embedder.setModelsRoot(path.join(__dirname, '..', 'vendor'));
embedder.setCacheRoot(path.join(__dirname, '..', '..', 'tmp-cache'));
const { embedText, cosineSim } = embedder;

// ---------- FTS5/BM25 (inline) ----------
const VI_STOPWORDS = new Set([
  'ở','la','voi','cua','cho','nay','kia','va','hoac','thi','ma','nen',
  'vay','roi','dang','se','da','co','cac','nhung','mot','trong','ngoai',
  'tren','duoi','khi','neu','tai','ve','theo','boi','vi','do','qua',
  'den','tu','vao','ra','len','xuong','di','toi','bang','cung','con',
  'do','day','kia','ay','nao','sao','dau','gi','ai','may','bao',
  'u','a','o','oi','nhe','nha','nhi','chu','ha','ho',
  'de','moi','chi','rat','hon','nhat','that',
]);
const stripVi = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
const normalize = s => stripVi(String(s || '')).toLowerCase().replace(/\s+/g, ' ').trim();
const tokens = s => normalize(s).split(/[^a-z0-9]+/).filter(t => t.length >= 2 && !VI_STOPWORDS.has(t));

let _synonyms = null;
function loadSynonyms() {
  if (_synonyms) return _synonyms;
  try { _synonyms = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'synonyms-vi.json'), 'utf-8')); }
  catch { _synonyms = {}; }
  return _synonyms;
}
function expandQuery(qTokens) {
  const syn = loadSynonyms();
  const out = new Set();
  let i = 0;
  while (i < qTokens.length) {
    let key = null, consume = 1;
    if (i + 1 < qTokens.length && syn[qTokens[i] + ' ' + qTokens[i + 1]]) {
      key = qTokens[i] + ' ' + qTokens[i + 1]; consume = 2;
    }
    if (!key && syn[qTokens[i]]) key = qTokens[i];
    if (key) {
      for (const v of (syn[key] || [key])) for (const t of tokens(v)) out.add(t);
      for (const t of key.split(' ')) if (t && !VI_STOPWORDS.has(t)) out.add(t);
    } else out.add(qTokens[i]);
    i += consume;
  }
  return [...out];
}

const K1 = 1.5, B = 0.75;
function buildBM25(corpusChunks) {
  const docs = corpusChunks.map(c => tokens(c.text));
  const lengths = docs.map(d => d.length);
  const avgdl = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const df = new Map();
  for (const d of docs) { const seen = new Set(d); for (const t of seen) df.set(t, (df.get(t) || 0) + 1); }
  const tfMaps = docs.map(d => {
    const m = new Map();
    for (const t of d) m.set(t, (m.get(t) || 0) + 1);
    return m;
  });
  return { docs, lengths, avgdl, df, tfMaps, N: docs.length };
}
function bm25Score(idx, di, term) {
  const tf = idx.tfMaps[di].get(term) || 0;
  if (!tf) return 0;
  const df = idx.df.get(term) || 0;
  const idf = Math.log((idx.N - df + 0.5) / (df + 0.5) + 1);
  return idf * tf * (K1 + 1) / (tf + K1 * (1 - B + B * idx.lengths[di] / idx.avgdl));
}
function searchFTS5(idx, q, topK = 10) {
  const terms = expandQuery(tokens(q));
  if (!terms.length) return [];
  return idx.docs.map((_, i) => ({ i, s: terms.reduce((a, t) => a + bm25Score(idx, i, t), 0) }))
    .filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, topK);
}

// ---------- Reciprocal Rank Fusion ----------
// Industry standard: score = Σ 1/(k + rank_in_list). k=60 canonical.
// Merges rankings from different retrievers without needing to normalize scores.
function rrfMerge(lists, k = 60, topK = 10) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((item, rank) => {
      const id = item.id;
      scores.set(id, (scores.get(id) || 0) + 1 / (k + rank + 1));
    });
  }
  return [...scores.entries()].map(([id, s]) => ({ id, s })).sort((a, b) => b.s - a.s).slice(0, topK);
}

// ---------- Price filter parse (synced with production v2.3.47.1 round-2) ----------
function parsePriceFilter(query) {
  const q = normalize(query);
  const toVnd = (num, unit) => {
    const n = parseFloat(String(num).replace(/,/g, '.'));
    if (!Number.isFinite(n) || n < 0) return null;
    if (unit === 'ty') return n * 1_000_000_000;
    if (unit === 'trieu' || unit === 'tr') return n * 1_000_000;
    if (unit === 'k' || unit === 'nghin' || unit === 'ngan') return n * 1_000;
    return null;  // no unit — don't guess
  };
  const under = q.match(/(?:duoi|<|<=|toi da|it hon)\s*(\d+(?:[.,]\d+)?)\s*(ty|trieu|tr|k|nghin|ngan)?\b/);
  const over = q.match(/(?:tren|>|>=|toi thieu|nhieu hon|hon)\s*(\d+(?:[.,]\d+)?)\s*(ty|trieu|tr|k|nghin|ngan)?\b/);
  const result = {};
  if (under) { const v = toVnd(under[1], under[2]); if (v != null) result.max = v; }
  if (over) { const v = toVnd(over[1], over[2]); if (v != null) result.min = v; }
  return (result.min != null || result.max != null) ? result : null;
}

function chunkPrice(text) {
  const m = String(text || '').match(/([\d.]+)\s*(?:VND|VNĐ|đồng|đ)\b/i);
  if (!m) return null;
  const raw = m[1].replace(/\./g, '');
  if (raw.length < 4) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

// ---------- Arch runners ----------
function scoreSemantic(fx, qvec) {
  return fx.chunks.map(c => ({ id: c.id, s: cosineSim(qvec, c.vec) }))
    .sort((a, b) => b.s - a.s).slice(0, 10);
}

async function main() {
  const fixturePath = path.join(__dirname, '..', 'test-fixtures', 'rag-canonical-1000.json');
  const fx = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
  console.log(`[compare-4] ${fx.chunks.length} chunks / ${fx.queries.length} queries`);

  // Warm + embed corpus
  await embedText('warmup', false);
  console.log('[compare-4] embedding corpus...');
  for (const c of fx.chunks) c.vec = await embedText(c.text, false);
  // Pre-compute chunk prices
  for (const c of fx.chunks) c.price = chunkPrice(c.text);

  const ftsIdx = buildBM25(fx.chunks);

  // Stats
  const archs = ['A_fts5', 'B_sem', 'C_hybrid', 'D_hybrid_price', 'Oracle_top10'];
  const stats = {};
  const catStats = {};
  for (const a of archs) {
    stats[a] = { t1: 0, t3: 0, tot: 0 };
    catStats[a] = {};
  }

  for (const q of fx.queries) {
    if (!q.expected || q.expected.length === 0) continue;
    const cat = q.note;

    // Embed once
    const qv = await embedText(q.q, true);

    // A: FTS5 only
    const fts = searchFTS5(ftsIdx, q.q, 10).map(x => ({ id: fx.chunks[x.i].id, s: x.s }));
    // B: Semantic only
    const sem = scoreSemantic(fx, qv);
    // C: Hybrid RRF
    const hyb = rrfMerge([fts, sem], 60, 10);
    // D: Hybrid + price filter pre-applied
    const priceFilter = parsePriceFilter(q.q);
    let hybPrice;
    if (priceFilter) {
      const eligible = fx.chunks.filter(c => {
        if (!c.price) return false;
        if (priceFilter.min && c.price < priceFilter.min) return false;
        if (priceFilter.max && c.price > priceFilter.max) return false;
        return true;
      });
      if (eligible.length > 0) {
        const fts2 = searchFTS5({ ...ftsIdx, docs: eligible.map(c => tokens(c.text)), lengths: eligible.map(c => tokens(c.text).length), tfMaps: eligible.map(c => { const m = new Map(); for (const t of tokens(c.text)) m.set(t, (m.get(t) || 0) + 1); return m; }), N: eligible.length, avgdl: ftsIdx.avgdl }, q.q, 10)
          .map(x => ({ id: eligible[x.i].id, s: x.s }));
        const sem2 = eligible.map(c => ({ id: c.id, s: cosineSim(qv, c.vec) })).sort((a, b) => b.s - a.s).slice(0, 10);
        hybPrice = rrfMerge([fts2, sem2], 60, 10);
      } else {
        hybPrice = hyb;  // filter left no candidates, fall through
      }
    } else {
      hybPrice = hyb;
    }

    // Oracle upper bound: if any expected is in union of top-10 candidates
    // from hybrid, an LLM reranker COULD pick it correctly.
    const candPool = new Set([...hyb.slice(0, 10).map(x => x.id), ...hybPrice.slice(0, 10).map(x => x.id)]);

    function record(key, rankedIds) {
      const top3 = rankedIds.slice(0, 3);
      stats[key].tot++;
      catStats[key][cat] ??= { t1: 0, t3: 0, tot: 0 };
      catStats[key][cat].tot++;
      if (q.expected.includes(top3[0])) { stats[key].t1++; catStats[key][cat].t1++; }
      if (q.expected.some(id => top3.includes(id))) { stats[key].t3++; catStats[key][cat].t3++; }
    }
    record('A_fts5', fts.map(x => x.id));
    record('B_sem', sem.map(x => x.id));
    record('C_hybrid', hyb.map(x => x.id));
    record('D_hybrid_price', hybPrice.map(x => x.id));
    // Oracle: pretend LLM always picks correctly if expected is in candidate pool
    const oracleIds = [...candPool];
    stats.Oracle_top10.tot++;
    catStats.Oracle_top10[cat] ??= { t1: 0, t3: 0, tot: 0 };
    catStats.Oracle_top10[cat].tot++;
    const oraclePicks = q.expected.filter(id => candPool.has(id)).slice(0, 3);
    if (oraclePicks.length > 0) { stats.Oracle_top10.t1++; catStats.Oracle_top10[cat].t1++; stats.Oracle_top10.t3++; catStats.Oracle_top10[cat].t3++; }
  }

  // ---------- Report ----------
  function pct(n, d) { return d ? (n / d * 100).toFixed(1) : '—'; }
  console.log('\n=== OVERALL — TOP-3 ACCURACY ===');
  console.log('arch                          Top-1   Top-3');
  for (const a of archs) {
    const label = {
      A_fts5: 'A  v2.3.46 FTS5 baseline       ',
      B_sem:  'B  v2.3.47 semantic pure       ',
      C_hybrid: 'C  Hybrid RRF (FTS5 + sem)   ',
      D_hybrid_price: 'D  Hybrid + price filter   ',
      Oracle_top10: 'Oracle  (LLM rerank ceiling) ',
    }[a];
    console.log(`  ${label} ${pct(stats[a].t1, stats[a].tot).padStart(5)}%  ${pct(stats[a].t3, stats[a].tot).padStart(5)}%`);
  }

  console.log('\n=== PER CATEGORY — TOP-3 (C vs D vs Oracle) ===');
  const cats = [...new Set([...Object.keys(catStats.C_hybrid)])].sort();
  console.log('category         A-FTS5   B-Sem    C-Hybrid   D-Hyb+Price   Oracle');
  for (const c of cats) {
    const row = archs.map(a => {
      const s = catStats[a][c];
      return s ? pct(s.t3, s.tot) + '%' : '—';
    });
    console.log(`  ${c.padEnd(14)} ${row[0].padStart(6)}  ${row[1].padStart(6)}  ${row[2].padStart(6)}    ${row[3].padStart(6)}       ${row[4].padStart(6)}`);
  }
  console.log(`\n  n=${stats.A_fts5.tot}   (OOD excluded)`);
}

main().catch(e => { console.error('[compare-4] error:', e); process.exit(1); });
