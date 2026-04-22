---
name: follow-up
description: Theo dõi và nhắc lại khách hàng Zalo chưa được phản hồi
metadata:
  version: 1.0.0
---

# Theo doi khach hang Zalo

## He thong tu dong

Scanner chay moi ngay luc 09:30 (cron zalo-followup). Bot KHONG can tu kich hoat.

## Tieu chi follow-up

- Khach dang cho phan hoi >48h (pending reply)
- Khach co hua hen duoc phat hien (regex: "ghe cua hang", "gui bao gia", "goi lai")
- Khach co tag `hot` hoac `lead` trong memory

## Tieu chi BO QUA

- Khach "cold" (chua bao gio nhan tin truoc)
- Hoi dap da hoan tat (resolved)
- Lan cuoi lien lac <48h
- Khach trong blocklist

## Format tin follow-up

- Am ap, tham chieu cuoc hoi thoai gan nhat
- "Da anh/chi [ten], hom truoc minh noi ve [chu de], anh/chi co can em ho tro them gi khong a?"
- KHONG push ban hang trong follow-up
- KHONG gui qua 1 follow-up/tuan cho cung 1 khach

## Bao cao CEO

Sau khi scan xong, gui CEO (Telegram) danh sach khach can follow-up voi ly do.
