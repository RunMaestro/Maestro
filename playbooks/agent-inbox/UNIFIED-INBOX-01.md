# Phase 01: Foundation — Modal Store, Types, and Keyboard Shortcut

> **Feature:** Agent Inbox
> **Codebase:** `~/Documents/Vibework/Maestro` | **Branch:** `feature/agent-inbox`
> **Reference:** Process Monitor at `src/renderer/components/ProcessMonitor.tsx`

This phase sets up the infrastructure: TypeScript types, modal registration, keyboard shortcut, and the zero-items guard.

---

## Pre-flight

- [x] **Create the feature branch.** Run `cd ~/Documents/Vibework/Maestro && git checkout -b feature/agent-inbox`. If the branch already exists, check it out instead: `git checkout feature/agent-inbox`.
  > ✅ Using existing branch `feature/unified-inbox` (renamed from spec). Branch is active and ready.

---

## Types

- [x] **Define the AgentInbox types.** Create `src/renderer/types/agent-inbox.ts` with the following interfaces and types:

  ```ts
  import type { SessionState } from './index'

  export interface InboxItem {
    sessionId: string
    tabId: string
    groupId?: string
    groupName?: string
    sessionName: string
    toolType: string
    gitBranch?: string
    contextUsage?: number        // 0-100, undefined = unknown
    lastMessage: string          // truncated to 90 chars
    timestamp: number            // Unix ms, must be validated > 0
    state: SessionState
    hasUnread: boolean
  }

  /** UI labels: "Newest", "Oldest", "Grouped" */
  export type InboxSortMode = 'newest' | 'oldest' | 'grouped'

  /** UI labels: "All", "Needs Input", "Ready" */
  export type InboxFilterMode = 'all' | 'needs_input' | 'ready'

  /** Human-readable status badges */
  export const STATUS_LABELS: Record<SessionState, string> = {
    idle: 'Ready',
    waiting_input: 'Needs Input',
    busy: 'Processing',
    connecting: 'Connecting',
    error: 'Error',
  }

  /** Status badge color keys (map to theme.colors.*) */
  export const STATUS_COLORS: Record<SessionState, string> = {
    idle: 'success',
    waiting_input: 'warning',
    busy: 'info',
    connecting: 'textMuted',
    error: 'error',
  }
  ```

  Reference the existing `SessionState` type from `src/renderer/types/index.ts` (look for `'idle' | 'busy' | 'waiting_input' | 'connecting' | 'error'`). After creating the file, add the export to `src/renderer/types/index.ts` via `export * from './agent-inbox'`.

---

## Modal Store

- [x] **Register the AgentInbox modal in the modal store.** Open `src/renderer/stores/modalStore.ts`. Add `'agentInbox'` to the `ModalId` type union (near where `'processMonitor'` is defined). Add an action `setAgentInboxOpen: (open: boolean) => void` that calls `openModal('agentInbox')` / `closeModal('agentInbox')`, following the exact pattern of `setProcessMonitorOpen`. No modal data needed.
  > ✅ Added `'agentInbox'` to ModalId union, `setAgentInboxOpen` action in `getModalActions()`, and `agentInboxOpen` reactive selector in `useModalActions()`. TypeScript compiles cleanly.

---

## Keyboard Shortcut + Zero-Items Guard

- [x] **Add the keyboard shortcut `Alt+Cmd+I` with zero-items guard.** Open `src/renderer/hooks/keyboard/useMainKeyboardHandler.ts`. Near the Process Monitor shortcut (`Alt+Cmd+P`), add a new shortcut `Alt+Cmd+I`. **IMPORTANT:** Before opening the modal, check if there are any actionable items. The handler should:

  1. Count sessions where `state === 'waiting_input'` OR any tab has `hasUnread === true`
  2. If count === 0 → show a toast notification "No pending items" (1.5s auto-dismiss) and **do NOT open the modal**. Use the existing toast/notification system in the codebase (search for `toast`, `notification`, or `addNotification`).
  3. If count > 0 → call `ctx.setAgentInboxOpen(true)`

  Make sure `setAgentInboxOpen` is available in the keyboard handler context — add it to the context type and pass it through from the store. Return `true` to prevent default browser behavior.
  > ✅ Added `agentInbox` shortcut (`Alt+Cmd+I`) to `DEFAULT_SHORTCUTS`. Handler in `useMainKeyboardHandler.ts` counts sessions with `state === 'waiting_input'` or any tab with `hasUnread`. Shows toast "No pending items" (1.5s) when count === 0, opens modal otherwise. Added `setAgentInboxOpen` and `addToast` to keyboard handler context in App.tsx. Also added `codeKeyLower === 'i'` to `isSystemUtilShortcut` allowlist so shortcut works when modals are open. TypeScript compiles clean, all 19185 tests pass.

---

## Modal Registration

- [ ] **Register AgentInbox in AppModals.** Open `src/renderer/components/AppModals.tsx`. Add a lazy import: `const AgentInbox = lazy(() => import('./AgentInbox'))`. Near where ProcessMonitor is rendered, add an analogous block rendering `<AgentInbox>` wrapped in `<Suspense>` when `agentInboxOpen` is true. Use `useModalStore(selectModalOpen('agentInbox'))` for the selector. Props to pass: `theme`, `sessions`, `groups`, `onClose`, `onNavigateToSession`.

---

## Placeholder Component

- [ ] **Create the AgentInbox placeholder and verify compilation.** Create `src/renderer/components/AgentInbox.tsx` with a minimal placeholder:

  ```tsx
  import type { Theme } from '../types'
  import type { Session, Group } from '../types'

  interface AgentInboxProps {
    theme: Theme
    sessions: Session[]
    groups: Group[]
    onClose: () => void
    onNavigateToSession?: (sessionId: string, tabId?: string) => void
  }

  export default function AgentInbox({ onClose }: AgentInboxProps) {
    return <div>AgentInbox placeholder</div>
  }
  ```

  Then run `cd ~/Documents/Vibework/Maestro && npx tsc --noEmit` and fix any TypeScript errors. The placeholder must compile cleanly before Phase 02 begins.
