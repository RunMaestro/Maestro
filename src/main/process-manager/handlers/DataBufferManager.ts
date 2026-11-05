import { EventEmitter } from 'events';
import { logger } from '../../utils/logger';
import { DATA_BUFFER_FLUSH_INTERVAL, DATA_BUFFER_SIZE_THRESHOLD } from '../constants';
import type { ManagedProcess } from '../types';
import { captureException } from '../../utils/sentry';
import { beginGlobalWorktreeActivity } from '../../git/worktreeActivity';
import { withWorktreeTurnActivity } from '../../git/worktreeTurnActivity';

/**
 * Manages data buffering for process output to reduce IPC event frequency.
 */
export class DataBufferManager {
	private readonly pendingFlushes = new WeakMap<ManagedProcess, () => void>();

	constructor(
		private processes: Map<string, ManagedProcess>,
		private emitter: EventEmitter
	) {}

	/**
	 * Buffer data and emit in batches.
	 * Data is accumulated and flushed every 50ms or when buffer exceeds 8KB.
	 */
	emitDataBuffered(sessionId: string, data: string, process?: ManagedProcess): void {
		withWorktreeTurnActivity(() => {
			const managedProcess = process ?? this.processes.get(sessionId);
			if (!managedProcess) {
				this.emitter.emit('data', sessionId, data);
				return;
			}

			managedProcess.dataBuffer = (managedProcess.dataBuffer || '') + data;

			if (managedProcess.dataBuffer.length > DATA_BUFFER_SIZE_THRESHOLD) {
				this.flushDataBuffer(sessionId, managedProcess);
				return;
			}

			if (!managedProcess.dataBufferTimeout) {
				// Deferred output can outlive native exit and process-map removal.
				const release = beginGlobalWorktreeActivity();
				this.pendingFlushes.set(managedProcess, release);
				try {
					const timeout = setTimeout(() => {
						withWorktreeTurnActivity(() => {
							// A cleared timer may still have a retained callback. It must
							// not flush or release a later timer on the same process.
							if (managedProcess.dataBufferTimeout !== timeout) return;
							this.flushDataBuffer(sessionId, managedProcess);
						}, captureException);
					}, DATA_BUFFER_FLUSH_INTERVAL);
					managedProcess.dataBufferTimeout = timeout;
				} catch (error) {
					this.pendingFlushes.delete(managedProcess);
					release();
					throw error;
				}
			}
		}, captureException);
	}

	/**
	 * Flush the data buffer for a session
	 */
	flushDataBuffer(sessionId: string, process?: ManagedProcess): void {
		withWorktreeTurnActivity(() => {
			const managedProcess = process ?? this.processes.get(sessionId);
			if (!managedProcess) return;

			if (managedProcess.dataBufferTimeout) {
				clearTimeout(managedProcess.dataBufferTimeout);
				managedProcess.dataBufferTimeout = undefined;
				this.pendingFlushes.get(managedProcess)?.();
				this.pendingFlushes.delete(managedProcess);
			}

			if (managedProcess.dataBuffer) {
				try {
					withWorktreeTurnActivity(() => {
						this.emitter.emit('data', sessionId, managedProcess.dataBuffer);
					}, captureException);
				} catch (err) {
					logger.error('[ProcessManager] Error flushing data buffer', 'ProcessManager', {
						sessionId,
						error: String(err),
					});
				}
				managedProcess.dataBuffer = undefined;
			}
		}, captureException);
	}
}
