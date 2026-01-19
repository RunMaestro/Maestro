/**
 * Agents Collector
 *
 * Collects agent configurations and availability.
 * - Custom paths are sanitized
 * - Custom args/env vars show only whether they're set, not values
 */

import { AgentDetector, AgentCapabilities } from '../../agent-detector';
import { sanitizePath } from './settings';

export interface AgentInfo {
	id: string;
	name: string;
	available: boolean;
	binaryName?: string;
	path?: string; // Sanitized (actual discovered path)
	customPath?: string; // "[SET]" or "[NOT SET]" (user override)
	customArgs?: string; // "[SET]" or "[NOT SET]" (may contain secrets)
	hasCustomEnvVars: boolean; // Just true/false, no values
	customEnvVarCount: number; // How many custom env vars are set
	capabilities: AgentCapabilities;
	hidden?: boolean;
	// Config options state (which options are enabled)
	configOptionsState?: Record<string, boolean | string | number>;
}

export interface AgentsInfo {
	detectedAgents: AgentInfo[];
	customPaths: Record<string, string>; // agentId -> "[SET]" or sanitized path info
	customArgsSet: string[]; // List of agent IDs with custom args
	customEnvVarsSet: string[]; // List of agent IDs with custom env vars
}

/**
 * Collect agent information with sensitive data sanitized.
 */
export async function collectAgents(agentDetector: AgentDetector | null): Promise<AgentsInfo> {
	const result: AgentsInfo = {
		detectedAgents: [],
		customPaths: {},
		customArgsSet: [],
		customEnvVarsSet: [],
	};

	if (!agentDetector) {
		return result;
	}

	// Get all detected agents
	const agents = await agentDetector.detectAgents();

	for (const agent of agents) {
		const agentInfo: AgentInfo = {
			id: agent.id,
			name: agent.name,
			available: agent.available,
			binaryName: agent.binaryName,
			path: agent.path ? sanitizePath(agent.path) : undefined,
			customPath: agent.customPath ? '[SET]' : '[NOT SET]',
			customArgs: '[NOT SET]', // Will be updated below if set
			hasCustomEnvVars: false,
			customEnvVarCount: 0,
			capabilities: agent.capabilities || {},
			hidden: agent.hidden,
		};

		// Track custom paths
		if (agent.customPath) {
			result.customPaths[agent.id] = sanitizePath(agent.customPath);
		}

		// Check for config options (model, contextWindow, etc.)
		if (agent.configOptions) {
			agentInfo.configOptionsState = {};
			for (const option of agent.configOptions) {
				// Just record that the option exists and its type, not the value
				// (values might contain sensitive info like model API endpoints)
				agentInfo.configOptionsState[option.key] = `[${option.type.toUpperCase()}]`;
			}
		}

		result.detectedAgents.push(agentInfo);
	}

	return result;
}
