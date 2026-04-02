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

```
rtk grep "function formatTime\b|const formatTime\b|function formatTimestamp|const formatTimestamp" src/ --glob="*.{ts,tsx}" | rtk grep -v "__tests__"
```

Expected locations:

1. `GroupChatHistoryPanel.tsx`
2. `GroupChatMessages.tsx`
3. `HistoryEntryItem.tsx`
4. `HistoryDetailModal.tsx`
5. `WizardMessageBubble.tsx`
6. `ParticipantCard.tsx`
7. `ThinkingStatusPill.tsx`
8. `LongestAutoRunsTable.tsx`
9. `ConversationScreen.tsx`
10. `conductorBadges.ts`
11. `groupChatExport.ts`
12. `tabExport.ts`
13. `MessageHistory.tsx`
14. `MobileHistoryPanel.tsx`
15. `ResponseViewer.tsx`

### Task 2: Categorize by output format

Read each definition and group them by output format:

- **Format A:** `HH:MM:SS` (24-hour)
- **Format B:** `h:mm AM/PM` (12-hour)
- **Format C:** `MMM D, YYYY h:mm AM/PM` (date + time)
- **Format D:** `relative` ("5 min ago")
- **Other**

### Task 3: Design canonical API

Add to `src/shared/formatters.ts`:

```typescript
/**
 * Format a timestamp for display.
 * @param timestamp - Unix timestamp in milliseconds (Date.now() format)
 * @param style - 'time' for HH:MM, 'datetime' for full date+time, 'relative' for "5m ago"
 */
export function formatTimestamp(
	timestamp: number,
	style: 'time' | 'datetime' | 'relative' = 'time'
): string {
	// Implementation covering all discovered patterns
}
```

If there are truly different output formats, provide multiple style options rather than multiple functions.

### Task 4: Implement and test the canonical function

Write the implementation in `shared/formatters.ts`. Add unit tests in `src/__tests__/shared/formatters.test.ts`:

```typescript
describe('formatTimestamp', () => {
	it('formats time-only', () => { ... });
	it('formats datetime', () => { ... });
	it('handles edge cases (0, negative, future)', () => { ... });
});
```

### Task 5: Migrate all 15 definitions

For each file:

1. Read the local definition to determine which `style` parameter to use
2. Remove the local function
3. Add import: `import { formatTimestamp } from '../../shared/formatters';`
4. If the local function had a different name, either rename the call sites or use: `import { formatTimestamp as formatTime } from ...`

### Task 6: Handle main process files separately

`groupChatExport.ts` and `tabExport.ts` are in the main process. They can import from `shared/formatters` directly.

`conductorBadges.ts` may also be main process - check and import accordingly.

### Task 7: Verify

```
rtk npm run lint
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

### Task 8: Verify no orphaned definitions remain

```
rtk grep "function formatTime\b|function formatTimestamp" src/ --glob="*.{ts,tsx}" | rtk grep -v "shared/formatters" | rtk grep -v "__tests__"
```

Should return 0 results.

---

## Success Criteria

- Canonical `formatTimestamp` in `src/shared/formatters.ts`
- 15 local definitions removed
- Unit tests for the new canonical function
- Lint and tests pass
