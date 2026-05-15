/**
 * ExternalSessionCoordinator
 *
 * Single owner of the on-disk session watchers for all agents. Walks the
 * storage registry, instantiates one {@link SessionFileWatcher} per agent
 * that exposes a {@link StorageWatchSpec}, and folds the resulting per-file
 * events into a single coalesced `'state-changed'` stream the renderer can
 * subscribe to.
 *
 * Two responsibilities the per-agent watcher doesn't handle on its own:
 *
 *  1. De-dup against locally-spawned sessions — Maestro itself may already
 *     be driving a session whose JSONL we'd otherwise classify as "external."
 *     The coordinator stamps `source: 'local' | 'external'` by asking
 *     `ProcessManager.findByAgentSessionId`.
 *  2. Burst coalescing — bulk imports or chatty agents can fire many
 *     append/create events in quick succession; we debounce the outward
 *     `'state-changed'` emission to 100ms so renderer state churn stays sane.
 *
 * Same-user, local-FS scope only; see {@link SessionFileWatcher} for the
 * underlying constraints.
 */

import { EventEmitter } from 'events';
import type { ToolType } from '../../shared/types';
import type { AgentSessionStorage } from '../agents';
import type { ProcessManager } from '../process-manager';
import type { SessionActivityEvent } from '../../shared/sessionActivity';
import { SessionFileWatcher } from './session-file-watcher';
import type { BaseSessionStorage, StorageWatchSpec } from './base-session-storage';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[ExternalSessionCoordinator]';

/** Debounce window for coalescing bursts of activity events. */
export const STATE_CHANGE_DEBOUNCE_MS = 100;

export interface ExternalSessionCoordinatorOptions {
	processManager: ProcessManager;
	storageRegistry: Partial<Record<ToolType, AgentSessionStorage>>;
}

export interface ExternalSessionStateChange {
	events: SessionActivityEvent[];
}

/**
 * Name of the event emitted whenever the coalesced state changes. Listeners
 * receive an {@link ExternalSessionStateChange} payload.
 */
export const STATE_CHANGED_EVENT = 'state-changed' as const;

/**
 * Per-file activity events forwarded from the underlying watchers. Listeners
 * receive `(event: SessionActivityEvent, filePath: string)` and are intended
 * for in-process consumers that need the absolute file path (e.g., the
 * external stats ingester that tails JSONL deltas).
 *
 * Only fired for events whose annotated `source` resolved to `'external'` —
 * sessions Maestro is already driving locally are filtered out so downstream
 * consumers don't have to dedup themselves.
 */
export const APPEND_EVENT = 'append' as const;
export const CREATE_EVENT = 'create' as const;

/**
 * Reads `getStorageWatchSpec()` off a storage instance without forcing every
 * caller to know it's defined on {@link BaseSessionStorage}. Returns `null`
 * for the (legal) case where the storage doesn't ship a spec.
 */
function readWatchSpec(storage: AgentSessionStorage): StorageWatchSpec | null {
	const candidate = storage as AgentSessionStorage & Partial<BaseSessionStorage>;
	if (typeof candidate.getStorageWatchSpec !== 'function') return null;
	return candidate.getStorageWatchSpec.call(candidate) ?? null;
}

export class ExternalSessionCoordinator extends EventEmitter {
	private readonly processManager: ProcessManager;
	private readonly storageRegistry: Partial<Record<ToolType, AgentSessionStorage>>;
	private readonly watchers: SessionFileWatcher[] = [];
	private readonly stateMap = new Map<string, SessionActivityEvent>();
	private stateDebounceTimer: NodeJS.Timeout | null = null;
	private started = false;

	constructor(options: ExternalSessionCoordinatorOptions) {
		super();
		this.processManager = options.processManager;
		this.storageRegistry = options.storageRegistry;
	}

	/**
	 * Snapshot of the current external-session activity state. Returned as a
	 * fresh `Map` so callers can't mutate the internal store.
	 */
	getState(): Map<string, SessionActivityEvent> {
		return new Map(this.stateMap);
	}

	/**
	 * Start one watcher per storage that exposes a {@link StorageWatchSpec}.
	 * Storages without a spec are skipped silently. Per-watcher failures are
	 * logged but never fatal — a single misbehaving agent must not take the
	 * whole coordinator down.
	 */
	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;

