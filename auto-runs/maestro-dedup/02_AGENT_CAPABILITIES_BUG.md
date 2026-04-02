# Phase 02: Fix AgentCapabilities Double-Definition Bug

## Objective

Fix `AgentCapabilities` being defined twice in the same file (`renderer/global.d.ts` at lines 61 and 104), which can cause type-shadowing bugs. Then consolidate the 6 total definitions across the codebase to a single canonical source.

**Evidence:** `docs/agent-guides/scans/SCAN-TYPES.md`, "AgentCapabilities (6 definitions)"
**Risk:** Medium - type changes can cascade. Build verification is critical.
**Estimated savings:** ~50 lines, eliminates potential type-shadowing bug

---

## Pre-flight Checks

- [x] Phase 01 (dead code removal) is complete
- [x] `rtk npm run lint` passes

**Completed 2026-04-02:** Consolidated 7 AgentCapabilities definitions (including double-definition bug in global.d.ts) down to 1 canonical definition in `src/shared/types.ts`. Also consolidated 2 duplicate `DEFAULT_CAPABILITIES` constants. Fixed bugs found:

- `global.d.ts` line 105 was missing `supportsThinkingDisplay` (type-shadowing bug)
- `renderer/types/index.ts` had 10 fields incorrectly marked optional
- `main/preload/agents.ts` was missing 9 fields (severely outdated)
- `hasCapability()` needed `!!` coercion after adding `imageResumeMode?: 'prompt-embed'`

Files modified:

- `src/shared/types.ts` - Added canonical `AgentCapabilities` + `DEFAULT_CAPABILITIES`
- `src/renderer/global.d.ts` - Removed both inline definitions, replaced with `import()` type alias
- `src/renderer/types/index.ts` - Removed local definition, re-exports from shared
- `src/renderer/hooks/agent/useAgentCapabilities.ts` - Removed local definition + `DEFAULT_CAPABILITIES`, imports from shared
- `src/main/agents/capabilities.ts` - Removed local definition + `DEFAULT_CAPABILITIES`, imports from shared
- `src/main/preload/agents.ts` - Removed local definition, imports from shared

Verification: `tsc --noEmit` passes for both `tsconfig.lint.json` and `tsconfig.main.json`. All 18 related test files pass.

---

## Tasks

### Task 1: Inventory all AgentCapabilities definitions

- [ ] Find all interface definitions: `rtk grep "interface AgentCapabilities" src/ --glob "*.{ts,tsx}"`
- [ ] Find all type alias definitions: `rtk grep "type AgentCapabilities" src/ --glob "*.{ts,tsx}"`
- [ ] Document each location and its fields (expect 6 definitions in: `shared/types.ts`, `main/agents/capabilities.ts`, `renderer/global.d.ts` line ~61, `renderer/global.d.ts` line ~104 (BUG), `renderer/types/index.ts`, `main/preload.ts`)

### Task 2: Compare all definitions for field differences

- [ ] Read each definition and list its fields
- [ ] Identify any fields present in one definition but missing from others
- [ ] Identify any optional vs required mismatches
- [ ] The canonical version must be a superset of all fields used anywhere

### Task 3: Establish canonical definition

- [ ] Ensure `src/shared/types.ts` contains the canonical `AgentCapabilities` with ALL fields from every definition
- [ ] If any definition has unique fields, add them to the canonical version

### Task 4: Fix the double-definition in global.d.ts

- [ ] Open `src/renderer/global.d.ts`
- [ ] Remove the duplicate `AgentCapabilities` at line ~104
- [ ] Remove or replace the definition at line ~61 with an `import()` type alias referencing `src/shared/types.ts`

### Task 5: Remove redundant definitions

- [ ] Remove local `AgentCapabilities` from `src/main/agents/capabilities.ts`, replace with import from `src/shared/types.ts`
- [ ] Remove local `AgentCapabilities` from `src/renderer/types/index.ts`, replace with re-export from `src/shared/types.ts`
- [ ] Remove local `AgentCapabilities` from `src/main/preload.ts`, replace with import from `src/shared/types.ts`
- [ ] Also consolidate any duplicate `DEFAULT_CAPABILITIES` constants to `src/shared/types.ts`

### Task 6: Update imports across the codebase

- [ ] Find all imports: `rtk grep "AgentCapabilities" src/ --glob "*.{ts,tsx}" | rtk grep "import"`
- [ ] Update each file to import from `src/shared/types.ts` (or `src/renderer/types/index.ts` re-export for renderer files)

### Task 7: Verify no type mismatches

- [ ] Run type checking: `rtk tsc -p tsconfig.lint.json --noEmit && rtk tsc -p tsconfig.main.json --noEmit`
- [ ] Fix any type errors that arise from field mismatches

### Task 8: Run tests

- [ ] Find related test files: `rtk grep "AgentCapabilities\|DEFAULT_CAPABILITIES" src/__tests__/ --glob "*.test.{ts,tsx}" -l`
- [ ] Run related tests: `rtk vitest run <related-test-files>`
- [ ] Confirm zero new test failures from your changes

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
