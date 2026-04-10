# Google Calendar Integration — Design Spec

## Mục tiêu

Khách đặt lịch qua Zalo/Messenger → bot check lịch trống CEO → đề xuất slot → khách chọn → bot tạo event → hiện trên Dashboard calendar.

## 3 tầng

### Tầng 1: Calendar embed trong Dashboard (read-only view)
- Tab mới "Lịch hẹn" trong sidebar (hoặc sub-section trong Tổng quan)
- `<webview>` embed Google Calendar agenda view
- CEO nhìn thấy lịch hẹn ngay trong app, không cần mở browser

### Tầng 2: API — bot check slot + tạo event
- OAuth2 login: CEO đăng nhập Google 1 lần → token persist
- `freebusy/query`: check CEO rảnh khi nào (next 7 ngày, giờ làm 8-18h)
- `events.insert`: tạo event khi khách confirm slot
- `events.list`: list upcoming events cho Dashboard

### Tầng 3: Bot tự động đặt lịch
- Khách nói "muốn hẹn" → bot hỏi ngày/giờ preference
- Bot check freebusy → đề xuất 2-3 slot rảnh gần nhất
- Khách chọn → bot tạo event → xác nhận khách
- CEO nhận notification Google Calendar tự động

## Flow chi tiết

```
Khách Zalo: "Em muốn đặt lịch tư vấn"
Bot: "Dạ anh muốn hẹn khoảng ngày nào ạ?"
Khách: "Thứ 5 hoặc thứ 6 tuần này"
Bot: [check freebusy thứ 5 + thứ 6]
Bot: "Dạ bên em còn trống:
     - Thứ 5, 10:00 - 10:30
     - Thứ 5, 14:00 - 14:30
     - Thứ 6, 09:00 - 09:30
     Anh chọn khung giờ nào ạ?"
Khách: "14h thứ 5"
Bot: [tạo event: "Tư vấn — Khách Nguyễn Huy", 14:00-14:30 thứ 5]
Bot: "Dạ em đã đặt lịch hẹn thứ 5 lúc 14:00 ạ. Anh sẽ nhận 
     thông báo nhắc trước 15 phút. Cảm ơn anh!"
→ CEO nhận Google Calendar notification
→ Dashboard calendar hiện event mới
```

## Architecture

```
electron/
├── gcal/
│   ├── auth.js       ← OAuth2 flow, token persist, auto-refresh
│   ├── calendar.js   ← freebusy, events.insert, events.list
│   └── config.js     ← working hours, slot duration, calendar ID
├── main.js           ← IPC handlers + embed webview
└── ui/dashboard.html ← Calendar tab/section
```

## OAuth2 Flow

1. CEO click "Kết nối Google" trong Dashboard
2. Open BrowserWindow → Google OAuth consent screen
3. Scopes: `calendar.readonly` + `calendar.events`
4. Redirect → exchange code → access_token + refresh_token
5. Store tokens in `~/.openclaw/gcal-tokens.json` (encrypted via safeStorage)
6. Auto-refresh khi token hết hạn (1h default)

**Cần Google Cloud Project:**
- MODORO tạo 1 project trên console.cloud.google.com
- Enable Calendar API
- Create OAuth2 credentials (Web application type)
- Client ID + Secret hardcode trong app (hoặc config)
- App ở "Testing" mode ban đầu (chỉ CEO được add vào test users)
- Production publish cần Google review (2-4 tuần)

## Config

```json
// gcal-config.json (trong workspace)
{
  "connected": true,
  "calendarId": "primary",
  "workingHours": { "start": "08:00", "end": "18:00" },
  "slotDurationMinutes": 30,
  "daysAhead": 7,
  "reminderMinutes": 15
}
```

CEO config giờ làm trong Dashboard. Bot dùng để filter slots.

## IPC Handlers

| IPC | Input | Output |
|-----|-------|--------|
| gcal-connect | — | Opens OAuth window |
| gcal-disconnect | — | Clears tokens |
| gcal-get-status | — | {connected, email} |
| gcal-get-freebusy | {dateFrom, dateTo} | {busy: [{start, end}], free: [{start, end}]} |
| gcal-create-event | {summary, start, end, description} | {success, eventId, htmlLink} |
| gcal-list-events | {maxResults?} | events[] |
| gcal-get-config | — | gcal-config.json |
| gcal-save-config | {workingHours, slotDuration, ...} | {success} |

## Dashboard UI

### Option A: Tab riêng "Lịch hẹn"
```
ĐIỀU KHIỂN
  Tổng quan
  Lịch tự động
  Tài liệu
  Lịch hẹn            ← mới
```

### Option B: Section trong Overview
Overview page thêm card "Lịch hẹn hôm nay" bên cạnh "Khách Zalo gần đây".

**Recommend A** — tab riêng vì có cả config (giờ làm, slot duration) + calendar embed.

Tab content:
```
+----------------------------------------------------------+
| Lịch hẹn                       [Kết nối Google Calendar] |
| Quản lý lịch hẹn với khách                               |
+----------------------------------------------------------+
|                                                          |
| ┌── Calendar embed (webview) ──────────────────────────┐ |
| │                                                      │ |
| │   Google Calendar agenda/week view                   │ |
| │   (read-only, auto-refresh)                          │ |
| │                                                      │ |
| └──────────────────────────────────────────────────────┘ |
|                                                          |
| Cài đặt                                                 |
| Giờ làm việc: [08:00] đến [18:00]                       |
| Thời lượng mỗi slot: [30 phút ▼]                        |
| Nhắc trước: [15 phút ▼]                                 |
|                                                          |
| Lịch hẹn sắp tới                                        |
| - Thứ 5, 14:00 — Tư vấn — Nguyễn Huy (Zalo)           |
| - Thứ 6, 10:00 — Demo SP — Lê Thảo (Zalo)             |
+----------------------------------------------------------+
```

## AGENTS.md update

```markdown
### Đặt lịch hẹn — tự động qua Google Calendar

Khách muốn hẹn → bot check lịch trống CEO:
1. Hỏi ngày preference: "Anh muốn hẹn khoảng ngày nào ạ?"
2. Check freebusy → đề xuất 2-3 slot: "Bên em còn trống: ..."
3. Khách chọn → tạo event: "Dạ em đã đặt lịch hẹn [ngày] lúc [giờ] ạ."

Nếu Google Calendar chưa kết nối → fallback flow cũ (hỏi + ghi note + chuyển CEO).
```

## Dependencies

- `googleapis` npm package (~5MB) — Google official Node.js client
- Hoặc: raw HTTP calls tới `googleapis.com/calendar/v3/*` (no extra dep, nhưng phải handle OAuth manually)

**Recommend raw HTTP** — tránh thêm dependency lớn. OAuth2 + Calendar API chỉ cần 4 endpoints, dùng Node built-in `https.request` đủ.

## Phases

| Phase | What | Effort |
|---|---|---|
| 1 | OAuth2 login + token persist + calendar embed | 3h |
| 2 | freebusy check + create event + list events | 2h |
| 3 | Bot auto-booking flow (AGENTS.md + bot tự gọi API) | 1h |
| 4 | Dashboard tab UI (config + upcoming list) | 2h |

Total: ~8h

## Không làm
- ~~Sync 2 chiều~~ — chỉ read calendar + create events
- ~~Multiple calendars~~ — chỉ primary calendar
- ~~Recurring events~~ — chỉ one-time
- ~~Google Meet link~~ — Phase 2 nếu cần
