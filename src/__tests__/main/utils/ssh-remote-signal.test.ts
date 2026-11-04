import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockSpawn = vi.fn();
vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return { ...actual, spawn: (...args: unknown[]) => mockSpawn(...args) };
});
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import {
	buildRemoteSignalScript,
	newRemotePidFilePath,
	signalRemoteAgent,
	sshConnectionArgs,
	withRemotePidRecord,
} from '../../../main/utils/ssh-remote-signal';
import { reserveWorktreeCleanup } from '../../../main/git/worktreeActivity';
import { captureException } from '../../../main/utils/sentry';

// `spawn` is mocked above; the real-bash tests below need the real one.
const { spawn: realSpawn, spawnSync } =
	await vi.importActual<typeof import('child_process')>('child_process');

const STDIN_SHELL = ['/bin/bash', '--norc', '--noprofile', '-s'];
const hasBash = process.platform !== 'win32' && fs.existsSync('/bin/bash');

describe('sshConnectionArgs', () => {
	it('strips the stdin remote shell and keeps the connection', () => {
		expect(sshConnectionArgs(['-o', 'BatchMode=yes', 'u@h', ...STDIN_SHELL])).toEqual([
			'-o',
			'BatchMode=yes',
			'u@h',
		]);
	});

	it('refuses anything that is not a stdin-script spawn', () => {
		expect(sshConnectionArgs(['u@h', '/bin/bash'])).toBeNull();
		expect(sshConnectionArgs(STDIN_SHELL)).toBeNull();
		expect(sshConnectionArgs(['u@h', ...STDIN_SHELL, 'extra'])).toBeNull();
	});
});

