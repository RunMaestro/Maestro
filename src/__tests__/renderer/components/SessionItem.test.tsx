/**
 * @fileoverview Tests for SessionItem component
 *
 * SessionItem renders a single session in the sidebar with:
 * - Session name and metadata
 * - Status indicators (GIT/LOCAL/REMOTE badges)
 * - AUTO mode indicator
 * - Window number badge (multi-window support)
 * - Bookmark toggle
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
	SessionItem,
	SessionItemProps,
	SessionItemVariant,
} from '../../../renderer/components/SessionItem';
import type { Session, Theme } from '../../../renderer/types';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
	Activity: () => <span data-testid="icon-activity" />,
	GitBranch: () => <span data-testid="icon-git-branch" />,
	Bot: () => <span data-testid="icon-bot" />,
	Bookmark: ({ fill }: { fill?: string }) => <span data-testid="icon-bookmark" data-fill={fill} />,
	AlertCircle: () => <span data-testid="icon-alert-circle" />,
	Server: () => <span data-testid="icon-server" />,
	Square: () => <span data-testid="icon-square" />,
}));

// Default theme
const defaultTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#343746',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentDim: '#bd93f980',
		accentText: '#bd93f9',
		accentForeground: '#f8f8f2',
		border: '#44475a',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
	},
};

// Create mock session
const createMockSession = (overrides: Partial<Session> = {}): Session => ({
	id: `session-${Math.random().toString(36).substr(2, 9)}`,
	name: 'Test Session',
	toolType: 'claude-code',
	state: 'idle',
	inputMode: 'ai',
	cwd: '/home/user/project',
	projectRoot: '/home/user/project',
	aiPid: 12345,
	terminalPid: 12346,
	aiLogs: [],
	shellLogs: [],
	isGitRepo: true,
	fileTree: [],
	fileExplorerExpanded: [],
	messageQueue: [],
	contextUsage: 30,
	activeTimeMs: 60000,
	...overrides,
});

// Create default props
const createDefaultProps = (overrides: Partial<SessionItemProps> = {}): SessionItemProps => ({
	session: createMockSession(),
	variant: 'flat' as SessionItemVariant,
	theme: defaultTheme,
	isActive: false,
	isKeyboardSelected: false,
	isDragging: false,
	isEditing: false,
	leftSidebarOpen: true,
	onSelect: vi.fn(),
	onDragStart: vi.fn(),
	onContextMenu: vi.fn(),
	onFinishRename: vi.fn(),
	onStartRename: vi.fn(),
	onToggleBookmark: vi.fn(),
	...overrides,
});

describe('SessionItem', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ============================================================================
	// Multi-Window Support Tests
	// ============================================================================

	describe('Multi-Window Window Number Badge', () => {
		it('does not show window badge when session is in current window', () => {
			const props = createDefaultProps({
				windowNumber: null,
				isInOtherWindow: false,
			});
			render(<SessionItem {...props} />);

			// Should not find W badge
			expect(screen.queryByText(/^W\d$/)).not.toBeInTheDocument();
		});

		it('shows window badge when session is in another window', () => {
			const props = createDefaultProps({
				windowNumber: 2,
				isInOtherWindow: true,
			});
			render(<SessionItem {...props} />);

			// Should show W2 badge
			expect(screen.getByText('W2')).toBeInTheDocument();
		});

		it('shows correct window number for different windows', () => {
			// Window 1
			const props1 = createDefaultProps({
				windowNumber: 1,
				isInOtherWindow: true,
			});
			const { unmount: unmount1 } = render(<SessionItem {...props1} />);
			expect(screen.getByText('W1')).toBeInTheDocument();
			unmount1();

			// Window 3
			const props3 = createDefaultProps({
				windowNumber: 3,
				isInOtherWindow: true,
			});
			render(<SessionItem {...props3} />);
			expect(screen.getByText('W3')).toBeInTheDocument();
		});

		it('does not show window badge when windowNumber is 0 and not in other window', () => {
			const props = createDefaultProps({
				windowNumber: 0,
				isInOtherWindow: false,
			});
			render(<SessionItem {...props} />);

			expect(screen.queryByText(/^W\d$/)).not.toBeInTheDocument();
		});

		it('shows window badge has correct title attribute', () => {
			const props = createDefaultProps({
				windowNumber: 2,
				isInOtherWindow: true,
			});
			render(<SessionItem {...props} />);

			const badge = screen.getByText('W2').closest('div');
			expect(badge).toHaveAttribute('title', 'Open in Window 2');
		});

		it('shows Square icon in window badge', () => {
			const props = createDefaultProps({
				windowNumber: 1,
				isInOtherWindow: true,
			});
			render(<SessionItem {...props} />);

			expect(screen.getByTestId('icon-square')).toBeInTheDocument();
		});
	});

	// ============================================================================
	// Basic Rendering Tests
	// ============================================================================

	describe('Basic Rendering', () => {
		it('renders session name', () => {
			const props = createDefaultProps({
				session: createMockSession({ name: 'My Test Session' }),
			});
			render(<SessionItem {...props} />);

			expect(screen.getByText('My Test Session')).toBeInTheDocument();
		});

		it('calls onSelect when clicked', () => {
			const onSelect = vi.fn();
			const props = createDefaultProps({ onSelect });
			render(<SessionItem {...props} />);

			fireEvent.click(screen.getByText('Test Session'));
			expect(onSelect).toHaveBeenCalled();
		});

		it('calls onToggleBookmark when bookmark button clicked', () => {
			const onToggleBookmark = vi.fn();
			const props = createDefaultProps({
				onToggleBookmark,
				session: createMockSession({ bookmarked: true }),
			});
			render(<SessionItem {...props} />);

			// Find and click the bookmark button
			const bookmarkIcon = screen.getByTestId('icon-bookmark');
			const bookmarkButton = bookmarkIcon.closest('button');
			if (bookmarkButton) {
				fireEvent.click(bookmarkButton);
				expect(onToggleBookmark).toHaveBeenCalled();
			}
		});
	});

	// ============================================================================
	// Indicator Tests
	// ============================================================================

	describe('Status Indicators', () => {
		it('shows GIT badge for git repos', () => {
			const props = createDefaultProps({
				session: createMockSession({ isGitRepo: true }),
			});
			render(<SessionItem {...props} />);

			expect(screen.getByText('GIT')).toBeInTheDocument();
		});

		it('shows LOCAL badge for non-git local repos', () => {
			const props = createDefaultProps({
				session: createMockSession({ isGitRepo: false }),
			});
			render(<SessionItem {...props} />);

			expect(screen.getByText('LOCAL')).toBeInTheDocument();
		});

		it('shows AUTO badge when session is in batch mode', () => {
			const props = createDefaultProps({
				isInBatch: true,
			});
			render(<SessionItem {...props} />);

			expect(screen.getByText('AUTO')).toBeInTheDocument();
		});

		it('shows ERR badge when session has agent error', () => {
			const props = createDefaultProps({
				session: createMockSession({
					agentError: {
						type: 'test-error',
						message: 'Test error message',
						recoverable: false,
						agentId: 'claude-code',
						timestamp: Date.now(),
					},
				}),
			});
			render(<SessionItem {...props} />);

			expect(screen.getByText('ERR')).toBeInTheDocument();
		});
	});

	// ============================================================================
	// Worktree Variant Tests
	// ============================================================================

	describe('Worktree Variant', () => {
		it('shows git branch icon for worktree variant', () => {
			const props = createDefaultProps({
				variant: 'worktree',
				session: createMockSession({
					parentSessionId: 'parent-123',
					worktreeBranch: 'feature/test',
				}),
			});
			render(<SessionItem {...props} />);

			expect(screen.getByTestId('icon-git-branch')).toBeInTheDocument();
		});

		it('does not show bookmark button for worktree children', () => {
			const props = createDefaultProps({
				variant: 'worktree',
				session: createMockSession({
					parentSessionId: 'parent-123',
				}),
			});
			render(<SessionItem {...props} />);

			// Worktree children inherit bookmark from parent - no toggle button
			expect(screen.queryByTitle(/bookmark/i)).not.toBeInTheDocument();
		});
	});

	// ============================================================================
	// Combined Indicators Tests
	// ============================================================================

	describe('Combined Indicators', () => {
		it('shows both AUTO badge and window badge when applicable', () => {
			const props = createDefaultProps({
				isInBatch: true,
				windowNumber: 2,
				isInOtherWindow: true,
			});
			render(<SessionItem {...props} />);

			expect(screen.getByText('AUTO')).toBeInTheDocument();
			expect(screen.getByText('W2')).toBeInTheDocument();
		});

		it('shows GIT badge, AUTO badge, and window badge together', () => {
			const props = createDefaultProps({
				session: createMockSession({ isGitRepo: true }),
				isInBatch: true,
				windowNumber: 1,
				isInOtherWindow: true,
			});
			render(<SessionItem {...props} />);

			expect(screen.getByText('GIT')).toBeInTheDocument();
			expect(screen.getByText('AUTO')).toBeInTheDocument();
			expect(screen.getByText('W1')).toBeInTheDocument();
		});
	});
});
