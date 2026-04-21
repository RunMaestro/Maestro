import { useCallback, useRef } from 'react';
import type { Session, LogEntry, UsageStats, ThinkingMode } from '../../types';
import { createTab, getActiveTab } from '../../utils/tabHelpers';
import { generateId } from '../../utils/ids';
import { buildSharedHistoryContext } from '../../utils/sessionHelpers';
import type { RightPanelHandle } from '../../components/RightPanel';
import { FALLBACK_CONTEXT_WINDOW } from '../../../shared/agentConstants';
import { logger } from '../../utils/logger';

/**
 * History entry for the addHistoryEntry function.
 */
export interface HistoryEntryInput {
	type: 'AUTO' | 'USER' | 'CUE';
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
	/** Context usage percentage from the agent run (used when activeSession context isn't available) */
	contextUsage?: number;
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
	/** Flash notification callback for user feedback */
	showFlash?: (message: string) => void;
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
		usageStats?: UsageStats,
		projectPath?: string
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
		showFlash,
	} = deps;

	// Refs for functions that need to be accessed from other callbacks
	const addHistoryEntryRef = useRef<((entry: HistoryEntryInput) => Promise<void>) | null>(null);

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

			await window.maestro.history.add(
				{
					id: generateId(),
					type: entry.type,
					timestamp: Date.now(),
					summary: entry.summary,
					fullResponse: entry.fullResponse,
					agentSessionId: entry.agentSessionId,
					sessionId: targetSessionId,
					sessionName: sessionName,
					projectPath: targetProjectPath,
					// Prefer active session's live context percentage; fall back to entry's own estimate
					...(() => {
						const ctx = shouldIncludeContextUsage
							? (activeSession?.contextUsage ?? entry.contextUsage)
							: entry.contextUsage;
						return ctx != null ? { contextUsage: ctx } : {};
					})(),
					// Only include usageStats if explicitly provided (per-task tracking)
					// Never use cumulative session stats - they're lifetime totals
					usageStats: entry.usageStats,
					// Pass through success field for error/failure tracking
					success: entry.success,
					// Pass through task execution time
					elapsedTimeMs: entry.elapsedTimeMs,
				},
				buildSharedHistoryContext(activeSession)
			);

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
			usageStats?: UsageStats,
			projectPath?: string
		) => {
			// Need an active session for tab management
			if (!activeSession) return;
			// Use provided projectPath (e.g. from history entry) or fall back to activeSession.projectRoot
			const resolvedProjectRoot = projectPath || activeSession.projectRoot;
			if (!resolvedProjectRoot) {
				logger.warn('[handleResumeSession] No projectRoot on activeSession', undefined, {
					sessionId: activeSession?.id,
					cwd: activeSession?.cwd,
				});
				showFlash?.('Cannot resume session: no project root set');
				return;
			}

			// Check if a tab with this agentSessionId already exists
			const existingTab = activeSession.aiTabs?.find(
				(tab) => tab.agentSessionId === agentSessionId
			);
			if (existingTab && existingTab.logs && existingTab.logs.length > 0) {
				// Switch to the existing tab instead of creating a duplicate
				setSessions((prev) =>
					prev.map((s) =>
						s.id === activeSession.id
							? {
									...s,
									activeTabId: existingTab.id,
									activeFileTabId: null,
									activeTerminalTabId: null,
									inputMode: 'ai',
								}
							: s
					)
				);
				setActiveAgentSessionId(agentSessionId);
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
						resolvedProjectRoot,
						agentSessionId,
						{ offset: 0, limit: 500 }
					);

					// Convert to log entries, keeping only messages with actual text content.
					// Tool-use-only messages (empty text) are skipped — restored tabs start
					// with thinking off so there's nothing useful to render for those entries.
					messages = result.messages
						.filter((msg: { content: string }) => msg.content && msg.content.trim().length > 0)
						.map((msg: { type: string; content: string; timestamp: string; uuid: string }) => ({
							id: msg.uuid || generateId(),
							timestamp: new Date(msg.timestamp).getTime(),
							source: msg.type === 'user' ? ('user' as const) : ('stdout' as const),
							text: msg.content,
						}));
				}

				if (messages.length === 0) {
					showFlash?.('Session has no displayable messages');
					return;
				}

				// Look up starred status, session name, and context usage from stores if not provided
				let isStarred = starred ?? false;
				let name = sessionName ?? null;
				let storedContextUsage: number | undefined;
				let finalUsageStats = usageStats;

				// Always look up origins for Claude sessions to get contextUsage (and name/starred if not provided)
				if (activeSession.toolType === 'claude-code') {
					try {
						// Look up session metadata from session origins (name, starred, contextUsage)
						// Note: getSessionOrigins is still Claude-specific until we add generic origin tracking
						const origins = await window.maestro.claude.getSessionOrigins(resolvedProjectRoot);
						const originData = origins[agentSessionId];
						if (originData && typeof originData === 'object') {
							if (sessionName === undefined && originData.sessionName) {
								name = originData.sessionName;
							}
							if (starred === undefined && originData.starred !== undefined) {
								isStarred = originData.starred;
							}
							if (originData.contextUsage !== undefined) {
								storedContextUsage = originData.contextUsage;
							}
						}
					} catch (error) {
						logger.warn(
							'[handleResumeSession] Failed to lookup session metadata:',
							undefined,
							error
						);
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

						// If an existing tab was found with empty logs, repopulate it instead of creating a new one
						if (existingTab) {
							const updatedTabs = s.aiTabs.map((tab) =>
								tab.id === existingTab.id
									? {
											...tab,
											logs: messages,
											name: name ?? tab.name,
											starred: isStarred || tab.starred,
											usageStats: finalUsageStats ?? tab.usageStats,
										}
									: tab
							);
							return {
								...s,
								aiTabs: updatedTabs,
								activeTabId: existingTab.id,
								activeFileTabId: null,
								activeTerminalTabId: null,
								inputMode: 'ai' as const,
							};
						}

						// Create tab from the CURRENT session state (not stale closure value)
						const result = createTab(s, {
							agentSessionId,
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
				setActiveAgentSessionId(agentSessionId);
			} catch (error) {
				logger.error('Failed to resume session:', undefined, error);
				const msg =
					error instanceof Error && error.message.includes('ENOENT')
						? 'Session file not found on disk'
						: 'Failed to load session';
				showFlash?.(msg);
			}
		},
		[
			activeSession?.projectRoot,
			activeSession?.id,
			activeSession?.aiTabs,
			activeSession?.toolType,
			setSessions,
			setActiveAgentSessionId,
			defaultSaveToHistory,
			defaultShowThinking,
			showFlash,
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
