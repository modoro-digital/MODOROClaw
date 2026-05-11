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
5. **BẮT BUỘC HỎI 5 CÂU TRƯỚC KHI TẠO ẢNH.** Gửi 1 tin nhắn duy nhất chứa 5 câu hỏi ABCDE. CEO trả lời gọn: "1A 2B 3C 4A 5B". Nếu chọn E thì ghi rõ: "1E watercolor". Rồi bạn tự soạn prompt chi tiết từ đáp án.

   **5 câu hỏi (gửi ĐÚNG format này):**
   ```
   Em cần biết thêm để tạo ảnh đẹp nhất:
   1. Phong cách?
      A. Ảnh thật (chụp studio)
      B. Minh họa/vector
      C. 3D render
      D. Nghệ thuật/tranh vẽ
      E. Khác (ghi rõ)
   2. Tông màu?
      A. Sáng/pastel nhẹ nhàng
      B. Tối/sang trọng (navy, đen, vàng)
      C. Rực rỡ/nổi bật
      D. Tự nhiên/earthy
      E. Khác (ghi rõ)
   3. Bố cục?
      A. Chủ thể ở giữa, nền đơn giản
      B. Góc nghiêng/động, nhiều chi tiết
      C. Close-up/cận cảnh
      D. Toàn cảnh/wide shot
      E. Khác (ghi rõ)
   4. Ánh sáng?
      A. Sáng đều, mềm mại (studio)
      B. Dramatic/tương phản cao
      C. Tự nhiên (nắng, golden hour)
      D. Neon/màu sắc
      E. Khác (ghi rõ)
   5. Có chữ trong ảnh không?
      A. Không có chữ
      B. Có tiêu đề lớn
      C. Có tiêu đề + mô tả ngắn
      D. Có nhiều text (poster/banner)
      E. Khác (ghi rõ)
   Trả lời nhanh: 1A 2B 3C 4A 5B (chọn E thì ghi rõ, VD: 1E watercolor)
   ```

   **Nếu CEO trả lời ngay không cần hỏi** (VD: "tạo nhanh đi", "khỏi hỏi", "làm luôn") → đọc preference file, nếu có dùng preference đã lưu, nếu không dùng default A cho tất cả.

   **Lưu preference:** Sau khi CEO trả lời 5 câu, gọi:
   ```
   web_fetch url="http://127.0.0.1:20200/api/image/preferences" method=POST body={"style":"A","colorTone":"B","composition":"C","lighting":"A","text":"B","custom":{"style":"watercolor"}}
   ```
   Chỉ gửi field `custom` cho câu nào CEO chọn E. Server lưu vào `image-preferences.json`.

   **Đọc preference (cho cron hoặc "tạo nhanh"):**
   ```
   web_fetch url="http://127.0.0.1:20200/api/image/preferences" method=GET
   ```
   Trả về preference đã lưu. Nếu rỗng/chưa có → dùng default A.

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
