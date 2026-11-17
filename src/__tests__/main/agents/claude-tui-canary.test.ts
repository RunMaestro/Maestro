/**
 * @file claude-tui-canary.test.ts
 * @description Tests for src/main/agents/claude-tui-canary.ts: when the canary
 * is due, how it reads a maestro-p run, and what it records and raises.
 *
 * child_process, the probe-folder helpers, the usage store, and electron-store
 * are mocked: no claude or maestro-p ever runs.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecFile, captureMessageMock, getAllSnapshotsMock, storeData } = vi.hoisted(() => ({
	mockExecFile: vi.fn(),
	captureMessageMock: vi.fn(),
	getAllSnapshotsMock: vi.fn(),
	storeData: new Map<string, unknown>(),
}));

vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return { ...actual, default: { ...actual, execFile: mockExecFile }, execFile: mockExecFile };
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
	return { ...actual, default: { ...actual, promisify: wrap }, promisify: wrap };
});

vi.mock('electron-store', () => ({
	default: class {
		get(key: string) {
			return storeData.get(key);
		}
		set(key: string, value: unknown) {
			storeData.set(key, value);
		}
	},
}));

vi.mock('../../../main/utils/sentry', () => ({ captureMessage: captureMessageMock }));

vi.mock('../../../main/stores/claudeUsageStore', () => ({
	getAllSnapshots: getAllSnapshotsMock,
}));

vi.mock('../../../main/agents/claude-usage-sampler', () => ({
	buildMaestroPProbeEnv: (vars: Record<string, string>, configDir: string) => ({
		...vars,
		CLAUDE_CONFIG_DIR: configDir,
	}),
	ensureUsageProbeDir: async () => '/tmp/maestro-claude-usage-probe',
	ensurePrivateProbeDir: async () => '/tmp/maestro-claude-canary-extra',
}));

vi.mock('../../../main/agents/claude-usage-startup', () => ({
	getMaestroPBinPath: () => '/app/maestro-p.js',
}));

import {
	ClaudeTuiCanary,
	interpretCanaryOutput,
	isCanaryDue,
	parseClaudeVersion,
} from '../../../main/agents/claude-tui-canary';
import type { ClaudeTuiCanaryResult } from '../../../shared/claudeTuiCanary';

const SUCCESS_STDOUT = [
	JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
	JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }),
].join('\n');

const FAILURE_STDOUT = JSON.stringify({
	type: 'result',
	subtype: 'error_during_execution',
	is_error: true,
	error: 'startup_dialog_blocked',
	last_screen: 'A new gate\n\n❯ No, exit',
});

function lastResult(overrides: Partial<ClaudeTuiCanaryResult> = {}): ClaudeTuiCanaryResult {
	return {
		claudeVersion: '2.1.326',
		maestroVersion: '1.2.0',
		checkedAt: 1,
		durationMs: 1,
		configDir: '/Users/test/.claude-a',
		ok: true,
		exitCode: 0,
		...overrides,
	};
}

/** Route `claude --version` and the maestro-p run to canned answers. */
function stubRuns(run: { stdout: string; exitCode?: number }): void {
	mockExecFile.mockImplementation(
		(
			_cmd: string,
			args: string[],
			_opts: unknown,
			cb: (err: Error | null, stdout: string, stderr: string) => void
		) => {
			if (args[0] === '--version') {
				cb(null, '2.1.326 (Claude Code)\n', '');
				return;
			}
			if (run.exitCode && run.exitCode !== 0) {
				const err = Object.assign(new Error('exit'), { code: run.exitCode, stdout: run.stdout });
				cb(err, run.stdout, '');
				return;
			}
			cb(null, run.stdout, '');
		}
	);
}

function makeCanary() {
	const notifyToast = vi.fn();
	const canary = new ClaudeTuiCanary({
		agentDetector: {
			getAgent: vi.fn(async () => ({ available: true, path: '/bin/claude', command: 'claude' })),
		} as never,
		maestroVersion: '1.2.0',
		notifyToast,
	});
	return { canary, notifyToast };
}

beforeEach(() => {
	mockExecFile.mockReset();
	captureMessageMock.mockReset();
	storeData.clear();
	getAllSnapshotsMock.mockReturnValue({
		'/Users/test/.claude-a': { sampledAt: '2026-11-17T10:00:00Z', authState: 'authenticated' },
		'/Users/test/.claude-b': { sampledAt: '2026-11-17T11:00:00Z', authState: 'authenticated' },
		'/Users/test/.claude-c': { sampledAt: '2026-11-17T12:00:00Z', authState: 'unauthenticated' },
	});
});

describe('parseClaudeVersion()', () => {
	it('reads the version out of claude --version', () => {
		expect(parseClaudeVersion('2.1.326 (Claude Code)\n')).toBe('2.1.326');
	});

	it('is null for output with no version', () => {
		expect(parseClaudeVersion('command not found')).toBeNull();
	});
});

