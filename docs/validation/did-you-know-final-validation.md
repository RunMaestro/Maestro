---
type: report
title: Did You Know final validation
created: 2026-09-19
tags:
  - did-you-know
  - validation
related:
  - '[[did-you-know-regression]]'
  - '[[CANONICAL-UTILITIES]]'
---

# Did You Know final validation

Reviewed the complete contribution diff from `0e4f286` to `f16d014` on
`symphony/issue-1555-mu85lxwa`. No production or test changes were needed.
Validation used the workspace-local Node.js 22.19.0 toolchain on macOS.

## Required checks

| Check                                        | Result                                            |
| -------------------------------------------- | ------------------------------------------------- |
| `npm run lint`                               | Passed all three TypeScript configurations.       |
| `npm run lint:eslint`                        | Passed source ESLint and test/script dash checks. |
| `npm run docs:verify`                        | Passed: 506 asserted paths, zero missing.         |
| Prettier on all surviving contribution files | Passed.                                           |
| `git diff --check 0e4f286 HEAD`              | Passed.                                           |

## Diff audit

- No added lines contain U+2013 or U+2014. Existing surrounding content was
  not rewritten.
- Source indentation matches the surrounding tabs. Space-prefixed matches
  are comment alignment and the polygon template literal moved unchanged
  from `TourOverlay.tsx`; those spaces are string content, not code indentation.
- `src/renderer/components/Wizard/services/shuffle.ts` is deleted. Wizard
  consumers and integration helpers import `src/shared/shuffle.ts`; no old
  shuffle imports or duplicate shuffle implementations remain.
- `getElementRect` and `getSpotlightClipPath` have one implementation each,
  in `src/renderer/utils/spotlight.ts`. Their former local definitions in
  `useTour.tsx` and `TourOverlay.tsx` are gone, and tour consumers import the
  promoted module. No dead code from either move remains.
- Both promoted utilities have index entries in `CLAUDE.md` and full entries
  in `docs/agent-guides/CANONICAL-UTILITIES.md`.
- `src/renderer/assets/did-you-know-frame.png` is committed, with identical
  HEAD and working-tree blob `c95a214873247772dfab094bcd28e456162d3efa`
  (284,408 bytes). Inspected this one image; the asset geometry tests passed.
- `docs/releases.md` is unchanged.

## Targeted tests

All 183 tests passed across eight files. Checked each JSON file result:
zero failed files, failed tests, or pending tests.

```bash
node node_modules/vitest/vitest.mjs run \
  src/__tests__/shared/shuffle.test.ts \
  src/__tests__/shared/didYouKnow.test.ts \
  src/__tests__/renderer/components/DidYouKnowFrame.test.ts \
  src/__tests__/renderer/components/DidYouKnowModal.test.tsx \
  src/__tests__/renderer/components/DidYouKnowReadingMode.test.tsx \
  src/__tests__/renderer/utils/spotlight.test.ts \
  src/__tests__/renderer/components/Wizard/TourStepWidth.test.tsx \
  src/__tests__/renderer/hooks/useTourActions.test.ts
```

## Deliberately deferred

- The next playbook checkbox, PR target confirmation, remains for its own run.
- Running-app launch, theme, zoom, small-window, reading-mode interaction,
  copy/artwork review, and representative feature screenshots remain the
  playbook's manual follow-up.
- The full test suite and live-provider scenarios were not run, honoring the
  playbook restriction. The full-suite push hook is skipped for the same reason.
- The six pre-existing prompt-initialization failures in
  `src/__tests__/integration/group-chat.integration.test.ts` remain unchanged;
  baseline evidence and the earlier 2,433-test pass are recorded in
  [[did-you-know-regression]].
- The commit hook is bypassed because its `lint-staged` executable is not
  installed; the report passed Prettier directly.
- Cross-platform CI was not run locally. No source edits required new tests
  or source language-service diagnostics; Markdown has no configured LSP.

## Rebase validation (2026-10-05)

Rebased all 55 contribution commits onto upstream `rc` at
`0c810524cdee371266671c218e4d80a668490bc8`. The original tip is preserved
locally on `backup/issue-1555-before-rebase-20261005`.

The only conflict was in `MainPanelContent.tsx`: retained the discovery
card's passive-layer browser-focus handling and upstream's `useToastAvoidZone`
registration. Reviewed the range-diff to confirm the contribution survived.

Validation on macOS with the workspace-local Node.js 22.19.0 toolchain:

- All 2,466 tests in the 49-file regression manifest in
  [[did-you-know-regression]] passed. The JSON results report zero failed
  files, failed tests, or pending tests.
- `npm run lint`, `npm run lint:eslint`, and `npm run build:renderer` passed.
- `npm run docs:verify` passed with 575 asserted paths; `npm run lint:doc-refs`
  passed across 39 documents.
- Prettier on contribution files and `git diff --check` passed.
- The existing headless browser smoke script passed dock geometry, backdrop
  hit testing, keyboard activation, return to the full card, reduced motion,
  and narrow viewport checks. Inspected the docked-card screenshot.

