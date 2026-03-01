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

import * as crypto from 'crypto';
import type { MainLogLevel } from '../../shared/logger-types';
import type { SessionInfo } from '../../shared/types';
import type {
	AgentCompletionData,
	CueConfig,
	CueEvent,
	CueRunResult,
	CueSessionStatus,
	CueSubscription,
} from './cue-types';
import { loadCueConfig, watchCueYaml } from './cue-yaml-loader';
import { createCueFileWatcher } from './cue-file-watcher';

const ACTIVITY_LOG_MAX = 500;
const DEFAULT_FILE_DEBOUNCE_MS = 5000;
const SOURCE_OUTPUT_MAX_CHARS = 5000;

/** Dependencies injected into the CueEngine */
export interface CueEngineDeps {
	getSessions: () => SessionInfo[];
	onCueRun: (sessionId: string, prompt: string, event: CueEvent) => Promise<CueRunResult>;
	onLog: (level: MainLogLevel, message: string, data?: unknown) => void;
}

/** Internal state per session with an active Cue config */
interface SessionState {
	config: CueConfig;
	timers: ReturnType<typeof setInterval>[];
	watchers: (() => void)[];
	yamlWatcher: (() => void) | null;
	lastTriggered?: string;
	nextTriggers: Map<string, number>; // subscriptionName -> next trigger timestamp
}

/** Active run tracking */
interface ActiveRun {
	result: CueRunResult;
	abortController?: AbortController;
}

/** Stored data for a single fan-in source completion */
interface FanInSourceCompletion {
	sessionId: string;
	sessionName: string;
	output: string;
}

export class CueEngine {
	private enabled = false;
	private sessions = new Map<string, SessionState>();
	private activeRuns = new Map<string, ActiveRun>();
	private activityLog: CueRunResult[] = [];
	private fanInTrackers = new Map<string, Map<string, FanInSourceCompletion>>();
	private fanInTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private deps: CueEngineDeps;

	constructor(deps: CueEngineDeps) {
		this.deps = deps;
	}

	/** Enable the engine and scan all sessions for Cue configs */
	start(): void {
		this.enabled = true;
		this.deps.onLog('cue', '[CUE] Engine started');

		const sessions = this.deps.getSessions();
		for (const session of sessions) {
			this.initSession(session);
		}
	}

	/** Disable the engine, clearing all timers and watchers */
	stop(): void {
		this.enabled = false;
		for (const [sessionId] of this.sessions) {
			this.teardownSession(sessionId);
		}
		this.sessions.clear();
		this.deps.onLog('cue', '[CUE] Engine stopped');
	}

	/** Re-read the YAML for a specific session, tearing down old subscriptions */
	refreshSession(sessionId: string, projectRoot: string): void {
		this.teardownSession(sessionId);
		this.sessions.delete(sessionId);

		const session = this.deps.getSessions().find((s) => s.id === sessionId);
		if (session) {
			this.initSession({ ...session, projectRoot });
		}
	}

	/** Teardown all subscriptions for a session */
	removeSession(sessionId: string): void {
		this.teardownSession(sessionId);
		this.sessions.delete(sessionId);
		this.deps.onLog('cue', `[CUE] Session removed: ${sessionId}`);
	}

	/** Returns status of all sessions with Cue configs */
	getStatus(): CueSessionStatus[] {
		const result: CueSessionStatus[] = [];
		const allSessions = this.deps.getSessions();

		for (const [sessionId, state] of this.sessions) {
			const session = allSessions.find((s) => s.id === sessionId);
			if (!session) continue;

			const activeRunCount = [...this.activeRuns.values()].filter(
				(r) => r.result.sessionId === sessionId
			).length;

			let nextTrigger: string | undefined;
			if (state.nextTriggers.size > 0) {
				const earliest = Math.min(...state.nextTriggers.values());
				nextTrigger = new Date(earliest).toISOString();
			}

			result.push({
				sessionId,
				sessionName: session.name,
				toolType: session.toolType,
				projectRoot: session.projectRoot,
				enabled: true,
				subscriptionCount: state.config.subscriptions.filter((s) => s.enabled !== false).length,
				activeRuns: activeRunCount,
				lastTriggered: state.lastTriggered,
				nextTrigger,
			});
		}

		return result;
	}

