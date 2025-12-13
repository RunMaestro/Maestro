/**
 * CommandHistoryDrawer - Swipe-up drawer for command history
 *
 * A touch-friendly drawer component that slides up from the bottom
 * to show command history. Can be triggered by swiping up from the
 * input area or tapping a history button.
 *
 * Features:
 * - Swipe up gesture to open from input area
 * - Swipe down gesture to close
 * - Touch-friendly history items
 * - Quick-tap to reuse commands
 * - Swipe left to reveal delete button (common mobile pattern)
 * - Long-press to delete individual commands
 * - Clear all history option
 */

import React, { useRef, useCallback, useState, useEffect } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { triggerHaptic, HAPTIC_PATTERNS, GESTURE_THRESHOLDS } from './constants';
import { formatRelativeTime } from '../../shared/formatters';
import { useSwipeGestures } from '../hooks/useSwipeGestures';
import type { CommandHistoryEntry } from '../hooks/useCommandHistory';

/** Height of the drawer handle area */
const HANDLE_HEIGHT = 28;

/** Minimum height when drawer is collapsed */
const MIN_DRAWER_HEIGHT = 0;

/** Maximum height as percentage of viewport */
const MAX_DRAWER_HEIGHT_PERCENT = 0.6;

/** Velocity threshold for flick gestures (px/ms) */
const FLICK_VELOCITY_THRESHOLD = 0.5;

/** Snap threshold - if dragged past this percentage, snap open/close */
const SNAP_THRESHOLD = 0.3;

export interface CommandHistoryDrawerProps {
  /** Whether the drawer is open */
  isOpen: boolean;
  /** Callback when drawer should close */
  onClose: () => void;
  /** Command history entries to display */
  history: CommandHistoryEntry[];
  /** Callback when a command is selected */
  onSelectCommand: (command: string) => void;
  /** Callback when a command is deleted */
  onDeleteCommand?: (id: string) => void;
  /** Callback to clear all history */
  onClearHistory?: () => void;
}

// formatRelativeTime imported from ../../shared/formatters

/**
 * Truncate command text for display
 */
function truncateCommand(command: string, maxLength = 60): string {
  if (command.length <= maxLength) return command;
  return command.slice(0, maxLength - 3) + '...';
}

/** Width of the delete action button revealed on swipe */
const DELETE_ACTION_WIDTH = 80;

/** Threshold for triggering delete action on swipe */
const DELETE_SWIPE_THRESHOLD = 60;

/**
 * Props for SwipeableHistoryItem component
 */
interface SwipeableHistoryItemProps {
  entry: CommandHistoryEntry;
  onSelect: (command: string) => void;
  onDelete?: (id: string) => void;
  isLongPressed: boolean;
  onLongPressStart: (id: string) => void;
  onLongPressEnd: () => void;
}

/**
 * Individual swipeable history item with swipe-to-delete functionality
 */
