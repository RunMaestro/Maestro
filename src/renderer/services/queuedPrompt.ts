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
import { getActiveTab, getTabDisplayName } from '../utils/tabHelpers';
import { captureQueuedTurnSettings } from '../utils/providerTabSessions';
import { planCrossAgentMentions } from './crossAgentMentions';
import { generateId } from '../utils/ids';

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
 * Queue a prompt for one tab of one agent, reading both from the store.
 *
 * `tabId` names the tab the prompt belongs to. An id that no longer resolves
 * falls back to the agent's active tab rather than dropping the prompt: the
 * caller has already decided this agent should be asked something, and losing
 * that because a tab moved is worse than answering it in the tab next door.
 *
 * @returns The queued item, or null when the agent is gone or has no AI tab.
 */
export function enqueuePromptForTab(options: {
	sessionId: string;
	tabId: string;
	text: string;
	images?: string[];
}): QueuedItem | null {
	const { sessionId, tabId, text, images } = options;
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	if (!session) return null;

	const tab = session.aiTabs?.find((t) => t.id === tabId) ?? getActiveTab(session);
	if (!tab) return null;

	const item = buildQueuedMessageItem({ session, tab, text, images });
	updateSessionWith(sessionId, (s) => ({
		...s,
		executionQueue: [...(s.executionQueue || []), item],
	}));
	return item;
}
