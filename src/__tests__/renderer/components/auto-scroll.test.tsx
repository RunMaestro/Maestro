/**
 * @file auto-scroll.test.tsx
 * @description Tests for the unified auto-scroll button (single down-arrow, right side)
 *
 * Test coverage includes:
 * - Settings integration (keyboard shortcut registration)
 * - Button rendering (visibility conditions, visual states)
 * - Click behavior (pin to bottom, unpin, re-pin after scroll-up)
 * - Pause/resume on scroll (dims on scroll-up, re-highlights on scroll-to-bottom)
 * - Props threading (backward compatibility without auto-scroll props)
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TerminalOutput } from '../../../renderer/components/TerminalOutput';
import { DEFAULT_SHORTCUTS } from '../../../renderer/constants/shortcuts';
import type { Session, Theme, LogEntry } from '../../../renderer/types';

// Mock dependencies (same pattern as TerminalOutput.test.tsx)
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
			return text;
		}
	},
}));

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn().mockReturnValue('layer-1'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
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

describe('Auto-scroll feature', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('settings integration', () => {
		it('setting is rendered in SettingsModal with correct label (shortcut registration)', () => {
			expect(DEFAULT_SHORTCUTS.toggleAutoScroll).toBeDefined();
			expect(DEFAULT_SHORTCUTS.toggleAutoScroll.label).toBe('Toggle Auto-Scroll AI Output');
			expect(DEFAULT_SHORTCUTS.toggleAutoScroll.keys).toEqual(['Alt', 'Meta', 's']);
		});
	});

	describe('keyboard shortcut', () => {
		it('auto-scroll keyboard shortcut is registered in shortcuts.ts', () => {
			const shortcut = DEFAULT_SHORTCUTS.toggleAutoScroll;
			expect(shortcut).toBeDefined();
			expect(shortcut.id).toBe('toggleAutoScroll');
			expect(shortcut.keys).toEqual(['Alt', 'Meta', 's']);
		});
	});

	describe('button rendering', () => {
		it('button does NOT render when setAutoScrollAiMode prop is not provided', () => {
			const props = createDefaultProps();

			render(<TerminalOutput {...props} />);

			expect(screen.queryByTitle(/Auto-scroll|Scroll to bottom|New messages/)).not.toBeInTheDocument();
		});

		it('button renders with accent styling when auto-scroll is active (pinned at bottom)', () => {
			const props = createDefaultProps({
				autoScrollAiMode: true,
				setAutoScrollAiMode: vi.fn(),
				session: createDefaultSession({ inputMode: 'ai' }),
			});

			render(<TerminalOutput {...props} />);

			const button = screen.getByTitle('Auto-scroll ON (click to unpin)');
			expect(button).toBeInTheDocument();
			expect(button).toHaveStyle({ backgroundColor: defaultTheme.colors.accent });
			expect(button).toHaveStyle({ color: defaultTheme.colors.accentForeground });
		});

		it('button is hidden when auto-scroll is off and at bottom (nothing to do)', () => {
			const props = createDefaultProps({
				autoScrollAiMode: false,
				setAutoScrollAiMode: vi.fn(),
			});

			render(<TerminalOutput {...props} />);

			// At bottom with auto-scroll off = no button visible
			expect(screen.queryByTitle(/Auto-scroll|Scroll to bottom|New messages/)).not.toBeInTheDocument();
		});

		it('button does NOT render in terminal mode', () => {
			const props = createDefaultProps({
				autoScrollAiMode: true,
				setAutoScrollAiMode: vi.fn(),
				session: createDefaultSession({ inputMode: 'terminal' }),
			});

			render(<TerminalOutput {...props} />);

			expect(screen.queryByTitle(/Auto-scroll|Scroll to bottom|New messages/)).not.toBeInTheDocument();
		});

		it('shows dimmed button when scrolled up (not pinned)', async () => {
			const logs: LogEntry[] = Array.from({ length: 20 }, (_, i) =>
				createLogEntry({ id: `log-${i}`, text: `Message ${i}`, source: i % 2 === 0 ? 'user' : 'stdout' })
			);

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				autoScrollAiMode: false,
				setAutoScrollAiMode: vi.fn(),
			});

			const { container } = render(<TerminalOutput {...props} />);

			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;

			// Simulate scroll away from bottom
			Object.defineProperty(scrollContainer, 'scrollHeight', { value: 2000, configurable: true });
			Object.defineProperty(scrollContainer, 'scrollTop', { value: 500, configurable: true });
			Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });

			fireEvent.scroll(scrollContainer);

			await act(async () => {
				vi.advanceTimersByTime(50);
			});

			const button = screen.getByTitle('Scroll to bottom (click to pin)');
			expect(button).toBeInTheDocument();
			expect(button).toHaveStyle({ backgroundColor: defaultTheme.colors.bgSidebar });
		});
	});

	describe('click behavior', () => {
		it('clicking when pinned at bottom disables auto-scroll (unpin)', async () => {
			const setAutoScrollAiMode = vi.fn();
			const props = createDefaultProps({
				autoScrollAiMode: true,
				setAutoScrollAiMode,
			});

			render(<TerminalOutput {...props} />);

			const button = screen.getByTitle('Auto-scroll ON (click to unpin)');
			await act(async () => {
				fireEvent.click(button);
			});

			expect(setAutoScrollAiMode).toHaveBeenCalledWith(false);
		});

		it('clicking when scrolled up enables auto-scroll and scrolls to bottom (pin)', async () => {
			const setAutoScrollAiMode = vi.fn();
			const logs: LogEntry[] = Array.from({ length: 20 }, (_, i) =>
				createLogEntry({ id: `log-${i}`, text: `Message ${i}`, source: i % 2 === 0 ? 'user' : 'stdout' })
			);

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				autoScrollAiMode: false,
				setAutoScrollAiMode,
			});

			const { container } = render(<TerminalOutput {...props} />);

			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
			const scrollToSpy = vi.fn();
			scrollContainer.scrollTo = scrollToSpy;

			// Simulate scroll away from bottom
			Object.defineProperty(scrollContainer, 'scrollHeight', { value: 2000, configurable: true });
			Object.defineProperty(scrollContainer, 'scrollTop', { value: 500, configurable: true });
			Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });

			fireEvent.scroll(scrollContainer);

			await act(async () => {
				vi.advanceTimersByTime(50);
			});

			const button = screen.getByTitle('Scroll to bottom (click to pin)');
			await act(async () => {
				fireEvent.click(button);
			});

			// Should enable auto-scroll
			expect(setAutoScrollAiMode).toHaveBeenCalledWith(true);
			// Should scroll to bottom
			expect(scrollToSpy).toHaveBeenCalledWith({
				top: 2000,
				behavior: 'smooth',
			});
		});
	});

	describe('pause and resume on scroll', () => {
		it('auto-scroll dims when user scrolls up (paused)', async () => {
			const setAutoScrollAiMode = vi.fn();
			const logs: LogEntry[] = Array.from({ length: 20 }, (_, i) =>
				createLogEntry({ id: `log-${i}`, text: `Message ${i}`, source: i % 2 === 0 ? 'user' : 'stdout' })
			);

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				autoScrollAiMode: true,
				setAutoScrollAiMode,
			});

			const { container } = render(<TerminalOutput {...props} />);

			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;

			// Simulate scroll away from bottom
			Object.defineProperty(scrollContainer, 'scrollHeight', { value: 2000, configurable: true });
			Object.defineProperty(scrollContainer, 'scrollTop', { value: 500, configurable: true });
			Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });

			fireEvent.scroll(scrollContainer);

			await act(async () => {
				vi.advanceTimersByTime(50);
			});

			// After scrolling up with auto-scroll on, button should show dimmed "pin" state
			const button = screen.getByTitle('Scroll to bottom (click to pin)');
			expect(button).toBeInTheDocument();
			expect(button).toHaveStyle({ backgroundColor: defaultTheme.colors.bgSidebar });
		});

		it('clicking re-pins after scroll-up and scrolls to bottom', async () => {
			const setAutoScrollAiMode = vi.fn();
			const logs: LogEntry[] = Array.from({ length: 20 }, (_, i) =>
				createLogEntry({ id: `log-${i}`, text: `Message ${i}`, source: i % 2 === 0 ? 'user' : 'stdout' })
			);

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs, isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				autoScrollAiMode: true,
				setAutoScrollAiMode,
			});

			const { container } = render(<TerminalOutput {...props} />);

			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
			const scrollToSpy = vi.fn();
			scrollContainer.scrollTo = scrollToSpy;

			// Simulate scroll away from bottom to trigger pause
			Object.defineProperty(scrollContainer, 'scrollHeight', { value: 2000, configurable: true });
			Object.defineProperty(scrollContainer, 'scrollTop', { value: 500, configurable: true });
			Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });

			fireEvent.scroll(scrollContainer);

			await act(async () => {
				vi.advanceTimersByTime(50);
			});

			const button = screen.getByTitle('Scroll to bottom (click to pin)');
			await act(async () => {
				fireEvent.click(button);
			});

			// Should re-enable auto-scroll and scroll to bottom
			expect(setAutoScrollAiMode).toHaveBeenCalledWith(true);
			expect(scrollToSpy).toHaveBeenCalledWith({
				top: 2000,
				behavior: 'smooth',
			});
		});
	});

	describe('props threading', () => {
		it('TerminalOutput accepts and uses autoScrollAiMode and setAutoScrollAiMode props', () => {
			const setAutoScrollAiMode = vi.fn();
			const props = createDefaultProps({
				autoScrollAiMode: true,
				setAutoScrollAiMode,
			});

			const { container } = render(<TerminalOutput {...props} />);
			expect(container).toBeTruthy();
			expect(screen.getByTitle('Auto-scroll ON (click to unpin)')).toBeInTheDocument();
		});

		it('TerminalOutput renders correctly without auto-scroll props (backward compatible)', () => {
			const props = createDefaultProps();

			const { container } = render(<TerminalOutput {...props} />);
			expect(container).toBeTruthy();
			expect(screen.queryByTitle(/Auto-scroll|Scroll to bottom|New messages/)).not.toBeInTheDocument();
		});
	});

	describe('button positioning based on userMessageAlignment', () => {
		it('button is on the left when user messages are right (AI on left)', () => {
			const props = createDefaultProps({
				autoScrollAiMode: true,
				setAutoScrollAiMode: vi.fn(),
				userMessageAlignment: 'right',
			});

			render(<TerminalOutput {...props} />);

			const button = screen.getByTitle('Auto-scroll ON (click to unpin)');
			expect(button.className).toContain('left-6');
			expect(button.className).not.toContain('right-6');
		});

		it('button is on the right when user messages are left (AI on right)', () => {
			const props = createDefaultProps({
				autoScrollAiMode: true,
				setAutoScrollAiMode: vi.fn(),
				userMessageAlignment: 'left',
			});

			render(<TerminalOutput {...props} />);

			const button = screen.getByTitle('Auto-scroll ON (click to unpin)');
			expect(button.className).toContain('right-6');
			expect(button.className).not.toContain('left-6');
		});
	});
});
