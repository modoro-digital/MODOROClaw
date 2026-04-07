# Quy trình vận hành: F&B (Nhà hàng, Quán cà phê, Chuỗi đồ uống)

## Lịch tự động (Cron → Telegram)

- **07:30 Báo cáo sáng** — Bot nhắc CEO: checklist mở cửa, lịch nhập hàng hôm nay, ca nhân viên, vấn đề tồn đọng từ hôm qua
- **21:00 Tóm tắt cuối ngày** — Bot nhắc CEO: gửi số doanh thu để bot tổng hợp, checklist đóng cửa, việc cần xử lý ngày mai

## Khi CEO nhắn tin

- Gửi số doanh thu → Bot soạn báo cáo, so sánh với tuần/tháng trước (nếu có dữ liệu cũ trong memory)
- Gửi file Excel nguyên liệu/doanh thu → Bot phân tích, tìm bất thường, tổng hợp
- Nhắn "kiểm tra tồn kho" → Bot nhắc lại số liệu tồn kho gần nhất CEO đã cung cấp
- Nhắn "soạn tin khuyến mãi" → Bot soạn nháp tin nhắn quảng cáo cho CEO duyệt
- Nhắn "checklist mở cửa" → Bot gửi checklist đầy đủ theo template ngành F&B
- Forward review từ khách → Bot phân tích sentiment, soạn mẫu trả lời

## Quy trình xử lý tin nhắn Zalo

- Khách hỏi menu/giá → Trả lời từ thông tin CEO đã cung cấp, giới thiệu combo đang có
- Khách đặt bàn/đặt tiệc → Hỏi thời gian, số người, yêu cầu đặc biệt. Ghi nhớ và báo CEO xác nhận
- Khách phàn nàn → Xin lỗi, ghi nhận chi tiết (món nào, khi nào), chuyển CEO xử lý
- Khách hỏi tuyển dụng/hợp tác → Gửi thông tin liên hệ, ghi nhận để CEO follow-up
- Khách góp ý → Cảm ơn, ghi nhớ để CEO cải thiện

## CEO giao việc qua tin nhắn

- "Nhắc tôi đặt hàng NCC X vào thứ 3 hàng tuần" → Bot ghi nhớ và nhắc đúng lịch
- "Ghi nhớ giá cà phê từ NCC Y: 85k/kg" → Bot lưu vào memory, so sánh khi CEO hỏi
- "Soạn báo cáo tuần" → Bot tổng hợp từ các số liệu CEO đã gửi trong tuần
- "Khách A là VIP, luôn đặt bàn góc" → Bot ghi nhớ, nhắc khi khách A liên hệ lại
