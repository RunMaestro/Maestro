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
	type CueConfig,
	type CueRunResult,
	type CueEvent,
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
import { createCueRecoveryService, type CueRecoveryService } from './cue-recovery-service';
import { loadCueConfig } from './cue-yaml-loader';

const MAX_CHAIN_DEPTH = 10;

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
				this.notifyAgentCompleted(sessionId, {
					sessionName: result.sessionName,
					status: result.status,
					exitCode: result.exitCode,
					durationMs: result.durationMs,
					stdout: result.stdout,
					triggeredBy: subscriptionName,
					chainDepth: (chainDepth ?? 0) + 1,
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
				this.dispatchService.dispatchSubscription(
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
			executeRun: (sessionId, prompt, event, subscriptionName, outputPrompt, chainDepth) => {
				this.runManager.execute(
					sessionId,
					prompt,
					event,
					subscriptionName,
					outputPrompt,
					chainDepth
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
				this.dispatchService.dispatchSubscription(
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
		this.heartbeat = createCueHeartbeat();
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
		this.deps.onLog('cue', '[CUE] Engine started');

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

		this.deps.onLog('cue', '[CUE] Engine stopped');
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
	 * Manually trigger a subscription by name, bypassing its event conditions.
	 * Creates a synthetic event and dispatches through the normal execution path.
	 * Returns true if the subscription was found and triggered.
	 */
	triggerSubscription(subscriptionName: string, promptOverride?: string): boolean {
		for (const [sessionId, state] of this.registry.snapshot()) {
			for (const sub of state.config.subscriptions) {
				if (sub.name !== subscriptionName) continue;
				if (sub.agent_id && sub.agent_id !== sessionId) continue;

				const event = createCueEvent(sub.event, sub.name, {
					manual: true,
					...(promptOverride ? { cliPrompt: promptOverride } : {}),
				});

				this.deps.onLog(
					'cue',
					`[CUE] "${sub.name}" manually triggered${promptOverride ? ' (with prompt override)' : ''}`
				);
				state.lastTriggered = event.timestamp;
				this.dispatchService.dispatchSubscription(
					sessionId,
					sub,
					event,
					'manual',
					undefined,
					promptOverride
				);
				return true;
			}
		}
		return false;
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
