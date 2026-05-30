---
name: bao-cao-ngay
description: Báo cáo ngày/tuần cho CEO — tổng hợp từ workspace, đọc 30 giây
metadata:
  version: 2.0.0
---

# Báo cáo ngày cho CEO

CHỈ CEO Telegram. Khách Zalo -> "Dạ đây là thông tin nội bộ ạ."

## Cách dùng (1 API call)

CEO nói "báo cáo hôm nay" -> gọi NGAY:

```
web_fetch url="http://127.0.0.1:20200/api/report/daily" method=POST body="{\"date\":\"2026-05-19\"}"
```

Response chứa: `revenue` (income/expense/net), `customers` (newToday/pendingFollowUp), `crons` (fired/failed), `highlights`, `sources`.

## Format báo cáo ngày

```
BÁO CÁO NGÀY [dd/mm/yyyy]

THU CHI
- Thu: [tổng] ([N giao dịch])
- Chi: [tổng] ([N giao dịch])
- Ròng: [thu - chi]

KHÁCH MỚI
- [N] khách Zalo mới
- [tên]: [1 dòng nhu cầu/trạng thái]

FOLLOW-UP TỒN
- [N] khách cần follow
- [tên]: chờ [N] ngày -- [chủ đề]

CẢNH BÁO
- [nội dung: nợ quá hạn, khách chưa phản hồi lâu]

VIỆC MAI
- [từ lịch hẹn + follow-up sắp hạn]
```

## Báo cáo tuần

CEO nói "tuần này thế nào" -> gọi `/api/report/daily` cho 7 ngày, tổng hợp:
`TỔNG QUAN: Thu [X] | Chi [Y] | Ròng [Z] | KHÁCH: Mới [N] | Follow-up tồn [N]`

## Quy tắc

- Số tiền: dấu chấm (5.000.000). Không bịa số -- không có data = nói không có
- Không mở đầu "Em xin báo cáo..." -- số liệu thẳng
- Thiếu data -> nói rõ thiếu gì: "Anh chưa ghi thu chi. Nhắn 'thu X chi Y' để em cập nhật."
- Tiếng Việt có dấu đầy đủ

## Cron tự động

CEO nói "báo cáo mỗi sáng" -> tạo cron agent mode. Đọc `skills/operations/cron-management.md`.
