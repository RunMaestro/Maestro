# Phase 02: FocusModeView Component Shell

> **Feature:** Focus Mode (Inbox Triage View)
> **Codebase:** `~/Documents/Vibework/Maestro` | **Branch:** `feature/focus-mode`
> **Depends on:** Phase 01 (InboxListView extraction complete)

This phase creates the `FocusModeView` component with its visual shell: header, subheader, empty body, and footer. No conversation data or reply input yet — just the layout and navigation chrome.

---

## Create FocusModeView Shell

- [ ] **Create `src/renderer/components/AgentInbox/FocusModeView.tsx` with the full visual layout.** The component renders inside the AgentInbox dialog shell (no overlay of its own). Structure:

  **Props interface:**
  ```ts
  import type { Theme, Session } from '../../types';
  import type { InboxItem } from '../../types/agent-inbox';

  interface FocusModeViewProps {
  	theme: Theme;
  	item: InboxItem;
  	items: InboxItem[];              // Full filtered+sorted list for prev/next
  	sessions: Session[];             // For accessing AITab.logs
  	currentIndex: number;            // Position of item in items[]
  	onClose: () => void;             // Close the entire modal
  	onExitFocus: () => void;         // Return to list view
  	onNavigateItem: (index: number) => void;  // Jump to item at index
  	onNavigateToSession?: (sessionId: string, tabId?: string) => void;
  }
  ```

  **Layout (top to bottom):**

  1. **Header bar (48px)**: Flex row, `px-4`, border-bottom.
     - Left: `◀ Inbox` back button (calls `onExitFocus`). Use a `<button>` with left-pointing arrow (`←` character or `ArrowLeft` icon from lucide). Text "Inbox" in `text-sm font-medium`.
     - Center: Agent name from `item.sessionName`, `text-sm font-bold`, truncated to 30 chars. If `item.tabName` exists, show it after a `·` separator in `text-xs text-dim`.
     - Right: Counter badge `"N / M"` where N = `currentIndex + 1`, M = `items.length`. Style: `text-xs px-2 py-0.5 rounded-full` with accent background at 20% opacity (same pattern as the inbox badge). Then a close button (X icon, calls `onClose`).

  2. **Subheader info bar (32px)**: Flex row, `px-4`, `text-xs`, border-bottom, background `bgActivity` with subtle opacity difference.
     - Git branch badge: monospace, `px-1.5 py-0.5 rounded`, background `border` color. Truncate to 25 chars. Show only if `item.gitBranch` exists.
     - Context usage: `"Context: XX%"` text, colored using the same `resolveContextUsageColor` function (import from `./InboxListView`). Show only if `item.contextUsage !== undefined`.
     - Status pill: `STATUS_LABELS[item.state]` text, colored using `STATUS_COLORS[item.state]` resolved to theme colors (same logic as InboxListView).
     - All items right-aligned with `gap-3`.

  3. **Body (flex: 1, overflow-y: auto)**: Placeholder for now:
     ```tsx
     <div
     	className="flex-1 flex items-center justify-center"
     	style={{ color: theme.colors.textDim }}
     >
     	<span className="text-sm">Conversation view — Phase 04</span>
     </div>
     ```

  4. **Footer (44px)**: Flex row, `px-4`, border-top, `justify-between`.
     - Left: `[← Prev]` button, disabled if `items.length <= 1`. Calls `onNavigateItem((currentIndex - 1 + items.length) % items.length)`.
     - Center: `"N / M"` counter text (same as header — keep both for visual balance).
     - Right: `[Next →]` button, disabled if `items.length <= 1`. Calls `onNavigateItem((currentIndex + 1) % items.length)`.
     - Button style: `text-xs px-3 py-1 rounded`, border, hover background at `accent` 10%.

  **Keyboard handling** (via a `useEffect` on the component, NOT `onKeyDown` — because the parent dialog already has onKeyDown, and we need clean separation):
  - Actually, wire keyboard into the parent's `onKeyDown` in Phase 03. For now, just render the visual shell.

  **Styling rules:**
  - Use tabs for indentation
  - NEVER hardcode hex colors — always `theme.colors.{token}`
  - Tailwind for layout, inline styles for theme colors
  - The entire component should be a single flex column that fills the dialog shell

  Run `npx tsc --noEmit` after creation.

