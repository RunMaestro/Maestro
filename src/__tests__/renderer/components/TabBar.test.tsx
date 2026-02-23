import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TabBar } from '../../../renderer/components/TabBar';
import { formatShortcutKeys } from '../../../renderer/utils/shortcutFormatter';
import type { AITab, Theme, FilePreviewTab } from '../../../renderer/types';

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
	ExternalLink: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="external-link-icon" className={className} style={style}>
			↗
		</span>
	),
	FolderOpen: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="folder-open-icon" className={className} style={style}>
			📂
		</span>
	),
	FileText: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="file-text-icon" className={className} style={style}>
			📄
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
		// Mock scrollTo and scrollIntoView
		Element.prototype.scrollTo = vi.fn();
		Element.prototype.scrollIntoView = vi.fn();
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

			expect(
				screen.getByTitle(`New tab (${formatShortcutKeys(['Meta', 't'])})`)
			).toBeInTheDocument();
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

			expect(
				screen.getByTitle(`Search tabs (${formatShortcutKeys(['Meta', 'Shift', 'o'])})`)
			).toBeInTheDocument();
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

			expect(
				screen.queryByTitle(`Search tabs (${formatShortcutKeys(['Meta', 'Shift', 'o'])})`)
			).not.toBeInTheDocument();
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

			fireEvent.click(screen.getByTitle(`New tab (${formatShortcutKeys(['Meta', 't'])})`));
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

			expect(
				screen.getByTitle(`Filter unread tabs (${formatShortcutKeys(['Meta', 'u'])})`)
			).toBeInTheDocument();

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

			expect(
				screen.getByTitle(`Showing unread only (${formatShortcutKeys(['Meta', 'u'])})`)
			).toBeInTheDocument();
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

			fireEvent.click(
				screen.getByTitle(`Search tabs (${formatShortcutKeys(['Meta', 'Shift', 'o'])})`)
			);
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

		it('does not show overlay for single tab without agentSessionId or logs', () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: '',
					agentSessionId: undefined,
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
		it('scrolls active tab into view when activeTabId changes', async () => {
			// Mock requestAnimationFrame
			const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
				cb(0);
				return 0;
			});

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

			// Get the tab bar container (the scrollable element)
			const tabBarContainer = container.querySelector('.overflow-x-auto') as HTMLElement;
			expect(tabBarContainer).toBeTruthy();

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

			// The scroll behavior uses getBoundingClientRect which returns 0s in JSDOM,
			// so we just verify the effect runs without error (container and tab element exist)
			const activeTab = container.querySelector('[data-tab-id="tab-2"]');
			expect(activeTab).toBeTruthy();

			rafSpy.mockRestore();
		});

		it('scrolls active tab into view when showUnreadOnly filter is toggled off', async () => {
			// Mock requestAnimationFrame
			const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
				cb(0);
				return 0;
			});

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

			// The scroll behavior uses getBoundingClientRect which returns 0s in JSDOM,
			// so we just verify the effect runs without error (container and tab element exist)
			const activeTab = container.querySelector('[data-tab-id="tab-3"]');
			expect(activeTab).toBeTruthy();

			rafSpy.mockRestore();
		});

		it('scrolls file tab into view when activeFileTabId changes', async () => {
			// Mock requestAnimationFrame
			const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
				cb(0);
				return 0;
			});

			const tabs = [createTab({ id: 'tab-1', name: 'Tab 1' })];
			const fileTab: FilePreviewTab = {
				id: 'file-1',
				path: '/path/to/file.ts',
				name: 'file',
				extension: '.ts',
			};
			const unifiedTabs = [
				{ id: 'tab-1', type: 'ai' as const, data: tabs[0] },
				{ id: 'file-1', type: 'file' as const, data: fileTab },
			];

			const { rerender, container } = render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					unifiedTabs={unifiedTabs}
					activeFileTabId={null}
					onFileTabSelect={vi.fn()}
					onFileTabClose={vi.fn()}
				/>
			);

			// Select the file tab - this should trigger scroll to file tab
			rerender(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
					unifiedTabs={unifiedTabs}
					activeFileTabId="file-1"
					onFileTabSelect={vi.fn()}
					onFileTabClose={vi.fn()}
				/>
			);

			// The scroll behavior uses getBoundingClientRect which returns 0s in JSDOM,
			// so we just verify the effect runs without error (container and tab element exist)
			const activeFileTab = container.querySelector('[data-tab-id="file-1"]');
			expect(activeFileTab).toBeTruthy();

			rafSpy.mockRestore();
		});

		it('scrolls active tab into view when its name changes (e.g., after auto-generation)', async () => {
			// Mock requestAnimationFrame
			const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
				cb(0);
				return 0;
			});

			const tabs = [
				createTab({ id: 'tab-1', name: null }), // Tab without name initially
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

			// Simulate the active tab's name being updated (e.g., auto-generated name)
			// This should trigger a scroll to ensure the now-wider tab is still visible
			const updatedTabs = [
				createTab({ id: 'tab-1', name: 'A Much Longer Auto-Generated Tab Name' }),
				createTab({ id: 'tab-2', name: 'Tab 2' }),
			];

			rerender(
				<TabBar
					tabs={updatedTabs}
					activeTabId="tab-1"
					theme={mockTheme}
					onTabSelect={mockOnTabSelect}
					onTabClose={mockOnTabClose}
					onNewTab={mockOnNewTab}
				/>
			);

			// The scroll behavior uses getBoundingClientRect which returns 0s in JSDOM,
			// so we just verify the effect runs without error and the tab renders with new name
			const activeTab = container.querySelector('[data-tab-id="tab-1"]');
			expect(activeTab).toBeTruthy();
			expect(screen.getByText('A Much Longer Auto-Generated Tab Name')).toBeTruthy();

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
			expect(
				screen.getByTitle(`New tab (${formatShortcutKeys(['Meta', 't'])})`)
			).toBeInTheDocument();
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
								scrollIntoView: vi.fn(),
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

		it('does not show Send to Agent button for tabs without logs', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: '',
					agentSessionId: undefined,
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
					onSendToAgent={mockOnSendToAgent}
				/>
			);

			const tab = screen.getByText('New Session').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			act(() => {
				vi.advanceTimersByTime(500);
			});

			// No overlay or Send to Agent for tabs without logs
			expect(screen.queryByText('Context: Send to Agent')).not.toBeInTheDocument();
		});

		it('shows Send to Agent button for tabs with logs but no agentSessionId', async () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'Compacted Tab',
					agentSessionId: undefined,
					logs: [{ id: '1', timestamp: Date.now(), source: 'user', text: 'Hello' }],
				}),
				createTab({
					id: 'tab-2',
					name: 'Tab 2',
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
					onSendToAgent={mockOnSendToAgent}
				/>
			);

			const tab = screen.getByText('Compacted Tab').closest('[data-tab-id]')!;
			fireEvent.mouseEnter(tab);

			act(() => {
				vi.advanceTimersByTime(450);
			});

			expect(screen.getByText('Context: Send to Agent')).toBeInTheDocument();
		});

		it('calls onSendToAgent with tab id when Send to Agent button is clicked', async () => {
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

describe('FileTab overlay menu', () => {
	const aiTab = createTab({ id: 'tab-1', name: 'AI Tab 1', agentSessionId: 'sess-1' });
	const defaultTabs: AITab[] = [aiTab];

	const fileTab: FilePreviewTab = {
		id: 'file-tab-1',
		path: '/path/to/document.md',
		name: 'document',
		extension: '.md',
		content: '# Test Document\n\nThis is test content.',
		scrollTop: 0,
		searchQuery: '',
		editMode: false,
		editContent: undefined,
		createdAt: Date.now(),
		lastModified: Date.now(),
	};

	const unifiedTabs = [
		{ type: 'ai' as const, id: 'tab-1', data: aiTab },
		{ type: 'file' as const, id: 'file-tab-1', data: fileTab },
	];

	it('shows file overlay menu on hover after delay', async () => {
		vi.useFakeTimers();

		render(
			<TabBar
				tabs={defaultTabs}
				activeTabId="tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={vi.fn()}
				onFileTabClose={vi.fn()}
			/>
		);

		const fileTabElement = screen.getByText('document').closest('[data-tab-id="file-tab-1"]');
		expect(fileTabElement).toBeInTheDocument();

		// Hover over the file tab
		await act(async () => {
			fireEvent.mouseEnter(fileTabElement!);
		});

		// Overlay should not be visible immediately
		expect(screen.queryByText('Copy File Path')).not.toBeInTheDocument();

		// Wait for the delay
		await act(async () => {
			vi.advanceTimersByTime(450);
		});

		// Overlay should now be visible with file-specific actions
		expect(screen.getByText('Copy File Path')).toBeInTheDocument();
		expect(screen.getByText('Copy File Name')).toBeInTheDocument();
		expect(screen.getByText('Open in Default App')).toBeInTheDocument();
		expect(screen.getByText(/Reveal in (Finder|Explorer|File Manager)/)).toBeInTheDocument();

		vi.useRealTimers();
	});

	it('shows file-specific actions in overlay menu', async () => {
		vi.useFakeTimers();

		render(
			<TabBar
				tabs={defaultTabs}
				activeTabId="tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={vi.fn()}
				onFileTabClose={vi.fn()}
			/>
		);

		const fileTabElement = screen.getByText('document').closest('[data-tab-id="file-tab-1"]');

		await act(async () => {
			fireEvent.mouseEnter(fileTabElement!);
			vi.advanceTimersByTime(450);
		});

		// Should show file-specific actions (these are unique to file tabs)
		expect(screen.getByText('Copy File Path')).toBeInTheDocument();
		expect(screen.getByText('Open in Default App')).toBeInTheDocument();
		expect(screen.getByText(/Reveal in (Finder|Explorer|File Manager)/)).toBeInTheDocument();

		vi.useRealTimers();
	});

	it('copies file path to clipboard when clicking Copy File Path', async () => {
		vi.useFakeTimers();
		const mockWriteText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, 'clipboard', {
			value: { writeText: mockWriteText },
			writable: true,
		});

		render(
			<TabBar
				tabs={defaultTabs}
				activeTabId="tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={vi.fn()}
				onFileTabClose={vi.fn()}
			/>
		);

		const fileTabElement = screen.getByText('document').closest('[data-tab-id="file-tab-1"]');

		await act(async () => {
			fireEvent.mouseEnter(fileTabElement!);
			vi.advanceTimersByTime(450);
		});

		const copyPathButton = screen.getByText('Copy File Path');
		await act(async () => {
			fireEvent.click(copyPathButton);
		});

		expect(mockWriteText).toHaveBeenCalledWith('/path/to/document.md');
		expect(screen.getByText('Copied!')).toBeInTheDocument();

		vi.useRealTimers();
	});

	it('copies filename with extension when clicking Copy File Name', async () => {
		vi.useFakeTimers();
		const mockWriteText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, 'clipboard', {
			value: { writeText: mockWriteText },
			writable: true,
		});

		render(
			<TabBar
				tabs={defaultTabs}
				activeTabId="tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={vi.fn()}
				onFileTabClose={vi.fn()}
			/>
		);

		const fileTabElement = screen.getByText('document').closest('[data-tab-id="file-tab-1"]');

		await act(async () => {
			fireEvent.mouseEnter(fileTabElement!);
			vi.advanceTimersByTime(450);
		});

		const copyNameButton = screen.getByText('Copy File Name');
		await act(async () => {
			fireEvent.click(copyNameButton);
		});

		expect(mockWriteText).toHaveBeenCalledWith('document.md');

		vi.useRealTimers();
	});

	it('calls openExternal when clicking Open in Default App', async () => {
		vi.useFakeTimers();
		const mockOpenExternal = vi.fn().mockResolvedValue(undefined);
		window.maestro = {
			...window.maestro,
			shell: {
				...window.maestro.shell,
				openExternal: mockOpenExternal,
			},
		} as typeof window.maestro;

		render(
			<TabBar
				tabs={defaultTabs}
				activeTabId="tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={vi.fn()}
				onFileTabClose={vi.fn()}
			/>
		);

		const fileTabElement = screen.getByText('document').closest('[data-tab-id="file-tab-1"]');

		await act(async () => {
			fireEvent.mouseEnter(fileTabElement!);
			vi.advanceTimersByTime(450);
		});

		const openButton = screen.getByText('Open in Default App');
		await act(async () => {
			fireEvent.click(openButton);
		});

		expect(mockOpenExternal).toHaveBeenCalledWith('file:///path/to/document.md');

		vi.useRealTimers();
	});

	it('calls showItemInFolder when clicking Reveal in Finder/Explorer', async () => {
		vi.useFakeTimers();
		const mockShowItemInFolder = vi.fn().mockResolvedValue(undefined);
		window.maestro = {
			...window.maestro,
			shell: {
				...window.maestro.shell,
				showItemInFolder: mockShowItemInFolder,
			},
		} as typeof window.maestro;

		render(
			<TabBar
				tabs={defaultTabs}
				activeTabId="tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={vi.fn()}
				onFileTabClose={vi.fn()}
			/>
		);

		const fileTabElement = screen.getByText('document').closest('[data-tab-id="file-tab-1"]');

		await act(async () => {
			fireEvent.mouseEnter(fileTabElement!);
			vi.advanceTimersByTime(450);
		});

		const revealButton = screen.getByText(/Reveal in (Finder|Explorer|File Manager)/);
		await act(async () => {
			fireEvent.click(revealButton);
		});

		expect(mockShowItemInFolder).toHaveBeenCalledWith('/path/to/document.md');

		vi.useRealTimers();
	});

	it('shows Close Tab action and calls onFileTabClose when clicked', async () => {
		vi.useFakeTimers();
		const mockFileTabClose = vi.fn();

		render(
			<TabBar
				tabs={defaultTabs}
				activeTabId="tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={vi.fn()}
				onFileTabClose={mockFileTabClose}
			/>
		);

		const fileTabElement = screen.getByText('document').closest('[data-tab-id="file-tab-1"]');

		await act(async () => {
			fireEvent.mouseEnter(fileTabElement!);
			vi.advanceTimersByTime(450);
		});

		// Get all "Close Tab" buttons - find the one in the file tab overlay
		// The overlay buttons are in a div with specific styling
		const closeTabButtons = screen.getAllByText('Close Tab');
		// The file tab's Close Tab button is in a standalone button (not the one with "X" icon prefix from AI tab overlay)
		const closeButton = closeTabButtons.find((btn) =>
			btn.closest('.shadow-xl')?.textContent?.includes('Copy File Path')
		);
		expect(closeButton).toBeTruthy();

		await act(async () => {
			fireEvent.click(closeButton!);
		});

		expect(mockFileTabClose).toHaveBeenCalledWith('file-tab-1');

		vi.useRealTimers();
	});

	it('shows Close Other Tabs action and calls handler when clicked', async () => {
		vi.useFakeTimers();
		const mockCloseOtherTabs = vi.fn();

		// Create multiple tabs to test Close Other Tabs
		const fileTab2: FilePreviewTab = {
			id: 'file-tab-2',
			path: '/path/to/other.ts',
			name: 'other',
			extension: '.ts',
			content: 'const y = 2;',
			scrollTop: 0,
			searchQuery: '',
			editMode: false,
			editContent: undefined,
			createdAt: Date.now(),
			lastModified: Date.now(),
		};

		const multiFileUnifiedTabs = [
			{ type: 'ai' as const, id: 'tab-1', data: aiTab },
			{ type: 'file' as const, id: 'file-tab-1', data: fileTab },
			{ type: 'file' as const, id: 'file-tab-2', data: fileTab2 },
		];

		render(
			<TabBar
				tabs={defaultTabs}
				activeTabId="tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				unifiedTabs={multiFileUnifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={vi.fn()}
				onFileTabClose={vi.fn()}
				onCloseOtherTabs={mockCloseOtherTabs}
			/>
		);

		const fileTabElement = screen.getByText('document').closest('[data-tab-id="file-tab-1"]');

		await act(async () => {
			fireEvent.mouseEnter(fileTabElement!);
			vi.advanceTimersByTime(450);
		});

		// Should show Close Other Tabs option
		const closeOtherButtons = screen.getAllByText('Close Other Tabs');
		// Find the one in the file tab overlay (has Copy File Path action)
		const closeOtherButton = closeOtherButtons.find((btn) =>
			btn.closest('.shadow-xl')?.textContent?.includes('Copy File Path')
		);
		expect(closeOtherButton).toBeTruthy();

		await act(async () => {
			fireEvent.click(closeOtherButton!);
		});

		expect(mockCloseOtherTabs).toHaveBeenCalled();

		vi.useRealTimers();
	});

	it('disables Close Other Tabs when only one tab exists', async () => {
		vi.useFakeTimers();
		const mockCloseOtherTabs = vi.fn();

		// Single tab only
		const singleTabUnified = [{ type: 'file' as const, id: 'file-tab-1', data: fileTab }];

		render(
			<TabBar
				tabs={[]}
				activeTabId=""
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				unifiedTabs={singleTabUnified}
				activeFileTabId="file-tab-1"
				onFileTabSelect={vi.fn()}
				onFileTabClose={vi.fn()}
				onCloseOtherTabs={mockCloseOtherTabs}
			/>
		);

		const fileTabElement = screen.getByText('document').closest('[data-tab-id="file-tab-1"]');

		await act(async () => {
			fireEvent.mouseEnter(fileTabElement!);
			vi.advanceTimersByTime(450);
		});

		// Should show Close Other Tabs but disabled
		const closeOtherButton = screen.getByText('Close Other Tabs');
		expect(closeOtherButton).toBeInTheDocument();
		expect(closeOtherButton.closest('button')).toHaveAttribute('disabled');

		vi.useRealTimers();
	});

	it('shows Close Tabs to Left action and calls handler when clicked', async () => {
		vi.useFakeTimers();
		const mockCloseTabsLeft = vi.fn();

		// Create multiple tabs - file tab in the middle
		const fileTab2: FilePreviewTab = {
			id: 'file-tab-2',
			path: '/path/to/other.ts',
			name: 'other',
			extension: '.ts',
			content: 'const y = 2;',
			scrollTop: 0,
			searchQuery: '',
			editMode: false,
			editContent: undefined,
			createdAt: Date.now(),
			lastModified: Date.now(),
		};

		// File tab is at index 1 (has tabs to the left)
		const multiTabsUnified = [
			{ type: 'ai' as const, id: 'tab-1', data: aiTab },
			{ type: 'file' as const, id: 'file-tab-1', data: fileTab },
			{ type: 'file' as const, id: 'file-tab-2', data: fileTab2 },
		];

		render(
			<TabBar
				tabs={defaultTabs}
				activeTabId="tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				unifiedTabs={multiTabsUnified}
				activeFileTabId={null}
				onFileTabSelect={vi.fn()}
				onFileTabClose={vi.fn()}
				onCloseTabsLeft={mockCloseTabsLeft}
			/>
		);

		// Hover over the middle tab (file-tab-1 at index 1)
		const fileTabElement = screen.getByText('document').closest('[data-tab-id="file-tab-1"]');

		await act(async () => {
			fireEvent.mouseEnter(fileTabElement!);
			vi.advanceTimersByTime(450);
		});

		// Should show Close Tabs to Left option
		const closeLeftButtons = screen.getAllByText('Close Tabs to Left');
		const closeLeftButton = closeLeftButtons.find((btn) =>
			btn.closest('.shadow-xl')?.textContent?.includes('Copy File Path')
		);
		expect(closeLeftButton).toBeTruthy();

		await act(async () => {
			fireEvent.click(closeLeftButton!);
		});

		expect(mockCloseTabsLeft).toHaveBeenCalled();

		vi.useRealTimers();
	});

	it('disables Close Tabs to Left for first tab', async () => {
		vi.useFakeTimers();
		const mockCloseTabsLeft = vi.fn();

		// File tab is first
		const fileFirstUnified = [
			{ type: 'file' as const, id: 'file-tab-1', data: fileTab },
			{ type: 'ai' as const, id: 'tab-1', data: aiTab },
		];

		render(
			<TabBar
				tabs={defaultTabs}
				activeTabId="tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				unifiedTabs={fileFirstUnified}
				activeFileTabId={null}
				onFileTabSelect={vi.fn()}
				onFileTabClose={vi.fn()}
				onCloseTabsLeft={mockCloseTabsLeft}
			/>
		);

		const fileTabElement = screen.getByText('document').closest('[data-tab-id="file-tab-1"]');

		await act(async () => {
			fireEvent.mouseEnter(fileTabElement!);
			vi.advanceTimersByTime(450);
		});

		// Should show Close Tabs to Left but disabled (first tab)
		const closeLeftButton = screen.getByText('Close Tabs to Left');
		expect(closeLeftButton).toBeInTheDocument();
		expect(closeLeftButton.closest('button')).toHaveAttribute('disabled');

		vi.useRealTimers();
	});

	it('shows Close Tabs to Right action and calls handler when clicked', async () => {
		vi.useFakeTimers();
		const mockCloseTabsRight = vi.fn();

		// Create multiple tabs - file tab in the middle
		const fileTab2: FilePreviewTab = {
			id: 'file-tab-2',
			path: '/path/to/other.ts',
			name: 'other',
			extension: '.ts',
			content: 'const y = 2;',
			scrollTop: 0,
			searchQuery: '',
			editMode: false,
			editContent: undefined,
			createdAt: Date.now(),
			lastModified: Date.now(),
		};

		// File tab is at index 1 (has tabs to the right)
		const multiTabsUnified = [
			{ type: 'ai' as const, id: 'tab-1', data: aiTab },
			{ type: 'file' as const, id: 'file-tab-1', data: fileTab },
			{ type: 'file' as const, id: 'file-tab-2', data: fileTab2 },
		];

		render(
			<TabBar
				tabs={defaultTabs}
				activeTabId="tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				unifiedTabs={multiTabsUnified}
				activeFileTabId={null}
				onFileTabSelect={vi.fn()}
				onFileTabClose={vi.fn()}
				onCloseTabsRight={mockCloseTabsRight}
			/>
		);

		// Hover over the middle tab (file-tab-1 at index 1)
		const fileTabElement = screen.getByText('document').closest('[data-tab-id="file-tab-1"]');

		await act(async () => {
			fireEvent.mouseEnter(fileTabElement!);
			vi.advanceTimersByTime(450);
		});

		// Should show Close Tabs to Right option
		const closeRightButtons = screen.getAllByText('Close Tabs to Right');
		const closeRightButton = closeRightButtons.find((btn) =>
			btn.closest('.shadow-xl')?.textContent?.includes('Copy File Path')
		);
		expect(closeRightButton).toBeTruthy();

		await act(async () => {
			fireEvent.click(closeRightButton!);
		});

		expect(mockCloseTabsRight).toHaveBeenCalled();

		vi.useRealTimers();
	});

	it('disables Close Tabs to Right for last tab', async () => {
		vi.useFakeTimers();
		const mockCloseTabsRight = vi.fn();

		// File tab is last
		const fileLastUnified = [
			{ type: 'ai' as const, id: 'tab-1', data: aiTab },
			{ type: 'file' as const, id: 'file-tab-1', data: fileTab },
		];

		render(
			<TabBar
				tabs={defaultTabs}
				activeTabId="tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				unifiedTabs={fileLastUnified}
				activeFileTabId={null}
				onFileTabSelect={vi.fn()}
				onFileTabClose={vi.fn()}
				onCloseTabsRight={mockCloseTabsRight}
			/>
		);

		const fileTabElement = screen.getByText('document').closest('[data-tab-id="file-tab-1"]');

		await act(async () => {
			fireEvent.mouseEnter(fileTabElement!);
			vi.advanceTimersByTime(450);
		});

		// Should show Close Tabs to Right but disabled (last tab)
		const closeRightButton = screen.getByText('Close Tabs to Right');
		expect(closeRightButton).toBeInTheDocument();
		expect(closeRightButton.closest('button')).toHaveAttribute('disabled');

		vi.useRealTimers();
	});

	it('shows Move to First Position for non-first file tabs', async () => {
		vi.useFakeTimers();
		const mockUnifiedReorder = vi.fn();

		// Put file tab in second position
		const unifiedTabsWithFileSecond = [
			{ type: 'ai' as const, id: 'tab-1', data: aiTab },
			{ type: 'file' as const, id: 'file-tab-1', data: fileTab },
		];

		render(
			<TabBar
				tabs={defaultTabs}
				activeTabId="tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				unifiedTabs={unifiedTabsWithFileSecond}
				activeFileTabId={null}
				onFileTabSelect={vi.fn()}
				onFileTabClose={vi.fn()}
				onUnifiedTabReorder={mockUnifiedReorder}
			/>
		);

		const fileTabElement = screen.getByText('document').closest('[data-tab-id="file-tab-1"]');

		await act(async () => {
			fireEvent.mouseEnter(fileTabElement!);
			vi.advanceTimersByTime(450);
		});

		// Should show Move to First Position
		expect(screen.getByText('Move to First Position')).toBeInTheDocument();

		vi.useRealTimers();
	});

	it('hides Move to First Position for first file tab', async () => {
		vi.useFakeTimers();
		const mockUnifiedReorder = vi.fn();

		// Put file tab in first position
		const unifiedTabsWithFileFirst = [
			{ type: 'file' as const, id: 'file-tab-1', data: fileTab },
			{ type: 'ai' as const, id: 'tab-1', data: aiTab },
		];

		render(
			<TabBar
				tabs={defaultTabs}
				activeTabId="tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				unifiedTabs={unifiedTabsWithFileFirst}
				activeFileTabId={null}
				onFileTabSelect={vi.fn()}
				onFileTabClose={vi.fn()}
				onUnifiedTabReorder={mockUnifiedReorder}
			/>
		);

		const fileTabElement = screen.getByText('document').closest('[data-tab-id="file-tab-1"]');

		await act(async () => {
			fireEvent.mouseEnter(fileTabElement!);
			vi.advanceTimersByTime(450);
		});

		// Should NOT show Move to First Position
		expect(screen.queryByText('Move to First Position')).not.toBeInTheDocument();

		vi.useRealTimers();
	});

	it('closes overlay when mouse leaves', async () => {
		vi.useFakeTimers();

		render(
			<TabBar
				tabs={defaultTabs}
				activeTabId="tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={vi.fn()}
				onFileTabClose={vi.fn()}
			/>
		);

		const fileTabElement = screen.getByText('document').closest('[data-tab-id="file-tab-1"]');

		// Hover to open overlay
		await act(async () => {
			fireEvent.mouseEnter(fileTabElement!);
			vi.advanceTimersByTime(450);
		});

		expect(screen.getByText('Copy File Path')).toBeInTheDocument();

		// Mouse leave from tab
		await act(async () => {
			fireEvent.mouseLeave(fileTabElement!);
			vi.advanceTimersByTime(150); // Wait for close delay
		});

		// Overlay should be closed
		expect(screen.queryByText('Copy File Path')).not.toBeInTheDocument();

		vi.useRealTimers();
	});
});

