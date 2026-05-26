import React from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { Modal, ModalFooter } from '../../ui/Modal';
import { MODAL_PRIORITIES } from '../../../constants/modalPriorities';
import type { Theme } from '../../../types';
import type { MultiDeleteModalState } from '../types';

interface MultiDeleteModalProps {
	theme: Theme;
	modal: MultiDeleteModalState;
	isDeleting: boolean;
	onClose: () => void;
	onDelete: () => void;
}

export function MultiDeleteModal({
	theme,
	modal,
	isDeleting,
	onClose,
	onDelete,
}: MultiDeleteModalProps) {
	const guardedClose = isDeleting ? () => {} : onClose;

	return (
		<Modal
			theme={theme}
			title={`Delete ${modal.nodes.length} items`}
			priority={MODAL_PRIORITIES.CONFIRM}
			onClose={guardedClose}
			headerIcon={<Trash2 className="w-4 h-4" style={{ color: theme.colors.error }} />}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={guardedClose}
					onConfirm={onDelete}
					confirmLabel={isDeleting ? 'Deleting...' : 'Delete'}
					confirmDisabled={isDeleting}
					destructive
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
				<div className="min-w-0 flex-1">
					<p style={{ color: theme.colors.textMain }}>
						Delete the following {modal.nodes.length} items? This action cannot be undone.
					</p>
					<div
						className="text-xs rounded border px-2 py-1.5 mt-3 max-h-40 overflow-auto font-mono"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textDim,
							backgroundColor: theme.colors.bgActivity,
						}}
					>
						{modal.nodes.map((n) => (
							<div key={n.path} className="truncate" title={n.path}>
								{n.path}
							</div>
						))}
					</div>
				</div>
			</div>
		</Modal>
	);
}
