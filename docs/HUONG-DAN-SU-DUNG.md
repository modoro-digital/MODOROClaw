---
pdf_options:
  format: A4
  margin: "28mm 24mm"
  printBackground: true
---

# 9BizClaw

Trợ lý AI tự động trả lời khách hàng trên Telegram và Zalo — được thiết kế riêng cho CEO doanh nghiệp vừa và nhỏ Việt Nam.

<div class="subtitle">Phiên bản 2.2 · 9Biz · modoro.vn</div>

---

## 1. Bot trả lời tự động

Bot hoạt động liên tục 24/7 trên hai kênh: **Telegram** (dùng để CEO kiểm soát bot) và **Zalo** (kênh khách hàng giao tiếp).

Khi khách nhắn tin, bot tự động đọc lịch sử hội thoại, đối chiếu với tài liệu doanh nghiệp đã upload, và trả lời bằng ngôn ngữ phù hợp với phong cách đã cài đặt.

**Bot có thể làm:**
- Trả lời câu hỏi về sản phẩm, dịch vụ, giá cả
- Hướng dẫn quy trình đặt hàng, thanh toán
- Xử lý khiếu nại đơn giản theo kịch bản có sẵn
- Ghi nhớ thông tin từng khách hàng Zalo qua các lần nhắn

**Bot không tự làm thay:**
- Xác nhận đơn hàng cuối cùng (cần CEO hoặc nhân viên duyệt)
- Chuyển tiền, thao tác trên hệ thống ngoài

---

## 2. Tủ tài liệu

Bot chỉ trả lời đúng khi có thông tin. Tủ tài liệu là nơi lưu toàn bộ kiến thức của doanh nghiệp để bot tham chiếu.

**Định dạng hỗ trợ:** PDF, Word (.docx), Excel (.xlsx), file văn bản (.txt)

**Phân loại mặc định:**

| Thư mục | Nên upload gì |
|---|---|
| Công ty | Giới thiệu công ty, chính sách, quy trình xử lý khiếu nại |
| Sản phẩm | Bảng giá, catalogue, thông số kỹ thuật, FAQ sản phẩm |
| Nhân viên | Thông tin nhóm chăm sóc khách hàng, phân công xử lý |

<div class="tip">Thực tế: Upload bảng giá và FAQ → bot sẽ trả lời được 70–80% câu hỏi thường gặp của khách mà không cần CEO can thiệp.</div>

Bot tự động cập nhật sau mỗi lần upload. Không cần khởi động lại.

---

## 3. Tính cách bot

CEO tùy chỉnh giọng điệu và phong cách giao tiếp của bot để phù hợp với thương hiệu doanh nghiệp.

**Có thể điều chỉnh:**
- **Bot tự xưng:** em (nữ/nam trẻ), chị (trung niên), anh (trung niên), mình (trung tính)
- **Gọi khách là:** anh/chị, quý khách, mình
- **Tính cách:** chọn 3–5 đặc điểm từ danh sách (ấm áp, chuyên nghiệp, thẳng thắn, kiên nhẫn, chủ động...)
- **Độ trang trọng:** thang 1–10, từ thân mật như bạn bè đến lễ tân khách sạn 5 sao
- **Câu chào riêng:** CEO tự soạn câu mở đầu cố định nếu muốn

<div class="note">Tính cách chỉ ảnh hưởng đến giọng văn và cách diễn đạt, không thay đổi nội dung thông tin bot trả lời.</div>

---

## 4. Kiểm soát kênh

### Tạm dừng và tiếp tục

Khi CEO muốn tự xử lý khách hàng trực tiếp mà không để bot can thiệp, có thể tạm dừng từng kênh riêng biệt.

- Bot ngừng nhận và trả lời tin nhắn khi đang tạm dừng
- Tạm dừng có giới hạn thời gian (tùy chọn) — tự động mở lại sau khoảng thời gian đã đặt
- Áp dụng độc lập cho Telegram và Zalo

### Trạng thái bot

Dashboard luôn hiển thị trạng thái thực tế của từng kênh:
- **Xanh:** Bot đang hoạt động, sẵn sàng nhận tin
- **Đỏ:** Kênh gặp vấn đề, cần kiểm tra

