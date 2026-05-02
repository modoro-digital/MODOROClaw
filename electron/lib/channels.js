'use strict';
const fs = require('fs');
const path = require('path');
const ctx = require('./context');
const { writeJsonAtomic, sanitizeZaloText, stripTelegramMarkdown } = require('./util');
const { getWorkspace, auditLog } = require('./workspace');
const { writeOpenClawConfigIfChanged } = require('./config');
const {
  findGlobalPackageFile, findNodeBin, spawnOpenClawSafe,
} = require('./boot');

// Late-binding for functions not yet extracted from main.js
let _isZaloTargetAllowedFn = null;
function setIsZaloTargetAllowed(fn) { _isZaloTargetAllowedFn = fn; }

let _getZcaProfileFn = null;
function setGetZcaProfile(fn) { _getZcaProfileFn = fn; }

let _isKnownZaloTargetFn = null;
function setIsKnownZaloTarget(fn) { _isKnownZaloTargetFn = fn; }

let _readZaloChannelStateFn = null;
function setReadZaloChannelState(fn) { _readZaloChannelStateFn = fn; }

let _isGatewayAliveFn = null;
function setIsGatewayAlive(fn) { _isGatewayAliveFn = fn; }

let _checkZaloCookieAgeFn = null;
function setCheckZaloCookieAge(fn) { _checkZaloCookieAgeFn = fn; }

// ============================================
//  SEND CEO ALERT
// ============================================

