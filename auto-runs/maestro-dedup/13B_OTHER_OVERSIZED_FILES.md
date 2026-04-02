# Phase 13-B: Decompose Other Oversized Files

## Objective

Address the remaining oversized files after App.tsx. Priority targets are files over 2,000 lines that contain significant duplication identified in earlier phases.

**Evidence:** `docs/agent-guides/scans/SCAN-OVERSIZED.md`
**Risk:** Medium-high - these are complex files. Work incrementally.
**Estimated savings:** Improved maintainability

---

## Pre-flight Checks

- [ ] Phase 13-A (App.tsx decomposition) is complete
- [ ] `rtk npm run lint` passes
- [ ] `rtk vitest run` passes

---

## Important Context

Current oversized files status:
- `App.tsx` - 4,034 lines (REGRESSION, addressed in Phase 13-A)
- `symphony.ts` handler - 3,318 lines
- `TabBar.tsx` - FULLY RESOLVED (2,839 -> 542)
- `FilePreview.tsx` - PARTIALLY RESOLVED (2,662 -> 1,320)
- `SymphonyModal.tsx` - large (check current size)
- `useTabHandlers.ts` - large (should be smaller after Phase 07)
- `useInputProcessing.ts` - large (should be smaller after Phase 07)

---

## Tasks

### Task 1: Re-measure after prior phases

Many earlier phases (formatters, state patterns, mocks) will have already reduced some files. Re-measure:

```
find src/ -name "*.ts" -o -name "*.tsx" | xargs wc -l | sort -rn | head -30
```

Only target files still over 1,500 lines.

### Task 2: Decompose symphony.ts handler (3,318 lines)

`src/main/ipc/handlers/symphony.ts` - the Symphony (group chat orchestration) handler.

Strategy:
1. Read the file to identify logical sections
2. Extract each IPC handler into its own function or sub-module
3. Keep the main file as a registration point

Create `src/main/ipc/handlers/symphony/`:
- `index.ts` - handler registration
- `create.ts` - create group chat handlers
- `manage.ts` - manage/update group chat handlers
- `participants.ts` - participant management handlers
- `messages.ts` - message handling
- `export.ts` - export/history handlers

### Task 3: Decompose SymphonyModal.tsx

Strategy:
1. Extract sub-panels into separate components
2. Extract state management into a custom hook
3. Keep the modal shell as the coordinator

Potential extractions:
- `SymphonyParticipantList.tsx`
- `SymphonyMessageView.tsx`
- `SymphonyConfigPanel.tsx`
- `useSymphonyModal.ts` (state hook)

### Task 4: Finish FilePreview.tsx decomposition (1,320 lines)

Already partially split. Identify remaining extractable sections:
- Language-specific renderers
- Toolbar logic
- Preview mode switching

### Task 5: Address useTabHandlers.ts and useInputProcessing.ts

After Phase 07 (session state helpers), these files should be significantly smaller. Check if they still exceed 800 lines.

If still oversized:
- `useTabHandlers.ts` - split by tab operation type (create, close, reorder, activate)
- `useInputProcessing.ts` - split by input type (text, slash commands, file drops)

### Task 6: Verify after each decomposition

```
rtk npm run lint
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

### Task 7: Final oversized file count

```
find src/ -name "*.ts" -o -name "*.tsx" | xargs wc -l | awk '$1 > 800' | sort -rn | wc -l
```

Target: fewer than 40 files over 800 lines (down from 82).

---

## Success Criteria

- `symphony.ts` handler split into focused modules
- `SymphonyModal.tsx` split into sub-components
- `FilePreview.tsx` further decomposed if still >800 lines
- Post-Phase-07 files re-checked
- Lint and tests pass
- Fewer than 40 files over 800 lines
