/**
 * CommandInputBar - Sticky bottom input bar for mobile web interface
 *
 * A touch-friendly command input component that stays fixed at the bottom
 * of the viewport and properly handles mobile keyboard appearance.
 *
 * Features:
 * - Always visible at bottom of screen
 * - Adjusts position when mobile keyboard appears (using visualViewport API)
 * - Supports safe area insets for notched devices
 * - Disabled state when disconnected or offline
 * - Large touch-friendly textarea for easy mobile input
 * - Auto-expanding textarea for multi-line commands (up to 4 lines)
 * - Minimum 44px touch targets per Apple HIG guidelines
 * - Mode toggle button (AI / Terminal) with visual indicator
 * - Voice input button for speech-to-text (uses Web Speech API)
 * - Interrupt button (red X) visible when session is busy
 * - Recent command chips for quick access to recently sent commands
 * - Slash command autocomplete popup when typing `/`
 * - Haptic feedback on send (if device supports vibration)
 * - Quick actions menu on long-press of send button
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { useSwipeUp } from '../hooks/useSwipeUp';
import { RecentCommandChips } from './RecentCommandChips';
import { SlashCommandAutocomplete, type SlashCommand, DEFAULT_SLASH_COMMANDS } from './SlashCommandAutocomplete';
import { QuickActionsMenu, type QuickAction } from './QuickActionsMenu';
import type { CommandHistoryEntry } from '../hooks/useCommandHistory';
import { webLogger } from '../utils/logger';

/**
 * Web Speech API type declarations
 * These are needed because TypeScript doesn't include these by default
 */
interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onaudioend: ((this: SpeechRecognition, ev: Event) => void) | null;
  onaudiostart: ((this: SpeechRecognition, ev: Event) => void) | null;
  onend: ((this: SpeechRecognition, ev: Event) => void) | null;
  onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null;
  onnomatch: ((this: SpeechRecognition, ev: Event) => void) | null;
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null;
  onsoundend: ((this: SpeechRecognition, ev: Event) => void) | null;
  onsoundstart: ((this: SpeechRecognition, ev: Event) => void) | null;
  onspeechend: ((this: SpeechRecognition, ev: Event) => void) | null;
  onspeechstart: ((this: SpeechRecognition, ev: Event) => void) | null;
  onstart: ((this: SpeechRecognition, ev: Event) => void) | null;
  abort(): void;
  start(): void;
  stop(): void;
}

interface SpeechRecognitionConstructor {
  new(): SpeechRecognition;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

/**
 * Check if speech recognition is supported in the current browser
 */
function isSpeechRecognitionSupported(): boolean {
  return typeof window !== 'undefined' &&
    (!!window.SpeechRecognition || !!window.webkitSpeechRecognition);
}

/**
 * Get the SpeechRecognition constructor (with vendor prefix fallback)
 */
function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

/** Minimum touch target size per Apple HIG guidelines (44pt) */
const MIN_TOUCH_TARGET = 44;

/** Duration in ms to trigger long-press for quick actions menu */
const LONG_PRESS_DURATION = 500;

/** Default minimum height for the text input area */
const MIN_INPUT_HEIGHT = 48;

/** Line height for text calculations */
const LINE_HEIGHT = 22;

/** Maximum number of lines before scrolling */
const MAX_LINES = 4;

/** Vertical padding inside textarea (top + bottom) */
const TEXTAREA_VERTICAL_PADDING = 28; // 14px top + 14px bottom

/** Maximum height for textarea based on max lines */
const MAX_TEXTAREA_HEIGHT = LINE_HEIGHT * MAX_LINES + TEXTAREA_VERTICAL_PADDING;

/**
 * Trigger haptic feedback using the Vibration API
 * Uses short vibrations for tactile confirmation on mobile devices
 *
 * @param pattern - Vibration pattern in milliseconds or single duration
 *   - 'light' (10ms) - subtle tap for button presses
 *   - 'medium' (25ms) - standard confirmation feedback
 *   - 'strong' (50ms) - important action confirmation
 *   - number - custom duration in milliseconds
 */
function triggerHapticFeedback(pattern: 'light' | 'medium' | 'strong' | number = 'medium'): void {
  // Check if the Vibration API is supported
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    const duration =
      pattern === 'light' ? 10 :
      pattern === 'medium' ? 25 :
      pattern === 'strong' ? 50 :
      pattern;

    try {
      navigator.vibrate(duration);
    } catch {
      // Silently fail if vibration is not allowed (e.g., permissions, battery saver)
    }
  }
}

