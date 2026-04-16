# Hướng Dẫn Cài Đặt MODOROClaw Cho Khách Hàng

> Tài liệu nội bộ MODORO Tech Corp. Dành cho nhân viên kỹ thuật khi đi setup máy cho khách hàng.
>
> Tổng thời gian ước tính: **30-45 phút** (bao gồm cả thời gian chờ cài đặt npm).

---

## Trước Khi Đến (Chuẩn Bị Tại Văn Phòng)

**Thời gian: 15-20 phút**

Trước khi đến nơi khách hàng, cần chuẩn bị sẵn những thứ sau:

### 1. Copy folder MODOROClaw vào USB

- Copy toàn bộ folder `claw` (bao gồm tất cả file và subfolder) vào USB.
- Đảm bảo USB có ít nhất **500MB** dung lượng trống.

### 2. Ghi nhớ mã cài đặt

Có 3 mã cài đặt hợp lệ (nhập mã nào cũng được, không phân biệt hoa thường):

| Mã cài đặt | Ghi chú |
|---|---|
| `MODORO-2026` | Mã chính |
| `MODORO-INSTALL` | Mã dự phòng 1 |
| `MODORO-SETUP` | Mã dự phòng 2 |

> **Lưu ý:** Khi nhập, hệ thống tự động chuyển thành CHỮ HOA trước khi kiểm tra. Vậy nên nhập `modoro-2026` hay `MODORO-2026` đều được.

### 3. Chuẩn bị tài khoản Telegram cho khách

- Hỏi khách: "Anh/chị có Telegram chưa?" — Nếu chưa có, hướng dẫn cài Telegram trước.
- Khách cần có Telegram trên điện thoại hoặc máy tính để làm bước 4.

### 4. Chuẩn bị thông tin công ty của khách

Hỏi khách trước hoặc in phiếu để khách điền:

- Tên công ty, địa chỉ, số điện thoại, email, website
- Giờ làm việc (thứ 2 - CN)
- Slogan / giới thiệu ngắn
- Lĩnh vực kinh doanh
- Danh sách sản phẩm/dịch vụ chính (tên, giá, mô tả)
- Chính sách bảo hành / đổi trả
- Số tài khoản ngân hàng (cho thanh toán)
- Chương trình khuyến mại hiện tại (nếu có)

### 5. Kiểm tra máy khách có Node.js chưa

- Không cần kiểm tra trước — RUN.bat sẽ tự động cài Node.js nếu chưa có.
- Nhưng nên biết: máy khách cần kết nối internet và có quyền Admin.

---

## Bước 1: Cài Đặt (Copy + Chạy RUN.bat + Nhập Mã)

**Thời gian: 5-10 phút**

### 1.1. Copy folder vào máy khách

1. Cắm USB vào máy khách.
2. Copy folder `claw` vào Desktop của khách (hoặc bất kỳ vị trí nào dễ nhớ).

[Ảnh: Folder claw trên Desktop của khách]

### 1.2. Chạy RUN.bat

1. Mở folder `claw`.
2. Nhấn đôi chuột vào file **RUN.bat**.

[Ảnh: File RUN.bat trong folder claw]

3. Nếu Windows hỏi "Do you want to allow this app...?" → chọn **Yes**.
4. Cửa sổ CMD sẽ hiện ra. Chờ đợi:
   - Nếu máy chưa có Node.js → hệ thống tự tải và cài (mất thêm 2-3 phút).
   - Nếu chưa có `node_modules` → hệ thống chạy `npm install` lần đầu (mất 1-2 phút).
5. Sau đó, cửa sổ **MODOROClaw** sẽ hiện lên với màn hình "Cài đặt lần đầu".

[Ảnh: Màn hình "Cài đặt lần đầu" với ô nhập mã cài đặt]

### 1.3. Nhập mã cài đặt

1. Nhập một trong các mã: `MODORO-2026`, `MODORO-INSTALL`, hoặc `MODORO-SETUP`.
2. Nhấn **Xác nhận**.

[Ảnh: Ô nhập mã cài đặt]

- Nếu sai mã → hiện thông báo đỏ "Mã cài đặt không đúng. Liên hệ MODORO để nhận mã."
- Nếu đúng → hiện nút "Cài đặt tự động".

### 1.4. Nhấn "Cài đặt tự động" và chờ đợi

