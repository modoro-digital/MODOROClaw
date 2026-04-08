# Bài Học — Self-Improving Agent

Bot ghi lại bài học từ sai lầm để ngày càng tốt hơn. **Pattern lặp 3+ lần → promote lên AGENTS.md** rồi archive entry cũ. Giữ file này dưới 5k chars.

## Format

```
### [YYYY-MM-DD] ID: L-### | Area: ... | Priority: high/medium/low
**Tình huống:** ...
**Sai lầm:** ...
**Bài học:** ...
**Trạng thái:** active | promoted | archived
```

Promoted entries đã được đưa vào AGENTS.md và không cần đọc lại ở đây — xem `archive/LEARNINGS-YYYY-MM-DD.md`.

---

### [2026-04-07] ID: L-006 | Area: daily-summary/stale-bugs | Priority: high
**Tình huống:** Bot lặp lại "fix cron handler bug" trong daily summary dù bug đã fix cùng ngày.
**Sai lầm:** Copy-forward entry từ session history cũ vào "việc tồn đọng" mà không verify bug còn tồn tại.
**Bài học:** Trước khi liệt kê bất kỳ bug nào vào "việc tồn đọng", PHẢI verify bug đó VẪN còn bằng cách đọc state hiện tại (code, config, logs). KHÔNG dựa vào session history cũ. Memory cũ có thể stale; ground truth là state hiện tại. Mục "việc tồn đọng" CHỈ liệt kê việc CEO chưa hoàn thành, KHÔNG tự thêm "bugs dev sửa" trừ khi CEO hỏi hoặc `.learnings/ERRORS.md` có entry mới trong 24h.
**Trạng thái:** active

---

## Đã promoted vào AGENTS.md (không đọc lại)

- L-001 (cron/scheduling): Không dùng `openclaw cron` CLI, ghi trực tiếp file → promoted vào "CẤM TUYỆT ĐỐI" + "Lịch tự động"
- L-002 (error-handling): Không hiển thị lỗi kỹ thuật cho CEO → promoted vào "CẤM TUYỆT ĐỐI"
- L-003 (cron/verification): Verify sau khi ghi file cron → promoted vào "Lịch tự động & Nhắc nhở"
- L-004 (cron/fixed-schedules): 2 file cron (schedules.json + custom-crons.json) → promoted vào "Lịch tự động"
- L-005 (cron/status-check): Không chạy CLI `openclaw cron list`, đọc file trực tiếp → promoted vào "CẤM TUYỆT ĐỐI" + "Khi cron không chạy đúng giờ"
