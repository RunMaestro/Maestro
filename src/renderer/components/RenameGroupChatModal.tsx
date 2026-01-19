/**
 * RenameGroupChatModal.tsx
 *
 * Modal for renaming an existing Group Chat.
 */

import { useState, useRef, useEffect } from 'react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter, FormInput } from './ui';

interface RenameGroupChatModalProps {
	theme: Theme;
	isOpen: boolean;
	currentName: string;
	onClose: () => void;
	onRename: (newName: string) => void;
}

export function RenameGroupChatModal({
	theme,
	isOpen,
	currentName,
	onClose,
	onRename,
}: RenameGroupChatModalProps): JSX.Element | null {
	const [name, setName] = useState(currentName);
	const inputRef = useRef<HTMLInputElement>(null);

	// Reset name when modal opens with new currentName
	useEffect(() => {
		if (isOpen) {
			setName(currentName);
		}
	}, [isOpen, currentName]);

	const handleRename = () => {
		if (name.trim() && name.trim() !== currentName) {
			onRename(name.trim());
			onClose();
		}
	};

	const canRename = name.trim().length > 0 && name.trim() !== currentName;

	if (!isOpen) return null;

	return (
		<Modal
			theme={theme}
			title="Rename Group Chat"
			priority={MODAL_PRIORITIES.RENAME_GROUP_CHAT}
			onClose={onClose}
			initialFocusRef={inputRef}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleRename}
					confirmLabel="Rename"
					confirmDisabled={!canRename}
				/>
			}
		>
			<FormInput
				ref={inputRef}
				theme={theme}
				label="Chat Name"
				value={name}
				onChange={setName}
				onSubmit={canRename ? handleRename : undefined}
				placeholder="Enter new name..."
				autoFocus
			/>
		</Modal>
	);
}
