import type { AgentConfig, AgentDefinition } from '../agents';
import type { AdditionalDirectory } from '../../shared/types';
import { logger } from './logger';

/** Fields applyAgentConfigOverrides actually reads. Accepting this narrower
 * shape lets CLI callers pass AgentDefinition (no capabilities/available). */
type AgentConfigOverridable = Pick<AgentConfig, 'configOptions' | 'defaultEnvVars'>;

const LOG_CONTEXT = '[AgentArgs]';

type BuildAgentArgsOptions = {
	baseArgs: string[];
	prompt?: string;
	cwd?: string;
	readOnlyMode?: boolean;
	modelId?: string;
	yoloMode?: boolean;
	permissionMode?: 'full' | 'standard' | 'readonly';
	agentSessionId?: string;
	/**
	 * The session's Additional Directories. Providers that declare
	 * `supportsAdditionalDirectories` turn these into native grant flags; the rest
	 * ignore them here and rely on the system-prompt block instead.
	 */
	additionalDirectories?: AdditionalDirectory[];
	/**
	 * Force the agent's batch-mode args (batchModePrefix / batchModeArgs /
	 * jsonOutputArgs) to be applied even when `prompt` is an empty string. The
	 * default behavior gates these on `options.prompt` being truthy so that a
	 * bare interactive launch (no prompt) doesn't accidentally enable batch
	 * mode. Callers that NEVER launch interactive mode - e.g. Cue, which spawns
	 * with `stdio: ['ignore', 'pipe', 'pipe']` and no TTY - must set this so an
	 * empty-after-substitution prompt (e.g. `{{CUE_SOURCE_OUTPUT}}` resolving
	 * to `""` when the upstream run produced no parseable stdout) doesn't
	 * silently fall back to interactive mode and fail with
	 * "stdin is not a terminal".
	 */
	forceBatchMode?: boolean;
};

type AgentConfigOverrides = {
	agentConfigValues?: Record<string, any>;
	sessionCustomModel?: string;
	sessionCustomEffort?: string;
	sessionCustomArgs?: string;
	sessionCustomEnvVars?: Record<string, string>;
};

type AgentConfigResolution = {
	args: string[];
	effectiveCustomEnvVars?: Record<string, string>;
	customArgsSource: 'session' | 'agent' | 'none';
	customEnvSource: 'session' | 'agent' | 'none';
	modelSource: 'session' | 'agent' | 'default';
};

/**
 * Split a space-separated argument string while preserving the established
 * quote-only grouping contract. This is intentionally not shell parsing:
 * backslashes are literal, quotes are only stripped when they wrap a token,
 * and unmatched opening quotes fall back to ordinary non-whitespace tokens.
 */
export function parseQuotedArgs(value?: string): string[] {
	if (!value || typeof value !== 'string') {
		return [];
	}

	const tokens = value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
	return tokens.map((token) => {
		if (
			(token.startsWith('"') && token.endsWith('"')) ||
			(token.startsWith("'") && token.endsWith("'"))
		) {
			return token.slice(1, -1);
		}
		return token;
	});
}

/** Check whether jsonOutputArgs (exact sequence or flag key) are already present in the args list. */
function hasJsonOutputFlag(haystack: string[], jsonOutputArgs: string[]): boolean {
	if (jsonOutputArgs.length === 0) return true;

	// Check if the exact arg sequence is already present
	for (let i = 0; i <= haystack.length - jsonOutputArgs.length; i++) {
		let match = true;
		for (let j = 0; j < jsonOutputArgs.length; j++) {
			if (haystack[i + j] !== jsonOutputArgs[j]) {
				match = false;
				break;
			}
		}
		if (match) return true;
	}

	// Also check if the flag key (e.g., --format, --output-format) is already
	// present with a different value - avoid appending a conflicting duplicate
	// that the dedup step would mangle.
	const flagKey = jsonOutputArgs[0];
	if (flagKey?.startsWith('-') && jsonOutputArgs.length > 1) {
		return haystack.includes(flagKey);
	}

	return false;
}

