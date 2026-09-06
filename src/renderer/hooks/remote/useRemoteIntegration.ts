import { useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import type { Session, SessionState, ThinkingMode, QueuedItem } from '../../types';
import { cueService } from '../../services/cue';
import { captureException } from '../../utils/sentry';
import {
	aiTabFocusFields,
	createTab,
	closeTab,
	getActiveTab,
	getRepairedUnifiedTabOrder,
	visibleAiTabs,
} from '../../utils/tabHelpers';
import { logger } from '../../utils/logger';
import { buildQueuedMessageItem } from '../../services/queuedPrompt';
import { requestFileTreeRefresh } from '../../utils/fileTreeRefresh';
import { persistTabStarred } from '../../utils/starredSessions';
import { formatLogsForClipboard } from '../../utils/contextExtractor';
import { messagesToLogEntries } from '../../components/AgentSessionsBrowser/utils/messagesToLogEntries';
import type { SessionMessage } from '../agent/useSessionViewer';
import { resolveSessionProjectPath } from '../../components/AgentSessionsBrowser/utils/sessionProjectPath';
import { notifyToast } from '../../stores/notificationStore';
import { applyCadenzaPayload, useCadenzaStore } from '../../stores/cadenzaStore';
import {
	applyMovementPayload,
	getMovementSnapshot,
	useMovementStore,
} from '../../stores/movementStore';
import { openUiSurface } from '../../utils/openUiSurface';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import { updateAiTab, updateSessionWith, useSessionStore } from '../../stores/sessionStore';
import { useConcertoCreationActivityStore } from '../../stores/concertoCreationActivityStore';
import { buildThinkingItems } from '../../utils/thinkingItems';
import type { ConcertoCreationPhase, ConcertoProgressNote } from '../../../shared/movement-types';
import {
	getConcertoDesignerFrameSnapshot,
	interactWithConcertoDesignerFrame,
} from '../../components/Concerto/concertoDesignerBridge';
import { useFileExplorerStore } from '../../stores/fileExplorerStore';
import {
	clearDesktopAiTabSelections,
	consumeDesktopAiTabSelection,
} from '../../utils/desktopTabSelectionSync';

/**
 * Dependencies for the useRemoteIntegration hook.
 * Uses refs for values that change frequently to avoid re-attaching listeners.
 */
export interface UseRemoteIntegrationDeps {
	/** Current active session ID */
	activeSessionId: string;
	/** Whether live mode is enabled (web interface) */
	isLiveMode: boolean;
	/** Ref to current sessions array (avoids stale closures) */
	sessionsRef: React.MutableRefObject<Session[]>;
	/** Ref to current active session ID (avoids stale closures) */
	activeSessionIdRef: React.MutableRefObject<string>;
	/** Active session ID setter */
	setActiveSessionId: (id: string) => void;
	/** Default value for saveToHistory on new tabs */
	defaultSaveToHistory: boolean;
	/** Default value for showThinking on new tabs */
	defaultShowThinking: ThinkingMode;
}

/**
 * Return type for useRemoteIntegration hook.
 * Currently empty as all functionality is side effects.
 */
export interface UseRemoteIntegrationReturn {
	// No return values - all functionality is via side effects
}

const MOVEMENT_INSPECTION_PAINT_FALLBACK_MS = 250;

/**
 * Attribute a Concerto bridge event only when one AI tab is unambiguously busy.
 * The bridge does not yet carry its originating session, so guessing in a
 * concurrent run could put another agent's design status on the focused pill.
 */
function recordConcertoCreationActivity(
	movementId: string,
	phase: ConcertoCreationPhase,
	revision?: number,
	reportedTitle?: string,
	step?: number,
	steps?: number,
	notes?: ConcertoProgressNote[]
): void {
	const thinkingItems = buildThinkingItems(useSessionStore.getState().sessions);
	if (thinkingItems.length !== 1) return;

	const [{ session, tab }] = thinkingItems;
	const thinkingStartTime = tab?.thinkingStartTime ?? session.thinkingStartTime;
	if (thinkingStartTime === undefined) return;

	const movement = useMovementStore
		.getState()
		.items.find((candidate) => candidate.id === movementId);
	// A progress event may arrive before the subagent has mounted its HTML. Other
	// Movement events must resolve to an authored HTML mockup so native/plugin
	// panels never create a Concerto pipeline track.
	if (!reportedTitle && (!movement || movement.viewType !== 'html')) return;

	useConcertoCreationActivityStore.getState().upsertTrack({
		sessionId: session.id,
		tabId: tab?.id ?? null,
		thinkingStartTime,
		movementId,
		title: reportedTitle?.trim() || movement?.title?.trim() || movementId,
		phase,
		step,
		steps,
		notes,
		width: movement ? Math.round(movement.width) : undefined,
		height:
			movement?.measuredHeight !== undefined
				? Math.round(movement.measuredHeight)
				: movement?.height !== undefined
					? Math.round(movement.height)
					: undefined,
		revision,
	});
}

/**
 * Wait until Chromium has had a full rendering opportunity after a synchronous
 * surface update. The second animation frame runs after the first frame's paint.
 * A bounded fallback keeps inspection responsive when background throttling
 * suppresses animation frames.
 */
function waitForMovementInspectionPaint(): Promise<void> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			window.clearTimeout(fallbackTimeout);
			resolve();
		};
		const fallbackTimeout = window.setTimeout(finish, MOVEMENT_INSPECTION_PAINT_FALLBACK_MS);
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(finish);
		});
	});
}

/**
 * Upper bound on messages pulled from a provider transcript for a gist. The
 * read is tail-anchored, so this keeps the newest N and reports the cut.
 */
const GIST_SESSION_MESSAGE_LIMIT = 10000;

type GistBody = { body: string } | { error: string };

/**
 * Transcript body for `gist create <agent-id> --session <id>` - ONE provider
 * session, not the agent's open AI tabs.
 *
 * Headless callers (Maestro Relay, playbooks, Cue, CI) address a conversation
 * by its provider session id and have no desktop tab, so publishing the
 * agent's tabs for them puts an unrelated conversation in a URL-readable gist.
 *
 * Prefers a live tab holding that session (its logs are already in memory and
 * every provider has them) and falls back to the provider's on-disk transcript,
 * which is where a purely headless session lives.
 */
async function buildSessionGistBody(session: Session, agentSessionId: string): Promise<GistBody> {
	const liveTab = session.aiTabs.find((tab) => tab.agentSessionId === agentSessionId);
	if (liveTab) {
		const body = formatLogsForClipboard(liveTab.logs);
		return body ? { body } : { error: `Session has no conversation history: ${agentSessionId}` };
	}

	const { projectPathForSessions, sshRemoteId } = resolveSessionProjectPath(session);
	if (!projectPathForSessions) {
		return { error: `Cannot resolve a project path for agent ${session.id}` };
	}

	let result: { messages: SessionMessage[]; hasMore: boolean };
	try {
		result = await window.maestro.agentSessions.read(
			session.toolType,
			projectPathForSessions,
			agentSessionId,
			{ offset: 0, limit: GIST_SESSION_MESSAGE_LIMIT },
			sshRemoteId
		);
	} catch {
		// A missing transcript throws out of the provider storage read. That is
		// an ordinary miss (wrong id, wrong agent, provider without on-disk
		// sessions), so answer the caller instead of reporting a crash.
		return { error: `No transcript found for session ${agentSessionId}` };
	}

	const body = formatLogsForClipboard(messagesToLogEntries(result.messages, agentSessionId));
	if (!body) {
		return { error: `No transcript found for session ${agentSessionId}` };
	}
	// Say so when the tail was cut - a silently truncated transcript reads as a
	// complete one to whoever opens the gist.
	return {
		body: result.hasMore
			? `_Older messages truncated - showing the most recent ${GIST_SESSION_MESSAGE_LIMIT}._\n\n${body}`
			: body,
	};
}

/**
 * Hook for handling web interface communication.
 *
 * Sets up listeners for remote commands from the web interface:
 * - Active session broadcast to web clients
 * - Remote command listener (dispatches event for App.tsx to handle)
 * - Remote mode switching
 * - Remote interrupt handling
 * - Remote session/tab selection
 * - Remote tab creation and closing
 * - Tab change broadcasting to web clients
 *
 * All effects have explicit cleanup functions to prevent memory leaks.
 *
 * @param deps - Hook dependencies
 * @returns Empty object (all functionality via side effects)
 */
