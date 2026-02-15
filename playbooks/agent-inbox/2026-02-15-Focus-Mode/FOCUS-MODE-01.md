# Phase 01: Extract InboxListView + Add viewMode Shell to AgentInbox

> **Feature:** Focus Mode (Inbox Triage View)
> **Codebase:** `~/Documents/Vibework/Maestro` | **Branch:** `feature/focus-mode`
> **Parent:** `src/renderer/components/AgentInbox.tsx` (800 lines)

This phase refactors AgentInbox.tsx into an orchestrator shell. The current body (header, list, footer) moves to a new `InboxListView.tsx` component. AgentInbox.tsx becomes a thin wrapper with `viewMode` state that will later render either InboxListView or FocusModeView.

**Why first:** All subsequent phases depend on this split. FocusModeView (Phase 02+) plugs into the same shell. We must extract cleanly without breaking existing behavior or tests.

---

## Pre-flight

- [ ] **Create the feature branch.** Run `cd ~/Documents/Vibework/Maestro && git checkout main && git pull && git checkout -b feature/focus-mode`. If `feature/unified-inbox` hasn't merged yet, branch from it instead: `git checkout feature/unified-inbox && git checkout -b feature/focus-mode`.

---

## Types

- [ ] **Add Focus Mode types to `src/renderer/types/agent-inbox.ts`.** Add the following type and extend InboxItem:

  ```ts
  /** View mode inside the AgentInbox modal */
  export type InboxViewMode = 'list' | 'focus'
  ```

  Also add to the existing file — do NOT modify existing types, only append. Run `npx tsc --noEmit` to verify.

---

## Extract InboxListView

