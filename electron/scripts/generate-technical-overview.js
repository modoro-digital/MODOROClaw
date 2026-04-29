#!/usr/bin/env node
// Generate 9BizClaw-Technical-Overview.docx from verified codebase facts.
// Run: node electron/scripts/generate-technical-overview.js

const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, TableOfContents,
  ShadingType, PageBreak } = require('docx');
const fs = require('fs');
const path = require('path');

const FONT = 'Calibri';
const ACCENT = '1F4E79';
const LIGHT_BG = 'E8F0FE';

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 400, after: 200 },
    children: [new TextRun({ text, font: FONT, size: 32, bold: true, color: ACCENT })],
  });
}
function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 300, after: 150 },
    children: [new TextRun({ text, font: FONT, size: 26, bold: true, color: ACCENT })],
  });
}
function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 200, after: 100 },
    children: [new TextRun({ text, font: FONT, size: 22, bold: true, color: '333333' })],
  });
}
function p(text, opts = {}) {
  const runs = [];
  if (typeof text === 'string') {
    runs.push(new TextRun({ text, font: FONT, size: 21, ...opts }));
  } else {
    text.forEach(t => runs.push(new TextRun({ font: FONT, size: 21, ...t })));
  }
  return new Paragraph({ spacing: { after: 100 }, children: runs });
}
function bullet(text, level = 0) {
  const runs = typeof text === 'string'
    ? [new TextRun({ text, font: FONT, size: 21 })]
    : text.map(t => new TextRun({ font: FONT, size: 21, ...t }));
  return new Paragraph({ bullet: { level }, spacing: { after: 60 }, children: runs });
}
function code(text) {
  return new Paragraph({
    spacing: { after: 80 },
    shading: { type: ShadingType.CLEAR, fill: 'F5F5F5' },
    children: [new TextRun({ text, font: 'Consolas', size: 18 })],
  });
}
function pageBreak() {
  return new Paragraph({ children: [new PageBreak()] });
}

const noBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const thinBorder = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
const tableBorders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };

function tableHeader(...cells) {
  return new TableRow({
    tableHeader: true,
    children: cells.map(text => new TableCell({
      shading: { type: ShadingType.CLEAR, fill: ACCENT },
      borders: tableBorders,
      children: [new Paragraph({
        children: [new TextRun({ text, font: FONT, size: 20, bold: true, color: 'FFFFFF' })],
      })],
    })),
  });
}
function tableRow(...cells) {
  return new TableRow({
    children: cells.map(text => new TableCell({
      borders: tableBorders,
      children: [new Paragraph({
        children: [new TextRun({ text, font: FONT, size: 20 })],
      })],
    })),
  });
}
function table(headers, rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      tableHeader(...headers),
      ...rows.map(r => tableRow(...r)),
    ],
  });
}

// ============================================================
// CONTENT — ALL facts verified from source code 2026-04-28
// ============================================================

const sections = [];

// --- COVER ---
sections.push(
  new Paragraph({ spacing: { before: 2000 }, children: [] }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 200 },
    children: [new TextRun({ text: '9BizClaw', font: FONT, size: 56, bold: true, color: ACCENT })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 100 },
    children: [new TextRun({ text: 'Technical Overview', font: FONT, size: 36, color: '666666' })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 400 },
    children: [new TextRun({ text: 'Tài liệu kỹ thuật tổng hợp hệ thống', font: FONT, size: 24, color: '999999', italics: true })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: `Version 2.4.0  |  Cập nhật: ${new Date().toISOString().slice(0,10)}`, font: FONT, size: 20, color: '999999' })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 200 },
    children: [new TextRun({ text: 'MODORO Tech Corp  |  Nội bộ — Không phát hành công khai', font: FONT, size: 20, color: '999999' })],
  }),
  pageBreak(),
);

// --- 1. TỔNG QUAN ---
sections.push(
  h1('1. Tổng quan'),
  p('9BizClaw là ứng dụng desktop (Electron) hỗ trợ CEO quản lý kinh doanh qua AI. App tự động trả lời khách hàng trên Zalo + Telegram bằng ChatGPT, với cơ chế giám sát và cảnh báo cho CEO theo thời gian thực.'),
  h2('Tech Stack'),
  bullet([{ text: 'Electron 28 ', bold: true }, { text: '— desktop shell, BrowserWindow + webview' }]),
  bullet([{ text: 'Node.js 22 ', bold: true }, { text: '— bundled trong vendor/, zero dependency' }]),
  bullet([{ text: 'openclaw ', bold: true }, { text: '— AI agent gateway (port 18789)' }]),
  bullet([{ text: '9router ', bold: true }, { text: '— OpenAI-compatible proxy, dùng ChatGPT Plus subscription làm API (port 20128)' }]),
  bullet([{ text: 'openzca ', bold: true }, { text: '— Zalo listener, duy trì session qua QR login' }]),
  bullet([{ text: 'modoro-zalo ', bold: true }, { text: '— fork của @tuyenhx/openzalo, 21 patch baked in' }]),
  h2('Message Flow'),
  code('Khách gửi tin Zalo/Telegram'),
  code('  → openzca / Telegram bot intercept'),
  code('  → openclaw gateway (port 18789)'),
  code('  → 9router (port 20128)'),
  code('  → ChatGPT (qua ChatGPT Plus subscription)'),
  code('  → response quay lại cùng đường'),
  code('  → auto-reply trên Zalo/Telegram'),
  code('  → nếu phát hiện escalation → CEO nhận alert Telegram trong 30s'),
  pageBreak(),
);

