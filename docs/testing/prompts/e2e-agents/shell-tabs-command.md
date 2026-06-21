# shell-tabs-command

Work in `/Users/jeffscottward/Github/tools/Maestro-worktrees/e2e-shell-tabs-command` on branch `codex/e2e-shell-tabs-command`.

Objective: author E2E test coverage for app shell, sidebars, global shortcuts, tabs, tab overlays, and command terminal workflows. The canonical matrix backs 266 remaining active scenarios. The source prompt says about 366; treat the extra 100 as a proposed expansion only if you can justify it in the lane progress file.

Hard rules:

- Do not use the E2E Runner skill.
- Do not run `npm run test:e2e`, `playwright test`, headed/UI E2E, or full E2E validation.
- Do not run `npx playwright test --list` unless the orchestrator later approves it.
- Allowed checks: static review and targeted non-E2E lint/type checks only.
- Update `docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md`.
- If you edit shared helpers, update `docs/testing/e2e/parallel-campaign/broadcasts.md`.
- Commit frequently. Prefer `gac -m "test(e2e-shell-tabs-command): ..."` if it stages only your lane work; otherwise use targeted `git add` and `git commit`.

Author deterministic Playwright specs, mocks, selectors, and assertions, but leave execution for a later phase. Include scenario counts, skipped/env-gated counts, files touched, commit hashes, and blockers in the lane progress file.
