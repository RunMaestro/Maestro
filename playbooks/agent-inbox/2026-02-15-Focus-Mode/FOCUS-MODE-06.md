# Phase 06: Prev/Next Navigation Polish + Counter

> **Feature:** Focus Mode (Inbox Triage View)
> **Codebase:** `~/Documents/Vibework/Maestro` | **Branch:** `feature/focus-mode`
> **Depends on:** Phase 05 (reply input wired)

This phase polishes the prev/next navigation: visual buttons, wrapping behavior, keyboard hints, and smooth transitions when changing items.

---

## Polish Navigation Buttons and Counter

- [ ] **Refine the Prev/Next buttons and counter in `src/renderer/components/AgentInbox/FocusModeView.tsx` footer.** The footer was created in Phase 02 as a skeleton. Now polish it:

  1. **Footer layout** (44px, border-top):
     ```tsx
     <div
     	className="flex items-center justify-between px-4 border-t"
     	style={{
     		height: 44,
     		borderColor: theme.colors.border,
     	}}
     >
     	{/* Prev button */}
     	<button
     		onClick={() => onNavigateItem((currentIndex - 1 + items.length) % items.length)}
     		disabled={items.length <= 1}
     		className="flex items-center gap-1 text-xs px-3 py-1.5 rounded transition-colors"
     		style={{
     			border: `1px solid ${theme.colors.border}`,
     			color: items.length > 1 ? theme.colors.textMain : theme.colors.textDim,
     			backgroundColor: 'transparent',
     			cursor: items.length > 1 ? 'pointer' : 'default',
     			opacity: items.length <= 1 ? 0.4 : 1,
     		}}
     		onMouseEnter={(e) => {
     			if (items.length > 1) {
     				e.currentTarget.style.backgroundColor = `${theme.colors.accent}10`;
     			}
     		}}
     		onMouseLeave={(e) => {
     			e.currentTarget.style.backgroundColor = 'transparent';
     		}}
     		title="Previous item (←)"
     	>
     		<ChevronLeft className="w-3 h-3" />
     		Prev
     	</button>

     	{/* Center: counter + keyboard hints */}
     	<div className="flex flex-col items-center gap-0.5">
     		<span
     			className="text-sm font-medium"
     			style={{ color: theme.colors.textMain }}
     		>
     			{currentIndex + 1} / {items.length}
     		</span>
     		<span
     			className="text-xs"
     			style={{ color: theme.colors.textDim, opacity: 0.6 }}
     		>
     			←→ Navigate · Esc Back
     		</span>
     	</div>

     	{/* Next button */}
     	<button
     		onClick={() => onNavigateItem((currentIndex + 1) % items.length)}
     		disabled={items.length <= 1}
     		className="flex items-center gap-1 text-xs px-3 py-1.5 rounded transition-colors"
     		style={{
     			border: `1px solid ${theme.colors.border}`,
     			color: items.length > 1 ? theme.colors.textMain : theme.colors.textDim,
     			backgroundColor: 'transparent',
     			cursor: items.length > 1 ? 'pointer' : 'default',
     			opacity: items.length <= 1 ? 0.4 : 1,
     		}}
     		onMouseEnter={(e) => {
     			if (items.length > 1) {
     				e.currentTarget.style.backgroundColor = `${theme.colors.accent}10`;
     			}
     		}}
     		onMouseLeave={(e) => {
     			e.currentTarget.style.backgroundColor = 'transparent';
     		}}
     		title="Next item (→)"
     	>
     		Next
     		<ChevronRight className="w-3 h-3" />
     	</button>
     </div>
     ```

  2. **Import icons:** Add `ChevronLeft, ChevronRight` to the lucide-react imports (alongside ArrowLeft, X, ArrowUp already used).

  3. **Remove duplicate counter** from the header if it exists. The header should show: `[← Inbox] [Agent Name · Tab] [X]`. The counter lives only in the footer now — cleaner hierarchy.

  Run `npx tsc --noEmit` to verify.

---

## Smooth Item Transitions

- [ ] **Add a subtle transition when navigating between items.** When `currentIndex` changes, add a brief opacity fade to the conversation body. This gives visual feedback that the content changed. Implementation:

  1. Add a state for transition:
     ```ts
     const [isTransitioning, setIsTransitioning] = useState(false);
     ```

  2. Watch for item changes:
     ```ts
     const prevItemRef = useRef<string>(`${item.sessionId}-${item.tabId}`);

     useEffect(() => {
     	const currentKey = `${item.sessionId}-${item.tabId}`;
     	if (prevItemRef.current !== currentKey) {
     		setIsTransitioning(true);
     		const timer = setTimeout(() => setIsTransitioning(false), 150);
     		prevItemRef.current = currentKey;
     		return () => clearTimeout(timer);
     	}
     }, [item.sessionId, item.tabId]);
     ```

  3. Apply to the conversation body wrapper:
     ```tsx
     <div
     	ref={scrollRef}
     	className="flex-1 overflow-y-auto px-4 py-3"
     	style={{
     		minHeight: 0,
     		opacity: isTransitioning ? 0.3 : 1,
     		transition: 'opacity 150ms ease',
     	}}
     >
     ```

  This is a lightweight cosmetic touch — no heavy animation library needed.

  Run `npx tsc --noEmit` to verify.

---

## Edge Cases

- [ ] **Handle edge cases for navigation.** In the AgentInbox shell (`index.tsx`), ensure:

  1. **Items list shrinks while in focus mode** (agent gets dismissed, session closes): If `focusIndex >= items.length`, clamp it:
     ```ts
     useEffect(() => {
     	if (viewMode === 'focus' && items.length > 0 && focusIndex >= items.length) {
     		setFocusIndex(items.length - 1);
     	}
     	if (viewMode === 'focus' && items.length === 0) {
     		handleExitFocus(); // No items left, return to list
     	}
     }, [items.length, focusIndex, viewMode]);
     ```

  2. **Guard in FocusModeView render:** Before rendering FocusModeView, check `items[focusIndex]` exists:
     ```tsx
     {viewMode === 'focus' && items[focusIndex] ? (
     	<FocusModeView
     		item={items[focusIndex]}
     		...
     	/>
     ) : viewMode === 'focus' ? (
     	// Fallback if item disappeared — shouldn't happen but safe
     	<div style={{ color: theme.colors.textDim, padding: 40, textAlign: 'center' }}>
     		<span className="text-sm">No items to focus on</span>
     	</div>
     ) : (
     	<InboxListView ... />
     )}
     ```

  Run `npx tsc --noEmit` to verify.

---

## Verification Gate

- [ ] **Run full verification.** Execute:
  ```bash
  cd ~/Documents/Vibework/Maestro && npx tsc --noEmit && npx vitest run && npx eslint src/renderer/components/AgentInbox/ --ext .ts,.tsx
  ```
  All tests must pass.

---

## Commit

- [ ] **Commit this phase.**
  ```bash
  git add src/renderer/components/AgentInbox/
  git commit -m "FOCUS-MODE: Phase 06 — polished prev/next navigation, transitions, edge cases"
  ```
