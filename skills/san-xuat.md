---
name: san-xuat
description: Kỹ năng chuyên ngành sản xuất — quản lý đơn hàng, nguyên liệu, kiểm soát chất lượng
metadata:
  version: 1.0.0
---

# Kỹ năng ngành: Sản xuất

## Nhắc nhở vận hành
- Nhắc CEO kiểm tra tiến độ đơn sản xuất mỗi sáng qua Telegram (cron)
- Nhắc đặt nguyên liệu trước 2-3 ngày theo lịch CEO đã thiết lập
- Nhắc lịch giao hàng cho khách trước 2 ngày — theo mốc CEO đã nhập
- Nhắc kiểm kê nguyên liệu định kỳ (hàng tuần hoặc 2 tuần/lần)
- Nhắc lịch bảo trì máy móc, tập huấn an toàn lao động, kiểm định thiết bị
- Nhắc đóng BHXH, gia hạn giấy phép, nộp thuế theo mốc CEO đặt

## Trả lời khách hàng Zalo
- Trả lời khách hỏi: sản phẩm, giá, thời gian sản xuất, MOQ — từ thông tin CEO đã cung cấp
- Tiếp nhận đơn hàng mới: ghi nhận chi tiết, báo CEO xác nhận năng lực sản xuất
- Cập nhật trạng thái đơn hàng cho khách khi CEO cung cấp tiến độ
- Ghi nhận khiếu nại chất lượng, chuyển CEO xử lý

## Soạn nội dung và báo cáo
- Soạn báo cáo sản xuất ngày khi CEO gửi số liệu: sản lượng đạt, lỗi, tỷ lệ hoàn thành
- Soạn báo cáo so sánh sản lượng thực tế vs kế hoạch từ dữ liệu CEO cung cấp
- Soạn checklist QC theo công đoạn khi CEO yêu cầu
- Soạn checklist an toàn lao động: bình chữa cháy, bảo hộ, lối thoát hiểm

## Ghi nhớ và theo dõi
- Ghi nhớ trạng thái từng đơn sản xuất: đang làm, xong, đã giao — khi CEO cập nhật
- Ghi nhớ thông tin nhà cung cấp nguyên liệu: giá, chất lượng, lịch sử giao hàng
- Ghi nhớ tỷ lệ lỗi, nguyên nhân sự cố để CEO tra cứu khi cần
- Nhớ lịch ca nhân viên, ai nghỉ phép, ai làm thêm giờ — từ thông tin CEO cung cấp

## Phân tích file CEO gửi
- Đọc file Excel sản lượng, tính tỷ lệ hoàn thành, tỷ lệ lỗi
- Đọc file Excel nguyên liệu nhập, so sánh giá với lần nhập trước
- Đọc file chấm công, tổng hợp giờ làm, phát hiện vượt quy định (200 giờ OT/năm)
- Tìm kiếm trong thư viện: tiêu chuẩn QC, hợp đồng khách, SOP sản xuất

## Ví dụ dùng API mới

**Nhập nguyên liệu:**
```
web_fetch url="http://127.0.0.1:20200/api/inventory/adjust" method=POST body="{\"sku\":\"NL-THEP-D10\",\"name\":\"Thép phi 10\",\"qty\":500,\"type\":\"in\",\"note\":\"NCC Hòa Phát, lô 2026-05\"}"
```

**Ghi đơn sản xuất:**
```
web_fetch url="http://127.0.0.1:20200/api/order/create" method=POST body="{\"customer\":\"Công ty Đại Phát\",\"items\":[{\"name\":\"Khung sắt loại A\",\"qty\":200,\"price\":150000}],\"note\":\"Giao trước 30/05\"}"
```

**Kiểm tra nguyên liệu dưới mức tối thiểu:**
```
web_fetch http://127.0.0.1:20200/api/inventory/alerts
```
