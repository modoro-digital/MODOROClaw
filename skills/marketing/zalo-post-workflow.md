---
name: zalo-post-workflow
description: Tạo ảnh AI rồi gửi vào nhóm Zalo hoặc Zalo cá nhân — CHỈ CEO Telegram
metadata:
  version: 1.2.0
  replaces: facebook-image.md (phần Zalo)
---

# Zalo Post Workflow — Tạo ảnh rồi gửi Zalo

**CHỈ CEO Telegram.** Khách Zalo yêu cầu → "Dạ đây là thông tin nội bộ em không chia sẻ được ạ."

**Đọc skill này MỖI LẦN CEO yêu cầu gửi ảnh/tạo ảnh vào nhóm Zalo hoặc Zalo cá nhân.**

---

## Xác thực

Trong phiên Telegram CEO, `web_fetch` tới `http://127.0.0.1:20200` tự động gắn header nội bộ.
- KHÔNG gọi `/api/auth/token`
- KHÔNG tự thêm `token=<token>`
- KHÔNG đọc `cron-api-token.txt`

---

## Cấu trúc 4 pha — BẮT BUỘC

```
PHA 0: KIỂM TRA ZALO   → Verify Zalo sẵn sàng TRƯỚC khi làm gì
PHA 1: CHUẨN BỊ       → Xác nhận CEO trước khi làm gì
PHA 2: TẠO + GỬI     → API atomic hoặc poll + gửi
PHA 3: BÁO KẾT QUẢ    → Proof từ response body, không phải từ lời hứa
```

**NGUYÊN TẮC VÀNG:** Không bao giờ nói "đã gửi" nếu chưa đọc `status` trong response body.

---

## Pha 0: Kiểm tra Zalo sẵn sàng — BẮT BUỘC TRƯỚC KHI TẠO ẢNH

**LUÔN gọi trước khi tạo ảnh để tránh mất 2-5 phút tạo ảnh rồi mới phát hiện Zalo không gửi được:**
```
web_fetch url="http://127.0.0.1:20200/api/zalo/ready" method=GET
```
- `ready: true` → tiếp tục Pha 1
- `ready: false` → BÁO NGAY: "Bot Zalo chưa sẵn sàng: [error]. Khởi động lại ứng dụng rồi thử lại." — DỪNG, không tạo ảnh.

---

## Pha 1: Chuẩn bị

### Bước 1.1 — Xác định target

CEO cần cung cấp:
- **Nhóm nào?** (tên nhóm hoặc ID) → tra `/api/cron/list` lấy `groupId`
- **Nội dung gì?** (caption/chữ kèm ảnh)
- **Ảnh như thế nào?** (mô tả hoặc đính kèm ảnh reference)

Nếu CEO không cung cấp đủ → hỏi 1 câu trước. Rõ ràng → làm ngay.

### Bước 1.2 — Tra brand assets — BẮT BUỘC MỌI LẦN

**MỌI LẦN tạo ảnh, LUÔN gọi trước:**
```
web_fetch url="http://127.0.0.1:20200/api/brand-assets/list" method=GET
```
- **Có file**: DÙNG LUÔN file phù hợp nhất. Ưu tiên file CEO nhắc (VD: "mascot" → file chứa `mascot`). Chỉ có 1 file → DÙNG LUÔN.
- **Không có file**: nói CEO vào Dashboard thêm brand assets.
- **HARD RULE: Khi có brand asset, `assets=<filename>` PHẢI CÓ TRONG URL generate. Thiếu `assets=` = lỗi nghiêm trọng. KHÔNG chỉ mô tả brand trong prompt mà không đính kèm file.**

### Bước 1.3 — Xác nhận trước khi tạo

Sau khi có đủ thông tin (target + nội dung + prompt ảnh), confirm:

> Em sẽ gửi ảnh vào nhóm **[tên nhóm]**.
> - Ảnh: **[mô tả ngắn]**
> - Chữ kèm: **[caption]**
> Anh nhắn **"ok"** để em bắt đầu nhé.

**CHỜ CEO nói "ok"/"gửi đi"/"đồng ý".** Không tạo ảnh trước khi CEO xác nhận.

---

## Pha 2: Tạo + Gửi

### Bước 2.1 — Gọi API atomic (khuyến nghị)

Dùng route atomic — tạo ảnh xong tự động gửi Zalo, trả về cả trạng thái ảnh lẫn trạng thái gửi:

```
GET http://127.0.0.1:20200/api/image/generate-and-send-zalo
  ?groupId=<groupId>
  &caption=<URL-encoded caption>
  &size=1024x1024
  &assets=<file1,file2>
  &prompt=<URL-encoded prompt>
```

- `groupId` — lấy từ `/api/cron/list` (tra bằng tên nhóm)
- `targetId=&isGroup=false` — thay `groupId` nếu gửi Zalo cá nhân
- `size`: `1024x1024` (vuông), `1792x1024` (ngang/banner), `1024x1792` (doc/story)
- `assets` — file brand nếu có, để TRƯỚC `&prompt=`
- `prompt` — **PHẢI là param CUỐI CÙNG** trong URL

