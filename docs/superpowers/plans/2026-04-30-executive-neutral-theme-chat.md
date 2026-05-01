# Executive Neutral Theme And Chat Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed black/gold dashboard with a cleaner Executive Neutral theme that supports light, dark, and system modes, while making the embedded Chat page feel faster and less technical.

**Architecture:** Keep the existing single-file dashboard structure and add focused CSS/JS changes inside `electron/ui/dashboard.html`. Extend the existing premium guard so regressions fail in `npm run guard:architecture` without introducing a new test framework.

**Tech Stack:** Electron renderer HTML/CSS/JavaScript, existing Node guard scripts, embedded `webview`.

---

### Task 1: Guard The New Theme Contract

**Files:**
- Modify: `electron/scripts/check-premium-theme-no-updates.js`

- [ ] **Step 1: Replace fixed black/gold expectations with Executive Neutral expectations**

The guard must require all of these markers:

```js
['theme boot helper', 'applySavedThemeBeforePaint'],
['executive neutral dark selector', ':root[data-theme="dark"]'],
['executive neutral light selector', ':root[data-theme="light"]'],
['champagne accent dark', '--accent:#c8a75a'],
['theme mode helper', 'setThemeMode(mode)'],
['system theme media listener', 'matchMedia(\'(prefers-color-scheme: dark)\')'],
['chat prewarm helper', 'prewarmChatEmbed'],
['clean chat shell class', 'chat-shell'],
```

- [ ] **Step 2: Preserve update requirements**

The guard must still require 9BizClaw update markers and OpenClaw vendor update-disable markers:

```js
['9BizClaw update button preserved', 'id="check-update-btn"'],
['9BizClaw update banner preserved', 'function showUpdateBanner(info) {'],
['9BizClaw manual update preserved', 'async function manualCheckUpdate() {'],
['9BizClaw boot update check preserved', 'checkForUpdates().catch'],
['OpenClaw update patch wrapper', 'ensureOpenclawUpdateUiDisabled'],
['OpenClaw update UI patch marker', '9BIZCLAW_OPENCLAW_UPDATE_UI_DISABLED'],
```

- [ ] **Step 3: Run guard and verify RED**

Run:

```powershell
node scripts/check-premium-theme-no-updates.js
```

Expected: FAIL because dashboard still uses fixed `premium` theme and lacks chat prewarm.

### Task 2: Implement Executive Neutral Theme Modes

**Files:**
- Modify: `electron/ui/dashboard.html`

- [ ] **Step 1: Replace the boot theme script**

Use a before-paint script that reads `localStorage.themeMode`, defaults to `system`, and resolves the actual theme via `prefers-color-scheme`.

- [ ] **Step 2: Replace fixed premium tokens**

Create `:root[data-theme="dark"]` and `:root[data-theme="light"]` tokens matching Executive Neutral:

```css
--accent:#c8a75a;
--surface:#12151a;
--border:#252a33;
```

for dark, and a warm white neutral set for light.

- [ ] **Step 3: Replace the static premium sidebar row**

Add a compact segmented control with `Sáng`, `Tối`, and `Hệ thống` buttons. Keep it inside the sidebar settings area and ensure labels cannot overflow.

- [ ] **Step 4: Update theme JS**

Implement `setThemeMode(mode)`, `resolveThemeMode(mode)`, `updateThemeToggleUI()`, and compatibility `toggleTheme()` that cycles light/dark/system.

### Task 3: Clean And Prewarm Chat

**Files:**
- Modify: `electron/ui/dashboard.html`

- [ ] **Step 1: Replace the Chat page header**

Remove the visible local URL from the user-facing subtitle. Use “Trò chuyện trực tiếp với trợ lý qua OpenClaw Gateway” and move token/browser/reload actions into compact controls.

- [ ] **Step 2: Add a premium chat shell**

Wrap `embed-wrap-chat` in `.chat-shell` with a compact toolbar, status pill, and cleaner loader. Keep the actual `webview` unchanged.

- [ ] **Step 3: Add chat prewarm**

Add `prewarmChatEmbed()` that runs after boot once the dashboard is initialized. It should call `ensureEmbedLoaded('chat', { silent: true })` so the webview loads before the user clicks Chat.

- [ ] **Step 4: Keep reload and retry behavior**

`reloadEmbed('chat')` and `retryEmbed('chat')` must still work and show a loader if the gateway is not ready.

### Task 4: Verify

**Files:**
- Modify: generated docs if `map:generate` changes them

- [ ] **Step 1: Syntax checks**

Run:

```powershell
node --check scripts/check-premium-theme-no-updates.js
```

- [ ] **Step 2: Guard**

Run:

```powershell
npm run guard:architecture
```

- [ ] **Step 3: Build Windows EXE if guards pass**

Run:

```powershell
npm run build:win
```
