# Calendar Interaction and Premium Theme Design

## Goal

Make Google Calendar inside 9BizClaw usable like a normal calendar and refresh the whole dashboard into a distinct premium SaaS theme.

## Current State

The Google Workspace page already renders FullCalendar and can list, create, and delete events through `gog`. Event click currently only shows an alert. The backend has no app route or IPC bridge for `gog calendar update`, even though `gog v0.13.0` supports:

```text
gog calendar update <calendarId> <eventId> --summary --from --to --description --location --attendees --send-updates
```

The dashboard theme is mostly flat light/dark variables with red action states. Many pages use `--bg`, `--surface`, `--border`, `--accent`, and shared card/input/button classes, so a premium refresh should primarily work through tokens and common components rather than one-off per-page styling.

## Scope

### Calendar Interaction

Users must be able to:

- click an event and open an edit modal instead of an alert
- edit title, start, end, location, description, and attendees
- save changes through Google Calendar API
- delete an event after confirmation
- open the event in Google Calendar when `htmlLink` exists
- drag/drop timed events to reschedule
- resize timed events to change duration
- select an empty slot to create a new event with start/end prefilled

After every create/update/delete/drag/resize action, the calendar must refresh from Google. If Google rejects an action, the UI must show the real error and revert the visual calendar change when applicable.

### Premium Theme

Apply an app-wide visual direction named `Executive Graphite`:

- graphite sidebar and elevated navigation
- warm off-white workspace in light mode
- deeper graphite workspace in dark mode
- restrained red accent for primary actions and selected states
- emerald/amber/red status colors
- sharper SaaS controls with 8-12px radius depending on component scale
- denser spacing than a marketing page, but with clearer hierarchy
- cleaner cards, tabs, inputs, modals, Gmail rows, and calendar surfaces

This must keep the existing light/dark toggle working. The two modes should look like the same premium product family, not unrelated themes.

## Architecture

### Backend

Add a new calendar update capability to the existing Google Workspace wrapper:

- `electron/lib/google-api.js`
  - add `updateEvent(eventId, updates, calendarId)`
  - build `gog calendar update` args only for fields provided by the UI
  - include `--send-updates none` by default unless caller specifies another mode

- `electron/lib/google-routes.js`
  - add `POST/GET /api/google/calendar/update`
  - require `eventId`
  - require at least one update field

- `electron/lib/dashboard-ipc.js`
  - add IPC handler `google-calendar-update`
  - audit successful updates

- `electron/preload.js`
  - expose `googleCalendarUpdate(opts)`

### Frontend

Update `electron/ui/dashboard.html`:

- make FullCalendar selectable, editable, eventResizableFromStart false, and eventDurationEditable true
- replace alert-based event click with `showCalEditModal(event)`
- reuse event extended props for location, description, attendees, and htmlLink
- add edit modal DOM under the calendar page
- add JS functions:
  - `toLocalDateTimeInputValue(date)`
  - `readCalEditForm()`
  - `showCalEditModal(event)`
  - `hideCalEditModal()`
  - `submitCalEdit()`
  - `deleteCalEditEvent()`
  - `openCalEditInGoogle()`
  - `handleCalEventDropOrResize(info)`
  - `handleCalDateSelect(info)`
- keep existing create modal, but prefill it from selection when available

### Theme

Update dashboard CSS tokens and shared selectors in `electron/ui/dashboard.html`:

- add `Executive Graphite` variables for `:root[data-theme="light"]` and `:root[data-theme="dark"]`
- upgrade common surfaces:
  - sidebar
  - `.page-header`
  - `.card`, `.main-card`, `.gw-card`
  - `.btn`
  - inputs, textareas, selects
  - tabs and active nav states
  - modal boxes
  - calendar shell and Gmail list rows

Prefer variables and shared selectors over repeated inline overrides.

## Error Handling

- Backend returns `{ error }` from the real thrown message, matching existing route style.
- UI shows `alert(...)` for failed save/delete/drag/resize because existing app patterns already use alerts for Google actions.
- On drag/resize failure, call `info.revert()` before showing the error.
- On delete success, close modal and refresh calendar.

## Testing

Add or extend guard scripts:

- `electron/scripts/check-google-calendar-route.js`
  - verify `updateEvent` helper exists
  - verify route exposes `/calendar/update`
  - verify dashboard IPC exposes `google-calendar-update`
  - verify preload exposes `googleCalendarUpdate`
  - verify dashboard contains FullCalendar `editable`, `selectable`, `eventDrop`, `eventResize`, and edit modal functions

Run:

```text
npm run guard:google-calendar
npm run guard:architecture
npm run build:win
```

## Non-Goals

- No new calendar library.
- No recurring-event scope editing UI in this iteration.
- No calendar list management.
- No RSVP/propose-time UI.
- No replacing the whole dashboard framework.

## Acceptance Criteria

- Existing calendar events can be clicked and edited.
- Existing calendar events can be deleted.
- Dragging or resizing an event calls the update bridge and refreshes.
- Selecting empty time opens create modal with start/end filled.
- Calendar update API is available from both local route and dashboard IPC.
- The whole app has a visibly different premium visual direction.
- `npm run guard:architecture` passes.
- Windows exe builds successfully.
