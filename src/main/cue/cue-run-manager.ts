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
import { DEFAULT_CUE_SETTINGS } from '../../shared/cue';
import type { CueLogPayload } from '../../shared/cue-log-types';
import type {
	CueCommand,
	CueEvent,
	CueNotifyConfig,
	CueRunResult,
	CueSettings,
	CueSubscription,
} from './cue-types';
import {
	updateCueEventStatus,
	safeRecordCueEvent,
	safeUpdateCueEventStatus,
	type CueEventFailureInfo,
} from './cue-db';
import type { CueQueuePersistence } from './cue-queue-persistence';
import { SOURCE_OUTPUT_MAX_CHARS } from './cue-fan-in-tracker';
import { sliceHeadByChars } from './cue-text-utils';
import { captureException } from '../utils/sentry';
import { substituteTemplateVariables, type TemplateContext } from '../../shared/templateVariables';
import { buildCueTemplateContext } from './cue-template-context-builder';
import { runMaestroCliSend } from './cue-cli-executor';

/** Cap on persisted error_message length — enough to carry an agent error
 *  envelope / stderr tail without bloating the journal DB. */
const MAX_CUE_ERROR_MESSAGE_CHARS = 2000;

/**
 * Map a run result to the failure diagnostics persisted on its `cue_events`
 * row. `errorMessage` is the trimmed/capped stderr, set only for non-completed
 * runs (a success has nothing to explain); `exitCode` is always carried so the
 * activity log can distinguish failure modes — e.g. a maestro-p idle timeout
 * (3) from a first_byte_timeout (5) from a plain non-zero agent exit.
 */
function failureInfoFromResult(
	result: Pick<CueRunResult, 'status' | 'stderr' | 'exitCode'>
): CueEventFailureInfo {
	const trimmed = result.stderr?.trim() ?? '';
	const errorMessage =
		result.status !== 'completed' && trimmed
			? sliceHeadByChars(trimmed, MAX_CUE_ERROR_MESSAGE_CHARS)
			: null;
	return { errorMessage, exitCode: result.exitCode ?? null };
}

/** Phase of a run in the state machine: running → stopping | finished */
export type RunPhase = 'running' | 'stopping' | 'finished';

/** Active run tracking */
export interface ActiveRun {
	result: CueRunResult;
	abortController?: AbortController;
	phase: RunPhase;
	/** The runId of the currently executing child process (differs from result.runId during output prompt phase) */
	processRunId?: string;
	/** Phase 01 — chain lineage carried for the completion notification. Equals
	 *  `result.runId` for root runs and the inherited value for descendants.
	 *  Persisted to `cue_events.chain_root_id` at write time and propagated to
	 *  the next dispatched run via `AgentCompletionData.chainRootId`. */
	chainRootId?: string;
	/** Self-overlap guard key (`${sessionId}\u0000${subscriptionName}`) for root
	 *  triggers (chainDepth 0). Held while the run is active so the same root
	 *  subscription can't run concurrently with itself; cleared on completion or
	 *  stop. Undefined for chained (depth > 0) runs, which are never guarded. */
	rootKey?: string;
}

