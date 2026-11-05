import fs from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import * as pty from 'node-pty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('child_process', async (original) => ({
	...(await original<typeof import('child_process')>()),
	spawn: vi.fn(),
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/stores/defaults', () => ({ getDefaultShell: vi.fn(() => 'bash') }));
vi.mock('../../../main/utils/spawnPath', () => ({ buildSpawnPath: vi.fn() }));
vi.mock('../../../main/process-manager/utils/pathResolver', () => ({
	resolveShellPath: vi.fn(),
	buildInteractiveShellArgs: vi.fn(),
	buildWrappedCommand: vi.fn(),
}));
vi.mock('../../../shared/platformDetection', () => ({ isWindows: vi.fn() }));
vi.mock('../../../main/process-manager/utils/commandKill', () => ({
	killProcessTreeNow: vi.fn(),
	sweepStragglers: vi.fn(),
}));

import { logger } from '../../../main/utils/logger';
import { captureException } from '../../../main/utils/sentry';
import { getDefaultShell } from '../../../main/stores/defaults';
import { buildSpawnPath } from '../../../main/utils/spawnPath';
import { resolveShellPath } from '../../../main/process-manager/utils/pathResolver';
import { isWindows } from '../../../shared/platformDetection';
import { killProcessTreeNow } from '../../../main/process-manager/utils/commandKill';

const target = path.resolve('command-cleanup-target');
let gate: typeof import('../../../main/git/worktreeActivity');
let runner: import('../../../main/process-manager/runners/LocalCommandRunner').LocalCommandRunner;
let emitter: EventEmitter;
let native: EventEmitter & {
	pid: number;
	kill: ReturnType<typeof vi.fn>;
	stdout: EventEmitter;
	stderr: EventEmitter;
};

