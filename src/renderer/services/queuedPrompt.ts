/**
 * queuedPrompt - put a prompt into an agent's execution queue from outside the
 * composer.
 *
 * Everything that sends a message to an agent without a user typing it (the
 * CLI's `dispatch --queue`, a snooze's wake prompt) has the same two problems:
 * the item has to be byte-identical to one the composer would have built, or it
 * renders wrong and drains wrong; and it must not race whatever the agent is
 * already doing.
 *
 * The queue solves the second one for free. An item appended here is dispatched
 * by `useQueueProcessing`, which drains an idle agent on its next render and an
 * busy one when its turn finishes - so a caller never has to ask "is the agent
 * free?" and never has to reimplement the spawn. It also means the target tab
 * is re-resolved at DRAIN time (`resolveQueuedItemTarget`), which is what makes
 * this safe to call in the same tick as a store write that created the tab:
 * nothing here depends on React having re-rendered yet.
 *
 * Module functions rather than a hook, because the callers (a 15s sweep timer,
 * an IPC listener) run outside React.
 */

import type { AITab, QueuedItem, Session } from '../types';
import { useSessionStore, updateSessionWith } from '../stores/sessionStore';
import { useAgentStore } from '../stores/agentStore';
import { getDispatchDeps } from '../stores/retryStore';
import { getActiveTab, getTabDisplayName } from '../utils/tabHelpers';
import { applyQueuedItemDispatch, getQueueBusyContext } from '../utils/executionQueue';
import { captureQueuedTurnSettings } from '../utils/providerTabSessions';
import { planCrossAgentMentions } from './crossAgentMentions';
import { generateId } from '../utils/ids';
import { logger } from '../utils/logger';

/** What to queue, and where. */
export interface QueuedPromptOptions {
	session: Session;
	/** Tab the prompt is addressed to. */
	tab: AITab;
	text: string;
	/** Base64 data URLs, forwarded to the spawn. */
	images?: string[];
}

/**
 * Build the queue item a message becomes, exactly as the composer builds it.
 *
 * Three of these fields are easy to omit and each has a visible cost:
 * `tabName` is the label a closed tab's queued item falls back to,
 * `readOnlyMode` is what lets the item bypass the parallel-execution guard, and
 * `turnSettings` freezes the model and effort at queue time so a queue that
 * drains after the user switches models still runs - and is labeled - with what
 * was selected when it was queued.
 *
 * The `@mention` flags are stamped but NOT fired: a consult must reach the
 * other agent when this item becomes the agent's turn, not when it was queued.
 * `agentStore.processQueuedItem` fires it at drain time.
 */
export function buildQueuedMessageItem({
	session,
	tab,
	text,
	images,
}: QueuedPromptOptions): QueuedItem {
	const mentionPlan = planCrossAgentMentions(text, session.id);
	return {
		id: generateId(),
		timestamp: Date.now(),
		tabId: tab.id,
		type: 'message',
		text,
		...(images && images.length > 0 ? { images: [...images] } : {}),
		tabName: getTabDisplayName(tab, session.agentSessionId),
		readOnlyMode: tab.readOnlyMode === true || tab.permissionMode === 'readonly',
		turnSettings: captureQueuedTurnSettings(tab, session),
		...(mentionPlan && {
			crossAgentMention: true,
			crossAgentOnly: mentionPlan.suppressLocal,
		}),
	};
}

/**
 * The slash command a message IS, when the whole message is exactly one of the
 * user's commands (`/commit`). Searches the same sets, in the same order, that
 * `agentStore.processQueuedItem` resolves a command item against, so an item
 * built from a match here always finds its definition there.
 */
function matchSlashCommand(
	session: Session,
	text: string
): { command: string; description?: string } | null {
	const commandText = text.trim();
	if (!commandText.startsWith('/')) return null;
	const deps = getDispatchDeps();
	return (
		deps?.customAICommands.find((cmd) => cmd.command === commandText) ??
		deps?.speckitCommands.find((cmd) => cmd.command === commandText) ??
		deps?.openspecCommands.find((cmd) => cmd.command === commandText) ??
		deps?.bmadCommands?.find((cmd) => cmd.command === commandText) ??
		session.agentCommands?.find((cmd) => cmd.command === commandText && cmd.prompt) ??
		null
	);
}