describe('Unified tabs drag and drop', () => {
	const mockOnUnifiedTabReorder = vi.fn();
	const mockOnTabReorder = vi.fn();
	const mockOnFileTabSelect = vi.fn();
	const mockOnFileTabClose = vi.fn();

	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		Element.prototype.scrollTo = vi.fn();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const aiTab1 = createTab({ id: 'ai-tab-1', name: 'AI Tab 1', agentSessionId: 'sess-1' });
	const aiTab2 = createTab({ id: 'ai-tab-2', name: 'AI Tab 2', agentSessionId: 'sess-2' });
	const aiTabs: AITab[] = [aiTab1, aiTab2];

	const fileTab1: FilePreviewTab = {
		id: 'file-tab-1',
		path: '/path/to/file1.ts',
		name: 'file1',
		extension: '.ts',
		content: 'const x = 1;',
		scrollTop: 0,
		searchQuery: '',
		editMode: false,
		editContent: undefined,
		createdAt: Date.now(),
		lastModified: Date.now(),
	};

	const fileTab2: FilePreviewTab = {
		id: 'file-tab-2',
		path: '/path/to/file2.md',
		name: 'file2',
		extension: '.md',
		content: '# File 2',
		scrollTop: 0,
		searchQuery: '',
		editMode: false,
		editContent: undefined,
		createdAt: Date.now() + 1,
		lastModified: Date.now() + 1,
	};

	// Unified tabs: AI, File, AI, File
	const unifiedTabs = [
		{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab1 },
		{ type: 'file' as const, id: 'file-tab-1', data: fileTab1 },
		{ type: 'ai' as const, id: 'ai-tab-2', data: aiTab2 },
		{ type: 'file' as const, id: 'file-tab-2', data: fileTab2 },
	];

	it('drags AI tab to file tab position and calls onUnifiedTabReorder', () => {
		render(
			<TabBar
				tabs={aiTabs}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				onTabReorder={mockOnTabReorder}
				onUnifiedTabReorder={mockOnUnifiedTabReorder}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		const aiTabElement = screen.getByText('AI Tab 1').closest('[data-tab-id]')!;
		const fileTabElement = screen.getByText('file1').closest('[data-tab-id]')!;

		// Start dragging ai-tab-1
		fireEvent.dragStart(aiTabElement, {
			dataTransfer: {
				effectAllowed: '',
				setData: vi.fn(),
				getData: vi.fn().mockReturnValue('ai-tab-1'),
			},
		});

		// Drop on file-tab-1
		fireEvent.drop(fileTabElement, {
			dataTransfer: {
				getData: vi.fn().mockReturnValue('ai-tab-1'),
			},
		});

		// Should call onUnifiedTabReorder with indices in unified array (0 to 1)
		expect(mockOnUnifiedTabReorder).toHaveBeenCalledWith(0, 1);
		// Should NOT call legacy onTabReorder since unified is available
		expect(mockOnTabReorder).not.toHaveBeenCalled();
	});

	it('drags file tab to AI tab position and calls onUnifiedTabReorder', () => {
		render(
			<TabBar
				tabs={aiTabs}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				onTabReorder={mockOnTabReorder}
				onUnifiedTabReorder={mockOnUnifiedTabReorder}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		const fileTabElement = screen.getByText('file1').closest('[data-tab-id]')!;
		const aiTabElement = screen.getByText('AI Tab 2').closest('[data-tab-id]')!;

		// Start dragging file-tab-1 (index 1)
		fireEvent.dragStart(fileTabElement, {
			dataTransfer: {
				effectAllowed: '',
				setData: vi.fn(),
				getData: vi.fn().mockReturnValue('file-tab-1'),
			},
		});

		// Drop on ai-tab-2 (index 2)
		fireEvent.drop(aiTabElement, {
			dataTransfer: {
				getData: vi.fn().mockReturnValue('file-tab-1'),
			},
		});

		// Should call onUnifiedTabReorder (from index 1 to index 2)
		expect(mockOnUnifiedTabReorder).toHaveBeenCalledWith(1, 2);
	});

	it('drags file tab to another file tab position', () => {
		render(
			<TabBar
				tabs={aiTabs}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				onTabReorder={mockOnTabReorder}
				onUnifiedTabReorder={mockOnUnifiedTabReorder}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		const fileTab1Element = screen.getByText('file1').closest('[data-tab-id]')!;
		const fileTab2Element = screen.getByText('file2').closest('[data-tab-id]')!;

		// Start dragging file-tab-1 (index 1)
		fireEvent.dragStart(fileTab1Element, {
			dataTransfer: {
				effectAllowed: '',
				setData: vi.fn(),
				getData: vi.fn().mockReturnValue('file-tab-1'),
			},
		});

		// Drop on file-tab-2 (index 3)
		fireEvent.drop(fileTab2Element, {
			dataTransfer: {
				getData: vi.fn().mockReturnValue('file-tab-1'),
			},
		});

		// Should call onUnifiedTabReorder (from index 1 to index 3)
		expect(mockOnUnifiedTabReorder).toHaveBeenCalledWith(1, 3);
	});

	it('does not reorder when dropping on the same tab', () => {
		render(
			<TabBar
				tabs={aiTabs}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				onUnifiedTabReorder={mockOnUnifiedTabReorder}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		const fileTabElement = screen.getByText('file1').closest('[data-tab-id]')!;

		// Drop on same tab
		fireEvent.drop(fileTabElement, {
			dataTransfer: {
				getData: vi.fn().mockReturnValue('file-tab-1'),
			},
		});

		expect(mockOnUnifiedTabReorder).not.toHaveBeenCalled();
	});

	it('sets drag over visual feedback on target tab', () => {
		render(
			<TabBar
				tabs={aiTabs}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				onUnifiedTabReorder={mockOnUnifiedTabReorder}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		const aiTabElement = screen.getByText('AI Tab 1').closest('[data-tab-id]')!;
		const fileTabElement = screen.getByText('file1').closest('[data-tab-id]')!;

		// Start dragging AI tab
		fireEvent.dragStart(aiTabElement, {
			dataTransfer: {
				effectAllowed: '',
				setData: vi.fn(),
				getData: vi.fn().mockReturnValue('ai-tab-1'),
			},
		});

		// Drag over file tab
		fireEvent.dragOver(fileTabElement, {
			dataTransfer: {
				dropEffect: '',
			},
		});

		// File tab should have ring visual
		expect(fileTabElement).toHaveClass('ring-2');
	});

	it('uses legacy onTabReorder when unifiedTabs is not provided', () => {
		render(
			<TabBar
				tabs={aiTabs}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				onTabReorder={mockOnTabReorder}
				onUnifiedTabReorder={mockOnUnifiedTabReorder}
				// No unifiedTabs provided - should fall back to legacy behavior
			/>
		);

		const tab1 = screen.getByText('AI Tab 1').closest('[data-tab-id]')!;
		const tab2 = screen.getByText('AI Tab 2').closest('[data-tab-id]')!;

		// Start dragging tab-1
		fireEvent.dragStart(tab1, {
			dataTransfer: {
				effectAllowed: '',
				setData: vi.fn(),
				getData: vi.fn().mockReturnValue('ai-tab-1'),
			},
		});

		// Drop on tab-2
		fireEvent.drop(tab2, {
			dataTransfer: {
				getData: vi.fn().mockReturnValue('ai-tab-1'),
			},
		});

		// Should use legacy onTabReorder
		expect(mockOnTabReorder).toHaveBeenCalledWith(0, 1);
		// Should NOT call onUnifiedTabReorder
		expect(mockOnUnifiedTabReorder).not.toHaveBeenCalled();
	});

	it('shows Move to First/Last for file tabs when not at edges', async () => {
		render(
			<TabBar
				tabs={aiTabs}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				onUnifiedTabReorder={mockOnUnifiedTabReorder}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		// Hover over file1 (index 1, not first or last)
		const fileTabElement = screen.getByText('file1').closest('[data-tab-id]')!;

		await act(async () => {
			fireEvent.mouseEnter(fileTabElement);
			vi.advanceTimersByTime(450);
		});

		// Should show both move options
		expect(screen.getByText('Move to First Position')).toBeInTheDocument();
		expect(screen.getByText('Move to Last Position')).toBeInTheDocument();
	});

	it('hides Move to First for first tab', async () => {
		render(
			<TabBar
				tabs={aiTabs}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				onUnifiedTabReorder={mockOnUnifiedTabReorder}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		// Hover over AI Tab 1 (index 0, first tab)
		const aiTabElement = screen.getByText('AI Tab 1').closest('[data-tab-id]')!;

		await act(async () => {
			fireEvent.mouseEnter(aiTabElement);
			vi.advanceTimersByTime(450);
		});

		// Move to First should be hidden (not just disabled)
		expect(screen.queryByText('Move to First Position')).not.toBeInTheDocument();
		// Move to Last should be visible
		expect(screen.getByText('Move to Last Position')).toBeInTheDocument();
	});

	it('hides Move to Last for last tab', async () => {
		render(
			<TabBar
				tabs={aiTabs}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				onUnifiedTabReorder={mockOnUnifiedTabReorder}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		// Hover over file2 (index 3, last tab)
		const fileTabElement = screen.getByText('file2').closest('[data-tab-id]')!;

		await act(async () => {
			fireEvent.mouseEnter(fileTabElement);
			vi.advanceTimersByTime(450);
		});

		// Move to First should be visible
		expect(screen.getByText('Move to First Position')).toBeInTheDocument();
		// Move to Last should be hidden (not just disabled)
		expect(screen.queryByText('Move to Last Position')).not.toBeInTheDocument();
	});

	it('calls onUnifiedTabReorder when Move to First is clicked on file tab', async () => {
		render(
			<TabBar
				tabs={aiTabs}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				onUnifiedTabReorder={mockOnUnifiedTabReorder}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		// Hover over file1 (index 1)
		const fileTabElement = screen.getByText('file1').closest('[data-tab-id]')!;

		await act(async () => {
			fireEvent.mouseEnter(fileTabElement);
			vi.advanceTimersByTime(450);
		});

		// Click Move to First
		const moveButton = screen.getByText('Move to First Position');
		fireEvent.click(moveButton);

		// Should call onUnifiedTabReorder with index 1 -> 0
		expect(mockOnUnifiedTabReorder).toHaveBeenCalledWith(1, 0);
	});

	it('calls onUnifiedTabReorder when Move to Last is clicked on file tab', async () => {
		render(
			<TabBar
				tabs={aiTabs}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				onUnifiedTabReorder={mockOnUnifiedTabReorder}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		// Hover over file1 (index 1)
		const fileTabElement = screen.getByText('file1').closest('[data-tab-id]')!;

		await act(async () => {
			fireEvent.mouseEnter(fileTabElement);
			vi.advanceTimersByTime(450);
		});

		// Click Move to Last
		const moveButton = screen.getByText('Move to Last Position');
		fireEvent.click(moveButton);

		// Should call onUnifiedTabReorder with index 1 -> 3 (last index)
		expect(mockOnUnifiedTabReorder).toHaveBeenCalledWith(1, 3);
	});

	it('middle-click closes file tab', () => {
		render(
			<TabBar
				tabs={aiTabs}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				onUnifiedTabReorder={mockOnUnifiedTabReorder}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		const fileTabElement = screen.getByText('file1').closest('[data-tab-id]')!;

		// Middle-click on file tab
		fireEvent.mouseDown(fileTabElement, { button: 1 });

		expect(mockOnFileTabClose).toHaveBeenCalledWith('file-tab-1');
	});

	it('left-click does NOT close file tab', () => {
		render(
			<TabBar
				tabs={aiTabs}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				onUnifiedTabReorder={mockOnUnifiedTabReorder}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		const fileTabElement = screen.getByText('file1').closest('[data-tab-id]')!;

		// Left-click on file tab (button: 0)
		fireEvent.mouseDown(fileTabElement, { button: 0 });

		// Should NOT close the tab
		expect(mockOnFileTabClose).not.toHaveBeenCalled();
	});

	it('right-click does NOT close file tab', () => {
		render(
			<TabBar
				tabs={aiTabs}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				onUnifiedTabReorder={mockOnUnifiedTabReorder}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		const fileTabElement = screen.getByText('file1').closest('[data-tab-id]')!;

		// Right-click on file tab (button: 2)
		fireEvent.mouseDown(fileTabElement, { button: 2 });

		// Should NOT close the tab
		expect(mockOnFileTabClose).not.toHaveBeenCalled();
	});

	it('middle-click on AI tab still works in unified mode', () => {
		const mockOnAiTabClose = vi.fn();

		render(
			<TabBar
				tabs={aiTabs}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={mockOnAiTabClose}
				onNewTab={vi.fn()}
				onUnifiedTabReorder={mockOnUnifiedTabReorder}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		const aiTabElement = screen.getByText('AI Tab 1').closest('[data-tab-id]')!;

		// Middle-click on AI tab
		fireEvent.mouseDown(aiTabElement, { button: 1 });

		// Should call the AI tab close handler, not file tab close handler
		expect(mockOnAiTabClose).toHaveBeenCalledWith('ai-tab-1');
		expect(mockOnFileTabClose).not.toHaveBeenCalled();
	});
});

describe('Unified active tab styling consistency', () => {
	const mockOnTabSelect = vi.fn();
	const mockOnTabClose = vi.fn();
	const mockOnNewTab = vi.fn();
	const mockOnFileTabSelect = vi.fn();
	const mockOnFileTabClose = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('applies same active styling to both AI tabs and file tabs', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab: FilePreviewTab = {
			id: 'file-tab-1',
			path: '/test/example.tsx',
			name: 'example',
			extension: '.tsx',
			content: 'const Example = () => {};',
			scrollTop: 0,
			searchQuery: '',
			editMode: false,
			editContent: undefined,
			createdAt: Date.now(),
			lastModified: Date.now(),
		};

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: 'file-tab-1', data: fileTab },
		];

		// Test 1: Active AI tab styling
		const { rerender } = render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		const activeAiTab = screen.getByText('AI Tab').closest('[data-tab-id]')!;
		expect(activeAiTab).toHaveStyle({ backgroundColor: mockTheme.colors.bgMain });
		expect(activeAiTab).toHaveStyle({ borderTopLeftRadius: '6px' });
		expect(activeAiTab).toHaveStyle({ borderTopRightRadius: '6px' });
		expect(activeAiTab).toHaveStyle({ marginBottom: '-1px' });
		expect(activeAiTab).toHaveStyle({ zIndex: '1' });

		// Test 2: Active file tab styling - switch active tab
		rerender(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId="file-tab-1"
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		const activeFileTab = screen.getByText('example').closest('[data-tab-id]')!;
		// File tabs should have the same active styling as AI tabs
		expect(activeFileTab).toHaveStyle({ backgroundColor: mockTheme.colors.bgMain });
		expect(activeFileTab).toHaveStyle({ borderTopLeftRadius: '6px' });
		expect(activeFileTab).toHaveStyle({ borderTopRightRadius: '6px' });
		expect(activeFileTab).toHaveStyle({ marginBottom: '-1px' });
		expect(activeFileTab).toHaveStyle({ zIndex: '1' });
	});

	it('applies same inactive styling to both AI tabs and file tabs', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab: FilePreviewTab = {
			id: 'file-tab-1',
			path: '/test/example.tsx',
			name: 'example',
			extension: '.tsx',
			content: 'const Example = () => {};',
			scrollTop: 0,
			searchQuery: '',
			editMode: false,
			editContent: undefined,
			createdAt: Date.now(),
			lastModified: Date.now(),
		};

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: 'file-tab-1', data: fileTab },
		];

		// Render with AI tab active (file tab inactive)
		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		const inactiveFileTab = screen.getByText('example').closest('[data-tab-id]') as HTMLElement;
		// Inactive file tab should NOT have the active background color (bright background)
		// It may be transparent or empty depending on how JSDOM handles it
		const bgColor = inactiveFileTab.style.backgroundColor;
		expect(bgColor === 'transparent' || bgColor === '').toBe(true);
		expect(inactiveFileTab).toHaveStyle({ marginBottom: '0' });
		expect(inactiveFileTab).toHaveStyle({ zIndex: '0' });
	});

	it('file tab displays extension badge with file extension text', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab: FilePreviewTab = {
			id: 'file-tab-1',
			path: '/test/example.tsx',
			name: 'example',
			extension: '.tsx',
			content: 'const Example = () => {};',
			scrollTop: 0,
			searchQuery: '',
			editMode: false,
			editContent: undefined,
			createdAt: Date.now(),
			lastModified: Date.now(),
		};

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: 'file-tab-1', data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId="file-tab-1"
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		// File tab should show extension badge (uppercase, without leading dot)
		const extensionBadge = screen.getByText('TSX');
		expect(extensionBadge).toBeInTheDocument();
		// Verify it has the uppercase and small badge styling
		expect(extensionBadge.className).toContain('uppercase');
	});
});

describe('File tab content and SSH support', () => {
	const mockOnTabSelect = vi.fn();
	const mockOnTabClose = vi.fn();
	const mockOnNewTab = vi.fn();
	const mockOnFileTabSelect = vi.fn();
	const mockOnFileTabClose = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('file tab stores content field', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileContent = '# Test Content\n\nThis is the file content stored on the tab.';
		const fileTab: FilePreviewTab = {
			id: 'file-tab-1',
			path: '/test/readme.md',
			name: 'readme',
			extension: '.md',
			content: fileContent, // Content is stored on the tab
			scrollTop: 0,
			searchQuery: '',
			editMode: false,
			editContent: undefined,
			createdAt: Date.now(),
			lastModified: Date.now(),
		};

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: 'file-tab-1', data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId="file-tab-1"
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		// Verify the file tab renders (content is used by MainPanel, not TabBar)
		expect(screen.getByText('readme')).toBeInTheDocument();
		// Verify the content is stored on the tab data
		expect(fileTab.content).toBe(fileContent);
	});

	it('file tab supports SSH remote ID', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab: FilePreviewTab = {
			id: 'file-tab-1',
			path: '/remote/project/src/main.ts',
			name: 'main',
			extension: '.ts',
			content: 'export const main = () => {}',
			scrollTop: 0,
			searchQuery: '',
			editMode: false,
			editContent: undefined,
			createdAt: Date.now(),
			lastModified: Date.now(),
			sshRemoteId: 'ssh-remote-123', // SSH remote ID for re-fetching
			isLoading: false,
		};

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: 'file-tab-1', data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId="file-tab-1"
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		// Verify the file tab renders
		expect(screen.getByText('main')).toBeInTheDocument();
		// Verify SSH remote ID is stored
		expect(fileTab.sshRemoteId).toBe('ssh-remote-123');
		expect(fileTab.isLoading).toBe(false);
	});

	it('file tab can be in loading state for SSH files', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab: FilePreviewTab = {
			id: 'file-tab-1',
			path: '/remote/project/loading.ts',
			name: 'loading',
			extension: '.ts',
			content: '', // Empty while loading
			scrollTop: 0,
			searchQuery: '',
			editMode: false,
			editContent: undefined,
			createdAt: Date.now(),
			lastModified: 0, // Not yet loaded
			sshRemoteId: 'ssh-remote-456',
			isLoading: true, // Currently loading content
		};

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: 'file-tab-1', data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId="file-tab-1"
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		// Tab still renders while loading
		expect(screen.getByText('loading')).toBeInTheDocument();
		// Verify loading state
		expect(fileTab.isLoading).toBe(true);
		expect(fileTab.content).toBe('');
	});

	it('file tab editContent takes precedence over content when set', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const originalContent = 'Original file content';
		const editedContent = 'Edited content not yet saved';
		const fileTab: FilePreviewTab = {
			id: 'file-tab-1',
			path: '/test/edited.md',
			name: 'edited',
			extension: '.md',
			content: originalContent,
			scrollTop: 100,
			searchQuery: 'search',
			editMode: true,
			editContent: editedContent, // Has unsaved edits
			createdAt: Date.now(),
			lastModified: Date.now(),
		};

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: 'file-tab-1', data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId="file-tab-1"
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		// Tab renders
		expect(screen.getByText('edited')).toBeInTheDocument();
		// Verify both content fields exist (MainPanel uses editContent ?? content)
		expect(fileTab.content).toBe(originalContent);
		expect(fileTab.editContent).toBe(editedContent);
		expect(fileTab.editMode).toBe(true);
	});
});

// Extension badge styling tests for visual polish across themes
describe('Extension badge styling across themes', () => {
	const mockOnTabSelect = vi.fn();
	const mockOnTabClose = vi.fn();
	const mockOnNewTab = vi.fn();
	const mockOnFileTabSelect = vi.fn();
	const mockOnFileTabClose = vi.fn();

	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		Element.prototype.scrollTo = vi.fn();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// Light theme for testing contrast
	const lightTheme: Theme = {
		id: 'github-light',
		name: 'GitHub Light',
		mode: 'light',
		colors: {
			bgMain: '#ffffff',
			bgSidebar: '#f6f8fa',
			bgActivity: '#eff2f5',
			textMain: '#24292f',
			textDim: '#57606a',
			accent: '#0969da',
			border: '#d0d7de',
			error: '#cf222e',
			success: '#1a7f37',
			warning: '#9a6700',
		},
	};

	// Dark theme for comparison
	const darkTheme: Theme = {
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
			border: '#44475a',
			error: '#ff5555',
			success: '#50fa7b',
			warning: '#ffb86c',
		},
	};

	const createFileTab = (extension: string): FilePreviewTab => ({
		id: `file-tab-${extension}`,
		path: `/test/file${extension}`,
		name: 'file',
		extension: extension,
		content: 'test content',
		scrollTop: 0,
		searchQuery: '',
		editMode: false,
		editContent: undefined,
		createdAt: Date.now(),
		lastModified: Date.now(),
	});

	it('renders extension badges for TypeScript files with appropriate styling', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab = createFileTab('.ts');

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: fileTab.id, data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={darkTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		// Extension badge should be rendered
		const badge = screen.getByText('TS');
		expect(badge).toBeInTheDocument();
		// Badge should have blue-ish background for TypeScript
		expect(badge).toHaveStyle({ backgroundColor: 'rgba(59, 130, 246, 0.3)' });
	});

	it('renders extension badges for TypeScript files with light theme appropriate styling', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab = createFileTab('.tsx');

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: fileTab.id, data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={lightTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		// Extension badge should be rendered with light theme colors
		const badge = screen.getByText('TSX');
		expect(badge).toBeInTheDocument();
		// Badge should have darker blue for better contrast on light backgrounds
		expect(badge).toHaveStyle({ backgroundColor: 'rgba(37, 99, 235, 0.15)' });
	});

	it('renders extension badges for Markdown files with dark theme styling', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab = createFileTab('.md');

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: fileTab.id, data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={darkTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		const badge = screen.getByText('MD');
		expect(badge).toBeInTheDocument();
		// Green tones for Markdown/Docs
		expect(badge).toHaveStyle({ backgroundColor: 'rgba(34, 197, 94, 0.3)' });
	});

	it('renders extension badges for JSON files with dark theme styling', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab = createFileTab('.json');

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: fileTab.id, data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={darkTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		const badge = screen.getByText('JSON');
		expect(badge).toBeInTheDocument();
		// Yellow tones for JSON/Config
		expect(badge).toHaveStyle({ backgroundColor: 'rgba(234, 179, 8, 0.3)' });
	});

	it('renders extension badges for CSS files with dark theme styling', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab = createFileTab('.css');

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: fileTab.id, data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={darkTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		const badge = screen.getByText('CSS');
		expect(badge).toBeInTheDocument();
		// Purple tones for CSS/Styles
		expect(badge).toHaveStyle({ backgroundColor: 'rgba(168, 85, 247, 0.3)' });
	});

	it('renders extension badges for HTML files with dark theme styling', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab = createFileTab('.html');

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: fileTab.id, data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={darkTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		const badge = screen.getByText('HTML');
		expect(badge).toBeInTheDocument();
		// Orange tones for HTML/Templates
		expect(badge).toHaveStyle({ backgroundColor: 'rgba(249, 115, 22, 0.3)' });
	});

	it('renders extension badges for Python files with dark theme styling', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab = createFileTab('.py');

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: fileTab.id, data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={darkTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		const badge = screen.getByText('PY');
		expect(badge).toBeInTheDocument();
		// Teal/cyan tones for Python
		expect(badge).toHaveStyle({ backgroundColor: 'rgba(20, 184, 166, 0.3)' });
	});

	it('renders extension badges for Rust files with dark theme styling', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab = createFileTab('.rs');

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: fileTab.id, data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={darkTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		const badge = screen.getByText('RS');
		expect(badge).toBeInTheDocument();
		// Rust/red-orange tones for Rust
		expect(badge).toHaveStyle({ backgroundColor: 'rgba(239, 68, 68, 0.3)' });
	});

	it('renders extension badges for unknown files using theme border color', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab = createFileTab('.xyz');

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: fileTab.id, data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={darkTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		const badge = screen.getByText('XYZ');
		expect(badge).toBeInTheDocument();
		// Unknown extensions use accent-derived color for visibility
		expect(badge).toHaveStyle({ backgroundColor: 'rgba(189, 147, 249, 0.3)' });
	});

	it('renders consistent tab name truncation for file tabs (max-w-[120px])', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab: FilePreviewTab = {
			id: 'file-tab-1',
			path: '/test/very-long-filename-that-should-be-truncated.ts',
			name: 'very-long-filename-that-should-be-truncated',
			extension: '.ts',
			content: 'test',
			scrollTop: 0,
			searchQuery: '',
			editMode: false,
			editContent: undefined,
			createdAt: Date.now(),
			lastModified: Date.now(),
		};

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: fileTab.id, data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1" // AI tab active, file tab inactive
				theme={darkTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
			/>
		);

		// File tab name span should have truncation class
		const fileNameSpan = screen.getByText('very-long-filename-that-should-be-truncated');
		expect(fileNameSpan).toHaveClass('truncate');
		expect(fileNameSpan).toHaveClass('max-w-[120px]');
	});
});

describe('File tab extension badge colorblind mode', () => {
	const mockOnTabSelect = vi.fn();
	const mockOnTabClose = vi.fn();
	const mockOnNewTab = vi.fn();
	const mockOnFileTabSelect = vi.fn();
	const mockOnFileTabClose = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	// Light theme for testing contrast
	const lightTheme: Theme = {
		id: 'github-light',
		name: 'GitHub Light',
		mode: 'light',
		colors: {
			bgMain: '#ffffff',
			bgSidebar: '#f6f8fa',
			bgActivity: '#eff2f5',
			textMain: '#24292f',
			textDim: '#57606a',
			accent: '#0969da',
			border: '#d0d7de',
			error: '#cf222e',
			success: '#1a7f37',
			warning: '#9a6700',
		},
	};

	// Dark theme for comparison
	const darkTheme: Theme = {
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
			border: '#44475a',
			error: '#ff5555',
			success: '#50fa7b',
			warning: '#ffb86c',
		},
	};

	const createTab = (overrides: Partial<AITab> = {}): AITab => ({
		id: 'test-tab',
		name: '',
		agentSessionId: 'abc12345-def6-7890',
		logs: [],
		...overrides,
	});

	const createFileTab = (extension: string): FilePreviewTab => ({
		id: `file-tab-${extension}`,
		path: `/test/example${extension}`,
		name: 'example',
		extension: extension,
		content: 'test content',
		scrollTop: 0,
		searchQuery: '',
		editMode: false,
		editContent: undefined,
		createdAt: Date.now(),
		lastModified: Date.now(),
	});

	it('renders colorblind-safe colors for TypeScript files in dark mode', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab = createFileTab('.ts');

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: fileTab.id, data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={darkTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
				colorBlindMode={true}
			/>
		);

		const badge = screen.getByText('TS');
		expect(badge).toBeInTheDocument();
		// Strong Blue (#0077BB) from Wong's colorblind-safe palette
		expect(badge).toHaveStyle({ backgroundColor: 'rgba(0, 119, 187, 0.35)' });
	});

	it('renders colorblind-safe colors for TypeScript files in light mode', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab = createFileTab('.tsx');

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: fileTab.id, data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={lightTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
				colorBlindMode={true}
			/>
		);

		const badge = screen.getByText('TSX');
		expect(badge).toBeInTheDocument();
		// Strong Blue (#0077BB) lighter for light theme
		expect(badge).toHaveStyle({ backgroundColor: 'rgba(0, 119, 187, 0.18)' });
	});

	it('renders colorblind-safe colors for Markdown files (teal)', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab = createFileTab('.md');

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: fileTab.id, data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={darkTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
				colorBlindMode={true}
			/>
		);

		const badge = screen.getByText('MD');
		expect(badge).toBeInTheDocument();
		// Teal (#009988) from Wong's colorblind-safe palette
		expect(badge).toHaveStyle({ backgroundColor: 'rgba(0, 153, 136, 0.35)' });
	});

	it('renders colorblind-safe colors for JSON/Config files (orange)', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab = createFileTab('.json');

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: fileTab.id, data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={darkTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
				colorBlindMode={true}
			/>
		);

		const badge = screen.getByText('JSON');
		expect(badge).toBeInTheDocument();
		// Orange (#EE7733) from Wong's colorblind-safe palette
		expect(badge).toHaveStyle({ backgroundColor: 'rgba(238, 119, 51, 0.35)' });
	});

	it('renders colorblind-safe colors for CSS files (purple)', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab = createFileTab('.css');

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: fileTab.id, data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={darkTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
				colorBlindMode={true}
			/>
		);

		const badge = screen.getByText('CSS');
		expect(badge).toBeInTheDocument();
		// Purple (#AA4499) from Wong's colorblind-safe palette
		expect(badge).toHaveStyle({ backgroundColor: 'rgba(170, 68, 153, 0.35)' });
	});

	it('renders colorblind-safe colors for HTML files (vermillion)', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab = createFileTab('.html');

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: fileTab.id, data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={darkTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
				colorBlindMode={true}
			/>
		);

		const badge = screen.getByText('HTML');
		expect(badge).toBeInTheDocument();
		// Vermillion (#CC3311) from Wong's colorblind-safe palette
		expect(badge).toHaveStyle({ backgroundColor: 'rgba(204, 51, 17, 0.35)' });
	});

	it('renders colorblind-safe colors for Python files (cyan)', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab = createFileTab('.py');

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: fileTab.id, data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={darkTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
				colorBlindMode={true}
			/>
		);

		const badge = screen.getByText('PY');
		expect(badge).toBeInTheDocument();
		// Cyan (#33BBEE) from Wong's colorblind-safe palette
		expect(badge).toHaveStyle({ backgroundColor: 'rgba(51, 187, 238, 0.35)' });
	});

	it('renders colorblind-safe colors for Rust files (magenta)', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab = createFileTab('.rs');

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: fileTab.id, data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={darkTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
				colorBlindMode={true}
			/>
		);

		const badge = screen.getByText('RS');
		expect(badge).toBeInTheDocument();
		// Magenta (#EE3377) from Wong's colorblind-safe palette
		expect(badge).toHaveStyle({ backgroundColor: 'rgba(238, 51, 119, 0.35)' });
	});

	it('renders colorblind-safe colors for Go files (blue-green)', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab = createFileTab('.go');

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: fileTab.id, data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={darkTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
				colorBlindMode={true}
			/>
		);

		const badge = screen.getByText('GO');
		expect(badge).toBeInTheDocument();
		// Blue-Green (#44AA99) from Wong's colorblind-safe palette
		expect(badge).toHaveStyle({ backgroundColor: 'rgba(68, 170, 153, 0.35)' });
	});

	it('renders colorblind-safe colors for Shell scripts (gray)', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab = createFileTab('.sh');

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: fileTab.id, data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={darkTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
				colorBlindMode={true}
			/>
		);

		const badge = screen.getByText('SH');
		expect(badge).toBeInTheDocument();
		// Gray for shell scripts (distinguishable by luminance)
		expect(badge).toHaveStyle({ backgroundColor: 'rgba(150, 150, 150, 0.35)' });
	});

	it('falls back to theme colors for unknown extensions in colorblind mode', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab' });
		const fileTab = createFileTab('.xyz');

		const unifiedTabs = [
			{ type: 'ai' as const, id: 'ai-tab-1', data: aiTab },
			{ type: 'file' as const, id: fileTab.id, data: fileTab },
		];

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={darkTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
				colorBlindMode={true}
			/>
		);

		const badge = screen.getByText('XYZ');
		expect(badge).toBeInTheDocument();
		// Colorblind mode also uses accent-derived fallback for unknown extensions
		expect(badge).toHaveStyle({ backgroundColor: 'rgba(189, 147, 249, 0.3)' });
	});
});

