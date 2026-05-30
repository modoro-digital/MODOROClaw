#!/usr/bin/env node
'use strict';
// Smoke test: skill-runner + python-runtime + cron-api auth gate.
// Covers gaps surfaced by 2026-05-15 round-2 reviews — these subsystems had
// zero smoke coverage and contain security-sensitive code (Python stub
// detection, channel gate, Bearer token validation).
//
// Run via `npm run smoke` (wired into guard:architecture).

const path = require('path');
const fs = require('fs');
const os = require('os');

let PASS = 0, FAIL = 0;
function ok(name) { PASS++; console.log('  PASS', name); }
function bad(name, why) { FAIL++; console.error('  FAIL', name, '|', why); }

// ── 1. python-runtime: stub detection ──
{
  const py = require(path.join('..', 'lib', 'python-runtime.js'));
  // We can't unit-test the actual MS Store stub without Windows, but we can
  // verify the helper function exists + handles the empty case sanely.
  if (typeof py.detectSystemPython === 'function') ok('python-runtime exposes detectSystemPython');
  else bad('python-runtime exposes detectSystemPython', 'function missing');

  if (typeof py.ensurePython === 'function') ok('python-runtime exposes ensurePython');
  else bad('python-runtime exposes ensurePython', 'function missing');

  // EMBEDDED_PYTHON_VERSION must be pinned (not floating).
  const ver = py.EMBEDDED_PYTHON_VERSION;
  if (typeof ver === 'string' && /^3\.\d+\.\d+$/.test(ver)) ok('embedded Python version pinned (' + ver + ')');
  else bad('embedded Python version pinned', 'got: ' + ver);

  // Verify _isMsStoreStub regex (read source — function isn't exported).
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'python-runtime.js'), 'utf-8');
  if (/_isMsStoreStub/.test(src) && /WindowsApps.*python.*exe/i.test(src)) ok('MS Store stub guard present');
  else bad('MS Store stub guard present', 'guard helper missing');

  if (/_isMacCltStubMissing/.test(src) && /xcode-select/.test(src)) ok('Mac CLT stub guard present');
  else bad('Mac CLT stub guard present', 'guard helper missing');

  // Token regex narrowed to absolute paths only — never PATH-relative.
  if (/path\.isAbsolute\(p\)/.test(src)) ok('Python cache requires absolute path');
  else bad('Python cache requires absolute path', 'isAbsolute check missing');
}

// ── 2. skill-runner: filename validation regex ──
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'skill-runner.js'), 'utf-8');
  if (/_resolveRuntimeBin/.test(src) && /runScript/.test(src)) ok('skill-runner exposes runScript + _resolveRuntimeBin');
  else bad('skill-runner exposes runScript + _resolveRuntimeBin', 'missing');

  if (/_buildSafeEnv/.test(src) && /PYTHONIOENCODING/.test(src)) ok('skill-runner sets PYTHONIOENCODING=utf-8 in safe env');
  else bad('skill-runner sets PYTHONIOENCODING=utf-8 in safe env', 'env hardening missing');

  if (/setTimeout/.test(src) && /SIGTERM/.test(src) && /SIGKILL/.test(src)) ok('skill-runner enforces timeout with SIGTERM+SIGKILL');
  else bad('skill-runner enforces timeout with SIGTERM+SIGKILL', 'kill path missing');
}

// ── 3. cron-api auth gate ──
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cron-api.js'), 'utf-8');
  if (/_requireCeoTelegram/.test(src)) ok('cron-api defines _requireCeoTelegram helper');
  else bad('cron-api defines _requireCeoTelegram helper', 'helper missing');

  // Global gate must check non-public routes BEFORE any handler dispatch.
  // Google routes also gated by _requireCeoTelegram (merged gate).
  if (/PUBLIC_ROUTES/.test(src) && /if \(!PUBLIC_ROUTES\.has\(urlPath\)/.test(src)) ok('cron-api global default-deny gate present');
  else bad('cron-api global default-deny gate present', 'gate not wired');

  // Bearer regex must demand 48 hex (16 byte * 2 ascii each, plus +16 from extra randomBytes(24).toString).
  if (/Bearer\\s\+\(\[a-f0-9\]\{48\}\)/i.test(src) || /Bearer.*\[a-f0-9\]\{48\}/.test(src)) ok('cron-api Bearer regex matches 48-hex token');
  else bad('cron-api Bearer regex matches 48-hex token', 'regex missing or wrong length');

  // Timing-safe compare.
  if (/timingSafeEqual/.test(src)) ok('cron-api token compare uses timingSafeEqual');
  else bad('cron-api token compare uses timingSafeEqual', 'using == or === (timing channel)');

  // Old fail-open pattern must be gone.
  const oldFailOpen = /if \(_reqChannel && _reqChannel\.toLowerCase\(\) !== 'telegram'\)/g;
  const matches = src.match(oldFailOpen);
  // 1 match is OK (in the explanatory comment); >1 means old pattern still in code.
  if (!matches || matches.length <= 1) ok('cron-api fail-open channel check eliminated');
  else bad('cron-api fail-open channel check eliminated', `${matches.length} occurrences still in code`);
}

