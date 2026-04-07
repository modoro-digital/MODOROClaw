# Knowledge Tab — Design Spec

**Date:** 2026-04-07
**Status:** Approved
**Author:** MODORO

## Mục tiêu

Thêm tab **Knowledge** trong Dashboard cho CEO upload file (hợp đồng, sản phẩm, danh sách nhân viên...). Bot tự đọc, tóm tắt, index, và "nhớ" để query khi cần.

## Phân nhóm

3 folder cố định:

| Folder | Purpose |
|--------|---------|
| `cong-ty` | Thông tin công ty: hợp đồng, chính sách, SOP, FAQ nội bộ |
| `san-pham` | Catalog sản phẩm/dịch vụ, bảng giá, mô tả |
| `nhan-vien` | Danh sách nhân viên, phân ca, vai trò, liên hệ |

## Storage

```
workspace/knowledge/
├── cong-ty/
│   ├── index.md          ← bot đọc bootstrap, có summary mỗi file
│   └── files/
│       └── <raw files>
├── san-pham/
│   ├── index.md
│   └── files/
└── nhan-vien/
    ├── index.md
    └── files/
```

SQLite (memory.db, đã có sẵn): thêm column `category TEXT` vào table `documents`. Mỗi entry đánh dấu thuộc folder nào. Search qua FTS5 với filter `WHERE category = ?`.

## Components

### Backend (electron/main.js)

| IPC | Input | Output | Behavior |
|-----|-------|--------|----------|
| `upload-knowledge-file` | `{category, filepath}` | `{success, summary, error?}` | Copy file → parse → AI summarize → append index.md → INSERT SQLite |
| `list-knowledge-files` | `{category}` | `[{filename, size, uploadedAt, summary}]` | Read disk + SQLite metadata |
| `delete-knowledge-file` | `{category, filename}` | `{success}` | Remove file + index.md entry + SQLite row |
| `get-knowledge-summary` | - | `{cong-ty, san-pham, nhan-vien}` | Return content of 3 index.md (for bot) |

Helpers:
- `summarizeWithAI(content, filename)` — POST tới 9Router với prompt "Tóm tắt 1-2 câu". Fallback: filename + first 200 chars nếu fail.
- `appendToKnowledgeIndex(category, filename, summary)` — lock-safe append vào index.md.
- `removeFromKnowledgeIndex(category, filename)` — regex remove section.

### UI (dashboard.html)

Sidebar item mới (sau "Lịch tự động"):
```
<div class="sidebar-menu-item" data-page="knowledge" onclick="switchPage('knowledge')">
  <span class="icon" data-icon="book-open"></span>
  <span class="label">Knowledge</span>
</div>
```

Page `page-knowledge`:

```
┌────────────────┬────────────────────┬──────────────────┐
│ THƯ MỤC        │ FILE               │ UPLOAD           │
│ ┌─ Công ty (3)│ ┌──────────────┐  │ ┌──────────────┐│
│ ├─ Sản phẩm(5)│ │ hop-dong.pdf │  │ │              ││
│ └─ Nhân viên 2│ │ 245 KB · ... │  │ │  Drag file   ││
│                │ │ [Tóm tắt] [X]│  │ │  vào đây     ││
│                │ ├──────────────┤  │ │              ││
│                │ │ ...          │  │ │  hoặc click  ││
│                │ └──────────────┘  │ └──────────────┘│
└────────────────┴────────────────────┴──────────────────┘
```

- **Col 1** (260px): 3 folder buttons. Click → load list. Active state highlight.
- **Col 2** (flex): file cards (icon theo extension, name, size, ngày upload, summary 2 dòng, nút xóa). Empty state: "Chưa có file nào, upload bên phải".
- **Col 3** (320px): drag-drop zone + click chọn. Hỗ trợ multi-file. Progress bar khi đang index. Activity log trong process.

Lazy load: chỉ fetch khi `switchPage('knowledge')`.

### Bot integration (AGENTS.md)

Section mới:

```markdown
## Knowledge doanh nghiệp

Mỗi session bootstrap, đọc 3 file index để biết có gì:
- `knowledge/cong-ty/index.md`
- `knowledge/san-pham/index.md`
- `knowledge/nhan-vien/index.md`

Khi CEO/khách hỏi:
1. Xác định chủ đề thuộc nhóm nào (công ty / sản phẩm / nhân viên)
2. Search trong knowledge files của nhóm đó
3. Trả lời + trích nguồn: "Theo [tên file]..."

KHÔNG hardcode thông tin từ memory. LUÔN đọc file để có data mới nhất.
```

## Data flow upload

