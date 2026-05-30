---
name: cron-management
description: Tạo/sửa/xóa lịch tự động (cron) khi CEO yêu cầu qua Telegram, bằng API nội bộ
metadata:
  version: 2.3.0
---

# Quản lý lịch tự động (Cron) qua API nội bộ

## Phạm vi

CHỈ thực hiện khi CEO yêu cầu qua Telegram. Khách hàng Zalo KHÔNG được tạo/sửa/xóa cron.

## Cách thực hiện

Bot dùng `web_fetch` gọi `http://127.0.0.1:20200/api/cron/*`.
KHÔNG ghi `custom-crons.json` trực tiếp. API tự validate và ghi file.

Phiên Telegram CEO tự xác thực khi gọi API local. KHÔNG gọi `/api/auth/token`, KHÔNG thêm `token=<token>`, KHÔNG đọc file token.

## Bước 1: Hiểu yêu cầu CEO

CEO nói: "tạo lịch gửi nhóm X mỗi sáng 9h nội dung Y".
Bot cần xác định:
- Nhóm/người nhận: tên nhóm hoặc groupId
- Thời gian: giờ/ngày/tần suất
- Nội dung: text gửi đi
- Loại: lặp lại (`cronExpr`) hay một lần (`oneTimeAt`)

## Bước 2: Tra cứu nhóm

```
web_fetch http://127.0.0.1:20200/api/cron/list
```

Response JSON chứa:
- `groups: [{ id, name }, ...]` để tìm groupId theo tên nhóm CEO nói.
- `crons: [...]` danh sách cron hiện có.

TUYỆT ĐỐI KHÔNG đoán groupId.

## Bước 3: Confirm với CEO trước khi tạo

Nói rõ: "Em sẽ tạo lịch [label] chạy lúc [giờ] gửi nhóm [tên nhóm]. Anh xác nhận nhé?"
CHỜ CEO trả lời xác nhận trước khi gọi create/delete/toggle.

## Bước 4: Gọi API tạo cron

Quy tắc URL:
- Dùng `+` thay khoảng trắng.
- `content` hoặc `prompt` đặt cuối URL.
- Ký tự đặc biệt: `&` -> `%26`, `"` -> `%22`, `%` -> `%25`.
- Prompt agent mode phải viết tiếng Việt có dấu đầy đủ.

**BẮT BUỘC: mọi cron group PHẢI truyền cả `groupId` VÀ `groupName`.** API cross-check để chặn bind sai nhóm (sự cố thật 2026-05-15: cron bị bind vào "LỊCH KH NUMINA" trong khi prompt nói "LỊCH CÁ NHÂN"). Nếu chỉ truyền `groupId`, API trả 400 + nhắc thêm groupName.

Lặp lại một nhóm:
```
web_fetch http://127.0.0.1:20200/api/cron/create?label=Chào+sáng&cronExpr=0+9+*+*+1-5&groupId=123456&groupName=Khách+VIP&content=Chào+buổi+sáng!
```

Lặp lại nhiều nhóm (groupIds + groupName phải khớp 1-1 hoặc gọi nhiều lần riêng biệt):
```
# Khuyến nghị: gọi 3 lần riêng cho 3 nhóm, mỗi lần có cả id+name
```

Lịch một lần:
```
web_fetch http://127.0.0.1:20200/api/cron/create?label=Thông+báo&oneTimeAt=2026-04-22T09:00:00&groupId=123456&groupName=Tên+nhóm&content=Nội+dung!
```

Agent mode (bot tự suy luận + thực hiện):
```
web_fetch http://127.0.0.1:20200/api/cron/create?label=Báo+cáo+sáng&cronExpr=0+8+*+*+*&groupId=123456&groupName=Tên+nhóm&mode=agent&prompt=Tổng+hợp+hoạt+động+hôm+qua+và+gửi+báo+cáo+ngắn+gọn
```

