/**
 * Cue Spawn Builder - constructs a fully resolved spawn specification
 * from a CueExecutionConfig.
 *
 * Single responsibility: given session/agent/prompt/SSH config, produce a
 * SpawnSpec (command, args, cwd, env, stdin data). No side effects beyond
 * the async SSH resolution.
 */

import * as path from 'path';
import type { CueExecutionConfig } from './cue-executor';
import { getAgentDefinition, getAgentCapabilities } from '../agents';
import { buildAgentArgs, applyAgentConfigOverrides } from '../utils/agent-args';
import {
	wrapSpawnWithSsh,
	sshUnresolvedRemoteMessage,
	type SshSpawnWrapConfig,
} from '../utils/ssh-spawn-wrapper';
import { getSshRemoteConfig } from '../utils/ssh-remote-resolver';
import { ensureRemoteMaestroPProbed } from '../agents/probeRemoteMaestroP';
import { sanitizeCustomEnvVars } from './cue-env-sanitizer';
import {
	resolveClaudeSpawnMode,
	applyClaudeSpawnDecision,
	buildRemoteInteractiveSpawn,
	isAgentOwnWorkingDirectory,
} from '../agents/resolveClaudeSpawnMode';
import { getClaudeTokenMode } from '../../shared/claudeTokenMode';
import { QUERY_SOURCE_ENV_VAR } from '../../shared/querySource';
import { buildSpawnPath } from '../utils/spawnPath';
import { isWindows } from '../../shared/platformDetection';
import { escapeCmdArgs } from '../process-manager/utils/shellEscape';

// ─── Types ──────���────────────────────────────────────────────────────────────

/** Fully resolved spawn specification - everything needed to call spawn(). */
export interface SpawnSpec {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	/** For SSH stdin-script mode: full bash script to send via stdin */
	sshStdinScript?: string;
	/** Human-readable remote agent invocation (shown in Process Details for SSH spawns) */
	sshRemoteCommand?: string;
	/**
	 * Raw prompt to send via stdin: SSH small-prompt mode, or a local Windows
	 * run of a `.cmd` / `.bat` shim (see {@link isWindowsBatchShim}).
	 */
	stdinPrompt?: string;
	/**
	 * Start the command through cmd.exe. Set only for a local Windows `.cmd` /
	 * `.bat` shim; `command` and `args` are already quoted for that shell.
	 */
	shell?: boolean;
	/** Whether SSH remote execution was actually used */
	sshRemoteUsed?: { name?: string; host: string };
}

/**
 * Whether a local command is a Windows batch-file shim (`claude.cmd`,
 * `codex.cmd`, `opencode.cmd` - what an npm global install puts on PATH).
 *
 * Node refuses to start a `.cmd` / `.bat` without a shell (`spawn EINVAL`,
 * since the CVE-2024-27980 fix), so a Cue run of such an agent failed before
 * it started (MAESTRO-R0). Same rule ChildProcessSpawner applies to desktop
 * spawns (MAESTRO-Q8).
 */