// Send an alert to CEO via Telegram. Zalo outbound to CEO is not possible
// (CEO's Zalo account IS the bot — can't message yourself).
async function sendCeoAlert(text) {
  const opts = { skipFilter: true, skipPauseCheck: true };
  let delivered = false;
  try {
    const result = await sendTelegram(text, opts);
    delivered = result === true;
  } catch (e) {
    console.error('[sendCeoAlert] Telegram failed:', e?.message);
  }
  if (!delivered) {
    // Telegram failed — write to disk as last resort so nothing is silently lost
    try {
      const logsDir = path.join(getWorkspace(), 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      const missedFile = path.join(logsDir, 'ceo-alerts-missed.log');
      const entry = `${new Date().toISOString()} — UNDELIVERED: ${text.slice(0, 500)}\n`;
      fs.appendFileSync(missedFile, entry, 'utf-8');
      console.error('[sendCeoAlert] Telegram failed — wrote to ceo-alerts-missed.log');
    } catch (e) {
      console.error('[sendCeoAlert] Telegram failed AND disk write failed:', e?.message);
    }
  }
  return delivered;
}

// ============================================
//  TELEGRAM CONFIG + STICKY CHAT ID + GATEWAY AUTH
// ============================================

// Sticky chatId persistence — protects against the silent-failure mode where
// the openclaw.json loses its `channels.telegram.allowFrom` entry (manual edit,
// downgrade, partial wizard, etc.). We persist the chatId every time we observe
// it, and recover from this file when config is missing it.
function getStickyChatIdPath() {
  return path.join(ctx.HOME, '.openclaw', 'modoroclaw-sticky-chatid.json');
}
function persistStickyChatId(token, chatId) {
  try {
    if (!chatId) return;
    const file = getStickyChatIdPath();
    const fp = token ? require('crypto').createHash('sha256').update(token).digest('hex').slice(0, 16) : null;
    // D20: Compare-then-write to avoid file system thrash. getTelegramConfig
    // is called from EVERY sendTelegram + every cron fire — we'd otherwise
    // rewrite this file dozens of times per minute with identical content.
    if (fs.existsSync(file)) {
      try {
        const existing = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (existing.chatId === String(chatId) && existing.tokenFingerprint === fp) {
          return; // unchanged, skip write
        }
      } catch {}
    }
    writeJsonAtomic(file, {
      chatId: String(chatId),
      // Store a token hash (not the token itself) so we can verify the sticky
      // value belongs to the same bot if multiple bots are configured later.
      tokenFingerprint: fp,
      savedAt: new Date().toISOString(),
    });
  } catch (e) { console.error('[sticky-chatid] write error:', e.message); }
}
function loadStickyChatId(token) {
  try {
    const file = getStickyChatIdPath();
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    // If we know the token, verify the fingerprint matches — otherwise the
    // sticky value might belong to a different bot.
    if (token && data.tokenFingerprint) {
      const fp = require('crypto').createHash('sha256').update(token).digest('hex').slice(0, 16);
      if (fp !== data.tokenFingerprint) return null;
    }
    return data.chatId || null;
  } catch { return null; }
}

// Last-resort recovery: ask Telegram's getUpdates for any recent chat that has
// messaged this bot, and return the first numeric chat id. Works if the user
// has ever sent a message to the bot in the last ~24h. Returns null on failure.
//
// IMPORTANT (D19): we explicitly pass `offset: 0` and `timeout: 0` (i.e. NOT
// long polling) so this call:
//   1. Does NOT acknowledge any updates (no offset advance) — openclaw's own
//      poller still receives them.
//   2. Returns instantly without holding a long-poll connection that would
//      block openclaw's poller.
//   3. May still briefly conflict with openclaw's poll → Telegram returns
//      409 Conflict to one of us. We accept the failure and the recovery
//      simply returns null. We don't retry.
//
// Throttled to once per 60s so a misconfigured environment doesn't hammer
// Telegram on every cron fire.
let _lastRecoverChatIdAt = 0;
async function recoverChatIdFromTelegram(token) {
  if (!token) return null;
  const now = Date.now();
  if (now - _lastRecoverChatIdAt < 60000) {
    console.log('[recover-chatid] throttled (last attempt < 60s ago)');
    return null;
  }
  _lastRecoverChatIdAt = now;
  try {
    return await new Promise((resolve) => {
      const https = require('https');
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${token}/getUpdates?offset=0&timeout=0&limit=10`,
        method: 'GET',
        timeout: 5000,
      }, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (!parsed.ok || !Array.isArray(parsed.result)) {
              if (parsed.error_code === 409) {
                console.log('[recover-chatid] 409 Conflict (openclaw poller is active) — skipping');
              }
              return resolve(null);
            }
            // Iterate newest-first WITHOUT mutating the original array.
            for (let i = parsed.result.length - 1; i >= 0; i--) {
              const update = parsed.result[i];
              const chat = update?.message?.chat || update?.edited_message?.chat;
              if (chat && typeof chat.id === 'number' && chat.type === 'private') {
                console.log('[recover-chatid] recovered from Telegram getUpdates:', chat.id);
                return resolve(String(chat.id));
              }
            }
            resolve(null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    });
  } catch { return null; }
}

function getTelegramConfig() {
  try {
    const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const token = config?.channels?.telegram?.botToken;
    const allowFrom = config?.channels?.telegram?.allowFrom;
    let chatId = allowFrom && allowFrom[0]; // First allowed user = CEO
    if (chatId) {
      persistStickyChatId(token, chatId); // keep sticky file fresh
      return { token, chatId };
    }
    // Config-missing-chatId fallback: try sticky file
    const sticky = loadStickyChatId(token);
    if (sticky) {
      console.warn('[getTelegramConfig] chatId missing from openclaw.json — using sticky file value:', sticky);
      return { token, chatId: sticky, recovered: 'sticky' };
    }
    return { token, chatId: undefined };
  } catch { return {}; }
}

// Async variant that ALSO tries Telegram getUpdates as last resort. Use this
// in cron handlers where we MUST find a chatId or fail loudly.
async function getTelegramConfigWithRecovery() {
  const sync = getTelegramConfig();
  if (sync.chatId) return sync;
  if (sync.token) {
    console.warn('[getTelegramConfigWithRecovery] telegram allowFrom is missing; refusing getUpdates chat recovery');
  }
  return sync;
}

function getGatewayAuthToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  try {
    const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return config?.gateway?.auth?.token || null;
  } catch { return null; }
}

async function getCeoSessionKey() {
  try {
    const { chatId } = await getTelegramConfigWithRecovery();
    if (!chatId) return null;
    return `agent:main:telegram:direct:${chatId}`;
  } catch { return null; }
}

async function sendToGatewaySession(sessionKey, message) {
  try {
    const params = JSON.stringify({ key: sessionKey, message });
    const res = await spawnOpenClawSafe(
      ['gateway', 'call', 'sessions.send', '--params', params, '--json'],
      { timeoutMs: 180000, allowCmdShellFallback: false }
    );
    if (res.code !== 0) {
      console.warn('[sessions.send] failed (exit ' + res.code + '):', (res.stderr || '').slice(0, 300));
      return false;
    }
    console.log('[sessions.send] delivered to', sessionKey.slice(0, 40) + '...');
    return true;
  } catch (e) {
    console.warn('[sessions.send] error:', e?.message || e);
    return false;
  }
}

// ============================================
//  SHARED OUTPUT FILTER — same patterns for Telegram + Zalo
// ============================================
// Mirrors the 47 block patterns from the modoro-zalo fork send.ts so BOTH
// channels get the same defense-in-depth. Zalo's transport-layer filter in
// send.ts is the primary defense for Zalo; this function covers Telegram
// sends from main.js (cron delivery, alerts) and sendZalo() direct sends.
const _outputFilterPatterns = [
  // Layer A: file paths + secrets
  { name: 'file-path-memory', re: /\bmemory\/[\w\-./]*\.md\b/i },
  { name: 'file-path-learnings', re: /\.learnings\/[\w\-./]*/i },
  { name: 'file-path-core', re: /\b(?:SOUL|USER|MEMORY|AGENTS|IDENTITY|COMPANY|PRODUCTS|BOOTSTRAP|HEARTBEAT|TOOLS)\.md\b/i },
  { name: 'file-path-config', re: /\bopenclaw\.json\b/i },
  { name: 'line-ref', re: /#L\d+/i },
  { name: 'unix-home', re: /~\/\.openclaw|~\/\.openzca/i },
  { name: 'win-user-path', re: /[A-Z]:[/\\]Users[/\\]/i },
  { name: 'api-key-sk', re: /\bsk-[a-zA-Z0-9_\-]{16,}/i },
  { name: 'bearer-token', re: /\bBearer\s+[a-zA-Z0-9_\-.]{20,}/i },
  { name: 'hex-token-48', re: /\b[a-f0-9]{48}\b/i },
  { name: 'hex-token-partial', re: /\b[a-f0-9]{16,47}\b/i },
  { name: 'botToken-field', re: /\bbotToken\b/i },
  { name: 'apiKey-field', re: /\bapiKey\b/i },
  // Layer A1.7: PII masking — bot MUST NOT echo sensitive customer data
  // extracted from images (CCCD, bank receipts, ID cards) now that the
  // vision 5-layer patch enables OCR. Nghị định 13/2023 (VN privacy law).
  // Tuned CONSERVATIVE to avoid false-positive blocking legit CS replies:
  //   - CCCD/CMND: require context keyword adjacency. Bare 12-digit numbers
  //     are common (order codes, timestamps, tracking IDs) so we won't
  //     block those; we only block when the bot explicitly SAYS "CCCD"
  //     or "căn cước" or "số CMND" next to a 9/12-digit run.
  //   - Bank account: require context keyword. Bare long numbers don't trip.
  //   - Credit card: require 13-19 digits WITH separator pattern (raw
  //     clumps already appear in product SKUs, so don't match without
  //     typical "XXXX-XXXX-XXXX-XXXX" or "XXXX XXXX XXXX XXXX" shape).
  //   - Phone: intentionally NOT filtered — Vietnamese CS routinely echoes
  //     phone numbers ("hotline 0909..."). Blocking all phones breaks
  //     legitimate operation.
  { name: 'pii-cccd-cmnd', re: /(?:cccd|căn\s*cước|cmnd|chứng\s*minh\s*(?:nhân\s*dân|thư))[\s:=]*\d{9}(?:\d{3})?\b/i },
  { name: 'pii-bank-account', re: /(?:stk|số\s*tài\s*khoản|account\s*(?:number|no\.?)|acct\s*#?)[\s:=]*\d{6,20}/i },
  { name: 'pii-credit-card', re: /\b\d{4}[\s-]\d{4}[\s-]\d{4}[\s-]\d{1,4}\b/ },
  // Layer A1.4: upstream API / LLM error leakage — ChatGPT/OpenAI errors passed through
  // 9Router into bot reply text. Customer must NEVER see "[Error] Our servers are..."
  { name: 'api-error-bracket', re: /\[Error\]/i },
  { name: 'api-overloaded', re: /servers? (?:are |is )?(?:currently )?overloaded/i },
  { name: 'api-rate-limit', re: /rate.?limit(?:ed|ing)?\b/i },
  { name: 'api-try-again', re: /(?:please |pls )?try again later/i },
  { name: 'api-internal-error', re: /(?:internal server error|502 bad gateway|503 service|429 too many)/i },
  { name: 'api-quota-exceeded', re: /quota.?exceeded|usage.?limit/i },
  // Layer A1.5: bot "silent" tokens — model outputs these instead of truly staying silent
  { name: 'bot-silent-token', re: /^(NO_REPLY|SKIP|SILENT|DO_NOT_REPLY|IM_LANG|IM LẶNG|KHÔNG TRẢ LỜI|no.?reply|skip.?message)$/i },
  // Layer A2: compaction/context reset
  { name: 'compaction-notice', re: /(?:Auto-compaction|Compacting context|Context limit exceeded|reset our conversation)/i },
  { name: 'compaction-emoji', re: /🧹/ },
  // Layer B: English chain-of-thought leakage
  // NOTE: cot-en-the-actor intentionally excludes "customer" — legitimate CS replies
  // routinely reference "the customer" in English phrases. "assistant/bot/model" are CoT.
  { name: 'cot-en-the-actor', re: /\bthe (assistant|bot|model)\b/i },
  // NOTE: cot-en-we-modal excludes "we can / let me / let's / i'll" — these appear in
  // code-switched Vietnamese CS replies ("Let me check for you", "We can arrange that").
  // Only block the obvious CoT patterns that have no CS use case.
  { name: 'cot-en-we-modal', re: /\b(we need to|we have to|we should|i need to|i should)\b/i },
  { name: 'cot-en-meta', re: /\b(internal reasoning|chain of thought|system prompt|instructions|prompt injection|tool call)\b/i },
  { name: 'cot-en-narration', re: /\b(based on (the|our)|according to (the|my)|as (you|i) (can|mentioned)|in (the|this) conversation)\b/i },
  { name: 'cot-en-reasoning-verbs', re: /\b(let me think|hmm,? let|first,? (i|let|we)|okay,? (so|let|i)|alright,? (so|let|i))\b/i },
  // Layer C: meta-commentary about file/tool operations
  { name: 'meta-vi-file-ops', re: /(?<![a-zA-Z0-9_])(edit file|ghi (?:vào )?file|lưu (?:vào )?file|update file|append file|read file|đọc file|cập nhật file|sửa file|tạo file|xóa file)(?![a-zA-Z0-9_])/i },
  { name: 'meta-vi-tool-name', re: /\b(tool (?:Edit|Write|Read|Bash|Grep|Glob)|use the (?:Edit|Write|Read) tool|công cụ (?:Edit|Write|Read|Bash))\b/i },
  { name: 'meta-vi-memory-claim', re: /(?<![a-zA-Z0-9_])(đã (?:lưu|ghi|cập nhật|update) (?:vào |trong )?(?:bộ nhớ|memory|hồ sơ|file|database)|stored (?:in|to) memory|saved to (?:file|memory))(?![a-zA-Z0-9_])/i },
  { name: 'meta-vi-tool-action', re: /\b(em (?:vừa|đã) (?:edit|write|read|chạy|gọi) (?:file|tool|công cụ)|em (?:vừa|đã) (?:cập nhật|sửa|đọc) (?:file|memory|database))\b/i },
  { name: 'meta-vi-fact-claim', re: /(?<![a-zA-Z0-9_])(em đã (?:cập nhật|ghi (?:nhận|chú)|lưu(?: lại)?) (?:rằng|thêm rằng|sở thích|preference|là anh|là chị|là mình)|đã (?:cập nhật|ghi nhận|lưu) (?:thêm )?rằng)(?![a-zA-Z0-9_])/i },
  // Layer D: all-Latin / no-Vietnamese-diacritic (>200 chars, no URL)
  // Threshold raised 40→200: product listings like "iPhone 15 Pro 256GB: 25,900,000 VND"
  // are all-Latin but legitimate CS replies. CoT leaks are long walls of English text (>200c).
  { name: 'no-vietnamese-diacritic', re: /^(?!.*https?:\/\/)(?=[\s\S]{200,})(?!.*[àáảãạâấầẩẫậăắằẳẵặèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđÀÁẢÃẠÂẤẦẨẪẬĂẮẰẲẴẶÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴĐ]).+/s },
  // Layer E: brand + internal name leakage
  // v2.2.59 fix: old regex \bopenzca\b blocked legit system notifications
  // like "Zalo đã sẵn sàng" (mentions "openzca listener"). Tightened to
  // match only path-like / CoT-debug contexts: file exts, path separators,
  // debug verbs (error/crashed/spawn). Plain brand word is now allowed —
  // system alerts are either routed via sendCeoAlert (skipFilter=true) or
  // ready-notify (skipFilter=true), and AI CoT leaks always appear alongside
  // paths or debug verbs, not as bare brand name.
  { name: 'brand-9bizclaw', re: /9bizclaw[\/\\.\-](?:dist|cli|json|ts|js|log|md)|(?:error|crashed|spawn|exception|stack(?:\s*trace)?)\s+9bizclaw/i },
  { name: 'brand-openclaw', re: /openclaw[\/\\.\-](?:dist|cli|mjs|json|ts|js|log|md)|(?:error|crashed|spawn|exception|stack(?:\s*trace)?)\s+openclaw/i },
  { name: 'brand-9router', re: /9router[\/\\.\-](?:dist|cli|json|ts|js|log|md)|(?:error|crashed|spawn|exception|stack(?:\s*trace)?)\s+9router/i },
  { name: 'brand-openzca', re: /openzca[\/\\.\-](?:dist|cli|listen|json|ts|js|log|md)|(?:error|crashed|spawn|exception|stack(?:\s*trace)?)\s+openzca/i },
  // Layer F: prompt injection acknowledgment leakage
  { name: 'jailbreak-acknowledge', re: /\b(developer mode|jailbreak|ignore previous|forget instructions|role\s*play as|you are now|pretend to be)\b/i },
  { name: 'system-prompt-leak', re: /\b(my (?:instructions|prompt|system prompt|rules)|here (?:are|is) my (?:rules|instructions))/i },
  // Layer G: cross-customer PII leakage (any attempt to list customers)
  { name: 'list-all-customers', re: /(?:tất cả khách hàng|all customers|list customers|other customers?|khách khác cũng|khách hàng khác)/i },
  // Layer H: fake order confirmation / hallucinated commerce — bot must NEVER
  // confirm orders, prices, shipping fees, discounts, or bookings without CEO.
  // These patterns are aggressive — if they fire, the bot was about to make a
  // commitment it cannot honor, which creates legal + reputation risk.
  { name: 'fake-order-confirm', re: /(?:đã\s+(?:xác\s*nhận|tạo|lưu|ghi\s*nhận)\s*đơn|đơn\s*(?:của\s+(?:anh|chị|mình|bạn))?\s*(?:đã|được)\s+(?:tạo|xác\s*nhận|lưu|ghi))/i },
  { name: 'fake-shipping-fee', re: /(?:phí\s*ship|ship\s*phí|phí\s*vận\s*chuyển|tiền\s*ship)\s*[:=]?\s*\d{1,3}[.,]?\d{3}/i },
  { name: 'fake-total-amount', re: /tổng\s*(?:tiền|cộng|đơn\s*hàng|thanh\s*toán|cần\s*thanh\s*toán)\s*[:=]?\s*\d{1,3}[.,]?\d{3}/i },
  { name: 'fake-discount-percent', re: /(?:giảm\s*(?:giá)?|discount|khuyến\s*mãi|sale)\s*\d{1,2}\s*%/i },
  { name: 'fake-booking-confirmed', re: /(?:đã\s*(?:đặt|book|giữ|xác\s*nhận))\s*(?:lịch|bàn|phòng|chỗ|slot|lịch\s*hẹn|cuộc\s*hẹn)/i },
  { name: 'fake-payment-received', re: /(?:đã\s*nhận\s*(?:thanh\s*toán|tiền|chuyển\s*khoản)|payment\s*received)/i },
];

const _outputFilterSafeMsgs = [
  'Dạ em xin lỗi, cho em một phút em rà lại thông tin rồi báo lại mình ạ.',
  'Dạ em ghi nhận rồi ạ. Em sẽ kiểm tra và phản hồi lại mình ngay.',
  'Dạ em đang xác nhận lại thông tin, mình chờ em xíu nha.',
];

function filterSensitiveOutput(text) {
  if (!text || typeof text !== 'string') return { blocked: false, text };
  for (const p of _outputFilterPatterns) {
    if (p.re.test(text)) {
      const safeMsg = _outputFilterSafeMsgs[Math.floor(Math.random() * _outputFilterSafeMsgs.length)];
      try {
        const logDir = path.join(getWorkspace(), 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(path.join(logDir, 'security-output-filter.jsonl'),
          JSON.stringify({ t: new Date().toISOString(), event: 'output_blocked', pattern: p.name, channel: 'main-process', bodyPreview: text.slice(0, 200), bodyLength: text.length }) + '\n', 'utf-8');
      } catch {}
      return { blocked: true, pattern: p.name, text: safeMsg };
    }
  }
  return { blocked: false, text };
}

// ============================================
//  CHANNEL PAUSE — file-based pause for Telegram + Zalo (Dashboard control)
// ============================================
function _getPausePath(channel) {
  const ws = getWorkspace();
  if (!ws) return null;
  return path.join(ws, `${channel}-paused.json`);
}

function setChannelPermanentPause(channel, reason = 'manual-disabled') {
  const p = _getPausePath(channel);
  if (!p) return false;
  try {
    writeJsonAtomic(p, {
      permanent: true,
      reason,
      pausedAt: new Date().toISOString(),
    });
    console.log(`[pause] ${channel} permanently paused (${reason})`);
    return true;
  } catch (e) {
    console.error(`[pause] ${channel} permanent pause error:`, e.message);
    return false;
  }
}

function clearChannelPermanentPause(channel) {
  const p = _getPausePath(channel);
  if (!p) return false;
  try {
    if (!fs.existsSync(p)) return true;
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
      data = { permanent: true, reason: 'corrupt' };
    }
    if (data?.permanent) {
      fs.unlinkSync(p);
      console.log(`[pause] ${channel} permanent pause cleared`);
    }
    return true;
  } catch (e) {
    console.error(`[pause] ${channel} clear permanent pause error:`, e.message);
    return false;
  }
}

function isZaloChannelEnabled() {
  try {
    const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
    if (!fs.existsSync(configPath)) return false;
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return (cfg?.channels?.['modoro-zalo'] || cfg?.channels?.openzalo)?.enabled !== false;
  } catch (e) {
    console.error('[zalo] read enabled state error:', e.message);
    return false;
  }
}

async function setZaloChannelEnabled(enabled) {
  const { withOpenClawConfigLock } = require('./config');
  try {
    return await withOpenClawConfigLock(async () => {
      const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
      if (!fs.existsSync(configPath)) return false;
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (!cfg.channels) cfg.channels = {};
      if (!cfg.channels['modoro-zalo'] || typeof cfg.channels['modoro-zalo'] !== 'object') {
        cfg.channels['modoro-zalo'] = {};
      }
      const next = enabled !== false;
      if (!cfg.plugins) cfg.plugins = {};
      if (!cfg.plugins.entries) cfg.plugins.entries = {};
      if (!cfg.plugins.entries['modoro-zalo'] || typeof cfg.plugins.entries['modoro-zalo'] !== 'object') {
        cfg.plugins.entries['modoro-zalo'] = {};
      }
      if (cfg.channels['modoro-zalo'].enabled === next && cfg.plugins.entries['modoro-zalo'].enabled === next) return true;
      cfg.channels['modoro-zalo'].enabled = next;
      cfg.plugins.entries['modoro-zalo'].enabled = next;
      try {
        const stickyPath = path.join(ctx.HOME, '.openclaw', 'modoroclaw-sticky-zalo-enabled.json');
        writeJsonAtomic(stickyPath, { enabled: next, ts: Date.now() });
      } catch (e) { console.warn('[zalo] sticky write error:', e?.message); }
      return writeOpenClawConfigIfChanged(configPath, cfg);
    });
  } catch (e) {
    console.error('[zalo] set enabled state error:', e.message);
    return false;
  }
}

function isChannelPaused(channel) {
  const p = _getPausePath(channel);
  if (!p) return false;
  try {
    if (!fs.existsSync(p)) return false;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
      // Corrupt pause file — fail closed: treat as paused to honor CEO's intent.
      // Better to block 1 message than to ignore a deliberate pause request.
      console.error(`[pause] ${channel} pause file corrupt — treating as paused (fail closed)`);
      return true;
    }
    // Permanent pause (e.g. default-disabled on fresh install) — no expiry
    if (data.permanent) return true;
    if (data.pausedUntil && new Date(data.pausedUntil) > new Date()) return true;
    // Expired — clean up
    try { fs.unlinkSync(p); } catch {}
    return false;
  } catch {
    console.error(`[pause] ${channel} unexpected error — treating as paused (fail closed)`);
    return true;
  }
}

function pauseChannel(channel, durationMin = 30) {
  const p = _getPausePath(channel);
  if (!p) return false;
  const until = new Date(Date.now() + durationMin * 60 * 1000).toISOString();
  try {
    writeJsonAtomic(p, { pausedUntil: until, pausedAt: new Date().toISOString() });
    console.log(`[pause] ${channel} paused until ${until}`);
    return true;
  } catch (e) { console.error(`[pause] ${channel} error:`, e.message); return false; }
}

function resumeChannel(channel) {
  const p = _getPausePath(channel);
  if (!p) return false;
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  console.log(`[pause] ${channel} resumed`);
  return true;
}

function getChannelPauseStatus(channel) {
  const p = _getPausePath(channel);
  if (!p) return { paused: false };
  try {
    if (!fs.existsSync(p)) return { paused: false };
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (data.permanent) return { paused: true, permanent: true };
    if (data.pausedUntil && new Date(data.pausedUntil) > new Date()) {
      return { paused: true, until: data.pausedUntil };
    }
    try { fs.unlinkSync(p); } catch {}
    return { paused: false };
  } catch {
    return { paused: true, permanent: true, error: 'corrupt' };
  }
}

// ============================================
//  SEND FUNCTIONS
// ============================================

// skipFilter: bypass output filter for system alerts (cron errors, boot pings)
// that are OUR messages, not AI-generated. Blocking these would cause silent failures.
// R1: strip Telegram Markdown v1 syntax tokens so plain-text send doesn't
// leak raw `*` / backtick / triple-backtick into CEO's alert output.
// sendCeoAlert call sites use `*bold*` + ``` code fences historically.
async function sendTelegram(text, { skipFilter = false, skipPauseCheck = false } = {}) {
  // Check pause state — skip send if Telegram is paused
  if (!skipPauseCheck && isChannelPaused('telegram')) {
    console.log('[sendTelegram] channel paused — skipping');
    return null;
  }
  // Output filter — same patterns as Zalo transport filter
  if (!skipFilter) {
    const filtered = filterSensitiveOutput(text);
    if (filtered.blocked) {
      console.warn(`[sendTelegram] output filter blocked (${filtered.pattern})`);
      text = filtered.text;
    }
  } else {
    // Bypass audit — so we can later verify bypass isn't abused.
    console.log('[sendTelegram] filter BYPASSED for system alert');
    try {
      const logDir = path.join(getWorkspace(), 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(path.join(logDir, 'security-output-filter.jsonl'),
        JSON.stringify({ t: new Date().toISOString(), event: 'output_bypass', channel: 'telegram', bodyPreview: text.slice(0, 200), bodyLength: text.length }) + '\n', 'utf-8');
    } catch {}
  }
  const { token, chatId } = getTelegramConfig();
  if (!token || !chatId) {
    console.error('[sendTelegram] missing token or chatId');
    return null;
  }
  // CRIT #8: Robust send with 429 retry, 401/403 persistent-failure alert,
  // 400 parse-mode fallback. Old code used parse_mode:'Markdown' (legacy v1)
  // which failed 400 on URLs with `_` or customer names like "DJ_Kool" — silent
  // cron drop. We now send plain text (no parse_mode) — safe for all content.
  // Strip Markdown syntax since we send without parse_mode (plain text)
  text = stripTelegramMarkdown(text);
  if (text.length > 4000) {
    // Filter runs on FULL text above (before this split), so chunks skip filter safely
    let c = text.lastIndexOf('\n\n', 4000);
    if (c < 200) c = text.lastIndexOf('\n', 4000);
    if (c < 200) c = text.lastIndexOf(' ', 4000);
    if (c < 200) c = 4000;
    await sendTelegram(text.slice(0, c), { skipFilter: true, skipPauseCheck });
    await new Promise(r => setTimeout(r, 300));
    return sendTelegram(text.slice(c).trimStart(), { skipFilter: true, skipPauseCheck });
  }
  const https = require('https');
  const doRequest = (withRetry = true) => new Promise((resolve) => {
    const payload = JSON.stringify({ chat_id: chatId, text });
    const req = https.request(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { method: 'POST', timeout: 30000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', async () => {
          try {
            const parsed = JSON.parse(d);
            if (parsed.ok) { resolve(true); return; }
            const code = parsed.error_code || res.statusCode;
            const desc = parsed.description || '';
            // 429: rate limit — retry once after retry_after seconds
            if (code === 429 && withRetry) {
              const wait = Math.min((parsed.parameters?.retry_after || 3) * 1000, 15000);
              console.warn(`[sendTelegram] 429 rate limit — retrying in ${wait}ms`);
              setTimeout(() => doRequest(false).then(resolve), wait);
              return;
            }
            // 401/403: token revoked or bot blocked — log to missed-alerts
            if (code === 401 || code === 403) {
              console.error('[sendTelegram] token invalid/blocked:', desc);
              try {
                const logPath = path.join(getWorkspace(), 'logs', 'ceo-alerts-missed.log');
                fs.mkdirSync(path.dirname(logPath), { recursive: true });
                fs.appendFileSync(logPath, `${new Date().toISOString()}\tTELEGRAM-${code}\t${desc}\t${text.slice(0, 200)}\n`);
              } catch {}
              resolve(null);
              return;
            }
            if ((code >= 500 || code === 0) && withRetry) {
              console.warn(`[sendTelegram] server error ${code} — retrying in 5s`);
              setTimeout(() => doRequest(false).then(resolve), 5000);
              return;
            }
            console.error('[sendTelegram] API error:', code, desc);
            resolve(null);
          } catch (e) { console.error('[sendTelegram] parse error:', e.message); resolve(null); }
        });
      }
    );
    req.on('error', (e) => {
      if (withRetry) { console.warn('[sendTelegram] network error — retrying in 5s:', e.message); setTimeout(() => doRequest(false).then(resolve), 5000); }
      else { console.error('[sendTelegram] network error:', e.message); resolve(null); }
    });
    req.on('timeout', () => {
      req.destroy();
      if (withRetry) { console.warn('[sendTelegram] timeout — retrying in 5s'); setTimeout(() => doRequest(false).then(resolve), 5000); }
      else { resolve(null); }
    });
    req.write(payload);
    req.end();
  });
  return doRequest(true);
}

async function sendTelegramPhoto(imagePath, caption, _retryCount = 0) {
  const { token, chatId } = getTelegramConfig();
  if (!token || !chatId) return false;
  if (!fs.existsSync(imagePath)) return false;

  const crypto = require('crypto');
  const https = require('https');
  const boundary = '----FormBoundary' + crypto.randomBytes(16).toString('hex');
  const imgBuf = fs.readFileSync(imagePath);
  const filename = path.basename(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';

  let body = '';
  body += `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`;
  if (caption) body += `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`;
  body += `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;

  const prefix = Buffer.from(body, 'utf-8');
  const suffix = Buffer.from(tail, 'utf-8');
  const payload = Buffer.concat([prefix, imgBuf, suffix]);

  return new Promise(resolve => {
    const req = https.request(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': payload.length }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (parsed.ok) return resolve(true);
          if (parsed.error_code === 429 && _retryCount < 3) {
            const wait = ((parsed.parameters && parsed.parameters.retry_after) || 5) * 1000;
            setTimeout(() => sendTelegramPhoto(imagePath, caption, _retryCount + 1).then(resolve), wait);
            return;
          }
          resolve(false);
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(30000, () => { req.destroy(); resolve(false); });
    req.write(payload);
    req.end();
  });
}

// Send a direct Zalo message to the CEO's personal Zalo account via openzca CLI.
// Mirrors sendTelegram() for parity. Used by cron alerts and fallback delivery.
async function sendZalo(text, opts = {}) {
  // Zalo outbound disabled — owner system removed. Alerts go via Telegram only.
  return null;
}

// ============================================
//  ZALO LISTENER CHECK + SEND ZALO TO
// ============================================

let _zaloListenerAlive = null;
let _zaloListenerAliveAt = 0;
const ZALO_LISTENER_CACHE_TTL = 30000;
function isZaloListenerAlive() {
  const now = Date.now();
  if (_zaloListenerAlive !== null && (now - _zaloListenerAliveAt) < ZALO_LISTENER_CACHE_TTL) {
    return _zaloListenerAlive;
  }
  const pid = findOpenzcaListenerPid();
  _zaloListenerAlive = !!pid;
  _zaloListenerAliveAt = now;
  return _zaloListenerAlive;
}

// Send a Zalo message to an arbitrary target (user or group), unlike sendZalo()
// which only ever talks to the configured CEO owner. Used by appointment push
// targets so bot/cron can push meeting links into any group or friend.
async function sendZaloTo(target, text, opts = {}) {
  let targetId, isGroup;
  if (typeof target === 'string') {
    if (target.startsWith('group:')) { targetId = target.slice(6); isGroup = true; }
    else if (target.startsWith('user:')) { targetId = target.slice(5); isGroup = false; }
    else { targetId = target; isGroup = false; }
  } else if (target && typeof target === 'object') {
    targetId = String(target.id || target.toId || '');
    isGroup = !!target.isGroup;
  }
  if (!targetId) { console.error('[sendZaloTo] missing target id'); return null; }

  const { skipFilter = false, skipPauseCheck = false } = opts;
  if (!isZaloChannelEnabled()) {
    console.log('[sendZaloTo] channel disabled in config — skipping');
    return null;
  }
  if (!skipPauseCheck && isChannelPaused('zalo')) {
    console.log('[sendZaloTo] channel paused — skipping');
    return null;
  }
  if (!opts.skipListenerCheck && !isZaloListenerAlive()) {
    console.error('[sendZaloTo] Zalo listener not running — refusing send (would silently fail)');
    return null;
  }
  if (!skipFilter) {
    text = sanitizeZaloText(text);
    const filtered = filterSensitiveOutput(text);
    if (filtered.blocked) {
      console.warn(`[sendZaloTo] output filter blocked (${filtered.pattern})`);
      text = filtered.text;
    }
  }

  const allow = _isZaloTargetAllowedFn ? _isZaloTargetAllowedFn(targetId, { isGroup }) : { allowed: true };
  if (!allow.allowed) {
    console.warn(`[sendZaloTo] blocked by policy (${allow.reason}) target=${targetId}`);
    return null;
  }

  const zcaBin = findGlobalPackageFile('openzca', 'dist/cli.js');
  if (!zcaBin) { console.error('[sendZaloTo] openzca CLI not found'); return null; }
  const nodeBin = findNodeBin() || 'node';
  const zcaProfile = opts.profile || (allow.state?.profile) || (_getZcaProfileFn ? _getZcaProfileFn() : 'default');
  const knownTarget = _isKnownZaloTargetFn ? _isKnownZaloTargetFn(targetId, { isGroup, profile: zcaProfile }) : { known: true };
  if (!knownTarget.known) {
    console.warn(`[sendZaloTo] target not in cache (${knownTarget.reason}) target=${targetId}`);
    return null;
  }

  const ZALO_CHUNK = 2000;
  const chunks = [];
  if (text.length > ZALO_CHUNK) {
    let remaining = text;
    while (remaining.length > ZALO_CHUNK) {
      let cut = ZALO_CHUNK;
      const paraBreak = remaining.lastIndexOf('\n\n', ZALO_CHUNK);
      if (paraBreak > 200) { cut = paraBreak + 2; }
      else {
        const sentBreak = remaining.slice(0, ZALO_CHUNK).search(/[.!?][^.!?]*$/);
        if (sentBreak > 200) { cut = sentBreak + 1; }
        else {
          const spaceBreak = remaining.lastIndexOf(' ', ZALO_CHUNK);
          if (spaceBreak > 200) { cut = spaceBreak + 1; }
        }
      }
      chunks.push(remaining.slice(0, cut).trimEnd());
      remaining = remaining.slice(cut).trimStart();
    }
    if (remaining.length > 0) chunks.push(remaining);
  } else {
    chunks.push(text);
  }

  const sendOneChunk = (chunk) => new Promise((resolve) => {
    try {
      const liveAllow = _isZaloTargetAllowedFn ? _isZaloTargetAllowedFn(targetId, { isGroup }) : { allowed: true };
      if (!liveAllow.allowed) {
        console.log(`[sendZaloTo] blocked before chunk send (${liveAllow.reason})`);
        resolve(null);
        return;
      }
      if (!isZaloChannelEnabled()) {
        console.log('[sendZaloTo] disabled before chunk send — aborting');
        resolve(null);
        return;
      }
      if (isChannelPaused('zalo')) {
        console.log('[sendZaloTo] paused before chunk send — aborting');
        resolve(null);
        return;
      }
      const args = [zcaBin, '--profile', zcaProfile, 'msg', 'send', targetId, chunk];
      if (isGroup) args.push('--group');
      const child = require('child_process').spawn(
        nodeBin, args,
        { shell: false, timeout: 20000, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => {
        if (code === 0) {
          resolve(true);
        } else {
          console.error(`[sendZaloTo] exit ${code}: ${stderr.slice(0, 200)}`);
          resolve(null);
        }
      });
      child.on('error', (e) => { console.error('[sendZaloTo] spawn error:', e.message); resolve(null); });
    } catch (e) {
      console.error('[sendZaloTo] error:', e.message);
      resolve(null);
    }
  });

  let lastResult = null;
  for (let i = 0; i < chunks.length; i++) {
    lastResult = await sendOneChunk(chunks[i]);
    if (!lastResult) {
      console.error(`[sendZaloTo] chunk ${i + 1}/${chunks.length} failed`);
      break;
    }
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 800));
  }
  if (lastResult) {
    console.log(`[sendZaloTo] sent to ${isGroup ? 'group' : 'user'} ${targetId}${chunks.length > 1 ? ` (${chunks.length} chunks)` : ''}`);
  }
  return lastResult;
}

const ZALO_IMAGE_MEDIA_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.heic', '.heif', '.avif']);

function readZaloMediaPolicy() {
  const policy = { maxMb: 25, roots: [] };
  try {
    const cfgPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      const candidates = [
        cfg?.mediaMaxMb,
        cfg?.messages?.mediaMaxMb,
        cfg?.channels?.['modoro-zalo']?.mediaMaxMb,
        cfg?.channels?.['modoro-zalo']?.messages?.mediaMaxMb,
      ].filter(v => Number.isFinite(Number(v)));
      if (candidates.length) policy.maxMb = Math.max(1, Math.min(100, Number(candidates[0])));
      const rootCandidates = [
        cfg?.mediaLocalRoots,
        cfg?.messages?.mediaLocalRoots,
        cfg?.channels?.['modoro-zalo']?.mediaLocalRoots,
        cfg?.channels?.['modoro-zalo']?.messages?.mediaLocalRoots,
      ].flat().filter(Boolean);
      policy.roots.push(...rootCandidates.map(String));
    }
  } catch {}
  return policy;
}

function resolveAllowedMediaRoots(extraRoots = []) {
  const ws = getWorkspace();
  const roots = [
    path.join(ws, 'media-assets'),
    path.join(ws, 'brand-assets'),
    path.join(ws, 'knowledge'),
    path.join(ws, 'documents'),
    ...extraRoots,
  ].filter(Boolean);
  return Array.from(new Set(roots.map(root => {
    const raw = String(root);
    return path.resolve(path.isAbsolute(raw) ? raw : path.join(ws, raw));
  })));
}

function isWithinAnyRoot(filePath, roots) {
  const resolved = path.resolve(filePath);
  return roots.some(root => resolved === root || resolved.startsWith(root + path.sep));
}

function resolveZaloMediaFile(filePath, opts = {}) {
  if (!filePath || typeof filePath !== 'string') throw new Error('filePath required');
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error('media file not found');
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error('media path is not a file');
  const policy = readZaloMediaPolicy();
  const maxMb = Number.isFinite(Number(opts.maxMb)) ? Number(opts.maxMb) : policy.maxMb;
  if (stat.size > maxMb * 1024 * 1024) throw new Error(`media file too large (max ${maxMb}MB)`);
  const roots = resolveAllowedMediaRoots([...(policy.roots || []), ...(opts.mediaLocalRoots || [])]);
  if (!opts.allowOutsideWorkspace && !isWithinAnyRoot(resolved, roots)) {
    throw new Error('media path is outside allowed roots');
  }
  return { path: resolved, size: stat.size, ext: path.extname(resolved).toLowerCase() };
}

async function sendZaloMediaTo(target, filePath, opts = {}) {
  let targetId, isGroup;
  if (typeof target === 'string') {
    if (target.startsWith('group:')) { targetId = target.slice(6); isGroup = true; }
    else if (target.startsWith('user:')) { targetId = target.slice(5); isGroup = false; }
    else { targetId = target; isGroup = false; }
  } else if (target && typeof target === 'object') {
    targetId = String(target.id || target.toId || '');
    isGroup = !!target.isGroup;
  }
  if (!targetId) { console.error('[sendZaloMediaTo] missing target id'); return null; }

  let media;
  try {
    media = resolveZaloMediaFile(filePath, opts);
  } catch (e) {
    console.error('[sendZaloMediaTo] invalid media:', e.message);
    return null;
  }

  const { skipFilter = false, skipPauseCheck = false } = opts;
  if (!isZaloChannelEnabled()) {
    console.log('[sendZaloMediaTo] channel disabled in config — skipping');
    return null;
  }
  if (!skipPauseCheck && isChannelPaused('zalo')) {
    console.log('[sendZaloMediaTo] channel paused — skipping');
    return null;
  }
  if (!opts.skipListenerCheck && !isZaloListenerAlive()) {
    console.error('[sendZaloMediaTo] Zalo listener not running — refusing send (would silently fail)');
    return null;
  }

  let caption = opts.caption ? String(opts.caption) : '';
  if (caption && !skipFilter) {
    caption = sanitizeZaloText(caption);
    const filtered = filterSensitiveOutput(caption);
    if (filtered.blocked) {
      console.warn(`[sendZaloMediaTo] caption filter blocked (${filtered.pattern})`);
      caption = filtered.text;
    }
  }

  const allow = _isZaloTargetAllowedFn ? _isZaloTargetAllowedFn(targetId, { isGroup }) : { allowed: true };
  if (!allow.allowed) {
    console.warn(`[sendZaloMediaTo] blocked by policy (${allow.reason}) target=${targetId}`);
    return null;
  }

  const zcaBin = findGlobalPackageFile('openzca', 'dist/cli.js');
  if (!zcaBin) { console.error('[sendZaloMediaTo] openzca CLI not found'); return null; }
  const nodeBin = findNodeBin() || 'node';
  const zcaProfile = opts.profile || (allow.state?.profile) || (_getZcaProfileFn ? _getZcaProfileFn() : 'default');
  const knownTarget = _isKnownZaloTargetFn ? _isKnownZaloTargetFn(targetId, { isGroup, profile: zcaProfile }) : { known: true };
  if (!knownTarget.known) {
    console.warn(`[sendZaloMediaTo] target not in cache (${knownTarget.reason}) target=${targetId}`);
    return null;
  }

  const sendMode = ZALO_IMAGE_MEDIA_EXTS.has(media.ext) ? 'image' : 'upload';
  return await new Promise((resolve) => {
    try {
      const liveAllow = _isZaloTargetAllowedFn ? _isZaloTargetAllowedFn(targetId, { isGroup }) : { allowed: true };
      if (!liveAllow.allowed) {
        console.log(`[sendZaloMediaTo] blocked before send (${liveAllow.reason})`);
        resolve(null);
        return;
      }
      if (!isZaloChannelEnabled()) {
        console.log('[sendZaloMediaTo] disabled before send — aborting');
        resolve(null);
        return;
      }
      if (isChannelPaused('zalo')) {
        console.log('[sendZaloMediaTo] paused before send — aborting');
        resolve(null);
        return;
      }
      const args = sendMode === 'image'
        ? [zcaBin, '--profile', zcaProfile, 'msg', 'image', targetId, media.path]
        : [zcaBin, '--profile', zcaProfile, 'msg', 'upload', media.path, targetId];
      if (sendMode === 'image' && caption) args.push('--message', caption);
      if (isGroup) args.push('--group');
      const child = require('child_process').spawn(
        nodeBin, args,
        { shell: false, timeout: opts.timeoutMs || 125000, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stderr = '';
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => {
        if (code === 0) {
          console.log(`[sendZaloMediaTo] sent ${sendMode} to ${isGroup ? 'group' : 'user'} ${targetId}`);
          resolve({ ok: true, mode: sendMode, stdout: stdout.slice(0, 1000) });
        } else {
          console.error(`[sendZaloMediaTo] exit ${code}: ${stderr.slice(0, 300)}`);
          resolve(null);
        }
      });
      child.on('error', (e) => { console.error('[sendZaloMediaTo] spawn error:', e.message); resolve(null); });
    } catch (e) {
      console.error('[sendZaloMediaTo] error:', e.message);
      resolve(null);
    }
  });
}

// ============================================
//  READY PROBES
// ============================================

// CEO complaint: "cần có cách nào đó show telegram và zalo thật sự sẵn sàng
// nhận tin nhắn, kiểu phải chắc chắn được". The dashboard used to display
// "running" based purely on whether OUR processes were spawned — that's a lie
// because the gateway can be up while the Telegram bot token is invalid, or
// while the Zalo listener has died/lost cookies. These probes hit the actual
// upstream service to prove the channel is reachable end-to-end.

// Telegram: call getMe — Telegram's API endpoint that returns bot identity.
// 200 + ok=true is conclusive proof: the token is valid AND Telegram's servers
// can reach this bot. Cheap (~150ms), doesn't send a user-visible message.
function getReadyGateState(channel) {
  const state = (global._readyNotifyState && global._readyNotifyState[channel]) || {};
  return {
    markerSeen: !!state.markerSeen,
    confirmed: !!state.confirmedAt,
    confirmedAt: state.confirmedAt || 0,
    confirmedBy: state.confirmedBy || '',
    awaitingConfirmation: !!state.awaitingConfirmation,
    lastError: state.lastError || '',
  };
}

function finalizeTelegramReadyProbe(base, hasCeoChatId) {
  if (!hasCeoChatId) {
    return { ...base, ready: false, reason: 'no-ceo-chat-id',
      error: 'Chưa có CEO chat ID để gửi tin xác nhận.' };
  }
  if (!ctx.botRunning) {
    return { ...base, ready: false, error: 'Gateway chưa khởi động' };
  }
  // READY GATE: dot green ONLY when gateway has emitted channel marker
  // AND notification sent. This is the contract: green = bot CAN reply.
  // getMe passing only proves token is valid, NOT that the channel pipeline
  // is initialized. On slow machines (Kaspersky, HDD), channel init takes
  // 1-3 min after WS ready. Showing green before that misleads CEO into
  // sending messages that get no reply.
  const gate = getReadyGateState('telegram');
  if (gate.confirmed) {
    return { ...base, ready: true };
  }
  if (gate.markerSeen) {
    return { ...base, ready: false, awaitingConfirmation: true,
      error: 'Telegram sắp sẵn sàng, đang gửi tin xác nhận...' };
  }
  // WS ready + getMe pass but channel not yet initialized
  return { ...base, ready: false, awaitingConfirmation: true,
    error: 'Đang khởi tạo kênh Telegram... (1-2 phút)' };
}

function finalizeZaloReadyProbe(base) {
  if (!ctx.botRunning) {
    return { ...base, ready: false, error: 'Gateway chưa khởi động' };
  }
  const gate = getReadyGateState('zalo');
  if (gate.confirmed) {
    return { ...base, ready: true };
  }
  if (gate.markerSeen) {
    return { ...base, ready: false, awaitingConfirmation: true,
      error: 'Zalo sắp sẵn sàng, đang xác nhận...' };
  }
  return { ...base, ready: false, awaitingConfirmation: true,
    error: 'Đang khởi tạo kênh Zalo... (1-2 phút)' };
}

async function probeTelegramReady() {
  const { token, chatId } = getTelegramConfig();
  if (!token) return { ready: false, error: 'Chưa cấu hình bot token' };
  const https = require('https');
  return await new Promise((resolve) => {
    const req = https.get(
      `https://api.telegram.org/bot${token}/getMe`,
      { timeout: 6000 },
      (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.ok && parsed.result) {
              resolve(finalizeTelegramReadyProbe({
                username: parsed.result.username,
                botName: parsed.result.first_name,
                botId: parsed.result.id,
                hasCeoChatId: !!chatId,
              }, !!chatId));
            } else {
              resolve({ ready: false, error: parsed.description || 'Telegram API trả về lỗi' });
            }
          } catch (e) {
            resolve({ ready: false, error: 'Phản hồi không hợp lệ: ' + e.message });
          }
        });
      }
    );
    req.on('error', (e) => resolve({ ready: false, error: 'Không kết nối được Telegram: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ready: false, error: 'Timeout kết nối Telegram (>6s)' }); });
  });
}

// Zalo: 3-layer check
//   1. listener-owner.json must exist (openzca wrote its pid)
//   2. The pid must still be a live `openzca listen` process
//   3. Cookie cache file must have been refreshed in the last 30 minutes
//      (stale cookies = listener will silently drop messages)
// Find any running `openzca ... listen ...` process. Returns its PID or null.
// This is the AUTHORITATIVE check — listener-owner.json is just a lock file
// which can be missing during the brief window between process spawn and
// `acquireListenerOwnerLock()`. The process itself is the source of truth.
function findOpenzcaListenerPid() {
  try {
    if (process.platform === 'win32') {
      // PowerShell primary (wmic deprecated/removed on Win11 24H2+).
      let wmicOut = null;
      try {
        wmicOut = require('child_process').execSync(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*openzca*listen*' } | Select-Object -ExpandProperty ProcessId"`,
          { encoding: 'utf-8', timeout: 5000 }
        );
      } catch { wmicOut = null; }

      if (wmicOut) {
        for (const line of wmicOut.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.toLowerCase().startsWith('node')) continue;
          const pid = parseInt(trimmed, 10);
          if (Number.isFinite(pid) && pid >= 100) return pid;
        }
      }

      // PowerShell fallback (works even when wmic is disabled)
      try {
        const psOut = require('child_process').execSync(
          `powershell -NoProfile -Command "Get-WmiObject Win32_Process -Filter \\"name='node.exe'\\" | Where-Object { $_.CommandLine -like '*openzca*listen*' } | Select-Object -ExpandProperty ProcessId"`,
          { encoding: 'utf-8', timeout: 5000, windowsHide: true }
        );
        for (const line of psOut.trim().split('\n')) {
          const pid = parseInt(line.trim(), 10);
          if (Number.isFinite(pid) && pid >= 100) return pid;
        }
      } catch {}
    } else {
      // Mac/Linux: pgrep -f matches command line. Returns one PID per line.
      // pgrep exit 1 = no matches → empty string. Iterate to be safe.
      const out = require('child_process').execSync(
        `pgrep -f "openzca.*listen" 2>/dev/null || true`,
        { encoding: 'utf-8', timeout: 3000, shell: '/bin/sh' }
      );
      for (const line of out.trim().split('\n')) {
        const pid = parseInt(line.trim(), 10);
        if (Number.isFinite(pid) && pid >= 100) return pid;
      }
    }
  } catch (e) {
    if (process.env.BIZCLAW_DEBUG) console.error('[findOpenzcaListenerPid]', e.message);
  }
  return null;
}