/** A queued event waiting for a concurrency slot */
export interface QueuedEvent {
	event: CueEvent;
	subscription: CueSubscription;
	prompt: string;
	outputPrompt?: string;
	subscriptionName: string;
	/** `pipeline_name` from the subscription, for human-friendly run labels.
	 *  Not persisted to the queue DB (no schema column); restored entries
	 *  fall back to undefined and the summary builder degrades to the legacy
	 *  `<base>-chain-N` strip. */
	pipelineName?: string;
	queuedAt: number;
	chainDepth?: number;
	cliOutput?: { target: string };
	action?: CueSubscription['action'];
	command?: CueCommand;
	/** Resolved notify config for `action: notify` runs. The dispatcher
	 *  collapses `subscription.notify` + the message fallback chain into
	 *  `{ message, sticky? }` before enqueueing so the executor doesn't
	 *  need to re-derive anything. Optional — non-notify actions leave
	 *  this undefined. */
	notify?: CueNotifyConfig;
	/** Phase 12A — DB row id for the persisted copy, when persistence is enabled. */
	persistId?: string;
	/** Phase 01 — chain lineage propagated from the dispatching parent. When
	 *  unset, the resulting run becomes a fresh chain root (its own `runId`
	 *  becomes the `chainRootId` and `parentEventId` stays NULL). */
	chainRootId?: string;
	parentEventId?: string;
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
		notify?: CueNotifyConfig;
	}) => Promise<CueRunResult>;
	onStopCueRun?: (runId: string) => boolean;
	onLog: (level: MainLogLevel, message: string, data?: unknown) => void;
	/** Called when a run finishes naturally (completed/failed/timeout) — pushes to activity log AND triggers chain propagation */
	onRunCompleted: (
		sessionId: string,
		result: CueRunResult,
		subscriptionName: string,
		chainDepth?: number,
		chainRootId?: string
	) => void;
	/** Called when a run is manually stopped — pushes to activity log only (no chain propagation) */
	onRunStopped: (result: CueRunResult) => void;
	/** Optional metadata-only hook fired once when a run starts — threaded to the
	 * plugin event bus to surface `cue.runStarted` to subscribed plugins; ids only. */
	onRunStarted?: (info: { runId: string; sessionId: string; subscriptionName: string }) => void;
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
	/**
	 * Phase 01 — gate for `pipeline_id` / `chain_root_id` / `parent_event_id`
	 * writes on `cue_events`. When false, every safeRecordCueEvent call from
	 * this manager passes `null` for the three additive columns, leaving the
	 * row's stats fields blank. Independent of the master Cue toggle —
	 * the engine still runs, it just doesn't record stats lineage. Optional
	 * for back-compat with tests that don't construct the run manager via
	 * the engine; when omitted, defaults to off (no stats writes).
	 */
	getUsageStatsEnabled?: () => boolean;
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
		queuedAtOverride?: number,
		/**
		 * `pipeline_name` from the dispatching subscription, propagated onto
		 * the resulting CueRunResult so list views (history, activity log)
		 * can label the run with the user-facing pipeline name instead of
		 * the legacy `Maestro-chain-2` plumbing name. Optional — undefined
		 * for restored persisted-queue rows, legacy YAML, and ad-hoc tests.
		 * Trailing-positional rather than wedged into the middle so existing
		 * 4-arg `execute(...)` call sites keep working without churn.
		 */
		pipelineName?: string,
		/**
		 * Phase 01 — chain lineage values. `chainRootId` is the inherited
		 * root identity (or undefined when this run is itself a root, in
		 * which case `doExecuteCueRun` snapshots `runId` as the root id at
		 * record time). `parentEventId` is the immediate parent run's
		 * `runId`, or undefined for root events. Both also persisted on
		 * `QueuedEvent` so they survive concurrency-gated buffering.
		 */
		chainRootId?: string,
		parentEventId?: string,
		/**
		 * Resolved notify config for `action: notify` runs (message already
		 * collapsed by the dispatch service). Threaded through the queue so
		 * concurrency-gated notify runs still surface the right toast body
		 * and sticky flag when they drain.
		 */
		notify?: CueNotifyConfig
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

	// Self-overlap guard. Holds the rootKey of every root trigger (chainDepth 0)
	// that is currently running. A root subscription must never run concurrently
	// with itself: before max_concurrent could exceed 1 the per-session slot
	// counter happened to serialize runs, which masked this. Once concurrency >
	// 1 the same trigger firing twice would overlap and double its side effects
	// (e.g. a posting pipeline replying twice). This set makes the
	// no-self-overlap rule explicit and independent of the slot count, while
	// still letting DIFFERENT subscriptions run in parallel up to max_concurrent.
	const activeRootKeys = new Set<string>();

	/** Stable identity for a root trigger; null for chained (depth > 0) runs,
	 *  which are part of an already-serialized chain and never self-guarded. */
	function rootKeyFor(
		sessionId: string,
		subscriptionName: string,
		chainDepth?: number
	): string | null {
		if ((chainDepth ?? 0) !== 0) return null;
		return `${sessionId}\u0000${subscriptionName}`;
	}

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
		const maxConcurrent = settings?.max_concurrent ?? DEFAULT_CUE_SETTINGS.max_concurrent;
		const timeoutMs =
			(settings?.timeout_minutes ?? DEFAULT_CUE_SETTINGS.timeout_minutes) * 60 * 1000;
		const sessionName = getSessionName(sessionId);

		// Index scan (not a head-only shift): the same-root guard below may skip
		// over a blocked entry to dispatch a later one, so we walk the queue and
		// splice out whatever we consume rather than always taking queue[0].
		let i = 0;
		while (i < queue.length) {
			const currentCount = activeRunCount.get(sessionId) ?? 0;
			if (currentCount >= maxConcurrent) break;

			const entry = queue[i];
			const ageMs = Date.now() - entry.queuedAt;

			// Check for stale events
			if (ageMs > timeoutMs) {
				queue.splice(i, 1);
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
				const droppedLineage = buildLineageColumns({
					runId: droppedRunId,
					chainRootId: entry.chainRootId,
					parentEventId: entry.parentEventId,
					pipelineName: entry.pipelineName,
				});
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
					...droppedLineage,
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

			// Same-root overlap guard: if another run of this exact root
			// subscription is still active, leave the entry queued and try the
			// next one. A different subscription can still claim the free slot;
			// this entry drains when its in-flight sibling finishes.
			const entryRootKey = rootKeyFor(sessionId, entry.subscriptionName, entry.chainDepth);
			if (entryRootKey && activeRootKeys.has(entryRootKey)) {
				i++;
				continue;
			}

			// Dispatch the queued event. Remove from the queue and its persisted
			// row first — the dispatch promise may outlive another drain/reset
			// cycle and we must not leave a ghost row referencing an in-flight run.
			queue.splice(i, 1);
			if (entry.persistId) deps.queuePersistence?.remove(entry.persistId);
			activeRunCount.set(sessionId, currentCount + 1);
			doExecuteCueRun(
				sessionId,
				entry.prompt,
				entry.event,
				entry.subscriptionName,
				entry.pipelineName,
				entry.outputPrompt,
				entry.chainDepth,
				entry.cliOutput,
				entry.action,
				entry.command,
				entry.chainRootId,
				entry.parentEventId,
				entry.notify
			);
		}

		// Clean up empty queue
		if (queue.length === 0) {
			eventQueue.delete(sessionId);
		}
	}

	/**
	 * Phase 01 — assemble the three additive `cue_events` columns. Returns
	 * `{ pipelineId, chainRootId, parentEventId }` set to live values when
	 * `getUsageStatsEnabled()` is true, or all-null when disabled (so the
	 * row's stats lineage stays NULL even when we have the data in memory).
	 * Centralized so every safeRecordCueEvent call site honors the same gate
	 * without duplicating the conditional.
	 */
	function buildLineageColumns(args: {
		runId: string;
		chainRootId?: string;
		parentEventId?: string;
		pipelineName?: string;
	}): { pipelineId: string | null; chainRootId: string | null; parentEventId: string | null } {
		if (!deps.getUsageStatsEnabled?.()) {
			return { pipelineId: null, chainRootId: null, parentEventId: null };
		}
		// Root events use their own runId as the chain root; descendants
		// inherit via the explicit chainRootId arg.
		const effectiveChainRootId = args.chainRootId ?? args.runId;
		return {
			pipelineId: args.pipelineName ?? null,
			chainRootId: effectiveChainRootId,
			parentEventId: args.parentEventId ?? null,
		};
	}

	async function doExecuteCueRun(
		sessionId: string,
		prompt: string,
		event: CueEvent,
		subscriptionName: string,
		pipelineName: string | undefined,
		outputPrompt?: string,
		chainDepth?: number,
		cliOutput?: { target: string },
		action?: CueSubscription['action'],
		command?: CueCommand,
		incomingChainRootId?: string,
		parentEventId?: string,
		notify?: CueNotifyConfig
	): Promise<void> {
		const sessionName = getSessionName(sessionId);
		const settings = deps.getSessionSettings(sessionId);
		const runId = crypto.randomUUID();
		const abortController = new AbortController();
		// Snapshot the chain root identity at run-start: descendants inherit it
		// from the dispatching parent; roots become their own root id. Held on
		// ActiveRun so the completion notification can propagate it to the
		// next run in the chain.
		const effectiveChainRootId = incomingChainRootId ?? runId;

		const result: CueRunResult = {
			runId,
			sessionId,
			sessionName,
			subscriptionName,
			pipelineName,
			event,
			status: 'running',
			stdout: '',
			stderr: '',
			exitCode: null,
			durationMs: 0,
			startedAt: new Date().toISOString(),
			endedAt: '',
		};

		// Claim the self-overlap guard for root triggers, synchronously before
		// the first await, so any concurrent admit/drain sees this run as active
		// and serializes a same-root sibling instead of overlapping it. Released
		// on completion (finally) and on stopRun.
		const myRootKey = rootKeyFor(sessionId, subscriptionName, chainDepth);
		if (myRootKey) activeRootKeys.add(myRootKey);

		activeRuns.set(runId, {
			result,
			abortController,
			phase: 'running',
			chainRootId: effectiveChainRootId,
			rootKey: myRootKey ?? undefined,
		});
		deps.onPreventSleep?.(`cue:run:${runId}`);
		const timeoutMs =
			(settings?.timeout_minutes ?? DEFAULT_CUE_SETTINGS.timeout_minutes) * 60 * 1000;
		const parentLineage = buildLineageColumns({
			runId,
			chainRootId: incomingChainRootId,
			parentEventId,
			pipelineName,
		});
		safeRecordCueEvent({
			id: runId,
			type: event.type,
			triggerName: event.triggerName,
			sessionId,
			subscriptionName,
			status: 'running',
			payload: JSON.stringify(event.payload),
			...parentLineage,
		});
		deps.onLog('cue', `[CUE] Run started: ${subscriptionName}`, {
			type: 'runStarted',
			runId,
			sessionId,
			subscriptionName,
		} satisfies CueLogPayload);
		deps.onRunStarted?.({ runId, sessionId, subscriptionName });

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
				notify,
			});
			if (!activeRuns.has(runId)) {
				// Engine was stopped (or run was cleared) while onCueRun was in
				// flight. The finally block's cleanup is gated on activeRuns
				// having this run, so without an explicit DB write the row
				// would stay `running` forever in the activity log.
				safeUpdateCueEventStatus(
					runId,
					runResult.status,
					runResult.providerSessionId,
					failureInfoFromResult(runResult)
				);
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
			// Carry the main task's provider session id for token attribution.
			// The output-prompt phase (below) overwrites stdout but NOT this —
			// it records its own session id on its own event row (outputRunId).
			result.providerSessionId = runResult.providerSessionId;

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

				// Output-prompt phase is logically a child of the parent run:
				// inherit the same chain root, point parent at the parent run.
				// This keeps stats queries that walk by chain_root_id from
				// orphaning the second leg of a two-phase run.
				const outputLineage = buildLineageColumns({
					runId: outputRunId,
					chainRootId: effectiveChainRootId,
					parentEventId: runId,
					pipelineName,
				});
				safeRecordCueEvent({
					id: outputRunId,
					type: event.type,
					triggerName: event.triggerName,
					sessionId,
					subscriptionName: `${subscriptionName}:output`,
					status: 'running',
					payload: JSON.stringify(outputEvent.payload),
					...outputLineage,
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
						updateCueEventStatus(
							outputRunId,
							outputStatus,
							outputResult?.providerSessionId,
							outputResult ? failureInfoFromResult(outputResult) : undefined
						);
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
					safeUpdateCueEventStatus(
						runId,
						result.status,
						result.providerSessionId,
						failureInfoFromResult(result)
					);
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

				const count = activeRunCount.get(sessionId) ?? 0;
				activeRunCount.set(sessionId, Math.max(0, count - 1));
				// Release the self-overlap guard BEFORE draining so a same-root
				// sibling that was held back can now be admitted by drainQueue.
				if (myRootKey) activeRootKeys.delete(myRootKey);
				drainQueue(sessionId);

				try {
					updateCueEventStatus(
						runId,
						result.status,
						result.providerSessionId,
						failureInfoFromResult(result)
					);
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

				// Notify engine of completion (for activity log + chain propagation).
				// Forward this run's chainRootId so the engine can stamp it onto
				// the AgentCompletionData passed to the completion service —
				// the next run dispatched off this completion inherits the
				// same root identity (or this run's runId, if it was itself
				// a root).
				deps.onRunCompleted(sessionId, result, subscriptionName, chainDepth, effectiveChainRootId);
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
			queuedAtOverride?: number,
			pipelineName?: string,
			chainRootId?: string,
			parentEventId?: string,
			notify?: CueNotifyConfig
		): void {
			const settings = deps.getSessionSettings(sessionId);
			const maxConcurrent = settings?.max_concurrent ?? DEFAULT_CUE_SETTINGS.max_concurrent;
			const queueSize = settings?.queue_size ?? DEFAULT_CUE_SETTINGS.queue_size;
			const currentCount = activeRunCount.get(sessionId) ?? 0;

			// Self-overlap guard: a root trigger whose own subscription is already
			// running must queue and wait even when a concurrency slot is free.
			// This is the fix for "pipelines double-fire at max_concurrent > 1" —
			// the same trigger no longer overlaps itself and duplicates its
			// side effects. Different subscriptions are unaffected and still
			// parallelize up to max_concurrent.
			const incomingRootKey = rootKeyFor(sessionId, subscriptionName, chainDepth);
			const sameRootActive = incomingRootKey ? activeRootKeys.has(incomingRootKey) : false;

			if (currentCount >= maxConcurrent || sameRootActive) {
				// At concurrency limit (or blocked by an in-flight same-root run) —
				// queue the event.
				const sessionName = getSessionName(sessionId);

				// Note in the log when the queueing is purely due to the
				// self-overlap guard (a slot was free) so the wait isn't
				// mistaken for a concurrency-limit backlog.
				if (sameRootActive && currentCount < maxConcurrent) {
					deps.onLog(
						'cue',
						`[CUE] "${subscriptionName}" already running — serializing re-trigger (slot free, same-subscription overlap blocked)`
					);
				}

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
					pipelineName,
					queuedAt,
					chainDepth,
					cliOutput,
					action,
					command,
					notify,
					persistId,
					chainRootId,
					parentEventId,
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
						chainRootId,
						parentEventId,
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
				pipelineName,
				outputPrompt,
				chainDepth,
				cliOutput,
				action,
				command,
				chainRootId,
				parentEventId,
				notify
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
			const count = activeRunCount.get(run.result.sessionId) ?? 0;
			activeRunCount.set(run.result.sessionId, Math.max(0, count - 1));
			// Release the self-overlap guard so a held-back same-root sibling can
			// drain into the slot this stopped run just vacated.
			if (run.rootKey) activeRootKeys.delete(run.rootKey);
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
			// Each stopRun above releases its own key; clear defensively so a
			// torn-down engine never leaves a stale guard that would wrongly
			// block the first run after restart.
			activeRootKeys.clear();
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
			activeRootKeys.clear();
			eventQueue.clear();
			// Reset tears down everything — persisted copies too. Any re-enqueue
			// after reset() will generate fresh persist IDs.
			deps.queuePersistence?.clearAll();
		},
	};
}
