# shell-tabs-command

Status: App shell completion tranche accepted; static-reviewed only

## Scope

App shell, sidebars, global shortcuts, tabs, command terminal.

## Checklist

- [x] Inspect existing related E2E coverage and component surfaces.
- [x] Author deterministic active scenarios up to the matrix-backed target where feasible.
- [x] Document any proposed +100 scenario expansion separately from the canonical matrix.
- [x] Record files touched and scenario counts.
- [x] Commit lane work on `codex/e2e-shell-tabs-command`.

## Progress

Canonical matrix-backed lane target: 266 active scenarios. The source-prompt
366 figure remains treated as an unaccepted +100 proposal; this lane did not
claim or justify any expansion beyond the canonical 266.

Authored in this branch:

| Bucket                                       | New tests | Active scenarios |
| -------------------------------------------- | --------: | ---------------: |
| App shell, sidebars, focus, global shortcuts |        75 |               90 |
| Command terminal workflows                   |        60 |               77 |
| Tabs, tab switcher, tab overlays             |        71 |               99 |
| Total                                        |       206 |              266 |

Matrix-backed scenarios still unclaimed in this lane progress file: 0.
Skipped/env-gated scenarios authored: 0.

The root coverage ledger's command-terminal matrix row is already saturated.
The latest app shell completion tranche is counted against the remaining
app-shell/global-shortcut rows and completes this lane's canonical 266
matrix-backed active scenarios.

Files touched:

