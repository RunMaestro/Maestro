/**
 * useSessions hook for Maestro web interface
 *
 * Provides real-time session state management for the web interface.
 * Uses the WebSocket connection to receive session updates and provides
 * methods to interact with sessions (send commands, interrupt, etc.).
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  useWebSocket,
  type SessionData,
  type UseWebSocketOptions,
  type UseWebSocketReturn,
  type WebSocketState,
} from './useWebSocket';
import type { Theme } from '../../shared/theme-types';

/**
 * Extended session data with client-side state
 */
export interface Session extends SessionData {
  /** Whether commands are currently being sent to this session */
  isSending?: boolean;
  /** Last error for this session */
  lastError?: string;
}

/**
 * Session state type (matches the desktop app's session states)
 * - idle: Ready/Green
 * - busy: Agent thinking/Yellow
 * - error: No connection/Red
 * - connecting: Pulsing Orange
 */
export type SessionState = 'idle' | 'busy' | 'error' | 'connecting';

/**
 * Input mode type
 * - ai: AI mode (interacting with AI agents)
 * - terminal: Command terminal mode
 */
export type InputMode = 'ai' | 'terminal';

/**
 * Options for the useSessions hook
 */
export interface UseSessionsOptions extends Omit<UseWebSocketOptions, 'handlers'> {
  /** Whether to automatically connect on mount */
  autoConnect?: boolean;
  /** Called when theme updates from server */
  onThemeUpdate?: (theme: Theme) => void;
  /** Called when sessions list changes */
  onSessionsChange?: (sessions: Session[]) => void;
  /** Called when active session changes */
  onActiveSessionChange?: (session: Session | null) => void;
  /** Called when an error occurs */
  onError?: (error: string) => void;
}

/**
 * Return type for the useSessions hook
 */
export interface UseSessionsReturn {
  /** All sessions */
  sessions: Session[];
  /** Sessions organized by group */
  sessionsByGroup: Record<string, Session[]>;
  /** Currently active/selected session */
  activeSession: Session | null;
  /** Set the active session by ID */
  setActiveSessionId: (sessionId: string | null) => void;
  /** Get a session by ID */
  getSession: (sessionId: string) => Session | undefined;

  /** WebSocket connection state */
  connectionState: WebSocketState;
  /** Whether connected and authenticated */
  isConnected: boolean;
  /** Connection error message */
  connectionError: string | null;
  /** Client ID assigned by server */
  clientId: string | null;

  /** Connect to the server */
  connect: () => void;
  /** Disconnect from the server */
  disconnect: () => void;
  /** Authenticate with a token */
  authenticate: (token: string) => void;

  /** Send a command to a session */
  sendCommand: (sessionId: string, command: string) => Promise<boolean>;
  /** Send a command to the active session */
  sendToActive: (command: string) => Promise<boolean>;
  /** Interrupt a session */
  interrupt: (sessionId: string) => Promise<boolean>;
  /** Interrupt the active session */
  interruptActive: () => Promise<boolean>;
  /** Switch session mode (AI/Terminal) */
  switchMode: (sessionId: string, mode: InputMode) => Promise<boolean>;

  /** Refresh the sessions list from the server */
  refreshSessions: () => void;

  /** The underlying WebSocket hook return (for advanced use) */
  ws: UseWebSocketReturn;
}

/**
 * useSessions hook for managing sessions in the Maestro web interface
 *
 * @example
 * ```tsx
 * function App() {
 *   const {
 *     sessions,
 *     activeSession,
 *     setActiveSessionId,
 *     sendToActive,
 *     isConnected,
 *     connect,
 *   } = useSessions({
 *     autoConnect: true,
 *     onThemeUpdate: (theme) => setTheme(theme),
 *   });
 *
 *   if (!isConnected) {
 *     return <button onClick={connect}>Connect</button>;
 *   }
 *
 *   return (
 *     <div>
 *       <SessionList
 *         sessions={sessions}
 *         activeSessionId={activeSession?.id}
 *         onSelect={setActiveSessionId}
 *       />
 *       <CommandInput
 *         onSubmit={(cmd) => sendToActive(cmd)}
 *         disabled={!activeSession}
 *       />
 *     </div>
 *   );
 * }
 * ```
 */
