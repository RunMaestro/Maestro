/**
 * crossAgentAsk - the CLI's face of the cross-agent consult (`maestro-cli ask`).
 *
 * An agent that wants another agent's opinion had exactly one verb before this:
 * `dispatch`, which writes into the target's ACTIVE tab. That drops a question
 * into the middle of whatever conversation the human has open there, and the
 * answer goes to the screen rather than back to the agent that asked. This is
 * the same consult a typed `@mention` performs - a hidden tab on the target,
 * fresh context, no focus, no unread - with the answer returned to the caller
 * instead of streamed into a chat bubble.
 *
 * It is deliberately a thin resolver over {@link sendCrossAgentRequest} rather
 * than a second dispatch path: continuity (the per-caller consult tab and its
 * resumed provider session), history attribution, cancellation, and the SSH /
 * token-mode spawn rules all live there, and a parallel implementation would
 * drift off every one of them.
 */

import { useSessionStore } from '../stores/sessionStore';
import { getActiveTab } from '../utils/tabHelpers';
import {
	sendCrossAgentRequest,
	type CrossAgentCompletion,
} from '../hooks/agent/useCrossAgentDispatch';
import type { LogEntry } from '../types';

/**
 * Stand-in source tab id for a consult nobody typed. The consult tab on the
 * target is keyed by (source agent, source tab), so a constant here means one
 * consult tab per CALLING AGENT rather than one per tab the agent happened to
 * have selected - which is what makes a follow-up `ask` resume the earlier
 * conversation instead of starting over. It matches no real tab on purpose:
 * the answer belongs to the caller's tool result, not to its transcript, so the
 * attribution-bubble write finds no tab and harmlessly no-ops.
 */
export const CROSS_AGENT_ASK_TAB_ID = 'cli-ask';

/**
 * Stand-in source agent id used when the caller does not name itself. Consults
 * from unattributed callers share one consult tab on each target.
 */
export const CROSS_AGENT_ASK_SESSION_ID = 'cli-ask';

/** Display name for an unattributed caller (names the target's consult tab). */
const CROSS_AGENT_ASK_FALLBACK_NAME = 'CLI';

export interface CrossAgentAskRequest {
	/** The agent to consult. */
	targetSessionId: string;
	/** The self-contained question. */
	question: string;
	/**
	 * The agent doing the asking. Optional, but worth passing: it names the
	 * consult tab on the target, keys the continuity, forwards the caller's cwd
	 * so the target may read the caller's project, and makes Stop on the caller
	 * cancel the consult.
	 */
	fromSessionId?: string;
	/**
	 * Forward the caller's active-tab transcript as context. Off by default -
	 * `ask` exists to send a fresh, self-contained question, and a relayed
	 * transcript is what `@mention` is for.
	 */
	withContext?: boolean;
}

export interface CrossAgentAskResult {
	success: boolean;
	/** The target's answer. Present (possibly partial) even when `success` is false. */
	answer?: string;
	error?: string;
	/** The user pressed Stop on the calling agent. Not a failure of the target. */
	canceled?: boolean;
	/** Display name of the consulted agent, for the caller's own reporting. */
	targetAgentName?: string;
	/** The hidden consult tab on the target that holds the persisted exchange. */
	targetTabId?: string;
}

/**
 * Consult `targetSessionId` and resolve with its answer.
 *
 * Resolves rather than rejects on every outcome, including a missing target: the
 * caller is a CLI process reporting to an agent, and an exception there reads as
 * a broken command instead of "that agent could not answer".
 */
export function runCrossAgentAsk(request: CrossAgentAskRequest): Promise<CrossAgentAskResult> {
	const sessions = useSessionStore.getState().sessions;
	const target = sessions.find((s) => s.id === request.targetSessionId);
	if (!target) {
		return Promise.resolve({
			success: false,
			error: `Agent ${request.targetSessionId} not found`,
		});
	}
	if (request.fromSessionId && request.fromSessionId === request.targetSessionId) {
		return Promise.resolve({
			success: false,
			error: 'An agent cannot consult itself',
			targetAgentName: target.name,
		});
	}

	const source = request.fromSessionId
		? sessions.find((s) => s.id === request.fromSessionId)
		: undefined;

	// Only forwarded when explicitly asked for; `selectContextWindow` inside
	// `sendCrossAgentRequest` narrows it the same way a typed mention's would be.
	const sourceLogs: LogEntry[] =
		request.withContext && source ? (getActiveTab(source)?.logs ?? []) : [];

	return new Promise<CrossAgentAskResult>((resolve) => {
		const finish = (completion: CrossAgentCompletion) => {
			resolve({
				success: !completion.error && !completion.canceled,
				answer: completion.text || undefined,
				error: completion.error,
				canceled: completion.canceled,
				targetAgentName: target.name,
				targetTabId: completion.targetTabId,
			});
		};

		sendCrossAgentRequest({
			sourceSessionId: source?.id ?? CROSS_AGENT_ASK_SESSION_ID,
			sourceAgentName: source?.name ?? CROSS_AGENT_ASK_FALLBACK_NAME,
			sourceTabId: CROSS_AGENT_ASK_TAB_ID,
			targetSessionId: request.targetSessionId,
			userPrompt: request.question,
			sourceLogs,
			sourceCwd: source?.cwd,
			onComplete: finish,
		});
	});
}
