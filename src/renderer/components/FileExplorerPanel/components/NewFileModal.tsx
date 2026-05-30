import React, { useRef } from 'react';
import { Modal, ModalFooter } from '../../ui/Modal';
import { FormInput } from '../../ui/FormInput';
import { MODAL_PRIORITIES } from '../../../constants/modalPriorities';
import type { Theme } from '../../../types';

interface NewFileModalProps {
	theme: Theme;
	kind: 'file' | 'folder';
	parentFolderLabel: string;
	value: string;
	setValue: (value: string) => void;
	error: string | null;
	isCreating: boolean;
	onClose: () => void;
	onCreate: () => void;
}

export function NewFileModal({
	theme,
	kind,
	parentFolderLabel,
	value,
	setValue,
	error,
	isCreating,
	onClose,
	onCreate,
}: NewFileModalProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const noun = kind === 'folder' ? 'folder' : 'file';

	return (
		<Modal
			theme={theme}
			title={`New ${noun} in ${parentFolderLabel}`}
			priority={MODAL_PRIORITIES.RENAME_INSTANCE}
			onClose={isCreating ? () => {} : onClose}
			initialFocusRef={inputRef}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={isCreating ? () => {} : onClose}
					onConfirm={onCreate}
					confirmLabel={isCreating ? 'Creating...' : 'Create'}
					confirmDisabled={isCreating || !value.trim()}
				/>
			}
		>
			<FormInput
				ref={inputRef}
				theme={theme}
				value={value}
				onChange={setValue}
				onSubmit={onCreate}
				placeholder={`Enter ${noun} name...`}
				error={error || undefined}
				submitEnabled={Boolean(value.trim()) && !isCreating}
			/>
		</Modal>
	);
}