async function probeZaloReady() {
  try {
    const state = _readZaloChannelStateFn ? _readZaloChannelStateFn() : { enabled: true, profile: 'default' };
    const pause = getChannelPauseStatus('zalo');
    if (state.configError) {
      return {
        ready: false,
        reason: 'config-error',
        error: 'Cấu hình Zalo đang lỗi hoặc chưa đọc được. Bot giữ trạng thái tắt để an toàn.',
      };
    }
    if (state.enabled === false) {
      return {
        ready: false,
        reason: 'disabled',
        error: 'Zalo đang tắt trong Dashboard. Bot sẽ không tự trả lời.',
      };
    }
    if (pause?.permanent) {
      return {
        ready: false,
        reason: 'paused-permanent',
        error: 'Zalo đang bị khóa an toàn trong Dashboard. Chỉ bật lại khi đã kiểm tra xong.',
      };
    }
    if (pause?.paused) {
      return {
        ready: false,
        reason: 'paused',
        error: pause.until ? `Zalo đang tạm dừng đến ${pause.until}.` : 'Zalo đang tạm dừng.',
      };
    }

    const ozDir = path.join(ctx.HOME, '.openzca', 'profiles', state.profile || 'default');
    const ownerFile = path.join(ozDir, 'listener-owner.json');
    const credsFile = path.join(ozDir, 'credentials.json');

    // CRITICAL ORDERING FIX (2026-04-08): process check MUST come before cookie
    // expiry check. Previously we returned `session-expired` based purely on
    // cookie file timestamps (lastAccessed + maxAge math), even when the
    // openzca listener process was running AND actively replying to Zalo
    // messages. Root cause: Zalo's zlogin_session has maxAge=3600 (1 hour)
    // but openzca maintains the WebSocket via keepalive without rewriting the
    // credentials file on every use. The file timestamp goes stale while the
    // live session keeps working. Result: CEO saw "Zalo đã hết hạn" in
    // Dashboard while Zalo replies arrived normally.
    //
    // Rule: if the listener process is alive, Zalo is READY by definition.
    // Cookie expiry math is only a diagnostic when the process is NOT running.
    // PRIMARY check: process by name (authoritative — process IS the listener,
    // regardless of whether the lock file has been written yet). Solves the
    // race window where listener-owner.json doesn't exist for ~3-5s after the
    // openzca subprocess spawns and before it calls acquireListenerOwnerLock().
    const processPid = findOpenzcaListenerPid();

    // SECONDARY check: lock file content (preferred when present — gives us
    // session metadata that the process check can't).
    let ownerPid = null;
    let ownerErr = null;
    if (fs.existsSync(ownerFile)) {
      try {
        const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf-8'));
        if (owner.pid) ownerPid = owner.pid;
        else ownerErr = 'lock file thiếu pid';
      } catch (e) { ownerErr = 'lock file hỏng: ' + e.message; }
    }

    // Cookie cache freshness — youngest mtime in the profile dir as proxy.
    // The auto-refresh interval is 10 min so 30+ min stale = something broken.
    let youngestMtime = 0;
    try {
      for (const entry of fs.readdirSync(ozDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        try {
          const m = fs.statSync(path.join(ozDir, entry.name)).mtimeMs;
          if (m > youngestMtime) youngestMtime = m;
        } catch {}
      }
    } catch {}
    const cacheAgeMin = youngestMtime ? Math.floor((Date.now() - youngestMtime) / 60000) : null;

    // Decide ready state. Listener process running = ready (cache may still be
    // refreshing in the background). No process = not ready, regardless of
    // lock file (a stale lock from a crashed process must be treated as down).
    const listenerPid = processPid || ownerPid || null;

    if (!processPid && !ownerPid) {
      // BOOT GRACE: During the first 60s after gateway start, openzca hasn't
      // spawned yet. Don't show scary "session expired" — show "đang khởi động".
      // Without this, boot fast-poll at 500ms hits this path, sees cookie maxAge
      // expired (Zalo session cookie has maxAge=3600 but openzca keeps it alive
      // via WebSocket without rewriting the file), and flashes "hết hạn" briefly.
      const bootGraceMs = 60000;
      const gatewayStartedAt = global._gatewayStartedAt || 0;
      const inBootGrace = gatewayStartedAt && (Date.now() - gatewayStartedAt < bootGraceMs);

      // Listener is not running. Check WHY and return the most actionable
      // error message. Credentials/expiry checks go HERE (fallback
      // diagnostics), not at the top — they previously caused false-positive
      // "expired" reports even when the process was happily maintaining the
      // WebSocket via keepalive.
      if (!fs.existsSync(credsFile)) {
        return {
          ready: false,
          reason: 'no-credentials',
          error: inBootGrace
            ? 'Zalo đang khởi động...'
            : 'Chưa đăng nhập Zalo. Vào tab Zalo bấm "Đổi tài khoản" để quét QR.',
        };
      }

      // During boot grace, skip cookie expiry check entirely — just say "đang khởi động"
      if (inBootGrace) {
        return {
          ready: false,
          reason: 'boot-grace',
          error: 'Zalo đang khởi động...',
          cacheAgeMin,
        };
      }

      // Cookie maxAge check removed — Zalo sessions persist indefinitely
      // while the listener keeps the WebSocket alive. The maxAge field in
      // credentials.json is misleading (openzca refreshes internally).
      return {
        ready: false,
        error: 'Listener chưa chạy. Đợi gateway khởi động Zalo channel (~10-15 giây sau khi mở app).',
        cacheAgeMin,
      };
    }

    // Process check failed but lock file claims a pid → verify the lock's pid
    // is alive and is actually openzca (not a recycled pid).
    if (!processPid && ownerPid) {
      let aliveAndOpenzca = false;
      if (process.platform === 'win32') {
        try {
          const out = require('child_process').execSync(
            `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${ownerPid}').CommandLine"`,
            { encoding: 'utf-8', timeout: 5000 }
          );
          aliveAndOpenzca = /openzca/i.test(out) && /listen/i.test(out);
        } catch {}
      } else {
        try {
          process.kill(ownerPid, 0);
          const cmdline = require('child_process').execSync(
            `ps -p ${ownerPid} -o command=`,
            { encoding: 'utf-8', timeout: 3000 }
          ).trim();
          aliveAndOpenzca = /openzca/i.test(cmdline) && /listen/i.test(cmdline);
        } catch {}
      }
      if (!aliveAndOpenzca) {
        // openzca auto-reconnects in 1-2s after periodic session refresh.
        // Debounce: wait 3s and re-check before declaring down, to avoid
        // false "stale lock" flashes during the normal reconnect window.
        await new Promise(r => setTimeout(r, 3000));
        // Re-read lock file — if PID changed, new process is up
        try {
          const freshOwner = JSON.parse(fs.readFileSync(ownerFile, 'utf-8'));
          if (freshOwner.pid && freshOwner.pid !== ownerPid) {
            return finalizeZaloReadyProbe({ listenerPid: freshOwner.pid, lastRefreshMinAgo: cacheAgeMin });
          }
        } catch {}
        // Also retry process search (PowerShell fallback may now succeed)
        const retryPid = findOpenzcaListenerPid();
        if (retryPid) {
          return finalizeZaloReadyProbe({ listenerPid: retryPid, lastRefreshMinAgo: cacheAgeMin });
        }
        return {
          ready: false,
          error: 'Listener đã thoát (lock file còn nhưng pid ' + ownerPid + ' không còn chạy)',
          listenerPid: ownerPid,
          cacheAgeMin,
        };
      }
    }

    // Stale cache warning (still ready — listener can reconnect)
    if (cacheAgeMin != null && cacheAgeMin > 30) {
      return finalizeZaloReadyProbe({
        listenerPid,
        lastRefreshMinAgo: cacheAgeMin,
        warning: `Cookie cache ${cacheAgeMin} phút trước — sắp cần refresh.`,
      });
    }

    return finalizeZaloReadyProbe({
      listenerPid,
      lastRefreshMinAgo: cacheAgeMin,
    });
  } catch (e) {
    return { ready: false, error: 'Probe error: ' + e.message };
  }
}

// ============================================
//  CHANNEL STATUS BROADCAST
// ============================================

// Periodic broadcast of channel readiness to the renderer so the sidebar dots
// stay fresh. Boot phase polls fast (every 3s for 30s) so the CEO sees the
// state flip from "checking" → "ready" as soon as the gateway brings the
// modoro-zalo channel up (typically 10-15s after gateway start). After the boot
// window, fall back to 45s steady-state polling.
let _channelStatusInterval = null;
let _channelStatusBootTimers = [];
let _lastChannelState = { telegram: null, zalo: null };
let _lastChannelAlertAt = { telegram: 0, zalo: 0 };
let _channelStatusBroadcastInFlight = false;
let _channelStatusTickCount = 0;
// Grace period: absorb brief disconnects (network blip, DNS hiccup) so the
// status dot doesn't flash red on transient failures. Only flip to not-ready
// after 3 consecutive probe failures (~2+ min at 45s interval).
const _CHANNEL_FAIL_GRACE = 3;
let _channelConsecutiveFails = { telegram: 0, zalo: 0 };
async function broadcastChannelStatusOnce() {
  if (_channelStatusBroadcastInFlight) return;
  if (!ctx.mainWindow || ctx.mainWindow.isDestroyed()) return;
  // PERF: skip expensive probes when window is not visible/focused, but still
  // run every 5th tick (~3.75min) so dots aren't completely stale when user opens app.
  _channelStatusTickCount++;
  try {
    if (!ctx.mainWindow.isVisible() || ctx.mainWindow.isMinimized()) {
      if (_channelStatusTickCount % 5 !== 0) return;
    }
  } catch {} // isVisible/isMinimized can throw if window is mid-destruction
  _channelStatusBroadcastInFlight = true;
  try {
    // Gate: if bot is stopped, both channels are not-ready by definition.
    // Don't probe Telegram getMe (token is valid even when gateway is off).
    if (!ctx.botRunning) {
      ctx.mainWindow.webContents.send('channel-status', {
        telegram: { ready: false, error: 'Bot đang dừng' },
        zalo: { ready: false, error: 'Bot đang dừng' },
        checkedAt: new Date().toISOString(),
      });
      return;
    }
    // Marker cache: if gateway confirmed alive within 5 min, skip the alive
    // probe entirely. This MUST run before isGatewayAlive() — the old order
    // (alive check first, marker check second) caused false-negative gray dots
    // when gateway was busy serving an AI completion and didn't respond to the
    // 2s health check. The marker IS proof the gateway is alive.
    const MARKER_FRESH_MS = 5 * 60 * 1000;
    const notifyState = global._readyNotifyState || null;
    const now = Date.now();
    const tgFresh = notifyState?.telegram?.markerSeenAt && (now - notifyState.telegram.markerSeenAt) < MARKER_FRESH_MS;
    const zlFresh = notifyState?.zalo?.markerSeenAt && (now - notifyState.zalo.markerSeenAt) < MARKER_FRESH_MS;
    const bothFresh = tgFresh && zlFresh;
    // Gate 2: gateway spawned (ctx.botRunning=true) but not yet listening on :18789.
    // Skip if both markers fresh — gateway was confirmed alive recently.
    if (!bothFresh) {
      const __gwAlive = _isGatewayAliveFn ? await _isGatewayAliveFn(8000) : false;
      if (!__gwAlive) {
        ctx.mainWindow.webContents.send('channel-status', {
          telegram: { ready: false, error: 'Đang khởi động...' },
          zalo: { ready: false, error: 'Đang khởi động...' },
          checkedAt: new Date().toISOString(),
        });
        return;
      }
    }
    const [tg, zl] = await Promise.all([
      tgFresh
        ? Promise.resolve({ ready: true, cachedFromMarker: true })
        : probeTelegramReady(),
      zlFresh
        ? Promise.resolve({ ready: true, cachedFromMarker: true })
        : probeZaloReady(),
    ]);
    if (tgFresh || zlFresh) {
      console.log(`[channel-status] skip probe (marker fresh) telegram=${!!tgFresh} zalo=${!!zlFresh}`);
    }
    // Grace period: if a channel was previously ready and just failed, keep
    // reporting ready until _CHANNEL_FAIL_GRACE consecutive failures. Prevents
    // the dot from flashing red on brief network blips (a few seconds).
    const rawProbes = { telegram: tg, zalo: zl };
    const smoothed = {};
    for (const ch of ['telegram', 'zalo']) {
      const probe = rawProbes[ch];
      const prev = _lastChannelState[ch];
      if (probe.ready) {
        _channelConsecutiveFails[ch] = 0;
        smoothed[ch] = probe;
      } else if (prev && prev.ready && _channelConsecutiveFails[ch] < _CHANNEL_FAIL_GRACE) {
        _channelConsecutiveFails[ch]++;
        console.log(`[channel-status] ${ch} probe failed but within grace (${_channelConsecutiveFails[ch]}/${_CHANNEL_FAIL_GRACE}) — keeping green`);
        smoothed[ch] = { ...prev, gracePeriod: true };
      } else {
        smoothed[ch] = probe;
      }
    }
    ctx.mainWindow.webContents.send('channel-status', {
      telegram: { ...smoothed.telegram, paused: isChannelPaused('telegram') },
      zalo: { ...smoothed.zalo, paused: isChannelPaused('zalo') },
      checkedAt: new Date().toISOString(),
    });

    try { if (_checkZaloCookieAgeFn) _checkZaloCookieAgeFn(); } catch {}

    // F-2: alert only after 5 minutes of continuous disconnect (skip transient
    // restarts / AI-busy probe misses). Previously this alerted on first
    // ready→not-ready transition with only 15min THROTTLE_MS — CEO phone
    // buzzed on every reply-serving probe miss. The grace logic used to live
    // in startChannelStatusBroadcast but was unreachable dead code behind
    // an accidental early `return await`.
    const THROTTLE_MS = 15 * 60 * 1000;
    const DOWN_GRACE_MS = 5 * 60 * 1000;
    // `now` already declared above (marker-fresh check); reuse.
    const probes = { telegram: tg, zalo: zl };
    const labels = { telegram: 'Telegram', zalo: 'Zalo' };
    if (!global._channelDownSince) global._channelDownSince = {};
    for (const ch of ['telegram', 'zalo']) {
      const prev = _lastChannelState[ch];
      const cur = probes[ch];
      if (cur.ready === false) {
        if (!global._channelDownSince[ch]) global._channelDownSince[ch] = now;
      }
      if (cur.ready === true) {
        delete global._channelDownSince[ch];
      }
      if (cur.ready === false && global._channelDownSince[ch] && (now - global._channelDownSince[ch]) >= DOWN_GRACE_MS) {
        if (now - (_lastChannelAlertAt[ch] || 0) >= THROTTLE_MS) {
          const hhmm = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
          const reason = (cur && cur.error) ? String(cur.error) : 'không rõ';
          const downMin = Math.round((now - global._channelDownSince[ch]) / 60000);
          const msg = `Kênh ${labels[ch]} mất kết nối đã ${downMin} phút (từ ${hhmm}). Tự khôi phục không thành công. Mở Dashboard kiểm tra giúp em ạ. Lý do: ${reason}.`;
          sendCeoAlert(msg).catch((e) => { console.error('[channel-status] sendCeoAlert error:', e.message); });
          _lastChannelAlertAt[ch] = now;
        }
      }
      _lastChannelState[ch] = smoothed[ch];
    }
  } catch (e) {
    console.error('[channel-status] broadcast error:', e.message);
  } finally {
    _channelStatusBroadcastInFlight = false;
  }
}
function startChannelStatusBroadcast() {
  if (_channelStatusInterval) clearInterval(_channelStatusInterval);
  for (const t of _channelStatusBootTimers) clearTimeout(t);
  _channelStatusBootTimers = [];
  // Tear down any previous fs.watch handles from a prior broadcast setup.
  if (global._channelStatusWatchers) {
    for (const w of global._channelStatusWatchers) { try { w.close(); } catch {} }
  }
  global._channelStatusWatchers = [];

  const broadcast = async () => broadcastChannelStatusOnce();
  // Debounced broadcast — file watchers can fire 2-3 events per write
  // (create + modify on Windows). Coalesce within 250ms.
  let _watchDebounce = null;
  const broadcastSoon = (reason) => {
    if (_watchDebounce) clearTimeout(_watchDebounce);
    _watchDebounce = setTimeout(() => {
      _watchDebounce = null;
      console.log('[channel-status] fs.watch trigger:', reason);
      broadcast();
    }, 250);
  };

  // Boot phase: fast polls so listener spawn is caught quickly (first 30s)
  // Boot phase: defer probes until gateway has had time to start channels.
  // Previously started at T+500ms — all probes before T+30s are wasted
  // (gateway still loading, Telegram getMe times out, Zalo scan finds nothing).
  // Now: first probe at T+15s, then every 5s until T+60s. Saves ~10 wasted
  // probe cycles (each = 6s HTTPS timeout + process scan).
  const bootDelays = [15000, 20000, 25000, 30000, 35000, 40000, 50000, 60000];
  for (const delay of bootDelays) {
    _channelStatusBootTimers.push(setTimeout(broadcast, delay));
  }
  // Steady-state polling — 45s cadence (matches CLAUDE.md v2.2.7 intent).
  // Fast boot-phase timers above catch the first 30s; fs.watch handles
  // instant updates on state-file writes. The 45s interval is pure backstop
  // for edge cases (cookie age, offline listener). Marker-fresh cache in
  // broadcastChannelStatusOnce further short-circuits probes for 5 minutes
  // after gateway emits a ready marker, so steady-state cost is minimal.
  _channelStatusInterval = setInterval(broadcast, 45 * 1000);

  // INSTANT triggers — file watches on load-bearing state files. Any write
  // fires a coalesced broadcast in <500ms. This eliminates the "phải bấm
  // Refresh mới thấy xanh" lag: listener-owner.json created → dot xanh
  // within 250ms; pause file deleted → dot xanh immediately; etc.
  const watchTargets = [];
  try {
    const ozDir = path.join(ctx.HOME, '.openzca', 'profiles', 'default');
    if (fs.existsSync(ozDir)) watchTargets.push({ dir: ozDir, label: 'openzca-profile' });
  } catch {}
  try {
    const ws = getWorkspace();
    if (fs.existsSync(ws)) watchTargets.push({ dir: ws, label: 'workspace' });
  } catch {}
  try {
    const openclawDir = path.join(ctx.HOME, '.openclaw');
    if (fs.existsSync(openclawDir)) watchTargets.push({ dir: openclawDir, label: 'openclaw' });
  } catch {}
  for (const { dir, label } of watchTargets) {
    try {
      const watcher = fs.watch(dir, { persistent: false }, (eventType, filename) => {
        if (!filename) return;
        const name = String(filename);
        if (
          name === 'listener-owner.json' ||
          name === 'credentials.json' ||
          name === 'zalo-paused.json' ||
          name === 'telegram-paused.json' ||
          name === 'openclaw.json'
        ) {
          broadcastSoon(`${label}/${name}`);
        }
      });
      watcher.on('error', () => {}); // ignore — fall back to polling
      global._channelStatusWatchers.push(watcher);
    } catch (e) {
      console.warn('[channel-status] fs.watch failed on', dir, ':', e?.message);
    }
  }
}

// ============================================
//  TELEGRAM COMMANDS + RICH SEND
// ============================================

async function registerTelegramCommands() {
  const { token } = getTelegramConfig();
  if (!token) return;
  const https = require('https');
  const commands = [
    // --- Custom MODOROClaw ---
    { command: 'menu', description: 'Xem mẫu giao việc theo ngành' },
    { command: 'baocao', description: 'Tạo báo cáo tổng hợp ngay lập tức' },
    { command: 'huongdan', description: 'Hướng dẫn cách sử dụng trợ lý' },
    { command: 'skill', description: 'Xem danh sách kỹ năng đã cài' },
    // /thuvien removed — Knowledge tab in Dashboard is the canonical document store.
    // Bot reads knowledge/<cat>/index.md per AGENTS.md bootstrap rule.
    // --- OpenClaw built-in (CEO-friendly) ---
    { command: 'new', description: 'Bắt đầu phiên hội thoại mới' },
    { command: 'reset', description: 'Xóa ngữ cảnh, bắt đầu lại từ đầu' },
    { command: 'status', description: 'Xem trạng thái bot (model, token, chi phí)' },
    { command: 'stop', description: 'Dừng tác vụ đang chạy' },
    { command: 'usage', description: 'Xem chi phí sử dụng AI' },
    { command: 'help', description: 'Xem tất cả lệnh có thể dùng' },
    { command: 'restart', description: 'Khởi động lại trợ lý' },
  ];
  return new Promise((resolve) => {
    const payload = JSON.stringify({ commands });
    const req = https.request(
      `https://api.telegram.org/bot${token}/setMyCommands`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { console.log('[telegram] setMyCommands:', d); resolve(d); }); }
    );
    req.on('error', (e) => { console.error('[telegram] setMyCommands error:', e.message); resolve(null); });
    req.write(payload);
    req.end();
  });
}

