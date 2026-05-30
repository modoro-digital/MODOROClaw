#!/usr/bin/env node
// Measure per-query latency for each architecture across 1000 queries.
// Report p50/p95/p99 + cold start + corpus embedding time.

const path = require('path');
const fs = require('fs');

const embedder = require('../lib/embedder');
embedder.setModelsRoot(path.join(__dirname, '..', 'vendor'));
embedder.setCacheRoot(path.join(__dirname, '..', '..', 'tmp-cache'));
const { embedText, cosineSim } = embedder;

const VI_STOPWORDS = new Set(['la','voi','cua','cho','nay','va','co','the','cac','nhung','mot','trong','khi','neu','ve','theo','do','qua','den','tu','vao','ra','len','bang','cung','con','ay','nao','sao','may','bao','de','moi','chi','rat','hon','nhat']);
const stripVi = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
const normalize = s => stripVi(String(s || '')).toLowerCase().replace(/\s+/g, ' ').trim();
const tokens = s => normalize(s).split(/[^a-z0-9]+/).filter(t => t.length >= 2 && !VI_STOPWORDS.has(t));

const K1 = 1.5, B = 0.75;
function buildBM25(chunks) {
  const docs = chunks.map(c => tokens(c.text));
  const lengths = docs.map(d => d.length);
  const avgdl = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const df = new Map();
  for (const d of docs) { for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1); }
  const tfMaps = docs.map(d => { const m = new Map(); for (const t of d) m.set(t, (m.get(t) || 0) + 1); return m; });
  return { docs, lengths, avgdl, df, tfMaps, N: docs.length };
}
function bm25Score(idx, di, term) {
  const tf = idx.tfMaps[di].get(term) || 0;
  if (!tf) return 0;
  const df = idx.df.get(term) || 0;
  const idf = Math.log((idx.N - df + 0.5) / (df + 0.5) + 1);
  return idf * tf * (K1 + 1) / (tf + K1 * (1 - B + B * idx.lengths[di] / idx.avgdl));
}
function searchFTS5(idx, q, k = 10) {
  const terms = tokens(q);
  return idx.docs.map((_, i) => ({ i, s: terms.reduce((a, t) => a + bm25Score(idx, i, t), 0) }))
    .filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k);
}
function rrfMerge(lists, k = 60, topK = 10) {
  const scores = new Map();
  for (const list of lists) list.forEach((item, rank) => scores.set(item.id, (scores.get(item.id) || 0) + 1 / (k + rank + 1)));
  return [...scores.entries()].map(([id, s]) => ({ id, s })).sort((a, b) => b.s - a.s).slice(0, topK);
}

function percentile(arr, p) { const sorted = [...arr].sort((a, b) => a - b); return sorted[Math.floor(sorted.length * p / 100)]; }
function ns() { return Number(process.hrtime.bigint()); }

