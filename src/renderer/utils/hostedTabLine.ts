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

/**
 * When this machine first saw an agent's host-queue hand-over (`hostQueueHandOver()`), and until
 * when it counts: this machine's clock, since a host's may differ. One per agent, the one the
 * host's queue shows now.
 */
const handOversSeen = new Map<
	string,
	{ itemId: string; at: number; until: number; checkedAt: number; hostSince?: number }
>();

/** The clock `projectHostedSession()` reads a host-queue hand-over's time limit from. */
export interface HandOverClock {
	/**
	 * When the limit of `itemId`'s hand-over started: the host's own time for it (`hostSince`, the
	 * item's `handOverSince`) when it sends one, never later than when this machine first saw it, so
	 * a client that connects late in the gap runs out with the host, and a host clock ahead of this
	 * one never makes it last longer (U9). The first call starts the limit, and so does a new
	 * `hostSince` for the same message.
	 */
	seenAt(itemId: string, limitMs: number, hostSince?: number): number;
	/** No hand-over now: the next one starts its own limit. */
	clear(): void;
}

/** `sessionId`'s hand-over clock, read at `now`. */
export function hostHandOverClock(sessionId: string, now: number): HandOverClock {
	return {
		seenAt(itemId, limitMs, hostSince) {
			const since =
				typeof hostSince === 'number' && Number.isFinite(hostSince) ? hostSince : undefined;
			const seen = handOversSeen.get(sessionId);
			// The same message, and the host's time for it unchanged (or never sent). A new time is a
			// new hand-over of the same message (it waited for something else in between, maybe
			// while this client was away): it gets a limit of its own (CodeRabbit on #2166).
			if (seen?.itemId === itemId && (since === undefined || since === seen.hostSince)) {
				seen.checkedAt = Math.max(seen.checkedAt, now);
				return seen.at;
			}
			const at = since === undefined ? now : Math.min(since, now);
			handOversSeen.set(sessionId, {
				itemId,
				at,
				until: at + limitMs,
				checkedAt: now,
				...(since !== undefined ? { hostSince: since } : {}),
			});
			return at;
		},
		clear() {
			handOversSeen.delete(sessionId);
		},
	};
}

/**
 * The soonest moment a host-queue hand-over runs out of time that the projection has not yet drawn
 * as run out: it must look again then, with no change from the host to run it. Measured from the
 * clock the projection last read, so a limit that ends between that read and this call is still
 * armed (as a recheck due now), and one the projection already drew as over is not (CodeRabbit on
 * #2166).
 */
export function nextHostHandOverDeadline(): number | undefined {
	let soonest: number | undefined;
	for (const { until, checkedAt } of handOversSeen.values()) {
		if (until > checkedAt && (soonest === undefined || until < soonest)) soonest = until;
	}
	return soonest;
}

/**
 * Forget the hand-overs of agents the sync no longer draws (deleted, moved back, hosting off, no
 * mirror): only a drawn agent's limit may arm the recheck, or a record no projection reads again
 * would re-arm it at once, for ever (CodeRabbit on #2166).
 */
export function pruneHostHandOvers(drawnSessionIds: ReadonlySet<string>): void {
	for (const sessionId of [...handOversSeen.keys()]) {
		if (!drawnSessionIds.has(sessionId)) handOversSeen.delete(sessionId);
	}
}

/** Test only: forget every line and every hand-over seen. */
export function resetHostedTabLinesForTest(): void {
	lines.clear();
	handOversSeen.clear();
}
