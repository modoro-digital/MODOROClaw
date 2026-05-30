# Aesthetic Recipes — DOCX

Chọn recipe phù hợp với loại văn bản. KHÔNG tự sáng tạo formatting — dùng exact values bên dưới.

## Modern Corporate (báo giá, proposal, báo cáo, invoice)

```
Font body:     Calibri 12pt (size: 24)
Font H1:       Calibri 18pt bold (size: 36)
Font H2:       Calibri 14pt bold (size: 28)
Font caption:  Calibri 10pt italic (size: 20)
Colors:        Primary #2B579A, Accent #E74C3C, Text #333333, Muted #666666
Margins:       top 1in, bottom 1in, left 1.2in, right 1in
Line spacing:  1.15 (exactly 276 twips)
Para spacing:  after 120 twips
Table header:  bg #2B579A, text white, bold, centered
Table rows:    alternating #FFFFFF / #F5F5F5
Table borders: bottom only, #D0D0D0, 1pt
Page numbers:  bottom right, Calibri 10pt
Header:        company name left, date right, 10pt muted
```

## Vietnamese Business (hợp đồng, công văn, biên bản)

```
Font body:     Times New Roman 13pt (size: 26)
Font H1:       Times New Roman 14pt bold uppercase (size: 28)
Font H2:       Times New Roman 13pt bold (size: 26)
Font caption:  Times New Roman 11pt italic (size: 22)
Colors:        Primary #000000, Accent #1A3C8F, Text #000000
Margins:       top 2cm, bottom 2cm, left 3cm, right 2cm (convertInchesToTwip: top/bottom 0.79, left 1.18, right 0.79)
Line spacing:  1.5 (exactly 360 twips)
Para spacing:  after 60 twips
Table header:  bg #1A3C8F, text white, bold, centered
Table rows:    all white, thin borders #000000 all sides
Page numbers:  bottom center "Trang X / Y", 11pt
Header:        company name centered, bold, 14pt, border-bottom 1pt
Footer:        "Trang" + page number centered
```

## Minimal Modern (pitch deck, creative brief, one-pager)

```
Font body:     Arial 11pt (size: 22)
Font H1:       Arial 24pt light (size: 48, bold: false)
Font H2:       Arial 16pt (size: 32)
Font caption:  Arial 9pt, color #999999 (size: 18)
Colors:        Primary #1A1A1A, Accent #FF6B35, Text #333333, Muted #999999
Margins:       1.5in all sides (convertInchesToTwip(1.5))
Line spacing:  1.4 (exactly 336 twips)
Para spacing:  after 200 twips
Table:         NO borders. Header: bold only. Rows: spacing + subtle shading #F8F8F8
Page numbers:  bottom right, 9pt, muted
Header:        none (clean look)
```

## Vietnamese SME Quick Templates

### Báo giá
- Recipe: Modern Corporate
- Sections: Header (logo+company) → Customer info → Table (STT, Tên, SL, Đơn giá, Thành tiền) → Total bold red → Payment terms → Signature

### Hợp đồng
- Recipe: Vietnamese Business
- Sections: Header (CỘNG HÒA XÃ HỘI...) → Title → Parties (Bên A, Bên B) → Articles (Điều 1, 2, 3...) → Signatures (2 columns)

### Báo cáo
- Recipe: Modern Corporate
- Sections: Cover page → TOC (optional) → Executive summary → Body sections → Conclusion → Appendix

### Đề xuất / Proposal
- Recipe: Modern Corporate or Minimal Modern
- Sections: Cover → Problem → Solution → Timeline → Budget table → Next steps → Contact