```
CEO drag file
  ↓
upload-knowledge-file IPC
  ↓
1. Validate type (.pdf .docx .xlsx .txt .md .csv .png .jpg)
2. Resolve dst = workspace/knowledge/<cat>/files/<filename> (rename if exists)
3. Copy raw file
4. Parse content (pdf-parse / mammoth / xlsx — đã có)
5. summarizeWithAI(content, filename) → string
6. appendToKnowledgeIndex(category, filename, summary)
7. INSERT SQLite documents (category=cat, filename, content)
  ↓
return { success, summary }
  ↓
UI: refresh list, show toast "Đã thêm <filename>"
```

## Error handling

| Lỗi | Xử lý |
|-----|-------|
| File type không support | Reject ở UI + main, báo CEO loại nào supported |
| Parse fail (file lỗi) | Vẫn copy file + ghi "Không đọc được nội dung" vào index, bot biết có file |
| 9Router fail (AI summarize) | Fallback: filename + first 200 chars |
| SQLite insert fail | Rollback file copy + index entry |
| Filename trùng | Auto rename `<name>-2.pdf`, `<name>-3.pdf`,... |
| File quá lớn (>20MB) | Reject + thông báo |

## Fresh-install compatibility

Theo `CLAUDE.md` Rule #1:

1. **`seedWorkspace()`** trong main.js:
   - `mkdir -p knowledge/{cong-ty,san-pham,nhan-vien}/files`
   - Tạo `<cat>/index.md` rỗng nếu thiếu (header `# Knowledge - Công ty\n\n*Chưa có tài liệu nào*`)

2. **`getDocumentsDb()`**:
   - Migration idempotent: `CREATE TABLE IF NOT EXISTS documents` đã có column `category TEXT DEFAULT 'general'`
   - Hoặc `ALTER TABLE documents ADD COLUMN category TEXT` wrapped in try/catch (idempotent on retry)

3. **`AGENTS.md` template** trong source:
   - Section "Knowledge doanh nghiệp" có sẵn → seed copy sang workspace

4. **`RESET.bat`**:
   - KHÔNG xóa `knowledge/` folder (CEO data)
   - HOẶC xóa nếu user muốn full reset (option)

## Testing

- [ ] Upload PDF vào "Công ty" → file xuất hiện trong list, index.md có summary
- [ ] Upload Excel vào "Sản phẩm" → bot trả lời câu "có sản phẩm gì giá X" được
- [ ] Upload .txt vào "Nhân viên" → bot trả lời "Nhân viên Lan làm ca nào?" được
- [ ] Xóa file → biến mất khỏi UI + index.md + SQLite + disk
- [ ] Restart app → bot vẫn nhớ (đọc index.md ở bootstrap)
- [ ] Upload file trùng tên → tự rename
- [ ] Upload file lỗi (corrupt PDF) → vẫn lưu file, index ghi "Không đọc được"
- [ ] Network down lúc upload → AI summarize fallback hoạt động
- [ ] Fresh install (RESET.bat → RUN.bat → wizard → vào Knowledge tab) → 3 folder rỗng có sẵn

## Out of scope

- Edit content file trong UI (CEO sửa file ngoài rồi re-upload)
- Version history (giữ bản cũ khi update)
- Folder tự custom (chỉ 3 folder cố định)
- Share knowledge giữa nhiều account
- OCR ảnh có chữ (chỉ ghi nhận path, AI vision sẽ đọc khi cần)

## File changes

| File | Thay đổi |
|------|---------|
| `electron/main.js` | +5 IPC handlers, +helpers, update seedWorkspace, update SQLite schema |
| `electron/preload.js` | +5 bridges |
| `electron/ui/dashboard.html` | +sidebar item, +page-knowledge HTML, +CSS, +JS handlers |
| `AGENTS.md` (source) | +section "Knowledge doanh nghiệp" |
| `CLAUDE.md` | +entry trong patches list |
| `README.md` | +mô tả Knowledge tab vào tính năng |

---

## README cleanup (phần 2)

Audit hiện tại 399 dòng, viết lại còn ~150 dòng. Chỉ giữ:

- Kiến trúc + data flow
- Tính năng có code thật:
  - Wizard (4 step sau khi đơn giản hóa)
  - Dashboard 5 pages: Overview / Lịch tự động / Telegram / Zalo / Knowledge
  - Cron file-based (schedules.json + custom-crons.json) + nút Test ngay
  - Document library + Knowledge tab
  - Self-healing: orphan listener cleanup, openzalo shell patch, blockStreaming fix
  - Light/dark theme
- 3 channel: Telegram ✓, Zalo ✓ (DM + group), Google ✗
- File-based knowledge: AGENTS.md, USER.md, COMPANY.md, PRODUCTS.md, IDENTITY.md, .learnings/

Bỏ:
- Mọi mô tả tính năng chưa có code
- "Đang phát triển" / "Sắp ra mắt"
- Diagram quá phức tạp không phản ánh thực tế
