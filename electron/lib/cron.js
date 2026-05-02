'use strict';
const fs = require('fs');
const path = require('path');
const ctx = require('./context');
const { writeJsonAtomic, tokenizeShellish } = require('./util');
const { getWorkspace, DEFAULT_SCHEDULES_JSON, auditLog } = require('./workspace');
const { findOpenClawCliJs, spawnOpenClawSafe } = require('./boot');
const { healOpenClawConfigInline, setJournalCronRun } = require('./config');
const {
  sendTelegram, sendCeoAlert, sendZaloTo,
  isChannelPaused, isZaloListenerAlive, findOpenzcaListenerPid,
  getTelegramConfigWithRecovery, getCeoSessionKey, sendToGatewaySession,
} = require('./channels');
const { extractConversationHistory, writeDailyMemoryJournal } = require('./conversation');
const { call9Router } = require('./nine-router');
const { getZcaProfile } = require('./zalo-memory');

// Lazy-load gateway to avoid circular require
let _gateway = null;
function getGateway() {
  if (!_gateway) _gateway = require('./gateway');
  return _gateway;
}

// ============================================================
//   CRON AGENT PIPELINE — Path B "must never silently fail"
// ============================================================

let _agentFlagProfile = null;   // 'full' | 'medium' | 'minimal'
let _agentCliHealthy = false;
let _agentCliVersionOk = false; // true only when --version call succeeds
let _selfTestPromise = null;

function cronJournalPath() {
  return path.join(getWorkspace(), 'logs', 'cron-runs.jsonl');
}
function journalCronRun(entry) {
  try {
    const file = cronJournalPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n', 'utf-8');
  } catch (e) {
    console.error('[cron-journal] write error:', e.message);
  }
}

// Wire journalCronRun into config.js so config can call it without circular dep
setJournalCronRun(journalCronRun);

async function selfTestOpenClawAgent() {
  if (_selfTestPromise) return _selfTestPromise;
  _selfTestPromise = (async () => {
    const usingDirectNode = !!findOpenClawCliJs();
    console.log(`[cron-agent self-test] cli path: ${usingDirectNode ? 'node openclaw.mjs (safe)' : 'openclaw.cmd (fallback — newline-fragile)'}`);

    let res;
    try {
      res = await spawnOpenClawSafe(['--version'], { timeoutMs: 10000 });
    } catch (e) {
      res = { code: -1, stdout: '', stderr: String(e?.message || e) };
    }

    const stdout = res.stdout || '';
    const stderr = res.stderr || '';

    _agentFlagProfile = 'full';

    const versionMatch = stdout.match(/OpenClaw\s+(\S+)/);
    const versionStr = versionMatch ? versionMatch[1] : null;

    if (res.code === 0 && versionStr) {
      _agentCliHealthy = true;
      _agentCliVersionOk = true;
      console.log(`[cron-agent self-test] OK — openclaw ${versionStr} (directNode=${usingDirectNode}, profile=full)`);
      journalCronRun({
        phase: 'self-test',
        ok: true,
        profile: 'full',
        version: versionStr,
        directNode: usingDirectNode,
        code: res.code,
        stdoutLen: stdout.length,
      });
      // Allow re-test after 30min so mid-session breakage is detected
      setTimeout(() => { _selfTestPromise = null; }, 30 * 60 * 1000);
    } else {
      console.warn(`[cron-agent self-test] FAIL — code=${res.code} stdoutLen=${stdout.length} stderrLen=${stderr.length} viaCmdShell=${res.viaCmdShell}`);
      if (stdout) console.warn(`[cron-agent self-test] stdout: ${stdout.slice(0, 300)}`);
      if (stderr) console.warn(`[cron-agent self-test] stderr: ${stderr.slice(0, 300)}`);
      journalCronRun({
        phase: 'self-test',
        ok: false,
        reason: 'version-call-failed',
        defaultedProfile: 'full',
        directNode: usingDirectNode,
        code: res.code,
        stdoutLen: stdout.length,
        stderrLen: stderr.length,
        stdoutPreview: stdout.slice(0, 400),
        stderrPreview: stderr.slice(0, 400),
        viaCmdShell: res.viaCmdShell,
      });
      _selfTestPromise = null;
    }
  })();
  return _selfTestPromise;
}

function buildAgentArgs(prompt, chatId) {
  const idStr = String(chatId);
  const base = ['agent', '--message', prompt, '--deliver'];
  if (_agentFlagProfile === 'full') {
    return [...base, '--channel', 'telegram', '--to', idStr, '--reply-channel', 'telegram', '--reply-to', idStr];
  }
  if (_agentFlagProfile === 'medium') {
    return [...base, '--channel', 'telegram', '--to', idStr];
  }
  return [...base, '--to', idStr];
}

function isTransientErr(stderr) {
  const s = (stderr || '').toLowerCase();
  return s.includes('econnrefused')
      || s.includes('etimedout')
      || s.includes('gateway') && s.includes('not')
      || s.includes('temporarily')
      || s.includes('timeout');
}

function isConfigInvalidErr(stderr) {
  const s = (stderr || '').toLowerCase();
  return s.includes('config invalid') || s.includes('unrecognized key');
}

function isFatalErr(stderr, exitCode) {
  const s = (stderr || '').toLowerCase();
  return s.includes('openclaw not found')
      || s.includes('cmd-shell fallback refused')
      || s.includes('enoent') && (s.includes('openclaw') || s.includes('node'))
      || s.includes('eacces')
      || s.includes('not authorized')
      || s.includes('invalid token')
      || (exitCode === 127);
}

function parseSafeOpenzcaMsgSend(shellCmd) {
  const tokens = tokenizeShellish(shellCmd);
  if (!tokens || !tokens.length) return null;
  let i = 0;
  if (/^(?:node|node\.exe)$/i.test(tokens[i] || '')) {
    const cli = String(tokens[i + 1] || '');
    if (!/openzca[\\\/].*dist[\\\/]cli\.js$/i.test(cli) && !/openzca.*cli\.js$/i.test(cli)) return null;
    i += 2;
  } else {
    const bin = String(tokens[i] || '');
    if (!/^(?:openzca(?:\.cmd|\.ps1)?|openzca)$/i.test(bin)) return null;
    i += 1;
  }
  let profile = null;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '--profile' || t === '-p') {
      profile = tokens[i + 1] || null;
      i += 2;
      continue;
    }
    if (t === '--debug' || t === '--debug-file') {
      i += (t === '--debug-file') ? 2 : 1;
      continue;
    }
    break;
  }
  if ((tokens[i] || '').toLowerCase() !== 'msg') return null;
  if ((tokens[i + 1] || '').toLowerCase() !== 'send') return null;
  const targetIdRaw = tokens[i + 2];
  const text = tokens[i + 3];
  if (!targetIdRaw || text == null) return null;
  const trailing = tokens.slice(i + 4);
  const isGroup = trailing.includes('--group');
  const profileIdx = trailing.indexOf('--profile');
  if (profileIdx !== -1 && !profile) {
    profile = trailing[profileIdx + 1] || null;
  }
  const unsupported = trailing.filter((t, idx) => {
    if (t === '--group') return false;
    if (profileIdx !== -1 && (idx === profileIdx || idx === profileIdx + 1)) return false;
    return true;
  });
  if (unsupported.length > 0) return null;
  const targetIds = targetIdRaw.split(',').map(s => s.trim()).filter(Boolean);
  if (!targetIds.length || targetIds.length > 50) return null;
  return { profile: profile || getZcaProfile(), targetIds, text, isGroup };
}

async function runSafeExecCommand(shellCmd, { label } = {}) {
  const parsed = parseSafeOpenzcaMsgSend(shellCmd);
  if (!parsed) return null;
  const { targetIds, text, isGroup, profile } = parsed;
  if (!isZaloListenerAlive()) {
    console.error(`[cron-exec] "${label || 'cron'}" — Zalo listener not running, refusing send`);
    journalCronRun({ phase: 'fail', label: label || 'cron', mode: 'safe-openzca', err: 'zalo-listener-down' });
    try { await sendCeoAlert(`Cron "${label || 'cron'}" không gửi được — Zalo listener không chạy. Vào Dashboard kiểm tra tab Zalo.`); } catch {}
    return false;
  }
  if (targetIds.length === 1) {
    console.log(`[cron-exec] "${label || 'cron'}" rerouted to safe Zalo sender`);
    const ok = await sendZaloTo({ id: targetIds[0], isGroup }, text, { profile });
    return ok ? true : false;
  }
  console.log(`[cron-exec] "${label || 'cron'}" broadcast to ${targetIds.length} targets`);
  let sent = 0;
  for (let t = 0; t < targetIds.length; t++) {
    try {
      const ok = await sendZaloTo({ id: targetIds[t], isGroup }, text, { profile });
      if (ok) sent++;
      else console.warn(`[cron-exec] broadcast target ${targetIds[t]} failed`);
    } catch (e) {
      console.error(`[cron-exec] broadcast target ${targetIds[t]} error:`, e?.message || e);
    }
    if (t < targetIds.length - 1) await new Promise(r => setTimeout(r, 1500));
  }
  console.log(`[cron-exec] broadcast done: ${sent}/${targetIds.length} sent`);
  if (sent === 0) return false;
  if (sent < targetIds.length) {
    try { await sendCeoAlert(`Cron "${label || 'cron'}" broadcast: ${sent}/${targetIds.length} nhóm thành công. ${targetIds.length - sent} nhóm thất bại.`); } catch {}
  }
  return true;
}

let _cronAgentQueue = Promise.resolve();
let _cronAgentQueueDepth = 0;
async function runCronAgentPrompt(prompt, opts = {}) {
  _cronAgentQueueDepth++;
  if (_cronAgentQueueDepth > 1) {
    console.log(`[cron-agent] queued (depth=${_cronAgentQueueDepth}) label="${opts?.label || 'cron'}"`);
  }
  const run = _cronAgentQueue.then(() => _runCronAgentPromptImpl(prompt, opts));
  _cronAgentQueue = run.catch(() => {}).finally(() => { _cronAgentQueueDepth--; });
  return run;
}

