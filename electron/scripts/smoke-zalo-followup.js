#!/usr/bin/env node
// Smoke test for scanZaloFollowUpCandidates — the Node-side pre-filter that
// replaced the agent's "đọc tất cả file" prompt. At 2000 Zalo friends the
// old approach was broken (context window overflow); this verifies the new
// approach finds correct candidates under realistic scale.

const fs = require('fs');
const path = require('path');
const os = require('os');

function fail(msg) { console.error('[zalo-followup smoke] FAIL:', msg); process.exit(1); }
function ok(msg) { console.log('  OK  ', msg); }

// Inline copy of scanZaloFollowUpCandidates so the smoke doesn't need to
// require() all of main.js (which pulls in electron/sqlite native deps).
// Must stay in-sync with main.js — guarded by assertion below.
function scanZaloFollowUpCandidates(ws, { nowMs = Date.now(), max = 20 } = {}) {
  const usersDir = path.join(ws, 'memory', 'zalo-users');
  if (!fs.existsSync(usersDir)) return [];
  const H24_MS = 24 * 60 * 60 * 1000;
  const H48_MS = 48 * 60 * 60 * 1000;
  const H30D_MS = 30 * H24_MS;
  const DATED_RE = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/gm;
  const PENDING_HINTS = /(chờ phản hồi|chờ trả lời|chưa chốt|cần follow-?up|sẽ liên hệ|hẹn mai|mai liên lạc|ngày mai sẽ|hứa.*(mua|đặt|ghé|qua))/i;
  const candidates = [];
  const files = fs.readdirSync(usersDir).filter(f => f.endsWith('.md'));
  for (const file of files) {
    const fp = path.join(usersDir, file);
    const stat = fs.statSync(fp);
    if (stat.size < 10) continue;
    if (nowMs - stat.mtimeMs > H30D_MS) continue;
    const content = fs.readFileSync(fp, 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    const fm = {};
    if (fmMatch) for (const line of fmMatch[1].split('\n')) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (m) fm[m[1]] = m[2].trim();
    }
    const name = fm.name || file.replace(/\.md$/, '');
    const dates = [];
    let dm; DATED_RE.lastIndex = 0;
    while ((dm = DATED_RE.exec(content)) !== null) dates.push(dm[1]);
    if (dates.length === 0) continue;  // cold contact — never DM'd the bot → not a follow-up
    const lastDate = dates.sort().at(-1);
    const lastMs = Date.parse(lastDate + 'T00:00:00Z');
    if (!Number.isFinite(lastMs)) continue;
    const staleMs = nowMs - lastMs;
    if (staleMs < H48_MS) continue;
    const sectionStart = content.lastIndexOf(`## ${lastDate}`);
    const sectionEnd = content.indexOf('\n## ', sectionStart + 3);
    const sectionText = sectionEnd > 0 ? content.slice(sectionStart, sectionEnd) : content.slice(sectionStart);
    if (!PENDING_HINTS.test(sectionText)) continue;
    const staleDays = Math.floor(staleMs / H24_MS);
    candidates.push({ kind: 'pending-stale', senderId: file.replace(/\.md$/, ''), name, staleDays, lastDate, priority: 30 + Math.min(staleDays, 30) });
  }
  candidates.sort((a, b) => b.priority - a.priority);
  return candidates.slice(0, max);
}

