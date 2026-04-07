# MODOROClaw V2 — Google Form + Bot Personalization + Memory System + UI Rebrand

**Date:** 2026-04-06
**Status:** Approved

---

## 1. Google Form — "MODOROClaw — Đăng ký cài đặt trợ lý AI"

Form thu thập thông tin khách hàng đã mua, để team MODORO lên lịch remote cài đặt (TeamViewer, 1-2 tiếng).

### Fields

| # | Field | Loại | Bắt buộc | Ghi chú |
|---|-------|------|----------|---------|
| 1 | Họ tên | Text | Yes | |
| 2 | Tên công ty | Text | Yes | |
| 3 | Số điện thoại / Zalo | Text | Yes | |
| 4 | Telegram (username hoặc số điện thoại) | Text | Yes | Để gửi bot link trước ngày cài |
| 5 | Email công ty | Email | Yes | |
| 6 | Website công ty (nếu có) | URL | No | |
| 7 | Lĩnh vực | Dropdown | Yes | 8 options (xem dưới) |
| 8 | Bạn muốn trợ lý làm gì? | Checkbox (nhiều) | Yes | Xem danh sách dưới |
| 9 | Bạn đã có máy tính chưa? | Radio | Yes | Đã có / Chưa có, cần MODORO hỗ trợ mua |
| 10 | Chọn ngày cài đặt | Date picker | Yes | Min: 10/04/2026 (cập nhật mỗi đợt) |
| 11 | Khung giờ mong muốn | Dropdown | Yes | Sáng (9-12h) / Chiều (13-17h) / Tối (19-21h) |
| 12 | Ghi chú thêm | Text dài | No | |
| 13 | Đồng ý xử lý dữ liệu | Checkbox | Yes | "Tôi đồng ý cho MODORO xử lý thông tin cá nhân để cài đặt và hỗ trợ trợ lý AI (theo NĐ 13/2023/NĐ-CP)" |

### Dropdown lĩnh vực (Field 7)

- Bất động sản
- F&B / Nhà hàng / Quán cà phê
- Thương mại / Bán lẻ
- Dịch vụ (spa, salon, phòng khám...)
- Giáo dục / Đào tạo
- Công nghệ / IT
- Sản xuất
- Khác (ghi rõ) ← conditional text input

### Checkbox trợ lý làm gì (Field 8)

- Trả lời tin nhắn Zalo khách hàng
- Chăm sóc nhóm Zalo
- Quản lý Google Calendar *(sắp có)*
- Đọc & tóm tắt email Gmail *(sắp có)*
- Báo cáo sáng hàng ngày qua Telegram
- Đăng bài Facebook Fanpage *(sắp có)*
- Soạn nội dung marketing
- Cập nhật tin tức ngành hàng ngày
- Khác (ghi rõ)

### Notes

- Mặc định tất cả khách chưa cài. MODORO team remote cài qua TeamViewer.
- Form data chỉ cho MODORO staff sử dụng, không feed vào wizard tự động.
- Field 10 min date cần update mỗi đợt bán mới.

---

## 2. Bot Personalization — Wizard Step mới

### Vị trí: Step 1.5 (sau tên/công ty, trước 9Router)

#### Fields

| Field | Loại | Mô tả |
|-------|------|-------|
| Lĩnh vực | Dropdown | Cùng 8 ngành như Google Form |
| Tông giọng | Radio (3) | Chuyên nghiệp-lịch sự / Thân thiện-gần gũi / Ngắn gọn-hiệu quả |
| Xưng hô với khách | Radio (3) | Em-Anh/Chị / Tôi-Quý khách / Mình-Bạn |
| Cách gọi CEO | Text (prefill "[tên]") | User tự điền honorific mong muốn |

#### Khi user chọn lĩnh vực, wizard tự động:

1. **Copy skill file** → `skills/{linh-vuc}.md`
   - File skill tầng 2 (vận hành) cho ngành đó
   - KHÔNG đụng AGENTS.md hay SOUL.md

2. **Tạo industry workflow** → `industry/{linh-vuc}.md`
   - Quy trình vận hành riêng cho ngành
   - AGENTS.md chỉ thêm 1 dòng reference: "Đọc quy trình ngành: industry/{linh-vuc}.md"

3. **Inject tone/xưng hô vào IDENTITY.md** (KHÔNG phải SOUL.md)
   - IDENTITY.md đã có sẵn fields "Cách xưng hô" và "Phong cách"
   - SOUL.md giữ nguyên, không tự động sửa

4. **Gộp tin tức ngành vào cron báo cáo sáng** (1 cron duy nhất)
   - Cron báo cáo sáng thêm section: "Tin tức ngành [lĩnh vực] hôm nay"
   - Không tạo cron riêng

