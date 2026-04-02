# Phase 02: Fix AgentCapabilities Double-Definition Bug

## Objective

Fix `AgentCapabilities` being defined twice in the same file (`renderer/global.d.ts` at lines 61 and 104), which can cause type-shadowing bugs. Then consolidate the 6 total definitions across the codebase to a single canonical source.

**Evidence:** `docs/agent-guides/scans/SCAN-TYPES.md`, "AgentCapabilities (6 definitions)"
**Risk:** Medium - type changes can cascade. Build verification is critical.
**Estimated savings:** ~50 lines, eliminates potential type-shadowing bug

---

## Pre-flight Checks

- [ ] Phase 01 (dead code removal) is complete
- [ ] `rtk npm run lint` passes

---

## Tasks

### Task 1: Inventory all AgentCapabilities definitions

Find every definition:

```
rtk grep "interface AgentCapabilities" src/ --include="*.ts" --include="*.tsx"
rtk grep "type AgentCapabilities" src/ --include="*.ts" --include="*.tsx"
```

Expected locations (6 definitions):

1. `src/shared/types.ts` - Likely canonical
2. `src/main/agents/capabilities.ts` - Domain-specific
3. `src/renderer/global.d.ts` line ~61 - First definition
4. `src/renderer/global.d.ts` line ~104 - DUPLICATE in same file (BUG)
5. `src/renderer/types/index.ts` - Re-declaration
6. `src/main/preload.ts` - Preload boundary re-declaration

### Task 2: Compare all definitions for field differences

Read each definition and compare fields. Document any differences - the canonical version must be a superset of all fields used anywhere.

### Task 3: Establish canonical definition

The canonical `AgentCapabilities` should live in `src/shared/types.ts`. Ensure it contains ALL fields from every definition.

### Task 4: Fix the double-definition in global.d.ts

Open `src/renderer/global.d.ts` and remove the duplicate `AgentCapabilities` definition (the one at line ~104). Keep the one that matches the canonical definition, or remove both and reference the shared type.

### Task 5: Remove redundant definitions

For each non-canonical definition:

- If the file imports from `shared/types.ts`, remove the local definition
- If the file is `global.d.ts` or `preload.ts`, reference the shared type via import
- If the file can't import (ambient declaration), ensure the definition matches exactly

### Task 6: Update imports across the codebase

Find all files that import `AgentCapabilities` and ensure they import from `src/shared/types.ts`:

```
rtk grep "AgentCapabilities" src/ --include="*.ts" --include="*.tsx" | grep "import"
```

### Task 7: Verify no type mismatches

```
rtk npm run lint
```

TypeScript type checking will catch any field mismatches between the old and new definitions. Fix any errors that arise.

### Task 8: Run full test suite

```
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

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

- Only ONE canonical `AgentCapabilities` definition in `src/shared/types.ts`
- The double-definition in `global.d.ts` is fixed
- All imports point to canonical source
- `rtk npm run lint` passes (no type errors)
- `rtk vitest run` passes
