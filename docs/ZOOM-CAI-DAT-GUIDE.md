# Hướng dẫn buổi Zoom cài đặt 9BizClaw

Dành cho nhân viên 9Biz khi hỗ trợ CEO qua TeamViewer.

---

## Trước khi zoom (gửi CEO trước 1-2 tiếng)

Gửi CEO tin nhắn này:

> "Anh/chị ơi, trước buổi zoom anh/chị chuẩn bị giúp em:
> 1. **File cài đặt** — em gửi link tải, anh/chị tải về để sẵn
> 2. **Ollama API key** — vào ollama.com → đăng nhập → Settings → API Keys → tạo key mới → copy sẵn
> 3. **Telegram**: mở Telegram trên điện thoại để nhận tin test cuối buổi
>
> Khoảng [giờ] mình bắt đầu nha anh/chị."

---

## Phần 1 — Cài & chạy wizard (10-15 phút)

**Mục tiêu: bot reply được trên Telegram trước khi kết thúc phần này.**

### 1.1 Cài đặt

- [ ] TeamViewer vào máy CEO
- [ ] Chạy file EXE (Windows) hoặc DMG (Mac)
- [ ] Chờ splash "Đang giải nén..." — lần đầu mất ~1 phút
- [ ] Wizard mở ra tự động

### 1.2 Wizard — Bước 1: Thông tin

- [ ] Tên CEO (cách xưng hô: anh/chị/thầy/cô...)
- [ ] Tên công ty
- [ ] Lĩnh vực kinh doanh (chọn từ dropdown)
- [ ] Tính cách bot: chọn **giọng xưng hô** + **3-5 tính cách** phù hợp ngành
  - Ví dụ spa/dịch vụ: Ấm áp + Chu đáo + Kiên nhẫn
  - Ví dụ BĐS: Chuyên nghiệp + Chủ động + Thực tế

### 1.3 Wizard — Bước 2: AI (Ollama)

- [ ] CEO paste Ollama API key vào ô
- [ ] Nhấn "Thiết lập AI" → chờ 5-10 giây
- [ ] Thấy "Thiết lập thành công. Model đã chọn tự động." → tiếp tục

> **Nếu lỗi:** Kiểm tra key có bị space thừa không. Thử copy lại từ ollama.com.

### 1.4 Wizard — Bước 3: Telegram Bot

**Nếu CEO chưa có bot Telegram:**
1. Mở Telegram → tìm @BotFather → `/newbot`
2. Đặt tên (VD: "Trợ Lý [Tên Shop]")
3. Copy Bot Token (dạng `123456:ABCdef...`)

**Điền vào wizard:**
- [ ] Paste Bot Token
- [ ] Lấy User ID: CEO mở `t.me/userinfobot` → gửi bất kỳ tin → copy số ID
- [ ] Nhấn "Kiểm tra" → thấy xanh → tiếp tục

### 1.5 Wizard — Bước 4: Hoàn tất

- [ ] Nhấn "Hoàn tất" → Dashboard mở ra
- [ ] Sidebar Telegram dot **xanh** trong vòng 30 giây

**Test ngay — quan trọng:**
> CEO tự nhắn bot 1 câu trên Telegram: *"Bạn là ai?"*
> Bot reply trong 5-10 giây → ✅ **Done. Phần 1 thành công.**

---

## Phần 2 — 3 tính năng cần biết ngay (10 phút)

### 2.1 Tab Tổng quan — "Bảng điều khiển"

Chỉ CEO:
- **Dot xanh/đỏ** ở sidebar = bot sống/chết
- **Hoạt động gần đây** = log những gì bot vừa làm
- **Sắp tới** = cron/lịch tự động sắp chạy

> *"Mỗi sáng anh/chị mở cái này ra là biết bot đêm qua làm gì."*

### 2.2 Tab Knowledge — "Tủ tài liệu"

Mục đích: càng nhiều tài liệu → bot càng trả lời chính xác.

**Demo ngay trong buổi:**
- [ ] Nhấn "Thêm tài liệu" → chọn 1 file PDF/Word về sản phẩm/dịch vụ → upload
- [ ] Chờ "Đã xử lý" (30-60 giây)
- [ ] CEO nhắn bot hỏi về nội dung file đó
- [ ] Bot trả lời dựa trên file → ✅ **second wow moment**

Hướng dẫn CEO upload thêm:
- Bảng giá, catalogue sản phẩm
- Quy trình xử lý khiếu nại
- FAQ thường gặp

### 2.3 Tab Telegram — Nút "Tạm dừng"

- [ ] Demo bật Tạm dừng → nhắn bot → bot không reply
- [ ] Tắt Tạm dừng → nhắn bot → bot reply lại

> *"Khi anh/chị muốn tự xử lý khách thì bấm Tạm dừng. Xong bấm Tiếp tục."*

---

## Phần 3 — Zalo (nếu còn thời gian hoặc CEO cần gấp)

> Zalo phức tạp hơn Telegram. Nếu buổi zoom đã >30 phút, hẹn buổi riêng.

Điều kiện để setup Zalo:
- CEO đã đăng nhập Zalo trên máy tính (app Zalo Desktop)
- CEO có tài khoản Zalo cá nhân dùng để nhận tin từ khách

Cách cài:
- [ ] Dashboard → Tab Zalo → làm theo hướng dẫn quét QR
- [ ] Chờ dot Zalo chuyển xanh (~15-30 giây)
- [ ] Nhắn bot từ Zalo → bot reply

---

## Kết buổi (2-3 phút)

- [ ] CEO tự nhắn bot thêm 2-3 câu để quen
- [ ] Chụp màn hình Dashboard dot xanh gửi cho CEO lưu
- [ ] Nhắn CEO: *"Nếu mai thấy dot đỏ thì restart app. Vẫn đỏ thì nhắn em."*
- [ ] Hỏi CEO muốn upload thêm tài liệu gì → hướng dẫn họ tự làm

---

## Xử lý sự cố thường gặp

| Tình huống | Xử lý |
|---|---|
| Wizard "Thiết lập AI" lỗi | Kiểm tra API key có đúng không, thử lại |
| Bot token sai | Vào @BotFather → `/mybots` → chọn bot → API Token |
| Dot Telegram đỏ sau wizard | Chờ 30s, nếu vẫn đỏ → restart app |
| Bot không reply dù dot xanh | Nhắn bot → nếu không có gì → check tab Tổng quan xem có lỗi không |
| Splash bar đứng >3 phút | Tắt antivirus tạm thời, chạy lại |

---

## Những thứ KHÔNG cần demo trong buổi cài

Để CEO tự khám phá sau khi quen:

- Cron / báo cáo sáng tự động
- Tính cách bot (chỉnh sau trong Dashboard → Cài đặt)
- Bạn bè Zalo / blocklist
- Tab 9Router và OpenClaw (nội bộ, CEO không cần biết)
