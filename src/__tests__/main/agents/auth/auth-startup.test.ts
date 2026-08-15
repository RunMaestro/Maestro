/**
 * Tests for src/main/agents/auth/auth-startup.ts
 *
 * Strategy: mock `auth-probe.ts` so each probe's result can be driven directly
 * (and, more importantly, so the CALL COUNT is observable), mock
 * `electron-store` so the real `providerAuthStore` is exercised end to end,
 * mock `os.homedir()` for deterministic config-dir resolution, and stub a fake
 * `AgentDetector`. Sessions go in as plain records, the way they come off disk.
 *
 * The load-bearing test in this file is the dedup one: ten stored sessions on
 * two accounts must produce exactly two probes. Everything else in the phase is
 * an optimization on top of that, and a regression there turns one spawn per
 * account back into one spawn per agent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { probeCredentialMock, loggerWarnMock, loggerInfoMock, loggerDebugMock } = vi.hoisted(() => ({
	probeCredentialMock: vi.fn(),
	loggerWarnMock: vi.fn(),
	loggerInfoMock: vi.fn(),
	loggerDebugMock: vi.fn(),
}));

vi.mock('../../../../main/agents/auth/auth-probe', () => ({
	probeCredential: probeCredentialMock,
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		warn: loggerWarnMock,
		info: loggerInfoMock,
		debug: loggerDebugMock,
		error: vi.fn(),
	},
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
	runStartupAuthProbe,
	AUTH_STARTUP_SESSION_WINDOW_MS,
	type StartupAuthProbeDeps,
} from '../../../../main/agents/auth/auth-startup';
import {
	getSnapshot,
	setSnapshot,
	PROBE_STALE_MS,
	__resetForTests as resetAuthStore,
} from '../../../../main/stores/providerAuthStore';
import type { CredentialIdentity, ProviderAuthSnapshot } from '../../../../shared/providerAuth';

const FROZEN_NOW = new Date('2026-08-15T12:00:00.000Z').getTime();
const HOME = '/Users/test';
const DEFAULT_CLAUDE_KEY = `claude-code::oauth::${HOME}/.claude::local`;
const WORK_CLAUDE_KEY = `claude-code::oauth::${HOME}/.claude-work::local`;

/** A stored session, shaped the way it comes off `maestro-sessions.json`. */
function makeSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: `session-${Math.random().toString(36).slice(2, 8)}`,
		toolType: 'claude-code',
		createdAt: FROZEN_NOW - 60_000,
		...overrides,
	};
}

function makeStore(data: Record<string, unknown>) {
	return {
		get(key: string, defaultValue?: unknown): unknown {
			return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : defaultValue;
		},
	};
}

function makeDeps(
	sessions: Array<Record<string, unknown>>,
	overrides: Partial<StartupAuthProbeDeps> & {
		configs?: Record<string, unknown>;
		agent?: unknown;
		sshRemotes?: Array<Record<string, unknown>>;
	} = {}
): StartupAuthProbeDeps {
	const { configs, agent, sshRemotes, ...rest } = overrides;
	return {
		sessionsStore: makeStore({ sessions }),
		agentConfigsStore: makeStore({ configs: configs ?? {} }),
		settingsStore: makeStore({ sshRemotes: sshRemotes ?? [] }),
		agentDetector: {
			getAgent: vi
				.fn()
				.mockResolvedValue(
					agent === undefined ? { path: '/usr/local/bin/claude', command: 'claude' } : agent
				),
		},
		now: () => FROZEN_NOW,
		...rest,
	} as unknown as StartupAuthProbeDeps;
}

function makeSnapshot(
	identity: CredentialIdentity,
	overrides: Partial<ProviderAuthSnapshot> = {}
): ProviderAuthSnapshot {
	return {
		identity,
		status: 'authenticated',
		checkedAt: FROZEN_NOW,
		source: 'probe',
		...overrides,
	};
}

/** Identity keys the probe mock was called with, in call order. */
function probedKeys(): string[] {
	return probeCredentialMock.mock.calls.map((call) => (call[0] as CredentialIdentity).key);
}

