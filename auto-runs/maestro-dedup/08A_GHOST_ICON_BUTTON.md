# Phase 08-A: Extract GhostIconButton Component

## Objective

Replace 100+ instances of the ghost icon button pattern (`p-1 rounded hover:bg-white/10 transition-colors`) across 40+ files with a shared `<GhostIconButton>` component.

**Evidence:** `docs/agent-guides/scans/SCAN-COMPONENTS.md`, "Ghost Icon Button Pattern Locations"
**Risk:** Low - pure UI extraction, no logic changes
**Estimated savings:** ~300 lines

---

## Pre-flight Checks

- [ ] Phase 07 (session state) is complete
- [ ] `rtk npm run lint` passes

---

## Tasks

### Task 1: Survey the pattern variations

```
rtk grep "p-1 rounded hover:bg-white/10" src/renderer/ --glob="*.tsx"
rtk grep "p-1.5 rounded hover:bg-white/10" src/renderer/ --glob="*.tsx"
rtk grep "opacity-0 group-hover:opacity-100" src/renderer/ --glob="*.tsx" | rtk grep "p-1"
```

Categorize the variants:

- **Standard:** `p-1 rounded hover:bg-white/10 transition-colors`
- **Larger:** `p-1.5 rounded hover:bg-white/10 transition-colors`
- **Fade-in:** Above + `opacity-0 group-hover:opacity-100`
- **With tooltip:** Above + wrapped in tooltip

### Task 2: Design the component API

Create `src/renderer/components/ui/GhostIconButton.tsx`:

```typescript
import React from 'react';

interface GhostIconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	/** Icon component from lucide-react */
	icon?: React.ReactNode;
	/** Size variant */
	size?: 'sm' | 'md';
	/** Show only on parent hover (requires parent to have 'group' class) */
	showOnHover?: boolean;
	/** Optional tooltip text */
	tooltip?: string;
	/** Additional className */
	className?: string;
	children?: React.ReactNode;
}

export function GhostIconButton({
	icon,
	size = 'sm',
	showOnHover = false,
	tooltip,
	className = '',
	children,
	...buttonProps
}: GhostIconButtonProps) {
	const sizeClass = size === 'sm' ? 'p-1' : 'p-1.5';
	const hoverClass = showOnHover ? 'opacity-0 group-hover:opacity-100' : '';

	const button = (
		<button
			type="button"
			className={`${sizeClass} rounded hover:bg-white/10 transition-colors ${hoverClass} ${className}`}
			{...buttonProps}
		>
			{icon || children}
		</button>
	);

	if (tooltip) {
		// Wrap with your tooltip component
		return <Tooltip content={tooltip}>{button}</Tooltip>;
	}

	return button;
}
```

### Task 3: Write tests

Create `src/__tests__/renderer/components/ui/GhostIconButton.test.tsx`:

- Renders with default props
- Applies size variants correctly
- Applies showOnHover class
- Passes through button props (onClick, disabled, aria-label)
- Renders tooltip when provided

### Task 4: Migrate high-frequency files first

Start with files that have the most instances:

1. `TabBar.tsx`
2. `SessionList.tsx`
3. `RightPanel.tsx`
4. `SymphonyModal.tsx`

For each:

1. Find all ghost icon button patterns
2. Replace with `<GhostIconButton>`
3. Run `rtk vitest run path/to/test`

### Task 5: Migrate remaining files

Work through the remaining 36+ files. For each:

1. Search for the pattern
2. Replace with the component
3. Ensure the `icon` prop matches (most pass a lucide-react icon as a child)

### Task 6: Handle edge cases

Some buttons may have additional classes or behaviors:

- **Active state:** Add an `active` prop if needed
- **Custom hover color:** Accept `hoverColor` prop
- **Disabled styling:** Ensure disabled state looks correct

### Task 7: Verify

```
rtk npm run lint
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

### Task 8: Count remaining raw patterns

```
rtk grep "p-1 rounded hover:bg-white/10" src/renderer/ --glob="*.tsx" | rtk grep -v "GhostIconButton" | wc -l
```

Target: fewer than 5 remaining (edge cases only).

---

## Success Criteria

- `GhostIconButton` component in `src/renderer/components/ui/`
- 100+ inline patterns replaced
- Unit tests for the component
- Lint and tests pass
