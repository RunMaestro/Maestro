import { memo, useCallback, useEffect, useRef } from 'react';
import { XTerminal, type XTerminalHandle } from './XTerminal';
import { TerminalTabBar } from './TerminalTabBar';
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
}

export const TerminalView = memo(function TerminalView(props: TerminalViewProps) {
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
	} = props;

	const terminalRefs = useRef<Map<string, XTerminalHandle>>(new Map());
	const activeTab = getActiveTerminalTab(session);

	const spawnPtyForTab = useCallback(
		async (tab: TerminalTab) => {
			if (tab.pid > 0 || tab.state === 'exited') {
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
					onTabPidChange(tab.id, result.pid);
					onTabStateChange(tab.id, 'idle');
					return;
				}

				onTabStateChange(tab.id, 'exited', 1);
				onTabPidChange(tab.id, 0);
			} catch {
				onTabStateChange(tab.id, 'exited', 1);
				onTabPidChange(tab.id, 0);
			}
		},
		[
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
				{session.terminalTabs.map((tab) => {
					const isActive = tab.id === session.activeTerminalTabId;
					return (
						<div
							key={tab.id}
							className={`absolute inset-0 ${isActive ? '' : 'invisible pointer-events-none'}`}
						>
							<XTerminal
								ref={(handle) => setTerminalRef(tab.id, handle)}
								sessionId={getTerminalSessionId(session.id, tab.id)}
								theme={theme}
								fontFamily={fontFamily}
								fontSize={fontSize}
							/>
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
});
