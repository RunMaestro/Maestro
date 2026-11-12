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
	createGroupParentId?: string;
	onCloseCreateGroupModal: () => void;
	onGroupCreated?: (groupId: string) => void;

	// RenameGroupModal
	renameGroupModalOpen: boolean;
	renameGroupId: string | null;
	renameGroupValue: string;
	setRenameGroupValue: (value: string) => void;
	renameGroupEmoji: string;
	setRenameGroupEmoji: (emoji: string) => void;
	renameGroupIcon?: string;
	setRenameGroupIcon: (icon: string | undefined) => void;
	renameGroupColor?: string;
	setRenameGroupColor: (color: string | undefined) => void;
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
	createGroupParentId,
	onCloseCreateGroupModal,
	onGroupCreated,
	// RenameGroupModal
	renameGroupModalOpen,
	renameGroupId,
	renameGroupValue,
	setRenameGroupValue,
	renameGroupEmoji,
	setRenameGroupEmoji,
	renameGroupIcon,
	setRenameGroupIcon,
	renameGroupColor,
	setRenameGroupColor,
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
					initialParentGroupId={createGroupParentId}
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
					groupIcon={renameGroupIcon}
					setGroupIcon={setRenameGroupIcon}
					groupColor={renameGroupColor}
					setGroupColor={setRenameGroupColor}
					onClose={onCloseRenameGroupModal}
					groups={groups}
					setGroups={setGroups}
				/>
			)}
		</>
	);
});
