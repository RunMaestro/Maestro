/**
 * @file spawnGroupChatAgent.ts
 * @description Centralized spawn helper for Group Chat agent processes.
 *
 * Every spawn site in the Group Chat router (moderator, participant, synthesis,
 * recovery) follows the same pattern: maybe SSH-wrap the command, apply
 * Windows-specific shell/stdin config, then call `processManager.spawn`. The first two
 * steps are `prepareGroupChatSpawn` in the library (the headless runtime runs the same
 * ones); this helper supplies the desktop's collaborators and hands the result to the
 * `ProcessManager`.
 */

import { IProcessManager } from './group-chat-moderator';
import type { SshRemoteSettingsStore } from '../utils/ssh-remote-resolver';
import { ensureRemoteMaestroPProbed } from '../agents/probeRemoteMaestroP';
import { getWindowsSpawnConfig } from './group-chat-config';
import { beginGroupChatTurn } from './group-chat-turn-metrics';
import type { AgentConfig } from '../agents/definitions';
import type { AgentSshRemoteConfig } from '../../shared/types';
import { resolveClaudeSpawnMode } from '../agents/resolveClaudeSpawnMode';
import type { ClaudeTokenMode } from '../../shared/claudeTokenMode';
import { prepareGroupChatSpawn } from '../../shared/maestro-lib/groupchat/spawn';

export interface SpawnGroupChatAgentConfig {
	/** Stable session id for the process manager */
	sessionId: string;
	/** Agent id (e.g. 'claude-code', 'codex') - used as `toolType` */
	agentId: string;
	/** Resolved agent definition */
	agent: AgentConfig;
	/** Base command - defaults to agent.path ?? agent.command */
	command?: string;
	/** Fully-formed args (after buildAgentArgs + any extras) */
	args: string[];
	/** Working directory */
	cwd: string;
	/** Prompt to send (via CLI arg or stdin) */
	prompt?: string;
	/** Resolved custom env vars to inject */
	customEnvVars?: Record<string, string>;
	/** Agent config values (used for context window resolution) */
	agentConfigValues?: Record<string, any>;
	/** SSH remote config (from chat moderator or matching session); null/undefined = local */
	sshRemoteConfig?: AgentSshRemoteConfig | null;
	/** SSH settings store (required when sshRemoteConfig is active) */
	sshStore?: SshRemoteSettingsStore | null;
	/**
	 * Claude token source for this agent (Claude Code only). Drives the
	 * maestro-p TUI vs `claude --print` choice. Ignored for non-Claude agents
	 * and SSH spawns (the TUI wrapper needs the local claude binary).
	 */
	tokenMode?: ClaudeTokenMode;
	/** Optional per-agent maestro-p script override. */
	maestroPPath?: string;
	/** Process manager to invoke */
	processManager: IProcessManager;
	/** Whether the spawned process is read-only (moderator / synthesis = true) */
	readOnlyMode?: boolean;
	/** Optional label for debug logs (e.g. 'moderator', 'participant: Alice') */
	debugLabel?: string;
	/**
	 * Overall idle budget for a maestro-p (interactive/dynamic) run, in seconds,
	 * forwarded as `--max-wait`. Group Chat is a background/orchestrated caller, so
	 * it MUST pass this to match the router's own supervising timeout - otherwise
	 * maestro-p falls back to its 300s idle default and silently kills a
	 * still-working moderator/participant whose JSONL output stalls past 300s
	 * (long tool runs or extended thinking), even though the router would wait the
	 * full 10 minutes. Same contract Cue follows. Ignored on the API path.
	 */
	maxWaitSeconds?: number;
}

export interface SpawnGroupChatAgentResult {
	pid: number;
	success: boolean;
}

/**
 * Spawn a Group Chat agent process with SSH + Windows shell handling applied.
 *
 * The helper:
 * 1. Prepares the spawn in the library: optional SSH wrapping (when `sshRemoteConfig.enabled`),
 *    the Claude token source, and the Windows shell/stdin config (skipped for SSH)
 * 2. Calls `processManager.spawn` with the prepared config
 *
 * All four legacy call sites (moderator, participant, synthesis, recovery) used
 * this exact sequence with only cosmetic differences - see git history for the
 * inline versions this replaces.
 */
export async function spawnGroupChatAgent(
	config: SpawnGroupChatAgentConfig
): Promise<SpawnGroupChatAgentResult> {
	const { processManager, sshStore } = config;

	const prepared = await prepareGroupChatSpawn(
		{
			processId: config.sessionId,
			providerId: config.agentId,
			agent: config.agent,
			command: config.command,
			args: config.args,
			cwd: config.cwd,
			prompt: config.prompt,
			customEnvVars: config.customEnvVars,
			agentConfigValues: config.agentConfigValues,
			sshRemoteConfig: config.sshRemoteConfig,
			tokenMode: config.tokenMode,
			maestroPPath: config.maestroPPath,
			readOnlyMode: config.readOnlyMode,
			debugLabel: config.debugLabel,
			maxWaitSeconds: config.maxWaitSeconds,
		},
		{
			sshStore: sshStore ?? null,
			resolveClaudeSpawnMode,
			probeRemoteMaestroP: ensureRemoteMaestroPProbed,
			windowsSpawnConfig: getWindowsSpawnConfig,
			beginTurn: beginGroupChatTurn,
		}
	);

	return processManager.spawn({
		sessionId: prepared.processId,
		toolType: prepared.providerId,
		cwd: prepared.cwd,
		command: prepared.command,
		args: prepared.args,
		readOnlyMode: prepared.readOnlyMode,
		prompt: prepared.prompt,
		contextWindow: prepared.contextWindow,
		customEnvVars: prepared.customEnvVars,
		promptArgs: prepared.promptArgs,
		noPromptSeparator: prepared.noPromptSeparator,
		shell: prepared.shell,
		runInShell: prepared.runInShell,
		sendPromptViaStdin: prepared.sendPromptViaStdin,
		sendPromptViaStdinRaw: prepared.sendPromptViaStdinRaw,
		sshStdinScript: prepared.sshStdinScript,
		sshRemoteCommand: prepared.sshRemoteCommand,
	});
}
