/**
 * ParticipantCard.tsx
 *
 * Displays a single group chat participant with their status,
 * session ID, context usage, stats, and cost.
 */

import { MessageSquare, Copy, Check, DollarSign, RotateCcw, Server } from 'lucide-react';
import { useState, useCallback } from 'react';
import type { Theme, GroupChatParticipant, SessionState } from '../types';
import { getStatusColor } from '../utils/theme';
import { formatCost } from '../utils/formatters';

interface ParticipantCardProps {
  theme: Theme;
  participant: GroupChatParticipant;
  state: SessionState;
  color?: string;
  groupChatId?: string;
  onContextReset?: (participantName: string) => void;
}

/**
 * Format time as relative or absolute.
 */
function formatTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function ParticipantCard({
  theme,
  participant,
  state,
  color,
  groupChatId,
  onContextReset,
}: ParticipantCardProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  // Use agent's session ID (clean GUID) when available, otherwise show pending
  const agentSessionId = participant.agentSessionId;
  const isPending = !agentSessionId;

  const copySessionId = useCallback(() => {
    if (agentSessionId) {
      navigator.clipboard.writeText(agentSessionId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [agentSessionId]);

  // Determine if state should animate (busy or connecting)
  const shouldPulse = state === 'busy' || state === 'connecting';

  const getStatusLabel = (): string => {
    switch (state) {
      case 'busy':
        return 'Working';
      case 'error':
        return 'Error';
      case 'connecting':
        return 'Connecting';
      default:
        return 'Idle';
    }
  };

  // Context usage percentage (default to 0 if not set)
  const contextUsage = participant.contextUsage ?? 0;

  // Show reset button when context usage is 40% or higher
  const showResetButton = contextUsage >= 40 && onContextReset && groupChatId && !isResetting;

  const handleReset = useCallback(async () => {
    if (!onContextReset || !groupChatId) return;
    setIsResetting(true);
    try {
      await onContextReset(participant.name);
    } finally {
      setIsResetting(false);
    }
  }, [onContextReset, groupChatId, participant.name]);

  return (
    <div
      className="rounded-lg border p-3"
      style={{
        backgroundColor: theme.colors.bgMain,
        borderColor: theme.colors.border,
        borderLeftWidth: '3px',
        borderLeftColor: color || theme.colors.accent,
      }}
    >
      {/* Header row: status + name on left, SSH pill + session ID pill on right */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div
            className={`w-2 h-2 rounded-full shrink-0 ${shouldPulse ? 'animate-pulse' : ''}`}
            style={{ backgroundColor: getStatusColor(state, theme) }}
            title={getStatusLabel()}
          />
          <span
            className="font-medium truncate"
            style={{ color: color || theme.colors.textMain }}
          >
            {participant.name}
          </span>
          {/* SSH Remote pill - shown when running on SSH remote */}
          {participant.sshRemoteName && (
            <span
              className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full shrink-0 border border-purple-500/30 text-purple-500 bg-purple-500/10 max-w-[80px]"
              title={`SSH Remote: ${participant.sshRemoteName}`}
            >
              <Server className="w-2.5 h-2.5 shrink-0" />
              <span className="truncate uppercase">{participant.sshRemoteName}</span>
            </span>
          )}
        </div>
        {/* Session ID pill - top right */}
        {isPending ? (
          <span
            className="text-[10px] px-2 py-0.5 rounded-full shrink-0 italic"
            style={{
              backgroundColor: `${theme.colors.textDim}20`,
              color: theme.colors.textDim,
              border: `1px solid ${theme.colors.textDim}40`,
            }}
          >
            pending
          </span>
        ) : (
          <button
            onClick={copySessionId}
            className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full hover:opacity-80 transition-opacity cursor-pointer shrink-0"
            style={{
              backgroundColor: `${theme.colors.accent}20`,
              color: theme.colors.accent,
              border: `1px solid ${theme.colors.accent}40`,
            }}
            title={`Session: ${agentSessionId}\nClick to copy`}
          >
            <span className="font-mono">
              {agentSessionId.slice(0, 8).toUpperCase()}
            </span>
            {copied ? (
              <Check className="w-2.5 h-2.5" />
            ) : (
              <Copy className="w-2.5 h-2.5" />
            )}
          </button>
        )}
      </div>

      {/* Stats row: message count + last time (left), agent type (right) */}
      <div
        className="text-xs mt-1 flex items-center justify-between"
        style={{ color: theme.colors.textDim }}
      >
        <div className="flex items-center gap-2">
          {(participant.messageCount !== undefined && participant.messageCount > 0) && (
            <span className="flex items-center gap-1" title="Messages sent">
              <MessageSquare className="w-3 h-3" />
              {participant.messageCount}
            </span>
          )}
          {participant.lastActivity && (
            <span title="Last activity">
              {formatTime(participant.lastActivity)}
            </span>
          )}
        </div>
        <span>{participant.agentId}</span>
      </div>

      {/* Context gauge + optional cost */}
      <div className="mt-2 flex items-center gap-2">
        <div className="flex-1">
          <div className="flex items-center justify-between mb-1">
            <span
              className="text-[10px]"
              style={{ color: theme.colors.textDim }}
            >
              Context
            </span>
            <span
              className="text-[10px]"
              style={{ color: theme.colors.textDim }}
            >
              {contextUsage}%
            </span>
          </div>
          <div
            className="h-1 rounded-full overflow-hidden"
            style={{ backgroundColor: theme.colors.border }}
          >
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${contextUsage}%`,
                backgroundColor:
                  contextUsage > 80
                    ? theme.colors.warning
                    : theme.colors.accent,
              }}
            />
          </div>
        </div>
        {/* Cost pill (optional) */}
        {(participant.totalCost !== undefined && participant.totalCost > 0) && (
          <span
            className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded shrink-0"
            style={{
              backgroundColor: `${theme.colors.success}20`,
              color: theme.colors.success,
            }}
            title="Total cost"
          >
            <DollarSign className="w-3 h-3" />
            {formatCost(participant.totalCost).slice(1)}
          </span>
        )}
        {/* Reset button - shown when context usage >= 40% */}
        {showResetButton && (
          <button
            onClick={handleReset}
            className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded shrink-0 hover:opacity-80 transition-opacity cursor-pointer"
            style={{
              backgroundColor: `${theme.colors.warning}20`,
              color: theme.colors.warning,
              border: `1px solid ${theme.colors.warning}40`,
            }}
            title="Reset context: Summarize current session and start fresh"
          >
            <RotateCcw className="w-3 h-3" />
            Reset
          </button>
        )}
        {/* Reset in progress indicator */}
        {isResetting && (
          <span
            className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded shrink-0 animate-pulse"
            style={{
              backgroundColor: `${theme.colors.warning}20`,
              color: theme.colors.warning,
            }}
          >
            <RotateCcw className="w-3 h-3 animate-spin" />
            Resetting...
          </span>
        )}
      </div>
    </div>
  );
}
