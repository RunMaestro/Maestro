/**
 * Usage statistics listener.
 * Forwards usage stats from AI responses, and hands group chat ones to the engine.
 */

import type { ProcessManager } from '../process-manager';
import { GROUP_CHAT_PREFIX, type ProcessListenerDependencies, type UsageStats } from './types';
import { appendUsageCapture } from './context-timeline-log';

/**
 * Sets up the usage listener for token/cost statistics.
 * Handles:
 * - Group chat participant and moderator usage (through the engine)
 * - Regular process usage forwarding to renderer
 */
export function setupUsageListener(
	processManager: ProcessManager,
	deps: Pick<ProcessListenerDependencies, 'safeSend' | 'groupChatEngine'>
): void {
	const { safeSend, groupChatEngine } = deps;

	// Handle usage statistics from AI responses
	processManager.on('usage', (sessionId: string, usageStats: UsageStats) => {
		// Group chat usage belongs to the engine: it folds the event into the turn's ledger and updates
		// the participant's or the moderator's card (`usageReported`; the headless runtime calls the
		// same one). Fast path: skip the engine for non-group-chat sessions.
		if (sessionId.startsWith(GROUP_CHAT_PREFIX)) {
			groupChatEngine.usageReported(sessionId, usageStats);
		}

		// Record the RAW capture before it goes out, and stamp the assigned seq
		// onto the very payload renderers receive. A renderer hydrating from the
		// main-side log can then dedup live events against hydrated ones by seq
		// instead of guessing (finding S1). Group-chat sessions flow through here
		// too; they simply never match an agent base session on retrieval.
		usageStats.captureSeq = appendUsageCapture(sessionId, usageStats);

		safeSend('process:usage', sessionId, usageStats);
	});
}
