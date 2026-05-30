/**
 * useGitStatus hook for git status and diff information from the web client.
 *
 * Provides git status and diff loading via WebSocket request-response,
 * with auto-load on sessionId changes.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { UseWebSocketReturn } from './useWebSocket';

/**
 * Git file status entry.
 */
export interface GitStatusFile {
	path: string;
	status: string;
	staged: boolean;
}

/**
 * Git status result from the server.
 */
export interface GitStatusResult {
	branch: string;
	files: GitStatusFile[];
	ahead: number;
	behind: number;
}

/**
 * Git diff result from the server.
 */
export interface GitDiffResult {
	diff: string;
	files: string[];
}

/**
 * Return value from useGitStatus hook.
 */
export interface UseGitStatusReturn {
	status: GitStatusResult | null;
	diff: GitDiffResult | null;
	isLoading: boolean;
	loadStatus: (sessionId: string) => Promise<void>;
	loadDiff: (sessionId: string, filePath?: string) => Promise<void>;
	refresh: (sessionId: string) => Promise<void>;
}

/**
 * Hook for managing git status and diff state via WebSocket.
 *
 * @param sendRequest - WebSocket sendRequest function for request-response operations
 * @param isConnected - Whether the WebSocket is currently connected
 * @param sessionId - Optional session ID to auto-load status when it changes
 */
export function useGitStatus(
	sendRequest: UseWebSocketReturn['sendRequest'],
	isConnected: boolean,
	sessionId?: string
): UseGitStatusReturn {
	const [status, setStatus] = useState<GitStatusResult | null>(null);
	const [diff, setDiff] = useState<GitDiffResult | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const lastSessionIdRef = useRef<string | undefined>(undefined);

	/**
	 * Load git status for a session.
	 */
	const loadStatus = useCallback(
		async (sid: string): Promise<void> => {
			if (!isConnected) return;

			setIsLoading(true);
			try {
				const response = await sendRequest<{ status?: GitStatusResult }>('get_git_status', {
					sessionId: sid,
				});
				if (response.status) {
					setStatus(response.status);
				}
			} catch {
				// Status fetch failed — will retry on next call
			} finally {
				setIsLoading(false);
			}
		},
		[sendRequest, isConnected]
	);

	/**
	 * Load git diff for a session, optionally for a specific file.
	 */
	const loadDiff = useCallback(
		async (sid: string, filePath?: string): Promise<void> => {
			if (!isConnected) return;

			setIsLoading(true);
			try {
				const response = await sendRequest<{ diff?: GitDiffResult }>('get_git_diff', {
					sessionId: sid,
					filePath,
				});
				if (response.diff) {
					setDiff(response.diff);
				}
			} catch {
				// Diff fetch failed — will retry on next call
			} finally {
				setIsLoading(false);
			}
		},
		[sendRequest, isConnected]
	);

	/**
	 * Refresh both status and diff for a session.
	 */
	const refresh = useCallback(
		async (sid: string): Promise<void> => {
			if (!isConnected) return;

			setIsLoading(true);
			try {
				const [statusResponse, diffResponse] = await Promise.all([
					sendRequest<{ status?: GitStatusResult }>('get_git_status', { sessionId: sid }),
					sendRequest<{ diff?: GitDiffResult }>('get_git_diff', { sessionId: sid }),
				]);
				if (statusResponse.status) {
					setStatus(statusResponse.status);
				}
				if (diffResponse.diff) {
					setDiff(diffResponse.diff);
				}
			} catch {
				// Refresh failed — will retry on next call
			} finally {
				setIsLoading(false);
			}
		},
		[sendRequest, isConnected]
	);

	// Auto-load status when sessionId changes
	useEffect(() => {
		if (!isConnected || !sessionId) {
			return;
		}
		if (lastSessionIdRef.current === sessionId) {
			return;
		}

		lastSessionIdRef.current = sessionId;
		setStatus(null);
		setDiff(null);
		loadStatus(sessionId);
	}, [isConnected, sessionId, loadStatus]);

	return {
		status,
		diff,
		isLoading,
		loadStatus,
		loadDiff,
		refresh,
	};
}

export default useGitStatus;
