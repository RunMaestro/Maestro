import React, { useRef, useState } from 'react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter } from './ui/Modal';
import { FormInput } from './ui/FormInput';

interface RenameTabModalProps {
	theme: Theme;
	initialName: string;
	agentSessionId?: string | null;
	onClose: () => void;
	onRename: (newName: string) => void;
}

export function RenameTabModal(props: RenameTabModalProps) {
	const { theme, initialName, agentSessionId, onClose, onRename } = props;
	const inputRef = useRef<HTMLInputElement>(null);
	const [value, setValue] = useState(initialName);

	// Generate placeholder with UUID octet if available
	const placeholder = agentSessionId
		? `Rename ${agentSessionId.split('-')[0].toUpperCase()}...`
		: 'Enter tab name...';

	const handleRename = () => {
		onRename(value.trim());
		onClose();
	};

	return (
		<Modal
			theme={theme}
			title="Rename Tab"
			priority={MODAL_PRIORITIES.RENAME_TAB}
			onClose={onClose}
			width={400}
			initialFocusRef={inputRef as React.RefObject<HTMLElement>}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleRename}
					confirmLabel="Rename"
				/>
			}
		>
			<FormInput
				ref={inputRef}
				theme={theme}
				value={value}
				onChange={setValue}
				onSubmit={handleRename}
				placeholder={placeholder}
			/>
		</Modal>
	);
}
