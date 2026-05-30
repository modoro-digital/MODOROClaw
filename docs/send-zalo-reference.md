# Gửi Zalo từ Telegram — Tạm dừng

**Tính năng gửi Zalo trực tiếp từ Telegram hiện đang tạm dừng.**

## Thay thế

- **Gửi nhóm theo lịch:** Tạo cron một lần qua Telegram (xem AGENTS.md mục "Lịch tự động")
  - Ví dụ: "tạo cron gửi nhóm VIP lúc 14:00 hôm nay nội dung Chào buổi chiều"
  - Hệ thống dùng `oneTimeAt` — gửi đúng 1 lần rồi tự xóa
- **Gửi nhanh:** CEO dùng Zalo trực tiếp

## Lý do tạm dừng

Tool `exec` đã được gỡ khỏi danh sách tool cho lý do bảo mật (tránh RCE từ Zalo).
Chưa có tool thay thế an toàn để bot gửi Zalo ad-hoc từ Telegram.
