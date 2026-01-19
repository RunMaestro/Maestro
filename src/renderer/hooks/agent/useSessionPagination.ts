import { useState, useRef, useCallback, useEffect } from 'react';
import type { ClaudeSession } from './useSessionViewer';

/**
 * Dependencies for the useSessionPagination hook.
 */
export interface UseSessionPaginationDeps {
	/** Project path for loading sessions (use projectRoot, not cwd, for consistent session storage access) */
	projectPath: string | undefined;
	/** Agent ID for the session (e.g., 'claude-code', 'opencode') */
	agentId?: string;
	/** Callback to update starred sessions from origins data */
	onStarredSessionsLoaded?: (starredIds: Set<string>) => void;
	/** Optional SSH remote ID for accessing sessions on a remote host */
	sshRemoteId?: string;
}

/**
 * Return type for the useSessionPagination hook.
 */
export interface UseSessionPaginationReturn {
	/** List of loaded sessions */
	sessions: ClaudeSession[];
	/** Whether initial loading is in progress */
	loading: boolean;
	/** Whether there are more sessions to load */
	hasMoreSessions: boolean;
	/** Whether additional sessions are currently being loaded */
	isLoadingMoreSessions: boolean;
	/** Total count of sessions available */
	totalSessionCount: number;
	/** Load more sessions (triggered manually or by scroll) */
	loadMoreSessions: () => Promise<void>;
	/** Handle scroll event to trigger pagination at 70% */
	handleSessionsScroll: () => void;
	/** Ref for the sessions container div */
	sessionsContainerRef: React.RefObject<HTMLDivElement>;
	/** Update a session in the list (e.g., after rename) */
	updateSession: (sessionId: string, updates: Partial<ClaudeSession>) => void;
	/** Set sessions directly (for external updates) */
	setSessions: React.Dispatch<React.SetStateAction<ClaudeSession[]>>;
}

/**
 * Hook for managing paginated session loading in AgentSessionsBrowser.
 *
 * Features:
 * - Initial load of sessions with cursor-based pagination
 * - Auto-load remaining sessions in background after initial load
 * - Scroll-triggered loading at 70% scroll position
 * - Progressive stats fetching
 * - Session origins loading for starred status
 *
 * @example
 * ```tsx
 * const {
 *   sessions,
 *   loading,
 *   hasMoreSessions,
 *   isLoadingMoreSessions,
 *   totalSessionCount,
 *   handleSessionsScroll,
 *   sessionsContainerRef,
 *   updateSession,
 * } = useSessionPagination({
 *   projectPath: activeSession?.projectRoot,
 *   onStarredSessionsLoaded: setStarredSessions,
 * });
 * ```
 */
