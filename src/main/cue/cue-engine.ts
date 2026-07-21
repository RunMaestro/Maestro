/**
 * Cue Engine Core - thin façade for Maestro Cue event-driven automation.
 *
 * Coordinates a small set of single-responsibility services. The engine itself
 * owns no Cue runtime state - every mutable thing (sessions, dedup keys, run
 * lifecycle, fan-in, etc.) lives behind a service interface.
 *
 * Service map:
 * - CueSessionRegistry      - sole owner of per-session state and dedup keys
 * - CueSessionRuntimeService - session lifecycle (init/refresh/teardown)
 * - CueRunManager           - concurrency, queues, run execution
 * - CueDispatchService      - fan-out routing
 * - CueCompletionService    - agent.completed routing (single + fan-in)
 * - CueFanInTracker         - multi-source agent.completed state machine
 * - CueQueryService         - read-only projections (status, graph, settings)
 * - CueRecoveryService      - DB init, sleep detection, missed-event recovery
 * - CueHeartbeat            - periodic heartbeat write
 * - CueActivityLog          - recent run history
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
	type CueNotifyConfig,
	type CueEventType,
	type CueRunResult,
	type CueRunStatus,
	type CueEvent,
	type CueSubscription,
} from './cue-types';
import { getCueRunLiveOutput } from './cue-executor';
import { scanTaskFilesNow, buildTaskPendingPayload } from './cue-task-scanner';
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
import { countCueEvents, getRecentCueEvents, type CueEventRecord } from './cue-db';
import { loadCueConfigDetailed } from './cue-yaml-loader';
import { readCueConfigFile, writeCueConfigFile } from './config/cue-config-repository';
import { removeSubscriptionFromYaml, type SelfDestructResult } from './cue-self-destruct';
import * as yaml from 'js-yaml';
import { cueDebugLog } from '../../shared/cueDebug';
import { captureException } from '../utils/sentry';
import { recordRunCompleted as recordTelemetryRunCompleted } from './cue-telemetry';
import type { PluginEvent } from '../../shared/plugins/events';
import {
	parseCueSubscriptionId,
	pipelineKeyForSubscription,
} from '../../shared/cue/subscription-id';
import type { Board, BoardCard } from '../../shared/board/types';
import type { ProfileSpawnOverrides } from '../../shared/profiles/types';
import {
	BoardDispatcher,
	type CardAssignment,
	type CardSpawnRequest,
	type CardSpawnResult,
} from '../board/board-dispatcher';

const MAX_CHAIN_DEPTH = 10;

/**
 * Stable identity key grouping subs that represent parallel branches of the
 * same visual trigger. Used by manual-trigger dispatch to fire every sibling
 * sub a scheduled tick would fire - e.g. `Schedule → [Cmd1, Cmd2]` serializes
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
		notify?: CueNotifyConfig;
	}) => Promise<CueRunResult>;
	onStopCueRun?: (runId: string) => boolean;
	onLog: (level: MainLogLevel, message: string, data?: unknown) => void;
	/** Called to prevent system sleep (e.g., when Cue has active scheduled subscriptions or runs) */
	onPreventSleep?: (reason: string) => void;
	/** Called to allow system sleep (e.g., when Cue scheduled subscriptions or runs end) */
	onAllowSleep?: (reason: string) => void;
	/**
	 * Phase 01 - gate for `pipeline_id` / `chain_root_id` / `parent_event_id`
	 * writes on the `cue_events` table. Wired through to `CueRunManager`. The
	 * production wiring reads `encoreFeatures.usageStats` from the settings
	 * store; tests typically pass `() => true` or omit (defaults to off).
	 */
	getUsageStatsEnabled?: () => boolean;
	/**
	 * Optional metadata-only hook fired once per subscription dispatch with the
	 * source event TYPE only. Threaded to the dispatch service to surface
	 * `cue.fired` to subscribed plugins; never carries prompt text.
	 */
	onTriggerFired?: (eventType: string) => void;
	/** Optional metadata-only plugin event sink. Threaded to surface Cue run
	 * lifecycle (`cue.runStarted` / `cue.runFinished`) to subscribed plugins;
	 * carries ids/status only, never prompt text or output. */
	emitPluginEvent?: (event: PluginEvent) => void;
	/**
	 * Board dispatcher wiring (Board Phase 3). Optional: when absent the engine
	 * runs Cue exactly as before. When present, the engine drains each project's
	 * `.maestro/board.yaml` task DAG on the SAME tick loop that drives Cue (no
	 * second timer). All board side effects are injected here so the engine core
	 * stays free of board-storage / profile / spawn internals.
	 *
	 * The board dispatch pass is gated on BOTH the `maestroCue` and `board`
	 * Encore flags (Board requires Cue - see {@link CueEngineBoardDeps.getEncoreFeatures}).
	 */
	board?: CueEngineBoardDeps;
}