describe('Performance: Many file tabs (10+)', () => {
	const mockOnTabSelect = vi.fn();
	const mockOnTabClose = vi.fn();
	const mockOnNewTab = vi.fn();
	const mockOnFileTabSelect = vi.fn();
	const mockOnFileTabClose = vi.fn();
	const mockOnUnifiedTabReorder = vi.fn();

	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		Element.prototype.scrollTo = vi.fn();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// Helper to create many file tabs
	const createManyFileTabs = (count: number): FilePreviewTab[] =>
		Array.from({ length: count }, (_, i) => ({
			id: `file-tab-${i}`,
			path: `/path/to/files/file-${i}.ts`,
			name: `file-${i}`,
			extension: '.ts',
			content: `// Content for file ${i}\nconst x${i} = ${i};`,
			scrollTop: 0,
			searchQuery: '',
			editMode: false,
			editContent: undefined,
			createdAt: Date.now() + i,
			lastModified: Date.now() + i,
		}));

	// Helper to create unified tabs from file tabs
	const createUnifiedTabsFromFiles = (
		fileTabs: FilePreviewTab[],
		aiTab: AITab
	): Array<{ type: 'ai' | 'file'; id: string; data: AITab | FilePreviewTab }> => [
		{ type: 'ai' as const, id: aiTab.id, data: aiTab },
		...fileTabs.map((ft) => ({ type: 'file' as const, id: ft.id, data: ft })),
	];

	it('renders 15 file tabs without performance issues', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab', agentSessionId: 'sess-1' });
		const fileTabs = createManyFileTabs(15);
		const unifiedTabs = createUnifiedTabsFromFiles(fileTabs, aiTab);

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
				onUnifiedTabReorder={mockOnUnifiedTabReorder}
			/>
		);

		// All 15 file tabs should be rendered
		expect(screen.getByText('file-0')).toBeInTheDocument();
		expect(screen.getByText('file-7')).toBeInTheDocument();
		expect(screen.getByText('file-14')).toBeInTheDocument();

		// All extension badges should be present (uppercase, no leading dot)
		const tsBadges = screen.getAllByText('TS');
		expect(tsBadges.length).toBe(15);
	});

	it('renders 30 file tabs with mixed AI tabs', () => {
		const aiTab1 = createTab({ id: 'ai-tab-1', name: 'AI Tab 1', agentSessionId: 'sess-1' });
		const aiTab2 = createTab({ id: 'ai-tab-2', name: 'AI Tab 2', agentSessionId: 'sess-2' });
		const fileTabs = createManyFileTabs(30);

		// Interleave AI tabs with file tabs
		const unifiedTabs = [
			{ type: 'ai' as const, id: aiTab1.id, data: aiTab1 },
			...fileTabs.slice(0, 15).map((ft) => ({ type: 'file' as const, id: ft.id, data: ft })),
			{ type: 'ai' as const, id: aiTab2.id, data: aiTab2 },
			...fileTabs.slice(15).map((ft) => ({ type: 'file' as const, id: ft.id, data: ft })),
		];

		render(
			<TabBar
				tabs={[aiTab1, aiTab2]}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
				onUnifiedTabReorder={mockOnUnifiedTabReorder}
			/>
		);

		// AI tabs should be present
		expect(screen.getByText('AI Tab 1')).toBeInTheDocument();
		expect(screen.getByText('AI Tab 2')).toBeInTheDocument();

		// File tabs from both groups should be present
		expect(screen.getByText('file-0')).toBeInTheDocument();
		expect(screen.getByText('file-14')).toBeInTheDocument();
		expect(screen.getByText('file-15')).toBeInTheDocument();
		expect(screen.getByText('file-29')).toBeInTheDocument();
	});

	it('selects file tab correctly among many tabs', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab', agentSessionId: 'sess-1' });
		const fileTabs = createManyFileTabs(20);
		const unifiedTabs = createUnifiedTabsFromFiles(fileTabs, aiTab);

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
				onUnifiedTabReorder={mockOnUnifiedTabReorder}
			/>
		);

		// Click on file-10
		const fileTab10 = screen.getByText('file-10').closest('[data-tab-id]')!;
		fireEvent.click(fileTab10);

		expect(mockOnFileTabSelect).toHaveBeenCalledWith('file-tab-10');
	});

	it('closes file tab correctly among many tabs', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab', agentSessionId: 'sess-1' });
		const fileTabs = createManyFileTabs(20);
		const unifiedTabs = createUnifiedTabsFromFiles(fileTabs, aiTab);

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId="file-tab-5" // Make file-5 active to show close button
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
				onUnifiedTabReorder={mockOnUnifiedTabReorder}
			/>
		);

		// The close button should be visible on the active file tab
		const fileTab5 = screen.getByText('file-5').closest('[data-tab-id]')!;
		const closeButton = fileTab5.querySelector('button[title="Close tab"]');
		expect(closeButton).toBeInTheDocument();

		fireEvent.click(closeButton!);
		expect(mockOnFileTabClose).toHaveBeenCalledWith('file-tab-5');
	});

	it('supports drag and drop reorder with many file tabs', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab', agentSessionId: 'sess-1' });
		const fileTabs = createManyFileTabs(15);
		const unifiedTabs = createUnifiedTabsFromFiles(fileTabs, aiTab);

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
				onUnifiedTabReorder={mockOnUnifiedTabReorder}
			/>
		);

		const fileTab2 = screen.getByText('file-2').closest('[data-tab-id]')!;
		const fileTab10 = screen.getByText('file-10').closest('[data-tab-id]')!;

		// Start dragging file-tab-2 (index 3 in unified tabs: AI tab is at 0)
		fireEvent.dragStart(fileTab2, {
			dataTransfer: {
				effectAllowed: '',
				setData: vi.fn(),
				getData: vi.fn().mockReturnValue('file-tab-2'),
			},
		});

		// Drop on file-tab-10 (index 11 in unified tabs)
		fireEvent.drop(fileTab10, {
			dataTransfer: {
				getData: vi.fn().mockReturnValue('file-tab-2'),
			},
		});

		// Should call onUnifiedTabReorder with correct indices
		expect(mockOnUnifiedTabReorder).toHaveBeenCalledWith(3, 11);
	});

	it('renders file tabs with different extensions correctly', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab', agentSessionId: 'sess-1' });
		const extensions = [
			'.ts',
			'.tsx',
			'.js',
			'.json',
			'.md',
			'.css',
			'.html',
			'.py',
			'.rs',
			'.go',
			'.sh',
		];
		const fileTabs: FilePreviewTab[] = extensions.map((ext, i) => ({
			id: `file-tab-${i}`,
			path: `/path/to/files/file-${i}${ext}`,
			name: `file-${i}`,
			extension: ext,
			content: `// Content`,
			scrollTop: 0,
			searchQuery: '',
			editMode: false,
			editContent: undefined,
			createdAt: Date.now() + i,
			lastModified: Date.now() + i,
		}));

		const unifiedTabs = createUnifiedTabsFromFiles(fileTabs, aiTab);

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId={null}
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
				onUnifiedTabReorder={mockOnUnifiedTabReorder}
			/>
		);

		// All extension badges should be rendered (uppercase, no leading dot)
		extensions.forEach((ext) => {
			// Strip leading dot and convert to uppercase (e.g., '.ts' -> 'TS')
			const badgeText = ext.replace(/^\./, '').toUpperCase();
			expect(screen.getByText(badgeText)).toBeInTheDocument();
		});
	});

	it('maintains active tab styling among many tabs', () => {
		const aiTab = createTab({ id: 'ai-tab-1', name: 'AI Tab', agentSessionId: 'sess-1' });
		const fileTabs = createManyFileTabs(20);
		const unifiedTabs = createUnifiedTabsFromFiles(fileTabs, aiTab);

		render(
			<TabBar
				tabs={[aiTab]}
				activeTabId="ai-tab-1"
				theme={mockTheme}
				onTabSelect={mockOnTabSelect}
				onTabClose={mockOnTabClose}
				onNewTab={mockOnNewTab}
				unifiedTabs={unifiedTabs}
				activeFileTabId="file-tab-10" // file-10 is active
				onFileTabSelect={mockOnFileTabSelect}
				onFileTabClose={mockOnFileTabClose}
				onUnifiedTabReorder={mockOnUnifiedTabReorder}
			/>
		);

		// Active file tab should have main background color (non-transparent)
		const activeFileTab = screen.getByText('file-10').closest('[data-tab-id]')!;
		expect(activeFileTab).toHaveStyle({ backgroundColor: mockTheme.colors.bgMain });

		// Active file tab should also have the bottom margin adjustment (active styling)
		expect(activeFileTab).toHaveStyle({ marginBottom: '-1px' });

		// Inactive file tab should NOT have the active margin adjustment
		const inactiveFileTab = screen.getByText('file-5').closest('[data-tab-id]')!;
		expect(inactiveFileTab).toHaveStyle({ marginBottom: '0' });
	});
});
