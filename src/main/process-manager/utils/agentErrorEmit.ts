import type { EventEmitter } from 'events';
import type { AgentError, ManagedProcess } from '../types';
import type { DataBufferManager } from '../handlers/DataBufferManager';

export interface EmitAgentErrorOptions {
	/**
	 * The turn is over, so the partial answer still held in `streamedText` is
	 * the last output it will ever produce. Emit it ahead of the error and mark
	 * the result emitted, so nothing re-emits it after the error. Leave this off
	 * for an error raised mid-stream, where the result is still to come.
	 */
	flushStreamedText?: boolean;
}

/**
 * Emit `agent-error` after every byte of output that preceded it.
 *
 * Output is batched for 50ms (`DataBufferManager`) while an error is emitted at
 * once, so without this the error overtakes the text that came before it. The
 * renderer reads any `data` that arrives after an error as the agent having
 * recovered: it deletes the error card and clears the error state. A failed
 * turn then reads as a finished one, with its partial answer rendered as the
 * reply and no sign anything went wrong. That is how a maestro-p idle timeout
 * (exit 3) showed only "Checking the Wayback Machine..." and stopped.
 */
export function emitAgentErrorAfterOutput(
	emitter: EventEmitter,
	bufferManager: Pick<DataBufferManager, 'emitDataBuffered' | 'flushDataBuffer'>,
	sessionId: string,
	managedProcess: ManagedProcess,
	agentError: AgentError,
	options: EmitAgentErrorOptions = {}
): void {
	if (options.flushStreamedText && !managedProcess.resultEmitted && managedProcess.streamedText) {
		managedProcess.resultEmitted = true;
		bufferManager.emitDataBuffered(sessionId, managedProcess.streamedText, managedProcess);
	}
	bufferManager.flushDataBuffer(sessionId, managedProcess);
	managedProcess.errorEmitted = true;
	emitter.emit('agent-error', sessionId, agentError);
}
