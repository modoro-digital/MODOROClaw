# MODOROClaw CEO Workspace — Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Add workflow layer (briefings, Zalo monitoring, alerts, task delegation, onboarding) to MODOROClaw-Setup.

**Architecture:** OpenClaw workspace with cron-driven data aggregation → Telegram delivery + Zalo OA webhook → draft-mode approval flow. All plugins native to OpenClaw.

**Tech Stack:** OpenClaw, Python, node-cron, Telegram Bot API, Zalo OA API, SQLite, RSS parsing

**Spec:** `docs/superpowers/specs/2026-04-04-modoro-claw-ceo-workspace-design.md`

---

## Phase 0: Minimal Onboarding Script (Week 1)

- [ ] Create `scripts/setup.sh` — config script that prompts for: CEO name, Telegram bot token, Telegram chat ID, Zalo OA token, city, briefing time
- [ ] Write values into `USER.md` and OpenClaw channel configs (`channels.telegram`, `channels.zalo`)
- [ ] Add `docs/setup-checklist.md` — manual steps for MODORO staff (create Telegram bot via BotFather, get Zalo OA token, run setup script)
- [ ] Test: run script, verify OpenClaw starts and Telegram bot responds to CEO chat ID only

## Phase 1: Morning Briefing (Week 2-3)

- [ ] Create `plugins/briefing/rss_fetcher.py` — fetch Vietnamese news from configurable RSS feed list
- [ ] Create `plugins/briefing/weather_fetcher.py` — OpenWeatherMap API call for CEO's city
- [ ] Create `plugins/briefing/competitor_watcher.py` — hash-based change detection for list of URLs
- [ ] Create `plugins/briefing/compiler.py` — assembles briefing text from all sources, handles failures gracefully (skip failed source, note it)
- [ ] Create `plugins/briefing/cron_job.py` — node-cron trigger at configured time, calls compiler, sends via Telegram
- [ ] Add `config/briefing.json` — RSS feeds, competitor URLs, weather city, cron schedule
- [ ] Test: trigger manually, verify Telegram delivery with partial data (kill one source intentionally)

## Phase 2: Zalo Monitor + Draft Replies (Week 4-6)

- [ ] Create `plugins/zalo_monitor/webhook_handler.py` — receives Zalo messages, stores in SQLite, creates contact profile if new
- [ ] Create `plugins/zalo_monitor/draft_engine.py` — analyzes message, drafts reply using SOUL.md voice
- [ ] Create `plugins/zalo_monitor/approval_flow.py` — sends draft to Telegram with inline keyboard (Approve/Edit/Skip), handles callbacks
- [ ] Create `plugins/zalo_monitor/sender.py` — on approval, sends reply via Zalo OA API. Hard-coded approval check (no bypass possible)
- [ ] Create `plugins/zalo_monitor/stale_checker.py` — cron: remind CEO after 2h, auto-skip after 4h
- [ ] Add business hours config to `config/zalo_monitor.json` — quiet hours, auto-ack message (disabled by default)
- [ ] Integrate overnight Zalo summary into Phase 1 briefing compiler
- [ ] Test: send test Zalo message, verify full flow through Telegram approval to Zalo reply

## Phase 3: Monitoring & Alerts (Week 7-8)

- [ ] Create `plugins/alerts/watcher_manager.py` — manages list of active watchers from config + Telegram commands
- [ ] Create `plugins/alerts/competitor_alert.py` — reuse Phase 1 competitor_watcher, but triggers alert instead of briefing section
- [ ] Create `plugins/alerts/keyword_tracker.py` — search configurable sources for brand/keyword mentions
- [ ] Create `plugins/alerts/alert_sender.py` — formats alert, sends to Telegram with Acknowledge/Investigate/Dismiss buttons
- [ ] Add `config/alerts.json` — watcher definitions, check intervals, keywords
- [ ] Test: change a monitored URL, verify alert fires within configured interval

## Phase 4: Task Delegation (Week 9-10)

- [ ] Create `plugins/tasks/command_parser.py` — parse CEO's Telegram message into intent (draft, summarize, search, remind, report)
- [ ] Create `plugins/tasks/confirm_flow.py` — send understanding back to CEO, wait for confirm before executing
- [ ] Create `plugins/tasks/executor.py` — routes to appropriate skill: text summarizer, web search API, reminder scheduler, report generator
- [ ] Create `plugins/tasks/reminder.py` — cron-based reminder delivery via Telegram
- [ ] Test: send "tóm tắt tin nhắn hôm nay" via Telegram, verify confirmation → execution → result

## Phase 5: Onboarding Wizard (Week 11-12)

- [ ] Create `plugins/onboarding/wizard.py` — replaces Phase 0 script with conversational Telegram flow (5 steps from spec)
- [ ] Create `plugins/onboarding/validator.py` — verify Telegram bot token works, Zalo OA token is valid, weather API responds for city
- [ ] Create `plugins/onboarding/quick_win.py` — trigger a mini-briefing immediately after setup completes
- [ ] Update `BOOTSTRAP.md` to trigger wizard on first Telegram contact
- [ ] Test: fresh instance, verify CEO can self-onboard and receives mini-briefing

---

## Cross-cutting

- [ ] Rate limiter middleware: 50 Telegram/hr, min(20, platform-limit) Zalo/hr
- [ ] Zalo token expiry monitor: check daily, alert 7 days before expiry
- [ ] Structured logging: all plugins log to `logs/` with timestamps, levels, searchable format
- [ ] Daily SQLite backup script in `scripts/backup.sh`
