/**
 * @file ReauthModal.test.tsx
 * @description Tests for the provider re-authentication modal.
 *
 * The point of this modal is that the login finishes inside Maestro, so the
 * behavior under test is the PTY contract: spawn exactly one login shell, type
 * the provider's own login command into it, run it on the agent's SSH remote
 * when the agent has one, and never leave that shell alive behind a closed
 * dialog.
 *
 * The second block covers the environment disclosure: that the three env layers
 * are merged in the spawner's own precedence order, and that failing to read one
 * layer degrades instead of blocking the login.
 */

import React from 'react';
import { render as rtlRender, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReauthModal } from '../../../renderer/components/ReauthModal';
import type { AuthOutage } from '../../../renderer/stores/authOutageStore';
import { providerAuthKey } from '../../../shared/providerAuthIdentity';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { createMockSession } from '../../helpers/mockSession';
import { mockTheme } from '../../helpers/mockTheme';

/**
 * The dialog is scoped to a PROVIDER outage, not to the agent that failed
 * first, so every render needs one. Defaults to a single blocked agent, which
 * is the common case; tests that care about the blast radius pass their own
 * `blocked` roster.
 */
function createOutage(overrides: Partial<AuthOutage> = {}): AuthOutage {
	const toolType = overrides.toolType ?? 'claude-code';
	return {
		providerKey: providerAuthKey(toolType),
		toolType,
		message: '',
		startedAt: 0,
		blocked: [{ sessionId: 'sess-1', tabIds: [] }],
		fromPipeline: false,
		...overrides,
	};
}

/** Modal registers itself with the layer stack, so it needs the provider. */
const render = (ui: React.ReactElement) => rtlRender(<LayerStackProvider>{ui}</LayerStackProvider>);

// The real XTerminal needs canvas/WebGL, which jsdom does not have.
vi.mock('../../../renderer/components/XTerminal', () => {
	const React = require('react');
	const XTerminal = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
		React.useImperativeHandle(ref, () => ({ focus: vi.fn() }));
		return React.createElement('div', {
			'data-testid': 'xterm-mock',
			'data-session-id': String(props.sessionId),
		});
	});
	XTerminal.displayName = 'XTerminal';
	return { XTerminal };
});

const mockSpawnTerminalTab = vi.fn();
const mockWrite = vi.fn();
const mockKill = vi.fn();
const mockGetCustomEnvVars = vi.fn();
let exitHandler: ((sessionId: string) => void) | undefined;

beforeEach(() => {
	vi.clearAllMocks();
	exitHandler = undefined;
	mockSpawnTerminalTab.mockResolvedValue({ pid: 4242, success: true });
	mockWrite.mockResolvedValue(true);
	mockKill.mockResolvedValue(true);
	mockGetCustomEnvVars.mockResolvedValue({});
	// Each test owns its own global layer; the store persists between them.
	useSettingsStore.setState({ shellEnvVars: {} } as never);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const maestro = (window as any).maestro;
	maestro.process.spawnTerminalTab = mockSpawnTerminalTab;
	maestro.process.write = mockWrite;
	maestro.process.kill = mockKill;
	maestro.agents.getCustomEnvVars = mockGetCustomEnvVars;
	maestro.process.onExit = vi.fn((handler: (sessionId: string) => void) => {
		exitHandler = handler;
		return () => {};
	});
});

