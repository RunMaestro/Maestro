/**
 * Maestro Web Remote Control
 *
 * Lightweight interface for controlling sessions from mobile/tablet devices.
 * Focused on quick command input and session monitoring.
 */

import React, { useEffect, useCallback, useState, useMemo, useRef } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { useWebSocket, type WebSocketState, type CustomCommand } from '../hooks/useWebSocket';
import { useCommandHistory } from '../hooks/useCommandHistory';
import { useNotifications } from '../hooks/useNotifications';
import { useUnreadBadge } from '../hooks/useUnreadBadge';
import { useOfflineQueue } from '../hooks/useOfflineQueue';
import { Badge, type BadgeVariant } from '../components/Badge';
import { useOfflineStatus, useMaestroMode, useDesktopTheme } from '../main';
import { buildApiUrl } from '../utils/config';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import { webLogger } from '../utils/logger';
import type { Theme } from '../../shared/theme-types';
import { SessionPillBar } from './SessionPillBar';
import { AllSessionsView } from './AllSessionsView';
import { CommandInputBar, type InputMode } from './CommandInputBar';
import { DEFAULT_SLASH_COMMANDS, type SlashCommand } from './SlashCommandAutocomplete';
import { CommandHistoryDrawer } from './CommandHistoryDrawer';
import { RecentCommandChips } from './RecentCommandChips';
import { ResponseViewer, type ResponseItem } from './ResponseViewer';
import { OfflineQueueBanner } from './OfflineQueueBanner';
import { ConnectionStatusIndicator } from './ConnectionStatusIndicator';
import { MessageHistory, type LogEntry } from './MessageHistory';
import type { Session, LastResponsePreview } from '../hooks/useSessions';

/**
 * Map WebSocket state to display properties
 */
interface ConnectionStatusConfig {
  label: string;
  variant: BadgeVariant;
  pulse: boolean;
}

const CONNECTION_STATUS_CONFIG: Record<WebSocketState | 'offline', ConnectionStatusConfig> = {
  offline: {
    label: 'Offline',
    variant: 'error',
    pulse: false,
  },
  disconnected: {
    label: 'Disconnected',
    variant: 'error',
    pulse: false,
  },
  connecting: {
    label: 'Connecting...',
    variant: 'connecting',
    pulse: true,
  },
  authenticating: {
    label: 'Authenticating...',
    variant: 'connecting',
    pulse: true,
  },
  connected: {
    label: 'Connected',
    variant: 'success',
    pulse: false,
  },
  authenticated: {
    label: 'Connected',
    variant: 'success',
    pulse: false,
  },
};

/**
 * Format cost in USD for display
 */
function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1.0) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

/**
 * Calculate context usage percentage from usage stats
 */
function calculateContextUsage(usageStats?: Session['usageStats'] | null): number | null {
  if (!usageStats) return null;
  const { inputTokens, outputTokens, contextWindow } = usageStats;
  if (inputTokens == null || outputTokens == null || contextWindow == null || contextWindow === 0) {
    return null;
  }
  return Math.min(Math.round(((inputTokens + outputTokens) / contextWindow) * 100), 100);
}

/**
 * Header component for the mobile app
 * Compact single-line header showing: Maestro | Session Name | Claude ID | Status | Cost | Context
 */
interface MobileHeaderProps {
  connectionState: WebSocketState;
  isOffline: boolean;
  onRetry?: () => void;
  activeSession?: Session | null;
}