1. Nhấn nút **Cài đặt tự động**.
2. Thanh tiến trình sẽ chạy từ 0% đến 100%.
3. Hệ thống sẽ cài 3 package qua npm: `openclaw`, `9router`, `openzca`.
4. **Thời gian chờ: 2-5 phút** (tùy tốc độ mạng).
5. Khi xong, màn hình hiện "Cài đặt thành công!" với dấu tích xanh.

[Ảnh: Màn hình "Cài đặt thành công!" với nút "Tiếp tục"]

6. Nhấn **Tiếp tục** → app sẽ khởi động lại và chuyển sang màn hình Wizard.

**Xử lý lỗi:**
- Nếu thanh tiến trình dừng lại lâu quá 5 phút → kiểm tra internet.
- Nếu hiện "Quá thời gian (10 phút)" → đóng app, kiểm tra mạng, chạy lại RUN.bat.
- Nếu hiện "Không chạy được" → có thể không có quyền Admin. Click phải RUN.bat → "Run as administrator".
- Nếu hiện "Cài xong nhưng không tìm thấy openclaw" → đóng app, chạy lại RUN.bat.

---

## Bước 2: Wizard — Thiết Lập Ban Đầu

**Thời gian: 3-5 phút**

Sau khi cài đặt xong và app khởi động lại, màn hình Wizard hiện ra với 6 bước (6 chấm tròn ở trên).

### Màn hình 1/6: Thông tin cơ bản

[Ảnh: Màn hình "Chào mừng đến với MODOROClaw!" với các ô nhập]

Điền các thông tin sau:

| Trường | Điền gì | Ví dụ |
|---|---|---|
| **Tên của bạn** | Tên CEO/chủ doanh nghiệp | Họ và tên đầy đủ |
| **Tên công ty / cửa hàng** | Tên công ty (không bắt buộc) | Công ty / cửa hàng của anh/chị |
| **Khung giờ nhận báo cáo** | Giờ CEO muốn nhận báo cáo | 07:00 (mặc định) |

- Muốn thêm nhiều khung giờ báo cáo: nhấn **+ Thêm khung giờ** (tối đa 5 khung).
- Phổ biến: thêm 07:00 (sáng) và 17:00 (chiều).

Nhấn **Tiếp tục**.

### Màn hình 1B/6: Lĩnh vực và phong cách

[Ảnh: Màn hình "Lĩnh vực & phong cách" với dropdown và radio buttons]

| Trường | Hướng dẫn |
|---|---|
| **Lĩnh vực kinh doanh** | Chọn từ dropdown: Bất động sản, F&B, Thương mại, Dịch vụ, Giáo dục, Công nghệ, Sản xuất, hoặc Khác |
| **Phong cách giao tiếp** | Chọn 1 trong 3: "Chuyên nghiệp — lịch sự" (B2B), "Thân thiện — gần gũi" (F&B, bán lẻ), "Ngắn gọn — hiệu quả" |
| **Xưng hô với khách hàng** | Chọn 1: "Em — Anh/Chị" (phổ biến nhất), "Tôi — Quý khách" (trang trọng), "Mình — Bạn" (trẻ trung) |
| **Trợ lý gọi bạn là** | Nhập cách bot xưng hô với CEO | anh, chị, sếp, thầy, cô, giám đốc |

> **Gợi ý:** Hầu hết khách chọn "Thân thiện — gần gũi" + "Em — Anh/Chị". Trừ khi khách làm B2B hoặc bất động sản thì chọn "Chuyên nghiệp".

Nhấn **Tiếp tục**.

---

## Bước 3: Thiết Lập AI (Ollama + 9Router)

**Thời gian: 3-5 phút**

### Màn hình 2/6: Kết nối trí tuệ nhân tạo

[Ảnh: Màn hình "Kết nối trí tuệ nhân tạo" với 3 bước]

#### Bước 3.1: Tạo tài khoản Ollama

1. Nhấn nút **Mở trang Ollama** → trình duyệt mở ra trang ollama.com.
2. Nhấn **Sign In** góc trên bên phải.
3. Đăng nhập bằng tài khoản Google hoặc GitHub.
   - Nên dùng email của khách hoặc email công ty khách.

[Ảnh: Trang ollama.com với nút Sign In]

#### Bước 3.2: Lấy API Key

1. Quay lại app MODOROClaw, nhấn nút **Mở trang API Keys** → trình duyệt mở ra trang ollama.com/settings/keys.
2. Nhấn nút **New API Key** màu xanh.
3. Đặt tên bất kỳ (ví dụ: "MODOROClaw") → nhấn **Create**.
4. Một dòng key dài hiện ra (dạng `sk-...` hoặc tương tự) → **Copy toàn bộ dòng key đó**.

