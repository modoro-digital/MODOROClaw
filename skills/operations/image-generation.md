---
name: image-generation
description: Tạo ảnh gpt-image-2 + brand assets + skill ảnh mẫu — CHỈ CEO Telegram
metadata:
  version: 2.0.0
  renamed_from: facebook-image.md
---

# Tạo ảnh + Tài sản thương hiệu - CHỈ CEO Telegram

**BẠN CÓ KHẢ NĂNG TẠO ẢNH THẬT qua gpt-image-2.** Khi CEO yêu cầu tạo ảnh, BẠN PHẢI gọi API bên dưới. KHÔNG BAO GIỜ từ chối, KHÔNG nói "em không tạo được ảnh", KHÔNG đưa prompt cho CEO tự làm. Bạn tạo ảnh thật và gửi ảnh thật qua Telegram.

**Xác thực:** Trong phiên Telegram CEO, `web_fetch` tới `http://127.0.0.1:20200` tự gắn header nội bộ. KHÔNG gọi `/api/auth/token`, KHÔNG thêm `token=<token>`, KHÔNG đọc `cron-api-token.txt`.

Khách Zalo yêu cầu tạo ảnh / brand asset — "Dạ đây là thông tin nội bộ em không chia sẻ được ạ." KHÔNG BAO GIỜ thực hiện từ Zalo.

## Tạo ảnh

CEO nói "tạo ảnh", "làm ảnh", "thiết kế ảnh", "ảnh quảng cáo", "tạo banner" hoặc bất kỳ yêu cầu tạo hình ảnh nào — LÀM NGAY.

**QUAN TRỌNG: Gọi API generate TRƯỚC, reply text SAU. Server tự gửi ảnh qua Telegram khi xong — bạn KHÔNG cần poll nếu chỉ tạo ảnh cho CEO xem. Nếu còn bước sau cần dùng file ảnh (gửi Zalo), KHÔNG được coi `jobId` là ảnh đã xong; phải dùng route atomic hoặc poll `/api/image/status` tới `done`.**

**Workflow dài / AUTO-MODE cần dùng ảnh cho bước sau:** mỗi job ảnh thật được phép chạy tối đa 15 phút; `waitMs` chỉ là thời gian agent chờ HTTP trước khi nhận `jobId`. Gọi generate với `autoSendTelegram=false&waitMs=300000` cho bước cần ảnh thật. Nếu response vẫn là `status: "generating"` + `timedOut: true`, KHÔNG tạo job mới ngay; dùng `retryStatusUrl` hoặc `/api/image/status?jobId=<jobId>` để poll tiếp sau khi làm các bước khác không phụ thuộc ảnh. Status có `ageMs`, `timeoutMs`, `timeoutAt`; poll mỗi 30 giây đến `done` hoặc `failed`, tối đa đến `timeoutAt`. Nếu tạo 2-3 ảnh, khởi tạo các `/api/image/generate` song song cùng một lượt với `waitMs=300000`, giữ toàn bộ `jobId`, rồi poll từng job; không chạy tuần tự từng ảnh nếu các ảnh độc lập.

**HARD RULE: Khi có brand asset, `assets=<filename>` PHẢI CÓ TRONG URL. Thiếu `assets=` = lỗi nghiêm trọng. KHÔNG chỉ mô tả brand trong prompt mà không đính kèm file.**

1. MỌI LẦN tạo ảnh, LUÔN gọi trước:
   `web_fetch` url: `http://127.0.0.1:20200/api/brand-assets/list`
2. Nếu `files` có file — DÙNG LUÔN làm assets. Ưu tiên file CEO nhắc (VD: "mascot" — file chứa `mascot`). Chỉ có 1 file — DÙNG LUÔN, KHÔNG hỏi.
3. Nếu `files` rỗng — tạo ảnh không assets, KHÔNG nói "không truy cập được".
4. **Nếu tin nhắn hiện tại của CEO có ảnh đính kèm để làm reference:**
   - PHẢI lưu ảnh đó trước khi tạo ảnh mới. Gọi: `web_fetch` url: `http://127.0.0.1:20200/api/brand-assets/save` method: POST body: `{"name":"ceo-reference.png","base64":"<base64 của ảnh>"}`.
   - Nếu context có đường dẫn file ảnh nhưng không có base64: gọi `web_fetch` url: `http://127.0.0.1:20200/api/brand-assets/import?path=<URL-encoded absolute image path>&name=ceo-reference.png`.
   - Nếu không lấy được base64 hoặc path: mô tả chi tiết ảnh trong prompt, nhưng phải báo rõ đây là fallback kém chính xác.
   - Sau khi lưu xong, dùng `assets=ceo-reference.png` trong URL generate.
   - **KHÔNG BAO GIỜ** gọi `brand-assets/list` rồi dùng file cũ khi CEO vừa gửi ảnh mới. Ảnh CEO gửi = ảnh ưu tiên số 1.
