/**
 * useAgentCapabilities.ts
 *
 * React hook for accessing agent capabilities.
 * Provides type-safe access to what features each agent supports.
 */

import { useState, useEffect, useCallback } from 'react';
import type { ToolType } from '../types';

/**
 * Capability flags that determine what features are available for each agent.
 */
export interface AgentCapabilities {
  /** Agent supports resuming existing sessions (e.g., --resume flag) */
  supportsResume: boolean;

  /** Agent supports read-only/plan mode (e.g., --permission-mode plan) */
  supportsReadOnlyMode: boolean;

  /** Agent outputs JSON-formatted responses (for parsing) */
  supportsJsonOutput: boolean;

  /** Agent provides a session ID for conversation continuity */
  supportsSessionId: boolean;

  /** Agent can accept image inputs (screenshots, diagrams, etc.) */
  supportsImageInput: boolean;

  /** Agent can accept image inputs when resuming an existing session */
  supportsImageInputOnResume: boolean;

  /** Agent supports slash commands (e.g., /help, /compact) */
  supportsSlashCommands: boolean;

  /** Agent stores session history in a discoverable location */
  supportsSessionStorage: boolean;

  /** Agent provides cost/pricing information */
  supportsCostTracking: boolean;

  /** Agent provides token usage statistics */
  supportsUsageStats: boolean;

  /** Agent supports batch/headless mode (non-interactive) */
  supportsBatchMode: boolean;

  /** Agent requires a prompt to start (no eager spawn on session creation) */
  requiresPromptToStart: boolean;

  /** Agent streams responses in real-time */
  supportsStreaming: boolean;

  /** Agent provides distinct "result" messages when done */
  supportsResultMessages: boolean;

  /** Agent supports selecting different models (e.g., --model flag) */
  supportsModelSelection: boolean;

  /** Agent supports --input-format stream-json for image input via stdin */
  supportsStreamJsonInput: boolean;

  /** Agent emits streaming thinking/reasoning content that can be displayed */
  supportsThinkingDisplay: boolean;
}

/**
 * Default capabilities - safe defaults for unknown agents.
 * All capabilities disabled by default (conservative approach).
 */
export const DEFAULT_CAPABILITIES: AgentCapabilities = {
  supportsResume: false,
  supportsReadOnlyMode: false,
  supportsJsonOutput: false,
  supportsSessionId: false,
  supportsImageInput: false,
  supportsImageInputOnResume: false,
  supportsSlashCommands: false,
  supportsSessionStorage: false,
  supportsCostTracking: false,
  supportsUsageStats: false,
  supportsBatchMode: false,
  requiresPromptToStart: false,
  supportsStreaming: false,
  supportsResultMessages: false,
  supportsModelSelection: false,
  supportsStreamJsonInput: false,
  supportsThinkingDisplay: false,
};

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

  const fetchCapabilities = useCallback(async (forceRefresh = false) => {
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
      console.error(`Failed to get capabilities for agent ${agentId}:`, err);
      setError(err instanceof Error ? err.message : 'Failed to load capabilities');
      // Use defaults on error
      setCapabilities(DEFAULT_CAPABILITIES);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  // Fetch capabilities on mount or when agentId changes
  useEffect(() => {
    fetchCapabilities();
  }, [fetchCapabilities]);

  // Helper to check a specific capability
  const hasCapability = useCallback(
    (capability: keyof AgentCapabilities): boolean => {
      return capabilities[capability];
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
 * Clear the capabilities cache.
 * Useful after agent detection refresh.
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
