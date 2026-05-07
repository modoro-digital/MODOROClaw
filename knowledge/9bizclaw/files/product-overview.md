# 9BizClaw — Trợ lý AI cho doanh nghiệp

9BizClaw là ứng dụng desktop (Windows + Mac) giúp chủ doanh nghiệp vừa và nhỏ tự động hóa chăm sóc khách hàng qua Zalo và quản lý công việc qua Telegram. Không cần kiến thức kỹ thuật, chỉ cần cài đặt và chạy.

## Hai kênh, hai vai trò

### Zalo — Kênh khách hàng
- Bot tự động trả lời khách hàng 24/7 bằng tiếng Việt tự nhiên
- Trả lời dựa trên tài liệu Knowledge (sản phẩm, giá, chính sách) — không bịa thông tin
- Nhận diện chủ doanh nghiệp (không trả lời chính chủ như khách)
- Hỗ trợ cả tin nhắn riêng lẫn nhóm Zalo
- Bộ lọc bảo vệ: không để lọt thông tin kỹ thuật, API key, đường dẫn file ra ngoài
- Chặn tin rác: danh sách chặn, lọc tin nhắn hệ thống, chống bot-vs-bot loop

### Telegram — Kênh quản lý (chỉ CEO)
- Nhận báo cáo tự động: tin nhắn Zalo, hoạt động khách, cảnh báo
- Ra lệnh bằng tiếng Việt: "tóm tắt Zalo hôm nay", "tạm dừng Zalo 30 phút"
- Tạo lịch tự động (cron) bằng cách nhắn tin: "Mỗi sáng 7:30, gửi cho anh/chị tóm tắt Zalo hôm qua"
- Gửi tin nhóm Zalo từ Telegram: "gửi nhóm Sale: nhớ cập nhật báo cáo tuần"
- Bot phân tích xu hướng, gợi ý chiến lược, cảnh báo rủi ro

## Lịch tự động (Cron)

Hệ thống cron cho phép đặt lịch để bot tự làm việc định kỳ:

### Tạo cron
- Nhắn Telegram cho bot bằng tiếng Việt tự nhiên
- Ví dụ: "Mỗi sáng 7:30 gửi cho tôi tóm tắt tin Zalo hôm qua"
- Ví dụ: "Mỗi thứ 2 đầu tuần, nhắc nhóm Sale cập nhật số liệu"
- Ví dụ: "Mỗi tối 18:00 tổng kết hoạt động hôm nay"
- Bot xác nhận lịch, bắt đầu chạy tự động
- Hỗ trợ cron expression (*/5 * * * *) hoặc tiếng Việt ("mỗi 30 phút", "mỗi ngày lúc 9:00")

### Quản lý cron
- Xem danh sách cron trên Dashboard tab Lịch
- Bật/tắt từng cron
- Xóa cron
- Test thử cron (chạy 1 lần ngay lập tức)
- Cron gửi kết quả qua Telegram và/hoặc nhóm Zalo

### An toàn
- Cron chỉ tạo được qua Telegram (CEO) — khách Zalo không thể tạo cron
- Mỗi cron chạy qua agent AI, không phải gửi text thô
- Retry tự động khi lỗi tạm thời (3 lần)
- Ghi log mỗi lần chạy vào cron-runs.jsonl
- Thất bại liên tiếp → alert CEO qua cả Telegram + Zalo

## Knowledge — Tài liệu doanh nghiệp

Bot đọc và nhớ nội dung tài liệu. Khi khách hỏi, bot tìm trong Knowledge để trả lời chính xác.

### 4 thư mục tài liệu
- **cong-ty**: Thông tin công ty (giờ mở cửa, địa chỉ, hotline, chính sách)
- **san-pham**: Bảng giá, thông số sản phẩm, khuyến mãi, tồn kho
- **nhan-vien**: Danh sách nhân viên, vai trò, liên hệ
- **9bizclaw**: Tài liệu về bản thân hệ thống (file này)

### Quyền truy cập tài liệu
- **Công khai (public)**: Khách hàng và nhân viên đều xem được
- **Chỉ nhân viên (staff)**: Chỉ nhân viên nội bộ
- **Chỉ CEO (ceo)**: Chỉ chủ doanh nghiệp trên Telegram

## Cá nhân hóa

### Persona Mix — Tính cách bot
- Chọn giọng xưng hô: Em (nữ trẻ), Em (nam trẻ), Chị, Anh, Mình (trung tính)
- Chọn tính cách (3-5 đặc điểm): sáng tạo, thực tế, linh hoạt, chu đáo, kiên nhẫn...
- Điều chỉnh độ trang trọng (thân mật ↔ trang trọng)
- Câu chào và câu kết riêng
- Preview reply trước khi lưu

### Tình trạng hôm nay (Shop State)
- Cập nhật nhanh: hết hàng, thiếu nhân viên, chậm giao hàng, khuyến mãi đang chạy
- Bot tự biết và thông báo cho khách khi liên quan

## Tạm dừng & Tiếp quản

Khi chủ muốn tự trả lời khách:
- **Dashboard**: Nút "Tạm dừng" — bot im hoàn toàn
- **Trong Zalo**: Gõ /tamdung — bot im cho cuộc chat đó (1 tiếng tự hết)
- **Gõ /tieptuc**: Bot hoạt động lại

## Lịch hẹn

- Quản lý lịch hẹn khách hàng trực tiếp trên Dashboard
- Hoặc nhắn Telegram: "thêm lịch mai 3pm họp anh Minh"
- Bot tự tạo lịch và nhắc

## Bảo mật

- Bộ lọc output 19 pattern: không để lọt file path, API key, dữ liệu cấu hình
- Danh sách chặn Zalo: chặn theo user, bot hoàn toàn bỏ qua
- Chống prompt injection: từ chối lệnh admin từ Zalo
- Khách Zalo không thể tạo cron, gửi broadcast, hoặc thực thi lệnh hệ thống
- PIN Dashboard (tùy chọn): bảo vệ truy cập Dashboard
- Export/import workspace: sao lưu và khôi phục toàn bộ dữ liệu

## Cài đặt

- Tải file cài đặt (.exe cho Windows, .dmg cho Mac)
- Chạy wizard 6 bước: nhập tên → chọn ngành → kết nối AI → kết nối Telegram → kết nối Zalo (tùy chọn) → hoàn tất
- Không cần cài thêm Node.js, npm, hay bất kỳ phần mềm nào
- Tự động cập nhật khi có bản mới

## Hỗ trợ

- Website: 9bizclaw.com
- Phát triển bởi 9Biz