// ── 4. skill-manager: appliesTo migration + folder layout ──
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'skill-manager.js'), 'utf-8');
  if (/_APPLIESTO_PATH_MIGRATIONS/.test(src) && /operations\/zalo-reply-rules.*operations\/zalo/.test(src)) {
    ok('skill-manager has appliesTo path migrations');
  } else bad('skill-manager has appliesTo path migrations', 'migration map missing');

  if (/persistAppliesToMigrationIfNeeded/.test(src)) ok('skill-manager has boot-time migration persistence');
  else bad('skill-manager has boot-time migration persistence', 'persist helper missing');

  if (/_yamlEscape/.test(src)) ok('skill-manager escapes YAML for SKILL.md frontmatter');
  else bad('skill-manager escapes YAML for SKILL.md frontmatter', 'no escape helper');

  // matchActiveSkills must support `opts.scope` for appliesTo filtering.
  if (/function matchActiveSkills\(rawBody, opts/.test(src) && /opts\.scope/.test(src)) {
    ok('matchActiveSkills accepts scope filter for appliesTo');
  } else bad('matchActiveSkills accepts scope filter for appliesTo', 'scope param not wired');

  // updateUserSkill must branch on layout.
  if (/skill\.layout === 'folder'/.test(src)) ok('updateUserSkill branches on layout');
  else bad('updateUserSkill branches on layout', 'layout-blind write');

  // Folder format SKILL.md must persist `filename:` so restore can recover it.
  if (/fmLines\.push\(`\s+filename: \$\{_yamlEscape\(s\.filename\)\}`\)/.test(src)) {
    ok('_buildAnthropicSkillMd persists filename in YAML');
  } else bad('_buildAnthropicSkillMd persists filename in YAML', 'filename not written');
}

// ── 5. cron.js sleep recovery + idempotency ──
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cron.js'), 'utf-8');
  if (/function replayMissedCrons/.test(src)) ok('cron has replayMissedCrons (Windows sleep catch-up)');
  else bad('cron has replayMissedCrons (Windows sleep catch-up)', 'function missing');

  if (/_seedRecentFiresFromAudit/.test(src)) ok('cron seeds recent fires from audit log (crash idempotency)');
  else bad('cron seeds recent fires from audit log (crash idempotency)', 'seed function missing');

  if (/_withKnowledgeLock/.test(src)) ok('cron has separate knowledge write lock (no cron-vs-knowledge starvation)');
  else bad('cron has separate knowledge write lock (no cron-vs-knowledge starvation)', 'lock not split');

  if (/isChannelPaused\('zalo'\)/.test(src)) ok('cron checks Zalo pause BEFORE agent run');
  else bad('cron checks Zalo pause BEFORE agent run', 'pause check missing');
}

// ── 6. Anthropic document skills routing ──
{
  const root = path.join(__dirname, '..', '..');
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf-8');
  const workspace = fs.readFileSync(path.join(__dirname, '..', 'lib', 'workspace.js'), 'utf-8');
  const requiredSkills = [
    'skills/anthropic-docx/SKILL.md',
    'skills/anthropic-xlsx/SKILL.md',
    'skills/anthropic-pptx/SKILL.md',
    'skills/anthropic-pdf/SKILL.md',
  ];
  for (const skillPath of requiredSkills) {
    if (fs.existsSync(path.join(root, skillPath))) ok('Anthropic skill exists: ' + skillPath);
    else bad('Anthropic skill exists: ' + skillPath, 'missing folder skill');
    if (agents.includes(skillPath)) ok('AGENTS routes document tasks to ' + skillPath);
    else bad('AGENTS routes document tasks to ' + skillPath, 'route missing');
  }
  const staleRoutes = [
    'skills/minimax-docx/SKILL.md',
    'skills/minimax-xlsx/SKILL.md',
    'skills/minimax-pdf/SKILL.md',
    'skills/pptx-generator/SKILL.md',
  ];
  const stale = staleRoutes.filter(route => agents.includes(route));
  if (stale.length === 0) ok('AGENTS no longer routes document tasks to MiniMax skills');
  else bad('AGENTS no longer routes document tasks to MiniMax skills', stale.join(', '));
  if (!/pptxgenjs`\s+v3/.test(agents)) ok('AGENTS does not claim pptxgenjs v3');
  else bad('AGENTS does not claim pptxgenjs v3', 'installed dependency is v4.x');
  if (/modoroclaw-agents-version:\s*110/.test(agents) && /CURRENT_AGENTS_MD_VERSION\s*=\s*110/.test(workspace)) {
    ok('AGENTS template version bumped to 110');
  } else {
    bad('AGENTS template version bumped to 110', 'AGENTS.md and workspace.js must stay in sync');
  }
}

// ── 7. inbound.ts folder-skill resolution ──
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'packages', 'modoro-zalo', 'src', 'inbound.ts'), 'utf-8');
  // Folder resolution: check SKILL.md path is constructed (any whitespace, may be on separate lines).
  if (/"SKILL\.md"/.test(src) && /__folderSkillMd/.test(src)) ok('inbound.ts resolves folder-layout SKILL.md');
  else bad('inbound.ts resolves folder-layout SKILL.md', 'still hardcodes flat .md');

  if (/__usScopes/.test(src) && /operations\/zalo/.test(src)) ok('inbound.ts applies Zalo scope filter');
  else bad('inbound.ts applies Zalo scope filter', 'scope filter missing');

  // v4: channel-scoped auth — only Telegram sessions get Bearer.
  const vp = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vendor-patches.js'), 'utf-8');
  if (/agentChannel === .telegram./.test(vp) && /Bearer/.test(vp)) ok('vendor-patches injects Bearer for Telegram only (channel-scoped)');
  else bad('vendor-patches injects Bearer for Telegram only (channel-scoped)', 'channel check or Bearer missing in helper');
  if (/isTelegram\s*=\s*true/.test(vp)) bad('vendor-patches old isTelegram=true still present', 'security regression');
  else ok('vendor-patches isTelegram=true absent (old pattern removed)');
}

console.log('');
console.log(`[smoke-skill-runtime] ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) process.exit(1);
