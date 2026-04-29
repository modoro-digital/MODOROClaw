#!/usr/bin/env node
// Smoke test for contextInjection config and openclaw bootstrap internals.
// We use contextInjection="always" so AGENTS.md is injected on EVERY turn
// (model was ignoring rules when continuation-skip dropped bootstrap after
// the first message). This test validates openclaw's bootstrap machinery
// still works correctly in case we ever need to switch modes.

const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.resolve(__dirname, '..');

function fail(msg) { console.error('[context-injection smoke] FAIL:', msg); process.exit(1); }
function ok(msg) { console.log('  OK  ', msg); }

// Try the source-tree vendor first (post-prebuild). Fall back to AppData
// locations where a running MODOROClaw install stores its vendor dir so dev
// can run this smoke without first running prebuild:vendor.
function candidateDistDirs() {
  const dirs = [path.join(root, 'vendor', 'node_modules', 'openclaw', 'dist')];
  if (process.env.OPENCLAW_DIST_DIR) dirs.unshift(process.env.OPENCLAW_DIST_DIR);
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  for (const app of ['modoro-claw', '9bizclaw', 'MODOROClaw']) {
    dirs.push(path.join(appData, app, 'vendor', 'node_modules', 'openclaw', 'dist'));
  }
  if (process.platform === 'darwin') {
    for (const app of ['modoro-claw', '9bizclaw', 'MODOROClaw']) {
      dirs.push(path.join(os.homedir(), 'Library', 'Application Support', app, 'vendor', 'node_modules', 'openclaw', 'dist'));
    }
  }
  return dirs;
}

function findBootstrapFilesChunk() {
  for (const d of candidateDistDirs()) {
    if (!fs.existsSync(d)) continue;
    const entries = fs.readdirSync(d);
    const match = entries.find(f => /^bootstrap-files-[A-Za-z0-9_-]+\.js$/.test(f));
    if (match) return { path: path.join(d, match), dir: d };
  }
  return null;
}