/** Input mode type - AI assistant or terminal */
export type InputMode = 'ai' | 'terminal';

export interface CommandInputBarProps {
  /** Whether the device is offline */
  isOffline: boolean;
  /** Whether connected to the server */
  isConnected: boolean;
  /** Placeholder text for the input */
  placeholder?: string;
  /** Callback when command is submitted */
  onSubmit?: (command: string) => void;
  /** Callback when input value changes */
  onChange?: (value: string) => void;
  /** Current input value (controlled) */
  value?: string;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Current input mode (AI or terminal) */
  inputMode?: InputMode;
  /** Callback when input mode is toggled */
  onModeToggle?: (mode: InputMode) => void;
  /** Whether the active session is busy (AI thinking) */
  isSessionBusy?: boolean;
  /** Callback when interrupt button is pressed */
  onInterrupt?: () => void;
  /** Callback when history drawer should open (swipe up) */
  onHistoryOpen?: () => void;
  /** Recent unique commands for quick-tap chips */
  recentCommands?: CommandHistoryEntry[];
  /** Callback when a recent command chip is tapped */
  onSelectRecentCommand?: (command: string) => void;
  /** Available slash commands (uses defaults if not provided) */
  slashCommands?: SlashCommand[];
  /** Whether a session is currently active (for quick actions menu) */
  hasActiveSession?: boolean;
  /** Current working directory (shown in terminal mode) */
  cwd?: string;
  /** Callback when slash command button is pressed (to open/close autocomplete) */
  onSlashCommandToggle?: () => void;
  /** Whether slash command autocomplete is currently open */
  isSlashCommandOpen?: boolean;
  /** Callback when input receives focus */
  onInputFocus?: () => void;
  /** Callback when input loses focus */
  onInputBlur?: () => void;
  /** Whether to show recent command chips (defaults to true) */
  showRecentCommands?: boolean;
}

/**
 * CommandInputBar component
 *
 * Provides a sticky bottom input bar optimized for mobile devices.
 * Uses the Visual Viewport API to stay above the keyboard.
 */
