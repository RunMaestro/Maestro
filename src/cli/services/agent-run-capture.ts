// CLI agent-run capture hook (F1 / ISC-1.9).
//
// CLI-owned agent runs (`send`, autorun batch, goal-runner, and their synopsis
// resumes) route through `spawnAgent` (agent-spawner.ts), NOT through the
// desktop `ProcessManager.spawn` seam that the main-process capture service
// wraps. This helper is the CLI-side analogue: it opens an AgentRun in the
// ledger at spawn and settles it to a terminal state on return, so those runs
// appear in the dashboard alongside desktop and Pianola runs.
//
// Capture is an observability substrate: it MUST NOT change spawn behavior,
// timing, or the caller's result. Every ledger write is wrapped so a store
// failure is logged and swallowed rather than breaking the CLI path.

import {
	resolveAgentRunProvider,
	assertTransition,
	type AgentRun,
	type AgentRunStatus,
} from '../../shared/agent-run';
import { upsertAgentRun, appendAgentRunEvent } from './agent-run-store';
import { generateUUID } from '../../shared/uuid';
import { logger } from '../../main/utils/logger';

const LOG_CONTEXT = 'AgentRunCapture';

export interface CaptureCliRunInput {
	/**
	 * Maestro session linkage when known. Omit for spawns without a stable
	 * session id; `findActiveRunBySession` tolerates undefined.
	 */
	sessionId?: string;
	/** Raw provider toolType (resolved to a canonical provider). */
	toolType: string;
	/** Working directory the agent runs in. */
	cwd: string;
	/** Prompt delivered to the agent (stored verbatim on the run). */
	prompt?: string;
	/** Origin classification, e.g. `cli:send`, `cli:autorun`, `cli:goal`. */
	source: string;
}

/** Build a unique run id from the source + spawn timestamp + random suffix. */
function createRunId(source: string, startedAt: number): string {
	const slug = source.replace(/[^a-z0-9]+/gi, '-');
	return `run_${slug}_${startedAt}_${generateUUID().slice(0, 8)}`;
}

/** Run a ledger write, logging and swallowing any failure. */
function safeLedger(action: () => void): void {
	try {
		action();
	} catch (error) {
		logger.error('agent-run ledger write failed', LOG_CONTEXT, error);
	}
}

/** Assemble the run record shared by the running and terminal snapshots. */
function buildRun(
	input: CaptureCliRunInput,
	runId: string,
	createdAt: number,
	updatedAt: number,
	status: AgentRunStatus,
	metadata?: AgentRun['metadata']
): AgentRun {
	return {
		id: runId,
		createdAt,
		updatedAt,
		provider: resolveAgentRunProvider(input.toolType),
		status,
		artifacts: [],
		touchedFiles: [],
		checks: [],
		reviews: [],
		cwd: input.cwd,
		source: input.source,
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
		...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
		...(metadata ? { metadata } : {}),
	};
}

/** Open the run at spawn: create the record + append a status_change event. */
function startRun(input: CaptureCliRunInput, runId: string, startedAt: number): void {
	upsertAgentRun(buildRun(input, runId, startedAt, startedAt, 'running'));
	appendAgentRunEvent({
		id: `evt_${runId}_running_${startedAt}`,
		runId,
		timestamp: startedAt,
		type: 'status_change',
		status: 'running',
		message: input.source,
	});
}

/** Settle the run to a terminal state from the resolved exit code. */
function settleRun(
	input: CaptureCliRunInput,
	runId: string,
	startedAt: number,
	exitCode: number
): void {
	const completedAt = Date.now();
	const durationMs = completedAt - startedAt;
	const status: AgentRunStatus = exitCode === 0 ? 'completed' : 'failed';
	// Guard the lifecycle edge (running -> completed/failed) before persisting.
	assertTransition('running', status);
	upsertAgentRun(buildRun(input, runId, startedAt, completedAt, status, { durationMs, exitCode }));
	appendAgentRunEvent({
		id: `evt_${runId}_${status}_${completedAt}`,
		runId,
		timestamp: completedAt,
		type: 'status_change',
		status,
		message: input.source,
		data: { exitCode, durationMs },
	});
}

/**
 * Wrap a `spawnAgent` invocation with ledger capture. Creates a running
 * AgentRun before `run()`, settles it to completed/failed on return using the
 * exit code from `resolveExit`, and settles it to failed (then re-throws) if
 * `run()` throws. All ledger errors are swallowed so the CLI path is never
 * broken by capture. Returns exactly what `run()` returned.
 */
export async function captureCliRun<T>(
	input: CaptureCliRunInput,
	run: () => Promise<T>,
	resolveExit: (result: T) => number
): Promise<T> {
	const startedAt = Date.now();
	const runId = createRunId(input.source, startedAt);
	safeLedger(() => startRun(input, runId, startedAt));
	try {
		const result = await run();
		safeLedger(() => {
			let exitCode = 1;
			try {
				exitCode = resolveExit(result);
			} catch (error) {
				logger.error('agent-run resolveExit failed', LOG_CONTEXT, error);
			}
			settleRun(input, runId, startedAt, exitCode);
		});
		return result;
	} catch (error) {
		safeLedger(() => settleRun(input, runId, startedAt, 1));
		throw error;
	}
}
