# Phase 03-D: Consolidate createMockTab/createMockAITab Factories

## Objective

Replace 12 local `createMockTab`/`createMockAITab` factory definitions across test files with a shared factory.

**Evidence:** `docs/agent-guides/scans/SCAN-MOCKS.md`, "createMockAITab / createMockTab definitions"
**Risk:** Zero production risk - test-only changes
**Estimated savings:** ~80 lines

---

## Pre-flight Checks

- [ ] Phase 03-C (window.maestro mocks) is complete
- [ ] `rtk vitest run` passes

---

## Tasks

### Task 1: Find all definitions

- [ ] Find all tab factory definitions: `rtk grep "function createMockTab\|function createMockAITab\|const createMockTab\|const createMockAITab" src/__tests__/ --glob "*.{ts,tsx}"`
- [ ] List all 12 files with local definitions

### Task 2: Read the AITab and Tab type definitions

- [ ] Find AITab type: `rtk grep "interface AITab\|type AITab " src/ --glob "*.ts" | rtk grep -v "__tests__"`
- [ ] Find FilePreviewTab type: `rtk grep "interface FilePreviewTab\|type FilePreviewTab " src/ --glob "*.ts" | rtk grep -v "__tests__"`
- [ ] Read both type definitions and list all required fields

### Task 3: Create shared mockTab.ts

- [ ] Create `src/__tests__/helpers/mockTab.ts`
- [ ] Implement `createMockAITab(overrides: Partial<AITab> = {}): AITab` with sensible defaults for ALL required fields
- [ ] Implement `createMockFileTab(overrides: Partial<FilePreviewTab> = {}): FilePreviewTab` with sensible defaults
- [ ] Verify types: `rtk tsc -p tsconfig.lint.json --noEmit`

### Task 4: Export from helpers/index.ts

- [ ] Add to `src/__tests__/helpers/index.ts`: `export { createMockAITab, createMockFileTab } from './mockTab';`

### Task 5: Migrate all 12 definitions

For each of the 12 files:

- [ ] Remove the local factory function
- [ ] Add import from `../helpers/mockTab` (adjust relative path)
- [ ] Adjust any unique override patterns to work with the new signature
- [ ] Run file-level test: `rtk vitest run path/to/file.test.ts`

### Task 6: Final verification

- [ ] Run all tests: `rtk vitest run`
- [ ] Confirm zero new test failures

### Task 7: Verify cleanup

- [ ] Check for orphans: `rtk grep "function createMockTab\|function createMockAITab\|const createMockTab\|const createMockAITab" src/__tests__/ --glob "*.{ts,tsx}" | rtk grep -v "helpers/"`
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

- Shared tab factories in `src/__tests__/helpers/mockTab.ts`
- 12 local definitions removed
- All tests pass
