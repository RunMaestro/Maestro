/**
 * Cue Spawn Builder — constructs a fully resolved spawn specification
 * from a CueExecutionConfig.
 *
 * Single responsibility: given session/agent/prompt/SSH config, produce a
 * SpawnSpec (command, args, cwd, env, stdin data). No side effects beyond
 * the async SSH resolution.
 */

import type { CueExecutionConfig } from './cue-executor';
import { getAgentDefinition, getAgentCapabilities } from '../agents';
import { buildAgentArgs, applyAgentConfigOverrides } from '../utils/agent-args';
import { wrapSpawnWithSsh, type SshSpawnWrapConfig } from '../utils/ssh-spawn-wrapper';
import { getSshRemoteConfig } from '../utils/ssh-remote-resolver';
import { ensureRemoteMaestroPProbed } from '../agents/probeRemoteMaestroP';
import { sanitizeCustomEnvVars } from './cue-env-sanitizer';
import {
	resolveClaudeSpawnMode,
	applyClaudeSpawnDecision,
	buildRemoteInteractiveSpawn,
} from '../agents/resolveClaudeSpawnMode';
import { getClaudeTokenMode } from '../../shared/claudeTokenMode';

// ─── Types ──────���────────────────────────────────────────────────────────────

/** Fully resolved spawn specification — everything needed to call spawn(). */
export interface SpawnSpec {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	/** For SSH stdin-script mode: full bash script to send via stdin */
	sshStdinScript?: string;
	/** Human-readable remote agent invocation (shown in Process Details for SSH spawns) */
	sshRemoteCommand?: string;
	/** For SSH small-prompt mode: raw prompt to send via stdin */
	stdinPrompt?: string;
	/** Whether SSH remote execution was actually used */
	sshRemoteUsed?: { name?: string; host: string };
}

/** Error result when the spawn spec cannot be built (e.g. unknown agent). */
export interface SpawnBuildError {
	ok: false;
	message: string;
}

/** Successful build result. */
export interface SpawnBuildSuccess {
	ok: true;
	spec: SpawnSpec;
}

export type SpawnBuildResult = SpawnBuildSuccess | SpawnBuildError;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Build a SpawnSpec from the given execution config.
 *
 * Follows the same pipeline as `process:spawn` IPC handler:
 * 1. Look up agent definition and capabilities
 * 2. Build base args via buildAgentArgs
 * 3. Apply config overrides (custom model, args, env)
 * 4. Apply SSH wrapping if enabled
 * 5. Append prompt to args for local execution
 */
