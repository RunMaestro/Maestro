# Parallel E2E Coverage Ledger

Source of truth: `docs/e2e-coverage-campaign.md`.

Current active tests: 729
Target active tests: 3,025
Remaining matrix-backed active scenarios: 2,296

## Matrix

| Surface                                                        | Lane                      | Current Active | Target Active | Remaining |
| -------------------------------------------------------------- | ------------------------- | -------------: | ------------: | --------: |
| App shell, layout, sidebars, resizing, focus, global shortcuts | `shell-tabs-command`      |             26 |           110 |        84 |
| Agent CRUD and provider setup                                  | `agent-crud-provider`     |             65 |           160 |        95 |
| Codex AI terminal workflows                                    | `autorun-ai-terminal`     |             29 |           170 |       141 |
| Command terminal workflows                                     | `shell-tabs-command`      |             49 |            95 |        46 |
| Tabs and tab overlays                                          | `shell-tabs-command`      |             53 |           120 |        67 |
| File explorer and file operations                              | `files-docs-history`      |             21 |           140 |       119 |
| File preview and document rendering                            | `files-docs-history`      |             36 |           180 |       144 |
| History panel                                                  | `files-docs-history`      |             17 |            95 |        78 |
| Auto Run                                                       | `autorun-ai-terminal`     |            128 |           260 |       132 |
| New Agent Wizard and inline wizard                             | `wizard-settings-prompts` |             32 |           190 |       158 |
| Settings                                                       | `wizard-settings-prompts` |             55 |           190 |       135 |
| Git, worktrees, PR, diff/log, Gist                             | `git-groupchat-playbooks` |             17 |           160 |       143 |
| Group chat                                                     | `git-groupchat-playbooks` |             50 |           140 |        90 |
| Usage dashboard and stats                                      | `stats-graph-symphony`    |             13 |           125 |       112 |
| Document graph                                                 | `stats-graph-symphony`    |             24 |           130 |       106 |
| Playbooks, marketplace, Spec Kit, OpenSpec                     | `git-groupchat-playbooks` |             15 |           145 |       130 |
| Symphony, leaderboard, achievements                            | `stats-graph-symphony`    |              2 |           120 |       118 |
| Director notes and prompt composer                             | `wizard-settings-prompts` |             11 |            90 |        79 |
| Debug/about/update/app info/agent error modals                 | `debug-accessibility`     |             16 |            85 |        69 |
| Mobile/web bridge                                              | `mobile-web-bridge`       |             93 |           190 |        97 |
| Accessibility smoke and destructive-action confirmations       | `debug-accessibility`     |              7 |           130 |       123 |

## Lane Totals

| Lane                       | Matrix-backed remaining | Authored active scenarios | Authored skipped/env-gated scenarios | Last accepted commit |
| -------------------------- | ----------------------: | ------------------------: | -----------------------------------: | -------------------- |
| `agent-crud-provider`      |                      95 |                         9 |                                    2 | `bb4fbcce2`          |
| `shell-tabs-command`       |                     197 |                        69 |                                    0 | `02ce883da`          |
| `files-docs-history`       |                     341 |                         8 |                                    5 | `bd10d5fdd`          |
| `autorun-ai-terminal`      |                     273 |                         0 |                                    0 | pending              |
| `wizard-settings-prompts`  |                     372 |                         0 |                                    0 | pending              |
| `git-groupchat-playbooks`  |                     363 |                         0 |                                    0 | pending              |
| `stats-graph-symphony`     |                     336 |                         0 |                                    0 | pending              |
| `debug-accessibility`      |                     192 |                         0 |                                    0 | pending              |
| `mobile-web-bridge`        |                      97 |                         5 |                                    0 | `243662e8f`          |
| `fixtures-sharding-review` |                       0 |                         0 |                                    0 | pending              |

## Merge Log

- 2026-06-08: accepted `codex/e2e-shell-tabs-command` through `02ce883da`; authored 9 tests covering 69 active shell/tab/terminal scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-agent-crud-provider` through `bb4fbcce2`; authored 9 active provider/CRUD/session scenarios and 2 skipped/env-gated real-provider rows. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-files-docs-history` through `bd10d5fdd`; authored 8 active file/docs/history scenarios plus 3 product-gap skips and 2 env-gated rows. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-mobile-web-bridge` through `243662e8f`; authored 5 active mobile/web bridge scenarios covering session summary state, detail/log API fallbacks, global history ordering, worktree metadata, and multi-session disable-all status clearing. No E2E execution was run.
