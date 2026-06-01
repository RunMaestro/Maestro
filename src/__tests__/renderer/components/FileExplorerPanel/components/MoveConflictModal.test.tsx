import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MoveConflictModal } from '../../../../../renderer/components/FileExplorerPanel/components/MoveConflictModal';
import { mockTheme } from '../../../../helpers/mockTheme';
import type { PendingMove } from '../../../../../renderer/components/FileExplorerPanel/types';

vi.mock('../../../../../renderer/components/ui/Modal', () => ({
	Modal: ({ title, children }: any) => (
		<div>
			<div data-testid="modal-title">{title}</div>
			{children}
		</div>
	),
}));

vi.mock('../../../../../renderer/constants/modalPriorities', () => ({
	MODAL_PRIORITIES: { CONFIRM: 200 },
}));

const makePendingMove = (name: string, autoName?: string): PendingMove => ({
	sourceName: name,
	sourceRelativePath: `src/${name}`,
	sourceAbsolutePath: `/project/src/${name}`,
	destAbsolutePath: `/project/dest/${name}`,
	autoRenameName: autoName ?? `${name} (2)`,
	autoRenameAbsolutePath: `/project/dest/${autoName ?? `${name} (2)`}`,
});

const defaultProps = {
	theme: mockTheme,
	destFolderLabel: '"components"',
	conflicts: [makePendingMove('index.ts')],
	nonConflictingCount: 0,
	isMoving: false,
	onCancel: vi.fn(),
	onOverwriteAll: vi.fn(),
	onAutoRenameAll: vi.fn(),
	onSkipConflicts: vi.fn(),
};

describe('MoveConflictModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('shows "Name conflict" title for a single conflict', () => {
		render(<MoveConflictModal {...defaultProps} />);
		expect(screen.getByTestId('modal-title').textContent).toBe('Name conflict');
	});

	it('shows "Name conflicts (N)" title for multiple conflicts', () => {
		render(
			<MoveConflictModal
				{...defaultProps}
				conflicts={[makePendingMove('a.ts'), makePendingMove('b.ts')]}
			/>
		);
		expect(screen.getByTestId('modal-title').textContent).toBe('Name conflicts (2)');
	});

	it('shows the auto-rename target name for single conflict', () => {
		render(<MoveConflictModal {...defaultProps} />);
		expect(screen.getByText(/Rename to "index\.ts \(2\)"/)).toBeTruthy();
	});

	it('calls onAutoRenameAll when auto-rename option is chosen', () => {
		const onAutoRenameAll = vi.fn();
		render(<MoveConflictModal {...defaultProps} onAutoRenameAll={onAutoRenameAll} />);
		fireEvent.click(screen.getByText(/Rename to/));
		expect(onAutoRenameAll).toHaveBeenCalledTimes(1);
	});

	it('calls onOverwriteAll when overwrite option is chosen', () => {
		const onOverwriteAll = vi.fn();
		render(<MoveConflictModal {...defaultProps} onOverwriteAll={onOverwriteAll} />);
		fireEvent.click(screen.getByText(/Overwrite existing/));
		expect(onOverwriteAll).toHaveBeenCalledTimes(1);
	});

	it('calls onCancel when Cancel is clicked', () => {
		const onCancel = vi.fn();
		render(<MoveConflictModal {...defaultProps} onCancel={onCancel} />);
		fireEvent.click(screen.getByText('Cancel'));
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('shows "Skip conflicts" button when nonConflictingCount > 0', () => {
		const onSkipConflicts = vi.fn();
		render(
			<MoveConflictModal
				{...defaultProps}
				nonConflictingCount={2}
				onSkipConflicts={onSkipConflicts}
			/>
		);
		const skipBtn = screen.getByText(/Skip conflicts, move 2/);
		expect(skipBtn).toBeTruthy();
		fireEvent.click(skipBtn);
		expect(onSkipConflicts).toHaveBeenCalledTimes(1);
	});

	it('does not show "Skip conflicts" when nonConflictingCount is 0', () => {
		render(<MoveConflictModal {...defaultProps} nonConflictingCount={0} />);
		expect(screen.queryByText(/Skip conflicts/)).toBeNull();
	});

	it('shows non-conflicting count in the body for multi-conflict', () => {
		render(
			<MoveConflictModal
				{...defaultProps}
				conflicts={[makePendingMove('a.ts'), makePendingMove('b.ts')]}
				nonConflictingCount={3}
			/>
		);
		expect(screen.getByText(/3 others can move without conflict/)).toBeTruthy();
	});

	it('disables all action buttons while moving', () => {
		render(<MoveConflictModal {...defaultProps} isMoving={true} />);
		const buttons = screen.getAllByRole('button');
		buttons.forEach((btn) => expect((btn as HTMLButtonElement).disabled).toBe(true));
	});

	it('uses "import" verbs when operation is copy', () => {
		render(
			<MoveConflictModal
				{...defaultProps}
				operation="copy"
				conflicts={[makePendingMove('a.ts'), makePendingMove('b.ts')]}
				nonConflictingCount={3}
			/>
		);
		// Body and skip button switch the verb from "move" to "import".
		expect(screen.getByText(/3 others can import without conflict/)).toBeTruthy();
		expect(screen.getByText(/Skip conflicts, import 3/)).toBeTruthy();
	});
});
