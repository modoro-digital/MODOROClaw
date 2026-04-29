# 9BizClaw

**Trợ lý AI doanh nghiệp — Telegram + Zalo, cài đặt 1 file**

Desktop app bundle sẵn mọi thứ. Tải file cài, chạy wizard, có ngay trợ lý AI 24/7. Không cần biết code, không cần cài Node.js hay bất kỳ thứ gì.

**v2.3.48** · Windows 10+ · macOS 11+ (Apple Silicon + Intel)

---

## Cài đặt

### Windows

1. Tải `9BizClaw Setup.exe` từ [Releases](https://github.com/modoro-digital/9BizClaw/releases)
2. Double-click → cài → launch
3. Lần đầu: splash bar trích xuất vendor (~30–60s) → wizard 5 bước → xong

### macOS

1. Tải `.dmg` (arm64 = Apple Silicon, x64 = Intel) từ [Releases](https://github.com/modoro-digital/9BizClaw/releases)
2. Kéo icon vào **Applications**
3. Lần đầu mở: **System Settings → Privacy & Security → Open Anyway**
4. Wizard 5 bước → xong

Cả hai platform bundle sẵn Node.js, OpenClaw, 9Router, OpenZCA, OpenZalo. Không cần Internet trừ khi gọi AI.

### Google Workspace

Nếu cần kết nối Calendar, Gmail, Drive, Contacts, Tasks hoặc Google Sheets, xem hướng dẫn lấy file OAuth Client JSON tại [docs/GOOGLE-WORKSPACE-SETUP.md](docs/GOOGLE-WORKSPACE-SETUP.md). File cần upload là OAuth Client ID loại Desktop app từ Google Cloud Console, không phải Service Account JSON.

---

## Tính năng

### Dashboard

| Tab | Nội dung |
|-----|----------|
| **Tổng quan** | Greeting, hoạt động gần đây, cron sắp tới, alerts cần xử lý |
| **Cá tính bot** | Chỉnh persona mix (region, voice, customer style, traits) sau khi wizard |
| **Tình trạng** | "Hôm nay shop như thế nào" — context real-time inject vào bot |
| **Lịch hẹn** | CRUD lịch hẹn local, kết nối Google Calendar |
| **Telegram** | Kiểm tra kết nối, gửi tin test, tạm dừng/tiếp tục, tour guide lần đầu |
| **Zalo** | Quản lý bạn bè, nhóm (3 chế độ + tóm tắt + nội bộ), gộp tin, tour guide lần đầu |
| **Lịch tự động** | 8 built-in crons + custom crons (cả agent mode), test fire thủ công |
| **Knowledge** | Upload PDF/Word/Excel, bot tự tóm tắt và tham chiếu khi trả lời (không trích nguồn) |
| **9Router** | Quản lý AI providers, API keys, model routing |
| **OpenClaw** | Debug gateway, xem log real-time |

### Kênh giao tiếp

- **Telegram** — kênh chỉ huy CEO, 12 slash commands
- **Zalo** — tự động trả lời khách, nhận diện chủ, quản lý nhóm + blocklist
- **Cross-channel** — gửi Zalo từ Telegram, escalate Zalo → Telegram, cron deliver cả hai

### AI

- **Persona mix** — tuỳ chỉnh giọng theo vùng miền, phong cách, nhóm khách
- **7 operational skills** — cron, knowledge, appointment, report, meditation, memory, follow-up
- **Round-robin + fallback** — nhiều AI provider, tự chuyển khi 1 cái fail
- **Vision** — đọc hình ảnh khách gửi, trả lời trực tiếp
- **DuckDuckGo search** — tìm kiếm web miễn phí, không cần API key
- **Cá nhân hóa theo ngành** — F&B, BĐS, dịch vụ, giáo dục, công nghệ, sản xuất, thương mại

### Zalo

- Tự kết bạn + chào khách mới
- Nhớ hồ sơ từng khách (CRM-lite)
- Đoán giới tính từ tên Việt
- Nhận diện CEO qua Zalo cá nhân
- 3 chế độ nhóm: @mention / mọi tin / tắt — xem tóm tắt nhóm
- 3 chế độ người lạ: trả lời / chào 1 lần / không trả lời
- Blocklist tích hợp
- Đọc hình ảnh khách gửi (vision)

### Tự động hóa

- 8 built-in crons: báo cáo sáng/tối, tuần, tháng, follow-up khách, heartbeat, meditation, dọn memory
- Custom crons: CEO yêu cầu bằng lời, bot tự tạo và lưu — hỗ trợ agent mode (AI xử lý + gửi kết quả vào nhóm Zalo)
- Cron API nội bộ (:20200) — bot tạo/xóa cron qua Telegram, gửi tin Zalo group qua API
- Self-healing: gateway crash, schema break, chatId mất
- Fast watchdog (20s): tự phục hồi gateway, không restart vì Zalo
- Auto-update 1 click ngay trong app

### Bảo mật

- Dashboard PIN lock (scrypt, lockout sau 5 lần sai)
- Output filter (chặn leak API keys, file paths, CoT tiếng Anh) — cả Telegram + Zalo
- Command-block (chặn lệnh admin từ Zalo strangers — cron, exec, broadcast)
- Audit log (mọi event ghi `audit.jsonl`)
- Escalation auto-forward (Zalo khiếu nại tự chuyển CEO qua Telegram + Zalo)
- Factory Reset + Export/Import workspace

---

## Kiến trúc

```
Electron Desktop App
├── Wizard (5 bước) → Dashboard → System Tray
│
├── OpenClaw Gateway (:18789)
│   ├── Telegram bot
│   ├── OpenZalo plugin (patched)
│   ├── Memory + Knowledge (SQLite)
│   └── Cron scheduler
│
├── 9Router (:20128)
│   └── AI routing: ChatGPT / Claude / Gemini / Ollama / ...
│
├── Cron API (:20200)
│   └── Cron CRUD + Zalo group send + knowledge add
│
└── OpenZCA daemon
    └── Zalo WebSocket listener
```

**Bundle size:** ~370 MB (Windows EXE) / ~580 MB (macOS DMG).  
Bao gồm Node.js v22, OpenClaw 2026.4.14, 9Router, OpenZCA, OpenZalo (~1.8 GB unpacked), Electron runtime.

---

## Build từ source

### Windows

```bash
git clone https://github.com/modoro-digital/9BizClaw.git
cd 9BizClaw/electron
npm install
npm run build:win
# Output: dist/9BizClaw Setup X.X.X.exe (~360 MB)
```

### macOS

```bash
cd 9BizClaw/electron
npm install
npm run build:mac:arm      # Apple Silicon
npm run build:mac:intel    # Intel
# Output: dist/9BizClaw-X.X.X-arm64.dmg
```

### Dev mode (Windows)

```bash
cd 9BizClaw
./RUN.bat
```

---

## Quy tắc phát triển

Đọc [CLAUDE.md](CLAUDE.md) trước khi sửa code.

- Mọi fix phải áp dụng được cho fresh install (`RESET.bat → RUN.bat`)
- Third-party versions pin theo [PINNING.md](PINNING.md)
- Smoke test chạy tự động trước mỗi build — fail thì build bị chặn

---

## License

Proprietary · MODORO Tech Corp
