import { useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import type { Session, SessionState, ThinkingMode } from '../../types';
import { cueService } from '../../services/cue';
import { captureException } from '../../utils/sentry';
import { createTab, closeTab } from '../../utils/tabHelpers';
import { logger } from '../../utils/logger';
import { formatLogsForClipboard } from '../../utils/contextExtractor';
import { notifyToast } from '../../stores/notificationStore';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import { useSessionStore } from '../../stores/sessionStore';

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
	/** Session state setter */
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
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
		setSessions,
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
				force?: boolean
			) => {
				// Log metadata only at info level — remote commands can carry
				// secrets, proprietary code, or PII. Mirror the redaction the
				// main process applies in web-server-factory; the truncated
				// preview moves to debug, which only opted-in users enable.
				logger.info('[useRemoteIntegration] onRemoteCommand callback invoked:', undefined, {
					sessionId,
					commandLength: command?.length ?? 0,
					inputMode,
					tabId,
					force,
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
					setSessions((prev) =>
						prev.map((s) =>
							s.id === sessionId
								? {
										...s,
										inputMode,
										...(inputMode === 'terminal' && { activeFileTabId: null }),
									}
								: s
						)
					);
				}

				// Switch to the target session (for visual feedback)
				setActiveSessionId(sessionId);
				logger.info('[useRemoteIntegration] Switched active session to:', undefined, sessionId);

				// Dispatch event directly - handleRemoteCommand handles all the logic
				// Don't set inputValue - we don't want command text to appear in the input bar
				// Pass the inputMode from web so handleRemoteCommand uses it
				logger.info('[useRemoteIntegration] Dispatching maestro:remoteCommand event:', undefined, {
					sessionId,
					commandLength: command?.length ?? 0,
					inputMode,
					tabId,
					force,
				});
				logger.debug(
					'[useRemoteIntegration] Dispatching maestro:remoteCommand preview:',
					undefined,
					{ sessionId, commandPreview: command?.substring(0, 50) }
				);
				window.dispatchEvent(
					new CustomEvent('maestro:remoteCommand', {
						detail: { sessionId, command, inputMode, tabId, force },
					})
				);
				logger.info('[useRemoteIntegration] Event dispatched successfully');
			}
		);

		return () => {
			unsubscribeRemote();
		};
	}, [sessionsRef, setSessions, setActiveSessionId]);

	// Handle remote mode switches from web interface
	// This allows web mode switches to go through the same code path as desktop
	useEffect(() => {
		const unsubscribeSwitchMode = window.maestro.process.onRemoteSwitchMode(
			(sessionId: string, mode: 'ai' | 'terminal') => {
				// Find the session and update its mode
				setSessions((prev) => {
					const session = prev.find((s) => s.id === sessionId);
					if (!session) {
						return prev;
					}

					// Only switch if mode is different
					if (session.inputMode === mode) {
						return prev;
					}

					return prev.map((s) => {
						if (s.id !== sessionId) return s;
						// Clear activeFileTabId when switching to terminal mode to prevent
						// orphaned file preview without tab bar
						return {
							...s,
							inputMode: mode,
							...(mode === 'terminal' && { activeFileTabId: null }),
						};
					});
				});
			}
		);

		return () => {
			unsubscribeSwitchMode();
		};
	}, [setSessions]);

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
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== session.id) return s;
							return {
								...s,
								state: 'idle' as SessionState,
								busySource: undefined,
								thinkingStartTime: undefined,
							};
						})
					);
				} catch (error) {
					logger.error('[Remote] Failed to interrupt session:', undefined, error);
				}
			}
		);

		return () => {
			unsubscribeInterrupt();
		};
	}, [sessionsRef, setSessions]);

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
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== sessionId) return s;
							// Check if tab exists
							if (!s.aiTabs.some((t) => t.id === tabId)) {
								return s;
							}
							return {
								...s,
								activeTabId: tabId,
								activeFileTabId: null,
								activeTerminalTabId: null,
								inputMode: 'ai' as const,
							};
						})
					);
				}
			}
		);

		// Handle remote tab selection from web interface
		// This also switches to the session if not already active
		const unsubscribeSelectTab = window.maestro.process.onRemoteSelectTab(
			(sessionId: string, tabId: string) => {
				// First, switch to the session if not already active
				const currentActiveId = activeSessionIdRef.current;
				if (currentActiveId !== sessionId) {
					setActiveSessionId(sessionId);
				}

				// Then update the active tab within the session
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;
						// Check if tab exists
						if (!s.aiTabs.some((t) => t.id === tabId)) {
							return s;
						}
						return {
							...s,
							activeTabId: tabId,
							activeFileTabId: null,
							activeTerminalTabId: null,
							inputMode: 'ai' as const,
						};
					})
				);
			}
		);

		// Handle remote new tab from web interface
		const unsubscribeNewTab = window.maestro.process.onRemoteNewTab(
			(sessionId: string, responseChannel: string) => {
				let newTabId: string | null = null;

				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;

						// Use createTab helper
						const result = createTab(s, {
							saveToHistory: defaultSaveToHistory,
							showThinking: defaultShowThinking,
						});
						if (!result) return s;
						newTabId = result.tab.id;
						return result.session;
					})
				);

				// Send response back with the new tab ID
				if (newTabId) {
					window.maestro.process.sendRemoteNewTabResponse(responseChannel, { tabId: newTabId });
				} else {
					window.maestro.process.sendRemoteNewTabResponse(responseChannel, null);
				}
			}
		);

		// Handle remote "new AI tab with prompt" from CLI (send --live --new-tab).
		// Atomically creates a fresh AI tab, makes it active, and dispatches the
		// prompt through the same maestro:remoteCommand event path that --live
		// uses — so downstream spawn/history/state flows are identical.
		// flushSync forces React to commit the new tab as active before we fire
		// the event; without it the downstream handler reads stale activeTabId
		// and writes the prompt into the previously-active tab.
		// Ack the renderer result on responseChannel so the CLI only reports
		// success when a tab was actually created.
		const unsubscribeNewTabWithPrompt = window.maestro.process.onRemoteNewAITabWithPrompt(
			(sessionId: string, prompt: string, responseChannel: string) => {
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
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== sessionId) return s;
							const result = createTab(s, {
								saveToHistory: defaultSaveToHistory,
								showThinking: defaultShowThinking,
							});
							if (!result) return s;
							createdTabId = result.tab.id;
							return result.session;
						})
					);
					if (createdTabId) {
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
				// we just created — without it, useRemoteHandlers would fall back to
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
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;

						// Use closeTab helper (handles last tab by creating a fresh one)
						const result = closeTab(s, tabId);
						return result?.session ?? s;
					})
				);
			}
		);

		// Handle remote rename tab from web interface
		const unsubscribeRenameTab = window.maestro.process.onRemoteRenameTab(
			(sessionId: string, tabId: string, newName: string) => {
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;

						// Find the tab to get its agentSessionId for persistence
						const tab = s.aiTabs.find((t) => t.id === tabId);
						if (!tab) {
							return s;
						}

						// Persist name to agent session metadata (async, fire and forget)
						// Use projectRoot (not cwd) for consistent session storage access
						if (tab.agentSessionId) {
							const agentId = s.toolType || 'claude-code';
							if (agentId === 'claude-code') {
								window.maestro.claude
									.updateSessionName(s.projectRoot, tab.agentSessionId, newName || '')
									.catch((err) => logger.error('Failed to persist tab name:', undefined, err));
							} else {
								window.maestro.agentSessions
									.setSessionName(agentId, s.projectRoot, tab.agentSessionId, newName || null)
									.catch((err) => logger.error('Failed to persist tab name:', undefined, err));
							}
							// Also update past history entries with this agentSessionId
							window.maestro.history
								.updateSessionName(tab.agentSessionId, newName || '')
								.catch((err) =>
									logger.error('Failed to update history session names:', undefined, err)
								);
						}

						return {
							...s,
							aiTabs: s.aiTabs.map((t) => (t.id === tabId ? { ...t, name: newName || null } : t)),
						};
					})
				);
			}
		);

		// Handle remote star tab from web interface
		const unsubscribeStarTab = window.maestro.process.onRemoteStarTab(
			(sessionId: string, tabId: string, starred: boolean) => {
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;

						const tab = s.aiTabs.find((t) => t.id === tabId);
						if (!tab?.agentSessionId) return s;

						// Persist starred state (same logic as desktop handleTabStar)
						const agentId = s.toolType || 'claude-code';
						if (agentId === 'claude-code') {
							window.maestro.claude
								.updateSessionStarred(s.projectRoot, tab.agentSessionId, starred)
								.catch((err) => logger.error('Failed to persist tab starred:', undefined, err));
						} else {
							window.maestro.agentSessions
								.setSessionStarred(agentId, s.projectRoot, tab.agentSessionId, starred)
								.catch((err) => logger.error('Failed to persist tab starred:', undefined, err));
						}

						return {
							...s,
							aiTabs: s.aiTabs.map((t) => (t.id === tabId ? { ...t, starred } : t)),
						};
					})
				);
			}
		);

		// Handle remote reorder tab from web interface
		const unsubscribeReorderTab = window.maestro.process.onRemoteReorderTab(
			(sessionId: string, fromIndex: number, toIndex: number) => {
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId || !s.aiTabs) return s;
						const tabs = [...s.aiTabs];
						const [movedTab] = tabs.splice(fromIndex, 1);
						tabs.splice(toIndex, 0, movedTab);
						return { ...s, aiTabs: tabs };
					})
				);
			}
		);

		// Handle remote bookmark toggle from web interface
		const unsubscribeToggleBookmark = window.maestro.process.onRemoteToggleBookmark(
			(sessionId: string) => {
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;
						return { ...s, bookmarked: !s.bookmarked };
					})
				);
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
		};
	}, [
		sessionsRef,
		activeSessionIdRef,
		setSessions,
		setActiveSessionId,
		defaultSaveToHistory,
		defaultShowThinking,
	]);

	// Handle remote open file tab from web/CLI interface
	// Dispatches a CustomEvent for App.tsx to handle (avoids hook ordering issues)
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteOpenFileTab(
			(sessionId: string, filePath: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:openFileTab', {
						detail: { sessionId, filePath },
					})
				);
			}
		);
		return () => {
			unsubscribe();
		};
	}, []);

	// Handle remote refresh file tree from web/CLI interface
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteRefreshFileTree((sessionId: string) => {
			window.dispatchEvent(
				new CustomEvent('maestro:refreshFileTree', {
					detail: { sessionId },
				})
			);
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
				tabId: explicitTabId,
				actionUrl,
				actionLabel,
				clickAction,
			} = params;
			// Resolve agent metadata for the header strip. Prefer the caller's
			// explicit `tabId` so the chip matches the click target; fall back
			// to the session's currently-active AI tab.
			let project: string | undefined;
			let tabId: string | undefined = explicitTabId;
			let tabName: string | undefined;
			if (sessionId) {
				const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
				project = session?.name;
				const targetTabId = explicitTabId ?? session?.activeTabId;
				const targetTab = session?.aiTabs?.find((t) => t.id === targetTabId);
				if (targetTab) {
					tabId = targetTab.id;
					tabName = targetTab.name ?? undefined;
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

	// Handle remote open browser tab from CLI/web interface.
	// responseChannel is forwarded so the App-level listener can ack the
	// CLI once the browser tab actually exists.
	useEffect(() => {
		const unsubscribe = window.maestro.process.onRemoteOpenBrowserTab(
			(sessionId: string, url: string, responseChannel: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:openBrowserTab', {
						detail: { sessionId, url, responseChannel },
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
				config: { cwd?: string; shell?: string; name?: string | null },
				responseChannel: string
			) => {
				window.dispatchEvent(
					new CustomEvent('maestro:openTerminalTab', {
						detail: { sessionId, config, responseChannel },
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
		const unsubscribe = window.maestro.process.onRemoteRefreshAutoRunDocs((sessionId: string) => {
			window.dispatchEvent(
				new CustomEvent('maestro:refreshAutoRunDocs', {
					detail: { sessionId },
				})
			);
		});
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

	// Handle remote set Auto Run folder from web interface — repoints a session
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
				responseChannel: string
			) => {
				window.dispatchEvent(
					new CustomEvent('maestro:remoteCreateSession', {
						detail: { name, toolType, cwd, groupId, config, responseChannel },
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

		const unsubscribeCreateGroup = window.maestro.process.onRemoteCreateGroup(
			(name: string, emoji: string | undefined, responseChannel: string) => {
				window.dispatchEvent(
					new CustomEvent('maestro:remoteCreateGroup', {
						detail: { name, emoji, responseChannel },
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

				if (!session.aiTabs || session.aiTabs.length === 0) return;

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
					prev.tabsHash !== current.tabsHash
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

					window.maestro.web.broadcastTabsChange(session.id, tabsForBroadcast, current.activeTabId);

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
					// Never send the raw prompt to telemetry — remote-triggered
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

					const content = `# ${session.name}\n\n${sections.join('\n\n---\n\n')}\n`;
					const safeName =
						(session.name || 'session').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 60) || 'session';
					const filename = `${safeName}_context.md`;

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
					// structured results. Anything that lands here is unexpected —
					// report to Sentry without the transcript/description/filename,
					// which can carry PII/secrets.
					captureException(error, {
						extra: {
							context: 'remoteCreateGist',
							sessionId,
							isPublic,
							descriptionProvided: Boolean(description),
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
