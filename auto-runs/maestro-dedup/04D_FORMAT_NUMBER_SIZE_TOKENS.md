# Phase 04-D: Consolidate formatNumber, formatFileSize, estimateTokens, stripAnsi, generateId

## Objective

Consolidate the remaining formatter/utility duplications:

- 5 redundant `formatNumber` definitions (canonical at `shared/formatters.ts:41`)
- 2 redundant `formatFileSize` definitions (canonical `formatSize` at `shared/formatters.ts:27`)
- 4 redundant `estimateTokens` definitions (canonical at `shared/formatters.ts:176`)
- 2 `stripAnsi` definitions (canonical at `shared/stringUtils.ts:36`)
- 5 redundant `generateId`/`generateUUID` definitions (canonical at `shared/uuid.ts:10`)

**Evidence:** `docs/agent-guides/scans/SCAN-FORMATTERS.md`
**Risk:** Low - pure utility functions
**Estimated savings:** ~155 lines total

---

## Pre-flight Checks

- [ ] Phase 04-C (formatTimestamp) is complete
- [ ] `rtk npm run lint` passes

---

## Tasks

### Task 1: Consolidate formatNumber (5 definitions)

Canonical: `src/shared/formatters.ts:41` - `formatNumber`

Remove local definitions from:

1. `symphony.ts:928`
2. `AgentComparisonChart.tsx:93`
3. `AutoRunStats.tsx:70`
4. `LocationDistributionChart.tsx:40`
5. `SourceDistributionChart.tsx:62`
6. `SummaryCards.tsx:72`

For each: remove local function, add `import { formatNumber } from '../../shared/formatters';`

### Task 2: Consolidate formatFileSize (2 definitions)

Canonical: `src/shared/formatters.ts:27` - `formatSize`

Remove local definitions from:

1. `FilePreview.tsx:265`
2. `documentStats.ts:92`

**NOTE:** The canonical name is `formatSize` but local definitions use `formatFileSize`. Either:

- Add `export { formatSize as formatFileSize }` to `shared/formatters.ts`, OR
- Rename call sites to use `formatSize`

Prefer renaming call sites since there are only 2.

### Task 3: Consolidate estimateTokens (4 redundant + 2 canonical)

Two canonical sources exist:

- `shared/formatters.ts:176` - `estimateTokenCount`
- `renderer/utils/tokenCounter.ts:55` - `estimateTokenCount`

First, decide which is canonical. Prefer `shared/formatters.ts` since it's accessible from both main and renderer.

Then remove local copies from:

1. `MergeSessionModal.tsx` / `SendToAgentModal.tsx` (identical pair)
2. `useMergeSession.ts` / `useSendToAgent.ts` (identical pair)

Also reconcile the two canonical sources - if `renderer/utils/tokenCounter.ts` has extra logic, move it to `shared/formatters.ts` and re-export from the renderer location.

### Task 4: Consolidate stripAnsi (2 definitions)

Two definitions:

- `main/utils/stripAnsi.ts:47` - standalone file
- `shared/stringUtils.ts:36` - `stripAnsiCodes`

Keep `shared/stringUtils.ts:36` as canonical. Update all importers of `main/utils/stripAnsi.ts` to import from `shared/stringUtils.ts`:

```
rtk grep "stripAnsi" src/ --glob="*.{ts,tsx}" | rtk grep "import"
```

Then either:

- Delete `main/utils/stripAnsi.ts` entirely, OR
- Replace its content with a re-export: `export { stripAnsiCodes as stripAnsi } from '../../shared/stringUtils';`

### Task 5: Consolidate generateId/generateUUID (5 redundant)

Canonical: `shared/uuid.ts:10` - `generateUUID`
Also: `renderer/utils/ids.ts:2` - `generateId`

Remove local copies from:

1. `main/stats/utils.ts:29`
2. `useBatchedSessionUpdates.ts:99`
3. `useLayerStack.ts:35`
4. `useCommandHistory.ts:67`
5. `useOfflineQueue.ts:107`

Replace with import from `shared/uuid.ts` for main process files, or `renderer/utils/ids.ts` for renderer files.

### Task 6: Verify

```
rtk npm run lint
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

### Task 7: Final cleanup check

```
rtk grep "function formatNumber\b" src/ | rtk grep -v "shared/formatters" | rtk grep -v "__tests__"
rtk grep "function formatFileSize|function formatSize\b" src/ | rtk grep -v "shared/formatters" | rtk grep -v "__tests__"
rtk grep "function estimateToken" src/ | rtk grep -v "shared/formatters" | rtk grep -v "tokenCounter" | rtk grep -v "__tests__"
rtk grep "function stripAnsi" src/ | rtk grep -v "shared/stringUtils" | rtk grep -v "__tests__"
rtk grep "function generateId|function generateUUID" src/ | rtk grep -v "shared/uuid" | rtk grep -v "renderer/utils/ids" | rtk grep -v "__tests__"
```

All should return 0 results.

---

## Success Criteria

- All formatter/utility duplications consolidated to canonical sources
- ~155 lines removed
- Re-exports added where needed for backwards compatibility
- Lint and tests pass
