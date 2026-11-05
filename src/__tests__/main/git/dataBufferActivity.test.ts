import fs from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedProcess } from '../../../main/process-manager/types';
import {
	DATA_BUFFER_FLUSH_INTERVAL,
	DATA_BUFFER_SIZE_THRESHOLD,
} from '../../../main/process-manager/constants';

vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));
vi.mock('../../../main/utils/logger', () => ({ logger: { error: vi.fn() } }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
import { logger } from '../../../main/utils/logger';
import { captureException } from '../../../main/utils/sentry';

const target = path.resolve('buffer-cleanup-target');
let gate: typeof import('../../../main/git/worktreeActivity');
let buffer: import('../../../main/process-manager/handlers/DataBufferManager').DataBufferManager;
let processes: Map<string, ManagedProcess>;
let process: ManagedProcess;
let emitter: EventEmitter;
let data: ReturnType<typeof vi.fn<() => void>>;

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
	expect(hold).toMatchObject({ status: 'blocked', blockers: [{ code: 'mutation-busy' }] });
}

beforeEach(async () => {
	vi.resetModules();
	vi.resetAllMocks();
	vi.useFakeTimers();
	vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
	gate = await import('../../../main/git/worktreeActivity');
	const { DataBufferManager } =
		await import('../../../main/process-manager/handlers/DataBufferManager');
	process = {
		sessionId: 'session',
		toolType: 'terminal',
		cwd: target,
		pid: 123,
		isTerminal: true,
		startTime: 0,
	};
	processes = new Map([['session', process]]);
	emitter = new EventEmitter();
	data = vi.fn<() => void>();
	emitter.on('data', data);
	buffer = new DataBufferManager(processes, emitter);
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('buffered process output activity', () => {
	it.each([target, path.join(target, 'child'), path.resolve('unrelated')])(
		'refuses standalone calls before lookup, buffering, cancellation or reporting under %s',
		async (root) => {
			const hold = await reserve(root);
			const lookup = vi.spyOn(processes, 'get');
			const timeout = vi.spyOn(globalThis, 'setTimeout');
			process.dataBuffer = 'kept';
			for (const run of [
				() => buffer.emitDataBuffered('session', 'new'),
				() => buffer.emitDataBuffered('missing', 'new'),
				() => buffer.flushDataBuffer('session'),
				() => buffer.flushDataBuffer('session', process),
			])
				expect(run).toThrow('reserved');
			expect(lookup).not.toHaveBeenCalled();
			expect(timeout).not.toHaveBeenCalled();
			expect(data).not.toHaveBeenCalled();
			expect(captureException).not.toHaveBeenCalled();
			expect(logger.error).not.toHaveBeenCalled();
			expect(process.dataBuffer).toBe('kept');
			hold.release();
			buffer.flushDataBuffer('session');
			expect(data).toHaveBeenCalledWith('session', 'kept');
		}
	);

	it('admits before lookup while a reservation is still canonicalizing', async () => {
		const ready = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(ready.promise);
		const pending = gate.reserveWorktreeCleanup(target);
		let duringLookup!: ReturnType<typeof gate.reserveWorktreeCleanup>;
		vi.spyOn(processes, 'get').mockImplementationOnce(() => {
			duringLookup = gate.reserveWorktreeCleanup(target);
			return process;
		});
		buffer.emitDataBuffered('session', 'queued');
		ready.resolve(target);
		for (const hold of await Promise.all([pending, duringLookup])) {
			if (hold.status === 'reserved-partially') hold.release();
			expect(hold).toMatchObject({ status: 'blocked' });
		}
		buffer.flushDataBuffer('session');
		(await reserve()).release();
	});

	it('owns one batching timer after native map removal and until deferred emission', async () => {
		buffer.emitDataBuffered('session', 'one');
		buffer.emitDataBuffered('session', 'two');
		expect(vi.getTimerCount()).toBe(1);
		processes.clear();
		await blocked();
		await vi.advanceTimersByTimeAsync(DATA_BUFFER_FLUSH_INTERVAL);
		expect(data).toHaveBeenCalledExactlyOnceWith('session', 'onetwo');
		expect(process.dataBufferTimeout).toBeUndefined();
		(await reserve()).release();
	});

	it.each(['manual', 'threshold'] as const)(
		'releases the timer after %s flush without duplicate emission',
		async (kind) => {
			buffer.emitDataBuffered('session', 'one');
			if (kind === 'manual') buffer.flushDataBuffer('session');
			else buffer.emitDataBuffered('session', 'x'.repeat(DATA_BUFFER_SIZE_THRESHOLD));
			expect(data).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
			(await reserve()).release();
			await vi.advanceTimersByTimeAsync(DATA_BUFFER_FLUSH_INTERVAL);
			expect(data).toHaveBeenCalledTimes(1);
		}
	);

	it('retained timer callbacks refuse before effects and cannot flush or release a replacement timer', async () => {
		const timeout = vi.spyOn(globalThis, 'setTimeout');
		buffer.emitDataBuffered('session', 'old');
		const callback = timeout.mock.calls[0][0] as () => void;
		buffer.flushDataBuffer('session');
		const hold = await reserve();
		expect(callback).toThrow('reserved');
		expect(captureException).not.toHaveBeenCalled();
		hold.release();
		buffer.emitDataBuffered('session', 'new');
		callback();
		expect(process.dataBuffer).toBe('new');
		expect(data).toHaveBeenCalledTimes(1);
		await blocked();
		await vi.advanceTimersByTimeAsync(DATA_BUFFER_FLUSH_INTERVAL);
		expect(data).toHaveBeenLastCalledWith('session', 'new');
		(await reserve()).release();
	});

	it('retains timer ownership on failed cancellation until cancellation actually succeeds', async () => {
		buffer.emitDataBuffered('session', 'queued');
		const failure = new Error('cancel failed');
		const report = Promise.withResolvers<void>();
		vi.mocked(captureException).mockReturnValueOnce(report.promise);
		vi.spyOn(globalThis, 'clearTimeout').mockImplementationOnce(() => {
			throw failure;
		});
		expect(() => buffer.flushDataBuffer('session')).toThrow(failure);
		report.resolve();
		await vi.advanceTimersByTimeAsync(0);
		await blocked();
		buffer.flushDataBuffer('session');
		(await reserve()).release();
	});

	it('failed timer setup releases only the timer while retaining asynchronous diagnostics', async () => {
		const failure = new Error('timer unavailable');
		const report = Promise.withResolvers<void>();
		vi.mocked(captureException).mockReturnValueOnce(report.promise);
		vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(() => {
			throw failure;
		});
		expect(() => buffer.emitDataBuffered('session', 'kept')).toThrow(failure);
		expect(process.dataBufferTimeout).toBeUndefined();
		await blocked();
		report.reject(new Error('report failed'));
		await vi.advanceTimersByTimeAsync(0);
		(await reserve()).release();
		expect(process.dataBuffer).toBe('kept');
	});

	it.each(['manual', 'timer', 'unregistered'] as const)(
		'owns %s consumer diagnostics through resolve, reject and synchronous reporter throw',
		async (kind) => {
			for (const outcome of ['resolve', 'reject', 'throw']) {
				const failure = new Error('consumer failed');
				const report = Promise.withResolvers<void>();
				vi.mocked(captureException).mockImplementationOnce(() => {
					if (outcome === 'throw') throw new Error('reporter threw');
					return report.promise;
				});
				data.mockImplementationOnce(() => {
					throw failure;
				});
				if (kind === 'unregistered') {
					expect(() => buffer.emitDataBuffered('missing', 'data')).toThrow(failure);
				} else {
					buffer.emitDataBuffered('session', 'data');
					if (kind === 'timer') await vi.advanceTimersByTimeAsync(DATA_BUFFER_FLUSH_INTERVAL);
					else expect(() => buffer.flushDataBuffer('session')).not.toThrow();
					expect(process.dataBuffer).toBeUndefined();
				}
				expect(captureException).toHaveBeenLastCalledWith(failure);
				if (outcome !== 'throw') {
					await blocked();
					if (outcome === 'resolve') report.resolve();
					else report.reject(new Error('diagnostic rejected'));
					await vi.advanceTimersByTimeAsync(0);
				}
				(await reserve()).release();
			}
		}
	);

	it('logger failure preserves the synchronous error and owns both reports independently', async () => {
		const consumer = new Error('consumer');
		const logging = new Error('logger');
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		vi.mocked(captureException)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		data.mockImplementationOnce(() => {
			throw consumer;
		});
		vi.mocked(logger.error).mockImplementationOnce(() => {
			throw logging;
		});
		buffer.emitDataBuffered('session', 'kept');
		expect(() => buffer.flushDataBuffer('session')).toThrow(logging);
		expect(vi.mocked(captureException).mock.calls.map(([error]) => error)).toEqual([
			consumer,
			logging,
		]);
		expect(process.dataBuffer).toBe('kept');
		first.resolve();
		await vi.advanceTimersByTimeAsync(0);
		await blocked();
		second.reject(new Error('second report rejected'));
		await vi.advanceTimersByTimeAsync(0);
		(await reserve()).release();
	});

	it('predecessor flush and concurrent diagnostics cannot release a successor timer', async () => {
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		vi.mocked(captureException)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const predecessor = process;
		buffer.emitDataBuffered('session', 'old');
		process = { ...predecessor, pid: 456, dataBuffer: undefined, dataBufferTimeout: undefined };
		processes.set('session', process);
		buffer.emitDataBuffered('session', 'new');
		data.mockImplementation(() => {
			throw new Error('consumer');
		});
		buffer.flushDataBuffer('session', predecessor);
		buffer.emitDataBuffered('session', 'old again', predecessor);
		buffer.flushDataBuffer('session', predecessor);
		expect(process.dataBuffer).toBe('new');
		first.resolve();
		second.resolve();
		await vi.advanceTimersByTimeAsync(0);
		await blocked();
		data.mockReset();
		buffer.flushDataBuffer('session');
		expect(data).toHaveBeenCalledExactlyOnceWith('session', 'new');
		(await reserve()).release();
	});

	it('missing flush and an externally scheduled timer retain existing no-op/cancel behavior', async () => {
		buffer.flushDataBuffer('missing');
		process.dataBufferTimeout = setTimeout(() => {
			throw new Error('must be cancelled');
		}, 50);
		buffer.flushDataBuffer('session');
		expect(vi.getTimerCount()).toBe(0);
		(await reserve()).release();
	});
});
