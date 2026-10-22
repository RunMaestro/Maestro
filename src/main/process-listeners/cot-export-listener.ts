/**
 * Chain of thought export: the process listener.
 *
 * It is the one place the log meets a running process. It hears three events
 * of the process manager and passes each to the turn assembler, which does
 * the work (see `src/main/cot-export/turn-assembler.ts`):
 *
 *   `spawn`         a process started
 *   `parsed-event`  a process printed one parsed line
 *   `exit`          a process ended
 *
 * WHAT IT GUARANTEES
 * - Nothing here throws into the process manager. Every handler is guarded,
 *   so a fault in the log can never disturb the turn it is a record of.
 * - It hears `parsed-event` only while a turn is being recorded. The process
 *   manager emits that event only when something listens, so with export off
 *   for every agent a line of output costs nothing here at all.
 * - It reads the spawn config and never changes it. What an agent is started
 *   with is the same with export on or off.
 * - It sends nothing anywhere. It has no way to reach the renderer, the web
 *   server, or the CLI, and it must not be given one. A failure is kept in
 *   the feature's own store, where only the person can see it.
 * - Its log lines do not say what it is for. Agents can read Maestro's logs.
 *
 * This feature is hidden from agents on purpose. Read the header of
 * `src/shared/cotExport/types.ts` before you change or expose anything here.
 */

import type { ProcessManager } from '../process-manager';
import type { ProcessConfig, TurnSettlement } from '../process-manager/types';
import type { ParsedEvent } from '../parsers/agent-output-parser';
import type { CotConfigStore } from '../cot-export/config-store';
import type { CotTarget } from '../cot-export/resolve-agent';
import { createCotTurnAssembler } from '../cot-export/turn-assembler';
import type { CotTurnAssembler } from '../cot-export/turn-assembler';
import type { CotWriter } from '../cot-export/writer';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'ProcessListeners';

/** Everything the listener is given. It makes nothing of its own but the assembler. */
export interface CotExportListenerDeps {
	/** The per-agent switch and folder, and where a failure is kept. */
	store: Pick<CotConfigStore, 'isEnabled' | 'getAgentConfig' | 'recordError'>;
	writer: Pick<CotWriter, 'append'>;
	/** Which agent a process belongs to (`peekCotAgentId`, `resolveCotTarget`). */
	resolver: {
		peekAgentId: (processSessionId: string) => string | null;
		resolveTarget: (processSessionId: string) => Promise<CotTarget | null>;
	};
	/** The clock, in epoch milliseconds. Defaults to `Date.now`. */
	now?: () => number;
}

/**
 * Starts recording the turns of agents that have export on. Returns the
 * assembler, so a caller that reads the files back can wait for it to be idle.
 */
export function setupCotExportListener(
	processManager: ProcessManager,
	deps: CotExportListenerDeps
): CotTurnAssembler {
	const now = deps.now ?? Date.now;

	/**
	 * Keeps a failure where the person can see it, and never throws.
	 *
	 * The message goes to the store and nowhere else. A failed write names the
	 * file it failed on, and so the log folder, which must not reach a log an
	 * agent can read. The log line carries the kind of error only.
	 */
	const fail = (agentId: string | null, error: unknown): void => {
		try {
			if (agentId !== null) {
				const message = error instanceof Error ? error.message : String(error);
				deps.store.recordError(agentId, message, now());
				return;
			}
		} catch {
			// The store could not take it. The log line below is what is left.
		}
		logger.warn('A process turn listener step failed', LOG_CONTEXT, {
			error: error instanceof Error ? error.name : typeof error,
		});
	};

	/** Wraps a handler so that nothing it does can throw into the emitter. */
	const guarded =
		<Args extends unknown[]>(handler: (...args: Args) => void) =>
		(...args: Args): void => {
			try {
				handler(...args);
			} catch (error) {
				fail(null, error);
			}
		};

	const onParsedEvent = guarded((sessionId: string, event: ParsedEvent) => {
		assembler.handleParsedEvent(sessionId, event);
	});

	const assembler = createCotTurnAssembler({
		peekAgentId: deps.resolver.peekAgentId,
		resolveTarget: deps.resolver.resolveTarget,
		isEnabled: (agentId) => deps.store.isEnabled(agentId),
		getFolder: (agentId) => deps.store.getAgentConfig(agentId).folder,
		isProcessRunning: (processSessionId) => processManager.get(processSessionId) !== undefined,
		writer: deps.writer,
		onError: fail,
		onFollowingChange: (following) => {
			if (following) processManager.on('parsed-event', onParsedEvent);
			else processManager.off('parsed-event', onParsedEvent);
		},
		now,
	});

	processManager.on(
		'spawn',
		guarded((config: ProcessConfig) => {
			if (!config?.sessionId) return;
			assembler.handleSpawn(config);
		})
	);

	// Ahead of every other `exit` listener. One of them may start the next
	// process under the same id from inside this very event, and the exit must
	// reach the turn it ended before that new turn takes its place.
	processManager.prependListener(
		'exit',
		guarded((sessionId: string, code?: number, _signal?: number, settlement?: TurnSettlement) => {
			assembler.handleExit(sessionId, typeof code === 'number' ? code : null, settlement?.outcome);
		})
	);

	return assembler;
}