// --- 2. CẤU TRÚC FILE ---
sections.push(
  h1('2. Cấu trúc file'),
  h2('electron/lib/ — 25 modules'),
  table(['File', 'Chức năng'], [
    ['config.js', 'ensureDefaultConfig, schema healer, writeOpenClawConfigIfChanged, migration'],
    ['boot.js', 'Vendor extraction, findNodeBin (12 fallback tiers), spawnOpenClawSafe, splash'],
    ['gateway.js', 'Start/stop gateway, fast watchdog, isGatewayAlive, kill helpers'],
    ['channels.js', 'Probes Telegram/Zalo, output filter (48 patterns), pause, sendCeoAlert, sendZalo'],
    ['cron.js', 'Cron scheduler, runCronAgentPrompt (3 retries), self-test, watchCustomCrons'],
    ['cron-api.js', 'Local HTTP Cron API (port 20200), CRUD cron jobs, rotating auth token'],
    ['dashboard-ipc.js', 'Tất cả IPC handlers cho Dashboard UI'],
    ['nine-router.js', '9Router lifecycle, password pin, better-sqlite3 auto-fix'],
    ['zalo-plugin.js', 'Plugin install, migration openzalo → modoro-zalo, seedZaloCustomersFromCache'],
    ['workspace.js', 'getWorkspace, seedWorkspace, auditLog, enforceRetentionPolicies'],
    ['knowledge.js', 'Knowledge tab: SQLite DB, 3 categories, RAG search server (port 20129)'],
    ['conversation.js', 'Memory journal, per-customer summaries, trimZaloMemoryFile (50KB cap)'],
    ['follow-up.js', 'Follow-up queue, lock mechanism (15 phút deadlock timeout)'],
    ['escalation.js', 'Escalation queue poller, đọc escalation-queue.jsonl → sendCeoAlert'],
    ['context.js', 'Shared mutable state singleton (mainWindow, flags, counters)'],
    ['vendor-patches.js', 'Tất cả vendor source-code patches (runtime + build-time)'],
    ['zalo-memory.js', 'Per-customer memory files (zalo-users/*.md), cache refresh'],
    ['persona.js', 'Persona compilation (đọc IDENTITY.md → persona mix)'],
    ['util.js', 'isPathSafe, writeJsonAtomic, sanitizeZaloText, stripTelegramMarkdown'],
    ['updates.js', 'Auto-update checker (GitHub releases)'],
    ['license.js', 'Offline Ed25519 license system, machine binding, revocation check'],
    ['embedder.js', 'Shared embedder module cho knowledge RAG'],
    ['fb-publisher.js', 'Facebook Graph API page posting'],
    ['image-gen.js', 'gpt-image-2 qua 9router — async job manager'],
    ['appointments.js', 'Appointment dispatcher'],
  ]),
  h2('electron/ui/ — 5 trang'),
  table(['File', 'Chức năng'], [
    ['dashboard.html', 'Dashboard chính — Overview, Telegram, Zalo, Knowledge, Cron, Settings'],
    ['wizard.html', 'Wizard cài đặt lần đầu (4 bước)'],
    ['license.html', 'Trang kích hoạt license (membership builds)'],
    ['splash.html', 'Splash screen giải nén vendor (Windows first-launch)'],
    ['no-openclaw.html', 'Trang lỗi khi không tìm thấy openclaw binary'],
  ]),
  h2('electron/scripts/ — 22 scripts'),
  p('Bao gồm: smoke-test.js (45 sections), 8 auxiliary smoke tests, prebuild-vendor.js, fix-better-sqlite3.js, generate-license.js, license-manager.js, fix-artifact-name.js, và các RAG benchmark scripts.'),
  h2('electron/packages/modoro-zalo/'),
  p('Fork của @tuyenhx/openzalo. Tự quản lý, không sync upstream. 21 patch markers trong inbound.ts, 9 escalation patterns trong send.ts. Được copy vào ~/.openclaw/extensions/modoro-zalo/ mỗi lần boot.'),
  pageBreak(),
);

