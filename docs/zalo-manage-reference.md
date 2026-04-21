# Quản lý Zalo từ Telegram — Lệnh chi tiết

## Tra cứu nhóm / người dùng

Bot KHÔNG dùng `exec` tool. Tra cứu bằng cách **đọc file trực tiếp**:

### Tìm group ID

1. Ưu tiên đọc `~/.openzca/profiles/default/cache/groups.json` — mảng JSON có `groupId`, `name`, `memberCount`
2. Nếu cache chưa có, đọc thư mục `memory/zalo-groups/` — mỗi file `<groupId>.md` có frontmatter `name:`

**Ví dụ CEO hỏi "group id của nhóm ABC":**
- Đọc `groups.json`, parse JSON, tìm trường `name` khớp/gần giống "ABC"
- Nếu nhiều kết quả → hỏi CEO chọn
- Trả lời CEO: "Nhóm ABC có ID là 1234567890123456789"

### Tìm user ID

1. Ưu tiên đọc `~/.openzca/profiles/default/cache/friends.json` — mảng JSON có `userId`, `displayName`, `zaloName`
2. Nếu cache chưa có, đọc thư mục `memory/zalo-users/` — mỗi file `<senderId>.md` có frontmatter `name:`, `zaloName:`

## Thay đổi cài đặt nhóm/user

Khi CEO yêu cầu thay đổi (bật/tắt nhóm, block user):

1. Đọc file cài đặt hiện tại:
   - Nhóm: `zalo-group-settings.json` trong workspace — JSON object `{"<groupId>": {"mode": "off"|"mention"|"all"}}`
   - User: `zalo-blocklist.json` trong workspace — JSON array `[{"id":"<userId>","name":"..."}]`
2. **Chỉ thay đổi entry liên quan**, giữ nguyên các entry khác. KHÔNG ghi đè toàn bộ file.
3. Confirm CEO trước khi ghi: "Em sẽ [tắt nhóm ABC / block user XYZ]. Anh confirm?"
4. Ghi JSON bằng `write_file` tool. Đảm bảo JSON hợp lệ (có thể dùng `JSON.stringify` nếu cần).
5. Dashboard tự cập nhật trong 30 giây.

## Quy trình

1. CEO nói "tắt nhóm ABC" hoặc "block user XYZ"
2. Tra cứu ID theo mục trên
3. Đọc file config hiện tại
4. Confirm CEO
5. Ghi file config (merge, không ghi đè)
6. Báo kết quả: "Đã [tắt nhóm ABC / block user XYZ]."

## Lưu ý

- Nếu `groups.json` hoặc `friends.json` chưa có → báo CEO: "Zalo chưa được kích hoạt hoặc chưa quét danh bạ."
- Tối đa 200 user trong blocklist. Nếu đã đủ → báo CEO.
