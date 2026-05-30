# 9BizClaw Project Skill — Review & Development

Use this skill when reviewing code or adding new functionality. It contains the full architectural mental model, development patterns, review protocol, and known landmines.

## Architecture in 30 seconds

9BizClaw = Electron desktop app for Vietnamese SME CEOs. CEO controls via Telegram. Bot talks to customers via Zalo. AI powered by OpenClaw gateway + 9Router model proxy.

```
CEO (Telegram) ──► OpenClaw Gateway (port 18789) ──► AI Agent
                                                       │
Customer (Zalo) ──► modoro-zalo plugin ──► inbound.ts ─┘
                                              │
                    send.ts ◄── agent reply ◄──┘
                       │
                    openzca ──► Zalo API
```

**Key processes:** Electron main → spawns 9Router (port 20128) → spawns OpenClaw gateway (port 18789) → gateway loads modoro-zalo plugin → plugin connects to openzca (Zalo WS listener)

**Internal APIs:** Cron API (port 20200) — localhost-only HTTP server for cron CRUD, file ops, image generation, workspace R/W. Bearer token auth (48 hex, rotated every boot).

## File Map

### Core runtime (electron/lib/)
| File | Responsibility |
|------|---------------|
| `gateway.js` | Gateway spawn, 9Router start, boot sequence, network restart, pre-warm |
| `config.js` | `ensureDefaultConfig()` — tools.allow, model registration, Zalo combo, schema healing |
| `channels.js` | `sendTelegram()`, `sendCeoAlert()`, output filter patterns (47+), channel pause/resume |
| `cron.js` | Cron scheduler, `runCronAgentPrompt()`, session-send fallback, process ack strip, missed cron replay |
| `cron-api.js` | HTTP API server (port 20200), auth gate, cron CRUD, image, exec, workspace R/W |
| `dashboard-ipc.js` | All IPC handlers (~164), knowledge CRUD, config save, channel management |
| `workspace.js` | `getWorkspace()`, `getDocumentsDb()`, `seedWorkspace()`, retention policies |
| `knowledge.js` | Knowledge DB schema, chunk indexing, FTS, embedding, backfill |
| `license.js` | Ed25519 license verification, HMAC seal, machine fingerprint, revocation |
| `boot.js` | `getBundledVendorDir()`, `findNodeBin()`, `appDataDir()` |
| `nine-router.js` | 9Router process management, API key sync, Zalo combo setup |
| `escalation.js` | Escalation queue processing, CEO alert enrichment |

### Plugin (electron/packages/modoro-zalo/src/)
| File | Responsibility |
|------|---------------|
| `inbound.ts` | 22+ defense layers: blocklist → system-msg → dedup → COMMAND-BLOCK → skill inject → RAG → dispatch |
| `send.ts` | Output filter (mirrors channels.js), escalation scanner, transport gate (text + media) |
| `channel.ts` | Channel config, friend list |
| `openzca.ts` | Zalo WS connection via openzca subprocess |

### UI
| File | Responsibility |
|------|---------------|
| `dashboard.html` | Main dashboard — overview, channels, knowledge, cron, settings |
| `wizard.html` | First-run setup — license → Telegram → 9Router → Zalo |
| `license.html` | License activation page |
| `preload.js` | IPC bridges (must match dashboard-ipc.js handlers 1:1) |

## Development Patterns

### Adding a new IPC handler (3-file checklist)

1. **dashboard-ipc.js** — Register handler:
```js
ipcMain.handle('my-new-handler', async (_event, args) => {
  try {
    // logic
    return { success: true, data: result };
  } catch (e) {
    return { success: false, error: e.message };
  }
});
```

2. **preload.js** — Add bridge:
```js
myNewHandler: (args) => ipcRenderer.invoke('my-new-handler', args),
```

3. **dashboard.html** — Call from UI:
```js
const result = await window.claw.myNewHandler({ key: 'value' });
```

