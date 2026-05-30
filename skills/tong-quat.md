---
name: tong-quat
description: Kỹ năng tổng quát áp dụng cho mọi ngành — nhắc việc, trả lời khách, soạn báo cáo
metadata:
  version: 1.0.0
---

# Kỹ năng ngành: Tổng quát (Áp dụng cho mọi ngành)

## Nhắc nhở và lịch trình
- Nhắc CEO về task đang chờ xử lý mỗi sáng và đầu chiều qua Telegram (cron)
- Nhắc deadline quan trọng trước 3 ngày, 1 ngày, và ngày đến hạn — theo mốc CEO đã nhập
- Nhắc lịch họp, lịch hẹn trước 1 ngày
- Nhắc gia hạn giấy phép kinh doanh, hợp đồng, bảo hiểm trước 30 ngày
- Nhắc nộp thuế GTGT (ngày 20), thuế TNDN, các mốc quan trọng theo lịch CEO đặt
- Nhắc ngày lễ, sự kiện (Tết, 30/4, 2/9) trước 2 tuần để chuẩn bị

## Trả lời khách hàng Zalo
- Trả lời khách hỏi thông tin sản phẩm/dịch vụ — từ tài liệu CEO đã cung cấp
- Tiếp nhận yêu cầu khách: ghi nhận chi tiết, báo CEO xử lý
- Trả lời câu hỏi về chính sách: bảo hành, đổi trả, thanh toán
- Khi không biết câu trả lời: xin phép kiểm tra và phản hồi sau, báo CEO

## Soạn nội dung
- Soạn nháp email, tin nhắn gửi khách hàng/đối tác cho CEO duyệt
- Soạn tin nhắn thông báo nội bộ: chính sách mới, lịch nghỉ lễ, thay đổi quy trình
- Soạn nội dung quảng bá: bài đăng mạng xã hội, tin nhắn Zalo khi CEO yêu cầu
- Soạn mẫu báo giá, hợp đồng đơn giản khi CEO cung cấp thông số

## Báo cáo
- Soạn báo cáo doanh thu, chi phí khi CEO gửi số liệu (tin nhắn hoặc file)
- Tổng hợp KPI theo tuần/tháng từ dữ liệu CEO cung cấp
- Soạn báo cáo tóm tắt bán tuần (thứ Tư) và cuối tuần (thứ Sáu) khi CEO yêu cầu
- So sánh kết quả kinh doanh giữa các kỳ từ dữ liệu CEO gửi

## Ghi nhớ và theo dõi
- Ghi nhớ thông tin khách hàng, đối tác: tên, SĐT, lịch sử tương tác
- Ghi nhớ task đã giao cho nhân viên, nhắc khi gần đến hạn
- Ghi nhớ các quyết định quan trọng của CEO để tra cứu sau
- Nhớ công nợ khách hàng, nhà cung cấp — từ dữ liệu CEO cung cấp

## Phân tích file CEO gửi
- Đọc file Excel doanh thu/chi phí, tính tổng, so sánh, tìm bất thường
- Đọc hợp đồng PDF/Word, tóm tắt điều khoản quan trọng
- Đọc file nhân sự: danh sách nhân viên, chấm công, ngày phép
- Tìm kiếm trong thư viện tài liệu: hợp đồng, quy trình, mẫu văn bản

## Ví dụ dùng API mới

**Ghi đơn hàng:**
```
web_fetch url="http://127.0.0.1:20200/api/order/create" method=POST body="{\"customer\":\"Công ty XYZ\",\"items\":[{\"name\":\"Dịch vụ tư vấn\",\"qty\":1,\"price\":5000000}],\"note\":\"Hợp đồng 1 tháng\"}"
```

**Ghi nghỉ phép nhân viên:**
```
web_fetch url="http://127.0.0.1:20200/api/leave/request" method=POST body="{\"employee\":\"Linh\",\"type\":\"annual\",\"from\":\"2026-05-26\",\"to\":\"2026-05-27\",\"note\":\"Việc gia đình\"}"
```

**Báo cáo tổng hợp ngày:**
```
web_fetch url="http://127.0.0.1:20200/api/report/daily" method=POST body="{\"date\":\"2026-05-19\"}"
```
