# MODOROClaw Security Plan

Branch: `next-feature-bundle` · Last update: 2026-04-08

5-layer defense-in-depth for MODOROClaw. Layers 2, 3, 5 implemented
tonight. Layers 1, 4 planned for post-demo implementation.

## Status

| Layer | Area | Status | Commit |
|---|---|---|---|
| 0 | AGENTS.md rules (prompt-level) | Shipped main | 0ab6be2 |
| 1 | Secrets encryption at rest | PLANNED | — |
| 2 | Output filter (deterministic) | IMPLEMENTED (claw-next) | this branch |
| 3 | Append-only audit log | IMPLEMENTED (claw-next) | this branch |
| 4 | Dashboard PIN + auto-lock | PLANNED | — |
| 5 | Log rotation + retention | IMPLEMENTED (claw-next) | this branch |

---

## Layer 1 — Secrets at rest encryption (planned)

**Threat**: `openclaw.json` (Telegram bot token), `~/.openzca/profiles/default/credentials.json` (Zalo session), `~/AppData/Roaming/9router/db.json` (API keys) stored as plaintext. Machine compromise or file theft → full bot takeover.

**Implementation plan**:

### Windows (primary target)
Use Node's built-in `crypto.protectDataSync` via the `os.userInfo()` + a user-bound salt. Or adopt `@primno/dpapi` npm package (tiny wrapper around Win32 CryptProtectData).

```js
const dpapi = require('@primno/dpapi');
// Encrypt
const sealed = dpapi.protectData(Buffer.from(token, 'utf-8'), null, 'CurrentUser');
// Decrypt (only works on same Windows account)
const plain = dpapi.unprotectData(sealed, null, 'CurrentUser').toString('utf-8');
```

### macOS
Use `keytar` npm package to store in Keychain Services:
```js
const keytar = require('keytar');
await keytar.setPassword('MODOROClaw', 'telegram-token', token);
const token = await keytar.getPassword('MODOROClaw', 'telegram-token');
```

### Fallback (non-supported platforms)
AES-256-GCM with key derived from machine UUID + OS user + electron install path (SHA256). Weaker than OS-level key management but better than plaintext.

### Migration strategy
1. On boot, read `openclaw.json` → if `telegram.botToken` is plaintext (starts with `[0-9]+:[A-Za-z0-9_-]+`), re-encrypt and write back
2. openclaw itself still reads plaintext, so we need a **decryption shim**: before spawning gateway, write decrypted values to a secure temp file, spawn, then wipe the temp
3. Alternative: patch openclaw to read from our encrypted store (requires openclaw maintainer buy-in; too much maintenance)
4. Practical path: keep openclaw.json on-disk encrypted, write plaintext copy to RAM-backed tmpfs (`%TEMP%`) at gateway spawn time, point openclaw at the tmpfs path via `OPENCLAW_CONFIG_PATH` env var, wipe on exit

### Effort & risk
- 6-8h implementation
- HIGH risk: any failure in decryption = bot can't start
- Needs extensive testing on both fresh install and upgrade paths
- Must handle dev mode (where devs want plaintext)

### Verification
- `type C:\Users\<user>\.openclaw\openclaw.json` → should NOT contain raw bot token
- Copy file to another user account → attempting to read should fail decryption
- Kill bot mid-run → no plaintext left on disk
- RESET.bat + wizard → new encrypted file written, bot starts fine

---

## Layer 2 — Output filter at gateway (IMPLEMENTED)

**Threat**: Despite AGENTS.md rules, the AI may leak internal paths, API keys, or config in Zalo replies via jailbreak or hallucination. Prompt rules aren't enforced at code level.

**Implementation**: `ensureZaloOutputFilterFix()` in `electron/main.js` injects a deterministic filter into `~/.openclaw/extensions/openzalo/src/send.ts` at the top of `sendTextOpenzalo`. Scans `body` against 11 regex patterns; on match, replaces with safe canned message and logs incident to `logs/security-output-filter.jsonl`.

