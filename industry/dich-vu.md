# Quy trình vận hành: Dịch vụ (Spa, Salon, Phòng khám, Thẩm mỹ viện)

## Lịch tự động (Cron → Telegram)

- **07:30 Báo cáo sáng** — Bot nhắc CEO: lịch hẹn hôm nay, khách cần nhắc tái sử dụng, vật tư cần kiểm tra
- **21:00 Tóm tắt cuối ngày** — Bot nhắc CEO: gửi doanh thu để tổng hợp, feedback khách trong ngày, việc ngày mai

## Khi CEO nhắn tin

- Gửi doanh thu ngày → Bot soạn báo cáo chia theo dịch vụ, nhân viên (nếu CEO cung cấp chi tiết)
- Nhắn "soạn tin nhắc khách tái khám" → Bot soạn mẫu nhắn nhở phù hợp dịch vụ
- Nhắn "khách Hoa đến lần 5, spa mặt" → Bot ghi nhớ, đánh dấu khách thân thiết
- Gửi file Excel chấm công → Bot tổng hợp giờ làm, tính hoa hồng nếu có công thức
- Nhắn "checklist vệ sinh phòng" → Bot gửi checklist theo tiêu chuẩn ngành

## Quy trình xử lý tin nhắn Zalo

- Khách hỏi bảng giá → Gửi bảng giá dịch vụ từ tài liệu CEO cung cấp
- Khách đặt lịch hẹn → Hỏi dịch vụ, ngày giờ mong muốn, ghi nhớ và báo CEO xác nhận
- Khách hỏi combo/ưu đãi → Gửi thông tin chương trình đang chạy
- Khách phàn nàn → Xin lỗi, ghi nhận chi tiết (dịch vụ, nhân viên, thời gian), chuyển CEO
- Khách hỏi liệu trình → Tư vấn từ thông tin CEO đã cung cấp

## CEO giao việc qua tin nhắn

- "Ghi nhớ: khách Lan dị ứng tinh dầu bạc hà" → Bot lưu, nhắc khi khách Lan liên hệ lại
- "Nhắc tôi liên hệ 10 khách lâu không quay lại" → Bot lọc từ memory, gửi danh sách
- "Soạn tin nhắn ưu đãi sinh nhật cho khách tháng 5" → Bot soạn nháp, CEO duyệt
- "Nhắc gia hạn chứng chỉ bác sĩ Minh ngày 15/6" → Bot nhắc trước 30 ngày và đúng ngày