describe('isCanaryDue()', () => {
	it('is due when it never ran', () => {
		expect(isCanaryDue(undefined, '2.1.326', '1.2.0')).toBe(true);
	});

	it('is due when Claude Code or Maestro changed', () => {
		expect(isCanaryDue(lastResult(), '2.1.327', '1.2.0')).toBe(true);
		expect(isCanaryDue(lastResult(), '2.1.326', '1.2.1')).toBe(true);
	});

	it('is not due again for the same versions, passed or failed', () => {
		expect(isCanaryDue(lastResult(), '2.1.326', '1.2.0')).toBe(false);
		expect(isCanaryDue(lastResult({ ok: false }), '2.1.326', '1.2.0')).toBe(false);
	});
});

describe('interpretCanaryOutput()', () => {
	it('passes a successful result envelope', () => {
		expect(interpretCanaryOutput(SUCCESS_STDOUT, 0)).toEqual({ ok: true, exitCode: 0 });
	});

	it('reads the failure code and screen off a failed envelope', () => {
		expect(interpretCanaryOutput(FAILURE_STDOUT, 11)).toEqual({
			ok: false,
			error: 'startup_dialog_blocked',
			exitCode: 11,
			screen: 'A new gate\n\n❯ No, exit',
		});
	});

	it('fails a run that never reported', () => {
		expect(interpretCanaryOutput('', null)).toEqual({
			ok: false,
			error: 'no_result',
			exitCode: null,
		});
	});
});

describe('ClaudeTuiCanary.check()', () => {
	it('runs on the newest authenticated account with the agent-shaped flags', async () => {
		stubRuns({ stdout: SUCCESS_STDOUT });
		const { canary, notifyToast } = makeCanary();

		const outcome = await canary.check();

		expect(outcome).toMatchObject({ ran: true, result: { ok: true, claudeVersion: '2.1.326' } });
		const run = mockExecFile.mock.calls.find((call) => call[1][0] === '/app/maestro-p.js');
		expect(run?.[1]).toEqual(
			expect.arrayContaining([
				'--dangerously-skip-permissions',
				'--add-dir',
				'/tmp/maestro-claude-canary-extra',
			])
		);
		expect(run?.[2]).toMatchObject({
			cwd: '/tmp/maestro-claude-usage-probe',
			env: { CLAUDE_CONFIG_DIR: '/Users/test/.claude-b', MAESTRO_CLAUDE_BIN: '/bin/claude' },
		});
		expect(notifyToast).not.toHaveBeenCalled();
		expect(canary.getLastResult()?.ok).toBe(true);
	});

	it('raises a sticky red toast and a Sentry message when the turn fails', async () => {
		stubRuns({ stdout: FAILURE_STDOUT, exitCode: 11 });
		const { canary, notifyToast } = makeCanary();

		const outcome = await canary.check();

		expect(outcome).toMatchObject({
			ran: true,
			result: { ok: false, error: 'startup_dialog_blocked' },
		});
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'red', dismissible: true })
		);
		expect(captureMessageMock).toHaveBeenCalledWith(
			'Claude TUI canary failed',
			'warning',
			expect.not.objectContaining({ screen: expect.anything() })
		);
		expect(canary.getLastResult()?.screen).toBe('A new gate\n\n❯ No, exit');
	});

	it('says so when Claude Code works again after a failure', async () => {
		storeData.set('last', lastResult({ ok: false, claudeVersion: '2.1.325' }));
		stubRuns({ stdout: SUCCESS_STDOUT });
		const { canary, notifyToast } = makeCanary();

		await canary.check();

		expect(notifyToast).toHaveBeenCalledWith(expect.objectContaining({ color: 'green' }));
	});

	it('does not run again for versions already checked, unless forced', async () => {
		storeData.set('last', lastResult());
		stubRuns({ stdout: SUCCESS_STDOUT });
		const { canary } = makeCanary();

		expect(await canary.check()).toMatchObject({ ran: false });
		expect(await canary.check({ force: true })).toMatchObject({ ran: true });
	});

	it('does not run without an authenticated account', async () => {
		getAllSnapshotsMock.mockReturnValue({});
		stubRuns({ stdout: SUCCESS_STDOUT });
		const { canary } = makeCanary();

		expect(await canary.check()).toMatchObject({ ran: false });
		expect(mockExecFile.mock.calls.some((call) => call[1][0] === '/app/maestro-p.js')).toBe(false);
	});

	it('shares one run between concurrent checks', async () => {
		stubRuns({ stdout: SUCCESS_STDOUT });
		const { canary } = makeCanary();

		const [a, b] = await Promise.all([canary.check(), canary.check()]);

		expect(a).toBe(b);
		expect(
			mockExecFile.mock.calls.filter((call) => call[1][0] === '/app/maestro-p.js')
		).toHaveLength(1);
	});
});
