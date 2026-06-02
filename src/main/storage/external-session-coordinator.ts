/**
 * External Session Coordinator
 *
 * Phase 4 of Remote Agent Visibility. Wires the per-agent
 * {@link SessionFileWatcher}s into a single hub, classifies each observed
 * session as Maestro-spawned (`local`) or started outside Maestro
 * (`external`), and emits a coalesced `'state-changed'` event the renderer can
 * subscribe to (over IPC) to light up the thinking pill for sessions Maestro
 * did not spawn.
 *
 * SAME-USER ONLY — inherits the local-FS scope of {@link SessionFileWatcher}.
 * SSH remote watching is explicitly out of scope.
 */

import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import { SessionFileWatcher } from './session-file-watcher';
import type { StorageWatchSpec } from './base-session-storage';
import type { SessionActivityEvent } from '../../shared/sessionActivity';
import type { ToolType } from '../../shared/types';
import type { ProcessManager } from '../process-manager';

const LOG_CONTEXT = 'ExternalSessionCoordinator';

/** Default coalescing window for `'state-changed'` emissions. */
const DEFAULT_DEBOUNCE_MS = 100;

/** Event name emitted whenever the tracked-session map transitions. */
export const STATE_CHANGED_EVENT = 'state-changed';

/**
 * Payload carried by the {@link STATE_CHANGED_EVENT} event — a flat snapshot of
 * every session currently being tracked (one entry per active session file).
 */
export interface ExternalSessionStateChange {
	events: SessionActivityEvent[];
}

/**
 * Minimal storage surface the coordinator depends on. Concrete storage classes
 * extend `BaseSessionStorage` (which provides `getStorageWatchSpec()` returning
 * `null` by default), so they satisfy this structurally. Typed loosely so the
 * coordinator can defensively skip storages that don't expose the hook.
 */
export interface WatchableStorage {
	readonly agentId: ToolType;
	getStorageWatchSpec?: () => StorageWatchSpec | null;
}

/**
 * Dependencies for the coordinator.
 *
 * `processManager` is narrowed to just the lookup the coordinator needs, which
 * keeps unit tests free to inject a tiny fake. `storageRegistry` maps agent id
 * to its storage; entries may be `undefined` (agent not registered on this
 * machine) and are skipped.
 */
export interface ExternalSessionCoordinatorDeps {
	processManager: Pick<ProcessManager, 'findByAgentSessionId'>;
	storageRegistry: Record<string, WatchableStorage | undefined>;
	/** Coalescing window in ms. Defaults to {@link DEFAULT_DEBOUNCE_MS}. */
	debounceMs?: number;
}

/**
 * Owns one {@link SessionFileWatcher} per agent that exposes a watch spec,
 * funnels their `'append'`/`'create'`/`'idle'` events into a single tracked
 * state map, and re-emits a debounced `'state-changed'` snapshot.
 *
 * Events:
 * - `'state-changed'` — fired (coalesced over `debounceMs`) on every transition
 *   of the tracked-session map, carrying {@link ExternalSessionStateChange}.
 */
export class ExternalSessionCoordinator extends EventEmitter {
	private readonly processManager: Pick<ProcessManager, 'findByAgentSessionId'>;
	private readonly storageRegistry: Record<string, WatchableStorage | undefined>;
	private readonly debounceMs: number;
	private readonly watchers: SessionFileWatcher[] = [];

	/** Tracked sessions keyed by `${agentId}:${sessionId}`. */
	private readonly state = new Map<string, SessionActivityEvent>();
	private emitTimer: ReturnType<typeof setTimeout> | null = null;
	private started = false;

	constructor(deps: ExternalSessionCoordinatorDeps) {
		super();
		this.processManager = deps.processManager;
		this.storageRegistry = deps.storageRegistry;
		this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	}

