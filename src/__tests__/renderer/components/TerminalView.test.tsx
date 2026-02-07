import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, TerminalTab, Theme } from '../../../renderer/types';

const mockXTerminalFocusBySessionId = vi.hoisted(() => new Map<string, ReturnType<typeof vi.fn>>());
const mockTerminalTabBarProps = vi.hoisted(() => ({
	current: null as {
		tabs: TerminalTab[];
		onTabClose: (tabId: string) => void;
	} | null,
}));

vi.mock('../../../renderer/components/XTerminal', async () => {
	const ReactModule = await import('react');

	return {
		XTerminal: ReactModule.forwardRef(function MockXTerminal(
			props: { sessionId: string },
			ref: React.ForwardedRef<{ focus: () => void }>
		) {
			const focus = vi.fn();
			mockXTerminalFocusBySessionId.set(props.sessionId, focus);

			ReactModule.useImperativeHandle(
				ref,
				() => ({
					focus,
				}),
				[focus]
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

import { TerminalView } from '../../../renderer/components/TerminalView';

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

describe('TerminalView', () => {
	let spawnTerminalTab: ReturnType<typeof vi.fn>;
	let killProcess: ReturnType<typeof vi.fn>;
	let onExit: ReturnType<typeof vi.fn>;
	let exitHandler: ((sessionId: string, code: number) => void) | null;

	beforeEach(() => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		mockXTerminalFocusBySessionId.clear();
		mockTerminalTabBarProps.current = null;
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

		const focus = mockXTerminalFocusBySessionId.get('session-1-terminal-tab-1');
		expect(focus).toBeTruthy();
		expect(focus).toHaveBeenCalled();

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