**GỬI ẢNH vào nhóm Zalo:** LUÔN dùng agent mode. KHÔNG dùng `content` với đường dẫn file — sẽ gửi đường dẫn dưới dạng text.
```
web_fetch http://127.0.0.1:20200/api/cron/create?label=Ảnh+sáng+nhóm&cronExpr=30+8+*+*+*&groupId=123456&groupName=Tên+nhóm&mode=agent&prompt=[WORKFLOW]+Tạo+1+ảnh+poster+chào+buổi+sáng+rồi+gửi+vào+nhóm+Tên+nhóm
```
Bot sẽ tự: tạo ảnh → gửi ảnh thật (qua openzca msg image) → không bao giờ gửi đường dẫn file.

**GỬI ẢNH CÓ SẴN theo lịch (CEO gửi ảnh + yêu cầu gửi lại mỗi ngày):**
Khi CEO gửi ảnh trên Telegram và yêu cầu tạo cron gửi ảnh đó:
1. Lưu ảnh vào media library: `web_fetch http://127.0.0.1:20200/api/media/upload?filePath=<đường dẫn ảnh CEO gửi>&visibility=public&type=brand`
   Response trả `mediaId` (VD: `"mediaId":"img_abc123"`)
2. Tạo cron agent mode với prompt tham chiếu mediaId:
```
web_fetch http://127.0.0.1:20200/api/cron/create?label=Thông+báo+lịch+đào+tạo&cronExpr=0+8+*+*+1-4&groupId=123456&groupName=Tên+nhóm&mode=agent&prompt=[WORKFLOW]+Gửi+ảnh+mediaId+img_abc123+kèm+caption+"Nội+dung+kèm"+vào+nhóm+Tên+nhóm.+Dùng+web_fetch+/api/zalo/send-media?mediaId=img_abc123%26groupId=123456%26caption=Nội+dung
```
3. Khi cron fire → agent gọi `/api/zalo/send-media?mediaId=img_abc123&groupId=123456&caption=...` → ảnh thật được gửi.

**Lưu ý:** Ảnh CEO gửi qua Telegram nằm trong thư mục media của gateway session. Dùng `read_file` hoặc `list_files` tìm ảnh gần nhất trong session, rồi `web_fetch /api/media/upload` để lưu vĩnh viễn.

**CẢNH BÁO: KHÔNG BAO GIỜ tạo cron text (`content`) chứa đường dẫn ảnh** như `brand-assets/generated/img_xxx.png`. Kết quả: gửi TEXT đường dẫn cho khách, không phải ảnh. Muốn gửi ảnh → agent mode + prompt mô tả ảnh hoặc tham chiếu mediaId.

## Bước 5: Xác nhận cron đã tạo (BẮT BUỘC)

Sau khi gọi create, PHẢI kiểm tra response:
1. Response có `"success":true` → tiếp bước 2.
2. Response có `"error":` → báo CEO lỗi cụ thể, KHÔNG nói "đã tạo".
3. Gọi `web_fetch http://127.0.0.1:20200/api/cron/list` — tìm cron vừa tạo trong danh sách.
4. CHỈ nói "đã tạo thành công" khi thấy cron trong list. Nếu không thấy → báo CEO "tạo không thành công".

TUYỆT ĐỐI KHÔNG nói "đã tạo" nếu chưa verify qua /api/cron/list.

## Xóa / tạm dừng / bật lại

```
web_fetch http://127.0.0.1:20200/api/cron/delete?id=<cronId>
web_fetch http://127.0.0.1:20200/api/cron/toggle?id=<cronId>&enabled=false
```

Mọi thao tác phải confirm CEO trước.

## Sửa nhiều cron (atomic)

Dùng `POST /api/cron/replace` body `{"deleteIds":[...], "creates":[...]}` -- API giữ cron cũ nếu tạo mới lỗi.

## Audit cron bind sai

CEO nghi ngờ cron gửi sai nhóm: `web_fetch http://127.0.0.1:20200/api/cron/audit` -- trả về `flagged` + lý do.

## Lưu ý

- Label tiếng Việt đầy đủ dấu, KHÔNG emoji
- GroupId phải tồn tại, API tự validate
- Zalo customers KHÔNG truy cập được API
