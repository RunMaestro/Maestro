/**
 * @fileoverview Tests for AgentInbox component
 * Tests: rendering, keyboard navigation, filter/sort controls,
 * focus management, ARIA attributes, virtualization integration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import AgentInbox from '../../../renderer/components/AgentInbox';
import type { Session, Group, Theme } from '../../../renderer/types';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
	X: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="x-icon" className={className} style={style}>
			×
		</span>
	),
}));

// Mock layer stack context
const mockRegisterLayer = vi.fn(() => 'layer-inbox-123');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
	}),
}));

// Mock react-window v2 List — renders all rows without virtualization for testing
vi.mock('react-window', () => ({
	List: ({
		rowComponent: RowComponent,
		rowCount,
		rowHeight,
		rowProps,
		style,
	}: {
		rowComponent: React.ComponentType<any>;
		rowCount: number;
		rowHeight: number | ((index: number, props: any) => number);
		rowProps: any;
		listRef?: any;
		style?: React.CSSProperties;
	}) => {
		const rows = [];
		for (let i = 0; i < rowCount; i++) {
			const height =
				typeof rowHeight === 'function' ? rowHeight(i, rowProps) : rowHeight;
			rows.push(
				<RowComponent
					key={i}
					index={i}
					style={{ height, position: 'absolute', top: 0, left: 0, width: '100%' }}
					ariaAttributes={{
						'aria-posinset': i + 1,
						'aria-setsize': rowCount,
						role: 'listitem' as const,
					}}
					{...rowProps}
				/>
			);
		}
		return (
			<div data-testid="virtual-list" style={style}>
				{rows}
			</div>
		);
	},
	useListRef: () => ({ current: null }),
}));

// Mock formatRelativeTime
vi.mock('../../../renderer/utils/formatters', () => ({
	formatRelativeTime: (ts: number | string | Date) => {
		if (typeof ts === 'number' && ts > 0) return '5m ago';
		return 'just now';
	},
}));

// ============================================================================
// Test factories
// ============================================================================
function createTheme(): Theme {
	return {
		id: 'dracula',
		name: 'Dracula',
		mode: 'dark',
		colors: {
			bgMain: '#282a36',
			bgSidebar: '#21222c',
			bgActivity: '#1e1f29',
			textMain: '#f8f8f2',
			textDim: '#6272a4',
			accent: '#bd93f9',
			accentDim: '#bd93f933',
			accentText: '#bd93f9',
			accentForeground: '#ffffff',
			border: '#44475a',
			success: '#50fa7b',
			warning: '#f1fa8c',
			error: '#ff5555',
		},
	};
}

function createSession(overrides: Partial<Session> & { id: string }): Session {
	return {
		name: 'Test Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/tmp',
		fullPath: '/tmp',
		projectRoot: '/tmp',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		aiTabs: [],
		activeTabId: '',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		...overrides,
	} as Session;
}

function createGroup(overrides: Partial<Group> & { id: string; name: string }): Group {
	return {
		emoji: '',
		collapsed: false,
		...overrides,
	};
}

function createTab(overrides: Partial<Session['aiTabs'][0]> & { id: string }) {
	return {
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: Date.now(),
		state: 'idle' as const,
		hasUnread: true,
		...overrides,
	};
}

// Helper: create a session with an inbox-eligible tab
function createInboxSession(
	sessionId: string,
	tabId: string,
	extras?: Partial<Session>
): Session {
	return createSession({
		id: sessionId,
		name: `Session ${sessionId}`,
		state: 'waiting_input',
		aiTabs: [
			createTab({
				id: tabId,
				hasUnread: true,
				logs: [{ text: `Last message from ${sessionId}`, timestamp: Date.now(), type: 'assistant' }],
			}),
		] as any,
		...extras,
	});
}

describe('AgentInbox', () => {
	let theme: Theme;
	let onClose: ReturnType<typeof vi.fn>;
	let onNavigateToSession: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		theme = createTheme();
		onClose = vi.fn();
		onNavigateToSession = vi.fn();
		mockRegisterLayer.mockClear();
		mockUnregisterLayer.mockClear();
		mockUpdateLayerHandler.mockClear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ==========================================================================
	// Rendering
	// ==========================================================================
	describe('rendering', () => {
		it('renders modal with dialog role and aria-label', () => {
			render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			const dialog = screen.getByRole('dialog');
			expect(dialog).toBeTruthy();
			expect(dialog.getAttribute('aria-label')).toBe('Agent Inbox');
			expect(dialog.getAttribute('aria-modal')).toBe('true');
		});

		it('renders header with title "Inbox"', () => {
			render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			expect(screen.getByText('Inbox')).toBeTruthy();
		});

		it('shows item count badge with "need action" text', () => {
			const sessions = [createInboxSession('s1', 't1')];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			expect(screen.getByText('1 need action')).toBeTruthy();
		});

		it('shows "0 need action" when no items', () => {
			render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			expect(screen.getByText('0 need action')).toBeTruthy();
		});

		it('shows empty state message when no items match filter', () => {
			render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			expect(screen.getByText('No items match the current filter')).toBeTruthy();
		});

		it('renders footer with keyboard hints', () => {
			render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			expect(screen.getByText('↑↓ Navigate')).toBeTruthy();
			expect(screen.getByText('Enter Open')).toBeTruthy();
			expect(screen.getByText('Esc Close')).toBeTruthy();
		});

		it('renders session name and last message for inbox items', () => {
			const sessions = [createInboxSession('s1', 't1')];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			expect(screen.getByText('Session s1')).toBeTruthy();
			expect(screen.getByText('Last message from s1')).toBeTruthy();
		});

		it('renders group name with separator when session has group', () => {
			const groups = [createGroup({ id: 'g1', name: 'My Group' })];
			const sessions = [
				createInboxSession('s1', 't1', { groupId: 'g1' }),
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={groups}
					onClose={onClose}
				/>
			);
			expect(screen.getByText('My Group')).toBeTruthy();
			expect(screen.getByText('/')).toBeTruthy();
		});

		it('renders status badge with correct label', () => {
			const sessions = [createInboxSession('s1', 't1')];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			// "Needs Input" appears in both the filter button and the status badge
			const matches = screen.getAllByText('Needs Input');
			expect(matches.length).toBeGreaterThanOrEqual(2);
			// The status badge is a <span> with borderRadius (pill style)
			const badge = matches.find((el) => el.tagName === 'SPAN');
			expect(badge).toBeTruthy();
		});

		it('renders git branch badge when available', () => {
			const sessions = [
				createInboxSession('s1', 't1', { worktreeBranch: 'feature/test' }),
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			expect(screen.getByText('feature/test')).toBeTruthy();
		});

		it('renders context usage when available', () => {
			const sessions = [
				createInboxSession('s1', 't1', { contextUsage: 45 }),
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			expect(screen.getByText('Context: 45%')).toBeTruthy();
		});

		it('renders relative timestamp', () => {
			const sessions = [createInboxSession('s1', 't1')];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			expect(screen.getByText('5m ago')).toBeTruthy();
		});
	});

	// ==========================================================================
	// Layer stack registration
	// ==========================================================================
	describe('layer stack', () => {
		it('registers modal layer on mount', () => {
			render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			expect(mockRegisterLayer).toHaveBeenCalledTimes(1);
			const call = mockRegisterLayer.mock.calls[0][0];
			expect(call.type).toBe('modal');
			expect(call.ariaLabel).toBe('Agent Inbox');
		});

		it('unregisters modal layer on unmount', () => {
			const { unmount } = render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			unmount();
			expect(mockUnregisterLayer).toHaveBeenCalledWith('layer-inbox-123');
		});
	});

	// ==========================================================================
	// Close behavior
	// ==========================================================================
	describe('close behavior', () => {
		it('calls onClose when close button is clicked', () => {
			render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			const closeBtn = screen.getByTitle('Close (Esc)');
			fireEvent.click(closeBtn);
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('calls onClose when overlay is clicked', () => {
			const { container } = render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			const overlay = container.querySelector('.modal-overlay');
			if (overlay) fireEvent.click(overlay);
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('does NOT call onClose when clicking inside modal content', () => {
			render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			const dialog = screen.getByRole('dialog');
			fireEvent.click(dialog);
			expect(onClose).not.toHaveBeenCalled();
		});
	});

	// ==========================================================================
	// Keyboard navigation
	// ==========================================================================
	describe('keyboard navigation', () => {
		it('ArrowDown increments selected index', () => {
			const sessions = [
				createInboxSession('s1', 't1'),
				createInboxSession('s2', 't2'),
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
					onNavigateToSession={onNavigateToSession}
				/>
			);
			const dialog = screen.getByRole('dialog');
			fireEvent.keyDown(dialog, { key: 'ArrowDown' });

			// Second item should now be selected (aria-selected)
			const options = screen.getAllByRole('option');
			expect(options[1].getAttribute('aria-selected')).toBe('true');
			expect(options[0].getAttribute('aria-selected')).toBe('false');
		});

		it('ArrowUp decrements selected index', () => {
			const sessions = [
				createInboxSession('s1', 't1'),
				createInboxSession('s2', 't2'),
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
					onNavigateToSession={onNavigateToSession}
				/>
			);
			const dialog = screen.getByRole('dialog');
			// First go down, then up
			fireEvent.keyDown(dialog, { key: 'ArrowDown' });
			fireEvent.keyDown(dialog, { key: 'ArrowUp' });

			const options = screen.getAllByRole('option');
			expect(options[0].getAttribute('aria-selected')).toBe('true');
		});

		it('ArrowDown wraps from last to first item', () => {
			const sessions = [
				createInboxSession('s1', 't1'),
				createInboxSession('s2', 't2'),
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			const dialog = screen.getByRole('dialog');
			// Go down twice (past last item, should wrap to first)
			fireEvent.keyDown(dialog, { key: 'ArrowDown' });
			fireEvent.keyDown(dialog, { key: 'ArrowDown' });

			const options = screen.getAllByRole('option');
			expect(options[0].getAttribute('aria-selected')).toBe('true');
		});

		it('ArrowUp wraps from first to last item', () => {
			const sessions = [
				createInboxSession('s1', 't1'),
				createInboxSession('s2', 't2'),
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			const dialog = screen.getByRole('dialog');
			fireEvent.keyDown(dialog, { key: 'ArrowUp' });

			const options = screen.getAllByRole('option');
			expect(options[1].getAttribute('aria-selected')).toBe('true');
		});

		it('Enter navigates to selected session and closes modal', () => {
			const sessions = [createInboxSession('s1', 't1')];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
					onNavigateToSession={onNavigateToSession}
				/>
			);
			const dialog = screen.getByRole('dialog');
			fireEvent.keyDown(dialog, { key: 'Enter' });

			expect(onNavigateToSession).toHaveBeenCalledWith('s1', 't1');
			expect(onClose).toHaveBeenCalled();
		});

		it('does nothing on keyboard events when no items', () => {
			render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			const dialog = screen.getByRole('dialog');
			// Should not throw
			fireEvent.keyDown(dialog, { key: 'ArrowDown' });
			fireEvent.keyDown(dialog, { key: 'ArrowUp' });
			fireEvent.keyDown(dialog, { key: 'Enter' });
		});
	});

	// ==========================================================================
	// Item click
	// ==========================================================================
	describe('item click', () => {
		it('navigates to session on item click', () => {
			const sessions = [createInboxSession('s1', 't1')];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
					onNavigateToSession={onNavigateToSession}
				/>
			);
			const option = screen.getByRole('option');
			fireEvent.click(option);
			expect(onNavigateToSession).toHaveBeenCalledWith('s1', 't1');
			expect(onClose).toHaveBeenCalled();
		});

		it('does not throw when onNavigateToSession is undefined', () => {
			const sessions = [createInboxSession('s1', 't1')];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			const option = screen.getByRole('option');
			// Should not throw
			fireEvent.click(option);
			expect(onClose).toHaveBeenCalled();
		});
	});

	// ==========================================================================
	// Filter controls
	// ==========================================================================
	describe('filter controls', () => {
		it('renders filter buttons: All, Needs Input, Ready', () => {
			render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			expect(screen.getByText('All')).toBeTruthy();
			expect(screen.getByText('Needs Input')).toBeTruthy();
			expect(screen.getByText('Ready')).toBeTruthy();
		});

		it('changes filter when clicking filter button', () => {
			// Session in 'idle' state with unread — visible under 'all' and 'ready', but not 'needs_input'
			const sessions = [
				createInboxSession('s1', 't1', { state: 'idle' }),
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			// Should be visible under 'all'
			expect(screen.getByText('Session s1')).toBeTruthy();

			// Switch to 'needs_input' filter
			fireEvent.click(screen.getByText('Needs Input'));
			// Item should disappear (idle, not waiting_input)
			expect(screen.queryByText('Session s1')).toBeNull();

			// Switch to 'Ready' — should reappear
			fireEvent.click(screen.getByText('Ready'));
			expect(screen.getByText('Session s1')).toBeTruthy();
		});
	});

	// ==========================================================================
	// Sort controls
	// ==========================================================================
	describe('sort controls', () => {
		it('renders sort buttons: Newest, Oldest, Grouped', () => {
			render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			expect(screen.getByText('Newest')).toBeTruthy();
			expect(screen.getByText('Oldest')).toBeTruthy();
			expect(screen.getByText('Grouped')).toBeTruthy();
		});

		it('renders group headers when Grouped sort is active', () => {
			const groups = [createGroup({ id: 'g1', name: 'Alpha Group' })];
			const sessions = [
				createInboxSession('s1', 't1', { groupId: 'g1' }),
				createInboxSession('s2', 't2'), // no group
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={groups}
					onClose={onClose}
				/>
			);
			// Switch to Grouped
			fireEvent.click(screen.getByText('Grouped'));
			// Group headers render with text-transform: uppercase via CSS.
			// "Alpha Group" appears in both the header and the item card,
			// so we check that at least 2 elements contain it (header + card span)
			const alphaMatches = screen.getAllByText('Alpha Group');
			expect(alphaMatches.length).toBeGreaterThanOrEqual(2);
			// "Ungrouped" only appears as a group header
			expect(screen.getByText('Ungrouped')).toBeTruthy();
		});
	});

	// ==========================================================================
	// ARIA
	// ==========================================================================
	describe('ARIA attributes', () => {
		it('has listbox role on body container', () => {
			render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			const listbox = screen.getByRole('listbox');
			expect(listbox).toBeTruthy();
			expect(listbox.getAttribute('aria-label')).toBe('Inbox items');
		});

		it('sets aria-activedescendant on listbox', () => {
			const sessions = [createInboxSession('s1', 't1')];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			const listbox = screen.getByRole('listbox');
			expect(listbox.getAttribute('aria-activedescendant')).toBe('inbox-item-s1-t1');
		});

		it('item cards have role=option and aria-selected', () => {
			const sessions = [createInboxSession('s1', 't1')];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			const option = screen.getByRole('option');
			expect(option.getAttribute('aria-selected')).toBe('true');
		});

		it('badge has aria-live=polite', () => {
			render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			const liveRegion = screen.getByText('0 need action');
			expect(liveRegion.getAttribute('aria-live')).toBe('polite');
		});
	});

	// ==========================================================================
	// Virtualization
	// ==========================================================================
	describe('virtualization', () => {
		it('renders items via the virtual list', () => {
			const sessions = [
				createInboxSession('s1', 't1'),
				createInboxSession('s2', 't2'),
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			const virtualList = screen.getByTestId('virtual-list');
			expect(virtualList).toBeTruthy();
			const options = screen.getAllByRole('option');
			expect(options.length).toBe(2);
		});
	});

	// ==========================================================================
	// Multiple items
	// ==========================================================================
	describe('multiple items', () => {
		it('shows correct item count for multiple sessions', () => {
			const sessions = [
				createInboxSession('s1', 't1'),
				createInboxSession('s2', 't2'),
				createInboxSession('s3', 't3'),
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			expect(screen.getByText('3 need action')).toBeTruthy();
		});

		it('first item is selected by default', () => {
			const sessions = [
				createInboxSession('s1', 't1'),
				createInboxSession('s2', 't2'),
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			const options = screen.getAllByRole('option');
			expect(options[0].getAttribute('aria-selected')).toBe('true');
			expect(options[1].getAttribute('aria-selected')).toBe('false');
		});
	});
});
