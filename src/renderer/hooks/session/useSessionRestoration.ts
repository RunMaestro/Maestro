/**
 * useSessionRestoration — extracted from App.tsx (Phase 2E)
 *
 * Owns session loading, restoration, migration, and corruption recovery.
 * Reads from Zustand stores directly — no parameters needed.
 *
 * Functions:
 *   - restoreSession: migrates legacy fields, recovers corrupted data, resets runtime state
 *   - fetchGitInfoInBackground: async git info fetch for SSH remote sessions
 *
 * Effects:
 *   - Session & group loading on mount (with React Strict Mode guard)
 *   - Sets initialLoadComplete + sessionsLoaded flags for splash coordination
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Session, SessionState, ToolType, LogEntry } from '../../types';
import { useSessionStore } from '../../stores/sessionStore';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { gitService } from '../../services/git';
import { generateId } from '../../utils/ids';
import { AUTO_RUN_FOLDER_NAME } from '../../components/Wizard';

// ============================================================================
// Return type
// ============================================================================

export interface SessionRestorationReturn {
	/** Proxy ref that bridges .current API to sessionStore boolean */
	initialLoadComplete: React.MutableRefObject<boolean>;
	/** Restore a persisted session (migration + corruption recovery + runtime reset) */
	restoreSession: (session: Session) => Promise<Session>;
	/** Fetch git info in background for SSH remote sessions */
	fetchGitInfoInBackground: (
		sessionId: string,
		cwd: string,
		sshRemoteId: string | undefined
	) => Promise<void>;
}

// ============================================================================
// Hook
// ============================================================================

