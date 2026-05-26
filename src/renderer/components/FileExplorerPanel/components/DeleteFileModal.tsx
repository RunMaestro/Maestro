import React, { useRef } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { Modal, ModalFooter } from '../../ui/Modal';
import { MODAL_PRIORITIES } from '../../../constants/modalPriorities';
import type { Theme } from '../../../types';
import type { FileNode } from '../../../types/fileTree';

interface DeleteFileModalProps {
	theme: Theme;
	node: FileNode;
	itemCount?: { fileCount: number; folderCount: number };
	isDeleting: boolean;
	onClose: () => void;
	onDelete: () => void;
}

export function DeleteFileModal({
	theme,
	node,
	itemCount,
	isDeleting,
	onClose,
	onDelete,
}: DeleteFileModalProps) {
	const cancelButtonRef = useRef<HTMLButtonElement>(null);
	const isFolder = node.type === 'folder';

	return (
		<Modal
			theme={theme}
			title={isFolder ? 'Delete Folder' : 'Delete File'}
			priority={MODAL_PRIORITIES.CONFIRM}
			onClose={isDeleting ? () => {} : onClose}
			headerIcon={<Trash2 className="w-4 h-4" style={{ color: theme.colors.error }} />}
			initialFocusRef={cancelButtonRef}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={isDeleting ? () => {} : onClose}
					onConfirm={onDelete}
					confirmLabel={isDeleting ? 'Deleting...' : 'Delete'}
					confirmDisabled={isDeleting}
					destructive
					cancelButtonRef={cancelButtonRef}
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
					<p style={{ color: theme.colors.textMain }}>
						Are you sure you want to delete the {isFolder ? 'folder' : 'file'} "{node.name}"? This
						action cannot be undone.
					</p>
					{isFolder && itemCount && (
						<p className="text-sm mt-3" style={{ color: theme.colors.warning }}>
							This folder contains {itemCount.fileCount} file{itemCount.fileCount !== 1 ? 's' : ''}
							{itemCount.folderCount > 0 && (
								<>
									{' '}
									and {itemCount.folderCount} subfolder{itemCount.folderCount !== 1 ? 's' : ''}
								</>
							)}
							.
						</p>
					)}
				</div>
			</div>
		</Modal>
	);
}
