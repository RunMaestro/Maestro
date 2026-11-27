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
 * Every queue path asks this through `isQueuedItemTargetBusy()` and `hostedTabHoldsLine()`. A turn
 * on its way is also a hand-over the tab draws busy (`hostedTabsHandingOver()`, U2), as a local tab
 * is busy from its dequeue. A line that changes tells the drain and the hosted projection to look
 * again (`onHostedTabLineChanged()`): nothing in the store has to change for it.
 */

interface LineHolder {
	/** When the holder took the line (this machine's clock). */
	since: number;
	/** A turn on its way to the host: the tab draws busy for it. */
	handingOver: boolean;
}

const lines = new Map<string, Map<string, LineHolder>>();
const changeListeners = new Set<() => void>();

function lineKey(sessionId: string, tabId: string): string {
	return `${sessionId}\u0000${tabId}`;
}

function notifyChanged(): void {
	for (const listener of [...changeListeners]) listener();
}

/**
 * `holderId` holds the line of `tabId` on `sessionId` until it releases it. `handingOver` marks a
 * turn on its way to the host, which the tab draws busy.
 */
export function holdHostedTabLine(
	sessionId: string,
	tabId: string,
	holderId: string,
	options: { handingOver?: boolean; now?: number } = {}
): void {
	if (!sessionId || !tabId) return;
	const key = lineKey(sessionId, tabId);
	const holders = lines.get(key) ?? new Map<string, LineHolder>();
	holders.set(holderId, {
		since: options.now ?? Date.now(),
		handingOver: options.handingOver === true,
	});
	lines.set(key, holders);
	notifyChanged();
}

/** `holderId` lets go of the line it held; the drain and the projection look again. */
export function releaseHostedTabLine(sessionId: string, tabId: string, holderId: string): void {
	const key = lineKey(sessionId, tabId);
	const holders = lines.get(key);
	if (!holders?.delete(holderId)) return;
	if (holders.size === 0) lines.delete(key);
	notifyChanged();
}

/** Whether anything holds the line of `tabId` on `sessionId`. */
export function hostedTabHoldsLine(sessionId: string, tabId: string | undefined): boolean {
	if (!tabId) return false;
	return (lines.get(lineKey(sessionId, tabId))?.size ?? 0) > 0;
}

/** The tabs of `sessionId` with a turn on its way to the host, each with when it left here. */
export function hostedTabsHandingOver(sessionId: string): ReadonlyMap<string, number> {
	const handingOver = new Map<string, number>();
	const prefix = `${sessionId}\u0000`;
	for (const [key, holders] of lines) {
		if (!key.startsWith(prefix)) continue;
		for (const holder of holders.values()) {
			if (!holder.handingOver) continue;
			const tabId = key.slice(prefix.length);
			const since = handingOver.get(tabId);
			if (since === undefined || holder.since < since) handingOver.set(tabId, holder.since);
		}
	}
	return handingOver;
}

/** Run `listener` each time a line is taken or let go. Answers the unsubscribe. */
export function onHostedTabLineChanged(listener: () => void): () => void {
	changeListeners.add(listener);
	return () => {
		changeListeners.delete(listener);
	};
}

/** Test only: forget every line. */
export function resetHostedTabLinesForTest(): void {
	lines.clear();
}
