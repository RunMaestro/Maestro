import type { Session } from '../types';

/**
 * Inputs the "needs attention" predicate can't read off the Session itself:
 * whether an agent is auto-running an Auto Run batch, and whether it is stuck
 * auto-retrying an outage. Both are tracked in separate stores (batchStore /
 * retryStore), so the caller passes them in as id sets.
 */
export interface AttentionContext {
	/** Session ids with an active Auto Run batch (the AUTO badge). */
	batchSessionIds: ReadonlySet<string>;
	/** Session ids stuck auto-retrying an outage. */
	stuckOutageIds: ReadonlySet<string>;
}

/**
 * Parse the comma-joined outage signature (see
 * `useActiveOutageSessionSignature` in retryStore) into a lookup set.
 */
export function outageIdsFromSignature(signature: string): Set<string> {
	return new Set(signature ? signature.split(',') : []);
}

/**
 * Single source of truth for the Left Bar unread ("needs attention") filter.
 *
 * An agent needs attention when it has an unread AI tab, is busy, is
 * auto-running an Auto Run batch, or is stuck auto-retrying an outage. Every
 * Left Bar surface that filters by unread - categorization
 * (`useSessionCategories`), rendered worktree children (`SessionList`), the
 * skinny sidebar (`SkinnySidebar`), jump badges + Alt+Cmd+N
 * (`useSortedSessions`), and keyboard cycling (`useCycleSession`) - MUST route
 * through here so they never diverge. A partial reimplementation is how an
 * auto-running worktree child ends up hidden while its parent stays visible.
 */
export function sessionNeedsAttention(session: Session, ctx: AttentionContext): boolean {
	if (session.aiTabs?.some((tab) => tab.hasUnread)) return true;
	if (session.state === 'busy') return true;
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
