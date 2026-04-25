# modoro-zalo Fork Design

## Goal

Replace runtime-patched `@tuyenhx/openzalo` with a self-contained `modoro-zalo` package. Eliminate all `ensure*Fix()` / `applyOpenzaloFork()` runtime injection. Full rename of internal channel ID from "openzalo" to "modoro-zalo". Backward-compatible with v2.3.49 customers via automatic migration on first boot.

## Background

MODOROClaw currently installs `@tuyenhx/openzalo@2026.3.31` as an openclaw channel plugin, then overwrites 4 source files (`inbound.ts`, `send.ts`, `channel.ts`, `openzca.ts`) every boot via `applyOpenzaloFork()`. These files contain 17+ defense-in-depth patches (blocklist, dedup, system-msg filter, output filter, command-block, RAG injection, rate limiting, bot-loop breaker, etc.).

This is a soft fork masquerading as runtime patches. Formalizing it eliminates:
- Boot-time file copying on every startup
- Risk of upstream `npm install` overwriting patches
- ~200-300 lines of `ensure*Fix()` boilerplate in main.js / vendor-patches.js
- Conceptual confusion about "patching" vs "owning" the Zalo integration

## Scope Assessment

Full rename — ALL "openzalo" references across the entire codebase, including internal function names in the 69 "unchanged" source files. No upstream sync planned (upstream will never be pulled again).

| File(s) | Count | Action |
|---------|-------|--------|
| `electron/packages/modoro-zalo/src/channel.ts` | 94 | Identity fields + all function/type/import names |
| `electron/packages/modoro-zalo/src/inbound.ts` | 93 | Log prefixes, runtime references, function names |
| `electron/packages/modoro-zalo/src/send.ts` | 4 | Function names, references |
| `electron/packages/modoro-zalo/src/` (69 other files) | 774 | Function names, type names, exports, config access |
| `electron/main.js` | 167 | Config paths, plugin paths, log messages, IPC handlers |
| `electron/scripts/smoke-test.js` | 24 | Test anchors, vendor verification paths |
| `electron/scripts/prebuild-vendor.js` | 18 | Vendor bundling, copy from packages/modoro-zalo/ |
| `electron/lib/vendor-patches.js` | 9 | `applyOpenzaloFork()` removed entirely |
| `electron/scripts/test-core.js` | 12 | Config assertions |
| `electron/ui/dashboard.html` | 4 | camelCase function names |
| `tools/zalo-manage.js` | 3 | Config access |
| `tools/send-zalo-safe.js` | 2 | Config access |
| `RESET.bat` / `USER-RESET.bat` | 2 | npm uninstall references |
| `docs/` | 96 | Documentation updates |
| **Total** | **~1,300** | |

Rename conventions:
- String literals: `"openzalo"` → `"modoro-zalo"`
- CamelCase: `openzaloPlugin` → `modoroZaloPlugin`
- PascalCase: `OpenzaloProbe` → `ModoroZaloProbe`
- Config paths: `channels.openzalo` → `channels["modoro-zalo"]` (bracket notation, hyphenated key)

### Bracket notation requirement

Since "modoro-zalo" contains a hyphen, all JavaScript config access must use bracket notation:
- Before: `config.channels.openzalo.enabled`
- After: `config.channels["modoro-zalo"].enabled`

This applies to ~40 config access paths in main.js and ~10 in channel.ts.

## Package Structure

```
electron/packages/modoro-zalo/
  openclaw.plugin.json        # id: "modoro-zalo", channels: ["modoro-zalo"]
  package.json                # name: "modoro-zalo", openclaw.channel.id: "modoro-zalo"
  src/
    inbound.ts                # 17+ patches baked inline, all refs renamed
    send.ts                   # output filter v6 + escalation detect, refs renamed
    channel.ts                # full rename: id/sectionKey/channelKey/configPrefixes/exports
    openzca.ts                # shell fix + vendor path resolution, refs renamed
    accounts.ts               # resolveOpenzaloAccount → resolveModoroZaloAccount, etc.
    policy.ts                 # resolveOpenzaloGroupMatch → resolveModoroZaloGroupMatch, etc.
    onboarding.ts             # openzaloOnboardingAdapter → modoroZaloOnboardingAdapter
    types.ts                  # ResolvedOpenzaloAccount → ResolvedModoroZaloAccount, etc.
    [65 other .ts files]      # all "openzalo" refs renamed to "modoro-zalo" / "modoroZalo"
  skills/                     # copied from openzalo
  scripts/                    # copied from openzalo
```

Source of truth: `electron/packages/modoro-zalo/`. No external dependency on `@tuyenhx/openzalo`. No upstream sync planned.

### Manifest files

**`openclaw.plugin.json`:**
```json
{
  "id": "modoro-zalo",
  "channels": ["modoro-zalo"],
  "channelConfigs": {
    "modoro-zalo": { ... }
  }
}
```