function SwipeableHistoryItem({
  entry,
  onSelect,
  onDelete,
  isLongPressed,
  onLongPressStart,
  onLongPressEnd,
}: SwipeableHistoryItemProps) {
  const colors = useThemeColors();
  const [showDeleteAction, setShowDeleteAction] = useState(false);

  // Swipe gesture hook for swipe-to-delete
  const {
    handlers: swipeHandlers,
    offsetX,
    isSwiping,
    resetOffset,
  } = useSwipeGestures({
    onSwipeLeft: onDelete ? () => {
      // Show delete action on swipe left
      triggerHaptic(HAPTIC_PATTERNS.tap);
      setShowDeleteAction(true);
    } : undefined,
    onSwipeRight: () => {
      // Hide delete action on swipe right
      setShowDeleteAction(false);
    },
    trackOffset: true,
    threshold: DELETE_SWIPE_THRESHOLD,
    maxOffset: DELETE_ACTION_WIDTH + 20,
    enabled: !!onDelete,
  });

  // Handle tap on the item
  const handleTap = useCallback(() => {
    if (showDeleteAction) {
      // Tap to dismiss delete action
      setShowDeleteAction(false);
      resetOffset();
    } else if (!isLongPressed) {
      onSelect(entry.command);
    }
  }, [showDeleteAction, isLongPressed, entry.command, onSelect, resetOffset]);

  // Handle delete button tap
  const handleDeleteTap = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    triggerHaptic(HAPTIC_PATTERNS.success);
    onDelete?.(entry.id);
    setShowDeleteAction(false);
    resetOffset();
  }, [entry.id, onDelete, resetOffset]);

  // Calculate transform based on swipe offset or delete action state
  const translateX = showDeleteAction
    ? -DELETE_ACTION_WIDTH
    : Math.min(0, offsetX); // Only allow left swipe

  return (
    <div
      style={{
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Delete action button (revealed on swipe left) */}
      {onDelete && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 1, // Account for border
            width: `${DELETE_ACTION_WIDTH}px`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#ef4444',
            cursor: 'pointer',
            opacity: showDeleteAction || offsetX < -20 ? 1 : 0,
            transition: 'opacity 0.15s ease',
          }}
          onClick={handleDeleteTap}
          aria-label="Delete command"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#ffffff"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </div>
      )}

      {/* Swipeable item content */}
      <div
        {...swipeHandlers}
        onClick={handleTap}
        onTouchStart={(e) => {
          swipeHandlers.onTouchStart(e);
          onLongPressStart(entry.id);
        }}
        onTouchEnd={(e) => {
          swipeHandlers.onTouchEnd(e);
          onLongPressEnd();
        }}
        onTouchCancel={(e) => {
          swipeHandlers.onTouchCancel(e);
          onLongPressEnd();
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          padding: '12px 16px',
          cursor: 'pointer',
          backgroundColor: isLongPressed
            ? `${colors.accent}15`
            : colors.bgSidebar,
          transition: isSwiping ? 'none' : 'transform 0.3s ease, background-color 0.15s ease',
          transform: `translateX(${translateX}px)`,
          WebkitTapHighlightColor: 'transparent',
          borderBottom: `1px solid ${colors.border}`,
          touchAction: 'pan-y',
        }}
      >
        {/* Mode indicator icon */}
        <div
          style={{
            width: '28px',
            height: '28px',
            borderRadius: '6px',
            backgroundColor:
              entry.mode === 'ai'
                ? `${colors.accent}20`
                : `${colors.textDim}20`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          {entry.mode === 'ai' ? (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke={colors.accent}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 3v2M12 19v2M5.64 5.64l1.42 1.42M16.95 16.95l1.41 1.41M3 12h2M19 12h2M5.64 18.36l1.42-1.42M16.95 7.05l1.41-1.41" />
              <circle cx="12" cy="12" r="4" />
            </svg>
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke={colors.textDim}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          )}
        </div>

        {/* Command text and timestamp */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            style={{
              margin: 0,
              fontSize: '14px',
              color: colors.textMain,
              fontFamily: 'ui-monospace, monospace',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {truncateCommand(entry.command)}
          </p>
          <p
            style={{
              margin: '2px 0 0',
              fontSize: '11px',
              color: colors.textDim,
            }}
          >
            {formatRelativeTime(entry.timestamp)}
          </p>
        </div>

        {/* Swipe hint indicator (chevron) */}
        {onDelete && !showDeleteAction && (
          <div
            style={{
              opacity: 0.3,
              color: colors.textDim,
              fontSize: '12px',
            }}
            aria-hidden="true"
          >
            ‹
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * CommandHistoryDrawer component
 */
export function CommandHistoryDrawer({
  isOpen,
  onClose,
  history,
  onSelectCommand,
  onDeleteCommand,
  onClearHistory,
}: CommandHistoryDrawerProps) {
  const colors = useThemeColors();
  const drawerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Track touch state for drag gesture
  const touchStartY = useRef<number>(0);
  const touchStartTime = useRef<number>(0);
  const isDragging = useRef<boolean>(false);
  const [dragOffset, setDragOffset] = useState(0);
  const [longPressId, setLongPressId] = useState<string | null>(null);

  // Long press timer ref
  const longPressTimer = useRef<NodeJS.Timeout | null>(null);

  // Calculate max drawer height based on viewport
  const [maxDrawerHeight, setMaxDrawerHeight] = useState(
    typeof window !== 'undefined'
      ? window.innerHeight * MAX_DRAWER_HEIGHT_PERCENT
      : 400
  );

  // Update max height on resize
  useEffect(() => {
    const handleResize = () => {
      setMaxDrawerHeight(window.innerHeight * MAX_DRAWER_HEIGHT_PERCENT);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Reset drag offset when drawer opens/closes
  useEffect(() => {
    setDragOffset(0);
  }, [isOpen]);

  /**
   * Handle touch start on drawer handle
   */
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    touchStartY.current = touch.clientY;
    touchStartTime.current = Date.now();
    isDragging.current = true;
  }, []);

  /**
   * Handle touch move for drag gesture
   */
  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!isDragging.current) return;

      const touch = e.touches[0];
      const deltaY = touch.clientY - touchStartY.current;

      // Only allow dragging down to close
      if (isOpen && deltaY > 0) {
        setDragOffset(deltaY);
        e.preventDefault();
      }
    },
    [isOpen]
  );

  /**
   * Handle touch end - determine if should snap open or closed
   */
  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (!isDragging.current) return;
      isDragging.current = false;

      const touchEndTime = Date.now();
      const duration = touchEndTime - touchStartTime.current;
      const velocity = dragOffset / duration;

      // Check for flick gesture
      if (velocity > FLICK_VELOCITY_THRESHOLD) {
        // Fast flick down - close
        onClose();
        triggerHaptic(HAPTIC_PATTERNS.tap);
      } else if (dragOffset > maxDrawerHeight * SNAP_THRESHOLD) {
        // Dragged past threshold - close
        onClose();
        triggerHaptic(HAPTIC_PATTERNS.tap);
      }

      // Reset drag offset with animation
      setDragOffset(0);
    },
    [dragOffset, maxDrawerHeight, onClose]
  );

  /**
   * Handle command item tap
   */
  const handleCommandTap = useCallback(
    (command: string) => {
      triggerHaptic(HAPTIC_PATTERNS.tap);
      onSelectCommand(command);
      onClose();
    },
    [onSelectCommand, onClose]
  );

  /**
   * Handle long press start on command item
   */
  const handleLongPressStart = useCallback(
    (id: string) => {
      longPressTimer.current = setTimeout(() => {
        triggerHaptic(HAPTIC_PATTERNS.success);
        setLongPressId(id);
      }, GESTURE_THRESHOLDS.longPress);
    },
    []
  );

  /**
   * Handle long press end
   */
  const handleLongPressEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  /**
   * Handle delete command
   */
  const handleDelete = useCallback(
    (id: string) => {
      triggerHaptic(HAPTIC_PATTERNS.tap);
      onDeleteCommand?.(id);
      setLongPressId(null);
    },
    [onDeleteCommand]
  );

  /**
   * Handle clear all history
   */
  const handleClearAll = useCallback(() => {
    triggerHaptic(HAPTIC_PATTERNS.interrupt);
    onClearHistory?.();
    onClose();
  }, [onClearHistory, onClose]);

  /**
   * Handle backdrop tap to close
   */
  const handleBackdropTap = useCallback(() => {
    onClose();
    setLongPressId(null);
  }, [onClose]);

  // Calculate current drawer height
  const currentHeight = isOpen
    ? Math.max(MIN_DRAWER_HEIGHT, maxDrawerHeight - dragOffset)
    : MIN_DRAWER_HEIGHT;

  // Don't render if closed and no transition needed
  if (!isOpen && dragOffset === 0) {
    return null;
  }

  return (
    <>
      {/* Backdrop overlay */}
      <div
        onClick={handleBackdropTap}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          opacity: isOpen ? 1 - dragOffset / maxDrawerHeight : 0,
          transition: isDragging.current ? 'none' : 'opacity 0.3s ease',
          zIndex: 199,
          pointerEvents: isOpen ? 'auto' : 'none',
        }}
      />

      {/* Drawer container */}
      <div
        ref={drawerRef}
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          height: currentHeight,
          backgroundColor: colors.bgSidebar,
          borderTopLeftRadius: '16px',
          borderTopRightRadius: '16px',
          boxShadow: '0 -4px 20px rgba(0, 0, 0, 0.15)',
          zIndex: 200,
          display: 'flex',
          flexDirection: 'column',
          transform: isOpen ? 'translateY(0)' : 'translateY(100%)',
          transition: isDragging.current ? 'none' : 'transform 0.3s ease, height 0.3s ease',
          // Safe area padding
          paddingBottom: 'max(12px, env(safe-area-inset-bottom))',
          paddingLeft: 'env(safe-area-inset-left)',
          paddingRight: 'env(safe-area-inset-right)',
        }}
      >
        {/* Drawer handle */}
        <div
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: `${HANDLE_HEIGHT}px`,
            cursor: 'grab',
            touchAction: 'none',
            flexShrink: 0,
          }}
        >
          {/* Visual handle indicator */}
          <div
            style={{
              width: '40px',
              height: '4px',
              backgroundColor: colors.border,
              borderRadius: '2px',
            }}
          />
        </div>

        {/* Header with title and clear button */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 16px 12px',
            borderBottom: `1px solid ${colors.border}`,
            flexShrink: 0,
          }}
        >
          <h3
            style={{
              margin: 0,
              fontSize: '16px',
              fontWeight: 600,
              color: colors.textMain,
            }}
          >
            Command History
          </h3>
          {history.length > 0 && onClearHistory && (
            <button
              onClick={handleClearAll}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                backgroundColor: 'transparent',
                border: `1px solid ${colors.border}`,
                color: colors.textDim,
                fontSize: '12px',
                fontWeight: 500,
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              Clear All
            </button>
          )}
        </div>

        {/* Scrollable content area */}
        <div
          ref={contentRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            overflowX: 'hidden',
            WebkitOverflowScrolling: 'touch',
          }}
        >
          {history.length === 0 ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                padding: '32px 16px',
                textAlign: 'center',
              }}
            >
              <svg
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                stroke={colors.textDim}
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ opacity: 0.5 }}
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <p
                style={{
                  marginTop: '12px',
                  color: colors.textDim,
                  fontSize: '14px',
                }}
              >
                No command history yet
              </p>
              <p
                style={{
                  marginTop: '4px',
                  color: colors.textDim,
                  fontSize: '12px',
                  opacity: 0.7,
                }}
              >
                Commands you send will appear here
              </p>
            </div>
          ) : (
            <div style={{ padding: '8px 0' }}>
              {/* Swipe hint for first-time users */}
              {history.length > 0 && onDeleteCommand && (
                <p
                  style={{
                    fontSize: '11px',
                    color: colors.textDim,
                    textAlign: 'center',
                    margin: '0 16px 8px',
                    opacity: 0.7,
                  }}
                >
                  Swipe left on an item to delete
                </p>
              )}
              {history.map((entry) => (
                <SwipeableHistoryItem
                  key={entry.id}
                  entry={entry}
                  onSelect={handleCommandTap}
                  onDelete={onDeleteCommand ? handleDelete : undefined}
                  isLongPressed={longPressId === entry.id}
                  onLongPressStart={handleLongPressStart}
                  onLongPressEnd={handleLongPressEnd}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export default CommandHistoryDrawer;
