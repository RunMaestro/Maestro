import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NewFileModal } from '../../../../../renderer/components/FileExplorerPanel/components/NewFileModal';
import { mockTheme } from '../../../../helpers/mockTheme';

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

const defaultProps = {
	theme: mockTheme,
	kind: 'file' as const,
	parentFolderLabel: '"src/components"',
	value: '',
	setValue: vi.fn(),
	error: null,
	isCreating: false,
	onClose: vi.fn(),
	onCreate: vi.fn(),
};

describe('NewFileModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('displays the parent folder in the title', () => {
		render(<NewFileModal {...defaultProps} />);
		expect(screen.getByTestId('modal-title').textContent).toContain('"src/components"');
	});

	it('shows the Enter file name placeholder', () => {
		render(<NewFileModal {...defaultProps} />);
		expect(screen.getByPlaceholderText('Enter file name...')).toBeTruthy();
	});

	it('uses folder copy when kind is folder', () => {
		render(<NewFileModal {...defaultProps} kind="folder" />);
		expect(screen.getByTestId('modal-title').textContent).toContain('New folder in');
		expect(screen.getByPlaceholderText('Enter folder name...')).toBeTruthy();
	});

	it('calls onCreate when confirm is clicked', () => {
		const onCreate = vi.fn();
		render(<NewFileModal {...defaultProps} value="newfile.ts" onCreate={onCreate} />);
		fireEvent.click(screen.getByTestId('confirm-btn'));
		expect(onCreate).toHaveBeenCalledTimes(1);
	});

	it('calls onClose when Cancel is clicked', () => {
		const onClose = vi.fn();
		render(<NewFileModal {...defaultProps} onClose={onClose} />);
		fireEvent.click(screen.getByText('Cancel'));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('disables confirm when no value is entered', () => {
		render(<NewFileModal {...defaultProps} value="" />);
		expect((screen.getByTestId('confirm-btn') as HTMLButtonElement).disabled).toBe(true);
	});

	it('disables confirm and shows "Creating..." when isCreating is true', () => {
		render(<NewFileModal {...defaultProps} value="file.ts" isCreating={true} />);
		expect(screen.getByText('Creating...')).toBeTruthy();
		expect((screen.getByTestId('confirm-btn') as HTMLButtonElement).disabled).toBe(true);
	});

	it('does not call onClose from Cancel while creating', () => {
		const onClose = vi.fn();
		render(<NewFileModal {...defaultProps} isCreating={true} onClose={onClose} />);
		fireEvent.click(screen.getByText('Cancel'));
		expect(onClose).not.toHaveBeenCalled();
	});

	it('shows inline error when error prop is set', () => {
		render(<NewFileModal {...defaultProps} error='"file.ts" already exists in this folder' />);
		expect(screen.getByTestId('error')).toBeTruthy();
	});

	it('calls setValue when user types', () => {
		const setValue = vi.fn();
		render(<NewFileModal {...defaultProps} setValue={setValue} />);
		fireEvent.change(screen.getByPlaceholderText('Enter file name...'), {
			target: { value: 'hello.ts' },
		});
		expect(setValue).toHaveBeenCalledWith('hello.ts');
	});
});
