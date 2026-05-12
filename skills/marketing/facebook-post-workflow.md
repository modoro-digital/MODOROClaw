---
name: facebook-post-workflow
description: Tạo ảnh AI rồi đăng bài vào Facebook Fanpage — CHỈ CEO Telegram
metadata:
  version: 1.2.0
  replaces: facebook-image.md (phần Facebook)
---

# Facebook Post Workflow — Tạo ảnh rồi đăng Fanpage

**CHỈ CEO Telegram.** Khách Zalo yêu cầu → "Dạ đây là thông tin nội bộ em không chia sẻ được ạ."

**Đọc skill này MỖI LẦN CEO yêu cầu đăng bài Facebook, đăng ảnh fanpage, tạo ảnh đăng Facebook.**

---

## Xác thực

Trong phiên Telegram CEO, `web_fetch` tới `http://127.0.0.1:20200` tự động gắn header nội bộ.
- KHÔNG gọi `/api/auth/token`
- KHÔNG tự thêm `token=<token>`
- KHÔNG đọc `cron-api-token.txt`

---

## Cấu trúc 5 pha — BẮT BUỘC

```
PHA 0: KIỂM TRA TOKEN  → Verify Facebook token TRƯỚC khi làm gì
PHA 1: CHỌN ASSETS     → Brand assets hoặc không
PHA 2: TẠO ẢNH        → Generate + poll đến done
PHA 3: PREVIEW          → Gửi Telegram cho CEO xem trước
PHA 4: ĐĂNG            → Chỉ khi CEO xác nhận "ok"
```

**NGUYÊN TẮC VÀNG:**
- Ảnh chưa được CEO xác nhận → KHÔNG ĐĂNG.
- Không bao giờ nói "đã đăng" nếu chưa nhận được `id` hoặc `post_id` từ Facebook API.

---

## Pha 0: Kiểm tra token Facebook — BẮT BUỘC TRƯỚC KHI TẠO ẢNH

**LUÔN gọi trước khi tạo ảnh để tránh mất 2-5 phút tạo ảnh rồi mới phát hiện token hết hạn:**
```
web_fetch url="http://127.0.0.1:20200/api/fb/verify" method=GET
```
- `valid: true` → tiếp tục Pha 1
- `valid: false` → BÁO NGAY: "Kết nối Fanpage chưa sẵn sàng: [error]. Vào Dashboard > Facebook > Kết nối Fanpage để cập nhật token." — DỪNG, không tạo ảnh.

---

## Pha 1: Chọn Assets

### Bước 1.1 — Kiểm tra brand assets

CEO nói "dùng logo", "dùng mascot", "dùng ảnh sản phẩm", "theo brand", hoặc CEO gửi kèm ảnh:
```
web_fetch url="http://127.0.0.1:20200/api/brand-assets/list" method=GET
```
- **Có file**: dùng file phù hợp nhất. Ưu tiên file có tên CEO nhắc (VD: "mascot" → file chứa `mascot`).
- **Không có file**: nói "Anh chưa upload tài sản thương hiệu nào. Vào Dashboard > Facebook > Tài sản thương hiệu để thêm."
- **CEO gửi kèm ảnh reference**: dùng ảnh đó làm reference trong prompt, không cần gọi brand-assets/list.

### Bước 1.2 — Kết nối Fanpage (lần đầu)

Nếu CEO hỏi về kết nối Fanpage:

1. Tạo Meta App theo use case **"Tương tác với khách hàng trên Messenger"** tại https://developers.facebook.com/apps
2. Vào app vừa tạo → **"Tùy chỉnh trường hợp sử dụng"** → chọn **"Quản lý mọi thứ trên Trang"**
3. Bật **Business Asset User Profile Access** (BẮT BUỘC — không bật thì không mở được quyền ở bước 4)
4. Bật các quyền: `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`, `read_insights`
5. Vào Graph API Explorer → generate User Token với các quyền trên
6. Gọi `me/accounts?fields=id,name,tasks,access_token` để lấy Page Access Token
7. Paste Page Access Token vào Dashboard > Facebook > Kết nối Fanpage

