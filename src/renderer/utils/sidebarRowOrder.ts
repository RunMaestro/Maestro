/**
 * The Left Bar's rows, in the order they are drawn.
 *
 * Cmd+[ / Cmd+] must step through exactly the rows the user can see, whatever
 * the filters, collapsed folders, nested groups, or plugin groupings are doing.
 * It used to rebuild its own copy of the list from the stores, and that copy
 * drifted from the render path every time the render path learned a new rule
 * (the unread filter hiding Bookmarks and forcing groups open, Groups+ nesting,
 * plugin groupings, the pinned Pianola row). So the render path now publishes
 * the rows it draws (`SessionList` -> `sidebarNavStore.visibleRows`) and the
 * cycle walks that list.
 *
 * The section decisions below are shared by the JSX and the published row list,
 * so the two read the same booleans instead of re-deriving them: add a rule
 * here and both sides see it.
 */

import type { Group, Session } from '../types';
import type { StarredItem } from '../hooks/session/useStarredItems';
import { sessionNeedsAttention, type AttentionContext } from './sessionAttention';

/** One row of the Left Bar a keyboard cursor can land on. */
export type SidebarRow =
	| { type: 'session'; id: string; navKey: string }
	| { type: 'starred'; id: string; starredKey: string }
	| { type: 'groupChat'; id: string };

/** The render context a session row is drawn in; it decides the row's navKey. */
export type SidebarRowVariant = 'bookmark' | 'group' | 'flat' | 'ungrouped';

/**
 * navIndexMap key for a parent row, matching the keys `computeSortedSessions`
 * builds. Variants without a real group id fall back to `ungrouped:`.
 */
export function sidebarNavKey(
	variant: SidebarRowVariant,
	sessionId: string,
	groupId?: string
): string {
	if (variant === 'bookmark') return `bookmark:${sessionId}`;
	if (variant === 'group' && groupId) return `group:${groupId}:${sessionId}`;
	return `ungrouped:${sessionId}`;
}

/** navIndexMap key for a worktree child row (see {@link sidebarNavKey}). */
export function sidebarChildNavKey(
	variant: SidebarRowVariant,
	childId: string,
	groupId?: string
): string {
	if (variant === 'bookmark') return `bookmark:wt:${childId}`;
	if (variant === 'group' && groupId) return `group:${groupId}:wt:${childId}`;
	return `ungrouped:wt:${childId}`;
}

export interface WorktreeChildVisibilityContext {
	showUnreadAgentsOnly: boolean;
	activeSessionId: string | null;
	attentionCtx: AttentionContext;
}

/**
 * The worktree children drawn under a parent row. Under the unread filter only
 * children that need attention (or are active) are drawn.
 */
export function sidebarWorktreeChildren(
	sortedChildren: readonly Session[],
	ctx: WorktreeChildVisibilityContext
): Session[] {
	if (!ctx.showUnreadAgentsOnly) return [...sortedChildren];
	return sortedChildren.filter(
		(child) => child.id === ctx.activeSessionId || sessionNeedsAttention(child, ctx.attentionCtx)
	);
}

/** Whether a parent's worktree children are open. The unread filter forces them open. */
export function sidebarWorktreesExpanded(session: Session, showUnreadAgentsOnly: boolean): boolean {
	return showUnreadAgentsOnly ? true : (session.worktreesExpanded ?? true);
}

export interface GroupSectionLayout {
	group: Group;
	/** The group's own agents, as drawn. */
	sessions: Session[];
	/** A Groups+ subgroup drawn indented under its parent. */
	nested: boolean;
	/** Agents are drawn as rows (not as collapsed pills). */
	expanded: boolean;
}

export interface GroupSectionLayoutContext {
	sessionsByGroupId: ReadonlyMap<string, Session[]>;
	groupById: ReadonlyMap<string, Group>;
	childrenByParentId: ReadonlyMap<string, Group[]>;
	groupsPlusEnabled: boolean;
	showUnreadAgentsOnly: boolean;
}

/**
 * Which group sections are drawn, in order, and whether each one shows its
 * agents as rows. Groups hidden by a collapsed Groups+ parent, or emptied by the
 * unread filter, are left out. The unread filter never opens a collapsed group:
 * only the user does, so toggling the filter cannot undo a collapse.
 */
