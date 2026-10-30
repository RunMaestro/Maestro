// Show agent command
// Displays detailed information about a specific agent including history and usage stats

import {
	getSessionById,
	readHarnessTierDefaults,
	readHistory,
	readGroups,
	readAgentConfigValue,
	readLocalModelEndpoints,
	readSessions,
	readSettingValue,
} from '../services/storage';
import {
	isSecretEnvKey,
	maskEnvValue,
	resolveAgentEnvironment,
} from '../../shared/agentEnvironment';
import { gatewayEnvVarsFor } from '../../shared/local-models/gateway';
import { formatAgentDetail } from '../output/formatter';
import { getClaudeTokenMode } from '../../shared/claudeTokenMode';
import { resolveCodexTransport } from '../../shared/codexTransport';
import {
	formatRunOnSpec,
	parseRunOnTarget,
	runOnTargetLabel,
} from '../../shared/local-models/run-on';
import {
	formatBackgroundRequestsSpec,
	parseBackgroundRequests,
} from '../../shared/local-models/background-requests';
import { agentTierRows, tierHarnessProblem, tierRowRecord } from '../../shared/modelTiers';
import { describePeerConfiguration } from '../../shared/peerAgents';
import { failCommand } from '../services/session-command';
import { readAgentSessionSettings } from '../services/agent-settings';

interface ShowAgentOptions {
	json?: boolean;
	/** Print secret environment values in full instead of masked. */
	showSecrets?: boolean;
}

/** A record of environment variables, or undefined when a store holds something else. */
function asEnvRecord(value: unknown): Record<string, string> | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
	const entries = Object.entries(value).filter(
		(entry): entry is [string, string] => typeof entry[1] === 'string'
	);
	return Object.fromEntries(entries);
}

/**
 * A record with its secret values masked, the way the desktop's environment
 * table shows them: a credential's tail is enough to tell two keys apart and
 * not enough to use.
 */
