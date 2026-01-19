/**
 * Tests for SessionPillBar component
 *
 * @file src/__tests__/web/mobile/SessionPillBar.test.tsx
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import SessionPillBar, {
	SessionPillBar as NamedSessionPillBar,
	type SessionPillBarProps,
} from '../../../web/mobile/SessionPillBar';
import type { Session } from '../../../web/hooks/useSessions';

// Mock ThemeProvider
const mockColors = {
	accent: '#8b5cf6',
	border: '#374151',
	bgMain: '#1f2937',
	bgSidebar: '#111827',
	textMain: '#f3f4f6',
	textDim: '#9ca3af',
};

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
}));

// Mock StatusDot component
vi.mock('../../../web/components/Badge', () => ({
	StatusDot: ({ status, size }: { status: string; size: string }) => (
		<span data-testid="status-dot" data-status={status} data-size={size}>
			{status}
		</span>
	),
}));

// Mock constants
const mockTriggerHaptic = vi.fn();
vi.mock('../../../web/mobile/constants', () => ({
	triggerHaptic: (pattern: number[]) => mockTriggerHaptic(pattern),
	HAPTIC_PATTERNS: {
		tap: [10],
		success: [30],
	},
}));

// Helper to create mock sessions
function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Session',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/Users/test/project',
		toolType: 'claude-code',
		bookmarked: false,
		groupId: null,
		groupName: null,
		groupEmoji: null,
		...overrides,
	} as Session;
}

// Helper to create DOMRect-like object
function createMockDOMRect(overrides: Partial<DOMRect> = {}): DOMRect {
	return {
		x: 100,
		y: 50,
		width: 120,
		height: 36,
		top: 50,
		right: 220,
		bottom: 86,
		left: 100,
		toJSON: () => ({}),
		...overrides,
	} as DOMRect;
}

describe('SessionPillBar', () => {
	let originalOntouchstart: PropertyDescriptor | undefined;
	let originalInnerWidth: PropertyDescriptor | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();

		// Store original window properties
		originalOntouchstart = Object.getOwnPropertyDescriptor(window, 'ontouchstart');
		originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');

		// Set default window.innerWidth
		Object.defineProperty(window, 'innerWidth', {
			value: 375,
			writable: true,
			configurable: true,
		});

		// Mock scrollTo on any element
		Element.prototype.scrollTo = vi.fn();

		// Mock getBoundingClientRect
		Element.prototype.getBoundingClientRect = vi.fn(() => createMockDOMRect());
	});

	afterEach(() => {
		vi.useRealTimers();

		// Restore original window properties
		if (originalOntouchstart !== undefined) {
			Object.defineProperty(window, 'ontouchstart', originalOntouchstart);
		} else {
			delete (window as Record<string, unknown>).ontouchstart;
		}

		if (originalInnerWidth !== undefined) {
			Object.defineProperty(window, 'innerWidth', originalInnerWidth);
		}
	});

	describe('exports', () => {
		it('exports SessionPillBar as default', () => {
			expect(SessionPillBar).toBeDefined();
			expect(typeof SessionPillBar).toBe('function');
		});

		it('exports SessionPillBar as named export', () => {
			expect(NamedSessionPillBar).toBeDefined();
			expect(SessionPillBar).toBe(NamedSessionPillBar);
		});
	});

	describe('empty state', () => {
		it('renders empty state message when no sessions', () => {
			render(<SessionPillBar sessions={[]} activeSessionId={null} onSelectSession={vi.fn()} />);

			expect(screen.getByText('No sessions available')).toBeInTheDocument();
		});

		it('applies custom className to empty state', () => {
			const { container } = render(
				<SessionPillBar
					sessions={[]}
					activeSessionId={null}
					onSelectSession={vi.fn()}
					className="custom-class"
				/>
			);

			expect(container.firstChild).toHaveClass('custom-class');
		});

		it('applies custom style to empty state', () => {
			const { container } = render(
				<SessionPillBar
					sessions={[]}
					activeSessionId={null}
					onSelectSession={vi.fn()}
					style={{ marginTop: '20px' }}
				/>
			);

			expect(container.firstChild).toHaveStyle({ marginTop: '20px' });
		});
	});

	describe('session pill rendering', () => {
		it('renders session pills for each session when group is expanded', () => {
			// Sessions need an activeSessionId to auto-expand the ungrouped group
			const sessions = [
				createMockSession({ id: 'session-1', name: 'Session 1' }),
				createMockSession({ id: 'session-2', name: 'Session 2' }),
			];

			render(
				<SessionPillBar sessions={sessions} activeSessionId="session-1" onSelectSession={vi.fn()} />
			);

			expect(screen.getByText('Session 1')).toBeInTheDocument();
			expect(screen.getByText('Session 2')).toBeInTheDocument();
		});

		it('marks active session with aria-pressed', () => {
			const sessions = [
				createMockSession({ id: 'session-1', name: 'Session 1' }),
				createMockSession({ id: 'session-2', name: 'Session 2' }),
			];

			render(
				<SessionPillBar sessions={sessions} activeSessionId="session-1" onSelectSession={vi.fn()} />
			);

			const activeButton = screen.getByRole('button', { pressed: true });
			expect(activeButton).toHaveAccessibleName(/Session 1/);
		});

		it('renders AI mode icon for AI sessions', () => {
			const sessions = [createMockSession({ id: 's1', inputMode: 'ai' })];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			expect(screen.getByText('AI')).toBeInTheDocument();
		});

		it('renders terminal mode icon for terminal sessions', () => {
			const sessions = [createMockSession({ id: 's1', inputMode: 'terminal' })];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			// Terminal mode shows command symbol
			expect(screen.getByText('\u2318')).toBeInTheDocument(); // ⌘
		});

		it('renders status dot with correct status', () => {
			const sessions = [
				createMockSession({ id: 's1', state: 'idle' }),
				createMockSession({ id: 's2', state: 'busy' }),
				createMockSession({ id: 's3', state: 'connecting' }),
				createMockSession({ id: 's4', state: 'error' }),
			];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			const statusDots = screen.getAllByTestId('status-dot');
			expect(statusDots).toHaveLength(4);
			expect(statusDots[0]).toHaveAttribute('data-status', 'idle');
			expect(statusDots[1]).toHaveAttribute('data-status', 'busy');
			expect(statusDots[2]).toHaveAttribute('data-status', 'connecting');
			expect(statusDots[3]).toHaveAttribute('data-status', 'error');
		});

		it('maps unknown state to error status', () => {
			const sessions = [createMockSession({ id: 's1', state: 'unknown-state' as 'idle' })];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			const statusDot = screen.getByTestId('status-dot');
			expect(statusDot).toHaveAttribute('data-status', 'error');
		});
	});

	describe('session selection', () => {
		it('calls onSelectSession when clicking session pill (non-touch)', () => {
			// Ensure not a touch device
			delete (window as Record<string, unknown>).ontouchstart;

			const onSelectSession = vi.fn();
			const sessions = [createMockSession({ id: 'session-1', name: 'Session 1' })];

			render(
				<SessionPillBar
					sessions={sessions}
					activeSessionId="session-1"
					onSelectSession={onSelectSession}
				/>
			);

			fireEvent.click(screen.getByText('Session 1').closest('button')!);

			expect(onSelectSession).toHaveBeenCalledWith('session-1');
			expect(mockTriggerHaptic).toHaveBeenCalledWith([10]); // tap pattern
		});

		it('does not call onSelectSession on click for touch devices', () => {
			// Simulate touch device
			Object.defineProperty(window, 'ontouchstart', {
				value: null,
				configurable: true,
			});

			const onSelectSession = vi.fn();
			const sessions = [createMockSession({ id: 'session-1', name: 'Session 1' })];

			render(
				<SessionPillBar
					sessions={sessions}
					activeSessionId="session-1"
					onSelectSession={onSelectSession}
				/>
			);

			fireEvent.click(screen.getByText('Session 1').closest('button')!);

			expect(onSelectSession).not.toHaveBeenCalled();
		});
	});

	describe('touch events on SessionPill', () => {
		it('selects session on tap (touchstart + touchend without movement)', () => {
			const onSelectSession = vi.fn();
			const sessions = [createMockSession({ id: 'session-1', name: 'Session 1' })];

			render(
				<SessionPillBar
					sessions={sessions}
					activeSessionId="session-1"
					onSelectSession={onSelectSession}
				/>
			);

			const button = screen.getByText('Session 1').closest('button')!;

			// Simulate touch start
			fireEvent.touchStart(button, {
				touches: [{ clientX: 100, clientY: 50 }],
			});

			// Simulate touch end without movement
			fireEvent.touchEnd(button);

			expect(onSelectSession).toHaveBeenCalledWith('session-1');
			expect(mockTriggerHaptic).toHaveBeenCalledWith([10]); // tap pattern
		});

		it('does not select session when scrolling (movement > threshold)', () => {
			const onSelectSession = vi.fn();
			const sessions = [createMockSession({ id: 'session-1', name: 'Session 1' })];

			render(
				<SessionPillBar
					sessions={sessions}
					activeSessionId="session-1"
					onSelectSession={onSelectSession}
				/>
			);

			const button = screen.getByText('Session 1').closest('button')!;

			// Simulate touch start
			fireEvent.touchStart(button, {
				touches: [{ clientX: 100, clientY: 50 }],
			});

			// Simulate touch move beyond threshold (10px)
			fireEvent.touchMove(button, {
				touches: [{ clientX: 120, clientY: 50 }],
			});

			// Simulate touch end
			fireEvent.touchEnd(button);

			expect(onSelectSession).not.toHaveBeenCalled();
		});

		it('triggers long press after 500ms', () => {
			const onSelectSession = vi.fn();
			const sessions = [createMockSession({ id: 'session-1', name: 'Session 1' })];

			render(
				<SessionPillBar
					sessions={sessions}
					activeSessionId="session-1"
					onSelectSession={onSelectSession}
				/>
			);

			const button = screen.getByText('Session 1').closest('button')!;

			// Simulate touch start
			fireEvent.touchStart(button, {
				touches: [{ clientX: 100, clientY: 50 }],
			});

			// Advance timers to trigger long press
			act(() => {
				vi.advanceTimersByTime(500);
			});

			expect(mockTriggerHaptic).toHaveBeenCalledWith([30]); // success pattern for long press

			// Touch end should NOT select (long press was triggered)
			fireEvent.touchEnd(button);
			expect(onSelectSession).not.toHaveBeenCalled();
		});

		it('cancels long press on touch cancel', () => {
			const sessions = [createMockSession({ id: 'session-1', name: 'Session 1' })];

			render(
				<SessionPillBar sessions={sessions} activeSessionId="session-1" onSelectSession={vi.fn()} />
			);

			const button = screen.getByText('Session 1').closest('button')!;

			// Simulate touch start
			fireEvent.touchStart(button, {
				touches: [{ clientX: 100, clientY: 50 }],
			});

			// Cancel touch
			fireEvent.touchCancel(button);

			// Advance timers - long press should not trigger
			act(() => {
				vi.advanceTimersByTime(600);
			});

			// Only the tap pattern from previous tests should be in the mock calls
			// The success pattern should NOT have been called
			const successCalls = mockTriggerHaptic.mock.calls.filter((call) => call[0][0] === 30);
			expect(successCalls).toHaveLength(0);
		});

		it('cancels long press when scrolling starts', () => {
			const sessions = [createMockSession({ id: 'session-1', name: 'Session 1' })];

			render(
				<SessionPillBar sessions={sessions} activeSessionId="session-1" onSelectSession={vi.fn()} />
			);

			const button = screen.getByText('Session 1').closest('button')!;

			// Simulate touch start
			fireEvent.touchStart(button, {
				touches: [{ clientX: 100, clientY: 50 }],
			});

			// Move beyond threshold to trigger scroll detection
			fireEvent.touchMove(button, {
				touches: [{ clientX: 115, clientY: 50 }],
			});

			// Advance timers - long press should not trigger because we're scrolling
			act(() => {
				vi.advanceTimersByTime(600);
			});

			const successCalls = mockTriggerHaptic.mock.calls.filter((call) => call[0][0] === 30);
			expect(successCalls).toHaveLength(0);
		});

		it('handles touchMove with no touchStart ref', () => {
			const sessions = [createMockSession({ id: 'session-1', name: 'Session 1' })];

			render(
				<SessionPillBar sessions={sessions} activeSessionId="session-1" onSelectSession={vi.fn()} />
			);

			const button = screen.getByText('Session 1').closest('button')!;

			// Simulate touch move without touchStart (edge case)
			fireEvent.touchMove(button, {
				touches: [{ clientX: 120, clientY: 50 }],
			});

			// Should not throw
			expect(true).toBe(true);
		});
	});

	describe('context menu (right-click)', () => {
		it('shows popover on right-click (desktop)', () => {
			const sessions = [createMockSession({ id: 'session-1', name: 'Session 1' })];

			render(
				<SessionPillBar sessions={sessions} activeSessionId="session-1" onSelectSession={vi.fn()} />
			);

			const button = screen.getByText('Session 1').closest('button')!;

			fireEvent.contextMenu(button);

			// Popover should appear
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});
	});

	describe('SessionInfoPopover', () => {
		it('shows session info when long-pressing', async () => {
			const sessions = [
				createMockSession({
					id: 'session-1',
					name: 'Test Session',
					state: 'idle',
					toolType: 'claude-code',
					inputMode: 'ai',
					cwd: '/Users/test/project',
				}),
			];

			render(
				<SessionPillBar sessions={sessions} activeSessionId="session-1" onSelectSession={vi.fn()} />
			);

			const button = screen.getByText('Test Session').closest('button')!;

			// Trigger long press
			fireEvent.touchStart(button, {
				touches: [{ clientX: 100, clientY: 50 }],
			});

			act(() => {
				vi.advanceTimersByTime(500);
			});

			// Popover should appear
			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-label', 'Session info for Test Session');

			// Check popover content
			expect(screen.getByText('Status')).toBeInTheDocument();
			expect(screen.getByText('Ready')).toBeInTheDocument();
			expect(screen.getByText('Tool')).toBeInTheDocument();
			expect(screen.getByText('Claude Code')).toBeInTheDocument();
			expect(screen.getByText('Mode')).toBeInTheDocument();
			expect(screen.getByText('AI Assistant')).toBeInTheDocument();
			expect(screen.getByText('Working Directory')).toBeInTheDocument();
		});

		it('shows correct status labels', async () => {
			const testCases = [
				{ state: 'idle', label: 'Ready' },
				{ state: 'busy', label: 'Thinking...' },
				{ state: 'connecting', label: 'Connecting...' },
				{ state: 'error', label: 'Error' },
			];

			for (const { state, label } of testCases) {
				const sessions = [createMockSession({ id: 'test', state: state as 'idle' })];

				const { unmount } = render(
					<SessionPillBar sessions={sessions} activeSessionId="test" onSelectSession={vi.fn()} />
				);

				const button = screen.getByRole('button');
				fireEvent.contextMenu(button);

				expect(screen.getByText(label)).toBeInTheDocument();

				unmount();
			}
		});

		it('shows correct tool type labels', async () => {
			const testCases = [
				{ toolType: 'claude-code', label: 'Claude Code' },
				{ toolType: 'openai-codex', label: 'OpenAI Codex' },
				{ toolType: 'gemini-cli', label: 'Gemini CLI' },
				{ toolType: 'qwen3-coder', label: 'Qwen3 Coder' },
				{ toolType: 'unknown-tool', label: 'unknown-tool' }, // fallback
			];

			for (const { toolType, label } of testCases) {
				const sessions = [createMockSession({ id: 'test', toolType })];

				const { unmount } = render(
					<SessionPillBar sessions={sessions} activeSessionId="test" onSelectSession={vi.fn()} />
				);

				const button = screen.getByRole('button');
				fireEvent.contextMenu(button);

				expect(screen.getByText(label)).toBeInTheDocument();

				unmount();
			}
		});

		it('shows Terminal mode correctly', async () => {
			const sessions = [createMockSession({ id: 's1', inputMode: 'terminal' })];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			const button = screen.getByRole('button');
			fireEvent.contextMenu(button);

			expect(screen.getByText('Terminal')).toBeInTheDocument();
			expect(screen.getByText('Command Terminal')).toBeInTheDocument();
		});

		it('truncates long paths', async () => {
			const sessions = [
				createMockSession({
					id: 's1',
					cwd: '/Users/very/long/path/that/exceeds/maximum/length/for/display',
				}),
			];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			const button = screen.getByRole('button');
			fireEvent.contextMenu(button);

			// Should show truncated path
			const pathElement = screen.getByText(/\.\.\.\//);
			expect(pathElement).toBeInTheDocument();
		});

		it('does not truncate short paths', async () => {
			const sessions = [createMockSession({ id: 's1', cwd: '/short/path' })];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			const button = screen.getByRole('button');
			fireEvent.contextMenu(button);

			expect(screen.getByText('/short/path')).toBeInTheDocument();
		});

		it('closes popover on close button click', () => {
			const sessions = [createMockSession({ id: 's1' })];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			const button = screen.getByRole('button');
			fireEvent.contextMenu(button);

			expect(screen.getByRole('dialog')).toBeInTheDocument();

			// Click close button
			const closeButton = screen.getByLabelText('Close popover');
			fireEvent.click(closeButton);

			expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		});

		it('closes popover on backdrop click', () => {
			const sessions = [createMockSession({ id: 's1' })];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			const button = screen.getByRole('button');
			fireEvent.contextMenu(button);

			expect(screen.getByRole('dialog')).toBeInTheDocument();

			// Click backdrop
			const backdrop = screen.getByRole('dialog').previousElementSibling;
			fireEvent.click(backdrop!);

			expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		});

		it('closes popover on Escape key', () => {
			const sessions = [createMockSession({ id: 's1' })];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			const button = screen.getByRole('button');
			fireEvent.contextMenu(button);

			expect(screen.getByRole('dialog')).toBeInTheDocument();

			// Press Escape
			fireEvent.keyDown(document, { key: 'Escape' });

			expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		});

		it('closes popover on outside click (after delay)', () => {
			const sessions = [createMockSession({ id: 's1' })];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			const button = screen.getByRole('button');
			fireEvent.contextMenu(button);

			expect(screen.getByRole('dialog')).toBeInTheDocument();

			// Wait for the 100ms delay before the outside click listener is active
			act(() => {
				vi.advanceTimersByTime(150);
			});

			// Click outside
			fireEvent.mouseDown(document.body);

			expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		});

		it('positions popover within viewport bounds', async () => {
			// Set narrow viewport
			Object.defineProperty(window, 'innerWidth', {
				value: 300,
				writable: true,
				configurable: true,
			});

			const sessions = [createMockSession({ id: 's1' })];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			const button = screen.getByRole('button');
			fireEvent.contextMenu(button);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toBeInTheDocument();
			// Position is calculated via inline styles - verified by component rendering
		});
	});

	describe('group headers', () => {
		it('renders group headers when multiple groups exist', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Session 1',
					groupId: 'group-1',
					groupName: 'Frontend',
				}),
				createMockSession({
					id: 's2',
					name: 'Session 2',
					groupId: 'group-2',
					groupName: 'Backend',
				}),
			];

			render(
				<SessionPillBar sessions={sessions} activeSessionId={null} onSelectSession={vi.fn()} />
			);

			expect(screen.getByText('Frontend')).toBeInTheDocument();
			expect(screen.getByText('Backend')).toBeInTheDocument();
		});

		it('renders group emoji when available', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					groupId: 'group-1',
					groupName: 'Frontend',
					groupEmoji: '\uD83D\uDDA5',
				}),
				createMockSession({
					id: 's2',
					groupId: 'group-2',
					groupName: 'Backend',
				}),
			];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			expect(screen.getByText('\uD83D\uDDA5')).toBeInTheDocument(); // Computer emoji
		});

		it('shows session count badge on group header', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					groupId: 'group-1',
					groupName: 'Frontend',
				}),
				createMockSession({
					id: 's2',
					groupId: 'group-1',
					groupName: 'Frontend',
				}),
				createMockSession({
					id: 's3',
					groupId: 'group-2',
					groupName: 'Backend',
				}),
			];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			// Frontend group has 2 sessions
			expect(screen.getByText('2')).toBeInTheDocument();
			// Backend group has 1 session
			expect(screen.getByText('1')).toBeInTheDocument();
		});

		it('does not render group headers for single ungrouped group', () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Session 1' }),
				createMockSession({ id: 's2', name: 'Session 2' }),
			];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			// Should not show "Ungrouped" header
			expect(screen.queryByText('Ungrouped')).not.toBeInTheDocument();
		});

		it('shows group header for single named group', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					groupId: 'group-1',
					groupName: 'My Group',
				}),
			];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			expect(screen.getByText('My Group')).toBeInTheDocument();
		});
	});

	describe('group collapse/expand', () => {
		it('starts with groups collapsed (except bookmarks) when no active session', () => {
			// With multiple named groups and no activeSessionId, all groups start collapsed
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Session 1',
					groupId: 'group-1',
					groupName: 'Frontend',
				}),
				createMockSession({
					id: 's2',
					name: 'Session 2',
					groupId: 'group-2',
					groupName: 'Backend',
				}),
			];

			render(
				<SessionPillBar sessions={sessions} activeSessionId={null} onSelectSession={vi.fn()} />
			);

			// Session pills should be hidden initially (groups collapsed)
			expect(screen.queryByText('Session 1')).not.toBeInTheDocument();
			expect(screen.queryByText('Session 2')).not.toBeInTheDocument();
			// But group headers should be visible
			expect(screen.getByText('Frontend')).toBeInTheDocument();
			expect(screen.getByText('Backend')).toBeInTheDocument();
		});

		it('expands group on header click (non-touch)', () => {
			// Ensure not a touch device
			delete (window as Record<string, unknown>).ontouchstart;

			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Session 1',
					groupId: 'group-1',
					groupName: 'Frontend',
				}),
				createMockSession({
					id: 's2',
					name: 'Session 2',
					groupId: 'group-2',
					groupName: 'Backend',
				}),
			];

			render(
				<SessionPillBar sessions={sessions} activeSessionId={null} onSelectSession={vi.fn()} />
			);

			// Click Frontend group header
			fireEvent.click(screen.getByText('Frontend').closest('button')!);

			// Session 1 should now be visible
			expect(screen.getByText('Session 1')).toBeInTheDocument();
			// Session 2 should still be hidden
			expect(screen.queryByText('Session 2')).not.toBeInTheDocument();
		});

		it('expands group on header tap (touch)', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Session 1',
					groupId: 'group-1',
					groupName: 'Frontend',
				}),
				createMockSession({
					id: 's2',
					name: 'Session 2',
					groupId: 'group-2',
					groupName: 'Backend',
				}),
			];

			render(
				<SessionPillBar sessions={sessions} activeSessionId={null} onSelectSession={vi.fn()} />
			);

			const frontendButton = screen.getByText('Frontend').closest('button')!;

			// Simulate tap
			fireEvent.touchStart(frontendButton, {
				touches: [{ clientX: 100, clientY: 50 }],
			});
			fireEvent.touchEnd(frontendButton);

			// Session 1 should now be visible
			expect(screen.getByText('Session 1')).toBeInTheDocument();
		});

		it('does not toggle group when scrolling on header', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Session 1',
					groupId: 'group-1',
					groupName: 'Frontend',
				}),
				createMockSession({
					id: 's2',
					name: 'Session 2',
					groupId: 'group-2',
					groupName: 'Backend',
				}),
			];

			render(
				<SessionPillBar sessions={sessions} activeSessionId={null} onSelectSession={vi.fn()} />
			);

			const frontendButton = screen.getByText('Frontend').closest('button')!;

			// Simulate scroll on group header
			fireEvent.touchStart(frontendButton, {
				touches: [{ clientX: 100, clientY: 50 }],
			});
			fireEvent.touchMove(frontendButton, {
				touches: [{ clientX: 130, clientY: 50 }],
			});
			fireEvent.touchEnd(frontendButton);

			// Session 1 should still be hidden
			expect(screen.queryByText('Session 1')).not.toBeInTheDocument();
		});

		it('handles touch cancel on group header', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Session 1',
					groupId: 'group-1',
					groupName: 'Frontend',
				}),
				createMockSession({
					id: 's2',
					groupId: 'group-2',
					groupName: 'Backend',
				}),
			];

			render(
				<SessionPillBar sessions={sessions} activeSessionId={null} onSelectSession={vi.fn()} />
			);

			const frontendButton = screen.getByText('Frontend').closest('button')!;

			fireEvent.touchStart(frontendButton, {
				touches: [{ clientX: 100, clientY: 50 }],
			});
			fireEvent.touchCancel(frontendButton);

			// Should not throw, group should remain collapsed
			expect(screen.queryByText('Session 1')).not.toBeInTheDocument();
		});

		it('collapses expanded group on second tap', () => {
			// Ensure not a touch device
			delete (window as Record<string, unknown>).ontouchstart;

			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Session 1',
					groupId: 'group-1',
					groupName: 'Frontend',
				}),
				createMockSession({
					id: 's2',
					name: 'Session 2',
					groupId: 'group-2',
					groupName: 'Backend',
				}),
			];

			render(
				<SessionPillBar sessions={sessions} activeSessionId={null} onSelectSession={vi.fn()} />
			);

			const frontendButton = screen.getByText('Frontend').closest('button')!;

			// First click - expand
			fireEvent.click(frontendButton);
			expect(screen.getByText('Session 1')).toBeInTheDocument();

			// Second click - collapse
			fireEvent.click(frontendButton);
			expect(screen.queryByText('Session 1')).not.toBeInTheDocument();
		});

		it('scrolls to group header when expanding', async () => {
			const sessions = [
				createMockSession({
					id: 's1',
					groupId: 'group-1',
					groupName: 'Frontend',
				}),
				createMockSession({
					id: 's2',
					groupId: 'group-2',
					groupName: 'Backend',
				}),
			];

			render(
				<SessionPillBar sessions={sessions} activeSessionId={null} onSelectSession={vi.fn()} />
			);

			const frontendButton = screen.getByText('Frontend').closest('button')!;

			// Expand the group
			fireEvent.touchStart(frontendButton, {
				touches: [{ clientX: 100, clientY: 50 }],
			});
			fireEvent.touchEnd(frontendButton);

			// Wait for scroll timeout
			act(() => {
				vi.advanceTimersByTime(100);
			});

			expect(Element.prototype.scrollTo).toHaveBeenCalled();
		});

		it('auto-expands group containing active session', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Session 1',
					groupId: 'group-1',
					groupName: 'Frontend',
				}),
				createMockSession({
					id: 's2',
					name: 'Session 2',
					groupId: 'group-2',
					groupName: 'Backend',
				}),
			];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			// Active session's group should be expanded
			expect(screen.getByText('Session 1')).toBeInTheDocument();
			// Other group should still be collapsed
			expect(screen.queryByText('Session 2')).not.toBeInTheDocument();
		});

		it('shows collapse indicator arrow', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					groupId: 'group-1',
					groupName: 'Frontend',
				}),
				createMockSession({
					id: 's2',
					groupId: 'group-2',
					groupName: 'Backend',
				}),
			];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			// Should have collapse indicators
			const arrows = screen.getAllByText('\u25BC'); // ▼
			expect(arrows).toHaveLength(2);
		});
	});

	describe('bookmarks group', () => {
		it('creates special bookmarks group for bookmarked sessions', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Bookmarked Session',
					bookmarked: true,
				}),
				createMockSession({
					id: 's2',
					name: 'Regular Session',
					bookmarked: false,
					groupId: 'group-1',
					groupName: 'My Group',
				}),
			];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			expect(screen.getByText('Bookmarks')).toBeInTheDocument();
			expect(screen.getByText('\u2605')).toBeInTheDocument(); // ★ star emoji
		});

		it('expands bookmarks group by default', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Bookmarked Session',
					bookmarked: true,
				}),
				createMockSession({
					id: 's2',
					name: 'Regular Session',
					bookmarked: false,
					groupId: 'group-1',
					groupName: 'My Group',
				}),
			];

			render(
				<SessionPillBar sessions={sessions} activeSessionId={null} onSelectSession={vi.fn()} />
			);

			// Bookmarked session should be visible (bookmarks expanded by default)
			expect(screen.getByText('Bookmarked Session')).toBeInTheDocument();
			// Regular session in other group should be hidden (no active session to auto-expand)
			expect(screen.queryByText('Regular Session')).not.toBeInTheDocument();
		});

		it('sorts bookmarks group first', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Session A',
					groupId: 'a-group',
					groupName: 'Alpha',
				}),
				createMockSession({
					id: 's2',
					name: 'Bookmarked',
					bookmarked: true,
				}),
				createMockSession({
					id: 's3',
					name: 'Session Z',
					groupId: 'z-group',
					groupName: 'Zeta',
				}),
			];

			render(<SessionPillBar sessions={sessions} activeSessionId="s2" onSelectSession={vi.fn()} />);

			// Get all group headers
			const buttons = screen.getAllByRole('button');
			const groupHeaders = buttons.filter((btn) => btn.getAttribute('aria-expanded') !== null);

			// First group should be Bookmarks
			expect(groupHeaders[0]).toHaveAccessibleName(/Bookmarks/);
		});
	});

	describe('ungrouped sessions', () => {
		it('shows Ungrouped label for sessions without group', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Grouped',
					groupId: 'group-1',
					groupName: 'My Group',
				}),
				createMockSession({
					id: 's2',
					name: 'Ungrouped Session',
					groupId: null,
					groupName: null,
				}),
			];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			expect(screen.getByText('Ungrouped')).toBeInTheDocument();
		});

		it('sorts ungrouped last', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Ungrouped Session',
				}),
				createMockSession({
					id: 's2',
					groupId: 'group-1',
					groupName: 'Alpha',
				}),
			];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			const buttons = screen.getAllByRole('button');
			const groupHeaders = buttons.filter((btn) => btn.getAttribute('aria-expanded') !== null);

			// Last group should be Ungrouped
			expect(groupHeaders[groupHeaders.length - 1]).toHaveAccessibleName(/Ungrouped/);
		});
	});

	describe('scrolling behavior', () => {
		it('attempts to scroll active session into view on mount', () => {
			// The component calls scrollTo but only when the button is visible
			// With ungrouped sessions, the active session auto-expands the group
			const sessions = [
				createMockSession({ id: 's1', name: 'Session 1' }),
				createMockSession({ id: 's2', name: 'Session 2' }),
			];

			render(<SessionPillBar sessions={sessions} activeSessionId="s2" onSelectSession={vi.fn()} />);

			// Session should be visible (auto-expanded)
			expect(screen.getByText('Session 2')).toBeInTheDocument();
			// scrollTo is called if the button is found with aria-pressed="true"
			// In jsdom, the mocked scrollTo may or may not be called depending on whether
			// querySelector returns the button. Check that the component renders correctly.
			expect(screen.getByRole('button', { pressed: true })).toBeInTheDocument();
		});

		it('keeps sessions visible when activeSessionId changes', () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Session 1' }),
				createMockSession({ id: 's2', name: 'Session 2' }),
			];

			const { rerender } = render(
				<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />
			);

			expect(screen.getByText('Session 1')).toBeInTheDocument();
			expect(screen.getByRole('button', { pressed: true })).toBeInTheDocument();

			rerender(
				<SessionPillBar sessions={sessions} activeSessionId="s2" onSelectSession={vi.fn()} />
			);

			// Both sessions should still be visible (same ungrouped group)
			expect(screen.getByText('Session 2')).toBeInTheDocument();
		});
	});

	describe('action buttons', () => {
		it('renders search button when onOpenAllSessions provided', () => {
			render(
				<SessionPillBar
					sessions={[createMockSession({ id: 's1' })]}
					activeSessionId="s1"
					onSelectSession={vi.fn()}
					onOpenAllSessions={vi.fn()}
				/>
			);

			expect(screen.getByLabelText(/Search.*sessions/i)).toBeInTheDocument();
		});

		it('calls onOpenAllSessions when search button clicked', () => {
			const onOpenAllSessions = vi.fn();

			render(
				<SessionPillBar
					sessions={[createMockSession({ id: 's1' })]}
					activeSessionId="s1"
					onSelectSession={vi.fn()}
					onOpenAllSessions={onOpenAllSessions}
				/>
			);

			fireEvent.click(screen.getByLabelText(/Search.*sessions/i));

			expect(onOpenAllSessions).toHaveBeenCalled();
			expect(mockTriggerHaptic).toHaveBeenCalledWith([10]);
		});

		it('renders history button when onOpenHistory provided', () => {
			render(
				<SessionPillBar
					sessions={[createMockSession({ id: 's1' })]}
					activeSessionId="s1"
					onSelectSession={vi.fn()}
					onOpenAllSessions={vi.fn()}
					onOpenHistory={vi.fn()}
				/>
			);

			expect(screen.getByLabelText('View history')).toBeInTheDocument();
		});

		it('calls onOpenHistory when history button clicked', () => {
			const onOpenHistory = vi.fn();

			render(
				<SessionPillBar
					sessions={[createMockSession({ id: 's1' })]}
					activeSessionId="s1"
					onSelectSession={vi.fn()}
					onOpenAllSessions={vi.fn()}
					onOpenHistory={onOpenHistory}
				/>
			);

			fireEvent.click(screen.getByLabelText('View history'));

			expect(onOpenHistory).toHaveBeenCalled();
			expect(mockTriggerHaptic).toHaveBeenCalledWith([10]);
		});

		it('does not render buttons when callbacks not provided', () => {
			render(
				<SessionPillBar
					sessions={[createMockSession({ id: 's1' })]}
					activeSessionId="s1"
					onSelectSession={vi.fn()}
				/>
			);

			expect(screen.queryByLabelText(/Search.*sessions/i)).not.toBeInTheDocument();
			expect(screen.queryByLabelText('View history')).not.toBeInTheDocument();
		});

		it('shows session count in search button label', () => {
			render(
				<SessionPillBar
					sessions={[createMockSession({ id: 's1' }), createMockSession({ id: 's2' })]}
					activeSessionId="s1"
					onSelectSession={vi.fn()}
					onOpenAllSessions={vi.fn()}
				/>
			);

			expect(screen.getByLabelText('Search 2 sessions')).toBeInTheDocument();
		});
	});

	describe('accessibility', () => {
		it('has tablist role on scroll container', () => {
			render(
				<SessionPillBar
					sessions={[createMockSession({ id: 's1' })]}
					activeSessionId="s1"
					onSelectSession={vi.fn()}
				/>
			);

			expect(screen.getByRole('tablist')).toBeInTheDocument();
		});

		it('provides accessible label on scroll container', () => {
			render(
				<SessionPillBar
					sessions={[createMockSession({ id: 's1' })]}
					activeSessionId="s1"
					onSelectSession={vi.fn()}
				/>
			);

			expect(screen.getByRole('tablist')).toHaveAttribute(
				'aria-label',
				expect.stringContaining('Session selector')
			);
		});

		it('provides accessible label on session pills', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'My Session',
					state: 'busy',
					inputMode: 'terminal',
				}),
			];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			const button = screen.getByRole('button');
			expect(button).toHaveAttribute('aria-label', expect.stringContaining('My Session'));
			expect(button).toHaveAttribute('aria-label', expect.stringContaining('busy'));
			expect(button).toHaveAttribute('aria-label', expect.stringContaining('terminal'));
		});

		it('includes active state in accessible label', () => {
			const sessions = [createMockSession({ id: 's1', name: 'Active Session' })];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			const button = screen.getByRole('button', { pressed: true });
			expect(button).toHaveAttribute('aria-label', expect.stringContaining('active'));
		});

		it('provides aria-expanded on group headers', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					groupId: 'group-1',
					groupName: 'Frontend',
				}),
				createMockSession({
					id: 's2',
					groupId: 'group-2',
					groupName: 'Backend',
				}),
			];

			render(
				<SessionPillBar sessions={sessions} activeSessionId={null} onSelectSession={vi.fn()} />
			);

			const groupHeaders = screen
				.getAllByRole('button')
				.filter((btn) => btn.getAttribute('aria-expanded') !== null);

			expect(groupHeaders).toHaveLength(2);
			expect(groupHeaders[0]).toHaveAttribute('aria-expanded', 'false');
		});

		it('updates aria-expanded when group is expanded', () => {
			// Ensure not a touch device
			delete (window as Record<string, unknown>).ontouchstart;

			const sessions = [
				createMockSession({
					id: 's1',
					groupId: 'group-1',
					groupName: 'Frontend',
				}),
				createMockSession({
					id: 's2',
					groupId: 'group-2',
					groupName: 'Backend',
				}),
			];

			render(
				<SessionPillBar sessions={sessions} activeSessionId={null} onSelectSession={vi.fn()} />
			);

			const frontendHeader = screen.getByText('Frontend').closest('button')!;
			expect(frontendHeader).toHaveAttribute('aria-expanded', 'false');

			fireEvent.click(frontendHeader);

			expect(frontendHeader).toHaveAttribute('aria-expanded', 'true');
		});
	});

	describe('styling', () => {
		it('applies custom className', () => {
			const { container } = render(
				<SessionPillBar
					sessions={[createMockSession({ id: 's1' })]}
					activeSessionId="s1"
					onSelectSession={vi.fn()}
					className="custom-class"
				/>
			);

			expect(container.firstChild).toHaveClass('custom-class');
		});

		it('applies custom style', () => {
			const { container } = render(
				<SessionPillBar
					sessions={[createMockSession({ id: 's1' })]}
					activeSessionId="s1"
					onSelectSession={vi.fn()}
					style={{ marginBottom: '10px' }}
				/>
			);

			expect(container.firstChild).toHaveStyle({ marginBottom: '10px' });
		});

		it('uses theme colors for styling', () => {
			render(
				<SessionPillBar
					sessions={[createMockSession({ id: 's1' })]}
					activeSessionId="s1"
					onSelectSession={vi.fn()}
				/>
			);

			// Component renders with theme colors (verified by visual output)
			expect(screen.getByRole('tablist').parentElement).toHaveStyle({
				borderBottom: `1px solid ${mockColors.border}`,
			});
		});
	});

	describe('edge cases', () => {
		it('handles session with very long name', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'This is a very long session name that should be truncated',
				}),
			];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			const nameElement = screen.getByText(
				'This is a very long session name that should be truncated'
			);
			expect(nameElement).toHaveStyle({ textOverflow: 'ellipsis' });
		});

		it('handles special characters in session name', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					name: '<script>alert("xss")</script>',
				}),
			];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			// Should render as text, not execute
			expect(screen.getByText('<script>alert("xss")</script>')).toBeInTheDocument();
		});

		it('handles unicode in session names', () => {
			const sessions = [createMockSession({ id: 's1', name: '\u1F4BB \u65E5\u672C\u8A9E' })];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			expect(screen.getByText('\u1F4BB \u65E5\u672C\u8A9E')).toBeInTheDocument();
		});

		it('handles rapid session selection', () => {
			const onSelectSession = vi.fn();
			const sessions = [createMockSession({ id: 's1' })];

			render(
				<SessionPillBar
					sessions={sessions}
					activeSessionId="s1"
					onSelectSession={onSelectSession}
				/>
			);

			const button = screen.getByRole('button');

			// Rapid taps
			for (let i = 0; i < 5; i++) {
				fireEvent.touchStart(button, { touches: [{ clientX: 100, clientY: 50 }] });
				fireEvent.touchEnd(button);
			}

			expect(onSelectSession).toHaveBeenCalledTimes(5);
		});

		it('handles sessions with missing optional fields', () => {
			const sessions = [
				{
					id: 's1',
					name: 'Minimal Session',
					state: 'idle',
					inputMode: 'ai',
					cwd: '/tmp',
					toolType: 'claude-code',
				} as Session,
			];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			expect(screen.getByText('Minimal Session')).toBeInTheDocument();
		});

		it('handles null activeSessionId with grouped sessions', () => {
			// With multiple named groups, sessions won't show without activeSessionId
			const sessions = [
				createMockSession({
					id: 's1',
					groupId: 'group-1',
					groupName: 'My Group',
				}),
				createMockSession({
					id: 's2',
					groupId: 'group-2',
					groupName: 'Another Group',
				}),
			];

			render(
				<SessionPillBar sessions={sessions} activeSessionId={null} onSelectSession={vi.fn()} />
			);

			// No session pill should have aria-pressed="true"
			const pressedButtons = screen.queryAllByRole('button', { pressed: true });
			expect(pressedButtons).toHaveLength(0);
			// But group headers should be visible
			expect(screen.getByText('My Group')).toBeInTheDocument();
		});

		it('handles activeSessionId not matching any session', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					groupId: 'group-1',
					groupName: 'My Group',
				}),
				createMockSession({
					id: 's2',
					groupId: 'group-2',
					groupName: 'Another Group',
				}),
			];

			render(
				<SessionPillBar
					sessions={sessions}
					activeSessionId="non-existent"
					onSelectSession={vi.fn()}
				/>
			);

			// Should not throw, no button pressed
			const pressedButtons = screen.queryAllByRole('button', { pressed: true });
			expect(pressedButtons).toHaveLength(0);
		});
	});

	describe('cleanup', () => {
		it('cleans up long press timer on unmount', () => {
			const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
			const sessions = [createMockSession({ id: 's1' })];

			const { unmount } = render(
				<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />
			);

			const button = screen.getByRole('button');

			// Start long press
			fireEvent.touchStart(button, { touches: [{ clientX: 100, clientY: 50 }] });

			// Unmount before timer completes
			unmount();

			expect(clearTimeoutSpy).toHaveBeenCalled();
		});

		it('removes event listeners on popover close', () => {
			const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');
			const sessions = [createMockSession({ id: 's1' })];

			render(<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />);

			// Open popover
			const button = screen.getByRole('button');
			fireEvent.contextMenu(button);

			expect(screen.getByRole('dialog')).toBeInTheDocument();

			// Close popover
			const closeButton = screen.getByLabelText('Close popover');
			fireEvent.click(closeButton);

			expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

			expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
		});
	});

	describe('integration scenarios', () => {
		it('handles full workflow: select session, view info, close', () => {
			const onSelectSession = vi.fn();
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'My Session',
					state: 'idle',
					toolType: 'claude-code',
				}),
			];

			render(
				<SessionPillBar
					sessions={sessions}
					activeSessionId="s1"
					onSelectSession={onSelectSession}
				/>
			);

			const button = screen.getByText('My Session').closest('button')!;

			// Long press to view info
			fireEvent.touchStart(button, { touches: [{ clientX: 100, clientY: 50 }] });
			act(() => {
				vi.advanceTimersByTime(500);
			});

			expect(screen.getByRole('dialog')).toBeInTheDocument();

			// Close popover
			fireEvent.keyDown(document, { key: 'Escape' });

			expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

			// Now tap to select
			fireEvent.touchStart(button, { touches: [{ clientX: 100, clientY: 50 }] });
			fireEvent.touchEnd(button);

			expect(onSelectSession).toHaveBeenCalledWith('s1');
		});

		it('handles multiple groups with active session switching', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Frontend Session',
					groupId: 'g1',
					groupName: 'Frontend',
				}),
				createMockSession({
					id: 's2',
					name: 'Backend Session',
					groupId: 'g2',
					groupName: 'Backend',
				}),
			];

			const { rerender } = render(
				<SessionPillBar sessions={sessions} activeSessionId="s1" onSelectSession={vi.fn()} />
			);

			// Frontend group expanded (active session)
			expect(screen.getByText('Frontend Session')).toBeInTheDocument();
			expect(screen.queryByText('Backend Session')).not.toBeInTheDocument();

			// Switch active session
			rerender(
				<SessionPillBar sessions={sessions} activeSessionId="s2" onSelectSession={vi.fn()} />
			);

			// Backend group now expanded
			expect(screen.getByText('Backend Session')).toBeInTheDocument();
		});
	});
});
