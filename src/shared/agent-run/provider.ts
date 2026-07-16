/**
 * Provider resolution (F1 / ISC-1.6) - PURE.
 *
 * Maps a session `toolType` (the string ProcessManager and the CLI spawn with)
 * to a canonical AgentRunProvider, falling back to `unknown` for anything not in
 * the known set. Kept pure and in the shared core so both the desktop capture
 * seam and the CLI capture hook resolve providers identically.
 */

import { resolveAgentId } from '../agentRegistry';
import { KNOWN_AGENT_RUN_PROVIDERS, type AgentRunProvider } from './types';

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

	const agentId = resolveAgentId(normalized);
	return agentId && (KNOWN_AGENT_RUN_PROVIDERS as readonly string[]).includes(agentId)
		? agentId
		: 'unknown';
}
