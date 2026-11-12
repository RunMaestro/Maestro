/**
 * Provider resolution (F1 / ISC-1.6) - PURE.
 *
 * Maps a session `toolType` (the string ProcessManager and the CLI spawn with)
 * to a canonical AgentRunProvider, falling back to `unknown` for anything not in
 * the known set. Kept pure and in the shared core so both the desktop capture
 * seam and the CLI capture hook resolve providers identically.
 */

import { KNOWN_AGENT_RUN_PROVIDERS, type AgentRunProvider } from './types';

/** toolType spellings that differ from the canonical provider id. */
const TOOL_TYPE_ALIASES: Record<string, AgentRunProvider> = {
	claude: 'claude-code',
	claudecode: 'claude-code',
	copilot: 'copilot-cli',
	droid: 'factory-droid',
	factory: 'factory-droid',
	qwen: 'qwen-coder',
	'qwen-code': 'qwen-coder',
};

/**
 * Resolve a canonical provider from a raw toolType. Returns `unknown` for empty
 * input, terminal/non-agent tool types, or any unrecognized string, so a run is
 * always tagged with a valid provider.
 */
export function resolveAgentRunProvider(toolType: string | undefined): AgentRunProvider {
	if (!toolType) return 'unknown';
	const normalized = toolType.trim().toLowerCase();
	if ((KNOWN_AGENT_RUN_PROVIDERS as readonly string[]).includes(normalized)) {
		return normalized as AgentRunProvider;
	}
	return TOOL_TYPE_ALIASES[normalized] ?? 'unknown';
}