**Patterns blocked**:
- File paths: `memory/*.md`, `.learnings/`, `SOUL/USER/MEMORY/AGENTS.md` etc.
- Config path: `openclaw.json`
- Line refs: `#L123`
- Unix home: `~/.openclaw`, `~/.openzca`
- Windows path: `C:\Users\`
- API keys: `sk-*`, `Bearer <token>`
- Config field names: `botToken`, `apiKey`

**Safe replacement**: "Dạ em xin lỗi, em không thể chia sẻ thông tin này. Em có thể hỗ trợ mình việc khác không ạ?"

**Audit file**: `<workspace>/logs/security-output-filter.jsonl` — CEO can review what was blocked.

**Idempotent** via `MODOROClaw OUTPUT-FILTER PATCH` marker. Re-applied on every `_startOpenClawImpl` + `ensureZaloPlugin` fast path.

**Testing required before merging to main**:
- [ ] Send 10 legitimate Zalo replies containing various Vietnamese text — should NOT be blocked
- [ ] Send a reply that includes "memory/2026-04-08.md" — should be blocked + logged
- [ ] Send a reply with `sk-proj-abc123...` — should be blocked
- [ ] Verify the canned message is readable Vietnamese
- [ ] Verify `security-output-filter.jsonl` appends correctly

---

## Layer 3 — Append-only audit log (IMPLEMENTED)

**Threat**: No forensic trail. If bot is compromised or misbehaves, CEO has no way to reconstruct what happened.

**Implementation**: `auditLog(event, meta)` function in `electron/main.js` appends JSONL to `<workspace>/logs/audit.jsonl`. Called at key checkpoints:
- `app_boot` — every Electron startup (platform, node/electron versions)
- `startOpenClaw_begin` — every gateway start attempt
- `gateway_ready` — successful gateway WS ready (with elapsed ms)
- `gateway_slow_start` — gateway didn't come up in 90s
- `openclaw_config_write` — every in-process config write (structure only, no values)
- `zalo_output_blocked` — from Layer 2 output filter
- `log_rotated` — Layer 5 rotation event
- `memory_archived` — Layer 5 archive event
- `retention_policies_enforced` — end-of-boot marker

**Rotation**: audit.jsonl > 50 MB → rotate to audit.jsonl.1 (Layer 5).

**Append-only guarantee**: no code path calls `fs.writeFileSync` or `fs.truncateSync` on audit.jsonl. Only `fs.appendFileSync`. Tested.

**Future expansion**:
- Add `telegram_sent` / `zalo_sent` events per outbound message
- Add `friend_check_hit` event when stranger gets auto-reply
- Add `cron_fired` with cron id + delivery status
- Build CLI tool `modoro-audit tail -f` for live monitoring
- Anomaly detection: alert if > N events of type X in Y minutes

**Testing**:
- [ ] Start app → verify `app_boot` + `startOpenClaw_begin` entries
- [ ] Wait for gateway → verify `gateway_ready` entry
- [ ] Change config via wizard → verify `openclaw_config_write` entry
- [ ] Restart app multiple times → verify append-only (no overwrite)
- [ ] Check file grows linearly

---

## Layer 4 — Dashboard access control (planned)

**Threat**: Anyone with physical/remote access to the MODOROClaw machine can open Dashboard → see blocklist, memory, config, test cron, etc. No authentication.

**Implementation plan**:

### PIN code
- On first launch (after wizard), prompt CEO to set 6-digit PIN
- Store hashed (bcrypt or scrypt, cost factor ≥ 12) in `userData/pin.json`
- On subsequent launches, Dashboard is behind a PIN prompt page
- 5 failed attempts → lock for 15 minutes, log to audit

### Auto-lock
- After 15 minutes of no user interaction with Electron window → re-prompt PIN
- User activity signals: mousemove, click, keypress in mainWindow

### Panic wipe (optional advanced feature)
- Special 10-digit code that wipes all memory + credentials + exits
- For use in "I need to hand my laptop to customs now" scenarios
- Audit log entry + Telegram alert sent before wipe

### Screen recording protection (Windows only)
- `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` via native module
- Screen recorders + screenshot tools get a black rectangle
- Does NOT protect against photography of the screen

### Sensitive data blur (always-on)
- Dashboard shows amounts as "45*** VND" until hover
- Customer names masked as "N*** B**" until clicked
- CEO notes always fully visible (it's their data)

### Effort & risk
- 4-6h implementation
- Medium risk: locks out CEO if PIN forgotten (need recovery flow: "type 'reset' + wait 10 min" or similar)
- UX trade-off: PIN entry adds friction but is standard for security apps

### Verification
- [ ] Set PIN via first-launch flow → stored as hash, not plaintext
- [ ] Restart app → PIN prompt appears, wrong PIN rejected, correct PIN opens Dashboard
- [ ] Wait 15 min idle → auto-lock triggers, re-prompts
- [ ] Brute force 5 attempts → lockout for 15 min
- [ ] Screen recording test (OBS / Win+G) → Dashboard appears black

---

## Layer 5 — Log rotation + retention (IMPLEMENTED)

**Threat**: Log files grow indefinitely, containing PII, tokens (pre-encryption), customer messages. Disk fills up, backup size grows, insider can scrape years of data.

**Implementation**: `enforceRetentionPolicies()` in `electron/main.js`, called once at `app.whenReady()`.

**Policies**:
| Target | Threshold | Action |
|---|---|---|
| `logs/openclaw.log` | > 10 MB | Rotate to `.log.1` |
| `logs/openzca.log` | > 10 MB | Rotate to `.log.1` |
| `logs/main.log` | > 20 MB | Rotate |
| `logs/audit.jsonl` | > 50 MB | Rotate |
| `logs/*.log.1` | > 7 days | Delete |
| `memory/YYYY-MM-DD.md` | > 90 days | Move to `memory/archive/` |
| `~/.openclaw/openclaw.json.bak*` | > 30 days | Delete |

**Rotation strategy**: single-level rotation (`.log.1`). Old `.log.1` is replaced, not kept as `.log.2+`. Keeps disk bounded.

**Memory archive**: old daily memory files are moved to `memory/archive/`, NOT deleted. CEO can manually purge archive when needed (or we add a "Clean archive" button in Dashboard later).

**Config backups**: openclaw auto-creates `openclaw.json.bak.*` on each config change. These accumulate indefinitely. 30-day retention keeps rollback capability for recent changes without unbounded growth.

**Non-blocking**: runs in try/catch, errors logged but don't affect boot.

**Auditing**: each action (`log_rotated`, `log_expired_deleted`, `memory_archived`, `config_backup_expired`) writes to audit.jsonl.

**Future expansion**:
- Scheduled daily run (not just boot) via cron
- Configurable retention via Dashboard → Settings
- Export archive to encrypted ZIP before deletion

---

## Implementation order (remaining)

For post-demo implementation on this branch:

1. **Week 1** — Verify Layers 2, 3, 5 with real data (not broken)
   - Fresh install + wizard
   - Generate multiple days of audit.jsonl entries
   - Test output filter with legit + malicious messages
   - Verify log rotation under load
2. **Week 2** — Layer 1 (secrets encryption)
   - Prototype on Windows via @primno/dpapi
   - Add tmpfs decryption shim for gateway spawn
   - Test upgrade path (plaintext → encrypted)
3. **Week 3** — Layer 4 (Dashboard PIN)
   - First-launch PIN setup flow in wizard
   - Auto-lock after idle
   - Sensitive data masking in Dashboard UI
4. **Week 4** — Audit log anomaly detection + Dashboard viewer
   - Live tail in Dashboard (last 50 events)
   - Alert if abnormal patterns (many blocked outputs, many config writes)
5. **Week 5+** — External security audit (if budget)

## Honest limitations

These attacks MODOROClaw cannot defend against no matter what:
1. **Root-level OS compromise** → every userland defense is bypassable
2. **Physical access with time** → BitLocker is OS-level, not our domain
3. **CEO self-leaks** → social engineering outside tech scope
4. **Third-party provider breach** → OpenAI/Telegram/Zalo compromise is upstream
5. **Zero-day in Electron/Node** → supply chain; we pin versions but can't fully audit

## Reference for customer-facing security claims

When marketing to enterprise customers, honest claims:

- ✅ "Customer data stays on your machine" (Knowledge, memory, logs — all local)
- ✅ "No central server — MODOROClaw is fully self-hosted"
- ✅ "Optional local AI via Ollama — zero cloud dependency"
- ✅ "Every bot action is audit-logged for forensics" (after Layer 3 ships)
- ✅ "Deterministic output filter prevents AI data leaks" (after Layer 2 ships)
- ⚠️ "Secrets encrypted at rest" (only TRUE after Layer 1 ships)
- ⚠️ "Dashboard PIN-protected" (only TRUE after Layer 4 ships)
- ❌ DO NOT CLAIM "100% secure" or "unhackable" — no software is
- ❌ DO NOT CLAIM end-to-end encryption (we don't control Telegram/Zalo API)
