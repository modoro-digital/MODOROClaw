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

Bot KHÔNG ĐƯỢC ghi trực tiếp vào file config (`zalo-blocklist.json`, `zalo-group-settings.json`, v.v.). Mọi thay đổi phải qua Dashboard.

Khi CEO yêu cầu (bật/tắt nhóm, block user):

1. Tra cứu ID theo mục trên
2. Confirm CEO: "Em tìm thấy [nhóm ABC / user XYZ]. Anh vào Dashboard > Zalo > [Bạn bè / Nhóm] để thay đổi nhé."
3. Nếu CEO hỏi lại → nhắc: "Vì lý do bảo mật, chỉ Dashboard mới thay đổi được blocklist và cài đặt nhóm."

## Lưu ý

- Nếu `groups.json` hoặc `friends.json` chưa có → báo CEO: "Zalo chưa được kích hoạt hoặc chưa quét danh bạ."
- Tối đa 200 user trong blocklist. Nếu đã đủ → báo CEO.