	/**
	 * Instantiate and start one watcher per storage that returns a non-null
	 * watch spec. Idempotent — repeat calls after the first are no-ops. Per
	 * the watch contract, individual watcher start failures are logged, not
	 * fatal, so the returned promise resolves once every watcher has had its
	 * chance to come up (regardless of which succeeded).
	 */
	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;

		const starts: Promise<void>[] = [];

		for (const storage of Object.values(this.storageRegistry)) {
			if (!storage) continue;
			if (typeof storage.getStorageWatchSpec !== 'function') continue;

			let spec: StorageWatchSpec | null;
			try {
				spec = storage.getStorageWatchSpec();
			} catch (err) {
				logger.warn(`getStorageWatchSpec() threw for ${storage.agentId}: ${err}`, LOG_CONTEXT);
				continue;
			}
			if (!spec) continue;

			const watcher = new SessionFileWatcher({
				agentId: storage.agentId,
				storageDir: spec.rootDir,
				fileMatcher: spec.fileMatcher,
			});

			// The spec's `activityEvent` is descriptive only — both `'append'`
			// and `'create'` represent live activity. Whether a session counts
			// as "thinking" is decided renderer-side by the event timestamp
			// (isActive), not by which event name fired here.
			watcher.on('append', (event: SessionActivityEvent) => this.handleActivity(event));
			watcher.on('create', (event: SessionActivityEvent) => this.handleActivity(event));
			watcher.on('idle', (event: SessionActivityEvent) => this.handleIdle(event));

			this.watchers.push(watcher);
			starts.push(
				watcher.start().catch((err) => {
					logger.warn(`Failed to start watcher for ${storage.agentId}: ${err}`, LOG_CONTEXT);
				})
			);
		}

		await Promise.allSettled(starts);
	}

	/**
	 * Stop every watcher, cancel any pending emission, and clear tracked state.
	 * Safe to call multiple times.
	 */
	async stop(): Promise<void> {
		if (this.emitTimer) {
			clearTimeout(this.emitTimer);
			this.emitTimer = null;
		}
		// Splice so a repeat stop() finds nothing to stop.
		const watchers = this.watchers.splice(0);
		await Promise.allSettled(watchers.map((w) => w.stop()));
		this.state.clear();
	}

	/**
	 * Defensive snapshot of the currently-tracked sessions. Callers (e.g. the
	 * IPC hydration handler) can mutate the returned map freely.
	 */
	getState(): Map<string, SessionActivityEvent> {
		return new Map(this.state);
	}

	private keyFor(event: Pick<SessionActivityEvent, 'agentId' | 'sessionId'>): string {
		return `${event.agentId}:${event.sessionId}`;
	}

	/**
	 * Record an `'append'`/`'create'` event. Re-classifies `source` by checking
	 * the ProcessManager for a Maestro-spawned process with the same
	 * agent-native session id — overriding whatever the watcher claimed.
	 */
	private handleActivity(event: SessionActivityEvent): void {
		const localProcess = this.processManager.findByAgentSessionId(event.sessionId);
		const annotated: SessionActivityEvent = {
			...event,
			source: localProcess ? 'local' : 'external',
		};
		this.state.set(this.keyFor(annotated), annotated);
		this.scheduleEmit();
	}

	/** Drop a session that went idle. Unknown keys are silently ignored. */
	private handleIdle(event: SessionActivityEvent): void {
		const key = this.keyFor(event);
		if (!this.state.has(key)) return;
		this.state.delete(key);
		this.scheduleEmit();
	}

	/**
	 * Coalesce a burst of transitions into a single emission. We keep the first
	 * armed timer and snapshot the map when it fires, so the payload always
	 * reflects the latest annotated copy per key without churning timers (and
	 * without risking starvation under sustained activity).
	 */
	private scheduleEmit(): void {
		if (this.emitTimer) return;
		this.emitTimer = setTimeout(() => {
			this.emitTimer = null;
			const payload: ExternalSessionStateChange = {
				events: Array.from(this.state.values()),
			};
			this.emit(STATE_CHANGED_EVENT, payload);
		}, this.debounceMs);
	}
}
