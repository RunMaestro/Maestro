/**
 * Fixtures for the turn assembly tests: real provider definitions, an agent, a tab, and a
 * context, each overridable. Nothing here reads a file or a clock.
 */
import type {
	TurnAgent,
	TurnContext,
	TurnTab,
} from '../../../../shared/maestro-lib/turns/assemble';
import { getAgentCapabilities } from '../../../../shared/maestro-lib/providers/capabilities';
import {
	getAgentDefinition,
	type AgentConfig,
} from '../../../../shared/maestro-lib/providers/definitions';

export const FIXED_NOW = new Date(2026, 9, 4, 12, 30, 15);

/** A provider as the desktop's detector returns it: definition, capabilities, and a binary path. */
export function providerFor(id: string, binary = `/usr/local/bin/${id}`): AgentConfig {
	const definition = getAgentDefinition(id);
	if (!definition) throw new Error(`no definition for ${id}`);
	return { ...definition, available: true, path: binary, capabilities: getAgentCapabilities(id) };
}

export function makeAgent(overrides: Partial<TurnAgent> = {}): TurnAgent {
	return {
		id: 'agent-1',
		name: 'Test Agent',
		toolType: 'claude-code',
		cwd: '/work/project',
		...overrides,
	};
}

export function makeTab(overrides: Partial<TurnTab> = {}): TurnTab {
	return { id: 'tab-1', agentSessionId: null, ...overrides };
}

export function makeContext(
	toolType = 'claude-code',
	overrides: Partial<TurnContext> = {}
): TurnContext {
	const binary = `/usr/local/bin/${getAgentDefinition(toolType)?.binaryName ?? toolType}`;
	return {
		provider: providerFor(toolType, binary),
		command: binary,
		providerConfig: {},
		prompts: {
			maestroSystem: 'SYSTEM for {{AGENT_NAME}} ({{AGENT_ID}}) tab {{TAB_ID}}',
			imageOnlyDefault: 'DESCRIBE THE IMAGE',
		},
		isWindowsHost: false,
		now: FIXED_NOW,
		...overrides,
	};
}