#### Skill files theo ngành (tầng 2 — vận hành)

| Ngành | File | Skill chính |
|-------|------|-------------|
| Bất động sản | `skills/bat-dong-san.md` | Quản lý lead, follow-up khách xem nhà, nhắc hạn hợp đồng, checklist giấy tờ, theo dõi tiến độ dự án |
| F&B | `skills/fnb.md` | Checklist mở/đóng cửa, nhắc nhập hàng, quản lý ca nhân viên, xử lý đặt bàn, theo dõi review, báo cáo doanh thu ngày |
| Thương mại / Bán lẻ | `skills/thuong-mai.md` | Theo dõi tồn kho, nhắc đặt hàng, quản lý đơn online, checklist giao hàng, khuyến mãi theo mùa |
| Dịch vụ | `skills/dich-vu.md` | Quản lý lịch hẹn, nhắc khách tái khám/tái sử dụng, theo dõi feedback, checklist vệ sinh/chuẩn bị |
| Giáo dục | `skills/giao-duc.md` | Quản lý lịch học, nhắc deadline bài tập, theo dõi học viên, gửi thông báo lớp, báo cáo tiến độ |
| Công nghệ / IT | `skills/cong-nghe.md` | Theo dõi ticket/task, nhắc deadline sprint, tóm tắt standup, quản lý khách hàng SaaS |
| Sản xuất | `skills/san-xuat.md` | Theo dõi đơn sản xuất, nhắc nguyên liệu, checklist QC, báo cáo output ngày, quản lý ca |
| Khác | `skills/tong-quat.md` | Skill vận hành chung: quản lý task, nhắc deadline, theo dõi khách hàng, báo cáo tuần |

#### Onboarding Message (Telegram lần đầu)

Ghi vào AGENTS.md section "Tin nhắn chào mừng", tích hợp với BOOTSTRAP.md flow hiện tại:

```
Chào [tên]! Em là trợ lý AI của [công ty].
Em đã được thiết lập cho ngành [lĩnh vực] với các kỹ năng:
• [skill 1]
• [skill 2]
• [skill 3]

Gõ "hướng dẫn" để xem cách giao việc cho em.
Gõ "skill" để xem danh sách kỹ năng.
```

#### Training & SOP (hiện trong app sau setup)

Khi CEO gõ **"hướng dẫn"** trên Telegram, bot gửi:

```
📋 Cách giao việc cho em:

1. Nhắn trực tiếp: "Soạn báo cáo tuần"
2. Forward tin Zalo: em sẽ tóm tắt và đề xuất trả lời
3. Giao task: "Nhắc tôi họp với Lan lúc 14h thứ 5"
4. Kiểm tra: "Hôm nay có gì?" → báo cáo tổng hợp

💡 Mẫu giao việc:
• "Trả lời khách tên X rằng..."
• "Tóm tắt tin nhắn Zalo hôm nay"
• "Soạn bài đăng Facebook về [chủ đề]"
• "Lên lịch tuần này"
```

Khi CEO gõ **"skill"**, bot liệt kê tất cả skill đã cài theo lĩnh vực.

---

## 3. Memory System — SQLite FTS5 + Append-only

### Cấu trúc thư mục (giữ nguyên path hiện tại)

```
memory/
├── people/           ← profile khách hàng, đối tác
├── projects/         ← dự án đang chạy
├── decisions/        ← quyết định CEO (theo tháng)
├── context/          ← ngữ cảnh tạm (2-3 file always-loaded)
├── industry/         ← knowledge base theo lĩnh vực (mới)
├── YYYY-MM-DD.md     ← nhật ký hàng ngày (append-only)
MEMORY.md             ← index nhẹ (~2k tokens, luôn load)
```

**Thay đổi vs hiện tại:** Chỉ thêm `memory/industry/`. Không di chuyển daily logs vào subfolder.

### SQLite FTS5

Dựa trên `tools/memory-db/` từ repo sếp:

- `rebuild-db.js` — scan `memory/**/*.md` → build `memory.db` (FTS5, porter tokenizer)
- `relevant-memory.js` — full-text search, top 5 results với rank score

**Rebuild strategy: INCREMENTAL, không full rebuild mỗi lần ghi.**

- Khi ghi memory mới → INSERT/UPDATE 1 record trong SQLite
- Full rebuild chỉ chạy: hàng đêm (cron) hoặc manual trigger
- Wrapper `memory_write(path, content)` xử lý cả file append + DB update atomic

### Append-only rules (ghi vào AGENTS.md)

