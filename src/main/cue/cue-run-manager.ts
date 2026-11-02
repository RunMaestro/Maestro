import {
	isDurableCueEvent,
	authorizePluginCueEvent,
	preparePluginCueEvent,
	finishPluginCueEvent,
} from './triggers/cue-plugin-trigger-source';

/**
 * Cue Run Manager - concurrency control, queue management, and run execution.
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
import type { CueLogPayload, CueQueueDropReason } from '../../shared/cue-log-types';
import type {
	CueAutoRunConfig,
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
	type CueEventCompletionInfo,
} from './cue-db';
import type { CueQueuePersistence } from './cue-queue-persistence';
import { SOURCE_OUTPUT_MAX_CHARS } from './cue-fan-in-tracker';
import { buildCuePersistedOutput, sliceHeadByChars } from './cue-text-utils';
import { captureException } from '../utils/sentry';
import { substituteTemplateVariables, type TemplateContext } from '../../shared/templateVariables';
import { buildCueTemplateContext } from './cue-template-context-builder';
import { runMaestroCliSend } from './cue-cli-executor';
import type { CueTurnSettings } from '../../shared/cue/turn-settings';

/** Cap on persisted error_message length - enough to carry an agent error
 *  envelope / stderr tail without bloating the journal DB. */
const MAX_CUE_ERROR_MESSAGE_CHARS = 2000;

/**
 * Map a run result to everything stamped on its `cue_events` row at completion.
 *
 * `errorMessage` is the trimmed/capped stderr, set only for non-completed runs
 * (a success has nothing to explain); `exitCode` is always carried so the
 * activity log can distinguish failure modes - e.g. a maestro-p idle timeout
 * (3) from a first_byte_timeout (5) from a plain non-zero agent exit.
 *
 * `outputExcerpt` / `fullOutput` come from the same derivation the JSONL
 * history writer uses, so the row and the history entry never disagree about
 * what a run said. Both are null for a run that printed nothing - that is the
 * signal the Activity Log and History filter on.
 */
function completionInfoFromResult(
	result: Pick<CueRunResult, 'status' | 'stdout' | 'stderr' | 'exitCode' | 'usage'>
): CueEventCompletionInfo {
	const trimmed = result.stderr?.trim() ?? '';
	const errorMessage =
		result.status !== 'completed' && trimmed
			? sliceHeadByChars(trimmed, MAX_CUE_ERROR_MESSAGE_CHARS)
			: null;
	const { excerpt, fullOutput } = buildCuePersistedOutput(result);
	return {
		errorMessage,
		exitCode: result.exitCode ?? null,
		outputExcerpt: excerpt,
		fullOutput,
		streamUsageJson: result.usage ? JSON.stringify(result.usage) : null,
	};
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
	/** Phase 01 - chain lineage carried for the completion notification. Equals
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
	 *  need to re-derive anything. Optional - non-notify actions leave
	 *  this undefined. */
	notify?: CueNotifyConfig;
	/** Captured Auto Run payload for `action: autorun` runs. Travels with the
	 *  run so the launch is pinned to the documents chosen when the run was
	 *  scheduled, rather than re-resolved from the agent's (mutable) Auto Run
	 *  folder at fire time. Optional - other actions leave this undefined. */
	autoRun?: CueAutoRunConfig;
	/** The subscription's `tier` / `model` / `effort`, resolved against the
	 *  target agent at spawn time. Undefined when the subscription sets none. */
	turnSettings?: CueTurnSettings;
	/** Phase 12A - DB row id for the persisted copy, when persistence is enabled. */
	persistId?: string;
	/** Phase 01 - chain lineage propagated from the dispatching parent. When
	 *  unset, the resulting run becomes a fresh chain root (its own `runId`
	 *  becomes the `chainRootId` and `parentEventId` stays NULL). */
	chainRootId?: string;
	parentEventId?: string;
}

