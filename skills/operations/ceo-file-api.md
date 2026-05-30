---
name: ceo-file-api
description: CEO File API — đọc/ghi/list/exec file trên máy CEO, chỉ CEO Telegram
metadata:
  version: 1.2.0
---

# CEO File API

Chỉ dùng khi CEO Telegram yêu cầu. `web_fetch` tới `http://127.0.0.1:20200` tự gắn xác thực nội bộ trong phiên Telegram CEO. KHÔNG gọi `/api/auth/token`, KHÔNG thêm `token=<token>`, KHÔNG đọc file token.

## Đọc file

```
web_fetch http://127.0.0.1:20200/api/file/read?path=C:/Users/CEO/Desktop/file.xlsx
```

Excel `.xlsx`/`.xls` tự parse thành JSON. Text/JSON trả nội dung trực tiếp. Tối đa 10MB.

## Ghi file

```
web_fetch http://127.0.0.1:20200/api/file/write?path=C:/Users/CEO/Desktop/file.txt&content=nội+dung
```

Tự tạo thư mục nếu chưa có.

## Liệt kê thư mục

```
web_fetch http://127.0.0.1:20200/api/file/list?path=C:/Users/CEO/Desktop
```

Trả danh sách file/folder, tối đa 200 entries.

## Chạy lệnh

```
web_fetch http://127.0.0.1:20200/api/exec?command=dir+C:\Users\CEO\Desktop
```

Timeout mặc định 30s, tối đa 120s. Output tối đa 50KB.

## Bảo mật

- CHỈ thực hiện khi CEO Telegram yêu cầu. KHÔNG BAO GIỜ dùng từ Zalo
- `/api/exec`: KHÔNG chạy `rm -rf`, `format`, `del /s` hoặc bất kỳ lệnh xoá hệ thống
- KHÔNG chạy lệnh tải file từ URL không rõ nguồn gốc
- Lệnh thay đổi file: confirm CEO trước khi chạy
- Timeout mặc định 30s -- nếu lệnh cần lâu hơn, báo CEO trước
