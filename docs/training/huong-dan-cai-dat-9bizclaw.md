# HƯỚNG DẪN CÀI ĐẶT 9BIZCLAW CHO ĐỘI INSTALLER

**Tài liệu training — dành cho đội cài đặt khi ra khách**

**Phiên bản:** v2.3.46 · **Ngày cập nhật:** 17/04/2026

---

## PHẦN I — HIỂU SẢN PHẨM TRƯỚC KHI CÀI

### 1. 9BizClaw là gì?

**9BizClaw** là **trợ lý AI doanh nghiệp** cài trên máy tính của chủ shop / CEO. Bot tự động:
- Trả lời tin nhắn khách trên **Telegram** và **Zalo** (cá nhân + nhóm)
- Đọc và dùng **tài liệu nội bộ** (catalogue sản phẩm, quy trình, FAQ) để trả lời chính xác
- Gửi **báo cáo sáng + tối** cho chủ doanh nghiệp mỗi ngày qua Telegram
- Ghi nhớ từng khách hàng để trả lời tự nhiên theo lịch sử giao tiếp

### 2. Giá trị bán cho khách

Khi khách hỏi "app này làm gì?", installer trả lời:
- **Tiết kiệm nhân viên chat:** 1 bot thay thế 2-3 nhân viên trực chat 24/7
- **Khách được trả lời trong <5 giây:** không bao giờ bỏ sót
- **Nói giọng doanh nghiệp:** bot học cách xưng hô, phong cách nói của shop
- **Bảo mật tuyệt đối:** bot chạy TRÊN MÁY KHÁCH, dữ liệu KHÔNG lên cloud
- **Không cần kiến thức IT:** wizard 6 bước, 5 phút cài xong

### 3. Kiến trúc tổng quan (nếu khách hỏi sâu)

```
[ Khách nhắn tin ]
      ↓
[ Zalo / Telegram Server ]
      ↓
[ 9BizClaw trên máy CEO ]
      ├─ OpenClaw Gateway (nhận/gửi tin)
      ├─ 9Router (chọn AI model)
      ├─ OpenZalo Plugin (kết nối Zalo)
      └─ Knowledge Base (đọc tài liệu shop)
      ↓
[ AI trả lời dựa trên bot personality + knowledge ]
```

### 4. Yêu cầu hệ thống

| | Windows | Mac |
|---|---|---|
| **OS** | Windows 10 / 11 | macOS 11 Big Sur trở lên |
| **CPU** | Intel i5 / AMD Ryzen 5 trở lên | Apple Silicon M1+ hoặc Intel |
| **RAM** | Tối thiểu 8GB, khuyến nghị 16GB | Tối thiểu 8GB |
| **Ổ cứng** | 5GB trống (sau cài 2GB) | 5GB trống |
| **Internet** | Bắt buộc (bot cần gọi AI) | Bắt buộc |
| **Mạng tiếng Việt (ISP VN)** | FTTH / 4G đều OK | FTTH / 4G đều OK |

**Lưu ý:** Máy SSD chậm (Micron 2200V, SSD laptop văn phòng cũ) cài sẽ mất **3-5 phút** thay vì 1-2 phút. Cảnh báo khách trước.

---

## PHẦN II — TRƯỚC KHI TỚI KHÁCH — CHECKLIST CHUẨN BỊ

### 2.1. Gửi installer này cho khách qua Zalo/email trước buổi cài

- [ ] Hỏi khách: **"Anh/chị xài Windows hay Mac?"** → gửi đúng file
- [ ] Gửi link download: **https://github.com/modoro-digital/9BizClaw/releases/latest**
- [ ] Khách tải về **TRƯỚC** buổi cài (tiết kiệm 5-10 phút ở chỗ khách)

### 2.2. Xin thông tin của khách trước

