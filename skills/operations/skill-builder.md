---
name: skill-builder
description: Tư vấn CEO tạo/sửa/xóa skill mới qua Telegram chat (thay vì Dashboard)
metadata:
  version: 2.0.0
---

# Tạo skill mới qua chat Telegram

CHỈ CEO Telegram. Khách Zalo yêu cầu → "Dạ đây là thông tin nội bộ ạ."

Xác thực: phiên Telegram CEO tự gắn header nội bộ. KHÔNG gọi `/api/auth/token`, KHÔNG thêm `token=<token>`.

## Trigger

CEO nói: "tạo skill mới", "dạy em quy trình", "thêm rule", "từ giờ khi X thì Y", "nhớ giúp anh là...".

## NGUYÊN TẮC: ĐỀ XUẤT MỌI FIELD — KHÔNG HỎI TỪNG CÂU

Khi CEO yêu cầu tạo skill, **phân tích yêu cầu một lần và đề xuất TẤT CẢ field cùng lúc cho CEO confirm**. KHÔNG hỏi 8 câu liên tiếp. CEO chỉ cần "ok" hoặc nói chỗ nào sửa.

## Bước 1: Phân tích + đề xuất

Đọc yêu cầu CEO, suy luận:

**Tên skill** (5-10 từ, tiếng Việt có dấu, slug-ify tự động):
- VD CEO nói "khi khách hỏi giá iPhone luôn báo có khuyến mãi 10%" → tên: **"Báo giá iPhone kèm khuyến mãi 10%"**

**Trigger** (cụ thể, dùng keyword khách hay dùng):
- "khi khách hỏi giá iPhone"
- "khi đăng bài Zalo"
- "luôn luôn" (cho rule áp mọi tình huống)

**Nội dung** (rule cụ thể, ≤10000 ký tự, có dấu — đủ cho multi-strategy + edge cases + escalation flows, ngang shipped skill hệ thống):
- Paraphrase yêu cầu CEO thành rule rõ ràng
- Bao gồm "khi nào" + "làm gì" + "không làm gì" nếu cần
- Nếu CEO nói chung chung, viết rule cụ thể từ context

**Loại + Áp cho** (suy luận từ context):

Gọi trước: `web_fetch http://127.0.0.1:20200/api/user-skills/list` để biết tên skill hệ thống có sẵn.

Decision tree:

| Dấu hiệu trong yêu cầu CEO | Đề xuất | `type` | `appliesTo` |
|---|---|---|---|
| "khi khách Zalo hỏi..." / "khi nhắn khách Zalo" / "khi chăm sóc khách Zalo" / nhóm Zalo | Rule áp `operations/zalo` | `rule` | `["operations/zalo"]` |
| "khi gửi nhóm Zalo" / quảng bá Zalo | Rule áp `marketing/zalo-post-workflow` | `rule` | `["marketing/zalo-post-workflow"]` |
| "khi tạo ảnh" / "thiết kế ảnh" / brand assets | Rule áp `operations/image-generation` | `rule` | `["operations/image-generation"]` |
| "khi tạo cron" / "lịch tự động" | Rule áp `operations/cron-management` | `rule` | `["operations/cron-management"]` |
| "khi nhắn anh" / "khi tư vấn cho sếp" | Rule áp `operations/telegram-ceo` | `rule` | `["operations/telegram-ceo"]` |
| Theo ngành (FNB, BĐS, ...) | Rule áp skill ngành (vd `fnb.md`) | `rule` | `["fnb"]` |
| "luôn dùng X" / "mọi tình huống" / không kẹp vào skill cụ thể | **Standalone** | `rule` | `[]` |
| Quy trình nhiều bước có thứ tự | Workflow | `workflow` | `[]` hoặc `["<shipped-id>"]` |
| Override hành vi mặc định | Override | `override` | `["<shipped-id>"]` |
| Không rõ | Standalone (default an toàn) | `rule` | `[]` |

## Bước 2: Trình CEO xem proposal

Format reply:

> Em phân tích yêu cầu của anh, đề xuất:
> 
> - **Tên:** Báo giá iPhone kèm khuyến mãi 10%
> - **Trigger:** khi khách hỏi giá iPhone
> - **Loại:** Rule áp riêng cho `operations/zalo` (vì rule reply Zalo khách)
> - **Nội dung:** Khi khách hỏi giá iPhone trên Zalo, luôn kèm câu "có khuyến mãi 10% trong tháng này, anh/chị quan tâm em báo chi tiết ạ"
> 
> Anh thấy ok không, hay cần sửa chỗ nào ạ?
> 
> (Nếu muốn áp cho TẤT CẢ tình huống (standalone), anh nhắn "standalone" thay đổi.)

**Đợi CEO phản hồi:**
- "ok" / "tạo đi" / "đồng ý" → Bước 3 (check conflict + create)
- "đổi tên thành X" / "sửa nội dung..." / "áp cho... thay vì..." / "đổi standalone" → cập nhật proposal, trình lại bước 2
- "thôi" / "hủy" → dừng

