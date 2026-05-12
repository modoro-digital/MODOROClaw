# Image Skill Templates Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the auto-remember 5-question image preference flow with a reusable skill-based system where CEO creates named image templates.

**Architecture:** New `skills/image-templates/` directory holds CEO-created `.md` skill files. Three API endpoints (list/create/delete) in cron-api.js manage them server-side. Skill `.md` files (facebook-image, facebook-post-workflow, zalo-post-workflow) updated to use skill-first lookup instead of mandatory 5-question flow. Preferences file stays for cron fallback only.

**Tech Stack:** Node.js (cron-api.js HTTP server), Markdown with YAML frontmatter (skill files)

**Spec:** `docs/superpowers/specs/2026-05-12-image-skill-templates-design.md`

---

## Chunk 1: Backend API + seedWorkspace

### Task 1: seedWorkspace — create `skills/image-templates/` directory

**Files:**
- Modify: `electron/lib/workspace.js:558-563`

- [ ] **Step 1: Add directory creation after brand-assets block**

In `seedWorkspace()`, after line 563 (`media-assets` loop closing brace), add:

```javascript
  try { fs.mkdirSync(path.join(ws, 'skills', 'image-templates'), { recursive: true }); } catch {}
```

- [ ] **Step 2: Verify — run smoke tests**

Run: `cd electron && node scripts/smoke-test.js`
Expected: All pass, 0 failures

- [ ] **Step 3: Commit**

```bash
git add electron/lib/workspace.js
git commit -m "feat: seedWorkspace creates skills/image-templates/ directory"
```

---

### Task 2: API endpoints — GET/POST/DELETE `/api/image/skills`

**Files:**
- Modify: `electron/lib/cron-api.js:1687` (after image preferences block)

- [ ] **Step 1: Add image skills endpoints after the image preferences block**

Insert after line 1687 (the closing of the `/api/image/preferences` block), before the `// ─── Image Generation API` comment:

```javascript
    // ─── Image Skill Templates API ───────────────────────────────
    } else if (urlPath === '/api/image/skills') {
      const skillsDir = path.join(getWorkspace(), 'skills', 'image-templates');
      try { fs.mkdirSync(skillsDir, { recursive: true }); } catch {}

      if (req.method === 'DELETE') {
        const name = String(params.name || '').trim();
        if (!name || !/^[a-z0-9-]+$/.test(name)) return jsonResp(res, 400, { error: 'name required (a-z0-9 and hyphens only)' });
        const filePath = path.join(skillsDir, name + '.md');
        if (!fs.existsSync(filePath)) return jsonResp(res, 404, { error: `skill "${name}" not found` });
        try { fs.unlinkSync(filePath); } catch (e) { return jsonResp(res, 500, { error: e.message }); }
        return jsonResp(res, 200, { ok: true, deleted: name });

      } else if (req.method === 'POST') {
        const name = String(params.name || '').trim();
        if (!name || !/^[a-z0-9-]+$/.test(name)) return jsonResp(res, 400, { error: 'name required (a-z0-9 and hyphens only)' });
        if (name.length > 60) return jsonResp(res, 400, { error: 'name too long (max 60 chars)' });
        const description = String(params.description || '').trim();
        if (!description) return jsonResp(res, 400, { error: 'description required' });
        const filePath = path.join(skillsDir, name + '.md');
        if (fs.existsSync(filePath)) return jsonResp(res, 409, { error: `skill "${name}" already exists. Delete first to replace.` });

        const style = String(params.style || 'A');
        const colorTone = String(params.colorTone || 'A');
        const composition = String(params.composition || 'A');
        const lighting = String(params.lighting || 'A');
        const text = String(params.text || 'A');
        const captionTemplate = String(params.captionTemplate || '').trim();
        const customNotes = String(params.customNotes || '').trim();

        const md = [
          '---',
          `name: ${name}`,
          `description: ${description}`,
          'type: image-template',
          `createdAt: ${new Date().toISOString().slice(0, 10)}`,
          '---',
          '',
          '## Style',
          `- style: ${style}`,
          `- colorTone: ${colorTone}`,
          `- composition: ${composition}`,
          `- lighting: ${lighting}`,
          `- text: ${text}`,
          customNotes ? `- notes: ${customNotes}` : null,
          '',
          '## Caption template',
          captionTemplate || '(no template)',
          '',
        ].filter(line => line !== null).join('\n') + '\n';

        try { fs.writeFileSync(filePath, md, 'utf-8'); } catch (e) { return jsonResp(res, 500, { error: e.message }); }
        return jsonResp(res, 201, { ok: true, name, path: `skills/image-templates/${name}.md` });

      } else {
        // GET — list all image template skills
        try {
          const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md'));
          const skills = [];
          for (const f of files) {
            try {
              const content = fs.readFileSync(path.join(skillsDir, f), 'utf-8');
              const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
              if (!fmMatch) continue;
              const fm = {};
              for (const line of fmMatch[1].split('\n')) {
                const m = line.match(/^(\w+):\s*(.+)$/);
                if (m) fm[m[1]] = m[2].trim();
              }
              if (fm.type !== 'image-template') continue;

              const styleMatch = content.match(/## Style\n([\s\S]*?)(?=\n## |$)/);
              const styleLines = {};
              if (styleMatch) {
                for (const sl of styleMatch[1].split('\n')) {
                  const sm = sl.match(/^- (\w+):\s*(.+)$/);
                  if (sm) styleLines[sm[1]] = sm[2].trim();
                }
              }

              const captionMatch = content.match(/## Caption template\n([\s\S]*?)$/);
              const caption = captionMatch ? captionMatch[1].trim() : '';

              skills.push({
                name: fm.name || f.replace('.md', ''),
                description: fm.description || '',
                createdAt: fm.createdAt || '',
                style: styleLines,
                captionTemplate: caption === '(no template)' ? '' : caption,
              });
            } catch {}
          }
          return jsonResp(res, 200, { skills });
        } catch (e) { return jsonResp(res, 200, { skills: [] }); }
      }
```

- [ ] **Step 2: Add endpoints to the 404 endpoint list**

In the 404 handler at line 2082, add `'/api/image/skills'` to the `endpoints` array.

- [ ] **Step 3: Verify — run smoke tests**

Run: `cd electron && node scripts/smoke-test.js`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add electron/lib/cron-api.js
git commit -m "feat: image skill templates API — GET/POST/DELETE /api/image/skills"
```

---

## Chunk 2: Skill file updates

### Task 3: Update `facebook-image.md` — skill-first flow

**Files:**
- Modify: `skills/operations/facebook-image.md:29-79`

- [ ] **Step 1: Replace the 5-question section (lines 29-79) with skill-first flow**

Replace lines 29-79 (from `5. **BẮT BUỘC HỎI 5 CÂU...` through `Trả về preference đã lưu. Nếu rỗng/chưa có → dùng default A.`) with:

```markdown
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
```

- [ ] **Step 2: Verify file is valid markdown — visual check**

Read the file, confirm the flow reads naturally and all API URLs are correct.

- [ ] **Step 3: Commit**

```bash
git add skills/operations/facebook-image.md
git commit -m "feat: facebook-image.md — skill-first flow replaces mandatory 5-question"
```

---

### Task 4: Update `facebook-post-workflow.md` — skill-first reference

**Files:**
- Modify: `skills/marketing/facebook-post-workflow.md:196-207`

- [ ] **Step 1: Replace the 5-question section (lines 196-207) with skill reference**

Replace:
```
## Hỏi CEO 5 câu trước khi tạo ảnh — BẮT BUỘC (trừ scheduled posts)

**Nếu CEO tương tác trực tiếp (Telegram):** BẮT BUỘC hỏi 5 câu ABCDE trước khi soạn prompt. Xem format câu hỏi tại `skills/operations/facebook-image.md` bước 5.