// ============================================
//  CLEANUP
// ============================================

function trackChannelBootTimer(t) {
  if (_channelStatusBootTimers.length > 50) {
    _channelStatusBootTimers = _channelStatusBootTimers.slice(-20);
  }
  _channelStatusBootTimers.push(t);
}

function cleanupChannelTimers() {
  if (_channelStatusInterval) { clearInterval(_channelStatusInterval); _channelStatusInterval = null; }
  for (const t of _channelStatusBootTimers) clearTimeout(t);
  _channelStatusBootTimers = [];
  if (global._channelStatusWatchers) {
    for (const w of global._channelStatusWatchers) { try { w.close(); } catch {} }
    global._channelStatusWatchers = [];
  }
}

module.exports = {
  // Config
  getStickyChatIdPath, persistStickyChatId, loadStickyChatId,
  recoverChatIdFromTelegram, getTelegramConfig, getTelegramConfigWithRecovery,
  getGatewayAuthToken, getCeoSessionKey, sendToGatewaySession,
  // Filter + Pause
  filterSensitiveOutput,
  _getPausePath, setChannelPermanentPause, clearChannelPermanentPause,
  isZaloChannelEnabled, setZaloChannelEnabled,
  isChannelPaused, pauseChannel, resumeChannel, getChannelPauseStatus,
  // Send
  sendTelegram, sendTelegramPhoto, sendZalo, sendZaloTo, sendZaloMediaTo, sendCeoAlert,
  // Probes
  isZaloListenerAlive, getReadyGateState,
  finalizeTelegramReadyProbe, finalizeZaloReadyProbe,
  probeTelegramReady, findOpenzcaListenerPid, probeZaloReady,
  // Broadcast
  broadcastChannelStatusOnce, startChannelStatusBroadcast,
  // Telegram commands
  registerTelegramCommands,
  // Late-binding setters
  setIsZaloTargetAllowed,
  setGetZcaProfile,
  setIsKnownZaloTarget,
  setReadZaloChannelState,
  setIsGatewayAlive,
  setCheckZaloCookieAge,
  // Cleanup
  trackChannelBootTimer,
  cleanupChannelTimers,
};
