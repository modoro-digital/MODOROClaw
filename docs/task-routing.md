# Quy Tắc Phân Bổ Công Việc

## Khung ra quyết định

### Giữ cục bộ khi:
- Task đơn giản, nhanh (dưới 5 phút)
- Cần ngữ cảnh cá nhân (sở thích, lịch sử người dùng)
- Đang trò chuyện thời gian thực với người dùng
- Liên quan đến quyết định bảo mật
- Task cần sự phê duyệt của người dùng

### Uỷ quyền cho agent chuyên biệt khi:
- Cần tập trung sâu hơn 15 phút
- Task có thể phân tách rõ ràng
- Có thể chạy song song
- Agent chính cần duy trì khả năng phản hồi
- Công việc khá độc lập

## Bảng tra cứu nhanh

| Tình huống | Hành động |
|-----------|----------|
| "Nghiên cứu X cho tôi" | Tạo agent nghiên cứu |
| "Xây tính năng này" | Tạo agent lập trình |
| "Bạn nghĩ gì về..." | Giữ cục bộ (trò chuyện) |
| "Sửa bug này" | Giữ cục bộ nếu nhỏ, uỷ quyền nếu phức tạp |
| "Soạn email" | Giữ cục bộ |
| "Phân tích dữ liệu này" | Uỷ quyền cho agent nghiên cứu |
| "Review PR này" | Uỷ quyền hoặc giữ tuỳ kích thước |

## Checklist bàn giao
Trước khi uỷ quyền:
- [ ] Task được định nghĩa rõ ràng
- [ ] Tiêu chí thành công rõ ràng
- [ ] Ngữ cảnh cần thiết đã được ghi lại
- [ ] Format trả về đã được chỉ định
- [ ] Ngân sách thời gian/tính toán đã được đặt

## Nhận kết quả
Khi agent chuyên biệt trả về:
- [ ] Xác minh tính đầy đủ
- [ ] Kiểm tra với tiêu chí chấp nhận
- [ ] Tích hợp vào ngữ cảnh của bạn
- [ ] Báo cáo cho người dùng bằng giọng của bạn
- [ ] Không chỉ chuyển tiếp output thô
