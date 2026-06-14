import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeleteFileModal } from '../../../../../renderer/components/FileExplorerPanel/components/DeleteFileModal';
import { mockTheme } from '../../../../helpers/mockTheme';
import type { FileNode } from '../../../../../renderer/types/fileTree';

vi.mock('../../../../../renderer/components/ui/Modal', () => ({
	Modal: ({ title, children, footer }: any) => (
		<div>
			<div data-testid="modal-title">{title}</div>
			{children}
			{footer}
		</div>
	),
	ModalFooter: ({ onCancel, onConfirm, confirmLabel, confirmDisabled }: any) => (
		<div>
			<button onClick={onCancel}>Cancel</button>
			<button onClick={onConfirm} disabled={confirmDisabled} data-testid="confirm-btn">
				{confirmLabel}
			</button>
		</div>
	),
}));

vi.mock('../../../../../renderer/constants/modalPriorities', () => ({
	MODAL_PRIORITIES: { CONFIRM: 200 },
}));

const fileNode: FileNode = { name: 'index.ts', type: 'file' };
const folderNode: FileNode = { name: 'src', type: 'folder' };

const defaultProps = {
	theme: mockTheme,
	node: fileNode,
	isDeleting: false,
	onClose: vi.fn(),
	onDelete: vi.fn(),
};

describe('DeleteFileModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('shows "Delete File" title for a file node', () => {
		render(<DeleteFileModal {...defaultProps} node={fileNode} />);
		expect(screen.getByTestId('modal-title').textContent).toBe('Delete File');
	});

	it('shows "Delete Folder" title for a folder node', () => {
		render(<DeleteFileModal {...defaultProps} node={folderNode} />);
		expect(screen.getByTestId('modal-title').textContent).toBe('Delete Folder');
	});

	it('shows the node name in the confirmation message', () => {
		render(<DeleteFileModal {...defaultProps} node={fileNode} />);
		expect(screen.getByText(/index\.ts/)).toBeTruthy();
	});

	it('shows item count for folder with contents', () => {
		render(
			<DeleteFileModal
				{...defaultProps}
				node={folderNode}
				itemCount={{ fileCount: 5, folderCount: 2 }}
			/>
		);
		expect(screen.getByText(/5 files/)).toBeTruthy();
		expect(screen.getByText(/2 subfolders/)).toBeTruthy();
	});

	it('shows singular item count correctly', () => {
		render(
			<DeleteFileModal
				{...defaultProps}
				node={folderNode}
				itemCount={{ fileCount: 1, folderCount: 0 }}
			/>
		);
		expect(screen.getByText(/1 file/)).toBeTruthy();
		expect(screen.queryByText(/subfolder/)).toBeNull();
	});

	it('calls onDelete when confirm is clicked', () => {
		const onDelete = vi.fn();
		render(<DeleteFileModal {...defaultProps} onDelete={onDelete} />);
		fireEvent.click(screen.getByTestId('confirm-btn'));
		expect(onDelete).toHaveBeenCalledTimes(1);
	});

	it('calls onClose when Cancel is clicked', () => {
		const onClose = vi.fn();
		render(<DeleteFileModal {...defaultProps} onClose={onClose} />);
		fireEvent.click(screen.getByText('Cancel'));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('shows "Deleting..." and disables confirm while deleting', () => {
		render(<DeleteFileModal {...defaultProps} isDeleting={true} />);
		expect(screen.getByText('Deleting...')).toBeTruthy();
		expect((screen.getByTestId('confirm-btn') as HTMLButtonElement).disabled).toBe(true);
	});

	it('does not call onClose from Cancel while deleting', () => {
		const onClose = vi.fn();
		render(<DeleteFileModal {...defaultProps} isDeleting={true} onClose={onClose} />);
		fireEvent.click(screen.getByText('Cancel'));
		expect(onClose).not.toHaveBeenCalled();
	});
});
