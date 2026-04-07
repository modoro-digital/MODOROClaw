# MODOROClaw

**Trợ lý AI 1-click cho CEO doanh nghiệp Việt Nam**

Ứng dụng desktop Electron điều khiển hệ sinh thái OpenClaw — trợ lý AI cá nhân kết nối Telegram (kênh CEO), Zalo (kênh khách), và AI model qua 9Router. CEO ra lệnh bằng tiếng Việt, trợ lý xử lý tin nhắn Zalo, gửi báo cáo định kỳ, và tự cải thiện qua bài học.

## Kiến trúc

```
+-----------------------------------------------------+
|           Electron Desktop App                       |
|  Wizard (4 steps)  |  Dashboard (5 pages)           |
+------------------------+----------------------------+
                         | IPC (preload.js)
+------------------------+----------------------------+
|              OpenClaw Gateway (:18789)               |
|  Telegram | OpenZalo | Memory SQLite | Cron         |
+------------------------+----------------------------+
                         |
+------------------------+----------------------------+
|              9Router (:20128)                        |
|  AI routing — Ollama Cloud + fallback                |
+-----------------------------------------------------+
```

**Luồng dữ liệu:**
- CEO nhắn Telegram → Gateway → AI (qua 9Router) → reply
- Khách nhắn Zalo → OpenZalo plugin → AI → tự reply hoặc escalate Telegram
- Cron (file-based, node-cron) → đến giờ → gửi reminder qua Telegram

## Tính năng đã hoạt động

### 1. Setup Wizard (4 bước)

| Bước | Nội dung |
|------|----------|
| 1 | Tên CEO, công ty, ngành (8 ngành: F&B, BĐS, thương mại, dịch vụ, giáo dục, công nghệ, sản xuất, tổng quát), phong cách, xưng hô |
| 2 | Đăng nhập Ollama Cloud, lấy API key, tự setup 9Router |
| 3 | Tạo Telegram Bot (BotFather), nhập token + user ID, test kết nối |
| 4 | Quét QR Zalo, chọn chế độ Zalo (auto / read / daily) |

Lịch tự động (báo cáo sáng 07:30, tóm tắt tối 21:00) cài sẵn defaults — chỉnh sau trong Dashboard.

### 2. Dashboard — 5 pages

**Sidebar menu:**
- 🏠 **Tổng quan** — trạng thái 5 kênh (Telegram, Zalo, Google, AI, Gateway) + lệnh nhanh
- 📅 **Lịch tự động** — xem/sửa cron, click chi tiết, nút Test ngay
- 📱 **Telegram** — giới thiệu + 6 lệnh nhanh
- 💬 **Zalo** — quản lý nhóm whitelist + chặn user (3 columns: settings/groups/friends)
- 📚 **Knowledge** — upload tài liệu công ty/sản phẩm/nhân viên (3 columns: folders/files/upload)

**Sidebar tools:**
- 🔧 9Router UI · ⚡ Gateway UI · ☀️/🌙 Light/dark theme toggle

**Activity panel:** real-time log ở trang Tổng quan, FAB drawer ở các trang khác.

### 3. Cron tự động (file-based, vĩnh viễn)

**Fixed schedules** (`schedules.json` trong workspace):
- `morning` 07:30 — báo cáo sáng
- `evening` 21:00 — tóm tắt cuối ngày
- `heartbeat` mỗi 5 phút — auto-restart gateway nếu chết
- `meditation` 01:00 — ghi queue self-improvement

**Custom crons** (`custom-crons.json`): bot ghi khi CEO yêu cầu, vĩnh viễn, không hết hạn. CEO bật/tắt/xóa qua Dashboard.

Cron handlers gửi reminder trực tiếp qua Telegram Bot API (không phụ thuộc gateway HTTP). File watcher tự reload khi file thay đổi.

### 4. Quản lý Zalo

**Chế độ trả lời:**
| Mode | Hành vi |
|------|---------|
| `auto` | Tự reply khách, escalate phức tạp qua Telegram |
| `read` | Chỉ đọc, báo Telegram, không reply |
| `daily` | Tóm tắt cuối ngày qua Telegram |

**Whitelist nhóm:** tick checkbox nhóm Zalo nào bot được trả lời. Bỏ tick → im lặng.
**Blocklist user:** tick user nào bot KHÔNG trả lời (lưu `zalo-blocklist.json`, bot đọc trước khi reply).
**Sync cache:** nút "Đồng bộ từ Zalo" gọi `openzca auth cache-refresh` để load nhóm/bạn bè mới.
**Trong nhóm:** bot chỉ reply khi được @mention (behavior chuẩn).

### 5. Knowledge doanh nghiệp

CEO upload file (PDF/Word/Excel/TXT/CSV/ảnh) vào 3 folder cố định:
- **Công ty** — hợp đồng, chính sách, SOP
- **Sản phẩm** — catalog, bảng giá
- **Nhân viên** — danh sách, ca làm

Bot AI tự tóm tắt mỗi file 1-2 câu, ghi vào `knowledge/<cat>/index.md`. Mỗi session bootstrap, bot đọc 3 file index để biết "có gì trong knowledge". Khi cần chi tiết → đọc file gốc + trả lời có trích nguồn.

Backend dùng SQLite FTS5 để full-text search + AI summarize qua 9Router.

### 6. Document library (cũ — qua Telegram)

CEO gửi file qua Telegram → bot tự lưu vào `documents/`, parse PDF/Word/Excel/CSV, index FTS5. CEO hỏi → bot search + trả lời.

