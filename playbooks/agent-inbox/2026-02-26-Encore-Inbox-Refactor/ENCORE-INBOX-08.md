# ENCORE-INBOX-08: Add Unified Inbox to command palette (QuickActionsModal)

## Objective
Add the Unified Inbox action to the command palette, conditionally rendered based on Encore gate.

## Context
- QuickActionsModal is at `src/renderer/components/QuickActionsModal.tsx`
- Director's Notes pattern:
  - Props: `onOpenDirectorNotes?: () => void` (optional, line 119)
  - Destructured: line 206
  - Conditional action entry: lines 1023-1036 using spread `...(onOpenDirectorNotes ? [{...}] : [])`
- NO agentInbox entry exists — must be created from scratch
- App.tsx passes `undefined` for the handler when feature is off (from Phase 05)

## Tasks

- [x] In `src/renderer/components/QuickActionsModal.tsx`, add `onOpenUnifiedInbox?: () => void` to the props interface (find where `onOpenDirectorNotes` is defined, around line 119). Then destructure it alongside `onOpenDirectorNotes` (around line 206).

- [x] In the actions array, find the Director's Notes entry (line 1023: `...(onOpenDirectorNotes`). AFTER that block, add the Unified Inbox entry:
  ```typescript
  ...(onOpenUnifiedInbox
    ? [
        {
          id: 'unifiedInbox',
          label: 'Unified Inbox',
          shortcut: shortcuts.agentInbox,
          subtext: 'Cross-session notification center',
          action: () => {
            onOpenUnifiedInbox();
            setQuickActionOpen(false);
          },
        },
      ]
    : []),
  ```

- [x] Run `npm run lint` to verify.

> **Note:** Also added `onOpenUnifiedInbox` to both `AppUtilityModalsProps` and `AppModalsProps` interfaces in `AppModals.tsx`, with destructuring and JSX threading to QuickActionsModal, to fix the type error from App.tsx already passing this prop.

## Gate
- `npm run lint` passes
- `grep -n "unifiedInbox" src/renderer/components/QuickActionsModal.tsx` returns action entry
- Action only appears when `onOpenUnifiedInbox` is defined (feature enabled)