- `e2e/app-shell.spec.ts` - added deterministic seeded-workbench tests for
  right-panel global shortcuts, agent cycling shortcuts, terminal search and
  history behavior, tab switcher keyboard modes/empty state, global tab
  shortcuts, and file tab overlay shell IPC routing. The second command-terminal
  tranche adds focused-input output search, regex/local filter recovery,
  transcript command copy, history empty/recovery and arrow navigation, and
  multiline shell command submission. The manual fallback tranche adds collapsed
  terminal output expand/recollapse controls, collapsed-output search
  expandability, clear-history draft preservation, and parent-directory cwd
  propagation. The terminal search/SSH tranche adds output-search close,
  visible collapsed-output search, clear-history while output search is open,
  SSH history selection routing, and SSH slash-command routing coverage. The tab
  switcher and tab overlay tranche adds Escape-close preservation, numeric AI tab
  selection, inactive AI tab session copying/unread marking, and active file tab
  name copying without closing the preview. The Quick Actions tab-management and
  terminal cwd/history tranche adds command-palette close-right/close-other
  unified tab flows, tilde `cd` cwd propagation, missing-directory `cd` cwd
  preservation, and repeated command history deduplication. The shell chrome,
  tab keyboard state, and terminal focus/history tranche adds command-palette
  sidebar/right-panel toggles, command-palette agent search from a collapsed
  Left Bar, terminal input/output focus toggling, terminal command-history
  preservation after transcript clearing, keyboard-driven tab star/rename/unread
  state, and global jump-to-bottom coverage for scrollable terminal output. The
  shell shortcut restore, tab overlay cancel/toggle, and terminal cwd/history
  tranche adds right-panel shortcut restoration after agent cycling, terminal
  output-search draft preservation, stdout transcript copying, reverse command
  history navigation, local bare-`cd` cwd reset, AI tab star-off toggling, and
  hover-rename cancellation. The shell draft/sidebar recovery, named-session Tab
  Switcher recovery, disabled AI tab close-action, and terminal history click
  tranche adds terminal-draft preservation across sidebar restoration and file
  search, named-session empty-search recovery, single-tab close-action disabled
  assertions, and mouse-selected command history focus restoration. The
  command-terminal cwd routing tranche adds absolute `cd`, relative
  parent-subpath `cd`, failed-`cd` preservation after a cwd change, exact
  `cd ~` reset, and cwd preservation after switching away from and back to the
  terminal agent. The shell/sidebar and Tab Switcher deterministic tranche adds
  Quick Actions right-panel restore, terminal draft preservation across
  right-panel shortcuts, agent search and terminal jump behavior with collapsed
  chrome, selected right-panel tab restoration, file-tab path/copy/close and
  edge-action assertions, Quick Actions close-left and rename-cancel flows, and
  starred/Quick Actions Tab Switcher recovery. The collapsed chrome, terminal
  history, and Tab Switcher tranche adds Auto Run preservation during Left Bar
  collapse/restore, Left Bar filter no-match recovery, Shortcuts Help layering
  over collapsed chrome, Quick Actions cancellation from hidden chrome,
  command-terminal cwd preservation after clear, history no-match recovery and
  cancel behavior, terminal focus-toggle draft preservation, unread/star
  shortcut toggles, keyboard rename submission, file-tab reopen from hover close,
  Tab Switcher no-match recovery, and inactive-tab rename cancellation. The
  terminal completion/filter, shell focus, and close-all tab tranche adds
  terminal history Tab completion, completed-history command execution, terminal
  input Escape focus recovery, local stdout/stderr filter close/reset behavior,
  combined local/global terminal output filtering, whitespace-padded terminal
  clear, quoted trailing-slash `cd`, history popover draft filtering, output
  search across user commands, right-panel preservation while terminal output
  search is open, and Quick Actions/global shortcut close-all tab recovery. The
  sidebar restore/cancel and inactive tab action tranche adds Quick Actions
  cancellation without side effects, right/left sidebar restore combinations,
  terminal draft preservation across hidden chrome and agent cycling, History
  and Auto Run right-panel restoration, inactive file-tab copy/open/move actions,
  inactive starred/unread AI tab Tab Switcher flows, close-all reopen recovery,
  and renamed new-tab search recovery. The shell/sidebar and tab shortcut
  restore tranche adds hidden-chrome Quick Actions restoration, Left Bar
  no-match recovery and selection, Shortcuts Help recovery over collapsed right
  chrome, Quick Actions cancel preservation, global tab rename cancellation,
  file-preview new-tab shortcuts, named-session Tab Switcher Escape behavior,
  and inactive AI-tab move preservation. The terminal search and terminal Tab
  Switcher tranche adds output-search reset, right-panel preservation while
  output search is open, Quick Actions cancellation over output search, local
  output-filter preservation while history opens, command-history recovery and
  mouse-selected execution, whitespace-clear history/cwd preservation,
  history-selected output search, and terminal Tab Switcher recovery from global
  shortcut and Quick Actions flows. The inactive tab switcher tranche adds
  inactive AI-tab rename, close/reopen, star/unstar, inactive AI/file tab
  move-back recovery, named/starred no-match mode recovery, multiple-new-tab
  no-match recovery, and numeric Tab Switcher selection of a renamed AI tab from
  file preview. The shell shortcut restore tranche adds Shortcuts Help recovery
  over collapsed right chrome, Files/History/Auto Run shortcut restoration,
  terminal draft preservation across Tab Switcher and right-panel restore flows,
  Left Bar filter preservation, hidden-chrome agent cycling, and renamed scratch
  AI-tab Tab Switcher/close/reopen recovery. The hidden chrome shortcut tranche
  adds Tab Switcher recovery over hidden Left Bar/right chrome, Shortcuts Help
  terminal-draft and agent-filter preservation, hidden-chrome agent cycling and
  Left Bar restoration, Auto Run/History shortcut restoration, and renamed
  inactive scratch AI-tab copy/unread overlay actions. The app shell completion
  tranche adds Left Bar/right-panel restoration, Quick Actions cancellation
  without shell side effects, hidden-right Files/History/Auto Run shortcut
  restoration with terminal draft preservation, agent-search Escape recovery
  over History/Auto Run, terminal/workbench cycling with hidden chrome, and
  Shortcuts Help Escape behavior over a hidden Left Bar.
- `docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md` - recorded this
  lane progress.
- `docs/testing/e2e/parallel-campaign/coverage-ledger.md` - reconciled shared campaign
  counts to 3,025 active tests and 0 remaining matrix-backed scenarios.
- `docs/testing/e2e/parallel-campaign/orchestrator-status.md` - recorded the current
  shell-tabs-command tranche as complete.
- `docs/testing/e2e/coverage-campaign.md` - added the accepted shell checkpoint for
  this tranche.

Shared helpers changed: none. `docs/testing/e2e/parallel-campaign/broadcasts.md` was
not updated.

Commits:

