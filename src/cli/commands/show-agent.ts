// Show agent command
// Displays detailed information about a specific agent including history and usage stats.
// A `peer:agent` target (Federation) reads the agent from that peer's host instead, in the same
// shape: History lives on the host and the bridge does not carry it, so `stats` is null there.

import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import type { SessionInfo } from '../../shared/types';
import { getSessionById, readHistory, readGroups } from '../services/storage';
import { formatAgentDetail, formatError } from '../output/formatter';
import { readAgentSessionSettings } from '../services/agent-settings';
import {
	PeerResolveError,
	peerErrorCode,
	routeAgentTarget,
	withPeerAgent,
	type PeerTarget,
} from '../services/peer-resolver';
import { ExitCode } from '../exit-codes';

interface ShowAgentOptions {
	json?: boolean;
}

export function showAgent(agentId: string, options: ShowAgentOptions): void | Promise<void> {
	const route = routeAgentTarget(agentId);
	if (route.kind === 'peer') return showPeerAgent(route.target, options);
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

		const output = {
			id: agent.id,
			name: agent.name,
			toolType: agent.toolType,
			cwd: agent.cwd,
			projectRoot: agent.projectRoot,
			groupId: agent.groupId,
			groupName: group?.name,
			autoRunFolderPath: agent.autoRunFolderPath,
			// Where this agent's worktrees go (Git menu -> Configure Worktrees).
			// Null when unset; `create-worktree` then picks the desktop default.
			worktreeBasePath: agent.worktreeConfig?.basePath ?? null,
			// Editable per-agent settings (the Edit Agent modal fields) so callers
			// can read the full config without parsing raw store files.
			...readAgentSessionSettings(agent),
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

/** A host tab as `show agent` lists it, so a turn started from here can be found again. */
interface PeerTabRow {
	id: string;
	name: string | null;
	state: 'idle' | 'busy';
	agentSessionId: string | null;
}

/** The peer's agent in the local output shape, plus `peer` and its tabs. */
function peerAgentOutput(agent: AgentRecord, peer: string, groupName: string | undefined) {
	const worktree = agent.worktreeConfig as { basePath?: string } | undefined;
	const tabs: PeerTabRow[] = (agent.aiTabs ?? []).map((tab) => ({
		id: tab.id,
		name: tab.name ?? null,
		state: tab.state === 'busy' ? 'busy' : 'idle',
		agentSessionId: tab.agentSessionId ?? null,
	}));
	return {
		id: agent.id,
		name: agent.name,
		toolType: agent.toolType,
		cwd: agent.cwd ?? '',
		projectRoot: agent.projectRoot ?? agent.cwd ?? '',
		groupId: agent.groupId,
		groupName,
		autoRunFolderPath: agent.autoRunFolderPath,
		worktreeBasePath: worktree?.basePath ?? null,
		// The record mirrors the persisted `Session` fields these settings are read from; every
		// one is optional and read with a null default, so a field the host did not send is unset.
		...readAgentSessionSettings(agent as unknown as SessionInfo),
		peer,
		activeTabId: agent.activeTabId ?? null,
		tabs,
		stats: null,
		recentHistory: [],
	};
}

async function showPeerAgent(target: PeerTarget, options: ShowAgentOptions): Promise<void> {
	try {
		const output = await withPeerAgent(target, async ({ agent, client, peer }) => {
			// The group name is a label only: a host that cannot list its groups still shows the agent.
			let groupName: string | undefined;
			if (agent.groupId) {
				const groups = await client.groups.list();
				if (groups.ok) groupName = groups.value.find((g) => g.id === agent.groupId)?.name;
			}
			return peerAgentOutput(agent, peer, groupName);
		});
		if (options.json) {
			console.log(JSON.stringify(output, null, 2));
		} else {
			console.log(formatAgentDetail(output));
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		const peerError = error instanceof PeerResolveError ? error : undefined;
		if (options.json) {
			console.error(
				JSON.stringify({
					error: message,
					...(peerError ? { code: peerErrorCode(peerError.code), peer: peerError.peer } : {}),
				})
			);
		} else {
			console.error(formatError(message));
		}
		process.exit(peerError?.exitCode ?? ExitCode.GeneralError);
	}
}
