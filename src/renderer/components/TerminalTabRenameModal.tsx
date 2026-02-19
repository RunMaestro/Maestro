import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter } from './ui/Modal';
import { FormInput } from './ui/FormInput';

interface TerminalTabRenameModalProps {
	theme: Theme;
	isOpen: boolean;
	currentName: string | null;
	defaultName: string;
	onSave: (name: string) => void;
	onClose: () => void;
}

export const TerminalTabRenameModal = memo(function TerminalTabRenameModal({
	theme,
	isOpen,
	currentName,
	defaultName,
	onSave,
	onClose,
}: TerminalTabRenameModalProps) {
	const [name, setName] = useState(currentName ?? '');
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (isOpen) {
			setName(currentName ?? '');
		}
	}, [isOpen, currentName]);

	const handleSave = useCallback(() => {
		onSave(name.trim());
		onClose();
	}, [name, onSave, onClose]);

	if (!isOpen) {
		return null;
	}

	return (
		<Modal
			theme={theme}
			title="Rename Terminal Tab"
			priority={MODAL_PRIORITIES.TERMINAL_TAB_RENAME}
			onClose={onClose}
			width={380}
			closeOnBackdropClick
			initialFocusRef={inputRef as React.RefObject<HTMLElement>}
			footer={
				<ModalFooter theme={theme} onCancel={onClose} onConfirm={handleSave} confirmLabel="Save" />
			}
		>
			<FormInput
				ref={inputRef}
				theme={theme}
				value={name}
				onChange={setName}
				onSubmit={handleSave}
				placeholder={defaultName}
				helperText={`Leave empty to use default name (${defaultName})`}
				selectOnFocus
			/>
		</Modal>
	);
});
