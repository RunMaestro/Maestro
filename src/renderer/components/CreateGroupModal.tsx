import React, { useState, useRef } from 'react';
import type { Theme, Group } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter, FormInput, GroupAppearancePicker } from './ui';
import { generateId } from '../utils/ids';

interface CreateGroupModalProps {
	theme: Theme;
	onClose: () => void;
	groups: Group[];
	setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
	onGroupCreated?: (groupId: string) => void; // Optional callback when group is created
}

export function CreateGroupModal(props: CreateGroupModalProps) {
	const { theme, onClose, groups, setGroups, onGroupCreated } = props;

	const [groupName, setGroupName] = useState('');
	const [groupEmoji, setGroupEmoji] = useState('📂');
	const [groupIcon, setGroupIcon] = useState<string | undefined>(undefined);
	const [groupColor, setGroupColor] = useState<string | undefined>(undefined);

	const inputRef = useRef<HTMLInputElement>(null);

	const handleCreate = () => {
		if (groupName.trim()) {
			const newGroupId = `group-${generateId()}`;
			const newGroup: Group = {
				id: newGroupId,
				name: groupName.trim().toUpperCase(),
				emoji: groupEmoji,
				kind: 'user',
				icon: groupIcon,
				color: groupColor,
				collapsed: false,
			};
			setGroups([...groups, newGroup]);

			// Call callback with new group ID if provided
			if (onGroupCreated) {
				onGroupCreated(newGroupId);
			}

			setGroupName('');
			setGroupEmoji('📂');
			setGroupIcon(undefined);
			setGroupColor(undefined);
			onClose();
		}
	};

	return (
		<Modal
			theme={theme}
			title="Create New Group"
			priority={MODAL_PRIORITIES.CREATE_GROUP}
			onClose={onClose}
			initialFocusRef={inputRef}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleCreate}
					confirmLabel="Create"
					confirmDisabled={!groupName.trim()}
				/>
			}
		>
			<div className="space-y-4">
				<GroupAppearancePicker
					theme={theme}
					emoji={groupEmoji}
					icon={groupIcon}
					color={groupColor}
					onEmojiChange={setGroupEmoji}
					onIconChange={setGroupIcon}
					onColorChange={setGroupColor}
					restoreFocusRef={inputRef}
				/>
				<FormInput
					ref={inputRef}
					theme={theme}
					label="Group Name"
					value={groupName}
					onChange={setGroupName}
					onSubmit={groupName.trim() ? handleCreate : undefined}
					placeholder="Enter group name..."
					heightClass="h-[52px]"
					autoFocus
				/>
			</div>
		</Modal>
	);
}
