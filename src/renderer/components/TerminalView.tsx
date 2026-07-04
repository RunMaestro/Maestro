import {
	memo,
	forwardRef,
	useImperativeHandle,
	useRef,
	useEffect,
	useCallback,
	useState,
	useMemo,
} from 'react';
import { XTerminal, XTerminalHandle } from './XTerminal';
import { TerminalSearchBar } from './TerminalSearchBar';
import { TerminalTouchBar } from './TerminalTouchBar';
import {
	getActiveTerminalTab,
	getTerminalSessionId,
	parseTerminalSessionId,
	updateTerminalTabState,
	updateTerminalTabPid,
} from '../utils/terminalTabHelpers';
import { useSessionStore } from '../stores/sessionStore';
import { useTabStore } from '../stores/tabStore';
import { captureException } from '../utils/sentry';
import { notifyToast } from '../stores/notificationStore';
import { isCoarsePointer } from '../utils/touch';
import type { PaneRect, Session, TerminalTab } from '../types';
import type { Theme } from '../../shared/theme-types';
import { logger } from '../utils/logger';

// ============================================================================
// Types
// ============================================================================

export interface TerminalViewHandle {
	clearActiveTerminal(): void;
	focusActiveTerminal(): void;
	searchActiveTerminal(query: string): boolean;
	searchNext(): boolean;
	searchPrevious(): boolean;
	/** Read the full scrollback + visible buffer for the specified terminal tab. */
	getTerminalBuffer(tabId: string): string;
}

interface TerminalViewProps {
	session: Session;
	theme: Theme;
	fontFamily: string;
	fontSize?: number;
	defaultShell: string;
	shellArgs?: string;
	shellEnvVars?: Record<string, string>;
	onTabStateChange: (tabId: string, state: TerminalTab['state'], exitCode?: number) => void;
	onTabPidChange: (tabId: string, pid: number) => void;
	searchOpen?: boolean;
	onSearchClose?: () => void;
	/** Whether the terminal panel is currently visible (inputMode === 'terminal'). Used to trigger repaint when returning from AI mode. */
	isVisible?: boolean;
	/**
	 * Tiling geometry: terminal-tab-id -> content-box rect (relative to this
	 * view's positioned container) for each terminal that is a leaf in the active
	 * tab group. When present, each matching tab's layer is positioned onto its
	 * pane rect and shown simultaneously (instead of only the active tab filling
	 * the panel). Omit for standalone (non-group) rendering - original behavior.
	 * Its own ResizeObserver reflows xterm cols/rows when a rect changes.
	 */
	paneRects?: Map<string, PaneRect>;
	/**
	 * Tiling: called with a terminal tab id when its positioned pane layer is
	 * pressed, so the caller can focus that pane (the live overlay sits over the
	 * transparent PaneFrame slot, intercepting the frame's own click-to-focus).
	 */
	onPaneMouseDown?: (tabId: string) => void;
	/** Copy the highlighted terminal selection to the clipboard. */
	onCopySelection?: (text: string) => void;
	/** Send the highlighted terminal selection to another agent. Tab ID is supplied so the
	 *  handler can derive a display name (e.g. "Terminal 2") for the target agent modal. */
	onSendSelectionToAgent?: (tabId: string, text: string) => void;
}

// ============================================================================
// Component
// ============================================================================

