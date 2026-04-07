# MODOROClaw V2 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add industry personalization, memory system, UI rebrand, and content (skills/training/SOP) to the MODOROClaw Electron app.

**Architecture:** Wizard gets a new "Lĩnh vực" step that selects industry → copies skill/workflow files → injects tone into IDENTITY.md → updates AGENTS.md reference. Memory system adds SQLite FTS5 via better-sqlite3 for full-text search across markdown files. UI rebranded to MODORO red/navy color scheme with mascot logo.

**Tech Stack:** Electron 28, Node.js, better-sqlite3 (SQLite FTS5), HTML/CSS/JS (no framework)

**Spec:** `docs/superpowers/specs/2026-04-06-moodoroclaw-v2-design.md`

---

## Chunk 1: Google Form Content Document

This is a reference document (not code). Create once, team uses it to build the actual Google Form manually.

### Task 1: Write Google Form specification document

**Files:**
- Create: `docs/google-form-spec.md`

- [ ] **Step 1: Create the form spec document**

Write `docs/google-form-spec.md` containing the exact form structure from the design spec Section 1. Include:
- All 13 fields with types, validation rules, required status
- Dropdown options for lĩnh vực (8 industries + "Khác" with conditional text)
- Checkbox options for "trợ lý làm gì" (9 options, 3 marked "sắp có")
- Date picker min: 10/04/2026
- Conditional logic: "Khác" text input shows when "Khác" selected in Field 7
- Data consent text for Field 13

- [ ] **Step 2: Commit**

```bash
git add docs/google-form-spec.md
git commit -m "docs: add Google Form specification for customer onboarding"
```

---

## Chunk 2: UI Rebrand

Rebrand from orange accent to MODORO red/navy. Process the mascot logo. Update all 4 HTML pages.

### Task 2: Process mascot logo (remove white background)

**Files:**
- Create: `electron/ui/modoro-mascot.png`
- Create: `electron/ui/tray-icon.png` (16x16 version)

- [ ] **Step 1: Process the logo image**

The source logo is provided by the user (attached image in conversation). Use ImageMagick or sharp to:
1. Remove white background → transparent PNG
2. Save as `electron/ui/modoro-mascot.png` (original size)
3. Resize to 16x16 → `electron/ui/tray-icon.png`

If ImageMagick not available, use Node.js script with `sharp`:

```bash
npm install -g sharp-cli
# Or use an online tool and save the files manually
```

- [ ] **Step 2: Commit**

```bash
git add electron/ui/modoro-mascot.png electron/ui/tray-icon.png
git commit -m "assets: add MODORO mascot logo (transparent) and tray icon"
```

### Task 3: Update CSS color scheme

**Files:**
- Modify: `electron/ui/styles.css:2-16` (CSS variables)

- [ ] **Step 1: Replace CSS variables**

In `electron/ui/styles.css`, replace the `:root` block (lines 2-16):

```css
:root {
  --bg: #0D1117;
  --surface: #161B22;
  --surface-hover: #1C2128;
  --border: #1A237E33;
  --text: #F0F6FC;
  --text-muted: #8b949e;
  --accent: #E53935;
  --accent-hover: #C62828;
  --secondary: #1A237E;
  --success: #4CAF50;
  --warning: #FFA726;
  --danger: #EF5350;
  --radius: 12px;
}
```

- [ ] **Step 2: Update focus glow to red**

Replace line 80-81 (`input:focus` box-shadow):

```css
input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(229, 57, 53, 0.15);
}
```

- [ ] **Step 3: Add secondary button style and navy card border**

After `.btn-secondary:hover` (line 146), add:

```css
.btn-tertiary {
  background: var(--secondary);
  color: white;
  border: none;
}
.btn-tertiary:hover { background: #283593; }

.card-navy { border-color: var(--secondary); }
```

- [ ] **Step 4: Update wizard dot active color**

Line 198 `.wizard-progress .dot.active` already uses `var(--accent)` — this will auto-update. Verify visually.

- [ ] **Step 5: Commit**

```bash
git add electron/ui/styles.css
git commit -m "style: rebrand UI to MODORO red/navy color scheme"
```

### Task 4: Update wizard.html with mascot and new brand

**Files:**
- Modify: `electron/ui/wizard.html`

- [ ] **Step 1: Replace wizard step 1 emoji with mascot**