async function _runCronAgentPromptImpl(prompt, { label, timeoutMs = 600000 } = {}) {
  const niceLabel = label || 'cron';

  const execMatch = prompt.trim().match(/^exec:\s+(.+)$/s);
  if (execMatch) {
    const shellCmd = execMatch[1].trim();
    const safeResult = await runSafeExecCommand(shellCmd, { label: niceLabel });
    if (safeResult !== null) {
      if (safeResult) {
        journalCronRun({ phase: 'ok', label: niceLabel, mode: 'safe-openzca' });
      } else {
        journalCronRun({ phase: 'fail', label: niceLabel, mode: 'safe-openzca', err: 'safe-openzca command blocked or failed' });
        try { await sendCeoAlert(`*Cron "${niceLabel}" bị chặn vì không an toàn hoặc gửi Zalo thất bại*\n\nLệnh gửi Zalo đã được kéo về đường an toàn và không được phép đi tiếp.`); } catch {}
      }
      return safeResult;
    }
    console.warn(`[cron-exec] "${niceLabel}" BLOCKED — unrecognized exec command: ${shellCmd.slice(0, 120)}`);
    journalCronRun({ phase: 'fail', label: niceLabel, mode: 'exec-blocked', err: 'only exec: openzca msg send is allowed' });
    try { await sendCeoAlert(`*Cron "${niceLabel}" bị chặn*\n\nChỉ cho phép \`exec: openzca msg send <id> "<text>" --group\`. Lệnh khác không được phép chạy trực tiếp.`); } catch {}
    return false;
  }

  try { healOpenClawConfigInline(); } catch (e) { console.error('[cron-agent] inline heal:', e?.message || e); }

  await selfTestOpenClawAgent();

  if (!_agentFlagProfile) _agentFlagProfile = 'full';

  const { chatId, recovered } = await getTelegramConfigWithRecovery();
  if (!chatId) {
    journalCronRun({ phase: 'fail', label: niceLabel, reason: 'no-chat-id-even-after-recovery' });
    console.error(`[cron-agent] "${niceLabel}" — no telegram chatId, even after recovery attempt`);
    try {
      const alertFile = path.join(getWorkspace(), 'logs', 'cron-cannot-deliver.txt');
      fs.mkdirSync(path.dirname(alertFile), { recursive: true });
      fs.appendFileSync(alertFile, `${new Date().toISOString()} — Cron "${niceLabel}" cannot deliver: no telegram chatId in config, sticky file, or recent Telegram updates. Re-run wizard or have someone /start the bot.\n`, 'utf-8');
    } catch {}
    return false;
  }
  if (recovered) {
    console.warn(`[cron-agent] "${niceLabel}" — used recovered chatId source: ${recovered}`);
    journalCronRun({ phase: 'chatid-recovered', label: niceLabel, source: recovered });
  }

  if (ctx.gatewayRestartInFlight || ctx.startOpenClawInFlight) {
    console.log(`[cron-agent] "${niceLabel}" — gateway restarting, waiting 15s before first attempt`);
    await new Promise(r => setTimeout(r, 15000));
  }

  const args = buildAgentArgs(prompt, chatId);
  const promptHasNewline = prompt.includes('\n');
  let lastErr = '';
  let lastCode = -1;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const startedAt = Date.now();
    console.log(`[cron-agent] "${niceLabel}" attempt ${attempt}/3 (profile=${_agentFlagProfile}, prompt ${prompt.length}c, multiline=${promptHasNewline})`);
    const res = await spawnOpenClawSafe(args, {
      timeoutMs,
      allowCmdShellFallback: !promptHasNewline,
    });
    const durMs = Date.now() - startedAt;
    if (res.code === 0) {
      journalCronRun({ phase: 'ok', label: niceLabel, attempt, durMs, profile: _agentFlagProfile, viaCmdShell: res.viaCmdShell });
      console.log(`[cron-agent] "${niceLabel}" delivered in ${durMs}ms (viaCmdShell=${res.viaCmdShell})`);
      return true;
    }
    lastCode = res.code;
    lastErr = (res.stderr || res.stdout || '').slice(0, 800);
    journalCronRun({ phase: 'retry', label: niceLabel, attempt, durMs, code: res.code, err: lastErr.slice(0, 300), viaCmdShell: res.viaCmdShell });
    console.error(`[cron-agent] "${niceLabel}" attempt ${attempt} failed (code ${res.code}): ${lastErr.slice(0, 200)}`);

    if (isFatalErr(lastErr, res.code)) {
      let userMsg;
      if (lastErr.includes('cmd-shell fallback refused')) {
        userMsg = `*Cron "${niceLabel}" KHÔNG chạy được — môi trường thiếu Node*\n\nKhông tìm thấy \`node\` hoặc \`openclaw.mjs\` trên máy. Cron prompt nhiều dòng KHÔNG thể chạy qua \`openclaw.cmd\` (cmd.exe sẽ truncate).\n\nCần cài Node.js và đảm bảo \`node\` chạy được từ terminal: \`node -v\`. Sau đó restart Modoro Claw.`;
      } else if (lastErr.toLowerCase().includes('openclaw not found')) {
        userMsg = `*Cron "${niceLabel}" KHÔNG chạy được — openclaw không có trên máy*\n\nCần \`npm install -g openclaw\` rồi restart Modoro Claw.`;
      } else if (lastErr.toLowerCase().includes('invalid token') || lastErr.toLowerCase().includes('not authorized')) {
        userMsg = `*Cron "${niceLabel}" KHÔNG chạy được — auth lỗi*\n\nGateway token hoặc Telegram bot token không hợp lệ. Vào Dashboard → Cài đặt → Wizard để cấu hình lại.\n\nstderr: \`${lastErr.slice(0, 200)}\``;
      } else {
        userMsg = `*Cron "${niceLabel}" KHÔNG chạy được — lỗi không retry được*\n\nExit ${res.code}\n\`\`\`\n${lastErr.slice(0, 400)}\n\`\`\``;
      }
      try { await sendCeoAlert(userMsg); } catch {}
      journalCronRun({ phase: 'fail', label: niceLabel, code: lastCode, reason: 'fatal-no-retry', err: lastErr.slice(0, 300) });
      return false;
    }

    if (attempt < 3 && isConfigInvalidErr(lastErr)) {
      const healed = healOpenClawConfigInline(lastErr);
      console.log(`[cron-agent] config-invalid detected; inline heal ${healed ? 'WROTE' : 'noop'}, retrying immediately`);
      continue;
    }

    if (attempt < 3) {
      const backoffMs = isTransientErr(lastErr) ? attempt * 5000 : attempt * 2000;
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  journalCronRun({ phase: 'fail', label: niceLabel, code: lastCode, err: lastErr.slice(0, 400) });
  try {
    await sendCeoAlert(`*Cron "${niceLabel}" thất bại sau 3 lần*\n\nExit code: \`${lastCode}\`\n\`\`\`\n${lastErr.slice(0, 500)}\n\`\`\``);
  } catch {}
  return false;
}

// ============================================================
//   SCHEDULE/PROMPT BUILDERS
// ============================================================

// Schedule management (CEO-friendly cron display)
function getSchedulesPath() { return path.join(getWorkspace(), 'schedules.json'); }
function getCustomCronsPath() { return path.join(getWorkspace(), 'custom-crons.json'); }

// Legacy paths for one-time migration from older installs
const legacySchedulesPaths = [
  path.join(ctx.HOME, '.openclaw', 'workspace', 'schedules.json'),
  // appDataDir() not available here — workspace.js handles that
];
const legacyCustomCronsPaths = [
  path.join(ctx.HOME, '.openclaw', 'workspace', 'custom-crons.json'),
];

function loadSchedules() {
  const schedulesPath = getSchedulesPath();
  try {
    if (fs.existsSync(schedulesPath)) {
      const raw = fs.readFileSync(schedulesPath, 'utf-8');
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('schedules.json must be an array');
        return parsed;
      } catch (parseErr) {
        const backupPath = schedulesPath + '.corrupt-' + Date.now();
        try { fs.copyFileSync(schedulesPath, backupPath); } catch {}
        console.error(`[schedules] CORRUPT JSON in ${schedulesPath}: ${parseErr.message}. Backed up to ${backupPath}. Falling back to defaults.`);
        try {
          const errFile = path.join(getWorkspace(), '.learnings', 'ERRORS.md');
          fs.mkdirSync(path.dirname(errFile), { recursive: true });
          fs.appendFileSync(errFile, `\n## ${new Date().toISOString()} — schedules.json corrupt\n\nError: ${parseErr.message}\nBackup: ${backupPath}\nFell back to defaults so morning/evening still fire.\n`, 'utf-8');
        } catch {}
        sendCeoAlert(`Cảnh báo: schedules.json bị lỗi JSON\n\n${parseErr.message}\n\nĐã backup về ${path.basename(backupPath)} và fall back về default schedules. Vào Dashboard, tab Lịch để xem.`).catch((e) => { console.error('[loadSchedules] alert error:', e.message); });
        return DEFAULT_SCHEDULES_JSON;
      }
    }
    for (const p of legacySchedulesPaths) {
      if (p !== schedulesPath && fs.existsSync(p)) {
        try {
          const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
          try {
            writeJsonAtomic(schedulesPath, data);
            console.log('[schedules] Migrated from', p, '→', schedulesPath);
          } catch {}
          return data;
        } catch (e) {
          console.error(`[schedules] legacy file ${p} is corrupt:`, e.message);
        }
      }
    }
  } catch {}
  return DEFAULT_SCHEDULES_JSON;
}

function loadDailySummaries(days) {
  const ws = getWorkspace();
  if (!ws) return '';
  const memDir = path.join(ws, 'memory');
  const parts = [];
  for (let i = days; i >= 1; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    const summaryPath = path.join(memDir, `${dateStr}-summary.md`);
    const rawPath = path.join(memDir, `${dateStr}.md`);
    try {
      if (fs.existsSync(summaryPath)) {
        parts.push(fs.readFileSync(summaryPath, 'utf-8'));
      } else if (fs.existsSync(rawPath)) {
        parts.push(fs.readFileSync(rawPath, 'utf-8'));
      }
    } catch { continue; }
  }
  return parts.join('\n\n');
}

