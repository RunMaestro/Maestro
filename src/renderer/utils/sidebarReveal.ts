/**
 * "Bring the sidebar cursor into view" signal.
 *
 * The Left Bar's scroll position belongs to the USER, but so does knowing which
 * agent is active. The rule is: whenever the active agent (or group chat)
 * changes, its row is scrolled into view - Opt+Cmd+NUMBER, the Cmd+K / Cmd+O
 * jumpers, Cmd+[ / Cmd+], a toast click, a CLI `focus-agent`. The one exception
 * is a switch the user made by pointing at the Left Bar itself: they are already
 * looking at the row they clicked, and re-aiming the list under the pointer
 * reads as the panel fighting them.
 *
 * Two inputs feed the consumer in SessionList:
 *
 * 1. An active-agent change it observes itself. It asks `takeLeftBarPointerInput()`
 *    whether the change came from a Left Bar click, and stays put if so.
 * 2. An explicit `requestSidebarReveal()`, for moves that change the cursor
 *    without changing the active agent (arrow navigation, landing on a starred
 *    or group chat row, jumping to the agent that is already active).
 *
 * The old design scrolled synchronously on every `activeSessionId` change, and
 * because `selectedSidebarIndex` is synced from `activeSessionId` by a parent
 * effect (React runs child effects first), the first pass scrolled to wherever
 * the keyboard cursor had been left and the second to the clicked row. That
 * double hop is what read as the panel "readjusting itself". The consumer now
 * defers a frame and re-reads the settled cursor, and clicks are exempt.
 *
 * A monotonic counter rather than a boolean: two consecutive reveal requests
 * are two distinct events, and a flag would coalesce them into one and then
 * need clearing, which is its own race.
 */

let revealToken = 0;
const listeners = new Set<() => void>();

/**
 * Ask the Left Bar to scroll its current keyboard cursor into view, even when
 * the active agent did not change.
 *
 * Safe to call before the cursor state has settled: the consumer defers to the
 * next frame and re-reads the cursor, so a caller that sets the cursor and
 * requests a reveal in the same tick gets the destination rather than the row
 * it started from.
 */
export function requestSidebarReveal(): void {
	revealToken++;
	for (const listener of listeners) listener();
}

/** Subscribe to reveal requests. Returns the unsubscribe function. */
export function subscribeSidebarReveal(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Current token. Zero means nothing has ever asked for a reveal. */
export function getSidebarRevealToken(): number {
	return revealToken;
}

/**
 * Whether the user's most recent pointer or key input landed in the Left Bar.
 * Set by the Left Bar's own pointer-down (capture), cleared by any other
 * pointer-down or any keydown anywhere.
 */
let leftBarPointerInput = false;

/** The user pressed a pointer inside the Left Bar. */
export function markLeftBarPointerInput(): void {
	leftBarPointerInput = true;
}

/** The user's latest input went somewhere other than a Left Bar pointer press. */
export function clearLeftBarPointerInput(): void {
	leftBarPointerInput = false;
}

/**
 * Consume the marker: `true` when the active-agent change being handled came
 * from a click in the Left Bar. Cleared on read, so a later programmatic switch
 * (CLI, toast, remote) is revealed even if the user has not touched anything
 * since the click.
 */
export function takeLeftBarPointerInput(): boolean {
	const fromPointer = leftBarPointerInput;
	leftBarPointerInput = false;
	return fromPointer;
}

/** Test seam: forget every subscriber, reset the counter and the input marker. */
export function _resetSidebarRevealForTests(): void {
	revealToken = 0;
	listeners.clear();
	leftBarPointerInput = false;
}