**Nếu CEO paste token nhưng lỗi:** Kiểm tra xem token có đủ quyền (`pages_manage_posts`). Nếu Graph API Explorer chỉ hiện `business_management` + `pages_show_list` → chưa bật **Business Asset User Profile Access** ở bước 3.

**Nếu Pha 0 đã pass** — token verified, tiếp tục bình thường. Nếu `/api/fb/post` vẫn trả lỗi token sau đó (token hết hạn giữa chừng), báo CEO cập nhật trong Dashboard.

---

## Pha 2: Tạo ảnh

### Bước 2.1 — Confirm trước khi tạo

Sau khi có thông tin (caption, mô tả ảnh, có/không brand assets):

> Em sẽ tạo ảnh đăng Facebook cho anh:
> - Nội dung: **[caption]**
> - Mô tả ảnh: **[prompt mô tả]**
> - Brand assets: **[có / không]**
>
> Anh nhắn **"ok"** để em bắt đầu tạo ảnh nhé.

**CHỜ CEO nói "ok".** Không tạo ảnh trước.

### Bước 2.2 — Generate ảnh

```
GET http://127.0.0.1:20200/api/image/generate
  ?autoSendTelegram=false
  &size=1024x1024
  &assets=<file1,file2>
  &prompt=<URL-encoded prompt>
```

- **`autoSendTelegram=false` BẮT BUỘC** — workflow này tự poll + gửi preview riêng ở Pha 3, KHÔNG để server tự gửi
- `size`: `1024x1024` (vuông), `1792x1024` (ngang/banner), `1024x1792` (doc/story)
- `assets` để TRƯỚC `&prompt=`
- `prompt` — **PHẢI là param CUỐI CÙNG**

**Lỗi?** Báo lỗi thật. Không nói "đã tạo xong" nếu API lỗi.

### Bước 2.3 — Poll đợi ảnh xong

```
GET http://127.0.0.1:20200/api/image/status?jobId=<jobId>
```

Poll mỗi **15 giây**, tối đa **12 lần** (= ~180 giây). Mỗi lần gọi `web_fetch` tới URL trên.

**TUYỆT ĐỐI KHÔNG:** Dùng `jobId` đang `generating` làm "ảnh đã xong".

**Timeout (hết 12 lần poll mà vẫn `generating`):** "Tạo ảnh lâu hơn dự kiến, anh chờ thêm chút nhé — ảnh xong em gửi preview ngay." Sau đó gọi thêm 6 lần nữa (mỗi 15s). Nếu vẫn `generating` sau tổng 18 lần → "Tạo ảnh bị timeout, thử lại sau nhé anh."

---

## Pha 3: Preview cho CEO

Sau khi ảnh done, gửi preview qua Telegram:

```
GET http://127.0.0.1:20200/api/telegram/send-photo
  ?imagePath=<relative-path>
  &caption=<URL-encoded caption>
```

Sau đó báo CEO:

> Đây là preview ảnh đăng Facebook:
> **Caption:** [caption]
>
> - Nhắn **"ok"** / **"đăng đi"** → em đăng lên Fanpage
> - Nhắn **"sửa caption"** → em sửa chữ rồi gửi lại preview
> - Nhắn **"tạo ảnh khác"** → em tạo ảnh mới
> - Nhắn **"hủy"** / **"thôi"** → dừng, không đăng

---

## Pha 4: Đăng lên Fanpage

**CHỈ khi CEO xác nhận "ok" / "đăng đi" / "gửi đi".**

### Bước 4.1 — Lấy approvalNonce (BẮT BUỘC trước khi đăng)

```
GET http://127.0.0.1:20200/api/fb/post
  ?preview=true
  &imagePath=<relative-path>
  &message=<URL-encoded caption>
```

Response: `{ "approvalNonce": "abc123...", "expiresAt": "...", "pageId": "...", "pageName": "..." }`

### Bước 4.2 — Đăng bài với nonce

```
GET http://127.0.0.1:20200/api/fb/post
  ?approvalNonce=<nonce-tu-buoc-4.1>
  &imagePath=<relative-path>
  &message=<URL-encoded caption>
```

