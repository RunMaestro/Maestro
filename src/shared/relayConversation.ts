/** Relay transport identity is separate from agent, tab and provider session ids. */
export interface RelayConversationState {
	conversationId: string;
	messageId?: string;
	status: 'queued' | 'running' | 'idle' | 'error';
	lastActivityAt: number;
	/** Explicit task completion, never inferred from an idle provider. */
	completedAt?: number;
	archivedAt?: number;
	error?: string;
}

/** Archive only clearly mapped, explicitly completed conversations with no work to lose. */
export function canArchiveRelayConversation(
	tab: {
		id: string;
		relayConversation?: RelayConversationState;
		state?: string;
		starred?: boolean;
		hasUnread?: boolean;
		inputValue?: string;
		stagedImages?: unknown[];
		pendingMergedContext?: string;
		wizardState?: unknown;
	},
	context: { now: number; hours: number; selected: boolean; queued: boolean; busy: boolean }
): boolean {
	const relay = tab.relayConversation;
	return (
		!!relay?.completedAt &&
		relay.status === 'idle' &&
		!relay.archivedAt &&
		Number.isFinite(context.hours) &&
		context.hours > 0 &&
		context.now - Math.max(relay.completedAt, relay.lastActivityAt) >= context.hours * 3_600_000 &&
		!context.selected &&
		!context.queued &&
		!context.busy &&
		tab.state !== 'busy' &&
		!tab.starred &&
		!tab.hasUnread &&
		!tab.inputValue &&
		!tab.stagedImages?.length &&
		!tab.pendingMergedContext &&
		!tab.wizardState
	);
}
