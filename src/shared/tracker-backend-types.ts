/**
 * TrackerBackend interface and sync state contracts for the local-first tracker epic.
 *
 * Work Graph is the source of truth. GitHub (and future backends) are optional sync
 * targets that implement this interface. No GitHub-specific types live here — those
 * stay in each backend's private module.
 */

// ---------------------------------------------------------------------------
// Primitive union types
// ---------------------------------------------------------------------------

/**
 * How a project is connected to a remote tracker backend.
 * - off: no sync, Work Graph is standalone
 * - read-only: pull inbound events, never push
 * - bidirectional: push outbound ops AND pull inbound events
 * - manual: user explicitly triggers each sync action
 */
export type TrackerSyncMode = 'off' | 'read-only' | 'bidirectional' | 'manual';

/**
 * Per-item sync lifecycle state.
 * - unsynced: item has never been sent to any backend
 * - syncing: an outbound op is currently in-flight
 * - synced: local and remote are in agreement
 * - conflict: both sides changed since last sync
 * - error: last outbound op failed
 * - rate-limited: backend throttled the request; retry after back-off
 */
export type TrackerSyncState =
	| 'unsynced'
	| 'syncing'
	| 'synced'
	| 'conflict'
	| 'error'
	| 'rate-limited';

// ---------------------------------------------------------------------------
// Metadata attached to each WorkItem describing its remote sync status
// ---------------------------------------------------------------------------

/**
 * Stored alongside a WorkItem to record where it lives in the remote backend
 * and whether it is in sync.
 */
export interface TrackerSyncMetadata {
	/** Current sync lifecycle state. */
	state: TrackerSyncState;
	/** Opaque backend identifier (e.g. GitHub issue number as string). */
	externalId?: string;
	/** Human-browseable URL to the external item. */
	externalUrl?: string;
	/** ISO-8601 timestamp of the last successful two-way sync. */
	lastSyncedAt?: string;
	/** Human-readable description of the last error, if state === 'error'. */
	lastError?: string;
	/**
	 * Content hash of the Work Graph item at the time it was last pushed,
	 * used for conflict detection.
	 */
	hash?: string;
}

// ---------------------------------------------------------------------------
// Outbound operation (Work Graph → remote backend)
// ---------------------------------------------------------------------------

/**
 * A single unit of work the backend must perform on the remote tracker.
 * Backends receive these from the sync engine and translate them into
 * provider-specific API calls.
 */
export interface TrackerOutboundOp {
	/** What action to perform on the remote item. */
	kind: 'create' | 'update' | 'comment' | 'close' | 'reopen';
	/** Work Graph item this op is for. */
	workItemId: string;
	/**
	 * Provider-agnostic payload. Backends extract only the fields they need
	 * (title, body, labels, status, etc.) via their own `normalize()` call.
	 */
	payload: unknown;
	/** Zero-based delivery attempt count, used for exponential back-off. */
	attempt: number;
}

// ---------------------------------------------------------------------------
// Inbound event (remote backend → Work Graph)
// ---------------------------------------------------------------------------

/**
 * A remote change the backend has observed since the last poll or webhook push.
 * The sync engine applies these to Work Graph items via their `externalId`.
 */
export interface TrackerInboundEvent {
	/** What happened on the remote side. */
	kind: 'created' | 'updated' | 'commented' | 'closed' | 'reopened';
	/** Opaque backend identifier of the affected remote item. */
	externalId: string;
	/** Raw provider payload — passed to `normalize()` before being applied. */
	payload: unknown;
	/** ISO-8601 timestamp when the event occurred on the remote side. */
	occurredAt: string;
}

// ---------------------------------------------------------------------------
// Backend interface
// ---------------------------------------------------------------------------

/**
 * Contract every remote tracker adapter must satisfy.
 *
 * Implementations must be provider-agnostic at the call-site level: callers
 * interact exclusively with this interface. Provider-specific types (GraphQL
 * nodes, REST response shapes, field IDs, etc.) are internal to each backend.
 */
export interface TrackerBackend {
	/** Stable machine identifier used in settings and logs (e.g. 'github'). */
	id: string;
	/** Human-readable display name (e.g. 'GitHub Issues'). */
	name: string;

	/**
	 * Returns true when the backend can currently accept requests.
	 * Should check auth tokens, network reachability, etc.
	 */
	isAvailable(): Promise<boolean>;

	/**
	 * Returns true when this backend can receive outbound ops as well as
	 * deliver inbound events (i.e. not read-only by design).
	 */
	supportsBidirectional(): boolean;

	/**
	 * Sends a single outbound operation to the remote tracker.
	 * On success, returns `{ success: true, externalId? }`.
	 * On failure, returns `{ success: false, error }` — never throws.
	 */
	sendOutbound(op: TrackerOutboundOp): Promise<{
		success: boolean;
		externalId?: string;
		error?: string;
	}>;

	/**
	 * Polls for remote events that occurred after `sinceIso`.
	 * Returns an empty array when nothing has changed (never throws).
	 */
	pollInbound(args: { sinceIso?: string }): Promise<TrackerInboundEvent[]>;

	/**
	 * Translates a raw provider payload into the provider-agnostic field set
	 * that Work Graph understands. Only include fields that are present in
	 * the payload — omit to signal "no change for this field".
	 */
	normalize(payload: unknown): {
		title?: string;
		body?: string;
		labels?: string[];
		status?: string;
	};
}

// ---------------------------------------------------------------------------
// Per-project sync settings stored in Work Graph project config
// ---------------------------------------------------------------------------

/**
 * Configuration that controls how a single Maestro project syncs with a
 * remote tracker backend.
 */
export interface TrackerSyncSettings {
	/** Backend adapter to use (matches `TrackerBackend.id`). */
	backendId: string;
	/** Sync direction/mode for this project. */
	mode: TrackerSyncMode;
	/** Absolute path of the project root on disk. */
	projectPath: string;
	/** How often (ms) to call `pollInbound`; defaults to backend's own value. */
	inboundIntervalMs?: number;
	/** ISO-8601 timestamp of the last completed inbound poll. */
	lastInboundCheckAt?: string;
}
