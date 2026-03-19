/**
 * @file TerminalView.test.tsx
 * @description Tests for TerminalView component
 *
 * Focused on the isVisible prop behaviour: the terminal must call refresh() + focus()
 * on the active XTerminal instance whenever isVisible transitions to true (e.g. when
 * the user returns from AI mode back to terminal mode). Without this explicit repaint
 * the WebGL/canvas framebuffer can be stale after display:none → display:flex.
 */

import React from 'react';
import { render, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TerminalView } from '../../../renderer/components/TerminalView';
import type { Session, TerminalTab } from '../../../renderer/types';
import type { Theme } from '../../../renderer/types';

// ---------------------------------------------------------------------------
// Mock XTerminal — the real component requires canvas/WebGL which jsdom lacks.
// We expose a forwardRef'd stub so TerminalView can attach its imperative ref.
// ---------------------------------------------------------------------------

const mockRefresh = vi.fn();
const mockFocus = vi.fn();
const mockWrite = vi.fn();

vi.mock('../../../renderer/components/XTerminal', () => {
	const React = require('react');
	const XTerminal = React.forwardRef(
		(
			_props: Record<string, unknown>,
			ref: React.Ref<{
				refresh(): void;
				focus(): void;
				write(data: string): void;
				clear(): void;
				scrollToBottom(): void;
				search(): boolean;
				searchNext(): boolean;
				searchPrevious(): boolean;
				getSelection(): string;
				resize(): void;
			}>
		) => {
			React.useImperativeHandle(ref, () => ({
				refresh: mockRefresh,
				focus: mockFocus,
				write: mockWrite,
				clear: vi.fn(),
				scrollToBottom: vi.fn(),
				search: vi.fn().mockReturnValue(false),
				searchNext: vi.fn().mockReturnValue(false),
				searchPrevious: vi.fn().mockReturnValue(false),
				getSelection: vi.fn().mockReturnValue(''),
				resize: vi.fn(),
			}));
			return React.createElement('div', { 'data-testid': 'xterm-mock' });
		}
	);
	XTerminal.displayName = 'XTerminal';
	return { XTerminal };
});

// Mock TerminalSearchBar (not under test here)
vi.mock('../../../renderer/components/TerminalSearchBar', () => ({
	TerminalSearchBar: () => null,
}));

