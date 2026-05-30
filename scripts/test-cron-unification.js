#!/usr/bin/env node
'use strict';

/**
 * Pre-implementation verification for cron unification plan (v2.5.0).
 * Tests COMMAND-BLOCK pattern coverage + delivery field parsing.
 *
 * Usage: node scripts/test-cron-unification.js
 * Run BEFORE executing the implementation plan.
 */

const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0, warn = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function bad(label) { fail++; console.error(`  ✗ ${label}`); }
function warning(label) { warn++; console.warn(`  ⚠ ${label}`); }

// ============================================================
// TEST 1: COMMAND-BLOCK patterns — existing + proposed
// ============================================================
console.log('\n=== TEST 1: COMMAND-BLOCK pattern coverage ===\n');

// Current TIER 1 patterns (lines 722-761 in inbound.ts)
const existingPatterns = [
  /(?:tạo|thêm|sửa|xóa|dừng|tắt|bật|liệt kê|list)\s+cron\b/i,
  /(?:tao|them|sua|xoa|dung|tat|bat|liet ke|list)\s+cron\b/i,
  /\b(create|add|delete|remove|stop|start|list|show)\s+cron\b/i,
  /\b(?:schedule|set\s*up|make)\s+(?:a\s+)?cron\b/i,
  /(?:đặt|tạo|lập|hẹn)\s+(?:lịch|giờ)\s+(?:gửi|nhắn|phát)/i,
  /(?:dat|tao|lap|hen)\s+(?:lich|gio)\s+(?:gui|nhan|phat)/i,
  /(?:tự\s+động|tu\s+dong)\s+(?:gửi|gui|nhắn|nhan|phát|phat)/i,
  /(?:lên\s+lịch|len\s+lich)\s+(?:gửi|gui)/i,
];

// Proposed NEW patterns (Task 1.5)
const newPatterns = [
  /\b(?:nhắc|nhac|remind)\s+(?:em|anh|tôi|toi|mình|minh|me).*(?:lúc|luc|giờ|gio|ngày|ngay|sáng|sang|trưa|trua|chiều|chieu|tối|toi|mỗi|moi)/i,
  /\b(?:hẹn|hen)\s+(?:nhắn|nhan|gửi|gui|phát|phat)/i,
  /\b(?:gửi|gui)\s+(?:tin|nhắn|nhan).*(?:mỗi\s+(?:ngày|ngay|giờ|gio)|lúc\s+\d)/i,
  /\b(?:nhắc|nhac|hẹn|hen)\s+(?:giờ|gio|lịch|lich)/i,
];

const allPatterns = [...existingPatterns, ...newPatterns];

function matchesBlock(text) {
  return allPatterns.some(p => p.test(text));
}
function matchesExisting(text) {
  return existingPatterns.some(p => p.test(text));
}
function matchesNew(text) {
  return newPatterns.some(p => p.test(text));
}

// Inputs that SHOULD be blocked (scheduling requests from Zalo strangers)
const shouldBlock = [
  // Explicit cron commands
  'tạo cron gửi nhóm mỗi sáng',
  'create cron for daily report',
  'xóa cron ABC',
  'list cron',
  'đặt lịch gửi tin nhắn mỗi sáng 9h',
  'tự động gửi tin vào nhóm',
  'lên lịch gửi báo cáo',
  // GAP scenarios (should be caught by new patterns)
  'nhắc em lúc 9h sáng mai',
  'nhắc em mỗi ngày lúc 8h',
  'nhac toi luc 3h chieu',
  'hẹn nhắn cho em vào mai',
  'hẹn gửi tin lúc 10h',
  'gửi tin nhắn mỗi ngày lúc 9h',
  'gửi tin lúc 8h sáng mai',
  'nhắc lịch họp tuần sau',
  'hẹn giờ gửi báo cáo',
  'hen lich cuoi tuan',
];

// Inputs that should NOT be blocked (legitimate CS questions)
const shouldNotBlock = [
  'nhắc em về đơn hàng',
  'cho em hỏi về sản phẩm',
  'em muốn đặt hàng',
  'gửi cho em bảng giá',
  'hẹn gặp tuần sau được không',  // no nhắn/gửi/phát after hẹn
  'nhắc em chuyện hôm qua',       // "hôm qua" not a future time
  'giá bao nhiêu',
  'tư vấn cho em',
  'đặt lịch hẹn khám',
  'em cần hỗ trợ',
  'xin chào',
  'sản phẩm còn hàng không',
  'gửi hình sản phẩm cho em',     // no time indicator
];

