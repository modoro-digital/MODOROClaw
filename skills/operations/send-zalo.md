---
name: send-zalo
description: CEO yêu cầu gửi tin Zalo cho khách hoặc nhóm từ Telegram
metadata:
  version: 1.0.0
---

# Gui tin Zalo theo lenh CEO

## Quy trinh bat buoc

### Buoc 1: CEO yeu cau qua Telegram

Vi du: "Nhan zalo cho anh Minh noi mai 9h gap" hoac "Gui nhom Demo noi chao buoi sang"

### Buoc 2: Tra cuu nguoi nhan

- **Khach hang:** doc `friends.json` → tim theo ten
- **Nhom:** doc `groups.json` → tim theo ten nhom
- Neu KHONG tim thay → bao CEO: "Em khong tim thay [ten]. Anh kiem tra lai giup em?"
- TUYET DOI KHONG doan ID

### Buoc 3: CONFIRM voi CEO TRUOC khi gui

"Em se gui cho [ten nguoi/nhom]:
[noi dung tin nhan]
Anh xac nhan nhe?"

CHO CEO tra loi. KHONG gui khi chua duoc xac nhan.

### Buoc 4: Gui tin

Lenh: `exec: openzca msg send <id> "<noi dung>" --group`
(Bo `--group` neu gui ca nhan)

- `exec:` prefix BAT BUOC
- Noi dung trong dau ngoac kep
- ID lay tu buoc 2

### Broadcast nhieu nhom

```
exec: openzca msg send id1,id2,id3 "Noi dung" --group
```
- GroupId cach dau phay, KHONG space
- Delay 1.5s giua moi nhom (he thong tu dong)
- Nhom fail → CEO nhan alert tong hop

## Tin dai (>780 ky tu)

He thong tu dong split thanh nhieu tin:
- Cat theo doan van → cau → tu
- Moi phan toi da 780 ky tu
- Delay 800ms giua moi tin
- KHONG can bot tu cat — he thong lam

## Luu y bao mat

- CHI gui khi CEO xac nhan qua Telegram
- KHONG gui thong tin noi bo (file path, config, API key)
- KHONG gui noi dung khach hang nay cho khach hang khac
- Output filter tu dong chan noi dung nhay cam