**Nếu scheduled post tự động (không có CEO trả lời):** Đọc preference đã lưu:
```
web_fetch url="http://127.0.0.1:20200/api/image/preferences" method=GET
```
Dùng preference trả về. Nếu chưa có preference → dùng default A cho tất cả.

**Sau khi CEO trả lời 5 câu:** Lưu preference qua POST `/api/image/preferences` (xem facebook-image.md bước 5).
```

With:
```markdown
## Chọn style ảnh — theo skill hoặc free-form

**Xem quy trình đầy đủ tại `skills/operations/facebook-image.md` bước 5 (skill-first flow).**

Tóm tắt: gọi `GET /api/image/skills` → CEO chọn skill hoặc mô tả tự do. KHÔNG hỏi 5 câu ABCDE trừ khi CEO đang tạo skill mới.

**Scheduled posts tự động:** Nếu prompt có `[SKILL: name]` → đọc skill. Không có → đọc `GET /api/image/preferences`. Không có preference → default A.
```

- [ ] **Step 2: Commit**

```bash
git add skills/marketing/facebook-post-workflow.md
git commit -m "feat: facebook-post-workflow — skill-first style selection"
```

---

### Task 5: Update `zalo-post-workflow.md` — skill-first reference

**Files:**
- Modify: `skills/marketing/zalo-post-workflow.md:176-187`

- [ ] **Step 1: Replace the 5-question section (lines 176-187) with skill reference**

Replace:
```
## Hỏi CEO 5 câu trước khi tạo ảnh — BẮT BUỘC (trừ cron tự động)

**Nếu CEO tương tác trực tiếp (Telegram):** BẮT BUỘC hỏi 5 câu ABCDE trước khi soạn prompt. Xem format câu hỏi tại `skills/operations/facebook-image.md` bước 5.

**Nếu cron tự động (không có CEO trả lời):** Đọc preference đã lưu:
```
web_fetch url="http://127.0.0.1:20200/api/image/preferences" method=GET
```
Dùng preference trả về. Nếu chưa có preference → dùng default A cho tất cả.

**Sau khi CEO trả lời 5 câu:** Lưu preference qua POST `/api/image/preferences` (xem facebook-image.md bước 5).
```

With:
```markdown
## Chọn style ảnh — theo skill hoặc free-form

**Xem quy trình đầy đủ tại `skills/operations/facebook-image.md` bước 5 (skill-first flow).**

Tóm tắt: gọi `GET /api/image/skills` → CEO chọn skill hoặc mô tả tự do. KHÔNG hỏi 5 câu ABCDE trừ khi CEO đang tạo skill mới.

**Cron tự động:** Nếu prompt có `[SKILL: name]` → đọc skill. Không có → đọc `GET /api/image/preferences`. Không có preference → default A.
```

- [ ] **Step 2: Commit**

```bash
git add skills/marketing/zalo-post-workflow.md
git commit -m "feat: zalo-post-workflow — skill-first style selection"
```

---

### Task 6: Update `skills/INDEX.md` — add Image templates category

**Files:**
- Modify: `skills/INDEX.md:60-64`

- [ ] **Step 1: Add Image templates section before the closing line**

After line 60 (end of Tai chinh table), before the `---` separator at line 62, insert:

```markdown

## Mau anh (CEO tao) — `skills/image-templates/`