[Ảnh: Trang API Keys của Ollama với nút New API Key và dòng key vừa tạo]

5. Quay lại app MODOROClaw, dán key vào ô **"Dán Ollama API Key vào đây"**.

#### Bước 3.3: Thiết lập AI tự động

1. Nhấn nút **Thiết lập AI** (nút xanh).
2. Chờ vài giây.
3. Khi thành công → hiện dòng xanh "Thiết lập thành công! Ollama đã được kết nối."

[Ảnh: Thông báo "Thiết lập thành công! Ollama đã được kết nối."]

> **Lưu ý:** Hệ thống tự động tạo combo AI tên "main" với model mặc định `ollama/qwen3.5` và tạo API key nội bộ cho 9Router. Không cần làm gì thêm.

**Nếu muốn thêm AI mạnh hơn (tùy chọn, có thể làm sau):**
- Nhấn nút **Mở trang quản lý AI (nâng cao)** → trình duyệt mở trang 9Router (localhost:20128).
- Ở đây có thể thêm provider mới (Codex, iFlow, v.v.) và thêm model vào combo "main".
- Bình thường không cần làm bước này khi cài đặt lần đầu.

Nhấn **Tiếp tục**.

**Xử lý lỗi:**
- "Lỗi: Không xác định" → Kiểm tra lại API key có copy đúng không, thử dán lại.
- Nếu vẫn lỗi → thử đăng nhập lại Ollama, tạo key mới.

---

## Bước 4: Thiết Lập Telegram

**Thời gian: 3-5 phút**

### Màn hình 3/6: Kết nối Telegram

[Ảnh: Màn hình "Kết nối Telegram" với 2 bước]

#### Bước 4.1: Tạo bot Telegram qua BotFather

Làm trên điện thoại hoặc máy tính của khách:

1. Mở app **Telegram**.
2. Tìm kiếm **@BotFather** (có dấu tích xanh).
3. Nhấn **Start** hoặc gửi `/start`.
4. Gửi tin nhắn: `/newbot`
5. BotFather hỏi tên bot → nhập tên, ví dụ: `Tro Ly MODORO`
6. BotFather hỏi username → nhập tên không dấu, kết thúc bằng `bot`, ví dụ: `modoro_assistant_bot`
7. BotFather gửi lại một **dòng token rất dài** dạng: `7123456789:AAHk5...` → **Copy toàn bộ dòng đó**.

[Ảnh: Cuộc trò chuyện với BotFather, highlight dòng token]

8. Quay lại app MODOROClaw, dán token vào ô **"Dán Bot Token vào đây"**.

#### Bước 4.2: Lấy User ID của khách

Vẫn trên Telegram của khách:

1. Tìm kiếm **@userinfobot**.
2. Nhấn **Start** hoặc gửi `/start`.
3. Bot trả về thông tin, trong đó có một **dãy số** (ví dụ: `123456789`) → **Copy dãy số đó**.

[Ảnh: Cuộc trò chuyện với @userinfobot, highlight dãy số User ID]

4. Quay lại app MODOROClaw, dán vào ô **"Dán User ID vào đây"** (chỉ gồm số, ví dụ: `123456789`).

#### Bước 4.3: Test kết nối

**QUAN TRỌNG — Làm bước này trước khi test:**

1. Trên Telegram của khách, tìm bot vừa tạo (tên đã đặt ở bước 4.1).
2. Gửi tin nhắn `/start` cho bot đó.
3. Quay lại app MODOROClaw, nhấn nút **Test kết nối Telegram**.
4. Nếu thành công → hiện xanh "Thành công! Kiểm tra Telegram — bot vừa gửi tin nhắn cho bạn."
5. Kiểm tra Telegram của khách — phải thấy tin nhắn từ bot.

[Ảnh: Nút Test và kết quả "Thành công!"]

**Xử lý lỗi khi test:**
- "Không kết nối được" → Kiểm tra:
  - Bot Token có copy đúng không? (Phải bao gồm cả phần số và phần sau dấu `:`)
  - User ID có đúng không? (Chỉ gồm số, không có chữ)
  - Đã gửi `/start` cho bot chưa? (Bắt buộc phải gửi trước khi test)
- Nếu vẫn lỗi → tạo lại bot mới với BotFather.

Nhấn **Tiếp tục**.

---

## Bước 5: Thiết Lập Zalo

