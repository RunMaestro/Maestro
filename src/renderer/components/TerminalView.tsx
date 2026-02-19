import {
	forwardRef,
	memo,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
} from 'react';
import { AlertCircle } from 'lucide-react';
import { XTerminal, type XTerminalHandle } from './XTerminal';
import { TerminalTabBar } from './TerminalTabBar';
import { TerminalSearchBar } from './TerminalSearchBar';
import type { Session, TerminalTab, Theme } from '../types';
import { getActiveTerminalTab, getTerminalSessionId } from '../utils/terminalTabHelpers';
import { captureException } from '../utils/sentry';

const SHELL_EXIT_MESSAGE =
	'\r\n\x1b[33mShell exited.\x1b[0m Press any key to close, or Ctrl+Shift+` for new terminal.\r\n';

interface TerminalViewProps {
	session: Session;
	theme: Theme;
	fontFamily: string;
	fontSize?: number;
	defaultShell: string;
	shellArgs?: string;
	shellEnvVars?: Record<string, string>;
	onTabSelect: (tabId: string) => void;
	onTabClose: (tabId: string) => void;
	onNewTab: () => void;
	onTabRename: (tabId: string, name: string) => void;
	onTabReorder: (fromIndex: number, toIndex: number) => void;
	onTabStateChange: (tabId: string, state: TerminalTab['state'], exitCode?: number) => void;
	onTabCwdChange: (tabId: string, cwd: string) => void;
	onTabPidChange: (tabId: string, pid: number) => void;
	onRequestRename?: (tabId: string) => void;
	searchOpen?: boolean;
	onSearchClose?: () => void;
}

export interface TerminalViewHandle {
	clearActiveTerminal: () => void;
	focusActiveTerminal: () => void;
	searchActiveTerminal: (query: string) => boolean;
	searchNext: () => boolean;
	searchPrevious: () => boolean;
}

/**
 * Renders the terminal tab workspace and owns PTY lifecycle for each tab.
 */
