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

// ─── Types ──────���────────────────────────────────────────────────────────────

/** Fully resolved spawn specification — everything needed to call spawn(). */
export interface SpawnSpec {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	/** For SSH stdin-script mode: full bash script to send via stdin */
	sshStdinScript?: string;
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
	const effectiveEnvVars = configResolution.effectiveCustomEnvVars;

	// Determine command
	let command = customPath || agentDef.command;
	let spawnArgs = finalArgs;
	let spawnCwd = projectRoot;
	let spawnEnvVars = effectiveEnvVars;
	let sshStdinScript: string | undefined;
	let stdinPrompt: string | undefined;
	let sshRemoteUsed: SpawnSpec['sshRemoteUsed'];

	// 4. Apply SSH wrapping if configured
	if (sshRemoteConfig?.enabled && sshStore) {
		const sshWrapConfig: SshSpawnWrapConfig = {
			command,
			args: finalArgs,
			cwd: projectRoot,
			prompt: substitutedPrompt,
			customEnvVars: effectiveEnvVars,
			agentBinaryName: agentDef.binaryName,
			promptArgs: agentDef.promptArgs,
			noPromptSeparator: agentDef.noPromptSeparator,
		};

		const sshResult = await wrapSpawnWithSsh(sshWrapConfig, sshRemoteConfig, sshStore);
		command = sshResult.command;
		spawnArgs = sshResult.args;
		spawnCwd = sshResult.cwd;
		spawnEnvVars = sshResult.customEnvVars;
		sshStdinScript = sshResult.sshStdinScript;
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
			stdinPrompt,
			sshRemoteUsed,
		},
	};
}
