import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import type { ExecResult } from '../../../main/utils/execFile';

vi.mock('fs/promises', async (original) => {
	const actual = await original<typeof import('fs/promises')>();
	return { ...actual, default: { ...actual, realpath: vi.fn() } };
});
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../main/utils/processTree', () => ({ killQuiet: vi.fn(() => true) }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({ logger: { warn: vi.fn() } }));
import { execFileNoThrow } from '../../../main/utils/execFile';
import { killQuiet } from '../../../main/utils/processTree';
import { captureException } from '../../../main/utils/sentry';
import { logger } from '../../../main/utils/logger';

describe('command-runner straggler sweep activity', () => {
	const target = path.resolve('command-sweep-target');
	const pid = 4242;
	const empty = { stdout: '', stderr: '', exitCode: 0 };
	let gate: typeof import('../../../main/git/worktreeActivity');
	let sweep: typeof import('../../../main/process-manager/utils/commandKill').sweepStragglers;
	let natives: Array<{
		child: EventEmitter;
		result: ReturnType<typeof Promise.withResolvers<ExecResult>>;
	}>;
	let releases: Array<() => void>;
	const drain = () => new Promise(setImmediate);
	async function reserve(root = target) {
		const hold = await gate.reserveWorktreeCleanup(root);
		if (hold.status === 'reserved-partially') releases.push(hold.release);
		expect(hold.status).toBe('reserved-partially');
		if (hold.status !== 'reserved-partially') throw new Error('Expected partial reservation');
		expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
		return hold;
	}
	async function blocked() {
		const hold = await gate.reserveWorktreeCleanup(target);
		if (hold.status === 'reserved-partially') releases.push(hold.release);
		expect(hold).toMatchObject({ status: 'blocked', blockers: [{ code: 'mutation-busy' }] });
	}
	beforeEach(async () => {
		vi.resetModules();
		vi.mocked(fs.realpath)
			.mockReset()
			.mockImplementation(async (p) => String(p));
		vi.mocked(killQuiet).mockReset().mockReturnValue(true);
		vi.mocked(captureException).mockReset().mockResolvedValue(undefined);
		vi.mocked(logger.warn).mockReset();
		natives = [];
		releases = [];
		vi.mocked(execFileNoThrow)
			.mockReset()
			.mockImplementation((_cmd, _args, _cwd, _opts, observe) => {
				const child = new EventEmitter();
				child.on('error', () => {});
				const result = Promise.withResolvers<ExecResult>();
				natives.push({ child, result });
				observe?.(child as Parameters<NonNullable<typeof observe>>[0]);
				return result.promise;
			});
		gate = await import('../../../main/git/worktreeActivity');
		({ sweepStragglers: sweep } = await import('../../../main/process-manager/utils/commandKill'));
	});
	afterEach(async () => {
		for (const release of releases) release();
		for (const native of natives) {
			native.result.resolve(empty);
			native.child.emit('close');
		}
		await drain();
		vi.restoreAllMocks();
	});

	it.each([target, path.join(target, 'descendant'), path.resolve('other-repository')])(
		'refuses before command setup, signals or recovery under %s',
		async (root) => {
			await reserve(root);
			expect(() => sweep(pid)).toThrow(/reserved/);
			for (const work of [execFileNoThrow, killQuiet, captureException, logger.warn]) {
				expect(work).not.toHaveBeenCalled();
			}
		}
	);
	it('admits synchronously while a reservation is canonicalizing', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = gate.reserveWorktreeCleanup(target);
		sweep(pid);
		canonical.resolve(target);
		await expect(reservation).resolves.toMatchObject({ status: 'blocked' });
		await blocked();
		natives[0].result.resolve(empty);
		await drain();
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});
	it('preserves argv, executor defaults, void return, PID filtering and SIGKILL', async () => {
		expect(sweep(pid)).toBeUndefined();
		expect(execFileNoThrow).toHaveBeenCalledWith(
			'ps',
			['-eo', 'pid=,ppid='],
			undefined,
			undefined,
			expect.any(Function)
		);
		natives[0].result.resolve({
			stdout: ` 9001 ${pid}\n9002 1\n0 ${pid}\nbad ${pid}\n9003 ${pid}\n`,
			stderr: '',
			exitCode: 0,
		});
		await drain();
		expect(vi.mocked(killQuiet).mock.calls).toEqual([
			[9001, 'SIGKILL'],
			[9003, 'SIGKILL'],
		]);
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});
	it.each(['result', 'error', 'exit', 'rejection'])(
		'does not mistake %s for native close',
		async (event) => {
			sweep(pid);
			if (event === 'error') natives[0].child.emit('error', new Error('timeout'));
			if (event === 'exit') natives[0].child.emit('exit', 1);
			if (event === 'rejection') natives[0].result.reject(new Error('execution failed'));
			else natives[0].result.resolve(empty);
			await drain();
			await blocked();
			natives[0].child.emit('close');
			await reserve();
		}
	);
	it('holds result processing when native close arrives first', async () => {
		sweep(pid);
		natives[0].child.emit('close');
		await blocked();
		natives[0].result.resolve({ ...empty, stdout: `9001 ${pid}` });
		await drain();
		expect(killQuiet).toHaveBeenCalledWith(9001, 'SIGKILL');
		await reserve();
	});
	it('keeps concurrent sweeps independent, including duplicate close', async () => {
		sweep(pid);
		sweep(pid + 1);
		for (const native of natives) native.result.resolve(empty);
		await drain();
		natives[0].child.emit('close');
		natives[0].child.emit('close');
		await blocked();
		natives[1].child.emit('close');
		await reserve();
	});
	it.each([false, true])('retains async failure reporting, rejection=%s', async (rejectReport) => {
		const report = Promise.withResolvers<void>();
		vi.mocked(captureException).mockReturnValueOnce(report.promise);
		sweep(pid);
		natives[0].child.emit('close');
		natives[0].result.reject(new Error('execution failed'));
		await drain();
		expect(captureException).toHaveBeenCalledWith(new Error('execution failed'));
		await blocked();
		if (rejectReport) report.reject(new Error('report failed'));
		else report.resolve();
		await drain();
		expect(logger.warn).toHaveBeenCalledTimes(rejectReport ? 1 : 0);
		await reserve();
	});
	it('retains callback failure reporting after native close', async () => {
		const report = Promise.withResolvers<void>();
		vi.mocked(captureException).mockReturnValueOnce(report.promise);
		vi.mocked(killQuiet).mockImplementationOnce(() => {
			throw new Error('signal callback failed');
		});
		sweep(pid);
		natives[0].child.emit('close');
		natives[0].result.resolve({ ...empty, stdout: `9001 ${pid}` });
		await drain();
		expect(captureException).toHaveBeenCalledWith(new Error('signal callback failed'));
		await blocked();
		report.resolve();
		await drain();
		await reserve();
	});
	it('preserves a synchronous setup error and retains unknown launch state', async () => {
		vi.mocked(execFileNoThrow).mockImplementationOnce(() => {
			throw new Error('unknown launch');
		});
		expect(() => sweep(pid)).toThrow('unknown launch');
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(killQuiet).not.toHaveBeenCalled();
		await blocked();
	});
	it('keeps successful results without native observation blocked', async () => {
		vi.mocked(execFileNoThrow).mockResolvedValueOnce(empty);
		sweep(pid);
		await drain();
		await blocked();
	});
	it('keeps missing native handles blocked', async () => {
		vi.mocked(execFileNoThrow).mockImplementationOnce((_cmd, _args, _cwd, _opts, observe) => {
			observe?.(undefined as unknown as Parameters<NonNullable<typeof observe>>[0]);
			return Promise.resolve(empty);
		});
		expect(() => sweep(pid)).toThrow();
		await blocked();
	});
	it('keeps failed observer installation blocked even after result and close', async () => {
		vi.mocked(execFileNoThrow).mockImplementationOnce((_cmd, _args, _cwd, _opts, observe) => {
			const child = new EventEmitter();
			vi.spyOn(child, 'once').mockImplementationOnce(() => {
				throw new Error('observer unavailable');
			});
			const result = Promise.withResolvers<ExecResult>();
			natives.push({ child, result });
			observe?.(child as Parameters<NonNullable<typeof observe>>[0]);
			return result.promise;
		});
		expect(() => sweep(pid)).toThrow('observer unavailable');
		natives[0].result.resolve(empty);
		natives[0].child.emit('close');
		await drain();
		await blocked();
	});
});