/**
 * Queue a prompt for one tab of one agent, reading both from the store.
 *
 * `tabId` names the tab the prompt belongs to. An id that no longer resolves
 * falls back to the agent's active tab rather than dropping the prompt: the
 * caller has already decided this agent should be asked something, and losing
 * that because a tab moved is worse than answering it in the tab next door.
 *
 * `expandCommands` is for text a person typed (Quick Chat): a message that is
 * exactly one of their slash commands is queued as that COMMAND, the way the
 * composer queues it, instead of as the literal text `/commit`. Callers whose
 * text was written by a program leave it off.
 *
 * @returns The queued item, or null when the agent is gone or has no AI tab.
 */
export function enqueuePromptForTab(options: {
	sessionId: string;
	tabId: string;
	text: string;
	images?: string[];
	expandCommands?: boolean;
}): QueuedItem | null {
	const { sessionId, tabId, text, images, expandCommands } = options;
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	if (!session) return null;

	const tab = session.aiTabs?.find((t) => t.id === tabId) ?? getActiveTab(session);
	if (!tab) return null;

	const message = buildQueuedMessageItem({ session, tab, text, images });
	const command = expandCommands ? matchSlashCommand(session, text) : null;
	const item: QueuedItem = command
		? {
				id: message.id,
				timestamp: message.timestamp,
				tabId: message.tabId,
				type: 'command',
				command: command.command,
				commandDescription: command.description,
				tabName: message.tabName,
				readOnlyMode: message.readOnlyMode,
				turnSettings: message.turnSettings,
			}
		: message;
	updateSessionWith(sessionId, (s) => ({
		...s,
		executionQueue: [...(s.executionQueue || []), item],
	}));
	return item;
}

/**
 * Take one item out of an agent's queue before it runs.
 *
 * @returns Whether it was still there to take. The check and the removal are one
 * store update, so a caller that means to send the prompt somewhere else can
 * trust `true`: the queue did not also start it. On `false` the item already
 * ran (or someone else removed it), and sending it again would send it twice.
 */
export function removeQueuedItem(sessionId: string, itemId: string): boolean {
	let removed = false;
	updateSessionWith(sessionId, (s) => {
		if (!s.executionQueue?.some((i) => i.id === itemId)) return s;
		removed = true;
		return { ...s, executionQueue: s.executionQueue.filter((i) => i.id !== itemId) };
	});
	return removed;
}

/** Runs one dequeued item. The default goes through `agentStore.processQueuedItem`. */
export type QueuedItemDispatcher = (sessionId: string, item: QueuedItem) => Promise<unknown>;

const dispatchThroughStore: QueuedItemDispatcher = (sessionId, item) => {
	const deps = getDispatchDeps();
	if (!deps) return Promise.reject(new Error('Queue dispatch is not ready yet'));
	return useAgentStore.getState().processQueuedItem(sessionId, item, deps);
};

/**
 * Run one queued item NOW instead of waiting for its turn: the Force Send
 * action. The Execution Queue's Force Send buttons and any service that queues a
 * prompt for a tab it knows is free (Quick Chat) share this, so "safe to send
 * right now" cannot mean two things.
 *
 * A tab runs one turn at a time, so an item whose own tab is mid-turn is left
 * queued. When ANOTHER tab of the agent is mid-turn the item runs alongside it
 * and is stamped `forceParallel`: that badges its chat entry and tells the
 * on-exit dequeue guard this was a deliberate override, not a sequential send.
 *
 * Recovery from a failed dispatch (release the tab, take the card back, re-queue
 * the prompt) is owned by `agentStore.processQueuedItem`, the only place that
 * knows WHY it failed. The rejection is logged here so it has an owner.
 *
 * @returns Whether the item was dispatched. False leaves it in the queue.
 */
export function sendQueuedItemNow(
	sessionId: string,
	itemId: string,
	dispatch: QueuedItemDispatcher = dispatchThroughStore
): boolean {
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	const item = session?.executionQueue?.find((i) => i.id === itemId);
	if (!session || !item) return false;

	const { targetTabBusy, otherBusyTabs } = getQueueBusyContext(session, item);
	if (targetTabBusy) return false;
	// Without the dispatch deps nothing could run it: leave it for the queue.
	if (dispatch === dispatchThroughStore && !getDispatchDeps()) return false;

	const dispatchItem: QueuedItem =
		otherBusyTabs.length > 0 ? { ...item, forceParallel: true } : item;
	updateSessionWith(sessionId, (s) => applyQueuedItemDispatch(s, dispatchItem));
	dispatch(sessionId, dispatchItem).catch((err) => {
		logger.error('[ForceSend] Dispatch failed, item returned to queue', undefined, err);
	});
	return true;
}
