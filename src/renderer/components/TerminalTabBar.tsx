/**
 * TerminalTabBar - Tab bar for managing multiple terminal tabs
 *
 * Similar to TabBar.tsx but simplified for terminal needs:
 * - No star/unread functionality
 * - No context menu (merge, send to agent, etc.)
 * - Simpler display names (Terminal 1, Terminal 2, or custom name)
 * - Shows shell type indicator
 * - Shows exit code if terminal exited
 */

import React, { useState, useRef, useCallback, useEffect, memo } from 'react';
import { X, Plus, Terminal as TerminalIcon } from 'lucide-react';
import type { TerminalTab, Theme } from '../types';
import { getTerminalTabDisplayName } from '../utils/terminalTabHelpers';

interface TerminalTabBarProps {
  tabs: TerminalTab[];
  activeTabId: string;
  theme: Theme;
  onTabSelect: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onNewTab: () => void;
  onRequestRename?: (tabId: string) => void;
  onTabReorder?: (fromIndex: number, toIndex: number) => void;
}

interface TerminalTabProps {
  tab: TerminalTab;
  index: number;
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
}

/**
 * Individual terminal tab component.
 * Displays terminal state via icon color: green (exited 0), red (exited non-zero), yellow (busy)
 */
const TerminalTabComponent = memo(function TerminalTabComponent({
  tab,
  index,
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
}: TerminalTabProps) {
  const [isHovered, setIsHovered] = useState(false);
  const displayName = getTerminalTabDisplayName(tab, index);
  const isExited = tab.state === 'exited';
  const isBusy = tab.state === 'busy';

  // Determine terminal icon color based on state
  const getIconColor = () => {
    if (isExited) {
      return tab.exitCode === 0 ? theme.colors.success : theme.colors.error;
    }
    if (isBusy) {
      return theme.colors.warning;
    }
    return isActive ? theme.colors.textMain : theme.colors.textDim;
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

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDrop={onDrop}
      onClick={onSelect}
      onMouseDown={handleMouseDown}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onDoubleClick={onRename}
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
        // Active tab has visible borders, inactive tabs have no borders
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
    >
      {/* Terminal icon with state indicator */}
      <TerminalIcon
        className="w-3.5 h-3.5 flex-shrink-0"
        style={{ color: getIconColor() }}
      />

      {/* Tab name */}
      <span
        className={`text-xs font-medium ${isActive ? 'whitespace-nowrap' : 'truncate max-w-[120px]'}`}
        style={{ color: isActive ? theme.colors.textMain : theme.colors.textDim }}
      >
        {displayName}
      </span>

      {/* Exit code indicator */}
      {isExited && tab.exitCode !== 0 && (
        <span
          className="text-[10px] opacity-70"
          style={{ color: theme.colors.error }}
          title={`Exit code: ${tab.exitCode}`}
        >
          ({tab.exitCode})
        </span>
      )}

      {/* Close button - visible on hover or when active */}
      {canClose && (isHovered || isActive) && (
        <button
          onClick={handleCloseClick}
          className="p-0.5 rounded hover:bg-white/10 transition-colors shrink-0"
          title="Close terminal"
        >
          <X
            className="w-3 h-3"
            style={{ color: theme.colors.textDim }}
          />
        </button>
      )}
    </div>
  );
});

/**
 * TerminalTabBar component for displaying terminal tabs.
 * Shows tabs for each PTY shell session within a Maestro session.
 * Appears only in terminal mode (hidden in AI mode).
 */
function TerminalTabBarInner({
  tabs,
  activeTabId,
  theme,
  onTabSelect,
  onTabClose,
  onNewTab,
  onRequestRename,
  onTabReorder,
}: TerminalTabBarProps) {
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  // Can close tabs if there's more than one
  const canClose = tabs.length > 1;

  // Center the active tab in the scrollable area when activeTabId changes
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
  }, [activeTabId]);

  // Check if tabs overflow the container
  useEffect(() => {
    const checkOverflow = () => {
      if (tabBarRef.current) {
        setIsOverflowing(tabBarRef.current.scrollWidth > tabBarRef.current.clientWidth);
      }
    };

    const timeoutId = setTimeout(checkOverflow, 0);
    window.addEventListener('resize', checkOverflow);
    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener('resize', checkOverflow);
    };
  }, [tabs.length]);

  const handleDragStart = useCallback((index: number) => (e: React.DragEvent) => {
    setDraggingIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  }, []);

  const handleDragOver = useCallback((index: number) => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggingIndex(null);
    setDragOverIndex(null);
  }, []);

  const handleDrop = useCallback((toIndex: number) => (e: React.DragEvent) => {
    e.preventDefault();
    const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (!isNaN(fromIndex) && fromIndex !== toIndex && onTabReorder) {
      onTabReorder(fromIndex, toIndex);
    }
    setDraggingIndex(null);
    setDragOverIndex(null);
  }, [onTabReorder]);

  const handleRenameRequest = useCallback((tabId: string) => {
    if (onRequestRename) {
      onRequestRename(tabId);
    }
  }, [onRequestRename]);

  // Determine the keyboard shortcut hint based on platform
  const shortcutKey = typeof navigator !== 'undefined' && navigator.platform?.includes('Mac') ? 'Ctrl+Shift+`' : 'Ctrl+Shift+`';

  return (
    <div
      ref={tabBarRef}
      className="flex items-end gap-0.5 pt-2 border-b overflow-x-auto overflow-y-hidden no-scrollbar"
      style={{
        backgroundColor: theme.colors.bgSidebar,
        borderColor: theme.colors.border,
        scrollbarWidth: 'thin',
      }}
    >
      {/* Tabs with separators between inactive tabs */}
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeTabId;
        const prevTab = index > 0 ? tabs[index - 1] : null;
        const isPrevActive = prevTab?.id === activeTabId;

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
            <div data-tab-id={tab.id}>
              <TerminalTabComponent
                tab={tab}
                index={index}
                isActive={isActive}
                theme={theme}
                canClose={canClose}
                onSelect={() => onTabSelect(tab.id)}
                onClose={() => onTabClose(tab.id)}
                onMiddleClick={() => canClose && onTabClose(tab.id)}
                onDragStart={handleDragStart(index)}
                onDragOver={handleDragOver(index)}
                onDragEnd={handleDragEnd}
                onDrop={handleDrop(index)}
                isDragging={draggingIndex === index}
                isDragOver={dragOverIndex === index}
                onRename={() => handleRenameRequest(tab.id)}
              />
            </div>
          </React.Fragment>
        );
      })}

      {/* New tab button - sticky on right when tabs overflow */}
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
          title={`New terminal (${shortcutKey})`}
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

export const TerminalTabBar = memo(TerminalTabBarInner);
