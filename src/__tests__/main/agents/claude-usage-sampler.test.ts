/**
 * Tests for src/main/agents/claude-usage-sampler.ts
 *
 * Strategy: mock the `child_process` module's execFile binding and the
 * `util.promisify` shim so the wrapped async path resolves/rejects
 * synchronously under test control, mock `os.homedir()` so
 * `resolveConfigDirKey` is host-agnostic, and stub `captureMessage` so we
 * can assert what gets reported to Sentry without touching the real
 * `@sentry/electron/main` module.
 *
 * Coverage hits every spec checklist item from playbook task 8:
 *   happy path → sampledAt set locally / configDirKey canonicalized /
 *   spawn args + env composition / custom + default timeout / deprecation
 *   warning prefix tolerance / `~/.claude` fallback / explicit configDir
 *   beats customEnvVars / every failure mode (ENOENT, EACCES, timeout,
 *   non-zero exit, empty stdout, no JSON line, malformed JSON, missing
 *   wire fields).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoist the mock functions so vi.mock() factories - which are themselves
// hoisted above all imports - can reference them at module-init time. Without
// vi.hoisted(), the factory closes over a `mockExecFile` that hasn't been
// initialized yet, and the first `import` from the source module crashes
// with "Cannot access 'mockExecFile' before initialization".
const { mockExecFile, captureMessageMock } = vi.hoisted(() => ({
	mockExecFile: vi.fn(),
	captureMessageMock: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		default: { ...actual, execFile: mockExecFile },
		execFile: mockExecFile,
	};
});

vi.mock('util', async (importOriginal) => {
	const actual = await importOriginal<typeof import('util')>();
	const wrap = (fn: unknown) => {
		if (fn === mockExecFile) {
			return (...args: unknown[]) =>
				new Promise((resolve, reject) => {
					mockExecFile(...args, (err: Error | null, stdout: string, stderr: string) => {
						if (err) reject(err);
						else resolve({ stdout, stderr });
					});
				});
		}
		return actual.promisify(fn as never);
	};
	return {
		...actual,
		default: { ...actual, promisify: wrap },
		promisify: wrap,
	};
});

vi.mock('os', async (importOriginal) => {
	const actual = await importOriginal<typeof import('os')>();
	const homedir = () => '/Users/test';
	return {
		...actual,
		homedir,
		default: { ...actual, homedir },
	};
});

vi.mock('../../../main/utils/sentry', () => ({
	captureMessage: captureMessageMock,
}));

import os from 'os';
import path from 'path';
import { sampleUsage } from '../../../main/agents/claude-usage-sampler';
import { asarNodePath, canonKey } from '../../helpers/pathExpect';

const FROZEN_NOW = new Date('2026-05-15T12:00:00.000Z').getTime();
const ORIGINAL_ENV = { ...process.env };

interface ExecFileCallSite {
	cmd: string;
	args: string[];
	options: Record<string, unknown>;
}

// Helper that primes the mocked execFile binding to invoke its callback with
// the given stdout/stderr (success path). Returns the captured call shape so
// tests can assert on the args/options passed to the spawn.
function primeSuccess(stdout: string, stderr: string = ''): () => ExecFileCallSite | null {
	let captured: ExecFileCallSite | null = null;
	mockExecFile.mockImplementation(
		(cmd: string, args: string[], options: Record<string, unknown>, callback: unknown) => {
			captured = { cmd, args, options };
			if (typeof callback === 'function') {
				(callback as (e: Error | null, o: string, x: string) => void)(null, stdout, stderr);
			}
			return {} as never;
		}
	);
	return () => captured;
}

function primeFailure(err: Error & { code?: string | number; killed?: boolean }): void {
	mockExecFile.mockImplementation(
		(_cmd: string, _args: string[], _options: Record<string, unknown>, callback: unknown) => {
			if (typeof callback === 'function') {
				(callback as (e: Error | null) => void)(err);
			}
			return {} as never;
		}
	);
}

function wireEnvelope(overrides: Record<string, unknown> = {}): string {
	const base = {
		type: 'status',
		config_dir: '/Users/test/.claude',
		session: { percent: 42, resets_at: '2026-05-15T17:00:00.000Z' },
		week_all_models: { percent: 73, resets_at: '2026-05-22T12:00:00.000Z' },
		week_sonnet_only: { percent: 19, resets_at: '2026-05-22T12:00:00.000Z' },
		...overrides,
	};
	return `${JSON.stringify(base)}\n`;
}

describe('claude-usage-sampler', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(FROZEN_NOW));
		mockExecFile.mockReset();
		captureMessageMock.mockReset();
		captureMessageMock.mockResolvedValue(undefined);
		// Restore env to a known baseline; some tests intentionally drop
		// CLAUDE_CONFIG_DIR from `process.env` to verify the ~/.claude fallback.
		for (const key of Object.keys(process.env)) {
			if (!(key in ORIGINAL_ENV)) {
				delete process.env[key];
			}
		}
		for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
			process.env[key] = value;
		}
		delete process.env.CLAUDE_CONFIG_DIR;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('happy path', () => {
		it('returns a snapshot with the wire fields mapped to camelCase', async () => {
			primeSuccess(wireEnvelope());
			const snap = await sampleUsage({
				binPath: '/opt/maestro/resources/maestro-p.js',
				cwd: '/tmp/cwd',
			});
			expect(snap).toEqual({
				sampledAt: new Date(FROZEN_NOW).toISOString(),
				configDirKey: canonKey(path.join(os.homedir(), '.claude')),
				authState: 'authenticated',
				session: { percent: 42, resetsAt: '2026-05-15T17:00:00.000Z' },
				weekAllModels: { percent: 73, resetsAt: '2026-05-22T12:00:00.000Z' },
				weekSonnetOnly: { percent: 19, resetsAt: '2026-05-22T12:00:00.000Z' },
			});
		});

		it('sets sampledAt on the sampling host, not from the wire', async () => {
			// Wire envelope's `sampled_at` (if any) is intentionally ignored;
			// even an unrelated `sampled_at` value in the wire shouldn't leak
			// into the snapshot's sampledAt. We assert against the local clock.
			primeSuccess(wireEnvelope());
			const localIso = new Date(FROZEN_NOW).toISOString();
			const snap = await sampleUsage({
				binPath: '/bin/maestro-p.js',
				cwd: '/tmp',
			});
			expect(snap?.sampledAt).toBe(localIso);
		});

		it('spawns process.execPath with [binPath, --status]', async () => {
			const inspect = primeSuccess(wireEnvelope());
			await sampleUsage({ binPath: '/opt/maestro/maestro-p.js', cwd: '/tmp' });
			const call = inspect();
			expect(call?.cmd).toBe(process.execPath);
			expect(call?.args).toEqual(['/opt/maestro/maestro-p.js', '--status']);
		});

		it('passes cwd through to the spawn options', async () => {
			const inspect = primeSuccess(wireEnvelope());
			await sampleUsage({ binPath: '/bin/maestro-p.js', cwd: '/var/projects/foo' });
			expect(inspect()?.options.cwd).toBe('/var/projects/foo');
		});

		it('uses the default 30s timeout when none is provided', async () => {
			const inspect = primeSuccess(wireEnvelope());
			await sampleUsage({ binPath: '/bin/maestro-p.js', cwd: '/tmp' });
			expect(inspect()?.options.timeout).toBe(30_000);
		});

		it('honors a custom timeoutMs', async () => {
			const inspect = primeSuccess(wireEnvelope());
			await sampleUsage({ binPath: '/bin/maestro-p.js', cwd: '/tmp', timeoutMs: 5_000 });
			expect(inspect()?.options.timeout).toBe(5_000);
		});

		it('caps maxBuffer at 1MB', async () => {
			const inspect = primeSuccess(wireEnvelope());
			await sampleUsage({ binPath: '/bin/maestro-p.js', cwd: '/tmp' });
			expect(inspect()?.options.maxBuffer).toBe(1 * 1024 * 1024);
		});
	});

	describe('env composition', () => {
		it('layers customEnvVars over process.env', async () => {
			process.env.PATH = '/usr/bin';
			const inspect = primeSuccess(wireEnvelope());
			await sampleUsage({
				binPath: '/bin/maestro-p.js',
				cwd: '/tmp',
				customEnvVars: { MAESTRO_CLAUDE_BIN: '/opt/claude' },
			});
			const env = inspect()?.options.env as NodeJS.ProcessEnv;
			expect(env.PATH).toBe('/usr/bin');
			expect(env.MAESTRO_CLAUDE_BIN).toBe('/opt/claude');
		});

		it('forces BROWSER to a no-op so an expired-token account can never pop the OAuth browser', async () => {
			// A read-only `/usage` probe must stay OAuth-silent: claude's URL opener
			// uses $BROWSER as the launch command and does not fall back to the
			// system opener, so a no-op here makes the consent flow open nothing on
			// an unattended background refresh tick. Regressing this silently
			// re-pops authorization windows.
			process.env.BROWSER = '/usr/bin/open-a-real-browser';
			const inspect = primeSuccess(wireEnvelope());
			await sampleUsage({ binPath: '/bin/maestro-p.js', cwd: '/tmp' });
			const env = inspect()?.options.env as NodeJS.ProcessEnv;
			expect(env.BROWSER).toBe('/usr/bin/true');
		});

		it('sets ELECTRON_RUN_AS_NODE=1 so the Electron execPath runs maestro-p as Node', async () => {
			// Without this, a packaged app would spawn a second GUI instance
			// instead of executing the maestro-p script, and --status would
			// never produce a snapshot.
			const inspect = primeSuccess(wireEnvelope());
			await sampleUsage({ binPath: '/bin/maestro-p.js', cwd: '/tmp' });
			const env = inspect()?.options.env as NodeJS.ProcessEnv;
			expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
		});

		it('prepends the in-asar node_modules to NODE_PATH when packaged (resourcesPath set)', async () => {
			// Must be the in-asar path, NOT app.asar.unpacked: node-pty rewrites
			// `app.asar` -> `app.asar.unpacked` once to find its spawn-helper, so
			// handing it the already-unpacked path double-applies the replace and
			// the helper exec fails with "posix_spawn failed: No such file or
			// directory" (silently broke every packaged Claude usage sample).
			const originalResourcesPath = process.resourcesPath;
			Object.defineProperty(process, 'resourcesPath', {
				value: '/Apps/Maestro.app/Contents/Resources',
				configurable: true,
			});
			process.env.NODE_PATH = '/pre/existing';
			try {
				const inspect = primeSuccess(wireEnvelope());
				await sampleUsage({ binPath: '/bin/maestro-p.js', cwd: '/tmp' });
				const env = inspect()?.options.env as NodeJS.ProcessEnv;
				const asar = asarNodePath('/Apps/Maestro.app/Contents/Resources');
				expect(env.NODE_PATH).toBe(`${asar}${path.delimiter}/pre/existing`);
			} finally {
				Object.defineProperty(process, 'resourcesPath', {
					value: originalResourcesPath,
					configurable: true,
				});
			}
		});

		it('leaves NODE_PATH untouched in dev (no resourcesPath)', async () => {
			const originalResourcesPath = process.resourcesPath;
			Object.defineProperty(process, 'resourcesPath', {
				value: '',
				configurable: true,
			});
			delete process.env.NODE_PATH;
			try {
				const inspect = primeSuccess(wireEnvelope());
				await sampleUsage({ binPath: '/bin/maestro-p.js', cwd: '/tmp' });
				const env = inspect()?.options.env as NodeJS.ProcessEnv;
				expect(env.NODE_PATH).toBeUndefined();
			} finally {
				Object.defineProperty(process, 'resourcesPath', {
					value: originalResourcesPath,
					configurable: true,
				});
			}
		});

		it('lets explicit configDir win over customEnvVars.CLAUDE_CONFIG_DIR', async () => {
			const inspect = primeSuccess(wireEnvelope());
			await sampleUsage({
				binPath: '/bin/maestro-p.js',
				cwd: '/tmp',
				configDir: '/Users/test/.claude-explicit',
				customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-smuggled' },
			});
			const env = inspect()?.options.env as NodeJS.ProcessEnv;
			expect(env.CLAUDE_CONFIG_DIR).toBe('/Users/test/.claude-explicit');
		});

		it('keys the snapshot by resolved configDir, not the wire echo', async () => {
			// Wire echoes a different path than what the wrapper actually used;
			// the snapshot must follow the wrapper's resolved env, not the
			// wire's echo. This protects against path-form drift across hosts.
			primeSuccess(wireEnvelope({ config_dir: '/echoed/by/binary/that/we/ignore' }));
			const snap = await sampleUsage({
				binPath: '/bin/maestro-p.js',
				cwd: '/tmp',
				configDir: '/Users/test/.claude-gmail',
			});
			expect(snap?.configDirKey).toBe(canonKey('/Users/test/.claude-gmail'));
		});

		it('canonicalizes a configDir with redundant separators in the key', async () => {
			primeSuccess(wireEnvelope());
			const snap = await sampleUsage({
				binPath: '/bin/maestro-p.js',
				cwd: '/tmp',
				configDir: '/Users/test/./.claude-smash/',
			});
			expect(snap?.configDirKey).toBe(canonKey('/Users/test/.claude-smash'));
		});

		it('falls back to ~/.claude when no configDir and no env var', async () => {
			delete process.env.CLAUDE_CONFIG_DIR;
			primeSuccess(wireEnvelope());
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js', cwd: '/tmp' });
			expect(snap?.configDirKey).toBe(canonKey(path.join(os.homedir(), '.claude')));
		});

		it('lets customEnvVars.CLAUDE_CONFIG_DIR drive the key when configDir is omitted', async () => {
			primeSuccess(wireEnvelope());
			const snap = await sampleUsage({
				binPath: '/bin/maestro-p.js',
				cwd: '/tmp',
				customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-via-env' },
			});
			expect(snap?.configDirKey).toBe(canonKey('/Users/test/.claude-via-env'));
		});
	});

	describe('tolerance', () => {
		it('tolerates a leading node deprecation warning on stdout', async () => {
			const noisy =
				'(node:1234) DeprecationWarning: Buffer() is deprecated\n' +
				'(Use `node --trace-deprecation ...` to show where the warning was created)\n' +
				wireEnvelope();
			primeSuccess(noisy);
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js', cwd: '/tmp' });
			expect(snap?.session.percent).toBe(42);
		});

		it('tolerates whitespace before the JSON line', async () => {
			primeSuccess(`   ${wireEnvelope()}`);
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js', cwd: '/tmp' });
			expect(snap).not.toBeNull();
		});

		it('ignores stderr content entirely (only stdout drives parsing)', async () => {
			primeSuccess(wireEnvelope(), 'some random stderr output');
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js', cwd: '/tmp' });
			expect(snap).not.toBeNull();
		});
	});

	describe('failure modes - never throw, always return null', () => {
		it('returns null on ENOENT (binary missing)', async () => {
			primeFailure(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
			const snap = await sampleUsage({ binPath: '/nope.js', cwd: '/tmp' });
			expect(snap).toBeNull();
			expect(captureMessageMock).toHaveBeenCalledWith(
				'maestro-p --status sample failed',
				'warning',
				expect.objectContaining({ stage: 'spawn', reason: 'ENOENT' })
			);
		});

		it('returns null on EACCES', async () => {
			primeFailure(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
			const snap = await sampleUsage({ binPath: '/locked.js', cwd: '/tmp' });
			expect(snap).toBeNull();
			expect(captureMessageMock).toHaveBeenCalledWith(
				'maestro-p --status sample failed',
				'warning',
				expect.objectContaining({ stage: 'spawn', reason: 'EACCES' })
			);
		});

		it('returns null on timeout (killed=true, no code)', async () => {
			const err = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
			primeFailure(err);
			const snap = await sampleUsage({
				binPath: '/bin/maestro-p.js',
				cwd: '/tmp',
				timeoutMs: 1_000,
			});
			expect(snap).toBeNull();
			expect(captureMessageMock).toHaveBeenCalledWith(
				'maestro-p --status sample failed',
				'warning',
				expect.objectContaining({ stage: 'spawn', reason: 'timeout' })
			);
		});

		it('returns null on non-zero exit (code is a number)', async () => {
			primeFailure(Object.assign(new Error('exit 2'), { code: 2 }));
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js', cwd: '/tmp' });
			expect(snap).toBeNull();
			expect(captureMessageMock).toHaveBeenCalledWith(
				'maestro-p --status sample failed',
				'warning',
				expect.objectContaining({ stage: 'spawn', reason: expect.stringContaining('exit') })
			);
		});

		it('returns null on empty stdout', async () => {
			primeSuccess('');
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js', cwd: '/tmp' });
			expect(snap).toBeNull();
			expect(captureMessageMock).toHaveBeenCalledWith(
				'maestro-p --status sample failed',
				'warning',
				expect.objectContaining({ stage: 'parse', reason: 'empty stdout' })
			);
		});

		it('returns null when stdout has only non-JSON noise', async () => {
			primeSuccess('this is not json\nneither is this\n');
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js', cwd: '/tmp' });
			expect(snap).toBeNull();
			expect(captureMessageMock).toHaveBeenCalledWith(
				'maestro-p --status sample failed',
				'warning',
				expect.objectContaining({ stage: 'parse' })
			);
		});

		it('returns null on malformed JSON', async () => {
			primeSuccess('{ not really json }\n');
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js', cwd: '/tmp' });
			expect(snap).toBeNull();
			expect(captureMessageMock).toHaveBeenCalledWith(
				'maestro-p --status sample failed',
				'warning',
				expect.objectContaining({ stage: 'parse', reason: expect.stringMatching(/json parse/) })
			);
		});

		it('returns null when type is not status', async () => {
			primeSuccess(wireEnvelope({ type: 'something-else' }));
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js', cwd: '/tmp' });
			expect(snap).toBeNull();
		});

		it('returns null when session window is missing', async () => {
			primeSuccess(wireEnvelope({ session: undefined }));
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js', cwd: '/tmp' });
			expect(snap).toBeNull();
		});

		it('returns null when a percent field is a string', async () => {
			primeSuccess(
				wireEnvelope({
					session: { percent: '42' as unknown as number, resets_at: '2026-05-15T17:00:00.000Z' },
				})
			);
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js', cwd: '/tmp' });
			expect(snap).toBeNull();
		});

		it('returns null when a resets_at field is missing', async () => {
			primeSuccess(
				wireEnvelope({
					week_all_models: { percent: 50 } as unknown as { percent: number; resets_at: string },
				})
			);
			const snap = await sampleUsage({ binPath: '/bin/maestro-p.js', cwd: '/tmp' });
			expect(snap).toBeNull();
		});
	});

	describe('Sentry payload safety', () => {
		it('does not include the full env or full stdout in the Sentry breadcrumb', async () => {
			primeSuccess('totally not json that mentions secret_token=abc123\n');
			await sampleUsage({
				binPath: '/bin/maestro-p.js',
				cwd: '/tmp',
				customEnvVars: { SECRET: 'should-not-leak' },
			});
			expect(captureMessageMock).toHaveBeenCalledTimes(1);
			const extras = captureMessageMock.mock.calls[0][2] as Record<string, unknown>;
			expect(Object.keys(extras).sort()).toEqual(['binPath', 'configDir', 'reason', 'stage']);
			// And no field carries any whiff of the stdout body or env values.
			for (const value of Object.values(extras)) {
				expect(String(value)).not.toContain('secret_token');
				expect(String(value)).not.toContain('should-not-leak');
			}
		});

		it('uses the explicit configDir in the breadcrumb when provided', async () => {
			primeSuccess('garbage\n');
			await sampleUsage({
				binPath: '/bin/maestro-p.js',
				cwd: '/tmp',
				configDir: '/Users/test/.claude-explicit',
			});
			const extras = captureMessageMock.mock.calls[0][2] as Record<string, unknown>;
			expect(extras.configDir).toBe('/Users/test/.claude-explicit');
		});

		it('falls back to ~/.claude in the breadcrumb when configDir is omitted', async () => {
			primeSuccess('garbage\n');
			await sampleUsage({ binPath: '/bin/maestro-p.js', cwd: '/tmp' });
			const extras = captureMessageMock.mock.calls[0][2] as Record<string, unknown>;
			expect(extras.configDir).toBe(path.join(os.homedir(), '.claude'));
		});
	});
});