function MobileHeader({ connectionState, isOffline, onRetry, activeSession }: MobileHeaderProps) {
  const colors = useThemeColors();
  const { isSession, goToDashboard } = useMaestroMode();

  // Show offline status if device is offline, otherwise show connection state
  const effectiveState = isOffline ? 'offline' : connectionState;
  const statusConfig = CONNECTION_STATUS_CONFIG[effectiveState];

  // Session status and usage
  const sessionState = activeSession?.state || 'idle';
  const isThinking = sessionState === 'busy';
  const cost = activeSession?.usageStats?.totalCostUsd;
  const contextUsage = calculateContextUsage(activeSession?.usageStats);

  // Get status dot color
  const getStatusDotColor = () => {
    if (sessionState === 'busy') return colors.warning;
    if (sessionState === 'error') return colors.error;
    if (sessionState === 'connecting') return colors.warning;
    return colors.success; // idle
  };

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        paddingTop: 'max(8px, env(safe-area-inset-top))',
        borderBottom: `1px solid ${colors.border}`,
        backgroundColor: colors.bgSidebar,
        minHeight: '44px',
        gap: '8px',
      }}
    >
      {/* Left: Maestro logo with wand icon */}
      <div
        onClick={isSession ? goToDashboard : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          cursor: isSession ? 'pointer' : 'default',
          flexShrink: 0,
        }}
        title={isSession ? 'Go to dashboard' : undefined}
      >
        {/* Wand icon */}
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
          <path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72Z"/>
          <path d="m14 7 3 3"/>
          <path d="M5 6v4"/>
          <path d="M19 14v4"/>
          <path d="M10 2v2"/>
          <path d="M7 8H3"/>
          <path d="M21 16h-4"/>
          <path d="M11 3H9"/>
        </svg>
        <span
          style={{
            fontSize: '16px',
            fontWeight: 600,
            color: colors.textMain,
          }}
        >
          Maestro
        </span>
      </div>

      {/* Center: Session info (name + Claude session ID + status + usage) */}
      {activeSession && (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            minWidth: 0,
            overflow: 'hidden',
          }}
        >
          {/* Session status dot */}
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: getStatusDotColor(),
              flexShrink: 0,
              animation: isThinking ? 'pulse 1.5s ease-in-out infinite' : 'none',
            }}
            title={`Session ${sessionState}`}
          />

          {/* Session name */}
          <span
            style={{
              fontSize: '13px',
              fontWeight: 500,
              color: colors.textMain,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {activeSession.name}
          </span>

          {/* Claude Session ID pill */}
          {activeSession.claudeSessionId && (
            <span
              style={{
                fontSize: '10px',
                color: colors.textDim,
                fontFamily: 'monospace',
                backgroundColor: colors.bgMain,
                padding: '2px 4px',
                borderRadius: '3px',
                flexShrink: 0,
              }}
              title={`Claude Session: ${activeSession.claudeSessionId}`}
            >
              {activeSession.claudeSessionId.slice(0, 8)}
            </span>
          )}

          {/* Cost */}
          {cost != null && cost > 0 && (
            <span
              style={{
                fontSize: '10px',
                color: colors.textDim,
                backgroundColor: `${colors.textDim}15`,
                padding: '2px 4px',
                borderRadius: '3px',
                flexShrink: 0,
              }}
              title={`Session cost: ${formatCost(cost)}`}
            >
              {formatCost(cost)}
            </span>
          )}

          {/* Context usage bar */}
          {contextUsage != null && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '3px',
                flexShrink: 0,
              }}
              title={`Context: ${contextUsage}%`}
            >
              <div
                style={{
                  width: '30px',
                  height: '4px',
                  backgroundColor: `${colors.textDim}20`,
                  borderRadius: '2px',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${contextUsage}%`,
                    height: '100%',
                    backgroundColor: contextUsage >= 90 ? colors.error : contextUsage >= 70 ? colors.warning : colors.success,
                    borderRadius: '2px',
                  }}
                />
              </div>
              <span style={{ fontSize: '9px', color: colors.textDim }}>{contextUsage}%</span>
            </div>
          )}
        </div>
      )}

      {/* Right: Connection status */}
      <Badge
        variant={statusConfig.variant}
        badgeStyle="subtle"
        size="sm"
        pulse={statusConfig.pulse}
        onClick={!isOffline && connectionState === 'disconnected' ? onRetry : undefined}
        style={{
          cursor: !isOffline && connectionState === 'disconnected' ? 'pointer' : 'default',
          flexShrink: 0,
        }}
      >
        {statusConfig.label}
      </Badge>

      {/* Pulse animation for thinking state */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </header>
  );
}

/**
 * Main mobile app component with WebSocket connection management
 */
export default function MobileApp() {
  const colors = useThemeColors();
  const isOffline = useOfflineStatus();
  const { setDesktopTheme } = useDesktopTheme();
  const [lastRefreshTime, setLastRefreshTime] = useState<Date | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [commandInput, setCommandInput] = useState('');
  const [showHistoryDrawer, setShowHistoryDrawer] = useState(false);
  const [showResponseViewer, setShowResponseViewer] = useState(false);
  const [selectedResponse, setSelectedResponse] = useState<LastResponsePreview | null>(null);
  const [responseIndex, setResponseIndex] = useState(0);

  // Message history state (logs from active session)
  const [sessionLogs, setSessionLogs] = useState<{ aiLogs: LogEntry[]; shellLogs: LogEntry[] }>({
    aiLogs: [],
    shellLogs: [],
  });
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);

  // Custom slash commands from desktop
  const [customCommands, setCustomCommands] = useState<CustomCommand[]>([]);

  // Input expansion state for small screens (drawer-like behavior)
  const [isInputExpanded, setIsInputExpanded] = useState(false);

  // Detect if on a small screen (phone vs tablet/iPad)
  // Use 768px as breakpoint - below this is considered "small"
  const [isSmallScreen, setIsSmallScreen] = useState(
    typeof window !== 'undefined' ? window.innerHeight < 700 : false
  );

  // Track screen size changes
  useEffect(() => {
    const handleResize = () => {
      setIsSmallScreen(window.innerHeight < 700);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Command history hook
  const {
    history: commandHistory,
    addCommand: addToHistory,
    removeCommand: removeFromHistory,
    clearHistory,
    getUniqueCommands,
  } = useCommandHistory();

  // Notification permission hook - requests permission on first visit
  const {
    permission: notificationPermission,
    showNotification,
  } = useNotifications({
    autoRequest: true,
    requestDelay: 3000, // Wait 3 seconds before prompting
    onGranted: () => {
      webLogger.debug('Notification permission granted', 'Mobile');
      triggerHaptic(HAPTIC_PATTERNS.success);
    },
    onDenied: () => {
      webLogger.debug('Notification permission denied', 'Mobile');
    },
  });

  // Unread badge hook - tracks unread responses and updates app badge
  const {
    addUnread: addUnreadResponse,
    markAllRead: markAllResponsesRead,
    unreadCount,
  } = useUnreadBadge({
    autoClearOnVisible: true, // Clear badge when user opens the app
    onCountChange: (count) => {
      webLogger.debug(`Unread response count: ${count}`, 'Mobile');
    },
  });

  // Track previous session states for detecting busy -> idle transitions
  const previousSessionStatesRef = useRef<Map<string, string>>(new Map());

  // Reference to send function for offline queue (will be set after useWebSocket)
  const sendRef = useRef<((sessionId: string, command: string) => boolean) | null>(null);

  /**
   * Get the first line of a response for notification display
   * Strips markdown/code markers and truncates to reasonable length
   */
  const getFirstLineOfResponse = useCallback((text: string): string => {
    if (!text) return 'Response completed';

    // Split by newlines and find first non-empty, non-markdown line
    const lines = text.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip empty lines and common markdown markers
      if (!trimmed) continue;
      if (trimmed.startsWith('```')) continue;
      if (trimmed === '---') continue;

      // Found a content line - truncate if too long
      const maxLength = 100;
      if (trimmed.length > maxLength) {
        return trimmed.substring(0, maxLength) + '...';
      }
      return trimmed;
    }

    return 'Response completed';
  }, []);

  /**
   * Show notification when AI response completes (if app is backgrounded)
   * Also increments the unread badge count
   */
  const showResponseNotification = useCallback((session: Session, response?: LastResponsePreview | null) => {
    // Only show if app is backgrounded
    if (document.visibilityState !== 'hidden') {
      return;
    }

    // Generate a unique ID for this response using session ID and timestamp
    const responseId = `${session.id}-${response?.timestamp || Date.now()}`;

    // Add to unread badge count (works even without notification permission)
    addUnreadResponse(responseId);
    webLogger.debug(`Added unread response: ${responseId}`, 'Mobile');

    // Only show notification if permission is granted
    if (notificationPermission !== 'granted') {
      return;
    }

    const title = `${session.name} - Response Ready`;
    const firstLine = response?.text
      ? getFirstLineOfResponse(response.text)
      : 'AI response completed';

    const notification = showNotification(title, {
      body: firstLine,
      tag: `maestro-response-${session.id}`, // Prevent duplicate notifications for same session
      renotify: true, // Allow notification to be re-shown if same tag
      silent: false,
      requireInteraction: false, // Auto-dismiss on mobile
    });

    if (notification) {
      webLogger.debug(`Notification shown for session: ${session.name}`, 'Mobile');

      // Handle notification click - focus the app
      notification.onclick = () => {
        window.focus();
        notification.close();
        // Set this session as active and clear badge
        setActiveSessionId(session.id);
        markAllResponsesRead();
      };
    }
  }, [notificationPermission, showNotification, getFirstLineOfResponse, addUnreadResponse, markAllResponsesRead]);

  // Memoize handlers to prevent unnecessary re-renders
  const wsHandlers = useMemo(() => ({
    onConnectionChange: (newState: WebSocketState) => {
      webLogger.debug(`Connection state: ${newState}`, 'Mobile');
    },
    onError: (err: string) => {
      webLogger.error(`WebSocket error: ${err}`, 'Mobile');
    },
    onSessionsUpdate: (newSessions: Session[]) => {
      webLogger.debug(`Sessions updated: ${newSessions.length}`, 'Mobile');

      // Update previous states map for all sessions
      newSessions.forEach(s => {
        previousSessionStatesRef.current.set(s.id, s.state);
      });

      setSessions(newSessions);
      // Auto-select first session if none selected
      setActiveSessionId(prev => {
        if (!prev && newSessions.length > 0) {
          return newSessions[0].id;
        }
        return prev;
      });
    },
    onSessionStateChange: (sessionId: string, state: string, additionalData?: Partial<Session>) => {
      // Check if this is a busy -> idle transition (AI response completed)
      const previousState = previousSessionStatesRef.current.get(sessionId);
      const isResponseComplete = previousState === 'busy' && state === 'idle';

      // Update the previous state
      previousSessionStatesRef.current.set(sessionId, state);

      setSessions(prev => {
        const updatedSessions = prev.map(s =>
          s.id === sessionId
            ? { ...s, state, ...additionalData }
            : s
        );

        // Show notification if response completed and app is backgrounded
        if (isResponseComplete) {
          const session = updatedSessions.find(s => s.id === sessionId);
          if (session) {
            // Get the response from additionalData or the updated session
            const response = (additionalData as any)?.lastResponse || (session as any).lastResponse;
            showResponseNotification(session, response);
          }
        }

        return updatedSessions;
      });
    },
    onSessionAdded: (session: Session) => {
      // Track state for new session
      previousSessionStatesRef.current.set(session.id, session.state);

      setSessions(prev => {
        if (prev.some(s => s.id === session.id)) return prev;
        return [...prev, session];
      });
    },
    onSessionRemoved: (sessionId: string) => {
      // Clean up state tracking
      previousSessionStatesRef.current.delete(sessionId);

      setSessions(prev => prev.filter(s => s.id !== sessionId));
      setActiveSessionId(prev => prev === sessionId ? null : prev);
    },
    onActiveSessionChanged: (sessionId: string) => {
      // Desktop app switched to a different session - sync with web
      webLogger.debug(`Desktop active session changed: ${sessionId}`, 'Mobile');
      setActiveSessionId(sessionId);
    },
    onSessionOutput: (sessionId: string, data: string, source: 'ai' | 'terminal') => {
      // Real-time output from AI or terminal - append to session logs
      console.log(`[MobileApp] onSessionOutput called: session=${sessionId}, source=${source}, dataLen=${data?.length || 0}`);
      webLogger.debug(`Session output: ${sessionId} (${source}) ${data.length} chars`, 'Mobile');

      // Only update if this is the active session
      setActiveSessionId(currentActiveId => {
        console.log(`[MobileApp] Checking activeSession: currentActiveId=${currentActiveId}, incomingSession=${sessionId}, match=${currentActiveId === sessionId}`);
        if (currentActiveId === sessionId) {
          setSessionLogs(prev => {
            const logKey = source === 'ai' ? 'aiLogs' : 'shellLogs';
            const existingLogs = prev[logKey] || [];

            // Check if the last entry is a streaming entry we should append to
            const lastLog = existingLogs[existingLogs.length - 1];
            const isStreamingAppend = lastLog &&
              lastLog.source === 'stdout' &&
              Date.now() - lastLog.timestamp < 5000; // Within 5 seconds

            if (isStreamingAppend) {
              // Append to existing entry
              const updatedLogs = [...existingLogs];
              updatedLogs[updatedLogs.length - 1] = {
                ...lastLog,
                text: lastLog.text + data,
              };
              return { ...prev, [logKey]: updatedLogs };
            } else {
              // Create new entry
              const newEntry = {
                id: `stream-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                timestamp: Date.now(),
                source: 'stdout' as const,
                text: data,
              };
              return { ...prev, [logKey]: [...existingLogs, newEntry] };
            }
          });
        }
        return currentActiveId;
      });
    },
    onSessionExit: (sessionId: string, exitCode: number) => {
      webLogger.debug(`Session exit: ${sessionId} code=${exitCode}`, 'Mobile');
      // Update session state to idle when process exits
      setSessions(prev => prev.map(s =>
        s.id === sessionId ? { ...s, state: 'idle' } : s
      ));
    },
    onUserInput: (sessionId: string, command: string, inputMode: 'ai' | 'terminal') => {
      // User input from desktop app - add to session logs so web interface stays in sync
      webLogger.debug(`User input from desktop: ${sessionId} (${inputMode}) ${command.substring(0, 50)}`, 'Mobile');

      // Only add if this is the active session
      setActiveSessionId(currentActiveId => {
        if (currentActiveId === sessionId) {
          const userLogEntry: LogEntry = {
            id: `user-desktop-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            timestamp: Date.now(),
            text: command,
            source: 'user',
          };
          setSessionLogs(prev => {
            const logKey = inputMode === 'ai' ? 'aiLogs' : 'shellLogs';
            return { ...prev, [logKey]: [...prev[logKey], userLogEntry] };
          });
        }
        return currentActiveId;
      });
    },
    onThemeUpdate: (theme: Theme) => {
      // Sync theme from desktop app by updating the React context
      // This will update ThemeProvider which will re-render all themed components
      webLogger.debug(`Theme update received: ${theme.name} (${theme.mode})`, 'Mobile');
      setDesktopTheme(theme);
    },
    onCustomCommands: (commands: CustomCommand[]) => {
      // Custom slash commands from desktop app
      webLogger.debug(`Custom commands received: ${commands.length}`, 'Mobile');
      setCustomCommands(commands);
    },
  }), [showResponseNotification, setDesktopTheme]);

  const { state: connectionState, connect, send, error, reconnectAttempts } = useWebSocket({
    autoReconnect: false, // Only retry manually via the retry button
    handlers: wsHandlers,
  });

  // Connect on mount
  useEffect(() => {
    connect();
  }, [connect]);

  // Fetch session logs when active session changes
  useEffect(() => {
    if (!activeSessionId || isOffline) {
      setSessionLogs({ aiLogs: [], shellLogs: [] });
      return;
    }

    const fetchSessionLogs = async () => {
      setIsLoadingLogs(true);
      try {
        const apiUrl = buildApiUrl(`/session/${activeSessionId}`);
        const response = await fetch(apiUrl);
        if (response.ok) {
          const data = await response.json();
          const session = data.session;
          setSessionLogs({
            aiLogs: session?.aiLogs || [],
            shellLogs: session?.shellLogs || [],
          });
          webLogger.debug('Fetched session logs:', 'Mobile', {
            aiLogs: session?.aiLogs?.length || 0,
            shellLogs: session?.shellLogs?.length || 0,
          });
        }
      } catch (err) {
        webLogger.error('Failed to fetch session logs', 'Mobile', err);
      } finally {
        setIsLoadingLogs(false);
      }
    };

    fetchSessionLogs();
  }, [activeSessionId, isOffline]);

  // Update sendRef after WebSocket is initialized
  useEffect(() => {
    sendRef.current = (sessionId: string, command: string) => {
      return send({
        type: 'send_command',
        sessionId,
        command,
      });
    };
  }, [send]);

  // Determine if we're actually connected
  const isActuallyConnected = !isOffline && (connectionState === 'connected' || connectionState === 'authenticated');

  // Offline queue hook - stores commands typed while offline and sends when reconnected
  const {
    queue: offlineQueue,
    queueLength: offlineQueueLength,
    status: offlineQueueStatus,
    queueCommand,
    removeCommand: removeQueuedCommand,
    clearQueue: clearOfflineQueue,
    processQueue: processOfflineQueue,
  } = useOfflineQueue({
    isOnline: !isOffline,
    isConnected: isActuallyConnected,
    sendCommand: (sessionId, command) => {
      if (sendRef.current) {
        return sendRef.current(sessionId, command);
      }
      return false;
    },
    onCommandSent: (cmd) => {
      webLogger.debug(`Queued command sent: ${cmd.command.substring(0, 50)}`, 'Mobile');
      triggerHaptic(HAPTIC_PATTERNS.success);
    },
    onCommandFailed: (cmd, error) => {
      webLogger.error(`Queued command failed: ${cmd.command.substring(0, 50)}`, 'Mobile', error);
    },
    onProcessingStart: () => {
      webLogger.debug('Processing offline queue...', 'Mobile');
    },
    onProcessingComplete: (successCount, failCount) => {
      webLogger.debug(`Offline queue processed. Success: ${successCount}, Failed: ${failCount}`, 'Mobile');
      if (successCount > 0) {
        triggerHaptic(HAPTIC_PATTERNS.success);
      }
    },
  });

  // Retry connection handler
  const handleRetry = useCallback(() => {
    connect();
  }, [connect]);

  // Handle session selection
  const handleSelectSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
    triggerHaptic(HAPTIC_PATTERNS.tap);
  }, []);

  // Handle opening All Sessions view
  const handleOpenAllSessions = useCallback(() => {
    setShowAllSessions(true);
    triggerHaptic(HAPTIC_PATTERNS.tap);
  }, []);

  // Handle closing All Sessions view
  const handleCloseAllSessions = useCallback(() => {
    setShowAllSessions(false);
  }, []);

  // Handle command submission
  const handleCommandSubmit = useCallback((command: string) => {
    if (!activeSessionId) return;

    // Find the active session to get input mode
    const session = sessions.find(s => s.id === activeSessionId);
    const currentMode = (session?.inputMode as InputMode) || 'ai';

    // Provide haptic feedback on send
    triggerHaptic(HAPTIC_PATTERNS.send);

    // Add to command history
    addToHistory(command, activeSessionId, currentMode);

    // Add user message to session logs immediately for display
    const userLogEntry: LogEntry = {
      id: `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      text: command,
      source: 'user',
    };
    setSessionLogs(prev => {
      const logKey = currentMode === 'ai' ? 'aiLogs' : 'shellLogs';
      return { ...prev, [logKey]: [...prev[logKey], userLogEntry] };
    });

    // If offline or not connected, queue the command for later
    if (isOffline || !isActuallyConnected) {
      const queued = queueCommand(activeSessionId, command, currentMode);
      if (queued) {
        webLogger.debug(`Command queued for later: ${command.substring(0, 50)}`, 'Mobile');
        // Provide different haptic feedback for queued commands
        triggerHaptic(HAPTIC_PATTERNS.tap);
      } else {
        webLogger.warn('Failed to queue command - queue may be full', 'Mobile');
      }
    } else {
      // Send the command to the active session immediately
      send({
        type: 'send_command',
        sessionId: activeSessionId,
        command,
      });
      webLogger.debug(`Command sent: ${command} to session: ${activeSessionId}`, 'Mobile');
    }

    // Clear the input
    setCommandInput('');

    // Collapse input on small screens after sending
    if (isSmallScreen) {
      setIsInputExpanded(false);
    }
  }, [activeSessionId, sessions, send, addToHistory, isOffline, isActuallyConnected, queueCommand, isSmallScreen]);

  // Handle command input change
  const handleCommandChange = useCallback((value: string) => {
    setCommandInput(value);
  }, []);

  // Handle input focus - expand on small screens
  const handleInputFocus = useCallback(() => {
    if (isSmallScreen) {
      setIsInputExpanded(true);
    }
  }, [isSmallScreen]);

  // Handle input blur - collapse on small screens (with small delay to allow for submit)
  const handleInputBlur = useCallback(() => {
    // Don't immediately collapse - let submit handler do it if needed
    // This prevents collapse when tapping submit button
  }, []);

  // Handle mode toggle between AI and Terminal
  const handleModeToggle = useCallback((mode: InputMode) => {
    if (!activeSessionId) return;

    // Provide haptic feedback
    triggerHaptic(HAPTIC_PATTERNS.tap);

    // Send mode switch command via WebSocket
    send({
      type: 'switch_mode',
      sessionId: activeSessionId,
      mode,
    });

    // Optimistically update local session state
    setSessions(prev => prev.map(s =>
      s.id === activeSessionId
        ? { ...s, inputMode: mode }
        : s
    ));

    webLogger.debug(`Mode switched to: ${mode} for session: ${activeSessionId}`, 'Mobile');
  }, [activeSessionId, send]);

  // Handle interrupt request
  const handleInterrupt = useCallback(async () => {
    if (!activeSessionId) return;

    // Provide haptic feedback
    triggerHaptic(HAPTIC_PATTERNS.tap);

    try {
      // Build the API URL with security token in path
      const apiUrl = buildApiUrl(`/session/${activeSessionId}/interrupt`);
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const result = await response.json();

      if (response.ok && result.success) {
        webLogger.debug(`Session interrupted: ${activeSessionId}`, 'Mobile');
        triggerHaptic(HAPTIC_PATTERNS.success);
      } else {
        webLogger.error(`Failed to interrupt session: ${result.error}`, 'Mobile');
      }
    } catch (error) {
      webLogger.error('Error interrupting session', 'Mobile', error);
    }
  }, [activeSessionId]);

  // Handle opening history drawer
  const handleOpenHistory = useCallback(() => {
    setShowHistoryDrawer(true);
    triggerHaptic(HAPTIC_PATTERNS.tap);
  }, []);

  // Handle closing history drawer
  const handleCloseHistory = useCallback(() => {
    setShowHistoryDrawer(false);
  }, []);

  // Handle selecting a command from history
  const handleSelectHistoryCommand = useCallback((command: string) => {
    setCommandInput(command);
    // Haptic feedback is provided by the drawer
  }, []);

  // Combined slash commands (default + custom from desktop)
  const allSlashCommands = useMemo((): SlashCommand[] => {
    // Convert custom commands to SlashCommand format
    const customSlashCommands: SlashCommand[] = customCommands.map(cmd => ({
      command: cmd.command.startsWith('/') ? cmd.command : `/${cmd.command}`,
      description: cmd.description,
      aiOnly: true, // Custom commands are AI-only
    }));
    // Combine defaults with custom commands
    return [...DEFAULT_SLASH_COMMANDS, ...customSlashCommands];
  }, [customCommands]);

  // Collect all responses from sessions for navigation
  const allResponses = useMemo((): ResponseItem[] => {
    return sessions
      .filter(s => (s as any).lastResponse)
      .map(s => ({
        response: (s as any).lastResponse as LastResponsePreview,
        sessionId: s.id,
        sessionName: s.name,
      }))
      // Sort by timestamp (most recent first)
      .sort((a, b) => b.response.timestamp - a.response.timestamp);
  }, [sessions]);

  // Handle expanding response to full-screen viewer
  const handleExpandResponse = useCallback((response: LastResponsePreview) => {
    setSelectedResponse(response);

    // Find the index of this response in allResponses
    const index = allResponses.findIndex(
      item => item.response.timestamp === response.timestamp
    );
    setResponseIndex(index >= 0 ? index : 0);

    setShowResponseViewer(true);
    triggerHaptic(HAPTIC_PATTERNS.tap);
    webLogger.debug(`Opening response viewer at index: ${index}`, 'Mobile');
  }, [allResponses]);

  // Handle navigating between responses in the viewer
  const handleNavigateResponse = useCallback((index: number) => {
    if (index >= 0 && index < allResponses.length) {
      setResponseIndex(index);
      setSelectedResponse(allResponses[index].response);
      webLogger.debug(`Navigating to response index: ${index}`, 'Mobile');
    }
  }, [allResponses]);

  // Handle closing response viewer
  const handleCloseResponseViewer = useCallback(() => {
    setShowResponseViewer(false);
    // Keep selectedResponse so animation can complete
    setTimeout(() => setSelectedResponse(null), 300);
  }, []);

  // Get active session for input mode
  const activeSession = sessions.find(s => s.id === activeSessionId);

  // Determine content based on connection state
  const renderContent = () => {
    // Show offline state when device has no network connectivity
    if (isOffline) {
      return (
        <div
          style={{
            marginBottom: '24px',
            padding: '16px',
            borderRadius: '12px',
            backgroundColor: colors.bgSidebar,
            border: `1px solid ${colors.border}`,
            maxWidth: '300px',
          }}
        >
          <h2 style={{ fontSize: '16px', marginBottom: '8px', color: colors.textMain }}>
            You're Offline
          </h2>
          <p style={{ fontSize: '14px', color: colors.textDim, marginBottom: '12px' }}>
            No internet connection. Maestro requires a network connection to communicate with your desktop app.
          </p>
          <p style={{ fontSize: '12px', color: colors.textDim }}>
            The app will automatically reconnect when you're back online.
          </p>
        </div>
      );
    }

    if (connectionState === 'disconnected') {
      return (
        <div
          style={{
            marginBottom: '24px',
            padding: '16px',
            borderRadius: '12px',
            backgroundColor: colors.bgSidebar,
            border: `1px solid ${colors.border}`,
            maxWidth: '300px',
          }}
        >
          <h2 style={{ fontSize: '16px', marginBottom: '8px', color: colors.textMain }}>
            Connection Lost
          </h2>
          <p style={{ fontSize: '14px', color: colors.textDim, marginBottom: '12px' }}>
            {error || 'Unable to connect to Maestro desktop app.'}
          </p>
          {reconnectAttempts > 0 && (
            <p style={{ fontSize: '12px', color: colors.textDim, marginBottom: '12px' }}>
              Reconnection attempts: {reconnectAttempts}
            </p>
          )}
          <button
            onClick={handleRetry}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              backgroundColor: colors.accent,
              color: '#fff',
              fontSize: '14px',
              fontWeight: 500,
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Retry Connection
          </button>
        </div>
      );
    }

    if (connectionState === 'connecting' || connectionState === 'authenticating') {
      return (
        <div
          style={{
            marginBottom: '24px',
            padding: '16px',
            borderRadius: '12px',
            backgroundColor: colors.bgSidebar,
            border: `1px solid ${colors.border}`,
            maxWidth: '300px',
          }}
        >
          <h2 style={{ fontSize: '16px', marginBottom: '8px', color: colors.textMain }}>
            Connecting to Maestro...
          </h2>
          <p style={{ fontSize: '14px', color: colors.textDim }}>
            Please wait while we establish a connection to your desktop app.
          </p>
        </div>
      );
    }

    // Connected or authenticated state - show conversation or prompt to select session
    if (!activeSession) {
      return (
        <div
          style={{
            marginBottom: '24px',
            padding: '16px',
            textAlign: 'center',
          }}
        >
          <p style={{ fontSize: '14px', color: colors.textDim }}>
            Select a session above to get started
          </p>
        </div>
      );
    }

    // Get logs based on current input mode
    const currentLogs = activeSession.inputMode === 'ai' ? sessionLogs.aiLogs : sessionLogs.shellLogs;

    // Show message history
    return (
      <div
        style={{
          width: '100%',
          maxWidth: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          alignItems: 'stretch',
        }}
      >
        {isLoadingLogs ? (
          <div
            style={{
              padding: '16px',
              textAlign: 'center',
              color: colors.textDim,
              fontSize: '13px',
            }}
          >
            Loading conversation...
          </div>
        ) : currentLogs.length === 0 ? (
          <div
            style={{
              padding: '16px',
              textAlign: 'center',
              color: colors.textDim,
              fontSize: '14px',
            }}
          >
            {activeSession.inputMode === 'ai'
              ? 'Ask your AI assistant anything'
              : 'Run shell commands'}
          </div>
        ) : (
          <MessageHistory
            logs={currentLogs}
            inputMode={activeSession.inputMode as 'ai' | 'terminal'}
            autoScroll={true}
            maxHeight="calc(100vh - 340px)"
          />
        )}
      </div>
    );
  };

  // CSS variable for dynamic viewport height with fallback
  // The fixed CommandInputBar requires padding at the bottom of the container
  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100dvh',
    backgroundColor: colors.bgMain,
    color: colors.textMain,
    // Add padding at bottom to account for fixed input bar (~70px + safe area)
    paddingBottom: 'calc(70px + max(12px, env(safe-area-inset-bottom)))',
  };

  // Determine if session pill bar should be shown
  const showSessionPillBar = !isOffline &&
    (connectionState === 'connected' || connectionState === 'authenticated') &&
    sessions.length > 0;

  return (
    <div style={containerStyle}>
      {/* Header with connection status and session info */}
      <MobileHeader
        connectionState={connectionState}
        isOffline={isOffline}
        onRetry={handleRetry}
        activeSession={activeSession}
      />

      {/* Connection status indicator with retry button - shows when disconnected or reconnecting */}
      <ConnectionStatusIndicator
        connectionState={connectionState}
        isOffline={isOffline}
        reconnectAttempts={reconnectAttempts}
        maxReconnectAttempts={10}
        error={error}
        onRetry={handleRetry}
      />

      {/* Session pill bar - shown when connected and sessions available */}
      {showSessionPillBar && (
        <SessionPillBar
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={handleSelectSession}
          onOpenAllSessions={handleOpenAllSessions}
        />
      )}

      {/* Offline queue banner - shown when there are queued commands */}
      {offlineQueueLength > 0 && (
        <OfflineQueueBanner
          queue={offlineQueue}
          status={offlineQueueStatus}
          onClearQueue={clearOfflineQueue}
          onProcessQueue={processOfflineQueue}
          onRemoveCommand={removeQueuedCommand}
          isOffline={isOffline}
          isConnected={isActuallyConnected}
        />
      )}

      {/* All Sessions view - full-screen modal with larger session cards */}
      {showAllSessions && (
        <AllSessionsView
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={handleSelectSession}
          onClose={handleCloseAllSessions}
        />
      )}

      {/* Main content area - shrinks when input expanded on small screens */}
      <main
        onClick={() => {
          // Collapse input when tapping message history on small screens
          if (isSmallScreen && isInputExpanded) {
            setIsInputExpanded(false);
          }
        }}
        style={{
          flex: isSmallScreen && isInputExpanded ? '0 0 30%' : 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'flex-start',
          padding: '20px',
          textAlign: 'center',
          overflow: 'auto',
          overscrollBehavior: 'contain',
          position: 'relative',
          transition: 'flex 0.2s ease-out',
          minHeight: isSmallScreen && isInputExpanded ? '100px' : undefined,
        }}
      >
        {/* Content wrapper */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: connectionState === 'connected' || connectionState === 'authenticated' ? 'flex-start' : 'center',
            width: '100%',
          }}
        >
          {renderContent()}
          {/* Show help text only when disconnected/connecting */}
          {connectionState !== 'connected' && connectionState !== 'authenticated' && (
            <p style={{ fontSize: '12px', color: colors.textDim }}>
              Make sure Maestro desktop app is running
            </p>
          )}
          {lastRefreshTime && (connectionState === 'connected' || connectionState === 'authenticated') && (
            <p style={{ fontSize: '11px', color: colors.textDim, marginTop: '8px' }}>
              Last updated: {lastRefreshTime.toLocaleTimeString()}
            </p>
          )}
        </div>
      </main>

      {/* Sticky bottom command input bar with recent command chips */}
      <CommandInputBar
        isOffline={isOffline}
        isConnected={connectionState === 'connected' || connectionState === 'authenticated'}
        value={commandInput}
        onChange={handleCommandChange}
        onSubmit={handleCommandSubmit}
        placeholder={
          !activeSessionId
            ? 'Select a session first...'
            : activeSession?.inputMode === 'ai'
              ? (isSmallScreen
                  ? 'Query AI...'
                  : `Ask ${activeSession?.toolType === 'claude-code' ? 'Claude' : activeSession?.toolType || 'AI'} about ${activeSession?.name || 'this session'}...`)
              : 'Run shell command...'
        }
        disabled={!activeSessionId}
        inputMode={(activeSession?.inputMode as InputMode) || 'ai'}
        onModeToggle={handleModeToggle}
        isSessionBusy={activeSession?.state === 'busy'}
        onInterrupt={handleInterrupt}
        onHistoryOpen={handleOpenHistory}
        recentCommands={
          getUniqueCommands(10)
            .filter(entry => entry.mode === activeSession?.inputMode)
            .slice(0, 5)
        }
        onSelectRecentCommand={handleSelectHistoryCommand}
        hasActiveSession={!!activeSessionId}
        cwd={activeSession?.cwd}
        slashCommands={allSlashCommands}
        onInputFocus={handleInputFocus}
        onInputBlur={handleInputBlur}
        showRecentCommands={!isSmallScreen}
      />

      {/* Command history drawer - swipe up from input area */}
      <CommandHistoryDrawer
        isOpen={showHistoryDrawer}
        onClose={handleCloseHistory}
        history={commandHistory}
        onSelectCommand={handleSelectHistoryCommand}
        onDeleteCommand={removeFromHistory}
        onClearHistory={clearHistory}
      />

      {/* Full-screen response viewer modal */}
      <ResponseViewer
        isOpen={showResponseViewer}
        response={selectedResponse}
        allResponses={allResponses.length > 1 ? allResponses : undefined}
        currentIndex={responseIndex}
        onNavigate={handleNavigateResponse}
        onClose={handleCloseResponseViewer}
        sessionName={activeSession?.name}
      />
    </div>
  );
}