Khi đến nơi, installer phải có sẵn:
- [ ] **Tên chủ doanh nghiệp** (để bot xưng hô, VD: "anh Tuấn", "chị Linh")
- [ ] **Tên doanh nghiệp/shop** (VD: "9Biz Tech")
- [ ] **Ngành nghề** (VD: "bán điện thoại", "spa", "quần áo nữ")
- [ ] **Phong cách muốn** (VD: "chuyên nghiệp", "thân thiện", "lịch sự")
- [ ] **Tài khoản Zalo cá nhân** của chủ doanh nghiệp (để cài bot vào)
- [ ] **Telegram của chủ** (để nhận báo cáo) — hoặc sẽ tạo bot mới tại chỗ

### 2.3. Chuẩn bị BotFather trên điện thoại installer

- [ ] Mở Telegram, tìm **@BotFather**
- [ ] Đã biết cách tạo bot mới: `/newbot` → đặt tên → lấy token
- [ ] Có template tên bot gợi ý: `shopName_claw_bot` (chỉ chữ, số, `_`)

### 2.4. Mang theo

- [ ] USB có sẵn installer `9BizClaw Setup X.X.X.exe` hoặc `.dmg` (phòng trường hợp mạng khách chậm)
- [ ] Tài liệu này (in ra hoặc iPad)

---

## PHẦN III — CÀI ĐẶT — WINDOWS

### 3.1. Download & chạy installer

**Nếu khách đã download trước:**
- File trong thư mục Downloads, tên `9BizClaw Setup 2.3.46.exe`

**Nếu chưa:**
- Mở Chrome/Edge → **https://github.com/modoro-digital/9BizClaw/releases/latest**
- Click file `.exe` để tải
- Kích thước ~420MB, mạng FTTH tải 1-2 phút

### 3.2. Chạy installer

- Double-click file `.exe`
- Windows SmartScreen hiện: **"Windows protected your PC"** → bấm **"More info"** → **"Run anyway"** (do chưa có code signing)
- Hiện tiến trình cài → 1-2 phút
- Sau cài xong, app tự mở → màn hình **Splash** hiện "Đang giải nén..." — **lần đầu 30-60 giây** (tar extract 1.6GB nội dung)

### 3.3. First launch — Splash screen

Lần đầu sau cài, app hiện splash với progress bar:
- `Đang giải nén... X / 171,968 file`
- **Chờ đến khi splash biến mất** (30-120s tuỳ tốc độ SSD)
- Sau đó wizard hiện ra

**Nếu splash không biến mất sau 5 phút:**
- Task Manager → kill `9BizClaw.exe`
- Mở lại từ Start Menu
- Nếu vẫn stuck → copy file `%APPDATA%\9bizclaw\logs\main.log` gửi team kỹ thuật

---

## PHẦN IV — CÀI ĐẶT — MAC

### 4.1. Download .dmg đúng chip

**Apple Silicon (M1/M2/M3/M4):**
- File có chữ **`arm64`**: `9BizClaw-2.3.46-arm64.dmg`

**Intel Mac (2020 trở về trước):**
- File KHÔNG có chữ `arm64`: `9BizClaw-2.3.46.dmg`

**Check chip trên Mac:**
- Apple menu → "About This Mac" → nếu thấy "Apple M" → arm64. Thấy "Intel" → x64.

### 4.2. Cài đặt

- Double-click file `.dmg`
- Mac hiện cửa sổ với **9BizClaw icon** + **Applications folder**
- **Kéo 9BizClaw vào Applications**
- Mở **Finder** → **Applications** → double-click **9BizClaw**
- macOS block: **"9BizClaw can't be opened"** (chưa có Apple signing)
  - **System Settings** → **Privacy & Security** → kéo xuống cuối → **"9BizClaw was blocked..."** → bấm **"Open Anyway"**
  - Dialog hiện lại → **"Open"**

---

## PHẦN V — WIZARD — 6 BƯỚC CẤU HÌNH

Wizard tự hiện sau khi cài. Làm theo thứ tự:

### BƯỚC 1 — Chào mừng

- Đọc qua mô tả
- Bấm **"Bắt đầu"**

### BƯỚC 2 — Thiết lập AI (9Router)

