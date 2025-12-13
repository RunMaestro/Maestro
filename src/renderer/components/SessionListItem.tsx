/**
 * SessionListItem - Renders an individual Claude session row in the AgentSessionsBrowser
 *
 * This component displays a session with:
 * - Star button for favorites
 * - Quick resume button (visible on hover)
 * - Session name with inline rename capability
 * - First message preview
 * - Session origin pill (MAESTRO, AUTO, CLI)
 * - Session ID pill
 * - Stats (time, messages, size, cost)
 * - Content search match info (when searching)
 * - Active indicator badge
 *
 * @module components/SessionListItem
 */

import React from 'react';
import {
  Star,
  Play,
  Edit3,
  Clock,
  MessageSquare,
  HardDrive,
  DollarSign,
  Search,
} from 'lucide-react';
import type { Theme } from '../types';
import { formatSize, formatRelativeTime } from '../utils/formatters';
import type { ClaudeSession } from '../hooks/useSessionViewer';

/**
 * Search result info for content-based searches
 */
export interface SearchResultInfo {
  matchCount: number;
  matchPreview: string;
}

/**
 * Props for the SessionListItem component
 */
export interface SessionListItemProps {
  /** The Claude session data */
  session: ClaudeSession;
  /** Zero-based index in the list */
  index: number;
  /** Currently selected index for keyboard navigation */
  selectedIndex: number;
  /** Whether this session is starred */
  isStarred: boolean;
  /** Currently active Claude session ID (if any) */
  activeClaudeSessionId: string | null;
  /** ID of session currently being renamed (if any) */
  renamingSessionId: string | null;
  /** Current rename input value */
  renameValue: string;
  /** Current search mode for conditional display */
  searchMode: 'title' | 'user' | 'assistant' | 'all';
  /** Search result info for content searches (optional) */
  searchResultInfo?: SearchResultInfo | null;
  /** Theme for styling */
  theme: Theme;
  /** Ref to attach to selected item */
  selectedItemRef: React.RefObject<HTMLButtonElement | HTMLDivElement | null>;
  /** Ref for rename input */
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  /** Handler for clicking a session row */
  onSessionClick: (session: ClaudeSession) => void;
  /** Handler for toggling star status */
  onToggleStar: (sessionId: string, e: React.MouseEvent) => void;
  /** Handler for quick resume (without viewing details) */
  onQuickResume: (session: ClaudeSession, e: React.MouseEvent) => void;
  /** Handler for starting rename */
  onStartRename: (session: ClaudeSession, e: React.MouseEvent) => void;
  /** Handler for rename input change */
  onRenameChange: (value: string) => void;
  /** Handler for submitting rename */
  onSubmitRename: (sessionId: string) => void;
  /** Handler for canceling rename */
  onCancelRename: () => void;
}

/**
 * SessionListItem component for rendering a single session row
 */
