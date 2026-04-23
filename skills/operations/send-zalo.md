---
name: send-zalo
description: CEO yêu cầu gửi tin Zalo cho khách hoặc nhóm từ Telegram
metadata:
  version: 2.0.0
---

# Gửi tin Zalo theo lệnh CEO — Tạm dừng

Tính năng gửi Zalo trực tiếp từ Telegram hiện đang tạm dừng vì tool `exec` đã bị gỡ.

## Thay thế cho gửi nhóm

Dùng cron một lần qua mục "Lịch tự động" trong AGENTS.md:

1. CEO nói: "gửi nhóm VIP lúc 14:00 hôm nay nội dung Chào buổi chiều"
2. Bot gọi `web_fetch http://127.0.0.1:20200/api/cron/list` lấy token + groupId
3. Confirm với CEO
4. Bot tạo cron `oneTimeAt` → gửi đúng 1 lần rồi tự xóa

## Gửi nhanh

CEO dùng Zalo trực tiếp — bot không có tool gửi ad-hoc an toàn.
