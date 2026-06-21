# Parallel E2E Coverage Campaign Plan

Historical authoring prompt. The parallel authoring campaign is complete. Use `docs/testing/current-status.md` and `docs/testing/game-plan.md` for the current plan, and use this file only to understand how the PM2 lane campaign was launched.

## Summary

The Maestro E2E authoring campaign ran on `codex/full-e2e-coverage-campaign` without running Playwright E2E tests. It started from 638 declared E2E tests against a 3,025 active-test target and used PM2-managed Codex lane agents to author the remaining matrix-backed scenarios plus documented skipped/env-gated cases.

Use PM2-managed codex exec agents for parallel authoring, but isolate each agent in its own git worktree
and feature branch. Shared-worktree rapid commits are a bad approach here because docs, fixtures, and
helpers are shared surfaces and concurrent commits can race or accidentally include another agent’s edits.

## Key Changes

- Create docs/testing/e2e/parallel-campaign/ with:
  - README.md: parallel campaign method, no-E2E-run rule, branch/worktree workflow.
  - orchestrator-status.md: high-level dashboard, agent states, blockers, next merges.
  - coverage-ledger.md: matrix copied from docs/testing/e2e/coverage-campaign.md, recalculated after each merge.
  - broadcasts.md: cross-agent findings and shared helper conventions.
  - agents/<lane>.md: one progress log per agent with checklist, files touched, test counts, blockers,
    commit hashes.

- Keep docs/testing/e2e/coverage-campaign.md as the canonical coverage matrix and update it after every accepted
  agent branch.

- Keep docs/testing/audits/test-coverage-audit.md for campaign checkpoints; record that E2E tests are authored but
  intentionally not executed in this phase.

- Preserve existing dirty work first: inspect current modified files, create an orchestrator checkpoint
  commit or stash only after confirming ownership, then branch all agents from the same clean base.

## Agent Lanes

Launch each lane as a one-shot PM2 process with --no-autorestart, using codex exec --cd <lane-worktree>
--dangerously-bypass-approvals-and-sandbox. Every agent must update its docs/testing/e2e/parallel-campaign/agents/
<lane>.md, commit frequently with gac -m "test(e2e-<lane>): ..." or equivalent, and never run E2E tests.

- agent-crud-provider: Agent CRUD, provider setup, Agent Sessions. Target remaining: about 104 active
  tests.

- shell-tabs-command: app shell, sidebars, global shortcuts, tabs, command terminal. Target remaining:
  about 366 active tests.

- files-docs-history: file explorer, file preview, document rendering, history. Target remaining: about
  349 active tests.

- autorun-ai-terminal: Auto Run plus Codex-only terminal workflows. Target remaining: about 273 active
  tests.

- wizard-settings-prompts: New Agent Wizard, inline wizard, Settings, Director Notes, prompt composer.
  Target remaining: about 372 active tests.

- git-groupchat-playbooks: Git/worktrees/PR/diff/log/Gist, group chat, playbooks, marketplace, Spec Kit,
  OpenSpec. Target remaining: about 363 active tests.

- stats-graph-symphony: usage dashboard, stats, document graph, Symphony, leaderboard, achievements.
  Target remaining: about 336 active tests.

- debug-accessibility: debug/about/update/process/error modals, destructive confirmations, accessibility
  smoke. Target remaining: about 192 active tests.

- mobile-web-bridge: mobile/web bridge only. Target remaining: about 102 active tests.
- fixtures-sharding-review: shared fixtures, reusable successful paths, selector/helper consolidation,
  suite sharding plan, static review of agent branches. No scenario quota; supports the other lanes.

## Orchestration Rules

- Orchestrator owns docs/testing/e2e/parallel-campaign/orchestrator-status.md, coverage-ledger.md, broadcasts.md,
  and final merges.

- Agents own their lane spec files and lane progress file; shared helper edits require a note in
  broadcasts.md.
- Agents must not run npm run test:e2e, playwright test, headed/UI E2E, or full E2E validation.
- Allowed checks: static review, TypeScript-aware editor checks, targeted non-E2E lint/type checks if they
  do not run E2E.

- Do not send routine lane quota emails. Email reports are reserved for major completion milestones that
  represent at least 6 hours of work or final gate completion; otherwise record the update in the lane
  progress file and orchestrator status docs.

- Merge one agent branch at a time into the campaign branch, resolve conflicts centrally, update docs and
  ledger, then broadcast any helper/API changes to active agents.

## PM2 Launch Pattern

Use one PM2 process per lane:

pm2 start "codex exec --cd /Users/jeffscottward/Github/tools/Maestro-worktrees/e2e-<lane> --dangerously-
bypass-approvals-and-sandbox - < docs/testing/prompts/e2e-agents/<lane>.md" --name "maestro-e2e-<lane>" --no-autorestart
--time

Inspect with:

pm2 logs maestro-e2e-<lane> --lines 200
pm2 show maestro-e2e-<lane>

## Test Plan

- Do not run E2E tests during this authoring campaign.
- For each branch, perform static review of selectors, fixtures, scenario names, and assertions.
- Use npx playwright test --list only if later approved, because it does not execute tests but still loads
  Playwright.

- Final validation is deferred to a later execution phase, likely sharded because playwright.config.ts
  currently has workers: 1 and fullyParallel: false.

## Post-Authoring Execution Phase

Multiple Maestro/Electron shells can be run for E2E validation only as separate Playwright invocations
managed by separate PM2/Codex workers. Do not raise Playwright's in-process worker count for Electron E2E.

Execution-phase rules:

- Keep one Playwright worker per process.
- Assign each PM2/Codex worker a disjoint spec shard.
- Give every shard unique HOME, MAESTRO_DATA_DIR, Playwright --output, and report paths.
- Build once before launching shards, or use separate worktrees per shard. Do not run npm run test:e2e
  concurrently because it rebuilds shared dist outputs before invoking Playwright.
- Give any web/mobile shard a unique VITE_PORT or a unique portless route.
- Start with two shards, inspect pm2 logs and artifacts, then scale only if both exit cleanly.

Example execution-worker command after explicit E2E approval:

```bash
pm2 start "codex exec --cd /Users/jeffscottward/Github/tools/Maestro --dangerously-bypass-approvals-and-sandbox - < docs/testing/prompts/e2e-agents/<execution-shard>.md" --name "maestro-e2e-run-<execution-shard>" --no-autorestart --time
```

Each execution-shard prompt should run direct Playwright commands against owned specs, not npm run
test:e2e, for example:

```bash
HOME=/tmp/maestro-e2e-<execution-shard>/home \
MAESTRO_DATA_DIR=/tmp/maestro-e2e-<execution-shard>/data \
PLAYWRIGHT_HTML_REPORT=playwright-report/<execution-shard> \
VITE_PORT=<unique-port> \
./node_modules/.bin/playwright test e2e/<owned-spec>.spec.ts --workers=1 --output=e2e-results/<execution-shard>
```

## Assumptions

- “100% coverage” for this phase means 100% planned E2E scenario coverage against the campaign matrix, not
  proven runtime pass status.

- Per-agent worktrees are mandatory despite the initial shared-worktree preference, because they are the
  minimal safe way to parallelize commits.

- Existing dirty work is in-flight and must be preserved before spawning agents.
- Live provider E2E remains Codex-only; non-Codex/provider-account flows stay static or environment-gated
  per the campaign scope.
