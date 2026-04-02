# Phase 08-C: Extend and Adopt EmptyStateView

## Objective

Extend the existing `EmptyStateView` component (currently used only in `App.tsx:3340`) to accept configurable props, then adopt it across 26+ empty state locations.

**Evidence:** `docs/agent-guides/scans/SCAN-COMPONENTS.md`, "Empty State Pattern Locations"
**Risk:** Low - UI consolidation
**Estimated savings:** ~150 lines

---

## Pre-flight Checks

- [ ] Phase 08-B (Spinner) is complete
- [ ] `rtk npm run lint` passes

---

## Tasks

### Task 1: Read the existing EmptyStateView

Read `src/renderer/components/EmptyStateView.tsx` to understand its current API and what it renders.

Understand its current API and what it renders.

### Task 2: Survey existing empty state patterns

```
rtk grep "No .* found|No .* available|No .* yet|Nothing to show|Empty|Get started" src/renderer/components/ --glob="*.tsx"
```

Common patterns include:

- Icon + message
- Icon + message + action button
- Just a centered message
- Message with subtitle

### Task 3: Extend EmptyStateView with flexible props

Update `src/renderer/components/EmptyStateView.tsx`:

```typescript
interface EmptyStateViewProps {
	/** Icon component (from lucide-react) */
	icon?: React.ReactNode;
	/** Primary message */
	message: string;
	/** Optional secondary description */
	description?: string;
	/** Optional action button */
	action?: {
		label: string;
		onClick: () => void;
	};
	/** Additional className for the container */
	className?: string;
}
```

### Task 4: Write tests

Update tests to cover all prop combinations:

- Message only
- Icon + message
- Icon + message + description
- Full props (icon + message + description + action)

### Task 5: Migrate empty state locations

For each of the 26+ locations:

1. Find the inline empty state markup
2. Replace with `<EmptyStateView icon={...} message="..." />`
3. Verify visual appearance matches

Start with the simplest cases (message-only) and work up to complex ones.

### Task 6: Verify

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

- `EmptyStateView` extended with icon, description, action props
- 26+ inline empty states replaced
- Tests cover all variants
- Lint and tests pass
