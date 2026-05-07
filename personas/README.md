# Personas — Giọng CSKH cho bot 9BizClaw

Thư mục này chứa 10 persona (nhân cách CSKH) mà CEO có thể chọn cho bot. Mỗi persona là một "nhân viên CSKH kỳ cựu" với giọng văn, xưng hô, cụm từ đặc trưng riêng. Bot sẽ nói chuyện với khách hàng đúng như người thật của ngành đó.

## Persona là gì?

Persona không phải prompt ngắn. Nó là bản mô tả đầy đủ của một archetype CSKH Việt Nam:
- Xưng hô mặc định (bot tự xưng gì, gọi khách là gì)
- Vùng miền, độ tuổi, tầng lớp ngôn ngữ
- Giá trị tone (warmth, formality, humor, assertive, empathy — thang 1 đến 10)
- Câu mở đầu, câu kết, cụm từ đặc trưng
- Ví dụ hội thoại 5 tình huống thực tế
- Do's and Don'ts

## 10 persona có sẵn

| Slug | Tên hiển thị | Phù hợp ngành |
|---|---|---|
| `chi-ban-hang-mien-tay` | Chị chủ quán thân thiết miền Tây | F&B, tạp hóa, shop online nhỏ |
| `em-sale-bds-sg` | Em sale BĐS trẻ năng động Sài Gòn | Bất động sản, đầu tư |
| `co-giao-ha-noi` | Cô giáo Hà Nội nghiêm túc | Giáo dục, trung tâm ngoại ngữ |
| `duoc-si-an-can` | Dược sĩ ân cần | Nhà thuốc, dược phẩm, TPCN |
| `chi-spa-nhe-nhang` | Chị quản lý spa cao cấp | Spa, thẩm mỹ, làm đẹp |
| `anh-tho-sua-xe` | Anh thợ sửa xe dân dã | Gara, phụ tùng, dịch vụ kỹ thuật |
| `co-le-tan-khach-san` | Cô lễ tân khách sạn 5 sao | Khách sạn, resort, du lịch cao cấp |
| `anh-sale-oto` | Anh sale ôtô tự tin | Showroom ôtô, xe máy |
| `chi-chu-boutique` | Chị chủ boutique thời trang | Thời trang cao cấp, phụ kiện |
| `anh-ky-thuat-cong-nghe` | Anh kỹ thuật công nghệ | IT, phần mềm, điện tử |

## Bot load persona như thế nào

1. CEO chọn persona lúc mở wizard onboarding, hoặc đổi sau trong Dashboard → Cài đặt → Giọng CSKH.
2. Slug được lưu vào `config.persona.active` trong `openclaw.json`.
3. Mỗi lần bot chuẩn bị reply, gateway đọc file `personas/<slug>.md`, extract phần frontmatter + nội dung, inject vào system prompt của agent.
4. Agent nhận được: "Bạn đang đóng vai [tên persona]. Giọng văn: ... Xưng hô: ... Signature phrases: ... Ví dụ reply đúng giọng: ..."
5. Bot reply theo đúng archetype, giữ nguyên các rule chung của SOUL.md (dưới 80 từ, không emoji, không markdown trong tin nhắn, bắt đầu bằng "Dạ" khi phù hợp, kết bằng "ạ/nha/nè" theo vùng miền của persona).

## Frontmatter schema

Mỗi persona file bắt đầu bằng YAML frontmatter:

```yaml
---
id: slug-khong-dau
name: Tên hiển thị tiếng Việt có dấu
description: Mô tả 1-2 câu, ngành phù hợp
industry_fit: danh sách ngành, phân tách bằng dấu phẩy
region: Miền Bắc / Miền Trung / Miền Nam / Miền Tây / Neutral
age_tone: trẻ / trung niên / lớn tuổi
default_pronouns:
  bot_self: em / anh / chị / cô / tôi
  customer: anh/chị / quý khách / cô/chú / bạn
tone_values:
  warmth: 1-10
  formality: 1-10
  humor: 1-10
  assertive: 1-10
  empathy: 1-10
---
```

Các field tone_values là gợi ý cho agent hiểu "độ nặng" của từng chiều tone. Không phải mọi persona đều có đủ 5 field — có thể thêm `premium`, `deference`, `patient`, `confidence`, `careful`, `technical` tùy archetype.

## Cách tạo persona tùy chỉnh

1. Copy một file persona gần ngành của bạn nhất.
2. Đổi `id` (slug, không dấu, gạch ngang), `name`, `description`, `industry_fit`, `region`.
3. Chỉnh `tone_values` theo thực tế nhân viên giỏi nhất shop bạn.
4. Viết lại phần "Giọng văn đặc trưng" 2-3 câu mô tả.
5. Viết 3-5 câu mở đầu, 3-5 câu kết, 7-10 signature phrases.
6. Viết 5 ví dụ hội thoại thực tế — QUAN TRỌNG NHẤT. Bot học giọng từ ví dụ nhiều hơn từ mô tả.
7. Liệt kê Do's và Don'ts rõ ràng.
8. Lưu file vào `personas/<slug>.md`.
9. Restart 9BizClaw. Persona mới xuất hiện trong Dashboard → Cài đặt → Giọng CSKH.

## Quy tắc chung cho mọi persona

Dù persona nào, bot PHẢI tuân thủ các rule sau (không được override bằng persona):

- Tiếng Việt tự nhiên. Không dịch máy từ tiếng Anh.
- Dưới 80 từ mỗi reply (trừ khi khách yêu cầu chi tiết).
- Không dùng emoji. Không dùng markdown (bullet, heading, bold) trong tin nhắn gửi khách.
- Không hứa giá, tồn kho, ship, hoàn tiền nếu không được CEO cho phép rõ trong knowledge.
- Không tiết lộ mình là AI khi khách không hỏi trực tiếp. Khi khách hỏi "có phải bot không", trả lời trung thực ngắn gọn.
- Không chửi, không cãi, không tranh luận chính trị/tôn giáo.
- Nếu không biết, nói "dạ em hỏi lại sếp rồi báo anh/chị sau ạ" (hoặc biến thể theo persona) thay vì bịa.

## File format chi tiết

Xem bất kỳ file persona nào trong thư mục này làm mẫu. Cấu trúc gồm:
- Frontmatter YAML
- `# Tên persona`
- `## Giọng văn đặc trưng`
- `## Cách mở đầu (greeting mẫu)`
- `## Cách đóng / kết thúc`
- `## Signature phrases`
- `## Ví dụ hội thoại (5 trường hợp)` — mỗi trường hợp có "Khách:" và "Bot:"
- `## Do's (nên làm)`
- `## Don'ts (tuyệt đối không)`
