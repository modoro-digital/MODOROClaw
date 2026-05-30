---
name: script-generator
description: AI tự sinh script Python/Node cho task lặp lại của CEO. DÙNG NGAY khi CEO mô tả task xử lý dữ liệu (Excel, Sheet, CSV, JSON), automation (scrape web, fill form), batch operations (image resize, OCR, translate), custom query (LTV, churn, inventory analysis), file processing, network probing — KỂ CẢ không nói "script" / "code". Bot phân tích task → generate script → test → CEO confirm → save làm skill folder để tháng sau dùng lại không tốn LLM.
metadata:
  version: 1.0.0
---

# AI tự sinh script cho task lặp lại của CEO

CHỈ CEO Telegram. Khách Zalo yêu cầu → "Dạ đây là thông tin nội bộ ạ."

## Khi nào trigger flow này

CEO mô tả task có dấu hiệu **deterministic + repeatable**:

- "Tính LTV mỗi khách iPhone tháng này"
- "Merge 3 file Excel báo cáo doanh thu"
- "Scrape giá iPhone 15 top 5 shop Shopee"
- "Resize hết ảnh sản phẩm trong folder X về 800x800"
- "OCR ảnh hóa đơn rồi extract số tiền"
- "Backup workspace zip rồi upload Drive"
- "Tìm khách Zalo inactive >60 ngày"
- "Translate 200 product description sang tiếng Anh"
- "Check website NCC có online không"
- "Generate hashtag cho 50 sản phẩm"

**KHÔNG dùng flow này** cho:
- Câu hỏi 1 lần đơn giản (CEO chỉ hỏi → trả lời, không tạo script)
- Task đã có skill hệ thống (cron, image, FB post, ...) — dùng skill đó
- Task cần judgment LLM mỗi lần (vd: trả lời khách Zalo) — đây là conversational, không deterministic

## Quy trình 6 bước

### Bước 1: Check skill cũ có match không

```
web_fetch http://127.0.0.1:20200/api/user-skills/list
```

Tìm skill `enabled: true` có `trigger` hoặc `name` match keyword task. Nếu match:
> Em có skill "[tên]" làm việc tương tự. Chạy luôn cái cũ hay cần tạo skill mới?

Nếu CEO chọn cái cũ → gọi `/api/skill/exec` với skillId của skill cũ. Hết flow.

Nếu CEO muốn tạo mới → tiếp Bước 2.

### Bước 2: Phân tích task

Trình CEO breakdown:
> Em hiểu task gồm:
> - **Input:** [data source — Excel file path / sheet ID / memory.db / web URL / ...]
> - **Operation:** [filter / aggregate / scrape / resize / OCR / ...]
> - **Output:** [JSON / CSV / số / list / file / Telegram message]
>
> Anh xác nhận đúng không, hay cần sửa?

CHỜ CEO confirm trước khi viết code.

### Bước 3: Check Python runtime (nếu task cần Python)

```
web_fetch http://127.0.0.1:20200/api/skill/python-status
```

- `available: true` -> tiep Bước 4
- `available: false` + `canLazyDownload: true` (Windows) -> hỏi CEO cho phép cài (~30MB). CEO ok -> `POST /api/skill/python-install`
- `available: false` + `canLazyDownload: false` (Mac/Linux) -> "Anh cài Python 3.8+ qua Homebrew/apt rồi thử lại."
- **Mac fallback:** Nếu Python không có, ưu tiên viết bằng Node.js (đã có sẵn trong vendor). Node có `xlsx`, `csv-parse`, `fs`, `https` -- đủ cho phần lớn task data processing. Chỉ cần Python cho task đặc thù (PIL/image, pandas/ML, playwright/browser).

Cho task Node-only (vd Playwright), skip Python check.

### Bước 4: Generate script

Bot tự viết Python/Node script. **Nguyên tắc:**

1. **Đọc template tương ứng** trong `references/`:
   - Task Excel/CSV → đọc `skills/operations/script-generator/references/pandas-excel.md`
   - Task SQLite memory → đọc `references/sqlite-memory.md`
   - Task HTTP request → đọc `references/http-requests.md`
   - Task browser scrape → đọc `references/playwright-browser.md`
   - Task image batch → đọc `references/pillow-image.md`
   - Task file ops → đọc `references/fs-fileops.md`

