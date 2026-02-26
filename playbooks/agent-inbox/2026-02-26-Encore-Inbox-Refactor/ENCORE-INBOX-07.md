# ENCORE-INBOX-07: Add Unified Inbox to hamburger menu (SessionList)

## Objective
Add the Unified Inbox menu item to the hamburger menu, conditionally rendered based on the Encore gate.

## Context
- SessionList is at `src/renderer/components/SessionList.tsx`
- Director's Notes pattern:
  - Props: `setDirectorNotesOpen?: (open: boolean) => void` (optional, line 442)
  - Destructured: line 462
  - Conditional render: `{setDirectorNotesOpen && (<button .../>)}` (line 702)
  - Shortcut badge: `shortcuts.directorNotes` (line 719)
- The `setAgentInboxOpen` prop does NOT exist yet — must be added
- App.tsx passes `undefined` when feature is off (from Phase 05)
- Props may also need updating in `HamburgerMenuContentProps` (inner component) and the outer `SessionListProps`
- Check `src/renderer/hooks/props/useSessionListProps.ts` for prop threading

## Tasks

- [x] In `src/renderer/components/SessionList.tsx`, add `setAgentInboxOpen?: (open: boolean) => void` to ALL relevant prop interfaces. Search for `setDirectorNotesOpen` to find all interfaces (there are at least 2: `HamburgerMenuContentProps` around line 442 and the outer interface around line 1081). Add `setAgentInboxOpen` as optional in each.

- [x] In the hamburger menu render section, find the Director's Notes button (line 702: `{setDirectorNotesOpen && (`). AFTER that block (after its closing `)}` and before the next `<div>` separator), add the Unified Inbox button following the same pattern:
  ```tsx
  {setAgentInboxOpen && (
    <button
      onClick={() => {
        setAgentInboxOpen(true);
        setMenuOpen(false);
      }}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
    >
      <Inbox className="w-5 h-5" style={{ color: theme.colors.accent }} />
      <div className="flex-1">
        <div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
          Unified Inbox
        </div>
        <div className="text-xs" style={{ color: theme.colors.textDim }}>
          Cross-session notifications
        </div>
      </div>
      {shortcuts.agentInbox && (
        <span className="text-xs font-mono px-1.5 py-0.5 rounded"
          style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}>
          {formatShortcutKeys(shortcuts.agentInbox.keys)}
        </span>
      )}
    </button>
  )}
  ```
  Add `Inbox` to the lucide-react imports if not already there.

- [x] In `src/renderer/hooks/props/useSessionListProps.ts`, add `setAgentInboxOpen` to the returned props if this file threads props to SessionList. Search for `setDirectorNotesOpen` in this file to find the pattern.

- [x] Ensure `setAgentInboxOpen` is properly destructured in all intermediate components that pass it down within SessionList.tsx.

- [x] Run `npm run lint` to verify. (Note: only pre-existing error remains — `onOpenUnifiedInbox` in AppModalsProps from another phase)

## Gate
- `npm run lint` passes
- `grep -n "setAgentInboxOpen" src/renderer/components/SessionList.tsx` returns prop definition + conditional render
- Menu button only appears when `setAgentInboxOpen` is defined (i.e., feature enabled)