```markdown
## Quy tắc bộ nhớ — Append-only

- memory/YYYY-MM-DD.md: KHÔNG BAO GIỜ sửa hoặc xóa. Chỉ append nội dung mới.
- MEMORY.md index: Chỉ thêm entry mới hoặc archive entry cũ. Không xóa.
- Khi cần "quên": đánh tag <!-- archived:YYYY-MM-DD --> trước nội dung. Không delete.
- Giữ MEMORY.md dưới 2k tokens. Entries inactive > 30 ngày → archive.
- Cập nhật MEMORY.md index đồng thời với mỗi thay đổi file chi tiết.
```

### Session start protocol (BỔ SUNG sau protocol hiện tại)

Protocol hiện tại giữ nguyên:
1. Đọc SOUL.md
2. Đọc IDENTITY.md
3. Đọc USER.md
4. Đọc memory/YYYY-MM-DD.md (hôm nay + hôm qua)
5. Đọc MEMORY.md

**Bổ sung thêm:**
6. Đọc memory/context/ (active context files)
7. Chạy `memory_search` với keyword từ tin nhắn đầu tiên
8. Đọc `industry/{linh-vuc}.md` nếu tin nhắn liên quan vận hành

Giới hạn: max 5 deep-dives khi bắt đầu phiên.

---

## 4. UI Rebrand — MODORO Brand

### Color scheme

| Token | Value | Usage |
|-------|-------|-------|
| `--primary` | `#E53935` (đỏ MODORO) | Buttons, accents |
| `--primary-hover` | `#C62828` | Button hover |
| `--secondary` | `#1A237E` (navy MODORO) | Headers, nav |
| `--surface` | `#0D1117` | Background (giữ dark theme) |
| `--surface-light` | `#161B22` | Cards |
| `--text` | `#F0F6FC` | Text chính |
| `--success` | `#4CAF50` | Status OK |
| `--danger` | `#EF5350` | Errors |
| `--warning` | `#FFA726` | Warnings |

### Logo

- File: `electron/ui/modoro-mascot.png` (transparent PNG, xóa nền trắng)
- Hiện trong: wizard step 1 (chào mừng), dashboard header, tray icon
- Kích thước wizard: 120x120px
- Kích thước dashboard header: 40x40px

### Layout changes

**Wizard:**
- Step 1: Mascot 120px + "Chào mừng đến với MODOROClaw!" + form fields
- Các step khác: header nhỏ hơn với mascot 40px + step title
- Button style: đỏ MODORO primary, navy secondary
- Card borders: navy subtle

**Dashboard:**
- Header: mascot 40px + "MODOROClaw" + status badge
- Channel cards: giữ layout hiện tại, đổi color scheme
- Bot toggle: đỏ khi running, navy khi stopped

**Tray icon:** Mascot scaled to 16x16

---

## 5. Installer Content — Skills, Training, Prompt SOP

### Bundled với installer

```
skills/
├── bat-dong-san.md
├── fnb.md
├── thuong-mai.md
├── dich-vu.md
├── giao-duc.md
├── cong-nghe.md
├── san-xuat.md
└── tong-quat.md

industry/
├── bat-dong-san.md
├── fnb.md
├── thuong-mai.md
├── dich-vu.md
├── giao-duc.md
├── cong-nghe.md
├── san-xuat.md
└── tong-quat.md

prompts/
├── session-start.md      (existing, updated)
├── training-guide.md     (NEW — nội dung gửi khi CEO gõ "hướng dẫn")
├── sop-templates.md      (NEW — mẫu giao việc theo lĩnh vực)
└── onboarding.md         (NEW — message chào mừng đầu tiên)
```

### Flow khi wizard chọn lĩnh vực

1. Copy `skills/{linh-vuc}.md` → workspace `skills/active.md`
2. Copy `industry/{linh-vuc}.md` → workspace `industry/active.md`
3. Append reference vào AGENTS.md: "Đọc thêm: skills/active.md, industry/active.md"
4. Update IDENTITY.md với tone + xưng hô
5. Generate onboarding message vào AGENTS.md section "Tin nhắn chào mừng"

---

## Dependencies & Risks

| Risk | Mitigation |
|------|------------|
| OpenClaw không hỗ trợ `memory_search` tool | Fallback: agent đọc MEMORY.md index + grep files |
| SQLite FTS5 không có sẵn trên mọi Node.js | Bundle better-sqlite3 npm package |
| Skill files chất lượng thấp | Review kỹ nội dung mỗi ngành trước khi ship |
| IDENTITY.md inject bị lỗi format | Validate markdown sau inject, rollback nếu lỗi |
| Google Form date picker min cứng | Document: update mỗi đợt bán |
