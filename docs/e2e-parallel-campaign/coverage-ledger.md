# Parallel E2E Coverage Ledger

Source of truth: `docs/e2e-coverage-campaign.md`.

Current active tests: 1193
Target active tests: 3,025
Remaining matrix-backed active scenarios: 1,832

## Matrix

| Surface                                                        | Lane                      | Current Active | Target Active | Remaining |
| -------------------------------------------------------------- | ------------------------- | -------------: | ------------: | --------: |
| App shell, layout, sidebars, resizing, focus, global shortcuts | `shell-tabs-command`      |             26 |           110 |        84 |
| Agent CRUD and provider setup                                  | `agent-crud-provider`     |            160 |           160 |         0 |
| Codex AI terminal workflows                                    | `autorun-ai-terminal`     |             33 |           170 |       137 |
| Command terminal workflows                                     | `shell-tabs-command`      |             61 |            95 |        34 |
| Tabs and tab overlays                                          | `shell-tabs-command`      |             53 |           120 |        67 |
| File explorer and file operations                              | `files-docs-history`      |             33 |           140 |       107 |
| File preview and document rendering                            | `files-docs-history`      |             44 |           180 |       136 |
| History panel                                                  | `files-docs-history`      |             26 |            95 |        69 |
| Auto Run                                                       | `autorun-ai-terminal`     |            134 |           260 |       126 |
| New Agent Wizard and inline wizard                             | `wizard-settings-prompts` |             40 |           190 |       150 |
| Settings                                                       | `wizard-settings-prompts` |             96 |           190 |        94 |
| Git, worktrees, PR, diff/log, Gist                             | `git-groupchat-playbooks` |             36 |           160 |       124 |
| Group chat                                                     | `git-groupchat-playbooks` |             55 |           140 |        85 |
| Usage dashboard and stats                                      | `stats-graph-symphony`    |             23 |           125 |       102 |
| Document graph                                                 | `stats-graph-symphony`    |             28 |           130 |       102 |
| Playbooks, marketplace, Spec Kit, OpenSpec                     | `git-groupchat-playbooks` |             41 |           145 |       104 |
| Symphony, leaderboard, achievements                            | `stats-graph-symphony`    |             15 |           120 |       105 |
| Director notes and prompt composer                             | `wizard-settings-prompts` |             21 |            90 |        69 |
| Debug/about/update/app info/agent error modals                 | `debug-accessibility`     |             85 |            85 |         0 |
| Mobile/web bridge                                              | `mobile-web-bridge`       |            104 |           190 |        86 |
| Accessibility smoke and destructive-action confirmations       | `debug-accessibility`     |             79 |           130 |        51 |

## Lane Totals

