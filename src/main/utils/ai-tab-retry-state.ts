/**
 * Which AI tabs of this desktop have a failed turn held for an automatic resend by Agent
 * Resilience right now, as the renderer reports it (`tabs:aiTabRetryState`, written on every
 * change of its retry map). Main reads it where it must not run a message a second time: a
 * Federation client's resend of a message this desktop's own retry already holds is refused
 * (`TurnSendReceipt` `retrying`), so one side owns the retry.
 */

const pendingTabs = new Set<string>();

function keyOf(agentId: string, tabId: string): string {
	return `${agentId}\u0000${tabId}`;
}

/** Record whether this tab's failed turn is held for an automatic resend. */
export function noteAiTabRetryPending(agentId: string, tabId: string, pending: boolean): void {
	if (pending) pendingTabs.add(keyOf(agentId, tabId));
	else pendingTabs.delete(keyOf(agentId, tabId));
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
}
