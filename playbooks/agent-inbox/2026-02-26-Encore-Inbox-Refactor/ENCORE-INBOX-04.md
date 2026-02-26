# ENCORE-INBOX-04: Port useAgentInbox hook and AgentInbox components

## Objective
Port the data hook and all 3 component files from `feature/inbox-focus-polish` into the current codebase, adapting imports to the new architecture.

## Context
- Source branch: `feature/inbox-focus-polish`
- Files to port:
  - `src/renderer/hooks/useAgentInbox.ts` — data aggregation hook
  - `src/renderer/components/AgentInbox/index.tsx` — modal shell + view switching
  - `src/renderer/components/AgentInbox/InboxListView.tsx` — virtualized list view
  - `src/renderer/components/AgentInbox/FocusModeView.tsx` — focus mode detail view
- The new codebase uses `settingsStore.ts` (Zustand) instead of prop-drilling settings
- `useModalLayer` hook and `MODAL_PRIORITIES` still exist in the same locations
- `modalStore` still exists at `src/renderer/stores/modalStore.ts`
- `formatRelativeTime` is at `src/renderer/utils/formatters.ts`

## Tasks

- [x] Create `src/renderer/hooks/useAgentInbox.ts` by extracting from old branch: `git show feature/inbox-focus-polish:src/renderer/hooks/useAgentInbox.ts`. Copy the full content. Verify imports: `Session`, `Group` from `../types`, `InboxItem`, `InboxFilterMode`, `InboxSortMode` from `../types/agent-inbox`. These should resolve since Phase 01 created the types file. Run `npm run lint` to check.

- [x] Create the directory `src/renderer/components/AgentInbox/` and port all 3 component files. For each, extract from old branch and copy:
  1. `git show feature/inbox-focus-polish:src/renderer/components/AgentInbox/index.tsx` → `src/renderer/components/AgentInbox/index.tsx`
  2. `git show feature/inbox-focus-polish:src/renderer/components/AgentInbox/InboxListView.tsx` → `src/renderer/components/AgentInbox/InboxListView.tsx`
  3. `git show feature/inbox-focus-polish:src/renderer/components/AgentInbox/FocusModeView.tsx` → `src/renderer/components/AgentInbox/FocusModeView.tsx`
  After copying, verify all imports resolve. Key imports to check:
  - `../../types` should export `Theme`, `Session`, `Group`, `ThinkingMode`, `LogEntry`
  - `../../types/agent-inbox` should export all inbox types (from Phase 01)
  - `../../hooks/useAgentInbox` should resolve (created above)
  - `../../hooks/ui/useModalLayer` — verify this exists: `ls src/renderer/hooks/ui/useModalLayer*`
  - `../../constants/modalPriorities` — verify: `grep -n "AGENT_INBOX" src/renderer/constants/modalPriorities.ts`. If `AGENT_INBOX` doesn't exist in priorities, add it (use priority 555, same as old branch)
  - `../../stores/modalStore` — verify `selectModalData` is exported
  - `../../utils/formatters` — verify `formatRelativeTime` is exported
  - The ported `InboxListView.tsx` uses `react-window` for virtualization, but this dependency does NOT exist in the project. The codebase already uses `@tanstack/react-virtual` (used by Director's Notes `UnifiedHistoryTab.tsx`). After copying the files, replace ALL `react-window` imports with `@tanstack/react-virtual` equivalents. Specifically: replace `import { FixedSizeList } from 'react-window'` (or similar) with `import { useVirtualizer } from '@tanstack/react-virtual'` and refactor the list rendering to use the `useVirtualizer` hook pattern (see `src/renderer/components/DirectorNotes/UnifiedHistoryTab.tsx` lines 201-221 for reference). This avoids adding an unnecessary dependency.
  - `../../utils/markdownConfig` — verify `generateTerminalProseStyles` exists
  - `../../components/MarkdownRenderer` — verify exists
  **Notes:** react-window → @tanstack/react-virtual migration completed. Added `agentInbox` to ModalId type, AgentInboxModalData interface, ModalDataMap, and getModalActions() in modalStore.ts. AGENT_INBOX priority added at 555 in modalPriorities.ts.

- [x] Run `npm run lint` and fix any import resolution errors. Common issues: renamed types, moved hooks, missing re-exports. Fix each error by finding the new location of the imported symbol.
  **Notes:** Fixed 2 type narrowing issues in index.tsx (filterMode/sortMode from ModalData needed explicit casts to InboxFilterMode/InboxSortMode). Lint passes clean.

## Gate
- `src/renderer/hooks/useAgentInbox.ts` exists
- `src/renderer/components/AgentInbox/` directory has 3 files: `index.tsx`, `InboxListView.tsx`, `FocusModeView.tsx`
- `npm run lint` passes (zero errors)
- `AGENT_INBOX` priority registered in `modalPriorities.ts`
