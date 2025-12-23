/**
 * CommandInputButtons - Extracted button components for CommandInputBar
 *
 * These button components are specialized for the mobile input bar with:
 * - Large touch targets (48px minimum per Apple HIG)
 * - Touch feedback with scale animations
 * - Haptic feedback via Vibration API
 * - Theme-aware styling
 *
 * Components:
 * - InputModeToggleButton: Switches between AI and Terminal modes
 * - VoiceInputButton: Microphone button for speech-to-text
 * - SlashCommandButton: Opens slash command autocomplete
 * - SendInterruptButton: Send message or cancel running AI query
 */

import React from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import type { InputMode } from './CommandInputBar';
import { triggerHaptic, MIN_TOUCH_TARGET } from './constants';

/** Default minimum height for the buttons */
const MIN_INPUT_HEIGHT = 48;

/**
 * Common base styles for all input bar buttons
 */
const buttonBaseStyles: React.CSSProperties = {
  padding: '10px',
  borderRadius: '12px',
  cursor: 'pointer',
  width: `${MIN_TOUCH_TARGET + 4}px`,
  height: `${MIN_INPUT_HEIGHT}px`,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'all 150ms ease',
  flexShrink: 0,
  WebkitTapHighlightColor: 'transparent',
  border: 'none',
};

// ============================================================================
// InputModeToggleButton
// ============================================================================

export interface InputModeToggleButtonProps {
  /** Current input mode (AI or terminal) */
  inputMode: InputMode;
  /** Callback when mode is toggled */
  onModeToggle: () => void;
  /** Whether the button is disabled */
  disabled: boolean;
}

/**
 * InputModeToggleButton - Switches between AI and Terminal modes
 *
 * Displays an AI sparkle icon in AI mode, or a terminal prompt icon in terminal mode.
 * Shows mode label below the icon.
 */
