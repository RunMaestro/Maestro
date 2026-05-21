import type React from 'react';
import type { Session } from '../../../types';
import { findNextUnreadSession } from '../../../utils/tabHelpers';
import type { QuickAction } from '../types';

interface BuildNavigationCommandsArgs {
	activeSession: Session | undefined;
	activeSessionId: string;
	sessions: Session[];
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	setActiveSessionId: (id: string) => void;
	setQuickActionOpen: (open: boolean) => void;
	setLeftSidebarOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
	setRightPanelOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
	setSuccessFlashNotification: (message: string | null) => void;
	addNewSession: () => void;
	deleteSession: (id: string) => void;
	openWizard?: () => void;
	getOpenInLabel: (platform: string) => string;
	platform: string;
	openPath?: (path: string) => void;
	shortcuts: {
		newInstance?: QuickAction['shortcut'];
		openWizard?: QuickAction['shortcut'];
		toggleSidebar?: QuickAction['shortcut'];
		toggleRightPanel?: QuickAction['shortcut'];
		nextUnreadTab?: QuickAction['shortcut'];
		killInstance?: QuickAction['shortcut'];
	};
}

export function buildNavigationCommands({
	activeSession,
	activeSessionId,
	sessions,
	setSessions,
	setActiveSessionId,
	setQuickActionOpen,
	setLeftSidebarOpen,
	setRightPanelOpen,
	setSuccessFlashNotification,
	addNewSession,
	deleteSession,
	openWizard,
	getOpenInLabel,
	platform,
	openPath,
	shortcuts,
}: BuildNavigationCommandsArgs): QuickAction[] {
	const commands: QuickAction[] = [
		{
			id: 'new',
			label: 'Create New Agent',
			shortcut: shortcuts.newInstance,
			action: addNewSession,
		},
	];

	if (openWizard) {
		commands.push({
			id: 'wizard',
			label: 'New Agent Wizard',
			shortcut: shortcuts.openWizard,
			action: () => {
				openWizard();
				setQuickActionOpen(false);
			},
		});
	}

	commands.push(
		{
			id: 'toggleSidebar',
			label: 'Toggle Sidebar',
			shortcut: shortcuts.toggleSidebar,
			action: () => setLeftSidebarOpen((prev) => !prev),
		},
		{
			id: 'toggleRight',
			label: 'Toggle Right Panel',
			shortcut: shortcuts.toggleRightPanel,
			action: () => setRightPanelOpen((prev) => !prev),
		},
		{
			id: 'nextUnreadTab',
			label: 'Next Unread / Draft Tab',
			shortcut: shortcuts.nextUnreadTab,
			action: () => {
				const result = findNextUnreadSession(sessions, activeSessionId);

				if (result.clearedCurrent) {
					setSessions((prev) =>
						prev.map((session) => {
							if (session.id !== activeSessionId) return session;
							return {
								...session,
								aiTabs: session.aiTabs.map((tab) =>
									tab.hasUnread ? { ...tab, hasUnread: false } : tab
								),
							};
						})
					);
				}

				if (result.jumped && result.targetSessionId) {
					setActiveSessionId(result.targetSessionId);
					const targetTabId = result.targetTabId;
					if (targetTabId) {
						setSessions((prev) =>
							prev.map((session) => {
								if (session.id !== result.targetSessionId) return session;
								return { ...session, activeTabId: targetTabId };
							})
						);
					}
				} else {
					setSuccessFlashNotification('No unread or draft tabs');
					setTimeout(() => setSuccessFlashNotification(null), 2000);
				}
				setQuickActionOpen(false);
			},
		}
	);

	if (activeSession && !activeSession.sshRemote) {
		commands.push({
			id: 'openWorkingDirectory',
			label: `${getOpenInLabel(platform)}: Working Directory`,
			subtext: activeSession.projectRoot,
			action: () => {
				openPath?.(activeSession.fullPath || activeSession.projectRoot);
				setQuickActionOpen(false);
			},
		});
	}

	if (activeSession) {
		commands.push({
			id: 'kill',
			label: `Remove Agent: ${activeSession.name}`,
			shortcut: shortcuts.killInstance,
			action: () => deleteSession(activeSessionId),
		});
	}

	return commands;
}
