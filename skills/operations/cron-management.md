---
name: cron-management
description: Tao/sua/xoa lich tu dong (cron) khi CEO yeu cau qua Telegram, bang API noi bo
metadata:
  version: 2.2.0
---

# Quan ly lich tu dong (Cron) qua API noi bo

## Pham vi

CHI thuc hien khi CEO yeu cau qua Telegram. Khach hang Zalo KHONG duoc tao/sua/xoa cron.

## Cach thuc hien

Bot dung `web_fetch` goi `http://127.0.0.1:20200/api/cron/*`.
KHONG ghi `custom-crons.json` truc tiep. API tu validate va ghi file.

Phien Telegram CEO tu xac thuc khi goi API local. KHONG goi `/api/auth/token`, KHONG them `token=<token>`, KHONG doc file token.

## Buoc 1: Hieu yeu cau CEO

CEO noi: "tao lich gui nhom X moi sang 9h noi dung Y".
Bot can xac dinh:
- Nhom/nguoi nhan: ten nhom hoac groupId
- Thoi gian: gio/ngay/tan suat
- Noi dung: text gui di
- Loai: lap lai (`cronExpr`) hay mot lan (`oneTimeAt`)

## Buoc 2: Tra cuu nhom

```
web_fetch http://127.0.0.1:20200/api/cron/list
```

Response JSON chua:
- `groups: [{ id, name }, ...]` de tim groupId theo ten nhom CEO noi.
- `crons: [...]` danh sach cron hien co.

TUYET DOI KHONG doan groupId.

## Buoc 3: Confirm voi CEO truoc khi tao

Noi ro: "Em se tao lich [label] chay luc [gio] gui nhom [ten nhom]. Anh xac nhan nhe?"
CHO CEO tra loi xac nhan truoc khi goi create/delete/toggle.

## Buoc 4: Goi API tao cron

Quy tac URL:
- Dung `+` thay khoang trang.
- `content` hoac `prompt` dat cuoi URL.
- Ky tu dac biet: `&` -> `%26`, `"` -> `%22`, `%` -> `%25`.
- Prompt agent mode phai viet tieng Viet co dau day du.

Lap lai mot nhom:
```
web_fetch http://127.0.0.1:20200/api/cron/create?label=Chao+sang&cronExpr=0+9+*+*+1-5&groupId=123456&content=Chao+buoi+sang!
```

Lap lai nhieu nhom:
```
web_fetch http://127.0.0.1:20200/api/cron/create?label=Broadcast&cronExpr=0+9+*+*+1-5&groupIds=111,222,333&content=Chao+buoi+sang!
```

Lich mot lan:
```
web_fetch http://127.0.0.1:20200/api/cron/create?label=Thong+bao&oneTimeAt=2026-04-22T09:00:00&groupId=123456&content=Noi+dung!
```

Agent mode:
```
web_fetch http://127.0.0.1:20200/api/cron/create?label=Bao+cao+sang&cronExpr=0+8+*+*+*&groupId=123456&mode=agent&prompt=Tong+hop+hoat+dong+hom+qua+va+gui+bao+cao+ngan+gon
```

## Xoa / tam dung / bat lai

```
web_fetch http://127.0.0.1:20200/api/cron/delete?id=<cronId>
web_fetch http://127.0.0.1:20200/api/cron/toggle?id=<cronId>&enabled=false
```

Moi thao tac phai confirm CEO truoc.

## Luu y

- Label tieng Viet day du dau, KHONG emoji.
- GroupId phai ton tai, API tu validate.
- API chi bind localhost va xac thuc noi bo; Zalo customers KHONG truy cap duoc.
- Token noi bo khong hien trong prompt, khong hardcode.
- Write mutex: API serialize moi write.