**Thời gian: 2-3 phút**

### Màn hình 4/6: Kết nối Zalo

[Ảnh: Màn hình "Kết nối Zalo" với nút "Đăng nhập Zalo"]

#### Bước 5.1: Quét QR đăng nhập Zalo

1. Nhấn nút **Đăng nhập Zalo** trong app MODOROClaw.
2. Chờ vài giây → mã QR hiện ra trên màn hình.

[Ảnh: Mã QR Zalo hiện trong app MODOROClaw]

3. Mở app **Zalo trên điện thoại** của khách.
4. Vào phần **Quét QR** (góc trên bên phải màn hình chính của Zalo).
5. Quét mã QR trên màn hình máy tính.
6. Xác nhận đăng nhập trên điện thoại.
7. Khi thành công → app hiện dấu tích xanh "Zalo đã kết nối thành công!"

[Ảnh: Thông báo "Zalo đã kết nối thành công!" với dấu tích xanh]

> **Lưu ý:** Nếu mã QR hết hạn (quá 2 phút) → nhấn nút **Làm mới mã QR** và quét lại.

#### Bước 5.2: Chọn chế độ Zalo

Hỏi khách muốn bot hoạt động thế nào trên Zalo và chọn tương ứng:

| Chế độ | Mô tả | Nên chọn khi |
|---|---|---|
| **Tự động trả lời** (mặc định) | Bot tự reply khách hàng. Vấn đề phức tạp gửi về Telegram cho CEO. | Khách muốn bot tự động xử lý |
| **Chỉ đọc** | Bot đọc tin nhắn, báo qua Telegram. Không tự trả lời. | Khách muốn kiểm soát hoàn toàn |
| **Tóm tắt cuối ngày** | Đọc tất cả, gửi tổng hợp 1 lần/ngày qua Telegram. | Khách chỉ cần biết tổng quan |

- Nếu chọn "Tóm tắt cuối ngày" → sẽ hiện thêm ô chọn giờ gửi (mặc định 18:00).

[Ảnh: 3 lựa chọn chế độ Zalo]

> **Gợi ý:** Hầu hết khách chọn **"Tự động trả lời"**. Đây là chế độ mạnh nhất.

#### Bước 5.3: Hoàn tất thiết lập

Nhấn nút **Hoàn tất** (dấu tích xanh).

Hệ thống sẽ:
1. Lưu thông tin Telegram (token, user ID).
2. Kết nối AI (9Router provider).
3. Cá nhân hóa trợ lý (lĩnh vực, phong cách, xưng hô).
4. Thiết lập lịch báo cáo.
5. Lưu chế độ Zalo.

Khi xong → chuyển sang màn hình "Xong rồi!" với tổng kết.

[Ảnh: Màn hình "Xong rồi!" với tổng kết thông tin]

Nhấn **Khởi động trợ lý** → app chuyển sang Dashboard chính.

---

## Bước 6: Upload Tài Liệu Qua Knowledge Tab

**Thời gian: 5-10 phút**

Sau khi wizard hoàn tất và Dashboard hiện lên, cần upload tài liệu cho bot. Đây là bước quan trọng nhất để bot trả lời chính xác.

### 6.1. Mở Dashboard → Knowledge

1. Trong app MODOROClaw, click vào tab **Knowledge** trên sidebar.
2. Có 3 danh mục: **Công ty**, **Sản phẩm**, **Nhân viên**.

### 6.2. Upload tài liệu công ty

1. Click vào mục **Công ty**.
2. Nhấn nút **Upload** → chọn file PDF chứa thông tin công ty (địa chỉ, giờ mở cửa, chính sách, ngân hàng...).
3. Bot tự đọc PDF và trích xuất nội dung. Không cần điền tay.

### 6.3. Upload tài liệu sản phẩm

1. Click vào mục **Sản phẩm**.
2. Upload file PDF bảng giá, catalog, hoặc danh sách SP/dịch vụ.
3. Bot tự đọc và trả lời khách dựa trên tài liệu đã upload.

### 6.4. Upload tài liệu nhân viên (tùy chọn)

1. Click vào mục **Nhân viên** nếu khách muốn bot biết thông tin nhân sự.
2. Upload file PDF danh sách nhân viên, phân công, ca trực...

> **QUAN TRỌNG:** CEO upload PDF vào Dashboard → Knowledge → bot tự đọc và trả lời khách dựa trên tài liệu đã upload. Upload càng chi tiết, bot trả lời càng chính xác.

