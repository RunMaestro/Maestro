import { useRef } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter } from './ui/Modal';

interface PlaybookDeleteConfirmModalProps {
	theme: Theme;
	playbookName: string;
	onConfirm: () => void;
	onCancel: () => void;
}

export function PlaybookDeleteConfirmModal({
	theme,
	playbookName,
	onConfirm,
	onCancel,
}: PlaybookDeleteConfirmModalProps) {
	const confirmButtonRef = useRef<HTMLButtonElement>(null);

	const handleConfirmClick = () => {
		onConfirm();
		onCancel(); // Close the modal after confirming
	};

	return (
		<Modal
			theme={theme}
			title="Delete Playbook"
			priority={MODAL_PRIORITIES.PLAYBOOK_DELETE_CONFIRM}
			onClose={onCancel}
			headerIcon={<Trash2 className="w-4 h-4" style={{ color: theme.colors.error }} />}
			zIndex={10000}
			initialFocusRef={confirmButtonRef}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onCancel}
					onConfirm={handleConfirmClick}
					confirmLabel="Delete"
					destructive
					confirmButtonRef={confirmButtonRef}
				/>
			}
			layerOptions={{
				blocksLowerLayers: true,
				capturesFocus: true,
				focusTrap: 'strict',
			}}
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
						Are you sure you want to delete "<strong>{playbookName}</strong>"?
					</p>
					<p className="text-sm mt-2" style={{ color: theme.colors.textDim }}>
						This cannot be undone.
					</p>
				</div>
			</div>
		</Modal>
	);
}
