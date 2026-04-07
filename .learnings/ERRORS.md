# Log Lỗi — Self-Improving Agent

Ghi lại lỗi command, tool failure, timeout để phát hiện pattern.

## Format

### [YYYY-MM-DD HH:MM] ERR-001 | Tool: [tên tool] | Severity: [critical/warn/info]
**Lỗi:** [Error message]
**Context:** [Đang làm gì]
**Đã xử lý:** [Có/Không — cách xử lý]

---

### [2026-04-06 22:00] ERR-001 | Tool: Bash (openclaw cron add) | Severity: critical
**Lỗi:** gateway closed (1008): pairing required
**Context:** CEO yêu cầu tạo cronjob, bot dùng `openclaw cron add` qua CLI
**Đã xử lý:** Có — KHÔNG dùng CLI cron nữa. Ghi file `custom-crons.json` trực tiếp. Xem LEARNINGS.md L-001.