export interface CueRunManagerDeps {
	getSessions: () => { id: string; name: string }[];
	getSessionSettings: (sessionId: string) => CueSettings | undefined;
	/** Live owner and loaded runtime readiness; distinct from current plugin authority. */
	canDrainSession?: (sessionId: string) => boolean;
	/** Queued durable rows retained on disk after live teardown; never retries synchronously. */
	onDurableRowsDetached?: (
		sessionId: string,
		entries: readonly Pick<QueuedEvent, 'persistId' | 'subscriptionName'>[]
	) => void;
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
		/**
		 * Aborted when the run is stopped. A launch that has not spawned its
		 * process yet checks it before spawning and returns `stopped` instead
		 * (see `cue-launch-cancel.ts`); both phases of a two-phase run get it.
		 */
		signal?: AbortSignal;
		autoRun?: CueAutoRunConfig;
		turnSettings?: CueTurnSettings;
	}) => Promise<CueRunResult>;
	onStopCueRun?: (runId: string) => boolean;
	onLog: (level: MainLogLevel, message: string, data?: unknown) => void;
	/** Called when a run finishes naturally (completed/failed/timeout) - pushes to activity log AND triggers chain propagation */
	onRunCompleted: (
		sessionId: string,
		result: CueRunResult,
		subscriptionName: string,
		chainDepth?: number,
		chainRootId?: string
	) => void;
	/** Called when a run is manually stopped - pushes to activity log only (no chain propagation) */
	onRunStopped: (result: CueRunResult) => void;
	/** Optional metadata-only hook fired once when a run starts - threaded to the
	 * plugin event bus to surface `cue.runStarted` to subscribed plugins; ids only. */
	onRunStarted?: (info: { runId: string; sessionId: string; subscriptionName: string }) => void;
	/** Called to prevent system sleep (e.g., when a Cue run starts) */
	onPreventSleep?: (reason: string) => void;
	/** Called to allow system sleep (e.g., when a Cue run ends) */
	onAllowSleep?: (reason: string) => void;
	/**
	 * Phase 12B - called when an event is dropped from the queue due to
	 * overflow (queue already at `queue_size`). The caller is expected to
	 * surface this to the user (toast, log banner) so the drop is visible.
	 */
	onQueueOverflow?: (
		payload: Omit<Extract<CueLogPayload, { type: 'queueOverflow' }>, 'type'>
	) => void;
	/**
	 * Phase 12A - optional queue persistence façade. When provided, every
	 * enqueue writes a row to disk and every drain/drop/clear removes it,
	 * allowing the queue to survive engine shutdown or a hard app crash. Omit
	 * to run entirely in-memory (preserves back-compat for tests and for the
	 * main process if persistence ever needs to be disabled).
	 */
	queuePersistence?: CueQueuePersistence;
	/**
	 * Phase 01 - gate for `pipeline_id` / `chain_root_id` / `parent_event_id`
	 * writes on `cue_events`. When false, every safeRecordCueEvent call from
	 * this manager passes `null` for the three additive columns, leaving the
	 * row's stats fields blank. Independent of the master Cue toggle -
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
		 * Phase 12A - optional pre-existing `queuedAt` used by the engine's
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
		 * the legacy `Maestro-chain-2` plumbing name. Optional - undefined
		 * for restored persisted-queue rows, legacy YAML, and ad-hoc tests.
		 * Trailing-positional rather than wedged into the middle so existing
		 * 4-arg `execute(...)` call sites keep working without churn.
		 */
		pipelineName?: string,
		/**
		 * Phase 01 - chain lineage values. `chainRootId` is the inherited
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
		notify?: CueNotifyConfig,
		/**
		 * Captured Auto Run payload for `action: autorun` runs. Threaded
		 * through the queue alongside `notify` so a concurrency-gated
		 * scheduled run still launches the documents it was scheduled with.
		 */
		autoRun?: CueAutoRunConfig,
		/** The subscription's model choice, threaded through the queue. */
		turnSettings?: CueTurnSettings,
		exemptFromQueueCap?: boolean
	): void | boolean;
	/**
	 * Record an event that was skipped before anything was spawned (a
	 * subscription's `gate` said no, or the prompt-injection screen refused
	 * it). Writes one `cue_events` row, born in its final status, and returns
	 * the result for the activity log.
	 *
	 * It claims no concurrency slot, holds no self-overlap guard, and raises no
	 * completion: nothing ran, so nothing downstream may fire off it.
	 */
	recordSkippedRun(skipped: {
		sessionId: string;
		event: CueEvent;
		subscriptionName: string;
		pipelineName?: string;
		status: Extract<CueRunResult['status'], 'gated' | 'blocked-injection'>;
		/** Why it was skipped, when a person should read it in History. */
		reason?: string;
		/** When the check that skipped it began (ms). Defaults to now. */
		startedAt?: number;
		chainRootId?: string;
		parentEventId?: string;
	}): CueRunResult;
	stopRun(runId: string): boolean;
	stopAll(): void | boolean;
	/**
	 * Drain gate (`CueEngine.drain`). While on, `execute` never starts a run:
	 * every event is queued and persisted regardless of `queue_size`, and
	 * the queue never drains. Off by default; the desktop never sets it.
	 */
	setDraining(draining: boolean): void;
	/** Resolves once no run is active (immediately when none is). */
	whenIdle(): Promise<void>;
	/**
	 * Runs already stopped (or discarded) whose launch has not returned yet:
	 * one still awaiting its executor, spawn spec or SSH probe, or one whose
	 * process has not exited. Not in `getActiveRuns()`, so the drain waits on
	 * this before it releases the lock.
	 */
	getUnsettledStoppedRunCount(): number;
	/**
	 * Re-persist every queued entry stamped with `drainedAt`, so restore can
	 * tell deferred work from a crash leftover (see cue-queue-persistence).
	 * Returns how many entries were written.
	 */
	persistQueueForRestart(drainedAt: number): number;
	/**
	 * Forget active runs and the queue in memory WITHOUT touching persisted
	 * rows. The drain's last step; `reset()` would delete the rows it just
	 * deferred.
	 */
	discardInMemory(): void;
	getActiveRuns(): CueRunResult[];
	getActiveRunCount(sessionId: string): number;
	getActiveRunMap(): Map<string, ActiveRun>;
	getQueueStatus(): Map<string, number>;
	/**
	 * Drop a session's queued events. `preserveStartup` keeps `app.startup`
	 * entries.
	 */
	clearQueue(sessionId: string, preserveStartup?: boolean): void | boolean;
	/**
	 * Settle a session's queue after a cue.yaml reload. `classify` returns
	 * null to keep an entry, or why it is dropped. A dropped entry loses its
	 * persisted row and is recorded in `cue_events` as never run, the way a
	 * stale drop is, with one `queueDropped` log line per reason. A queued
	 * event can be a webhook delivery already answered 2xx, so it never
	 * disappears without a trace. Returns how many entries were dropped.
	 */
	retainQueue(
		sessionId: string,
		classify: (entry: QueuedEvent) => CueQueueDropReason | null
	): number;
	reset(): void | boolean;
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

	/** Set by the drain (see `setDraining`): queue everything, start nothing. */
	let draining = false;
	/**
	 * Runs the drain stopped. Their process exits after `stopRun` already
	 * recorded `stopped`, and a shell or maestro-cli run reports that exit as
	 * its own status (`failed` on a signal), which would overwrite the row. The
	 * drain keeps `stopped`. (A desktop manual stop is left as it was.)
	 */
	const drainStoppedRuns = new Set<string>();
	/**
	 * Runs removed from `activeRuns` by a stop (or a reset) while their
	 * `doExecuteCueRun` is still awaiting `onCueRun`. Their signal is aborted,
	 * so a launch that has not spawned yet will not, but until it returns it
	 * is visible neither to `getActiveRuns()` nor to the process registry.
	 * Deleted when `doExecuteCueRun` returns.
	 */
	const unsettledStoppedRuns = new Set<string>();
	/** Abort a run that is leaving `activeRuns` and cover its launch until it settles. */
	function cancelLaunch(runId: string, run: ActiveRun): void {
		unsettledStoppedRuns.add(runId);
		run.abortController?.abort();
	}
	/** Callers of `whenIdle()` waiting for the last active run to leave. */
	let idleWaiters: Array<() => void> = [];
	function notifyIfIdle(): void {
		if (activeRuns.size > 0 || idleWaiters.length === 0) return;
		const waiters = idleWaiters;
		idleWaiters = [];
		for (const resolve of waiters) resolve();
	}

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
		// The drain defers every queued event to the next start.
		if (draining) return;
		const queue = eventQueue.get(sessionId);
		if (!queue || queue.length === 0) return;

		const settings = deps.getSessionSettings(sessionId);
		const maxConcurrent = settings?.max_concurrent ?? 1;
		const timeoutMs = (settings?.timeout_minutes ?? 30) * 60 * 1000;
		const sessionName = getSessionName(sessionId);

		// Index scan (not a head-only shift): the same-root guard below may skip
		// over a blocked entry to dispatch a later one, so we walk the queue and
		// splice out whatever we consume rather than always taking queue[0].
		let i = 0;
		while (i < queue.length) {
			const currentCount = activeRunCount.get(sessionId) ?? 0;
			if (currentCount >= maxConcurrent) break;

			const entry = queue[i];
			if (isDurableCueEvent(entry.event) && deps.canDrainSession?.(sessionId) === false) {
				i++;
				continue;
			}
			const ageMs = Date.now() - entry.queuedAt;

			// Check for stale events
			if (!isDurableCueEvent(entry.event) && ageMs > timeoutMs) {
				queue.splice(i, 1);
				const ageMinutes = Math.round(ageMs / 60000);
				// Remove the persisted copy - this runtime drain path is the
				// second half of the stale-drop handling (restore has its own).
				if (entry.persistId) deps.queuePersistence?.remove(entry.persistId);
				// Record the dropped event to the activity log so users can see
				// *why* their queued run never fired - previously these events
				// disappeared with only a log line, making it look like a bug.
				recordDroppedEntry(sessionId, entry, { queuedForMs: ageMs });
				// Emit as `queueDropped` (stale reason) rather than `runFinished`
				// with status: 'timeout'. Previously this path incremented
				// `runsTimedOut` via the metric interceptor, confounding real
				// runtime timeouts with queue-drain staleness. The DB row
				// still records status: 'timeout' so the user-facing activity
				// log shows the same symbol as before - only the internal
				// metric accounting differs.
				deps.onLog(
					'cue',
					`[CUE] Dropping stale queued event for "${sessionName}" (queued ${ageMinutes}m ago) - recorded as timeout in activity log`,
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
			// row first - the dispatch promise may outlive another drain/reset
			// cycle and we must not leave a ghost row referencing an in-flight run.
			queue.splice(i, 1);
			if (!authorizePluginCueEvent(entry.event, sessionId, entry.subscriptionName)) {
				if (entry.persistId) deps.queuePersistence?.remove(entry.persistId);
				continue;
			}
			if (entry.persistId && !isDurableCueEvent(entry.event))
				deps.queuePersistence?.remove(entry.persistId);
			activeRunCount.set(sessionId, currentCount + 1);
			const execution = doExecuteCueRun(
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
				entry.notify,
				entry.autoRun,
				entry.turnSettings
			);
			if (entry.persistId && isDurableCueEvent(entry.event))
				void execution.then(
					() => deps.queuePersistence?.remove(entry.persistId!),
					() => deps.queuePersistence?.remove(entry.persistId!)
				);
		}

		// Clean up empty queue
		if (queue.length === 0) {
			eventQueue.delete(sessionId);
		}
	}

	/**
	 * Record a queued event that will never run. The row is born finalized as
	 * `timeout` (no running→timeout flip), with `droppedFromQueue` and `details`
	 * merged into the event payload so the activity log can say why.
	 */
	function recordDroppedEntry(
		sessionId: string,
		entry: QueuedEvent,
		details: Record<string, unknown>
	): void {
		const droppedRunId = crypto.randomUUID();
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
				...details,
			}),
			...buildLineageColumns({
				runId: droppedRunId,
				chainRootId: entry.chainRootId,
				parentEventId: entry.parentEventId,
				pipelineName: entry.pipelineName,
			}),
		});
	}

	/**
	 * Phase 01 - assemble the three additive `cue_events` columns. Returns
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
		notify?: CueNotifyConfig,
		autoRun?: CueAutoRunConfig,
		turnSettings?: CueTurnSettings
	): Promise<void> {
		if (!authorizePluginCueEvent(event, sessionId, subscriptionName)) {
			activeRunCount.set(sessionId, Math.max(0, (activeRunCount.get(sessionId) ?? 1) - 1));
			return;
		}
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

		const retainAuthority = (): boolean => {
			if (authorizePluginCueEvent(event, sessionId, subscriptionName)) return true;
			result.status = 'stopped';
			result.stdout = '';
			result.stderr = '';
			return false;
		};

		let executorMayHaveStarted = false;
		const prepareAndRetainAuthority = async () => {
			if (!(await preparePluginCueEvent(event, sessionId, subscriptionName, true, runId))) {
				result.status = 'stopped';
				result.stdout = '';
				result.stderr = '';
				return false;
			}
			return !abortController.signal.aborted && retainAuthority();
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
		const timeoutMs = (settings?.timeout_minutes ?? 30) * 60 * 1000;
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
			...(pipelineName ? { pipelineId: pipelineName } : {}),
		} satisfies CueLogPayload);
		deps.onRunStarted?.({ runId, sessionId, subscriptionName });

		try {
			if (!(event.type === 'plugin.event' ? await prepareAndRetainAuthority() : retainAuthority()))
				return;
			executorMayHaveStarted = true;
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
				autoRun,
				turnSettings,
				signal: abortController.signal,
			});
			if (runResult.executionStarted === false) executorMayHaveStarted = false;
			if (
				!(event.type === 'plugin.event' ? await prepareAndRetainAuthority() : retainAuthority())
			) {
				if (!activeRuns.has(runId))
					safeUpdateCueEventStatus(
						runId,
						'stopped',
						runResult.providerSessionId,
						completionInfoFromResult(result)
					);
				return;
			}
			if (!activeRuns.has(runId)) {
				// Engine was stopped (or run was cleared) while onCueRun was in
				// flight. The finally block's cleanup is gated on activeRuns
				// having this run, so without an explicit DB write the row
				// would stay `running` forever in the activity log.
				const stoppedByDrain = drainStoppedRuns.delete(runId);
				const finalStatus = stoppedByDrain ? 'stopped' : runResult.status;
				safeUpdateCueEventStatus(
					runId,
					finalStatus,
					runResult.providerSessionId,
					completionInfoFromResult({ ...runResult, status: finalStatus })
				);
				// Emit with the structured runFinished payload so live
				// listeners (activity log, queue indicators) observe the
				// transition identically to a normal completion - this is
				// what renderer subscribers key off of.
				deps.onLog(
					'cue',
					`[CUE] Run "${subscriptionName}" completed after engine stop - status recorded (${finalStatus}), result discarded`,
					{
						type: 'runFinished',
						runId,
						sessionId,
						subscriptionName,
						status: finalStatus,
					} satisfies CueLogPayload
				);
				return;
			}
			result.status = runResult.status;
			result.stdout = runResult.stdout;
			result.stderr = runResult.stderr;
			result.exitCode = runResult.exitCode;
			// Carry the main task's provider session id and stream-parsed usage
			// for token attribution. The output-prompt phase (below) overwrites
			// stdout but NOT these - it records its own session id/usage on its
			// own event row (outputRunId).
			result.providerSessionId = runResult.providerSessionId;
			// Usage follows the same rule: this is the MAIN task's, and the
			// output phase does not fold its tokens in here.
			result.usage = runResult.usage;

			// Execute output prompt if the main task succeeded and an output prompt is configured.
			// Skipped for `action: command` runs - output_prompt is an AI follow-up, not a
			// shell/cli concept.
			if (outputPrompt && result.status === 'completed' && action !== 'command') {
				deps.onLog(
					'cue',
					`[CUE] "${subscriptionName}" executing output prompt for downstream handoff`
				);

				// Compute the sliced output ONCE - used for both the recorded
				// payload's sourceOutput and the context prompt below. The prior
				// code called sliceHeadByChars twice with identical arguments.
				const slicedOutput = sliceHeadByChars(result.stdout, SOURCE_OUTPUT_MAX_CHARS);

				const outputRunId = crypto.randomUUID();
				// Plugin provenance authenticates the exact opaque metadata. Agent output
				// belongs in the output prompt/result, never in the authenticated event payload.
				const outputEvent: CueEvent = isDurableCueEvent(event)
					? event
					: {
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
				// ALWAYS finalized - even if both the run and the status-update
				// call fail. Without this, a double-failure leaves the row
				// stuck at `running` and the activity log shows a phantom run.
				let outputResult: CueRunResult | undefined;
				let outputStatus: CueRunResult['status'] = 'failed';
				try {
					if (
						!(event.type === 'plugin.event' ? await prepareAndRetainAuthority() : retainAuthority())
					) {
						outputStatus = 'stopped';
						return;
					}
					const startedBeforeOutput = executorMayHaveStarted;
					executorMayHaveStarted = true;
					outputResult = await deps.onCueRun({
						runId: outputRunId,
						sessionId,
						prompt: contextPrompt,
						subscriptionName: `${subscriptionName}:output`,
						event: outputEvent,
						timeoutMs,
						// Same agent, same subscription: the follow-up runs on the
						// model the subscription chose for the main task.
						turnSettings,
						// The same signal: a stop during this phase cancels its launch too.
						signal: abortController.signal,
					});
					if (outputResult.executionStarted === false) executorMayHaveStarted = startedBeforeOutput;
					if (
						!(event.type === 'plugin.event' ? await prepareAndRetainAuthority() : retainAuthority())
					) {
						outputStatus = 'stopped';
						outputResult = { ...outputResult, status: 'stopped', stdout: '', stderr: '' };
						return;
					}
					outputStatus = outputResult.status;
				} finally {
					// Use the raw (throwing) updateCueEventStatus with our own
					// try/catch so the Sentry `operation` tag is specific to
					// this call site - distinguishing "output-phase finalize
					// failed" from generic "status update failed" when
					// triaging reports. The `safe*` wrappers tag everything
					// as `safeUpdateCueEventStatus`, which is too coarse to
					// tell this failure mode apart from a normal run update.
					try {
						updateCueEventStatus(
							outputRunId,
							outputStatus,
							outputResult?.providerSessionId,
							outputResult ? completionInfoFromResult(outputResult) : undefined
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
					// function is gated on `activeRuns.has(runId)` - which is now
					// false. Finalize it here so the activity log doesn't show a
					// phantom never-ending run. Mirrors the earlier handling at
					// line ~245 for the pre-output-prompt case.
					safeUpdateCueEventStatus(
						runId,
						result.status,
						result.providerSessionId,
						completionInfoFromResult(result)
					);
					deps.onLog(
						'cue',
						`[CUE] Run "${subscriptionName}" output phase completed after engine stop - parent status recorded (${result.status}), result discarded`,
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

			if (!(event.type === 'plugin.event' ? await prepareAndRetainAuthority() : retainAuthority()))
				return;

			// Phase 3: legacy cli_output delivery - shell out to maestro-cli send --live.
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
							`[CUE] "${subscriptionName}" CLI output target resolved to empty string (raw="${cliOutput.target}") - skipping delivery`
						);
					} else {
						if (
							!(event.type === 'plugin.event'
								? await prepareAndRetainAuthority()
								: retainAuthority())
						)
							return;
						const sendResult = await runMaestroCliSend(resolvedTarget, result.stdout);
						if (
							!(event.type === 'plugin.event'
								? await prepareAndRetainAuthority()
								: retainAuthority())
						)
							return;
						if (!sendResult.ok) {
							throw new Error(`CLI exited with code ${sendResult.exitCode}: ${sendResult.stderr}`);
						}
						deps.onLog(
							'cue',
							`[CUE] "${subscriptionName}" CLI output delivered to ${resolvedTarget}`
						);
					}
				} catch (cliError) {
					if (
						!(event.type === 'plugin.event' ? await prepareAndRetainAuthority() : retainAuthority())
					)
						return;
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
			try {
				await finishPluginCueEvent(event, runId, executorMayHaveStarted);
			} catch {
				// A missing ACK never reopens a claimed event. Preserve uncertainty.
			}
			try {
				// A stopped run's launch has returned: nothing of it is left to spawn.
				unsettledStoppedRuns.delete(runId);
				drainStoppedRuns.delete(runId);
				// Only clean up if the run is still tracked. If it was already removed
				// (by stopRun or reset), that caller handled its own cleanup.
				if (activeRuns.has(runId)) {
					// Natural completion - set final timing and perform all cleanup
					result.endedAt = new Date().toISOString();
					result.durationMs = Date.now() - new Date(result.startedAt).getTime();

					if (
						event.type === 'plugin.event' &&
						!(await preparePluginCueEvent(event, sessionId, subscriptionName))
					) {
						result.status = 'stopped';
						result.stdout = '';
						result.stderr = '';
					}
					retainAuthority();
					if (activeRuns.has(runId)) {
						transitionRun(runId, 'finished');
						activeRuns.delete(runId);
						deps.onAllowSleep?.(`cue:run:${runId}`);

						const count = activeRunCount.get(sessionId) ?? 0;
						activeRunCount.set(sessionId, Math.max(0, count - 1));
						// Release the self-overlap guard BEFORE draining so a same-root
						// sibling that was held back can now be admitted by drainQueue.
						if (myRootKey) activeRootKeys.delete(myRootKey);
						drainQueue(sessionId);

						// Cleanup/drain callbacks can revoke too. Fence the FIRST terminal
						// write and status notification, not only the later chain callback.
						retainAuthority();
						try {
							updateCueEventStatus(
								runId,
								result.status,
								result.providerSessionId,
								completionInfoFromResult(result)
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
							...(pipelineName ? { pipelineId: pipelineName } : {}),
						} satisfies CueLogPayload);

						// Notify engine of completion (for activity log + chain propagation).
						// Forward this run's chainRootId so the engine can stamp it onto
						// the AgentCompletionData passed to the completion service -
						// the next run dispatched off this completion inherits the
						// same root identity (or this run's runId, if it was itself
						// a root).
						if (!retainAuthority()) {
							safeUpdateCueEventStatus(
								runId,
								'stopped',
								result.providerSessionId,
								completionInfoFromResult(result)
							);
						}
						if (result.status === 'stopped') deps.onRunStopped(result);
						else
							deps.onRunCompleted(
								sessionId,
								result,
								subscriptionName,
								chainDepth,
								effectiveChainRootId
							);
						// After onRunCompleted, which can queue this run's successors: a drain
						// waiting for idleness must see them before it persists the queue.
						notifyIfIdle();
					}
				}
			} finally {
				unsettledStoppedRuns.delete(runId);
				drainStoppedRuns.delete(runId);
				notifyIfIdle();
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
			notify?: CueNotifyConfig,
			autoRun?: CueAutoRunConfig,
			turnSettings?: CueTurnSettings,
			exemptFromQueueCap?: boolean
		): void | boolean {
			if (!authorizePluginCueEvent(event, sessionId, subscriptionName)) return false;
			const settings = deps.getSessionSettings(sessionId);
			const maxConcurrent = settings?.max_concurrent ?? 1;
			const queueSize = settings?.queue_size ?? 0;
			// While draining, or for a deferred event restored after a drain, the
			// queue is a deferral rather than a buffer: never cap or drop it.
			const uncapped = draining || exemptFromQueueCap === true;
			const currentCount = activeRunCount.get(sessionId) ?? 0;

			// Self-overlap guard: a root trigger whose own subscription is already
			// running must queue and wait even when a concurrency slot is free.
			// This is the fix for "pipelines double-fire at max_concurrent > 1" -
			// the same trigger no longer overlaps itself and duplicates its
			// side effects. Different subscriptions are unaffected and still
			// parallelize up to max_concurrent.
			const incomingRootKey = rootKeyFor(sessionId, subscriptionName, chainDepth);
			const sameRootActive = incomingRootKey ? activeRootKeys.has(incomingRootKey) : false;

			if (draining || currentCount >= maxConcurrent || sameRootActive) {
				// At concurrency limit (or blocked by an in-flight same-root run) -
				// queue the event.
				const sessionName = getSessionName(sessionId);

				// Note in the log when the queueing is purely due to the
				// self-overlap guard (a slot was free) so the wait isn't
				// mistaken for a concurrency-limit backlog.
				if (!draining && sameRootActive && currentCount < maxConcurrent) {
					deps.onLog(
						'cue',
						`[CUE] "${subscriptionName}" already running - serializing re-trigger (slot free, same-subscription overlap blocked)`
					);
				}

				// Guard: queue_size <= 0 means "no buffering allowed". Without
				// this, the overflow branch below dereferences queue[0] on an
				// empty queue and crashes. Treat the incoming event itself as
				// dropped (not the non-existent oldest) and return early.
				if (queueSize <= 0 && !uncapped) {
					deps.onQueueOverflow?.({
						sessionId,
						sessionName,
						subscriptionName,
						queuedAt: queuedAtOverride ?? Date.now(),
						outcome: 'incoming-rejected',
					});
					deps.onLog(
						'cue',
						`[CUE] Queue disabled for "${sessionName}" (queue_size=${queueSize}), dropping incoming event`
					);
					return false;
				}

				if (!eventQueue.has(sessionId)) {
					eventQueue.set(sessionId, []);
				}
				const queue = eventQueue.get(sessionId)!;

				if (queue.length >= queueSize && !uncapped) {
					// Drop the oldest entry. Surface this to the user via the
					// onQueueOverflow callback (12B) - without it the drop is
					// invisible except to someone scraping logs.
					const dropped = queue[0];
					if (isDurableCueEvent(event) || isDurableCueEvent(dropped.event)) {
						deps.onQueueOverflow?.({
							sessionId,
							sessionName,
							subscriptionName,
							queuedAt: queuedAtOverride ?? Date.now(),
							outcome: 'incoming-rejected',
						});
						deps.onLog(
							'cue',
							`[CUE] Queue full for "${sessionName}" and durable admission prevents eviction, dropping incoming event`
						);
						return false;
					}
					deps.onQueueOverflow?.({
						sessionId,
						sessionName,
						subscriptionName: dropped.subscriptionName,
						queuedAt: dropped.queuedAt,
						outcome: 'oldest-evicted',
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
					autoRun,
					turnSettings,
					persistId,
					chainRootId,
					parentEventId,
				};
				queue.push(queuedEntry);

				// Persist AFTER the in-memory push so the row appears only for
				// entries that actually made it into the live queue. Safe
				// wrappers mean a persist failure cannot break the live queue.
				if (deps.queuePersistence && persistId) {
					const persisted = deps.queuePersistence.persist(sessionId, persistId, {
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
						autoRun,
						notify,
						turnSettings,
					});
					if (isDurableCueEvent(event) && persisted !== true) {
						queue.splice(queue.indexOf(queuedEntry), 1);
						deps.queuePersistence.remove(persistId);
						return false;
					}
				}

				deps.onLog(
					'cue',
					draining
						? `[CUE] Event deferred for "${sessionName}" (engine draining, ${queue.length} in queue)`
						: `[CUE] Event queued for "${sessionName}" (${queue.length}/${queueSize} in queue, ${currentCount}/${maxConcurrent} concurrent)`
				);
				if (isDurableCueEvent(event) && !deps.queuePersistence) {
					queue.splice(queue.indexOf(queuedEntry), 1);
					return false;
				}
				return true;
			}

			// Slot available - dispatch immediately
			let durablePersistId: string | undefined;
			if (isDurableCueEvent(event)) {
				if (!deps.queuePersistence) return false;
				durablePersistId = crypto.randomUUID();
				const persisted = deps.queuePersistence.persist(sessionId, durablePersistId, {
					event,
					subscriptionName,
					prompt,
					outputPrompt,
					cliOutput,
					action,
					command,
					chainDepth,
					queuedAt: queuedAtOverride ?? Date.now(),
					chainRootId,
					parentEventId,
					autoRun,
					notify,
					turnSettings,
				});
				if (persisted !== true || !authorizePluginCueEvent(event, sessionId, subscriptionName)) {
					deps.queuePersistence.remove(durablePersistId);
					return false;
				}
			}
			activeRunCount.set(sessionId, currentCount + 1);
			const execution = doExecuteCueRun(
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
				notify,
				autoRun,
				turnSettings
			);
			if (durablePersistId)
				void execution.then(
					() => deps.queuePersistence?.remove(durablePersistId!),
					() => deps.queuePersistence?.remove(durablePersistId!)
				);
			return true;
		},

		recordSkippedRun(skipped): CueRunResult {
			const runId = crypto.randomUUID();
			const endedAtMs = Date.now();
			const startedAtMs = Math.min(skipped.startedAt ?? endedAtMs, endedAtMs);
			const result: CueRunResult = {
				runId,
				sessionId: skipped.sessionId,
				sessionName: getSessionName(skipped.sessionId),
				subscriptionName: skipped.subscriptionName,
				pipelineName: skipped.pipelineName,
				event: skipped.event,
				status: skipped.status,
				stdout: '',
				// A refusal explains itself where a failed run would: the
				// activity row and History both read `stderr`.
				stderr: skipped.reason ?? '',
				exitCode: null,
				durationMs: endedAtMs - startedAtMs,
				startedAt: new Date(startedAtMs).toISOString(),
				endedAt: new Date(endedAtMs).toISOString(),
			};
			// Born finalized, like a stale queue drop: there is no `running`
			// phase to flip out of. No output columns are written, which is what
			// keeps a skipped event out of History (see
			// CUE_EVENT_WORTH_SHOWING_SQL).
			safeRecordCueEvent({
				id: runId,
				type: skipped.event.type,
				triggerName: skipped.event.triggerName,
				sessionId: skipped.sessionId,
				subscriptionName: skipped.subscriptionName,
				status: skipped.status,
				payload: JSON.stringify(skipped.event.payload),
				...buildLineageColumns({
					runId,
					chainRootId: skipped.chainRootId,
					parentEventId: skipped.parentEventId,
					pipelineName: skipped.pipelineName,
				}),
			});
			if (skipped.reason) {
				// Only a skip with a reason to show writes the completion
				// columns. A `gated` event passes none and keeps them NULL.
				safeUpdateCueEventStatus(runId, skipped.status, null, completionInfoFromResult(result));
			}
			return result;
		},

		stopRun(runId: string): boolean {
			// Phase-validated transition: only running → stopping is valid
			const prevPhase = transitionRun(runId, 'stopping');
			if (prevPhase === null) return false;

			const run = activeRuns.get(runId)!;
			if (draining) drainStoppedRuns.add(runId);

			// Signal the process to stop - kill the currently executing child process.
			// During output prompt phase, processRunId differs from the parent runId.
			deps.onStopCueRun?.(runId);
			if (run.processRunId && run.processRunId !== runId) {
				deps.onStopCueRun?.(run.processRunId);
			}
			// A launch with no process yet is cancelled here: it checks the
			// signal before spawning (see cue-launch-cancel.ts).
			cancelLaunch(runId, run);

			// Finalize the result for immediate UI feedback
			run.result.status = 'stopped';
			run.result.endedAt = new Date().toISOString();
			run.result.durationMs = Date.now() - new Date(run.result.startedAt).getTime();

			// Remove from activeRuns - the finally block in doExecuteCueRun
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
				...(run.result.pipelineName ? { pipelineId: run.result.pipelineName } : {}),
			} satisfies CueLogPayload);
			notifyIfIdle();
			return true;
		},

		stopAll(): void {
			// Clear the queue FIRST, then stop active runs. stopRun calls
			// drainQueue internally when it releases a concurrency slot; if
			// the queue still has entries at that point, the drain dispatches
			// a fresh run that escapes this stopAll invocation. Clearing the
			// queue up-front makes every nested drain a no-op, so after this
			// function returns there are zero active runs AND zero queued
			// events - the contract callers (engine shutdown / Cue toggle
			// off) actually need.
			const detachedQueues = [...eventQueue];
			eventQueue.clear();
			deps.queuePersistence?.clearAll();
			for (const [sessionId, queue] of detachedQueues) {
				const durable = queue.filter((entry) => entry.persistId && isDurableCueEvent(entry.event));
				if (durable.length) deps.onDurableRowsDetached?.(sessionId, durable);
			}
			for (const runId of [...activeRuns.keys()]) {
				this.stopRun(runId);
			}
			// Each stopRun above releases its own key; clear defensively so a
			// torn-down engine never leaves a stale guard that would wrongly
			// block the first run after restart.
			activeRootKeys.clear();
		},

		setDraining(on: boolean): void {
			draining = on;
		},

		whenIdle(): Promise<void> {
			if (activeRuns.size === 0) return Promise.resolve();
			return new Promise<void>((resolve) => idleWaiters.push(resolve));
		},

		getUnsettledStoppedRunCount(): number {
			return unsettledStoppedRuns.size;
		},

		persistQueueForRestart(drainedAt: number): number {
			const persistence = deps.queuePersistence;
			if (!persistence) return 0;
			let count = 0;
			for (const [sessionId, queue] of eventQueue) {
				for (const entry of queue) {
					if (!entry.persistId) entry.persistId = crypto.randomUUID();
					persistence.persist(sessionId, entry.persistId, {
						event: entry.event,
						subscriptionName: entry.subscriptionName,
						prompt: entry.prompt,
						outputPrompt: entry.outputPrompt,
						cliOutput: entry.cliOutput,
						action: entry.action,
						command: entry.command,
						chainDepth: entry.chainDepth,
						queuedAt: entry.queuedAt,
						chainRootId: entry.chainRootId,
						parentEventId: entry.parentEventId,
						drainedAt,
					});
					count++;
				}
			}
			return count;
		},

		discardInMemory(): void {
			for (const [runId, run] of activeRuns) {
				cancelLaunch(runId, run);
				deps.onAllowSleep?.(`cue:run:${runId}`);
			}
			activeRuns.clear();
			activeRunCount.clear();
			activeRootKeys.clear();
			eventQueue.clear();
			notifyIfIdle();
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
			const queue = eventQueue.get(sessionId);
			if (!queue) return;
			const keep = (e: QueuedEvent) => preserveStartup && e.event.type === 'app.startup';
			const kept = queue.filter(keep);
			const detached: QueuedEvent[] = [];
			// Ordinary drops are terminal. Acknowledged durable rows remain on
			// disk and must re-enter the engine's deferred-owner restore set.
			for (const entry of queue) {
				if (keep(entry) || !entry.persistId) continue;
				if (isDurableCueEvent(entry.event)) detached.push(entry);
				else deps.queuePersistence?.remove(entry.persistId);
			}
			if (kept.length === 0) {
				eventQueue.delete(sessionId);
			} else {
				eventQueue.set(sessionId, kept);
			}
			if (detached.length) deps.onDurableRowsDetached?.(sessionId, detached);
		},

		retainQueue(
			sessionId: string,
			classify: (entry: QueuedEvent) => CueQueueDropReason | null
		): number {
			const queue = eventQueue.get(sessionId);
			if (!queue) return 0;
			const kept: QueuedEvent[] = [];
			const droppedByReason = new Map<CueQueueDropReason, number>();
			for (const entry of queue) {
				const reason = classify(entry);
				if (reason === null) {
					kept.push(entry);
					continue;
				}
				if (entry.persistId) deps.queuePersistence?.remove(entry.persistId);
				recordDroppedEntry(sessionId, entry, { reason });
				droppedByReason.set(reason, (droppedByReason.get(reason) ?? 0) + 1);
			}
			if (kept.length === 0) {
				eventQueue.delete(sessionId);
			} else {
				eventQueue.set(sessionId, kept);
			}

			const sessionName = getSessionName(sessionId);
			let dropped = 0;
			for (const [reason, count] of droppedByReason) {
				dropped += count;
				const why =
					reason === 'superseded'
						? 'a heartbeat whose timing changed fires on load instead'
						: reason === 'session-missing'
							? 'the agent no longer exists'
							: 'their subscription was removed, renamed or switched off';
				deps.onLog(
					reason === 'superseded' ? 'cue' : 'warn',
					`[CUE] Dropped ${count} queued event(s) for "${sessionName}" on a cue.yaml reload: ${why} - recorded in the activity log`,
					{ type: 'queueDropped', sessionId, count, reason } satisfies CueLogPayload
				);
			}
			// Refresh registers sources synchronously after settling this queue.
			// Recheck the current map/readiness in the next microtask, never a
			// captured entry; stop/reset/deletion can empty it before then.
			if (kept.some((entry) => isDurableCueEvent(entry.event)))
				queueMicrotask(() => {
					if (deps.canDrainSession?.(sessionId) !== false) drainQueue(sessionId);
				});
			return dropped;
		},

		reset(): void {
			// A run forgotten here must not start a process afterwards either.
			for (const [runId, run] of activeRuns) {
				cancelLaunch(runId, run);
				deps.onAllowSleep?.(`cue:run:${runId}`);
			}
			activeRuns.clear();
			activeRunCount.clear();
			activeRootKeys.clear();
			eventQueue.clear();
			// Reset clears ordinary persisted work; acknowledged plugin rows survive for restore.
			deps.queuePersistence?.clearAll();
			notifyIfIdle();
		},
	};
}