export function useSessions(options: UseSessionsOptions = {}): UseSessionsReturn {
  const {
    autoConnect = false,
    onThemeUpdate,
    onSessionsChange,
    onActiveSessionChange,
    onError,
    ...wsOptions
  } = options;

  // State
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(null);

  // Refs for callbacks to avoid stale closures
  const onThemeUpdateRef = useRef(onThemeUpdate);
  const onSessionsChangeRef = useRef(onSessionsChange);
  const onActiveSessionChangeRef = useRef(onActiveSessionChange);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onThemeUpdateRef.current = onThemeUpdate;
    onSessionsChangeRef.current = onSessionsChange;
    onActiveSessionChangeRef.current = onActiveSessionChange;
    onErrorRef.current = onError;
  }, [onThemeUpdate, onSessionsChange, onActiveSessionChange, onError]);

  /**
   * Handle full sessions list update
   */
  const handleSessionsUpdate = useCallback((newSessions: SessionData[]) => {
    setSessions((prev) => {
      // Preserve client-side state (isSending, lastError) from previous sessions
      const sessionsMap = new Map(prev.map((s) => [s.id, s]));
      const updated = newSessions.map((session) => {
        const existing = sessionsMap.get(session.id);
        return {
          ...session,
          isSending: existing?.isSending,
          lastError: existing?.lastError,
        };
      });
      return updated;
    });
    onSessionsChangeRef.current?.(sessions);
  }, [sessions]);

  /**
   * Handle individual session state change
   */
  const handleSessionStateChange = useCallback(
    (sessionId: string, state: string, additionalData?: Partial<SessionData>) => {
      setSessions((prev) => {
        const index = prev.findIndex((s) => s.id === sessionId);
        if (index === -1) return prev;

        const updated = [...prev];
        updated[index] = {
          ...updated[index],
          state,
          ...additionalData,
        };
        return updated;
      });
    },
    []
  );

  /**
   * Handle session added
   */
  const handleSessionAdded = useCallback((session: SessionData) => {
    setSessions((prev) => {
      // Check if session already exists
      if (prev.some((s) => s.id === session.id)) {
        return prev;
      }
      return [...prev, session];
    });
  }, []);

  /**
   * Handle session removed
   */
  const handleSessionRemoved = useCallback((sessionId: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));

    // If the removed session was active, clear the active session
    setActiveSessionIdState((currentActive) =>
      currentActive === sessionId ? null : currentActive
    );
  }, []);

  /**
   * Handle theme update from server
   */
  const handleThemeUpdate = useCallback((theme: Theme) => {
    onThemeUpdateRef.current?.(theme);
  }, []);

  /**
   * Handle errors
   */
  const handleError = useCallback((error: string) => {
    onErrorRef.current?.(error);
  }, []);

  // Initialize WebSocket with handlers
  const ws = useWebSocket({
    ...wsOptions,
    handlers: {
      onSessionsUpdate: handleSessionsUpdate,
      onSessionStateChange: handleSessionStateChange,
      onSessionAdded: handleSessionAdded,
      onSessionRemoved: handleSessionRemoved,
      onThemeUpdate: handleThemeUpdate,
      onError: handleError,
    },
  });

  // Auto-connect on mount if enabled
  useEffect(() => {
    if (autoConnect && ws.state === 'disconnected') {
      ws.connect();
    }
  }, [autoConnect, ws.state, ws.connect]);

  /**
   * Get the active session object
   */
  const activeSession = useMemo(() => {
    if (!activeSessionId) return null;
    return sessions.find((s) => s.id === activeSessionId) ?? null;
  }, [sessions, activeSessionId]);

  /**
   * Notify when active session changes
   */
  useEffect(() => {
    onActiveSessionChangeRef.current?.(activeSession);
  }, [activeSession]);

  /**
   * Set the active session by ID
   */
  const setActiveSessionId = useCallback((sessionId: string | null) => {
    setActiveSessionIdState(sessionId);
  }, []);

  /**
   * Get a session by ID
   */
  const getSession = useCallback(
    (sessionId: string): Session | undefined => {
      return sessions.find((s) => s.id === sessionId);
    },
    [sessions]
  );

  /**
   * Sessions organized by group (tool type as a simple grouping)
   */
  const sessionsByGroup = useMemo(() => {
    const groups: Record<string, Session[]> = {};
    for (const session of sessions) {
      const group = session.toolType || 'other';
      if (!groups[group]) {
        groups[group] = [];
      }
      groups[group].push(session);
    }
    return groups;
  }, [sessions]);

  /**
   * Get the base URL for API requests
   */
  const getApiBaseUrl = useCallback((): string => {
    return `${window.location.protocol}//${window.location.host}`;
  }, []);

  /**
   * Send a command to a session
   */
  const sendCommand = useCallback(
    async (sessionId: string, command: string): Promise<boolean> => {
      // Mark session as sending
      setSessions((prev) => {
        const index = prev.findIndex((s) => s.id === sessionId);
        if (index === -1) return prev;
        const updated = [...prev];
        updated[index] = { ...updated[index], isSending: true, lastError: undefined };
        return updated;
      });

      try {
        const response = await fetch(`${getApiBaseUrl()}/api/session/${sessionId}/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ command }),
        });

        const result = await response.json();

        if (!response.ok || !result.success) {
          throw new Error(result.error || 'Failed to send command');
        }

        // Clear sending state on success
        setSessions((prev) => {
          const index = prev.findIndex((s) => s.id === sessionId);
          if (index === -1) return prev;
          const updated = [...prev];
          updated[index] = { ...updated[index], isSending: false };
          return updated;
        });

        return true;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        // Set error state
        setSessions((prev) => {
          const index = prev.findIndex((s) => s.id === sessionId);
          if (index === -1) return prev;
          const updated = [...prev];
          updated[index] = { ...updated[index], isSending: false, lastError: errorMessage };
          return updated;
        });

        onErrorRef.current?.(errorMessage);
        return false;
      }
    },
    [getApiBaseUrl]
  );

  /**
   * Send a command to the active session
   */
  const sendToActive = useCallback(
    async (command: string): Promise<boolean> => {
      if (!activeSessionId) {
        onErrorRef.current?.('No active session');
        return false;
      }
      return sendCommand(activeSessionId, command);
    },
    [activeSessionId, sendCommand]
  );

  /**
   * Interrupt a session
   */
  const interrupt = useCallback(
    async (sessionId: string): Promise<boolean> => {
      try {
        const response = await fetch(`${getApiBaseUrl()}/api/session/${sessionId}/interrupt`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        });

        const result = await response.json();

        if (!response.ok || !result.success) {
          throw new Error(result.error || 'Failed to interrupt session');
        }

        return true;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        onErrorRef.current?.(errorMessage);
        return false;
      }
    },
    [getApiBaseUrl]
  );

  /**
   * Interrupt the active session
   */
  const interruptActive = useCallback(async (): Promise<boolean> => {
    if (!activeSessionId) {
      onErrorRef.current?.('No active session');
      return false;
    }
    return interrupt(activeSessionId);
  }, [activeSessionId, interrupt]);

  /**
   * Switch session mode (AI/Terminal)
   */
  const switchMode = useCallback(
    async (sessionId: string, mode: InputMode): Promise<boolean> => {
      // This would typically be sent via WebSocket or API
      // For now, we send it as a message via WebSocket
      return ws.send({
        type: 'switch_mode',
        sessionId,
        mode,
      });
    },
    [ws]
  );

  /**
   * Refresh the sessions list
   */
  const refreshSessions = useCallback(() => {
    ws.send({ type: 'get_sessions' });
  }, [ws]);

  return {
    // Session data
    sessions,
    sessionsByGroup,
    activeSession,
    setActiveSessionId,
    getSession,

    // Connection state
    connectionState: ws.state,
    isConnected: ws.isAuthenticated,
    connectionError: ws.error,
    clientId: ws.clientId,

    // Connection methods
    connect: ws.connect,
    disconnect: ws.disconnect,
    authenticate: ws.authenticate,

    // Session interaction methods
    sendCommand,
    sendToActive,
    interrupt,
    interruptActive,
    switchMode,
    refreshSessions,

    // Underlying WebSocket hook
    ws,
  };
}

export default useSessions;