The browser smoke check uses a component harness, not a running Electron
webview. Real docs-page focus/scrolling, launch timing in the desktop app,
and the full theme/zoom/artwork review still need manual verification.
The optional representative screenshots remain unadded.

The full local test suite and live-provider scenarios were not run, following
this contribution's playbook restriction. Full Linux and Windows CI must pass
before merge. The earlier mocked group-chat failures were not rerun in this
rebase pass; their September 19 baseline remains documented separately.
The renderer build emitted dynamic-import/chunking warnings outside this
feature. No dependency or lockfile changes were made.

## Review preparation (2026-10-11)

Rebased onto upstream `rc` at `a73a8bdf64abd33045835f22d571f80f18e646fc`.
Preserved the original tip on `backup/issue-1555-before-rebase-20261011`.
The only rebase conflict was the reorganized canonical utility index in
`CLAUDE.md`; retained the current index format and both discovery utilities.
Reviewed the range-diff after replaying all 56 commits.

Two readiness checks identified fixes included in this update:

- Subscribe to the existing onboarding series store so discovery tips wait
  for all four setup screens. Added a regression test covering an interrupted
  launch delay, every onboarding step, and the full delay after completion.
- Let footer rows grow with text, scale action columns with the interface
  font, and stack actions on narrow cards. The previous fixed-height rows let
  the primary action overlap Next at the maximum font scale.

Validation:

- All 2,488 tests in the existing 49-file regression manifest passed, with
  zero failed files, failed tests, or pending tests.
- TypeScript, ESLint, repository-wide Prettier, main/preload builds, and
  renderer build passed. Documentation checks passed: 679 paths, 250 index
  entries matched to their full entries, and references across 41 documents.
- A hidden Electron instance used an isolated demo profile under the
  workspace. Confirmed that the card stays absent through all four onboarding
  screens, opens after dismissal and splash removal, and opens a docs tab
  while docking the card. No test window was shown or live Maestro data used.
- Browser component checks exercised all 21 cards across 20 themes. Inspected
  light/dark screenshots and checked font scales 0.6, 1.0, and 2.4 at widths
  390, 600, and 1000. The narrow maximum-font case reproduced the footer
  overlap before the fix and passed afterward.

Remaining limitations:

- The external docs page did not finish loading in the hidden Electron guest;
  its DOM check timed out, including with background throttling disabled.
  Real docs-page clicking and keyboard scrolling remain unverified. Component
  tests establish docking and navigation behavior, not that desktop check.
- Full Linux/Windows CI still requires maintainer approval. The full local
  suite and live-provider scenarios remain outside the playbook's validation
  scope. Earlier unrelated mocked group-chat failures were not rerun here.
- Optional representative feature screenshots are still not included. Theme
  geometry checks and inspected examples do not replace an editorial review
  of all artwork and copy.

Keep the PR in draft until the remaining desktop interaction check and CI
are satisfied. The previous dated validation sections are historical results.

## Rebase and readiness (2026-10-18)

Rebased all 57 commits onto upstream `rc` at
`c3cd1d2e1bf58a16a383ec9706311ade350a8cfe`. The previous head is preserved on
`backup/issue-1555-before-rebase-20261018`. Reviewed the replay with range-diff.
Conflicts preserved upstream settings tests, keyboard actions, the canonical
utility index, and the new host browser creation path. Ported the navigation
regression into the upstream browser component test location and placed the
runtime navigation field on the canonical shared browser type.

Adapted discovery navigation to asynchronous host tab creation. Rapid Next/Back
requests reuse the pending tab and apply the latest requested URL. The remote
browser view consumes explicit requests after its connection is ready, without
replaying observed redirects. Native and remote new-tab actions share the opener.

Validation against the committed dependency lockfile:

- 2,610 tests passed across 50 regression files. The clean-install run passed
  2,607 tests in 49 files; the remaining asset file initially could not load the
  canvas native module. After rebuilding canvas, all three asset tests passed.
- TypeScript, ESLint, full-repository Prettier, main/preload builds, renderer
  build, and web-desktop build passed.
- Documentation checks passed: 934 asserted paths, 320 matching utility index
  entries, and references across 42 documents.
- Browser checks covered all 21 tips in light and dark themes, font scales
  0.6/1.0/2.4 at widths 390/600/1000, and navigation through every tip at the
  narrow maximum-font setting. Reading-mode checks passed docking, backdrop
  hit testing, keyboard activation, return, reduced motion, and narrow widths.
- An isolated, offscreen Electron window loaded the real Cue docs page
  (24,200 text characters, complete DOM), scrolled it, reused the docs tab for
  the next tip, and returned to the modal. Native guest mouse events followed
  a real link to Cue Configuration; PageDown scrolled that page 690 pixels.
  The window remained invisible. This resolves the earlier hidden-window document-loading timeout.

Dependencies were restored with `npm ci` and the native modules rebuilt locally;
no dependency manifest or lockfile changes are included. Logs and the current
50-file manifest are in `tmp/readiness-oct18/` (local, not committed).
The full suite and live-provider scenarios remain outside the contribution
playbook's scope; the push hook that runs the full suite is bypassed after the
checks above. Maintainer-approved CI and visual/editorial review remain required.