export function useSessionRestoration(): SessionRestorationReturn {
	// --- Store actions (stable, non-reactive) ---
	// Extract action references once via useMemo so they can be called inside
	// useCallback/useEffect without appearing in dependency arrays. Zustand
	// store actions returned by getState() are stable singletons that never
	// change, so the empty deps array is intentional.
	const { setSessions, setGroups, setActiveSessionId, setSessionsLoaded } = useMemo(
		() => useSessionStore.getState(),
		[]
	);
	const { setGroupChats } = useMemo(() => useGroupChatStore.getState(), []);

	// --- initialLoadComplete proxy ref ---
	// Bridges ref API (.current = true) to store boolean so both ref-style
	// and store-style consumers stay in sync.
	const initialLoadComplete = useMemo(() => {
		const ref = { current: useSessionStore.getState().initialLoadComplete };
		return new Proxy(ref, {
			set(_target, prop, value) {
				if (prop === 'current') {
					ref.current = value;
					useSessionStore.getState().setInitialLoadComplete(value);
					return true;
				}
				return false;
			},
			get(target, prop) {
				if (prop === 'current') {
					return useSessionStore.getState().initialLoadComplete;
				}
				return (target as Record<string | symbol, unknown>)[prop];
			},
		});
	}, []) as React.MutableRefObject<boolean>;

	// --- validateAgentInBackground ---
	// Checks agent availability without blocking session restoration.
	// If the agent is unavailable, marks the session with error state.
	// Called after splash hides — never blocks startup.
	const validateAgentInBackground = useCallback(
		async (sessionId: string, toolType: string, sshRemoteId: string | undefined) => {
			try {
				const agent = await window.maestro.agents.get(toolType, sshRemoteId);
				if (!agent) {
					console.error(`[validateAgentInBackground] Agent not found for toolType: ${toolType}`);
					setSessions((prev) =>
						prev.map((s) =>
							s.id === sessionId
								? {
										...s,
										aiPid: -1,
										state: 'error' as SessionState,
									}
								: s
						)
					);
				}
			} catch (err) {
				// IPC failures are treated as transient (e.g. main process still
				// starting). We don't mark the session as 'error' here because the
				// agent may become available shortly after splash completes.
				console.warn(`[validateAgentInBackground] Agent validation failed for ${toolType}:`, err);
			}
		},
		[]
	);

	// --- fetchGitInfoInBackground ---
	const fetchGitInfoInBackground = useCallback(
		async (sessionId: string, cwd: string, sshRemoteId: string | undefined) => {
			try {
				const isGitRepo = await gitService.isRepo(cwd, sshRemoteId);

				let gitBranches: string[] | undefined;
				let gitTags: string[] | undefined;
				let gitRefsCacheTime: number | undefined;
				if (isGitRepo) {
					[gitBranches, gitTags] = await Promise.all([
						gitService.getBranches(cwd, sshRemoteId),
						gitService.getTags(cwd, sshRemoteId),
					]);
					gitRefsCacheTime = Date.now();
				}

				setSessions((prev) =>
					prev.map((s) =>
						s.id === sessionId
							? {
									...s,
									isGitRepo,
									gitBranches,
									gitTags,
									gitRefsCacheTime,
									sshConnectionFailed: false,
								}
							: s
					)
				);
			} catch (error) {
				console.warn(
					`[fetchGitInfoInBackground] Failed to fetch git info for session ${sessionId}:`,
					error
				);
				setSessions((prev) =>
					prev.map((s) => (s.id === sessionId ? { ...s, sshConnectionFailed: true } : s))
				);
			}
		},
		[]
	);

	// --- restoreSession ---
	const restoreSession = useCallback(async (session: Session): Promise<Session> => {
		try {
			// Migration: ensure projectRoot is set (for sessions created before this field was added)
			if (!session.projectRoot) {
				session = { ...session, projectRoot: session.cwd };
			}

			// Migration: default autoRunFolderPath for sessions that don't have one
			if (!session.autoRunFolderPath && session.projectRoot) {
				session = {
					...session,
					autoRunFolderPath: `${session.projectRoot}/${AUTO_RUN_FOLDER_NAME}`,
				};
			}

			// Migration: ensure fileTreeAutoRefreshInterval is set (default 180s for legacy sessions)
			if (session.fileTreeAutoRefreshInterval == null) {
				console.warn(
					`[restoreSession] Session missing fileTreeAutoRefreshInterval, defaulting to 180s`
				);
				session = { ...session, fileTreeAutoRefreshInterval: 180 };
			}

			// Sessions must have aiTabs - if missing, this is a data corruption issue
			// Create a default tab to prevent crashes when code calls .find() on aiTabs
			if (!session.aiTabs || session.aiTabs.length === 0) {
				console.error(
					'[restoreSession] Session has no aiTabs - data corruption, creating default tab:',
					session.id
				);
				const defaultTabId = generateId();
				return {
					...session,
					aiPid: -1,
					terminalPid: 0,
					state: 'error' as SessionState,
					isLive: false,
					liveUrl: undefined,
					aiTabs: [
						{
							id: defaultTabId,
							agentSessionId: null,
							name: null,
							state: 'idle' as const,
							logs: [
								{
									id: generateId(),
									timestamp: Date.now(),
									source: 'system' as const,
									text: '⚠️ Session data was corrupted and has been recovered with a new tab.',
								},
							],
							starred: false,
							inputValue: '',
							stagedImages: [],
							createdAt: Date.now(),
						},
					],
					activeTabId: defaultTabId,
					filePreviewTabs: [],
					activeFileTabId: null,
					unifiedTabOrder: [{ type: 'ai' as const, id: defaultTabId }],
					unifiedClosedTabHistory: [],
				};
			}

			// Fix inconsistency: activeFileTabId should only be set in AI mode.
			// If inputMode is 'terminal' but a file tab is still active, clear it to prevent
			// rendering a file preview without a tab bar (orphaned file preview bug).
			if (session.inputMode !== 'ai' && session.activeFileTabId) {
				console.warn(
					`[restoreSession] Session has activeFileTabId='${session.activeFileTabId}' but inputMode='${session.inputMode}' — clearing orphaned file tab reference`
				);
				session = { ...session, activeFileTabId: null };
			}

			// Detect and fix inputMode/toolType mismatch
			let correctedSession = { ...session };
			let aiAgentType = correctedSession.toolType;

			// If toolType is 'terminal', migrate to claude-code
			if (aiAgentType === 'terminal') {
				console.warn(`[restoreSession] Session has toolType='terminal', migrating to claude-code`);
				aiAgentType = 'claude-code' as ToolType;
				correctedSession = {
					...correctedSession,
					toolType: 'claude-code' as ToolType,
				};

				const warningLog: LogEntry = {
					id: generateId(),
					timestamp: Date.now(),
					source: 'system',
					text: '⚠️ Session migrated to use Claude Code agent.',
				};
				const activeTabIndex = correctedSession.aiTabs.findIndex(
					(tab) => tab.id === correctedSession.activeTabId
				);
				if (activeTabIndex >= 0) {
					correctedSession.aiTabs = correctedSession.aiTabs.map((tab, i) =>
						i === activeTabIndex ? { ...tab, logs: [...tab.logs, warningLog] } : tab
					);
				}
			}

			// Agent detection is deferred to background (see loadSessionsAndGroups)
			// to avoid blocking splash screen on slow SSH or binary lookups.
			// AI processes are NOT started during restore anyway - aiPid stays
			// at 0 until the user sends their first message.

			// Get SSH remote ID for remote git operations
			const sshRemoteId =
				correctedSession.sshRemoteId ||
				(correctedSession.sessionSshRemoteConfig?.enabled
					? correctedSession.sessionSshRemoteConfig.remoteId
					: undefined) ||
				undefined;

			const isRemoteSession = !!sshRemoteId;

			// For local sessions, fetch git info with a timeout to prevent
			// slow/unreachable filesystems from blocking the splash screen.
			// For remote sessions, use persisted values and update in background.
			let isGitRepo = correctedSession.isGitRepo ?? false;
			let gitBranches = correctedSession.gitBranches;
			let gitTags = correctedSession.gitTags;
			let gitRefsCacheTime = correctedSession.gitRefsCacheTime;

			if (!isRemoteSession) {
				const GIT_TIMEOUT_MS = 5000;
				// NOTE: On timeout, the inner git operations continue running in the
				// background until the OS/filesystem eventually resolves/rejects them.
				// This is a known trade-off of Promise.race — Promises are not cancellable.
				try {
					const gitResult = await Promise.race([
						(async () => {
							const repoCheck = await gitService.isRepo(correctedSession.cwd, undefined);
							if (!repoCheck) return { isGitRepo: false } as const;
							const [branches, tags] = await Promise.all([
								gitService.getBranches(correctedSession.cwd, undefined),
								gitService.getTags(correctedSession.cwd, undefined),
							]);
							return { isGitRepo: true, branches, tags } as const;
						})(),
						new Promise<null>((resolve) => setTimeout(() => resolve(null), GIT_TIMEOUT_MS)),
					]);
					if (gitResult) {
						isGitRepo = gitResult.isGitRepo;
						if (gitResult.isGitRepo) {
							gitBranches = gitResult.branches;
							gitTags = gitResult.tags;
							gitRefsCacheTime = Date.now();
						}
					} else {
						console.warn(
							`[restoreSession] Git info timed out after ${GIT_TIMEOUT_MS}ms for ${correctedSession.cwd}, using persisted values`
						);
					}
				} catch (err) {
					console.warn('[restoreSession] Git info failed, using persisted values:', err);
				}
			}

			// Migration: ensure terminalTabs exists (may be empty — terminals are created on demand)
			if (!correctedSession.terminalTabs) {
				correctedSession = {
					...correctedSession,
					terminalTabs: [],
					activeTerminalTabId: null,
					// When unifiedTabOrder is undefined (legacy session), build it from AI+file tabs only.
					unifiedTabOrder: correctedSession.unifiedTabOrder ?? [
						...correctedSession.aiTabs.map((tab) => ({
							type: 'ai' as const,
							id: tab.id,
						})),
						...(correctedSession.filePreviewTabs || []).map((tab) => ({
							type: 'file' as const,
							id: tab.id,
						})),
					],
				};
			}

			// Migration: ensure activeTerminalTabId is null if undefined
			if (correctedSession.activeTerminalTabId === undefined) {
				correctedSession = { ...correctedSession, activeTerminalTabId: null };
			}

			// Reset all tab states to idle - processes don't survive app restart
			const resetAiTabs = correctedSession.aiTabs.map((tab) => ({
				...tab,
				state: 'idle' as const,
				thinkingStartTime: undefined,
			}));

			// Reset terminal tab runtime state - PTY processes don't survive app restart
			const resetTerminalTabs = (correctedSession.terminalTabs || []).map((tab) => ({
				...tab,
				pid: 0,
				state: 'idle' as const,
				exitCode: undefined,
			}));

			return {
				...correctedSession,
				aiPid: 0,
				terminalPid: 0,
				state: 'idle' as SessionState,
				busySource: undefined,
				thinkingStartTime: undefined,
				currentCycleTokens: undefined,
				currentCycleBytes: undefined,
				statusMessage: undefined,
				isGitRepo,
				gitBranches,
				gitTags,
				gitRefsCacheTime,
				isLive: false,
				liveUrl: undefined,
				aiLogs: [],
				aiTabs: resetAiTabs,
				shellLogs: correctedSession.shellLogs,
				executionQueue: correctedSession.executionQueue || [],
				activeTimeMs: correctedSession.activeTimeMs || 0,
				agentError: undefined,
				agentErrorPaused: false,
				closedTabHistory: [],
				filePreviewTabs: correctedSession.filePreviewTabs || [],
				activeFileTabId: correctedSession.activeFileTabId ?? null,
				terminalTabs: resetTerminalTabs,
				activeTerminalTabId: correctedSession.activeTerminalTabId ?? null,
				unifiedTabOrder: correctedSession.unifiedTabOrder || [
					...resetAiTabs.map((tab) => ({ type: 'ai' as const, id: tab.id })),
					...(correctedSession.filePreviewTabs || []).map((tab) => ({
						type: 'file' as const,
						id: tab.id,
					})),
					...resetTerminalTabs.map((tab) => ({
						type: 'terminal' as const,
						id: tab.id,
					})),
				],
			};
		} catch (error) {
			console.error(`Error restoring session ${session.id}:`, error);
			return {
				...session,
				aiPid: -1,
				terminalPid: 0,
				state: 'error' as SessionState,
				isLive: false,
				liveUrl: undefined,
			};
		}
	}, []);

	// --- Session & group loading effect ---
	// Use a ref to prevent duplicate execution in React Strict Mode
	const sessionLoadStarted = useRef(false);
	useEffect(() => {
		if (sessionLoadStarted.current) {
			return;
		}
		sessionLoadStarted.current = true;

		const loadSessionsAndGroups = async () => {
			try {
				window.__updateSplash?.(50, 'Seating the musicians...');
				const savedSessions = await window.maestro.sessions.getAll();
				const savedGroups = await window.maestro.groups.getAll();

				// Handle sessions
				if (savedSessions && savedSessions.length > 0) {
					const restoredSessions = await Promise.all(savedSessions.map((s) => restoreSession(s)));
					setSessions(restoredSessions);

					// Set active session to first session if current activeSessionId is invalid
					const activeSessionId = useSessionStore.getState().activeSessionId;
					if (
						restoredSessions.length > 0 &&
						!restoredSessions.find((s) => s.id === activeSessionId)
					) {
						setActiveSessionId(restoredSessions[0].id);
					}

					// Background tasks: agent validation + SSH git info.
					// These run after splash hides so they never block startup.
					for (const session of restoredSessions) {
						const sshRemoteId =
							session.sshRemoteId ||
							(session.sessionSshRemoteConfig?.enabled
								? session.sessionSshRemoteConfig.remoteId
								: undefined) ||
							undefined;

						// Validate agent availability in background (SSH-aware)
						validateAgentInBackground(session.id, session.toolType, sshRemoteId);

						// For remote sessions, also fetch git info in background
						if (sshRemoteId) {
							fetchGitInfoInBackground(session.id, session.cwd, sshRemoteId);
						}
					}
				} else {
					setSessions([]);
					// No sessions means no file tree to load — unblock splash immediately
					useSessionStore.getState().setInitialFileTreeReady(true);
				}

				// Handle groups
				if (savedGroups && savedGroups.length > 0) {
					setGroups(savedGroups);
				} else {
					setGroups([]);
				}

				// Load group chats
				try {
					const savedGroupChats = await window.maestro.groupChat.list();
					setGroupChats(savedGroupChats || []);
				} catch (gcError) {
					console.error('Failed to load group chats:', gcError);
					setGroupChats([]);
				}
			} catch (e) {
				console.error('Failed to load sessions/groups:', e);
				setSessions([]);
				setGroups([]);
				// Error loading sessions — no file tree to wait for
				useSessionStore.getState().setInitialFileTreeReady(true);
			} finally {
				// Mark initial load as complete to enable persistence
				initialLoadComplete.current = true;

				// Mark sessions as loaded for splash screen coordination
				setSessionsLoaded(true);
			}
		};
		loadSessionsAndGroups();
	}, []);

	return {
		initialLoadComplete,
		restoreSession,
		fetchGitInfoInBackground,
	};
}
