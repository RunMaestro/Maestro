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
	private deps: CueEngineDeps;

	constructor(deps: CueEngineDeps) {
		this.deps = deps;
		this.registry = createCueSessionRegistry();

		this.runManager = createCueRunManager({
			getSessions: deps.getSessions,
			getSessionSettings: (sessionId) => this.registry.get(sessionId)?.config.settings,
			onCueRun: deps.onCueRun,
			onStopCueRun: deps.onStopCueRun,
			onLog: deps.onLog,
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
		});
		this.fanInTracker = createCueFanInTracker({
			onLog: deps.onLog,
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
			onLog: deps.onLog,
		});
		this.sessionRuntimeService = createCueSessionRuntimeService({
			enabled: () => this.enabled,
			getSessions: deps.getSessions,
			onRefreshRequested: (sessionId, projectRoot) => {
				this.refreshSession(sessionId, projectRoot);
			},
			onLog: deps.onLog,
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
				const configs = new Map<string, CueConfig>();
				for (const [sessionId, state] of this.registry.snapshot()) {
					configs.set(sessionId, state.config);
				}
				return configs;
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
			onLog: deps.onLog,
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
			onLog: deps.onLog,
		});
		this.heartbeat = createCueHeartbeat(() => this.cleanupService.onTick());
		this.recoveryService = createCueRecoveryService({
			onLog: deps.onLog,
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
	 *   - `'system-boot'`: pass at Electron launch (index.ts). app.startup fires.
	 *   - `'user-toggle'` (default): user flipped the Cue toggle. app.startup
	 *     does NOT re-fire — toggling is idempotent.
	 */
	start(reason: SessionInitReason = 'user-toggle'): void {
		if (this.enabled) return;

		const initResult = this.recoveryService.init();
		if (!initResult.ok) {
			return;
		}

		this.enabled = true;
		// Data payload triggers a renderer refresh via cue:activityUpdate,
		// clearing any stale queue counters left over from a prior stop.
		this.deps.onLog('cue', '[CUE] Engine started', { type: 'engineStarted' });

		const sessions = this.deps.getSessions();
		for (const session of sessions) {
			this.sessionRuntimeService.initSession(session, { reason });
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
		this.sessionRuntimeService.clearAll();

		// Clear concurrency and fan-in state. The session registry's clear()
		// preserves app.startup dedup keys across stop/start cycles, so toggling
		// Cue off/on does not re-fire startup subscriptions. Startup keys only
		// reset when the Electron process restarts (new CueEngine instance).
		this.runManager.reset();
		this.fanInTracker.reset();

		// Stop heartbeat and close database via the recovery service.
		this.heartbeat.stop();
		this.recoveryService.shutdown();

		// Data payload triggers a renderer refresh via cue:activityUpdate so
		// the queue counters, active runs list, and indicators reflect the
		// cleared engine state instead of waiting for the next 10s poll.
		this.deps.onLog('cue', '[CUE] Engine stopped', { type: 'engineStopped' });
	}

	/** Re-read the YAML for a specific session, tearing down old subscriptions */
	refreshSession(sessionId: string, projectRoot: string): void {
		const result = this.sessionRuntimeService.refreshSession(sessionId, projectRoot);
		if (result.reloaded && result.sessionName) {
			this.deps.onLog(
				'cue',
				`[CUE] Config reloaded for "${result.sessionName}" (${result.activeCount ?? 0} subscriptions)`,
				{ type: 'configReloaded', sessionId }
			);
		} else if (result.configRemoved && result.sessionName) {
			this.deps.onLog('cue', `[CUE] Config removed for "${result.sessionName}"`, {
				type: 'configRemoved',
				sessionId,
			});
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