async function generateWeeklySummary() {
  const ws = getWorkspace();
  if (!ws) return null;
  const memDir = path.join(ws, 'memory');
  const now = new Date();
  const thu = new Date(now);
  thu.setDate(thu.getDate() + 3 - ((thu.getDay() + 6) % 7));
  const jan4 = new Date(thu.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((thu - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  const weekLabel = `${thu.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
  const weekFile = path.join(memDir, `week-${weekLabel}-summary.md`);
  try {
    if (fs.existsSync(weekFile)) return fs.readFileSync(weekFile, 'utf-8');
  } catch {}
  const dailies = loadDailySummaries(7);
  if (!dailies) return null;
  const summary = await call9Router(
    `Dưới đây là tóm tắt hoạt động 7 ngày qua. Tổng hợp thành BÁO CÁO TUẦN ngắn gọn:\n` +
    `- Tổng quan hoạt động\n- Khách hàng nổi bật\n- Vấn đề tồn đọng\n- Số liệu tổng hợp\n` +
    `Chỉ trả về bullet points.\n\n---\n${dailies.substring(0, 6000)}`,
    { maxTokens: 800, temperature: 0.2, timeoutMs: 20000 }
  );
  if (summary) {
    try {
      fs.writeFileSync(weekFile, `# Tóm tắt tuần ${weekLabel}\n\n${summary}\n`, 'utf-8');
      console.log(`[journal] weekly summary written: week-${weekLabel}-summary.md`);
    } catch {}
    return `# Tóm tắt tuần ${weekLabel}\n\n${summary}\n`;
  }
  return dailies;
}

function loadWeeklySummaries() {
  const ws = getWorkspace();
  if (!ws) return '';
  const memDir = path.join(ws, 'memory');
  const parts = [];
  for (let w = 4; w >= 1; w--) {
    const d = new Date(Date.now() - w * 7 * 86400000);
    const thu = new Date(d);
    thu.setDate(thu.getDate() + 3 - ((thu.getDay() + 6) % 7));
    const jan4 = new Date(thu.getFullYear(), 0, 4);
    const weekNum = 1 + Math.round(((thu - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
    const weekLabel = `${thu.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
    const weekFile = path.join(memDir, `week-${weekLabel}-summary.md`);
    try {
      if (fs.existsSync(weekFile)) {
        parts.push(fs.readFileSync(weekFile, 'utf-8'));
        continue;
      }
    } catch {}
    const weekDailies = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(d.getTime() + i * 86400000);
      const dateStr = day.toISOString().slice(0, 10);
      const sp = path.join(memDir, `${dateStr}-summary.md`);
      const rp = path.join(memDir, `${dateStr}.md`);
      try {
        if (fs.existsSync(sp)) weekDailies.push(fs.readFileSync(sp, 'utf-8'));
        else if (fs.existsSync(rp)) weekDailies.push(fs.readFileSync(rp, 'utf-8'));
      } catch {}
    }
    if (weekDailies.length > 0) parts.push(weekDailies.join('\n'));
  }
  return parts.join('\n\n');
}

function loadPromptTemplate(name) {
  // __dirname is electron/lib/ — prompts/ is in electron/
  const candidates = [
    path.join(__dirname, '..', 'prompts', name),
    path.join(process.resourcesPath || path.join(__dirname, '..'), 'prompts', name),
  ];
  for (const p of candidates) {
    try { return fs.readFileSync(p, 'utf-8'); } catch {}
  }
  return null;
}

function buildMorningBriefingPrompt(timeStr) {
  try { writeDailyMemoryJournal({ date: new Date(Date.now() - 86400000) }); } catch {}
  const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
  const history = extractConversationHistory({ sinceMs, maxMessages: 50, maxPerSender: 10 });
  const historyBlock = history
    ? `\n\n--- Lịch sử tin nhắn 24h qua ---\n${history}\n--- Hết ---\n\n`
    : `\n\n_(Chưa có tin nhắn nào trong 24h qua.)_\n\n`;
  const template = loadPromptTemplate('morning-briefing.md');
  if (template) {
    return template
      .replace('{{time}}', timeStr || '07:30')
      .replace('{{historyBlock}}', historyBlock);
  }
  return `Bây giờ là ${timeStr || '07:30'} sáng. Gửi báo cáo sáng cho CEO.` + historyBlock +
    `Tóm tắt hôm qua, việc hôm nay, tin cần xử lý, cảnh báo. Tiếng Việt có dấu, không emoji.`;
}

function buildEveningSummaryPrompt(timeStr) {
  try { writeDailyMemoryJournal({ date: new Date() }); } catch {}
  const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
  const history = extractConversationHistory({ sinceMs, maxMessages: 50, maxPerSender: 10 });
  const historyBlock = history
    ? `\n\n--- LỊCH SỬ TIN NHẮN 24H QUA (đã trích từ session storage, KHÔNG cần em đi tìm thêm) ---\n${history}\n--- HẾT LỊCH SỬ ---\n\n`
    : `\n\n_(Chưa có tin nhắn nào trong 24h qua.)_\n\n`;

  let memoryInsights = '';
  try {
    const ws = getWorkspace();
    if (ws) {
      const memDir = path.join(ws, 'memory', 'zalo-users');
      if (fs.existsSync(memDir)) {
        const files = fs.readdirSync(memDir).filter(f => f.endsWith('.md'));
        const today = new Date();
        const todayStr = today.toISOString().slice(0, 10);
        const yesterdayStr = new Date(today - 86400000).toISOString().slice(0, 10);
        const recentFiles = [];
        for (const f of files) {
          try {
            const stat = fs.statSync(path.join(memDir, f));
            const ageH = (Date.now() - stat.mtimeMs) / 3600000;
            if (ageH < 48) recentFiles.push(f);
          } catch {}
        }
        if (recentFiles.length > 0) {
          const snippets = [];
          for (const f of recentFiles.slice(0, 20)) {
            try {
              const content = fs.readFileSync(path.join(memDir, f), 'utf-8');
              const lines = content.split('\n');
              const recentLines = lines.filter(l => l.includes(todayStr) || l.includes(yesterdayStr));
              if (recentLines.length > 0) {
                snippets.push(`[${f.replace('.md', '')}] ${recentLines.slice(-5).join(' | ')}`);
              }
            } catch {}
          }
          if (snippets.length > 0) {
            memoryInsights = `\n\n--- HOAT DONG KHACH HANG 48H (tu memory/zalo-users/) ---\n${snippets.join('\n')}\n--- HET ---\n\n`;
          }
        }
      }
    }
  } catch {}

  let knowledgeGaps = '';
  try {
    const ws = getWorkspace();
    if (ws) {
      const auditPath = path.join(ws, 'logs', 'audit.jsonl');
      if (fs.existsSync(auditPath)) {
        const raw = fs.readFileSync(auditPath, 'utf-8');
        const lines = raw.trim().split('\n').slice(-200);
        const gaps = [];
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.event === 'knowledge_gap' || entry.event === 'no_answer') {
              gaps.push(entry.question || entry.detail || '');
            }
          } catch {}
        }
        if (gaps.length > 0) {
          knowledgeGaps = `\n\n--- CAU HOI BOT KHONG TRA LOI DUOC ---\n${[...new Set(gaps)].slice(0, 5).join('\n')}\n--- HET ---\n\n`;
        }
      }
    }
  } catch {}

  const template = loadPromptTemplate('evening-briefing.md');
  if (template) {
    return template
      .replace('{{time}}', timeStr || '21:00')
      .replace('{{historyBlock}}', historyBlock)
      .replace('{{memoryInsights}}', memoryInsights)
      .replace('{{knowledgeGaps}}', knowledgeGaps);
  }
  return `Bây giờ là ${timeStr || '21:00'}, cuối ngày. Tóm tắt hoạt động hôm nay cho CEO.` +
    historyBlock + memoryInsights + knowledgeGaps +
    `Tiếng Việt có dấu, không emoji, ngắn gọn.`;
}

async function buildWeeklyReportPrompt() {
  await generateWeeklySummary();
  const sinceMs24h = Date.now() - 24 * 60 * 60 * 1000;
  const recentRaw = extractConversationHistory({ sinceMs: sinceMs24h, maxMessages: 50, maxPerSender: 10 });
  const dailySummaries = loadDailySummaries(7);
  const recentBlock = recentRaw
    ? `\n\n--- TIN NHẮN 24H GẦN NHẤT (chi tiết) ---\n${recentRaw}\n--- HẾT ---\n\n`
    : '';
  const summaryBlock = dailySummaries
    ? `\n\n--- TÓM TẮT 7 NGÀY QUA (từ daily summaries, cover 100% tin nhắn) ---\n${dailySummaries}\n--- HẾT TÓM TẮT ---\n\n`
    : `\n\n_(Không có tóm tắt ngày nào trong 7 ngày qua.)_\n\n`;
  const template = loadPromptTemplate('weekly-report.md');
  if (template) {
    return template
      .replace('{{recentBlock}}', recentBlock)
      .replace('{{summaryBlock}}', summaryBlock);
  }
  return `Hôm nay là thứ 2. Gửi báo cáo tuần cho CEO.` +
    recentBlock + summaryBlock +
    `Tổng kết tuần, vấn đề tồn đọng, số liệu, ưu tiên tuần tới. Tiếng Việt có dấu, không emoji.`;
}

function buildMonthlyReportPrompt() {
  const sinceMs24h = Date.now() - 24 * 60 * 60 * 1000;
  const recentRaw = extractConversationHistory({ sinceMs: sinceMs24h, maxMessages: 50, maxPerSender: 10 });
  const weeklySummaries = loadWeeklySummaries();
  const recentBlock = recentRaw
    ? `\n\n--- TIN NHẮN 24H GẦN NHẤT (chi tiết) ---\n${recentRaw}\n--- HẾT ---\n\n`
    : '';
  const summaryBlock = weeklySummaries
    ? `\n\n--- TÓM TẮT 4 TUẦN QUA (từ weekly summaries, cover 100% tin nhắn) ---\n${weeklySummaries}\n--- HẾT TÓM TẮT ---\n\n`
    : `\n\n_(Không có tóm tắt trong 30 ngày qua.)_\n\n`;
  const template = loadPromptTemplate('monthly-report.md');
  if (template) {
    return template
      .replace('{{recentBlock}}', recentBlock)
      .replace('{{summaryBlock}}', summaryBlock);
  }
  return `Ngày 1 tháng mới. Hãy gửi BÁO CÁO THÁNG cho CEO.` +
    recentBlock + summaryBlock +
    `Dựa trên tóm tắt hàng tuần + memory/ + knowledge, tổng hợp:\n` +
    `1. Tổng kết tháng: kết quả nổi bật, milestone đạt được\n` +
    `2. Khách hàng: khách mới, khách quay lại, khách mất (nếu có data)\n` +
    `3. Hoạt động bot: tổng tin xử lý, cron runs, errors (nếu có)\n` +
    `4. So sánh với tháng trước (nếu có data memory)\n` +
    `5. Kế hoạch + ưu tiên tháng tới\n\n` +
    `Trả lời bằng tiếng Việt, dùng tiêu đề **BÁO CÁO THÁNG** in đậm + bullet points. ` +
    `KHÔNG dùng emoji. KHÔNG hỏi lại CEO. Nếu data ít thì tóm ngắn.`;
}

function scanZaloFollowUpCandidates(ws, { nowMs = Date.now(), max = 20 } = {}) {
  const usersDir = path.join(ws, 'memory', 'zalo-users');
  if (!fs.existsSync(usersDir)) return [];

  const H24_MS = 24 * 60 * 60 * 1000;
  const H48_MS = 48 * 60 * 60 * 1000;
  const H30D_MS = 30 * H24_MS;
  const DATED_RE = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/gm;
  const PENDING_HINTS = /(chờ phản hồi|chờ trả lời|chưa chốt|cần follow-?up|sẽ liên hệ|hẹn mai|mai liên lạc|ngày mai sẽ|hứa.*(mua|đặt|ghé|qua))/i;

  const candidates = [];
  let files;
  try { files = fs.readdirSync(usersDir).filter(f => f.endsWith('.md')); }
  catch { return []; }

  for (const file of files) {
    const fp = path.join(usersDir, file);
    let stat;
    try { stat = fs.statSync(fp); } catch { continue; }
    if (stat.size < 10) continue;
    if (nowMs - stat.mtimeMs > H30D_MS) continue;

    let content;
    try {
      content = fs.readFileSync(fp, 'utf-8');
    } catch { continue; }

    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    const fm = {};
    if (fmMatch) {
      for (const line of fmMatch[1].split('\n')) {
        const m = line.match(/^(\w+):\s*(.*)$/);
        if (m) fm[m[1]] = m[2].trim();
      }
    }
    const name = fm.name || file.replace(/\.md$/, '');

    const dates = [];
    let dm;
    DATED_RE.lastIndex = 0;
    while ((dm = DATED_RE.exec(content)) !== null) dates.push(dm[1]);

    if (dates.length === 0) continue;

    {
      const lastDate = dates.sort().at(-1);
      const lastMs = Date.parse(lastDate + 'T00:00:00Z');
      if (!Number.isFinite(lastMs)) continue;
      const staleMs = nowMs - lastMs;
      if (staleMs < H48_MS) continue;

      const sectionStart = content.lastIndexOf(`## ${lastDate}`);
      const sectionEnd = content.indexOf('\n## ', sectionStart + 3);
      const sectionText = sectionEnd > 0
        ? content.slice(sectionStart, sectionEnd)
        : content.slice(sectionStart);

      if (!PENDING_HINTS.test(sectionText)) continue;

      const staleDays = Math.floor(staleMs / H24_MS);
      const preview = (sectionText.match(/^[-*]\s+(.*?)$/m)?.[1] || sectionText.split('\n')[1] || '').slice(0, 80);
      candidates.push({
        kind: 'pending-stale',
        senderId: file.replace(/\.md$/, ''),
        name,
        staleDays,
        lastDate,
        priority: 30 + Math.min(staleDays, 30),
        line: `- ${name} — ${preview || 'chờ phản hồi'} (ngày ${lastDate}, ${staleDays} ngày chưa trả lời tiếp)`,
      });
    }
  }

  candidates.sort((a, b) => b.priority - a.priority);
  return candidates.slice(0, max);
}

function buildZaloFollowUpPrompt(candidates) {
  if (!Array.isArray(candidates)) {
    return (
      `Kiểm tra khách hàng Zalo cần follow-up. Đọc tất cả file trong memory/zalo-users/*.md.\n\n` +
      `KHÔNG dùng emoji. KHÔNG hỏi lại CEO.`
    );
  }

  if (candidates.length === 0) {
    return (
      `Gửi cho CEO NỘI DUNG CHÍNH XÁC NHƯ SAU (không thêm chữ, không hỏi lại, không bịa):\n\n` +
      `Không có khách nào cần follow-up hôm nay.\n\n` +
      `Gửi qua tool sessions_send.`
    );
  }

  const blocks = candidates.map((c, i) => {
    const urgency = c.staleDays >= 4 ? 'CAO' : c.staleDays >= 2 ? 'TRUNG BINH' : 'BINH THUONG';
    const preview = c.line.replace(/^-\s*/, '');
    return [
      `${i + 1}. ${c.name}`,
      `   Mức độ: ${urgency} -- ${c.staleDays} ngày chưa phản hồi (từ ${c.lastDate})`,
      `   Nội dung gần nhất: ${preview}`,
      `   Gợi ý nhắn: Viết 1 câu nhắn tin tự nhiên cho khách này dựa trên nội dung trên. Giọng như đang hỏi thăm, không bán hàng. Ví dụ: "Anh/chị [tên] ơi, hôm trước mình trao đổi về [chủ đề], anh/chị đã cân nhắc thế nào ạ?"`,
    ].join('\n');
  });

  return (
    `Em đã quét memory khách hàng Zalo và tìm được ${candidates.length} khách cần follow-up.\n\n` +
    `Gửi cho CEO báo cáo với format bên dưới. Với mỗi khách, VIẾT MỘT CÂU NHẮN GỢI Ý CỤ THỂ dựa trên nội dung cuối cùng của họ (không dùng template chung chung). Ưu tiên khách có độ khẩn cấp CAO lên trước.\n\n` +
    `FOLLOW-UP KHACH ZALO (${candidates.length} khách)\n\n` +
    blocks.join('\n\n') +
    `\n\n` +
    `Với mỗi khách, thêm dòng "Gợi ý nhắn:" với 1 câu nhắn tin tự nhiên, cụ thể theo ngữ cảnh của khách đó. Không dùng template. Không bắt đầu bằng "Chào anh/chị" thuần túy.\n\n` +
    `Gửi đúng tool sessions_send. KHÔNG emoji, KHÔNG hỏi lại CEO, KHÔNG bịa thêm khách ngoài danh sách trên.`
  );
}

function readTextSnippet(filePath, maxChars = 4000) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (raw.length <= maxChars) return raw;
    return raw.slice(-maxChars);
  } catch {
    return '';
  }
}

function listRecentFiles(dir, predicate, limit = 8) {
  try {
    if (!dir || !fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .map(name => {
        const fullPath = path.join(dir, name);
        let stat = null;
        try { stat = fs.statSync(fullPath); } catch {}
        return { name, fullPath, stat };
      })
      .filter(entry => entry.stat && entry.stat.isFile() && (!predicate || predicate(entry.name, entry.fullPath)))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function collectZaloMemoryStats(ws) {
  const usersDir = path.join(ws, 'memory', 'zalo-users');
  const groupsDir = path.join(ws, 'memory', 'zalo-groups');
  const lines = [];

  try {
    const userFiles = fs.existsSync(usersDir) ? fs.readdirSync(usersDir).filter(f => f.endsWith('.md')) : [];
    let activeUsers = 0;
    const samples = [];
    for (const file of userFiles.slice(0, 80)) {
      const raw = readTextSnippet(path.join(usersDir, file), 2000);
      const msgCount = Number(raw.match(/^msgCount:\s*(\d+)/m)?.[1] || 0);
      const name = raw.match(/^name:\s*(.+)$/m)?.[1]?.trim() || file.replace(/\.md$/, '');
      const lastSeen = raw.match(/^lastSeen:\s*(.+)$/m)?.[1]?.trim() || '';
      if (msgCount > 0) activeUsers++;
      if (msgCount > 0 && samples.length < 5) samples.push(`${name} msgCount=${msgCount}${lastSeen ? ` lastSeen=${lastSeen}` : ''}`);
    }
    lines.push(`Zalo users: ${userFiles.length} profile(s), ${activeUsers} co msgCount > 0`);
    if (samples.length) lines.push('Mau user co tuong tac: ' + samples.join('; '));
  } catch {
    lines.push('Zalo users: khong doc duoc thong ke');
  }

  try {
    const groupFiles = fs.existsSync(groupsDir) ? fs.readdirSync(groupsDir).filter(f => f.endsWith('.md')) : [];
    lines.push(`Zalo groups: ${groupFiles.length} profile(s)`);
  } catch {
    lines.push('Zalo groups: khong doc duoc thong ke');
  }

  return lines.join('\n');
}

function collectMeditationContext() {
  const ws = getWorkspace();
  if (!ws) return 'Workspace chua san sang, khong co du lieu noi bo de review.';

  const parts = [];
  const learnings = readTextSnippet(path.join(ws, '.learnings', 'LEARNINGS.md'), 7000)
    || readTextSnippet(path.join(ws, 'LEARNINGS.md'), 7000);
  parts.push(`--- LEARNINGS.md GAN DAY ---\n${learnings || '(Chua co learning nao.)'}`);

  const memDir = path.join(ws, 'memory');
  const recentMemoryFiles = listRecentFiles(memDir, name => name.endsWith('.md'), 8);
  const memoryBlocks = recentMemoryFiles.map(entry => {
    const content = readTextSnippet(entry.fullPath, 1800);
    return `### memory/${entry.name}\n${content || '(rong)'}`;
  });
  parts.push(`--- MEMORY JOURNAL GAN DAY ---\n${memoryBlocks.length ? memoryBlocks.join('\n\n') : '(Khong co journal memory gan day.)'}`);

  const weeklyFiles = listRecentFiles(memDir, name => /^week-.*-summary\.md$/i.test(name) || /weekly-digest\.md$/i.test(name), 4);
  const weeklyBlocks = weeklyFiles.map(entry => `### memory/${entry.name}\n${readTextSnippet(entry.fullPath, 1600) || '(rong)'}`);
  if (weeklyBlocks.length) parts.push(`--- WEEKLY DIGEST / SUMMARY ---\n${weeklyBlocks.join('\n\n')}`);

  parts.push(`--- ZALO MEMORY STATS ---\n${collectZaloMemoryStats(ws)}`);

  const cronTail = readTextSnippet(path.join(ws, 'logs', 'cron-runs.jsonl'), 3500);
  if (cronTail) parts.push(`--- CRON RUN TAIL ---\n${cronTail}`);

  return parts.join('\n\n').slice(0, 18000);
}

function buildMeditationPrompt() {
  const contextBlock = collectMeditationContext();
  return (
    `Bay gio la 01:00 sang. Day la phien TOI UU BAN DEM.\n\n` +
    `He thong da doc san du lieu can thiet ben duoi. KHONG tu bao thieu quyen doc workspace neu block du lieu da co san.\n` +
    `Chi goi API /api/workspace/append?path=.learnings/LEARNINGS.md neu that su co learning moi dang ghi nhan.\n\n` +
    `Nhiem vu:\n` +
    `1. Dem uoc luong learning entries da review tu block LEARNINGS.\n` +
    `2. Tim pattern lap lai/impact cao tu LEARNINGS, memory journal, Zalo memory stats va cron tail.\n` +
    `3. Neu co pattern moi dang ghi nhan: append vao .learnings/LEARNINGS.md voi ma L-XXX tiep theo, noi dung ngan duoi 2000 bytes.\n` +
    `4. Gui CEO bao cao ngan bang tieng Viet co dau:\n` +
    `**TOI UU BAN DEM**\n` +
    `- Da review N learning entries\n` +
    `- Pattern moi phat hien: [bullet neu co, hoac "Khong co gi moi"]\n` +
    `- Diem can cai thien: [1-2 bullet ngan]\n\n` +
    `KHONG dung emoji. KHONG hoi lai CEO. KHONG sua AGENTS.md. KHONG noi ve duong dan file trong cau tra loi.\n\n` +
    `--- DU LIEU NOI BO DA DOC SAN ---\n${contextBlock}\n--- HET DU LIEU NOI BO ---`
  );
}

function buildMemoryCleanupPrompt() {
  return (
    `Dọn dẹp memory. Đọc tất cả file trong memory/ (trừ zalo-users/).\n\n` +
    `1. Tìm các journal entries cũ > 7 ngày, tổng hợp những insight quan trọng\n` +
    `2. Ghi tổng hợp tuần vào memory/weekly-digest.md (append, không xóa cũ)\n` +
    `3. Xác định thông tin trùng lặp hoặc outdated trong memory files\n\n` +
    `Gửi CEO báo cáo ngắn:\n` +
    `**DỌN DẸP MEMORY**\n` +
    `- Đã tổng hợp N journal entries\n` +
    `- Insight chính: [1-3 bullet]\n\n` +
    `KHÔNG xóa file gốc, chỉ tổng hợp. KHÔNG dùng emoji. KHÔNG hỏi lại CEO.`
  );
}

// ============================================================
//   runCronViaSessionOrFallback
// ============================================================

async function runCronViaSessionOrFallback(prompt, opts = {}) {
  const sessionKey = await getCeoSessionKey();
  if (sessionKey) {
    const ok = await sendToGatewaySession(sessionKey, prompt);
    if (ok) {
      journalCronRun({ phase: 'ok', label: opts.label || 'cron', mode: 'session-send' });
      return true;
    }
    console.log('[cron] sessions.send failed, falling back to runCronAgentPrompt');
  }
  return runCronAgentPrompt(prompt, opts);
}

// ============================================================
//   TELEGRAM BUILT-IN COMMANDS
// ============================================================

async function handleTimCommand(keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) {
    await sendTelegram('Cách dùng: /tim <tên|SĐT|từ khóa>');
    return;
  }
  const workspace = getWorkspace();
  if (!workspace) { await sendTelegram('Lỗi: không xác định được workspace.'); return; }
  const dir = path.join(workspace, 'memory', 'zalo-users');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch {}
  const kwLower = kw.toLowerCase();
  const matches = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
      const fm = {};
      const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      const body = m ? m[2] : raw;
      if (m) {
        for (const line of m[1].split('\n')) {
          const mm = line.match(/^([a-zA-Z][\w]*)\s*:\s*(.*)$/);
          if (mm) fm[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, '');
        }
      }
      const haystack = [
        fm.name, fm.phone, fm.email, fm.zaloName, body
      ].filter(Boolean).join('\n').toLowerCase();
      if (haystack.includes(kwLower)) {
        let snippet = '';
        const bodyLower = body.toLowerCase();
        const idx = bodyLower.indexOf(kwLower);
        if (idx >= 0) {
          const start = Math.max(0, idx - 20);
          snippet = body.slice(start, start + 80).replace(/\s+/g, ' ').trim();
        } else {
          snippet = body.replace(/\s+/g, ' ').trim().slice(0, 80);
        }
        let rel = '';
        if (fm.lastSeen) {
          const ts = Date.parse(fm.lastSeen);
          if (!isNaN(ts)) {
            const diffDays = Math.floor((Date.now() - ts) / 86400000);
            if (diffDays <= 0) rel = 'hôm nay';
            else if (diffDays === 1) rel = 'hôm qua';
            else rel = `${diffDays} ngày trước`;
          }
        }
        matches.push({
          name: fm.name || fm.zaloName || f.replace(/\.md$/, ''),
          phone: fm.phone || '',
          rel,
          snippet,
          lastSeenMs: fm.lastSeen ? Date.parse(fm.lastSeen) || 0 : 0,
        });
      }
    } catch {}
  }
  matches.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
  if (matches.length === 0) {
    await sendTelegram(`Không tìm thấy khách nào khớp "${kw}"`);
    return;
  }
  const top = matches.slice(0, 5);
  const lines = [`**Tìm thấy ${matches.length} khách với từ khóa "${kw}":**`, ''];
  top.forEach((m, i) => {
    const parts = [`**${m.name}**`];
    if (m.phone) parts.push(m.phone);
    if (m.rel) parts.push(m.rel);
    lines.push(`${i + 1}. ${parts.join(' · ')}`);
    if (m.snippet) lines.push(`   "${m.snippet}"`);
    lines.push('');
  });
  await sendTelegram(lines.join('\n').trim());
}

async function handleThongkeCommand() {
  const workspace = getWorkspace();
  if (!workspace) { await sendTelegram('Lỗi: không xác định được workspace.'); return; }

  const auditFile = path.join(workspace, 'logs', 'audit.jsonl');
  let tgReplies = 0, zaloReplies = 0, cronFired = 0;
  try {
    const stat = fs.statSync(auditFile);
    const readFrom = Math.max(0, stat.size - 64 * 1024);
    const fd = fs.openSync(auditFile, 'r');
    const buf = Buffer.alloc(stat.size - readFrom);
    fs.readSync(fd, buf, 0, buf.length, readFrom);
    fs.closeSync(fd);
    const lines = buf.toString('utf-8').split('\n');
    const todayStr = new Date().toISOString().slice(0, 10);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (!ev.t || !ev.t.startsWith(todayStr)) continue;
        const evt = String(ev.event || '');
        if (/telegram.*reply|reply.*telegram|telegram_send/i.test(evt)) tgReplies++;
        else if (/zalo.*reply|reply.*zalo|zalo_send/i.test(evt)) zaloReplies++;
        if (evt === 'cron_fired') cronFired++;
      } catch {}
    }
  } catch {}
  const totalReplies = tgReplies + zaloReplies;

  const dir = path.join(workspace, 'memory', 'zalo-users');
  let totalCustomers = 0, activeToday = 0;
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    totalCustomers = files.length;
    const todayStr = new Date().toISOString().slice(0, 10);
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
        const m = raw.match(/^---\n([\s\S]*?)\n---/);
        if (m) {
          const lsMatch = m[1].match(/lastSeen\s*:\s*(.+)/);
          if (lsMatch && lsMatch[1].trim().startsWith(todayStr)) activeToday++;
        }
      } catch {}
    }
  } catch {}

  const upSec = Math.floor(process.uptime());
  const upH = Math.floor(upSec / 3600);
  const upM = Math.floor((upSec % 3600) / 60);

  const now = new Date();
  const hhmm = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const ddmm = now.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });

  const lines = [
    `**Thống kê hôm nay (${hhmm} ${ddmm})**`,
    '',
    `Tin đã trả: ${totalReplies} (Telegram ${tgReplies} · Zalo ${zaloReplies})`,
    `Khách tương tác: ${activeToday} / ${totalCustomers} tổng`,
    `Cron đã chạy: ${cronFired}`,
    `Uptime: ${upH}g ${upM}p`,
  ];
  await sendTelegram(lines.join('\n'));
}