**`package.json`:**
```json
{
  "name": "modoro-zalo",
  "openclaw": {
    "channel": {
      "id": "modoro-zalo",
      "label": "Modoro Zalo",
      "docsPath": "/channels/modoro-zalo",
      "docsLabel": "modoro-zalo"
    },
    "install": {
      "localPath": "extensions/modoro-zalo"
    }
  }
}
```

### channel.ts rename details

Critical identity fields:

```typescript
// BEFORE (openzalo)
id: "openzalo",
sectionKey: "openzalo",
channelKey: "openzalo",
reload: { configPrefixes: ["channels.openzalo"] },

// AFTER (modoro-zalo)
id: "modoro-zalo",
sectionKey: "modoro-zalo",
channelKey: "modoro-zalo",
reload: { configPrefixes: ["channels.modoro-zalo"] },
```

All 94 references in channel.ts renamed (32 lowercase string literals + 62 mixed-case function/type names). Key renames:
- `openzaloPlugin` → `modoroZaloPlugin`
- `openzaloMessageActions` → `modoroZaloMessageActions`
- `openzaloOnboardingAdapter` → `modoroZaloOnboardingAdapter`
- `resolveOpenzaloAccount` → `resolveModoroZaloAccount`
- `OpenzaloChannelConfigSchema` → `ModoroZaloChannelConfigSchema`
- `OpenzaloProbe` → `ModoroZaloProbe`
- Config access: `cfg.channels?.openzalo` → `cfg.channels?.["modoro-zalo"]`

## Channel Name Migration

### openclaw.json config

`ensureDefaultConfig()` handles migration:

```
if channels.openzalo exists AND channels["modoro-zalo"] does NOT exist:
  channels["modoro-zalo"] = deep copy of channels.openzalo
  delete channels.openzalo
  mark changed
```

Also migrate `plugins` section:
- `plugins.entries.openzalo` → `plugins.entries["modoro-zalo"]`
- `plugins.allow` array: replace `"openzalo"` with `"modoro-zalo"`
- Remove any `@tuyenhx/openzalo` npm spec references

### Plugin directory

`ensureZaloPlugin()` rewritten:

1. Fast path: `~/.openclaw/extensions/modoro-zalo/openclaw.plugin.json` exists AND `.fork-version` matches current version → return
2. Copy `electron/packages/modoro-zalo/` → `~/.openclaw/extensions/modoro-zalo/`
3. Symlink/junction `node_modules` → vendor node_modules (same pattern as current)
4. Write `.fork-version` marker
5. Cleanup: if `~/.openclaw/extensions/openzalo/` exists → delete

### main.js references

All 167 `openzalo` references updated. Categories:
- **Config paths** (~40): `channels.openzalo.*` → `channels["modoro-zalo"].*` (bracket notation)
- **Plugin paths** (~25): `extensions/openzalo` → `extensions/modoro-zalo`
- **Function names** (~8): `ensureOpenzaloShellFix` etc. removed (patches baked in)
- **Log messages** (~15): `[openzalo]` → `[modoro-zalo]`
- **Comments** (~8): updated for clarity
- **Remaining** (~71): config access, conditionals, field references

### openzca compatibility

openzca daemon reads channel identifier from the plugin's `openclaw.plugin.json`. The manifest declares `"modoro-zalo"` as channel name. openclaw.json config has `channels["modoro-zalo"]` with matching settings. Gateway loads plugin → registers channel → openzca sees the new name via gateway WS handshake.

**Testing required:** Verify openzca `listen` command connects correctly when gateway announces `modoro-zalo` instead of `openzalo`. openzca may have hardcoded "openzalo" expectations — if so, `ensureOpenzcaFriendEventFix()` (which already patches openzca) can be extended.

## Boot Sequence (after fork)

```
_startOpenClawImpl()
  ensureDefaultConfig()              # migrate channels.openzalo → channels["modoro-zalo"]
  ensureZaloPlugin()                 # copy from packages/modoro-zalo/ (no @tuyenhx/openzalo)
  [REMOVED] applyOpenzaloFork()      # deleted — patches baked in
  [REMOVED] ensure*Fix() x17         # deleted — inline in source
  ensureVisionFix()                  # kept (patches openclaw, not openzalo)
  ensureVisionCatalogFix()           # kept
  ensureVisionSerializationFix()     # kept
  ensureWebFetchLocalhostFix()       # kept
  ensureOpenclawPricingFix()         # kept
  ensureOpenclawPrewarmFix()         # kept
  ensureOpenzcaFriendEventFix()      # kept (patches openzca, not openzalo)
  syncAllBootstrapData()
  spawn gateway
```

Net removal from vendor-patches.js:
- `OPENZALO_FORK_VERSION` constant
- `applyOpenzaloFork()` function
- `_copyForkFiles()` helper
- The `fork` case in `applyAllVendorPatches()`

All `ensure*Fix()` functions for openzalo patches (blocklist, system-msg, dedup, output filter, force-one-message, shell fix, command-block) were already consolidated into `applyOpenzaloFork()` in main.js — those call sites are simply removed.

## v2.3.49 Customer Migration

Customer updates from v2.3.49 to v2.4.0:

