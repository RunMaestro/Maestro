# Parallel E2E Coverage Campaign

This directory coordinates the no-execution E2E authoring campaign described in
`docs/e2e-parallel-prompt.md`.

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
   `docs/e2e-parallel-campaign/agents/<lane>.md`.
5. Shared helper edits are allowed only when the lane records the convention in
   `docs/e2e-parallel-campaign/broadcasts.md`.
6. Agents commit frequently with `gac -m "test(e2e-<lane>): ..."` or an
   equivalent targeted `git add`/`git commit` when `gac` would stage unrelated
   work.
7. The orchestrator merges one lane branch at a time, resolves conflicts
   centrally, updates `coverage-ledger.md`, and broadcasts shared changes.

## Lanes

| Lane | Scope | Matrix-backed remaining |
| --- | --- | ---: |
| `agent-crud-provider` | Agent CRUD, provider setup, Agent Sessions | 104 |
| `shell-tabs-command` | App shell, sidebars, global shortcuts, tabs, command terminal | 266 |
| `files-docs-history` | File explorer, file preview, document rendering, history | 349 |
| `autorun-ai-terminal` | Auto Run plus Codex-only AI terminal workflows | 273 |
| `wizard-settings-prompts` | New Agent Wizard, inline wizard, Settings, Director Notes, prompt composer | 372 |
| `git-groupchat-playbooks` | Git/worktrees/PR/diff/log/Gist, group chat, playbooks, marketplace, Spec Kit, OpenSpec | 363 |
| `stats-graph-symphony` | Usage dashboard, stats, document graph, Symphony, leaderboard, achievements | 336 |
| `debug-accessibility` | Debug/about/update/process/error modals, destructive confirmations, accessibility smoke | 192 |
| `mobile-web-bridge` | Mobile/web bridge only | 102 |
| `fixtures-sharding-review` | Shared fixtures, selector/helper consolidation, sharding plan, static branch review | 0 |

The source prompt lists `shell-tabs-command` as about 366 scenarios, but the
canonical coverage matrix currently sums that lane to 266. Do not inflate the
canonical target silently. If the lane finds 100 additional valid shell/tab
scenarios, record them as proposed target expansion in its progress file.

## PM2

Each lane is launched as a one-shot PM2 process with `--no-autorestart`:

```bash
pm2 start "codex exec --cd /Users/jeffscottward/Github/tools/Maestro-worktrees/e2e-<lane> --dangerously-bypass-approvals-and-sandbox - < prompts/e2e-agents/<lane>.md" --name "maestro-e2e-<lane>" --no-autorestart --time
```

Inspect a lane with:

```bash
pm2 logs maestro-e2e-<lane> --lines 200
pm2 show maestro-e2e-<lane>
```