RULE: Every handler MUST have try/catch. Every handler MUST have a preload bridge. Every bridge MUST have a UI call site (or document why it's gateway-only).

### Adding an inbound.ts patch (defense layer)

Pattern: anchor marker → code block → end marker. Idempotent via marker check.

```typescript
// === 9BizClaw MY-PATCH-NAME ===
// description
try {
  // defense logic
  if (shouldBlock) {
    runtime.log?.('modoro-zalo: drop reason for sender=' + message.senderId);
    return; // early exit = message never reaches AI
  }
} catch (__err) {
  runtime.log?.('modoro-zalo: MY-PATCH error: ' + String(__err));
}
// === END 9BizClaw MY-PATCH-NAME ===
```

RULES:
- All variables must use `__` prefix (e.g., `__mpFs`, `__mpPath`) to avoid collision
- Always fail-closed (catch → return, not catch → continue)
- Workspace resolution is duplicated per patch (no shared helpers in plugin context)
- Calling order in `_startOpenClawImpl()` matters: LAST called = FIRST in file (closest to anchor)

### Adding output filter patterns (2-file mirror)

BOTH files must be updated in sync:
1. `electron/lib/channels.js` — `_outputFilterPatterns` array
2. `electron/packages/modoro-zalo/src/send.ts` — `__ofBlockPatterns` array

Same name, same regex. channels.js is the Electron-side gate (sendTelegram/sendZaloTo). send.ts is the gateway-side gate (runs inside openclaw process).

### Adding a cron-api endpoint

Add a new `else if (urlPath === '/api/<your-endpoint>')` branch in the request handler in cron-api.js. Auth is checked by `_requireCeoTelegram()` above your branch. Parse body with `parseJsonBody(req)`, return with `jsonResp(res, 200, { success: true })`.

For PUBLIC endpoints (no auth): add to `PUBLIC_ROUTES` Set. For Zalo-safe read endpoints: add to Zalo-safe pre-gate pattern. Default: everything requires Bearer token.

### Adding a new skill file

1. Create `skills/operations/my-skill.md` (or `skills/marketing/`, `skills/` for industry)
2. Add entry to `skills/INDEX.md` table
3. Update AGENTS.md routing table if the skill has specific trigger patterns
4. Skill count in AGENTS.md header line

## Review Protocol — 10-Agent Functional Audit

Run before every major release. Spawns 10 parallel code-reviewer subagents, each tracing a real CEO user flow end-to-end.

### The 10 agents:

| # | Area | Key files | What to trace |
|---|------|-----------|---------------|
| 1 | Boot + First Launch | main.js, boot.js, runtime-installer.js, migration.js | Launch → splash → runtime install → 9Router → gateway → green dots |
| 2 | Telegram + AGENTS.md | AGENTS.md, gateway.js, config.js | Message → routing → skill/tool → reply. tools.allow, contextInjection |
| 3 | Zalo Inbound | inbound.ts | 22-layer pipeline order. Regex false positives. Bypass paths |
| 4 | Zalo Outbound | send.ts, channels.js, escalation.js | Output filter → escalation scanner → transport gate. Pattern sync |
| 5 | Cron System | cron.js, cron-api.js | Create → schedule → fire → deliver. Auth, retry, Zalo delivery |
| 6 | Knowledge + RAG | dashboard-ipc.js, workspace.js, knowledge.js | Upload → extract → summarize → index → search. DB singleton |
| 7 | License + Wizard | license.js, wizard.html, license.html | Key verify → seal → wizard steps → boot. Machine fingerprint |
| 9 | Dashboard IPC | dashboard-ipc.js, preload.js, dashboard.html | Handler↔bridge↔UI parity. Missing try/catch. Orphan handlers |
| 10 | Security Cross-Cut | cron-api.js, inbound.ts, channels.js, config.js | 6 attack vectors: exec, file read, leak, fake commerce, bot loop, cron abuse |

### How to run:

Spawn all 10 as parallel `superpowers:code-reviewer` subagents. Each reads actual source, reports ONLY issues with file:line references. After all return, verify top findings against source before acting (agents hallucinate ~30% of "critical" findings).

## Known Landmines

### Will break things silently:
- **NEVER create a second Telegram `getUpdates` poller.** Gateway already polls. Two pollers = 409 Conflict = messages lost permanently.
- **NEVER use PowerShell to edit `openclaw.json`.** UTF-16 BOM → openclaw rejects → wizard reappears.
- **NEVER push to MODORO Digital org.** Private repo only (PeterBui85/9BizClaw-Premium).
- **NEVER call `db.close()` on the documents DB.** Singleton pattern — close kills it for all callers.
- **Output filter patterns must be mirrored** in BOTH channels.js AND send.ts. Forgetting one = filter bypassed on that path.

### Will confuse you:
- `sendZalo()` is disabled (returns null). CEO's Zalo IS the bot — can't message yourself. `sendCeoAlert` is Telegram-only.
- `ensureZaloPlugin` patches are injected into `~/.openclaw/extensions/` at RUNTIME, not build time. Source of truth is `electron/packages/modoro-zalo/`.
- `__usOriginalRawBody` is NOT the original — it's captured AFTER MSG-LENGTH-GATE truncation.
- Skill 3KB cap deliberately lets the first skill through regardless of size (by design).
- `exec` is in tools.allow by CEO's explicit decision. AGENTS.md "CẤM SỬA APP" rule is the guard.
- `build:mac:arm`/`build:mac:intel` npm scripts include obfuscation, but CI workflows call electron-builder directly (no obfuscation in CI yet).

### Build & Test commands:
```bash
# Smoke tests (must pass before build):
cd electron && npm run smoke

# Architecture guards (system map + contracts + all guards):
npm run guard:architecture

# Build Windows:
npm run build:win

# Build Mac (from GitHub Actions — never local):
# Push to PeterBui85/9BizClaw-Premium + tag v2.x.x

# Regenerate system map after changing exports/IPC/routes:
npm run map:generate
```

### Version rules:
- Build EXE/DMG is local artifact, NOT shipped. Ship only when CEO explicitly says.
- Version stays the same across rebuilds. Bump only for real releases.
- `fix-artifact-name.js` runs post-build to fix electron-builder's version mangling.
