import type { WindowInfo } from '../../shared/window-types';

/** Minimal shape needed to scope a session list by window ownership. */
interface ScopableSession {
	id: string;
	parentSessionId?: string | null;
}

/**
 * Filter a session list to the agents THIS window owns (single-window-per-agent):
 * only the agents `ownsSession` returns true for, plus any worktree child whose
 * parent it owns (so a detached agent keeps its worktrees in the same window).
 *
 * Applies in EVERY window, not just secondaries. `ownsSession` already encodes
 * the right thing for each: the primary owns every agent no secondary has claimed
 * (so an agent moved to another window disappears from the primary's Left Bar),
 * and a secondary owns exactly its scoped set. In the common single-window case
 * the primary owns everything, so this is a no-op; likewise when `ownsSession` is
 * null (no WindowProvider, e.g. isolation tests / web). Kept pure so it is
 * unit-testable apart from the heavy SessionList render.
 */
export function scopeSessionsToOwningWindow<T extends ScopableSession>(
	sessions: T[],
	ownsSession: ((sessionId: string) => boolean) | null | undefined
): T[] {
	if (!ownsSession) return sessions;
	return sessions.filter(
		(s) => ownsSession(s.id) || (s.parentSessionId != null && ownsSession(s.parentSessionId))
	);
}

/**
 * A window an agent can be moved into, plus how to label it. Shared by the
 * Left Bar agent context menu and the Cmd+K palette so both surfaces enumerate
 * and label window destinations identically.
 */
export interface WindowMoveTarget {
	windowId: string;
	isMain: boolean;
	/** 1-based position in registry order (primary first), matching WindowBadge. */
	windowNumber: number;
	/** Display label: "Main Window" for the primary, else its lead agent name. */
	label: string;
	/** True when this window already surfaces the agent (shown disabled / skipped). */
	isCurrentOwner: boolean;
}

/** The primary window is always labeled generically - it holds the catch-all set. */
export const MAIN_WINDOW_LABEL = 'Main Window';

const MAX_LABEL_LENGTH = 28;

/** End-ellipsis clamp for a secondary window's lead-agent label. */
function truncateLabel(name: string): string {
	const trimmed = name.trim();
	if (trimmed.length <= MAX_LABEL_LENGTH) return trimmed;
	return `${trimmed.slice(0, MAX_LABEL_LENGTH - 1)}…`;
}

/**
 * Build the ordered list of windows an agent can move between, labeling the
 * primary "Main Window" and each secondary by its lead (first) agent's name.
 *
 * Ownership is catch-all aware: an agent is owned by the secondary window that
 * explicitly claimed it, otherwise by the primary. `getSessionName` resolves an
 * agent id to its display name (the caller owns the session list); a secondary
 * with no resolvable lead name falls back to its window number.
 *
 * Returns `[]` before the registry has hydrated (the single-window common case),
 * so callers can simply skip rendering the "move to window" affordance.
 */
export function buildWindowMoveTargets(
	windows: WindowInfo[],
	agentId: string,
	getSessionName: (sessionId: string) => string | undefined
): WindowMoveTarget[] {
	if (windows.length === 0) return [];
	const claimedBySecondary = windows.some((win) => !win.isMain && win.sessionIds.includes(agentId));
	return windows.map((win, idx) => {
		const isCurrentOwner = claimedBySecondary
			? !win.isMain && win.sessionIds.includes(agentId)
			: win.isMain;
		let label: string;
		if (win.isMain) {
			label = MAIN_WINDOW_LABEL;
		} else {
			const leadName = win.sessionIds[0] ? getSessionName(win.sessionIds[0]) : undefined;
			label = leadName ? truncateLabel(leadName) : `Window ${idx + 1}`;
		}
		return {
			windowId: win.id,
			isMain: win.isMain,
			windowNumber: idx + 1,
			label,
			isCurrentOwner,
		};
	});
}
