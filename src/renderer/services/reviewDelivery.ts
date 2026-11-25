/**
 * reviewDelivery - the two ways a finished review reaches its agent, shared by
 * the Git Diff review (`diffReview.ts`) and the File Preview review
 * (`fileReview.ts`).
 *
 * Both self-source from the stores, so a view needs no callbacks threaded
 * through its host:
 *
 * - `sendReviewPrompt` QUEUES the review into the agent's AI tab through
 *   `enqueuePromptForTab`, the path the CLI's `dispatch --queue` and a snooze's
 *   wake prompt use. An idle agent runs it on the queue's next drain and a busy
 *   one when its turn ends, so a review never interrupts work in progress.
 * - `editReviewPromptInComposer` appends the review to that tab's draft
 *   through `insertIntoAgentComposer`, for a user who wants to reword it or add
 *   a note before it goes.
 *
 * From a view both land the user on the tab the review went to: sending a
 * review is asking to watch the agent act on it. A CLI caller passing
 * `--background` gets the same delivery with nothing moved.
 */

import type { Session } from '../types';
import { useSessionStore } from '../stores/sessionStore';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import { notifyToast } from '../stores/notificationStore';
import { enqueuePromptForTab } from './queuedPrompt';
import { insertIntoAgentComposer, resolveComposerTarget } from './quoteIntoComposer';
import { jumpToAgent } from './agentNavigation';

/**
 * Whether an agent can receive a review. Terminal-only agents have no
 * conversation to send it to.
 */
export function canReceiveReview(session: Pick<Session, 'toolType'> | null | undefined): boolean {
	return !!session && session.toolType !== 'terminal';
}

/** How a review is handed over, and whether the user is taken to it. */
export interface ReviewDeliveryOptions {
	/** Write it and move nothing: no agent or tab switch, no flash. */
	background?: boolean;
}

/** Which of the two ways out a delivery takes. */
export type ReviewDeliveryMode = 'send' | 'compose';

/**
 * Queue `prompt` for the agent's AI tab and bring that tab on screen (inside
 * its tiled group when it is a pane of one).
 *
 * @returns `false` (and says why in a toast) when the agent or its AI tab no
 * longer exists, so the caller keeps the comments.
 */
export function sendReviewPrompt(
	sessionId: string,
	prompt: string,
	options: ReviewDeliveryOptions = {}
): boolean {
	if (!prompt.trim()) return false;
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	const target = session && canReceiveReview(session) ? resolveComposerTarget(session) : null;
	const item = target
		? enqueuePromptForTab({ sessionId, tabId: target.tabId, text: prompt })
		: null;
	if (!session || !target || !item) {
		notifyToast({
			color: 'red',
			title: 'Review Not Sent',
			message: session
				? `${session.name} has no AI tab to receive the review. Your comments are kept.`
				: 'The agent this review was written for no longer exists. Your comments are kept.',
		});
		return false;
	}

	if (options.background) return true;
	jumpToAgent(sessionId, { tabId: item.tabId, stayInTiledGroup: true });
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
export function editReviewPromptInComposer(
	sessionId: string,
	prompt: string,
	options: ReviewDeliveryOptions = {}
): boolean {
	if (!prompt.trim()) return false;
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	if (!session || !canReceiveReview(session)) {
		notifyToast({
			color: 'red',
			title: 'No Composer to Fill',
			message: 'The agent this review was written for cannot take it. Your comments are kept.',
		});
		return false;
	}
	// The helper switches to the agent (keeping its tiled group) unless this is
	// a background delivery, which only writes the tab's draft.
	return (
		insertIntoAgentComposer(sessionId, prompt, {
			format: 'block',
			reveal: !options.background,
			missingTabMessage: 'This agent has no AI tab. Open one, then send the review again.',
		}) !== null
	);
}

/** Hand `prompt` over the way `mode` names. */
export function deliverReviewPrompt(
	mode: ReviewDeliveryMode,
	sessionId: string,
	prompt: string,
	options: ReviewDeliveryOptions = {}
): boolean {
	return mode === 'compose'
		? editReviewPromptInComposer(sessionId, prompt, options)
		: sendReviewPrompt(sessionId, prompt, options);
}

export type ReviewDeliveryResult<C> =
	| { ok: true; delivered: C[]; outdated: C[]; prompt: string }
	| { ok: false; error: string; outdated: C[] };

/**
 * Deliver one review's pending comments: every comment that is current and has
 * text goes into one prompt, outdated ones stay behind (flagged, never sent),
 * and only what was actually delivered is forgotten (`forget`), so a failed
 * delivery keeps everything.
 */
export function deliverPendingReview<C extends { id: string; body: string }>({
	sessionId,
	comments,
	outdatedIds,
	formatPrompt,
	forget,
	mode,
	background,
}: {
	sessionId: string;
	comments: readonly C[];
	outdatedIds: ReadonlySet<string>;
	formatPrompt: (current: C[]) => string;
	/** Drop the delivered comments from the store. */
	forget: (ids: string[]) => void;
	mode: ReviewDeliveryMode;
	background?: boolean;
}): ReviewDeliveryResult<C> {
	const outdated = comments.filter((c) => outdatedIds.has(c.id));
	const current = comments.filter((c) => !outdatedIds.has(c.id) && c.body.trim());
	const prompt = formatPrompt(current);
	if (!prompt) {
		return {
			ok: false,
			outdated,
			error:
				outdated.length > 0
					? 'Every pending comment is outdated: its lines changed since it was written'
					: 'There are no comments to send',
		};
	}
	if (!deliverReviewPrompt(mode, sessionId, prompt, { background })) {
		return { ok: false, outdated, error: 'The agent has no AI tab to receive the review' };
	}
	forget(current.map((c) => c.id));
	return { ok: true, delivered: current, outdated, prompt };
}
