# Lịch tự động — Tham khảo chi tiết

## File cấu hình

- `schedules.json` — built-in cron jobs (bot KHÔNG được ghi)
- `custom-crons.json` — CEO-created cron jobs (bot tạo qua API nội bộ)

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

## Tạo / sửa / xóa custom cron — qua API nội bộ

Bot dùng `web_fetch` gọi `http://127.0.0.1:20200/api/cron/*`. KHÔNG ghi file trực tiếp.

**Bảo mật:**
- API chỉ bind localhost (127.0.0.1)
- Mọi lệnh mutation (create/delete/toggle) yêu cầu phiên CEO Telegram đã xác thực
- Phiên Telegram CEO tự gắn header nội bộ; bot KHÔNG đọc `cron-api-token.txt`, KHÔNG thêm `token=<token>` vào URL
- Inbound.ts command-block chặn mọi mention của API URL từ Zalo
- Max 20 cron, max 500 ký tự content, tối thiểu 5 phút/lần
- Mỗi cron tạo qua API sẽ gửi alert cho CEO

### Xác thực — BẮT BUỘC cho create/delete/toggle

Gọi API local trực tiếp từ phiên CEO Telegram. Không tự lấy token, không truyền token query string.

### Quy tắc URL quan trọng

- Dùng `+` thay khoảng trắng trong URL (`Chào+buổi+sáng`, KHÔNG `Chào buổi sáng`)
- **`content` phải là tham số CUỐI CÙNG** — nội dung có thể chứa `&` hoặc ký tự đặc biệt, server sẽ lấy toàn bộ phần sau `content=`
- Ký tự đặc biệt: `&` → `%26`, `"` → `%22`, `%` → `%25`

### Tạo cron — gửi 1 nhóm

```
web_fetch http://127.0.0.1:20200/api/cron/create?label=Chào+sáng+nhóm+VIP&cronExpr=0+9+*+*+1-5&groupId=6778716167335853128&content=Chào+buổi+sáng+các+anh+chị!
```

### Tạo cron — gửi nhiều nhóm (broadcast)

```
web_fetch http://127.0.0.1:20200/api/cron/create?label=Broadcast+sáng&cronExpr=0+9+*+*+1-5&groupIds=111,222,333&content=Chào+buổi+sáng!
```

### Tạo cron — một lần (oneTimeAt)

```
web_fetch http://127.0.0.1:20200/api/cron/create?label=Thông+báo&oneTimeAt=2026-04-22T09:00:00&groupId=6778716167335853128&content=Khai+trương!
```

### Xem danh sách cron + nhóm (KHÔNG cần token)

```
web_fetch http://127.0.0.1:20200/api/cron/list
```

Trả JSON: `{ crons: [...], groups: [{ id, name }, ...] }`
Bot dùng `groups` để tra tên → groupId.

### Xóa cron

```
web_fetch http://127.0.0.1:20200/api/cron/delete?id=cron_1713765600000
```

### Tạm dừng / bật lại

```
web_fetch http://127.0.0.1:20200/api/cron/toggle?id=cron_1713765600000&enabled=false
```

## API response format

Mọi endpoint trả JSON:
- Thành công: `{ "success": true, "id": "...", "entry": {...} }`
- Lỗi 403: `{ "error": "CEO Telegram authorization required" }` — không gọi từ phiên CEO Telegram đã xác thực
- Lỗi 400: validation errors (groupId sai, cronExpr sai, oneTimeAt quá khứ)
- Lỗi 404: cron không tìm thấy

## cronExpr — BẮT BUỘC là cron expression

**CẤM TUYỆT ĐỐI:** KHÔNG dùng ISO date, KHÔNG dùng timestamp, KHÔNG dùng date string.

Ví dụ ĐÚNG:
- `0 9 * * 1-5` = 9h thứ 2-6
- `30 7 * * *` = 7:30 mỗi ngày
- `37 7 22 4 *` = 7:37 ngày 22/4 (một lần trong năm)
- `0 */2 * * *` = mỗi 2 giờ
- `0 7 1 * *` = 7h ngày 1 mỗi tháng

### Lịch một lần (one-time)

CEO nói "gửi lúc 7:37 hôm nay" → dùng `oneTimeAt` thay vì `cronExpr`.
Format: `YYYY-MM-DDTHH:MM:SS` (local time, KHÔNG có Z).
API validate: reject nếu date không hợp lệ hoặc trong quá khứ.

## Quy trình bắt buộc

1. CEO nhắn Telegram: "tạo cron gửi nhóm X mỗi sáng 9h nội dung Y"
2. Bot gọi `web_fetch .../api/cron/list` để xem nhóm available (không cần token)
3. Bot CONFIRM với CEO trước khi tạo
4. CEO xác nhận → bot gọi `web_fetch .../api/cron/create?...&content=...`
5. Hệ thống tự động reload cron

## Lưu ý

- Label tiếng Việt, KHÔNG emoji
- GroupId phải tồn tại (API tự validate, trả lỗi + danh sách nhóm nếu sai)
- cronExpr PHẢI là cron expression chuẩn (API tự validate)
- oneTimeAt format `YYYY-MM-DDTHH:MM:SS` (local time, KHÔNG có Z)
- Hệ thống tự reload sau mỗi thay đổi — KHÔNG cần restart
- Write mutex: API serialize mọi write — an toàn khi gọi nhiều lần liên tiếp
