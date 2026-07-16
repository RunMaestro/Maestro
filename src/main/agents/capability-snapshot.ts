/**
 * Capability snapshot manager.
 *
 * Owns the in-memory copy of agent capability snapshots, persists them to
 * disk via the agent-capabilities store, and broadcasts updates to renderers
 * so the UI status pills stay live.
 *
 * Snapshots are derived from `detector.ts` (success path) and the
 * `agent-error` event flow in `process-listeners/error-listener.ts`
 * (reactive auth-required classification). Tests construct their own
 * `CapabilitySnapshotManager` with a fake store; the singleton
 * `capabilitySnapshots` is wired in `main/index.ts` for production.
 */

import type Store from 'electron-store';
import type { AgentCapabilitiesData } from '../stores/types';
import {
	type AgentCapabilitiesSnapshot,
	type AgentCapabilitiesSnapshotMap,
	type AgentStatus,
	type SnapshotUpdatedPayload,
	SNAPSHOT_UPDATED_CHANNEL,
	buildSnapshotKey,
} from '../../shared/agentCapabilities';
import { logger } from '../utils/logger';
import { captureMessage } from '../utils/sentry';

const LOG_CONTEXT = 'CapabilitySnapshot';

/**
 * Connection-level probe failures (SSH timeout, refused, unreachable host,
 * DNS miss, reset) are expected and recoverable - they just mean a configured
 * remote is currently offline or unreachable. They fire on every periodic
 * reprobe of a down host, so reporting each one to Sentry buries genuinely
 * unexpected probe failures under network noise. We still persist the `failed`
 * status (red pill) so the UI reflects reality; we just skip the breadcrumb.
 * Fixes MAESTRO-RA.
 */
function isExpectedConnectionFailure(error: string): boolean {
	return /connection timed out|operation timed out|connection refused|connection reset|connection closed|network is unreachable|no route to host|could not resolve hostname|host key verification failed|timed out after \d+s/i.test(
		error
	);
}

// Re-export so main-process call sites have a single import path.
export { SNAPSHOT_UPDATED_CHANNEL, type SnapshotUpdatedPayload };

/** Broadcaster fn: usually `safeSend.bind(null, SNAPSHOT_UPDATED_CHANNEL)`. */
export type SnapshotBroadcaster = (payload: SnapshotUpdatedPayload) => void;

/** Minimal store contract - narrower than electron-store so tests can fake it. */
export interface SnapshotStoreLike {
	get<K extends keyof AgentCapabilitiesData>(
		key: K,
		defaultValue?: AgentCapabilitiesData[K]
	): AgentCapabilitiesData[K];
	set<K extends keyof AgentCapabilitiesData>(key: K, value: AgentCapabilitiesData[K]): void;
}

export class CapabilitySnapshotManager {
	private store: SnapshotStoreLike | null = null;
	private broadcaster: SnapshotBroadcaster | null = null;
	private cache: AgentCapabilitiesSnapshotMap = {};

	/**
	 * Hydrate from the persisted store and wire up the broadcaster.
	 * Safe to call once at startup, after stores have been initialized.
	 */
	init(store: SnapshotStoreLike, broadcaster?: SnapshotBroadcaster): void {
		this.store = store;
		this.broadcaster = broadcaster ?? null;
		const persisted = store.get('snapshots', {});
		// Defensively drop any `probing` entries we find on disk: that status
		// is transient and should never survive a process exit. Crashes during
		// a reprobe would otherwise leave the UI stuck on a spinning pill.
		this.cache = {};
		for (const [key, snap] of Object.entries(persisted)) {
			if (snap && snap.status !== 'probing') {
				this.cache[key] = snap;
			}
		}
		const count = Object.keys(this.cache).length;
		if (count > 0) {
			logger.info(`Hydrated ${count} capability snapshot(s) from disk`, LOG_CONTEXT);
		}
	}

	/** For tests only - drop all state so each test starts clean. */
	__resetForTests(): void {
		this.store = null;
		this.broadcaster = null;
		this.cache = {};
	}

	/** Read a single snapshot. Returns undefined when no entry exists. */
	get(agentId: string, remoteId?: string | null): AgentCapabilitiesSnapshot | undefined {
		return this.cache[buildSnapshotKey(agentId, remoteId)];
	}

	/** Read every known snapshot - used for hydrating the renderer at startup. */
	getAll(): AgentCapabilitiesSnapshotMap {
		return { ...this.cache };
	}

	/** Drop a snapshot (e.g. user clicked Re-probe). Emits an update with `null`. */
	clear(agentId: string, remoteId?: string | null): void {
		const key = buildSnapshotKey(agentId, remoteId);
		if (!(key in this.cache)) {
			return;
		}
		delete this.cache[key];
		this.persist();
		this.emit({ key, agentId, remoteId: remoteId ?? undefined, snapshot: null });
	}