// --- 3. BOOT SEQUENCE ---
sections.push(
  h1('3. Boot Sequence'),
  h2('Trước app.whenReady() (đồng bộ)'),
  bullet([{ text: 'app.disableHardwareAcceleration() ', bold: true }, { text: '— tắt GPU, tránh crash trên máy có GPU driver cũ' }]),
  bullet([{ text: 'requestSingleInstanceLock() ', bold: true }, { text: '— chỉ cho phép 1 instance chạy. Nếu lock fail → ghi singleton-blocked.log, quit' }]),
  bullet([{ text: 'initFileLogger() ', bold: true }, { text: '— log ra <userData>/9bizclaw/logs/main.log với rotation' }]),
  bullet([{ text: 'require() 25 modules ', bold: true }, { text: '— load tất cả lib/*.js' }]),
  bullet([{ text: 'Cross-module wiring ', bold: true }, { text: '— 11 setter calls nối các module lại với nhau' }]),
  bullet([{ text: 'registerAllIpcHandlers() ', bold: true }, { text: '— đăng ký tất cả IPC handlers cho renderer' }]),
  bullet([{ text: 'initPathAugmentation() ', bold: true }, { text: '— thêm vendor/node vào PATH' }]),

  h2('app.whenReady() (async)'),
  p('Thứ tự quan trọng — thay đổi sẽ gây race condition:'),
  bullet('1. Vendor extraction (Windows) — BLOCKING, hiện splash với progress bar'),
  bullet('2. initEmbedder() — khởi tạo RAG embedding model'),
  bullet('3. bootDiagRunFullCheck() — ghi boot-diagnostic.txt'),
  bullet('4. installEmbedHeaderStripper() — strip X-Frame-Options cho webview'),
  bullet('5. createWindow() — tạo BrowserWindow chính'),
  bullet('6. createTray() — tạo system tray icon'),
  bullet('7. License check (15s delay, chỉ membership builds)'),
  bullet('8. powerSaveBlocker.start("prevent-app-suspension") — chống Mac App Nap'),
  bullet('9. Power monitor listeners (resume/suspend)'),
  bullet('10. ensureZaloPlugin() — fire-and-forget'),
  bullet('11. Knowledge folders + index rewrite + backfill'),
  bullet('12. enforceRetentionPolicies() + 6h interval'),
  bullet('13. startChannelStatusBroadcast()'),
  bullet('14. startKnowledgeSearchServer() — port 20129'),
  bullet('15. startFastWatchdog() — 30s delay, sau đó 20s interval'),

  h2('Bên trong createWindow() — conditional paths'),
  bullet([{ text: 'Membership + invalid license: ', bold: true }, { text: 'load license.html, return' }]),
  bullet([{ text: 'Không có openclaw: ', bold: true }, { text: 'load no-openclaw.html' }]),
  bullet([{ text: 'Đã config xong: ', bold: true }, { text: 'load dashboard.html, chạy startup chain:' }]),
  bullet('seedWorkspace() → ensureZaloPlugin() → seedZaloCustomersFromCache()', 1),
  bullet('startOpenClaw() (gồm ensureDefaultConfig + gateway spawn)', 1),
  bullet('startCronJobs() → startFollowUpChecker() → startEscalationChecker()', 1),
  bullet('startCronApi() → watchCustomCrons() → startZaloCacheAutoRefresh()', 1),
  bullet('startAppointmentDispatcher() → checkZaloCookieAge() (30s delay)', 1),
  bullet([{ text: 'Chưa config: ', bold: true }, { text: 'load wizard.html' }]),
  pageBreak(),
);

// --- 4. CONFIG SYSTEM ---
sections.push(
  h1('4. Config System'),
  p('File config: ~/.openclaw/openclaw.json — được đọc/ghi bởi nhiều process (Electron, gateway, CLI). Config system đảm bảo consistency và tự sửa lỗi.'),

  h2('ensureDefaultConfig()'),
  p('Chạy mỗi lần startOpenClaw(). Tự động thêm/sửa các field mặc định, migration, và strip invalid keys.'),
  bullet([{ text: 'REQUIRED_TOOLS: ', bold: true }, { text: "['message', 'web_search', 'web_fetch', 'update_plan']" }]),
  bullet([{ text: 'BANNED_TOOLS: ', bold: true }, { text: "['exec', 'process', 'cron'] — bị filter khỏi tools.allow" }]),
  bullet([{ text: 'KNOWN_BAD_ZALO_KEYS: ', bold: true }, { text: "['streaming', 'streamMode', 'nativeStreaming', 'blockStreamingDefault'] — tự động strip" }]),
  bullet([{ text: 'Migration openzalo -> modoro-zalo: ', bold: true }, { text: 'deep-copy channels.openzalo -> channels["modoro-zalo"], delete openzalo, update plugins.entries và plugins.allow' }]),
  bullet([{ text: 'MODORO_ZALO_VALID_FIELDS whitelist: ', bold: true }, { text: '17 fields hợp lệ — bất kỳ key nào không nằm trong list bị strip' }]),

  h2('Schema Healer'),
  p([
    { text: 'parseUnrecognizedKeyErrors(stderr) ', bold: true },
    { text: 'parse lỗi "Unrecognized key" từ openclaw stderr. ' },
    { text: 'healOpenClawConfigInline(errStderr) ', bold: true },
    { text: 'walk dotted path và delete key động. Tự động retry — future openclaw schema breaks SELF-HEAL on first failure.' },
  ]),

  h2('writeOpenClawConfigIfChanged()'),
  p('Mọi write openclaw.json PHẢI qua helper này. Quy trình:'),
  bullet('1. sanitizeOpenClawConfigInPlace(config) — strip known bad keys'),
  bullet('2. Serialize với 2-space indent + trailing newline'),
  bullet('3. Đọc file hiện tại, so sánh bytes'),
  bullet('4. NẾU GIỐNG NHAU — SKIP write (tránh gateway restart)'),
  bullet('5. Nếu khác — writeFileSync + audit log'),
  p([{ text: 'Tại sao quan trọng: ', bold: true }, { text: 'Bất kỳ write nào thay đổi inode của openclaw.json sẽ trigger gateway configReloader -> restart gateway -> "Gateway is restarting" message gửi cho khách. Helper này ngăn việc đó.' }]),
  pageBreak(),
);

