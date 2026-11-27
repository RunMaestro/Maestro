/**
 * A hosted agent's tab holds its line on this machine while a turn of it is on its way to the host,
 * or while a consult waits for its turn to start there.
 *
 * A local tab is busy from the moment its queue drain takes an item until the turn ends, so
 * nothing queued behind the item can overtake it, and a turn that consults another agent puts its
 * hold at the head of the queue before anything else can run. A hosted tab runs its turns on the
 * host: the drain takes the item, hands it over, and the tab reads the host's state again, which
 * is idle until the host's first frame of the new turn arrives. In that gap the drain took the next
 * waiting item too, the host queued it behind the first, and started it the moment the first turn
 * ended, while the first turn's consult was still running here (U1). Each holder of a line names
 * itself, so one release never frees a line another holder still holds.
 *
 * Every queue path asks this through `isQueuedItemTargetBusy()` and `hostedTabHoldsLine()`; a
 * released line tells the drain to look again (`onHostedTabLineReleased()`), so the next item goes
 * at once rather than at the drain's next poll.
 */

const holders = new Map<string, Set<string>>();
const releaseListeners = new Set<() => void>();

function lineKey(sessionId: string, tabId: string): string {
	return `${sessionId}\u0000${tabId}`;
}

/** `holderId` holds the line of `tabId` on `sessionId` until it releases it. */
export function holdHostedTabLine(sessionId: string, tabId: string, holderId: string): void {
	if (!sessionId || !tabId) return;
	const key = lineKey(sessionId, tabId);
	const set = holders.get(key) ?? new Set<string>();
	set.add(holderId);
	holders.set(key, set);
}

/** `holderId` lets go of the line it held; the drain looks again once nobody holds it. */
export function releaseHostedTabLine(sessionId: string, tabId: string, holderId: string): void {
	const key = lineKey(sessionId, tabId);
	const set = holders.get(key);
	if (!set?.delete(holderId)) return;
	if (set.size > 0) return;
	holders.delete(key);
	for (const listener of [...releaseListeners]) listener();
}

/** Whether anything holds the line of `tabId` on `sessionId`. */
export function hostedTabHoldsLine(sessionId: string, tabId: string | undefined): boolean {
	if (!tabId) return false;
	return (holders.get(lineKey(sessionId, tabId))?.size ?? 0) > 0;
}

/** Run `listener` each time a line is let go. Answers the unsubscribe. */
export function onHostedTabLineReleased(listener: () => void): () => void {
	releaseListeners.add(listener);
	return () => {
		releaseListeners.delete(listener);
	};
}

/** Test only: forget every line. */
export function resetHostedTabLinesForTest(): void {
	holders.clear();
}
