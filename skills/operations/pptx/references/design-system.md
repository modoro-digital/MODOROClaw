# Design System — PPTX

## Color Palettes

Chọn palette phù hợp với chủ đề. KHÔNG tự sáng tạo màu — dùng exact values.

### Business Blue (default — báo cáo, proposal)
```
primary:   "2B579A"    // dark blue — titles, headers
secondary: "4A6FA5"    // medium blue — subtitles
accent:    "E74C3C"    // red — highlights, CTAs
light:     "EBF0F7"    // light blue — backgrounds, cards
bg:        "FFFFFF"    // white
```

### Executive Dark (pitch deck, investor)
```
primary:   "1A1A2E"    // near-black — backgrounds
secondary: "16213E"    // dark navy
accent:    "E94560"    // vibrant red-pink
light:     "F5F5F5"    // off-white — text on dark
bg:        "0F3460"    // deep blue
```

### Modern Warm (creative, marketing)
```
primary:   "2D3436"    // charcoal
secondary: "636E72"    // gray
accent:    "FF6B35"    // orange
light:     "FFF3E0"    // warm cream
bg:        "FFFFFF"    // white
```

### Vietnamese Corporate (công văn, formal)
```
primary:   "1A3C8F"    // deep blue
secondary: "333333"    // dark gray
accent:    "C62828"    // dark red
light:     "F5F5F5"    // light gray
bg:        "FFFFFF"    // white
```

### Nature/Health (spa, clinic, organic)
```
primary:   "2E7D32"    // forest green
secondary: "4CAF50"    // green
accent:    "FF8F00"    // amber
light:     "E8F5E9"    // light green
bg:        "FFFFFF"    // white
```

## Style Recipes

### Sharp (business, formal)
- Rectangle shapes, square corners
- Bold divider lines between sections
- High contrast headers

### Soft (approachable, friendly)
- Rounded rectangles (rectRadius: 0.15)
- Subtle shadows
- Muted accent colors

### Minimal (modern, clean)
- No shapes — typography only
- Maximum white space
- Thin lines, no fills

## Font Reference

| Use | Font | Size |
|-----|------|------|
| Slide title | Arial Bold | 36-44pt |
| Subtitle | Arial | 20-24pt |
| Body text | Arial | 16-18pt |
| Caption/note | Arial | 12-14pt |
| Page number | Arial | 11-12pt |

## Slide Dimensions

- Layout: LAYOUT_16x9 (10" x 5.625")
- Safe zone: 0.5" margins all sides → content area 9" x 4.625"
- Title zone: y: 0.3-0.8, h: 1.0-1.5
- Content zone: y: 1.8-2.2, h: 2.5-3.0
- Footer zone: y: 5.0-5.4

## Page Number Badge (REQUIRED)

Position: x: 9.3", y: 5.1", w: 0.4, h: 0.4
```javascript
// Circle badge
slide.addShape(pres.shapes.OVAL, {
  x: 9.3, y: 5.1, w: 0.4, h: 0.4,
  fill: { color: theme.accent }
});
slide.addText(String(slideNumber), {
  x: 9.3, y: 5.1, w: 0.4, h: 0.4,
  fontSize: 12, fontFace: "Arial",
  color: "FFFFFF", bold: true,
  align: "center", valign: "middle"
});
```
