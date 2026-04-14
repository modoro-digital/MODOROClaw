# 9BizClaw Design System

Rules cho mọi UI change. Không ngoại lệ. Tham chiếu: Linear, Stripe Dashboard, Vercel.

---

## Rule 1: Spacing Scale (8px base)

Chỉ dùng bội số của 4px. Preferred steps:

| Token        | Value | Dùng cho                              |
|-------------|-------|---------------------------------------|
| `--sp-1`    | 4px   | Icon-to-text gap, micro adjustments   |
| `--sp-2`    | 8px   | Intra-component (padding nhỏ nhất)    |
| `--sp-3`    | 12px  | List item gap, small card padding     |
| `--sp-4`    | 16px  | Default card padding, section gap     |
| `--sp-5`    | 20px  | Between related sections              |
| `--sp-6`    | 24px  | Between unrelated sections            |
| `--sp-8`    | 32px  | Page-level section breaks             |
| `--sp-10`   | 40px  | Hero/header vertical padding          |
| `--sp-12`   | 48px  | Page top/bottom padding               |

**NEVER** dùng giá trị lẻ (13px, 17px, 22px). Round lên/xuống bội 4.

---

## Rule 2: Typography Hierarchy (5 levels only)

```
Level 1 — Page Title:       20px / 650 / var(--text)
Level 2 — Section Header:   14px / 600 / var(--text)         <- NO uppercase
Level 3 — Card Header:      13px / 600 / var(--text-secondary)
Level 4 — Body:             13px / 400 / var(--text)
Level 5 — Caption/Meta:     12px / 400 / var(--text-muted)
```

### Rules:

- **NEVER** dùng `text-transform: uppercase` cho section headers. Uppercase chỉ cho badge/tag nhỏ hơn 4 từ.
- **NEVER** dùng font-size < 12px. Minimum readable size.
- Section headers dùng **color: var(--text)** + font-weight 600. KHÔNG dùng `--text-muted` cho headers.
- Body text dùng `line-height: 1.6`. Headers dùng `line-height: 1.3`.
- Max 1 level difference giữa adjacent elements. Không nhảy từ Level 1 xuống Level 5.

---

## Rule 3: Surface Hierarchy (3 layers max)

```
Layer 0 — Page canvas:      var(--bg)
Layer 1 — Card/Panel:       var(--surface) + border
Layer 2 — Inset/Well:       var(--bg) inside Layer 1
```

### Rules:

- **Max 2 nesting levels.** Card-in-card-in-card = BUG.
- Card (`Layer 1`): `background: var(--surface)`, `border: 1px solid var(--border)`, `border-radius: var(--radius)`, `padding: var(--sp-4)`.
- Inset well (`Layer 2`): `background: var(--bg)`, `border-radius: var(--radius-sm)`, `padding: var(--sp-3)`. Dùng cho code blocks, input areas, embedded content.
- Card KHÔNG có box-shadow bình thường. Shadow chỉ cho modals, dropdowns, popovers.
- Cards KHÔNG có hover effect trừ khi clickable.

---

## Rule 4: Section Anatomy (mandatory structure)

Mọi section trong page PHẢI theo cấu trúc:

```html
<div class="ds-section">
  <div class="ds-section-header">
    <h3 class="ds-section-title">Section Name</h3>
    <p class="ds-section-desc">One line description if needed</p>
  </div>
  <div class="ds-section-body">
    <!-- content here -->
  </div>
</div>
```

### Rules:

- Header luôn nằm NGOÀI card. Không đặt h3 bên trong `.main-card`.
- Description luôn đi kèm header nếu section không self-explanatory.
- Khoảng cách giữa sections: `var(--sp-6)` (24px).
- Khoảng cách header -> body: `var(--sp-3)` (12px).

---

## Rule 5: Interactive Elements

### Prompt/Command Cards:

```html
<div class="ds-prompt" onclick="copyPrompt(this)">
  <span class="ds-prompt-text">Prompt text here</span>
  <span class="ds-prompt-tag">Tag</span>
  <span class="ds-prompt-copy" data-icon="copy" data-icon-size="14"></span>
</div>
```

