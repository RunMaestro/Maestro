# Phase 05: Deduplicate Type/Interface Definitions

## Objective

Consolidate 28 interfaces that have 98 redundant definitions across the codebase. The root cause is the preload boundary re-declaration pattern: types defined in `shared/`, re-declared in `main/preload.ts`, re-declared in `renderer/types/index.ts` and `renderer/global.d.ts`, then again locally.

**Evidence:** `docs/agent-guides/scans/SCAN-TYPES.md`
**Risk:** Medium - type changes cascade across process boundaries. Build verification is critical after each change.
**Estimated savings:** ~370 lines

---

## Pre-flight Checks

- [ ] Phase 04 (formatters) is complete
- [ ] `rtk npm run lint` passes
- [ ] `rtk vitest run` passes

---

## Important Context

Electron apps have three process contexts:

1. **Main process** (`src/main/`) - Node.js, full access
2. **Preload** (`src/main/preload.ts`) - Bridge between main and renderer
3. **Renderer** (`src/renderer/`) - Browser context, limited access

Types in `src/shared/` are importable by all three. The problem is that instead of importing from `shared/`, many files re-declare the same interfaces.

**Strategy:** Establish `src/shared/types.ts` as the single source of truth. Update preload and renderer to import from shared rather than re-declaring.

---

## Tasks

### Task 1: Inventory all duplicated interfaces

For the top offenders, find every definition:

```
rtk grep "interface AgentCapabilities" src/ --glob="*.{ts,tsx}"
rtk grep "interface UsageStats" src/ --glob="*.{ts,tsx}"
rtk grep "interface SessionInfo" src/ --glob="*.{ts,tsx}"
rtk grep "interface AgentConfig\b" src/ --glob="*.{ts,tsx}"
rtk grep "interface AgentConfigsData" src/ --glob="*.{ts,tsx}"
```

For each, record: file, line number, field list.

### Task 2: Handle AgentCapabilities (6 defs, was addressed in Phase 02)

If Phase 02 already resolved this, verify it's done:

```
rtk grep "interface AgentCapabilities" src/ --glob="*.{ts,tsx}" | wc -l
```

Should be 1 (canonical only). If not, finish the work from Phase 02.

### Task 3: Consolidate UsageStats (6 definitions)

Canonical should be in `src/shared/stats-types.ts` or `src/shared/types.ts`.

1. Find all 6 definitions
2. Compare fields - create a superset
3. Establish canonical in `shared/stats-types.ts`
4. Replace all other definitions with imports
5. Run `rtk npm run lint` after each file change

### Task 4: Consolidate SessionInfo (3 definitions)

Down from 6 to 3 as of 2026-04-01.

1. Find all 3 definitions
2. Compare fields
3. Keep canonical in `shared/types.ts`
4. Replace others with imports

### Task 5: Consolidate AgentConfig (5 definitions)

1. Find all 5 definitions
2. Compare fields
3. Keep canonical in `shared/types.ts` or `main/agents/definitions.ts`
4. Replace others with imports

### Task 6: Consolidate AgentConfigsData (5 definitions)

1. Find all 5 definitions
2. This is typically `Record<string, AgentConfig>` or similar
3. Keep one canonical definition alongside `AgentConfig`
4. Replace others

### Task 7: Consolidate remaining 3+ definition interfaces

For each of the 17 interfaces with 3 definitions (51 total):

```
rtk grep "interface SshRemoteConfig\b" src/
rtk grep "interface ParsedOutput\b" src/
rtk grep "interface AutoRunConfig\b" src/
# ... etc for each duplicated interface from SCAN-TYPES.md
```

Work through them systematically:

1. Find definitions
2. Compare fields
3. Pick canonical location
4. Replace duplicates with imports

### Task 8: Fix the preload type-sharing mechanism

The root cause is that `renderer/global.d.ts` declares ambient types that can't import. Fix this by:

1. Moving type declarations from `global.d.ts` to importable `.ts` files
2. Using `import type` in renderer files
3. Keeping `global.d.ts` minimal - only for true ambient declarations (e.g., `window.maestro` shape)

**This is the most impactful change** - it prevents the re-declaration pattern from recurring.

### Task 9: Clean up renderer/types/index.ts

This file likely re-exports or re-declares many shared types. Replace re-declarations with re-exports:

```typescript
// BEFORE (re-declaration)
export interface AgentCapabilities { ... }

// AFTER (re-export)
export type { AgentCapabilities } from '../../shared/types';
```

### Task 10: Verify no duplicate definitions remain

```
# Count definitions for each top-offender interface
for iface in AgentCapabilities UsageStats SessionInfo AgentConfig AgentConfigsData; do
  echo "$iface: $(rtk grep "interface $iface\b" src/ --glob="*.{ts,tsx}" | wc -l)"
done
```

Each should show 1.

### Task 11: Full verification

```
rtk npm run lint
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

- Each of 28 duplicated interfaces has exactly 1 canonical definition
- ~98 redundant definitions removed
- `renderer/global.d.ts` no longer re-declares shared types
- Preload boundary uses imports from `shared/`
- Lint and tests pass
