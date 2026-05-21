import type { GroupChat } from '../../../../shared/group-chat-types';
import type { Session } from '../../../types';
import type { QuickAction } from '../types';

interface BuildGroupChatJumpCommandsArgs {
	groupChats?: GroupChat[];
	onOpenGroupChat?: (id: string) => void;
	setQuickActionOpen: (open: boolean) => void;
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
