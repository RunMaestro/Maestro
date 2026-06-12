import React, { memo } from 'react';
import type { Theme, Group } from '../../types';

// Group Modal Components
import { CreateGroupModal } from '../CreateGroupModal';
import { RenameGroupModal } from '../RenameGroupModal';

/**
 * Props for the AppGroupModals component
 */
export interface AppGroupModalsProps {
	theme: Theme;
	groups: Group[];
	setGroups: React.Dispatch<React.SetStateAction<Group[]>>;

	// CreateGroupModal
	createGroupModalOpen: boolean;
	onCloseCreateGroupModal: () => void;
	onGroupCreated?: (groupId: string) => void;

	// RenameGroupModal
	renameGroupModalOpen: boolean;
	renameGroupId: string | null;
	renameGroupValue: string;
	setRenameGroupValue: (value: string) => void;
	renameGroupEmoji: string;
	setRenameGroupEmoji: (emoji: string) => void;
	onCloseRenameGroupModal: () => void;
}

/**
 * AppGroupModals - Renders group management modals
 *
 * Contains:
 * - CreateGroupModal: Create a new session group
 * - RenameGroupModal: Rename an existing group
 */
export const AppGroupModals = memo(function AppGroupModals({
	theme,
	groups,
	setGroups,
	// CreateGroupModal
	createGroupModalOpen,
	onCloseCreateGroupModal,
	onGroupCreated,
	// RenameGroupModal
	renameGroupModalOpen,
	renameGroupId,
	renameGroupValue,
	setRenameGroupValue,
	renameGroupEmoji,
	setRenameGroupEmoji,
	onCloseRenameGroupModal,
}: AppGroupModalsProps) {
	return (
		<>
			{/* --- CREATE GROUP MODAL --- */}
			{createGroupModalOpen && (
				<CreateGroupModal
					theme={theme}
					onClose={onCloseCreateGroupModal}
					groups={groups}
					setGroups={setGroups}
					onGroupCreated={onGroupCreated}
				/>
			)}

			{/* --- RENAME GROUP MODAL --- */}
			{renameGroupModalOpen && renameGroupId && (
				<RenameGroupModal
					theme={theme}
					groupId={renameGroupId}
					groupName={renameGroupValue}
					setGroupName={setRenameGroupValue}
					groupEmoji={renameGroupEmoji}
					setGroupEmoji={setRenameGroupEmoji}
					onClose={onCloseRenameGroupModal}
					groups={groups}
					setGroups={setGroups}
				/>
			)}
		</>
	);
});
