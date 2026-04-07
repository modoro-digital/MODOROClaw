# Quy trình vận hành: Công nghệ và IT

## Lịch tự động (Cron → Telegram)

- **07:30 Báo cáo sáng** — Bot nhắc CEO: deadline sprint, task tồn đọng, lịch họp hôm nay
- **21:00 Tóm tắt cuối ngày** — Bot nhắc CEO: kết quả hôm nay, blocker cần xử lý, kế hoạch ngày mai

## Khi CEO nhắn tin

- Nhắn nội dung standup → Bot tổng hợp thành bullet points, lưu memory
- Nhắn "soạn release notes v2.1" → Bot soạn từ danh sách tính năng CEO mô tả
- Gửi file Excel danh sách task → Bot phân tích: task quá hạn, task chưa assign, tỷ lệ hoàn thành
- Nhắn "tóm tắt cuộc họp hôm nay" → Bot soạn summary từ notes CEO gửi
- Nhắn "soạn email thông báo bảo trì" → Bot soạn nháp cho CEO duyệt

## Quy trình xử lý tin nhắn Zalo

- Khách hỏi tính năng sản phẩm → Trả lời từ tài liệu CEO đã cung cấp
- Khách báo lỗi/yêu cầu hỗ trợ → Ghi nhận chi tiết, phân loại mức độ, báo CEO/team
- Khách hỏi bảng giá → Gửi bảng giá từ tài liệu, giải thích các gói dịch vụ
- Khách hỏi SLA/chính sách → Trả lời từ tài liệu, câu hỏi phức tạp chuyển CEO

## CEO giao việc qua tin nhắn

- "Ghi nhớ: khách ABC Corp sắp hết trial ngày 20/5" → Bot lưu, nhắc trước 3 ngày
- "Nhắc team deadline sprint thứ 6 này" → Bot nhắc trước 2 ngày
- "Soạn báo cáo tuần: ship 3 features, fix 8 bugs" → Bot soạn báo cáo từ dữ liệu
- "Nhắc gia hạn domain modoro.vn ngày 1/7" → Bot nhắc trước 30 ngày
