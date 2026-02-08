import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { AlertCircle } from 'lucide-react';
import { XTerminal, type XTerminalHandle } from './XTerminal';
import { TerminalTabBar } from './TerminalTabBar';
import { TerminalSearchBar } from './TerminalSearchBar';
import type { Session, TerminalTab, Theme } from '../types';
import { getActiveTerminalTab, getTerminalSessionId } from '../utils/terminalTabHelpers';

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
		const activeTab = getActiveTerminalTab(session);

		useEffect(() => {
			latestTabsRef.current = session.terminalTabs;
		}, [session.terminalTabs]);

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
				try {
					const result = await window.maestro.process.spawnTerminalTab({
						sessionId: terminalSessionId,
						cwd: tab.cwd || session.cwd,
						shell: defaultShell,
						shellArgs,
						shellEnvVars,
					});

					if (result.success && result.pid > 0) {
						const latestTab = getLatestTab(tab.id);
						if (!latestTab || (!allowExited && latestTab.state === 'exited')) {
							return;
						}

						onTabPidChange(tab.id, result.pid);
						onTabStateChange(tab.id, 'idle');
						return;
					}

					if (!getLatestTab(tab.id)) {
						return;
					}

					onTabStateChange(tab.id, 'exited', 1);
					onTabPidChange(tab.id, 0);
				} catch {
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

		useEffect(() => {
			if (!activeTab) {
				return;
			}

			terminalRefs.current.get(activeTab.id)?.focus();
		}, [activeTab?.id]);

		useEffect(() => {
			return window.maestro.process.onExit((sessionId, code) => {
				const matchingTab = session.terminalTabs.find(
					(tab) => getTerminalSessionId(session.id, tab.id) === sessionId
				);

				if (!matchingTab) {
					return;
				}

				onTabStateChange(matchingTab.id, 'exited', code);
				onTabPidChange(matchingTab.id, 0);
			});
		}, [session.id, session.terminalTabs, onTabStateChange, onTabPidChange]);

		const handleTabClose = useCallback(
			async (tabId: string) => {
				const tab = session.terminalTabs.find((candidate) => candidate.id === tabId);
				try {
					if (tab && tab.pid > 0) {
						await window.maestro.process.kill(getTerminalSessionId(session.id, tabId));
					}
				} finally {
					onTabClose(tabId);
				}
			},
			[session.id, session.terminalTabs, onTabClose]
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
						const showSpawnFailure = isSpawnFailureTab(tab);
						return (
							<div
								key={tab.id}
								className={`absolute inset-0 ${isActive ? '' : 'invisible pointer-events-none'}`}
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
