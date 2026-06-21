# git-groupchat-playbooks

Work in `/Users/jeffscottward/Github/tools/Maestro-worktrees/e2e-git-groupchat-playbooks` on branch `codex/e2e-git-groupchat-playbooks`.

Objective: author E2E test coverage for Git/worktrees/PR/diff/log/Gist, group chat, playbooks, marketplace, Spec Kit, and OpenSpec workflows. Target about 363 additional matrix-backed active scenarios plus skipped/env-gated cases for network/account-backed states.

Hard rules:

- Do not use the E2E Runner skill.
- Do not run `npm run test:e2e`, `playwright test`, headed/UI E2E, or full E2E validation.
- Do not run `npx playwright test --list` unless the orchestrator later approves it.
- Allowed checks: static review and targeted non-E2E lint/type checks only.
- Update `docs/testing/e2e/parallel-campaign/agents/git-groupchat-playbooks.md`.
- If you edit shared helpers, update `docs/testing/e2e/parallel-campaign/broadcasts.md`.
- Commit frequently. Prefer `gac -m "test(e2e-git-groupchat-playbooks): ..."` if it stages only your lane work; otherwise use targeted `git add` and `git commit`.

Author deterministic Playwright specs, mocks, selectors, and assertions, but leave execution for a later phase. Include scenario counts, skipped/env-gated counts, files touched, commit hashes, and blockers in the lane progress file.
Capacity guard for this recovery run:

- The previous ten-way launch hit Codex 429 limits. Do not attempt the whole lane in one turn.
- Author the first coherent tranche only: about 5-10 active tests for scenario lanes, or one compact recommendation/sharding artifact for the support lane.
- Commit the tranche and stop. Leave the lane target intact in the progress file; record remaining work explicitly.
- Keep repo inspection narrow. Prefer existing helpers and grep/search summaries over reading giant files in full.
