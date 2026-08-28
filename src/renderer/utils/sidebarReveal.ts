/**
 * Opt-in "bring the sidebar cursor into view" signal.
 *
 * The Left Bar's scroll position belongs to the USER. It may only be moved when
 * the user drove the cursor somewhere they cannot see - arrow navigation, the
 * Cmd+[ / Cmd+] cycle, a deliberate jump. It must NOT move when the user clicks
 * a row: they are already looking at the thing they clicked, and re-aiming the
 * list under the pointer reads as the panel fighting them.
 *
 * The old design inferred the intent from state instead: a `useEffect` in
 * SessionList watched `activeSessionId` and scrolled whenever it changed. A
 * click changes `activeSessionId`, so a click scrolled. Worse, it scrolled
 * TWICE - `selectedSidebarIndex` is synced from `activeSessionId` by a parent
 * effect, React runs child effects first, so the first pass scrolled to
 * wherever the keyboard cursor had been left and the second to the clicked row.
 * That double hop is what read as the panel "readjusting itself".
 *
 * Intent cannot be recovered from the state it produced, so it is declared
 * instead. Callers that mean "reveal the cursor" say so; everything else is
 * silent by default, and a new caller that forgets is inert rather than
 * surprising.
 *
 * A monotonic counter rather than a boolean: two consecutive reveal requests
 * are two distinct events, and a flag would coalesce them into one and then
 * need clearing, which is its own race.
 */

let revealToken = 0;
const listeners = new Set<() => void>();

/**
 * Ask the Left Bar to scroll its current keyboard cursor into view.
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

/** Test seam: forget every subscriber and reset the counter. */
export function _resetSidebarRevealForTests(): void {
	revealToken = 0;
	listeners.clear();
}
