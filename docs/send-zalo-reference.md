# Gửi Zalo từ Telegram — Quy trình chi tiết

**LUÔN HỎI CEO XÁC NHẬN TRƯỚC KHI GỬI. KHÔNG BAO GIỜ gửi thẳng.**

## Quy trình

1. Đọc groups.json lấy groupId (nếu gửi group) — dùng `read` tool:
   - Path: `~/.openzca/profiles/default/cache/groups.json` (cả Windows + Mac)
   - Parse JSON, tìm theo trường `name` **CHÍNH XÁC** khớp tên CEO nói.
   - CEO nói nhiều nhóm → tìm tất cả groupId tương ứng. Nhiều hơn 1 kết quả cho 1 tên → hỏi CEO chọn.
2. **XÁC NHẬN VỚI CEO** — reply Telegram:
   - 1 nhóm: "Em tìm thấy nhóm [tên] ([số] thành viên). Nội dung em sẽ gửi: [nội dung]. Anh reply 'ok' để em gửi."
   - Nhiều nhóm: "Em tìm thấy [N] nhóm: [tên1] ([số1] TV), [tên2] ([số2] TV), ... Nội dung gửi chung: [nội dung]. Anh reply 'ok' để em gửi [N] nhóm."
   - **CHỜ CEO reply "ok"/"gửi đi"/"được" trước khi thực hiện. KHÔNG gửi nếu chưa được xác nhận.**
3. SAU KHI CEO xác nhận, gửi qua `exec` tool — PHẢI dùng `send-zalo-safe.js`:
   - **Group:** `node tools/send-zalo-safe.js <groupId> "<nội dung>" --group`
   - **DM cá nhân:** `node tools/send-zalo-safe.js <userId> "<nội dung>"`
   - KHÔNG gọi `openzca` trực tiếp.
   - **Nhiều nhóm:** gọi `exec` tool TỪNG NHÓM MỘT, mỗi lần 1 groupId. Gửi xong nhóm này → gửi nhóm kế tiếp. Báo kết quả tổng hợp sau khi hoàn tất tất cả.
   - **Broadcast (cron):** `exec: openzca msg send <id1>,<id2>,<id3> "nội dung" --group` — gửi cùng nội dung vào nhiều nhóm, cách nhau dấu phẩy. Delay 1.5s giữa mỗi nhóm. Nếu có nhóm fail → CEO nhận alert tổng hợp.
   - **Nội dung dài:** KHÔNG tự chia nhỏ. Hỏi CEO "Nội dung dài [N] ký tự, anh muốn em chia nhỏ không?" và CHỜ xác nhận.
4. Exit 0 = thành công. Exit 1 = bị chặn bởi safety gate → báo lý do cho CEO. Exit 2 = openzca fail.
5. Nếu groups.json chưa có → báo CEO: "Zalo chưa được kích hoạt."
6. **Báo kết quả:**
   - 1 nhóm: "Đã gửi thành công vào nhóm [tên]."
   - Nhiều nhóm: "Đã gửi [M]/[N] nhóm thành công." Nếu có nhóm fail → liệt kê cụ thể nhóm nào fail và lý do.
