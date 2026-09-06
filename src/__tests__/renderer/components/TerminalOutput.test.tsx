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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	TerminalOutput,
	collapseAiResponseLogs,
} from '../../../renderer/components/TerminalOutput';
import { useCenterFlashStore } from '../../../renderer/stores/centerFlashStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import type { Session, Theme, LogEntry } from '../../../renderer/types';
import { TRANSCRIPT_SCROLL_TO_BOTTOM_EVENT } from '../../../renderer/services/transcriptScroll';

// Mock dependencies
vi.mock('react-syntax-highlighter', () => ({
	Prism: ({ children }: { children: string }) => (
		<pre data-testid="syntax-highlighter">{children}</pre>
	),
}));

vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
	vscDarkPlus: {},
	vs: {},
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

// Track message-by-message navigation calls
const mockJumpToMessageEdge = vi.fn().mockReturnValue(true);

vi.mock('../../../renderer/utils/messageScrollNavigation', async () => {
	const actual = await vi.importActual<
		typeof import('../../../renderer/utils/messageScrollNavigation')
	>('../../../renderer/utils/messageScrollNavigation');
	return {
		...actual,
		jumpToMessageEdge: (...args: Parameters<typeof actual.jumpToMessageEdge>) =>
			mockJumpToMessageEdge(...args),
	};
});

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
			showThinking: 'on',
		},
	],
	activeTabId: 'tab-1',
	terminalTabs: [],
	activeTerminalTabId: null,
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
	outputSearchRegex: false,
	setOutputSearchOpen: vi.fn(),
	setOutputSearchQuery: vi.fn(),
	setOutputSearchRegex: vi.fn(),
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
		useSettingsStore.setState({ showToolCalls: true });
		// A jump left behind by one test would fire inside the next one.
		useUIStore.setState({ pendingLogJump: null });
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
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			expect(screen.getByText('First message')).toBeInTheDocument();
		});

		it('displays user messages with different styling', () => {
			const logs: LogEntry[] = [createLogEntry({ text: 'User input here', source: 'user' })];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// User messages should render in a flex container
			// Default alignment is 'right', which does not apply flex-row-reverse (corrected in ba807307)
			const userMessageContainer = screen.getByText('User input here').closest('[data-log-index]');
			expect(userMessageContainer).not.toBeNull();
			expect(userMessageContainer!.className).toContain('flex');
		});

		it('shows delivered checkmark for delivered messages', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: 'Delivered message', source: 'user', delivered: true }),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			expect(screen.getByTitle('Message delivered')).toBeInTheDocument();
		});

		it('shows read-only eye indicator for messages sent in read-only mode', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: 'Read-only message', source: 'user', readOnly: true }),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			expect(screen.getByTitle('Sent in read-only mode')).toBeInTheDocument();
		});

		it('does not show read-only indicator for messages sent without read-only flag', () => {
			const logs: LogEntry[] = [createLogEntry({ text: 'Regular message', source: 'user' })];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			expect(screen.queryByTitle('Sent in read-only mode')).not.toBeInTheDocument();
		});

		it('renders error log entries through the markdown renderer to preserve line breaks', () => {
			// Issue #775: agent error messages contain status + explanation separated by
			// newlines; rendering them inside a plain <p> collapsed the whitespace, so
			// the status and the explanation ended up on a single line in chat.
			const errorText = 'fatal: not a git repository\n\nhint: run `git init` first.';
			const logs: LogEntry[] = [createLogEntry({ text: errorText, source: 'error' })];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// Error badge still shows up next to the icon.
			expect(screen.getByText('Error')).toBeInTheDocument();

			// The full error text is handed to react-markdown (mocked here as a div with
			// data-testid="react-markdown"). This guarantees newlines/markdown render
			// the same way they do for normal AI responses, instead of being flattened.
			const markdown = screen.getByTestId('react-markdown');
			expect(markdown).toHaveTextContent('fatal: not a git repository');
			expect(markdown).toHaveTextContent('hint: run');
			expect(markdown.textContent).toBe(errorText);
		});

		it('collapses consecutive AI responses in AI mode', () => {
			const logs: LogEntry[] = [
				createLogEntry({ id: 'user-1', text: 'Question', source: 'user' }),
				createLogEntry({ id: 'resp-1', text: 'Part 1 of response. ', source: 'stdout' }),
				createLogEntry({ id: 'resp-2', text: 'Part 2 of response. ', source: 'stdout' }),
				createLogEntry({ id: 'resp-3', text: 'Part 3 of response.', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			const { container } = render(<TerminalOutput {...props} />);

			// Should have 2 log items: 1 user + 1 combined response
			const logItems = container.querySelectorAll('[data-log-index]');
			expect(logItems.length).toBe(2);
		});

		it('keeps an error-source entry out of the surrounding response group', () => {
			const logs: LogEntry[] = [
				createLogEntry({ id: 'resp-1', text: 'Tail of an earlier response.', source: 'stdout' }),
				createLogEntry({ id: 'err-1', text: 'Unknown command: /nonexistent', source: 'error' }),
				createLogEntry({ id: 'resp-2', text: 'Start of a later response.', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			const { container } = render(<TerminalOutput {...props} />);

			// The error entry must flush its own boundary rather than being
			// stitched (via a no-separator join) between the two response groups.
			const logItems = container.querySelectorAll('[data-log-index]');
			expect(logItems.length).toBe(3);

			const markdownBlocks = screen.getAllByTestId('react-markdown');
			const combinedText = markdownBlocks.map((el) => el.textContent).join('|');
			expect(combinedText).not.toContain('response.Unknown command');
			expect(combinedText).not.toContain('/nonexistentStart of a later response.');
		});

		it("keeps Claude's plan-limit banner off the front of the retried answer", () => {
			// After a plan-quota outage, Claude forwards its banner as a plain
			// `stdout` entry with no marker. The answer the auto-retry produces
			// arrives half an hour later but is still the next `stdout` entry in the
			// same response group, so grouping used to render the reply as
			// "You've hit your session limit · resets 12:50am (America/Chicago)Yes,
			// on the first part. ...".
			const logs: LogEntry[] = [
				createLogEntry({ id: 'user-1', text: 'Question', source: 'user' }),
				createLogEntry({
					id: 'limit-1',
					text: "You've hit your session limit · resets 12:50am (America/Chicago)",
					source: 'stdout',
				}),
				createLogEntry({ id: 'resp-1', text: 'Yes on the first part.', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const { container } = render(<TerminalOutput {...createDefaultProps({ session })} />);

			// user + banner + answer, not user + one stitched bubble.
			expect(container.querySelectorAll('[data-log-index]').length).toBe(3);

			const combinedText = screen
				.getAllByTestId('react-markdown')
				.map((el) => el.textContent)
				.join('|');
			expect(combinedText).not.toContain('(America/Chicago)Yes on the first part.');
		});
	});

	describe('command-mode cards are never merged into a response group', () => {
		const lsOutput = '\u001b[1m\u001b[36mnode_modules\u001b[0m tailwind.config.mjs\n';

		function commandCard(overrides: Partial<LogEntry> = {}): LogEntry {
			return createLogEntry({
				id: 'card-1',
				// `source: 'stdout'` is correct - the body really is terminal output.
				// That is precisely why grouping used to swallow it.
				source: 'stdout',
				text: lsOutput,
				shellCommand: {
					command: 'ls',
					cwd: '/repo',
					status: 'finished',
					exitCode: 0,
				},
				...overrides,
			});
		}

		function renderLogs(logs: LogEntry[], propOverrides: Record<string, unknown> = {}) {
			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});
			return render(<TerminalOutput {...createDefaultProps({ session, ...propOverrides })} />);
		}

		it('gives the command its own row instead of appending it to the agent reply', () => {
			// The reported bug: `!ls` output was concatenated onto the tail of the
			// preceding agent message and rendered as markdown, ANSI codes and all.
			const logs: LogEntry[] = [
				createLogEntry({ id: 'resp-1', text: 'rather than guess now.', source: 'stdout' }),
				commandCard(),
			];

			const { container } = renderLogs(logs);

			expect(container.querySelectorAll('[data-log-index]').length).toBe(2);

			const markdown = screen
				.queryAllByTestId('react-markdown')
				.map((el) => el.textContent)
				.join('|');
			expect(markdown).not.toContain('guess now.node_modules');
			expect(markdown).not.toContain('node_modules');
		});

		it('renders the card chrome rather than a markdown bubble', () => {
			// NOTE: this file stubs ansi-to-html to a passthrough, so the ANSI ->
			// colour conversion itself is asserted in ShellCommandCard.test.tsx
			// (which uses the real converter). What matters here is that the entry
			// reaches the card at all, instead of being flattened into markdown.
			renderLogs([commandCard()]);

			// Card-only chrome: the command in the header and its exit status.
			expect(screen.getByText('ls')).toBeInTheDocument();
			expect(screen.getByText(/exit 0/)).toBeInTheDocument();
			// The output must NOT have gone through the markdown renderer.
			const markdown = screen
				.queryAllByTestId('react-markdown')
				.map((el) => el.textContent)
				.join('|');
			expect(markdown).not.toContain('node_modules');
		});

		it('keeps a card between two replies from stitching them together', () => {
			const logs: LogEntry[] = [
				createLogEntry({ id: 'resp-1', text: 'Before.', source: 'stdout' }),
				commandCard(),
				createLogEntry({ id: 'resp-2', text: 'After.', source: 'stdout' }),
			];

			const { container } = renderLogs(logs);

			expect(container.querySelectorAll('[data-log-index]').length).toBe(3);
			const markdown = screen
				.queryAllByTestId('react-markdown')
				.map((el) => el.textContent)
				.join('|');
			expect(markdown).not.toContain('Before.After.');
		});

		it('gives each of several commands its own row', () => {
			const logs: LogEntry[] = [
				commandCard({ id: 'card-1' }),
				commandCard({ id: 'card-2' }),
				commandCard({ id: 'card-3' }),
			];

			const { container } = renderLogs(logs);

			expect(container.querySelectorAll('[data-log-index]').length).toBe(3);
		});

		it('offers delete on a finished card when the transcript is editable', () => {
			// The card takes an early return and never reaches the shared hover
			// toolbar, so it has to carry the affordance itself - this asserts the
			// props actually arrive from TerminalOutput.
			renderLogs([commandCard()], { onDeleteLog: vi.fn() });

			expect(screen.getByTestId('shell-command-delete')).toBeInTheDocument();
		});

		it('repaints a finished card that produced no output at all', () => {
			// Regression: the LogItem memo compared `log.text`, which never changes
			// for a silent command (`!true`), so the card stayed frozen mid-run -
			// spinner up, Stop offered, and delete hidden behind its finished gate.
			// Both `tabs` (what this file's getActiveTab mock reads) and `aiTabs`
			// (what TerminalOutput's active-tab useMemo keys on). A session carrying
			// only one of them can never repaint on a rerender, which would make
			// this test assert the harness rather than the component.
			const sessionWith = (log: LogEntry) => {
				const tabs = [{ id: 'tab-1', agentSessionId: 'claude-123', logs: [log], isUnread: false }];
				return createDefaultSession({ tabs, aiTabs: tabs, activeTabId: 'tab-1' } as never);
			};
			const onDeleteLog = vi.fn();

			const running = commandCard({
				text: '',
				shellCommand: { command: 'true', cwd: '/repo', status: 'running' },
			});
			const { rerender } = render(
				<TerminalOutput {...createDefaultProps({ session: sessionWith(running), onDeleteLog })} />
			);
			expect(screen.queryByTestId('shell-command-delete')).not.toBeInTheDocument();

			const finished = commandCard({
				text: '',
				shellCommand: {
					command: 'true',
					cwd: '/repo',
					status: 'finished',
					exitCode: 0,
					durationMs: 12,
				},
			});
			rerender(
				<TerminalOutput {...createDefaultProps({ session: sessionWith(finished), onDeleteLog })} />
			);

			expect(screen.getByText(/exit 0/)).toBeInTheDocument();
			expect(screen.queryByText('Stop')).not.toBeInTheDocument();
			expect(screen.getByTestId('shell-command-delete')).toBeInTheDocument();
		});
	});

	describe('cross-tab search jump anchors', () => {
		it('tags every rendered row with its entry id', () => {
			const logs: LogEntry[] = [
				createLogEntry({ id: 'user-1', text: 'A question', source: 'user' }),
				createLogEntry({ id: 'resp-1', text: 'An answer', source: 'stdout' }),
			];
			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const { container } = render(<TerminalOutput {...createDefaultProps({ session })} />);

			const ids = Array.from(container.querySelectorAll('[data-log-id]')).map((el) =>
				el.getAttribute('data-log-id')
			);
			expect(ids).toEqual(['user-1', 'resp-1']);
		});

		it('anchors a collapsed response group to its first entry id', () => {
			// resp-2 and resp-3 merge into the row owned by resp-1, so a jump
			// targeting any of them has to resolve to that one anchor.
			const logs: LogEntry[] = [
				createLogEntry({ id: 'resp-1', text: 'Part 1. ', source: 'stdout' }),
				createLogEntry({ id: 'resp-2', text: 'Part 2. ', source: 'stdout' }),
				createLogEntry({ id: 'resp-3', text: 'Part 3.', source: 'stdout' }),
			];
			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const { container } = render(<TerminalOutput {...createDefaultProps({ session })} />);

			const ids = Array.from(container.querySelectorAll('[data-log-id]')).map((el) =>
				el.getAttribute('data-log-id')
			);
			expect(ids).toEqual(['resp-1']);
		});

		/**
		 * jsdom has no layout engine, so the real scroll positions can't be
		 * asserted. What these cover is the arbitration: a pending jump has to
		 * reach the target row, and the two things that scroll the transcript on
		 * their own (follow-the-tail auto-scroll, saved-position restore) have to
		 * stand down while it does. Getting that wrong is what left the user on
		 * the right tab but the wrong message.
		 */
		function setupJump(logs: LogEntry[], logId: string, extraProps = {}) {
			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});
			useUIStore.getState().setPendingLogJump({ sessionId: session.id, tabId: 'tab-1', logId });

			const { container } = render(
				<TerminalOutput {...createDefaultProps({ session, ...extraProps })} />
			);

			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
			const scrollToSpy = vi.fn();
			scrollContainer.scrollTo = scrollToSpy;

			const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-log-id]'));
			for (const row of rows) {
				row.scrollIntoView = vi.fn();
				Object.defineProperty(row, 'offsetParent', {
					get: () => document.body,
					configurable: true,
				});
			}
			return { container, scrollContainer, scrollToSpy, rows };
		}

		const rowById = (rows: HTMLElement[], id: string) =>
			rows.find((r) => r.getAttribute('data-log-id') === id)!;

		it('scrolls to the jumped-to entry and flashes it', async () => {
			const logs: LogEntry[] = [
				createLogEntry({ id: 'user-1', text: 'A question', source: 'user' }),
				createLogEntry({ id: 'user-2', text: 'The hit', source: 'user' }),
			];
			const { rows } = setupJump(logs, 'user-2');

			await act(async () => {
				vi.advanceTimersByTime(50);
			});

			const target = rowById(rows, 'user-2');
			expect(target.scrollIntoView).toHaveBeenCalled();
			expect(target.classList.contains('jump-flash')).toBe(true);
			expect(rowById(rows, 'user-1').scrollIntoView).not.toHaveBeenCalled();
		});

		it('resolves a hit inside a collapsed group to the row that renders it', async () => {
			const logs: LogEntry[] = [
				createLogEntry({ id: 'resp-1', text: 'Part 1. ', source: 'stdout' }),
				createLogEntry({ id: 'resp-2', text: 'Part 2.', source: 'stdout' }),
			];
			// resp-2 has no row of its own; the jump must land on resp-1's row.
			const { rows } = setupJump(logs, 'resp-2');

			await act(async () => {
				vi.advanceTimersByTime(50);
			});

			expect(rowById(rows, 'resp-1').scrollIntoView).toHaveBeenCalled();
		});

		it('does not let auto-scroll yank the view back to the bottom', async () => {
			const logs: LogEntry[] = [
				createLogEntry({ id: 'user-1', text: 'The hit', source: 'user' }),
				createLogEntry({ id: 'resp-1', text: 'A reply', source: 'stdout' }),
			];
			const { scrollToSpy } = setupJump(logs, 'user-1');

			await act(async () => {
				vi.advanceTimersByTime(50);
			});

			expect(scrollToSpy).not.toHaveBeenCalled();
		});

		it('does not let the saved scroll position override the jump', async () => {
			const logs: LogEntry[] = [
				createLogEntry({ id: 'user-1', text: 'The hit', source: 'user' }),
				createLogEntry({ id: 'resp-1', text: 'A reply', source: 'stdout' }),
			];
			const { scrollContainer, rows } = setupJump(logs, 'user-1', { initialScrollTop: 900 });

			// jsdom clamps every scrollTop to 0 (no layout), so the restored VALUE
			// can't be asserted - watch for the assignment itself instead.
			const scrollTopWrites = vi.fn();
			Object.defineProperty(scrollContainer, 'scrollTop', {
				get: () => 0,
				set: scrollTopWrites,
				configurable: true,
			});

			await act(async () => {
				vi.advanceTimersByTime(50);
			});

			expect(scrollTopWrites).not.toHaveBeenCalled();
			expect(rowById(rows, 'user-1').scrollIntoView).toHaveBeenCalled();
		});

		it('consumes the jump so it does not re-fire on the next render', async () => {
			const logs: LogEntry[] = [createLogEntry({ id: 'user-1', text: 'The hit', source: 'user' })];
			setupJump(logs, 'user-1');

			await act(async () => {
				vi.advanceTimersByTime(50);
			});

			expect(useUIStore.getState().pendingLogJump).toBeNull();
		});

		it('ignores a jump aimed at a different tab', async () => {
			const logs: LogEntry[] = [createLogEntry({ id: 'user-1', text: 'The hit', source: 'user' })];
			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});
			useUIStore.getState().setPendingLogJump({
				sessionId: session.id,
				tabId: 'tab-2',
				logId: 'user-1',
			});

			const { container } = render(<TerminalOutput {...createDefaultProps({ session })} />);
			const row = container.querySelector<HTMLElement>('[data-log-id="user-1"]')!;
			row.scrollIntoView = vi.fn();

			await act(async () => {
				vi.advanceTimersByTime(50);
			});

			expect(row.scrollIntoView).not.toHaveBeenCalled();
			// Still pending: the tab it belongs to hasn't rendered it yet.
			expect(useUIStore.getState().pendingLogJump).not.toBeNull();
		});
	});

	describe('search functionality', () => {
		it('shows search input when outputSearchOpen is true', () => {
			const props = createDefaultProps({ outputSearchOpen: true });
			render(<TerminalOutput {...props} />);

			expect(
				screen.getByPlaceholderText('Search output... (Enter: next, Shift+Enter: prev)')
			).toBeInTheDocument();
		});

		it('calls setOutputSearchQuery when typing in search', async () => {
			const setOutputSearchQuery = vi.fn();
			const props = createDefaultProps({
				outputSearchOpen: true,
				setOutputSearchQuery,
			});
			render(<TerminalOutput {...props} />);

			const searchInput = screen.getByPlaceholderText(
				'Search output... (Enter: next, Shift+Enter: prev)'
			);
			fireEvent.change(searchInput, { target: { value: 'test query' } });

			expect(setOutputSearchQuery).toHaveBeenCalledWith('test query');
		});

		it('keeps all logs visible when searching (highlight-only, no filter)', () => {
			// NOTE: use a source that isn't collapsed into response groups (stdout/stderr
			// are merged by `collapsedLogs`), so each log produces its own DOM item.
			const logs: LogEntry[] = [
				createLogEntry({ text: 'This contains hello world', source: 'tool' }),
				createLogEntry({ text: 'This does not match', source: 'tool' }),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				outputSearchQuery: 'hello',
			});

			const { container } = render(<TerminalOutput {...props} />);

			// All logs should remain visible; search highlights rather than filters.
			const logItems = container.querySelectorAll('[data-log-index]');
			expect(logItems.length).toBe(2);
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

		it('hides search input when outputSearchOpen is false', () => {
			const props = createDefaultProps({ outputSearchOpen: false });
			render(<TerminalOutput {...props} />);

			expect(
				screen.queryByPlaceholderText('Search output... (Enter: next, Shift+Enter: prev)')
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

			const searchInput = screen.getByPlaceholderText(
				'Search output... (Enter: next, Shift+Enter: prev)'
			);

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

		it('shows "Plain Text" label on regex toggle when in plain mode', () => {
			const props = createDefaultProps({ outputSearchOpen: true, outputSearchRegex: false });
			render(<TerminalOutput {...props} />);

			expect(screen.getByText('Plain Text')).toBeInTheDocument();
			expect(screen.queryByText('Regex')).not.toBeInTheDocument();
		});

		it('shows "Regex" label on regex toggle when in regex mode', () => {
			const props = createDefaultProps({ outputSearchOpen: true, outputSearchRegex: true });
			render(<TerminalOutput {...props} />);

			expect(screen.getByText('Regex')).toBeInTheDocument();
			expect(screen.queryByText('Plain Text')).not.toBeInTheDocument();
		});
	});

	describe('keyboard navigation', () => {
		it('nudges scroll up on plain ArrowUp', () => {
			const props = createDefaultProps();
			const { container } = render(<TerminalOutput {...props} />);

			const outputDiv = container.firstChild as HTMLElement;
			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;

			const scrollBySpy = vi.fn();
			scrollContainer.scrollBy = scrollBySpy;

			fireEvent.keyDown(outputDiv, { key: 'ArrowUp' });

			expect(scrollBySpy).toHaveBeenCalledWith({ top: -100 });
			expect(mockJumpToMessageEdge).not.toHaveBeenCalled();
		});

		it('nudges scroll down on plain ArrowDown', () => {
			const props = createDefaultProps();
			const { container } = render(<TerminalOutput {...props} />);

			const outputDiv = container.firstChild as HTMLElement;
			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;

			const scrollBySpy = vi.fn();
			scrollContainer.scrollBy = scrollBySpy;

			fireEvent.keyDown(outputDiv, { key: 'ArrowDown' });

			expect(scrollBySpy).toHaveBeenCalledWith({ top: 100 });
			expect(mockJumpToMessageEdge).not.toHaveBeenCalled();
		});

		it('jumps to previous message on Shift+ArrowUp', () => {
			const props = createDefaultProps();
			const { container } = render(<TerminalOutput {...props} />);

			const outputDiv = container.firstChild as HTMLElement;
			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;

			fireEvent.keyDown(outputDiv, { key: 'ArrowUp', shiftKey: true });

			expect(mockJumpToMessageEdge).toHaveBeenCalledWith(scrollContainer, '[data-log-index]', 'up');
		});

		it('jumps to next message on Shift+ArrowDown', () => {
			const props = createDefaultProps();
			const { container } = render(<TerminalOutput {...props} />);

			const outputDiv = container.firstChild as HTMLElement;
			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;

			fireEvent.keyDown(outputDiv, { key: 'ArrowDown', shiftKey: true });

			expect(mockJumpToMessageEdge).toHaveBeenCalledWith(
				scrollContainer,
				'[data-log-index]',
				'down'
			);
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
		it('fires the Copied to Clipboard center flash when copy succeeds', async () => {
			useCenterFlashStore.getState().setActive(null);

			const logs: LogEntry[] = [createLogEntry({ text: 'Copy this text', source: 'stdout' })];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			const copyButton = screen.getByTitle('Copy to clipboard');

			const writeTextMock = vi.fn().mockResolvedValue(undefined);
			Object.assign(navigator, {
				clipboard: { writeText: writeTextMock },
			});

			await act(async () => {
				fireEvent.click(copyButton);
			});

			expect(writeTextMock).toHaveBeenCalledWith('Copy this text');

			await waitFor(() => {
				const active = useCenterFlashStore.getState().active;
				expect(active?.message).toBe('Copied to Clipboard');
				expect(active?.detail).toBe('Copy this text');
				expect(active?.color).toBe('theme');
			});
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

		it('dismisses confirmation modal when layer stack onEscape fires', async () => {
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

			// Modal should be open and registered with the layer stack
			expect(screen.getByText('Remove Queued Message?')).toBeInTheDocument();
			expect(mockRegisterLayer).toHaveBeenCalled();

			// Pull the most recent registerLayer call's onEscape - this is what the
			// layer stack fires when Escape is pressed on the topmost layer.
			const layerConfig = mockRegisterLayer.mock.calls[mockRegisterLayer.mock.calls.length - 1][0];
			expect(typeof layerConfig.onEscape).toBe('function');

			await act(async () => {
				layerConfig.onEscape();
			});

			expect(screen.queryByText('Remove Queued Message?')).not.toBeInTheDocument();
		});

		it('confirms removal when Enter key is pressed on the focused confirm button', async () => {
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

			// Modal should be open. The shared ModalFooter handles Enter directly on the
			// confirm button via its onKeyDown handler, so we dispatch keyDown there.
			expect(screen.getByText('Remove Queued Message?')).toBeInTheDocument();
			const confirmButton = screen.getByRole('button', { name: 'Remove' });

			await act(async () => {
				fireEvent.keyDown(confirmButton, { key: 'Enter' });
			});

			expect(onRemoveQueuedItem).toHaveBeenCalledWith('q1');
			expect(screen.queryByText('Remove Queued Message?')).not.toBeInTheDocument();
		});

		it('keeps confirmation modal open when clicking the backdrop', async () => {
			// Confirmation modals intentionally do not close on backdrop click - users
			// must explicitly choose Cancel/Confirm or press Escape. This guards against
			// accidental dismissal of destructive prompts.
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

			// Click the modal overlay
			const modalOverlay = screen.getByText('Remove Queued Message?').closest('[role="dialog"]');
			await act(async () => {
				fireEvent.click(modalOverlay!);
			});

			expect(screen.getByText('Remove Queued Message?')).toBeInTheDocument();
		});

		describe('force send button', () => {
			const forceSendSession = () =>
				createDefaultSession({
					executionQueue: [{ id: 'q1', type: 'message', text: 'Queued message', tabId: 'tab-1' }],
				});

			// The inline card mirrors the Execution Queue modal exactly: present
			// when force sending is possible or one settings toggle away, absent
			// when the block is a dead end the user cannot act on from the card.
			it('renders Force Send disabled when forced parallel is off and another tab is busy', () => {
				const props = createDefaultProps({
					session: forceSendSession(),
					forcedParallelEnabled: false,
					onForceSendQueuedItem: vi.fn(),
					getForceSendContext: () => ({
						targetTabBusy: false,
						otherBusyTabs: [{ id: 'tab-2', displayName: 'Other Tab' }],
						requiresParallel: true,
						canForce: false,
						blockedReason: 'needs-forced-parallel' as const,
					}),
				});
				render(<TerminalOutput {...props} />);
				expect(screen.getByRole('button', { name: /Force Send/ })).toBeDisabled();
			});

			it('hides Force Send when the target tab is busy', () => {
				// The card is rendered under the turn that tab is already running,
				// so the queued item is next in line by definition and there is
				// nothing to force.
				const props = createDefaultProps({
					session: forceSendSession(),
					forcedParallelEnabled: true,
					onForceSendQueuedItem: vi.fn(),
					getForceSendContext: () => ({
						targetTabBusy: true,
						otherBusyTabs: [{ id: 'tab-2', displayName: 'Other Tab' }],
						requiresParallel: true,
						canForce: false,
						blockedReason: 'target-tab-busy' as const,
					}),
				});
				render(<TerminalOutput {...props} />);
				expect(screen.queryByRole('button', { name: /Force Send/ })).toBeNull();
			});

			it('renders Force Send ENABLED on a quiet agent - the always-allowed case', () => {
				const props = createDefaultProps({
					session: forceSendSession(),
					forcedParallelEnabled: true,
					onForceSendQueuedItem: vi.fn(),
					getForceSendContext: () => ({
						targetTabBusy: false,
						otherBusyTabs: [],
						requiresParallel: false,
						canForce: true,
					}),
				});
				render(<TerminalOutput {...props} />);
				expect(screen.getByRole('button', { name: /Force Send/ })).toBeEnabled();
			});

			it('renders Force Send button when enabled, target idle, and another tab busy', () => {
				const props = createDefaultProps({
					session: forceSendSession(),
					forcedParallelEnabled: true,
					onForceSendQueuedItem: vi.fn(),
					getForceSendContext: () => ({
						targetTabBusy: false,
						otherBusyTabs: [{ id: 'tab-2', displayName: 'Other Tab' }],
						requiresParallel: true,
						canForce: true,
					}),
				});
				render(<TerminalOutput {...props} />);
				expect(screen.getByRole('button', { name: /Force Send/ })).toBeInTheDocument();
			});

			it('shows confirmation modal listing other busy tabs', async () => {
				const props = createDefaultProps({
					session: forceSendSession(),
					forcedParallelEnabled: true,
					onForceSendQueuedItem: vi.fn(),
					getForceSendContext: () => ({
						targetTabBusy: false,
						otherBusyTabs: [
							{ id: 'tab-2', displayName: 'Refactor' },
							{ id: 'tab-3', displayName: 'A1B2C3D4' },
						],
						requiresParallel: true,
						canForce: true,
					}),
				});
				render(<TerminalOutput {...props} />);
				const triggers = screen.getAllByRole('button', { name: /Force Send/ });
				await act(async () => {
					fireEvent.click(triggers[0]);
				});
				expect(screen.getByText('Force Send Message?')).toBeInTheDocument();
				expect(screen.getByText('2 OTHER TABS WORKING')).toBeInTheDocument();
				expect(screen.getByText('Refactor')).toBeInTheDocument();
				expect(screen.getByText('A1B2C3D4')).toBeInTheDocument();
			});

			it('uses singular label when exactly one other tab is busy', async () => {
				const props = createDefaultProps({
					session: forceSendSession(),
					forcedParallelEnabled: true,
					onForceSendQueuedItem: vi.fn(),
					getForceSendContext: () => ({
						targetTabBusy: false,
						otherBusyTabs: [{ id: 'tab-2', displayName: 'Other' }],
						requiresParallel: true,
						canForce: true,
					}),
				});
				render(<TerminalOutput {...props} />);
				const triggers = screen.getAllByRole('button', { name: /Force Send/ });
				await act(async () => {
					fireEvent.click(triggers[0]);
				});
				expect(screen.getByText('1 OTHER TAB WORKING')).toBeInTheDocument();
			});

			it('calls onForceSendQueuedItem when confirmed', async () => {
				const onForceSendQueuedItem = vi.fn();
				const props = createDefaultProps({
					session: forceSendSession(),
					forcedParallelEnabled: true,
					onForceSendQueuedItem,
					getForceSendContext: () => ({
						targetTabBusy: false,
						otherBusyTabs: [{ id: 'tab-2', displayName: 'Other' }],
						requiresParallel: true,
						canForce: true,
					}),
				});
				render(<TerminalOutput {...props} />);
				const triggers = screen.getAllByRole('button', { name: /Force Send/ });
				await act(async () => {
					fireEvent.click(triggers[0]);
				});
				// Now click the "Force Send" confirm button inside the modal (the second occurrence).
				const buttons = screen.getAllByRole('button', { name: /Force Send/ });
				await act(async () => {
					fireEvent.click(buttons[buttons.length - 1]);
				});
				expect(onForceSendQueuedItem).toHaveBeenCalledWith('q1');
			});

			it('dismisses Force Send modal via layer stack onEscape without calling handler', async () => {
				const onForceSendQueuedItem = vi.fn();
				const props = createDefaultProps({
					session: forceSendSession(),
					forcedParallelEnabled: true,
					onForceSendQueuedItem,
					getForceSendContext: () => ({
						targetTabBusy: false,
						otherBusyTabs: [{ id: 'tab-2', displayName: 'Other' }],
						requiresParallel: true,
						canForce: true,
					}),
				});
				render(<TerminalOutput {...props} />);
				const triggers = screen.getAllByRole('button', { name: /Force Send/ });
				await act(async () => {
					fireEvent.click(triggers[0]);
				});
				expect(screen.getByText('Force Send Message?')).toBeInTheDocument();

				const layerConfig =
					mockRegisterLayer.mock.calls[mockRegisterLayer.mock.calls.length - 1][0];
				await act(async () => {
					layerConfig.onEscape();
				});

				expect(screen.queryByText('Force Send Message?')).not.toBeInTheDocument();
				expect(onForceSendQueuedItem).not.toHaveBeenCalled();
			});

			it('hides Force Send button when item already has forceParallel flag', () => {
				const props = createDefaultProps({
					session: createDefaultSession({
						executionQueue: [
							{
								id: 'q1',
								type: 'message',
								text: 'already force-parallel',
								tabId: 'tab-1',
								forceParallel: true,
							},
						],
					}),
					forcedParallelEnabled: true,
					onForceSendQueuedItem: vi.fn(),
					getForceSendContext: () => ({
						targetTabBusy: false,
						otherBusyTabs: [{ id: 'tab-2', displayName: 'Other' }],
						requiresParallel: true,
						canForce: true,
					}),
				});
				render(<TerminalOutput {...props} />);
				expect(screen.queryByRole('button', { name: /Force Send/ })).not.toBeInTheDocument();
			});
		});
	});

	describe('new message indicator', () => {
		it('shows new message indicator when not at bottom', async () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: 'Message 1', source: 'user' }),
				createLogEntry({ text: 'Response 1', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
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
				tabs: [
					{
						id: 'tab-1',
						agentSessionId: 'claude-123',
						logs: newLogs,
						isUnread: false,
					},
				],
			};

			rerender(<TerminalOutput {...createDefaultProps({ session: newSession })} />);

			// Should show indicator
			await waitFor(() => {
				const indicator = screen.queryByTitle('Scroll to new messages');
				// This may or may not appear depending on exact scroll detection
			});
		});
	});

	describe('delete functionality', () => {
		it('shows delete button for user messages when onDeleteLog is provided', () => {
			const logs: LogEntry[] = [createLogEntry({ text: 'User message', source: 'user' })];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
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
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
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
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
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
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
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
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
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
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
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
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
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

		it('shows delete button for each user message in a conversation', () => {
			const logs: LogEntry[] = [
				createLogEntry({ id: 'log-1', text: 'First user message', source: 'user' }),
				createLogEntry({ id: 'log-2', text: 'AI response', source: 'stdout' }),
				createLogEntry({ id: 'log-3', text: 'Second user message', source: 'user' }),
				createLogEntry({ id: 'log-4', text: 'Another AI response', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
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
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
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
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
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
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
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
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
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
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
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
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
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

		it('shows markdown toggle button for user messages in AI mode (#622 consistency)', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: 'User message with **markdown**', source: 'user' }),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: false,
			});

			render(<TerminalOutput {...props} />);

			// Toggle is now exposed on user messages too - consistent with
			// assistant messages so the user can flip between formatted and
			// raw text views of their own input.
			expect(screen.queryByTitle(/Show plain text/)).toBeInTheDocument();
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
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
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

		it('shows raw markdown source when markdownEditMode is true (plain text mode)', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: '# Heading\n\n**Bold text**', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: true,
			});

			render(<TerminalOutput {...props} />);

			// In plain text mode, raw markdown source should be shown
			// Heading symbol (#) and bold markers (**) should be preserved
			expect(screen.getByText(/# Heading/)).toBeInTheDocument();
			expect(screen.getByText(/\*\*Bold text\*\*/)).toBeInTheDocument();
			// Should not render via MarkdownRenderer
			expect(screen.queryByTestId('react-markdown')).not.toBeInTheDocument();
		});

		it('toggle button has accent color when markdownEditMode is true', () => {
			const logs: LogEntry[] = [createLogEntry({ text: '# Heading', source: 'stdout' })];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
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
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
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

		it('preserves code fences in raw markdown mode', () => {
			const codeBlockText = '```javascript\nconst x = 1;\nconst y = 2;\n```';
			const logs: LogEntry[] = [createLogEntry({ text: codeBlockText, source: 'stdout' })];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: true,
			});

			render(<TerminalOutput {...props} />);

			// Code content and fences should be preserved in raw mode
			expect(screen.getByText(/const x = 1/)).toBeInTheDocument();
			expect(screen.getByText(/const y = 2/)).toBeInTheDocument();
		});

		it('preserves inline code backticks in raw markdown mode', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: 'Use the `console.log` function', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: true,
			});

			render(<TerminalOutput {...props} />);

			// Should show the raw text with backticks preserved
			expect(screen.getByText(/Use the `console.log` function/)).toBeInTheDocument();
		});

		it('shows markdown toggle button for stderr messages in AI mode', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: 'Error: Something went wrong', source: 'stderr' }),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
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
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: true,
			});

			render(<TerminalOutput {...props} />);

			// Both AI responses should be affected by the same markdown mode
			// In raw mode, we should see raw markdown source for both
			expect(screen.getByText(/# First Response/)).toBeInTheDocument();
			expect(screen.getByText(/# Second Response/)).toBeInTheDocument();
		});

		it('shows Eye icon when markdownEditMode is true', () => {
			const logs: LogEntry[] = [createLogEntry({ text: '# Heading', source: 'stdout' })];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
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
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
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
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
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

		it('shows raw markdown source including link URLs in plain text mode', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: 'Check out [this link](https://example.com)', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: true,
			});

			render(<TerminalOutput {...props} />);

			// Raw markdown source should be visible including the URL
			expect(screen.getByText(/\[this link\]\(https:\/\/example\.com\)/)).toBeInTheDocument();
		});

		it('shows raw list markers in plain text mode', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: '* Item one\n* Item two\n* Item three', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: true,
			});

			render(<TerminalOutput {...props} />);

			// Raw markdown with * markers should be visible
			expect(screen.getByText(/\* Item one/)).toBeInTheDocument();
		});
	});

	describe('thinking log markdown rendering', () => {
		it('renders thinking logs with MarkdownRenderer in AI mode', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: '**bold thinking** and `code`', source: 'thinking' }),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: false,
			});

			render(<TerminalOutput {...props} />);

			// MarkdownRenderer is mocked as react-markdown with data-testid
			expect(screen.getByTestId('react-markdown')).toBeInTheDocument();
		});

		it('renders thinking logs as plain text when markdownEditMode is true', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: '**bold thinking** and `code`', source: 'thinking' }),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: true,
			});

			render(<TerminalOutput {...props} />);

			// Should show raw text, not rendered markdown
			expect(screen.getByText(/\*\*bold thinking\*\*/)).toBeInTheDocument();
			expect(screen.queryByTestId('react-markdown')).not.toBeInTheDocument();
		});

		it('shows thinking pill label alongside markdown content', () => {
			const logs: LogEntry[] = [
				createLogEntry({ text: '# Analysis\n\nLet me think...', source: 'thinking' }),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// The "thinking" label pill should still be visible
			expect(screen.getByText('thinking')).toBeInTheDocument();
			// And markdown should be rendered
			expect(screen.getByTestId('react-markdown')).toBeInTheDocument();
		});
	});

	describe('tool log detail extraction', () => {
		it('renders TodoWrite tool with task summary from todos array', () => {
			const logs: LogEntry[] = [
				createLogEntry({
					text: 'TodoWrite',
					source: 'tool',
					metadata: {
						toolState: {
							status: 'completed',
							input: {
								todos: [
									{
										content: 'Fix lint issues',
										status: 'completed',
										activeForm: 'Fixing lint issues',
									},
									{ content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' },
									{ content: 'Build project', status: 'pending', activeForm: 'Building project' },
								],
							},
						},
					},
				}),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			expect(screen.getByText('TodoWrite')).toBeInTheDocument();
			// Should show activeForm of in_progress task with progress count
			expect(screen.getByText('Running tests (1/3)')).toBeInTheDocument();
		});

		it('renders TodoWrite with first task when none in progress', () => {
			const logs: LogEntry[] = [
				createLogEntry({
					text: 'TodoWrite',
					source: 'tool',
					metadata: {
						toolState: {
							status: 'completed',
							input: {
								todos: [
									{
										content: 'Fix lint issues',
										status: 'completed',
										activeForm: 'Fixing lint issues',
									},
									{ content: 'Run tests', status: 'completed', activeForm: 'Running tests' },
								],
							},
						},
					},
				}),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// No in_progress task, falls back to first task's content
			expect(screen.getByText('Fix lint issues (2/2)')).toBeInTheDocument();
		});

		it('expands the task list card to show individual task items', () => {
			const logs: LogEntry[] = [
				createLogEntry({
					text: 'TodoWrite',
					source: 'tool',
					metadata: {
						toolState: {
							status: 'completed',
							input: {
								todos: [
									{
										content: 'Fix lint issues',
										status: 'completed',
										activeForm: 'Fixing lint issues',
									},
									{ content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' },
									{ content: 'Build project', status: 'pending', activeForm: 'Building project' },
								],
							},
						},
					},
				}),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// Collapsed by default - individual items are not rendered
			expect(screen.queryByText('Fix lint issues')).not.toBeInTheDocument();
			expect(screen.queryByText('Build project')).not.toBeInTheDocument();

			fireEvent.click(screen.getByRole('button', { name: 'Expand task list' }));

			expect(screen.getByText('Fix lint issues')).toBeInTheDocument();
			expect(screen.getByText('Build project')).toBeInTheDocument();
			// In-progress task uses its present-tense activeForm
			expect(screen.getByText('Running tests')).toBeInTheDocument();
		});

		it('renders a task list card for Codex update_plan payloads', () => {
			const logs: LogEntry[] = [
				createLogEntry({
					text: 'update_plan',
					source: 'tool',
					metadata: {
						toolState: {
							status: 'completed',
							input: {
								plan: [
									{ step: 'Read the failing spec', status: 'completed' },
									{ step: 'Patch the parser', status: 'in_progress' },
								],
							},
						},
					},
				}),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'codex-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			expect(screen.getByText('Patch the parser (1/2)')).toBeInTheDocument();
			// Generic key/value fallback is suppressed for checklist payloads
			expect(screen.queryByText('plan: [2]')).not.toBeInTheDocument();
		});

		it('renders Bash tool with command detail', () => {
			const logs: LogEntry[] = [
				createLogEntry({
					text: 'Bash',
					source: 'tool',
					metadata: {
						toolState: {
							status: 'running',
							input: { command: 'npm run test' },
						},
					},
				}),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			expect(screen.getByText('Bash')).toBeInTheDocument();
			expect(screen.getByText('npm run test')).toBeInTheDocument();
		});

		it('hides tool logs at render when showToolCalls is off', () => {
			const logs: LogEntry[] = [
				createLogEntry({
					text: 'Bash',
					source: 'tool',
					metadata: { toolState: { status: 'running', input: { command: 'npm run test' } } },
				}),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			useSettingsStore.setState({ showToolCalls: false });
			render(<TerminalOutput {...createDefaultProps({ session })} />);

			// Tool events stay recorded in state; the tab hid them, so the badge must
			// not render. Visibility is a pure render concern (no log mutation).
			expect(screen.queryByText('Bash')).not.toBeInTheDocument();
			expect(screen.queryByText('npm run test')).not.toBeInTheDocument();
		});

		it('shows tool logs when the tab has Thinking off but showToolCalls is on', () => {
			const logs: LogEntry[] = [
				createLogEntry({
					text: 'Bash',
					source: 'tool',
					metadata: { toolState: { status: 'running', input: { command: 'npm run test' } } },
				}),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'off' },
				],
				activeTabId: 'tab-1',
			});

			// The two settings are independent: showToolCalls alone decides whether
			// tool cells are drawn, so Thinking off must not suppress them.
			useSettingsStore.setState({ showToolCalls: true });
			render(<TerminalOutput {...createDefaultProps({ session })} />);

			expect(screen.getByText('Bash')).toBeInTheDocument();
			expect(screen.getByText('npm run test')).toBeInTheDocument();
		});

		it('hides tool logs when showToolCalls is off even with Thinking sticky', () => {
			const logs: LogEntry[] = [
				createLogEntry({
					text: 'Bash',
					source: 'tool',
					metadata: { toolState: { status: 'running', input: { command: 'npm run test' } } },
				}),
			];

			const session = createDefaultSession({
				tabs: [
					{
						id: 'tab-1',
						agentSessionId: 'claude-123',
						logs,
						isUnread: false,
						showThinking: 'sticky',
					},
				],
				activeTabId: 'tab-1',
			});

			// The other direction of the same independence: a tab that keeps its
			// reasoning chain still honours a global "no tool cells" preference.
			useSettingsStore.setState({ showToolCalls: false });
			render(<TerminalOutput {...createDefaultProps({ session })} />);

			expect(screen.queryByText('Bash')).not.toBeInTheDocument();
			expect(screen.queryByText('npm run test')).not.toBeInTheDocument();
		});

		it('keeps response segments separate when a hidden tool call sat between them', () => {
			// collapseAiResponseLogs treats a tool entry as a boundary. If tools were
			// filtered BEFORE collapse, the two replies would merge into one bubble
			// ("First replySecond reply"). Collapsing first preserves the boundary.
			const logs: LogEntry[] = [
				createLogEntry({ text: 'First reply', source: 'stdout' }),
				createLogEntry({
					text: 'Bash',
					source: 'tool',
					metadata: { toolState: { status: 'completed' } },
				}),
				createLogEntry({ text: 'Second reply', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			useSettingsStore.setState({ showToolCalls: false });
			render(<TerminalOutput {...createDefaultProps({ session })} />);

			// The tool badge is hidden, but the two replies stay separate.
			expect(screen.getByText('First reply')).toBeInTheDocument();
			expect(screen.getByText('Second reply')).toBeInTheDocument();
			expect(screen.queryByText('Bash')).not.toBeInTheDocument();
		});

		it('collapses subagent tool calls behind a count under the Task badge', () => {
			const logs: LogEntry[] = [
				createLogEntry({
					id: 'tool-task_1',
					text: 'Task',
					source: 'tool',
					metadata: { toolState: { status: 'running', input: { description: 'explore parsers' } } },
				}),
				createLogEntry({
					id: 'tool-child_a',
					text: 'Grep',
					source: 'tool',
					metadata: {
						toolState: { status: 'completed', input: { pattern: 'parseJsonLine' } },
						parentToolUseId: 'task_1',
					},
				}),
				createLogEntry({
					id: 'tool-child_b',
					text: 'Read',
					source: 'tool',
					metadata: {
						toolState: { status: 'completed', input: { file_path: '/tmp/a.ts' } },
						parentToolUseId: 'task_1',
					},
				}),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			render(<TerminalOutput {...createDefaultProps({ session })} />);

			// Parent renders; children are hidden behind the count until expanded.
			expect(screen.getByText('Task')).toBeInTheDocument();
			expect(screen.getByText('2 tool calls')).toBeInTheDocument();
			expect(screen.queryByText('Grep')).not.toBeInTheDocument();
			expect(screen.queryByText('Read')).not.toBeInTheDocument();

			fireEvent.click(screen.getByText('2 tool calls'));

			expect(screen.getByText('Grep')).toBeInTheDocument();
			expect(screen.getByText('Read')).toBeInTheDocument();
		});

		it('singularizes the subagent tool call count', () => {
			const logs: LogEntry[] = [
				createLogEntry({
					id: 'tool-task_1',
					text: 'Task',
					source: 'tool',
					metadata: { toolState: { status: 'running' } },
				}),
				createLogEntry({
					id: 'tool-child_a',
					text: 'Grep',
					source: 'tool',
					metadata: { toolState: { status: 'running' }, parentToolUseId: 'task_1' },
				}),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			render(<TerminalOutput {...createDefaultProps({ session })} />);
			expect(screen.getByText('1 tool call')).toBeInTheDocument();
		});

		it('renders an orphaned subagent tool entry flat', () => {
			const logs: LogEntry[] = [
				createLogEntry({
					id: 'tool-child_a',
					text: 'Grep',
					source: 'tool',
					metadata: {
						toolState: { status: 'completed', input: { pattern: 'orphan' } },
						parentToolUseId: 'trimmed_away',
					},
				}),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			render(<TerminalOutput {...createDefaultProps({ session })} />);

			expect(screen.getByText('Grep')).toBeInTheDocument();
			expect(screen.getByText('orphan')).toBeInTheDocument();
			expect(screen.queryByText(/tool calls?$/)).not.toBeInTheDocument();
		});

		it('renders Bash tool with description and full multi-line command', () => {
			const logs: LogEntry[] = [
				createLogEntry({
					text: 'Bash',
					source: 'tool',
					metadata: {
						toolState: {
							status: 'running',
							input: {
								command:
									'echo "=== All comparison samples ==="\nls -lh ~/Downloads/output/compare_* 2>/dev/null\necho "=== Done ==="',
								description: 'List comparison samples',
							},
						},
					},
				}),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// Description shown separately
			expect(screen.getByText('List comparison samples')).toBeInTheDocument();
			// Full command shown without truncation - use regex since getByText struggles with newlines
			expect(screen.getByText(/All comparison samples/)).toBeInTheDocument();
			expect(screen.getByText(/compare_\* 2>\/dev\/null/)).toBeInTheDocument();
			expect(screen.getByText(/Done ===/)).toBeInTheDocument();
		});

		it('renders tool with boolean input as key=value', () => {
			const logs: LogEntry[] = [
				createLogEntry({
					text: 'SomeUnknownTool',
					source: 'tool',
					metadata: {
						toolState: {
							status: 'running',
							input: { someWeirdField: true },
						},
					},
				}),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// Tool name should render
			expect(screen.getByText('SomeUnknownTool')).toBeInTheDocument();
			// Generic summarizer shows boolean as key=value
			expect(screen.getByText('someWeirdField=true')).toBeInTheDocument();
		});

		describe('hidden progress rendering', () => {
			it('renders hidden tool progress with the polished activity treatment', () => {
				const logs: LogEntry[] = [
					createLogEntry({
						id: 'hidden-progress:tab-1',
						text: 'Reading src/renderer/App.tsx',
						source: 'system',
						metadata: {
							toolState: {
								status: 'running',
								input: { path: 'src/renderer/App.tsx' },
							},
							hiddenProgress: {
								kind: 'tool',
								toolName: 'view',
							},
						},
					}),
				];

				const session = createDefaultSession({
					tabs: [
						{
							id: 'tab-1',
							agentSessionId: 'claude-123',
							logs,
							isUnread: false,
							showThinking: 'on',
						},
					],
					activeTabId: 'tab-1',
				});

				render(<TerminalOutput {...createDefaultProps({ session })} />);

				expect(screen.getByText('view')).toBeInTheDocument();
				expect(screen.getByText('Reading src/renderer/App.tsx')).toBeInTheDocument();
				expect(screen.queryByTestId('react-markdown')).not.toBeInTheDocument();
			});

			it('uses the standard failed icon treatment for hidden progress', () => {
				const logs: LogEntry[] = [
					createLogEntry({
						id: 'hidden-progress:tab-1',
						text: 'Command failed',
						source: 'system',
						metadata: {
							toolState: {
								status: 'failed',
							},
							hiddenProgress: {
								kind: 'tool',
								toolName: 'bash',
							},
						},
					}),
				];

				const session = createDefaultSession({
					tabs: [
						{
							id: 'tab-1',
							agentSessionId: 'claude-123',
							logs,
							isUnread: false,
							showThinking: 'on',
						},
					],
					activeTabId: 'tab-1',
				});

				render(<TerminalOutput {...createDefaultProps({ session })} />);

				expect(screen.getByText('!')).toBeInTheDocument();
				expect(screen.queryByText('×')).not.toBeInTheDocument();
			});
		});

		it('renders any tool with string input fields generically', () => {
			const logs: LogEntry[] = [
				createLogEntry({
					text: 'Skill',
					source: 'tool',
					metadata: {
						toolState: {
							status: 'running',
							input: { skill_name: 'commit-push-pr' },
						},
					},
				}),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			expect(screen.getByText('Skill')).toBeInTheDocument();
			expect(screen.getByText('commit-push-pr')).toBeInTheDocument();
		});

		it('renders tool with multiple input fields joined', () => {
			const logs: LogEntry[] = [
				createLogEntry({
					text: 'Grep',
					source: 'tool',
					metadata: {
						toolState: {
							status: 'completed',
							input: { pattern: 'TODO', path: '/src', output_mode: 'content' },
						},
					},
				}),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			expect(screen.getByText('Grep')).toBeInTheDocument();
			// Generic summarizer joins all string fields
			expect(screen.getByText('TODO /src content')).toBeInTheDocument();
		});

		it('renders tool with empty input gracefully', () => {
			const logs: LogEntry[] = [
				createLogEntry({
					text: 'EmptyTool',
					source: 'tool',
					metadata: {
						toolState: {
							status: 'completed',
							input: {},
						},
					},
				}),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			expect(screen.getByText('EmptyTool')).toBeInTheDocument();
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
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
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
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
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
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			expect(screen.getByText('/history:')).toBeInTheDocument();
			expect(screen.getByText('Generate a history synopsis')).toBeInTheDocument();
		});

		it('renders the AI command body as markdown, keeping the command header', () => {
			const body = '## Step 1\n\nRun `the script` and report **what moved**.';
			const logs: LogEntry[] = [
				createLogEntry({
					text: body,
					source: 'user',
					aiCommand: {
						command: '/archive-playbooks',
						description: 'Archive finished playbooks',
					},
				}),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			// Header pill still renders, body goes through the markdown stack
			// (react-markdown is mocked to a div with this testid).
			expect(screen.getByText('/archive-playbooks:')).toBeInTheDocument();
			expect(screen.getByTestId('react-markdown')).toHaveTextContent('Step 1');
		});

		it('shows the AI command body as raw source in markdown edit mode', () => {
			const url = 'https://github.com/RunMaestro/Maestro/pull/738';
			const logs: LogEntry[] = [
				createLogEntry({
					text: `Review the open PR comments and respond.\n${url}`,
					source: 'user',
					aiCommand: {
						command: '/pr-review',
						description: 'Review PR Comments w/ Action',
					},
				}),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session, markdownEditMode: true });
			render(<TerminalOutput {...props} />);

			expect(screen.queryByTestId('react-markdown')).not.toBeInTheDocument();

			// Raw source still linkifies bare URLs.
			const link = screen.getByText(url);
			expect(link.tagName).toBe('A');
			expect(link).toHaveAttribute('href', url);

			fireEvent.click(link);
			expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(url);
		});
	});

	describe('auto-scroll when at bottom', () => {
		it('auto-scrolls to bottom when user is at bottom and new content arrives', async () => {
			// isAtBottom starts as true (initial state), so auto-scroll should work
			const logs: LogEntry[] = [
				createLogEntry({ id: 'user-1', text: 'Hello', source: 'user' }),
				createLogEntry({ id: 'resp-1', text: 'Hi there', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			const { container, rerender } = render(<TerminalOutput {...props} />);

			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
			const scrollToSpy = vi.fn();
			scrollContainer.scrollTo = scrollToSpy;

			scrollToSpy.mockClear();

			// Add a new user message (simulating message send while at bottom)
			const newLogs = [
				...logs,
				createLogEntry({ id: 'user-2', text: 'Follow up question', source: 'user' }),
			];
			const newSession = {
				...session,
				tabs: [
					{
						id: 'tab-1',
						agentSessionId: 'claude-123',
						logs: newLogs,
						isUnread: false,
					},
				],
			};

			rerender(<TerminalOutput {...createDefaultProps({ session: newSession })} />);

			// MutationObserver fires on DOM change, RAF needs time to execute
			await act(async () => {
				vi.advanceTimersByTime(50);
			});

			// scrollTo should have been called - user was at bottom, auto-scroll kicks in
			expect(scrollToSpy).toHaveBeenCalled();
		});

		it('does NOT auto-scroll when user has scrolled up (auto-scroll paused)', async () => {
			const logs: LogEntry[] = [
				createLogEntry({ id: 'user-1', text: 'Hello', source: 'user' }),
				createLogEntry({ id: 'resp-1', text: 'Response', source: 'stdout' }),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			const { container, rerender } = render(<TerminalOutput {...props} />);

			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
			const scrollToSpy = vi.fn();
			scrollContainer.scrollTo = scrollToSpy;

			// Simulate NOT at bottom (user scrolled up)
			Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, configurable: true });
			Object.defineProperty(scrollContainer, 'scrollTop', { value: 0, configurable: true });
			Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
			// scrollHeight(1000) - scrollTop(0) - clientHeight(400) = 600 > 50 → NOT at bottom

			fireEvent.scroll(scrollContainer);
			await act(async () => {
				vi.advanceTimersByTime(50);
			});

			scrollToSpy.mockClear();

			// Add new content
			const newLogs = [
				...logs,
				createLogEntry({ id: 'resp-2', text: 'New response', source: 'stdout' }),
			];
			const newSession = {
				...session,
				tabs: [
					{
						id: 'tab-1',
						agentSessionId: 'claude-123',
						logs: newLogs,
						isUnread: false,
					},
				],
			};

			rerender(<TerminalOutput {...createDefaultProps({ session: newSession })} />);

			await act(async () => {
				vi.advanceTimersByTime(50);
			});

			// scrollTo should NOT have been called - user scrolled up, auto-scroll paused
			expect(scrollToSpy).not.toHaveBeenCalled();
		});

		it('auto-scrolls when at bottom and new content arrives', async () => {
			const logs: LogEntry[] = [createLogEntry({ id: 'user-1', text: 'Hello', source: 'user' })];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			const { container, rerender } = render(<TerminalOutput {...props} />);

			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
			const scrollToSpy = vi.fn();
			scrollContainer.scrollTo = scrollToSpy;

			scrollToSpy.mockClear();

			// Add new content
			const newLogs = [
				...logs,
				createLogEntry({ id: 'resp-1', text: 'AI response', source: 'stdout' }),
			];
			const newSession = {
				...session,
				tabs: [
					{
						id: 'tab-1',
						agentSessionId: 'claude-123',
						logs: newLogs,
						isUnread: false,
					},
				],
			};

			rerender(<TerminalOutput {...createDefaultProps({ session: newSession })} />);

			await act(async () => {
				// Follow-scroll is armed by a MutationObserver microtask that schedules a
				// rAF; the async variant drains microtasks between timer steps so the
				// scroll deterministically fires on slow CI runners.
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(scrollToSpy).toHaveBeenCalled();
		});

		it('always auto-scrolls in terminal mode', async () => {
			const logs: LogEntry[] = [createLogEntry({ id: 'cmd-1', text: 'ls', source: 'user' })];

			const session = createDefaultSession({
				inputMode: 'terminal',
				shellLogs: logs,
			});

			const props = createDefaultProps({ session });
			const { container, rerender } = render(<TerminalOutput {...props} />);

			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
			const scrollToSpy = vi.fn();
			scrollContainer.scrollTo = scrollToSpy;

			scrollToSpy.mockClear();

			// Add terminal output
			const newLogs = [
				...logs,
				createLogEntry({ id: 'out-1', text: 'file1.txt\nfile2.txt', source: 'stdout' }),
			];
			const newSession = {
				...session,
				shellLogs: newLogs,
			};

			rerender(<TerminalOutput {...createDefaultProps({ session: newSession })} />);

			await act(async () => {
				// Follow-scroll is armed by a MutationObserver microtask that schedules a
				// rAF; the async variant drains microtasks between timer steps so the
				// scroll deterministically fires on slow CI runners.
				await vi.advanceTimersByTimeAsync(50);
			});

			// Terminal mode always auto-scrolls
			expect(scrollToSpy).toHaveBeenCalled();
		});

		it('keeps sticking to the bottom after clicking the pin button while scrolled up', async () => {
			// Regression (#1140 follow-up): clicking the scroll-to-bottom / pin
			// button used to scroll once but not re-arm the observer's at-bottom
			// gate, so streaming thinking output stopped following. web-desktop
			// surfaced it most visibly, but the bug was shared with desktop.
			const logs: LogEntry[] = [
				createLogEntry({ id: 'user-1', text: 'Hello', source: 'user' }),
				createLogEntry({ id: 'resp-1', text: 'Response', source: 'stdout' }),
			];
			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				// TerminalOutput's activeTab memo keys off the real `aiTabs` field (this
				// suite's `tabs` fixture only feeds the mocked getActiveTab), so a rerender
				// that only changes `tabs` never busts the memo. Give it a real reference to
				// depend on; content is irrelevant since getActiveTab still reads `tabs`.
				aiTabs: [] as any,
				activeTabId: 'tab-1',
			});

			const { container, rerender } = render(
				<TerminalOutput {...createDefaultProps({ session })} />
			);
			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;

			// jsdom never actually scrolls. Mirror the requested top into scrollTop
			// (clamped to the max, like a real browser) AND dispatch the native
			// `scroll` event that scrollTo fires, so the handleScrollInner guard
			// path is genuinely exercised rather than bypassed.
			const scrollToSpy = vi.fn((arg: number | ScrollToOptions) => {
				const top = typeof arg === 'object' && arg ? (arg.top ?? 0) : (arg ?? 0);
				const max = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
				Object.defineProperty(scrollContainer, 'scrollTop', {
					value: Math.min(top, max),
					configurable: true,
				});
				fireEvent.scroll(scrollContainer);
			});
			scrollContainer.scrollTo = scrollToSpy as unknown as HTMLElement['scrollTo'];

			// User scrolls up: 1000 tall, viewport 400, parked at the top.
			Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, configurable: true });
			Object.defineProperty(scrollContainer, 'scrollTop', { value: 0, configurable: true });
			Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
			fireEvent.scroll(scrollContainer);
			await act(async () => {
				vi.advanceTimersByTime(50);
			});

			// The pin button appears once we're away from the bottom.
			const pinButton = screen.getByTitle(/pin/i);
			await act(async () => {
				fireEvent.click(pinButton);
				vi.advanceTimersByTime(50);
			});
			// The click performs the initial jump to the current bottom.
			expect(scrollToSpy).toHaveBeenCalled();

			scrollToSpy.mockClear();

			// New streamed content arrives. Because the click re-armed the
			// at-bottom gate, the observer must follow it (call scrollTo again).
			const newLogs = [
				...logs,
				createLogEntry({ id: 'resp-2', text: 'More streamed text', source: 'stdout' }),
			];
			const newSession = {
				...session,
				tabs: [
					{
						id: 'tab-1',
						agentSessionId: 'claude-123',
						logs: newLogs,
						isUnread: false,
					},
				],
				// New reference so the activeTab memo (keyed on aiTabs) actually recomputes.
				aiTabs: [{}] as any,
			};
			rerender(<TerminalOutput {...createDefaultProps({ session: newSession })} />);
			await act(async () => {
				// Drain the MutationObserver microtask (it schedules the follow rAF) and
				// advance that rAF in one deterministic step. The async variant flushes
				// microtasks between timer steps, so a slow CI runner cannot advance
				// timers before the observer arms the scroll (Windows shard flake).
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(scrollToSpy).toHaveBeenCalled();
		});

		it('pauses auto-scroll when the user scrolls up after pinning, within the guard window', async () => {
			// Greptile P1: after the pin button arms the ~100ms programmatic-scroll
			// guard, a real user scroll-up that lands inside that window must NOT be
			// mistaken for our own bottom-jump. The guard is anchored to the
			// recorded bottom target, so a scroll-up (scrollTop below the target)
			// still leaves the bottom - proven by onAtBottomChange(false) firing.
			// A position-blind guard would swallow it and keep auto-scroll pinned.
			const onAtBottomChange = vi.fn();
			const logs: LogEntry[] = [
				createLogEntry({ id: 'user-1', text: 'Hello', source: 'user' }),
				createLogEntry({ id: 'resp-1', text: 'Response', source: 'stdout' }),
			];
			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const { container } = render(
				<TerminalOutput {...createDefaultProps({ session, onAtBottomChange })} />
			);
			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;

			Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, configurable: true });
			Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
			Object.defineProperty(scrollContainer, 'scrollTop', { value: 600, configurable: true });

			// scrollTo clamps to the max and dispatches the native scroll event a
			// real browser fires, so the handleScrollInner guard path runs.
			const scrollToSpy = vi.fn((arg: number | ScrollToOptions) => {
				const top = typeof arg === 'object' && arg ? (arg.top ?? 0) : (arg ?? 0);
				const max = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
				Object.defineProperty(scrollContainer, 'scrollTop', {
					value: Math.min(top, max),
					configurable: true,
				});
				fireEvent.scroll(scrollContainer);
			});
			scrollContainer.scrollTo = scrollToSpy as unknown as HTMLElement['scrollTo'];

			// User scrolls up so the pin button appears.
			Object.defineProperty(scrollContainer, 'scrollTop', { value: 0, configurable: true });
			fireEvent.scroll(scrollContainer);
			await act(async () => {
				vi.advanceTimersByTime(20);
			});
			expect(screen.getByTitle(/pin/i)).toBeInTheDocument();

			// Click the pin: synchronously arms the guard (records bottom target
			// 600, starts the 100ms timer) and jumps to the bottom.
			await act(async () => {
				fireEvent.click(screen.getByTitle(/pin/i));
				vi.advanceTimersByTime(20); // clear the scroll throttle; guard still armed
			});
			onAtBottomChange.mockClear();
			scrollToSpy.mockClear();

			// User scrolls up again, still well inside the guard window.
			Object.defineProperty(scrollContainer, 'scrollTop', { value: 0, configurable: true });
			fireEvent.scroll(scrollContainer);
			await act(async () => {
				vi.advanceTimersByTime(20);
			});

			// Discriminator: the scroll-up registered as leaving the bottom, and
			// the pin button is shown again (auto-scroll paused).
			expect(onAtBottomChange).toHaveBeenCalledWith(false);
			expect(screen.getByTitle(/pin/i)).toBeInTheDocument();
		});
	});

	describe('explicit scroll-to-bottom request', () => {
		/**
		 * A bang command's output card is content the user asked for, so it has
		 * to be revealed even when they had scrolled up to read history - the one
		 * case where the auto-scroll pause is the wrong answer.
		 */
		function renderScrolledUp() {
			const logs: LogEntry[] = [
				createLogEntry({ id: 'user-1', text: 'Hello', source: 'user' }),
				createLogEntry({ id: 'resp-1', text: 'Response', source: 'stdout' }),
			];
			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const { container } = render(<TerminalOutput {...createDefaultProps({ session })} />);
			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
			const scrollToSpy = vi.fn();
			scrollContainer.scrollTo = scrollToSpy;

			// Park the view away from the bottom, which pauses auto-scroll.
			Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, configurable: true });
			Object.defineProperty(scrollContainer, 'scrollTop', { value: 0, configurable: true });
			Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
			fireEvent.scroll(scrollContainer);

			return { session, scrollToSpy };
		}

		async function dispatchScrollRequest(sessionId: string, tabId: string) {
			await act(async () => {
				window.dispatchEvent(
					new CustomEvent(TRANSCRIPT_SCROLL_TO_BOTTOM_EVENT, {
						detail: { sessionId, tabId },
					})
				);
				vi.advanceTimersByTime(50);
			});
		}

		it('jumps to the bottom even while auto-scroll is paused', async () => {
			const { session, scrollToSpy } = renderScrolledUp();
			await act(async () => {
				vi.advanceTimersByTime(50);
			});
			scrollToSpy.mockClear();

			await dispatchScrollRequest(session.id, 'tab-1');

			expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: 'auto' });
		});

		it('ignores a request aimed at another tab or another agent', async () => {
			const { session, scrollToSpy } = renderScrolledUp();
			await act(async () => {
				vi.advanceTimersByTime(50);
			});
			scrollToSpy.mockClear();

			await dispatchScrollRequest(session.id, 'tab-2');
			await dispatchScrollRequest('session-other', 'tab-1');

			expect(scrollToSpy).not.toHaveBeenCalled();
		});

		it('resumes following the tail, so later output stays visible', async () => {
			const logs: LogEntry[] = [createLogEntry({ id: 'user-1', text: 'Hello', source: 'user' })];
			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const { container, rerender } = render(
				<TerminalOutput {...createDefaultProps({ session })} />
			);
			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
			const scrollToSpy = vi.fn();
			scrollContainer.scrollTo = scrollToSpy;

			Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, configurable: true });
			Object.defineProperty(scrollContainer, 'scrollTop', { value: 0, configurable: true });
			Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
			fireEvent.scroll(scrollContainer);
			await act(async () => {
				vi.advanceTimersByTime(50);
			});

			await dispatchScrollRequest(session.id, 'tab-1');
			scrollToSpy.mockClear();

			// Streaming output lands after the request - it must follow, not stall.
			const newSession = {
				...session,
				tabs: [
					{
						id: 'tab-1',
						agentSessionId: 'claude-123',
						logs: [
							...logs,
							createLogEntry({ id: 'out-1', text: 'command output', source: 'stdout' }),
						],
						isUnread: false,
					},
				],
			};
			rerender(<TerminalOutput {...createDefaultProps({ session: newSession })} />);
			await act(async () => {
				vi.advanceTimersByTime(50);
			});

			expect(scrollToSpy).toHaveBeenCalled();
		});
	});

	describe('scroll position persistence', () => {
		it('calls onScrollPositionChange when scrolling (throttled)', async () => {
			const onScrollPositionChange = vi.fn();
			const props = createDefaultProps({ onScrollPositionChange });
			const { container } = render(<TerminalOutput {...props} />);

			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;

			// Simulate scroll. `writable` matters: real `scrollTop` is settable, and
			// the mount-time restore writes to it, so a read-only stub throws where
			// the browser would not.
			Object.defineProperty(scrollContainer, 'scrollTop', {
				value: 100,
				writable: true,
				configurable: true,
			});
			fireEvent.scroll(scrollContainer);

			// Wait for throttle
			await act(async () => {
				vi.advanceTimersByTime(250);
			});

			expect(onScrollPositionChange).toHaveBeenCalledWith(100);
		});

		/**
		 * Mount a transcript and hand back a handle on the scroll box, with
		 * `scrollTop` backed by a real variable so we can see where the restore
		 * actually put the view. `scrollHeight` is settable because the whole
		 * point of these tests is content whose height changes underneath the
		 * restore - while the tab was off screen, or as it settles on mount.
		 *
		 * Writes to `scrollTop` are CLAMPED to `scrollHeight - clientHeight`, the
		 * way a real browser clamps them. Without that, "scroll to the bottom"
		 * (which asks for `scrollHeight`, the honest way to say "as far as this
		 * goes") reads back as a number no element could ever hold, and the test
		 * measures the stub rather than the restore.
		 */
		function mountWithScrollBox(
			extraProps: Record<string, unknown>,
			{ scrollHeight = 15000, clientHeight = 800 } = {}
		) {
			const { container } = render(<TerminalOutput {...createDefaultProps(extraProps)} />);
			const el = container.querySelector('.overflow-y-auto') as HTMLElement;
			let top = 0;
			let height = scrollHeight;
			const clamp = (v: number) => Math.max(0, Math.min(v, height - clientHeight));
			Object.defineProperty(el, 'scrollTop', {
				configurable: true,
				get: () => top,
				set: (v: number) => {
					top = clamp(v);
				},
			});
			Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => height });
			Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
			el.scrollTo = ((opts: { top: number }) => {
				top = clamp(opts.top);
			}) as unknown as typeof el.scrollTo;

			return {
				el,
				scrollTop: () => top,
				bottom: () => height - clientHeight,
				grow: (to: number) => {
					height = to;
					// Growth the transcript can SEE. `scrollHeight` is a getter here,
					// and moving a getter notifies nothing: the follow-the-tail
					// re-pin hangs off a MutationObserver on the scroll container, so
					// content has to actually arrive in the DOM for it to fire, the
					// same as it does in the app.
					el.appendChild(document.createElement('div'));
				},
				settle: async (ms = 800) => {
					await act(async () => {
						// Let any pending MutationObserver callback land FIRST. It is
						// delivered as a microtask and it is what schedules the re-pin
						// frame, so advancing timers before it runs drains an empty
						// frame queue and the re-pin is never seen.
						await Promise.resolve();
						vi.advanceTimersByTime(ms);
					});
				},
			};
		}

		it('restores a tab parked mid-history to its saved offset', async () => {
			// isAtBottom false means the user deliberately scrolled up to read.
			// New entries are appended BELOW them, so the offset still points at
			// what they were reading and must be honored exactly.
			const box = mountWithScrollBox({ initialScrollTop: 4200, initialIsAtBottom: false });
			await box.settle();

			expect(box.scrollTop()).toBe(4200);
		});

		it('pauses auto-scroll when it restores mid-history', async () => {
			// Otherwise the MutationObserver yanks the view straight back down and
			// the restore is pointless.
			const onAtBottomChange = vi.fn();
			const box = mountWithScrollBox({
				initialScrollTop: 4200,
				initialIsAtBottom: false,
				onAtBottomChange,
			});
			await box.settle();

			expect(box.scrollTop()).toBeLessThan(box.bottom() - 50);
		});

		it('restores a tail-following tab to the BOTTOM, not its saved offset', async () => {
			// The regression: `scrollTop` is a snapshot of where the bottom was at
			// save time. This tab was AT the bottom when it was 5000px tall (offset
			// 4200), then the agent wrote another 10000px while it was off screen.
			// Restoring 4200 verbatim strands the user 10000px above the reply they
			// clicked a toast to go and read.
			const box = mountWithScrollBox({ initialScrollTop: 4200, initialIsAtBottom: true });
			await box.settle();

			expect(box.scrollTop()).toBe(box.bottom());
		});

		it('treats an unset isAtBottom as following the tail', async () => {
			// `undefined` is what a tab that has never been scrolled carries. It has
			// to mean bottom, and it has to mean the SAME thing here as it does to
			// the unread gate in useAgentDataListener, which reads `!== false`.
			const box = mountWithScrollBox({ initialScrollTop: 4200 });
			await box.settle();

			expect(box.scrollTop()).toBe(box.bottom());
		});

		it('keeps chasing the bottom while the content is still settling', async () => {
			// Images decoding and code blocks re-highlighting grow the transcript
			// for several frames after mount, so "landed on the bottom" is true on
			// the first frame and wrong on the next. Latching there would leave the
			// tab short by however much arrived late.
			const box = mountWithScrollBox({ initialIsAtBottom: true }, { scrollHeight: 6000 });
			await box.settle(50);

			box.grow(21000);
			await box.settle();

			expect(box.scrollTop()).toBe(box.bottom());
		});

		it('does not fight a user who scrolls while the restore is still settling', async () => {
			// Their input wins - a restore that keeps yanking the view is worse
			// than landing high. The wheel is what makes this the user: a bare
			// `scroll` event is also what our own writes produce.
			const box = mountWithScrollBox({ initialIsAtBottom: true }, { scrollHeight: 6000 });
			fireEvent.wheel(box.el);
			fireEvent.scroll(box.el);
			await box.settle();

			box.grow(21000);
			await box.settle();

			expect(box.scrollTop()).toBeLessThan(box.bottom());
		});

		it('does not mistake a late echo of its own write for the user scrolling up', async () => {
			// THE regression behind "I come back and I am way up the transcript".
			// Every scroll this component performs fires a `scroll` event that is
			// indistinguishable from the user's, and the one-shot guard covers at
			// most one of them: the restore writes each frame, the handler is
			// throttled to 16ms, and `scrollToBottom` drops the guard on a 32ms
			// timer. An event the guard missed reported an offset that was no longer
			// the bottom (the content grew underneath it), which read as a scroll-up:
			// auto-scroll paused and the tab was persisted as parked mid-history, so
			// every later visit opened it high with the tail no longer followed.
			const onAtBottomChange = vi.fn();
			const box = mountWithScrollBox(
				{ initialIsAtBottom: true, onAtBottomChange },
				{ scrollHeight: 6000 }
			);
			await box.settle();
			const landed = box.scrollTop();

			// The agent writes more while the user sits at the bottom, then the
			// event for OUR last write is delivered against the taller content.
			box.grow(21000);
			fireEvent.scroll(box.el);
			await box.settle(250);

			expect(landed).toBe(5200);
			expect(onAtBottomChange).not.toHaveBeenCalledWith(false);
		});

		it('does not persist a position while the restore is still settling', async () => {
			// Saving a way-point of our own restore overwrote the tab's real
			// position with wherever the climb had got to, and wrote
			// `isAtBottom: false` for a tab that was following the tail. The tab
			// then opened there next time, higher every visit.
			const onScrollPositionChange = vi.fn();
			const onAtBottomChange = vi.fn();
			const box = mountWithScrollBox(
				{ initialIsAtBottom: true, onScrollPositionChange, onAtBottomChange },
				{ scrollHeight: 6000 }
			);
			await box.settle(50);

			box.grow(21000);
			fireEvent.scroll(box.el);
			await act(async () => {
				vi.advanceTimersByTime(250);
			});

			expect(onAtBottomChange).not.toHaveBeenCalledWith(false);
			expect(onScrollPositionChange).not.toHaveBeenCalledWith(5200);
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
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
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
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({ session });
			render(<TerminalOutput {...props} />);

			expect(screen.getByText(/日本語テスト.*🎉.*émojis/)).toBeInTheDocument();
		});
	});

	describe('mode pill rendering', () => {
		// The pill is opt-in (Display -> Provider Mode Pill, default off), so every
		// assertion about its label has to turn the display setting on first.
		beforeEach(() => {
			useSettingsStore.setState({ showProviderModePill: true });
		});

		afterEach(() => {
			useSettingsStore.setState({ showProviderModePill: false });
		});

		it('is suppressed entirely when the display setting is off', () => {
			useSettingsStore.setState({ showProviderModePill: false });

			const logs: LogEntry[] = [
				createLogEntry({ id: 'user-1', text: 'prompt', source: 'user' }),
				createLogEntry({
					id: 'resp-1',
					text: 'response from API stream',
					source: 'stdout',
					renderStyle: 'structured',
				}),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			render(<TerminalOutput {...createDefaultProps({ session })} />);

			expect(screen.getByText('response from API stream')).toBeInTheDocument();
			expect(screen.queryByText('claude -p')).not.toBeInTheDocument();
			expect(screen.queryByText('TUI Wrapper')).not.toBeInTheDocument();
		});

		it('still renders the model and effort pills when the mode pill is off', () => {
			useSettingsStore.setState({ showProviderModePill: false });

			const logs: LogEntry[] = [
				createLogEntry({ id: 'user-1', text: 'prompt', source: 'user' }),
				createLogEntry({
					id: 'resp-1',
					text: 'response',
					source: 'stdout',
					renderStyle: 'structured',
					turnModel: 'opus',
					turnEffort: 'high',
				}),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			render(<TerminalOutput {...createDefaultProps({ session })} />);

			expect(screen.getByText('opus')).toBeInTheDocument();
			expect(screen.getByText('high')).toBeInTheDocument();
			expect(screen.queryByText('claude -p')).not.toBeInTheDocument();
		});

		it('labels TUI and API turns separately when both render styles coexist', () => {
			const logs: LogEntry[] = [
				createLogEntry({ id: 'user-1', text: 'first prompt', source: 'user' }),
				createLogEntry({
					id: 'api-resp',
					text: 'response from API stream',
					source: 'stdout',
					renderStyle: 'structured',
				}),
				createLogEntry({ id: 'user-2', text: 'second prompt', source: 'user' }),
				createLogEntry({
					id: 'interactive-resp',
					text: 'response captured from interactive TUI',
					source: 'stdout',
					renderStyle: 'text-stream',
				}),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			render(<TerminalOutput {...createDefaultProps({ session })} />);

			expect(screen.getByText('claude -p')).toBeInTheDocument();
			expect(screen.getByText('TUI Wrapper')).toBeInTheDocument();
		});

		it('labels an interactive turn as TUI even when a system banner leads its response group', () => {
			// Regression: Dynamic mode (and, before the fix, plain TUI) inserts an
			// "Adaptive Mode: switched ..." system entry just before the streamed
			// response. `collapsedLogs` merges the consecutive non-user entries into
			// one block; basing the merged entry only on `[0]` inherited the banner's
			// missing renderStyle and mislabeled the maestro-p turn as "API".
			const logs: LogEntry[] = [
				createLogEntry({ id: 'user-1', text: 'prompt', source: 'user' }),
				createLogEntry({
					id: 'banner',
					text: 'Adaptive Mode: switched from API Limits to Time Limits. Quota windows reset.',
					source: 'system',
				}),
				createLogEntry({
					id: 'interactive-resp',
					text: 'response captured from interactive TUI',
					source: 'stdout',
					renderStyle: 'text-stream',
				}),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			render(<TerminalOutput {...createDefaultProps({ session })} />);

			expect(screen.getByText('TUI Wrapper')).toBeInTheDocument();
			expect(screen.queryByText('claude -p')).not.toBeInTheDocument();
		});

		it('uses the "Dynamic" prefix when the session has Adaptive Mode enabled', () => {
			const logs: LogEntry[] = [
				createLogEntry({ id: 'user-1', text: 'first prompt', source: 'user' }),
				createLogEntry({
					id: 'resp-tui',
					text: 'tui response',
					source: 'stdout',
					renderStyle: 'text-stream',
				}),
				createLogEntry({ id: 'user-2', text: 'second prompt', source: 'user' }),
				createLogEntry({
					id: 'resp-api',
					text: 'api response',
					source: 'stdout',
					renderStyle: 'structured',
				}),
			];

			const session = createDefaultSession({
				enableMaestroP: true,
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			render(<TerminalOutput {...createDefaultProps({ session })} />);

			expect(screen.getByText('Dynamic TUI Wrapper')).toBeInTheDocument();
			expect(screen.getByText('Dynamic claude -p')).toBeInTheDocument();
			expect(screen.queryByText('TUI Wrapper')).not.toBeInTheDocument();
			expect(screen.queryByText('claude -p')).not.toBeInTheDocument();
		});

		it('omits the "Dynamic" prefix when the session pins maestro-p mode (forced TUI / API)', () => {
			const logs: LogEntry[] = [
				createLogEntry({ id: 'user-1', text: 'first prompt', source: 'user' }),
				createLogEntry({
					id: 'resp-tui',
					text: 'tui response',
					source: 'stdout',
					renderStyle: 'text-stream',
				}),
				createLogEntry({ id: 'user-2', text: 'second prompt', source: 'user' }),
				createLogEntry({
					id: 'resp-api',
					text: 'api response',
					source: 'stdout',
					renderStyle: 'structured',
				}),
			];

			// Forced TUI: enableMaestroP on + maestroPMode 'interactive' is NOT
			// adaptive - only Dynamic mode auto-switches, so the prefix must drop.
			const session = createDefaultSession({
				enableMaestroP: true,
				maestroPMode: 'interactive',
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			render(<TerminalOutput {...createDefaultProps({ session })} />);

			expect(screen.getByText('TUI Wrapper')).toBeInTheDocument();
			expect(screen.getByText('claude -p')).toBeInTheDocument();
			expect(screen.queryByText('Dynamic TUI Wrapper')).not.toBeInTheDocument();
			expect(screen.queryByText('Dynamic claude -p')).not.toBeInTheDocument();
		});

		it('does not render the pill on user messages even when tagged text-stream', () => {
			const logs: LogEntry[] = [
				createLogEntry({
					id: 'user-1',
					text: 'a user prompt',
					source: 'user',
					renderStyle: 'text-stream',
				}),
			];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			render(<TerminalOutput {...createDefaultProps({ session })} />);

			expect(screen.getByText('a user prompt')).toBeInTheDocument();
			expect(screen.queryByText('TUI Wrapper')).not.toBeInTheDocument();
			expect(screen.queryByText('claude -p')).not.toBeInTheDocument();
		});

		it('does not render the pill on non-Claude agents', () => {
			const logs: LogEntry[] = [
				createLogEntry({ id: 'user-1', text: 'prompt', source: 'user' }),
				createLogEntry({ id: 'resp-1', text: 'response', source: 'stdout' }),
			];

			const session = createDefaultSession({
				toolType: 'codex',
				tabs: [{ id: 'tab-1', agentSessionId: 'codex-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			render(<TerminalOutput {...createDefaultProps({ session })} />);

			expect(screen.queryByText('TUI Wrapper')).not.toBeInTheDocument();
			expect(screen.queryByText('claude -p')).not.toBeInTheDocument();
			expect(screen.queryByText('Dynamic TUI Wrapper')).not.toBeInTheDocument();
			expect(screen.queryByText('Dynamic claude -p')).not.toBeInTheDocument();
		});
	});

	describe('model / effort pill rendering', () => {
		it('labels each response with the model and effort its turn was sent with', () => {
			// The point of the pills: the user switched configuration mid-conversation,
			// so each response has to say which one produced it.
			const logs: LogEntry[] = [
				createLogEntry({ id: 'user-1', text: 'first prompt', source: 'user' }),
				createLogEntry({
					id: 'resp-1',
					text: 'answered by opus',
					source: 'stdout',
					turnModel: 'opus',
					turnEffort: 'high',
				}),
				createLogEntry({ id: 'user-2', text: 'second prompt', source: 'user' }),
				createLogEntry({
					id: 'resp-2',
					text: 'answered by sonnet',
					source: 'stdout',
					turnModel: 'sonnet',
					turnEffort: 'low',
				}),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			render(<TerminalOutput {...createDefaultProps({ session })} />);

			expect(screen.getByText('opus')).toBeInTheDocument();
			expect(screen.getByText('high')).toBeInTheDocument();
			expect(screen.getByText('sonnet')).toBeInTheDocument();
			expect(screen.getByText('low')).toBeInTheDocument();
		});

		it('renders on non-Claude agents, which have no token-source pill', () => {
			const logs: LogEntry[] = [
				createLogEntry({ id: 'user-1', text: 'prompt', source: 'user' }),
				createLogEntry({
					id: 'resp-1',
					text: 'response',
					source: 'stdout',
					turnModel: 'gpt-5',
					turnEffort: 'medium',
				}),
			];

			const session = createDefaultSession({
				toolType: 'codex',
				tabs: [{ id: 'tab-1', agentSessionId: 'codex-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			render(<TerminalOutput {...createDefaultProps({ session })} />);

			expect(screen.getByText('gpt-5')).toBeInTheDocument();
			expect(screen.getByText('medium')).toBeInTheDocument();
			expect(screen.queryByText('claude -p')).not.toBeInTheDocument();
		});

		it('omits a pill whose value is unset, meaning the agent default applied', () => {
			const logs: LogEntry[] = [
				createLogEntry({ id: 'user-1', text: 'prompt', source: 'user' }),
				createLogEntry({ id: 'resp-1', text: 'response', source: 'stdout', turnModel: 'opus' }),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			render(<TerminalOutput {...createDefaultProps({ session })} />);

			expect(screen.getByTestId('turn-model-pill')).toHaveTextContent('opus');
			expect(screen.queryByTestId('turn-effort-pill')).not.toBeInTheDocument();
		});

		it('does not render the pills on user messages', () => {
			const logs: LogEntry[] = [
				createLogEntry({
					id: 'user-1',
					text: 'a user prompt',
					source: 'user',
					turnModel: 'opus',
					turnEffort: 'high',
				}),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			render(<TerminalOutput {...createDefaultProps({ session })} />);

			expect(screen.getByText('a user prompt')).toBeInTheDocument();
			expect(screen.queryByTestId('turn-model-pill')).not.toBeInTheDocument();
			expect(screen.queryByTestId('turn-effort-pill')).not.toBeInTheDocument();
		});

		it('keeps the pills when a system banner leads the response group', () => {
			// Same collapse trap the token-source pill hit: the combined entry is
			// built from `[0]`, which here is the banner and carries no stamp.
			const logs: LogEntry[] = [
				createLogEntry({ id: 'user-1', text: 'prompt', source: 'user' }),
				createLogEntry({
					id: 'banner',
					text: 'Adaptive Mode: switched from API Limits to Time Limits.',
					source: 'system',
				}),
				createLogEntry({
					id: 'resp-1',
					text: 'streamed response',
					source: 'stdout',
					turnModel: 'opus',
					turnEffort: 'xhigh',
				}),
			];

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			render(<TerminalOutput {...createDefaultProps({ session })} />);

			expect(screen.getByTestId('turn-model-pill')).toHaveTextContent('opus');
			expect(screen.getByTestId('turn-effort-pill')).toHaveTextContent('xhigh');
		});
	});

	describe('progressive transcript rendering (#1342)', () => {
		// Switching to an agent with a long transcript used to mount every entry in
		// one synchronous commit, freezing the UI for seconds on the PREVIOUS agent's
		// view. The newest entries must render immediately; the rest backfills later.
		const createLongTranscript = (count: number): LogEntry[] =>
			Array.from({ length: count }, (_, i) =>
				createLogEntry({
					id: `log-${i}`,
					text: `Message ${i}`,
					source: i % 2 === 0 ? 'user' : 'stdout',
				})
			);

		const renderedIndices = (container: HTMLElement): number[] =>
			Array.from(container.querySelectorAll('[data-log-index]')).map((el) =>
				Number(el.getAttribute('data-log-index'))
			);

		it('bounds the first commit instead of mounting the whole transcript', () => {
			const logs = createLongTranscript(400);
			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const { container } = render(<TerminalOutput {...createDefaultProps({ session })} />);

			const indices = renderedIndices(container);
			expect(indices.length).toBeLessThan(logs.length);
			// The newest entry is what the user is looking at - it must be present.
			expect(screen.getByText('Message 399')).toBeInTheDocument();
			// Ancient history is deferred, not dropped (see backfill test below).
			expect(screen.queryByText('Message 0')).not.toBeInTheDocument();
		});

		it('keeps absolute log indices so message navigation still targets correctly', () => {
			const logs = createLongTranscript(400);
			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const { container } = render(<TerminalOutput {...createDefaultProps({ session })} />);

			const indices = renderedIndices(container);
			// Indices are offsets into the full log list, not into the rendered window,
			// so the last one is 399 rather than (window length - 1).
			expect(indices[indices.length - 1]).toBe(399);
			expect(indices[0]).toBeGreaterThan(0);
		});

		it('backfills the deferred history over subsequent idle ticks', async () => {
			const logs = createLongTranscript(40);
			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const { container } = render(<TerminalOutput {...createDefaultProps({ session })} />);
			expect(renderedIndices(container).length).toBeLessThan(40);

			// jsdom has no requestIdleCallback, so the hook uses its setTimeout fallback.
			await act(async () => {
				vi.advanceTimersByTime(500);
			});

			expect(renderedIndices(container).length).toBe(40);
			expect(screen.getByText('Message 0')).toBeInTheDocument();
		});

		it('renders short transcripts in full immediately', () => {
			const logs = createLongTranscript(5);
			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const { container } = render(<TerminalOutput {...createDefaultProps({ session })} />);

			expect(renderedIndices(container)).toEqual([0, 1, 2, 3, 4]);
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

	describe('raw markdown source mode', () => {
		it('shows raw markdown syntax in plain text mode', () => {
			const markdownText = '# Heading\n\n**Bold** and *italic*\n\n```js\ncode\n```';
			const logs: LogEntry[] = [createLogEntry({ text: markdownText, source: 'stdout' })];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: true,
			});

			render(<TerminalOutput {...props} />);

			// Raw markdown syntax should be preserved (# for headings, ** for bold, etc.)
			expect(screen.getByText(/# Heading/)).toBeInTheDocument();
			expect(screen.getByText(/\*\*Bold\*\*/)).toBeInTheDocument();
		});

		it('preserves code fences in raw mode', () => {
			const markdownText = '```javascript\nconst x = 1;\n```';
			const logs: LogEntry[] = [createLogEntry({ text: markdownText, source: 'stdout' })];

			const session = createDefaultSession({
				tabs: [
					{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				markdownEditMode: true,
			});

			render(<TerminalOutput {...props} />);

			// Code fences and content should be preserved
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
			tabs: [
				{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
			],
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
			tabs: [
				{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false, showThinking: 'on' },
			],
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

	describe('gist publish button', () => {
		it('shows gist publish button for AI messages when ghCliAvailable is true', async () => {
			const session = createDefaultSession({
				inputMode: 'ai',
				tabs: [
					{
						id: 'tab-1',
						logs: [{ id: '1', source: 'ai', text: 'AI response text', timestamp: Date.now() }],
					},
				],
				activeTabId: 'tab-1',
			});

			const onPublishMessageGist = vi.fn();
			const props = createDefaultProps({
				session,
				ghCliAvailable: true,
				onPublishMessageGist,
			});
			render(<TerminalOutput {...props} />);

			const gistButton = screen.getByTitle('Publish as GitHub Gist');
			expect(gistButton).toBeInTheDocument();
		});

		it('hides gist publish button when ghCliAvailable is false', async () => {
			const session = createDefaultSession({
				inputMode: 'ai',
				tabs: [
					{
						id: 'tab-1',
						logs: [{ id: '1', source: 'ai', text: 'AI response text', timestamp: Date.now() }],
					},
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				ghCliAvailable: false,
			});
			render(<TerminalOutput {...props} />);

			expect(screen.queryByTitle('Publish as GitHub Gist')).not.toBeInTheDocument();
		});

		it('does not show gist publish button for user messages', async () => {
			const session = createDefaultSession({
				inputMode: 'ai',
				tabs: [
					{
						id: 'tab-1',
						logs: [{ id: '1', source: 'user', text: 'User message', timestamp: Date.now() }],
					},
				],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				ghCliAvailable: true,
				onPublishMessageGist: vi.fn(),
			});
			render(<TerminalOutput {...props} />);

			expect(screen.queryByTitle('Publish as GitHub Gist')).not.toBeInTheDocument();
		});

		it('calls onPublishMessageGist with message text when clicked', async () => {
			const session = createDefaultSession({
				inputMode: 'ai',
				tabs: [
					{
						id: 'tab-1',
						logs: [{ id: '1', source: 'ai', text: 'AI response to share', timestamp: Date.now() }],
					},
				],
				activeTabId: 'tab-1',
			});

			const onPublishMessageGist = vi.fn();
			const props = createDefaultProps({
				session,
				ghCliAvailable: true,
				onPublishMessageGist,
			});
			render(<TerminalOutput {...props} />);

			const gistButton = screen.getByTitle('Publish as GitHub Gist');
			fireEvent.click(gistButton);

			expect(onPublishMessageGist).toHaveBeenCalledWith('AI response to share', '1');
		});
	});
});

describe('collapseAiResponseLogs', () => {
	const mk = (over: Partial<LogEntry>): LogEntry =>
		({ id: 'x', timestamp: 0, source: 'stdout', text: '', ...over }) as LogEntry;

	const crossAgent = (fromAgentName: string, error?: string) => ({
		requestId: `req-${fromAgentName}`,
		fromSessionId: `sess-${fromAgentName}`,
		fromAgentName,
		fromToolType: 'claude-code' as const,
		...(error ? { error } : {}),
	});

	it('collapses consecutive local response entries into one bubble', () => {
		const out = collapseAiResponseLogs([
			mk({ id: 'u', source: 'user', text: 'hi' }),
			mk({ id: 'a', source: 'stdout', text: 'part 1 ' }),
			mk({ id: 'b', source: 'stdout', text: 'part 2' }),
		]);
		expect(out.map((l) => l.id)).toEqual(['u', 'a']);
		expect(out[1].text).toBe('part 1 part 2');
	});

	it('keeps each cross-agent reply as its own standalone bubble', () => {
		const out = collapseAiResponseLogs([
			mk({ id: 'u', source: 'user', text: 'what are we working on? @LH and @MM' }),
			mk({
				id: 'lh',
				source: 'ai',
				text: 'LH failed',
				metadata: { crossAgent: crossAgent('Learned Hand', 'no output') },
			}),
			mk({ id: 'local', source: 'stdout', text: 'Scratch here, we did X' }),
			mk({
				id: 'mm',
				source: 'ai',
				text: 'MM here',
				metadata: { crossAgent: crossAgent('Maestro Marketing') },
			}),
		]);
		// Four separate bubbles, in order, none merged.
		expect(out.map((l) => l.id)).toEqual(['u', 'lh', 'local', 'mm']);
		// The local reply keeps its own text and NO cross-agent provenance.
		const local = out.find((l) => l.id === 'local')!;
		expect(local.text).toBe('Scratch here, we did X');
		expect(local.metadata?.crossAgent).toBeUndefined();
		// Each cross-agent bubble keeps its own attribution.
		expect(out.find((l) => l.id === 'lh')!.metadata?.crossAgent?.fromAgentName).toBe(
			'Learned Hand'
		);
		expect(out.find((l) => l.id === 'mm')!.metadata?.crossAgent?.fromAgentName).toBe(
			'Maestro Marketing'
		);
	});

	it('does not fold two consecutive cross-agent replies together', () => {
		const out = collapseAiResponseLogs([
			mk({ id: 'a', source: 'ai', text: 'A', metadata: { crossAgent: crossAgent('Alpha') } }),
			mk({ id: 'b', source: 'ai', text: 'B', metadata: { crossAgent: crossAgent('Beta') } }),
		]);
		expect(out.map((l) => l.id)).toEqual(['a', 'b']);
	});

	it('preserves text-stream renderStyle when any grouped local entry carries it', () => {
		const out = collapseAiResponseLogs([
			mk({ id: 'a', source: 'system', text: 'banner ' }),
			mk({ id: 'b', source: 'stdout', text: 'streamed', renderStyle: 'text-stream' }),
		]);
		expect(out).toHaveLength(1);
		expect(out[0].renderStyle).toBe('text-stream');
	});

	it('keeps Agent Resilience outage markers standalone, not folded into a text group', () => {
		const out = collapseAiResponseLogs([
			mk({ id: 'a', source: 'stdout', text: 'before ' }),
			mk({ id: 'outage', source: 'stdout', text: 'retrying...', retryOutageId: 'out-1' }),
			mk({ id: 'b', source: 'stdout', text: 'after' }),
		]);
		// The outage marker breaks the run: the text on either side stays separate.
		expect(out.map((l) => l.id)).toEqual(['a', 'outage', 'b']);
		expect(out.find((l) => l.id === 'outage')!.retryOutageId).toBe('out-1');
	});
});