- `c9739e8b5` - `test(e2e-shell-tabs-command): add shell tab shortcut coverage`
- `3748d86fb` - `test(e2e-shell-tabs-command): add terminal control tranche`
- `2d9975b17` - `test(e2e-shell-tabs-command): add terminal output controls`
- `ea049b708` - `test(e2e-shell-tabs-command): add terminal search ssh tranche`
- `36f60d251` - `test(e2e-shell-tabs-command): tighten terminal search clear assertion`
- `d9b81d185` - `test(e2e-shell-tabs-command): add tab switcher overlay coverage`
- `88d6a2266` - `test(e2e-shell-tabs-command): add tab command terminal tranche`
- `396fcd9ec` - `test(e2e-shell-tabs-command): add shell tab keyboard tranche`
- `1f2918a91` - `test(e2e-shell-tabs-command): add shell tab terminal static tranche`
- `bb867f786` - `test(e2e-shell-tabs-command): add shell tab command recovery tranche`
- `7a3d72861` - `test(e2e-shell-tabs-command): add terminal cwd routing tranche`
- `1db0b90fc` - `test(e2e-shell-tabs-command): add shell tab deterministic tranche`
- `40cfbf15d` - `test(e2e-shell-tabs-command): add collapsed chrome tab tranche`
- `e998e8879` - `test(e2e-shell-tabs-command): add terminal tab tranche`
- `f926eebc6` - `test(e2e-shell-tabs-command): add sidebar tab action tranche`
- `c76fc616d` - `test(e2e-shell-tabs-command): add shell tab restore tranche`
- `daf5e33ca` - `test(e2e-shell-tabs-command): add terminal search tab tranche`
- `5974abe99` - `test(e2e-shell-tabs-command): add inactive tab switcher tranche`
- `93bfbaa21` - `test(e2e-shell-tabs-command): add shell shortcut restore tranche`
- `a72e2fe3e` - `test(e2e-shell-tabs-command): add hidden chrome shortcut tranche`
- `15692b0d0` - `test(e2e-shell-tabs-command): add app shell completion tranche`
- `37045d564` - `docs(e2e-shell-tabs-command): record app shell completion tranche`

Validation performed:

- `npx prettier --write e2e/app-shell.spec.ts` - applied formatting.
- `npx eslint e2e/app-shell.spec.ts` - passed.
- `npx prettier --check e2e/app-shell.spec.ts` - passed.
- `git diff --check -- e2e/app-shell.spec.ts` - passed.
- `npx prettier --check docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md` -
  passed.
- `git diff --check -- docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md` -
  passed.
- Static `code-reviewer` diff review - passed, with no prohibited Playwright
  runner/listing tokens in the added lines.
- `./node_modules/.bin/eslint e2e/app-shell.spec.ts` - passed for the manual
  fallback tranche.
- `./node_modules/.bin/prettier --write e2e/app-shell.spec.ts` - applied
  formatting for the manual fallback tranche.
- `git diff --check -- e2e/app-shell.spec.ts` - passed for the manual fallback
  tranche.
- Focused static reviewer pass - passed for the manual fallback tranche, with
  no critical or high issues after correcting the collapsed-output search
  assertion to match current renderer behavior.
- `npx prettier --write e2e/app-shell.spec.ts` - applied formatting for the
  terminal search/SSH tranche.
- `npx prettier --check e2e/app-shell.spec.ts` - passed for the terminal
  search/SSH tranche.
- `npx eslint e2e/app-shell.spec.ts` - passed for the terminal search/SSH
  tranche.
- `git diff --check -- e2e/app-shell.spec.ts` - passed for the terminal
  search/SSH tranche.
- Static `.only` and prohibited-command guard - passed for the terminal
  search/SSH tranche.
- Focused code-reviewer pass - found no critical or high issues after the
  clear-history search assertion was tightened to the product contract.
- `npx prettier --write e2e/app-shell.spec.ts` - applied formatting for the tab
  switcher and tab overlay tranche.
- `npx prettier --check e2e/app-shell.spec.ts` - passed for the tab switcher and
  tab overlay tranche.
- `npx eslint e2e/app-shell.spec.ts` - passed for the tab switcher and tab
  overlay tranche.
- `git diff --check -- e2e/app-shell.spec.ts docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md` -
  passed for the tab switcher and tab overlay tranche.
- Static `.only` and prohibited-command guard - passed for the tab switcher and
  tab overlay tranche.
- Focused code-reviewer pass - found no critical or high issues in the tab
  switcher and tab overlay tranche.
- `./node_modules/.bin/prettier --write e2e/app-shell.spec.ts docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md` -
  unchanged for the Quick Actions tab-management and terminal cwd/history
  tranche.
- `./node_modules/.bin/eslint e2e/app-shell.spec.ts` - passed for the Quick
  Actions tab-management and terminal cwd/history tranche.
