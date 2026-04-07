# MODOROClaw CEO Workspace — Design Spec

**Date:** 2026-04-04
**Author:** MODORO Technology Corporation
**Status:** Draft

---

## 1. Problem

Vietnamese CEOs need a personal AI assistant that works reliably from day one. Current options are either too technical to set up, too unreliable for daily use, or not localized for the Vietnamese market and communication ecosystem (Zalo, Telegram).

MODORO already has a production-hardened OpenClaw workspace template (MODOROClaw-Setup) with identity, memory, and safety layers. What's missing is a **workflow layer** — concrete, pre-built automations that deliver value immediately after setup.

## 2. Product Overview

A single OpenClaw workspace that CEOs install once. It ships with pre-configured workflows that run autonomously (briefings, monitoring) and respond to commands (task delegation, Zalo draft replies). Everything runs inside OpenClaw — no separate apps, no extra dashboards.

### Target User

Vietnamese CEO/founder of a small-to-medium business. Not technical. Uses Zalo daily for business communication. Willing to use Telegram as a private command channel for their AI assistant.

### Success Criteria

- CEO receives first morning briefing within 24 hours of setup
- Zalo messages are summarized and draft replies appear on Telegram without CEO configuration beyond initial auth
- Zero false sends — no message goes out on Zalo without CEO approval
- System runs for 30 days without manual intervention (beyond approvals)

## 3. Deployment Model

**Hosting:** MODORO-managed cloud server (VPS in Vietnam for data residency compliance).

- Each CEO gets a dedicated OpenClaw instance on a Vietnamese cloud provider (e.g., Viettel IDC, FPT Cloud, or a Vietnam-region VPS)
- Always-on (24/7) — required for cron jobs, Zalo webhooks, and the 30-day unattended success criterion
- MODORO manages infrastructure; CEO interacts only via Telegram and Zalo
- Stable public URL for Zalo OA webhook endpoint (via reverse proxy / domain)
- Backups: daily automated snapshots of SQLite memory database and config files

**Why not local/self-hosted:** A CEO's laptop that sleeps at night misses the morning briefing. A Zalo webhook needs a stable public URL. Cloud-hosted is the only way to hit the reliability targets.

**Cost model:** Infrastructure cost borne by MODORO, passed through in product pricing. CEO pays nothing extra for hosting.

## 4. Architecture Overview

```
MODOROClaw-Setup (single OpenClaw workspace)
│
├── Identity Layer (existing)
│   ├── SOUL.md          — core philosophy and behavioral principles
│   ├── IDENTITY.md      — name, style, persona
│   └── USER.md          — owner profile
│
├── Safety Layer (existing)
│   ├── AGENTS.md        — operating rules and protocols
│   ├── STOP → DESCRIBE → WAIT error handling
│   ├── Execution limits (20 min/task, 20 loop max)
│   └── Config file protection
│
├── Memory Layer (existing)
│   ├── memory/          — long-term storage (people, projects, decisions)
│   ├── SQLite + FTS5    — searchable memory database
│   └── meditations/     — self-reflection framework
│
├── Channel Layer (new)
│   ├── Telegram Bot      — CEO's private command center
│   │   ├── Receives: briefings, alerts, Zalo draft approvals
│   │   └── Sends: commands, approvals, task requests
│   └── Zalo OA           — customer/employee-facing
│       ├── Receives: customer/employee messages
│       └── Sends: CEO-approved replies only (draft mode)
│
├── Workflow Layer (new) — Phase 1-5
│   ├── Morning Briefing  — cron-scheduled daily digest
│   ├── Zalo Monitor      — watch + summarize + draft replies
│   ├── Alert Watchers    — competitor/social/KPI monitoring
│   ├── Task Delegation   — conversational commands via Telegram
│   └── Onboarding Wizard — guided first-run setup
│
└── Execution Layer (new)
    ├── Scheduler          — cron engine (from Claw-X or node-cron)
    ├── Data Aggregation   — web scraping, RSS, API fetchers
    └── Curated Skills     — whitelisted subset from Claw-X (5-10 proven skills)
```

## 5. Channel Design

### 5.1 Telegram — CEO Command Center

**Plugin:** OpenClaw native Telegram channel (built-in, well-supported).