async function handleBaocaoCommand() {
  await sendTelegram('Đang chạy báo cáo, em sẽ gửi sau vài giây...');
  try {
    const timeStr = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const prompt = buildMorningBriefingPrompt(timeStr);
    runCronViaSessionOrFallback(prompt, { label: 'manual-baocao' }).catch(e => {
      console.error('[/baocao] runCronViaSessionOrFallback failed:', e?.message || e);
      sendTelegram('Xin lỗi, em chạy báo cáo bị lỗi. Thử lại sau vài phút giúp em.').catch(() => {});
    });
  } catch (e) {
    console.error('[/baocao] build prompt failed:', e?.message || e);
    await sendTelegram('Xin lỗi, em chạy báo cáo bị lỗi. Thử lại sau vài phút giúp em.');
  }
}

async function handleTelegramBuiltinCommand(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/')) return false;
  const firstSpace = raw.indexOf(' ');
  const head = (firstSpace >= 0 ? raw.slice(0, firstSpace) : raw).split('@')[0].toLowerCase();
  const args = firstSpace >= 0 ? raw.slice(firstSpace + 1) : '';
  if (head === '/tim') {
    await handleTimCommand(args);
    return true;
  }
  if (head === '/thongke') {
    await handleThongkeCommand();
    return true;
  }
  if (head === '/baocao') {
    await handleBaocaoCommand();
    return true;
  }
  return false;
}

