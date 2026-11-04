import fs from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import * as pty from 'node-pty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('child_process', () => ({ spawn: vi.fn() }));
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
import { getDefaultShell } from '../../../main/stores/defaults';
import { buildSpawnPath } from '../../../main/utils/spawnPath';
import { resolveShellPath } from '../../../main/process-manager/utils/pathResolver';
import { isWindows } from '../../../shared/platformDetection';
import { killProcessTreeNow } from '../../../main/process-manager/utils/commandKill';

const target = path.resolve('command-cleanup-target');
let gate: typeof import('../../../main/git/worktreeActivity');
let runner: import('../../../main/process-manager/runners/LocalCommandRunner').LocalCommandRunner;
let emitter: EventEmitter;
let native: EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> };

beforeEach(async () => {
	vi.resetModules();
	vi.resetAllMocks();
	vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
	vi.mocked(getDefaultShell).mockReturnValue('bash');
	vi.mocked(resolveShellPath).mockReturnValue('/bin/bash');
	vi.mocked(isWindows).mockReturnValue(false);
	native = Object.assign(new EventEmitter(), { pid: 12345, kill: vi.fn() });
	vi.mocked(pty.spawn).mockReturnValue({
		pid: native.pid,
		kill: native.kill,
		onExit: (cb: (event: { exitCode: number }) => void) => native.on('pty-exit', cb),
		onData: vi.fn(),
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
	expect(await gate.reserveWorktreeCleanup(target)).toMatchObject({
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
			expect(runner.cancel('session')).toBe(false);
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
		// Existing reporting semantics leave the UI promise unsettled; observed exit
		// still releases exclusion. Do not use that UI promise to infer safety.
		void pending;
		(await reserve()).release();
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
		native.emit('pty-exit', { exitCode: 0 });
		await expect(runner.run('late', 'command', target)).rejects.toThrow('reserved');
		hold.release();
	});
});
