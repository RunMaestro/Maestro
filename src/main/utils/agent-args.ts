import type { AgentConfig } from '../agent-detector';

type BuildAgentArgsOptions = {
	baseArgs: string[];
	prompt?: string;
	cwd?: string;
	readOnlyMode?: boolean;
	modelId?: string;
	yoloMode?: boolean;
	agentSessionId?: string;
};

type AgentConfigOverrides = {
	agentConfigValues?: Record<string, any>;
	sessionCustomModel?: string;
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

export function buildAgentArgs(
	agent: AgentConfig | null | undefined,
	options: BuildAgentArgsOptions
): string[] {
	let finalArgs = [...options.baseArgs];

	if (!agent) {
		return finalArgs;
	}

	if (agent.batchModePrefix && options.prompt) {
		finalArgs = [...agent.batchModePrefix, ...finalArgs];
	}

	if (agent.batchModeArgs && options.prompt) {
		finalArgs = [...finalArgs, ...agent.batchModeArgs];
	}

	if (agent.jsonOutputArgs && !finalArgs.some((arg) => agent.jsonOutputArgs!.includes(arg))) {
		finalArgs = [...finalArgs, ...agent.jsonOutputArgs];
	}

	if (agent.workingDirArgs && options.cwd) {
		finalArgs = [...finalArgs, ...agent.workingDirArgs(options.cwd)];
	}

	if (options.readOnlyMode && agent.readOnlyArgs) {
		finalArgs = [...finalArgs, ...agent.readOnlyArgs];
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

	return finalArgs;
}

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
				if (overrides.sessionCustomModel !== undefined) {
					value = overrides.sessionCustomModel;
					modelSource = 'session';
				} else if (agentConfigValues[option.key] !== undefined) {
					value = agentConfigValues[option.key];
					modelSource = 'agent';
				} else {
					value = option.default;
					modelSource = 'default';
				}
			} else {
				value =
					agentConfigValues[option.key] !== undefined
						? agentConfigValues[option.key]
						: option.default;
			}

			finalArgs = [...finalArgs, ...option.argBuilder(value)];
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
		(option) => option.key === 'contextWindow'
	);
	const contextWindowDefault = contextWindowOption?.default ?? 0;
	return typeof agentConfigValues.contextWindow === 'number'
		? agentConfigValues.contextWindow
		: contextWindowDefault;
}