/** Build the final CLI arguments for an agent process based on mode, config, and user options. */
export function buildAgentArgs(
	agent: AgentConfig | null | undefined,
	options: BuildAgentArgsOptions
): string[] {
	let finalArgs = [...options.baseArgs];

	if (!agent) {
		return finalArgs;
	}

	// Resolve effective permission level. permissionMode takes precedence over the
	// legacy readOnlyMode/yoloMode booleans when set explicitly.
	const isFullAccess =
		options.permissionMode === 'full' ||
		(options.permissionMode === undefined && options.yoloMode === true);
	const isReadOnly =
		options.permissionMode === 'readonly' ||
		(options.permissionMode === undefined && options.readOnlyMode === true);

	// Batch-mode gate: normally we infer "batch mode" from the presence of a
	// truthy prompt, so a bare interactive launch (no prompt) doesn't get batch
	// args it never asked for. Callers that never launch interactive mode pass
	// `forceBatchMode: true` so this path still fires when the prompt is an
	// empty string (e.g. a Cue template variable that resolved to nothing).
	const inBatchMode = Boolean(options.prompt) || options.forceBatchMode === true;

	if (agent.batchModePrefix && inBatchMode) {
		finalArgs = [...agent.batchModePrefix, ...finalArgs];
	}

	if (agent.batchModeArgs && inBatchMode) {
		// Skip batch mode args (e.g. -y, --dangerously-bypass-approvals-and-sandbox)
		// when in read-only mode. Batch mode args grant write/approval permissions
		// that conflict with read-only intent, regardless of whether the agent has
		// CLI-enforced read-only mode or prompt-only enforcement.
		if (!isReadOnly) {
			finalArgs = [...finalArgs, ...agent.batchModeArgs];
		}
	}

	// Only inject JSON output args when a prompt is provided (batch/non-interactive mode).
	// Interactive sessions must not receive these flags (e.g., Copilot rejects --output-format json
	// in interactive mode). Agents that need JSON output in interactive mode should include
	// the relevant flags in their base `args` or `batchModeArgs` instead.
	if (agent.jsonOutputArgs && inBatchMode && !hasJsonOutputFlag(finalArgs, agent.jsonOutputArgs)) {
		finalArgs = [...finalArgs, ...agent.jsonOutputArgs];
	}

	if (agent.workingDirArgs && options.cwd) {
		// Prepend so the directory flag lands before any subcommand (e.g. Codex
		// `exec`). Codex treats `-C` as a root-level global flag - placing it
		// after the subcommand makes it silently ignored (#959).
		finalArgs = [...agent.workingDirArgs(options.cwd), ...finalArgs];
	}

	if (isFullAccess) {
		// Prefer fullAccessArgs over the legacy yoloModeArgs alias.
		const fullArgs = agent.fullAccessArgs ?? agent.yoloModeArgs;
		if (fullArgs) {
			finalArgs = [...finalArgs, ...fullArgs];
		}
	} else if (isReadOnly) {
		if (agent.readOnlyArgs) {
			finalArgs = [...finalArgs, ...agent.readOnlyArgs];
		}
		if (agent.readOnlyCliEnforced === false) {
			logger.warn(
				`Agent ${agent.name}: read-only mode requested but no CLI-level enforcement available`,
				LOG_CONTEXT,
				{ agentId: agent.id }
			);
		}
	}
	// standard mode: no bypass args, no read-only args - agent uses its default permission model

	if (options.modelId && agent.modelArgs) {
		finalArgs = [...finalArgs, ...agent.modelArgs(options.modelId)];
	}

	if (options.agentSessionId && agent.resumeArgs) {
		finalArgs = [...finalArgs, ...agent.resumeArgs(options.agentSessionId)];
	}

	// Deduplicate repeated flag-style arguments while preserving order.
	// Positional arguments (non-flags) are intentionally left untouched.
	const seenFlags = new Set<string>();
	const dedupedArgs: string[] = [];
	for (const arg of finalArgs) {
		if (arg.startsWith('-')) {
			if (seenFlags.has(arg)) {
				continue;
			}
			seenFlags.add(arg);
		}
		dedupedArgs.push(arg);
	}

	// Additional Directories are appended AFTER the dedupe on purpose. Every
	// provider expresses a multi-directory grant by repeating its flag
	// (`--add-dir a --add-dir b`), and the dedupe above drops repeated flag
	// tokens - it would keep the first `--add-dir`, delete the second, and leave
	// the orphaned path behind as a stray positional that the CLI would read as
	// the prompt. Emitting them last also keeps them ahead of the prompt, which
	// callers append after this function returns.
	return [...dedupedArgs, ...buildAdditionalDirArgs(agent, options.additionalDirectories)];
}

/**
 * Translate the session's directory grants into provider-native CLI args.
 *
 * Returns [] for providers that have no native mechanism - they still receive
 * the grants through the `{{ADDITIONAL_DIRECTORIES}}` system-prompt block, which
 * is built independently of this path. Exported so the CLI spawner
 * (`src/cli/services/agent-spawner.ts`), which assembles args itself rather than
 * calling `buildAgentArgs`, produces byte-identical flags.
 */
export function buildAdditionalDirArgs(
	agent: Pick<AgentConfig, 'additionalDirArgs'> | AgentDefinition | null | undefined,
	dirs: AdditionalDirectory[] | undefined
): string[] {
	if (!agent?.additionalDirArgs || !dirs?.length) {
		return [];
	}
	return agent.additionalDirArgs(dirs);
}