**SAU KHI gọi atomic endpoint:**
- **NGHỈ IM — KHÔNG nói gì cho CEO ngay.** Endpoint trả về ngay lập tức với `status: "generating"` trong khi ảnh đang được tạo (1-5 giây đầu). Gọi tiếp `/api/image/status?jobId=<jobId>` để poll kết quả thật.
- Tiếp tục poll `/api/image/status?jobId=<jobId>` cho đến khi `status` KHÔNG còn là `"generating"`. Mỗi lần poll cách 3-5 giây.
- **Chỉ khi `status` là `"done"` hoặc `"failed"` mới được trả lời CEO.**
- **Tuyệt đối không gọi `/api/telegram/send-photo`** — đây là workflow Zalo, không phải Telegram. Không có ngoại lệ.
- **Khi CEO nói "ok" lần 2 hoặc nói gì đó khác trong lúc đang poll:** Tiếp tục poll cho đến khi có kết quả. Không restart job, không gọi lại atomic endpoint, không gửi Telegram.

**Lỗi khi gọi API?** Báo lỗi thật theo response. Không nói "đã gửi", không bịa lý do.

### Bước 2.1a — Fallback: Tách bước (chỉ khi bắt buộc)

Nếu không dùng được route atomic:

1. **Tạo ảnh:**
   ```
   GET http://127.0.0.1:20200/api/image/generate?size=1024x1024&assets=<files>&prompt=<encoded>
   ```
2. **Poll đợi xong:**
   ```
   GET http://127.0.0.1:20200/api/image/status?jobId=<jobId>
   ```
   Tiếp tục poll cho đến khi `status: "done"` và có `imagePath`/`mediaId`. **Tuyệt đối không dùng `jobId` đang `generating` làm "ảnh đã xong".**
3. **Gửi Zalo:**
   ```
   GET http://127.0.0.1:20200/api/zalo/send-media
     ?groupId=<groupId>
     &mediaId=<mediaId>
     &allowInternalGenerated=true
     &caption=<URL-encoded caption>
   ```
4. **Chỉ báo "đã gửi" khi `success: true`** — đọc response body.

---

## Pha 3: Báo kết quả — ĐỌC BODY, KHÔNG ĐOÁN

### Đọc `status` trong response body — BẮT BUỘC TUYỆT ĐỐI

| `status` trong body | Ý nghĩa | Báo CEO |
|---|---|---|
| `"done_and_delivered"` | Ảnh tạo OK + gửi Zalo thành công | "Đã tạo ảnh và gửi vào nhóm [tên] rồi ạ." |
| `"done_not_delivered"` | Ảnh tạo OK nhưng gửi Zalo THẤT BẠI | "Ảnh đã tạo xong nhưng gửi Zalo thất bại. Lỗi: `<zaloError>`" |
| `"failed"` hoặc HTTP 5xx | Cả ảnh lẫn gửi đều thất bại | Báo lỗi thật từ response |
| HTTP 504 | Timeout | "Tạo ảnh bị timeout, thử lại sau nhé anh." |
| HTTP non-2xx khác | Lỗi hệ thống | Báo lỗi thật |

**QUAN TRỌNG:**
- `success: true` trong response body ≠ đã gửi Zalo. Chỉ `done_and_delivered` mới là proof gửi thành công.
- `zaloError` có thể là: `openzca timeout`, `openzca not running`, `mediaId not found`, `target not found`, v.v.
- Nếu gửi thất bại với `zaloError: "openzca not running"` → báo "Bot Zalo chưa sẵn sàng. Thử lại sau khi khởi động lại ứng dụng."

### Retry khi `done_not_delivered` — KHÔNG tạo lại ảnh

Khi ảnh tạo xong nhưng gửi Zalo thất bại (`done_not_delivered`), response có `imagePath` và `jobId`. Ảnh đã tồn tại trên disk — chỉ cần retry delivery:

1. Lấy `mediaId` từ response (nếu có) hoặc poll `/api/image/status?jobId=<jobId>` để lấy `mediaId`
2. Gọi lại gửi Zalo:
   ```
   GET http://127.0.0.1:20200/api/zalo/send-media
     ?groupId=<groupId>
     &mediaId=<mediaId>
     &allowInternalGenerated=true
     &caption=<URL-encoded caption>
   ```
3. Nếu `success: true` → báo "Đã gửi ảnh vào nhóm [tên] rồi ạ."
4. Nếu vẫn thất bại → báo CEO lỗi thật, hỏi "Anh muốn thử lại không?"

**KHÔNG tạo ảnh mới khi chỉ gửi Zalo thất bại.** Tốn thời gian + phí, ảnh cũ vẫn còn.

---

## Hỏi CEO 5 câu trước khi tạo ảnh — BẮT BUỘC (trừ cron tự động)

