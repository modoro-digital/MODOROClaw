# HEARTBEAT.md — Hệ Thống Kiểm Tra Tự Động

**Mẫu heartbeat luân phiên:** Một heartbeat chạy mỗi 2 giờ, thực hiện kiểm tra quá hạn nhất dựa trên file trạng thái.

Đọc `docs/agent-architecture.md` để biết đầy đủ quy tắc hành vi.

---

## Quy tắc nền tảng
- **KHÔNG XOÁ GÌ** mà không hỏi chủ nhân trước
- Không spam — cân nhắc trước khi thông báo
- Không gửi tin nhắn ra bên ngoài (email, mạng xã hội) mà không được phép
- Ghi nhật ký mọi việc làm vào file bộ nhớ hàng ngày

---

## Xử lý sự kiện thức dậy (Bộ lắng nghe thời gian thực)

Khi được đánh thức bởi sự kiện hệ thống:
1. **Kiểm tra hộp thư ngay**
2. **Xử lý tin nhắn khẩn** — nếu khẩn cấp, phản hồi bằng hành động
3. **Xác nhận tin thông báo** — nếu có câu hỏi hoặc cần phản hồi
4. **Đánh dấu đã đọc** — sau khi xử lý, đánh dấu tin nhắn đã đọc
5. **Chỉ báo cáo khi cần hành động** — không spam vì tin INFO thông thường

---

## Hệ thống kiểm tra luân phiên

### Cách hoạt động
1. Đọc `memory/heartbeat-state.json` để biết lần kiểm tra gần nhất
2. Tính toán kiểm tra nào quá hạn nhất (tôn trọng khung giờ)
3. Chạy kiểm tra đó
4. Cập nhật timestamp trong file trạng thái
5. Chỉ báo cáo nếu tìm thấy điều cần hành động
6. Trả về `HEARTBEAT_OK` nếu không cần chú ý

### Tần suất kiểm tra

| Kiểm tra | Tần suất | Khung giờ | Ưu tiên |
|----------|----------|-----------|---------|
| Tự bảo trì | 1 giờ | Bất kỳ | Cao |
| Đồng bộ dashboard | 1 giờ | Bất kỳ | Cao |
| Hộp thư | 1 giờ | Bất kỳ | Cao |
| Email | 2 giờ | 8:00 - 22:00 | Trung bình |
| Lịch | 2 giờ | 8:00 - 22:00 | Trung bình |
| Quan hệ | 12 giờ | 9:00 - 21:00 | Thấp |
| Ghi nhận bài học | 6 giờ | Bất kỳ | Thấp |

---

## Chi tiết từng kiểm tra

### Tự bảo trì (mỗi giờ)
**Mục đích:** Ghi nhận bài học, theo dõi quyết định, chia sẻ kinh nghiệm, kiểm tra phối hợp.

**Hành động:**
1. Xem lại phiên để tìm quyết định, sai sót, hoặc hiểu biết mới
2. Tìm cơ hội kết hợp công việc hoặc dự án gần đây
3. Kiểm tra bài học từ agent khác
4. Cập nhật file bộ nhớ hôm nay
5. Ghi bài học vào learning database

**Báo cáo:** Chỉ khi có phát hiện/hiểu biết đáng chia sẻ

---

### Đồng bộ dashboard (mỗi giờ)
**Mục đích:** Giữ dashboard đám mây đồng bộ với dữ liệu cục bộ

**Báo cáo:** Chỉ khi gặp lỗi

---

### Hộp thư (mỗi giờ)
**Mục đích:** Kiểm tra tin nhắn từ agent hoặc hệ thống khác

**Quy tắc phản hồi:**
- [HÀNH ĐỘNG] hoặc urgent=true → phản hồi bằng hành động
- [THÔNG TIN] → phản hồi nếu cần xác nhận hoặc có câu hỏi
- [TRÒ CHUYỆN] → phản hồi chân thành nếu có điều muốn nói

**Báo cáo:** Chỉ cho tin khẩn hoặc cần hành động

---

### Email (mỗi 2 giờ, 8:00-22:00)
**Mục đích:** Kiểm tra email quan trọng

**Báo cáo nếu:**
- Email tuyển dụng
- Lời mời lịch
- Yêu cầu có thời hạn
- Thư từ kinh doanh đang chờ

---

### Lịch (mỗi 2 giờ, 8:00-22:00)
**Mục đích:** Cảnh báo về sự kiện sắp tới

**Báo cáo nếu:**
- Sự kiện bắt đầu trong vòng 2 giờ
- Sự kiện mới kể từ lần kiểm tra trước
- Cuộc họp quan trọng sắp diễn ra

---

### Quan hệ (mỗi 12 giờ, 9:00-21:00)
**Mục đích:** Kiểm tra follow-up quan hệ cần thực hiện

**Báo cáo nếu:** Có ai đó cần follow-up

---

## Khi nào cảnh báo chủ nhân

- Email quan trọng đến
- Sự kiện lịch sắp diễn ra (dưới 2 giờ)
- Phát hiện cơ hội thú vị
- Lo ngại về ngân sách token (hơn 150k context)
- Tin nhắn khẩn cấp
- Đã hơn 8 giờ kể từ lần nói chuyện thực chất cuối

## Khi nào im lặng

- Đêm khuya (23:00-08:00) trừ khi khẩn cấp
- Chủ nhân rõ ràng đang bận
- Không có gì mới kể từ lần kiểm tra trước
- Vừa kiểm tra cách đây chưa đến 30 phút
- Tất cả hệ thống bình thường

Trả về `HEARTBEAT_OK` nếu không cần chú ý.

---

## Phản hồi im lặng
Khi không có gì cần nói, phản hồi CHỈ VỚI: NO_REPLY
⚠️ Quy tắc:
- Đó phải là TOÀN BỘ tin nhắn — không gì khác
- Không bao giờ ghép nối nó vào phản hồi thực
- Không bao giờ bọc trong markdown hoặc code block

---

## Quy trình xử lý lỗi khi chạy kiểm tra

*(Cải tiến từ MODORO)*

Khi gặp lỗi trong heartbeat/cron:
1. DỪNG ngay. Không retry
2. Báo chủ nhân: tên task + lỗi nguyên văn + bước đang làm
3. CHỜ lệnh. Không tự sửa config, không kill process
