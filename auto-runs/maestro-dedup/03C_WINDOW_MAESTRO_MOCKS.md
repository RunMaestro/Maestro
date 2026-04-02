# Phase 03-C: Consolidate window.maestro Mock Setup

## Objective

Replace 117 test file instances that set up their own `window.maestro` mock with the centralized mock in `src/__tests__/setup.ts`.

**Evidence:** `docs/agent-guides/scans/SCAN-MOCKS.md`, "Test files with window.maestro mock setup"
**Risk:** Zero production risk - test-only changes
**Estimated savings:** ~1,755 lines (avg ~15 lines per instance)
**NOTE:** Count regressed from 64 to 117 as of 2026-04-01 re-validation.

---

## Pre-flight Checks

- [ ] Phase 03-B (mockTheme) is complete
- [ ] `rtk vitest run` passes

---

## Tasks

### Task 1: Audit the existing centralized mock

Read `src/__tests__/setup.ts` (around line 205) to understand what namespaces are already mocked:

```
rtk grep -A 50 "window.maestro" src/__tests__/setup.ts
```

Document which `window.maestro.*` namespaces are covered:

- `window.maestro.settings` ?
- `window.maestro.process` ?
- `window.maestro.fs` ?
- `window.maestro.git` ?
- `window.maestro.autorun` ?
- `window.maestro.system` ?
- `window.maestro.stats` ?
- (etc.)

### Task 2: Survey local mock patterns to find missing namespaces

```
rtk grep "window\.maestro\." src/__tests__/ --include="*.ts" --include="*.tsx" | grep -v "setup.ts" | sed 's/.*window\.maestro\.\([a-zA-Z]*\).*/\1/' | sort | uniq -c | sort -rn
```

This reveals which namespaces tests mock locally. Any namespace appearing frequently but missing from `setup.ts` needs to be added.

### Task 3: Extend setup.ts to cover all namespaces

Add any missing namespaces to the centralized mock in `src/__tests__/setup.ts`. Each mock should provide sensible no-op defaults:

```typescript
// Example pattern for each namespace
window.maestro.git = {
	isRepo: vi.fn().mockResolvedValue(false),
	getBranch: vi.fn().mockResolvedValue('main'),
	getStatus: vi.fn().mockResolvedValue({ files: [] }),
	// ... all methods in the namespace
};
```

### Task 4: Create a mock reset helper

Add to `src/__tests__/helpers/mockMaestro.ts`:

```typescript
/**
 * Reset all window.maestro mocks to defaults.
 * Call in beforeEach when test needs clean slate.
 */
export function resetMaestroMocks(): void {
	// Reset all vi.fn() mocks on window.maestro namespaces
	Object.values(window.maestro).forEach((namespace) => {
		if (typeof namespace === 'object' && namespace !== null) {
			Object.values(namespace).forEach((fn) => {
				if (typeof fn === 'function' && 'mockReset' in fn) {
					(fn as ReturnType<typeof vi.fn>).mockReset();
				}
			});
		}
	});
}

/**
 * Override specific maestro mocks for a test.
 * Use instead of redefining the entire namespace.
 */
export function mockMaestroNamespace(
	namespace: keyof typeof window.maestro,
	overrides: Record<string, unknown>
): void {
	Object.assign(window.maestro[namespace], overrides);
}
```

### Task 5: Migrate test files - batch by pattern

Group files by the type of `window.maestro` mock they set up:

**Pattern A: Full `window.maestro` reassignment** (~30 files)

```typescript
// BEFORE
(window as any).maestro = { settings: { get: vi.fn(), ... }, ... };

// AFTER - just override what's needed
import { mockMaestroNamespace } from '../helpers/mockMaestro';
beforeEach(() => {
	mockMaestroNamespace('settings', { get: vi.fn().mockResolvedValue('custom') });
});
```

**Pattern B: Namespace-level override** (~50 files)

```typescript
// BEFORE
window.maestro.settings = { get: vi.fn(), set: vi.fn(), ... };

// AFTER
mockMaestroNamespace('settings', { get: vi.fn().mockResolvedValue('custom') });
```

**Pattern C: Individual method override** (~37 files)

```typescript
// BEFORE
(window.maestro.settings.get as any).mockResolvedValue('value');

// AFTER - this pattern is FINE, keep it as-is if setup.ts provides the base mock
```

Pattern C files may not need changes if setup.ts already provides the base mock.

### Task 6: Process files in directory order

For each directory:

1. `src/__tests__/renderer/components/` - largest group
2. `src/__tests__/renderer/hooks/`
3. `src/__tests__/renderer/stores/`
4. `src/__tests__/main/`
5. `src/__tests__/shared/`

After each directory, run `rtk vitest run` to verify.

### Task 7: Handle special cases

Some tests may need to completely replace a namespace (e.g., testing error paths). These should use:

```typescript
beforeEach(() => {
	window.maestro.settings = {
		...window.maestro.settings,
		get: vi.fn().mockRejectedValue(new Error('fail')),
	};
});
afterEach(() => {
	// Restore from setup.ts defaults
	resetMaestroMocks();
});
```

### Task 8: Final verification

```
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

All tests must pass.

### Task 9: Count remaining local mocks

```
rtk grep "window\.maestro\s*=" src/__tests__/ --include="*.ts" --include="*.tsx" | grep -v "setup.ts" | grep -v "helpers/" | wc -l
```

Target: fewer than 10 remaining (only special-case overrides).

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

- `src/__tests__/setup.ts` covers all `window.maestro.*` namespaces
- `src/__tests__/helpers/mockMaestro.ts` provides reset and override utilities
- 117 local mock setups reduced to <10 special cases
- All tests pass
