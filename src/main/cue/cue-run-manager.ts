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
import type { CueLogPayload } from '../../shared/cue-log-types';
import type { CueCommand, CueEvent, CueRunResult, CueSettings, CueSubscription } from './cue-types';
import { updateCueEventStatus, safeRecordCueEvent, safeUpdateCueEventStatus } from './cue-db';
import type { CueQueuePersistence } from './cue-queue-persistence';
import { SOURCE_OUTPUT_MAX_CHARS } from './cue-fan-in-tracker';
import { sliceHeadByChars } from './cue-text-utils';
import { captureException } from '../utils/sentry';
import { substituteTemplateVariables, type TemplateContext } from '../../shared/templateVariables';
import { buildCueTemplateContext } from './cue-template-context-builder';
import { runMaestroCliSend } from './cue-cli-executor';

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
	cliOutput?: { target: string };
	action?: CueSubscription['action'];
	command?: CueCommand;
	/** Phase 12A — DB row id for the persisted copy, when persistence is enabled. */
	persistId?: string;
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
		action?: CueSubscription['action'];
		command?: CueCommand;
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
	/**
	 * Phase 12B — called when an event is dropped from the queue due to
	 * overflow (queue already at `queue_size`). The caller is expected to
	 * surface this to the user (toast, log banner) so the drop is visible.
	 */
	onQueueOverflow?: (payload: {
		sessionId: string;
		sessionName: string;
		subscriptionName: string;
		queuedAt: number;
	}) => void;
	/**
	 * Phase 12A — optional queue persistence façade. When provided, every
	 * enqueue writes a row to disk and every drain/drop/clear removes it,
	 * allowing the queue to survive engine shutdown or a hard app crash. Omit
	 * to run entirely in-memory (preserves back-compat for tests and for the
	 * main process if persistence ever needs to be disabled).
	 */
	queuePersistence?: CueQueuePersistence;
}

export interface CueRunManager {
	execute(
		sessionId: string,
		prompt: string,
		event: CueEvent,
		subscriptionName: string,
		outputPrompt?: string,
		chainDepth?: number,
		cliOutput?: { target: string },
		action?: CueSubscription['action'],
		command?: CueCommand,
		/**
		 * Phase 12A — optional pre-existing `queuedAt` used by the engine's
		 * restore path so re-queued events retain their ORIGINAL wall-clock
		 * timestamp. Without this, `drainQueue`'s staleness check would
		 * forever see "just now" for entries that had been waiting for hours
		 * before the app crashed, effectively converting staleness into a
		 * free pass across restarts.
		 */
		queuedAtOverride?: number
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
				// Remove the persisted copy — this runtime drain path is the
				// second half of the stale-drop handling (restore has its own).
				if (entry.persistId) deps.queuePersistence?.remove(entry.persistId);
				// Record the dropped event to the activity log so users can see
				// *why* their queued run never fired — previously these events
				// disappeared with only a log line, making it look like a bug.
				const droppedRunId = crypto.randomUUID();
				// We record the event directly in its final `timeout` state, so
				// there's no separate running→timeout flip needed — the row is
				// born finalized (unlike normal runs, which start as `running`).
				safeRecordCueEvent({
					id: droppedRunId,
					type: entry.event.type,
					triggerName: entry.event.triggerName,
					sessionId,
					subscriptionName: entry.subscriptionName,
					status: 'timeout',
					payload: JSON.stringify({
						...entry.event.payload,
						droppedFromQueue: true,
						queuedForMs: ageMs,
					}),
				});
				// Emit as `queueDropped` (stale reason) rather than `runFinished`
				// with status: 'timeout'. Previously this path incremented
				// `runsTimedOut` via the metric interceptor, confounding real
				// runtime timeouts with queue-drain staleness. The DB row
				// still records status: 'timeout' so the user-facing activity
				// log shows the same symbol as before — only the internal
				// metric accounting differs.
				deps.onLog(
					'cue',
					`[CUE] Dropping stale queued event for "${sessionName}" (queued ${ageMinutes}m ago) — recorded as timeout in activity log`,
					{
						type: 'queueDropped',
						sessionId,
						count: 1,
						reason: 'stale',
					} satisfies CueLogPayload
				);
				continue;
			}

