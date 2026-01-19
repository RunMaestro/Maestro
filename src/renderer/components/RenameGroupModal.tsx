import React, { useRef } from 'react';
import type { Theme, Group } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter, EmojiPickerField, FormInput } from './ui';

interface RenameGroupModalProps {
	theme: Theme;
	groupId: string;
	groupName: string;
	setGroupName: (name: string) => void;
	groupEmoji: string;
	setGroupEmoji: (emoji: string) => void;
	onClose: () => void;
	groups: Group[];
	setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
}

export function RenameGroupModal(props: RenameGroupModalProps) {
	const {
		theme,
		groupId,
		groupName,
		setGroupName,
		groupEmoji,
		setGroupEmoji,
		onClose,
		groups: _groups,
		setGroups,
	} = props;

	const inputRef = useRef<HTMLInputElement>(null);

	const handleRename = () => {
		if (groupName.trim() && groupId) {
			setGroups((prev) =>
				prev.map((g) =>
					g.id === groupId ? { ...g, name: groupName.trim().toUpperCase(), emoji: groupEmoji } : g
				)
			);
			onClose();
		}
	};

	return (
		<Modal
			theme={theme}
			title="Rename Group"
			priority={MODAL_PRIORITIES.RENAME_GROUP}
			onClose={onClose}
			initialFocusRef={inputRef}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleRename}
					confirmLabel="Rename"
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
						onSubmit={handleRename}
						placeholder="Enter group name..."
						heightClass="h-[52px]"
						autoFocus
					/>
				</div>
			</div>
		</Modal>
	);
}
