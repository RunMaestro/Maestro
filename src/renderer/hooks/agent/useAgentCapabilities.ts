/**
 * useAgentCapabilities.ts
 *
 * React hook for accessing agent capabilities.
 * Provides type-safe access to what features each agent supports.
 */

import { useState, useEffect, useCallback } from 'react';
import type { ToolType } from '../../types';
import type { AgentCapabilities } from '../../../shared/types';
import { DEFAULT_CAPABILITIES } from '../../../shared/types';
import { logger } from '../../utils/logger';

export type { AgentCapabilities };
export { DEFAULT_CAPABILITIES };

/**
 * Return type for useAgentCapabilities hook.
 */
export interface UseAgentCapabilitiesReturn {
	/** The agent's capabilities */
	capabilities: AgentCapabilities;
	/** Whether capabilities are still loading */
	loading: boolean;
	/** Error message if capabilities failed to load */
	error: string | null;
	/** Function to refresh capabilities from the backend */
	refresh: () => Promise<void>;
	/** Check if a specific capability is supported */
	hasCapability: (capability: keyof AgentCapabilities) => boolean;
}

// Cache for capabilities to avoid repeated IPC calls
const capabilitiesCache = new Map<string, AgentCapabilities>();

/**
 * Hook to get capabilities for an agent.
 *
 * @param agentId - The agent identifier (e.g., 'claude-code', 'opencode')
 *                  Can also accept ToolType which includes agents
 * @returns Object with capabilities, loading state, and helper functions
 *
 * @example
 * ```tsx
 * function InputArea({ toolType }: { toolType: ToolType }) {
 *   const { capabilities, hasCapability } = useAgentCapabilities(toolType);
 *
 *   return (
 *     <div>
 *       {hasCapability('supportsImageInput') && <ImageAttachButton />}
 *       {hasCapability('supportsSlashCommands') && <SlashCommandAutocomplete />}
 *     </div>
 *   );
 * }
 * ```
 */
export function useAgentCapabilities(
	agentId: string | ToolType | null | undefined
): UseAgentCapabilitiesReturn {
	const [capabilities, setCapabilities] = useState<AgentCapabilities>(
		agentId && capabilitiesCache.has(agentId)
			? capabilitiesCache.get(agentId)!
			: DEFAULT_CAPABILITIES
	);
	const [loading, setLoading] = useState<boolean>(!agentId || !capabilitiesCache.has(agentId));
	const [error, setError] = useState<string | null>(null);

	const fetchCapabilities = useCallback(
		async (forceRefresh = false) => {
			setError(null);
			if (!agentId) {
				setCapabilities(DEFAULT_CAPABILITIES);
				setLoading(false);
				return;
			}

			// Check cache first
			if (!forceRefresh && capabilitiesCache.has(agentId)) {
				setCapabilities(capabilitiesCache.get(agentId)!);
				setLoading(false);
				return;
			}

			setLoading(true);

			try {
				const result = await window.maestro.agents.getCapabilities(agentId);
				// Merge with defaults to ensure all optional fields are defined
				const fullCapabilities: AgentCapabilities = { ...DEFAULT_CAPABILITIES, ...result };
				capabilitiesCache.set(agentId, fullCapabilities);
				setCapabilities(fullCapabilities);
			} catch (err) {
				logger.error(`Failed to get capabilities for agent ${agentId}:`, undefined, err);
				setError(err instanceof Error ? err.message : 'Failed to load capabilities');
				// Use defaults on error
				setCapabilities(DEFAULT_CAPABILITIES);
			} finally {
				setLoading(false);
			}
		},
		[agentId]
	);

	// Fetch capabilities on mount or when agentId changes
	useEffect(() => {
		fetchCapabilities();
	}, [fetchCapabilities]);

	// Helper to check a specific capability
	const hasCapability = useCallback(
		(capability: keyof AgentCapabilities): boolean => {
			return !!capabilities[capability];
		},
		[capabilities]
	);

	return {
		capabilities,
		loading,
		error,
		refresh: () => fetchCapabilities(true),
		hasCapability,
	};
}

/**
 * Synchronous capability check using cached data.
 * Safe to call outside React components (e.g., in callbacks, event handlers).
 * Returns false for uncached agents (conservative default).
 *
 * @param agentId - The agent identifier
 * @param capability - The capability key to check
 * @returns true if the agent is cached and supports the capability
 */
export function hasCapabilityCached(agentId: string, capability: keyof AgentCapabilities): boolean {
	const cached = capabilitiesCache.get(agentId);
	if (!cached) return !!DEFAULT_CAPABILITIES[capability];
	return !!cached[capability];
}

/**
 * Read the cached capabilities for an agent, or `undefined` when the agent has
 * never been looked up.
 *
 * Callers that must distinguish "never fetched" from "fetched and the answer is
 * false" MUST use this instead of `hasCapabilityCached`, which collapses both
 * onto `DEFAULT_CAPABILITIES` and so reports a cache miss as "unsupported".
 * That conflation is what silently dropped CLI dispatches to agent types the
 * user had not opened this renderer session.
 */
export function getCachedCapabilities(agentId: string): AgentCapabilities | undefined {
	return capabilitiesCache.get(agentId);
}

/**
 * Clear the capabilities cache.
 * Useful after agent detection refresh.
 *
 * NOTE: anything that clears the cache must re-prime it (see
 * `primeCapabilitiesCache`), or synchronous `hasCapabilityCached` callers fall
 * back to the conservative defaults again.
 */
export function clearCapabilitiesCache(): void {
	capabilitiesCache.clear();
}

/**
 * Pre-populate the cache with capabilities for an agent.
 * Useful when capabilities are already known (e.g., from agent detection).
 */
export function setCapabilitiesCache(agentId: string, capabilities: AgentCapabilities): void {
	capabilitiesCache.set(agentId, capabilities);
}

/**
 * Prime the cache for EVERY known agent type in one IPC round trip.
 *
 * `hasCapabilityCached` is synchronous and cannot fetch, so any caller running
 * outside the active session's React tree (background dispatch, remote command
 * handlers) previously read an empty cache as "capability unsupported". Priming
 * at startup makes the cache reflect reality before those callers run.
 *
 * Never throws: a failure leaves the cache as-is, and the miss-aware call sites
 * still fetch on demand.
 *
 * @returns the number of agent entries primed (0 on failure)
 */
export async function primeCapabilitiesCache(): Promise<number> {
	try {
		const all = await window.maestro.agents.getAllCapabilities();
		let primed = 0;
		for (const [agentId, capabilities] of Object.entries(all ?? {})) {
			capabilitiesCache.set(agentId, { ...DEFAULT_CAPABILITIES, ...capabilities });
			primed++;
		}
		return primed;
	} catch (err) {
		logger.error('Failed to prime agent capabilities cache', undefined, err);
		return 0;
	}
}
