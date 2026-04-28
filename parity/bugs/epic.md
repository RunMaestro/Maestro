# Web app bug fixes

Concrete, actionable bug fixes for `src/web/`. Run in parallel with the parity tiers; these are independent.

## Tasks

| #                                         | Title                                        | Severity | Effort |
| ----------------------------------------- | -------------------------------------------- | -------- | ------ |
| [001](001-session-crash-copy.md)          | Session crash on copy-to-clipboard           | **P0**   | S      |
| [002](002-voice-input-error-toasts.md)    | Voice input swallows errors silently         | P1       | S      |
| [003](003-keyboard-offset-debounce.md)    | iOS keyboard offset race condition           | P1       | M      |
| [004](004-offline-queue-stability.md)     | Offline queue retry without stability check  | P1       | M      |
| [005](005-message-history-null-checks.md) | MessageHistory null session access           | P1       | S      |
| [006](006-websocket-dedup-memory.md)      | WebSocket dedup set unbounded growth         | P2       | S      |
| [007](007-web-test-suite.md)              | No test coverage in src/web/                 | P2       | L      |
| [008](008-vibration-permission.md)        | Android vibration permission silent fallback | P2       | S      |

## Severity definitions

- **P0** — blocks usage; user must reload app
- **P1** — degraded UX; feature broken or unreliable
- **P2** — polish; long-term hygiene

## Suggested execution order

**Today:** 001 (P0 — session crash). Land this on its own branch, fast PR, merge.

**This week (parallel batch):** 002, 003, 005, 008. All independent, small, can run as parallel worktree playbooks.

**This week (sequential):** 004 (offline queue requires careful testing of reconnect scenarios — don't parallelize with anything that touches WebSocket).

**This month:** 006 (memory hygiene — non-urgent), 007 (test suite — large project, decompose into sub-tasks before executing).

## Verify-first

Bug reports were authored at a point in time. Each task doc starts with a verify step — confirm the bug still reproduces before fixing it. If a fix has already shipped, mark `~~obsolete~~` and skip.

```bash
git log --oneline -50 -- src/web/        # what's shipped recently
gh issue list --state open --search "web crash"
gh pr list --state open --search "fix web"
```

## Definition of done (whole lane)

- [ ] All 8 fixes merged to `origin/main`
- [ ] No regression in existing functionality
- [ ] P2 items either complete or deferred with explicit decision
- [ ] Upstream batch PR opened for the bug fixes (separate from parity batch)