---

## Bước 7: Test Thử

**Thời gian: 5 phút**

### 7.1. Test Telegram

1. Trên điện thoại/máy tính của khách, mở Telegram.
2. Vào bot đã tạo (tìm theo tên đã đặt ở bước 4.1).
3. Gửi thử tin nhắn, ví dụ: `Xin chao` hoặc `Bao cao`.
4. Chờ 10-30 giây → bot phải trả lời.

[Ảnh: Bot trả lời tin nhắn trên Telegram]

**Nếu bot không trả lời:**
- Kiểm tra Dashboard trên app MODOROClaw → phải hiện "Đang chạy" (trạng thái xanh).
- Nếu hiện "Đã dừng" → nhấn nút khởi động lại.
- Xem log: mở file `claw\logs\openclaw.log` để kiểm tra lỗi.

### 7.2. Test Zalo (nếu đã chọn chế độ "Tự động trả lời")

1. Dùng một điện thoại khác (hoặc nhờ đồng nghiệp) gửi tin nhắn Zalo đến số/tài khoản Zalo của khách.
2. Ví dụ: gửi "Cho mình hỏi giá sản phẩm X"
3. Chờ 10-30 giây → bot phải tự động trả lời trên Zalo.
4. Đồng thời, CEO nhận thông báo trên Telegram về tin nhắn Zalo.

[Ảnh: Bot trả lời tự động trên Zalo]

> **Lưu ý:** Lần đầu bot có thể trả lời chậm (30-60 giây) vì AI cần "khởi động". Các lần sau nhanh hơn.

### 7.3. Kiểm tra báo cáo tự động (tùy chọn)

- Nếu đã đặt lịch báo cáo lúc 07:00 và 17:00, có thể đợi đến giờ đó hoặc kiểm tra bằng cách gửi "bao cao" trên Telegram.

---

## Bước 8: Bàn Giao Cho Khách

**Thời gian: 5-10 phút**

### 8.1. Hướng dẫn CEO các thao tác cơ bản

Giải thích cho khách:

1. **Khởi động hệ thống:** Nhấn đôi chuột vào `RUN.bat` trên Desktop. App sẽ tự động chạy.
2. **Tắt hệ thống:** Click phải icon tôm hùm (tray icon) dưới thanh taskbar → chọn **Thoát**.
3. **Nhận báo cáo:** Bot tự động gửi báo cáo vào khung giờ đã thiết lập trên Telegram.
4. **Ra lệnh cho bot trên Telegram:** Gửi tin nhắn bất kỳ cho bot. Ví dụ:
   - "Báo cáo doanh thu hôm qua"
   - "Liệt kê cuộc hẹn hôm nay"
   - "Tóm tắt tin nhắn Zalo chưa đọc"
5. **Zalo:** Bot tự động đọc và trả lời (tùy chế độ đã chọn). Vấn đề phức tạp sẽ được chuyển về Telegram cho CEO xử lý.

### 8.2. Những điều khách cần biết

- **Máy tính phải bật:** Bot chỉ hoạt động khi máy tính bật và app MODOROClaw đang chạy.
- **Internet:** Cần có kết nối internet để bot hoạt động.
- **Cập nhật thông tin:** Khi có sản phẩm mới hoặc thay đổi giá, upload PDF mới vào Dashboard → Knowledge. Bot tự cập nhật.
- **Liên hệ hỗ trợ:** Nếu có vấn đề, liên hệ MODORO qua [điền kênh hỗ trợ của MODORO].

### 8.3. Để lại cho khách

- Folder `claw` trên Desktop (đã setup xong).
- Tài khoản Telegram với bot đã hoạt động.
- Tài khoản Zalo đã kết nối.
- Tài khoản Ollama (email + mật khẩu) — nên ghi lại cho khách.

---

## Xử Lý Sự Cố

### Lỗi thường gặp và cách fix

