# Quy trình vận hành: Tổng quát (Áp dụng cho mọi ngành)

## Lịch tự động (Cron → Telegram)

- **07:30 Báo cáo sáng** — Bot nhắc CEO: task tồn đọng, lịch hẹn hôm nay, deadline sắp đến, vấn đề cần xử lý
- **21:00 Tóm tắt cuối ngày** — Bot nhắc CEO: việc đã xong hôm nay, việc cần xử lý ngày mai

## Khi CEO nhắn tin

- Gửi số doanh thu/chi phí → Bot soạn báo cáo, so sánh với kỳ trước
- Gửi file Excel/PDF → Bot đọc, tóm tắt, phân tích dữ liệu
- Nhắn "soạn email cho khách X" → Bot soạn nháp cho CEO duyệt
- Nhắn "tổng hợp tuần này" → Bot lấy từ memory các số liệu CEO đã gửi trong tuần
- Nhắn "lịch tuần" → Bot tổng hợp các lịch hẹn, deadline đã ghi nhớ
- Hỏi bất kỳ → Bot trả lời bằng kiến thức AI + thông tin CEO đã cung cấp trước đó

## Quy trình xử lý tin nhắn Zalo

- Khách hỏi thông tin → Trả lời từ tài liệu CEO đã cung cấp (sản phẩm, dịch vụ, giá, chính sách)
- Khách yêu cầu hỗ trợ → Ghi nhận chi tiết, báo CEO xử lý
- Khách phàn nàn → Xin lỗi, ghi nhận, chuyển CEO
- Không biết câu trả lời → Xin phép kiểm tra, báo CEO để phản hồi sau

## CEO giao việc qua tin nhắn

- "Nhắc tôi [việc gì] lúc [giờ/ngày]" → Bot nhắc đúng lịch
- "Ghi nhớ: [thông tin]" → Bot lưu vào memory, tra cứu khi cần
- "Soạn [nội dung]" → Bot soạn nháp, CEO duyệt
- "Tìm [thông tin] trong tài liệu" → Bot tìm kiếm trong thư viện FTS5
- "Báo cáo [chủ đề]" → Bot tổng hợp từ dữ liệu đã có