- Nút **"Thiết lập AI"** lớn ở giữa
- Bấm → app tự install 9Router + chạy background
- Khi sẵn sàng: dashboard 9Router hiện, password mặc định `123456`
- **Cấu hình provider:** chọn **"OpenClaw Plus (ChatGPT)"** hoặc **"Anthropic Claude"** (theo tài khoản của khách)
- Click **"Login"** → follow OAuth flow trong browser
- Sau khi login xong → quay lại wizard → bấm **"Tiếp theo"**

**Lưu ý:** Nếu khách có sẵn API key OpenAI/Anthropic, dán vào thay vì login. Rẻ hơn cho khách hoạt động nhiều.

### BƯỚC 3 — Telegram

- Tạo bot Telegram (nếu khách chưa có):
  1. Mở Telegram → search **@BotFather**
  2. Gõ `/newbot`
  3. Đặt tên hiển thị: **"Trợ lý [tên shop]"**
  4. Đặt username: **`shopname_claw_bot`** (phải kết thúc bằng `bot`)
  5. BotFather gửi lại **token** dạng `123456789:ABCdefGHI...`
- Paste token vào ô **"Token bot"**
- Bấm **"Kiểm tra"** → nếu OK hiện tên bot
- Khách nhắn `/start` với bot vừa tạo (trên Telegram của khách) để bot có **chatId**
- Bot sẽ gửi về chatId → paste vào ô **"ChatId của bạn"** hoặc app tự detect

### BƯỚC 4 — Tính cách bot

Hỏi khách 3 câu:
1. **"Anh/chị muốn bot gọi mình là gì?"** → VD: "anh Tuấn"
2. **"Shop tên là gì?"** → VD: "9Biz Tech"
3. **"Muốn giọng điệu chuyên nghiệp hay thân thiện?"**

Điền vào các ô tương ứng. Có thể tinh chỉnh sau trong tab **"Tính cách bot"**.

### BƯỚC 5 — Zalo (QR login)

- Bấm **"Đăng nhập Zalo"** → app mở QR code
- **Hướng dẫn khách:**
  1. Mở Zalo trên điện thoại
  2. Bấm biểu tượng **cài đặt** → **"Quét QR"**
  3. Scan QR trên màn hình máy tính
  4. Xác nhận đăng nhập
- Sau 5-15 giây, app hiện **"Đã đăng nhập"** + tên tài khoản Zalo
- Bấm **"Tiếp theo"**

**Nếu QR không quét được:**
- Check Zalo trên điện thoại có được update lên version mới nhất
- Thử đăng xuất Zalo trên tất cả thiết bị khác rồi thử lại
- Nếu vẫn lỗi: skip bước này, bỏ qua — bot vẫn chạy Telegram

### BƯỚC 6 — Hoàn tất

- Review thông tin
- Bấm **"Hoàn tất"**
- App navigate vào **Dashboard**

**Thời gian khởi động lần đầu:** 70-90 giây cho gateway sẵn sàng. Chờ khi sidebar Telegram + Zalo có chấm xanh.

---

## PHẦN VI — DASHBOARD — CẤU HÌNH SAU WIZARD

### 6.1. Sidebar bên trái (menu)

| Tab | Mục đích |
|---|---|
| **Tổng quan** | Greeting + hoạt động gần đây + cron sắp tới + alerts cần để ý |
| **Telegram** | Quản lý Telegram (test gửi, tạm dừng) |
| **Zalo** | Quản lý Zalo — **QUAN TRỌNG NHẤT** |
| **Tài liệu** | Upload catalogue, tài liệu công ty, FAQ |
| **Tính cách** | Chỉnh persona mix (hài hước/nghiêm túc/chuyên nghiệp/thân thiện) |
| **Shop State** | Giờ mở cửa, trạng thái shop hôm nay |
| **Calendar** | Lịch hẹn khách |
| **Cron** | Lên lịch bot gửi báo cáo / nhắc việc |
| **9Router** | Web UI quản lý AI provider (advanced) |
| **OpenClaw** | Web UI openclaw gateway (advanced) |
| **Gateway** | Start/stop/restart bot |

