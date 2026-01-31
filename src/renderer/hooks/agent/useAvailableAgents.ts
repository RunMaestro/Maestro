/**
 * useAvailableAgents.ts
 *
 * Hook for retrieving available agents with their current status.
 * Combines agent detection with session state to determine:
 * - Which agents are available/installed
 * - Which agents are busy (have active sessions)
 * - Which agent is the current source (disabled for transfer)
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import type { ToolType, Session } from '../../types';
import type { AgentCapabilities } from './useAgentCapabilities';
import { DEFAULT_CAPABILITIES } from './useAgentCapabilities';

// Use AgentConfig from types - it has optional capabilities fields
// The detect API may not return all capability fields
import type { AgentConfig } from '../../types';

/**
 * Agent availability status for display in selection UIs
 */
export type AgentStatus = 'ready' | 'busy' | 'unavailable' | 'current';

/**
 * Available agent with computed status information
 */
export interface AvailableAgent {
	/** Agent identifier (e.g., 'claude-code', 'opencode') */
	id: ToolType;
	/** Display name */
	name: string;
	/** Display icon (emoji) */
	icon: string;
	/** Current status */
	status: AgentStatus;
	/** Number of active sessions using this agent */
	activeSessions: number;
	/** Whether agent binary is available on the system */
	available: boolean;
	/** Agent capabilities for feature checking */
	capabilities: AgentCapabilities;
}

/**
 * Return type for useAvailableAgents hook
 */
export interface UseAvailableAgentsReturn {
	/** List of agents with computed status */
	agents: AvailableAgent[];
	/** Whether agents are still being loaded */
	loading: boolean;
	/** Error message if detection failed */
	error: string | null;
	/** Refresh agents from backend */
	refresh: () => Promise<void>;
	/** Get a specific agent by ID */
	getAgent: (id: ToolType) => AvailableAgent | undefined;
}

/**
 * Get display icon for an agent
 */
function getAgentIcon(agentId: string): string {
	switch (agentId) {
		case 'claude-code':
			return '🤖';
		case 'codex':
			return '◇';
		case 'gemini-cli':
			return '🔷';
		case 'qwen3-coder':
			return '⬡';
		case 'opencode':
			return '📟';
		case 'factory-droid':
			return '🏭';
		default:
			return '🔧';
	}
}

/**
 * Hook to get available agents with their current status.
 *
 * @param currentAgentId - The current agent ID (marked as 'current' status)
 * @param sessions - Current sessions for calculating busy status
 * @returns Object with agents list, loading state, and helper functions
 *
 * @example
 * ```tsx
 * function AgentSelector({ currentAgent, sessions }: Props) {
 *   const { agents, loading, getAgent } = useAvailableAgents(currentAgent, sessions);
 *
 *   if (loading) return <Spinner />;
 *
 *   return (
 *     <div>
 *       {agents.map(agent => (
 *         <AgentCard
 *           key={agent.id}
 *           agent={agent}
 *           disabled={agent.status === 'current' || agent.status === 'unavailable'}
 *         />
 *       ))}
 *     </div>
 *   );
 * }
 * ```
 */
export function useAvailableAgents(
	currentAgentId: ToolType | null | undefined,
	sessions: Session[] = []
): UseAvailableAgentsReturn {
	const [rawAgents, setRawAgents] = useState<AgentConfig[]>([]);
	const [loading, setLoading] = useState<boolean>(true);
	const [error, setError] = useState<string | null>(null);

	// Fetch agents from backend
	const fetchAgents = useCallback(async () => {
		setLoading(true);
		setError(null);

		try {
			const detectedAgents = await window.maestro.agents.detect();
			setRawAgents(detectedAgents);
		} catch (err) {
			console.error('Failed to detect agents:', err);
			setError(err instanceof Error ? err.message : 'Failed to detect agents');
			setRawAgents([]);
		} finally {
			setLoading(false);
		}
	}, []);

	// Fetch on mount
	useEffect(() => {
		fetchAgents();
	}, [fetchAgents]);

	// Calculate session counts per agent
	const sessionCountsByAgent = useMemo(() => {
		const counts: Record<string, number> = {};
		for (const session of sessions) {
			const toolType = session.toolType;
			counts[toolType] = (counts[toolType] || 0) + 1;
		}
		return counts;
	}, [sessions]);

	// Calculate busy agents (those with sessions in busy state)
	const busyAgents = useMemo(() => {
		const busy = new Set<string>();
		for (const session of sessions) {
			if (session.state === 'busy') {
				busy.add(session.toolType);
			}
		}
		return busy;
	}, [sessions]);

	// Build list of agents with computed status
	const agents = useMemo((): AvailableAgent[] => {
		return rawAgents
			.filter((agent) => !agent.hidden)
			.map((agent) => {
				let status: AgentStatus;

				if (agent.id === currentAgentId) {
					status = 'current';
				} else if (!agent.available) {
					status = 'unavailable';
				} else if (busyAgents.has(agent.id)) {
					status = 'busy';
				} else {
					status = 'ready';
				}

				return {
					id: agent.id as ToolType,
					name: agent.name,
					icon: getAgentIcon(agent.id),
					status,
					activeSessions: sessionCountsByAgent[agent.id] || 0,
					available: agent.available,
					capabilities: { ...DEFAULT_CAPABILITIES, ...agent.capabilities },
				};
			});
	}, [rawAgents, currentAgentId, busyAgents, sessionCountsByAgent]);

	// Get a specific agent by ID
	const getAgent = useCallback(
		(id: ToolType): AvailableAgent | undefined => {
			return agents.find((a) => a.id === id);
		},
		[agents]
	);

	return {
		agents,
		loading,
		error,
		refresh: fetchAgents,
		getAgent,
	};
}

/**
 * Get available agents for a specific use case (e.g., context transfer).
 * Filters to only agents that support the required capability.
 *
 * @param currentAgentId - Current agent ID to exclude
 * @param sessions - Current sessions for busy status
 * @param requiredCapability - Capability that agents must have
 * @returns Filtered list of agents that support the capability
 */
export function useAvailableAgentsForCapability(
	currentAgentId: ToolType | null | undefined,
	sessions: Session[] = [],
	requiredCapability: keyof AgentCapabilities
): UseAvailableAgentsReturn {
	const result = useAvailableAgents(currentAgentId, sessions);

	const filteredAgents = useMemo(() => {
		return result.agents.filter((agent) => agent.capabilities[requiredCapability]);
	}, [result.agents, requiredCapability]);

	const getAgent = useCallback(
		(id: ToolType): AvailableAgent | undefined => {
			return filteredAgents.find((a) => a.id === id);
		},
		[filteredAgents]
	);

	return {
		...result,
		agents: filteredAgents,
		getAgent,
	};
}
