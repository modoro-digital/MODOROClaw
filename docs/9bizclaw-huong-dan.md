# 9BizClaw — Hướng Dẫn Sử Dụng

> Tài liệu dành cho CEO. Mọi thao tác đều qua Telegram — nhắn cho bot, bot xử lý.

---

## Bắt đầu nhanh

Sau khi cài xong, mở Telegram, tìm bot vừa tạo, nhắn bất kỳ. Bot trả lời trong 30-60 giây.

**3 điều nên làm đầu tiên:**

1. **Upload tài liệu** — Dashboard > tab Tài liệu > thư mục Sản phẩm > upload file bảng giá (PDF/Word/Excel). Bot sẽ dùng file này để trả lời khách Zalo.
2. **Thử gửi tin Zalo** — Telegram nhắn: "Nhắn Zalo cho [tên người]: Chào anh/chị". Bot tìm người, xác nhận, chờ reply "ok" rồi gửi.
3. **Tạo lịch tự động** — Telegram nhắn: "Tạo cron mỗi sáng 9h gửi nhóm [tên nhóm]: Chào buổi sáng!"

**App phải mở** để bot hoạt động. Thu nhỏ xuống tray được, nhưng không tắt. Mac đóng nắp = sleep = bot ngừng.

---

## 1. Trả lời khách Zalo tự động

Bot tự trả lời khách hàng trên Zalo dựa trên tài liệu đã upload.

| Khách hỏi | Bot trả lời |
|-----------|-------------|
| "Cho mình hỏi giá iPhone 15 Pro 256GB" | "Dạ iPhone 15 Pro 256GB hiện có giá 25.900.000 VND ạ." |
| "Bảo hành bao lâu vậy em?" | "Dạ sản phẩm bảo hành 12 tháng tại cửa hàng ạ." |
| "Giờ mở cửa mấy giờ?" | "Dạ cửa hàng mở cửa từ 8h đến 21h hàng ngày ạ." |
| "Giải giúm mình bài toán" | "Dạ em chỉ hỗ trợ sản phẩm và dịch vụ công ty thôi ạ." |
| [Gửi ảnh sản phẩm] "Cái này còn không?" | Bot nhận diện ảnh, tra cứu → trả lời giá và tình trạng |
| "Hàng giao sai, muốn gặp quản lý" | "Dạ để em báo sếp xử lý." → CEO nhận alert trên Telegram |

Nếu bot chưa biết: "Dạ cái này em chưa có thông tin chính thức ạ." rồi chuyển cho CEO.

**Trong nhóm Zalo:** 3 chế độ — @mention (chỉ reply khi tag), Mọi tin (reply tất cả), Tắt (im lặng). Cài trong Dashboard > Zalo.

---

## 2. Báo cáo

| Nhắn gì | Bot làm gì |
|---------|-----------|
| "Báo cáo hôm nay" | Tóm tắt: thu chi, khách mới, follow-up tồn, cron đã chạy |
| "Hôm nay thế nào?" | Giống trên |
| "Báo cáo tuần này" | Tổng hợp 7 ngày |

---

## 3. Gửi tin Zalo từ Telegram

Không cần mở Zalo. Nhắn qua Telegram, bot gửi giúp.

| Nhắn gì | Bot làm gì |
|---------|-----------|
| "Nhắn Zalo cho chị Lan: Em gửi báo giá qua email rồi ạ" | Tìm chị Lan → xác nhận tên → chờ reply "ok" → gửi |
| "Gửi nhóm NHÂN VIÊN: Họp 3h chiều nay" | Tìm nhóm → xác nhận → chờ "ok" → gửi |

Bot luôn xác nhận tên người/nhóm + nội dung trước. Chỉ gửi khi reply "ok" hoặc "gửi đi".

---

## 4. Lịch tự động (Cron)

### Tạo lịch

