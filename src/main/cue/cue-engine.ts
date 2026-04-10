/**
 * Cue Engine Core — the main coordinator for Maestro Cue event-driven automation.
 *
 * Discovers maestro-cue.yaml files per session, manages interval timers,
 * file watchers, and agent completion listeners. Runs in the Electron main process.
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
import { captureException } from '../utils/sentry';
import { loadCueConfig } from './cue-yaml-loader';
import { initCueDb, closeCueDb, pruneCueEvents } from './cue-db';
import { createCueActivityLog } from './cue-activity-log';
import type { CueActivityLog } from './cue-activity-log';
import { createCueHeartbeat, EVENT_PRUNE_AGE_MS } from './cue-heartbeat';
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
import type { CueSessionRuntimeService } from './cue-session-runtime-service';
const MAX_CHAIN_DEPTH = 10;

// Re-export for backwards compat (tests import from cue-engine)
export { calculateNextScheduledTime } from './cue-subscription-setup';

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
	private fanInTracker!: CueFanInTracker;
	private runManager!: CueRunManager;
	/** Tracks "subName:HH:MM" keys that time.scheduled already fired, preventing double-fire on config refresh */
	private scheduledFiredKeys = new Set<string>();
	/** Tracks "sessionId:subName" keys for app.startup subscriptions that already fired this process lifecycle.
	 *  NOT cleared on stop() — persists across engine stop/start cycles (feature toggling). Only resets on app restart. */
	private startupFiredKeys = new Set<string>();
	/** True only during the initial session scan inside start(true). Cleared immediately after the scan
	 *  completes so that later refreshSession/initSession calls don't fire app.startup subs. */
	private isBootScan = false;
	private heartbeat: CueHeartbeat;
	private dispatchService: CueDispatchService;
	private completionService: CueCompletionService;
	private queryService: CueQueryService;
	private sessionRuntimeService: CueSessionRuntimeService;
	private deps: CueEngineDeps;

	constructor(deps: CueEngineDeps) {
		this.deps = deps;
		this.runManager = createCueRunManager({
			getSessions: deps.getSessions,
			getSessionSettings: (sessionId) =>
				this.sessionRuntimeService.getSessionState(sessionId)?.config.settings,
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
			scheduledFiredKeys: this.scheduledFiredKeys,
			startupFiredKeys: this.startupFiredKeys,
			isBootScan: () => this.isBootScan,
			executeCueRun: (sessionId, prompt, event, subscriptionName, outputPrompt, chainDepth) => {
				this.runManager.execute(
					sessionId,
					prompt,
					event,
					subscriptionName,
					outputPrompt,
					chainDepth
				);
			},
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
			getSessionConfigs: () => this.sessionRuntimeService.getSessionConfigs(),
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
			getSessionStates: () => this.sessionRuntimeService.getSessionStates(),
			getActiveRunCount: (sessionId) => this.runManager.getActiveRunCount(sessionId),
			loadConfigForProjectRoot: loadCueConfig,
		});
		this.heartbeat = createCueHeartbeat({
			onLog: deps.onLog,
			getSessions: () => {
				const result = new Map<string, { config: CueConfig; sessionName: string }>();
				const allSessions = deps.getSessions();
				for (const [sessionId, state] of this.sessionRuntimeService.getSessionStates()) {
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

	/** Enable the engine and scan all sessions for Cue configs.
	 *  @param isSystemBoot Pass `true` only at application launch (index.ts). When false (default),
	 *  app.startup subscriptions will NOT fire — this prevents re-firing when the user toggles Cue on/off. */
	start(isSystemBoot = false): void {
		if (this.enabled) return;

		if (isSystemBoot) {
			this.isBootScan = true;
		}

		// Initialize Cue database and prune old events — fail gracefully so app startup is not blocked
		try {
			initCueDb((level, msg) => this.deps.onLog(level as MainLogLevel, msg));
			pruneCueEvents(EVENT_PRUNE_AGE_MS);
		} catch (error) {
			this.deps.onLog(
				'error',
				`[CUE] Failed to initialize Cue database — engine will not start: ${error}`
			);
			captureException(error instanceof Error ? error : new Error(String(error)), {
				extra: { operation: 'cue.dbInit' },
			});
			this.isBootScan = false;
			return;
		}

		this.enabled = true;
		this.deps.onLog('cue', '[CUE] Engine started');

		const sessions = this.deps.getSessions();
		for (const session of sessions) {
			this.sessionRuntimeService.initSession(session);
		}

		// Boot scan complete — clear the flag so later refreshSession/initSession
		// calls (YAML hot-reload, auto-discovery) don't fire app.startup subs
		this.isBootScan = false;

		// Detect sleep gap from previous heartbeat
		this.heartbeat.detectSleepAndReconcile();

		// Start heartbeat writer (30s interval)
		this.heartbeat.start();
	}

	/** Disable the engine, clearing all timers and watchers */
	stop(): void {
		if (!this.enabled) return;

		this.enabled = false;
		this.sessionRuntimeService.clearAll();

		// Clear concurrency and fan-in state
		this.runManager.reset();
		this.fanInTracker.reset();
		this.scheduledFiredKeys.clear();
		// NOTE: startupFiredKeys is NOT cleared here — it persists across engine stop/start
		// cycles so that toggling Cue off/on does not re-fire app.startup subscriptions.
		// It only resets when the Electron process restarts (new CueEngine instance).

		// Stop heartbeat and close database
		this.heartbeat.stop();
		try {
			closeCueDb();
		} catch {
			// Non-fatal — database may not have been initialized
		}

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
		for (const [sessionId, state] of this.sessionRuntimeService.getSessionStates()) {
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
