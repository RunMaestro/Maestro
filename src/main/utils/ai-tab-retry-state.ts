/**
 * Which AI tabs of this desktop have a failed turn held for an automatic resend by Agent
 * Resilience right now, as the renderer reports it (`tabs:aiTabRetryState`, written on every
 * change of its retry map). Main reads it where it must not run a message a second time: a
 * Federation client's resend of a message this desktop's own retry already holds is refused
 * (`TurnSendReceipt` `retrying`), so one side owns the retry.
 *
 * A renderer's retries live in its memory only: a reload or a crash ends them without a `false`
 * report. So each claim remembers the renderer that made it, and every claim of a renderer ends
 * when that renderer navigates, dies, or is destroyed (`watchRetryOwner()`). No claim outlives
 * the retry it stands for.
 */

/** The renderer that reported a claim: the parts of `WebContents` read here. */
export interface RetryClaimOwner {
	id: number;
	on(event: 'did-navigate' | 'render-process-gone' | 'destroyed', listener: () => void): unknown;
}

/** Claims by `agentId:tabId`: the id of the renderer that made each. */
const pendingTabs = new Map<string, number>();
const watchedOwners = new Set<number>();

function keyOf(agentId: string, tabId: string): string {
	return `${agentId}\u0000${tabId}`;
}

function forgetOwner(ownerId: number): void {
	for (const [key, claimedBy] of pendingTabs) {
		if (claimedBy === ownerId) pendingTabs.delete(key);
	}
}

/** End every claim of `owner` when its page goes (a reload, a crash, a closed window). */
function watchRetryOwner(owner: RetryClaimOwner): void {
	if (watchedOwners.has(owner.id)) return;
	watchedOwners.add(owner.id);
	owner.on('did-navigate', () => forgetOwner(owner.id));
	owner.on('render-process-gone', () => forgetOwner(owner.id));
	owner.on('destroyed', () => {
		forgetOwner(owner.id);
		watchedOwners.delete(owner.id);
	});
}

/**
 * Record whether this tab's failed turn is held for an automatic resend. `owner` is the renderer
 * that reported it; a claim with no owner (a caller outside a renderer) ends only on `false`.
 */
export function noteAiTabRetryPending(
	agentId: string,
	tabId: string,
	pending: boolean,
	owner?: RetryClaimOwner
): void {
	const key = keyOf(agentId, tabId);
	if (!pending) {
		pendingTabs.delete(key);
		return;
	}
	if (owner) watchRetryOwner(owner);
	pendingTabs.set(key, owner?.id ?? -1);
}

/** Whether this tab's failed turn is held for an automatic resend right now. */
export function isAiTabRetryPending(agentId: string, tabId: string): boolean {
	return pendingTabs.has(keyOf(agentId, tabId));
}

/** Forget a tab (it closed): its retry went with it. */
export function forgetAiTabRetryState(agentId: string, tabId: string): void {
	pendingTabs.delete(keyOf(agentId, tabId));
}

/** Clear the record between unit tests. */
export function resetAiTabRetryStateForTests(): void {
	pendingTabs.clear();
	watchedOwners.clear();
}