	/** Mark agent as successfully detected. Discovered fields piggyback on the patch. */
	markOk(
		agentId: string,
		patch: Omit<AgentCapabilitiesSnapshot, 'status' | 'lastProbedAt' | 'remoteId'>,
		remoteId?: string | null
	): AgentCapabilitiesSnapshot {
		return this.write(agentId, { ...patch, status: 'ok', lastError: undefined }, remoteId);
	}

	/** Binary wasn't on PATH and no usable custom path. */
	markNotInstalled(agentId: string, remoteId?: string | null): AgentCapabilitiesSnapshot {
		// Wipe path/version/models from a previous `ok` snapshot - otherwise
		// the UI would show a stale binary path beneath the red pill.
		return this.write(
			agentId,
			{
				status: 'not_installed',
				path: undefined,
				version: undefined,
				models: undefined,
				lastError: undefined,
			},
			remoteId
		);
	}

	/** Spawn failed with an auth-related error pattern. Tracked reactively. */
	markAuthRequired(
		agentId: string,
		error: string,
		remoteId?: string | null
	): AgentCapabilitiesSnapshot {
		return this.write(agentId, { status: 'auth_required', lastError: error }, remoteId);
	}

	/**
	 * Unexpected failure during detection / probe.
	 * Sends a low-volume Sentry breadcrumb so real-world failure modes surface.
	 */
	markFailed(agentId: string, error: string, remoteId?: string | null): AgentCapabilitiesSnapshot {
		if (!isExpectedConnectionFailure(error)) {
			void captureMessage('agent-probe-failed', 'warning', {
				agentId,
				remoteId: remoteId ?? null,
				error: error.slice(0, 500), // cap to avoid bloating sentry events
			});
		}
		return this.write(agentId, { status: 'failed', lastError: error }, remoteId);
	}

	/**
	 * Transient - used by `reprobe` so the UI can show a spinner.
	 * Intentionally does NOT persist: if the app exits mid-probe we never
	 * want to hydrate a stuck `probing` pill on next launch.
	 */
	markProbing(agentId: string, remoteId?: string | null): AgentCapabilitiesSnapshot {
		return this.write(agentId, { status: 'probing' }, remoteId, { skipPersist: true });
	}

	private write(
		agentId: string,
		patch: Partial<AgentCapabilitiesSnapshot> & { status: AgentStatus },
		remoteId?: string | null,
		options?: { skipPersist?: boolean }
	): AgentCapabilitiesSnapshot {
		const key = buildSnapshotKey(agentId, remoteId);
		const previous = this.cache[key];
		const next: AgentCapabilitiesSnapshot = {
			...previous,
			...patch,
			lastProbedAt: Date.now(),
			remoteId: remoteId ?? undefined,
		};
		this.cache[key] = next;
		if (!options?.skipPersist) {
			this.persist();
		}
		this.emit({ key, agentId, remoteId: remoteId ?? undefined, snapshot: next });
		return next;
	}

	private persist(): void {
		if (!this.store) return;
		try {
			this.store.set('snapshots', this.cache);
		} catch (err) {
			// Persistence failure is non-fatal - the in-memory cache still serves
			// the current process. Log so disk errors are visible.
			logger.warn('Failed to persist agent capability snapshots', LOG_CONTEXT, {
				error: String(err),
			});
		}
	}

	private emit(payload: SnapshotUpdatedPayload): void {
		if (!this.broadcaster) return;
		try {
			this.broadcaster(payload);
		} catch (err) {
			logger.debug('Snapshot broadcaster threw', LOG_CONTEXT, { error: String(err) });
		}
	}
}

/**
 * Production singleton. `main/index.ts` calls `init()` once the stores and
 * main window are ready. Anywhere else that needs read/write access just
 * imports this singleton.
 */
export const capabilitySnapshots = new CapabilitySnapshotManager();

/** Bridge helper for `main/index.ts`: builds a broadcaster from a safeSend fn. */
export function createSnapshotBroadcaster(
	safeSend: (channel: string, ...args: unknown[]) => void
): SnapshotBroadcaster {
	return (payload) => safeSend(SNAPSHOT_UPDATED_CHANNEL, payload);
}

/** Re-export for ergonomic imports at call sites. */
export type {
	AgentCapabilitiesSnapshot,
	AgentCapabilitiesSnapshotMap,
} from '../../shared/agentCapabilities';

/** Narrows electron-store to the minimal shape this manager needs. */
export function asSnapshotStore(store: Store<AgentCapabilitiesData>): SnapshotStoreLike {
	return store;
}
