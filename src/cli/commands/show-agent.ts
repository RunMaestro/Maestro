// Show agent command
// Displays detailed information about a specific agent including history and usage stats

import { getSessionById, readHistory, readGroups } from '../services/storage';
import { formatAgentDetail, formatError } from '../output/formatter';
import { getClaudeTokenMode } from '../../shared/claudeTokenMode';

interface ShowAgentOptions {
	json?: boolean;
}

export function showAgent(agentId: string, options: ShowAgentOptions): void {
	try {
		const agent = getSessionById(agentId);

		if (!agent) {
			throw new Error(`Agent not found: ${agentId}`);
		}

		// Get group name if agent belongs to a group
		const groups = readGroups();
		const group = agent.groupId ? groups.find((g) => g.id === agent.groupId) : undefined;

		// Get history entries for this agent
		const history = readHistory(undefined, agent.id);

		// Calculate aggregate stats from history
		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		let totalCacheReadTokens = 0;
		let totalCacheCreationTokens = 0;
		let totalCost = 0;
		let totalElapsedMs = 0;
		let successCount = 0;
		let failureCount = 0;

		for (const entry of history) {
			if (entry.usageStats) {
				totalInputTokens += entry.usageStats.inputTokens || 0;
				totalOutputTokens += entry.usageStats.outputTokens || 0;
				totalCacheReadTokens += entry.usageStats.cacheReadInputTokens || 0;
				totalCacheCreationTokens += entry.usageStats.cacheCreationInputTokens || 0;
				totalCost += entry.usageStats.totalCostUsd || 0;
			}
			if (entry.elapsedTimeMs) {
				totalElapsedMs += entry.elapsedTimeMs;
			}
			if (entry.success === true) {
				successCount++;
			} else if (entry.success === false) {
				failureCount++;
			}
		}

		// Get recent history (last 10 entries)
		const recentHistory = history.sort((a, b) => b.timestamp - a.timestamp).slice(0, 10);

		// Resolve the Claude token source to the friendly tri-state (api | tui via
		// 'interactive' | dynamic) the Edit Agent modal shows. SSH enablement flips
		// the default for an unconfigured agent, so pass it through.
		const tokenSource = getClaudeTokenMode(
			{ enableMaestroP: agent.enableMaestroP, maestroPMode: agent.maestroPMode },
			{ sshEnabled: agent.sessionSshRemoteConfig?.enabled === true }
		);

		const output = {
			id: agent.id,
			name: agent.name,
			toolType: agent.toolType,
			cwd: agent.cwd,
			projectRoot: agent.projectRoot,
			groupId: agent.groupId,
			groupName: group?.name,
			autoRunFolderPath: agent.autoRunFolderPath,
			// Editable per-agent settings (the Edit Agent modal fields) so callers
			// can read the full config without parsing raw store files.
			nudgeMessage: agent.nudgeMessage ?? null,
			newSessionMessage: agent.newSessionMessage ?? null,
			customPath: agent.customPath ?? null,
			customArgs: agent.customArgs ?? null,
			customEnvVars: agent.customEnvVars ?? null,
			customModel: agent.customModel ?? null,
			customEffort: agent.customEffort ?? null,
			customContextWindow: agent.customContextWindow ?? null,
			// Claude token source: friendly tri-state plus the raw stored pair.
			tokenSource: agent.toolType === 'claude-code' ? tokenSource : null,
			enableMaestroP: agent.enableMaestroP ?? null,
			maestroPMode: agent.maestroPMode ?? null,
			maestroPPath: agent.maestroPPath ?? null,
			// Full SSH execution config so onboarding/verification can confirm the
			// agent's remote, working-dir override, and history-sync state without
			// reading raw store files.
			sessionSshRemoteConfig: agent.sessionSshRemoteConfig ?? null,
			stats: {
				historyEntries: history.length,
				successCount,
				failureCount,
				totalInputTokens,
				totalOutputTokens,
				totalCacheReadTokens,
				totalCacheCreationTokens,
				totalCost,
				totalElapsedMs,
			},
			recentHistory: recentHistory.map((entry) => ({
				id: entry.id,
				type: entry.type,
				timestamp: entry.timestamp,
				summary: entry.summary,
				success: entry.success,
				elapsedTimeMs: entry.elapsedTimeMs,
				cost: entry.usageStats?.totalCostUsd,
			})),
		};

		if (options.json) {
			console.log(JSON.stringify(output, null, 2));
		} else {
			console.log(formatAgentDetail(output));
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		if (options.json) {
			console.error(JSON.stringify({ error: message }));
		} else {
			console.error(formatError(message));
		}
		process.exit(1);
	}
}
