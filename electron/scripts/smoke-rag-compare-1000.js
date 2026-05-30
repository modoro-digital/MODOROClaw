#!/usr/bin/env node
// Run BOTH v2.3.46 (FTS5+BM25+synonym) AND v2.3.47 (E5 semantic) against
// the 1000-query × 200-chunk multi-industry fixture and report uplift
// per industry × per category.
//
// Outputs a side-by-side table so we can decide whether v2.3.47 RAG is
// actually worth the 90MB + complexity across diverse industries.

const path = require('path');
const fs = require('fs');

const embedder = require('../lib/embedder');
embedder.setModelsRoot(path.join(__dirname, '..', 'vendor'));
embedder.setCacheRoot(path.join(__dirname, '..', '..', 'tmp-cache'));
const { embedText, cosineSim } = embedder;

// ---------- FTS5 / BM25 baseline (inlined from smoke-rag-fts5-only.js) ----------
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
function searchFTS5(idx, q) {
  const terms = expandQuery(tokens(q));
  if (!terms.length) return [];
  return idx.docs.map((_, i) => ({ i, s: terms.reduce((a, t) => a + bm25Score(idx, i, t), 0) }))
    .filter(x => x.s > 0).sort((a, b) => b.s - a.s);
}

// ---------- main ----------
async function main() {
  const fixturePath = path.join(__dirname, '..', 'test-fixtures', 'rag-canonical-1000.json');
  const fx = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
  console.log(`[compare-1000] ${fx.chunks.length} chunks / ${fx.queries.length} queries`);

  // Warm up + embed corpus
  console.log('[compare-1000] loading embedder + embedding corpus...');
  await embedText('warmup', false);
  for (const c of fx.chunks) c.vec = await embedText(c.text, false);

  // Build FTS5 index once
  const ftsIdx = buildBM25(fx.chunks);

  // Score both per query
  const categoryStats = {};  // category → { fts: {t1,t3,tot}, sem: {t1,t3,tot} }
  const industryStats = {};

  for (const q of fx.queries) {
    if (!q.expected || q.expected.length === 0) continue;  // skip OOD
    const cat = q.note;
    const expectedIndustry = fx.chunks.find(c => c.id === q.expected[0])?.industry || 'unknown';
    categoryStats[cat] ??= { fts: { t1: 0, t3: 0, tot: 0 }, sem: { t1: 0, t3: 0, tot: 0 } };
    industryStats[expectedIndustry] ??= { fts: { t1: 0, t3: 0, tot: 0 }, sem: { t1: 0, t3: 0, tot: 0 } };

    // Semantic
    const qv = await embedText(q.q, true);
    const semRanked = fx.chunks.map(c => ({ id: c.id, s: cosineSim(qv, c.vec) })).sort((a, b) => b.s - a.s);
    const semTop3 = semRanked.slice(0, 3).map(x => x.id);

    // FTS5
    const ftsRanked = searchFTS5(ftsIdx, q.q);
    const ftsTop3 = ftsRanked.slice(0, 3).map(x => fx.chunks[x.i].id);

    for (const [key, top3] of [['sem', semTop3], ['fts', ftsTop3]]) {
      categoryStats[cat][key].tot++;
      industryStats[expectedIndustry][key].tot++;
      if (q.expected.includes(top3[0])) { categoryStats[cat][key].t1++; industryStats[expectedIndustry][key].t1++; }
      if (q.expected.some(id => top3.includes(id))) { categoryStats[cat][key].t3++; industryStats[expectedIndustry][key].t3++; }
    }
  }

  // ---------- report ----------
  function pct(num, den) { return den ? (num / den * 100).toFixed(1) : '—'; }
  function delta(a, b) { return ((a - b) / 100 * 100).toFixed(1); }  // raw %-point diff
  function deltaPP(a, b) { const d = a - b; const sign = d >= 0 ? '+' : ''; return `${sign}${d.toFixed(1)}`; }

  console.log('\n=== PER CATEGORY — TOP-3 ACCURACY ===');
  console.log('category         FTS5(v2.3.46)   Sem(v2.3.47)    Δ (pp)');
  const cats = Object.keys(categoryStats).sort();
  let totFtsT3 = 0, totSemT3 = 0, totSamples = 0;
  let totFtsT1 = 0, totSemT1 = 0;
  for (const c of cats) {
    const s = categoryStats[c];
    const ftsPct = s.fts.t3 / s.fts.tot * 100;
    const semPct = s.sem.t3 / s.sem.tot * 100;
    const pad = c.padEnd(16);
    console.log(`  ${pad} ${pct(s.fts.t3, s.fts.tot).padStart(5)}%         ${pct(s.sem.t3, s.sem.tot).padStart(5)}%         ${deltaPP(semPct, ftsPct).padStart(6)}`);
    totFtsT3 += s.fts.t3; totSemT3 += s.sem.t3; totSamples += s.fts.tot;
    totFtsT1 += s.fts.t1; totSemT1 += s.sem.t1;
  }

  console.log('\n=== PER INDUSTRY — TOP-3 ACCURACY ===');
  console.log('industry         FTS5(v2.3.46)   Sem(v2.3.47)    Δ (pp)');
  const inds = Object.keys(industryStats).sort();
  for (const i of inds) {
    const s = industryStats[i];
    const ftsPct = s.fts.t3 / s.fts.tot * 100;
    const semPct = s.sem.t3 / s.sem.tot * 100;
    const pad = i.padEnd(16);
    console.log(`  ${pad} ${pct(s.fts.t3, s.fts.tot).padStart(5)}%         ${pct(s.sem.t3, s.sem.tot).padStart(5)}%         ${deltaPP(semPct, ftsPct).padStart(6)}`);
  }

  console.log('\n=== OVERALL ===');
  console.log(`  Top-1:  FTS5 ${pct(totFtsT1, totSamples)}%   Sem ${pct(totSemT1, totSamples)}%   Δ ${deltaPP(totSemT1 / totSamples * 100, totFtsT1 / totSamples * 100)} pp`);
  console.log(`  Top-3:  FTS5 ${pct(totFtsT3, totSamples)}%   Sem ${pct(totSemT3, totSamples)}%   Δ ${deltaPP(totSemT3 / totSamples * 100, totFtsT3 / totSamples * 100)} pp`);
  console.log(`  n=${totSamples} (excluding ${fx.queries.length - totSamples} OOD)`);
}

main().catch(e => { console.error('[compare-1000] error:', e); process.exit(1); });
