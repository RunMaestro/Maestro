# Parallel E2E Coverage Campaign

This directory coordinates the no-execution E2E authoring campaign described in
`docs/testing/prompts/e2e-parallel-campaign-plan.md`.

Current state: authoring is complete. The canonical matrix is 3,025 / 3,025 active scenarios with 0 matrix-backed scenarios remaining. Full PM2-sharded Playwright/Electron execution has completed once and Phase 5 stabilization is in progress; see `docs/testing/current-status.md` for the current pass/fail state.

## Rules

- Do not run Playwright E2E in this phase.
- Do not run `npm run test:e2e`, `playwright test`, `test:e2e:ui`, headed E2E,
  UI-mode E2E, or full E2E validation.
- `npx playwright test --list` is also off-limits unless the orchestrator later
  approves it explicitly.
- Allowed checks are static review, TypeScript-aware editor checks, and targeted
  non-E2E lint/type checks that do not load or execute Playwright.
- Live provider coverage remains Codex-only. Non-Codex provider flows should be
  static UI/configuration/disabled-state coverage unless a local reliable
  provider is available.
- Network-backed flows should use deterministic mocks, local fixtures, or
  explicit skipped/environment-gated cases when real external state is required.

## Workflow

1. The orchestrator commits this scaffold on `codex/full-e2e-coverage-campaign`.
2. Each lane runs in its own worktree under
   `/Users/jeffscottward/Github/tools/Maestro-worktrees/e2e-<lane>`.
3. Each lane owns a feature branch named `codex/e2e-<lane>`.
4. Each lane updates only its lane specs and
   `docs/testing/e2e/parallel-campaign/agents/<lane>.md`.
5. Shared helper edits are allowed only when the lane records the convention in
   `docs/testing/e2e/parallel-campaign/broadcasts.md`.
6. Agents commit frequently with `gac -m "test(e2e-<lane>): ..."` or an
   equivalent targeted `git add`/`git commit` when `gac` would stage unrelated
   work.
7. The orchestrator merges one lane branch at a time, resolves conflicts
   centrally, updates `coverage-ledger.md`, and broadcasts shared changes.

## Lane Summary

| Lane                       | Scope                                                                                   | Accepted active | Skipped/env-gated | Remaining |
| -------------------------- | --------------------------------------------------------------------------------------- | --------------: | ----------------: | --------: |
| `agent-crud-provider`      | Agent CRUD, provider setup, Agent Sessions                                              |             104 |                 2 |         0 |
| `shell-tabs-command`       | App shell, sidebars, global shortcuts, tabs, command terminal                           |             266 |                 0 |         0 |
| `files-docs-history`       | File explorer, file preview, document rendering, history                                |             354 |                 5 |         0 |
| `autorun-ai-terminal`      | Auto Run plus Codex-only AI terminal workflows                                          |             273 |                 0 |         0 |
| `wizard-settings-prompts`  | New Agent Wizard, inline wizard, Settings, Director Notes, prompt composer              |             372 |                 1 |         0 |
| `git-groupchat-playbooks`  | Git/worktrees/PR/diff/log/Gist, group chat, playbooks, marketplace, Spec Kit, OpenSpec  |             363 |                 7 |         0 |
| `stats-graph-symphony`     | Usage dashboard, stats, document graph, Symphony, leaderboard, achievements             |             341 |                 6 |         0 |
| `debug-accessibility`      | Debug/about/update/process/error modals, destructive confirmations, accessibility smoke |             192 |                 0 |         0 |
| `mobile-web-bridge`        | Mobile/web bridge only                                                                  |             102 |                 0 |         0 |
| `fixtures-sharding-review` | Shared fixtures, selector/helper consolidation, sharding plan, static branch review     |               0 |                 0 |         0 |

## PM2

Each lane is launched as a one-shot PM2 process with `--no-autorestart`:

```bash
pm2 start "codex exec --cd /Users/jeffscottward/Github/tools/Maestro-worktrees/e2e-<lane> --dangerously-bypass-approvals-and-sandbox - < docs/testing/prompts/e2e-agents/<lane>.md" --name "maestro-e2e-<lane>" --no-autorestart --time
```

Inspect a lane with:

```bash
pm2 logs maestro-e2e-<lane> --lines 200
pm2 show maestro-e2e-<lane>
```

Stop all Maestro E2E PM2 lanes and any Playwright/Electron child process groups with:

```bash
npm run test:e2e:stop
```

## E2E Execution Sharding

Post-authoring E2E execution is feasible as multiple PM2-managed Codex workers that each run a separate Playwright shard in its own Maestro/Electron app process. Do not make a single Playwright invocation parallel: `playwright.config.ts` intentionally keeps Electron E2E serial with `fullyParallel: false` and `workers: 1`.

Use this mode only after the orchestrator explicitly approves E2E execution. Keep each shard isolated:

- One PM2 one-shot Codex process per shard.
- One Playwright worker per process.
- Distinct spec ownership so two shards do not run the same spec file.
- Distinct `HOME`, `MAESTRO_DATA_DIR`, Playwright `--output`, and report paths.
- If a shard uses Playwright browser contexts while `HOME` is isolated, set
  `PLAYWRIGHT_BROWSERS_PATH` to an installed browser cache outside the isolated
  home, or install browsers into the isolated home before launching the shard.
- Build artifacts prepared once by the orchestrator before shard launch, or separate worktrees per shard. Do not let several shards run `npm run test:e2e` concurrently because that script rebuilds shared `dist/` outputs before invoking Playwright.
- Unique web/mobile server ports when a shard starts a web server; set `VITE_PORT` or route through `portless` per shard.

Recommended first trial is two shards, each running direct Playwright commands after a single shared build:

```bash
pm2 start "codex exec --cd /Users/jeffscottward/Github/tools/Maestro --dangerously-bypass-approvals-and-sandbox - < docs/testing/prompts/e2e-agents/<execution-shard>.md" --name "maestro-e2e-run-<execution-shard>" --no-autorestart --time
```

Each execution-shard prompt should run only its assigned specs, for example:

```bash
HOME=/tmp/maestro-e2e-<execution-shard>/home \
MAESTRO_DATA_DIR=/tmp/maestro-e2e-<execution-shard>/data \
PLAYWRIGHT_BROWSERS_PATH=/Users/jeffscottward/Library/Caches/ms-playwright \
PLAYWRIGHT_HTML_REPORT=playwright-report/<execution-shard> \
VITE_PORT=<unique-port> \
./node_modules/.bin/playwright test e2e/<owned-spec>.spec.ts --workers=1 --output=e2e-results/<execution-shard>
```

Scale past two shards only after confirming both shards exit cleanly and their artifacts stay separated.

If a shard must be interrupted, use `npm run test:e2e:stop` instead of only
`pm2 stop`; the stop script removes `maestro-e2e*` PM2 entries and sweeps
their Playwright/Electron child process groups.
