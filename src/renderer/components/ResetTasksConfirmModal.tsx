import React, { useRef, useCallback } from 'react';
import { RotateCcw } from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter } from './ui/Modal';

interface ResetTasksConfirmModalProps {
	theme: Theme;
	documentName: string;
	completedTaskCount: number;
	onConfirm: () => void;
	onClose: () => void;
}

export function ResetTasksConfirmModal({
	theme,
	documentName,
	completedTaskCount,
	onConfirm,
	onClose,
}: ResetTasksConfirmModalProps) {
	const confirmButtonRef = useRef<HTMLButtonElement>(null);

	const handleConfirm = useCallback(() => {
		onConfirm();
		onClose();
	}, [onConfirm, onClose]);

	return (
		<Modal
			theme={theme}
			title="Reset Completed Tasks"
			priority={MODAL_PRIORITIES.AUTORUN_RESET_TASKS}
			onClose={onClose}
			width={450}
			initialFocusRef={confirmButtonRef}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleConfirm}
					confirmLabel="Reset Tasks"
					confirmButtonRef={confirmButtonRef}
				/>
			}
		>
			<div className="flex items-start gap-3">
				<div
					className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center"
					style={{ backgroundColor: theme.colors.warning + '20' }}
				>
					<RotateCcw className="w-5 h-5" style={{ color: theme.colors.warning }} />
				</div>
				<div>
					<p className="text-sm leading-relaxed mb-2" style={{ color: theme.colors.textMain }}>
						Are you sure you want to reset all {completedTaskCount} completed task
						{completedTaskCount !== 1 ? 's' : ''} in <strong>{documentName}</strong>?
					</p>
					<p className="text-xs" style={{ color: theme.colors.textDim }}>
						This will uncheck all completed checkboxes, marking them as pending again.
					</p>
				</div>
			</div>
		</Modal>
	);
}
