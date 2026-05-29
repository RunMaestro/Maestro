# E2E Coverage Campaign

## Current State

Branch: `codex/full-e2e-coverage-campaign`

This campaign extends the existing coverage work from unit/integration coverage into app-wide Playwright/Electron E2E coverage.

Measured inventory:

| Area                              |              Current Count |
| --------------------------------- | -------------------------: |
| E2E spec files after batch 1      |                          6 |
| Declared E2E tests after batch 6  |                        162 |
| Last pre-campaign full E2E result |      91 passed, 49 skipped |
| Latest full E2E validation        |     113 passed, 49 skipped |
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

| Surface                                                        | Existing Active | Target Active | Notes                                                                                |
| -------------------------------------------------------------- | --------------: | ------------: | ------------------------------------------------------------------------------------ |
| App shell, layout, sidebars, resizing, focus, global shortcuts |               0 |            90 | Left Bar, Right Bar, Main Window, collapse/restore, focus traps, keyboard-only paths |
| Agent CRUD and provider setup                                  |               0 |           120 | Codex live/config flows, Terminal flows, non-Codex static and unavailable states     |
| Codex AI terminal workflows                                    |               0 |           140 | Send, interrupt, retry, replay, copy/save, streaming, tool/thinking displays, errors |
| Command terminal workflows                                     |               0 |            70 | Shell mode, history, cwd, output, resize, stop, errors                               |
| Tabs and tab overlays                                          |               0 |            95 | AI tabs, file tabs, rename, close variants, reorder, export, merge/send context      |
| File explorer and file operations                              |               0 |           110 | Browse, search, refresh, rename, delete, context menu, empty/error states            |
| File preview and document rendering                            |               0 |           150 | Markdown, images, Mermaid, CSV, binary, large files, search, TOC, edit/save, links   |
| History panel                                                  |               0 |            70 | Filtering, details, lookback, search, empty/loading/error states                     |
| Auto Run                                                       |              91 |           220 | Existing suite plus skipped batch, image, error, multi-document, persistence flows   |
| New Agent Wizard and inline wizard                             |              16 |           140 | Setup/resume/exit, directory, conversation, phase review, generated docs             |
| Settings                                                       |               0 |           130 | General, Display, Theme, Shortcuts, Encore, SSH remotes, env vars, persistence       |
| Git, worktrees, PR, diff/log, Gist                             |               0 |           120 | Local temp repos first; GitHub/Gist account paths gated                              |
| Group chat                                                     |               0 |           100 | Creation, participants, Codex-only routing, history, errors, deletion                |
| Usage dashboard and stats                                      |               0 |            80 | Charts, lookbacks, loading, empty, errors, detail modals                             |
| Document graph                                                 |               0 |            90 | Graph build, node selection, preview, settings, layout, persistence                  |
| Playbooks, marketplace, Spec Kit, OpenSpec                     |               0 |            95 | Local/import/export/search flows; network paths mocked/gated                         |
| Symphony, leaderboard, achievements                            |               0 |            90 | Static, auth/error, modal, history and CTA flows                                     |
| Director notes and prompt composer                             |               0 |            55 | Create/edit/delete, insertion, keyboard, empty/error states                          |
| Debug/about/update/app info/agent error modals                 |               0 |            65 | Modal open/close, copy/report, expected error paths                                  |
| Mobile/web bridge                                              |               0 |           130 | Web/mobile shell, session list, terminal, Auto Run, offline queue, websocket states  |
| Accessibility smoke and destructive-action confirmations       |               0 |            90 | Keyboard paths, escape behavior, focus restore, confirmation flows                   |

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