| Lane                       | Matrix-backed remaining | Authored active scenarios | Authored skipped/env-gated scenarios | Last accepted commit |
| -------------------------- | ----------------------: | ------------------------: | -----------------------------------: | -------------------- |
| `agent-crud-provider`      |                       0 |                       104 |                                    2 | `563b9db6c`          |
| `shell-tabs-command`       |                     185 |                        81 |                                    0 | `2d9975b17`          |
| `files-docs-history`       |                     312 |                        37 |                                    5 | `b5491cd9b`          |
| `autorun-ai-terminal`      |                     263 |                        10 |                                    0 | `cd804bebf`          |
| `wizard-settings-prompts`  |                     313 |                        59 |                                    1 | `bb21caed1`          |
| `git-groupchat-playbooks`  |                     313 |                        50 |                                    7 | `10ed8a71a`          |
| `stats-graph-symphony`     |                     309 |                        27 |                                    6 | `bb9a6f68b`          |
| `debug-accessibility`      |                      51 |                       141 |                                    0 | `cd485eda6`          |
| `mobile-web-bridge`        |                      86 |                        16 |                                    0 | `d7ccdd3d`           |
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
- 2026-06-08: accepted `codex/e2e-autorun-ai-terminal` through `cd804bebf`; authored 5 additional active Auto Run/Codex AI terminal scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-shell-tabs-command` through `44e98a94f`; authored 7 additional active command-terminal scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-debug-accessibility` through `15e7a1a20`; authored 6 additional active debug package modal scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-mobile-web-bridge` through `d580f80ea`; authored 6 additional active mobile/web bridge scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-files-docs-history` through `5694e29e6`; authored 7 additional active file/docs/history scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-wizard-settings-prompts` through `ee4375c7b`; authored 6 additional active wizard/settings/prompt scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-stats-graph-symphony` through `784d84e34`; authored 6 additional active stats/graph/Symphony scenarios plus 1 env-gated row. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-git-groupchat-playbooks` through `6033dd4b7`; authored 7 additional active Git/playbook scenarios plus 2 skipped/env-gated rows. No E2E execution was run.

- 2026-06-08: accepted `codex/e2e-files-docs-history` through `0f93fb81d`; authored 6 additional active file/docs/history scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-wizard-settings-prompts` through `a210a889e`; authored 6 additional active wizard/settings/prompt scenarios and a static review assertion fix. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-git-groupchat-playbooks` through `b40916745`; authored 7 additional active Git/playbook scenarios plus 2 skipped/env-gated rows. No E2E execution was run.
- 2026-06-08: stopped `maestro-e2e-stats-graph-symphony-t5` after it stalled with no worktree changes; no stats/Symphony rows were accepted in this tranche.
- 2026-06-08: accepted `codex/e2e-files-docs-history` through `6f8134fb9`; authored 5 additional active file/docs/history fallback scenarios after tranche-6 PM2 workers failed with Codex managed-account 503 errors before authoring. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-wizard-settings-prompts` through `e8bc7da23`; authored 5 additional active Settings/Prompt Composer fallback scenarios after tranche-7 PM2 workers failed with Codex managed-account 503 errors before authoring. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-git-groupchat-playbooks` through `839b3e3b6`; authored 5 additional active Git/PR/group-chat/marketplace fallback scenarios after the tranche-7 PM2 worker failed with Codex managed-account 503 errors before authoring. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-stats-graph-symphony-fallback-2` through `33581a7ec`; authored 5 additional active Usage Dashboard/Auto Run/Document Graph/Symphony fallback scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-wizard-settings-prompts-fallback-2` through `f8c3f107d`; authored 5 additional active Settings fallback scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-git-groupchat-playbooks-fallback-2` through `705b731a7`; authored 5 additional active Git/group-chat/playbook fallback scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-wizard-settings-prompts-fallback-3` through `16e9f11cd`; authored 5 additional active Settings/Bionify fallback scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-wizard-settings-prompts-fallback-4` through `1741d2b74`; authored 5 additional active Settings preference fallback scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-git-groupchat-playbooks-fallback-3` through `1efd6cfc5`; authored 5 additional active Git Diff/Create PR/Playbook Exchange/OpenSpec fallback scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-wizard-settings-prompts-fallback-5` through `02c808467`; authored 5 additional active Settings shell/input/notification fallback scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-git-groupchat-playbooks-fallback-4` through `4867f111c`; authored 5 additional active Create PR/Playbook Exchange fallback scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-wizard-settings-prompts-fallback-6` through `d3c251829`; authored 5 additional active Settings Display local file indexing/context warning fallback scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-stats-graph-symphony-fallback-3` through `bb9a6f68b`; authored 5 additional active Usage Dashboard heatmap/provider comparison and Symphony help/stats/leaderboard failure fallback scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-git-groupchat-playbooks-fallback-5` through `10ed8a71a`; authored 5 additional active Group Chat close, Playbook Exchange search/detail/document switching, and Create Pull Request multiline description fallback scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-wizard-settings-prompts-fallback-7` through `bb21caed1`; authored 5 additional active Settings max-output/user-alignment/native-title-bar/confetti/update-check fallback scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-mobile-web-bridge-fallback-2` through `d7ccdd3d4`; authored 5 additional active token API/theme/Auto Run WebSocket/subscription/server-lifecycle fallback scenarios. No E2E execution was run.
- 2026-06-08: accepted `codex/e2e-files-docs-history-fallback-2` through `b5491cd9b`; authored 5 additional active file preview clipboard/edit/search fallback scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `1ab3dbece`; authored 5 additional active System Log Viewer severity/detail and update check fallback scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `agent-crud-provider` fallback through `03961a3e7`; authored 5 additional active Create/Edit Agent validation and unavailable-provider fallback scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `agent-crud-provider` fallback through `ef05abd54`; authored 5 additional active generic provider Agent Sessions detail, favorite, rename, search-mode, and keyboard-resume scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `agent-crud-provider` fallback through `9362cf4fc`; authored 5 additional active agent group creation, context-menu move/ungroup, context-menu create-group, collapse/expand, and inline rename scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `agent-crud-provider` fallback through `8bbf419f8`; authored 5 additional active Quick Actions create, duplicate cancel/create, Agent Only directory preservation, and exact-name working-directory delete scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `agent-crud-provider` fallback through `750e25fd0`; authored 5 additional active Agent Sessions New Session, quick-resume, metadata preservation, Show All, and search-control scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `agent-crud-provider` fallback through `b4e5f2bca`; authored 5 additional active provider bookmark, sidebar filter, and empty-group deletion scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `agent-crud-provider` fallback through `dc7d732ce`; authored 5 additional active provider configuration persistence, reset, duplicate-prefill, and provider-switch scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `agent-crud-provider` fallback through `a37cd777a`; authored 5 additional active provider refresh, folder-picker keyboard create, keyboard save, and provider-switch cancel scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `agent-crud-provider` fallback through `b6015f342`; authored 5 additional active Agent Sessions list favorite, rename-cancel, keyboard navigation, detail resume, and graph-search shortcut scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `agent-crud-provider` fallback through `1bd023b7e`; authored 5 additional active Agent Sessions list rename-save, blank detail rename clearing, detail favorite sync, hidden detail, and Named plus Show All filter scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `agent-crud-provider` fallback through `d6f26a028`; authored 5 additional active Agent Sessions list add-name, blank list-name clearing, origin metadata, hidden title search, and unmatched-search graph-toggle scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `agent-crud-provider` fallback through `07a01b7fb`; authored 5 additional active group blank-validation, group cancel, existing-group move, context-menu unbookmark, and populated-group delete-control scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `agent-crud-provider` fallback through `230e6e1c3`; authored 5 additional active group blur rename, blank inline rename preservation, current-group disabled state, emptied-group delete-control, and bookmarked-group visibility scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `agent-crud-provider` fallback through `0cb3fda43`; authored 3 additional active Create New Agent draft-cancel, provider-draft switch-isolation, and Edit Agent cancel-without-save scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `agent-crud-provider` fallback through `e9541b64a`; authored 5 additional active required-field validation, directory-warning clearing, optional override reset, blank Edit Agent name, and reverse provider-switch cleanup scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `agent-crud-provider` fallback through `e17df308a`; authored 5 additional active Create/Edit Agent SSH remote selection, host-scoped validation, duplicate prefill, remote persistence, and local-return scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `agent-crud-provider` fallback through `6fc534e46`; authored 5 additional active Create/Edit Agent Escape close, post-create reset, folder-picker shortcut, and duplicate-modal Escape scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `agent-crud-provider` fallback through `023c2e08c`; authored 5 additional active Create New Agent directory-acknowledgment reset, SSH/local folder-picker shortcut, and duplicate provider config create/clear scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `agent-crud-provider` fallback through `563b9db6c`; authored 7 final active provider SSH command reset, create/edit SSH selection reset/cancel, provider-switch SSH draft, and duplicate SSH inheritance/clearing scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `605499366`; authored 5 additional active System Log Viewer clear/search/filter and update refresh/manual release fallback scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `8aa446c40`; authored 5 additional active update manual-link/assets-building and debug-package reveal fallback scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `07c782f13`; authored 5 additional active Process Monitor list/detail/refresh and kill-confirmation scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `713267101`; authored 5 additional active agent error modal network, dismiss, permission, authentication, and crash recovery scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `21ec6909a`; authored 5 additional active agent error recovery banner-clear, token-exhaustion, rate-limit, missing-session, and unknown-error scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `43d359dc6`; authored 5 additional active agent error modal JSON toggle, unstructured-detail, header-close, Escape-close, and non-recoverable close-control scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `824ddb7a1`; authored 5 additional active About modal website, Discord, documentation, project GitHub, and creator LinkedIn external-link scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `a3009ef36`; authored 5 additional active About modal creator GitHub, close-control, Escape-close, leaderboard registration open, and leaderboard Escape-close scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `bb8488c72`; authored 5 additional active update release-note collapse/re-expand, update Escape-close, debug package footer-cancel, and debug package Done-close scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `b52037cc0`; authored 5 additional active update pre-release toggle restoration, update error refresh/Escape-close, debug package error-cancel, and debug package path-copy scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `681521ec8`; authored 5 additional active Process Monitor empty-state, collapse-all, detail Escape-return, detail Back-return, and header-close scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `f2316172c`; authored 5 additional active System Log Viewer header close, Escape close, individual structured detail show/hide, and unmatched search state scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `6a856bac0`; authored 5 additional active Process Monitor kill-confirmation cancel, backdrop-dismiss, button-confirm, cancel-refresh preservation, and selected-process-only kill scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `1f3044aa3`; authored 5 additional active System Log clear-confirmation Escape cancel, header close, backdrop non-dismissal, focused-Enter confirm, and severity-filter preservation scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `30ecb2060`; authored 5 additional active Process Monitor list Escape-close, keyboard-help, arrow-key detail entry, Space collapse, and Enter restore scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `60955184c`; authored 5 additional active Process Monitor ArrowUp terminal detail, ArrowLeft collapse, ArrowRight expand, ArrowRight child-selection, and lowercase-refresh scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `393595080`; authored 5 additional active Process Monitor double-click detail, detail close, terminal metadata, session-navigation, and footer-status scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `5d199a653`; authored 5 additional active Process Monitor ArrowDown first-selection, child-to-parent selection, Space detail, Expand-all restore, and clicked-row Enter scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `8d033c945`; authored 5 additional active System Log Viewer empty-state, entry-count, search-focus, footer-hint, and expand-collapse disabled-state scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `2bfd428aa`; authored 5 additional active Debug Package privacy-copy, category-checkbox, checkbox-toggle, checkbox-restore, and submission-instruction scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `9694be825`; authored 5 additional active update modal version-delta, release-note content, available-action, checkbox beta-opt-in, and release-history affordance scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `e6ebb1ce5`; authored 5 additional active update modal download progress, disabled downloading, downloaded restart action, install handoff, and stale download-error refresh scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `4fdcc0307`; authored 5 additional active Quick Actions unmatched search, group-mode return, group destination controls, Keyboard Shortcuts unmatched search, and mastery progress scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `8c5706ee9`; authored 5 additional active Quick Actions debug command visibility, Enter selection, number hotkey selection, and website shell-routing scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `debug-accessibility` fallback through `cd485eda6`; authored 5 additional active Quick Actions Settings, theme-tab, global environment settings, documentation shell-routing, and Discord shell-routing scenarios. No E2E execution was run.
- 2026-06-08: accepted manual `shell-tabs-command` fallback through `2d9975b17`; authored 5 additional active command-terminal output expansion, collapsed-search expandability, clear-history draft preservation, and parent-directory cwd scenarios. Focused static review found no critical or high issues. No E2E execution was run.
