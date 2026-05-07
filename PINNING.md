# Pinned dependency versions

9BizClaw v2.4.0+ uses **runtime install** — packages are downloaded on first run instead of bundled in the EXE. This document tracks pinned versions for the runtime install process.

## Current pinned versions

| Package | Version | What it does | Risk if upstream breaks |
|---|---|---|---|
| `openclaw` | `2026.4.14` | Gateway + agent runtime + cron pipeline + vision + web search | All bot replies dead, all crons fail |
| `openzca` | `0.1.57` | Zalo websocket listener (Zalo channel backend) | Zalo silent, Telegram still works |
| `9router` | `0.4.12` | AI provider router (proxies to Ollama / Codex / etc.) with RTK context filtering | All AI calls fail, bot can't think |
| `modoro-zalo` | `1.0.0` | Self-owned Zalo channel plugin (fork of @tuyenhx/openzalo@2026.3.31) | Zalo channel disabled |

## Where versions are referenced

| File | What |
|---|---|
| [electron/scripts/versions.json](electron/scripts/versions.json) | **Canonical source** — single JSON file with all pinned versions. Loaded by both runtime-installer.js and prebuild-vendor.js so they always agree. |
| [electron/lib/runtime-installer.js](electron/lib/runtime-installer.js) | Runtime install logic — loads `versions.json` → `PINNED_VERSIONS` |
| [electron/lib/conflict-detector.js](electron/lib/conflict-detector.js) | Version conflict detection |
| [electron/lib/migration.js](electron/lib/migration.js) | v2.3.x → v2.4.0 migration |
| [electron/lib/updates.js](electron/lib/updates.js) | Auto-update logic |
| [electron/package.json](electron/package.json) | `prebuild:modoro-zalo` script references |
| [electron/scripts/prebuild-vendor.js](electron/scripts/prebuild-vendor.js) | Build-time vendor bundling — loads `versions.json` |

**Upgrade rule:** When bumping a version, update only `electron/scripts/versions.json`. All other files read from it.
## Runtime Install Architecture (v2.4.0+)

```
First Launch Flow:
1. Show splash UI
2. Check installation status
3. Download Node.js v22.14+ (~120MB) if needed
4. npm install openclaw, 9router, openzca (~45MB)
5. Copy modoro-zalo plugin from bundle (~2MB)
6. App ready! User data preserved.

Subsequent Launches:
- Skip installation (already done)
- Boot directly to app

EXE Size: ~50-80MB (vs ~436MB before)
```

## Bundle vs Runtime Comparison

| Aspect | v2.3.x (Bundled) | v2.4.0+ (Runtime) |
|--------|-------------------|---------------------|
| EXE size | ~436 MB | ~50-80 MB |
| First run | Extract vendor (~30-60s) | Download packages (~2-5 min) |
| Subsequent runs | Fast | Fast |
| Update size | Full EXE (~436MB) | Package only (~50MB) |
| npm update | N/A | Automatic |

## Why we pin

Real bugs that would have shipped to users without pinning:

| Date | Upstream change | Symptom |
|---|---|---|
| 2026-04-08 | `openclaw 2026.4.x` removed `agents.defaults.blockStreaming` (boolean) → renamed to `blockStreamingDefault` ("on"/"off") | Every cron fired with "Config invalid: Unrecognized key blockStreaming" → all morning briefings dead |
| 2026-04-08 | `openzalo` schema added strict validation that rejected `streaming: "off"` field on `channels.openzalo` | Cron pipeline died with "must NOT have additional properties" → fatal exit code 1 |
| 2026-04-07 | `openzalo` plugin's `runOpenzcaStreaming` used `spawn(binary, args, {shell: true})` on Windows | cmd.exe truncated multi-line agent prompts → Zalo group bot replies disappeared silently |
| 2026-04-07 | `openzalo` `inbound.ts` only honored `disableBlockStreaming` if `account.config.blockStreaming` was an explicit boolean | Word "Dạ" got split into "D" + "ạ" across 2 messages |

These are real bugs we hit. Pinning would have prevented all of them.

## Upgrade procedure (when you need a newer version)

1. **Check upstream changelog** for the package you want to bump.
2. **Update version in 4 files** listed above. Search for current version string and replace.
3. **Wipe vendor** and rebuild:
   ```bash
   cd electron
   rm -rf vendor/node_modules
   npm run prebuild:vendor
   ```
4. **Run smoke test**:
   ```bash
   npm run smoke
   ```
   If it fails, the new upstream version broke something. Either fix the patch templates / `ensureDefaultConfig()` to match, or revert the version bump.
5. **Manual QA**:
   - Run wizard end-to-end on a fresh Windows VM
   - Send a Telegram message → bot replies in 1 message, no emoji
   - Send a Zalo message → bot replies in 1 message
   - Test "Báo cáo sáng" cron → bot generates real report from history
   - Verify config audit log: `tail ~/.openclaw/logs/config-audit.jsonl` — no `"Unrecognized key"` errors after 5 minutes of runtime
6. **Bump 9BizClaw version** in `electron/package.json` (semver patch for non-breaking, minor for new behavior).
7. **Build EXE/DMG** — smoke test runs automatically as pre-build hook.
8. **Update this file** with new versions + add a row to the bug table if you fixed a known issue.
9. **Ship**.

## When NOT to upgrade

- "Just want the latest" — NO. Stability > newness.
- Upstream changelog says "patch fix" but you can't tell what changed — NO. Wait until someone else hits the bug.
- Upstream changelog says "schema migration" — NO. This means hours of patch template work.

## When you SHOULD upgrade

- Security CVE in current pinned version
- Critical bug fix that affects 9BizClaw users
- New feature you actually need (and have committed to maintain)

## Future-proofing strategies (in priority order)

1. **Smoke test** (DONE) — catches breakage at build time, not in production.
2. **Defensive patching layer** (DONE) — `healOpenClawConfigInline`, `ensureXxxFix` re-apply on every boot.
3. **Self-heal for unknown errors** (DONE) — schema healer parses 3 error formats, strips unknown bad keys.
4. **Fork strategically** — when 9BizClaw has 50+ paying users, fork `openzca` (Zalo reverse-engineer) to own the most critical path.
5. **Eliminate dependency** — when 9BizClaw has 500+ users, build native Zalo client. Nuclear option.
