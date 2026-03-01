import React, { memo, useRef, useState } from 'react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter } from './ui/Modal';
import { FormInput } from './ui/FormInput';

interface TerminalTabRenameModalProps {
	theme: Theme;
	isOpen: boolean;
	/** Current custom name, or null if using the auto-generated default. */
	currentName: string | null;
	/** Auto-generated name shown as placeholder and in helper text (e.g. "Terminal 1"). */
	defaultName: string;
	onSave: (name: string) => void;
	onClose: () => void;
}

export const TerminalTabRenameModal = memo(function TerminalTabRenameModal(
	props: TerminalTabRenameModalProps
) {
	const { theme, isOpen, currentName, defaultName, onSave, onClose } = props;
	const inputRef = useRef<HTMLInputElement>(null);
	const [value, setValue] = useState(currentName ?? '');

	if (!isOpen) return null;

	const handleSave = () => {
		onSave(value.trim());
		onClose();
	};

	return (
		<Modal
			theme={theme}
			title="Rename Terminal Tab"
			priority={MODAL_PRIORITIES.RENAME_TAB}
			onClose={onClose}
			width={400}
			initialFocusRef={inputRef as React.RefObject<HTMLElement>}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleSave}
					confirmLabel="Rename"
				/>
			}
		>
			<FormInput
				ref={inputRef}
				theme={theme}
				value={value}
				onChange={setValue}
				onSubmit={handleSave}
				placeholder={defaultName}
			/>
			<p
				className="mt-2 text-xs"
				style={{ color: theme.colors.textDim }}
			>
				Leave empty to use the default name ({defaultName}).
			</p>
		</Modal>
	);
});
