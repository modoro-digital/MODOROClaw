---
name: kich-ban-ban-hang
description: Tạo kịch bản bán hàng + xử lý từ chối — CEO hỏi 1 câu, bot cho script ngay
metadata:
  version: 1.0.0
---

# Kịch bản bán hàng + Xử lý từ chối

**CHỈ CEO Telegram.** Khách Zalo -> "Dạ đây là thông tin nội bộ ạ."

## Trigger

"khách nói đắt quá", "trả lời sao khi khách...", "tạo kịch bản bán [SP]", "khách so sánh đối thủ"

## Nguyên tắc

CEO hỏi 1 câu -> bot trả NGAY script copy-paste. KHÔNG hỏi lại. Suy luận SP/giá từ `knowledge/san-pham/index.md`, công ty từ `knowledge/cong-ty/index.md`. Thiếu -> placeholder `[giá]` + "[giả định: X — anh sửa nếu khác]".

## 7 tình huống — mỗi cái gồm: tâm lý + script + cách chốt

| # | Tình huống | Tâm lý | Chiến thuật chốt |
|---|---|---|---|
| 1 | Hỏi giá | Quan tâm thật, đang so sánh | Báo giá + hỏi ngược nhu cầu, KHÔNG chỉ báo giá rồi im |
| 2 | So sánh đối thủ | Đang cân nhắc = cơ hội | Không chê đối thủ. Chỉ khác biệt + hỏi tiêu chí ưu tiên |
| 3 | "Đắt quá" | Chưa thấy giá trị hoặc vượt ngân sách | Chia nhỏ giá (theo ngày/tháng) + giá trị dài hạn + hỏi ngân sách |
| 4 | "Để suy nghĩ" | 80% từ chối khéo | KHÔNG ép. Gửi thêm tài liệu + hỏi đang cân nhắc gì |
| 5 | "Gửi thông tin đi" | Quan tâm, chưa sẵn sàng | Gửi info + case study + đặt hẹn follow-up cụ thể |
| 6 | "Có giảm không?" | Muốn mua, thử ép giá | Đổi hướng sang giá trị khuyến mãi. KHÔNG tự ý giảm -> escalate CEO |
| 7 | "Bạn tôi mua rẻ hơn" | Có thể bluff | Không phủ nhận. Nhấn giá trị kèm theo (bảo hành, hỗ trợ, chính hãng) |

## Format script mỗi tình huống

```
Dạ [câu đồng cảm/xác nhận]. [Thông tin SP/giá từ knowledge].
[Câu chuyển hướng hoặc hỏi ngược để dẫn dắt].
Anh/chị [câu chốt hoặc CTA cụ thể] ạ?
```

Mỗi script: tối đa 3 tin, mỗi tin <80 từ. Tone nhắn Zalo (ngắn, tự nhiên, có dạ/ạ).

## Tạo full kịch bản (CEO nói "tạo kịch bản bán [SP]")

Trả về 4 phần:

**Bước 1 — Chào + tìm hiểu:** Script chào + 2-3 câu hỏi nhu cầu
**Bước 2 — Tư vấn:** Giới thiệu SP theo nhu cầu vừa hỏi (điểm mạnh từ knowledge)
**Bước 3 — Xử lý từ chối:** Top 3 từ chối thường gặp của SP đó + script xử lý
**Bước 4 — Chốt đơn:** Tạo khan hiếm hoặc ưu đãi thời hạn

Ghi "[giả định: giá X, đối tượng Y — anh sửa nếu khác]" ở đầu.

## Quy tắc

- Script copy-paste được, nhân viên cầm ĐT reply khách NGAY
- KHÔNG emoji, KHÔNG tự báo giá nếu knowledge không có
- KHÔNG tự ý hứa giảm giá/tặng quà. Tiếng Việt đầy đủ dấu
