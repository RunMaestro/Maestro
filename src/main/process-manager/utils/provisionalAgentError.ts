import type { EventEmitter } from 'events';
import type { ManagedProcess } from '../types';

/**
 * Emit the in-turn error notice StdoutHandler is holding for this process, if
 * one is still held (see `AgentOutputParser.isProvisionalErrorNotice`).
 *
 * Called at the two points where a turn ends on the notice: a result message
 * with no model output after the notice, and process exit. Both callers go
 * through here so the hold is always released the same way: at most one
 * `agent-error` per process, and never a second one after an error that was
 * already emitted.
 */
export function settleProvisionalAgentError(
	emitter: EventEmitter,
	sessionId: string,
	managedProcess: ManagedProcess
): void {
	const held = managedProcess.provisionalError;
	if (!held) return;
	managedProcess.provisionalError = undefined;
	if (managedProcess.errorEmitted) return;
	managedProcess.errorEmitted = true;
	emitter.emit('agent-error', sessionId, held);
}