			// Dispatch the queued event. Remove persisted row first — the
			// dispatch promise may outlive another drain/reset cycle and we
			// must not leave a ghost row referencing an in-flight run.
			if (entry.persistId) deps.queuePersistence?.remove(entry.persistId);
			activeRunCount.set(sessionId, currentCount + 1);
			doExecuteCueRun(
				sessionId,
				entry.prompt,
				entry.event,
				entry.subscriptionName,
				entry.outputPrompt,
				entry.chainDepth,
				entry.cliOutput,
				entry.action,
				entry.command
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
		chainDepth?: number,
		cliOutput?: { target: string },
		action?: CueSubscription['action'],
		command?: CueCommand
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
		safeRecordCueEvent({
			id: runId,
			type: event.type,
			triggerName: event.triggerName,
			sessionId,
			subscriptionName,
			status: 'running',
			payload: JSON.stringify(event.payload),
		});
		deps.onLog('cue', `[CUE] Run started: ${subscriptionName}`, {
			type: 'runStarted',
			runId,
			sessionId,
			subscriptionName,
		} satisfies CueLogPayload);

		try {
			const runResult = await deps.onCueRun({
				runId,
				sessionId,
				prompt,
				subscriptionName,
				event,
				timeoutMs,
				action,
				command,
			});
			if (!activeRuns.has(runId)) {
				// Engine was stopped (or run was cleared) while onCueRun was in
				// flight. The finally block's cleanup is gated on activeRuns
				// having this run, so without an explicit DB write the row
				// would stay `running` forever in the activity log.
				safeUpdateCueEventStatus(runId, runResult.status);
				// Emit with the structured runFinished payload so live
				// listeners (activity log, queue indicators) observe the
				// transition identically to a normal completion — this is
				// what renderer subscribers key off of.
				deps.onLog(
					'cue',
					`[CUE] Run "${subscriptionName}" completed after engine stop — status recorded (${runResult.status}), result discarded`,
					{
						type: 'runFinished',
						runId,
						sessionId,
						subscriptionName,
						status: runResult.status,
					} satisfies CueLogPayload
				);
				return;
			}
			result.status = runResult.status;
			result.stdout = runResult.stdout;
			result.stderr = runResult.stderr;
			result.exitCode = runResult.exitCode;

			// Execute output prompt if the main task succeeded and an output prompt is configured.
			// Skipped for `action: command` runs — output_prompt is an AI follow-up, not a
			// shell/cli concept.
			if (outputPrompt && result.status === 'completed' && action !== 'command') {
				deps.onLog(
					'cue',
					`[CUE] "${subscriptionName}" executing output prompt for downstream handoff`
				);

				// Compute the sliced output ONCE — used for both the recorded
				// payload's sourceOutput and the context prompt below. The prior
				// code called sliceHeadByChars twice with identical arguments.
				const slicedOutput = sliceHeadByChars(result.stdout, SOURCE_OUTPUT_MAX_CHARS);

				const outputRunId = crypto.randomUUID();
				const outputEvent: CueEvent = {
					...event,
					id: crypto.randomUUID(),
					payload: {
						...event.payload,
						sourceOutput: slicedOutput,
						outputPromptPhase: true,
					},
				};

				safeRecordCueEvent({
					id: outputRunId,
					type: event.type,
					triggerName: event.triggerName,
					sessionId,
					subscriptionName: `${subscriptionName}:output`,
					status: 'running',
					payload: JSON.stringify(outputEvent.payload),
				});

				// Track the output prompt's process ID so stopRun can kill it
				const run = activeRuns.get(runId);
				if (run) run.processRunId = outputRunId;

				const contextPrompt = `${outputPrompt}\n\n---\n\nContext from completed task:\n${slicedOutput}`;
				// Wrap the output-prompt phase in try/finally so the DB row is
				// ALWAYS finalized — even if both the run and the status-update
				// call fail. Without this, a double-failure leaves the row
				// stuck at `running` and the activity log shows a phantom run.
				let outputResult: CueRunResult | undefined;
				let outputStatus: CueRunResult['status'] = 'failed';
				try {
					outputResult = await deps.onCueRun({
						runId: outputRunId,
						sessionId,
						prompt: contextPrompt,
						subscriptionName: `${subscriptionName}:output`,
						event: outputEvent,
						timeoutMs,
					});
					outputStatus = outputResult.status;
				} finally {
					// Use the raw (throwing) updateCueEventStatus with our own
					// try/catch so the Sentry `operation` tag is specific to
					// this call site — distinguishing "output-phase finalize
					// failed" from generic "status update failed" when
					// triaging reports. The `safe*` wrappers tag everything
					// as `safeUpdateCueEventStatus`, which is too coarse to
					// tell this failure mode apart from a normal run update.
					try {
						updateCueEventStatus(outputRunId, outputStatus);
					} catch (finalizeErr) {
						captureException(finalizeErr, {
							operation: 'cue:finalizeOutputRunStatus',
							outputRunId,
							outputStatus,
						});
					}
				}

				if (!activeRuns.has(runId)) {
					// Engine reset between the main task finishing and the output
					// prompt completing. The output-phase DB row was finalized in
					// the inner finally above, but the PARENT runId is still
					// `running` because the outer finally at the bottom of this
					// function is gated on `activeRuns.has(runId)` — which is now
					// false. Finalize it here so the activity log doesn't show a
					// phantom never-ending run. Mirrors the earlier handling at
					// line ~245 for the pre-output-prompt case.
					safeUpdateCueEventStatus(runId, result.status);
					deps.onLog(
						'cue',
						`[CUE] Run "${subscriptionName}" output phase completed after engine stop — parent status recorded (${result.status}), result discarded`,
						{
							type: 'runFinished',
							runId,
							sessionId,
							subscriptionName,
							status: result.status,
						} satisfies CueLogPayload
					);
					return;
				}

				if (outputResult && outputResult.status === 'completed') {
					result.stdout = outputResult.stdout;
				} else {
					deps.onLog(
						'cue',
						`[CUE] "${subscriptionName}" output prompt failed (${outputStatus}), using main task output`
					);
				}
			}

			// Phase 3: legacy cli_output delivery — shell out to maestro-cli send --live.
			// New code should use a downstream `action: command` subscription with
			// `command.mode: 'cli'` instead; this path remains for YAML files that
			// haven't been re-saved through the editor yet. Skipped for command actions
			// (the action itself is the work, not a side effect).
			if (cliOutput && result.status === 'completed' && action !== 'command') {
				deps.onLog(
					'cue',
					`[CUE] "${subscriptionName}" Phase 3: delivering CLI output to target="${cliOutput.target}" (stdout length=${result.stdout.length})`
				);
				try {
					const cueContext = buildCueTemplateContext(
						event,
						{ name: subscriptionName, event: event.type, enabled: true, prompt: '' },
						runId
					);
					const templateContext: TemplateContext = {
						session: {
							id: sessionId,
							name: sessionName,
							toolType: '',
							cwd: '',
						},
						cue: cueContext,
					};
					const resolvedTarget = substituteTemplateVariables(
						cliOutput.target,
						templateContext
					).trim();
					if (!resolvedTarget) {
						deps.onLog(
							'warn',
							`[CUE] "${subscriptionName}" CLI output target resolved to empty string (raw="${cliOutput.target}") — skipping delivery`
						);
					} else {
						const sendResult = await runMaestroCliSend(resolvedTarget, result.stdout);
						if (!sendResult.ok) {
							throw new Error(`CLI exited with code ${sendResult.exitCode}: ${sendResult.stderr}`);
						}
						deps.onLog(
							'cue',
							`[CUE] "${subscriptionName}" CLI output delivered to ${resolvedTarget}`
						);
					}
				} catch (cliError) {
					captureException(cliError, {
						operation: 'cue:cliOutputDelivery',
						subscriptionName,
						target: cliOutput.target,
					});
					deps.onLog(
						'warn',
						`[CUE] "${subscriptionName}" CLI output delivery failed: ${cliError instanceof Error ? cliError.message : String(cliError)}`
					);
				}
			} else if (cliOutput && result.status !== 'completed') {
				deps.onLog(
					'cue',
					`[CUE] "${subscriptionName}" Phase 3 skipped: run status="${result.status}" (not completed)`
				);
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
				} satisfies CueLogPayload);

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
			chainDepth?: number,
			cliOutput?: { target: string },
			action?: CueSubscription['action'],
			command?: CueCommand,
			queuedAtOverride?: number
		): void {
			const settings = deps.getSessionSettings(sessionId);
			const maxConcurrent = settings?.max_concurrent ?? 1;
			const queueSize = settings?.queue_size ?? 10;
			const currentCount = activeRunCount.get(sessionId) ?? 0;

			if (currentCount >= maxConcurrent) {
				// At concurrency limit — queue the event
				const sessionName = getSessionName(sessionId);

				// Guard: queue_size <= 0 means "no buffering allowed". Without
				// this, the overflow branch below dereferences queue[0] on an
				// empty queue and crashes. Treat the incoming event itself as
				// dropped (not the non-existent oldest) and return early.
				if (queueSize <= 0) {
					deps.onQueueOverflow?.({
						sessionId,
						sessionName,
						subscriptionName,
						queuedAt: queuedAtOverride ?? Date.now(),
					});
					deps.onLog(
						'cue',
						`[CUE] Queue disabled for "${sessionName}" (queue_size=${queueSize}), dropping incoming event`
					);
					return;
				}

				if (!eventQueue.has(sessionId)) {
					eventQueue.set(sessionId, []);
				}
				const queue = eventQueue.get(sessionId)!;

				if (queue.length >= queueSize) {
					// Drop the oldest entry. Surface this to the user via the
					// onQueueOverflow callback (12B) — without it the drop is
					// invisible except to someone scraping logs.
					const dropped = queue[0];
					deps.onQueueOverflow?.({
						sessionId,
						sessionName,
						subscriptionName: dropped.subscriptionName,
						queuedAt: dropped.queuedAt,
					});
					// Remove the persisted row before shifting from memory so
					// persistence and in-memory stay in lockstep.
					if (dropped.persistId) deps.queuePersistence?.remove(dropped.persistId);
					queue.shift();
					deps.onLog('cue', `[CUE] Queue full for "${sessionName}", dropping oldest event`);
				}

				const persistId = deps.queuePersistence ? crypto.randomUUID() : undefined;
				// Preserve the original queuedAt when the engine restores a
				// persisted row so the staleness check in drainQueue still
				// behaves correctly relative to the user's actual wait time.
				const queuedAt = queuedAtOverride ?? Date.now();
				const queuedEntry: QueuedEvent = {
					event,
					subscription: { name: subscriptionName, event: event.type, enabled: true, prompt },
					prompt,
					outputPrompt,
					subscriptionName,
					queuedAt,
					chainDepth,
					cliOutput,
					action,
					command,
					persistId,
				};
				queue.push(queuedEntry);

				// Persist AFTER the in-memory push so the row appears only for
				// entries that actually made it into the live queue. Safe
				// wrappers mean a persist failure cannot break the live queue.
				if (deps.queuePersistence && persistId) {
					deps.queuePersistence.persist(sessionId, persistId, {
						event,
						subscriptionName,
						prompt,
						outputPrompt,
						cliOutput,
						action,
						command,
						chainDepth,
						queuedAt,
					});
				}

				deps.onLog(
					'cue',
					`[CUE] Event queued for "${sessionName}" (${queue.length}/${queueSize} in queue, ${currentCount}/${maxConcurrent} concurrent)`
				);
				return;
			}

			// Slot available — dispatch immediately
			activeRunCount.set(sessionId, currentCount + 1);
			doExecuteCueRun(
				sessionId,
				prompt,
				event,
				subscriptionName,
				outputPrompt,
				chainDepth,
				cliOutput,
				action,
				command
			);
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
			} satisfies CueLogPayload);
			return true;
		},

		stopAll(): void {
			// Clear the queue FIRST, then stop active runs. stopRun calls
			// drainQueue internally when it releases a concurrency slot; if
			// the queue still has entries at that point, the drain dispatches
			// a fresh run that escapes this stopAll invocation. Clearing the
			// queue up-front makes every nested drain a no-op, so after this
			// function returns there are zero active runs AND zero queued
			// events — the contract callers (engine shutdown / Cue toggle
			// off) actually need.
			eventQueue.clear();
			deps.queuePersistence?.clearAll();
			for (const runId of [...activeRuns.keys()]) {
				this.stopRun(runId);
			}
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
				// Mirror the in-memory clear on disk so persisted rows don't
				// outlive the live queue they represent.
				const queue = eventQueue.get(sessionId);
				if (queue) {
					for (const entry of queue) {
						if (entry.persistId) deps.queuePersistence?.remove(entry.persistId);
					}
				}
				eventQueue.delete(sessionId);
				return;
			}
			const queue = eventQueue.get(sessionId);
			if (!queue) return;
			const kept = queue.filter((e) => e.event.type === 'app.startup');
			// Remove persisted rows for entries we are dropping (non-startup).
			for (const entry of queue) {
				if (entry.event.type !== 'app.startup' && entry.persistId) {
					deps.queuePersistence?.remove(entry.persistId);
				}
			}
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
			// Reset tears down everything — persisted copies too. Any re-enqueue
			// after reset() will generate fresh persist IDs.
			deps.queuePersistence?.clearAll();
		},
	};
}