**Authentication:** During onboarding, the CEO's Telegram chat ID is recorded and stored in `USER.md`. All subsequent commands are validated against this chat ID at the plugin level. If an unrecognized chat ID sends a message, the bot responds with a generic "unauthorized" message and logs the attempt. No commands are processed, no data is exposed.

**Capabilities used:**
- Rich text messages (markdown formatting for briefings)
- Inline keyboards (approve/edit/reject buttons for Zalo drafts)
- Direct message conversation (task delegation)
- File sending (reports, summaries)

**Message types the CEO receives:**
- Morning briefing (daily, scheduled)
- Zalo message summaries with draft reply + approve/edit/reject buttons
- Proactive alerts (monitoring triggers)
- Task completion confirmations

**Message types the CEO sends:**
- Approval taps (inline keyboard)
- Edited replies (text corrections before sending to Zalo)
- Task commands ("summarize this document", "draft email to X")
- Configuration commands ("change briefing time to 7am")

### 5.2 Zalo OA — Customer/Employee Channel

**Plugin:** `@openclaw/zalo` (install via `openclaw plugins install @openclaw/zalo`).

**Capabilities used:**
- Direct message receiving (customer/employee messages)
- Text reply sending (CEO-approved replies only)
- Webhook mode for real-time message capture

**Zalo OA token lifecycle:**
- Zalo OA access tokens expire periodically (typically 90 days)
- The system monitors token expiry and sends a Telegram reminder 7 days before expiration: "🔑 Zalo OA token hết hạn trong 7 ngày. Nhấn [Gia hạn] để làm mới."
- CEO taps [Renew] → guided re-authentication flow via Telegram
- If token expires without renewal: Zalo monitoring pauses, CEO gets an alert on Telegram, morning briefing notes "⚠️ Zalo OA disconnected — tap [Reconnect] to fix"
- Token stored encrypted in local config, never in memory/SQLite

**Zalo OA account requirement:** CEO must have a Zalo Official Account (free or verified tier). Onboarding wizard checks this in Step 2. If they don't have one, the wizard provides a link to create one and pauses until connected.