- `./node_modules/.bin/prettier --check e2e/app-shell.spec.ts docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md` -
  passed for the Quick Actions tab-management and terminal cwd/history tranche.
- `git diff --check -- e2e/app-shell.spec.ts docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md` -
  passed for the Quick Actions tab-management and terminal cwd/history tranche.
- Added-lines prohibited-token guard for `.only`, fixed waits, and Playwright
  runner/listing commands - passed for the Quick Actions tab-management and
  terminal cwd/history tranche.
- Focused code-reviewer pass - found one determinism risk in the repeated
  terminal-history assertion; fixed with runner-call polling and busy-state
  checks. No critical or high issues remain.
- `./node_modules/.bin/prettier --check docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md docs/testing/e2e/parallel-campaign/coverage-ledger.md` -
  passed for the shared ledger reconciliation.
- `git diff --check -- docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md docs/testing/e2e/parallel-campaign/coverage-ledger.md` -
  passed for the shared ledger reconciliation.
- `./node_modules/.bin/prettier --write e2e/app-shell.spec.ts` - unchanged for
  the shell chrome, tab keyboard state, and terminal focus/history tranche.
- `./node_modules/.bin/eslint e2e/app-shell.spec.ts` - passed for the shell
  chrome, tab keyboard state, and terminal focus/history tranche.
- `git diff --check -- e2e/app-shell.spec.ts` - passed for the shell chrome,
  tab keyboard state, and terminal focus/history tranche.
- Added-lines prohibited-token guard for focused-test markers, fixed waits, and
  Playwright runner/listing commands - passed for the shell chrome, tab keyboard state, and
  terminal focus/history tranche.
- Focused code-reviewer pass - found one flaky unscoped sidebar-filter
  assertion; fixed by scoping the hidden-agent expectation to
  `[data-tour="session-list"]`. No critical or high issues remain.
- `./node_modules/.bin/prettier --write e2e/app-shell.spec.ts` - unchanged for
  the shell shortcut restore, tab overlay cancel/toggle, and terminal cwd/history
  tranche.
- `./node_modules/.bin/eslint e2e/app-shell.spec.ts` - passed for the shell
  shortcut restore, tab overlay cancel/toggle, and terminal cwd/history tranche.
- `./node_modules/.bin/prettier --check e2e/app-shell.spec.ts docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md docs/testing/e2e/parallel-campaign/coverage-ledger.md` -
  passed for the shell shortcut restore, tab overlay cancel/toggle, and
  terminal cwd/history tranche.
- `git diff --check -- e2e/app-shell.spec.ts docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md docs/testing/e2e/parallel-campaign/coverage-ledger.md` -
  passed for the shell shortcut restore, tab overlay cancel/toggle, and
  terminal cwd/history tranche.
- Added-lines prohibited-token guard for focused-test markers, fixed waits, and
  Playwright runner/listing commands - passed for the shell shortcut restore,
  tab overlay cancel/toggle, and terminal cwd/history tranche.
- Focused code-reviewer pass - found no critical or high issues across the
  three-file diff.
- `./node_modules/.bin/prettier --write e2e/app-shell.spec.ts docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md docs/testing/e2e/parallel-campaign/coverage-ledger.md docs/testing/e2e/parallel-campaign/orchestrator-status.md` -
  applied formatting to `orchestrator-status.md`; other touched files were
  unchanged for the shell draft/sidebar recovery, named-session Tab Switcher
  recovery, and terminal history click tranche.
- `./node_modules/.bin/eslint e2e/app-shell.spec.ts` - passed for the shell
  draft/sidebar recovery, named-session Tab Switcher recovery, and terminal
  history click tranche.
- `./node_modules/.bin/prettier --check e2e/app-shell.spec.ts docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md docs/testing/e2e/parallel-campaign/coverage-ledger.md docs/testing/e2e/parallel-campaign/orchestrator-status.md` -
  passed for the shell draft/sidebar recovery, named-session Tab Switcher
  recovery, and terminal history click tranche.
- `git diff --check -- e2e/app-shell.spec.ts docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md docs/testing/e2e/parallel-campaign/coverage-ledger.md docs/testing/e2e/parallel-campaign/orchestrator-status.md` -
  passed for the shell draft/sidebar recovery, named-session Tab Switcher
  recovery, and terminal history click tranche.
