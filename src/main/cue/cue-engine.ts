/**
 * Cue Engine Core — thin façade for Maestro Cue event-driven automation.
 *
 * Coordinates a small set of single-responsibility services. The engine itself
 * owns no Cue runtime state — every mutable thing (sessions, dedup keys, run
 * lifecycle, fan-in, etc.) lives behind a service interface.
 *
 * Service map:
 * - CueSessionRegistry      — sole owner of per-session state and dedup keys
 * - CueSessionRuntimeService — session lifecycle (init/refresh/teardown)
 * - CueRunManager           — concurrency, queues, run execution
 * - CueDispatchService      — fan-out routing
 * - CueCompletionService    — agent.completed routing (single + fan-in)
 * - CueFanInTracker         — multi-source agent.completed state machine
 * - CueQueryService         — read-only projections (status, graph, settings)
 * - CueRecoveryService      — DB init, sleep detection, missed-event recovery
 * - CueHeartbeat            — periodic heartbeat write
 * - CueActivityLog          — recent run history
 *
 * Supports agent completion chains:
 * - Fan-out: a subscription fires its prompt against multiple target sessions
 * - Fan-in: a subscription waits for multiple source sessions to complete before firing
 * - Session bridging: completion events from user sessions (non-Cue) trigger Cue subscriptions
 */

import type { MainLogLevel } from '../../shared/logger-types';
import type { CueLogPayload } from '../../shared/cue-log-types';
import type { SessionInfo } from '../../shared/types';
import {
	createCueEvent,
	type AgentCompletionData,
	type CueCommand,
	type CueConfig,
	type CueRunResult,
	type CueEvent,
	type CueSubscription,
} from './cue-types';
import { createCueActivityLog } from './cue-activity-log';
import type { CueActivityLog } from './cue-activity-log';
import { createCueHeartbeat } from './cue-heartbeat';
import type { CueHeartbeat } from './cue-heartbeat';
import { createCueFanInTracker } from './cue-fan-in-tracker';
import type { CueFanInTracker } from './cue-fan-in-tracker';
import { createCueRunManager } from './cue-run-manager';
import type { CueRunManager } from './cue-run-manager';
import { createCueDispatchService } from './cue-dispatch-service';
import type { CueDispatchService } from './cue-dispatch-service';
import { createCueCompletionService } from './cue-completion-service';
import type { CueCompletionService } from './cue-completion-service';
import { createCueQueryService } from './cue-query-service';
import type { CueQueryService } from './cue-query-service';
import { createCueSessionRuntimeService } from './cue-session-runtime-service';
import type { CueSessionRuntimeService, SessionInitReason } from './cue-session-runtime-service';
import { createCueSessionRegistry, type CueSessionRegistry } from './cue-session-registry';
import type { SessionState } from './cue-session-state';
import { createCueRecoveryService, type CueRecoveryService } from './cue-recovery-service';
import { createCueCleanupService, type CueCleanupService } from './cue-cleanup-service';
import { createCueMetrics, type CueMetrics, type CueMetricsCollector } from './cue-metrics';
import { createCueQueuePersistence, type CueQueuePersistence } from './cue-queue-persistence';
import { loadCueConfig } from './cue-yaml-loader';

const MAX_CHAIN_DEPTH = 10;

/**
 * Stable identity key grouping subs that represent parallel branches of the
 * same visual trigger. Used by manual-trigger dispatch to fire every sibling
 * sub a scheduled tick would fire — e.g. `Schedule → [Cmd1, Cmd2]` serializes
 * as two subs sharing event config but targeting different commands; both
 * must fire together when the user clicks Play.
 *
 * Mirrors `triggerGroupKey` in `yamlToPipeline.ts` so the runtime's notion of
 * "same trigger" matches the editor's collapse rule on load. Any divergence
 * in event-specific config (different schedule_times, different watch glob,
 * etc.) yields a distinct key and therefore a distinct group, preserving
 * author intent when they configured truly independent triggers.
 */