export function SessionListItem({
  session,
  index,
  selectedIndex,
  isStarred,
  activeClaudeSessionId,
  renamingSessionId,
  renameValue,
  searchMode,
  searchResultInfo,
  theme,
  selectedItemRef,
  renameInputRef,
  onSessionClick,
  onToggleStar,
  onQuickResume,
  onStartRename,
  onRenameChange,
  onSubmitRename,
  onCancelRename,
}: SessionListItemProps) {
  const isSelected = index === selectedIndex;
  const isRenaming = renamingSessionId === session.sessionId;
  const isActive = activeClaudeSessionId === session.sessionId;

  return (
    <div
      ref={isSelected ? (selectedItemRef as React.RefObject<HTMLDivElement>) : null}
      onClick={() => onSessionClick(session)}
      className="w-full text-left px-6 py-4 flex items-start gap-4 hover:bg-white/5 transition-colors border-b group cursor-pointer"
      style={{
        backgroundColor: isSelected ? theme.colors.accent + '15' : 'transparent',
        borderColor: theme.colors.border + '50',
      }}
    >
      {/* Star button */}
      <button
        onClick={(e) => onToggleStar(session.sessionId, e)}
        className="p-1 -ml-1 rounded hover:bg-white/10 transition-colors shrink-0"
        title={isStarred ? 'Remove from favorites' : 'Add to favorites'}
      >
        <Star
          className="w-4 h-4"
          style={{
            color: isStarred ? theme.colors.warning : theme.colors.textDim,
            fill: isStarred ? theme.colors.warning : 'transparent',
          }}
        />
      </button>

      {/* Quick Resume button */}
      <button
        onClick={(e) => onQuickResume(session, e)}
        className="p-1 rounded hover:bg-white/10 transition-colors shrink-0 opacity-0 group-hover:opacity-100"
        title="Resume session in new tab"
      >
        <Play className="w-4 h-4" style={{ color: theme.colors.success }} />
      </button>

      <div className="flex-1 min-w-0">
        {/* Session name row - inline rename input or display */}
        {isRenaming ? (
          <div className="flex items-center gap-1.5 mb-1">
            <input
              ref={renameInputRef}
              type="text"
              value={renameValue}
              onChange={(e) => onRenameChange(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onSubmitRename(session.sessionId);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  onCancelRename();
                }
              }}
              onClick={(e) => e.stopPropagation()}
              onBlur={() => onSubmitRename(session.sessionId)}
              placeholder="Enter session name..."
              className="flex-1 bg-transparent outline-none text-sm font-semibold px-2 py-0.5 rounded border min-w-0"
              style={{
                color: theme.colors.accent,
                borderColor: theme.colors.accent,
                backgroundColor: theme.colors.bgActivity,
              }}
            />
          </div>
        ) : session.sessionName ? (
          <div className="flex items-center gap-1.5 mb-1 group/name">
            <span
              className="font-semibold text-sm truncate"
              style={{ color: theme.colors.accent }}
            >
              {session.sessionName}
            </span>
            <button
              onClick={(e) => onStartRename(session, e)}
              className="p-0.5 rounded opacity-0 group-hover/name:opacity-100 hover:bg-white/10 transition-all"
              title="Rename session"
            >
              <Edit3 className="w-3 h-3" style={{ color: theme.colors.accent }} />
            </button>
          </div>
        ) : null}

        {/* First message / title row with optional rename button */}
        <div
          className={`flex items-center gap-1.5 ${session.sessionName ? 'mb-1' : 'mb-1.5'} group/title`}
        >
          <span
            className="font-medium truncate text-sm flex-1 min-w-0"
            style={{ color: session.sessionName ? theme.colors.textDim : theme.colors.textMain }}
          >
            {session.firstMessage || `Session ${session.sessionId.slice(0, 8)}...`}
          </span>
          {/* Rename button for sessions without a name (shows on hover) */}
          {!session.sessionName && !isRenaming && (
            <button
              onClick={(e) => onStartRename(session, e)}
              className="p-0.5 rounded opacity-0 group-hover/title:opacity-100 hover:bg-white/10 transition-all shrink-0"
              title="Add session name"
            >
              <Edit3 className="w-3 h-3" style={{ color: theme.colors.textDim }} />
            </button>
          )}
        </div>

        {/* Stats row: origin pill + session ID + stats + match info */}
        <div className="flex items-center gap-3 text-xs" style={{ color: theme.colors.textDim }}>
          {/* Session origin pill */}
          {session.origin === 'user' && (
            <span
              className="text-[10px] font-bold px-1.5 py-0.5 rounded"
              style={{ backgroundColor: theme.colors.accent + '30', color: theme.colors.accent }}
              title="User-initiated through Maestro"
            >
              MAESTRO
            </span>
          )}
          {session.origin === 'auto' && (
            <span
              className="text-[10px] font-bold px-1.5 py-0.5 rounded"
              style={{ backgroundColor: theme.colors.warning + '30', color: theme.colors.warning }}
              title="Auto-batch session through Maestro"
            >
              AUTO
            </span>
          )}
          {!session.origin && (
            <span
              className="text-[10px] font-bold px-1.5 py-0.5 rounded"
              style={{ backgroundColor: theme.colors.border, color: theme.colors.textDim }}
              title="Claude Code CLI session"
            >
              CLI
            </span>
          )}

          {/* Session ID pill */}
          <span
            className="text-[10px] font-mono px-1.5 py-0.5 rounded"
            style={{ backgroundColor: theme.colors.border + '60', color: theme.colors.textDim }}
          >
            {session.sessionId.startsWith('agent-')
              ? `AGENT-${session.sessionId.split('-')[1]?.toUpperCase() || ''}`
              : session.sessionId.split('-')[0].toUpperCase()}
          </span>

          {/* Stats */}
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {formatRelativeTime(session.modifiedAt)}
          </span>
          <span className="flex items-center gap-1">
            <MessageSquare className="w-3 h-3" />
            {session.messageCount}
          </span>
          <span className="flex items-center gap-1">
            <HardDrive className="w-3 h-3" />
            {formatSize(session.sizeBytes)}
          </span>

          {/* Cost per session */}
          {session.costUsd > 0 && (
            <span className="flex items-center gap-1 font-mono" style={{ color: theme.colors.success }}>
              <DollarSign className="w-3 h-3" />
              {session.costUsd.toFixed(2)}
            </span>
          )}

          {/* Show match count for content searches */}
          {searchResultInfo && searchResultInfo.matchCount > 0 && searchMode !== 'title' && (
            <span
              className="flex items-center gap-1 px-1.5 py-0.5 rounded"
              style={{ backgroundColor: theme.colors.accent + '20', color: theme.colors.accent }}
            >
              <Search className="w-3 h-3" />
              {searchResultInfo.matchCount}
            </span>
          )}

          {/* Show match preview for content searches */}
          {searchResultInfo && searchResultInfo.matchPreview && searchMode !== 'title' && (
            <span className="truncate italic max-w-[400px]" style={{ color: theme.colors.accent }}>
              "{searchResultInfo.matchPreview}"
            </span>
          )}
        </div>
      </div>

      {/* Active indicator */}
      {isActive && (
        <span
          className="text-[10px] px-2 py-0.5 rounded-full shrink-0"
          style={{ backgroundColor: theme.colors.success + '20', color: theme.colors.success }}
        >
          ACTIVE
        </span>
      )}
    </div>
  );
}
