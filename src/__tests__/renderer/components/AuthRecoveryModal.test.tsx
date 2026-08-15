/**
 * AuthRecoveryModal - the surface that repairs one expired login.
 *
 * The load-bearing property is WHICH ACCOUNT. A modal opened for `.claude-gmail`
 * that signs into `.claude-smash` produces a successful-looking flow that fixes
 * nothing, and the user does not find out until the next prompt burns. The
 * renderer's half of that guarantee is naming the right credential on the spawn
 * request (main layers that identity's env over the base env, covered in
 * `src/__tests__/main/agents/auth/auth-login.test.ts`), so these tests assert
 * the identity key and the login-shaped run id it spawns under - never a
 * sibling's.
 *
 * The other half is the payoff: one login clears every agent on that credential,
 * and a login that did NOT work keeps the modal (and its scrollback) on screen.
 * That path runs through the REAL `verifyAuthRecovery` service against the real
 * stores, with only the bridge stubbed, because the wiring between them is what
 * this test is for.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { AuthRecoveryModal, extractLoginUrl } from '../../../renderer/components/AuthRecoveryModal';
import { openUrl } from '../../../renderer/utils/openUrl';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { useCenterFlashStore } from '../../../renderer/stores/centerFlashStore';
import { useModalStore } from '../../../renderer/stores/modalStore';
import { useProviderAuthStore } from '../../../renderer/stores/providerAuthStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { CredentialIdentity, ProviderAuthSnapshot } from '../../../shared/providerAuth';
import type { AgentError, Session } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import { mockTheme } from '../../helpers/mockTheme';

// xterm needs a layout engine and a canvas; neither exists in jsdom, and the
// terminal's own behavior is covered by XTerminal.test.ts. What matters here is
// WHICH process id it is mounted on - that id is what keeps login output off
// every agent listener - and whether it survives a failed verify.
vi.mock('../../../renderer/components/XTerminal', () => ({
	XTerminal: (props: { sessionId: string }) => (
		<div data-testid="xterm" data-session-id={props.sessionId} />
	),
}));

// The sign-in link has to leave through the app's one URL path (system browser
// or Maestro tab, per the user's setting), never a direct `shell.openExternal`.
vi.mock('../../../renderer/utils/openUrl', () => ({ openUrl: vi.fn() }));
const openUrlMock = vi.mocked(openUrl);

const HOME = '/Users/x';
const GMAIL_DIR = `${HOME}/.claude-gmail`;
const GMAIL_KEY = `claude-code::oauth::${GMAIL_DIR}::local`;
const SMASH_DIR = `${HOME}/.claude-smash`;
const SMASH_KEY = `claude-code::oauth::${SMASH_DIR}::local`;

// ============================================================================
// Fixtures
// ============================================================================

function oauthIdentity(key: string, label: string, configDir: string): CredentialIdentity {
	return {
		key,
		provider: 'claude-code',
		kind: 'oauth',
		scope: configDir,
		host: 'local',
		envVarName: 'CLAUDE_CONFIG_DIR',
		configDir,
		label,
	};
}

const gmailIdentity = oauthIdentity(GMAIL_KEY, '.claude-gmail', GMAIL_DIR);
const smashIdentity = oauthIdentity(SMASH_KEY, '.claude-smash', SMASH_DIR);

/** The same account, but living on a machine that has no browser of its own. */
const remoteIdentity: CredentialIdentity = {
	key: `claude-code::oauth::/home/me/.claude::ssh:remote-1`,
	provider: 'claude-code',
	kind: 'oauth',
	scope: '/home/me/.claude',
	host: 'ssh:remote-1',
	envVarName: 'CLAUDE_CONFIG_DIR',
	configDir: '/home/me/.claude',
	label: '.claude',
};

const apiKeyIdentity: CredentialIdentity = {
	key: 'claude-code::api-key::sha256-1a2b::local',
	provider: 'claude-code',
	kind: 'api-key',
	scope: 'sha256-1a2b',
	host: 'local',
	envVarName: 'ANTHROPIC_API_KEY',
	label: 'ANTHROPIC_API_KEY',
};

const authError = (): AgentError => ({
	type: 'auth_expired',
	message: 'Invalid API key. Please run /login',
	recoverable: true,
	agentId: 'claude-code',
	timestamp: 1,
});

const rateLimitError = (): AgentError => ({
	type: 'rate_limited',
	message: 'Slow down',
	recoverable: true,
	agentId: 'claude-code',
	timestamp: 1,
});

