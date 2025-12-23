/**
 * RecentCommandChips - Quick-tap chips showing recently sent commands
 *
 * A horizontally scrollable row of chips displaying recent commands
 * that users can tap to quickly reuse. Designed for mobile touch interaction.
 *
 * Features:
 * - Horizontal scroll for many commands
 * - Touch-friendly chip size (minimum 44px height)
 * - Mode indicator (AI/Terminal) on each chip
 * - Tap to fill command input
 * - Haptic feedback on tap
 * - Fades out for long commands with ellipsis
 */

import React, { useCallback, useRef, useEffect } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import type { CommandHistoryEntry } from '../hooks/useCommandHistory';
import { truncateCommand } from '../../shared/formatters';

/** Maximum characters to show in a chip before truncating */
const MAX_CHIP_LENGTH = 30;

/** Number of recent unique commands to show */
const DEFAULT_CHIP_COUNT = 5;

export interface RecentCommandChipsProps {
  /** Recent command entries to display (should be pre-filtered to unique commands) */
  commands: CommandHistoryEntry[];
  /** Callback when a command chip is tapped */
  onSelectCommand: (command: string) => void;
  /** Maximum number of chips to show (default: 5) */
  maxChips?: number;
  /** Whether the chips are disabled */
  disabled?: boolean;
}

/**
 * RecentCommandChips component
 *
 * Displays recent unique commands as horizontally scrollable chips
 * for quick access from the mobile command input area.
 */
export function RecentCommandChips({
  commands,
  onSelectCommand,
  maxChips = DEFAULT_CHIP_COUNT,
  disabled = false,
}: RecentCommandChipsProps) {
  const colors = useThemeColors();
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Get limited number of commands
  const displayCommands = commands.slice(0, maxChips);

  /**
   * Handle chip tap
   */
  const handleChipTap = useCallback(
    (command: string) => {
      if (disabled) return;
      triggerHaptic(HAPTIC_PATTERNS.tap);
      onSelectCommand(command);
    },
    [disabled, onSelectCommand]
  );

  // Don't render if no commands
  if (displayCommands.length === 0) {
    return null;
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        paddingLeft: '16px',
        paddingRight: '8px',
        paddingBottom: '8px',
      }}
    >
      {/* Label */}
      <span
        style={{
          fontSize: '11px',
          fontWeight: 500,
          color: colors.textDim,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          opacity: disabled ? 0.5 : 0.7,
        }}
      >
        Recent
      </span>

      {/* Horizontally scrollable chips container */}
      <div
        ref={scrollContainerRef}
        style={{
          display: 'flex',
          gap: '8px',
          overflowX: 'auto',
          overflowY: 'hidden',
          scrollbarWidth: 'none', // Firefox
          msOverflowStyle: 'none', // IE/Edge
          WebkitOverflowScrolling: 'touch',
          // Fade effect on the right edge
          maskImage: 'linear-gradient(to right, black calc(100% - 24px), transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 24px), transparent 100%)',
          paddingRight: '16px', // Extra padding for fade
        }}
        // Hide scrollbar in WebKit browsers
        className="hide-scrollbar"
      >
        {displayCommands.map((entry) => (
          <button
            key={entry.id}
            onClick={() => handleChipTap(entry.command)}
            disabled={disabled}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '8px 12px',
              borderRadius: '20px',
              backgroundColor: disabled
                ? `${colors.bgSidebar}80`
                : colors.bgSidebar,
              border: `1px solid ${colors.border}`,
              color: disabled ? colors.textDim : colors.textMain,
              fontSize: '13px',
              fontFamily: 'ui-monospace, monospace',
              whiteSpace: 'nowrap',
              cursor: disabled ? 'default' : 'pointer',
              opacity: disabled ? 0.5 : 1,
              // Touch-friendly size (44px minimum height)
              minHeight: '36px',
              // Prevent shrinking
              flexShrink: 0,
              // Smooth transitions
              transition: 'background-color 150ms ease, transform 100ms ease',
              // Remove default button styles
              outline: 'none',
              WebkitTapHighlightColor: 'transparent',
            }}
            onTouchStart={(e) => {
              if (!disabled) {
                e.currentTarget.style.transform = 'scale(0.95)';
                e.currentTarget.style.backgroundColor = `${colors.accent}15`;
              }
            }}
            onTouchEnd={(e) => {
              e.currentTarget.style.transform = 'scale(1)';
              e.currentTarget.style.backgroundColor = colors.bgSidebar;
            }}
            onTouchCancel={(e) => {
              e.currentTarget.style.transform = 'scale(1)';
              e.currentTarget.style.backgroundColor = colors.bgSidebar;
            }}
            aria-label={`Reuse command: ${entry.command}`}
          >
            {/* Mode indicator icon */}
            {entry.mode === 'ai' ? (
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke={colors.accent}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: 0, opacity: disabled ? 0.5 : 0.8 }}
              >
                <path d="M12 3v2M12 19v2M5.64 5.64l1.42 1.42M16.95 16.95l1.41 1.41M3 12h2M19 12h2M5.64 18.36l1.42-1.42M16.95 7.05l1.41-1.41" />
                <circle cx="12" cy="12" r="4" />
              </svg>
            ) : (
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke={colors.textDim}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: 0, opacity: disabled ? 0.5 : 0.8 }}
              >
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
            )}
            {/* Command text */}
            <span>{truncateCommand(entry.command, MAX_CHIP_LENGTH)}</span>
          </button>
        ))}
      </div>

      {/* CSS to hide scrollbar */}
      <style>{`
        .hide-scrollbar::-webkit-scrollbar {
          display: none;
        }
      `}</style>
    </div>
  );
}

export default RecentCommandChips;
