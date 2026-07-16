import { useCallback, useRef } from 'react';
import type { Session, LogEntry, UsageStats, ThinkingMode } from '../../types';
import { useSessionStore, selectSessionById, selectActiveSession } from '../../stores/sessionStore';
import { aiTabFocusFields, createTab, getActiveTab } from '../../utils/tabHelpers';
import { generateId } from '../../utils/ids';
import { buildSharedHistoryContext } from '../../utils/sessionHelpers';
import type { RightPanelHandle } from '../../components/RightPanel';
import { FALLBACK_CONTEXT_WINDOW } from '../../../shared/agentConstants';
import { logger } from '../../utils/logger';

/**
 * Matches the Auto Run synopsis prompt that Maestro injects into the agent
 * session after a task ("Give/Provide a brief synopsis of what you just
 * accomplished ..."). The leading verb and trailing wording have drifted across
 * versions and the prompt is user-customizable, so we anchor on the stable core
 * phrase. A restored tab hides this request and the assistant's `**Summary:**`
 * reply since they are bookkeeping, not part of the user's conversation.
 */
const SYNOPSIS_REQUEST_PATTERN =
	/^\s*\S+\s+a\s+brief\s+synopsis\s+of\s+what\s+you\s+just\s+accomplished/i;

export function isSynopsisRequest(msg: {
	type?: string;
	role?: string;
	content?: string;
}): boolean {
	const isUser = msg.type === 'user' || msg.role === 'user';
	return isUser && typeof msg.content === 'string' && SYNOPSIS_REQUEST_PATTERN.test(msg.content);
}

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
	/**
	 * Claude-only, per-turn token source override. When omitted, it's resolved from
	 * the entry's session `claudeInteractive` mode. Background/Auto Run/Cue callers
	 * can set it explicitly to stamp the source they ran under.
	 */
	tokenSource?: 'interactive' | 'api';
	/** Claude-only, per-turn token source reason override. See {@link tokenSource}. */
	tokenSourceReason?: 'auto' | 'limit';
	/**
	 * Cross-agent attribution: the calling agent's display name, stamped when this
	 * entry records a consult the agent answered (so its History shows who
	 * consulted it).
	 */
	sourceAgentName?: string;
}

/**
 * Dependencies for the useAgentSessionManagement hook.
 */
export interface UseAgentSessionManagementDeps {
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
	/**
	 * Resume a Agent session, opening as a new tab or switching to existing.
	 * Resolves to `true` when a tab was opened or switched, `false` when the
	 * session could not be loaded (e.g. aged out / no longer on disk) so callers
	 * can offer recovery (such as removing a stale star).
	 */
	handleResumeSession: (
		agentSessionId: string,
		providedMessages?: LogEntry[],
		sessionName?: string,
		starred?: boolean,
		usageStats?: UsageStats,
		projectPath?: string,
		opts?: ResumeSessionOptions
	) => Promise<boolean>;
}

/**
 * Optional behavior overrides for {@link UseAgentSessionManagementReturn.handleResumeSession}.
 */
export interface ResumeSessionOptions {
	/**
	 * Resume into a specific Maestro agent (Session.id) resolved fresh from the
	 * store, rather than the current active session. Required when jumping
	 * across agents (e.g. the Left Bar "Starred Sessions" list), where the target
	 * agent isn't the one currently active.
	 */
	targetSessionId?: string;
	/**
	 * Skip the built-in flash when the session can't be loaded. Lets the caller
	 * present its own recovery UI (e.g. "this session aged out, remove the star?")
	 * instead of a transient message.
	 */
	suppressUnavailableFlash?: boolean;
}

/**
 * Hook for Agent-specific session operations.
 *
 * Handles:
 * - Adding history entries with session metadata
 * - Jumping to Agent sessions in the browser
 * - Resuming saved Agent sessions as tabs
 *
 * The active session is not passed in as a dep; each callback resolves it
 * fresh from the store (`selectActiveSession(useSessionStore.getState())`) at
 * call time, so callers never risk acting on a stale closure value.
 *
 * @param deps - Hook dependencies
 * @returns Session management functions and refs
 */
