import React, { useRef } from 'react';
import type { Theme, Group } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter, FormInput, GroupAppearancePicker } from './ui';
import { usePluginContributions } from '../hooks/usePluginContributions';
import { selectGroupsPlusEnabled, useSettingsStore } from '../stores/settingsStore';

interface RenameGroupModalProps {
	theme: Theme;
	groupId: string;
	groupName: string;
	setGroupName: (name: string) => void;
	groupEmoji: string;
	setGroupEmoji: (emoji: string) => void;
	groupIcon?: string;
	setGroupIcon: (icon: string | undefined) => void;
	groupColor?: string;
	setGroupColor: (color: string | undefined) => void;
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
		groupIcon,
		setGroupIcon,
		groupColor,
		setGroupColor,
		onClose,
		groups: _groups,
		setGroups,
	} = props;

	const inputRef = useRef<HTMLInputElement>(null);
	const groupsPlusEnabled = useSettingsStore(selectGroupsPlusEnabled);
	const pluginContributions = usePluginContributions();

	const handleRename = () => {
		if (groupName.trim() && groupId) {
			setGroups((prev) =>
				prev.map((g) =>
					g.id === groupId
						? {
								...g,
								name: groupName.trim().toUpperCase(),
								emoji: groupEmoji,
								icon: groupIcon,
								color: groupColor,
							}
						: g
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
			<div className="space-y-4">
				<GroupAppearancePicker
					theme={theme}
					emoji={groupEmoji}
					icon={groupIcon}
					color={groupColor}
					onEmojiChange={setGroupEmoji}
					onIconChange={setGroupIcon}
					onColorChange={setGroupColor}
					iconPacks={pluginContributions.iconPacks}
					restoreFocusRef={inputRef}
					groupsPlusEnabled={groupsPlusEnabled}
				/>
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
		</Modal>
	);
}
