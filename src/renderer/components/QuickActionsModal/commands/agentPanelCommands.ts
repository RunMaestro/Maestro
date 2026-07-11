import type React from 'react';
import type { Group, RightPanelTab, Session } from '../../../types';
import { getAllFolderPaths } from '../../../utils/fileExplorer';
import type { QuickAction, QuickActionMode } from '../types';

interface BuildAgentPanelCommandsArgs {
	activeSession: Session | undefined;
	groups: Group[];
	sessions: Session[];
	setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	setQuickActionOpen: (open: boolean) => void;
	setRenameGroupModalOpen: (open: boolean) => void;
	setRenameGroupId: (id: string) => void;
	setRenameGroupValue: (value: string) => void;
	setRenameGroupEmoji: (emoji: string) => void;
	setRenameGroupIcon: (icon: string | undefined) => void;
	setRenameGroupColor: (color: string | undefined) => void;
	setCreateGroupModalOpen: (open: boolean) => void;
	setRightPanelOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
	setActiveRightTab: (tab: RightPanelTab) => void;
	setMode: (mode: QuickActionMode) => void;
	resetSelectionToFirst: () => void;
	moveToGroupShortcut?: QuickAction['shortcut'];
	ungroupedCollapsed: boolean;
	setUngroupedCollapsed: (collapsed: boolean) => void;
	bookmarksCollapsed: boolean;
	setBookmarksCollapsed: (collapsed: boolean) => void;
	groupChatsExpanded: boolean;
	setGroupChatsExpanded: (expanded: boolean) => void;
}

export function buildAgentPanelCommands({
	activeSession,
	groups,
	sessions,
	setGroups,
	setSessions,
	setQuickActionOpen,
	setRenameGroupModalOpen,
	setRenameGroupId,
	setRenameGroupValue,
	setRenameGroupEmoji,
	setRenameGroupIcon,
	setRenameGroupColor,
	setCreateGroupModalOpen,
	setRightPanelOpen,
	setActiveRightTab,
	setMode,
	resetSelectionToFirst,
	moveToGroupShortcut,
	ungroupedCollapsed,
	setUngroupedCollapsed,
	bookmarksCollapsed,
	setBookmarksCollapsed,
	groupChatsExpanded,
	setGroupChatsExpanded,
}: BuildAgentPanelCommandsArgs): QuickAction[] {
	const commands: QuickAction[] = [];

	if (activeSession?.groupId) {
		commands.push({
			id: 'renameGroup',
			label: 'Rename Group',
			action: () => {
				const group = groups.find((g) => g.id === activeSession.groupId);
				if (group) {
					setRenameGroupId(group.id);
					setRenameGroupValue(group.name);
					setRenameGroupEmoji(group.emoji);
					setRenameGroupIcon(group.icon);
					setRenameGroupColor(group.color);
					setRenameGroupModalOpen(true);
					setQuickActionOpen(false);
				}
			},
		});
	}

	if (activeSession) {
		commands.push({
			id: 'moveToGroup',
			label: 'Move to Group...',
			shortcut: moveToGroupShortcut,
			action: () => {
				setMode('move-to-group');
				resetSelectionToFirst();
			},
		});
	}

	commands.push({
		id: 'createGroup',
		label: 'Create New Group',
		action: () => {
			setCreateGroupModalOpen(true);
			setQuickActionOpen(false);
		},
	});

	if (groups.some((group) => group.collapsed) || ungroupedCollapsed) {
		commands.push({
			id: 'expandAllGroups',
			label: 'Expand All Agent Groups',
			action: () => {
				setGroups((prev) =>
					prev.map((group) => (group.collapsed ? { ...group, collapsed: false } : group))
				);
				setUngroupedCollapsed(false);
				setQuickActionOpen(false);
			},
		});
	}

	if (groups.some((group) => !group.collapsed) || !ungroupedCollapsed) {
		commands.push({
			id: 'collapseAllGroups',
			label: 'Collapse All Agent Groups',
			action: () => {
				setGroups((prev) =>
					prev.map((group) => (group.collapsed ? group : { ...group, collapsed: true }))
				);
				setUngroupedCollapsed(true);
				setQuickActionOpen(false);
			},
		});
	}

	if (
		groups.some((group) => group.collapsed) ||
		(sessions.some((session) => session.bookmarked) && bookmarksCollapsed) ||
		ungroupedCollapsed ||
		!groupChatsExpanded
	) {
		commands.push({
			id: 'expandEntireAgentPanel',
			label: 'Expand Entire Agent Panel',
			action: () => {
				setGroups((prev) =>
					prev.map((group) => (group.collapsed ? { ...group, collapsed: false } : group))
				);
				setBookmarksCollapsed(false);
				setUngroupedCollapsed(false);
				setGroupChatsExpanded(true);
				setQuickActionOpen(false);
			},
		});
	}

	if (
		groups.some((group) => !group.collapsed) ||
		(sessions.some((session) => session.bookmarked) && !bookmarksCollapsed) ||
		!ungroupedCollapsed ||
		groupChatsExpanded
	) {
		commands.push({
			id: 'collapseEntireAgentPanel',
			label: 'Collapse Entire Agent Panel',
			action: () => {
				setGroups((prev) =>
					prev.map((group) => (group.collapsed ? group : { ...group, collapsed: true }))
				);
				setBookmarksCollapsed(true);
				setUngroupedCollapsed(true);
				setGroupChatsExpanded(false);
				setQuickActionOpen(false);
			},
		});
	}

	if (activeSession?.fileTree?.length) {
		const allFolderPaths = getAllFolderPaths(activeSession.fileTree);
		if (allFolderPaths.length > 0) {
			const expanded = activeSession.fileExplorerExpanded ?? [];
			const expandedSet = new Set(expanded);
			const hasUnexpanded = allFolderPaths.some((path) => !expandedSet.has(path));
			const hasExpanded = expanded.length > 0;
			const sessionId = activeSession.id;

			if (hasUnexpanded) {
				commands.push({
					id: 'expandAllFolders',
					label: 'Expand All Folders in File Panel',
					action: () => {
						setSessions((prev) =>
							prev.map((session) =>
								session.id === sessionId
									? { ...session, fileExplorerExpanded: allFolderPaths }
									: session
							)
						);
						setRightPanelOpen(true);
						setActiveRightTab('files');
						setQuickActionOpen(false);
					},
				});
			}

			if (hasExpanded) {
				commands.push({
					id: 'collapseAllFolders',
					label: 'Collapse All Folders in File Panel',
					action: () => {
						setSessions((prev) =>
							prev.map((session) =>
								session.id === sessionId ? { ...session, fileExplorerExpanded: [] } : session
							)
						);
						setRightPanelOpen(true);
						setActiveRightTab('files');
						setQuickActionOpen(false);
					},
				});
			}
		}
	}

	return commands;
}