console.log('Should BLOCK (scheduling requests):');
for (const input of shouldBlock) {
  if (matchesBlock(input)) {
    const byNew = !matchesExisting(input) && matchesNew(input);
    ok(`BLOCKED: "${input}"${byNew ? ' (new pattern)' : ''}`);
  } else {
    bad(`NOT BLOCKED: "${input}" — GAP!`);
  }
}

console.log('\nShould NOT block (legitimate CS):');
for (const input of shouldNotBlock) {
  if (matchesBlock(input)) {
    bad(`FALSE POSITIVE: "${input}" — would block legitimate question`);
  } else {
    ok(`PASS: "${input}"`);
  }
}

// Known gaps (accepted risk — Zalo is Vietnamese-only, English scheduling on Zalo is near-impossible)
const knownGaps = [
  'remind me at 9am tomorrow',
];
console.log('\nKnown gaps (accepted risk — AGENTS.md provides backup):');
for (const input of knownGaps) {
  if (matchesBlock(input)) {
    ok(`BLOCKED (unexpectedly): "${input}"`);
  } else {
    warning(`NOT BLOCKED (accepted): "${input}" — English scheduling on Zalo platform, AGENTS.md catches this`);
  }
}

// ============================================================
// TEST 2: Delivery field parsing (Task 5 logic)
// ============================================================
console.log('\n=== TEST 2: Delivery field parsing (jobs.json → zaloTarget) ===\n');

function parseDelivery(j) {
  const ch = (j.delivery?.channel || '').toLowerCase();
  const rawTo = j.delivery?.to || '';
  const bareId = rawTo.includes(':') ? rawTo.split(':').slice(1).join(':') : rawTo;
  const isZalo = ch.startsWith('zalo');
  const isGroup = isZalo && (ch === 'zalogroup' || ch === 'zalo_group');
  const tz = j.schedule?.tz || '';
  return {
    zaloTarget: isZalo && bareId ? { id: bareId, isGroup, label: j.name || bareId } : undefined,
    groupId: isGroup && bareId ? bareId : undefined,
    telegramTarget: ch === 'telegram' && bareId ? bareId : undefined,
    tz: tz || undefined,
  };
}

// Test cases based on real template format
const deliveryTests = [
  {
    name: 'Zalo DM (template format: zalouser:<ID>)',
    input: { name: 'Daily report', delivery: { channel: 'zalouser', to: 'zalouser:123456789' }, schedule: { tz: 'Asia/Saigon' } },
    expected: { zaloTarget: { id: '123456789', isGroup: false }, groupId: undefined, telegramTarget: undefined, tz: 'Asia/Saigon' },
  },
  {
    name: 'Zalo group (expected: zalogroup:<ID>)',
    input: { name: 'Group update', delivery: { channel: 'zalogroup', to: 'zalogroup:987654321' }, schedule: { tz: 'Asia/Ho_Chi_Minh' } },
    expected: { zaloTarget: { id: '987654321', isGroup: true }, groupId: '987654321', telegramTarget: undefined, tz: 'Asia/Ho_Chi_Minh' },
  },
  {
    name: 'Telegram channel',
    input: { name: 'CEO alert', delivery: { channel: 'telegram', to: 'telegram:111222333' }, schedule: {} },
    expected: { zaloTarget: undefined, groupId: undefined, telegramTarget: '111222333', tz: undefined },
  },
  {
    name: 'No delivery field (Telegram default)',
    input: { name: 'Simple cron', schedule: {} },
    expected: { zaloTarget: undefined, groupId: undefined, telegramTarget: undefined, tz: undefined },
  },
  {
    name: 'Bare ID (no prefix)',
    input: { name: 'Bare Zalo', delivery: { channel: 'zalouser', to: '555666777' }, schedule: {} },
    expected: { zaloTarget: { id: '555666777', isGroup: false }, groupId: undefined, telegramTarget: undefined, tz: undefined },
  },
  {
    name: 'MODOROClaw format (zalo_group)',
    input: { name: 'Alt format', delivery: { channel: 'zalo_group', to: '888999000' }, schedule: {} },
    expected: { zaloTarget: { id: '888999000', isGroup: true }, groupId: '888999000', telegramTarget: undefined, tz: undefined },
  },
  {
    name: 'Bare Telegram ID (no prefix)',
    input: { name: 'Bare TG', delivery: { channel: 'telegram', to: '444555666' }, schedule: {} },
    expected: { zaloTarget: undefined, groupId: undefined, telegramTarget: '444555666', tz: undefined },
  },
];

