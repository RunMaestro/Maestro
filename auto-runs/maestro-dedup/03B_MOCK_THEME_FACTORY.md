# Phase 03-B: Consolidate createMockTheme and mockTheme Definitions

## Objective

Replace 35 `createMockTheme` functions and 119 inline `mockTheme` objects (154 total) with a single shared factory in `src/__tests__/helpers/mockTheme.ts`.

**Evidence:** `docs/agent-guides/scans/SCAN-MOCKS.md`, "createMockTheme definitions" + "mockTheme object definitions"
**Risk:** Zero production risk - test-only changes
**Estimated savings:** ~500 lines
**NOTE:** Count regressed from 97 to 154 as of 2026-04-01 re-validation.

---

## Pre-flight Checks

- [ ] Phase 03-A (mockSession) is complete
- [ ] `rtk vitest run` passes

---

## Tasks

### Task 1: Survey existing theme mock patterns

Find all definitions:

```
rtk grep "createMockTheme\|const mockTheme\|let mockTheme" src/__tests__/ --include="*.ts" --include="*.tsx" -l
```

Read 5-6 to understand the common pattern. Key things to capture:

- Theme color properties (textMain, textSecondary, background, accent, etc.)
- Theme metadata (name, id, isDark)
- Any variant patterns (dark theme mock, light theme mock)

### Task 2: Read the Theme type definition

```
rtk grep "interface Theme\|type Theme " src/ --include="*.ts" --include="*.tsx" | grep -v "__tests__"
```

Read the canonical Theme type to ensure the mock covers all 13 required colors.

### Task 3: Create shared mockTheme.ts

Create `src/__tests__/helpers/mockTheme.ts`:

```typescript
import type { Theme } from '../../renderer/constants/themes';

export const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	isDark: true,
	colors: {
		background: '#1a1a2e',
		backgroundSecondary: '#16213e',
		textMain: '#e0e0e0',
		textSecondary: '#a0a0a0',
		accent: '#4fc3f7',
		accentHover: '#29b6f6',
		border: '#333333',
		success: '#4caf50',
		warning: '#ff9800',
		error: '#f44336',
		info: '#2196f3',
		buttonBg: '#333333',
		buttonText: '#ffffff',
	},
};

export function createMockTheme(overrides: Partial<Theme> = {}): Theme {
	return {
		...mockTheme,
		...overrides,
		colors: {
			...mockTheme.colors,
			...(overrides.colors || {}),
		},
	};
}
```

**IMPORTANT:** Match the exact field names from the canonical Theme type. The colors listed above are examples - use the real field names.

### Task 4: Export from helpers/index.ts

Add to `src/__tests__/helpers/index.ts`:

```typescript
export { mockTheme, createMockTheme } from './mockTheme';
```

### Task 5: Migrate createMockTheme function definitions (35 files)

For each file with a `createMockTheme` function:

1. Remove the local function
2. Add import: `import { createMockTheme } from '../helpers/mockTheme';`
3. Verify any custom overrides still work

### Task 6: Migrate inline mockTheme objects (119 instances)

For each file with an inline `mockTheme` object:

1. Remove the local `const mockTheme = { ... }` declaration
2. Add import: `import { mockTheme } from '../helpers/mockTheme';`
3. If the test modifies `mockTheme` properties, switch to `createMockTheme({ ... })`

**Batch by directory:**

- `src/__tests__/renderer/components/` (largest group)
- `src/__tests__/renderer/hooks/`
- `src/__tests__/renderer/stores/`

### Task 7: Run tests after each batch

After migrating each directory, run:

```
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

Fix any failures before proceeding to the next batch.

### Task 8: Verify cleanup complete

```
rtk grep "createMockTheme\|const mockTheme.*=.*{" src/__tests__/ --include="*.ts" --include="*.tsx" | grep -v "helpers/mockTheme" | grep -v "import"
```

Should return 0 results (or only `let mockTheme` reassignments that use the imported factory).

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
