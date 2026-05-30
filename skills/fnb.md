---
name: fnb
description: Kỹ năng chuyên ngành F&B — nhà hàng, quán cà phê, dịch vụ ăn uống
metadata:
  version: 1.0.0
---

# Kỹ năng ngành: F&B (Nhà hàng, Quán cà phê, Quán ăn)

## Nhắc nhở vận hành hàng ngày
- Gửi checklist mở cửa cho CEO mỗi sáng (qua Telegram theo lịch cron): vệ sinh, nguyên liệu, quầy thu ngân, đồng phục
- Gửi nhắc đóng cửa cuối ngày: đối chiếu doanh thu, tồn kho, vệ sinh bếp, tắt thiết bị
- Nhắc CEO kiểm tra lịch ca nhân viên mỗi tối trước ngày hôm sau
- Nhắc các mốc quan trọng: nộp thuế, gia hạn giấy phép, đóng BHXH

## Trả lời khách hàng Zalo
- Trả lời tự động khi khách hỏi: giờ mở cửa, menu, giá, vị trí quán
- Tiếp nhận đặt bàn qua Zalo OA: hỏi số người, giờ đến, ghi nhớ và xác nhận
- Khi khách khiếu nại trên Zalo: xin lỗi, ghi nhận vấn đề, chuyển cho CEO xử lý
- Khi khách hỏi tuyển dụng: gửi thông tin liên hệ phòng nhân sự

## Soạn nội dung và báo cáo
- Soạn mẫu báo cáo doanh thu ngày khi CEO gửi số liệu (tin nhắn hoặc file Excel)
- Soạn nháp tin nhắn khuyến mãi, thông báo đặc biệt để CEO duyệt trước khi gửi khách
- Soạn lịch trình khuyến mãi cho các dịp lễ (Tết, 8/3, Black Friday) khi CEO yêu cầu
- Soạn mẫu trả lời review tiêu cực/tích cực khi CEO gửi nội dung review

## Ghi nhớ và theo dõi
- Ghi nhớ thông tin nhà cung cấp, giá nhập hàng mà CEO báo qua tin nhắn
- Ghi nhớ khách VIP, sở thích đặc biệt của khách khi CEO cung cấp
- Ghi nhớ lịch nhập hàng định kỳ, nhắc CEO trước 1 ngày
- Nhớ các vấn đề đã xảy ra để không lặp lại (VD: nhà cung cấp X hay giao trễ)

## Phân tích file CEO gửi
- Đọc file Excel doanh thu, tính tổng, so sánh với tuần/tháng trước
- Đọc file bảng chấm công, tổng hợp giờ làm, phát hiện bất thường
- Đọc menu PDF/Word, tóm tắt danh sách món và giá
- Tìm kiếm thông tin trong thư viện tài liệu đã lưu (SOP, công thức, hợp đồng)

## Ví dụ dùng API mới

**Nhập nguyên liệu:**
```
web_fetch url="http://127.0.0.1:20200/api/inventory/adjust" method=POST body="{\"sku\":\"CF-ROBUSTA\",\"name\":\"Cà phê Robusta 1kg\",\"qty\":20,\"type\":\"in\",\"note\":\"Nhập từ NCC Tân Phú\"}"
```

**Ghi đơn đặt bàn:**
```
web_fetch url="http://127.0.0.1:20200/api/order/create" method=POST body="{\"customer\":\"Anh Hùng\",\"items\":[{\"name\":\"Bàn VIP 10 người\",\"qty\":1,\"price\":2000000}],\"note\":\"Tối 20/05 lúc 19h, sinh nhật\"}"
```

**Kiểm tra nguyên liệu sắp hết:**
```
web_fetch http://127.0.0.1:20200/api/inventory/alerts
```