function maskSecrets(
	vars: Record<string, string> | undefined,
	showSecrets: boolean | undefined
): Record<string, string> | null {
	if (!vars) return null;
	if (showSecrets) return vars;
	return Object.fromEntries(
		Object.entries(vars).map(([key, value]) => [
			key,
			isSecretEnvKey(key) ? maskEnvValue(value) : value,
		])
	);
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

		// Where the agent's model runs (the Models tab's Run on picker). An agent
		// with no stored target runs on its provider's model, which is a value, not
		// an unset field. A stored target that cannot be read is reported as it is
		// stored, with the reason: every launch of that agent is refused for it.
		const runOn = parseRunOnTarget(agent.runOn);
		const runOnSource = runOn.ok && runOn.target.type === 'source' ? runOn.target : undefined;
		const endpoints = readLocalModelEndpoints();

		// Where a low, medium or high task of this agent launches (the Models tab's
		// Tiers block), each with the layer the value comes from: the agent's own
		// target, the harness default, or the built-in table. It is the resolution
		// a launch runs, so a tier a launch would refuse carries the refusal. Empty
		// for a harness that cannot be told which model to run.
		const tiers = tierHarnessProblem(agent.toolType)
			? []
			: agentTierRows(
					{ toolType: agent.toolType, tierTargets: agent.tierTargets, runOn: agent.runOn },
					readHarnessTierDefaults()
				).map((row) => tierRowRecord(row, endpoints));

		// Where the token proxy sends this agent's side requests. No stored target
		// is a value (`none`: every request goes to the provider). A stored value
		// that cannot be read fails every background request, and is reported so.
		const background = parseBackgroundRequests(agent.backgroundRequests);
		const backgroundTarget = background.ok ? background.backgroundRequests?.target : undefined;

		// The peer roster (the Peers tab): the stored rows and grants, and the team
		// they resolve to. The agent list is read only for an agent that has peer
		// configuration, the same guard the prompt builders use.
		const hasPeerConfig =
			!!agent.peerAgents?.length || !!agent.groupPeerAccess || !!agent.worktreePeerAccess;
		const peers = describePeerConfiguration(agent, hasPeerConfig ? readSessions() : []);

		// What the agent is spawned with, and the layer each value came from: the
		// Edit Agent dialog's "Show environment" table, from the same resolver.
		// The agent's own variables REPLACE the provider-level set.
		const effectiveEnv = resolveAgentEnvironment({
			global: asEnvRecord(readSettingValue('shellEnvVars')),
			agent: asEnvRecord(readAgentConfigValue(agent.toolType, 'customEnvVars')),
			session: agent.customEnvVars,
			gateway: gatewayEnvVarsFor(agent.toolType, agent.gatewayUrl),
		}).map((entry) => ({
			...entry,
			value:
				options.showSecrets || !isSecretEnvKey(entry.key) ? entry.value : maskEnvValue(entry.value),
			secret: isSecretEnvKey(entry.key),
		}));
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
			nudgeMessage: agent.nudgeMessage ?? null,
			peerDescription: agent.peerDescription ?? null,
			newSessionMessage: agent.newSessionMessage ?? null,
			customPath: agent.customPath ?? null,
			customArgs: agent.customArgs ?? null,
			// Secret values are masked unless `--show-secrets` is passed, as the
			// desktop masks them until the eye is clicked.
			customEnvVars: maskSecrets(agent.customEnvVars, options.showSecrets),
			// Variables switched off in the editor (`update-agent --env-park`).
			parkedEnvVars: maskSecrets(agent.customEnvVarsDisabled, options.showSecrets),
			// Every variable the agent is spawned with: `source` is the layer that
			// set it (global, agent, session, gateway) and `shadowedBy` the layers
			// it overrode.
			effectiveEnv,
			// Local Models gateway (settable with `update-agent --gateway-url`).
			gatewayUrl: agent.gatewayUrl ?? null,
			// How the Maestro token proxy carries this agent's requests when the
			// gateway points at it (settable with `update-agent --proxy-mode`).
			// Null means the default, passthrough.
			tokenProxyMode: agent.tokenProxyMode ?? null,
			// Run on (settable with `update-agent --run-on` / `--run-on-context`).
			// `runOnSpec` is the spelling `--run-on` takes, so a read can be written
			// back; `runOnLabel` is the target as the desktop names it.
			runOn: runOn.ok ? runOn.target : (agent.runOn ?? null),
			runOnSpec: runOn.ok ? formatRunOnSpec(runOn.target) : null,
			runOnLabel: runOnSource ? runOnTargetLabel(runOnSource, endpoints) : null,
			runOnProblem: runOn.ok ? null : runOn.error,
			// Tier targets (settable with `update-agent --tier <tier>=<target>`).
			// `spec` is the spelling `--tier` takes; `source` is the layer that
			// answered: agent, harness-default, built-in, or null for not mapped.
			tiers,
			// Background requests (settable with `update-agent --background-requests`).
			backgroundRequests: background.ok
				? (background.backgroundRequests ?? null)
				: (agent.backgroundRequests ?? null),
			backgroundRequestsSpec: background.ok
				? formatBackgroundRequestsSpec(background.backgroundRequests)
				: null,
			backgroundRequestsLabel: backgroundTarget
				? runOnTargetLabel(backgroundTarget, endpoints)
				: null,
			backgroundRequestsProblem: background.ok ? null : background.error,
			// Peer agents (settable with `update-agent --peer`, `--peer-note`,
			// `--remove-peer`, `--group-peers`, `--worktree-peers`). `rows` and the two
			// grants are what is stored; `roster` is who the agent can reach now,
			// each with the grant (`source`) that produced it.
			peers,
			// System One switch (settable with `update-agent --system-one on|off`).
			// False means the agent follows "Let agents use System One".
			systemOneOptOut: agent.systemOneOptOut === true,
			customModel: agent.customModel ?? null,
			customEffort: agent.customEffort ?? null,
			customContextWindow: agent.customContextWindow ?? null,
			// Claude token source: friendly tri-state plus the raw stored pair.
			tokenSource: agent.toolType === 'claude-code' ? tokenSource : null,
			enableMaestroP: agent.enableMaestroP ?? null,
			maestroPMode: agent.maestroPMode ?? null,
			maestroPPath: agent.maestroPPath ?? null,
			// Codex transport: the resolved value (exec | app-server) the spawner
			// reads, plus the raw stored field. Null for non-Codex agents.
			codexTransport: agent.toolType === 'codex' ? resolveCodexTransport(agent) : null,
			codexTransportStored: agent.codexTransport ?? null,
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
		failCommand(message, options.json);
	}
}
