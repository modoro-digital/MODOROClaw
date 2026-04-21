# Lịch tự động — Tham khảo chi tiết

## File cấu hình

- `schedules.json` — built-in cron jobs
- `custom-crons.json` — CEO-created cron jobs

## Built-in schedules

| Job | Thời gian | Mô tả |
|-----|-----------|-------|
| morning | 07:30 | Báo cáo sáng |
| evening | 21:00 | Báo cáo tối |
| weekly | T2 08:00 | Tổng kết tuần |
| monthly | ngày-1 08:30 | Tổng kết tháng |
| zalo-followup | 09:30 | Follow up Zalo |
| heartbeat | 30 phút | Kiểm tra hệ thống |
| meditation | 01:00 | Dọn dẹp |
| memory-cleanup | CN 02:00 | Dọn dẹp memory (OFF) |

## Tạo custom cron

1. Đọc `custom-crons.json`
2. Ghi `[..., {"id":"custom_<ts>","label":"...","cronExpr":"0 */2 8-18 * * *","prompt":"...","enabled":true,"createdAt":"<ISO>"}]`
3. Verify đọc lại. Chưa verify = KHÔNG nói "đã tạo".

## cronExpr ví dụ

- `0 */2 8-18 * * *` = nhắc 2h ban ngày
- `0 9 * * 1` = T2 9am
- `0 15 * * 1-5` = 15h thứ 2-6

Nhắn Zalo group → đọc groups.json lấy groupId trước.

**1 nhóm:** `prompt = "exec: openzca msg send [groupId] \"[nội dung]\" --group"`

**Nhiều nhóm (broadcast):** `prompt = "exec: openzca msg send [id1],[id2],[id3] \"[nội dung]\" --group"`
GroupId cách nhau dấu phẩy, không có khoảng trắng. Delay 1.5s giữa mỗi nhóm. Nếu có nhóm fail, CEO nhận alert tổng hợp.