// --- 5. GATEWAY ---
sections.push(
  h1('5. Gateway'),
  p('openclaw gateway là AI agent server chạy trên port 18789. Quản lý bởi gateway.js.'),

  h2('Lifecycle'),
  bullet([{ text: 'startOpenClaw(opts) ', bold: true }, { text: '— async, re-entrant guard qua ctx.startOpenClawInFlight. Gọi ensureDefaultConfig -> spawn "node openclaw.mjs gateway run" -> wait WebSocket ready (max 240s)' }]),
  bullet([{ text: 'stopOpenClaw() ', bold: true }, { text: '— SIGINT (Unix) / taskkill (Windows) -> race 5s deadline -> killPort(18789)' }]),

  h2('Fast Watchdog'),
  table(['Thông số', 'Giá trị', 'Ý nghĩa'], [
    ['FW_INTERVAL_MS', '20,000ms (20s)', 'Khoảng cách giữa các lần check'],
    ['Boot grace period', '360,000ms (6 phút)', 'Skip watchdog trong 6 phút đầu (cho slow boot)'],
    ['Consecutive fail threshold', '5 lần', 'Phải fail 5 lần liên tiếp mới restart'],
    ['FW_RECHECK_MS', '3,000ms (3s)', 'Sau fail lần 1, recheck sau 3s trước khi đếm'],
    ['FW_MAX_RESTARTS_PER_HOUR', '5', 'Tối đa 5 lần restart/giờ (chống loop)'],
    ['Initial delay', '30,000ms (30s)', 'Cho gateway boot xong mới bắt đầu watchdog'],
  ]),

  h2('isGatewayAlive()'),
  p('HTTP GET đến http://127.0.0.1:18789/. Bất kỳ response 2xx/3xx/4xx = alive. Default timeout 15s (trước đây 2s -> false positive khi model đang xử lý).'),

  h2('Boot Ping Throttle'),
  p('READY_NOTIFY_THROTTLE_MS = 30 phút. Persist timestamp qua .boot-ping-ts.json. CEO không bị spam "đã sẵn sàng" khi restart nhiều lần.'),
  pageBreak(),
);

// --- 6. CHANNELS ---
sections.push(
  h1('6. Channels (Telegram + Zalo)'),

  h2('Channel Probes'),
  bullet([{ text: 'Telegram: ', bold: true }, { text: 'gọi api.telegram.org/bot<token>/getMe — 200 + ok=true là proof token hợp lệ' }]),
  bullet([{ text: 'Zalo: ', bold: true }, { text: '3-layer: (1) tìm process openzca listen (wmic/pgrep), (2) check listener-owner.json pid, (3) profile mtime < 30 phút' }]),
  p('Channel status broadcast: boot fast polling [500ms, 3s, 6s, 10s, 15s, 20s, 25s, 30s] rồi rơi về 45s steady-state.'),

  h2('Output Filter — 48 patterns'),
  p('filterSensitiveOutput(text) apply cho CẢ HAI kênh (sendTelegram + sendZalo). 8 layer:'),
  table(['Layer', 'Số patterns', 'Ví dụ'], [
    ['A: File paths + secrets', '12', 'API key, bearer token, file paths'],
    ['A1.4: API error leakage', '6', '"overloaded", "rate limit", "internal error"'],
    ['A1.5: Bot silent tokens', '1', 'Silent token markers'],
    ['A1.7: PII masking', '3', 'CCCD/CMND, bank account, credit card'],
    ['A2: Compaction', '2', 'Compaction notice, compaction emoji'],
    ['B: English CoT', '5', 'Chain-of-thought leak (reasoning verbs, narration)'],
    ['C: Meta-commentary', '5', 'Tool names, memory claims, file operations'],
    ['D-H: Brand, injection, PII, fake commerce', '14', 'Brand names, jailbreak, fake orders'],
  ]),
  p('Audit log: mỗi lần filter block -> ghi vào logs/security-output-filter.jsonl.'),

  h2('Pause — Fail-Closed Design'),
  p([
    { text: 'isChannelPaused() ', bold: true },
    { text: 'đọc {channel}-paused.json. Nếu JSON.parse fail (file corrupt) -> return TRUE (paused). Nguyên tắc: thà bot im lặng nhầm còn hơn gửi tin khi CEO muốn dừng.' },
  ]),

  h2('sendCeoAlert()'),
  p('Gửi alert qua Telegram. Nếu Telegram fail -> ghi vào logs/ceo-alerts-missed.log với timestamp + nội dung (cắt 500 ký tự). Nếu cả disk write fail -> log console.'),

  h2('sendZalo() — Long Message Split'),
  p('Max chunk: 2000 ký tự. Split tại paragraph (\\n\\n) -> sentence (.!?) -> word (space). Min cut position 200 chars. Gap 800ms giữa các chunk (rate limit).'),
  pageBreak(),
);

