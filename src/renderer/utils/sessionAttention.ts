import type { Session } from '../types';

/**
 * Inputs the "needs attention" predicate can't read off the Session itself:
 * whether an agent is auto-running an Auto Run batch, and whether it is stuck
 * auto-retrying an Agent Resilience outage. Both are tracked in separate stores
 * (batchStore / retryStore), so the caller passes them in as id sets.
 */
export interface AttentionContext {
	/** Session ids with an active Auto Run batch (the AUTO badge). */
	batchSessionIds: ReadonlySet<string>;
	/** Session ids stuck auto-retrying an outage. */
	stuckOutageIds: ReadonlySet<string>;
}

/**
 * Parse the comma-joined outage signature (see `useActiveOutageSessionSignature`
 * in retryStore) into a lookup set. An empty signature yields an empty set (no
 * phantom empty-string id).
 */
export function outageIdsFromSignature(signature: string): Set<string> {
	return new Set(signature ? signature.split(',') : []);
}

/**
 * Single source of truth for the Left Bar unread ("needs attention") filter.
 *
 * An agent needs attention when it has an unread AI tab, is busy, is in an
 * error state, is auto-running an Auto Run batch, or is stuck auto-retrying an
 * outage. Every Left Bar surface that filters by unread MUST route through here
 * so they never diverge: categorization (`useSessionCategories`), the bell
 * badge + rendered worktree children (`SessionList`), the jump-badge / nav
 * projection (`computeSortedSessions` via `SidebarNavSync`), the collapsed rail
 * (`SkinnySidebar`), and keyboard cycling (`useCycleSession`). A partial
 * reimplementation is how an auto-running worktree child ends up hidden while
 * its parent stays visible.
 *
 * The active-session carve-out is intentionally NOT here: each surface keeps
 * its own "always show the active agent (or its parent)" rule because the
 * semantics differ (parent-of-active rollup, active group chat, per-row), and
 * an active idle agent does not "need attention".
 */
export function sessionNeedsAttention(session: Session, ctx: AttentionContext): boolean {
	if (session.aiTabs?.some((tab) => tab.hasUnread)) return true;
	if (session.state === 'busy' || session.state === 'error') return true;
	if (ctx.batchSessionIds.has(session.id)) return true;
	if (ctx.stuckOutageIds.has(session.id)) return true;
	return false;
}

/**
 * True when a parent agent should stay visible under the unread filter: it
 * needs attention itself, or any of its worktree children do (a busy or
 * auto-running worktree keeps the parent surfaced).
 */
export function sessionOrChildrenNeedAttention(
	session: Session,
	children: readonly Session[] | undefined,
	ctx: AttentionContext
): boolean {
	if (sessionNeedsAttention(session, ctx)) return true;
	return children?.some((child) => sessionNeedsAttention(child, ctx)) ?? false;
}
