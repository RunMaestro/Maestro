import React, { memo, useEffect } from 'react';
import type { Theme, Group } from '../../types';
import {
	getModalActions,
	selectModalData,
	selectModalOpen,
	useModalStore,
} from '../../stores/modalStore';

// Group Modal Components
import { CreateGroupModal } from '../CreateGroupModal';
import { RenameGroupModal } from '../RenameGroupModal';
import { GroupSettingsModal } from '../GroupSettingsModal';

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
 * - GroupSettingsModal: Edit the defaults a new agent in a group starts with
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
	// Group Settings reads its own open state: one group id is all it carries,
	// so nothing is threaded through App.tsx for it.
	const groupSettingsOpen = useModalStore(selectModalOpen('groupSettings'));
	const groupSettingsData = useModalStore(selectModalData('groupSettings'));
	const groupSettingsGroup = groupSettingsOpen
		? groups.find((g) => g.id === groupSettingsData?.groupId)
		: undefined;
	const closeGroupSettings = () => getModalActions().closeGroupSettings();

	// A group deleted while its settings are open leaves nothing to draw. Close
	// the entry too, so the store does not report a modal that is not on screen.
	const groupSettingsOrphaned = groupSettingsOpen && !groupSettingsGroup;
	useEffect(() => {
		if (groupSettingsOrphaned) getModalActions().closeGroupSettings();
	}, [groupSettingsOrphaned]);

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

			{/* --- GROUP SETTINGS MODAL --- */}
			{groupSettingsGroup && (
				<GroupSettingsModal
					theme={theme}
					group={groupSettingsGroup}
					setGroups={setGroups}
					onClose={closeGroupSettings}
				/>
			)}
		</>
	);
});