// --- 7. ZALO PLUGIN ---
sections.push(
  h1('7. Zalo Plugin (modoro-zalo fork)'),

  h2('Tại sao fork?'),
  p('Trước: @tuyenhx/openzalo npm package + 17 runtime patches inject mỗi boot. Fragile: upstream update bất kỳ sẽ break patch anchors. Sau: self-owned package tại electron/packages/modoro-zalo/. Tất cả patches baked in. Không sync upstream.'),

  h2('21 Defense Layers trong inbound.ts'),
  p('Thứ tự trong file = thứ tự xử lý. Message đi qua từng layer, bị drop nếu vi phạm bất kỳ layer nào:'),
  table(['#', 'Layer', 'Chức năng'], [
    ['1', 'GS-HELPER', 'Group settings helper'],
    ['2', 'OWNER-TAKEOVER', 'Nhận diện CEO (owner) trong conversation'],
    ['3', 'SKILL-NEUTRALIZE', 'Vô hiệu hóa skill markers từ input khách'],
    ['4', 'FB-NEUTRALIZE', 'Vô hiệu hóa Facebook markers'],
    ['5', 'GCAL-NEUTRALIZE', 'Vô hiệu hóa Google Calendar markers'],
    ['6', 'BLOCKLIST v3', 'Block sender theo zalo-blocklist.json'],
    ['7', 'SYSTEM-MSG', 'Filter system events ("X đã thêm Y vào nhóm")'],
    ['8', 'SENDER-DEDUP', 'Chống double-delivery (3s window)'],
    ['9', 'COMMAND-BLOCK v2', 'Rewrite admin commands thành "[nội dung nội bộ đã được lọc]"'],
    ['10', 'MEDIA-TYPE-FILTER', 'Lọc media type không hỗ trợ'],
    ['11', 'RATE-LIMIT v2', 'Rate limiting per-sender'],
    ['12', 'MSG-LENGTH-GATE', 'Cắt message quá dài'],
    ['13', 'BOT-LOOP-BREAKER', 'Phát hiện bot-vs-bot loop, dừng reply'],
    ['14', 'OUT-OF-SCOPE FILTER', 'Lọc nội dung ngoài phạm vi'],
    ['15', 'GROUP-SETTINGS v7', 'Quản lý settings nhóm Zalo'],
    ['16', 'RAG v9', 'Knowledge retrieval (tìm tài liệu liên quan)'],
    ['17', 'FRIEND-CHECK v5', 'Kiểm tra quan hệ bạn bè'],
    ['18', 'PAUSE', 'Channel pause enforcement'],
    ['19', 'ZALO-MODE', 'Xử lý Zalo mode'],
    ['20', 'DELIVER-COALESCE v4', 'Gom nhiều token thành 1 message (chống split)'],
    ['21', 'FORCE-ONE-MESSAGE', 'Tắt streaming, đảm bảo 1 reply/message'],
  ]),

  h2('Escalation Scanner trong send.ts'),
  p('9 regex patterns quét mỗi outbound message. Nếu match -> ghi vào escalation-queue.jsonl -> CEO nhận alert trong 30s.'),
  p('Patterns chính: "chuyển cho sếp", "báo sếp", "hỏi sếp", "nhờ sếp", "ngoài khả năng", "sếp sẽ xử lý", "em đã chuyển sếp"...'),

  h2('Plugin Install Flow'),
  p('_ensureZaloPluginImpl() copy từ packages/modoro-zalo/ (dev) hoặc vendor/node_modules/modoro-zalo/ (packaged) -> ~/.openclaw/extensions/modoro-zalo/. Cleanup old extensions/openzalo/. In-flight promise pattern chống race condition.'),
  pageBreak(),
);

// --- 8. CRON SYSTEM ---
sections.push(
  h1('8. Cron System'),

  h2('findNodeBin() — 12 Fallback Tiers'),
  p('Resolve đường dẫn tuyệt đối của node binary. Không bao giờ dùng "node" tương đối (Mac Finder launch không có PATH).'),
  table(['Tier', 'Source'], [
    ['1', 'Bundled vendor Node (packaged app)'],
    ['2', 'PATH lookup (where/command -v)'],
    ['3', 'nvm (~/.nvm/versions/node/)'],
    ['4', 'volta ($VOLTA_HOME/bin)'],
    ['5', 'asdf (~/.asdf/shims, Unix)'],
    ['6', 'fnm (AppData/Local/fnm_multishells/)'],
    ['7', 'nodenv (~/.nodenv/shims, Unix)'],
    ['8', 'n/tj (~N_PREFIX/bin, Unix)'],
    ['9', 'mise/rtx (~/.local/share/mise/shims, Unix)'],
    ['10', 'devbox/nix (/nix/var/nix/profiles/default/bin, Unix)'],
    ['11', 'Homebrew + system (/opt/homebrew/bin, /usr/local/bin, C:\\Program Files\\nodejs)'],
    ['12', 'User-local (~/.local/bin, ~/.npm-global/bin)'],
  ]),

  h2('spawnOpenClawSafe()'),
  p('Preferred: spawn qua "node openclaw.mjs <args>" với shell:false (multi-line safe). Fallback: openclaw.cmd với shell:true (UNSAFE — chỉ khi allowCmdShellFallback=true). runCronAgentPrompt set allowCmdShellFallback=false khi prompt có newline.'),

  h2('Self-Test + CEO Alert'),
  p('selfTestOpenClawAgent() chạy 1 lần mỗi process: spawn "openclaw --version", parse kết quả. Nếu fail -> sendCeoAlert() gửi cảnh báo cho CEO trên Telegram. Non-blocking — cron vẫn start.'),

  h2('runCronAgentPrompt() — 3 Attempts'),
  p('Retry với exponential backoff. Fatal errors (signal kill, OOM) break ngay. Config-invalid errors trigger healOpenClawConfigInline() và retry.'),

  h2('Cron API (port 20200)'),
  bullet([{ text: 'Auth: ', bold: true }, { text: 'crypto.randomBytes(24) = 48 hex chars, rotated mỗi boot, lưu cron-api-token.txt' }]),
  bullet([{ text: 'Bind: ', bold: true }, { text: '127.0.0.1 only (localhost)' }]),
  bullet([{ text: 'Endpoints: ', bold: true }, { text: '/api/cron/create, /list, /delete, /toggle' }]),
  bullet([{ text: 'Port fallback: ', bold: true }, { text: 'Bắt đầu 20200, retry 3 lần (tăng port) nếu EADDRINUSE' }]),
  pageBreak(),
);