// Mock tabStore — TerminalView uses closeTerminalTab to auto-close exited tabs
const { mockCloseTerminalTab } = vi.hoisted(() => ({
	mockCloseTerminalTab: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock('../../../renderer/stores/tabStore', () => ({
	useTabStore: (sel?: (s: any) => any) => {
		const state = { closeTerminalTab: mockCloseTerminalTab };
		return sel ? sel(state) : state;
	},
}));

// Mock notifyToast — TerminalView shows error toasts on spawn failure
const { mockNotifyToast } = vi.hoisted(() => ({
	mockNotifyToast: vi.fn().mockReturnValue('toast-id'),
}));

vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: (...args: unknown[]) => mockNotifyToast(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseTheme: Theme = {
	id: 'dark',
	name: 'Dark',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		accentDim: '#004a7f',
		accentForeground: '#ffffff',
		border: '#3c3c3c',
		error: '#f44747',
		warning: '#ff8c00',
		selection: '#264f78',
	},
} as unknown as Theme;

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
	return {
		id: 'tab-1',
		name: null,
		shellType: 'zsh',
		pid: 1234,
		cwd: '/tmp',
		createdAt: Date.now(),
		state: 'idle',
		exitCode: undefined,
		...overrides,
	};
}

function makeSession(tabs: TerminalTab[], activeTabId = tabs[0]?.id): Session {
	return {
		id: 'session-1',
		name: 'Test Session',
		toolType: 'terminal',
		inputMode: 'terminal',
		terminalTabs: tabs,
		activeTerminalTabId: activeTabId,
		cwd: '/tmp',
		fullPath: '/tmp',
		projectRoot: '/tmp',
		aiTabs: [],
		activeTabId: '',
	} as unknown as Session;
}

const defaultProps = {
	theme: baseTheme,
	fontFamily: 'monospace',
	fontSize: 14,
	defaultShell: '/bin/zsh',
	onTabStateChange: vi.fn(),
	onTabPidChange: vi.fn(),
};

// Extend the global window.maestro process mock with terminal-specific methods
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const maestro = () => (window as any).maestro;

beforeEach(() => {
	vi.clearAllMocks();
	// spawnTerminalTab and onData are not in the global setup mock — add them here
	maestro().process.spawnTerminalTab = vi.fn().mockResolvedValue({ success: true, pid: 9999 });
	maestro().process.onData = vi.fn().mockReturnValue(() => {});
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TerminalView — isVisible repaint behaviour', () => {
	it('calls refresh() and focus() when isVisible becomes true', async () => {
		const tab = makeTab({ pid: 1234, state: 'idle' });
		const session = makeSession([tab]);

		const { rerender } = render(
			<TerminalView {...defaultProps} session={session} isVisible={false} />
		);

		// Not visible yet — no repaint calls expected from the isVisible effect
		expect(mockRefresh).not.toHaveBeenCalled();
		expect(mockFocus).not.toHaveBeenCalled();

		// Transition: hidden → visible (simulates returning from AI mode)
		await act(async () => {
			rerender(<TerminalView {...defaultProps} session={session} isVisible={true} />);
			// Advance past the 50ms setTimeout inside the effect
			await new Promise((resolve) => setTimeout(resolve, 100));
		});

		expect(mockRefresh).toHaveBeenCalledTimes(1);
		expect(mockFocus).toHaveBeenCalledTimes(1);
	});

	it('does NOT call refresh() when isVisible stays false', async () => {
		const tab = makeTab({ pid: 1234, state: 'idle' });
		const session = makeSession([tab]);

		const { rerender } = render(
			<TerminalView {...defaultProps} session={session} isVisible={false} />
		);

		// Let mount effects settle (activeTab?.id effect fires once on mount regardless of isVisible)
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 100));
		});

		// Reset the mock AFTER mount so we only measure calls from the re-render
		mockRefresh.mockClear();

		// Re-render with same isVisible=false — the isVisible effect must NOT fire
		await act(async () => {
			rerender(<TerminalView {...defaultProps} session={session} isVisible={false} />);
			await new Promise((resolve) => setTimeout(resolve, 100));
		});

		expect(mockRefresh).not.toHaveBeenCalled();
	});

	it('does NOT call refresh() when isVisible transitions from true to false', async () => {
		const tab = makeTab({ pid: 1234, state: 'idle' });
		const session = makeSession([tab]);

		const { rerender } = render(
			<TerminalView {...defaultProps} session={session} isVisible={true} />
		);

		// Allow initial mount effects to settle
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 100));
		});

		const callsAfterMount = mockRefresh.mock.calls.length;

		// Now hide the terminal
		await act(async () => {
			rerender(<TerminalView {...defaultProps} session={session} isVisible={false} />);
			await new Promise((resolve) => setTimeout(resolve, 100));
		});

		// refresh() count must not increase when hiding
		expect(mockRefresh).toHaveBeenCalledTimes(callsAfterMount);
	});

	it('calls refresh() again on each subsequent show (multiple round-trips)', async () => {
		const tab = makeTab({ pid: 1234, state: 'idle' });
		const session = makeSession([tab]);

		const { rerender } = render(
			<TerminalView {...defaultProps} session={session} isVisible={false} />
		);

		// First show
		await act(async () => {
			rerender(<TerminalView {...defaultProps} session={session} isVisible={true} />);
			await new Promise((resolve) => setTimeout(resolve, 100));
		});

		const callsAfterFirstShow = mockRefresh.mock.calls.length;
		expect(callsAfterFirstShow).toBeGreaterThanOrEqual(1);

		// Hide
		await act(async () => {
			rerender(<TerminalView {...defaultProps} session={session} isVisible={false} />);
			await new Promise((resolve) => setTimeout(resolve, 100));
		});

		// Second show
		await act(async () => {
			rerender(<TerminalView {...defaultProps} session={session} isVisible={true} />);
			await new Promise((resolve) => setTimeout(resolve, 100));
		});

		// At least one more refresh() call compared to after first show
		expect(mockRefresh.mock.calls.length).toBeGreaterThan(callsAfterFirstShow);
	});
});