Find the step 1 heading area (around line 30-31) and replace the emoji with mascot image:

```html
<div style="text-align:center;margin:16px 0">
  <img src="modoro-mascot.png" alt="MODOROClaw" style="width:120px;height:120px">
</div>
<h1 style="text-align:center">Chào mừng đến với MODOROClaw!</h1>
```

- [ ] **Step 2: Add mascot to other step headers**

For each step header (steps 2-6), add a small mascot before the title:

```html
<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
  <img src="modoro-mascot.png" alt="" style="width:40px;height:40px">
  <h1>🧠 Kết nối trí tuệ nhân tạo</h1>
</div>
```

- [ ] **Step 3: Commit**

```bash
git add electron/ui/wizard.html
git commit -m "ui: add MODORO mascot to wizard steps"
```

### Task 5: Update dashboard.html with mascot header

**Files:**
- Modify: `electron/ui/dashboard.html`

- [ ] **Step 1: Replace dashboard titlebar/header**

Replace the titlebar with a branded header:

```html
<div class="titlebar" style="gap:8px">
  <img src="modoro-mascot.png" alt="" style="width:24px;height:24px;-webkit-app-region:no-drag">
  <span>MODOROClaw</span>
</div>
```

- [ ] **Step 2: Commit**

```bash
git add electron/ui/dashboard.html
git commit -m "ui: add MODORO mascot to dashboard header"
```

### Task 6: Update no-openclaw.html and main.js tray icon

**Files:**
- Modify: `electron/ui/no-openclaw.html`
- Modify: `electron/main.js:163-170` (tray icon)

- [ ] **Step 1: Replace emoji in no-openclaw.html**

Replace the 🦞 emoji (line 13) with mascot:

```html
<div style="text-align:center;margin-bottom:16px">
  <img src="modoro-mascot.png" alt="MODOROClaw" style="width:100px;height:100px">
</div>
```

- [ ] **Step 2: Update tray icon in main.js**

In `electron/main.js` `createTray()`, the existing code already loads `tray-icon.png` if it exists (line 163-166). Since Task 2 creates this file, the tray icon will auto-update. No code change needed — verify the path matches.

- [ ] **Step 3: Commit**

```bash
git add electron/ui/no-openclaw.html
git commit -m "ui: rebrand install screen with MODORO mascot"
```

---

## Chunk 3: Skill & Industry Content Files

Create the 8 skill files and 8 industry workflow files. Plus training/SOP prompts.

### Task 7: Create skill files (8 industries)

**Files:**
- Create: `skills/bat-dong-san.md`
- Create: `skills/fnb.md`
- Create: `skills/thuong-mai.md`
- Create: `skills/dich-vu.md`
- Create: `skills/giao-duc.md`
- Create: `skills/cong-nghe.md`
- Create: `skills/san-xuat.md`
- Create: `skills/tong-quat.md`

- [ ] **Step 1: Create skills directory**

```bash
mkdir -p skills
```

- [ ] **Step 2: Write all 8 skill files**

Each file follows this structure (example for F&B):

```markdown
# Kỹ năng ngành: F&B / Nhà hàng / Quán cà phê

## Checklist mở cửa
- Kiểm tra tồn kho nguyên liệu chính
- Xác nhận ca nhân viên hôm nay
- Kiểm tra đặt bàn/đơn online
- Mở máy POS, kiểm tra tiền mặt

## Checklist đóng cửa
- Tổng kết doanh thu ngày (cash + chuyển khoản)
- Kiểm tra tồn kho cuối ngày
- Ghi nhận nguyên liệu cần nhập ngày mai
- Lock cửa, tắt thiết bị

## Quản lý ca nhân viên
- Nhắc nhân viên ca tiếp theo trước 30 phút
- Ghi nhận nhân viên đi trễ/vắng
- Báo cáo giờ làm cuối tuần cho CEO

## Nhập hàng
- Nhắc nhập hàng khi tồn kho dưới mức tối thiểu
- Ghi nhận đơn nhập: nhà cung cấp, số lượng, giá
- So sánh giá nhập với lần trước

## Đặt bàn & Đơn online
- Xác nhận đặt bàn, gửi nhắc trước 1 giờ
- Theo dõi đơn delivery (GrabFood, ShopeeFood)
- Báo CEO khi có đơn lớn hoặc VIP

## Theo dõi review
- Tóm tắt review mới trên Google Maps, Facebook
- Phân loại: tích cực / tiêu cực / đề xuất
- Escalate review tiêu cực cho CEO
```

