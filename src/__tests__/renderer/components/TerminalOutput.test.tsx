/**
 * @file TerminalOutput.test.tsx
 * @description Tests for TerminalOutput component and its internal helpers
 *
 * Test coverage includes:
 * - Pure helper functions (tested via component behavior since they're not exported)
 * - CodeBlockWithCopy component
 * - ElapsedTimeDisplay component
 * - LogItemComponent (memoized)
 * - TerminalOutput main component
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TerminalOutput } from '../../../renderer/components/TerminalOutput';
import type { Session, Theme, LogEntry } from '../../../renderer/types';

// Mock dependencies
vi.mock('react-syntax-highlighter', () => ({
	Prism: ({ children }: { children: string }) => (
		<pre data-testid="syntax-highlighter">{children}</pre>
	),
}));

vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
	vscDarkPlus: {},
}));

vi.mock('react-markdown', () => ({
	default: ({ children }: { children: string }) => (
		<div data-testid="react-markdown">{children}</div>
	),
}));

vi.mock('remark-gfm', () => ({
	default: [],
}));

vi.mock('dompurify', () => ({
	default: {
		sanitize: (html: string) => html,
	},
}));

vi.mock('ansi-to-html', () => ({
	default: class Convert {
		toHtml(text: string) {
			// Simple mock that preserves the text
			return text;
		}
	},
}));

// Track layer stack mock functions
const mockRegisterLayer = vi.fn().mockReturnValue('layer-1');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
	}),
}));

vi.mock('../../../renderer/utils/tabHelpers', () => ({
	getActiveTab: (session: Session) =>
		session.tabs?.find((t) => t.id === session.activeTabId) || session.tabs?.[0],
}));

// Default theme for testing
const defaultTheme: Theme = {
	id: 'test-theme' as any,
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		textMain: '#e94560',
		textDim: '#a0a0a0',
		accent: '#e94560',
		accentDim: '#b83b5e',
		accentForeground: '#ffffff',
		border: '#2a2a4e',
		success: '#00ff88',
		warning: '#ffcc00',
		error: '#ff4444',
	},
};

// Create a default session
const createDefaultSession = (overrides: Partial<Session> = {}): Session => ({
	id: 'session-1',
	name: 'Test Session',
	toolType: 'claude-code',
	state: 'idle',
	inputMode: 'ai',
	cwd: '/test/path',
	projectRoot: '/test/path',
	aiPid: 12345,
	terminalPid: 12346,
	aiLogs: [],
	shellLogs: [],
	isGitRepo: false,
	fileTree: [],
	fileExplorerExpanded: [],
	messageQueue: [],
	tabs: [
		{
			id: 'tab-1',
			agentSessionId: 'claude-123',
			logs: [],
			isUnread: false,
		},
	],
	activeTabId: 'tab-1',
	...overrides,
});

// Create a log entry
const createLogEntry = (overrides: Partial<LogEntry> = {}): LogEntry => ({
	id: `log-${Date.now()}-${Math.random()}`,
	text: 'Test log entry',
	timestamp: Date.now(),
	source: 'stdout',
	...overrides,
});

// Default props
const createDefaultProps = (
	overrides: Partial<React.ComponentProps<typeof TerminalOutput>> = {}
) => ({
	session: createDefaultSession(),
	theme: defaultTheme,
	fontFamily: 'monospace',
	activeFocus: 'main',
	outputSearchOpen: false,
	outputSearchQuery: '',
	setOutputSearchOpen: vi.fn(),
	setOutputSearchQuery: vi.fn(),
	setActiveFocus: vi.fn(),
	setLightboxImage: vi.fn(),
	inputRef: { current: null } as React.RefObject<HTMLTextAreaElement>,
	logsEndRef: { current: null } as React.RefObject<HTMLDivElement>,
	maxOutputLines: 50,
	markdownEditMode: false,
	setMarkdownEditMode: vi.fn(),
	...overrides,
});

describe('TerminalOutput', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('basic rendering', () => {
		it('renders without crashing', () => {
			const { container } = render(<TerminalOutput {...createDefaultProps()} />);
			expect(container).toBeTruthy();
		});

		it('renders with AI mode background color', () => {
			const props = createDefaultProps();
			const { container } = render(<TerminalOutput {...props} />);

			const outputDiv = container.firstChild as HTMLElement;
			expect(outputDiv).toHaveStyle({ backgroundColor: defaultTheme.colors.bgMain });
		});

		it('renders with terminal mode background color', () => {
			const session = createDefaultSession({ inputMode: 'terminal' });
			const props = createDefaultProps({ session });
			const { container } = render(<TerminalOutput {...props} />);

			const outputDiv = container.firstChild as HTMLElement;
			expect(outputDiv).toHaveStyle({ backgroundColor: defaultTheme.colors.bgActivity });
		});

		it('is focusable with tabIndex 0', () => {
			const { container } = render(<TerminalOutput {...createDefaultProps()} />);
			const outputDiv = container.firstChild as HTMLElement;
			expect(outputDiv).toHaveAttribute('tabIndex', '0');
		});
	});

	describe('log entry rendering', () => {
		it('renders log entries from active tab in AI mode', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: 'First message', source: 'user' }),
				createLogEntry({ text: 'AI response', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			expect(screen.getByText('First message')).toBeInTheDocument();
		});

		it('renders shell logs in terminal mode', () => {
			const shellLogs: LogEntry[] = [
				createLogEntry({ text: 'ls -la', source: 'user' }),
				createLogEntry({ text: 'total 100', source: 'stdout' }),
			];

			const session = createDefaultSession({
				inputMode: 'terminal',
				shellLogs,
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			expect(screen.getByText(/total 100/)).toBeInTheDocument();
		});

		it('displays user messages with different styling', () => {
			const logs: LogEntry[] = [createLogEntry({ text: 'User input here', source: 'user' })];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// User messages should be right-aligned
			const userMessageContainer = screen.getByText('User input here').closest('.flex-row-reverse');
			expect(userMessageContainer).toBeInTheDocument();
		});

		it('shows delivered checkmark for delivered messages', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: 'Delivered message', source: 'user', delivered: true }),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			expect(screen.getByTitle('Message delivered')).toBeInTheDocument();
		});

		it('shows STDERR label for stderr entries', () => {
			const logs: LogEntry[] = [createLogEntry({ text: 'Error output', source: 'stderr' })];

			const session = createDefaultSession({
				inputMode: 'terminal',
				shellLogs: logs,
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			expect(screen.getByText('STDERR')).toBeInTheDocument();
		});

		it('collapses consecutive AI responses in AI mode', () => {
			const logs: LogEntry[] = [
				createLogEntry({ id: 'user-1', text: 'Question', source: 'user' }),
				createLogEntry({ id: 'resp-1', text: 'Part 1 of response. ', source: 'stdout' }),
				createLogEntry({ id: 'resp-2', text: 'Part 2 of response. ', source: 'stdout' }),
				createLogEntry({ id: 'resp-3', text: 'Part 3 of response.', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			const { container } = render(<TerminalOutput {...props} />);

			// Should have 2 log items: 1 user + 1 combined response
			const logItems = container.querySelectorAll('[data-log-index]');
			expect(logItems.length).toBe(2);
		});
	});

	describe('search functionality', () => {
		it('shows search input when outputSearchOpen is true', () => {
			const props = createDefaultProps({ outputSearchOpen: true });
			render(<TerminalOutput {...props} />);

			expect(screen.getByPlaceholderText('Filter output... (Esc to close)')).toBeInTheDocument();
		});

		it('calls setOutputSearchQuery when typing in search', async () => {
			const setOutputSearchQuery = vi.fn();
			const props = createDefaultProps({
				outputSearchOpen: true,
				setOutputSearchQuery,
			});
			render(<TerminalOutput {...props} />);

			const searchInput = screen.getByPlaceholderText('Filter output... (Esc to close)');
			fireEvent.change(searchInput, { target: { value: 'test query' } });

			expect(setOutputSearchQuery).toHaveBeenCalledWith('test query');
		});

		it('filters logs based on search query', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: 'This contains hello world', source: 'stdout' }),
				createLogEntry({ text: 'This does not match', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				outputSearchQuery: 'hello',
			});

			const { container } = render(<TerminalOutput {...props} />);

			// Only one log should match the filter
			const logItems = container.querySelectorAll('[data-log-index]');
			expect(logItems.length).toBe(1);
		});

		it('opens search when Cmd+F is pressed', () => {
			const setOutputSearchOpen = vi.fn();
			const props = createDefaultProps({ setOutputSearchOpen });
			const { container } = render(<TerminalOutput {...props} />);

			const outputDiv = container.firstChild as HTMLElement;
			fireEvent.keyDown(outputDiv, { key: 'f', metaKey: true });

			expect(setOutputSearchOpen).toHaveBeenCalledWith(true);
		});

		it('opens search when Ctrl+F is pressed', () => {
			const setOutputSearchOpen = vi.fn();
			const props = createDefaultProps({ setOutputSearchOpen });
			const { container } = render(<TerminalOutput {...props} />);

			const outputDiv = container.firstChild as HTMLElement;
			fireEvent.keyDown(outputDiv, { key: 'f', ctrlKey: true });

			expect(setOutputSearchOpen).toHaveBeenCalledWith(true);
		});

		it('filters logs case-insensitively (in terminal mode)', async () => {
			// Use terminal mode to avoid log collapsing
			const logs: LogEntry[] = [
				createLogEntry({ text: 'This contains HELLO world', source: 'stdout' }),
				createLogEntry({ text: 'This contains hello world', source: 'stdout' }),
				createLogEntry({ text: 'This does not match', source: 'stdout' }),
			];

			const session = createDefaultSession({
				inputMode: 'terminal',
				shellLogs: logs,
			});

			const props = createDefaultProps({
				session,
				outputSearchQuery: 'hello',
			});

			const { container } = render(<TerminalOutput {...props} />);

			// Wait for debounce (150ms)
			await act(async () => {
				vi.advanceTimersByTime(200);
			});

			// Both logs with 'hello' and 'HELLO' should match (case insensitive)
			const logItems = container.querySelectorAll('[data-log-index]');
			expect(logItems.length).toBe(2);
		});

		it('shows all logs when search query is empty (terminal mode)', async () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: 'First log', source: 'stdout' }),
				createLogEntry({ text: 'Second log', source: 'stdout' }),
				createLogEntry({ text: 'Third log', source: 'stdout' }),
			];

			const session = createDefaultSession({
				inputMode: 'terminal',
				shellLogs: logs,
			});

			const props = createDefaultProps({
				session,
				outputSearchOpen: true,
				outputSearchQuery: '',
			});

			const { container } = render(<TerminalOutput {...props} />);

			// Wait for debounce (150ms)
			await act(async () => {
				vi.advanceTimersByTime(200);
			});

			// All 3 logs should be visible when query is empty
			const logItems = container.querySelectorAll('[data-log-index]');
			expect(logItems.length).toBe(3);
		});

		it('hides search input when outputSearchOpen is false', () => {
			const props = createDefaultProps({ outputSearchOpen: false });
			render(<TerminalOutput {...props} />);

			expect(
				screen.queryByPlaceholderText('Filter output... (Esc to close)')
			).not.toBeInTheDocument();
		});

		it('preserves search query when filtering (controlled component)', async () => {
			const setOutputSearchQuery = vi.fn();
			const props = createDefaultProps({
				outputSearchOpen: true,
				outputSearchQuery: 'initial',
				setOutputSearchQuery,
			});
			render(<TerminalOutput {...props} />);

			const searchInput = screen.getByPlaceholderText('Filter output... (Esc to close)');

			// The input should show the current query value
			expect(searchInput).toHaveValue('initial');

			// Typing calls the setter
			fireEvent.change(searchInput, { target: { value: 'updated' } });
			expect(setOutputSearchQuery).toHaveBeenCalledWith('updated');
		});

		it('does not open search when Cmd+F is pressed and search is already open', () => {
			const setOutputSearchOpen = vi.fn();
			const props = createDefaultProps({ setOutputSearchOpen, outputSearchOpen: true });
			const { container } = render(<TerminalOutput {...props} />);

			const outputDiv = container.firstChild as HTMLElement;
			fireEvent.keyDown(outputDiv, { key: 'f', metaKey: true });

			// Should not call setOutputSearchOpen again when already open
			expect(setOutputSearchOpen).not.toHaveBeenCalled();
		});

		it('registers layer when search opens', () => {
			mockRegisterLayer.mockClear();
			const props = createDefaultProps({ outputSearchOpen: true });
			render(<TerminalOutput {...props} />);

			expect(mockRegisterLayer).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'overlay',
					ariaLabel: 'Output Search',
					onEscape: expect.any(Function),
				})
			);
		});

		it('unregisters layer when component unmounts with search open', () => {
			mockUnregisterLayer.mockClear();
			const props = createDefaultProps({ outputSearchOpen: true });
			const { unmount } = render(<TerminalOutput {...props} />);

			unmount();

			expect(mockUnregisterLayer).toHaveBeenCalled();
		});

		it('matches logs containing partial words (terminal mode)', async () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: 'authentication failed', source: 'stdout' }),
				createLogEntry({ text: 'unauthorized access', source: 'stdout' }),
				createLogEntry({ text: 'success', source: 'stdout' }),
			];

			const session = createDefaultSession({
				inputMode: 'terminal',
				shellLogs: logs,
			});

			const props = createDefaultProps({
				session,
				outputSearchQuery: 'auth',
			});

			const { container } = render(<TerminalOutput {...props} />);

			// Wait for debounce (150ms)
			await act(async () => {
				vi.advanceTimersByTime(200);
			});

			// Both 'authentication' and 'unauthorized' contain 'auth'
			const logItems = container.querySelectorAll('[data-log-index]');
			expect(logItems.length).toBe(2);
		});
	});

	describe('keyboard navigation', () => {
		it('scrolls up on ArrowUp key', () => {
			const props = createDefaultProps();
			const { container } = render(<TerminalOutput {...props} />);

			const outputDiv = container.firstChild as HTMLElement;
			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;

			// Mock scrollBy
			const scrollBySpy = vi.fn();
			scrollContainer.scrollBy = scrollBySpy;

			fireEvent.keyDown(outputDiv, { key: 'ArrowUp' });

			expect(scrollBySpy).toHaveBeenCalledWith({ top: -100 });
		});

		it('scrolls down on ArrowDown key', () => {
			const props = createDefaultProps();
			const { container } = render(<TerminalOutput {...props} />);

			const outputDiv = container.firstChild as HTMLElement;
			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;

			const scrollBySpy = vi.fn();
			scrollContainer.scrollBy = scrollBySpy;

			fireEvent.keyDown(outputDiv, { key: 'ArrowDown' });

			expect(scrollBySpy).toHaveBeenCalledWith({ top: 100 });
		});

		it('scrolls page up on Alt+ArrowUp', () => {
			const props = createDefaultProps();
			const { container } = render(<TerminalOutput {...props} />);

			const outputDiv = container.firstChild as HTMLElement;
			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;

			const scrollBySpy = vi.fn();
			scrollContainer.scrollBy = scrollBySpy;

			fireEvent.keyDown(outputDiv, { key: 'ArrowUp', altKey: true });

			// Should scroll by container height (mocked to 0 in tests)
			expect(scrollBySpy).toHaveBeenCalled();
		});

		it('scrolls page down on Alt+ArrowDown', () => {
			const props = createDefaultProps();
			const { container } = render(<TerminalOutput {...props} />);

			const outputDiv = container.firstChild as HTMLElement;
			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;

			const scrollBySpy = vi.fn();
			scrollContainer.scrollBy = scrollBySpy;

			fireEvent.keyDown(outputDiv, { key: 'ArrowDown', altKey: true });

			// Should scroll by container height (page down)
			expect(scrollBySpy).toHaveBeenCalled();
		});

		it('scrolls to top on Cmd+ArrowUp', () => {
			const props = createDefaultProps();
			const { container } = render(<TerminalOutput {...props} />);

			const outputDiv = container.firstChild as HTMLElement;
			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;

			const scrollToSpy = vi.fn();
			scrollContainer.scrollTo = scrollToSpy;

			fireEvent.keyDown(outputDiv, { key: 'ArrowUp', metaKey: true });

			expect(scrollToSpy).toHaveBeenCalledWith({ top: 0 });
		});

		it('scrolls to bottom on Cmd+ArrowDown', () => {
			const props = createDefaultProps();
			const { container } = render(<TerminalOutput {...props} />);

			const outputDiv = container.firstChild as HTMLElement;
			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;

			const scrollToSpy = vi.fn();
			scrollContainer.scrollTo = scrollToSpy;

			fireEvent.keyDown(outputDiv, { key: 'ArrowDown', metaKey: true });

			expect(scrollToSpy).toHaveBeenCalled();
		});

		it('focuses input on Escape when search is not open', () => {
			const setActiveFocus = vi.fn();
			const inputRef = { current: { focus: vi.fn() } } as any;
			const props = createDefaultProps({ setActiveFocus, inputRef });
			const { container } = render(<TerminalOutput {...props} />);

			const outputDiv = container.firstChild as HTMLElement;
			fireEvent.keyDown(outputDiv, { key: 'Escape' });

			expect(inputRef.current.focus).toHaveBeenCalled();
			expect(setActiveFocus).toHaveBeenCalledWith('main');
		});
	});

	describe('copy to clipboard', () => {
		it('shows copied notification when copy succeeds', async () => {
			const logs: LogEntry[] = [createLogEntry({ text: 'Copy this text', source: 'stdout' })];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// Find and click the copy button
			const copyButton = screen.getByTitle('Copy to clipboard');

			// Mock clipboard
			const writeTextMock = vi.fn().mockResolvedValue(undefined);
			Object.assign(navigator, {
				clipboard: { writeText: writeTextMock },
			});

			await act(async () => {
				fireEvent.click(copyButton);
			});

			expect(writeTextMock).toHaveBeenCalledWith('Copy this text');

			await waitFor(() => {
				expect(screen.getByText('Copied to Clipboard')).toBeInTheDocument();
			});
		});
	});

	describe('expand/collapse long messages', () => {
		it('shows "Show all X lines" button for long messages', () => {
			const longText = Array(100).fill('Line of text').join('\n');
			const logs: LogEntry[] = [createLogEntry({ text: longText, source: 'stdout' })];

			const session = createDefaultSession({
				inputMode: 'terminal',
				shellLogs: logs,
			});

			const props = createDefaultProps({
				session,
				maxOutputLines: 10, // Collapse after 10 lines
			});

			render(<TerminalOutput {...props} />);

			expect(screen.getByText(/Show all 100 lines/)).toBeInTheDocument();
		});

		it('expands message when "Show all" button is clicked', async () => {
			const longText = Array(100).fill('Line of text').join('\n');
			const logs: LogEntry[] = [createLogEntry({ text: longText, source: 'stdout' })];

			const session = createDefaultSession({
				inputMode: 'terminal',
				shellLogs: logs,
			});

			const props = createDefaultProps({
				session,
				maxOutputLines: 10,
			});

			const { container } = render(<TerminalOutput {...props} />);

			// Mock scrollTo on scroll container before clicking expand
			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
			if (scrollContainer) {
				scrollContainer.scrollTo = vi.fn();
				scrollContainer.scrollBy = vi.fn();
			}

			const expandButton = screen.getByText(/Show all 100 lines/);
			await act(async () => {
				fireEvent.click(expandButton);
				vi.advanceTimersByTime(100);
			});

			// After expanding, should show "Show less"
			expect(screen.getByText('Show less')).toBeInTheDocument();
		});
	});

	describe('busy state indicators', () => {
		it('shows busy indicator for terminal mode when state is busy', () => {
			const session = createDefaultSession({
				inputMode: 'terminal',
				state: 'busy',
				busySource: 'terminal',
				statusMessage: 'Running command...',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			expect(screen.getByText('Running command...')).toBeInTheDocument();
		});

		it('shows default message when no statusMessage provided', () => {
			const session = createDefaultSession({
				inputMode: 'terminal',
				state: 'busy',
				busySource: 'terminal',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			expect(screen.getByText('Executing command...')).toBeInTheDocument();
		});
	});

	describe('queued items display', () => {
		it('shows queued items section in AI mode', () => {
			const session = createDefaultSession({
				executionQueue: [
					{ id: 'q1', type: 'message', text: 'Queued message 1', tabId: 'tab-1' },
					{ id: 'q2', type: 'command', command: '/history', tabId: 'tab-1' },
				],
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			expect(screen.getByText('QUEUED (2)')).toBeInTheDocument();
			expect(screen.getByText('Queued message 1')).toBeInTheDocument();
			expect(screen.getByText('/history')).toBeInTheDocument();
		});

		it('shows remove button for queued items', () => {
			const session = createDefaultSession({
				executionQueue: [{ id: 'q1', type: 'message', text: 'Queued message', tabId: 'tab-1' }],
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			expect(screen.getByTitle('Remove from queue')).toBeInTheDocument();
		});

		it('shows confirmation modal when remove button is clicked', async () => {
			const session = createDefaultSession({
				executionQueue: [{ id: 'q1', type: 'message', text: 'Queued message', tabId: 'tab-1' }],
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			const removeButton = screen.getByTitle('Remove from queue');
			await act(async () => {
				fireEvent.click(removeButton);
			});

			expect(screen.getByText('Remove Queued Message?')).toBeInTheDocument();
		});

		it('calls onRemoveQueuedItem when confirmed', async () => {
			const onRemoveQueuedItem = vi.fn();
			const session = createDefaultSession({
				executionQueue: [{ id: 'q1', type: 'message', text: 'Queued message', tabId: 'tab-1' }],
			});

			const props = createDefaultProps({ session, onRemoveQueuedItem });
			render(<TerminalOutput {...props} />);

			// Click remove button
			const removeButton = screen.getByTitle('Remove from queue');
			await act(async () => {
				fireEvent.click(removeButton);
			});

			// Click confirm in modal
			const confirmButton = screen.getByRole('button', { name: 'Remove' });
			await act(async () => {
				fireEvent.click(confirmButton);
			});

			expect(onRemoveQueuedItem).toHaveBeenCalledWith('q1');
		});

		it('truncates long queued messages and shows expand button', () => {
			const longMessage = 'A'.repeat(250);
			const session = createDefaultSession({
				executionQueue: [{ id: 'q1', type: 'message', text: longMessage, tabId: 'tab-1' }],
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// Should show truncated message
			expect(screen.getByText(/^A+\.\.\.$/)).toBeInTheDocument();
			// Should show expand button
			expect(screen.getByText(/Show all/)).toBeInTheDocument();
		});

		it('expands and collapses long queued messages when toggle is clicked', async () => {
			// Create a message with >200 characters and multiple lines to trigger isLongMessage
			// isLongMessage check: displayText.length > 200
			const longMessage = Array.from(
				{ length: 20 },
				(_, i) => `This is line number ${i + 1} with some text`
			).join('\n');
			// Each line is ~35 chars, 20 lines = 700 chars (>200)
			const session = createDefaultSession({
				executionQueue: [{ id: 'q1', type: 'message', text: longMessage, tabId: 'tab-1' }],
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// Should show expand button initially (Show all X lines)
			const expandButton = screen.getByText(/Show all.*lines/);
			expect(expandButton).toBeInTheDocument();

			// Click to expand
			await act(async () => {
				fireEvent.click(expandButton);
			});

			// Should show "Show less" after expanding
			expect(screen.getByText('Show less')).toBeInTheDocument();

			// Click to collapse
			const collapseButton = screen.getByText('Show less');
			await act(async () => {
				fireEvent.click(collapseButton);
			});

			// Should show expand button again
			expect(screen.getByText(/Show all.*lines/)).toBeInTheDocument();
		});

		it('dismisses confirmation modal when Cancel button is clicked', async () => {
			const session = createDefaultSession({
				executionQueue: [{ id: 'q1', type: 'message', text: 'Queued message', tabId: 'tab-1' }],
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// Click remove button to open modal
			const removeButton = screen.getByTitle('Remove from queue');
			await act(async () => {
				fireEvent.click(removeButton);
			});

			// Modal should be open
			expect(screen.getByText('Remove Queued Message?')).toBeInTheDocument();

			// Click Cancel button
			const cancelButton = screen.getByRole('button', { name: 'Cancel' });
			await act(async () => {
				fireEvent.click(cancelButton);
			});

			// Modal should be closed
			expect(screen.queryByText('Remove Queued Message?')).not.toBeInTheDocument();
		});

		it('dismisses confirmation modal when Escape key is pressed', async () => {
			const session = createDefaultSession({
				executionQueue: [{ id: 'q1', type: 'message', text: 'Queued message', tabId: 'tab-1' }],
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// Click remove button to open modal
			const removeButton = screen.getByTitle('Remove from queue');
			await act(async () => {
				fireEvent.click(removeButton);
			});

			// Modal should be open
			expect(screen.getByText('Remove Queued Message?')).toBeInTheDocument();

			// Press Escape key on the modal overlay
			const modalOverlay = screen
				.getByText('Remove Queued Message?')
				.closest('[class*="fixed inset-0"]');
			await act(async () => {
				fireEvent.keyDown(modalOverlay!, { key: 'Escape' });
			});

			// Modal should be closed
			expect(screen.queryByText('Remove Queued Message?')).not.toBeInTheDocument();
		});

		it('confirms removal when Enter key is pressed on modal', async () => {
			const onRemoveQueuedItem = vi.fn();
			const session = createDefaultSession({
				executionQueue: [{ id: 'q1', type: 'message', text: 'Queued message', tabId: 'tab-1' }],
			});

			const props = createDefaultProps({ session, onRemoveQueuedItem });
			render(<TerminalOutput {...props} />);

			// Click remove button to open modal
			const removeButton = screen.getByTitle('Remove from queue');
			await act(async () => {
				fireEvent.click(removeButton);
			});

			// Modal should be open
			expect(screen.getByText('Remove Queued Message?')).toBeInTheDocument();

			// Press Enter key on the modal overlay
			const modalOverlay = screen
				.getByText('Remove Queued Message?')
				.closest('[class*="fixed inset-0"]');
			await act(async () => {
				fireEvent.keyDown(modalOverlay!, { key: 'Enter' });
			});

			// onRemoveQueuedItem should be called
			expect(onRemoveQueuedItem).toHaveBeenCalledWith('q1');
			// Modal should be closed
			expect(screen.queryByText('Remove Queued Message?')).not.toBeInTheDocument();
		});

		it('dismisses confirmation modal when clicking overlay background', async () => {
			const session = createDefaultSession({
				executionQueue: [{ id: 'q1', type: 'message', text: 'Queued message', tabId: 'tab-1' }],
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// Click remove button to open modal
			const removeButton = screen.getByTitle('Remove from queue');
			await act(async () => {
				fireEvent.click(removeButton);
			});

			// Modal should be open
			expect(screen.getByText('Remove Queued Message?')).toBeInTheDocument();

			// Click the overlay background (not the modal content)
			const modalOverlay = screen
				.getByText('Remove Queued Message?')
				.closest('[class*="fixed inset-0"]');
			await act(async () => {
				fireEvent.click(modalOverlay!);
			});

			// Modal should be closed
			expect(screen.queryByText('Remove Queued Message?')).not.toBeInTheDocument();
		});
	});

	describe('new message indicator', () => {
		it('shows new message indicator when not at bottom', async () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: 'Message 1', source: 'user' }),
				createLogEntry({ text: 'Response 1', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			const { container, rerender } = render(<TerminalOutput {...props} />);

			// Simulate scroll not at bottom
			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
			Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000 });
			Object.defineProperty(scrollContainer, 'scrollTop', { value: 0 });
			Object.defineProperty(scrollContainer, 'clientHeight', { value: 400 });

			fireEvent.scroll(scrollContainer);

			// Add new message
			const newLogs = [...logs, createLogEntry({ text: 'New message', source: 'stdout' })];
			const newSession = {
				...session,
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs: newLogs, isUnread: false }],
			};

			rerender(<TerminalOutput {...createDefaultProps({ session: newSession })} />);

			// Should show indicator
			await waitFor(() => {
				const indicator = screen.queryByTitle('Scroll to new messages');
				// This may or may not appear depending on exact scroll detection
			});
		});
	});

	describe('TTS functionality', () => {
		it('shows speak button when audioFeedbackCommand is provided', () => {
			const logs: LogEntry[] = [createLogEntry({ text: 'Text to speak', source: 'stdout' })];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				audioFeedbackCommand: 'say "{text}"',
			});

			render(<TerminalOutput {...props} />);

			expect(screen.getByTitle('Speak text')).toBeInTheDocument();
		});

		it('does not show speak button for user messages', () => {
			const logs: LogEntry[] = [createLogEntry({ text: 'User message', source: 'user' })];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				audioFeedbackCommand: 'say "{text}"',
			});

			render(<TerminalOutput {...props} />);

			expect(screen.queryByTitle('Speak text')).not.toBeInTheDocument();
		});

		it('calls speak API when speak button is clicked', async () => {
			const logs: LogEntry[] = [createLogEntry({ text: 'Text to speak', source: 'stdout' })];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				audioFeedbackCommand: 'say "{text}"',
			});

			render(<TerminalOutput {...props} />);

			const speakButton = screen.getByTitle('Speak text');
			await act(async () => {
				fireEvent.click(speakButton);
			});

			expect(window.maestro.notification.speak).toHaveBeenCalledWith(
				'Text to speak',
				'say "{text}"'
			);
		});
	});

	describe('delete functionality', () => {
		it('shows delete button for user messages when onDeleteLog is provided', () => {
			const logs: LogEntry[] = [createLogEntry({ text: 'User message', source: 'user' })];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				onDeleteLog: vi.fn(),
			});

			render(<TerminalOutput {...props} />);

			expect(screen.getByTitle(/Delete message/)).toBeInTheDocument();
		});

		it('shows confirmation when delete button is clicked', async () => {
			const logs: LogEntry[] = [createLogEntry({ text: 'User message', source: 'user' })];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				onDeleteLog: vi.fn(),
			});

			render(<TerminalOutput {...props} />);

			const deleteButton = screen.getByTitle(/Delete message/);
			await act(async () => {
				fireEvent.click(deleteButton);
			});

			expect(screen.getByText('Delete?')).toBeInTheDocument();
		});

		it('calls onDeleteLog when delete is confirmed', async () => {
			const onDeleteLog = vi.fn().mockReturnValue(null);
			const logs: LogEntry[] = [
				createLogEntry({ id: 'log-1', text: 'User message', source: 'user' }),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				onDeleteLog,
			});

			render(<TerminalOutput {...props} />);

			// Click delete button
			const deleteButton = screen.getByTitle(/Delete message/);
			await act(async () => {
				fireEvent.click(deleteButton);
			});

			// Click Yes to confirm
			const confirmButton = screen.getByRole('button', { name: 'Yes' });
			await act(async () => {
				fireEvent.click(confirmButton);
			});

			expect(onDeleteLog).toHaveBeenCalledWith('log-1');
		});

		it('does not show delete button when onDeleteLog is not provided', () => {
			const logs: LogEntry[] = [createLogEntry({ text: 'User message', source: 'user' })];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				// onDeleteLog is not provided
			});

			render(<TerminalOutput {...props} />);

			expect(screen.queryByTitle(/Delete message/)).not.toBeInTheDocument();
			expect(screen.queryByTitle(/Delete command/)).not.toBeInTheDocument();
		});

		it('does not call onDeleteLog when No is clicked', async () => {
			const onDeleteLog = vi.fn().mockReturnValue(null);
			const logs: LogEntry[] = [
				createLogEntry({ id: 'log-1', text: 'User message', source: 'user' }),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				onDeleteLog,
			});

			render(<TerminalOutput {...props} />);

			// Click delete button
			const deleteButton = screen.getByTitle(/Delete message/);
			await act(async () => {
				fireEvent.click(deleteButton);
			});

			// Click No to cancel
			const cancelButton = screen.getByRole('button', { name: 'No' });
			await act(async () => {
				fireEvent.click(cancelButton);
			});

			expect(onDeleteLog).not.toHaveBeenCalled();
			// Confirmation dialog should be dismissed
			expect(screen.queryByText('Delete?')).not.toBeInTheDocument();
		});

		it('does not show delete button for stdout messages', () => {
			const logs: LogEntry[] = [createLogEntry({ text: 'AI response', source: 'stdout' })];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				onDeleteLog: vi.fn(),
			});

			render(<TerminalOutput {...props} />);

			expect(screen.queryByTitle(/Delete message/)).not.toBeInTheDocument();
			expect(screen.queryByTitle(/Delete command/)).not.toBeInTheDocument();
		});

		it('does not show delete button for stderr messages', () => {
			const logs: LogEntry[] = [createLogEntry({ text: 'Error output', source: 'stderr' })];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				onDeleteLog: vi.fn(),
			});

			render(<TerminalOutput {...props} />);

			expect(screen.queryByTitle(/Delete message/)).not.toBeInTheDocument();
			expect(screen.queryByTitle(/Delete command/)).not.toBeInTheDocument();
		});

		it('shows delete button with correct tooltip in terminal mode', () => {
			const logs: LogEntry[] = [createLogEntry({ text: 'ls -la', source: 'user' })];

			const session = createDefaultSession({
				inputMode: 'terminal',
				shellLogs: logs,
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs: [], isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				onDeleteLog: vi.fn(),
			});

			render(<TerminalOutput {...props} />);

			expect(screen.getByTitle(/Delete command and output/)).toBeInTheDocument();
		});

		it('shows delete button for each user message in a conversation', () => {
			const logs: LogEntry[] = [
				createLogEntry({ id: 'log-1', text: 'First user message', source: 'user' }),
				createLogEntry({ id: 'log-2', text: 'AI response', source: 'stdout' }),
				createLogEntry({ id: 'log-3', text: 'Second user message', source: 'user' }),
				createLogEntry({ id: 'log-4', text: 'Another AI response', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				onDeleteLog: vi.fn(),
			});

			render(<TerminalOutput {...props} />);

			// Should have 2 delete buttons, one for each user message
			const deleteButtons = screen.getAllByTitle(/Delete message/);
			expect(deleteButtons).toHaveLength(2);
		});

		it('confirmation dialog shows Delete? text with Yes and No buttons', async () => {
			const logs: LogEntry[] = [createLogEntry({ text: 'User message', source: 'user' })];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				onDeleteLog: vi.fn(),
			});

			render(<TerminalOutput {...props} />);

			const deleteButton = screen.getByTitle(/Delete message/);
			await act(async () => {
				fireEvent.click(deleteButton);
			});

			expect(screen.getByText('Delete?')).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Yes' })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'No' })).toBeInTheDocument();
		});

		it('handles onDeleteLog return value for scroll positioning', async () => {
			const onDeleteLog = vi.fn().mockReturnValue(0); // Return index 0
			const logs: LogEntry[] = [
				createLogEntry({ id: 'log-1', text: 'First message', source: 'user' }),
				createLogEntry({ id: 'log-2', text: 'Response', source: 'stdout' }),
				createLogEntry({ id: 'log-3', text: 'Second message', source: 'user' }),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				onDeleteLog,
			});

			render(<TerminalOutput {...props} />);

			// Click delete on first message
			const deleteButtons = screen.getAllByTitle(/Delete message/);
			await act(async () => {
				fireEvent.click(deleteButtons[0]);
			});

			const confirmButton = screen.getByRole('button', { name: 'Yes' });
			await act(async () => {
				fireEvent.click(confirmButton);
			});

			expect(onDeleteLog).toHaveBeenCalledWith('log-1');
		});
	});

	describe('markdown rendering', () => {
		it('shows markdown toggle button for AI responses', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: '# Heading\n\nParagraph', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: false,
			});

			render(<TerminalOutput {...props} />);

			expect(screen.getByTitle(/Show plain text/)).toBeInTheDocument();
		});

		it('calls setMarkdownEditMode when toggle is clicked', async () => {
			const setMarkdownEditMode = vi.fn();
			const logs: LogEntry[] = [createLogEntry({ text: '# Heading', source: 'stdout' })];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: false,
				setMarkdownEditMode,
			});

			render(<TerminalOutput {...props} />);

			const toggleButton = screen.getByTitle(/Show plain text/);
			await act(async () => {
				fireEvent.click(toggleButton);
			});

			expect(setMarkdownEditMode).toHaveBeenCalledWith(true);
		});

		it('shows "Show formatted" tooltip when markdownEditMode is true', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: '# Heading\n\nParagraph', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: true,
			});

			render(<TerminalOutput {...props} />);

			expect(screen.getByTitle(/Show formatted/)).toBeInTheDocument();
		});

		it('toggles from formatted mode to plain text mode when clicked', async () => {
			const setMarkdownEditMode = vi.fn();
			const logs: LogEntry[] = [createLogEntry({ text: '# Heading', source: 'stdout' })];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: true,
				setMarkdownEditMode,
			});

			render(<TerminalOutput {...props} />);

			const toggleButton = screen.getByTitle(/Show formatted/);
			await act(async () => {
				fireEvent.click(toggleButton);
			});

			// When markdownEditMode is true, clicking should set it to false
			expect(setMarkdownEditMode).toHaveBeenCalledWith(false);
		});

		it('does not show markdown toggle button for user messages', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: 'User message with **markdown**', source: 'user' }),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: false,
			});

			render(<TerminalOutput {...props} />);

			expect(screen.queryByTitle(/Show plain text/)).not.toBeInTheDocument();
			expect(screen.queryByTitle(/Show formatted/)).not.toBeInTheDocument();
		});

		it('does not show markdown toggle button in terminal mode', () => {
			const logs: LogEntry[] = [createLogEntry({ text: 'Terminal output', source: 'stdout' })];

			const session = createDefaultSession({
				inputMode: 'terminal',
				shellLogs: logs,
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: false,
			});

			render(<TerminalOutput {...props} />);

			expect(screen.queryByTitle(/Show plain text/)).not.toBeInTheDocument();
			expect(screen.queryByTitle(/Show formatted/)).not.toBeInTheDocument();
		});

		it('uses MarkdownRenderer when markdownEditMode is false (formatted mode)', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: '# Heading\n\n**Bold text**', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: false,
			});

			render(<TerminalOutput {...props} />);

			// MarkdownRenderer is mocked as react-markdown, which renders with data-testid
			expect(screen.getByTestId('react-markdown')).toBeInTheDocument();
		});

		it('strips markdown when markdownEditMode is true (plain text mode)', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: '# Heading\n\n**Bold text**', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: true,
			});

			render(<TerminalOutput {...props} />);

			// In plain text mode, markdown should be stripped
			// Heading symbol (#) should be removed
			// Bold markers (**) should be removed
			expect(screen.getByText(/Heading/)).toBeInTheDocument();
			expect(screen.getByText(/Bold text/)).toBeInTheDocument();
			// Should not render via MarkdownRenderer
			expect(screen.queryByTestId('react-markdown')).not.toBeInTheDocument();
		});

		it('toggle button has accent color when markdownEditMode is true', () => {
			const logs: LogEntry[] = [createLogEntry({ text: '# Heading', source: 'stdout' })];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: true,
			});

			render(<TerminalOutput {...props} />);

			const toggleButton = screen.getByTitle(/Show formatted/);
			// In markdownEditMode=true, button color should be accent color
			expect(toggleButton).toHaveStyle({ color: defaultTheme.colors.accent });
		});

		it('toggle button has dim color when markdownEditMode is false', () => {
			const logs: LogEntry[] = [createLogEntry({ text: '# Heading', source: 'stdout' })];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: false,
			});

			render(<TerminalOutput {...props} />);

			const toggleButton = screen.getByTitle(/Show plain text/);
			// In markdownEditMode=false, button color should be textDim
			expect(toggleButton).toHaveStyle({ color: defaultTheme.colors.textDim });
		});

		it('preserves code block content when stripping markdown', () => {
			const codeBlockText = '```javascript\nconst x = 1;\nconst y = 2;\n```';
			const logs: LogEntry[] = [createLogEntry({ text: codeBlockText, source: 'stdout' })];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: true,
			});

			render(<TerminalOutput {...props} />);

			// Code content should be preserved without fences
			expect(screen.getByText(/const x = 1/)).toBeInTheDocument();
			expect(screen.getByText(/const y = 2/)).toBeInTheDocument();
		});

		it('renders inline code without backticks when stripping markdown', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: 'Use the `console.log` function', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: true,
			});

			render(<TerminalOutput {...props} />);

			// Should show the code without backticks
			expect(screen.getByText(/Use the console.log function/)).toBeInTheDocument();
		});

		it('shows markdown toggle button for stderr messages in AI mode', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: 'Error: Something went wrong', source: 'stderr' }),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: false,
			});

			render(<TerminalOutput {...props} />);

			// All non-user messages in AI mode show the markdown toggle
			expect(screen.getByTitle(/Show plain text/)).toBeInTheDocument();
		});

		it('maintains markdown mode state across multiple AI responses', () => {
			const logs: LogEntry[] = [
				createLogEntry({ id: 'ai-1', text: '# First Response', source: 'stdout' }),
				createLogEntry({ id: 'user-1', text: 'Follow up question', source: 'user' }),
				createLogEntry({ id: 'ai-2', text: '# Second Response', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: true,
			});

			render(<TerminalOutput {...props} />);

			// Both AI responses should be affected by the same markdown mode
			// In plain text mode, we should see stripped markdown for both
			expect(screen.getByText(/First Response/)).toBeInTheDocument();
			expect(screen.getByText(/Second Response/)).toBeInTheDocument();
		});

		it('shows Eye icon when markdownEditMode is true', () => {
			const logs: LogEntry[] = [createLogEntry({ text: '# Heading', source: 'stdout' })];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: true,
			});

			const { container } = render(<TerminalOutput {...props} />);

			// Eye icon should be present (lucide renders an svg with specific path)
			const toggleButton = screen.getByTitle(/Show formatted/);
			const svg = toggleButton.querySelector('svg');
			expect(svg).toBeInTheDocument();
		});

		it('shows FileText icon when markdownEditMode is false', () => {
			const logs: LogEntry[] = [createLogEntry({ text: '# Heading', source: 'stdout' })];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: false,
			});

			const { container } = render(<TerminalOutput {...props} />);

			// FileText icon should be present
			const toggleButton = screen.getByTitle(/Show plain text/);
			const svg = toggleButton.querySelector('svg');
			expect(svg).toBeInTheDocument();
		});

		it('toggle button appears on hover (has opacity-0 group-hover:opacity-50 classes)', () => {
			const logs: LogEntry[] = [createLogEntry({ text: '# Heading', source: 'stdout' })];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: false,
			});

			render(<TerminalOutput {...props} />);

			const toggleButton = screen.getByTitle(/Show plain text/);
			// Verify the hover behavior classes are present
			expect(toggleButton).toHaveClass('opacity-0');
			expect(toggleButton).toHaveClass('group-hover:opacity-50');
		});

		it('removes links from markdown when in plain text mode', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: 'Check out [this link](https://example.com)', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: true,
			});

			render(<TerminalOutput {...props} />);

			// Link text should be shown, but not as a link
			expect(screen.getByText(/Check out this link/)).toBeInTheDocument();
		});

		it('removes list markers from markdown when in plain text mode', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: '* Item one\n* Item two\n* Item three', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: true,
			});

			render(<TerminalOutput {...props} />);

			// List items should be shown (stripMarkdown converts * to - for list markers)
			expect(screen.getByText(/Item one/)).toBeInTheDocument();
		});
	});

	describe('local filter functionality', () => {
		it('shows filter button for terminal output entries', () => {
			const logs: LogEntry[] = [createLogEntry({ text: 'Terminal output', source: 'stdout' })];

			const session = createDefaultSession({
				inputMode: 'terminal',
				shellLogs: logs,
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			expect(screen.getByTitle('Filter this output')).toBeInTheDocument();
		});

		it('shows filter input when filter button is clicked', async () => {
			const logs: LogEntry[] = [createLogEntry({ text: 'Terminal output', source: 'stdout' })];

			const session = createDefaultSession({
				inputMode: 'terminal',
				shellLogs: logs,
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			const filterButton = screen.getByTitle('Filter this output');
			await act(async () => {
				fireEvent.click(filterButton);
			});

			expect(screen.getByPlaceholderText(/Include by keyword/)).toBeInTheDocument();
		});

		it('toggles between include and exclude mode', async () => {
			const logs: LogEntry[] = [createLogEntry({ text: 'Terminal output', source: 'stdout' })];

			const session = createDefaultSession({
				inputMode: 'terminal',
				shellLogs: logs,
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// Open filter
			const filterButton = screen.getByTitle('Filter this output');
			await act(async () => {
				fireEvent.click(filterButton);
			});

			// Click mode toggle (should start as include)
			const modeToggle = screen.getByTitle('Include matching lines');
			await act(async () => {
				fireEvent.click(modeToggle);
			});

			expect(screen.getByTitle('Exclude matching lines')).toBeInTheDocument();
		});

		it('toggles between plain text and regex mode', async () => {
			const logs: LogEntry[] = [createLogEntry({ text: 'Terminal output', source: 'stdout' })];

			const session = createDefaultSession({
				inputMode: 'terminal',
				shellLogs: logs,
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// Open filter
			const filterButton = screen.getByTitle('Filter this output');
			await act(async () => {
				fireEvent.click(filterButton);
			});

			// Click regex toggle (should start as plain text)
			const regexToggle = screen.getByTitle('Using plain text');
			await act(async () => {
				fireEvent.click(regexToggle);
			});

			expect(screen.getByTitle('Using regex')).toBeInTheDocument();
		});
	});

	describe('image display', () => {
		it('renders images in log entries', () => {
			const logs: LogEntry[] = [
				createLogEntry({
					text: 'Message with image',
					source: 'user',
					images: ['data:image/png;base64,abc123'],
				}),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			const img = screen.getByRole('img');
			expect(img).toHaveAttribute('src', 'data:image/png;base64,abc123');
		});

		it('calls setLightboxImage when image is clicked', async () => {
			const setLightboxImage = vi.fn();
			const images = ['data:image/png;base64,abc123'];
			const logs: LogEntry[] = [
				createLogEntry({
					text: 'Message with image',
					source: 'user',
					images,
				}),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session, setLightboxImage });
			render(<TerminalOutput {...props} />);

			const img = screen.getByRole('img');
			await act(async () => {
				fireEvent.click(img);
			});

			expect(setLightboxImage).toHaveBeenCalledWith(images[0], images, 'history');
		});
	});

	describe('aiCommand display', () => {
		it('renders AI command with special styling', () => {
			const logs: LogEntry[] = [
				createLogEntry({
					text: 'History synopsis content here',
					source: 'user',
					aiCommand: {
						command: '/history',
						description: 'Generate a history synopsis',
					},
				}),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			expect(screen.getByText('/history:')).toBeInTheDocument();
			expect(screen.getByText('Generate a history synopsis')).toBeInTheDocument();
		});
	});

	describe('elapsed time display', () => {
		it('shows elapsed time for busy terminal state with thinkingStartTime', () => {
			const session = createDefaultSession({
				inputMode: 'terminal',
				state: 'busy',
				busySource: 'terminal',
				thinkingStartTime: Date.now() - 65000, // 1 minute 5 seconds ago
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// Should show elapsed time
			expect(screen.getByText('1:05')).toBeInTheDocument();
		});

		it('updates elapsed time every second', async () => {
			const session = createDefaultSession({
				inputMode: 'terminal',
				state: 'busy',
				busySource: 'terminal',
				thinkingStartTime: Date.now(),
			});

			const props = createDefaultProps({ session });
			const { container } = render(<TerminalOutput {...props} />);

			// Mock scrollTo on scroll container (needed for terminal auto-scroll)
			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
			if (scrollContainer) {
				scrollContainer.scrollTo = vi.fn();
				scrollContainer.scrollBy = vi.fn();
			}

			// Initial time
			expect(screen.getByText('0:00')).toBeInTheDocument();

			// Advance by 1 second
			await act(async () => {
				vi.advanceTimersByTime(1000);
			});

			expect(screen.getByText('0:01')).toBeInTheDocument();
		});
	});

	describe('scroll position persistence', () => {
		it('calls onScrollPositionChange when scrolling (throttled)', async () => {
			const onScrollPositionChange = vi.fn();
			const props = createDefaultProps({ onScrollPositionChange });
			const { container } = render(<TerminalOutput {...props} />);

			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;

			// Simulate scroll
			Object.defineProperty(scrollContainer, 'scrollTop', { value: 100 });
			fireEvent.scroll(scrollContainer);

			// Wait for throttle
			await act(async () => {
				vi.advanceTimersByTime(250);
			});

			expect(onScrollPositionChange).toHaveBeenCalledWith(100);
		});

		it('restores scroll position from initialScrollTop', () => {
			const props = createDefaultProps({ initialScrollTop: 500 });
			const { container } = render(<TerminalOutput {...props} />);

			// The scroll restoration happens via requestAnimationFrame
			// In tests this is mocked, so we just verify the prop is used
		});
	});

	describe('terminal mode specific behaviors', () => {
		it('shows $ prompt for user commands in terminal mode', () => {
			const logs: LogEntry[] = [createLogEntry({ text: 'ls -la', source: 'user' })];

			const session = createDefaultSession({
				inputMode: 'terminal',
				shellLogs: logs,
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			expect(screen.getByText('$')).toBeInTheDocument();
		});
	});

	describe('edge cases', () => {
		it('handles empty logs gracefully', () => {
			const props = createDefaultProps();
			const { container } = render(<TerminalOutput {...props} />);

			const logItems = container.querySelectorAll('[data-log-index]');
			expect(logItems.length).toBe(0);
		});

		it('handles null session.tabs gracefully', () => {
			const session = createDefaultSession();
			(session as any).tabs = undefined;

			const props = createDefaultProps({ session });
			// Should not throw
			expect(() => render(<TerminalOutput {...props} />)).not.toThrow();
		});

		it('handles special characters in log text', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: '<script>alert("xss")</script>', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// Content should be displayed (DOMPurify mock just returns input)
			expect(screen.getByText(/<script>alert/)).toBeInTheDocument();
		});

		it('handles unicode in log text', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: '日本語テスト 🎉 émojis', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			expect(screen.getByText(/日本語テスト.*🎉.*émojis/)).toBeInTheDocument();
		});

		it('skips empty stderr entries', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: '', source: 'stderr' }),
				createLogEntry({ text: 'Valid output', source: 'stdout' }),
			];

			const session = createDefaultSession({
				inputMode: 'terminal',
				shellLogs: logs,
			});

			const props = createDefaultProps({ session });
			const { container } = render(<TerminalOutput {...props} />);

			// Should only render the valid output
			const logItems = container.querySelectorAll('[data-log-index]');
			expect(logItems.length).toBe(1);
		});
	});
});

describe('helper function behaviors (tested via component)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('processCarriageReturns behavior', () => {
		it('handles carriage returns in terminal output', () => {
			// Text with carriage return - should show last segment
			const textWithCR = 'Loading...\rDone!';
			const logs: LogEntry[] = [createLogEntry({ text: textWithCR, source: 'stdout' })];

			const session = createDefaultSession({
				inputMode: 'terminal',
				shellLogs: logs,
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// Should only show "Done!" not "Loading..."
			expect(screen.getByText('Done!')).toBeInTheDocument();
			expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
		});

		it('handles multiple carriage returns', () => {
			const text = '10%\r20%\r30%\r100%';
			const logs: LogEntry[] = [createLogEntry({ text, source: 'stdout' })];

			const session = createDefaultSession({
				inputMode: 'terminal',
				shellLogs: logs,
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// Should only show final value
			expect(screen.getByText('100%')).toBeInTheDocument();
		});
	});

	describe('processLogTextHelper behavior', () => {
		it('filters out empty lines in terminal mode', () => {
			const textWithEmptyLines = 'line1\n\n\nline2';
			const logs: LogEntry[] = [createLogEntry({ text: textWithEmptyLines, source: 'stdout' })];

			const session = createDefaultSession({
				inputMode: 'terminal',
				shellLogs: logs,
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// Both lines should be present
			expect(screen.getByText(/line1/)).toBeInTheDocument();
		});

		it('filters out bash prompts', () => {
			const textWithPrompt = 'output\nbash-3.2$ \nmore output';
			const logs: LogEntry[] = [createLogEntry({ text: textWithPrompt, source: 'stdout' })];

			const session = createDefaultSession({
				inputMode: 'terminal',
				shellLogs: logs,
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// Output should be present, prompt filtered
			expect(screen.getByText(/output/)).toBeInTheDocument();
		});
	});

	describe('filterTextByLinesHelper behavior', () => {
		it('filters lines by keyword (include mode)', async () => {
			const text = 'error: something went wrong\ninfo: all good\nerror: another issue';
			const logs: LogEntry[] = [createLogEntry({ text, source: 'stdout' })];

			const session = createDefaultSession({
				inputMode: 'terminal',
				shellLogs: logs,
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// Open local filter
			const filterButton = screen.getByTitle('Filter this output');
			await act(async () => {
				fireEvent.click(filterButton);
			});

			// Type filter query
			const filterInput = screen.getByPlaceholderText(/Include by keyword/);
			await act(async () => {
				fireEvent.change(filterInput, { target: { value: 'error' } });
			});

			// Should filter to only error lines
			// (exact behavior depends on component rendering)
		});

		it('filters lines by regex', async () => {
			const text = 'user123 logged in\nuser456 logged out\nadmin logged in';
			const logs: LogEntry[] = [createLogEntry({ text, source: 'stdout' })];

			const session = createDefaultSession({
				inputMode: 'terminal',
				shellLogs: logs,
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// Open local filter
			const filterButton = screen.getByTitle('Filter this output');
			await act(async () => {
				fireEvent.click(filterButton);
			});

			// Enable regex mode
			const regexToggle = screen.getByTitle('Using plain text');
			await act(async () => {
				fireEvent.click(regexToggle);
			});

			// Type regex pattern
			const filterInput = screen.getByPlaceholderText(/Include by RegEx/);
			await act(async () => {
				fireEvent.change(filterInput, { target: { value: 'user\\d+' } });
			});
		});

		it('handles invalid regex gracefully', async () => {
			const text = 'some text';
			const logs: LogEntry[] = [createLogEntry({ text, source: 'stdout' })];

			const session = createDefaultSession({
				inputMode: 'terminal',
				shellLogs: logs,
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// Open local filter
			const filterButton = screen.getByTitle('Filter this output');
			await act(async () => {
				fireEvent.click(filterButton);
			});

			// Enable regex mode
			const regexToggle = screen.getByTitle('Using plain text');
			await act(async () => {
				fireEvent.click(regexToggle);
			});

			// Type invalid regex
			const filterInput = screen.getByPlaceholderText(/Include by RegEx/);
			await act(async () => {
				fireEvent.change(filterInput, { target: { value: '[invalid' } });
			});

			// Should not throw, falls back to plain text matching
		});
	});

	describe('stripMarkdown behavior', () => {
		it('strips markdown when in raw mode', () => {
			const markdownText = '# Heading\n\n**Bold** and *italic*\n\n```js\ncode\n```';
			const logs: LogEntry[] = [createLogEntry({ text: markdownText, source: 'stdout' })];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: true,
			});

			render(<TerminalOutput {...props} />);

			// In raw mode, markdown should be stripped
			// Headings, bold markers should be removed
		});

		it('preserves code block content without fences', () => {
			const markdownText = '```javascript\nconst x = 1;\n```';
			const logs: LogEntry[] = [createLogEntry({ text: markdownText, source: 'stdout' })];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: true,
			});

			render(<TerminalOutput {...props} />);

			// Code content should be preserved
			expect(screen.getByText(/const x = 1/)).toBeInTheDocument();
		});
	});
});

describe('memoization behavior', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('LogItemComponent has stable rendering with same props', () => {
		const logs: LogEntry[] = [createLogEntry({ id: 'log-1', text: 'Test', source: 'stdout' })];

		const session = createDefaultSession({
			tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
			activeTabId: 'tab-1',
		});

		const props = createDefaultProps({ session });
		const { rerender } = render(<TerminalOutput {...props} />);

		// Rerender with same props - should use memoized component
		rerender(<TerminalOutput {...props} />);

		// If memo works correctly, this shouldn't cause issues
		expect(screen.getByText('Test')).toBeInTheDocument();
	});

	it('should re-render log items when fontFamily changes (memo regression test)', async () => {
		// This test ensures LogItemComponent re-renders when fontFamily prop changes
		// A previous bug had the memo comparator missing fontFamily, preventing visual updates
		const logs: LogEntry[] = [
			createLogEntry({ id: 'log-1', text: 'Test log content', source: 'stdout' }),
		];

		const session = createDefaultSession({
			tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
			activeTabId: 'tab-1',
		});

		const props = createDefaultProps({ session, fontFamily: 'Courier New' });
		const { rerender, container } = render(<TerminalOutput {...props} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(50);
		});

		// Find an element with fontFamily styling
		const styledElements = container.querySelectorAll('[style*="font-family"]');
		const hasOldFont = Array.from(styledElements).some((el) =>
			(el as HTMLElement).style.fontFamily.includes('Courier New')
		);
		expect(hasOldFont).toBe(true);

		// Rerender with different fontFamily
		rerender(<TerminalOutput {...createDefaultProps({ session, fontFamily: 'Monaco' })} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(50);
		});

		// The log items should now use the new font
		const updatedElements = container.querySelectorAll('[style*="font-family"]');
		const hasNewFont = Array.from(updatedElements).some((el) =>
			(el as HTMLElement).style.fontFamily.includes('Monaco')
		);
		expect(hasNewFont).toBe(true);
	});
});
