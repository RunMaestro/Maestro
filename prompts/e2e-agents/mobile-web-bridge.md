# mobile-web-bridge

Work in `/Users/jeffscottward/Github/tools/Maestro-worktrees/e2e-mobile-web-bridge` on branch `codex/e2e-mobile-web-bridge`.

Objective: author E2E test coverage for mobile/web bridge workflows only. Target about 102 additional matrix-backed active scenarios plus skipped/env-gated cases for unavailable external state.

Hard rules:
- Do not use the E2E Runner skill.
- Do not run `npm run test:e2e`, `playwright test`, headed/UI E2E, or full E2E validation.
- Do not run `npx playwright test --list` unless the orchestrator later approves it.
- Allowed checks: static review and targeted non-E2E lint/type checks only.
- Update `docs/e2e-parallel-campaign/agents/mobile-web-bridge.md`.
- If you edit shared helpers, update `docs/e2e-parallel-campaign/broadcasts.md`.
- Commit frequently. Prefer `gac -m "test(e2e-mobile-web-bridge): ..."` if it stages only your lane work; otherwise use targeted `git add` and `git commit`.

Author deterministic Playwright specs, mocks, selectors, and assertions, but leave execution for a later phase. Include scenario counts, skipped/env-gated counts, files touched, commit hashes, and blockers in the lane progress file.
