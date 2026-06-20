import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { DataBufferManager } from '../../main/process-manager/handlers/DataBufferManager';
import type { ManagedProcess } from '../../main/process-manager/types';
import { logger } from '../../main/utils/logger';
import {
	DATA_BUFFER_FLUSH_INTERVAL,
	DATA_BUFFER_SIZE_THRESHOLD,
} from '../../main/process-manager/constants';

vi.mock('../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
	},
}));

function createManagedProcess(overrides: Partial<ManagedProcess> = {}): ManagedProcess {
	return {
		sessionId: 'test-session',
		toolType: 'claude-code',
		cwd: '/tmp',
		pid: 1234,
		isTerminal: false,
		startTime: Date.now(),
		...overrides,
	} as ManagedProcess;
}

function createTestContext(processOverrides?: Partial<ManagedProcess>) {
	const processes = new Map<string, ManagedProcess>();
	const emitter = new EventEmitter();
	const sessionId = 'test-session';
	const proc = createManagedProcess({ sessionId, ...processOverrides });
	processes.set(sessionId, proc);
	const manager = new DataBufferManager(processes, emitter);

	return { processes, emitter, sessionId, proc, manager };
}

describe('DataBufferManager', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('emits data immediately when the session is unknown', () => {
		const { emitter, manager } = createTestContext();
		const dataSpy = vi.fn();
		emitter.on('data', dataSpy);

		manager.emitDataBuffered('missing-session', 'orphan output');

		expect(dataSpy).toHaveBeenCalledWith('missing-session', 'orphan output');
	});

	it('buffers data and flushes it on the timer without scheduling duplicate timeouts', () => {
		const { emitter, sessionId, proc, manager } = createTestContext();
		const dataSpy = vi.fn();
		emitter.on('data', dataSpy);

		manager.emitDataBuffered(sessionId, 'hello');
		const firstTimeout = proc.dataBufferTimeout;
		manager.emitDataBuffered(sessionId, ' world');

		expect(proc.dataBuffer).toBe('hello world');
		expect(proc.dataBufferTimeout).toBe(firstTimeout);
		expect(dataSpy).not.toHaveBeenCalled();

		vi.advanceTimersByTime(DATA_BUFFER_FLUSH_INTERVAL);

		expect(dataSpy).toHaveBeenCalledWith(sessionId, 'hello world');
		expect(proc.dataBuffer).toBeUndefined();
		expect(proc.dataBufferTimeout).toBeUndefined();
	});

	it('flushes immediately when the buffered data exceeds the size threshold', () => {
		const { emitter, sessionId, proc, manager } = createTestContext();
		const dataSpy = vi.fn();
		emitter.on('data', dataSpy);
		const oversizedOutput = 'x'.repeat(DATA_BUFFER_SIZE_THRESHOLD + 1);

		manager.emitDataBuffered(sessionId, oversizedOutput);

		expect(dataSpy).toHaveBeenCalledWith(sessionId, oversizedOutput);
		expect(proc.dataBuffer).toBeUndefined();
		expect(proc.dataBufferTimeout).toBeUndefined();
	});

	it('returns without emitting when flushing an unknown session', () => {
		const { emitter, manager } = createTestContext();
		const dataSpy = vi.fn();
		emitter.on('data', dataSpy);

		manager.flushDataBuffer('missing-session');

		expect(dataSpy).not.toHaveBeenCalled();
	});

	it('clears an existing timeout even when there is no buffered data', () => {
		const timeout = setTimeout(() => {}, 1000);
		const { emitter, sessionId, proc, manager } = createTestContext({
			dataBufferTimeout: timeout,
		});
		const dataSpy = vi.fn();
		emitter.on('data', dataSpy);

		manager.flushDataBuffer(sessionId);

		expect(proc.dataBufferTimeout).toBeUndefined();
		expect(dataSpy).not.toHaveBeenCalled();
	});

	it('logs listener failures and still clears the buffered data', () => {
		const { emitter, sessionId, proc, manager } = createTestContext({
			dataBuffer: 'pending output',
			dataBufferTimeout: setTimeout(() => {}, 1000),
		});
		emitter.on('data', () => {
			throw new Error('listener failed');
		});

		manager.flushDataBuffer(sessionId);

		expect(logger.error).toHaveBeenCalledWith(
			'[ProcessManager] Error flushing data buffer',
			'ProcessManager',
			{
				sessionId,
				error: 'Error: listener failed',
			}
		);
		expect(proc.dataBuffer).toBeUndefined();
		expect(proc.dataBufferTimeout).toBeUndefined();
	});
});
