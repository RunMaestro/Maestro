/**
 * Tests for src/main/agents/auth/auth-probe.ts
 *
 * Strategy: mock `execFileNoThrow` so every provider's status output (and every
 * way a spawn can fail) can be driven directly, mock the logger so the "never
 * log a secret" assertions have something to inspect, and mock `os.homedir()`
 * so the default cwd is deterministic. Identities are built through the real
 * `resolveCredentialIdentity`, since a hand-written identity literal would let
 * a resolver change slip past these tests.
 *
 * The two rules in the module docblock are what most of this file exists to
 * defend:
 *
 * 1. A probe that could not RUN is `unknown`, never `logged-out`. Timeouts,
 *    missing binaries, and unparseable payloads are all tested for that.
 * 2. A non-`oauth` identity is `unsupported` with ZERO spawns. Those tests
 *    assert on the spawn mock's call count, not just on the returned status,
 *    because a probe that runs and then discards its answer still leaks a
 *    credential onto a command line.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
	execFileNoThrowMock,
	wrapSpawnWithSshMock,
	loggerWarnMock,
	loggerInfoMock,
	loggerDebugMock,
	loggerErrorMock,
} = vi.hoisted(() => ({
	execFileNoThrowMock: vi.fn(),
	wrapSpawnWithSshMock: vi.fn(),
	loggerWarnMock: vi.fn(),
	loggerInfoMock: vi.fn(),
	loggerDebugMock: vi.fn(),
	loggerErrorMock: vi.fn(),
}));

vi.mock('../../../../main/utils/execFile', () => ({
	execFileNoThrow: execFileNoThrowMock,
}));

vi.mock('../../../../main/utils/ssh-spawn-wrapper', () => ({
	wrapSpawnWithSsh: wrapSpawnWithSshMock,
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		warn: loggerWarnMock,
		info: loggerInfoMock,
		debug: loggerDebugMock,
		error: loggerErrorMock,
	},
}));

vi.mock('os', async () => {
	const actual = await vi.importActual<typeof import('os')>('os');
	const homedir = () => '/Users/test';
	return { ...actual, homedir, default: { ...actual, homedir } };
});

import {
	probeCredential,
	DEFAULT_PROBE_TIMEOUT_MS,
	SSH_PROBE_TIMEOUT_MS,
} from '../../../../main/agents/auth/auth-probe';
import { resolveCredentialIdentity } from '../../../../shared/providerAuth';
import type { CredentialIdentity } from '../../../../shared/providerAuth';

const FROZEN_NOW = new Date('2026-08-15T12:00:00.000Z').getTime();
const HOME = '/Users/test';
const now = () => FROZEN_NOW;

/** Build an identity the same way the startup pass does, from tool type + env. */
function identityFor(toolType: string, env: Record<string, string> = {}): CredentialIdentity {
	return resolveCredentialIdentity({ toolType, env, homeDir: HOME });
}

/** Queue one `execFileNoThrow` result. */
function mockRun(result: { stdout?: string; stderr?: string; exitCode: number | string }): void {
	execFileNoThrowMock.mockResolvedValue({
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.exitCode,
	});
}

function probeOpts(overrides: Record<string, unknown> = {}) {
	return { binaryPath: '/usr/local/bin/agent', env: {}, now, ...overrides };
}