describe('runStartupAuthProbe', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetAuthStore();
		probeCredentialMock.mockImplementation(async (identity: CredentialIdentity) =>
			makeSnapshot(identity)
		);
	});

	// ========================================================================
	// Dedup - the whole point of the phase
	// ========================================================================

	it('probes each unique identity exactly once across ten sessions on two accounts', async () => {
		const sessions = [
			...Array.from({ length: 5 }, () => makeSession()),
			...Array.from({ length: 5 }, () =>
				makeSession({ customEnvVars: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-work` } })
			),
		];

		const result = await runStartupAuthProbe(makeDeps(sessions));

		expect(probeCredentialMock).toHaveBeenCalledTimes(2);
		expect(probedKeys().sort()).toEqual([WORK_CLAUDE_KEY, DEFAULT_CLAUDE_KEY].sort());
		expect(result).toMatchObject({ identities: 2, probed: 2, byStatus: { authenticated: 2 } });
	});

	it('keeps two providers on the same host as two identities', async () => {
		const sessions = [makeSession(), makeSession({ toolType: 'codex' })];

		await runStartupAuthProbe(makeDeps(sessions));

		expect(probedKeys().sort()).toEqual(
			[DEFAULT_CLAUDE_KEY, `codex::oauth::${HOME}/.codex::local`].sort()
		);
	});

	it('persists every probe result under its identity key', async () => {
		await runStartupAuthProbe(makeDeps([makeSession()]));

		expect(getSnapshot(DEFAULT_CLAUDE_KEY)).toMatchObject({
			status: 'authenticated',
			source: 'probe',
		});
	});

	it('merges agent-level env under session-level env', async () => {
		const sessions = [
			makeSession({ customEnvVars: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-work` } }),
		];
		const deps = makeDeps(sessions, {
			configs: { 'claude-code': { customEnvVars: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-agent` } } },
		});

		await runStartupAuthProbe(deps);

		// Session level wins, so the identity is the work dir, not the agent dir.
		expect(probedKeys()).toEqual([WORK_CLAUDE_KEY]);
		expect(probeCredentialMock.mock.calls[0][1]).toMatchObject({
			env: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-work` },
			binaryPath: '/usr/local/bin/claude',
		});
	});

	// ========================================================================
	// startup vs manual
	// ========================================================================

	it('skips an identity with a fresh snapshot in startup mode and re-probes it in manual mode', async () => {
		const identity: CredentialIdentity = {
			key: DEFAULT_CLAUDE_KEY,
			provider: 'claude-code',
			kind: 'oauth',
			scope: `${HOME}/.claude`,
			host: 'local',
			label: '.claude',
		};
		setSnapshot(DEFAULT_CLAUDE_KEY, makeSnapshot(identity, { checkedAt: FROZEN_NOW - 1_000 }));
		const sessions = [makeSession()];

		const startup = await runStartupAuthProbe(makeDeps(sessions));
		expect(probeCredentialMock).not.toHaveBeenCalled();
		expect(startup).toMatchObject({ identities: 1, probed: 0, skippedFresh: 1 });

		const manual = await runStartupAuthProbe(makeDeps(sessions, { mode: 'manual' }));
		expect(probeCredentialMock).toHaveBeenCalledTimes(1);
		expect(manual).toMatchObject({ probed: 1, skippedFresh: 0 });
	});

	it('re-probes an identity whose snapshot has aged past PROBE_STALE_MS', async () => {
		const identity: CredentialIdentity = {
			key: DEFAULT_CLAUDE_KEY,
			provider: 'claude-code',
			kind: 'oauth',
			scope: `${HOME}/.claude`,
			host: 'local',
			label: '.claude',
		};
		setSnapshot(
			DEFAULT_CLAUDE_KEY,
			makeSnapshot(identity, { checkedAt: FROZEN_NOW - PROBE_STALE_MS - 1 })
		);

		await runStartupAuthProbe(makeDeps([makeSession()]));

		expect(probeCredentialMock).toHaveBeenCalledTimes(1);
	});

	it('skips an out-of-window session in startup mode and probes it in manual mode', async () => {
		const sessions = [
			makeSession({ createdAt: FROZEN_NOW - AUTH_STARTUP_SESSION_WINDOW_MS - 1, aiTabs: [] }),
		];

		const startup = await runStartupAuthProbe(makeDeps(sessions));
		expect(probeCredentialMock).not.toHaveBeenCalled();
		expect(startup).toMatchObject({ identities: 0, probed: 0 });

		const manual = await runStartupAuthProbe(makeDeps(sessions, { mode: 'manual' }));
		expect(probeCredentialMock).toHaveBeenCalledTimes(1);
		expect(manual).toMatchObject({ identities: 1, probed: 1 });
	});

	it('treats a recently opened AI tab as activity on an old session', async () => {
		// `createdAt` alone would read a daily-driver agent created months ago as
		// permanently stale, so it would never be probed at any boot.
		const sessions = [
			makeSession({
				createdAt: FROZEN_NOW - AUTH_STARTUP_SESSION_WINDOW_MS * 10,
				aiTabs: [{ createdAt: FROZEN_NOW - 5_000 }],
			}),
		];

		await runStartupAuthProbe(makeDeps(sessions));

		expect(probeCredentialMock).toHaveBeenCalledTimes(1);
	});

	// ========================================================================
	// onlyKeys narrowing
	// ========================================================================

	it('probes exactly the named key when onlyKeys is supplied', async () => {
		const sessions = [
			makeSession(),
			makeSession({ customEnvVars: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-work` } }),
		];

		const result = await runStartupAuthProbe(
			makeDeps(sessions, { mode: 'manual', onlyKeys: [WORK_CLAUDE_KEY] })
		);

		expect(probedKeys()).toEqual([WORK_CLAUDE_KEY]);
		expect(result).toMatchObject({ identities: 1, probed: 1 });
	});

	it('probes nothing when onlyKeys names a key no session references', async () => {
		const result = await runStartupAuthProbe(
			makeDeps([makeSession()], { mode: 'manual', onlyKeys: ['claude-code::oauth::/gone::local'] })
		);

		expect(probeCredentialMock).not.toHaveBeenCalled();
		expect(result).toMatchObject({ identities: 0, probed: 0 });
	});

	// ========================================================================
	// Skips
	// ========================================================================

	it('skips a provider that is not installed on this host', async () => {
		const result = await runStartupAuthProbe(makeDeps([makeSession()], { agent: null }));

		expect(probeCredentialMock).not.toHaveBeenCalled();
		expect(result).toMatchObject({ identities: 1, probed: 0, skippedNotInstalled: 1 });
	});

	it('ignores a session with no tool type', async () => {
		const result = await runStartupAuthProbe(makeDeps([makeSession({ toolType: '' })]));

		expect(probeCredentialMock).not.toHaveBeenCalled();
		expect(result.identities).toBe(0);
	});

	it('has nothing to probe when there are no stored sessions', async () => {
		const result = await runStartupAuthProbe(makeDeps([]));

		expect(probeCredentialMock).not.toHaveBeenCalled();
		expect(result).toMatchObject({ identities: 0, probed: 0 });
	});

	// ========================================================================
	// SSH
	// ========================================================================

	it('skips an SSH session at startup and probes it on a manual refresh', async () => {
		const sessions = [
			makeSession({ sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' } }),
		];

		await runStartupAuthProbe(makeDeps(sessions));
		expect(probeCredentialMock).not.toHaveBeenCalled();

		await runStartupAuthProbe(makeDeps(sessions, { mode: 'manual' }));
		expect(probedKeys()).toEqual([`claude-code::oauth::${HOME}/.claude::ssh:remote-1`]);
		// A remote probe runs the provider by bare binary name on the remote host,
		// so the local detector's absolute path must not be used.
		expect(probeCredentialMock.mock.calls[0][1]).toMatchObject({
			binaryPath: 'claude',
			sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});
	});

	it('probes an SSH identity even when the provider is missing locally', async () => {
		const sessions = [
			makeSession({ sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' } }),
		];

		const result = await runStartupAuthProbe(makeDeps(sessions, { mode: 'manual', agent: null }));

		expect(probeCredentialMock).toHaveBeenCalledTimes(1);
		expect(result.skippedNotInstalled).toBe(0);
	});

	it('drops an SSH session that names no remote rather than probing locally', async () => {
		const sessions = [makeSession({ sessionSshRemoteConfig: { enabled: true } })];

		const result = await runStartupAuthProbe(makeDeps(sessions, { mode: 'manual' }));

		expect(probeCredentialMock).not.toHaveBeenCalled();
		expect(result.identities).toBe(0);
	});

	it('keeps the local and remote copies of one account dir as two identities', async () => {
		const sessions = [
			makeSession(),
			makeSession({ sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' } }),
		];

		await runStartupAuthProbe(makeDeps(sessions, { mode: 'manual' }));

		expect(probedKeys().sort()).toEqual(
			[DEFAULT_CLAUDE_KEY, `claude-code::oauth::${HOME}/.claude::ssh:remote-1`].sort()
		);
	});

	// ========================================================================
	// Failure containment
	// ========================================================================

	it('records nothing when a probe throws', async () => {
		probeCredentialMock.mockRejectedValue(new Error('boom'));

		const result = await runStartupAuthProbe(makeDeps([makeSession()]));

		// A crash must never read as a login verdict.
		expect(getSnapshot(DEFAULT_CLAUDE_KEY)).toBeNull();
		expect(result.probed).toBe(0);
		expect(loggerWarnMock).toHaveBeenCalled();
	});

	it('keeps probing the other identities after one throws', async () => {
		probeCredentialMock.mockImplementation(async (identity: CredentialIdentity) => {
			if (identity.key === DEFAULT_CLAUDE_KEY) throw new Error('boom');
			return makeSnapshot(identity);
		});
		const sessions = [
			makeSession(),
			makeSession({ customEnvVars: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-work` } }),
		];

		const result = await runStartupAuthProbe(makeDeps(sessions));

		expect(result.probed).toBe(1);
		expect(getSnapshot(WORK_CLAUDE_KEY)).not.toBeNull();
	});

	it('never throws when the sessions store blows up', async () => {
		const deps = makeDeps([]);
		(deps.sessionsStore as { get: () => unknown }).get = () => {
			throw new Error('store unavailable');
		};

		await expect(runStartupAuthProbe(deps)).resolves.toMatchObject({ identities: 0, probed: 0 });
		expect(loggerWarnMock).toHaveBeenCalled();
	});

	it('counts results by status', async () => {
		probeCredentialMock.mockImplementation(async (identity: CredentialIdentity) =>
			makeSnapshot(identity, {
				status: identity.key === DEFAULT_CLAUDE_KEY ? 'logged-out' : 'unknown',
			})
		);
		const sessions = [
			makeSession(),
			makeSession({ customEnvVars: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-work` } }),
		];

		const result = await runStartupAuthProbe(makeDeps(sessions));

		expect(result.byStatus).toEqual({ 'logged-out': 1, unknown: 1 });
	});

	// ========================================================================
	// Secret hygiene
	// ========================================================================

	it('never writes a raw token into the stored snapshot for an api-key identity', async () => {
		const TOKEN = 'sk-ant-super-secret-token-value-0123456789';
		probeCredentialMock.mockImplementation(async (identity: CredentialIdentity) =>
			makeSnapshot(identity, { status: 'unsupported', detail: 'Credential is an API key' })
		);

		await runStartupAuthProbe(
			makeDeps([makeSession({ customEnvVars: { ANTHROPIC_API_KEY: TOKEN } })])
		);

		const key = probedKeys()[0];
		expect(key).not.toContain(TOKEN);
		expect(JSON.stringify(getSnapshot(key))).not.toContain(TOKEN);
		const logged = JSON.stringify([loggerWarnMock.mock.calls, loggerInfoMock.mock.calls]);
		expect(logged).not.toContain(TOKEN);
	});
});
