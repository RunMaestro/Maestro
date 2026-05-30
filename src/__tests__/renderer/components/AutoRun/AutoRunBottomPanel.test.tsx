import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
	AutoRunBottomPanel,
	type AutoRunBottomPanelProps,
} from '../../../../renderer/components/AutoRun/AutoRunBottomPanel';

import { mockTheme } from '../../../helpers/mockTheme';
vi.mock('../../../../renderer/utils/shortcutFormatter', () => ({
	formatShortcutKeys: (keys: string[]) => keys.join('+'),
}));
vi.mock('../../../../renderer/utils/tokenCounter', () => ({
	formatTokenCount: (count: number) => `${count}`,
}));

vi.mock('lucide-react', () => ({
	RotateCcw: ({ className }: { className?: string }) => (
		<span data-testid="rotate-ccw-icon" className={className}>
			↺
		</span>
	),
	Save: ({ className }: { className?: string }) => (
		<span data-testid="save-icon" className={className}>
			💾
		</span>
	),
}));

const defaultProps: AutoRunBottomPanelProps = {
	theme: mockTheme,
	taskCounts: { completed: 0, total: 0 },
	tokenCount: null,
	isDirty: false,
	isLocked: false,
	onSave: vi.fn(),
	onRevert: vi.fn(),
	onOpenResetTasksModal: vi.fn(),
};

function renderPanel(overrides: Partial<AutoRunBottomPanelProps> = {}) {
	const props = { ...defaultProps, ...overrides };
	return render(<AutoRunBottomPanel {...props} />);
}

describe('AutoRunBottomPanel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('shows task counts when total > 0', () => {
		renderPanel({ taskCounts: { completed: 2, total: 5 } });
		expect(screen.getByText('2')).toBeInTheDocument();
		expect(screen.getByText('5')).toBeInTheDocument();
		expect(screen.getByText(/of/)).toBeInTheDocument();
		expect(screen.getByText(/tasks/)).toBeInTheDocument();
	});

	it('shows completed count in success color when all tasks done', () => {
		renderPanel({ taskCounts: { completed: 5, total: 5 } });
		// Both "5" spans exist; the first one is the completed count
		const fives = screen.getAllByText('5');
		const completedSpan = fives[0];
		expect(completedSpan).toHaveStyle({ color: mockTheme.colors.success });
	});

	it('shows completed count in accent color when not all tasks done', () => {
		renderPanel({ taskCounts: { completed: 2, total: 5 } });
		const completedSpan = screen.getByText('2');
		expect(completedSpan).toHaveStyle({ color: mockTheme.colors.accent });
	});

	it('shows Revert button when isDirty and not locked', () => {
		renderPanel({ isDirty: true, isLocked: false });
		expect(screen.getByTitle('Discard changes')).toBeInTheDocument();
	});

	it('hides Revert button when not dirty', () => {
		renderPanel({ isDirty: false, isLocked: false });
		expect(screen.queryByTitle('Discard changes')).not.toBeInTheDocument();
	});

	it('hides Revert button when locked', () => {
		renderPanel({ isDirty: true, isLocked: true });
		expect(screen.queryByTitle('Discard changes')).not.toBeInTheDocument();
	});

	it('shows Save button when isDirty and not locked', () => {
		renderPanel({ isDirty: true, isLocked: false });
		expect(screen.getByTitle(/Save changes/)).toBeInTheDocument();
	});

	it('hides Save button when not dirty', () => {
		renderPanel({ isDirty: false, isLocked: false });
		expect(screen.queryByTitle(/Save changes/)).not.toBeInTheDocument();
	});

	it('clicking Save calls onSave', () => {
		const onSave = vi.fn();
		renderPanel({ isDirty: true, isLocked: false, onSave });
		fireEvent.click(screen.getByTitle(/Save changes/));
		expect(onSave).toHaveBeenCalledOnce();
	});

	it('clicking Revert calls onRevert', () => {
		const onRevert = vi.fn();
		renderPanel({ isDirty: true, isLocked: false, onRevert });
		fireEvent.click(screen.getByTitle('Discard changes'));
		expect(onRevert).toHaveBeenCalledOnce();
	});

	it('shows token count when tokenCount is not null', () => {
		renderPanel({ tokenCount: 1500 });
		expect(screen.getByText('Tokens:')).toBeInTheDocument();
		expect(screen.getByText('1500')).toBeInTheDocument();
	});

	it('does not show token count when tokenCount is null', () => {
		renderPanel({ tokenCount: null });
		expect(screen.queryByText('Tokens:')).not.toBeInTheDocument();
	});

	it('shows "Unsaved changes" when no tasks, no tokens, but dirty and not locked', () => {
		renderPanel({
			taskCounts: { completed: 0, total: 0 },
			tokenCount: null,
			isDirty: true,
			isLocked: false,
		});
		expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
	});

	it('does not show "Unsaved changes" when tasks exist', () => {
		renderPanel({
			taskCounts: { completed: 0, total: 3 },
			tokenCount: null,
			isDirty: true,
			isLocked: false,
		});
		expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
	});

	it('does not show "Unsaved changes" when locked', () => {
		renderPanel({
			taskCounts: { completed: 0, total: 0 },
			tokenCount: null,
			isDirty: true,
			isLocked: true,
		});
		expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
	});

	it('shows reset button when taskCounts.completed > 0 and not locked', () => {
		renderPanel({
			taskCounts: { completed: 3, total: 5 },
			isLocked: false,
		});
		expect(screen.getByTitle(/Reset 3 completed tasks/)).toBeInTheDocument();
	});

	it('hides reset button when taskCounts.completed is 0', () => {
		renderPanel({
			taskCounts: { completed: 0, total: 5 },
			isLocked: false,
		});
		expect(screen.queryByTitle(/Reset.*completed/)).not.toBeInTheDocument();
	});

	it('hides reset button when locked', () => {
		renderPanel({
			taskCounts: { completed: 3, total: 5 },
			isLocked: true,
		});
		expect(screen.queryByTitle(/Reset.*completed/)).not.toBeInTheDocument();
	});

	it('clicking reset button calls onOpenResetTasksModal', () => {
		const onOpenResetTasksModal = vi.fn();
		renderPanel({
			taskCounts: { completed: 2, total: 5 },
			isLocked: false,
			onOpenResetTasksModal,
		});
		fireEvent.click(screen.getByTitle(/Reset 2 completed tasks/));
		expect(onOpenResetTasksModal).toHaveBeenCalledOnce();
	});

	it('reset button title uses singular "task" when completed is 1', () => {
		renderPanel({
			taskCounts: { completed: 1, total: 5 },
			isLocked: false,
		});
		expect(screen.getByTitle('Reset 1 completed task')).toBeInTheDocument();
	});

	it('reset button title uses plural "tasks" when completed > 1', () => {
		renderPanel({
			taskCounts: { completed: 3, total: 5 },
			isLocked: false,
		});
		expect(screen.getByTitle('Reset 3 completed tasks')).toBeInTheDocument();
	});
});
