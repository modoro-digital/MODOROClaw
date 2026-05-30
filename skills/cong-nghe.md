---
name: cong-nghe
description: Kỹ năng chuyên ngành công nghệ và IT — quản lý sprint, hỗ trợ khách hàng SaaS
metadata:
  version: 1.0.0
---

# Kỹ năng ngành: Công nghệ và IT

## Nhắc nhở vận hành
- Nhắc CEO về deadline sprint, release trước 2 ngày qua Telegram (cron)
- Nhắc lịch sprint planning, review, retrospective trước 1 ngày
- Nhắc gia hạn domain, SSL certificate, hosting trước 30 ngày — theo mốc CEO đã nhập
- Nhắc lịch bảo trì hệ thống định kỳ và thông báo khách hàng
- Nhắc lịch gia hạn hợp đồng khách hàng SaaS trước 30 ngày

## Trả lời khách hàng Zalo
- Trả lời khách hỏi về sản phẩm/dịch vụ: tính năng, giá, gói dịch vụ — từ tài liệu CEO đã cung cấp
- Tiếp nhận yêu cầu hỗ trợ kỹ thuật cơ bản, ghi nhận và chuyển cho team
- Trả lời câu hỏi về chính sách: SLA, bảo hành, thanh toán
- Ghi nhận feedback từ khách hàng, báo CEO

## Soạn nội dung và báo cáo
- Soạn tóm tắt standup/cuộc họp khi CEO gửi nội dung (tin nhắn hoặc note)
- Soạn release notes cho khách hàng khi CEO mô tả tính năng mới
- Soạn báo cáo tuần: số task done, bug fix, feature ship — từ dữ liệu CEO cung cấp
- Soạn email/tin nhắn thông báo bảo trì, cập nhật sản phẩm cho CEO duyệt
- Tóm tắt action items từ cuộc họp khi CEO gửi notes

## Ghi nhớ và theo dõi
- Ghi nhớ trạng thái khách hàng SaaS: đang trial, đang dùng, sắp hết hạn — khi CEO cập nhật
- Ghi nhớ danh sách task/blocker mà CEO báo để nhắc follow-up
- Ghi nhớ quyết định kỹ thuật quan trọng từ các cuộc họp
- Nhớ lịch sử incident, nguyên nhân, cách xử lý để tra cứu khi cần

## Phân tích file CEO gửi
- Đọc file Excel danh sách khách hàng/task, tổng hợp theo trạng thái
- Đọc tài liệu kỹ thuật (PDF/Word), tóm tắt điểm chính
- Đọc file báo cáo chi phí cloud, so sánh các tháng
- Tìm kiếm trong thư viện: tài liệu kỹ thuật, SOP deploy, hợp đồng khách

## Ví dụ dùng API mới

**Ghi đơn hàng SaaS mới:**
```
web_fetch url="http://127.0.0.1:20200/api/order/create" method=POST body="{\"customer\":\"Công ty ABC\",\"items\":[{\"name\":\"Gói Enterprise 12 tháng\",\"qty\":1,\"price\":120000000}],\"note\":\"Hợp đồng ký 20/05\"}"
```

**Xem tổng doanh thu tháng:**
```
web_fetch http://127.0.0.1:20200/api/order/summary?from=2026-05-01&to=2026-05-31
```

**Ghi nghỉ phép dev:**
```
web_fetch url="http://127.0.0.1:20200/api/leave/request" method=POST body="{\"employee\":\"Minh\",\"type\":\"annual\",\"from\":\"2026-05-26\",\"to\":\"2026-05-30\",\"note\":\"Nghỉ phép năm\"}"
```
