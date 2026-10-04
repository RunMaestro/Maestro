/**
 * diffReview - hand a review left in the Git Diff viewer to the agent the diff
 * was taken for (issue #1475).
 *
 * Two ways out, both self-sourcing from the stores so the viewer needs no
 * callbacks threaded through the modal host:
 *
 * - `sendDiffReview` QUEUES the review into the agent's AI tab through
 *   `enqueuePromptForTab`, the path the CLI's `dispatch --queue` and a snooze's
 *   wake prompt use. An idle agent runs it on the queue's next drain and a busy
 *   one when its turn ends, so a review never interrupts work in progress.
 * - `editDiffReviewInComposer` appends the review to that tab's draft through
 *   `insertIntoAgentComposer`, for a user who wants to reword it or add a note
 *   before it goes.
 *
 * Both land the user on the tab the review went to: sending a review is asking
 * to watch the agent act on it.
 */

import type { Session } from '../types';
import { useSessionStore, updateSessionWith } from '../stores/sessionStore';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import { notifyToast } from '../stores/notificationStore';
import { enqueuePromptForTab } from './queuedPrompt';
import { insertIntoAgentComposer, resolveComposerTarget } from './quoteIntoComposer';
import { jumpToAgent } from './agentNavigation';

/**
 * Whether an agent can receive a diff review. Terminal-only agents have no
 * conversation to send it to.
 */
export function canReceiveDiffReview(
	session: Pick<Session, 'toolType'> | null | undefined
): boolean {
	return !!session && session.toolType !== 'terminal';
}

/**
 * Bring the agent on screen at `tabId`. When the agent is already on screen in
 * a tiled group, the tab is made active without leaving the group, the same
 * rule Quote in Message follows. A jump from another agent always lands on a
 * standalone tab (`jumpToAgent` leaves any group).
 */
function revealReviewTab(sessionId: string, tabId: string, inGroup: boolean): void {
	if (inGroup && useSessionStore.getState().activeSessionId === sessionId) {
		updateSessionWith(sessionId, (s) => ({ ...s, activeTabId: tabId }));
		return;
	}
	jumpToAgent(sessionId, { tabId });
}

/**
 * Queue `prompt` for the agent's AI tab and bring that tab on screen.
 *
 * @returns `false` (and says why in a toast) when the agent or its AI tab no
 * longer exists, so the caller keeps the comments.
 */
export function sendDiffReview(sessionId: string, prompt: string): boolean {
	if (!prompt.trim()) return false;
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	const target = session && canReceiveDiffReview(session) ? resolveComposerTarget(session) : null;
	const item = target
		? enqueuePromptForTab({ sessionId, tabId: target.tabId, text: prompt })
		: null;
	if (!session || !target || !item) {
		notifyToast({
			color: 'red',
			title: 'Review Not Sent',
			message: session
				? `${session.name} has no AI tab to receive the review. Your comments are kept.`
				: 'The agent this diff belongs to no longer exists. Your comments are kept.',
		});
		return false;
	}

	revealReviewTab(sessionId, item.tabId, target.inGroup);
	notifyCenterFlash({
		message: `Review sent to ${session.name}`,
		detail: session.state === 'busy' ? 'Queued behind the current turn' : undefined,
		color: 'green',
	});
	return true;
}

/**
 * Put `prompt` in the agent's composer for editing instead of sending it.
 *
 * @returns `false` when there is no AI tab to put it in (the composer helper
 * toasts), so the caller keeps the comments.
 */
export function editDiffReviewInComposer(sessionId: string, prompt: string): boolean {
	if (!prompt.trim()) return false;
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	if (!session || !canReceiveDiffReview(session)) {
		notifyToast({
			color: 'red',
			title: 'No Composer to Fill',
			message: 'The agent this diff belongs to cannot take a review. Your comments are kept.',
		});
		return false;
	}
	// The composer only renders for the active agent: switch first, then fill.
	if (useSessionStore.getState().activeSessionId !== sessionId) jumpToAgent(sessionId);
	return insertIntoAgentComposer(sessionId, prompt);
}