		const entries = Object.entries(this.storageRegistry) as Array<
			[ToolType, AgentSessionStorage | undefined]
		>;

		for (const [agentId, storage] of entries) {
			if (!storage) continue;

			let spec: StorageWatchSpec | null;
			try {
				spec = readWatchSpec(storage);
			} catch (err) {
				logger.warn(
					`getStorageWatchSpec() threw for ${agentId}: ${(err as Error).message}`,
					LOG_CONTEXT
				);
				continue;
			}
			if (!spec) continue;

			const watcher = new SessionFileWatcher({
				agentId,
				storageDir: spec.rootDir,
				fileMatcher: spec.fileMatcher,
			});

			// Both 'append' and 'create' represent live activity — the
			// activityEvent field on the spec is purely informational about
			// which one each agent treats as its dominant signal. The
			// renderer-visible "is this session thinking?" check uses
			// `isActive(event)` on the timestamp, not the event name.
			//
			// We accept the second `filePath` arg from the watcher emit so we
			// can re-broadcast it on the coordinator's own `'append'` /
			// `'create'` channels for in-process consumers (the stats ingester)
			// that need to read the underlying JSONL.
			watcher.on('append', (event, filePath: string) =>
				this.handleFileActivity(APPEND_EVENT, event, filePath)
			);
			watcher.on('create', (event, filePath: string) =>
				this.handleFileActivity(CREATE_EVENT, event, filePath)
			);
			watcher.on('idle', (event) => this.handleIdle(event));

			try {
				await watcher.start();
				this.watchers.push(watcher);
			} catch (err) {
				logger.warn(
					`Failed to start watcher for ${agentId}: ${(err as Error).message}`,
					LOG_CONTEXT
				);
			}
		}
	}

	/**
	 * Stop every watcher, drop accumulated state, and cancel any pending
	 * debounced emission. Safe to call multiple times.
	 */
	async stop(): Promise<void> {
		if (this.stateDebounceTimer) {
			clearTimeout(this.stateDebounceTimer);
			this.stateDebounceTimer = null;
		}

		const watchers = this.watchers.splice(0, this.watchers.length);
		await Promise.all(
			watchers.map(async (watcher) => {
				try {
					await watcher.stop();
				} catch (err) {
					logger.warn(
						`Error stopping watcher for ${watcher.agentId}: ${(err as Error).message}`,
						LOG_CONTEXT
					);
				}
			})
		);

		this.stateMap.clear();
		this.started = false;
	}

	/**
	 * Update the coalesced state map for the renderer-facing `state-changed`
	 * stream AND re-emit the underlying watcher event on the coordinator's
	 * `'append'` / `'create'` channel for in-process consumers that need the
	 * file path. The per-file event is suppressed for sessions Maestro already
	 * drives locally (the stats DB would otherwise get a second insert via the
	 * process-driven path).
	 */
	private handleFileActivity(
		channel: typeof APPEND_EVENT | typeof CREATE_EVENT,
		event: SessionActivityEvent,
		filePath: string
	): void {
		const annotated = this.annotateSource(event);
		const key = `${annotated.agentId}:${annotated.sessionId}`;
		this.stateMap.set(key, annotated);
		this.scheduleStateChange();

		if (annotated.source === 'external') {
			this.emit(channel, annotated, filePath);
		}
	}

	private handleIdle(event: SessionActivityEvent): void {
		const key = `${event.agentId}:${event.sessionId}`;
		if (this.stateMap.delete(key)) {
			this.scheduleStateChange();
		}
	}

	private annotateSource(event: SessionActivityEvent): SessionActivityEvent {
		const local = this.processManager.findByAgentSessionId(event.sessionId);
		return {
			...event,
			source: local ? 'local' : 'external',
		};
	}

	private scheduleStateChange(): void {
		if (this.stateDebounceTimer) return;
		this.stateDebounceTimer = setTimeout(() => {
			this.stateDebounceTimer = null;
			const payload: ExternalSessionStateChange = {
				events: Array.from(this.stateMap.values()),
			};
			this.emit(STATE_CHANGED_EVENT, payload);
		}, STATE_CHANGE_DEBOUNCE_MS);
	}
}
