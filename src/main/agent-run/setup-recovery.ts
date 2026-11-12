/**
 * Wire startup crash recovery for the agent-run ledger (F1 / ISC-1.10).
 *
 * Mirrors setup-capture-listener.ts: the pure recovery pass
 * (recoverNonTerminalRuns) gets the concrete store + ProcessManager injected
 * here, so recover-runs.ts stays free of fs/electron imports. Called once at
 * startup, after the store is readable and BEFORE any new agent spawns, so
 * every run left non-terminal by a crash reconciles against a process table
 * that only contains genuinely live sessions.
 *
 * Error-tolerant by contract: a store read/write failure is logged and
 * swallowed - recovery must never break app startup.
 */

import type { ProcessManager } from '../process-manager';
import {
	readAgentRuns,
	upsertAgentRun,
	appendAgentRunEvent,
} from '../../cli/services/agent-run-store';
import { logger } from '../utils/logger';
import { recoverNonTerminalRuns } from './recover-runs';
import { broadcastRunUpdated, broadcastEventAppended } from './broadcast';

const LOG_CONTEXT = '[AgentRunRecovery]';

/**
 * Run the recovery pass once. Returns the number of runs reconciled (0 on an
 * empty store or when every non-terminal run still has a live process; -1 when
 * the pass itself failed and was swallowed).
 */
export function setupAgentRunRecovery(processManager: ProcessManager): number {
	try {
		return recoverNonTerminalRuns({
			listRuns: readAgentRuns,
			upsertRun: (run) => {
				const saved = upsertAgentRun(run);
				broadcastRunUpdated(saved);
				return saved;
			},
			appendEvent: (event) => {
				broadcastEventAppended(appendAgentRunEvent(event));
			},
			isSessionLive: (sessionId) =>
				sessionId !== undefined && processManager.get(sessionId) !== undefined,
			log: (message, count) => {
				logger.info(`${message}: ${count}`, LOG_CONTEXT);
			},
		});
	} catch (error) {
		logger.warn(`Startup run recovery failed: ${String(error)}`, LOG_CONTEXT);
		return -1;
	}
}
