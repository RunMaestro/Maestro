/**
 * Cue Run Manager — concurrency control, queue management, and run execution.
 *
 * Manages the lifecycle of Cue run executions:
 * - Concurrency gating (max_concurrent per session)
 * - Event queuing when at concurrency limit
 * - Queue draining when slots free
 * - Active run tracking and stop controls
 * - Output prompt execution (two-phase runs)
 * - Completion event emission for chain propagation
 */

import * as crypto from 'crypto';
import type { MainLogLevel } from '../../shared/logger-types';
import type { CueEvent, CueRunResult, CueSettings, CueSubscription } from './cue-types';
import { recordCueEvent, updateCueEventStatus } from './cue-db';
import { SOURCE_OUTPUT_MAX_CHARS } from './cue-fan-in-tracker';
import { captureException } from '../utils/sentry';

/** Phase of a run in the state machine: running → stopping | finished */
export type RunPhase = 'running' | 'stopping' | 'finished';

/** Active run tracking */
export interface ActiveRun {
	result: CueRunResult;
	abortController?: AbortController;
	phase: RunPhase;
	/** The runId of the currently executing child process (differs from result.runId during output prompt phase) */
	processRunId?: string;
}

/** A queued event waiting for a concurrency slot */
export interface QueuedEvent {
	event: CueEvent;
	subscription: CueSubscription;
	prompt: string;
	outputPrompt?: string;
	subscriptionName: string;
	queuedAt: number;
	chainDepth?: number;
}

export interface CueRunManagerDeps {
	getSessions: () => { id: string; name: string }[];
	getSessionSettings: (sessionId: string) => CueSettings | undefined;
	onCueRun: (request: {
		runId: string;
		sessionId: string;
		prompt: string;
		subscriptionName: string;
		event: CueEvent;
		timeoutMs: number;
	}) => Promise<CueRunResult>;
	onStopCueRun?: (runId: string) => boolean;
	onLog: (level: MainLogLevel, message: string, data?: unknown) => void;
	/** Called when a run finishes naturally (completed/failed/timeout) — pushes to activity log AND triggers chain propagation */
	onRunCompleted: (
		sessionId: string,
		result: CueRunResult,
		subscriptionName: string,
		chainDepth?: number
	) => void;
	/** Called when a run is manually stopped — pushes to activity log only (no chain propagation) */
	onRunStopped: (result: CueRunResult) => void;
	/** Called to prevent system sleep (e.g., when a Cue run starts) */
	onPreventSleep?: (reason: string) => void;
	/** Called to allow system sleep (e.g., when a Cue run ends) */
	onAllowSleep?: (reason: string) => void;
}

export interface CueRunManager {
	execute(
		sessionId: string,
		prompt: string,
		event: CueEvent,
		subscriptionName: string,
		outputPrompt?: string,
		chainDepth?: number
	): void;
	stopRun(runId: string): boolean;
	stopAll(): void;
	getActiveRuns(): CueRunResult[];
	getActiveRunCount(sessionId: string): number;
	getActiveRunMap(): Map<string, ActiveRun>;
	getQueueStatus(): Map<string, number>;
	clearQueue(sessionId: string, preserveStartup?: boolean): void;
	reset(): void;
}

