/**
 * Agent Icons Constants
 *
 * Centralized mapping of agent types to their display icons.
 * These icons are used throughout the UI to visually identify different AI agents.
 *
 * Usage:
 * ```typescript
 * import { AGENT_ICONS, getAgentIcon } from '../constants/agentIcons';
 *
 * // Direct lookup
 * const icon = AGENT_ICONS['claude-code']; // '🤖'
 *
 * // Safe lookup with fallback
 * const icon = getAgentIcon('unknown-agent'); // '🔧'
 * ```
 */

import type { ToolType } from '../types';

/**
 * Mapping of agent type IDs to their display icons.
 * Icons should be recognizable and distinct for each agent type.
 */
export const AGENT_ICONS: Record<string, string> = {
	// Primary agents
	'claude-code': '🤖',
	claude: '🤖',

	// OpenAI family
	'openai-codex': '◇',
	codex: '◇',

	// Google family
	'gemini-cli': '🔷',
	gemini: '🔷',

	// Alibaba family
	'qwen3-coder': '⬡',
	qwen: '⬡',

	// Open-source alternatives
	opencode: '📟',
	aider: '🛠️',

	// Terminal/shell (internal)
	terminal: '💻',
};

/**
 * Default icon for unknown or unrecognized agent types
 */
export const DEFAULT_AGENT_ICON = '🔧';

/**
 * Get the display icon for an agent type.
 * Returns a default icon if the agent type is not recognized.
 *
 * @param agentId - The agent type ID (e.g., 'claude-code', 'gemini-cli')
 * @returns The corresponding icon string
 */
export function getAgentIcon(agentId: string): string {
	return AGENT_ICONS[agentId] || DEFAULT_AGENT_ICON;
}

/**
 * Get the display icon for a ToolType.
 * Type-safe version of getAgentIcon.
 *
 * @param toolType - The ToolType value
 * @returns The corresponding icon string
 */
export function getAgentIconForToolType(toolType: ToolType): string {
	return getAgentIcon(toolType);
}

export default AGENT_ICONS;
