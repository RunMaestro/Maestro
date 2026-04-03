import { useCallback, useRef } from 'react';
import type { Session, LogEntry, UsageStats, ThinkingMode } from '../../types';
import { createTab, getActiveTab } from '../../utils/tabHelpers';
import { generateId } from '../../utils/ids';
import type { RightPanelHandle } from '../../components/RightPanel';
import { FALLBACK_CONTEXT_WINDOW } from '../../../shared/agentConstants';
import {
	normalizeOpenClawSessionId,
	resolveCanonicalOpenClawSessionId,
} from '../../../shared/openclawSessionId';

/**
 * History entry for the addHistoryEntry function.
 */
export interface HistoryEntryInput {
	type: 'AUTO' | 'USER';
	summary: string;
	fullResponse?: string;
	agentSessionId?: string;
	usageStats?: UsageStats;
	/** Optional override for background operations (prevents cross-agent bleed) */
	sessionId?: string;
	/** Optional override for background operations (prevents cross-agent bleed) */
	projectPath?: string;
	/** Optional override for background operations (prevents cross-agent bleed) */
	sessionName?: string;
	/** Whether the operation succeeded (false for errors/failures) */
	success?: boolean;
	/** Task execution time in milliseconds */
	elapsedTimeMs?: number;
}

/**
 * Dependencies for the useAgentSessionManagement hook.
 */
export interface UseAgentSessionManagementDeps {
	/** Current active session (null if none selected) */
	activeSession: Session | null;
	/** Session state setter */
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	/** Agent session ID setter */
	setActiveAgentSessionId: (id: string | null) => void;
	/** Agent sessions browser open state setter */
	setAgentSessionsOpen: (open: boolean) => void;
	/** Ref to the right panel for refreshing history */
	rightPanelRef: React.RefObject<RightPanelHandle | null>;
	/** Default value for saveToHistory on new tabs */
	defaultSaveToHistory: boolean;
	/** Default value for showThinking on new tabs */
	defaultShowThinking: ThinkingMode;
}

/**
 * Return type for useAgentSessionManagement hook.
 */
export interface UseAgentSessionManagementReturn {
	/** Add a history entry for the current session */
	addHistoryEntry: (entry: HistoryEntryInput) => Promise<void>;
	/** Ref to addHistoryEntry for use in callbacks that need latest version */
	addHistoryEntryRef: React.MutableRefObject<((entry: HistoryEntryInput) => Promise<void>) | null>;
	/** Jump to a specific agent session in the browser */
	handleJumpToAgentSession: (agentSessionId: string) => void;
	/** Resume a Agent session, opening as a new tab or switching to existing */
	handleResumeSession: (
		agentSessionId: string,
		providedMessages?: LogEntry[],
		sessionName?: string,
		starred?: boolean,
		usageStats?: UsageStats
	) => Promise<void>;
}

/**
 * Hook for Agent-specific session operations.
 *
 * Handles:
 * - Adding history entries with session metadata
 * - Jumping to Agent sessions in the browser
 * - Resuming saved Agent sessions as tabs
 *
 * @param deps - Hook dependencies
 * @returns Session management functions and refs
 */
