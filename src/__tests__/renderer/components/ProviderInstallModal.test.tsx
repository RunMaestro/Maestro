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
import { AGENT_MODES, agentModeFields } from '../../helpers';

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
const mockReprobe = vi.fn();
let exitHandler: ((sessionId: string, code: number) => void) | undefined;
let dataHandler: ((sessionId: string, data: string) => void) | undefined;

beforeEach(() => {
	vi.clearAllMocks();
	exitHandler = undefined;
	dataHandler = undefined;
	platformState.current = 'darwin';
	mockSpawnTerminalTab.mockResolvedValue({ pid: 1, success: true });
	mockWrite.mockResolvedValue(true);
	mockReprobe.mockResolvedValue({ status: 'ok' });
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
	maestro.agents = {
		...maestro.agents,
		reprobe: mockReprobe,
	};
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
	it('types the install for this platform into a shell that exits with it, without offering Retry yet', async () => {
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
		expect(screen.queryByTestId('provider-install-retry')).toBeNull();
	});

	it.each(AGENT_MODES)('draws the same dialog and installs where a %s agent runs', async (mode) => {
		// A Windows host, so a remote agent's POSIX line is visibly not this machine's.
		platformState.current = 'win32';
		const claude = {
			...session,
			toolType: 'claude-code',
			...agentModeFields(mode),
		} as unknown as Session;
		render(
			<ProviderInstallModal
				theme={mockTheme}
				session={claude}
				onClose={vi.fn()}
				onRetry={vi.fn()}
			/>
		);
		const ptySessionId = await startInstall();
		const spawn = mockSpawnTerminalTab.mock.calls[0][0];

		expect(screen.getByTestId('provider-install-status')).toHaveTextContent(
			'Installing Claude Code. Answer any prompts above.'
		);
		if (mode === 'local') {
			expect(spawn.sessionSshRemoteConfig).toBeUndefined();
			expect(screen.getByTestId('provider-install-command')).toHaveTextContent('install.ps1');
		} else {
			// The shell starts on the remote and types the remote's POSIX command.
			expect(spawn.sessionSshRemoteConfig).toMatchObject({ enabled: true, remoteId: 'r1' });
			expect(spawn.cwd).toBe('');
			expect(mockWrite).toHaveBeenCalledWith(
				ptySessionId,
				"bash -c 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash'; exit $?\r"
			);
		}
	});

	it('reports success, refreshes detection, and offers Retry when the install exits 0', async () => {
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
		expect(mockReprobe).toHaveBeenCalledWith('codex');

		fireEvent.click(screen.getByTestId('provider-install-retry'));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it('offers Run Again and does not offer Retry after a failed install', async () => {
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
		expect(screen.queryByTestId('provider-install-retry')).toBeNull();

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

	it('spawns nothing and does not offer Retry when there is no install for the platform', () => {
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
		expect(screen.queryByTestId('provider-install-retry')).toBeNull();
		expect(mockSpawnTerminalTab).not.toHaveBeenCalled();
		expect(screen.getByTestId('provider-install-status')).toHaveTextContent('no one-line install');
	});

	it('installs and reprobes the failed tab provider rather than the agent toolType', async () => {
		const claudeWithCodexTab = {
			id: 'agent-2',
			name: 'Claude Agent',
			toolType: 'claude-code',
			cwd: '/tmp/project',
			projectRoot: '/tmp/project',
			customEnvVars: { CLAUDE_ONLY: '1' },
			providerOverrides: {
				codex: { customEnvVars: { CODEX_ONLY: '1' } },
			},
			aiTabs: [{ id: 'tab-codex', tabProvider: 'codex', logs: [] }],
		} as unknown as Session;

		render(
			<ProviderInstallModal
				theme={mockTheme}
				session={claudeWithCodexTab}
				agentId="codex"
				tabId="tab-codex"
				onClose={vi.fn()}
				onRetry={vi.fn()}
			/>
		);

		const ptySessionId = await startInstall();
		expect(screen.getByRole('heading', { name: 'Install Codex CLI' })).toBeInTheDocument();
		expect(screen.getByTestId('provider-install-command')).toHaveTextContent(
			'npm install -g @openai/codex'
		);
		expect(mockSpawnTerminalTab).toHaveBeenCalledWith(
			expect.objectContaining({
				toolType: 'codex',
				sessionCustomEnvVars: expect.objectContaining({ CODEX_ONLY: '1' }),
			})
		);
		expect(mockSpawnTerminalTab.mock.calls[0][0].sessionCustomEnvVars).not.toHaveProperty(
			'CLAUDE_ONLY'
		);

		await act(async () => {
			exitHandler?.(ptySessionId, 0);
		});
		expect(mockReprobe).toHaveBeenCalledWith('codex');
	});
});