export function useRemoteIntegration(deps: UseRemoteIntegrationDeps): UseRemoteIntegrationReturn {
	const {
		activeSessionId,
		isLiveMode,
		sessionsRef,
		activeSessionIdRef,
		setActiveSessionId,
		defaultSaveToHistory,
		defaultShowThinking,
	} = deps;

	// Broadcast active session change to web clients
	useEffect(() => {
		if (activeSessionId && isLiveMode) {
			window.maestro.live.broadcastActiveSession(activeSessionId);
		}
	}, [activeSessionId, isLiveMode]);

	// Handle remote commands from web interface
	// This allows web commands to go through the exact same code path as desktop commands
	useEffect(() => {
		logger.info('[useRemoteIntegration] Setting up onRemoteCommand listener');
		const unsubscribeRemote = window.maestro.process.onRemoteCommand(
			(
				sessionId: string,
				command: string,
				inputMode?: 'ai' | 'terminal',
				tabId?: string,
				force?: boolean,
				images?: string[],
				background?: boolean,
				receiptChannel?: string
			) => {
				// Delivery receipt for the web server's `executeCommand` promise.
				// Every early return below must answer it, or the caller waits out
				// the main-side timeout and reads the drop as a generic failure.
				// The accept ack itself is sent further downstream, by
				// handleRemoteCommand, once the prompt reaches the spawn logic.
				const rejectDelivery = (reason: string) => {
					if (receiptChannel) {
						window.maestro.process.sendRemoteCommandReceipt(receiptChannel, false, reason);
					}
				};
				// Log metadata only at info level - remote commands can carry
				// secrets, proprietary code, or PII. Mirror the redaction the
				// main process applies in web-server-factory; the truncated
				// preview moves to debug, which only opted-in users enable.
				logger.info('[useRemoteIntegration] onRemoteCommand callback invoked:', undefined, {
					sessionId,
					commandLength: command?.length ?? 0,
					inputMode,
					tabId,
					force,
					imageCount: images?.length ?? 0,
					background,
				});
				logger.debug('[useRemoteIntegration] onRemoteCommand preview:', undefined, {
					sessionId,
					commandPreview: command?.substring(0, 50),
				});

				// Verify the session exists
				const targetSession = sessionsRef.current.find((s) => s.id === sessionId);
				logger.info('[useRemoteIntegration] Target session lookup:', undefined, {
					found: !!targetSession,
					sessionCount: sessionsRef.current.length,
					availableIds: sessionsRef.current.map((s) => s.id),
				});

				if (!targetSession) {
					logger.warn('[useRemoteIntegration] Session not found, dropping command');
					rejectDelivery('session-not-found');
					return;
				}

				// Check if session is busy (should have been checked by web server,
				// but double-check). `force: true` (from `dispatch --force`) opts
				// out of the guard so a queued follow-up can land on a busy tab.
				if (targetSession.state === 'busy' && !force) {
					logger.warn(
						'[useRemoteIntegration] Session is busy, dropping command. State:',
						undefined,
						targetSession.state
					);
					rejectDelivery('session-busy');
					return;
				}
				logger.info(
					'[useRemoteIntegration] Session state check passed:',
					undefined,
					targetSession.state
				);

				// If web provided an inputMode, sync the session state before executing
				// This ensures the renderer uses the same mode the web intended
				if (inputMode && targetSession.inputMode !== inputMode) {
					updateSessionWith(sessionId, (s) => ({
						...s,
						inputMode,
						...(inputMode === 'terminal' && { activeFileTabId: null }),
					}));
				}

				// Switch to the target session (for visual feedback). A phone tapping
				// send wants exactly this; an agent handing work to another agent
				// does not, and until `background` existed it had no way to say so -
				// which is also what defeated `create-worktree --background` the
				// moment it was given a message to deliver.
				if (background === true) {
					logger.info(
						'[useRemoteIntegration] Background dispatch - leaving the view where it is:',
						undefined,
						sessionId
					);
				} else {
					setActiveSessionId(sessionId);
					logger.info('[useRemoteIntegration] Switched active session to:', undefined, sessionId);
				}

				// Dispatch event directly - handleRemoteCommand handles all the logic
				// Don't set inputValue - we don't want command text to appear in the input bar
				// Pass the inputMode from web so handleRemoteCommand uses it
				logger.info('[useRemoteIntegration] Dispatching maestro:remoteCommand event:', undefined, {
					sessionId,
					commandLength: command?.length ?? 0,
					inputMode,
					tabId,
					force,
					imageCount: images?.length ?? 0,
				});
				logger.debug(
					'[useRemoteIntegration] Dispatching maestro:remoteCommand preview:',
					undefined,
					{ sessionId, commandPreview: command?.substring(0, 50) }
				);
				window.dispatchEvent(
					new CustomEvent('maestro:remoteCommand', {
						detail: { sessionId, command, inputMode, tabId, force, images, receiptChannel },
					})
				);
				logger.info('[useRemoteIntegration] Event dispatched successfully');
			}
		);

		return () => {
			unsubscribeRemote();
		};
	}, [sessionsRef, setActiveSessionId]);

	// Handle remote mode switches from web interface
	// This allows web mode switches to go through the same code path as desktop
	useEffect(() => {
		const unsubscribeSwitchMode = window.maestro.process.onRemoteSwitchMode(
			(sessionId: string, mode: 'ai' | 'terminal', background?: boolean) => {
				// Find the session and update its mode
				const session = sessionsRef.current.find((s) => s.id === sessionId);
				if (!session) return;

				// Only switch if mode is different
				if (session.inputMode === mode) return;

				// Background placement: mode IS the rendered surface, so switching
				// the agent the human is looking at would move their view. Nothing
				// is created here that could sit in a tab bar instead, so the only
				// honest background behaviour is to decline. Agents that are not on
				// screen switch normally - that changes no pixels.
				if (background && useSessionStore.getState().activeSessionId === sessionId) return;

				// Clear activeFileTabId when switching to terminal mode to prevent
				// orphaned file preview without tab bar
				updateSessionWith(sessionId, (s) => ({
					...s,
					inputMode: mode,
					...(mode === 'terminal' && { activeFileTabId: null }),
				}));
			}
		);

		return () => {
			unsubscribeSwitchMode();
		};
	}, [sessionsRef]);

	// Handle remote interrupts from web interface
	// This allows web interrupts to go through the same code path as desktop (handleInterrupt)
	useEffect(() => {
		const unsubscribeInterrupt = window.maestro.process.onRemoteInterrupt(
			async (sessionId: string) => {
				// Find the session
				const session = sessionsRef.current.find((s) => s.id === sessionId);
				if (!session) {
					return;
				}

				// Use the same logic as handleInterrupt
				const currentMode = session.inputMode;
				const targetSessionId =
					currentMode === 'ai' ? `${session.id}-ai` : `${session.id}-terminal`;

				try {
					// Send interrupt signal (Ctrl+C)
					await window.maestro.process.interrupt(targetSessionId);

					// Set state to idle (same as handleInterrupt)
					updateSessionWith(session.id, (s) => ({
						...s,
						state: 'idle' as SessionState,
						busySource: undefined,
						thinkingStartTime: undefined,
					}));
				} catch (error) {
					logger.error('[Remote] Failed to interrupt session:', undefined, error);
				}
			}
		);

		return () => {
			unsubscribeInterrupt();
		};
	}, [sessionsRef]);

	// Handle remote session selection from web interface
	// This allows web clients to switch the active session in the desktop app
	// If tabId is provided, also switches to that tab within the session
	useEffect(() => {
		const unsubscribeSelectSession = window.maestro.process.onRemoteSelectSession(
			(sessionId: string, tabId?: string) => {
				// Check if session exists
				const session = sessionsRef.current.find((s) => s.id === sessionId);
				if (!session) {
					return;
				}

				// Switch to the session (same as clicking in SessionList)
				setActiveSessionId(sessionId);

				// If tabId provided, also switch to that tab
				if (tabId) {
					updateSessionWith(sessionId, (s) => {
						// Check if tab exists
						if (!s.aiTabs.some((t) => t.id === tabId)) {
							return s;
						}
						return { ...s, ...aiTabFocusFields(tabId) };
					});
				}
			}
		);

		// Handle explicit Web -> Desktop tab selection and Web-Desktop inventory sync.
		const unsubscribeSelectTab = window.maestro.process.onRemoteSelectTab(
			(sessionId, tabId, remoteTabs, activeTabChanged) => {
				const currentActiveId = activeSessionIdRef.current;
				const isInventorySync = remoteTabs !== undefined;

				// A bare remote:selectTab event is an explicit Web -> Desktop navigation
				// request. A tabs_changed packet also arrives on this channel in
				// Web-Desktop, but it is primarily an inventory snapshot and must not
				// pull the browser into whichever background agent happened to change.
				if (!isInventorySync && currentActiveId !== sessionId) {
					setActiveSessionId(sessionId);
				}

				// The legacy `tabs_changed` web packet carries the complete desktop tab
				// inventory as its third argument. Reconcile that snapshot here so the
				// browser adds and removes tabs instead of only following an ID it may not
				// have. Existing tabs retain renderer-only data such as logs and drafts.
				updateSessionWith(sessionId, (s) => {
					let updatedSession = s;
					if (isInventorySync) {
						const existingById = new Map(s.aiTabs.map((tab) => [tab.id, tab]));
						const aiTabs = remoteTabs.map((remoteTab) => {
							const existing = existingById.get(remoteTab.id);
							const syncedFields = {
								id: remoteTab.id,
								agentSessionId: remoteTab.agentSessionId,
								name: remoteTab.name,
								starred: remoteTab.starred,
								usageStats: remoteTab.usageStats ?? undefined,
								createdAt: remoteTab.createdAt,
								state: remoteTab.state,
								thinkingStartTime: remoteTab.thinkingStartTime ?? undefined,
								hasUnread: remoteTab.hasUnread,
							};

							// Desktop snapshots intentionally exclude draft changes from their
							// change signature. Preserve the browser's current draft for tabs it
							// already knows so unrelated updates cannot replace newer input.
							if (existing) return { ...existing, ...syncedFields };
							return {
								...syncedFields,
								inputValue: remoteTab.inputValue,
								logs: [],
								stagedImages: [],
								saveToHistory: defaultSaveToHistory,
								showThinking: defaultShowThinking,
							};
						});
						updatedSession = { ...s, aiTabs };
						updatedSession = {
							...updatedSession,
							unifiedTabOrder: getRepairedUnifiedTabOrder(updatedSession),
						};
					}

					const targetExists = updatedSession.aiTabs.some((tab) => tab.id === tabId);
					if (!isInventorySync) {
						return targetExists
							? { ...updatedSession, ...aiTabFocusFields(tabId) }
							: updatedSession;
					}

					// Only a real desktop tab-selection change may move the browser's visible
					// tab, and only when the browser is already viewing that session. Metadata
					// changes (busy/unread/name/starred) retain the browser's local focus.
					if (activeTabChanged && currentActiveId === sessionId && targetExists) {
						return { ...updatedSession, ...aiTabFocusFields(tabId) };
					}

					// If the browser's remembered AI tab was removed, repair the dormant id
					// without clearing a currently focused file/terminal/browser surface.
					if (!updatedSession.aiTabs.some((tab) => tab.id === updatedSession.activeTabId)) {
						const visibleTabs = visibleAiTabs(updatedSession.aiTabs);
						const fallbackTabId = visibleTabs.some((tab) => tab.id === tabId)
							? tabId
							: visibleTabs[0]?.id || '';
						return { ...updatedSession, activeTabId: fallbackTabId };
					}

					return updatedSession;
				});
			}
		);

		// Handle remote new tab from web interface
		const unsubscribeNewTab = window.maestro.process.onRemoteNewTab(
			(sessionId: string, responseChannel: string, background?: boolean) => {
				let newTabId: string | null = null;

				flushSync(() => {
					updateSessionWith(sessionId, (s) => {
						// Use createTab helper. `activate: false` appends the tab without
						// touching any active-* id, so it shows up in the tab bar the way
						// a browser opens a background tab.
						const result = createTab(s, {
							saveToHistory: defaultSaveToHistory,
							showThinking: defaultShowThinking,
							activate: !background,
						});
						if (!result) return s;
						newTabId = result.tab.id;
						return result.session;
					});
				});
				// A background create must not pull the Left Bar over either.
				if (newTabId && !background) {
					setActiveSessionId(sessionId);
				}

				// Send response back with the new tab ID
				if (newTabId) {
					window.maestro.process.sendRemoteNewTabResponse(responseChannel, { tabId: newTabId });
				} else {
					window.maestro.process.sendRemoteNewTabResponse(responseChannel, null);
				}
			}
		);

		// Handle remote "new AI tab with prompt" from CLI (dispatch --new-tab).
		// Atomically creates a fresh AI tab and dispatches the prompt through the
		// same maestro:remoteCommand event path that a plain dispatch uses, so
		// downstream spawn/history/state flows are identical. A background dispatch
		// (the default) creates the new tab without focus so the user's current view
		// is preserved; `dispatch --focus` makes the new tab active instead. flushSync
		// forces React to commit the new tab into session state before we fire the event,
		// so the downstream handler can resolve the freshly-created tabId (which we
		// always pass explicitly) instead of racing on a stale snapshot.
		// Ack the renderer result on responseChannel so the CLI only reports
		// success when a tab was actually created.
		const unsubscribeNewTabWithPrompt = window.maestro.process.onRemoteNewAITabWithPrompt(
			(sessionId: string, prompt: string, responseChannel: string, background?: boolean) => {
				// Guard: the downstream maestro:remoteCommand handler drops commands
				// for missing or busy sessions. Check here so we don't create an
				// orphan tab and falsely ack success.
				const targetSession = sessionsRef.current.find((s) => s.id === sessionId);
				if (!targetSession) {
					logger.warn(
						'[useRemoteIntegration] onRemoteNewAITabWithPrompt: session not found, dropping prompt'
					);
					window.maestro.process.sendRemoteNewAITabWithPromptResponse(responseChannel, false);
					return;
				}
				if (targetSession.state === 'busy') {
					logger.warn(
						'[useRemoteIntegration] onRemoteNewAITabWithPrompt: session is busy, dropping prompt'
					);
					window.maestro.process.sendRemoteNewAITabWithPromptResponse(responseChannel, false);
					return;
				}
				let createdTabId: string | undefined;
				flushSync(() => {
					updateSessionWith(sessionId, (s) => {
						const result = createTab(s, {
							saveToHistory: defaultSaveToHistory,
							showThinking: defaultShowThinking,
							// Background dispatch is the default (`--focus` opts into the
							// foreground): create the tab without making it active so the
							// user's current view is preserved.
							activate: !background,
						});
						if (!result) return s;
						createdTabId = result.tab.id;
						return result.session;
					});
					if (createdTabId && !background) {
						setActiveSessionId(sessionId);
					}
				});
				if (!createdTabId) {
					logger.warn(
						'[useRemoteIntegration] onRemoteNewAITabWithPrompt: createTab failed, dropping prompt'
					);
					window.maestro.process.sendRemoteNewAITabWithPromptResponse(responseChannel, false);
					return;
				}
				// Pass the new tab id explicitly so the renderer writes into the tab
				// we just created - without it, useRemoteHandlers would fall back to
				// activeTabId, which is correct here but would race in any future
				// caller that doesn't atomically setActiveSessionId.
				window.dispatchEvent(
					new CustomEvent('maestro:remoteCommand', {
						detail: { sessionId, command: prompt, inputMode: 'ai', tabId: createdTabId },
					})
				);
				window.maestro.process.sendRemoteNewAITabWithPromptResponse(
					responseChannel,
					true,
					createdTabId
				);
			}
		);

		// Handle remote close tab from web interface
		const unsubscribeCloseTab = window.maestro.process.onRemoteCloseTab(
			(sessionId: string, tabId: string) => {
				updateSessionWith(sessionId, (s) => {
					// Use closeTab helper (handles last tab by creating a fresh one)
					const result = closeTab(s, tabId);
					return result?.session ?? s;
				});
			}
		);

		// Handle remote rename tab from web interface
		const unsubscribeRenameTab = window.maestro.process.onRemoteRenameTab(
			(sessionId: string, tabId: string, newName: string) => {
				const session = sessionsRef.current.find((s) => s.id === sessionId);
				// Find the tab to get its agentSessionId for persistence
				const tab = session?.aiTabs.find((t) => t.id === tabId);
				if (!session || !tab) return;

				// Persist name to agent session metadata (async, fire and forget)
				// Use projectRoot (not cwd) for consistent session storage access
				if (tab.agentSessionId) {
					const agentId = session.toolType || 'claude-code';
					if (agentId === 'claude-code') {
						window.maestro.claude
							.updateSessionName(session.projectRoot, tab.agentSessionId, newName || '')
							.catch((err) => logger.error('Failed to persist tab name:', undefined, err));
					} else {
						window.maestro.agentSessions
							.setSessionName(agentId, session.projectRoot, tab.agentSessionId, newName || null)
							.catch((err) => logger.error('Failed to persist tab name:', undefined, err));
					}
					// Also update past history entries with this agentSessionId
					window.maestro.history
						.updateSessionName(tab.agentSessionId, newName || '')
						.catch((err) =>
							logger.error('Failed to update history session names:', undefined, err)
						);
				}

				updateAiTab(sessionId, tabId, (t) => ({ ...t, name: newName || null }));
			}
		);

		// Handle remote star tab from web interface
		const unsubscribeStarTab = window.maestro.process.onRemoteStarTab(
			(sessionId: string, tabId: string, starred: boolean) => {
				const session = sessionsRef.current.find((s) => s.id === sessionId);
				const tab = session?.aiTabs.find((t) => t.id === tabId);
				if (!session || !tab?.agentSessionId) return;

				// Persist starred state and broadcast the change (same logic as
				// desktop handleTabStar) so the Left Bar's starred cache refreshes.
				persistTabStarred(session, tab, starred);

				updateAiTab(sessionId, tabId, (t) => ({ ...t, starred }));
			}
		);

		// Handle remote reorder tab from web interface
		const unsubscribeReorderTab = window.maestro.process.onRemoteReorderTab(
			(sessionId: string, fromIndex: number, toIndex: number) => {
				updateSessionWith(sessionId, (s) => {
					if (!s.aiTabs) return s;
					const tabs = [...s.aiTabs];
					const [movedTab] = tabs.splice(fromIndex, 1);
					tabs.splice(toIndex, 0, movedTab);
					return { ...s, aiTabs: tabs };
				});
			}
		);

		// Handle remote bookmark toggle from web interface
		const unsubscribeToggleBookmark = window.maestro.process.onRemoteToggleBookmark(
			(sessionId: string) => {
				updateSessionWith(sessionId, (s) => ({ ...s, bookmarked: !s.bookmarked }));
			}
		);

		// Handle remote "enqueue command" from the CLI (`dispatch --queue`). The
		// renderer owns the authoritative execution queue, so the queue-vs-dispatch
		// decision lives here: a busy target joins `session.executionQueue` (FIFO);
		// an idle target dispatches immediately through the same maestro:remoteCommand
		// path as a plain dispatch. The ack carries the queue outcome so the CLI can
		// report position. Enqueued items are byte-identical to UI-queued items, so
		// they render in the ExecutionQueueBrowser/Indicator, are editable/reorderable/
		// removable, and the closed-tab resolver (resolveQueuedItemTarget) applies at
		// drain time.
		const unsubscribeEnqueueCommand = window.maestro.process.onRemoteEnqueueCommand(
			(
				sessionId: string,
				command: string,
				responseChannel: string,
				_inputMode?: 'ai' | 'terminal',
				tabId?: string,
				images?: string[],
				background?: boolean
			) => {
				const reply = (result: {
					success: boolean;
					tabId?: string;
					queued?: boolean;
					queuePosition?: number;
					queueLength?: number;
					itemId?: string;
					error?: string;
					reason?: 'session-not-found' | 'tab-not-found' | 'no-ai-tabs';
				}) => window.maestro.process.sendRemoteEnqueueCommandResponse(responseChannel, result);

				try {
					const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
					if (!session) {
						reply({ success: false, error: 'Session not found', reason: 'session-not-found' });
						return;
					}

					// Resolve the target tab. An explicit --tab that no longer exists is
					// an error - never silently reroute to the active tab, which would
					// mislead callers chaining the returned tabId. No --tab -> active tab.
					// The `tab-not-found` reason is what lets a dispatch callback (which
					// has no caller listening for the error) fall back to agent-level
					// delivery instead of dropping the wake; see deliverCallback.
					const requestedTab = tabId ? session.aiTabs?.find((t) => t.id === tabId) : undefined;
					if (tabId && !requestedTab) {
						reply({ success: false, error: `Tab not found: ${tabId}`, reason: 'tab-not-found' });
						return;
					}
					const targetTab = requestedTab ?? getActiveTab(session);
					if (!targetTab) {
						reply({ success: false, error: 'Session has no AI tabs', reason: 'no-ai-tabs' });
						return;
					}
					const resolvedTabId = targetTab.id;

					// Idle target: no line to wait in, dispatch now through the shared
					// remote-command path (identical to a plain `dispatch`). Respect the
					// dispatch --focus opt-in via `background`.
					if (session.state !== 'busy') {
						if (!background) {
							setActiveSessionId(sessionId);
						}
						window.dispatchEvent(
							new CustomEvent('maestro:remoteCommand', {
								detail: { sessionId, command, inputMode: 'ai', tabId: resolvedTabId, images },
							})
						);
						reply({ success: true, tabId: resolvedTabId, queued: false });
						return;
					}

					// Busy target: get in line. The item is built by the shared builder,
					// so it is byte-identical to one the composer would have queued -
					// including the `@mention` intent flags (fired at drain time, not
					// here) and the model/effort capture that keeps a queued turn running
					// under the settings it was queued with.
					const queuedItem: QueuedItem = buildQueuedMessageItem({
						session,
						tab: targetTab,
						text: command,
						images,
					});

					// Position is deterministic from the snapshot we already read: the item
					// is appended to the tail, so it lands at length+1 (1-based). Computing
					// it here (not inside the state updater) keeps the returned position
					// independent of when the store applies the update.
					const queueLength = (session.executionQueue?.length ?? 0) + 1;
					updateSessionWith(sessionId, (s) => ({
						...s,
						executionQueue: [...s.executionQueue, queuedItem],
					}));

					reply({
						success: true,
						tabId: resolvedTabId,
						queued: true,
						// 1-based position from the front; the item sits at the tail.
						queuePosition: queueLength,
						queueLength,
						itemId: queuedItem.id,
					});
				} catch (error) {
					logger.error('[useRemoteIntegration] onRemoteEnqueueCommand failed:', undefined, error);
					reply({
						success: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		);

		// Handle remote "list queue" from the CLI (`queue list`). Read-only snapshot
		// of the authoritative executionQueue(s) so scripts can inspect what is
		// pending. Reads the store directly (useSessionStore.getState) so the snapshot
		// is always current, per the store's outside-React contract.
		const unsubscribeListQueue = window.maestro.process.onRemoteListQueue(
			(sessionId: string | undefined, responseChannel: string) => {
				try {
					const sessions = useSessionStore.getState().sessions;
					const relevant = sessionId
						? sessions.filter((s) => s.id === sessionId)
						: sessions.filter((s) => (s.executionQueue?.length ?? 0) > 0);
					const queues = relevant.map((s) => ({
						sessionId: s.id,
						name: s.name,
						state: s.state,
						items: (s.executionQueue ?? []).map((item) => ({
							id: item.id,
							timestamp: item.timestamp,
							tabId: item.tabId,
							type: item.type,
							...(item.text !== undefined ? { text: item.text } : {}),
							...(item.command !== undefined ? { command: item.command } : {}),
							...(item.commandArgs !== undefined ? { commandArgs: item.commandArgs } : {}),
							...(item.tabName !== undefined ? { tabName: item.tabName } : {}),
							...(item.paused !== undefined ? { paused: item.paused } : {}),
						})),
					}));
					window.maestro.process.sendRemoteListQueueResponse(responseChannel, {
						success: true,
						queues,
					});
				} catch (error) {
					logger.error('[useRemoteIntegration] onRemoteListQueue failed:', undefined, error);
					window.maestro.process.sendRemoteListQueueResponse(responseChannel, {
						success: false,
						queues: [],
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		);

		// Handle remote "remove queue item" from the CLI (`queue remove`). Drops the
		// item by id from the authoritative queue, exactly like the UI trash action.
		const unsubscribeRemoveQueueItem = window.maestro.process.onRemoteRemoveQueueItem(
			(sessionId: string, itemId: string, responseChannel: string) => {
				try {
					// Determine the outcome from the current store snapshot, then mutate.
					// Keeps the returned `removed` independent of update timing.
					const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
					const removed = !!session?.executionQueue?.some((i) => i.id === itemId);
					if (removed) {
						updateSessionWith(sessionId, (s) => ({
							...s,
							executionQueue: s.executionQueue.filter((i) => i.id !== itemId),
						}));
					}
					window.maestro.process.sendRemoteRemoveQueueItemResponse(responseChannel, {
						success: true,
						removed,
					});
				} catch (error) {
					logger.error('[useRemoteIntegration] onRemoteRemoveQueueItem failed:', undefined, error);
					window.maestro.process.sendRemoteRemoveQueueItemResponse(responseChannel, {
						success: false,
						removed: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		);

		return () => {
			unsubscribeSelectSession();
			unsubscribeSelectTab();
			unsubscribeNewTab();
			unsubscribeNewTabWithPrompt();
			unsubscribeCloseTab();
			unsubscribeRenameTab();
			unsubscribeStarTab();
			unsubscribeReorderTab();
			unsubscribeToggleBookmark();
			unsubscribeEnqueueCommand();
			unsubscribeListQueue();
			unsubscribeRemoveQueueItem();
		};
	}, [
		sessionsRef,
		activeSessionIdRef,
		setActiveSessionId,
		defaultSaveToHistory,
		defaultShowThinking,
	]);

	// Handle remote open file tab from web/CLI interface
	// Dispatches a CustomEvent for App.tsx to handle (avoids hook ordering issues)
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteOpenFileTab(
			(
				sessionId: string,
				filePath: string,
				options: { background: boolean; switchToAgent: boolean }
			) => {
				window.dispatchEvent(
					new CustomEvent('maestro:openFileTab', {
						detail: {
							sessionId,
							filePath,
							background: options.background,
							switchToAgent: options.switchToAgent,
						},
					})
				);
			}
		);
		return () => {
			unsubscribe();
		};
	}, []);

	// Handle a remote request to open a modal / dashboard (`maestro-cli open`).
	// The main process has already validated the surface and tab, so this is a
	// straight hand-off to the shared opener.
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteOpenModal((params) => {
			openUiSurface(params.surface, params.tab);
		});
		return () => {
			unsubscribe();
		};
	}, []);

	// Handle a remote request to graph a set of documents (`maestro-cli
	// open-graph`). Paths arrive absolute; the graph addresses files relative to
	// its own root, so they are relativized against the target agent here rather
	// than in the main process, which does not know which root the view uses.
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteOpenDocumentGraph((params) => {
			const session = useSessionStore
				.getState()
				.sessions.find((s: Session) => s.id === params.sessionId);
			const root = session?.projectRoot || session?.cwd || '';
			const relative = (absolutePath: string): string => {
				if (!root) return absolutePath;
				if (absolutePath === root) return '';
				const prefix = root.endsWith('/') ? root : `${root}/`;
				return absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : absolutePath;
			};

			// Focusing the agent first: the graph is a full-window view on ONE
			// agent, so rendering it under a different agent than the one the user
			// is looking at would put it somewhere they cannot see.
			if (session) setActiveSessionId(params.sessionId);

			useFileExplorerStore.getState().openGraphScope({
				files: params.files?.length ? params.files.map(relative) : undefined,
				directory: params.directory !== undefined ? relative(params.directory) : undefined,
				focusPath: params.focusPath ? relative(params.focusPath) : undefined,
			});
		});
		return () => {
			unsubscribe();
		};
	}, [setActiveSessionId]);

	// Handle remote refresh file tree from web/CLI interface
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteRefreshFileTree((sessionId: string) => {
			requestFileTreeRefresh(sessionId);
		});
		return () => {
			unsubscribe();
		};
	}, []);

	// Handle remote toast notifications from CLI/web interface.
	// Resolves the agent (if provided) so the toast carries project/tab metadata,
	// enabling click-to-jump behavior.
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteNotifyToast((params) => {
			const {
				title,
				message,
				color,
				duration,
				dismissible,
				sessionId,
				sourceAgent,
				tabId: explicitTabId,
				actionUrl,
				actionLabel,
				clickAction,
			} = params;
			// Resolve agent metadata for the header strip. Only stamp a tab on
			// the toast when the caller explicitly passed one - otherwise the
			// agent's currently-focused tab would leak onto every agent-scoped
			// toast (e.g. cron-fired notifications), which is misleading.
			// An explicit `sourceAgent` label wins over the store-resolved name:
			// it's store-independent, so cron/watchdog toasts always show who
			// fired them even when that agent isn't loaded in the Left Bar.
			let project: string | undefined = sourceAgent;
			let tabId: string | undefined = explicitTabId;
			let tabName: string | undefined;
			if (sessionId) {
				const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
				if (!project) project = session?.name;
				if (explicitTabId) {
					const targetTab = session?.aiTabs?.find((t) => t.id === explicitTabId);
					if (targetTab) {
						tabId = targetTab.id;
						tabName = targetTab.name ?? undefined;
					}
				}
			}
			notifyToast({
				color,
				title,
				message,
				duration: duration !== undefined ? duration * 1000 : undefined,
				dismissible,
				sessionId,
				tabId,
				tabName,
				project,
				actionUrl,
				actionLabel,
				clickAction,
			});
		});
		return () => {
			unsubscribe();
		};
	}, []);

	// Handle remote center-flash notifications from CLI/web interface.
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteNotifyCenterFlash((params) => {
			notifyCenterFlash({
				message: params.message,
				detail: params.detail,
				color: params.color,
				duration: params.duration,
			});
		});
		return () => {
			unsubscribe();
		};
	}, []);

	// Handle remote cadenza-view operations (open/update/close) from CLI/web interface.
	useEffect(() => {
		// Guard: on a dev hot-restart the renderer can mount before the rebuilt
		// preload exposes newer bridge methods. Degrade gracefully instead of
		// crashing the whole app into the error boundary.
		const proc = window.maestro?.process;
		if (typeof proc?.onRemoteCadenza !== 'function') return;
		const unsubscribe = proc.onRemoteCadenza((params) => {
			applyCadenzaPayload(params);
		});
		// Flash a cadenza when a chat chip points at it. Main routes the flash here
		// only in the in-app fallback case (no HUD window); normally it goes to the HUD.
		const unsubscribeFlash = proc.onRemoteCadenzaFlash?.((id) => {
			useCadenzaStore.getState().flashItem(id);
		});
		return () => {
			unsubscribe();
			unsubscribeFlash?.();
		};
	}, []);

	// Handle remote movement operations and Concerto progress reports from CLI/web.
	useEffect(() => {
		// Guard: on a dev hot-restart the renderer can mount before the rebuilt
		// preload exposes newer bridge methods. Degrade gracefully instead of
		// crashing the whole app into the error boundary.
		const proc = window.maestro?.process;
		if (typeof proc?.onRemoteMovement !== 'function') return;
		const unsubscribe = proc.onRemoteMovement((params, responseChannel) => {
			const reply = (applied: boolean) => {
				if (responseChannel) proc.sendMovementAppliedResponse?.(responseChannel, applied);
			};
			if (params.op === 'progress') {
				if (!params.id || !params.phase || !params.title) {
					reply(false);
					return;
				}
				recordConcertoCreationActivity(
					params.id,
					params.phase,
					params.revision,
					params.title,
					params.step,
					params.steps,
					params.notes
				);
				reply(true);
				return;
			}
			try {
				flushSync(() => applyMovementPayload(params));
			} catch {
				reply(false);
				return;
			}
			if (params.op === 'clear') {
				useConcertoCreationActivityStore.getState().clear();
			} else if (params.op === 'remove' && params.id) {
				useConcertoCreationActivityStore.getState().clearMovement(params.id);
			} else if (params.id) {
				let phase: ConcertoCreationPhase = 'refining';
				if (params.op === 'begin' || params.op === 'add') phase = 'composing';
				else if (
					useMovementStore.getState().items.find((movement) => movement.id === params.id)?.preparing
				) {
					phase = 'composing';
				} else if (
					params.op === 'move' ||
					(params.body === undefined && params.title === undefined && params.viewType === undefined)
				) {
					phase = 'arranging';
				}
				recordConcertoCreationActivity(params.id, phase, params.revision);
			}
			if (params.id && params.revision !== undefined) {
				void getConcertoDesignerFrameSnapshot('movement', params.id, 3500, params.revision)
					.then((snapshot) => reply(snapshot !== null))
					.catch(() => reply(false));
				return;
			}
			reply(true);
		});
		return () => {
			unsubscribe();
		};
	}, []);

	// Answer `movement state` reads: the main process sends a request with a
	// response channel; reply with the current movement snapshot (items + size).
	useEffect(() => {
		const proc = window.maestro?.process;
		if (typeof proc?.onRequestMovementState !== 'function') return;
		const unsubscribe = proc.onRequestMovementState((responseChannel: string) => {
			proc.sendMovementStateResponse?.(responseChannel, getMovementSnapshot());
		});
		return () => unsubscribe();
	}, []);

	// Designer feedback for HTML Movements: report the live iframe crop and
	// diagnostics so main can capture exactly what the user sees.
	useEffect(() => {
		const proc = window.maestro?.process;
		if (typeof proc?.onRequestMovementDesignerInspection !== 'function') return;
		const unsubscribe = proc.onRequestMovementDesignerInspection(
			(id, expectedRevision, responseChannel) => {
				// Inspection is read-only for the iframe, but the requested panel must be
				// visible above overlapping peers for Chromium's compositor crop to show it.
				flushSync(() => useMovementStore.getState().surfaceItem(id));
				recordConcertoCreationActivity(id, 'reviewing', expectedRevision);
				void waitForMovementInspectionPaint()
					.then(() => getConcertoDesignerFrameSnapshot('movement', id, undefined, expectedRevision))
					.then((snapshot) =>
						proc.sendMovementDesignerInspectionResponse?.(responseChannel, snapshot)
					)
					.catch(() => proc.sendMovementDesignerInspectionResponse?.(responseChannel, null));
			}
		);
		return () => unsubscribe();
	}, []);

	// Selector-scoped click/type actions stay inside the sandboxed mockup and
	// let an agent verify interactive states before taking another screenshot.
	useEffect(() => {
		const proc = window.maestro?.process;
		if (typeof proc?.onRequestMovementDesignerInteraction !== 'function') return;
		const unsubscribe = proc.onRequestMovementDesignerInteraction(
			(id, action, expectedRevision, responseChannel) => {
				recordConcertoCreationActivity(id, 'testing', expectedRevision);
				void interactWithConcertoDesignerFrame('movement', id, action, undefined, expectedRevision)
					.then((result) => proc.sendMovementDesignerInteractionResponse?.(responseChannel, result))
					.catch((error) =>
						proc.sendMovementDesignerInteractionResponse?.(responseChannel, {
							ok: false,
							action: action.kind,
							selector: action.selector,
							message: error instanceof Error ? error.message : String(error),
						})
					);
			}
		);
		return () => unsubscribe();
	}, []);

	// Handle remote open browser tab from CLI/web interface.
	// responseChannel is forwarded so the App-level listener can ack the
	// CLI once the browser tab actually exists.
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteOpenBrowserTab(
			(
				sessionId: string,
				url: string,
				responseChannel: string,
				options: { background?: boolean }
			) => {
				window.dispatchEvent(
					new CustomEvent('maestro:openBrowserTab', {
						detail: { sessionId, url, responseChannel, background: options?.background === true },
					})
				);
			}
		);
		return () => {
			unsubscribe();
		};
	}, []);

	// Handle remote close browser tab from CLI/web interface. The owning agent
	// is resolved by tab id in the App-level listener, so the caller only needs
	// the id handed back by open-browser.
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteCloseBrowserTab(
			(tabId: string, responseChannel: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:closeBrowserTab', {
						detail: { tabId, responseChannel },
					})
				);
			}
		);
		return () => {
			unsubscribe();
		};
	}, []);

	// Handle remote open terminal tab from CLI/web interface.
	// responseChannel is forwarded so the App-level listener can ack the
	// CLI once the terminal tab actually exists.
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteOpenTerminalTab(
			(
				sessionId: string,
				config: { cwd?: string; shell?: string; name?: string | null; command?: string },
				responseChannel: string,
				options: { background?: boolean }
			) => {
				window.dispatchEvent(
					new CustomEvent('maestro:openTerminalTab', {
						detail: {
							sessionId,
							config,
							responseChannel,
							background: options?.background === true,
						},
					})
				);
			}
		);
		return () => {
			unsubscribe();
		};
	}, []);

	// Handle remote writes into an existing terminal tab from CLI/web interface.
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteWriteTerminalTab(
			(sessionId: string, payload: { tabRef?: string; data: string }, responseChannel: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:writeTerminalTab', {
						detail: { sessionId, ...payload, responseChannel },
					})
				);
			}
		);
		return () => {
			unsubscribe();
		};
	}, []);

	// Handle remote terminal tab listing from CLI/web interface.
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteListTerminalTabs(
			(sessionId: string | undefined, responseChannel: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:listTerminalTabs', {
						detail: { sessionId, responseChannel },
					})
				);
			}
		);
		return () => {
			unsubscribe();
		};
	}, []);

	// Handle remote refresh auto-run docs from web/CLI interface
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteRefreshAutoRunDocs(
			(sessionId: string, background?: boolean) => {
				window.dispatchEvent(
					new CustomEvent('maestro:refreshAutoRunDocs', {
						detail: { sessionId, background },
					})
				);
			}
		);
		return () => {
			unsubscribe();
		};
	}, []);

	// Handle remote configure auto-run from CLI/web interface
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteConfigureAutoRun(
			(sessionId: string, config: any, responseChannel: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:configureAutoRun', {
						detail: { sessionId, config, responseChannel },
					})
				);
			}
		);
		return () => {
			unsubscribe();
		};
	}, []);

	// Handle a remote Goal-Driven Auto Run launch (`goal-run --visible`) from the CLI
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteLaunchGoalRun(
			(
				sessionId: string,
				config: {
					goal: string;
					exitCriteria?: string;
					maxIterations?: number | null;
					model?: string;
					effort?: string;
				},
				responseChannel: string
			) => {
				window.dispatchEvent(
					new CustomEvent('maestro:launchGoalRun', {
						detail: { sessionId, config, responseChannel },
					})
				);
			}
		);
		return () => {
			unsubscribe();
		};
	}, []);

	// Handle remote create-worktree-agent from the CLI. Creates a new agent in a
	// git worktree branched off a parent agent, without an Auto Run playbook.
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteCreateWorktreeSession(
			(parentSessionId: string, config: any, responseChannel: string, background?: boolean) => {
				window.dispatchEvent(
					new CustomEvent('maestro:createWorktreeSession', {
						detail: { parentSessionId, config, responseChannel, background },
					})
				);
			}
		);
		return () => {
			unsubscribe();
		};
	}, []);

	// Handle remote set Auto Run folder from web interface - repoints a session
	// at a different `.maestro/` folder, mirroring desktop's `dialog.selectFolder`
	// + `handleAutoRunFolderSelected` flow.
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteSetAutoRunFolder(
			(sessionId: string, folderPath: string, responseChannel: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:setAutoRunFolder', {
						detail: { sessionId, folderPath, responseChannel },
					})
				);
			}
		);
		return () => {
			unsubscribe();
		};
	}, []);

	// Handle remote get auto-run docs from web interface
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteGetAutoRunDocs(
			(sessionId: string, responseChannel: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:getAutoRunDocs', {
						detail: { sessionId, responseChannel },
					})
				);
			}
		);
		return () => {
			unsubscribe();
		};
	}, []);

	// Handle remote get auto-run doc content from web interface
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteGetAutoRunDocContent(
			(sessionId: string, filename: string, responseChannel: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:getAutoRunDocContent', {
						detail: { sessionId, filename, responseChannel },
					})
				);
			}
		);
		return () => {
			unsubscribe();
		};
	}, []);

	// Handle remote save auto-run doc from web interface
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteSaveAutoRunDoc(
			(sessionId: string, filename: string, content: string, responseChannel: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:saveAutoRunDoc', {
						detail: { sessionId, filename, content, responseChannel },
					})
				);
			}
		);
		return () => {
			unsubscribe();
		};
	}, []);

	// Handle remote stop auto-run from web interface
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteStopAutoRun((sessionId: string) => {
			window.dispatchEvent(
				new CustomEvent('maestro:stopAutoRun', {
					detail: { sessionId },
				})
			);
		});
		return () => {
			unsubscribe();
		};
	}, []);

	// Handle remote reset-tasks from web interface
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteResetAutoRunDocTasks(
			(sessionId: string, filename: string, responseChannel: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:resetAutoRunDocTasks', {
						detail: { sessionId, filename, responseChannel },
					})
				);
			}
		);
		return () => {
			unsubscribe();
		};
	}, []);

	// Handle remote auto-run error-recovery actions (resume / skip / abort) from web
	useEffect(() => {
		const unsubResume = window.maestro.process.onRemoteResumeAutoRunError(
			(sessionId: string, responseChannel: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:resumeAutoRunError', {
						detail: { sessionId, responseChannel },
					})
				);
			}
		);
		const unsubSkip = window.maestro.process.onRemoteSkipAutoRunDocument(
			(sessionId: string, responseChannel: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:skipAutoRunDocument', {
						detail: { sessionId, responseChannel },
					})
				);
			}
		);
		const unsubAbort = window.maestro.process.onRemoteAbortAutoRunError(
			(sessionId: string, responseChannel: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:abortAutoRunError', {
						detail: { sessionId, responseChannel },
					})
				);
			}
		);
		return () => {
			unsubResume();
			unsubSkip();
			unsubAbort();
		};
	}, []);

	// Handle remote playbook CRUD from web interface (request-response)
	useEffect(() => {
		const unsubList = window.maestro.process.onRemoteListPlaybooks(
			(sessionId: string, responseChannel: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:listPlaybooks', {
						detail: { sessionId, responseChannel },
					})
				);
			}
		);
		const unsubCreate = window.maestro.process.onRemoteCreatePlaybook(
			(sessionId: string, playbook: unknown, responseChannel: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:createPlaybook', {
						detail: { sessionId, playbook, responseChannel },
					})
				);
			}
		);
		const unsubUpdate = window.maestro.process.onRemoteUpdatePlaybook(
			(sessionId: string, playbookId: string, updates: unknown, responseChannel: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:updatePlaybook', {
						detail: { sessionId, playbookId, updates, responseChannel },
					})
				);
			}
		);
		const unsubDelete = window.maestro.process.onRemoteDeletePlaybook(
			(sessionId: string, playbookId: string, responseChannel: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:deletePlaybook', {
						detail: { sessionId, playbookId, responseChannel },
					})
				);
			}
		);
		return () => {
			unsubList();
			unsubCreate();
			unsubUpdate();
			unsubDelete();
		};
	}, []);

	// Handle remote set setting from web interface
	// Uses the existing settings infrastructure via window.maestro.settings.set()
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteSetSetting(
			async (key: string, value: unknown, responseChannel: string) => {
				try {
					await window.maestro.settings.set(key, value);
					window.maestro.process.sendRemoteSetSettingResponse(responseChannel, true);
				} catch {
					window.maestro.process.sendRemoteSetSettingResponse(responseChannel, false);
				}
			}
		);
		return () => {
			unsubscribe();
		};
	}, []);

	// Handle remote get git status from web interface
	// Uses existing git IPC infrastructure (window.maestro.git.status + window.maestro.git.branch)
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteGetGitStatus(
			async (sessionId: string, responseChannel: string) => {
				try {
					// Look up the session's cwd
					const session = sessionsRef.current.find((s) => s.id === sessionId);
					if (!session) {
						window.maestro.process.sendRemoteGetGitStatusResponse(responseChannel, {
							branch: '',
							files: [],
							ahead: 0,
							behind: 0,
						});
						return;
					}

					const cwd = session.cwd;

					// Run git status --porcelain and git branch in parallel
					const [statusResult, branchResult] = await Promise.all([
						window.maestro.git.status(cwd),
						window.maestro.git.branch(cwd),
					]);

					// Parse status output
					const statusLines = (statusResult.stdout || '')
						.replace(/\s+$/, '')
						.split('\n')
						.filter((line: string) => line.length > 0);

					const files = statusLines.map((line: string) => {
						const status = line.substring(0, 2);
						const pathField = line.substring(3);
						const renameParts = pathField.split(' -> ');
						const filePath = renameParts[renameParts.length - 1] || pathField;
						// Staged if index column (first char) is not space or ?
						const staged = status[0] !== ' ' && status[0] !== '?';
						return { path: filePath, status: status.trim(), staged };
					});

					const branch = (branchResult.stdout || '').trim();

					// Get ahead/behind info
					let ahead = 0;
					let behind = 0;
					try {
						const infoResult = await window.maestro.git.info(cwd);
						ahead = infoResult.ahead || 0;
						behind = infoResult.behind || 0;
					} catch {
						// ahead/behind not available, that's fine
					}

					window.maestro.process.sendRemoteGetGitStatusResponse(responseChannel, {
						branch,
						files,
						ahead,
						behind,
					});
				} catch {
					window.maestro.process.sendRemoteGetGitStatusResponse(responseChannel, {
						branch: '',
						files: [],
						ahead: 0,
						behind: 0,
					});
				}
			}
		);
		return () => {
			unsubscribe();
		};
	}, []);

	// Handle remote get git diff from web interface
	// Uses existing git IPC infrastructure (window.maestro.git.diff)
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteGetGitDiff(
			async (sessionId: string, filePath: string | undefined, responseChannel: string) => {
				try {
					// Look up the session's cwd
					const session = sessionsRef.current.find((s) => s.id === sessionId);
					if (!session) {
						window.maestro.process.sendRemoteGetGitDiffResponse(responseChannel, {
							diff: '',
							files: [],
						});
						return;
					}

					const cwd = session.cwd;
					const diffResult = await window.maestro.git.diff(cwd, filePath);
					const diff = diffResult.stdout || '';

					// Extract changed file paths from diff output
					const fileMatches = diff.match(/^diff --git a\/.+ b\/(.+)$/gm) || [];
					const files = fileMatches
						.map((line: string) => {
							const match = line.match(/^diff --git a\/.+ b\/(.+)$/);
							return match ? match[1] : '';
						})
						.filter(Boolean);

					window.maestro.process.sendRemoteGetGitDiffResponse(responseChannel, {
						diff,
						files,
					});
				} catch {
					window.maestro.process.sendRemoteGetGitDiffResponse(responseChannel, {
						diff: '',
						files: [],
					});
				}
			}
		);
		return () => {
			unsubscribe();
		};
	}, []);

	// Handle remote session/group management from web interface
	// These dispatch CustomEvents for App.tsx to handle via existing session/group management hooks
	useEffect(() => {
		const unsubscribeCreateSession = window.maestro.process.onRemoteCreateSession(
			(
				name: string,
				toolType: string,
				cwd: string,
				groupId: string | undefined,
				config: Record<string, unknown> | undefined,
				responseChannel: string,
				background?: boolean
			) => {
				window.dispatchEvent(
					new CustomEvent('maestro:remoteCreateSession', {
						detail: { name, toolType, cwd, groupId, config, responseChannel, background },
					})
				);
			}
		);

		const unsubscribeDeleteSession = window.maestro.process.onRemoteDeleteSession(
			(sessionId: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:remoteDeleteSession', {
						detail: { sessionId },
					})
				);
			}
		);

		const unsubscribeRenameSession = window.maestro.process.onRemoteRenameSession(
			(sessionId: string, newName: string, responseChannel: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:remoteRenameSession', {
						detail: { sessionId, newName, responseChannel },
					})
				);
			}
		);

		const unsubscribeUpdateSessionCwd = window.maestro.process.onRemoteUpdateSessionCwd(
			(sessionId: string, newCwd: string, responseChannel: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:remoteUpdateSessionCwd', {
						detail: { sessionId, newCwd, responseChannel },
					})
				);
			}
		);

		const unsubscribeUpdateSessionSsh = window.maestro.process.onRemoteUpdateSessionSsh(
			(sessionId: string, sshPatch: Record<string, unknown>, responseChannel: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:remoteUpdateSessionSsh', {
						detail: { sessionId, sshPatch, responseChannel },
					})
				);
			}
		);

		const unsubscribeUpdateSessionConfig = window.maestro.process.onRemoteUpdateSessionConfig(
			(sessionId: string, configPatch: Record<string, unknown>, responseChannel: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:remoteUpdateSessionConfig', {
						detail: { sessionId, configPatch, responseChannel },
					})
				);
			}
		);

		const unsubscribeCreateGroup = window.maestro.process.onRemoteCreateGroup(
			(
				name: string,
				emoji: string | undefined,
				parentGroupId: string | undefined,
				responseChannel: string
			) => {
				window.dispatchEvent(
					new CustomEvent('maestro:remoteCreateGroup', {
						detail: { name, emoji, parentGroupId, responseChannel },
					})
				);
			}
		);

		const unsubscribeRenameGroup = window.maestro.process.onRemoteRenameGroup(
			(groupId: string, name: string, responseChannel: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:remoteRenameGroup', {
						detail: { groupId, name, responseChannel },
					})
				);
			}
		);

		const unsubscribeDeleteGroup = window.maestro.process.onRemoteDeleteGroup((groupId: string) => {
			window.dispatchEvent(
				new CustomEvent('maestro:remoteDeleteGroup', {
					detail: { groupId },
				})
			);
		});

		const unsubscribeMoveSessionToGroup = window.maestro.process.onRemoteMoveSessionToGroup(
			(sessionId: string, groupId: string | null, responseChannel: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:remoteMoveSessionToGroup', {
						detail: { sessionId, groupId, responseChannel },
					})
				);
			}
		);

		return () => {
			unsubscribeCreateSession();
			unsubscribeDeleteSession();
			unsubscribeRenameSession();
			unsubscribeUpdateSessionCwd();
			unsubscribeUpdateSessionSsh();
			unsubscribeUpdateSessionConfig();
			unsubscribeCreateGroup();
			unsubscribeRenameGroup();
			unsubscribeDeleteGroup();
			unsubscribeMoveSessionToGroup();
		};
	}, []);

	// Broadcast tab changes to web clients when tabs, activeTabId, or tab properties change
	// PERFORMANCE FIX: This effect was previously missing its dependency array, causing it to
	// run on EVERY render (including every keystroke). Now it only runs when isLiveMode changes,
	// and uses the sessionsRef to avoid reacting to every session state change.
	// The internal comparison logic ensures broadcasts only happen when actually needed.
	const prevTabsRef = useRef<
		Map<string, { tabCount: number; activeTabId: string; tabsHash: string }>
	>(new Map());

	// Track previous session states for broadcasting state changes to web clients
	// This is separate from tab changes because session state (busy/idle) changes need
	// to be broadcast immediately for proper UI feedback on the web interface
	const prevSessionStatesRef = useRef<Map<string, string>>(new Map());

	// Only set up the interval when live mode is active
	useEffect(() => {
		// Skip entirely if not in live mode - no web clients to broadcast to
		if (!isLiveMode) return;
		clearDesktopAiTabSelections();

		// Use an interval to periodically check for changes instead of running on every render
		// This dramatically reduces CPU usage during normal typing
		const intervalId = setInterval(() => {
			const sessions = sessionsRef.current;

			sessions.forEach((session) => {
				// Broadcast session state changes (busy/idle) to web clients
				// This bypasses the debounced persistence which resets state to 'idle' before saving
				const prevState = prevSessionStatesRef.current.get(session.id);
				if (prevState !== session.state) {
					window.maestro.web.broadcastSessionState(session.id, session.state, {
						name: session.name,
						toolType: session.toolType,
						inputMode: session.inputMode,
						cwd: session.cwd,
					});
					prevSessionStatesRef.current.set(session.id, session.state);
				}

				const activeTabChanged = consumeDesktopAiTabSelection(
					session.id,
					session.activeTabId || session.aiTabs?.[0]?.id || ''
				);

				// An empty aiTabs array is a valid state and still has to be broadcast,
				// otherwise remote clients keep rendering tabs the user already closed.
				if (!session.aiTabs) return;

				// Create a hash of tab properties that should trigger a broadcast when changed
				const tabsHash = session.aiTabs
					.map((t) => `${t.id}:${t.name || ''}:${t.starred}:${t.state}:${t.hasUnread ?? false}`)
					.join('|');

				const prev = prevTabsRef.current.get(session.id);
				const current = {
					tabCount: session.aiTabs.length,
					activeTabId: session.activeTabId || session.aiTabs[0]?.id || '',
					tabsHash,
				};
				// Check if anything changed
				if (
					!prev ||
					prev.tabCount !== current.tabCount ||
					prev.activeTabId !== current.activeTabId ||
					prev.tabsHash !== current.tabsHash ||
					activeTabChanged
				) {
					const tabsForBroadcast = session.aiTabs.map((tab) => ({
						id: tab.id,
						agentSessionId: tab.agentSessionId,
						name: tab.name,
						starred: tab.starred,
						inputValue: tab.inputValue,
						usageStats: tab.usageStats,
						createdAt: tab.createdAt,
						state: tab.state,
						thinkingStartTime: tab.thinkingStartTime,
						hasUnread: tab.hasUnread,
					}));

					window.maestro.web.broadcastTabsChange(
						session.id,
						tabsForBroadcast,
						current.activeTabId,
						activeTabChanged
					);

					prevTabsRef.current.set(session.id, current);
				}
			});
		}, 500); // Check every 500ms - fast enough for good UX, slow enough to not impact typing

		return () => clearInterval(intervalId);
	}, [isLiveMode, sessionsRef]);

	// Handle remote trigger Cue subscription requests (from web/CLI clients)
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteTriggerCueSubscription(
			async (
				subscriptionName: string,
				prompt: string | undefined,
				responseChannel: string,
				sourceAgentId?: string
			) => {
				try {
					const result = await cueService.triggerSubscription(
						subscriptionName,
						prompt,
						sourceAgentId
					);
					window.maestro.process.sendRemoteTriggerCueSubscriptionResponse(responseChannel, result);
				} catch (error) {
					console.error('[Remote Cue Trigger] Failed:', subscriptionName, error);
					logger.error('[Remote Cue Trigger] Failed:', undefined, [subscriptionName, error]);
					// Never send the raw prompt to telemetry - remote-triggered
					// Cue prompts can carry user-authored content with PII or
					// secrets. Send length/presence so we can correlate failures
					// against payload size without leaking the body.
					captureException(error, {
						extra: {
							context: 'remoteTriggerCueSubscription',
							subscriptionName,
							responseChannel,
							promptLength: prompt?.length ?? 0,
							promptProvided: prompt !== undefined,
						},
					});
					window.maestro.process.sendRemoteTriggerCueSubscriptionResponse(responseChannel, false);
				}
			}
		);
		return unsubscribe;
	}, []);

	// Handle remote create-gist requests (from CLI / web clients).
	// Gathers every AI tab's transcript for the session, formats it the same
	// way the desktop "Publish Gist" flow does, and shells out to `gh gist
	// create` via the existing git IPC handler.
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteCreateGist(
			async (
				sessionId: string,
				description: string,
				isPublic: boolean,
				agentSessionId: string | undefined,
				responseChannel: string
			) => {
				try {
					const session = sessionsRef.current.find((s) => s.id === sessionId);
					if (!session) {
						window.maestro.process.sendRemoteCreateGistResponse(responseChannel, {
							success: false,
							error: `Session not found: ${sessionId}`,
						});
						return;
					}

					let content: string;
					if (agentSessionId) {
						// Narrowed to one provider session: publish exactly that
						// conversation, never a fallback to the agent's tabs. A caller
						// that named a session and got a different one published has
						// leaked it - gists are readable by anyone with the URL.
						const result = await buildSessionGistBody(session, agentSessionId);
						if ('error' in result) {
							window.maestro.process.sendRemoteCreateGistResponse(responseChannel, {
								success: false,
								error: result.error,
							});
							return;
						}
						content = `# ${session.name}\n\n_Session \`${agentSessionId}\`_\n\n${result.body}\n`;
					} else {
						const sections: string[] = [];
						for (const tab of session.aiTabs) {
							const body = formatLogsForClipboard(tab.logs);
							if (!body) continue;
							const header = tab.name || tab.id.slice(0, 8);
							sections.push(`## Tab: ${header}\n\n${body}`);
						}

						if (sections.length === 0) {
							window.maestro.process.sendRemoteCreateGistResponse(responseChannel, {
								success: false,
								error: 'Session has no conversation history to publish',
							});
							return;
						}

						content = `# ${session.name}\n\n${sections.join('\n\n---\n\n')}\n`;
					}

					const safeName =
						(session.name || 'session').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 60) || 'session';
					// Session ids are provider-issued, so scrub them the same way as the
					// agent name before they become a gist filename.
					const safeSessionId = agentSessionId?.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 8);
					const filename = safeSessionId
						? `${safeName}_${safeSessionId}_context.md`
						: `${safeName}_context.md`;

					const result = await window.maestro.git.createGist(
						filename,
						content,
						description,
						isPublic
					);
					window.maestro.process.sendRemoteCreateGistResponse(responseChannel, result);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					// Known recoverable modes (session missing, empty history, `gh`
					// not installed/authenticated) already returned above as
					// structured results. Anything that lands here is unexpected -
					// report to Sentry without the transcript/description/filename,
					// which can carry PII/secrets.
					captureException(error, {
						extra: {
							context: 'remoteCreateGist',
							sessionId,
							isPublic,
							descriptionProvided: Boolean(description),
							agentSessionTargeted: Boolean(agentSessionId),
						},
					});
					window.maestro.process.sendRemoteCreateGistResponse(responseChannel, {
						success: false,
						error: message,
					});
				}
			}
		);
		return unsubscribe;
	}, [sessionsRef]);

	return {};
}
