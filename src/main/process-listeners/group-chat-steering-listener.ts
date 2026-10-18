/**
 * @file group-chat-steering-listener.ts
 * @description Settles group chat steers once their turn says what it did with them.
 *
 * A steer is answered twice (see SteeringVerdict in src/shared/chatSteering.ts):
 * the socket says "delivered" at once, and the turn's transcript says later
 * whether it was absorbed, taken as a follow-up, or dropped. Tab steers are
 * settled in the renderer, which owns their queue. A group chat's queue lives in
 * MAIN, so its steers are settled here: a steer no turn took goes back in the
 * queue instead of being lost.
 *
 * The renderer still receives `process:steering-verdict` for these process ids
 * and ignores them: it only acts on steers it is waiting for.
 */

import type { ProcessManager } from '../process-manager';
import type { SteeringResultFrame } from '../../shared/chatSteering';
import { GROUP_CHAT_PREFIX } from './types';
import {
	groupChatSteeringVerdict,
	unsettledGroupChatSteersOnExit,
} from '../group-chat/group-chat-router';
import { returnSteeredMessage } from '../group-chat/group-chat-queue';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';

const LOG_CONTEXT = '[GroupChatSteering]';

function returnToQueue(
	steer: { groupChatId: string; text: string; readOnly: boolean },
	held: boolean
): void {
	returnSteeredMessage(steer.groupChatId, steer, held).catch((err) => {
		// The user's words are at stake, so this is reported, not just logged.
		logger.error('Could not return a steered message to the queue', LOG_CONTEXT, {
			groupChatId: steer.groupChatId,
			error: err instanceof Error ? err.message : String(err),
		});
		void captureException(err, {
			operation: 'groupChat:returnSteer',
			groupChatId: steer.groupChatId,
		});
	});
}

export function setupGroupChatSteeringListener(processManager: ProcessManager): void {
	processManager.on('steering-verdict', (sessionId: string, verdict: SteeringResultFrame) => {
		if (!sessionId.startsWith(GROUP_CHAT_PREFIX)) return;
		const returned = groupChatSteeringVerdict(sessionId, verdict);
		// The turn said it never took it, so it is safe to send again.
		if (returned) returnToQueue(returned, false);
	});

	processManager.on('exit', (sessionId: string) => {
		if (!sessionId.startsWith(GROUP_CHAT_PREFIX)) return;
		// Nobody knows whether these were seen, so they come back held.
		for (const steer of unsettledGroupChatSteersOnExit(sessionId)) returnToQueue(steer, true);
	});
}
