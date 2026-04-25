# Image Generation + Facebook Posting + Brand Assets — Design Spec

## Mục tiêu

CEO nói "đăng bài lên fanpage về khuyến mãi cuối tuần, dùng logo của mình" trên Telegram → bot tạo ảnh branded bằng gpt-image-2 (kèm logo làm reference input) → preview cho CEO xác nhận → đăng lên Facebook Page.

Ba khả năng mới, loosely coupled:
1. **Brand Assets** — thư mục ảnh tài sản thương hiệu, CEO upload một lần, bot dùng làm reference khi tạo ảnh
2. **Image Generation** — gọi gpt-image-2 qua 9router Codex Responses API, hỗ trợ reference images
3. **Facebook Page Posting** — đăng bài (text + ảnh) lên fanpage qua Graph API v25.0

## Quyết định thiết kế

| Câu hỏi | Quyết định | Lý do |
|----------|-----------|-------|
| Facebook auth | Manual token paste (không OAuth) | Ship nhanh, không cần Meta App Review, CEO đủ kỹ thuật để paste token |
| Brand assets location | `brand-assets/` top-level, tách khỏi `knowledge/` | Ảnh dùng làm AI input, khác bản chất với docs dùng cho RAG |
| Image gen architecture | Async job (POST start → GET poll) | gpt-image-2 có thể mất 5-10 phút, HTTP request không nên treo lâu |
| Confirm before post | AGENTS.md behavioral rule | Giống pattern Zalo cron confirm, không cần code mới cho flow này |
| Agent access | Cron API endpoints + `web_fetch` | Giống pattern hiện tại, không thêm tool vào `tools.allow` |
| Scope v1 | Publish-only | Không comment reply, không Messenger, không personal account |

## Step 0: Validation — Reference Image Input

**Trước khi build bất kỳ thứ gì**, validate rằng 9router Codex API chấp nhận reference image input.

**Test:** Gửi ảnh có sẵn (`gpt-image-2-test.png`) làm `input_image` cùng text prompt → xác nhận output có incorporate elements từ input image.

**Nếu fail:** Fallback sang text-only prompting (mô tả brand elements bằng text thay vì gửi ảnh). Brand assets vẫn hữu ích — bot đọc tên file + CEO mô tả, nhưng không gửi binary làm input.

---

## 1. Brand Assets System

### Folder structure

```
brand-assets/          ← workspace root, cạnh knowledge/ và memory/
├── logo.png
├── banner-template.jpg
├── product-photo-1.png
└── generated/         ← output từ image generation
    ├── img_1745_001.png
    └── ...
```

Flat folder, không subfolder, không metadata DB. Chỉ chứa ảnh.

### Constraints

- Max file size: 10MB per file
- Formats: png, jpg, jpeg, webp
- Resize trước khi gửi API: max 4MB base64 per image
- `generated/` subfolder cho output, tách biệt khỏi source assets

### Upload từ Telegram

CEO gửi ảnh trên Telegram kèm caption "lưu asset" / "save logo" / "lưu vào brand assets" → bot:
1. Download ảnh từ Telegram API (`getFile` → download)
2. Save vào `brand-assets/` với tên từ caption hoặc auto-generate (`asset-YYYYMMDD-HHMMSS.png`)
3. Xác nhận: "Em đã lưu ảnh vào tài sản thương hiệu: logo.png"

**Implementation:** Cron API endpoint `POST /api/brand-assets/save` — body: `{ name, base64 }`. Agent gọi qua `web_fetch`. Agent nhận ảnh Telegram (đã có vision flow), extract base64, gọi endpoint.

**AGENTS.md rule:**
```
KHI CEO gửi ảnh kèm lệnh lưu ("lưu asset", "save logo", "lưu brand asset"):
1. Download ảnh từ tin nhắn
2. Gọi /api/brand-assets/save với tên file phù hợp
3. Xác nhận: "Em đã lưu [tên file] vào tài sản thương hiệu."
```

### Dashboard UI

Nằm trong Facebook tab, section "Tài sản thương hiệu":
- Grid thumbnails của tất cả files trong `brand-assets/`
- Nút upload (multi-file)
- Nút xoá per-file
- Không hiện `generated/` subfolder (đó là output, không phải source)

