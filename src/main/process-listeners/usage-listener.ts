/**
 * Usage statistics listener.
 * Handles usage stats from AI responses, including group chat participant/moderator updates.
 */

import type { ProcessManager } from '../process-manager';
import { GROUP_CHAT_PREFIX, type ProcessListenerDependencies, type UsageStats } from './types';

/**
 * Sets up the usage listener for token/cost statistics.
 * Handles:
 * - Group chat participant usage updates
 * - Group chat moderator usage updates
 * - Regular process usage forwarding to renderer
 */
export function setupUsageListener(
	processManager: ProcessManager,
	deps: Pick<
		ProcessListenerDependencies,
		| 'broadcastToAllWindows'
		| 'outputParser'
		| 'groupChatEmitters'
		| 'groupChatStorage'
		| 'usageAggregator'
		| 'logger'
		| 'patterns'
	>
): void {
	const {
		broadcastToAllWindows,
		outputParser,
		groupChatEmitters,
		groupChatStorage,
		usageAggregator,
		logger,
		patterns,
	} = deps;
	const { REGEX_MODERATOR_SESSION } = patterns;

	// Handle usage statistics from AI responses
	processManager.on('usage', (sessionId: string, usageStats: UsageStats) => {
		// Fast path: skip regex for non-group-chat sessions (performance optimization)
		const isGroupChatSession = sessionId.startsWith(GROUP_CHAT_PREFIX);

		// Handle group chat participant usage - update participant stats
		const participantUsageInfo = isGroupChatSession
			? outputParser.parseParticipantSessionId(sessionId)
			: null;
		if (participantUsageInfo) {
			const { groupChatId, participantName } = participantUsageInfo;

			// Calculate context usage percentage using agent-specific logic
			// Note: For group chat, we don't have agent type here, defaults to Claude behavior
			const totalContextTokens = usageAggregator.calculateContextTokens(usageStats);
			const effectiveWindow = usageStats.contextWindow > 0 ? usageStats.contextWindow : 200000;

			// Skip update if values are accumulated (total > window) from multi-tool turns
			const contextUsage =
				totalContextTokens <= effectiveWindow
					? Math.round((totalContextTokens / effectiveWindow) * 100)
					: -1; // -1 signals "skip update"

			// Update participant with usage stats (skip context update if accumulated)
			const updateData: {
				contextUsage?: number;
				tokenCount?: number;
				totalCost: number;
			} = {
				totalCost: usageStats.totalCostUsd,
			};
			if (contextUsage >= 0) {
				updateData.contextUsage = contextUsage;
				updateData.tokenCount = totalContextTokens;
			}

			groupChatStorage
				.updateParticipant(groupChatId, participantName, updateData)
				.then((updatedChat) => {
					// Emit participants changed so UI updates
					// Note: updateParticipant returns the updated chat, avoiding extra DB read
					groupChatEmitters.emitParticipantsChanged?.(groupChatId, updatedChat.participants);
				})
				.catch((err) => {
					logger.error('[GroupChat] Failed to update participant usage', 'ProcessListener', {
						error: String(err),
						participant: participantName,
					});
				});
			// Still send to renderer for consistency
		}

		// Handle group chat moderator usage - emit for UI
		const moderatorUsageMatch = isGroupChatSession
			? sessionId.match(REGEX_MODERATOR_SESSION)
			: null;
		if (moderatorUsageMatch) {
			const groupChatId = moderatorUsageMatch[1];
			// Calculate context usage percentage using agent-specific logic
			// Note: Moderator is typically Claude, defaults to Claude behavior
			const totalContextTokens = usageAggregator.calculateContextTokens(usageStats);
			const effectiveWindow = usageStats.contextWindow > 0 ? usageStats.contextWindow : 200000;

			// Skip context update if values are accumulated (total > window) from multi-tool turns.
			// When accumulated, emit with contextUsage/tokenCount as -1 so the handler
			// knows to preserve the previous values. Cost is always updated.
			if (totalContextTokens <= effectiveWindow) {
				const contextUsage = Math.round((totalContextTokens / effectiveWindow) * 100);
				groupChatEmitters.emitModeratorUsage?.(groupChatId, {
					contextUsage,
					totalCost: usageStats.totalCostUsd,
					tokenCount: totalContextTokens,
				});
			} else {
				groupChatEmitters.emitModeratorUsage?.(groupChatId, {
					contextUsage: -1,
					totalCost: usageStats.totalCostUsd,
					tokenCount: -1,
				});
			}
		}

		broadcastToAllWindows('process:usage', sessionId, usageStats);
	});
}
