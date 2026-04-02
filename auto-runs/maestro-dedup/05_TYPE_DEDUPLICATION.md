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

- [ ] Find AgentCapabilities definitions: `rtk grep "interface AgentCapabilities" src/ --glob "*.{ts,tsx}"`
- [ ] Find UsageStats definitions: `rtk grep "interface UsageStats" src/ --glob "*.{ts,tsx}"`
- [ ] Find SessionInfo definitions: `rtk grep "interface SessionInfo" src/ --glob "*.{ts,tsx}"`
- [ ] Find AgentConfig definitions: `rtk grep "interface AgentConfig\b" src/ --glob "*.{ts,tsx}"`
- [ ] Find AgentConfigsData definitions: `rtk grep "interface AgentConfigsData" src/ --glob "*.{ts,tsx}"`
- [ ] For each, record: file path, line number, field list

### Task 2: Handle AgentCapabilities (6 defs, was addressed in Phase 02)

- [ ] Verify Phase 02 is done: `rtk grep "interface AgentCapabilities" src/ --glob "*.{ts,tsx}"` (expect exactly 1 result)
- [ ] If more than 1, finish the Phase 02 consolidation work before continuing

### Task 3: Consolidate UsageStats (6 definitions)

- [ ] Read all 6 definitions and compare fields
- [ ] Create a superset definition as canonical in `src/shared/stats-types.ts`
- [ ] Replace definition in each non-canonical file with `import type { UsageStats } from '../../shared/stats-types';`
- [ ] Run lint after each file: `rtk tsc -p tsconfig.lint.json --noEmit`

### Task 4: Consolidate SessionInfo (3 definitions)

- [ ] Read all 3 definitions and compare fields
- [ ] Keep canonical definition in `src/shared/types.ts`
- [ ] Replace other 2 definitions with imports from `shared/types.ts`

### Task 5: Consolidate AgentConfig (5 definitions)

- [ ] Read all 5 definitions and compare fields
- [ ] Keep canonical in `src/shared/types.ts` or `src/main/agents/definitions.ts`
- [ ] Replace other 4 definitions with imports

### Task 6: Consolidate AgentConfigsData (5 definitions)

- [ ] Read all 5 definitions (typically `Record<string, AgentConfig>` or similar)
- [ ] Keep one canonical definition alongside `AgentConfig`
- [ ] Replace other 4 definitions with imports

### Task 7: Consolidate remaining 3+ definition interfaces

For each of the 17 interfaces with 3 definitions (51 total), from SCAN-TYPES.md:

- [ ] Read `docs/agent-guides/scans/SCAN-TYPES.md` for the full findings list
- [ ] For each duplicated interface: find definitions, compare fields, pick canonical location
- [ ] Replace duplicate definitions with imports from canonical source
- [ ] Run `rtk tsc -p tsconfig.lint.json --noEmit` after each batch of changes

### Task 8: Fix the preload type-sharing mechanism

- [ ] Move type declarations from `renderer/global.d.ts` to importable `.ts` files
- [ ] Update renderer files to use `import type` instead of relying on ambient declarations
- [ ] Keep `global.d.ts` minimal - only true ambient declarations (e.g., `window.maestro` shape)
- [ ] This prevents the re-declaration pattern from recurring

### Task 9: Clean up renderer/types/index.ts

- [ ] Read `src/renderer/types/index.ts` and identify all re-declared types
- [ ] Replace each re-declaration with a re-export: `export type { TypeName } from '../../shared/types';`
- [ ] Verify no local definitions remain that have canonical sources in shared/

### Task 10: Verify no duplicate definitions remain

- [ ] Count AgentCapabilities: `rtk grep "interface AgentCapabilities\b" src/ --glob "*.{ts,tsx}"` (expect 1)
- [ ] Count UsageStats: `rtk grep "interface UsageStats\b" src/ --glob "*.{ts,tsx}"` (expect 1)
- [ ] Count SessionInfo: `rtk grep "interface SessionInfo\b" src/ --glob "*.{ts,tsx}"` (expect 1)
- [ ] Count AgentConfig: `rtk grep "interface AgentConfig\b" src/ --glob "*.{ts,tsx}"` (expect 1)
- [ ] Count AgentConfigsData: `rtk grep "interface AgentConfigsData\b" src/ --glob "*.{ts,tsx}"` (expect 1)

### Task 11: Full verification

- [ ] Run lint: `rtk npm run lint`
- [ ] Run type checking: `rtk tsc -p tsconfig.main.json --noEmit && rtk tsc -p tsconfig.lint.json --noEmit`
- [ ] Find related test files: `rtk grep "UsageStats\|SessionInfo\|AgentConfig" src/__tests__/ --glob "*.test.{ts,tsx}" -l`
- [ ] Run related tests: `rtk vitest run <related-test-files>`
- [ ] Confirm zero new test failures

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