// ============================================================
//   CUSTOM CRON MANAGEMENT
// ============================================================

function healCustomCronEntries(arr) {
  let healed = false;
  for (const c of arr) {
    if (!c || typeof c !== 'object') continue;
    if (!c.cronExpr && typeof c.cron === 'string') {
      c.cronExpr = c.cron;
      delete c.cron;
      healed = true;
    }
    if (!c.cronExpr && typeof c.schedule === 'string') {
      c.cronExpr = c.schedule;
      delete c.schedule;
      healed = true;
    }
    if (c.cronExpr && (/^\d{4}-\d{2}-\d{2}/.test(c.cronExpr) || /T\d{2}:\d{2}/.test(c.cronExpr))) {
      const isoVal = c.cronExpr;
      c.oneTimeAt = isoVal.replace(/\.000Z$/, '').replace(/Z$/, '');
      delete c.cronExpr;
      healed = true;
      console.log(`[custom-crons] auto-healed ISO cronExpr "${isoVal}" → oneTimeAt "${c.oneTimeAt}" for ${c.id || c.label || '(unknown)'}`);
    }
    if ((c.cronExpr || c.oneTimeAt) && c.prompt && c.enabled === undefined) {
      c.enabled = true;
      healed = true;
    }
    if (!c.id && (c.cronExpr || c.oneTimeAt)) {
      c.id = 'custom_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      healed = true;
    }
    if (!c.label && c.prompt) {
      c.label = String(c.prompt).trim().split('\n')[0].slice(0, 60);
      healed = true;
    }
    if (c.prompt && /^openzca\s+.*msg\s+send\s/i.test(c.prompt.trim())) {
      c.prompt = 'exec: ' + c.prompt.trim();
      healed = true;
      console.log(`[custom-crons] auto-healed missing exec: prefix for ${c.id || c.label || '(unknown)'}`);
    }
    if (!c.createdAt) {
      c.createdAt = new Date().toISOString();
      healed = true;
    }
  }
  return healed;
}

function loadCustomCrons() {
  const customCronsPath = getCustomCronsPath();
  let modoroEntries = [];
  try {
    if (fs.existsSync(customCronsPath)) {
      const raw = fs.readFileSync(customCronsPath, 'utf-8');
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
          throw new Error('custom-crons.json must be an array, got ' + typeof parsed);
        }
        const beforeLen = parsed.length;
        const cleaned = parsed.filter(c => !c || c.source !== 'openclaw');
        const ocStripped = beforeLen - cleaned.length;
        if (ocStripped > 0) {
          parsed.length = 0;
          Array.prototype.push.apply(parsed, cleaned);
          _withCustomCronLock(async () => {
            try {
              writeJsonAtomic(customCronsPath, cleaned);
              console.log(`[custom-crons] upgrade migration: stripped ${ocStripped} OpenClaw-merged entries`);
            } catch (e) { console.warn('[custom-crons] migration writeback failed:', e.message); }
          }).catch(() => {});
        }
        const wasHealed = healCustomCronEntries(parsed);
        if (wasHealed) {
          const snapshot = JSON.parse(JSON.stringify(parsed));
          _withCustomCronLock(async () => {
            try {
              writeJsonAtomic(customCronsPath, snapshot);
              console.log('[custom-crons] healed entries (alias/defaults) and rewrote file');
            } catch (e) { console.warn('[custom-crons] heal-writeback failed:', e.message); }
          }).catch(() => {});
        }
        modoroEntries = parsed;
      } catch (parseErr) {
        const backupPath = customCronsPath + '.corrupt-' + Date.now();
        try { fs.copyFileSync(customCronsPath, backupPath); } catch {}
        console.error(`[custom-crons] CORRUPT JSON in ${customCronsPath}: ${parseErr.message}. Backed up to ${backupPath}`);
        try {
          const errFile = path.join(getWorkspace(), '.learnings', 'ERRORS.md');
          fs.mkdirSync(path.dirname(errFile), { recursive: true });
          fs.appendFileSync(errFile, `\n## ${new Date().toISOString()} — custom-crons.json corrupt\n\nError: ${parseErr.message}\nBackup: ${backupPath}\nAll custom crons disabled until fixed. Restore from backup or recreate via Dashboard.\n`, 'utf-8');
        } catch {}
        sendCeoAlert(`Cảnh báo: custom-crons.json bị lỗi JSON\n\n${parseErr.message}\n\nFile gốc đã backup về: ${path.basename(backupPath)}. Tất cả custom cron sẽ KHÔNG chạy cho tới khi sửa file. Vào Dashboard, tab Cron để recreate hoặc khôi phục từ backup.`).catch((e) => { console.error('[loadCustomCrons] alert error:', e.message); });
      }
    } else {
      for (const p of legacyCustomCronsPaths) {
        if (p !== customCronsPath && fs.existsSync(p)) {
          try {
            const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
            try {
              writeJsonAtomic(customCronsPath, data);
              console.log('[custom-crons] Migrated:', p, '→', customCronsPath);
            } catch {}
            modoroEntries = data;
            break;
          } catch (e) {
            console.error(`[custom-crons] legacy file ${p} is corrupt:`, e.message);
          }
        }
      }
    }
  } catch (e) {
    console.error('[custom-crons] load error:', e.message);
  }

  let openclawEntries = [];
  try {
    const ocJobsPath = path.join(ctx.HOME, '.openclaw', 'cron', 'jobs.json');
    if (fs.existsSync(ocJobsPath)) {
      const raw = JSON.parse(fs.readFileSync(ocJobsPath, 'utf-8'));
      const jobs = Array.isArray(raw?.jobs) ? raw.jobs : [];
      const modoroIds = new Set(modoroEntries.map(c => c?.id).filter(Boolean));
      for (const j of jobs) {
        if (!j || !j.id) continue;
        if (modoroIds.has('oc_' + j.id)) continue;
        const schedExpr = j.schedule?.expr || j.schedule?.at || '';
        if (!schedExpr) continue;
        openclawEntries.push({
          id: 'oc_' + j.id,
          label: j.name || 'OpenClaw cron',
          cronExpr: schedExpr,
          prompt: j.payload?.text || j.payload?.message || '',
          enabled: j.enabled !== false,
          source: 'openclaw',
        });
      }
      if (openclawEntries.length > 0) {
        healCustomCronEntries(openclawEntries);
        for (const oc of openclawEntries) {
          if (oc.prompt && !oc.prompt.trim().startsWith('exec:') &&
              /(?:zalo|nhom|group|gui\s+tin|openzca)/i.test(oc.prompt)) {
            console.warn(`[custom-crons] OpenClaw cron "${oc.label}" looks like a Zalo send but is NOT in exec: format — agent will attempt natural language execution (unreliable). Prompt should be: exec: openzca --profile default msg send <groupId> "<text>" --group`);
          }
        }
        console.log(`[custom-crons] merged ${openclawEntries.length} OpenClaw cron(s) into scheduler`);
      }
    }
  } catch (e) {
    console.warn('[custom-crons] failed to read OpenClaw cron/jobs.json:', e?.message);
  }

  return [...modoroEntries, ...openclawEntries];
}

let customCronWatcher = null;
let schedulesWatcher = null;
let _watchPollerInterval = null;
let _lastCustomCronsMtime = 0;
let _lastSchedulesMtime = 0;
let _lastOcJobsMtime = 0;

function watchCustomCrons() {
  try {
    if (customCronWatcher) { try { customCronWatcher.close(); } catch {} customCronWatcher = null; }
    if (schedulesWatcher) { try { schedulesWatcher.close(); } catch {} schedulesWatcher = null; }
    if (_watchPollerInterval) { clearInterval(_watchPollerInterval); _watchPollerInterval = null; }

    const customCronsPath = getCustomCronsPath();
    const schedulesPath = getSchedulesPath();
    const dir = path.dirname(customCronsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(customCronsPath)) writeJsonAtomic(customCronsPath, []);
    if (!fs.existsSync(schedulesPath)) writeJsonAtomic(schedulesPath, loadSchedules());

    try { _lastCustomCronsMtime = fs.statSync(customCronsPath).mtimeMs; } catch {}
    try { _lastSchedulesMtime = fs.statSync(schedulesPath).mtimeMs; } catch {}
    const ocJobsPath = path.join(ctx.HOME, '.openclaw', 'cron', 'jobs.json');
    try { _lastOcJobsMtime = fs.statSync(ocJobsPath).mtimeMs; } catch {}

    let debounce1 = null;
    let debounce2 = null;
    if (!global._knownCronIds) {
      global._knownCronIds = new Set(loadCustomCrons().map(c => c && c.id).filter(Boolean));
    }
    const reloadCustom = () => {
      clearTimeout(debounce1);
      debounce1 = setTimeout(async () => {
        console.log('[cron] custom-crons.json changed, reloading...');
        try { restartCronJobs(); } catch (e) { console.error('[cron] reload error:', e.message); }
        const current = loadCustomCrons();
        if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
          ctx.mainWindow.webContents.send('custom-crons-updated', current);
        }
        try {
          const prevIds = global._knownCronIds || new Set();
          const currIds = new Set(current.map(c => c && c.id).filter(Boolean));
          const added = [];
          for (const c of current) {
            if (c && c.id && c.enabled !== false && (c.cronExpr || c.oneTimeAt) && c.prompt && !prevIds.has(c.id)) {
              added.push(c);
            }
          }
          global._knownCronIds = currIds;
          for (const c of added) {
            const schedule = c.cronExpr || c.oneTimeAt || '(unknown)';
            if (c.cronExpr) {
              const nodeCron = require('node-cron');
              const validExpr = typeof nodeCron.validate === 'function' ? nodeCron.validate(c.cronExpr) : true;
              if (!validExpr) continue;
            }
            const label = c.label || c.id;
            const schedType = c.oneTimeAt ? 'Một lần' : 'Lịch';
            const msg = `*Cron mới đã được lên lịch*\n\n` +
                        `Nhãn: \`${label}\`\n` +
                        `${schedType}: \`${schedule}\` (giờ VN)\n` +
                        `Prompt: ${String(c.prompt).slice(0, 200)}${c.prompt.length > 200 ? '...' : ''}\n\n` +
                        `Đây là xác nhận từ hệ thống — nếu bạn không yêu cầu cron này, vào Dashboard → Cron để xóa.`;
            try { await sendCeoAlert(msg); } catch {}
          }
        } catch (e) { console.error('[cron] new-entry confirmation error:', e.message); }
      }, 1000);
    };
    const reloadSchedules = () => {
      clearTimeout(debounce2);
      debounce2 = setTimeout(() => {
        console.log('[cron] schedules.json changed, reloading...');
        try { restartCronJobs(); } catch (e) { console.error('[cron] reload error:', e.message); }
        if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
          ctx.mainWindow.webContents.send('schedules-updated', loadSchedules());
        }
      }, 1000);
    };

    const safeWatch = (target, onChange) => {
      try {
        const w = fs.watch(target, (eventType) => {
          if (eventType === 'rename') {
            try { w.close(); } catch {}
            setTimeout(() => {
              try {
                if (target === customCronsPath) {
                  customCronWatcher = safeWatch(target, onChange);
                } else {
                  schedulesWatcher = safeWatch(target, onChange);
                }
              } catch (e) { console.error('[cron] re-watch error:', e.message); }
            }, 200);
          }
          onChange();
        });
        w.on('error', (e) => {
          console.error('[cron] watcher error on', target, '—', e.message, '(falling back to poller)');
        });
        return w;
      } catch (e) {
        console.error('[cron] fs.watch failed for', target, '—', e.message, '(poller will catch changes)');
        return null;
      }
    };
    customCronWatcher = safeWatch(customCronsPath, reloadCustom);
    schedulesWatcher = safeWatch(schedulesPath, reloadSchedules);

    _watchPollerInterval = setInterval(() => {
      try {
        const m1 = fs.statSync(customCronsPath).mtimeMs;
        if (m1 !== _lastCustomCronsMtime) {
          _lastCustomCronsMtime = m1;
          console.log('[cron] poller detected custom-crons.json mtime change');
          reloadCustom();
        }
      } catch {}
      try {
        const m2 = fs.statSync(schedulesPath).mtimeMs;
        if (m2 !== _lastSchedulesMtime) {
          _lastSchedulesMtime = m2;
          console.log('[cron] poller detected schedules.json mtime change');
          reloadSchedules();
        }
      } catch {}
      try {
        const m3 = fs.statSync(ocJobsPath).mtimeMs;
        if (m3 !== _lastOcJobsMtime) {
          _lastOcJobsMtime = m3;
          console.log('[cron] poller detected OpenClaw jobs.json mtime change');
          reloadCustom();
        }
      } catch {}
    }, 2000);
    _watchPollerInterval.unref?.();
  } catch (e) { console.error('[cron] watch error:', e.message); }
}

