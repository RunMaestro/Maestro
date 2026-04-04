// Agent-specific configuration commands
// Manages per-agent settings in maestro-agent-configs.json

import {
	readAgentConfigs,
	readAgentConfig,
	readAgentConfigValue,
	writeAgentConfigValue,
	deleteAgentConfigValue,
} from '../services/storage';
import {
	formatSettingsList,
	formatSettingDetail,
	formatError,
	formatSuccess,
	formatWarning,
	type SettingDisplay,
} from '../output/formatter';
import { emitJsonl } from '../output/jsonl';

// Known agent config keys with descriptions for --verbose mode
const AGENT_CONFIG_METADATA: Record<string, { description: string; type: string }> = {
	customPath: {
		description: 'Custom path to the agent CLI binary. Overrides PATH detection.',
		type: 'string',
	},
	customArgs: {
		description: 'Additional CLI arguments appended when spawning the agent.',
		type: 'string',
	},
	customEnvVars: {
		description:
			'Extra environment variables injected when spawning the agent. Object mapping names to values.',
		type: 'object',
	},
	model: {
		description: 'Model override for the agent (e.g., gpt-5.3-codex, claude-3.5-sonnet).',
		type: 'string',
	},
	contextWindow: {
		description: 'Maximum context window size in tokens. Used for context usage display.',
		type: 'number',
	},
	reasoningEffort: {
		description: 'Reasoning effort level for agents that support it (low, medium, high).',
		type: 'string',
	},
};

interface AgentListOptions {
	json?: boolean;
	verbose?: boolean;
}

interface AgentGetOptions {
	json?: boolean;
	verbose?: boolean;
}

interface AgentSetOptions {
	json?: boolean;
	raw?: string;
}

interface AgentResetOptions {
	json?: boolean;
}

/**
 * Parse a CLI value string into the appropriate JS type.
 */
function parseValue(input: string): unknown {
	if (input === 'true') return true;
	if (input === 'false') return false;
	if (input === 'null') return null;
	if (input !== '' && !/^0\d/.test(input)) {
		const num = Number(input);
		if (!isNaN(num) && isFinite(num)) return num;
	}
	if (input.startsWith('[') || input.startsWith('{')) {
		try {
			return JSON.parse(input);
		} catch {
			// Fall through to string
		}
	}
	return input;
}

/**
 * List all agent configs, or a single agent's config.
 */
