/**
 * Session ID listener.
 * Forwards agent session ids to the renderer and hands group chat ones to the engine.
 */

import type { ProcessManager } from '../process-manager';
import { GROUP_CHAT_PREFIX, type ProcessListenerDependencies } from './types';

/**
 * Sets up the session-id listener.
 * Handles:
 * - Group chat participant and moderator session ids: the engine stores them where the chat can
 *   resume them and tells the UI (`sessionAnnounced`; the headless runtime calls the same one)
 * - Regular session ID forwarding to renderer
 */
export function setupSessionIdListener(
	processManager: ProcessManager,
	deps: Pick<ProcessListenerDependencies, 'safeSend' | 'groupChatEngine'>
): void {
	const { safeSend, groupChatEngine } = deps;

	processManager.on('session-id', (sessionId: string, agentSessionId: string) => {
		// Capture before any callback can finish the process and clear its receipt.
		// This scope belongs to the emitting launch, not the agent's current settings.
		const nativeSessionLaunch = processManager.nativeSessionLaunchOf(sessionId);

		// Fast path: skip the engine for non-group-chat sessions (performance optimization)
		if (sessionId.startsWith(GROUP_CHAT_PREFIX)) {
			void groupChatEngine.sessionAnnounced(sessionId, agentSessionId);
		}

		// Still send to renderer for logging purposes
		// Keep the observed and requested IDs separate: the consumer must refuse a
		// mismatched resume without replacing the retained conversation or its scope.
		if (nativeSessionLaunch) {
			safeSend('process:session-id', sessionId, agentSessionId, nativeSessionLaunch);
		} else {
			safeSend('process:session-id', sessionId, agentSessionId);
		}
	});
}
