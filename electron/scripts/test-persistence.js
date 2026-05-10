#!/usr/bin/env node
/**
 * test-persistence.js — Simulate CEO daily flow and verify data survives
 * reboots and app updates.
 *
 * Creates a temporary workspace, runs through: boot → wizard → daily use →
 * reboot → app update (AGENTS.md version bump) → verify everything persisted.
 *
 * Usage:  node electron/scripts/test-persistence.js
 * Exit:   0 = all pass, 1 = failures found
 */

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Temp directory setup ────────────────────────────────────────
const TEMP_ROOT = path.join(os.tmpdir(), 'modoroclaw-persist-test-' + Date.now());
const TEMP_WS = path.join(TEMP_ROOT, 'workspace');
const TEMP_HOME = path.join(TEMP_ROOT, 'home');
const TEMP_OC = path.join(TEMP_HOME, '.openclaw');
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON_ROOT = path.resolve(__dirname, '..');

fs.mkdirSync(TEMP_WS, { recursive: true });
fs.mkdirSync(path.join(TEMP_OC, 'extensions', 'modoro-zalo'), { recursive: true });
fs.mkdirSync(path.join(TEMP_OC, 'logs'), { recursive: true });
fs.writeFileSync(path.join(TEMP_OC, 'openclaw.json'), JSON.stringify({
  channels: {}, agents: { defaults: {} }, gateway: {}, tools: {}, plugins: {},
}, null, 2));

// Copy template files from repo root so seedWorkspace can find them
const TEMPLATE_FILES = [
  'AGENTS.md', 'BOOTSTRAP.md', 'SOUL.md', 'IDENTITY.md', 'USER.md',
  'COMPANY.md', 'PRODUCTS.md', 'MEMORY.md', 'TOOLS.md', 'README.md',
];
for (const f of TEMPLATE_FILES) {
  const src = path.join(REPO_ROOT, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TEMP_WS, f));
}
for (const d of ['skills', 'tools', 'docs', 'prompts', 'memory', 'config', 'knowledge']) {
  _copyDirShallow(path.join(REPO_ROOT, d), path.join(TEMP_WS, d));
}

function _copyDirShallow(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) _copyDirShallow(s, d);
    else if (!fs.existsSync(d)) fs.copyFileSync(s, d);
  }
}

// ── Redirect context BEFORE requiring modules ───────────────────
const ctx = require('../lib/context');
ctx.HOME = TEMP_HOME;
ctx.resourceDir = TEMP_WS;
ctx.userDataDir = TEMP_WS;

const { getWorkspace, seedWorkspace, invalidateWorkspaceCache, _setWorkspaceCacheForTest, setCompilePersonaMix } = require('../lib/workspace');
const { ensureDefaultConfig } = require('../lib/config');
const { writeJsonAtomic } = require('../lib/util');

let compilePersonaMix;
try {
  compilePersonaMix = require('../lib/persona').compilePersonaMix;
  if (compilePersonaMix) setCompilePersonaMix(compilePersonaMix);
} catch {}

// ── Test helpers ────────────────────────────────────────────────
let passed = 0, failed = 0;
function pass(name, detail) {
  passed++;
  console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? ' — ' + detail : ''}`);
}
function fail(name, detail) {
  failed++;
  console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ' — ' + detail : ''}`);
}
function assert(cond, name, detail) {
  if (cond) pass(name, detail);
  else fail(name, detail);
}
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

