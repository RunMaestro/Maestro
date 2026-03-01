import { memo, forwardRef, useImperativeHandle, useRef, useEffect } from 'react';
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

		// Spawn PTY when active tab changes and has no PID yet
		useEffect(() => {
			if (!activeTab || activeTab.pid !== 0 || activeTab.state === 'exited') {
				return;
			}

			const terminalSessionId = getTerminalSessionId(session.id, activeTab.id);
			const tabId = activeTab.id;

			window.maestro.process
				.spawnTerminalTab({
					sessionId: terminalSessionId,
					cwd: activeTab.cwd || session.cwd,
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
		// eslint-disable-next-line react-hooks/exhaustive-deps
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
		// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [activeTab?.id]);

		// Subscribe to PTY exit events for terminal tabs in this session
		useEffect(() => {
			const cleanup = window.maestro.process.onExit((exitSessionId: string, code: number) => {
				const parsed = parseTerminalSessionId(exitSessionId);
				if (!parsed || parsed.sessionId !== session.id) return;
				onTabStateChange(parsed.tabId, 'exited', code);
			});
			return cleanup;
		// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [session.id]);

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

					return (
						<div
							key={tab.id}
							className={`absolute inset-0 ${isActive ? '' : 'invisible'}`}
							style={{ pointerEvents: isActive ? 'auto' : 'none' }}
						>
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
									} else {
										terminalRefs.current.delete(tab.id);
									}
								}}
								sessionId={terminalSessionId}
								theme={theme}
								fontFamily={fontFamily}
								fontSize={fontSize}
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