describe('probeCredential', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ========================================================================
	// claude-code
	// ========================================================================

	describe('claude-code', () => {
		const identity = () => identityFor('claude-code');

		it('maps loggedIn: true to authenticated and surfaces the email in detail', async () => {
			mockRun({
				stdout: JSON.stringify({
					loggedIn: true,
					apiProvider: 'firstparty',
					email: 'dev@example.com',
					orgName: 'Example Inc',
					subscriptionType: 'max',
				}),
				exitCode: 0,
			});

			const snapshot = await probeCredential(identity(), probeOpts());

			expect(snapshot.status).toBe('authenticated');
			expect(snapshot.detail).toContain('dev@example.com');
			expect(snapshot.detail).toContain('Example Inc');
			expect(snapshot.detail).toContain('max');
			expect(snapshot.accountLabel).toBe('.claude');
			expect(snapshot.source).toBe('probe');
			expect(snapshot.checkedAt).toBe(FROZEN_NOW);
			expect(execFileNoThrowMock).toHaveBeenCalledWith(
				'/usr/local/bin/agent',
				['auth', 'status', '--json'],
				HOME,
				expect.objectContaining({ timeout: DEFAULT_PROBE_TIMEOUT_MS })
			);
		});

		it('maps loggedIn: false to logged-out', async () => {
			mockRun({ stdout: JSON.stringify({ loggedIn: false }), exitCode: 0 });

			const snapshot = await probeCredential(identity(), probeOpts());

			expect(snapshot.status).toBe('logged-out');
			expect(snapshot.accountLabel).toBe('.claude');
		});

		it('honors loggedIn: false even though the command exits 1', async () => {
			// Verified 2026-08-15: `claude auth status --json` exits 1 when logged
			// out but still prints well-formed JSON. Gating on the exit code would
			// throw away a perfectly good verdict, so the parser ignores it.
			mockRun({ stdout: JSON.stringify({ loggedIn: false }), exitCode: 1 });

			expect((await probeCredential(identity(), probeOpts())).status).toBe('logged-out');
		});

		it('parses JSON out of pretty-printed output with a warning prefix', async () => {
			mockRun({
				stdout: `(node:1234) DeprecationWarning: whatever\n{\n  "loggedIn": true,\n  "email": "multi@example.com"\n}\n`,
				exitCode: 0,
			});

			const snapshot = await probeCredential(identity(), probeOpts());

			expect(snapshot.status).toBe('authenticated');
			expect(snapshot.detail).toBe('multi@example.com');
		});

		it('maps garbage stdout to unknown, not logged-out', async () => {
			mockRun({ stdout: 'command not found: auth\n', exitCode: 1 });

			const snapshot = await probeCredential(identity(), probeOpts());

			expect(snapshot.status).toBe('unknown');
			expect(loggerWarnMock).toHaveBeenCalled();
		});

		it('maps JSON without a loggedIn field to unknown', async () => {
			mockRun({ stdout: JSON.stringify({ apiProvider: 'firstparty' }), exitCode: 0 });

			expect((await probeCredential(identity(), probeOpts())).status).toBe('unknown');
		});

		it('maps a timeout to unknown', async () => {
			mockRun({ exitCode: 'ETIMEDOUT' });

			const snapshot = await probeCredential(identity(), probeOpts({ timeoutMs: 250 }));

			expect(snapshot.status).toBe('unknown');
			expect(snapshot.detail).toContain('timed out');
		});

		it('maps a missing binary to unknown', async () => {
			mockRun({ exitCode: 'ENOENT' });

			const snapshot = await probeCredential(identity(), probeOpts());

			expect(snapshot.status).toBe('unknown');
			expect(snapshot.detail).toContain('ENOENT');
		});

		it('maps a non-first-party apiProvider to unsupported, not logged-out', async () => {
			mockRun({
				stdout: JSON.stringify({ loggedIn: false, apiProvider: 'bedrock' }),
				exitCode: 1,
			});

			const snapshot = await probeCredential(identity(), probeOpts());

			expect(snapshot.status).toBe('unsupported');
			expect(snapshot.detail).toContain('bedrock');
		});

		it('treats a first-party apiProvider as a normal login verdict', async () => {
			mockRun({
				stdout: JSON.stringify({ loggedIn: true, apiProvider: 'firstParty', email: 'a@b.c' }),
				exitCode: 0,
			});

			expect((await probeCredential(identity(), probeOpts())).status).toBe('authenticated');
		});
	});

	// ========================================================================
	// codex
	// ========================================================================

	describe('codex', () => {
		const identity = () => identityFor('codex');

		it('maps a logged-in line plus exit 0 to authenticated', async () => {
			mockRun({ stdout: 'Logged in using ChatGPT (dev@example.com)\n', exitCode: 0 });

			const snapshot = await probeCredential(identity(), probeOpts());

			expect(snapshot.status).toBe('authenticated');
			expect(snapshot.detail).toBe('Logged in using ChatGPT (dev@example.com)');
			expect(snapshot.accountLabel).toBe('.codex');
			expect(execFileNoThrowMock).toHaveBeenCalledWith(
				'/usr/local/bin/agent',
				['login', 'status'],
				HOME,
				expect.anything()
			);
		});

		it('maps "Not logged in" to logged-out even though it contains the logged-in phrase', async () => {
			// The negated form is checked FIRST for exactly this reason. A test that
			// only covers the happy path will not catch a reordering.
			mockRun({ stdout: 'Not logged in\n', exitCode: 1 });

			expect((await probeCredential(identity(), probeOpts())).status).toBe('logged-out');
		});

		it('maps an unrecognized line to unknown and keeps it as the detail', async () => {
			mockRun({ stdout: 'codex: unknown subcommand "login"\n', exitCode: 2 });

			const snapshot = await probeCredential(identity(), probeOpts());

			expect(snapshot.status).toBe('unknown');
			expect(snapshot.detail).toBe('codex: unknown subcommand "login"');
			expect(loggerWarnMock).toHaveBeenCalled();
		});

		it('does not claim authenticated on a logged-in phrase with a non-zero exit', async () => {
			mockRun({ stdout: 'Logged in using ChatGPT\n', exitCode: 3 });

			expect((await probeCredential(identity(), probeOpts())).status).toBe('unknown');
		});

		it('maps a spawn failure to unknown', async () => {
			mockRun({ exitCode: 'EACCES' });

			expect((await probeCredential(identity(), probeOpts())).status).toBe('unknown');
		});
	});

	// ========================================================================
	// opencode
	// ========================================================================

	describe('opencode', () => {
		const identity = () => identityFor('opencode');

		it('maps a non-zero credential count to authenticated', async () => {
			// Real output is ANSI-decorated, so this also covers the strip step.
			mockRun({ stdout: '\u001b[1mCredentials\u001b[0m\n\n2 credentials\n', exitCode: 0 });

			const snapshot = await probeCredential(identity(), probeOpts());

			expect(snapshot.status).toBe('authenticated');
			expect(snapshot.detail).toBe('2 stored credentials');
			expect(execFileNoThrowMock).toHaveBeenCalledWith(
				'/usr/local/bin/agent',
				['auth', 'list'],
				HOME,
				expect.anything()
			);
		});

		it('maps a zero credential count to logged-out', async () => {
			mockRun({ stdout: '0 credentials\n', exitCode: 0 });

			expect((await probeCredential(identity(), probeOpts())).status).toBe('logged-out');
		});

		it('maps unrecognized output to unknown', async () => {
			mockRun({ stdout: 'migrating database...\n', exitCode: 0 });

			expect((await probeCredential(identity(), probeOpts())).status).toBe('unknown');
		});
	});

	// ========================================================================
	// Providers with no probe
	// ========================================================================

	it('returns unknown for copilot-cli without spawning anything', async () => {
		const snapshot = await probeCredential(identityFor('copilot-cli'), probeOpts());

		expect(snapshot.status).toBe('unknown');
		expect(execFileNoThrowMock).not.toHaveBeenCalled();
	});

	it('returns unsupported for an oauth identity on an unrecognized provider', async () => {
		// factory-droid resolves to kind 'unknown' and is caught by the rule-2
		// short-circuit, so the provider switch's default branch needs an identity
		// that is oauth but unprobeable to be reached at all.
		const identity: CredentialIdentity = {
			key: 'factory-droid::oauth::/Users/test/.factory::local',
			provider: 'factory-droid',
			kind: 'oauth',
			scope: '/Users/test/.factory',
			host: 'local',
			label: '.factory',
		};

		const snapshot = await probeCredential(identity, probeOpts());

		expect(snapshot.status).toBe('unsupported');
		expect(execFileNoThrowMock).not.toHaveBeenCalled();
	});

	it('returns unsupported for factory-droid without spawning anything', async () => {
		const snapshot = await probeCredential(identityFor('factory-droid'), probeOpts());

		expect(snapshot.status).toBe('unsupported');
		expect(execFileNoThrowMock).not.toHaveBeenCalled();
	});

	// ========================================================================
	// Rule 2: never probe a non-oauth identity
	// ========================================================================

	describe('non-oauth identities', () => {
		const cases: Array<{ name: string; toolType: string; env: Record<string, string> }> = [
			{
				name: 'api-key',
				toolType: 'claude-code',
				env: { ANTHROPIC_API_KEY: 'sk-ant-secret-value-0123456789abcdef' },
			},
			{
				name: 'gateway',
				toolType: 'claude-code',
				env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/v1' },
			},
			{ name: 'cloud-provider', toolType: 'claude-code', env: { CLAUDE_CODE_USE_BEDROCK: '1' } },
		];

		for (const testCase of cases) {
			it(`maps a ${testCase.name} identity to unsupported with zero spawns`, async () => {
				const identity = identityFor(testCase.toolType, testCase.env);
				expect(identity.kind).toBe(testCase.name);

				const snapshot = await probeCredential(identity, probeOpts({ env: testCase.env }));

				expect(snapshot.status).toBe('unsupported');
				expect(snapshot.detail).toBeTruthy();
				expect(execFileNoThrowMock).not.toHaveBeenCalled();
			});
		}

		it('never puts a raw token in the snapshot or in a log line', async () => {
			const TOKEN = 'sk-ant-super-secret-token-value-0123456789';
			const env = { ANTHROPIC_API_KEY: TOKEN };
			const identity = identityFor('claude-code', env);

			const snapshot = await probeCredential(identity, probeOpts({ env }));

			expect(JSON.stringify(snapshot)).not.toContain(TOKEN);
			const logged = JSON.stringify([
				loggerWarnMock.mock.calls,
				loggerInfoMock.mock.calls,
				loggerDebugMock.mock.calls,
				loggerErrorMock.mock.calls,
			]);
			expect(logged).not.toContain(TOKEN);
		});
	});

	// ========================================================================
	// Spawn hygiene
	// ========================================================================

	it('layers the identity env over the parent env and neutralizes $BROWSER', async () => {
		mockRun({ stdout: JSON.stringify({ loggedIn: true }), exitCode: 0 });

		await probeCredential(
			identityFor('claude-code', { CLAUDE_CONFIG_DIR: '/Users/test/.claude-work' }),
			probeOpts({ env: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-work' } })
		);

		const options = execFileNoThrowMock.mock.calls[0][3] as { env: Record<string, string> };
		expect(options.env.CLAUDE_CONFIG_DIR).toBe('/Users/test/.claude-work');
		expect(options.env.BROWSER).toBe('/usr/bin/true');
		expect(options.env.PATH).toBe(process.env.PATH);
	});

	// A failover endpoint that redirects the base URL is a DIFFERENT operator, so
	// a credential it never supplied must not reach it - and the dangerous copy is
	// the INHERITED one, which absence from `opts.env` cannot remove.
	it('removes an inherited credential the failover endpoint does not supply', async () => {
		mockRun({ stdout: JSON.stringify({ loggedIn: true }), exitCode: 0 });
		const previous = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = 'primary-key-from-maestro-env';

		try {
			await probeCredential(
				identityFor('claude-code'),
				probeOpts({
					env: { ANTHROPIC_BASE_URL: 'https://backup.example' },
					unsetEnvKeys: ['ANTHROPIC_API_KEY'],
				})
			);

			const options = execFileNoThrowMock.mock.calls[0][3] as { env: Record<string, string> };
			expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
			// Everything else still comes through.
			expect(options.env.ANTHROPIC_BASE_URL).toBe('https://backup.example');
			expect(options.env.PATH).toBe(process.env.PATH);
		} finally {
			if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = previous;
		}
	});

	it('runs in the supplied cwd when one is given', async () => {
		mockRun({ stdout: JSON.stringify({ loggedIn: true }), exitCode: 0 });

		await probeCredential(identityFor('claude-code'), probeOpts({ cwd: '/tmp/project' }));

		expect(execFileNoThrowMock.mock.calls[0][2]).toBe('/tmp/project');
	});

	// ========================================================================
	// SSH remotes
	//
	// The credential lives on the far machine, so every one of these tests is
	// really the same assertion: the probe either runs on the host that owns the
	// credential, or it answers `unknown`. There is no third option, and there is
	// certainly no "check the local machine and file the result under the remote
	// identity" option.
	// ========================================================================

	describe('ssh remotes', () => {
		const REMOTE_ID = 'remote-1';

		/** An identity whose host is `ssh:remote-1`, built through the real resolver. */
		function remoteIdentity(
			toolType = 'claude-code',
			env: Record<string, string> = {}
		): CredentialIdentity {
			return resolveCredentialIdentity({
				toolType,
				env,
				homeDir: HOME,
				sshRemoteId: REMOTE_ID,
			});
		}

		function remoteOpts(overrides: Record<string, unknown> = {}) {
			return probeOpts({
				sshRemoteConfig: { enabled: true, remoteId: REMOTE_ID },
				sshStore: { getSshRemotes: () => [] },
				...overrides,
			});
		}

		/** Make the wrapper report a successful wrap onto `remoteId`. */
		function mockWrapOnto(remoteId: string): void {
			wrapSpawnWithSshMock.mockResolvedValue({
				command: '/usr/bin/ssh',
				args: ['user@host', 'claude auth status --json'],
				cwd: HOME,
				sshRemoteUsed: { id: remoteId, name: remoteId, host: 'host' },
			});
		}

		it('runs the status command through the ssh wrapper, by bare binary name', async () => {
			mockWrapOnto(REMOTE_ID);
			mockRun({ stdout: JSON.stringify({ loggedIn: true }), exitCode: 0 });

			const snapshot = await probeCredential(
				remoteIdentity(),
				// What `collectAuthTargets` resolves for a remote target with no
				// customPath. A locally-detected path is never passed here: it names a
				// file that does not exist on the far side.
				remoteOpts({
					binaryPath: 'claude',
					cwd: '/remote/project',
					env: { CLAUDE_CONFIG_DIR: '/remote/.claude-work' },
				})
			);

			expect(snapshot.status).toBe('authenticated');
			const wrapConfig = wrapSpawnWithSshMock.mock.calls[0][0];
			expect(wrapConfig.agentBinaryName).toBe('claude');
			expect(wrapConfig.args).toEqual(['auth', 'status', '--json']);
			expect(wrapConfig.cwd).toBe('/remote/project');
			// The effective env has to travel with the command, or the remote CLI
			// reads its own default config dir instead of the agent's account.
			expect(wrapConfig.customEnvVars).toEqual({ CLAUDE_CONFIG_DIR: '/remote/.claude-work' });
			// And the local spawn is the ssh client the wrapper handed back.
			expect(execFileNoThrowMock.mock.calls[0][0]).toBe('/usr/bin/ssh');
		});

		// An agent pointed at a different CLI install must be PROBED against that
		// install, or the badge describes an account the agent never uses. Over SSH
		// the override is a path on the remote host, so it travels verbatim.
		it("invokes the agent's own remote customPath when it has one", async () => {
			mockWrapOnto(REMOTE_ID);
			mockRun({ stdout: JSON.stringify({ loggedIn: true }), exitCode: 0 });

			await probeCredential(remoteIdentity(), remoteOpts({ binaryPath: '/opt/custom/claude' }));

			expect(wrapSpawnWithSshMock.mock.calls[0][0].agentBinaryName).toBe('/opt/custom/claude');
		});

		it('gives a remote probe a longer timeout than a local one', async () => {
			mockWrapOnto(REMOTE_ID);
			mockRun({ stdout: JSON.stringify({ loggedIn: true }), exitCode: 0 });

			await probeCredential(remoteIdentity(), remoteOpts());

			const options = execFileNoThrowMock.mock.calls[0][3] as { timeout: number };
			expect(options.timeout).toBe(SSH_PROBE_TIMEOUT_MS);
			expect(SSH_PROBE_TIMEOUT_MS).toBeGreaterThan(DEFAULT_PROBE_TIMEOUT_MS);
		});

		it('still honors an explicit timeout override', async () => {
			mockWrapOnto(REMOTE_ID);
			mockRun({ stdout: JSON.stringify({ loggedIn: true }), exitCode: 0 });

			await probeCredential(remoteIdentity(), remoteOpts({ timeoutMs: 1234 }));

			expect((execFileNoThrowMock.mock.calls[0][3] as { timeout: number }).timeout).toBe(1234);
		});

		it('refuses to probe when the remote cannot be resolved', async () => {
			wrapSpawnWithSshMock.mockResolvedValue({
				command: '/usr/local/bin/agent',
				args: ['auth', 'status', '--json'],
				cwd: HOME,
				sshRemoteUsed: null,
			});

			const snapshot = await probeCredential(remoteIdentity(), remoteOpts());

			expect(snapshot.status).toBe('unknown');
			expect(snapshot.detail).toContain('could not be resolved');
			expect(execFileNoThrowMock).not.toHaveBeenCalled();
		});

		it('refuses to probe when the wrapper resolves a different remote', async () => {
			mockWrapOnto('some-other-remote');

			const snapshot = await probeCredential(remoteIdentity(), remoteOpts());

			expect(snapshot.status).toBe('unknown');
			expect(execFileNoThrowMock).not.toHaveBeenCalled();
		});

		it('refuses to probe when SSH is configured but no store was supplied', async () => {
			const snapshot = await probeCredential(
				remoteIdentity(),
				probeOpts({ sshRemoteConfig: { enabled: true, remoteId: REMOTE_ID } })
			);

			expect(snapshot.status).toBe('unknown');
			expect(wrapSpawnWithSshMock).not.toHaveBeenCalled();
			expect(execFileNoThrowMock).not.toHaveBeenCalled();
		});

		it('refuses to probe a remote credential with no ssh config at all', async () => {
			const snapshot = await probeCredential(remoteIdentity(), probeOpts());

			// This is the whole bug in one test: a local spawn here would report THIS
			// machine's login state under a credential that lives somewhere else.
			expect(snapshot.status).toBe('unknown');
			expect(snapshot.detail).toContain(REMOTE_ID);
			expect(execFileNoThrowMock).not.toHaveBeenCalled();
		});

		it('refuses to probe a local credential through an ssh remote', async () => {
			const snapshot = await probeCredential(identityFor('claude-code'), remoteOpts());

			expect(snapshot.status).toBe('unknown');
			expect(execFileNoThrowMock).not.toHaveBeenCalled();
		});

		it('reports an unreachable host as unknown, not logged-out', async () => {
			mockWrapOnto(REMOTE_ID);
			mockRun({
				stderr: 'ssh: connect to host build-box port 22: Connection refused',
				exitCode: 255,
			});

			const snapshot = await probeCredential(remoteIdentity(), remoteOpts());

			expect(snapshot.status).toBe('unknown');
			expect(snapshot.detail).toContain('Connection refused');
		});

		it('reports a rejected key as unknown even when ssh exits zero', async () => {
			// A login shell on the far side can swallow the exit code, so the message
			// is checked too. Codex is the dangerous provider here: its logged-out
			// matcher is a plain substring test over the same text.
			mockWrapOnto(REMOTE_ID);
			mockRun({ stderr: 'Permission denied (publickey).', exitCode: 0 });

			const snapshot = await probeCredential(remoteIdentity('codex'), remoteOpts());

			expect(snapshot.status).toBe('unknown');
			expect(snapshot.detail).toContain('Permission denied');
		});

		it('reports a remote timeout as unknown', async () => {
			mockWrapOnto(REMOTE_ID);
			mockRun({ exitCode: 'ETIMEDOUT' });

			const snapshot = await probeCredential(remoteIdentity(), remoteOpts());

			expect(snapshot.status).toBe('unknown');
			expect(snapshot.detail).toContain('timed out');
		});

		it('still reads a genuine logged-out answer from the remote', async () => {
			// The transport guard must not swallow the real verdict: the remote ran
			// the command, and it said no.
			mockWrapOnto(REMOTE_ID);
			mockRun({ stdout: JSON.stringify({ loggedIn: false }), exitCode: 1 });

			const snapshot = await probeCredential(remoteIdentity(), remoteOpts());

			expect(snapshot.status).toBe('logged-out');
		});

		it('reports a thrown wrapper as unknown instead of falling back to local', async () => {
			wrapSpawnWithSshMock.mockRejectedValue(new Error('ssh config unreadable'));

			const snapshot = await probeCredential(remoteIdentity(), remoteOpts());

			expect(snapshot.status).toBe('unknown');
			expect(execFileNoThrowMock).not.toHaveBeenCalled();
		});

		it('never logs the identity env when a remote probe fails', async () => {
			// The identity KEY carries the config dir by design (it is the scope, and
			// the Settings panel shows it). What must never appear is anything else
			// the env block happens to carry, which for a real agent is where the
			// tokens live.
			const SECRET = 'ghp-remote-deploy-secret-0123456789';
			const env = { CLAUDE_CONFIG_DIR: '/remote/.claude-work', DEPLOY_TOKEN: SECRET };
			mockWrapOnto(REMOTE_ID);
			mockRun({
				stderr: 'ssh: connect to host build-box port 22: No route to host',
				exitCode: 255,
			});

			await probeCredential(remoteIdentity('claude-code', env), remoteOpts({ env }));

			const logged = JSON.stringify([
				loggerWarnMock.mock.calls,
				loggerInfoMock.mock.calls,
				loggerDebugMock.mock.calls,
				loggerErrorMock.mock.calls,
			]);
			expect(logged).not.toContain(SECRET);
		});
	});
});