<div class="page-break"></div>

---

## 5. Quản lý Zalo

### Bạn bè và danh sách chặn

Bot chỉ phản hồi những người đã trong danh sách bạn bè Zalo của tài khoản được kết nối. CEO có thể:
- Xem danh sách bạn bè hiện tại
- Chặn người dùng cụ thể (bot sẽ bỏ qua tin nhắn từ người đó)

### Nhóm Zalo

Bot có thể tham gia và trả lời trong nhóm Zalo khi được mention. CEO cài đặt:
- Cho phép tất cả nhóm hoặc chỉ nhóm được chọn
- Tắt hoàn toàn tính năng nhóm nếu không cần

### Bộ nhớ khách hàng

Với mỗi khách hàng Zalo, bot tự động ghi lại lịch sử tóm tắt sau mỗi cuộc hội thoại. Lần sau khách nhắn lại, bot nhớ được bối cảnh — không bắt khách kể lại từ đầu.

CEO cũng có thể thêm ghi chú thủ công cho từng khách (thông tin đặc biệt, lưu ý cần nhớ).

---

## 6. Lịch và tự động hóa

### Báo cáo sáng tự động

Mỗi sáng vào giờ CEO đã đặt, bot tự động gửi bản tóm tắt hoạt động qua Telegram:
- Số tin nhắn nhận/đã trả lời
- Khách hàng mới
- Nội dung cần CEO chú ý

### Lịch tự động tùy chỉnh

CEO tạo các tác vụ tự động theo lịch, ví dụ:
- Gửi nhắc nhở nội bộ mỗi thứ Hai
- Tổng kết cuối tuần
- Nhắc gia hạn hợp đồng theo chu kỳ

Mỗi tác vụ có thể giao bot xử lý (phân tích, tóm tắt, soạn nội dung) rồi gửi kết quả về Telegram của CEO.

### Kết nối Google Calendar <span class="badge badge-soon">Sắp ra mắt</span>

Phiên bản tiếp theo sẽ tích hợp trực tiếp với Google Calendar:
- Bot đọc lịch hẹn của CEO để trả lời khách hỏi về thời gian trống
- Tự động tạo lịch hẹn khi khách xác nhận qua chat
- Nhắc lịch hẹn sắp đến qua Telegram

---

## 7. Bảng điều khiển (Dashboard)

Toàn bộ cài đặt và theo dõi được thực hiện qua Dashboard trên máy tính CEO.

**Tab Tổng quan:** Xem ngay trạng thái bot, hoạt động gần đây, và các mục cần chú ý trong ngày.

**Tab Telegram / Zalo:** Cài đặt từng kênh, kiểm tra kết nối, tạm dừng/tiếp tục.

**Tab Knowledge:** Quản lý tủ tài liệu — upload, xóa, tổ chức theo thư mục.

**Tab Lịch:** Xem và chỉnh lịch báo cáo sáng, thêm lịch tự động mới.

**Tab Cài đặt:** Điều chỉnh tính cách bot, thông tin doanh nghiệp.

---

## Câu hỏi thường gặp

**Bot không trả lời — phải làm gì?**
Mở Dashboard → kiểm tra dot màu ở sidebar. Nếu đỏ → tắt và mở lại ứng dụng. Nếu vẫn đỏ → liên hệ 9Biz hỗ trợ.

**Khách hỏi thông tin sai — sửa thế nào?**
Vào tab Knowledge → xóa file cũ → upload file đã cập nhật. Bot áp dụng ngay, không cần khởi động lại.

**Bot trả lời nhưng không đúng ý — chỉnh ở đâu?**
Vào tab Cài đặt → Tính cách nhân viên để điều chỉnh giọng điệu. Hoặc bổ sung thêm tài liệu hướng dẫn chi tiết hơn vào Knowledge.

**Muốn tự trả lời khách trong lúc đang demo — làm sao?**
Tab Telegram hoặc Zalo → nhấn "Tạm dừng". Nhớ bật lại sau khi xong.

---

<footer>9BizClaw · 9Biz · modoro.vn · Hỗ trợ qua Telegram: @modoro_support</footer>
