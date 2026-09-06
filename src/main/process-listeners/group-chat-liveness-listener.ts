/**
 * @file group-chat-liveness-listener.ts
 * @description Feeds Group Chat's silence budgets proof that a turn is still working.
 *
 * The router supervises every moderator and participant turn with an idle
 * watchdog, but `IProcessManager` (its view of the process manager) is a
 * spawn/write/kill interface with no events on it - deliberately, so the router
 * does not grow a second output path beside the buffering one in the data
 * listener. This module is the bridge: it owns the only listeners that exist to
 * re-arm those budgets, and hands each session id straight to the router, which
 * ignores anything it does not recognize.
 *
 * `raw-stdout` is included on top of the shared liveness events because it is the
 * earliest and most frequent signal a group chat process produces, and the data
 * listener already proved it is the one that fires during work rather than at the
 * end of it.
 */

import type { ProcessManager } from '../process-manager';
import { GROUP_CHAT_PREFIX } from './types';
import { AGENT_LIVENESS_EVENTS } from '../utils/agent-liveness';
import { noteGroupChatActivity } from '../group-chat/group-chat-router';

export function setupGroupChatLivenessListener(processManager: ProcessManager): void {
	const note = (sessionId: string): void => {
		// Cheap prefix guard first: every process in the app emits these events and
		// only group chat sessions have a budget to re-arm.
		if (!sessionId.startsWith(GROUP_CHAT_PREFIX)) return;
		noteGroupChatActivity(sessionId);
	};

	for (const event of AGENT_LIVENESS_EVENTS) processManager.on(event, note);
	processManager.on('raw-stdout', note);
}