| Nhắn gì | Kết quả |
|---------|---------|
| "Tạo cron gửi nhóm KHÁCH VIP mỗi sáng 9h: Chào buổi sáng!" | Tin cố định, gửi mỗi ngày 9h |
| "Tạo cron mỗi sáng 8h tóm tắt tin tức ngành BĐS rồi gửi nhóm NHÂN VIÊN" | Bot tự tìm tin mới mỗi sáng → tóm tắt → gửi |
| "Tạo cron mỗi sáng tạo ảnh poster chào buổi sáng rồi gửi nhóm VIP" | Bot tạo ảnh AI mới mỗi sáng → gửi |
| "Tạo cron nhắc nhóm NHÂN VIÊN mỗi thứ 2 lúc 8h: Nhớ nộp báo cáo tuần" | Tin cố định, gửi mỗi thứ 2 |

### Quản lý lịch

| Nhắn gì | Kết quả |
|---------|---------|
| "Danh sách cron" | Liệt kê tất cả lịch đang có |
| "Xóa cron báo cáo sáng" | Xóa lịch |
| "Tắt cron theo dõi khách" | Tạm tắt, không xóa |
| "Bật cron theo dõi khách" | Bật lại |
| "Test cron báo cáo tối" | Chạy thử ngay |

**8 lịch có sẵn:** Báo cáo sáng (7:30), báo cáo tối (21:00), tổng kết tuần (T2 8:00), tổng kết tháng (ngày 1), follow-up Zalo (9:30), kiểm tra hệ thống (30 phút), dọn dẹp (1:00), dọn memory (CN 2:00). Tất cả bật/tắt được.

---

## 5. Tạo file & Tài liệu

| Nhắn gì | Kết quả |
|---------|---------|
| "Soạn báo giá cho Anh C: 2 iPhone 15 Pro x 25.900.000" | Tạo file Word → preview → OK → gửi |
| "Tạo Excel tổng hợp đơn hàng tuần" | Tạo file Excel |
| "Tạo slide giới thiệu công ty 5 trang" | Tạo PowerPoint |
| "Tạo JD tuyển nhân viên bán hàng" | Mô tả công việc + bài đăng + câu hỏi phỏng vấn |

---

## 6. Tạo ảnh AI

| Nhắn gì | Kết quả |
|---------|---------|
| "Tạo banner giảm giá 50% cuối tuần" | Tạo ảnh → gửi preview Telegram |
| "Tạo ảnh poster sản phẩm mới rồi gửi nhóm KHÁCH VIP" | Tạo → preview → OK → gửi vào nhóm Zalo |

Bot tự dùng logo, ảnh sản phẩm đã upload trong tab Tài sản hình ảnh (nếu có).

---

## 7. Chuỗi tự động (Workflow)

Kết hợp nhiều thao tác trong 1 câu. Bot tự tách bước, làm tuần tự.

| Nhắn gì | Bot tự làm |
|---------|-----------|
| "Tạo ảnh khuyến mãi rồi gửi nhóm KHÁCH VIP" | Tạo ảnh → preview → OK → gửi Zalo |
| "Kiểm tra tồn kho, lọc hàng sắp hết, tạo ảnh cảnh báo gửi nhóm Kho" | Check kho → filter → tạo ảnh → gửi nhóm |

Bot hỏi xác nhận kế hoạch trước khi bắt đầu. Nếu 1 bước lỗi → dừng + báo.

---

## 8. Quản lý doanh nghiệp

### Đơn hàng & Tồn kho

| Nhắn gì | Kết quả |
|---------|---------|
| "Ghi đơn: Anh C mua 2 iPhone 15 Pro, tổng 51.800.000" | Ghi đơn hàng |
| "Danh sách đơn hôm nay" | Liệt kê đơn |
| "Kiểm tra tồn kho iPhone 15" | Số lượng còn |
| "Nhập kho 50 iPhone 15 Pro" | Điều chỉnh kho |

### Sổ sách & Công nợ

| Nhắn gì | Kết quả |
|---------|---------|
| "Ghi thu: Anh D thanh toán 15.200.000 đơn DH-001" | Ghi sổ thu |
| "Ghi chi: Mua hàng nhập kho 8.000.000" | Ghi sổ chi |
| "Thu chi tuần này" | Tổng hợp thu chi |
| "Ai đang nợ?" | Danh sách khách nợ |

### Tạo tài liệu

| Nhắn gì | Kết quả |
|---------|---------|
| "Soạn báo giá cho Anh C: 2 iPhone 15 Pro x 25.900.000" | Tạo báo giá → preview → OK → gửi |
| "Tạo JD tuyển nhân viên bán hàng" | Mô tả + bài đăng + câu hỏi phỏng vấn |
| "Tạo slide giới thiệu công ty 5 trang" | Tạo PowerPoint |

