import type { AgentConfig } from '../agents';
import { logger } from './logger';

const LOG_CONTEXT = '[AgentArgs]';

type BuildAgentArgsOptions = {
	baseArgs: string[];
	prompt?: string;
	cwd?: string;
	readOnlyMode?: boolean;
	modelId?: string;
	yoloMode?: boolean;
	agentSessionId?: string;
	/**
	 * Force the agent's batch-mode args (batchModePrefix / batchModeArgs /
	 * jsonOutputArgs) to be applied even when `prompt` is an empty string. The
	 * default behavior gates these on `options.prompt` being truthy so that a
	 * bare interactive launch (no prompt) doesn't accidentally enable batch
	 * mode. Callers that NEVER launch interactive mode — e.g. Cue, which spawns
	 * with `stdio: ['ignore', 'pipe', 'pipe']` and no TTY — must set this so an
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

/** Parse a space-separated custom args string into an array, respecting quoted segments. */
function parseCustomArgs(customArgs?: string): string[] {
	if (!customArgs || typeof customArgs !== 'string') {
		return [];
	}

	const customArgsArray = customArgs.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
	return customArgsArray.map((arg) => {
		if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
			return arg.slice(1, -1);
		}
		return arg;
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
	// present with a different value — avoid appending a conflicting duplicate
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
		// when readOnlyMode is active. Batch mode args grant write/approval permissions
		// that conflict with read-only intent, regardless of whether the agent has
		// CLI-enforced read-only mode or prompt-only enforcement.
		if (!options.readOnlyMode) {
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
		finalArgs = [...finalArgs, ...agent.workingDirArgs(options.cwd)];
	}

	if (options.readOnlyMode && agent.readOnlyArgs) {
		finalArgs = [...finalArgs, ...agent.readOnlyArgs];
	}

	if (options.readOnlyMode && agent.readOnlyCliEnforced === false) {
		logger.warn(
			`Agent ${agent.name}: read-only mode requested but no CLI-level enforcement available`,
			LOG_CONTEXT,
			{ agentId: agent.id }
		);
	}

	if (options.modelId && agent.modelArgs) {
		finalArgs = [...finalArgs, ...agent.modelArgs(options.modelId)];
	}

	if (options.yoloMode && agent.yoloModeArgs) {
		finalArgs = [...finalArgs, ...agent.yoloModeArgs];
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

	return dedupedArgs;
}

/** Apply agent configuration overrides (custom args, env vars, model selection) to base args. */
export function applyAgentConfigOverrides(
	agent: AgentConfig | null | undefined,
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
				overrides.sessionCustomEffort !== undefined
			) {
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

	const parsedCustomArgs = parseCustomArgs(effectiveCustomArgs);
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