1. App starts → `ensureDefaultConfig()` detects `channels.openzalo` → deep-copies config to `channels["modoro-zalo"]` → deletes old key → writes config
2. `ensureZaloPlugin()` → no `extensions/modoro-zalo/` found → copies from `packages/modoro-zalo/`
3. Cleanup → detects `extensions/openzalo/` → deletes old plugin directory
4. Gateway spawns → loads `modoro-zalo` plugin → openzca connects → Zalo works normally

Customer sees zero difference. Bot still receives Zalo messages, replies, blocklist/dedup/filter all active. Only difference: no runtime patch injection at boot.

### Rollback safety

If v2.4.0 has issues and customer downgrades to v2.3.49:
- `ensureDefaultConfig()` v2.3.49 sees `channels["modoro-zalo"]` as unknown key → ignores (harmless)
- `ensureZaloPlugin()` v2.3.49 sees no `extensions/openzalo/` → re-installs `@tuyenhx/openzalo` from vendor → `applyOpenzaloFork()` applies patches
- Bot works on v2.3.49 again

**Gap 1:** `channels.openzalo` config was deleted during upgrade. v2.3.49's `ensureDefaultConfig()` will recreate it with defaults (`enabled: true`, `dmPolicy: "open"`). Customer loses any custom openzalo config (e.g. custom allowFrom). Acceptable because: (a) most customers use defaults, (b) rollback is emergency path, (c) config is recreatable.

**Gap 2:** Leftover `channels["modoro-zalo"]` key in openclaw.json after rollback. v2.3.49 does not know this key — openclaw's strict config validator may reject it (`channels.modoro-zalo: Unrecognized key`). Mitigation: v2.3.49 already has `healOpenClawConfigInline()` which auto-deletes unrecognized keys on first failure. Self-heals on first cron/agent run.

## Upstream Sync Strategy

**No upstream sync.** @tuyenhx/openzalo will never be pulled again. modoro-zalo is a permanent, complete fork. If openzalo adds desirable features in the future, we cherry-pick manually by reading their code — not by diffing or merging.

## Files Changed

### New
- `electron/packages/modoro-zalo/` (entire package, ~73 files — full copy of @tuyenhx/openzalo@2026.3.31 with all ~1,300 "openzalo" refs renamed to "modoro-zalo" variants, 4 patched files baked in)

### Modified
- `electron/main.js` — rewrite `ensureZaloPlugin()`, update `ensureDefaultConfig()` migration (channels + plugins.entries + plugins.allow), rename 167 openzalo references (bracket notation for hyphenated key)
- `electron/lib/vendor-patches.js` — remove `applyOpenzaloFork()`, `_copyForkFiles()`, `OPENZALO_FORK_VERSION`, fork case in `applyAllVendorPatches()`
- `electron/scripts/prebuild-vendor.js` — copy from `packages/modoro-zalo/` instead of `npm install @tuyenhx/openzalo` (18 ref updates + build pipeline change)
- `electron/scripts/smoke-test.js` — update 24 patch anchor checks + vendor verification for modoro-zalo paths
- `electron/scripts/test-core.js` — update 12 config assertions from `channels.openzalo` to `channels["modoro-zalo"]`
- `electron/ui/dashboard.html` — rename 4 camelCase function refs
- `tools/zalo-manage.js` — update 3 config access paths
- `tools/send-zalo-safe.js` — update 2 config access paths
- `RESET.bat` / `USER-RESET.bat` — remove `@tuyenhx/openzalo` uninstall refs
- `PINNING.md` — replace @tuyenhx/openzalo entry with modoro-zalo (self-owned, no external pin needed)
- `AGENTS.md` — update any openzalo references
- `CLAUDE.md` — update patch documentation references

### Deleted
- `electron/patches/openzalo-fork/` (4 files — merged into packages/modoro-zalo/src/)
- `electron/patches/openzalo-openzca.ts` (merged into packages/modoro-zalo/src/openzca.ts)

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| openzca fails to connect to renamed channel | Medium | Test openzca → gateway handshake with "modoro-zalo" channel name before shipping. Extend `ensureOpenzcaFriendEventFix()` if openzca has hardcoded "openzalo" |
| openclaw gateway rejects unknown channel | Low | openclaw channel system is plugin-driven, not hardcoded. Plugin's channel.ts `id` field is authoritative. Test with `openclaw gateway run` |
| Bracket notation bugs (missing quotes, dot notation on hyphenated key) | Medium | Mechanical find-and-replace, but each site must use `["modoro-zalo"]` not `.modoro-zalo`. Smoke test catches config access failures |
| Customer custom config lost on rollback | Low | Documented in rollback section. Defaults are safe |
| Smoke test false-passes after rename | Medium | smoke-test.js must verify new plugin name + patch markers in new paths. Rebuild test anchors for modoro-zalo |
| Rollback leaves orphan `channels["modoro-zalo"]` key | Low | v2.3.49's `healOpenClawConfigInline()` auto-deletes unrecognized keys on first failure |
