# Chuyển Đổi Microservices

## Trạng Thái
Giai đoạn lập kế hoạch

## Bắt Đầu
2026-03-01

## Tổng Quan
Dẫn dắt nỗ lực kỹ thuật chuyển ứng dụng nguyên khối (monolith) sang microservices. Đây là dự án 6 tháng ảnh hưởng toàn bộ đội ngũ kỹ thuật.

## Mục Tiêu

1. **Khả năng mở rộng**: Scale từng dịch vụ độc lập theo tải
2. **Triển khai**: Deploy thay đổi mà không rủi ro toàn hệ thống
3. **Quyền tự chủ đội ngũ**: Mỗi đội sở hữu toàn bộ dịch vụ của mình
4. **Tự do công nghệ**: Dùng công cụ phù hợp nhất cho từng dịch vụ

## Kiến Trúc Hiện Tại

- Django monolith đơn lẻ
- Cơ sở dữ liệu PostgreSQL
- Redis cho caching
- Triển khai trên AWS EC2

## Kiến Trúc Mục Tiêu

- 4-6 dịch vụ lõi (User, Content, Analytics, Notifications, v.v.)
- API Gateway cho định tuyến
- Event bus cho giao tiếp bất đồng bộ
- Mỗi dịch vụ: DB riêng, deployment riêng
- Kubernetes cho điều phối

## Quyết Định Cần Đưa Ra

1. **Ranh giới dịch vụ**: Chia monolith như thế nào?
2. **Quyền sở hữu dữ liệu**: Dịch vụ nào sở hữu dữ liệu nào?
3. **Giao tiếp**: REST vs gRPC vs events?
4. **Chiến lược di chuyển**: Big bang vs strangler fig?

## Timeline

- **Tháng 3**: Thiết kế kiến trúc, proof of concept
- **Tháng 4**: Tách dịch vụ đầu tiên (User service)
- **Tháng 5-6**: Di chuyển các dịch vụ lõi
- **Tháng 7**: Kiểm thử, tối ưu, dọn dẹp
- **Tháng 8**: Ngừng hoạt động monolith

## Rủi Ro

- **Độ phức tạp**: Đường cong học hỏi của đội ngũ
- **Nhất quán dữ liệu**: Giao dịch phân tán
- **Hiệu suất**: Chi phí mạng tăng
- **Rollback**: Nếu không hoạt động thì sao?

## Hành Động Tiếp Theo

1. Hoàn thành tài liệu đề xuất kiến trúc
2. Lên lịch họp đánh giá kiến trúc
3. Xây dựng proof of concept cho giao tiếp giữa dịch vụ
4. Lấy đồng thuận từ kỹ sư cấp cao

## Các Bên Liên Quan

- **Quản lý**: Cần timeline dự án, nhu cầu nguồn lực
- **Kỹ sư cấp cao**: Cần phê duyệt phương pháp kỹ thuật
- **Đội ngũ**: Cần đào tạo, tài liệu
- **Product**: Cần hiểu tác động lên roadmap

---

*Cập nhật lần cuối: [YYYY-MM-DD]*