	/** Returns currently running Cue executions */
	getActiveRuns(): CueRunResult[] {
		return [...this.activeRuns.values()].map((r) => r.result);
	}

	/** Returns recent completed/failed runs */
	getActivityLog(limit?: number): CueRunResult[] {
		if (limit !== undefined) {
			return this.activityLog.slice(-limit);
		}
		return [...this.activityLog];
	}

	/** Stops a specific running execution */
	stopRun(runId: string): boolean {
		const run = this.activeRuns.get(runId);
		if (!run) return false;

		run.abortController?.abort();
		run.result.status = 'stopped';
		run.result.endedAt = new Date().toISOString();
		run.result.durationMs = Date.now() - new Date(run.result.startedAt).getTime();

		this.activeRuns.delete(runId);
		this.pushActivityLog(run.result);
		this.deps.onLog('cue', `[CUE] Run stopped: ${runId}`);
		return true;
	}

	/** Stops all running executions */
	stopAll(): void {
		for (const [runId] of this.activeRuns) {
			this.stopRun(runId);
		}
	}

	/** Returns master enabled state */
	isEnabled(): boolean {
		return this.enabled;
	}

	/**
	 * Check if any Cue subscriptions are listening for a given session's completion.
	 * Used to avoid emitting completion events for sessions nobody cares about.
	 */
	hasCompletionSubscribers(sessionId: string): boolean {
		if (!this.enabled) return false;

		const allSessions = this.deps.getSessions();
		const completingSession = allSessions.find((s) => s.id === sessionId);
		const completingName = completingSession?.name ?? sessionId;

		for (const [, state] of this.sessions) {
			for (const sub of state.config.subscriptions) {
				if (sub.event !== 'agent.completed' || sub.enabled === false) continue;

				const sources = Array.isArray(sub.source_session)
					? sub.source_session
					: sub.source_session
						? [sub.source_session]
						: [];

				if (sources.some((src) => src === sessionId || src === completingName)) {
					return true;
				}
			}
		}

		return false;
	}

	/** Notify the engine that an agent session has completed (for agent.completed triggers) */
	notifyAgentCompleted(sessionId: string, completionData?: AgentCompletionData): void {
		if (!this.enabled) return;

		// Resolve the completing session's name for matching
		const allSessions = this.deps.getSessions();
		const completingSession = allSessions.find((s) => s.id === sessionId);
		const completingName = completionData?.sessionName ?? completingSession?.name ?? sessionId;

		for (const [ownerSessionId, state] of this.sessions) {
			for (const sub of state.config.subscriptions) {
				if (sub.event !== 'agent.completed' || sub.enabled === false) continue;

				const sources = Array.isArray(sub.source_session)
					? sub.source_session
					: sub.source_session
						? [sub.source_session]
						: [];

				// Match by session name or ID
				if (!sources.some((src) => src === sessionId || src === completingName)) continue;

				if (sources.length === 1) {
					// Single source — fire immediately
					const event: CueEvent = {
						id: crypto.randomUUID(),
						type: 'agent.completed',
						timestamp: new Date().toISOString(),
						triggerName: sub.name,
						payload: {
							sourceSession: completingName,
							sourceSessionId: sessionId,
							status: completionData?.status ?? 'completed',
							exitCode: completionData?.exitCode ?? null,
							durationMs: completionData?.durationMs ?? 0,
							sourceOutput: (completionData?.stdout ?? '').slice(-SOURCE_OUTPUT_MAX_CHARS),
							triggeredBy: completionData?.triggeredBy,
						},
					};
					this.deps.onLog('cue', `[CUE] "${sub.name}" triggered (agent.completed)`);
					this.dispatchSubscription(ownerSessionId, sub, event, completingName);
				} else {
					// Fan-in: track completions with data
					this.handleFanIn(
						ownerSessionId,
						state,
						sub,
						sources,
						sessionId,
						completingName,
						completionData
					);
				}
			}
		}
	}

