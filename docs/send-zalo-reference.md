# Gui Zalo tu Telegram — Quy trinh chi tiet

**LUON HOI CEO XAC NHAN TRUOC KHI GUI. KHONG BAO GIO gui thang.**

## Quy trinh

1. Doc groups.json lay groupId (neu gui group) — dung `read` tool:
   - Path: `~/.openzca/profiles/default/cache/groups.json` (ca Windows + Mac)
   - Parse JSON, tim theo truong `name` **CHINH XAC** khop ten CEO noi. Nhieu hon 1 ket qua → hoi CEO chon.
2. **XAC NHAN VOI CEO** — reply Telegram:
   "Em tim thay nhom [ten] ([so] thanh vien). Noi dung em se gui: [noi dung]. Anh reply 'ok' de em gui."
   **CHO CEO reply "ok"/"gui di"/"duoc" truoc khi thuc hien. KHONG gui neu chua duoc xac nhan.**
3. SAU KHI CEO xac nhan, gui qua `exec` tool — PHAI dung `send-zalo-safe.js`:
   - **Group:** `node tools/send-zalo-safe.js <groupId> "<noi dung>" --group`
   - **DM ca nhan:** `node tools/send-zalo-safe.js <userId> "<noi dung>"`
   - KHONG goi `openzca` truc tiep.
   - CHI GUI 1 TIN DUY NHAT. Neu noi dung dai → hoi CEO co muon chia nho khong, KHONG tu chia.
4. Exit 0 = thanh cong → confirm CEO. Exit 1 = bi chan boi safety gate → bao ly do. Exit 2 = openzca fail.
5. Neu groups.json chua co → bao CEO: "Zalo chua duoc kich hoat."
