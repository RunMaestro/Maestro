import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, Star, Copy, Edit2, Mail, Pencil, Search, GitMerge, ArrowRightCircle, Minimize2, Clipboard } from 'lucide-react';
import type { AITab, Theme } from '../types';
import { hasDraft } from '../utils/tabHelpers';

interface TabBarProps {
  tabs: AITab[];
  activeTabId: string;
  theme: Theme;
  onTabSelect: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onNewTab: () => void;
  onRequestRename?: (tabId: string) => void;
  onTabReorder?: (fromIndex: number, toIndex: number) => void;
  onTabStar?: (tabId: string, starred: boolean) => void;
  onTabMarkUnread?: (tabId: string) => void;
  /** Handler to open merge session modal with this tab as source */
  onMergeWith?: (tabId: string) => void;
  /** Handler to open send to agent modal with this tab as source */
  onSendToAgent?: (tabId: string) => void;
  /** Handler to summarize and continue in a new tab */
  onSummarizeAndContinue?: (tabId: string) => void;
  /** Handler to copy conversation context to clipboard */
  onCopyContext?: (tabId: string) => void;
  showUnreadOnly?: boolean;
  onToggleUnreadFilter?: () => void;
  onOpenTabSearch?: () => void;
}

interface TabProps {
  tab: AITab;
  isActive: boolean;
  theme: Theme;
  canClose: boolean;
  onSelect: () => void;
  onClose: () => void;
  onMiddleClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDrop: (e: React.DragEvent) => void;
  isDragging: boolean;
  isDragOver: boolean;
  onRename: () => void;
  onStar?: (starred: boolean) => void;
  onMarkUnread?: () => void;
  /** Handler to open merge session modal with this tab as source */
  onMergeWith?: () => void;
  /** Handler to open send to agent modal with this tab as source */
  onSendToAgent?: () => void;
  /** Handler to summarize and continue in a new tab */
  onSummarizeAndContinue?: () => void;
  /** Handler to copy conversation context to clipboard */
  onCopyContext?: () => void;
  shortcutHint?: number | null;
  registerRef?: (el: HTMLDivElement | null) => void;
  hasDraft?: boolean;
}

/**
 * Get the display name for a tab.
 * Priority: name > truncated session ID > "New"
 *
 * Handles different agent session ID formats:
 * - Claude UUID: "abc123-def456-ghi789" → "ABC123" (first octet)
 * - OpenCode: "SES_4BCDFE8C5FFE4KC1UV9NSMYEDB" → "SES_4BCD" (prefix + 4 chars)
 * - Codex: "thread_abc123..." → "THR_ABC1" (prefix + 4 chars)
 */
function getTabDisplayName(tab: AITab): string {
  if (tab.name) {
    return tab.name;
  }
  if (tab.agentSessionId) {
    const id = tab.agentSessionId;

    // OpenCode format: ses_XXXX... or SES_XXXX...
    if (id.toLowerCase().startsWith('ses_')) {
      // Return "SES_" + first 4 chars of the ID portion
      return `SES_${id.slice(4, 8).toUpperCase()}`;
    }

    // Codex format: thread_XXXX...
    if (id.toLowerCase().startsWith('thread_')) {
      // Return "THR_" + first 4 chars of the ID portion
      return `THR_${id.slice(7, 11).toUpperCase()}`;
    }

    // Claude UUID format: has dashes, return first octet
    if (id.includes('-')) {
      return id.split('-')[0].toUpperCase();
    }

    // Generic fallback: first 8 chars uppercase
    return id.slice(0, 8).toUpperCase();
  }
  return 'New Session';
}

/**
 * Individual tab component styled like browser tabs (Safari/Chrome).
 * All tabs have visible borders; active tab connects to content area.
 * Includes hover overlay with session info and actions.
 */
