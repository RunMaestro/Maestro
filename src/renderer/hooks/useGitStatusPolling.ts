import { useState, useEffect, useRef, useCallback } from 'react';
import type { Session } from '../types';
import { gitService } from '../services/git';

/**
 * Return type for the useGitStatusPolling hook
 */
export interface UseGitStatusPollingReturn {
  /**
   * Map of session ID to git file change count.
   * Only sessions that are git repos will have entries.
   */
  gitFileCounts: Map<string, number>;
  /**
   * Manually trigger a refresh of git status for all sessions.
   * Useful when you know files have changed and want immediate feedback.
   */
  refreshGitStatus: () => Promise<void>;
}

/**
 * Configuration options for git status polling
 */
export interface UseGitStatusPollingOptions {
  /**
   * Polling interval in milliseconds.
   * Default: 30000 (30 seconds)
   */
  pollInterval?: number;
  /**
   * Whether to pause polling when document is hidden.
   * Default: true
   */
  pauseWhenHidden?: boolean;
  /**
   * Inactivity timeout in milliseconds. Polling stops after this duration
   * of no user activity and resumes when activity is detected.
   * Default: 60000 (60 seconds)
   */
  inactivityTimeout?: number;
}

const DEFAULT_POLL_INTERVAL = 30000; // 30 seconds
const DEFAULT_INACTIVITY_TIMEOUT = 60000; // 60 seconds

/**
 * Hook that polls git status for all git repository sessions.
 *
 * Features:
 * - Only polls sessions marked as git repos
 * - Pauses polling when the app is in background (document hidden)
 * - Pauses polling after user inactivity to save CPU
 * - Parallelizes git status calls for better performance
 * - Returns a map of session ID to changed file count
 *
 * CPU optimization: Polling stops after 60s of user inactivity and
 * resumes immediately when user activity is detected.
 *
 * Extracted from SessionList.tsx to reduce file size and improve maintainability.
 *
 * @param sessions - Array of all sessions to poll
 * @param options - Optional configuration for polling behavior
 * @returns Object containing gitFileCounts map and refreshGitStatus function
 */
export function useGitStatusPolling(
  sessions: Session[],
  options: UseGitStatusPollingOptions = {}
): UseGitStatusPollingReturn {
  const {
    pollInterval = DEFAULT_POLL_INTERVAL,
    pauseWhenHidden = true,
    inactivityTimeout = DEFAULT_INACTIVITY_TIMEOUT,
  } = options;

  const [gitFileCounts, setGitFileCounts] = useState<Map<string, number>>(new Map());

  // Use ref to track sessions to avoid stale closure issues in interval callback
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // Activity tracking refs
  const lastActivityRef = useRef<number>(Date.now());
  const isActiveRef = useRef<boolean>(true);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Poll git status for all Git sessions
  const pollGitStatus = useCallback(async () => {
    // Skip polling if document is hidden (app in background)
    if (pauseWhenHidden && document.hidden) return;

    const gitSessions = sessionsRef.current.filter(s => s.isGitRepo);
    if (gitSessions.length === 0) return;

    // Parallelize git status calls for better performance
    // Sequential calls with 10 sessions = 1-2s, parallel = 200-300ms
    const results = await Promise.all(
      gitSessions.map(async (session) => {
        try {
          const cwd = session.inputMode === 'terminal'
            ? (session.shellCwd || session.cwd)
            : session.cwd;
          const status = await gitService.getStatus(cwd);
          return [session.id, status.files.length] as const;
        } catch {
          return null;
        }
      })
    );

    const newCounts = new Map<string, number>();
    for (const result of results) {
      if (result) {
        newCounts.set(result[0], result[1]);
      }
    }

    setGitFileCounts(newCounts);
  }, [pauseWhenHidden]);

  const startPolling = useCallback(() => {
    if (!intervalRef.current && !document.hidden) {
      pollGitStatus();
      intervalRef.current = setInterval(() => {
        const now = Date.now();
        const timeSinceLastActivity = now - lastActivityRef.current;

        // Check if user is still active
        if (timeSinceLastActivity < inactivityTimeout) {
          pollGitStatus();
        } else {
          // User inactive - stop polling to save CPU
          isActiveRef.current = false;
          if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
        }
      }, pollInterval);
    }
  }, [pollInterval, inactivityTimeout, pollGitStatus]);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // Handle visibility changes
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopPolling();
      } else if (isActiveRef.current) {
        startPolling();
      }
    };

    if (pauseWhenHidden) {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      if (pauseWhenHidden) {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
  }, [pauseWhenHidden, startPolling, stopPolling]);

  // Listen for user activity to restart polling if inactive
  useEffect(() => {
    const handleActivity = () => {
      lastActivityRef.current = Date.now();
      const wasInactive = !isActiveRef.current;
      isActiveRef.current = true;

      // Restart polling if it was stopped due to inactivity
      if (wasInactive && !document.hidden) {
        startPolling();
      }
    };

    window.addEventListener('keydown', handleActivity);
    window.addEventListener('mousedown', handleActivity);
    window.addEventListener('wheel', handleActivity);
    window.addEventListener('touchstart', handleActivity);

    return () => {
      window.removeEventListener('keydown', handleActivity);
      window.removeEventListener('mousedown', handleActivity);
      window.removeEventListener('wheel', handleActivity);
      window.removeEventListener('touchstart', handleActivity);
    };
  }, [startPolling]);

  // Initial start and cleanup
  useEffect(() => {
    if (!pauseWhenHidden || !document.hidden) {
      startPolling();
    }

    return () => {
      stopPolling();
    };
  }, [pauseWhenHidden, startPolling, stopPolling]);

  return {
    gitFileCounts,
    refreshGitStatus: pollGitStatus,
  };
}
