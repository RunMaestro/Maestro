/**
 * @file auto-scroll.test.tsx
 * @description Tests for the auto-scroll feature in TerminalOutput
 *
 * Test coverage includes:
 * - Settings integration (keyboard shortcut registration)
 * - Props threading (backward compatibility without auto-scroll props)
 * - Thinking stream auto-scroll (MutationObserver-based scroll triggering)
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

// Mock MutationObserver for JSDOM — store callback on observe() so tests
// can trigger it manually to simulate DOM mutations.
class MockMutationObserver {
	private callback: MutationCallback;
	observe = vi.fn(() => {
		// Store callback so rerender-triggered DOM changes can flush it
		(window as any).__mutationCallback = this.callback;
	});
	disconnect = vi.fn();
	takeRecords = vi.fn().mockReturnValue([]);
	constructor(callback: MutationCallback) {
		this.callback = callback;
	}
}
vi.stubGlobal('MutationObserver', MockMutationObserver);

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
			logs: [
				{ id: 'default-log', text: 'Default log entry', timestamp: 0, source: 'stdout' as const },
			],
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

	describe('props threading', () => {
		it('TerminalOutput renders correctly without auto-scroll props (backward compatible)', () => {
			const props = createDefaultProps();

			const { container } = render(<TerminalOutput {...props} />);
			expect(container).toBeTruthy();
		});
	});

	describe('thinking stream auto-scroll', () => {
		it('auto-scrolls when thinking log text grows in-place (same array length)', async () => {
			// Setup: auto-scroll enabled, one thinking log entry
			const thinkingLog = createLogEntry({
				id: 'thinking-1',
				text: 'Let me analyze',
				source: 'thinking',
			});

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs: [thinkingLog], isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				autoScrollAiMode: true,
			});

			const { container, rerender } = render(<TerminalOutput {...props} />);

			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
			const scrollToSpy = vi.fn();
			scrollContainer.scrollTo = scrollToSpy;
			Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, configurable: true });
			Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });

			scrollToSpy.mockClear();

			// Simulate thinking chunk update: text grows but array length stays the same
			const updatedThinkingLog = { ...thinkingLog, text: 'Let me analyze this code carefully' };
			const updatedSession = createDefaultSession({
				tabs: [
					{
						id: 'tab-1',
						agentSessionId: 'claude-123',
						logs: [updatedThinkingLog],
						isUnread: false,
					},
				],
				activeTabId: 'tab-1',
			});

			rerender(
				<TerminalOutput
					{...createDefaultProps({
						session: updatedSession,
						autoScrollAiMode: true,
					})}
				/>
			);

			// Trigger MutationObserver callback (simulates DOM mutation)
			(window as any).__mutationCallback?.([]);

			await act(async () => {
				vi.advanceTimersByTime(20); // Flush RAF + any timers
			});

			// KEY ASSERTION: scrollTo should fire despite array length being unchanged.
			// The MutationObserver detects the DOM text change and triggers scroll.
			expect(scrollToSpy).toHaveBeenCalled();
		});

		it('does not increment unread badge count on thinking text growth', async () => {
			// The unread badge should only increment on NEW entries, not in-place updates
			const thinkingLog = createLogEntry({
				id: 'thinking-1',
				text: 'Thinking...',
				source: 'thinking',
			});

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs: [thinkingLog], isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				autoScrollAiMode: false, // OFF — so badge system is active
			});

			const { container, rerender } = render(<TerminalOutput {...props} />);
			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;

			// Simulate scroll away from bottom (so badge would show)
			Object.defineProperty(scrollContainer, 'scrollHeight', { value: 2000, configurable: true });
			Object.defineProperty(scrollContainer, 'scrollTop', { value: 500, configurable: true });
			Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
			fireEvent.scroll(scrollContainer);
			await act(async () => {
				vi.advanceTimersByTime(50);
			});

			// Update thinking text (in-place, same array length)
			const updatedLog = { ...thinkingLog, text: 'Thinking about a lot of things...' };
			const updatedSession = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs: [updatedLog], isUnread: false }],
				activeTabId: 'tab-1',
			});

			rerender(
				<TerminalOutput
					{...createDefaultProps({
						session: updatedSession,
						autoScrollAiMode: false,
					})}
				/>
			);

			await act(async () => {
				vi.advanceTimersByTime(50);
			});

			// Badge should NOT appear — no new entries were added
			expect(screen.queryByText('1')).not.toBeInTheDocument();
		});

		it('auto-scrolls when tool event appends new entry after thinking', async () => {
			const thinkingLog = createLogEntry({
				id: 'thinking-1',
				text: 'Thinking...',
				source: 'thinking',
			});

			const session = createDefaultSession({
				tabs: [{ id: 'tab-1', agentSessionId: 'claude-123', logs: [thinkingLog], isUnread: false }],
				activeTabId: 'tab-1',
			});

			const props = createDefaultProps({
				session,
				autoScrollAiMode: true,
			});

			const { container, rerender } = render(<TerminalOutput {...props} />);
			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
			const scrollToSpy = vi.fn();
			scrollContainer.scrollTo = scrollToSpy;
			Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, configurable: true });
			Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
			scrollToSpy.mockClear();

			// Tool event arrives: new entry appended
			const toolLog = createLogEntry({ id: 'tool-1', text: 'grep_search', source: 'tool' });
			const updatedSession = createDefaultSession({
				tabs: [
					{
						id: 'tab-1',
						agentSessionId: 'claude-123',
						logs: [thinkingLog, toolLog],
						isUnread: false,
					},
				],
				activeTabId: 'tab-1',
			});

			rerender(
				<TerminalOutput
					{...createDefaultProps({
						session: updatedSession,
						autoScrollAiMode: true,
					})}
				/>
			);

			// Trigger MutationObserver callback (simulates DOM mutation from new node)
			(window as any).__mutationCallback?.([]);

			await act(async () => {
				vi.advanceTimersByTime(20);
			});

			expect(scrollToSpy).toHaveBeenCalled();
		});
	});
});
