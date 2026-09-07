/**
 * Tests for renderer/services/toastClickActions.ts
 *
 * Covers what a toast click actually does for each kind, including the misses:
 * a click on a notification whose target tab has since been closed must still
 * take the user somewhere and say what happened, never no-op.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatchToastClickAction } from '../../../renderer/services/toastClickActions';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useNotificationStore } from '../../../renderer/stores/notificationStore';
import { useFileExplorerStore } from '../../../renderer/stores/fileExplorerStore';
import { createMockSession } from '../../helpers/mockSession';
import type { BrowserTab, Session, TerminalTab } from '../../../renderer/types';

function terminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
	return {
		id: 'term-1',
		name: null,
		shellType: 'zsh',
		pid: 0,
		cwd: '/test/project',
		createdAt: 0,
		state: 'idle',
		...overrides,
	} as TerminalTab;
}

function browserTab(overrides: Partial<BrowserTab> = {}): BrowserTab {
	return {
		id: 'browser-1',
		url: 'https://example.com',
		title: 'Example',
		createdAt: 0,
		partition: 'persist:test',
		canGoBack: false,
		canGoForward: false,
		isLoading: false,
		favicon: null,
		...overrides,
	} as BrowserTab;
}

function seedSessions(sessions: Session[]): void {
	useSessionStore.setState({ sessions, activeSessionId: '' });
}

function currentSession(id: string): Session | undefined {
	return useSessionStore.getState().sessions.find((s) => s.id === id);
}

describe('dispatchToastClickAction', () => {
	let dispatchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		seedSessions([]);
		useNotificationStore.setState({ toasts: [] });
		dispatchSpy = vi.spyOn(window, 'dispatchEvent');
	});

	afterEach(() => {
		dispatchSpy.mockRestore();
		vi.clearAllMocks();
	});

	function dispatchedEvent(type: string): CustomEvent | undefined {
		const match = dispatchSpy.mock.calls.find(
			([e]: [Event]) => e instanceof CustomEvent && e.type === type
		);
		return match?.[0] as CustomEvent | undefined;
	}

	it('jump-session delegates to the App-provided handler', () => {
		const onSessionClick = vi.fn();
		dispatchToastClickAction(
			{ kind: 'jump-session', sessionId: 's1', tabId: 't1' },
			{ onSessionClick }
		);
		expect(onSessionClick).toHaveBeenCalledWith('s1', 't1');
	});

	it('open-file dispatches the shared file-open event', () => {
		dispatchToastClickAction({ kind: 'open-file', sessionId: 's1', path: '/tmp/a.ts' });
		expect(dispatchedEvent('maestro:openFileTab')?.detail).toEqual({
			sessionId: 's1',
			filePath: '/tmp/a.ts',
		});
	});

	describe('open-terminal', () => {
		it('focuses a terminal tab by id and switches to terminal mode', () => {
			seedSessions([
				createMockSession({
					id: 's1',
					terminalTabs: [terminalTab({ id: 'term-1' }), terminalTab({ id: 'term-2' })],
					activeFileTabId: 'file-9',
					activeBrowserTabId: 'browser-9',
				}),
			]);

			dispatchToastClickAction({ kind: 'open-terminal', sessionId: 's1', tabRef: 'term-2' });

			expect(useSessionStore.getState().activeSessionId).toBe('s1');
			const session = currentSession('s1')!;
			expect(session.activeTerminalTabId).toBe('term-2');
			expect(session.inputMode).toBe('terminal');
			// The file and browser selections outrank a terminal tab, so both have
			// to be cleared or the old view stays on screen.
			expect(session.activeFileTabId).toBeNull();
			expect(session.activeBrowserTabId).toBeNull();
		});

		it('resolves a terminal tab by name', () => {
			seedSessions([
				createMockSession({
					id: 's1',
					terminalTabs: [terminalTab({ id: 'term-1', name: 'Dev server' })],
				}),
			]);

			dispatchToastClickAction({ kind: 'open-terminal', sessionId: 's1', tabRef: 'Dev server' });

			expect(currentSession('s1')!.activeTerminalTabId).toBe('term-1');
		});

		it('falls back to the agent and warns when the tab is gone', () => {
			seedSessions([createMockSession({ id: 's1', terminalTabs: [] })]);

			dispatchToastClickAction({ kind: 'open-terminal', sessionId: 's1', tabRef: 'Dev server' });

			expect(useSessionStore.getState().activeSessionId).toBe('s1');
			expect(currentSession('s1')!.activeTerminalTabId).toBeNull();
			const toasts = useNotificationStore.getState().toasts;
			expect(toasts).toHaveLength(1);
			expect(toasts[0].title).toBe('Terminal tab not found');
		});

		it('warns when the agent itself is gone', () => {
			seedSessions([]);
			dispatchToastClickAction({ kind: 'open-terminal', sessionId: 'missing' });
			expect(useNotificationStore.getState().toasts[0].title).toBe('Agent not found');
		});
	});

	describe('open-browser', () => {
		it('focuses an existing browser tab', () => {
			seedSessions([
				createMockSession({
					id: 's1',
					browserTabs: [browserTab({ id: 'browser-1' })],
					inputMode: 'terminal',
					activeTerminalTabId: 'term-9',
					activeFileTabId: 'file-9',
				}),
			]);

			dispatchToastClickAction({ kind: 'open-browser', sessionId: 's1', tabId: 'browser-1' });

			expect(useSessionStore.getState().activeSessionId).toBe('s1');
			const session = currentSession('s1')!;
			expect(session.activeBrowserTabId).toBe('browser-1');
			expect(session.inputMode).toBe('ai');
			expect(session.activeTerminalTabId).toBeNull();
			expect(session.activeFileTabId).toBeNull();
		});

		it('opens a new browser tab when only a url is given', () => {
			seedSessions([createMockSession({ id: 's1' })]);

			dispatchToastClickAction({
				kind: 'open-browser',
				sessionId: 's1',
				url: 'https://example.com/build',
			});

			expect(dispatchedEvent('maestro:openBrowserTab')?.detail).toEqual({
				sessionId: 's1',
				url: 'https://example.com/build',
			});
		});

		it('opens the url when the named tab has been closed', () => {
			seedSessions([createMockSession({ id: 's1', browserTabs: [] })]);

			dispatchToastClickAction({
				kind: 'open-browser',
				sessionId: 's1',
				tabId: 'gone',
				url: 'https://example.com/build',
			});

			expect(dispatchedEvent('maestro:openBrowserTab')?.detail).toEqual({
				sessionId: 's1',
				url: 'https://example.com/build',
			});
		});

		it('falls back to the agent and warns when the tab is gone and no url was given', () => {
			seedSessions([createMockSession({ id: 's1', browserTabs: [] })]);

			dispatchToastClickAction({ kind: 'open-browser', sessionId: 's1', tabId: 'gone' });

			expect(useSessionStore.getState().activeSessionId).toBe('s1');
			expect(useNotificationStore.getState().toasts[0].title).toBe('Browser tab not found');
		});
	});

	it('open-url hands off to the system browser', () => {
		dispatchToastClickAction({ kind: 'open-url', url: 'https://example.com/logs' });
		expect(globalThis.window.maestro.shell.openExternal).toHaveBeenCalledWith(
			'https://example.com/logs'
		);
	});

	it('closes the Document Graph overlay before landing on a tab', () => {
		useFileExplorerStore.setState({ isGraphViewOpen: true });
		seedSessions([createMockSession({ id: 's1', terminalTabs: [terminalTab({ id: 'term-1' })] })]);

		dispatchToastClickAction({ kind: 'open-terminal', sessionId: 's1', tabRef: 'term-1' });

		expect(useFileExplorerStore.getState().isGraphViewOpen).toBe(false);
	});
});
