# Tier 1 — Quick Wins

Low-effort, high-value web/mobile parity tasks. All target `src/web/mobile/`. Data flows already exist via WebSocket; these are UI-only ports.

## Tasks

| #                                     | Title                                     | Effort | Depends on | Shared touchpoints        |
| ------------------------------------- | ----------------------------------------- | ------ | ---------- | ------------------------- |
| [001](001-execution-queue-mobile.md)  | Execution queue indicator + browser       | S      | —          | new component             |
| [002](002-tool-call-cards.md)         | Tool call card display in response viewer | S      | —          | `MessageHistory.tsx`      |
| [003](003-git-status-widget.md)       | Git status widget (compact)               | S      | —          | session header            |
| [004](004-thinking-status-pill.md)    | Multi-tab thinking status awareness       | S-M    | —          | `AutoRunIndicator`        |
| [005](005-achievement-badge.md)       | Achievement / Conductor badge card        | M      | —          | new component             |
| [006](006-cli-activity-banner.md)     | Playbook execution status banner          | S      | —          | `SessionStatusBanner.tsx` |
| [007](007-queue-reorder-mobile.md)    | Drag-to-reorder queued items              | M      | **001**    | `QueuedItemsList` mobile  |
| [008](008-output-truncation-badge.md) | Max-output-lines truncation indicator     | S      | —          | `ResponseViewer` footer   |

## Suggested execution order

**Parallel batch A** (no shared files): 001, 002, 003, 004, 005, 008 → kick off six worktree playbooks at once.

**Parallel batch B** (after 001 lands): 006, 007 → 007 depends on 001's queue list component; 006 lightly touches `SessionStatusBanner.tsx` which 002 may also touch — run sequentially after batch A merges.

## Verify-first checklist (run before launching)

```bash
git log --oneline -50 -- src/web/        # what shipped recently
git log --oneline -20 --grep="queue"     # any queue work in flight?
git log --oneline -20 --grep="tool"      # any tool-call work in flight?
gh pr list --state open --search "web"   # any open PRs in this space?
```

If a task here matches an open PR or a recent merge, mark it `~~obsolete~~` in this epic and skip.

## Definition of done (whole tier)

- [ ] All 8 task PRs merged to `origin/main`
- [ ] Mobile viewport visually verified (375x812)
- [ ] Upstream batch PR opened to `RunMaestro/Maestro:main`
- [ ] No `npm run lint`, `npm run lint:eslint`, or `npm run test` failures