### Seeding

`seedWorkspace()` tạo `brand-assets/` directory rỗng trên fresh install.

### Cron API Endpoints

- `GET /api/brand-assets/list` → `{ files: ["logo.png", "banner.jpg", ...] }`
- `POST /api/brand-assets/save` → body: `{ name, base64 }` → save file, returns `{ ok, name, sizeBytes }`
- **Path traversal guard:** `name` phải pass validation — `path.resolve(brandAssetsDir, name)` phải startsWith `brandAssetsDir`. Reject `../`, absolute paths, null bytes.
- **Không có `/api/brand-assets/read`** — agent không cần đọc base64 trực tiếp (xem Section 2 giải thích)

Token auth cho tất cả endpoints (cùng rotating token).

### IPC Handlers

- `list-brand-assets` → trả danh sách files + thumbnails (base64 nhỏ cho Dashboard grid)
- `upload-brand-asset` → save file vào `brand-assets/`
- `delete-brand-asset` → xoá file (path traversal guard)

---

## 2. Image Generation via 9Router

### Module

`electron/lib/image-gen.js` — standalone, không phụ thuộc Facebook.

### API Contract (9Router Codex Responses API)

```
POST http://127.0.0.1:20128/codex/responses
{
  model: "cx/gpt-5.4",
  input: [
    { role: "user", content: [
      { type: "input_text", text: "Tạo banner khuyến mãi..." },
      { type: "input_image", image_url: "data:image/png;base64,..." }
    ]}
  ],
  tools: [{ type: "image_generation", model: "gpt-image-2", size: "1024x1024" }],
  tool_choice: { type: "image_generation" },
  stream: true,
  store: false
}
```

Response: SSE stream → parse `response.output_item.done` event → extract base64 PNG.

### Async Job Pattern

Image generation có thể mất 5-10 phút. Không block HTTP request.

1. `POST /api/image/generate` → starts background job → returns `{ jobId: "img_1745..." }` immediately
   - Body: `{ prompt: "...", assets: ["logo.png"], size: "1024x1024" }`
   - **Server-side asset loading:** endpoint tự đọc assets từ `brand-assets/`, convert to base64, gửi tới 9router. Agent KHÔNG bao giờ nhận/gửi raw base64 — tránh blow context window.
   - Spawn async function gọi 9router, parse SSE
   - Save result to `brand-assets/generated/<jobId>.png`

2. `GET /api/image/status?jobId=img_1745...` → returns:
   - `{ status: "generating" }` — đang chạy
   - `{ status: "done", imagePath: "brand-assets/generated/img_1745.png" }` — xong (KHÔNG trả base64)
   - `{ status: "failed", error: "..." }` — lỗi

3. Timeout: 15 phút. Sau 15 phút nếu chưa xong → mark failed.

4. Job cleanup: giữ tối đa 20 generated images, xoá cũ nhất khi vượt. Dùng async mutex (cùng pattern như Cron API write ops) tránh race khi 2 jobs xong cùng lúc.

### Agent Usage — Capped Polling

Agent gọi qua `web_fetch` (đã có trong `tools.allow`):
1. `web_fetch url=http://127.0.0.1:20200/api/image/generate` POST body
2. Nhận jobId
3. Reply CEO: "Em đang tạo ảnh, có thể mất vài phút..."
4. Poll `web_fetch url=http://127.0.0.1:20200/api/image/status?jobId=...`
5. **Poll cap: tối đa 5 lần**, interval 30s-60s (tổng ~2.5-5 phút polling)
6. Nếu sau 5 lần vẫn `generating` → reply CEO: "Ảnh đang tạo lâu hơn dự kiến. Anh hỏi lại em sau vài phút nhé, hoặc em sẽ báo khi xong."
7. **Proactive notification:** khi job xong (done/failed), `image-gen.js` gọi `sendTelegram()` trực tiếp (server-side, không qua agent) gửi thông báo + ảnh cho CEO. Agent không cần poll vô hạn.

### Gửi ảnh qua Telegram

