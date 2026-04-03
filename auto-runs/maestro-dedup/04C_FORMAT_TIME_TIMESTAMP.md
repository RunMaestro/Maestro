# Phase 04-C: Create Canonical formatTimestamp and Consolidate 15 Definitions

## Objective

Create a canonical `formatTimestamp` in `src/shared/formatters.ts` and replace 15 local `formatTime`/`formatTimestamp` definitions that currently have NO canonical source.

**Evidence:** `docs/agent-guides/scans/SCAN-FORMATTERS.md`, "formatTime / formatTimestamp re-definitions"
**Risk:** Low-medium - must ensure all 15 sites produce the same output format after consolidation
**Estimated savings:** ~100 lines

---

## Pre-flight Checks

- [x] Phase 04-B (formatElapsedTime) is complete
- [x] `rtk npm run lint` passes

---

## Tasks

### Task 1: Inventory all 15 definitions

- [x] Find all definitions: `rtk grep "function formatTime\b\|const formatTime\b\|function formatTimestamp\|const formatTimestamp" src/ --glob "*.{ts,tsx}" | rtk grep -v "__tests__"`
- [x] Confirm expected locations: `GroupChatHistoryPanel.tsx`, `GroupChatMessages.tsx`, `HistoryEntryItem.tsx`, `HistoryDetailModal.tsx`, `WizardMessageBubble.tsx`, `ParticipantCard.tsx`, `ThinkingStatusPill.tsx`, `LongestAutoRunsTable.tsx`, `ConversationScreen.tsx`, `conductorBadges.ts`, `groupChatExport.ts`, `tabExport.ts`, `MessageHistory.tsx`, `MobileHistoryPanel.tsx`, `ResponseViewer.tsx`
  - Note: `conductorBadges.ts` has `formatTimeRemaining` (different function, not a timestamp formatter). `GroupChatPanel.tsx` was found as an additional site not in the scan.

### Task 2: Categorize by output format

- [x] Read each of the 15 definitions
- [x] Group by output format: `HH:MM:SS` (24-hour), `h:mm AM/PM` (12-hour), `MMM D, YYYY h:mm AM/PM` (date+time), relative ("5 min ago"), other
- [x] Document which style each call site needs
  - **smart** (5): GroupChatPanel, MobileHistoryPanel, MessageHistory, GroupChatHistoryPanel, HistoryEntryItem - time if today, date+time otherwise
  - **time** (3): WizardMessageBubble, ConversationScreen, LongestAutoRunsTable - time only
  - **datetime** (2): HistoryDetailModal, ResponseViewer - always date+time
  - **full** (2): groupChatExport, tabExport - full toLocaleString()
  - **relative+time** (1): ParticipantCard - relative time with time fallback
  - **JSX** (1): GroupChatMessages - returns JSX, uses `formatTimestamp('time')` for string part
  - **duration** (1): ThinkingStatusPill - takes seconds, NOT a timestamp formatter

### Task 3: Design canonical API

- [x] Add `formatTimestamp(timestamp: number | string, style: 'time' | 'datetime' | 'smart' | 'full' = 'smart'): string` to `src/shared/formatters.ts`
- [x] If there are truly different output formats, provide multiple style options rather than multiple functions
  - Four styles: `time`, `datetime`, `smart` (default), `full`. Accepts `number | string` input.

### Task 4: Implement and test the canonical function

- [x] Write the implementation in `src/shared/formatters.ts` covering all discovered output patterns
- [x] Add unit tests in `src/__tests__/shared/formatters.test.ts` for each style variant
- [x] Test edge cases: timestamp 0, negative values, future timestamps
- [x] Run tests: `rtk vitest run src/__tests__/shared/formatters.test.ts` - all 67 tests pass

### Task 5: Migrate all 15 definitions

For each file:

- [x] Read the local definition to determine which `style` parameter to use
- [x] Remove the local function
- [x] Add import: `import { formatTimestamp } from '../../shared/formatters';` (adjust path)
- [x] If local function was named `formatTime`, use: `import { formatTimestamp as formatTime } from ...` - used direct `formatTimestamp` naming instead for consistency
- [x] Verify output matches the old local definition
  - 12 files fully migrated (5 smart, 3 time, 2 datetime, 2 full)
  - ParticipantCard: refactored to `formatParticipantTime()` using `formatTimestamp('time')` as fallback
  - GroupChatMessages: refactored to `formatMessageTimestamp()` using `formatTimestamp('time')` for string part, keeps JSX wrapper
  - ThinkingStatusPill: left as-is (duration formatter taking seconds, not a timestamp)

### Task 6: Handle main process files separately

- [x] Replace in `groupChatExport.ts` - import from `shared/formatters` directly (uses 'full' style)
- [x] Replace in `tabExport.ts` - import from `shared/formatters` directly (uses 'full' style)
- [x] Check if `conductorBadges.ts` is main process, import accordingly - `conductorBadges.ts` has `formatTimeRemaining` which is a different function (time-to-badge calculation), not a timestamp formatter. Not part of this consolidation.

### Task 7: Verify

- [x] Run lint: `rtk npm run lint` - passes
- [x] Run related tests: `rtk vitest run src/__tests__/shared/formatters.test.ts` - 67 tests pass
- [x] Find and run component tests that use formatTime/formatTimestamp: found 6 related test files, all pass (408 tests total)
- [x] Confirm zero new test failures

### Task 8: Verify no orphaned definitions remain

- [x] Check: `rtk grep "function formatTime\b\|function formatTimestamp" src/ --glob "*.{ts,tsx}" | rtk grep -v "shared/formatters" | rtk grep -v "__tests__"` - only ThinkingStatusPill.tsx remains (duration formatter, intentionally excluded)
- [x] Result should be 0 - 0 timestamp formatter definitions remain outside canonical. ThinkingStatusPill's `formatTime(seconds)` is a duration formatter, not a timestamp formatter.

---

## Verification

After completing changes, run targeted tests for the files you modified:

```bash
rtk vitest run <path-to-relevant-test-files>
```

**Rule: Zero new test failures from your changes.** Pre-existing failures on the baseline are acceptable. If a test you didn't touch starts failing, investigate whether your refactoring broke it. If your change removed code that a test depended on, update that test.

Do NOT run the full test suite (it takes too long). Only run tests relevant to the files you changed. Use `rtk grep` to find related test files:

```bash
rtk grep "import.*from.*<module-you-changed>" --glob "*.test.*"
```

Also verify types:

```bash
rtk tsc -p tsconfig.main.json --noEmit
rtk tsc -p tsconfig.lint.json --noEmit
```

---

## Success Criteria

- Canonical `formatTimestamp` in `src/shared/formatters.ts`
- 15 local definitions removed
- Unit tests for the new canonical function
- Lint and tests pass
