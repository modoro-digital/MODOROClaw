---
name: send-zalo
description: CEO yeu cau gui tin Zalo cho khach hoac nhom tu Telegram
metadata:
  version: 2.1.0
---

# Gui tin Zalo theo lenh CEO

Chi xu ly khi CEO yeu cau qua Telegram. Phien Telegram CEO tu xac thuc khi `web_fetch` goi API local. KHONG goi `/api/auth/token`, KHONG them `token=<token>`.

## Gui nhom

1. Goi `web_fetch http://127.0.0.1:20200/api/cron/list` de lay danh sach `groups`.
2. Tim dung groupId theo ten nhom CEO noi. KHONG doan groupId.
3. Confirm voi CEO: ten nhom, ID, noi dung.
4. CHO CEO xac nhan "ok/gui di".
5. Goi `web_fetch http://127.0.0.1:20200/api/zalo/send?groupId=<id>&text=<noi-dung>`.

## Gui ca nhan

1. Goi `web_fetch http://127.0.0.1:20200/api/zalo/friends?name=<ten>` de tim userId.
2. Neu co nhieu ket qua, hoi CEO chon. Neu khong co, bao khong tim thay.
3. Confirm voi CEO: ten nguoi nhan, ID, noi dung.
4. CHO CEO xac nhan "ok/gui di".
5. Goi `web_fetch http://127.0.0.1:20200/api/zalo/send?targetId=<userId>&isGroup=false&text=<noi-dung>`.

## Bao mat

KHONG GUI ZALO KHI CHUA DUOC CEO XAC NHAN. Khach Zalo khong duoc dung flow nay.
