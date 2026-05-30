---
name: excel
description: Đọc/sửa/tạo file Excel trên máy CEO — Node.js hoặc Python
metadata:
  version: 1.0.0
---

# Excel — đọc, sửa, tạo file trên máy CEO

**CHỈ CEO Telegram.** Khách Zalo → "Dạ đây là thông tin nội bộ ạ."

## Nguyên tắc

CEO nói 1 câu → làm NGAY, không hỏi lại trừ khi thiếu đường dẫn.
"file trên Desktop" → resolve `~/Desktop/`. Detect platform 1 lần đầu phiên:

```
exec: node -e "console.log(process.platform,require('os').homedir())"
```

## Đọc Excel

**Ưu tiên CEO File API:**

```
web_fetch http://127.0.0.1:20200/api/file/read?path=C:/Users/CEO/Desktop/bao-cao.xlsx
```

API tự parse `.xlsx`/`.xls` thành JSON. Hiện tối đa 50 dòng dạng bảng text. CEO muốn thêm → "xem tiếp" hoặc "dòng 51-100".

**Fallback exec** khi cần lọc/tính toán: Node.js + `xlsx` module từ vendor, hoặc Python3 + `openpyxl`.

## Tóm tắt Excel

CEO: "tóm tắt file doanh-thu.xlsx" → đọc file, trả về:
- Số sheet, số dòng, tên cột mỗi sheet
- Cột số: tổng, trung bình, min, max
- Cột ngày: range (từ — đến)
- Cột text: số giá trị duy nhất

## Sửa Excel

CEO: "sửa ô B5 thành 500000" / "thêm dòng mới"

**Luôn backup trước khi sửa** — copy sang `<tên>.backup-<ngày>.xlsx`.

Sửa ô: `exec` Node.js đọc workbook → ghi ô → save. Thêm dòng: đọc header → suy luận cột từ yêu cầu → append.

Xác nhận sau sửa:

```
Đã sửa file bao-cao.xlsx:
- Backup: bao-cao.backup-2026-05-16.xlsx
- Ô B5 (Sheet DoanhThu): 350000 → 500000
```

## Tạo Excel mới

CEO: "tạo file excel theo dõi doanh thu tháng 5" → suy luận cấu trúc cột từ yêu cầu → tạo NGAY trên Desktop. Dùng `exec` Node.js + `xlsx` module tạo workbook với header + độ rộng cột hợp lý.

Xác nhận: tên file, vị trí, danh sách cột. Hỏi "Anh cần thêm dữ liệu luôn không?"

## Resolve đường dẫn

| CEO nói | Resolve |
|---------|---------|
| "file trên Desktop" | `~/Desktop/` |
| "file bao-cao.xlsx" | Tìm Desktop trước, rồi workspace |
| Đường dẫn đầy đủ | Dùng nguyên |
| "file Excel" (không tên) | Liệt kê `*.xlsx` trên Desktop cho CEO chọn |

## Fallback chain

1. `web_fetch /api/file/read` -- nhanh nhất, API tự parse
2. Node.js + `xlsx` module (vendor bundled)
3. Python3 + `openpyxl`
4. CSV thuần (không cần module)

## Quy tắc

- KHÔNG sửa file gốc mà không backup trước
- Số tiền format có dấu chấm (5.000.000)
- Tối đa 50 dòng hiển thị. File > 10MB -> cảnh báo trước
- Tiếng Việt có dấu đầy đủ
