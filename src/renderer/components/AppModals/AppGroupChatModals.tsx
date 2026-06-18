import { memo } from 'react';
import type { Theme, GroupChat, GroupChatMessage, ModeratorConfig } from '../../types';

// Group Chat Modal Components
import { GroupChatModal } from '../GroupChatModal';
import { DeleteGroupChatModal } from '../DeleteGroupChatModal';
import { RenameGroupChatModal } from '../RenameGroupChatModal';
import { GroupChatInfoOverlay } from '../GroupChatInfoOverlay';

/**
 * Props for the AppGroupChatModals component
 */
export interface AppGroupChatModalsProps {
	theme: Theme;
	groupChats: GroupChat[];

	// NewGroupChatModal
	showNewGroupChatModal: boolean;
	onCloseNewGroupChatModal: () => void;
	onCreateGroupChat: (
		name: string,
		moderatorAgentId: string,
		moderatorConfig?: ModeratorConfig
	) => void;

	// DeleteGroupChatModal
	showDeleteGroupChatModal: string | null;
	onCloseDeleteGroupChatModal: () => void;
	onConfirmDeleteGroupChat: () => void;

	// RenameGroupChatModal
	showRenameGroupChatModal: string | null;
	onCloseRenameGroupChatModal: () => void;
	onRenameGroupChat: (newName: string) => void;

	// EditGroupChatModal
	showEditGroupChatModal: string | null;
	onCloseEditGroupChatModal: () => void;
	onUpdateGroupChat: (
		id: string,
		name: string,
		moderatorAgentId: string,
		moderatorConfig?: ModeratorConfig
	) => void;

	// GroupChatInfoOverlay
	showGroupChatInfo: boolean;
	activeGroupChatId: string | null;
	groupChatMessages: GroupChatMessage[];
	onCloseGroupChatInfo: () => void;
	onOpenModeratorSession: (moderatorSessionId: string) => void;
}

/**
 * AppGroupChatModals - Renders Group Chat management modals
 *
 * Contains:
 * - NewGroupChatModal: Create a new group chat
 * - DeleteGroupChatModal: Confirm deletion of a group chat
 * - RenameGroupChatModal: Rename an existing group chat
 * - EditGroupChatModal: Edit group chat settings (name, moderator)
 * - GroupChatInfoOverlay: View group chat info and statistics
 */
export const AppGroupChatModals = memo(function AppGroupChatModals({
	theme,
	groupChats,
	// NewGroupChatModal
	showNewGroupChatModal,
	onCloseNewGroupChatModal,
	onCreateGroupChat,
	// DeleteGroupChatModal
	showDeleteGroupChatModal,
	onCloseDeleteGroupChatModal,
	onConfirmDeleteGroupChat,
	// RenameGroupChatModal
	showRenameGroupChatModal,
	onCloseRenameGroupChatModal,
	onRenameGroupChat,
	// EditGroupChatModal
	showEditGroupChatModal,
	onCloseEditGroupChatModal,
	onUpdateGroupChat,
	// GroupChatInfoOverlay
	showGroupChatInfo,
	activeGroupChatId,
	groupChatMessages,
	onCloseGroupChatInfo,
	onOpenModeratorSession,
}: AppGroupChatModalsProps) {
	// Find group chats by ID for modal props
	const deleteGroupChat = showDeleteGroupChatModal
		? groupChats.find((c) => c.id === showDeleteGroupChatModal)
		: null;

	const renameGroupChat = showRenameGroupChatModal
		? groupChats.find((c) => c.id === showRenameGroupChatModal)
		: null;

	const editGroupChat = showEditGroupChatModal
		? groupChats.find((c) => c.id === showEditGroupChatModal)
		: null;

	const infoGroupChat = activeGroupChatId
		? groupChats.find((c) => c.id === activeGroupChatId)
		: null;

	return (
		<>
			{/* --- NEW GROUP CHAT MODAL --- */}
			{showNewGroupChatModal && (
				<GroupChatModal
					mode="create"
					theme={theme}
					isOpen={showNewGroupChatModal}
					onClose={onCloseNewGroupChatModal}
					onCreate={onCreateGroupChat}
				/>
			)}

			{/* --- DELETE GROUP CHAT MODAL --- */}
			{showDeleteGroupChatModal && deleteGroupChat && (
				<DeleteGroupChatModal
					theme={theme}
					isOpen={!!showDeleteGroupChatModal}
					groupChatName={deleteGroupChat.name}
					onClose={onCloseDeleteGroupChatModal}
					onConfirm={onConfirmDeleteGroupChat}
				/>
			)}

			{/* --- RENAME GROUP CHAT MODAL --- */}
			{showRenameGroupChatModal && renameGroupChat && (
				<RenameGroupChatModal
					theme={theme}
					isOpen={!!showRenameGroupChatModal}
					currentName={renameGroupChat.name}
					onClose={onCloseRenameGroupChatModal}
					onRename={onRenameGroupChat}
				/>
			)}

			{/* --- EDIT GROUP CHAT MODAL --- */}
			{showEditGroupChatModal && (
				<GroupChatModal
					mode="edit"
					theme={theme}
					isOpen={!!showEditGroupChatModal}
					groupChat={editGroupChat || null}
					onClose={onCloseEditGroupChatModal}
					onSave={onUpdateGroupChat}
				/>
			)}

			{/* --- GROUP CHAT INFO OVERLAY --- */}
			{showGroupChatInfo && activeGroupChatId && infoGroupChat && (
				<GroupChatInfoOverlay
					theme={theme}
					isOpen={showGroupChatInfo}
					groupChat={infoGroupChat}
					messages={groupChatMessages}
					onClose={onCloseGroupChatInfo}
					onOpenModeratorSession={onOpenModeratorSession}
				/>
			)}
		</>
	);
});
