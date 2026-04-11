import { memo, forwardRef, useImperativeHandle, useRef, useEffect, useCallback } from 'react';
import { XTerminal, XTerminalHandle } from './XTerminal';
import { TerminalSearchBar } from './TerminalSearchBar';
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
import type { Session, TerminalTab } from '../types';
import type { Theme } from '../../shared/theme-types';

// ============================================================================
// Types
// ============================================================================

export interface TerminalViewHandle {
	clearActiveTerminal(): void;
	focusActiveTerminal(): void;
	searchActiveTerminal(query: string): boolean;
	searchNext(): boolean;
	searchPrevious(): boolean;
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

		const activeTab = getActiveTerminalTab(session);

		// Expose imperative handle to parent
		useImperativeHandle(
			ref,
			(): TerminalViewHandle => ({
				clearActiveTerminal() {
					if (activeTab) {
						terminalRefs.current.get(activeTab.id)?.clear();
					}
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

				const terminalSessionId = getTerminalSessionId(session.id, tabId);

				// Build effective SSH config: prefer explicit sessionSshRemoteConfig, then fall back
				// to sshRemoteId which is set after an AI agent connects. Without this fallback,
				// terminal tabs under running SSH agents spawn locally instead of on the remote host.
				//
				// workingDirOverride must be a REMOTE path. session.remoteCwd is the tracked remote
				// working directory; sessionSshRemoteConfig.workingDirOverride is the user-configured
				// remote project root. session.cwd is LOCAL and must NOT be used here — it would
				// cause `cd "/local/path"` on the remote, which fails and exits SSH immediately.
				const effectiveSshConfig = session.sessionSshRemoteConfig?.enabled
					? {
							...session.sessionSshRemoteConfig,
							workingDirOverride:
								session.sessionSshRemoteConfig.workingDirOverride || session.remoteCwd || undefined,
						}
					: session.sshRemoteId
						? {
								enabled: true,
								remoteId: session.sshRemoteId,
								workingDirOverride:
									session.remoteCwd ||
									session.sessionSshRemoteConfig?.workingDirOverride ||
									undefined,
							}
						: undefined;

				window.maestro.process
					.spawnTerminalTab({
						sessionId: terminalSessionId,
						cwd: tab.cwd || session.cwd || session.projectRoot || '',
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
						} else {
							// Spawn failed — close the tab and notify via batched toast
							setTimeout(() => closeTerminalTab(tabId), 0);
							notifySpawnFailure(
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
						// Spawn threw — close the tab and notify via batched toast
						setTimeout(() => closeTerminalTab(tabId), 0);
						notifySpawnFailure(
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
				// onTabPidChange accessed via stable ref — not a dep
				// onTabStateChange not used in this callback
				closeTerminalTab,
				notifySpawnFailure,
			]
		);

		// Spawn PTY when active tab changes and has no PID yet
		useEffect(() => {
			if (!activeTab || activeTab.pid !== 0 || activeTab.state === 'exited') {
				return;
			}
			spawnPtyForTab(activeTab);
		}, [activeTab?.id, spawnPtyForTab]);

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

		// Auto-close terminal tabs when the shell process exits.
		// Startup failures (exit within 2s) show an error toast; normal exits close silently.
		useEffect(() => {
			const terminalTabs = session.terminalTabs || [];
			for (const tab of terminalTabs) {
				const prev = prevTabStatesRef.current.get(tab.id);
				if (prev !== undefined && prev !== 'exited' && tab.state === 'exited') {
					const age = Date.now() - tab.createdAt;
					const tabId = tab.id;
					if (age < 2000) {
						// Startup failure — close tab and show error toast
						console.warn(
							`[TerminalView] Shell exited ${age}ms after creation (exit code: ${tab.exitCode ?? '?'}). Closing tab.`
						);
						setTimeout(() => closeTerminalTab(tabId), 0);
						notifySpawnFailure(
							`Shell exited immediately${tab.exitCode != null ? ` (exit code: ${tab.exitCode})` : ''}.`
						);
					} else {
						// Close on next tick to avoid mutating state mid-render
						setTimeout(() => closeTerminalTab(tabId), 0);
					}
				}
				prevTabStatesRef.current.set(tab.id, tab.state);
			}
		}, [session.terminalTabs, closeTerminalTab]);

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
					const isActive = tab.id === session.activeTerminalTabId;
					const terminalSessionId = getTerminalSessionId(session.id, tab.id);

					return (
						<div
							key={tab.id}
							className={`absolute inset-0 ${isActive ? '' : 'invisible'}`}
							style={{ pointerEvents: isActive ? 'auto' : 'none' }}
						>
							<XTerminal
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
								isActive={isActive}
							/>
						</div>
					);
				})}
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
