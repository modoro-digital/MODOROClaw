---
name: zalo-followup-sheet
description: Xuất danh sách khách hàng Zalo (CRM) để nhân viên follow-up — trả về JSON hoặc lưu thành file .xlsx local
metadata:
  version: 2.0.0
---

# Xuất danh sách khách Zalo (CRM)

CHỈ CEO Telegram. Khách Zalo -> "Dạ đây là thông tin nội bộ ạ."

## Khi nào dùng

CEO nói: "tổng hợp khách Zalo", "xuất danh sách khách", "danh sách khách cần chăm", "follow-up khách", "xuất khách hàng"

## Cách dùng (1 API call)

```
web_fetch url="http://127.0.0.1:20200/api/zalo-crm/export" method=POST body="{\"dateRange\":\"today\"}"
```

Response: `{customersExported, customers: [{name, phone, summary}]}`

Trình bày danh sách khách cho CEO. Nếu CEO muốn file, dùng skill `anthropic-xlsx` để tạo file `.xlsx` local từ dữ liệu trả về.

## Tuỳ chọn

| Param | Ý nghĩa |
|-------|---------|
| `dateRange` | `"today"` (mặc định) hoặc `"all"` |

## Lỗi thường gặp

- `"No customers found"` -> "Không có khách Zalo mới trong khoảng thời gian này."

## Cron tự động

CEO: "mỗi tối 8h xuất danh sách khách Zalo" -> tạo cron agent mode. Đọc `skills/operations/cron-management.md`.
