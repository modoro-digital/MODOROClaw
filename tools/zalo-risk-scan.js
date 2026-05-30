#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function isWorkspaceLike(p) {
  try {
    return p && fs.existsSync(p) && (
      fs.existsSync(path.join(p, 'AGENTS.md'))
      || fs.existsSync(path.join(p, 'memory'))
      || fs.existsSync(path.join(p, 'custom-crons.json'))
    );
  } catch {
    return false;
  }
}

function firstExisting(candidates) {
  for (const p of candidates) {
    if (isWorkspaceLike(p)) return p;
  }
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  return candidates[0];
}

function workspaceRoot() {
  return firstExisting([
    process.env.OPENCLAW_WORKSPACE,
    process.env.CLAW_WORKSPACE,
    process.cwd(),
    path.resolve(__dirname, '..'),
  ].filter(Boolean));
}

function readText(filePath, max = 12000) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    const raw = fs.readFileSync(filePath, 'utf-8');
    return raw.length > max ? raw.slice(-max) : raw;
  } catch {
    return '';
  }
}

function listMd(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(name => name.endsWith('.md'))
      .map(name => {
        const fullPath = path.join(dir, name);
        let stat = null;
        try { stat = fs.statSync(fullPath); } catch {}
        return { name, fullPath, stat };
      })
      .filter(entry => entry.stat && entry.stat.isFile())
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  } catch {
    return [];
  }
}

function field(raw, name) {
  return raw.match(new RegExp('^' + name + ':\\s*(.+)$', 'm'))?.[1]?.trim() || '';
}

function isRecent(ms, hours) {
  return Number.isFinite(ms) && Date.now() - ms <= hours * 60 * 60 * 1000;
}

function scanProfiles(root) {
  const users = listMd(path.join(root, 'memory', 'zalo-users')).slice(0, 300);
  const needsFollowup = [];
  const newContacts = [];
  const complaints = [];
  const stalePending = [];
  const riskRe = /(khiếu nại|phàn nàn|bực|không hài lòng|hoàn tiền|đổi trả|lỗi|hỏng|trễ|chưa nhận|báo sếp|chuyển sếp|chờ phản hồi|pending|follow[- ]?up)/i;
  const pendingRe = /(chờ phản hồi|pending|follow[- ]?up|báo sếp|chuyển sếp|sẽ liên hệ|liên hệ lại)/i;

  for (const entry of users) {
    const raw = readText(entry.fullPath, 5000);
    const name = field(raw, 'name') || entry.name.replace(/\.md$/, '');
    const msgCount = Number(field(raw, 'msgCount') || 0);
    const lastSeenRaw = field(raw, 'lastSeen');
    const lastSeenMs = lastSeenRaw ? new Date(lastSeenRaw).getTime() : entry.stat.mtimeMs;
    const item = { name, msgCount, lastSeenMs };

    if (msgCount > 0 && msgCount <= 3 && isRecent(lastSeenMs, 36)) newContacts.push(item);
    if (pendingRe.test(raw)) {
      needsFollowup.push(item);
      if (!isRecent(lastSeenMs, 24)) stalePending.push(item);
    }
    if (riskRe.test(raw)) complaints.push(item);
  }

  return { totalUsers: users.length, needsFollowup, newContacts, complaints, stalePending };
}

function scanCronRuns(root) {
  const file = path.join(root, 'logs', 'cron-runs.jsonl');
  const raw = readText(file, 30000);
  const failures = [];
  const lines = raw.split(/\r?\n/).filter(Boolean).slice(-200);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry && (entry.phase === 'fail' || entry.phase === 'skip')) {
        failures.push({
          label: entry.label || entry.id || 'cron',
          reason: entry.reason || entry.err || entry.error || entry.phase,
          t: entry.t || '',
        });
      }
    } catch {}
  }
  return failures.slice(-8);
}

function names(items, limit = 5) {
  if (!items.length) return 'Không có';
  return items.slice(0, limit).map(x => x.name).join(', ') + (items.length > limit ? ` và ${items.length - limit} mục khác` : '');
}

function main() {
  const root = workspaceRoot();
  const profiles = scanProfiles(root);
  const cronFailures = scanCronRuns(root);
  const missedAlerts = readText(path.join(root, 'logs', 'ceo-alerts-missed.log'), 4000);
  const summaryOnly = process.argv.includes('--summary');

  const lines = [];
  lines.push('BÁO CÁO RỦI RO ZALO');
  lines.push('');
  lines.push(`Đã quét ${profiles.totalUsers} hồ sơ khách Zalo.`);
  lines.push(`Khách mới cần theo dõi: ${names(profiles.newContacts)}`);
  lines.push(`Khách có tín hiệu cần follow-up: ${names(profiles.needsFollowup)}`);
  lines.push(`Khách có tín hiệu khiếu nại/rủi ro: ${names(profiles.complaints)}`);
  if (profiles.stalePending.length) {
    lines.push(`Rủi ro quá hạn: ${names(profiles.stalePending)} chưa thấy cập nhật mới trong hơn 24 giờ.`);
  } else {
    lines.push('Rủi ro quá hạn: Không có tín hiệu quá hạn rõ ràng.');
  }

  if (cronFailures.length) {
    lines.push('');
    lines.push('Cron lỗi gần đây:');
    for (const f of cronFailures.slice(-5)) {
      lines.push(`- ${f.label}: ${String(f.reason || 'không rõ lỗi').slice(0, 140)}`);
    }
  } else {
    lines.push('');
    lines.push('Cron lỗi gần đây: Không thấy lỗi mới trong log gần nhất.');
  }

  if (missedAlerts.trim()) {
    lines.push('');
    lines.push('Cảnh báo hệ thống: Có alert gửi CEO từng bị miss, nên kiểm tra Telegram/Zalo sau khi bot khởi động.');
  }

  if (!summaryOnly) {
    lines.push('');
    lines.push('Gợi ý xử lý: ưu tiên khách có khiếu nại hoặc pending quá 24 giờ, sau đó kiểm tra cron lỗi nếu có.');
  }

  process.stdout.write(lines.join('\n') + '\n');
}

try {
  main();
} catch (e) {
  process.stdout.write('BÁO CÁO RỦI RO ZALO\n\nKhông quét được dữ liệu, nhưng script tương thích vẫn chạy để cron không lỗi thiếu file.\nChi tiết: ' + String(e?.message || e).slice(0, 200) + '\n');
  process.exitCode = 0;
}