// --- 9. SECURITY ---
sections.push(
  h1('9. Security'),

  h2('BrowserWindow — Sandbox'),
  table(['Setting', 'Giá trị', 'Ý nghĩa'], [
    ['contextIsolation', 'true', 'Renderer không truy cập được Node.js APIs'],
    ['nodeIntegration', 'false', 'Không cho phép require() trong renderer'],
    ['sandbox', 'true', 'Process isolation cấp OS'],
    ['webviewTag', 'true', 'Cho phép <webview> (cần cho embed 9Router/OpenClaw)'],
  ]),
  p('Preload: contextBridge.exposeInMainWorld("claw", {...}) — chỉ expose IPC bridges, không expose raw ipcRenderer.'),

  h2('tools.allow Hardening'),
  p([
    { text: 'Chỉ 4 tools được phép: ', bold: true },
    { text: 'message, web_search, web_fetch, update_plan. ' },
    { text: '3 tools bị cấm: ', bold: true },
    { text: 'exec (RCE), process (spawn), cron (schedule abuse). Áp dụng cho TẤT CẢ channels.' },
  ]),

  h2('Command-Block Patch'),
  p('inbound.ts rewrite rawBody cho 8+ admin command patterns TRƯỚC KHI AI thấy. Agent không bao giờ nhận được lệnh gốc. Zalo-only (Telegram có plugin riêng).'),

  h2('Output Filter'),
  p('48 regex patterns block: file paths, API keys, PII (CCCD, bank account, credit card), English CoT leaks, brand names, jailbreak attempts, fake commerce (đơn hàng giả). Apply cả 2 kênh.'),

  h2('License System'),
  bullet('Offline Ed25519 signature verification — không cần server'),
  bullet('Machine binding: HMAC seal trên hostname + MAC + platform'),
  bullet('Revocation: best-effort check GitHub Gist (non-blocking)'),
  bullet('Key format: CLAW-{base64url(payload + 64-byte Ed25519 signature)}'),
  pageBreak(),
);

// --- 10. KNOWLEDGE ---
sections.push(
  h1('10. Knowledge System'),

  h2('3 Categories'),
  table(['ID', 'Nhãn'], [
    ['cong-ty', 'Công ty — tài liệu về công ty'],
    ['san-pham', 'Sản phẩm — thông tin sản phẩm/dịch vụ'],
    ['nhan-vien', 'Nhân viên — thông tin nhân sự'],
  ]),

  h2('Storage'),
  bullet([{ text: 'SQLite: ', bold: true }, { text: 'memory.db tại workspace, column category. Idempotent ALTER TABLE.' }]),
  bullet([{ text: 'Filesystem fallback: ', bold: true }, { text: 'Khi DB fail, đọc thẳng từ knowledge/<cat>/files/. CEO luôn thấy file thật trên disk.' }]),
  bullet([{ text: 'Backfill: ', bold: true }, { text: 'backfillKnowledgeFromDisk() chạy lúc boot — scan disk, INSERT files chưa có vào DB.' }]),

  h2('RAG Search'),
  p('Knowledge search HTTP server port 20129 (127.0.0.1 only). Hỗ trợ FTS5 full-text search + E5 semantic embedding (ONNX). Gateway query endpoint này để tìm tài liệu liên quan trước khi trả lời khách.'),

  h2('better-sqlite3 ABI Auto-Fix'),
  p('Nếu better-sqlite3 native binary compile cho Node version khác Electron -> throw NODE_MODULE_VERSION mismatch. autoFixBetterSqlite3() sync exec fix-better-sqlite3.js, clear require cache, retry. Chỉ chạy 1 lần.'),
  pageBreak(),
);

// --- 11. WORKSPACE & DATA ---
sections.push(
  h1('11. Workspace & Data'),

  h2('seedWorkspace()'),
  p('Chạy mỗi boot. Copy workspace templates (AGENTS.md, IDENTITY.md, schedules.json...) vào workspace khi missing. Tạo memory/zalo-users/ + memory/zalo-groups/ + knowledge/<cat>/files/.'),

  h2('Memory Files — 50KB Cap'),
  p('trimZaloMemoryFile() chạy sau mỗi lần append. Drop oldest ## YYYY-MM-DD sections từ trên xuống cho đến khi file <= 50KB. Giữ nguyên YAML front-matter header. Dùng Buffer.byteLength cho chính xác.'),

  h2('Retention Policies — 6 Targets'),
  p('enforceRetentionPolicies() chạy lúc boot + mỗi 6 giờ:'),
  table(['Target', 'Rule'], [
    ['Log rotation (9 files)', 'Rotate khi vượt maxBytes: main.log 20MB, audit.jsonl 50MB, cron-runs.jsonl 10MB...'],
    ['Old .log.N files', 'Xóa nếu mtime > 7 ngày'],
    ['Memory journal', 'Archive vào memory/archive/ nếu mtime > 90 ngày'],
    ['Config backups', 'Xóa openclaw.json.bak* nếu mtime > 30 ngày'],
    ['Agent sessions', 'Xóa ~/.openclaw/agents/main/sessions/*.jsonl nếu mtime > 7 ngày'],
    ['SQLite WAL', 'PRAGMA wal_checkpoint(TRUNCATE) — giảm dung lượng DB'],
  ]),

  h2('Follow-Up Queue'),
  bullet([{ text: 'Lock: ', bold: true }, { text: '_followUpQueueLock boolean + timestamp. Deadlock auto-release sau 15 phút.' }]),
  bullet([{ text: 'Check interval: ', bold: true }, { text: '60 giây' }]),
  bullet([{ text: 'Purge: ', bold: true }, { text: 'Entries > 24 giờ bị xóa' }]),
  bullet([{ text: 'Per-item persistence: ', bold: true }, { text: 'Ghi lại sau mỗi item xử lý — survive crash giữa loop' }]),
  pageBreak(),
);