for (const t of deliveryTests) {
  const result = parseDelivery(t.input);
  const checks = [];

  // Check zaloTarget
  if (t.expected.zaloTarget === undefined) {
    if (result.zaloTarget !== undefined) checks.push(`zaloTarget: expected undefined, got ${JSON.stringify(result.zaloTarget)}`);
  } else {
    if (!result.zaloTarget) checks.push('zaloTarget: expected object, got undefined');
    else {
      if (result.zaloTarget.id !== t.expected.zaloTarget.id) checks.push(`zaloTarget.id: expected "${t.expected.zaloTarget.id}", got "${result.zaloTarget.id}"`);
      if (result.zaloTarget.isGroup !== t.expected.zaloTarget.isGroup) checks.push(`zaloTarget.isGroup: expected ${t.expected.zaloTarget.isGroup}, got ${result.zaloTarget.isGroup}`);
    }
  }

  // Check groupId
  if (result.groupId !== t.expected.groupId) checks.push(`groupId: expected ${JSON.stringify(t.expected.groupId)}, got ${JSON.stringify(result.groupId)}`);

  // Check telegramTarget
  if (result.telegramTarget !== t.expected.telegramTarget) checks.push(`telegramTarget: expected ${JSON.stringify(t.expected.telegramTarget)}, got ${JSON.stringify(result.telegramTarget)}`);

  // Check tz
  if (result.tz !== t.expected.tz) checks.push(`tz: expected ${JSON.stringify(t.expected.tz)}, got ${JSON.stringify(result.tz)}`);

  if (checks.length === 0) {
    ok(t.name);
  } else {
    bad(`${t.name}: ${checks.join('; ')}`);
  }
}

// ============================================================
// TEST 3: config.js REQUIRED_TOOLS / BANNED_TOOLS state
// ============================================================
console.log('\n=== TEST 3: Current config.js tool arrays (pre-change baseline) ===\n');

const configSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'lib', 'config.js'), 'utf-8');

const reqMatch = configSrc.match(/REQUIRED_TOOLS\s*=\s*\[([^\]]+)\]/);
const banMatch = configSrc.match(/BANNED_TOOLS\s*=\s*\[([^\]]+)\]/);

if (!reqMatch) bad('REQUIRED_TOOLS array not found');
else ok(`REQUIRED_TOOLS found`);

if (!banMatch) bad('BANNED_TOOLS array not found');
else ok(`BANNED_TOOLS found`);

if (reqMatch && banMatch) {
  const reqStr = reqMatch[1];
  const banStr = banMatch[1];
  if (banStr.includes("'cron'")) ok('cron is currently in BANNED_TOOLS (will be moved)');
  else bad('cron is NOT in BANNED_TOOLS — already moved?');
  if (!reqStr.includes("'cron'")) ok('cron is NOT yet in REQUIRED_TOOLS (will be added)');
  else warning('cron is already in REQUIRED_TOOLS');
  if (banStr.includes("'process'")) ok('process is in BANNED_TOOLS (stays)');
  else bad('process is NOT in BANNED_TOOLS — security issue');
}

// ============================================================
// TEST 4: Template file format verification
// ============================================================
console.log('\n=== TEST 4: Template jobs.json field verification ===\n');

