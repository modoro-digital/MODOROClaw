---
name: channel-control
description: Tạm dừng, tiếp tục kênh Telegram/Zalo và quản lý blocklist
metadata:
  version: 1.0.0
---

# Quan ly kenh lien lac

## Tam dung / Tiep tuc kenh

CEO co the tam dung bat ky kenh nao qua Dashboard hoac Telegram.

| Thao tac | Telegram | Zalo |
|---|---|---|
| Tam dung | Bam "Tam dung" tren Dashboard | Bam "Tam dung" tren Dashboard |
| Tiep tuc | Bam "Tiep tuc" tren Dashboard | Bam "Tiep tuc" tren Dashboard |

Khi kenh tam dung:
- Bot KHONG gui tin qua kenh do
- Tin den van duoc nhan nhung KHONG xu ly
- File `{channel}-paused.json` ghi trang thai
- File bi loi JSON → coi nhu DANG TAM DUNG (fail closed, bao ve CEO)

## Blocklist Zalo

File: `zalo-blocklist.json` — mang userId bi chan.

- CEO them/xoa qua Dashboard tab Zalo
- Bot KHONG tu them vao blocklist (chi DE XUAT khi khach xuc pham 3+ lan)
- Khach trong blocklist → tin den bi drop truoc khi den AI
- Toi da 200 entry

## Stranger policy

File: `zalo-stranger-policy.json`

| Mode | Hanh vi |
|---|---|
| `reply` | Tra loi nguoi la binh thuong |
| `greet-only` | Chi chao, khong tra loi cau hoi |
| `ignore` | Im lang voi nguoi la |

## Bot KHONG duoc tu y

- KHONG tu dung kenh khi khong co lenh CEO
- KHONG tu them nguoi vao blocklist
- KHONG tu doi stranger policy
- Moi thay doi phai qua Dashboard hoac CEO xac nhan qua Telegram
