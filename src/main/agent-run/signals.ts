/**
 * AgentRun signal producers (F5) - main-process lifecycle signal sources.
 *
 * The capture service (F1) only knows spawn and exit; it settles a run to
 * running/completed/failed. The intermediate lifecycle states (waiting,
 * needs_review, fixing) need their own signal sources, which live here:
 *
 *   - `markWaiting`     the agent blocked on the user      (running  -> waiting)
 *   - `markWorking`     the agent resumed after an answer  (waiting  -> running)
 *   - `markNeedsReview` review surfaced open findings      (*        -> needs_review)
 *   - `markFixing`      a fix agent was actually dispatched (*       -> fixing)
 *
 * Design mirrors the capture service: store access is injected (so this file
 * imports no fs/electron/child_process), every transition is guarded by the
 * pure lifecycle table, each write appends a `status_change` event, and every
 * method swallows + logs its own errors so a signal never throws into a
 * lifecycle path (ISC-1.8-style).
 *
 * Anti-signal guards (the important half of the spec):
 *   - ISC-5.7: `markWaiting` only fires from `running`; a run that already left
 *     running (e.g. completed) is never flipped to a false `waiting`.
 *   - ISC-5.8: `markNeedsReview` only fires when the run has >=1 open finding;
 *     a clean run is never parked in `needs_review`.
 *   - ISC-5.9: `markFixing` only fires when the caller reports a real dispatch;
 *     with no dispatch it writes nothing.
 */

import {
	assertTransition,
	hasOpenReviewFinding,
	type AgentRun,
	type AgentRunEvent,
	type AgentRunMetadata,
	type AgentRunStatus,
} from '../../shared/agent-run';
import { broadcastRunUpdated, broadcastEventAppended } from './broadcast';

/** Everything the producers touch that is not pure. Injected for testability. */
export interface AgentRunSignalDeps {
	getAgentRun: (runId: string) => AgentRun | undefined;
	/** Find the live (non-terminal) run for a session, if any. */
	findActiveRunBySession: (sessionId: string) => AgentRun | undefined;
	upsertAgentRun: (run: AgentRun) => AgentRun;
	appendAgentRunEvent: (event: AgentRunEvent) => AgentRunEvent;
	now?: () => number;
	log?: (level: 'warn' | 'error', message: string, error?: unknown) => void;
}

/**
 * Evidence that a fix agent was really dispatched (ISC-5.9). The presence of
 * this object is the signal; its fields are metadata-only (ids/labels), never
 * prompt text or agent output, mirroring the events.ts metadata contract.
 */
export interface FixDispatch {
	agentId?: string;
	sessionId?: string;
	reason?: string;
}

export class AgentRunSignals {
	private readonly deps: AgentRunSignalDeps;

	constructor(deps: AgentRunSignalDeps) {
		this.deps = deps;
	}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	private report(level: 'warn' | 'error', message: string, error?: unknown): void {
		this.deps.log?.(level, message, error);
	}

	/**
	 * The agent blocked on the user: `running -> waiting` (ISC-5.2/5.7). Resolves
	 * the live run from the session. Anti (ISC-5.7): a run that is not currently
	 * `running` is left untouched - no false waiting on an already-settled run.
	 */
	markWaiting(sessionId: string): AgentRun | undefined {
		try {
			const run = this.deps.findActiveRunBySession(sessionId);
			if (!run || run.status !== 'running') return undefined;
			return this.transition(run, 'waiting', 'agent awaiting user input');
		} catch (error) {
			this.report('error', `markWaiting failed for ${sessionId}`, error);
			return undefined;
		}
	}

	/**
	 * The agent resumed after the user answered: `waiting -> running` (ISC-5.3).
	 * Anti-symmetric with markWaiting: only a currently `waiting` run resumes.
	 */
	markWorking(sessionId: string): AgentRun | undefined {
		try {
			const run = this.deps.findActiveRunBySession(sessionId);
			if (!run || run.status !== 'waiting') return undefined;
			return this.transition(run, 'running', 'agent resumed after input');
		} catch (error) {
			this.report('error', `markWorking failed for ${sessionId}`, error);
			return undefined;
		}
	}

	/**
	 * Review surfaced findings: `-> needs_review` (ISC-5.8). Resolved by run id
	 * (review runs against a specific run, not a live session). Anti (ISC-5.8): a
	 * run with zero open findings is never parked in `needs_review` - we return
	 * without writing so a clean review is a no-op.
	 */
	markNeedsReview(runId: string): AgentRun | undefined {
		try {
			const run = this.deps.getAgentRun(runId);
			if (!run) return undefined;
			if (!hasOpenReviewFinding(run)) return undefined;
			if (run.status === 'needs_review') return run;
			return this.transition(run, 'needs_review', 'review found open findings');
		} catch (error) {
			this.report('error', `markNeedsReview failed for ${runId}`, error);
			return undefined;
		}
	}

	/**
	 * A fix agent was dispatched: `-> fixing` (ISC-5.9). Anti (ISC-5.9): the
	 * `dispatch` argument IS the signal - with no dispatch we write nothing, so a
	 * run is never flipped to `fixing` without a real fix in flight. The dispatch
	 * ids ride along on the status_change event as metadata for the ledger.
	 */
	markFixing(runId: string, dispatch?: FixDispatch): AgentRun | undefined {
		try {
			if (!dispatch) return undefined;
			const run = this.deps.getAgentRun(runId);
			if (!run) return undefined;
			if (run.status === 'fixing') return run;
			const data: AgentRunMetadata = {
				...(dispatch.agentId ? { fixAgentId: dispatch.agentId } : {}),
				...(dispatch.sessionId ? { fixSessionId: dispatch.sessionId } : {}),
				...(dispatch.reason ? { reason: dispatch.reason } : {}),
			};
			return this.transition(run, 'fixing', 'fix agent dispatched', data);
		} catch (error) {
			this.report('error', `markFixing failed for ${runId}`, error);
			return undefined;
		}
	}

	/**
	 * Guard + persist + mirror a single status change. Guarded by the pure
	 * lifecycle table (assertTransition throws on an illegal edge, caught by the
	 * caller), then the run is upserted and a `status_change` event appended, both
	 * broadcast to the renderer/web clients.
	 */
	private transition(
		run: AgentRun,
		to: AgentRunStatus,
		message: string,
		data?: AgentRunMetadata
	): AgentRun {
		const ts = this.now();
		assertTransition(run.status, to);
		const next: AgentRun = { ...run, status: to, updatedAt: ts };
		const saved = this.deps.upsertAgentRun(next);
		broadcastRunUpdated(saved);
		this.emit(run.id, ts, to, message, data);
		return saved;
	}

	private emit(
		runId: string,
		timestamp: number,
		status: AgentRunStatus,
		message: string,
		data?: AgentRunMetadata
	): void {
		try {
			const saved = this.deps.appendAgentRunEvent({
				id: `evt:${runId}:status_change:${timestamp}`,
				runId,
				timestamp,
				type: 'status_change',
				status,
				message,
				...(data ? { data } : {}),
			});
			broadcastEventAppended(saved);
		} catch (error) {
			this.report('warn', `event append failed for ${runId}`, error);
		}
	}
}
