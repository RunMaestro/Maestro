/**
 * Shared types for agent capability snapshots.
 *
 * A snapshot captures the runtime-discovered state of an agent for a given
 * environment (local or per-SSH-remote). Persisted to disk so cold-launch
 * UI renders meaningful state before the next probe round-trip completes.
 */

import type { AgentId } from './agentIds';

/**
 * High-level readiness status for an agent in a particular environment.
 *
 * - `ok` - agent binary is present and last interaction succeeded.
 * - `not_installed` - binary not found on PATH and no usable custom path.
 * - `auth_required` - binary present, but the most recent spawn failed with
 *   an auth-related error pattern. Cleared the next time detection succeeds.
 * - `not_configured` - agent definition exists but lacks the configuration
 *   required to actually run (reserved for future use).
 * - `probing` - detection is currently in-flight (transient UI state).
 * - `failed` - last detection attempt threw / errored unexpectedly.
 */
export type AgentStatus =
	| 'ok'
	| 'not_installed'
	| 'auth_required'
	| 'not_configured'
	| 'probing'
	| 'failed';

/**
 * A point-in-time capability snapshot for one agent in one environment.
 *
 * Stored on disk under a `<agentId>` or `<agentId>:<remoteUuid>` key so the
 * renderer can read meaningful state before the next live detection round.
 */
export interface AgentCapabilitiesSnapshot {
	/** Readiness classification - drives status pills and pickers. */
	status: AgentStatus;
	/** Detected binary path (when available). */
	path?: string;
	/** Reported version string from `--version` (best-effort). */
	version?: string;
	/** Discovered models, if any. */
	models?: string[];
	/**
	 * Discovered context window size in tokens, when probing surfaces it.
	 * Reserved for the followup PR that migrates `DEFAULT_CONTEXT_WINDOWS`
	 * callers - populated lazily as detection grows richer.
	 */
	contextWindow?: number;
	/** Last error string (auth message, spawn failure detail, etc.). */
	lastError?: string;
	/** Unix ms timestamp of the most recent probe attempt. */
	lastProbedAt: number;
	/**
	 * Stable UUID of the SSH remote this snapshot is keyed against, or
	 * undefined when this is the local snapshot. Mirrors the cache key so
	 * consumers don't have to split the key string.
	 */
	remoteId?: string;
}

/** Snapshot map keyed by `agentId` (local) or `agentId:remoteUuid` (SSH). */
export type AgentCapabilitiesSnapshotMap = Record<string, AgentCapabilitiesSnapshot>;

/**
 * Build the persistence key for a snapshot. Local snapshots use the bare
 * agent id; SSH snapshots append the stable SSH remote UUID.
 */
export function buildSnapshotKey(agentId: AgentId | string, remoteId?: string | null): string {
	return remoteId ? `${agentId}:${remoteId}` : String(agentId);
}

/** IPC channel used to broadcast snapshot mutations to renderers. */
export const SNAPSHOT_UPDATED_CHANNEL = 'agents:snapshot-updated';

/** Payload sent over the broadcast channel on every mutation. */
export interface SnapshotUpdatedPayload {
	key: string;
	agentId: string;
	remoteId?: string;
	/** null means the snapshot was cleared (e.g. user invalidated for re-probe). */
	snapshot: AgentCapabilitiesSnapshot | null;
}
