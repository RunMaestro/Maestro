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
 *
 * The third block covers the credential-kind gate: the environment does not just
 * get disclosed, it decides whether a login is the right remedy at all. An
 * API-key, gateway, or Bedrock agent fails with the same output an expired login
 * produces, so the shell must not open for one - the flow would succeed and fix
 * nothing.
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
		React.useImperativeHandle(ref, () => ({ focus: vi.fn(), write: vi.fn() }));
		return React.createElement('div', {
			'data-testid': 'xterm-mock',
			'data-session-id': String(props.sessionId),
		});
	});
	XTerminal.displayName = 'XTerminal';
	return { XTerminal };
});

// `vi.mock` is hoisted above ordinary declarations, so the flag it reads has
// to be hoisted too.
const platformState = vi.hoisted(() => ({ current: 'darwin' }));
vi.mock('../../../renderer/utils/platformUtils', () => ({
	isWindowsPlatform: () => platformState.current === 'win32',
	isMacOSPlatform: () => platformState.current === 'darwin',
	isLinuxPlatform: () => platformState.current === 'linux',
}));

const mockSpawnTerminalTab = vi.fn();
const mockWrite = vi.fn();
const mockKill = vi.fn();
const mockGetCustomEnvVars = vi.fn();
let exitHandler: ((sessionId: string) => void) | undefined;
let dataHandler: ((sessionId: string, data: string) => void) | undefined;

/**
 * The login command is held until the shell proves it is alive, so a test that
 * wants to observe the write has to deliver that first byte.
 */