export function useSessionPagination({
	projectPath,
	agentId = 'claude-code',
	onStarredSessionsLoaded,
	sshRemoteId,
}: UseSessionPaginationDeps): UseSessionPaginationReturn {
	// Session list state
	const [sessions, setSessions] = useState<ClaudeSession[]>([]);
	const [loading, setLoading] = useState(true);

	// Pagination state
	const [hasMoreSessions, setHasMoreSessions] = useState(false);
	const [isLoadingMoreSessions, setIsLoadingMoreSessions] = useState(false);
	const [totalSessionCount, setTotalSessionCount] = useState(0);
	const nextCursorRef = useRef<string | null>(null);

	// Container ref for scroll handling
	const sessionsContainerRef = useRef<HTMLDivElement>(null);

	// Store origins map for merging into paginated results
	const originsMapRef = useRef<
		Map<string, { origin?: string; sessionName?: string; starred?: boolean }>
	>(new Map());

	// Load sessions on mount or when projectPath/agentId changes
	useEffect(() => {
		// Reset pagination state
		setSessions([]);
		setHasMoreSessions(false);
		setTotalSessionCount(0);
		nextCursorRef.current = null;

		const loadSessions = async () => {
			if (!projectPath) {
				setLoading(false);
				return;
			}

			try {
				// Load session metadata (starred status, sessionName) from session origins
				const originsMap = new Map<
					string,
					{ origin?: string; sessionName?: string; starred?: boolean }
				>();
				const starredFromOrigins = new Set<string>();

				if (agentId === 'claude-code') {
					// Claude Code uses its own origins store (claude:getSessionOrigins)
					const origins = await window.maestro.claude.getSessionOrigins(projectPath);
					for (const [sessionId, originData] of Object.entries(origins)) {
						if (typeof originData === 'object') {
							if (originData?.starred) {
								starredFromOrigins.add(sessionId);
							}
							originsMap.set(sessionId, originData);
						} else if (typeof originData === 'string') {
							originsMap.set(sessionId, { origin: originData });
						}
					}
				} else {
					// Other agents (Codex, OpenCode, etc.) use the generic origins store
					const origins = await window.maestro.agentSessions.getOrigins(agentId, projectPath);
					for (const [sessionId, originData] of Object.entries(origins)) {
						if (originData?.starred) {
							starredFromOrigins.add(sessionId);
						}
						originsMap.set(sessionId, originData);
					}
				}

				onStarredSessionsLoaded?.(starredFromOrigins);

				// Store for use in loadMoreSessions
				originsMapRef.current = originsMap;

				// Use generic agentSessions API with agentId parameter for paginated loading
				// Pass sshRemoteId for SSH remote session access
				const result = await window.maestro.agentSessions.listPaginated(
					agentId,
					projectPath,
					{ limit: 100 },
					sshRemoteId
				);

				// Merge origins data (sessionName, starred) into sessions
				// Type cast to ClaudeSession since the API returns compatible data
				const sessionsWithOrigins: ClaudeSession[] = result.sessions.map((session) => {
					const originData = originsMapRef.current.get(session.sessionId);
					return {
						...session,
						sessionName: originData?.sessionName || session.sessionName,
						starred: originData?.starred || session.starred,
						origin: (originData?.origin || session.origin) as 'user' | 'auto' | undefined,
					};
				});

				setSessions(sessionsWithOrigins);
				setHasMoreSessions(result.hasMore);
				setTotalSessionCount(result.totalCount);
				nextCursorRef.current = result.nextCursor;

				// Start fetching aggregate stats for ALL sessions (runs in background with progressive updates)
				// Note: Stats tracking is currently Claude-specific; other agents will need their own implementation
				if (agentId === 'claude-code') {
					window.maestro.claude.getProjectStats(projectPath);
				}
			} catch (error) {
				console.error('Failed to load sessions:', error);
			} finally {
				setLoading(false);
			}
		};

		loadSessions();
	}, [projectPath, agentId, onStarredSessionsLoaded, sshRemoteId]);

	// Load more sessions when scrolling near bottom
	const loadMoreSessions = useCallback(async () => {
		if (!projectPath || !hasMoreSessions || isLoadingMoreSessions || !nextCursorRef.current) return;

		setIsLoadingMoreSessions(true);
		try {
			// Use generic agentSessions API with agentId parameter
			// Pass sshRemoteId for SSH remote session access
			const result = await window.maestro.agentSessions.listPaginated(
				agentId,
				projectPath,
				{
					cursor: nextCursorRef.current,
					limit: 100,
				},
				sshRemoteId
			);

			// Merge origins data (sessionName, starred) into new sessions
			// Type cast to ClaudeSession since the API returns compatible data
			const sessionsWithOrigins: ClaudeSession[] = result.sessions.map((session) => {
				const originData = originsMapRef.current.get(session.sessionId);
				return {
					...session,
					sessionName: originData?.sessionName || session.sessionName,
					starred: originData?.starred || session.starred,
					origin: (originData?.origin || session.origin) as 'user' | 'auto' | undefined,
				};
			});

			// Append new sessions, avoiding duplicates
			setSessions((prev) => {
				const existingIds = new Set(prev.map((s) => s.sessionId));
				const newSessions = sessionsWithOrigins.filter((s) => !existingIds.has(s.sessionId));
				return [...prev, ...newSessions];
			});
			setHasMoreSessions(result.hasMore);
			nextCursorRef.current = result.nextCursor;
		} catch (error) {
			console.error('Failed to load more sessions:', error);
		} finally {
			setIsLoadingMoreSessions(false);
		}
	}, [projectPath, agentId, hasMoreSessions, isLoadingMoreSessions, sshRemoteId]);

	// Handle scroll for sessions list pagination - load more at 70% scroll
	const handleSessionsScroll = useCallback(() => {
		const container = sessionsContainerRef.current;
		if (!container) return;

		const { scrollTop, scrollHeight, clientHeight } = container;
		const scrollPercentage = (scrollTop + clientHeight) / scrollHeight;
		const atSeventyPercent = scrollPercentage >= 0.7;

		if (atSeventyPercent && hasMoreSessions && !isLoadingMoreSessions) {
			loadMoreSessions();
		}
	}, [hasMoreSessions, isLoadingMoreSessions, loadMoreSessions]);

	// Ref to track the last loaded session count to avoid duplicate triggers
	const lastLoadedCountRef = useRef(0);

	// Auto-load ALL remaining sessions in background after initial load
	// This ensures full search capability and accurate stats
	useEffect(() => {
		// Only trigger if we have more sessions and conditions are right
		if (!loading && !isLoadingMoreSessions && hasMoreSessions && sessions.length > 0) {
			// Check if sessions.length actually increased since last load
			// This prevents infinite loop when no new sessions are added
			if (sessions.length === lastLoadedCountRef.current) {
				// No new sessions were added, don't try to load more
				return;
			}
			lastLoadedCountRef.current = sessions.length;

			// Small delay to let UI render first, then continue loading
			const timer = setTimeout(() => {
				loadMoreSessions();
			}, 50);
			return () => clearTimeout(timer);
		}
	}, [loading, isLoadingMoreSessions, hasMoreSessions, sessions.length, loadMoreSessions]);

	// Reset the last loaded count when projectPath, agentId, or sshRemoteId changes
	useEffect(() => {
		lastLoadedCountRef.current = 0;
	}, [projectPath, agentId, sshRemoteId]);

	// Update a specific session in the list
	const updateSession = useCallback((sessionId: string, updates: Partial<ClaudeSession>) => {
		setSessions((prev) => prev.map((s) => (s.sessionId === sessionId ? { ...s, ...updates } : s)));
	}, []);

	return {
		sessions,
		loading,
		hasMoreSessions,
		isLoadingMoreSessions,
		totalSessionCount,
		loadMoreSessions,
		handleSessionsScroll,
		sessionsContainerRef,
		updateSession,
		setSessions,
	};
}