	/** Clear all fan-in state for a session (when Cue is disabled or session removed) */
	clearFanInState(sessionId: string): void {
		for (const key of [...this.fanInTrackers.keys()]) {
			if (key.startsWith(`${sessionId}:`)) {
				this.fanInTrackers.delete(key);
				const timer = this.fanInTimers.get(key);
				if (timer) {
					clearTimeout(timer);
					this.fanInTimers.delete(key);
				}
			}
		}
	}

	// --- Private methods ---

	/**
	 * Dispatch a subscription, handling fan-out if configured.
	 * If the subscription has fan_out targets, fires against each target session.
	 * Otherwise fires against the owner session.
	 */
	private dispatchSubscription(
		ownerSessionId: string,
		sub: CueSubscription,
		event: CueEvent,
		sourceSessionName: string
	): void {
		if (sub.fan_out && sub.fan_out.length > 0) {
			// Fan-out: fire against each target session
			const targetNames = sub.fan_out.join(', ');
			this.deps.onLog('cue', `[CUE] Fan-out: "${sub.name}" → ${targetNames}`);

			const allSessions = this.deps.getSessions();
			for (let i = 0; i < sub.fan_out.length; i++) {
				const targetName = sub.fan_out[i];
				const targetSession = allSessions.find((s) => s.name === targetName || s.id === targetName);

				if (!targetSession) {
					this.deps.onLog('cue', `[CUE] Fan-out target not found: "${targetName}" — skipping`);
					continue;
				}

				const fanOutEvent: CueEvent = {
					...event,
					id: crypto.randomUUID(),
					payload: {
						...event.payload,
						fanOutSource: sourceSessionName,
						fanOutIndex: i,
					},
				};
				this.executeCueRun(targetSession.id, sub.prompt, fanOutEvent, sub.name);
			}
		} else {
			this.executeCueRun(ownerSessionId, sub.prompt, event, sub.name);
		}
	}

	/**
	 * Handle fan-in logic: track which sources have completed, fire when all done.
	 * Supports timeout handling based on the subscription's settings.
	 */
	private handleFanIn(
		ownerSessionId: string,
		state: SessionState,
		sub: CueSubscription,
		sources: string[],
		completedSessionId: string,
		completedSessionName: string,
		completionData?: AgentCompletionData
	): void {
		const key = `${ownerSessionId}:${sub.name}`;

		if (!this.fanInTrackers.has(key)) {
			this.fanInTrackers.set(key, new Map());
		}
		const tracker = this.fanInTrackers.get(key)!;
		tracker.set(completedSessionId, {
			sessionId: completedSessionId,
			sessionName: completedSessionName,
			output: (completionData?.stdout ?? '').slice(-SOURCE_OUTPUT_MAX_CHARS),
		});

		// Start timeout timer on first source completion
		if (tracker.size === 1 && !this.fanInTimers.has(key)) {
			const timeoutMs = (state.config.settings.timeout_minutes ?? 30) * 60 * 1000;
			const timer = setTimeout(() => {
				this.handleFanInTimeout(key, ownerSessionId, state, sub, sources);
			}, timeoutMs);
			this.fanInTimers.set(key, timer);
		}

		const remaining = sources.length - tracker.size;
		if (remaining > 0) {
			this.deps.onLog(
				'cue',
				`[CUE] Fan-in "${sub.name}": waiting for ${remaining} more session(s)`
			);
			return;
		}

		// All sources completed — clear timer and fire
		const timer = this.fanInTimers.get(key);
		if (timer) {
			clearTimeout(timer);
			this.fanInTimers.delete(key);
		}
		this.fanInTrackers.delete(key);

		const completions = [...tracker.values()];
		const event: CueEvent = {
			id: crypto.randomUUID(),
			type: 'agent.completed',
			timestamp: new Date().toISOString(),
			triggerName: sub.name,
			payload: {
				completedSessions: completions.map((c) => c.sessionId),
				sourceSession: completions.map((c) => c.sessionName).join(', '),
				sourceOutput: completions.map((c) => c.output).join('\n---\n'),
			},
		};
		this.deps.onLog('cue', `[CUE] "${sub.name}" triggered (agent.completed, fan-in complete)`);
		this.dispatchSubscription(
			ownerSessionId,
			sub,
			event,
			completions.map((c) => c.sessionName).join(', ')
		);
	}

