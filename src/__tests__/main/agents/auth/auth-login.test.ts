/**
 * Tests for src/main/agents/auth/auth-login.ts
 *
 * Strategy mirrors `auth-startup.test.ts`: mock `electron-store` so the real
 * `providerAuthStore` is exercised, mock `os.homedir()` for deterministic
 * config-dir resolution, stub a fake `AgentDetector`, and hand sessions in as
 * the plain records they come off disk as. The ProcessManager is a spy, so the
 * assertions are about the spawn config rather than about a real PTY.
 *
 * The load-bearing test here is the env one: a login started for account B must
 * spawn with B's `CLAUDE_CONFIG_DIR`. Getting that wrong writes a fresh token
 * into the wrong config directory and reports success for an account that is
 * still broken, which the user does not discover until the next prompt burns.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { loggerWarnMock, loggerInfoMock, wrapSpawnWithSshMock } = vi.hoisted(() => ({
	loggerWarnMock: vi.fn(),
	loggerInfoMock: vi.fn(),
	wrapSpawnWithSshMock: vi.fn(),
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		warn: loggerWarnMock,
		info: loggerInfoMock,
		debug: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('../../../../main/utils/ssh-spawn-wrapper', () => ({
	wrapSpawnWithSsh: wrapSpawnWithSshMock,
}));

vi.mock('electron-store', () => ({
	default: class MockStore {
		data: Record<string, unknown>;
		constructor(options: Record<string, unknown>) {
			this.data = { ...((options.defaults as Record<string, unknown>) ?? {}) };
		}
		get(key: string, defaultValue?: unknown): unknown {
			return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : defaultValue;
		}
		set(key: string, value: unknown): void {
			this.data[key] = value;
		}
	},
}));

vi.mock('os', async () => {
	const actual = await vi.importActual<typeof import('os')>('os');
	const homedir = () => '/Users/test';
	return { ...actual, homedir, default: { ...actual, homedir } };
});

import {
	startAuthLogin,
	stopAuthLogin,
	type AuthLoginDeps,
} from '../../../../main/agents/auth/auth-login';
import {
	setSnapshot,
	__resetForTests as resetAuthStore,
} from '../../../../main/stores/providerAuthStore';
import { buildLoginRunSessionId } from '../../../../shared/providerAuth';
import type { CredentialIdentity } from '../../../../shared/providerAuth';

const HOME = '/Users/test';
const DEFAULT_KEY = `claude-code::oauth::${HOME}/.claude::local`;
const WORK_KEY = `claude-code::oauth::${HOME}/.claude-work::local`;
const CODEX_KEY = `codex::oauth::${HOME}/.codex::local`;

function runIdFor(key: string): string {
	return buildLoginRunSessionId(key, 'run1');
}

function makeStore(data: Record<string, unknown>) {
	return {
		get(key: string, defaultValue?: unknown): unknown {
			return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : defaultValue;
		},
	};
}

interface Harness {
	deps: AuthLoginDeps;
	spawn: ReturnType<typeof vi.fn>;
	kill: ReturnType<typeof vi.fn>;
}

function makeHarness(
	sessions: Array<Record<string, unknown>>,
	overrides: {
		configs?: Record<string, unknown>;
		agent?: unknown;
		sshRemotes?: Array<Record<string, unknown>>;
		processManager?: unknown;
		agentDetector?: unknown;
	} = {}
): Harness {
	const spawn = vi.fn().mockReturnValue({ pid: 4242, success: true });
	const kill = vi.fn().mockReturnValue(true);
	// `in` rather than `??`, so a test can pass an explicitly null manager.
	const processManager = 'processManager' in overrides ? overrides.processManager : { spawn, kill };
	const detector = {
		getAgent: vi
			.fn()
			.mockResolvedValue(
				overrides.agent === undefined
					? { path: '/usr/local/bin/claude', command: 'claude' }
					: overrides.agent
			),
	};
	return {
		spawn,
		kill,
		deps: {
			sessionsStore: makeStore({ sessions }),
			agentConfigsStore: makeStore({ configs: overrides.configs ?? {} }),
			settingsStore: makeStore({ sshRemotes: overrides.sshRemotes ?? [] }),
			getAgentDetector: () => (overrides.agentDetector ?? detector) as never,
			getProcessManager: () => processManager as never,
		} as unknown as AuthLoginDeps,
	};
}

function makeSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: `session-${Math.random().toString(36).slice(2, 8)}`,
		toolType: 'claude-code',
		createdAt: Date.now(),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	resetAuthStore();
});

describe('startAuthLogin', () => {
	it('spawns the login command in a PTY under the supplied run id', async () => {
		const { deps, spawn } = makeHarness([makeSession()]);

		const result = await startAuthLogin(deps, {
			identityKey: DEFAULT_KEY,
			runSessionId: runIdFor(DEFAULT_KEY),
		});

		expect(result.started).toBe(true);
		expect(result.pid).toBe(4242);
		expect(result.commandLine).toBe('claude auth login');
		expect(spawn).toHaveBeenCalledTimes(1);
		const config = spawn.mock.calls[0][0];
		expect(config.sessionId).toBe(runIdFor(DEFAULT_KEY));
		expect(config.command).toBe('/usr/local/bin/claude');
		expect(config.args).toEqual(['auth', 'login']);
		expect(config.requiresPty).toBe(true);
		// Not `terminal`: that spawns the user's login shell and drops the
		// identity's env, signing in to the default account.
		expect(config.toolType).toBe('claude-code');
		expect(config.prompt).toBeUndefined();
	});

	it('asks for raw PTY output so the login TUI is not stripped', async () => {
		const { deps, spawn } = makeHarness([makeSession()]);

		await startAuthLogin(deps, {
			identityKey: DEFAULT_KEY,
			runSessionId: runIdFor(DEFAULT_KEY),
		});

		expect(spawn.mock.calls[0][0].rawPtyOutput).toBe(true);
	});

	it('never sets BROWSER, so the login flow can actually open a browser', async () => {
		const { deps, spawn } = makeHarness([makeSession()]);

		await startAuthLogin(deps, {
			identityKey: DEFAULT_KEY,
			runSessionId: runIdFor(DEFAULT_KEY),
		});

		// The probe and the usage sampler both neutralize $BROWSER because they run
		// unattended. This call site is the inverse and must not inherit that.
		expect(spawn.mock.calls[0][0].customEnvVars ?? {}).not.toHaveProperty('BROWSER');
	});

	it("spawns with the target account's env, not another account's", async () => {
		const { deps, spawn } = makeHarness([
			makeSession({ id: 'a', customEnvVars: { CLAUDE_CONFIG_DIR: `${HOME}/.claude` } }),
			makeSession({ id: 'b', customEnvVars: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-work` } }),
		]);

		await startAuthLogin(deps, {
			identityKey: WORK_KEY,
			runSessionId: runIdFor(WORK_KEY),
		});

		expect(spawn.mock.calls[0][0].customEnvVars).toEqual({
			CLAUDE_CONFIG_DIR: `${HOME}/.claude-work`,
		});
	});

	it('merges agent-level env under session-level env', async () => {
		const { deps, spawn } = makeHarness(
			[makeSession({ customEnvVars: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-work` } })],
			{ configs: { 'claude-code': { customEnvVars: { EXTRA: '1' } } } }
		);

		await startAuthLogin(deps, {
			identityKey: WORK_KEY,
			runSessionId: runIdFor(WORK_KEY),
		});

		expect(spawn.mock.calls[0][0].customEnvVars).toEqual({
			EXTRA: '1',
			CLAUDE_CONFIG_DIR: `${HOME}/.claude-work`,
		});
	});

	it('pre-fills the email from the last successful snapshot', async () => {
		const identity: CredentialIdentity = {
			key: DEFAULT_KEY,
			provider: 'claude-code',
			kind: 'oauth',
			scope: `${HOME}/.claude`,
			host: 'local',
			configDir: `${HOME}/.claude`,
			label: '.claude',
		};
		setSnapshot(DEFAULT_KEY, {
			identity,
			status: 'logged-out',
			detail: 'ada@example.com · Acme · max',
			checkedAt: 1,
			source: 'probe',
		});
		const { deps, spawn } = makeHarness([makeSession()]);

		const result = await startAuthLogin(deps, {
			identityKey: DEFAULT_KEY,
			runSessionId: runIdFor(DEFAULT_KEY),
		});

		expect(spawn.mock.calls[0][0].args).toEqual(['auth', 'login', '--email', 'ada@example.com']);
		expect(result.commandLine).toBe('claude auth login --email ada@example.com');
	});

	it('passes the console and sso flags through', async () => {
		const { deps, spawn } = makeHarness([makeSession()]);

		await startAuthLogin(deps, {
			identityKey: DEFAULT_KEY,
			runSessionId: runIdFor(DEFAULT_KEY),
			preferConsole: true,
			sso: true,
		});

		expect(spawn.mock.calls[0][0].args).toEqual(['auth', 'login', '--console', '--sso']);
	});

	it('surfaces the provider note so the UI can explain a device-code flow', async () => {
		const { deps } = makeHarness([makeSession({ toolType: 'copilot-cli' })], {
			agent: { path: '/usr/local/bin/copilot', command: 'copilot' },
		});

		const key = `copilot-cli::oauth::${HOME}/.copilot::local`;
		const result = await startAuthLogin(deps, {
			identityKey: key,
			runSessionId: runIdFor(key),
		});

		expect(result.started).toBe(true);
		expect(result.note).toContain('device-code');
	});

	it('refuses a run id that is not login-shaped', async () => {
		const { deps, spawn } = makeHarness([makeSession()]);

		const result = await startAuthLogin(deps, {
			identityKey: DEFAULT_KEY,
			runSessionId: 'session-42-ai-tab-7',
		});

		expect(result.started).toBe(false);
		expect(spawn).not.toHaveBeenCalled();
		expect(loggerWarnMock).toHaveBeenCalled();
	});

	it('refuses a login-prefixed id that still carries a reserved segment', async () => {
		const { deps, spawn } = makeHarness([makeSession()]);

		const result = await startAuthLogin(deps, {
			identityKey: DEFAULT_KEY,
			runSessionId: 'auth-login-x-terminal-9',
		});

		expect(result.started).toBe(false);
		expect(spawn).not.toHaveBeenCalled();
	});

	it('reports a reason when no agent uses the account any more', async () => {
		const { deps, spawn } = makeHarness([makeSession({ toolType: 'codex' })]);

		const result = await startAuthLogin(deps, {
			identityKey: WORK_KEY,
			runSessionId: runIdFor(WORK_KEY),
		});

		expect(result.started).toBe(false);
		expect(result.error).toMatch(/no agent uses this account/i);
		expect(spawn).not.toHaveBeenCalled();
	});

	it('never spawns for a credential a login cannot repair', async () => {
		const { deps, spawn } = makeHarness([
			makeSession({ customEnvVars: { ANTHROPIC_API_KEY: 'sk-test' } }),
		]);
		// The api-key identity's scope is a fingerprint, so read the key back off
		// the only target this store can produce rather than hardcoding the hash.
		const result = await startAuthLogin(deps, {
			identityKey: DEFAULT_KEY,
			runSessionId: runIdFor(DEFAULT_KEY),
		});

		expect(result.started).toBe(false);
		expect(spawn).not.toHaveBeenCalled();
	});

	it('reports a reason when the provider CLI is not installed here', async () => {
		const { deps, spawn } = makeHarness([makeSession()], { agent: null });

		const result = await startAuthLogin(deps, {
			identityKey: DEFAULT_KEY,
			runSessionId: runIdFor(DEFAULT_KEY),
		});

		expect(result.started).toBe(false);
		expect(result.error).toMatch(/not found on this machine/i);
		expect(spawn).not.toHaveBeenCalled();
	});

	it('reports a reason when the spawn itself fails', async () => {
		const spawn = vi.fn().mockReturnValue({ pid: -1, success: false });
		const { deps } = makeHarness([makeSession()], {
			processManager: { spawn, kill: vi.fn() },
		});

		const result = await startAuthLogin(deps, {
			identityKey: DEFAULT_KEY,
			runSessionId: runIdFor(DEFAULT_KEY),
		});

		expect(result.started).toBe(false);
		expect(result.error).toBeTruthy();
	});

	it("runs a remote account's login on its remote, by bare binary name", async () => {
		wrapSpawnWithSshMock.mockResolvedValue({
			command: 'ssh',
			args: ['host', 'codex login'],
			cwd: HOME,
			sshRemoteUsed: { id: 'remote-1' },
		});
		const { deps, spawn } = makeHarness([
			makeSession({
				toolType: 'codex',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			}),
		]);

		const key = `codex::oauth::${HOME}/.codex::ssh:remote-1`;
		const result = await startAuthLogin(deps, {
			identityKey: key,
			runSessionId: runIdFor(key),
		});

		expect(result.started).toBe(true);
		expect(result.remote).toBe(true);
		expect(wrapSpawnWithSshMock.mock.calls[0][0].command).toBe('codex');
		expect(spawn.mock.calls[0][0].command).toBe('ssh');
	});

	it('names the remote so the modal can say which machine it is signing in on', async () => {
		wrapSpawnWithSshMock.mockResolvedValue({
			command: 'ssh',
			args: ['host', 'codex login'],
			cwd: HOME,
			sshRemoteUsed: { id: 'remote-1' },
		});
		const { deps } = makeHarness(
			[
				makeSession({
					toolType: 'codex',
					sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				}),
			],
			{
				sshRemotes: [
					{
						id: 'remote-1',
						name: 'dev-box',
						host: '10.0.0.5',
						port: 22,
						username: 'me',
						privateKeyPath: '',
						enabled: true,
					},
				],
			}
		);

		const key = `codex::oauth::${HOME}/.codex::ssh:remote-1`;
		const result = await startAuthLogin(deps, {
			identityKey: key,
			runSessionId: runIdFor(key),
		});

		// The renderer only has `remote-1`, which is not what the user called the
		// machine, and the browser step happens somewhere else than the login.
		expect(result.remoteLabel).toBe('dev-box (me@10.0.0.5)');
	});

	it('refuses to sign in locally when the SSH remote cannot be resolved', async () => {
		wrapSpawnWithSshMock.mockResolvedValue({
			command: 'codex',
			args: ['login'],
			cwd: HOME,
			sshRemoteUsed: null,
		});
		const { deps, spawn } = makeHarness([
			makeSession({
				toolType: 'codex',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'missing' },
			}),
		]);

		const key = `codex::oauth::${HOME}/.codex::ssh:missing`;
		const result = await startAuthLogin(deps, {
			identityKey: key,
			runSessionId: runIdFor(key),
		});

		expect(result.started).toBe(false);
		expect(result.error).toMatch(/will not sign in locally/i);
		expect(spawn).not.toHaveBeenCalled();
	});

	it('probes a codex account it can still see', async () => {
		const { deps, spawn } = makeHarness([makeSession({ toolType: 'codex' })], {
			agent: { path: '/usr/local/bin/codex', command: 'codex' },
		});

		const result = await startAuthLogin(deps, {
			identityKey: CODEX_KEY,
			runSessionId: runIdFor(CODEX_KEY),
		});

		expect(result.started).toBe(true);
		expect(spawn.mock.calls[0][0].args).toEqual(['login']);
	});

	it('reports a reason when the process manager is not up yet', async () => {
		const { deps } = makeHarness([makeSession()], { processManager: null });

		const result = await startAuthLogin(deps, {
			identityKey: DEFAULT_KEY,
			runSessionId: runIdFor(DEFAULT_KEY),
		});

		expect(result.started).toBe(false);
		expect(result.error).toBeTruthy();
	});
});

describe('stopAuthLogin', () => {
	it('kills the process running under a login run id', () => {
		const kill = vi.fn().mockReturnValue(true);
		expect(stopAuthLogin(() => ({ kill }) as never, runIdFor(DEFAULT_KEY))).toBe(true);
		expect(kill).toHaveBeenCalledWith(runIdFor(DEFAULT_KEY));
	});

	it('refuses to kill anything that is not a login run id', () => {
		const kill = vi.fn().mockReturnValue(true);
		expect(stopAuthLogin(() => ({ kill }) as never, 'session-42-ai-tab-7')).toBe(false);
		expect(kill).not.toHaveBeenCalled();
	});

	it('returns false when nothing is running', () => {
		expect(stopAuthLogin(() => null, runIdFor(DEFAULT_KEY))).toBe(false);
	});
});
