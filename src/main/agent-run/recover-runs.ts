/**
 * Crash / restart recovery for the agent-run ledger (F1 / ISC-1.10).
 *
 * The store only reads snapshots; nothing else clears runs left non-terminal by
 * a crash. On startup we reconcile every run still in a non-terminal state whose
 * session has no live process: a run whose session is known-gone settles to
 * `failed`, an ambiguous one to `stale` via the audited transition path so the
 * lifecycle guard permits it. Idempotent: a second pass finds nothing to do.
 */

import {
	assertTransition,
	isTerminalAgentRunStatus,
	type AgentRun,
	type AgentRunStatus,
} from '../../shared/agent-run';

export interface RecoverRunsDeps {
	listRuns: () => AgentRun[];
	upsertRun: (run: AgentRun) => AgentRun;
	appendEvent: (event: {
		id: string;
		runId: string;
		timestamp: number;
		type: string;
		status?: AgentRunStatus;
		message?: string;
	}) => void;
	/** True when a session still has a live process (do not reconcile it). */
	isSessionLive: (sessionId: string | undefined) => boolean;
	now?: () => number;
	log?: (message: string, count: number) => void;
}

export function recoverNonTerminalRuns(deps: RecoverRunsDeps): number {
	const now = (deps.now ?? Date.now)();
	let recovered = 0;

	for (const run of deps.listRuns()) {
		if (isTerminalAgentRunStatus(run.status)) continue;
		if (deps.isSessionLive(run.sessionId)) continue;

		// queued/running with a dead session crashed mid-flight -> failed.
		// waiting/needs_review/fixing are ambiguous -> failed as well (terminal,
		// user can retry). The guard allows both from any non-terminal source.
		const target: AgentRunStatus = 'failed';
		try {
			assertTransition(run.status, target, { audited: true });
		} catch {
			continue;
		}
		deps.upsertRun({
			...run,
			status: target,
			updatedAt: now,
			metadata: { ...(run.metadata ?? {}), recoveredFrom: run.status, recoveredAt: now },
		});
		deps.appendEvent({
			id: `evt:${run.id}:recovered:${now}`,
			runId: run.id,
			timestamp: now,
			type: 'status_change',
			status: target,
			message: `recovered from ${run.status} after restart (no live process)`,
		});
		recovered += 1;
	}

	if (recovered > 0) deps.log?.('recovered non-terminal runs after restart', recovered);
	return recovered;
}
