---
name: giao-duc
description: Kỹ năng chuyên ngành giáo dục và đào tạo — quản lý học viên, lịch học, tuyển sinh
metadata:
  version: 1.0.0
---

# Kỹ năng ngành: Giáo dục và Đào tạo

## Nhắc nhở vận hành
- Nhắc CEO/quản lý về lịch học ngày mai qua Telegram (theo lịch cron)
- Nhắc deadline nộp bài, lịch kiểm tra trước 2 ngày — theo mốc CEO đã nhập
- Nhắc lịch đánh giá giáo viên, họp phụ huynh, sự kiện tốt nghiệp
- Nhắc mùa tuyển sinh (tháng 5, 9, 1) trước 3 tuần để chuẩn bị nội dung
- Nhắc CEO thu học phí các lớp sắp đến hạn

## Trả lời khách hàng Zalo
- Trả lời phụ huynh/học viên hỏi: lịch học, học phí, chương trình — từ thông tin CEO đã cung cấp
- Tiếp nhận đăng ký khóa mới: ghi nhận tên, SĐT, khóa quan tâm, báo CEO
- Trả lời câu hỏi về chính sách: bảo lưu, hoàn phí, chuyển lớp
- Gửi thông báo lịch nghỉ lễ, thay đổi lịch học khi CEO yêu cầu

## Soạn nội dung và báo cáo
- Soạn thông báo gửi phụ huynh/học viên: thay đổi lịch, sự kiện, nhắc học phí
- Soạn nội dung tuyển sinh: bài đăng mạng xã hội, tin nhắn Zalo cho CEO duyệt
- Soạn báo cáo tiến độ lớp học khi CEO cung cấp dữ liệu: số buổi, tỷ lệ hoàn thành
- Soạn tin nhắn Zalo thông báo kết quả học tập cho phụ huynh

## Ghi nhớ và theo dõi
- Ghi nhớ thông tin học viên: tên, lớp, tiến độ, phụ huynh liên hệ — khi CEO cung cấp
- Ghi nhớ lịch học từng lớp, giáo viên phụ trách
- Ghi nhớ học viên nợ học phí, học viên sắp hết khóa để nhắc CEO
- Nhớ phản hồi của học viên/phụ huynh về chất lượng giảng dạy

## Phân tích file CEO gửi
- Đọc file Excel điểm số/chấm công, tổng hợp tiến độ học viên
- Đọc file danh sách học viên, phân tích ai cần liên hệ (nợ phí, vắng nhiều)
- Đọc file doanh thu học phí, tính tổng theo khóa/tháng
- Tìm kiếm trong thư viện: giáo trình, đề thi mẫu, quy chế

## Ví dụ dùng API mới

**Ghi đơn đăng ký khóa học:**
```
web_fetch url="http://127.0.0.1:20200/api/order/create" method=POST body="{\"customer\":\"Phụ huynh Nguyễn Văn A\",\"items\":[{\"name\":\"Khóa IELTS 3 tháng\",\"qty\":1,\"price\":8000000}],\"note\":\"Học viên: Nguyễn B, bắt đầu 01/06\"}"
```

**Ghi nghỉ phép giáo viên:**
```
web_fetch url="http://127.0.0.1:20200/api/leave/request" method=POST body="{\"employee\":\"Cô Hương\",\"type\":\"sick\",\"from\":\"2026-05-20\",\"to\":\"2026-05-20\",\"note\":\"Nghỉ ốm, cần tìm giáo viên thay\"}"
```

**Xem tổng thu học phí tháng:**
```
web_fetch http://127.0.0.1:20200/api/order/summary?from=2026-05-01&to=2026-05-31
```
