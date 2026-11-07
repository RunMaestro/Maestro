// Agent-specific configuration commands
// Manages per-provider-type settings in maestro-agent-configs.json. `list` and
// `get` also accept the ID of one agent in the Left Bar, and then read that
// agent's own settings (the fields `update-agent` writes) from its record.

import {
	readAgentConfigs,
	readAgentConfig,
	readAgentConfigValue,
	writeAgentConfigValue,
	deleteAgentConfigValue,
	getSessionById,
} from '../services/storage';
import {
	readAgentSessionSettings,
	AGENT_SESSION_SETTING_METADATA,
} from '../services/agent-settings';
import { isValidAgentId } from '../../shared/agentIds';
import type { SessionInfo } from '../../shared/types';
import {
	formatSettingsList,
	formatSettingDetail,
	formatSuccess,
	formatWarning,
	type SettingDisplay,
} from '../output/formatter';
import { emitJsonl } from '../output/jsonl';
import { failCommand } from '../services/session-command';

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
	reasoningSummary: {
		description:
			'Codex reasoning summary mode (auto, concise, detailed, none); empty inherits the provider default.',
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

type SettingsTarget = { kind: 'provider'; id: string } | { kind: 'agent'; agent: SessionInfo };

/**
 * Decide which store an `<agent-id>` argument names. A provider type (or any
 * key already in maestro-agent-configs.json) reads the provider config. An ID
 * or unique prefix of an agent in the Left Bar reads that agent's own record,
 * where `update-agent` writes. Anything else stays on the provider store, as
 * before.
 */
function resolveSettingsTarget(agentId: string): SettingsTarget {
	if (isValidAgentId(agentId) || agentId in readAgentConfigs()) {
		return { kind: 'provider', id: agentId };
	}
	const agent = getSessionById(agentId);
	return agent ? { kind: 'agent', agent } : { kind: 'provider', id: agentId };
}

function agentSettingEntries(agent: SessionInfo): SettingDisplay[] {
	return Object.entries(readAgentSessionSettings(agent)).map(([key, value]) => {
		const meta = AGENT_SESSION_SETTING_METADATA[key as keyof typeof AGENT_SESSION_SETTING_METADATA];
		return {
			key,
			value,
			type: meta.type,
			category: `Agent: ${agent.name} (${agent.id})`,
			description: meta.description,
		};
	});
}

/** `set` and `reset` only write provider defaults; an agent is edited with `update-agent`. */
function assertProviderTarget(agentId: string): void {
	const target = resolveSettingsTarget(agentId);
	if (target.kind === 'agent') {
		throw new Error(
			`"${agentId}" is the agent "${target.agent.name}", not a provider type. ` +
				`"settings agent set/reset" write per-provider defaults. ` +
				`Use "maestro-cli update-agent ${target.agent.id} ..." to change this agent.`
		);
	}
}

/**
 * List all agent configs, or a single agent's config.
 */
export function settingsAgentList(agentId: string | undefined, options: AgentListOptions): void {
	try {
		const target = agentId ? resolveSettingsTarget(agentId) : undefined;
		if (target?.kind === 'agent') {
			// Show one Left Bar agent's own settings
			const entries = agentSettingEntries(target.agent);
			if (options.json) {
				for (const entry of entries) {
					emitJsonl({
						type: 'setting',
						scope: 'agent',
						agentId: target.agent.id,
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
		} else if (agentId) {
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
						scope: 'provider',
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
						scope: 'provider',
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
		failCommand(`Failed to list agent configs: ${message}`, options.json);
	}
}

/**
 * Get a single agent config value.
 */
export function settingsAgentGet(agentId: string, key: string, options: AgentGetOptions): void {
	try {
		const target = resolveSettingsTarget(agentId);
		let value: unknown;
		let meta: { description: string; type: string } | undefined;
		let resolvedAgentId = agentId;
		if (target.kind === 'agent') {
			const settings = readAgentSessionSettings(target.agent);
			if (!(key in settings)) {
				throw new Error(
					`Unknown setting "${key}" for agent "${target.agent.name}". Known: ${Object.keys(settings).join(', ')}`
				);
			}
			value = settings[key as keyof typeof settings];
			meta = AGENT_SESSION_SETTING_METADATA[key as keyof typeof settings];
			resolvedAgentId = target.agent.id;
		} else {
			value = readAgentConfigValue(agentId, key);
			meta = AGENT_CONFIG_METADATA[key];
		}

		if (options.json) {
			emitJsonl({
				type: 'setting',
				scope: target.kind,
				agentId: resolvedAgentId,
				key,
				value,
				valueType: meta?.type ?? typeof value,
				category: `Agent: ${resolvedAgentId}`,
				...(options.verbose && meta ? { description: meta.description } : {}),
			});
		} else {
			if (options.verbose && meta) {
				const display: SettingDisplay = {
					key,
					value,
					type: meta.type,
					category: `Agent: ${resolvedAgentId}`,
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
		failCommand(message, options.json);
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
		assertProviderTarget(agentId);
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
		failCommand(`Failed to set "${agentId}.${key}": ${message}`, options.json);
	}
}

/**
 * Reset (delete) a single agent config key.
 */
export function settingsAgentReset(agentId: string, key: string, options: AgentResetOptions): void {
	try {
		assertProviderTarget(agentId);
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
		failCommand(`Failed to reset "${agentId}.${key}": ${message}`, options.json);
	}
}
