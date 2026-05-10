---
name: google-workspace
description: Google Calendar, Gmail, Drive, Docs, Contacts, Tasks, Sheets, Apps Script — CHỈ CEO Telegram
metadata:
  version: 1.1.0
---

# Google Workspace — CHỈ CEO Telegram

Bot có thể truy cập Google Calendar, Gmail, Drive, Docs, Contacts, Tasks, Sheets và Apps Script của CEO qua local API.
Dùng web_fetch gọi http://127.0.0.1:20200/api/google/*.

Xác thực: phiên Telegram CEO tự gắn header nội bộ cho API local. KHÔNG gọi `/api/auth/token`, KHÔNG tự thêm `token=<token>`.

## Routes

- GET /api/google/status — kiểm tra trạng thái kết nối
- GET /api/google/health — kiểm tra từng dịch vụ. Nếu service báo `accessNotConfigured` hoặc "has not been used in project" thì báo CEO bật dùng Google API trong Google Cloud, KHÔNG nói đã sẵn sàng.

### Calendar
- GET /api/google/calendar/events?from=ISO&to=ISO — lịch theo khoảng thời gian
- POST /api/google/calendar/create body: {summary, start, end, attendees?} — tạo sự kiện
- POST /api/google/calendar/update body: {eventId, summary?, start?, end?, description?, location?, attendees?, sendUpdates?} — cập nhật sự kiện
- POST /api/google/calendar/delete body: {eventId} — xóa sự kiện
- POST /api/google/calendar/freebusy body: {from, to} — kiểm tra lịch bận
- POST /api/google/calendar/free-slots body: {date: "YYYY-MM-DD"} — tìm slot trống

### Gmail
- GET /api/google/gmail/inbox?max=20 — danh sách email
- GET /api/google/gmail/read?id=<msgId> — đọc chi tiết 1 email
- POST /api/google/gmail/send body: {to, subject, body} — gửi email mới
- POST /api/google/gmail/reply body: {id, body} — trả lời email

### Drive
- GET /api/google/drive/list?query=<q>&max=20 — tìm file Drive
- POST /api/google/drive/upload body: {filePath, folderId?} — upload file
- POST /api/google/drive/download body: {fileId, destPath, format?} — download/export file
- POST /api/google/drive/share body: {fileId, email, role?} — chia sẻ file

### Sheets
- GET /api/google/sheets/list?max=20 — liệt kê Google Sheets gần đây trong Drive
- GET /api/google/sheets/metadata?spreadsheetId=<id> — xem metadata Google Sheet
- GET /api/google/sheets/get?spreadsheetId=<id>&range=Sheet1!A1:D20 — đọc dữ liệu Sheet (giá trị hiển thị)
- GET /api/google/sheets/get?spreadsheetId=<id>&range=Sheet1!A1:D20&render=FORMULA — đọc công thức thay vì giá trị (render: FORMATTED_VALUE | UNFORMATTED_VALUE | FORMULA)
- POST /api/google/sheets/update body: {spreadsheetId, range, values} — sửa vùng dữ liệu Sheet
- POST /api/google/sheets/append body: {spreadsheetId, range, values} — thêm dòng vào Sheet

### Docs
- GET /api/google/docs/list?max=20 — liệt kê Google Docs gần đây trong Drive
- GET /api/google/docs/info?docId=<id> — xem thông tin Google Doc
- GET /api/google/docs/read?docId=<id>&maxBytes=200000 — đọc nội dung Google Doc
- POST /api/google/docs/create body: {title, parent?, file?, pageless?} — tạo Google Doc
- POST /api/google/docs/write body: {docId, text?, file?, append?, replace?, markdown?, tabId?} — ghi nội dung Google Doc
- POST /api/google/docs/insert body: {docId, content?, file?, index?, tabId?} — chèn nội dung vào Google Doc
- POST /api/google/docs/find-replace body: {docId, find, replace?, first?, matchCase?, tabId?} — tìm và thay thế trong Google Doc
- POST /api/google/docs/export body: {docId, out?, format?} — export Google Doc

### Contacts
- GET /api/google/contacts/search?query=<q> — tìm liên hệ
- POST /api/google/contacts/create body: {name, phone?, email?} — tạo liên hệ

### Tasks
- GET /api/google/tasks/lists — danh sách task lists
- GET /api/google/tasks/list?listId=<id> — danh sách tasks
- POST /api/google/tasks/create body: {title, due?, listId?} — tạo task
- POST /api/google/tasks/complete body: {taskId, listId?} — hoàn thành task

### Apps Script
- POST /api/google/appscript/run body: {scriptId, functionName, params?} — chạy Apps Script

## Cú pháp web_fetch chuẩn

