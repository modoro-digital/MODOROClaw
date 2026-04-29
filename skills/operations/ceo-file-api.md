---
name: ceo-file-api
description: CEO File API — doc/ghi/list/exec file tren may CEO, CHI CEO Telegram
metadata:
  version: 1.0.0
---

# CEO File API — CHI CEO Telegram

Truy cap MOI file tren may tinh CEO. Token bat buoc cho moi endpoint.

## Doc file

```
web_fetch http://127.0.0.1:20200/api/file/read?token=<token>&path=C:/Users/CEO/Desktop/file.xlsx
```

Excel (.xlsx/.xls) tu parse thanh JSON. Text/JSON tra noi dung truc tiep. Max 10MB.

## Ghi file

```
web_fetch http://127.0.0.1:20200/api/file/write?token=<token>&path=C:/Users/.../file.txt&content=noi+dung
```

Tu tao thu muc neu chua co.

## Liet ke thu muc

```
web_fetch http://127.0.0.1:20200/api/file/list?token=<token>&path=C:/Users/CEO/Desktop
```

Tra danh sach file/folder (max 200 entries).

## Chay lenh

```
web_fetch http://127.0.0.1:20200/api/exec?token=<token>&command=dir+C:\Users\CEO\Desktop
```

Timeout mac dinh 30s, max 120s. Output max 50KB.

## Bao mat

CHI thuc hien khi CEO Telegram yeu cau. KHONG BAO GIO dung tu Zalo.