Agent không gửi binary trực tiếp (tool `message` chỉ hỗ trợ text). Thay vào đó:
- `POST /api/telegram/send-photo` — body: `{ imagePath, caption }`. Server-side gọi Telegram `sendPhoto` API với file từ disk.
- Agent gọi endpoint này qua `web_fetch` sau khi image gen xong.
- Proactive notification (khi agent không poll nữa) cũng dùng endpoint này.

### Standalone Use Case

CEO trên Telegram: "tạo ảnh banner cho sale cuối tuần, dùng logo" → agent tạo ảnh → gửi lại trên Telegram. Không cần Facebook.

---

## 3. Facebook Publisher

### Module

`electron/lib/fb-publisher.js` — pure Graph API v25.0 wrapper.

### Methods

- `postText(pageId, token, message)` → `POST /{page_id}/feed` → returns `{ postId, postUrl }`
- `postPhoto(pageId, token, message, imageBuffer)` → `POST /{page_id}/photos` multipart → returns `{ postId, postUrl }`
- `verifyToken(token)` → `GET /me/accounts` → returns `{ valid, pageId, pageName }` hoặc error
- `getRecentPosts(pageId, token, limit=5)` → `GET /{page_id}/feed?fields=message,created_time,full_picture&limit=5`

### Config

`fb-config.json` trong workspace root:
```json
{
  "pageId": "123456789",
  "pageName": "My Business Page",
  "accessToken": "<encrypted>",
  "connectedAt": "2026-04-25T10:30:00Z"
}
```

**Token security:** `accessToken` được encrypt bằng Electron `safeStorage.encryptString()` trước khi ghi file. Đọc bằng `safeStorage.decryptString()`. Nếu `safeStorage` không available (headless/CI) → fallback plaintext + log warning.

File `fb-config.json` được thêm vào `.gitignore` (đã có sẵn pattern cho workspace runtime files).

### Cron API Endpoint

`POST /api/fb/post` — body: `{ message, imagePath }` (imagePath optional, relative to workspace)
- Đọc token từ `fb-config.json`
- Gọi Graph API
- Returns `{ postId, postUrl }`
- Token auth (rotating token)

### Dashboard Facebook Tab

Thay thế "Soon" badge hiện tại. Gồm:

**Section 1 — Kết nối Page:**
- Text input cho Page Access Token
- Nút "Kết nối" → gọi `verifyToken` → hiện tên Page + trạng thái
- Hướng dẫn ngắn: link tới Meta Business Suite để lấy token
- Permissions cần: `pages_manage_posts`, `pages_read_engagement`

**Section 2 — Bài đăng gần đây:**
- List 5 bài mới nhất (text + thumbnail + ngày đăng)
- Read-only, refresh khi mở tab

**Section 3 — Tài sản thương hiệu:**
- Grid thumbnails từ `brand-assets/`
- Upload/delete buttons

### Error Handling

- Token hết hạn (`OAuthException`) → Dashboard warning banner + agent nói CEO: "Token Facebook hết hạn, anh paste token mới vào Dashboard."
- Graph API rate limit → không xử lý đặc biệt (CEO không post 200 bài/giờ)
- Network error → retry 1 lần sau 3s, fail → thông báo CEO

---

## 4. Confirm-Before-Post Flow

**AGENTS.md behavioral rule** — không cần code mới cho flow này.

