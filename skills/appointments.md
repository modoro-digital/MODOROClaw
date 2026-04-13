# Quản lý lịch hẹn cho CEO

File `workspace/appointments.json` (array). Dispatcher tick 60s. CHỈ CEO được tạo/sửa/xóa.

## Schema

```json
{"id":"apt_<ms>_<rand>","title":"Họp anh Minh","customerName":"Anh Minh","phone":"09xx",
"start":"2026-04-12T15:00:00+07:00","end":"2026-04-12T16:00:00+07:00",
"meetingUrl":"https://zoom.us/j/...","location":"","note":"",
"reminderMinutes":15,"reminderChannels":["telegram"],
"pushTargets":[{"channel":"zalo_group","toId":"<groupId>","toName":"<tên>","atTime":"08:00","daily":true,"template":"Sáng nay có {title} lúc {startHHMM}. Link: {meetingUrl}"}],
"status":"scheduled","reminderFiredAt":null,"pushedAt":{},"createdBy":"telegram","createdAt":"<ISO>"}
```

**Timezone BẮT BUỘC:** `YYYY-MM-DDTHH:MM:SS+07:00`. KHÔNG dùng `Z`. Không chắc ngày → HỎI CEO.

**Placeholders:** `{title}`, `{customerName}`, `{phone}`, `{meetingUrl}`, `{startHHMM}`, `{startDate}`.

## Tạo

Parse NLP → fields. Đọc file (nếu chưa có → `[]`). Append + ghi (indent 2). Confirm CEO: title, time, reminder, push targets.

**Push target Zalo:** Đọc `~/.openzca/profiles/default/groups.json`. Normalize accent-insensitive. 1 match → auto-fill + confirm CEO. Nhiều → list 2-3, chờ chọn. 0 → báo không tìm thấy, KHÔNG đoán groupId.

## Sửa / Xóa / List

- **Sửa giờ:** Dùng IPC `update-appointment` để engine reset `reminderFiredAt/pushedAt`. Không có IPC: tự set `null/{}`.
- **Nhiều match:** hỏi CEO trước. **Hủy:** `status:"canceled"`. **Xóa:** filter bỏ array.
- **List:** filter date VN timezone, bullet ngắn.

## Quy tắc

1. Khách xin đặt → escalate, KHÔNG tự ghi. 2. id `apt_<ms>_<rand>`. 3. `+07:00` bắt buộc — sai → fire nhầm. 4. Fuzzy match accent-insensitive, KHÔNG đoán groupId. 5. Confirm sau ghi. 6. KHÔNG touch `reminderFiredAt/pushedAt/status`. 7. KHÔNG nhắc file/JSON trong reply CEO.