	/**
	 * Handle fan-in timeout. Behavior depends on timeout_on_fail setting:
	 * - 'break': log failure and clear the tracker
	 * - 'continue': fire the downstream subscription with partial data
	 */
	private handleFanInTimeout(
		key: string,
		ownerSessionId: string,
		state: SessionState,
		sub: CueSubscription,
		sources: string[]
	): void {
		this.fanInTimers.delete(key);
		const tracker = this.fanInTrackers.get(key);
		if (!tracker) return;

		const completedNames = [...tracker.values()].map((c) => c.sessionName);
		const completedIds = [...tracker.keys()];

		// Determine which sources haven't completed yet
		const allSessions = this.deps.getSessions();
		const timedOutSources = sources.filter((src) => {
			const session = allSessions.find((s) => s.name === src || s.id === src);
			const sessionId = session?.id ?? src;
			return !completedIds.includes(sessionId) && !completedIds.includes(src);
		});

		if (state.config.settings.timeout_on_fail === 'continue') {
			// Fire with partial data
			const completions = [...tracker.values()];
			this.fanInTrackers.delete(key);

			const event: CueEvent = {
				id: crypto.randomUUID(),
				type: 'agent.completed',
				timestamp: new Date().toISOString(),
				triggerName: sub.name,
				payload: {
					completedSessions: completions.map((c) => c.sessionId),
					timedOutSessions: timedOutSources,
					sourceSession: completions.map((c) => c.sessionName).join(', '),
					sourceOutput: completions.map((c) => c.output).join('\n---\n'),
					partial: true,
				},
			};
			this.deps.onLog(
				'cue',
				`[CUE] Fan-in "${sub.name}" timed out (continue mode) — firing with ${completedNames.length}/${sources.length} sources`
			);
			this.dispatchSubscription(ownerSessionId, sub, event, completedNames.join(', '));
		} else {
			// 'break' mode — log failure and clear
			this.fanInTrackers.delete(key);
			this.deps.onLog(
				'cue',
				`[CUE] Fan-in "${sub.name}" timed out (break mode) — ${completedNames.length}/${sources.length} completed, waiting for: ${timedOutSources.join(', ')}`
			);
		}
	}

	private initSession(session: SessionInfo): void {
		if (!this.enabled) return;

		const config = loadCueConfig(session.projectRoot);
		if (!config) return;

		const state: SessionState = {
			config,
			timers: [],
			watchers: [],
			yamlWatcher: null,
			nextTriggers: new Map(),
		};

		// Watch the YAML file for changes
		state.yamlWatcher = watchCueYaml(session.projectRoot, () => {
			this.deps.onLog('cue', `[CUE] Config changed for session "${session.name}", refreshing`);
			this.refreshSession(session.id, session.projectRoot);
		});

		// Set up subscriptions
		for (const sub of config.subscriptions) {
			if (sub.enabled === false) continue;

			if (sub.event === 'time.interval' && sub.interval_minutes) {
				this.setupTimerSubscription(session, state, sub);
			} else if (sub.event === 'file.changed' && sub.watch) {
				this.setupFileWatcherSubscription(session, state, sub);
			}
			// agent.completed subscriptions are handled reactively via notifyAgentCompleted
		}

		this.sessions.set(session.id, state);
		this.deps.onLog(
			'cue',
			`[CUE] Initialized session "${session.name}" with ${config.subscriptions.filter((s) => s.enabled !== false).length} active subscription(s)`
		);
	}