**Nếu CEO tương tác trực tiếp (Telegram):** BẮT BUỘC hỏi 5 câu ABCDE trước khi soạn prompt. Xem format câu hỏi tại `skills/operations/facebook-image.md` bước 5.

**Nếu cron tự động (không có CEO trả lời):** Đọc preference đã lưu:
```
web_fetch url="http://127.0.0.1:20200/api/image/preferences" method=GET
```
Dùng preference trả về. Nếu chưa có preference → dùng default A cho tất cả.

**Sau khi CEO trả lời 5 câu:** Lưu preference qua POST `/api/image/preferences` (xem facebook-image.md bước 5).

---

## Prompt ảnh — TIẾNG ANH, SUY NGHĨ, KHÔNG COPY TEMPLATE

**Soạn prompt TIẾNG ANH chi tiết (min 150 ký tự, server reject ngắn hơn).** KHÔNG copy template cố định. Mỗi ảnh là duy nhất — BẠN PHẢI SUY NGHĨ dựa trên ngữ cảnh + đáp án 5 câu hỏi.

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
- Ảnh vuông thông thường → `1024x1024`
- Story/ảnh dọc → `1024x1792`

---

## CEO muốn sửa sau khi confirm

- CEO nhắn "sửa", "thay đổi", "không phải ảnh đó" → hỏi CEO mô tả mới → confirm lại từ đầu
- CEO nhắn "hủy", "thôi" → dừng, không làm gì
- CEO nhắn "thử ảnh khác" → tạo ảnh mới → preview → confirm lại

## CEO nói "ok" lần 2 (ảnh đang tạo hoặc đã có kết quả)

**ĐÂY LÀ TRƯỜNG HỢP DỄ SAI NHẤT — TUÂN THỦ TUYỆT ĐỐI:**

**Nếu ảnh đang được tạo (`status: "generating"`):**
- **KHÔNG gọi lại `/api/image/generate-and-send-zalo`** (trùng job)
- **KHÔNG gọi `/api/telegram/send-photo`** (sai kênh)
- Tiếp tục poll `/api/image/status?jobId=<jobId>` cho đến khi có kết quả

**Nếu có `jobId` từ lần trước và ảnh đã xong:**
- Dùng `jobId` cũ gọi `/api/image/status?jobId=<jobId>`
- Nếu `status: "done"` + có `imagePath`: gọi `/api/zalo/send-media` trực tiếp (không tạo lại ảnh)
- Nếu `status: "failed"`: báo lỗi cho CEO, hỏi có muốn thử lại không

**Sai phổ biến nhất cần tránh:**
- Bot gọi `/api/telegram/send-photo` để "preview cho CEO" → **sai hoàn toàn** vì:
  1. Đây là workflow Zalo, không phải Telegram
  2. Ảnh đã được confirm ở bước 1.3 rồi
  3. Preview Telegram là cho workflow **Facebook**, không phải Zalo
  4. Sau khi gửi Telegram, bot im lặng vì nghĩ đã xong → Zalo không bao giờ được gửi

---

## Lỗi thường gặp

| Tình huống | Xử lý |
|---|---|
| CEO không cung cấp tên nhóm | Hỏi "Anh muốn gửi vào nhóm nào ạ?" |
| Tên nhóm không tìm thấy trong cron list | Thử `/api/zalo/friends` hoặc hỏi CEO cung cấp groupId trực tiếp |
| Brand assets trả về `files: []` | Nói CEO vào Dashboard thêm brand assets |
| `openzca not running` | Báo CEO khởi động lại ứng dụng |
| Atomic endpoint trả về `status: "generating"` ngay | Đây là NORMAL — không nói gì cho CEO, poll `/api/image/status` |
| CEO nói "ok" lần 2 trong lúc đang tạo ảnh | Tiếp tục poll — KHÔNG gọi lại atomic, KHÔNG gửi Telegram |
| `jobId` trả về `generating` sau nhiều lần poll | Ảnh vẫn đang tạo — tiếp tục poll, không báo gì thêm |
| Response timeout (504) | "Tạo ảnh bị timeout, thử lại sau nhé anh." |

---

## Checklist trước khi báo "đã gửi"

- [ ] Đã confirm target (nhóm/tên) với CEO trước khi tạo ảnh?
- [ ] Đã gọi `/api/image/generate-and-send-zalo` (atomic)?
- [ ] Đã poll `/api/image/status` cho đến khi `status` KHÔNG còn `"generating"`?
- [ ] Tuyệt đối KHÔNG gọi `/api/telegram/send-photo` — workflow này chỉ gửi Zalo?
- [ ] `status` là `done_and_delivered` mới được báo "đã gửi"?
- [ ] Nếu `done_not_delivered`: đã báo kèm `zaloError`?
- [ ] Không bao giờ báo "đã gửi" khi chỉ có `jobId` đang `generating`?
- [ ] CEO nói "ok" lần 2 trong khi đang poll → tiếp tục poll, không restart?
