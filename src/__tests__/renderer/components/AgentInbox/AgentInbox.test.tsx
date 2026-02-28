import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import type { Theme, Session, Group } from '../../../../renderer/types';
import type { InboxItem } from '../../../../renderer/types/agent-inbox';

// ---------------------------------------------------------------------------
// Mocks — must be declared before component imports
// ---------------------------------------------------------------------------

vi.mock('../../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn(() => 'layer-inbox'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	}),
}));

vi.mock('../../../../renderer/constants/modalPriorities', () => ({
	MODAL_PRIORITIES: { AGENT_INBOX: 555 },
}));

const mockUpdateAgentInboxData = vi.fn();
vi.mock('../../../../renderer/stores/modalStore', () => ({
	useModalStore: vi.fn(() => null),
	selectModalData: vi.fn(() => () => null),
	getModalActions: () => ({
		updateAgentInboxData: mockUpdateAgentInboxData,
	}),
}));

vi.mock('../../../../renderer/utils/formatters', () => ({
	formatRelativeTime: vi.fn(() => '2m ago'),
}));

vi.mock('../../../../renderer/utils/shortcutFormatter', () => ({
	formatShortcutKeys: vi.fn((keys: string[]) => keys.join('+')),
	isMacOS: vi.fn(() => false),
}));

vi.mock('../../../../renderer/utils/markdownConfig', () => ({
	generateTerminalProseStyles: vi.fn(() => ''),
}));

// Mock MarkdownRenderer used in FocusModeView (named export)
vi.mock('../../../../renderer/components/MarkdownRenderer', () => ({
	MarkdownRenderer: ({ content }: { content: string }) => (
		<span data-testid="markdown">{content}</span>
	),
}));

// Mock @tanstack/react-virtual — return virtual items matching the item count
vi.mock('@tanstack/react-virtual', () => ({
	useVirtualizer: (opts: { count: number }) => ({
		getVirtualItems: () =>
			Array.from({ length: Math.min(opts.count, 50) }, (_, i) => ({
				index: i,
				start: i * 132,
				size: 132,
				key: `virtual-${i}`,
			})),
		getTotalSize: () => opts.count * 132,
		scrollToIndex: vi.fn(),
		measureElement: vi.fn(),
	}),
}));

// ---------------------------------------------------------------------------
// Import component AFTER mocks
// ---------------------------------------------------------------------------
import AgentInbox from '../../../../renderer/components/AgentInbox';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

const mockTheme: Theme = {
	id: 'dark',
	name: 'Dark',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		bgTerminal: '#1a1a2e',
		textMain: '#eaeaea',
		textDim: '#888',
		accent: '#e94560',
		accentForeground: '#ffffff',
		error: '#ff6b6b',
		border: '#333',
		success: '#4ecdc4',
		warning: '#ffd93d',
		terminalCursor: '#e94560',
	},
};

const makeTab = (overrides: Record<string, unknown> = {}) => ({
	id: `tab-${Math.random().toString(36).slice(2, 8)}`,
	agentSessionId: null,
	name: null,
	starred: false,
	logs: [{ id: 'log-1', timestamp: Date.now(), source: 'ai' as const, text: 'Hello world' }],
	inputValue: '',
	stagedImages: [],
	createdAt: 1000,
	state: 'idle' as const,
	hasUnread: true,
	...overrides,
});

const makeSession = (overrides: Partial<Session> = {}): Session =>
	({
		id: `s-${Math.random().toString(36).slice(2, 8)}`,
		name: 'Agent Alpha',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/test',
		fullPath: '/test',
		projectRoot: '/test',
		port: 0,
		aiPid: 0,
		terminalPid: 0,
		inputMode: 'ai',
		aiTabs: [makeTab()],
		activeTabId: 'default-tab',
		closedTabHistory: [],
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		executionQueue: [],
		contextUsage: 0,
		isGitRepo: false,
		changedFiles: [],
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		isLive: false,
		...overrides,
	}) as unknown as Session;

const makeGroup = (overrides: Partial<Group> = {}): Group => ({
	id: `g-${Math.random().toString(36).slice(2, 8)}`,
	name: 'Group',
	emoji: '',
	collapsed: false,
	...overrides,
});

