#!/usr/bin/env node
// electron/scripts/smoke-rag-test.js
// ---------------------------------------------------------------
// RAG accuracy smoke — runs against bundled transformers.js model
// at electron/vendor/models/Xenova/multilingual-e5-small. Loads the
// 40-query canonical fixture, embeds all 25 chunks + 40 queries,
// measures Top-1 + Top-3 retrieval accuracy on non-OOD queries.
//
// HARD GATE: Top-3 >= 85% — process.exit(1) if below.
// Top-1 printed as soft metric.
//
// Does NOT hit network (allowRemoteModels: false).
// Cold model load ~10-15s; embedding 25 + 40 = 65 passes ~2-3s.

const path = require('path');
const fs = require('fs');

async function main() {
  // Dynamic import — @xenova/transformers is ESM-only.
  const { pipeline, env } = await import('@xenova/transformers');

  // Point at bundled model, no network fallback.
  env.localModelPath = path.join(__dirname, '..', 'vendor', 'models');
  env.cacheDir = env.localModelPath;
  env.allowLocalModels = true;
  env.allowRemoteModels = false;

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
  const extractor = await pipeline(
    'feature-extraction',
    'Xenova/multilingual-e5-small',
    { quantized: true, local_files_only: true }
  );
  console.log(`[smoke-rag] model loaded in ${Date.now() - t0}ms`);

  async function embed(text, isQuery) {
    const prefix = isQuery ? 'query: ' : 'passage: ';
    const out = await extractor(prefix + text, { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  }
  function cos(a, b) {
    let s = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s;
  }

  console.log(`[smoke-rag] embedding ${fx.chunks.length} chunks...`);
  for (const c of fx.chunks) {
    c.vec = await embed(c.text, false);
  }

  console.log(`[smoke-rag] embedding ${fx.queries.length} queries + scoring...`);
  let t1 = 0, t3 = 0, total = 0;
  const fails = [];
  for (const q of fx.queries) {
    if (!Array.isArray(q.expected) || q.expected.length === 0) continue; // skip OOD
    total++;
    const qv = await embed(q.q, true);
    const ranked = fx.chunks
      .map(c => ({ id: c.id, s: cos(qv, c.vec) }))
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
  console.log('\n[smoke-rag] OK (Top-3 gate passed)');
}

main().catch((e) => {
  console.error('[smoke-rag] error:', e && e.stack || e);
  process.exit(1);
});
