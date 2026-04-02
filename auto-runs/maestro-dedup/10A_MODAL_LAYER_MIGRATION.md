# Phase 10-A: Migrate Modal Boilerplate to useModalLayer Hook

## Objective

Migrate 50+ files from manual `registerLayer`/`unregisterLayer` boilerplate to the existing `useModalLayer` hook (currently used by only 1-2 files).

**Evidence:** `docs/agent-guides/scans/SCAN-BLOCKS.md`, "registerLayer/unregisterLayer by File"
**Risk:** Low-medium - modal behavior must be preserved (Escape handling, layer priority)
**Estimated savings:** ~200 lines (4 lines per file x 50 files)

---

## Pre-flight Checks

- [ ] Phase 09 (shared hooks) is complete
- [ ] `rtk npm run lint` passes
- [ ] `rtk vitest run` passes

---

## Tasks

### Task 1: Read the existing useModalLayer hook

Read `src/renderer/hooks/ui/useModalLayer.ts` to understand its API:
- What parameters does it accept?
- Does it handle the `isOpen` conditional logic?
- Does it accept priority from `modalPriorities.ts`?
- Does it handle the `onCloseRef` pattern?

### Task 2: Verify useModalLayer covers all patterns

The manual pattern looks like:
```typescript
const { registerLayer, unregisterLayer } = useLayerStack();
const onCloseRef = useRef(onClose);
onCloseRef.current = onClose;

useEffect(() => {
	if (isOpen) {
		const id = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.SOME_MODAL,
			onEscape: () => onCloseRef.current(),
		});
		return () => unregisterLayer(id);
	}
}, [isOpen, registerLayer, unregisterLayer]);
```

Ensure `useModalLayer` handles all of this. If not, extend it.

### Task 3: Find all files with manual boilerplate

```
rtk grep -rn "registerLayer\|unregisterLayer" src/renderer/ --include="*.ts" --include="*.tsx" | grep -v "__tests__" | grep -v "useModalLayer" | grep -v "LayerStackContext" -l
```

### Task 4: Migrate in batches by component directory

For each file:

```typescript
// BEFORE (manual)
const { registerLayer, unregisterLayer } = useLayerStack();
const onCloseRef = useRef(onClose);
onCloseRef.current = onClose;
useEffect(() => {
	if (isOpen) {
		const id = registerLayer({ type: 'modal', priority: X, onEscape: () => onCloseRef.current() });
		return () => unregisterLayer(id);
	}
}, [isOpen, registerLayer, unregisterLayer]);

// AFTER (hook)
useModalLayer({
	isOpen,
	priority: X,
	onEscape: onClose,
});
```

Process files in batches:
1. Simple modals (direct `isOpen` + `onClose` props) - ~30 files
2. Complex modals (conditional open, multiple close paths) - ~15 files
3. Non-modal layers (drawers, panels with escape handling) - ~5 files

### Task 5: Handle DocumentGraphView.tsx (17 registerLayer calls)

This is the worst offender. It likely has multiple nested modal layers. Migrate carefully - each layer needs its own `useModalLayer` call with the correct priority.

### Task 6: Verify Escape key behavior

After migrating each batch, manually verify:
- Escape closes the topmost modal
- Stacked modals close in correct order
- Escape does NOT close modals that are behind other modals

### Task 7: Verify

```
rtk npm run lint
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

### Task 8: Count remaining manual registrations

```
rtk grep -rn "registerLayer" src/renderer/ --include="*.ts" --include="*.tsx" | grep -v "__tests__" | grep -v "useModalLayer" | grep -v "LayerStackContext" | wc -l
```

Target: 0.

---

## Success Criteria

- 50+ files migrated to `useModalLayer` hook
- All modal Escape behavior preserved
- No manual `registerLayer`/`unregisterLayer` calls remain in components
- Lint and tests pass
