/**
 * Report a delivered CLI dispatch to the calling agent's transcript.
 *
 * Shared by the three dispatch paths (`send_command`, `new_ai_tab_with_prompt`,
 * `enqueue_command`) so they cannot disagree about when a hand-off is worth a
 * pill. Called only once the renderer has ACCEPTED the prompt: a rejected or
 * failed dispatch delegated nothing, and a pill for it would claim otherwise.
 *
 * `maestro-cli ask` is not routed here. The renderer owns that consult end to
 * end and records its own pill, because only it learns the answer's outcome.
 */

import { captureException } from '../../../utils/sentry';
import { isSelfDispatch, readCallerMessageFields } from '../../../../shared/agentDelegation';
import type { MessageHandlerContext, WebClientMessage } from './types';

export interface DeliveredDispatch {
	targetSessionId: string;
	targetTabId?: string;
	prompt: string;
	newTab?: boolean;
	queued?: boolean;
}

export function noteDispatchDelegation(
	ctx: MessageHandlerContext,
	message: WebClientMessage,
	dispatch: DeliveredDispatch
): void {
	// No caller means a human or an external script sent it: nothing to attribute.
	const caller = readCallerMessageFields(message);
	if (!caller || !ctx.callbacks.noteAgentDelegation) return;
	if (isSelfDispatch(caller, dispatch.targetSessionId, dispatch.targetTabId)) return;

	try {
		ctx.callbacks.noteAgentDelegation({ kind: 'dispatch', ...caller, ...dispatch });
	} catch (error) {
		// The prompt is already delivered and its result already sent. A pill that
		// failed to draw must not turn that into a reported failure, but it is
		// still a bug worth seeing.
		void captureException(error, { area: 'web-server', handler: 'note_agent_delegation' });
	}
}
