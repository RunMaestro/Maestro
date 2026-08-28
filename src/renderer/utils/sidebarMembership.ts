/**
 * Which agents the Left Bar is drawing.
 *
 * "Visible" here is Pedram's definition: drawn ANYWHERE in the scrollable list,
 * scroll position irrelevant. Expand/collapse, archive state, the text filter,
 * and the unread filter decide membership.
 *
 * These two predicates existed inline in `useSessionCategories` (which decides
 * what renders) and, in a subtly different form, in `useSortedSessions`. Cmd+[ /
 * Cmd+] had no copy at all, which is why it cycled agents that were not on
 * screen. Three builders for one list is how they end up disagreeing in ten
 * places, so the render path and the cycle now share one source of truth -
 * adding a match rule here fixes both at once rather than one of them.
 */

import type { Session } from '../types';

/**
 * Does this agent match the sidebar's filter text?
 *
 * Matches on the agent's own name, any of its AI tab names, and its worktree
 * children's names and branch names, because a user filtering for a branch
 * expects the parent row that owns it. An empty query matches everything.
 */
export function sessionMatchesFilter(
	session: Session,
	query: string,
	worktreeChildren: Session[] = []
): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	if (session.name.toLowerCase().includes(q)) return true;
	if (session.aiTabs?.some((tab) => tab.name?.toLowerCase().includes(q))) return true;
	return worktreeChildren.some(
		(child) =>
			child.worktreeBranch?.toLowerCase().includes(q) || child.name.toLowerCase().includes(q)
	);
}

export interface UnreadFilterContext {
	showUnreadAgentsOnly: boolean;
	activeSessionId?: string | null;
	/** This agent's worktree children, whose activity keeps the parent visible. */
	worktreeChildren?: Session[];
	/** Agents currently running an Auto Run playbook (the AUTO badge). */
	batchSessionIds?: ReadonlySet<string>;
	/** Agents with an active Agent Resilience outage. */
	stuckOutageIds?: ReadonlySet<string>;
}

/**
 * Does this agent survive the unread-agents filter?
 *
 * An Auto Run agent sits in state `idle` between prompts and a stuck agent is
 * not "unread" in any literal sense, but both need attention, so both stay
 * visible. The ACTIVE agent always stays visible - a filter that hides the row
 * you are working in loses your place, and the cycle would then have no valid
 * position to move from.
 */
export function passesUnreadFilter(session: Session, ctx: UnreadFilterContext): boolean {
	if (!ctx.showUnreadAgentsOnly) return true;

	const children = ctx.worktreeChildren ?? [];
	const isActiveOrParentOfActive =
		session.id === ctx.activeSessionId ||
		children.some((child) => child.id === ctx.activeSessionId);
	if (isActiveOrParentOfActive) return true;

	const needsAttention = (s: Session): boolean =>
		(s.aiTabs?.some((tab) => tab.hasUnread) ?? false) ||
		s.state === 'busy' ||
		(ctx.batchSessionIds?.has(s.id) ?? false) ||
		(ctx.stuckOutageIds?.has(s.id) ?? false);

	return needsAttention(session) || children.some(needsAttention);
}