export async function buildSpawnSpec(
	config: CueExecutionConfig,
	substitutedPrompt: string
): Promise<SpawnBuildResult> {
	const {
		toolType,
		projectRoot,
		sshRemoteConfig,
		customPath,
		customArgs,
		customEnvVars,
		customModel,
		customEffort,
		sshStore,
		agentConfigValues,
	} = config;

	// 1. Look up agent definition
	const agentDef = getAgentDefinition(toolType);
	if (!agentDef) {
		return { ok: false, message: `Unknown agent type: ${toolType}` };
	}

	// 2. Build args following the same pipeline as process:spawn
	const agentConfig = {
		...agentDef,
		available: true,
		path: customPath || agentDef.command,
		capabilities: getAgentCapabilities(toolType),
	};

	let finalArgs = buildAgentArgs(agentConfig, {
		baseArgs: agentDef.args,
		prompt: substitutedPrompt,
		cwd: projectRoot,
		yoloMode: true, // Cue runs always use YOLO mode like Auto Run
		permissionMode: 'full' as const,
		// Cue spawns with `stdio: ['ignore', 'pipe', 'pipe']` and no TTY, so the
		// agent must run in batch mode every time. Without this, a prompt that
		// substituted to `""` (e.g. `{{CUE_SOURCE_OUTPUT}}` when the upstream
		// agent produced no parseable stdout) would silently drop the batch-mode
		// args — e.g. Codex loses its `exec` subcommand and launches its TUI,
		// which immediately dies with "Error: stdin is not a terminal".
		forceBatchMode: true,
	});

	// 3. Apply config overrides (custom model, custom args, custom env vars)
	const configResolution = applyAgentConfigOverrides(agentConfig, finalArgs, {
		agentConfigValues: (agentConfigValues ?? {}) as Record<string, any>,
		sessionCustomModel: customModel,
		sessionCustomEffort: customEffort,
		sessionCustomArgs: customArgs,
		sessionCustomEnvVars: customEnvVars,
	});
	finalArgs = configResolution.args;
	// Sanitize custom env vars BEFORE they reach the spawn environment. This
	// drops blocklisted names (PATH, HOME, USER, SHELL, LD_PRELOAD,
	// DYLD_INSERT_LIBRARIES, NODE_OPTIONS) and any name that does not match the
	// POSIX identifier regex. Keeping this in the spawn-builder means SSH
	// wrapping below inherits the sanitized map automatically via
	// `sshWrapConfig.customEnvVars`.
	const sanitizedResult = sanitizeCustomEnvVars(
		configResolution.effectiveCustomEnvVars,
		config.onLog
	);
	const effectiveEnvVars = sanitizedResult.sanitized;

	// Determine command
	let command = customPath || agentDef.command;
	let spawnArgs = finalArgs;
	let spawnCwd = projectRoot;
	// `sshResult.customEnvVars` (assigned below in the SSH path) is
	// `Record<string, string> | undefined`, so the inferred type for
	// `spawnEnvVars` needs to allow undefined. Explicitly type it; the spread
	// at the end of the function already handles the undefined case via `|| {}`.
	let spawnEnvVars: Record<string, string> | undefined = effectiveEnvVars;
	let sshStdinScript: string | undefined;
	let sshRemoteCommand: string | undefined;
	let stdinPrompt: string | undefined;
	let sshRemoteUsed: SpawnSpec['sshRemoteUsed'];

	// 3b. Resolve the Claude token source (TUI / API / dynamic) the same way the
	// desktop `process:spawn` handler does, so a Cue run honors the triggering
	// agent's selection. The decision is computed here (the command + sanitized
	// env are now known) but APPLIED after the prompt is appended below, so
	// maestro-p's "prompt is the trailing positional" contract stays intact.
	// SSH spawns resolve to `api` (the resolver short-circuits on sshEnabled),
	// because maestro-p needs the local TUI and SSH runs `claude --print`.
	// Over SSH, warm the remote maestro-p probe BEFORE resolving so a headless Cue
	// spawn falls a remote TUI selection back to API instead of exiting 127 when
	// maestro-p isn't installed on the remote (no UI/readiness probe runs first).
	let remoteMaestroPAvailable: boolean | undefined;
	if (sshRemoteConfig?.enabled && sshStore) {
		const sshRemote = getSshRemoteConfig(sshStore, {
			sessionSshConfig: sshRemoteConfig,
		}).config;
		if (sshRemote) {
			remoteMaestroPAvailable = await ensureRemoteMaestroPProbed(sshRemote);
		}
	}
	const tokenMode = getClaudeTokenMode(
		{
			enableMaestroP: config.enableMaestroP,
			maestroPMode: config.maestroPMode,
		},
		// Remote agents default to the TUI when the user hasn't chosen, unless the
		// remote has no maestro-p to run it (then API).
		{ sshEnabled: !!sshRemoteConfig?.enabled, sshMaestroPAvailable: remoteMaestroPAvailable }
	);
	const claudeSpawnDecision = resolveClaudeSpawnMode({
		agent: {
			id: agentDef.id,
			interactiveCommand: agentDef.interactiveCommand,
			interactiveModeArgs: agentDef.interactiveModeArgs,
			defaultEnvVars: agentDef.defaultEnvVars,
		},
		tokenMode,
		sshEnabled: !!sshRemoteConfig?.enabled,
		// Lets the resolver fall a remote TUI spawn back to API when the remote
		// has no maestro-p on its PATH (avoids exit 127).
		sshRemoteId: sshRemoteConfig?.remoteId ?? undefined,
		command,
		sessionCustomPath: config.customPath,
		sessionCustomEnvVars: effectiveEnvVars,
		maestroPPath: config.maestroPPath,
		now: new Date(),
	});

	// 4. Apply SSH wrapping if configured
	if (sshRemoteConfig?.enabled && sshStore) {
		// Claude interactive/dynamic over SSH runs maestro-p on the remote host
		// (must be on its PATH) to drive the remote TUI on the Max subscription,
		// honoring the Cue run's configured timeout as the idle budget. Returns
		// null for the API path, leaving the SSH config on the plain claude binary.
		const remoteInteractive = buildRemoteInteractiveSpawn({
			decision: claudeSpawnDecision,
			interactiveModeArgs: agentDef.interactiveModeArgs,
			remoteClaudeBin: claudeSpawnDecision.claudeRealBinPath,
			maxWaitSeconds: Math.ceil(config.timeoutMs / 1000),
		});
		const sshWrapConfig: SshSpawnWrapConfig = {
			command,
			args: remoteInteractive ? [...remoteInteractive.prependArgs, ...finalArgs] : finalArgs,
			cwd: projectRoot,
			prompt: substitutedPrompt,
			customEnvVars: remoteInteractive
				? { ...effectiveEnvVars, ...remoteInteractive.env }
				: effectiveEnvVars,
			agentBinaryName: remoteInteractive ? remoteInteractive.command : agentDef.binaryName,
			promptArgs: agentDef.promptArgs,
			noPromptSeparator: agentDef.noPromptSeparator,
		};

		const sshResult = await wrapSpawnWithSsh(sshWrapConfig, sshRemoteConfig, sshStore);
		command = sshResult.command;
		spawnArgs = sshResult.args;
		spawnCwd = sshResult.cwd;
		spawnEnvVars = sshResult.customEnvVars;
		sshStdinScript = sshResult.sshStdinScript;
		sshRemoteCommand = sshResult.sshRemoteCommand;
		stdinPrompt = sshResult.prompt;

		if (sshResult.sshRemoteUsed) {
			sshRemoteUsed = sshResult.sshRemoteUsed;
		}
	}

	// 5. Append prompt as a positional CLI argument when the SSH wrapper
	// was NOT actually used. If sshRemoteConfig.enabled is true but sshStore
	// was missing, SSH wrapping was skipped so we still need to append.
	if (!sshRemoteUsed) {
		if (agentDef.promptArgs) {
			spawnArgs = [...spawnArgs, ...agentDef.promptArgs(substitutedPrompt)];
		} else if (agentDef.noPromptSeparator) {
			spawnArgs = [...spawnArgs, substitutedPrompt];
		} else {
			spawnArgs = [...spawnArgs, '--', substitutedPrompt];
		}
	}

	// 6. Realize an interactive (maestro-p) decision for local spawns. Applied
	// AFTER the prompt append so the maestro-p script + interactive flags come
	// FIRST and the prompt stays LAST (maestro-p strips the headless-only flags,
	// forwards the rest to the claude TUI, and reads the trailing positional as
	// the prompt). The injected MAESTRO_CLAUDE_BIN flows into the spec env below
	// via spawnEnvVars. SSH was already handled above and resolves to `api`.
	if (
		!sshRemoteUsed &&
		claudeSpawnDecision.mode === 'interactive' &&
		claudeSpawnDecision.maestroPBinPath
	) {
		const applied = applyClaudeSpawnDecision({
			decision: claudeSpawnDecision,
			interactiveModeArgs: agentDef.interactiveModeArgs,
			command,
			args: spawnArgs,
			customEnvVars: spawnEnvVars,
			// Honor the Cue run's configured timeout as maestro-p's idle budget
			// (`--max-wait`) instead of its 300s default. Without this a Cue
			// prompt dispatch through maestro-p was capped at 300s regardless of
			// `timeout_minutes`, killing every long-running background turn.
			maxWaitSeconds: Math.ceil(config.timeoutMs / 1000),
		});
		command = applied.command;
		spawnArgs = applied.args;
		spawnEnvVars = applied.customEnvVars;
	}

	return {
		ok: true,
		spec: {
			command,
			args: spawnArgs,
			cwd: spawnCwd,
			env: {
				...process.env,
				...(spawnEnvVars || {}),
			} as Record<string, string>,
			sshStdinScript,
			sshRemoteCommand,
			stdinPrompt,
			sshRemoteUsed,
		},
	};
}
