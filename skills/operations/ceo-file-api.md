---
name: ceo-file-api
description: CEO File API, doc/ghi/list/exec file tren may CEO, chi CEO Telegram
metadata:
  version: 1.1.0
---

# CEO File API

Chi dung khi CEO Telegram yeu cau. `web_fetch` toi `http://127.0.0.1:20200` tu gan xac thuc noi bo trong phien Telegram CEO. KHONG goi `/api/auth/token`, KHONG them `token=<token>`, KHONG doc file token.

## Doc file

```
web_fetch http://127.0.0.1:20200/api/file/read?path=C:/Users/CEO/Desktop/file.xlsx
```

Excel `.xlsx`/`.xls` tu parse thanh JSON. Text/JSON tra noi dung truc tiep. Max 10MB.

## Ghi file

```
web_fetch http://127.0.0.1:20200/api/file/write?path=C:/Users/CEO/Desktop/file.txt&content=noi+dung
```

Tu tao thu muc neu chua co.

## Liet ke thu muc

```
web_fetch http://127.0.0.1:20200/api/file/list?path=C:/Users/CEO/Desktop
```

Tra danh sach file/folder, toi da 200 entries.

## Chay lenh

```
web_fetch http://127.0.0.1:20200/api/exec?command=dir+C:\Users\CEO\Desktop
```

Timeout mac dinh 30s, max 120s. Output max 50KB.

## Bao mat

CHI thuc hien khi CEO Telegram yeu cau. KHONG BAO GIO dung tu Zalo.