### 6.2. Cấu hình tab Zalo — QUAN TRỌNG

**Panel trái (sidebar cấu hình):**

- **Chế độ trả lời:**
  - `Tự động trả lời` — bot reply như bình thường
  - `Chỉ đọc + tóm tắt cuối ngày` — bot KHÔNG reply, chỉ đọc và tóm tắt gửi CEO cuối ngày
  
- **Người lạ nhắn tin** (ai chưa là bạn Zalo):
  - `Trả lời bình thường` — bot reply ngay
  - `Chỉ chào 1 lần` — bot gửi 1 câu chào rồi im
  - `Không trả lời` — bot ignore
  
- **Hành vi nhóm mới** (khi bot được add vào nhóm mới):
  - `@mention` — chỉ reply khi có ai tag bot
  - `Mọi tin` — reply mọi tin nhắn trong nhóm
  - `Tắt` — không reply trong nhóm mới

- **Chủ nhân Zalo:** chọn tên chủ shop trong dropdown — để bot biết đây là CEO để xưng hô đúng

**Panel giữa (danh sách Nhóm + Bạn bè):**

- **Nhóm:** mặc định **TẤT CẢ TẮT** sau onboarding (policy an toàn — tránh bot spam khách khi chưa config xong)
- **Bạn bè:** tương tự
- Installer phải **bật từng nhóm/bạn** mà khách muốn bot trả lời

Sau cấu hình xong → bấm **"Lưu cấu hình"** (nút xanh góc dưới trái).

### 6.3. Upload tài liệu (tab Tài liệu)

Hướng dẫn khách:
- 3 thư mục: **Công ty** / **Sản phẩm** / **Nhân viên**
- Kéo thả file vào → bot tự đọc + nhớ
- Format hỗ trợ: PDF, Word, Excel, TXT, CSV, ảnh (JPG, PNG)
- Giới hạn: 100MB/file

**Gợi ý upload cho khách bán hàng:**
- Thư mục **Công ty:** giờ mở cửa, địa chỉ, chính sách bảo hành
- Thư mục **Sản phẩm:** catalogue giá, mô tả chi tiết
- Thư mục **Nhân viên:** SDT liên hệ khẩn, giờ trực

---

## PHẦN VII — VERIFICATION — TEST SAU CÀI

**KHÔNG BAO GIỜ rời khỏi nhà khách khi chưa verify 4 điểm này.**

### 7.1. Test Telegram

- Mở tab **Telegram** → bấm **"Gửi tin test"**
- Khách phải nhận được tin test trong **3-5 giây**
- Khách nhắn lại bất kỳ → bot reply trong **5-15 giây**

### 7.2. Test Zalo (tin cá nhân)

- Yêu cầu khách nhắn tin Zalo cho CEO từ **1 số khác** (vợ/người thân/installer chat thử)
- Sender đó phải ở trạng thái **đã bật** (un-blocked) trong Dashboard → Zalo → Bạn bè
- Bot phải reply trong **10-20 giây**

### 7.3. Test Zalo (nhóm)

- Vào 1 nhóm Zalo đã bật mode `@mention`
- Tag CEO + hỏi một câu
- Bot phải reply (nếu chưa bật group → lưu cấu hình rồi test lại)

### 7.4. Test Cron

- Tab **Cron** → click **"Test"** bên cạnh cron "Morning report"
- Khách phải nhận báo cáo test trên Telegram trong 30s

**Nếu 1 trong 4 test fail:**
1. Tab **Gateway** → bấm **"Khởi động lại gateway"** → chờ 2 phút → test lại
2. Nếu vẫn fail → copy log `%APPDATA%\9bizclaw\logs\main.log` → gửi team kỹ thuật
3. KHÔNG claim "bot chạy OK" nếu verify chưa pass

---

## PHẦN VIII — HANDOFF — BÀN GIAO CHO KHÁCH

