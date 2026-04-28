# Task 001 — Execution queue indicator + browser (mobile)

## Context

Desktop shows queued messages/commands via `ExecutionQueueIndicator` (badge with count) and `QueuedItemsList` (collapsible list with reorder + cancel). Mobile has no visibility into the queue — users send commands but can't see what's waiting.

The data is already broadcast: `executionQueue` is part of `SessionData` over WebSocket.

## Desktop reference

- `src/renderer/components/ExecutionQueueIndicator.tsx` — badge with count, expand/collapse
- `src/renderer/components/QueuedItemsList.tsx` — list with reorder, cancel actions

## Web target

- New: `src/web/mobile/MobileExecutionQueueIndicator.tsx`
- New: `src/web/mobile/MobileQueuedItemsList.tsx`
- Wire-up: render the indicator in the session header next to status pills

## Acceptance criteria

- [ ] Mobile indicator shows queue depth as a numeric badge
- [ ] Tapping the indicator reveals the queue list (modal or slide-over, mobile-friendly)
- [ ] Each queued item shows: command preview (truncated to ~80 chars), position, ETA if available
- [ ] Empty queue: indicator hidden (not zero-badge)
- [ ] Reorder + cancel left for task 007 — read-only view here
- [ ] Lint, ESLint, tests all green
- [ ] No layout regression on small viewport (375x667 minimum)

## Implementation tasks

- [ ] Read `ExecutionQueueIndicator.tsx` and `QueuedItemsList.tsx` to understand the data shape
- [ ] Verify `executionQueue` is in the WebSocket payload (`src/main/web-server/` broadcast handlers)
- [ ] Create `MobileExecutionQueueIndicator.tsx` — receive queue from session context, render compact badge
- [ ] Create `MobileQueuedItemsList.tsx` — modal/sheet showing queue items, dismiss-on-tap-outside
- [ ] Wire the indicator into wherever the existing mobile session header lives (`MobileApp.tsx` or its children)
- [ ] Match existing mobile styling — use `Badge` from `src/web/components/`
- [ ] Hide the indicator when queue is empty
- [ ] Run validation
- [ ] Commit: `feat(web): port execution queue indicator to mobile`

## Pitfalls

- Don't add a new WebSocket message type — data already arrives in `SessionData`
- Don't bring over desktop's drag handles — touch reorder is task 007
- Mobile sheets need swipe-to-dismiss; reuse `useSwipeGestures` if available

## Verify-first

Before starting:

```bash
git log --oneline -20 --grep="queue"
gh pr list --state open --search "execution queue"
```