export function useAgentSessionManagement(
	deps: UseAgentSessionManagementDeps
): UseAgentSessionManagementReturn {
	const {
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
			const activeSession = selectActiveSession(useSessionStore.getState());

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

			// Resolve the Claude token source for this turn. Token source belongs on
			// the ENTRY, not the agent: a Dynamic-mode agent flips between TUI and API
			// across turns, so we snapshot the resolved mode at write time. An explicit
			// override from the caller (background/Auto Run/Cue) always wins; otherwise
			// read the resolved session's live `claudeInteractive`. For Claude Code we
			// always emit a token source: when `claudeInteractive` is absent the turn
			// ran the default `claude --print` (API) path - the adaptive/maestro-p
			// machinery only writes that field when it engages, so absence means API.
			// Non-Claude agents get no field at all.
			const tokenSourceFields = (() => {
				if (entry.tokenSource) {
					return {
						tokenSource: entry.tokenSource,
						...(entry.tokenSourceReason ? { tokenSourceReason: entry.tokenSourceReason } : {}),
					};
				}
				const tokenSession = entry.sessionId
					? selectSessionById(entry.sessionId)(useSessionStore.getState())
					: activeSession;
				if (tokenSession?.toolType === 'claude-code') {
					const ci = tokenSession.claudeInteractive;
					return {
						tokenSource: ci?.mode ?? 'api',
						...(ci?.modeReason ? { tokenSourceReason: ci.modeReason } : {}),
					};
				}
				return {};
			})();

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
					// Claude-only per-turn token source (TUI vs API); omitted otherwise
					...tokenSourceFields,
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
					// Cross-agent attribution: which agent consulted this one (if any)
					...(entry.sourceAgentName ? { sourceAgentName: entry.sourceAgentName } : {}),
				},
				buildSharedHistoryContext(activeSession)
			);

			// Refresh history panel to show the new entry
			rightPanelRef.current?.refreshHistoryPanel();
		},
		[rightPanelRef]
	);

	/**
	 * Jump to a specific agent session in the agent sessions browser.
	 */
	const handleJumpToAgentSession = useCallback(
		(agentSessionId: string) => {
			const activeSession = selectActiveSession(useSessionStore.getState());

			// Set the agent session ID and load its messages
			if (activeSession) {
				setActiveAgentSessionId(agentSessionId);
				// Open the agent sessions browser to show the selected session
				setAgentSessionsOpen(true);
			}
		},
		[setActiveAgentSessionId, setAgentSessionsOpen]
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
			projectPath?: string,
			opts?: ResumeSessionOptions
		): Promise<boolean> => {
			// Resolve the agent to resume into. When a targetSessionId is provided
			// (cross-agent jump, e.g. starred sessions), read it fresh from the store
			// by id. Otherwise fall back to the current active session, also resolved
			// fresh so it can't be a stale closure value.
			const activeSession = selectActiveSession(useSessionStore.getState());
			const targetSession = opts?.targetSessionId
				? (selectSessionById(opts.targetSessionId)(useSessionStore.getState()) ?? null)
				: activeSession;
			// Need a session for tab management
			if (!targetSession) return false;
			// Use provided projectPath (e.g. from history entry) or fall back to the target's projectRoot
			const resolvedProjectRoot = projectPath || targetSession.projectRoot;
			if (!resolvedProjectRoot) {
				logger.warn('[handleResumeSession] No projectRoot on target session', undefined, {
					sessionId: targetSession.id,
					cwd: targetSession.cwd,
				});
				if (!opts?.suppressUnavailableFlash) {
					showFlash?.('Cannot resume session: no project root set');
				}
				return false;
			}

			// Check if a tab with this agentSessionId already exists
			const existingTab = targetSession.aiTabs?.find(
				(tab) => tab.agentSessionId === agentSessionId
			);
			if (existingTab && existingTab.logs && existingTab.logs.length > 0) {
				// Switch to the existing tab instead of creating a duplicate
				setSessions((prev) =>
					prev.map((s) =>
						s.id === targetSession.id ? { ...s, ...aiTabFocusFields(existingTab.id) } : s
					)
				);
				setActiveAgentSessionId(agentSessionId);
				return true;
			}

			try {
				// Use provided messages or fetch them
				let messages: LogEntry[];
				if (providedMessages && providedMessages.length > 0) {
					messages = providedMessages;
				} else {
					// Load the session messages using the generic agentSessions API
					// Use projectRoot (not cwd) for consistent session storage access
					// Pass sshRemoteId so SSH-remote sessions read from the correct host
					const agentId = targetSession.toolType || 'claude-code';
					const result = await window.maestro.agentSessions.read(
						agentId,
						resolvedProjectRoot,
						agentSessionId,
						{ offset: 0, limit: 500 },
						targetSession.sshRemoteId
					);

					// Drop the Auto Run synopsis request and the assistant reply that
					// immediately follows it. These are Maestro bookkeeping turns, not part
					// of the user's conversation, so they shouldn't reappear on restore.
					const withoutSynopsis = result.messages.filter(
						(
							msg: { type: string; role?: string; content: string },
							i: number,
							arr: { type: string; role?: string; content: string }[]
						) => {
							if (isSynopsisRequest(msg)) return false;
							const prev = arr[i - 1];
							const isAssistant = msg.type === 'assistant' || msg.role === 'assistant';
							if (prev && isSynopsisRequest(prev) && isAssistant) return false;
							return true;
						}
					);

					// Convert to log entries, keeping messages with actual text content or
					// reconstructed images. Tool-use-only messages (empty text, no images)
					// are skipped - restored tabs start with thinking off so there's nothing
					// useful to render for those entries.
					messages = withoutSynopsis
						.filter(
							(msg: { content: string; images?: string[] }) =>
								(msg.content && msg.content.trim().length > 0) ||
								(msg.images != null && msg.images.length > 0)
						)
						.map(
							(msg: {
								type: string;
								content: string;
								timestamp: string;
								uuid: string;
								images?: string[];
							}) => ({
								id: msg.uuid || generateId(),
								timestamp: new Date(msg.timestamp).getTime(),
								source: msg.type === 'user' ? ('user' as const) : ('stdout' as const),
								text: msg.content,
								...(msg.images && msg.images.length > 0 && { images: msg.images }),
							})
						);
				}

				if (messages.length === 0) {
					// No messages came back: the session is empty or has aged out / been
					// removed from disk. Treat as unavailable so callers can recover.
					if (!opts?.suppressUnavailableFlash) {
						showFlash?.('Session has no displayable messages');
					}
					return false;
				}

				// Look up starred status, session name, and context usage from stores if not provided
				let isStarred = starred ?? false;
				let name = sessionName ?? null;
				let storedContextUsage: number | undefined;
				let finalUsageStats = usageStats;

				// Always look up origins for Claude sessions to get contextUsage (and name/starred if not provided)
				if (targetSession.toolType === 'claude-code') {
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
						if (s.id !== targetSession.id) return s;

						// Re-resolve the existing tab from FRESH state, not the `existingTab`
						// captured before the async read above. handleResumeSession awaits
						// disk I/O, so two activations of the same starred session (a rapid
						// double-click, or a click racing the keyboard cycle) can both pass
						// the pre-await dedup with no tab present. Re-checking here means the
						// second update sees the first's committed tab and focuses it instead
						// of creating a duplicate. There must never be two tabs for one session.
						const freshExistingTab = s.aiTabs?.find((tab) => tab.agentSessionId === agentSessionId);

						// If a tab already exists for this session, repopulate (if needed) and
						// focus it instead of creating a duplicate.
						if (freshExistingTab) {
							const updatedTabs = s.aiTabs.map((tab) =>
								tab.id === freshExistingTab.id
									? {
											...tab,
											logs: tab.logs && tab.logs.length > 0 ? tab.logs : messages,
											name: name ?? tab.name,
											starred: isStarred || tab.starred,
											usageStats: finalUsageStats ?? tab.usageStats,
										}
									: tab
							);
							return {
								...s,
								aiTabs: updatedTabs,
								...aiTabFocusFields(freshExistingTab.id),
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
				return true;
			} catch (error) {
				logger.error('Failed to resume session:', undefined, error);
				if (!opts?.suppressUnavailableFlash) {
					const msg =
						error instanceof Error && error.message.includes('ENOENT')
							? 'Session file not found on disk'
							: 'Failed to load session';
					showFlash?.(msg);
				}
				return false;
			}
		},
		[setSessions, setActiveAgentSessionId, defaultSaveToHistory, defaultShowThinking, showFlash]
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
