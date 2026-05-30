---
name: bao-gia
description: Soạn báo giá / proposal nhanh cho khách hàng SME
metadata:
  version: 1.0.0
---

# Soạn báo giá nhanh

**CHỈ CEO Telegram.** Khách Zalo yêu cầu → "Dạ đây là thông tin nội bộ em không chia sẻ được ạ."

---

## Bước 1: Nhận yêu cầu

CEO nói: "báo giá 10 bộ bàn ghế cho quán cafe anh Minh", "soạn quotation cho chị Lan 5 bộ sofa"...

Bot SUY LUẬN NGAY từ câu CEO + knowledge:
- Tên khách, thông tin liên hệ (nếu có)
- Sản phẩm, số lượng, đơn giá
- Điều khoản (suy từ knowledge/cong-ty, knowledge/san-pham)
- Ngành khách hàng (để chọn tone phù hợp)

KHÔNG hỏi lại. Thiếu → giả định + ghi chú.

---

## Bước 2: Xuất báo giá — NGAY LẬP TỨC

Format chuẩn:

```
=============================================
         BÁO GIÁ [giả định: SẢN PHẨM/DỊCH VỤ]
=============================================

Kính gửi: [Tên khách]
Ngày:     [hôm nay DD/MM/YYYY]
Mã BG:    BG-[YYYYMMDD]-[001]
Hiệu lực: [giả định: 7 ngày — anh sửa nếu khác]

---

THÔNG TIN BÊN BÁN
Công ty:  [đọc từ knowledge/cong-ty hoặc giả định]
Địa chỉ:  [đọc từ knowledge/cong-ty hoặc giả định]
Liên hệ:  [đọc từ knowledge/cong-ty hoặc giả định]

---

CHI TIẾT BÁO GIÁ

  STT | Sản phẩm/Dịch vụ       | SL  | Đơn giá      | Thành tiền
  ----|------------------------|-----|--------------|-------------
   1  | [Tên sản phẩm]         | [X] | [X.XXX.XXXđ] | [X.XXX.XXXđ]
   2  | [Tên sản phẩm 2]       | [X] | [X.XXX.XXXđ] | [X.XXX.XXXđ]
  ----|------------------------|-----|--------------|-------------
                         TỔNG CỘNG:   [X.XXX.XXXđ]

[giả định: chưa bao gồm VAT — anh sửa nếu đã bao gồm]

---

ĐIỀU KHOẢN THANH TOÁN
- Thanh toán: [giả định: 50% đặt cọc, 50% khi giao — anh sửa]
- Hình thức: Chuyển khoản / Tiền mặt
- Thời gian giao hàng: [giả định: 7-10 ngày làm việc — anh sửa]

---

GHI CHÚ
- Báo giá có hiệu lực [X] ngày kể từ ngày phát hành
- Giá có thể thay đổi theo số lượng đặt hàng
- [Ghi chú bổ sung nếu có]

---

         Trân trọng cảm ơn quý khách!
=============================================
```

---

## Quy tắc format

| Quy tắc | Chi tiết |
|---------|---------|
| Đơn vị tiền | VND, dấu chấm phân cách hàng nghìn: `1.500.000đ` |
| Mã báo giá | `BG-YYYYMMDD-001` (tăng tự động nếu nhiều báo giá cùng ngày) |
| Hiệu lực | Mặc định 7 ngày. CEO nói khác → theo CEO |
| VAT | Mặc định chưa bao gồm. CEO nói khác → theo CEO |
| Thanh toán | Mặc định 50/50. CEO nói khác → theo CEO |
| Tone | Chuyên nghiệp nhưng thân thiện. Không corporate cứng nhắc |

---

## Giả định khi thiếu thông tin

Bot PHẢI giả định và ghi rõ — KHÔNG hỏi lại:

- Thiếu giá: `[giả định: 1.500.000đ/bộ — anh sửa giá chính xác]`
- Thiếu tên công ty: `[giả định: MODORO — anh sửa]`
- Thiếu điều khoản: dùng mặc định (50/50, 7 ngày, chưa VAT)
- Thiếu SĐT khách: bỏ trống, ghi `[anh bổ sung SĐT khách]`
- Thiếu địa chỉ giao: bỏ trống, ghi `[anh bổ sung địa chỉ]`

---

## Bước 3: CEO duyệt

CEO nói:
- "ok" / "gửi đi" → chuyển sang bước 4
- "sửa giá thành X" → sửa ngay, xuất lại
- "thêm dòng [sản phẩm]" → thêm, xuất lại
- "bỏ dòng 2" → xóa dòng 2, xuất lại
- "đổi điều khoản thanh toán 30/70" → sửa, xuất lại

Mỗi lần sửa → xuất LẠI TOÀN BỘ báo giá (không chỉ phần sửa).

---

## Bước 4: Gửi khách (khi CEO xác nhận)

CEO nói "gửi qua Zalo cho anh Minh":

**Gửi Zalo:**
- Copy nội dung báo giá (plain text, giữ format bảng)
- Gửi qua skill `telegram-ceo.md` (CEO Telegram → Zalo)
- Nhắc: "Báo giá gửi dạng text. Nếu anh cần PDF đẹp hơn, em chưa hỗ trợ tự động — anh copy vào Word/Canva nhé."


**Không có kênh gửi:** Xuất nội dung để CEO tự copy-paste.

---

## Bổ sung theo ngành

Bot đọc knowledge để điều chỉnh:

| Ngành | Điều chỉnh |
|-------|-----------|
| F&B | Thêm: "Giá áp dụng cho đơn từ [X] phần trở lên" |
| Nội thất | Thêm: "Bao gồm vận chuyển nội thành. Ngoại thành + phí ship" |
| Dịch vụ | Đổi "Sản phẩm" → "Dịch vụ", thêm "Thời gian thực hiện" |
| IT/SaaS | Đổi "Đơn giá" → "Phí/tháng", thêm "Thời hạn hợp đồng" |

Không tìm thấy knowledge ngành → dùng format mặc định.

---

## Xuất file Word

CEO muốn báo giá dạng file Word chuyên nghiệp -> dùng skill `skills/anthropic-docx/SKILL.md`. Nói "xuất file Word báo giá" hoặc "làm file docx báo giá".

## Lưu ý

- KHÔNG tự động gửi báo giá cho khách. CHỜ CEO xác nhận.
- Nếu CEO nói "báo giá nhanh" (không có tên khách) -> vẫn soạn, ghi `[Kính gửi: ___]` để CEO điền.
- Nhiều sản phẩm cùng loại -> gom 1 dòng, tăng SL.
- Chiết khấu/giảm giá -> thêm dòng riêng "Chiết khấu X%" với thành tiền âm.