- `imagePath` — **PHẢI là path TƯƠNG ĐỐI** từ workspace (VD: `brand-assets/generated/img_xxx.png`)
- `message` — **PHẢI là param CUỐI CÙNG**
- `imagePath` + `message` PHẢI GIỐNG CHÍNH XÁC bước 4.1 (server so khớp fingerprint)
- Nếu thiếu `approvalNonce` hoặc nonce sai/hết hạn → HTTP 403

### Đọc response body — BẮT BUỘC

| Response | Ý nghĩa | Báo CEO |
|---|---|---|
| Có `id` hoặc `post_id` trong body | Đăng thành công | "Đã đăng bài lên Fanpage rồi ạ." |
| `HTTP 200 + success: false` hoặc `error` | Facebook từ chối (token hết hạn, thiếu quyền, ...) | Báo lỗi thật. Hướng dẫn CEO kiểm tra lại kết nối Fanpage. |
| HTTP 4xx/5xx khác | Lỗi hệ thống | Báo lỗi thật |
| HTTP 504 | Timeout | "Facebook bị timeout, thử lại sau nhé anh." |

### Lỗi token Fanpage

Nếu response báo token lỗi:
> "Kết nối Fanpage đã hết hạn. Vào Dashboard > Facebook > Kết nối Fanpage để cập nhật lại token."

---

## Chọn style ảnh — theo skill hoặc free-form

**Xem quy trình đầy đủ tại `skills/operations/facebook-image.md` bước 5 (skill-first flow).**

Tóm tắt: gọi `GET /api/image/skills` → CEO chọn skill hoặc mô tả tự do. KHÔNG hỏi 5 câu ABCDE trừ khi CEO đang tạo skill mới.

**Scheduled posts tự động:** Nếu prompt có `[SKILL: name]` → đọc skill. Không có → đọc `GET /api/image/preferences`. Không có preference → default A.

---

## Prompt ảnh — TIẾNG ANH, SUY NGHĨ, KHÔNG COPY TEMPLATE

**Soạn prompt TIẾNG ANH chi tiết (min 150 ký tự, server reject ngắn hơn).** KHÔNG copy template. Mỗi ảnh duy nhất — BẠN PHẢI SUY NGHĨ dựa trên ngữ cảnh + đáp án 5 câu hỏi.

**Khi dùng brand asset, prompt PHẢI bắt đầu bằng:**
`IMPORTANT: The attached reference image is a brand asset. Reproduce it EXACTLY as-is — same colors, same shapes, same text, same proportions, same style. Do NOT reinterpret, redesign, redraw, or reimagine it in any way. Place the EXACT original image into the composition.`

**Prompt PHẢI bao gồm:**
- Subject chi tiết (vật liệu, tư thế, context)
- Scene/environment cụ thể
- Lighting cụ thể (KHÔNG "good lighting" — phải nói rõ loại: soft key, rim, volumetric...)
- Color palette dùng mã HEX
- Composition (góc, rule of thirds, depth of field)
- Style/medium rõ ràng (từ đáp án câu 1)
- Typography nếu có text (từ đáp án câu 5)
- MỌI CHỮ TIẾNG VIỆT TRONG ẢNH PHẢI CÓ DẤU ĐẦY ĐỦ

**Size phù hợp:**
- Banner/quảng cáo → `1792x1024`
- Ảnh vuông → `1024x1024`
- Story/ảnh dọc → `1024x1792`

---

## CEO muốn sửa sau khi preview

| Tình huống | Hành động |
|---|---|
| "sửa caption" / "đổi chữ" | Sửa caption → gửi lại preview Telegram → chờ "ok" |
| "tạo ảnh khác" / "thử ảnh khác" | Tạo ảnh mới → preview → chờ "ok" |
| "đổi ảnh" / "không phải ảnh đó" | Tạo ảnh mới → preview → chờ "ok" |
| "hủy" / "thôi" / "không đăng nữa" | Dừng, không làm gì |
| "đăng đi" / "ok" / "gửi đi" | Gọi `/api/fb/post?preview=true` → lấy nonce → gọi `/api/fb/post?approvalNonce=...` → báo kết quả |