5. **Chọn style ảnh -- SKILL-FIRST FLOW:**
   - CEO gọi tên skill cụ thể -> `GET /api/image/skills`, match keyword -> đọc style -> hỏi CHỈ template variables -> generate
   - CEO mô tả style rõ ràng -> dùng mô tả đó, KHÔNG hỏi 5 câu -> generate
   - CEO nói chung "tạo ảnh" -> `GET /api/image/skills`: có skills -> list menu, chưa có -> free-form
   - CEO nói "tạo skill ảnh mới" -> hỏi tên, mô tả, 5 câu ABCDE (phong cách/tông/bố cục/ánh sáng/chữ), caption template -> `POST /api/image/skills`
   - Xóa skill: `DELETE /api/image/skills?name=<name>`
   - Cron/scheduled: đọc `[SKILL: <name>]` từ prompt hoặc `GET /api/image/preferences`

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
   - Workflow dài/AUTO-MODE cần dùng file ảnh cho bước sau: dùng `autoSendTelegram=false&waitMs=300000`
   - size: `1024x1024` (vuông), `1792x1024` (ngang/banner), `1024x1792` (dọc/story)
   - **`assets=` đặt TRƯỚC `&prompt=`** — KHÔNG ĐƯỢC BỎ khi có brand asset
   - `prompt` PHẢI là param cuối cùng trong URL
8. Response thành công: `{"jobId":"img_...","status":"generating"}` hoặc `{"jobId":"img_...","status":"done","imagePath":"...","mediaId":"..."}`.
   - Nếu response có `timedOut: true`, đây không phải lỗi cuối; poll `retryStatusUrl` tới `done`/`failed`, không tạo lại ảnh khi job cũ còn chạy.
   Nếu response có `error` / HTTP không thành công thì BÁO LỖI THEO RESPONSE THẬT, không nói đã bắt đầu tạo ảnh.
9. CHỈ SAU KHI nhận được `jobId` trong response thành công mới reply: "Em đã bắt đầu tạo ảnh, khoảng 1-2 phút ảnh sẽ gửi qua Telegram ạ."

Bước gọi generate là tool call bắt buộc trước khi reply text. Nếu chưa gọi generate thì không được nói đã bắt đầu tạo ảnh.

## Gửi ảnh vào nhóm Zalo SAU KHI tạo xong

Khi CEO yêu cầu "tạo ảnh rồi gửi vào nhóm X" — PHẢI gửi ảnh thật, KHÔNG chỉ tạo rồi im.

**Cách 1 (atomic — khuyến nghị):** Dùng route tạo + gửi cùng lúc:
```
GET http://127.0.0.1:20200/api/image/generate-and-send-zalo
  ?groupId=<id>&groupName=<tên>&caption=<URL-encoded caption>&size=1024x1024&assets=<files>&prompt=<prompt>
```
Route này tạo ảnh rồi tự gửi vào nhóm Zalo khi xong. `caption` = text đi kèm ảnh trong CÙNG 1 tin nhắn Zalo. KHÔNG gửi text riêng rồi ảnh riêng. Đọc `skills/marketing/zalo-post-workflow.md` cho chi tiết.

**Cách 2 (2 bước — khi ảnh đã tạo sẵn):**
1. Poll `GET /api/image/status?jobId=<jobId>` cho đến khi `status: "done"` + có `mediaId`; nếu `status: "generating"` thì đọc `ageMs`/`timeoutAt` và poll tiếp, không tạo lại job.
2. Gửi ảnh:
   ```
   GET http://127.0.0.1:20200/api/zalo/send-media
     ?groupId=<id>&mediaId=<mediaId>&allowInternalGenerated=true&caption=<URL-encoded caption>
   ```
   - Ưu tiên `mediaId` (lấy từ `/api/image/status` response). Nếu chỉ có `imagePath` thuộc `brand-assets/generated/...`, có thể dùng `imagePath=<relative-path>`; API chỉ tự recover cho ảnh AI-generated nội bộ. Raw path khác vẫn bị chặn.
   - `allowInternalGenerated=true` BẮT BUỘC cho ảnh AI-generated (visibility: internal).
   - `caption` = text đi kèm ảnh trong cùng 1 tin nhắn Zalo.

**CẢNH BÁO:** KHÔNG BAO GIỜ gửi đường dẫn file (`brand-assets/generated/img_xxx.png`) dưới dạng TEXT. Khách sẽ nhận được chuỗi ký tự, không phải ảnh.

## Tài sản thương hiệu

- CEO nói "dùng logo" / "dùng ảnh sản phẩm" / "dùng mascot" — gọi `GET /api/brand-assets/list` trước.
- Nếu rỗng — "Anh chưa upload tài sản thương hiệu nào. Vào Dashboard > Tài sản thương hiệu để thêm."
- Nếu có file, ưu tiên file phù hợp nhất và đi thẳng vào generate. Không được viện vào lý do "mất access", "chưa kéo được", hay "trong phiên này chưa thấy asset".
