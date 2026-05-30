# DOCX Formatting Reference (docx@9.6.1)

Khi CEO yêu cầu tạo file Word/DOCX, dùng package `docx` (đã cài sẵn trong node_modules).

## Template script

```javascript
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        HeadingLevel, AlignmentType, BorderStyle, WidthType,
        ImageRun, PageBreak, ShadingType, convertInchesToTwip } = require('docx');
const fs = require('fs');

const doc = new Document({
  styles: {
    default: {
      document: {
        run: { font: 'Calibri', size: 24 }, // 12pt
        paragraph: { spacing: { after: 120, line: 276 } }, // 1.15 spacing
      },
    },
  },
  sections: [{
    properties: {
      page: {
        margin: {
          top: convertInchesToTwip(1),
          bottom: convertInchesToTwip(1),
          left: convertInchesToTwip(1.2),
          right: convertInchesToTwip(1),
        },
      },
    },
    children: [
      // Content goes here
    ],
  }],
});

// Save
const buffer = await Packer.toBuffer(doc);
fs.writeFileSync('output.docx', buffer);
```

## Heading

```javascript
new Paragraph({
  text: 'Tieu de',
  heading: HeadingLevel.HEADING_1, // or HEADING_2, HEADING_3
  spacing: { before: 240, after: 120 },
})
```

## Bold/Italic/Color text

```javascript
new Paragraph({
  children: [
    new TextRun({ text: 'Bold ', bold: true }),
    new TextRun({ text: 'Italic ', italics: true }),
    new TextRun({ text: 'Red', color: 'FF0000', bold: true }),
    new TextRun({ text: 'Large', size: 32, font: 'Arial' }), // 16pt
  ],
})
```

## Table (professional style)

```javascript
const headerColor = '2B579A'; // dark blue
const headerRow = new TableRow({
  tableHeader: true,
  children: ['STT', 'Ten', 'So luong', 'Don gia', 'Thanh tien'].map(text =>
    new TableCell({
      children: [new Paragraph({ children: [new TextRun({ text, bold: true, color: 'FFFFFF', size: 22 })], alignment: AlignmentType.CENTER })],
      shading: { type: ShadingType.SOLID, color: headerColor },
      verticalAlign: 'center',
    })
  ),
});

const dataRow = (cells) => new TableRow({
  children: cells.map(text =>
    new TableCell({
      children: [new Paragraph({ text: String(text), spacing: { before: 40, after: 40 } })],
      borders: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'D0D0D0' } },
    })
  ),
});

const table = new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  rows: [
    headerRow,
    dataRow(['1', 'San pham A', '10', '500,000', '5,000,000']),
    dataRow(['2', 'San pham B', '5', '1,200,000', '6,000,000']),
  ],
});
```

## Bullet list

```javascript
new Paragraph({
  text: 'Item 1',
  bullet: { level: 0 },
})
```

## Separator line

```javascript
new Paragraph({
  border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } },
  spacing: { after: 200 },
})
```

## Professional tips

## Routing — chon pipeline theo yeu cau CEO

- CEO noi "tao/viet/soan [bao gia/hop dong/bao cao/de xuat]" → **CREATE** (tao moi tu dau)
- CEO noi "sua/cap nhat/them vao file [X]" → **EDIT** (doc file goc bang /api/file/read, sua, ghi lai)
- CEO noi "format lai/lam dep/doi mau" → **FORMAT** (doc file, ap dung style moi, ghi lai)

## Aesthetic recipes (adapted from MiniMax/ECMA-376 standards)

### Modern Corporate (bao gia, proposal, bao cao)
- Font: Calibri 12pt body, 18pt H1, 14pt H2
- Colors: Primary #2B579A (blue), Accent #E74C3C (red), Text #333333
- Margins: top/bottom 1in, left 1.2in, right 1in
- Line spacing: 1.15 (276 twips)
- Table: header #2B579A white text, rows alternating #F5F5F5/#FFFFFF
- Page numbers: bottom right, Calibri 10pt

### Vietnamese Business (hop dong, cong van)
- Font: Times New Roman 13pt body, 14pt H1 bold, 13pt H2 bold
- Margins: top 2cm, bottom 2cm, left 3cm, right 2cm (theo tieu chuan VN)
- Line spacing: 1.5 (exactly 22pt)
- Header: ten cong ty centered, bold, 14pt
- Footer: page number centered "Trang X/Y"
- Table: thin borders #000000, header bold centered

### Minimal Modern (pitch deck, creative brief)
- Font: Arial 11pt body, 24pt H1 light, 16pt H2
- Colors: Primary #1A1A1A, Accent #FF6B35, Muted #999999
- Margins: wide (1.5in all sides)
- Line spacing: 1.4
- No table borders — use spacing + shading only
- Lots of white space

## Professional tips (MUST follow)

- Heading 1: 18pt bold. Heading 2: 14pt bold. Body: 12pt regular
- Table header: dark background + white text. NEVER light text on white bg
- Alternating row colors for tables with 5+ rows
- Page break between major sections: `new Paragraph({ children: [new PageBreak()] })`
- Number formatting: dung dau phay cho hang nghin (1,000,000 VND), dau cham cho thap phan
- Ngay thang: dd/MM/yyyy hoac "ngay ... thang ... nam ..."
- Footer: luon co so trang. Header: ten cong ty hoac ten tai lieu
- KHONG dung emoji. KHONG dung mau sac nhieu hon 3. KHONG dung font decorative

## Full example: Bao gia

```javascript
const doc = new Document({
  sections: [{
    children: [
      new Paragraph({ text: 'BAO GIA', heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER }),
      new Paragraph({ children: [
        new TextRun({ text: 'Cong ty: ', bold: true }),
        new TextRun('MODORO Tech Corp'),
      ]}),
      new Paragraph({ children: [
        new TextRun({ text: 'Ngay: ', bold: true }),
        new TextRun(new Date().toLocaleDateString('vi-VN')),
      ]}),
      new Paragraph({ text: '' }), // spacer
      table, // from above
      new Paragraph({ text: '' }),
      new Paragraph({ children: [
        new TextRun({ text: 'Tong cong: ', bold: true, size: 28 }),
        new TextRun({ text: '11,000,000 VND', bold: true, size: 28, color: 'E74C3C' }),
      ], alignment: AlignmentType.RIGHT }),
    ],
  }],
});
```

## Luu file

Luon luu vao Desktop CEO:
- Windows: `C:/Users/<user>/Desktop/<ten-file>.docx`
- Mac: `/Users/<user>/Desktop/<ten-file>.docx`

Detect path: `require('os').homedir() + '/Desktop/'`
