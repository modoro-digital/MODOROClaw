---
name: thuong-mai
description: Kỹ năng chuyên ngành thương mại và bán lẻ — quản lý tồn kho, đơn hàng, khuyến mãi
metadata:
  version: 1.0.0
---

# Kỹ năng ngành: Thương mại và Bán lẻ

## Nhắc nhở vận hành
- Nhắc CEO kiểm tra tồn kho theo lịch tuần (mỗi sáng thứ Hai qua Telegram)
- Nhắc đặt hàng nhà cung cấp theo lịch CEO đã thiết lập
- Nhắc các mốc khuyến mãi: Tết, 8/3, 30/4, Black Friday, 11/11, 12/12 — trước 2-3 tuần
- Nhắc đóng gói và gửi hàng cho đơn CEO báo trong ngày
- Nhắc thanh toán hóa đơn, nộp thuế, gia hạn dịch vụ theo mốc CEO đặt

## Trả lời khách hàng Zalo
- Trả lời khách hỏi giá, tình trạng còn hàng, chính sách bảo hành — từ thông tin CEO đã cung cấp
- Tiếp nhận đơn hàng qua Zalo: ghi nhận sản phẩm, số lượng, địa chỉ giao, báo CEO xác nhận
- Xử lý yêu cầu đổi trả: hỏi lý do, hướng dẫn quy trình, chuyển CEO quyết định
- Gửi thông tin khuyến mãi đang chạy cho khách hỏi

## Soạn nội dung và báo cáo
- Soạn báo cáo doanh thu khi CEO gửi số liệu (tin nhắn hoặc file)
- Soạn mô tả sản phẩm cho đăng bán online khi CEO cung cấp thông tin
- Soạn tin nhắn khuyến mãi, thông báo sản phẩm mới cho CEO duyệt
- Soạn kế hoạch khuyến mãi theo mùa khi CEO yêu cầu
- Tóm tắt tình hình kinh doanh tuần/tháng từ dữ liệu CEO cung cấp

## Ghi nhớ và theo dõi
- Ghi nhớ danh sách nhà cung cấp: tên, SĐT, mặt hàng, giá gần nhất, đánh giá
- Ghi nhớ khách hàng thân thiết và sở thích mua sắm khi CEO cung cấp
- Ghi nhớ giá nhập từng đợt để CEO so sánh khi nhập lần sau
- Nhớ sản phẩm nào hay hết, sản phẩm nào bán chậm — từ dữ liệu CEO báo

## Phân tích file CEO gửi
- Đọc file Excel tồn kho, tìm sản phẩm sắp hết hoặc tồn đọng lâu
- Đọc file Excel doanh thu, tính tổng theo kênh bán, so sánh các kỳ
- Đọc báo giá nhà cung cấp (PDF/Excel), so sánh giá giữa các NCC
- Tìm kiếm thông tin trong thư viện: hợp đồng NCC, chính sách bảo hành, quy trình

## Ví dụ dùng API mới

**Ghi đơn hàng khách:**
```
web_fetch url="http://127.0.0.1:20200/api/order/create" method=POST body="{\"customer\":\"Chị Mai\",\"items\":[{\"name\":\"iPhone 15 Pro 256GB\",\"qty\":1,\"price\":25900000},{\"name\":\"Ốp lưng MagSafe\",\"qty\":1,\"price\":350000}],\"note\":\"Ship COD Q7\"}"
```

**Xuất kho:**
```
web_fetch url="http://127.0.0.1:20200/api/inventory/adjust" method=POST body="{\"sku\":\"IP15P-256\",\"qty\":1,\"type\":\"out\",\"note\":\"Bán cho Chị Mai\"}"
```

**Kiểm tra tồn kho toàn bộ:**
```
web_fetch http://127.0.0.1:20200/api/inventory/check
```