---

## Lỗi thường gặp

| Tình huống | Xử lý |
|---|---|
| Brand assets `files: []` | Nói CEO vào Dashboard thêm brand assets |
| API `/api/fb/post` trả lỗi token | Hướng dẫn CEO cập nhật Fanpage token |
| Ảnh không tạo được (`error`) | Báo lỗi thật, không nói "đã tạo" |
| Preview không gửi được | Báo lỗi, vẫn tiếp tục chờ CEO xác nhận caption để đăng |
| `jobId` trả về `generating` | Tiếp tục poll `/api/image/status` |
| Response timeout (504) | "Facebook bị timeout, thử lại sau nhé anh." |

---

## Checklist trước khi báo "đã đăng"

- [ ] Đã confirm với CEO trước khi tạo ảnh?
- [ ] Đã poll đến `status: "done"` trước khi dùng `imagePath`?
- [ ] Đã gửi preview Telegram trước khi đăng?
- [ ] Đã chờ CEO xác nhận "ok"/"đăng đi" trước khi gọi `/api/fb/post`?
- [ ] Đã đọc `id`/`post_id` trong response body?
- [ ] Nếu lỗi token: đã hướng dẫn CEO cập nhật Fanpage trong Dashboard?

---

## Lịch tự động đăng Facebook (Scheduled Posts)

CEO nói: "đăng Facebook mỗi sáng 9h", "tự động đăng bài mỗi ngày", "lịch đăng Facebook"...

### Tạo lịch

```
web_fetch "http://127.0.0.1:20200/api/fb/schedule/create?postTime=09:00&leadMinutes=120&prompt=<prompt-tạo-ảnh>&caption=<caption>&label=<tên>&imageSize=1024x1024"
```

- `postTime` (BẮT BUỘC): giờ đăng, dạng HH:MM (VD: `09:00`)
- `leadMinutes`: tạo ảnh trước bao nhiêu phút (mặc định 120 = 2 tiếng)
- `prompt`: prompt tạo ảnh (TIẾNG ANH, chi tiết)
- `caption`: nội dung bài đăng Facebook
- `assetNames`: brand assets dùng (JSON array, VD: `["mascot-removebg.png"]`)
- `autoPost`: `true` = tự đăng không cần duyệt (MẶC ĐỊNH: `false`)

### Flow tự động

1. **Trước giờ đăng** (leadMinutes): hệ thống tự tạo ảnh → gửi preview qua Telegram
2. **CEO duyệt**: reply "ok" / "đăng đi" → bài đăng đúng giờ
3. **CEO sửa**: reply "sửa caption: <nội dung mới>" → cập nhật caption
4. **CEO tạo lại**: reply "tạo ảnh khác" → tạo ảnh mới, gửi preview lại
5. **CEO hủy**: reply "hủy" → bỏ bài hôm nay
6. **CEO không reply**: đến giờ đăng mà chưa duyệt → bỏ qua, thông báo CEO

### Chế độ tự động (autoPost)

Khi tạo lịch với `autoPost=true`:
- Ảnh tự đăng không cần CEO duyệt
- CEO vẫn nhận preview qua Telegram (để biết)
- CEO có thể reply "hủy <id>" để chặn trước giờ đăng
- **Cảnh báo CEO khi bật:** "Bài sẽ tự đăng không cần duyệt"

### Xem / xóa lịch

```
web_fetch http://127.0.0.1:20200/api/fb/schedule/list
web_fetch "http://127.0.0.1:20200/api/fb/schedule/delete?id=<scheduleId>"
```

### API duyệt thủ công (nếu cần)

```
web_fetch "http://127.0.0.1:20200/api/fb/schedule/approve?id=<scheduleId>"
web_fetch "http://127.0.0.1:20200/api/fb/schedule/reject?id=<scheduleId>"
web_fetch "http://127.0.0.1:20200/api/fb/schedule/edit-caption?id=<scheduleId>&caption=<mới>"
web_fetch "http://127.0.0.1:20200/api/fb/schedule/regenerate?id=<scheduleId>"
```