function Tab({
  tab,
  isActive,
  theme,
  canClose,
  onSelect,
  onClose,
  onMiddleClick,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
  isDragging,
  isDragOver,
  onRename,
  onStar,
  onMarkUnread,
  onMergeWith,
  onSendToAgent,
  onSummarizeAndContinue,
  onCopyContext,
  shortcutHint,
  registerRef,
  hasDraft
}: TabProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [showCopied, setShowCopied] = useState(false);
  const [overlayPosition, setOverlayPosition] = useState<{ top: number; left: number } | null>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabRef = useRef<HTMLDivElement>(null);

  // Register ref with parent for scroll-into-view functionality
  const setTabRef = useCallback((el: HTMLDivElement | null) => {
    (tabRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    registerRef?.(el);
  }, [registerRef]);

  const handleMouseEnter = () => {
    setIsHovered(true);
    // Only show overlay for tabs with an established Claude session
    // New/empty tabs don't have a session yet, so star/rename don't apply
    if (!tab.agentSessionId) return;

    // Open overlay after delay
    hoverTimeoutRef.current = setTimeout(() => {
      // Calculate position for fixed overlay
      if (tabRef.current) {
        const rect = tabRef.current.getBoundingClientRect();
        setOverlayPosition({ top: rect.bottom + 4, left: rect.left });
      }
      setOverlayOpen(true);
    }, 400);
  };

  // Ref to track if mouse is over the overlay
  const isOverOverlayRef = useRef(false);

  const handleMouseLeave = () => {
    setIsHovered(false);
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    // Delay closing overlay to allow mouse to reach it (there's a gap between tab and overlay)
    hoverTimeoutRef.current = setTimeout(() => {
      if (!isOverOverlayRef.current) {
        setOverlayOpen(false);
      }
    }, 100);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    // Middle-click to close
    if (e.button === 1 && canClose) {
      e.preventDefault();
      onMiddleClick();
    }
  };

  const handleCloseClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();
  };

  const handleCopySessionId = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (tab.agentSessionId) {
      navigator.clipboard.writeText(tab.agentSessionId);
      setShowCopied(true);
      setTimeout(() => setShowCopied(false), 1500);
    }
  };

  const handleStarClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onStar?.(!tab.starred);
  };

  const handleRenameClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Call rename immediately (before closing overlay) to ensure prompt isn't blocked
    // Browsers block window.prompt() when called from setTimeout since it's not a direct user action
    onRename();
    setOverlayOpen(false);
  };

  const handleMarkUnreadClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onMarkUnread?.();
    setOverlayOpen(false);
  };

  const handleMergeWithClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onMergeWith?.();
    setOverlayOpen(false);
  };

  const handleSendToAgentClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSendToAgent?.();
    setOverlayOpen(false);
  };

  const handleSummarizeAndContinueClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSummarizeAndContinue?.();
    setOverlayOpen(false);
  };

  const handleCopyContextClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onCopyContext?.();
    setOverlayOpen(false);
  };

  const displayName = getTabDisplayName(tab);

  // Browser-style tab: all tabs have borders, active tab "connects" to content
  // Active tab is bright and obvious, inactive tabs are more muted
  return (
    <div
      ref={setTabRef}
      data-tab-id={tab.id}
      className={`
        relative flex items-center gap-1.5 px-3 py-1.5 cursor-pointer
        transition-all duration-150 select-none
        ${isDragging ? 'opacity-50' : ''}
        ${isDragOver ? 'ring-2 ring-inset' : ''}
      `}
      style={{
        // All tabs have rounded top corners
        borderTopLeftRadius: '6px',
        borderTopRightRadius: '6px',
        // Active tab: bright background matching content area
        // Inactive tabs: transparent with subtle hover
        backgroundColor: isActive
          ? theme.colors.bgMain
          : (isHovered ? 'rgba(255, 255, 255, 0.08)' : 'transparent'),
        // Active tab has visible borders, inactive tabs have no borders (cleaner look)
        borderTop: isActive ? `1px solid ${theme.colors.border}` : '1px solid transparent',
        borderLeft: isActive ? `1px solid ${theme.colors.border}` : '1px solid transparent',
        borderRight: isActive ? `1px solid ${theme.colors.border}` : '1px solid transparent',
        // Active tab has no bottom border (connects to content)
        borderBottom: isActive ? `1px solid ${theme.colors.bgMain}` : '1px solid transparent',
        // Active tab sits on top of the tab bar's bottom border
        marginBottom: isActive ? '-1px' : '0',
        // Slight z-index for active tab to cover border properly
        zIndex: isActive ? 1 : 0,
        '--tw-ring-color': isDragOver ? theme.colors.accent : 'transparent'
      } as React.CSSProperties}
      onClick={onSelect}
      onMouseDown={handleMouseDown}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDrop={onDrop}
      title={tab.name || tab.agentSessionId || 'New tab'}
    >
      {/* Busy indicator - pulsing dot for tabs in write mode */}
      {tab.state === 'busy' && (
        <div
          className="w-2 h-2 rounded-full shrink-0 animate-pulse"
          style={{ backgroundColor: theme.colors.warning }}
        />
      )}

      {/* Unread indicator - solid dot for tabs with unread messages (not shown when busy) */}
      {tab.state !== 'busy' && tab.hasUnread && (
        <div
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: theme.colors.accent }}
          title="New messages"
        />
      )}

      {/* Star indicator for starred sessions - only show if tab has a session ID */}
      {tab.starred && tab.agentSessionId && (
        <Star
          className="w-3 h-3 fill-current shrink-0"
          style={{ color: theme.colors.warning }}
        />
      )}

      {/* Draft indicator - pencil icon for tabs with unsent input or staged images */}
      {hasDraft && (
        <span title="Has draft message">
          <Pencil
            className="w-3 h-3 shrink-0"
            style={{ color: theme.colors.warning }}
          />
        </span>
      )}

      {/* Shortcut hint badge - shows tab number for Cmd+1-9 navigation */}
      {shortcutHint !== null && shortcutHint !== undefined && (
        <span
          className="w-4 h-4 flex items-center justify-center rounded text-[10px] font-medium shrink-0 opacity-50"
          style={{
            backgroundColor: theme.colors.border,
            color: theme.colors.textMain
          }}
        >
          {shortcutHint}
        </span>
      )}

      {/* Tab name - show full name for active tab, truncate inactive tabs */}
      <span
        className={`text-xs font-medium ${isActive ? 'whitespace-nowrap' : 'truncate max-w-[120px]'}`}
        style={{ color: isActive ? theme.colors.textMain : theme.colors.textDim }}
      >
        {displayName}
      </span>

      {/* Close button - visible on hover or when active, takes space of busy indicator when not busy */}
      {canClose && (isHovered || isActive) && (
        <button
          onClick={handleCloseClick}
          className="p-0.5 rounded hover:bg-white/10 transition-colors shrink-0"
          title="Close tab"
        >
          <X
            className="w-3 h-3"
            style={{ color: theme.colors.textDim }}
          />
        </button>
      )}

      {/* Hover overlay with session info and actions - rendered via portal to escape stacking context */}
      {overlayOpen && overlayPosition && createPortal(
        <div
          className="fixed z-[100] rounded-lg shadow-xl border overflow-hidden"
          style={{
            backgroundColor: theme.colors.bgSidebar,
            borderColor: theme.colors.border,
            minWidth: '220px',
            top: overlayPosition.top,
            left: overlayPosition.left
          }}
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={() => {
            // Keep overlay open when mouse enters it
            isOverOverlayRef.current = true;
            if (hoverTimeoutRef.current) {
              clearTimeout(hoverTimeoutRef.current);
              hoverTimeoutRef.current = null;
            }
          }}
          onMouseLeave={() => {
            // Close overlay when mouse leaves it
            isOverOverlayRef.current = false;
            setOverlayOpen(false);
            setIsHovered(false);
          }}
        >
          {/* Header with session name and ID */}
          <div
            className="border-b"
            style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border }}
          >
            {/* Session name display */}
            {tab.name && (
              <div
                className="px-3 py-2 text-sm font-medium"
                style={{ color: theme.colors.textMain }}
              >
                {tab.name}
              </div>
            )}

            {/* Session ID display */}
            {tab.agentSessionId && (
              <div
                className="px-3 py-2 text-[10px] font-mono"
                style={{ color: theme.colors.textDim }}
              >
                {tab.agentSessionId}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="p-1">
            {tab.agentSessionId && (
              <button
                onClick={handleCopySessionId}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
                style={{ color: theme.colors.textMain }}
                title={`Full ID: ${tab.agentSessionId}`}
              >
                <Copy className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
                {showCopied ? 'Copied!' : 'Copy Session ID'}
              </button>
            )}

            {/* Star button - only show for tabs with established session */}
            {tab.agentSessionId && (
              <button
                onClick={handleStarClick}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
                style={{ color: theme.colors.textMain }}
              >
                <Star
                  className={`w-3.5 h-3.5 ${tab.starred ? 'fill-current' : ''}`}
                  style={{ color: tab.starred ? theme.colors.warning : theme.colors.textDim }}
                />
                {tab.starred ? 'Unstar Session' : 'Star Session'}
              </button>
            )}

            <button
              onClick={handleRenameClick}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
              style={{ color: theme.colors.textMain }}
            >
              <Edit2 className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
              Rename Tab
            </button>

            <button
              onClick={handleMarkUnreadClick}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
              style={{ color: theme.colors.textMain }}
            >
              <Mail className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
              Mark as Unread
            </button>

            {/* Context Management Section - divider and grouped options */}
            {(tab.agentSessionId || (tab.logs?.length ?? 0) >= 1) && (onMergeWith || onSendToAgent || onSummarizeAndContinue || onCopyContext) && (
              <div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
            )}

            {/* Context: Copy to Clipboard */}
            {(tab.logs?.length ?? 0) >= 1 && onCopyContext && (
              <button
                onClick={handleCopyContextClick}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
                style={{ color: theme.colors.textMain }}
              >
                <Clipboard className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
                Context: Copy to Clipboard
              </button>
            )}

            {/* Context: Compact */}
            {(tab.logs?.length ?? 0) >= 5 && onSummarizeAndContinue && (
              <button
                onClick={handleSummarizeAndContinueClick}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
                style={{ color: theme.colors.textMain }}
              >
                <Minimize2 className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
                Context: Compact
              </button>
            )}

            {/* Context: Merge Into */}
            {tab.agentSessionId && onMergeWith && (
              <button
                onClick={handleMergeWithClick}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
                style={{ color: theme.colors.textMain }}
              >
                <GitMerge className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
                Context: Merge Into
              </button>
            )}

            {/* Context: Send to Agent */}
            {tab.agentSessionId && onSendToAgent && (
              <button
                onClick={handleSendToAgentClick}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
                style={{ color: theme.colors.textMain }}
              >
                <ArrowRightCircle className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
                Context: Send to Agent
              </button>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

/**
 * TabBar component for displaying AI session tabs.
 * Shows tabs for each Claude Code conversation within a Maestro session.
 * Appears only in AI mode (hidden in terminal mode).
 */
export function TabBar({
  tabs,
  activeTabId,
  theme,
  onTabSelect,
  onTabClose,
  onNewTab,
  onRequestRename,
  onTabReorder,
  onTabStar,
  onTabMarkUnread,
  onMergeWith,
  onSendToAgent,
  onSummarizeAndContinue,
  onCopyContext,
  showUnreadOnly: showUnreadOnlyProp,
  onToggleUnreadFilter,
  onOpenTabSearch
}: TabBarProps) {
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  // Use prop if provided (controlled), otherwise use local state (uncontrolled)
  const [showUnreadOnlyLocal, setShowUnreadOnlyLocal] = useState(false);
  const showUnreadOnly = showUnreadOnlyProp ?? showUnreadOnlyLocal;
  const toggleUnreadFilter = onToggleUnreadFilter ?? (() => setShowUnreadOnlyLocal(prev => !prev));

  const tabBarRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [isOverflowing, setIsOverflowing] = useState(false);

  // Center the active tab in the scrollable area when activeTabId changes or filter is toggled
  useEffect(() => {
    requestAnimationFrame(() => {
      const container = tabBarRef.current;
      const tabElement = container?.querySelector(`[data-tab-id="${activeTabId}"]`) as HTMLElement | null;
      if (container && tabElement) {
        // Calculate scroll position to center the tab
        const scrollLeft = tabElement.offsetLeft - (container.clientWidth / 2) + (tabElement.offsetWidth / 2);
        container.scrollTo({ left: scrollLeft, behavior: 'smooth' });
      }
    });
  }, [activeTabId, showUnreadOnly]);

  // Can always close tabs - closing the last one creates a fresh new tab
  const canClose = true;

  const handleDragStart = useCallback((tabId: string, e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tabId);
    setDraggingTabId(tabId);
  }, []);

  const handleDragOver = useCallback((tabId: string, e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (tabId !== draggingTabId) {
      setDragOverTabId(tabId);
    }
  }, [draggingTabId]);

  const handleDragEnd = useCallback(() => {
    setDraggingTabId(null);
    setDragOverTabId(null);
  }, []);

  const handleDrop = useCallback((targetTabId: string, e: React.DragEvent) => {
    e.preventDefault();
    const sourceTabId = e.dataTransfer.getData('text/plain');

    if (sourceTabId && sourceTabId !== targetTabId && onTabReorder) {
      const sourceIndex = tabs.findIndex(t => t.id === sourceTabId);
      const targetIndex = tabs.findIndex(t => t.id === targetTabId);

      if (sourceIndex !== -1 && targetIndex !== -1) {
        onTabReorder(sourceIndex, targetIndex);
      }
    }

    setDraggingTabId(null);
    setDragOverTabId(null);
  }, [tabs, onTabReorder]);

  const handleRenameRequest = useCallback((tabId: string) => {
    // Request rename via modal (window.prompt doesn't work in Electron)
    if (onRequestRename) {
      onRequestRename(tabId);
    }
  }, [onRequestRename]);

  // Count unread tabs for the filter toggle tooltip
  const _unreadCount = tabs.filter(t => t.hasUnread).length;

  // Filter tabs based on unread filter state
  // When filter is on, show: unread tabs + active tab + tabs with drafts
  // The active tab disappears from the filtered list when user navigates away from it
  const displayedTabs = showUnreadOnly
    ? tabs.filter(t => t.hasUnread || t.id === activeTabId || hasDraft(t))
    : tabs;

  // Check if tabs overflow the container (need sticky + button)
  useEffect(() => {
    const checkOverflow = () => {
      if (tabBarRef.current) {
        // scrollWidth > clientWidth means content overflows
        setIsOverflowing(tabBarRef.current.scrollWidth > tabBarRef.current.clientWidth);
      }
    };

    // Check after DOM renders
    const timeoutId = setTimeout(checkOverflow, 0);

    // Re-check on window resize
    window.addEventListener('resize', checkOverflow);
    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener('resize', checkOverflow);
    };
  }, [tabs.length, displayedTabs.length]);

  return (
    <div
      ref={tabBarRef}
      className="flex items-end gap-0.5 pt-2 border-b overflow-x-auto overflow-y-hidden no-scrollbar"
      style={{
        backgroundColor: theme.colors.bgSidebar,
        borderColor: theme.colors.border
      }}
    >
      {/* Tab search and unread filter - sticky at the beginning with full-height opaque background */}
      <div
        className="sticky left-0 flex items-center shrink-0 pl-2 pr-1 gap-1 self-stretch"
        style={{ backgroundColor: theme.colors.bgSidebar, zIndex: 5 }}
      >
        {/* Tab search button */}
        {onOpenTabSearch && (
          <button
            onClick={onOpenTabSearch}
            className="flex items-center justify-center w-6 h-6 rounded hover:bg-white/10 transition-colors"
            style={{ color: theme.colors.textDim }}
            title="Search tabs (Cmd+Shift+O)"
          >
            <Search className="w-4 h-4" />
          </button>
        )}
        {/* Unread filter toggle */}
        <button
          onClick={toggleUnreadFilter}
          className="relative flex items-center justify-center w-6 h-6 rounded transition-colors"
          style={{
            color: showUnreadOnly ? theme.colors.accent : theme.colors.textDim,
            opacity: showUnreadOnly ? 1 : 0.5
          }}
          title={showUnreadOnly ? 'Showing unread only (Cmd+U)' : 'Filter unread tabs (Cmd+U)'}
        >
          <Mail className="w-4 h-4" />
          {/* Notification dot */}
          <div
            className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full"
            style={{ backgroundColor: theme.colors.accent }}
          />
        </button>
      </div>

      {/* Empty state when filter is on but no unread tabs */}
      {showUnreadOnly && displayedTabs.length === 0 && (
        <div
          className="flex items-center px-3 py-1.5 text-xs italic shrink-0 self-center mb-1"
          style={{ color: theme.colors.textDim }}
        >
          No unread tabs
        </div>
      )}

      {/* Tabs with separators between inactive tabs */}
      {displayedTabs.map((tab, index) => {
        const isActive = tab.id === activeTabId;
        const prevTab = index > 0 ? displayedTabs[index - 1] : null;
        const isPrevActive = prevTab?.id === activeTabId;
        // Get original index for shortcut hints (Cmd+1-9)
        const originalIndex = tabs.findIndex(t => t.id === tab.id);

        // Show separator between inactive tabs (not adjacent to active tab)
        const showSeparator = index > 0 && !isActive && !isPrevActive;

        return (
          <React.Fragment key={tab.id}>
            {showSeparator && (
              <div
                className="w-px h-4 self-center shrink-0"
                style={{ backgroundColor: theme.colors.border }}
              />
            )}
            <Tab
              tab={tab}
              isActive={isActive}
              theme={theme}
              canClose={canClose}
              onSelect={() => onTabSelect(tab.id)}
              onClose={() => onTabClose(tab.id)}
              onMiddleClick={() => canClose && onTabClose(tab.id)}
              onDragStart={(e) => handleDragStart(tab.id, e)}
              onDragOver={(e) => handleDragOver(tab.id, e)}
              onDragEnd={handleDragEnd}
              onDrop={(e) => handleDrop(tab.id, e)}
              isDragging={draggingTabId === tab.id}
              isDragOver={dragOverTabId === tab.id}
              onRename={() => handleRenameRequest(tab.id)}
              onStar={onTabStar && tab.agentSessionId ? (starred) => onTabStar(tab.id, starred) : undefined}
              onMarkUnread={onTabMarkUnread ? () => onTabMarkUnread(tab.id) : undefined}
              onMergeWith={onMergeWith && tab.agentSessionId ? () => onMergeWith(tab.id) : undefined}
              onSendToAgent={onSendToAgent && tab.agentSessionId ? () => onSendToAgent(tab.id) : undefined}
              onSummarizeAndContinue={onSummarizeAndContinue && (tab.logs?.length ?? 0) >= 5 ? () => onSummarizeAndContinue(tab.id) : undefined}
              onCopyContext={onCopyContext && (tab.logs?.length ?? 0) >= 1 ? () => onCopyContext(tab.id) : undefined}
              shortcutHint={!showUnreadOnly && originalIndex < 9 ? originalIndex + 1 : null}
              hasDraft={hasDraft(tab)}
              registerRef={(el) => {
                if (el) {
                  tabRefs.current.set(tab.id, el);
                } else {
                  tabRefs.current.delete(tab.id);
                }
              }}
            />
          </React.Fragment>
        );
      })}

      {/* New Tab Button - sticky on right when tabs overflow, with full-height opaque background */}
      <div
        className={`flex items-center shrink-0 pl-2 pr-2 self-stretch ${isOverflowing ? 'sticky right-0' : ''}`}
        style={{
          backgroundColor: theme.colors.bgSidebar,
          zIndex: 5
        }}
      >
        <button
          onClick={onNewTab}
          className="flex items-center justify-center w-6 h-6 rounded hover:bg-white/10 transition-colors"
          style={{ color: theme.colors.textDim }}
          title="New tab (Cmd+T)"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

    </div>
  );
}
