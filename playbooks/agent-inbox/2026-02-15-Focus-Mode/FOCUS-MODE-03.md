# Phase 03: Focus Mode Entry Button + Keyboard Shortcuts

> **Feature:** Focus Mode (Inbox Triage View)
> **Codebase:** `~/Documents/Vibework/Maestro` | **Branch:** `feature/focus-mode`
> **Depends on:** Phase 02 (FocusModeView shell wired in)

This phase adds the "Focus" entry button to the InboxListView header and wires keyboard shortcuts for both entering and navigating within focus mode.

---

## Focus Button in InboxListView Header

- [ ] **Add a "Focus" button to the InboxListView header row 1, next to the close button.** Open `src/renderer/components/AgentInbox/InboxListView.tsx`. In the header row 1 (the row with "Unified Inbox" title + badge + close button), add a button between the badge and the close button:

  **Button spec:**
  ```tsx
  <button
  	onClick={() => {
  		if (items.length > 0 && items[selectedIndex]) {
  			onEnterFocus(items[selectedIndex]);
  		}
  	}}
  	disabled={items.length === 0}
  	className="text-xs px-2.5 py-1 rounded transition-colors"
  	style={{
  		backgroundColor: items.length > 0 ? `${theme.colors.accent}15` : 'transparent',
  		color: items.length > 0 ? theme.colors.accent : theme.colors.textDim,
  		cursor: items.length > 0 ? 'pointer' : 'default',
  		opacity: items.length === 0 ? 0.5 : 1,
  	}}
  	onMouseEnter={(e) => {
  		if (items.length > 0) {
  			e.currentTarget.style.backgroundColor = `${theme.colors.accent}25`;
  		}
  	}}
  	onMouseLeave={(e) => {
  		if (items.length > 0) {
  			e.currentTarget.style.backgroundColor = `${theme.colors.accent}15`;
  		}
  	}}
  	title="Enter Focus Mode (F)"
  >
  	Focus ▶
  </button>
  ```

  Place it in the header row 1, right side, in a flex container with `gap-2` alongside the close button. The order should be: `[Focus ▶] [X]`.

  Run `npx tsc --noEmit` to verify.

---

## Keyboard Shortcuts

- [ ] **Wire keyboard shortcuts for Focus Mode in the AgentInbox shell.** Open `src/renderer/components/AgentInbox/index.tsx`. Update the `onKeyDown` handler on the dialog div:

  **When `viewMode === 'list'`:**
  - `F` key (no modifiers): Enter focus mode with the selected item. Delegate to InboxListView's existing keyboard handler. Actually, since the shell intercepts `onKeyDown` first, handle it here:
    ```ts
    if (viewMode === 'list' && (e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey) {
    	e.preventDefault();
    	if (items.length > 0) {
    		// Need to know the selected index from InboxListView
    		// Option: lift selectedIndex to shell, or use a ref callback
    	}
    }
    ```

    **Problem:** The shell doesn't know which item is selected in InboxListView. Two approaches:
    - **Approach A:** Lift `selectedIndex` to the shell (cleaner, aligns with the lifted filter/sort state from Phase 02)
    - **Approach B:** Have InboxListView expose a ref to get the selected item

    **Choose Approach A:** Lift `selectedIndex` and `setSelectedIndex` to the shell. Add them to InboxListView's props. This means InboxListView no longer has its own `useState` for `selectedIndex` — it receives it from the parent.

    Update InboxListView props to include:
    ```ts
    selectedIndex: number;
    setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
    ```

    In the shell's `onKeyDown`:
    ```ts
    if (viewMode === 'list' && (e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey) {
    	e.preventDefault();
    	if (items.length > 0 && items[selectedIndex]) {
    		handleEnterFocus(items[selectedIndex]);
    	}
    }
    ```

  **When `viewMode === 'focus'`:**
  - `Escape`: Exit focus mode, return to list view (already handled in Phase 01)
  - `ArrowLeft`: Navigate to previous item
    ```ts
    if (viewMode === 'focus' && e.key === 'ArrowLeft') {
    	e.preventDefault();
    	setFocusIndex(prev => (prev - 1 + items.length) % items.length);
    }
    ```
  - `ArrowRight`: Navigate to next item
    ```ts
    if (viewMode === 'focus' && e.key === 'ArrowRight') {
    	e.preventDefault();
    	setFocusIndex(prev => (prev + 1) % items.length);
    }
    ```
  - `Backspace` or `B`: Exit focus mode (secondary shortcut, same as Escape but more ergonomic)
    ```ts
    if (viewMode === 'focus' && (e.key === 'Backspace' || e.key === 'b' || e.key === 'B') && !e.metaKey && !e.ctrlKey) {
    	e.preventDefault();
    	handleExitFocus();
    }
    ```

  **Important:** When `viewMode === 'focus'`, do NOT let ArrowUp/ArrowDown reach InboxListView. The shell should consume all keyboard events when in focus mode. Add an early return:
  ```ts
  if (viewMode === 'focus') {
  	// Handle focus-mode keys, then return
  	switch (e.key) {
  		case 'Escape': handleExitFocus(); e.stopPropagation(); e.preventDefault(); return;
  		case 'ArrowLeft': ... return;
  		case 'ArrowRight': ... return;
  		case 'Backspace':
  		case 'b':
  		case 'B': ... return;
  	}
  	return; // Consume all other keys in focus mode
  }
  // List mode keys below...
  ```

  Run `npx tsc --noEmit` to verify.

---

## Update Footer Hints

- [ ] **Update keyboard hints in both views.**

  **InboxListView footer** (already has `↑↓ Navigate`, `Enter Open`, `Esc Close`):
  - Add `F Focus` hint: `<span>F Focus</span>` (if not already added in Phase 01)

  **FocusModeView footer** (currently has Prev/Next buttons):
  - Add keyboard hints between the nav buttons: `<span className="text-xs" style={{ color: theme.colors.textDim }}>←→ Navigate · Esc Back</span>`

  Run `npx tsc --noEmit` to verify.

---

## Verification Gate

- [ ] **Run full verification.** Execute:
  ```bash
  cd ~/Documents/Vibework/Maestro && npx tsc --noEmit && npx vitest run && npx eslint src/renderer/components/AgentInbox/ --ext .ts,.tsx
  ```
  Lifting `selectedIndex` may require updating existing tests that checked internal state. Fix as needed. All tests must pass.

---

## Commit

- [ ] **Commit this phase.**
  ```bash
  git add src/renderer/components/AgentInbox/
  git commit -m "FOCUS-MODE: Phase 03 — Focus button, keyboard shortcuts, lifted selectedIndex"
  ```