export function InputModeToggleButton({
  inputMode,
  onModeToggle,
  disabled,
}: InputModeToggleButtonProps) {
  const colors = useThemeColors();
  const isAiMode = inputMode === 'ai';

  const handleClick = () => {
    triggerHaptic(10);
    onModeToggle();
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      style={{
        ...buttonBaseStyles,
        backgroundColor: isAiMode ? `${colors.accent}20` : `${colors.textDim}20`,
        border: `2px solid ${isAiMode ? colors.accent : colors.textDim}`,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        flexDirection: 'column',
        gap: '2px',
      }}
      onTouchStart={(e) => {
        if (!disabled) {
          e.currentTarget.style.transform = 'scale(0.95)';
        }
      }}
      onTouchEnd={(e) => {
        e.currentTarget.style.transform = 'scale(1)';
      }}
      aria-label={`Switch to ${isAiMode ? 'terminal' : 'AI'} mode. Currently in ${isAiMode ? 'AI' : 'terminal'} mode.`}
      aria-pressed={isAiMode}
    >
      {/* Mode icon - AI sparkle or Terminal prompt */}
      {isAiMode ? (
        <svg
          width="18"
          height="18"
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
          width="18"
          height="18"
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
      {/* Mode label */}
      <span
        style={{
          fontSize: '9px',
          fontWeight: 600,
          color: isAiMode ? colors.accent : colors.textDim,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
        }}
      >
        {isAiMode ? 'AI' : 'CLI'}
      </span>
    </button>
  );
}

// ============================================================================
// VoiceInputButton
// ============================================================================

export interface VoiceInputButtonProps {
  /** Whether currently listening for voice input */
  isListening: boolean;
  /** Callback to toggle voice input */
  onToggle: () => void;
  /** Whether the button is disabled */
  disabled: boolean;
}

/**
 * VoiceInputButton - Microphone button for speech-to-text
 *
 * Shows a microphone icon that pulses red when actively listening.
 * Uses the Web Speech API for transcription.
 */
export function VoiceInputButton({
  isListening,
  onToggle,
  disabled,
}: VoiceInputButtonProps) {
  const colors = useThemeColors();

  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      style={{
        ...buttonBaseStyles,
        backgroundColor: isListening ? '#ef444420' : `${colors.textDim}15`,
        border: `2px solid ${isListening ? '#ef4444' : colors.border}`,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        animation: isListening ? 'pulse 1.5s ease-in-out infinite' : 'none',
      }}
      onTouchStart={(e) => {
        if (!disabled) {
          e.currentTarget.style.transform = 'scale(0.95)';
        }
      }}
      onTouchEnd={(e) => {
        e.currentTarget.style.transform = 'scale(1)';
      }}
      aria-label={isListening ? 'Stop voice input' : 'Start voice input'}
      aria-pressed={isListening}
    >
      {/* Microphone icon */}
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill={isListening ? '#ef4444' : 'none'}
        stroke={isListening ? '#ef4444' : colors.textDim}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" x2="12" y1="19" y2="22" />
      </svg>
    </button>
  );
}

// ============================================================================
// SlashCommandButton
// ============================================================================

export interface SlashCommandButtonProps {
  /** Whether the slash command autocomplete is open */
  isOpen: boolean;
  /** Callback to open the autocomplete */
  onOpen: () => void;
  /** Whether the button is disabled */
  disabled: boolean;
}

/**
 * SlashCommandButton - Opens slash command autocomplete
 *
 * Shows a "/" character that becomes accented when the autocomplete is open.
 * Only visible in AI mode.
 */
export function SlashCommandButton({
  isOpen,
  onOpen,
  disabled,
}: SlashCommandButtonProps) {
  const colors = useThemeColors();

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      style={{
        ...buttonBaseStyles,
        backgroundColor: isOpen ? `${colors.accent}20` : `${colors.textDim}15`,
        border: `2px solid ${isOpen ? colors.accent : colors.border}`,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
      onTouchStart={(e) => {
        if (!disabled) {
          e.currentTarget.style.transform = 'scale(0.95)';
        }
      }}
      onTouchEnd={(e) => {
        e.currentTarget.style.transform = 'scale(1)';
      }}
      aria-label="Open slash commands"
    >
      {/* Slash icon */}
      <span
        style={{
          fontSize: '20px',
          fontWeight: 600,
          color: isOpen ? colors.accent : colors.textDim,
          fontFamily: 'ui-monospace, monospace',
        }}
      >
        /
      </span>
    </button>
  );
}

// ============================================================================
// SendInterruptButton
// ============================================================================

export interface SendInterruptButtonProps {
  /** Whether to show the interrupt (cancel) button instead of send */
  isInterruptMode: boolean;
  /** Whether the send button is disabled */
  isSendDisabled: boolean;
  /** Callback when interrupt button is clicked */
  onInterrupt: () => void;
  /** Ref for the send button (used by long-press menu) */
  sendButtonRef?: React.RefObject<HTMLButtonElement>;
  /** Touch start handler for long-press detection */
  onTouchStart?: React.TouchEventHandler<HTMLButtonElement>;
  /** Touch end handler for long-press detection */
  onTouchEnd?: React.TouchEventHandler<HTMLButtonElement>;
  /** Touch move handler for long-press cancellation */
  onTouchMove?: React.TouchEventHandler<HTMLButtonElement>;
}

/**
 * SendInterruptButton - Send message or cancel running AI query
 *
 * Shows an up-arrow send button normally, or a red X when AI is busy.
 * The send button supports long-press for quick actions menu.
 */
export function SendInterruptButton({
  isInterruptMode,
  isSendDisabled,
  onInterrupt,
  sendButtonRef,
  onTouchStart,
  onTouchEnd,
  onTouchMove,
}: SendInterruptButtonProps) {
  const colors = useThemeColors();

  const handleInterrupt = () => {
    triggerHaptic(50);
    onInterrupt();
  };

  if (isInterruptMode) {
    return (
      <button
        type="button"
        onClick={handleInterrupt}
        style={{
          ...buttonBaseStyles,
          padding: '14px',
          backgroundColor: '#ef4444',
          color: '#ffffff',
          fontSize: '14px',
          fontWeight: 500,
        }}
        onTouchStart={(e) => {
          e.currentTarget.style.transform = 'scale(0.95)';
          e.currentTarget.style.backgroundColor = '#dc2626';
        }}
        onTouchEnd={(e) => {
          e.currentTarget.style.transform = 'scale(1)';
          e.currentTarget.style.backgroundColor = '#ef4444';
        }}
        aria-label="Cancel running command or AI query"
      >
        {/* X icon for interrupt */}
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    );
  }

  return (
    <button
      ref={sendButtonRef}
      type="submit"
      disabled={isSendDisabled}
      style={{
        ...buttonBaseStyles,
        padding: '14px',
        backgroundColor: colors.accent,
        color: '#ffffff',
        fontSize: '14px',
        fontWeight: 500,
        cursor: isSendDisabled ? 'default' : 'pointer',
        opacity: isSendDisabled ? 0.5 : 1,
      }}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchMove={onTouchMove}
      aria-label="Send command (long press for quick actions)"
    >
      {/* Arrow up icon for send */}
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="12" y1="19" x2="12" y2="5" />
        <polyline points="5 12 12 5 19 12" />
      </svg>
    </button>
  );
}

// ============================================================================
// ExpandedModeSendInterruptButton (for mobile expanded AI mode)
// ============================================================================

export interface ExpandedModeSendInterruptButtonProps {
  /** Whether to show the interrupt (cancel) button instead of send */
  isInterruptMode: boolean;
  /** Whether the send button is disabled */
  isSendDisabled: boolean;
  /** Callback when interrupt button is clicked */
  onInterrupt: () => void;
}

/**
 * ExpandedModeSendInterruptButton - Full-width button for mobile expanded mode
 *
 * Similar to SendInterruptButton but renders as a full-width button with text
 * labels ("Stop" or "Send") for the expanded mobile input mode.
 */
export function ExpandedModeSendInterruptButton({
  isInterruptMode,
  isSendDisabled,
  onInterrupt,
}: ExpandedModeSendInterruptButtonProps) {
  const colors = useThemeColors();

  const handleInterrupt = () => {
    triggerHaptic(50);
    onInterrupt();
  };

  const baseExpandedStyles: React.CSSProperties = {
    width: '100%',
    padding: '12px',
    borderRadius: '12px',
    fontSize: '15px',
    fontWeight: 600,
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    transition: 'opacity 150ms ease, background-color 150ms ease',
    WebkitTapHighlightColor: 'transparent',
  };

  if (isInterruptMode) {
    return (
      <button
        type="button"
        onClick={handleInterrupt}
        style={{
          ...baseExpandedStyles,
          backgroundColor: '#ef4444',
          color: '#ffffff',
        }}
        onTouchStart={(e) => {
          e.currentTarget.style.backgroundColor = '#dc2626';
        }}
        onTouchEnd={(e) => {
          e.currentTarget.style.backgroundColor = '#ef4444';
        }}
        aria-label="Cancel running AI query"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
        <span>Stop</span>
      </button>
    );
  }

  return (
    <button
      type="submit"
      disabled={isSendDisabled}
      style={{
        ...baseExpandedStyles,
        backgroundColor: colors.accent,
        color: '#ffffff',
        cursor: isSendDisabled ? 'default' : 'pointer',
        opacity: isSendDisabled ? 0.5 : 1,
      }}
      aria-label="Send message"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="12" y1="19" x2="12" y2="5" />
        <polyline points="5 12 12 5 19 12" />
      </svg>
      <span>Send</span>
    </button>
  );
}
