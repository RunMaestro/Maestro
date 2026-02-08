import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, TerminalTab, Theme } from '../../../renderer/types';

type MockXTerminalHandle = {
	focus: ReturnType<typeof vi.fn>;
	clear: ReturnType<typeof vi.fn>;
	search: ReturnType<typeof vi.fn>;
	searchNext: ReturnType<typeof vi.fn>;
	searchPrevious: ReturnType<typeof vi.fn>;
};

const mockXTerminalHandlesBySessionId = vi.hoisted(() => new Map<string, MockXTerminalHandle>());
const mockTerminalTabBarProps = vi.hoisted(() => ({
	current: null as {
		tabs: TerminalTab[];
		onTabClose: (tabId: string) => void;
	} | null,
}));
const mockTerminalSearchBarProps = vi.hoisted(() => ({
	current: null as {
		isOpen: boolean;
		onClose: () => void;
		onSearch: (query: string) => boolean;
		onSearchNext: () => boolean;
		onSearchPrevious: () => boolean;
	} | null,
}));

vi.mock('../../../renderer/components/XTerminal', async () => {
	const ReactModule = await import('react');

	return {
		XTerminal: ReactModule.forwardRef(function MockXTerminal(
			props: { sessionId: string },
			ref: React.ForwardedRef<{
				focus: () => void;
				clear: () => void;
				search: (query: string) => boolean;
				searchNext: () => boolean;
				searchPrevious: () => boolean;
			}>
		) {
			const focus = vi.fn();
			const clear = vi.fn();
			const search = vi.fn(() => true);
			const searchNext = vi.fn(() => true);
			const searchPrevious = vi.fn(() => false);

			mockXTerminalHandlesBySessionId.set(props.sessionId, {
				focus,
				clear,
				search,
				searchNext,
				searchPrevious,
			});

			ReactModule.useImperativeHandle(
				ref,
				() => ({
					focus,
					clear,
					search,
					searchNext,
					searchPrevious,
				}),
				[focus, clear, search, searchNext, searchPrevious]
			);

			return ReactModule.createElement('div', {
				'data-testid': `xterminal-${props.sessionId}`,
			});
		}),
	};
});

vi.mock('../../../renderer/components/TerminalTabBar', () => ({
	TerminalTabBar: (props: { tabs: TerminalTab[]; onTabClose: (tabId: string) => void }) => {
		mockTerminalTabBarProps.current = props;

		return React.createElement(
			'div',
			{ 'data-testid': 'terminal-tab-bar' },
			React.createElement(
				'button',
				{
					type: 'button',
					'data-testid': 'close-first-tab',
					onClick: () => {
						if (props.tabs[0]) {
							void props.onTabClose(props.tabs[0].id);
						}
					},
				},
				'Close first tab'
			)
		);
	},
}));

vi.mock('../../../renderer/components/TerminalSearchBar', () => ({
	TerminalSearchBar: (props: {
		isOpen: boolean;
		onClose: () => void;
		onSearch: (query: string) => boolean;
		onSearchNext: () => boolean;
		onSearchPrevious: () => boolean;
	}) => {
		mockTerminalSearchBarProps.current = props;
		return React.createElement('div', { 'data-testid': 'terminal-search-bar' });
	},
}));

import { TerminalView, type TerminalViewHandle } from '../../../renderer/components/TerminalView';

const theme: Theme = {
	id: 'nord',
	name: 'Nord',
	mode: 'dark',
	colors: {
		bgMain: '#2e3440',
		bgSidebar: '#3b4252',
		bgActivity: '#434c5e',
		border: '#4c566a',
		textMain: '#eceff4',
		textDim: '#d8dee9',
		accent: '#88c0d0',
		accentDim: '#81a1c1',
		accentText: '#8fbcbb',
		accentForeground: '#2e3440',
		success: '#a3be8c',
		warning: '#ebcb8b',
		error: '#bf616a',
	},
};

function createSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Terminal Session',
		cwd: '/workspace',
		activeTerminalTabId: 'tab-1',
		terminalTabs: [
			{
				id: 'tab-1',
				name: null,
				shellType: 'zsh',
				pid: 0,
				cwd: '/workspace',
				createdAt: Date.now(),
				state: 'idle',
			},
		],
		...overrides,
	} as Session;
}

