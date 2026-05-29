# E2E Coverage Campaign

## Current State

Branch: `codex/full-e2e-coverage-campaign`

This campaign extends the existing coverage work from unit/integration coverage into app-wide Playwright/Electron E2E coverage.

Measured inventory:

| Area                              |              Current Count |
| --------------------------------- | -------------------------: |
| E2E spec files after batch 19     |                          7 |
| Declared E2E tests after batch 19 |                        202 |
| Last pre-campaign full E2E result |      91 passed, 49 skipped |
| Latest full E2E validation        |     153 passed, 49 skipped |
| Renderer component files          |                        236 |
| Renderer hook files               |                        123 |
| Renderer store files              |                         11 |
| Web/mobile files                  |                         59 |
| IPC handler modules               |                         30 |
| Current `npm run test` result     | 28,521 passed, 106 skipped |

The current E2E suite is mostly an Auto Run suite plus one Bionify reading-mode scenario. It is not deep app-wide coverage.

## Scope Rules

- Live AI-provider E2E coverage is Codex-only.
- Claude Code, OpenCode, Factory Droid, Gemini, and Qwen flows should be covered as static UI/configuration/disabled-state flows unless a local reliable provider is available.
- Terminal-agent flows are in scope because they do not require an AI provider.
- Network-backed features should use deterministic mocks, local fixtures, or skipped environmental tests when a real account/token is required.
- E2E should cover user journeys and cross-boundary behavior. It should not duplicate every unit-test permutation.

## Target Size Estimate

Best current estimate: 1,350 to 1,850 active E2E scenarios, plus 150 to 300 explicitly skipped or environment-gated scenarios.

That range is high enough to cover the app surface, but low enough to avoid a brittle suite that mirrors unit tests one assertion at a time. At the current Electron runtime of roughly 2.5 seconds per passing scenario, 1,500 active scenarios would take about 60 to 70 minutes serially and should eventually be sharded.

## Coverage Matrix

| Surface                                                        | Existing Active | Target Active | Notes                                                                                 |
| -------------------------------------------------------------- | --------------: | ------------: | ------------------------------------------------------------------------------------- |
| App shell, layout, sidebars, resizing, focus, global shortcuts |               0 |            90 | Left Bar, Right Bar, Main Window, collapse/restore, focus traps, keyboard-only paths  |
| Agent CRUD and provider setup                                  |               0 |           120 | Codex live/config flows, Terminal flows, non-Codex static and unavailable states      |
| Codex AI terminal workflows                                    |               0 |           140 | Send, interrupt, retry, replay, copy/save, streaming, tool/thinking displays, errors  |
| Command terminal workflows                                     |               4 |            70 | Shell transcript, output search/filter, command history; resize/stop/errors next      |
| Tabs and tab overlays                                          |               0 |            95 | AI tabs, file tabs, rename, close variants, reorder, export, merge/send context       |
| File explorer and file operations                              |               0 |           110 | Browse, search, refresh, rename, delete, context menu, empty/error states             |
| File preview and document rendering                            |               8 |           150 | Markdown, CSV, binary handoff, image, Mermaid, large file, search, edit/preview       |
| History panel                                                  |               0 |            70 | Filtering, details, lookback, search, empty/loading/error states                      |
| Auto Run                                                       |              91 |           220 | Existing suite plus skipped batch, image, error, multi-document, persistence flows    |
| New Agent Wizard and inline wizard                             |              16 |           140 | Setup/resume/exit, directory, conversation, phase review, generated docs              |
| Settings                                                       |               0 |           130 | General, Display, Theme, Shortcuts, Encore, SSH remotes, env vars, persistence        |
| Git, worktrees, PR, diff/log, Gist                             |               0 |           120 | Local temp repos first; GitHub/Gist account paths gated                               |
| Group chat                                                     |               0 |           100 | Creation, participants, Codex-only routing, history, errors, deletion                 |
| Usage dashboard and stats                                      |               0 |            80 | Charts, lookbacks, loading, empty, errors, detail modals                              |
| Document graph                                                 |               0 |            90 | Graph build, node selection, preview, settings, layout, persistence                   |
| Playbooks, marketplace, Spec Kit, OpenSpec                     |               0 |            95 | Local/import/export/search flows; network paths mocked/gated                          |
| Symphony, leaderboard, achievements                            |               0 |            90 | Static, auth/error, modal, history and CTA flows                                      |
| Director notes and prompt composer                             |               7 |            55 | Director's Notes settings/history/help/AI overview; prompt composer open/edit/control |
| Debug/about/update/app info/agent error modals                 |               0 |            65 | Modal open/close, copy/report, expected error paths                                   |
| Mobile/web bridge                                              |               0 |           130 | Web/mobile shell, session list, terminal, Auto Run, offline queue, websocket states   |
| Accessibility smoke and destructive-action confirmations       |               0 |            90 | Keyboard paths, escape behavior, focus restore, confirmation flows                    |

Estimated matrix total: 2,250 active scenarios. After removing provider-unavailable and account-gated scenarios, the likely executable local target is 1,350 to 1,850.

## Phase Order