describe('TerminalView — auto-close on shell exit', () => {
	it('calls closeTerminalTab when a tab transitions to exited state after 2s', async () => {
		vi.useFakeTimers();
		// Tab created >2s ago — normal exit should auto-close
		const tab = makeTab({ pid: 1234, state: 'busy', createdAt: Date.now() - 5000 });
		const session = makeSession([tab]);

		const { rerender } = render(
			<TerminalView {...defaultProps} session={session} isVisible={true} />
		);

		// Transition tab state to 'exited'
		const exitedTab = makeTab({
			pid: 1234,
			state: 'exited',
			exitCode: 0,
			createdAt: Date.now() - 5000,
		});
		const exitedSession = makeSession([exitedTab]);

		act(() => {
			rerender(<TerminalView {...defaultProps} session={exitedSession} isVisible={true} />);
		});

		// Advance past the setTimeout(0) auto-close
		act(() => {
			vi.advanceTimersByTime(1);
		});

		expect(mockCloseTerminalTab).toHaveBeenCalledWith('tab-1');
		vi.useRealTimers();
	});

	it('auto-closes and shows error toast when shell exits within 2s of creation (startup failure)', async () => {
		vi.useFakeTimers();
		// Tab just created — exit within 2s is a startup failure
		const tab = makeTab({ pid: 1234, state: 'busy', createdAt: Date.now() });
		const session = makeSession([tab]);

		const { rerender } = render(
			<TerminalView {...defaultProps} session={session} isVisible={true} />
		);

		// Shell exits immediately
		const exitedTab = makeTab({ pid: 1234, state: 'exited', exitCode: 1, createdAt: Date.now() });
		const exitedSession = makeSession([exitedTab]);

		act(() => {
			rerender(<TerminalView {...defaultProps} session={exitedSession} isVisible={true} />);
		});

		act(() => {
			vi.advanceTimersByTime(1);
		});

		// Tab should be closed
		expect(mockCloseTerminalTab).toHaveBeenCalledWith('tab-1');

		// Toast is debounced (200ms) — advance past the dedup window
		act(() => {
			vi.advanceTimersByTime(250);
		});

		expect(mockNotifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'error',
				title: 'Failed to start terminal',
			})
		);
		vi.useRealTimers();
	});

	it('batches multiple spawn failures into a single toast', async () => {
		vi.useFakeTimers();
		// Two tabs that both exit immediately (startup failure)
		const tab1 = makeTab({ id: 'tab-1', pid: 1234, state: 'busy', createdAt: Date.now() });
		const tab2 = makeTab({ id: 'tab-2', pid: 5678, state: 'busy', createdAt: Date.now() });
		const session = makeSession([tab1, tab2], 'tab-1');

		const { rerender } = render(
			<TerminalView {...defaultProps} session={session} isVisible={true} />
		);

		// Both tabs exit immediately
		const exitedTab1 = makeTab({
			id: 'tab-1',
			pid: 1234,
			state: 'exited',
			exitCode: 1,
			createdAt: Date.now(),
		});
		const exitedTab2 = makeTab({
			id: 'tab-2',
			pid: 5678,
			state: 'exited',
			exitCode: 1,
			createdAt: Date.now(),
		});
		const exitedSession = makeSession([exitedTab1, exitedTab2], 'tab-1');

		act(() => {
			rerender(<TerminalView {...defaultProps} session={exitedSession} isVisible={true} />);
		});

		act(() => {
			vi.advanceTimersByTime(1);
		});

		// Both tabs should be closed
		expect(mockCloseTerminalTab).toHaveBeenCalledWith('tab-1');
		expect(mockCloseTerminalTab).toHaveBeenCalledWith('tab-2');

		// Before dedup timer fires, no toast yet
		expect(mockNotifyToast).not.toHaveBeenCalled();

		// Advance past 200ms dedup window
		act(() => {
			vi.advanceTimersByTime(250);
		});

		// Should show a single batched toast
		expect(mockNotifyToast).toHaveBeenCalledTimes(1);
		expect(mockNotifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'error',
				title: 'Failed to start 2 terminals',
			})
		);
		vi.useRealTimers();
	});
});

describe('TerminalView — no refresh when no tabs', () => {
	it('renders empty state without calling refresh when there are no terminal tabs', () => {
		const session = makeSession([]);
		render(<TerminalView {...defaultProps} session={session} isVisible={true} />);
		// With no tabs there are no XTerminal instances to refresh
		expect(mockRefresh).not.toHaveBeenCalled();
	});
});
