import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, Star, Copy, Edit2, Mail, Pencil } from 'lucide-react';
import type { AITab, Theme } from '../types';

interface TabBarProps {
  tabs: AITab[];
  activeTabId: string;
  theme: Theme;
  onTabSelect: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onNewTab: () => void;
  onTabRename?: (tabId: string, newName: string) => void;
  onRequestRename?: (tabId: string) => void;
  onTabReorder?: (fromIndex: number, toIndex: number) => void;
  onCloseOthers?: (tabId: string) => void;
  onTabStar?: (tabId: string, starred: boolean) => void;
  showUnreadOnly?: boolean;
  onToggleUnreadFilter?: () => void;
}

interface TabProps {
  tab: AITab;
  isActive: boolean;
  theme: Theme;
  canClose: boolean;
  onSelect: () => void;
  onClose: () => void;
  onMiddleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDrop: (e: React.DragEvent) => void;
  isDragging: boolean;
  isDragOver: boolean;
  onRename: () => void;
  onStar?: (starred: boolean) => void;
  shortcutHint?: number | null;
  registerRef?: (el: HTMLDivElement | null) => void;
  hasDraft?: boolean;
}

/**
 * Get the display name for a tab.
 * Priority: name > first UUID octet > "New"
 */
function getTabDisplayName(tab: AITab): string {
  if (tab.name) {
    return tab.name;
  }
  if (tab.claudeSessionId) {
    // Return first octet of UUID in uppercase
    return tab.claudeSessionId.split('-')[0].toUpperCase();
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
  onContextMenu,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
  isDragging,
  isDragOver,
  onRename,
  onStar,
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
    if (!tab.claudeSessionId) return;

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
    if (tab.claudeSessionId) {
      navigator.clipboard.writeText(tab.claudeSessionId);
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

  const displayName = getTabDisplayName(tab);

  // Browser-style tab: all tabs have borders, active tab "connects" to content
  // Active tab is bright and obvious, inactive tabs are more muted
  return (
    <div
      ref={setTabRef}
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
        ringColor: isDragOver ? theme.colors.accent : 'transparent'
      }}
      onClick={onSelect}
      onMouseDown={handleMouseDown}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onContextMenu={onContextMenu}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDrop={onDrop}
      title={tab.name || tab.claudeSessionId || 'New tab'}
    >
      {/* Busy indicator - pulsing dot for tabs in write mode */}
      {tab.state === 'busy' && (
        <div
          className="w-2 h-2 rounded-full shrink-0 animate-pulse"
          style={{ backgroundColor: theme.colors.warning }}
        />
      )}

      {/* Unread indicator - solid dot for tabs with unread messages (only when not active and not busy) */}
      {!isActive && tab.state !== 'busy' && tab.hasUnread && (
        <div
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: theme.colors.accent }}
          title="New messages"
        />
      )}

      {/* Star indicator for starred sessions */}
      {tab.starred && (
        <Star
          className="w-3 h-3 fill-current shrink-0"
          style={{ color: theme.colors.warning }}
        />
      )}

      {/* Draft indicator - pencil icon for tabs with unsent input or staged images */}
      {hasDraft && (
        <Pencil
          className="w-3 h-3 shrink-0"
          style={{ color: theme.colors.textDim }}
          title="Has draft message"
        />
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

      {/* Tab name */}
      <span
        className="text-xs font-medium truncate max-w-[120px]"
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
            {tab.claudeSessionId && (
              <div
                className="px-3 py-2 text-[10px] font-mono"
                style={{ color: theme.colors.textDim }}
              >
                {tab.claudeSessionId}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="p-1">
            {tab.claudeSessionId && (
              <button
                onClick={handleCopySessionId}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
                style={{ color: theme.colors.textMain }}
              >
                <Copy className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
                {showCopied ? 'Copied!' : 'Copy Session ID'}
              </button>
            )}

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

            <button
              onClick={handleRenameClick}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
              style={{ color: theme.colors.textMain }}
            >
              <Edit2 className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
              Rename Tab
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

/**
 * Context menu for tab right-click actions.
 */
interface ContextMenuProps {
  x: number;
  y: number;
  theme: Theme;
  canClose: boolean;
  canCloseOthers: boolean;
  onRename: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onDismiss: () => void;
}

function ContextMenu({
  x,
  y,
  theme,
  canClose,
  canCloseOthers,
  onRename,
  onClose,
  onCloseOthers,
  onDismiss
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  React.useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onDismiss]);

  // Close on Escape
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onDismiss();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onDismiss]);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 py-1 rounded-md shadow-xl border"
      style={{
        left: x,
        top: y,
        backgroundColor: theme.colors.bgSidebar,
        borderColor: theme.colors.border,
        minWidth: '140px'
      }}
    >
      <button
        onClick={() => {
          onRename();
          onDismiss();
        }}
        className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors"
        style={{ color: theme.colors.textMain }}
      >
        Rename
      </button>
      {canClose && (
        <button
          onClick={() => {
            onClose();
            onDismiss();
          }}
          className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors"
          style={{ color: theme.colors.textMain }}
        >
          Close
        </button>
      )}
      {canCloseOthers && (
        <button
          onClick={() => {
            onCloseOthers();
            onDismiss();
          }}
          className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors"
          style={{ color: theme.colors.textMain }}
        >
          Close Others
        </button>
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
  onTabRename,
  onRequestRename,
  onTabReorder,
  onCloseOthers,
  onTabStar,
  showUnreadOnly: showUnreadOnlyProp,
  onToggleUnreadFilter
}: TabBarProps) {
  const [contextMenu, setContextMenu] = useState<{
    tabId: string;
    x: number;
    y: number;
  } | null>(null);

  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  // Use prop if provided (controlled), otherwise use local state (uncontrolled)
  const [showUnreadOnlyLocal, setShowUnreadOnlyLocal] = useState(false);
  const showUnreadOnly = showUnreadOnlyProp ?? showUnreadOnlyLocal;
  const toggleUnreadFilter = onToggleUnreadFilter ?? (() => setShowUnreadOnlyLocal(prev => !prev));

  const tabBarRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [isOverflowing, setIsOverflowing] = useState(false);
  const prevTabCountRef = useRef(tabs.length);
  const prevActiveTabIdRef = useRef(activeTabId);

  // Scroll active tab into view when user navigates to a different tab
  // Use 'center' to ensure the tab isn't hidden under sticky elements (unread filter, new tab button)
  // Don't scroll when closing tabs (tab count decreased) to avoid jarring movement
  useEffect(() => {
    const tabCountDecreased = tabs.length < prevTabCountRef.current;
    const activeTabChanged = activeTabId !== prevActiveTabIdRef.current;

    // Update refs for next comparison
    prevTabCountRef.current = tabs.length;
    prevActiveTabIdRef.current = activeTabId;

    // Only scroll if active tab changed AND we didn't just close a tab
    if (activeTabChanged && !tabCountDecreased) {
      const timeoutId = setTimeout(() => {
        const activeTabElement = tabRefs.current.get(activeTabId);
        if (activeTabElement) {
          activeTabElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
      }, 0);
      return () => clearTimeout(timeoutId);
    }
  }, [activeTabId, tabs.length]);

  // Can always close tabs - closing the last one creates a fresh new tab
  const canClose = true;

  const handleContextMenu = useCallback((tabId: string, e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({
      tabId,
      x: e.clientX,
      y: e.clientY
    });
  }, []);

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
  const unreadCount = tabs.filter(t => t.hasUnread).length;

  // Check if a tab has draft content (unsent input or staged images)
  const hasDraft = (tab: AITab) => (tab.inputValue && tab.inputValue.trim() !== '') || (tab.stagedImages && tab.stagedImages.length > 0);

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
      {/* Unread filter toggle - sticky at the beginning with full-height opaque background */}
      <div
        className="sticky left-0 flex items-center shrink-0 pl-2 pr-2 self-stretch group"
        style={{ backgroundColor: theme.colors.bgSidebar, zIndex: 5 }}
      >
        <button
          onClick={toggleUnreadFilter}
          className="relative flex items-center justify-center w-6 h-6 rounded transition-colors"
          style={{
            color: showUnreadOnly ? theme.colors.accent : theme.colors.textDim,
            opacity: showUnreadOnly ? 1 : 0.5
          }}
        >
          <Mail className="w-4 h-4" />
          {/* Notification dot */}
          <div
            className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full"
            style={{ backgroundColor: theme.colors.accent }}
          />
        </button>
        {/* Hover overlay */}
        <div
          className="absolute left-2 top-full mt-1 px-2 py-1 rounded text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
          style={{
            backgroundColor: theme.colors.bgSidebar,
            border: `1px solid ${theme.colors.border}`,
            color: theme.colors.textMain,
            zIndex: 6
          }}
        >
          {showUnreadOnly ? 'Showing unread only' : 'Filter unread tabs'}
        </div>
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
              onContextMenu={(e) => handleContextMenu(tab.id, e)}
              onDragStart={(e) => handleDragStart(tab.id, e)}
              onDragOver={(e) => handleDragOver(tab.id, e)}
              onDragEnd={handleDragEnd}
              onDrop={(e) => handleDrop(tab.id, e)}
              isDragging={draggingTabId === tab.id}
              isDragOver={dragOverTabId === tab.id}
              onRename={() => handleRenameRequest(tab.id)}
              onStar={onTabStar ? (starred) => onTabStar(tab.id, starred) : undefined}
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

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          theme={theme}
          canClose={canClose}
          canCloseOthers={tabs.length > 1}
          onRename={() => handleRenameRequest(contextMenu.tabId)}
          onClose={() => onTabClose(contextMenu.tabId)}
          onCloseOthers={() => onCloseOthers?.(contextMenu.tabId)}
          onDismiss={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
