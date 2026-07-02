import type React from 'react';
import type { Session } from '../../../types';
import type { QuickAction } from '../types';
import { alphabetizeKey } from '../utils/quickActionSorting';
import { makeAgentJumpAction, type GetSessionWindow } from './agentJumpAction';

interface BuildSessionCommandsArgs {
	sessions: Session[];
	setActiveSessionId: (id: string) => void;
	revealJumpTarget: (session: Session) => void;
	/** Multi-window: resolves an agent's owning window so cross-window picks focus
	 * that window instead of stealing the agent. Omitted = single-window behavior. */
	getSessionWindow?: GetSessionWindow;
}

interface BuildSessionManagementCommandsArgs {
	activeSession: Session | undefined;
	activeSessionId: string;
	sessions: Session[];
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	setQuickActionOpen: (open: boolean) => void;
	setRenameInstanceModalOpen: (open: boolean) => void;
	setRenameInstanceValue: (value: string) => void;
	onEditAgent?: (session: Session) => void;
	agentSettingsShortcut?: QuickAction['shortcut'];
	toggleBookmarkShortcut?: QuickAction['shortcut'];
	deleteSession: (id: string) => void;
	killShortcut?: QuickAction['shortcut'];
	openClearBookmarksConfirm: (bookmarkedCount: number) => void;
}

export function buildSessionJumpCommands({
	sessions,
	setActiveSessionId,
	revealJumpTarget,
	getSessionWindow,
}: BuildSessionCommandsArgs): QuickAction[] {
	return sessions.map((session) => {
		let label: string;
		if (session.parentSessionId) {
			const parentSession = sessions.find((p) => p.id === session.parentSessionId);
			const parentName = parentSession?.name || 'Unknown';
			label = `Jump to ${parentName} subagent: ${session.name}`;
		} else {
			label = `Jump to: ${session.name}`;
		}

		return {
			id: `jump-${session.id}`,
			label,
			action: makeAgentJumpAction({
				session,
				setActiveSessionId,
				revealJumpTarget,
				getSessionWindow,
			}),
			subtext: session.state.toUpperCase(),
			bookmarked: !!session.bookmarked,
			agentSortKey: alphabetizeKey(session.name),
		};
	});
}

export function buildSessionManagementCommands({
	activeSession,
	activeSessionId,
	sessions,
	setSessions,
	setQuickActionOpen,
	setRenameInstanceModalOpen,
	setRenameInstanceValue,
	onEditAgent,
	agentSettingsShortcut,
	toggleBookmarkShortcut,
	deleteSession,
	killShortcut,
	openClearBookmarksConfirm,
}: BuildSessionManagementCommandsArgs): QuickAction[] {
	const commands: QuickAction[] = [];

	if (activeSession) {
		commands.push({
			id: 'rename',
			label: `Rename Agent: ${activeSession.name}`,
			action: () => {
				setRenameInstanceValue(activeSession.name);
				setRenameInstanceModalOpen(true);
				setQuickActionOpen(false);
			},
		});
	}

	if (activeSession && onEditAgent) {
		commands.push({
			id: 'editAgent',
			label: `Edit Agent: ${activeSession.name}`,
			shortcut: agentSettingsShortcut,
			action: () => {
				onEditAgent(activeSession);
				setQuickActionOpen(false);
			},
		});
	}

	if (activeSession) {
		commands.push({
			id: 'toggleBookmark',
			label: activeSession.bookmarked
				? `Unbookmark: ${activeSession.name}`
				: `Bookmark: ${activeSession.name}`,
			shortcut: toggleBookmarkShortcut,
			action: () => {
				setSessions((prev) =>
					prev.map((session) =>
						session.id === activeSessionId
							? { ...session, bookmarked: !session.bookmarked }
							: session
					)
				);
				setQuickActionOpen(false);
			},
		});
	}

	if (sessions.some((session) => session.bookmarked)) {
		commands.push({
			id: 'clearAllBookmarks',
			label: 'Clear All Bookmarks',
			action: () => {
				const bookmarkedCount = sessions.filter((session) => session.bookmarked).length;
				setQuickActionOpen(false);
				openClearBookmarksConfirm(bookmarkedCount);
			},
		});
	}

	if (activeSession) {
		commands.push({
			id: 'kill',
			label: `Remove Agent: ${activeSession.name}`,
			shortcut: killShortcut,
			action: () => deleteSession(activeSessionId),
		});
	}

	return commands;
}