### 7. Self-healing

Auto-fix các bug đã gặp, không cần CEO xử lý:

| Bug | Cơ chế |
|-----|--------|
| Gateway crash/stuck | Heartbeat watchdog mỗi 5 phút, auto stopOpenClaw + startOpenClaw |
| Orphan Zalo listener (gateway chết, listener tree còn sống) | `cleanupOrphanZaloListener()` kill `openzca listen` tree trước mỗi cold start; cleanup khi app quit |
| OpenZalo Windows shell bug (multi-line message bị truncate) | Patched `electron/patches/openzalo-openzca.ts`, auto-restore mỗi startup nếu plugin bị reinstall |
| Block streaming split bot reply ("Dạ" → "D" + "ạ") | `ensureDefaultConfig()` set `blockStreaming: false` ở 3 levels (openzalo + telegram + agents.defaults) |
| Workspace path mismatch (bot vs Electron) | `getWorkspace()` auto-detect writable, sync qua `openclaw.json → agents.defaults.workspace` |
| Stale group/friend cache | Auto `openzca auth cache-refresh` mỗi 10 phút |

### 8. Bot self-improvement

`.learnings/LEARNINGS.md` chứa 5 bài học pre-loaded (L-001 .. L-005). Bot đọc mỗi session, không lặp lại lỗi cũ:
- L-001: Không dùng CLI `openclaw cron` → ghi file `custom-crons.json`
- L-002: Không hiển thị lỗi kỹ thuật cho CEO
- L-003: Verify file sau mỗi lần ghi (tránh nói dối success)
- L-004: 2 file cron — `schedules.json` (fixed) + `custom-crons.json` (custom)
- L-005: Không chạy `openclaw cron list/status/restart`, đọc file trực tiếp

Bot có quyền tự ghi thêm bài học vào LEARNINGS.md khi gặp lỗi mới.

### 9. Hệ thống cá nhân hóa theo ngành

Khi CEO chọn ngành ở wizard, hệ thống copy:
- `skills/<nganh>.md` → `skills/active.md` (kỹ năng chuyên ngành)
- `industry/<nganh>.md` → `industry/active.md` (quy trình vận hành)
- `prompts/sop/<nganh>.md` → `prompts/sop/active.md` (mẫu giao việc)
- `prompts/training/<nganh>.md` → `prompts/training/active.md`

8 ngành có sẵn: F&B, BĐS, thương mại, dịch vụ, giáo dục, công nghệ, sản xuất, tổng quát.

### 10. Telegram slash commands

12 commands đã đăng ký (`/menu`, `/baocao`, `/huongdan`, `/skill`, `/thuvien`, `/new`, `/reset`, `/status`, `/stop`, `/usage`, `/help`, `/restart`).

## Cấu trúc file

```
claw/
├── electron/              # Electron app
│   ├── main.js            # Main process: IPC, cron, document, knowledge, gateway
│   ├── preload.js         # Renderer bridges
│   ├── ui/
│   │   ├── dashboard.html # 5-page dashboard
│   │   ├── wizard.html    # 4-step setup
│   │   └── no-openclaw.html
│   └── patches/
│       └── openzalo-openzca.ts  # OpenZalo Windows shell fix template
├── AGENTS.md              # Bot rules (CẤM CLI cron, knowledge instructions...)
├── IDENTITY.md, USER.md, COMPANY.md, PRODUCTS.md, SOUL.md, MEMORY.md, HEARTBEAT.md
├── schedules.json         # Fixed cron defaults (morning/evening/heartbeat/meditation)
├── custom-crons.json      # Bot-managed custom crons
├── zalo-blocklist.json    # User IDs bot không reply
├── knowledge/             # Knowledge tab data
│   ├── cong-ty/{index.md, files/}
│   ├── san-pham/{index.md, files/}
│   └── nhan-vien/{index.md, files/}
├── skills/                # 8 industry skill files
├── industry/              # 8 industry workflow files
├── prompts/sop/, prompts/training/
├── .learnings/            # LEARNINGS.md, ERRORS.md (pre-loaded)
├── memory/                # Daily journals, people/projects/decisions/context
└── docs/superpowers/specs/  # Design specs

~/.openclaw/
├── openclaw.json          # OpenClaw runtime config
├── extensions/openzalo/   # OpenZalo plugin (auto-patched)
└── workspace/memory.db    # SQLite FTS5 (documents + knowledge)
```

## Cài đặt + chạy

```bash
# 1. Cài deps Electron
cd electron
npm install

# 2. Cài OpenClaw + 9Router toàn cục
npm install -g openclaw 9router

# 3. Chạy app (Windows)
./RUN.bat
```

**Reset hoàn toàn (mô phỏng máy mới):**
```bash
./RESET.bat   # Xóa hết: ~/.openclaw, ~/.openzca, runtime files
./RUN.bat     # Wizard sẽ xuất hiện
```

## Quy tắc dev

Đọc `CLAUDE.md` trước khi sửa code. **Mọi fix BẮT BUỘC apply được cho user mới cài fresh** — không chỉ patch máy hiện tại.

## Channel status

| Channel | Trạng thái |
|---------|-----------|
| Telegram | ✅ DM hoạt động |
| Zalo DM | ✅ Hoạt động |
| Zalo group | ✅ Hoạt động (chỉ reply khi @mention) |
| Google Calendar/Gmail | ❌ Chưa implement |
| Facebook Messenger | ❌ Chưa implement |
| Facebook Fanpage | ❌ Chưa implement |