beforeEach(async () => {
	vi.resetModules();
	vi.resetAllMocks();
	vi.mocked(captureException).mockResolvedValue(undefined);
	vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
	vi.mocked(getDefaultShell).mockReturnValue('bash');
	vi.mocked(resolveShellPath).mockReturnValue('/bin/bash');
	vi.mocked(isWindows).mockReturnValue(false);
	native = Object.assign(new EventEmitter(), {
		pid: 12345,
		kill: vi.fn(),
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
	});
	vi.mocked(pty.spawn).mockReturnValue({
		pid: native.pid,
		kill: native.kill,
		onExit: (cb: (event: { exitCode: number }) => void) => native.on('pty-exit', cb),
		onData: (cb: (data: string) => void) => native.on('pty-data', cb),
	} as unknown as pty.IPty);
	vi.mocked(spawn).mockReturnValue(native as unknown as ReturnType<typeof spawn>);
	gate = await import('../../../main/git/worktreeActivity');
	const { LocalCommandRunner } =
		await import('../../../main/process-manager/runners/LocalCommandRunner');
	emitter = new EventEmitter();
	runner = new LocalCommandRunner(emitter);
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
	const hold = await gate.reserveWorktreeCleanup(target);
	if (hold.status === 'reserved-partially') hold.release();
	expect(hold).toMatchObject({
		status: 'blocked',
		blockers: [{ code: 'mutation-busy' }],
	});
}

async function started(windows = false, id = 'session') {
	vi.mocked(isWindows).mockReturnValue(windows);
	const pending = runner.run(id, 'command', target);
	await vi.waitFor(() => expect(windows ? spawn : pty.spawn).toHaveBeenCalled());
	return { pending };
}

describe('local command activity', () => {
	it.each([target, path.join(target, 'child'), path.resolve('unrelated')])(
		'refuses before shell/environment/child setup under reservation %s',
		async (root) => {
			const hold = await reserve(root);
			const readEnv = vi.fn(() => 'value');
			await expect(
				runner.run('session', 'command', 'unknown-cwd', undefined, {
					get VALUE() {
						return readEnv();
					},
				})
			).rejects.toThrow('reserved');
			for (const probe of [
				readEnv,
				getDefaultShell,
				resolveShellPath,
				buildSpawnPath,
				pty.spawn,
				spawn,
				logger.debug,
			])
				expect(probe).not.toHaveBeenCalled();
			expect(() => runner.cancel('session')).toThrow('reserved');
			hold.release();
			const { pending } = await started();
			native.emit('pty-exit', { exitCode: 0 });
			await pending;
			(await reserve()).release();
		}
	);

	it('registers pending start synchronously and retains activity during shell setup', async () => {
		let duringSetup!: Promise<void>;
		vi.mocked(resolveShellPath).mockImplementation(() => {
			duringSetup = blocked();
			return '/bin/bash';
		});
		const pending = runner.run('session', 'command', target);
		expect(resolveShellPath).not.toHaveBeenCalled();
		await blocked();
		await duringSetup;
		await blocked();
		native.emit('pty-exit', { exitCode: 0 });
		await pending;
		(await reserve()).release();
	});

	it('a newly admitted command prevents an in-flight reservation', async () => {
		let canonicalReady!: (value: string) => void;
		vi.mocked(fs.realpath).mockImplementationOnce(
			() =>
				new Promise<string>((resolve) => {
					canonicalReady = resolve;
				})
		);
		const reservation = gate.reserveWorktreeCleanup(target);
		const pending = runner.run('session', 'command', path.join(target, 'descendant'));
		canonicalReady(target);
		expect(await reservation).toMatchObject({ status: 'blocked' });
		await vi.waitFor(() => expect(pty.spawn).toHaveBeenCalledOnce());
		native.emit('pty-exit', { exitCode: 0 });
		await pending;
		(await reserve()).release();
	});

	it('cancels a pending start without spawning or signalling any child', async () => {
		const exit = vi.fn();
		emitter.on('command-exit', exit);
		const pending = runner.run('session', 'command', target);
		expect(runner.cancel('session')).toBe(true);
		await expect(pending).resolves.toEqual({ exitCode: 137 });
		expect(exit).toHaveBeenCalledExactlyOnceWith('session', 137);
		for (const probe of [getDefaultShell, resolveShellPath, pty.spawn, spawn, killProcessTreeNow])
			expect(probe).not.toHaveBeenCalled();
		expect(runner.cancel('session')).toBe(false);
		(await reserve()).release();
	});

	it.each([0, 1, 137])('holds until observed PTY exit %s', async (exitCode) => {
		const { pending } = await started();
		await blocked();
		native.emit('pty-exit', { exitCode });
		await expect(pending).resolves.toEqual({ exitCode });
		(await reserve()).release();
	});

	it('Stop feedback does not release before PTY exit, even after successful kills', async () => {
		const { pending } = await started();
		expect(runner.cancel('session')).toBe(true);
		await expect(pending).resolves.toEqual({ exitCode: 137 });
		expect(killProcessTreeNow).toHaveBeenCalledWith(native.pid, { sessionId: 'session' });
		expect(native.kill).toHaveBeenCalledWith('SIGKILL');
		await blocked();
		native.emit('pty-exit', { exitCode: 137 });
		(await reserve()).release();
	});

	it.each(['exit', 'error', 'cancel'])(
		'Windows %s settles the UI but holds until close',
		async (event) => {
			const { pending } = await started(true);
			if (event === 'cancel') runner.cancel('session');
			else native.emit(event, event === 'exit' ? 0 : new Error('child failed'));
			await expect(pending).resolves.toEqual({
				exitCode: event === 'exit' ? 0 : event === 'error' ? 1 : 137,
			});
			await blocked();
			native.emit('close', 0);
			(await reserve()).release();
		}
	);

	it.each(['shell', 'pty-recoverable', 'pty-fatal', 'windows'])(
		'releases after %s setup/spawn failure',
		async (failure) => {
			const error = new Error(failure === 'pty-recoverable' ? 'permission denied' : 'broken setup');
			if (failure === 'shell')
				vi.mocked(resolveShellPath).mockImplementationOnce(() => {
					throw error;
				});
			else if (failure === 'windows') {
				vi.mocked(isWindows).mockReturnValue(true);
				vi.mocked(spawn).mockImplementationOnce(() => {
					throw error;
				});
			} else
				vi.mocked(pty.spawn).mockImplementationOnce(() => {
					throw error;
				});
			const pending = runner.run('session', 'command', target);
			if (failure === 'pty-recoverable') await expect(pending).resolves.toEqual({ exitCode: 1 });
			else await expect(pending).rejects.toThrow(error.message);
			expect(runner.cancel('session')).toBe(false);
			(await reserve()).release();
		}
	);

	it('does not release a spawned child when listener setup fails', async () => {
		vi.mocked(pty.spawn).mockReturnValue({
			onExit: (cb: (event: { exitCode: number }) => void) => native.on('pty-exit', cb),
			onData: () => {
				throw new Error('listener setup');
			},
		} as unknown as pty.IPty);
		await expect(runner.run('session', 'command', target)).rejects.toThrow('listener setup');
		await blocked();
		native.emit('pty-exit', { exitCode: 0 });
		(await reserve()).release();
	});

	it('releases observed PTY exit even if an exit listener throws', async () => {
		const { pending } = await started();
		emitter.on('command-exit', () => {
			throw new Error('reporting');
		});
		expect(() => native.emit('pty-exit', { exitCode: 0 })).toThrow('reporting');
		await expect(pending).resolves.toEqual({ exitCode: 0 });
		await vi.waitFor(async () => (await reserve()).release());
	});

	it('one completed command cannot release another command activity', async () => {
		const first = await started(false, 'first');
		const second = await started(true, 'second');
		native.emit('pty-exit', { exitCode: 0 });
		await first.pending;
		await blocked();
		native.emit('exit', 0);
		await second.pending;
		await blocked();
		native.emit('close', 0);
		const hold = await reserve();
		// A duplicate old PTY completion cannot clear a later reservation.
		expect(() => native.emit('pty-exit', { exitCode: 0 })).toThrow('reserved');
		await expect(runner.run('late', 'command', target)).rejects.toThrow('reserved');
		hold.release();
	});
});

// Keep direct references to native callbacks after the result and child settle.
async function retained(windows = false) {
	const { pending } = await started(windows);
	const callbacks = windows
		? {
				stdout: () => native.stdout.listeners('data')[0](Buffer.from('output')),
				stderr: () => native.stderr.listeners('data')[0](Buffer.from('error output')),
				exit: () => native.listeners('exit')[0](0),
				error: () => native.listeners('error')[0](Error('native error')),
				close: native.listeners('close')[0] as () => void,
			}
		: {
				stdout: () => native.listeners('pty-data')[0]('output'),
				exit: () => native.listeners('pty-exit')[0]({ exitCode: 0 }),
			};
	callbacks.exit();
	if (windows) callbacks.close!();
	await pending;
	return callbacks;
}

describe('retained local command callbacks', () => {
	it('keeps overlapping late diagnostics independent of a successor command', async () => {
		const callbacks = await retained();
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		// Keep differential runs against the old non-observing source contained.
		void second.promise.catch(() => {});
		vi.mocked(captureException)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		emitter.on('data', () => {
			throw Error('consumer');
		});
		expect(callbacks.stdout).toThrow('consumer');
		expect(callbacks.stdout).toThrow('consumer');
		const successor = await started(true, 'successor');
		first.resolve();
		await blocked();
		second.reject(Error('diagnostic rejection'));
		await blocked();
		native.emit('exit', 0);
		await successor.pending;
		await blocked();
		native.emit('close', 0);
		await vi.waitFor(async () => (await reserve()).release());
		expect(captureException).toHaveBeenCalledTimes(2);
	});

	it.each(['pty-data', 'pty-exit', 'stdout', 'stderr', 'exit', 'error', 'close', 'cancel'])(
		'refuses late %s before decoding, logging, consumers, diagnostics or signals',
		async (kind) => {
			const windows = !kind.startsWith('pty-');
			const callbacks = await retained(windows);
			const callback =
				kind === 'cancel'
					? () => runner.cancel('session')
					: kind.startsWith('pty-')
						? callbacks[kind === 'pty-data' ? 'stdout' : 'exit']
						: callbacks[kind as keyof typeof callbacks]!;
			const output = vi.fn();
			emitter.on('data', output).on('stderr', output).on('command-exit', output);
			vi.clearAllMocks();
			const hold = await reserve(path.join(target, 'descendant'));
			try {
				expect(callback).toThrow('reserved');
				for (const probe of [
					output,
					logger.debug,
					logger.error,
					captureException,
					native.kill,
					killProcessTreeNow,
				])
					expect(probe).not.toHaveBeenCalled();
			} finally {
				hold.release();
			}
			expect(callback).not.toThrow();
			(await reserve()).release();
		}
	);

	it.each(['resolve', 'reject', 'throw'])(
		'owns late output diagnostics through reporter %s without replacing the callback error',
		async (outcome) => {
			const callbacks = await retained(true);
			const failure = Error('output consumer');
			emitter.on('data', () => {
				throw failure;
			});
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockImplementationOnce(() => {
				if (outcome === 'throw') throw Error('diagnostic throw');
				return reporting.promise;
			});
			expect(callbacks.stdout).toThrow(failure);
			if (outcome !== 'throw') {
				await blocked();
				if (outcome === 'resolve') reporting.resolve();
				else reporting.reject(Error('diagnostic rejection'));
			}
			await vi.waitFor(async () => (await reserve()).release());
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
		}
	);

	it.each(['resolve', 'reject', 'throw'])(
		'preserves fatal setup error while retaining reporter %s',
		async (outcome) => {
			const failure = Error('fatal PTY setup');
			vi.mocked(pty.spawn).mockImplementationOnce(() => {
				throw failure;
			});
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockImplementationOnce(() => {
				if (outcome === 'throw') throw Error('diagnostic throw');
				return reporting.promise;
			});
			await expect(runner.run('session', 'command', target)).rejects.toThrow(failure);
			if (outcome !== 'throw') {
				await blocked();
				if (outcome === 'resolve') reporting.resolve();
				else reporting.reject(Error('diagnostic rejection'));
			}
			await vi.waitFor(async () => (await reserve()).release());
			expect(captureException).toHaveBeenCalledOnce();
			expect(captureException).toHaveBeenCalledWith(
				failure,
				expect.objectContaining({ operation: 'process-runner:pty-spawn' })
			);
		}
	);

	it.each([false, true])(
		'retains native and diagnostic ownership independently (native first: %s)',
		async (nativeFirst) => {
			const { pending } = await started(true);
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			emitter.on('stderr', () => {
				throw Error('stderr consumer');
			});
			expect(() => native.stderr.emit('data', Buffer.from('error'))).toThrow('stderr consumer');
			native.emit('exit', 0);
			await pending;
			if (nativeFirst) native.emit('close', 0);
			else {
				reporting.resolve();
				await Promise.resolve();
			}
			await blocked();
			if (nativeFirst) reporting.resolve();
			else native.emit('close', 0);
			await vi.waitFor(async () => (await reserve()).release());
		}
	);

	it('blocks a pending reservation when a retained callback begins reporting', async () => {
		const callbacks = await retained();
		let canonical!: (value: string) => void;
		vi.mocked(fs.realpath).mockImplementationOnce(
			() =>
				new Promise<string>((resolve) => {
					canonical = resolve;
				})
		);
		const reservation = gate.reserveWorktreeCleanup(target);
		const reporting = Promise.withResolvers<void>();
		vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
		emitter.on('data', () => {
			throw Error('late callback');
		});
		expect(callbacks.stdout).toThrow('late callback');
		canonical(target);
		const result = await reservation;
		if (result.status === 'reserved-partially') result.release();
		expect(result.status).toBe('blocked');
		await blocked();
		reporting.resolve();
		await vi.waitFor(async () => (await reserve()).release());
	});

	it.each([false, true])(
		'keeps same-session successor cancellation and native ownership (Windows: %s)',
		async (windows) => {
			const first = await started(windows);
			const firstExit = native.listeners(windows ? 'exit' : 'pty-exit')[0];
			const firstClose = native.listeners('close')[0] as (() => void) | undefined;
			const second = await started(windows);
			firstExit(windows ? 0 : { exitCode: 0 });
			await first.pending;
			firstClose?.();
			expect(runner.cancel('session')).toBe(true);
			await expect(second.pending).resolves.toEqual({ exitCode: 137 });
			await blocked();
			native.emit(windows ? 'exit' : 'pty-exit', windows ? 137 : { exitCode: 137 });
			if (windows) native.emit('close', 137);
			(await reserve()).release();
		}
	);

	it.each([false, true])(
		'settles exit despite throwing consumer and owns reporting (Windows: %s)',
		async (windows) => {
			const { pending } = await started(windows);
			const reporting = Promise.withResolvers<void>();
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			emitter.on('command-exit', () => {
				throw Error('exit consumer');
			});
			expect(() =>
				native.emit(windows ? 'exit' : 'pty-exit', windows ? 0 : { exitCode: 0 })
			).toThrow('exit consumer');
			await expect(pending).resolves.toEqual({ exitCode: 0 });
			if (windows) native.emit('close', 0);
			await blocked();
			reporting.reject(Error('diagnostic rejection'));
			await vi.waitFor(async () => (await reserve()).release());
			expect(captureException).toHaveBeenCalledOnce();
		}
	);
});
