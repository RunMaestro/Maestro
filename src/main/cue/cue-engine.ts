/**
 * Cue Engine Core — the main coordinator for Maestro Cue event-driven automation.
 *
 * Discovers maestro-cue.yaml files per session, manages interval timers,
 * file watchers, and agent completion listeners. Runs in the Electron main process.
 */

import * as crypto from 'crypto';
import type { MainLogLevel } from '../../shared/logger-types';
import type { SessionInfo } from '../../shared/types';
import type { CueConfig, CueEvent, CueRunResult, CueSessionStatus } from './cue-types';
import { loadCueConfig, watchCueYaml } from './cue-yaml-loader';
import { createCueFileWatcher } from './cue-file-watcher';

const ACTIVITY_LOG_MAX = 500;
const DEFAULT_FILE_DEBOUNCE_MS = 5000;

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

export class CueEngine {
	private enabled = false;
	private sessions = new Map<string, SessionState>();
	private activeRuns = new Map<string, ActiveRun>();
	private activityLog: CueRunResult[] = [];
	private fanInTrackers = new Map<string, Set<string>>();
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

	/** Notify the engine that an agent session has completed (for agent.completed triggers) */
	notifyAgentCompleted(sessionId: string): void {
		if (!this.enabled) return;

		for (const [ownerSessionId, state] of this.sessions) {
			for (const sub of state.config.subscriptions) {
				if (sub.event !== 'agent.completed' || sub.enabled === false) continue;

				const sources = Array.isArray(sub.source_session)
					? sub.source_session
					: sub.source_session
						? [sub.source_session]
						: [];

				if (!sources.includes(sessionId)) continue;

				if (sources.length === 1) {
					// Single source — fire immediately
					const event: CueEvent = {
						id: crypto.randomUUID(),
						type: 'agent.completed',
						timestamp: new Date().toISOString(),
						triggerName: sub.name,
						payload: { completedSessionId: sessionId },
					};
					this.deps.onLog('cue', `[CUE] "${sub.name}" triggered (agent.completed)`);
					this.executeCueRun(ownerSessionId, sub.prompt, event, sub.name);
				} else {
					// Fan-in: track completions
					const key = `${ownerSessionId}:${sub.name}`;
					if (!this.fanInTrackers.has(key)) {
						this.fanInTrackers.set(key, new Set());
					}
					const tracker = this.fanInTrackers.get(key)!;
					tracker.add(sessionId);

					if (tracker.size >= sources.length) {
						this.fanInTrackers.delete(key);
						const event: CueEvent = {
							id: crypto.randomUUID(),
							type: 'agent.completed',
							timestamp: new Date().toISOString(),
							triggerName: sub.name,
							payload: {
								completedSessions: [...tracker],
							},
						};
						this.deps.onLog(
							'cue',
							`[CUE] "${sub.name}" triggered (agent.completed, fan-in complete)`
						);
						this.executeCueRun(ownerSessionId, sub.prompt, event, sub.name);
					}
				}
			}
		}
	}

	// --- Private methods ---

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

		// Clean up fan-in trackers for this session
		for (const key of this.fanInTrackers.keys()) {
			if (key.startsWith(`${sessionId}:`)) {
				this.fanInTrackers.delete(key);
			}
		}
	}
}
