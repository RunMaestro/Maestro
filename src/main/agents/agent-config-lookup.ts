/**
 * Per-agent config/env-var lookup, read from the agent configs store.
 *
 * Extracted out of main/index.ts (Phase 5 refactoring) rather than into the
 * IPC bootstrap module specifically, because it's read from both
 * setupIpcHandlers() AND unscoped Cue-construction code inside
 * app.whenReady() - it isn't exclusively an IPC-bootstrap concern.
 */

import type { getAgentConfigsStore } from '../stores';

export interface AgentConfigLookup {
	getAgentConfigForAgent: (agentId: string) => Record<string, any>;
	getCustomEnvVarsForAgent: (agentId: string) => Record<string, string> | undefined;
}

export function createAgentConfigLookup(
	agentConfigsStore: ReturnType<typeof getAgentConfigsStore>
): AgentConfigLookup {
	const getAgentConfigForAgent = (agentId: string): Record<string, any> => {
		const allConfigs = agentConfigsStore.get('configs', {});
		return allConfigs[agentId] || {};
	};

	const getCustomEnvVarsForAgent = (agentId: string): Record<string, string> | undefined =>
		getAgentConfigForAgent(agentId).customEnvVars as Record<string, string> | undefined;

	return { getAgentConfigForAgent, getCustomEnvVarsForAgent };
}

/**
 * Every provider's custom binary path from the agent configs store, the map
 * `AgentDetector.setCustomPaths` takes. Startup, the Settings setter, and an
 * outside write (maestro-cli `settings agent set`) all apply it through here.
 */
export function customPathsFromAgentConfigs(
	configs: Record<string, unknown>
): Record<string, string> {
	const customPaths: Record<string, string> = {};
	for (const [agentId, config] of Object.entries(configs)) {
		if (config && typeof config === 'object' && 'customPath' in config) {
			const customPath = (config as { customPath?: unknown }).customPath;
			if (typeof customPath === 'string' && customPath) customPaths[agentId] = customPath;
		}
	}
	return customPaths;
}
