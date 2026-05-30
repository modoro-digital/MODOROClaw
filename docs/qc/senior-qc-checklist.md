# Senior QC Checklist

Use this checklist before shipping a Dashboard, Zalo, channel, importer, or release-flow change. It is intentionally biased toward failures that can damage customer trust, leak internal control, or make the Dashboard claim success when nothing actually happened.

## P0

Block release until each item is verified.

- Zalo send safety: no customer-facing Zalo send happens without CEO confirmation, except explicitly tagged `[AUTO-MODE]` flows.
- Dry-run never sends: Dashboard dry-run paths render previews only and never call Zalo send APIs.
- Pause/off truth: Dashboard pause, channel disabled, group off, friend off, read-only mode, and internal-only flags match runtime behavior.
- Payment exclusion: v1 menu flows do not mention SePay, QR, bank transfer, account number, or payment instructions.
- IPC file boundary: renderer cannot pass arbitrary local import paths to main process; picker flows use main-process-owned opaque tokens.
- Config integrity: tests do not write directly to protected config files such as `openclaw.json`, blocklists, schedules, or cron files outside approved APIs.
- Customer data isolation: Zalo customer A cannot see customer B memory, internal paths, internal files, or admin controls.
- Packaged app: the packaged build starts, opens Dashboard, and exercises the same preload/IPC bridge as development.

## P1

Fix before broad release unless explicitly accepted.

- Zalo overview on laptop: at 1366x768, 1280px width, and 125% Windows scaling, rows are readable and controls do not overlap.
- Large lists: 500 groups and 500 friends keep search, segments, scroll, and bulk actions responsive enough for setup work.
- Import hardening: XLSX import rejects oversized files, too many rows, duplicate slugs, missing required display fields, malformed workbooks, unexpected sheet names, formula cells, and hyperlink cells.
- Template round trip: download XLSX template, fill it, import it, save it, restart app, and verify catalog persistence.
- Preview formatting: bold text, lowercase text, multiline descriptions, and Vietnamese copy render correctly in the live Zalo preview.
- Gateway recovery: Zalo disconnected, QR expired, listener restart, local 403/5xx, and boot-in-progress states show truthful messages.
- Toast truth: every success toast corresponds to durable state or a real successful API response.
- Security content: imported catalog values containing HTML, Markdown, formula text, hyperlink text, or prompt-injection text render as inert content.

## P2

Track for polish and regression depth.

- Theme coverage: light/dark/system mode keep contrast readable in Zalo overview and Menu subtabs.
- Keyboard flow: command input Enter runs dry-run, import dialogs cancel cleanly, and tab order is usable.
- Copy quality: customer-facing Vietnamese has dấu, no debug terms, no file paths, and no internal implementation wording.
- Restart recovery: interrupted import, canceled save dialog, and invalid token expiration recover with clear errors.
- Release notes: new guard scripts and manual smoke requirements are visible to whoever cuts the release.

## Evidence Required

For each release candidate, attach:

- Automated guard command output.
- Manual packaged-app smoke notes.
- Screenshots for 1366x768 and 1280px Zalo overview/Menu layouts.
- Import fixture names used for valid, duplicate, oversized, and too-many-row tests.
