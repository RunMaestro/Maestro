import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GroupChatHeader } from '../../../renderer/components/GroupChatHeader';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { Theme, Shortcut } from '../../../renderer/types';

import { mockTheme } from '../../helpers/mockTheme';
vi.mock('lucide-react', () => ({
	Info: ({ className }: { className?: string }) => (
		<span data-testid="info-icon" className={className}>
			i
		</span>
	),
	Edit2: ({ className }: { className?: string }) => (
		<span data-testid="edit-icon" className={className}>
			✎
		</span>
	),
	Columns: ({ className }: { className?: string }) => (
		<span data-testid="columns-icon" className={className}>
			▥
		</span>
	),
	DollarSign: ({ className }: { className?: string }) => (
		<span data-testid="dollar-icon" className={className}>
			$
		</span>
	),
	StopCircle: ({ className }: { className?: string }) => (
		<span data-testid="stop-circle-icon" className={className}>
			⏹
		</span>
	),
}));

const mockShortcuts: Record<string, Shortcut> = {
	toggleRightPanel: { id: 'toggleRightPanel', label: 'Toggle right panel', keys: ['Cmd', 'B'] },
};

const defaultProps = {
	theme: mockTheme,
	name: 'Test Chat',
	participantCount: 3,
	state: 'idle' as const,
	moderatorOnly: false,
	onToggleModeratorOnly: vi.fn(),
	onStopAll: vi.fn(),
	onRename: vi.fn(),
	onShowInfo: vi.fn(),
	rightPanelOpen: false,
	onToggleRightPanel: vi.fn(),
	shortcuts: mockShortcuts,
};

describe('GroupChatHeader', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useSettingsStore.setState({ showSessionCostPill: true });
	});

	it('renders group chat name and participant count', () => {
		render(<GroupChatHeader {...defaultProps} />);
		expect(screen.getByText('Group Chat: Test Chat')).toBeTruthy();
		expect(screen.getByText('3 participants')).toBeTruthy();
	});

	it('does not render a close (X) button', () => {
		render(<GroupChatHeader {...defaultProps} />);
		expect(screen.queryByTitle('Close')).toBeNull();
	});

	it('renders info button', () => {
		render(<GroupChatHeader {...defaultProps} />);
		expect(screen.getByTitle('Info')).toBeTruthy();
	});

	it('calls onRename when title is clicked', () => {
		render(<GroupChatHeader {...defaultProps} />);
		fireEvent.click(screen.getByText('Group Chat: Test Chat'));
		expect(defaultProps.onRename).toHaveBeenCalled();
	});

	it('shows cost pill when totalCost is provided', () => {
		render(<GroupChatHeader {...defaultProps} totalCost={6.98} />);
		expect(screen.getByText('6.98')).toBeTruthy();
	});

	it('hides cost pill when the session cost pill setting is off', () => {
		useSettingsStore.setState({ showSessionCostPill: false });
		render(<GroupChatHeader {...defaultProps} totalCost={6.98} />);
		expect(screen.queryByText('6.98')).toBeNull();
		expect(screen.queryByTestId('dollar-icon')).toBeNull();
	});

	it('tags the participant pill and marks a busy header for the yield ladder', () => {
		const { container } = render(<GroupChatHeader {...defaultProps} state="moderator-thinking" />);
		const header = container.firstElementChild as HTMLElement;
		expect(header).toHaveClass('group-chat-header-container', 'group-chat-header-busy');
		expect(screen.getByText('3 participants')).toHaveClass('group-chat-header-participants');
	});

	it('does not mark an idle header as busy', () => {
		const { container } = render(<GroupChatHeader {...defaultProps} />);
		expect(container.firstElementChild).not.toHaveClass('group-chat-header-busy');
	});

	it('shows right panel toggle when panel is closed', () => {
		render(<GroupChatHeader {...defaultProps} rightPanelOpen={false} />);
		expect(screen.getByTestId('columns-icon')).toBeTruthy();
	});

	it('hides right panel toggle when panel is open', () => {
		render(<GroupChatHeader {...defaultProps} rightPanelOpen={true} />);
		expect(screen.queryByTestId('columns-icon')).toBeNull();
	});

	it('uses singular "participant" for count of 1', () => {
		render(<GroupChatHeader {...defaultProps} participantCount={1} />);
		expect(screen.getByText('1 participant')).toBeTruthy();
	});

	it('shows Stop All button when state is not idle', () => {
		render(<GroupChatHeader {...defaultProps} state="moderator-thinking" />);
		expect(screen.getByText('Stop All')).toBeTruthy();
	});

	it('hides Stop All button when state is idle', () => {
		render(<GroupChatHeader {...defaultProps} state="idle" />);
		expect(screen.queryByText('Stop All')).toBeNull();
	});

	it('calls onStopAll when Stop All button is clicked', () => {
		const onStopAll = vi.fn();
		render(
			<GroupChatHeader {...defaultProps} state="participants-working" onStopAll={onStopAll} />
		);
		fireEvent.click(screen.getByText('Stop All'));
		expect(onStopAll).toHaveBeenCalledOnce();
	});

	describe('view mode switch', () => {
		it('marks Team Chat as the selected segment in the team view', () => {
			render(<GroupChatHeader {...defaultProps} moderatorOnly={false} />);
			expect(screen.getByTestId('group-chat-view-mode-team').getAttribute('aria-checked')).toBe(
				'true'
			);
			expect(
				screen.getByTestId('group-chat-view-mode-moderator').getAttribute('aria-checked')
			).toBe('false');
		});

		it('marks Moderator Only as the selected segment in the moderator view', () => {
			render(<GroupChatHeader {...defaultProps} moderatorOnly={true} />);
			expect(
				screen.getByTestId('group-chat-view-mode-moderator').getAttribute('aria-checked')
			).toBe('true');
		});

		it('carries short labels for a cramped header', () => {
			render(<GroupChatHeader {...defaultProps} />);
			expect(screen.getByText('Team')).toHaveClass('segmented-label-short');
			expect(screen.getByText('Moderator')).toHaveClass('segmented-label-short');
		});

		it('toggles when the other segment is clicked', () => {
			const onToggleModeratorOnly = vi.fn();
			render(
				<GroupChatHeader
					{...defaultProps}
					moderatorOnly={false}
					onToggleModeratorOnly={onToggleModeratorOnly}
				/>
			);
			fireEvent.click(screen.getByTestId('group-chat-view-mode-moderator'));
			expect(onToggleModeratorOnly).toHaveBeenCalledOnce();
		});

		it('does not toggle when the already-selected segment is clicked', () => {
			const onToggleModeratorOnly = vi.fn();
			render(
				<GroupChatHeader
					{...defaultProps}
					moderatorOnly={false}
					onToggleModeratorOnly={onToggleModeratorOnly}
				/>
			);
			fireEvent.click(screen.getByTestId('group-chat-view-mode-team'));
			expect(onToggleModeratorOnly).not.toHaveBeenCalled();
		});
	});
});
