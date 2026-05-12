---
name: ceo-memory-api
description: Bot memory API — lưu/tìm/xóa ký ức qua Cron API port 20200
metadata:
  version: 1.0.0
---

# Bộ nhớ bot (CEO Memory)

Bot có thể lưu và truy xuất ký ức qua Cron API. Xác thực: phiên Telegram CEO tự gắn header nội bộ — KHÔNG đọc `cron-api-token.txt`, KHÔNG tự thêm `token=<token>`.

## Khi nào dùng

- CEO sửa lỗi bot ("không phải vậy") → lưu `correction`
- Học được quy tắc mới từ CEO → lưu `rule`
- Phát hiện pattern khách hàng → lưu `pattern`

## Lưu ký ức

`POST http://127.0.0.1:20200/api/memory/write`
Body: `{"type":"rule","content":"Khách hỏi bảo hành → 12 tháng"}`
Type: `rule` | `pattern` | `preference` | `fact` | `correction`

## Tìm ký ức

`POST http://127.0.0.1:20200/api/memory/search`
Body: `{"query":"bảo hành","limit":5}`

## Xóa ký ức

`POST http://127.0.0.1:20200/api/memory/delete`
Body: `{"id":"mem_..."}`

## Lưu ý

KHÔNG tự ý gọi memory/write trong hội thoại thường. Hệ thống nudge sẽ tự động review và lưu sau mỗi cuộc hội thoại CEO.