// --- 12. BUILD & DISTRIBUTION ---
sections.push(
  h1('12. Build & Distribution'),

  h2('App Metadata'),
  table(['Field', 'Giá trị'], [
    ['name', '9bizclaw'],
    ['version', '2.4.0'],
    ['productName', '9BizClaw'],
    ['appId', 'vn.9biz.claw'],
  ]),

  h2('Zero-Dependency Install'),
  p('App bundle Node.js 22 + tất cả npm packages trong vendor/. User download 1 file EXE, cài đặt, chạy. Không cần Node.js, npm, hay bất kỳ dependency nào.'),

  h2('Windows: Vendor Tar Extraction'),
  p('NSIS installer ship vendor-bundle.tar (~1.6 GB) thay vì 126,644 file nhỏ. First launch: SHA256 verify -> tar -xvf với progress bar (splash.html) -> ghi version stamp. Subsequent launches: skip. EXE ~370MB.'),

  h2('Mac: Signed + Notarized'),
  p('DMG ship vendor/ directory trực tiếp (APFS drag-drop nhanh). Developer ID: MODORO Tech Corp, Team ID: UQKLW82B3A. Apple Notarized.'),

  h2('Windows: Chưa Ký'),
  p('EXE chưa có code signing certificate. Đây là lý do chính antivirus báo nhầm. Lộ trình: mua EV cert (~$240-500/năm).'),

  h2('Smoke Test Suite'),
  p('Chạy trước mỗi build (npm run smoke). Block build nếu fail.'),
  bullet([{ text: 'smoke-test.js: ', bold: true }, { text: '45 test sections — vendor versions, patch anchors, IPC parity, security, boot order...' }]),
  bullet([{ text: '8 auxiliary smoke files: ', bold: true }, { text: 'context-injection, RAG benchmarks, zalo-followup, visibility' }]),
  bullet([{ text: 'npm smoke chain: ', bold: true }, { text: 'smoke-test + smoke-context-injection + smoke-zalo-followup + smoke-visibility' }]),
  pageBreak(),
);

// --- 13. KNOWN ISSUES & PATCHES ---
sections.push(
  h1('13. Known Issues & Lộ Trình'),

  h2('Chưa Giải Quyết'),
  bullet([{ text: 'EV Code Signing Certificate (Windows): ', bold: true }, { text: 'Chưa mua. Antivirus vẫn báo nhầm. Ưu tiên cao.' }]),
  bullet([{ text: 'AGENTS.md size: ', bold: true }, { text: 'Hiện 14,329 bytes (150 dòng). Giới hạn openclaw ~20K chars. Còn room nhưng cần theo dõi khi thêm rules.' }]),

  h2('Patches Đang Active'),
  p('Tất cả patches đã baked vào source code (không còn runtime injection). Danh sách theo subsystem:'),

  h3('Config'),
  bullet('blockStreaming schema break — delete key cũ, openclaw 2026.4.x default đã là "off"'),
  bullet('CLI subprocess bypass — xóa 2 CLI calls trong ensureZaloPlugin, heal in-process'),
  bullet('writeOpenClawConfigIfChanged byte-equal guard — chống gateway restart'),

  h3('Gateway'),
  bullet('Restart loop fix — 5 consecutive fails, 5 restarts/hour cap, boot grace 6 phút'),
  bullet('Boot ping throttle — 30 phút, persist qua restart'),
  bullet('isGatewayAlive timeout — 15s (từ 2s)'),

  h3('Channels'),
  bullet('XFO stripper — 3 partitions (embed-openclaw, embed-9router, embed-gcal)'),
  bullet('Output filter — 48 patterns, apply cả 2 kênh'),
  bullet('Pause fail-closed — corrupt JSON = paused'),
  bullet('sendCeoAlert disk fallback — logs/ceo-alerts-missed.log'),
  bullet('sendZalo long message split — 2000 chars, paragraph/sentence/word boundaries'),

  h3('Zalo Plugin'),
  bullet('modoro-zalo fork — 21 patches baked in, không runtime injection'),
  bullet('DELIVER-COALESCE v4 — gom tokens, error logging cho group send'),
  bullet('Escalation scanner v2 — 9 patterns, mandatory keywords trong AGENTS.md'),
  bullet('Sender dedup — 3s window, Map pruned 500 entries/60s TTL'),
  bullet('Bot-loop-breaker — 6 detection signals'),

  h3('Cron'),
  bullet('Path B v3 — 6-layer reliability (findNodeBin, spawnOpenClawSafe, schema healer, chatId recovery, boot ordering, inline heal)'),
  bullet('Self-test CEO alert — sendCeoAlert khi CLI fail'),
  bullet('Custom cron handler — spawn agent thay vì gửi text'),

  h3('Boot'),
  bullet('Mac App Nap — powerSaveBlocker.start("prevent-app-suspension")'),
  bullet('Boot latency — 9Router trước patches, 60s wait loop, pre-warm OAuth ping'),
  bullet('Vendor tar extraction — Windows first-launch splash + progress bar'),
  bullet('better-sqlite3 ABI auto-fix — runtime + postinstall script'),

  h3('Security'),
  bullet('tools.allow hardened — 4 tools only, 3 banned'),
  bullet('Command-block patch — rewrite admin commands trong inbound.ts'),
  bullet('Cron API rotating token — 48 hex chars, localhost-only'),

  h3('Workspace'),
  bullet('MODORO_WORKSPACE env poisoning — explicit delete trước set'),
  bullet('ensureZaloPlugin race — in-flight promise pattern'),
  bullet('initFileLogger lowercase — "9bizclaw" không phải "9BizClaw"'),
  bullet('Zalo owner path — platform-aware resolution + MODORO_WORKSPACE env lookup'),
  pageBreak(),
);