function createCallbacks() {
	return {
		onTabSelect: vi.fn(),
		onTabClose: vi.fn(),
		onNewTab: vi.fn(),
		onTabRename: vi.fn(),
		onTabReorder: vi.fn(),
		onTabStateChange: vi.fn(),
		onTabCwdChange: vi.fn(),
		onTabPidChange: vi.fn(),
		onRequestRename: vi.fn(),
	};
}

function mount(component: React.ReactElement): { container: HTMLDivElement; root: Root } {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);

	act(() => {
		root.render(component);
	});

	return { container, root };
}

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});

	return { promise, resolve };
}

describe('TerminalView', () => {
	let spawnTerminalTab: ReturnType<typeof vi.fn>;
	let killProcess: ReturnType<typeof vi.fn>;
	let onExit: ReturnType<typeof vi.fn>;
	let exitHandler: ((sessionId: string, code: number) => void) | null;

	beforeEach(() => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		mockXTerminalHandlesBySessionId.clear();
		mockTerminalTabBarProps.current = null;
		mockTerminalSearchBarProps.current = null;
		vi.clearAllMocks();
		exitHandler = null;

		spawnTerminalTab = vi.fn().mockResolvedValue({ success: true, pid: 4242 });
		killProcess = vi.fn().mockResolvedValue(true);
		onExit = vi.fn((handler: (sessionId: string, code: number) => void) => {
			exitHandler = handler;
			return vi.fn();
		});

		Object.assign((window as any).maestro.process as Record<string, unknown>, {
			spawnTerminalTab,
			kill: killProcess,
			onExit,
		});
	});

	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('spawns PTY for active tab and focuses its terminal', async () => {
		const callbacks = createCallbacks();
		const session = createSession();
		const { container, root } = mount(
			<TerminalView
				session={session}
				theme={theme}
				fontFamily="Monaco"
				defaultShell="zsh"
				shellArgs="-l"
				shellEnvVars={{ FOO: 'bar' }}
				{...callbacks}
			/>
		);

		expect(container.querySelector('[data-testid="terminal-tab-bar"]')).toBeTruthy();
		expect(
			container.querySelector('[data-testid="xterminal-session-1-terminal-tab-1"]')
		).toBeTruthy();

		await vi.waitFor(() => {
			expect(spawnTerminalTab).toHaveBeenCalledWith({
				sessionId: 'session-1-terminal-tab-1',
				cwd: '/workspace',
				shell: 'zsh',
				shellArgs: '-l',
				shellEnvVars: { FOO: 'bar' },
			});
		});

		expect(callbacks.onTabPidChange).toHaveBeenCalledWith('tab-1', 4242);
		expect(callbacks.onTabStateChange).toHaveBeenCalledWith('tab-1', 'idle');

		const terminalHandle = mockXTerminalHandlesBySessionId.get('session-1-terminal-tab-1');
		expect(terminalHandle).toBeTruthy();
		expect(terminalHandle?.focus).toHaveBeenCalled();

		act(() => {
			root.unmount();
		});
	});

	it('marks tab exited when PTY spawn fails', async () => {
		const callbacks = createCallbacks();
		spawnTerminalTab.mockResolvedValue({ success: false, pid: 0 });

		const session = createSession();
		const { root } = mount(
			<TerminalView
				session={session}
				theme={theme}
				fontFamily="Monaco"
				defaultShell="zsh"
				{...callbacks}
			/>
		);

		await vi.waitFor(() => {
			expect(callbacks.onTabStateChange).toHaveBeenCalledWith('tab-1', 'exited', 1);
		});
		expect(callbacks.onTabPidChange).toHaveBeenCalledWith('tab-1', 0);

		act(() => {
			root.unmount();
		});
	});

	it('shows spawn error state and retries exited tab spawn', async () => {
		const callbacks = createCallbacks();
		const session = createSession({
			terminalTabs: [
				{
					id: 'tab-1',
					name: null,
					shellType: 'zsh',
					pid: 0,
					cwd: '/workspace',
					createdAt: Date.now(),
					state: 'exited',
					exitCode: 1,
				},
			],
		});

		const { container, root } = mount(
			<TerminalView
				session={session}
				theme={theme}
				fontFamily="Monaco"
				defaultShell="zsh"
				{...callbacks}
			/>
		);

		expect(container.textContent).toContain('Failed to start terminal');
		expect(
			container.querySelector('[data-testid="xterminal-session-1-terminal-tab-1"]')
		).toBeNull();
		expect(spawnTerminalTab).not.toHaveBeenCalled();

		const retryButton = Array.from(container.querySelectorAll('button')).find(
			(button) => button.textContent === 'Retry'
		);
		expect(retryButton).toBeTruthy();

		act(() => {
			retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		});

		await vi.waitFor(() => {
			expect(spawnTerminalTab).toHaveBeenCalledWith({
				sessionId: 'session-1-terminal-tab-1',
				cwd: '/workspace',
				shell: 'zsh',
				shellArgs: undefined,
				shellEnvVars: undefined,
			});
		});

		expect(callbacks.onTabPidChange).toHaveBeenCalledWith('tab-1', 4242);
		expect(callbacks.onTabStateChange).toHaveBeenCalledWith('tab-1', 'idle');

		act(() => {
			root.unmount();
		});
	});

	it('spawns reopened tab PTY using the restored tab cwd', async () => {
		const callbacks = createCallbacks();
		const session = createSession({
			cwd: '/workspace/root',
			activeTerminalTabId: 'reopened-tab',
			terminalTabs: [
				{
					id: 'reopened-tab',
					name: 'Reopened',
					shellType: 'zsh',
					pid: 0,
					cwd: '/workspace/reopened',
					createdAt: Date.now(),
					state: 'idle',
				},
			],
		});
		const { root } = mount(
			<TerminalView
				session={session}
				theme={theme}
				fontFamily="Monaco"
				defaultShell="zsh"
				{...callbacks}
			/>
		);

		await vi.waitFor(() => {
			expect(spawnTerminalTab).toHaveBeenCalledWith({
				sessionId: 'session-1-terminal-reopened-tab',
				cwd: '/workspace/reopened',
				shell: 'zsh',
				shellArgs: undefined,
				shellEnvVars: undefined,
			});
		});

		expect(callbacks.onTabPidChange).toHaveBeenCalledWith('reopened-tab', 4242);
		expect(callbacks.onTabStateChange).toHaveBeenCalledWith('reopened-tab', 'idle');

		act(() => {
			root.unmount();
		});
	});

	it('ignores late spawn success when a rapidly closed tab no longer exists', async () => {
		const callbacks = createCallbacks();
		const pendingSpawn = createDeferred<{ success: boolean; pid: number }>();
		spawnTerminalTab.mockReturnValue(pendingSpawn.promise);

		const initialSession = createSession({
			activeTerminalTabId: 'tab-1',
			terminalTabs: [
				{
					id: 'tab-1',
					name: null,
					shellType: 'zsh',
					pid: 0,
					cwd: '/workspace',
					createdAt: Date.now(),
					state: 'idle',
				},
				{
					id: 'tab-2',
					name: 'Other',
					shellType: 'zsh',
					pid: 9001,
					cwd: '/workspace/other',
					createdAt: Date.now(),
					state: 'busy',
				},
			],
		});

		const { container, root } = mount(
			<TerminalView
				session={initialSession}
				theme={theme}
				fontFamily="Monaco"
				defaultShell="zsh"
				{...callbacks}
			/>
		);

		await vi.waitFor(() => {
			expect(spawnTerminalTab).toHaveBeenCalledTimes(1);
		});

		const closeButton = container.querySelector(
			'[data-testid="close-first-tab"]'
		) as HTMLButtonElement | null;
		expect(closeButton).toBeTruthy();

		act(() => {
			closeButton?.click();
		});

		const closedSession = createSession({
			activeTerminalTabId: 'tab-2',
			terminalTabs: [
				{
					id: 'tab-2',
					name: 'Other',
					shellType: 'zsh',
					pid: 9001,
					cwd: '/workspace/other',
					createdAt: Date.now(),
					state: 'busy',
				},
			],
		});

		act(() => {
			root.render(
				<TerminalView
					session={closedSession}
					theme={theme}
					fontFamily="Monaco"
					defaultShell="zsh"
					{...callbacks}
				/>
			);
		});

		await act(async () => {
			pendingSpawn.resolve({ success: true, pid: 5050 });
			await pendingSpawn.promise;
		});

		expect(callbacks.onTabClose).toHaveBeenCalledWith('tab-1');
		expect(callbacks.onTabPidChange).not.toHaveBeenCalledWith('tab-1', 5050);
		expect(callbacks.onTabStateChange).not.toHaveBeenCalledWith('tab-1', 'idle');

		act(() => {
			root.unmount();
		});
	});

	it('keeps terminal tab exited when the process exits before spawn resolves', async () => {
		const callbacks = createCallbacks();
		const pendingSpawn = createDeferred<{ success: boolean; pid: number }>();
		spawnTerminalTab.mockReturnValue(pendingSpawn.promise);

		const session = createSession();
		const { root } = mount(
			<TerminalView
				session={session}
				theme={theme}
				fontFamily="Monaco"
				defaultShell="zsh"
				{...callbacks}
			/>
		);

		await vi.waitFor(() => {
			expect(spawnTerminalTab).toHaveBeenCalledTimes(1);
		});

		act(() => {
			exitHandler?.('session-1-terminal-tab-1', 137);
		});

		expect(callbacks.onTabStateChange).toHaveBeenCalledWith('tab-1', 'exited', 137);
		expect(callbacks.onTabPidChange).toHaveBeenCalledWith('tab-1', 0);

		const exitedSession = createSession({
			terminalTabs: [
				{
					id: 'tab-1',
					name: null,
					shellType: 'zsh',
					pid: 0,
					cwd: '/workspace',
					createdAt: Date.now(),
					state: 'exited',
					exitCode: 137,
				},
			],
		});

		act(() => {
			root.render(
				<TerminalView
					session={exitedSession}
					theme={theme}
					fontFamily="Monaco"
					defaultShell="zsh"
					{...callbacks}
				/>
			);
		});

		await act(async () => {
			pendingSpawn.resolve({ success: true, pid: 4242 });
			await pendingSpawn.promise;
		});

		expect(callbacks.onTabPidChange).not.toHaveBeenCalledWith('tab-1', 4242);
		expect(callbacks.onTabStateChange).not.toHaveBeenCalledWith('tab-1', 'idle');

		act(() => {
			root.unmount();
		});
	});

	it('resolves pending PTY spawn after unmount without throwing', async () => {
		const callbacks = createCallbacks();
		const pendingSpawn = createDeferred<{ success: boolean; pid: number }>();
		spawnTerminalTab.mockReturnValue(pendingSpawn.promise);

		const session = createSession();
		const { root } = mount(
			<TerminalView
				session={session}
				theme={theme}
				fontFamily="Monaco"
				defaultShell="zsh"
				{...callbacks}
			/>
		);

		await vi.waitFor(() => {
			expect(spawnTerminalTab).toHaveBeenCalledTimes(1);
		});

		act(() => {
			root.unmount();
		});

		await act(async () => {
			pendingSpawn.resolve({ success: true, pid: 6006 });
			await pendingSpawn.promise;
		});

		expect(callbacks.onTabPidChange).toHaveBeenCalledWith('tab-1', 6006);
		expect(callbacks.onTabStateChange).toHaveBeenCalledWith('tab-1', 'idle');
	});

	it('exposes clear and search methods for the active terminal tab via ref', () => {
		const callbacks = createCallbacks();
		const session = createSession();
		const terminalViewRef = React.createRef<TerminalViewHandle>();

		const { root } = mount(
			<TerminalView
				ref={terminalViewRef}
				session={session}
				theme={theme}
				fontFamily="Monaco"
				defaultShell="zsh"
				{...callbacks}
			/>
		);

		const terminalHandle = mockXTerminalHandlesBySessionId.get('session-1-terminal-tab-1');
		expect(terminalHandle).toBeTruthy();

		act(() => {
			terminalViewRef.current?.clearActiveTerminal();
		});
		expect(terminalHandle?.clear).toHaveBeenCalledTimes(1);

		const searchResult = terminalViewRef.current?.searchActiveTerminal('needle') ?? false;
		expect(searchResult).toBe(true);
		expect(terminalHandle?.search).toHaveBeenCalledWith('needle');

		const searchNextResult = terminalViewRef.current?.searchNext() ?? false;
		expect(searchNextResult).toBe(true);
		expect(terminalHandle?.searchNext).toHaveBeenCalledTimes(1);

		const searchPreviousResult = terminalViewRef.current?.searchPrevious() ?? true;
		expect(searchPreviousResult).toBe(false);
		expect(terminalHandle?.searchPrevious).toHaveBeenCalledTimes(1);

		const initialFocusCalls = terminalHandle?.focus.mock.calls.length ?? 0;
		act(() => {
			terminalViewRef.current?.focusActiveTerminal();
		});
		expect(terminalHandle?.focus.mock.calls.length ?? 0).toBe(initialFocusCalls + 1);

		act(() => {
			root.unmount();
		});
	});

	it('passes search UI callbacks to the search bar for the active terminal', () => {
		const callbacks = createCallbacks();
		const onSearchClose = vi.fn();
		const session = createSession();

		const { root } = mount(
			<TerminalView
				session={session}
				theme={theme}
				fontFamily="Monaco"
				defaultShell="zsh"
				searchOpen={true}
				onSearchClose={onSearchClose}
				{...callbacks}
			/>
		);

		const terminalHandle = mockXTerminalHandlesBySessionId.get('session-1-terminal-tab-1');
		expect(terminalHandle).toBeTruthy();
		expect(mockTerminalSearchBarProps.current?.isOpen).toBe(true);

		const searchResult = mockTerminalSearchBarProps.current?.onSearch('needle') ?? false;
		expect(searchResult).toBe(true);
		expect(terminalHandle?.search).toHaveBeenCalledWith('needle');

		const searchNextResult = mockTerminalSearchBarProps.current?.onSearchNext() ?? false;
		expect(searchNextResult).toBe(true);
		expect(terminalHandle?.searchNext).toHaveBeenCalledTimes(1);

		const searchPreviousResult = mockTerminalSearchBarProps.current?.onSearchPrevious() ?? true;
		expect(searchPreviousResult).toBe(false);
		expect(terminalHandle?.searchPrevious).toHaveBeenCalledTimes(1);

		act(() => {
			mockTerminalSearchBarProps.current?.onClose();
		});
		expect(onSearchClose).toHaveBeenCalledTimes(1);

		act(() => {
			root.unmount();
		});
	});

	it('kills PTY before closing a running tab', async () => {
		const callbacks = createCallbacks();
		const session = createSession({
			terminalTabs: [
				{
					id: 'tab-1',
					name: null,
					shellType: 'zsh',
					pid: 999,
					cwd: '/workspace',
					createdAt: Date.now(),
					state: 'busy',
				},
			],
		});
		const { container, root } = mount(
			<TerminalView
				session={session}
				theme={theme}
				fontFamily="Monaco"
				defaultShell="zsh"
				{...callbacks}
			/>
		);

		const closeButton = container.querySelector(
			'[data-testid="close-first-tab"]'
		) as HTMLButtonElement | null;
		expect(closeButton).toBeTruthy();

		act(() => {
			closeButton?.click();
		});

		await vi.waitFor(() => {
			expect(killProcess).toHaveBeenCalledWith('session-1-terminal-tab-1');
		});

		expect(callbacks.onTabClose).toHaveBeenCalledWith('tab-1');

		act(() => {
			root.unmount();
		});
	});

	it('handles process exit events for matching tab session ids', () => {
		const callbacks = createCallbacks();
		const session = createSession({
			terminalTabs: [
				{
					id: 'tab-1',
					name: null,
					shellType: 'zsh',
					pid: 100,
					cwd: '/workspace',
					createdAt: Date.now(),
					state: 'idle',
				},
				{
					id: 'tab-2',
					name: 'Build',
					shellType: 'bash',
					pid: 200,
					cwd: '/workspace/build',
					createdAt: Date.now(),
					state: 'busy',
				},
			],
		});

		const { root } = mount(
			<TerminalView
				session={session}
				theme={theme}
				fontFamily="Monaco"
				defaultShell="zsh"
				{...callbacks}
			/>
		);

		expect(onExit).toHaveBeenCalledTimes(1);
		expect(exitHandler).toBeTypeOf('function');

		act(() => {
			exitHandler?.('session-1-terminal-tab-2', 9);
			exitHandler?.('session-1-terminal-nonexistent', 1);
		});

		expect(callbacks.onTabStateChange).toHaveBeenCalledWith('tab-2', 'exited', 9);
		expect(callbacks.onTabPidChange).toHaveBeenCalledWith('tab-2', 0);

		act(() => {
			root.unmount();
		});
	});

	it('shows empty state when there are no terminal tabs', () => {
		const callbacks = createCallbacks();
		const session = createSession({
			activeTerminalTabId: '',
			terminalTabs: [],
		});
		const { container, root } = mount(
			<TerminalView
				session={session}
				theme={theme}
				fontFamily="Monaco"
				defaultShell="zsh"
				{...callbacks}
			/>
		);

		expect(container.textContent).toContain('No terminal tabs. Click + to create one.');
		expect(spawnTerminalTab).not.toHaveBeenCalled();

		act(() => {
			root.unmount();
		});
	});
});