export function CommandInputBar({
  isOffline,
  isConnected,
  placeholder,
  onSubmit,
  onChange,
  value: controlledValue,
  disabled: externalDisabled,
  inputMode = 'ai',
  onModeToggle,
  isSessionBusy = false,
  onInterrupt,
  onHistoryOpen,
  recentCommands,
  onSelectRecentCommand,
  slashCommands = DEFAULT_SLASH_COMMANDS,
  hasActiveSession = false,
  cwd,
  onSlashCommandToggle,
  isSlashCommandOpen = false,
  onInputFocus,
  onInputBlur,
  showRecentCommands = true,
}: CommandInputBarProps) {
  const colors = useThemeColors();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Swipe up gesture detection for opening history drawer
  const { handlers: swipeUpHandlers } = useSwipeUp({
    onSwipeUp: () => onHistoryOpen?.(),
    enabled: !!onHistoryOpen,
  });

  // Track keyboard visibility for positioning
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);

  // Track textarea height for auto-expansion
  const [textareaHeight, setTextareaHeight] = useState(MIN_INPUT_HEIGHT);

  // Internal state for uncontrolled mode
  const [internalValue, setInternalValue] = useState('');
  const value = controlledValue !== undefined ? controlledValue : internalValue;

  // Slash command autocomplete state
  const [slashCommandOpen, setSlashCommandOpen] = useState(false);
  const [selectedSlashCommandIndex, setSelectedSlashCommandIndex] = useState(0);

  // Voice input state
  const [isListening, setIsListening] = useState(false);
  const [voiceSupported] = useState(() => isSpeechRecognitionSupported());
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  // Quick actions menu state
  const [quickActionsOpen, setQuickActionsOpen] = useState(false);
  const [quickActionsAnchor, setQuickActionsAnchor] = useState<{ x: number; y: number } | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendButtonRef = useRef<HTMLButtonElement>(null);

  // Determine if input should be disabled
  // Disable when: externally disabled, offline, not connected, OR session is busy (no queuing on mobile)
  const isDisabled = externalDisabled || isOffline || !isConnected || isSessionBusy;

  // Get placeholder text based on state
  const getPlaceholder = () => {
    if (isOffline) return 'Offline...';
    if (!isConnected) return 'Connecting...';
    if (isSessionBusy) return 'Waiting for response...';
    return placeholder || 'Enter command...';
  };

  /**
   * Auto-resize textarea based on content
   * Expands up to MAX_LINES (4 lines) then enables scrolling
   */
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to minimum to get accurate scrollHeight measurement
    textarea.style.height = `${MIN_INPUT_HEIGHT}px`;

    // Calculate the new height based on content
    const scrollHeight = textarea.scrollHeight;

    // Clamp height between minimum and maximum
    const newHeight = Math.min(Math.max(scrollHeight, MIN_INPUT_HEIGHT), MAX_TEXTAREA_HEIGHT);

    setTextareaHeight(newHeight);
    textarea.style.height = `${newHeight}px`;
  }, [value]);

  /**
   * Handle Visual Viewport resize for keyboard detection
   * This is the modern way to handle mobile keyboard appearance
   */
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const handleResize = () => {
      // Calculate the offset caused by keyboard
      const windowHeight = window.innerHeight;
      const viewportHeight = viewport.height;
      const offset = windowHeight - viewportHeight - viewport.offsetTop;

      // Only update if there's a significant change (keyboard appearing/disappearing)
      if (offset > 50) {
        setKeyboardOffset(offset);
        setIsKeyboardVisible(true);
      } else {
        setKeyboardOffset(0);
        setIsKeyboardVisible(false);
      }
    };

    const handleScroll = () => {
      // Re-adjust on scroll to keep the bar in view
      if (containerRef.current && isKeyboardVisible) {
        // Force the container to stay at the bottom of the visible area
        handleResize();
      }
    };

    viewport.addEventListener('resize', handleResize);
    viewport.addEventListener('scroll', handleScroll);

    // Initial check
    handleResize();

    return () => {
      viewport.removeEventListener('resize', handleResize);
      viewport.removeEventListener('scroll', handleScroll);
    };
  }, [isKeyboardVisible]);

  /**
   * Handle textarea change
   * Also detects slash commands and shows autocomplete
   */
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      if (controlledValue === undefined) {
        setInternalValue(newValue);
      }
      onChange?.(newValue);

      // Show slash command autocomplete when typing / at the start
      // Only show if input starts with / and doesn't contain spaces (still typing command)
      if (newValue.startsWith('/') && !newValue.includes(' ')) {
        setSlashCommandOpen(true);
        setSelectedSlashCommandIndex(0);
      } else {
        setSlashCommandOpen(false);
      }
    },
    [controlledValue, onChange]
  );

  /**
   * Handle slash command selection from autocomplete
   */
  const handleSelectSlashCommand = useCallback(
    (command: string) => {
      if (controlledValue === undefined) {
        setInternalValue(command);
      }
      onChange?.(command);
      setSlashCommandOpen(false);

      // Focus back on textarea
      textareaRef.current?.focus();

      // Auto-submit the slash command after a brief delay
      setTimeout(() => {
        onSubmit?.(command);
        // Clear input after submit (for uncontrolled mode)
        if (controlledValue === undefined) {
          setInternalValue('');
        }
        onChange?.('');
      }, 50);
    },
    [controlledValue, onChange, onSubmit]
  );

  /**
   * Close slash command autocomplete
   */
  const handleCloseSlashCommand = useCallback(() => {
    setSlashCommandOpen(false);
  }, []);

  /**
   * Handle form submission
   */
  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!value.trim() || isDisabled) return;

      // Trigger haptic feedback on successful send
      triggerHapticFeedback('medium');

      onSubmit?.(value.trim());

      // Clear input after submit (for uncontrolled mode)
      if (controlledValue === undefined) {
        setInternalValue('');
      }

      // Keep focus on textarea after submit
      textareaRef.current?.focus();
    },
    [value, isDisabled, onSubmit, controlledValue]
  );

  /**
   * Handle key press events
   * Enter submits, Shift+Enter adds a newline
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Submit on Enter (Shift+Enter adds newline for multi-line input)
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit(e);
      }
    },
    [handleSubmit]
  );

  /**
   * Handle mode toggle between AI and Terminal
   */
  const handleModeToggle = useCallback(() => {
    // Light haptic feedback for mode switch
    triggerHapticFeedback('light');
    const newMode = inputMode === 'ai' ? 'terminal' : 'ai';
    onModeToggle?.(newMode);
  }, [inputMode, onModeToggle]);

  /**
   * Handle interrupt button press
   */
  const handleInterrupt = useCallback(() => {
    // Strong haptic feedback for interrupt action (important action)
    triggerHapticFeedback('strong');
    onInterrupt?.();
  }, [onInterrupt]);

  /**
   * Initialize speech recognition when voice input starts
   */
  const startVoiceInput = useCallback(() => {
    if (!voiceSupported || isDisabled) return;

    const SpeechRecognitionClass = getSpeechRecognition();
    if (!SpeechRecognitionClass) return;

    // Create new recognition instance
    const recognition = new SpeechRecognitionClass();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';
    recognition.maxAlternatives = 1;

    // Store reference for cleanup
    recognitionRef.current = recognition;

    // Track interim results to update input in real-time
    let finalTranscript = '';

    recognition.onstart = () => {
      setIsListening(true);
      triggerHapticFeedback('medium');
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interimTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        } else {
          interimTranscript += result[0].transcript;
        }
      }

      // Update input with current transcription (append to existing value)
      const currentText = value.trim();
      const separator = currentText ? ' ' : '';
      const newText = currentText + separator + (finalTranscript || interimTranscript);

      if (controlledValue === undefined) {
        setInternalValue(newText);
      }
      onChange?.(newText);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      webLogger.warn('Speech recognition error', 'VoiceInput', event.error);
      setIsListening(false);
      recognitionRef.current = null;

      // Haptic feedback on error
      if (event.error !== 'aborted' && event.error !== 'no-speech') {
        triggerHapticFeedback('strong');
      }
    };

    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
      triggerHapticFeedback('light');

      // Focus textarea after voice input ends
      textareaRef.current?.focus();
    };

    try {
      recognition.start();
    } catch (err) {
      webLogger.warn('Failed to start speech recognition', 'VoiceInput', err);
      setIsListening(false);
      recognitionRef.current = null;
    }
  }, [voiceSupported, isDisabled, value, controlledValue, onChange]);

  /**
   * Stop voice input
   */
  const stopVoiceInput = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Ignore errors when stopping
      }
      recognitionRef.current = null;
    }
    setIsListening(false);
  }, []);

  /**
   * Toggle voice input on/off
   */
  const handleVoiceToggle = useCallback(() => {
    if (isListening) {
      stopVoiceInput();
    } else {
      startVoiceInput();
    }
  }, [isListening, startVoiceInput, stopVoiceInput]);

  /**
   * Clear long-press timer (used when touch ends or moves)
   */
  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  /**
   * Handle long-press start on send button
   * Starts a timer that will show the quick actions menu
   */
  const handleSendButtonTouchStart = useCallback((e: React.TouchEvent<HTMLButtonElement>) => {
    // Clear any existing timer
    clearLongPressTimer();

    // Get the button position for menu anchor
    const button = sendButtonRef.current;
    if (button) {
      const rect = button.getBoundingClientRect();
      const anchor = {
        x: rect.left + rect.width / 2,
        y: rect.top,
      };

      // Start long-press timer
      longPressTimerRef.current = setTimeout(() => {
        // Trigger haptic feedback for long-press activation
        triggerHapticFeedback('medium');

        // Show quick actions menu
        setQuickActionsAnchor(anchor);
        setQuickActionsOpen(true);

        // Prevent the normal touch behavior
        longPressTimerRef.current = null;
      }, LONG_PRESS_DURATION);
    }

    // Scale down slightly on touch for tactile feedback
    if (!isDisabled && value.trim()) {
      e.currentTarget.style.transform = 'scale(0.95)';
    }
  }, [clearLongPressTimer, isDisabled, value]);

  /**
   * Handle touch end on send button
   * Clears the long-press timer and handles normal tap
   */
  const handleSendButtonTouchEnd = useCallback((e: React.TouchEvent<HTMLButtonElement>) => {
    e.currentTarget.style.transform = 'scale(1)';

    // If quick actions menu is not open and timer was running, this was a normal tap
    // The form onSubmit will handle the actual submission
    clearLongPressTimer();
  }, [clearLongPressTimer]);

  /**
   * Handle touch move on send button
   * Cancels long-press if user moves finger
   */
  const handleSendButtonTouchMove = useCallback(() => {
    clearLongPressTimer();
  }, [clearLongPressTimer]);

  /**
   * Handle quick action selection from menu
   */
  const handleQuickAction = useCallback((action: QuickAction) => {
    // Trigger haptic feedback
    triggerHapticFeedback('medium');

    if (action === 'switch_mode') {
      // Toggle to the opposite mode
      const newMode = inputMode === 'ai' ? 'terminal' : 'ai';
      onModeToggle?.(newMode);
    }
  }, [inputMode, onModeToggle]);

  /**
   * Close quick actions menu
   */
  const handleCloseQuickActions = useCallback(() => {
    setQuickActionsOpen(false);
  }, []);

  /**
   * Cleanup recognition and timers on unmount
   */
  useEffect(() => {
    return () => {
      // Clean up speech recognition
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // Ignore errors during cleanup
        }
      }
      // Clean up long-press timer
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      {...swipeUpHandlers}
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: keyboardOffset,
        zIndex: 100,
        // Safe area padding for notched devices
        paddingBottom: isKeyboardVisible ? '0' : 'max(12px, env(safe-area-inset-bottom))',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
        paddingTop: onHistoryOpen ? '4px' : '12px', // Reduced top padding when swipe handle is shown
        backgroundColor: colors.bgSidebar,
        borderTop: `1px solid ${colors.border}`,
        // Smooth transition when keyboard appears/disappears
        transition: isKeyboardVisible ? 'none' : 'bottom 0.15s ease-out',
      }}
    >
      {/* Swipe up handle indicator - visual hint for opening history */}
      {onHistoryOpen && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            paddingBottom: '8px',
            cursor: 'pointer',
          }}
          onClick={onHistoryOpen}
          aria-label="Open command history"
        >
          <div
            style={{
              width: '36px',
              height: '4px',
              backgroundColor: colors.border,
              borderRadius: '2px',
              opacity: 0.6,
            }}
          />
        </div>
      )}

      {/* Recent command chips - quick-tap to reuse commands */}
      {/* On mobile, can be hidden when input is not focused to save space */}
      {showRecentCommands && recentCommands && recentCommands.length > 0 && onSelectRecentCommand && (
        <RecentCommandChips
          commands={recentCommands}
          onSelectCommand={onSelectRecentCommand}
          disabled={isDisabled}
        />
      )}

      {/* Slash command autocomplete popup */}
      <SlashCommandAutocomplete
        isOpen={slashCommandOpen}
        inputValue={value}
        inputMode={inputMode}
        commands={slashCommands}
        onSelectCommand={handleSelectSlashCommand}
        onClose={handleCloseSlashCommand}
        selectedIndex={selectedSlashCommandIndex}
        onSelectedIndexChange={setSelectedSlashCommandIndex}
      />

      <form
        onSubmit={handleSubmit}
        style={{
          display: 'flex',
          gap: '8px',
          alignItems: 'flex-end', // Align to bottom for multi-line textarea
          paddingLeft: '16px',
          paddingRight: '16px',
        }}
      >
        {/* Mode toggle button - AI / Terminal */}
        {/* NOTE: Mode toggle is NOT disabled when session is busy - user should always be able to switch modes */}
        <button
          type="button"
          onClick={handleModeToggle}
          disabled={externalDisabled || isOffline || !isConnected}
          style={{
            padding: '10px',
            borderRadius: '12px',
            backgroundColor: inputMode === 'ai' ? `${colors.accent}20` : `${colors.textDim}20`,
            border: `2px solid ${inputMode === 'ai' ? colors.accent : colors.textDim}`,
            cursor: (externalDisabled || isOffline || !isConnected) ? 'default' : 'pointer',
            opacity: (externalDisabled || isOffline || !isConnected) ? 0.5 : 1,
            // Touch-friendly size - meets Apple HIG 44pt minimum
            width: `${MIN_TOUCH_TARGET + 4}px`,
            height: `${MIN_INPUT_HEIGHT}px`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '2px',
            // Smooth transitions
            transition: 'all 150ms ease',
            // Prevent button from shrinking
            flexShrink: 0,
            // Active state feedback
            WebkitTapHighlightColor: 'transparent',
          }}
          onTouchStart={(e) => {
            if (!(externalDisabled || isOffline || !isConnected)) {
              e.currentTarget.style.transform = 'scale(0.95)';
            }
          }}
          onTouchEnd={(e) => {
            e.currentTarget.style.transform = 'scale(1)';
          }}
          aria-label={`Switch to ${inputMode === 'ai' ? 'terminal' : 'AI'} mode. Currently in ${inputMode === 'ai' ? 'AI' : 'terminal'} mode.`}
          aria-pressed={inputMode === 'ai'}
        >
          {/* Mode icon - AI sparkle or Terminal prompt */}
          {inputMode === 'ai' ? (
            // AI sparkle icon
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
            // Terminal prompt icon
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
              color: inputMode === 'ai' ? colors.accent : colors.textDim,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}
          >
            {inputMode === 'ai' ? 'AI' : 'CLI'}
          </span>
        </button>

        {/* Voice input button - only shown if speech recognition is supported */}
        {voiceSupported && (
          <button
            type="button"
            onClick={handleVoiceToggle}
            disabled={isDisabled}
            style={{
              padding: '10px',
              borderRadius: '12px',
              backgroundColor: isListening ? '#ef444420' : `${colors.textDim}15`,
              border: `2px solid ${isListening ? '#ef4444' : colors.border}`,
              cursor: isDisabled ? 'default' : 'pointer',
              opacity: isDisabled ? 0.5 : 1,
              // Touch-friendly size - meets Apple HIG 44pt minimum
              width: `${MIN_TOUCH_TARGET + 4}px`,
              height: `${MIN_INPUT_HEIGHT}px`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              // Smooth transitions
              transition: 'all 150ms ease',
              // Prevent button from shrinking
              flexShrink: 0,
              // Active state feedback
              WebkitTapHighlightColor: 'transparent',
              // Pulsing animation when listening
              animation: isListening ? 'pulse 1.5s ease-in-out infinite' : 'none',
            }}
            onTouchStart={(e) => {
              if (!isDisabled) {
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
        )}

        {/* Inline CSS for pulse animation */}
        <style>
          {`
            @keyframes pulse {
              0%, 100% {
                box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4);
              }
              50% {
                box-shadow: 0 0 0 8px rgba(239, 68, 68, 0);
              }
            }
          `}
        </style>

        {/* Slash command button - only shown in AI mode */}
        {inputMode === 'ai' && (
          <button
            type="button"
            onClick={() => {
              // Set input to "/" and open autocomplete
              if (controlledValue === undefined) {
                setInternalValue('/');
              }
              onChange?.('/');
              setSlashCommandOpen(true);
              setSelectedSlashCommandIndex(0);
              // Focus the textarea
              textareaRef.current?.focus();
            }}
            disabled={isDisabled}
            style={{
              padding: '10px',
              borderRadius: '12px',
              backgroundColor: slashCommandOpen ? `${colors.accent}20` : `${colors.textDim}15`,
              border: `2px solid ${slashCommandOpen ? colors.accent : colors.border}`,
              cursor: isDisabled ? 'default' : 'pointer',
              opacity: isDisabled ? 0.5 : 1,
              // Touch-friendly size - meets Apple HIG 44pt minimum
              width: `${MIN_TOUCH_TARGET + 4}px`,
              height: `${MIN_INPUT_HEIGHT}px`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              // Smooth transitions
              transition: 'all 150ms ease',
              // Prevent button from shrinking
              flexShrink: 0,
              // Active state feedback
              WebkitTapHighlightColor: 'transparent',
            }}
            onTouchStart={(e) => {
              if (!isDisabled) {
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
                color: slashCommandOpen ? colors.accent : colors.textDim,
                fontFamily: 'ui-monospace, monospace',
              }}
            >
              /
            </span>
          </button>
        )}

        {/* Terminal mode: $ prefix + textarea in a container */}
        {inputMode === 'terminal' ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'flex-start',
              borderRadius: '12px',
              backgroundColor: colors.bgMain,
              border: `2px solid ${colors.border}`,
              padding: '14px 18px',
              gap: '8px',
              opacity: isDisabled ? 0.5 : 1,
            }}
          >
            {/* $ prompt */}
            <span
              style={{
                color: colors.accent,
                fontSize: '17px',
                fontFamily: 'ui-monospace, monospace',
                fontWeight: 600,
                lineHeight: `${LINE_HEIGHT}px`,
                flexShrink: 0,
              }}
            >
              $
            </span>
            <textarea
              ref={textareaRef}
              value={value}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              placeholder={getPlaceholder()}
              disabled={isDisabled}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="send"
              rows={1}
              style={{
                flex: 1,
                padding: 0,
                border: 'none',
                backgroundColor: 'transparent',
                color: isDisabled ? colors.textDim : colors.textMain,
                fontSize: '17px',
                fontFamily: 'ui-monospace, monospace',
                lineHeight: `${LINE_HEIGHT}px`,
                outline: 'none',
                height: `${Math.max(textareaHeight - 28, LINE_HEIGHT)}px`,
                minHeight: `${LINE_HEIGHT}px`,
                maxHeight: `${MAX_TEXTAREA_HEIGHT - 28}px`,
                resize: 'none',
                overflowY: textareaHeight >= MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden',
                overflowX: 'hidden',
                wordWrap: 'break-word',
              }}
              onFocus={(e) => {
                const container = e.currentTarget.parentElement;
                if (container) container.style.borderColor = colors.accent;
                onInputFocus?.();
              }}
              onBlur={(e) => {
                const container = e.currentTarget.parentElement;
                if (container) container.style.borderColor = colors.border;
                onInputBlur?.();
              }}
              aria-label={inputMode === 'terminal' ? 'Shell command input' : 'AI prompt input'}
              aria-multiline="true"
            />
          </div>
        ) : (
          /* AI mode: regular textarea */
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={getPlaceholder()}
            disabled={isDisabled}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="send"
          rows={1}
          style={{
            flex: 1,
            // Large touch-friendly padding (minimum 12px, but larger for comfort)
            padding: '14px 18px',
            borderRadius: '12px',
            backgroundColor: colors.bgMain,
            border: `2px solid ${colors.border}`,
            color: isDisabled ? colors.textDim : colors.textMain,
            // 16px minimum prevents iOS zoom on focus, 17px for better readability
            fontSize: '17px',
            fontFamily: 'inherit',
            lineHeight: `${LINE_HEIGHT}px`,
            opacity: isDisabled ? 0.5 : 1,
            outline: 'none',
            // Dynamic height for auto-expansion (controlled by useEffect)
            height: `${textareaHeight}px`,
            // Large minimum height for easy touch targeting
            minHeight: `${MIN_INPUT_HEIGHT}px`,
            // Maximum height based on MAX_LINES (4 lines) before scrolling
            maxHeight: `${MAX_TEXTAREA_HEIGHT}px`,
            // Reset appearance for consistent styling
            WebkitAppearance: 'none',
            appearance: 'none',
            // Remove default textarea resize handle
            resize: 'none',
            // Smooth height transitions for auto-expansion
            transition: 'height 100ms ease-out, border-color 150ms ease, opacity 150ms ease, box-shadow 150ms ease',
            // Better text rendering on mobile
            WebkitFontSmoothing: 'antialiased',
            MozOsxFontSmoothing: 'grayscale',
            // Enable scrolling only when content exceeds max height
            overflowY: textareaHeight >= MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden',
            overflowX: 'hidden',
            wordWrap: 'break-word',
          }}
          onFocus={(e) => {
            // Add focus ring for accessibility
            e.currentTarget.style.borderColor = colors.accent;
            e.currentTarget.style.boxShadow = `0 0 0 3px ${colors.accent}33`;
            onInputFocus?.();
          }}
          onBlur={(e) => {
            // Remove focus ring
            e.currentTarget.style.borderColor = colors.border;
            e.currentTarget.style.boxShadow = 'none';
            onInputBlur?.();
          }}
          aria-label="Command input"
          aria-disabled={isDisabled}
          aria-multiline="true"
        />
        )}

        {/* Interrupt button - visible when session is busy (red X) */}
        {isSessionBusy && (
          <button
            type="button"
            onClick={handleInterrupt}
            disabled={isDisabled}
            style={{
              padding: '14px',
              borderRadius: '12px',
              backgroundColor: '#ef4444', // Red color for interrupt
              color: '#ffffff',
              fontSize: '14px',
              fontWeight: 500,
              border: 'none',
              cursor: isDisabled ? 'default' : 'pointer',
              opacity: isDisabled ? 0.5 : 1,
              // Touch-friendly size - meets Apple HIG 44pt minimum
              width: `${MIN_TOUCH_TARGET + 4}px`,
              height: `${MIN_INPUT_HEIGHT}px`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              // Smooth transitions
              transition: 'opacity 150ms ease, background-color 150ms ease, transform 100ms ease',
              // Prevent button from shrinking
              flexShrink: 0,
              // Active state feedback
              WebkitTapHighlightColor: 'transparent',
            }}
            onTouchStart={(e) => {
              // Scale down slightly on touch for tactile feedback
              if (!isDisabled) {
                e.currentTarget.style.transform = 'scale(0.95)';
                e.currentTarget.style.backgroundColor = '#dc2626'; // Darker red on press
              }
            }}
            onTouchEnd={(e) => {
              e.currentTarget.style.transform = 'scale(1)';
              e.currentTarget.style.backgroundColor = '#ef4444';
            }}
            aria-label="Interrupt session"
          >
            {/* X icon for interrupt - larger for touch */}
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
        )}

        {/* Send button - large touch target matching input height */}
        {/* Long-press shows quick actions menu */}
        <button
          ref={sendButtonRef}
          type="submit"
          disabled={isDisabled || !value.trim()}
          style={{
            padding: '14px',
            borderRadius: '12px',
            backgroundColor: colors.accent,
            color: '#ffffff',
            fontSize: '14px',
            fontWeight: 500,
            border: 'none',
            cursor: isDisabled || !value.trim() ? 'default' : 'pointer',
            opacity: isDisabled || !value.trim() ? 0.5 : 1,
            // Touch-friendly size - meets Apple HIG 44pt minimum
            width: `${MIN_TOUCH_TARGET + 4}px`,
            height: `${MIN_INPUT_HEIGHT}px`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            // Smooth transitions
            transition: 'opacity 150ms ease, background-color 150ms ease, transform 100ms ease',
            // Prevent button from shrinking
            flexShrink: 0,
            // Active state feedback
            WebkitTapHighlightColor: 'transparent',
          }}
          onTouchStart={handleSendButtonTouchStart}
          onTouchEnd={handleSendButtonTouchEnd}
          onTouchMove={handleSendButtonTouchMove}
          aria-label="Send command (long press for quick actions)"
        >
          {/* Arrow up icon for send - larger for touch */}
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
      </form>

      {/* Current working directory display - shown in terminal mode */}
      {inputMode === 'terminal' && cwd && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: '12px',
            fontFamily: 'ui-monospace, monospace',
            color: colors.textDim,
            paddingLeft: '4px',
            marginTop: '4px',
          }}
        >
          <span style={{ opacity: 0.7 }}>
            {cwd.replace(/^\/Users\/[^/]+/, '~')}
          </span>
        </div>
      )}

      {/* Quick actions menu - shown on long-press of send button */}
      <QuickActionsMenu
        isOpen={quickActionsOpen}
        onClose={handleCloseQuickActions}
        onSelectAction={handleQuickAction}
        inputMode={inputMode}
        anchorPosition={quickActionsAnchor}
        hasActiveSession={hasActiveSession}
      />
    </div>
  );
}

export default CommandInputBar;
