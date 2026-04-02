# Phase 09-A: Extract useFocusAfterRender and useEventListener Hooks

## Objective

Create two shared hooks to replace repetitive patterns:
1. `useFocusAfterRender` - replaces 45 `setTimeout(() => ref.current?.focus(), N)` patterns across 28 files
2. `useEventListener` - replaces manual `addEventListener`/`removeEventListener` pairs in 63+ files

**Evidence:** `docs/agent-guides/scans/SCAN-HOOKS.md`
**Risk:** Low - extracting patterns into hooks with identical behavior
**Estimated savings:** ~340 lines

---

## Pre-flight Checks

- [ ] Phase 08 (UI components) is complete
- [ ] `rtk npm run lint` passes
- [ ] `rtk vitest run` passes

---

## Part 1: useFocusAfterRender

### Task 1: Survey the setTimeout focus pattern

```
rtk grep -rn "setTimeout.*focus" src/renderer/ --include="*.ts" --include="*.tsx" | grep -v "__tests__"
```

Note the delay values used: 0ms, 50ms, 100ms are common. Determine the most common default.

### Task 2: Create useFocusAfterRender hook

Create `src/renderer/hooks/utils/useFocusAfterRender.ts`:

```typescript
import { useEffect, type RefObject } from 'react';

/**
 * Focus an element after render with an optional delay.
 * Replaces the common setTimeout(() => ref.current?.focus(), delay) pattern.
 */
export function useFocusAfterRender(
	ref: RefObject<HTMLElement | null>,
	shouldFocus: boolean = true,
	delay: number = 0,
): void {
	useEffect(() => {
		if (!shouldFocus) return;

		const timer = setTimeout(() => {
			ref.current?.focus();
		}, delay);

		return () => clearTimeout(timer);
	}, [ref, shouldFocus, delay]);
}
```

### Task 3: Write tests for useFocusAfterRender

Test:
- Focuses element after render
- Respects delay parameter
- Cleans up timeout on unmount
- Does nothing when shouldFocus is false

### Task 4: Migrate setTimeout focus patterns (45 instances)

For each of the 28 files:
1. Find the `setTimeout(() => ref.current?.focus(), N)` pattern
2. Determine if it's in a `useEffect` (replace entirely) or in an event handler (may need different approach)
3. If in useEffect, replace with `useFocusAfterRender(ref, condition, delay)`
4. If in an event handler, keep inline (the hook is for render-time focus)

---

## Part 2: useEventListener

### Task 5: Survey addEventListener/removeEventListener pairs

```
rtk grep -rn "addEventListener" src/renderer/ --include="*.ts" --include="*.tsx" | grep -v "__tests__" | grep -v "node_modules" -l
```

Top offenders: `activityBus.ts` (10), `MarketplaceModal.tsx` (10), `useMainKeyboardHandler.ts` (8), `SymphonyModal.tsx` (8), `App.tsx` (8)

### Task 6: Create useEventListener hook

Create `src/renderer/hooks/utils/useEventListener.ts`:

```typescript
import { useEffect, useRef } from 'react';

/**
 * Attach an event listener with automatic cleanup.
 * Replaces manual addEventListener/removeEventListener pairs.
 */
export function useEventListener<K extends keyof WindowEventMap>(
	eventName: K,
	handler: (event: WindowEventMap[K]) => void,
	element?: Window | HTMLElement | null,
	options?: boolean | AddEventListenerOptions,
): void {
	const savedHandler = useRef(handler);

	useEffect(() => {
		savedHandler.current = handler;
	}, [handler]);

	useEffect(() => {
		const targetElement = element ?? window;
		if (!targetElement?.addEventListener) return;

		const eventListener = (event: Event) => {
			savedHandler.current(event as WindowEventMap[K]);
		};

		targetElement.addEventListener(eventName, eventListener, options);
		return () => targetElement.removeEventListener(eventName, eventListener, options);
	}, [eventName, element, options]);
}
```

### Task 7: Write tests for useEventListener

Test:
- Attaches listener on mount
- Removes listener on unmount
- Updates handler without re-attaching listener
- Works with custom elements
- Handles null element gracefully

### Task 8: Migrate event listener pairs (63+ files)

For each file with manual add/remove pairs:

```typescript
// BEFORE
useEffect(() => {
	const handler = (e) => { ... };
	window.addEventListener('keydown', handler);
	return () => window.removeEventListener('keydown', handler);
}, [deps]);

// AFTER
useEventListener('keydown', (e) => { ... });
```

Start with top offenders:
1. `activityBus.ts` (10 pairs)
2. `MarketplaceModal.tsx` (10 pairs)
3. `useMainKeyboardHandler.ts` (8 pairs)
4. `SymphonyModal.tsx` (8 pairs)
5. `App.tsx` (8 pairs)

### Task 9: Export from hooks barrel

Add exports to `src/renderer/hooks/utils/index.ts` (or create if doesn't exist):
```typescript
export { useFocusAfterRender } from './useFocusAfterRender';
export { useEventListener } from './useEventListener';
```

### Task 10: Verify

```
rtk npm run lint
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

---

## Success Criteria

- `useFocusAfterRender` hook created with tests
- `useEventListener` hook created with tests
- 45 setTimeout-focus patterns migrated
- 63+ addEventListener/removeEventListener pairs migrated
- Lint and tests pass