| Lỗi | Nguyên nhân | Cách fix |
|---|---|---|
| **RUN.bat flash rồi đóng** | Chưa có Node.js và không tải được | Cài Node.js thủ công từ https://nodejs.org (chọn bản LTS), rồi chạy lại RUN.bat |
| **"Mã cài đặt không đúng"** | Nhập sai mã | Thử lại: `MODORO-2026`, `MODORO-INSTALL`, hoặc `MODORO-SETUP` |
| **Cài đặt bị treo** | Mạng yếu hoặc bị firewall chặn | Kiểm tra internet. Thử tắt firewall/antivirus tạm thời rồi chạy lại |
| **"Cài xong nhưng không tìm thấy openclaw"** | PATH chưa cập nhật | Đóng app, đóng CMD, chạy lại RUN.bat. Nếu vẫn lỗi, restart máy rồi thử lại |
| **Thiết lập AI thất bại** | Ollama API key sai hoặc hết hạn | Vào ollama.com/settings/keys, tạo key mới, dán lại |
| **Test Telegram thất bại** | Chưa gửi /start cho bot | Mở Telegram, tìm bot, gửi `/start`, rồi test lại |
| **Test Telegram: "Không kết nối được"** | Token sai hoặc User ID sai | Kiểm tra lại: token từ BotFather (rất dài, có dấu `:`), User ID từ @userinfobot (chỉ gồm số) |
| **Zalo QR không hiện** | openzca chưa cài hoặc lỗi | Chờ thêm 10 giây. Nếu vẫn không hiện, nhấn "Làm mới mã QR". Nếu vẫn lỗi, restart app |
| **Zalo QR hết hạn** | Quá 2 phút chưa quét | Nhấn **Làm mới mã QR** và quét lại |
| **Bot không trả lời (sau khi setup xong)** | Gateway chưa sẵn sàng | Đợi 30-60 giây. Nếu quá 2 phút, kiểm tra Dashboard. Nếu "Đã dừng" → khởi động lại |
| **Bot trả lời sai thông tin** | Chưa upload tài liệu vào Knowledge | Mở Dashboard → Knowledge → upload PDF công ty và sản phẩm |
| **App bị lỗi nặng, muốn làm lại** | Lỗi config | Chạy **SOFT-RESET.bat** (chỉ xóa config, giữ plugin). Rồi chạy RUN.bat để setup lại từ wizard |
| **Muốn xóa sạch và cài lại từ đầu** | Reset hoàn toàn | Chạy **RESET.bat** (xóa tất cả: openclaw, 9router, Zalo session, config, logs). Rồi chạy RUN.bat |

### Các file reset

| File | Tác dụng | Khi nào dùng |
|---|---|---|
| **SOFT-RESET.bat** | Xóa config (openclaw.json, 9router db.json, Zalo session). Giữ nguyên openclaw và 9router binary. | Muốn setup lại từ wizard mà không cần cài lại |
| **RESET.bat** | Xóa tất cả: uninstall openclaw + 9router, xóa .openclaw, xóa .openzca, xóa 9router config, xóa logs | Máy bị lỗi nặng, muốn làm lại sạch từ đầu |

### Kiểm tra log khi gặp lỗi

- **OpenClaw log:** `claw\logs\openclaw.log`
- **9Router log:** `claw\logs\9router.log`
- **Zalo log:** `claw\logs\openzca.log`
- **OpenClaw config:** `%USERPROFILE%\.openclaw\openclaw.json`
- **9Router config:** `%APPDATA%\9router\db.json`

Mở các file log bằng Notepad để xem lỗi chi tiết. Chụp màn hình gửi cho đội kỹ thuật MODORO nếu cần hỗ trợ.

---

## Tổng Kết Luồng Cài Đặt

```
USB copy folder claw vao Desktop
         |
    Chay RUN.bat
         |
  [Chua co Node.js?] → Tu dong cai Node.js
         |
    npm install (lan dau)
         |
    Man hinh "Cai dat lan dau"
         |
    Nhap ma: MODORO-2026
         |
    Nhan "Cai dat tu dong" → cai openclaw, 9router, openzca (2-5 phut)
         |
    "Cai dat thanh cong!" → Nhan "Tiep tuc" → App khoi dong lai
         |
    Wizard Buoc 1: Ten, cong ty, gio bao cao
         |
    Wizard Buoc 1B: Linh vuc, phong cach, xung ho
         |
    Wizard Buoc 2: Tao tai khoan Ollama → Lay API Key → Thiet lap AI
         |
    Wizard Buoc 3: Tao bot Telegram → Lay User ID → Test
         |
    Wizard Buoc 4: Quet QR Zalo → Chon che do → Hoan tat
         |
    Man hinh "Xong roi!" → Nhan "Khoi dong tro ly"
         |
    Dashboard chinh → Upload PDF vao Knowledge tab
         |
    Test Telegram + Zalo → Ban giao cho khach
```

---

*Tài liệu này được tạo bởi MODORO Tech Corp. Phiên bản: 2026-04-06.*
