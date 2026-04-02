# Phase 03-A: Consolidate createMockSession Factories

## Objective

Replace 66 separate `createMockSession` factory definitions across 66 test files with a single shared factory in `src/__tests__/helpers/mockSession.ts`.

**Evidence:** `docs/agent-guides/scans/SCAN-MOCKS.md`, "createMockSession definitions"
**Risk:** Zero production risk - test-only changes
**Estimated savings:** ~660 lines

---

## Pre-flight Checks

- [x] Phase 02 (type bug fix) is complete
- [x] `rtk vitest run` passes (baseline)

**Completed 2026-04-02:** Consolidated 62 local `createMockSession` factory definitions into a single shared factory at `src/__tests__/helpers/mockSession.ts`. 3 definitions were correctly excluded (2 `SessionInfo` type in cue tests, 1 `SessionBroadcastData` type in broadcastService test).

Factory approach:

- Shared factory provides sensible defaults for ALL required Session fields
- 45 files use the shared factory directly (standard `Partial<Session>` overrides)
- 17 files use thin local wrappers that call the shared factory with test-specific defaults (e.g., pre-populated AI tabs, specific cwd paths)
- 1 file (InputArea.test.tsx) uses a wrapper for wizardState extraction logic
- 1 file (useSendToAgent.test.ts) uses a renamed convenience helper `createTestSession` for positional-arg calls

Files created:

- `src/__tests__/helpers/mockSession.ts` - shared factory
- `src/__tests__/helpers/index.ts` - barrel export

Verification: `tsc --noEmit` passes for tsconfig.lint.json. 14,730 tests pass across all migrated files. 2 pre-existing failures in SessionList (sidebar width rendering, unrelated to migration).

---

## Tasks

### Task 1: Create the helpers directory

- [ ] Create directory: `mkdir -p src/__tests__/helpers/`

### Task 2: Survey existing mock session factories

- [ ] Find all files with definitions: `rtk grep "createMockSession" src/__tests__/ --glob "*.{ts,tsx}" -l`
- [ ] Count total definitions: `rtk grep "function createMockSession\|const createMockSession" src/__tests__/ --glob "*.{ts,tsx}"`
- [ ] Read 5-6 representative definitions to understand common patterns and variations

### Task 3: Read the Session interface

- [ ] Read the `Session` interface in `src/shared/types.ts`
- [ ] Check `src/renderer/types/index.ts` for any renderer-specific session types
- [ ] List all required fields the mock factory must provide

### Task 4: Create shared mockSession.ts

- [ ] Create `src/__tests__/helpers/mockSession.ts`
- [ ] Implement `createMockSession(overrides: Partial<Session> = {}): Session` with sensible defaults for ALL required Session fields
- [ ] Verify the factory satisfies TypeScript with zero overrides: `rtk tsc -p tsconfig.lint.json --noEmit`

### Task 5: Create index.ts barrel export

- [ ] Create `src/__tests__/helpers/index.ts` with: `export { createMockSession } from './mockSession';`

### Task 6: Migrate test files in batches of 10

For each batch, per file:

- [ ] Remove the local `createMockSession` definition
- [ ] Add import: `import { createMockSession } from '../helpers/mockSession';` (adjust relative path)
- [ ] Verify custom overrides still work with the new factory signature
- [ ] Run file-level test: `rtk vitest run path/to/file.test.ts`

Process all 66 files in directory order:

- [ ] Batch 1: `src/__tests__/renderer/components/*.test.tsx` (files 1-10)
- [ ] Batch 2: `src/__tests__/renderer/components/*.test.tsx` (files 11-20)
- [ ] Batch 3: `src/__tests__/renderer/components/*.test.tsx` (files 21-30)
- [ ] Batch 4: `src/__tests__/renderer/components/*.test.tsx` (remaining)
- [ ] Batch 5: `src/__tests__/renderer/hooks/*.test.ts`
- [ ] Batch 6: `src/__tests__/renderer/stores/*.test.ts`
- [ ] Batch 7: `src/__tests__/main/*.test.ts` and `src/__tests__/shared/*.test.ts`

### Task 7: Handle edge cases

- [ ] Identify factories with unique behavior (auto-incrementing IDs, different agent types, etc.)
- [ ] For each unique factory, determine if it can be handled via overrides to the shared factory
- [ ] If not, create a thin local wrapper that calls the shared factory with test-specific defaults
- [ ] If truly different types (e.g., `SessionInfo` instead of `Session`), keep the local definition

### Task 8: Verify all tests pass

- [ ] Run all tests: `rtk vitest run`
- [ ] If any fail, check that the shared factory defaults match what the individual test expected
- [ ] Fix failures by adjusting overrides or factory defaults

### Task 9: Clean up - verify no orphaned local factories remain

- [ ] Check for orphans: `rtk grep "function createMockSession\|const createMockSession" src/__tests__/ --glob "*.{ts,tsx}" | rtk grep -v "helpers/mockSession"`
- [ ] Result should be 0 (or only intentional thin wrappers calling the shared factory)

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

- Single `createMockSession` factory in `src/__tests__/helpers/mockSession.ts`
- 66 local definitions removed
- All tests pass
- Factory supports all override patterns used by existing tests