const templatePath = path.join(__dirname, '..', 'release-zalo-v2.0.0', 'docs', 'cron.jobs.template.json');
if (!fs.existsSync(templatePath)) {
  warning('Template file not found — skipping');
} else {
  const template = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
  const jobs = template.jobs || [];
  if (jobs.length === 0) {
    warning('Template has no jobs');
  } else {
    const j = jobs[0];
    // Verify field paths exist
    if (j.schedule?.kind) ok(`schedule.kind: "${j.schedule.kind}"`);
    else warning('schedule.kind missing');
    if (j.schedule?.expr) ok(`schedule.expr: "${j.schedule.expr}"`);
    else bad('schedule.expr missing');
    if (j.schedule?.tz) ok(`schedule.tz: "${j.schedule.tz}"`);
    else warning('schedule.tz missing');
    if (j.payload?.message) ok(`payload.message exists (${j.payload.message.length} chars)`);
    else bad('payload.message missing');
    if (j.delivery?.channel) ok(`delivery.channel: "${j.delivery.channel}"`);
    else bad('delivery.channel missing');
    if (j.delivery?.to) ok(`delivery.to: "${j.delivery.to}"`);
    else bad('delivery.to missing');
    if (j.delivery?.mode !== undefined) ok(`delivery.mode: "${j.delivery.mode}"`);
    else warning('delivery.mode missing');

    // Test our parser against template data
    const parsed = parseDelivery(j);
    if (parsed.zaloTarget) {
      ok(`Template parsed → zaloTarget.id: "${parsed.zaloTarget.id}", isGroup: ${parsed.zaloTarget.isGroup}`);
    } else if (parsed.telegramTarget) {
      ok(`Template parsed → telegramTarget: "${parsed.telegramTarget}"`);
    } else {
      warning('Template parsed → no target (delivery.mode may be "none")');
    }
    if (parsed.tz) ok(`Template parsed → tz: "${parsed.tz}"`);
  }
}

// ============================================================
// TEST 5: Existing loadCustomCrons line numbers
// ============================================================
console.log('\n=== TEST 5: cron.js line verification ===\n');

const cronSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'lib', 'cron.js'), 'utf-8');
const cronLines = cronSrc.split('\n');

// Check that line 1623 is where we think the push is
const pushLine = cronLines[1622]; // 0-indexed
if (pushLine && pushLine.includes('openclawEntries.push({')) {
  ok(`Line 1623: openclawEntries.push (correct target)`);
} else {
  bad(`Line 1623: expected "openclawEntries.push", got "${(pushLine || '').trim().slice(0, 60)}"`);
}

const endLine = cronLines[1629]; // line 1630 in 1-indexed
if (endLine && endLine.includes('});')) {
  ok(`Line 1630: closing brace (correct range)`);
} else {
  bad(`Line 1630: expected "})", got "${(endLine || '').trim().slice(0, 60)}"`);
}

// Check scheduler uses c.zaloTarget
const zaloTargetDispatch = cronSrc.includes('zaloTarget: c.zaloTarget');
if (zaloTargetDispatch) ok('Scheduler passes c.zaloTarget to runCronAgentPrompt');
else bad('Scheduler does NOT pass c.zaloTarget — chain broken');

// ============================================================
// TEST 6: Smoke test line verification
// ============================================================
console.log('\n=== TEST 6: smoke-test.js line verification ===\n');

const smokeSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'scripts', 'smoke-test.js'), 'utf-8');
const smokeLines = smokeSrc.split('\n');

// Check that TEST 19 is around line 1661
const test19Line = smokeLines.findIndex(l => l.includes('TEST 19'));
if (test19Line >= 0) {
  ok(`TEST 19 found at line ${test19Line + 1}`);
  if (test19Line + 1 >= 1655 && test19Line + 1 <= 1675) {
    ok(`TEST 19 line ${test19Line + 1} is within expected range (1655-1675)`);
  } else {
    warning(`TEST 19 at line ${test19Line + 1} — plan says ~1661, may need line number adjustment`);
  }
} else {
  bad('TEST 19 not found in smoke-test.js');
}

// ============================================================
// SUMMARY
// ============================================================
console.log(`\n${'='.repeat(50)}`);
console.log(`RESULTS: ${pass} passed, ${fail} failed, ${warn} warnings`);
console.log(`${'='.repeat(50)}\n`);

if (fail > 0) {
  console.error('FAILURES DETECTED — fix before executing plan.');
  process.exit(1);
}
if (warn > 0) {
  console.log('Warnings present — review before proceeding.');
}
process.exit(0);
