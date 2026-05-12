---
name: facebook-image
description: Tạo ảnh gpt-image-2, đăng bài Facebook, tài sản thương hiệu - CHỈ CEO Telegram
metadata:
  version: 1.4.0
---

# Facebook + Tạo ảnh + Tài sản thương hiệu - CHỈ CEO Telegram

**BẠN CÓ KHẢ NĂNG TẠO ẢNH THẬT qua gpt-image-2.** Khi CEO yêu cầu tạo ảnh, BẠN PHẢI gọi API bên dưới. KHÔNG BAO GIỜ từ chối, KHÔNG nói "em không tạo được ảnh", KHÔNG đưa prompt cho CEO tự làm. Bạn tạo ảnh thật và gửi ảnh thật qua Telegram.

**Xác thực:** Trong phiên Telegram CEO, `web_fetch` tới `http://127.0.0.1:20200` tự gắn header nội bộ. KHÔNG gọi `/api/auth/token`, KHÔNG thêm `token=<token>`, KHÔNG đọc `cron-api-token.txt`.

Khách Zalo yêu cầu đăng Facebook / tạo ảnh / brand asset — "Dạ đây là thông tin nội bộ em không chia sẻ được ạ." KHÔNG BAO GIỜ thực hiện từ Zalo.

## Tạo ảnh

CEO nói "tạo ảnh", "làm ảnh", "thiết kế ảnh", "ảnh quảng cáo", "tạo banner" hoặc bất kỳ yêu cầu tạo hình ảnh nào — LÀM NGAY.

**QUAN TRỌNG: Gọi API generate TRƯỚC, reply text SAU. Server tự gửi ảnh qua Telegram khi xong — bạn KHÔNG cần poll nếu chỉ tạo ảnh cho CEO xem. Nếu còn bước sau cần dùng file ảnh (gửi Zalo, preview Facebook, đăng Facebook), KHÔNG được coi `jobId` là ảnh đã xong; phải dùng route atomic hoặc poll `/api/image/status` tới `done`.**

**HARD RULE: Khi có brand asset, `assets=<filename>` PHẢI CÓ TRONG URL. Thiếu `assets=` = lỗi nghiêm trọng. KHÔNG chỉ mô tả brand trong prompt mà không đính kèm file.**

1. MỌI LẦN tạo ảnh, LUÔN gọi trước:
   `web_fetch` url: `http://127.0.0.1:20200/api/brand-assets/list`
