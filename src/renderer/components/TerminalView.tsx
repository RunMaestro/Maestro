import { memo, forwardRef, useImperativeHandle, useRef, useEffect, useCallback } from 'react';
import { AlertCircle } from 'lucide-react';
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
import { captureException } from '../utils/sentry';
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

		// Shared spawn function — used both on mount and for retry
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
				const effectiveSshConfig = session.sessionSshRemoteConfig?.enabled
					? session.sessionSshRemoteConfig
					: session.sshRemoteId
						? {
								enabled: true,
								remoteId: session.sshRemoteId,
								// Use session.cwd as the remote working directory so the terminal starts
								// in the project directory rather than the remote home directory.
								workingDirOverride: session.cwd || undefined,
							}
						: undefined;

				window.maestro.process
					.spawnTerminalTab({
						sessionId: terminalSessionId,
						cwd: tab.cwd || session.cwd || session.projectRoot || '',
						shell: defaultShell || undefined,
						shellArgs,
						shellEnvVars,
						sessionSshRemoteConfig: effectiveSshConfig,
					})
					.then((result) => {
						if (result.success) {
							onTabPidChange(tabId, result.pid);
						} else {
							onTabStateChange(tabId, 'exited', 1);
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
						onTabStateChange(tabId, 'exited', 1);
					})
					.finally(() => {
						spawnInFlightRef.current.delete(tabId);
					});
			},
			[
				session.id,
				session.cwd,
				session.sessionSshRemoteConfig,
				session.sshRemoteId,
				defaultShell,
				shellArgs,
				shellEnvVars,
				onTabPidChange,
				onTabStateChange,
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

		// Write shell exit message to xterm buffer when a tab transitions to 'exited'
		useEffect(() => {
			const terminalTabs = session.terminalTabs || [];
			for (const tab of terminalTabs) {
				const prev = prevTabStatesRef.current.get(tab.id);
				if (prev !== undefined && prev !== 'exited' && tab.state === 'exited') {
					const handle = terminalRefs.current.get(tab.id);
					if (handle) {
						const code = tab.exitCode ?? 0;
						handle.write(
							`\r\n\x1b[33mShell exited (code: ${code}).\x1b[0m Press Ctrl+Shift+\` for new terminal.\r\n`
						);
					}
				}
				prevTabStatesRef.current.set(tab.id, tab.state);
			}
		}, [session.terminalTabs]);

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
					// Spawn failed: exited before getting a PID
					const isSpawnFailed = tab.state === 'exited' && tab.pid === 0;

					return (
						<div
							key={tab.id}
							className={`absolute inset-0 ${isActive ? '' : 'invisible'}`}
							style={{ pointerEvents: isActive ? 'auto' : 'none' }}
						>
							{isSpawnFailed ? (
								// Error state overlay for spawn failures
								<div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
									<AlertCircle className="w-8 h-8" style={{ color: theme.colors.error }} />
									<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
										Failed to start terminal
									</span>
									<button
										onClick={() => {
											// Clear the loading-written guard so 'Starting terminal...' shows again on retry
											loadingWrittenRef.current.delete(tab.id);
											onTabStateChange(tab.id, 'idle');
											onTabPidChange(tab.id, 0);
											spawnPtyForTab({ ...tab, state: 'idle', pid: 0 });
										}}
										className="px-3 py-1.5 rounded text-xs font-medium transition-opacity hover:opacity-80"
										style={{
											backgroundColor: theme.colors.accent,
											color: theme.colors.accentForeground,
										}}
									>
										Retry
									</button>
								</div>
							) : (
								<>
									{tab.state === 'exited' && (
										<div
											className="absolute top-0 left-0 right-0 z-10 px-3 py-1 text-xs text-center"
											style={{
												background: theme.colors.bgSidebar,
												color: theme.colors.textDim,
												borderBottom: `1px solid ${theme.colors.accentDim}`,
											}}
										>
											Process exited{tab.exitCode !== undefined ? ` (code ${tab.exitCode})` : ''} —
											press any key or create a new tab
										</div>
									)}
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
									/>
								</>
							)}
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
