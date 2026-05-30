---
name: cong-no
description: Theo dõi công nợ khách hàng — ghi nợ, trả nợ, nhắc nợ, cảnh báo quá hạn
metadata:
  version: 1.0.0
---

# Theo dõi công nợ

**CHỈ CEO Telegram.** Khách Zalo yêu cầu → "Dạ đây là thông tin nội bộ ạ."

## Nguyên tắc

CEO nói 1 câu — bot xuất kết quả NGAY. Không hỏi lại.
Thiếu thông tin → giả định hợp lý + ghi "[giả định: X — anh sửa nếu khác]".
Lưu file: `cong-no.md`. Append-only, có ngày tháng.

## Ghi nợ mới

CEO: "ghi nợ anh Tuấn 5 triệu" / "Tuấn nợ 5tr tiền hàng"

Bot NGAY LẬP TỨC:
1. Đọc `cong-no.md`:
   ```
   web_fetch http://127.0.0.1:20200/api/workspace/read?path=cong-no.md
   ```
   (tạo mới nếu chưa có)
2. Ghi file (append dòng mới):
   ```
   web_fetch url="http://127.0.0.1:20200/api/workspace/append" method=POST body="{\"path\":\"cong-no.md\",\"content\":\"<dòng mới theo format bảng>\",\"mode\":\"append\"}"
   ```
3. Giả định:
   - Hạn trả: +30 ngày từ hôm nay (nếu CEO không nói)
   - Ghi chú: suy từ ngữ cảnh ("tiền hàng", "tiền công", ...)
   - Ngày nợ: hôm nay
4. Xác nhận:

```
Đã ghi:
| Tên      | Số tiền    | Ngày nợ    | Hạn trả    | Ghi chú   |
|----------|-----------|------------|------------|-----------|
| Anh Tuấn | 5,000,000 | 2026-05-16 | 2026-06-15 | Tiền hàng |
[giả định: hạn 30 ngày — anh sửa nếu khác]
```

## Trả nợ (một phần hoặc toàn bộ)

CEO: "anh Tuấn trả 3 triệu" / "Tuấn thanh toán hết"

Bot:
1. Đọc file, tìm dòng của "Tuấn" còn nợ
2. Ghi dòng mới với số tiền âm (trả): `-3,000,000`
3. Tính còn lại, báo CEO:

```
Anh Tuấn đã trả 3,000,000. Còn nợ lại: 2,000,000 (hạn 2026-06-15).
```

Nếu trả hết → ghi `ĐÃ THANH TOÁN` vào ghi chú.

## Xem tổng hợp công nợ

CEO: "ai đang nợ mình?" / "báo cáo công nợ"

Bot đọc file, tổng hợp theo từng người, chỉ hiện khoản CÒN NỢ:
- Bảng: Tên | Tổng nợ | Đã trả | Còn lại | Hạn gần nhất | Trạng thái
- Trạng thái: `Trong hạn` / `SẮP QUÁ HẠN` (<7 ngày) / `QUÁ HẠN` (+ số ngày)
- Dòng cuối: tổng còn nợ + số khoản sắp/quá hạn

## Soạn tin nhắc nợ

CEO: "nhắc anh Tuấn trả nợ" / "soạn tin nhắc Chị Lan"

Bot soạn tin nhắc: thân thiện, không gây áp lực, nhắc số tiền + khoản gì + ngày.
Hỏi CEO: "Anh gửi qua Zalo/gọi điện, hoặc để em gửi giúp?"

## Cảnh báo tự động

Khi CEO hỏi bất kỳ câu gì liên quan công nợ, bot kèm cảnh báo nếu có:
- Nợ quá hạn (quá ngày hạn trả): **CẢNH BÁO** + số ngày quá hạn
- Sắp quá hạn (<7 ngày): **LƯU Ý**
- Nợ lớn (>20 triệu 1 người): ghi chú "[khoản lớn — anh theo dõi sát]"

## Format file `cong-no.md`

```markdown
# Sổ công nợ

## 2026-05-16
| Tên | Số tiền | Loại | Hạn trả | Ghi chú |
|-----|---------|------|---------|---------|
| Anh Tuấn | 5,000,000 | NỢ | 2026-06-15 | Tiền hàng |

## 2026-05-18
| Anh Tuấn | -3,000,000 | TRẢ | — | Chuyển khoản |
```

Mỗi dòng là 1 giao dịch. `NỢ` = ghi nợ mới, `TRẢ` = trả nợ. Tổng nợ = SUM theo tên.

## Lưu ý

- KHÔNG làm phức tạp — đây là sổ nợ, không phải kế toán
- Tiền Việt Nam, không cần đơn vị ngoại tệ
- Tên người: giữ nguyên cách CEO gọi (anh Tuấn, chị Lan, Minh, ...)
- Nếu CEO nói "xóa nợ anh Tuấn" → ghi `TRẢ` toàn bộ + ghi chú "CEO xóa nợ"