export function useAgentSessionManagement(
	deps: UseAgentSessionManagementDeps
): UseAgentSessionManagementReturn {
	const {
		activeSession,
		setSessions,
		setActiveAgentSessionId,
		setAgentSessionsOpen,
		rightPanelRef,
		defaultSaveToHistory,
		defaultShowThinking,
	} = deps;

	// Refs for functions that need to be accessed from other callbacks
	const addHistoryEntryRef = useRef<((entry: HistoryEntryInput) => Promise<void>) | null>(null);
	const sshRemoteId =
		activeSession?.sshRemoteId || activeSession?.sessionSshRemoteConfig?.remoteId || undefined;
	const projectPathForSessions = sshRemoteId
		? activeSession?.remoteCwd ||
			activeSession?.sessionSshRemoteConfig?.workingDirOverride ||
			activeSession?.projectRoot
		: activeSession?.projectRoot;

	/**
	 * Add a history entry for a session.
	 * Uses provided session info or falls back to active session.
	 */
	const addHistoryEntry = useCallback(
		async (entry: HistoryEntryInput) => {
			// Use provided values or fall back to activeSession
			const targetSessionId = entry.sessionId || activeSession?.id;
			const targetProjectPath = entry.projectPath || activeSession?.cwd;

			if (!targetSessionId || !targetProjectPath) return;

			// Get session name from entry, or from active tab if using activeSession
			let sessionName = entry.sessionName;
			if (!sessionName && activeSession && !entry.sessionId) {
				const activeTab = getActiveTab(activeSession);
				sessionName = activeTab?.name ?? undefined;
			}

			const shouldIncludeContextUsage = !entry.sessionId || entry.sessionId === activeSession?.id;

			await window.maestro.history.add({
				id: generateId(),
				type: entry.type,
				timestamp: Date.now(),
				summary: entry.summary,
				fullResponse: entry.fullResponse,
				agentSessionId: entry.agentSessionId,
				sessionId: targetSessionId,
				sessionName: sessionName,
				projectPath: targetProjectPath,
				...(shouldIncludeContextUsage ? { contextUsage: activeSession?.contextUsage } : {}),
				// Only include usageStats if explicitly provided (per-task tracking)
				// Never use cumulative session stats - they're lifetime totals
				usageStats: entry.usageStats,
				// Pass through success field for error/failure tracking
				success: entry.success,
				// Pass through task execution time
				elapsedTimeMs: entry.elapsedTimeMs,
			});

			// Refresh history panel to show the new entry
			rightPanelRef.current?.refreshHistoryPanel();
		},
		[activeSession, rightPanelRef]
	);

	/**
	 * Jump to a specific agent session in the agent sessions browser.
	 */
	const handleJumpToAgentSession = useCallback(
		(agentSessionId: string) => {
			// Set the agent session ID and load its messages
			if (activeSession) {
				setActiveAgentSessionId(agentSessionId);
				// Open the agent sessions browser to show the selected session
				setAgentSessionsOpen(true);
			}
		},
		[activeSession, setActiveAgentSessionId, setAgentSessionsOpen]
	);

	/**
	 * Resume an agent session - opens as a new tab or switches to existing tab.
	 * Loads messages from the session and looks up metadata (starred, name).
	 */
	const handleResumeSession = useCallback(
		async (
			agentSessionId: string,
			providedMessages?: LogEntry[],
			sessionName?: string,
			starred?: boolean,
			usageStats?: UsageStats
		) => {
			if (!activeSession?.projectRoot || !projectPathForSessions) return;

			const isOpenClaw = activeSession.toolType === 'openclaw';
			let resolvedSessionId = isOpenClaw
				? normalizeOpenClawSessionId(agentSessionId) || agentSessionId
				: agentSessionId;

			if (isOpenClaw) {
				try {
					const sessions = await window.maestro.agentSessions.list(
						activeSession.toolType,
						projectPathForSessions,
						sshRemoteId
					);
					const listedSessionIds = sessions.map((session) => session.sessionId);
					const canonicalSessionId = resolveCanonicalOpenClawSessionId(
						agentSessionId,
						listedSessionIds
					);
					if (canonicalSessionId) {
						resolvedSessionId = canonicalSessionId;
					}
				} catch (error) {
					console.warn(
						'[handleResumeSession] Failed to resolve canonical OpenClaw session ID:',
						error
					);
				}
			}

			// Check if a tab with this agentSessionId already exists
			const existingTab = activeSession.aiTabs?.find((tab) => {
				if (tab.agentSessionId === resolvedSessionId) {
					return true;
				}

				if (!isOpenClaw) {
					return false;
				}

				if (!tab.agentSessionId) {
					return false;
				}

				const tabCanonicalSessionId = normalizeOpenClawSessionId(tab.agentSessionId);
				return tabCanonicalSessionId !== null && tabCanonicalSessionId === resolvedSessionId;
			});
			if (existingTab) {
				// Switch to the existing tab instead of creating a duplicate
				setSessions((prev) =>
					prev.map((s) =>
						s.id === activeSession.id
							? { ...s, activeTabId: existingTab.id, activeFileTabId: null, inputMode: 'ai' }
							: s
					)
				);
				setActiveAgentSessionId(resolvedSessionId);
				return;
			}

			try {
				// Use provided messages or fetch them
				let messages: LogEntry[];
				if (providedMessages && providedMessages.length > 0) {
					messages = providedMessages;
				} else {
					// Load the session messages using the generic agentSessions API
					// Use projectRoot (not cwd) for consistent session storage access
					const agentId = activeSession.toolType || 'claude-code';
					const result = await window.maestro.agentSessions.read(
						agentId,
						projectPathForSessions,
						resolvedSessionId,
						{ offset: 0, limit: 100 },
						sshRemoteId
					);

					// Convert to log entries
					messages = result.messages.map(
						(msg: { type: string; content: string; timestamp: string; uuid: string }) => ({
							id: msg.uuid || generateId(),
							timestamp: new Date(msg.timestamp).getTime(),
							source: msg.type === 'user' ? ('user' as const) : ('stdout' as const),
							text: msg.content || '',
						})
					);
				}

				// Look up starred status, session name, and context usage from stores if not provided
				let isStarred = starred ?? false;
				let name = sessionName ?? null;
				let storedContextUsage: number | undefined;
				let finalUsageStats = usageStats;

				// Always look up origins for Claude/OpenClaw sessions to get contextUsage (and name/starred if not provided)
				if (activeSession.toolType === 'claude-code' || activeSession.toolType === 'openclaw') {
					try {
						// Look up session metadata from session origins (name, starred, contextUsage)
						// Claude uses claude-specific storage APIs; OpenClaw uses generic origins storage
						const originData =
							activeSession.toolType === 'openclaw'
								? await (async () => {
										const originProjectPaths = Array.from(
											new Set(
												[projectPathForSessions, activeSession.projectRoot].filter(
													(pathCandidate): pathCandidate is string => !!pathCandidate
												)
											)
										);

										for (const originProjectPath of originProjectPaths) {
											const origins = await window.maestro.agentSessions.getOrigins(
												activeSession.toolType,
												originProjectPath
											);
											const matchedOrigin = origins[resolvedSessionId];
											if (matchedOrigin) {
												return matchedOrigin;
											}
										}

										return undefined;
									})()
								: (await window.maestro.claude.getSessionOrigins(activeSession.projectRoot))[
										resolvedSessionId
									];
						if (originData && typeof originData === 'object') {
							const originWithUsage = originData as {
								contextUsage?: number;
								origin?: 'user' | 'auto';
								sessionName?: string;
								starred?: boolean;
							};

							if (sessionName === undefined && typeof originWithUsage.sessionName === 'string') {
								name = originWithUsage.sessionName;
							}
							if (starred === undefined && originWithUsage.starred !== undefined) {
								isStarred = originWithUsage.starred;
							}
							if (originWithUsage.contextUsage !== undefined) {
								storedContextUsage = originWithUsage.contextUsage;
							}
						}
					} catch (error) {
						console.warn('[handleResumeSession] Failed to lookup session metadata:', error);
					}
				}

				// If we have stored contextUsage, set token values to reproduce that percentage
				// The context calculation is: (inputTokens + cacheRead + cacheCreation) / contextWindow * 100
				// So we set inputTokens = contextUsage * contextWindow / 100 to get the correct percentage
				if (storedContextUsage !== undefined && storedContextUsage > 0) {
					const contextWindow = finalUsageStats?.contextWindow || FALLBACK_CONTEXT_WINDOW;
					finalUsageStats = {
						inputTokens: Math.round((storedContextUsage * contextWindow) / 100),
						outputTokens: finalUsageStats?.outputTokens || 0,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						totalCostUsd: finalUsageStats?.totalCostUsd || 0,
						contextWindow,
						reasoningTokens: finalUsageStats?.reasoningTokens,
					};
				}

				// Update the session and switch to AI mode
				// IMPORTANT: Use functional update to get fresh session state and avoid race conditions
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== activeSession.id) return s;

						// Create tab from the CURRENT session state (not stale closure value)
						const result = createTab(s, {
							agentSessionId: resolvedSessionId,
							logs: messages,
							name,
							starred: isStarred,
							usageStats: finalUsageStats,
							saveToHistory: defaultSaveToHistory,
							showThinking: defaultShowThinking,
						});
						if (!result) return s;

						return { ...result.session, activeFileTabId: null, inputMode: 'ai' };
					})
				);
				setActiveAgentSessionId(resolvedSessionId);
			} catch (error) {
				console.error('Failed to resume session:', error);
			}
		},
		[
			activeSession?.projectRoot,
			activeSession?.id,
			activeSession?.aiTabs,
			activeSession?.toolType,
			activeSession?.remoteCwd,
			activeSession?.sshRemoteId,
			activeSession?.sessionSshRemoteConfig?.remoteId,
			activeSession?.sessionSshRemoteConfig?.workingDirOverride,
			setSessions,
			setActiveAgentSessionId,
			defaultSaveToHistory,
			defaultShowThinking,
			projectPathForSessions,
			sshRemoteId,
		]
	);

	// Update refs for slash command functions (so other handlers can access latest versions)
	addHistoryEntryRef.current = addHistoryEntry;

	return {
		addHistoryEntry,
		addHistoryEntryRef,
		handleJumpToAgentSession,
		handleResumeSession,
	};
}
