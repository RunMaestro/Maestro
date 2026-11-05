/**
 * ProviderInstallModal: runs the provider's install command for this platform
 * in the shared embedded terminal, and hands Retry back to the caller.
 */

import React from 'react';
import { render as rtlRender, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProviderInstallModal } from '../../../renderer/components/ProviderInstallModal';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../helpers/mockTheme';
import type { Session } from '../../../renderer/types';

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
	getPlatform: () => platformState.current,
	isWindowsPlatform: () => platformState.current === 'win32',
	isMacOSPlatform: () => platformState.current === 'darwin',
	isLinuxPlatform: () => platformState.current === 'linux',
}));

const session = {
	id: 'agent-1',
	name: 'My Codex',
	toolType: 'codex',
	cwd: '/tmp/project',
	projectRoot: '/tmp/project',
} as unknown as Session;

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
	maestro.shell.openExternal = vi.fn().mockResolvedValue(undefined);
});

async function startInstall() {
	await waitFor(() => expect(mockSpawnTerminalTab).toHaveBeenCalled());
	const ptySessionId = mockSpawnTerminalTab.mock.calls[0][0].sessionId as string;
	await act(async () => {
		dataHandler?.(ptySessionId, '$ ');
		await Promise.resolve();
	});
	return ptySessionId;
}

describe('ProviderInstallModal', () => {
	it('types the install for this platform into a shell that exits with it', async () => {
		render(
			<ProviderInstallModal
				theme={mockTheme}
				session={session}
				onClose={vi.fn()}
				onRetry={vi.fn()}
			/>
		);
		const ptySessionId = await startInstall();

		expect(ptySessionId).toMatch(/^install-agent-1-terminal-/);
		expect(screen.getByTestId('provider-install-command')).toHaveTextContent(
			'npm install -g @openai/codex'
		);
		expect(mockWrite).toHaveBeenCalledWith(ptySessionId, 'npm install -g @openai/codex; exit $?\r');
	});

	it('reports success when the install exits 0, and Retry hands back to the caller', async () => {
		const onRetry = vi.fn();
		render(
			<ProviderInstallModal
				theme={mockTheme}
				session={session}
				onClose={vi.fn()}
				onRetry={onRetry}
			/>
		);
		const ptySessionId = await startInstall();

		await act(async () => {
			exitHandler?.(ptySessionId, 0);
		});
		expect(screen.getByTestId('provider-install-status')).toHaveTextContent('Codex CLI installed');

		fireEvent.click(screen.getByTestId('provider-install-retry'));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it('offers Run Again after a failed install', async () => {
		render(
			<ProviderInstallModal
				theme={mockTheme}
				session={session}
				onClose={vi.fn()}
				onRetry={vi.fn()}
			/>
		);
		const ptySessionId = await startInstall();

		await act(async () => {
			exitHandler?.(ptySessionId, 1);
		});
		expect(screen.getByTestId('provider-install-status')).toHaveTextContent('exit code 1');

		fireEvent.click(screen.getByTestId('provider-install-run-again'));
		await waitFor(() => expect(mockSpawnTerminalTab).toHaveBeenCalledTimes(2));
	});

	it('opens the provider install guide', async () => {
		render(
			<ProviderInstallModal
				theme={mockTheme}
				session={session}
				onClose={vi.fn()}
				onRetry={vi.fn()}
			/>
		);
		fireEvent.click(screen.getByTestId('provider-install-docs'));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((window as any).maestro.shell.openExternal).toHaveBeenCalledWith(
			expect.stringMatching(/^https:\/\/github\.com\/openai\/codex/)
		);
	});

	it('spawns nothing when there is no install for the platform', () => {
		platformState.current = 'browser';
		render(
			<ProviderInstallModal
				theme={mockTheme}
				session={session}
				onClose={vi.fn()}
				onRetry={vi.fn()}
			/>
		);
		expect(screen.queryByTestId('provider-install-command')).toBeNull();
		expect(mockSpawnTerminalTab).not.toHaveBeenCalled();
		expect(screen.getByTestId('provider-install-status')).toHaveTextContent('no one-line install');
	});
});
