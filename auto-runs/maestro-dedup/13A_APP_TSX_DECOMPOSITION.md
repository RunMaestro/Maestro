# Phase 13-A: Decompose App.tsx (4,034 lines)

## Objective

Break down `App.tsx` from 4,034 lines into focused modules. This is the single largest file in the codebase and has been growing (was 3,619, now 4,034 - a REGRESSION).

**Evidence:** `docs/agent-guides/scans/SCAN-OVERSIZED.md`
**Risk:** High - App.tsx is the main coordinator. Changes must be incremental and verified at each step.
**Estimated savings:** Improved maintainability, target <1,000 lines for App.tsx

---

## Pre-flight Checks

- [ ] Phase 12 (constants) is complete
- [ ] `rtk npm run lint` passes
- [ ] `rtk vitest run` passes
- [ ] Create a backup branch: `rtk git checkout -b backup/pre-app-decomposition`

---

## Important Notes

- **Work incrementally.** Extract one concern at a time, verify, then continue.
- **DO NOT change behavior.** This is pure structural refactoring.
- **Keep App.tsx as the coordinator.** It should import and compose extracted modules, not duplicate their logic.
- Previous successful decomposition: TabBar.tsx went from 2,839 to 542 lines by splitting into 4 files.

---

## Tasks

### Task 1: Read App.tsx and categorize sections

Read the entire file and categorize its contents into logical groups:

Expected categories:
- **State declarations** (useState, useRef, etc.)
- **Effect hooks** (useEffect blocks)
- **Event handlers** (keyboard, mouse, window events)
- **IPC listeners** (window.maestro event handlers)
- **Modal render logic** (conditional modal rendering)
- **Layout render** (the main JSX tree)
- **Helper functions** (inline utilities)
- **Constants** (inline constants)

Note the line ranges for each category.

### Task 2: Extract keyboard handler logic

If `useMainKeyboardHandler` already exists, ensure App.tsx delegates to it fully. If App.tsx still has inline keyboard handling, extract it.

Target: `src/renderer/hooks/useAppKeyboardHandler.ts`

### Task 3: Extract IPC listener setup

All `window.maestro.on(...)` listeners in App.tsx should move to a dedicated hook:

Create `src/renderer/hooks/useAppIpcListeners.ts`:
```typescript
export function useAppIpcListeners(deps: AppIpcDeps) {
	useEffect(() => {
		// All IPC listener registrations
		// Return cleanup function
	}, [deps]);
}
```

### Task 4: Extract modal orchestration

App.tsx likely renders 10+ modals conditionally. Extract the modal state and render logic:

Create `src/renderer/components/AppModals.tsx`:
```typescript
interface AppModalsProps {
	// All modal open states and handlers
}

export function AppModals(props: AppModalsProps) {
	return (
		<>
			{props.settingsOpen && <SettingsModal ... />}
			{props.aboutOpen && <AboutModal ... />}
			// ... all modals
		</>
	);
}
```

### Task 5: Extract session management effects

Effects that manage session lifecycle (creation, deletion, status updates) can move to:

Create `src/renderer/hooks/useSessionLifecycle.ts`

### Task 6: Extract auto-run / batch processing coordination

Auto-run state management and batch processing coordination can move to:

Create `src/renderer/hooks/useAutoRunCoordination.ts`

### Task 7: Extract Encore Feature gating logic

All Encore Feature conditional logic can be centralized:

Create `src/renderer/hooks/useEncoreFeatures.ts`

### Task 8: Verify after each extraction

After extracting each module:
1. `rtk npm run lint`
2. `rtk vitest run`
3. Verify App.tsx still composes everything correctly
4. Check no behavior changes

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

### Task 9: Final App.tsx should be a thin coordinator

Target structure for App.tsx after decomposition:

```typescript
export function App() {
	// Minimal state that truly belongs to App
	const settings = useSettings();
	const sessions = useSessionStore();
	
	// Extracted hooks
	useAppKeyboardHandler(...);
	useAppIpcListeners(...);
	useSessionLifecycle(...);
	useAutoRunCoordination(...);
	const encoreFeatures = useEncoreFeatures(settings);
	
	return (
		<AppLayout>
			<LeftBar ... />
			<MainPanel ... />
			<RightBar ... />
			<AppModals ... />
		</AppLayout>
	);
}
```

### Task 10: Measure result

```
wc -l src/renderer/App.tsx
```

Target: <1,000 lines.

---

## Success Criteria

- App.tsx reduced from 4,034 to <1,000 lines
- Extracted modules are focused and self-contained
- No behavior changes
- All extracted hooks have tests
- Lint and tests pass