**Known limitations (design around these):**
- 2,000 character message limit (chunk long replies)
- No group support (Marketplace bots only — DMs only)
- Media handling unreliable (don't promise image/file support)
- No streaming (send complete messages only)
- Rate limits vary by OA tier — system respects `min(self-imposed, platform-imposed)` limits

**Draft Mode Flow:**

```
Customer/Employee sends message on Zalo
        │
        ▼
OpenClaw Zalo plugin receives message
        │
        ▼
Assistant analyzes message context
(checks memory for customer history, ongoing conversations)
        │
        ▼
Assistant drafts reply
        │
        ▼
Draft sent to CEO on Telegram with:
  - Original message (quoted)
  - Sender info
  - Draft reply
  - [Approve] [Edit] [Skip] buttons
        │
        ▼
CEO taps Approve ──────────► Assistant sends reply on Zalo
CEO taps Edit ─────────────► CEO types correction → sends on Zalo
CEO taps Skip ─────────────► No reply sent, logged for later
```

**Safety guarantee:** The assistant NEVER sends a Zalo reply without explicit CEO approval. This is enforced at the plugin level, not just by prompt instructions.

## 6. Workflow Phases

### Phase 1: Morning Briefing

**Priority:** Highest. This is the "wow moment" on day one.

**How it works:**
1. Cron job triggers daily at CEO's configured time (default: 7:00 AM ICT)
2. Data aggregation runs in parallel:
   - Vietnamese business news (RSS feeds from VnExpress, CafeBiz, etc.)
   - Competitor website changes (configurable list of URLs)
   - Weather for CEO's city
   - Zalo OA overnight messages summary (if Phase 2 is active)
3. Assistant compiles briefing using identity/style from SOUL.md
4. Sends formatted briefing to CEO's Telegram

**Briefing template:**

```
☀️ Chào buổi sáng, [CEO name]

📰 TIN TỨC
• [Headline 1] — [1-line summary]
• [Headline 2] — [1-line summary]
• [Headline 3] — [1-line summary]

🏢 ĐỐI THỦ
• [Competitor]: [notable change or "không có thay đổi"]

💬 ZALO (qua đêm)
• [X] tin nhắn mới từ [Y] người
• Cần phản hồi: [summary of pending messages]

🌤️ Thời tiết: [City] — [temp]°C, [condition]

Chúc [honorific] một ngày hiệu quả! 🦞
```

*Note: Template is illustrative. Actual format driven by SOUL.md/IDENTITY.md style. Honorific (anh/chị/etc.) configured during onboarding based on CEO preference.*

**Data sources (Phase 1 — public only):**
- RSS feeds (VnExpress, CafeBiz, Tuoi Tre, etc.)
- Competitor URLs (simple change detection via hash comparison)
- Weather API (OpenWeatherMap free tier)
- Zalo message count (from Phase 2 integration)

**Failure handling:**
- If any data source fails, briefing still sends with available data + note about what failed
- If cron fails entirely, CEO gets a "missed briefing" alert when system recovers
- All failures logged to memory for debugging

**Reliability target:** 99% delivery rate over 30 days (max 1 missed briefing per month).

### Phase 2: Zalo Monitor + Draft Replies

**Priority:** High. This is the daily utility that keeps CEOs engaged.

**How it works:**
1. Zalo OA webhook receives incoming messages in real-time
2. Assistant processes each message:
   - Identifies sender (checks memory for existing profile)
   - Classifies intent (question, complaint, request, greeting, etc.)
   - Checks conversation history for context
3. Drafts a reply in the CEO's voice (using SOUL.md/IDENTITY.md style)
4. Sends to CEO on Telegram for approval (see Draft Mode Flow above)
5. On approval, sends reply via Zalo OA

**Batching logic:**
- During business hours (8 AM - 9 PM): real-time drafts, sent to Telegram immediately
- Outside business hours: messages collected, summarized in next morning briefing
- CEO can configure quiet hours

**Memory integration:**
- New contacts automatically get a profile in `memory/people/`
- Conversation history stored for context in future interactions
- Recurring questions flagged for potential FAQ automation (Phase 3 upgrade path)

**Stale draft policy:**
- If CEO hasn't acted on a draft within 2 hours during business hours: send a Telegram reminder
- If no action within 4 hours: mark as "skipped" and log
- CEO can configure an auto-acknowledgment message for Zalo (e.g., "Chúng tôi đã nhận tin nhắn, sẽ phản hồi sớm") — disabled by default

**Reliability target:** 100% message capture (no Zalo messages lost). Draft quality measured as: `approvals / (approvals + edits + skips)` over trailing 7 days — target >= 90%. System logs all approval events for measurement.

### Phase 3: Monitoring & Alerts

**Priority:** Medium. Builds on Phase 1 infrastructure.

**How it works:**
1. CEO configures watchers during onboarding or via Telegram commands:
   - Competitor URLs to monitor
   - Keywords to track on social media
   - Simple KPI thresholds (if connected to data source)
2. Cron jobs run at configured intervals (hourly/daily)
3. When a trigger fires, assistant sends alert to CEO on Telegram

**Alert types:**
- Competitor website changed (new product, pricing change, new blog post)
- Brand mention detected (configurable sources)
- KPI threshold crossed (requires Phase 4 integration with business tools)

**Alert format:**

```
🚨 CẢNH BÁO: [Type]

[What changed / what was detected]
[Link to source]

Hành động đề xuất: [Assistant's suggested action]
[Acknowledge] [Investigate] [Dismiss]
```

**Reliability target:** Monitoring checks execute on schedule 99%+ of the time. Known limitation: hash-based detection may miss JavaScript-rendered or CDN-cached changes — document this to CEO as a constraint, not a bug. Acceptable false positive rate < 10%.

### Phase 4: Task Delegation

**Priority:** Medium-low. Requires trust built from Phases 1-3.

**How it works:**
1. CEO sends a natural language command on Telegram
2. Assistant parses intent and confirms understanding before executing
3. Executes task using available tools/skills
4. Reports result back on Telegram

**Supported tasks (curated, reliability-first):**
- Draft text content (emails, announcements, social posts)
- Summarize documents (paste text or forward messages)
- Look up information (web search, memory search)
- Set reminders and follow-ups
- Generate simple reports from collected data

**Not supported (explicitly scoped out for reliability):**
- Direct email sending (draft only — CEO sends)
- Financial transactions
- Anything requiring browser automation (too fragile)
- Calendar management (requires OAuth — future phase)

**Confirmation pattern:**
Every task follows: `CEO commands → Assistant confirms understanding → CEO confirms → Assistant executes → Assistant reports result`. No silent execution.

**Reliability target:** 90% task completion without retry. 100% confirmation before execution.

### Phase 5: Onboarding Wizard

**Priority:** Built last, but experienced first by the CEO.

**How it works:**
1. CEO installs OpenClaw with MODOROClaw workspace
2. First run triggers BOOTSTRAP.md guided flow
3. Step-by-step setup via Telegram conversation:

```
Step 1: "Xin chào! Tôi là trợ lý AI của bạn. Hãy bắt đầu thiết lập."
        → CEO enters their name, company name, city

Step 2: "Hãy kết nối Zalo OA của bạn."
        → Guided Zalo OA token setup

Step 3: "Bạn muốn nhận báo cáo buổi sáng lúc mấy giờ?"
        → CEO picks briefing time

Step 4: "Hãy cho tôi biết 3 đối thủ chính của bạn."
        → CEO enters competitor URLs

Step 5: "Thiết lập hoàn tất! Báo cáo đầu tiên sẽ đến lúc [time]."
        → System schedules first briefing
        → If time hasn't passed today, sends a mini-briefing immediately as proof
```

**Quick win:** The mini-briefing at the end of onboarding. CEO sees value within minutes of setup, not the next morning.

**Reliability target:** 100% completion rate for onboarding flow. No step should fail silently.

## 7. Execution Layer — Claw-X Integration

### What we take from Claw-X:
- **Cron scheduler** — battle-tested, supports complex schedules
- **Data aggregation skills** — RSS reader, web scraper, change detector
- **Notification routing** — Telegram message formatting and delivery

### What we DON'T take:
- The full Claw-X desktop app (we're inside OpenClaw, not running a separate app)
- All 55+ skills (most are unvetted — reliability risk)
- Claw-X's own UI/dashboard (CEO uses Telegram, not a desktop app)

### Whitelisted skills (curated for reliability):

**Phase 1-3 skills:**
1. RSS feed reader
2. Web page change detector (hash-based)
3. Weather API fetcher
4. Text summarizer
5. Vietnamese news aggregator

**Phase 4 skills (vetted during Phases 1-3 stabilization period):**
6. Web search (via API, not browser)
7. Reminder/follow-up scheduler
8. Report generator (from collected data)

Additional skills added only after testing in production for 2+ weeks.

### Integration approach:
- Fork relevant Claw-X skill code into MODOROClaw-Setup repo
- Adapt to work as native OpenClaw plugins
- Remove external dependencies where possible
- Add MODORO safety wrappers (execution limits, error handling)

## 8. Safety & Error Handling

### Inherited from existing MODOROClaw-Setup:
- STOP → DESCRIBE → WAIT error protocol
- 20 minute per task execution limit
- 20 loop maximum
- Config file protection (backup before modify)
- Multi-channel authentication

### New safety rules for CEO workflows:

**Zalo draft mode enforcement:**
- Hard-coded: no Zalo outbound message without approval flag
- Not configurable by prompt — enforced in plugin code
- Audit log of all sent messages with approval timestamps

**Briefing failure recovery:**
- If morning briefing fails 2 days in a row, send a "system health" alert to CEO
- Never silently fail — always communicate what went wrong

**Data source graceful degradation:**
- Each data source in the briefing is independent
- If one fails, others still appear
- Failed source shows: "⚠️ [Source] tạm thời không khả dụng"

**Rate limiting:**
- Max 50 Telegram messages per hour (prevent spam from runaway processes)
- Max 20 Zalo replies per hour, or Zalo OA platform limit — whichever is lower
- Configurable by CEO

**Telegram authentication enforcement:**
- CEO's Telegram chat ID bound during onboarding, stored in `USER.md`
- All incoming Telegram messages validated against registered chat ID before processing
- Unauthorized attempts: generic rejection message, logged with timestamp and chat ID
- No data exposed to unauthorized users

## 9. Data Privacy & Compliance

**Vietnamese regulatory context:**
- Vietnam Cybersecurity Law (2018) and Personal Data Protection Decree (2023) apply
- Customer messages from Zalo may contain personal data

**Data residency:**
- OpenClaw instance hosted on Vietnamese cloud provider (see Section 3)
- SQLite database, memory files, and logs remain on Vietnamese infrastructure
- Telegram is used as a notification/command channel only — customer data is not stored on Telegram servers long-term

**Data handling rules:**
- Customer messages stored in local SQLite only (not synced externally)
- CEO can delete customer profiles via Telegram command
- No data shared with third parties (MODORO staff access only for support, with CEO permission)
- Zalo OA tokens stored encrypted, never in plaintext

**Consent:**
- Zalo OA inherently requires user-initiated contact (customers message the OA first)
- Auto-reply acknowledgment (if enabled) includes a note that an AI assistant is helping process messages

## 10. Data Flow Diagram

```
                    ┌─────────────────────────────┐
                    │       PUBLIC INTERNET        │
                    │  (news, competitors, weather)│
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
                    │     EXECUTION LAYER          │
                    │  ┌─────────────────────┐     │
                    │  │ Cron Scheduler       │     │
                    │  │ (morning briefing,   │     │
                    │  │  alert watchers)     │     │
                    │  └─────────┬───────────┘     │
                    │            │                  │
                    │  ┌─────────▼───────────┐     │
                    │  │ Data Aggregation     │     │
                    │  │ (RSS, scraper, APIs) │     │
                    │  └─────────┬───────────┘     │
                    └────────────┼─────────────────┘
                                 │
                    ┌────────────▼─────────────────┐
                    │      OPENCLAW CORE           │
                    │                              │
                    │  ┌──────────────────────┐    │
                    │  │ Assistant Brain       │    │
                    │  │ (SOUL + IDENTITY +    │    │
                    │  │  MEMORY + AGENTS)     │    │
                    │  └──────┬───────┬───────┘    │
                    │         │       │            │
                    └─────────┼───────┼────────────┘
                              │       │
              ┌───────────────▼─┐   ┌─▼────────────────┐
              │   TELEGRAM       │   │   ZALO OA         │
              │   (CEO private)  │   │   (public-facing)  │
              │                  │   │                    │
              │ • Briefings      │   │ • Customer msgs    │
              │ • Alerts         │   │ • Employee msgs    │
              │ • Draft approvals│   │ • Approved replies  │
              │ • Task commands  │   │                    │
              └──────────────────┘   └────────────────────┘
```

## 11. What's Explicitly Out of Scope

- **Google Calendar / Email integration** — requires OAuth, adds complexity. Future phase.
- **Browser automation** — inherently unreliable. Not promised.
- **Full autonomous Zalo replies** — draft mode only. Trust must be earned.
- **Mobile app** — CEO uses Telegram app. No custom app needed.
- **Multi-language** — Vietnamese-first. English support is not a priority.
- **AutoClaw (autoglm.z.ai)** — early access, wrong ecosystem, wrong IM platforms.
- **Full Claw-X desktop app** — we take skills, not the app itself.

## 12. Implementation Sequence

```
Phase 0 (Week 1): Minimal Onboarding Script
  → Manual setup checklist + config script for MODORO staff
  → Connects Telegram bot, Zalo OA token, basic CEO profile
  → Required for all subsequent phases to work
  → This is NOT the full onboarding wizard — just enough to get started

Phase 1 (Week 2-3): Morning Briefing
  → Cron scheduler + RSS/weather/scraper + Telegram delivery
  → CEO gets daily briefings. Trust building begins.
  → 1 week stabilization before Phase 2

Phase 2 (Week 4-6): Zalo Monitor + Draft Replies
  → Zalo OA webhook + message processing + Telegram approval flow
  → CEO manages Zalo conversations from Telegram.
  → 1 week stabilization before Phase 3

Phase 3 (Week 7-8): Monitoring & Alerts
  → Competitor watchers + social monitoring + alert routing
  → CEO gets proactive notifications.
  → 1 week stabilization before Phase 4

Phase 4 (Week 9-10): Task Delegation
  → Natural language command parsing + curated task skills
  → CEO delegates work via Telegram.
  → 1 week stabilization before Phase 5

Phase 5 (Week 11-12): Onboarding Wizard
  → Replaces Phase 0 manual script with guided self-service flow
  → Quick win mini-briefing at end of setup
  → New CEOs self-onboard without MODORO staff involvement
```

**Total timeline:** ~12 weeks development + stabilization periods included.

Each phase ships only when the previous phase has run reliably for 1+ week in production. Phases are additive — new code only, no modifications to prior phase infrastructure. If a phase must be rolled back, it can be disabled without affecting earlier phases.
