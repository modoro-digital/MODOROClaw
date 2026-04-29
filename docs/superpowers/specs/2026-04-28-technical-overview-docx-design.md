# 9BizClaw Technical Overview (.docx) — Design Spec

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tạo file `docs/9BizClaw-Technical-Overview.docx` — tài liệu kỹ thuật tổng hợp toàn bộ hệ thống, phục vụ CEO reference + dev mới onboard.

**Format:** Microsoft Word (.docx), clean professional style (Calibri/Arial, heading có màu nhẹ).

**Ngôn ngữ:** Mixed Việt-Anh — thuật ngữ kỹ thuật giữ tiếng Anh (gateway, watchdog, spawn, IPC), giải thích bằng tiếng Việt.

**Constraint quan trọng nhất:** Mọi thông tin (tên file, function, port, pattern count, số lượng, thứ tự boot) PHẢI được verify từ codebase thật tại thời điểm viết. KHÔNG ĐƯỢC bịa hoặc dùng thông tin từ memory/conversation. Mỗi section phải grep/read source trước khi viết.

---

## Cấu trúc file

### Phần 1: Tổng quan
- App là gì, giải quyết vấn đề gì
- Tech stack
- Message flow diagram (text-based)

### Phần 2: Cấu trúc file
- main.js — orchestrator
- lib/ — liệt kê từng module với mô tả 1 dòng (verify bằng ls + đọc header)
- packages/modoro-zalo/ — Zalo fork
- ui/ — dashboard, wizard, license, splash
- scripts/ — smoke test, prebuild, build

### Phần 3: Boot sequence
- Thứ tự khởi động (verify từ main.js app.whenReady block)
- Vendor extraction (Windows first-launch)
- 9Router → Gateway → Channel probes
- Boot race conditions đã gặp và đã fix

### Phần 4: Config system
- ensureDefaultConfig() — self-healing
- Schema healer — parseUnrecognizedKeyErrors + healOpenClawConfigInline
- writeOpenClawConfigIfChanged() — byte-equal guard
- Config migration openzalo → modoro-zalo
- Tất cả config-related patches

### Phần 5: Gateway
- Start/stop lifecycle
- Fast watchdog (verify threshold, boot grace, restart cap từ gateway.js)
- isGatewayAlive() timeout
- Gateway-related patches

### Phần 6: Channels (Telegram + Zalo)
- Probes (verify từ channels.js)
- Output filter (verify pattern count từ channels.js)
- Pause fail-closed
- sendCeoAlert + disk fallback
- sendZalo + long message split
- Channel-related patches

### Phần 7: Zalo plugin (modoro-zalo fork)
- Tại sao fork
- Defense layers trong inbound.ts (verify markers từ file thật)
- Escalation scanner trong send.ts (verify pattern count)
- DELIVER-COALESCE
- Plugin install flow
- Zalo-related patches

### Phần 8: Cron system
- findNodeBin() fallback chain (verify từ boot.js)
- spawnOpenClawSafe() shell guard
- Self-test + CEO alert
- Cron API (verify port, token mechanism từ cron-api.js)
- Cron-related patches

### Phần 9: Security
- tools.allow (verify exact list từ config.js)
- Command-block
- BrowserWindow config (verify từ main.js)
- Output filter
- License mechanism

### Phần 10: Knowledge system
- Categories (verify từ knowledge.js)
- SQLite + fallback
- better-sqlite3 ABI fix
- RAG

### Phần 11: Workspace & Data
- seedWorkspace() (verify từ workspace.js)
- Memory file cap (verify từ conversation.js)
- Retention policies (verify targets từ workspace.js)
- Follow-up queue lock

### Phần 12: Build & Distribution
- prebuild-vendor.js flow
- Vendor tar extraction
- Smoke test suite (verify test count)
- EXE size, zero-dependency
- Mac signed, Win unsigned

### Phần 13: Known issues & Lộ trình
- EV code signing
- AGENTS.md size limit
- All active patches summary

### Phần 14: Vận hành nhanh
- Restart, đọc log, verify component
- Troubleshooting
- Link docs chi tiết

---

## Approach: Tạo .docx

Dùng npm package `docx` (https://www.npmjs.com/package/docx) để generate .docx từ Node.js script. Script đọc codebase → extract facts → build document.

Hoặc: viết .md trước → convert bằng pandoc.

Recommend: viết trực tiếp bằng `docx` package cho control tốt hơn về styling (heading colors, font, spacing).

## Verification protocol

Mỗi section trong implementation:
1. Grep/Read file source liên quan
2. Extract facts (numbers, names, order)
3. Viết content dựa trên facts
4. Cross-check: mọi claim có file:line reference
