/**
 * DeleteGroupChatModal.tsx
 *
 * Confirmation modal for deleting a Group Chat.
 * Warns the user that deletion is permanent.
 */

import { useRef, useCallback } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter } from './ui/Modal';

interface DeleteGroupChatModalProps {
	theme: Theme;
	isOpen: boolean;
	groupChatName: string;
	onClose: () => void;
	onConfirm: () => void;
}

export function DeleteGroupChatModal({
	theme,
	isOpen,
	groupChatName,
	onClose,
	onConfirm,
}: DeleteGroupChatModalProps): JSX.Element | null {
	const confirmButtonRef = useRef<HTMLButtonElement>(null);

	const handleConfirm = useCallback(() => {
		onConfirm();
		onClose();
	}, [onConfirm, onClose]);

	if (!isOpen) return null;

	return (
		<Modal
			theme={theme}
			title="Delete Group Chat"
			priority={MODAL_PRIORITIES.DELETE_GROUP_CHAT}
			onClose={onClose}
			headerIcon={<Trash2 className="w-4 h-4" style={{ color: theme.colors.error }} />}
			width={450}
			initialFocusRef={confirmButtonRef}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleConfirm}
					confirmLabel="Delete"
					destructive
					confirmButtonRef={confirmButtonRef}
				/>
			}
		>
			<div className="flex gap-4">
				<div
					className="flex-shrink-0 p-2 rounded-full h-fit"
					style={{ backgroundColor: `${theme.colors.error}20` }}
				>
					<AlertTriangle className="w-5 h-5" style={{ color: theme.colors.error }} />
				</div>
				<div>
					<p className="leading-relaxed" style={{ color: theme.colors.textMain }}>
						Are you sure you want to delete <strong>"{groupChatName}"</strong>?
					</p>
					<p className="text-sm leading-relaxed mt-2" style={{ color: theme.colors.textDim }}>
						This will permanently delete the group chat and all its messages. Participant sessions
						will not be affected.
					</p>
				</div>
			</div>
		</Modal>
	);
}
