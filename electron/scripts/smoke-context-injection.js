#!/usr/bin/env node
// Smoke test for the contextInjection="continuation-skip" fix (commit da3806d).
//
// What this proves:
//  1. openclaw's `hasCompletedBootstrapTurn(sessionFile)` returns false for a
//     fresh session file (no bootstrap marker) → first customer message will
//     get full bootstrap injection (no regression).
//  2. Returns true after a session file contains the marker record
//     `{type:"custom", customType:"openclaw:bootstrap-context:full"}` → next
//     message from same customer will SKIP bootstrap (~8k token savings).
//  3. Returns false if a compaction record appears AFTER the marker → after
//     compaction, bootstrap re-fires (safety rules not permanently stale).
//
// Why: the fix is a 1-line config change. Smoke-test.js already validates
// openclaw accepts the config value. This file validates the OTHER HALF —
// that the skip logic actually kicks in when expected. If a future openclaw
// release changes the marker format or scan logic, this smoke will fail.

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
  console.log('[context-injection smoke] verifying continuation-skip behavior...');

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
  const mainJs = fs.readFileSync(path.join(root, 'main.js'), 'utf-8');

  // Strip block comments + line comments before matching so we assert against
  // executable code only. Quick/dirty but good enough for fingerprint checks.
  const stripped = mainJs
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\/])\/\/[^\n]*/g, '$1');

  if (!/config\.agents\.defaults\.contextInjection\s*=\s*['"]continuation-skip['"]/.test(stripped)) {
    fail('main.js no longer ASSIGNS contextInjection="continuation-skip" in code — fix reverted?');
  }
  ok('main.js ensureDefaultConfig writes contextInjection="continuation-skip"');

  // Must be the actual array literal, not the comment describing it.
  if (!/DENY_TOOLS\s*=\s*\[[\s\S]*?['"]image_generate['"][\s\S]*?['"]exec['"][\s\S]*?\]/.test(stripped)) {
    fail('main.js no longer defines DENY_TOOLS array with image_generate + exec — tools.deny reverted?');
  }
  ok('main.js ensureDefaultConfig denies media-gen + exec tools');

  if (!/config\.tools\.loopDetection\.enabled\s*=\s*true\s*;/.test(stripped)) {
    fail('main.js no longer ASSIGNS tools.loopDetection.enabled = true — safety net reverted?');
  }
  ok('main.js ensureDefaultConfig enables tools.loopDetection.enabled');

  // Layer 5 vision: ensureDefaultConfig must declare input:["image"] on
  // ninerouter models or pi-ai will strip image_url parts at final
  // outbound serialization (commit ef6076f). Assert the mutation code
  // survives refactors.
  if (!/m\.input\s*=\s*Array\.isArray\(m\.input\)[\s\S]{0,100}?['"]image['"]/.test(stripped) &&
      !/m\.input\s*=\s*\[[^\]]*['"]image['"]/.test(stripped)) {
    fail('main.js no longer assigns input:["image"] on ninerouter models — pi-ai will strip every image_url → bot hallucinates images.');
  }
  ok('main.js ensureDefaultConfig sets model.input includes "image"');

  // --- Test 8: cross-binding — continuation-skip REQUIRES tools.deny:exec ---
  // Reviewer observation C2: with contextInjection="continuation-skip",
  // AGENTS.md rule "KHÔNG chạy openclaw CLI qua exec" is NOT in system prompt
  // on tin 2+. tools.deny:["exec","process"] closes that hole at the config
  // level. If one of these two fixes silently reverts, safety degrades on
  // repeat customer messages. Enforce they ship together.
  const hasContInjSkip = /config\.agents\.defaults\.contextInjection\s*=\s*['"]continuation-skip['"]/.test(stripped);
  const denyHasExec = /DENY_TOOLS\s*=\s*\[[\s\S]*?['"]exec['"]/.test(stripped);
  if (hasContInjSkip && !denyHasExec) {
    fail('contextInjection="continuation-skip" is set but tools.deny[exec] is not — safety gap on tin 2+');
  }
  ok('continuation-skip + tools.deny[exec] co-bound (C2 cross-invariant)');

  console.log('[context-injection smoke] PASS — all 9 assertions held');
}

run().catch(e => { console.error('[context-injection smoke] threw:', e); process.exit(1); });
