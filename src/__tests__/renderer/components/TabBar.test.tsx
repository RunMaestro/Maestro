import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TabBar } from '../../../renderer/components/TabBar';
import type { AITab, Theme } from '../../../renderer/types';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
	X: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="x-icon" className={className} style={style}>
			X
		</span>
	),
	Plus: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="plus-icon" className={className} style={style}>
			+
		</span>
	),
	Star: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="star-icon" className={className} style={style}>
			★
		</span>
	),
	Copy: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="copy-icon" className={className} style={style}>
			📋
		</span>
	),
	Edit2: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="edit-icon" className={className} style={style}>
			✎
		</span>
	),
	Mail: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="mail-icon" className={className} style={style}>
			✉
		</span>
	),
	Pencil: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="pencil-icon" className={className} style={style}>
			✏
		</span>
	),
	Search: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="search-icon" className={className} style={style}>
			🔍
		</span>
	),
	GitMerge: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="git-merge-icon" className={className} style={style}>
			⎇
		</span>
	),
	ArrowRightCircle: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="arrow-right-circle-icon" className={className} style={style}>
			→
		</span>
	),
	Minimize2: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="minimize-icon" className={className} style={style}>
			⊟
		</span>
	),
	Download: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="download-icon" className={className} style={style}>
			↓
		</span>
	),
	Clipboard: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="clipboard-icon" className={className} style={style}>
			📎
		</span>
	),
	Share2: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="share2-icon" className={className} style={style}>
			⬆
		</span>
	),
	ChevronsLeft: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="chevrons-left-icon" className={className} style={style}>
			«
		</span>
	),
	ChevronsRight: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="chevrons-right-icon" className={className} style={style}>
			»
		</span>
	),
}));

// Mock react-dom createPortal
vi.mock('react-dom', async () => {
	const actual = await vi.importActual('react-dom');
	return {
		...actual,
		createPortal: (children: React.ReactNode) => children,
	};
});

// Test theme
const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#2a2a2a',
		bgActivity: '#3a3a3a',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#007acc',
		border: '#444444',
		error: '#ff4444',
		success: '#44ff44',
		warning: '#ffaa00',
		vibe: '#ff00ff',
		agentStatus: '#00ff00',
	},
};

// Helper to create tabs
function createTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
		state: 'idle',
		name: '',
		starred: false,
		hasUnread: false,
		inputValue: '',
		stagedImages: [],
		...overrides,
	};
}

