# Quy trình vận hành: Giáo dục và Đào tạo

## Lịch tự động (Cron → Telegram)

- **07:30 Báo cáo sáng** — Bot nhắc CEO: lịch học hôm nay, deadline bài tập sắp đến, học viên nợ học phí
- **21:00 Tóm tắt cuối ngày** — Bot nhắc CEO: buổi học đã xong, việc cần xử lý ngày mai

## Khi CEO nhắn tin

- Gửi file Excel điểm số → Bot tổng hợp, phát hiện học viên kết quả đi xuống
- Nhắn "soạn thông báo lịch nghỉ lễ 30/4" → Bot soạn nháp thông báo cho phụ huynh/học viên
- Nhắn "danh sách học viên nợ học phí" → Bot tổng hợp từ memory
- Gửi file danh sách lớp → Bot phân tích: sĩ số, tiến độ, ai vắng nhiều
- Nhắn "soạn bài tuyển sinh khóa mới" → Bot soạn nội dung quảng bá cho CEO duyệt

## Quy trình xử lý tin nhắn Zalo

- Phụ huynh/học viên hỏi lịch học → Trả lời từ thông tin CEO đã cung cấp
- Hỏi học phí, chương trình → Gửi thông tin chi tiết từ tài liệu
- Đăng ký khóa mới → Ghi nhận tên, SĐT, khóa quan tâm, báo CEO
- Hỏi chính sách bảo lưu/hoàn phí → Trả lời theo quy định CEO đã cung cấp
- Phàn nàn chất lượng → Ghi nhận chi tiết, chuyển CEO xử lý

## CEO giao việc qua tin nhắn

- "Ghi nhớ: lớp IELTS A bắt đầu 10/5, cô Hoa phụ trách, 15 học viên" → Bot lưu memory
- "Nhắc thu học phí lớp B trước ngày 15 hàng tháng" → Bot nhắc đúng lịch
- "Soạn email kết quả học tập gửi phụ huynh" → Bot soạn từ dữ liệu CEO cung cấp
- "Nhắc chuẩn bị nội dung tuyển sinh trước tháng 9" → Bot nhắc từ tháng 8
