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
import { applySystemPromptDelivery } from '../utils/system-prompt-delivery';
import { steeringSocketPathFor } from '../process-manager/steering-client';
import { resolveSshLaunchTarget } from '../../shared/maestro-lib/launch/ssh-remote-resolver';
import { applyAgentGatewayToSpawn } from '../local-models/proxy/service';
import { applyAgentRunOnToSpawn, logRunOnLaunch, storedAgentRunOn } from '../local-models/run-on';
import { runOnHarnessMode } from '../../shared/local-models/run-on';

/** The remote's display name for a refusal message; its id when it cannot be resolved. */
function sshRemoteName(
	store: SshRemoteSettingsStore | null | undefined,
	config: AgentSshRemoteConfig
): string {
	const target = resolveSshLaunchTarget(store ?? undefined, config);
	return target.kind === 'remote' ? target.remote.name : (config.remoteId ?? 'unknown');
}

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
	/**
	 * The Left Bar agent this process runs AS, when there is one (a participant,
	 * a cross-agent consult target). Its Run on target, or failing that its Local
	 * Models gateway, is applied to the spawn, so the turn runs on the same model
	 * by the same route as that agent's own tab. Omit for a process that is
	 * nobody's agent (the moderator, synthesis): both are per-agent settings and
	 * there is none to read.
	 */
	maestroAgentId?: string;
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
	/**
	 * Maestro system prompt for this agent. Delivered by
	 * `applySystemPromptDelivery`, exactly like a tab spawn: the native flag
	 * (temp file on Windows local) when the agent supports it, otherwise embedded
	 * into `prompt`, and not re-embedded when `isResume`.
	 */
	appendSystemPrompt?: string;
	/** True when `args` resume an existing provider session. */
	isResume?: boolean;
	/**
	 * `cwd` is the agent's own working directory, so maestro-p may accept
	 * claude's folder-trust prompt there (#1872). Leave unset for any other
	 * folder (the moderator's, a synthesis scratch dir).
	 */
	acceptWorkspaceTrust?: boolean;
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
	const { sessionId, agentId, agent, sshRemoteConfig } = config;

	// System prompt first, so every later step (maestro-p rewrite, SSH wrap,
	// Windows stdin) sees the final args and prompt.
	const delivered = await applySystemPromptDelivery({
		args: config.args,
		prompt: config.prompt,
		systemPrompt: config.appendSystemPrompt,
		supportsAppendSystemPrompt: !!config.agent.capabilities?.supportsAppendSystemPrompt,
		isResume: !!config.isResume,
		isSshSession: !!config.sshRemoteConfig?.enabled,
		sessionId: config.sessionId,
		agentId: config.agentId,
		logContext: '[GroupChat:Spawn]',
	});
	// Where the agent's model runs, applied before anything below reads the
	// arguments or the env, so the local, maestro-p and SSH paths all carry it:
	// its Run on target first, and its Local Models gateway only when it has
	// none (a Run on target takes the gateway's place, since the gateway routes
	// to the provider). Either one that cannot be used (a source that is down, a
	// loopback address for a remote host, a proxy that will not start) refuses
	// the turn by name rather than running it somewhere the user did not choose.
	let args = delivered.args;
	let customEnvVars = config.customEnvVars;
	if (config.maestroAgentId) {
		const remote = sshRemoteConfig?.enabled
			? { name: sshRemoteName(sshStore, sshRemoteConfig) }
			: null;
		const runOn = await applyAgentRunOnToSpawn({
			agentId: config.maestroAgentId,
			toolType: agentId,
			agent,
			args,
			customEnvVars,
			remote,
		});
		if (!runOn.ok) throw new Error(runOn.error);
		args = runOn.args;
		customEnvVars = runOn.customEnvVars;
		if (runOn.runOn) {
			logRunOnLaunch('[GroupChat:Spawn]', { sessionId, toolType: agentId }, runOn.runOn);
		} else {
			const gateway = await applyAgentGatewayToSpawn({
				agentId: config.maestroAgentId,
				toolType: agentId,
				args,
				customEnvVars,
				remote,
			});
			if (!gateway.ok) throw new Error(gateway.error);
			args = gateway.args;
			customEnvVars = gateway.customEnvVars;
		}
	}

	const prepared = await prepareGroupChatSpawn(
		{
			processId: config.sessionId,
			providerId: config.agentId,
			agent: config.agent,
			command: config.command,
			args,
			cwd: config.cwd,
			prompt: delivered.prompt,
			customEnvVars,
			agentConfigValues: config.agentConfigValues,
			sshRemoteConfig: config.sshRemoteConfig,
			tokenMode: runOnHarnessMode(
				config.maestroAgentId ? storedAgentRunOn(config.maestroAgentId) : undefined,
				config.tokenMode ?? 'api',
				'api'
			),
			maestroPPath: config.maestroPPath,
			readOnlyMode: config.readOnlyMode,
			debugLabel: config.debugLabel,
			maxWaitSeconds: config.maxWaitSeconds,
			acceptWorkspaceTrust: config.acceptWorkspaceTrust,
		},
		{
			sshStore: sshStore ?? null,
			resolveClaudeSpawnMode,
			probeRemoteMaestroP: ensureRemoteMaestroPProbed,
			windowsSpawnConfig: getWindowsSpawnConfig,
			beginTurn: beginGroupChatTurn,
			steeringSocketPath: steeringSocketPathFor,
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