describe('TabBar', () => {
	const mockOnTabSelect = vi.fn();
	const mockOnTabClose = vi.fn();
	const mockOnNewTab = vi.fn();
	const mockOnTabRename = vi.fn();
	const mockOnRequestRename = vi.fn();
	const mockOnTabReorder = vi.fn();
	const mockOnTabStar = vi.fn();
	const mockOnTabMarkUnread = vi.fn();
	const mockOnToggleUnreadFilter = vi.fn();
	const mockOnOpenTabSearch = vi.fn();

	// Mock timers for hover delays
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		// Mock scrollTo
		Element.prototype.scrollTo = vi.fn();
		// Mock clipboard
		Object.assign(navigator, {
			clipboard: {
				writeText: vi.fn().mockResolvedValue(undefined),
			},
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('rendering', () => {
		it('renders tabs correctly', () => {
			const tabs = [createTab({ id: 'tab-1', name: 'Tab 1' })];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			expect(screen.getByText('Tab 1')).toBeInTheDocument();
		});

		it('renders new tab button', () => {
			render(
				<TabBar
					tabs={[createTab()]}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			expect(screen.getByTitle('New tab (Cmd+T)')).toBeInTheDocument();
		});

		it('renders unread filter button', () => {
			render(
				<TabBar
					tabs={[createTab()]}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			expect(screen.getByTitle(/Filter unread tabs/)).toBeInTheDocument();
		});

		it('renders tab search button when onOpenTabSearch provided', () => {
			render(
				<TabBar
					tabs={[createTab()]}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onOpenTabSearch={mockOnOpenTabSearch}
				/>
			);

			expect(screen.getByTitle('Search tabs (Cmd+Shift+O)')).toBeInTheDocument();
		});

		it('does not render tab search button when onOpenTabSearch not provided', () => {
			render(
				<TabBar
					tabs={[createTab()]}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			expect(screen.queryByTitle('Search tabs (Cmd+Shift+O)')).not.toBeInTheDocument();
		});
	});

	describe('getTabDisplayName', () => {
		it('displays tab name when provided', () => {
			const tabs = [createTab({ id: 'tab-1', name: 'My Custom Tab' })];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			expect(screen.getByText('My Custom Tab')).toBeInTheDocument();
		});

		it('displays first UUID octet when no name but agentSessionId exists', () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: '',
					agentSessionId: 'abcd1234-5678-9abc-def0-123456789012',
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			expect(screen.getByText('ABCD1234')).toBeInTheDocument();
		});

		it('displays "New Session" when no name and no agentSessionId', () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: '',
					agentSessionId: undefined,
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			expect(screen.getByText('New Session')).toBeInTheDocument();
		});
	});

	describe('tab selection', () => {
		it('calls onTabSelect when tab is clicked', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Tab 1' }),
				createTab({ id: 'tab-2', name: 'Tab 2' }),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			fireEvent.click(screen.getByText('Tab 2'));
			expect(mockOnTabSelect).toHaveBeenCalledWith('tab-2');
		});

		it('applies active styles to active tab', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Tab 1' }),
				createTab({ id: 'tab-2', name: 'Tab 2' }),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			const activeTab = screen.getByText('Tab 1').closest('[data-tab-id]');
			expect(activeTab).toHaveStyle({ backgroundColor: mockTheme.colors.bgMain });
		});
	});

	describe('tab close', () => {
		it('calls onTabClose when close button is clicked', () => {
			const tabs = [createTab({ id: 'tab-1', name: 'Tab 1' })];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			const closeButton = screen.getByTitle('Close tab');
			fireEvent.click(closeButton);
			expect(mockOnTabClose).toHaveBeenCalledWith('tab-1');
		});

		it('calls onTabClose on middle-click', () => {
			const tabs = [createTab({ id: 'tab-1', name: 'Tab 1' })];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			fireEvent.mouseDown(tab, { button: 1 });
			expect(mockOnTabClose).toHaveBeenCalledWith('tab-1');
		});

		it('does not close on left-click mouseDown', () => {
			const tabs = [createTab({ id: 'tab-1', name: 'Tab 1' })];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			fireEvent.mouseDown(tab, { button: 0 });
			expect(mockOnTabClose).not.toHaveBeenCalled();
		});
	});

	describe('new tab', () => {
		it('calls onNewTab when new tab button is clicked', () => {
			render(
				<TabBar
					tabs={[createTab()]}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			fireEvent.click(screen.getByTitle('New tab (Cmd+T)'));
			expect(mockOnNewTab).toHaveBeenCalled();
		});
	});

	describe('tab indicators', () => {
		it('shows busy indicator when tab is busy', () => {
			const tabs = [createTab({ id: 'tab-1', name: 'Tab 1', state: 'busy' })];

			const { container } = render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			const busyDot = container.querySelector('.animate-pulse');
			expect(busyDot).toBeInTheDocument();
			expect(busyDot).toHaveStyle({ backgroundColor: mockTheme.colors.warning });
		});

		it('shows unread indicator for inactive tab with unread messages', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Tab 1' }),
				createTab({ id: 'tab-2', name: 'Tab 2', hasUnread: true }),
			];

			const { container } = render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			const unreadDot = container.querySelector('[title="New messages"]');
			expect(unreadDot).toBeInTheDocument();
			expect(unreadDot).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
		});

		it('shows unread indicator for active tab (when manually marked)', () => {
			const tabs = [createTab({ id: 'tab-1', name: 'Tab 1', hasUnread: true })];

			const { container } = render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			// Unread indicator should show immediately even on active tab
			// This allows users to mark a tab as unread and see the indicator right away
			const unreadDot = container.querySelector('[title="New messages"]');
			expect(unreadDot).toBeInTheDocument();
			expect(unreadDot).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
		});

		it('does not show unread indicator for busy tab', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Tab 1' }),
				createTab({ id: 'tab-2', name: 'Tab 2', hasUnread: true, state: 'busy' }),
			];

			const { container } = render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			expect(container.querySelector('[title="New messages"]')).not.toBeInTheDocument();
		});

		it('shows star indicator for starred tabs', () => {
			const tabs = [createTab({ id: 'tab-1', name: 'Tab 1', starred: true })];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			expect(screen.getByTestId('star-icon')).toBeInTheDocument();
		});

		it('shows draft indicator for tabs with unsent input', () => {
			const tabs = [createTab({ id: 'tab-1', name: 'Tab 1', inputValue: 'draft message' })];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			// The pencil icon component is rendered with testid
			expect(screen.getByTestId('pencil-icon')).toBeInTheDocument();
		});

		it('shows draft indicator for tabs with staged images', () => {
			const tabs = [createTab({ id: 'tab-1', name: 'Tab 1', stagedImages: ['image.png'] })];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			// The pencil icon component is rendered with testid
			expect(screen.getByTestId('pencil-icon')).toBeInTheDocument();
		});

		it('shows shortcut hints for first 9 tabs', () => {
			const tabs = Array.from({ length: 10 }, (_, i) =>
				createTab({ id: `tab-${i}`, name: `Tab ${i + 1}` })
			);

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-0"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			// Should show 1-9 but not 10
			for (let i = 1; i <= 9; i++) {
				expect(screen.getByText(String(i))).toBeInTheDocument();
			}
			expect(screen.queryByText('10')).not.toBeInTheDocument();
		});

		it('hides shortcut hints when showUnreadOnly is true', () => {
			const tabs = [createTab({ id: 'tab-1', name: 'Tab 1' })];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					showUnreadOnly={true}
				/>
			);

			expect(screen.queryByText('1')).not.toBeInTheDocument();
		});
	});

	describe('unread filter', () => {
		it('toggles unread filter when button clicked (uncontrolled)', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Tab 1' }),
				createTab({ id: 'tab-2', name: 'Tab 2', hasUnread: true }),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			// Initially both tabs visible
			expect(screen.getByText('Tab 1')).toBeInTheDocument();
			expect(screen.getByText('Tab 2')).toBeInTheDocument();

			// Toggle filter
			fireEvent.click(screen.getByTitle(/Filter unread tabs/));

			// Now only unread and active tab visible
			expect(screen.getByText('Tab 1')).toBeInTheDocument(); // Active
			expect(screen.getByText('Tab 2')).toBeInTheDocument(); // Unread
		});

		it('calls onToggleUnreadFilter when provided (controlled)', () => {
			const tabs = [createTab({ id: 'tab-1', name: 'Tab 1' })];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onToggleUnreadFilter={mockOnToggleUnreadFilter}
				/>
			);

			fireEvent.click(screen.getByTitle(/Filter unread tabs/));
			expect(mockOnToggleUnreadFilter).toHaveBeenCalled();
		});

		it('shows empty state when filter is on but no unread tabs', () => {
			const tabs = [createTab({ id: 'tab-1', name: 'Tab 1' })];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-2" // Different from tab-1
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					showUnreadOnly={true}
				/>
			);

			expect(screen.getByText('No unread tabs')).toBeInTheDocument();
		});

		it('includes tabs with drafts in filtered view', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Tab 1' }),
				createTab({ id: 'tab-2', name: 'Draft Tab', inputValue: 'draft' }),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-3" // Not in the list
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					showUnreadOnly={true}
				/>
			);

			// Only draft tab should be visible
			expect(screen.queryByText('Tab 1')).not.toBeInTheDocument();
			expect(screen.getByText('Draft Tab')).toBeInTheDocument();
		});

		it('updates filter button title based on state', () => {
			const tabs = [createTab({ id: 'tab-1', name: 'Tab 1' })];

			const { rerender } = render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					showUnreadOnly={false}
				/>
			);

			expect(screen.getByTitle('Filter unread tabs (Cmd+U)')).toBeInTheDocument();

			rerender(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					showUnreadOnly={true}
				/>
			);

			expect(screen.getByTitle('Showing unread only (Cmd+U)')).toBeInTheDocument();
		});
	});

	describe('tab search', () => {
		it('calls onOpenTabSearch when search button clicked', () => {
			render(
				<TabBar
					tabs={[createTab()]}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onOpenTabSearch={mockOnOpenTabSearch}
				/>
			);

			fireEvent.click(screen.getByTitle('Search tabs (Cmd+Shift+O)'));
			expect(mockOnOpenTabSearch).toHaveBeenCalled();
		});
	});

	describe('drag and drop', () => {
		it('handles drag start', () => {
			const tabs = [createTab({ id: 'tab-1', name: 'Tab 1' })];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onTabReorder={mockOnTabReorder}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			const dataTransfer = {
				effectAllowed: '',
				setData: vi.fn(),
				getData: vi.fn().mockReturnValue('tab-1'),
			};

			fireEvent.dragStart(tab, { dataTransfer });

			expect(dataTransfer.effectAllowed).toBe('move');
			expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'tab-1');
		});

		it('handles drag over', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Tab 1' }),
				createTab({ id: 'tab-2', name: 'Tab 2' }),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onTabReorder={mockOnTabReorder}
				/>
			);

			const tab2 = screen.getByText('Tab 2').closest('[data-tab-id]')!;
			const dataTransfer = {
				dropEffect: '',
			};

			const event = fireEvent.dragOver(tab2, { dataTransfer });
			expect(dataTransfer.dropEffect).toBe('move');
		});

		it('handles drop and reorders tabs', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Tab 1' }),
				createTab({ id: 'tab-2', name: 'Tab 2' }),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onTabReorder={mockOnTabReorder}
				/>
			);

			const tab1 = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			const tab2 = screen.getByText('Tab 2').closest('[data-tab-id]')!;

			// Start dragging tab-1
			fireEvent.dragStart(tab1, {
				dataTransfer: {
					effectAllowed: '',
					setData: vi.fn(),
					getData: vi.fn().mockReturnValue('tab-1'),
				},
			});

			// Drop on tab-2
			fireEvent.drop(tab2, {
				dataTransfer: {
					getData: vi.fn().mockReturnValue('tab-1'),
				},
			});

			expect(mockOnTabReorder).toHaveBeenCalledWith(0, 1);
		});

		it('does not reorder when dropping on same tab', () => {
			const tabs = [createTab({ id: 'tab-1', name: 'Tab 1' })];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onTabReorder={mockOnTabReorder}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;

			fireEvent.drop(tab, {
				dataTransfer: {
					getData: vi.fn().mockReturnValue('tab-1'),
				},
			});

			expect(mockOnTabReorder).not.toHaveBeenCalled();
		});

		it('handles drag end', () => {
			const tabs = [createTab({ id: 'tab-1', name: 'Tab 1' })];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onTabReorder={mockOnTabReorder}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;

			// Start drag to set draggingTabId
			fireEvent.dragStart(tab, {
				dataTransfer: {
					effectAllowed: '',
					setData: vi.fn(),
				},
			});

			// Drag end should reset state
			fireEvent.dragEnd(tab);

			// Tab should no longer have opacity-50 class (dragging state)
			expect(tab).not.toHaveClass('opacity-50');
		});
	});

	describe('hover overlay', () => {
		it('shows overlay after hover delay for tabs with agentSessionId', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'Tab 1',
					agentSessionId: 'abc123-def456',
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onTabStar={mockOnTabStar}
					onRequestRename={mockOnRequestRename}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			// Overlay not visible yet
			expect(screen.queryByText('Copy Session ID')).not.toBeInTheDocument();

			// Advance timers past the 400ms delay
			act(() => {
				vi.advanceTimersByTime(450);
			});

			// Now overlay should be visible
			expect(screen.getByText('Copy Session ID')).toBeInTheDocument();
			expect(screen.getByText('Star Session')).toBeInTheDocument();
			expect(screen.getByText('Rename Tab')).toBeInTheDocument();
		});

		it('does not show overlay for tabs without agentSessionId', () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: '',
					agentSessionId: undefined,
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			const tab = screen.getByText('New Session').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			act(() => {
				vi.advanceTimersByTime(500);
			});

			expect(screen.queryByText('Copy Session ID')).not.toBeInTheDocument();
		});

		it('closes overlay on mouse leave', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'Tab 1',
					agentSessionId: 'abc123',
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onTabStar={mockOnTabStar}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;

			// Open overlay
			fireEvent.mouseEnter(tab);
			act(() => {
				vi.advanceTimersByTime(450);
			});
			expect(screen.getByText('Copy Session ID')).toBeInTheDocument();

			// Leave tab
			fireEvent.mouseLeave(tab);

			// Wait for close delay
			act(() => {
				vi.advanceTimersByTime(150);
			});

			expect(screen.queryByText('Copy Session ID')).not.toBeInTheDocument();
		});

		it('keeps overlay open when mouse enters overlay', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'Tab 1',
					agentSessionId: 'abc123',
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onTabStar={mockOnTabStar}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;

			// Open overlay
			fireEvent.mouseEnter(tab);
			act(() => {
				vi.advanceTimersByTime(450);
			});

			const overlay = screen.getByText('Copy Session ID').closest('.fixed')!;

			// Leave tab but enter overlay
			fireEvent.mouseLeave(tab);
			fireEvent.mouseEnter(overlay);

			// Wait past close delay
			act(() => {
				vi.advanceTimersByTime(200);
			});

			// Overlay should still be visible
			expect(screen.getByText('Copy Session ID')).toBeInTheDocument();
		});

		it('closes overlay when mouse leaves overlay', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'Tab 1',
					agentSessionId: 'abc123',
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onTabStar={mockOnTabStar}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;

			// Open overlay
			fireEvent.mouseEnter(tab);
			act(() => {
				vi.advanceTimersByTime(450);
			});

			const overlay = screen.getByText('Copy Session ID').closest('.fixed')!;

			// Leave tab but enter overlay (to keep it open)
			fireEvent.mouseLeave(tab);
			fireEvent.mouseEnter(overlay);

			// Verify overlay is still visible
			expect(screen.getByText('Copy Session ID')).toBeInTheDocument();

			// Now leave the overlay
			fireEvent.mouseLeave(overlay);

			// Overlay should close immediately
			expect(screen.queryByText('Copy Session ID')).not.toBeInTheDocument();
		});

		it('prevents click event propagation on overlay', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'Tab 1',
					agentSessionId: 'abc123',
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onTabStar={mockOnTabStar}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;

			// Open overlay
			fireEvent.mouseEnter(tab);
			act(() => {
				vi.advanceTimersByTime(450);
			});

			const overlay = screen.getByText('Copy Session ID').closest('.fixed')!;

			// Click on overlay should not propagate
			fireEvent.click(overlay);

			// Overlay should still be open (event was stopped)
			expect(screen.getByText('Copy Session ID')).toBeInTheDocument();
		});

		it('copies session ID to clipboard', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'Tab 1',
					agentSessionId: 'abc123-xyz789',
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);
			act(() => {
				vi.advanceTimersByTime(450);
			});

			fireEvent.click(screen.getByText('Copy Session ID'));

			expect(navigator.clipboard.writeText).toHaveBeenCalledWith('abc123-xyz789');
			expect(screen.getByText('Copied!')).toBeInTheDocument();

			// Reset after delay
			act(() => {
				vi.advanceTimersByTime(1600);
			});
			expect(screen.queryByText('Copied!')).not.toBeInTheDocument();
		});

		it('calls onTabStar when star button clicked', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'Tab 1',
					agentSessionId: 'abc123',
					starred: false,
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onTabStar={mockOnTabStar}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);
			act(() => {
				vi.advanceTimersByTime(450);
			});

			fireEvent.click(screen.getByText('Star Session'));
			expect(mockOnTabStar).toHaveBeenCalledWith('tab-1', true);
		});

		it('shows "Unstar Session" for starred tabs', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'Tab 1',
					agentSessionId: 'abc123',
					starred: true,
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onTabStar={mockOnTabStar}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);
			act(() => {
				vi.advanceTimersByTime(450);
			});

			expect(screen.getByText('Unstar Session')).toBeInTheDocument();
		});

		it('calls onRequestRename when rename clicked', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'Tab 1',
					agentSessionId: 'abc123',
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onRequestRename={mockOnRequestRename}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);
			act(() => {
				vi.advanceTimersByTime(450);
			});

			fireEvent.click(screen.getByText('Rename Tab'));
			expect(mockOnRequestRename).toHaveBeenCalledWith('tab-1');
		});

		it('calls onTabMarkUnread when Mark as Unread clicked', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'Tab 1',
					agentSessionId: 'abc123',
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onTabMarkUnread={mockOnTabMarkUnread}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);
			act(() => {
				vi.advanceTimersByTime(450);
			});

			fireEvent.click(screen.getByText('Mark as Unread'));
			expect(mockOnTabMarkUnread).toHaveBeenCalledWith('tab-1');
		});

		it('displays session name in overlay header', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'My Session Name',
					agentSessionId: 'abc123',
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			const tab = screen.getByText('My Session Name').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);
			act(() => {
				vi.advanceTimersByTime(450);
			});

			// Session name appears in overlay header
			const overlayNames = screen.getAllByText('My Session Name');
			expect(overlayNames.length).toBeGreaterThan(1); // Tab name + overlay header
		});

		it('displays session ID in overlay header', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: '',
					agentSessionId: 'full-session-id-12345',
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			const tab = screen.getByText('FULL').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);
			act(() => {
				vi.advanceTimersByTime(450);
			});

			expect(screen.getByText('full-session-id-12345')).toBeInTheDocument();
		});
	});

	describe('separators', () => {
		it('shows separators between inactive tabs', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Tab 1' }),
				createTab({ id: 'tab-2', name: 'Tab 2' }),
				createTab({ id: 'tab-3', name: 'Tab 3' }),
			];

			const { container } = render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			// Separators between inactive tabs (tab-2 and tab-3)
			const separators = container.querySelectorAll('.w-px');
			expect(separators.length).toBeGreaterThan(0);
		});

		it('does not show separator next to active tab', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Tab 1' }),
				createTab({ id: 'tab-2', name: 'Tab 2' }),
			];

			const { container } = render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-2"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			// No separator when active tab is involved
			const separators = container.querySelectorAll('.w-px');
			// Separator should not appear before tab-2 (which is active)
			expect(separators.length).toBe(0);
		});
	});

	describe('scroll behavior', () => {
		it('scrolls to center active tab when activeTabId changes', async () => {
			// Mock requestAnimationFrame
			const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
				cb(0);
				return 0;
			});
			const scrollToSpy = vi.fn();

			const tabs = [
				createTab({ id: 'tab-1', name: 'Tab 1' }),
				createTab({ id: 'tab-2', name: 'Tab 2' }),
			];

			const { rerender, container } = render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			// Mock scrollTo on the container
			const tabBarContainer = container.firstChild as HTMLElement;
			tabBarContainer.scrollTo = scrollToSpy;

			// Change active tab
			rerender(
				<TabBar
					tabs={tabs}
					activeTabId="tab-2"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			// scrollTo should have been called via requestAnimationFrame
			expect(scrollToSpy).toHaveBeenCalled();

			rafSpy.mockRestore();
		});

		it('scrolls to center active tab when showUnreadOnly filter is toggled off', async () => {
			// Mock requestAnimationFrame
			const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
				cb(0);
				return 0;
			});
			const scrollToSpy = vi.fn();

			const tabs = [
				createTab({ id: 'tab-1', name: 'Tab 1' }),
				createTab({ id: 'tab-2', name: 'Tab 2', hasUnread: true }),
				createTab({ id: 'tab-3', name: 'Tab 3' }),
			];

			const { rerender, container } = render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-3"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					showUnreadOnly={true}
				/>
			);

			// Mock scrollTo on the container
			const tabBarContainer = container.firstChild as HTMLElement;
			tabBarContainer.scrollTo = scrollToSpy;

			// Clear initial calls
			scrollToSpy.mockClear();

			// Toggle filter off - this should trigger scroll to active tab
			rerender(
				<TabBar
					tabs={tabs}
					activeTabId="tab-3"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					showUnreadOnly={false}
				/>
			);

			// scrollTo should have been called when filter was toggled
			expect(scrollToSpy).toHaveBeenCalled();

			rafSpy.mockRestore();
		});
	});

	describe('styling', () => {
		it('applies theme colors correctly', () => {
			const tabs = [createTab({ id: 'tab-1', name: 'Tab 1' })];

			const { container } = render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			const tabBar = container.firstChild as HTMLElement;
			expect(tabBar).toHaveStyle({ backgroundColor: mockTheme.colors.bgSidebar });
			expect(tabBar).toHaveStyle({ borderColor: mockTheme.colors.border });
		});

		it('applies hover effect on inactive tabs', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Tab 1' }),
				createTab({ id: 'tab-2', name: 'Tab 2' }),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			const inactiveTab = screen.getByText('Tab 2').closest('[data-tab-id]')! as HTMLElement;

			// Before hover - check inline style is not hover state
			const initialBgColor = inactiveTab.style.backgroundColor;
			expect(initialBgColor).not.toBe('rgba(255, 255, 255, 0.08)');

			// Hover
			fireEvent.mouseEnter(inactiveTab);
			expect(inactiveTab.style.backgroundColor).toBe('rgba(255, 255, 255, 0.08)');

			// Leave
			fireEvent.mouseLeave(inactiveTab);

			// After the timeout the state is set
			act(() => {
				vi.advanceTimersByTime(150);
			});

			// Background color should no longer be hover state
			expect(inactiveTab.style.backgroundColor).not.toBe('rgba(255, 255, 255, 0.08)');
		});

		it('does not set title attribute on tabs (removed for cleaner UX)', () => {
			// Tab title tooltips were intentionally removed to streamline the tab interaction feel
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'My Tab',
					agentSessionId: 'session-123',
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			const tab = screen.getByText('My Tab').closest('[data-tab-id]')!;
			expect(tab).not.toHaveAttribute('title');
		});
	});

	describe('edge cases', () => {
		it('handles empty tabs array', () => {
			render(
				<TabBar
					tabs={[]}
					activeTabId="nonexistent"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			// Should still render the new tab button
			expect(screen.getByTitle('New tab (Cmd+T)')).toBeInTheDocument();
		});

		it('handles special characters in tab names', () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: '<script>alert("xss")</script>',
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			// Text should be escaped, not executed
			expect(screen.getByText('<script>alert("xss")</script>')).toBeInTheDocument();
		});

		it('handles unicode in tab names', () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: '🎵 Music Tab 日本語',
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			expect(screen.getByText('🎵 Music Tab 日本語')).toBeInTheDocument();
		});

		it('handles very long tab names with truncation for inactive tabs', () => {
			const longName = 'This is a very long tab name that should be truncated';
			const tabs = [
				createTab({ id: 'tab-1', name: 'Active Tab' }),
				createTab({ id: 'tab-2', name: longName }),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			// Inactive tab should be truncated
			const inactiveTabName = screen.getByText(longName);
			expect(inactiveTabName).toHaveClass('truncate');
			expect(inactiveTabName).toHaveClass('max-w-[120px]');

			// Active tab should show full name without truncation
			const activeTabName = screen.getByText('Active Tab');
			expect(activeTabName).toHaveClass('whitespace-nowrap');
			expect(activeTabName).not.toHaveClass('truncate');
		});

		it('handles many tabs', () => {
			const tabs = Array.from({ length: 50 }, (_, i) =>
				createTab({ id: `tab-${i}`, name: `Tab ${i + 1}` })
			);

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-0"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			expect(screen.getByText('Tab 1')).toBeInTheDocument();
			expect(screen.getByText('Tab 50')).toBeInTheDocument();
		});

		it('handles whitespace-only inputValue (no draft indicator)', () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'Tab 1',
					inputValue: '   ', // whitespace only
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			expect(screen.queryByTitle('Has draft message')).not.toBeInTheDocument();
		});

		it('handles empty stagedImages array (no draft indicator)', () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'Tab 1',
					stagedImages: [],
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			expect(screen.queryByTitle('Has draft message')).not.toBeInTheDocument();
		});

		it('handles rapid tab selection', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Tab 1' }),
				createTab({ id: 'tab-2', name: 'Tab 2' }),
				createTab({ id: 'tab-3', name: 'Tab 3' }),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			fireEvent.click(screen.getByText('Tab 2'));
			fireEvent.click(screen.getByText('Tab 3'));
			fireEvent.click(screen.getByText('Tab 1'));

			expect(mockOnTabSelect).toHaveBeenCalledTimes(3);
			expect(mockOnTabSelect).toHaveBeenNthCalledWith(1, 'tab-2');
			expect(mockOnTabSelect).toHaveBeenNthCalledWith(2, 'tab-3');
			expect(mockOnTabSelect).toHaveBeenNthCalledWith(3, 'tab-1');
		});
	});

	describe('overflow detection', () => {
		it('makes new tab button sticky when tabs overflow', () => {
			// Mock scrollWidth > clientWidth
			const originalRef = React.useRef;
			vi.spyOn(React, 'useRef').mockImplementation((initial) => {
				const ref = originalRef(initial);
				if (ref.current === null) {
					Object.defineProperty(ref, 'current', {
						get: () => ({
							scrollWidth: 1000,
							clientWidth: 500,
							querySelector: vi.fn().mockReturnValue({
								offsetLeft: 100,
								offsetWidth: 80,
							}),
							scrollTo: vi.fn(),
						}),
						set: () => {},
					});
				}
				return ref;
			});

			const tabs = Array.from({ length: 20 }, (_, i) =>
				createTab({ id: `tab-${i}`, name: `Tab ${i + 1}` })
			);

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-0"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			// Wait for overflow check
			act(() => {
				vi.advanceTimersByTime(100);
			});

			vi.restoreAllMocks();
		});
	});

	describe('tab hover overlay menu (tab move operations)', () => {
		it('shows "Move to First Position" for non-first tabs', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Tab 1', agentSessionId: 'session-1' }),
				createTab({ id: 'tab-2', name: 'Tab 2', agentSessionId: 'session-2' }),
				createTab({ id: 'tab-3', name: 'Tab 3', agentSessionId: 'session-3' }),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-2"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onTabReorder={mockOnTabReorder}
				/>
			);

			const tab = screen.getByText('Tab 2').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			act(() => {
				vi.advanceTimersByTime(450);
			});

			expect(screen.getByText('Move to First Position')).toBeInTheDocument();
			expect(screen.getByText('Move to Last Position')).toBeInTheDocument();
		});

		it('hides "Move to First Position" when hovering first tab', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Tab 1', agentSessionId: 'session-1' }),
				createTab({ id: 'tab-2', name: 'Tab 2', agentSessionId: 'session-2' }),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onTabReorder={mockOnTabReorder}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			act(() => {
				vi.advanceTimersByTime(450);
			});

			// Move to First Position is hidden on first tab
			expect(screen.queryByText('Move to First Position')).not.toBeInTheDocument();
			// Move to Last Position is shown
			expect(screen.getByText('Move to Last Position')).toBeInTheDocument();
		});

		it('hides "Move to Last Position" when hovering last tab', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Tab 1', agentSessionId: 'session-1' }),
				createTab({ id: 'tab-2', name: 'Tab 2', agentSessionId: 'session-2' }),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onTabReorder={mockOnTabReorder}
				/>
			);

			const tab = screen.getByText('Tab 2').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			act(() => {
				vi.advanceTimersByTime(450);
			});

			// Move to Last Position is hidden on last tab
			expect(screen.queryByText('Move to Last Position')).not.toBeInTheDocument();
			// Move to First Position is shown
			expect(screen.getByText('Move to First Position')).toBeInTheDocument();
		});

		it('hides both move options when only one tab exists', () => {
			const tabs = [createTab({ id: 'tab-1', name: 'Tab 1', agentSessionId: 'session-1' })];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onTabReorder={mockOnTabReorder}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			act(() => {
				vi.advanceTimersByTime(450);
			});

			// Both move options are hidden when only one tab exists
			expect(screen.queryByText('Move to First Position')).not.toBeInTheDocument();
			expect(screen.queryByText('Move to Last Position')).not.toBeInTheDocument();
		});

		it('calls onTabReorder when "Move to First Position" is clicked', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Tab 1', agentSessionId: 'session-1' }),
				createTab({ id: 'tab-2', name: 'Tab 2', agentSessionId: 'session-2' }),
				createTab({ id: 'tab-3', name: 'Tab 3', agentSessionId: 'session-3' }),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-2"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onTabReorder={mockOnTabReorder}
				/>
			);

			const tab = screen.getByText('Tab 3').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			act(() => {
				vi.advanceTimersByTime(450);
			});

			fireEvent.click(screen.getByText('Move to First Position'));

			// Should reorder from index 2 to index 0
			expect(mockOnTabReorder).toHaveBeenCalledWith(2, 0);
		});

		it('calls onTabReorder when "Move to Last Position" is clicked', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Tab 1', agentSessionId: 'session-1' }),
				createTab({ id: 'tab-2', name: 'Tab 2', agentSessionId: 'session-2' }),
				createTab({ id: 'tab-3', name: 'Tab 3', agentSessionId: 'session-3' }),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-2"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onTabReorder={mockOnTabReorder}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			act(() => {
				vi.advanceTimersByTime(450);
			});

			fireEvent.click(screen.getByText('Move to Last Position'));

			// Should reorder from index 0 to index 2
			expect(mockOnTabReorder).toHaveBeenCalledWith(0, 2);
		});

		it('does not show move options when onTabReorder is not provided', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Tab 1', agentSessionId: 'session-1' }),
				createTab({ id: 'tab-2', name: 'Tab 2', agentSessionId: 'session-2' }),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					// onTabReorder not provided
				/>
			);

			const tab = screen.getByText('Tab 2').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			act(() => {
				vi.advanceTimersByTime(450);
			});

			// Move options should not be shown without onTabReorder
			expect(screen.queryByText('Move to First Position')).not.toBeInTheDocument();
			expect(screen.queryByText('Move to Last Position')).not.toBeInTheDocument();
		});

		it('closes overlay menu after move action', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Tab 1', agentSessionId: 'session-1' }),
				createTab({ id: 'tab-2', name: 'Tab 2', agentSessionId: 'session-2' }),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onTabReorder={mockOnTabReorder}
				/>
			);

			const tab = screen.getByText('Tab 2').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			act(() => {
				vi.advanceTimersByTime(450);
			});

			expect(screen.getByText('Move to First Position')).toBeInTheDocument();

			fireEvent.click(screen.getByText('Move to First Position'));

			// Overlay should be closed after clicking Move
			expect(screen.queryByText('Move to First Position')).not.toBeInTheDocument();
		});

		it('renders ChevronsLeft icon for Move to First Position', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Tab 1', agentSessionId: 'session-1' }),
				createTab({ id: 'tab-2', name: 'Tab 2', agentSessionId: 'session-2' }),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onTabReorder={mockOnTabReorder}
				/>
			);

			const tab = screen.getByText('Tab 2').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			act(() => {
				vi.advanceTimersByTime(450);
			});

			expect(screen.getByTestId('chevrons-left-icon')).toBeInTheDocument();
		});

		it('renders ChevronsRight icon for Move to Last Position', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Tab 1', agentSessionId: 'session-1' }),
				createTab({ id: 'tab-2', name: 'Tab 2', agentSessionId: 'session-2' }),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onTabReorder={mockOnTabReorder}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			act(() => {
				vi.advanceTimersByTime(450);
			});

			expect(screen.getByTestId('chevrons-right-icon')).toBeInTheDocument();
		});

		it('handles overlay menu on different tabs with proper move options', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Tab 1', agentSessionId: 'session-1' }),
				createTab({ id: 'tab-2', name: 'Tab 2', agentSessionId: 'session-2' }),
				createTab({ id: 'tab-3', name: 'Tab 3', agentSessionId: 'session-3' }),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onTabReorder={mockOnTabReorder}
				/>
			);

			// Open overlay menu on Tab 1 (first tab)
			const tab1 = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab1);

			act(() => {
				vi.advanceTimersByTime(450);
			});

			// Move to First Position is hidden on first tab
			expect(screen.queryByText('Move to First Position')).not.toBeInTheDocument();
			// Move to Last Position is shown on first tab
			expect(screen.getByText('Move to Last Position')).toBeInTheDocument();

			// Close menu by hovering away
			fireEvent.mouseLeave(tab1);

			// Open overlay menu on Tab 3 (last tab)
			const tab3 = screen.getByText('Tab 3').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab3);

			act(() => {
				vi.advanceTimersByTime(450);
			});

			// Move to Last Position is hidden on last tab
			expect(screen.queryByText('Move to Last Position')).not.toBeInTheDocument();
			// Move to First Position is shown on last tab
			expect(screen.getByText('Move to First Position')).toBeInTheDocument();
		});

		it('overlay menu works with many tabs', () => {
			const tabs = Array.from({ length: 20 }, (_, i) =>
				createTab({ id: `tab-${i}`, name: `Tab ${i + 1}`, agentSessionId: `session-${i}` })
			);

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-10"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onTabReorder={mockOnTabReorder}
				/>
			);

			const tab = screen.getByText('Tab 11').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			act(() => {
				vi.advanceTimersByTime(450);
			});

			// Middle tab should show both move options
			expect(screen.getByText('Move to First Position')).toBeInTheDocument();
			expect(screen.getByText('Move to Last Position')).toBeInTheDocument();
		});
	});

	describe('Send to Agent', () => {
		const mockOnSendToAgent = vi.fn();

		beforeEach(() => {
			mockOnSendToAgent.mockClear();
		});

		it('shows Send to Agent button in hover overlay when onSendToAgent is provided', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'Tab 1',
					agentSessionId: 'abc123-def456',
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onSendToAgent={mockOnSendToAgent}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			// Advance timers past the 400ms delay
			act(() => {
				vi.advanceTimersByTime(450);
			});

			// Send to Agent button should be visible
			expect(screen.getByText('Context: Send to Agent')).toBeInTheDocument();
		});

		it('does not show Send to Agent button when onSendToAgent is not provided', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'Tab 1',
					agentSessionId: 'abc123-def456',
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			act(() => {
				vi.advanceTimersByTime(450);
			});

			// Send to Agent button should NOT be visible
			expect(screen.queryByText('Context: Send to Agent')).not.toBeInTheDocument();
		});

		it('does not show Send to Agent button for tabs without agentSessionId', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: '',
					agentSessionId: undefined,
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onSendToAgent={mockOnSendToAgent}
				/>
			);

			const tab = screen.getByText('New Session').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			act(() => {
				vi.advanceTimersByTime(500);
			});

			// Overlay shouldn't be shown for tabs without agentSessionId
			expect(screen.queryByText('Context: Send to Agent')).not.toBeInTheDocument();
		});

		it('calls onSendToAgent with tab id when Send to Agent button is clicked', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'Tab 1',
					agentSessionId: 'abc123-def456',
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onSendToAgent={mockOnSendToAgent}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			act(() => {
				vi.advanceTimersByTime(450);
			});

			const sendToAgentButton = screen.getByText('Context: Send to Agent');
			fireEvent.click(sendToAgentButton);

			expect(mockOnSendToAgent).toHaveBeenCalledWith('tab-1');
			expect(mockOnSendToAgent).toHaveBeenCalledTimes(1);
		});

		it('closes overlay after clicking Send to Agent', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'Tab 1',
					agentSessionId: 'abc123-def456',
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onSendToAgent={mockOnSendToAgent}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			act(() => {
				vi.advanceTimersByTime(450);
			});

			// Click Send to Agent
			const sendToAgentButton = screen.getByText('Context: Send to Agent');
			fireEvent.click(sendToAgentButton);

			// Overlay should be closed
			expect(screen.queryByText('Context: Send to Agent')).not.toBeInTheDocument();
		});

		it('renders ArrowRightCircle icon for Send to Agent button', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'Tab 1',
					agentSessionId: 'abc123-def456',
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onSendToAgent={mockOnSendToAgent}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			act(() => {
				vi.advanceTimersByTime(450);
			});

			// The ArrowRightCircle icon should be present
			expect(screen.getByTestId('arrow-right-circle-icon')).toBeInTheDocument();
		});
	});

	describe('Publish as GitHub Gist', () => {
		const mockOnPublishGist = vi.fn();

		beforeEach(() => {
			mockOnPublishGist.mockClear();
		});

		it('shows Publish as GitHub Gist button when onPublishGist and ghCliAvailable are provided and tab has logs', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'Tab 1',
					agentSessionId: 'abc123-def456',
					logs: [{ id: '1', timestamp: Date.now(), source: 'user', text: 'Hello' }],
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onPublishGist={mockOnPublishGist}
					ghCliAvailable={true}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			act(() => {
				vi.advanceTimersByTime(450);
			});

			expect(screen.getByText('Context: Publish as GitHub Gist')).toBeInTheDocument();
		});

		it('does not show Publish as GitHub Gist button when ghCliAvailable is false', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'Tab 1',
					agentSessionId: 'abc123-def456',
					logs: [{ id: '1', timestamp: Date.now(), source: 'user', text: 'Hello' }],
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onPublishGist={mockOnPublishGist}
					ghCliAvailable={false}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			act(() => {
				vi.advanceTimersByTime(450);
			});

			expect(screen.queryByText('Context: Publish as GitHub Gist')).not.toBeInTheDocument();
		});

		it('does not show Publish as GitHub Gist button when tab has no logs', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'Tab 1',
					agentSessionId: 'abc123-def456',
					logs: [],
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onPublishGist={mockOnPublishGist}
					ghCliAvailable={true}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			act(() => {
				vi.advanceTimersByTime(450);
			});

			expect(screen.queryByText('Context: Publish as GitHub Gist')).not.toBeInTheDocument();
		});

		it('calls onPublishGist with tab id when clicked', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'Tab 1',
					agentSessionId: 'abc123-def456',
					logs: [{ id: '1', timestamp: Date.now(), source: 'user', text: 'Hello' }],
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onPublishGist={mockOnPublishGist}
					ghCliAvailable={true}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			act(() => {
				vi.advanceTimersByTime(450);
			});

			const publishGistButton = screen.getByText('Context: Publish as GitHub Gist');
			fireEvent.click(publishGistButton);

			expect(mockOnPublishGist).toHaveBeenCalledWith('tab-1');
			expect(mockOnPublishGist).toHaveBeenCalledTimes(1);
		});

		it('closes overlay after clicking Publish as GitHub Gist', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'Tab 1',
					agentSessionId: 'abc123-def456',
					logs: [{ id: '1', timestamp: Date.now(), source: 'user', text: 'Hello' }],
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onPublishGist={mockOnPublishGist}
					ghCliAvailable={true}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			act(() => {
				vi.advanceTimersByTime(450);
			});

			const publishGistButton = screen.getByText('Context: Publish as GitHub Gist');
			fireEvent.click(publishGistButton);

			expect(screen.queryByText('Context: Publish as GitHub Gist')).not.toBeInTheDocument();
		});

		it('renders Share2 icon for Publish as GitHub Gist button', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'Tab 1',
					agentSessionId: 'abc123-def456',
					logs: [{ id: '1', timestamp: Date.now(), source: 'user', text: 'Hello' }],
				}),
			];

			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					onPublishGist={mockOnPublishGist}
					ghCliAvailable={true}
				/>
			);

			const tab = screen.getByText('Tab 1').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			act(() => {
				vi.advanceTimersByTime(450);
			});

			expect(screen.getByTestId('share2-icon')).toBeInTheDocument();
		});
	});
});
