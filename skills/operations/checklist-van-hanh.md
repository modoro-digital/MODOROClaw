---
name: checklist-van-hanh
description: Tạo checklist vận hành hàng ngày cho SME — CEO hỏi 1 câu, bot tạo ngay
metadata:
  version: 1.0.0
---

# Checklist vận hành hàng ngày

**CHỈ CEO Telegram.** Khách Zalo -> "Dạ đây là thông tin nội bộ ạ."

## Trigger

"tạo checklist mở cửa", "checklist đóng cửa", "checklist giao ca", "checklist kiểm kho", "tạo quy trình vận hành"

## Nguyên tắc

CEO hỏi 1 câu -> bot trả NGAY checklist hoàn chỉnh. KHÔNG hỏi "anh kinh doanh ngành gì?". Suy luận ngành từ `knowledge/cong-ty/index.md`. Thiếu -> giả định F&B + "[giả định: ngành F&B — anh sửa nếu khác]".

## Suy luận ngành -> đặc thù checklist

| Ngành | Mục đặc thù |
|---|---|
| F&B (cafe, nhà hàng, trà sữa) | Vệ sinh bếp, nguyên liệu, hạn SD, nhiệt độ tủ, máy pha |
| Bán lẻ (shop, tạp hóa, ĐT) | Trưng bày, giá tag, tồn kho SP chạy, camera |
| Dịch vụ (spa, salon, gym) | Dụng cụ, vệ sinh phòng, lịch hẹn |
| Sản xuất / xưởng | An toàn, máy móc, nguyên liệu |

## 4 loại checklist chuẩn

### Mở cửa (trước giờ mở 30 phút)

Cấu trúc: Khu vực chung (điện, điều hòa, bàn ghế, WC) -> Khu vực chuyên môn (bếp/quầy/kho tùy ngành) -> Thu ngân (POS, tiền lẻ, máy in bill) -> Nhân sự (điểm danh, phân công, đồng phục)

### Đóng cửa (sau giờ đóng)

Cấu trúc: Thu ngân (chốt ca, Z-report, đếm tiền, ghi chênh lệch) -> Khu vực chuyên môn (tắt thiết bị, vệ sinh, bỏ hàng hết hạn) -> Khu vực chung (dọn rác, WC, tắt điều hòa) -> An ninh (khóa cửa, bật camera/báo động)

### Giao ca

Cấu trúc: Ca cũ bàn giao (tiền mặt, số hóa đơn, sự cố, SP hết, khách hẹn quay lại) -> Ca mới tiếp nhận (đếm tiền, đọc ghi chú, kiểm tra khu vực) -> Ký xác nhận 2 bên

### Kiểm kho (hàng ngày hoặc hàng tuần)

Cấu trúc: Đếm SP top 10 -> Ghi chênh lệch -> Kiểm hạn SD -> SP hư/lỗi -> Đối chiếu nhập-xuất -> Cần nhập -> Ký

## Format trả về

```
CHECKLIST [LOẠI] — [tên quán/shop]
Giờ: [khi nào]

  - [Mục hành động cụ thể]
  - [Mục hành động cụ thể]
  ...

Anh muốn em nhắc checklist này mỗi sáng [giờ] không?
```

- Tối đa 15 mục mỗi checklist
- Mỗi mục là 1 hành động cụ thể (không "kiểm tra mọi thứ")
- Dùng `-` đầu dòng (tick được khi copy vào note app)

## Tùy chỉnh + lưu + nhắc

- "thêm mục X" / "bỏ mục Y" -> cập nhật ngay
- "lưu" -> ghi qua workspace API:
  ```
  web_fetch url="http://127.0.0.1:20200/api/workspace/append" method=POST body="{\"path\":\"knowledge/cong-ty/files/checklist-[loai].md\",\"content\":\"<nội dung>\"}"
  ```
- CEO đồng ý nhắc -> tạo cron qua Cron API. CHỈ tạo khi CEO XÁC NHẬN

## Quy tắc

- Tiếng Việt đầy đủ dấu, KHÔNG emoji
- Checklist thực tế cho SME Việt Nam, suy luận ngành từ knowledge