	private setupTimerSubscription(
		session: SessionInfo,
		state: SessionState,
		sub: { name: string; prompt: string; interval_minutes?: number }
	): void {
		const intervalMs = (sub.interval_minutes ?? 0) * 60 * 1000;
		if (intervalMs <= 0) return;

		// Fire immediately on first setup
		const immediateEvent: CueEvent = {
			id: crypto.randomUUID(),
			type: 'time.interval',
			timestamp: new Date().toISOString(),
			triggerName: sub.name,
			payload: { interval_minutes: sub.interval_minutes },
		};
		this.deps.onLog('cue', `[CUE] "${sub.name}" triggered (time.interval, initial)`);
		this.executeCueRun(session.id, sub.prompt, immediateEvent, sub.name);

		// Then on the interval
		const timer = setInterval(() => {
			if (!this.enabled) return;

			const event: CueEvent = {
				id: crypto.randomUUID(),
				type: 'time.interval',
				timestamp: new Date().toISOString(),
				triggerName: sub.name,
				payload: { interval_minutes: sub.interval_minutes },
			};
			this.deps.onLog('cue', `[CUE] "${sub.name}" triggered (time.interval)`);
			state.lastTriggered = event.timestamp;
			state.nextTriggers.set(sub.name, Date.now() + intervalMs);
			this.executeCueRun(session.id, sub.prompt, event, sub.name);
		}, intervalMs);

		state.nextTriggers.set(sub.name, Date.now() + intervalMs);
		state.timers.push(timer);
	}

	private setupFileWatcherSubscription(
		session: SessionInfo,
		state: SessionState,
		sub: { name: string; prompt: string; watch?: string }
	): void {
		if (!sub.watch) return;

		const cleanup = createCueFileWatcher({
			watchGlob: sub.watch,
			projectRoot: session.projectRoot,
			debounceMs: DEFAULT_FILE_DEBOUNCE_MS,
			triggerName: sub.name,
			onEvent: (event) => {
				if (!this.enabled) return;
				this.deps.onLog('cue', `[CUE] "${sub.name}" triggered (file.changed)`);
				state.lastTriggered = event.timestamp;
				this.executeCueRun(session.id, sub.prompt, event, sub.name);
			},
		});

		state.watchers.push(cleanup);
	}

	private async executeCueRun(
		sessionId: string,
		prompt: string,
		event: CueEvent,
		subscriptionName: string
	): Promise<void> {
		const session = this.deps.getSessions().find((s) => s.id === sessionId);
		const runId = crypto.randomUUID();
		const abortController = new AbortController();

		const result: CueRunResult = {
			runId,
			sessionId,
			sessionName: session?.name ?? 'Unknown',
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

		this.activeRuns.set(runId, { result, abortController });

		try {
			const runResult = await this.deps.onCueRun(sessionId, prompt, event);
			result.status = runResult.status;
			result.stdout = runResult.stdout;
			result.stderr = runResult.stderr;
			result.exitCode = runResult.exitCode;
		} catch (error) {
			result.status = 'failed';
			result.stderr = error instanceof Error ? error.message : String(error);
		} finally {
			result.endedAt = new Date().toISOString();
			result.durationMs = Date.now() - new Date(result.startedAt).getTime();
			this.activeRuns.delete(runId);
			this.pushActivityLog(result);

			// Emit completion event for agent completion chains
			// This allows downstream subscriptions to react to this Cue run's completion
			this.notifyAgentCompleted(sessionId, {
				sessionName: result.sessionName,
				status: result.status,
				exitCode: result.exitCode,
				durationMs: result.durationMs,
				stdout: result.stdout,
				triggeredBy: subscriptionName,
			});
		}
	}

	private pushActivityLog(result: CueRunResult): void {
		this.activityLog.push(result);
		if (this.activityLog.length > ACTIVITY_LOG_MAX) {
			this.activityLog = this.activityLog.slice(-ACTIVITY_LOG_MAX);
		}
	}

	private teardownSession(sessionId: string): void {
		const state = this.sessions.get(sessionId);
		if (!state) return;

		for (const timer of state.timers) {
			clearInterval(timer);
		}
		for (const cleanup of state.watchers) {
			cleanup();
		}
		if (state.yamlWatcher) {
			state.yamlWatcher();
		}

		// Clean up fan-in trackers and timers for this session
		this.clearFanInState(sessionId);
	}
}
