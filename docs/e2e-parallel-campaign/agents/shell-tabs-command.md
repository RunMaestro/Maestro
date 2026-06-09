# shell-tabs-command

Status: terminal search/SSH tranche committed; static-reviewed only

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
| App shell, sidebars, focus, global shortcuts |         2 |               17 |
| Command terminal workflows                   |        20 |               37 |
| Tabs, tab switcher, tab overlays             |         4 |               32 |
| Total                                        |        26 |               86 |

Matrix-backed scenarios still unclaimed in this lane progress file: 180.
Skipped/env-gated scenarios authored: 0.

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
  SSH history selection routing, and SSH slash-command routing coverage.
- `docs/e2e-parallel-campaign/agents/shell-tabs-command.md` - recorded this
  lane progress.

Shared helpers changed: none. `docs/e2e-parallel-campaign/broadcasts.md` was
not updated.

Commits:

- `c9739e8b5` - `test(e2e-shell-tabs-command): add shell tab shortcut coverage`
- `3748d86fb` - `test(e2e-shell-tabs-command): add terminal control tranche`
- `2d9975b17` - `test(e2e-shell-tabs-command): add terminal output controls`
- `ea049b708` - `test(e2e-shell-tabs-command): add terminal search ssh tranche`

Validation performed:

- `npx prettier --write e2e/app-shell.spec.ts` - applied formatting.
- `npx eslint e2e/app-shell.spec.ts` - passed.
- `npx prettier --check e2e/app-shell.spec.ts` - passed.
- `git diff --check -- e2e/app-shell.spec.ts` - passed.
- `npx prettier --check docs/e2e-parallel-campaign/agents/shell-tabs-command.md` -
  passed.
- `git diff --check -- docs/e2e-parallel-campaign/agents/shell-tabs-command.md` -
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
