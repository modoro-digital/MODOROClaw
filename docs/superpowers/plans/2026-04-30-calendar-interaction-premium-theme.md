# Calendar Interaction and Premium Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build normal Google Calendar interaction in the dashboard and apply the Executive Graphite premium theme.

**Architecture:** Backend adds a calendar update route/IPC bridge around existing `gog calendar update`. Frontend keeps FullCalendar, adds event edit/delete/drag/resize/select flows, and updates global dashboard CSS tokens/shared selectors for a premium SaaS look.

**Tech Stack:** Electron, plain HTML/CSS/JS, FullCalendar, local Google API wrapper, gogcli v0.13.0, Node guard scripts.

---

## File Map

- Modify: `electron/lib/google-api.js`
  - Add `updateEvent(eventId, updates, calendarId)`.
  - Export `updateEvent`.
- Modify: `electron/lib/google-routes.js`
  - Add `/calendar/update` route.
- Modify: `electron/lib/dashboard-ipc.js`
  - Add `google-calendar-update` IPC handler.
- Modify: `electron/preload.js`
  - Expose `googleCalendarUpdate`.
- Modify: `electron/ui/dashboard.html`
  - Add interactive calendar UI and Executive Graphite theme CSS.
- Create: `electron/scripts/check-google-calendar-route.js`
  - Guard route/IPC/preload/UI integration.
- Modify: `electron/package.json`
  - Add `guard:google-calendar`.
  - Add it to `guard:architecture`.
- Modify generated: `docs/generated/system-map.json`, `docs/generated/system-map.txt`
  - Regenerate after route/IPC changes.

## Task 1: Calendar Backend Update Capability

**Files:**
- Modify: `electron/lib/google-api.js`
- Modify: `electron/lib/google-routes.js`
- Modify: `electron/lib/dashboard-ipc.js`
- Modify: `electron/preload.js`
- Create: `electron/scripts/check-google-calendar-route.js`
- Modify: `electron/package.json`

- [ ] **Step 1: Write failing guard**

Create `electron/scripts/check-google-calendar-route.js` with checks for these exact strings:

```js
#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = {
  api: path.join(root, 'lib', 'google-api.js'),
  routes: path.join(root, 'lib', 'google-routes.js'),
  ipc: path.join(root, 'lib', 'dashboard-ipc.js'),
  preload: path.join(root, 'preload.js'),
  dashboard: path.join(root, 'ui', 'dashboard.html'),
};

const failures = [];
const read = file => fs.readFileSync(file, 'utf8');
const assertIncludes = (name, text, needle) => {
  if (!text.includes(needle)) failures.push(`${name}: missing ${needle}`);
};

const api = read(files.api);
const routes = read(files.routes);
const ipc = read(files.ipc);
const preload = read(files.preload);
const dashboard = read(files.dashboard);

assertIncludes('google-api updateEvent function', api, 'async function updateEvent(');
assertIncludes('google-api gog calendar update', api, "'calendar', 'update'");
assertIncludes('google-api export updateEvent', api, 'updateEvent,');
assertIncludes('google-routes calendar update route', routes, "urlPath === '/calendar/update'");
assertIncludes('dashboard-ipc update handler', ipc, "ipcMain.handle('google-calendar-update'");
assertIncludes('preload update bridge', preload, 'googleCalendarUpdate:');
assertIncludes('dashboard editable calendar', dashboard, 'editable: true');
assertIncludes('dashboard selectable calendar', dashboard, 'selectable: true');
assertIncludes('dashboard eventDrop handler', dashboard, 'eventDrop: handleCalEventDropOrResize');
assertIncludes('dashboard eventResize handler', dashboard, 'eventResize: handleCalEventDropOrResize');
assertIncludes('dashboard date select handler', dashboard, 'select: handleCalDateSelect');
assertIncludes('dashboard edit modal', dashboard, 'cal-edit-modal');
assertIncludes('dashboard edit save', dashboard, 'submitCalEdit');
assertIncludes('dashboard edit delete', dashboard, 'deleteCalEditEvent');
assertIncludes('dashboard theme', dashboard, 'Executive Graphite');

if (failures.length) {
  console.error('[google-calendar-route] FAIL');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}

console.log('[google-calendar-route] PASS calendar update route and interactive UI wiring');
```

- [ ] **Step 2: Run guard and verify red**

Run:

```text
npm run guard:google-calendar
```

Expected: command missing before package script is added, or script fails with missing update route/UI wiring after script is added.

