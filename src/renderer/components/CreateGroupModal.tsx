import React, { useState, useRef } from 'react';
import type { Theme, Group } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter, FormInput, GroupAppearancePicker } from './ui';
import { generateId } from '../utils/ids';
import { canCreateGroupInside } from '../../shared/groupHierarchy';
import { usePluginContributions } from '../hooks/usePluginContributions';
import { selectGroupsPlusEnabled, useSettingsStore } from '../stores/settingsStore';

interface CreateGroupModalProps {
	theme: Theme;
	onClose: () => void;
	groups: Group[];
	setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
	/** Root group preselected by an "inside folder" action. */
	initialParentGroupId?: string;
	onGroupCreated?: (groupId: string) => void; // Optional callback when group is created
}

export function CreateGroupModal(props: CreateGroupModalProps) {
	const { theme, onClose, groups, setGroups, initialParentGroupId, onGroupCreated } = props;
	const groupsPlusEnabled = useSettingsStore(selectGroupsPlusEnabled);
	const rootGroups = groups.filter((group) => !group.parentGroupId);
	const initialParentId =
		groupsPlusEnabled && rootGroups.some((group) => group.id === initialParentGroupId)
			? initialParentGroupId
			: '';
	const [groupName, setGroupName] = useState('');
	const [groupEmoji, setGroupEmoji] = useState('📂');
	const [groupIcon, setGroupIcon] = useState<string | undefined>(undefined);
	const [groupColor, setGroupColor] = useState<string | undefined>(undefined);
	const [parentGroupId, setParentGroupId] = useState(initialParentId);
	const inputRef = useRef<HTMLInputElement>(null);
	const pluginContributions = usePluginContributions();

	const handleCreate = () => {
		if (groupName.trim()) {
			const resolvedParentGroupId =
				groupsPlusEnabled && canCreateGroupInside(groups, parentGroupId)
					? parentGroupId
					: undefined;
			const newGroupId = `group-${generateId()}`;
			const newGroup: Group = {
				id: newGroupId,
				name: groupName.trim().toUpperCase(),
				emoji: groupEmoji,
				kind: 'user',
				icon: groupIcon,
				color: groupColor,
				...(resolvedParentGroupId ? { parentGroupId: resolvedParentGroupId } : {}),
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
			setParentGroupId('');
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
					onSubmit={groupName.trim() ? handleCreate : undefined}
					placeholder="Enter group name..."
					heightClass="h-[52px]"
					autoFocus
				/>
				{groupsPlusEnabled && (
					<div>
						<label
							htmlFor="create-group-parent"
							className="block text-xs font-medium uppercase tracking-wide mb-1"
							style={{ color: theme.colors.textDim }}
						>
							Inside folder
						</label>
						<select
							id="create-group-parent"
							value={parentGroupId}
							onChange={(event) => setParentGroupId(event.target.value)}
							className="w-full px-3 py-2 rounded border bg-transparent outline-none text-sm cursor-pointer"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						>
							<option value="">Top level</option>
							{rootGroups.map((group) => (
								<option key={group.id} value={group.id}>
									{group.name}
								</option>
							))}
						</select>
					</div>
				)}
			</div>
		</Modal>
	);
}