Write similar files for all 8 industries with tier-2 operational skills as listed in the spec.

- [ ] **Step 3: Commit**

```bash
git add skills/
git commit -m "content: add 8 industry skill files (tier-2 operations)"
```

### Task 8: Create industry workflow files

**Files:**
- Create: `industry/bat-dong-san.md`
- Create: `industry/fnb.md`
- Create: `industry/thuong-mai.md`
- Create: `industry/dich-vu.md`
- Create: `industry/giao-duc.md`
- Create: `industry/cong-nghe.md`
- Create: `industry/san-xuat.md`
- Create: `industry/tong-quat.md`

- [ ] **Step 1: Create industry directory**

```bash
mkdir -p industry
```

- [ ] **Step 2: Write all 8 industry workflow files**

Each file defines daily/weekly workflows. Example for F&B:

```markdown
# Quy trình vận hành: F&B

## Quy trình hàng ngày
1. **6:00-7:00** — Báo cáo sáng: doanh thu hôm qua, đặt bàn hôm nay, tồn kho cần nhập
2. **Trước giờ mở cửa** — Gửi checklist mở cửa cho nhân viên ca sáng
3. **Trong ngày** — Xử lý đặt bàn, đơn online, trả lời Zalo khách hàng
4. **Cuối ngày** — Checklist đóng cửa, tổng kết doanh thu, ghi nhận nhập hàng ngày mai

## Quy trình hàng tuần
- Thứ 2: Tổng kết tuần trước, lên kế hoạch tuần này
- Thứ 6: Báo cáo giờ làm nhân viên, nhắc CEO duyệt lương

## Quy trình xử lý tin nhắn Zalo
- Hỏi giờ mở cửa, menu, giá → trả lời ngay
- Đặt bàn → xác nhận, ghi vào lịch
- Khiếu nại → escalate CEO
- Hỏi tuyển dụng → chuyển thông tin liên hệ

## Tin tức ngành
Mỗi sáng tóm tắt 3-5 tin tức F&B Việt Nam từ: CafeBiz, VnExpress Kinh doanh, Brands Vietnam.
```

- [ ] **Step 3: Commit**

```bash
git add industry/
git commit -m "content: add 8 industry workflow files"
```

### Task 9: Create training guide and SOP prompts

**Files:**
- Create: `prompts/training-guide.md`
- Create: `prompts/sop-templates.md`
- Create: `prompts/onboarding.md`

- [ ] **Step 1: Write training-guide.md**

Content sent when CEO types "hướng dẫn" on Telegram (from spec Section 2).

- [ ] **Step 2: Write sop-templates.md**

SOP templates per industry — sample task delegation prompts CEO can copy-paste.

- [ ] **Step 3: Write onboarding.md**

Template for first-message onboarding with placeholders: `{name}`, `{company}`, `{industry}`, `{skills}`.

- [ ] **Step 4: Commit**

```bash
git add prompts/training-guide.md prompts/sop-templates.md prompts/onboarding.md
git commit -m "content: add training guide, SOP templates, and onboarding prompt"
```

---

## Chunk 4: Memory System (SQLite FTS5)

### Task 10: Install better-sqlite3 and create memory-db tools

**Files:**
- Modify: `electron/package.json` (add better-sqlite3 dependency)
- Create: `tools/memory-db/rebuild-db.js`
- Create: `tools/memory-db/search-memory.js`
- Create: `tools/memory-db/memory-write.js`

- [ ] **Step 1: Install better-sqlite3**

```bash
cd electron && npm install better-sqlite3
```

Note: better-sqlite3 is a native module — electron-builder will bundle it for the target platform.

- [ ] **Step 2: Create rebuild-db.js**

Full rebuild script that scans `memory/**/*.md` and builds FTS5 index:

