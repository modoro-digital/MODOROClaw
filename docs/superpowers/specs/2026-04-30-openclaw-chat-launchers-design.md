# OpenClaw Chat And Launcher Design

## Goal

Add a normal user-facing Chat entry to the dashboard, make AI Models open the external 9Router browser UI by default, and add an Advanced Settings launcher below AI Models that opens the OpenClaw web UI while showing the gateway login token.

## Decisions

- The dashboard will not reimplement OpenClaw chat logic. It will embed the existing OpenClaw web UI for the Chat tab.
- The `AI Models` sidebar item will become an external launcher for `http://127.0.0.1:20128/`.
- A new `Cài đặt nâng cao` sidebar item will open `http://127.0.0.1:18789/` in the default browser and reveal the OpenClaw gateway token in the dashboard sidebar.
- The existing hidden `page-openclaw` remains available as the internal fallback page used by command palette and tests, but normal sidebar navigation points users to Chat for conversation and Advanced Settings for browser-based OpenClaw admin.

## UX Requirements

- Sidebar order under settings:
  - `AI Models`
  - `Cài đặt nâng cao`
  - theme toggle
  - tray preference
  - update check
- Sidebar gets a new `Chat` item in the control section.
- Chat tab shows an OpenClaw webview, with buttons for reload, open in browser, and copy gateway token.
- AI Models click opens the 9Router URL externally and does not switch to the embedded 9Router page.
- Advanced Settings click opens OpenClaw externally and calls token reveal/copy helper so the user can paste the token if OpenClaw asks for login.

## Security And Safety

- Only existing local URLs are used: `127.0.0.1:20128` and `127.0.0.1:18789`.
- Gateway token is read through existing IPC `get-gateway-token`; no new token file access is exposed to renderer.
- External open continues to go through the existing `open-external` IPC allowlist.

## Verification

- Add a dashboard guard that checks sidebar entries, launcher functions, token visibility flow, and embed wiring.
- Wire the guard into `guard:architecture`.
- Run syntax checks, the new guard, `guard:architecture`, and `build:win`.