// --- 14. VAN HANH NHANH ---
sections.push(
  h1('14. Vận Hành Nhanh'),

  h2('Restart Gateway'),
  p('Dashboard -> click nút Start/Stop. Hoặc: IPC "toggle-bot" -> stopOpenClaw() + startOpenClaw().'),

  h2('Đọc Log'),
  table(['Log', 'Đường dẫn', 'Nội dung'], [
    ['main.log', '<userData>/logs/main.log', 'Electron main process log (20MB rotation)'],
    ['audit.jsonl', '<workspace>/logs/audit.jsonl', 'Tất cả sự kiện hệ thống (50MB rotation)'],
    ['cron-runs.jsonl', '<workspace>/logs/cron-runs.jsonl', 'Mỗi lần cron chạy (10MB rotation)'],
    ['security-output-filter.jsonl', '<workspace>/logs/', 'Mỗi lần output filter block tin nhắn'],
    ['escalation-queue.jsonl', '<workspace>/logs/', 'Escalation entries chưa xử lý'],
    ['ceo-alerts-missed.log', '<workspace>/logs/', 'Alerts không gửi được cho CEO'],
    ['config-errors.log', '<workspace>/logs/', 'Lỗi khi đọc/ghi openclaw.json'],
    ['openclaw.log', '<workspace>/logs/', 'Gateway stdout/stderr (10MB rotation)'],
    ['openzca.log', '<workspace>/logs/', 'Zalo listener log (10MB rotation)'],
    ['9router.log', '<workspace>/logs/', 'AI router log (10MB rotation)'],
  ]),
  p([
    { text: 'Đường dẫn: ', bold: true },
    { text: '<userData> = %APPDATA%\\9bizclaw (Win) hoặc ~/Library/Application Support/9bizclaw (Mac). <workspace> = <userData> hoặc ~/.openclaw/workspace.' },
  ]),

  h2('Verify Component'),
  bullet([{ text: 'Gateway: ', bold: true }, { text: 'curl http://127.0.0.1:18789/ — bất kỳ response là alive' }]),
  bullet([{ text: '9Router: ', bold: true }, { text: 'curl http://127.0.0.1:20128/v1/models — 200 = OK' }]),
  bullet([{ text: 'Cron API: ', bold: true }, { text: 'curl http://127.0.0.1:20200/api/cron/list — cần auth token' }]),
  bullet([{ text: 'Knowledge: ', bold: true }, { text: 'curl http://127.0.0.1:20129/ — cần auth token' }]),
  bullet([{ text: 'Telegram: ', bold: true }, { text: 'Dashboard sidebar dot xanh, hoặc nút "Gửi tin test"' }]),
  bullet([{ text: 'Zalo: ', bold: true }, { text: 'Dashboard sidebar dot xanh = listener process đang chạy' }]),

  h2('Troubleshooting'),
  bullet([{ text: 'Bot không reply: ', bold: true }, { text: 'Check gateway alive (curl 18789) -> check 9router (curl 20128) -> đọc openclaw.log' }]),
  bullet([{ text: 'Cron không chạy: ', bold: true }, { text: 'Đọc cron-runs.jsonl -> check self-test OK -> check schedules.json' }]),
  bullet([{ text: 'Zalo không nhận tin: ', bold: true }, { text: 'Check openzca process (wmic/pgrep) -> check listener-owner.json -> đọc openzca.log' }]),
  bullet([{ text: 'Dashboard blank: ', bold: true }, { text: 'Check installEmbedHeaderStripper đã chạy -> check webview partition' }]),
  bullet([{ text: 'Antivirus báo nhầm: ', bold: true }, { text: 'Whitelist 2 folder: %LOCALAPPDATA%\\Programs\\9BizClaw\\ + %APPDATA%\\9bizclaw\\' }]),

  h2('Docs Chi Tiết'),
  bullet('docs/ceo-quick-guide.md — Hướng dẫn nhanh cho CEO'),
  bullet('docs/HUONG-DAN-SU-DUNG.md — Hướng dẫn sử dụng đầy đủ'),
  bullet('docs/HUONG-DAN-CAI-DAT.md — Hướng dẫn cài đặt'),
  bullet('docs/setup-checklist.md — Checklist setup'),
  bullet('docs/cron-reference.md — Tham chiếu cron'),
);

// ============================================================
// BUILD DOCUMENT
// ============================================================

const doc = new Document({
  creator: 'MODORO Tech Corp',
  title: '9BizClaw Technical Overview',
  description: 'Tài liệu kỹ thuật tổng hợp hệ thống 9BizClaw',
  styles: {
    default: {
      document: {
        run: { font: FONT, size: 21 },
        paragraph: { spacing: { after: 100 } },
      },
    },
  },
  sections: [{
    properties: {
      page: {
        margin: { top: 1200, right: 1200, bottom: 1200, left: 1200 },
      },
    },
    children: sections,
  }],
});

const outPath = path.resolve(__dirname, '..', '..', 'docs', '9BizClaw-Technical-Overview.docx');
Packer.toBuffer(doc).then(buffer => {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buffer);
  console.log(`Generated: ${outPath}`);
  console.log(`Size: ${(buffer.length / 1024).toFixed(0)} KB`);
}).catch(err => {
  console.error('Failed to generate .docx:', err);
  process.exit(1);
});
