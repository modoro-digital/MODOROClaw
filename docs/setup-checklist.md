# Checklist Thiết Lập MODOROClaw — Dành cho nhân viên MODORO

## Chuẩn bị (trước khi gặp CEO)

- [ ] Tạo VPS trên nhà cung cấp Việt Nam (Viettel IDC / FPT Cloud)
- [ ] Cài đặt OpenClaw trên VPS
- [ ] Clone MODOROClaw-Setup vào workspace OpenClaw
- [ ] Cài plugin Telegram: `openclaw plugins install @openclaw/telegram`
- [ ] Cài plugin Zalo: `openclaw plugins install @openclaw/zalo`

## Thu thập thông tin từ CEO

- [ ] Họ tên, tên gọi, cách xưng hô ưa thích
- [ ] Thành phố, múi giờ
- [ ] Tên công ty, lĩnh vực kinh doanh
- [ ] URL website đối thủ (1-5 URL)
- [ ] Giờ muốn nhận báo cáo sáng

## Tạo Telegram Bot

- [ ] Mở Telegram, tìm @BotFather
- [ ] Gửi `/newbot`, đặt tên bot (ví dụ: "Trợ Lý MODORO")
- [ ] Lưu Bot Token
- [ ] CEO gửi tin nhắn đầu tiên cho bot
- [ ] Lấy Chat ID của CEO (dùng `https://api.telegram.org/bot<TOKEN>/getUpdates`)
- [ ] Xác nhận bot phản hồi đúng CEO

## Kết nối Zalo OA (nếu CEO đã có)

- [ ] CEO đăng nhập Zalo OA tại https://oa.zalo.me
- [ ] Tạo ứng dụng tại https://developers.zalo.me
- [ ] Lấy OA Access Token
- [ ] Ghi nhận ngày hết hạn token
- [ ] Tạo webhook secret (8-256 ký tự)
- [ ] Cấu hình webhook URL: `https://<domain>/zalo/webhook`

## Chạy script thiết lập

```bash
cd /path/to/workspace
bash scripts/setup.sh
```

Script sẽ hỏi tất cả thông tin ở trên và tự ghi vào config.

## Kiểm tra sau thiết lập

- [ ] `openclaw start` — khởi động thành công
- [ ] Gửi tin nhắn test từ Telegram CEO → bot phản hồi
- [ ] Chạy thử báo cáo sáng: `openclaw run briefing --test`
- [ ] Nếu có Zalo: gửi tin test từ Zalo → hiện trên Telegram CEO
- [ ] Kiểm tra cron đã lên lịch: `openclaw cron list`

## Bàn giao cho CEO

- [ ] Xác nhận CEO nhận được tin test trên Telegram
- [ ] Hẹn CEO kiểm tra báo cáo sáng ngày mai
- [ ] Gửi hướng dẫn nhanh cho CEO (xem `docs/ceo-quick-guide.md`)