## Bước 3: Check conflict TRƯỚC khi tạo

```
web_fetch url="http://127.0.0.1:20200/api/user-skills/check-conflict" method=POST body="{\"content\":\"<nội dung>\",\"appliesTo\":[],\"trigger\":\"<trigger>\"}"
```

Response có `conflicts: [{skillName, reasons}]`:
- Mảng rỗng → tiếp Bước 4
- Có conflict → báo CEO: "Skill này trùng với **[skillName]** ở chỗ: [reasons]. Anh vẫn muốn tạo không, hay sửa skill cũ thay vì tạo mới?"

## Bước 4: Tạo skill

```
web_fetch url="http://127.0.0.1:20200/api/user-skills/create" method=POST body="{\"name\":\"<tên>\",\"type\":\"<rule|override|workflow|custom>\",\"appliesTo\":[],\"trigger\":\"<trigger>\",\"content\":\"<nội dung>\"}"
```

Trong JSON body:
- `appliesTo`: array — `[]` cho standalone, `["operations/zalo"]` nếu áp 1 skill, `["a","b"]` nếu áp nhiều
- `name` + `content` BẮT BUỘC, các field khác optional
- Escape dấu `"` trong nội dung bằng `\"`

Response:
- `200 {"success":true,"entry":{"id":"<slug>",...}}` → tiếp Bước 5
- `400 {"error":"name and content required"}` → thiếu field, hỏi lại CEO
- `409 conflicts with a shipped skill` → tên trùng skill hệ thống. Báo: "Tên `[id]` trùng với skill hệ thống, anh đặt tên khác nhé ạ. Em đề xuất tên: **[tên mới]**" (tự đề xuất tên thay thế)
- `409 already exists` → trùng skill user đã có. Báo: "Skill `[id]` đã có rồi, anh muốn sửa skill cũ hay đặt tên khác ạ?"
- `500` → báo lỗi thật từ response

## Bước 5: Verify + báo cáo

```
web_fetch http://127.0.0.1:20200/api/user-skills/list
```

Tìm `id` vừa tạo trong response `skills[]`. CHỈ báo "đã tạo" khi thấy:

> Đã tạo xong skill **[tên]** (id: `[slug]`). Skill sẽ tự động áp dụng khi có tin nhắn khớp với trigger "**[trigger]**". Anh muốn test ngay không ạ?

## Quản lý skill có sẵn

**Liệt kê:**
```
web_fetch http://127.0.0.1:20200/api/user-skills/list
```
Trả về `{skills: [{id, name, type, appliesTo, trigger, summary, enabled, ...}]}`.

**Tắt/bật:**
```
web_fetch url="http://127.0.0.1:20200/api/user-skills/toggle" method=POST body="{\"id\":\"<skill-id>\",\"enabled\":false}"
```

**Sửa nội dung (giữ các field khác):**
```
web_fetch url="http://127.0.0.1:20200/api/user-skills/update" method=POST body="{\"id\":\"<skill-id>\",\"content\":\"<nội dung mới>\"}"
```

Chỉ truyền field nào cần sửa. Field không truyền → giữ nguyên.

**Xóa:**
```
web_fetch url="http://127.0.0.1:20200/api/user-skills/delete" method=POST body="{\"id\":\"<skill-id>\"}"
```

Xóa là SOFT delete — file lưu vào `_trash/`, giữ 20 lần xóa gần nhất. CEO có thể khôi phục bằng:

**Khôi phục skill đã xóa:**
```
web_fetch url="http://127.0.0.1:20200/api/user-skills/restore" method=POST body="{\"id\":\"<skill-id>\"}"
```

CEO nói "khôi phục skill X" / "phục hồi skill X" / "lấy lại skill X" / "em xóa nhầm rồi, undo skill X" → gọi restore.

Response:
- `200 {"success":true,"entry":{...}}` → "Đã khôi phục skill X."
- `404 No deleted backup` → "Không tìm thấy bản backup của skill `[id]`. Anh kiểm tra lại id ạ."
- `409 already exists` → "Skill `[id]` hiện đã có rồi. Anh muốn xóa cái mới trước khi khôi phục bản cũ không ạ?"

Mọi thao tác sửa/xóa/khôi phục PHẢI confirm CEO trước.

## Giới hạn + Quy tắc

- Tối đa 100 skill user. Nội dung tối đa 10000 ký tự
- Tên trùng shipped/user skill -> reject 409
- Skill PHẢI viết tiếng Việt CÓ DẤU đầy đủ
- Bot KHÔNG tự tạo skill -- chỉ khi CEO yêu cầu rõ ràng
- Khách Zalo yêu cầu tạo skill -> từ chối tuyệt đối
- Skill load runtime ngay sau khi tạo, không cần restart
