'use strict';
const fs = require('fs');
const path = require('path');
const ctx = require('./context');
const { writeJsonAtomic, tokenizeShellish } = require('./util');
const { getWorkspace, DEFAULT_SCHEDULES_JSON, auditLog } = require('./workspace');
const { findOpenClawCliJs, spawnOpenClawSafe } = require('./boot');
const { healOpenClawConfigInline, setJournalCronRun } = require('./config');
const {
  sendTelegram, sendCeoAlert, sendZaloTo, filterSensitiveOutput,
  isZaloListenerAlive,
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

const CRON_AGENT_TIMEOUT_MS = 600000;
const CRON_AGENT_MAX_RETRIES = 3;
const CRON_TRANSIENT_BACKOFF_BASE_MS = 5000;
const CRON_DEFAULT_BACKOFF_BASE_MS = 2000;

let _agentFlagProfile = null;   // 'full' | 'medium' | 'minimal'
let _agentCliHealthy = false;
let _lastSelfTestStderr = '';
let _agentCliVersionOk = false; // true only when --version call succeeds
let _selfTestAlertSent = false;
let _selfTestPromise = null;

/** @returns {string|null} Path to cron-runs.jsonl journal file */
function getCronJournalPath() {
  const ws = getWorkspace();
  if (!ws) return null;
  return path.join(ws, 'logs', 'cron-runs.jsonl');
}
function journalCronRun(entry) {
  try {
    const file = getCronJournalPath();
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n', 'utf-8');
  } catch (e) {
    console.error('[cron-journal] write error:', e.message);
  }
}

// Wire journalCronRun into config.js so config can call it without circular dep
setJournalCronRun(journalCronRun);

function inferMemoryTaskType(text) {
  const t = String(text || '').toLowerCase();
  if (/sheet|excel|xlsx|google|gmail|drive|calendar/.test(t)) return 'google_workspace';
  if (/facebook|fanpage|insight|fb\b/.test(t)) return 'facebook';
  if (/zalo|whatsapp|telegram|lark/.test(t)) return 'channel_workflow';
  if (/docx|word|pptx|powerpoint|pdf|slide/.test(t)) return 'document_generation';
  if (/ảnh|hình|image|poster|banner/.test(t)) return 'image_generation';
  return 'workflow';
}

async function injectMemoryOsContext(prompt, { label = '' } = {}) {
  try {
    const { getMemoryContext } = require('./ceo-memory');
    const ctx = await getMemoryContext({
      query: [label, prompt].filter(Boolean).join('\n'),
      channel: 'telegram',
      taskType: inferMemoryTaskType([label, prompt].join(' ')),
      intent: label,
      limit: 10,
    });
    if (!ctx.memories?.length && !ctx.procedures?.length && !ctx.safetyWarnings?.length) return prompt;
    const compact = {
      scopes: ctx.scopes,
      memories: (ctx.memories || []).map(m => ({
        id: m.id,
        type: m.type,
        scope: m.scope,
        content: m.content,
        evidenceIds: m.evidence_event_ids || [],
      })),
      procedures: (ctx.procedures || []).map(m => ({
        id: m.id,
        scope: m.scope,
        content: m.content,
      })),
      safetyWarnings: ctx.safetyWarnings || [],
    };
    return `<memory-os-context trusted="true">\n${JSON.stringify(compact)}\n</memory-os-context>\n\n${prompt}`;
  } catch (e) {
    console.warn('[cron-agent] memory context injection failed:', e?.message);
    return prompt;
  }
}

/**
 * Self-test the openclaw agent CLI — verifies --version works, caches flag profile.
 * Alerts CEO via Telegram on failure. Runs once then caches for 30min.
 * @returns {Promise<void>}
 */
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
    _lastSelfTestStderr = stderr;

    _agentFlagProfile = 'full';

    const versionMatch = stdout.match(/OpenClaw\s+(\S+)/);
    const versionStr = versionMatch ? versionMatch[1] : null;

    if (res.code === 0 && versionStr) {
      _agentCliHealthy = true;
      _agentCliVersionOk = true;
      // Reset alert flag so a NEW outage in the same session re-alerts CEO.
      // Without this, once CEO is told "openclaw down" they're never told
      // "openclaw recovered" or "openclaw down again" (Round-2 Reviewer F).
      _selfTestAlertSent = false;
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

// ── Agent output parsing ───────────────────────────────────────────────
// The cron agent runs with --json to get structured JSON output instead of
// channel delivery (--deliver is omitted; openclaw defaults it to false).
// This lets us capture the reply text and deliver it to the correct Zalo
// target without the LLM seeing or leaking the delivery instructions.
//
// Expected JSON shape from openclaw agent --json:
// { "result": { "payloads": [{ "text": "...", "mediaUrls": [...] }], ... } }

/**
 * Parse openclaw agent --json stdout into structured reply.
 * @param {string} stdout - Raw stdout from openclaw agent process
 * @returns {{ text: string, mediaUrls: string[] } | null}
 */
function _extractPayload(parsed) {
  const payloads = parsed?.result?.payloads || parsed?.payloads || [];
  if (Array.isArray(payloads) && payloads.length > 0) {
    const first = payloads[0];
    return { text: first.text || '', mediaUrls: first.mediaUrls || first.mediaUrl || [] };
  }
  if (parsed?.text) return { text: parsed.text, mediaUrls: [] };
  return null;
}

function parseAgentJsonOutput(stdout) {
  if (!stdout) return null;
  const trimmed = stdout.trim();
  try {
    return _extractPayload(JSON.parse(trimmed));
  } catch {
    // stdout wasn't pure JSON. The agent runs with --json, so non-JSON means the
    // process emitted a banner / log / deprecation line around (or instead of) the
    // JSON. NEVER deliver the raw blob — that leaks internal logs to the CEO or a
    // customer group. Try to salvage the embedded JSON object; otherwise return
    // null so the caller treats it as a parse failure (no delivery) instead.
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { return _extractPayload(JSON.parse(trimmed.slice(start, end + 1))); } catch {}
    }
    console.warn('[cron-agent] agent stdout was not valid JSON — not delivering raw output');
    return null;
  }
}

// ── Post-agent Zalo delivery ─────────────────────────────────────────
// After the agent produces content, deliver it to the Zalo target.
// Uses sendZaloTo directly (same-process, same-permissions as the bot).
// This is the reliable path: no HTTP, no auth token needed.

// Match: "Em xử lý luôn.", "Dạ em sẽ thực hiện ngay!", "Vâng, em làm liền ạ."
// No match: "Em xử lý đơn hàng cho mình ngay nhé" (has object after verb)
const _processAckLineRe = /^\s*(?:dạ\s+)?(?:vâng\s*[,.]?\s*)?(?:dạ\s*[,.]?\s*)?em\s+(?:sẽ\s+)?(?:xử\s*lý|thực\s*hiện|làm|chạy)\s+(?:luôn|ngay|liền|rồi)\s*[.!ạ]*\s*$/i;
const _processDescRe = /^\s*(?:dạ\s+)?em\s+(?:sẽ\s+)?(?:xử\s*lý|thực\s*hiện|làm|chạy|kiểm\s*tra)\s+(?:theo|nhiều|quy\s*trình|luồng|lần\s*lượt|từng\s*bước|các\s*bước)/i;
// Match: "Em đang xử lý.", "Dạ em đang chạy."
// No match: "Em đang xử lý đơn hàng 1234" (has object)
const _processStatusLineRe = /^\s*(?:dạ\s+)?em\s+đang\s+(?:xử\s*lý|thực\s*hiện|chạy)\s*[.!ạ]*\s*$/i;
// Match: "Dạ", "Vâng", "Dạ vâng ạ."
// No match: "Dạ em ghi nhận rồi ạ" (has content after ack)
const _bareAckLineRe = /^\s*(?:dạ|vâng|dạ vâng)\s*[,.]?\s*(?:ạ\s*[.!]?)?\s*$/i;

// A process-description line that ALSO carries result data (a colon, digits, or
// a result token) is a real report — keep it. Only strip a process-description
// line when it is pure process narration with no data payload. This prevents the
// whole-message wipe that erased legitimate CEO cron reports starting with
// phrases like "Em kiểm tra theo yêu cầu rồi: doanh thu...".
const _resultBearingRe = /[:0-9]|kết\s*quả|doanh|đơn|triệu/i;

function _stripProcessAcks(text) {
  const lines = text.split('\n');
  const cleaned = lines.filter(line => {
    const t = line.trim();
    if (!t) return true;
    if (_processAckLineRe.test(t) || _processStatusLineRe.test(t) || _bareAckLineRe.test(t)) return false;
    // Per-line process-description strip — but never wipe a line that carries
    // actual data (digits, a colon, or a result token).
    if (_processDescRe.test(t) && !_resultBearingRe.test(t)) return false;
    return true;
  });
  return cleaned.join('\n').trim();
}

// Throttled CEO alert when a cron produced output the filter blocked (typically
// an upstream/provider error). Without this the failure is silent: the customer
// or CEO gets a polite content-less ack and nobody knows the cron actually
// failed. Max one alert per 30 min per cron so a down upstream (every cron
// firing blocked) does not flood the CEO.
const _lastCronBlockedAlertAt = new Map();
async function _alertCronBlocked(label, pattern, channelLabel) {
  try {
    const now = Date.now();
    const last = _lastCronBlockedAlertAt.get(label) || 0;
    if (now - last < 30 * 60 * 1000) return;
    _lastCronBlockedAlertAt.set(label, now);
    await sendCeoAlert(`[Cron "${label}"] đã chạy nhưng kết quả bị bộ lọc nội dung chặn (thường do lỗi nhà cung cấp AI / token hết hạn). Không gửi gì cho ${channelLabel}. Vui lòng kiểm tra logs.`);
  } catch {}
}

async function deliverCronResultToZalo(replyText, zaloTarget, label) {
  if (!replyText) return true;
  const cleaned = _stripProcessAcks(String(replyText));
  if (!cleaned || cleaned.length < 5 || /^\s*DONE\s*[.!]?\s*$/i.test(cleaned)) {
    console.log(`[cron-agent] Zalo delivery for "${label}" skipped — agent completed via tools (no customer-facing text)`);
    return true;
  }
  // If the output filter would block this (raw upstream error/leak), do NOT
  // send a substituted polite ack to a CUSTOMER group — that looks broken and
  // the customer gets no real content. Skip delivery and alert the CEO instead.
  try {
    const f = filterSensitiveOutput(cleaned);
    if (f && f.blocked) {
      console.log(`[cron-agent] Zalo delivery for "${label}" skipped — reply blocked by output filter (${f.pattern})`);
      try { auditLog('cron_zalo_blocked', { label, pattern: f.pattern }); } catch {}
      await _alertCronBlocked(label, f.pattern, 'nhóm Zalo');
      return false;
    }
  } catch {}
  const target = zaloTarget || {};
  const targetId = target.id;
  const isGroup = target.isGroup === true;
  const targetLabel = target.label || targetId;
  try {
    // skipOnBlock: defense-in-depth — even if channels.js's output filter has a
    // pattern cron.js's filterSensitiveOutput lacks, a block here returns
    // {blocked:true} instead of substituting a polite ack into the customer group.
    const result = await sendZaloTo({ id: String(targetId), isGroup }, cleaned.slice(0, 5000), { skipOnBlock: true });
    if (result && result.ok) {
      console.log(`[cron-agent] Zalo delivery OK → ${isGroup ? 'group' : 'user'} ${targetLabel}`);
      return true;
    }
    if (result && result.blocked) {
      console.log(`[cron-agent] Zalo delivery for "${label}" blocked at transport filter — alerting CEO`);
      try { await _alertCronBlocked(label, result.error || 'transport-filter', 'nhóm Zalo'); } catch {}
      return false;
    }
    // sendZaloTo returned {ok:false, error} — try CEO alert as last resort
    console.warn(`[cron-agent] Zalo delivery to "${targetLabel}" failed: ${(result && result.error) || 'unknown'}, alerting CEO instead`);
    try {
      await sendCeoAlert(`[Cron "${label}"] Kết quả:\n${String(replyText).slice(0, 3000)}${(result && result.error) ? '\n[Lỗi: ' + result.error + ']' : ''}`);
    } catch {}
    return false;
  } catch (e) {
    console.error(`[cron-agent] deliverCronResultToZalo error: ${e.message}`);
    try {
      await sendCeoAlert(`[Cron "${label}"] Kết quả (Zalo thất bại):\n${String(replyText).slice(0, 3000)}`);
    } catch {}
    return false;
  }
}

// Telegram (CEO) parity with deliverCronResultToZalo: strip process-acks and,
// crucially, DROP a reply that the output filter would block (a raw upstream
// error/leak). Without this, sendTelegram() substitutes a polite "em đang xác
// nhận…" ack, so the CEO gets a content-less message at EVERY cron fire when the
// model errors (the reported bug). A failed cron must produce NO message here —
// genuine spawn/exit failures are still surfaced via the retry/fatal path.
// Returns a status string: 'empty' | 'blocked' | 'delivered' | 'error'.
// (Caller uses this to journal accurately — a filter-blocked fire must not be
// recorded as 'ok' when nothing reached the CEO.)
async function deliverCronResultToTelegram(replyText, label) {
  if (!replyText) return 'empty';
  const cleaned = _stripProcessAcks(String(replyText));
  if (!cleaned || cleaned.length < 5 || /^\s*DONE\s*[.!]?\s*$/i.test(cleaned)) {
    console.log(`[cron-agent] Telegram delivery for "${label}" skipped — no CEO-facing content (ack/DONE only)`);
    return 'empty';
  }
  try {
    const f = filterSensitiveOutput(cleaned);
    if (f && f.blocked) {
      console.log(`[cron-agent] Telegram delivery for "${label}" skipped — reply blocked by output filter (${f.pattern})`);
      try { auditLog('cron_telegram_blocked', { label, pattern: f.pattern }); } catch {}
      await _alertCronBlocked(label, f.pattern, 'Telegram');
      return 'blocked';
    }
  } catch {}
  try {
    await sendTelegram(cleaned);
    return 'delivered';
  } catch (e) {
    console.warn(`[cron-agent] Telegram delivery failed:`, e?.message);
    return 'error';
  }
}

const CRON_PROMPT_MAX_BYTES = 24000;

/** Cap a prompt to stay within the Windows CreateProcess 32KB argv limit.
 *  openclaw has NO --message-file / --params @file / stdin input, so BOTH the
 *  CLI `agent --message` path AND the `gateway call sessions.send --params` path
 *  carry the whole prompt in argv and hit the same ~32KB limit. This must be
 *  applied to BOTH paths (previously only the CLI path capped → the session path
 *  threw ENAMETOOLONG and wasted a spawn before falling back). When capped, a
 *  note instructs the agent to summarize from the data it received. */
function capCronPromptBytes(prompt) {
  const promptBytes = Buffer.byteLength(prompt, 'utf-8');
  if (promptBytes <= CRON_PROMPT_MAX_BYTES) return prompt;
  console.warn(`[cron-agent] prompt ${(promptBytes / 1024).toFixed(1)}KB exceeds ${(CRON_PROMPT_MAX_BYTES / 1024).toFixed(0)}KB argv limit — capping (openclaw has no file/stdin input)`);
  const buf = Buffer.from(prompt, 'utf-8');
  let end = CRON_PROMPT_MAX_BYTES;
  while (end > 0 && (buf[end] & 0xC0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf-8') + '\n\n[... nội dung bị cắt do giới hạn kỹ thuật. Tóm tắt từ dữ liệu có sẵn.]';
}

/** Build openclaw agent CLI args. Defaults to 'full' profile if self-test hasn't run yet.
 *  Caps prompt at 24KB to stay within Windows CreateProcess 32KB argv limit. */
function buildAgentArgs(prompt, chatId, useJson = false) {
  const idStr = String(chatId);
  const safePrompt = capCronPromptBytes(prompt);
  const base = ['agent', '--message', safePrompt];
  if (useJson) base.push('--json');
  const profile = _agentFlagProfile || 'full';
  if (profile === 'full') {
    const args = [...base, '--channel', 'telegram', '--to', idStr];
    if (!useJson) args.push('--reply-channel', 'telegram', '--reply-to', idStr);
    return args;
  }
  return [...base, '--channel', 'telegram', '--to', idStr];
}

function isTransientErr(stderr) {
  const s = (stderr || '').toLowerCase();
  return s.includes('econnrefused')
      || s.includes('etimedout')
      || s.includes('gateway not running')
      || s.includes('gateway is not')
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
      || (s.includes('enoent') && (s.includes('openclaw') || s.includes('node')))
      || s.includes('eacces')
      || s.includes('not authorized')
      || s.includes('invalid token')
      || s.includes('enametoolong')
      || s.includes('e2big')
      || s.includes('arg list too long')
      || (exitCode === 127);
}

// True when the failure is the openclaw agent losing its gateway connection and
// (slowly) falling back to a cold embedded run — the class that gets SIGKILLed by
// the cron timeout (exit -9, "gateway closed (1006 abnormal closure)"). Used to
// ensure a warm gateway before retrying instead of re-spawning the same cold path.
function isGatewayDropErr(stderr) {
  const s = (stderr || '').toLowerCase();
  return s.includes('falling back to embedded')
      || s.includes('gateway closed')
      || s.includes('abnormal closure')
      || s.includes('1006');
}

// Ensure the gateway is warm before a cron agent runs. If the gateway is truly
// unresponsive — isGatewayAlive(15s) will NOT false-positive a busy-but-alive
// gateway — openclaw would otherwise fall back to a COLD EMBEDDED run that is slow
// (cold start + reasoning model) and gets SIGKILLed by the cron timeout (exit -9).
// startOpenClaw is re-entrant-guarded and no-ops if the gateway is actually up, so
// a responsive gateway is never killed. Returns { aliveAtStart } for diagnostics.
async function ensureGatewayWarmForCron(label) {
  let aliveAtStart = true;
  try {
    const gw = getGateway();
    if (typeof gw.isGatewayAlive === 'function') {
      aliveAtStart = await gw.isGatewayAlive(15000);
      if (!aliveAtStart) {
        console.warn(`[cron] gateway not alive before "${label || 'cron'}" — starting to avoid cold-embedded fallback`);
        try { auditLog('cron_gateway_warm', { label: label || 'cron', aliveAtStart: false, action: 'start' }); } catch {}
        if (typeof gw.startOpenClaw === 'function') await gw.startOpenClaw({ silent: true });
      }
    }
  } catch (e) {
    console.warn('[cron] ensureGatewayWarmForCron error:', e?.message);
  }
  return { aliveAtStart };
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
    console.error(`[cron-exec] "${label || 'cron'}" — Zalo listener down, skipping send`);
    return false;
  }
  if (targetIds.length === 1) {
    console.log(`[cron-exec] "${label || 'cron'}" rerouted to safe Zalo sender`);
    const result = await sendZaloTo({ id: targetIds[0], isGroup }, text, { profile, skipOnBlock: true });
    if (result && result.blocked) { try { journalCronRun({ phase: 'blocked', label: label || 'cron', mode: 'safe-openzca' }); } catch {} }
    return result && result.ok;
  }
  console.log(`[cron-exec] "${label || 'cron'}" broadcast to ${targetIds.length} targets`);
  let sent = 0;
  for (let t = 0; t < targetIds.length; t++) {
    try {
      const result = await sendZaloTo({ id: targetIds[t], isGroup }, text, { profile, skipOnBlock: true });
      if (result && result.ok) sent++;
      else console.warn(`[cron-exec] broadcast target ${targetIds[t]} failed: ${(result && result.error) || 'unknown'}`);
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
/**
 * Run a prompt through the openclaw agent with retry, journal, and CEO delivery.
 * @param {string} prompt - The prompt text (or "exec: ..." for shell commands)
 * @param {{ label?: string, zaloTarget?: { id: string, isGroup: boolean, label?: string }, timeoutMs?: number }} [opts]
 * @returns {Promise<boolean>} True if delivered successfully
 */
async function runCronAgentPrompt(prompt, opts = {}) {
  if (_cronAgentQueueDepth >= 10) {
    // Don't drop a scheduled job silently — journal + alert the CEO (fail-loud).
    const lbl = opts?.label || 'cron';
    console.warn(`[cron-agent] queue full (depth=${_cronAgentQueueDepth}) — rejecting "${lbl}"`);
    try { journalCronRun({ phase: 'fail', label: lbl, reason: 'queue-full' }); } catch {}
    try { sendCeoAlert(`*Cron quá tải*\n\nLịch "${lbl}" bị bỏ qua vì hàng đợi đầy (gateway đang chậm). Em sẽ chạy lại lần lịch kế tiếp.`).catch(e => console.warn('[auto-fix] promise rejected:', e?.message)); } catch {}
    return false;
  }
  _cronAgentQueueDepth++;
  if (_cronAgentQueueDepth > 1) {
    console.log(`[cron-agent] queued (depth=${_cronAgentQueueDepth}) label="${opts?.label || 'cron'}"`);
  }
  const run = _cronAgentQueue.then(() => _runCronAgentPromptImpl(prompt, opts));
  _cronAgentQueue = run.catch(() => {}).finally(() => { _cronAgentQueueDepth--; });
  return run;
}

async function _runCronAgentPromptImpl(prompt, { label, zaloTarget, isOneTime, suppressDelivery, timeoutMs = CRON_AGENT_TIMEOUT_MS } = {}) {
  const niceLabel = label || 'cron';

  // PAUSE CHECK 2026-05-15: if this cron targets Zalo and Zalo channel is
  // paused, short-circuit BEFORE running the agent. Previously the agent
  // ran (~30-90s of LLM tokens wasted) and on Zalo failure the reply was
  // forwarded to CEO Telegram — violates CEO's pause intent (they paused
  // to STOP customer chatter, not to redirect it).
  if (zaloTarget && zaloTarget.id) {
    try {
      const channels = require('./channels');
      if (typeof channels.isChannelPaused === 'function' && channels.isChannelPaused('zalo')) {
        const status = (typeof channels.getChannelPauseStatus === 'function') ? channels.getChannelPauseStatus('zalo') : null;
        const until = status && status.until ? ` (đến ${new Date(status.until).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })})` : '';
        journalCronRun({ phase: 'skip', label: niceLabel, reason: 'zalo-paused', until: status?.until || null });
        console.log(`[cron-agent] "${niceLabel}" skipped — Zalo channel paused${until}`);
        try { await sendCeoAlert(`[Cron "${niceLabel}"] đã bỏ qua vì kênh Zalo đang tạm dừng${until}. Em sẽ chạy lại khi anh tiếp tục Zalo.`); } catch {}
        return false;
      }
    } catch (e) { console.warn('[cron-agent] pause-check error (proceeding):', e?.message); }
  }

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
  if (!_agentCliHealthy && _lastSelfTestStderr && isConfigInvalidErr(_lastSelfTestStderr)) {
    console.log('[cron-agent] self-test caught config error — healing dynamically');
    healOpenClawConfigInline(_lastSelfTestStderr);
  }

  if (!_agentFlagProfile) _agentFlagProfile = 'full';

  const { chatId, recovered } = await getTelegramConfigWithRecovery();
  if (!chatId) {
    journalCronRun({ phase: 'fail', label: niceLabel, reason: 'no-chat-id-even-after-recovery' });
    console.error(`[cron-agent] "${niceLabel}" — no telegram chatId, even after recovery attempt`);
    try {
      const alertFile = path.join(getWorkspace(), 'logs', 'cron-cannot-deliver.txt');
      fs.mkdirSync(path.dirname(alertFile), { recursive: true });
      fs.appendFileSync(alertFile, `${new Date().toISOString()} — Cron "${niceLabel}" cannot deliver: no telegram chatId in config, sticky file, or recent Telegram updates. Re-run wizard or have someone /start the bot.\n`, 'utf-8');
    } catch (e) { console.warn('[cron-agent] cron-cannot-deliver.txt write error:', e?.message); }
    // Surface to Dashboard overview via a flag file so next load can show alert
    try {
      const flagFile = path.join(getWorkspace(), 'logs', 'cron-delivery-blocked.flag');
      fs.writeFileSync(flagFile, JSON.stringify({ label: niceLabel, ts: new Date().toISOString() }), 'utf-8');
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

  // Wrap ALL cron prompts with [AUTO-MODE] tag so AGENTS.md skips confirmation rules.
  // Zalo-targeted crons get additional delivery instruction.
  const promptWithMemory = await injectMemoryOsContext(prompt, { label: niceLabel });
  let finalPrompt = '[AUTO-MODE]\n' + promptWithMemory;
  if (zaloTarget && zaloTarget.id) {
    finalPrompt += '\n\n[Kết quả của task này sẽ được gửi trực tiếp đến Zalo. CHỈ output nội dung cuối cùng dành cho người nhận. TUYỆT ĐỐI KHÔNG mô tả quy trình, bước làm, workflow, hay giải thích cách em xử lý. Nếu đã hoàn thành qua tool call và không cần gửi thêm gì, chỉ output: DONE]';
  }
  const args = buildAgentArgs(finalPrompt, chatId, true);
  // Guard against cmd.exe truncation must be computed from what is ACTUALLY
  // spawned (finalPrompt), not the original prompt. finalPrompt always begins
  // with "[AUTO-MODE]\n", so it always contains a newline → the cmd-shell
  // fallback (which truncates multi-line argv) must never be allowed here.
  const promptHasNewline = finalPrompt.includes('\n');
  let lastErr = '';
  let lastCode = -1;
  for (let attempt = 1; attempt <= CRON_AGENT_MAX_RETRIES; attempt++) {
    const startedAt = Date.now();
    console.log(`[cron-agent] "${niceLabel}" attempt ${attempt}/3 (profile=${_agentFlagProfile}, prompt ${prompt.length}c, multiline=${promptHasNewline})`);
    const res = await spawnOpenClawSafe(args, {
      timeoutMs,
      allowCmdShellFallback: !promptHasNewline,
    });
    const durMs = Date.now() - startedAt;
    if (res.code === 0) {
      // Parse structured JSON output to extract the agent's reply text
      const agentReply = parseAgentJsonOutput(res.stdout || '');
      const replyText = agentReply?.text?.trim();
      console.log(`[cron-agent] "${niceLabel}" done in ${durMs}ms, reply length=${replyText ? replyText.length : 0} chars`);
      if (!agentReply && (res.stdout || '').trim().length > 20) {
        // Agent exited 0 but produced unparseable (non-JSON) stdout — nothing
        // delivered. Surface it in the journal rather than silently dropping.
        // Return here so the same fire is NOT double-journaled as 'ok' below
        // (replyText is falsy, so no delivery would run anyway — but the trailing
        // ok journal would still fire without this early return).
        try { journalCronRun({ phase: 'fail', label: niceLabel, reason: 'agent-output-not-json' }); } catch {}
        return false;
      }
      // Deliver to target channel. suppressDelivery: multi-step substeps deliver
      // NOWHERE (their text is work-in-progress chatter; the real output goes via
      // tool calls inside the step) — prevents per-step spam to BOTH the Zalo group
      // and the CEO's Telegram.
      let zaloOk = true;
      let tgStatus = 'n/a';
      if (suppressDelivery) {
        // no-op: step chatter is not delivered to any channel
      } else if (zaloTarget && replyText) {
        zaloOk = await deliverCronResultToZalo(replyText, zaloTarget, niceLabel);
      } else if (replyText && !zaloTarget) {
        tgStatus = await deliverCronResultToTelegram(replyText, niceLabel);
      }
      // Don't record 'ok' when the result was blocked by the output filter and
      // nothing reached the CEO — journal it as 'blocked' so it's not invisible.
      const journalPhase = tgStatus === 'blocked' ? 'blocked' : 'ok';
      journalCronRun({ phase: journalPhase, label: niceLabel, attempt, durMs, profile: _agentFlagProfile, viaCmdShell: res.viaCmdShell, zaloDelivered: !!zaloTarget, telegram: tgStatus });
      console.log(`[cron-agent] "${niceLabel}" delivered${zaloTarget ? ' (Telegram+zalo)' : ' (Telegram only)'} in ${durMs}ms (viaCmdShell=${res.viaCmdShell})`);
      return zaloOk;
    }
    lastCode = res.code;
    lastErr = (res.stderr || res.stdout || '').slice(0, 800);
    journalCronRun({ phase: 'retry', label: niceLabel, attempt, durMs, code: res.code, gatewayDrop: isGatewayDropErr(lastErr), err: lastErr.slice(0, 300), viaCmdShell: res.viaCmdShell });
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

    if (attempt < CRON_AGENT_MAX_RETRIES && isConfigInvalidErr(lastErr)) {
      const healed = healOpenClawConfigInline(lastErr);
      console.log(`[cron-agent] config-invalid detected; inline heal ${healed ? 'WROTE' : 'noop'}, retrying immediately`);
      continue;
    }

    if (attempt < CRON_AGENT_MAX_RETRIES) {
      // If the agent lost the gateway and cold-embedded-failed, warm the gateway
      // before retrying — otherwise the retry re-spawns the same doomed cold path.
      if (isGatewayDropErr(lastErr)) { try { await ensureGatewayWarmForCron(niceLabel); } catch {} }
      const backoffMs = isTransientErr(lastErr) ? attempt * CRON_TRANSIENT_BACKOFF_BASE_MS : attempt * CRON_DEFAULT_BACKOFF_BASE_MS;
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  const gwDrop = isGatewayDropErr(lastErr);
  journalCronRun({ phase: 'fail', label: niceLabel, code: lastCode, gatewayDrop: gwDrop, err: lastErr.slice(0, 400) });
  try {
    const diag = gwDrop ? `\n\n_Chẩn đoán: gateway rớt giữa chừng → openclaw chạy embedded (cold) → quá thời gian → bị dừng. Lần sau bot tự khởi động lại gateway trước khi chạy._` : '';
    await sendCeoAlert(`*Cron "${niceLabel}" thất bại sau 3 lần*\n\nExit code: \`${lastCode}\`\n\`\`\`\n${lastErr.slice(0, 500)}\n\`\`\`${diag}`);
  } catch {}
  return false;
}

// ============================================================
//   SCHEDULE/PROMPT BUILDERS
// ============================================================

// Schedule management (CEO-friendly cron display)
function getSchedulesPath() { const ws = getWorkspace(); if (!ws) return null; return path.join(ws, 'schedules.json'); }
function getCustomCronsPath() { const ws = getWorkspace(); if (!ws) return null; return path.join(ws, 'custom-crons.json'); }

// TODO: remove legacy migration after v2.5.0 when all users have upgraded
const legacySchedulesPaths = [
  path.join(ctx.HOME, '.openclaw', 'workspace', 'schedules.json'),
  // appDataDir() not available here — workspace.js handles that
];
const legacyCustomCronsPaths = [
  path.join(ctx.HOME, '.openclaw', 'workspace', 'custom-crons.json'),
];

function repairJsonControlCharsInStrings(raw) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < String(raw || '').length; i++) {
    const ch = raw[i];
    const code = ch.charCodeAt(0);
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      out += ch;
      inString = false;
      continue;
    }
    if (code >= 0 && code < 0x20) {
      if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

function parseCustomCronsJson(raw) {
  const cleanRaw = String(raw || '').replace(/^\uFEFF/, '');
  try {
    const parsed = JSON.parse(cleanRaw);
    if (!Array.isArray(parsed)) throw new Error('custom-crons.json must be an array, got ' + typeof parsed);
    return { parsed, repaired: false };
  } catch (firstErr) {
    const repairedRaw = repairJsonControlCharsInStrings(cleanRaw);
    if (repairedRaw === cleanRaw) throw firstErr;
    try {
      const parsed = JSON.parse(repairedRaw);
      if (!Array.isArray(parsed)) throw new Error('custom-crons.json must be an array, got ' + typeof parsed);
      return { parsed, repaired: true, originalError: firstErr.message };
    } catch {
      throw firstErr;
    }
  }
}

function loadSchedules() {
  const schedulesPath = getSchedulesPath();
  if (!schedulesPath) return [];
  try {
    if (fs.existsSync(schedulesPath)) {
      const raw = fs.readFileSync(schedulesPath, 'utf-8');
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('schedules.json must be an array');
        const hadHeartbeat = parsed.some(s => s.id === 'heartbeat');
        const hadMeditation = parsed.some(s => s.id === 'meditation');
        let cleaned = parsed.filter(s => s.id !== 'heartbeat' && s.id !== 'meditation');
        // Auto-inject new default schedule entries that existing users don't have
        let injected = false;
        for (const def of DEFAULT_SCHEDULES_JSON) {
          if (!cleaned.some(s => s.id === def.id)) {
            cleaned.push(def);
            injected = true;
            console.log(`[schedules] auto-injected new schedule: ${def.id}`);
          }
        }
        if (hadHeartbeat || hadMeditation || injected) {
          try { writeJsonAtomic(schedulesPath, cleaned); } catch {}
          if (hadHeartbeat) console.log('[schedules] removed legacy heartbeat entry');
          if (hadMeditation) console.log('[schedules] removed legacy meditation entry');
        }
        return cleaned;
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

  let taskHistory = '';
  try {
    const { listMemories } = require('./ceo-memory');
    const memories = listMemories({ limit: 20 });
    if (memories && memories.length > 0) {
      const recent = memories.filter(m => {
        const age = Date.now() - new Date(m.created_at).getTime();
        return age < 48 * 3600000;
      });
      if (recent.length > 0) {
        taskHistory = '\n\n--- HOẠT ĐỘNG 48H QUA (từ bộ nhớ bot) ---\n' +
          recent.map(m => '- [' + m.type + '] ' + m.content).join('\n') +
          '\n--- HẾT ---\n\n';
      }
    }
  } catch {}

  const template = loadPromptTemplate('morning-briefing.md');
  if (template) {
    return template
      .replace('{{time}}', timeStr || '07:30')
      .replace('{{historyBlock}}', historyBlock)
      .replace('{{taskHistory}}', taskHistory);
  }
  return `Bây giờ là ${timeStr || '07:30'} sáng. Gửi báo cáo sáng cho CEO.` + historyBlock + taskHistory +
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

  let taskHistory = '';
  try {
    const { listMemories } = require('./ceo-memory');
    const memories = listMemories({ limit: 20 });
    if (memories && memories.length > 0) {
      const recent = memories.filter(m => {
        const age = Date.now() - new Date(m.created_at).getTime();
        return age < 48 * 3600000;
      });
      if (recent.length > 0) {
        taskHistory = '\n\n--- HOẠT ĐỘNG 48H QUA (từ bộ nhớ bot) ---\n' +
          recent.map(m => '- [' + m.type + '] ' + m.content).join('\n') +
          '\n--- HẾT ---\n\n';
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
      .replace('{{taskHistory}}', taskHistory)
      .replace('{{knowledgeGaps}}', knowledgeGaps);
  }
  return `Bây giờ là ${timeStr || '21:00'}, cuối ngày. Tóm tắt hoạt động hôm nay cho CEO.` +
    historyBlock + memoryInsights + taskHistory + knowledgeGaps +
    `Tiếng Việt có dấu, không emoji, ngắn gọn.`;
}

function buildAfternoonNudgePrompt(timeStr) {
  const sinceMs = Date.now() - 8 * 60 * 60 * 1000;
  const history = extractConversationHistory({ sinceMs, maxMessages: 30, maxPerSender: 5 });

  const signals = [];
  let pendingFollowUps = '';
  let overduePayments = '';
  let recentCustomers = '';
  try {
    const ws = getWorkspace();
    if (ws) {
      const fqPath = path.join(ws, 'follow-up-queue.json');
      if (fs.existsSync(fqPath)) {
        try {
          const fq = JSON.parse(fs.readFileSync(fqPath, 'utf-8'));
          const pending = (Array.isArray(fq) ? fq : []).filter(e => !e.firedAt);
          if (pending.length > 0) {
            signals.push('follow-up');
            pendingFollowUps = `\n--- FOLLOW-UP ĐANG CHỜ (${pending.length}) ---\n` +
              pending.slice(0, 5).map(e => `- ${e.customerName || e.senderId}: ${(e.reason || '').slice(0, 80)}`).join('\n') + '\n--- Hết ---\n';
          }
        } catch {}
      }
      const cnPath = path.join(ws, 'cong-no.md');
      if (fs.existsSync(cnPath)) {
        try {
          const cn = fs.readFileSync(cnPath, 'utf-8');
          const overdueLines = cn.split('\n').filter(l => /quá hạn|overdue|chưa thanh toán/i.test(l));
          if (overdueLines.length > 0) {
            signals.push('cong-no');
            overduePayments = `\n--- CÔNG NỢ CẦN NHẮC ---\n${overdueLines.slice(0, 5).join('\n')}\n--- Hết ---\n`;
          }
        } catch {}
      }
      const memDir = path.join(ws, 'memory', 'zalo-users');
      if (fs.existsSync(memDir)) {
        const recent = [];
        for (const f of fs.readdirSync(memDir).filter(f => f.endsWith('.md')).slice(0, 100)) {
          try {
            const stat = fs.statSync(path.join(memDir, f));
            if ((Date.now() - stat.mtimeMs) < 8 * 3600000) {
              const content = fs.readFileSync(path.join(memDir, f), 'utf-8').slice(0, 300);
              const nameMatch = content.match(/^name:\s*(.+)$/im);
              recent.push(nameMatch ? nameMatch[1].trim() : f.replace('.md', ''));
            }
          } catch {}
        }
        if (recent.length > 0) {
          signals.push('customers');
          recentCustomers = `\n--- ${recent.length} KHÁCH TƯƠNG TÁC HÔM NAY ---\n${recent.slice(0, 10).join(', ')}\n--- Hết ---\n`;
        }
      }
    }
  } catch {}

  if (signals.length === 0 && !history) return null;

  const dayOfWeek = new Date().getDay();
  const angles = [
    'Nhắc follow-up khách chưa chốt đơn',
    'Gợi ý up-sell/cross-sell cho khách đang trao đổi',
    'Đề xuất nội dung đăng Zalo chiều nay',
    'Review khách mới hôm nay — ai có tiềm năng cao',
    'Kiểm tra đơn hàng/lịch hẹn cần xử lý trước EOD',
    'Tổng hợp câu hỏi thường gặp hôm nay — cần bổ sung FAQ?',
    'Đánh giá tốc độ phản hồi khách hôm nay — cần cải thiện gì?',
  ];
  const todayAngle = angles[dayOfWeek % angles.length];

  const historyBlock = history ? `\n--- Tin nhắn hôm nay ---\n${history}\n--- Hết ---\n` : '';
  return (
    `${timeStr || '14:00'} chiều. Gợi ý chiều cho CEO.\n\n` +
    `GÓC NHÌN HÔM NAY: ${todayAngle}\n\n` +
    `Dựa trên data bên dưới, đưa ra 1-3 hành động CỤ THỂ CEO có thể làm ngay chiều nay.\n` +
    `Mỗi hành động kèm lý do ngắn (1 câu). CEO reply 1 từ là em thực hiện.\n` +
    `Nếu data rỗng → gợi ý proactive (tạo content, check inventory, nhắn khách cũ).\n` +
    `KHÔNG lặp lại gợi ý hôm qua. KHÔNG generic. KHÔNG emoji.\n\n` +
    historyBlock + pendingFollowUps + overduePayments + recentCustomers
  );
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
  const PENDING_HINTS = /(chờ phản hồi|chờ trả lời|chưa chốt|cần follow-?up|sẽ liên hệ|hẹn mai|mai liên lạc|ngày mai sẽ|hứa.*(mua|đặt|ghé|qua)|suy nghĩ|chưa quyết|để xem|tính sau|xem lại|chưa trả lời|do dự|lưỡng lự|đang cân nhắc|chưa đồng ý|chưa ok|hỏi giá.*chưa mua|báo giá.*chưa)/i;

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
      if (staleMs < H24_MS) continue;

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
    lines.push(`Zalo users: ${userFiles.length} profile(s), ${activeUsers} có msgCount > 0`);
    if (samples.length) lines.push('Mẫu user có tương tác: ' + samples.join('; '));
  } catch {
    lines.push('Zalo users: không đọc được thống kê');
  }

  try {
    const groupFiles = fs.existsSync(groupsDir) ? fs.readdirSync(groupsDir).filter(f => f.endsWith('.md')) : [];
    lines.push(`Zalo groups: ${groupFiles.length} profile(s)`);
  } catch {
    lines.push('Zalo groups: không đọc được thống kê');
  }

  return lines.join('\n');
}

// meditation cron removed — redundant with ceo-memory, conversation journaling, weekly digest

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
//   Multi-step AUTO-MODE splitter
// ============================================================

const MULTISTEP_MIN_STEPS = 3;

function parseMultiStepPrompt(prompt) {
  const lines = prompt.split('\n');
  const steps = [];
  let currentStep = null;
  for (const line of lines) {
    const m = line.match(/^(?:Bước\s+\d+\/\d+:\s*)?(\d+)\.\s+(.+)/);
    if (m) {
      if (currentStep) steps.push(currentStep);
      currentStep = { stepNum: parseInt(m[1], 10), text: m[2].trim() };
    } else if (currentStep && line.trim()) {
      currentStep.text += ' ' + line.trim();
    }
  }
  if (currentStep) steps.push(currentStep);
  if (steps.length < MULTISTEP_MIN_STEPS) return null;
  const firstIdx = prompt.indexOf(steps[0].text.slice(0, 20));
  const preamble = firstIdx > 0 ? prompt.slice(0, prompt.lastIndexOf('\n', firstIdx)).trim() : '';
  return { preamble, steps };
}

async function runMultiStepCronPrompt(prompt, opts = {}) {
  const parsed = parseMultiStepPrompt(prompt);
  if (!parsed) return _runCronAgentPromptImpl(prompt, opts);
  const { preamble, steps } = parsed;
  const total = steps.length;
  const niceLabel = opts.label || 'cron';
  console.log(`[cron-multistep] "${niceLabel}" detected ${total} steps — splitting`);
  journalCronRun({ phase: 'multistep-start', label: niceLabel, totalSteps: total });

  const completed = [];
  const failed = [];

  for (const step of steps) {
    let stepPrompt = '';
    if (preamble) stepPrompt += preamble + '\n\n';
    if (completed.length > 0) {
      stepPrompt += '--- DA XONG ---\n';
      for (const c of completed) stepPrompt += `Buoc ${c.n}: ${c.s}\n`;
      stepPrompt += '---\n\n';
    }
    stepPrompt += `BUOC HIEN TAI (${step.stepNum}/${total}): ${step.text}\nThuc hien DUNG 1 buoc nay. Reply ket qua ngan gon.`;

    console.log(`[cron-multistep] step ${step.stepNum}/${total}: ${step.text.slice(0, 80)}`);
    const t0 = Date.now();
    try {
      const ok = await runCronAgentPrompt(stepPrompt, {
        ...opts,
        // Per-step text replies are work-in-progress chatter ("Buoc xong…") — they
        // must NOT be delivered to ANY channel (group OR the CEO's Telegram). The
        // actual deliverable happens via a tool call inside the relevant step.
        zaloTarget: undefined,
        suppressDelivery: true,
        label: `${niceLabel} [${step.stepNum}/${total}]`,
      });
      const dur = Date.now() - t0;
      if (ok) {
        completed.push({ n: step.stepNum, s: step.text.slice(0, 80) });
        console.log(`[cron-multistep] step ${step.stepNum} OK (${dur}ms)`);
      } else {
        failed.push(step.stepNum);
        console.warn(`[cron-multistep] step ${step.stepNum} FAILED (${dur}ms), skipping`);
      }
    } catch (e) {
      failed.push(step.stepNum);
      console.error(`[cron-multistep] step ${step.stepNum} error:`, e?.message);
    }
    journalCronRun({ phase: failed.includes(step.stepNum) ? 'multistep-step-fail' : 'multistep-step-ok', label: niceLabel, stepNum: step.stepNum, totalSteps: total });
  }

  console.log(`[cron-multistep] "${niceLabel}" done: ${completed.length}/${total} OK, ${failed.length} failed`);
  journalCronRun({ phase: failed.length === 0 ? 'multistep-done' : 'multistep-partial', label: niceLabel, completed: completed.length, failed: failed.length, totalSteps: total });
  if (failed.length > 0) {
    try { await sendCeoAlert(`Cron "${niceLabel}" xong ${completed.length}/${total} buoc.\nLoi: buoc ${failed.join(', ')}`); } catch {}
  }
  return completed.length > 0;
}

// ============================================================
//   runCronViaSessionOrFallback
// ============================================================

async function runCronViaSessionOrFallback(prompt, opts = {}) {
  // Warm the gateway FIRST so the cron uses the running (fast) gateway instead of
  // openclaw's slow cold-embedded fallback (which exceeds the cron timeout → SIGKILL
  // exit -9). Only restarts when the gateway is genuinely dead (see helper).
  await ensureGatewayWarmForCron(opts.label);
  // Multi-step detection: ONLY for [AUTO-MODE] prompts with numbered steps.
  // Non-AUTO-MODE prompts (evening briefing, morning report) may contain
  // numbered lists as formatting — splitting them destroys context.
  const isAutoMode = /\[AUTO-MODE\]/i.test(prompt);
  if (isAutoMode) {
    const parsed = parseMultiStepPrompt(prompt);
    if (parsed && parsed.steps.length >= MULTISTEP_MIN_STEPS) {
      return runMultiStepCronPrompt(prompt, opts);
    }
  }
  // When cron targets a Zalo group, session-send cannot deliver there (it only
  // replies to the CEO's Telegram session). Always use runCronAgentPrompt which
  // handles Zalo delivery with the actual agent reply text.
  if (opts.zaloTarget || opts.groupId || opts.groupIds) {
    return runCronAgentPrompt(prompt, opts);
  }
  const sessionKey = await getCeoSessionKey();
  if (sessionKey) {
    // Cap before session-send too: sessions.send carries the prompt in --params
    // argv (same 32KB Windows limit as the CLI path), so an uncapped weekly report
    // would throw ENAMETOOLONG here and waste a spawn before falling back.
    const ok = await sendToGatewaySession(sessionKey, capCronPromptBytes(prompt));
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
      sendTelegram('Xin lỗi, em chạy báo cáo bị lỗi. Thử lại sau vài phút giúp em.').catch(e => console.warn('[cron] telegram notify error:', e?.message));
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
        const parsedResult = parseCustomCronsJson(raw);
        const parsed = parsedResult.parsed;
        let needsWriteback = false;
        const writebackReasons = [];
        if (parsedResult.repaired) {
          const backupPath = customCronsPath + '.repair-backup-' + Date.now();
          try { fs.copyFileSync(customCronsPath, backupPath); } catch {}
          needsWriteback = true;
          writebackReasons.push('repaired raw control characters in string values');
          console.warn(`[custom-crons] auto-repaired JSON control characters in ${customCronsPath}. Backup: ${backupPath}`);
          try {
            const errFile = path.join(getWorkspace(), '.learnings', 'ERRORS.md');
            fs.mkdirSync(path.dirname(errFile), { recursive: true });
            fs.appendFileSync(errFile, `\n## ${new Date().toISOString()} — custom-crons.json auto-repaired\n\nOriginal error: ${parsedResult.originalError || 'invalid JSON'}\nBackup: ${backupPath}\nAction: Escaped raw control characters inside JSON string values and kept custom crons active.\n`, 'utf-8');
          } catch {}
          sendCeoAlert(`Custom cron bị lỗi JSON do nội dung có ký tự xuống dòng chưa được escape. Hệ thống đã tự sửa file và giữ lịch custom tiếp tục chạy. Bản gốc đã được backup: ${path.basename(backupPath)}.`).catch((e) => { console.error('[loadCustomCrons] repair alert error:', e.message); });
        }
        const beforeLen = parsed.length;
        const cleaned = parsed.filter(c => !c || c.source !== 'openclaw');
        const ocStripped = beforeLen - cleaned.length;
        if (ocStripped > 0) {
          parsed.length = 0;
          Array.prototype.push.apply(parsed, cleaned);
          needsWriteback = true;
          writebackReasons.push(`stripped ${ocStripped} OpenClaw-merged entries`);
        }
        const wasHealed = healCustomCronEntries(parsed);
        if (wasHealed) {
          needsWriteback = true;
          writebackReasons.push('healed aliases/default fields');
        }
        if (needsWriteback) {
          const snapshot = JSON.parse(JSON.stringify(parsed));
          _withCustomCronLock(async () => {
            try {
              writeJsonAtomic(customCronsPath, snapshot);
              console.log('[custom-crons] rewrote file after repair/migration: ' + writebackReasons.join('; '));
            } catch (e) { console.warn('[custom-crons] repair-writeback failed:', e.message); }
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

  const merged = [...modoroEntries, ...openclawEntries];
  const seen = new Set();
  const deduped = [];
  for (const c of merged) {
    if (!c) { deduped.push(c); continue; }
    const schedKey = c.cronExpr ? c.cronExpr.trim().replace(/\s+/g, ' ') : (c.oneTimeAt || '');
    if (!schedKey) { deduped.push(c); continue; }
    const targetKey = c.zaloTarget?.id || c.groupId || '';
    const promptFp = (c.prompt || '').length > 0
      ? require('crypto').createHash('md5').update(c.prompt).digest('hex').slice(0, 8)
      : '';
    const fp = schedKey + '|' + (targetKey || promptFp);
    if (!targetKey && !promptFp) { deduped.push(c); continue; }
    if (seen.has(fp)) {
      console.warn(`[custom-crons] DEDUP: skipping "${c.label || c.id}" — duplicate schedule+target/prompt: ${fp}`);
      continue;
    }
    seen.add(fp);
    deduped.push(c);
  }
  return deduped;
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

// C-I1 helper: read tail of audit.jsonl, populate `_cronInFlight` Map for
// any `cron_fired` event within the last 5 minutes with a marker so the
// matching scheduler tick (if it fires this minute due to crash recovery)
// skips. After 5 minutes, the Map auto-evicts.
function _seedRecentFiresFromAudit() {
  try {
    const auditPath = path.join(getWorkspace(), 'logs', 'audit.jsonl');
    if (!fs.existsSync(auditPath)) return;
    // Read last 64KB only — cron-fired events are tiny; 64KB is plenty for 5min.
    const stat = fs.statSync(auditPath);
    const offset = Math.max(0, stat.size - 65536);
    const fd = fs.openSync(auditPath, 'r');
    const buf = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    const lines = buf.toString('utf-8').split('\n').filter(Boolean);
    const cutoff = Date.now() - 5 * 60_000;
    let seeded = 0;
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (!e || e.event !== 'cron_fired') continue;
        // auditLog writes { t, event, pid, ...meta } — timestamp is `t`, and meta
        // (id/label) is spread at top level. Reading e.ts / e.meta.id (the old
        // code) always yielded undefined → the entire crash-recovery dedup was a
        // no-op → CEO reports could double-fire on a restart-within-the-minute.
        const ts = e.t ? Date.parse(e.t) : 0;
        if (!ts || ts < cutoff) continue;
        const id = e.id || e.label;
        if (!id) continue;
        // Mark as in-flight so the next fire (if it happens within 5min) skips.
        // Auto-expire after the remaining grace window.
        global._cronInFlight.set(id, true);
        const remainingMs = (ts + 5 * 60_000) - Date.now();
        if (remainingMs > 0) {
          setTimeout(() => { try { global._cronInFlight.delete(id); } catch {} }, remainingMs).unref?.();
        }
        seeded++;
      } catch {}
    }
    if (seeded > 0) console.log(`[cron] seeded ${seeded} recent fire(s) from audit log (crash recovery idempotency)`);
  } catch (e) { console.warn('[cron] _seedRecentFiresFromAudit error:', e?.message); }
}

// A one-time cron whose fire time already passed (machine asleep / app closed
// across the scheduled minute). Previously deleted SILENTLY — a missed customer
// commitment with zero trace. We do NOT auto-fire it late (the moment may be
// wrong for a time-sensitive customer-group post); instead surface it to the CEO
// (fail-loud) then remove. Idempotent: removal clears it so the next restart
// won't re-alert.
async function _handlePastDueOneTime(c) {
  try {
    const when = (() => { try { return new Date(c.oneTimeAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }); } catch { return c.oneTimeAt; } })();
    await sendCeoAlert(`*Cron một lần bị lỡ*\n\nLịch "${c.label || c.id}" đáng lẽ chạy lúc ${when} nhưng máy đang tắt/ngủ lúc đó. Em không tự chạy trễ để tránh gửi sai thời điểm — anh tạo lại nếu vẫn cần nhé.`);
  } catch (e) { console.warn('[cron] past-due alert failed:', e?.message); }
  try { await _removeCustomCronById(c.id); } catch (e) { console.error(`[cron] remove past-due ${c.id} failed:`, e?.message); }
}

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

  // C-I1 fix 2026-05-15: seed `_recentFireIds` from audit log so a cron that
  // ALREADY fired in the last 5 minutes (e.g. before a crash) does not
  // re-fire on next boot. The Map is process-lifetime; entries expire after
  // 5 minutes (longer than typical cron-schedule precision).
  try { _seedRecentFiresFromAudit(); } catch (e) { console.warn('[cron] audit seed failed:', e?.message); }

  selfTestOpenClawAgent()
    .then(async () => {
      if (!_agentCliVersionOk && !_selfTestAlertSent) {
        _selfTestAlertSent = true;
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
      case 'afternoon-nudge': {
        const [h, m] = (s.time || '14:00').split(':');
        cronExpr = `${m !== undefined && m !== '' ? m : 0} ${h !== undefined && h !== '' ? h : 14} * * *`;
        handler = async () => {
          console.log('[cron] Afternoon nudge triggered at', new Date().toISOString());
          if (global._cronInFlight?.get('afternoon-nudge')) return;
          global._cronInFlight?.set('afternoon-nudge', true);
          try {
            const prompt = buildAfternoonNudgePrompt(s.time);
            if (!prompt) {
              console.log('[cron] Afternoon nudge skipped — no actionable signals today');
              try { auditLog('cron_skipped', { id: 'afternoon-nudge', reason: 'no_signals' }); } catch {}
              return;
            }
            await runCronViaSessionOrFallback(prompt, { label: 'afternoon-nudge' });
            try { auditLog('cron_fired', { id: 'afternoon-nudge', label: s.label || 'Gợi ý chiều' }); } catch {}
          } catch (e) {
            console.error('[cron] Afternoon nudge threw:', e?.message || e);
            try { auditLog('cron_failed', { id: 'afternoon-nudge', label: 'Gợi ý chiều', error: String(e?.message || e).slice(0, 200) }); } catch {}
            try { await sendCeoAlert(`Cron "Gợi ý chiều" lỗi: ${String(e?.message || e).slice(0, 200)}`); } catch {}
          } finally {
            global._cronInFlight?.delete('afternoon-nudge');
          }
        };
        break;
      }
      case 'heartbeat': {
        // Removed — fast watchdog (gateway.js, 20s interval) covers all health
        // checks with better latency and safety. Heartbeat was redundant and
        // caused restart loops + HEARTBEAT_OK leak to customers.
        cronExpr = null;
        handler = null;
        break;
      }
      case 'meditation': {
        cronExpr = null;
        handler = null;
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
      if (typeof cron.validate === 'function' && !cron.validate(cronExpr)) {
        // A corrupt time field in schedules.json (e.g. "9:" → "  9 * * *") used to
        // make cron.schedule throw and the builtin schedule was silently skipped.
        // Surface it instead of letting a CEO report quietly never fire.
        console.error(`[cron] builtin ${s.id} has INVALID cronExpr "${cronExpr}" — skipping + alerting`);
        try { sendCeoAlert(`*Lịch "${s.id}" lỗi cấu hình giờ*\n\nGiờ đặt không hợp lệ (\`${cronExpr}\`) nên lịch này sẽ KHÔNG chạy. Anh kiểm tra lại giờ trong cài đặt nhé.`).catch(e => console.warn('[auto-fix] promise rejected:', e?.message)); } catch {}
      } else {
        try {
          const job = cron.schedule(cronExpr, handler, { timezone: 'Asia/Ho_Chi_Minh' });
          cronJobs.push({ id: s.id, job });
          console.log(`[cron] Scheduled ${s.id}: ${cronExpr}`);
        } catch (e) { console.error(`[cron] Failed to schedule ${s.id}:`, e.message); }
      }
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
  if (!global._cronFireDedup) global._cronFireDedup = new Map();
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
          console.log(`[cron] oneTime ${c.id} already past (${c.oneTimeAt}) — alerting CEO + removing`);
          _handlePastDueOneTime(c).catch(e => console.error(`[cron] past-due ${c.id} failed:`, e?.message));
          continue;
        }
        const effectiveDelay = Math.max(delayMs, 1000);
        const timer = setTimeout(async () => {
          // A-I2 fix 2026-05-15: oneTimeAt previously skipped both _cronInFlight
          // and _cronFireDedup. If restartCronJobs runs while a fire is in-flight
          // (e.g., quick /api/cron/replace), the new schedule could double-fire.
          const niceId = c.id || c.label || 'one-time';
          if (global._cronInFlight && global._cronInFlight.get(niceId)) {
            console.warn(`[cron] OneTime ${niceId} SKIPPED — already firing in this process`);
            return;
          }
          global._cronInFlight && global._cronInFlight.set(niceId, true);
          console.log(`[cron] OneTime "${c.label || c.id}" firing at`, new Date().toISOString());
          try {
            if (c.prompt && !c.prompt.startsWith('exec:')) {
              await runCronViaSessionOrFallback(c.prompt, { label: c.label || c.id, zaloTarget: c.zaloTarget, isOneTime: !!c.oneTimeAt });
            } else {
              await runCronAgentPrompt(c.prompt, { label: c.label || c.id, zaloTarget: c.zaloTarget, isOneTime: !!c.oneTimeAt });
            }
            try { auditLog('cron_fired', { id: c.id, label: c.label || c.id, kind: 'one-time' }); } catch {}
          } catch (e) {
            console.error(`[cron] OneTime ${c.id} failed:`, e?.message);
            try { auditLog('cron_failed', { id: c.id, label: c.label || c.id, kind: 'one-time', error: String(e?.message || e).slice(0, 200) }); } catch {}
            try { await sendCeoAlert(`*Cron một lần "${c.label || c.id}" lỗi*\n\n\`${String(e?.message || e).slice(0, 300)}\``); } catch {}
          } finally {
            global._cronInFlight && global._cronInFlight.delete(niceId);
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
          console.log(`[cron] oneTime ${c.id} already past (${c.oneTimeAt}) — alerting CEO + removing`);
          _handlePastDueOneTime(c).catch(e => console.error(`[cron] past-due ${c.id} failed:`, e?.message));
          continue;
        }
        const effectiveDelay = Math.max(delayMs, 1000);
        const timer = setTimeout(async () => {
          // A-I2 fix 2026-05-15 — mirror in-flight guard on the healed branch.
          const niceId = c.id || c.label || 'one-time';
          if (global._cronInFlight && global._cronInFlight.get(niceId)) {
            console.warn(`[cron] OneTime (healed) ${niceId} SKIPPED — already firing`);
            return;
          }
          global._cronInFlight && global._cronInFlight.set(niceId, true);
          console.log(`[cron] OneTime "${c.label || c.id}" firing at`, new Date().toISOString());
          try {
            if (c.prompt && !c.prompt.startsWith('exec:')) {
              await runCronViaSessionOrFallback(c.prompt, { label: c.label || c.id, zaloTarget: c.zaloTarget, isOneTime: !!c.oneTimeAt });
            } else {
              await runCronAgentPrompt(c.prompt, { label: c.label || c.id, zaloTarget: c.zaloTarget, isOneTime: !!c.oneTimeAt });
            }
            try { auditLog('cron_fired', { id: c.id, label: c.label || c.id, kind: 'one-time-healed' }); } catch {}
          } catch (e) {
            console.error(`[cron] OneTime ${c.id} failed:`, e?.message);
            try { auditLog('cron_failed', { id: c.id, label: c.label || c.id, kind: 'one-time-healed', error: String(e?.message || e).slice(0, 200) }); } catch {}
            try { await sendCeoAlert(`*Cron một lần "${c.label || c.id}" lỗi*\n\n\`${String(e?.message || e).slice(0, 300)}\``); } catch {}
          } finally {
            global._cronInFlight && global._cronInFlight.delete(niceId);
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
        if (c.cronExpr) {
          const promptFp = require('crypto').createHash('md5').update(c.prompt || '').digest('hex').slice(0, 8);
          const target = c.zaloTarget?.id || c.groupId || '';
          const minuteKey = c.cronExpr.trim().replace(/\s+/g, ' ') + '|' + promptFp + '|' + target + '|' + new Date().toISOString().slice(0, 16);
          const lastFire = global._cronFireDedup.get(minuteKey);
          if (lastFire) {
            console.warn(`[cron] Custom "${c.label || c.id}" SKIPPED — same cronExpr+prompt already fired this minute (by ${lastFire})`);
            journalCronRun({ phase: 'skip', label: c.label || c.id, reason: 'duplicate-fire-same-minute' });
            return;
          }
          global._cronFireDedup.set(minuteKey, niceId);
          setTimeout(() => global._cronFireDedup.delete(minuteKey), 120000);
        }
        global._cronInFlight.set(niceId, true);
        try {
          console.log(`[cron] Custom "${c.label || c.id}" triggered at`, new Date().toISOString());
          const ok = (c.prompt && !c.prompt.startsWith('exec:'))
            ? await runCronViaSessionOrFallback(c.prompt, { label: c.label || c.id, zaloTarget: c.zaloTarget, isOneTime: !!c.oneTimeAt })
            : await runCronAgentPrompt(c.prompt, { label: c.label || c.id, zaloTarget: c.zaloTarget, isOneTime: !!c.oneTimeAt });
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

  // Facebook scheduled posts: not included in the free edition.
}

// SEPARATE LOCK 2026-05-15: unrelated knowledge / workspace appends used to
// share the cron mutex, so a slow knowledge import would queue every cron
// create/delete/toggle behind it. Splitting locks keeps cron CRUD responsive
// while still serializing knowledge writes.
let _knowledgeWriteChain = Promise.resolve();
async function _withKnowledgeLock(fn) {
  let release;
  const gate = new Promise(r => { release = r; });
  const prev = _knowledgeWriteChain;
  _knowledgeWriteChain = gate;
  await prev;
  try { return await fn(); } finally { release(); }
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

// ─── Sleep/resume catch-up ───────────────────────────────────────────
// On Windows, lid close suspends the entire JS engine. node-cron only computes
// the NEXT future fire on resume, so any cron whose fire time fell during sleep
// is silently dropped. `replayMissedCrons(sinceMs)` walks the gap minute by
// minute, finds which crons would have fired, and fires the MOST RECENT missed
// instance ONCE (not all missed instances — 5 days of sleep should NOT trigger
// 5 morning briefings).
//
// Cron expression supported: standard 5-field `m h dom mon dow` with the most
// common subforms: `*`, exact int, `*/N`, `A-B`, `A,B,C`. Matches node-cron
// validate scope. Anything more exotic falls back to "no match" (safer).
function _parseCronField(field, min, max) {
  // Returns a Set<int> of values that match within [min,max], or null if invalid.
  const out = new Set();
  for (const part of String(field).split(',')) {
    let p = part.trim();
    if (!p) continue;
    let step = 1;
    const slash = p.split('/');
    if (slash.length === 2) { step = parseInt(slash[1], 10) || 1; p = slash[0]; }
    if (p === '*') {
      for (let i = min; i <= max; i++) if ((i - min) % step === 0) out.add(i);
      continue;
    }
    const range = p.split('-');
    if (range.length === 2) {
      const lo = parseInt(range[0], 10), hi = parseInt(range[1], 10);
      if (Number.isFinite(lo) && Number.isFinite(hi)) {
        for (let i = lo; i <= hi; i++) if ((i - lo) % step === 0 && i >= min && i <= max) out.add(i);
        continue;
      }
    }
    const n = parseInt(p, 10);
    if (Number.isFinite(n) && n >= min && n <= max) out.add(n);
  }
  return out.size ? out : null;
}

function _cronMatchesDate(expr, d) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [fMin, fHour, fDom, fMon, fDow] = parts;
  const min = _parseCronField(fMin, 0, 59);
  const hour = _parseCronField(fHour, 0, 23);
  const dom = _parseCronField(fDom, 1, 31);
  const mon = _parseCronField(fMon, 1, 12);
  const dow = _parseCronField(fDow, 0, 7); // 0+7 both = Sunday for cron tradition
  if (!min || !hour || !dom || !mon || !dow) return false;
  // node-cron schedules use { timezone: 'Asia/Ho_Chi_Minh' }, so we must
  // extract time components in that timezone — not system local time.
  const vnStr = d.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' });
  const vn = new Date(vnStr);
  if (!min.has(vn.getMinutes())) return false;
  if (!hour.has(vn.getHours())) return false;
  if (!mon.has(vn.getMonth() + 1)) return false;
  // Cron quirk: if BOTH dom and dow are restricted (not `*`), use OR; else AND.
  const dowVal = vn.getDay(); // 0=Sun
  const dowMatch = dow.has(dowVal) || (dowVal === 0 && dow.has(7));
  const domMatch = dom.has(vn.getDate());
  const domRestricted = fDom !== '*';
  const dowRestricted = fDow !== '*';
  if (domRestricted && dowRestricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

async function replayMissedCrons(sinceMs) {
  if (!sinceMs || typeof sinceMs !== 'number') return { replayed: 0, skipped: 0 };
  const now = Date.now();
  const gapMs = now - sinceMs;
  if (gapMs < 60_000) return { replayed: 0, skipped: 0, reason: 'gap_too_short' };
  // Hard cap: don't walk more than 7 days of minutes (10080 iterations).
  // Beyond that, just skip — CEO can manually re-run if they really care.
  const maxGapMs = 7 * 24 * 60 * 60_000;
  const walkFrom = gapMs > maxGapMs ? now - maxGapMs : sinceMs;

  // Gather all enabled cron expressions from schedules.json + custom-crons.json.
  // For each cron we'll record the LATEST timestamp that matched within the gap.
  const candidates = []; // [{ id, label, expr, handler, lastMatch }]
  try {
    const schedules = loadSchedules();
    for (const sched of (schedules || [])) {
      if (!sched || sched.enabled === false || !sched.time) continue;
      // schedules use HH:MM not cron expr — translate
      const m = String(sched.time).match(/^(\d{1,2}):(\d{2})$/);
      if (!m) continue;
      const cronExpr = `${parseInt(m[2], 10)} ${parseInt(m[1], 10)} * * *`;
      candidates.push({ id: 'sched:' + (sched.id || sched.label || 'unknown'), label: sched.label || sched.id || 'unknown', expr: cronExpr, isBuiltin: true });
    }
  } catch (e) { console.warn('[replayMissedCrons] loadSchedules failed:', e?.message); }
  try {
    const custom = loadCustomCrons() || [];
    for (const c of custom) {
      if (!c || c.enabled === false) continue;
      if (!c.cronExpr) continue; // oneTimeAt is re-loaded by startCronJobs, no replay needed
      candidates.push({ id: c.id, label: c.label || c.id, expr: c.cronExpr, prompt: c.prompt, zaloTarget: c.zaloTarget });
    }
  } catch (e) { console.warn('[replayMissedCrons] loadCustomCrons failed:', e?.message); }

  // Walk minute by minute from walkFrom to now. _cronMatchesDate converts
  // each Date to Asia/Ho_Chi_Minh before matching (consistent with node-cron tz).
  let replayed = 0, skipped = 0;
  for (const c of candidates) {
    let lastMatch = 0;
    for (let t = Math.ceil(walkFrom / 60_000) * 60_000; t <= now; t += 60_000) {
      const d = new Date(t);
      if (_cronMatchesDate(c.expr, d)) lastMatch = t;
    }
    if (!lastMatch) { skipped++; continue; }
    // Don't replay if gap < 5min (cron probably already fired post-resume).
    if (now - lastMatch < 5 * 60_000) { skipped++; continue; }
    console.log(`[replayMissedCrons] firing ${c.id} (${c.label}) — last match ${new Date(lastMatch).toISOString()}`);
    try { journalCronRun({ phase: 'replay-missed', label: c.label, id: c.id, missedAt: new Date(lastMatch).toISOString() }); } catch {}
    // For custom-cron entries, fire via runCronAgentPrompt (same path as
    // scheduled fire). For builtin schedules, defer to the next legitimate
    // fire — the builtin handlers may have side effects we don't want to
    // duplicate on resume (e.g. morning briefing also triggers data prep).
    // CEO is alerted that they were skipped.
    if (c.isBuiltin) {
      try { await sendCeoAlert(`[Cron resume] Lịch "${c.label}" đáng lẽ chạy lúc ${new Date(lastMatch).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })} nhưng máy đang ngủ. Em sẽ chạy lại lúc lịch tiếp theo.`); } catch {}
    } else if (c.prompt) {
      // Dedup against a near-simultaneous scheduled fire: hold the same
      // _cronInFlight key the scheduled handler checks, so node-cron firing this
      // cron while replay is mid-run is skipped (no double-deliver on wake).
      const niceId = c.id || c.label || 'replay';
      if (global._cronInFlight && global._cronInFlight.get(niceId)) { skipped++; continue; }
      if (global._cronInFlight) global._cronInFlight.set(niceId, true);
      try {
        if (c.prompt.startsWith('exec:')) await runCronAgentPrompt(c.prompt, { label: c.label, zaloTarget: c.zaloTarget, isOneTime: !!c.oneTimeAt });
        else await runCronViaSessionOrFallback(c.prompt, { label: c.label, zaloTarget: c.zaloTarget, isOneTime: !!c.oneTimeAt });
        replayed++;
      } catch (e) { console.warn(`[replayMissedCrons] ${c.id} failed:`, e?.message); }
      finally { if (global._cronInFlight) global._cronInFlight.delete(niceId); }
    }
  }
  console.log(`[replayMissedCrons] done — replayed=${replayed} skipped=${skipped} gapMin=${Math.round(gapMs / 60_000)}`);
  return { replayed, skipped, gapMs };
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
  cron_skipped: { label: 'Cron bỏ qua (không có tín hiệu)', icon: 'clock', show: true },
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
        const _vnParts = (dt) => {
          const s = dt.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
          const [datePart, timePart] = s.split(', ');
          const [mo, da] = datePart.split('/').map(Number);
          const [hh, mm] = timePart.split(':').map(Number);
          const dow = parseInt(dt.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh', weekday: 'narrow' }).replace(/[^0-6]/, ''), 10);
          return { m: mm, h: hh, dom: da, mon: mo, d: new Date(dt.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' })).getDay() };
        };
        for (let i = 0; i < 1440 * 31; i++) {
          const vn = _vnParts(candidate);
          const m = vn.m, h = vn.h, d = vn.d;
          const dom = vn.dom, mon = vn.mon;
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
    // Compute next fire in Vietnam timezone
    const vnNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
    const vnNext = new Date(vnNow);
    vnNext.setHours(h, m, 0, 0);
    if (vnNext <= vnNow) vnNext.setDate(vnNext.getDate() + 1);
    // Convert back to real UTC by computing the offset
    const offsetMs = vnNow.getTime() - now.getTime();
    const realNext = new Date(vnNext.getTime() - offsetMs);
    return realNext.toISOString();
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
  cronJournalPath: getCronJournalPath, journalCronRun, selfTestOpenClawAgent,
  buildAgentArgs, isTransientErr, isConfigInvalidErr, isFatalErr,
  parseSafeOpenzcaMsgSend, runSafeExecCommand,
  runCronAgentPrompt,
  runCronViaSessionOrFallback,
  // Schedule management
  getSchedulesPath, getCustomCronsPath,
  loadSchedules, loadCustomCrons,
  repairJsonControlCharsInStrings, parseCustomCronsJson,
  loadDailySummaries, generateWeeklySummary, loadWeeklySummaries,
  loadPromptTemplate,
  // Prompt builders
  buildMorningBriefingPrompt, buildEveningSummaryPrompt,
  buildWeeklyReportPrompt, buildMonthlyReportPrompt,
  scanZaloFollowUpCandidates, buildZaloFollowUpPrompt,
  buildMemoryCleanupPrompt,
  // Cron lifecycle
  healCustomCronEntries, watchCustomCrons,
  startCronJobs, stopCronJobs, restartCronJobs,
  // Sleep/resume catch-up (Windows lid close)
  replayMissedCrons,
  // CRUD helpers
  _withCustomCronLock, _withKnowledgeLock, _removeCustomCronById, surfaceCronConfigError,
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
