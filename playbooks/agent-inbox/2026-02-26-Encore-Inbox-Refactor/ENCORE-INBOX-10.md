# ENCORE-INBOX-10: Fix Focus Mode auto-scroll bug

## Objective
Fix the bug where Focus Mode forcefully scrolls to the bottom every time logs update, preventing users from reading earlier messages.

## Context
- Bug location: `src/renderer/components/AgentInbox/FocusModeView.tsx` — search for `Auto-scroll to bottom when logs change`
- Current code: `useEffect` fires on every `visibleLogs` change and sets `scrollTop = scrollHeight`
- Problem: when an agent is actively producing output, `visibleLogs` updates constantly, scroll snaps to bottom — user cannot scroll up
- Fix: proximity-based auto-scroll (only scroll if user is near bottom)
- Note: line numbers are approximate since the file was just ported in Phase 04

## Tasks

- [x] In `src/renderer/components/AgentInbox/FocusModeView.tsx`, find the auto-scroll useEffect (search for `scrollRef.current.scrollTop = scrollRef.current.scrollHeight`). Replace the entire useEffect block with a proximity-based approach:
  ```typescript
  // Auto-scroll to bottom ONLY if user is near bottom (within 150px) or item changed
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevItemRef = useRef<string>('');
  useEffect(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    const itemKey = `${item.sessionId}:${item.tabId}`;
    const isNewItem = prevItemRef.current !== itemKey;
    if (isNewItem) {
      prevItemRef.current = itemKey;
      el.scrollTop = el.scrollHeight;
      return;
    }
    // Only auto-scroll if user is near bottom
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 150) {
      el.scrollTop = el.scrollHeight;
    }
  }, [visibleLogs, item.sessionId, item.tabId]);
  ```
  Keep the `scrollRef` declaration if it already exists (just replace the useEffect body). If `prevItemRef` doesn't exist, add it. Key behaviors:
  - **New item (prev/next navigation):** always scroll to bottom (fresh context)
  - **Same item, user near bottom (<150px):** auto-scroll (following along)
  - **Same item, user scrolled up (>150px):** don't scroll (reading history)

- [x] Run `npm run lint` to verify no type errors.

## Gate
- `npm run lint` passes
- `grep -n "distanceFromBottom" src/renderer/components/AgentInbox/FocusModeView.tsx` returns the proximity check