/** Injected side effects for the Board Phase 3 dispatch pass. */
export interface CueEngineBoardDeps {
	/**
	 * Read the current Encore flags fresh each tick (the existing on-demand
	 * idiom, no listener). The board pass runs only when BOTH `maestroCue` and
	 * `board` are on, so toggling either at runtime takes effect immediately.
	 */
	getEncoreFeatures: () => { maestroCue?: boolean; board?: boolean };
	/** Unique project roots to scan for a `.maestro/board.yaml`. */
	getProjectRoots: () => string[];
	/** Load all boards for a project root. */
	listBoards: (projectRoot: string) => Board[];
	/** Persist one mutated board back to its project's board.yaml. */
	saveBoard: (projectRoot: string, board: Board) => void;
	/**
	 * Resolve a card's assignee profile into spawn overrides, or `null` when it
	 * can't be resolved (missing profile / base agent). Uses Phase 1
	 * `resolveProfileSpawnOverrides`.
	 */
	resolveOverrides: (projectRoot: string, card: BoardCard) => ProfileSpawnOverrides | null;
	/**
	 * Worker-pool assignment (Board Phase 6). When provided, cards resolve to a
	 * FREE opt-in worker in the project pool instead of a single pinned agent.
	 * Takes precedence over {@link resolveOverrides}. See {@link CardAssignment}.
	 */
	assign?: (
		projectRoot: string,
		card: BoardCard,
		busyAgentIds: ReadonlySet<string>
	) => CardAssignment;
	/** Spawn a claimed card's assignee to completion via the existing spawn path. */
	spawnCard: (projectRoot: string, request: CardSpawnRequest) => Promise<CardSpawnResult>;
	/**
	 * OPTIONAL auto-decompose (Board Phase 5), OFF by default. When wired AND the
	 * board's own `autoDecompose` flag is `true`, run one decomposition pass for a
	 * board (fan triage cards into child cards, capped per tick) and return how
	 * many triage cards were expanded. Absent => the step is skipped and triage
	 * cards wait for manual promotion.
	 */
	decompose?: (projectRoot: string, board: Board) => Promise<number>;
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
	 * One {@link BoardDispatcher} per board, keyed by `${projectRoot}::${boardId}`.
	 * Created lazily on first sighting so each board keeps its own in-flight set
	 * across ticks (the stale-reclaim guard). Empty when board deps aren't wired.
	 */
	private boardDispatchers: Map<string, BoardDispatcher> = new Map();
	/**
	 * Board keys (`${projectRoot}::${boardId}`) with an auto-decompose pass in
	 * flight. The decompose LLM call is async and fire-and-forget on the tick, so
	 * this guard prevents a slow pass from being re-launched (and a triage card
	 * double-expanded) by the next tick before it persists. Only used when the
	 * optional `decompose` dep is wired.
	 */
	private boardDecomposeInFlight: Set<string> = new Set();
	/**
	 * Per-`projectRoot` chain of pending YAML mutations. `setSubscriptionEnabled`
	 * does a read → mutate → write cycle that is not atomic on the filesystem;
	 * two concurrent toggles (e.g. rapid web-UI clicks, or a toggle racing the
	 * pipeline editor's save) would otherwise silently overwrite each other.
	 * Each call appends to the project's pending chain, so the writes serialise
	 * per file even under concurrent invocation. The map entry is dropped when
	 * the chain settles to keep this from growing unbounded across the lifetime
	 * of the engine.
	 */
	private yamlWriteChains: Map<string, Promise<unknown>> = new Map();

