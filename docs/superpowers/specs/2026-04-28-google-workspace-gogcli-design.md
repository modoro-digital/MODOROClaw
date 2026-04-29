# Google Workspace Integration via gogcli — Design Spec

> Supersedes: `2026-04-10-google-calendar-design.md` (raw OAuth2 approach)

## Goal

Bundle [gogcli](https://github.com/steipete/gogcli) (`gog` binary) into 9BizClaw to give CEO full Google Workspace access — Calendar, Gmail, Drive, Contacts, Tasks — from both Dashboard UI and Telegram/Zalo chat.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Scope | Full suite: Calendar + Gmail + Drive + Contacts + Tasks | gogcli covers all via 1 binary + 1 auth |
| OAuth credentials | Each customer creates own Google Cloud Project | Team MODORO supports setup; no shared quota |
| Binary delivery | Bundle in `vendor/gog/` | Consistent with Node/openclaw/openzca/9router pattern |
| Bot integration | Local HTTP API on port 20200 via `web_fetch` | Reuses cron API pattern; keeps `exec` out of tools.allow |
| API server | Extend existing cron API server (port 20200) | 1 server, shared auth token, localhost-only |
| Dashboard layout | 1 page "Google Workspace" with 5 internal tabs | Keeps sidebar clean |
| Credential storage | OS keychain (gogcli default) | Secure, zero config from app side |
| gogcli config dir | `GOG_CONFIG_DIR` → `<userData>/gog/` | App controls all gogcli state |

## Architecture

```
CEO (Telegram/Zalo)
  → Bot (openclaw agent)
  → web_fetch http://127.0.0.1:20200/api/google/*
  → cron-api.js handler
  → spawn gog CLI (JSON output)
  → return result to bot
  → bot formats reply → CEO

CEO (Dashboard)
  → IPC handler in dashboard-ipc.js
  → google-api.js wrapper
  → spawn gog CLI (JSON output)
  → return to renderer
```

Both paths converge on the same `google-api.js` wrapper module.

## File structure

### New files
- `electron/lib/google-api.js` — spawn wrapper for `gog` CLI. One exported function per operation.
- `electron/lib/google-routes.js` — route handler function for `/api/google/*`, receives `(urlPath, params, req, res, jsonResp)` and branches internally. Follows the same raw `http.createServer` pattern as cron-api.js (no Express).

### Modified files
- `electron/scripts/prebuild-vendor.js` — download + verify `gog` binary per platform/arch
- `electron/scripts/smoke-test.js` — verify `gog` binary exists + version check (Wave 1); add route-level checks per wave
- `electron/lib/cron-api.js` — delegate `/api/google/*` requests to google-routes.js handler; add google status to `tokenFreeEndpoints`
- `electron/lib/dashboard-ipc.js` — add google IPC handlers, delete 8 old `gcal-*` handlers, update `check-all-channels` handler to use `gog auth status` instead of checking `~/.gog/` files
- `electron/preload.js` — add google IPC bridges
- `electron/ui/dashboard.html` — replace page-gcal placeholder with full Google Workspace page
- `electron/packages/modoro-zalo/src/inbound.ts` — add `gog`/`google`/`gmail`/`drive` patterns to COMMAND-BLOCK v3
- `AGENTS.md` — add Google Workspace section with web_fetch examples

### Deleted files
- `electron/gcal/auth.js` — replaced by gogcli auth
- `electron/gcal/calendar.js` — replaced by google-api.js
- `electron/gcal/config.js` — replaced by gogcli config

## Binary bundling

### prebuild-vendor.js additions

```
Platform/arch → binary URL:
  win32/x64   → github.com/steipete/gogcli/releases/download/v0.13.0/gog_windows_amd64.exe
  win32/arm64 → gog_windows_arm64.exe
  darwin/arm64 → gog_darwin_arm64
  darwin/x64   → gog_darwin_amd64

Download → SHA256 verify → place at:
  vendor/gog/gog.exe (Windows)
  vendor/gog/gog     (Mac, chmod +x)
```

**SHA256 checksums:** Must be obtained from the v0.13.0 GitHub release page at implementation time. The implementer downloads each binary once, computes `sha256sum`, and hardcodes the hashes into `prebuild-vendor.js` (same pattern as the Node binary checksums at lines 47-59 of the existing file). Never ship without verified checksums.

**Mac chmod recovery:** `getGogBinaryPath()` in google-api.js checks `fs.accessSync(path, fs.constants.X_OK)` and re-applies `chmod +x` if needed (same pattern as prebuild-vendor.js line 238).

Smoke test: `gog version` exits 0, output contains version string.

## CLI command verification

**All `gog` CLI commands in this spec are based on the v0.13.0 README.** Before Wave 1 implementation begins, the implementer MUST:
1. Download the actual `gog` binary for their platform
2. Run `gog --help`, `gog calendar --help`, `gog gmail --help`, `gog drive --help`, `gog contacts --help`, `gog tasks --help`
3. Verify exact flag names/syntax and update google-api.js accordingly
4. Document any deviations from this spec in the PR description

Command syntax in this spec is best-effort from the README. The `gogExec()` wrapper MUST handle non-JSON stdout gracefully (try JSON.parse, on failure return `{ error: 'Unexpected output', raw: stdout }`).

## Auth flow

### gogcli config directory

All `gog` spawns set `GOG_CONFIG_DIR` to `<userData>/gog/` (e.g., `%APPDATA%/9bizclaw/gog/` on Windows). This ensures:
- Client credentials, config, and any file-backend tokens live under app's control
- No collision with user's personal gogcli install (if any)
- Consistent path across platforms
- Easy to wipe on factory reset

### Setup (one-time, team-assisted)

1. Team creates Google Cloud Project for customer
2. Enables APIs: Calendar, Gmail, Drive, People (Contacts), Tasks
3. Creates OAuth2 Desktop credentials → downloads `client_secret.json`
4. In Dashboard "Google Workspace" tab → Settings sub-tab → "Upload client_secret.json"
5. App copies file to `<userData>/gog/client_secret.json`
6. App runs: `gog auth credentials <path>` (registers with gogcli, one-time)

### Connect account

1. CEO clicks "Ket noi tai khoan Google" button, enters email
2. App runs: `gog auth add <email> --services calendar,gmail,drive,contacts,tasks`
3. This command blocks until OAuth completes — spawn as async child process with 120s timeout
4. Browser opens → Google OAuth consent → CEO approves → gogcli receives callback internally
5. Tokens stored in OS keychain automatically by gogcli
6. App saves email to `<userData>/gog/account.json` for future `GOG_ACCOUNT` env var
7. App verifies: `gog auth status --json` → shows connected account

### Environment

All `gog` spawns include:
```
GOG_CONFIG_DIR=<userData>/gog/   (app-controlled config directory)
GOG_JSON=1                       (always JSON output)
GOG_TIMEZONE=Asia/Ho_Chi_Minh
GOG_ACCOUNT=<email>              (from saved account.json)
```

## google-api.js — CLI wrapper

Core spawn helper:

```javascript
function gogExec(args, timeoutMs = 15000) {
  const gogBin = getGogBinaryPath();
  const env = {
    ...process.env,
    GOG_CONFIG_DIR: path.join(app.getPath('userData'), 'gog'),
    GOG_JSON: '1',
    GOG_TIMEZONE: 'Asia/Ho_Chi_Minh',
    GOG_ACCOUNT: getGogAccount(),
  };
  // execFileSync with { env, timeout: timeoutMs, encoding: 'utf-8' }
  // try JSON.parse(stdout)
  // on parse error: return { error: 'Unexpected output', raw: stdout }
  // on spawn error: throw with descriptive message
}
```

### Calendar operations
- `listEvents(timeMin, timeMax)` → `gog calendar events list --from <> --to <>`
- `createEvent(summary, start, end, attendees)` → `gog calendar events create ...`
- `deleteEvent(eventId)` → `gog calendar events delete <id>`
- `getFreeBusy(timeMin, timeMax)` → `gog calendar freebusy ...`
- `getFreeSlots(date, workStart, workEnd, slotMinutes)` — computed from freebusy

### Gmail operations
- `listInbox(maxResults)` → `gog gmail search --query "in:inbox" --max <n>`
- `readEmail(messageId)` → `gog gmail get <id>`
- `sendEmail(to, subject, body)` → `gog gmail send --to <> --subject <> --body <>`
- `replyEmail(messageId, body)` → `gog gmail reply <id> --body <>`

### Drive operations
- `listFiles(query, maxResults)` → `gog drive ls` or `gog drive search <query>`
- `downloadFile(fileId, destPath)` → `gog drive download <id> <dest>` — destPath validated via `isPathSafe(workspace, destPath)`
- `uploadFile(filePath, folderId)` → `gog drive upload <path> --parent <folder>` — filePath validated: must be under `getWorkspace()` or `getBrandAssetsDir()`
- `shareFile(fileId, email, role)` → `gog drive share <id> --email <> --role <>`

### Contacts operations
- `listContacts(query)` → `gog contacts list` or `gog contacts search <query>`
- `createContact(name, phone, email)` → `gog contacts create ...`

### Tasks operations
- `listTasks(listId)` → `gog tasks list`
- `createTask(listId, title, dueDate)` → `gog tasks add <title> --due <date>`
- `completeTask(taskId)` → `gog tasks done <id>`

## API routes (port 20200)

### Token policy

`/api/google/status` added to `tokenFreeEndpoints` array in cron-api.js — bot needs to check connection status without pre-acquiring a token. All other Google routes require `Authorization: Bearer <cron-api-token>`.

### Route handler pattern

`google-routes.js` exports a single function:
```javascript
module.exports = function handleGoogleRoute(urlPath, params, req, res, jsonResp) {
  // urlPath already stripped of '/api/google' prefix by cron-api.js
  if (urlPath === '/status') { ... }
  else if (urlPath === '/calendar/events') { ... }
  // etc.
}
```

cron-api.js delegates: `if (urlPath.startsWith('/api/google/')) { return handleGoogleRoute(urlPath.slice('/api/google'.length), ...) }`

### Auth
```
GET  /api/google/status              → { connected, email, services[] }
```

### Calendar
```
POST /api/google/calendar/events     → { events[] }    body: { from, to }
POST /api/google/calendar/create     → { event }       body: { summary, start, end, attendees? }
POST /api/google/calendar/delete     → { ok }          body: { eventId }
POST /api/google/calendar/freebusy   → { busy[] }      body: { from, to }
POST /api/google/calendar/free-slots → { slots[] }     body: { date, workStart?, workEnd?, slotMinutes? }
```

### Gmail
```
POST /api/google/gmail/inbox         → { messages[] }  body: { max? }
POST /api/google/gmail/read          → { message }     body: { id }
POST /api/google/gmail/send          → { id }          body: { to, subject, body }
POST /api/google/gmail/reply         → { id }          body: { id, body }
```

### Drive
```
POST /api/google/drive/list          → { files[] }     body: { query?, max? }
POST /api/google/drive/upload        → { file }        body: { path, folderId? }
POST /api/google/drive/share         → { ok }          body: { fileId, email, role }
```

### Contacts
```
POST /api/google/contacts/search     → { contacts[] }  body: { query }
POST /api/google/contacts/create     → { contact }     body: { name, phone?, email? }
```

### Tasks
```
POST /api/google/tasks/list          → { tasks[] }     body: { listId? }
POST /api/google/tasks/create        → { task }        body: { title, due?, listId? }
POST /api/google/tasks/done          → { ok }          body: { taskId }
```

## IPC handlers (dashboard-ipc.js)

New handlers (thin wrappers around google-api.js):
```
google-auth-status        → googleApi.authStatus()
google-upload-credentials → save client_secret.json + gog auth credentials
google-connect            → gog auth add (async, 120s timeout)
google-disconnect         → gog auth remove
google-calendar-events    → googleApi.listEvents(from, to)
google-calendar-create    → googleApi.createEvent(...)
google-calendar-delete    → googleApi.deleteEvent(eventId)
google-calendar-freebusy  → googleApi.getFreeBusy(from, to)
google-calendar-free-slots → googleApi.getFreeSlots(...)
google-gmail-inbox        → googleApi.listInbox(max)
google-gmail-read         → googleApi.readEmail(id)
google-gmail-send         → googleApi.sendEmail(to, subject, body)
google-gmail-reply        → googleApi.replyEmail(id, body)
google-drive-list         → googleApi.listFiles(query, max)
google-drive-upload       → googleApi.uploadFile(path, folderId)
google-drive-share        → googleApi.shareFile(fileId, email, role)
google-contacts-search    → googleApi.listContacts(query)
google-contacts-create    → googleApi.createContact(name, phone, email)
google-tasks-list         → googleApi.listTasks(listId)
google-tasks-create       → googleApi.createTask(listId, title, due)
google-tasks-done         → googleApi.completeTask(taskId)
```

Delete old: `gcal-connect`, `gcal-disconnect`, `gcal-get-status`, `gcal-list-events`, `gcal-get-freebusy`, `gcal-create-event`, `gcal-get-free-slots`, `gcal-get-config`, `gcal-save-config`.

Update: `check-all-channels` handler — replace `~/.gog/token.json` file check with `gog auth status --json` call (via googleApi.authStatus()).

## Dashboard UI

### Sidebar
Replace "Google Calendar" + "Soon" badge → "Google Workspace" (no badge, active when connected).

### Page layout
Single page `page-google` with horizontal tab bar:

```
[Calendar] [Gmail] [Drive] [Contacts] [Tasks] [Settings]
```

Horizontal sub-tabs are a new UI pattern in this dashboard — this sets the precedent for future multi-section pages.

**Settings tab** (always accessible):
- Upload client_secret.json button
- "Ket noi tai khoan Google" button → starts OAuth
- Connection status: email + connected services
- "Ngat ket noi" button

**Calendar tab:**
- Week view list (next 7 days, grouped by date)
- "Tao su kien" button → modal form (summary, date, time, duration, attendees)
- Each event: time, title, attendees count, edit/delete actions

**Gmail tab:**
- Inbox list (20 recent, unread highlighted)
- Click to expand email body (inline, not new page)
- "Soan email" button → modal form (to, subject, body)
- Reply inline

**Drive tab:**
- File browser (list view, breadcrumb navigation)
- Search bar
- Upload button
- Share action per file

**Contacts tab:**
- Search bar + contact list
- Click to see details (name, phone, email)
- "Them lien he" button

**Tasks tab:**
- Task list with checkboxes
- "Them task" inline input
- Filter: all / pending / completed

## AGENTS.md addition

```markdown
## Google Workspace

Bot co the truy cap Google Calendar, Gmail, Drive, Contacts, Tasks cua CEO
qua local API. Dung web_fetch goi http://127.0.0.1:20200/api/google/*.

Header bat buoc: Authorization: Bearer <token tu file cron-api-token.txt>

Vi du:
- "lich tuan nay" → POST /api/google/calendar/events body: {from: "today", to: "+7d"}
- "dat meeting 3pm thu 5" → POST /api/google/calendar/create
- "email moi" → POST /api/google/gmail/inbox
- "gui email cho X noi dung Y" → POST /api/google/gmail/send
- "tim file bao cao" → POST /api/google/drive/list body: {query: "bao cao"}
- "so dien thoai Hung" → POST /api/google/contacts/search body: {query: "Hung"}
- "them task goi khach" → POST /api/google/tasks/create body: {title: "goi khach"}

KHONG BAO GIO gui email hoac tao su kien tu Zalo. Chi thuc hien khi CEO
yeu cau truc tiep qua Telegram. Neu Zalo hoi ve email/lich: tra loi thong
tin nhung KHONG thuc hien hanh dong.

Neu chua ket noi Google: tra loi "Anh chua ket noi Google Workspace.
Mo Dashboard > Google Workspace > Settings de ket noi."
```

## Security

### API layer
- All Google routes (except `/status`) behind `cron-api-token` (48 hex chars, rotated every boot)
- Server binds localhost only (127.0.0.1)

### Zalo COMMAND-BLOCK (inbound.ts)
Add patterns to COMMAND-BLOCK v3 in `electron/packages/modoro-zalo/src/inbound.ts`:
```typescript
/\bgog\b/i,
/\bgoogle\b.*\b(?:calendar|gmail|drive|contacts|tasks|workspace)\b/i,
/\bgmail\b.*\b(?:send|gui|forward|reply|draft)\b/i,
/\bdrive\b.*\b(?:upload|download|share|delete|xoa)\b/i,
/\b(?:gui|send)\s+email\b/i,
/\b(?:tao|dat|book)\s+(?:meeting|lich|su kien|event)\b/i,
```

### Gmail send protection (defense-in-depth)
1. **COMMAND-BLOCK** (code-level): Zalo users cannot even ask about sending email — rawBody rewritten before agent sees it
2. **AGENTS.md** (LLM-level): Bot instructed to never execute Gmail send / calendar create from Zalo context
3. **API route**: `/api/google/gmail/send` checks request context header `X-Source-Channel` — if present and equals `zalo`, returns 403. (cron-api.js sets this header based on the calling context when proxying for the bot)

### Drive path validation
`uploadFile()` and `downloadFile()` validate paths via `isPathSafe(baseDir, path)` from `lib/util.js`. Allowed base directories: `getWorkspace()`, `getBrandAssetsDir()`. Arbitrary path access returns error.

## Error handling

- `gog` not found / not executable → Dashboard shows "Khong tim thay gog. Vui long cai lai app." + auto chmod +x attempt on Mac
- Not authenticated → clear message + link to Settings tab
- Token expired → gogcli auto-refreshes via OS keychain (transparent)
- `gog auth add` timeout (>120s) → cancel process, show "Het thoi gian. Vui long thu lai."
- API timeout → 15s default, return error with retry suggestion
- Google API quota → surface error message from gog stderr
- Non-JSON stdout from gog → return `{ error: 'Unexpected output', raw: stdout }` instead of crash

## Implementation waves

**Wave 1a — Binary + spawn helper:**
- Download + SHA256 verify gog binary in prebuild-vendor.js
- google-api.js with `gogExec()` helper + `authStatus()` + `getGogBinaryPath()`
- Smoke test: gog binary exists + version check
- COMMAND-BLOCK patterns added to inbound.ts

**Wave 1b — Auth + Settings UI:**
- Auth functions in google-api.js (credentials, connect, disconnect)
- google-routes.js with `/status` endpoint
- Mount into cron-api.js
- Dashboard Settings tab (upload credentials, connect, status)
- Delete old `electron/gcal/` directory + 9 old `gcal-*` IPC handlers
- Update `check-all-channels` handler

**Wave 2 — Calendar:**
- Calendar operations in google-api.js
- Calendar API routes in google-routes.js
- Calendar IPC handlers in dashboard-ipc.js + preload bridges
- Calendar Dashboard tab
- AGENTS.md calendar examples

**Wave 3 — Gmail:**
- Gmail operations + routes + IPC + tab
- Gmail send protection (X-Source-Channel check)

**Wave 4 — Drive:**
- Drive operations + routes + IPC + tab
- Path validation for upload/download

**Wave 5 — Contacts + Tasks:**
- Contacts + Tasks operations + routes + IPC + tabs
- Final AGENTS.md update with all service examples

Each wave ships independently with its own commit.
