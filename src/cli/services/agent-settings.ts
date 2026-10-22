// The editable settings of ONE agent (the Edit Agent modal fields that
// `update-agent` writes), read from that agent's record in maestro-sessions.json.
// `show-agent` and `settings agent get/list <agent-id>` both read through here,
// so every field `update-agent` can set is readable from either command. The
// per-provider-type defaults in maestro-agent-configs.json are a different
// store and are not read here.

import type { SessionInfo } from '../../shared/types';
import { getClaudeTokenMode } from '../../shared/claudeTokenMode';
import { resolveCodexTransport } from '../../shared/codexTransport';

export function readAgentSessionSettings(agent: SessionInfo) {
	// Resolve the Claude token source to the friendly tri-state (api | tui via
	// 'interactive' | dynamic) the Edit Agent modal shows. SSH enablement flips
	// the default for an unconfigured agent, so pass it through.
	const tokenSource = getClaudeTokenMode(
		{ enableMaestroP: agent.enableMaestroP, maestroPMode: agent.maestroPMode },
		{ sshEnabled: agent.sessionSshRemoteConfig?.enabled === true }
	);

	return {
		// Left Bar bookmark state (settable with `maestro-cli bookmark` /
		// `unbookmark`, or `update-agent --bookmark`).
		bookmarked: !!agent.bookmarked,
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
		// Codex transport: the resolved value (exec | app-server) the spawner
		// reads, plus the raw stored field. Null for non-Codex agents.
		codexTransport: agent.toolType === 'codex' ? resolveCodexTransport(agent) : null,
		codexTransportStored: agent.codexTransport ?? null,
		// Full SSH execution config so onboarding/verification can confirm the
		// agent's remote, working-dir override, and history-sync state without
		// reading raw store files.
		sessionSshRemoteConfig: agent.sessionSshRemoteConfig ?? null,
	};
}

export type AgentSessionSettings = ReturnType<typeof readAgentSessionSettings>;

/** Type and description of each agent setting, for `settings agent --verbose`. */
export const AGENT_SESSION_SETTING_METADATA: Record<
	keyof AgentSessionSettings,
	{ description: string; type: string }
> = {
	bookmarked: { description: 'Pinned to the Bookmarks section of the Left Bar.', type: 'boolean' },
	nudgeMessage: {
		description: 'Appended to every message sent to the agent (not shown in chat).',
		type: 'string',
	},
	newSessionMessage: {
		description: 'Prefixed to the first message of every new session (not shown in chat).',
		type: 'string',
	},
	customPath: { description: 'Override of the agent binary path.', type: 'string' },
	customArgs: { description: 'Extra CLI arguments appended to the spawn.', type: 'string' },
	customEnvVars: {
		description: 'Env vars merged over the provider-level customEnvVars.',
		type: 'object',
	},
	customModel: { description: 'Model override for this agent.', type: 'string' },
	customEffort: { description: 'Reasoning effort override for this agent.', type: 'string' },
	customContextWindow: { description: 'Context window size in tokens.', type: 'number' },
	tokenSource: {
		description: 'Resolved Claude token source (api, interactive, dynamic). Claude Code only.',
		type: 'string',
	},
	enableMaestroP: { description: 'Stored Claude token-source opt-in.', type: 'boolean' },
	maestroPMode: { description: 'Stored Claude token mode (interactive, dynamic).', type: 'string' },
	maestroPPath: { description: 'Override of the maestro-p binary path.', type: 'string' },
	codexTransport: {
		description: 'Resolved Codex transport (exec, app-server). Codex only.',
		type: 'string',
	},
	codexTransportStored: {
		description: 'Stored Codex transport opt-in; unset means exec.',
		type: 'string',
	},
	sessionSshRemoteConfig: { description: 'SSH remote execution config.', type: 'object' },
};