### 8.1. Hướng dẫn khách 5 điểm chính

1. **"Để bot chạy, máy tính phải bật + app mở"** (hoặc minimize, đừng quit)
2. **"Bot có thể trả lời sai trong 1-2 ngày đầu — chị gửi tin cho em chỉnh lại prompt"**
3. **"Mở tab Tổng quan mỗi sáng để xem báo cáo tối qua"**
4. **"Nếu khách nào bot trả lời kỳ → tìm tên trong tab Zalo → Bạn bè → Tắt/chỉnh nhớ"**
5. **"Có gì bất thường, gọi hotline [SĐT]"**

### 8.2. Checklist trước khi ra về

- [ ] 4 test đều pass
- [ ] Chủ doanh nghiệp đã nhắn ít nhất 3 tin thử + thấy bot phản hồi
- [ ] Hướng dẫn khách cách mở/đóng app (Start Menu / Dock)
- [ ] Gửi khách cái doc này + video hướng dẫn
- [ ] Lấy feedback: khách thấy ổn, có câu hỏi gì không?

### 8.3. Thông tin quan trọng để lại cho khách

Ghi giấy/email cho khách:
- Link web 9Router: `http://127.0.0.1:20128` (mật khẩu `123456`)
- Link web OpenClaw: `http://127.0.0.1:18789`
- Thư mục workspace: `%APPDATA%\9bizclaw` (Windows) hoặc `~/Library/Application Support/modoro-claw` (Mac)
- Hotline support: **[điền SĐT]**

---

## PHẦN IX — TROUBLESHOOTING — SỰ CỐ THƯỜNG GẶP

### 9.1. Splash không biến mất / kẹt khi khởi động

**Nguyên nhân:** SSD chậm + antivirus scan 170k file vendor.

**Fix:**
1. Task Manager → kill `9BizClaw.exe`
2. Disable Windows Defender real-time tạm 30 phút (qua Start → Windows Security → Virus & threat → Manage settings → off Real-time)
3. Mở lại app → lần này fast path
4. Bật lại Defender sau khi app ready

### 9.2. Gateway không ready / bot không reply

**Check thứ tự:**
1. Tab **Gateway** → nhìn trạng thái. Nếu đỏ → bấm **"Khởi động lại gateway"**
2. Tab **Tổng quan** → xem "Cần để ý" có alert nào không
3. Tab **Telegram** → click **"Kiểm tra"** — nếu fail, token sai
4. Tab **Zalo** → dot đỏ? Click **"Kiểm tra"** — có thể cookies Zalo hết hạn, phải đăng nhập lại

### 9.3. Bot trả lời sai / trật ngữ cảnh

- Tab **Tính cách** → điều chỉnh persona
- Tab **Tài liệu** → upload thêm FAQ rõ ràng
- Tab **Zalo → Bạn bè** → mở hồ sơ user đó → xem/sửa memory (note quan trọng về khách đó)

### 9.4. Bot reply spam nhiều lần cùng 1 tin

**Bug đã fix ở v2.3.41+** (duplicate sender dedup). Nếu khách báo, update lên version mới.

### 9.5. Bot không hiểu tiếng Việt có dấu

- Check tab **Tính cách** → prompt có "tiếng Việt có dấu" không
- Check AI model đang dùng: 9Router → models → chắc chắn model hỗ trợ tiếng Việt (GPT-4, Claude Sonnet đều OK)

### 9.6. Khởi động chậm (5+ phút) trên Windows

**Fix cho v2.3.46:** nếu khách update lên v2.3.46, patch tự làm fetch openrouter.ai fail nhanh. Nếu vẫn chậm:
1. Kiểm tra DNS máy khách — ping `openrouter.ai` xem có trả lời không
2. Thử đổi DNS sang Google (8.8.8.8)
3. Nếu công ty chặn openrouter.ai → không ảnh hưởng (patch của app đã handle)

### 9.7. Cài lại (đổi máy khách)

