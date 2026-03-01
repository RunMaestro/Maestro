import { memo, forwardRef, useImperativeHandle, useRef, useEffect, useCallback } from 'react';
import { AlertCircle } from 'lucide-react';
import { XTerminal, XTerminalHandle } from './XTerminal';
import { TerminalSearchBar } from './TerminalSearchBar';
import { getActiveTerminalTab, getTerminalSessionId, parseTerminalSessionId, updateTerminalTabState, updateTerminalTabPid } from '../utils/terminalTabHelpers';
import { useSessionStore } from '../stores/sessionStore';
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
		},
		ref
	) {
		// Map of tabId → XTerminalHandle ref for each tab instance
		const terminalRefs = useRef<Map<string, XTerminalHandle>>(new Map());
		// Track previous tab states to detect transitions (for exit message)
		const prevTabStatesRef = useRef<Map<string, TerminalTab['state']>>(new Map());

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
				const terminalSessionId = getTerminalSessionId(session.id, tab.id);
				const tabId = tab.id;

				window.maestro.process
					.spawnTerminalTab({
						sessionId: terminalSessionId,
						cwd: tab.cwd || session.cwd,
						shell: defaultShell || undefined,
						shellArgs,
						shellEnvVars,
					})
					.then((result) => {
						if (result.success) {
							onTabPidChange(tabId, result.pid);
						} else {
							onTabStateChange(tabId, 'exited', 1);
						}
					})
					.catch(() => {
						onTabStateChange(tabId, 'exited', 1);
					});
			},
			[session.id, session.cwd, defaultShell, shellArgs, shellEnvVars]
		);

		// Spawn PTY when active tab changes and has no PID yet
		useEffect(() => {
			if (!activeTab || activeTab.pid !== 0 || activeTab.state === 'exited') {
				return;
			}
			spawnPtyForTab(activeTab);
		}, [activeTab?.id]);

		// Focus the active terminal when the active tab changes
		useEffect(() => {
			if (activeTab) {
				// Use a short delay so the DOM is visible before focusing
				const timer = setTimeout(() => {
					terminalRefs.current.get(activeTab.id)?.focus();
				}, 50);
				return () => clearTimeout(timer);
			}
		}, [activeTab?.id]);

		// Close search when the active terminal tab changes
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
						handle.write(`\r\n\x1b[33mShell exited (code: ${code}).\x1b[0m Press Ctrl+Shift+\` for new terminal.\r\n`);
					}
				}
				prevTabStatesRef.current.set(tab.id, tab.state);
			}
		}, [session.terminalTabs]);

		const terminalTabs = session.terminalTabs || [];

		if (terminalTabs.length === 0) {
			return (
				<div className="flex-1 flex items-center justify-center text-sm" style={{ color: theme.colors.textDim }}>
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
											Process exited{tab.exitCode !== undefined ? ` (code ${tab.exitCode})` : ''} — press any key or create a new tab
										</div>
									)}
									<XTerminal
										ref={(handle) => {
											if (handle) {
												terminalRefs.current.set(tab.id, handle);
												// Write loading indicator when terminal mounts with no PTY yet
												if (tab.pid === 0 && tab.state === 'idle') {
													setTimeout(() => {
														handle.write('\x1b[2mStarting terminal...\x1b[0m');
													}, 0);
												}
											} else {
												terminalRefs.current.delete(tab.id);
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
		useSessionStore.getState().setSessions((prev) =>
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
		useSessionStore.getState().setSessions((prev) =>
			prev.map((s) => (s.id === sessionId ? updateTerminalTabPid(s, tabId, pid) : s))
		);
	};
}