---

## Wire FocusModeView into AgentInbox Shell

- [ ] **Replace the focus mode placeholder in `src/renderer/components/AgentInbox/index.tsx` with the real FocusModeView.** Changes:

  1. Import `FocusModeView` from `./FocusModeView`
  2. Import `useAgentInbox` from `../../hooks/useAgentInbox` (the shell needs the filtered items list to pass to FocusModeView)
  3. Add state for tracking the current focus index:
     ```ts
     const [focusIndex, setFocusIndex] = useState(0);
     ```
  4. Compute the items list in the shell (currently only computed inside InboxListView). Add:
     ```ts
     const [filterMode, setFilterMode] = useState<InboxFilterMode>('all');
     const [sortMode, setSortMode] = useState<InboxSortMode>('newest');
     const items = useAgentInbox(sessions, groups, filterMode, sortMode);
     ```
     **Wait** — this means InboxListView and the shell both need the items. Two options:
     - **Option A:** Lift filter/sort state to the shell, pass items down to InboxListView
     - **Option B:** Keep filter/sort in InboxListView, pass a callback up when entering focus that includes the items list

     **Choose Option A** — lift filter/sort to the shell. This way the shell owns the canonical items list, and FocusModeView can navigate it. Update InboxListView to accept `items`, `filterMode`, `setFilterMode`, `sortMode`, `setSortMode` as props instead of computing them internally.

  5. Update InboxListView props:
     ```ts
     interface InboxListViewProps {
     	theme: Theme;
     	sessions: Session[];
     	groups: Group[];
     	items: InboxItem[];
     	filterMode: InboxFilterMode;
     	setFilterMode: (mode: InboxFilterMode) => void;
     	sortMode: InboxSortMode;
     	setSortMode: (mode: InboxSortMode) => void;
     	onClose: () => void;
     	onNavigateToSession?: (sessionId: string, tabId?: string) => void;
     	onEnterFocus: (item: InboxItem) => void;
     	containerRef: React.RefObject<HTMLDivElement>;
     }
     ```
     Remove `useAgentInbox` call from InboxListView — it now receives items via props.

  6. When entering focus mode, compute the index:
     ```ts
     const handleEnterFocus = useCallback((item: InboxItem) => {
     	const idx = items.findIndex(i => i.sessionId === item.sessionId && i.tabId === item.tabId);
     	setFocusIndex(idx >= 0 ? idx : 0);
     	setViewMode('focus');
     }, [items]);
     ```

  7. Render FocusModeView when `viewMode === 'focus'` and `items[focusIndex]` exists:
     ```tsx
     <FocusModeView
     	theme={theme}
     	item={items[focusIndex]}
     	items={items}
     	sessions={sessions}
     	currentIndex={focusIndex}
     	onClose={handleClose}
     	onExitFocus={handleExitFocus}
     	onNavigateItem={setFocusIndex}
     	onNavigateToSession={onNavigateToSession}
     />
     ```

  Run `npx tsc --noEmit` after all changes.

---

## Verification Gate

- [ ] **Run full verification.** Execute:
  ```bash
  cd ~/Documents/Vibework/Maestro && npx tsc --noEmit && npx vitest run && npx eslint src/renderer/components/AgentInbox/ --ext .ts,.tsx
  ```
  All existing tests must pass. The lift of filter/sort state may require test updates if tests were setting internal state — fix as needed. The key invariant: InboxListView renders identically to the old AgentInbox for `viewMode === 'list'`.

---

## Commit

- [ ] **Commit this phase.**
  ```bash
  git add src/renderer/components/AgentInbox/FocusModeView.tsx \
          src/renderer/components/AgentInbox/index.tsx \
          src/renderer/components/AgentInbox/InboxListView.tsx
  git commit -m "FOCUS-MODE: Phase 02 — FocusModeView shell with header, subheader, and footer"
  ```
