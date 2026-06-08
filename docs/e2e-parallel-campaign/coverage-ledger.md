# Parallel E2E Coverage Ledger

Source of truth: `docs/e2e-coverage-campaign.md`.

Current active tests: 779
Target active tests: 3,025
Remaining matrix-backed active scenarios: 2,246

## Matrix

| Surface                                                        | Lane                      | Current Active | Target Active | Remaining |
| -------------------------------------------------------------- | ------------------------- | -------------: | ------------: | --------: |
| App shell, layout, sidebars, resizing, focus, global shortcuts | `shell-tabs-command`      |             26 |           110 |        84 |
| Agent CRUD and provider setup                                  | `agent-crud-provider`     |             65 |           160 |        95 |
| Codex AI terminal workflows                                    | `autorun-ai-terminal`     |             31 |           170 |       139 |
| Command terminal workflows                                     | `shell-tabs-command`      |             49 |            95 |        46 |
| Tabs and tab overlays                                          | `shell-tabs-command`      |             53 |           120 |        67 |
| File explorer and file operations                              | `files-docs-history`      |             25 |           140 |       115 |
| File preview and document rendering                            | `files-docs-history`      |             36 |           180 |       144 |
| History panel                                                  | `files-docs-history`      |             19 |            95 |        76 |
| Auto Run                                                       | `autorun-ai-terminal`     |            131 |           260 |       129 |
| New Agent Wizard and inline wizard                             | `wizard-settings-prompts` |             38 |           190 |       152 |
| Settings                                                       | `wizard-settings-prompts` |             58 |           190 |       132 |
| Git, worktrees, PR, diff/log, Gist                             | `git-groupchat-playbooks` |             21 |           160 |       139 |
| Group chat                                                     | `git-groupchat-playbooks` |             51 |           140 |        89 |
| Usage dashboard and stats                                      | `stats-graph-symphony`    |             17 |           125 |       108 |
| Document graph                                                 | `stats-graph-symphony`    |             26 |           130 |       104 |
| Playbooks, marketplace, Spec Kit, OpenSpec                     | `git-groupchat-playbooks` |             21 |           145 |       124 |
| Symphony, leaderboard, achievements                            | `stats-graph-symphony`    |              7 |           120 |       113 |
| Director notes and prompt composer                             | `wizard-settings-prompts` |             14 |            90 |        76 |
| Debug/about/update/app info/agent error modals                 | `debug-accessibility`     |             19 |            85 |        66 |
| Mobile/web bridge                                              | `mobile-web-bridge`       |             93 |           190 |        97 |
| Accessibility smoke and destructive-action confirmations       | `debug-accessibility`     |              9 |           130 |       121 |

## Lane Totals

| Lane                       | Matrix-backed remaining | Authored active scenarios | Authored skipped/env-gated scenarios | Last accepted commit |
| -------------------------- | ----------------------: | ------------------------: | -----------------------------------: | -------------------- |
| `agent-crud-provider`      |                      95 |                         9 |                                    2 | `bb4fbcce2`          |
| `shell-tabs-command`       |                     197 |                        69 |                                    0 | `02ce883da`          |
| `files-docs-history`       |                     335 |                        14 |                                    5 | `c47df15c2`          |
| `autorun-ai-terminal`      |                     268 |                         5 |                                    0 | `ca4241a13`          |
| `wizard-settings-prompts`  |                     360 |                        12 |                                    1 | `30fd144ab`          |
| `git-groupchat-playbooks`  |                     352 |                        11 |                                    3 | `f8b94b00`           |
| `stats-graph-symphony`     |                     325 |                        11 |                                    5 | `cd80b10f`           |
| `debug-accessibility`      |                     187 |                         5 |                                    0 | `94f7b2d7`           |
| `mobile-web-bridge`        |                      97 |                         5 |                                    0 | `243662e8f`          |
| `fixtures-sharding-review` |                       0 |                         0 |                                    0 | `392c4527`           |

## Merge Log

- 2026-06-08: accepted `codex/e2e-shell-tabs-command` through `02ce883da`; authored 9 tests covering 69 active shell/tab/terminal scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-agent-crud-provider` through `bb4fbcce2`; authored 9 active provider/CRUD/session scenarios and 2 skipped/env-gated real-provider rows. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-files-docs-history` through `bd10d5fdd`; authored 8 active file/docs/history scenarios plus 3 product-gap skips and 2 env-gated rows. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-mobile-web-bridge` through `243662e8f`; authored 5 active mobile/web bridge scenarios covering session summary state, detail/log API fallbacks, global history ordering, worktree metadata, and multi-session disable-all status clearing. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-autorun-ai-terminal` through `ca4241a13`; authored 5 active Auto Run/Codex AI terminal scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-wizard-settings-prompts` through `01b93b1f`; authored 5 active wizard/settings/prompt scenarios plus 1 env-gated row. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-stats-graph-symphony` through `8d37e190`; authored 5 active stats/graph/Symphony scenarios plus 2 skipped and 2 env-gated rows. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-debug-accessibility` through `94f7b2d7`; authored 5 active debug/accessibility scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-fixtures-sharding-review` through `392c4527`; authored the support-lane fixture/helper recommendation and sharding plan. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-git-groupchat-playbooks` through `f56007a23`; authored 5 active Git/group-chat/playbook scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-files-docs-history` through `c47df15c2`; authored 6 additional active file/docs/history scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-wizard-settings-prompts` through `30fd144ab`; authored 7 additional active wizard/settings/prompt scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-stats-graph-symphony` through `cd80b10f`; authored 6 additional active stats/graph/Symphony scenarios plus 1 env-gated row. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-git-groupchat-playbooks` through `f8b94b00`; authored 6 additional active Git/playbook scenarios plus 3 skipped/env-gated rows. No E2E execution was run.
