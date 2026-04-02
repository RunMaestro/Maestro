# Phase 12: Constants, Minor Dedup, and CSS Cleanup

## Objective

Clean up remaining P3 (nice-to-have) duplications:
- 3 redundant `AUTO_RUN_FOLDER_NAME` definitions
- 2 `DEFAULT_CAPABILITIES` definitions
- Compound CSS className patterns extracted to shared constants

**Evidence:** `docs/agent-guides/scans/SCAN-TYPES.md` (constants), `docs/agent-guides/scans/SCAN-COMPONENTS.md` (CSS)
**Risk:** Very low
**Estimated savings:** ~126 lines

---

## Pre-flight Checks

- [ ] Phase 11 (logging) is complete
- [ ] `rtk npm run lint` passes

---

## Tasks

### Task 1: Remove AUTO_RUN_FOLDER_NAME aliases (3 definitions)

The constant `AUTO_RUN_FOLDER_NAME = PLAYBOOKS_DIR` exists in 3 places:
1. `phaseGenerator.ts:153`
2. `inlineWizardDocumentGeneration.ts:25`
3. `existingDocsDetector.ts:13`

The canonical `PLAYBOOKS_DIR` is already exported from `shared/maestro-paths.ts:14`.

For each file:
1. Remove the local `AUTO_RUN_FOLDER_NAME` declaration
2. Replace all usages with `PLAYBOOKS_DIR`
3. Add import: `import { PLAYBOOKS_DIR } from '../../shared/maestro-paths';`

### Task 2: Consolidate DEFAULT_CAPABILITIES (2 definitions)

Two locations:
1. `main/agents/capabilities.ts:98` (canonical)
2. `renderer/hooks/agent/useAgentCapabilities.ts:89`

The renderer can't directly import from main process. Options:
- Move `DEFAULT_CAPABILITIES` to `shared/` (best - accessible by both)
- Share via preload bridge
- Re-export from shared types

Steps:
1. Move the constant to `src/shared/agentConstants.ts` or `src/shared/types.ts`
2. Update both import sites
3. Remove the duplicate definition

### Task 3: Extract compound CSS className constants

From SCAN-COMPONENTS.md, the most repeated compound patterns:

```
"w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left" (23x)
"block text-xs font-bold opacity-70 uppercase mb-2" (20x)
```

Create `src/renderer/constants/classNames.ts`:

```typescript
/** Reusable compound className constants for common UI patterns */

/** Full-width interactive list item */
export const LIST_ITEM_CLASS = 'w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left';

/** Section heading label */
export const SECTION_LABEL_CLASS = 'block text-xs font-bold opacity-70 uppercase mb-2';
```

Then migrate the 43 highest-frequency usages:
```
rtk grep -rn "w-full flex items-center gap-3 px-3 py-2.5" src/renderer/ --include="*.tsx" -l
rtk grep -rn "block text-xs font-bold opacity-70 uppercase mb-2" src/renderer/ --include="*.tsx" -l
```

### Task 4: Verify

```
rtk npm run lint
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

---

## Success Criteria

- `AUTO_RUN_FOLDER_NAME` aliases removed, using `PLAYBOOKS_DIR` directly
- `DEFAULT_CAPABILITIES` has single definition in shared code
- Top compound CSS patterns extracted to constants
- Lint and tests pass
