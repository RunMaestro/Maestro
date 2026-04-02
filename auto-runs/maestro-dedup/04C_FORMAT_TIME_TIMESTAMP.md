# Phase 04-C: Create Canonical formatTimestamp and Consolidate 15 Definitions

## Objective

Create a canonical `formatTimestamp` in `src/shared/formatters.ts` and replace 15 local `formatTime`/`formatTimestamp` definitions that currently have NO canonical source.

**Evidence:** `docs/agent-guides/scans/SCAN-FORMATTERS.md`, "formatTime / formatTimestamp re-definitions"
**Risk:** Low-medium - must ensure all 15 sites produce the same output format after consolidation
**Estimated savings:** ~100 lines

---

## Pre-flight Checks

- [ ] Phase 04-B (formatElapsedTime) is complete
- [ ] `rtk npm run lint` passes

---

## Tasks

### Task 1: Inventory all 15 definitions

- [ ] Find all definitions: `rtk grep "function formatTime\b\|const formatTime\b\|function formatTimestamp\|const formatTimestamp" src/ --glob "*.{ts,tsx}" | rtk grep -v "__tests__"`
- [ ] Confirm expected locations: `GroupChatHistoryPanel.tsx`, `GroupChatMessages.tsx`, `HistoryEntryItem.tsx`, `HistoryDetailModal.tsx`, `WizardMessageBubble.tsx`, `ParticipantCard.tsx`, `ThinkingStatusPill.tsx`, `LongestAutoRunsTable.tsx`, `ConversationScreen.tsx`, `conductorBadges.ts`, `groupChatExport.ts`, `tabExport.ts`, `MessageHistory.tsx`, `MobileHistoryPanel.tsx`, `ResponseViewer.tsx`

### Task 2: Categorize by output format

- [ ] Read each of the 15 definitions
- [ ] Group by output format: `HH:MM:SS` (24-hour), `h:mm AM/PM` (12-hour), `MMM D, YYYY h:mm AM/PM` (date+time), relative ("5 min ago"), other
- [ ] Document which style each call site needs

### Task 3: Design canonical API

- [ ] Add `formatTimestamp(timestamp: number, style: 'time' | 'datetime' | 'relative' = 'time'): string` to `src/shared/formatters.ts`
- [ ] If there are truly different output formats, provide multiple style options rather than multiple functions

### Task 4: Implement and test the canonical function

- [ ] Write the implementation in `src/shared/formatters.ts` covering all discovered output patterns
- [ ] Add unit tests in `src/__tests__/shared/formatters.test.ts` for each style variant
- [ ] Test edge cases: timestamp 0, negative values, future timestamps
- [ ] Run tests: `rtk vitest run src/__tests__/shared/formatters.test.ts`

### Task 5: Migrate all 15 definitions

For each file:

- [ ] Read the local definition to determine which `style` parameter to use
- [ ] Remove the local function
- [ ] Add import: `import { formatTimestamp } from '../../shared/formatters';` (adjust path)
- [ ] If local function was named `formatTime`, use: `import { formatTimestamp as formatTime } from ...`
- [ ] Verify output matches the old local definition

### Task 6: Handle main process files separately

- [ ] Replace in `groupChatExport.ts` - import from `shared/formatters` directly
- [ ] Replace in `tabExport.ts` - import from `shared/formatters` directly
- [ ] Check if `conductorBadges.ts` is main process, import accordingly

### Task 7: Verify

- [ ] Run lint: `rtk npm run lint`
- [ ] Run related tests: `rtk vitest run src/__tests__/shared/formatters.test.ts`
- [ ] Find and run component tests that use formatTime/formatTimestamp: `rtk grep "formatTime\|formatTimestamp" src/__tests__/ --glob "*.test.{ts,tsx}" -l`
- [ ] Confirm zero new test failures

### Task 8: Verify no orphaned definitions remain

- [ ] Check: `rtk grep "function formatTime\b\|function formatTimestamp" src/ --glob "*.{ts,tsx}" | rtk grep -v "shared/formatters" | rtk grep -v "__tests__"`
- [ ] Result should be 0

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
