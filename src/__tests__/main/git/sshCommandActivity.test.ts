import fs from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshRemoteConfig } from '../../../shared/types';

vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));
vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/cliDetection', () => ({
	resolveSshPath: vi.fn(),
	getExpandedEnv: vi.fn(() => ({})),
}));
vi.mock('../../../main/process-manager/utils/commandKill', () => ({
	killProcessTreeNow: vi.fn(),
}));

import { logger } from '../../../main/utils/logger';
import { resolveSshPath, getExpandedEnv } from '../../../main/utils/cliDetection';
import { killProcessTreeNow } from '../../../main/process-manager/utils/commandKill';

const target = path.resolve('ssh-cleanup-target');
const sshPath = path.resolve('bin', 'ssh');
const config: SshRemoteConfig = {
	id: 'remote',
	name: 'Remote',
	host: 'remote-host',
	username: 'user',
	port: 22,
	privateKeyPath: '',
	enabled: true,
};
let gate: typeof import('../../../main/git/worktreeActivity');
let runner: import('../../../main/process-manager/runners/SshCommandRunner').SshCommandRunner;
let emitter: EventEmitter;
let native: ReturnType<typeof makeNative>;

function makeNative() {
	return Object.assign(new EventEmitter(), {
		pid: 12345 as number | undefined,
		kill: vi.fn(),
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
	});
}

beforeEach(async () => {
	vi.resetModules();
	vi.resetAllMocks();
	vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
	vi.mocked(resolveSshPath).mockResolvedValue(sshPath);
	native = makeNative();
	vi.mocked(spawn).mockReturnValue(native as unknown as ReturnType<typeof spawn>);
	gate = await import('../../../main/git/worktreeActivity');
	const { SshCommandRunner } =
		await import('../../../main/process-manager/runners/SshCommandRunner');
	emitter = new EventEmitter();
	runner = new SshCommandRunner(emitter);
});

afterEach(() => vi.restoreAllMocks());

async function reserve(root = target) {
	const hold = await gate.reserveWorktreeCleanup(root);
	expect(hold.status).toBe('reserved-partially');
	if (hold.status !== 'reserved-partially') throw new Error('Reservation failed');
	expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
	return hold;
}

async function blocked() {
	expect(await gate.reserveWorktreeCleanup(target)).toMatchObject({
		status: 'blocked',
		blockers: [{ code: 'mutation-busy' }],
	});
}

function run(id = 'session') {
	return runner.run(id, 'command', '~/remote-project', config);
}

async function started() {
	const pending = run();
	await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
	return { pending };
}