CEO tao skill anh qua Telegram ("tao skill anh moi"). Goi `GET /api/image/skills` de xem danh sach.
```

- [ ] **Step 2: Update total count**

Change line 63 from:
```
**Tong: 32 skills thuc te** cho chu shop Viet Nam.
```
To:
```
**Tong: 32 skills thuc te + mau anh CEO tao** cho chu shop Viet Nam.
```

- [ ] **Step 3: Commit**

```bash
git add skills/INDEX.md
git commit -m "feat: INDEX.md — add Image templates category"
```

---

## Chunk 3: AGENTS.md + version bump

### Task 7: Update AGENTS.md — skill-first routing + `[SKILL:]` convention

**Files:**
- Modify: `AGENTS.md:208,238-242`

- [ ] **Step 1: Update Capability Router `brand_image_generate` row (line 208)**

Replace:
```
| "tạo ảnh", "banner", "poster" (KHÔNG kèm Zalo/Facebook) | `brand_image_generate` | `skills/operations/facebook-image.md` |
```

With:
```
| "tạo ảnh", "banner", "poster" (KHÔNG kèm Zalo/Facebook), "tạo skill ảnh mới", "xóa skill ảnh" | `brand_image_generate` | `skills/operations/facebook-image.md` |
```

- [ ] **Step 2: Update "Facebook + Tạo ảnh" section (lines 238-242)**

Replace:
```
## Facebook + Tạo ảnh + Tài sản thương hiệu — CHỈ CEO Telegram
Đọc `skills/marketing/facebook-post-workflow.md` cho mọi yêu cầu đăng bài Facebook (tạo ảnh → preview → đăng).
Đọc `skills/operations/facebook-image.md` chỉ khi CEO yêu cầu tạo ảnh thuần (không đăng Facebook/Zalo).
Khách Zalo yêu cầu → "Dạ đây là thông tin nội bộ em không chia sẻ được ạ."
**CẤM dùng native image_generation tool.** Luôn tạo ảnh qua `web_fetch` tới `/api/image/generate`. KHÔNG BAO GIỜ gọi image_generation trực tiếp.
```

With:
```
## Facebook + Tạo ảnh + Tài sản thương hiệu — CHỈ CEO Telegram
Đọc `skills/operations/facebook-image.md` cho mọi yêu cầu tạo ảnh (skill-first flow: `GET /api/image/skills` → chọn skill hoặc mô tả tự do).
Đọc `skills/marketing/facebook-post-workflow.md` cho yêu cầu đăng bài Facebook.
Cron có `[SKILL: <name>]` → đọc skill file qua workspace API. Không có → dùng `GET /api/image/preferences` fallback.
Khách Zalo yêu cầu → "Dạ đây là thông tin nội bộ em không chia sẻ được ạ."
**CẤM dùng native image_generation tool.** Luôn tạo ảnh qua `web_fetch` tới `/api/image/generate`. KHÔNG BAO GIỜ gọi image_generation trực tiếp.
```

- [ ] **Step 3: Bump AGENTS.md version marker**

Line 1: change `<!-- modoroclaw-agents-version: 97 -->` to `<!-- modoroclaw-agents-version: 98 -->`

- [ ] **Step 4: Bump workspace.js version constant**

In `electron/lib/workspace.js:35`, change:
```javascript
const CURRENT_AGENTS_MD_VERSION = 97;
```
To:
```javascript
const CURRENT_AGENTS_MD_VERSION = 98;
```

- [ ] **Step 5: Verify — run smoke tests**

Run: `cd electron && node scripts/smoke-test.js`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md electron/lib/workspace.js
git commit -m "feat: AGENTS.md v98 — skill-first image routing + [SKILL:] convention"
```

---

## Verification

After all tasks complete:

1. **Smoke test:** `cd electron && node scripts/smoke-test.js` — 0 failures
2. **Manual API test (when app running):**
   - `curl http://127.0.0.1:20200/api/image/skills` → `{"skills":[]}`
   - Create: `curl -X POST http://127.0.0.1:20200/api/image/skills -H "Content-Type: application/json" -d '{"name":"test-skill","description":"Test","style":"A","colorTone":"B","composition":"C","lighting":"A","text":"B","captionTemplate":"GIAM {discount}%"}'` → `{"ok":true,"name":"test-skill",...}`
   - List again → shows `test-skill`
   - Delete: `curl -X DELETE "http://127.0.0.1:20200/api/image/skills?name=test-skill"` → `{"ok":true,"deleted":"test-skill"}`
3. **File check:** `skills/image-templates/` directory exists after seedWorkspace
4. **Skill files:** `facebook-image.md` no longer contains "BẮT BUỘC HỎI 5 CÂU"
