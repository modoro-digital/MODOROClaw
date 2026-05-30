# Bài Học — Self-Improving Agent

Bot ghi lại bài học từ sai lầm và phản hồi của CEO để ngày càng thông minh hơn.

## Format

### [YYYY-MM-DD] ID: L-001 | Area: [khu vực] | Priority: [high/medium/low]
**Tình huống:** [Mô tả]
**Sai lầm:** [Bot đã làm gì sai]  
**Bài học:** [Rút ra được gì]
**Trạng thái:** active | promoted | archived

---

### [2026-04-06] ID: L-001 | Area: cron/scheduling | Priority: high
**Tình huống:** CEO yêu cầu tạo cronjob nhắc nhở định kỳ
**Sai lầm:** Dùng lệnh CLI `openclaw cron add` hoặc bất kỳ lệnh `openclaw cron` nào → lỗi "gateway closed (1008): pairing required"
**Bài học:** KHÔNG BAO GIỜ dùng `openclaw cron add/remove/list` qua Bash/CLI. Thay vào đó, **ghi trực tiếp vào file `custom-crons.json`** trong workspace. Ứng dụng tự phát hiện thay đổi file và kích hoạt cron. Xem AGENTS.md mục "Tạo nhắc nhở / cron theo yêu cầu CEO" để biết format JSON.
**Trạng thái:** active

### [2026-04-06] ID: L-002 | Area: error-handling | Priority: high
**Tình huống:** Bot gặp lỗi kỹ thuật (pairing, gateway closed)
**Sai lầm:** Báo lỗi kỹ thuật cho CEO kèm hướng dẫn chạy lệnh terminal
**Bài học:** KHÔNG BAO GIỜ hiển thị lỗi kỹ thuật cho CEO. CEO không phải kỹ thuật viên. Nếu gặp lỗi, dùng phương án thay thế (ghi file) hoặc báo "Em sẽ xử lý, anh chờ chút ạ" — không bao giờ yêu cầu CEO chạy lệnh terminal.
**Trạng thái:** active

### [2026-04-07] ID: L-003 | Area: cron/verification | Priority: critical
**Tình huống:** CEO yêu cầu gộp/sửa cron → bot trả lời "đã làm xong" nhưng thực tế KHÔNG ghi file nào
**Sai lầm:** Báo success mà không verify. CEO kiểm tra file thấy không đổi → mất lòng tin
**Bài học:** Sau MỖI lần ghi `schedules.json` hoặc `custom-crons.json`, BẮT BUỘC đọc lại file để verify nội dung đã thay đổi đúng. Chỉ báo "✅ đã xong" KHI đã verify. Nếu ghi thất bại → báo CEO trung thực.
**Trạng thái:** active

### [2026-04-07] ID: L-004 | Area: cron/fixed-schedules | Priority: high
**Tình huống:** CEO muốn đổi giờ "Báo cáo sáng" (fixed schedule) từ 07:30 → 08:30
**Sai lầm:** Bot không biết fixed schedules nằm ở `schedules.json` trong workspace, chỉ biết `custom-crons.json`
**Bài học:** Có 2 file cron: `schedules.json` (morning/evening/heartbeat/meditation — chỉ sửa `time` và `enabled`) và `custom-crons.json` (custom do CEO tạo mới). Xem AGENTS.md mục "Lịch tự động & Nhắc nhở".
**Trạng thái:** active

### [2026-04-07] ID: L-005 | Area: cron/status-check + error-handling | Priority: critical
**Tình huống:** Cron không chạy đúng giờ, hoặc CEO hỏi "cron có hoạt động không"
**Sai lầm:** Bot chạy `openclaw cron list` và `openclaw gateway status` qua Bash → lệnh treo (vì CLI này cần gateway session, không chạy được từ bot agent) → bot báo CEO "gateway có thể bị treo, anh có muốn restart không?"
**Bài học (cực kỳ quan trọng):**
1. KHÔNG BAO GIỜ chạy CLI `openclaw cron list/status/restart/config`. Các lệnh này sẽ treo hoặc báo lỗi pairing.
2. Để biết cron nào đang active: ĐỌC `schedules.json` và `custom-crons.json` — entry `enabled: true` = đang chạy.
3. Nếu cron không trigger đúng giờ → đó là lỗi KỸ THUẬT của ứng dụng, không phải việc của bot. Ghi vào `.learnings/ERRORS.md` và IM LẶNG.
4. KHÔNG BAO GIỜ hỏi CEO "anh có muốn restart không" — CEO không phải dev, câu hỏi này vô nghĩa với họ và vi phạm L-002.
5. Nếu CEO hỏi về trạng thái cron, chỉ nói: "Lịch hiện tại: [list từ schedules.json]. Em sẽ báo lại nếu có gì bất thường."
**Trạng thái:** active

### [2026-04-07] ID: L-006 | Area: cron/fixed-bugs — KHÔNG báo lại | Priority: critical
**Tình huống:** Trong daily summary và báo cáo cuối ngày 7/4/2026, bot lặp lại trong "việc tồn đọng": *"🔴 Fix cron handler bug | Cần team dev sửa"* — nghĩa là cron gửi raw prompt thay vì chạy qua agent.
**Sai lầm:** Bug ĐÃ ĐƯỢC FIX vĩnh viễn trong cùng ngày 7/4/2026 với layered defense Path B v2 (4 layers: boot ordering + inline heal + heal-and-retry trên Config-invalid + robust openclaw.mjs resolver). Nhưng vì bot đọc lại session history JSONL của chính nó, nó copy-forward entry cũ và tiếp tục báo cáo bug như đang tồn tại. CEO mất lòng tin vào bộ nhớ bot.
**Bài học:**
1. **Cron handler bug đã fix vĩnh viễn ngày 2026-04-07.** KHÔNG bao giờ liệt kê "Fix cron handler bug", "cron gửi raw prompt", hay bất kỳ dạng nào của bug này vào "việc tồn đọng" / "vấn đề chưa xử lý" / "cần team dev sửa" trong daily summary nữa. Coi như đã đóng case.
2. **Cách verify trước khi báo cáo:** click "Test" trên custom cron trong Dashboard → Telegram nhận được summary thật (output của agent), không phải prompt text → cron handler đang hoạt động đúng. Hoặc đọc `logs/cron-runs.jsonl` — có dòng `phase:"ok"` = OK, dòng `phase:"fail"` mới = có vấn đề thật.
3. **Nguyên tắc tổng quát (áp dụng cho MỌI bug đã fix, không chỉ cron handler):** Trước khi liệt kê bất kỳ bug nào vào "việc tồn đọng", phải verify bug đó VẪN còn (đọc file/log/code state hiện tại), KHÔNG dựa vào session history cũ. Memory cũ có thể stale; ground truth là state hiện tại của code, config, và logs.
4. **Format mới khi báo cáo daily summary:** mục "việc tồn đọng" CHỈ liệt kê việc CEO chưa hoàn thành (vd: điền COMPANY.md, PRODUCTS.md, lịch họp chưa confirm). KHÔNG tự ý thêm "bugs cần dev sửa" trừ khi CEO chủ động hỏi hoặc `.learnings/ERRORS.md` có entry MỚI trong vòng 24h. Nếu cần báo bug, ghi vào ERRORS.md trước rồi mới đề cập với CEO.
**Trạng thái:** active
