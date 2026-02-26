# ENCORE-INBOX-05: Integrate Unified Inbox into App.tsx (modal + state + Encore gating)

## Objective
Wire the Unified Inbox modal into App.tsx with Encore Feature gating, following the Director's Notes pattern exactly.

## Context
- App.tsx is at `src/renderer/App.tsx` (6,563 lines post-refactor)
- Director's Notes pattern to mirror:
  - Line 46-47: lazy import `const DirectorNotesModal = lazy(() => import('./components/DirectorNotes')...)`
  - Line 356-357: modal state from `useModalActions()` — `directorNotesOpen, setDirectorNotesOpen`
  - Line 508: `encoreFeatures` destructured from settings
  - Line 5220: conditional setter for SessionList: `setDirectorNotesOpen: encoreFeatures.directorNotes ? setDirectorNotesOpen : undefined`
  - Line 5634: conditional handler for QuickActions: `encoreFeatures.directorNotes ? () => setDirectorNotesOpen(true) : undefined`
  - Line 6017: gated modal render: `{encoreFeatures.directorNotes && directorNotesOpen && (<Suspense>...</Suspense>)}`
- `useModalActions()` comes from `src/renderer/stores/modalStore.ts` — need to add `agentInboxOpen`/`setAgentInboxOpen` there first
- `modalStore.ts` has `agentInbox` in valid modal IDs (check with `grep "agentInbox" src/renderer/stores/modalStore.ts`) — if not, add it

## Tasks

- [x] In `src/renderer/stores/modalStore.ts`, verify that `agentInbox` is registered as a valid modal ID. Search for `type ModalId` or the array/union of valid modal IDs. If `agentInbox` is NOT present, add it following the pattern used by `directorNotes` or other modals. Also verify `useModalActions()` returns `agentInboxOpen` and `setAgentInboxOpen` — if not, add them following the `directorNotesOpen`/`setDirectorNotesOpen` pattern.
  > `agentInbox` was already registered as ModalId (line 230) with `AgentInboxModalData` and `setAgentInboxOpen` action. Added `agentInboxOpen` reactive selector to `useModalActions()` return object.

- [x] In `src/renderer/App.tsx`, add the lazy import for AgentInbox near line 46 (next to Director's Notes import):
  ```typescript
  const AgentInbox = lazy(() => import('./components/AgentInbox'));
  ```
  Then destructure `agentInboxOpen` and `setAgentInboxOpen` from `useModalActions()` (find where `directorNotesOpen` is destructured, around line 356).
  > Added lazy import at line 49. Destructured `agentInboxOpen` and `setAgentInboxOpen` from `useModalActions()` at lines 360-361.

- [x] In `src/renderer/App.tsx`, add the gated modal render. Find the Director's Notes modal block (line 6017: `{encoreFeatures.directorNotes && directorNotesOpen && (`). AFTER that block, add:
  ```tsx
  {encoreFeatures.unifiedInbox && agentInboxOpen && (
    <Suspense fallback={null}>
      <AgentInbox
        theme={theme}
        sessions={sessions}
        groups={groups}
        onClose={() => setAgentInboxOpen(false)}
        onNavigateToSession={handleNavigateToSession}
      />
    </Suspense>
  )}
  ```
  Verify `handleNavigateToSession` or equivalent callback exists (search for the function used by Director's Notes `onResumeSession`). If the exact callback doesn't exist, create a minimal one or use `handleDirectorNotesResumeSession` pattern as reference.
  > Created `handleAgentInboxNavigateToSession` callback (closes inbox, switches to session). Gated modal render at line 6051 with full props including `enterToSendAI`.

- [x] Wire conditional setters for child components. Find the props assembly area (around line 5220 where Director's Notes does it):
  - For SessionList: `setAgentInboxOpen: encoreFeatures.unifiedInbox ? setAgentInboxOpen : undefined`
  - For QuickActionsModal (around line 5634): `onOpenUnifiedInbox: encoreFeatures.unifiedInbox ? () => setAgentInboxOpen(true) : undefined`
  > Both wired. Also added `setAgentInboxOpen` to keyboard handler ref object for future keybinding support.

- [x] Run `npm run lint` — expect type errors for SessionList/QuickActionsModal props not accepting optional. Note errors for next phases.
  > 2 expected type errors:
  > 1. `TS2353`: `setAgentInboxOpen` not in `UseSessionListPropsDeps` type (line 5236)
  > 2. `TS2322`: `onOpenUnifiedInbox` not in `AppModalsProps` type (line 5652)
  > Both will be resolved in phases 06-08 when those component prop interfaces are updated.

## Gate
- `npm run lint` may have type errors (resolved in phases 06-08)
- `grep -n "agentInboxOpen" src/renderer/App.tsx` returns lazy import, state, gated render, and conditional setters
- Modal is gated: `encoreFeatures.unifiedInbox && agentInboxOpen`
