import { useState, useEffect, useRef, useCallback } from 'react';
import type { Session } from '../types';
import { gitService } from '../services/git';

/**
 * Extended git status data for a session.
 * Includes file count (for all sessions) and detailed info (for active session).
 */
export interface GitStatusData {
  /** Number of changed files from git status --porcelain */
  fileCount: number;
  /** Current branch name */
  branch?: string;
  /** Remote URL (origin) */
  remote?: string;
  /** Number of commits behind upstream */
  behind: number;
  /** Number of commits ahead of upstream */
  ahead: number;
  /** Detailed file changes with line additions/deletions (active session only) */
  fileChanges?: GitFileChange[];
  /** Total line additions across all files */
  totalAdditions: number;
  /** Total line deletions across all files */
  totalDeletions: number;
  /** Number of modified files */
  modifiedCount: number;
  /** Timestamp when this data was last updated */
  lastUpdated: number;
}

/**
 * Individual file change with line-level statistics
 */
export interface GitFileChange {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  modified: boolean;
}

/**
 * Return type for the useGitStatusPolling hook
 */
export interface UseGitStatusPollingReturn {
  /**
   * Map of session ID to git status data.
   * Only sessions that are git repos will have entries.
   */
  gitStatusMap: Map<string, GitStatusData>;
  /**
   * Manually trigger a refresh of git status for all sessions.
   * Useful when you know files have changed and want immediate feedback.
   */
  refreshGitStatus: () => Promise<void>;
  /**
   * Whether the hook is currently loading data
   */
  isLoading: boolean;
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
  /**
   * ID of the currently active session. Extended data (numstat, branch info)
   * will be fetched for this session.
   */
  activeSessionId?: string;
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
 * - Returns comprehensive git data: file counts, branch, ahead/behind, numstat
 * - Fetches detailed numstat data only for the active session (optimization)
 *
 * CPU optimization: Polling stops after 60s of user inactivity and
 * resumes immediately when user activity is detected.
 *
 * Consolidates git polling that was previously scattered across:
 * - SessionList.tsx (file counts)
 * - MainPanel.tsx (branch, remote, ahead/behind)
 * - GitStatusWidget.tsx (numstat file changes)
 *
 * @param sessions - Array of all sessions to poll
 * @param options - Optional configuration for polling behavior
 * @returns Object containing gitStatusMap, refreshGitStatus function, and isLoading state
 */
export function useGitStatusPolling(
  sessions: Session[],
  options: UseGitStatusPollingOptions = {}
): UseGitStatusPollingReturn {
  const {
    pollInterval = DEFAULT_POLL_INTERVAL,
    pauseWhenHidden = true,
    inactivityTimeout = DEFAULT_INACTIVITY_TIMEOUT,
    activeSessionId,
  } = options;

  const [gitStatusMap, setGitStatusMap] = useState<Map<string, GitStatusData>>(new Map());
  const [isLoading, setIsLoading] = useState(false);

  // Use ref to track sessions to avoid stale closure issues in interval callback
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // Track active session ID
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  // Activity tracking refs
  const lastActivityRef = useRef<number>(Date.now());
  const isActiveRef = useRef<boolean>(true);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Poll git status for all Git sessions
  const pollGitStatus = useCallback(async () => {
    // Skip polling if document is hidden (app in background)
    if (pauseWhenHidden && document.hidden) return;

    const gitSessions = sessionsRef.current.filter(s => s.isGitRepo);
    if (gitSessions.length === 0) {
      setGitStatusMap(prev => (prev.size === 0 ? prev : new Map()));
      return;
    }

    setIsLoading(true);

    try {
      const currentActiveSessionId = activeSessionIdRef.current;

      // Parallelize git status calls for better performance
      // Sequential calls with 10 sessions = 1-2s, parallel = 200-300ms
      const results = await Promise.all(
        gitSessions.map(async (session) => {
          try {
            const cwd = session.inputMode === 'terminal'
              ? (session.shellCwd || session.cwd)
              : session.cwd;

            const isActiveSession = session.id === currentActiveSessionId;

            // For non-active sessions, just get basic status (file count)
            if (!isActiveSession) {
              const status = await gitService.getStatus(cwd);
              const statusData: GitStatusData = {
                fileCount: status.files.length,
                branch: status.branch,
                behind: 0,
                ahead: 0,
                totalAdditions: 0,
                totalDeletions: 0,
                modifiedCount: 0,
                lastUpdated: Date.now(),
              };
              return [session.id, statusData] as const;
            }

            // For active session, get comprehensive data including numstat
            // Use git:info for branch/remote/ahead/behind (single IPC call, 4 parallel git commands)
            // Plus get detailed file changes with numstat
            const [gitInfo, status, numstat] = await Promise.all([
              window.maestro.git.info(cwd),
              gitService.getStatus(cwd),
              gitService.getNumstat(cwd),
            ]);

            // Create a map of path -> numstat data
            const numstatMap = new Map<string, { additions: number; deletions: number }>();
            numstat.files.forEach(file => {
              numstatMap.set(file.path, { additions: file.additions, deletions: file.deletions });
            });

            // Parse porcelain format and merge with numstat
            const fileChanges: GitFileChange[] = [];
            let totalAdditions = 0;
            let totalDeletions = 0;
            let modifiedCount = 0;

            status.files.forEach(file => {
              const statusCode = file.status.trim();
              const indexStatus = statusCode[0];
              const workingStatus = statusCode[1] || ' ';
              const stats = numstatMap.get(file.path) || { additions: 0, deletions: 0 };

              const change: GitFileChange = {
                path: file.path,
                status: statusCode,
                additions: stats.additions,
                deletions: stats.deletions,
                modified: false
              };

              // Accumulate totals
              totalAdditions += stats.additions;
              totalDeletions += stats.deletions;

              // Check for modifications
              if (indexStatus === 'M' || workingStatus === 'M' || indexStatus === 'R' || workingStatus === 'R') {
                change.modified = true;
                modifiedCount++;
              }

              fileChanges.push(change);
            });

            const statusData: GitStatusData = {
              fileCount: status.files.length,
              branch: gitInfo.branch,
              remote: gitInfo.remote,
              behind: gitInfo.behind,
              ahead: gitInfo.ahead,
              fileChanges,
              totalAdditions,
              totalDeletions,
              modifiedCount,
              lastUpdated: Date.now(),
            };

            return [session.id, statusData] as const;
          } catch {
            return null;
          }
        })
      );

      const newStatusMap = new Map<string, GitStatusData>();
      for (const result of results) {
        if (result) {
          newStatusMap.set(result[0], result[1]);
        }
      }

      setGitStatusMap(newStatusMap);
    } finally {
      setIsLoading(false);
    }
  }, [pauseWhenHidden]);

  const startPolling = useCallback(() => {
    if (!intervalRef.current && (!pauseWhenHidden || !document.hidden)) {
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
      if (wasInactive && (!pauseWhenHidden || !document.hidden)) {
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

  // Refresh immediately when active session changes to get detailed data
  useEffect(() => {
    if (activeSessionId) {
      pollGitStatus();
    }
  }, [activeSessionId, pollGitStatus]);

  return {
    gitStatusMap,
    refreshGitStatus: pollGitStatus,
    isLoading,
  };
}
