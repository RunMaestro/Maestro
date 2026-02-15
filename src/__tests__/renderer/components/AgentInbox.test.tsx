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
	CheckCircle: ({ style, ...props }: { style?: React.CSSProperties; 'data-testid'?: string }) => (
		<span data-testid={props['data-testid'] ?? 'check-circle-icon'} style={style}>
			✓
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
			// Default filter is 'all' → shows "All caught up" message
			expect(screen.getByText('All caught up — no sessions need attention.')).toBeTruthy();
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
			// Smart summary: waiting_input with no recognized AI source → "Waiting: awaiting your response"
			expect(screen.getByText('Waiting: awaiting your response')).toBeTruthy();
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

		it('renders git branch badge when available with icon prefix', () => {
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
			const badge = screen.getByTestId('git-branch-badge');
			expect(badge).toBeTruthy();
			expect(badge.textContent).toContain('⎇');
			expect(badge.textContent).toContain('feature/test');
		});

		it('renders context usage when available with colored text', () => {
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
			// Should render context usage bar
			expect(screen.getByTestId('context-usage-bar')).toBeTruthy();
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

		it('cancels pending requestAnimationFrame on unmount', () => {
			const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame');
			const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(42);

			const sessions = [createInboxSession('s1', 't1')];
			const { unmount } = render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
					onNavigateToSession={onNavigateToSession}
				/>
			);

			// Trigger close (which schedules a requestAnimationFrame)
			const closeBtn = screen.getByTitle('Close (Esc)');
			fireEvent.click(closeBtn);
			expect(rafSpy).toHaveBeenCalled();

			// Unmount before the rAF fires
			unmount();
			expect(cancelSpy).toHaveBeenCalledWith(42);

			cancelSpy.mockRestore();
			rafSpy.mockRestore();
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

		it('Tab moves focus from list to first header control', () => {
			const sessions = [createInboxSession('s1', 't1')];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			const dialog = screen.getByRole('dialog');
			// Focus the dialog (list area)
			dialog.focus();
			expect(document.activeElement).toBe(dialog);

			// Press Tab — should move to first header button
			fireEvent.keyDown(dialog, { key: 'Tab' });
			// Active element should be a button inside the header
			expect(document.activeElement?.tagName).toBe('BUTTON');
		});

		it('Tab cycles through header controls and wraps back to list', () => {
			const sessions = [createInboxSession('s1', 't1')];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			const dialog = screen.getByRole('dialog');
			dialog.focus();

			// Count all header buttons (3 sort + 3 filter + 1 close = 7)
			fireEvent.keyDown(dialog, { key: 'Tab' });
			const firstButton = document.activeElement;
			expect(firstButton?.tagName).toBe('BUTTON');

			// Tab through all header buttons
			for (let i = 0; i < 6; i++) {
				fireEvent.keyDown(dialog, { key: 'Tab' });
			}
			// After 7 total Tabs (1 + 6), should be at the last header button
			expect(document.activeElement?.tagName).toBe('BUTTON');

			// One more Tab should wrap back to list container
			fireEvent.keyDown(dialog, { key: 'Tab' });
			expect(document.activeElement).toBe(dialog);
		});

		it('Shift+Tab wraps from list to list (when at first header or list)', () => {
			const sessions = [createInboxSession('s1', 't1')];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			const dialog = screen.getByRole('dialog');
			dialog.focus();

			// Shift+Tab from list area: focusIdx is -1, which is <= 0, so wraps to list container
			fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
			expect(document.activeElement).toBe(dialog);
		});

		it('Shift+Tab from second header control goes to first', () => {
			const sessions = [createInboxSession('s1', 't1')];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			const dialog = screen.getByRole('dialog');
			dialog.focus();

			// Tab to first header control
			fireEvent.keyDown(dialog, { key: 'Tab' });
			const firstButton = document.activeElement;

			// Tab to second header control
			fireEvent.keyDown(dialog, { key: 'Tab' });
			const secondButton = document.activeElement;
			expect(secondButton).not.toBe(firstButton);

			// Shift+Tab should go back to first
			fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
			expect(document.activeElement).toBe(firstButton);
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

		it('filter control has aria-label="Filter sessions"', () => {
			const { container } = render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			const filterControl = container.querySelector('[aria-label="Filter sessions"]');
			expect(filterControl).toBeTruthy();
		});

		it('sort control has aria-label="Sort sessions"', () => {
			const { container } = render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			const sortControl = container.querySelector('[aria-label="Sort sessions"]');
			expect(sortControl).toBeTruthy();
		});

		it('filter segment buttons have aria-pressed attribute', () => {
			const { container } = render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			const filterControl = container.querySelector('[aria-label="Filter sessions"]');
			expect(filterControl).toBeTruthy();
			const buttons = filterControl!.querySelectorAll('button');
			expect(buttons.length).toBe(3);
			// "All" is active by default
			expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
			expect(buttons[1].getAttribute('aria-pressed')).toBe('false');
			expect(buttons[2].getAttribute('aria-pressed')).toBe('false');
		});

		it('sort segment buttons have aria-pressed attribute', () => {
			const { container } = render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			const sortControl = container.querySelector('[aria-label="Sort sessions"]');
			expect(sortControl).toBeTruthy();
			const buttons = sortControl!.querySelectorAll('button');
			expect(buttons.length).toBe(3);
			// "Newest" is active by default
			expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
			expect(buttons[1].getAttribute('aria-pressed')).toBe('false');
			expect(buttons[2].getAttribute('aria-pressed')).toBe('false');
		});

		it('aria-pressed updates when filter changes', () => {
			const { container } = render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			const filterControl = container.querySelector('[aria-label="Filter sessions"]');
			const buttons = filterControl!.querySelectorAll('button');
			// Click "Needs Input" button
			fireEvent.click(buttons[1]);
			expect(buttons[0].getAttribute('aria-pressed')).toBe('false');
			expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
			expect(buttons[2].getAttribute('aria-pressed')).toBe('false');
		});
	});

	// ==========================================================================
	// Empty states (filter-aware)
	// ==========================================================================
	describe('empty states', () => {
		it('shows "All caught up" with checkmark icon when filter is "All" and no items', () => {
			render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			expect(screen.getByTestId('inbox-empty-state')).toBeTruthy();
			expect(screen.getByText('All caught up — no sessions need attention.')).toBeTruthy();
			expect(screen.getByTestId('inbox-empty-icon')).toBeTruthy();
		});

		it('shows "No sessions waiting for input" without icon when filter is "Needs Input"', () => {
			render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			// Switch to "Needs Input" filter
			fireEvent.click(screen.getByText('Needs Input'));
			expect(screen.getByText('No sessions waiting for input.')).toBeTruthy();
			expect(screen.queryByTestId('inbox-empty-icon')).toBeNull();
		});

		it('shows "No idle sessions with unread messages" without icon when filter is "Ready"', () => {
			render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			// Switch to "Ready" filter
			fireEvent.click(screen.getByText('Ready'));
			expect(screen.getByText('No idle sessions with unread messages.')).toBeTruthy();
			expect(screen.queryByTestId('inbox-empty-icon')).toBeNull();
		});

		it('shows empty state when modal is open and user switches to a filter with no results', () => {
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
			// Initially visible under "All"
			expect(screen.getByText('Session s1')).toBeTruthy();

			// Switch to "Needs Input" — no items match
			fireEvent.click(screen.getByText('Needs Input'));
			expect(screen.queryByText('Session s1')).toBeNull();
			expect(screen.getByText('No sessions waiting for input.')).toBeTruthy();
			expect(screen.getByTestId('inbox-empty-state')).toBeTruthy();
		});

		it('empty state icon has 32px size and 50% opacity', () => {
			render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			const icon = screen.getByTestId('inbox-empty-icon');
			expect(icon.style.width).toBe('32px');
			expect(icon.style.height).toBe('32px');
			expect(icon.style.opacity).toBe('0.5');
		});

		it('empty state text has 14px font, textDim color, max-width 280px, and center alignment', () => {
			render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			const text = screen.getByText('All caught up — no sessions need attention.');
			expect(text.style.fontSize).toBe('14px');
			expect(text.style.maxWidth).toBe('280px');
			expect(text.style.textAlign).toBe('center');
		});

		it('empty state is centered vertically and horizontally', () => {
			const { container } = render(
				<AgentInbox
					theme={theme}
					sessions={[]}
					groups={[]}
					onClose={onClose}
				/>
			);
			const emptyState = screen.getByTestId('inbox-empty-state');
			// Uses flexbox centering
			expect(emptyState.className).toContain('flex');
			expect(emptyState.className).toContain('items-center');
			expect(emptyState.className).toContain('justify-center');
		});

		it('modal does NOT close when filter has no results — stays open with empty state', () => {
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
			// Switch to "Needs Input" — no items, but modal stays open
			fireEvent.click(screen.getByText('Needs Input'));
			expect(onClose).not.toHaveBeenCalled();
			// Modal is still rendered
			expect(screen.getByRole('dialog')).toBeTruthy();
			expect(screen.getByTestId('inbox-empty-state')).toBeTruthy();
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

	// ==========================================================================
	// InboxItemCard visual hierarchy
	// ==========================================================================
	describe('InboxItemCard', () => {
		it('uses background fill for selection, not border or outline', () => {
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
			// Selected card should have a non-transparent background (accent at 8% opacity)
			expect(option.style.backgroundColor).not.toBe('transparent');
			expect(option.style.backgroundColor).not.toBe('');
			// No outline on selection (outline only on focus)
			expect(option.style.outline).toBe('');
		});

		it('non-selected card has transparent background and no outline', () => {
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
			// Second item is not selected
			expect(options[1].style.backgroundColor).toBe('transparent');
			expect(options[1].style.outline).toBe('');
		});

		it('card row 1 shows session name in bold', () => {
			const sessions = [createInboxSession('s1', 't1')];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			const sessionName = screen.getByText('Session s1');
			expect(sessionName.style.fontWeight).toBe('600');
			expect(sessionName.style.fontSize).toBe('14px');
		});

		it('card row 2 shows last message in muted color', () => {
			const sessions = [createInboxSession('s1', 't1')];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			// Smart summary: waiting_input with no recognized AI source → "Waiting: awaiting your response"
			const lastMsg = screen.getByText('Waiting: awaiting your response');
			expect(lastMsg.style.fontSize).toBe('13px');
			// JSDOM converts hex to rgb; textDim #6272a4 = rgb(98, 114, 164)
			expect(lastMsg.style.color).toBeTruthy();
		});

		it('card row 3 git branch has SF Mono/Menlo/monospace font stack', () => {
			const sessions = [
				createInboxSession('s1', 't1', { worktreeBranch: 'main' }),
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			const branchBadge = screen.getByTestId('git-branch-badge');
			// JSDOM normalizes single quotes to double quotes in CSS values
			expect(branchBadge.style.fontFamily).toBe('"SF Mono", "Menlo", monospace');
		});

		it('card row 3 status badge renders as colored pill', () => {
			const sessions = [createInboxSession('s1', 't1')];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			// "Needs Input" status badge — find the pill (span with borderRadius)
			const badges = screen.getAllByText('Needs Input');
			const pill = badges.find(
				(el) => el.tagName === 'SPAN' && el.style.borderRadius === '10px'
			);
			expect(pill).toBeTruthy();
			// Pill should have colored background
			expect(pill!.style.backgroundColor).toBeTruthy();
		});

		it('card has no standalone emoji', () => {
			const groups = [createGroup({ id: 'g1', name: 'Test Group' })];
			const sessions = [
				createInboxSession('s1', 't1', { groupId: 'g1' }),
			];
			const { container } = render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={groups}
					onClose={onClose}
				/>
			);
			const option = container.querySelector('[role="option"]');
			const textContent = option?.textContent ?? '';
			// No emoji characters — check for common emoji range
			const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2702}-\u{27B0}]/u;
			expect(emojiRegex.test(textContent)).toBe(false);
		});

		it('card has correct height and border-radius', () => {
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
			// height = ITEM_HEIGHT (80) - 12 = 68px
			expect(option.style.height).toBe('68px');
			expect(option.style.borderRadius).toBe('8px');
		});

		it('group name shown in muted 12px font', () => {
			const groups = [createGroup({ id: 'g1', name: 'Dev Team' })];
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
			const groupName = screen.getByText('Dev Team');
			expect(groupName.style.fontSize).toBe('12px');
			// JSDOM converts hex to rgb — just verify color is set
			expect(groupName.style.color).toBeTruthy();
		});

		it('timestamp shown right-aligned in muted 12px font', () => {
			const sessions = [createInboxSession('s1', 't1')];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			const timestamp = screen.getByText('5m ago');
			expect(timestamp.style.fontSize).toBe('12px');
			// JSDOM converts hex to rgb — just verify color is set
			expect(timestamp.style.color).toBeTruthy();
			expect(timestamp.style.flexShrink).toBe('0');
		});

		it('context usage shows percentage text', () => {
			const sessions = [
				createInboxSession('s1', 't1', { contextUsage: 72 }),
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			const ctx = screen.getByText('Context: 72%');
			expect(ctx.style.fontSize).toBe('11px');
		});

		it('context usage bar uses green color for 0-59%', () => {
			const sessions = [
				createInboxSession('s1', 't1', { contextUsage: 30 }),
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			const bar = screen.getByTestId('context-usage-bar');
			const fill = bar.firstElementChild as HTMLElement;
			// JSDOM converts hex to rgb — #50fa7b → rgb(80, 250, 123)
			expect(fill.style.backgroundColor).toBe('rgb(80, 250, 123)');
			expect(fill.style.width).toBe('30%');
		});

		it('context usage bar uses orange color for 60-79%', () => {
			const sessions = [
				createInboxSession('s1', 't1', { contextUsage: 65 }),
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			const bar = screen.getByTestId('context-usage-bar');
			const fill = bar.firstElementChild as HTMLElement;
			// JSDOM converts hex to rgb — #f59e0b → rgb(245, 158, 11)
			expect(fill.style.backgroundColor).toBe('rgb(245, 158, 11)');
			expect(fill.style.width).toBe('65%');
		});

		it('context usage bar uses red color for 80-100%', () => {
			const sessions = [
				createInboxSession('s1', 't1', { contextUsage: 90 }),
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			const bar = screen.getByTestId('context-usage-bar');
			const fill = bar.firstElementChild as HTMLElement;
			// JSDOM converts hex to rgb — #ff5555 → rgb(255, 85, 85)
			expect(fill.style.backgroundColor).toBe('rgb(255, 85, 85)');
			expect(fill.style.width).toBe('90%');
		});

		it('context usage text color matches bar color', () => {
			const sessions = [
				createInboxSession('s1', 't1', { contextUsage: 75 }),
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			const text = screen.getByTestId('context-usage-text');
			// JSDOM converts hex to rgb — #f59e0b (orange) → rgb(245, 158, 11)
			expect(text.style.color).toBe('rgb(245, 158, 11)');
		});

		it('shows placeholder "Context: \u2014" when contextUsage is undefined', () => {
			const sessions = [
				createInboxSession('s1', 't1', { contextUsage: undefined }),
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			expect(screen.getByText('Context: \u2014')).toBeTruthy();
			// No bar should render
			expect(screen.queryByTestId('context-usage-bar')).toBeNull();
		});

		it('shows placeholder "Context: \u2014" when contextUsage is NaN', () => {
			const sessions = [
				createInboxSession('s1', 't1', { contextUsage: NaN }),
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			expect(screen.getByText('Context: \u2014')).toBeTruthy();
			expect(screen.queryByTestId('context-usage-bar')).toBeNull();
		});

		it('context usage bar is 4px tall and full width', () => {
			const sessions = [
				createInboxSession('s1', 't1', { contextUsage: 50 }),
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			const bar = screen.getByTestId('context-usage-bar');
			expect(bar.style.height).toBe('4px');
			expect(bar.style.width).toBe('100%');
		});

		it('context usage bar clamps percentage between 0 and 100', () => {
			const sessions = [
				createInboxSession('s1', 't1', { contextUsage: 150 }),
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			const bar = screen.getByTestId('context-usage-bar');
			const fill = bar.firstElementChild as HTMLElement;
			expect(fill.style.width).toBe('100%');
		});

		it('does not render git branch badge when not available', () => {
			const sessions = [
				createInboxSession('s1', 't1'), // no worktreeBranch
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			expect(screen.queryByTestId('git-branch-badge')).toBeNull();
		});

		it('truncates git branch name to 25 chars with ellipsis', () => {
			const longBranch = 'feature/very-long-branch-name-that-exceeds-limit';
			const sessions = [
				createInboxSession('s1', 't1', { worktreeBranch: longBranch }),
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			const badge = screen.getByTestId('git-branch-badge');
			// Should contain the ⎇ icon prefix
			expect(badge.textContent).toContain('⎇');
			// Should truncate to 25 chars + "..."
			expect(badge.textContent).toContain(longBranch.slice(0, 25) + '...');
			// Should NOT contain the full branch name
			expect(badge.textContent).not.toContain(longBranch);
		});

		it('does not truncate git branch name at exactly 25 chars', () => {
			const exactBranch = 'feature/exactly-25-chars!'; // 25 chars
			const sessions = [
				createInboxSession('s1', 't1', { worktreeBranch: exactBranch }),
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			const badge = screen.getByTestId('git-branch-badge');
			expect(badge.textContent).toContain(exactBranch);
			expect(badge.textContent).not.toContain('...');
		});

		it('does not render git branch badge for empty string branch', () => {
			const sessions = [
				createInboxSession('s1', 't1', { worktreeBranch: '' }),
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			expect(screen.queryByTestId('git-branch-badge')).toBeNull();
		});

		it('renders context placeholder text when undefined (not hidden)', () => {
			const sessions = [
				createInboxSession('s1', 't1', { contextUsage: undefined }),
			];
			render(
				<AgentInbox
					theme={theme}
					sessions={sessions}
					groups={[]}
					onClose={onClose}
				/>
			);
			// Now shows "Context: —" placeholder instead of hiding
			expect(screen.getByText('Context: \u2014')).toBeTruthy();
		});

		it('selected card has tabIndex=0, non-selected has tabIndex=-1', () => {
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
			expect(options[0].getAttribute('tabindex')).toBe('0');
			expect(options[1].getAttribute('tabindex')).toBe('-1');
		});
	});
});