export function settingsAgentList(agentId: string | undefined, options: AgentListOptions): void {
	try {
		if (agentId) {
			// Show config for a specific agent
			const config = readAgentConfig(agentId);
			if (Object.keys(config).length === 0) {
				if (options.json) {
					console.log(JSON.stringify({}));
				} else {
					console.log(formatWarning(`No configuration found for agent "${agentId}".`));
				}
				return;
			}

			const entries: SettingDisplay[] = Object.entries(config).map(([key, value]) => {
				const meta = AGENT_CONFIG_METADATA[key];
				return {
					key,
					value,
					type: meta?.type ?? typeof value,
					category: `Agent: ${agentId}`,
					description: meta?.description,
				};
			});

			if (options.json) {
				for (const entry of entries) {
					emitJsonl({
						type: 'setting',
						agentId,
						key: entry.key,
						value: entry.value,
						valueType: entry.type,
						category: entry.category,
						...(options.verbose ? { description: entry.description } : {}),
					});
				}
			} else {
				console.log(formatSettingsList(entries, { verbose: options.verbose }));
			}
		} else {
			// Show all agent configs
			const allConfigs = readAgentConfigs();
			const agentIds = Object.keys(allConfigs).sort();

			if (agentIds.length === 0) {
				if (options.json) {
					console.log(JSON.stringify({}));
				} else {
					console.log(formatWarning('No agent configurations found.'));
				}
				return;
			}

			const entries: SettingDisplay[] = [];
			for (const id of agentIds) {
				const config = allConfigs[id];
				for (const [key, value] of Object.entries(config)) {
					const meta = AGENT_CONFIG_METADATA[key];
					entries.push({
						key: `${id}.${key}`,
						value,
						type: meta?.type ?? typeof value,
						category: `Agent: ${id}`,
						description: meta?.description,
					});
				}
			}

			if (options.json) {
				for (const entry of entries) {
					emitJsonl({
						type: 'setting',
						key: entry.key,
						value: entry.value,
						valueType: entry.type,
						category: entry.category,
						...(options.verbose ? { description: entry.description } : {}),
					});
				}
			} else {
				console.log(formatSettingsList(entries, { verbose: options.verbose }));
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		if (options.json) {
			console.error(JSON.stringify({ error: message }));
		} else {
			console.error(formatError(`Failed to list agent configs: ${message}`));
		}
		process.exit(1);
	}
}

/**
 * Get a single agent config value.
 */
export function settingsAgentGet(agentId: string, key: string, options: AgentGetOptions): void {
	try {
		const value = readAgentConfigValue(agentId, key);
		const meta = AGENT_CONFIG_METADATA[key];

		if (options.json) {
			emitJsonl({
				type: 'setting',
				agentId,
				key,
				value,
				valueType: meta?.type ?? typeof value,
				category: `Agent: ${agentId}`,
				...(options.verbose && meta ? { description: meta.description } : {}),
			});
		} else {
			if (options.verbose && meta) {
				const display: SettingDisplay = {
					key,
					value,
					type: meta.type,
					category: `Agent: ${agentId}`,
					description: meta.description,
				};
				console.log(formatSettingDetail(display));
			} else {
				if (typeof value === 'object' && value !== null) {
					console.log(JSON.stringify(value, null, 2));
				} else {
					console.log(value === undefined ? '' : String(value));
				}
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		if (options.json) {
			console.error(JSON.stringify({ error: message }));
		} else {
			console.error(formatError(message));
		}
		process.exit(1);
	}
}

/**
 * Set a single agent config value.
 */
export function settingsAgentSet(
	agentId: string,
	key: string,
	value: string,
	options: AgentSetOptions
): void {
	try {
		const oldValue = readAgentConfigValue(agentId, key);

		let parsedValue: unknown;
		if (options.raw !== undefined) {
			try {
				parsedValue = JSON.parse(options.raw);
			} catch (e) {
				throw new Error(`Invalid JSON in --raw: ${e instanceof Error ? e.message : String(e)}`);
			}
		} else {
			parsedValue = parseValue(value);
		}

		writeAgentConfigValue(agentId, key, parsedValue);

		if (options.json) {
			emitJsonl({
				type: 'setting_set',
				agentId,
				key,
				oldValue,
				newValue: parsedValue,
			});
		} else {
			console.log(formatSuccess(`${agentId}.${key} = ${JSON.stringify(parsedValue)}`));
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		if (options.json) {
			console.error(JSON.stringify({ error: message }));
		} else {
			console.error(formatError(`Failed to set "${agentId}.${key}": ${message}`));
		}
		process.exit(1);
	}
}

/**
 * Reset (delete) a single agent config key.
 */
export function settingsAgentReset(agentId: string, key: string, options: AgentResetOptions): void {
	try {
		const oldValue = readAgentConfigValue(agentId, key);
		const removed = deleteAgentConfigValue(agentId, key);

		if (!removed) {
			throw new Error(`Key "${key}" not found in agent "${agentId}" config.`);
		}

		if (options.json) {
			emitJsonl({
				type: 'setting_reset',
				agentId,
				key,
				oldValue,
				defaultValue: undefined,
			});
		} else {
			console.log(formatSuccess(`${agentId}.${key} removed`));
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		if (options.json) {
			console.error(JSON.stringify({ error: message }));
		} else {
			console.error(formatError(`Failed to reset "${agentId}.${key}": ${message}`));
		}
		process.exit(1);
	}
}
