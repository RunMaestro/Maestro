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
	/**
	 * Display label: the user-assigned custom name if set, else "Main Window" for
	 * the primary or "Window N" for a secondary (its 1-based number).
	 */
	label: string;
	/**
	 * The raw user-assigned name (undefined when unnamed). Seeds the rename input;
	 * distinct from `label`, which always has a display fallback.
	 */
	customName?: string;
	/** True when this window already surfaces the agent (shown disabled / skipped). */
	isCurrentOwner: boolean;
}

/** The primary window is always labeled generically - it holds the catch-all set. */
export const MAIN_WINDOW_LABEL = 'Main Window';

const MAX_LABEL_LENGTH = 28;

/** End-ellipsis clamp for a user-assigned custom window name. */
function truncateLabel(name: string): string {
	const trimmed = name.trim();
	if (trimmed.length <= MAX_LABEL_LENGTH) return trimmed;
	return `${trimmed.slice(0, MAX_LABEL_LENGTH - 1)}…`;
}

/**
 * Build the ordered list of windows an agent can move between, labeling the
 * primary "Main Window" and each secondary by its 1-based number ("Window 2",
 * "Window 3", ...) - matching the WindowBadge / OS-title numbering.
 *
 * A user-assigned `win.name` wins over every default label. Secondary windows do
 * NOT borrow their lead agent's name (an earlier behaviour, reverted): a window
 * is a stable numbered container, not a mirror of whatever agent happens to be in
 * it. Ownership is still catch-all aware for `isCurrentOwner`: an agent is owned
 * by the secondary window that explicitly claimed it, else the primary.
 *
 * Only lists windows that actually hold at least one agent: an empty SECONDARY
 * window is auto-closing (see `wireEmptySecondaryWindowAutoClose`), so it must
 * never appear as a move destination - not even during the brief window between
 * "last agent moved out" and the OS `closed` event. The primary is always kept
 * (it is the catch-all owner and never closes). `windowNumber` stays the 1-based
 * registry-order index so it keeps matching the WindowBadge / OS-title numbering
 * even when an empty window in the middle is skipped.
 *
 * Returns `[]` before the registry has hydrated (the single-window common case),
 * so callers can simply skip rendering the "move to window" affordance.
 */
export function buildWindowMoveTargets(windows: WindowInfo[], agentId: string): WindowMoveTarget[] {
	if (windows.length === 0) return [];
	const claimedBySecondary = windows.some((win) => !win.isMain && win.sessionIds.includes(agentId));
	return windows.flatMap((win, idx) => {
		// Skip an empty secondary - it is closing and is not a valid destination.
		if (!win.isMain && win.sessionIds.length === 0) return [];
		const isCurrentOwner = claimedBySecondary
			? !win.isMain && win.sessionIds.includes(agentId)
			: win.isMain;
		const customName = win.name && win.name.trim().length > 0 ? win.name.trim() : undefined;
		let label: string;
		if (customName) {
			label = truncateLabel(customName);
		} else if (win.isMain) {
			label = MAIN_WINDOW_LABEL;
		} else {
			label = `Window ${idx + 1}`;
		}
		return [
			{
				windowId: win.id,
				isMain: win.isMain,
				windowNumber: idx + 1,
				label,
				customName,
				isCurrentOwner,
			},
		];
	});
}