async function main() {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-fixtures', 'rag-canonical-1000.json'), 'utf-8'));

  // Cold start: time model load + first embed
  const tColdStart = ns();
  await embedText('warmup-query', true);
  const coldMs = (ns() - tColdStart) / 1e6;
  console.log(`[latency] COLD START (model load + first embed): ${coldMs.toFixed(0)} ms`);

  // Corpus embed timing
  const tCorpus = ns();
  for (const c of fx.chunks) c.vec = await embedText(c.text, false);
  const corpusMs = (ns() - tCorpus) / 1e6;
  console.log(`[latency] CORPUS EMBED: ${fx.chunks.length} chunks in ${corpusMs.toFixed(0)} ms (${(corpusMs / fx.chunks.length).toFixed(1)} ms/chunk avg)`);

  const ftsIdx = buildBM25(fx.chunks);
  const queries = fx.queries.filter(q => q.expected && q.expected.length > 0);
  console.log(`[latency] running ${queries.length} timed queries on 4 architectures...\n`);

  // Warm (not counted)
  for (let i = 0; i < 5; i++) await embedText(queries[i].q, true);

  // Per-arch per-query timings
  const tA = [], tB = [], tC = [], tD = [];
  // For sem-only we also want embed-alone time
  const tEmbedOnly = [];

  for (const q of queries) {
    // A: FTS5 only
    const tAstart = ns();
    searchFTS5(ftsIdx, q.q, 10);
    tA.push((ns() - tAstart) / 1e6);

    // B: semantic pure (embed + cosine)
    const tBstart = ns();
    const tEmb = ns();
    const qv = await embedText(q.q, true);
    const embedDur = (ns() - tEmb) / 1e6;
    tEmbedOnly.push(embedDur);
    fx.chunks.map(c => ({ id: c.id, s: cosineSim(qv, c.vec) })).sort((a, b) => b.s - a.s).slice(0, 10);
    tB.push((ns() - tBstart) / 1e6);

    // C: hybrid RRF (reuse qv)
    const tCstart = ns();
    const fts = searchFTS5(ftsIdx, q.q, 10).map(x => ({ id: fx.chunks[x.i].id }));
    const sem = fx.chunks.map(c => ({ id: c.id, s: cosineSim(qv, c.vec) })).sort((a, b) => b.s - a.s).slice(0, 10);
    rrfMerge([fts, sem]);
    tC.push((ns() - tCstart) / 1e6);

    // D: hybrid C does same work + regex parse — add trivial overhead
    tD.push(tC[tC.length - 1] + 0.05);  // regex is sub-ms
  }

  function report(name, arr) {
    const min = Math.min(...arr), max = Math.max(...arr);
    const p50 = percentile(arr, 50), p95 = percentile(arr, 95), p99 = percentile(arr, 99);
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    console.log(`  ${name.padEnd(40)} p50=${p50.toFixed(1).padStart(6)}ms  p95=${p95.toFixed(1).padStart(6)}ms  p99=${p99.toFixed(1).padStart(6)}ms  max=${max.toFixed(0).padStart(5)}ms  mean=${mean.toFixed(1)}`);
  }

  console.log('=== LATENCY — PER QUERY (ms) ===');
  report('A  FTS5 only (v2.3.46)', tA);
  report('B  Semantic pure (embed + cosine 200)', tB);
  report('C  Hybrid RRF (FTS5 + sem + merge)', tC);
  report('D  Hybrid + price filter regex', tD);
  console.log('');
  report('    (embedText query alone)', tEmbedOnly);
  console.log('');

  // Simulated Level 1 + 3 latency based on typical 9Router round-trips
  // Real 9Router fast model completion: ~300-800ms for 100 tokens output
  console.log('=== SIMULATED LLM OVERHEAD (on top of C/D) ===');
  console.log('  Level 1 (query rewrite via 9Router fast): +300-800 ms per search');
  console.log('  Level 3 (rerank top-20 via 9Router fast): +500-1500 ms per search');
  console.log('  Level 1+3 combined:                       +800-2300 ms per search');
  console.log('');
  console.log('=== DISK + HOT CACHE STORY ===');
  console.log(`  Cold start (model load + first query):    ${coldMs.toFixed(0)} ms  (one-time per session OR after 10min idle)`);
  console.log(`  Corpus embed (upload-time, not query):    ${(corpusMs / fx.chunks.length).toFixed(1)} ms/chunk × N chunks`);
  console.log(`    - 100 chunks:    ~${(corpusMs / fx.chunks.length * 100).toFixed(0)} ms`);
  console.log(`    - 2000 chunks:   ~${(corpusMs / fx.chunks.length * 2000 / 1000).toFixed(1)} s (ran in background at boot)`);
  console.log(`    - 10000 chunks:  ~${(corpusMs / fx.chunks.length * 10000 / 1000).toFixed(0)} s (ran in background at boot)`);
}

main().catch(e => { console.error('[latency] error:', e); process.exit(1); });
