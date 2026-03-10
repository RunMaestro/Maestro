/**
 * Agent ID Constants — Single Source of Truth
 *
 * This module defines the canonical list of all agent IDs in Maestro.
 * The ToolType union is derived from this array, ensuring type safety
 * and eliminating duplicate definitions.
 *
 * When adding a new agent, add its ID here. TypeScript will then
 * enforce updates in all dependent code (capabilities, parsers, storage, etc.).
 */

/**
 * All known agent IDs in Maestro.
 * This is the single source of truth — ToolType is derived from this array.
 */
export const AGENT_IDS = [
	'terminal',
	'claude-code',
	'codex',
	'gemini-cli',
	'qwen3-coder',
	'opencode',
	'factory-droid',
	'aider',
] as const;

/**
 * Union type of all valid agent IDs.
 * Derived from AGENT_IDS to ensure a single source of truth.
 */
export type AgentId = (typeof AGENT_IDS)[number];

/**
 * Type guard to check if a string is a valid agent ID.
 * @param id - The string to check
 * @returns True if the string is a valid AgentId
 */
export function isValidAgentId(id: string): id is AgentId {
	return AGENT_IDS.includes(id as AgentId);
}
