/**
 * Tests for renderer/services/toastClickActions.ts
 *
 * Covers what a toast click actually does for each kind, including the misses:
 * a click on a notification whose target tab has since been closed must still
 * take the user somewhere and say what happened, never no-op.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatchToastClickAction } from '../../../renderer/services/toastClickActions';
import { useModalStore } from '../../../renderer/stores/modalStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useNotificationStore } from '../../../renderer/stores/notificationStore';
import { useFileExplorerStore } from '../../../renderer/stores/fileExplorerStore';
import { createMockLaunchRecord } from '../../helpers/mockLaunchRecord';
import { createMockSession } from '../../helpers/mockSession';
import type { Session, TerminalTab } from '../../../renderer/types';
import type { BrowserTab } from '../../../shared/browserPage';

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
		seedSessions([createMockSession({ id: 's1' })]);
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

			expect(
				dispatchToastClickAction({ kind: 'open-terminal', sessionId: 's1', tabRef: 'Dev server' })
			).toBe(false);

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

			expect(
				dispatchToastClickAction({ kind: 'open-browser', sessionId: 's1', tabId: 'gone' })
			).toBe(false);

			expect(useSessionStore.getState().activeSessionId).toBe('s1');
			expect(useNotificationStore.getState().toasts[0].title).toBe('Browser tab not found');
		});
	});

	describe('open-playbook-outro', () => {
		const getLaunch = vi.mocked(window.maestro.marketplace.getLaunch);
		const click = { kind: 'open-playbook-outro', sessionId: 's1', launchId: 'launch-1' } as const;

		beforeEach(() => {
			getLaunch.mockReset();
			useModalStore.setState({ modals: new Map() });
		});

		it('goes to the agent that ran the playbook and opens the outro read from main', async () => {
			seedSessions([createMockSession({ id: 's1' }), createMockSession({ id: 's2' })]);
			useSessionStore.setState({ activeSessionId: 's2' });
			const launch = createMockLaunchRecord({ sessionId: 's1', status: 'completed' });
			getLaunch.mockResolvedValue({ success: true, launch });

			expect(dispatchToastClickAction(click)).toBe(true);

			expect(useSessionStore.getState().activeSessionId).toBe('s1');
			expect(getLaunch).toHaveBeenCalledWith('launch-1');
			await vi.waitFor(() => expect(useModalStore.getState().isOpen('playbookOutro')).toBe(true));
			expect(useModalStore.getState().getData('playbookOutro')).toEqual({ launch });
			expect(useNotificationStore.getState().toasts).toHaveLength(0);
		});

		it('closes the Document Graph overlay on the way to the agent', async () => {
			useFileExplorerStore.setState({ isGraphViewOpen: true });
			seedSessions([createMockSession({ id: 's1' })]);
			getLaunch.mockResolvedValue({ success: true, launch: createMockLaunchRecord() });

			dispatchToastClickAction(click);

			expect(useFileExplorerStore.getState().isGraphViewOpen).toBe(false);
			await vi.waitFor(() => expect(useModalStore.getState().isOpen('playbookOutro')).toBe(true));
		});

		it('opens the outro without moving anyone when the agent is gone', async () => {
			seedSessions([createMockSession({ id: 's2' })]);
			useSessionStore.setState({ activeSessionId: 's2' });
			getLaunch.mockResolvedValue({ success: true, launch: createMockLaunchRecord() });

			expect(dispatchToastClickAction(click)).toBe(true);

			expect(useSessionStore.getState().activeSessionId).toBe('s2');
			await vi.waitFor(() => expect(useModalStore.getState().isOpen('playbookOutro')).toBe(true));
			expect(useNotificationStore.getState().toasts).toHaveLength(0);
		});

		it('says so, and opens nothing, when main has no such launch', async () => {
			seedSessions([createMockSession({ id: 's1' })]);
			getLaunch.mockResolvedValue({ success: false, error: 'Error: Launch not found: launch-1' });

			dispatchToastClickAction(click);

			await vi.waitFor(() => expect(useNotificationStore.getState().toasts).toHaveLength(1));
			const [toast] = useNotificationStore.getState().toasts;
			expect(toast.title).toBe('Playbook outro not available');
			expect(toast.message).toBe(
				'Maestro could not read the launch record: Launch not found: launch-1'
			);
			expect(useModalStore.getState().isOpen('playbookOutro')).toBe(false);
			// The agent is still where the person was sent: the click went somewhere.
			expect(useSessionStore.getState().activeSessionId).toBe('s1');
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
