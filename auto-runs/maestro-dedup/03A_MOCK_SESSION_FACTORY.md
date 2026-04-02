# Phase 03-A: Consolidate createMockSession Factories

## Objective

Replace 66 separate `createMockSession` factory definitions across 66 test files with a single shared factory in `src/__tests__/helpers/mockSession.ts`.

**Evidence:** `docs/agent-guides/scans/SCAN-MOCKS.md`, "createMockSession definitions"
**Risk:** Zero production risk - test-only changes
**Estimated savings:** ~660 lines

---

## Pre-flight Checks

- [ ] Phase 02 (type bug fix) is complete
- [ ] `rtk vitest run` passes (baseline)

---

## Tasks

### Task 1: Create the helpers directory

```
mkdir -p src/__tests__/helpers/
```

### Task 2: Survey existing mock session factories

Find all definitions:

```
rtk grep "createMockSession" src/__tests__/ --include="*.ts" --include="*.tsx" -l
rtk grep "function createMockSession\|const createMockSession" src/__tests__/ --include="*.ts" --include="*.tsx"
```

Read 5-6 representative definitions to understand the common pattern and any variations.

### Task 3: Read the Session interface

Read `src/shared/types.ts` (or wherever the `Session` interface lives) to understand all required fields.

Also check `src/renderer/types/index.ts` for any renderer-specific session types.

### Task 4: Create shared mockSession.ts

Create `src/__tests__/helpers/mockSession.ts` with a flexible factory:

```typescript
import type { Session } from '../../shared/types';

export function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'test-session-1',
		name: 'Test Session',
		agentType: 'claude-code',
		status: 'ready',
		aiTabs: [
			{
				id: 'tab-1',
				name: 'Tab 1',
				messages: [],
				agentSessionId: null,
				isLoading: false,
			},
		],
		activeTabId: 'tab-1',
		activeFileTabId: null,
		filePreviewTabs: [],
		unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
		// ... fill in ALL required fields with sensible defaults
		...overrides,
	};
}
```

**IMPORTANT:** Study the existing factories to determine the exact fields needed. The factory should satisfy TypeScript's type checker with zero overrides.

### Task 5: Create index.ts barrel export

Create `src/__tests__/helpers/index.ts`:

```typescript
export { createMockSession } from './mockSession';
```

### Task 6: Migrate test files in batches of 10

For each batch:

1. Open the test file
2. Find the local `createMockSession` definition
3. Remove it
4. Add import: `import { createMockSession } from '../helpers/mockSession';` (adjust path as needed)
5. Verify any custom overrides still work with the new factory signature
6. Run `rtk vitest run path/to/file.test.ts` to verify

Process all 66 files. Group by directory to minimize path confusion:

- `src/__tests__/renderer/components/*.test.tsx` (largest group)
- `src/__tests__/renderer/hooks/*.test.ts`
- `src/__tests__/renderer/stores/*.test.ts`
- `src/__tests__/main/*.test.ts`
- `src/__tests__/shared/*.test.ts`

### Task 7: Handle edge cases

Some factories may have extra features (e.g., auto-incrementing IDs, different agent types). If a test file's factory has unique behavior:

1. Check if it can be handled via overrides
2. If not, create a variant (e.g., `createMockBatchSession`, `createMockRemoteSession`)

### Task 8: Verify all tests pass

```
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

All tests must pass. If any fail, check that the shared factory's defaults match what the individual test expected.

### Task 9: Clean up - verify no orphaned local factories remain

```
rtk grep "function createMockSession\|const createMockSession" src/__tests__/ --include="*.ts" --include="*.tsx" | grep -v "helpers/mockSession"
```

Should return 0 results.

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