- Added-lines prohibited-token guard for focused-test markers, fixed waits, and
  Playwright runner/listing commands - passed for the shell draft/sidebar
  recovery, named-session Tab Switcher recovery, and terminal history click
  tranche.
- Focused code-reviewer pass - found no critical or high issues after checking
  the named-session Tab Switcher selection path against `TabSwitcherModal`.
- `./node_modules/.bin/prettier --write e2e/app-shell.spec.ts docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md docs/testing/e2e/parallel-campaign/coverage-ledger.md docs/testing/e2e/parallel-campaign/orchestrator-status.md` -
  applied formatting to `e2e/app-shell.spec.ts` and
  `docs/testing/e2e/parallel-campaign/orchestrator-status.md` for the
  command-terminal cwd routing tranche.
- `./node_modules/.bin/eslint e2e/app-shell.spec.ts` - passed for the
  command-terminal cwd routing tranche.
- `./node_modules/.bin/prettier --check e2e/app-shell.spec.ts docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md docs/testing/e2e/parallel-campaign/coverage-ledger.md docs/testing/e2e/parallel-campaign/orchestrator-status.md` -
  passed for the command-terminal cwd routing tranche.
- `git diff --check -- e2e/app-shell.spec.ts docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md docs/testing/e2e/parallel-campaign/coverage-ledger.md docs/testing/e2e/parallel-campaign/orchestrator-status.md` -
  passed for the command-terminal cwd routing tranche.
- Added-lines prohibited-token guard for focused-test markers, fixed waits, and
  Playwright runner/listing commands - passed for the command-terminal cwd
  routing tranche, checking 180 added lines.
- Focused code-reviewer pass - found no critical or high issues in the
  command-terminal cwd routing tranche.
- `./node_modules/.bin/prettier --write e2e/app-shell.spec.ts` - unchanged for
  the shell/sidebar and Tab Switcher deterministic tranche.
- `./node_modules/.bin/eslint e2e/app-shell.spec.ts` - passed for the
  shell/sidebar and Tab Switcher deterministic tranche.
- `./node_modules/.bin/prettier --check e2e/app-shell.spec.ts` - passed for the
  shell/sidebar and Tab Switcher deterministic tranche.
- `git diff --check -- e2e/app-shell.spec.ts` - passed for the shell/sidebar and
  Tab Switcher deterministic tranche.
- Added-lines prohibited-token guard for focused-test markers, fixed waits, and
  Playwright runner/listing commands - passed for the shell/sidebar and Tab
  Switcher deterministic tranche.
- Pre-commit hook ran `prettier --write --ignore-unknown` and `eslint --fix` on
  `e2e/app-shell.spec.ts` before `1db0b90fc`.
- Focused code-reviewer pass - found no critical or high issues after checking
  Quick Actions closure and unified tab close-left behavior against the current
  renderer implementations.
- `./node_modules/.bin/prettier --write docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md docs/testing/e2e/parallel-campaign/coverage-ledger.md docs/testing/e2e/parallel-campaign/orchestrator-status.md` -
  applied formatting to `docs/testing/e2e/parallel-campaign/orchestrator-status.md`;
  other touched docs were unchanged.
- `./node_modules/.bin/prettier --check docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md docs/testing/e2e/parallel-campaign/coverage-ledger.md docs/testing/e2e/parallel-campaign/orchestrator-status.md` -
  passed for the shell/sidebar and Tab Switcher deterministic tranche.
- `git diff --check -- docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md docs/testing/e2e/parallel-campaign/coverage-ledger.md docs/testing/e2e/parallel-campaign/orchestrator-status.md` -
  passed for the shell/sidebar and Tab Switcher deterministic tranche.
- Added-lines prohibited-token guard across the touched campaign docs - passed
  for the shell/sidebar and Tab Switcher deterministic tranche.
- `./node_modules/.bin/prettier --write e2e/app-shell.spec.ts` - applied
  formatting for the collapsed chrome, terminal history, and Tab Switcher
  tranche.
- `./node_modules/.bin/eslint e2e/app-shell.spec.ts` - passed for the collapsed
  chrome, terminal history, and Tab Switcher tranche.
- `git diff --check -- e2e/app-shell.spec.ts` - passed for the collapsed chrome,
  terminal history, and Tab Switcher tranche.
- Added-lines prohibited-token guard for focused-test markers, fixed waits, and
  Playwright runner/listing commands - passed for the collapsed chrome, terminal
  history, and Tab Switcher tranche.
