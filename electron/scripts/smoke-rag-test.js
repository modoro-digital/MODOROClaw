#!/usr/bin/env node
// electron/scripts/smoke-rag-test.js
// ---------------------------------------------------------------
// RAG accuracy smoke — loads the 40-query canonical fixture, embeds all 25
// chunks + 40 queries, measures Top-1 + Top-3 retrieval accuracy on non-OOD
// queries.
//
// E1 FIX: imports the SAME embedder module main.js uses (electron/lib/embedder.js)
// so a bug in production embedText() actually fails this gate.
//
// E2 FIX: degeneracy guard — computes mean pairwise cosine between chunks.
// If mean > 0.95 → embeddings collapsed (e.g. all-zero, constant vector from
// broken quantization). Catches silent-failure the Top-3 gate could miss.
//
// HARD GATES:
//   1. Top-3 >= 85% — process.exit(1) if below.
//   2. Mean pairwise chunk-chunk cosine < 0.95 — process.exit(1) if degenerate.
// Top-1 printed as soft metric.

const path = require('path');
const fs = require('fs');

// Route the shared embedder at the bundled models dir for smoke runs.
const embedder = require('../lib/embedder');
embedder.setModelsRoot(path.join(__dirname, '..', 'vendor'));
const { embedText, cosineSim } = embedder;

async function main() {
  const fixturePath = path.join(__dirname, '..', 'test-fixtures', 'rag-canonical.json');
  if (!fs.existsSync(fixturePath)) {
    console.error(`[smoke-rag] fixture missing: ${fixturePath}`);
    process.exit(1);
  }
  const fx = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
  if (!Array.isArray(fx.chunks) || !Array.isArray(fx.queries)) {
    console.error('[smoke-rag] fixture malformed — expected {chunks:[], queries:[]}');
    process.exit(1);
  }

  console.log(`[smoke-rag] loading Xenova/multilingual-e5-small (quantized, local-only)...`);
  const t0 = Date.now();
  // First call triggers load; log time separately.
  await embedText('warmup', false);
  console.log(`[smoke-rag] model loaded in ${Date.now() - t0}ms`);

  console.log(`[smoke-rag] embedding ${fx.chunks.length} chunks...`);
  for (const c of fx.chunks) {
    c.vec = await embedText(c.text, false);
  }

  // E2: Degeneracy guard. If all chunks collapse to near-identical vectors,
  // Top-3 ≥ 85% can still pass by chance on small corpora — but the embedder
  // is actually broken. Mean pairwise cosine across all distinct pairs.
  let pairSum = 0, pairCount = 0;
  for (let i = 0; i < fx.chunks.length; i++) {
    for (let j = i + 1; j < fx.chunks.length; j++) {
      pairSum += cosineSim(fx.chunks[i].vec, fx.chunks[j].vec);
      pairCount++;
    }
  }
  const meanPair = pairSum / pairCount;
  console.log(`[smoke-rag] mean chunk-chunk cosine: ${meanPair.toFixed(4)} (degeneracy guard: <0.95)`);
  if (meanPair > 0.95) {
    console.error(`[smoke-rag] FAIL: embeddings collapsed (mean pairwise ${meanPair.toFixed(4)} > 0.95) — embedder broken`);
    process.exit(1);
  }

  console.log(`[smoke-rag] embedding ${fx.queries.length} queries + scoring...`);
  let t1 = 0, t3 = 0, total = 0;
  const fails = [];
  for (const q of fx.queries) {
    if (!Array.isArray(q.expected) || q.expected.length === 0) continue; // skip OOD
    total++;
    const qv = await embedText(q.q, true);
    const ranked = fx.chunks
      .map(c => ({ id: c.id, s: cosineSim(qv, c.vec) }))
      .sort((a, b) => b.s - a.s);
    const top3ids = ranked.slice(0, 3).map(x => x.id);
    if (q.expected.includes(top3ids[0])) t1++;
    if (q.expected.some(id => top3ids.includes(id))) {
      t3++;
    } else {
      fails.push(`[${q.note}] "${q.q}" top3=[${top3ids.join(',')}] expected=[${q.expected.join(',')}]`);
    }
  }

  const t1pct = (t1 / total * 100).toFixed(1);
  const t3pct = (t3 / total * 100).toFixed(1);
  console.log('');
  console.log(`[smoke-rag] Top-1: ${t1}/${total} = ${t1pct}%`);
  console.log(`[smoke-rag] Top-3: ${t3}/${total} = ${t3pct}%`);
  if (fails.length > 0) {
    console.log(`[smoke-rag] ${fails.length} Top-3 miss(es):`);
    for (const f of fails) console.log(`  ${f}`);
  }

  if (t3 / total < 0.85) {
    console.error(`\n[smoke-rag] FAIL: Top-3 ${t3pct}% below 85% gate`);
    process.exit(1);
  }
  console.log('\n[smoke-rag] OK (Top-3 gate passed + degeneracy guard passed)');
}

main().catch((e) => {
  console.error('[smoke-rag] error:', e && e.stack || e);
  process.exit(1);
});