function isWindowsBatchShim(command: string): boolean {
	if (!isWindows()) return false;
	const ext = path.win32.extname(command.replace(/"/g, '')).toLowerCase();
	return ext === '.cmd' || ext === '.bat';
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
		session,
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
		// A Cue-triggered run is the same agent doing the same work unattended, so
		// it gets the same directory grants an interactive turn would.
		additionalDirectories: session?.additionalDirectories,
		yoloMode: true, // Cue runs always use YOLO mode like Auto Run
		permissionMode: 'full' as const,
		// Cue spawns with `stdio: ['ignore', 'pipe', 'pipe']` and no TTY, so the
		// agent must run in batch mode every time. Without this, a prompt that
		// substituted to `""` (e.g. `{{CUE_SOURCE_OUTPUT}}` when the upstream
		// agent produced no parseable stdout) would silently drop the batch-mode
		// args - e.g. Codex loses its `exec` subcommand and launches its TUI,
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

	// A Cue run is the agent working in its own project root, so a TUI run may
	// accept claude's folder-trust prompt there (#1872).
	const acceptWorkspaceTrust = isAgentOwnWorkingDirectory(projectRoot, session);

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
			acceptWorkspaceTrust,
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
			querySource: 'cue',
		};

		const sshResult = await wrapSpawnWithSsh(sshWrapConfig, sshRemoteConfig, sshStore);
		// The wrapper hands back the LOCAL config when the remote is missing or
		// disabled, still carrying the remote's cwd. Running that would leak the
		// prompt to this machine against the wrong (or no) directory.
		if (!sshResult.sshRemoteUsed) {
			return { ok: false, message: sshUnresolvedRemoteMessage(sshRemoteConfig) };
		}
		command = sshResult.command;
		spawnArgs = sshResult.args;
		spawnCwd = sshResult.cwd;
		spawnEnvVars = sshResult.customEnvVars;
		sshStdinScript = sshResult.sshStdinScript;
		sshRemoteCommand = sshResult.sshRemoteCommand;
		stdinPrompt = sshResult.prompt;
		sshRemoteUsed = sshResult.sshRemoteUsed;
	}

	// A local maestro-p run reads the prompt as its trailing positional (step 6).
	const runsMaestroPLocally =
		!sshRemoteUsed &&
		claudeSpawnDecision.mode === 'interactive' &&
		!!claudeSpawnDecision.maestroPBinPath;

	// 5. Append prompt as a positional CLI argument when the SSH wrapper
	// was NOT actually used. If sshRemoteConfig.enabled is true but sshStore
	// was missing, SSH wrapping was skipped so we still need to append.
	//
	// A Windows `.cmd` / `.bat` shim has to start through cmd.exe (below), and
	// cmd.exe ends the command at the first line break, so a multi-line prompt
	// in argv would arrive cut short. An agent that reads its prompt from stdin
	// gets it there instead, as the desktop spawn does on Windows.
	if (
		!sshRemoteUsed &&
		!runsMaestroPLocally &&
		isWindowsBatchShim(command) &&
		agentConfig.capabilities?.supportsPromptViaStdin
	) {
		if (agentDef.stdinPromptArgs) {
			spawnArgs = [...spawnArgs, ...agentDef.stdinPromptArgs];
		}
		stdinPrompt = substitutedPrompt;
	} else if (!sshRemoteUsed) {
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
	if (runsMaestroPLocally) {
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
			acceptWorkspaceTrust,
		});
		command = applied.command;
		spawnArgs = applied.args;
		spawnEnvVars = applied.customEnvVars;
	}

	// 7. A local Windows `.cmd` / `.bat` shim starts through cmd.exe, with every
	// argument escaped for it and a command path containing spaces quoted
	// (cmd.exe would split "C:\Users\First Last\...\claude.cmd"), matching
	// ChildProcessSpawner.
	let shell: boolean | undefined;
	if (!sshRemoteUsed && isWindowsBatchShim(command)) {
		shell = true;
		spawnArgs = escapeCmdArgs(spawnArgs);
		if (/\s/.test(command) && !command.startsWith('"')) {
			command = `"${command}"`;
		}
	}

	return {
		ok: true,
		spec: {
			command,
			args: spawnArgs,
			cwd: spawnCwd,
			env: {
				...process.env,
				// A Dock/Finder launch hands Maestro launchd's bare PATH
				// (/usr/bin:/bin:/usr/sbin:/sbin), so inheriting it verbatim leaves the
				// agent and every tool it shells out to blind to Homebrew and other
				// user installs. Same PATH the desktop agent spawn builds (#1573).
				PATH: buildSpawnPath(),
				...(spawnEnvVars || {}),
				// Stamped after the user's own vars: a Cue run is a Cue run no matter
				// what the agent's env overrides say. Without this every downstream
				// consumer of the spawned process (Claude Code hooks, telemetry
				// sidecars) sees a turn indistinguishable from one the user typed,
				// because Cue prompts ARE the user's words from cue.yaml.
				[QUERY_SOURCE_ENV_VAR]: 'cue',
			} as Record<string, string>,
			sshStdinScript,
			sshRemoteCommand,
			stdinPrompt,
			shell,
			sshRemoteUsed,
		},
	};
}
