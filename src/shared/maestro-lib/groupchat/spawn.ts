/**
 * @file groupchat/spawn.ts
 * @description Everything a group chat or consult turn decides before its process exists.
 *
 * Every spawn site in a round (moderator, participant, synthesis, recovery) and every consult
 * follows one sequence: maybe warm the remote maestro-p probe, pick the Claude token source and
 * realize it, SSH-wrap the command when the agent runs on a remote, apply the Windows shell and
 * stdin rules, and start the turn clock. `prepareGroupChatSpawn` is that sequence, so each call
 * site only describes the semantic intent (`GroupChatSpawn`) and a host only turns the answer into
 * a process: the desktop through its `ProcessManager`, the headless runtime through
 * `planPipeSpawn`.
 *
 * The three collaborators that differ per host are inputs (`GroupChatSpawnDeps`): the Claude
 * decision, whose usage snapshot and remote probe cache are native on the desktop; the remote
 * probe warm-up; and the turn clock.
 */

import type { ClaudeTokenMode } from '../../claudeTokenMode';
import { logger } from '../host';
import { getContextWindowValue } from '../launch/agent-args';
import {
	applyClaudeSpawnDecision,
	buildRemoteInteractiveSpawn,
	type ClaudeSpawnDecision,
	type ResolveClaudeSpawnModeCoreInput,
} from '../launch/interactive-mode';
import {
	getSshRemoteConfig,
	type SshRemoteSettingsStore,
	type SshRemoteResolveResult,
} from '../launch/ssh-remote-resolver';
import { sshUnresolvedRemoteMessage, wrapSpawnWithSsh } from '../launch/ssh-spawn-wrapper';
import type { WindowsSpawnConfig } from './windows-spawn';
import type { GroupChatSpawn } from './types';

const LOG_CONTEXT = '[GroupChatSpawn]';

/** What the host contributes to preparing a spawn. */
export interface GroupChatSpawnDeps {
	/** Where the SSH remotes are, or null when the host has none. Required when a spawn names a remote. */
	sshStore: SshRemoteSettingsStore | null;
	/** Decides the Claude token source (the maestro-p TUI or `claude --print`) for one spawn. */
	resolveClaudeSpawnMode(
		input: Omit<ResolveClaudeSpawnModeCoreInput, 'agent'> & { agent: GroupChatSpawn['agent'] }
	): ClaudeSpawnDecision;
	/**
	 * Warm the remote maestro-p probe BEFORE the decision is made, so a remote TUI selection falls
	 * back to the API instead of exiting 127 when maestro-p is not installed there. A host with no
	 * probe cache leaves it out; the decision then stays optimistic.
	 */
	probeRemoteMaestroP?(remote: NonNullable<SshRemoteResolveResult['config']>): Promise<unknown>;
	/** The Windows shell and stdin choices, with the host's custom shell path applied. */
	windowsSpawnConfig(agentId: string, ssh: GroupChatSpawn['sshRemoteConfig']): WindowsSpawnConfig;
	/** Starts the turn clock for a process id, at the one choke point every turn shape goes through. */
	beginTurn(processId: string): void;
}

/** The process a turn starts, in the fields both hosts read. */
export interface PreparedGroupChatSpawn {
	processId: string;
	providerId: string;
	cwd: string;
	command: string;
	args: string[];
	prompt?: string;
	customEnvVars?: Record<string, string>;
	/** A read-only turn (moderator, synthesis, a read-only delegation). */
	readOnlyMode: boolean;
	contextWindow: number;
	promptArgs?: (prompt: string) => string[];
	noPromptSeparator?: boolean;
	/** Windows shell, stdin, and SSH script choices. */
	shell?: string;
	runInShell?: boolean;
	sendPromptViaStdin?: boolean;
	sendPromptViaStdinRaw?: boolean;
	sshStdinScript?: string;
	sshRemoteCommand?: string;
}