export const TerminalView = memo(
	forwardRef<TerminalViewHandle, TerminalViewProps>(function TerminalView(
		{
			session,
			theme,
			fontFamily,
			fontSize,
			defaultShell,
			shellArgs,
			shellEnvVars,
			onTabStateChange,
			onTabPidChange,
			searchOpen,
			onSearchClose,
			isVisible,
			onCopySelection,
			onSendSelectionToAgent,
			paneRects,
			onPaneMouseDown,
		},
		ref
	) {
		// Map of tabId → XTerminalHandle ref for each tab instance
		const terminalRefs = useRef<Map<string, XTerminalHandle>>(new Map());
		// Track previous tab states to detect transitions (for exit message)
		const prevTabStatesRef = useRef<Map<string, TerminalTab['state']>>(new Map());
		// In-flight spawn guard: set of tabIds currently waiting for a PTY PID
		const spawnInFlightRef = useRef<Set<string>>(new Set());
		// Track which tabs have already had the loading message written to avoid duplicates
		const loadingWrittenRef = useRef<Set<string>>(new Set());
		// Dedup spawn-failure toasts: batch rapid failures into a single notification
		const spawnFailureCountRef = useRef(0);
		const spawnFailureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
		const spawnFailureLastMessageRef = useRef<string | null>(null);
		// Stable refs for callback props — prevents spawnPtyForTab from getting a new
		// identity on every render, which would re-trigger the spawn useEffect in a loop.
		const onTabPidChangeRef = useRef(onTabPidChange);
		onTabPidChangeRef.current = onTabPidChange;
		const onTabStateChangeRef = useRef(onTabStateChange);
		onTabStateChangeRef.current = onTabStateChange;

		// Touch key bar (coarse-pointer devices only). Evaluated once per render;
		// the pointer type does not change during a session.
		const coarsePointer = isCoarsePointer();
		// Sticky-Ctrl armed state for the touch key bar. A ref mirror lets the
		// XTerminal bridge read the latest value without re-creating the bridge.
		const [ctrlArmed, setCtrlArmed] = useState(false);
		const ctrlArmedRef = useRef(ctrlArmed);
		ctrlArmedRef.current = ctrlArmed;
		const stickyCtrl = useMemo(
			() => ({
				isActive: () => ctrlArmedRef.current,
				onConsume: () => setCtrlArmed(false),
			}),
			[]
		);

		const closeTerminalTab = useTabStore((s) => s.closeTerminalTab);

		// Batch spawn-failure toasts: coalesce rapid failures (e.g. session restore
		// triggers many tabs at once) into a single toast with a count.
		const notifySpawnFailure = useCallback((message: string) => {
			spawnFailureCountRef.current++;
			// Always store the most recent message, but never let a non-SSH message
			// overwrite an SSH-specific one (SSH messages take precedence).
			if (
				!spawnFailureLastMessageRef.current ||
				message.startsWith('SSH ') ||
				!spawnFailureLastMessageRef.current.startsWith('SSH ')
			) {
				spawnFailureLastMessageRef.current = message;
			}
			if (spawnFailureTimerRef.current) {
				clearTimeout(spawnFailureTimerRef.current);
			}
			spawnFailureTimerRef.current = setTimeout(() => {
				const count = spawnFailureCountRef.current;
				const lastMessage = spawnFailureLastMessageRef.current ?? message;
				spawnFailureCountRef.current = 0;
				spawnFailureLastMessageRef.current = null;
				spawnFailureTimerRef.current = null;
				notifyToast({
					type: 'error',
					title: count > 1 ? `Failed to start ${count} terminals` : 'Failed to start terminal',
					message:
						count > 1 ? `${count} terminals could not be started. ${lastMessage}` : lastMessage,
				});
			}, 200);
		}, []);

		// Handle a PTY spawn failure. Scratch tabs are closed (their config is
		// disposable); persistent tabs are kept and marked 'exited' so they survive
		// a transient failure (e.g. an SSH remote that is briefly unreachable) and
		// can be restarted by the user instead of vanishing. Marking 'exited' (rather
		// than leaving 'idle') also stops the spawn effects from retrying in a loop.
		const handleSpawnFailure = useCallback(
			(tabId: string, isPersistent: boolean, message: string) => {
				logger.warn('Terminal PTY spawn failed', 'TerminalView', {
					sessionId: session.id,
					tabId,
					isPersistent,
					message,
					decision: isPersistent ? 'keep-for-restart' : 'close',
				});
				if (isPersistent) {
					onTabStateChangeRef.current(tabId, 'exited');
					terminalRefs.current
						.get(tabId)
						?.write('\r\n\x1b[2m[failed to start] - restart from the tab menu\x1b[0m\r\n');
				} else {
					setTimeout(() => closeTerminalTab(tabId, 'spawn-failure'), 0);
				}
				notifySpawnFailure(message);
			},
			[session.id, closeTerminalTab, notifySpawnFailure]
		);

		const activeTab = getActiveTerminalTab(session);

		// Touch key bar → PTY. Writes the raw escape sequence through the SAME path
		// keyboard input uses (window.maestro.process.write), targeting the active
		// terminal tab. Focus is preserved by the buttons themselves (pointer-down is
		// prevented), so the virtual keyboard stays up.
		const handleTouchKey = useCallback(
			(sequence: string) => {
				const tab = getActiveTerminalTab(session);
				if (!tab) return;
				const terminalSessionId = getTerminalSessionId(session.id, tab.id);
				window.maestro.process.write(terminalSessionId, sequence).catch(() => {
					// Write failures are surfaced by the process exit handler
				});
			},
			[session]
		);

		const toggleCtrlArmed = useCallback(() => setCtrlArmed((v) => !v), []);

		// Expose imperative handle to parent
		useImperativeHandle(
			ref,
			(): TerminalViewHandle => ({
				clearActiveTerminal() {
					if (!activeTab) return;
					// xterm.clear() removes scrollback but keeps the current prompt line
					// exactly where it is — which looks like nothing happened when the user
					// has just the prompt visible. Also send Ctrl+L to the PTY so the shell
					// redraws the current line at the top of a fresh screen.
					terminalRefs.current.get(activeTab.id)?.clear();
					const terminalSessionId = getTerminalSessionId(session.id, activeTab.id);
					window.maestro.process.write(terminalSessionId, '\x0c').catch(() => {
						// Write failures are surfaced by the process exit handler
					});
				},
				focusActiveTerminal() {
					if (activeTab) {
						terminalRefs.current.get(activeTab.id)?.focus();
					}
				},
				searchActiveTerminal(query: string): boolean {
					if (!activeTab) return false;
					return terminalRefs.current.get(activeTab.id)?.search(query) ?? false;
				},
				searchNext(): boolean {
					if (!activeTab) return false;
					return terminalRefs.current.get(activeTab.id)?.searchNext() ?? false;
				},
				searchPrevious(): boolean {
					if (!activeTab) return false;
					return terminalRefs.current.get(activeTab.id)?.searchPrevious() ?? false;
				},
				getTerminalBuffer(tabId: string): string {
					return terminalRefs.current.get(tabId)?.getBuffer() ?? '';
				},
			}),
			[activeTab]
		);

		// Shared spawn function — closes tab and shows error toast on failure
		const spawnPtyForTab = useCallback(
			(tab: TerminalTab) => {
				const tabId = tab.id;
				// Guard: skip if a spawn is already in flight for this tab
				if (spawnInFlightRef.current.has(tabId)) return;
				spawnInFlightRef.current.add(tabId);

				// "Persistent" tabs carry user intent to keep running: a configured
				// startup command, or any tab under an SSH/remote session (whose
				// transport can drop for reasons unrelated to the user). We never
				// silently discard these on failure - we keep them as a restartable
				// exited husk instead of closing the tab and losing its config.
				const isPersistent =
					!!tab.startupCommand ||
					!!(session.sessionSshRemoteConfig?.enabled || session.sshRemoteId);

				const terminalSessionId = getTerminalSessionId(session.id, tabId);

				// Build effective SSH config: prefer explicit sessionSshRemoteConfig, then fall back
				// to sshRemoteId which is set after an AI agent connects. Without this fallback,
				// terminal tabs under running SSH agents spawn locally instead of on the remote host.
				//
				// workingDirOverride must be a REMOTE path. Fallback chain:
				//   1. sessionSshRemoteConfig.workingDirOverride — user-configured remote project root
				//   2. session.remoteCwd — tracked remote cwd (set after agent reports cd)
				//   3. session.cwd — the working directory from session creation; for SSH sessions
				//      this IS a remote path (the user types a remote path when SSH is enabled)
				const effectiveSshConfig = session.sessionSshRemoteConfig?.enabled
					? {
							...session.sessionSshRemoteConfig,
							workingDirOverride:
								session.sessionSshRemoteConfig.workingDirOverride ||
								session.remoteCwd ||
								session.cwd ||
								undefined,
						}
					: session.sshRemoteId
						? {
								enabled: true,
								remoteId: session.sshRemoteId,
								workingDirOverride:
									session.remoteCwd ||
									session.sessionSshRemoteConfig?.workingDirOverride ||
									session.cwd ||
									undefined,
							}
						: undefined;

				// When a startup command is configured, spawn the PTY in its configured cwd
				// (if any) so the command runs in the right directory. Otherwise keep the
				// existing fallback chain.
				const spawnCwd =
					(tab.startupCommand && tab.startupCommandCwd) ||
					tab.cwd ||
					session.cwd ||
					session.projectRoot ||
					'';

				window.maestro.process
					.spawnTerminalTab({
						sessionId: terminalSessionId,
						cwd: spawnCwd,
						shell: defaultShell || undefined,
						shellArgs,
						shellEnvVars,
						toolType: session.toolType,
						sessionCustomEnvVars: session.customEnvVars,
						sessionSshRemoteConfig: effectiveSshConfig,
					})
					.then((result) => {
						if (result.success) {
							onTabPidChangeRef.current(tabId, result.pid);
							// Run the user-configured startup command. The PTY buffers stdin,
							// so the shell will execute it once initialization (rc files, etc.)
							// finishes.
							if (tab.startupCommand) {
								window.maestro.process
									.write(terminalSessionId, tab.startupCommand + '\n')
									.catch(() => {
										// Write failures are surfaced by the process exit handler
									});
							}
						} else {
							// Spawn failed. Persistent tabs are kept (marked exited so the
							// spawn effects stop retrying in a loop); scratch tabs are closed.
							handleSpawnFailure(
								tabId,
								isPersistent,
								effectiveSshConfig?.enabled
									? 'SSH terminal could not be started. Check that the SSH remote is enabled and reachable.'
									: 'The shell process could not be started. Check system PTY availability.'
							);
						}
					})
					.catch((err) => {
						captureException(err, {
							extra: {
								tabId,
								terminalSessionId,
								operation: 'spawnTerminalTab',
							},
						});
						// Spawn threw — same persistent-vs-scratch handling as a failed spawn.
						handleSpawnFailure(
							tabId,
							isPersistent,
							err instanceof Error ? err.message : 'An unexpected error occurred.'
						);
					})
					.finally(() => {
						spawnInFlightRef.current.delete(tabId);
					});
			},
			[
				session.id,
				session.cwd,
				session.remoteCwd,
				session.sessionSshRemoteConfig,
				session.sshRemoteId,
				defaultShell,
				shellArgs,
				shellEnvVars,
				// onTabPidChange / onTabStateChange accessed via stable refs — not deps
				handleSpawnFailure,
			]
		);

		// Spawn PTY when active tab changes and has no PID yet
		useEffect(() => {
			if (!activeTab || activeTab.pid !== 0 || activeTab.state === 'exited') {
				return;
			}
			spawnPtyForTab(activeTab);
		}, [activeTab?.id, spawnPtyForTab]);

		// Eagerly spawn any non-active terminal tab that has a startupCommand
		// configured. Without this, a tab with `npm run dev` would silently sit
		// dormant after an app restart until the user clicked it — defeating the
		// whole point of a persistent startup command. spawnPtyForTab's in-flight
		// guard + the pid===0 check make this safe to re-evaluate on every render.
		useEffect(() => {
			const terminalTabs = session.terminalTabs || [];
			for (const tab of terminalTabs) {
				if (
					tab.startupCommand &&
					tab.pid === 0 &&
					tab.state !== 'exited' &&
					tab.id !== activeTab?.id
				) {
					spawnPtyForTab(tab);
				}
			}
		}, [session.terminalTabs, activeTab?.id, spawnPtyForTab]);

		// Focus and repaint the active terminal when the active tab changes.
		// The refresh() call is necessary because switching tabs uses CSS visibility: hidden
		// rather than unmounting, so xterm.js's ResizeObserver never fires — the WebGL/canvas
		// renderer won't repaint unless explicitly told to after the element becomes visible.
		useEffect(() => {
			if (activeTab) {
				// Short delay so the DOM visibility change applies before fitting/repainting
				const timer = setTimeout(() => {
					const handle = terminalRefs.current.get(activeTab.id);
					handle?.refresh();
					handle?.focus();
				}, 50);
				return () => clearTimeout(timer);
			}
		}, [activeTab?.id]);

		// Repaint + focus when the terminal panel becomes visible again (e.g. returning from AI mode).
		// activeTab?.id doesn't change in this case, so the effect above won't fire — we need an
		// explicit refresh here. The display:none → display:flex transition can wipe the WebGL/canvas
		// framebuffer, so we must tell xterm.js to redraw from its internal buffer.
		useEffect(() => {
			if (isVisible && activeTab) {
				const timer = setTimeout(() => {
					const handle = terminalRefs.current.get(activeTab.id);
					handle?.refresh();
					handle?.focus();
				}, 50);
				return () => clearTimeout(timer);
			}
		}, [isVisible]);

		// Close search when the active terminal tab changes.
		// Intentionally depends only on activeTab?.id — we want to close search when
		// switching tabs, not every time searchOpen/onSearchClose props change.
		useEffect(() => {
			if (searchOpen) {
				onSearchClose?.();
			}
		}, [activeTab?.id]);

		// Subscribe to PTY exit events for terminal tabs in this session
		useEffect(() => {
			const cleanup = window.maestro.process.onExit((exitSessionId: string, code: number) => {
				const parsed = parseTerminalSessionId(exitSessionId);
				if (!parsed || parsed.sessionId !== session.id) return;
				onTabStateChange(parsed.tabId, 'exited', code);
			});
			return cleanup;
		}, [session.id]);

		// Handle a terminal's PTY exiting. A plain scratch shell is closed (the user
		// typed `exit` / Ctrl-D, or the shell died - that's disposable). A "persistent"
		// tab is NOT auto-closed: a tab with a startup command, or any tab under an
		// SSH/remote session whose transport can drop for reasons unrelated to the user
		// (sleep, network blip, server timeout). Silently destroying those discards the
		// user's config and is the root cause of the long-standing "terminal tabs vanish"
		// reports. Instead we keep them as a restartable exited husk with a visible notice.
		//
		// pid === 0 means the PTY never spawned, i.e. this 'exited' transition came from
		// a spawn failure already handled at the spawn site - skip it here to avoid a
		// duplicate toast/notice.
		useEffect(() => {
			const terminalTabs = session.terminalTabs || [];
			const isRemoteSession = !!(session.sessionSshRemoteConfig?.enabled || session.sshRemoteId);
			for (const tab of terminalTabs) {
				const prev = prevTabStatesRef.current.get(tab.id);
				if (prev !== undefined && prev !== 'exited' && tab.state === 'exited' && tab.pid !== 0) {
					const age = Date.now() - tab.createdAt;
					const tabId = tab.id;
					const isPersistent = !!tab.startupCommand || isRemoteSession;
					// Diagnostic: every PTY exit logs why the tab was kept or closed. This
					// is the signal for the "terminal tabs vanish" reports - e.g. an SSH
					// transport dropping logs exitCode here with isRemote:true / kept.
					logger.info('Terminal PTY exited', 'TerminalView', {
						sessionId: session.id,
						tabId,
						exitCode: tab.exitCode,
						ageMs: age,
						hasStartupCommand: !!tab.startupCommand,
						isRemote: isRemoteSession,
						decision: isPersistent ? 'keep-for-restart' : 'close',
					});
					if (age < 2000) {
						// Exited almost immediately - surface as a startup failure toast.
						notifySpawnFailure(
							`Shell exited immediately${tab.exitCode != null ? ` (exit code: ${tab.exitCode})` : ''}.`
						);
					}
					if (isPersistent) {
						// Keep the tab; show a visible notice instead of a silent dead husk.
						terminalRefs.current
							.get(tabId)
							?.write(
								`\r\n\x1b[2m[process exited${tab.exitCode != null ? ` (code ${tab.exitCode})` : ''}] - restart from the tab menu\x1b[0m\r\n`
							);
					} else {
						// Close on next tick to avoid mutating state mid-render.
						setTimeout(() => closeTerminalTab(tabId, 'pty-exit'), 0);
					}
				}
				prevTabStatesRef.current.set(tab.id, tab.state);
			}
		}, [
			session.terminalTabs,
			session.sessionSshRemoteConfig,
			session.sshRemoteId,
			closeTerminalTab,
			notifySpawnFailure,
		]);

		const terminalTabs = session.terminalTabs || [];

		if (terminalTabs.length === 0) {
			return (
				<div
					className="flex-1 flex items-center justify-center text-sm"
					style={{ color: theme.colors.textDim }}
				>
					No terminal tabs
				</div>
			);
		}

		const handleSearchClose = () => {
			onSearchClose?.();
			// Return focus to the active terminal
			if (activeTab) {
				terminalRefs.current.get(activeTab.id)?.focus();
			}
		};

		return (
			<div className="flex-1 flex flex-col overflow-hidden">
				{coarsePointer && (
					<TerminalTouchBar
						theme={theme}
						ctrlArmed={ctrlArmed}
						onToggleCtrl={toggleCtrlArmed}
						onKey={handleTouchKey}
					/>
				)}
				<div className="flex-1 relative overflow-hidden">
					<TerminalSearchBar
						theme={theme}
						isOpen={!!searchOpen}
						onClose={handleSearchClose}
						onSearch={(q) => {
							if (!activeTab) return false;
							return terminalRefs.current.get(activeTab.id)?.search(q) ?? false;
						}}
						onSearchNext={() => {
							if (!activeTab) return false;
							return terminalRefs.current.get(activeTab.id)?.searchNext() ?? false;
						}}
						onSearchPrevious={() => {
							if (!activeTab) return false;
							return terminalRefs.current.get(activeTab.id)?.searchPrevious() ?? false;
						}}
					/>
					{terminalTabs.map((tab) => {
						const terminalSessionId = getTerminalSessionId(session.id, tab.id);
						// Tiling: this tab is a leaf in the active group. Position its layer onto
						// the published pane rect and show it (multiple terminals visible at once).
						// XTerminal's own ResizeObserver reflows cols/rows when the rect changes.
						const paneRect = paneRects?.get(tab.id);
						// Standalone (no paneRects): only the session's active tab layer is shown,
						// filling the panel - original keep-alive behavior.
						const isActive = paneRects ? paneRect != null : tab.id === session.activeTerminalTabId;
						const positioned = paneRect != null;

						return (
							<div
								key={tab.id}
								// overflow-hidden clips the xterm canvas to this layer's box. Critical for
								// a tiled (positioned) pane: the layer is height-clamped to its pane rect,
								// but xterm sizes its canvas from its own delayed ResizeObserver reflow. In
								// the window between the pane shrinking (e.g. the AI input appearing when
								// focus moves to an AI pane) and xterm reflowing, an over-tall canvas would
								// otherwise spill past the pane's bottom - down to the panel's clip - and
								// bleed over the input area. Harmless for the standalone `inset-0` case,
								// which the panel container already clips.
								className={`absolute overflow-hidden ${positioned ? '' : 'inset-0 '}${isActive ? '' : 'invisible'}`}
								// Tiling: pressing a pane focuses it (the overlay sits over the
								// transparent PaneFrame slot, so the frame's own click-to-focus never
								// sees this press). Fires on mousedown-capture so focus lands before
								// xterm begins a selection drag.
								onMouseDownCapture={positioned ? () => onPaneMouseDown?.(tab.id) : undefined}
								style={
									positioned
										? {
												top: paneRect.top,
												left: paneRect.left,
												width: paneRect.width,
												height: paneRect.height,
												pointerEvents: 'auto',
											}
										: { pointerEvents: isActive ? 'auto' : 'none' }
								}
							>
								<XTerminal
									onCopySelection={onCopySelection}
									onSendSelectionToAgent={
										onSendSelectionToAgent
											? (text: string) => onSendSelectionToAgent(tab.id, text)
											: undefined
									}
									stickyCtrl={coarsePointer && isActive ? stickyCtrl : undefined}
									ref={(handle) => {
										if (handle) {
											terminalRefs.current.set(tab.id, handle);
											// Write loading indicator once per idle cycle — guard prevents duplicate writes on re-renders
											if (
												tab.pid === 0 &&
												tab.state === 'idle' &&
												!loadingWrittenRef.current.has(tab.id)
											) {
												loadingWrittenRef.current.add(tab.id);
												setTimeout(() => {
													handle.write('\x1b[2mStarting terminal...\x1b[0m');
												}, 0);
											}
										} else {
											terminalRefs.current.delete(tab.id);
											// Do NOT clear loadingWrittenRef here — React calls inline ref callbacks with
											// null then the new handle on re-renders; clearing it would cause repeated writes.
										}
									}}
									sessionId={terminalSessionId}
									theme={theme}
									fontFamily={fontFamily}
									fontSize={fontSize}
									// Treat the tab as inactive when the whole TerminalView is hidden
									// (a different session is active) so XTerminal disposes its WebGL
									// renderer and frees the GPU context. Re-init happens automatically
									// when isVisible flips back to true.
									isActive={isActive && isVisible !== false}
								/>
							</div>
						);
					})}
				</div>
			</div>
		);
	})
);

// ============================================================================
// Callback factories — used by MainPanel to wire tab state/pid updates
// ============================================================================

/**
 * Create an onTabStateChange callback that updates session state in the store.
 * Called when a PTY process exits or changes state.
 */
export function createTabStateChangeHandler(sessionId: string) {
	return (tabId: string, state: TerminalTab['state'], exitCode?: number) => {
		useSessionStore
			.getState()
			.setSessions((prev) =>
				prev.map((s) =>
					s.id === sessionId ? updateTerminalTabState(s, tabId, state, exitCode) : s
				)
			);
	};
}

/**
 * Create an onTabPidChange callback that updates session state in the store.
 * Called when a PTY is spawned and the PID is known.
 */
export function createTabPidChangeHandler(sessionId: string) {
	return (tabId: string, pid: number) => {
		useSessionStore
			.getState()
			.setSessions((prev) =>
				prev.map((s) => (s.id === sessionId ? updateTerminalTabPid(s, tabId, pid) : s))
			);
	};
}
