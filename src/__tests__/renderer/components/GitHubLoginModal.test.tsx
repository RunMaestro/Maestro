/**
 * GitHubLoginModal: runs `gh auth login` in the shared embedded login terminal
 * and continues the moment gh reports signed in.
 */

import React from 'react';
import { render as rtlRender, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubLoginModal } from '../../../renderer/components/GitHubLoginModal';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../helpers/mockTheme';

const render = (ui: React.ReactElement) => rtlRender(<LayerStackProvider>{ui}</LayerStackProvider>);

// The real XTerminal needs canvas/WebGL, which jsdom does not have.
vi.mock('../../../renderer/components/XTerminal', () => {
	const React = require('react');
	const XTerminal = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
		React.useImperativeHandle(ref, () => ({ focus: vi.fn(), write: vi.fn() }));
		return React.createElement('div', {
			'data-testid': 'xterm-mock',
			'data-session-id': String(props.sessionId),
		});
	});
	XTerminal.displayName = 'XTerminal';
	return { XTerminal };
});

const platformState = vi.hoisted(() => ({ current: 'darwin' }));
vi.mock('../../../renderer/utils/platformUtils', () => ({
	isWindowsPlatform: () => platformState.current === 'win32',
	isMacOSPlatform: () => platformState.current === 'darwin',
	isLinuxPlatform: () => platformState.current === 'linux',
}));

const LOGIN = {
	command: '/opt/homebrew/bin/gh',
	args: ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'],
	display: '/opt/homebrew/bin/gh auth login --hostname github.com --git-protocol https --web',
};

const mockSpawnTerminalTab = vi.fn();
const mockWrite = vi.fn();
let exitHandler: ((sessionId: string, code: number) => void) | undefined;
let dataHandler: ((sessionId: string, data: string) => void) | undefined;

beforeEach(() => {
	vi.clearAllMocks();
	exitHandler = undefined;
	dataHandler = undefined;
	platformState.current = 'darwin';
	mockSpawnTerminalTab.mockResolvedValue({ pid: 1, success: true });
	mockWrite.mockResolvedValue(true);
	useSettingsStore.setState({ shellEnvVars: {}, defaultShell: 'zsh' } as never);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const maestro = (window as any).maestro;
	maestro.process.spawnTerminalTab = mockSpawnTerminalTab;
	maestro.process.write = mockWrite;
	maestro.process.kill = vi.fn().mockResolvedValue(true);
	maestro.process.onExit = vi.fn((handler: typeof exitHandler) => {
		exitHandler = handler;
		return () => {};
	});
	maestro.process.onData = vi.fn((handler: typeof dataHandler) => {
		dataHandler = handler;
		return () => {};
	});
	maestro.feedback.getGhLoginCommand = vi.fn().mockResolvedValue(LOGIN);
	maestro.feedback.checkGhAuth = vi.fn().mockResolvedValue({ authenticated: true });
});

async function startLogin() {
	await waitFor(() => expect(mockSpawnTerminalTab).toHaveBeenCalled());
	const ptySessionId = mockSpawnTerminalTab.mock.calls[0][0].sessionId as string;
	await act(async () => {
		dataHandler?.(ptySessionId, '$ ');
		await Promise.resolve();
	});
	return ptySessionId;
}

describe('GitHubLoginModal', () => {
	it('types the gh login into a shell that exits with gh, so the end of the login is visible', async () => {
		render(<GitHubLoginModal theme={mockTheme} onClose={vi.fn()} onSignedIn={vi.fn()} />);
		const ptySessionId = await startLogin();

		expect(ptySessionId).toMatch(/^gh-login-terminal-/);
		expect(mockWrite).toHaveBeenCalledWith(ptySessionId, `${LOGIN.display}; exit $?\r`);
	});

	// A user on the wrong gh account should see which one before signing in again.
	it('names the account gh is signed in as, when the caller knows it', async () => {
		render(
			<GitHubLoginModal
				theme={mockTheme}
				account={{ host: 'github.com', login: 'octocat' }}
				onClose={vi.fn()}
				onSignedIn={vi.fn()}
			/>
		);
		expect((await screen.findByTestId('gh-login-account')).textContent).toContain(
			'octocat @ github.com'
		);
	});

	it('names no account when none is known', async () => {
		render(<GitHubLoginModal theme={mockTheme} onClose={vi.fn()} onSignedIn={vi.fn()} />);
		await startLogin();
		expect(screen.queryByTestId('gh-login-account')).toBeNull();
	});

	it('uses the PowerShell exit form on Windows, never WSL', async () => {
		platformState.current = 'win32';
		useSettingsStore.setState({ defaultShell: 'wsl' } as never);
		render(<GitHubLoginModal theme={mockTheme} onClose={vi.fn()} onSignedIn={vi.fn()} />);
		const ptySessionId = await startLogin();

		expect(mockSpawnTerminalTab.mock.calls[0][0].shell).toBe('powershell');
		expect(mockWrite).toHaveBeenCalledWith(ptySessionId, `${LOGIN.display}; exit $LASTEXITCODE\r`);
	});

	it('re-checks gh past the cache and continues when the login exits 0', async () => {
		const onSignedIn = vi.fn();
		render(<GitHubLoginModal theme={mockTheme} onClose={vi.fn()} onSignedIn={onSignedIn} />);
		const ptySessionId = await startLogin();

		await act(async () => {
			exitHandler?.(ptySessionId, 0);
			await Promise.resolve();
		});

		await waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
		expect(window.maestro.feedback.checkGhAuth).toHaveBeenCalledWith({ fresh: true });
	});

	it('stays open with a retry when the login fails, and Check Again can still continue', async () => {
		const onSignedIn = vi.fn();
		render(<GitHubLoginModal theme={mockTheme} onClose={vi.fn()} onSignedIn={onSignedIn} />);
		const ptySessionId = await startLogin();

		await act(async () => {
			exitHandler?.(ptySessionId, 1);
			await Promise.resolve();
		});
		expect(screen.getByTestId('gh-login-status').textContent).toContain('code 1');
		expect(onSignedIn).not.toHaveBeenCalled();

		fireEvent.click(screen.getByTestId('gh-login-retry'));
		await waitFor(() => expect(mockSpawnTerminalTab).toHaveBeenCalledTimes(2));
		expect(mockSpawnTerminalTab.mock.calls[1][0].sessionId).not.toBe(ptySessionId);

		fireEvent.click(screen.getByTestId('gh-login-check'));
		await waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
	});
});