export const TerminalView = memo(
	forwardRef<TerminalViewHandle, TerminalViewProps>(function TerminalView(props, ref) {
		const {
			session,
			theme,
			fontFamily,
			fontSize = 14,
			defaultShell,
			shellArgs,
			shellEnvVars,
			onTabSelect,
			onTabClose,
			onNewTab,
			onTabReorder,
			onTabStateChange,
			onTabPidChange,
			onRequestRename,
			searchOpen,
			onSearchClose,
		} = props;

		const terminalRefs = useRef<Map<string, XTerminalHandle>>(new Map());
		const latestTabsRef = useRef<TerminalTab[]>(session.terminalTabs);
		const shellExitedTabsRef = useRef<Set<string>>(new Set());
		const [focusedTabId, setFocusedTabId] = useState<string | null>(null);
		const activeTab = getActiveTerminalTab(session);

		useEffect(() => {
			latestTabsRef.current = session.terminalTabs;
		}, [session.terminalTabs]);

		useEffect(() => {
			const tabsById = new Map(session.terminalTabs.map((tab) => [tab.id, tab]));
			for (const tabId of shellExitedTabsRef.current) {
				const tab = tabsById.get(tabId);
				if (!tab || tab.state !== 'exited' || tab.pid > 0) {
					shellExitedTabsRef.current.delete(tabId);
				}
			}
		}, [session.terminalTabs]);

		useEffect(() => {
			if (!focusedTabId) {
				return;
			}

			const isFocusedTabStillOpen = session.terminalTabs.some((tab) => tab.id === focusedTabId);
			if (!isFocusedTabStillOpen) {
				setFocusedTabId(null);
			}
		}, [session.terminalTabs, focusedTabId]);

		const getLatestTab = useCallback((tabId: string) => {
			return latestTabsRef.current.find((tab) => tab.id === tabId);
		}, []);

		const getActiveTerminalHandle = useCallback(() => {
			if (!session.activeTerminalTabId) {
				return null;
			}

			return terminalRefs.current.get(session.activeTerminalTabId) ?? null;
		}, [session.activeTerminalTabId]);

		useImperativeHandle(
			ref,
			() => ({
				clearActiveTerminal: () => {
					getActiveTerminalHandle()?.clear();
				},
				focusActiveTerminal: () => {
					getActiveTerminalHandle()?.focus();
				},
				searchActiveTerminal: (query: string) => getActiveTerminalHandle()?.search(query) ?? false,
				searchNext: () => getActiveTerminalHandle()?.searchNext() ?? false,
				searchPrevious: () => getActiveTerminalHandle()?.searchPrevious() ?? false,
			}),
			[getActiveTerminalHandle]
		);

		const spawnPtyForTab = useCallback(
			async (tab: TerminalTab, allowExited = false) => {
				if (tab.pid > 0 || (!allowExited && tab.state === 'exited')) {
					return;
				}

				const terminalSessionId = getTerminalSessionId(session.id, tab.id);
				const tabShell = tab.shellType ?? defaultShell;
				try {
					const result = await window.maestro.process.spawnTerminalTab({
						sessionId: terminalSessionId,
						cwd: tab.cwd || session.cwd,
						shell: tabShell,
						shellArgs,
						shellEnvVars,
						...(session.sessionSshRemoteConfig
							? { sessionSshRemoteConfig: session.sessionSshRemoteConfig }
							: {}),
					});

					if (result.success && result.pid > 0) {
						const latestTab = getLatestTab(tab.id);
						// Spawn resolves asynchronously, so ignore late success for tabs that were
						// closed (or already marked exited) while the process request was in flight.
						if (!latestTab || (!allowExited && latestTab.state === 'exited')) {
							return;
						}

						shellExitedTabsRef.current.delete(tab.id);
						onTabPidChange(tab.id, result.pid);
						onTabStateChange(tab.id, 'idle');
						return;
					}

					if (!getLatestTab(tab.id)) {
						return;
					}

					onTabStateChange(tab.id, 'exited', 1);
					onTabPidChange(tab.id, 0);
				} catch (error) {
					captureException(error, {
						tags: {
							component: 'TerminalView',
							operation: 'spawnPtyForTab',
							api: 'window.maestro.process.spawnTerminalTab',
						},
						extra: {
							sessionId: session.id,
							tabId: tab.id,
							terminalSessionId,
							cwd: tab.cwd || session.cwd,
							shell: tabShell,
							hasShellArgs: Boolean(shellArgs),
							hasShellEnvVars: Boolean(shellEnvVars && Object.keys(shellEnvVars).length > 0),
							hasSessionSshRemoteConfig: Boolean(session.sessionSshRemoteConfig),
						},
					});

					if (!getLatestTab(tab.id)) {
						return;
					}

					onTabStateChange(tab.id, 'exited', 1);
					onTabPidChange(tab.id, 0);
				}
			},
			[
				getLatestTab,
				session.id,
				session.cwd,
				session.sessionSshRemoteConfig,
				defaultShell,
				shellArgs,
				shellEnvVars,
				onTabPidChange,
				onTabStateChange,
			]
		);

		useEffect(() => {
			if (activeTab && activeTab.pid === 0 && activeTab.state !== 'exited') {
				void spawnPtyForTab(activeTab);
			}
		}, [activeTab, spawnPtyForTab]);

		useLayoutEffect(() => {
			if (!activeTab) {
				setFocusedTabId(null);
				return;
			}

			terminalRefs.current.get(activeTab.id)?.focus();
		}, [activeTab?.id]);

		useEffect(() => {
			const handleWindowFocus = () => {
				getActiveTerminalHandle()?.focus();
			};

			window.addEventListener('focus', handleWindowFocus);

			return () => {
				window.removeEventListener('focus', handleWindowFocus);
			};
		}, [getActiveTerminalHandle]);

		useEffect(() => {
			return window.maestro.process.onExit((sessionId, code) => {
				const matchingTab = session.terminalTabs.find(
					(tab) => getTerminalSessionId(session.id, tab.id) === sessionId
				);

				if (!matchingTab) {
					return;
				}

				if (matchingTab.pid > 0) {
					shellExitedTabsRef.current.add(matchingTab.id);
					terminalRefs.current.get(matchingTab.id)?.write(SHELL_EXIT_MESSAGE);
				} else {
					shellExitedTabsRef.current.delete(matchingTab.id);
				}

				onTabStateChange(matchingTab.id, 'exited', code);
				onTabPidChange(matchingTab.id, 0);
			});
		}, [session.id, session.terminalTabs, onTabStateChange, onTabPidChange]);

		const handleTabClose = useCallback(
			async (tabId: string) => {
				const tab = session.terminalTabs.find((candidate) => candidate.id === tabId);
				if (focusedTabId === tabId) {
					setFocusedTabId(null);
				}
				shellExitedTabsRef.current.delete(tabId);
				try {
					if (tab && tab.pid > 0) {
						try {
							await window.maestro.process.kill(getTerminalSessionId(session.id, tabId));
						} catch (error) {
							captureException(error, {
								tags: {
									component: 'TerminalView',
									operation: 'handleTabClose',
									api: 'window.maestro.process.kill',
								},
								extra: {
									sessionId: session.id,
									tabId,
									terminalSessionId: getTerminalSessionId(session.id, tabId),
									tabPid: tab.pid,
								},
							});
						}
					}
				} finally {
					onTabClose(tabId);
				}
			},
			[session.id, session.terminalTabs, onTabClose, focusedTabId]
		);

		const handleTerminalInput = useCallback(
			(tabId: string, data: string) => {
				if (!data || !shellExitedTabsRef.current.has(tabId)) {
					return;
				}

				// Exited tabs close on first keypress so users can dismiss the tab quickly
				// without sending bytes to a dead PTY.
				shellExitedTabsRef.current.delete(tabId);
				void handleTabClose(tabId);
			},
			[handleTabClose]
		);

		const handleCloseOtherTabs = useCallback(
			(tabId: string) => {
				onTabSelect(tabId);
				const tabIdsToClose = session.terminalTabs
					.filter((tab) => tab.id !== tabId)
					.map((tab) => tab.id);

				for (const tabIdToClose of tabIdsToClose) {
					void handleTabClose(tabIdToClose);
				}
			},
			[session.terminalTabs, onTabSelect, handleTabClose]
		);

		const handleCloseTabsRight = useCallback(
			(tabId: string) => {
				const tabIndex = session.terminalTabs.findIndex((tab) => tab.id === tabId);
				if (tabIndex === -1) {
					return;
				}

				const tabIdsToClose = session.terminalTabs.slice(tabIndex + 1).map((tab) => tab.id);
				for (const tabIdToClose of tabIdsToClose) {
					void handleTabClose(tabIdToClose);
				}
			},
			[session.terminalTabs, handleTabClose]
		);

		const setTerminalRef = useCallback((tabId: string, handle: XTerminalHandle | null) => {
			if (handle) {
				terminalRefs.current.set(tabId, handle);
				return;
			}

			terminalRefs.current.delete(tabId);
		}, []);

		const handleSearch = useCallback(
			(query: string) => getActiveTerminalHandle()?.search(query) ?? false,
			[getActiveTerminalHandle]
		);

		const handleSearchNext = useCallback(
			() => getActiveTerminalHandle()?.searchNext() ?? false,
			[getActiveTerminalHandle]
		);

		const handleSearchPrevious = useCallback(
			() => getActiveTerminalHandle()?.searchPrevious() ?? false,
			[getActiveTerminalHandle]
		);

		const handleSearchClose = useCallback(() => {
			onSearchClose?.();
		}, [onSearchClose]);

		const isSpawnFailureTab = useCallback((tab: TerminalTab) => {
			if (shellExitedTabsRef.current.has(tab.id)) {
				// Shell exits reuse the in-terminal yellow notice instead of the failure pane.
				return false;
			}

			return (
				tab.state === 'exited' && tab.pid === 0 && tab.exitCode !== undefined && tab.exitCode !== 0
			);
		}, []);

		return (
			<div className="flex h-full flex-col">
				<TerminalTabBar
					tabs={session.terminalTabs}
					activeTabId={session.activeTerminalTabId}
					theme={theme}
					onTabSelect={onTabSelect}
					onTabClose={handleTabClose}
					onNewTab={onNewTab}
					onRequestRename={onRequestRename}
					onTabReorder={onTabReorder}
					onCloseOtherTabs={handleCloseOtherTabs}
					onCloseTabsRight={handleCloseTabsRight}
				/>

				<div className="relative flex-1 overflow-hidden">
					<TerminalSearchBar
						theme={theme}
						isOpen={searchOpen ?? false}
						onClose={handleSearchClose}
						onSearch={handleSearch}
						onSearchNext={handleSearchNext}
						onSearchPrevious={handleSearchPrevious}
					/>

					{session.terminalTabs.map((tab) => {
						const isActive = tab.id === session.activeTerminalTabId;
						const isFocused = isActive && focusedTabId === tab.id;
						const showSpawnFailure = isSpawnFailureTab(tab);
						return (
							<div
								key={tab.id}
								data-testid={`terminal-pane-${tab.id}`}
								className={`absolute inset-0 border border-transparent transition-shadow ${isActive ? '' : 'invisible pointer-events-none'}`}
								style={
									isFocused
										? {
												boxShadow: `inset 0 0 0 1px ${theme.colors.accent}`,
											}
										: undefined
								}
							>
								{showSpawnFailure ? (
									<div className="flex h-full items-center justify-center">
										<div className="flex flex-col items-center gap-3 text-center">
											<AlertCircle className="h-8 w-8" style={{ color: theme.colors.error }} />
											<p className="text-sm" style={{ color: theme.colors.textMain }}>
												Failed to start terminal
											</p>
											<button
												type="button"
												onClick={() => {
													void spawnPtyForTab(tab, true);
												}}
												className="rounded-md border px-3 py-1.5 text-sm"
												style={{
													borderColor: theme.colors.border,
													color: theme.colors.textMain,
													backgroundColor: theme.colors.bgSidebar,
												}}
											>
												Retry
											</button>
										</div>
									</div>
								) : (
									<XTerminal
										ref={(handle) => setTerminalRef(tab.id, handle)}
										sessionId={getTerminalSessionId(session.id, tab.id)}
										theme={theme}
										fontFamily={fontFamily}
										fontSize={fontSize}
										processInputEnabled={tab.pid > 0}
										onFocus={() => {
											setFocusedTabId(tab.id);
										}}
										onBlur={() => {
											setFocusedTabId((currentTabId) =>
												currentTabId === tab.id ? null : currentTabId
											);
										}}
										onData={(data) => {
											handleTerminalInput(tab.id, data);
										}}
									/>
								)}
							</div>
						);
					})}

					{session.terminalTabs.length === 0 && (
						<div
							className="flex h-full items-center justify-center text-sm"
							style={{ color: theme.colors.textDim }}
						>
							No terminal tabs. Click + to create one.
						</div>
					)}
				</div>
			</div>
		);
	})
);
