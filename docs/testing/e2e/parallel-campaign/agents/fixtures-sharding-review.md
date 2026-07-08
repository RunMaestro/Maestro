# fixtures-sharding-review

Status: first support-plan tranche ready

## Scope

Shared fixtures, reusable successful paths, selector/helper consolidation,
suite sharding plan, static review of agent branches.

## Checklist

- [x] Inspect existing fixtures and repeated E2E setup paths.
- [x] Propose helper conventions without forcing broad rewrites.
- [x] Record any shared helper changes in `broadcasts.md`.
- [x] Draft a no-execution sharding plan for later validation.
- [x] Commit lane work on `codex/e2e-fixtures-sharding-review`.

## Progress

### 2026-06-08 first support-plan tranche

- Commit: created after this document update; final lane handoff records the exact
  hash because a commit cannot contain its own final hash.
- Files touched:
  - `docs/testing/e2e/parallel-campaign/agents/fixtures-sharding-review.md`
- Shared helpers touched: none. `docs/testing/e2e/parallel-campaign/broadcasts.md` did
  not need an update.
- Static evidence reviewed:
  - `e2e/fixtures/electron-app.ts` already provides the shared launch/data
    fixture and 46 helper methods, including wizard, right panel, Auto Run, and
    session-list helpers.
  - All current E2E specs except `e2e/bionify-reading-mode.spec.ts` import
    `./fixtures/electron-app`.
  - `e2e/app-shell.spec.ts` is the largest consolidation target at about 11k
    lines, with heavy mixed-domain selector usage.
  - `e2e/group-chat.spec.ts` and `e2e/web-mobile.spec.ts` are also large, but
    their local helpers are domain-specific enough to keep local for now.
  - `git worktree list` shows the parallel lane branches and worktrees are
    present; this tranche reviewed branch/worktree shape statically only.
- Fixture/helper recommendations:
  - Keep `e2e/fixtures/electron-app.ts` as the only shared fixture module until
    at least two lane specs need the same helper.
  - Prefer small helper additions over broad page-object rewrites. New shared
    helpers should wrap stable user workflows, not incidental selector chains.
  - Good first shared-helper candidates are repeated shell affordances currently
    local to `e2e/app-shell.spec.ts`: settings openers, Quick Actions openers,
    modal-root lookup by heading, system-log/process-monitor navigation, and
    agent-session dialog navigation.
  - Keep web/mobile server helpers local to `e2e/web-mobile.spec.ts` until a
    non-mobile lane needs them.
  - Keep group-chat IPC stubs local until another lane consumes the same stubs.
- Selector consolidation notes:
  - Prefer `getByRole` with accessible names for durable user-facing controls.
  - Add `data-testid` only for dense shell widgets, repeated icon-only buttons,
    virtualized lists, or controls whose text is user-generated or localized.
  - Avoid adding shared helpers for one-off `locator()` calls. Extract only when
    the same user action or shell region appears in multiple specs.
  - When a helper wraps a selector, keep the helper name user-action oriented:
    `openQuickActions`, `openAgentSessions`, `getSessionList`.
- Later-phase sharding plan:
  - Split `e2e/app-shell.spec.ts` before adding major new coverage there. Use
    workflow files such as shell tabs/commands, settings and SSH, Git/Quick
    Actions, system logs/process monitor, session list/groups, and file preview.
  - Keep each lane's new scenarios in its domain spec instead of expanding
    `app-shell.spec.ts`.
  - After the orchestrator approves E2E execution, balance CI shards by observed
    runtime, with static line count only as a temporary proxy.
  - Defer any `playwright test --list` or runtime sharding validation until the
    orchestrator explicitly allows Playwright commands.
- Checks run:
  - `npx prettier --check docs/testing/e2e/parallel-campaign/agents/fixtures-sharding-review.md`
  - `git diff --check`
- E2E execution deliberately not run:
  - Did not run `npm run test:e2e`, `playwright test`, headed/UI E2E, or
    `npx playwright test --list`.
  - Did not use the E2E Runner skill.
- Remaining lane target:
  - Review later lane commits after the scenario lanes land their first
    tranches, then update this doc with concrete helper extraction candidates.
  - Broadcast shared helper guidance only if a later tranche edits shared helper
    code.
- Blockers and follow-up:
  - No blocker for this documentation tranche.
  - Runtime shard sizing remains blocked by the campaign-wide no-Playwright rule.
