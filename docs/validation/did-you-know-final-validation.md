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