```javascript
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const glob = require('glob'); // or use fs.readdirSync recursive

const ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = path.join(__dirname, 'memory.db');

// Delete existing DB
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

const db = new Database(DB_PATH);
db.exec(`CREATE VIRTUAL TABLE memories USING fts5(path, content, tokenize='porter')`);

const insert = db.prepare('INSERT INTO memories (path, content) VALUES (?, ?)');

// Scan all markdown files in memory/
const memoryDir = path.join(ROOT, 'memory');
function scanDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) scanDir(full);
    else if (entry.name.endsWith('.md')) {
      const content = fs.readFileSync(full, 'utf-8');
      const rel = path.relative(ROOT, full).replace(/\\/g, '/');
      insert.run(rel, content);
    }
  }
}

// Also index top-level md files: MEMORY.md, IDENTITY.md, USER.md
for (const f of ['MEMORY.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md']) {
  const full = path.join(ROOT, f);
  if (fs.existsSync(full)) {
    insert.run(f, fs.readFileSync(full, 'utf-8'));
  }
}

scanDir(memoryDir);

// Also scan skills/ and industry/
for (const sub of ['skills', 'industry']) {
  scanDir(path.join(ROOT, sub));
}

db.close();
console.log('Memory DB rebuilt:', DB_PATH);
```

- [ ] **Step 3: Create search-memory.js**

```javascript
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'memory.db');

function searchMemory(query, limit = 5) {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare(
    'SELECT path, content, rank FROM memories WHERE memories MATCH ? ORDER BY rank LIMIT ?'
  ).all(query, limit);
  db.close();
  return rows.map(r => ({
    path: r.path,
    snippet: r.content.substring(0, 200),
    relevance: r.rank,
  }));
}

// CLI mode
if (require.main === module) {
  const query = process.argv[2];
  if (!query) { console.log('Usage: node search-memory.js "search terms"'); process.exit(1); }
  const results = searchMemory(query);
  results.forEach((r, i) => {
    console.log(`\n--- ${i + 1}. ${r.path} (rank: ${r.relevance.toFixed(2)}) ---`);
    console.log(r.snippet);
  });
}

module.exports = { searchMemory };
```

- [ ] **Step 4: Create memory-write.js (atomic write + incremental DB update)**

```javascript
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'memory.db');
const ROOT = path.resolve(__dirname, '..', '..');

function memoryWrite(filePath, content, append = true) {
  const fullPath = path.resolve(ROOT, filePath);

  // Write to file
  if (append && fs.existsSync(fullPath)) {
    fs.appendFileSync(fullPath, '\n' + content, 'utf-8');
  } else {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
  }

  // Update DB incrementally
  if (!fs.existsSync(DB_PATH)) return; // DB not built yet
  const db = new Database(DB_PATH);
  const rel = path.relative(ROOT, fullPath).replace(/\\/g, '/');
  const fullContent = fs.readFileSync(fullPath, 'utf-8');

  // Delete old entry if exists, insert new
  db.prepare('DELETE FROM memories WHERE path = ?').run(rel);
  db.prepare('INSERT INTO memories (path, content) VALUES (?, ?)').run(rel, fullContent);
  db.close();
}

module.exports = { memoryWrite };
```

- [ ] **Step 5: Commit**

```bash
git add tools/memory-db/ electron/package.json
git commit -m "feat: add SQLite FTS5 memory system (rebuild, search, incremental write)"
```

### Task 11: Create memory/industry/ directory and update AGENTS.md

**Files:**
- Create: `memory/industry/.gitkeep`
- Create: `memory/context/.gitkeep`
- Modify: `AGENTS.md` (add memory rules + industry reference)

- [ ] **Step 1: Create directories**

```bash
mkdir -p memory/industry memory/context
touch memory/industry/.gitkeep memory/context/.gitkeep
```

- [ ] **Step 2: Add append-only rules to AGENTS.md**

Append after the existing "Hệ thống bộ nhớ phân cấp" section (after line 49), before "Ghi ra file":

```markdown
### Quy tắc Append-only

- `memory/YYYY-MM-DD.md`: KHÔNG BAO GIỜ sửa hoặc xóa. Chỉ append nội dung mới.
- `MEMORY.md` index: Chỉ thêm entry mới hoặc archive entry cũ. Không xóa.
- Khi cần "quên": đánh tag `<!-- archived:YYYY-MM-DD -->` trước nội dung. Không delete.
- Giữ MEMORY.md dưới 2k tokens. Entries inactive > 30 ngày → archive.
- Cập nhật MEMORY.md index đồng thời với mỗi thay đổi file chi tiết.

### Bổ sung session start

Sau khi đọc SOUL.md, IDENTITY.md, USER.md, MEMORY.md, daily logs:
6. Đọc `memory/context/` (active context files)
7. Chạy `memory_search` với keyword từ tin nhắn đầu tiên
8. Đọc `industry/active.md` nếu tin nhắn liên quan vận hành

Giới hạn: max 5 deep-dives khi bắt đầu phiên.
```

