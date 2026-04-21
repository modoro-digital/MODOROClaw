# Google Form — "MODOROClaw — Đăng ký cài đặt trợ lý AI"

Tạo form này trên Google Forms. Team MODORO dùng để thu thập thông tin khách hàng đã mua, lên lịch remote cài đặt qua TeamViewer (1-2 tiếng).

---

## Fields

### 1. Họ tên
- Loại: Short text
- Bắt buộc: Yes

### 2. Tên công ty
- Loại: Short text
- Bắt buộc: Yes

### 3. Số điện thoại / Zalo
- Loại: Short text
- Bắt buộc: Yes
- Validation: số điện thoại

### 4. Telegram (username hoặc số điện thoại)
- Loại: Short text
- Bắt buộc: Yes
- Ghi chú: "Để gửi bot link trước ngày cài. Ví dụ: @username hoặc 0901234567"

### 5. Email công ty
- Loại: Email
- Bắt buộc: Yes

### 6. Website công ty (nếu có)
- Loại: URL
- Bắt buộc: No

### 7. Lĩnh vực
- Loại: Dropdown
- Bắt buộc: Yes
- Options:
  - Bất động sản
  - F&B / Nhà hàng / Quán cà phê
  - Thương mại / Bán lẻ
  - Dịch vụ (spa, salon, phòng khám...)
  - Giáo dục / Đào tạo
  - Công nghệ / IT
  - Sản xuất
  - Khác (ghi rõ)
- Logic: Khi chọn "Khác (ghi rõ)" → hiện thêm field text "Ghi rõ lĩnh vực"

### 8. Bạn muốn trợ lý làm gì?
- Loại: Checkbox (chọn nhiều)
- Bắt buộc: Yes (chọn ít nhất 1)
- Options:
  - Trả lời tin nhắn Zalo khách hàng
  - Chăm sóc nhóm Zalo
  - Quản lý Google Calendar (sắp có)
  - Đọc & tóm tắt email Gmail (sắp có)
  - Báo cáo sáng hàng ngày qua Telegram
  - Đăng bài Facebook Fanpage (sắp có)
  - Soạn nội dung marketing
  - Cập nhật tin tức ngành hàng ngày
  - Khác (ghi rõ)

### 9. Bạn đã có máy tính chưa?
- Loại: Radio
- Bắt buộc: Yes
- Options:
  - Đã có
  - Chưa có, cần MODORO hỗ trợ mua

### 10. Chọn ngày cài đặt
- Loại: Date picker
- Bắt buộc: Yes
- Min date: 10/04/2026 (cập nhật mỗi đợt bán mới)

### 11. Khung giờ mong muốn
- Loại: Dropdown
- Bắt buộc: Yes
- Options:
  - Sáng (9h - 12h)
  - Chiều (13h - 17h)
  - Tối (19h - 21h)

### 12. Ghi chú thêm
- Loại: Long text
- Bắt buộc: No

### 13. Đồng ý xử lý dữ liệu
- Loại: Checkbox (1 option)
- Bắt buộc: Yes
- Text: "Tôi đồng ý cho MODORO xử lý thông tin cá nhân để cài đặt và hỗ trợ trợ lý AI (theo NĐ 13/2023/NĐ-CP)"

---

## Lưu ý khi tạo form

- Title: "MODOROClaw — Đăng ký cài đặt trợ lý AI"
- Description: "Vui lòng điền thông tin bên dưới để team MODORO lên lịch cài đặt trợ lý AI cho bạn. Thời gian cài đặt khoảng 1-2 tiếng qua remote (TeamViewer)."
- Confirmation message: "Cảm ơn bạn đã đăng ký! Team MODORO sẽ liên hệ qua Telegram/Zalo để xác nhận lịch cài đặt."
- Mặc định tất cả khách chưa cài. MODORO team remote cài qua TeamViewer.
- Form data chỉ cho MODORO staff sử dụng, không feed vào wizard tự động.
- Field 10 min date cần update mỗi đợt bán mới.