describe('SSH command activity', () => {
	it.each([target, path.join(target, 'child'), path.resolve('unrelated')])(
		'refuses before SSH arguments, environment, binary or child setup under reservation %s',
		async (root) => {
			const hold = await reserve(root);
			const readConfig = vi.fn(() => 'key');
			await expect(
				runner.run('session', 'command', '~/remote', {
					...config,
					get privateKeyPath() {
						return readConfig();
					},
				})
			).rejects.toThrow('reserved');
			expect(readConfig).not.toHaveBeenCalled();
			expect(resolveSshPath).not.toHaveBeenCalled();
			expect(getExpandedEnv).not.toHaveBeenCalled();
			expect(spawn).not.toHaveBeenCalled();
			expect(runner.cancel('session')).toBe(false);
			hold.release();
			(await reserve()).release();
		}
	);

	it('blocks globally during pending SSH resolution and cancels before native setup', async () => {
		let finish!: (value: string) => void;
		vi.mocked(resolveSshPath).mockImplementationOnce(
			() =>
				new Promise((r) => {
					finish = r;
				})
		);
		const pending = run();
		await blocked();
		expect(fs.realpath).toHaveBeenCalledTimes(1); // Only the local reservation, never remote cwd.
		expect(runner.cancel('session')).toBe(true);
		await blocked();
		finish(sshPath);
		await expect(pending).resolves.toEqual({ exitCode: 137 });
		expect(getExpandedEnv).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
		expect(runner.cancel('session')).toBe(false);
		(await reserve()).release();
	});

	it('wins admission while an earlier reservation is resolving its target', async () => {
		let finish!: (value: string) => void;
		vi.mocked(fs.realpath).mockImplementationOnce(
			() =>
				new Promise((r) => {
					finish = r;
				})
		);
		const reservation = gate.reserveWorktreeCleanup(target);
		const { pending } = await started();
		finish(target);
		expect(await reservation).toMatchObject({ status: 'blocked' });
		native.emit('exit', 0);
		await pending;
		native.emit('close', 0);
		(await reserve()).release();
	});

	it.each(['arguments', 'binary', 'environment'])(
		'releases proven pre-native %s failure',
		async (phase) => {
			if (phase === 'arguments')
				vi.mocked(logger.info).mockImplementationOnce(() => {
					throw Error('setup');
				});
			if (phase === 'binary') vi.mocked(resolveSshPath).mockRejectedValueOnce(Error('setup'));
			if (phase === 'environment')
				vi.mocked(getExpandedEnv).mockImplementationOnce(() => {
					throw Error('setup');
				});
			await expect(run()).rejects.toThrow('setup');
			expect(spawn).not.toHaveBeenCalled();
			expect(runner.cancel('session')).toBe(false);
			(await reserve()).release();
		}
	);

	it.each(['exit', 'error', 'cancel'])(
		'retains activity after %s result until local close',
		async (event) => {
			const { pending } = await started();
			if (event === 'cancel') {
				expect(runner.cancel('session')).toBe(true);
				expect(killProcessTreeNow).toHaveBeenCalledWith(native.pid, { sessionId: 'session' });
			} else native.emit(event, event === 'error' ? Error('ssh failed') : 0);
			await pending;
			expect(runner.cancel('session')).toBe(false);
			await blocked();
			native.emit('close', 0);
			(await reserve()).release();
		}
	);

	it('retains a close observed before the operation result settles', async () => {
		const { pending } = await started();
		native.emit('close', 0);
		await blocked();
		native.emit('exit', 0);
		await pending;
		(await reserve()).release();
	});

	it('removes its cancel handle before notifying synchronous completion listeners', async () => {
		emitter.on('command-exit', () => expect(runner.cancel('session')).toBe(false));
		const { pending } = await started();
		native.emit('exit', 0);
		await pending;
		await blocked();
		native.emit('close', 0);
		(await reserve()).release();
	});

	it('tracks a child without a pid through error and actual close', async () => {
		native.pid = undefined;
		const { pending } = await started();
		native.emit('error', Error('ENOENT'));
		await expect(pending).resolves.toEqual({ exitCode: 1 });
		await blocked();
		native.emit('close', -1);
		(await reserve()).release();
	});

	it('retains uncertainty if native invocation throws without a returned observer', async () => {
		vi.mocked(spawn).mockImplementationOnce(() => {
			throw Error('native unknown');
		});
		await expect(run()).rejects.toThrow('native unknown');
		await blocked();
	});

	it('retains uncertainty if a close observer cannot be installed', async () => {
		vi.spyOn(native, 'on').mockImplementationOnce(() => {
			throw Error('observer');
		});
		await expect(run()).rejects.toThrow('observer');
		native.emit('close', 0);
		await blocked();
	});

	it('keeps a child alive in activity after stream listener setup throws', async () => {
		vi.spyOn(native.stdout, 'on').mockImplementationOnce(() => {
			throw Error('stream');
		});
		await expect(run()).rejects.toThrow('stream');
		await blocked();
		native.emit('close', 0);
		(await reserve()).release();
	});

	it('releases after synchronous close followed by setup failure', async () => {
		vi.spyOn(native, 'on').mockImplementationOnce((event, cb) => {
			expect(event).toBe('close');
			cb();
			return native;
		});
		vi.spyOn(native.stdout, 'on').mockImplementationOnce(() => {
			throw Error('stream');
		});
		await expect(run()).rejects.toThrow('stream');
		(await reserve()).release();
	});

	it.each(['command-exit', 'stderr'])(
		'settles despite a throwing %s reporter while waiting for close',
		async (event) => {
			emitter.on(event, () => {
				throw Error('reporting');
			});
			const { pending } = await started();
			expect(() =>
				native.emit(event === 'stderr' ? 'error' : 'exit', event === 'stderr' ? Error('ssh') : 0)
			).toThrow('reporting');
			await pending;
			await blocked();
			native.emit('close', 0);
			(await reserve()).release();
		}
	);

	it('does not let late predecessor events unregister or release a successor', async () => {
		const { pending: first } = await started();
		const predecessor = native;
		native = makeNative();
		vi.mocked(spawn).mockReturnValueOnce(native as unknown as ReturnType<typeof spawn>);
		const second = run();
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
		predecessor.emit('exit', 0);
		await first;
		predecessor.emit('close', 0);
		predecessor.emit('close', 0);
		expect(runner.cancel('session')).toBe(true);
		await second;
		expect(native.kill).toHaveBeenCalled();
		await blocked();
		native.emit('close', 0);
		(await reserve()).release();
	});

	it('protects a reentrant successor started by command completion', async () => {
		const { pending: first } = await started();
		const successor = makeNative();
		vi.mocked(spawn).mockReturnValueOnce(successor as unknown as ReturnType<typeof spawn>);
		let second!: Promise<unknown>;
		emitter.once('command-exit', () => {
			second = run();
		});
		native.emit('exit', 0);
		await first;
		native.emit('close', 0);
		expect(runner.cancel('session')).toBe(true);
		await second;
		await blocked();
		successor.emit('close', 0);
		(await reserve()).release();
	});

	it('does not let a cancelled pending predecessor replace its successor cancellation', async () => {
		let finish!: (value: string) => void;
		vi.mocked(resolveSshPath).mockImplementationOnce(
			() =>
				new Promise((r) => {
					finish = r;
				})
		);
		const first = run();
		runner.cancel('session');
		const { pending: second } = await started();
		finish(sshPath);
		await expect(first).resolves.toEqual({ exitCode: 137 });
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(runner.cancel('session')).toBe(true);
		await second;
		await blocked();
		native.emit('close', 0);
		(await reserve()).release();
	});

	it('keeps activity if cancellation cannot terminate the child', async () => {
		const { pending } = await started();
		vi.mocked(killProcessTreeNow).mockImplementationOnce(() => {
			throw Error('kill');
		});
		expect(() => runner.cancel('session')).toThrow('kill');
		await blocked();
		native.emit('exit', 0);
		await pending;
		await blocked();
		native.emit('close', 0);
		(await reserve()).release();
	});

	it('preserves SSH output and arguments without probing remote cwd on the local host', async () => {
		const data = vi.fn();
		emitter.on('data', data);
		const { pending } = await started();
		expect(fs.realpath).not.toHaveBeenCalled();
		expect(spawn).toHaveBeenCalledWith(
			sshPath,
			expect.arrayContaining(['-T', 'user@remote-host']),
			expect.not.objectContaining({ cwd: expect.anything() })
		);
		native.stdout.emit('data', Buffer.from('output'));
		expect(data).toHaveBeenCalledWith('session', 'output');
		native.emit('exit', 3);
		await expect(pending).resolves.toEqual({ exitCode: 3 });
		native.emit('close', 3);
		(await reserve()).release();
	});
});