1. Export backup: copy thư mục `%APPDATA%\9bizclaw` (Windows) sang USB
2. Cài app trên máy mới
3. Paste thư mục vào đúng path
4. Bật app → wizard skip (đã onboard)

---

## PHẦN X — FAQ INSTALLER SẼ BỊ HỎI

**Q: Bot này có phải ChatGPT không?**
A: Không phải. 9BizClaw là **app chạy trên máy anh/chị**, kết nối tới AI (có thể là ChatGPT, Claude, hoặc AI khác — tuỳ cài). Dữ liệu khách của anh/chị KHÔNG được lưu trên server Anthropic/OpenAI — chỉ có câu hỏi tức thời gửi lên AI để tạo câu trả lời.

**Q: Tháng tốn bao nhiêu tiền?**
A: Có 2 phần:
1. **App 9BizClaw:** MIỄN PHÍ, chỉ 1 lần cài
2. **AI API:** tuỳ volume chat. Shop nhỏ (100-300 tin/ngày) ~50-150k/tháng. Shop lớn (1000+ tin/ngày) ~300-700k/tháng. Khách có thể xài ChatGPT Plus (20 USD/tháng không giới hạn) rẻ nhất.

**Q: Bot có học được cách trả lời của tôi không?**
A: Có. Mỗi lần anh/chị sửa câu trả lời của bot qua Dashboard, nó sẽ nhớ. Càng dùng càng thông minh.

**Q: Bảo mật thế nào?**
A: Dữ liệu khách + tài liệu shop **TOÀN BỘ nằm trên máy anh/chị**, không lên cloud. AI chỉ nhận câu hỏi từng cái để trả lời, không lưu. Có thể xoá app bất cứ lúc nào → data sạch.

**Q: Tắt máy có reply được không?**
A: Không. Máy phải bật + app phải chạy. Khuyến nghị: **máy mini PC rẻ** (~5tr) chạy 24/7 cho bot.

**Q: Nhiều nhân viên cùng dùng được không?**
A: Hiện tại **1 máy = 1 tài khoản Zalo + 1 bot**. Nếu doanh nghiệp cần nhiều nhân viên chat thay phiên, có thể gắn máy vào Zalo doanh nghiệp — tất cả nhân viên share chung 1 bot trả lời thay họ khi bận.

**Q: Cài nhầm thì sao?**
A: Cài lại đè lên — workspace data của khách được giữ (config + memory + docs). Nếu muốn xoá sạch: Uninstall → xoá thư mục `%APPDATA%\9bizclaw` → cài lại từ đầu.

**Q: Có trial / refund không?**
A: Tuỳ chính sách team — installer xác nhận với CEO 9Biz trước khi promise.

---

## PHỤ LỤC — SHORTCUTS & COMMANDS

### Quick keyboard shortcuts
- `Ctrl + Shift + I` — Mở DevTools (debug khi cần)
- `F12` — Force reload dashboard

### Log locations
- **Main log:** `%APPDATA%\9bizclaw\logs\main.log`
- **9Router log:** `%APPDATA%\9bizclaw\logs\9router.log`
- **Gateway log:** `%APPDATA%\9bizclaw\logs\openclaw.log` hoặc `%TEMP%\openclaw\`
- **Audit log (hoạt động bot):** `%APPDATA%\9bizclaw\logs\audit.jsonl`

### Workspace data
- **Config:** `%APPDATA%\9bizclaw\openclaw.json`
- **Bot personality:** `%APPDATA%\9bizclaw\IDENTITY.md`
- **Bot memory khách:** `%APPDATA%\9bizclaw\memory\zalo-users\*.md`
- **Bot memory nhóm:** `%APPDATA%\9bizclaw\memory\zalo-groups\*.md`
- **Knowledge docs:** `%APPDATA%\9bizclaw\knowledge\{cong-ty,san-pham,nhan-vien}\files\`

---

**Hết tài liệu. Version v2.3.46 — Apr 2026.**

**Có câu hỏi: liên hệ team 9Biz**
