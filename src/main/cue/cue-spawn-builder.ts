/**
 * Cue Spawn Builder - constructs a fully resolved spawn specification
 * from a CueExecutionConfig.
 *
 * Single responsibility: given session/agent/prompt/SSH config, produce a
 * SpawnSpec (command, args, cwd, env, stdin data). No side effects beyond
 * the async SSH resolution.
 */

import type { CueExecutionConfig } from './cue-executor';
import { getAgentDefinition, getAgentCapabilities } from '../agents';
import { buildAgentArgs, applyAgentConfigOverrides } from '../utils/agent-args';
import {
	wrapSpawnWithSsh,
	sshUnresolvedRemoteMessage,
	type SshSpawnWrapConfig,
} from '../utils/ssh-spawn-wrapper';
import { buildAgentLaunchPlan } from '../../shared/maestro-lib/launch/launch-plan';
import { buildSpawnPath } from '../utils/spawnPath';
import { QUERY_SOURCE_ENV_VAR } from '../../shared/querySource';
import { ensureRemoteMaestroPProbed } from '../agents/probeRemoteMaestroP';
import { sanitizeCustomEnvVars } from './cue-env-sanitizer';
import {
	resolveClaudeSpawnMode,
	applyClaudeSpawnDecision,
	buildRemoteInteractiveSpawn,
} from '../agents/resolveClaudeSpawnMode';
import { getClaudeTokenMode } from '../../shared/claudeTokenMode';

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
 * 3. Apply config overrides (custom model, args)
 * 4. Plan the launch (target, command, env, prompt delivery) via
 *    `buildAgentLaunchPlan`, failing on an unresolvable SSH remote
 * 5. Wrap a remote launch with SSH, or realize a local maestro-p decision
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

	// Sanitize every user-set env layer BEFORE it reaches the spawn environment.
	// This drops blocklisted names (PATH, HOME, USER, SHELL, LD_PRELOAD,
	// DYLD_INSERT_LIBRARIES, NODE_OPTIONS) and any name that does not match the
	// POSIX identifier regex. Provider defaults are Maestro's own and pass as-is.
	const sanitizeLayer = (vars: Record<string, string> | undefined) =>
		vars === undefined ? undefined : sanitizeCustomEnvVars(vars, config.onLog).sanitized;

	// 4. The launch plan decides where the run happens, what it execs, its
	// environment and how the prompt reaches it, as the `cue` surface: the
	// inherited environment, then the provider defaults, then the agent's own
	// vars, with the prompt on the command line. An SSH remote that cannot be
	// resolved fails the run here: it never falls back to running the agent on
	// this machine.
	const planResult = buildAgentLaunchPlan({
		surface: 'cue',
		agent: { ...agentDef, capabilities: agentConfig.capabilities },
		command: customPath || agentDef.command,
		args: finalArgs,
		cwd: projectRoot,
		prompt: substitutedPrompt,
		agentCustomEnvVars: sanitizeLayer(
			(agentConfigValues as Record<string, unknown> | undefined)?.customEnvVars as
				| Record<string, string>
				| undefined
		),
		sessionCustomEnvVars: sanitizeLayer(customEnvVars),
		// A Cue run is a Cue run no matter what the agent's env overrides say.
		// Without this every downstream consumer of the spawned process (Claude
		// Code hooks, telemetry sidecars) sees a turn indistinguishable from one
		// the user typed, because Cue prompts ARE the user's words from cue.yaml.
		querySource: 'cue',
		isServerMode: config.isServerMode,
		sshRemoteConfig,
		sshStore,
	});
	if (!planResult.ok) {
		return { ok: false, message: planResult.error };
	}
	const plan = planResult.plan;

	let command = plan.command;
	let spawnArgs = plan.args;
	let spawnCwd = plan.cwd;
	let spawnEnv: Record<string, string> = (plan.env ?? { ...process.env }) as Record<string, string>;
	let sshStdinScript: string | undefined;
	let sshRemoteCommand: string | undefined;
	let stdinPrompt: string | undefined = plan.stdin;
	let sshRemoteUsed: SpawnSpec['sshRemoteUsed'];

	// 4b. Resolve the Claude token source (TUI / API / dynamic) the same way the
	// desktop `process:spawn` handler does, so a Cue run honors the triggering
	// agent's selection. SSH spawns resolve to `api` (the resolver short-circuits
	// on sshEnabled), because maestro-p needs the local TUI and SSH runs
	// `claude --print`. Over SSH, warm the remote maestro-p probe BEFORE resolving
	// so a headless Cue spawn falls a remote TUI selection back to API instead of
	// exiting 127 when maestro-p isn't installed on the remote (no UI/readiness
	// probe runs first).
	const remoteTarget = plan.target.kind === 'remote' ? plan.target.remote : undefined;
	const remoteMaestroPAvailable = remoteTarget
		? await ensureRemoteMaestroPProbed(remoteTarget)
		: undefined;
	const tokenMode = getClaudeTokenMode(
		{
			enableMaestroP: config.enableMaestroP,
			maestroPMode: config.maestroPMode,
		},
		// Remote agents default to the TUI when the user hasn't chosen, unless the
		// remote has no maestro-p to run it (then API).
		{ sshEnabled: !!remoteTarget, sshMaestroPAvailable: remoteMaestroPAvailable }
	);
	const claudeSpawnDecision = resolveClaudeSpawnMode({
		agent: {
			id: agentDef.id,
			interactiveCommand: agentDef.interactiveCommand,
			interactiveModeArgs: agentDef.interactiveModeArgs,
			defaultEnvVars: agentDef.defaultEnvVars,
		},
		tokenMode,
		sshEnabled: !!remoteTarget,
		// Lets the resolver fall a remote TUI spawn back to API when the remote
		// has no maestro-p on its PATH (avoids exit 127).
		sshRemoteId: sshRemoteConfig?.remoteId ?? undefined,
		command: customPath || agentDef.command,
		sessionCustomPath: config.customPath,
		sessionCustomEnvVars: plan.envVars,
		maestroPPath: config.maestroPPath,
		now: new Date(),
	});

	if (remoteTarget && sshRemoteConfig && sshStore) {
		// 5. Remote: hand the plan to the SSH wrapper, which owns the ssh command
		// and places the prompt (inline or through its stdin script). Claude
		// interactive/dynamic over SSH runs maestro-p on the remote host (must be
		// on its PATH) to drive the remote TUI on the Max subscription, honoring
		// the Cue run's configured timeout as the idle budget. Null for the API
		// path, leaving the SSH config on the plain claude binary.
		const remoteInteractive = buildRemoteInteractiveSpawn({
			decision: claudeSpawnDecision,
			interactiveModeArgs: agentDef.interactiveModeArgs,
			remoteClaudeBin: claudeSpawnDecision.claudeRealBinPath,
			maxWaitSeconds: Math.ceil(config.timeoutMs / 1000),
		});
		const sshWrapConfig: SshSpawnWrapConfig = {
			command: plan.command,
			args: remoteInteractive ? [...remoteInteractive.prependArgs, ...plan.args] : plan.args,
			cwd: plan.cwd,
			prompt: substitutedPrompt,
			customEnvVars: remoteInteractive
				? { ...(plan.envVars ?? {}), ...remoteInteractive.env }
				: plan.envVars,
			agentBinaryName: remoteInteractive ? remoteInteractive.command : plan.command,
			promptArgs: agentDef.promptArgs,
			noPromptSeparator: agentDef.noPromptSeparator,
			querySource: 'cue',
		};

		const sshResult = await wrapSpawnWithSsh(sshWrapConfig, sshRemoteConfig, sshStore);
		if (!sshResult.sshRemoteUsed) {
			// The plan resolved this remote a moment ago; losing it now is still a
			// failure, not a reason to run locally.
			return { ok: false, message: sshUnresolvedRemoteMessage(sshRemoteConfig) };
		}
		command = sshResult.command;
		spawnArgs = sshResult.args;
		spawnCwd = sshResult.cwd;
		// The local ssh client inherits this process's env (SSH_AUTH_SOCK and the
		// like); the agent's own vars travel inside the ssh command or script.
		spawnEnv = {
			...process.env,
			PATH: buildSpawnPath(),
			...(sshResult.customEnvVars ?? {}),
			[QUERY_SOURCE_ENV_VAR]: 'cue',
		} as Record<string, string>;
		sshStdinScript = sshResult.sshStdinScript;
		sshRemoteCommand = sshResult.sshRemoteCommand;
		stdinPrompt = sshResult.prompt;
		sshRemoteUsed = sshResult.sshRemoteUsed;
	} else if (claudeSpawnDecision.mode === 'interactive' && claudeSpawnDecision.maestroPBinPath) {
		// 6. Realize an interactive (maestro-p) decision for a local run. Applied
		// to the planned args, which already end with the prompt, so the maestro-p
		// script + interactive flags come FIRST and the prompt stays LAST
		// (maestro-p strips the headless-only flags, forwards the rest to the
		// claude TUI, and reads the trailing positional as the prompt). The vars
		// it adds (MAESTRO_CLAUDE_BIN and its Node settings) are merged over the
		// planned env, which already holds the agent's own.
		const applied = applyClaudeSpawnDecision({
			decision: claudeSpawnDecision,
			interactiveModeArgs: agentDef.interactiveModeArgs,
			command,
			args: spawnArgs,
			customEnvVars: {},
			// Honor the Cue run's configured timeout as maestro-p's idle budget
			// (`--max-wait`) instead of its 300s default. Without this a Cue
			// prompt dispatch through maestro-p was capped at 300s regardless of
			// `timeout_minutes`, killing every long-running background turn.
			maxWaitSeconds: Math.ceil(config.timeoutMs / 1000),
		});
		command = applied.command;
		spawnArgs = applied.args;
		spawnEnv = { ...spawnEnv, ...(applied.customEnvVars ?? {}) };
	}

	return {
		ok: true,
		spec: {
			command,
			args: spawnArgs,
			cwd: spawnCwd,
			env: spawnEnv,
			sshStdinScript,
			sshRemoteCommand,
			stdinPrompt,
			sshRemoteUsed,
		},
	};
}
