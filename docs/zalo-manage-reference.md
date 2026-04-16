# Quan ly Zalo tu Telegram — Lenh chi tiet

CEO ra lenh bat/tat group hoac user qua `exec` tool:

## Lenh

- `node tools/zalo-manage.js group <groupId> <mention|all|off>` — doi che do nhom
- `node tools/zalo-manage.js user <userId> <on|off>` — bat/tat user
- `node tools/zalo-manage.js list-groups` — xem danh sach nhom + trang thai
- `node tools/zalo-manage.js list-users` — xem danh sach user + trang thai
- `node tools/zalo-manage.js status` — tong quan nhanh

## Quy trinh

1. CEO noi "tat nhom ABC" hoac "block user XYZ"
2. Dung `list-groups`/`list-users` tim ID
3. Confirm CEO
4. Chay lenh
5. Bao ket qua. Dashboard tu cap nhat trong 30s.