// ============================================================
//   startCronJobs + CRUD
// ============================================================

const cron = require('node-cron');
let cronJobs = [];
let _startCronJobsInFlight = false;
let _customCronWriteChain = Promise.resolve();

// Late-binding getter for _saveZaloManagerInFlight (lives in dashboard-ipc.js)
let _getSaveZaloManagerInFlight = () => false;
function setSaveZaloManagerInFlightGetter(fn) { _getSaveZaloManagerInFlight = fn; }

function startCronJobs() {
  if (_startCronJobsInFlight) { console.log('[cron] startCronJobs skipped — already in flight'); return; }
  _startCronJobsInFlight = true;
  try { _startCronJobsInner(); } finally { _startCronJobsInFlight = false; }
}

function _startCronJobsInner() {
  stopCronJobs();
  if (!global._cronInFlight) global._cronInFlight = new Map();

  selfTestOpenClawAgent()
    .then(async () => {
      if (!_agentCliVersionOk) {
        const msg = '[Cảnh báo cron] Không chạy được openclaw CLI khi khởi động. ' +
          'Cron job sáng/tối có thể không chạy được. Kiểm tra Dashboard → console để biết chi tiết.';
        try { await sendCeoAlert(msg); } catch {}
        console.warn('[startCronJobs] CLI health check failed — CEO alerted');
      }
    })
    .catch((e) => console.error('[cron-agent self-test] threw:', e?.message || e));

  const schedules = loadSchedules();

  for (const s of schedules) {
    if (!s.enabled) continue;

    let cronExpr = null;
    let handler = null;

    switch (s.id) {
      case 'morning': {
        const [h, m] = (s.time || '07:30').split(':');
        cronExpr = `${m !== undefined && m !== '' ? m : 30} ${h !== undefined && h !== '' ? h : 7} * * *`;
        handler = async () => {
          console.log('[cron] Morning briefing triggered at', new Date().toISOString());
          if (global._cronInFlight?.get('morning')) {
            console.warn('[cron] Morning SKIPPED — previous run still in flight');
            return;
          }
          global._cronInFlight?.set('morning', true);
          try {
            const prompt = buildMorningBriefingPrompt(s.time);
            await runCronViaSessionOrFallback(prompt, { label: 'morning-briefing' });
            try { auditLog('cron_fired', { id: 'morning', label: s.label || 'Báo cáo sáng' }); } catch {}
          } catch (e) {
            console.error('[cron] Morning handler threw:', e?.message || e);
            try { auditLog('cron_failed', { id: 'morning', label: s.label || 'Báo cáo sáng', error: String(e?.message || e).slice(0, 200) }); } catch {}
            try { await sendCeoAlert(`Cron "Báo cáo sáng" lỗi: ${String(e?.message || e).slice(0, 200)}`); } catch {}
          } finally {
            global._cronInFlight?.delete('morning');
          }
        };
        break;
      }
      case 'evening': {
        const [h, m] = (s.time || '21:00').split(':');
        cronExpr = `${m !== undefined && m !== '' ? m : 0} ${h !== undefined && h !== '' ? h : 21} * * *`;
        handler = async () => {
          console.log('[cron] Evening summary triggered at', new Date().toISOString());
          if (global._cronInFlight?.get('evening')) {
            console.warn('[cron] Evening SKIPPED — previous run still in flight');
            return;
          }
          global._cronInFlight?.set('evening', true);
          try {
            const prompt = buildEveningSummaryPrompt(s.time);
            await runCronViaSessionOrFallback(prompt, { label: 'evening-summary' });
            try { auditLog('cron_fired', { id: 'evening', label: s.label || 'Tóm tắt cuối ngày' }); } catch {}
          } catch (e) {
            console.error('[cron] Evening handler threw:', e?.message || e);
            try { auditLog('cron_failed', { id: 'evening', label: s.label || 'Tóm tắt cuối ngày', error: String(e?.message || e).slice(0, 200) }); } catch {}
            try { await sendCeoAlert(`Cron "Tóm tắt cuối ngày" lỗi: ${String(e?.message || e).slice(0, 200)}`); } catch {}
          } finally {
            global._cronInFlight?.delete('evening');
          }
        };
        break;
      }
      case 'heartbeat': {
        const timeStr = (s.time || '').toLowerCase();
        const m = timeStr.match(/(\d+)\s*ph[uú]t/);
        const everyMin = m ? Math.max(5, parseInt(m[1], 10)) : 10;
        cronExpr = `*/${everyMin} * * * *`;
        handler = async () => {
          try {
            if (_getSaveZaloManagerInFlight() || ctx.startOpenClawInFlight) {
              console.log('[heartbeat] skipping — user-triggered restart in progress');
              return;
            }
            const sinceGatewayStart = Date.now() - (global._gatewayStartedAt || 0);
            if (global._gatewayStartedAt && sinceGatewayStart < 360_000) {
              console.log(`[heartbeat] skipping — gateway only ${Math.round(sinceGatewayStart/1000)}s old (<6min grace)`);
              return;
            }
            const { isGatewayAlive, startOpenClaw, stopOpenClaw } = getGateway();
            const alive1 = await isGatewayAlive(30000);
            if (alive1) {
              try {
                const cfgPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
                const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
                if ((cfg?.channels?.['modoro-zalo'] || cfg?.channels?.openzalo)?.enabled === true && !isChannelPaused('zalo')) {
                  const lpid = findOpenzcaListenerPid();
                  if (lpid) {
                    global._zaloListenerMissStreak = 0;
                  } else {
                    global._zaloListenerMissStreak = (global._zaloListenerMissStreak || 0) + 1;
                    const streak = global._zaloListenerMissStreak;
                    console.log(`[zalo-watchdog] listener missing — streak=${streak}`);
                    if (streak < 3) { return; }
                    if (ctx.gatewayRestartInFlight || ctx.startOpenClawInFlight) {
                      console.log('[zalo-watchdog] restart already in-flight — skipping');
                      return;
                    }
                    const sinceBoot = Date.now() - (ctx.gatewayLastStartedAt || 0);
                    if (sinceBoot < 60_000) {
                      console.log(`[zalo-watchdog] gateway only ${sinceBoot}ms old — too fresh to restart`);
                      return;
                    }
                    const lastRestart = global._zaloListenerLastRestartAt || 0;
                    const sinceRestart = Date.now() - lastRestart;
                    if (lastRestart > 0 && sinceRestart < 10 * 60_000) {
                      console.log(`[zalo-watchdog] last restart ${Math.round(sinceRestart/1000)}s ago — waiting out 10min cooldown`);
                      return;
                    }
                    global._zaloListenerRestartHistory = (global._zaloListenerRestartHistory || []).filter(ts => (Date.now() - ts) < 2 * 60 * 60_000);
                    if (global._zaloListenerGaveUp) {
                      console.log('[zalo-watchdog] already gave up after 3 restarts in 2h — waiting for manual Save/resume');
                      return;
                    }
                    if (global._zaloListenerRestartHistory.length >= 3) {
                      console.log('[zalo-watchdog] 3 restarts in 2h — giving up, alerting CEO');
                      global._zaloListenerGaveUp = true;
                      const _fwAlertAge = Date.now() - (global._zaloListenerAlertSentAt || 0);
                      if (global._zaloListenerAlertSentAt && _fwAlertAge < 15 * 60 * 1000) {
                        console.log(`[zalo-watchdog] skipping CEO alert — fast watchdog already alerted ${Math.round(_fwAlertAge/1000)}s ago`);
                      } else {
                        try { await sendCeoAlert('Listener Zalo đang không ổn định, vui lòng kiểm tra kết nối mạng'); } catch {}
                        global._zaloListenerAlertSentAt = Date.now();
                      }
                      return;
                    }
                    console.log('[zalo-watchdog] gateway alive but Zalo listener dead (3 misses) — hard-restart');
                    global._zaloListenerLastRestartAt = Date.now();
                    global._zaloListenerRestartHistory.push(Date.now());
                    global._zaloListenerMissStreak = 0;
                    if (ctx.gatewayRestartInFlight) return;
                    ctx.gatewayRestartInFlight = true;
                    try {
                      try { await stopOpenClaw(); } catch {}
                      await new Promise(r => setTimeout(r, 5000));
                      try { await startOpenClaw({ silent: true }); } catch (e) { console.error('[zalo-watchdog] zalo restart failed:', e.message); }
                    } finally {
                      ctx.gatewayRestartInFlight = false;
                    }
                  }
                }
              } catch {}
              return;
            }
            await new Promise(r => setTimeout(r, 5000));
            const alive2 = await isGatewayAlive(30000);
            if (alive2) {
              console.log('[heartbeat] gateway slow but alive — skipping restart');
              return;
            }
            await new Promise(r => setTimeout(r, 5000));
            const alive3 = await isGatewayAlive(30000);
            if (alive3) {
              console.log('[heartbeat] gateway slow but alive (3rd probe) — skipping restart');
              return;
            }
            if (ctx.gatewayRestartInFlight || ctx.startOpenClawInFlight) {
              console.log('[heartbeat] restart already in-flight — skipping gateway-dead restart');
              return;
            }
            console.log('[heartbeat] Gateway not responding (3 consecutive failures) — auto-restarting');
            ctx.gatewayRestartInFlight = true;
            try {
              try { await stopOpenClaw(); } catch {}
              await new Promise(r => setTimeout(r, 5000));
              try { await startOpenClaw({ silent: true }); } catch (e) {
                console.error('[heartbeat] restart failed:', e.message);
              }
            } finally {
              ctx.gatewayRestartInFlight = false;
            }
          } catch (e) {
            console.error('[heartbeat] error:', e.message);
            try { await sendCeoAlert(`[Heartbeat] Lỗi: ${String(e?.message || e).slice(0, 200)}`); } catch {}
            try { auditLog('heartbeat_error', { error: String(e?.message || e).slice(0, 200) }); } catch {}
          }
        };
        break;
      }
      case 'meditation': {
        cronExpr = '0 1 * * *';
        handler = async () => {
          console.log('[cron] Meditation triggered at', new Date().toISOString());
          if (global._cronInFlight?.get('meditation')) return;
          global._cronInFlight?.set('meditation', true);
          try {
            const prompt = buildMeditationPrompt();
            await runCronAgentPrompt(prompt, { label: 'meditation' });
            try { auditLog('cron_fired', { id: 'meditation', label: 'Tối ưu ban đêm' }); } catch {}
          } catch (e) {
            console.error('[cron] Meditation threw:', e?.message || e);
            try { auditLog('cron_failed', { id: 'meditation', label: 'Tối ưu ban đêm', error: String(e?.message || e).slice(0, 200) }); } catch {}
            try { await sendCeoAlert(`Cron "Tối ưu ban đêm" lỗi: ${String(e?.message || e).slice(0, 200)}`); } catch {}
          } finally { global._cronInFlight?.delete('meditation'); }
        };
        break;
      }
      case 'weekly': {
        const [h, m] = (s.time || '08:00').split(':');
        cronExpr = `${m !== undefined && m !== '' ? m : 0} ${h !== undefined && h !== '' ? h : 8} * * 1`;
        handler = async () => {
          console.log('[cron] Weekly report triggered at', new Date().toISOString());
          if (global._cronInFlight?.get('weekly')) return;
          global._cronInFlight?.set('weekly', true);
          try {
            const prompt = await buildWeeklyReportPrompt();
            await runCronViaSessionOrFallback(prompt, { label: 'weekly-report' });
            try { auditLog('cron_fired', { id: 'weekly', label: s.label || 'Báo cáo tuần' }); } catch {}
          } catch (e) {
            console.error('[cron] Weekly handler threw:', e?.message || e);
            try { auditLog('cron_failed', { id: 'weekly', label: 'Báo cáo tuần', error: String(e?.message || e).slice(0, 200) }); } catch {}
            try { await sendCeoAlert(`Cron "Báo cáo tuần" lỗi: ${String(e?.message || e).slice(0, 200)}`); } catch {}
          } finally { global._cronInFlight?.delete('weekly'); }
        };
        break;
      }
      case 'monthly': {
        const [h, m] = (s.time || '08:30').split(':');
        cronExpr = `${m !== undefined && m !== '' ? m : 30} ${h !== undefined && h !== '' ? h : 8} 1 * *`;
        handler = async () => {
          console.log('[cron] Monthly report triggered at', new Date().toISOString());
          if (global._cronInFlight?.get('monthly')) return;
          global._cronInFlight?.set('monthly', true);
          try {
            const prompt = buildMonthlyReportPrompt();
            await runCronViaSessionOrFallback(prompt, { label: 'monthly-report' });
            try { auditLog('cron_fired', { id: 'monthly', label: s.label || 'Báo cáo tháng' }); } catch {}
          } catch (e) {
            console.error('[cron] Monthly handler threw:', e?.message || e);
            try { auditLog('cron_failed', { id: 'monthly', label: 'Báo cáo tháng', error: String(e?.message || e).slice(0, 200) }); } catch {}
            try { await sendCeoAlert(`Cron "Báo cáo tháng" lỗi: ${String(e?.message || e).slice(0, 200)}`); } catch {}
          } finally { global._cronInFlight?.delete('monthly'); }
        };
        break;
      }
      case 'zalo-followup': {
        const [h, m] = (s.time || '09:30').split(':');
        cronExpr = `${m ?? '30'} ${h ?? '9'} * * *`;
        handler = async () => {
          console.log('[cron] Zalo follow-up triggered at', new Date().toISOString());
          if (global._cronInFlight?.get('zalo-followup')) return;
          global._cronInFlight?.set('zalo-followup', true);
          try {
            const ws = getWorkspace();
            const candidates = ws ? scanZaloFollowUpCandidates(ws) : [];
            const prompt = buildZaloFollowUpPrompt(candidates);
            await runCronAgentPrompt(prompt, { label: 'zalo-followup' });
            try { auditLog('cron_fired', { id: 'zalo-followup', label: 'Follow-up khách Zalo', candidateCount: candidates.length }); } catch {}
          } catch (e) {
            console.error('[cron] Zalo follow-up threw:', e?.message || e);
            try { auditLog('cron_failed', { id: 'zalo-followup', label: 'Follow-up khách Zalo', error: String(e?.message || e).slice(0, 200) }); } catch {}
            try { await sendCeoAlert(`Cron "Follow-up khách Zalo" lỗi: ${String(e?.message || e).slice(0, 200)}`); } catch {}
          } finally { global._cronInFlight?.delete('zalo-followup'); }
        };
        break;
      }
      case 'memory-cleanup': {
        cronExpr = '0 2 * * 0';
        handler = async () => {
          console.log('[cron] Memory cleanup triggered at', new Date().toISOString());
          if (global._cronInFlight?.get('memory-cleanup')) return;
          global._cronInFlight?.set('memory-cleanup', true);
          try {
            const prompt = buildMemoryCleanupPrompt();
            await runCronAgentPrompt(prompt, { label: 'memory-cleanup' });
            try { auditLog('cron_fired', { id: 'memory-cleanup', label: 'Dọn dẹp memory' }); } catch {}
          } catch (e) {
            console.error('[cron] Memory cleanup threw:', e?.message || e);
            try { auditLog('cron_failed', { id: 'memory-cleanup', label: 'Dọn dẹp memory', error: String(e?.message || e).slice(0, 200) }); } catch {}
            try { await sendCeoAlert(`Cron "Dọn dẹp memory" lỗi: ${String(e?.message || e).slice(0, 200)}`); } catch {}
          } finally { global._cronInFlight?.delete('memory-cleanup'); }
        };
        break;
      }
    }

    if (cronExpr && handler) {
      try {
        const job = cron.schedule(cronExpr, handler, { timezone: 'Asia/Ho_Chi_Minh' });
        cronJobs.push({ id: s.id, job });
        console.log(`[cron] Scheduled ${s.id}: ${cronExpr}`);
      } catch (e) { console.error(`[cron] Failed to schedule ${s.id}:`, e.message); }
    }
  }

  // Weekly gateway restart
  try {
    const { startOpenClaw, stopOpenClaw } = getGateway();
    const weeklyRestart = cron.schedule('30 3 * * 3', async () => {
      if (!global._cronInFlight) global._cronInFlight = new Map();
      if (global._cronInFlight.has('weekly-gateway-restart')) return;
      if (ctx.gatewayRestartInFlight) {
        console.log('[cron] Weekly gateway restart skipped — restart already in-flight');
        return;
      }
      global._cronInFlight.set('weekly-gateway-restart', Date.now());
      console.log('[cron] Weekly gateway restart for memory hygiene');
      try { auditLog('cron_fired', { id: 'weekly-gateway-restart', label: 'Weekly memory hygiene' }); } catch {}
      try {
        await stopOpenClaw();
        await startOpenClaw({ silent: true });
        console.log('[cron] Weekly gateway restart completed');
      } catch (e) {
        console.error('[cron] Weekly gateway restart failed:', e?.message);
        try { await sendCeoAlert(`Cron "Weekly restart" lỗi: ${String(e?.message || e).slice(0, 200)}`); } catch {}
        try { auditLog('cron_failed', { id: 'weekly-gateway-restart', error: String(e?.message || e).slice(0, 200) }); } catch {}
      } finally {
        global._cronInFlight.delete('weekly-gateway-restart');
      }
    }, { timezone: 'Asia/Ho_Chi_Minh' });
    cronJobs.push({ id: 'weekly-gateway-restart', job: weeklyRestart });
    console.log('[cron] Scheduled weekly-gateway-restart: 30 3 * * 3');
  } catch (e) { console.error('[cron] Failed to schedule weekly restart:', e?.message); }

  // Custom crons
  const customs = loadCustomCrons();
  if (!global._cronInFlight) global._cronInFlight = new Map();
  for (const c of customs) {
    if (!c) continue;
    if (!c.enabled) continue;
    if (!c.prompt || !c.prompt.trim()) {
      console.warn(`[cron] custom cron ${c.id || '(no id)'} skipped — empty prompt`);
      surfaceCronConfigError(c, 'empty prompt field');
      continue;
    }
    if (c.oneTimeAt && !c.cronExpr) {
      try {
        const fireAt = new Date(c.oneTimeAt);
        const delayMs = fireAt.getTime() - Date.now();
        if (isNaN(fireAt.getTime())) {
          surfaceCronConfigError(c, `oneTimeAt invalid date: "${c.oneTimeAt}"`);
          continue;
        }
        if (delayMs < -60000) {
          console.log(`[cron] oneTime ${c.id} already past (${c.oneTimeAt}) — removing`);
          _removeCustomCronById(c.id).catch(e => console.error(`[cron] remove past-due ${c.id} failed:`, e?.message));
          continue;
        }
        const effectiveDelay = Math.max(delayMs, 1000);
        const timer = setTimeout(async () => {
          console.log(`[cron] OneTime "${c.label || c.id}" firing at`, new Date().toISOString());
          try {
            if (c.prompt && !c.prompt.startsWith('exec:')) {
              await runCronViaSessionOrFallback(c.prompt, { label: c.label || c.id });
            } else {
              await runCronAgentPrompt(c.prompt, { label: c.label || c.id });
            }
            try { auditLog('cron_fired', { id: c.id, label: c.label || c.id, kind: 'one-time' }); } catch {}
          } catch (e) {
            console.error(`[cron] OneTime ${c.id} failed:`, e?.message);
            try { auditLog('cron_failed', { id: c.id, label: c.label || c.id, kind: 'one-time', error: String(e?.message || e).slice(0, 200) }); } catch {}
            try { await sendCeoAlert(`*Cron một lần "${c.label || c.id}" lỗi*\n\n\`${String(e?.message || e).slice(0, 300)}\``); } catch {}
          }
          try { await _removeCustomCronById(c.id); } catch (re) { console.error(`[cron] remove oneTime ${c.id} failed:`, re?.message); }
        }, effectiveDelay);
        cronJobs.push({ id: c.id, job: { stop: () => clearTimeout(timer) } });
        console.log(`[cron] OneTime scheduled ${c.id}: ${c.oneTimeAt} (in ${Math.round(effectiveDelay / 1000)}s)`);
      } catch (e) {
        surfaceCronConfigError(c, `oneTimeAt setup failed: ${e.message}`);
      }
      continue;
    }
    if (!c.cronExpr) {
      console.warn(`[cron] custom cron ${c.id || '(no id)'} skipped — missing cronExpr`);
      surfaceCronConfigError(c, 'missing cronExpr field');
      continue;
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(c.cronExpr) || /T\d{2}:\d{2}/.test(c.cronExpr)) {
      console.log(`[cron] inline-healing ISO cronExpr "${c.cronExpr}" → oneTimeAt for ${c.id}`);
      c.oneTimeAt = c.cronExpr.replace(/\.000Z$/, '').replace(/Z$/, '');
      delete c.cronExpr;
      _withCustomCronLock(async () => {
        const customCronsPath = getCustomCronsPath();
        const all = loadCustomCrons();
        const idx = all.findIndex(x => x && x.id === c.id);
        if (idx >= 0) { all[idx] = c; writeJsonAtomic(customCronsPath, all); }
      }).catch(e => { console.warn('[cron] inline-heal write failed:', e?.message); });
    }
    if (c.oneTimeAt && !c.cronExpr) {
      try {
        const fireAt = new Date(c.oneTimeAt);
        const delayMs = fireAt.getTime() - Date.now();
        if (isNaN(fireAt.getTime())) {
          surfaceCronConfigError(c, `oneTimeAt invalid date: "${c.oneTimeAt}"`);
          continue;
        }
        if (delayMs < -60000) {
          console.log(`[cron] oneTime ${c.id} already past (${c.oneTimeAt}) — removing`);
          _removeCustomCronById(c.id).catch(e => console.error(`[cron] remove past-due ${c.id} failed:`, e?.message));
          continue;
        }
        const effectiveDelay = Math.max(delayMs, 1000);
        const timer = setTimeout(async () => {
          console.log(`[cron] OneTime "${c.label || c.id}" firing at`, new Date().toISOString());
          try {
            if (c.prompt && !c.prompt.startsWith('exec:')) {
              await runCronViaSessionOrFallback(c.prompt, { label: c.label || c.id });
            } else {
              await runCronAgentPrompt(c.prompt, { label: c.label || c.id });
            }
            try { auditLog('cron_fired', { id: c.id, label: c.label || c.id, kind: 'one-time-healed' }); } catch {}
          } catch (e) {
            console.error(`[cron] OneTime ${c.id} failed:`, e?.message);
            try { auditLog('cron_failed', { id: c.id, label: c.label || c.id, kind: 'one-time-healed', error: String(e?.message || e).slice(0, 200) }); } catch {}
            try { await sendCeoAlert(`*Cron một lần "${c.label || c.id}" lỗi*\n\n\`${String(e?.message || e).slice(0, 300)}\``); } catch {}
          }
          try { await _removeCustomCronById(c.id); } catch (re) { console.error(`[cron] remove oneTime ${c.id} failed:`, re?.message); }
        }, effectiveDelay);
        cronJobs.push({ id: c.id, job: { stop: () => clearTimeout(timer) } });
        console.log(`[cron] OneTime (inline-healed) scheduled ${c.id}: ${c.oneTimeAt} (in ${Math.round(effectiveDelay / 1000)}s)`);
      } catch (e) {
        surfaceCronConfigError(c, `oneTimeAt setup failed: ${e.message}`);
      }
      continue;
    }
    if (typeof cron.validate === 'function' && !cron.validate(c.cronExpr)) {
      console.error(`[cron] custom cron ${c.id} has INVALID cronExpr: "${c.cronExpr}"`);
      surfaceCronConfigError(c, `invalid cron expression: "${c.cronExpr}"`);
      continue;
    }
    try {
      const job = cron.schedule(c.cronExpr, async () => {
        const niceId = c.id || c.label || 'cron';
        if (global._cronInFlight.get(niceId)) {
          console.warn(`[cron] Custom "${c.label || c.id}" SKIPPED — previous run still in flight`);
          journalCronRun({ phase: 'skip', label: c.label || c.id, reason: 'previous-still-in-flight' });
          return;
        }
        global._cronInFlight.set(niceId, true);
        try {
          console.log(`[cron] Custom "${c.label || c.id}" triggered at`, new Date().toISOString());
          const ok = (c.prompt && !c.prompt.startsWith('exec:'))
            ? await runCronViaSessionOrFallback(c.prompt, { label: c.label || c.id })
            : await runCronAgentPrompt(c.prompt, { label: c.label || c.id });
          console.log(`[cron] Custom ${c.id} agent run result:`, ok);
          try { auditLog('cron_fired', { id: c.id, label: c.label || c.id, kind: 'custom' }); } catch {}
        } catch (e) {
          console.error(`[cron] Custom ${c.id} handler threw (suppressed):`, e?.message || e);
          journalCronRun({ phase: 'fail', label: c.label || c.id, reason: 'handler-threw', err: String(e?.message || e).slice(0, 300) });
          try { auditLog('cron_failed', { id: c.id, label: c.label || c.id, kind: 'custom', error: String(e?.message || e).slice(0, 200) }); } catch {}
          try { await sendCeoAlert(`*Cron "${c.label || c.id}" lỗi nội bộ*\n\n\`${String(e?.message || e).slice(0, 300)}\``); } catch {}
        } finally {
          global._cronInFlight.delete(niceId);
        }
      }, { timezone: 'Asia/Ho_Chi_Minh' });
      cronJobs.push({ id: c.id, job });
      console.log(`[cron] Custom scheduled ${c.id}: ${c.cronExpr} → "${c.prompt.substring(0, 50)}..."`);
    } catch (e) {
      console.error(`[cron] Failed custom ${c.id}:`, e.message);
      surfaceCronConfigError(c, `cron.schedule threw: ${e.message}`);
    }
  }
}

