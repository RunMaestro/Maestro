/**
 * AgentSelector.tsx
 *
 * Shared component for selecting AI agents across the application.
 * Used by:
 * - AgentCreationDialog (Symphony)
 * - NewInstanceModal (new session creation)
 * - Wizard AgentSelectionScreen
 * - Group chat modals
 *
 * Features:
 * - Renders agent cards with selection state
 * - Shows availability status (Available/Not Found/Coming Soon)
 * - Optional filtering by capabilities (e.g., supportsBatchMode)
 * - Optional expandable config panel integration
 * - Keyboard navigation support
 */

import React from 'react';
import { Bot, RefreshCw } from 'lucide-react';
import type { Theme, AgentConfig } from '../../types';

// ============================================================================
// Types
// ============================================================================

export interface AgentSelectorProps {
  theme: Theme;
  /** List of agents to display */
  agents: AgentConfig[];
  /** Currently selected agent ID */
  selectedAgentId: string | null;
  /** Called when an agent is selected */
  onSelectAgent: (agentId: string) => void;
  /** Optional: Show loading state */
  isLoading?: boolean;
  /** Optional: Filter function to determine which agents to show */
  filterFn?: (agent: AgentConfig) => boolean;
  /** Optional: Custom empty state message */
  emptyMessage?: React.ReactNode;
  /** Optional: Show refresh button and handler */
  onRefreshAgent?: (agentId: string) => void;
  /** Optional: Agent currently being refreshed */
  refreshingAgentId?: string | null;
  /** Optional: Render custom content below agent info (e.g., config panel) */
  renderExpandedContent?: (agent: AgentConfig) => React.ReactNode;
  /** Optional: Control which agent is expanded (for expandable mode) */
  expandedAgentId?: string | null;
  /** Optional: Compact mode (less padding) */
  compact?: boolean;
  /** Optional: Show "Beta" badge for certain agents */
  showBetaBadge?: boolean;
  /** Optional: Show "Coming Soon" for unsupported agents */
  showComingSoon?: boolean;
  /** Optional: List of supported agent IDs (others shown as "Coming Soon") */
  supportedAgentIds?: string[];
}

export interface AgentCardProps {
  agent: AgentConfig;
  theme: Theme;
  isSelected: boolean;
  onSelect: () => void;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  compact?: boolean;
  showBetaBadge?: boolean;
  isSupported?: boolean;
  showComingSoon?: boolean;
}

// ============================================================================
// AgentCard Component
// ============================================================================

export function AgentCard({
  agent,
  theme,
  isSelected,
  onSelect,
  onRefresh,
  isRefreshing,
  compact,
  showBetaBadge,
  isSupported = true,
  showComingSoon,
}: AgentCardProps) {
  const isBetaAgent = agent.id === 'codex' || agent.id === 'opencode';

  return (
    <button
      onClick={isSupported ? onSelect : undefined}
      disabled={!isSupported}
      className={`w-full rounded-lg border text-left transition-all ${
        compact ? 'p-3' : 'p-4'
      } ${
        isSelected ? 'ring-2' : ''
      } ${
        !isSupported ? 'opacity-50 cursor-not-allowed' : 'hover:bg-white/5'
      }`}
      style={{
        backgroundColor: isSelected ? theme.colors.bgActivity : 'transparent',
        borderColor: isSelected ? theme.colors.accent : theme.colors.border,
        ...(isSelected && { boxShadow: `0 0 0 2px ${theme.colors.accent}` }),
      }}
    >
      <div className="flex items-center gap-3">
        <Bot
          className={compact ? 'w-5 h-5' : 'w-6 h-6'}
          style={{ color: isSelected ? theme.colors.accent : theme.colors.textDim }}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="font-medium" style={{ color: theme.colors.textMain }}>
              {agent.name}
            </h4>
            {showBetaBadge && isBetaAgent && (
              <span
                className="text-[9px] px-1.5 py-0.5 rounded font-bold uppercase"
                style={{
                  backgroundColor: theme.colors.warning + '30',
                  color: theme.colors.warning,
                }}
              >
                Beta
              </span>
            )}
          </div>
          <p className="text-xs truncate" style={{ color: theme.colors.textDim }}>
            {agent.path ?? agent.command}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isSupported ? (
            <>
              {agent.available ? (
                <span
                  className="text-xs px-2 py-0.5 rounded"
                  style={{ backgroundColor: theme.colors.success + '20', color: theme.colors.success }}
                >
                  Available
                </span>
              ) : (
                <span
                  className="text-xs px-2 py-0.5 rounded"
                  style={{ backgroundColor: theme.colors.error + '20', color: theme.colors.error }}
                >
                  Not Found
                </span>
              )}
              {onRefresh && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRefresh();
                  }}
                  className="p-1 rounded hover:bg-white/10 transition-colors"
                  title="Refresh detection"
                  style={{ color: theme.colors.textDim }}
                >
                  <RefreshCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin' : ''}`} />
                </button>
              )}
              {isSelected && (
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: theme.colors.accent }} />
              )}
            </>
          ) : showComingSoon ? (
            <span
              className="text-xs px-2 py-0.5 rounded"
              style={{ backgroundColor: theme.colors.warning + '20', color: theme.colors.warning }}
            >
              Coming Soon
            </span>
          ) : null}
        </div>
      </div>
    </button>
  );
}

// ============================================================================
// AgentSelector Component
// ============================================================================

export function AgentSelector({
  theme,
  agents,
  selectedAgentId,
  onSelectAgent,
  isLoading,
  filterFn,
  emptyMessage,
  onRefreshAgent,
  refreshingAgentId,
  renderExpandedContent,
  expandedAgentId,
  compact,
  showBetaBadge,
  showComingSoon,
  supportedAgentIds,
}: AgentSelectorProps) {
  // Apply filter if provided
  const filteredAgents = filterFn ? agents.filter(filterFn) : agents;

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <RefreshCw className="w-6 h-6 animate-spin" style={{ color: theme.colors.accent }} />
      </div>
    );
  }

  // Empty state
  if (filteredAgents.length === 0) {
    return (
      <div className="text-center py-4" style={{ color: theme.colors.textDim }}>
        {emptyMessage || 'No AI agents detected. Please install Claude Code or another supported agent.'}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {filteredAgents.map((agent) => {
        const isSupported = supportedAgentIds ? supportedAgentIds.includes(agent.id) : true;
        const isExpanded = expandedAgentId === agent.id;

        return (
          <div key={agent.id}>
            <AgentCard
              agent={agent}
              theme={theme}
              isSelected={selectedAgentId === agent.id}
              onSelect={() => onSelectAgent(agent.id)}
              onRefresh={onRefreshAgent ? () => onRefreshAgent(agent.id) : undefined}
              isRefreshing={refreshingAgentId === agent.id}
              compact={compact}
              showBetaBadge={showBetaBadge}
              isSupported={isSupported}
              showComingSoon={showComingSoon}
            />
            {/* Expanded content (e.g., AgentConfigPanel) */}
            {isExpanded && renderExpandedContent && (
              <div className="mt-2 ml-8">
                {renderExpandedContent(agent)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default AgentSelector;
