# Common Pitfalls & Debugging

## UI Bug Debugging Checklist

1. **CSS first:** Check parent `overflow: hidden`, `z-index` conflicts, `position` mismatches
2. **Scroll issues:** Use `scrollIntoView({ block: 'nearest' })`, not centering
3. **Portal escape:** Clipped overlays/tooltips → `createPortal(el, document.body)`
4. **Fixed positioning:** `position: fixed` inside transformed parents won't work — check ancestor transforms

## Historical Bugs That Wasted Time

- **Tab naming bug:** "Fixed" modal coordination when real issue was unregistered IPC handler
- **Tooltip clipping:** Attempted `overflow: visible` on element when parent had `overflow: hidden`
- **Session validation:** Fixed renderer calls when handler wasn't wired in main process

**Lesson:** Always verify the IPC handler exists in `src/main/index.ts` before modifying caller code.

## Focus Not Working

1. Add `tabIndex={0}` or `tabIndex={-1}`
2. Add `outline-none` class
3. Use `ref={(el) => el?.focus()}` for auto-focus

## Settings Not Persisting

1. Verify wrapper calls `window.maestro.settings.set()`
2. Check loading code in `useSettings.ts` useEffect
3. Verify key name matches in both save and load

## Modal Escape Not Working

1. Register with layer stack (don't handle Escape locally)
2. Check priority in `modalPriorities.ts`
3. Use ref pattern to avoid re-registration

## Theme Colors Not Applying

1. Use `style={{ color: theme.colors.textMain }}` — never Tailwind color classes for themed elements
2. Check theme prop is passed to component

## Process Output Not Showing

1. Check agent ID matches (with `-ai` or `-terminal` suffix)
2. Verify `onData` listener is registered
3. Check process spawned successfully (pid > 0)

## Root Cause Verification (Before Implementing Fixes)

**IPC issues:** Verify handler registered in `src/main/index.ts` first.
**UI rendering:** Check CSS on element AND parent containers before changing logic.
**State not updating:** Trace data flow source → consumer. Check if setter is called vs re-render suppressed.
**Feature not working:** Verify code path is actually executing (temporary console.log).

## Sentry Integration

- Let unexpected exceptions bubble up (auto-reported)
- Handle expected/recoverable errors explicitly
- Use `captureException(error, context)` for explicit reporting
- Dynamic Sentry import required (electron.app access issue at module load)