// ── Main test flow ──────────────────────────────────────────────
async function main() {
  const ws = getWorkspace();
  console.log('\n\x1b[1m  Temp workspace: ' + ws + '\x1b[0m');
  console.log('  Temp HOME:      ' + TEMP_HOME + '\n');

  // ============================================================
  //  PHASE 1: First boot
  // ============================================================
  console.log('\x1b[1m=== PHASE 1: First Boot ===\x1b[0m\n');

  seedWorkspace();
  await ensureDefaultConfig();

  assert(fs.existsSync(path.join(ws, 'AGENTS.md')), 'T1.1 AGENTS.md created');
  assert(fs.existsSync(path.join(ws, 'SOUL.md')), 'T1.2 SOUL.md created');
  assert(fs.existsSync(path.join(ws, 'IDENTITY.md')), 'T1.3 IDENTITY.md created');
  assert(fs.existsSync(path.join(ws, 'memory', 'zalo-users')), 'T1.4 memory/zalo-users/ created');
  assert(fs.existsSync(path.join(ws, 'memory', 'zalo-groups')), 'T1.5 memory/zalo-groups/ created');

  const schedPath = path.join(ws, 'schedules.json');
  const sched = readJson(schedPath);
  assert(sched && Array.isArray(sched) && sched.length >= 6, 'T1.6 schedules.json seeded', sched ? sched.length + ' entries' : 'null');

  const persona = readJson(path.join(ws, 'active-persona.json'));
  assert(persona && persona.traits, 'T1.7 active-persona.json seeded');

  const ocConfig = readJson(path.join(TEMP_OC, 'openclaw.json'));
  assert(ocConfig && ocConfig.gateway?.mode === 'local', 'T1.8 gateway.mode = local');
  assert(ocConfig && ocConfig.agents?.defaults?.blockStreamingDefault === 'off', 'T1.9 blockStreamingDefault = off');

  // ============================================================
  //  PHASE 2: Wizard (simulate CEO filling business profile + persona)
  // ============================================================
  console.log('\n\x1b[1m=== PHASE 2: Wizard Simulation ===\x1b[0m\n');

  // Write COMPANY.md
  const companyContent = '# Thong tin cong ty\n\nTen: MODORO Tech\nNganh: AI/SaaS\n';
  fs.writeFileSync(path.join(ws, 'COMPANY.md'), companyContent);
  assert(fs.readFileSync(path.join(ws, 'COMPANY.md'), 'utf-8').includes('MODORO Tech'), 'T2.1 COMPANY.md saved');

  // Write IDENTITY.md
  const identityContent = '---\nCach xung ho: anh Peter\nChuc vu: CEO\n---\n';
  fs.writeFileSync(path.join(ws, 'IDENTITY.md'), identityContent);
  assert(fs.readFileSync(path.join(ws, 'IDENTITY.md'), 'utf-8').includes('Peter'), 'T2.2 IDENTITY.md saved');

  // Write persona
  const personaMix = {
    traits: { warmth: 0.8, formality: 0.3 },
    greeting: 'Xin chao anh!',
    closing: 'Than men,',
    phrases: ['du roi anh', 'de em check'],
  };
  writeJsonAtomic(path.join(ws, 'active-persona.json'), personaMix);
  const savedPersona = readJson(path.join(ws, 'active-persona.json'));
  assert(savedPersona?.greeting === 'Xin chao anh!', 'T2.3 active-persona.json saved');

  // Enable modoro-zalo channel in openclaw.json
  const config2 = readJson(path.join(TEMP_OC, 'openclaw.json'));
  if (config2) {
    if (!config2.channels) config2.channels = {};
    config2.channels['modoro-zalo'] = { enabled: true, dmPolicy: 'open', allowFrom: ['*'], groupPolicy: 'open' };
    fs.writeFileSync(path.join(TEMP_OC, 'openclaw.json'), JSON.stringify(config2, null, 2) + '\n');
  }
  await ensureDefaultConfig();
  const config2b = readJson(path.join(TEMP_OC, 'openclaw.json'));
  assert(config2b?.channels?.['modoro-zalo']?.enabled === true, 'T2.4 modoro-zalo.enabled preserved after ensureDefaultConfig');

  // ============================================================
  //  PHASE 3: Daily Use
  // ============================================================
  console.log('\n\x1b[1m=== PHASE 3: Daily Use ===\x1b[0m\n');

  // Zalo blocklist
  const blocklistPath = path.join(ws, 'zalo-blocklist.json');
  writeJsonAtomic(blocklistPath, ['user1', 'user2', 'user3']);
  assert(readJson(blocklistPath)?.length === 3, 'T3.1 zalo-blocklist.json saved', '3 entries');

  // Zalo group settings
  const gsPath = path.join(ws, 'zalo-group-settings.json');
  writeJsonAtomic(gsPath, { group_abc: { mode: 'mention' }, group_xyz: { mode: 'all' } });
  assert(readJson(gsPath)?.group_abc?.mode === 'mention', 'T3.2 zalo-group-settings.json saved');

  // Stranger policy
  const spPath = path.join(ws, 'zalo-stranger-policy.json');
  writeJsonAtomic(spPath, { policy: 'reply-once' });
  assert(readJson(spPath)?.policy === 'reply-once', 'T3.3 zalo-stranger-policy.json saved');

  // Custom crons
  const ccPath = path.join(ws, 'custom-crons.json');
  writeJsonAtomic(ccPath, [{ id: 'cron1', label: 'Test cron', cronExpr: '0 9 * * *', prompt: 'hello', enabled: true }]);
  assert(readJson(ccPath)?.[0]?.id === 'cron1', 'T3.4 custom-crons.json saved');

  // Schedules — toggle morning off
  const schedData = readJson(schedPath) || [];
  const morning = schedData.find(s => s.id === 'morning');
  if (morning) morning.enabled = false;
  writeJsonAtomic(schedPath, schedData);
  assert(readJson(schedPath)?.find(s => s.id === 'morning')?.enabled === false, 'T3.5 schedules.json morning=off');

  // Zalo mode
  fs.mkdirSync(path.join(ws, 'config'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'config', 'zalo-mode.txt'), 'read', 'utf-8');
  assert(fs.readFileSync(path.join(ws, 'config', 'zalo-mode.txt'), 'utf-8') === 'read', 'T3.6 zalo-mode.txt saved');

  // Knowledge file
  const kDir = path.join(ws, 'knowledge', 'cong-ty', 'files');
  fs.mkdirSync(kDir, { recursive: true });
  fs.writeFileSync(path.join(kDir, 'test-doc.txt'), 'Knowledge content here');
  assert(fs.existsSync(path.join(kDir, 'test-doc.txt')), 'T3.7 knowledge file saved');

  // Memory file
  const memDir = path.join(ws, 'memory', 'zalo-users');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'customer123.md'), '# Customer 123\nVIP customer notes');
  assert(fs.existsSync(path.join(memDir, 'customer123.md')), 'T3.8 zalo memory file saved');

  // Add a custom tool to tools.allow
  const config3 = readJson(path.join(TEMP_OC, 'openclaw.json'));
  if (config3?.tools) {
    config3.tools.allow = [...(config3.tools.allow || []), 'custom_tool'];
    fs.writeFileSync(path.join(TEMP_OC, 'openclaw.json'), JSON.stringify(config3, null, 2) + '\n');
  }

  // ============================================================
  //  PHASE 4: Reboot Simulation
  // ============================================================
  console.log('\n\x1b[1m=== PHASE 4: Reboot ===\x1b[0m\n');

  invalidateWorkspaceCache();
  seedWorkspace();
  await ensureDefaultConfig();

  assert(readJson(blocklistPath)?.length === 3, 'T4.1 blocklist survived reboot');
  assert(readJson(gsPath)?.group_abc?.mode === 'mention', 'T4.2 group settings survived reboot');
  assert(readJson(spPath)?.policy === 'reply-once', 'T4.3 stranger policy survived reboot');
  assert(readJson(ccPath)?.[0]?.id === 'cron1', 'T4.4 custom crons survived reboot');
  assert(readJson(schedPath)?.find(s => s.id === 'morning')?.enabled === false, 'T4.5 schedules survived reboot');
  assert(fs.readFileSync(path.join(ws, 'config', 'zalo-mode.txt'), 'utf-8').trim() === 'read', 'T4.6 zalo-mode survived reboot');
  assert(readJson(path.join(ws, 'active-persona.json'))?.greeting === 'Xin chao anh!', 'T4.7 persona survived reboot');
  assert(fs.readFileSync(path.join(ws, 'COMPANY.md'), 'utf-8').includes('MODORO Tech'), 'T4.8 COMPANY.md survived reboot');
  assert(fs.readFileSync(path.join(ws, 'IDENTITY.md'), 'utf-8').includes('Peter'), 'T4.9 IDENTITY.md survived reboot');
  assert(fs.existsSync(path.join(kDir, 'test-doc.txt')), 'T4.10 knowledge file survived reboot');
  assert(fs.existsSync(path.join(memDir, 'customer123.md')), 'T4.11 memory file survived reboot');

  // Verify custom tool survived (merge, not replace)
  const config4 = readJson(path.join(TEMP_OC, 'openclaw.json'));
  assert(config4?.tools?.allow?.includes('custom_tool'), 'T4.12 custom tool survived reboot (merge)');
  assert(config4?.tools?.allow?.includes('message'), 'T4.13 required tools still present');

  // Verify modoro-zalo.enabled not clobbered
  assert(config4?.channels?.['modoro-zalo']?.enabled === true, 'T4.14 modoro-zalo.enabled survived reboot');

  // ============================================================
  //  PHASE 5: App Update (AGENTS.md version bump)
  // ============================================================
  console.log('\n\x1b[1m=== PHASE 5: App Update ===\x1b[0m\n');

  // Simulate packaged app upgrade: template dir (new AGENTS.md) != workspace dir (old AGENTS.md).
  // In dev mode, ws === templateRoot so version bump is skipped. In packaged mode, they differ.
  // We simulate packaged mode by splitting into separate template + workspace dirs.
  const TEMP_TEMPLATES = path.join(TEMP_ROOT, 'templates');
  fs.mkdirSync(TEMP_TEMPLATES, { recursive: true });
  for (const f of TEMPLATE_FILES) {
    const src = path.join(REPO_ROOT, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TEMP_TEMPLATES, f));
  }
  for (const d of ['skills', 'tools', 'docs', 'prompts', 'memory', 'config', 'knowledge']) {
    _copyDirShallow(path.join(REPO_ROOT, d), path.join(TEMP_TEMPLATES, d));
  }

  // Downgrade workspace AGENTS.md version to trigger upgrade
  const agentsPath = path.join(ws, 'AGENTS.md');
  let agentsContent = fs.readFileSync(agentsPath, 'utf-8');
  agentsContent = agentsContent.replace(/modoroclaw-agents-version:\s*\d+/, 'modoroclaw-agents-version: 1');
  fs.writeFileSync(agentsPath, agentsContent);

  // Inject Zalo mode line (simulates save-zalo-mode having written it before upgrade)
  agentsContent = fs.readFileSync(agentsPath, 'utf-8');
  if (agentsContent.includes('### Zalo')) {
    agentsContent = agentsContent.replace(
      /### Zalo[^\n]*/,
      match => match + '\n\n**Che do: Chi doc.** KHONG tu tra loi tren Zalo.'
    );
    fs.writeFileSync(agentsPath, agentsContent);
  }

  // Point resourceDir at templates, force workspace cache to TEMP_WS (simulates packaged mode)
  ctx.resourceDir = TEMP_TEMPLATES;
  invalidateWorkspaceCache();
  _setWorkspaceCacheForTest(ws);
  seedWorkspace();
  await ensureDefaultConfig();

  // Restore resourceDir for subsequent phases
  ctx.resourceDir = TEMP_WS;

  // AGENTS.md should be upgraded
  const newAgents = fs.readFileSync(agentsPath, 'utf-8');
  const verMatch = newAgents.match(/modoroclaw-agents-version:\s*(\d+)/);
  assert(verMatch && parseInt(verMatch[1]) > 1, 'T5.1 AGENTS.md upgraded', 'v' + (verMatch ? verMatch[1] : '?'));

  // Backup should exist
  const learningsDir = path.join(ws, '.learnings');
  const backups = fs.existsSync(learningsDir) ? fs.readdirSync(learningsDir).filter(f => f.startsWith('AGENTS-backup')) : [];
  assert(backups.length > 0, 'T5.2 AGENTS.md backup created', backups[0] || 'none');

  // User data must survive the update
  assert(readJson(blocklistPath)?.length === 3, 'T5.3 blocklist survived update');
  assert(readJson(gsPath)?.group_abc?.mode === 'mention', 'T5.4 group settings survived update');
  assert(readJson(spPath)?.policy === 'reply-once', 'T5.5 stranger policy survived update');
  assert(readJson(ccPath)?.[0]?.id === 'cron1', 'T5.6 custom crons survived update');
  assert(readJson(schedPath)?.find(s => s.id === 'morning')?.enabled === false, 'T5.7 schedules survived update');
  assert(readJson(path.join(ws, 'active-persona.json'))?.greeting === 'Xin chao anh!', 'T5.8 persona survived update');
  assert(fs.readFileSync(path.join(ws, 'COMPANY.md'), 'utf-8').includes('MODORO Tech'), 'T5.9 COMPANY.md survived update');
  assert(fs.readFileSync(path.join(ws, 'IDENTITY.md'), 'utf-8').includes('Peter'), 'T5.10 IDENTITY.md survived update');
  assert(fs.existsSync(path.join(kDir, 'test-doc.txt')), 'T5.11 knowledge file survived update');
  assert(fs.existsSync(path.join(memDir, 'customer123.md')), 'T5.12 memory file survived update');

  // Zalo mode re-applied to fresh AGENTS.md
  const updatedAgents = fs.readFileSync(agentsPath, 'utf-8');
  assert(
    fs.readFileSync(path.join(ws, 'config', 'zalo-mode.txt'), 'utf-8').trim() === 'read',
    'T5.13 zalo-mode.txt preserved'
  );
  // Check if zalo mode was re-injected into AGENTS.md (our fix)
  const hasZaloMode = updatedAgents.includes('Chi doc') || updatedAgents.includes('Chỉ đọc');
  assert(hasZaloMode, 'T5.14 zalo mode re-applied to upgraded AGENTS.md');

  // Config survived update
  const config5 = readJson(path.join(TEMP_OC, 'openclaw.json'));
  assert(config5?.channels?.['modoro-zalo']?.enabled === true, 'T5.15 modoro-zalo.enabled survived update');
  assert(config5?.tools?.allow?.includes('custom_tool'), 'T5.16 custom tool survived update');

  // ============================================================
  //  PHASE 6: Config Schema Healing
  // ============================================================
  console.log('\n\x1b[1m=== PHASE 6: Schema Healing ===\x1b[0m\n');

  // Inject bad keys
  const config6 = readJson(path.join(TEMP_OC, 'openclaw.json'));
  if (config6?.channels?.['modoro-zalo']) {
    config6.channels['modoro-zalo'].streaming = 'off';
    config6.channels['modoro-zalo'].streamMode = 'chunk';
  }
  if (config6?.agents?.defaults) {
    config6.agents.defaults.blockStreaming = true;
  }
  fs.writeFileSync(path.join(TEMP_OC, 'openclaw.json'), JSON.stringify(config6, null, 2) + '\n');

  await ensureDefaultConfig();

  const config6b = readJson(path.join(TEMP_OC, 'openclaw.json'));
  assert(!('streaming' in (config6b?.channels?.['modoro-zalo'] || {})), 'T6.1 streaming stripped from modoro-zalo');
  assert(!('streamMode' in (config6b?.channels?.['modoro-zalo'] || {})), 'T6.2 streamMode stripped from modoro-zalo');
  assert(!('blockStreaming' in (config6b?.agents?.defaults || {})), 'T6.3 blockStreaming stripped from agents.defaults');
  // Verify valid fields NOT stripped
  assert(config6b?.channels?.['modoro-zalo']?.enabled === true, 'T6.4 enabled NOT stripped');
  assert(config6b?.channels?.['modoro-zalo']?.dmPolicy === 'open', 'T6.5 dmPolicy NOT stripped');

  // Verify dangerous tools always stripped
  const config6c = readJson(path.join(TEMP_OC, 'openclaw.json'));
  if (config6c?.tools) {
    config6c.tools.allow = [...(config6c.tools.allow || []), 'exec', 'process', 'cron'];
    fs.writeFileSync(path.join(TEMP_OC, 'openclaw.json'), JSON.stringify(config6c, null, 2) + '\n');
  }
  await ensureDefaultConfig();
  const config6d = readJson(path.join(TEMP_OC, 'openclaw.json'));
  assert(!config6d?.tools?.allow?.includes('exec'), 'T6.6 exec stripped from tools.allow');
  assert(!config6d?.tools?.allow?.includes('process'), 'T6.7 process stripped from tools.allow');
  assert(!config6d?.tools?.allow?.includes('cron'), 'T6.8 cron stripped from tools.allow');
  assert(config6d?.tools?.allow?.includes('custom_tool'), 'T6.9 custom_tool preserved after dangerous strip');

  // ============================================================
  //  RESULTS
  // ============================================================
  console.log('\n\x1b[1m=== RESULTS ===\x1b[0m\n');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total:  ${passed + failed}\n`);

  // Cleanup
  try { fs.rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch {}

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('\n\x1b[31mFATAL:\x1b[0m', e);
  try { fs.rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch {}
  process.exit(2);
});