async function _withCustomCronLock(fn) {
  let release;
  const gate = new Promise(r => { release = r; });
  const prev = _customCronWriteChain;
  _customCronWriteChain = gate;
  await prev;
  try { return await fn(); } finally { release(); }
}

async function _removeCustomCronById(id) {
  await _withCustomCronLock(async () => {
    try {
      const p = path.join(getWorkspace(), 'custom-crons.json');
      if (!fs.existsSync(p)) return;
      const arr = JSON.parse(fs.readFileSync(p, 'utf-8'));
      const filtered = Array.isArray(arr) ? arr.filter(e => e?.id !== id) : arr;
      writeJsonAtomic(p, filtered);
      console.log(`[cron] removed one-time entry ${id} from custom-crons.json`);
    } catch (e) { console.warn(`[cron] _removeCustomCronById(${id}) error:`, e?.message); }
  });
}

function surfaceCronConfigError(c, reason) {
  try {
    const errFile = path.join(getWorkspace(), '.learnings', 'ERRORS.md');
    fs.mkdirSync(path.dirname(errFile), { recursive: true });
    fs.appendFileSync(errFile, `\n## ${new Date().toISOString()} — custom-cron config error\n\nCron: \`${c?.label || c?.id || '?'}\` (id: \`${c?.id || '?'}\`)\nReason: ${reason}\nExpr: \`${c?.cronExpr || '?'}\`\nPrompt (first 100 chars): ${(c?.prompt || '').slice(0, 100)}\n`, 'utf-8');
  } catch (e) { console.error('[surfaceCronConfigError] write error:', e.message); }
  sendCeoAlert(`*Cron "${c?.label || c?.id || '?'}" cấu hình sai*\n\n${reason}\n\nCron sẽ KHÔNG chạy cho tới khi sửa. Vào Dashboard → Cron để fix.`).catch((e) => { console.error('[surfaceCronConfigError] alert error:', e.message); });
}