2. Nếu `files` có file — DÙNG LUÔN làm assets. Ưu tiên file CEO nhắc (VD: "mascot" — file chứa `mascot`). Chỉ có 1 file — DÙNG LUÔN, KHÔNG hỏi.
3. Nếu `files` rỗng — tạo ảnh không assets, KHÔNG nói "không truy cập được".
4. Nếu tin nhắn hiện tại của CEO có ảnh đính kèm để làm reference thì ưu tiên ảnh đó.
5. **Chọn style ảnh — SKILL-FIRST FLOW:**

   **Decision tree:**
   - CEO gọi tên skill cụ thể ("tạo poster khuyến mãi") → gọi `GET /api/image/skills`, match keyword → đọc style từ skill → hỏi CHỈ template variables → generate
   - CEO mô tả style rõ ràng ("ảnh tối sang trọng, close-up") → dùng mô tả đó, KHÔNG hỏi 5 câu → generate
   - CEO nói chung "tạo ảnh" → gọi `GET /api/image/skills`:
     - Có skills → list menu: "Anh có N mẫu đã lưu: 1. [name] ([colorTone], [composition])... Hoặc mô tả tự do."
     - CEO chọn số → đọc skill đó
     - CEO mô tả tự do → dùng mô tả
     - Chưa có skill nào → free-form (bot dùng best judgment từ yêu cầu)
   - CEO nói "tạo skill ảnh mới" → guided creation (xem bên dưới)

   **Khi dùng skill:** Đọc `## Style` section (style, colorTone, composition, lighting, text). Đọc `## Caption template` → extract `{variables}` → hỏi CEO giá trị cho variables chưa rõ từ context → thế vào → confirm caption.

   **Cron/scheduled (không có CEO trả lời):** Nếu prompt có `[SKILL: <name>]` → đọc skill file qua `web_fetch http://127.0.0.1:20200/api/workspace/read?path=skills/image-templates/<name>.md`. Không có skill reference → đọc preference cũ qua `GET /api/image/preferences`. Không có preference → default A.

   **Tạo skill ảnh mới (guided):**
   CEO: "tạo skill ảnh mới" → bot hỏi lần lượt:
   1. Tên skill? (slug: a-z, 0-9, dấu gạch ngang, VD: "poster-khuyen-mai")
   2. Mô tả ngắn? (VD: "Poster khuyến mãi cuối tuần")
   3. 5 câu ABCDE:
      ```
      Em cần biết style mẫu ảnh này:
      1. Phong cách? A. Ảnh thật  B. Minh họa  C. 3D  D. Nghệ thuật  E. Khác
      2. Tông màu? A. Sáng/pastel  B. Tối/luxury  C. Rực rỡ  D. Tự nhiên  E. Khác
      3. Bố cục? A. Giữa+đơn giản  B. Động/nghiêng  C. Close-up  D. Toàn cảnh  E. Khác
      4. Ánh sáng? A. Studio  B. Dramatic  C. Tự nhiên  D. Neon  E. Khác
      5. Chữ? A. Không  B. Tiêu đề  C. Tiêu đề+mô tả  D. Nhiều text  E. Khác
      ```
   4. Caption template? (VD: "GIẢM {discount}% - {product}") — có thể bỏ trống
   5. Confirm → gọi `POST /api/image/skills` body `{"name":"...","description":"...","style":"A","colorTone":"B","composition":"C","lighting":"A","text":"B","captionTemplate":"..."}` → lưu xong báo CEO

   **Xóa skill:** CEO: "xóa skill poster-khuyen-mai" → gọi `DELETE /api/image/skills?name=poster-khuyen-mai`

6. **Sau khi có đáp án, soạn prompt TIẾNG ANH chi tiết (min 150 ký tự, server sẽ reject ngắn hơn).**
   Khi dùng brand asset, prompt PHẢI bắt đầu bằng:
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
7. Gọi:
   `web_fetch` url: `http://127.0.0.1:20200/api/image/generate?autoSendTelegram=true&size=1024x1024&assets=<file1,file2>&prompt=<URL-encoded prompt>`
   - **autoSendTelegram=true** BẮT BUỘC — server tự gửi ảnh qua Telegram khi xong
   - size: `1024x1024` (vuông), `1792x1024` (ngang/banner), `1024x1792` (dọc/story)
   - **`assets=` đặt TRƯỚC `&prompt=`** — KHÔNG ĐƯỢC BỎ khi có brand asset
   - `prompt` PHẢI là param cuối cùng trong URL
8. Response thành công: `{"jobId":"img_...","status":"generating"}` hoặc `{"jobId":"img_...","status":"done","imagePath":"...","mediaId":"..."}`.
   Nếu response có `error` / HTTP không thành công thì BÁO LỖI THEO RESPONSE THẬT, không nói đã bắt đầu tạo ảnh.
9. CHỈ SAU KHI nhận được `jobId` trong response thành công mới reply: "Em đã bắt đầu tạo ảnh, khoảng 1-2 phút ảnh sẽ gửi qua Telegram ạ."

Bước gọi generate là tool call bắt buộc trước khi reply text. Nếu chưa gọi generate thì không được nói đã bắt đầu tạo ảnh.

**Phần đăng Zalo:** xem `skills/marketing/zalo-post-workflow.md`
**Phần đăng Facebook:** xem `skills/marketing/facebook-post-workflow.md`

## Tài sản thương hiệu

- CEO nói "dùng logo" / "dùng ảnh sản phẩm" / "dùng mascot" — gọi `GET /api/brand-assets/list` trước.
- Nếu rỗng — "Anh chưa upload tài sản thương hiệu nào. Vào Dashboard > Facebook > Tài sản thương hiệu để thêm."
- Nếu có file, ưu tiên file phù hợp nhất và đi thẳng vào generate. Không được viện vào lý do "mất access", "chưa kéo được", hay "trong phiên này chưa thấy asset".
