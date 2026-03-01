import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GroupChatHeader } from '../../../renderer/components/GroupChatHeader';
import type { Theme, Shortcut } from '../../../renderer/types';

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
}));

const mockTheme = {
	colors: {
		bgSidebar: '#1e1e1e',
		border: '#333',
		textMain: '#fff',
		textDim: '#999',
		success: '#4caf50',
	},
} as Theme;

const mockShortcuts: Record<string, Shortcut> = {
	toggleRightPanel: { id: 'toggleRightPanel', label: 'Toggle right panel', keys: ['Cmd', 'B'] },
};

const defaultProps = {
	theme: mockTheme,
	name: 'Test Chat',
	participantCount: 3,
	onRename: vi.fn(),
	onShowInfo: vi.fn(),
	rightPanelOpen: false,
	onToggleRightPanel: vi.fn(),
	shortcuts: mockShortcuts,
};

describe('GroupChatHeader', () => {
	beforeEach(() => {
		vi.clearAllMocks();
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
});