- [ ] **Step 3: Add industry/skills reference line to AGENTS.md**

In the "Giao thức mở rộng" section (line 212), add:

```markdown
- `skills/active.md` — kỹ năng ngành đã chọn
- `industry/active.md` — quy trình vận hành ngành đã chọn
```

- [ ] **Step 4: Commit**

```bash
git add memory/industry/.gitkeep memory/context/.gitkeep AGENTS.md
git commit -m "feat: add memory directories and append-only rules to AGENTS.md"
```

---

## Chunk 5: Wizard Personalization Step

### Task 12: Add new IPC handlers for personalization

**Files:**
- Modify: `electron/main.js` (add `save-personalization` IPC handler)
- Modify: `electron/preload.js` (expose new IPC)

- [ ] **Step 1: Add IPC handler in main.js**

Add after the `save-zalo-mode` handler:

```javascript
// Save personalization (industry, tone, pronouns)
ipcMain.handle('save-personalization', async (_event, { industry, tone, pronouns, ceoTitle }) => {
  try {
    // 1. Copy skill file → skills/active.md
    const skillSrc = path.join(resourceDir, 'skills', `${industry}.md`);
    const skillDst = path.join(resourceDir, 'skills', 'active.md');
    if (fs.existsSync(skillSrc)) {
      fs.copyFileSync(skillSrc, skillDst);
    }

    // 2. Copy industry workflow → industry/active.md
    const indSrc = path.join(resourceDir, 'industry', `${industry}.md`);
    const indDst = path.join(resourceDir, 'industry', 'active.md');
    if (fs.existsSync(indSrc)) {
      fs.copyFileSync(indSrc, indDst);
    }

    // 3. Update IDENTITY.md with tone + pronouns
    const identityPath = path.join(resourceDir, 'IDENTITY.md');
    if (fs.existsSync(identityPath)) {
      let content = fs.readFileSync(identityPath, 'utf-8');
      // Replace xưng hô line
      content = content.replace(
        /- \*\*Cách xưng hô:\*\* .*/,
        `- **Cách xưng hô:** ${pronouns} — gọi chủ nhân là ${ceoTitle}`
      );
      // Replace phong cách line
      const toneMap = {
        'professional': 'Chuyên nghiệp, lịch sự, rõ ràng. Phù hợp giao tiếp doanh nghiệp.',
        'friendly': 'Thân thiện, gần gũi, nhiệt tình. Phù hợp ngành dịch vụ, bán lẻ.',
        'concise': 'Ngắn gọn, hiệu quả, đi thẳng vào vấn đề. Không dài dòng.',
      };
      content = content.replace(
        /- \*\*Phong cách:\*\* .*/,
        `- **Phong cách:** ${toneMap[tone] || toneMap['friendly']}`
      );
      fs.writeFileSync(identityPath, content, 'utf-8');
    }

    // 4. Add reference in AGENTS.md if not already there
    const agentsPath = path.join(resourceDir, 'AGENTS.md');
    if (fs.existsSync(agentsPath)) {
      let content = fs.readFileSync(agentsPath, 'utf-8');
      if (!content.includes('skills/active.md')) {
        content = content.replace(
          '## Giao thức mở rộng',
          '## Kỹ năng ngành\n\nĐọc thêm: `skills/active.md`, `industry/active.md`\n\n## Giao thức mở rộng'
        );
        fs.writeFileSync(agentsPath, content, 'utf-8');
      }
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});
```

- [ ] **Step 2: Expose in preload.js**

Add to the `contextBridge.exposeInMainWorld('claw', {` block:

```javascript
  // Personalization
  savePersonalization: (opts) => ipcRenderer.invoke('save-personalization', opts),
```

- [ ] **Step 3: Commit**

```bash
git add electron/main.js electron/preload.js
git commit -m "feat: add save-personalization IPC handler"
```

### Task 13: Add personalization wizard step in wizard.html

**Files:**
- Modify: `electron/ui/wizard.html`

