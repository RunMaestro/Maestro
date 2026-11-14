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
vi.mock('../../../shared/maestro-lib/host', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../shared/maestro-lib/host')>()),
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../../../shared/maestro-lib/host';
import { stopProcess } from '../../../shared/maestro-lib/control/termination';

import {
	__resetPendingRemoteReapsForTest,
	buildPreLaunchReapScript,
	buildRemoteSignalScript,
	newRemotePidFilePath,
	reapRemoteAgent,
	signalRemoteAgent,
	sshConnectionArgs,
	takePendingRemoteReaps,
	withRemotePidRecord,
} from '../../../main/utils/ssh-remote-signal';

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
	beforeEach(() => {
		mockSpawn.mockReset();
		vi.clearAllMocks();
	});

	function fakeChild() {
		return Object.assign(new EventEmitter(), {
			stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
			kill: vi.fn(),
			unref: vi.fn(),
		});
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
		expect(child.stdin.end).toHaveBeenCalledWith(
			buildRemoteSignalScript('/tmp/maestro-agent-x.pid', 'interrupt')
		);
		expect(child.unref).toHaveBeenCalled();
	});

	it.each(['exit', 'error', 'throw'] as const)(
		'reports unreachable-host %s as failure without exposing the private script',
		(event) => {
			const child = fakeChild();
			const target = {
				sshCommand: 'ssh',
				sshArgs: ['u@h', ...STDIN_SHELL],
				pidFile: newRemotePidFilePath(true),
				sessionId: 'synthetic-session',
				promptArtifactPath: '/tmp/private-prompt-fixture.json',
			};
			const script = buildRemoteSignalScript(
				target.pidFile,
				'terminate',
				target.promptArtifactPath
			);
			const error = new Error(`unreachable ${target.promptArtifactPath} ${script}`);
			mockSpawn.mockImplementation(() => {
				if (event === 'throw') throw error;
				return child;
			});
			expect(signalRemoteAgent(target, 'terminate')).toBe(event !== 'throw');
			if (event !== 'throw') {
				expect(child.stdin.end).toHaveBeenCalledWith(script);
				expect(mockSpawn.mock.calls[0][1]).toEqual(target.sshArgs);
				child.stdin.emit('error', error);
				if (event === 'exit') child.emit('exit', 255);
				else child.emit('error', error);
			}
			expect(logger.warn).toHaveBeenCalledOnce();
			expect(logger.info).not.toHaveBeenCalled();
			const logs = JSON.stringify(vi.mocked(logger.warn).mock.calls);
			for (const privateValue of [target.promptArtifactPath, target.pidFile, script]) {
				expect(logs).not.toContain(privateValue);
			}
		}
	);

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

	it('reports the exit code once, and null when ssh errors', () => {
		const target = {
			sshCommand: 'ssh',
			sshArgs: ['u@h', ...STDIN_SHELL],
			pidFile: '/tmp/x',
			sessionId: 's',
		};
		const exited = fakeChild();
		mockSpawn.mockReturnValueOnce(exited);
		const onExit = vi.fn();
		signalRemoteAgent(target, 'terminate', onExit);
		exited.emit('exit', 255);
		exited.emit('exit', 0);
		expect(onExit).toHaveBeenCalledOnce();
		expect(onExit).toHaveBeenCalledWith(255);

		const errored = fakeChild();
		mockSpawn.mockReturnValueOnce(errored);
		const onError = vi.fn();
		signalRemoteAgent(target, 'terminate', onError);
		errored.emit('error', new Error('EAGAIN'));
		errored.emit('exit', null);
		expect(onError).toHaveBeenCalledOnce();
		expect(onError).toHaveBeenCalledWith(null);
	});
});