async function emitShellOutput(sessionId: string, data = '$ ') {
	await act(async () => {
		dataHandler?.(sessionId, data);
		await Promise.resolve();
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	exitHandler = undefined;
	dataHandler = undefined;
	mockSpawnTerminalTab.mockResolvedValue({ pid: 4242, success: true });
	mockWrite.mockResolvedValue(true);
	mockKill.mockResolvedValue(true);
	mockGetCustomEnvVars.mockResolvedValue({});
	platformState.current = 'darwin';
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
	maestro.process.onData = vi.fn((handler: (sessionId: string, data: string) => void) => {
		dataHandler = handler;
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

		// Held until the shell speaks: typing into a PTY that is not ready yet is
		// how a remote login came up as an empty box.
		expect(mockWrite).not.toHaveBeenCalled();
		await emitShellOutput(mockSpawnTerminalTab.mock.calls[0][0].sessionId);
		expect(mockWrite).toHaveBeenCalledWith(expect.any(String), 'claude /login\r');
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

	// The bug this guards: spawn and kill used to live in separate effects, so
	// React StrictMode's remount (cleanup, then re-run) killed the shell the
	// first pass had started while a one-shot guard blocked the second pass from
	// starting another. The result was a dead PTY nobody typed into - an empty
	// terminal box - and it reproduced every time over SSH, where the spawn takes
	// long enough that the teardown always wins the race.
	it('still has a live login shell after a StrictMode-style remount', async () => {
		const session = createMockSession({ id: 'sess-1' });
		const outage = createOutage();
		const ui = (
			<ReauthModal theme={mockTheme} outage={outage} session={session} onClose={vi.fn()} />
		);

		// Let the first mount get as far as its own shell (the environment read
		// gates the spawn, so it has to settle first), then tear down and mount
		// again without letting the second spawn settle - exactly what StrictMode
		// does on a slow (SSH) spawn.
		const first = render(ui);
		await flushSpawn();
		first.unmount();
		render(ui);
		await flushSpawn();

		// The remount must have started its own shell rather than being blocked.
		expect(mockSpawnTerminalTab).toHaveBeenCalledTimes(2);
		const liveSessionId: string = mockSpawnTerminalTab.mock.calls[1][0].sessionId;

		// ...and that shell is the one that gets the login typed into it.
		await emitShellOutput(liveSessionId);
		expect(mockWrite).toHaveBeenCalledWith(liveSessionId, 'claude /login\r');
	});

	// The abandoned attempt's promise resolves after the remount. It must not
	// type the login into a shell that is already being replaced.
	it('does not type the login into a superseded shell', async () => {
		const session = createMockSession({ id: 'sess-1' });
		const outage = createOutage();
		const ui = (
			<ReauthModal theme={mockTheme} outage={outage} session={session} onClose={vi.fn()} />
		);

		const first = render(ui);
		await flushSpawn();
		first.unmount();
		render(ui);
		await flushSpawn();

		const supersededSessionId: string = mockSpawnTerminalTab.mock.calls[0][0].sessionId;
		await emitShellOutput(supersededSessionId);

		expect(mockWrite).not.toHaveBeenCalledWith(supersededSessionId, expect.any(String));
	});

	// A shell that never prints (a wedged SSH handshake) must still get the
	// command rather than leaving the user at a blank box forever.
	it('types the login anyway when the shell prints nothing', async () => {
		vi.useFakeTimers();
		try {
			const session = createMockSession({ id: 'sess-1' });
			const outage = createOutage();
			render(<ReauthModal theme={mockTheme} outage={outage} session={session} onClose={vi.fn()} />);
			await act(async () => {
				await Promise.resolve();
				await Promise.resolve();
			});
			expect(mockWrite).not.toHaveBeenCalled();

			await act(async () => {
				vi.advanceTimersByTime(8000);
			});

			expect(mockWrite).toHaveBeenCalledWith(expect.any(String), 'claude /login\r');
		} finally {
			vi.useRealTimers();
		}
	});

	// Over SSH the override becomes a `cd` the remote shell runs before anything
	// else, so a stale or local-looking path kills the session before the login
	// can start. The login needs no project directory at all.
	it('does not cd the remote login shell into a guessed project directory', async () => {
		const session = createMockSession({
			id: 'sess-1',
			cwd: '/Users/local/only',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any);
		const outage = createOutage();
		render(<ReauthModal theme={mockTheme} outage={outage} session={session} onClose={vi.fn()} />);
		await flushSpawn();

		expect(
			mockSpawnTerminalTab.mock.calls[0][0].sessionSshRemoteConfig.workingDirOverride
		).toBeUndefined();
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
		await emitShellOutput(mockSpawnTerminalTab.mock.calls[0][0].sessionId);
		expect(mockWrite).toHaveBeenCalledWith(expect.any(String), 'droid\r');
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

/**
 * Not every credential is an OAuth login, and the ones that are not fail with
 * the same `auth_expired` output. Running the provider's login command for them
 * produces a successful-looking flow that changes nothing the agent presents, so
 * the shell must never open.
 */
describe('ReauthModal credential kinds', () => {
	/** Render with `vars` as the agent's own environment layer. */
	async function renderWithEnv(vars: Record<string, string>, toolType = 'claude-code') {
		mockGetCustomEnvVars.mockResolvedValue(vars);
		const session = createMockSession({ id: 'sess-1', toolType });
		render(
			<ReauthModal
				theme={mockTheme}
				outage={createOutage({ toolType })}
				session={session}
				onClose={vi.fn()}
			/>
		);
		await flushSpawn();
	}

	it('opens the login shell for a plain OAuth agent', async () => {
		await renderWithEnv({});
		expect(mockSpawnTerminalTab).toHaveBeenCalledTimes(1);
	});

	it('does not offer a login to an agent authenticating with an API key', async () => {
		await renderWithEnv({ ANTHROPIC_API_KEY: 'sk-live-xxx' });

		expect(mockSpawnTerminalTab).not.toHaveBeenCalled();
		expect(await screen.findByText(/ANTHROPIC_API_KEY/)).toBeInTheDocument();
	});

	// The token belongs to the gateway operator, so it outranks a token check:
	// even with a key set, no provider login can repair it.
	it('names the gateway an agent is pointed at instead of offering a login', async () => {
		await renderWithEnv({
			ANTHROPIC_BASE_URL: 'https://api.z.ai/v1',
			ANTHROPIC_AUTH_TOKEN: 'gw-token',
		});

		expect(mockSpawnTerminalTab).not.toHaveBeenCalled();
		expect(await screen.findByText(/api\.z\.ai/)).toBeInTheDocument();
	});

	it('sends a Bedrock agent to its cloud credentials rather than a provider login', async () => {
		await renderWithEnv({ CLAUDE_CODE_USE_BEDROCK: '1' });

		expect(mockSpawnTerminalTab).not.toHaveBeenCalled();
		expect(await screen.findByText(/AWS Bedrock/)).toBeInTheDocument();
	});

	// A flag the user turned off must not be read as a Bedrock agent.
	it('treats a disabled cloud flag as the OAuth default', async () => {
		await renderWithEnv({ CLAUDE_CODE_USE_BEDROCK: 'false' });
		expect(mockSpawnTerminalTab).toHaveBeenCalledTimes(1);
	});

	// An emptied row is how a user turns an inherited variable off.
	it('treats a blank API key as unset', async () => {
		await renderWithEnv({ ANTHROPIC_API_KEY: '   ' });
		expect(mockSpawnTerminalTab).toHaveBeenCalledTimes(1);
	});

	it('classifies per provider rather than assuming Anthropic vars', async () => {
		await renderWithEnv({ OPENAI_API_KEY: 'sk-openai' }, 'codex');

		expect(mockSpawnTerminalTab).not.toHaveBeenCalled();
		expect(await screen.findByText(/OPENAI_API_KEY/)).toBeInTheDocument();
	});

	// Blocked or not, the agents are still stopped and their queues still held.
	it('still offers to resume the blocked agents', async () => {
		await renderWithEnv({ ANTHROPIC_API_KEY: 'sk-live-xxx' });
		expect(screen.getByTestId('reauth-resume')).toBeInTheDocument();
	});
});

/**
 * The sign-in URL is the one thing on this screen the user cannot get at by
 * hand: it is hundreds of characters, the provider TUI soft-wraps it across
 * rows, and mouse tracking eats the drag that would select it. These cover the
 * wiring rather than the matching (see `loginUrl.test.ts` for that) - the part
 * that can silently break is the accumulation across PTY chunks, since a
 * wrapped URL never arrives in one.
 */
describe('ReauthModal login URL', () => {
	let writeText: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(window.navigator, 'clipboard', {
			value: { writeText },
			configurable: true,
		});
	});

	/** Mount the dialog and return the PTY id its login shell was spawned on. */
	async function renderAndSpawn(): Promise<string> {
		const session = createMockSession({ id: 'sess-1', toolType: 'claude-code' });
		render(
			<ReauthModal
				theme={mockTheme}
				outage={createOutage({ toolType: 'claude-code' })}
				session={session}
				onClose={vi.fn()}
			/>
		);
		await flushSpawn();
		return mockSpawnTerminalTab.mock.calls[0][0].sessionId;
	}

	it('offers nothing until the provider prints a URL', async () => {
		const ptyId = await renderAndSpawn();
		await emitShellOutput(ptyId, 'Starting login...\n');

		expect(screen.queryByTestId('reauth-copy-url')).not.toBeInTheDocument();
	});

	it('copies a URL that arrived split across PTY chunks', async () => {
		const ptyId = await renderAndSpawn();

		// A real login URL is longer than the terminal is wide, so it reaches the
		// renderer as several writes with the wrap in the middle of the query.
		await emitShellOutput(ptyId, 'Open this URL:\n\n  https://claude.ai/oauth/authorize?client_id');
		await emitShellOutput(
			ptyId,
			'=9d1c&redirect_uri=http%3A%2F%2Flocal\nhost%3A45289%2Fcallback\n'
		);

		fireEvent.click(await screen.findByTestId('reauth-copy-url'));

		await waitFor(() =>
			expect(writeText).toHaveBeenCalledWith(
				'https://claude.ai/oauth/authorize?client_id=9d1c&redirect_uri=http%3A%2F%2Flocalhost%3A45289%2Fcallback'
			)
		);
	});

	// A retried login prints a fresh URL; copying the spent one fails with no
	// sign anything is wrong.
	it('follows the flow to a reissued URL', async () => {
		const ptyId = await renderAndSpawn();
		await emitShellOutput(ptyId, 'https://claude.ai/oauth/authorize?attempt=1\n');
		await emitShellOutput(
			ptyId,
			'That code expired.\nhttps://claude.ai/oauth/authorize?attempt=2\n'
		);

		fireEvent.click(screen.getByTestId('reauth-copy-url'));

		await waitFor(() =>
			expect(writeText).toHaveBeenCalledWith('https://claude.ai/oauth/authorize?attempt=2')
		);
	});

	// The login shell prints plenty of URLs that are not the sign-in link.
	it('stays hidden for output that carries no sign-in link', async () => {
		const ptyId = await renderAndSpawn();
		await emitShellOutput(ptyId, 'Docs: https://example.com/help\n');

		expect(screen.queryByTestId('reauth-copy-url')).not.toBeInTheDocument();
	});
});
describe('ReauthModal on Windows', () => {
	/** Windows agents are ALWAYS spawned as native processes - never via wsl.exe. */
	function windowsSession(overrides: Record<string, unknown> = {}) {
		platformState.current = 'win32';
		return createMockSession({ id: 'sess-1', toolType: 'claude-code', ...overrides } as never);
	}

	// A login inside WSL writes credentials to the WSL home directory, which the
	// native agent never reads: the flow would appear to succeed and fix nothing.
	it('never runs the login in WSL, because the agent is a native process', async () => {
		useSettingsStore.setState({ defaultShell: 'wsl' } as never);
		const session = windowsSession();
		render(
			<ReauthModal theme={mockTheme} outage={createOutage()} session={session} onClose={vi.fn()} />
		);
		await flushSpawn();

		expect(mockSpawnTerminalTab.mock.calls[0][0].shell).toBe('powershell');
	});

	it('honours a native Windows shell the user chose', async () => {
		useSettingsStore.setState({ defaultShell: 'pwsh' } as never);
		render(
			<ReauthModal
				theme={mockTheme}
				outage={createOutage()}
				session={windowsSession()}
				onClose={vi.fn()}
			/>
		);
		await flushSpawn();

		expect(mockSpawnTerminalTab.mock.calls[0][0].shell).toBe('pwsh');
	});

	// An SSH remote has its own shell and its own credential store, so the
	// Windows-only override must not reach across the connection.
	it('leaves the shell alone for an SSH remote agent', async () => {
		useSettingsStore.setState({ defaultShell: 'wsl' } as never);
		const session = windowsSession({
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});
		render(
			<ReauthModal theme={mockTheme} outage={createOutage()} session={session} onClose={vi.fn()} />
		);
		await flushSpawn();

		expect(mockSpawnTerminalTab.mock.calls[0][0].shell).toBe('wsl');
	});

	// PowerShell echoes a line that starts with a quoted string instead of
	// running it, so the call operator is what makes the login actually start.
	it('types a PowerShell-safe command for a path with spaces', async () => {
		useSettingsStore.setState({ defaultShell: 'powershell' } as never);
		const session = windowsSession({ customPath: 'C:\\Program Files\\Claude\\claude.exe' });
		render(
			<ReauthModal theme={mockTheme} outage={createOutage()} session={session} onClose={vi.fn()} />
		);
		await flushSpawn();
		await emitShellOutput(mockSpawnTerminalTab.mock.calls[0][0].sessionId);

		expect(mockWrite).toHaveBeenCalledWith(
			expect.any(String),
			'& "C:\\Program Files\\Claude\\claude.exe" /login\r'
		);
	});

	// ConPTY passes LF through as Ctrl+J, which PSReadLine does not treat as
	// "run this line". CR is what a real Enter key sends on every platform.
	it('submits with CR rather than LF', async () => {
		useSettingsStore.setState({ defaultShell: 'powershell' } as never);
		render(
			<ReauthModal
				theme={mockTheme}
				outage={createOutage()}
				session={windowsSession()}
				onClose={vi.fn()}
			/>
		);
		await flushSpawn();
		await emitShellOutput(mockSpawnTerminalTab.mock.calls[0][0].sessionId);

		expect(mockWrite).toHaveBeenCalledWith(expect.any(String), 'claude /login\r');
	});
});
