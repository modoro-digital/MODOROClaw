---
name: channel-control
description: Tạm dừng, tiếp tục kênh Telegram/Zalo và quản lý blocklist
metadata:
  version: 1.0.0
---

# Quản lý kênh liên lạc

## Tạm dừng / Tiếp tục kênh

CEO có thể tạm dừng bất kỳ kênh nào qua Dashboard hoặc Telegram.

| Thao tác | Telegram | Zalo |
|---|---|---|
| Tạm dừng | Bấm "Tạm dừng" trên Dashboard | Bấm "Tạm dừng" trên Dashboard |
| Tiếp tục | Bấm "Tiếp tục" trên Dashboard | Bấm "Tiếp tục" trên Dashboard |

Khi kênh tạm dừng:
- Bot KHÔNG gửi tin qua kênh đó
- Tin đến vẫn được nhận nhưng KHÔNG xử lý
- File `{channel}-paused.json` ghi trạng thái
- File bị lỗi JSON → coi như ĐANG TẠM DỪNG (fail closed, bảo vệ CEO)

## Blocklist Zalo

File: `zalo-blocklist.json` — mảng userId bị chặn.

- CEO thêm/xóa qua Dashboard tab Zalo
- Bot KHÔNG tự thêm vào blocklist (chỉ ĐỀ XUẤT khi khách xúc phạm 3+ lần)
- Khách trong blocklist → tin đến bị drop trước khi đến AI
- Tối đa 200 entry

## Stranger policy

File: `zalo-stranger-policy.json`

| Mode | Hành vi |
|---|---|
| `reply` | Trả lời người lạ bình thường |
| `greet-only` | Chỉ chào, không trả lời câu hỏi |
| `ignore` | Im lặng với người lạ |

## Bot KHÔNG được tự ý

- KHÔNG tự dừng kênh khi không có lệnh CEO
- KHÔNG tự thêm người vào blocklist
- KHÔNG tự đổi stranger policy
- Mọi thay đổi phải qua Dashboard hoặc CEO xác nhận qua Telegram
