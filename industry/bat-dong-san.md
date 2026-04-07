# Quy trình vận hành: Bất động sản

## Lịch tự động (Cron → Telegram)

- **07:30 Báo cáo sáng** — Bot nhắc CEO: lịch hẹn xem nhà hôm nay, khách cần follow-up, hợp đồng sắp đến hạn thanh toán
- **21:00 Tóm tắt cuối ngày** — Bot nhắc CEO: kết quả hôm nay, khách đã liên hệ, việc cần xử lý ngày mai

## Khi CEO nhắn tin

- Gửi thông tin khách mới → Bot ghi nhớ: tên, SĐT, nhu cầu, ngân sách, khu vực, phân loại nóng/ấm/lạnh
- Nhắn "danh sách khách chưa liên hệ" → Bot tổng hợp từ memory, nhắc khách quá 7 ngày
- Nhắn "soạn báo giá căn A-1205" → Bot soạn từ thông tin dự án CEO đã cung cấp
- Gửi file Excel danh sách khách → Bot phân tích, gợi ý khách cần ưu tiên
- Gửi file bảng giá dự án → Bot tóm tắt, so sánh các căn
- Nhắn "checklist giấy tờ công chứng" → Bot gửi danh sách đầy đủ: CCCD, sổ đỏ, hộ khẩu, ủy quyền...

## Quy trình xử lý tin nhắn Zalo

- Khách hỏi giá dự án → Gửi bảng giá từ tài liệu CEO cung cấp, kèm chính sách bán hàng
- Khách muốn xem nhà → Hỏi thời gian thuận tiện, ghi nhớ, báo CEO sắp xếp
- Khách hỏi pháp lý → Trả lời từ thông tin CEO đã cung cấp, câu hỏi phức tạp chuyển CEO
- Khách phàn nàn tiến độ → Ghi nhận, báo CEO xử lý
- Khách hỏi vay ngân hàng → Gửi thông tin đối tác ngân hàng CEO đã cung cấp
- Môi giới hỏi hợp tác → Ghi nhận thông tin, chuyển CEO quyết định

## CEO giao việc qua tin nhắn

- "Nhắc tôi gọi lại khách Lan 14h chiều nay" → Bot nhắc đúng giờ
- "Ghi nhớ: căn B-308 đã đặt cọc, khách Hùng, 2 tỷ" → Bot lưu và cập nhật trạng thái
- "Nhắc thanh toán đợt 2 dự án X ngày 15/5" → Bot nhắc trước 3 ngày và đúng ngày
- "Soạn tin follow-up cho khách đã xem nhà hôm nay" → Bot soạn nháp, CEO duyệt trước khi gửi
