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
 *
 * The "does this agent need attention?" half lives one level down in
 * `sessionAttention`, because the bell badge, the collapsed rail, and the
 * jump-badge projection ask it without a filter context. Add an attention rule
 * there, not here.
 */

import type { Session } from '../types';
import { sessionOrChildrenNeedAttention, type AttentionContext } from './sessionAttention';
// Imported from the leaf module rather than `tabHelpers` so a Left Bar predicate
// doesn't drag the whole tab-management surface (and its import cycle) with it.
import { visibleAiTabs } from './unifiedTabOrderUtils';

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
	// Hidden consult tabs are invisible to the user, so matching one would keep an
	// agent in the filtered list for a name nothing on screen carries.
	if (visibleAiTabs(session.aiTabs).some((tab) => tab.name?.toLowerCase().includes(q))) return true;
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

const NO_IDS: ReadonlySet<string> = new Set<string>();

/**
 * Does this agent survive the unread-agents filter?
 *
 * The "needs attention" half lives in `sessionAttention` because the bell badge,
 * the collapsed rail, and the jump-badge projection ask the same question
 * without a filter context. This function is that predicate plus the two rules
 * that only membership cares about: the filter being off at all, and the ACTIVE
 * agent always staying visible - a filter that hides the row you are working in
 * loses your place, and the cycle would then have no valid position to move from.
 */
export function passesUnreadFilter(session: Session, ctx: UnreadFilterContext): boolean {
	if (!ctx.showUnreadAgentsOnly) return true;

	const children = ctx.worktreeChildren ?? [];
	const isActiveOrParentOfActive =
		session.id === ctx.activeSessionId ||
		children.some((child) => child.id === ctx.activeSessionId);
	if (isActiveOrParentOfActive) return true;

	const attentionCtx: AttentionContext = {
		batchSessionIds: ctx.batchSessionIds ?? NO_IDS,
		stuckOutageIds: ctx.stuckOutageIds ?? NO_IDS,
	};
	return sessionOrChildrenNeedAttention(session, children, attentionCtx);
}
