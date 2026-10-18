/**
 * The order the Left Bar draws its groups and agents in, as pure functions.
 *
 * The Left Bar builds its rows from `useSessionCategories` plus the group
 * nesting in `SessionList`. A surface that lists agents outside it (the Quick
 * Chat picker) must read in the same order, or the user hunts for an agent in a
 * list that does not look like the one they know. Both read the rules here.
 */

import { compareNamesIgnoringEmojis } from '../../shared/emojiUtils';
import type { Group, Session } from '../types';
import { passesHiddenGroupFilter, resolveHiddenGroupIds } from './sidebarMembership';

export interface LeftBarGroupOrder {
	/** Groups in render order: alphabetical, each nested group right after its parent. */
	orderedGroups: Group[];
	/** Nested groups by parent id. Empty unless nesting is on. */
	childrenByParentId: Map<string, Group[]>;
}

/**
 * Order the groups the Left Bar draws.
 *
 * @param sortedGroups The visible groups, already alphabetical.
 * @param groupById EVERY group, to resolve a nested group's parent.
 * @param nested Whether Groups+ nesting is on. Off, the order is flat.
 *
 * A child is placed under its parent only when that parent is itself drawn. A
 * child of a missing or suppressed parent draws as a root rather than vanishing
 * with it.
 */
export function orderLeftBarGroups(
	sortedGroups: Group[],
	groupById: ReadonlyMap<string, Group>,
	nested: boolean
): LeftBarGroupOrder {
	const childrenByParentId = new Map<string, Group[]>();
	if (!nested) return { orderedGroups: sortedGroups, childrenByParentId };

	const drawn = new Set(sortedGroups.map((g) => g.id));
	const rootGroups: Group[] = [];
	for (const group of sortedGroups) {
		const parent = group.parentGroupId ? groupById.get(group.parentGroupId) : undefined;
		if (!parent || parent.parentGroupId || !drawn.has(parent.id)) {
			rootGroups.push(group);
			continue;
		}
		const children = childrenByParentId.get(parent.id);
		if (children) children.push(group);
		else childrenByParentId.set(parent.id, [group]);
	}
	return {
		orderedGroups: rootGroups.flatMap((group) => [
			group,
			...(childrenByParentId.get(group.id) ?? []),
		]),
		childrenByParentId,
	};
}

export interface LeftBarAgentOrderInput {
	sessions: Session[];
	groups: Group[];
	/** Groups+ nesting (`selectGroupsPlusEnabled`). */
	nestedGroups: boolean;
	/** The Pianola Encore Feature: its agent is pinned above everything. */
	pianolaEnabled: boolean;
	/** The Left Bar's "Show Hidden" toggle. */
	showHiddenGroups: boolean;
	/** The active agent, whose group is never hidden (see resolveHiddenGroupIds). */
	activeSessionId: string | null;
}

/**
 * Every top-level agent in the order the Left Bar draws it, each ONCE: Pianola,
 * then Bookmarks, then each group in order, then Ungrouped. Worktree children
 * and agents in hidden groups are left out. A bookmarked agent appears in the
 * Bookmarks position only, because a picker that lists one agent twice offers
 * two rows that do the same thing.
 */
export function leftBarAgentOrder(input: LeftBarAgentOrderInput): Session[] {
	const { sessions, groups, nestedGroups, pianolaEnabled, showHiddenGroups, activeSessionId } =
		input;
	const byName = (a: { name: string }, b: { name: string }) =>
		compareNamesIgnoringEmojis(a.name, b.name);
	const hiddenGroupIds = resolveHiddenGroupIds(groups, {
		showHiddenGroups,
		activeGroupId: sessions.find((s) => s.id === activeSessionId)?.groupId ?? null,
	});
	const topLevel = sessions
		.filter((s) => !s.parentSessionId && passesHiddenGroupFilter(s, hiddenGroupIds))
		.sort(byName);

	const ordered: Session[] = [];
	const placed = new Set<string>();
	const place = (list: Session[]) => {
		for (const s of list) {
			if (placed.has(s.id)) continue;
			placed.add(s.id);
			ordered.push(s);
		}
	};

	const pianola = topLevel.filter((s) => s.isPianola);
	if (pianolaEnabled) place(pianola);
	const rest = topLevel.filter((s) => !s.isPianola);
	place(rest.filter((s) => s.bookmarked));

	const groupById = new Map(groups.map((g) => [g.id, g]));
	const visibleGroups = groups.filter((g) => !hiddenGroupIds.has(g.id)).sort(byName);
	const { orderedGroups } = orderLeftBarGroups(visibleGroups, groupById, nestedGroups);
	for (const group of orderedGroups) {
		place(rest.filter((s) => s.groupId === group.id));
	}
	place(rest.filter((s) => !s.groupId || !groupById.has(s.groupId)));
	return ordered;
}
