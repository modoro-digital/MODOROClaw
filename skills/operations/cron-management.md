---
name: cron-management
description: Tạo/sửa/xóa lịch tự động (cron) khi CEO yêu cầu qua Telegram
metadata:
  version: 1.0.0
---

# Quan ly lich tu dong (Cron)

## Pham vi

CHI thuc hien khi CEO yeu cau qua Telegram. Khach hang Zalo KHONG duoc tao/sua/xoa cron.

## Quy trinh bat buoc

### Buoc 1: Hieu yeu cau CEO

CEO noi: "tao lich gui nhom X moi sang 9h noi dung Y"
Bot can xac dinh:
- **Nhom/nguoi nhan:** ten nhom hoac userId
- **Thoi gian:** gio/ngay/tan suat
- **Noi dung:** text gui di
- **Loai:** lap lai (cronExpr) hay mot lan (oneTimeAt)

### Buoc 2: Tra cuu groupId

Doc `groups.json` trong workspace. Tim groupId theo ten nhom CEO noi.
Neu KHONG tim thay → bao CEO: "Em khong tim thay nhom ten [X]. Anh kiem tra lai ten chinh xac giup em?"
TUYET DOI KHONG doan groupId.

### Buoc 3: Xay dung JSON

#### Lich lap lai (cronExpr)

```json
{
  "id": "slug-chu-thuong-gach-ngang",
  "label": "Mo ta tieng Viet, KHONG emoji",
  "cronExpr": "0 9 * * 1-5",
  "prompt": "exec: openzca msg send 6778716167335853128 \"Chao buoi sang!\" --group",
  "enabled": true
}
```

#### Lich mot lan (oneTimeAt)

```json
{
  "id": "one-time-slug",
  "label": "Mo ta tieng Viet, KHONG emoji",
  "oneTimeAt": "2026-04-22T09:00:00",
  "prompt": "exec: openzca msg send 6778716167335853128 \"Chao buoi sang!\" --group",
  "enabled": true
}
```

### BAT BUOC — Quy tac prompt

- Gui Zalo: `exec: openzca msg send <groupId> "<noi dung>" --group`
- `exec:` prefix BAT BUOC — thieu prefix = cron bi ket o approval wall
- GroupId lay tu `groups.json`, KHONG tu dien
- Noi dung trong dau ngoac kep

### BAT BUOC — Quy tac cronExpr

Chi chap nhan cron expression chuan (5 hoac 6 fields):
- `0 9 * * 1-5` = 9h thu 2–6
- `30 7 * * *` = 7:30 moi ngay
- `0 */2 * * *` = moi 2 gio
- `0 7 1 * *` = 7h ngay 1 moi thang
- `37 7 22 4 *` = 7:37 ngay 22/4

**CAM TUYET DOI:**
- `2026-04-22T01:51:00.000Z` — ISO date, KHONG phai cron
- `7:37 AM` — gio thuong, KHONG phai cron
- `tomorrow 9am` — text, KHONG phai cron
- Bat ky chuoi co `T` hoac `-` dang ngay thang

Neu CEO noi "gui luc 7:37 hom nay" → dung `oneTimeAt`, KHONG dung cronExpr.

### BAT BUOC — Quy tac oneTimeAt

- Format: `YYYY-MM-DDTHH:MM:SS` (local time, KHONG co Z)
- KHONG BAO GIO them `.000Z` hoac `Z` o cuoi
- He thong tu dong chay dung gio roi xoa entry

### Buoc 4: Confirm voi CEO TRUOC khi ghi

Gui message Telegram:
"Em se tao lich [label] chay luc [gio] gui nhom [ten nhom]. Anh xac nhan nhe?"

CHO CEO tra loi. KHONG ghi file khi chua duoc xac nhan.

### Buoc 5: Ghi file

Doc `custom-crons.json` hien tai → append entry moi → ghi lai file.
He thong tu dong reload trong vai giay.

## Broadcast nhieu nhom

GroupId cach dau phay, KHONG co khoang trang:
```
"prompt": "exec: openzca msg send 111,222,333 \"Noi dung\" --group"
```

## Sua / Xoa / Tam dung

- **Sua:** Doc file → tim theo `id` → thay doi field → confirm CEO → ghi lai
- **Xoa:** Doc file → loai bo entry → confirm CEO → ghi lai
- **Tam dung:** Set `"enabled": false` (khong xoa)
- MOI thao tac phai confirm CEO truoc

## Luu y

- `id` phai unique, slug (chu thuong, gach ngang, khong dau tieng Viet)
- `label` tieng Viet day du dau, KHONG emoji
- GroupId phai ton tai trong `groups.json`
- File watcher tu detect thay doi — KHONG can restart app