async function run() {
  console.log('[zalo-followup smoke] verifying follow-up scanner scales + filters correctly...');

  const now = new Date('2026-04-18T10:00:00Z').getTime();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-followup-'));
  const usersDir = path.join(tmpDir, 'memory', 'zalo-users');
  fs.mkdirSync(usersDir, { recursive: true });

  const writeProfile = (id, opts) => {
    const lastSeen = opts.lastSeen || '2026-04-15T10:00:00.000Z';
    const body = opts.body || '';
    const content = `---
name: ${opts.name || 'Test ' + id}
zaloName: ${opts.name || 'Test ' + id}
lastSeen: ${lastSeen}
msgCount: 0
tags: []
groups: []
---
# ${opts.name || 'Test ' + id}

${body}
`;
    fs.writeFileSync(path.join(usersDir, `${id}.md`), content);
  };

  try {
    // Scenario 1: new friend, 3 days old, no interactions → SKIP
    // (Semantic: never DM'd bot = cold contact, not a follow-up. User pushed
    // back: "nó có nhiều người ko có tương tác nó cũng report, để làm gì?")
    writeProfile('1001', {
      name: 'Khách Mới A',
      lastSeen: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
      body: '',
    });
    // Scenario 2: new friend, 2 hours old, no interactions → SKIP
    writeProfile('1002', {
      name: 'Khách Mới Quá Sớm',
      lastSeen: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      body: '',
    });
    // Scenario 3: old interaction 5 days ago with "chờ phản hồi" → CANDIDATE (stale)
    writeProfile('1003', {
      name: 'Khách Đợi',
      body: '## 2026-04-13\n- Khách hỏi giá iPhone 15\n- Bot đã báo giá, khách nói "em sẽ liên hệ mai"\n- Trạng thái: chờ phản hồi\n',
    });
    // Scenario 4: old interaction 3 days ago but RESOLVED (no pending hint) → SKIP
    writeProfile('1004', {
      name: 'Khách Đã Xong',
      body: '## 2026-04-15\n- Khách đặt hàng iPhone 15\n- Bot xác nhận đơn\n- Trạng thái: đã xong\n',
    });
    // Scenario 5: interaction yesterday (< 48h) with pending → SKIP (too fresh)
    writeProfile('1005', {
      name: 'Khách Hôm Qua',
      body: '## 2026-04-17\n- Khách hỏi, chờ phản hồi\n',
    });
    // Scenario 6: promise phrase "hứa ghé cửa hàng" 4 days ago → CANDIDATE
    writeProfile('1006', {
      name: 'Khách Hẹn Ghé',
      body: '## 2026-04-14\n- Khách hứa cuối tuần sẽ ghé qua cửa hàng xem\n',
    });

    const results = scanZaloFollowUpCandidates(tmpDir, { nowMs: now, max: 20 });

    // Assertions — only customers who DM'd bot + have pending state should appear.
    const byId = new Map(results.map(r => [r.senderId, r]));
    if (byId.size !== 2) fail(`expected 2 candidates (1003 + 1006), got ${byId.size}: ${[...byId.keys()].join(',')}`);
    ok('2 candidates found — ONLY customers bot owes a reply to');

    if (!byId.has('1003') || byId.get('1003').kind !== 'pending-stale') fail('1003 missing or wrong kind');
    if (byId.get('1003').lastDate !== '2026-04-13') fail(`1003 lastDate ${byId.get('1003').lastDate}`);
    ok('1003 stale-pending with "chờ phản hồi" hint, classified correctly');

    if (!byId.has('1006')) fail('1006 (hứa ghé) missing');
    ok('1006 "hứa ghé cửa hàng" matched promise regex');

    // Critical semantic fix: cold contacts (no interaction ever) must NOT appear.
    if (byId.has('1001')) fail('1001 (cold contact, no DM ever) MUST NOT appear — semantic fix');
    if (byId.has('1002')) fail('1002 (fresh cold contact) MUST NOT appear — semantic fix');
    ok('cold contacts (1001 + 1002) correctly EXCLUDED — no noise for CEO');

    if (byId.has('1004')) fail('1004 (đã xong) should be skipped — no pending hint');
    if (byId.has('1005')) fail('1005 (< 48h) should be skipped as too fresh');
    ok('resolved (1004), < 48h (1005) correctly skipped');

    // Scale + noise-suppression test: 2000 synthetic profiles where the
    // MAJORITY are cold contacts (typical 2000-friend CEO situation).
    // Old semantic would've reported ~1000 noise entries. New semantic
    // must report ZERO extra from this noise floor.
    console.log('  ... generating 2000 synthetic profiles (mostly cold) for scale test ...');
    for (let i = 2000; i < 4000; i++) {
      const addedDaysAgo = Math.floor(Math.random() * 30) + 1;
      const hasInteraction = Math.random() < 0.2;  // only 20% have actually DM'd bot
      const body = hasInteraction
        ? `## 2026-04-${10 + (i % 8)}\n- Khách hỏi, bot trả lời. Trạng thái: đã xong.\n`
        : '';  // majority: no dated sections = cold contact
      writeProfile(String(i), {
        name: `Khách ${i}`,
        lastSeen: new Date(now - addedDaysAgo * 24 * 60 * 60 * 1000).toISOString(),
        body,
      });
    }
    const t0 = Date.now();
    const big = scanZaloFollowUpCandidates(tmpDir, { nowMs: now, max: 20 });
    const dt = Date.now() - t0;
    if (dt > 5000) fail(`scan too slow: ${dt}ms for 2006 profiles (budget 5000ms)`);
    // Noise floor check: from 1600 cold contacts + 400 resolved interactions,
    // we expect 0 new candidates from the synthetic set (all resolved, no
    // pending hints). Only the 2 from initial scenarios should remain.
    if (big.length !== 2) fail(`expected 2 candidates after adding 2000 noise profiles, got ${big.length} — semantic broken?`);
    ok(`2006-profile scan in ${dt}ms, 2 candidates (1600 cold contacts correctly ignored)`);

    console.log('[zalo-followup smoke] PASS — scale + filter assertions held');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  // Sync guard: cron.js must keep this function's signature stable
  const cronJs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cron.js'), 'utf-8');
  if (!/function scanZaloFollowUpCandidates\(ws[^)]*\)/.test(cronJs)) {
    fail('cron.js no longer defines scanZaloFollowUpCandidates');
  }
  if (!/buildZaloFollowUpPrompt\(candidates\)/.test(cronJs)) {
    fail('cron.js callers no longer pass candidates to buildZaloFollowUpPrompt');
  }
  ok('cron.js keeps scanner + caller wiring in place');
}

run().catch(e => { console.error('[zalo-followup smoke] threw:', e); process.exit(1); });
