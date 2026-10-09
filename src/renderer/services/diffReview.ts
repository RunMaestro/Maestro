/**
 * Ship a batch of diff annotations back to the agent that produced the diff.
 *
 * The review is QUEUED into the agent's active AI tab rather than spawned, the
 * same shape the composer builds when the agent is busy: an idle agent picks it
 * up on the queue's next drain, and a busy one runs it when the current turn
 * ends, so a review never interrupts work in progress.
 *
 * Pending annotations are also parked here per repo, so closing the diff viewer
 * (an Escape pressed out of habit) does not throw away a half-written review.
 */
import type { Session } from '../types';
import type { DiffAnnotation } from '../utils/diffAnnotations';
import { useSessionStore, updateSessionWith } from '../stores/sessionStore';
import { getActiveTab, getTabDisplayName } from '../utils/tabHelpers';
import { captureQueuedTurnSettings } from '../utils/providerTabSessions';
import { generateId } from '../utils/ids';
import { jumpToAgent } from './agentNavigation';
import { notifyCenterFlash } from '../stores/centerFlashStore';

const pendingByRepo = new Map<string, DiffAnnotation[]>();

/** Annotations left on this repo's diff and not yet sent. */
export function getPendingDiffAnnotations(repo: string): DiffAnnotation[] {
	return pendingByRepo.get(repo) ?? [];
}

/** Park (or, with an empty list, forget) the annotations for this repo. */
export function setPendingDiffAnnotations(repo: string, annotations: DiffAnnotation[]): void {
	if (annotations.length === 0) pendingByRepo.delete(repo);
	else pendingByRepo.set(repo, annotations);
}

/**
 * The agent a diff review goes to: the one the diff was taken for, else the
 * active agent. Terminal-only agents have no conversation to send it to.
 */
export function resolveDiffReviewTarget(
	sessions: readonly Session[],
	activeSessionId: string,
	diffSessionId?: string | null
): Session | undefined {
	const id = diffSessionId || activeSessionId;
	const session = sessions.find((s) => s.id === id);
	if (!session || session.toolType === 'terminal') return undefined;
	return session;
}

/**
 * Queue `prompt` into the agent's active AI tab and bring that tab on screen.
 *
 * @returns `false` when the agent or its AI tab no longer exists.
 */
export function sendDiffReviewToAgent(sessionId: string, prompt: string): boolean {
	if (!prompt.trim()) return false;
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	if (!session) return false;
	const tab = getActiveTab(session);
	if (!tab) return false;

	updateSessionWith(sessionId, (s) => ({
		...s,
		executionQueue: [
			...s.executionQueue,
			{
				id: generateId(),
				timestamp: Date.now(),
				tabId: tab.id,
				type: 'message',
				text: prompt,
				tabName: getTabDisplayName(tab),
				readOnlyMode: tab.readOnlyMode === true,
				turnSettings: captureQueuedTurnSettings(tab, s),
			},
		],
	}));

	// Sending the review is the user asking to watch the agent work on it.
	jumpToAgent(sessionId, { tabId: tab.id });
	notifyCenterFlash({
		message: `Review sent to ${session.name}`,
		detail: session.state === 'busy' ? 'Queued behind the current turn' : undefined,
		color: 'green',
	});
	return true;
}