- [ ] **Step 3: Implement `updateEvent`**

In `electron/lib/google-api.js`, add after `createEvent(...)`:

```js
async function updateEvent(eventId, updates, calendarId) {
  const args = ['calendar', 'update', calendarId || 'primary', eventId];
  const opts = updates || {};
  if (opts.summary !== undefined) args.push('--summary', String(opts.summary));
  if (opts.start !== undefined) args.push('--from', String(opts.start));
  if (opts.end !== undefined) args.push('--to', String(opts.end));
  if (opts.description !== undefined) args.push('--description', String(opts.description));
  if (opts.location !== undefined) args.push('--location', String(opts.location));
  if (opts.attendees !== undefined) {
    const attendees = Array.isArray(opts.attendees) ? opts.attendees.join(',') : String(opts.attendees || '');
    args.push('--attendees', attendees);
  }
  args.push('--send-updates', opts.sendUpdates || 'none');
  return gogExec(args, 30000);
}
```

Export `updateEvent` beside `createEvent` and `deleteEvent`.

- [ ] **Step 4: Add local API route**

In `electron/lib/google-routes.js`, after `/calendar/create`, add:

```js
if (urlPath === '/calendar/update') {
  if (!params.eventId) return jsonResp(res, 400, { error: 'eventId required' });
  const updates = {
    summary: params.summary,
    start: params.start,
    end: params.end,
    description: params.description,
    location: params.location,
    attendees: params.attendees,
    sendUpdates: params.sendUpdates,
  };
  const hasUpdate = Object.entries(updates).some(([key, value]) => key !== 'sendUpdates' && value !== undefined);
  if (!hasUpdate) return jsonResp(res, 400, { error: 'at least one update field required' });
  const r = await googleApi.updateEvent(params.eventId, updates, params.calendarId);
  return jsonResp(res, 200, r);
}
```

- [ ] **Step 5: Add IPC and preload bridge**

In `electron/lib/dashboard-ipc.js`, after `google-calendar-create`, add:

```js
ipcMain.handle('google-calendar-update', async (_ev, opts) => {
  try {
    if (!opts?.eventId) return { error: 'eventId required' };
    const r = await googleApi.updateEvent(opts.eventId, opts, opts.calendarId);
    try { auditLog('google_calendar_update', { eventId: opts.eventId, summary: opts.summary }); } catch {}
    return r;
  } catch (e) { return { error: e.message }; }
});
```

In `electron/preload.js`, expose:

```js
googleCalendarUpdate: (opts) => ipcRenderer.invoke('google-calendar-update', opts),
```

- [ ] **Step 6: Wire guard script**

In `electron/package.json`, add:

```json
"guard:google-calendar": "node scripts/check-google-calendar-route.js"
```

Add `npm run guard:google-calendar` into `guard:architecture` after `guard:google-sheets`.

- [ ] **Step 7: Run guard**

Run:

```text
npm run guard:google-calendar
```

Expected: still fails until Task 2 UI wiring is complete.

## Task 2: Interactive Calendar UI and Premium Theme

**Files:**
- Modify: `electron/ui/dashboard.html`

- [ ] **Step 1: Add edit modal markup**

Under the existing create event modal in `#gw-calendar`, add a modal with id `cal-edit-modal`. It must include inputs:

```text
cal-edit-id
cal-edit-summary
cal-edit-start
cal-edit-end
cal-edit-location
cal-edit-attendees
cal-edit-description
```

It must have buttons calling:

```text
openCalEditInGoogle()
deleteCalEditEvent()
hideCalEditModal()
submitCalEdit()
```

- [ ] **Step 2: Add FullCalendar interaction options**

Inside `new FullCalendar.Calendar(el, { ... })`, add:

```js
selectable: true,
editable: true,
eventStartEditable: true,
eventDurationEditable: true,
selectMirror: true,
```

Replace current `eventClick` alert with:

```js
eventClick: (info) => {
  info.jsEvent?.preventDefault();
  showCalEditModal(info.event);
},
eventDrop: handleCalEventDropOrResize,
eventResize: handleCalEventDropOrResize,
select: handleCalDateSelect,
```

- [ ] **Step 3: Preserve event metadata**

In `normalizeCalendarEvents(events)`, include:

```js
extendedProps: {
  raw: ev,
  location: ev.location || '',
  description: ev.description || '',
  attendees: Array.isArray(ev.attendees) ? ev.attendees.map(a => a.email || a).filter(Boolean).join(', ') : '',
  htmlLink: ev.htmlLink || ev.url || '',
}
```

