---
name: workflow-chains
description: Tự tách và thực hiện workflow nhiều bước — không giới hạn số bước, tự compose từ API có sẵn
metadata:
  version: 2.0.0
---

# Workflow Chains — Tự compose workflow từ API có sẵn

CEO có thể yêu cầu BẤT KỲ workflow nào kết hợp nhiều bước. Bot KHÔNG phụ thuộc vào danh sách chain cố định — tự tách bước, tự chọn API, tự chạy tuần tự.

## Quy tắc sắt

1. **KHÔNG DỪNG GIỮA CHỪNG.** CEO nói "tạo ảnh rồi gửi nhóm Zalo" = 2 bước. Tạo ảnh xong → PHẢI gửi tiếp. Im ru sau bước 1 = lỗi nghiêm trọng.
2. **Output bước N = input bước N+1.** Dữ liệu từ bước trước → làm input bước tiếp theo. imagePath từ generate → gửi qua send-media. KHÔNG để mất data giữa các bước.
3. **Fail loud theo mode.** Chế độ thường: bước bắt buộc fail → dừng và báo CEO rõ bước nào lỗi. Prompt có `[AUTO-MODE]`: retry đúng 1 lần; nếu vẫn fail thì báo CEO 1 dòng ngắn, BỎ QUA bước đó và tiếp tục bước sau ngay, không chờ CEO.
4. **Không giới hạn số bước.** 3, 5, 7, 10 bước đều OK. CEO muốn gì thì compose từ API có sẵn.

## API actions có sẵn (bot tự chọn)

| Domain | Actions | Skill tham khảo |
|--------|---------|-----------------|
| Tạo ảnh | `image/generate`, `image/status`, `image/generate-and-send-zalo` | `image-generation.md` |
| Gửi Zalo text | `openzca msg send` (qua cron hoặc sendZaloTo) | `telegram-ceo.md` |
| Gửi Zalo ảnh | `zalo/send-media`, `image/generate-and-send-zalo` | `image-generation.md` |
| Đơn hàng | `order/create`, `order/list`, `order/update`, `order/summary` | `workspace-api.md` |
| Tồn kho | `inventory/adjust`, `inventory/check`, `inventory/alerts` | `workspace-api.md` |
| Nghỉ phép | `leave/request`, `leave/list`, `leave/summary` | `workspace-api.md` |
| Báo cáo | `report/daily` | `workspace-api.md` |
| Xuất khách CRM | `zalo-crm/export` | `zalo-followup-sheet.md` |
| Workspace file | `workspace/read`, `workspace/append`, `workspace/list` | `workspace-api.md` |
| CEO file | `file/read`, `file/write`, `file/list`, `file/exec` | `ceo-file-api.md` |
| Memory | `memory/write`, `memory/search` | `ceo-memory-api.md` |
| Cron | `cron/create`, `cron/list`, `cron/delete` | `cron-management.md` |

## Cách thực hiện (bất kỳ workflow nào)

### Bước 0: Phân tích + liệt kê

Tách yêu cầu CEO thành bước, chọn API cho mỗi bước, liệt kê:

> Em hiểu yêu cầu gồm 4 bước:
> 1. Đọc file lịch đăng bài từ workspace
> 2. Lấy nội dung hôm nay → soạn prompt tạo ảnh
> 3. Tạo ảnh gửi vào nhóm Zalo "Khách VIP"
> 4. Ghi lại trạng thái "đã gửi" vào file log
>
> Em làm luôn nhé?

CEO confirm → chạy. CEO sửa → điều chỉnh.

### Bước 1-N: Chạy tuần tự

Mỗi bước:
1. Gọi API → đợi response thành công
2. Trích data cần thiết từ response (imagePath, content, v.v.)
3. Dùng data đó cho bước tiếp theo
4. Báo CEO ngắn gọn kết quả từng bước (KHÔNG đợi hết chain mới báo)

**AUTO-MODE tool order:** nếu cần gửi tiến độ bằng `message`, chỉ gọi `message` sau khi các tool thật của bước đó đã xong và đặt `message` là tool cuối trong lượt. Không đặt `message` trước `web_fetch`/`exec`/upload/generate.