/** An agent on `configDir`, optionally already wearing an error. */
function makeSession(id: string, configDir: string, error?: AgentError): Session {
	return createMockSession({
		id,
		name: id,
		customEnvVars: { CLAUDE_CONFIG_DIR: configDir },
		aiTabs: [createMockAITab({ id: `${id}-tab`, ...(error ? { agentError: error } : {}) })],
		activeTabId: `${id}-tab`,
		...(error
			? {
					agentError: error,
					agentErrorTabId: `${id}-tab`,
					agentErrorPaused: true,
					state: 'error' as const,
				}
			: {}),
	});
}

const snapshotFor = (
	identity: CredentialIdentity,
	status: ProviderAuthSnapshot['status']
): ProviderAuthSnapshot => ({ identity, status, checkedAt: 1, source: 'probe' });

// ============================================================================
// Bridge
// ============================================================================

interface Bridge {
	startLogin: ReturnType<typeof vi.fn>;
	stopLogin: ReturnType<typeof vi.fn>;
	reprobe: ReturnType<typeof vi.fn>;
	clearError: ReturnType<typeof vi.fn>;
	/** Fire a PTY exit for a process id, as main's `onExit` channel would. */
	emitExit: (sessionId: string) => void;
	/** Push PTY output for a process id, as main's `onData` channel would. */
	emitData: (sessionId: string, data: string) => void;
}

let baseMaestro: unknown;

/**
 * Stub the two channels the modal owns (the login PTY, the re-probe) over the
 * globally-mocked bridge, leaving every other namespace intact.
 *
 * `probeResult` is what a re-probe writes for the requested key: a status, or
 * null for a probe that could not answer at all.
 */
function installBridge(
	options: {
		probeResult?: ProviderAuthSnapshot['status'] | null;
		startResult?: {
			started?: boolean;
			commandLine?: string;
			error?: string;
			remote?: boolean;
			remoteLabel?: string;
		};
	} = {}
): Bridge {
	const { probeResult = 'authenticated', startResult } = options;
	const exitListeners = new Set<(sessionId: string) => void>();
	const dataListeners = new Set<(sessionId: string, data: string) => void>();

	const startLogin = vi.fn(async (request: { runSessionId: string }) => ({
		runSessionId: request.runSessionId,
		started: true,
		commandLine: 'claude auth login --email me@example.com',
		...(startResult ?? {}),
	}));
	const stopLogin = vi.fn().mockResolvedValue(true);
	const reprobe = vi.fn(async (key: string) => {
		const identity = useProviderAuthStore.getState().snapshots[key]?.identity ?? gmailIdentity;
		const snapshot = probeResult ? snapshotFor(identity, probeResult) : null;
		if (snapshot) useProviderAuthStore.getState().applyChange(key, snapshot);
		return {
			identities: 1,
			probed: 1,
			skippedFresh: 0,
			skippedNotInstalled: 0,
			byStatus: {},
			snapshot,
		};
	});
	const clearError = vi.fn().mockResolvedValue(undefined);

	(window as unknown as { maestro: unknown }).maestro = {
		...(baseMaestro as Record<string, unknown>),
		providerAuth: {
			getAll: vi.fn().mockResolvedValue({}),
			onChange: () => () => {},
			reprobe,
			startLogin,
			stopLogin,
		},
		process: {
			...((baseMaestro as { process?: Record<string, unknown> })?.process ?? {}),
			onExit: (listener: (sessionId: string) => void) => {
				exitListeners.add(listener);
				return () => exitListeners.delete(listener);
			},
			onData: (listener: (sessionId: string, data: string) => void) => {
				dataListeners.add(listener);
				return () => dataListeners.delete(listener);
			},
		},
		agents: { getCustomEnvVars: vi.fn().mockResolvedValue({}) },
		fs: { homeDir: vi.fn().mockResolvedValue(HOME) },
		agentError: { clearError },
	};

	return {
		startLogin,
		stopLogin,
		reprobe,
		clearError,
		emitExit: (sessionId: string) => {
			for (const listener of Array.from(exitListeners)) listener(sessionId);
		},
		emitData: (sessionId: string, data: string) => {
			for (const listener of Array.from(dataListeners)) listener(sessionId, data);
		},
	};
}

// ============================================================================
// Render helper
// ============================================================================

interface RenderOptions {
	identity?: CredentialIdentity;
	blockedSessions?: Session[];
	onClose?: () => void;
}

