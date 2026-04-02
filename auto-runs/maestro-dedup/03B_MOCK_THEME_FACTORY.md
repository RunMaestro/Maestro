# Phase 03-B: Consolidate createMockTheme and mockTheme Definitions

## Objective

Replace 35 `createMockTheme` functions and 119 inline `mockTheme` objects (154 total) with a single shared factory in `src/__tests__/helpers/mockTheme.ts`.

**Evidence:** `docs/agent-guides/scans/SCAN-MOCKS.md`, "createMockTheme definitions" + "mockTheme object definitions"
**Risk:** Zero production risk - test-only changes
**Estimated savings:** ~500 lines
**NOTE:** Count regressed from 97 to 154 as of 2026-04-01 re-validation.

---

## Pre-flight Checks

- [x] Phase 03-A (mockSession) is complete
- [x] `rtk vitest run` passes

**Completed 2026-04-02:** Consolidated 113 local mockTheme/createMockTheme definitions into a single shared factory at `src/__tests__/helpers/mockTheme.ts`.

Factory approach:

- Shared `mockTheme` constant provides sensible defaults for all 13 required ThemeColors fields
- Shared `mockThemeColors` constant exported for direct color reference in assertions
- `createMockTheme(overrides)` accepts `Partial<Theme>` with deep merge of colors
- 113 files migrated: removed local definitions, added import from shared factory
- Tests with hardcoded color assertions updated to reference `mockTheme.colors.xxx` dynamically
- Special case: ThemePicker.test.tsx uses `createMockTheme({ id, name, mode })` to create full ThemeId records
- Special case: broadcastService.test.ts uses `createMockTheme({ id: 'monokai', name: 'Monokai' })`
- 2 pre-existing test failures (SessionList LIVE mode) are NOT caused by this migration

Files created:

- `src/__tests__/helpers/mockTheme.ts` - shared factory (mockTheme, mockThemeColors, createMockTheme)
- Updated `src/__tests__/helpers/index.ts` - barrel export

---

## Tasks

### Task 1: Survey existing theme mock patterns

- [ ] Find all files with definitions: `rtk grep "createMockTheme\|const mockTheme\|let mockTheme" src/__tests__/ --glob "*.{ts,tsx}" -l`
- [ ] Read 5-6 representative definitions to capture: color properties, theme metadata (name, id, isDark), variant patterns (dark/light)

### Task 2: Read the Theme type definition

- [ ] Find canonical type: `rtk grep "interface Theme\|type Theme " src/ --glob "*.{ts,tsx}" | rtk grep -v "__tests__"`
- [ ] Read the canonical Theme type and list all 13 required color fields

### Task 3: Create shared mockTheme.ts

- [ ] Create `src/__tests__/helpers/mockTheme.ts`
- [ ] Implement `mockTheme` constant with all required Theme fields using real field names from the canonical type
- [ ] Implement `mockThemeColors` constant for direct color reference in assertions
- [ ] Implement `createMockTheme(overrides: Partial<Theme> = {}): Theme` with deep merge of colors
- [ ] Verify types: `rtk tsc -p tsconfig.lint.json --noEmit`

### Task 4: Export from helpers/index.ts

- [ ] Add to `src/__tests__/helpers/index.ts`: `export { mockTheme, mockThemeColors, createMockTheme } from './mockTheme';`

### Task 5: Migrate createMockTheme function definitions (35 files)

For each file with a local `createMockTheme` function:

- [ ] Remove the local function definition
- [ ] Add import: `import { createMockTheme } from '../helpers/mockTheme';` (adjust relative path)
- [ ] Verify custom overrides still work with the new factory signature
- [ ] Run file-level test: `rtk vitest run path/to/file.test.ts`

### Task 6: Migrate inline mockTheme objects (119 instances)

For each file with an inline `const mockTheme = { ... }`:

- [ ] Remove the local `const mockTheme` declaration
- [ ] Add import: `import { mockTheme } from '../helpers/mockTheme';`
- [ ] If the test mutates `mockTheme` properties, switch to `createMockTheme({ ... })` instead
- [ ] Update hardcoded color assertions to reference `mockTheme.colors.xxx` dynamically

Batch by directory:

- [ ] Batch 1: `src/__tests__/renderer/components/` - run tests after: `rtk vitest run src/__tests__/renderer/components/`
- [ ] Batch 2: `src/__tests__/renderer/hooks/` - run tests after: `rtk vitest run src/__tests__/renderer/hooks/`
- [ ] Batch 3: `src/__tests__/renderer/stores/` - run tests after: `rtk vitest run src/__tests__/renderer/stores/`

### Task 7: Run full test suite

- [ ] Run all tests: `rtk vitest run`
- [ ] Fix any failures before proceeding (check that shared mock defaults match individual test expectations)

### Task 8: Verify cleanup complete

- [ ] Check for orphans: `rtk grep "createMockTheme\|const mockTheme.*=.*{" src/__tests__/ --glob "*.{ts,tsx}" | rtk grep -v "helpers/mockTheme" | rtk grep -v "import"`
- [ ] Result should be 0 (or only `let mockTheme` reassignments using the imported factory)

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

- Single `mockTheme` constant and `createMockTheme` factory in `src/__tests__/helpers/mockTheme.ts`
- 154 local definitions/objects removed
- All tests pass