export function createCueRunManager(deps: CueRunManagerDeps): CueRunManager {
	const activeRuns = new Map<string, ActiveRun>();
	const activeRunCount = new Map<string, number>();
	const eventQueue = new Map<string, QueuedEvent[]>();

	function getSessionName(sessionId: string): string {
		return deps.getSessions().find((s) => s.id === sessionId)?.name ?? sessionId;
	}

	/**
	 * Attempt a phase transition on an active run.
	 * Returns the previous phase on success, or null if invalid
	 * (run not found, already finished, or already in target phase).
	 */
	function transitionRun(runId: string, toPhase: 'stopping' | 'finished'): RunPhase | null {
		const run = activeRuns.get(runId);
		if (!run || run.phase === 'finished' || run.phase === toPhase) return null;
		const from = run.phase;
		run.phase = toPhase;
		return from;
	}

	function drainQueue(sessionId: string): void {
		const queue = eventQueue.get(sessionId);
		if (!queue || queue.length === 0) return;

		const settings = deps.getSessionSettings(sessionId);
		const maxConcurrent = settings?.max_concurrent ?? 1;
		const timeoutMs = (settings?.timeout_minutes ?? 30) * 60 * 1000;
		const sessionName = getSessionName(sessionId);

		while (queue.length > 0) {
			const currentCount = activeRunCount.get(sessionId) ?? 0;
			if (currentCount >= maxConcurrent) break;

			const entry = queue.shift()!;
			const ageMs = Date.now() - entry.queuedAt;

			// Check for stale events
			if (ageMs > timeoutMs) {
				const ageMinutes = Math.round(ageMs / 60000);
				deps.onLog(
					'cue',
					`[CUE] Dropping stale queued event for "${sessionName}" (queued ${ageMinutes}m ago)`
				);
				continue;
			}

			// Dispatch the queued event
			activeRunCount.set(sessionId, currentCount + 1);
			doExecuteCueRun(
				sessionId,
				entry.prompt,
				entry.event,
				entry.subscriptionName,
				entry.outputPrompt,
				entry.chainDepth
			);
		}

		// Clean up empty queue
		if (queue.length === 0) {
			eventQueue.delete(sessionId);
		}
	}

	async function doExecuteCueRun(
		sessionId: string,
		prompt: string,
		event: CueEvent,
		subscriptionName: string,
		outputPrompt?: string,
		chainDepth?: number
	): Promise<void> {
		const sessionName = getSessionName(sessionId);
		const settings = deps.getSessionSettings(sessionId);
		const runId = crypto.randomUUID();
		const abortController = new AbortController();

		const result: CueRunResult = {
			runId,
			sessionId,
			sessionName,
			subscriptionName,
			event,
			status: 'running',
			stdout: '',
			stderr: '',
			exitCode: null,
			durationMs: 0,
			startedAt: new Date().toISOString(),
			endedAt: '',
		};

		activeRuns.set(runId, { result, abortController, phase: 'running' });
		deps.onPreventSleep?.(`cue:run:${runId}`);
		const timeoutMs = (settings?.timeout_minutes ?? 30) * 60 * 1000;
		try {
			recordCueEvent({
				id: runId,
				type: event.type,
				triggerName: event.triggerName,
				sessionId,
				subscriptionName,
				status: 'running',
				payload: JSON.stringify(event.payload),
			});
		} catch {
			// Non-fatal if DB is unavailable
		}
		deps.onLog('cue', `[CUE] Run started: ${subscriptionName}`, {
			type: 'runStarted',
			runId,
			sessionId,
			subscriptionName,
		});

		try {
			const runResult = await deps.onCueRun({
				runId,
				sessionId,
				prompt,
				subscriptionName,
				event,
				timeoutMs,
			});
			if (!activeRuns.has(runId)) {
				return;
			}
			result.status = runResult.status;
			result.stdout = runResult.stdout;
			result.stderr = runResult.stderr;
			result.exitCode = runResult.exitCode;

			// Execute output prompt if the main task succeeded and an output prompt is configured
			if (outputPrompt && result.status === 'completed') {
				deps.onLog(
					'cue',
					`[CUE] "${subscriptionName}" executing output prompt for downstream handoff`
				);

				const outputRunId = crypto.randomUUID();
				const outputEvent: CueEvent = {
					...event,
					id: crypto.randomUUID(),
					payload: {
						...event.payload,
						sourceOutput: result.stdout.substring(0, SOURCE_OUTPUT_MAX_CHARS),
						outputPromptPhase: true,
					},
				};

				try {
					recordCueEvent({
						id: outputRunId,
						type: event.type,
						triggerName: event.triggerName,
						sessionId,
						subscriptionName: `${subscriptionName}:output`,
						status: 'running',
						payload: JSON.stringify(outputEvent.payload),
					});
				} catch {
					// Non-fatal if DB is unavailable
				}

				// Track the output prompt's process ID so stopRun can kill it
				const run = activeRuns.get(runId);
				if (run) run.processRunId = outputRunId;

				const contextPrompt = `${outputPrompt}\n\n---\n\nContext from completed task:\n${result.stdout.substring(0, SOURCE_OUTPUT_MAX_CHARS)}`;
				const outputResult = await deps.onCueRun({
					runId: outputRunId,
					sessionId,
					prompt: contextPrompt,
					subscriptionName: `${subscriptionName}:output`,
					event: outputEvent,
					timeoutMs,
				});

				try {
					updateCueEventStatus(outputRunId, outputResult.status);
				} catch {
					// Non-fatal if DB is unavailable
				}

				if (!activeRuns.has(runId)) {
					return;
				}

				if (outputResult.status === 'completed') {
					result.stdout = outputResult.stdout;
				} else {
					deps.onLog(
						'cue',
						`[CUE] "${subscriptionName}" output prompt failed (${outputResult.status}), using main task output`
					);
				}
			}
		} catch (error) {
			if (!activeRuns.has(runId)) {
				return;
			}
			result.status = 'failed';
			result.stderr = error instanceof Error ? error.message : String(error);
		} finally {
			// Only clean up if the run is still tracked. If it was already removed
			// (by stopRun or reset), that caller handled its own cleanup.
			if (activeRuns.has(runId)) {
				// Natural completion — set final timing and perform all cleanup
				result.endedAt = new Date().toISOString();
				result.durationMs = Date.now() - new Date(result.startedAt).getTime();

				transitionRun(runId, 'finished');
				activeRuns.delete(runId);
				deps.onAllowSleep?.(`cue:run:${runId}`);

				const count = activeRunCount.get(sessionId) ?? 1;
				activeRunCount.set(sessionId, Math.max(0, count - 1));
				drainQueue(sessionId);

				try {
					updateCueEventStatus(runId, result.status);
				} catch (err) {
					deps.onLog('warn', `[CUE] Failed to update DB status for run ${runId}`);
					captureException(err, {
						operation: 'cue:updateEventStatus',
						runId,
						status: result.status,
					});
				}
				deps.onLog('cue', `[CUE] Run finished: ${subscriptionName} (${result.status})`, {
					type: 'runFinished',
					runId,
					sessionId,
					subscriptionName,
					status: result.status,
				});

				// Notify engine of completion (for activity log + chain propagation)
				deps.onRunCompleted(sessionId, result, subscriptionName, chainDepth);
			}
		}
	}

	return {
		execute(
			sessionId: string,
			prompt: string,
			event: CueEvent,
			subscriptionName: string,
			outputPrompt?: string,
			chainDepth?: number
		): void {
			const settings = deps.getSessionSettings(sessionId);
			const maxConcurrent = settings?.max_concurrent ?? 1;
			const queueSize = settings?.queue_size ?? 10;
			const currentCount = activeRunCount.get(sessionId) ?? 0;

			if (currentCount >= maxConcurrent) {
				// At concurrency limit — queue the event
				const sessionName = getSessionName(sessionId);
				if (!eventQueue.has(sessionId)) {
					eventQueue.set(sessionId, []);
				}
				const queue = eventQueue.get(sessionId)!;

				if (queue.length >= queueSize) {
					// Drop the oldest entry
					queue.shift();
					deps.onLog('cue', `[CUE] Queue full for "${sessionName}", dropping oldest event`);
				}

				queue.push({
					event,
					subscription: { name: subscriptionName, event: event.type, enabled: true, prompt },
					prompt,
					outputPrompt,
					subscriptionName,
					queuedAt: Date.now(),
					chainDepth,
				});

				deps.onLog(
					'cue',
					`[CUE] Event queued for "${sessionName}" (${queue.length}/${queueSize} in queue, ${currentCount}/${maxConcurrent} concurrent)`
				);
				return;
			}

			// Slot available — dispatch immediately
			activeRunCount.set(sessionId, currentCount + 1);
			doExecuteCueRun(sessionId, prompt, event, subscriptionName, outputPrompt, chainDepth);
		},

		stopRun(runId: string): boolean {
			// Phase-validated transition: only running → stopping is valid
			const prevPhase = transitionRun(runId, 'stopping');
			if (prevPhase === null) return false;

			const run = activeRuns.get(runId)!;

			// Signal the process to stop — kill the currently executing child process.
			// During output prompt phase, processRunId differs from the parent runId.
			deps.onStopCueRun?.(runId);
			if (run.processRunId && run.processRunId !== runId) {
				deps.onStopCueRun?.(run.processRunId);
			}
			run.abortController?.abort();

			// Finalize the result for immediate UI feedback
			run.result.status = 'stopped';
			run.result.endedAt = new Date().toISOString();
			run.result.durationMs = Date.now() - new Date(run.result.startedAt).getTime();

			// Remove from activeRuns — the finally block in doExecuteCueRun
			// sees this and skips its own cleanup (single ownership).
			activeRuns.delete(runId);
			deps.onAllowSleep?.(`cue:run:${runId}`);

			// Free the concurrency slot immediately so queued events can proceed
			const count = activeRunCount.get(run.result.sessionId) ?? 1;
			activeRunCount.set(run.result.sessionId, Math.max(0, count - 1));
			drainQueue(run.result.sessionId);

			// Record final status in DB and notify
			try {
				updateCueEventStatus(runId, 'stopped');
			} catch (err) {
				deps.onLog('warn', `[CUE] Failed to update DB status for stopped run ${runId}`);
				captureException(err, { operation: 'cue:updateEventStatus', runId, status: 'stopped' });
			}
			deps.onRunStopped(run.result);
			deps.onLog('cue', `[CUE] Run stopped: ${runId}`, {
				type: 'runStopped',
				runId,
				sessionId: run.result.sessionId,
				subscriptionName: run.result.subscriptionName,
			});
			return true;
		},

		stopAll(): void {
			for (const runId of [...activeRuns.keys()]) {
				this.stopRun(runId);
			}
			eventQueue.clear();
		},

		getActiveRuns(): CueRunResult[] {
			return [...activeRuns.values()].map((r) => r.result);
		},

		getActiveRunCount(sessionId: string): number {
			return [...activeRuns.values()].filter((r) => r.result.sessionId === sessionId).length;
		},

		getActiveRunMap(): Map<string, ActiveRun> {
			return activeRuns;
		},

		getQueueStatus(): Map<string, number> {
			const result = new Map<string, number>();
			for (const [sessionId, queue] of eventQueue) {
				if (queue.length > 0) {
					result.set(sessionId, queue.length);
				}
			}
			return result;
		},

		clearQueue(sessionId: string, preserveStartup = false): void {
			if (!preserveStartup) {
				eventQueue.delete(sessionId);
				return;
			}
			const queue = eventQueue.get(sessionId);
			if (!queue) return;
			const kept = queue.filter((e) => e.event.type === 'app.startup');
			if (kept.length === 0) {
				eventQueue.delete(sessionId);
			} else {
				eventQueue.set(sessionId, kept);
			}
		},

		reset(): void {
			for (const runId of activeRuns.keys()) {
				deps.onAllowSleep?.(`cue:run:${runId}`);
			}
			activeRuns.clear();
			activeRunCount.clear();
			eventQueue.clear();
		},
	};
}
