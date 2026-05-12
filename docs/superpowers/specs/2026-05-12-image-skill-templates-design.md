# Image Skill Templates — Design Spec

**Goal:** Replace the auto-remember 5-question image preference flow with a reusable skill-based system. CEO creates named image skills (style + caption template) that can be invoked by name or from a menu. Preferences file stays as cron-only fallback.

**Approach:** Skill-first, preferences-as-fallback (Approach A).

---

## Skill file format

Saved as `.md` in `skills/image-templates/` (dedicated directory, separate from `skills/content/` to avoid collision with existing content skills).

```markdown
skills/image-templates/poster-khuyen-mai.md
---
name: poster-khuyen-mai
description: Poster khuyến mãi cuối tuần
type: image-template
createdAt: 2026-05-12
---
## Style
- style: photo
- colorTone: vibrant
- composition: centered
- lighting: natural
- text: title+desc

## Caption template
GIẢM {discount}% - {product}
Chỉ còn {price}
{shop_name}
```

Bot reads Style section to build image prompt. Caption template has `{variables}` — bot extracts placeholders, asks CEO for values it cannot infer from context, substitutes, shows final caption for confirmation.

---

## Flows

### Create new skill (guided)

CEO: "tạo skill ảnh mới" → bot calls `GET /api/image/skills` to show existing, then runs guided flow:
1. Tên skill? (VD: "poster-khuyen-mai")
2. Mô tả ngắn? (VD: "Poster khuyến mãi cuối tuần")
3. 5 câu ABCDE (style/color/composition/lighting/text) — same format as current
4. Caption template? (VD: "GIẢM {discount}% - {product}")
5. Confirm → call `POST /api/image/skills` with skill definition → API writes `.md` file server-side

Bot does NOT write `.md` directly (AGENTS.md `.md` write prohibition). Server-side API creates the file.

### Use skill by name

CEO: "tạo poster khuyến mãi" → bot calls `GET /api/image/skills` → matches keyword to `poster-khuyen-mai` → reads style → asks only template variables ("Sản phẩm nào? Giảm bao nhiêu?") → generate.

### Use skill from menu

CEO: "tạo ảnh" → bot calls `GET /api/image/skills` → lists results:
```
Anh có 3 mẫu đã lưu:
1. Poster khuyến mãi (vibrant, centered)
2. Ảnh SP luxury (dark, close-up)
3. Banner sale (photo, diagonal)
Hoặc mô tả tự do để tạo mới.
```
CEO picks number or describes freely.

### Interactive decision tree

```
CEO yêu cầu tạo ảnh
├── CEO gọi tên skill cụ thể → đọc skill → hỏi variables → generate
├── CEO mô tả style rõ ràng → free-form, không hỏi 5 câu → generate
├── CEO nói chung "tạo ảnh" → list skill menu
│   ├── CEO chọn số → đọc skill đó
│   ├── CEO mô tả tự do → free-form
│   └── Chưa có skill nào → free-form với defaults hợp lý
└── CEO nói "tạo skill ảnh mới" → guided creation flow
```

`image-preferences.json` NOT read for any interactive path.

### Free-form (no skill)

CEO describes directly: "tạo ảnh iPhone 15 nền đen sang trọng" → bot uses best judgment from description, no 5 questions asked.

### Cron usage (unchanged)

Cron prompt can reference skill by name using `[SKILL: poster-khuyen-mai]` prefix — this is a pure LLM convention (same pattern as existing `[WORKFLOW]` prefix), not a code parser. Bot reads the skill file via workspace API and uses its Style section for prompt composition. Document in AGENTS.md + cron-management skill only.

Old crons without skill reference still use `image-preferences.json` as fallback.

### Delete / Edit skill

v1 scope: CEO says "xóa skill poster-khuyen-mai" → bot calls `DELETE /api/image/skills?name=poster-khuyen-mai`. Edit = delete + re-create via guided flow. No partial edit in v1.

---

## Changes to existing code

### Skill files

| File | Change |
|------|--------|
| `skills/operations/facebook-image.md` | Remove 5-question flow from interactive path. Replace with decision tree above. Keep 5-question flow ONLY inside "tạo skill ảnh mới" guided creation |
| `skills/marketing/facebook-post-workflow.md` | Skill lookup before generate, no auto-ask 5 questions |
| `skills/marketing/zalo-post-workflow.md` | Same as facebook-post-workflow |
| `skills/INDEX.md` | Add static one-line "Image templates" category pointing to `skills/image-templates/`. No dynamic sync — `GET /api/image/skills` is the authoritative list |

### Backend

| File | Change |
|------|--------|
| `electron/lib/cron-api.js` | `GET /api/image/skills` — lists all `.md` files from `skills/image-templates/`, parses frontmatter, returns `[{name, description, createdAt}]` |
| `electron/lib/cron-api.js` | `POST /api/image/skills` — accepts `{name, description, style, captionTemplate}`, writes `.md` file to `skills/image-templates/<name>.md`. Validates name (slug format), prevents overwrite of existing |
| `electron/lib/cron-api.js` | `DELETE /api/image/skills?name=<name>` — deletes the `.md` file |
| `electron/lib/cron-api.js` | `GET/POST /api/image/preferences` stays unchanged (cron fallback) |

### AGENTS.md

- Capability Router: update `brand_image_generate` row to mention skill lookup via `GET /api/image/skills`
- "Facebook + Tạo ảnh" section: add skill-first flow instructions + decision tree reference
- Cron section: document `[SKILL: name]` convention

### Unchanged

- `image-preferences.json` — cron-only fallback
- `electron/lib/image-gen.js` — generation logic untouched, only prompt composition changes (done by LLM reading skill files)
- Dashboard — no UI changes needed

---

## Total scope

4 skill `.md` files + 3 API endpoints (list/create/delete) + AGENTS.md update. No new modules. New directory `skills/image-templates/` created by `seedWorkspace()`.