- Focused code-reviewer pass found one Quick Actions Escape determinism risk;
  fixed by matching the existing fallback key-dispatch pattern. No critical or
  high issues remain.
- Pre-commit hook ran `prettier --write --ignore-unknown` and `eslint --fix` on
  `e2e/app-shell.spec.ts` before `40cfbf15d`.
- `./node_modules/.bin/prettier --write docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md docs/testing/e2e/parallel-campaign/coverage-ledger.md docs/testing/e2e/parallel-campaign/orchestrator-status.md` -
  applied formatting to shared campaign docs for the collapsed chrome, terminal
  history, and Tab Switcher tranche.
- `./node_modules/.bin/prettier --check e2e/app-shell.spec.ts docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md docs/testing/e2e/parallel-campaign/coverage-ledger.md docs/testing/e2e/parallel-campaign/orchestrator-status.md` -
  passed for the collapsed chrome, terminal history, and Tab Switcher tranche.
- `git diff --check -- docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md docs/testing/e2e/parallel-campaign/coverage-ledger.md docs/testing/e2e/parallel-campaign/orchestrator-status.md` -
  passed for the collapsed chrome, terminal history, and Tab Switcher tranche.
- Added-lines prohibited-token guard across the touched campaign docs - passed
  for the collapsed chrome, terminal history, and Tab Switcher tranche.
- `./node_modules/.bin/prettier --write e2e/app-shell.spec.ts` - unchanged for
  the terminal completion/filter, shell focus, and close-all tab tranche.
- `./node_modules/.bin/eslint e2e/app-shell.spec.ts` - passed for the terminal
  completion/filter, shell focus, and close-all tab tranche.
- `git diff --check -- e2e/app-shell.spec.ts` - passed for the terminal
  completion/filter, shell focus, and close-all tab tranche.
- Added-lines prohibited-token guard for focused-test markers, fixed waits, and
  Playwright runner/listing commands - passed for the terminal completion/filter,
  shell focus, and close-all tab tranche.
- Focused code-reviewer pass - found no critical or high issues in the terminal
  completion/filter, shell focus, and close-all tab tranche.
- Pre-commit hook ran `prettier --write --ignore-unknown` and `eslint --fix` on
  `e2e/app-shell.spec.ts` before `e998e8879`.
- `./node_modules/.bin/prettier --write docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md docs/testing/e2e/parallel-campaign/coverage-ledger.md docs/testing/e2e/parallel-campaign/orchestrator-status.md` -
  applied formatting to `docs/testing/e2e/parallel-campaign/orchestrator-status.md`.
- `./node_modules/.bin/prettier --check e2e/app-shell.spec.ts docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md docs/testing/e2e/parallel-campaign/coverage-ledger.md docs/testing/e2e/parallel-campaign/orchestrator-status.md` -
  passed for the terminal completion/filter, shell focus, and close-all tab
  tranche.
- `git diff --check -- docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md docs/testing/e2e/parallel-campaign/coverage-ledger.md docs/testing/e2e/parallel-campaign/orchestrator-status.md` -
  passed for the terminal completion/filter, shell focus, and close-all tab
  tranche.
- Added-lines prohibited-token guard across the touched campaign docs - passed
  for the terminal completion/filter, shell focus, and close-all tab tranche.
- `./node_modules/.bin/prettier --write e2e/app-shell.spec.ts docs/testing/e2e/coverage-campaign.md docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md docs/testing/e2e/parallel-campaign/coverage-ledger.md docs/testing/e2e/parallel-campaign/orchestrator-status.md` -
  applied formatting to `docs/testing/e2e/parallel-campaign/orchestrator-status.md`;
  other touched files were unchanged for the sidebar restore/cancel and inactive
  tab action tranche.
- `./node_modules/.bin/eslint e2e/app-shell.spec.ts` - passed for the sidebar
  restore/cancel and inactive tab action tranche.
- `./node_modules/.bin/prettier --check e2e/app-shell.spec.ts docs/testing/e2e/coverage-campaign.md docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md docs/testing/e2e/parallel-campaign/coverage-ledger.md docs/testing/e2e/parallel-campaign/orchestrator-status.md` -
  passed for the sidebar restore/cancel and inactive tab action tranche.