async function run() {
  console.log('[context-injection smoke] verifying bootstrap machinery...');

  const found = findBootstrapFilesChunk();
  if (!found) {
    console.log('  WARN chunk not found in source vendor/ or AppData installs — skip smoke');
    console.log('       run prebuild:vendor OR install MODOROClaw OR set OPENCLAW_DIST_DIR=<dir>');
    return;
  }
  const { path: chunkPath, dir: chunkDir } = found;
  ok(`located bootstrap-files chunk: ${path.relative(process.cwd(), chunkPath) || chunkPath}`);

  // Dynamic-import the ESM module. Exports are minified single letters whose
  // identities we resolve by reading the export map at the bottom of the file
  // — Rollup emits `export { X as a, Y as i, ... }` which is stable format.
  const src = fs.readFileSync(chunkPath, 'utf-8');
  const exportMatch = src.match(/^export\s*\{([^}]+)\}\s*;?\s*$/m);
  if (!exportMatch) fail('could not parse export map from ' + path.basename(chunkPath));
  const exportMap = {};
  for (const pair of exportMatch[1].split(',')) {
    const m = pair.trim().match(/^(\w+)\s+as\s+(\w+)$/);
    if (m) exportMap[m[1]] = m[2];  // { hasCompletedBootstrapTurn: "n", ... }
  }
  const hasKey = exportMap.hasCompletedBootstrapTurn;
  const markerKey = exportMap.FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE;
  if (!hasKey || !markerKey) {
    fail('openclaw renamed exports — expected hasCompletedBootstrapTurn + FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE');
  }

  const url = 'file:///' + chunkPath.replace(/\\/g, '/');
  const mod = await import(url);
  const hasCompletedBootstrapTurn = mod[hasKey];
  const MARKER = mod[markerKey];

  if (typeof hasCompletedBootstrapTurn !== 'function') fail('hasCompletedBootstrapTurn is not a function');
  if (MARKER !== 'openclaw:bootstrap-context:full') {
    fail(`MARKER changed: expected "openclaw:bootstrap-context:full", got ${JSON.stringify(MARKER)}`);
  }
  ok(`openclaw marker constant stable: ${MARKER}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-ctxinj-'));
  const sessionFile = path.join(tmpDir, 'session.jsonl');

  try {
    // --- Test 1: empty session file → no bootstrap marker → false ---
    fs.writeFileSync(sessionFile, '');
    const r1 = await hasCompletedBootstrapTurn(sessionFile);
    if (r1 !== false) fail(`empty session: expected false, got ${r1}`);
    ok('empty session → bootstrap fires (first message path preserved)');

    // --- Test 2: session file with marker record → true ---
    const markerLine = JSON.stringify({
      type: 'custom',
      customType: MARKER,
      data: { timestamp: Date.now(), runId: 'test-run', sessionId: 'test-sess' },
    }) + '\n';
    // Prepend some realistic noise so we test the tail-scan logic.
    const userLine = JSON.stringify({ type: 'user', role: 'user', content: 'xin chào' }) + '\n';
    const assistantLine = JSON.stringify({ type: 'assistant', role: 'assistant', content: 'Dạ em chào anh' }) + '\n';
    fs.writeFileSync(sessionFile, userLine + assistantLine + markerLine);
    const r2 = await hasCompletedBootstrapTurn(sessionFile);
    if (r2 !== true) fail(`marker present: expected true, got ${r2}`);
    ok('marker present → bootstrap SKIPPED (8k+ token savings per repeat message)');

    // --- Test 3: marker + compaction after → false (re-fire) ---
    const compactionLine = JSON.stringify({ type: 'compaction', reason: 'size-limit' }) + '\n';
    fs.writeFileSync(sessionFile, userLine + assistantLine + markerLine + compactionLine);
    const r3 = await hasCompletedBootstrapTurn(sessionFile);
    if (r3 !== false) fail(`marker + compaction: expected false, got ${r3}`);
    ok('compaction after marker → bootstrap re-fires (safety rules refreshed)');

    // --- Test 4: no session file at all → false (graceful) ---
    fs.unlinkSync(sessionFile);
    const r4 = await hasCompletedBootstrapTurn(sessionFile);
    if (r4 !== false) fail(`missing session: expected false, got ${r4}`);
    ok('missing session file → bootstrap fires (new customer graceful)');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  // --- Test 5: our ensureDefaultConfig actually writes all 3 token-bloat keys ---
  // Regexes MUST match the ASSIGNMENT literal, not comments — reviewer caught
  // prior version matching block comments, which meant deleting the code and
  // keeping the comment would silently pass the smoke.
  const configJs = fs.readFileSync(path.join(root, 'lib', 'config.js'), 'utf-8');

  // Strip block comments + line comments before matching so we assert against
  // executable code only. Quick/dirty but good enough for fingerprint checks.
  const stripped = configJs
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\/])\/\/[^\n]*/g, '$1');

  if (!/config\.agents\.defaults\.contextInjection\s*!==?\s*['"]always['"]/.test(stripped)) {
    fail('config.js no longer ASSIGNS contextInjection="always" in code — fix reverted?');
  }
  ok('config.js ensureDefaultConfig writes contextInjection="always"');

  // tools.allow allowlist replaces the old deny approach — verify it exists
  // config.js renamed ALLOW_TOOLS → REQUIRED_TOOLS in modularization
  if (!/REQUIRED_TOOLS\s*=\s*\[[\s\S]*?['"]message['"][\s\S]*?['"]web_search['"][\s\S]*?\]/.test(stripped) &&
      !/ALLOW_TOOLS\s*=\s*\[[\s\S]*?['"]message['"][\s\S]*?['"]web_search['"][\s\S]*?\]/.test(stripped)) {
    fail('config.js no longer defines REQUIRED_TOOLS/ALLOW_TOOLS array with message + web_search — tools.allow reverted?');
  }
  ok('config.js ensureDefaultConfig sets tools.allow allowlist');

  if (!/config\.tools\.loopDetection\.enabled\s*=\s*true\s*;/.test(stripped)) {
    fail('config.js no longer ASSIGNS tools.loopDetection.enabled = true — safety net reverted?');
  }
  ok('config.js ensureDefaultConfig enables tools.loopDetection.enabled');

  // Layer 5 vision: ensureDefaultConfig must declare input:["image"] on
  // ninerouter models or pi-ai will strip image_url parts at final
  // outbound serialization (commit ef6076f). Assert the mutation code
  // survives refactors.
  if (!/m\.input\s*=\s*Array\.isArray\(m\.input\)[\s\S]{0,100}?['"]image['"]/.test(stripped) &&
      !/m\.input\s*=\s*\[[^\]]*['"]image['"]/.test(stripped)) {
    fail('config.js no longer assigns input:["image"] on ninerouter models — pi-ai will strip every image_url → bot hallucinates images.');
  }
  ok('config.js ensureDefaultConfig sets model.input includes "image"');

  // --- Test 8: cross-binding — continuation-skip + tools.allow must coexist ---
  const hasContInjSkip = /config\.agents\.defaults\.contextInjection\s*=\s*['"]continuation-skip['"]/.test(stripped);
  const hasAllowList = /(?:ALLOW_TOOLS|REQUIRED_TOOLS)\s*=\s*\[/.test(stripped);
  if (hasContInjSkip && !hasAllowList) {
    fail('contextInjection="continuation-skip" is set but tools.allow is missing — unbounded tool surface');
  }
  ok('continuation-skip + tools.allow co-bound (C2 cross-invariant)');

  console.log('[context-injection smoke] PASS — all 9 assertions held');
}

run().catch(e => { console.error('[context-injection smoke] threw:', e); process.exit(1); });
