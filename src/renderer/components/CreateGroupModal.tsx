import React, { useState, useRef } from 'react';
import type { Theme, Group } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter, EmojiPickerField, FormInput } from './ui';
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

	const inputRef = useRef<HTMLInputElement>(null);

	const handleCreate = () => {
		if (groupName.trim()) {
			const newGroupId = `group-${generateId()}`;
			const newGroup: Group = {
				id: newGroupId,
				name: groupName.trim().toUpperCase(),
				emoji: groupEmoji,
				collapsed: false,
			};
			setGroups([...groups, newGroup]);

			// Call callback with new group ID if provided
			if (onGroupCreated) {
				onGroupCreated(newGroupId);
			}

			setGroupName('');
			setGroupEmoji('📂');
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
			<div className="flex gap-4 items-end">
				{/* Emoji Selector - Left Side */}
				<EmojiPickerField
					theme={theme}
					value={groupEmoji}
					onChange={setGroupEmoji}
					restoreFocusRef={inputRef}
				/>

				{/* Group Name Input - Right Side */}
				<div className="flex-1">
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
			</div>
		</Modal>
	);
}