- `git diff --check -- e2e/app-shell.spec.ts docs/testing/e2e/coverage-campaign.md docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md docs/testing/e2e/parallel-campaign/coverage-ledger.md docs/testing/e2e/parallel-campaign/orchestrator-status.md` -
  passed for the sidebar restore/cancel and inactive tab action tranche.
- Added-lines prohibited-token guard for focused-test markers, fixed waits, and
  Playwright runner/listing commands - passed for the sidebar restore/cancel and
  inactive tab action tranche plus shared-doc follow-up, checking 301 nonblank
  added lines while allowing the documented "not run" statements in campaign
  docs.
- Focused code-reviewer pass - found no critical or high issues in the sidebar
  restore/cancel and inactive tab action tranche.
- `./node_modules/.bin/prettier --write e2e/app-shell.spec.ts` - unchanged for
  the shell/sidebar and tab shortcut restore tranche.
- `./node_modules/.bin/eslint e2e/app-shell.spec.ts` - passed for the
  shell/sidebar and tab shortcut restore tranche.
- `git diff --check -- e2e/app-shell.spec.ts` - passed for the shell/sidebar and
  tab shortcut restore tranche.
- Added-lines prohibited-token guard for focused-test markers, fixed waits, and
  Playwright runner/listing commands - passed for the shell/sidebar and tab
  shortcut restore tranche, checking 200 added lines.
- Focused code-reviewer pass - tightened one tab-close assertion to avoid
  over-specifying active-selection behavior. No critical or high issues remain.
- Pre-commit hook ran `prettier --write --ignore-unknown` and `eslint --fix` on
  `e2e/app-shell.spec.ts` before `c76fc616d`.
- `./node_modules/.bin/prettier --write e2e/app-shell.spec.ts` - applied
  formatting for the terminal search and terminal Tab Switcher tranche.
- `./node_modules/.bin/eslint e2e/app-shell.spec.ts` - passed for the terminal
  search and terminal Tab Switcher tranche.
- `git diff --check -- e2e/app-shell.spec.ts` - passed for the terminal search
  and terminal Tab Switcher tranche.
- Added-lines prohibited-token guard for focused-test markers, fixed waits,
  forced clicks, console logs, and Playwright runner/listing commands - passed
  for the terminal search and terminal Tab Switcher tranche.
- Initial `NODE_OPTIONS=--max-old-space-size=8192 ./node_modules/.bin/tsc -p tsconfig.lint.json --noEmit --pretty false`
  found the existing missing ignored generated prompt module; after
  `npm run build:prompts`, the same TypeScript command passed.
- Focused code-reviewer pass - found no critical or high issues in the
  terminal search and terminal Tab Switcher tranche.
- Pre-commit hook ran `prettier --write --ignore-unknown` and `eslint --fix` on
  `e2e/app-shell.spec.ts` before `daf5e33ca`.
- `./node_modules/.bin/prettier --write e2e/app-shell.spec.ts` - unchanged for
  the inactive tab switcher tranche.
- `./node_modules/.bin/eslint e2e/app-shell.spec.ts` - passed for the inactive
  tab switcher tranche.
- `git diff --check -- e2e/app-shell.spec.ts` - passed for the inactive tab
  switcher tranche.
- Added-lines prohibited-token guard for focused-test markers, skipped/fixme
  tests, fixed waits, force-clicks, console logging, and Playwright
  runner/listing commands - passed for the inactive tab switcher tranche.
- Static duplicate-title scan - passed for `e2e/app-shell.spec.ts` with 513
  unique `test(...)` titles.
- Focused code-reviewer checklist pass - found no critical or high issues in
  the inactive tab switcher tranche.
- Pre-commit hook ran `prettier --write --ignore-unknown` and `eslint --fix` on
  `e2e/app-shell.spec.ts` before `5974abe99`.
- `./node_modules/.bin/prettier --write docs/testing/e2e/coverage-campaign.md docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md docs/testing/e2e/parallel-campaign/coverage-ledger.md docs/testing/e2e/parallel-campaign/orchestrator-status.md` -
  applied formatting to `docs/testing/e2e/coverage-campaign.md`; other touched docs
  were unchanged.
- `./node_modules/.bin/prettier --check e2e/app-shell.spec.ts docs/testing/e2e/coverage-campaign.md docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md docs/testing/e2e/parallel-campaign/coverage-ledger.md docs/testing/e2e/parallel-campaign/orchestrator-status.md` -
  passed for the inactive tab switcher tranche and docs.
