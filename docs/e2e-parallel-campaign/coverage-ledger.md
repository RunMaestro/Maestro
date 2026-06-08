# Parallel E2E Coverage Ledger

Source of truth: `docs/e2e-coverage-campaign.md`.

Current active tests: 707
Target active tests: 3,025
Remaining matrix-backed active scenarios: 2,318

## Matrix

| Surface                                                        | Lane                      | Current Active | Target Active | Remaining |
| -------------------------------------------------------------- | ------------------------- | -------------: | ------------: | --------: |
| App shell, layout, sidebars, resizing, focus, global shortcuts | `shell-tabs-command`      |             26 |           110 |        84 |
| Agent CRUD and provider setup                                  | `agent-crud-provider`     |             56 |           160 |       104 |
| Codex AI terminal workflows                                    | `autorun-ai-terminal`     |             29 |           170 |       141 |
| Command terminal workflows                                     | `shell-tabs-command`      |             49 |            95 |        46 |
| Tabs and tab overlays                                          | `shell-tabs-command`      |             53 |           120 |        67 |
| File explorer and file operations                              | `files-docs-history`      |             17 |           140 |       123 |
| File preview and document rendering                            | `files-docs-history`      |             33 |           180 |       147 |
| History panel                                                  | `files-docs-history`      |             16 |            95 |        79 |
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
| Mobile/web bridge                                              | `mobile-web-bridge`       |             88 |           190 |       102 |
| Accessibility smoke and destructive-action confirmations       | `debug-accessibility`     |              7 |           130 |       123 |

## Lane Totals

| Lane                       | Matrix-backed remaining | Authored active scenarios | Authored skipped/env-gated scenarios | Last accepted commit |
| -------------------------- | ----------------------: | ------------------------: | -----------------------------------: | -------------------- |
| `agent-crud-provider`      |                     104 |                         0 |                                    0 | pending              |
| `shell-tabs-command`       |                     197 |                        69 |                                    0 | `02ce883da`          |
| `files-docs-history`       |                     349 |                         0 |                                    0 | pending              |
| `autorun-ai-terminal`      |                     273 |                         0 |                                    0 | pending              |
| `wizard-settings-prompts`  |                     372 |                         0 |                                    0 | pending              |
| `git-groupchat-playbooks`  |                     363 |                         0 |                                    0 | pending              |
| `stats-graph-symphony`     |                     336 |                         0 |                                    0 | pending              |
| `debug-accessibility`      |                     192 |                         0 |                                    0 | pending              |
| `mobile-web-bridge`        |                     102 |                         0 |                                    0 | pending              |
| `fixtures-sharding-review` |                       0 |                         0 |                                    0 | pending              |

## Merge Log

- 2026-06-08: accepted `codex/e2e-shell-tabs-command` through `02ce883da`; authored 9 tests covering 69 active shell/tab/terminal scenarios. No E2E execution was run.
