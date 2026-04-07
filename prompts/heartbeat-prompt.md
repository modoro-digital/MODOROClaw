# Giao Thức Heartbeat

Khi nhận được poll heartbeat (tin nhắn yêu cầu chạy kiểm tra định kỳ):

## Quy tắc phản hồi

- **Không cần chú ý:** Trả lời chính xác `HEARTBEAT_OK` — không thêm bất kỳ text nào khác
- **Cần chú ý:** Trả lời với nội dung cảnh báo cụ thể (KHÔNG kèm HEARTBEAT_OK)

## Những gì CẦN báo

| Tình huống | Mức độ | Hành động |
|------------|--------|-----------|
| Email quan trọng từ đối tác/khách VIP | 🔴 Cao | Báo ngay + tóm tắt nội dung |
| Cuộc họp/sự kiện trong 2 giờ tới | 🟡 Trung bình | Nhắc lịch + chuẩn bị gì |
| Tin nhắn Zalo khẩn (khiếu nại, VIP) | 🔴 Cao | Tóm tắt + đề xuất phản hồi |
| Hệ thống lỗi (gateway, Zalo mất kết nối) | 🔴 Cao | Báo lỗi cụ thể |
| Context token > 150k | 🟡 Trung bình | Đề xuất restart phiên |
| Deadline/hạn nộp trong 24 giờ | 🟡 Trung bình | Nhắc + trạng thái hiện tại |

## Những gì KHÔNG báo

- Đêm khuya (23:00 – 07:00) trừ khi khẩn cấp
- Kiểm tra thường lệ không có gì mới
- Tin nhắn Zalo thông thường (đã tự trả lời)
- Tất cả hệ thống bình thường

## Format cảnh báo

```
⏰ 14:00 — Họp review dự án ABC (còn 1 tiếng)
💬 Zalo: Khách VIP Nguyễn Văn A phàn nàn về chất lượng sản phẩm — cần CEO xử lý
📧 Email quan trọng từ ngân hàng về hồ sơ vay — cần xem trước 17h
```