- [ ] **Step 4: Add calendar helper JS**

Add functions near existing calendar helpers:

```js
let _calEditEvent = null;

function toLocalDateTimeInputValue(date) {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function showCalEditModal(event) {
  _calEditEvent = event;
  document.getElementById('cal-edit-id').value = event.id || '';
  document.getElementById('cal-edit-summary').value = event.title || '';
  document.getElementById('cal-edit-start').value = toLocalDateTimeInputValue(event.start);
  document.getElementById('cal-edit-end').value = toLocalDateTimeInputValue(event.end || event.start);
  document.getElementById('cal-edit-location').value = event.extendedProps?.location || '';
  document.getElementById('cal-edit-attendees').value = event.extendedProps?.attendees || '';
  document.getElementById('cal-edit-description').value = event.extendedProps?.description || '';
  document.getElementById('cal-edit-modal').style.display = 'flex';
}

function hideCalEditModal() {
  document.getElementById('cal-edit-modal').style.display = 'none';
  _calEditEvent = null;
}
```

Then add `submitCalEdit`, `deleteCalEditEvent`, `openCalEditInGoogle`, `handleCalEventDropOrResize`, and `handleCalDateSelect` using `window.claw.googleCalendarUpdate`, `window.claw.googleCalendarDelete`, `window.claw.openExternal`, and existing `showCalCreateModal`.

- [ ] **Step 5: Create selected-slot flow**

`handleCalDateSelect(info)` must call `showCalCreateModal({ start: info.start, end: info.end })`.

Update `showCalCreateModal(selection)` so selection pre-fills start/end; otherwise keep current now/+1h behavior.

- [ ] **Step 6: Add Executive Graphite theme CSS**

In `dashboard.html`, add a comment:

```css
/* Executive Graphite premium theme */
```

Add or override variables:

```css
:root[data-theme="light"] {
  --bg:#f4f1ec;
  --bg-elevated:#141414;
  --surface:#fffdfa;
  --surface-hover:#f7f2ea;
  --surface-elevated:#ffffff;
  --border:#ded6ca;
  --border-strong:#cbbdad;
  --text:#161616;
  --text-secondary:#3d3934;
  --text-muted:#726b62;
  --accent:#b4232c;
  --danger:#b4232c;
  --success:#167a55;
  --warning:#b7791f;
}

:root[data-theme="dark"] {
  --bg:#101112;
  --bg-elevated:#18191b;
  --surface:#1b1c1f;
  --surface-hover:#24262a;
  --surface-elevated:#222428;
  --border:#303238;
  --border-strong:#474a52;
  --text:#f4efe7;
  --text-secondary:#d8d0c4;
  --text-muted:#a69b8d;
  --accent:#dc3d45;
  --danger:#ef4444;
  --success:#27b07d;
  --warning:#d99a2b;
}
```

Upgrade shared selectors for sidebar, cards, buttons, inputs, tabs, and modals using those variables. Keep text fitting rules intact.

- [ ] **Step 7: Run dashboard guard**

Run:

```text
npm run guard:google-calendar
```

Expected: PASS when Task 1 and Task 2 are both integrated.

## Task 3: Integration and Build

**Files:**
- Modify generated: `docs/generated/system-map.json`
- Modify generated: `docs/generated/system-map.txt`

- [ ] **Step 1: Regenerate system map**

Run:

```text
npm run map:generate
```

- [ ] **Step 2: Run architecture guard**

Run:

```text
npm run guard:architecture
```

Expected: PASS.

- [ ] **Step 3: Build Windows exe**

Run:

```text
npm run build:win
```

Expected: PASS and artifact at `dist/9BizClaw Setup 2.4.0.exe`.

- [ ] **Step 4: Manual verification checklist**

Open the built app and verify:

- Google Calendar tab visually uses Executive Graphite surfaces.
- Click event opens edit modal.
- Save update changes Google Calendar event.
- Delete removes event after confirmation.
- Selecting empty slot opens create modal with start/end filled.
- Drag/resize either saves or reverts with real error.
- Gmail tab still lists messages from the previous normalization fix.

## Self-Review

- Spec coverage: backend update, UI interaction, drag/resize/select, theme, guards, build all mapped to tasks.
- Placeholder scan: no unresolved placeholder items.
- Type consistency: route/IPC/preload names all use `googleCalendarUpdate` and `google-calendar-update`.
