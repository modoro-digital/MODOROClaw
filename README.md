# MODOROClaw

**Trợ lý AI 1-click cho CEO doanh nghiệp Việt Nam**

Ứng dụng desktop bundle sẵn mọi thứ — Telegram bot, Zalo bot (qua plugin OpenZalo), AI router (9Router), engine OpenClaw. CEO chỉ cần tải file cài, chạy wizard 4 bước, là có ngay 1 trợ lý 24/7 trên Telegram + Zalo. Không cần biết Node, Python, Docker, terminal.

Phiên bản hiện tại: **v2.2.9** · Hỗ trợ **Windows 10+** và **macOS 11+** (arm64 + Intel).

---

## Cài đặt — không cần cài gì khác

### Windows
1. Tải `MODOROClaw-Setup-2.2.9.exe` từ [Releases](https://github.com/modoro-digital/MODOROClaw/releases).
2. Double-click → installer chạy → app mở.
3. Wizard 4 bước → xong.

**EXE đã bundle sẵn**: Node.js 22, OpenClaw, 9Router, OpenZCA, OpenZalo plugin. Zero dependency, không cần Internet trừ lúc OAuth + chạy AI.

### macOS (arm64 — M1/M2/M3/M4 — hoặc x64 — Intel)
1. Tải `MODOROClaw-2.2.9-arm64.dmg` (Apple Silicon) hoặc `MODOROClaw-2.2.9-x64.dmg` (Intel) từ Releases.
2. Mở DMG → kéo MODOROClaw vào Applications.
3. Lần đầu mở: **System Settings → Privacy & Security** → cuộn xuống → click **"Open Anyway"** → Open. Sau lần này không bị nữa.
4. Wizard 4 bước → xong.

DMG cũng bundle Node + plugins. Không cần cài Homebrew/Node/Xcode.

### Reset hoàn toàn (mô phỏng máy mới)
- Windows: chạy `RESET.bat` (xóa `~/.openclaw`, `~/.openzca`, runtime files) rồi chạy lại app.
- Mac: xóa `~/Library/Application Support/modoro-claw` + `~/.openclaw` + `~/.openzca` rồi mở lại app.

---

## Wizard 4 bước

| Bước | Nội dung |
|------|----------|
| 1 | Tên CEO, công ty, ngành (8 ngành: F&B, BĐS, thương mại, dịch vụ, giáo dục, công nghệ, sản xuất, tổng quát), phong cách (chuyên nghiệp / thân thiện / ngắn gọn), xưng hô (em / tôi / mình) |
| 2 | Đăng nhập Ollama Cloud, lấy API key, tự setup 9Router |
| 3 | Tạo Telegram Bot (BotFather), nhập token + user ID, test kết nối |
| 4 | Quét QR Zalo, chọn tài khoản Zalo cá nhân của CEO (để bot nhận diện chủ), chọn chế độ trả lời (auto / read / daily) |

Sau wizard: dashboard mở, bot bắt đầu nhận tin nhắn ngay.

---

## Dashboard — 7 tab

### Tổng quan (redesigned v2.2.9)
4 section thật sự helpful:
- **Greeting** — Chào sáng/trưa/tối anh [tên]. Hôm nay [thứ], [ngày]. Bot đã ghi nhận N sự kiện hôm nay. Pill xanh/đỏ "Đang chạy / Đã dừng".
- **Hoạt động gần đây** — last 8 sự kiện từ audit log mapped sang tiếng Việt: Khởi động bot, Bot sẵn sàng, Cron đã chạy, Bộ lọc chặn 1 tin Zalo, Mac thức dậy...
- **Sắp tới** — next 6 cron firings tính từ schedules.json + custom-crons.json
- **Cần anh để ý** — alerts với severity (HIGH/MED/LOW) + CTA 1-click: bot đang dừng → Khởi động; cookie Zalo > 14 ngày → Quét QR mới; tin bị filter chặn → Xem log; khách Zalo mới → Mở Zalo

### Lịch tự động
- Built-in cron: báo cáo sáng 07:30, tóm tắt cuối ngày 21:00, heartbeat 30 phút (auto-restart gateway nếu chết), meditation 01:00 (self-improvement queue)
- Custom cron: bot ghi khi CEO yêu cầu, vĩnh viễn, không hết hạn
- Test 1-click cho mỗi cron

### Telegram
- Hướng dẫn nhanh, kiểm tra kết nối thật (gọi getMe), nút "Gửi tin test" để chứng minh end-to-end
- 12 slash commands: /menu, /baocao, /huongdan, /skill, /thuvien, /new, /reset, /status, /stop, /usage, /help, /restart

### Zalo
- 3 columns: cài đặt | nhóm | bạn bè
- Chọn chủ Zalo (bot tự nhận diện CEO khi DM tới — chi tiết bên dưới)
- Whitelist nhóm (tick checkbox nhóm nào bot được trả lời)
- Blocklist user (tick user nào bot KHÔNG trả lời)
- Sync cache từ Zalo (gọi `openzca auth cache-refresh`)
- 3 chế độ: auto (tự reply + escalate phức tạp qua Telegram) / read (chỉ đọc, báo Telegram) / daily (tóm tắt cuối ngày qua Telegram)

### Knowledge
3 folder cố định: cong-ty (hợp đồng/SOP), san-pham (catalog/giá), nhan-vien (danh sách/ca làm). Upload PDF/Word/Excel/CSV/TXT/ảnh. Bot AI tự tóm tắt mỗi file 1-2 câu vào `index.md` của folder. Backend SQLite FTS5 cho full-text search.

### 9Router
Embed inline tab quản lý 9Router (login mật khẩu mặc định `123456`, JWT cookie persist).

### OpenClaw
Embed inline tab gateway OpenClaw để debug session, xem log conversation real-time.

---

## Bot tự nhận diện chủ Zalo (ZALO_CHU_NHAN — v2.2.4+)

CEO thường có 2 Zalo: 1 cho bot (đăng nhập qua wizard) + 1 cá nhân. Khi CEO nhắn từ Zalo cá nhân tới bot, bot tự động:
1. Nhận diện qua `senderId` (đối chiếu `zalo-owner.json` đã đặt ở wizard step 4)
2. Inject `[ZALO_CHU_NHAN tên="..."]` marker vào message body
3. AGENTS.md instruct bot: switch sang **CEO mode** — dùng ceo_title, accept lệnh quản trị `/reset`, `/status`, nghe info nội bộ (doanh thu, KPI, lương), skip customer flow

→ CEO có thể "ra lệnh" bot từ Zalo cá nhân thay vì phải mở Telegram.

---

## 5-layer security (v2.2.5+)

| Layer | Mục đích | Status |
|---|---|---|
| **0 — AGENTS.md prompt rules** | Bot luôn đọc rule trước khi reply, biết cái gì không được leak | SHIPPED |
| **1 — Secrets at-rest (scoped)** | `chmod 600` trên `~/.openclaw/openclaw.json`, `dashboard-pin.json`, `~/.openzca/profiles/.../credentials.json`. `chmod 700` trên parent dir. Unix only. Full DPAPI/Keychain encryption deferred. | SHIPPED (scoped) |
| **2 — Output filter** | Inject regex filter vào `openzalo/src/send.ts` → chặn 11 patterns nguy hiểm (file paths, API keys, config field names, line refs, "em đã ghi nhận rằng..."). On match → replace bằng safe canned message + log incident | SHIPPED (v3) |
| **3 — Append-only audit log** | `auditLog()` ghi `<workspace>/logs/audit.jsonl` các sự kiện: app_boot, gateway_ready, cron_fired/failed, zalo_output_blocked, dashboard_pin_unlock/lockout, system_resume/suspend, ... | SHIPPED |
| **4 — Dashboard PIN** | 6-digit PIN bảo vệ Dashboard. scrypt hash (N=2^15), 5 sai → lockout 15 phút, 15 phút idle → auto-lock. Reset qua Telegram User ID verified với `allowFrom`. | SHIPPED |
| **5 — Log rotation + retention** | `enforceRetentionPolicies()` rotate logs > 10-50 MB, archive memory > 90 ngày, xoá `openclaw.json.bak*` > 30 ngày | SHIPPED |

Mac App Nap có thể freeze cron — fix bằng `powerSaveBlocker.start('prevent-app-suspension')` ở app boot.

---

## Self-healing — không cần CEO xử lý

| Bug | Cơ chế |
|-----|--------|
| Gateway crash/stuck | Heartbeat watchdog 30 phút, 2 lần fail liên tiếp → auto stopOpenClaw + startOpenClaw |
| Orphan Zalo listener | `cleanupOrphanZaloListener()` kill `openzca listen` tree trước mỗi cold start |
| OpenZalo Windows shell bug (multi-line truncate) | Patched `electron/patches/openzalo-openzca.ts`, auto-restore mỗi startup |
| Block streaming split bot reply ("Dạ" → "D" + "ạ") | `ensureDefaultConfig()` set `blockStreaming: false` per-channel |
| Workspace path mismatch | `getWorkspace()` auto-detect, sync qua `openclaw.json → agents.defaults.workspace`, `MODORO_WORKSPACE` env injected vào gateway |
| better-sqlite3 ABI mismatch | Postinstall `fix-better-sqlite3.js` fetch prebuilt cho đúng Electron + arch (cross-arch Mac CI verified bằng Mach-O CPU type check) |
| Mac App Nap freeze cron | `powerSaveBlocker('prevent-app-suspension')` ở app boot |
| openclaw schema drift | Generic schema healer parse `Unrecognized key` từ stderr, delete key động, retry. Self-heal future schema breaks. |
| Telegram chatId mất | 3-tier recovery: openclaw.json → sticky-chatid.json → getUpdates parse |
| Stale group/friend cache | Auto `openzca auth cache-refresh` mỗi 10 phút |
| openzca friend_event không subscribe | Inject patch trong cli.js để auto-accept friend request + refresh cache → stranger thêm bạn → bot reply trong vài giây |

---

## Bot self-improvement

`.learnings/LEARNINGS.md` chứa bài học pre-loaded. Bot đọc mỗi session, không lặp lại lỗi cũ. Bot có quyền tự ghi thêm bài học khi gặp lỗi mới.

---

## Hệ thống cá nhân hóa theo ngành

Wizard chọn ngành → copy:
- `skills/<nganh>.md` → `skills/active.md` (kỹ năng chuyên ngành)
- `industry/<nganh>.md` → `industry/active.md` (quy trình vận hành)
- `prompts/sop/<nganh>.md` → `prompts/sop/active.md` (mẫu giao việc)
- `prompts/training/<nganh>.md` → `prompts/training/active.md`

8 ngành: F&B, BĐS, thương mại, dịch vụ, giáo dục, công nghệ, sản xuất, tổng quát.

---

## Kiến trúc

```
+--------------------------------------------------------+
|              Electron Desktop App (v2.2.9)              |
|  Wizard (4 steps)  |  Dashboard (7 tabs)  |  Tray      |
+------------------------+-------------------------------+
                         | IPC (preload.js)
+------------------------+-------------------------------+
|              OpenClaw Gateway (:18789)                  |
|  Telegram | OpenZalo (patched) | Memory SQLite | Cron  |
+------------------------+-------------------------------+
                         |
+------------------------+-------------------------------+
|              9Router (:20128)                           |
|  AI routing — Ollama Cloud + ChatGPT Plus + fallback   |
+--------------------------------------------------------+
                         |
+------------------------+-------------------------------+
|              OpenZCA daemon (Zalo listener)             |
|  WebSocket → zca-js → Zalo Web                         |
+--------------------------------------------------------+
```

**Luồng dữ liệu:**
- CEO Telegram → Gateway → 9Router → AI → reply
- Khách Zalo → OpenZCA → OpenZalo plugin → Gateway → AI → reply
- CEO Zalo cá nhân → OpenZalo phát hiện owner → inject `[ZALO_CHU_NHAN]` marker → bot switch CEO mode
- Cron (file-based, node-cron) → handler chạy → audit log → reply qua Telegram

---

## Cấu trúc file

```
claw/
├── electron/
│   ├── main.js                # Main process: IPC, cron, document, knowledge, gateway, patches
│   ├── preload.js             # Renderer bridges
│   ├── package.json           # name: modoro-claw, productName: MODOROClaw
│   ├── ui/
│   │   ├── dashboard.html     # 7-tab dashboard (overview, schedules, telegram, zalo, knowledge, 9router, openclaw)
│   │   ├── wizard.html        # 4-step setup
│   │   ├── splash.html        # Win first-launch vendor extract progress
│   │   └── no-openclaw.html
│   ├── patches/
│   │   └── openzalo-openzca.ts # OpenZalo Windows shell fix template
│   ├── scripts/
│   │   ├── prebuild-vendor.js # Bundle Node + plugins for Win/Mac
│   │   ├── fix-better-sqlite3.js # Cross-arch ABI fix postinstall
│   │   └── smoke-test.js      # Pre-build smoke check
│   └── build/
│       ├── icon.ico, icon.icns, icon.png
│       └── tray-icon.png
├── AGENTS.md                  # Bot rules — version-stamped, auto-migrate on upgrade
├── IDENTITY.md, USER.md, COMPANY.md, PRODUCTS.md, SOUL.md, MEMORY.md, HEARTBEAT.md
├── schedules.json             # Built-in cron defaults
├── custom-crons.json          # Bot-managed custom crons
├── zalo-blocklist.json        # User IDs bot không reply
├── zalo-owner.json            # CEO's personal Zalo userId for ZALO_CHU_NHAN detection
├── knowledge/                 # Knowledge tab data
│   ├── cong-ty/{index.md, files/}
│   ├── san-pham/{index.md, files/}
│   └── nhan-vien/{index.md, files/}
├── skills/                    # 8 industry skill files
├── industry/                  # 8 industry workflow files
├── prompts/sop/, prompts/training/
├── .learnings/                # LEARNINGS.md, ERRORS.md (pre-loaded)
├── memory/                    # Daily journals, zalo-users/<id>.md
├── logs/                      # audit.jsonl, security-output-filter.jsonl, openclaw.log, openzca.log
├── config/
├── docs/superpowers/
├── .github/workflows/
│   └── build-mac.yml          # Mac DMG build (arm64 + x64) on tag push
├── CLAUDE.md                  # Dev rules — fresh install parity, version pinning
├── PINNING.md                 # Pinned third-party versions
├── SECURITY-PLAN.md           # 5-layer defense status
├── RESET.bat                  # Win: wipe runtime files
└── RUN.bat                    # Win: launch dev mode

Runtime (per-user):
~/.openclaw/                   # OpenClaw runtime (config, plugins, sessions)
├── openclaw.json              # Bot token, channel config
├── dashboard-pin.json         # Layer 4 PIN hash
├── extensions/openzalo/       # Auto-patched plugin source
└── logs/                      # config-audit.jsonl

~/.openzca/profiles/default/   # Zalo session
├── credentials.json           # chmod 600, Layer 1
└── listener-owner.json        # PID lock + meta

Win packaged: %APPDATA%/modoro-claw/  (lowercase! matches Electron app.getName())
Mac packaged: ~/Library/Application Support/modoro-claw/
```

---

## Channel status

| Channel | Trạng thái |
|---------|-----------|
| Telegram DM | Hoạt động |
| Telegram bot commands | Hoạt động (12 slash commands) |
| Zalo DM (khách) | Hoạt động |
| Zalo group | Hoạt động (chỉ reply khi @mention) |
| Zalo CEO recognition | Hoạt động (ZALO_CHU_NHAN marker) |
| Knowledge upload (PDF/Word/Excel/CSV/TXT) | Hoạt động (FTS5 + AI summarize) |
| Cron tự động | Hoạt động (file-based, App Nap-safe) |
| Dashboard PIN lock | Hoạt động (scrypt + 5-attempt lockout) |
| Output filter | Hoạt động (v3 patterns + audit log) |
| Google Calendar / Gmail | Chưa implement |
| Facebook Messenger | Chưa implement |
| Facebook Fanpage | Chưa implement |

---

## Dev / build

```bash
# Clone + cài deps Electron
git clone https://github.com/modoro-digital/MODOROClaw.git
cd MODOROClaw/electron
npm install   # postinstall fix-better-sqlite3 chạy tự động

# Dev mode (Win)
cd ..
./RUN.bat

# Build Win EXE
cd electron
npm run build:win   # prebuild-vendor → smoke-test → electron-builder --win

# Build Mac DMG (chỉ trên Mac)
npm run build:mac:arm     # arm64
npm run build:mac:intel   # x64
```

Mac DMG cũng có thể build qua **GitHub Actions**: push tag `v*` → workflow `build-mac.yml` tự build cả 2 arch trên macos-14 runner, upload `.dmg` artifact + tạo Release.

---

## Quy tắc dev

Đọc `CLAUDE.md` trước khi sửa code. **Mọi fix BẮT BUỘC apply được cho user mới cài fresh** — không chỉ patch máy hiện tại. Plugin patches phải có version pin để self-migrate khi upgrade. Pin third-party versions theo `PINNING.md` — không bao giờ `npm install` không có version explicit.

---

## Liên hệ

MODORO Tech Corp · [github.com/modoro-digital/MODOROClaw](https://github.com/modoro-digital/MODOROClaw)