function triggerGroupKey(sub: CueSubscription): string {
	// Sort filter keys so two subs whose filter objects differ only in key
	// insertion order (hand-written YAML or library-reordered round-trips)
	// still hash to the same group.
	const filter = sub.filter
		? Object.keys(sub.filter)
				.sort()
				.reduce<Record<string, unknown>>((acc, k) => {
					acc[k] = (sub.filter as Record<string, unknown>)[k];
					return acc;
				}, {})
		: null;
	return JSON.stringify({
		event: sub.event,
		schedule_times: sub.schedule_times ?? null,
		schedule_days: sub.schedule_days ?? null,
		interval_minutes: sub.interval_minutes ?? null,
		watch: sub.watch ?? null,
		repo: sub.repo ?? null,
		poll_minutes: sub.poll_minutes ?? null,
		gh_state: sub.gh_state ?? null,
		label: sub.label ?? null,
		filter,
	});
}

/** Dependencies injected into the CueEngine */
export interface CueEngineDeps {
	getSessions: () => SessionInfo[];
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
	/** Called to prevent system sleep (e.g., when Cue has active scheduled subscriptions or runs) */
	onPreventSleep?: (reason: string) => void;
	/** Called to allow system sleep (e.g., when Cue scheduled subscriptions or runs end) */
	onAllowSleep?: (reason: string) => void;
}

export class CueEngine {
	private enabled = false;
	/** Set to 'system-boot' while the engine is running after a system-boot or
	 * user-toggle-on start. Drives refreshSession() to fire app.startup for
	 * sessions that arrive after start() (the common case at boot). */
	private startReason: 'system-boot' | null = null;
	private activityLog: CueActivityLog = createCueActivityLog();
	private registry: CueSessionRegistry;
	private fanInTracker!: CueFanInTracker;
	private runManager!: CueRunManager;
	private heartbeat: CueHeartbeat;
	private dispatchService: CueDispatchService;
	private completionService: CueCompletionService;
	private queryService: CueQueryService;
	private sessionRuntimeService: CueSessionRuntimeService;
	private recoveryService: CueRecoveryService;
	private cleanupService: CueCleanupService;
	private metrics: CueMetricsCollector = createCueMetrics();
	private queuePersistence: CueQueuePersistence;
	private deps: CueEngineDeps;

	/**
	 * Intercept all onLog calls to route structured payloads into metrics.
	 * Subsystems stay decoupled from the metrics module — they emit the same
	 * typed CueLogPayload they already do, and the engine translates.
	 *
	 * Arrow-function field so `this` is bound when we pass it into subsystem deps.
	 */
	private meteredOnLog: CueEngineDeps['onLog'] = (level, message, data) => {
		this.recordMetricFromPayload(data);
		// Preserve original arity: omit `data` when it's undefined so vi.fn() mocks
		// that assert `toHaveBeenCalledWith(level, msg)` (2 args) still match —
		// this path is hot for every warn/info line the engine emits.
		if (data === undefined) {
			this.deps.onLog(level, message);
		} else {
			this.deps.onLog(level, message, data);
		}
	};

