---
name: ceo-memory-api
description: Bot memory API - lưu, tìm, duyệt và lấy context ký ức qua Cron API port 20200
metadata:
  version: 2.0.0
---

# Bộ nhớ bot (CEO Memory)

Bot có thể lưu và truy xuất ký ức qua Cron API. Xác thực: phiên Telegram CEO tự gắn header nội bộ. Không đọc `cron-api-token.txt`, không tự thêm `token=<token>`.

## Nguồn runtime chính

Trước khi làm task có khả năng cần ký ức, gọi context builder:

`POST http://127.0.0.1:20200/api/memory/context`

Body ví dụ:
```json
{
  "query": "xuất báo cáo tồn kho",
  "channel": "telegram",
  "taskType": "workflow",
  "intent": "export_report",
  "limit": 8
}
```

Kết quả trả về gồm:
- `memories`: ký ức phù hợp đã lọc theo kênh
- `procedures`: quy trình vận hành cần ưu tiên
- `entities`: đối tượng liên quan nếu có
- `safetyWarnings`: cảnh báo phân quyền/kênh
- `evidenceIds`: ID bằng chứng để CEO xem trong Dashboard

Khi đang ở kênh Zalo khách hàng, context builder tự loại ký ức `ceo`, `internal`, `workflow`. Không cố lấy vòng qua bằng `/api/memory/search`.

## Khi nào ghi ký ức

Gọi `/api/memory/write` trong cùng turn khi CEO dạy điều bền vững:
- CEO sửa lỗi bot: `type: "correction"`
- CEO dặn quy tắc tương lai: `type: "rule"`
- CEO nói sở thích hoặc phong cách làm việc: `type: "preference"`
- CEO dạy quy trình lặp lại: `type: "procedure"`
- CEO dạy sự thật ổn định về doanh nghiệp: `type: "fact"`
- Phát hiện pattern khách hàng lặp lại: `type: "pattern"`

Không ghi task completion, cron result, “đã gửi email”, “đã tạo file”, “đã đăng bài”. Đó là log, không phải memory.

## Lưu ký ức

`POST http://127.0.0.1:20200/api/memory/write`

Body tối thiểu:
```json
{
  "type": "procedure",
  "scope": "ceo",
  "content": "Khi CEO yêu cầu xuất báo cáo tồn kho, tạo file .xlsx local rồi gửi đường dẫn file cho CEO."
}
```

Type hợp lệ: `rule`, `pattern`, `preference`, `fact`, `correction`, `procedure`, `entity_note`, `task_state`.

Scope hợp lệ:
- `ceo`: chỉ CEO Telegram/app chat
- `internal`: nội bộ
- `workflow`: quy trình vận hành nội bộ
- `customer`: chỉ kênh khách hàng
- `public`: có thể dùng mọi kênh

Nếu nội dung chứa token, mật khẩu, số điện thoại, email hoặc dữ liệu nhạy cảm, hệ thống tự để `pending_review`. Ký ức pending không vào context cho đến khi CEO duyệt trong Dashboard.

## Tìm và quản trị

Tìm thô:
```json
POST /api/memory/search
{"query":"bảo hành","channel":"telegram","limit":5}
```

Tắt/bật:
```json
POST /api/memory/status
{"id":"mem_...","status":"disabled"}
```

Trạng thái hợp lệ: `active`, `pending_review`, `disabled`, `superseded`, `deleted`.

Đánh dấu đã bị thay thế:
```json
POST /api/memory/supersede
{"id":"mem_old","supersededById":"mem_new"}
```

Xóa hẳn:
```json
POST /api/memory/delete
{"id":"mem_..."}
```

## Quy tắc chất lượng

- Ghi insight, không ghi log.
- Viết tiếng Việt có dấu, ngắn gọn, dưới 500 ký tự.
- Trước khi ghi, gọi `/api/memory/context` hoặc `/api/memory/search` để tránh trùng.
- Ghi thầm khi tự quan sát. Chỉ xác nhận khi CEO nói rõ “ghi nhớ/nhớ giùm”.
- Nếu CEO dạy quy trình vận hành mới, ghi `procedure`, không ghi `rule`.
- Nếu ký ức mới thay ký ức cũ, dùng `supersedesId` khi write hoặc gọi `/api/memory/supersede`.

## Ví dụ quan trọng

CEO nói: “Từ giờ xuất báo cáo tồn kho thì làm file .xlsx local, đừng tạo document online.”

Ghi:
```json
{
  “type”: “procedure”,
  “scope”: “workflow”,
  “entityType”: “workflow”,
  “entityId”: “inventory-report-export”,
  “content”: “Khi xuất báo cáo tồn kho, tạo file .xlsx local bằng anthropic-xlsx skill và gửi đường dẫn file cho CEO; không tạo document online.”
}
```

CEO nói: “Đừng bao giờ báo cáo dài, anh chỉ cần 3-5 dòng.”

Ghi:
```json
{
  "type": "preference",
  "scope": "ceo",
  "content": "CEO thích báo cáo ngắn 3-5 dòng, rõ ý, không lan man."
}
```
