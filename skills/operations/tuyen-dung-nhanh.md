---
name: tuyen-dung-nhanh
description: Viết JD tuyển dụng + câu hỏi phỏng vấn — CEO nói 1 câu, bot xuất ngay
metadata:
  version: 1.0.0
---

# Tuyển dụng nhanh

**CHỈ CEO Telegram.** Khách Zalo yêu cầu → "Dạ đây là thông tin nội bộ ạ."

## Nguyên tắc

CEO nói 1 câu → bot xuất 3 phần NGAY. Không hỏi lại.
Thiếu info → suy luận từ IDENTITY.md + ngành + thị trường + ghi "[giả định: X — anh sửa nếu khác]".

## Suy luận

Từ 1 câu, suy: tên công ty (IDENTITY.md), ngành, full/part-time (mặc định full), lương (thị trường VN theo vùng+vị trí), yêu cầu (theo vị trí), quyền lợi (SME: BHXH, thưởng lễ Tết, đào tạo), địa điểm (IDENTITY.md hoặc giả định), cách ứng tuyển (inbox/Zalo/SĐT).

## Output: 3 phần

### Phần 1 — Bài đăng group tuyển dụng (copy-paste được)

```
[HOOK 1 câu — nhấn quyền lợi/cơ hội, hấp dẫn ứng viên]

[Tên công ty] đang tìm [vị trí].

Quyền lợi:
- [3-5 dòng: lương, thưởng, đào tạo, môi trường]

Yêu cầu:
- [2-3 dòng cốt lõi]

Địa điểm: [quận/TP]
Liên hệ: [inbox/Zalo/SĐT]
```

Quy tắc: quyền lợi TRƯỚC yêu cầu (bán cơ hội, không bán gánh nặng). Hook gây chú ý. Yêu cầu tối đa 3 dòng. Tone thân thiện, không corporate. 150-250 từ.

### Phần 2 — JD chi tiết (gửi ứng viên quan tâm)

Gồm: vị trí, hình thức, lương (range, ghi giả định), mô tả công việc (4-6 hành động cụ thể), yêu cầu (3-5), ưu tiên (1-2), quyền lợi (5-7), cách ứng tuyển.

Mô tả = hành động thật ("tư vấn khách qua Zalo"), không trừu tượng. Lương range cụ thể, không "thỏa thuận". SME có thể "nhắn giới thiệu bản thân" thay CV.

### Phần 3 — 5 câu hỏi phỏng vấn

Tình huống thực tế, phù hợp SME. Mỗi câu kèm "[Mục đích: đánh giá X]".

Loại câu hỏi: xử lý khách khó, áp lực doanh số/deadline, teamwork khi thiếu người, trung thực khi sai sót, động lực với ngành.

KHÔNG hỏi: "điểm mạnh điểm yếu", "5 năm nữa ở đâu" (sáo rỗng, ứng viên trả mẫu).

## Sửa

CEO nói "sửa lương 10 triệu", "bỏ yêu cầu kinh nghiệm" → sửa ngay phần liên quan, xuất lại.

## Lưu ý

- Tiếng Việt có dấu đầy đủ
- Lương suy luận thị trường VN 2026, luôn ghi "[giả định]"
- Bài phải đăng group được ngay, không cần chỉnh