describe('signalRemoteAgent', () => {
	let children: EventEmitter[];
	let reservations: Array<() => void>;
	const target = {
		sshCommand: '/usr/bin/ssh',
		sshArgs: ['-o', 'ControlMaster=auto', 'u@h', ...STDIN_SHELL],
		pidFile: '/tmp/maestro-agent-x.pid',
		sessionId: 's-ai-t',
	};

	beforeEach(() => {
		mockSpawn.mockReset();
		vi.mocked(captureException).mockClear();
		children = [];
		reservations = [];
	});

	afterEach(async () => {
		for (const child of children) {
			child.emit('exit', 0);
			child.emit('close', 0);
		}
		for (const release of reservations) release();
		await Promise.resolve();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function fakeChild() {
		const child = Object.assign(new EventEmitter(), {
			stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
			kill: vi.fn(),
			unref: vi.fn(),
		});
		children.push(child);
		return child;
	}

	async function reserve(root = process.cwd()) {
		const hold = await reserveWorktreeCleanup(root);
		if (hold.status === 'reserved-partially') reservations.push(hold.release);
		expect(hold.status).toBe('reserved-partially');
		if (hold.status !== 'reserved-partially') throw new Error('Expected partial reservation');
		expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
		return hold;
	}

	it('reuses the agent connection and sends the signal script on stdin', () => {
		const child = fakeChild();
		mockSpawn.mockReturnValue(child);

		const sent = signalRemoteAgent(
			{
				sshCommand: '/usr/bin/ssh',
				sshArgs: ['-o', 'ControlMaster=auto', 'u@h', ...STDIN_SHELL],
				pidFile: '/tmp/maestro-agent-x.pid',
				sessionId: 's-ai-t',
			},
			'interrupt'
		);

		expect(sent).toBe(true);
		const [cmd, args, opts] = mockSpawn.mock.calls[0];
		expect(cmd).toBe('/usr/bin/ssh');
		expect(args).toEqual(['-o', 'ControlMaster=auto', 'u@h', ...STDIN_SHELL]);
		expect(opts.detached).toBe(true);
		expect(opts.stdio).toEqual(['pipe', 'ignore', 'ignore']);
		expect(child.stdin.end).toHaveBeenCalledWith(
			buildRemoteSignalScript('/tmp/maestro-agent-x.pid', 'interrupt')
		);
		expect(child.unref).toHaveBeenCalled();
	});

	it('does nothing for args it cannot reconnect with', () => {
		expect(
			signalRemoteAgent(
				{ sshCommand: 'ssh', sshArgs: ['u@h', 'claude'], pidFile: '/tmp/x', sessionId: 's' },
				'terminate'
			)
		).toBe(false);
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it('never throws when ssh cannot be spawned', () => {
		mockSpawn.mockImplementation(() => {
			throw new Error('ENOENT');
		});
		expect(
			signalRemoteAgent(
				{ sshCommand: 'ssh', sshArgs: ['u@h', ...STDIN_SHELL], pidFile: '/tmp/x', sessionId: 's' },
				'interrupt'
			)
		).toBe(false);
	});

	it.each([process.cwd(), path.join(process.cwd(), 'src'), os.tmpdir()])(
		'refuses before target access, native setup or recovery under %s',
		async (root) => {
			const hold = await reserve(root);
			const access = vi.fn(() => target.sshArgs);
			for (const mode of ['interrupt', 'terminate'] as const)
				expect(() =>
					signalRemoteAgent(
						{
							...target,
							get sshArgs() {
								return access();
							},
						},
						mode
					)
				).toThrow(/reserved/);
			expect(access).not.toHaveBeenCalled();
			expect(mockSpawn).not.toHaveBeenCalled();
			expect(captureException).not.toHaveBeenCalled();
			hold.release();
			(await reserve()).release();
		}
	);

	it.each(['interrupt', 'terminate'] as const)(
		'holds %s through exit/error/unref until independent close',
		async (mode) => {
			const child = fakeChild();
			mockSpawn.mockReturnValue(child);
			expect(signalRemoteAgent(target, mode)).toBe(true);
			child.stdin.emit('error', new Error('EPIPE'));
			child.emit('error', new Error('connection failed'));
			child.emit('exit', 255);
			expect(child.unref).toHaveBeenCalledOnce();
			expect(await reserveWorktreeCleanup(process.cwd())).toMatchObject({
				status: 'blocked',
				blockers: [{ code: 'mutation-busy' }],
			});
			child.emit('close', 255);
			(await reserve()).release();
		}
	);

	it.each(['success', 'throw'])('holds beyond a timeout kill %s until close', async (outcome) => {
		vi.useFakeTimers();
		const child = fakeChild();
		if (outcome === 'throw')
			child.kill.mockImplementation(() => {
				throw new Error('gone');
			});
		mockSpawn.mockReturnValue(child);
		expect(signalRemoteAgent(target, 'terminate')).toBe(true);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
		expect(await reserveWorktreeCleanup(process.cwd())).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});
		child.emit('close', null);
		(await reserve()).release();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(['stdin', 'unref'] as const)(
		'holds a false post-spawn verdict after %s setup failure',
		async (failure) => {
			const child = fakeChild();
			const fail = () => {
				throw new Error('setup failed');
			};
			if (failure === 'stdin') child.stdin.end.mockImplementation(fail);
			else child.unref.mockImplementation(fail);
			mockSpawn.mockReturnValue(child);
			expect(signalRemoteAgent(target, 'interrupt')).toBe(false);
			expect(await reserveWorktreeCleanup(process.cwd())).toMatchObject({
				status: 'blocked',
				blockers: [{ code: 'mutation-busy' }],
			});
			child.emit('close', 1);
			(await reserve()).release();
		}
	);

	it('retains both concurrent signal children and blocks late calls under reservation', async () => {
		const first = fakeChild();
		const second = fakeChild();
		mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
		expect(signalRemoteAgent(target, 'interrupt')).toBe(true);
		expect(signalRemoteAgent({ ...target, sessionId: 'replacement' }, 'terminate')).toBe(true);
		second.emit('close', 0);
		expect(await reserveWorktreeCleanup(process.cwd())).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});
		first.emit('close', 0);
		await reserve();
		expect(() => signalRemoteAgent(target, 'terminate')).toThrow(/reserved/);
		expect(mockSpawn).toHaveBeenCalledTimes(2);
	});

	it('releases no-child refusal, synchronous spawn failure and target setup failure', async () => {
		expect(signalRemoteAgent({ ...target, sshArgs: ['u@h', 'claude'] }, 'interrupt')).toBe(false);
		(await reserve()).release();
		mockSpawn.mockImplementation(() => {
			throw new Error('ENOENT');
		});
		expect(signalRemoteAgent(target, 'interrupt')).toBe(false);
		(await reserve()).release();
		expect(() =>
			signalRemoteAgent(
				{
					...target,
					get sshArgs(): string[] {
						throw new Error('target failed');
					},
				},
				'interrupt'
			)
		).toThrow('target failed');
		(await reserve()).release();
	});

	it('releases close racing a final setup failure without leaking activity', async () => {
		const child = fakeChild();
		child.stdin.end.mockImplementation(() => {
			child.emit('close', 0);
		});
		child.unref.mockImplementation(() => {
			throw new Error('unref failed');
		});
		mockSpawn.mockReturnValue(child);
		expect(signalRemoteAgent(target, 'interrupt')).toBe(false);
		(await reserve()).release();
	});

	it('retains unknown ownership when a child handle or close observer is unavailable', async () => {
		// Fresh module instances isolate the intentionally unreleasable holds.
		vi.resetModules();
		const adapter = await import('../../../main/utils/ssh-remote-signal');
		const gate = await import('../../../main/git/worktreeActivity');
		mockSpawn.mockReturnValueOnce(undefined);
		expect(adapter.signalRemoteAgent(target, 'interrupt')).toBe(false);
		expect(await gate.reserveWorktreeCleanup(process.cwd())).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});
		vi.resetModules();
		const nextAdapter = await import('../../../main/utils/ssh-remote-signal');
		const nextGate = await import('../../../main/git/worktreeActivity');
		const child = fakeChild();
		vi.spyOn(child, 'on').mockImplementation(() => {
			throw new Error('observer failed');
		});
		mockSpawn.mockReturnValueOnce(child);
		expect(nextAdapter.signalRemoteAgent(target, 'terminate')).toBe(false);
		child.emit('close', 0);
		expect(await nextGate.reserveWorktreeCleanup(process.cwd())).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});
	});
});