```
KHI CEO yêu cầu đăng bài Facebook:
1. Tạo ảnh (nếu cần) qua /api/image/generate → poll status
2. Soạn caption phù hợp với nội dung CEO yêu cầu
3. GỬI PREVIEW cho CEO qua Telegram:
   - Ảnh (nếu có)
   - Caption đầy đủ
   - "Anh xác nhận đăng bài này lên fanpage không? Reply 'ok' để đăng, hoặc nói em thay đổi gì."
4. CHỜ CEO REPLY — KHÔNG tự động đăng
5. CEO nói "ok" / "đăng đi" → gọi /api/fb/post → xác nhận với link bài đăng
6. CEO nói thay đổi → sửa caption/tạo lại ảnh → preview lại
7. CEO nói "huỷ" / "thôi" → dừng, không đăng

KHI CEO yêu cầu tạo ảnh (không đăng FB):
1. Tạo ảnh qua /api/image/generate
2. Nói CEO "đang tạo ảnh, có thể mất vài phút"
3. Poll status, khi xong → gửi ảnh qua Telegram
4. KHÔNG tự động đăng lên bất kỳ đâu

BRAND ASSETS:
- CEO nói "dùng logo" / "dùng ảnh sản phẩm" → đọc /api/brand-assets/list
- Nếu brand-assets/ rỗng → "Anh chưa upload tài sản thương hiệu nào.
  Vào Dashboard > Facebook > Tài sản thương hiệu để thêm, hoặc gửi ảnh cho em kèm lệnh 'lưu asset'."
- Nếu có nhiều file → hỏi CEO muốn dùng file nào, hoặc dùng tất cả nếu CEO nói chung chung

KHI CEO gửi ảnh kèm lệnh lưu ("lưu asset", "save logo", "lưu brand asset", "lưu ảnh này"):
1. Download ảnh từ tin nhắn
2. Gọi /api/brand-assets/save với tên file phù hợp (từ caption hoặc auto-generate)
3. Xác nhận: "Em đã lưu [tên file] vào tài sản thương hiệu."
```

---

## 5. File Structure

### New files

```
brand-assets/                          ← workspace root, seeded empty
electron/lib/image-gen.js             ← 9router Codex API client + async job manager
electron/lib/fb-publisher.js          ← Graph API v25.0 wrapper
```

### Modified files

```
electron/main.js
  ├── seedWorkspace()                  ← thêm brand-assets/ dir
  ├── startCronApi()                   ← thêm 8 endpoints:
  │     GET  /api/brand-assets/list
  │     POST /api/brand-assets/save
  │     POST /api/image/generate
  │     GET  /api/image/status?jobId=X
  │     POST /api/fb/post
  │     GET  /api/fb/recent
  │     POST /api/telegram/send-photo
  │     (path traversal guard trên tất cả file-access endpoints)
  ├── IPC handlers:
  │     save-fb-config, get-fb-config, verify-fb-token
  │     list-brand-assets, upload-brand-asset, delete-brand-asset
  └── ensureDefaultConfig()            ← không thay đổi tools.allow

electron/preload.js                    ← bridges cho IPC handlers mới
electron/ui/dashboard.html             ← Facebook tab thay thế "Soon" badge
AGENTS.md                              ← thêm Facebook posting + image gen + brand asset rules
```

### Không thay đổi

- `tools.allow` — agent dùng `web_fetch` gọi Cron API, không cần tool mới
- `ensureDefaultConfig()` — không thêm config mới cho openclaw.json
- Existing Zalo/Telegram flows — không ảnh hưởng

---

## 6. Error Handling

| Scenario | Hành vi |
|----------|---------|
| 9router chưa sẵn sàng | `/api/image/generate` trả `{ error: "9Router không sẵn sàng" }`. Agent: "Em không tạo được ảnh lúc này." |
| Image gen timeout (>15 phút) | Job marked failed. Proactive notification gửi CEO: "Tạo ảnh bị timeout, anh thử lại với prompt ngắn hơn." |
| Agent poll 5 lần vẫn generating | Agent dừng poll, thông báo CEO. Server-side proactive notification khi job xong. |
| FB token hết hạn | Graph API trả `OAuthException`. Dashboard warning + agent: "Token Facebook hết hạn, anh paste token mới." |
| Brand assets rỗng | Agent gợi ý upload qua Dashboard hoặc gửi ảnh trên Telegram kèm "lưu asset" |
| Brand asset quá lớn | Upload bị chặn ở 10MB. Resize xuống 4MB base64 trước khi gửi API |
| FB post thất bại | Retry 1 lần sau 3s. Fail → agent báo CEO với error message |
| Reference image không work với API | Fallback text-only prompting (brand description thay vì binary) |
| Path traversal trên brand-assets | `path.resolve()` + `startsWith()` guard. Reject `../`, absolute paths, null bytes |
| FB token leak risk | Token encrypted bằng Electron `safeStorage`. File `fb-config.json` trong `.gitignore` |
