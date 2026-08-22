import type { GroupChat } from '../../../../shared/group-chat-types';
import type { Session } from '../../../types';
import {
	describeGroupChatRunState,
	getGroupChatRunState,
	type GroupChatBusySnapshot,
} from '../../../utils/groupChatStatus';
import type { QuickAction } from '../types';
import { alphabetizeKey } from '../utils/quickActionSorting';

interface BuildGroupChatJumpCommandsArgs {
	groupChats?: GroupChat[];
	onOpenGroupChat?: (id: string) => void;
	setQuickActionOpen: (open: boolean) => void;
}

interface BuildGroupChatSwitcherCommandsArgs {
	groupChats?: GroupChat[];
	busySnapshot: GroupChatBusySnapshot;
	onOpenGroupChat?: (id: string) => void;
}

interface BuildGroupChatCommandsArgs {
	sessions: Session[];
	groupChats?: GroupChat[];
	activeGroupChatId?: string | null;
	onNewGroupChat?: () => void;
	onCloseGroupChat?: () => void;
	onDeleteGroupChat?: (id: string) => void;
	setQuickActionOpen: (open: boolean) => void;
	newGroupChatShortcut?: QuickAction['shortcut'];
	killShortcut?: QuickAction['shortcut'];
}

export function buildGroupChatJumpCommands({
	groupChats,
	onOpenGroupChat,
	setQuickActionOpen,
}: BuildGroupChatJumpCommandsArgs): QuickAction[] {
	if (!groupChats || !onOpenGroupChat) return [];
	return groupChats.map((groupChat) => ({
		id: `groupchat-${groupChat.id}`,
		label: `Group Chat: ${groupChat.name}`,
		action: () => {
			onOpenGroupChat(groupChat.id);
			setQuickActionOpen(false);
		},
		subtext: `${groupChat.participants.length} participant${groupChat.participants.length !== 1 ? 's' : ''}`,
	}));
}

/**
 * Group chat entries for the agent jumper (Cmd+K agents mode).
 *
 * Only RUNNING rooms are listed. The jumper's job is "where is work happening
 * right now", and a busy room is work the same way a busy agent is; an idle
 * room would just pad an already long list, and it is still reachable from the
 * main palette via buildGroupChatJumpCommands.
 */
export function buildGroupChatSwitcherCommands({
	groupChats,
	busySnapshot,
	onOpenGroupChat,
}: BuildGroupChatSwitcherCommandsArgs): QuickAction[] {
	if (!groupChats || !onOpenGroupChat) return [];

	const commands: QuickAction[] = [];
	for (const groupChat of groupChats) {
		const run = getGroupChatRunState(groupChat.id, busySnapshot);
		if (!run.isBusy) continue;
		const label = `Group Chat: ${groupChat.name}`;
		commands.push({
			id: `jump-groupchat-${groupChat.id}`,
			label,
			action: () => onOpenGroupChat(groupChat.id),
			isRunningAgent: true,
			runningInfo: {
				// Group chat runs have no per-room start timestamp, so the subtext
				// carries a status label instead of an elapsed clock.
				state: 'busy',
				statusLabel: describeGroupChatRunState(run),
				queueCount: 0,
			},
			agentSortKey: alphabetizeKey(label),
		});
	}
	return commands;
}

export function buildGroupChatCommands({
	sessions,
	groupChats,
	activeGroupChatId,
	onNewGroupChat,
	onCloseGroupChat,
	onDeleteGroupChat,
	setQuickActionOpen,
	newGroupChatShortcut,
	killShortcut,
}: BuildGroupChatCommandsArgs): QuickAction[] {
	const commands: QuickAction[] = [];

	if (onNewGroupChat && sessions.filter((session) => session.toolType !== 'terminal').length >= 2) {
		commands.push({
			id: 'newGroupChat',
			label: 'New Group Chat',
			shortcut: newGroupChatShortcut,
			action: () => {
				onNewGroupChat();
				setQuickActionOpen(false);
			},
		});
	}

	if (activeGroupChatId && onCloseGroupChat) {
		commands.push({
			id: 'closeGroupChat',
			label: 'Close Group Chat',
			action: () => {
				onCloseGroupChat();
				setQuickActionOpen(false);
			},
		});
	}

	if (activeGroupChatId && onDeleteGroupChat && groupChats) {
		commands.push({
			id: 'deleteGroupChat',
			label: `Remove Group Chat: ${groupChats.find((c) => c.id === activeGroupChatId)?.name || 'Group Chat'}`,
			shortcut: killShortcut,
			action: () => {
				onDeleteGroupChat(activeGroupChatId);
				setQuickActionOpen(false);
			},
		});
	}

	return commands;
}