async function renderModal(options: RenderOptions = {}) {
	const identity = options.identity ?? gmailIdentity;
	const onClose = options.onClose ?? vi.fn();
	let utils!: ReturnType<typeof render>;
	// The login spawn resolves on a microtask and sets state, so mount inside
	// `act` rather than leaving that update unwrapped.
	await act(async () => {
		utils = render(
			<LayerStackProvider>
				<AuthRecoveryModal
					identity={identity}
					blockedSessions={options.blockedSessions ?? []}
					theme={mockTheme}
					onClose={onClose}
				/>
			</LayerStackProvider>
		);
	});
	return { ...utils, onClose, identity };
}

const sessionById = (id: string): Session | undefined =>
	useSessionStore.getState().sessions.find((s) => s.id === id);

const terminalSessionId = (): string | null =>
	screen.getByTestId('xterm').getAttribute('data-session-id');

// ============================================================================
// Tests
// ============================================================================

describe('AuthRecoveryModal', () => {
	beforeEach(() => {
		baseMaestro = baseMaestro ?? (window as unknown as { maestro: unknown }).maestro;
		vi.clearAllMocks();
		useProviderAuthStore.getState().__resetForTests();
		useProviderAuthStore.setState({
			homeDir: HOME,
			agentEnvVars: { 'claude-code': {} },
			loaded: true,
			snapshots: {
				[GMAIL_KEY]: snapshotFor(gmailIdentity, 'logged-out'),
				[SMASH_KEY]: snapshotFor(smashIdentity, 'logged-out'),
			},
		});
		useSessionStore.setState({ sessions: [] });
		useCenterFlashStore.getState().setActive(null);
		useModalStore.setState({ modals: new Map() });
	});

	afterEach(() => {
		cleanup();
	});

	describe('spawning the login', () => {
		it('spawns for the account on screen and never for a sibling account', async () => {
			const bridge = installBridge();

			// The modal is opened for `.claude-smash` while `.claude-gmail` is the
			// account that happens to be everywhere else in the store.
			await renderModal({ identity: smashIdentity });

			expect(bridge.startLogin).toHaveBeenCalledTimes(1);
			const request = bridge.startLogin.mock.calls[0][0];
			expect(request.identityKey).toBe(SMASH_KEY);
			// The env itself is layered in main from THIS key; the renderer's job is
			// to never hand over the wrong one.
			expect(request.identityKey).not.toBe(GMAIL_KEY);
			expect(request.runSessionId).toContain('claude-smash');
			expect(request.runSessionId).not.toContain('claude-gmail');
		});

		it('mounts the terminal on the login run id, inside the modal body', async () => {
			const bridge = installBridge();
			const { container } = await renderModal();

			const runSessionId = bridge.startLogin.mock.calls[0][0].runSessionId;
			// A login-shaped id matches no agent listener, which is what keeps the
			// login's output out of every agent transcript.
			expect(runSessionId.startsWith('auth-login-')).toBe(true);
			expect(terminalSessionId()).toBe(runSessionId);

			// jsdom has no layout engine, so assert STRUCTURE: the terminal lives in
			// the sized box rather than merely existing somewhere in the document.
			const box = container.querySelector('[data-testid="auth-recovery-terminal"]');
			expect(box).not.toBeNull();
			expect(box!.contains(screen.getByTestId('xterm'))).toBe(true);
		});

		it('says so when the login command could not be started', async () => {
			// A terminal that stayed black because nothing spawned is
			// indistinguishable from one that is thinking.
			installBridge({ startResult: { started: false, error: 'claude is not installed' } });
			await renderModal();

			expect(screen.getByTestId('auth-recovery-spawn-error').textContent).toContain(
				'claude is not installed'
			);
		});

		it('reveals the command main actually ran, not a locally guessed one', async () => {
			installBridge();
			await renderModal();

			fireEvent.click(screen.getByTestId('auth-recovery-reveal-command'));

			const reveal = screen.getByTestId('auth-recovery-command');
			expect(reveal.textContent).toContain('claude auth login --email me@example.com');
			// The account's own directory, so a user who copies the line into their
			// own terminal cannot sign in to the default account by accident.
			expect(reveal.textContent).toContain(GMAIL_DIR);
		});
	});

	describe('logging into an SSH remote', () => {
		/** Start a remote login and hand back its process id. */
		async function renderRemote(startResult?: { remoteLabel?: string }) {
			const bridge = installBridge({
				startResult: { remote: true, remoteLabel: 'dev-box (me@10.0.0.5)', ...(startResult ?? {}) },
			});
			await renderModal({ identity: remoteIdentity });
			return { bridge, runSessionId: bridge.startLogin.mock.calls[0][0].runSessionId as string };
		}

		it('says which machine is being signed into, and where the browser step happens', async () => {
			await renderRemote();

			const note = screen.getByTestId('auth-recovery-remote-note').textContent ?? '';
			// The remote's own name, not the `remote-1` id buried in the identity key.
			expect(note).toContain('dev-box (me@10.0.0.5)');
			expect(note).toContain('browser step happens on this machine');
		});

		it('falls back to the remote id until main names the machine', async () => {
			// A spawn result that carried no label (an older main, a remote deleted
			// from Settings) must still not pretend the login is local.
			installBridge({ startResult: { remote: true } });
			await renderModal({ identity: remoteIdentity });

			expect(screen.getByTestId('auth-recovery-remote-note').textContent).toContain('remote-1');
		});

		it('says nothing about a remote for a local account', async () => {
			installBridge();
			await renderModal();

			expect(screen.queryByTestId('auth-recovery-remote-note')).not.toBeInTheDocument();
		});

		it('turns the printed sign-in URL into a click that opens it here', async () => {
			const { bridge, runSessionId } = await renderRemote();

			await act(async () => {
				bridge.emitData(
					runSessionId,
					'\x1b[32mBrowser did not open.\x1b[0m Visit https://claude.ai/oauth/authorize?code=abc123 to continue.\r\n'
				);
			});

			const panel = screen.getByTestId('auth-recovery-login-url');
			expect(panel.textContent).toContain('https://claude.ai/oauth/authorize?code=abc123');
			// The trailing period of the sentence is not part of the URL.
			expect(panel.textContent).not.toContain('abc123.');

			fireEvent.click(screen.getByTestId('auth-recovery-open-url'));
			// Through the app's URL path, so the user's system-vs-Maestro browser
			// setting still decides where it lands.
			expect(openUrlMock).toHaveBeenCalledWith(
				'https://claude.ai/oauth/authorize?code=abc123',
				expect.objectContaining({ ctrlKey: false })
			);
		});

		it('ignores output from a process that is not this login', async () => {
			const { bridge } = await renderRemote();

			await act(async () => {
				bridge.emitData('some-agent-session', 'Visit https://evil.example/nope now\r\n');
			});

			expect(screen.queryByTestId('auth-recovery-login-url')).not.toBeInTheDocument();
		});

		it('finds a URL that arrived split across two PTY chunks', async () => {
			const { bridge, runSessionId } = await renderRemote();

			await act(async () => {
				bridge.emitData(runSessionId, 'Open https://claude.ai/oauth/auth');
				bridge.emitData(runSessionId, 'orize?code=split-in-half\r\n');
			});

			expect(screen.getByTestId('auth-recovery-login-url').textContent).toContain(
				'https://claude.ai/oauth/authorize?code=split-in-half'
			);
		});

		it('drops the stale URL when the login is re-run', async () => {
			const { bridge, runSessionId } = await renderRemote();
			await act(async () => {
				bridge.emitData(runSessionId, 'Visit https://claude.ai/oauth/authorize?code=first\r\n');
			});
			expect(screen.getByTestId('auth-recovery-login-url')).toBeInTheDocument();

			await act(async () => {
				fireEvent.click(screen.getByTestId('auth-recovery-rerun'));
			});

			// That URL's flow died with the killed PTY, so offering it would send the
			// user through a sign-in that lands nowhere.
			expect(screen.queryByTestId('auth-recovery-login-url')).not.toBeInTheDocument();
		});

		it('offers the command to run on the remote when no URL ever appears', async () => {
			vi.useFakeTimers();
			try {
				const { bridge, runSessionId } = await renderRemote();
				expect(screen.queryByTestId('auth-recovery-remote-no-url')).not.toBeInTheDocument();

				await act(async () => {
					vi.advanceTimersByTime(30_000);
				});

				// A remote with no browser leaves the CLI waiting on something that will
				// never happen; the user needs a way out, not a hung terminal.
				const panel = screen.getByTestId('auth-recovery-remote-no-url');
				expect(panel.textContent).toContain('dev-box (me@10.0.0.5)');
				expect(panel.textContent).toContain('claude auth login --email me@example.com');
				expect(screen.getByTestId('auth-recovery-remote-copy-command')).toBeInTheDocument();

				// ...and it withdraws the moment the URL does show up.
				await act(async () => {
					bridge.emitData(runSessionId, 'Visit https://claude.ai/oauth/authorize?code=late\r\n');
				});
				expect(screen.queryByTestId('auth-recovery-remote-no-url')).not.toBeInTheDocument();
			} finally {
				vi.useRealTimers();
			}
		});

		it('leaves a local login alone when it prints no URL', async () => {
			vi.useFakeTimers();
			try {
				installBridge();
				await renderModal();

				await act(async () => {
					vi.advanceTimersByTime(30_000);
				});

				// A local login opens its own browser; nagging about a missing link
				// would be noise.
				expect(screen.queryByTestId('auth-recovery-remote-no-url')).not.toBeInTheDocument();
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe('extractLoginUrl', () => {
		it('returns the last URL, unwrapped from color codes and punctuation', () => {
			expect(
				extractLoginUrl(
					'docs at https://docs.example/help\r\nGo to \x1b[4mhttps://auth.example/x?y=1\x1b[0m.'
				)
			).toBe('https://auth.example/x?y=1');
		});

		it('answers null rather than guessing when there is no URL', () => {
			expect(extractLoginUrl('Waiting for the browser...')).toBeNull();
			expect(extractLoginUrl('')).toBeNull();
		});
	});

	describe('credentials no login can repair', () => {
		it('renders guidance instead of a terminal for an api-key credential', async () => {
			const bridge = installBridge();
			await renderModal({ identity: apiKeyIdentity });

			expect(screen.queryByTestId('xterm')).not.toBeInTheDocument();
			expect(screen.queryByTestId('auth-recovery-terminal')).not.toBeInTheDocument();
			expect(bridge.startLogin).not.toHaveBeenCalled();

			const guidance = screen.getByTestId('auth-recovery-guidance');
			expect(guidance.textContent).toContain('ANTHROPIC_API_KEY');
			expect(guidance.textContent).toContain('signing in cannot repair it');
			// Nothing to re-run, so the control that would re-run it is not offered.
			expect(screen.queryByTestId('auth-recovery-rerun')).not.toBeInTheDocument();
		});

		it('renders guidance for an oauth provider with no known login command', async () => {
			const bridge = installBridge();
			await renderModal({
				identity: {
					key: 'factory-droid::oauth::default::local',
					provider: 'factory-droid',
					kind: 'oauth',
					scope: 'default',
					host: 'local',
					label: 'default',
				},
			});

			expect(bridge.startLogin).not.toHaveBeenCalled();
			expect(screen.getByTestId('auth-recovery-guidance').textContent).toContain(
				'No sign-in flow is known for this credential'
			);
		});
	});

	describe('verifying the login', () => {
		beforeEach(() => {
			useSessionStore.setState({
				sessions: [
					makeSession('a', GMAIL_DIR, authError()),
					makeSession('b', GMAIL_DIR, authError()),
					makeSession('sibling', SMASH_DIR, authError()),
					makeSession('rate-limited', GMAIL_DIR, rateLimitError()),
				],
			});
		});

		it('clears the error on EVERY agent on the identity and closes', async () => {
			const bridge = installBridge({ probeResult: 'authenticated' });
			const { onClose } = await renderModal({
				blockedSessions: [sessionById('a')!, sessionById('b')!],
			});

			await act(async () => {
				fireEvent.click(screen.getByTestId('auth-recovery-verify'));
			});

			expect(bridge.reprobe).toHaveBeenCalledWith(GMAIL_KEY, { source: 'login-flow' });
			for (const id of ['a', 'b']) {
				expect(sessionById(id)?.agentError).toBeUndefined();
				expect(sessionById(id)?.aiTabs[0].agentError).toBeUndefined();
			}
			// A sibling account was never signed in, and a rate limit is still true.
			expect(sessionById('sibling')?.agentError?.type).toBe('auth_expired');
			expect(sessionById('rate-limited')?.agentError?.type).toBe('rate_limited');
			expect(useCenterFlashStore.getState().active?.color).toBe('green');
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('verifies on PTY exit too, since some CLIs finish without the button', async () => {
			const bridge = installBridge({ probeResult: 'authenticated' });
			await renderModal();

			await act(async () => {
				bridge.emitExit(bridge.startLogin.mock.calls[0][0].runSessionId);
			});

			expect(bridge.reprobe).toHaveBeenCalledWith(GMAIL_KEY, { source: 'login-flow' });
			expect(sessionById('a')?.agentError).toBeUndefined();
		});

		it('keeps the modal and the scrollback when the account is still logged out', async () => {
			const bridge = installBridge({ probeResult: 'logged-out' });
			const { onClose } = await renderModal();
			const runSessionId = bridge.startLogin.mock.calls[0][0].runSessionId;

			await act(async () => {
				fireEvent.click(screen.getByTestId('auth-recovery-verify'));
			});

			// Closing on failure would hide the evidence the user has to read.
			expect(onClose).not.toHaveBeenCalled();
			expect(screen.getByTestId('auth-recovery-status').getAttribute('data-verify-phase')).toBe(
				'logged-out'
			);
			// Same terminal instance and same live PTY: the scrollback the CLI wrote
			// is still on screen.
			expect(terminalSessionId()).toBe(runSessionId);
			expect(bridge.stopLogin).not.toHaveBeenCalled();
			expect(sessionById('a')?.agentError?.type).toBe('auth_expired');
		});

		it('says it could not confirm rather than claiming success', async () => {
			installBridge({ probeResult: null });
			const { onClose } = await renderModal();

			await act(async () => {
				fireEvent.click(screen.getByTestId('auth-recovery-verify'));
			});

			expect(screen.getByTestId('auth-recovery-status').getAttribute('data-verify-phase')).toBe(
				'unknown'
			);
			expect(screen.getByTestId('auth-recovery-status').textContent).toContain('Could not confirm');
			expect(onClose).not.toHaveBeenCalled();
			expect(sessionById('a')?.agentError?.type).toBe('auth_expired');
		});
	});

	describe('owning the PTY', () => {
		it('kills the login when the modal closes', async () => {
			const bridge = installBridge();
			const { unmount } = await renderModal();
			const runSessionId = bridge.startLogin.mock.calls[0][0].runSessionId;

			unmount();

			// A closed modal must not leave a live PTY (and a half-finished OAuth
			// flow) behind.
			expect(bridge.stopLogin).toHaveBeenCalledWith(runSessionId);
		});

		it('replaces the PTY on re-run rather than reusing it', async () => {
			const bridge = installBridge();
			await renderModal();
			const first = bridge.startLogin.mock.calls[0][0].runSessionId;

			await act(async () => {
				fireEvent.click(screen.getByTestId('auth-recovery-rerun'));
			});

			expect(bridge.stopLogin).toHaveBeenCalledWith(first);
			expect(bridge.startLogin).toHaveBeenCalledTimes(2);
			const second = bridge.startLogin.mock.calls[1][0].runSessionId;
			expect(second).not.toBe(first);
			// A new run id means a new terminal instance, so the aborted flow's
			// output cannot be mistaken for the new one's.
			expect(terminalSessionId()).toBe(second);
		});
	});

	describe('exits', () => {
		it('closes through the same handler from the ESC pill and from Escape', async () => {
			installBridge();
			const { onClose } = await renderModal();

			const pill = screen.getByTestId('auth-recovery-esc');
			// A real button, not the inert `<div>` the pill used to be copy-pasted as.
			expect(pill.tagName).toBe('BUTTON');
			fireEvent.click(pill);
			expect(onClose).toHaveBeenCalledTimes(1);

			// Escape goes through the layer stack the Modal registered with, so this
			// only fires if the registration carries the same callback.
			await act(async () => {
				fireEvent.keyDown(window, { key: 'Escape' });
			});
			expect(onClose).toHaveBeenCalledTimes(2);
		});

		it('unregisters its layer on unmount so the layer below takes Escape back', async () => {
			installBridge();
			const { onClose, unmount } = await renderModal();

			unmount();
			await act(async () => {
				fireEvent.keyDown(window, { key: 'Escape' });
			});

			expect(onClose).not.toHaveBeenCalled();
		});
	});

	describe('header', () => {
		it('names the account and how many agents the login unblocks', async () => {
			installBridge();
			await renderModal({
				blockedSessions: [makeSession('a', GMAIL_DIR), makeSession('b', GMAIL_DIR)],
			});

			// The account's own directory name, at all times: signing into the wrong
			// one looks like success and fixes nothing.
			expect(screen.getByText(/\.claude-gmail/)).toBeInTheDocument();
			expect(screen.getByText(/Unblocks 2 agents/)).toBeInTheDocument();
			expect(screen.getByText(/browser sign-in/)).toBeInTheDocument();
		});

		it('names the single agent it unblocks', async () => {
			installBridge();
			await renderModal({ blockedSessions: [makeSession('solo', GMAIL_DIR)] });

			expect(screen.getByText(/Unblocks 1 agent: solo/)).toBeInTheDocument();
		});
	});
});
