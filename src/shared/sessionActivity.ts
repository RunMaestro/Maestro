/**
 * Session Activity Types
 *
 * Shared types describing activity in agent session files on disk, regardless
 * of whether Maestro itself spawned the agent. Used to surface remote/external
 * agent activity (e.g., a Claude Code session started over SSH by the same user)
 * in the same UI + stats paths as locally-spawned agents.
 *
 * Same-user only: we rely on local filesystem permissions on the watched
 * storage directories. No cross-user / cross-account support.
 */

import type { ToolType } from './types';

/**
 * Distinguishes Maestro-spawned sessions ('local') from sessions discovered
 * via the on-disk session-file watcher ('external').
 */
export type SessionActivitySource = 'local' | 'external';

/**
 * Emitted whenever a watched session file grows or appears.
 *
 * - `agentId`     — the agent that owns the session file (e.g., 'claude-code').
 * - `sessionId`   — agent-native session identifier parsed from the file path.
 * - `projectPath` — project / workspace path associated with the session.
 * - `lastActivityAt` — epoch ms timestamp of the most recent append/create.
 * - `source`      — 'local' for Maestro-spawned, 'external' for watched-only.
 * - `sizeBytes`   — current size of the underlying session file in bytes.
 */
export interface SessionActivityEvent {
	agentId: ToolType;
	sessionId: string;
	projectPath: string;
	lastActivityAt: number;
	source: SessionActivitySource;
	sizeBytes: number;
}

/**
 * A session is treated as "thinking" if its file has been appended to within
 * this many milliseconds of `now`.
 */
export const EXTERNAL_ACTIVITY_ACTIVE_MS = 3000;

/**
 * A session is cleared from the active set after this many milliseconds of
 * filesystem quiet.
 */
export const EXTERNAL_ACTIVITY_IDLE_MS = 30000;

/**
 * Returns true if the event's `lastActivityAt` is within the active window
 * relative to `now`. Used by both the watcher and the renderer to decide
 * whether to show a thinking pill for an external session.
 */
export function isActive(event: SessionActivityEvent, now: number = Date.now()): boolean {
	return now - event.lastActivityAt <= EXTERNAL_ACTIVITY_ACTIVE_MS;
}
