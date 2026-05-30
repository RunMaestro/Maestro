import type { RightPanelTab } from '../../../types';
import type { QuickAction } from '../types';

interface BuildRightPanelCommandsArgs {
	autoRunDisabled: boolean;
	autoRunSelectedDocument?: string | null;
	autoRunCompletedTaskCount?: number;
	setRightPanelOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
	setActiveRightTab: (tab: RightPanelTab) => void;
	setQuickActionOpen: (open: boolean) => void;
	onToggleAutoRunExpanded?: () => void;
	onAutoRunResetTasks?: () => void;
	shortcuts: {
		goToFiles?: QuickAction['shortcut'];
		goToHistory?: QuickAction['shortcut'];
		goToAutoRun?: QuickAction['shortcut'];
		toggleAutoRunExpanded?: QuickAction['shortcut'];
	};
}

export function buildRightPanelCommands({
	autoRunDisabled,
	autoRunSelectedDocument,
	autoRunCompletedTaskCount,
	setRightPanelOpen,
	setActiveRightTab,
	setQuickActionOpen,
	onToggleAutoRunExpanded,
	onAutoRunResetTasks,
	shortcuts,
}: BuildRightPanelCommandsArgs): QuickAction[] {
	const commands: QuickAction[] = [
		{
			id: 'goToFiles',
			label: 'Go to Files Tab',
			shortcut: shortcuts.goToFiles,
			action: () => {
				setRightPanelOpen(true);
				setActiveRightTab('files');
				setQuickActionOpen(false);
			},
		},
		{
			id: 'goToHistory',
			label: 'Go to History Tab',
			shortcut: shortcuts.goToHistory,
			action: () => {
				setRightPanelOpen(true);
				setActiveRightTab('history');
				setQuickActionOpen(false);
			},
		},
	];

	if (!autoRunDisabled) {
		commands.push({
			id: 'goToAutoRun',
			label: 'Go to Auto Run Tab',
			shortcut: shortcuts.goToAutoRun,
			action: () => {
				setRightPanelOpen(true);
				setActiveRightTab('autorun');
				setQuickActionOpen(false);
			},
		});

		if (onToggleAutoRunExpanded) {
			commands.push({
				id: 'autoRunExpandedPreview',
				label: 'Auto Run Expanded Preview',
				subtext: 'Open the Auto Run document in a centered modal',
				shortcut: shortcuts.toggleAutoRunExpanded,
				action: () => {
					onToggleAutoRunExpanded();
					setQuickActionOpen(false);
				},
			});
		}

		if (
			autoRunSelectedDocument &&
			autoRunCompletedTaskCount &&
			autoRunCompletedTaskCount > 0 &&
			onAutoRunResetTasks
		) {
			commands.push({
				id: 'resetAutoRunTasks',
				label: `Reset Finished Tasks in ${autoRunSelectedDocument}`,
				subtext: `Uncheck ${autoRunCompletedTaskCount} completed task${autoRunCompletedTaskCount !== 1 ? 's' : ''}`,
				action: () => {
					onAutoRunResetTasks();
					setQuickActionOpen(false);
				},
			});
		}
	}

	return commands;
}