2. **Script phải:**
   - Đầu file: docstring 1 dòng mô tả task
   - `argparse` cho CLI args (path, options)
   - `print()` output → JSON nếu structured data, plain text nếu đơn giản
   - Error → `print(json.dumps({"error": "..."}), file=sys.stderr); sys.exit(1)`
   - KHÔNG hardcode path tuyệt đối — dùng args
   - KHÔNG dùng package nặng nếu stdlib đủ (sqlite3 OK, pandas chỉ khi cần)

3. **Filename:** kebab-case + extension (`calc-ltv.py`, `merge-excel.py`)

### Bước 5: Test trên sample

```
web_fetch url="http://127.0.0.1:20200/api/skill/test-exec" method=POST
  body="{\"code\":\"<full script code>\",\"runtime\":\"python\",\"args\":[\"<sample arg>\"]}"
```

Response: `{success, exitCode, stdout, stderr, durationMs}`.

**Iteration loop (max 3 lần):**
- `success: true` + output hợp lý → tiếp Bước 6
- `exitCode != 0` → đọc `stderr`, fix script, re-test
- 3 lần fail → escalate CEO với full log:
  > Em thử 3 lần không chạy được. Lỗi: [last stderr]. Anh xem giúp em hoặc sửa task mô tả lại?

### Bước 6: Trình proposal + save

> Em viết script làm:
> - [Tóm tắt 3 dòng: input → operation → output]
>
> Chạy thử trên sample thấy:
> ```
> [stdout preview, max 500 chars]
> ```
>
> [Hidden by default — CEO bấm "xem code" hiện ra:
> ```python
> [full code]
> ```]
>
> Ok lưu thành skill để tháng sau dùng lại không ạ? Em sẽ đặt tên "[tên đề xuất]".

**Lưu skill bằng:**

```
web_fetch url="http://127.0.0.1:20200/api/user-skills/create" method=POST
  body="{
    \"name\":\"[tên]\",
    \"description\":\"<pushy description: WHAT + WHEN, list keyword task để future trigger>\",
    \"trigger\":\"[keyword chính]\",
    \"content\":\"[2-3 đoạn mô tả khi nào dùng, output format expected]\",
    \"scripts\":[{
      \"filename\":\"<name>.py\",
      \"runtime\":\"python\",
      \"description\":\"<1 dòng mô tả script>\",
      \"code\":\"<full script code>\",
      \"args\":[\"<arg1>\",\"<arg2>\"]
    }],
    \"allowedTools\":[]
  }"
```

Sau create → run script với args thật:

```
web_fetch url="http://127.0.0.1:20200/api/skill/exec" method=POST
  body="{\"skillId\":\"<id từ create response>\",\"script\":\"<name>\",\"args\":[\"<real arg>\"]}"
```

Báo CEO output thật.

## Edit existing script (khi CEO báo lỗi)

CEO: "skill X chạy sai chỗ Y" / "thêm filter Z vào skill X"

1. Đọc script hiện tại: `web_fetch /api/workspace/read?path=user-skills/<id>/scripts/<file>`
2. Phân tích bug/feature request
3. Patch script với change tối thiểu
4. Test lại với sample
5. Trình CEO diff + preview output
6. Nếu CEO ok → `web_fetch /api/user-skills/update` với `scripts` field mới

## Show summary thay vì full code

Khi trình CEO ở Bước 6:
- **Mặc định:** summary 3 dòng (input → operation → output) + sample output
- Nếu CEO bấm "xem code" / "show me the code" → mới show full Python code
- CEO không quen đọc code → tránh wall of text gây choáng

## Security & limits

- Script timeout default 60s, max 300s (5 phút) cho long-running
- Output max 1MB, truncate sau đó
- Test-exec network deny outbound (chỉ localhost) — script generation phase test
- Production exec network mở (CEO đã trust skill này sau khi confirm)
- Script chỉ chạy từ Telegram CEO channel — Zalo customer không trigger được (channel gate ở API)
- Script declared trong SKILL.md frontmatter — không declare = không chạy được (whitelist)

## Audit

Mọi script execution log vào `logs/audit.jsonl`:
- `user_skill_script_generated` — khi save lần đầu
- `user_skill_script_executed` — mỗi lần run
- `user_skill_script_edited` — khi CEO sửa
