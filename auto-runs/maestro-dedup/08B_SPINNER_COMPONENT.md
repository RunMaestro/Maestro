# Phase 08-B: Extract Spinner Component

## Objective

Replace 95+ `<Loader2 className="... animate-spin" />` instances across 43 files with a shared `<Spinner>` component.

**Evidence:** `docs/agent-guides/scans/SCAN-COMPONENTS.md`, "Spinner Instances"
**Risk:** Low - pure UI extraction
**Estimated savings:** ~200 lines

---

## Pre-flight Checks

- [ ] Phase 08-A (GhostIconButton) is complete
- [ ] `rtk npm run lint` passes

---

## Tasks

### Task 1: Survey spinner variations

```
rtk grep "Loader2" src/renderer/ --glob="*.tsx" | rtk grep "animate-spin"
```

Categorize by size:

- **Small:** `w-3 h-3 animate-spin` or `w-4 h-4 animate-spin`
- **Medium:** `w-5 h-5 animate-spin` or `w-6 h-6 animate-spin`
- **Large:** `w-8 h-8 animate-spin` or larger

### Task 2: Create the Spinner component

Create `src/renderer/components/ui/Spinner.tsx`:

```typescript
import { Loader2 } from 'lucide-react';

interface SpinnerProps {
	/** Size variant */
	size?: 'xs' | 'sm' | 'md' | 'lg';
	/** Additional className */
	className?: string;
}

const sizeClasses = {
	xs: 'w-3 h-3',
	sm: 'w-4 h-4',
	md: 'w-5 h-5',
	lg: 'w-8 h-8',
} as const;

export function Spinner({ size = 'sm', className = '' }: SpinnerProps) {
	return (
		<Loader2
			className={`${sizeClasses[size]} animate-spin ${className}`}
		/>
	);
}
```

### Task 3: Write tests

Create `src/__tests__/renderer/components/ui/Spinner.test.tsx`:

- Renders with each size variant
- Applies additional className
- Renders Loader2 with animate-spin

### Task 4: Migrate top offender files

1. **`SymphonyModal.tsx`** (9 instances)
2. **`AgentSessionsBrowser.tsx`** (7 instances)
3. **`DocumentGraphView.tsx`** (5 instances)

For each: replace `<Loader2 className="w-4 h-4 animate-spin" />` with `<Spinner size="sm" />`

### Task 5: Migrate remaining 40 files

Work through all 43 files. Map each Loader2 size to the appropriate `size` prop:

- `w-3 h-3` -> `size="xs"`
- `w-4 h-4` -> `size="sm"`
- `w-5 h-5` -> `size="md"`
- `w-6 h-6` / `w-8 h-8` -> `size="lg"`

If a Loader2 has additional classes beyond size (e.g., color), pass them via `className`.

### Task 6: Remove orphaned Loader2 imports

After migration, many files will have unused `Loader2` imports. Remove them:

```
rtk grep "import.*Loader2" src/renderer/ --glob="*.tsx"
```

Check each file - if Loader2 is no longer used, remove the import.

### Task 7: Verify

```
rtk npm run lint
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

### Task 8: Count remaining raw Loader2 usages

```
rtk grep "Loader2.*animate-spin" src/renderer/ --glob="*.tsx" | rtk grep -v "Spinner" | wc -l
```

Target: 0 remaining.

---

## Success Criteria

- `Spinner` component in `src/renderer/components/ui/`
- 95+ inline Loader2 usages replaced
- Orphaned Loader2 imports removed
- Lint and tests pass
