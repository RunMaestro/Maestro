import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RenameFileModal } from '../../../../../renderer/components/FileExplorerPanel/components/RenameFileModal';
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

vi.mock('../../../../../renderer/components/ui/FormInput', () => ({
	FormInput: ({ value, onChange, onSubmit, placeholder, error }: any) => (
		<div>
			<input
				placeholder={placeholder}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={(e) => e.key === 'Enter' && onSubmit?.()}
			/>
			{error && <span data-testid="error">{error}</span>}
		</div>
	),
}));

vi.mock('../../../../../renderer/constants/modalPriorities', () => ({
	MODAL_PRIORITIES: { RENAME_INSTANCE: 100 },
}));

const fileNode: FileNode = { name: 'App.tsx', type: 'file' };
const folderNode: FileNode = { name: 'components', type: 'folder' };

const defaultProps = {
	theme: mockTheme,
	node: fileNode,
	value: 'App.tsx',
	setValue: vi.fn(),
	error: null,
	onClose: vi.fn(),
	onRename: vi.fn(),
};

describe('RenameFileModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('shows "Rename File" title for a file node', () => {
		render(<RenameFileModal {...defaultProps} node={fileNode} />);
		expect(screen.getByTestId('modal-title').textContent).toBe('Rename File');
	});

	it('shows "Rename Folder" title for a folder node', () => {
		render(<RenameFileModal {...defaultProps} node={folderNode} value="components" />);
		expect(screen.getByTestId('modal-title').textContent).toBe('Rename Folder');
	});

	it('uses the current name as the initial value', () => {
		render(<RenameFileModal {...defaultProps} value="App.tsx" />);
		expect((screen.getByPlaceholderText('Enter file name...') as HTMLInputElement).value).toBe(
			'App.tsx'
		);
	});

	it('calls onRename when confirm is clicked', () => {
		const onRename = vi.fn();
		render(<RenameFileModal {...defaultProps} value="NewName.tsx" onRename={onRename} />);
		fireEvent.click(screen.getByTestId('confirm-btn'));
		expect(onRename).toHaveBeenCalledTimes(1);
	});

	it('calls onRename when Enter is pressed', () => {
		const onRename = vi.fn();
		render(<RenameFileModal {...defaultProps} value="NewName.tsx" onRename={onRename} />);
		fireEvent.keyDown(screen.getByPlaceholderText('Enter file name...'), { key: 'Enter' });
		expect(onRename).toHaveBeenCalledTimes(1);
	});

	it('calls onClose when Cancel is clicked', () => {
		const onClose = vi.fn();
		render(<RenameFileModal {...defaultProps} onClose={onClose} />);
		fireEvent.click(screen.getByText('Cancel'));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('disables confirm when value matches the original name', () => {
		render(<RenameFileModal {...defaultProps} value="App.tsx" />);
		expect((screen.getByTestId('confirm-btn') as HTMLButtonElement).disabled).toBe(true);
	});

	it('uses the folder placeholder for folder nodes', () => {
		render(<RenameFileModal {...defaultProps} node={folderNode} value="components" />);
		expect(screen.getByPlaceholderText('Enter folder name...')).toBeTruthy();
	});

	it('shows inline error when error prop is set', () => {
		render(<RenameFileModal {...defaultProps} error="Name cannot contain slashes" />);
		expect(screen.getByTestId('error').textContent).toContain('slashes');
	});

	it('calls setValue when user types', () => {
		const setValue = vi.fn();
		render(<RenameFileModal {...defaultProps} setValue={setValue} />);
		fireEvent.change(screen.getByPlaceholderText('Enter file name...'), {
			target: { value: 'Renamed.tsx' },
		});
		expect(setValue).toHaveBeenCalledWith('Renamed.tsx');
	});
});
