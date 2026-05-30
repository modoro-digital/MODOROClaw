---
name: handoff
description: Create a session handover document when ending a work session or switching context
trigger: /handoff
---

# Session Handoff

Create a comprehensive handover document so the next session (or a different agent) can pick up exactly where you left off.

## When to Use

- End of a long work session
- Before switching to a different task/branch
- When handing off to another developer or agent
- When context is too large and needs fresh start

## File Strategy

**Single file: `HANDOVER.md`** — always overwrite with latest session. Previous sessions are in git history if needed. One file = next session always reads the same path, no hunting for dates.

If a session-specific archive is needed, move the old one to `docs/handovers/YYYY-MM-DD.md` before overwriting.

## Process

1. **Read recent git history** — `git log --oneline -20` + `git diff --stat`
2. **Check uncommitted changes** — `git status --short`
3. **Read DEVLOG.md** — for context on what was planned
4. **Read docs/customer-reports.md** — for open issues
5. **Check running processes** — any background builds, tests, crons

## Handoff Document Template

Write to `HANDOVER.md` in project root:

```markdown
# Session Handover — YYYY-MM-DD

## Summary
[1-2 sentences: what was the goal, what was achieved]

## What Was Done
[Grouped by feature/fix. Each item: what, why, file(s), status]

## Customer Bugs Fixed
[Table: #, bug, status]

## Test Results
[Table: what was tested, pass/fail, known issues]

## Files Changed
[Grouped: core code, docs, tests, configs]

## Build Status
[EXE/DMG built? Committed? Pushed? Released? Tag?]

## Not Done / Next Steps
[Numbered list of what remains, ordered by priority]

## Architecture Decisions
[Key decisions made and why — so next session doesn't re-debate them]
```

## Rules

- **Be specific** — file paths, line numbers, exact error messages
- **State what works AND what doesn't** — no false confidence
- **Include test evidence** — not just "tested", but pass/fail counts
- **Link to specs/plans** — so next session can read the full context
- **Mention customer reports** — open issues that need attention
- **Git state** — branch, uncommitted changes, pushed/not-pushed
- **Don't summarize code** — the code speaks for itself. Summarize decisions and status.
