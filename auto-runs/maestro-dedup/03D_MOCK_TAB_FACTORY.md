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

```
rtk grep "function createMockTab\|function createMockAITab\|const createMockTab\|const createMockAITab" src/__tests__/ --include="*.ts" --include="*.tsx"
```

### Task 2: Read the AITab and Tab type definitions

```
rtk grep "interface AITab\|type AITab " src/ --include="*.ts" | grep -v "__tests__"
rtk grep "interface FilePreviewTab\|type FilePreviewTab " src/ --include="*.ts" | grep -v "__tests__"
```

### Task 3: Create shared mockTab.ts

Create `src/__tests__/helpers/mockTab.ts`:

```typescript
import type { AITab, FilePreviewTab, UnifiedTabRef } from '../../shared/types';

export function createMockAITab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'mock-tab-1',
		name: 'Mock Tab',
		messages: [],
		agentSessionId: null,
		isLoading: false,
		// ... all required AITab fields
		...overrides,
	};
}

export function createMockFileTab(overrides: Partial<FilePreviewTab> = {}): FilePreviewTab {
	return {
		id: 'mock-file-tab-1',
		filePath: '/test/file.ts',
		// ... all required fields
		...overrides,
	};
}
```

### Task 4: Export from helpers/index.ts

Add to `src/__tests__/helpers/index.ts`:
```typescript
export { createMockAITab, createMockFileTab } from './mockTab';
```

### Task 5: Migrate all 12 definitions

For each file:
1. Remove local factory
2. Import from `../helpers/mockTab`
3. Adjust any unique override patterns
4. Run file-level test: `rtk vitest run path/to/file.test.ts`

### Task 6: Final verification

```
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

### Task 7: Verify cleanup

```
rtk grep "function createMockTab\|function createMockAITab\|const createMockTab\|const createMockAITab" src/__tests__/ | grep -v "helpers/"
```

Should return 0 results.

---

## Success Criteria

- Shared tab factories in `src/__tests__/helpers/mockTab.ts`
- 12 local definitions removed
- All tests pass