/**
 * Decide how one turn starts: the SSH wrap, the Claude token source, the Windows shell. Throws
 * when the agent is set to run on an SSH remote that cannot be used, never degrading to a local
 * run against the remote's directory.
 */
export async function prepareGroupChatSpawn(
	spawn: GroupChatSpawn,
	deps: GroupChatSpawnDeps
): Promise<PreparedGroupChatSpawn> {
	const {
		processId,
		providerId,
		agent,
		args,
		cwd,
		prompt,
		customEnvVars,
		agentConfigValues,
		sshRemoteConfig,
		readOnlyMode = false,
		debugLabel,
	} = spawn;
	const { sshStore } = deps;

	const baseCommand = spawn.command ?? agent.path ?? agent.command;

	let spawnCommand = baseCommand;
	let spawnArgs = args;
	let spawnCwd = cwd;
	let spawnPrompt: string | undefined = prompt;
	let spawnEnvVars = customEnvVars;
	let spawnSshStdinScript: string | undefined;
	let spawnSshRemoteCommand: string | undefined;

	// Over SSH, warm the remote maestro-p probe BEFORE resolving so a remote TUI
	// selection falls back to API instead of exiting 127 when maestro-p isn't
	// installed on the remote (the resolver reads this from the cache).
	if (sshRemoteConfig?.enabled && sshStore && deps.probeRemoteMaestroP) {
		const sshRemote = getSshRemoteConfig(sshStore, {
			sessionSshConfig: sshRemoteConfig,
		}).config;
		if (sshRemote) {
			await deps.probeRemoteMaestroP(sshRemote);
		}
	}

	// Resolve the Claude token source (maestro-p TUI vs `claude --print`) and,
	// for the interactive/dynamic case, rewrite the spawn to run maestro-p via
	// process.execPath. The resolver returns API for non-Claude agents and SSH
	// spawns, so this is a no-op outside the local Claude Code interactive path.
	// maestro-p reads the prompt the same way claude does (positional after the
	// args the process manager appends), so prompt delivery is unchanged.
	const tokenMode: ClaudeTokenMode = spawn.tokenMode ?? 'api';
	const claudeDecision = deps.resolveClaudeSpawnMode({
		agent,
		tokenMode,
		sshEnabled: !!sshRemoteConfig?.enabled,
		// Lets the resolver fall a remote TUI spawn back to API when the remote
		// has no maestro-p on its PATH (avoids exit 127).
		sshRemoteId: sshRemoteConfig?.remoteId ?? undefined,
		command: baseCommand,
		sessionCustomEnvVars: customEnvVars,
		maestroPPath: spawn.maestroPPath,
		now: new Date(),
	});
	if (claudeDecision.mode === 'interactive' && claudeDecision.maestroPBinPath) {
		const applied = applyClaudeSpawnDecision({
			decision: claudeDecision,
			interactiveModeArgs: agent.interactiveModeArgs,
			command: baseCommand,
			args,
			customEnvVars,
			maxWaitSeconds: spawn.maxWaitSeconds,
		});
		spawnCommand = applied.command;
		spawnArgs = applied.args;
		spawnEnvVars = applied.customEnvVars;
		if (debugLabel) {
			logger.debug(
				`[GroupChat:Debug] ${debugLabel} resolved to maestro-p (tokenMode=${spawn.tokenMode})`,
				LOG_CONTEXT
			);
		}
	}

	// Apply SSH wrapping if configured
	if (sshRemoteConfig?.enabled && !sshStore) {
		throw new Error(
			`SSH remote is enabled but sshStore is not available for ${debugLabel ?? processId}`
		);
	}
	if (sshStore && sshRemoteConfig?.enabled) {
		if (debugLabel) {
			logger.debug(`[GroupChat:Debug] Applying SSH wrapping for ${debugLabel}...`, LOG_CONTEXT);
		}
		// Claude interactive/dynamic over SSH runs maestro-p on the remote host
		// (must be on its PATH) to drive the remote TUI on the Max subscription.
		// Returns null for the API path, leaving the SSH config untouched.
		const remoteInteractive = buildRemoteInteractiveSpawn({
			decision: claudeDecision,
			interactiveModeArgs: agent.interactiveModeArgs,
			remoteClaudeBin: claudeDecision.claudeRealBinPath,
			maxWaitSeconds: spawn.maxWaitSeconds,
		});
		if (remoteInteractive && debugLabel) {
			logger.debug(
				`[GroupChat:Debug] ${debugLabel} resolved to remote maestro-p over SSH (tokenMode=${spawn.tokenMode})`,
				LOG_CONTEXT
			);
		}
		const sshWrapped = await wrapSpawnWithSsh(
			{
				command: baseCommand,
				args: remoteInteractive ? [...remoteInteractive.prependArgs, ...args] : args,
				cwd,
				prompt,
				customEnvVars: remoteInteractive
					? { ...(customEnvVars ?? {}), ...remoteInteractive.env }
					: customEnvVars,
				promptArgs: agent.promptArgs,
				noPromptSeparator: agent.noPromptSeparator,
				agentBinaryName: remoteInteractive ? remoteInteractive.command : agent.binaryName,
			},
			sshRemoteConfig,
			sshStore
		);
		// wrapSpawnWithSsh quietly hands back the unmodified local config when the
		// remote cannot be resolved. Taking it would run this agent on the user's
		// own machine against the REMOTE's cwd - the participant would either fail
		// on a missing directory or, worse, succeed against the wrong files. The
		// user opted into a remote host, so fail loudly instead of degrading.
		if (!sshWrapped.sshRemoteUsed) {
			throw new Error(sshUnresolvedRemoteMessage(sshRemoteConfig));
		}
		spawnCommand = sshWrapped.command;
		spawnArgs = sshWrapped.args;
		spawnCwd = sshWrapped.cwd;
		spawnPrompt = sshWrapped.prompt;
		spawnEnvVars = sshWrapped.customEnvVars;
		spawnSshStdinScript = sshWrapped.sshStdinScript;
		spawnSshRemoteCommand = sshWrapped.sshRemoteCommand;
		if (debugLabel) {
			logger.debug(
				`[GroupChat:Debug] SSH remote used for ${debugLabel}: ${sshWrapped.sshRemoteUsed.name}`,
				LOG_CONTEXT
			);
		}
	}

	// Get Windows-specific spawn config (shell, stdin mode) - skipped for SSH
	const winConfig = deps.windowsSpawnConfig(providerId, sshRemoteConfig ?? undefined);
	if (winConfig.shell && debugLabel) {
		logger.debug(
			`[GroupChat:Debug] Windows shell config for ${debugLabel}: ${winConfig.shell}`,
			LOG_CONTEXT
		);
	}

	// Start the clock at the single choke point every turn shape goes through
	// (moderator, participant, synthesis, recovery), so a new spawn site is
	// measured without having to remember to opt in.
	deps.beginTurn(processId);

	return {
		processId,
		providerId,
		cwd: spawnCwd,
		command: spawnCommand,
		args: spawnArgs,
		prompt: spawnPrompt,
		customEnvVars: spawnEnvVars,
		readOnlyMode,
		contextWindow: getContextWindowValue(agent, agentConfigValues ?? {}),
		promptArgs: agent.promptArgs,
		noPromptSeparator: agent.noPromptSeparator,
		shell: winConfig.shell,
		runInShell: winConfig.runInShell,
		sendPromptViaStdin: winConfig.sendPromptViaStdin,
		sendPromptViaStdinRaw: winConfig.sendPromptViaStdinRaw,
		sshStdinScript: spawnSshStdinScript,
		sshRemoteCommand: spawnSshRemoteCommand,
	};
}

export type { WindowsSpawnConfig };