// The scripts run on a remote host we cannot reach in CI, so run them under the
// local bash against a real process instead. That is what proves the shell is
// right: the pid record, the recycled-pid guard, and the group signal.
describe.skipIf(!hasBash)('remote scripts under a real bash', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-remote-signal-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	/** Start `bash -s` the way sshd does: as a session leader, reading the script on stdin. */
	function launch(pidFile: string) {
		const child = realSpawn('/bin/bash', ['--norc', '--noprofile', '-s'], {
			detached: true,
			stdio: ['pipe', 'ignore', 'ignore'],
		});
		child.stdin!.end(withRemotePidRecord('exec sleep 30\n', pidFile));
		return child;
	}

	async function waitFor(check: () => boolean, ms = 3000) {
		const end = Date.now() + ms;
		while (!check()) {
			if (Date.now() > end) throw new Error('timed out');
			await new Promise((r) => setTimeout(r, 25));
		}
	}

	function runScript(script: string) {
		return spawnSync('/bin/bash', ['--norc', '--noprofile', '-s'], { input: script });
	}

	it('records the pid of the exec-ed agent and interrupts it', async () => {
		const pidFile = path.join(dir, 'agent.pid');
		const child = launch(pidFile);
		const exited = new Promise<NodeJS.Signals | null>((r) => child.on('exit', (_c, s) => r(s)));

		await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').includes(' '));
		expect(Number(fs.readFileSync(pidFile, 'utf8').split(' ')[0])).toBe(child.pid);

		runScript(buildRemoteSignalScript(pidFile, 'interrupt'));
		expect(await exited).toBe('SIGINT');
	});

	it('terminates the agent and removes the pid file', async () => {
		const pidFile = path.join(dir, 'agent.pid');
		const child = launch(pidFile);
		const exited = new Promise<NodeJS.Signals | null>((r) => child.on('exit', (_c, s) => r(s)));
		await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').includes(' '));

		runScript(buildRemoteSignalScript(pidFile, 'terminate'));

		expect(await exited).toBe('SIGTERM');
		expect(fs.existsSync(pidFile)).toBe(false);
	});

	it('refuses a pid whose start time no longer matches (recycled pid)', async () => {
		const pidFile = path.join(dir, 'agent.pid');
		const child = launch(pidFile);
		await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').includes(' '));
		fs.writeFileSync(pidFile, `${child.pid} Thu Jan  1 00:00:00 1970\n`);

		runScript(buildRemoteSignalScript(pidFile, 'terminate'));

		expect(child.exitCode).toBeNull();
		expect(child.signalCode).toBeNull();
		process.kill(-child.pid!, 'SIGKILL');
	});

	it('exits quietly when there is no pid file', () => {
		const result = runScript(buildRemoteSignalScript(path.join(dir, 'missing.pid'), 'interrupt'));
		expect(result.status).toBe(0);
	});
});

describe('withRemotePidRecord', () => {
	it('sweeps day-old records before writing its own, then runs the script', () => {
		const out = withRemotePidRecord('exec claude\n', '/tmp/maestro-agent-a.pid');
		const lines = out.split('\n');
		expect(lines[0]).toBe(
			"find /tmp -maxdepth 1 -name 'maestro-agent-*.pid' -mmin +1440 -delete 2>/dev/null"
		);
		expect(lines[1]).toContain("> '/tmp/maestro-agent-a.pid'");
		expect(out.endsWith('exec claude\n')).toBe(true);
	});
});

describe('newRemotePidFilePath', () => {
	it('is unique per spawn', () => {
		expect(newRemotePidFilePath()).not.toBe(newRemotePidFilePath());
	});
});