describe('reapRemoteAgent', () => {
	const target = {
		sshCommand: 'ssh',
		sshArgs: ['u@h', ...STDIN_SHELL],
		pidFile: '/tmp/maestro-agent-reap.pid',
		sessionId: 'agent-ai-tab',
	};
	const children: Array<EventEmitter & { stdin: EventEmitter }> = [];

	beforeEach(() => {
		vi.useFakeTimers();
		mockSpawn.mockReset();
		vi.clearAllMocks();
		children.length = 0;
		mockSpawn.mockImplementation(() => {
			const child = Object.assign(new EventEmitter(), {
				stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
				kill: vi.fn(),
				unref: vi.fn(),
			});
			children.push(child);
			return child;
		});
	});
	afterEach(() => {
		__resetPendingRemoteReapsForTest();
		vi.useRealTimers();
	});

	it('retries while ssh cannot reach the host, then stops once it answers', () => {
		reapRemoteAgent(target, [1_000, 2_000]);
		expect(children).toHaveLength(1);

		children[0].emit('exit', 255);
		vi.advanceTimersByTime(999);
		expect(children).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(children).toHaveLength(2);

		children[1].emit('exit', 0);
		vi.advanceTimersByTime(60_000);
		expect(children).toHaveLength(2);
		expect(takePendingRemoteReaps(target.sessionId)).toEqual([]);
	});

	it('treats a timed-out signal ssh as unreached', () => {
		reapRemoteAgent(target, [1_000]);
		children[0].emit('exit', null);
		vi.advanceTimersByTime(1_000);
		expect(children).toHaveLength(2);
	});

	it('stops at once when the host ran the script, whatever it answered', () => {
		reapRemoteAgent(target, [1_000]);
		children[0].emit('exit', 1);
		vi.advanceTimersByTime(60_000);
		expect(children).toHaveLength(1);
	});

	it('gives up when every delay is spent', () => {
		reapRemoteAgent(target, [1_000]);
		children[0].emit('exit', 255);
		vi.advanceTimersByTime(1_000);
		children[1].emit('exit', 255);
		vi.advanceTimersByTime(60_000);
		expect(children).toHaveLength(2);
		expect(takePendingRemoteReaps(target.sessionId)).toEqual([]);
		expect(logger.warn).toHaveBeenCalledWith(
			'Gave up stopping a remote agent: its host never answered',
			expect.any(String),
			expect.objectContaining({ sessionId: target.sessionId })
		);
	});

	it('hands a pending reap to the next launch and stops retrying it', () => {
		const promptOwner = {
			...target,
			pidFile: newRemotePidFilePath(true),
			promptArtifactPath: '/tmp/private-prompt-fixture.json',
		};
		const otherTab = {
			...target,
			pidFile: '/tmp/maestro-agent-other.pid',
			sessionId: 'agent-ai-x',
		};
		reapRemoteAgent(target, [1_000]);
		reapRemoteAgent(promptOwner, [1_000]);
		reapRemoteAgent(otherTab, [1_000]);
		for (const child of children) child.emit('exit', 255);

		expect(takePendingRemoteReaps(target.sessionId)).toEqual([target]);
		expect(takePendingRemoteReaps(target.sessionId)).toEqual([]);

		vi.advanceTimersByTime(1_000);
		// The taken reap is gone; the prompt owner and the other tab still retry.
		expect(children).toHaveLength(5);
	});

	it('builds nothing when no reap is pending', () => {
		expect(buildPreLaunchReapScript([])).toBe('');
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
	function launch(pidFile: string, script = 'exec sleep 30\n', promptArtifactPath?: string) {
		const child = realSpawn('/bin/bash', ['--norc', '--noprofile', '-s'], {
			detached: true,
			env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
			stdio: ['pipe', 'ignore', 'ignore'],
		});
		child.stdin!.end(withRemotePidRecord(script, pidFile, promptArtifactPath));
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
		return spawnSync('/bin/bash', ['--norc', '--noprofile', '-s'], {
			input: script,
			timeout: 7000,
			env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
		});
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

	it.skipIf(process.platform !== 'linux')(
		'keeps a pre-record cancellation tombstone against delayed launch',
		async () => {
			const pidFile = newRemotePidFilePath(true);
			const artifact = path.join(dir, 'never-created.json');
			try {
				expect(runScript(buildRemoteSignalScript(pidFile, 'terminate', artifact)).status).toBe(1);
				expect(fs.statSync(`${pidFile}.cancel`).size).toBe(0);
				const child = launch(pidFile, 'printf late > "$_maestro_prompt_path"', artifact);
				await waitFor(() => child.exitCode !== null);
				expect(child.exitCode).toBe(1);
				expect(fs.existsSync(artifact)).toBe(false);
				expect(fs.existsSync(pidFile)).toBe(false);
			} finally {
				fs.rmSync(`${pidFile}.cancel`, { force: true });
			}
		}
	);

	it.skipIf(process.platform !== 'linux').each(['owned', 'recycled', 'replaced'] as const)(
		'checks descriptor ownership before hard-stop cleanup: %s',
		async (ownership) => {
			const pidFile = newRemotePidFilePath(true);
			const artifact = path.join(dir, 'private-prompt.json');
			const child = launch(
				pidFile,
				[
					'exec 9> "$_maestro_prompt_path"',
					"trap '' INT TERM",
					"printf 'synthetic prompt' >&9",
					'while :; do sleep 1; done',
				].join('\n'),
				artifact
			);
			try {
				await waitFor(
					() => fs.existsSync(artifact) && fs.readFileSync(artifact, 'utf8') === 'synthetic prompt'
				);
				if (ownership === 'recycled') {
					fs.writeFileSync(pidFile, `${child.pid} Thu Jan 1 00:00:00 1970\n`);
				} else if (ownership === 'replaced') {
					fs.renameSync(artifact, path.join(dir, 'owned-inode.json'));
					fs.writeFileSync(artifact, 'unowned replacement');
				}
				const result = runScript(buildRemoteSignalScript(pidFile, 'terminate', artifact));
				expect(result.error).toBeUndefined();
				expect(result.status).toBe(ownership === 'recycled' ? 1 : 0);
				expect(result.stdout.toString() + result.stderr.toString()).toBe('');
				if (ownership === 'owned') expect(fs.existsSync(artifact)).toBe(false);
				else
					expect(fs.readFileSync(artifact, 'utf8')).toBe(
						ownership === 'recycled' ? 'synthetic prompt' : 'unowned replacement'
					);
				expect(fs.existsSync(pidFile)).toBe(ownership === 'recycled');
				expect(fs.statSync(`${pidFile}.cancel`).mode & 0o777).toBe(0o600);
			} finally {
				stopProcess({ child }, { from: 'kill', graceMs: 0, immediate: true });
				await waitFor(() => child.exitCode !== null || child.signalCode !== null);
				fs.rmSync(pidFile, { force: true });
				fs.rmSync(`${pidFile}.cancel`, { force: true });
			}
		},
		20_000
	);

	it('exits quietly when there is no pid file', () => {
		const result = runScript(buildRemoteSignalScript(path.join(dir, 'missing.pid'), 'interrupt'));
		expect(result.status).toBe(0);
	});

	it('stops an orphaned agent before the next launch starts its own', async () => {
		const orphanPid = path.join(dir, 'orphan.pid');
		const orphan = launch(orphanPid);
		const orphanExit = new Promise<NodeJS.Signals | null>((r) =>
			orphan.on('exit', (_c, s) => r(s))
		);
		await waitFor(
			() => fs.existsSync(orphanPid) && fs.readFileSync(orphanPid, 'utf8').includes(' ')
		);

		const nextPid = path.join(dir, 'next.pid');
		const marker = path.join(dir, 'launched');
		const prefix = buildPreLaunchReapScript([
			{ sshCommand: 'ssh', sshArgs: [], pidFile: orphanPid, sessionId: 's' },
			{ sshCommand: 'ssh', sshArgs: [], pidFile: path.join(dir, 'gone.pid'), sessionId: 's' },
		]);
		const next = realSpawn('/bin/bash', ['--norc', '--noprofile', '-s'], {
			detached: true,
			env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
			stdio: ['pipe', 'ignore', 'ignore'],
		});
		// The reap's `exit` stays in its subshell, and it reads none of the
		// script bash is still reading, so the launch runs to its own agent.
		next.stdin!.end(
			prefix + withRemotePidRecord(`printf ok > '${marker}'\nexec sleep 30\n`, nextPid)
		);
		try {
			expect(await orphanExit).toBe('SIGTERM');
			await waitFor(() => fs.existsSync(marker));
			expect(fs.existsSync(orphanPid)).toBe(false);
			expect(Number(fs.readFileSync(nextPid, 'utf8').split(' ')[0])).toBe(next.pid);
			expect(next.exitCode).toBeNull();
		} finally {
			process.kill(-next.pid!, 'SIGKILL');
		}
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