- [ ] **Create `src/renderer/components/AgentInbox/InboxListView.tsx` and move AgentInbox body into it.** This is the biggest task in the playbook. Follow these steps precisely:

  1. **Create directory** `src/renderer/components/AgentInbox/` (new folder).
  2. **Create `InboxListView.tsx`** inside the new folder.
  3. **Move ALL content** from the current `AgentInbox.tsx` into `InboxListView.tsx`, with these modifications:
     - Rename the component from `AgentInbox` to `InboxListView`
     - Change the export to `export default function InboxListView`
     - Add a new prop to the interface: `onEnterFocus: (item: InboxItem) => void`
     - The `useModalLayer` hook call should **stay in the parent** (AgentInbox), so **remove** the `useModalLayer` import and call from InboxListView
     - The outer overlay `<div className="fixed inset-0 modal-overlay ...">` and the dialog `<div role="dialog" ...>` shell should **stay in the parent** — InboxListView should only render from the header `<div ref={headerRef}>` down to the footer
     - Remove the `handleClose` callback that manages focus restoration (parent owns that now)
     - Accept `onClose` prop and call it directly when needed (X button, Enter-to-navigate)
     - Accept a `containerRef` prop of type `React.RefObject<HTMLDivElement>` for keyboard focus management (the parent owns the ref)
     - Add keyboard shortcut: when `e.key === 'f' || e.key === 'F'` (without modifiers), call `onEnterFocus(items[selectedIndex])` if items exist
  4. **Move helper functions** into InboxListView.tsx: `buildRows`, `resolveStatusColor`, `resolveContextUsageColor`, `InboxItemCardContent`, `InboxRow`, `SegmentedControl`, all constants (`ITEM_HEIGHT`, `GROUP_HEADER_HEIGHT`, `MODAL_HEADER_HEIGHT`, `MODAL_FOOTER_HEIGHT`, `EMPTY_STATE_MESSAGES`, `SORT_OPTIONS`, `FILTER_OPTIONS`)
  5. **Move all imports** that these functions need (React, List, lucide icons, types, hooks, utils, constants)
  6. **Keep `resolveContextUsageColor` as a named export** (it's imported by tests)
  7. Add `F Focus` to the footer keyboard hints: `<span>F Focus</span>` alongside existing hints

  The InboxListView props interface should look like:

  ```ts
  interface InboxListViewProps {
  	theme: Theme;
  	sessions: Session[];
  	groups: Group[];
  	onClose: () => void;
  	onNavigateToSession?: (sessionId: string, tabId?: string) => void;
  	onEnterFocus: (item: InboxItem) => void;
  	containerRef: React.RefObject<HTMLDivElement>;
  }
  ```

  Run `npx tsc --noEmit` after creation.

---

## Refactor AgentInbox as Shell

- [ ] **Rewrite `src/renderer/components/AgentInbox.tsx` as a thin orchestrator shell (move to `src/renderer/components/AgentInbox/index.tsx`).** The original file at `src/renderer/components/AgentInbox.tsx` should be **deleted** and replaced with `src/renderer/components/AgentInbox/index.tsx`. This preserves the import path `./AgentInbox` for AppModals.tsx. The shell should:

  1. **Import** `InboxListView` from `./InboxListView`
  2. **Own the modal layer**: `useModalLayer(MODAL_PRIORITIES.AGENT_INBOX, 'Unified Inbox', handleClose)`
  3. **Own focus restoration** (triggerRef, rafIdRef, handleClose — same logic as current)
  4. **Own viewMode state**:
     ```ts
     const [viewMode, setViewMode] = useState<InboxViewMode>('list')
     const [focusItem, setFocusItem] = useState<InboxItem | null>(null)
     ```
  5. **Handle focus mode entry**:
     ```ts
     const handleEnterFocus = useCallback((item: InboxItem) => {
     	setFocusItem(item);
     	setViewMode('focus');
     }, []);
     ```
  6. **Handle focus mode exit** (back to list):
     ```ts
     const handleExitFocus = useCallback(() => {
     	setFocusItem(null);
     	setViewMode('list');
     }, []);
     ```
  7. **Render the modal shell** (overlay + dialog wrapper), same as current AgentInbox lines 648-667
  8. **Conditionally render** inside the dialog:
     ```tsx
     {viewMode === 'list' ? (
     	<InboxListView
     		theme={theme}
     		sessions={sessions}
     		groups={groups}
     		onClose={handleClose}
     		onNavigateToSession={onNavigateToSession}
     		onEnterFocus={handleEnterFocus}
     		containerRef={containerRef}
     	/>
     ) : (
     	<div style={{ color: theme.colors.textDim, padding: 40, textAlign: 'center' }}>
     		Focus Mode placeholder — Phase 02
     	</div>
     )}
     ```
  9. **Intercept Escape key in the dialog's onKeyDown**: If `viewMode === 'focus'` and `e.key === 'Escape'`, call `handleExitFocus()` and `e.stopPropagation()` (prevents layer stack from closing the modal). If `viewMode === 'list'`, let the event propagate normally (layer stack handles close).
  10. **Modal width**: For now, keep `w-[600px]`. The resize animation comes in Phase 07.

  The props interface remains unchanged:
  ```ts
  interface AgentInboxProps {
  	theme: Theme;
  	sessions: Session[];
  	groups: Group[];
  	onClose: () => void;
  	onNavigateToSession?: (sessionId: string, tabId?: string) => void;
  }
  ```

  Delete the old `src/renderer/components/AgentInbox.tsx` file. Run `npx tsc --noEmit` to verify the new `AgentInbox/index.tsx` is picked up by the lazy import in AppModals.tsx.

---

## Verification Gate

- [ ] **Run full verification.** Execute:
  ```bash
  cd ~/Documents/Vibework/Maestro && npx tsc --noEmit && npx vitest run && npx eslint src/renderer/components/AgentInbox/ --ext .ts,.tsx
  ```
  All existing AgentInbox tests must still pass. If tests import from `../AgentInbox`, they now resolve to `../AgentInbox/index.tsx` — this should work transparently. If any test imports `resolveContextUsageColor` from `../AgentInbox`, update the import to `../AgentInbox/InboxListView` or re-export it from the index. Fix any failures before proceeding.

---

## Commit

- [ ] **Commit this phase.** Stage only the changed/created files:
  ```bash
  git add src/renderer/types/agent-inbox.ts \
          src/renderer/components/AgentInbox/index.tsx \
          src/renderer/components/AgentInbox/InboxListView.tsx
  git rm src/renderer/components/AgentInbox.tsx 2>/dev/null || true
  git commit -m "FOCUS-MODE: Phase 01 — extract InboxListView, add viewMode shell to AgentInbox"
  ```
  If `git rm` fails (file already moved), that's fine — just make sure the old file doesn't exist.
