/**
 * Media window at launch - bring the saved play queue back when the app starts.
 * See `Plans/floating-widgets.md`, section 4.
 *
 * The media widget window is the queue's authority: it hydrates the saved
 * `mediaPlayerQueue` and publishes the snapshot every app window shows. Main
 * otherwise creates that window only on the first forwarded command, so with
 * no window at launch a saved queue would be invisible (the Now Playing pill
 * and the palette's "Open Media Player" read the replica, which has nothing).
 *
 * The plan says "an active item that is not dismissed", but the saved queue has
 * no dismissed flag: the renderer always restores it dormant and minimized, and
 * picks the first item as the active one when the saved one is gone. So the
 * rule reduces to "the saved queue holds a playable item". The window is
 * created hidden; the authority shows it only once the user restores the
 * player, exactly as the in-app player behaves today.
 */

import { sanitizeMediaItems } from '../../shared/mediaTypes';
import type { FloatingWidgetController } from './floating-widget-window';

/**
 * Whether a saved `mediaPlayerQueue` will restore an active item. Uses the
 * renderer's own sanitizer, so a malformed or hand-edited queue that the
 * authority would drop does not create a window for nothing.
 */
export function savedMediaQueueHasActiveItem(saved: unknown): boolean {
	if (!saved || typeof saved !== 'object') return false;
	return sanitizeMediaItems((saved as { items?: unknown }).items).length > 0;
}

/**
 * Create (never show) the media window when the saved queue has an active
 * item. Returns whether a window now exists for it. Call after the relay's IPC
 * is registered, so the window's `getState` and `ready` calls have handlers.
 */
export function restoreMediaWindowAtLaunch(
	saved: unknown,
	controller: Pick<FloatingWidgetController, 'ensureCreated'>
): boolean {
	if (!savedMediaQueueHasActiveItem(saved)) return false;
	return controller.ensureCreated() !== null;
}