- [ ] **Step 1: Add Step 1.5 HTML (between step 1 and step 2)**

Insert new wizard step after the existing step 1 `</div>` and before step 2:

```html
<!-- ==================== STEP 1B: Lĩnh vực & Cá nhân hóa ==================== -->
<div class="wizard-step" id="step-1b">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
    <img src="modoro-mascot.png" alt="" style="width:40px;height:40px">
    <h1>🏢 Lĩnh vực & phong cách</h1>
  </div>
  <p>Trợ lý sẽ được tối ưu cho ngành của bạn.</p>

  <label>Lĩnh vực kinh doanh</label>
  <select id="industry">
    <option value="">— Chọn lĩnh vực —</option>
    <option value="bat-dong-san">Bất động sản</option>
    <option value="fnb">F&B / Nhà hàng / Quán cà phê</option>
    <option value="thuong-mai">Thương mại / Bán lẻ</option>
    <option value="dich-vu">Dịch vụ (spa, salon, phòng khám...)</option>
    <option value="giao-duc">Giáo dục / Đào tạo</option>
    <option value="cong-nghe">Công nghệ / IT</option>
    <option value="san-xuat">Sản xuất</option>
    <option value="tong-quat">Khác / Tổng quát</option>
  </select>

  <label>Phong cách giao tiếp</label>
  <div style="margin-bottom:12px">
    <label class="radio-option" onclick="selectTone('professional')">
      <input type="radio" name="tone" value="professional">
      <div><strong>Chuyên nghiệp — lịch sự</strong><p>Phù hợp B2B, bất động sản, công nghệ</p></div>
    </label>
    <label class="radio-option" onclick="selectTone('friendly')">
      <input type="radio" name="tone" value="friendly" checked>
      <div><strong>Thân thiện — gần gũi</strong><p>Phù hợp F&B, dịch vụ, bán lẻ</p></div>
    </label>
    <label class="radio-option" onclick="selectTone('concise')">
      <input type="radio" name="tone" value="concise">
      <div><strong>Ngắn gọn — hiệu quả</strong><p>Đi thẳng vào vấn đề, không dài dòng</p></div>
    </label>
  </div>

  <label>Xưng hô với khách hàng</label>
  <div style="margin-bottom:12px">
    <label class="radio-option" onclick="selectPronouns('em-anh-chi')">
      <input type="radio" name="pronouns" value="em-anh-chi" checked>
      <div><strong>Em — Anh/Chị</strong><p>Lịch sự, phổ biến nhất</p></div>
    </label>
    <label class="radio-option" onclick="selectPronouns('toi-quy-khach')">
      <input type="radio" name="pronouns" value="toi-quy-khach">
      <div><strong>Tôi — Quý khách</strong><p>Trang trọng, doanh nghiệp lớn</p></div>
    </label>
    <label class="radio-option" onclick="selectPronouns('minh-ban')">
      <input type="radio" name="pronouns" value="minh-ban">
      <div><strong>Mình — Bạn</strong><p>Thân thiện, trẻ trung</p></div>
    </label>
  </div>

  <label>Trợ lý gọi bạn là</label>
  <input type="text" id="ceo-title" placeholder="Ví dụ: anh Huy, chị Lan, sếp">

  <div class="btn-row">
    <button class="btn btn-secondary" onclick="goNext(1)">← Quay lại</button>
    <button class="btn btn-primary" onclick="goNext(2)">Tiếp tục →</button>
  </div>
</div>
```

- [ ] **Step 2: Add JS variables and navigation logic**

In the `<script>` section, add:

```javascript
let selectedTone = 'friendly';
let selectedPronouns = 'em-anh-chi';

function selectTone(t) { selectedTone = t; }
function selectPronouns(p) { selectedPronouns = p; }
```

Update the `goNext()` function to handle the new step flow:
- Step 1 → Step 1b
- Step 1b → Step 2
- Step 1b back → Step 1

Update progress dots to include the new step.

- [ ] **Step 3: Update finishSetup() to save personalization**

In `finishSetup()`, after saving wizard config and before cron setup, add:

```javascript
status.textContent = 'Đang cá nhân hóa trợ lý...';
const industry = document.getElementById('industry').value || 'tong-quat';
const ceoTitle = document.getElementById('ceo-title').value.trim() || name;
await window.claw.savePersonalization({
  industry,
  tone: selectedTone,
  pronouns: selectedPronouns,
  ceoTitle,
}).catch(() => {});
```