export function layoutGroupSections(
	displayGroups: readonly Group[],
	ctx: GroupSectionLayoutContext
): GroupSectionLayout[] {
	const layouts: GroupSectionLayout[] = [];
	for (const group of displayGroups) {
		const sessions = ctx.sessionsByGroupId.get(group.id) ?? [];
		const parentGroup =
			ctx.groupsPlusEnabled && group.parentGroupId
				? ctx.groupById.get(group.parentGroupId)
				: undefined;
		const nested = Boolean(parentGroup && !parentGroup.parentGroupId);
		if (nested && parentGroup?.collapsed) continue;
		const childGroups = ctx.groupsPlusEnabled ? (ctx.childrenByParentId.get(group.id) ?? []) : [];
		const hasVisibleChild = childGroups.some(
			(child) => (ctx.sessionsByGroupId.get(child.id) ?? []).length > 0
		);
		// Keep a parent visible for a matching child while filtering by unread agents.
		if (ctx.showUnreadAgentsOnly && sessions.length === 0 && !hasVisibleChild) continue;
		layouts.push({
			group,
			sessions,
			nested,
			expanded: !group.collapsed,
		});
	}
	return layouts;
}

export interface VirtualGroupNode {
	id: string;
	name: string;
	parentGroupId?: string;
}

export interface VirtualGroupSectionLayout<G extends VirtualGroupNode = VirtualGroupNode> {
	group: G;
	parent?: G;
	collapsed: boolean;
	sessions: Session[];
}

/**
 * Which plugin-grouping sections are drawn, in order: each root followed by its
 * children, a child skipped while its parent is collapsed.
 */
export function layoutVirtualGroupSections<G extends VirtualGroupNode>(
	model: { groups: readonly G[]; assignments: Record<string, string> },
	collapsedById: Readonly<Record<string, boolean>>,
	sessions: readonly Session[]
): VirtualGroupSectionLayout<G>[] {
	const byId = new Map(model.groups.map((group) => [group.id, group]));
	const ordered = model.groups
		.filter((group) => !group.parentGroupId || !byId.has(group.parentGroupId))
		.flatMap((group) => [
			group,
			...model.groups.filter((candidate) => candidate.parentGroupId === group.id),
		]);
	const layouts: VirtualGroupSectionLayout<G>[] = [];
	for (const group of ordered) {
		const parent = group.parentGroupId ? byId.get(group.parentGroupId) : undefined;
		if (parent && collapsedById[parent.id] === true) continue;
		layouts.push({
			group,
			parent,
			collapsed: collapsedById[group.id] === true,
			sessions: sessions.filter((session) => model.assignments[session.id] === group.id),
		});
	}
	return layouts;
}

/** A run of parent agent rows drawn in one render context. */
export interface SidebarSessionSection {
	variant: SidebarRowVariant;
	groupId?: string;
	sessions: readonly Session[];
}

export interface SidebarRowOrderInput {
	/** Starred rows as drawn: empty when the section is hidden or collapsed. */
	starredItems: readonly StarredItem[];
	/** Agent sections in draw order, only those whose rows are open. */
	sections: readonly SidebarSessionSection[];
	/** Worktree children drawn under a parent: empty when collapsed or filtered out. */
	drawnWorktreeChildren: (parent: Session) => readonly Session[];
	/** Group chats as drawn: empty when the section is hidden or collapsed. */
	groupChats: readonly { id: string }[];
}

/** Flatten the drawn sections into the rows a keyboard cursor can land on. */
export function buildSidebarRowOrder(input: SidebarRowOrderInput): SidebarRow[] {
	const rows: SidebarRow[] = input.starredItems.map((item) => ({
		type: 'starred',
		id: item.parentSessionId,
		starredKey: item.key,
	}));
	for (const section of input.sections) {
		for (const session of section.sessions) {
			if (session.parentSessionId) continue;
			rows.push({
				type: 'session',
				id: session.id,
				navKey: sidebarNavKey(section.variant, session.id, section.groupId),
			});
			for (const child of input.drawnWorktreeChildren(session)) {
				rows.push({
					type: 'session',
					id: child.id,
					navKey: sidebarChildNavKey(section.variant, child.id, section.groupId),
				});
			}
		}
	}
	for (const chat of input.groupChats) {
		rows.push({ type: 'groupChat', id: chat.id });
	}
	return rows;
}
