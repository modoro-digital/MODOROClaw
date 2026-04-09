# MODOROClaw

**Trợ lý AI doanh nghiệp — Telegram + Zalo, 1-click cài đặt**

Desktop app bundle sẵn mọi thứ. CEO tải file cài, chạy wizard 4 bước, có ngay trợ lý AI 24/7. Không cần biết code.

**v2.2.20** · Windows 10+ · macOS 11+ (Apple Silicon + Intel)

---

## Cài đặt

### Windows

```
1. Tải MODOROClaw Setup.exe từ Releases
2. Double-click → cài → launch
3. Wizard 4 bước → xong
```

### macOS

```
1. Tải .dmg (arm64 hoặc x64) từ Releases
2. Kéo vào Applications
3. Lần đầu: System Settings → Privacy & Security → Open Anyway
4. Wizard 4 bước → xong
```

Cả hai đều bundle sẵn Node.js, OpenClaw, 9Router, OpenZCA, OpenZalo. Không cần Internet trừ khi gọi AI.

---

## Tính năng

### Kênh giao tiếp
- **Telegram** — kênh chỉ huy CEO, 12 slash commands
- **Zalo** — tự động trả lời khách, nhận diện chủ, quản lý nhóm/blocklist
- **Cross-channel** — gửi Zalo từ Telegram, escalate từ Zalo sang Telegram

### Dashboard
- **Tổng quan** — khách mới, sự kiện, cron, alerts cần xử lý
- **Lịch tự động** — 8 built-in crons + custom crons do bot tạo
- **Telegram/Zalo** — kiểm tra kết nối, test gửi tin, quản lý nhóm
- **Knowledge** — upload PDF/Word/Excel, bot tự tóm tắt và tham chiếu
- **9Router** — quản lý AI providers, API keys, model routing
- **OpenClaw** — debug gateway, xem log real-time

### AI
- **79 expert skills** — marketing, advisory, strategy, content, sales, growth, finance, HR
- **Smart model selection** — wizard tự chọn model tốt nhất khi onboard
- **Round-robin + fallback** — nhiều provider, tự chuyển khi 1 cái fail
- **Cá nhân hóa theo ngành** — F&B, BĐS, dịch vụ, giáo dục, công nghệ, sản xuất, thương mại

### Zalo
- Tự kết bạn + chào khách mới
- Nhớ hồ sơ từng khách (CRM-lite)
- Đoán giới tính từ tên Việt
- Nhận diện CEO qua Zalo cá nhân
- 3 chế độ: auto / read-only / daily summary

### Tự động hóa
- 8 built-in crons: báo cáo sáng/tối, tuần, tháng, follow-up khách, heartbeat, meditation, dọn memory
- Custom crons: CEO yêu cầu bằng lời, bot tự tạo
- Self-healing: gateway crash, schema break, chatId mất, cookie Zalo hết hạn

### Bảo mật
- Dashboard PIN lock (scrypt, lockout sau 5 lần sai)
- Output filter (chặn leak API keys, file paths)
- Audit log (mọi event ghi `audit.jsonl`)
- Secrets `chmod 600` (Unix)

---

## Kiến trúc

```
Electron Desktop App
├── Wizard (4 steps) → Dashboard (7 tabs) → Tray
│
├── OpenClaw Gateway (:18789)
│   ├── Telegram bot
│   ├── OpenZalo plugin (patched)
│   ├── Memory + Knowledge
│   └── Cron scheduler
│
├── 9Router (:20128)
│   └── AI routing: Ollama / ChatGPT / Claude / Gemini / ...
│
└── OpenZCA daemon
    └── Zalo WebSocket listener
```

---

## Build từ source

### Windows

```bash
git clone https://github.com/modoro-digital/MODOROClaw.git
cd MODOROClaw/electron
npm install
npm run build:win
# Output: dist/MODOROClaw Setup X.X.X.exe
```

### macOS

```bash
git clone https://github.com/modoro-digital/MODOROClaw.git
cd MODOROClaw/electron
npm install
npm run build:mac:arm      # Apple Silicon
npm run build:mac:intel    # Intel
# Output: dist/MODOROClaw-X.X.X-arm64.dmg
```

### Dev mode (Windows)

```bash
cd MODOROClaw
./RUN.bat
```

---

## Kiểm tra phiên bản

Phiên bản hiển thị ở sidebar Dashboard (dưới logo). Hoặc check qua CLI:

```bash
# Windows (packaged)
"%LOCALAPPDATA%\Programs\MODOROClaw\MODOROClaw.exe" --version

# macOS (packaged)
/Applications/MODOROClaw.app/Contents/MacOS/MODOROClaw --version

# Dev mode
cd electron && node -e "console.log(require('./package.json').version)"
```

So sánh với version mới nhất trên [Releases](https://github.com/modoro-digital/MODOROClaw/releases).

---

## Quy tắc phát triển

Đọc `CLAUDE.md` trước khi sửa code. Mọi fix phải áp dụng được cho fresh install. Third-party versions pin theo `PINNING.md`.

---

## License

MIT

---

MODORO Tech Corp · [modoro-digital/MODOROClaw](https://github.com/modoro-digital/MODOROClaw)
