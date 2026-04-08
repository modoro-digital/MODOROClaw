# Pinned dependency versions

MODOROClaw bundles 4 third-party npm packages. Their versions are **pinned exactly** to protect against upstream schema/CLI breakage.

## Current pinned versions

| Package | Version | What it does | Risk if upstream breaks |
|---|---|---|---|
| `openclaw` | `2026.4.5` | Gateway + agent runtime + cron pipeline | All bot replies dead, all crons fail |
| `openzca` | `0.1.57` | Zalo websocket listener (Zalo channel backend) | Zalo silent, Telegram still works |
| `9router` | `0.3.82` | AI provider router (proxies to Ollama / Codex / etc.) | All AI calls fail, bot can't think |
| `@tuyenhx/openzalo` | `2026.3.31` | OpenClaw plugin for Zalo channel | Zalo channel disabled |

## Where versions are referenced (single source of truth = this file)

| File | What |
|---|---|
| [electron/scripts/prebuild-vendor.js](electron/scripts/prebuild-vendor.js) | Mac packaged `.dmg` bundles these versions in `vendor/node_modules/` |
| [electron/scripts/smoke-test.js](electron/scripts/smoke-test.js) | Pre-build validator checks bundled vendor matches |
| [electron/main.js](electron/main.js) `install-openclaw` IPC handler | First-time Windows install via wizard fetches these versions |
| [RUN.command](RUN.command) | Mac dev launcher auto-installs these versions |

When upgrading: change ALL FOUR locations + run `npm run smoke` + manual QA + ship build.

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
6. **Bump MODOROClaw version** in `electron/package.json` (semver patch for non-breaking, minor for new behavior).
7. **Build EXE/DMG** — smoke test runs automatically as pre-build hook.
8. **Update this file** with new versions + add a row to the bug table if you fixed a known issue.
9. **Ship**.

## When NOT to upgrade

- "Just want the latest" — NO. Stability > newness.
- Upstream changelog says "patch fix" but you can't tell what changed — NO. Wait until someone else hits the bug.
- Upstream changelog says "schema migration" — NO. This means hours of patch template work.

## When you SHOULD upgrade

- Security CVE in current pinned version
- Critical bug fix that affects MODOROClaw users
- New feature you actually need (and have committed to maintain)

## Future-proofing strategies (in priority order)

1. **Smoke test** (DONE) — catches breakage at build time, not in production.
2. **Defensive patching layer** (DONE) — `healOpenClawConfigInline`, `ensureXxxFix` re-apply on every boot.
3. **Self-heal for unknown errors** (DONE) — schema healer parses 3 error formats, strips unknown bad keys.
4. **Fork strategically** — when MODOROClaw has 50+ paying users, fork `openzca` (Zalo reverse-engineer) to own the most critical path.
5. **Eliminate dependency** — when MODOROClaw has 500+ users, build native Zalo client. Nuclear option.
