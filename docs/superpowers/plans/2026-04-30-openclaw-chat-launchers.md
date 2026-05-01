# OpenClaw Chat And Launchers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user chat tab and make AI Models / Advanced Settings launch the correct browser UIs with token visibility.

**Architecture:** Keep OpenClaw and 9Router as source-of-truth web apps. Dashboard adds navigation, launcher helpers, and guard coverage instead of duplicating chat or model management behavior.

**Tech Stack:** Electron dashboard HTML, preload IPC already present, Node guard scripts, existing `openExternal` allowlist.

---

### Task 1: Guard The Navigation Contract

**Files:**
- Create: `electron/scripts/check-openclaw-launchers.js`
- Modify: `electron/package.json`

- [ ] Create a guard that reads `electron/ui/dashboard.html` and asserts these strings exist:
  - `data-page="chat"`
  - `id="page-chat"`
  - `openAiModelsBrowser()`
  - `openAdvancedSettings()`
  - `copyAndShowGatewayToken()`
  - `ensureEmbedLoaded('chat')`
  - `http://127.0.0.1:20128/`
  - `http://127.0.0.1:18789/`
- [ ] Add `guard:openclaw-launchers` to `electron/package.json`.
- [ ] Add it to `guard:architecture` after `guard:gmail-inbox`.
- [ ] Run `npm run guard:openclaw-launchers` and verify it fails before UI implementation.

### Task 2: Implement Sidebar And Chat Page

**Files:**
- Modify: `electron/ui/dashboard.html`

- [ ] Add a `Chat` sidebar item in the control section.
- [ ] Change `AI Models` sidebar item to call `openAiModelsBrowser()` instead of `switchPage('9router')`.
- [ ] Add `Cài đặt nâng cao` below AI Models calling `openAdvancedSettings()`.
- [ ] Add `page-chat` with an OpenClaw webview wrapper and token/browser/reload buttons.
- [ ] Extend embed maps with `chat` pointing to the OpenClaw URL and `persist:embed-openclaw`.
- [ ] Update `switchPage()` to lazy-load `chat`.
- [ ] Add helper functions:
  - `showGatewayToken()`
  - `openAiModelsBrowser()`
  - `openAdvancedSettings()`
- [ ] Keep the existing `page-9router` and `page-openclaw` as fallback routes for command palette compatibility.

### Task 3: Verify And Build

**Files:**
- Generated: `docs/generated/system-map.json`
- Generated: `docs/generated/system-map.txt`

- [ ] Run `node --check` on touched JavaScript files.
- [ ] Run `npm run guard:openclaw-launchers`.
- [ ] Run `npm run map:generate` if architecture map is stale.
- [ ] Run `npm run guard:architecture`.
- [ ] Run `npm run build:win`.