1. Build reusable E2E fixtures and helpers for isolated app state, temp projects, temp git repos, Codex/Terminal sessions, IPC stubbing, file uploads, and modal assertions.
2. Convert currently skipped Auto Run tests where deterministic local fixtures are enough.
3. Add shell/navigation coverage: app chrome, sidebars, tabs, file explorer, file preview, command terminal.
4. Add Codex-only AI terminal coverage and static non-Codex provider-state coverage.
5. Add wizard, settings, git/worktree, group chat, dashboard, document graph, marketplace/playbooks, and modal coverage.
6. Add web/mobile bridge coverage after local Electron surface coverage has a stable helper layer.
7. Shard the E2E suite once serial runtime becomes too slow for normal validation.

## Immediate Next Batch

The first implementation batch should focus on infrastructure and high-ROI existing gaps:

- Add shared E2E helpers for opening Right Bar tabs, opening the New Agent Wizard fresh, selecting agent tiles by accessible button name, and asserting modals.
- Unskip or replace deterministic Auto Run tests that do not require live AI execution.
- Add foundational app shell tests for Right Bar tab switching, Left Bar selection, TabBar actions, and File Preview toolbar behavior.

## Progress Log

- 2026-05-29 batch 1: added deterministic persisted-state Electron launch helper, shared right-panel tab helper, fresh wizard shortcut helper, and `e2e/app-shell.spec.ts` covering app shell regions, Right Bar tab switching, Settings, Auto Run guide, and markdown file preview edit/preview toggling.
- Validation: `npm run test:e2e -- app-shell.spec.ts` passed 4/4; `npx playwright test app-shell.spec.ts autorun-setup.spec.ts` passed 17 with 11 existing intentional skips; `npx playwright test` passed 95 with 49 existing intentional skips.
- 2026-05-29 batch 2: extended `e2e/app-shell.spec.ts` to cover Left Bar Codex/Terminal agent switching, TabBar AI/file tab switching, and Tab Switcher filtering/selection.
- Validation: `npx playwright test app-shell.spec.ts` passed 7/7; `npx playwright test` passed 98 with 49 existing intentional skips.
- 2026-05-29 batch 3: extended `e2e/app-shell.spec.ts` to cover File Explorer folder expansion/collapse, opening markdown files from the tree, and File Preview in-file search.
- Validation: `npx playwright test app-shell.spec.ts` passed 10/10; `npx playwright test` passed 101 with 49 existing intentional skips.
- 2026-05-29 batch 4: extended `e2e/app-shell.spec.ts` to cover Settings tab navigation, shortcut filtering, and Display settings persistence for the Files pane icon theme.
- Validation: `npx playwright test app-shell.spec.ts` passed 13/13; `npx playwright test` passed 104 with 49 existing intentional skips.
- 2026-05-29 batch 5: extended `e2e/app-shell.spec.ts` to cover Quick Actions filtering, Shortcuts Help launch/search, About launch, Tab Switcher launch, Settings launch, and unmatched command empty state.
- Validation: `npx playwright test app-shell.spec.ts` passed 18/18; `npx playwright test app-shell.spec.ts -g "expands and collapses folders" --repeat-each=3` passed 3/3 after adding a file-tree readiness guard; `npx playwright test` passed 109 with 49 existing intentional skips.
- 2026-05-29 batch 6: extended `e2e/app-shell.spec.ts` to seed History through the preload API and cover History entry rendering, AUTO/USER filters, keyboard search, detail modal validation toggle, and the History panel guide.
- Validation: `npx playwright test app-shell.spec.ts` passed 22/22; `npx playwright test` passed 113 with 49 existing intentional skips.
- 2026-05-29 batch 7: extended `e2e/app-shell.spec.ts` to cover Quick Actions launch paths for System Log Viewer and System Processes, including key modal controls and close behavior.
- Validation: `npx playwright test app-shell.spec.ts` passed 24/24; `npx playwright test` passed 115 with 49 existing intentional skips.
- 2026-05-29 batch 8: extended `e2e/app-shell.spec.ts` to cover Quick Actions launch for Usage Dashboard, view-mode tab switching, time-range selection, and close behavior.
- Validation: `npx playwright test app-shell.spec.ts` passed 25/25; `npx playwright test` passed 116 with 49 existing intentional skips.
- 2026-05-29 batch 9: extended `e2e/app-shell.spec.ts` to cover Quick Actions launch for the active Codex agent's Agent Sessions browser, including header, new-session action, search, filters, and empty state.
- Validation: `npx playwright test app-shell.spec.ts` passed 26/26; `npx playwright test` passed 117 with 49 existing intentional skips.
- 2026-05-29 batch 10: extended `e2e/app-shell.spec.ts` to cover Quick Actions paths for targeted Settings sections, group creation, fuzzy file search file selection, and Right Bar tab navigation.
- Validation: `npx playwright test app-shell.spec.ts -g "creates a group from Quick Actions"` passed 1/1; `npx playwright test app-shell.spec.ts` passed 30/30; `npx playwright test` passed 121 with 49 existing intentional skips.
- 2026-05-29 batch 11: extended `e2e/app-shell.spec.ts` to cover Quick Actions agent-management paths for Create New Agent, Edit Agent, Rename Agent, bookmark toggling, and AI/shell mode switching.
- Validation: `npx playwright test app-shell.spec.ts -g "Create New Agent|Edit Agent|renames the active agent|toggles bookmark|switches the active agent"` passed 5/5; `npx playwright test app-shell.spec.ts` passed 35/35; `npx playwright test` passed 126 with 49 existing intentional skips.
- 2026-05-29 batch 12: added deterministic Group Chat E2E coverage for persisted group chat loading, seeded message rendering, participants/history right-panel navigation, and header info/rename flow. Also wired `MAESTRO_DATA_DIR` into the Electron main process so persisted-state E2E launches are isolated to per-test userData, and hardened one Auto Run no-session assertion exposed by that isolation.
- Validation: `npx playwright test group-chat.spec.ts` passed 3/3; `npx playwright test app-shell.spec.ts` passed 35/35; `npx playwright test e2e/autorun-sessions.spec.ts:333` passed 1/1; `npx playwright test` passed 129 with 49 existing intentional skips.
- 2026-05-29 batch 13: expanded Group Chat E2E coverage for Left Bar context-menu edit/delete/archive/unarchive flows, archived chat visibility/opening, right-panel collapse/restore, and history activity-graph lookback selection.
- Validation: `npx playwright test group-chat.spec.ts` passed 9/9; `npx playwright test` passed 135 with 49 existing intentional skips.
- 2026-05-29 batch 14: added Document Graph E2E coverage from the markdown file preview toolbar, including graph loading from linked seeded markdown, search/clear, layout switching, neighbor-depth slider, external-link mode, help panel, close confirmation, and Quick Actions re-open of the last graph.
- Validation: `npx playwright test app-shell.spec.ts -g "Document Graph"` passed 2/2; `npx playwright test app-shell.spec.ts` passed 37/37; `npx playwright test` passed 137 with 49 existing intentional skips.
- 2026-05-29 batch 15: added Director's Notes E2E coverage for Encore settings enable/disable behavior, Quick Actions availability, unified history rendering and filters, search/detail modal flow, help tab, and deterministic AI Overview content. Added a seeded settings hook to the Electron launch helper and stubbed only the synopsis IPC handler during these tests to avoid live non-Codex provider execution.
- Validation: `npx playwright test app-shell.spec.ts -g "Director"` passed 4/4; `npx playwright test app-shell.spec.ts` passed 41/41; `npx playwright test` passed 141 with 49 existing intentional skips. Full-suite log: `/tmp/maestro-full-e2e-director-notes-batch15.log`.
- 2026-05-29 batch 16: added Prompt Composer E2E coverage for opening from the AI input toolbar, opening with the keyboard shortcut, editing multi-line drafts, Tab insertion, control visibility/toggling, disabled/enabled Send state, and closing without dispatching a live prompt.
- Validation: `npx playwright test app-shell.spec.ts -g "Prompt Composer"` passed 3/3; `npx playwright test app-shell.spec.ts` passed 44/44; `npx playwright test` passed 144 with 49 existing intentional skips. Full-suite log: `/tmp/maestro-full-e2e-prompt-composer-batch16.log`.
- 2026-05-29 batch 17: added File Preview E2E breadth for CSV table rendering/search and binary file external-open confirmation, including seeded CSV and binary fixture files in the app-shell workbench.
- Validation: `npx playwright test app-shell.spec.ts -g "CSV|binary"` passed 2/2; `npx playwright test app-shell.spec.ts` passed 46/46; `npx playwright test` passed 146 with 49 existing intentional skips. Full-suite log: `/tmp/maestro-full-e2e-file-preview-batch17.log`.
- 2026-05-29 batch 18: added File Preview E2E breadth for image preview rendering, Mermaid markdown code-fence rendering, and large text truncation/load-full behavior. Also hardened Quick Actions close assertions after full-suite logging exposed stale-layer Escape flakiness.
- Validation: `npx playwright test app-shell.spec.ts -g "image files|Mermaid|large text"` passed 3/3; `npx playwright test app-shell.spec.ts -g "unmatched Quick Actions|Director's Notes in Encore"` passed 2/2; `npx playwright test app-shell.spec.ts` passed 49/49; `npx playwright test` passed 149 with 49 existing intentional skips. Full-suite log: `/tmp/maestro-full-e2e-file-preview-batch18-rerun.log`.
- 2026-05-29 batch 19: added Command Terminal E2E coverage for seeded terminal transcript rendering, terminal input chrome, output search, per-output filtering, and shell command history selection.
- Validation: `npx playwright test app-shell.spec.ts -g "command terminal|seeded Codex and Terminal"` passed 4/4; `npx playwright test app-shell.spec.ts -g "command history entries"` passed 1/1; `npx playwright test app-shell.spec.ts` passed 53/53; `npx playwright test` passed 153 with 49 existing intentional skips. Full-suite log: `/tmp/maestro-full-e2e-command-terminal-batch19-rerun.log`.