---

## 9. Theo dõi khách hàng

| Nhắn gì | Kết quả |
|---------|---------|
| "Khách nào chưa trả lời?" | Danh sách khách chờ follow-up |
| "Khách hot tuần này?" | Khách có tag "hot" hoặc "lead" |
| "Xuất danh sách khách Zalo tuần này ra file Excel" | Tạo file Excel CRM |
| "Nhớ giùm: Anh C thích hàng Nhật, budget 50 triệu" | Bot ghi nhớ vĩnh viễn |
| "Khách Nguyễn Văn E đã mua gì?" | Tra lịch sử khách |

Bot tự ghi nhớ khách Zalo (tên, sở thích, lịch sử). Cron follow-up chạy hàng ngày — khách chưa phản hồi > 48h, bot báo CEO trên Telegram.

---

## 10. Lịch hẹn

| Nhắn gì | Kết quả |
|---------|---------|
| "Đặt lịch hẹn khách Anh C ngày mai 10h" | Ghi lịch hẹn + nhắc trước giờ hẹn |
| "Lịch hẹn hôm nay" | Danh sách cuộc hẹn |
| "Dời lịch Anh C sang 3h chiều" | Cập nhật lịch |

---

## 11. Kỹ năng tùy chỉnh

| Nhắn gì | Kết quả |
|---------|---------|
| "Tạo skill mới: khi khách hỏi combo, tư vấn 3 combo phổ biến nhất" | Bot hỏi chi tiết → đề xuất → OK → skill tự kích hoạt |
| "Tạo skill: khi khách hỏi lịch hẹn, check lịch hẹn rồi đề xuất 3 slot" | Skill kết hợp lịch hẹn nội bộ |
| "Danh sách skill" | Xem tất cả kỹ năng |

Bot có sẵn 40 kỹ năng (vận hành + marketing + 8 ngành). Tự kích hoạt theo ngữ cảnh.

**Kỹ năng theo ngành có sẵn:**

| Ngành | Ví dụ bot tự xử lý |
|-------|-------------------|
| Bất động sản | Dự án, pháp lý, tiến độ, thanh toán |
| F&B | Đặt bàn, menu, khuyến mãi, checklist mở/đóng cửa |
| Spa / Salon | Đặt lịch dịch vụ, nhắc tái sử dụng, combo chăm sóc |
| Giáo dục | Lịch học, tuyển sinh, học phí, liên lạc phụ huynh |
| Công nghệ / IT | Hỗ trợ kỹ thuật, SLA, sprint, release notes |
| Sản xuất | Đơn sản xuất, nguyên liệu, QC, kiểm kê |
| Thương mại / Bán lẻ | Tồn kho, đơn hàng, đổi trả, nhà cung cấp |
| Dịch vụ tổng quát | Công việc chung không thuộc ngành cụ thể |

---

## 12. Hệ thống

| Nhắn gì | Kết quả |
|---------|---------|
| "Trạng thái hệ thống" | Gateway, Telegram, Zalo, AI, cron |
| "Tạm dừng bot 2 tiếng" | Bot im lặng, tự bật lại sau 2h |
| "Tạm dừng Zalo 1 giờ" | Chỉ dừng Zalo |
| "Tiếp tục bot" | Bật lại ngay |

---

## Lưu ý quan trọng

- **App phải mở** để bot hoạt động. Thu nhỏ xuống tray được, nhưng không tắt.
- **Mac đóng nắp = sleep = bot ngừng.** Vào Energy Saver > tắt sleep nếu muốn bot chạy 24/7.
- **Dữ liệu 100% trên máy.** Không lên cloud của 9Biz. Backup định kỳ: Dashboard > menu hỗ trợ > "Sao lưu dữ liệu".
- **Cập nhật app không mất dữ liệu** — dữ liệu nằm riêng, cài mới chỉ ghi đè app.
- **Hỗ trợ:** tech@modoro.com.vn hoặc nhóm Telegram trong app (Dashboard > menu hỗ trợ > "Liên hệ 9Biz").
