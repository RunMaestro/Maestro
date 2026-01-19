import { EventEmitter } from 'events';
import { logger } from '../../utils/logger';
import { DATA_BUFFER_FLUSH_INTERVAL, DATA_BUFFER_SIZE_THRESHOLD } from '../constants';
import type { ManagedProcess } from '../types';

/**
 * Manages data buffering for process output to reduce IPC event frequency.
 */
export class DataBufferManager {
	constructor(
		private processes: Map<string, ManagedProcess>,
		private emitter: EventEmitter
	) {}

	/**
	 * Buffer data and emit in batches.
	 * Data is accumulated and flushed every 50ms or when buffer exceeds 8KB.
	 */
	emitDataBuffered(sessionId: string, data: string): void {
		const managedProcess = this.processes.get(sessionId);
		if (!managedProcess) {
			this.emitter.emit('data', sessionId, data);
			return;
		}

		managedProcess.dataBuffer = (managedProcess.dataBuffer || '') + data;

		if (managedProcess.dataBuffer.length > DATA_BUFFER_SIZE_THRESHOLD) {
			this.flushDataBuffer(sessionId);
			return;
		}

		if (!managedProcess.dataBufferTimeout) {
			managedProcess.dataBufferTimeout = setTimeout(() => {
				this.flushDataBuffer(sessionId);
			}, DATA_BUFFER_FLUSH_INTERVAL);
		}
	}

	/**
	 * Flush the data buffer for a session
	 */
	flushDataBuffer(sessionId: string): void {
		const managedProcess = this.processes.get(sessionId);
		if (!managedProcess) return;

		if (managedProcess.dataBufferTimeout) {
			clearTimeout(managedProcess.dataBufferTimeout);
			managedProcess.dataBufferTimeout = undefined;
		}

		if (managedProcess.dataBuffer) {
			try {
				this.emitter.emit('data', sessionId, managedProcess.dataBuffer);
			} catch (err) {
				logger.error('[ProcessManager] Error flushing data buffer', 'ProcessManager', {
					sessionId,
					error: String(err),
				});
			}
			managedProcess.dataBuffer = undefined;
		}
	}
}
