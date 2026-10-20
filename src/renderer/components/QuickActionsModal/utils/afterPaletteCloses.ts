/**
 * Work that has to wait for the palette to be GONE, not merely asked to close.
 *
 * `setQuickActionOpen(false)` is a state write: the palette is still mounted,
 * still focused, and the keystroke that picked the entry is still propagating
 * when the entry's `action()` returns. Three things go wrong for an action that
 * takes effect in that window, and every palette entry that touches focus or
 * the keyboard hits at least one of them:
 *
 *  - **The palette re-asserts its own focus.** Its search input is focused
 *    through `useFocusAfterRender` with no dependency array, so it takes focus
 *    back after every render it survives - including the one an action's focus
 *    move caused.
 *  - **`useMainKeyboardHandler` drops bare keys while a layer is open.** An
 *    action that works by dispatching a key (the vertical half of region focus
 *    sends a bare arrow) is swallowed by the layer guard until the palette has
 *    left the layer stack.
 *  - **The selecting keystroke is still live.** The number hotkeys
 *    (Cmd/Ctrl+1-9) are not stopped from propagating, so they reach the window
 *    handler AFTER the action ran. Anything the action armed is therefore
 *    something that keystroke can still be matched against - which is how
 *    arming Deck mode synchronously would hand the mode its own selecting
 *    chord and disarm it in the same event.
 *
 * {@link MOUNT_FOCUS_DELAY_MS} is the same 50ms `buildSearchCommands` waits
 * before opening its filter inputs, and its doc comment describes exactly this
 * race. It is one shared helper rather than a `setTimeout` per call site so
 * that the next palette entry with this problem inherits the reason along with
 * the delay.
 */

import { MOUNT_FOCUS_DELAY_MS } from '../../../hooks/utils/useFocusAfterRender';

export function afterPaletteCloses(run: () => void): void {
	setTimeout(run, MOUNT_FOCUS_DELAY_MS);
}