/** Apply agent configuration overrides (custom args, env vars, model selection) to base args. */
export function applyAgentConfigOverrides(
	agent: AgentConfigOverridable | AgentDefinition | AgentConfig | null | undefined,
	baseArgs: string[],
	overrides: AgentConfigOverrides
): AgentConfigResolution {
	let finalArgs = [...baseArgs];
	const agentConfigValues = overrides.agentConfigValues ?? {};
	let modelSource: AgentConfigResolution['modelSource'] = 'default';

	if (agent && agent.configOptions) {
		for (const option of agent.configOptions) {
			if (!option.argBuilder) {
				continue;
			}

			let value: any;
			if (option.key === 'model') {
				if (overrides.sessionCustomModel !== undefined && overrides.sessionCustomModel !== '') {
					value = overrides.sessionCustomModel;
					modelSource = 'session';
				} else if (agentConfigValues[option.key] !== undefined) {
					value = agentConfigValues[option.key];
					modelSource = 'agent';
				} else {
					value = option.default;
					modelSource = 'default';
				}
			} else if (
				(option.key === 'effort' || option.key === 'reasoningEffort') &&
				overrides.sessionCustomEffort !== undefined &&
				overrides.sessionCustomEffort !== ''
			) {
				// Empty means "cleared" and falls through to the agent-level config, the
				// same rule `model` uses above - and the same order the effort pill shows
				// (tab > agent override > agent config).
				value = overrides.sessionCustomEffort;
			} else {
				value =
					agentConfigValues[option.key] !== undefined
						? agentConfigValues[option.key]
						: option.default;
			}

			// Type assertion needed because AgentConfigOption is a discriminated union
			// and we're handling all types generically here
			const argBuilderFn = option.argBuilder as (value: unknown) => string[];
			finalArgs = [...finalArgs, ...argBuilderFn(value)];
		}
	}

	const effectiveCustomArgs = overrides.sessionCustomArgs ?? agentConfigValues.customArgs;
	let customArgsSource: AgentConfigResolution['customArgsSource'] = overrides.sessionCustomArgs
		? 'session'
		: agentConfigValues.customArgs
			? 'agent'
			: 'none';

	const parsedCustomArgs = parseQuotedArgs(effectiveCustomArgs);
	if (parsedCustomArgs.length > 0) {
		finalArgs = [...finalArgs, ...parsedCustomArgs];
	} else {
		customArgsSource = 'none';
	}

	// Merge env vars: agent defaults (lowest) < agent config (medium) < session overrides (highest)
	// User-configured vars override agent defaults; session vars override both
	const userEnvVars =
		overrides.sessionCustomEnvVars ??
		(agentConfigValues.customEnvVars as Record<string, string> | undefined);
	const agentDefaultEnvVars = agent?.defaultEnvVars;

	// Start with agent defaults, then layer on user config
	let effectiveCustomEnvVars: Record<string, string> | undefined;
	if (agentDefaultEnvVars || userEnvVars) {
		effectiveCustomEnvVars = {
			...(agentDefaultEnvVars || {}),
			...(userEnvVars || {}),
		};
	}

	const hasEnvVars = effectiveCustomEnvVars && Object.keys(effectiveCustomEnvVars).length > 0;
	const customEnvSource: AgentConfigResolution['customEnvSource'] = overrides.sessionCustomEnvVars
		? 'session'
		: agentConfigValues.customEnvVars
			? 'agent'
			: 'none';

	return {
		args: finalArgs,
		effectiveCustomEnvVars: hasEnvVars ? effectiveCustomEnvVars : undefined,
		customArgsSource,
		customEnvSource: hasEnvVars ? customEnvSource : 'none',
		modelSource,
	};
}

/** Resolve the effective context window size from session, agent config, or defaults. */
export function getContextWindowValue(
	agent: AgentConfig | null | undefined,
	agentConfigValues: Record<string, any>,
	sessionCustomContextWindow?: number
): number {
	// Session-level override takes priority
	if (typeof sessionCustomContextWindow === 'number' && sessionCustomContextWindow > 0) {
		return sessionCustomContextWindow;
	}
	// Fall back to agent-level config
	const contextWindowOption = agent?.configOptions?.find(
		(option) => option.key === 'contextWindow' && option.type === 'number'
	);
	// Extract default value, ensuring it's a number (contextWindow should always be a number config)
	const defaultValue = contextWindowOption?.default;
	const contextWindowDefault = typeof defaultValue === 'number' ? defaultValue : 0;
	return typeof agentConfigValues.contextWindow === 'number'
		? agentConfigValues.contextWindow
		: contextWindowDefault;
}