Also update the morning briefing cron message to include industry news:

```javascript
message: `Tạo báo cáo sáng cho ${name} (${company || 'doanh nghiệp'}, ngành ${industry}). Bao gồm: lịch họp hôm nay, tin tức ngành ${industry} (3-5 tin), email quan trọng chưa đọc, tóm tắt tin nhắn Zalo qua đêm.`,
```

- [ ] **Step 4: Commit**

```bash
git add electron/ui/wizard.html
git commit -m "feat: add industry personalization step to wizard"
```

---

## Chunk 6: Onboarding Message & AGENTS.md Updates

### Task 14: Add onboarding message section to AGENTS.md

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Add "Tin nhắn chào mừng" section**

Before "Giao thức mở rộng" section, add:

```markdown
## Tin nhắn chào mừng

Khi CEO nhắn Telegram lần đầu (hoặc sau reset), gửi tin nhắn chào mừng.
Đọc `prompts/onboarding.md` để lấy template, điền thông tin từ IDENTITY.md và skills/active.md.

## Lệnh đặc biệt

Khi CEO gõ trên Telegram:
- **"hướng dẫn"** → đọc `prompts/training-guide.md` và gửi nội dung
- **"skill"** → đọc `skills/active.md` và liệt kê các kỹ năng đã cài
- **"báo cáo"** → tạo báo cáo tổng hợp ngay lập tức (không chờ cron)
```

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "feat: add onboarding message and special commands to AGENTS.md"
```

### Task 15: Update session-start.md with memory search protocol

**Files:**
- Modify: `prompts/session-start.md`

- [ ] **Step 1: Read current session-start.md**

Check current content and append the additional steps (6-8 from spec).

- [ ] **Step 2: Append memory search protocol**

Add to end of file:

```markdown
## Bổ sung: Tìm kiếm bộ nhớ

Sau khi hoàn thành các bước trên:
6. Đọc tất cả files trong `memory/context/`
7. Nếu có tin nhắn đầu tiên, chạy `memory_search` với keyword chính
8. Nếu tin nhắn liên quan vận hành ngành, đọc `industry/active.md`

Giới hạn: max 5 deep-dives tổng cộng khi bắt đầu phiên.
```

- [ ] **Step 3: Commit**

```bash
git add prompts/session-start.md
git commit -m "feat: add memory search protocol to session start"
```

---

## Chunk 7: Integration & Final Wiring

### Task 16: Add memory rebuild to gateway startup

**Files:**
- Modify: `electron/main.js` (in `startOpenClaw()`)

- [ ] **Step 1: Run memory rebuild before gateway starts**

In `startOpenClaw()`, after `ensureDefaultConfig(bin)` and before `start9Router()`, add:

```javascript
  // Rebuild memory DB before gateway start
  try {
    const rebuildScript = path.join(resourceDir, 'tools', 'memory-db', 'rebuild-db.js');
    if (fs.existsSync(rebuildScript)) {
      await execFilePromise('node', [rebuildScript], { timeout: 10000, cwd: resourceDir, stdio: 'pipe' });
    }
  } catch {}
```

- [ ] **Step 2: Commit**

```bash
git add electron/main.js
git commit -m "feat: rebuild memory DB on gateway startup"
```

### Task 17: Verify full flow end-to-end

- [ ] **Step 1: Run RESET.bat**
- [ ] **Step 2: Run RUN.bat**
- [ ] **Step 3: Verify no-openclaw screen shows mascot**
- [ ] **Step 4: Install openclaw, verify wizard loads**
- [ ] **Step 5: Verify Step 1 shows mascot + new fields**
- [ ] **Step 6: Verify Step 1b (industry selection) appears and works**
- [ ] **Step 7: Complete wizard through all steps**
- [ ] **Step 8: Verify on dashboard: mascot header, red/navy colors**
- [ ] **Step 9: Verify skills/active.md and industry/active.md were created**
- [ ] **Step 10: Verify IDENTITY.md was updated with tone/pronouns**
- [ ] **Step 11: Send Telegram message, verify bot responds**
- [ ] **Step 12: Verify memory DB exists at tools/memory-db/memory.db**
- [ ] **Step 13: Run `node tools/memory-db/search-memory.js "test"` to verify search works**
