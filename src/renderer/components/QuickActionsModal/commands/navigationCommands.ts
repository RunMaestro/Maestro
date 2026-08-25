import type { Session } from '../../../types';
import type { QuickAction } from '../types';

interface BuildNavigationCommandsArgs {
	activeSession: Session | undefined;
	activeSessionId: string;
	setQuickActionOpen: (open: boolean) => void;
	setLeftSidebarOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
	setRightPanelOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
	addNewSession: () => void;
	deleteSession: (id: string) => void;
	openWizard?: () => void;
	getOpenInLabel: (platform: string) => string;
	platform: string;
	openPath?: (path: string) => void;
	// Shared with the Alt+Cmd+Down keyboard shortcut so both invocation paths
	// use the same sidebar-visible ordering and current-session clear semantics.
	onGoToNextUnread?: () => void;
	// Shared with the Cmd+Shift+, / Cmd+Shift+. keyboard shortcuts so both paths
	// walk the same session/tab navigation history.
	onNavBack?: () => void;
	onNavForward?: () => void;
	shortcuts: {
		newInstance?: QuickAction['shortcut'];
		openWizard?: QuickAction['shortcut'];
		toggleSidebar?: QuickAction['shortcut'];
		toggleRightPanel?: QuickAction['shortcut'];
		nextUnreadTab?: QuickAction['shortcut'];
		killInstance?: QuickAction['shortcut'];
		navBack?: QuickAction['shortcut'];
		navForward?: QuickAction['shortcut'];
	};
}

export function buildNavigationCommands({
	activeSession,
	activeSessionId,
	setQuickActionOpen,
	setLeftSidebarOpen,
	setRightPanelOpen,
	addNewSession,
	deleteSession,
	openWizard,
	getOpenInLabel,
	platform,
	openPath,
	onGoToNextUnread,
	onNavBack,
	onNavForward,
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
				// Delegate to the shared App.tsx callback so this matches the
				// Alt+Cmd+Down keyboard shortcut exactly (uses sortedSessions -
				// the sidebar's visible order - and the same clear semantics).
				onGoToNextUnread?.();
				setQuickActionOpen(false);
			},
		}
	);

	if (onNavBack) {
		commands.push({
			id: 'navBack',
			label: 'Navigate Back',
			shortcut: shortcuts.navBack,
			action: () => {
				onNavBack();
				setQuickActionOpen(false);
			},
		});
	}

	if (onNavForward) {
		commands.push({
			id: 'navForward',
			label: 'Navigate Forward',
			shortcut: shortcuts.navForward,
			action: () => {
				onNavForward();
				setQuickActionOpen(false);
			},
		});
	}

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