- Background: `var(--bg)` (inset look inside card)
- Padding: `10px 14px`
- Border: `1px solid transparent`
- Border-radius: `var(--radius-sm)`
- Hover: `border-color: var(--border-strong)` + copy icon visible
- Copy icon: **HIDDEN by default**, VISIBLE on hover via `opacity: 0 -> 1`.

### Buttons:

- Primary (accent): max 1 per visible area
- Secondary (ghost): default for most actions
- Small: padding `6px 12px`, font-size `12px`
- NEVER stack more than 3 buttons horizontally

---

## Rule 6: Color Usage

| Color             | Dùng cho                                   | NEVER dùng cho              |
|-------------------|--------------------------------------------|-----------------------------|
| `--accent`        | Primary CTA, brand highlight, active state | Body text, borders          |
| `--success`       | Status "ready", confirmations              | Decorative, headers         |
| `--warning`       | Attention needed, degraded state           | Success states              |
| `--danger`        | Errors, destructive actions                | Warnings, accents           |
| `--text`          | Headers, primary content                   | Muted/secondary info        |
| `--text-secondary`| Section labels, secondary info             | Primary content             |
| `--text-muted`    | Timestamps, hints, meta                    | Headers, interactive labels |

- **Max 2 accent colors per screen.** Accent + one semantic (success/warning/danger).
- Tags/badges: `background: var(--accent-soft)`, `color: var(--accent)`, `border-radius: 4px`, `padding: 2px 8px`, `font-size: 11px`, `font-weight: 500`.
- NEVER colorize decoratively. Every color must mean something.

---

## Rule 7: Density & Grouping

- Max visible items without scroll: **5-7** per group
- If more than 7: collapse with "Xem tat ca (N)" toggle
- List item gap: `var(--sp-2)` (8px)
- Group gap (between categories): `var(--sp-5)` (20px)
- 2 columns max. Switch to 1 if content > 40 chars per item.

---

## Rule 8: Motion

- Transitions: `0.15s ease` for color/border/opacity
- NEVER animate layout (width, height, padding)
- Page transitions: none (instant switch)
- Loading: `.spinner` or `.pulse-dot` only

---

## Rule 9: Icons (Lucide)

- 14px inline, 16px in buttons, 18px in section headers, 24-26px page headers
- Color inherits parent. NEVER set icon color separately unless status.
- NEVER use icons as sole label. Always pair with text.

---

## Rule 10: Content Guidelines

- **No emojis.** Ever. Use Lucide icons.
- **Sentence case** for headers ("Lệnh nhanh" not "LỆNH NHANH").
- **Max 1 sentence** for section descriptions.
- **Tooltips** for contextual help, not paragraphs inside cards.
- **Action labels** start with verb: "Kiểm tra", "Gửi tin", "Tạm dừng".

---

## Anti-patterns

| Anti-pattern | Do instead |
|---|---|
| Inline `style=""` | Use CSS classes from design system |
| `text-transform: uppercase` on headers | font-weight 600 + proper font-size |
| Card inside card inside card | Max 2 surface layers |
| Same grey for header and description | Headers = `--text`, descriptions = `--text-muted` |
| Copy icon always visible | Show on hover only |
| Spacing 13px, 17px, 22px | 4px grid: 4, 8, 12, 16, 20, 24, 32 |
| Font-size below 12px | Minimum 12px |
| More than 3 buttons in a row | Primary + secondary group |
| Colored backgrounds for non-status | Reserve color for meaning |

---

## Checklist truoc khi commit

- [ ] Spacing chi dung boi 4px?
- [ ] Typography chi dung 5 levels da dinh nghia?
- [ ] Max 2 surface layers?
- [ ] Section header nam NGOAI card?
- [ ] Khong co inline styles moi?
- [ ] Khong co uppercase headers?
- [ ] Khong co emojis?
- [ ] Interactive elements co hover state?
- [ ] Copy icons an khi khong hover?
- [ ] Font-size >= 12px?