// Default props factory
const createDefaultProps = (overrides: Record<string, unknown> = {}) => ({
	theme: mockTheme,
	sessions: [] as Session[],
	groups: [] as Group[],
	onClose: vi.fn(),
	onNavigateToSession: vi.fn(),
	onQuickReply: vi.fn(),
	onOpenAndReply: vi.fn(),
	onMarkAsRead: vi.fn(),
	onToggleThinking: vi.fn(),
	...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentInbox', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Mock requestAnimationFrame for auto-focus
		vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
			cb(0);
			return 0;
		});
		vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ====================================================================
	// 1. List mode renders inbox items
	// ====================================================================

	describe('list mode rendering', () => {
		it('renders the dialog with correct ARIA attributes', () => {
			const props = createDefaultProps();
			render(<AgentInbox {...props} />);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toBeInTheDocument();
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Unified Inbox');
		});

		it('renders inbox items from sessions', () => {
			const tab1 = makeTab({ id: 't1', hasUnread: true });
			const tab2 = makeTab({ id: 't2', hasUnread: true });
			const s1 = makeSession({ id: 's1', name: 'Agent One', aiTabs: [tab1] });
			const s2 = makeSession({ id: 's2', name: 'Agent Two', aiTabs: [tab2] });

			const props = createDefaultProps({ sessions: [s1, s2] });
			render(<AgentInbox {...props} />);

			// Items render with role="option"
			const options = screen.getAllByRole('option');
			expect(options.length).toBeGreaterThanOrEqual(2);
		});

		it('renders empty state when no sessions match filter', () => {
			const tab = makeTab({ id: 't1', hasUnread: false });
			const session = makeSession({ id: 's1', aiTabs: [tab] });

			// Default filter is 'unread' — a session with no unread tabs shows empty
			const props = createDefaultProps({ sessions: [session] });
			render(<AgentInbox {...props} />);

			const emptyState = screen.getByTestId('inbox-empty-state');
			expect(emptyState).toBeInTheDocument();
		});

		it('renders session names in item cards', () => {
			const tab = makeTab({ id: 't1', hasUnread: true });
			const session = makeSession({ id: 's1', name: 'Claude Worker', aiTabs: [tab] });

			const props = createDefaultProps({ sessions: [session] });
			render(<AgentInbox {...props} />);

			expect(screen.getByText('Claude Worker')).toBeInTheDocument();
		});
	});

	// ====================================================================
	// 2. Filter pills change visible items
	// ====================================================================

	describe('filter pills', () => {
		it('renders filter segmented control with All/Unread/Read/Starred options', () => {
			const props = createDefaultProps();
			render(<AgentInbox {...props} />);

			const filterControl = screen.getByLabelText('Filter agents');
			expect(within(filterControl).getByText('All')).toBeInTheDocument();
			expect(within(filterControl).getByText('Unread')).toBeInTheDocument();
			expect(within(filterControl).getByText('Read')).toBeInTheDocument();
			expect(within(filterControl).getByText('Starred')).toBeInTheDocument();
		});

		it('clicking "All" filter shows all items (unread + read)', () => {
			const tabUnread = makeTab({ id: 't1', hasUnread: true });
			const tabRead = makeTab({ id: 't2', hasUnread: false });
			const s1 = makeSession({ id: 's1', name: 'Unread Agent', aiTabs: [tabUnread] });
			const s2 = makeSession({ id: 's2', name: 'Read Agent', aiTabs: [tabRead] });

			const props = createDefaultProps({ sessions: [s1, s2] });
			render(<AgentInbox {...props} />);

			// Default filter is 'unread' — only unread tab shows
			const optionsBefore = screen.getAllByRole('option');
			expect(optionsBefore).toHaveLength(1);

			// Click 'All' filter (scoped to filter control)
			const filterControl = screen.getByLabelText('Filter agents');
			fireEvent.click(within(filterControl).getByText('All'));

			// Now both should be visible
			const optionsAfter = screen.getAllByRole('option');
			expect(optionsAfter).toHaveLength(2);
		});

		it('clicking "Starred" filter shows only starred items', () => {
			const tabStarred = makeTab({ id: 't1', hasUnread: true, starred: true });
			const tabNormal = makeTab({ id: 't2', hasUnread: true, starred: false });
			const s1 = makeSession({ id: 's1', name: 'Starred', aiTabs: [tabStarred] });
			const s2 = makeSession({ id: 's2', name: 'Normal', aiTabs: [tabNormal] });

			const props = createDefaultProps({ sessions: [s1, s2] });
			render(<AgentInbox {...props} />);

			// Click 'Starred' filter (scoped to filter control)
			const filterControl = screen.getByLabelText('Filter agents');
			fireEvent.click(within(filterControl).getByText('Starred'));

			const options = screen.getAllByRole('option');
			expect(options).toHaveLength(1);
		});

		it('clicking "Read" filter shows only non-unread items', () => {
			const tabUnread = makeTab({ id: 't1', hasUnread: true });
			const tabRead = makeTab({ id: 't2', hasUnread: false });
			const session = makeSession({ id: 's1', aiTabs: [tabUnread, tabRead] });

			const props = createDefaultProps({ sessions: [session] });
			render(<AgentInbox {...props} />);

			// Click 'Read' filter (scoped to filter control)
			const filterControl = screen.getByLabelText('Filter agents');
			fireEvent.click(within(filterControl).getByText('Read'));

			const options = screen.getAllByRole('option');
			expect(options).toHaveLength(1);
		});
	});

	// ====================================================================
	// 3. Keyboard navigation (up/down arrows, Enter to select)
	// ====================================================================

	describe('keyboard navigation', () => {
		it('ArrowDown moves selection to next item', () => {
			const tab1 = makeTab({ id: 't1', hasUnread: true });
			const tab2 = makeTab({ id: 't2', hasUnread: true });
			const s1 = makeSession({ id: 's1', name: 'First', aiTabs: [tab1] });
			const s2 = makeSession({ id: 's2', name: 'Second', aiTabs: [tab2] });

			const props = createDefaultProps({ sessions: [s1, s2] });
			render(<AgentInbox {...props} />);

			const listbox = screen.getByRole('listbox');

			// First item should be selected initially
			const optionsBefore = screen.getAllByRole('option');
			expect(optionsBefore[0]).toHaveAttribute('aria-selected', 'true');

			// Press ArrowDown on the listbox
			fireEvent.keyDown(listbox, { key: 'ArrowDown' });

			// Second item should now be selected
			const optionsAfter = screen.getAllByRole('option');
			expect(optionsAfter[1]).toHaveAttribute('aria-selected', 'true');
		});

		it('ArrowUp moves selection to previous item', () => {
			const tab1 = makeTab({ id: 't1', hasUnread: true });
			const tab2 = makeTab({ id: 't2', hasUnread: true });
			const s1 = makeSession({ id: 's1', name: 'First', aiTabs: [tab1] });
			const s2 = makeSession({ id: 's2', name: 'Second', aiTabs: [tab2] });

			const props = createDefaultProps({ sessions: [s1, s2] });
			render(<AgentInbox {...props} />);

			const listbox = screen.getByRole('listbox');

			// Move down first, then up
			fireEvent.keyDown(listbox, { key: 'ArrowDown' });
			fireEvent.keyDown(listbox, { key: 'ArrowUp' });

			const options = screen.getAllByRole('option');
			expect(options[0]).toHaveAttribute('aria-selected', 'true');
		});

		it('Enter on an item calls onNavigateToSession and onClose', () => {
			const tab = makeTab({ id: 't1', hasUnread: true });
			const session = makeSession({ id: 's1', name: 'Agent', aiTabs: [tab] });

			const onNavigate = vi.fn();
			const onClose = vi.fn();
			const props = createDefaultProps({
				sessions: [session],
				onNavigateToSession: onNavigate,
				onClose,
			});
			render(<AgentInbox {...props} />);

			const listbox = screen.getByRole('listbox');
			fireEvent.keyDown(listbox, { key: 'Enter' });

			expect(onNavigate).toHaveBeenCalledWith('s1', 't1');
			expect(onClose).toHaveBeenCalled();
		});
	});

	// ====================================================================
	// 4. Escape closes the modal
	// ====================================================================

	describe('Escape closes modal', () => {
		it('clicking overlay background calls onClose', () => {
			const onClose = vi.fn();
			const props = createDefaultProps({ onClose });
			render(<AgentInbox {...props} />);

			// The overlay is the outermost div with modal-overlay class
			const overlay = screen.getByRole('dialog').parentElement!;
			fireEvent.click(overlay);

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('clicking close button calls onClose', () => {
			const tab = makeTab({ id: 't1', hasUnread: true });
			const session = makeSession({ id: 's1', aiTabs: [tab] });
			const onClose = vi.fn();
			const props = createDefaultProps({ sessions: [session], onClose });
			render(<AgentInbox {...props} />);

			// Close button has title="Close (Esc)"
			const closeBtn = screen.getByTitle('Close (Esc)');
			fireEvent.click(closeBtn);

			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	// ====================================================================
	// 5. Focus mode entry (Enter or double-click)
	// ====================================================================

	describe('focus mode entry', () => {
		it('pressing F enters focus mode', () => {
			const tab = makeTab({ id: 't1', hasUnread: true });
			const session = makeSession({ id: 's1', name: 'Agent', aiTabs: [tab] });

			const props = createDefaultProps({ sessions: [session] });
			render(<AgentInbox {...props} />);

			const dialog = screen.getByRole('dialog');

			// Press F on the dialog container to enter focus mode
			fireEvent.keyDown(dialog, { key: 'f' });

			// In focus mode, the listbox disappears and focus view renders
			// We can detect focus mode by checking for the reply textarea
			const textarea = screen.queryByLabelText('Reply to agent');
			expect(textarea).toBeInTheDocument();
		});

		it('double-clicking an item enters focus mode', () => {
			const tab = makeTab({ id: 't1', hasUnread: true });
			const session = makeSession({ id: 's1', name: 'Agent', aiTabs: [tab] });

			const props = createDefaultProps({ sessions: [session] });
			render(<AgentInbox {...props} />);

			// Double-click the first option
			const option = screen.getByRole('option');
			fireEvent.doubleClick(option);

			// Should enter focus mode — reply textarea appears
			const textarea = screen.queryByLabelText('Reply to agent');
			expect(textarea).toBeInTheDocument();
		});

		it('Escape in focus mode returns to list mode', () => {
			const tab = makeTab({ id: 't1', hasUnread: true });
			const session = makeSession({ id: 's1', name: 'Agent', aiTabs: [tab] });

			const props = createDefaultProps({ sessions: [session] });
			render(<AgentInbox {...props} />);

			const dialog = screen.getByRole('dialog');

			// Enter focus mode
			fireEvent.keyDown(dialog, { key: 'f' });
			expect(screen.queryByLabelText('Reply to agent')).toBeInTheDocument();

			// Press Escape — should go back to list mode, not close
			fireEvent.keyDown(dialog, { key: 'Escape' });

			// Listbox should be back
			const listbox = screen.queryByRole('listbox');
			expect(listbox).toBeInTheDocument();
		});

		it('Backspace in focus mode (not in textarea) returns to list mode', () => {
			const tab = makeTab({ id: 't1', hasUnread: true });
			const session = makeSession({ id: 's1', name: 'Agent', aiTabs: [tab] });

			const props = createDefaultProps({ sessions: [session] });
			render(<AgentInbox {...props} />);

			const dialog = screen.getByRole('dialog');

			// Enter focus mode
			fireEvent.keyDown(dialog, { key: 'f' });
			expect(screen.queryByLabelText('Reply to agent')).toBeInTheDocument();

			// Focus the dialog container (not textarea) before pressing Backspace
			dialog.focus();

			// Press Backspace while dialog itself is focused (not textarea)
			fireEvent.keyDown(dialog, { key: 'Backspace' });

			// Should return to list mode
			const listbox = screen.queryByRole('listbox');
			expect(listbox).toBeInTheDocument();
		});
	});

	// ====================================================================
	// 6. Reply sends input to correct tab (simpler assertion)
	// ====================================================================

	describe('reply in focus mode', () => {
		it('renders reply textarea in focus mode', () => {
			const tab = makeTab({ id: 't1', hasUnread: true });
			const session = makeSession({ id: 's1', name: 'Agent', aiTabs: [tab] });

			const props = createDefaultProps({ sessions: [session] });
			render(<AgentInbox {...props} />);

			const dialog = screen.getByRole('dialog');
			fireEvent.keyDown(dialog, { key: 'f' });

			const textarea = screen.getByLabelText('Reply to agent');
			expect(textarea).toBeInTheDocument();
			expect(textarea.tagName).toBe('TEXTAREA');
		});
	});
});