function stopCronJobs() {
  for (const { job } of cronJobs) { try { job.stop(); } catch {} }
  cronJobs = [];
}

function restartCronJobs() {
  startCronJobs();
}

// ============================================================
//   DASHBOARD OVERVIEW HELPERS
// ============================================================

const _OVERVIEW_EVENT_LABELS = {
  app_boot: { label: 'Khởi động bot', icon: 'zap', show: true },
  gateway_ready: { label: 'Bot sẵn sàng nhận tin', icon: 'check', show: true },
  gateway_slow_start: { label: 'Bot khởi động chậm', icon: 'clock', show: true },
  zalo_output_blocked: { label: 'Bộ lọc chặn 1 tin Zalo', icon: 'shield', show: true },
  cron_fired: { label: 'Cron đã chạy', icon: 'calendar', show: true },
  cron_failed: { label: 'Cron lỗi', icon: 'alert', show: true },
  zalo_owner_set: { label: 'Đã đặt chủ Zalo', icon: 'user', show: true },
  system_resume: { label: 'Mac thức dậy', icon: 'power', show: true },
  system_suspend: { label: 'Mac đang ngủ', icon: 'moon', show: true },
};

function _readJsonlTail(filePath, maxLines) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const stat = fs.statSync(filePath);
    const SIZE = stat.size;
    if (SIZE === 0) return [];
    const READ_BYTES = Math.min(SIZE, 64 * 1024);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(READ_BYTES);
    fs.readSync(fd, buf, 0, READ_BYTES, SIZE - READ_BYTES);
    fs.closeSync(fd);
    const text = buf.toString('utf-8');
    const lines = text.split('\n').filter(Boolean);
    if (SIZE > READ_BYTES && lines.length > 1) lines.shift();
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
      try { out.push(JSON.parse(lines[i])); } catch {}
    }
    return out;
  } catch (e) {
    console.warn('[overview] readJsonlTail error:', e?.message);
    return [];
  }
}

function _readCeoNameFromIdentity() {
  try {
    const ws = getWorkspace();
    if (!ws) return { name: '', title: '' };
    const idPath = path.join(ws, 'IDENTITY.md');
    if (!fs.existsSync(idPath)) return { name: '', title: '' };
    const content = fs.readFileSync(idPath, 'utf-8');
    const match = content.match(/Cách xưng hô:\*\*\s*([^\n\[]+)/i)
               || content.match(/Cách xưng hô:\s*([^\n\[]+)/i);
    if (!match) return { name: '', title: '' };
    let raw = match[1].trim();
    raw = raw.replace(/^(em|tôi|mình)\s*[—–\-]+\s*gọi\s+(chủ nhân là\s+)?/i, '');
    raw = raw.split(/[,(]/)[0].trim();
    const title = raw.slice(0, 40);
    let name = raw.replace(/^(anh|chị|anh\/chị|quý Sếp|thầy|cô|bác|chú)\s+/i, '');
    name = name.slice(0, 40);
    return { name, title };
  } catch { return { name: '', title: '' }; }
}

function _readRecentZaloCustomers(ws, limit = 5) {
  try {
    const dir = path.join(ws, 'memory', 'zalo-users');
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    const customers = [];
    for (const f of files) {
      try {
        const fp = path.join(dir, f);
        const stat = fs.statSync(fp);
        const content = fs.readFileSync(fp, 'utf-8');
        let name = '', lastSeen = '', msgCount = 0;
        const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const fm = fmMatch[1];
          const nameM = fm.match(/name:\s*(.+)/i);
          if (nameM) name = nameM[1].trim().replace(/^["']|["']$/g, '');
          const lsM = fm.match(/lastSeen:\s*(.+)/i);
          if (lsM) lastSeen = lsM[1].trim().replace(/^["']|["']$/g, '');
          const mcM = fm.match(/msgCount:\s*(\d+)/i);
          if (mcM) msgCount = parseInt(mcM[1], 10);
        }
        let summary = '';
        const sumMatch = content.match(/##\s*Tóm tắt\s*\n+([\s\S]*?)(?:\n##|\n---|\s*$)/i);
        if (sumMatch) {
          summary = sumMatch[1].trim().split('\n')[0].replace(/^[-*]\s*/, '').trim();
          if (summary.length > 80) summary = summary.slice(0, 77) + '...';
        }
        const senderId = f.replace(/\.md$/, '');
        const sortTime = lastSeen ? new Date(lastSeen).getTime() : stat.mtimeMs;
        if (!name) name = senderId;
        customers.push({ name, lastSeen: lastSeen || stat.mtime.toISOString(), summary, senderId, msgCount, _sortTime: sortTime });
      } catch {}
    }
    customers.sort((a, b) => b._sortTime - a._sortTime);
    return customers.slice(0, limit).map(c => ({ name: c.name, lastSeen: c.lastSeen, summary: c.summary, senderId: c.senderId, msgCount: c.msgCount }));
  } catch { return []; }
}

function _nextFireTime(timeStr, now = new Date(), cronExpr = null) {
  if (cronExpr) {
    try {
      const parts = String(cronExpr).trim().split(/\s+/);
      if (parts.length >= 5) {
        const [minF, hourF, domF, monF, dowF] = parts;
        const _expandField = (f, min, max) => {
          if (f === '*') return null;
          const vals = new Set();
          for (const seg of f.split(',')) {
            const stepMatch = seg.match(/^(?:(\d+)-(\d+)|\*)\/(\d+)$/);
            if (stepMatch) {
              const lo = stepMatch[1] != null ? parseInt(stepMatch[1]) : min;
              const hi = stepMatch[2] != null ? parseInt(stepMatch[2]) : max;
              const step = parseInt(stepMatch[3] || '1');
              for (let i = lo; i <= hi; i += step) vals.add(i);
            } else if (seg.includes('-')) {
              const [a, b] = seg.split('-').map(Number);
              for (let i = a; i <= b; i++) vals.add(i);
            } else {
              vals.add(parseInt(seg));
            }
          }
          return vals.size ? vals : null;
        };
        const minSet = _expandField(minF, 0, 59);
        const hourSet = _expandField(hourF, 0, 23);
        const domSet = _expandField(domF, 1, 31);
        const monSet = _expandField(monF, 1, 12);
        const dowSet = _expandField(dowF, 0, 6);
        const candidate = new Date(now.getTime() + 60000);
        candidate.setSeconds(0, 0);
        for (let i = 0; i < 1440 * 31; i++) {
          const m = candidate.getMinutes(), h = candidate.getHours(), d = candidate.getDay();
          const dom = candidate.getDate(), mon = candidate.getMonth() + 1;
          if ((!minSet || minSet.has(m)) && (!hourSet || hourSet.has(h)) && (!domSet || domSet.has(dom)) && (!monSet || monSet.has(mon)) && (!dowSet || dowSet.has(d))) {
            return candidate.toISOString();
          }
          candidate.setTime(candidate.getTime() + 60000);
        }
      }
    } catch {}
    return null;
  }
  if (!timeStr) return null;
  const everyMatch = String(timeStr).match(/Mỗi\s+(\d+)\s*phút/i);
  if (everyMatch) {
    const n = parseInt(everyMatch[1], 10);
    if (!isFinite(n) || n < 1) return null;
    const next = new Date(now.getTime() + n * 60 * 1000);
    return next.toISOString();
  }
  const hhmm = String(timeStr).match(/^(\d{1,2}):(\d{2})$/);
  if (hhmm) {
    const h = parseInt(hhmm[1], 10), m = parseInt(hhmm[2], 10);
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    const next = new Date(now);
    next.setHours(h, m, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }
  return null;
}

// ============================================================
//   CLEANUP
// ============================================================

function cleanupCronTimers() {
  stopCronJobs();
  if (_watchPollerInterval) { clearInterval(_watchPollerInterval); _watchPollerInterval = null; }
  if (customCronWatcher) { try { customCronWatcher.close(); } catch {} customCronWatcher = null; }
  if (schedulesWatcher) { try { schedulesWatcher.close(); } catch {} schedulesWatcher = null; }
}

// ============================================================
//   EXPORTS
// ============================================================

module.exports = {
  // Agent pipeline
  cronJournalPath, journalCronRun, selfTestOpenClawAgent,
  buildAgentArgs, isTransientErr, isConfigInvalidErr, isFatalErr,
  parseSafeOpenzcaMsgSend, runSafeExecCommand,
  runCronAgentPrompt,
  runCronViaSessionOrFallback,
  // Schedule management
  getSchedulesPath, getCustomCronsPath,
  loadSchedules, loadCustomCrons,
  loadDailySummaries, generateWeeklySummary, loadWeeklySummaries,
  loadPromptTemplate,
  // Prompt builders
  buildMorningBriefingPrompt, buildEveningSummaryPrompt,
  buildWeeklyReportPrompt, buildMonthlyReportPrompt,
  scanZaloFollowUpCandidates, buildZaloFollowUpPrompt,
  buildMeditationPrompt, buildMemoryCleanupPrompt,
  // Cron lifecycle
  healCustomCronEntries, watchCustomCrons,
  startCronJobs, stopCronJobs, restartCronJobs,
  // CRUD helpers
  _withCustomCronLock, _removeCustomCronById, surfaceCronConfigError,
  // Telegram builtins
  handleTimCommand, handleThongkeCommand, handleBaocaoCommand,
  handleTelegramBuiltinCommand,
  // Dashboard overview helpers
  _readJsonlTail, _readCeoNameFromIdentity, _readRecentZaloCustomers, _nextFireTime,
  _OVERVIEW_EVENT_LABELS,
  // Cleanup
  cleanupCronTimers,
  // Late-binding setters
  setSaveZaloManagerInFlightGetter,
  // Getters for state needed by IPC
  getAgentFlagProfile: () => _agentFlagProfile,
  getAgentCliHealthy: () => _agentCliHealthy,
};
