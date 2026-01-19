import React, { useRef, useCallback } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter } from './ui/Modal';

interface ConfirmModalProps {
	theme: Theme;
	message: string;
	onConfirm: (() => void) | null;
	onClose: () => void;
}

export function ConfirmModal({ theme, message, onConfirm, onClose }: ConfirmModalProps) {
	const confirmButtonRef = useRef<HTMLButtonElement>(null);

	const handleConfirm = useCallback(() => {
		if (onConfirm) {
			onConfirm();
		}
		onClose();
	}, [onConfirm, onClose]);

	return (
		<Modal
			theme={theme}
			title="Confirm Delete"
			priority={MODAL_PRIORITIES.CONFIRM}
			onClose={onClose}
			headerIcon={<Trash2 className="w-4 h-4" style={{ color: theme.colors.error }} />}
			width={450}
			zIndex={10000}
			initialFocusRef={confirmButtonRef}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleConfirm}
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
				<p className="leading-relaxed" style={{ color: theme.colors.textMain }}>
					{message}
				</p>
			</div>
		</Modal>
	);
}
