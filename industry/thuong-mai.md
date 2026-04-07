# Quy trình vận hành: Thương mại và Bán lẻ

## Lịch tự động (Cron → Telegram)

- **07:30 Báo cáo sáng** — Bot nhắc CEO: đơn hàng cần xử lý, nhà cung cấp cần liên hệ, việc tồn đọng hôm qua
- **21:00 Tóm tắt cuối ngày** — Bot nhắc CEO: gửi doanh thu để tổng hợp, đơn hàng chưa gửi, việc cần xử lý ngày mai

## Khi CEO nhắn tin

- Gửi số doanh thu → Bot soạn báo cáo, so sánh với kỳ trước (nếu có dữ liệu trong memory)
- Gửi file Excel tồn kho → Bot phân tích: sản phẩm sắp hết, tồn đọng lâu, cần đặt thêm
- Gửi file báo giá NCC → Bot so sánh giá giữa các nhà cung cấp
- Nhắn "soạn tin khuyến mãi Black Friday" → Bot soạn nháp cho CEO duyệt
- Nhắn "đơn hàng khách Minh: 5 áo size L, giao Q7" → Bot ghi nhớ, nhắc đóng gói

## Quy trình xử lý tin nhắn Zalo

- Khách hỏi giá/còn hàng → Trả lời từ thông tin CEO đã cung cấp
- Khách đặt hàng → Ghi nhận sản phẩm, số lượng, địa chỉ, báo CEO xác nhận
- Khách hỏi đổi trả → Hướng dẫn quy trình, ghi nhận lý do, chuyển CEO quyết định
- Khách hỏi bảo hành → Trả lời chính sách từ tài liệu CEO cung cấp
- Khách hỏi khuyến mãi → Gửi thông tin chương trình đang chạy

## CEO giao việc qua tin nhắn

- "Ghi nhớ: NCC Hòa Phát, anh Tuấn 0912xxx, giá thép 15.5k/kg" → Bot lưu memory
- "Nhắc tôi đặt hàng NCC mỗi thứ 2 và thứ 5" → Bot nhắc đúng lịch
- "Soạn báo cáo tồn kho tuần" → Bot tổng hợp từ dữ liệu CEO đã gửi
- "Nhắc các mốc khuyến mãi 11/11 trước 3 tuần" → Bot nhắc từ 21/10