```
web_fetch url="http://127.0.0.1:20200/api/google/calendar/events?from=2026-04-28T00:00:00Z&to=2026-05-04T23:59:59Z" method=GET
```
```
web_fetch url="http://127.0.0.1:20200/api/google/gmail/send" method=POST body="{\"to\":\"user@example.com\",\"subject\":\"Tiêu đề\",\"body\":\"Nội dung\"}" headers="{\"Content-Type\":\"application/json\"}"
```

## Ví dụ mapping

- "lịch tuần này" → GET /api/google/calendar/events?from=<today>&to=<+7d>
- "đặt meeting 3pm thứ 5" → POST /api/google/calendar/create
- "slot trống ngày mai" → POST /api/google/calendar/free-slots
- "email mới" → GET /api/google/gmail/inbox
- "gửi email cho X nội dung Y" → POST /api/google/gmail/send
- "tìm file báo cáo" → GET /api/google/drive/list?query=báo+cáo
- "tóm tắt Google Doc" → GET /api/google/docs/read?docId=<id>&maxBytes=200000 rồi tóm tắt
- "tạo Google Doc" → POST /api/google/docs/create rồi POST /api/google/docs/write nếu cần ghi nội dung
- "danh sách Google Sheet gần đây" → GET /api/google/sheets/list?max=20
- "đọc sheet đơn hàng" → GET /api/google/sheets/get?spreadsheetId=<id>&range=Orders!A1:H50
- "thêm dòng vào sheet" → POST /api/google/sheets/append
- "số điện thoại Hùng" → GET /api/google/contacts/search?query=Hùng
- "thêm task gọi khách" → POST /api/google/tasks/create
- "tasks hôm nay" → GET /api/google/tasks/list

AppSheet: hiện tại thao tác trực tiếp AppSheet app/admin API chưa được wrap. Nếu AppSheet dùng Google Sheet làm data source thì đọc/sửa Sheet qua routes `/api/google/sheets/*`.

## Google Sheet link flow — BẮT BUỘC

- KHÔNG gọi `/api/auth/token`. Gọi route Google local trực tiếp; phiên Telegram CEO tự xác thực.
- Nếu CEO gửi link `docs.google.com/spreadsheets/d/<id>/...`, trích `<id>` rồi dùng local API `/api/google/sheets/*`. KHÔNG web_fetch trực tiếp link Google Sheet và KHÔNG yêu cầu CEO bật chia sẻ công khai khi Google Workspace đã kết nối.
- Trước khi đọc dữ liệu, gọi `GET /api/google/sheets/metadata?spreadsheetId=<id>` để lấy tên tab thật.
- Nếu CEO không nói tab/range, đọc tab đầu tiên bằng range `<Tên tab đầu tiên>!A1:Z50` (quote tên tab nếu có khoảng trắng/ký tự đặc biệt).
- Nếu CEO hỏi "có danh sách các sheet không" hoặc chọn "danh sách gần đây", gọi `GET /api/google/sheets/list?max=20`, không dùng query tự chế như `type:spreadsheet`.
- Khi ghi bằng nhiều dòng qua `/api/google/sheets/update` hoặc `/api/google/sheets/append`, `values` PHẢI là JSON 2D array, ví dụ `[["Ngày","Danh mục"],["",""]]`, URL-encode nếu dùng GET. Có thể dùng range bắt đầu như `Sheet1!A1`; API sẽ tự mở rộng vùng ghi theo số dòng/cột. KHÔNG tự retry bằng cách giảm range nếu Google báo "tried writing to row ..."; lỗi đó nghĩa là `values`/range chưa khớp hoặc values chưa được parse đúng.

## Google Docs link flow — BẮT BUỘC

- Nếu CEO gửi link `docs.google.com/document/d/<id>/...`, trích `<id>` rồi dùng local API `/api/google/docs/*`. KHÔNG web_fetch trực tiếp link Google Doc và KHÔNG yêu cầu CEO bật chia sẻ công khai khi Google Workspace đã kết nối.
- Nếu CEO không nói phần cần đọc, gọi `GET /api/google/docs/read?docId=<id>&maxBytes=200000`.
- Nếu đọc/sửa thất bại do `accessNotConfigured`, báo CEO bật Google Docs API hoặc Drive API trong Google Cloud project của OAuth client.

## Lỗi thường gặp

- Contacts lỗi `People API has not been used in project` hoặc `accessNotConfigured` → báo CEO bật People API.
- Tasks lỗi tương tự → báo CEO bật Google Tasks API.
- Không yêu cầu CEO kết nối lại nếu `/api/google/status` vẫn connected.

## An toàn

KHÔNG BAO GIỜ gửi email hoặc tạo sự kiện từ Zalo. Chỉ thực hiện khi CEO yêu cầu trực tiếp qua Telegram. Nếu Zalo hỏi về email/lịch: trả lời thông tin nhưng KHÔNG thực hiện hành động.

Nếu chưa kết nối Google: trả lời "Anh chưa kết nối Google Workspace. Mở Dashboard > Google Workspace > Cài đặt để kết nối."
