/**
 * @file spawnGroupChatAgent.ts
 * @description Centralized spawn helper for Group Chat agent processes.
 *
 * Every spawn site in the Group Chat router (moderator, participant, synthesis,
 * recovery) follows the same pattern: maybe SSH-wrap the command, apply
 * Windows-specific shell/stdin config, then call `processManager.spawn`. This
 * helper consolidates that sequence so each call site only needs to describe
 * the semantic spawn intent rather than repeat the mechanics.
 */

import { IProcessManager } from './group-chat-moderator';
import { getContextWindowValue } from '../utils/agent-args';
import { wrapSpawnWithSsh } from '../utils/ssh-spawn-wrapper';
import type { SshRemoteSettingsStore } from '../utils/ssh-remote-resolver';
import { getWindowsSpawnConfig } from './group-chat-config';
import type { AgentConfig } from '../agents/definitions';
import type { AgentSshRemoteConfig } from '../../shared/types';

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
	/** Process manager to invoke */
	processManager: IProcessManager;
	/** Whether the spawned process is read-only (moderator / synthesis = true) */
	readOnlyMode?: boolean;
	/** Optional label for debug logs (e.g. 'moderator', 'participant: Alice') */
	debugLabel?: string;
}

export interface SpawnGroupChatAgentResult {
	pid: number;
	success: boolean;
}

/**
 * Spawn a Group Chat agent process with SSH + Windows shell handling applied.
 *
 * The helper:
 * 1. Optionally wraps the command with SSH (when `sshRemoteConfig.enabled`)
 * 2. Applies Windows-specific shell/stdin config (skipped for SSH)
 * 3. Calls `processManager.spawn` with the resolved config
 *
 * All four legacy call sites (moderator, participant, synthesis, recovery) used
 * this exact sequence with only cosmetic differences - see git history for the
 * inline versions this replaces.
 */
export async function spawnGroupChatAgent(
	config: SpawnGroupChatAgentConfig
): Promise<SpawnGroupChatAgentResult> {
	const {
		sessionId,
		agentId,
		agent,
		args,
		cwd,
		prompt,
		customEnvVars,
		agentConfigValues,
		sshRemoteConfig,
		sshStore,
		processManager,
		readOnlyMode = false,
		debugLabel,
	} = config;

	const baseCommand = config.command ?? agent.path ?? agent.command;

	let spawnCommand = baseCommand;
	let spawnArgs = args;
	let spawnCwd = cwd;
	let spawnPrompt: string | undefined = prompt;
	let spawnEnvVars = customEnvVars;
	let spawnSshStdinScript: string | undefined;

	// Apply SSH wrapping if configured
	if (sshRemoteConfig?.enabled && !sshStore) {
		throw new Error(
			`SSH remote is enabled but sshStore is not available for ${debugLabel ?? sessionId}`
		);
	}
	if (sshStore && sshRemoteConfig?.enabled) {
		if (debugLabel) {
			console.log(`[GroupChat:Debug] Applying SSH wrapping for ${debugLabel}...`);
		}
		const sshWrapped = await wrapSpawnWithSsh(
			{
				command: baseCommand,
				args,
				cwd,
				prompt,
				customEnvVars,
				promptArgs: agent.promptArgs,
				noPromptSeparator: agent.noPromptSeparator,
				agentBinaryName: agent.binaryName,
			},
			sshRemoteConfig,
			sshStore
		);
		spawnCommand = sshWrapped.command;
		spawnArgs = sshWrapped.args;
		spawnCwd = sshWrapped.cwd;
		spawnPrompt = sshWrapped.prompt;
		spawnEnvVars = sshWrapped.customEnvVars;
		spawnSshStdinScript = sshWrapped.sshStdinScript;
		if (sshWrapped.sshRemoteUsed && debugLabel) {
			console.log(
				`[GroupChat:Debug] SSH remote used for ${debugLabel}: ${sshWrapped.sshRemoteUsed.name}`
			);
		}
	}

	// Get Windows-specific spawn config (shell, stdin mode) - skipped for SSH
	const winConfig = getWindowsSpawnConfig(agentId, sshRemoteConfig ?? undefined);
	if (winConfig.shell && debugLabel) {
		console.log(`[GroupChat:Debug] Windows shell config for ${debugLabel}: ${winConfig.shell}`);
	}

	const spawnResult = processManager.spawn({
		sessionId,
		toolType: agentId,
		cwd: spawnCwd,
		command: spawnCommand,
		args: spawnArgs,
		readOnlyMode,
		prompt: spawnPrompt,
		contextWindow: getContextWindowValue(agent, agentConfigValues ?? {}),
		customEnvVars: spawnEnvVars,
		promptArgs: agent.promptArgs,
		noPromptSeparator: agent.noPromptSeparator,
		shell: winConfig.shell,
		runInShell: winConfig.runInShell,
		sendPromptViaStdin: winConfig.sendPromptViaStdin,
		sendPromptViaStdinRaw: winConfig.sendPromptViaStdinRaw,
		sshStdinScript: spawnSshStdinScript,
	});

	return spawnResult;
}
