# Bug 005 — MessageHistory null session access

## Severity

P1 — render error / dev console warnings when session disappears mid-render.

## What's wrong

In `src/web/mobile/MessageHistory.tsx`, tab and AI-tab data is accessed without null guards (`session.aiTabs[…]`, `session.activeTabId`). If the active session is cleared during a scroll/render cycle (related to the same race as bug 001), rendering throws "Cannot read property of undefined."

## Acceptance criteria

- [ ] All `session.*`, `session.aiTabs`, and tab-data accesses use optional chaining or early-return
- [ ] When session is null: render fallback (e.g. empty state, "Session ended" placeholder)
- [ ] No console warnings during the session-disappears-mid-render flow
- [ ] No regression on the happy path
- [ ] Lint, ESLint, tests all green

## Implementation tasks

- [ ] Read `MessageHistory.tsx` fully — note every `session.X` access
- [ ] Add optional chaining: `session?.aiTabs`, `session?.activeTabId`
- [ ] Identify the rendering branches that depend on session — short-circuit early when session is missing
- [ ] Add a fallback render: `{!session && <EmptyState message="Session unavailable" />}`
- [ ] Apply the same pattern to sibling components if you spot the same issue (note in Follow-ups, don't go beyond MessageHistory unless trivial)
- [ ] Run validation
- [ ] Commit: `fix(web): null-check session access in MessageHistory`

## Verify-first

```bash
git log --oneline -20 -- src/web/mobile/MessageHistory.tsx
```

## Pitfalls

- Optional chaining shouldn't paper over real bugs — if a code path _expects_ session to exist, that's a hint the component shouldn't render at all in the null case (lift the check higher)
- TypeScript may have been lying about non-nullable types — fix the types too if you find them wrong
