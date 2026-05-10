# Bug Rate Reduction — Defensive Layers Design

**Date:** 2026-05-10
**Goal:** Cut bug rate ~50-60% with ~3-4 days of work, low regression risk.
**Context:** 78% of commits in the past month were bug fixes across 6 categories: cross-platform (8), race conditions (5), config drift (4), path mismatches (6), process lifecycle (5), runtime monkey-patching (4). Runtime monkey-patching was already addressed — all 6 `ensure*Fix` patches were migrated to the build-time `modoro-zalo` fork in a prior refactor.

## Component 1: Pre-flight Boot Verification

New module `electron/lib/preflight.js`. Runs on every boot after `app.whenReady()`, before `createWindow()`. Aggregate timeout: 10 seconds for all checks combined.

**Imports:** `getUserDataDir`/`getWorkspace` from `workspace.js`, `getBundledVendorDir`/`findNodeBin` from `boot.js`, `getModelDir`/`isModelDownloaded` from `model-downloader.js`.

**Checks (each returns `{ pass, message, heal? }`):**

| Check | What | Self-heal | Critical? |
|---|---|---|---|
| paths | `getUserDataDir()`, `getBundledVendorDir()`, `getModelDir()`, workspace resolve and are writable | Create missing dirs | Yes |
| config | `openclaw.json` parses, no unrecognized keys, required fields present | `healOpenClawConfigInline()` | Yes |
| native | `require('better-sqlite3')` loads without ABI error | `autoFixBetterSqlite3()` | No |
| processes | `findNodeBin()` resolves, 9router binary exists | — | Yes |
| model | RAG model files present and non-empty | Flag for download on splash | No |

**Behavior:**
- Critical check fails + no self-heal = surface diagnostic to splash screen via the environment error UI.
- Non-critical failure = log warning, continue boot (graceful degradation exists).
- Self-heal gets one attempt. If heal throws, treat as failed-no-heal and surface diagnostic.
- If aggregate 10s timeout hit, surface whatever checks haven't passed yet as diagnostics.

## Component 2: Contract Guards

Inline assertions in 6-8 key functions. Pattern:

```javascript
function guardPath(label, actual, mustBeInside) {
  if (!actual) throw new Error(`[preflight] ${label}: path is null`);
  if (mustBeInside) {
    const rel = path.relative(mustBeInside, actual);
    if (rel.startsWith('..') || path.isAbsolute(rel))
      throw new Error(`[preflight] ${label}: ${actual} escapes ${mustBeInside}`);
  }
}
```

Uses `path.relative` instead of `startsWith` to prevent partial-prefix false positives on Windows (e.g. `app-data-extra` vs `app-data`).

**Locations:**
- `getModelDir()` — result inside `getUserDataDir()` (skip guard when `!app.isPackaged` for dev mode)
- `getModelFilePath(f)` — result inside `getModelDir()`
- `getWorkspace()` — returned dir exists and is writable
- `getBundledVendorDir()` — when non-null, `vendor/` contains `node_modules`
- `writeOpenClawConfigIfChanged()` — config serializes to valid JSON before write
- `spawnOpenClawSafe()` — node binary exists at resolved path before spawn

## Files Changed

| File | Change |
|---|---|
| `electron/lib/preflight.js` | **New** — boot checks + guard utility |
| `electron/main.js` | Add preflight call in boot sequence |
| `electron/lib/model-downloader.js` | Add path guard to `getModelDir()`, `getModelFilePath()` |
| `electron/lib/workspace.js` | Add path guard to `getWorkspace()` |
| `electron/lib/boot.js` | Add guard to `getBundledVendorDir()` |

## Not In Scope

- File splitting (main.js / dashboard-ipc.js remain large)
- CI/CD pipeline
- Automated test suite
- Build-time patch migration (already completed in prior refactor)
- These build on top of this foundation as future work.