- `git diff --check -- docs/testing/e2e/coverage-campaign.md docs/testing/e2e/parallel-campaign/agents/shell-tabs-command.md docs/testing/e2e/parallel-campaign/coverage-ledger.md docs/testing/e2e/parallel-campaign/orchestrator-status.md` -
  passed for the inactive tab switcher docs.
- Added-lines prohibited-token guard across the touched campaign docs - passed
  for focused-test markers, fixed waits, force-clicks, console logging, and
  Playwright runner/listing commands.
- `NODE_OPTIONS=--max-old-space-size=8192 ./node_modules/.bin/tsc -p tsconfig.lint.json --noEmit --pretty false` -
  passed.
- `./node_modules/.bin/prettier --write e2e/app-shell.spec.ts` - applied
  formatting for the shell shortcut restore tranche.
- `./node_modules/.bin/eslint e2e/app-shell.spec.ts` - passed for the shell
  shortcut restore tranche.
- `./node_modules/.bin/prettier --check e2e/app-shell.spec.ts` - passed for the
  shell shortcut restore tranche.
- `git diff --check -- e2e/app-shell.spec.ts` - passed for the shell shortcut
  restore tranche.
- Added-lines prohibited-token guard for focused-test markers, skipped/fixme
  tests, fixed waits, force-clicks, console logging, and Playwright
  runner/listing commands - passed for the shell shortcut restore tranche.
- Static duplicate-title scan - the 12 new titles are unique; the only duplicate
  titles found are pre-existing Director entries outside this tranche.
- Focused code-reviewer checklist pass - found no critical or high issues in
  the shell shortcut restore tranche.
- Pre-commit hook ran `prettier --write --ignore-unknown` and `eslint --fix` on
  `e2e/app-shell.spec.ts` before `93bfbaa21`.
- `./node_modules/.bin/prettier --write e2e/app-shell.spec.ts` - unchanged after
  selector tightening for the hidden chrome shortcut tranche.
- `./node_modules/.bin/eslint e2e/app-shell.spec.ts` - passed for the hidden
  chrome shortcut tranche.
- `./node_modules/.bin/prettier --check e2e/app-shell.spec.ts` - passed for the
  hidden chrome shortcut tranche.
- `git diff --check -- e2e/app-shell.spec.ts` - passed for the hidden chrome
  shortcut tranche.
- Added-lines prohibited-token guard for focused-test markers, skipped/fixme
  tests, fixed waits, force-clicks, console logging, and Playwright
  runner/listing commands - passed for the hidden chrome shortcut tranche.
- Static duplicate-title scan - the 14 new titles are unique; the only duplicate
  titles found are pre-existing Director entries outside this tranche.
- Focused code-reviewer checklist pass - tightened two inactive-tab overlay
  action selectors to role-based buttons. No critical or high issues remain.
- Pre-commit hook ran `prettier --write --ignore-unknown` and `eslint --fix` on
  `e2e/app-shell.spec.ts` before `a72e2fe3e`.
- `./node_modules/.bin/prettier --write e2e/app-shell.spec.ts` - applied
  formatting for the app shell completion tranche.
- Added-title/prohibited-token scan - found exactly 19 new active tests, no
  duplicate `e2e/app-shell.spec.ts` titles, and no added `.only`, `.skip`,
  `.fixme`, fixed waits, Playwright runner/listing commands, or E2E scripts.
- `./node_modules/.bin/eslint e2e/app-shell.spec.ts` - passed for the app shell
  completion tranche.
- `./node_modules/.bin/prettier --check e2e/app-shell.spec.ts` - passed for the
  app shell completion tranche.
- `git diff --check -- e2e/app-shell.spec.ts` - passed for the app shell
  completion tranche.
- Pre-commit hook ran `prettier --write --ignore-unknown` and `eslint --fix` on
  `e2e/app-shell.spec.ts` before `15692b0d0`.

Validation intentionally not performed:

- No `npm run test:e2e`.
- No `playwright test`.
- No headed/UI E2E.
- No `npx playwright test --list`.

Blockers and limitations:

- E2E execution is intentionally deferred by campaign hard rule.
- The repo does not include row-level canonical matrix data for the 266
  scenarios, only bucket counts in `coverage-ledger.md`.
- A direct ad-hoc `tsc --noEmit` over `e2e/app-shell.spec.ts` is not a usable
  validation gate today because the existing E2E file has baseline typing
  assumptions around browser `window` access inside Playwright callbacks.