/** Await the spawn promise chain that the mount effect kicks off. */
async function flushSpawn() {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe('ReauthModal', () => {
	it('spawns one login shell and types the provider login command into it', async () => {
		const session = createMockSession({ id: 'sess-1', toolType: 'claude-code' });
		const outage = createOutage({ toolType: 'claude-code' });
		render(<ReauthModal theme={mockTheme} outage={outage} session={session} onClose={vi.fn()} />);
		await flushSpawn();

		expect(mockSpawnTerminalTab).toHaveBeenCalledTimes(1);
		expect(mockSpawnTerminalTab.mock.calls[0][0]).toMatchObject({
			cwd: '/test/project',
			toolType: 'claude-code',
		});
		expect(mockWrite).toHaveBeenCalledWith(expect.any(String), 'claude /login\n');
	});

	// The routing key is load-bearing twice over: `-terminal-` makes PtySpawner
	// forward raw output for xterm.js, and the `reauth-` prefix keeps TerminalView
	// from claiming this shell's exit as one of its own terminal tabs.
	it('uses a PTY key that cannot collide with a terminal tab', async () => {
		const session = createMockSession({ id: 'sess-1' });
		const outage = createOutage();
		render(<ReauthModal theme={mockTheme} outage={outage} session={session} onClose={vi.fn()} />);
		await flushSpawn();

		const ptySessionId: string = mockSpawnTerminalTab.mock.calls[0][0].sessionId;
		expect(ptySessionId.startsWith('reauth-sess-1-terminal-')).toBe(true);
		expect(ptySessionId.split('-terminal-')[0]).not.toBe('sess-1');
		expect(screen.getByTestId('xterm-mock').getAttribute('data-session-id')).toBe(ptySessionId);
	});

	it('kills the login shell when the modal unmounts', async () => {
		const session = createMockSession({ id: 'sess-1' });
		const outage = createOutage();
		const { unmount } = render(
			<ReauthModal theme={mockTheme} outage={outage} session={session} onClose={vi.fn()} />
		);
		await flushSpawn();
		const ptySessionId: string = mockSpawnTerminalTab.mock.calls[0][0].sessionId;

		unmount();

		expect(mockKill).toHaveBeenCalledWith(ptySessionId);
	});

	// An agent that runs on a remote host has to re-authenticate on that host.
	it('runs the login on the agent SSH remote when it has one', async () => {
		const session = createMockSession({
			id: 'sess-1',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			remoteCwd: '/srv/project',
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any);
		const outage = createOutage();
		render(<ReauthModal theme={mockTheme} outage={outage} session={session} onClose={vi.fn()} />);
		await flushSpawn();

		expect(mockSpawnTerminalTab.mock.calls[0][0].sessionSshRemoteConfig).toMatchObject({
			enabled: true,
			remoteId: 'remote-1',
			workingDirOverride: '/srv/project',
		});
	});

	it('shows the TUI follow-up for an agent whose login is a slash command', async () => {
		const session = createMockSession({ id: 'sess-1', toolType: 'factory-droid' });
		const outage = createOutage({ toolType: 'factory-droid' });
		render(<ReauthModal theme={mockTheme} outage={outage} session={session} onClose={vi.fn()} />);
		await flushSpawn();

		expect(screen.getByText(/then type \/login/)).toBeInTheDocument();
		expect(mockWrite).toHaveBeenCalledWith(expect.any(String), 'droid\n');
	});

	// The Terminal agent is a plain shell: there is no credential to refresh, so
	// guessing a command to run would be worse than saying so.
	it('does not spawn anything for an agent with no login command', async () => {
		const session = createMockSession({ id: 'sess-1', toolType: 'terminal' });
		const outage = createOutage({ toolType: 'terminal' });
		render(<ReauthModal theme={mockTheme} outage={outage} session={session} onClose={vi.fn()} />);
		await flushSpawn();

		expect(mockSpawnTerminalTab).not.toHaveBeenCalled();
		expect(screen.queryByTestId('xterm-mock')).not.toBeInTheDocument();
		expect(screen.getByText(/no login command Maestro can run/)).toBeInTheDocument();
	});

	it('reports a failed spawn instead of waiting on a shell that never started', async () => {
		mockSpawnTerminalTab.mockResolvedValue({ pid: 0, success: false });
		const session = createMockSession({ id: 'sess-1' });
		const outage = createOutage();
		render(<ReauthModal theme={mockTheme} outage={outage} session={session} onClose={vi.fn()} />);
		await flushSpawn();

		expect(mockWrite).not.toHaveBeenCalled();
		await waitFor(() => {
			expect(screen.getByText(/shell could not be started/i)).toBeInTheDocument();
		});
	});

	it('names the SSH remote when the login shell could not be reached', async () => {
		mockSpawnTerminalTab.mockResolvedValue({ pid: 0, success: false });
		const session = createMockSession({
			id: 'sess-1',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any);
		const outage = createOutage();
		render(<ReauthModal theme={mockTheme} outage={outage} session={session} onClose={vi.fn()} />);
		await flushSpawn();

		await waitFor(() => {
			expect(screen.getByText(/SSH remote could not be reached/i)).toBeInTheDocument();
		});
	});

	it('reports the login session ending when its shell exits', async () => {
		const session = createMockSession({ id: 'sess-1' });
		const outage = createOutage();
		render(<ReauthModal theme={mockTheme} outage={outage} session={session} onClose={vi.fn()} />);
		await flushSpawn();
		const ptySessionId: string = mockSpawnTerminalTab.mock.calls[0][0].sessionId;

		// An unrelated process exiting must not close out this flow.
		act(() => exitHandler?.('some-other-session'));
		expect(screen.queryByText(/login session ended/i)).not.toBeInTheDocument();

		act(() => exitHandler?.(ptySessionId));
		expect(screen.getByText(/login session ended/i)).toBeInTheDocument();
	});

	it('says a pipeline was the thing that hit the expired credentials', async () => {
		const session = createMockSession({ id: 'sess-1', name: 'Nightly Triage' });
		const outage = createOutage({ message: 'OAuth token has expired.', fromPipeline: true });
		render(<ReauthModal theme={mockTheme} outage={outage} session={session} onClose={vi.fn()} />);
		await flushSpawn();

		expect(screen.getByText(/taking Cue pipelines down with it/)).toBeInTheDocument();
		expect(screen.getByText('OAuth token has expired.')).toBeInTheDocument();
	});

	// The dialog is scoped to the provider, so it has to describe the whole blast
	// radius: one expired token stops every agent sharing that credential store,
	// and one login releases all of them.
	it('names every blocked agent and offers to resume them together', async () => {
		const sessions = [
			createMockSession({ id: 'sess-1', name: 'Nightly Triage' }),
			createMockSession({ id: 'sess-2', name: 'Doc Sweep' }),
		];
		useSessionStore.setState({ sessions });
		const outage = createOutage({
			blocked: [
				{ sessionId: 'sess-1', tabIds: ['tab-1'] },
				{ sessionId: 'sess-2', tabIds: [] },
			],
		});
		render(
			<ReauthModal theme={mockTheme} outage={outage} session={sessions[0]} onClose={vi.fn()} />
		);
		await flushSpawn();

		expect(screen.getByText('Nightly Triage, Doc Sweep')).toBeInTheDocument();
		expect(screen.getByText(/All 2 agents on this provider are stopped/)).toBeInTheDocument();
		expect(screen.getByTestId('reauth-resume').textContent).toBe('Resume 2 Agents');
	});
});

/**
 * Which credentials the login writes, and which the agent then reads, is decided
 * by the environment - so an auth failure is exactly when it has to be visible.
 * The merge must match the spawner's, or the panel would describe a process
 * nobody is running.
 */
describe('ReauthModal environment disclosure', () => {
	/** An agent whose own override shadows the provider layer for the same key. */
	function createEnvSession() {
		return createMockSession({
			id: 'sess-1',
			name: 'Cyber Stocks',
			toolType: 'claude-code',
			customEnvVars: { ANTHROPIC_BASE_URL: 'https://session.example' },
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any);
	}

	beforeEach(() => {
		mockGetCustomEnvVars.mockResolvedValue({ ANTHROPIC_BASE_URL: 'https://provider.example' });
		useSettingsStore.setState({ shellEnvVars: { GLOBAL_ONLY: 'yes' } } as never);
	});

	function renderEnvModal() {
		const session = createEnvSession();
		return render(
			<ReauthModal theme={mockTheme} outage={createOutage()} session={session} onClose={vi.fn()} />
		);
	}

	it('names the agent whose environment is shown', async () => {
		renderEnvModal();
		await waitFor(() =>
			expect(screen.getByTestId('reauth-env-toggle')).toHaveTextContent('Cyber Stocks')
		);
	});

	it('starts collapsed so the login stays the focus', async () => {
		renderEnvModal();
		await waitFor(() => expect(screen.getByTestId('reauth-env-toggle')).toBeInTheDocument());
		expect(screen.queryByTestId('reauth-env')).not.toBeInTheDocument();
	});

	it('merges all three layers with the spawner precedence', async () => {
		renderEnvModal();
		fireEvent.click(await screen.findByTestId('reauth-env-toggle'));

		await waitFor(() => expect(screen.getByTestId('reauth-env')).toBeInTheDocument());
		// Global-only var survives...
		expect(screen.getByText('GLOBAL_ONLY')).toBeInTheDocument();
		// ...and the session value beats the provider value for the same key.
		expect(screen.getByText('https://session.example')).toBeInTheDocument();
		expect(screen.queryByText('https://provider.example')).not.toBeInTheDocument();
	});

	it('counts the effective variables on the toggle', async () => {
		renderEnvModal();
		await waitFor(() => expect(screen.getByTestId('reauth-env-toggle')).toHaveTextContent('(2)'));
	});

	// The env panel is a diagnostic aid; it must never stop the user logging in.
	it('still renders the login when the provider layer cannot be read', async () => {
		mockGetCustomEnvVars.mockRejectedValue(new Error('ipc down'));
		renderEnvModal();

		fireEvent.click(await screen.findByTestId('reauth-env-toggle'));

		await waitFor(() => expect(screen.getByTestId('reauth-env')).toBeInTheDocument());
		// Falls back to the layers it does have.
		expect(screen.getByText('GLOBAL_ONLY')).toBeInTheDocument();
		expect(screen.getByTestId('reauth-resume')).toBeInTheDocument();
	});
});
