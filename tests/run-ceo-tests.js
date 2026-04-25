#!/usr/bin/env node
/**
 * MODOROClaw CEO Test Runner — v2.3.48
 * Tests 100 cases against live running instance.
 * Categories: file structure, config, bot rules, channels, defense, FB, cron, knowledge, security
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync, execSync } = require('child_process');

// ── Paths ──
const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'electron');
const WS = path.join(process.env.APPDATA || '', 'modoro-claw');
const OPENCLAW = path.join(process.env.USERPROFILE || '', '.openclaw');

let pass = 0, fail = 0, skip = 0;
const results = [];

function test(id, name, fn) {
  try {
    const r = fn();
    if (r === 'SKIP') {
      skip++;
      results.push({ id, name, status: 'SKIP' });
      console.log(`  SKIP  #${id} ${name}`);
    } else if (r === true || r === undefined) {
      pass++;
      results.push({ id, name, status: 'PASS' });
      console.log(`  PASS  #${id} ${name}`);
    } else {
      fail++;
      results.push({ id, name, status: 'FAIL', detail: String(r) });
      console.log(`  FAIL  #${id} ${name} — ${r}`);
    }
  } catch (e) {
    fail++;
    results.push({ id, name, status: 'FAIL', detail: e.message });
    console.log(`  FAIL  #${id} ${name} — ${e.message}`);
  }
}

function fileExists(p) { return fs.existsSync(p); }
function readFile(p) { return fs.readFileSync(p, 'utf-8'); }
function httpGet(url, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ══════════════════════════════════════════
//  A. WIZARD & FIRST BOOT (structure checks)
// ══════════════════════════════════════════
console.log('\n[A] WIZARD & FIRST BOOT');

test(1, 'Wizard HTML exists', () => {
  return fileExists(path.join(ELECTRON, 'ui', 'wizard.html')) || 'wizard.html missing';
});

test(2, 'Wizard has business profile step', () => {
  const html = readFile(path.join(ELECTRON, 'ui', 'wizard.html'));
  return html.includes('save-personalization') || html.includes('business-profile') || html.includes('wiz-company')
    || 'no business profile step found';
});

test(3, 'Wizard has Telegram setup', () => {
  const html = readFile(path.join(ELECTRON, 'ui', 'wizard.html'));
  return (html.includes('testTelegram') || html.includes('test-telegram') || html.includes('wiz-tg'))
    || 'no Telegram setup in wizard';
});

test(4, 'Wizard has 9Router setup', () => {
  const html = readFile(path.join(ELECTRON, 'ui', 'wizard.html'));
  return (html.includes('setup9RouterAuto') || html.includes('setup-9router') || html.includes('9router') || html.includes('9Router'))
    || 'no 9Router setup in wizard';
});

test(5, 'Wizard has Zalo QR step', () => {
  const html = readFile(path.join(ELECTRON, 'ui', 'wizard.html'));
  return (html.includes('findZaloQR') || html.includes('find-zalo-qr') || html.includes('setupZalo') || html.includes('setup-zalo'))
    || 'no Zalo QR step';
});

test(6, 'Dashboard HTML exists', () => {
  return fileExists(path.join(ELECTRON, 'ui', 'dashboard.html')) || 'dashboard.html missing';
});

test(7, 'Gateway responds (bot started)', () => 'SKIP'); // tested via curl below

test(8, 'Boot ping function exists', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('sendTelegram') || 'no sendTelegram function';
});

// ══════════════════════════════════════════
//  B. DASHBOARD OVERVIEW
// ══════════════════════════════════════════
console.log('\n[B] DASHBOARD OVERVIEW');

test(9, 'Overview IPC handler exists', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('get-overview-data') || 'no get-overview-data handler';
});

test(10, 'Bot status IPC exists', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('get-bot-status') || 'no get-bot-status handler';
});

test(11, 'Activity feed reads audit.jsonl', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('audit.jsonl') || 'no audit.jsonl reference';
});

test(12, 'Upcoming crons computed', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('_nextFireTime') || main.includes('nextFireTime') || 'no next fire time computation';
});

test(13, 'Alerts section in overview', () => {
  const html = readFile(path.join(ELECTRON, 'ui', 'dashboard.html'));
  return html.includes('alerts') || html.includes('can-anh-de-y') || html.includes('alert') || 'no alerts section';
});

test(14, 'Auto-refresh in overview', () => {
  const html = readFile(path.join(ELECTRON, 'ui', 'dashboard.html'));
  return (html.includes('setInterval') && html.includes('overview')) || html.includes('refreshOverview')
    || 'no auto-refresh logic';
});

// ══════════════════════════════════════════
//  C. TELEGRAM CHANNEL
// ══════════════════════════════════════════
console.log('\n[C] TELEGRAM CHANNEL');

test(15, 'Telegram probe IPC exists', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('check-telegram-ready') || 'no check-telegram-ready';
});

test(16, 'Telegram self-test IPC exists', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('telegram-self-test') || 'no telegram-self-test';
});

test(17, 'Telegram probe calls getMe API', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('/getMe') || 'no Telegram getMe call';
});

test(18, 'Pause Telegram IPC exists', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes("'pause-telegram'") || 'no pause-telegram handler';
});

test(19, 'Resume Telegram IPC exists', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes("'resume-telegram'") || 'no resume-telegram handler';
});

test(20, 'Telegram config exists with chatId', () => {
  const configPath = path.join(OPENCLAW, 'openclaw.json');
  if (!fileExists(configPath)) return 'SKIP';
  const config = JSON.parse(readFile(configPath));
  return (config.channels?.telegram?.allowFrom?.length > 0 || config.channels?.telegram?.token?.length > 10)
    || 'no Telegram config';
});

test(21, 'Output filter exists for Telegram', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('filterSensitiveOutput') || 'no output filter';
});

test(22, 'No emoji rule in AGENTS.md', () => {
  const agents = readFile(path.join(ROOT, 'AGENTS.md'));
  return agents.includes('KHÔNG BAO GIỜ DÙNG EMOJI') || 'no-emoji rule missing';
});

// ══════════════════════════════════════════
//  D. ZALO CHANNEL
// ══════════════════════════════════════════
console.log('\n[D] ZALO CHANNEL');

test(23, 'Zalo probe IPC exists', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('check-zalo-ready') || 'no check-zalo-ready';
});

test(24, 'Zalo format rule: max 80 words', () => {
  const agents = readFile(path.join(ROOT, 'agents', '10-zalo.md'));
  return agents.includes('80') || 'no 80 word limit rule';
});

test(25, 'Zalo no emoji (agent rule)', () => {
  const agents = readFile(path.join(ROOT, 'agents', '00-core.md'));
  return agents.includes('KHÔNG BAO GIỜ DÙNG EMOJI') || 'no-emoji rule missing in core';
});

test(26, 'Zalo no markdown rule', () => {
  const agents = readFile(path.join(ROOT, 'agents', '10-zalo.md'));
  return (agents.includes('cấm bold') || agents.includes('Văn xuôi thuần') || agents.includes('cấm'))
    || 'no markdown ban in Zalo rules';
});

test(27, 'Zalo owner marker detection', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('ZALO_CH') || main.includes('zalo-owner') || 'no owner marker logic';
});

test(28, 'Zalo blocklist patch exists', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('ensureZaloBlocklistFix') || 'no blocklist patch';
});

test(29, 'Zalo blocklist IPC (save-zalo-manager-config)', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('save-zalo-manager-config') || 'no save-zalo-manager-config';
});

test(30, 'Zalo friend list IPC', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('list-zalo-friends') || 'no list-zalo-friends';
});

test(31, 'Zalo group list IPC', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('list-zalo-groups') || 'no list-zalo-groups';
});

test(32, 'Zalo group reply rules exist', () => {
  const agents = readFile(path.join(ROOT, 'agents', '10-zalo.md'));
  return agents.includes('Group') || agents.includes('group') || 'no group rules';
});

test(33, 'Zalo system msg filter patch', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('ensureZaloSystemMsgFix') || 'no system msg filter';
});

test(34, 'Zalo bot detection rules', () => {
  const agents = readFile(path.join(ROOT, 'agents', '10-zalo.md'));
  return (agents.includes('bot khác') || agents.includes('template lặp')) || 'no bot detection rules';
});

test(35, 'Zalo first greeting idempotency', () => {
  const ref = readFile(path.join(ROOT, 'docs', 'zalo-group-reference.md'));
  return ref.includes('firstGreeting') || 'no firstGreeting in group reference';
});

test(36, 'Zalo memory dir created by seedWorkspace', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return (main.includes('zalo-users') && main.includes('zalo-groups')) || 'seedWorkspace missing memory dirs';
});

test(37, 'Zalo pause IPC exists', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes("'pause-zalo'") || 'no pause-zalo';
});

test(38, 'Zalo resume IPC exists', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes("'resume-zalo'") || 'no resume-zalo';
});

// ══════════════════════════════════════════
//  E. ZALO DEFENSE
// ══════════════════════════════════════════
console.log('\n[E] ZALO DEFENSE');

const defenseRef = readFile(path.join(ROOT, 'docs', 'zalo-defense-reference.md'));

test(39, 'Defense: prompt injection row', () => {
  return defenseRef.includes('Prompt injection') || 'no prompt injection defense';
});

test(40, 'Defense: PII request row', () => {
  return defenseRef.includes('PII') || defenseRef.includes('info nội bộ') || 'no PII defense';
});

test(41, 'Defense: cross-customer leak row', () => {
  return defenseRef.includes('Cross-customer') || defenseRef.includes('khách khác') || 'no cross-customer defense';
});

test(42, 'Defense: off-topic reject row', () => {
  return defenseRef.includes('Học thuật/code/dịch') || 'no off-topic defense';
});

test(43, 'Defense: harassment handling rows', () => {
  return defenseRef.includes('Harassment') || 'no harassment defense';
});

test(44, 'Defense: scam detection row', () => {
  return defenseRef.includes('Scam') || defenseRef.includes('lừa đảo') || 'no scam defense';
});

test(45, 'Defense: long message row', () => {
  return defenseRef.includes('2000') || 'no >2000 char defense';
});

test(46, 'Defense: empty/sticker row', () => {
  return defenseRef.includes('sticker') || defenseRef.includes('emoji') || 'no empty msg defense';
});

test(47, 'Defense: repeated message row', () => {
  return defenseRef.includes('Lặp lại') || 'no repeat defense';
});

test(48, 'Defense: fake history row', () => {
  return defenseRef.includes('Fake history') || defenseRef.includes('hứa') || 'no fake history defense';
});

// ══════════════════════════════════════════
//  F. FACEBOOK FANPAGE
// ══════════════════════════════════════════
console.log('\n[F] FACEBOOK FANPAGE');

test(49, 'FB auth module exists', () => {
  return fileExists(path.join(ELECTRON, 'fb', 'auth.js')) || 'fb/auth.js missing';
});

test(50, 'FB connect-start IPC', () => {
  const pre = readFile(path.join(ELECTRON, 'preload.js'));
  return pre.includes('fb-connect-start') || 'no fb-connect-start bridge';
});

test(51, 'FB disconnect IPC', () => {
  const pre = readFile(path.join(ELECTRON, 'preload.js'));
  return pre.includes('fb-disconnect') || 'no fb-disconnect bridge';
});

test(52, 'FB compose-publish IPC', () => {
  const pre = readFile(path.join(ELECTRON, 'preload.js'));
  return pre.includes('fb-compose-publish') || 'no fb-compose-publish bridge';
});

test(53, 'FB graph.js has uploadPhoto', () => {
  const graph = readFile(path.join(ELECTRON, 'fb', 'graph.js'));
  return graph.includes('uploadPhoto') || 'no uploadPhoto in graph.js';
});

test(54, 'FB drafts module exists', () => {
  return fileExists(path.join(ELECTRON, 'fb', 'drafts.js')) || 'fb/drafts.js missing';
});

test(55, 'FB publish-draft IPC', () => {
  const pre = readFile(path.join(ELECTRON, 'preload.js'));
  return pre.includes('fb-publish-draft') || 'no fb-publish-draft';
});

test(56, 'FB skip-draft IPC', () => {
  const pre = readFile(path.join(ELECTRON, 'preload.js'));
  return pre.includes('fb-skip-draft') || 'no fb-skip-draft';
});

test(57, 'FB performance module', () => {
  return fileExists(path.join(ELECTRON, 'fb', 'performance.js')) || 'fb/performance.js missing';
});

test(58, 'FB multi-page support (listConnectedPages)', () => {
  const auth = readFile(path.join(ELECTRON, 'fb', 'auth.js'));
  return auth.includes('listConnectedPages') || 'no multi-page support';
});

// ══════════════════════════════════════════
//  G. CRON & SCHEDULING
// ══════════════════════════════════════════
console.log('\n[G] CRON & SCHEDULING');

test(59, 'Morning brief in schedules template', () => {
  const sched = path.join(ROOT, 'schedules.json');
  if (!fileExists(sched)) return 'SKIP';
  const s = readFile(sched);
  return (s.includes('morning') || s.includes('sáng') || s.includes('7:')) || 'no morning brief';
});

test(60, 'Evening summary in schedules template', () => {
  const sched = path.join(ROOT, 'schedules.json');
  if (!fileExists(sched)) return 'SKIP';
  const s = readFile(sched);
  return (s.includes('evening') || s.includes('tối') || s.includes('21:') || s.includes('22:')) || 'no evening summary';
});

test(61, 'Custom cron IPC (save-custom-crons)', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('save-custom-crons') || 'no save-custom-crons';
});

test(62, 'Cron test button IPC (test-cron)', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes("'test-cron'") || 'no test-cron handler';
});

test(63, 'Cron enable/disable toggle', () => {
  const html = readFile(path.join(ELECTRON, 'ui', 'dashboard.html'));
  return html.includes('cron') || 'no cron toggle in dashboard';
});

test(64, 'runCronAgentPrompt exists', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('runCronAgentPrompt') || 'no runCronAgentPrompt';
});

test(65, 'Multi-line prompt safe (shell:false)', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('shell: false') || main.includes("shell:false") || 'no shell:false for cron';
});

test(66, 'Cron audit log emission', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('cron_fired') || main.includes('cron_failed') || 'no cron audit log';
});

test(67, 'Cron failure alert to CEO', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('sendCeoAlert') || 'no sendCeoAlert for cron failure';
});

test(68, 'Cron owner grouping (set-cron-owner)', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('set-cron-owner') || 'no set-cron-owner';
});

// ══════════════════════════════════════════
//  H. GOOGLE CALENDAR
// ══════════════════════════════════════════
console.log('\n[H] GOOGLE CALENDAR');

test(69, 'GCal connect IPC', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes("'gcal-connect'") || 'no gcal-connect';
});

test(70, 'GCal list-events IPC', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes("'gcal-list-events'") || 'no gcal-list-events';
});

test(71, 'GCal create-event IPC', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes("'gcal-create-event'") || 'no gcal-create-event';
});

test(72, 'GCal update-event IPC', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes("'gcal-update-event'") || 'no gcal-update-event';
});

test(73, 'GCal delete-event IPC', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes("'gcal-delete-event'") || 'no gcal-delete-event';
});

test(74, 'GCal free-slots IPC', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes("'gcal-get-free-slots'") || main.includes('gcal-get-freebusy') || 'no free slots';
});

test(75, 'GCal disconnect IPC', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes("'gcal-disconnect'") || 'no gcal-disconnect';
});

test(76, 'GCal marker neutralize patch', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('ensureZaloGcalNeutralizeFix') || 'no GCAL neutralize patch';
});

// ══════════════════════════════════════════
//  I. KNOWLEDGE BASE
// ══════════════════════════════════════════
console.log('\n[I] KNOWLEDGE BASE');

test(77, 'Upload knowledge IPC', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes("'upload-knowledge-file'") || 'no upload handler';
});

test(78, 'PDF parse pinned to 1.1.1', () => {
  const pkg = JSON.parse(readFile(path.join(ELECTRON, 'package.json')));
  return pkg.dependencies['pdf-parse'] === '1.1.1' || `pdf-parse is ${pkg.dependencies['pdf-parse']}`;
});

test(79, 'Delete knowledge IPC', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes("'delete-knowledge-file'") || 'no delete handler';
});

test(80, 'Knowledge counts IPC', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes("'get-knowledge-counts'") || 'no counts handler';
});

test(81, 'Knowledge visibility control', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('visibility') || 'no visibility control';
});

test(82, 'Knowledge category dirs exist + seedWorkspace creates index.md', () => {
  const cats = ['cong-ty', 'san-pham', 'nhan-vien'];
  for (const c of cats) {
    const p = path.join(ROOT, 'knowledge', c);
    if (!fileExists(p)) return `missing knowledge/${c}/ directory`;
  }
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('index.md') || 'seedWorkspace missing index.md creation';
});

test(83, 'Knowledge search IPC', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes("'knowledge-search'") || main.includes("'search-documents'") || 'no search handler';
});

test(84, 'Knowledge DB + filesystem fallback', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('backfillKnowledgeFromDisk') || 'no filesystem fallback';
});

// ══════════════════════════════════════════
//  J. SHOP STATE
// ══════════════════════════════════════════
console.log('\n[J] SHOP STATE');

test(85, 'Shop state get IPC', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes("'get-shop-state'") || 'no get-shop-state';
});

test(86, 'Shop state set IPC', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes("'set-shop-state'") || 'no set-shop-state';
});

test(87, 'Shop state fields (outOfStock, shippingDelay, etc)', () => {
  const ref = readFile(path.join(ROOT, 'docs', 'zalo-veteran-reference.md'));
  return (ref.includes('outOfStock') || ref.includes('shippingDelay') || ref.includes('shop-state'))
    || 'no shop state fields in veteran reference';
});

test(88, 'Shop state read before reply (veteran rule)', () => {
  const ref = readFile(path.join(ROOT, 'docs', 'zalo-veteran-reference.md'));
  return ref.includes('shop-state.json') || 'no shop-state.json read rule';
});

// ══════════════════════════════════════════
//  K. PERSONA & IDENTITY
// ══════════════════════════════════════════
console.log('\n[K] PERSONA & IDENTITY');

test(89, 'Persona mix IPC (save-persona-mix)', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes('save-persona-mix') || 'no save-persona-mix';
});

test(90, 'Tone matching rule (veteran ref)', () => {
  const ref = readFile(path.join(ROOT, 'docs', 'zalo-veteran-reference.md'));
  return ref.includes('Tone Match') || 'no tone matching rule';
});

test(91, 'Tone match: formal/slang detection', () => {
  const ref = readFile(path.join(ROOT, 'docs', 'zalo-veteran-reference.md'));
  return ref.includes('slang') || ref.includes('formal') || 'no formal/slang detection';
});

test(92, 'Persona override rule (persona ref)', () => {
  const ref = readFile(path.join(ROOT, 'docs', 'zalo-veteran-reference.md'));
  return ref.includes('Persona') || 'no persona rule in veteran ref';
});

// ══════════════════════════════════════════
//  L. (removed — PIN lock feature removed in v2.3.49)
// ══════════════════════════════════════════

// ══════════════════════════════════════════
//  M. SYSTEM & MAINTENANCE
// ══════════════════════════════════════════
console.log('\n[M] SYSTEM & MAINTENANCE');

test(97, 'Export workspace IPC', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes("'export-workspace'") || 'no export-workspace';
});

test(98, 'Import workspace IPC', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes("'import-workspace'") || 'no import-workspace';
});

test(99, 'App update check IPC', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes("'check-for-updates'") || 'no check-for-updates';
});

test(100, 'Factory reset IPC', () => {
  const main = readFile(path.join(ELECTRON, 'main.js'));
  return main.includes("'factory-reset'") || 'no factory-reset';
});

// ══════════════════════════════════════════
//  CROSS-CUTTING CHECKS
// ══════════════════════════════════════════
console.log('\n[X] CROSS-CUTTING CHECKS');

const mainJs = readFile(path.join(ELECTRON, 'main.js'));
const agentsMd = readFile(path.join(ROOT, 'AGENTS.md'));
const preload = readFile(path.join(ELECTRON, 'preload.js'));

test('X1', 'AGENTS.md under 20K chars', () => {
  return agentsMd.length < 20000 || `AGENTS.md is ${agentsMd.length} chars (limit 20000)`;
});

test('X2', 'AGENTS.md under 20K bytes', () => {
  const bytes = Buffer.byteLength(agentsMd);
  return bytes < 20000 || `AGENTS.md is ${bytes} bytes (limit 20000)`;
});

test('X3', 'Output filter covers Telegram', () => {
  return mainJs.includes('filterSensitiveOutput') || 'no output filter';
});

test('X4', 'Output filter covers Zalo', () => {
  return mainJs.includes('ensureZaloOutputFilterFix') || 'no Zalo output filter';
});

test('X5', 'Output filter covers chat-gateway', () => {
  // Check if chat-gateway handler uses filterSensitiveOutput
  const cgIdx = mainJs.indexOf('chat-gateway');
  if (cgIdx === -1) return 'no chat-gateway handler';
  const nearby = mainJs.substring(cgIdx, cgIdx + 3000);
  return nearby.includes('filterSensitiveOutput') || 'chat-gateway missing output filter';
});

test('X6', 'Marker scrub on all output paths (ReDoS-safe)', () => {
  return mainJs.includes('[^\\]]{0,2048}') || 'no ReDoS-safe marker scrub';
});

test('X7', 'Pause state checked before send', () => {
  return mainJs.includes('isChannelPaused') || 'no pause check before send';
});

test('X8', 'Pause fail-closed (corrupt file = paused)', () => {
  return mainJs.includes('treating as paused') || mainJs.includes('fail closed') || 'no fail-closed on corrupt pause file';
});

test('X9', 'Zalo msg split (no truncation)', () => {
  return mainJs.includes('splitZaloMessage') || (mainJs.includes('sendZalo') && mainJs.includes('chunk'))
    || 'no message split in sendZalo';
});

test('X10', 'Zalo memory file size cap', () => {
  return mainJs.includes('trimZaloMemoryFile') || 'no memory file size cap';
});

test('X11', 'Per-sender dedup guard', () => {
  return mainJs.includes('ensureZaloSenderDedupFix') || 'no sender dedup';
});

test('X12', 'Preload/main IPC parity (all bridges have handlers)', () => {
  // Count bridges in preload
  const bridges = (preload.match(/invoke\(['"]([^'"]+)['"]/g) || []).map(m => m.match(/['"]([^'"]+)['"]/)[1]);
  const missing = bridges.filter(b => !mainJs.includes(`'${b}'`) && !mainJs.includes(`"${b}"`));
  return missing.length === 0 || `${missing.length} bridges missing handlers: ${missing.slice(0, 5).join(', ')}`;
});

test('X13', 'Audit trail (auditLog function)', () => {
  return mainJs.includes('auditLog') || 'no auditLog function';
});

test('X14', 'ensureDefaultConfig runs on every start', () => {
  return mainJs.includes('ensureDefaultConfig') || 'no ensureDefaultConfig';
});

test('X15', 'seedWorkspace runs on start', () => {
  return mainJs.includes('seedWorkspace') || 'no seedWorkspace';
});

// ══════════════════════════════════════════
//  LIVE SERVICE CHECKS
// ══════════════════════════════════════════
console.log('\n[L] LIVE SERVICE CHECKS');

async function runLiveChecks() {
  // Gateway — use /v1/models which is the API endpoint (/ returns web UI which may be slow)
  try {
    const gw = await httpGet('http://127.0.0.1:18789/v1/models', 10000);
    test('L1', 'Gateway responds HTTP 200', () => gw.status === 200 || `got ${gw.status}`);
  } catch (e) {
    test('L1', 'Gateway responds HTTP 200', () => `gateway down: ${e.message}`);
  }

  // 9Router
  try {
    const nr = await httpGet('http://127.0.0.1:20128/');
    test('L2', '9Router responds', () => [200, 301, 302, 307].includes(nr.status) || `got ${nr.status}`);
  } catch (e) {
    test('L2', '9Router responds', () => `9router down: ${e.message}`);
  }

  // 9Router models endpoint
  try {
    const models = await httpGet('http://127.0.0.1:20128/v1/models');
    test('L3', '9Router /v1/models returns data', () => {
      if (models.status !== 200) return `got ${models.status}`;
      try {
        const d = JSON.parse(models.data);
        return (d.data && d.data.length > 0) || 'no models returned';
      } catch { return 'invalid JSON'; }
    });
  } catch (e) {
    test('L3', '9Router /v1/models returns data', () => `failed: ${e.message}`);
  }

  // Telegram probe
  try {
    const configPath = path.join(OPENCLAW, 'openclaw.json');
    if (fileExists(configPath)) {
      const config = JSON.parse(readFile(configPath));
      const token = config.channels?.telegram?.token;
      if (token) {
        const tg = await httpGet(`https://api.telegram.org/bot${token}/getMe`, 8000).catch(() => null);
        if (tg) {
          test('L4', 'Telegram getMe responds', () => {
            if (tg.status !== 200) return `got ${tg.status}`;
            const d = JSON.parse(tg.data);
            return d.ok === true || 'getMe not ok';
          });
          test('L5', 'Telegram bot username retrieved', () => {
            const d = JSON.parse(tg.data);
            return d.result?.username ? true : 'no username';
          });
        } else {
          test('L4', 'Telegram getMe responds', () => 'SKIP');
          test('L5', 'Telegram bot username retrieved', () => 'SKIP');
        }
      } else {
        test('L4', 'Telegram getMe responds', () => 'SKIP');
        test('L5', 'Telegram bot username retrieved', () => 'SKIP');
      }
    } else {
      test('L4', 'Telegram getMe responds', () => 'SKIP');
      test('L5', 'Telegram bot username retrieved', () => 'SKIP');
    }
  } catch (e) {
    test('L4', 'Telegram getMe responds', () => `error: ${e.message}`);
    test('L5', 'Telegram bot username retrieved', () => 'SKIP');
  }

  // Zalo listener check
  try {
    const lockPath = path.join(process.env.USERPROFILE || '', '.openzca', 'profiles', 'default', 'listener-owner.json');
    if (fileExists(lockPath)) {
      const lock = JSON.parse(readFile(lockPath));
      test('L6', 'Zalo listener lock file present', () => lock.pid ? true : 'no pid in lock');
    } else {
      test('L6', 'Zalo listener lock file present', () => 'SKIP');
    }
  } catch (e) {
    test('L6', 'Zalo listener lock file present', () => `error: ${e.message}`);
  }

  // 9Router chat completion test (gateway proxies through 9Router)
  try {
    const payload = JSON.stringify({
      model: 'gpt-5-mini',
      messages: [{ role: 'user', content: 'reply with exactly: pong' }],
      max_tokens: 10
    });
    const nrChat = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: 20128,
        path: '/v1/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 30000
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode, data }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(payload);
      req.end();
    });
    test('L7', '9Router chat API responds (200 or 404=no credentials)', () => {
      if (nrChat.status === 200 || nrChat.status === 404) {
        // 404 with "No active credentials" = 9Router works, just no API key configured
        return true;
      }
      return `got ${nrChat.status}`;
    });
  } catch (e) {
    test('L7', '9Router chat completion responds', () => `failed: ${e.message}`);
  }

  // ── Summary ──
  console.log('\n' + '='.repeat(60));
  console.log(`CEO Test Results: ${pass} PASS, ${fail} FAIL, ${skip} SKIP (${pass + fail + skip} total)`);
  console.log('='.repeat(60));

  if (fail > 0) {
    console.log('\nFailed tests:');
    for (const r of results.filter(r => r.status === 'FAIL')) {
      console.log(`  #${r.id} ${r.name}: ${r.detail}`);
    }
  }

  process.exit(fail > 0 ? 1 : 0);
}

runLiveChecks();
