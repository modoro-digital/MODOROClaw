# Quy trình vận hành: Sản xuất

## Lịch tự động (Cron → Telegram)

- **07:30 Báo cáo sáng** — Bot nhắc CEO: đơn sản xuất đang chạy, nguyên liệu cần kiểm tra, lịch giao hàng hôm nay
- **21:00 Tóm tắt cuối ngày** — Bot nhắc CEO: gửi sản lượng để tổng hợp, sự cố trong ngày, kế hoạch ngày mai

## Khi CEO nhắn tin

- Gửi số sản lượng cuối ca → Bot soạn báo cáo: đạt vs kế hoạch, tỷ lệ lỗi, so sánh các ngày
- Gửi file Excel nguyên liệu nhập → Bot tổng hợp, so sánh giá với lần nhập trước
- Nhắn "checklist QC" → Bot gửi checklist kiểm tra chất lượng theo công đoạn
- Nhắn "checklist an toàn lao động" → Bot gửi danh sách kiểm tra: bình cứu hỏa, bảo hộ, lối thoát hiểm
- Gửi file chấm công → Bot tổng hợp giờ làm, OT, phát hiện vượt quy định 200 giờ/năm

## Quy trình xử lý tin nhắn Zalo

- Khách hỏi sản phẩm/báo giá → Trả lời từ thông tin CEO đã cung cấp (giá, MOQ, thời gian SX)
- Khách đặt đơn mới → Ghi nhận chi tiết (sản phẩm, số lượng, thời hạn), báo CEO xác nhận
- Khách hỏi tiến độ đơn → Trả lời từ trạng thái CEO đã cập nhật trong memory
- Khách khiếu nại chất lượng → Ghi nhận chi tiết, chuyển CEO xử lý

## CEO giao việc qua tin nhắn

- "Ghi nhớ: đơn #125 cho Công ty Thành Đạt, giao 20/5, 5000 hộp" → Bot lưu, nhắc trước 2 ngày
- "Nhắc kiểm kê nguyên liệu thứ 6 hàng tuần" → Bot nhắc đúng lịch
- "NCC Kim Phát: giá nhựa PP 25k/kg, tăng 8% so với tháng trước" → Bot ghi nhớ, cảnh báo biến động
- "Soạn báo cáo sản xuất tuần" → Bot tổng hợp từ số liệu CEO đã gửi trong tuần