**AUTO-MODE image rule:** mỗi job ảnh thật được phép chạy tối đa 15 phút; `waitMs` chỉ là thời gian agent chờ HTTP trước khi nhận `jobId`. Với 1 ảnh cần dùng ngay, dùng `waitMs=300000`. Với 2-3 ảnh độc lập, khởi tạo các `/api/image/generate` song song cùng một lượt với `autoSendTelegram=false&waitMs=300000`, giữ toàn bộ `jobId`, rồi poll từng job. Nếu job nào vẫn `generating/timedOut` sau 5 phút thì tiếp tục bước không phụ thuộc ảnh và quay lại poll, không tạo lại job cũ.

### Bước cuối: Tổng kết

> Xong 4/4 bước:
> 1. File lịch: đọc 5 dòng lịch đăng bài
> 2. Prompt: soạn xong từ nội dung "Khuyến mãi tuần 3"
> 3. Ảnh: đã tạo + gửi nhóm "Khách VIP"
> 4. Log: cập nhật trạng thái "đã gửi"

## Quy tắc gửi ảnh Zalo (hay quên)

**CẢNH BÁO: Đây là lỗi phổ biến nhất trong workflow.**

- Tạo ảnh xong PHẢI gửi tiếp nếu CEO yêu cầu. KHÔNG im ru.
- Gửi ẢNH THẬT, không gửi đường dẫn file dưới dạng text.
- Dùng `generate-and-send-zalo` (atomic, 1 call) HOẶC poll `image/status` → lấy `mediaId` rồi gọi `zalo/send-media?mediaId=<mediaId>&allowInternalGenerated=true&caption=<text>`.
- Nếu chỉ có `imagePath` nội bộ dạng `brand-assets/generated/...`, vẫn được gọi `zalo/send-media?imagePath=<path>&allowInternalGenerated=true&caption=<text>`. KHÔNG dùng tool `message` channel modoro-zalo để gửi ảnh; phải gọi API `/api/zalo/send-media` để nhận success/error thật.
- Đọc `skills/operations/image-generation.md` mục "Gửi ảnh vào nhóm Zalo SAU KHI tạo xong" cho chi tiết.

## Ví dụ workflow 5+ bước

CEO: "Kiểm tra tồn kho, lọc mặt hàng sắp hết, tạo ảnh cảnh báo, gửi nhóm Kho, rồi ghi log báo cáo"

→ 5 bước:
1. `inventory/check` → lấy danh sách tồn kho
2. Lọc items có qty < minQty → soạn nội dung cảnh báo
3. `image/generate-and-send-zalo` → tạo ảnh cảnh báo + gửi nhóm Kho
4. `workspace/append` → ghi log vào file báo cáo (ngày, số items cảnh báo, đã gửi nhóm)
5. Reply CEO: "Em đã gửi cảnh báo tồn kho (3 items sắp hết) vào nhóm Kho + ghi log."

## Cron workflow

CEO muốn chain chạy tự động → tạo cron agent mode với prefix `[WORKFLOW]`:
```
web_fetch POST /api/cron/create body={"label":"Cảnh báo tồn kho sáng","cronExpr":"0 8 * * 1-5","groupId":"123","groupName":"Nhóm Kho","mode":"agent","prompt":"[WORKFLOW] Kiểm tra tồn kho, lọc hàng sắp hết, tạo ảnh cảnh báo gửi nhóm Kho, ghi log báo cáo"}
```

**Gửi ảnh trong cron:** LUÔN dùng agent mode. KHÔNG dùng `content` với đường dẫn file.

## An toàn

- KHÔNG chain từ Zalo customer — chỉ CEO Telegram/Dashboard
- Bước nào cần confirm CEO (gửi tin Zalo, xóa dữ liệu) → hỏi trước khi chạy. Ngoại lệ: prompt có `[AUTO-MODE]` thì CEO đã duyệt pipeline, không hỏi confirm.
- Bước đọc data (file, inventory, memory) → chạy luôn không cần hỏi