	constructor(deps: CueEngineDeps) {
		this.deps = deps;
		this.registry = createCueSessionRegistry();
		const meteredOnLog = this.meteredOnLog;

		// Phase 12A — queue persistence façade. Wired up-front so the run
		// manager receives it by construction. Uses the in-process registry +
		// settings for staleness / session-membership checks.
		this.queuePersistence = createCueQueuePersistence({
			onLog: meteredOnLog,
			getSessionTimeoutMs: (sessionId) => {
				const state = this.registry.get(sessionId);
				return (state?.config.settings?.timeout_minutes ?? 30) * 60 * 1000;
			},
			knownSessionIds: () => new Set(deps.getSessions().map((s) => s.id)),
		});

		this.runManager = createCueRunManager({
			getSessions: deps.getSessions,
			getSessionSettings: (sessionId) => this.registry.get(sessionId)?.config.settings,
			onCueRun: deps.onCueRun,
			onStopCueRun: deps.onStopCueRun,
			onLog: meteredOnLog,
			onRunCompleted: (sessionId, result, subscriptionName, chainDepth) => {
				this.pushActivityLog(result);
				// Carry forwarded outputs from the triggering event through to the
				// completion notification so downstream agents can access them via
				// per-source template variables ({{CUE_FORWARDED_<NAME>}}).
				const forwarded = result.event.payload.forwardedOutputs as
					| Record<string, string>
					| undefined;
				this.notifyAgentCompleted(sessionId, {
					sessionName: result.sessionName,
					status: result.status,
					exitCode: result.exitCode,
					durationMs: result.durationMs,
					stdout: result.stdout,
					triggeredBy: subscriptionName,
					chainDepth: (chainDepth ?? 0) + 1,
					forwardedOutputs: forwarded,
				});
			},
			onRunStopped: (result) => {
				this.pushActivityLog(result);
			},
			onPreventSleep: deps.onPreventSleep,
			onAllowSleep: deps.onAllowSleep,
			// Phase 12B: surface queue overflow through the same typed-log channel
			// so the renderer's activity-update listener can toast the user.
			onQueueOverflow: (payload) => {
				meteredOnLog('warn', `[CUE] Queue overflow in "${payload.sessionName}"`, {
					type: 'queueOverflow',
					...payload,
				} satisfies CueLogPayload);
			},
			// Phase 12A: queue rows survive app crash / quit.
			queuePersistence: this.queuePersistence,
		});
		this.fanInTracker = createCueFanInTracker({
			onLog: meteredOnLog,
			getSessions: deps.getSessions,
			dispatchSubscription: (ownerSessionId, sub, event, sourceSessionName, chainDepth) => {
				return this.dispatchService.dispatchSubscription(
					ownerSessionId,
					sub,
					event,
					sourceSessionName,
					chainDepth
				);
			},
		});
		this.dispatchService = createCueDispatchService({
			getSessions: deps.getSessions,
			executeRun: (
				sessionId,
				prompt,
				event,
				subscriptionName,
				outputPrompt,
				chainDepth,
				cliOutput,
				action,
				command
			) => {
				this.runManager.execute(
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
			onLog: meteredOnLog,
		});
		this.sessionRuntimeService = createCueSessionRuntimeService({
			enabled: () => this.enabled,
			getSessions: deps.getSessions,
			onRefreshRequested: (sessionId, projectRoot) => {
				this.refreshSession(sessionId, projectRoot);
			},
			onLog: meteredOnLog,
			onPreventSleep: deps.onPreventSleep,
			onAllowSleep: deps.onAllowSleep,
			registry: this.registry,
			dispatchSubscription: (ownerSessionId, sub, event, sourceSessionName, chainDepth) => {
				return this.dispatchService.dispatchSubscription(
					ownerSessionId,
					sub,
					event,
					sourceSessionName,
					chainDepth
				);
			},
			clearQueue: (sessionId, preserveStartup) => {
				this.runManager.clearQueue(sessionId, preserveStartup);
			},
			clearFanInState: (sessionId) => {
				this.fanInTracker.clearForSession(sessionId);
			},
		});
		this.completionService = createCueCompletionService({
			enabled: () => this.enabled,
			getSessions: () =>
				deps.getSessions().map((session) => ({ id: session.id, name: session.name })),
			getSessionConfigs: () => {
				const views = new Map<string, { config: CueConfig; ownershipWarning?: string }>();
				for (const [sessionId, state] of this.registry.snapshot()) {
					views.set(sessionId, {
						config: state.config,
						ownershipWarning: state.ownershipWarning,
					});
				}
				return views;
			},
			fanInTracker: this.fanInTracker,
			onDispatch: (ownerSessionId, sub, event, sourceSessionName, chainDepth) => {
				this.dispatchService.dispatchSubscription(
					ownerSessionId,
					sub,
					event,
					sourceSessionName,
					chainDepth
				);
			},
			onLog: meteredOnLog,
			maxChainDepth: MAX_CHAIN_DEPTH,
		});
		this.queryService = createCueQueryService({
			enabled: () => this.enabled,
			getAllSessions: () =>
				deps.getSessions().map((session) => ({
					id: session.id,
					name: session.name,
					toolType: session.toolType,
					projectRoot: session.projectRoot,
				})),
			getSessionStates: () => this.registry.snapshot(),
			getActiveRunCount: (sessionId) => this.runManager.getActiveRunCount(sessionId),
			loadConfigForProjectRoot: loadCueConfig,
		});
		this.cleanupService = createCueCleanupService({
			fanInTracker: this.fanInTracker,
			registry: this.registry,
			getSessions: () => deps.getSessions().map((s) => ({ id: s.id })),
			getSessionTimeoutMs: (sessionId) => {
				const state = this.registry.get(sessionId);
				return (state?.config.settings?.timeout_minutes ?? 30) * 60 * 1000;
			},
			getCurrentMinute: () => {
				const now = new Date();
				return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
			},
			onLog: meteredOnLog,
		});
		this.heartbeat = createCueHeartbeat({
			onTick: () => this.cleanupService.onTick(),
			// Route heartbeat-failure notifications through the metered log
			// channel so the engine's recordMetricFromPayload bumps the
			// heartbeatFailures counter exactly once per failure run.
			onFailure: (payload) => {
				this.meteredOnLog('warn', '[CUE] Heartbeat write failing', payload);
			},
		});
		this.recoveryService = createCueRecoveryService({
			onLog: meteredOnLog,
			getSessions: () => {
				const result = new Map<string, { config: CueConfig; sessionName: string }>();
				const allSessions = deps.getSessions();
				for (const [sessionId, state] of this.registry.snapshot()) {
					const session = allSessions.find((s) => s.id === sessionId);
					result.set(sessionId, {
						config: state.config,
						sessionName: session?.name ?? sessionId,
					});
				}
				return result;
			},
			onDispatch: (sessionId, sub, event) => {
				this.dispatchService.dispatchSubscription(sessionId, sub, event, sessionId);
			},
		});
	}

	/**
	 * Enable the engine and scan all sessions for Cue configs.
	 *
	 * @param reason Why the engine is starting. Determines whether `app.startup`
	 *   subscriptions fire:
	 *   - `'system-boot'`: used at Electron launch (index.ts) AND when the user
	 *     enables Cue via the IPC handler (`cue:enable` calls
	 *     `requireEngine().start('system-boot')`). app.startup subscriptions fire
	 *     and are deduped per engine cycle (keys are cleared by stop()).
	 *   - `'user-toggle'` (default): direct engine.start() call without an explicit
	 *     reason (e.g. in tests or internal paths). app.startup does NOT fire —
	 *     only IPC-driven enables and Electron launch use 'system-boot'.
	 */
	start(reason: SessionInitReason = 'user-toggle'): void {
		if (this.enabled) return;

		const initResult = this.recoveryService.init();
		if (!initResult.ok) {
			return;
		}

		this.startReason = reason === 'system-boot' ? 'system-boot' : null;
		this.enabled = true;
		// Reset metrics so startedAt reflects THIS start, not the collector's
		// construction. Without this, startedAt is fixed at engine-instance
		// creation time, making "uptime" rate calcs wrong across stop/start
		// cycles within the same Electron process.
		this.metrics.reset();
		// Data payload triggers a renderer refresh via cue:activityUpdate,
		// clearing any stale queue counters left over from a prior stop.
		this.meteredOnLog('cue', '[CUE] Engine started', {
			type: 'engineStarted',
		} satisfies CueLogPayload);

		const sessions = this.deps.getSessions();
		for (const session of sessions) {
			this.sessionRuntimeService.initSession(session, { reason });
		}

		// Phase 12A — restore persisted queue entries AFTER sessions are
		// initialized (so registry.get(...) has their configs / timeout). Each
		// entry is re-executed through the normal path so the run manager
		// re-applies concurrency gating + re-persists with a new persist id.
		// The prior persistId is discarded via remove() inside the restore
		// helper's session-missing drop path (if applicable), or is discarded
		// implicitly on re-enqueue since we never reuse the old id.
		const restored = this.queuePersistence.restoreAll();
		for (const [sessionId, entries] of restored) {
			for (const entry of entries) {
				// Remove the persisted row immediately — runManager.execute will
				// re-persist with a fresh id when it re-queues (or dispatches
				// immediately if a slot is available).
				this.queuePersistence.remove(entry.persistId);
				// Pass the original queuedAt so drainQueue's staleness check
				// still reflects real user wait time, not the restart time.
				this.runManager.execute(
					sessionId,
					entry.prompt,
					entry.event,
					entry.subscriptionName,
					entry.outputPrompt,
					entry.chainDepth,
					entry.cliOutput,
					entry.action,
					entry.command,
					entry.queuedAt
				);
			}
		}

		// Detect sleep gap from previous heartbeat
		this.recoveryService.detectSleepAndReconcile();

		// Start heartbeat writer (30s interval)
		this.heartbeat.start();
	}

	/** Disable the engine, clearing all timers and watchers */
	stop(): void {
		if (!this.enabled) return;

		this.enabled = false;
		this.startReason = null;
		this.sessionRuntimeService.clearAll();
		// Clear startup dedup keys so that re-enabling Cue fires app.startup
		// subscriptions again for the new engine cycle.
		this.sessionRuntimeService.clearAllStartupKeys();

		this.runManager.reset();
		this.fanInTracker.reset();

		// Stop heartbeat and close database via the recovery service.
		this.heartbeat.stop();
		this.recoveryService.shutdown();
		this.metrics.reset();

		// Data payload triggers a renderer refresh via cue:activityUpdate so
		// the queue counters, active runs list, and indicators reflect the
		// cleared engine state instead of waiting for the next 10s poll.
		this.meteredOnLog('cue', '[CUE] Engine stopped', {
			type: 'engineStopped',
		} satisfies CueLogPayload);
	}

	/** Re-read the YAML for a specific session, tearing down old subscriptions */
	refreshSession(sessionId: string, projectRoot: string): void {
		// When the engine started with 'system-boot', sessions that arrive via
		// refreshSession (the typical path at boot, since getSessions() is empty
		// when start() fires) should still get their app.startup triggers.
		const reason = this.startReason ?? 'refresh';
		const result = this.sessionRuntimeService.refreshSession(sessionId, projectRoot, reason);
		if (result.reloaded && result.sessionName) {
			this.meteredOnLog(
				'cue',
				`[CUE] Config reloaded for "${result.sessionName}" (${result.activeCount ?? 0} subscriptions)`,
				{ type: 'configReloaded', sessionId } satisfies CueLogPayload
			);
		} else if (result.configRemoved && result.sessionName) {
			this.meteredOnLog('cue', `[CUE] Config removed for "${result.sessionName}"`, {
				type: 'configRemoved',
				sessionId,
			} satisfies CueLogPayload);
		}
	}

	/** Teardown all subscriptions for a session */
	removeSession(sessionId: string): void {
		this.sessionRuntimeService.removeSession(sessionId);
	}

	/** Returns status of all sessions with Cue configs */
	getStatus() {
		return this.queryService.getStatus();
	}

	/** Returns currently running Cue executions */
	getActiveRuns(): CueRunResult[] {
		return this.runManager.getActiveRuns();
	}

	/** Returns recent completed/failed runs */
	getActivityLog(limit?: number): CueRunResult[] {
		return this.activityLog.getAll(limit);
	}

	/** Stops a specific running execution */
	stopRun(runId: string): boolean {
		const result = this.runManager.stopRun(runId);
		return result;
	}

	/** Stops all running executions and clears all queues */
	stopAll(): void {
		this.runManager.stopAll();
	}

	/** Returns master enabled state */
	isEnabled(): boolean {
		return this.enabled;
	}

	/** Returns queue depth per session (for the Cue Modal) */
	getQueueStatus(): Map<string, number> {
		return this.runManager.getQueueStatus();
	}

	/** Returns the merged Cue settings from the first available session config */
	getSettings() {
		return this.queryService.getSettings();
	}

	/** Returns all sessions with their parsed subscriptions (for graph visualization) */
	getGraphData() {
		return this.queryService.getGraphData();
	}

	/**
	 * Phase 12D — returns fan-in subscriptions that have completed some sources
	 * but are stalled past 50% of their configured timeout. Empty array means
	 * healthy (or no active fan-in at all).
	 */
	getFanInHealth() {
		return this.fanInTracker.checkHealth({
			sessions: this.deps.getSessions(),
			lookupSubscription: (key: string) => {
				const colonIdx = key.indexOf(':');
				if (colonIdx === -1) return null;
				const ownerSessionId = key.slice(0, colonIdx);
				const subName = key.slice(colonIdx + 1);
				const state = this.registry.get(ownerSessionId);
				if (!state) return null;
				const sub = state.config.subscriptions?.find((s) => s.name === subName);
				if (!sub) return null;
				// Fan-in requires multiple sources; accept either the array or
				// single-string form of `source_session`. Combine with any ID
				// overrides present via `source_session_ids`. Single-source subs
				// don't qualify as fan-in and return null.
				const nameSources: string[] = Array.isArray(sub.source_session)
					? sub.source_session
					: sub.source_session
						? [sub.source_session]
						: [];
				const idSources: string[] = Array.isArray(sub.source_session_ids)
					? (sub.source_session_ids as string[])
					: typeof sub.source_session_ids === 'string'
						? [sub.source_session_ids as string]
						: [];
				const sources = [...nameSources, ...idSources];
				if (sources.length < 2) return null;
				return {
					sub,
					settings: state.config.settings ?? {},
					sources,
				};
			},
		});
	}

	/** Returns a snapshot of engine-level counters (runs, queue, fan-in, etc.). */
	getMetrics(): CueMetrics {
		return this.metrics.snapshot();
	}

	/** Testing/observability helper — expose the collector so subsystems can be
	 * handed a bound increment function without leaking the engine instance. */
	getMetricsCollector(): CueMetricsCollector {
		return this.metrics;
	}

	/**
	 * Translate structured onLog payloads into metric counter increments.
	 * Kept as a single chokepoint so subsystems stay fully decoupled from the
	 * metrics module — they emit typed CueLogPayload as normal; the engine
	 * observes and counts.
	 */
	private recordMetricFromPayload(data: unknown): void {
		if (!data || typeof data !== 'object') return;
		const payload = data as { type?: unknown };
		if (typeof payload.type !== 'string') return;
		const typed = payload as { type: string; status?: string; count?: number };

		switch (typed.type) {
			case 'runStarted':
				this.metrics.increment('runsStarted');
				break;
			case 'runFinished':
				if (typed.status === 'completed') this.metrics.increment('runsCompleted');
				else if (typed.status === 'failed') this.metrics.increment('runsFailed');
				else if (typed.status === 'timeout') this.metrics.increment('runsTimedOut');
				else if (typed.status === 'stopped') this.metrics.increment('runsStopped');
				break;
			case 'runStopped':
				this.metrics.increment('runsStopped');
				break;
			case 'queueOverflow':
				this.metrics.increment('eventsDropped');
				break;
			case 'queueRestored':
				this.metrics.increment('queueRestored', typed.count ?? 0);
				break;
			case 'queueDropped':
				this.metrics.increment('eventsDropped', typed.count ?? 0);
				break;
			case 'fanInTimeout':
				this.metrics.increment('fanInTimeouts');
				break;
			case 'fanInComplete':
				this.metrics.increment('fanInCompletions');
				break;
			case 'rateLimitBackoff':
				this.metrics.increment('rateLimitBackoffs');
				break;
			case 'githubPollError':
				this.metrics.increment('githubPollErrors');
				break;
			case 'heartbeatFailure':
				this.metrics.increment('heartbeatFailures');
				break;
			case 'configReloaded':
				this.metrics.increment('configReloads');
				break;
			case 'pathTraversalBlocked':
				this.metrics.increment('pathTraversalsBlocked');
				break;
		}
	}

	/**
	 * Manually trigger subscription(s) by name, bypassing event conditions.
	 *
	 * Resolution:
	 *   1. Exact `sub.name` match — the anchor.
	 *   2. If no exact match, treat `subscriptionName` as a `pipeline_name`
	 *      and use the first initial-trigger sub in that pipeline as the
	 *      anchor. This handles the pipeline-editor Play button case where
	 *      a freshly-rebuilt (not-yet-reloaded) trigger node carries only
	 *      `pipelineName` as its fire target — the serializer's per-branch
	 *      emission doesn't guarantee any sub is named exactly `pipelineName`
	 *      (command targets inherit their node's auto-generated name).
	 *
	 * Dispatch set:
	 *   - Initial-trigger anchor (event !== 'agent.completed') with a
	 *     known `pipeline_name` → fire every sibling sub that shares
	 *     `pipeline_name` + identical event config. A natural scheduled
	 *     tick arms each parallel branch sub independently and fires them
	 *     all simultaneously; manual trigger mirrors that so a fan-out to
	 *     [Cmd1, Cmd2] fires both commands in one click instead of one.
	 *   - Chain-sub anchor (agent.completed), OR legacy sub with no
	 *     `pipeline_name`, OR a `promptOverride` is present → anchor-only.
	 *     A prompt override is a targeted CLI feature; applying it to
	 *     unrelated siblings would surprise the caller.
	 *
	 * Returns true iff at least one dispatch actually queued a run. Returns
	 * false when no anchor was found OR every dispatch in the group was
	 * skipped (empty prompts, missing target sessions, etc.) so the UI can
	 * surface "didn't run" instead of letting a silent no-op look like
	 * success.
	 */
	triggerSubscription(
		subscriptionName: string,
		promptOverride?: string,
		sourceAgentId?: string
	): boolean {
		type OwnedSub = {
			ownerSessionId: string;
			state: SessionState;
			sub: CueSubscription;
		};

		// Collect every sub the current session scope owns. A sub is owned
		// by its `agent_id` session when set; unbound subs are owned by
		// whichever registry entry contains them (filter preserves
		// existing semantics).
		const ownedSubs: OwnedSub[] = [];
		for (const [sessionId, state] of this.registry.snapshot()) {
			for (const sub of state.config.subscriptions) {
				if (sub.agent_id && sub.agent_id !== sessionId) continue;
				ownedSubs.push({ ownerSessionId: sessionId, state, sub });
			}
		}

		// Anchor resolution: exact name, then `pipeline_name` fallback.
		let anchor = ownedSubs.find((x) => x.sub.name === subscriptionName);
		if (!anchor) {
			anchor = ownedSubs.find(
				(x) => x.sub.pipeline_name === subscriptionName && x.sub.event !== 'agent.completed'
			);
		}
		if (!anchor) return false;

		// Decide whether to fire the sibling group or just the anchor.
		// See method docstring for the rationale on each condition.
		const shouldFireGroup =
			anchor.sub.event !== 'agent.completed' && !!anchor.sub.pipeline_name && !promptOverride;

		let toDispatch: OwnedSub[];
		if (shouldFireGroup) {
			const anchorKey = triggerGroupKey(anchor.sub);
			toDispatch = ownedSubs.filter(
				(x) =>
					x.sub.pipeline_name === anchor!.sub.pipeline_name &&
					x.sub.event !== 'agent.completed' &&
					triggerGroupKey(x.sub) === anchorKey
			);
		} else {
			toDispatch = [anchor];
		}

		let totalDispatched = 0;
		for (const { ownerSessionId, state, sub } of toDispatch) {
			const event = createCueEvent(sub.event, sub.name, {
				manual: true,
				...(sourceAgentId ? { sourceAgentId } : {}),
				...(promptOverride ? { cliPrompt: promptOverride } : {}),
			});

			this.deps.onLog(
				'cue',
				`[CUE] "${sub.name}" manually triggered${promptOverride ? ' (with prompt override)' : ''}`
			);
			state.lastTriggered = event.timestamp;
			const dispatched = this.dispatchService.dispatchSubscription(
				ownerSessionId,
				sub,
				event,
				'manual',
				undefined,
				promptOverride
			);
			if (dispatched > 0) totalDispatched++;
		}
		return totalDispatched > 0;
	}

	/** Clears queued events for a session */
	clearQueue(sessionId: string, preserveStartup = false): void {
		this.runManager.clearQueue(sessionId, preserveStartup);
	}

	/**
	 * Check if any Cue subscriptions are listening for a given session's completion.
	 * Used to avoid emitting completion events for sessions nobody cares about.
	 */
	hasCompletionSubscribers(sessionId: string): boolean {
		return this.completionService.hasCompletionSubscribers(sessionId);
	}

	/** Notify the engine that an agent session has completed (for agent.completed triggers) */
	notifyAgentCompleted(sessionId: string, completionData?: AgentCompletionData): void {
		this.completionService.notifyAgentCompleted(sessionId, completionData);
	}

	/** Clear all fan-in state for a session (when Cue is disabled or session removed) */
	clearFanInState(sessionId: string): void {
		this.fanInTracker.clearForSession(sessionId);
	}

	private pushActivityLog(result: CueRunResult): void {
		this.activityLog.push(result);
	}
}
