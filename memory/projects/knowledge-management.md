# Công Cụ Quản Lý Tri Thức

## Trạng Thái
Đang phát triển

## Bắt Đầu
2026-02-15

## Tổng Quan
Xây dựng hệ thống quản lý tri thức cá nhân với kết nối thông minh giữa các ghi chú nhờ AI. Tương tự Obsidian nhưng có liên kết ngữ nghĩa tự động và tổ chức hỗ trợ bởi AI.

## Mục Tiêu

1. **Thu thập**: Ghi chú dễ dàng từ mọi thiết bị
2. **Kết nối**: Tự động phát hiện ghi chú liên quan
3. **Hiển thị**: AI giúp tìm ghi chú phù hợp khi cần
4. **Mở rộng**: Hệ thống plugin cho workflow tuỳ chỉnh

## Công Nghệ

- **Backend**: Python, FastAPI, PostgreSQL
- **Frontend**: React, TypeScript, Tailwind
- **AI**: OpenAI API cho embeddings và completions
- **Tìm kiếm**: pgvector cho tương đồng ngữ nghĩa
- **Hosting**: Ưu tiên cục bộ, tuỳ chọn đồng bộ cloud

## Tiến Độ Hiện Tại

### Hoàn thành
- [x] Thiết lập FastAPI server cơ bản
- [x] Thiết kế schema cơ sở dữ liệu
- [x] API CRUD cho ghi chú
- [x] Frontend React đơn giản
- [x] Tích hợp OpenAI embedding

### Đang thực hiện
- [ ] Endpoint tìm kiếm ngữ nghĩa
- [ ] Phát hiện ghi chú liên quan
- [ ] Trình soạn thảo ghi chú frontend
- [ ] Nhập dữ liệu từ Obsidian

### Backlog
- [ ] Ứng dụng di động
- [ ] Hệ thống plugin
- [ ] Tính năng cộng tác
- [ ] Đồng bộ cloud

## Quyết Định

**2026-02-20**: Chọn PostgreSQL + pgvector thay vì vector DB chuyên dụng
- Lý do: Ít dịch vụ cần quản lý hơn
- Đánh đổi: Có thể gặp giới hạn mở rộng sau này

**2026-03-01**: Quyết định kiến trúc ưu tiên cục bộ (local-first)
- Lý do: Bảo mật cho ghi chú cá nhân
- Đánh đổi: Đồng bộ khó triển khai hơn

## Trở Ngại

Hiện không có

## Hành Động Tiếp Theo

1. Hoàn thành endpoint tìm kiếm ngữ nghĩa (tuần này)
2. Xây dựng trình soạn thảo ghi chú với hỗ trợ markdown
3. Thêm hệ thống tag cho tổ chức thủ công
4. Triển khai MVP cho sử dụng cá nhân

## Tài Liệu Tham Khảo

- Công cụ tương tự: Obsidian, Roam Research, Notion
- Nguồn cảm hứng: Ghi chú của Andy Matuschak, phương pháp Zettelkasten
- Tham khảo kỹ thuật: Tài liệu OpenAI embedding, tài liệu pgvector

---

*Cập nhật lần cuối: [YYYY-MM-DD]*