	/**
	 * Intercept all onLog calls to route structured payloads into metrics.
	 * Subsystems stay decoupled from the metrics module - they emit the same
	 * typed CueLogPayload they already do, and the engine translates.
	 *
	 * Arrow-function field so `this` is bound when we pass it into subsystem deps.
	 */
	private meteredOnLog: CueEngineDeps['onLog'] = (level, message, data) => {
		this.recordMetricFromPayload(data);
		// Preserve original arity: omit `data` when it's undefined so vi.fn() mocks
		// that assert `toHaveBeenCalledWith(level, msg)` (2 args) still match -
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

		// Phase 12A - queue persistence façade. Wired up-front so the run
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
			onRunStarted: (info) =>
				this.safeEmitPluginEvent({
					topic: 'cue.runStarted',
					at: new Date().toISOString(),
					payload: info,
				}),
			onRunCompleted: (sessionId, result, subscriptionName, chainDepth, chainRootId) => {
				this.pushActivityLog(result);
				this.safeEmitPluginEvent({
					topic: 'cue.runFinished',
					at: new Date().toISOString(),
					payload: {
						runId: result.runId,
						sessionId: result.sessionId,
						subscriptionName: result.subscriptionName,
						status: result.status,
						pipelineName: result.pipelineName,
						durationMs: result.durationMs,
					},
				});
				// `time.once` subscriptions are one-shot: rewrite cue.yaml to drop
				// the sub on terminal status. `stopped` (manual abort) routes
				// through `onRunStopped` instead and never self-destructs - the
				// user explicitly cancelled and may want to reschedule. The YAML
				// watcher reloads the config naturally after the rewrite.
				this.maybeSelfDestructOnce(sessionId, result, subscriptionName);
				// Telemetry: emit `run_completed` once per natural completion.
				// task_kind is derived here rather than inside the run manager
				// so the engine remains the sole authority on telemetry shape.
				// `agent.completed` events came from chain propagation (handoff
				// between agents). Subscriptions with `action: command` represent
				// a command node firing. Everything else is a trigger-driven run.
				const taskKind: 'agent_handoff' | 'command_node' | 'trigger_action' =
					result.event.type === 'agent.completed'
						? 'agent_handoff'
						: result.event.payload?.actionKind === 'command'
							? 'command_node'
							: 'trigger_action';
				recordTelemetryRunCompleted({
					subscriptionName,
					pipelineName: result.pipelineName,
					taskKind,
					chainRootId: chainRootId ?? null,
					parentRunId: (result.event.payload?.parentRunId as string | undefined) ?? null,
					durationMs: result.durationMs,
					status: result.status,
				});
				// Conductor level credit: only autonomous AI time advances the
				// podium (badge progression + leaderboard, which read the same
				// cumulativeTimeMs, so there is no drift). Command nodes are
				// deterministic shell steps, not agent reasoning, so they never
				// credit. Each run is floored to whole minutes: a sub-minute agent
				// run yields 0, matching Auto Run's minute-granularity accrual and
				// keeping trivial/quick automations off the podium.
				if (taskKind !== 'command_node' && result.status === 'completed') {
					const creditMs = Math.floor(result.durationMs / 60000) * 60000;
					if (creditMs > 0) {
						this.meteredOnLog('debug', '[CUE] Conductor time credit', {
							type: 'conductorTimeCredit',
							creditMs,
						});
					}
				}
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
					// Phase 01 - propagate chain lineage so the completion
					// service can stamp it onto the next dispatched run's
					// `cue_events` row.
					parentRunId: result.runId,
					chainRootId,
				});
			},
			onRunStopped: (result) => {
				this.pushActivityLog(result);
				this.safeEmitPluginEvent({
					topic: 'cue.runFinished',
					at: new Date().toISOString(),
					payload: {
						runId: result.runId,
						sessionId: result.sessionId,
						subscriptionName: result.subscriptionName,
						status: result.status,
						pipelineName: result.pipelineName,
						durationMs: result.durationMs,
					},
				});
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
			// Phase 01: gate cue_events stats lineage writes on the Encore flag.
			getUsageStatsEnabled: deps.getUsageStatsEnabled,
		});
		this.fanInTracker = createCueFanInTracker({
			onLog: meteredOnLog,
			getSessions: deps.getSessions,
			dispatchSubscription: (
				ownerSessionId,
				sub,
				event,
				sourceSessionName,
				chainDepth,
				promptOverride,
				chainRootId,
				parentEventId
			) => {
				return this.dispatchService.dispatchSubscription(
					ownerSessionId,
					sub,
					event,
					sourceSessionName,
					chainDepth,
					promptOverride,
					chainRootId,
					parentEventId
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
				pipelineName,
				outputPrompt,
				chainDepth,
				cliOutput,
				action,
				command,
				chainRootId,
				parentEventId,
				notify
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
					command,
					undefined, // queuedAtOverride - fresh dispatch, not a restore
					pipelineName,
					chainRootId,
					parentEventId,
					notify
				);
			},
			onLog: meteredOnLog,
			onTriggerFired: deps.onTriggerFired,
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
			// Route trigger-source self-destructs (missed-grace / filtered) through
			// the engine's per-root write chain so they serialise against toggles
			// and run-completion self-destructs on the same cue.yaml.
			selfDestruct: (projectRoot, subscriptionName) =>
				this.selfDestructSubscription(projectRoot, subscriptionName),
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
			onDispatch: (
				ownerSessionId,
				sub,
				event,
				sourceSessionName,
				chainDepth,
				chainRootId,
				parentEventId
			) => {
				this.dispatchService.dispatchSubscription(
					ownerSessionId,
					sub,
					event,
					sourceSessionName,
					chainDepth,
					undefined, // no prompt override on chained completions
					chainRootId,
					parentEventId
				);
			},
			onLog: meteredOnLog,
			maxChainDepth: MAX_CHAIN_DEPTH,
		});
		this.queryService = createCueQueryService({
			getAllSessions: () =>
				deps.getSessions().map((session) => ({
					id: session.id,
					name: session.name,
					toolType: session.toolType,
					projectRoot: session.projectRoot,
				})),
			getSessionStates: () => this.registry.snapshot(),
			getActiveRunCount: (sessionId) => this.runManager.getActiveRunCount(sessionId),
			// Use the partitioned/detailed loader so an inactive session's
			// dashboard view matches what the runtime will see when the engine
			// initializes that session. The legacy `loadCueConfig` skips
			// validation entirely, so the editor would render subscriptions
			// that the runtime later silently drops via `loadCueConfigDetailed`
			// - the user sees the sub in the editor, then activates Cue, and
			// it vanishes. Same loader on both paths keeps the views in sync.
			loadConfigForProjectRoot: (projectRoot) => {
				const result = loadCueConfigDetailed(projectRoot);
				return result.ok ? result.config : null;
			},
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
			onTick: () => {
				this.cleanupService.onTick();
				// Board Phase 3: drain each project's task DAG on the SAME tick that
				// drives Cue cleanup - no second timer. Gated on both Encore flags
				// inside the pass; a throw here must never kill the heartbeat.
				this.boardDispatchTick();
			},
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
	 *     reason (e.g. in tests or internal paths). app.startup does NOT fire -
	 *     only IPC-driven enables and Electron launch use 'system-boot'.
	 */
	start(reason: SessionInitReason = 'user-toggle'): void {
		if (this.enabled) return;

		const initResult = this.recoveryService.init();
		if (!initResult.ok) {
			return;
		}

		// Rehydrate the activity log from sqlite so the Cue Modal shows recent
		// runs after an app restart instead of starting blank. Must run after
		// recoveryService.init() (which opens the DB and prunes 7-day-old rows)
		// and before live runs start pushing to the in-memory log.
		this.hydrateActivityLogFromDb();

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

		// Phase 12A - restore persisted queue entries AFTER sessions are
		// initialized (so registry.get(...) has their configs / timeout). Each
		// entry is re-executed through the normal path so the run manager
		// re-applies concurrency gating + re-persists with a new persist id.
		// The prior persistId is discarded via remove() inside the restore
		// helper's session-missing drop path (if applicable), or is discarded
		// implicitly on re-enqueue since we never reuse the old id.
		const restored = this.queuePersistence.restoreAll();
		for (const [sessionId, entries] of restored) {
			for (const entry of entries) {
				// Remove the persisted row immediately - runManager.execute will
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
					entry.queuedAt,
					// Persisted queue rows don't carry pipelineName (no schema
					// column for it). The summary builder will fall back to
					// stripping the `-chain-N` suffix off subscriptionName, so
					// restored runs degrade gracefully to the legacy label.
					undefined,
					// Phase 01 - chain lineage round-tripped through the
					// queue table so resumed runs stay attached to their
					// chain root in stats. Roots and rows persisted before
					// usageStats was enabled come back as undefined.
					entry.chainRootId,
					entry.parentEventId
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
		// Drop board dispatchers so a re-enable rebuilds them with fresh in-flight
		// sets (any card left `running` is reclaimed as stale on the next tick).
		this.boardDispatchers.clear();

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
		cueDebugLog('engine:refreshSession:start', { sessionId, projectRoot, reason });
		const result = this.sessionRuntimeService.refreshSession(sessionId, projectRoot, reason);
		cueDebugLog('engine:refreshSession:result', {
			sessionId,
			projectRoot,
			sessionName: result.sessionName,
			reloaded: result.reloaded,
			configRemoved: result.configRemoved,
			activeCount: result.activeCount,
			kind: 'kind' in result ? (result as { kind?: string }).kind : undefined,
		});
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

	/**
	 * Snapshot the live stdout/stderr buffers for an in-flight Cue run. Returns
	 * null when the runId isn't currently active. Used by the dashboard's
	 * "expand to see live logs" UX so the user can introspect a long-running
	 * agent without leaving the modal.
	 */
	getRunLiveOutput(runId: string): { stdout: string; stderr: string } | null {
		return getCueRunLiveOutput(runId);
	}

	/** Returns recent completed/failed runs */
	getActivityLog(limit?: number): CueRunResult[] {
		return this.activityLog.getAll(limit);
	}

	/**
	 * Flip the `enabled` flag on a single subscription in its owning session's
	 * cue.yaml, then refresh that session so the trigger sources reattach.
	 *
	 * `subscriptionId` follows the `${sessionId}::${pipeline}::${name}` shape
	 * the web server's `setGetCueSubscriptionsCallback` emits via
	 * `composeCueSubscriptionId` - same identity we surface to remote callers
	 * (CLI / web UI). The pipeline discriminator is what guarantees we don't
	 * silently mutate the wrong row when two pipelines in the same session
	 * each define a sub with the same name. Anything that can't be parsed
	 * back to a live session + matching subscription returns `false` so the
	 * caller can surface a "no such subscription" failure to the user instead
	 * of silently doing nothing.
	 *
	 * Concurrency: the read-modify-write cycle is serialised per `projectRoot`
	 * via `yamlWriteChains`. Two concurrent toggles for subs in the same
	 * project (rapid web-UI clicks, a toggle racing a pipeline-editor save)
	 * would otherwise let whichever write lands second silently discard the
	 * first one's `enabled` flip. The chain also re-reads the YAML immediately
	 * before mutating so a writer that intervened *outside* the chain (any
	 * non-engine writer of cue.yaml) is observed and rolled into the next
	 * write rather than overwritten with stale state.
	 *
	 * Comments and field ordering in the raw YAML are NOT preserved - the
	 * implementation parses → mutates → serialises. That matches the existing
	 * pipeline-editor write path (which also re-emits the YAML from a
	 * structured graph), and is acceptable for a single-field flip from a
	 * remote toggle.
	 */
	async setSubscriptionEnabled(subscriptionId: string, enabled: boolean): Promise<boolean> {
		const parsedId = parseCueSubscriptionId(subscriptionId);
		if (!parsedId) return false;
		const { sessionId, pipeline: targetPipeline, name: subName } = parsedId;

		const session = this.deps.getSessions().find((s) => s.id === sessionId);
		if (!session) return false;
		const projectRoot = session.projectRoot;
		if (!projectRoot) return false;

		// Serialise per projectRoot so concurrent toggles and `time.once`
		// self-destructs can't trample each other's read-modify-write cycle.
		return await this.enqueueYamlWrite(projectRoot, () =>
			this.runSubscriptionEnabledWrite(sessionId, projectRoot, targetPipeline, subName, enabled)
		);
	}

	/**
	 * Serialise a cue.yaml mutation for `projectRoot` against the per-root write
	 * chain. Both `setSubscriptionEnabled` (remote toggle) and `time.once`
	 * self-destruct route through here, so a self-destruct can't race a toggle
	 * (or another self-destruct) on the same file and silently clobber the other
	 * write. A rejected earlier job does not poison later ones - each runs
	 * regardless of how the previous settled and reports its own pass/fail.
	 */
	private async enqueueYamlWrite<T>(projectRoot: string, work: () => T | Promise<T>): Promise<T> {
		const prev = this.yamlWriteChains.get(projectRoot) ?? Promise.resolve();
		const next = prev.then(work, work);
		this.yamlWriteChains.set(projectRoot, next);
		try {
			return await next;
		} finally {
			// Drop the entry once the chain has settled to ours - guard against
			// dropping a later writer's promise that already replaced ours.
			if (this.yamlWriteChains.get(projectRoot) === next) {
				this.yamlWriteChains.delete(projectRoot);
			}
		}
	}

	/**
	 * Remove a subscription from cue.yaml, serialised against the per-root write
	 * chain (see {@link enqueueYamlWrite}). The single serialised entry point for
	 * both the run-completion self-destruct path and the trigger-source
	 * `requestSelfDestruct` callback wired into the runtime service.
	 */
	private selfDestructSubscription(
		projectRoot: string,
		subscriptionName: string
	): Promise<SelfDestructResult> {
		return this.enqueueYamlWrite(projectRoot, () =>
			removeSubscriptionFromYaml(projectRoot, subscriptionName)
		);
	}

	private runSubscriptionEnabledWrite(
		sessionId: string,
		projectRoot: string,
		targetPipeline: string,
		subName: string,
		enabled: boolean
	): boolean {
		const file = readCueConfigFile(projectRoot);
		if (!file) return false;

		let parsed: unknown;
		try {
			parsed = yaml.load(file.raw);
		} catch (err) {
			captureException(err, { operation: 'setSubscriptionEnabled:yamlLoad', sessionId });
			return false;
		}
		if (!parsed || typeof parsed !== 'object') return false;
		const subs = (parsed as Record<string, unknown>).subscriptions;
		if (!Array.isArray(subs)) return false;

		// Match BOTH pipeline AND name. Without the pipeline discriminator,
		// two same-named subs in different pipelines under one session would
		// have indistinguishable ids and the first-match heuristic could
		// silently toggle the wrong row.
		let found = false;
		for (const sub of subs) {
			if (!sub || typeof sub !== 'object') continue;
			const subRecord = sub as Record<string, unknown>;
			if (subRecord.name !== subName) continue;
			const subPipeline = pipelineKeyForSubscription({
				name: subRecord.name as string,
				pipeline_name:
					typeof subRecord.pipeline_name === 'string' ? subRecord.pipeline_name : undefined,
			});
			if (subPipeline !== targetPipeline) continue;
			subRecord.enabled = enabled;
			found = true;
			break;
		}
		if (!found) return false;

		try {
			const serialized = yaml.dump(parsed, { lineWidth: -1, noRefs: true });
			writeCueConfigFile(projectRoot, serialized);
		} catch (err) {
			captureException(err, { operation: 'setSubscriptionEnabled:yamlWrite', sessionId });
			return false;
		}

		this.refreshSession(sessionId, projectRoot);
		return true;
	}

	/** Returns the lifetime count of Cue events recorded in the journal. */
	getEventCount(): number {
		return countCueEvents();
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

	/**
	 * Re-run sleep detection and trigger immediate GitHub polls. Called by the
	 * Electron main process on `powerMonitor.on('resume')` so a laptop that's
	 * been asleep - long enough for time-based or PR/issue triggers to be
	 * missed - catches up within seconds of the lid opening.
	 *
	 * Sequence:
	 *  1. Stop the heartbeat writer so its 30s tick can't clobber `last_seen`
	 *     before the recovery service computes the gap.
	 *  2. `recoveryService.detectSleepAndReconcile()` - fires one catch-up event
	 *     per `time.heartbeat` and `time.scheduled` subscription whose missed
	 *     interval / scheduled slot fell inside the gap.
	 *  3. Iterate trigger sources and call `pollNow()` on any that expose it
	 *     (currently `github.pull_request` / `github.issue`). The GitHub poller
	 *     dedupes against its SQLite "seen" set, so this is safe even if the
	 *     normal poll tick fires moments later.
	 *  4. Re-start the heartbeat writer.
	 *
	 * Idempotent: a second call within seconds sees `last_seen ≈ now` (because
	 * step 4 wrote a fresh heartbeat), so the recovery service's threshold
	 * check short-circuits without firing duplicate catch-ups. Multiple resume
	 * events from the same wake (lid + display + monitor) are absorbed.
	 *
	 * No-op when the engine is disabled.
	 */
	reconcileAfterWake(): void {
		if (!this.enabled) return;

		this.heartbeat.stop();
		try {
			this.recoveryService.detectSleepAndReconcile();

			for (const state of this.registry.snapshot().values()) {
				for (const source of state.triggerSources) {
					if (typeof source.pollNow !== 'function') continue;
					try {
						source.pollNow();
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						this.meteredOnLog('warn', `[CUE] pollNow() threw on resume: ${message}`);
						void captureException(err, { operation: 'cue.reconcileAfterWake.pollNow' });
					}
				}
			}
		} finally {
			this.heartbeat.start();
		}
	}

	/** Returns queue depth per session (for the Cue Modal) */
	getQueueStatus(): Map<string, number> {
		return this.runManager.getQueueStatus();
	}

	/** Returns the merged Cue settings from the first available session config */
	getSettings() {
		return this.queryService.getSettings();
	}

	/**
	 * Persist updated global Cue settings to every known cue.yaml on disk and
	 * refresh the in-memory session configs so the engine immediately reflects
	 * the new values. Used by the Settings → Encore Features → Maestro Cue
	 * panel, which autosaves on change without involving the pipeline editor.
	 *
	 * Strategy: read each unique session config root's raw YAML, swap only the
	 * `settings:` block via js-yaml parse/dump (subscriptions, no_ancestor_fallback,
	 * etc. are preserved verbatim from the parsed object - comments and exact
	 * formatting are lost, same as the pipeline editor's save path).
	 *
	 * No-op safely when no sessions are registered (engine not yet bootstrapped):
	 * in-memory settings remain at DEFAULT_CUE_SETTINGS and the next session's
	 * cue.yaml load wins. The renderer warns the user when the call lands in
	 * this state by inspecting the returned `writtenRoots` array.
	 */
	saveSettings(settings: import('./cue-types').CueSettings): { writtenRoots: string[] } {
		// Strip `owner_agent_id` - it is a PER-ROOT field (it pins ownership to an
		// agent that lives at one specific projectRoot) and must never propagate
		// across roots. Merging it into every cue.yaml here is exactly how every
		// single-agent project ended up with a bogus
		// "settings.owner_agent_id ... does not match any agent" warning: one
		// root's owner leaked through getSettings() and got broadcast to all.
		// Each file keeps its OWN existing owner_agent_id via the merge below.
		const { owner_agent_id: _perRootOwner, ...globalSettings } = settings;
		// Dedupe by config root so two sessions sharing the same cue.yaml don't
		// cause a double-write race. Prefer `configRoot` (config-from-ancestor
		// case) over the session's own projectRoot.
		const states = this.registry.snapshot();
		const sessions = this.deps.getSessions();
		const projectRootById = new Map(sessions.map((s) => [s.id, s.projectRoot]));
		const roots = new Set<string>();
		for (const [sessionId, state] of states) {
			const root = state.configRoot ?? projectRootById.get(sessionId);
			if (root) roots.add(root);
		}

		const writtenRoots: string[] = [];
		for (const root of roots) {
			try {
				const file = readCueConfigFile(root);
				if (!file) continue;
				const parsed = (yaml.load(file.raw) ?? {}) as Record<string, unknown>;
				const existingSettings = (parsed.settings ?? {}) as Record<string, unknown>;
				parsed.settings = { ...existingSettings, ...globalSettings };
				const dumped = yaml.dump(parsed, {
					indent: 2,
					lineWidth: 120,
					noRefs: true,
					quotingType: "'",
					forceQuotes: false,
				});
				writeCueConfigFile(root, dumped);
				writtenRoots.push(root);
			} catch (err) {
				void captureException(err, {
					operation: 'cue.saveSettings',
					extra: { root },
				});
			}
		}

		// Mirror the new settings into in-memory state so getSettings() returns
		// the updated values immediately (without waiting for a YAML re-read).
		for (const state of states.values()) {
			state.config.settings = { ...state.config.settings, ...globalSettings };
		}

		return { writtenRoots };
	}

	/** Returns all sessions with their parsed subscriptions (for graph visualization) */
	getGraphData() {
		return this.queryService.getGraphData();
	}

	/**
	 * Phase 12D - returns fan-in subscriptions that have completed some sources
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

	/** Testing/observability helper - expose the collector so subsystems can be
	 * handed a bound increment function without leaking the engine instance. */
	getMetricsCollector(): CueMetricsCollector {
		return this.metrics;
	}

	/**
	 * Translate structured onLog payloads into metric counter increments.
	 * Kept as a single chokepoint so subsystems stay fully decoupled from the
	 * metrics module - they emit typed CueLogPayload as normal; the engine
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
	 *   1. Exact `sub.name` match - the anchor.
	 *   2. If no exact match, treat `subscriptionName` as a `pipeline_name`
	 *      and use the first initial-trigger sub in that pipeline as the
	 *      anchor. This handles the pipeline-editor Play button case where
	 *      a freshly-rebuilt (not-yet-reloaded) trigger node carries only
	 *      `pipelineName` as its fire target - the serializer's per-branch
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
			// task.pending template variables ({{CUE_TASK_LIST}}, {{CUE_TASK_COUNT}},
			// ...) are populated purely from the event payload. The polling scanner
			// fills it in; a manual trigger does not, so without this enrichment the
			// agent receives an empty task list and reports "nothing to do" even when
			// the watched file has open tasks (issue #1151). Scan the watched file(s)
			// now so Run Now / `maestro-cli cue trigger` behaves like the auto scan.
			const taskPayload =
				sub.event === 'task.pending' && sub.watch
					? this.buildManualTaskPendingPayload(ownerSessionId, sub.watch)
					: {};

			const event = createCueEvent(sub.event, sub.name, {
				manual: true,
				...taskPayload,
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

	/**
	 * Scan a task.pending subscription's watched files at manual-trigger time and
	 * return the task payload for the first file that has pending tasks.
	 *
	 * Returns an empty object when nothing is watched, the project root is
	 * unknown, or no file currently has open tasks (the agent then legitimately
	 * reports "nothing to do"). Anchors on the first matching file, which covers
	 * the dominant single-file `watch` case; the polling scanner fires one event
	 * per file, whereas a manual trigger is a single dispatch.
	 */
	private buildManualTaskPendingPayload(
		sessionId: string,
		watchGlob: string
	): Record<string, unknown> {
		const projectRoot = this.deps.getSessions().find((s) => s.id === sessionId)?.projectRoot;
		if (!projectRoot) return {};

		try {
			const scanned = scanTaskFilesNow(projectRoot, watchGlob);
			if (scanned.length === 0) return {};
			const first = scanned[0];
			return buildTaskPendingPayload(first.absPath, first.relPath, first.content, first.tasks);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.deps.onLog('error', `[CUE] Manual task scan failed for "${watchGlob}": ${message}`);
			return {};
		}
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

	/**
	 * Best-effort plugin event sink. The Cue run lifecycle (start/finish) must
	 * never be broken by a throwing plugin bus: `onRunStarted` fires before the
	 * run manager's try/finally, so an exception here would strand the run
	 * outside cleanup. Emit failures are isolated and reported, never rethrown.
	 */
	private safeEmitPluginEvent(event: PluginEvent): void {
		try {
			this.deps.emitPluginEvent?.(event);
		} catch (err) {
			void captureException(err, { operation: 'cue:pluginEvent', topic: event.topic });
		}
	}

	/**
	 * If `result` finalized a `time.once` subscription, rewrite cue.yaml to drop
	 * it so the one-shot task does not fire again on a future engine cycle.
	 *
	 *  - `completed`  → always self-destruct.
	 *  - `failed` / `timeout` → self-destruct unless the sub set
	 *                  `self_destruct_on_failure: false` (default true).
	 *  - `stopped`    → never; the manual-stop callback never reaches here.
	 *
	 * No-op for non-`time.once` runs and when the sub is already absent from
	 * the in-memory config (e.g. removed by a hot-reload between fire and
	 * finalize). The YAML watcher reloads the config naturally after a
	 * successful rewrite - callers must not refresh the session manually.
	 */
	private maybeSelfDestructOnce(
		sessionId: string,
		result: CueRunResult,
		subscriptionName: string
	): void {
		if (result.event.type !== 'time.once') return;

		const state = this.registry.get(sessionId);
		const sub = state?.config.subscriptions.find((s) => s.name === subscriptionName);
		if (!sub) return;

		let reason: 'completed' | 'failed';
		if (result.status === 'completed') {
			reason = 'completed';
		} else if (
			(result.status === 'failed' || result.status === 'timeout') &&
			sub.self_destruct_on_failure !== false
		) {
			reason = 'failed';
		} else {
			return;
		}

		const session = this.deps.getSessions().find((s) => s.id === sessionId);
		if (!session) return;

		void this.selfDestructSubscription(session.projectRoot, subscriptionName)
			.then((res) => {
				if (res.removed) {
					this.meteredOnLog(
						'cue',
						`[CUE] self-destruct removed "${subscriptionName}" from cue.yaml (${reason})`
					);
				} else {
					this.meteredOnLog(
						'warn',
						`[CUE] self-destruct could not remove "${subscriptionName}" (${reason}): ${res.reason ?? 'unknown'}`
					);
				}
			})
			.catch((err) => {
				const message = err instanceof Error ? err.message : String(err);
				this.meteredOnLog(
					'warn',
					`[CUE] self-destruct threw for "${subscriptionName}" (${reason}): ${message}`
				);
				// removeSubscriptionFromYaml resolves expected file errors via its
				// structured { removed: false } result, so reaching this catch means
				// an unexpected throw - surface it to Sentry rather than only logging.
				void captureException(err, {
					operation: 'maybeSelfDestructOnce',
					sessionId,
					subscriptionName,
					reason,
				});
			});
	}

	/**
	 * Load recent cue_events from sqlite and seed the in-memory activity log.
	 * stdout/stderr/exitCode are not persisted, so the rehydrated entries show
	 * the metadata + status + timing only - sufficient for the activity panel.
	 * Orphaned `running` rows (from a prior app crash before the run could
	 * finalize) are surfaced as `failed` so the UI doesn't render them as a
	 * 0ms success.
	 */
	private hydrateActivityLogFromDb(): void {
		try {
			const records = getRecentCueEvents(0, 1000);
			if (records.length === 0) return;
			const sessionNamesById = new Map(this.deps.getSessions().map((s) => [s.id, s.name]));
			// getRecentCueEvents returns newest-first; reverse so the ring buffer
			// ends up with oldest at the front and newest at the back, matching
			// the order live push() produces.
			const results = records
				.slice()
				.reverse()
				.map((record) => recordToRunResult(record, sessionNamesById));
			this.activityLog.seed(results);
			this.meteredOnLog('cue', `[CUE] Activity log rehydrated (${results.length} entries)`);
		} catch (err) {
			this.meteredOnLog(
				'warn',
				`[CUE] Activity log rehydrate failed: ${err instanceof Error ? err.message : String(err)}`
			);
			captureException(err, { operation: 'cue:hydrateActivityLogFromDb' });
		}
	}

	/**
	 * Board Phase 3 dispatch pass, invoked from the heartbeat tick.
	 *
	 * Gated on BOTH Encore flags: the Board is the first dependent Encore flag,
	 * so "Board requires Cue" is expressed as a runtime dual-check read fresh
	 * each tick (no new listener - matches the on-demand `encoreFeatures` read
	 * idiom in index.ts). When either flag is off, the pass is a no-op.
	 *
	 * For each project root, each board gets its own {@link BoardDispatcher}
	 * (kept in {@link boardDispatchers} so its in-flight set survives across
	 * ticks) and one {@link BoardDispatcher.tick}. Everything the dispatcher
	 * touches - load, save, profile resolution, spawn - is injected from
	 * {@link CueEngineBoardDeps}, so the engine core stays board-agnostic.
	 *
	 * Never throws: a board or profile problem must not take down the Cue
	 * heartbeat that shares this tick.
	 */
	private boardDispatchTick(): void {
		const board = this.deps.board;
		if (!board) return;
		if (!this.enabled) return;

		try {
			// Dual-gate: Board requires Cue. Read both flags fresh each tick so a
			// runtime toggle of either takes effect without an app restart.
			const ef = board.getEncoreFeatures();
			if (!ef.maestroCue || !ef.board) return;

			const roots = new Set(board.getProjectRoots());
			const seenKeys = new Set<string>();
			for (const projectRoot of roots) {
				let boards: Board[];
				try {
					boards = board.listBoards(projectRoot);
				} catch (err) {
					this.meteredOnLog(
						'warn',
						`[BOARD] Failed to load boards for "${projectRoot}": ${err instanceof Error ? err.message : String(err)}`
					);
					continue;
				}
				for (const b of boards) {
					const key = `${projectRoot}::${b.id}`;
					seenKeys.add(key);
					// Optional auto-decompose (off by default; gated on the board's own
					// flag). Fire-and-forget with an in-flight guard; expanded children
					// are picked up by a subsequent tick's dispatch.
					this.maybeAutoDecompose(key, projectRoot, b);
					const dispatcher = this.getOrCreateBoardDispatcher(key, projectRoot, b.id);
					dispatcher.tick();
				}
			}

			// Drop dispatchers whose board vanished (deleted board.yaml / board) so
			// the map doesn't grow unbounded across the engine's lifetime.
			for (const key of [...this.boardDispatchers.keys()]) {
				if (!seenKeys.has(key)) this.boardDispatchers.delete(key);
			}
		} catch (err) {
			this.meteredOnLog(
				'warn',
				`[BOARD] Dispatch tick failed: ${err instanceof Error ? err.message : String(err)}`
			);
			captureException(err, { operation: 'board:dispatchTick' });
		}
	}

	/**
	 * Kick off one auto-decompose pass for a board when the optional `decompose`
	 * dep is wired and the board opted in (`autoDecompose: true`). Guarded so a
	 * single slow pass isn't relaunched by the next tick. Errors are logged and
	 * never propagate to the tick loop.
	 */
	private maybeAutoDecompose(key: string, projectRoot: string, board: Board): void {
		const decompose = this.deps.board?.decompose;
		if (!decompose) return;
		if (board.autoDecompose !== true) return;
		if (this.boardDecomposeInFlight.has(key)) return;
		this.boardDecomposeInFlight.add(key);
		decompose(projectRoot, board)
			.then((count) => {
				if (count > 0) {
					this.meteredOnLog('info', `[BOARD] auto-decomposed ${count} triage card(s)`);
				}
			})
			.catch((err) => {
				this.meteredOnLog(
					'warn',
					`[BOARD] auto-decompose failed: ${err instanceof Error ? err.message : String(err)}`
				);
			})
			.finally(() => {
				this.boardDecomposeInFlight.delete(key);
			});
	}

	/** Get (or lazily build) the dispatcher bound to one board at a project root. */
	private getOrCreateBoardDispatcher(
		key: string,
		projectRoot: string,
		boardId: string
	): BoardDispatcher {
		const existing = this.boardDispatchers.get(key);
		if (existing) return existing;

		const boardDeps = this.deps.board!;
		const dispatcher = new BoardDispatcher({
			loadBoard: () => boardDeps.listBoards(projectRoot).find((b) => b.id === boardId) ?? null,
			saveBoard: (b: Board) => boardDeps.saveBoard(projectRoot, b),
			resolveOverrides: (card: BoardCard): ProfileSpawnOverrides | null =>
				boardDeps.resolveOverrides(projectRoot, card),
			assign: boardDeps.assign
				? (card: BoardCard, busy: ReadonlySet<string>): CardAssignment =>
						boardDeps.assign!(projectRoot, card, busy)
				: undefined,
			spawn: (request: CardSpawnRequest): Promise<CardSpawnResult> =>
				boardDeps.spawnCard(projectRoot, request),
			onLog: (level, message) => this.meteredOnLog(level, `[BOARD] ${message}`),
		});
		this.boardDispatchers.set(key, dispatcher);
		return dispatcher;
	}
}

function recordToRunResult(
	record: CueEventRecord,
	sessionNamesById: Map<string, string>
): CueRunResult {
	let payload: Record<string, unknown> = {};
	if (record.payload) {
		try {
			const parsed = JSON.parse(record.payload);
			if (parsed && typeof parsed === 'object') {
				payload = parsed as Record<string, unknown>;
			}
		} catch {
			// Non-JSON or corrupt payload - leave empty rather than crash hydration.
		}
	}
	const startedAt = new Date(record.createdAt).toISOString();
	const endedAt = record.completedAt ? new Date(record.completedAt).toISOString() : '';
	const durationMs = record.completedAt ? Math.max(0, record.completedAt - record.createdAt) : 0;
	// Orphaned `running` rows survived an app crash - surface as failed so the
	// activity log doesn't paint them as zero-duration successes.
	const status: CueRunStatus =
		record.status === 'running' ? 'failed' : (record.status as CueRunStatus);
	return {
		runId: record.id,
		sessionId: record.sessionId,
		sessionName: sessionNamesById.get(record.sessionId) ?? record.sessionId,
		subscriptionName: record.subscriptionName,
		event: {
			id: record.id,
			type: record.type as CueEventType,
			timestamp: startedAt,
			triggerName: record.triggerName,
			payload,
		},
		status,
		stdout: '',
		stderr: '',
		exitCode: null,
		durationMs,
		startedAt,
		endedAt,
	};
}
