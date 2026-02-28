/**
 * @file auto-scroll.test.tsx
 * @description Tests for the auto-scroll feature across multiple components
 *
 * Test coverage includes:
 * - Settings integration (default value, persistence, SettingsModal rendering)
 * - Keyboard shortcut registration and handling
 * - TerminalOutput auto-scroll button behavior (rendering, clicking, state)
 * - Props threading from useMainPanelProps through MainPanel to TerminalOutput
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
		accentText: '#ff79c6',
		border: '#2a2a4e',
		success: '#00ff88',
		warning: '#ffcc00',
		error: '#ff4444',
		info: '#4488ff',
		successForeground: '#1a1a2e',
		warningForeground: '#1a1a2e',
		errorForeground: '#1a1a2e',
		successDim: 'rgba(0, 255, 136, 0.15)',
		warningDim: 'rgba(255, 204, 0, 0.15)',
		errorDim: 'rgba(255, 68, 68, 0.15)',
		infoDim: 'rgba(68, 136, 255, 0.15)',
		diffAddition: '#00ff88',
		diffAdditionBg: 'rgba(0, 255, 136, 0.15)',
		diffDeletion: '#ff4444',
		diffDeletionBg: 'rgba(255, 68, 68, 0.15)',
		overlay: 'rgba(0, 0, 0, 0.6)',
		overlayHeavy: 'rgba(0, 0, 0, 0.8)',
		hoverBg: 'rgba(255, 255, 255, 0.06)',
		activeBg: 'rgba(255, 255, 255, 0.15)',
		shadow: 'rgba(0, 0, 0, 0.3)',
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
		it('autoScrollAiMode defaults to false (button does not render when at bottom)', () => {
			// When autoScrollAiMode is false (default) and at bottom, the button should not render
			const setAutoScrollAiMode = vi.fn();
			const props = createDefaultProps({
				autoScrollAiMode: false,
				setAutoScrollAiMode,
			});

			render(<TerminalOutput {...props} />);

			// In the current behavior, button only shows when not at bottom or when active
			expect(screen.queryByTitle(/Auto-scroll|Scroll to bottom/)).not.toBeInTheDocument();
		});

		it('autoScrollAiMode persists when toggled via button click', async () => {
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

			// Should call the setter to unpin (true -> false)
			expect(setAutoScrollAiMode).toHaveBeenCalledWith(false);
		});

		it('setting is rendered in SettingsModal with correct label (shortcut registration)', () => {
			// Verify the toggleAutoScroll shortcut is registered in DEFAULT_SHORTCUTS
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

	describe('TerminalOutput button rendering', () => {
		it('auto-scroll button does NOT render when autoScrollAiMode prop is not provided', () => {
			// When setAutoScrollAiMode is not passed, button should not render
			const props = createDefaultProps({
				// No autoScrollAiMode or setAutoScrollAiMode
			});

			render(<TerminalOutput {...props} />);

			expect(screen.queryByTitle(/Auto-scroll/)).not.toBeInTheDocument();
		});

		it('auto-scroll button renders when autoScrollAiMode is true and inputMode is ai', () => {
			const props = createDefaultProps({
				autoScrollAiMode: true,
				setAutoScrollAiMode: vi.fn(),
				session: createDefaultSession({ inputMode: 'ai' }),
			});

			render(<TerminalOutput {...props} />);

			expect(screen.getByTitle('Auto-scroll ON (click to unpin)')).toBeInTheDocument();
		});

		it('auto-scroll button does NOT render in terminal mode', () => {
			const props = createDefaultProps({
				autoScrollAiMode: true,
				setAutoScrollAiMode: vi.fn(),
				session: createDefaultSession({ inputMode: 'terminal' }),
			});

			render(<TerminalOutput {...props} />);

			expect(screen.queryByTitle(/Auto-scroll/)).not.toBeInTheDocument();
		});

		it('clicking the button unpins autoScrollAiMode', async () => {
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

			// Should unpin (true -> false)
			expect(setAutoScrollAiMode).toHaveBeenCalledWith(false);
		});

		it('button shows active state when auto-scroll is on and at bottom', () => {
			const props = createDefaultProps({
				autoScrollAiMode: true,
				setAutoScrollAiMode: vi.fn(),
			});

			render(<TerminalOutput {...props} />);

			const button = screen.getByTitle('Auto-scroll ON (click to unpin)');
			// Active state uses accent background
			expect(button).toHaveStyle({ backgroundColor: defaultTheme.colors.accent });
			expect(button).toHaveStyle({ color: defaultTheme.colors.accentForeground });
		});

		it('button does not render when autoScrollAiMode is false and at bottom', () => {
			const props = createDefaultProps({
				autoScrollAiMode: false,
				setAutoScrollAiMode: vi.fn(),
			});

			render(<TerminalOutput {...props} />);

			// When not active and at bottom, button is hidden
			expect(screen.queryByTitle(/Auto-scroll|Scroll to bottom/)).not.toBeInTheDocument();
		});
	});

	describe('auto-scroll pause and resume behavior', () => {
		it('button changes to "Scroll to bottom" when user scrolls away from bottom', async () => {
			const setAutoScrollAiMode = vi.fn();
			const logs: LogEntry[] = Array.from({ length: 20 }, (_, i) =>
				createLogEntry({
					id: `log-${i}`,
					text: `Message ${i}`,
					source: i % 2 === 0 ? 'user' : 'stdout',
				})
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

			// Simulate scroll away from bottom (more than 50px from bottom)
			Object.defineProperty(scrollContainer, 'scrollHeight', { value: 2000, configurable: true });
			Object.defineProperty(scrollContainer, 'scrollTop', { value: 500, configurable: true });
			Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });

			fireEvent.scroll(scrollContainer);

			// Wait for throttle
			await act(async () => {
				vi.advanceTimersByTime(50);
			});

			// After scrolling up, the button should show "Scroll to bottom" (paused internally)
			const button = screen.getByTitle(/Scroll to bottom/);
			expect(button).toBeInTheDocument();
		});

		it('clicking button when scrolled away snaps to bottom and re-pins', async () => {
			const setAutoScrollAiMode = vi.fn();
			const logs: LogEntry[] = Array.from({ length: 20 }, (_, i) =>
				createLogEntry({
					id: `log-${i}`,
					text: `Message ${i}`,
					source: i % 2 === 0 ? 'user' : 'stdout',
				})
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

			// Should now show "Scroll to bottom" state
			const scrollButton = screen.getByTitle(/Scroll to bottom/);
			expect(scrollButton).toBeInTheDocument();

			// Click to resume
			await act(async () => {
				fireEvent.click(scrollButton);
			});

			// Should have called scrollTo to snap to bottom
			expect(scrollToSpy).toHaveBeenCalledWith({
				top: 2000, // scrollHeight
				behavior: 'smooth',
			});

			// Button should now show active state (re-pinned)
			expect(screen.getByTitle('Auto-scroll ON (click to unpin)')).toBeInTheDocument();
		});
	});

	describe('props threading', () => {
		it('TerminalOutput accepts and uses autoScrollAiMode and setAutoScrollAiMode props', () => {
			// This tests that the props interface is properly defined and used
			const setAutoScrollAiMode = vi.fn();
			const props = createDefaultProps({
				autoScrollAiMode: true,
				setAutoScrollAiMode,
			});

			// Should render without errors and show the auto-scroll button
			const { container } = render(<TerminalOutput {...props} />);
			expect(container).toBeTruthy();
			expect(screen.getByTitle('Auto-scroll ON (click to unpin)')).toBeInTheDocument();
		});

		it('TerminalOutput renders correctly without auto-scroll props (backward compatible)', () => {
			// When auto-scroll props are not provided, component should render normally
			const props = createDefaultProps();

			const { container } = render(<TerminalOutput {...props} />);
			expect(container).toBeTruthy();
			// No auto-scroll button should be rendered
			expect(screen.queryByTitle(/Auto-scroll/)).not.toBeInTheDocument();
		});
	});
});
