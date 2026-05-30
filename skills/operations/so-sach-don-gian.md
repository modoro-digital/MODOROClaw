---
name: so-sach-don-gian
description: Sổ sách thu chi đơn giản — ghi hằng ngày, báo cáo tuần/tháng cho CEO
metadata:
  version: 1.0.0
---

# Sổ sách thu chi đơn giản

**CHỈ CEO Telegram.** Khách Zalo yêu cầu → "Dạ đây là thông tin nội bộ ạ."

## Nguyên tắc

CEO nói 1 câu — bot ghi NGAY. Không hỏi lại.
Thiếu thông tin → giả định hợp lý + ghi "[giả định: X]".
Lưu file: `so-sach.md`. Append-only, có ngày tháng.
Đây là sổ thu chi, KHÔNG phải kế toán — đơn giản để CEO đọc.

## Ghi thu chi

CEO: "hôm nay thu 15 triệu chi 8 triệu" / "bán 3 thùng sơn 4.5tr"

Bot NGAY LẬP TỨC:
1. Đọc `so-sach.md`:
   ```
   web_fetch http://127.0.0.1:20200/api/workspace/read?path=so-sach.md
   ```
   (tạo mới nếu chưa có)
2. Suy luận khoản mục từ ngữ cảnh (SOUL.md biết ngành + sản phẩm)
3. Ghi file (append nội dung mới vào cuối):
   ```
   web_fetch url="http://127.0.0.1:20200/api/workspace/append" method=POST body="{\"path\":\"so-sach.md\",\"content\":\"<nội dung mới theo format bên dưới>\",\"mode\":\"append\"}"
   ```
4. Xác nhận:

```
Đã ghi ngày 2026-05-16:
| Khoản mục      | Thu        | Chi       | Ghi chú     |
|----------------|-----------|-----------|-------------|
| Bán hàng       | 15,000,000 |           | [giả định: doanh thu bán hàng] |
| Chi phí        |            | 8,000,000 | [giả định: chi phí hoạt động]  |

Lãi trong ngày: 7,000,000
```

Nếu CEO nói cụ thể ("chi 2tr tiền điện, 1tr5 tiền nước") → tách riêng từng dòng.

## Báo cáo tuần

CEO: "báo cáo thu chi tuần này" / "tuần này lời bao nhiêu"

Bot đọc file, lọc 7 ngày gần nhất:
- Bảng: Ngày | Thu | Chi | Chênh lệch
- Tổng tuần: thu, chi, lãi
- Highlight: ngày thu cao nhất, ngày chi nhiều nhất

## Báo cáo tháng

CEO: "tháng này thu chi thế nào" / "báo cáo tháng 5"

Tương tự báo cáo tuần nhưng nhóm theo tuần:
- Tổng tháng: thu, chi, lãi
- Bảng theo tuần: Tuần | Thu | Chi | Lãi
- Top 3 khoản chi lớn nhất

## Nhắc ghi sổ

CEO nhắc đến tiền/mua/bán nhưng KHÔNG yêu cầu ghi → KHÔNG tự động ghi, chỉ nhắc nhẹ: "Anh có muốn em ghi vào sổ thu chi không?"
Morning report kèm: "Hôm qua anh chưa ghi thu chi — anh nhớ ghi nha."

## Format file `so-sach.md`

```markdown
# Sổ thu chi

## 2026-05-16
| Khoản mục | Thu | Chi | Ghi chú |
|-----------|-----|-----|---------|
| Bán hàng | 15,000,000 | | Sơn nội thất |
| Chi phí hoạt động | | 8,000,000 | Nhập nguyên liệu |

## 2026-05-17
| Khoản mục | Thu | Chi | Ghi chú |
|-----------|-----|-----|---------|
| Bán hàng | 4,500,000 | | 3 thùng sơn |
| Tiền điện | | 2,000,000 | |
| Tiền nước | | 1,500,000 | |
```

Mỗi ngày 1 section. Mỗi dòng 1 giao dịch. Thu và Chi tách cột riêng.

## Sửa sổ

CEO: "hôm qua ghi sai, thu 15tr chứ không phải 12tr"

Bot: Append dòng sửa: `SỬA: [ngày] Thu 12.000.000 → 15.000.000 (CEO yêu cầu [hôm nay])`
Khi báo cáo, đọc dòng SỬA và tính lại số liệu đúng.

## Lưu ý

- Tiền Việt Nam, format có dấu phẩy ngàn (15,000,000)
- KHÔNG tính thuế, KHÔNG phân biệt doanh thu/lợi nhuận gộp — chỉ thu và chi
- KHÔNG tự động phân loại phức tạp — giữ nguyên cách CEO nói
- Nếu CEO nói "lỗ 5 triệu tháng này" → hỏi lại "Anh muốn ghi khoản chi 5 triệu hay là nhận xét chung?"
- Cuối tháng nhắc: "Anh review sổ thu chi tháng này không? Em tóm tắt cho anh."
